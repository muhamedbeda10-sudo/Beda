import type { NextFunction, Request, Response } from 'express'
import { can, type Permission } from '@qc/shared/permissions'
import type { Role } from '@qc/shared/types'
import type { Db } from '../db/pool'
import { forbidden, unauthenticated } from '../lib/errors'
import { PERMISSION_COLUMNS, permissionRecord } from './permissions'
import { verifyAccessToken } from './tokens'

export interface AuthUser {
  id: string
  name: string
  role: Role
  sessionId: string
  /** §14 — what they may open and do, read with the account on this request. */
  permissions: ReadonlySet<Permission>
  /** §14 — the AI assistant's owner: every permission, and nobody else changes the account. */
  adminPlus: boolean
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser
  }
}

/**
 * Resolve the Bearer token to a user. The token is trusted for identity, but
 * role and active flag are re-read from the database on every request, so a
 * deactivated or removed account or a changed role takes effect immediately
 * rather than when the token expires. So are their permissions (§14): their
 * role's set with their own overrides. The system sender (§21) never has a
 * session, whatever a token claims.
 */
export function authenticate(db: Db, secret: string) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    if (!token) return next(unauthenticated())
    const claims = verifyAccessToken(token, secret)
    if (!claims) return next(unauthenticated('Your session has expired. Sign in again.'))

    const { rows } = await db.query<{
      id: string
      name: string
      role: Role
      isActive: boolean
      revoked: boolean
      adminPlus: boolean
      rolePermissions: string[]
      overrides: { permission: string; granted: boolean }[]
    }>(
      `SELECT u.id, u.name, u.role, u.is_active AS "isActive",
              (s.id IS NULL OR s.revoked_at IS NOT NULL OR s.expires_at < now()) AS revoked,
              ${PERMISSION_COLUMNS}
         FROM users u
         LEFT JOIN auth_sessions s ON s.id = $2 AND s.user_id = u.id
        WHERE u.id = $1 AND u.deleted_at IS NULL AND NOT u.is_system`,
      [claims.sub, claims.sid],
    )
    const u = rows[0]
    if (!u || !u.isActive) return next(unauthenticated('This account is no longer active.'))
    if (u.revoked) return next(unauthenticated('You were signed out. Sign in again.'))
    const held = permissionRecord(u.role, u)
    req.user = { id: u.id, name: u.name, role: u.role, sessionId: claims.sid, permissions: new Set(held.permissions), adminPlus: held.adminPlus }
    next()
  }
}

export function requireUser(req: Request): AuthUser {
  if (!req.user) throw unauthenticated()
  return req.user
}

/** Route guard on a permission (§14): the person's own, as read on this request. */
export function requirePermission(permission: Permission) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const user = requireUser(req)
    if (!can(user.permissions, permission)) return next(forbidden())
    next()
  }
}

/** Route guard on any one of several permissions: a screen's data that another screen shows too. */
export function requireAnyPermission(...permissions: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const user = requireUser(req)
    if (!permissions.some((p) => can(user.permissions, p))) return next(forbidden())
    next()
  }
}

/** Whether the person asking holds a permission. */
export const userCan = (user: AuthUser, permission: Permission): boolean => can(user.permissions, permission)
