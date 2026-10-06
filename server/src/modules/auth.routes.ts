import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { AVATAR_MAX_CHARS, type AuthConfigResponse, type AuthResponse, type AvatarResponse } from '@qc/shared/api'
import type { Role, UserProfile } from '@qc/shared/types'
import type { AppContext } from '../context'
import { withTransaction, PG, pgCode, type Queryable } from '../db/pool'
import { HttpError, badRequest, duplicate, forbidden, unauthenticated } from '../lib/errors'
import { parse } from '../lib/validate'
import { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH } from '../auth/password'
import { REFRESH_COOKIE, SESSION_MARKER_COOKIE, hashRefreshToken, newRefreshToken, signAccessToken } from '../auth/tokens'
import { authenticate, requireUser } from '../auth/middleware'
import { seedDemoDataIfEmpty } from '../db/seed'
import { sniffImageMime } from '../images/storage'

/** The login name: letters, digits, dot, dash, underscore; case does not matter. */
export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,39}$/
export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(USERNAME_PATTERN, 'Username: 2–40 letters, digits, dots, dashes or underscores, starting with a letter or digit.')

const passwordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`)
  .max(200)

const avatarSchema = z.object({
  dataUrl: z
    .string()
    .max(AVATAR_MAX_CHARS, 'The photo is too large.')
    .regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/, 'The photo must be a JPEG.'),
})

const loginSchema = z.object({ username: usernameSchema, password: z.string().min(1).max(200) })
const registerSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  name: z.string().trim().min(1, 'Enter your name.').max(120),
})

export const USER_COLUMNS = `id, username, name, role, is_active AS "isActive", created_at AS "createdAt", last_login_at AS "lastLoginAt"`

async function countUsers(q: Queryable): Promise<number> {
  const { rows } = await q.query<{ n: number }>('SELECT count(*)::int AS n FROM users WHERE deleted_at IS NULL')
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
          `INSERT INTO users (username, name, role, password_hash) VALUES ($1, $2, $3, $4) RETURNING ${USER_COLUMNS}`,
          [body.username, body.name, role, passwordHash],
        )
        return rows[0]
      } catch (e) {
        if (pgCode(e) === PG.UNIQUE_VIOLATION) throw duplicate('This username is already taken.')
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
    const limiterKey = `${req.ip ?? 'unknown'}|${body.username}`
    const wait = ctx.loginLimiter.hit(limiterKey)
    if (wait > 0) {
      throw new HttpError(429, 'rate_limited', `Too many attempts. Try again in ${wait} seconds.`)
    }

    const { rows } = await db.query<UserProfile & { passwordHash: string }>(
      `SELECT ${USER_COLUMNS}, password_hash AS "passwordHash" FROM users WHERE username = $1 AND deleted_at IS NULL`,
      [body.username],
    )
    const row = rows[0]
    // Verify against a real hash even when the user does not exist, so timing
    // does not reveal which usernames exist.
    const ok = row ? await verifyPassword(body.password, row.passwordHash) : await verifyPassword(body.password, DUMMY_HASH).then(() => false)
    if (!ok) throw unauthenticated('Incorrect username or password.')
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
        `SELECT s.id AS sid, u.id, u.username, u.name, u.role, u.is_active AS "isActive",
                u.created_at AS "createdAt", u.last_login_at AS "lastLoginAt"
           FROM auth_sessions s JOIN users u ON u.id = s.user_id
          WHERE s.refresh_token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
            AND u.deleted_at IS NULL
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
    const { rows } = await db.query<UserProfile>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1 AND deleted_at IS NULL`, [user.id])
    if (!rows[0]) throw unauthenticated()
    res.json(rows[0])
  })

  // ---- The person's own profile photo -----------------------------------------
  // Anyone signed in sets, reads and removes their own, and only their own.

  r.get('/me/avatar', authenticate(db, config.JWT_SECRET), async (req, res) => {
    const user = requireUser(req)
    const { rows } = await db.query<{ dataUrl: string }>('SELECT data_url AS "dataUrl" FROM user_avatars WHERE user_id = $1', [user.id])
    const body: AvatarResponse = { dataUrl: rows[0]?.dataUrl ?? null }
    res.json(body)
  })

  r.put('/me/avatar', authenticate(db, config.JWT_SECRET), async (req, res) => {
    const user = requireUser(req)
    const { dataUrl } = parse(avatarSchema, req.body)
    // The text says JPEG; the bytes must too.
    const bytes = Buffer.from(dataUrl.slice('data:image/jpeg;base64,'.length), 'base64')
    if (bytes.length === 0 || sniffImageMime(bytes.subarray(0, 16)) !== 'image/jpeg') throw badRequest('The photo must be a JPEG.')
    await db.query(
      `INSERT INTO user_avatars (user_id, data_url) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET data_url = EXCLUDED.data_url, updated_at = now()`,
      [user.id, dataUrl],
    )
    const body: AvatarResponse = { dataUrl }
    res.json(body)
  })

  r.delete('/me/avatar', authenticate(db, config.JWT_SECRET), async (req, res) => {
    const user = requireUser(req)
    await db.query('DELETE FROM user_avatars WHERE user_id = $1', [user.id])
    res.status(204).end()
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
