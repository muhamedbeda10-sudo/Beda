import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { AVATARS_MAX_IDS, AVATAR_MAX_CHARS, AVATAR_THUMB_MAX_CHARS, type AuthConfigResponse, type AuthResponse, type AvatarResponse, type AvatarsResponse } from '@qc/shared/api'
import type { Role, UserProfile } from '@qc/shared/types'
import type { AppContext } from '../context'
import { withTransaction, PG, pgCode, type Queryable } from '../db/pool'
import { HttpError, badRequest, duplicate, forbidden, unauthenticated } from '../lib/errors'
import { parse } from '../lib/validate'
import { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH } from '../auth/password'
import { REFRESH_COOKIE, REFRESH_REUSE_GRACE_SECONDS, SESSION_MARKER_COOKIE, hashRefreshToken, newRefreshToken, signAccessToken } from '../auth/tokens'
import { authenticate, requireUser } from '../auth/middleware'
import { loadProfile } from '../auth/profile'
import { RESERVED_OWNER_NAME, isReservedForAiOwner, pinAiOwnerIn } from '../ai/owner'
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

const JPEG_DATA_URL = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/
const JPEG_PREFIX = 'data:image/jpeg;base64,'
const avatarSchema = z.object({
  dataUrl: z.string().max(AVATAR_MAX_CHARS, 'The photo is too large.').regex(JPEG_DATA_URL, 'The photo must be a JPEG.'),
  thumbDataUrl: z.string().max(AVATAR_THUMB_MAX_CHARS, 'The small copy of the photo is too large.').regex(JPEG_DATA_URL, 'The photo must be a JPEG.').optional(),
})
const avatarsQuery = z.object({
  ids: z
    .string()
    .transform((v) => Array.from(new Set(v.split(',').map((x) => x.trim()).filter(Boolean))))
    .pipe(z.array(z.string().uuid()).min(1).max(AVATARS_MAX_IDS)),
})

/** Whether a data URL's bytes really are a JPEG, whatever its text says. */
function isJpegDataUrl(dataUrl: string): boolean {
  const bytes = Buffer.from(dataUrl.slice(JPEG_PREFIX.length), 'base64')
  return bytes.length > 0 && sniffImageMime(bytes.subarray(0, 16)) === 'image/jpeg'
}

const loginSchema = z.object({ username: usernameSchema, password: z.string().min(1).max(200) })
const registerSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  name: z.string().trim().min(1, 'Enter your name.').max(120),
})

export const USER_COLUMNS = `id, username, name, role, is_active AS "isActive", created_at AS "createdAt", last_login_at AS "lastLoginAt"`

