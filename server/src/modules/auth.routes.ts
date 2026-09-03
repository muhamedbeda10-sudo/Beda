import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import type { AuthConfigResponse, AuthResponse } from '@qc/shared/api'
import type { Role, UserProfile } from '@qc/shared/types'
import type { AppContext } from '../context'
import { withTransaction, PG, pgCode, type Queryable } from '../db/pool'
import { HttpError, badRequest, duplicate, forbidden, unauthenticated } from '../lib/errors'
import { parse } from '../lib/validate'
import { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH } from '../auth/password'
import { REFRESH_COOKIE, SESSION_MARKER_COOKIE, hashRefreshToken, newRefreshToken, signAccessToken } from '../auth/tokens'
import { authenticate, requireUser } from '../auth/middleware'
import { seedDemoDataIfEmpty } from '../db/seed'

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('Enter a valid email address.')
  .max(254)

const passwordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`)
  .max(200)

const loginSchema = z.object({ email: emailSchema, password: z.string().min(1).max(200) })
const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().trim().min(1, 'Enter your name.').max(120),
})

export const USER_COLUMNS = `id, email, name, role, is_active AS "isActive", created_at AS "createdAt", last_login_at AS "lastLoginAt"`

async function countUsers(q: Queryable): Promise<number> {
  const { rows } = await q.query<{ n: number }>('SELECT count(*)::int AS n FROM users')
  return rows[0].n
}

export function authRoutes(ctx: AppContext): Router {
  const r = Router()
  const { db, config } = ctx
  const refreshTtlMs = config.REFRESH_TOKEN_TTL_DAYS * 86_400_000

  function cookieOptions(expiresAt: Date) {
    return {
      httpOnly: true,
      sameSite: 'lax' as const,
      secure: config.NODE_ENV === 'production',
      path: '/api/auth',
      expires: expiresAt,
    }
  }

  function setSessionCookies(res: Response, refresh: string, expiresAt: Date) {
    res.cookie(REFRESH_COOKIE, refresh, cookieOptions(expiresAt))
    res.cookie(SESSION_MARKER_COOKIE, '1', { ...cookieOptions(expiresAt), httpOnly: false, path: '/' })
  }

  function clearSessionCookies(res: Response) {
    res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' })
    res.clearCookie(SESSION_MARKER_COOKIE, { path: '/' })
  }

  /** Open a device session and answer with both tokens. */
  async function issueTokens(req: Request, res: Response, user: UserProfile): Promise<AuthResponse> {
    const refresh = newRefreshToken()
    const expiresAt = new Date(Date.now() + refreshTtlMs)
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO auth_sessions (user_id, refresh_token_hash, expires_at, user_agent, ip_address)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [user.id, hashRefreshToken(refresh), expiresAt, (req.headers['user-agent'] ?? '').slice(0, 300), req.ip ?? null],
    )
    const sid = rows[0].id
    setSessionCookies(res, refresh, expiresAt)
    return {
      accessToken: signAccessToken({ sub: user.id, name: user.name, role: user.role, sid }, config.JWT_SECRET, config.ACCESS_TOKEN_TTL),
      expiresIn: config.ACCESS_TOKEN_TTL,
      user,
    }
  }

  r.get('/config', async (_req, res) => {
    const noUsers = (await countUsers(db)) === 0
    const body: AuthConfigResponse = {
      selfRegistrationOpen: noUsers || config.AUTH_ALLOW_SELF_REGISTRATION,
      factoryTimeZone: config.FACTORY_TIMEZONE,
    }
    res.json(body)
  })

  /**
   * The very first account becomes the admin — otherwise nobody could reach
   * Admin to promote anyone. The check and the insert share a transaction and
   * an advisory lock, so two first sign-ups cannot both become admin.
   */
  r.post('/register', async (req, res) => {
    const body = parse(registerSchema, req.body)
    const passwordHash = await hashPassword(body.password)

    const user = await withTransaction(db, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock($1)', [8_811_002])
      const first = (await countUsers(tx)) === 0
      if (!first && !config.AUTH_ALLOW_SELF_REGISTRATION) {
        throw forbidden('Self-registration is closed. Ask an administrator to create your account.')
      }
      const role: Role = first ? 'admin' : 'inspector'
      try {
        const { rows } = await tx.query<UserProfile>(
          `INSERT INTO users (email, name, role, password_hash) VALUES ($1, $2, $3, $4) RETURNING ${USER_COLUMNS}`,
          [body.email, body.name, role, passwordHash],
        )
        return rows[0]
      } catch (e) {
        if (pgCode(e) === PG.UNIQUE_VIOLATION) throw duplicate('This email is already registered.')
        throw e
      }
    })

    if (user.role === 'admin' && config.SEED_DEMO_DATA) {
      await seedDemoDataIfEmpty(db).catch((e) => console.warn('[seed] demo data was not seeded:', e))
    }
    await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id])
    res.status(201).json(await issueTokens(req, res, user))
  })

  r.post('/login', async (req, res) => {
    const body = parse(loginSchema, req.body)
    const limiterKey = `${req.ip ?? 'unknown'}|${body.email}`
    const wait = ctx.loginLimiter.hit(limiterKey)
    if (wait > 0) {
      throw new HttpError(429, 'rate_limited', `Too many attempts. Try again in ${wait} seconds.`)
    }

    const { rows } = await db.query<UserProfile & { passwordHash: string }>(
      `SELECT ${USER_COLUMNS}, password_hash AS "passwordHash" FROM users WHERE email = $1`,
      [body.email],
    )
    const row = rows[0]
    // Verify against a real hash even when the user does not exist, so timing
    // does not reveal which emails are registered.
    const ok = row ? await verifyPassword(body.password, row.passwordHash) : await verifyPassword(body.password, DUMMY_HASH).then(() => false)
    if (!ok) throw unauthenticated('Incorrect email or password.')
    if (!row.isActive) throw unauthenticated('This account has been deactivated. Contact your administrator.')

    ctx.loginLimiter.reset(limiterKey)
    await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [row.id])
    const { passwordHash: _omit, ...user } = row
    res.json(await issueTokens(req, res, { ...user, lastLoginAt: new Date().toISOString() }))
  })

  /** Rotate the refresh token and mint a new access token. */
  r.post('/refresh', async (req, res) => {
    const presented = typeof req.cookies?.[REFRESH_COOKIE] === 'string' ? (req.cookies[REFRESH_COOKIE] as string) : ''
    if (!presented) throw unauthenticated('Sign in to continue.')

    const next = newRefreshToken()
    const expiresAt = new Date(Date.now() + refreshTtlMs)
    const result = await withTransaction(db, async (tx) => {
      const { rows } = await tx.query<{ sid: string } & UserProfile>(
        `SELECT s.id AS sid, u.id, u.email, u.name, u.role, u.is_active AS "isActive",
                u.created_at AS "createdAt", u.last_login_at AS "lastLoginAt"
           FROM auth_sessions s JOIN users u ON u.id = s.user_id
          WHERE s.refresh_token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
          FOR UPDATE OF s`,
        [hashRefreshToken(presented)],
      )
      const row = rows[0]
      if (!row) return null
      if (!row.isActive) return null
      await tx.query(
        'UPDATE auth_sessions SET refresh_token_hash = $2, expires_at = $3, last_used_at = now() WHERE id = $1',
        [row.sid, hashRefreshToken(next), expiresAt],
      )
      return row
    })
    if (!result) {
      clearSessionCookies(res)
      throw unauthenticated('Your session has expired. Sign in again.')
    }
    const { sid, ...user } = result
    setSessionCookies(res, next, expiresAt)
    const body: AuthResponse = {
      accessToken: signAccessToken({ sub: user.id, name: user.name, role: user.role, sid }, config.JWT_SECRET, config.ACCESS_TOKEN_TTL),
      expiresIn: config.ACCESS_TOKEN_TTL,
      user,
    }
    res.json(body)
  })

  r.post('/logout', async (req, res) => {
    const presented = typeof req.cookies?.[REFRESH_COOKIE] === 'string' ? (req.cookies[REFRESH_COOKIE] as string) : ''
    if (presented) {
      await db.query('UPDATE auth_sessions SET revoked_at = now() WHERE refresh_token_hash = $1 AND revoked_at IS NULL', [
        hashRefreshToken(presented),
      ])
    }
    clearSessionCookies(res)
    res.status(204).end()
  })

  r.get('/me', authenticate(db, config.JWT_SECRET), async (req, res) => {
    const user = requireUser(req)
    const { rows } = await db.query<UserProfile>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [user.id])
    if (!rows[0]) throw unauthenticated()
    res.json(rows[0])
  })

  r.post('/change-password', authenticate(db, config.JWT_SECRET), async (req, res) => {
    const user = requireUser(req)
    const body = parse(z.object({ currentPassword: z.string().min(1), newPassword: passwordSchema }), req.body)
    const { rows } = await db.query<{ passwordHash: string }>('SELECT password_hash AS "passwordHash" FROM users WHERE id = $1', [user.id])
    if (!rows[0] || !(await verifyPassword(body.currentPassword, rows[0].passwordHash))) {
      throw badRequest('The current password is incorrect.')
    }
    await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [user.id, await hashPassword(body.newPassword)])
    // Every other device is signed out; this one keeps its session.
    await db.query('UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL', [
      user.id,
      user.sessionId,
    ])
    res.status(204).end()
  })

  return r
}

/** A valid scrypt hash of a random string, used to equalise login timing. */
const DUMMY_HASH =
  'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
