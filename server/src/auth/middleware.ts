import type { NextFunction, Request, Response } from 'express'
import { can, type Capability } from '@qc/shared/rules'
import type { Role } from '@qc/shared/types'
import type { Db } from '../db/pool'
import { forbidden, unauthenticated } from '../lib/errors'
import { verifyAccessToken } from './tokens'

export interface AuthUser {
  id: string
  name: string
  role: Role
  sessionId: string
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser
  }
}

/**
 * Resolve the Bearer token to a user. The token is trusted for identity, but
 * role and active flag are re-read from the database on every request, so a
 * deactivated account or a changed role takes effect immediately rather than
 * when the token expires.
 */
export function authenticate(db: Db, secret: string) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    if (!token) return next(unauthenticated())
    const claims = verifyAccessToken(token, secret)
    if (!claims) return next(unauthenticated('Your session has expired. Sign in again.'))

    const { rows } = await db.query<{ id: string; name: string; role: Role; isActive: boolean; revoked: boolean }>(
      `SELECT u.id, u.name, u.role, u.is_active AS "isActive",
              (s.id IS NULL OR s.revoked_at IS NOT NULL OR s.expires_at < now()) AS revoked
         FROM users u
         LEFT JOIN auth_sessions s ON s.id = $2 AND s.user_id = u.id
        WHERE u.id = $1`,
      [claims.sub, claims.sid],
    )
    const u = rows[0]
    if (!u || !u.isActive) return next(unauthenticated('This account is no longer active.'))
    if (u.revoked) return next(unauthenticated('You were signed out. Sign in again.'))
    req.user = { id: u.id, name: u.name, role: u.role, sessionId: claims.sid }
    next()
  }
}

export function requireUser(req: Request): AuthUser {
  if (!req.user) throw unauthenticated()
  return req.user
}

/** Route guard on a domain capability (§14), the same table the client uses. */
export function requireCapability(capability: Capability) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const user = requireUser(req)
    if (!can(user.role, capability)) return next(forbidden())
    next()
  }
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const user = requireUser(req)
    if (!roles.includes(user.role)) return next(forbidden())
    next()
  }
}