/** People with an account. The system sender (§21) is nobody: the first person to register still becomes the admin. */
async function countUsers(q: Queryable): Promise<number> {
  const { rows } = await q.query<{ n: number }>('SELECT count(*)::int AS n FROM users WHERE deleted_at IS NULL AND NOT is_system')
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

  /** The person signing in, permissions and all (§14). */
  async function signedInProfile(userId: string): Promise<UserProfile> {
    const profile = await loadProfile(db, userId)
    if (!profile) throw unauthenticated()
    return profile
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
   *
   * §20 — the AI assistant's owner's name (AI_OWNER_USERNAME) is not for
   * anyone to register while no owner is pinned: only the first account of an
   * empty installation — the person setting it up — may take it, and is
   * pinned as the owner with it.
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
      const ownersName = await isReservedForAiOwner(tx, config, body.username)
      if (ownersName && !first) throw duplicate(RESERVED_OWNER_NAME)
      const role: Role = first ? 'admin' : 'inspector'
      let created: UserProfile
      try {
        const { rows } = await tx.query<UserProfile>(
          `INSERT INTO users (username, name, role, password_hash) VALUES ($1, $2, $3, $4) RETURNING ${USER_COLUMNS}`,
          [body.username, body.name, role, passwordHash],
        )
        created = rows[0]
      } catch (e) {
        if (pgCode(e) === PG.UNIQUE_VIOLATION) throw duplicate('This username is already taken.')
        throw e
      }
      if (ownersName) await pinAiOwnerIn(tx, created.username)
      return created
    })

    if (user.role === 'admin' && config.SEED_DEMO_DATA) {
      await seedDemoDataIfEmpty(db).catch((e) => console.warn('[seed] demo data was not seeded:', e))
    }
    await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id])
    res.status(201).json(await issueTokens(req, res, await signedInProfile(user.id)))
  })

  r.post('/login', async (req, res) => {
    const body = parse(loginSchema, req.body)
    const limiterKey = `${req.ip ?? 'unknown'}|${body.username}`
    const wait = ctx.loginLimiter.hit(limiterKey)
    if (wait > 0) {
      throw new HttpError(429, 'rate_limited', `Too many attempts. Try again in ${wait} seconds.`)
    }

    const { rows } = await db.query<Pick<UserProfile, 'id' | 'isActive'> & { passwordHash: string; isSystem: boolean }>(
      `SELECT ${USER_COLUMNS}, password_hash AS "passwordHash", is_system AS "isSystem" FROM users WHERE username = $1 AND deleted_at IS NULL`,
      [body.username],
    )
    const row = rows[0]
    // Verify against a real hash even when the user does not exist, so timing
    // does not reveal which usernames exist. The system sender (§21) is
    // refused like an unknown name, whatever its stored hash says.
    const ok =
      row && !row.isSystem ? await verifyPassword(body.password, row.passwordHash) : await verifyPassword(body.password, DUMMY_HASH).then(() => false)
    if (!ok) throw unauthenticated('Incorrect username or password.')
    if (!row.isActive) throw unauthenticated('This account has been deactivated. Contact your administrator.')

    ctx.loginLimiter.reset(limiterKey)
    await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [row.id])
    res.json(await issueTokens(req, res, await signedInProfile(row.id)))
  })

  /**
   * Rotate the refresh token and mint a new access token. The token a device
   * replaced a moment ago (REFRESH_REUSE_GRACE_SECONDS) is answered too, with
   * a new access token for the same device and its cookie left alone: that is
   * a second tab that refreshed at the same moment, and the cookie the first
   * one set is the device's current token. Later, the replaced token is
   * refused — but its cookie is not cleared, since the browser holds the
   * newer one by then; only a token that names no live device clears them.
   */
  r.post('/refresh', async (req, res) => {
    const presented = typeof req.cookies?.[REFRESH_COOKIE] === 'string' ? (req.cookies[REFRESH_COOKIE] as string) : ''
    if (!presented) throw unauthenticated('Sign in to continue.')

    const presentedHash = hashRefreshToken(presented)
    const next = newRefreshToken()
    const expiresAt = new Date(Date.now() + refreshTtlMs)
    const result = await withTransaction(db, async (tx) => {
      // Two refreshes with one cookie wait on this row lock; the second then
      // reads the row as the first left it: its token is now the previous one.
      const { rows } = await tx.query<{ sid: string; current: boolean } & UserProfile>(
        `SELECT s.id AS sid, s.refresh_token_hash = $1 AS current, u.id, u.username, u.name, u.role, u.is_active AS "isActive",
                u.created_at AS "createdAt", u.last_login_at AS "lastLoginAt"
           FROM auth_sessions s JOIN users u ON u.id = s.user_id
          WHERE (s.refresh_token_hash = $1 OR (s.previous_token_hash = $1 AND s.rotated_at > now() - make_interval(secs => $2)))
            AND s.revoked_at IS NULL AND s.expires_at > now()
            AND u.deleted_at IS NULL AND NOT u.is_system
          FOR UPDATE OF s`,
        [presentedHash, REFRESH_REUSE_GRACE_SECONDS],
      )
      const row = rows[0]
      if (!row || !row.isActive) return null
      if (!row.current) {
        await tx.query('UPDATE auth_sessions SET last_used_at = now() WHERE id = $1', [row.sid])
        return { ...row, rotated: false }
      }
      await tx.query(
        `UPDATE auth_sessions SET previous_token_hash = refresh_token_hash, rotated_at = now(), refresh_token_hash = $2, expires_at = $3, last_used_at = now()
          WHERE id = $1`,
        [row.sid, hashRefreshToken(next), expiresAt],
      )
      return { ...row, rotated: true }
    })
    if (!result) {
      // A token this device replaced earlier: the browser holds the newer one, which clearing would erase.
      const replaced = await db.query(
        `SELECT 1 FROM auth_sessions WHERE previous_token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
        [presentedHash],
      )
      if (replaced.rowCount === 0) clearSessionCookies(res)
      throw unauthenticated('Your session has expired. Sign in again.')
    }
    const { sid } = result
    if (result.rotated) setSessionCookies(res, next, expiresAt)
    // The account as it is now, permissions and all (§14): a change made since the last refresh reaches the app here.
    const user = await loadProfile(db, result.id)
    if (!user) throw unauthenticated('Your session has expired. Sign in again.')
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
      // The device's token, or the one it replaced in a refresh that crossed this sign-out: either way the device is signed out.
      await db.query('UPDATE auth_sessions SET revoked_at = now() WHERE (refresh_token_hash = $1 OR previous_token_hash = $1) AND revoked_at IS NULL', [
        hashRefreshToken(presented),
      ])
    }
    clearSessionCookies(res)
    res.status(204).end()
  })

  r.get('/me', authenticate(db, config.JWT_SECRET), async (req, res) => {
    const user = requireUser(req)
    res.json(await signedInProfile(user.id))
  })

  // ---- The person's own profile photo -----------------------------------------
  // Anyone signed in sets, reads and removes their own, and only their own.

  r.get('/me/avatar', authenticate(db, config.JWT_SECRET), async (req, res) => {
    const user = requireUser(req)
    const { rows } = await db.query<{ dataUrl: string }>('SELECT data_url AS "dataUrl" FROM user_avatars WHERE user_id = $1', [user.id])
    const body: AvatarResponse = { dataUrl: rows[0]?.dataUrl ?? null }
    res.json(body)
  })

  // Colleagues' small photos, for the chat's circles: anyone signed in may see them.
  r.get('/avatars', authenticate(db, config.JWT_SECRET), async (req, res) => {
    requireUser(req)
    const { ids } = parse(avatarsQuery, req.query)
    const { rows } = await db.query<{ userId: string; dataUrl: string }>(
      `SELECT a.user_id AS "userId", coalesce(a.thumb_data_url, a.data_url) AS "dataUrl"
         FROM user_avatars a JOIN users u ON u.id = a.user_id AND u.deleted_at IS NULL
        WHERE a.user_id = ANY($1::uuid[])`,
      [ids],
    )
    const body: AvatarsResponse = { avatars: Object.fromEntries(rows.map((r) => [r.userId, r.dataUrl])) }
    res.json(body)
  })

  r.put('/me/avatar', authenticate(db, config.JWT_SECRET), async (req, res) => {
    const user = requireUser(req)
    const { dataUrl, thumbDataUrl } = parse(avatarSchema, req.body)
    // The text says JPEG; the bytes must too.
    if (!isJpegDataUrl(dataUrl) || (thumbDataUrl !== undefined && !isJpegDataUrl(thumbDataUrl))) throw badRequest('The photo must be a JPEG.')
    await db.query(
      `INSERT INTO user_avatars (user_id, data_url, thumb_data_url) VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET data_url = EXCLUDED.data_url, thumb_data_url = EXCLUDED.thumb_data_url, updated_at = now()`,
      [user.id, dataUrl, thumbDataUrl ?? null],
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
