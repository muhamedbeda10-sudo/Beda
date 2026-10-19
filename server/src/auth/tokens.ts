// ============================================================================
// Two tokens, two jobs.
//
//   Access token   short-lived JWT the client keeps in memory and sends as a
//                  Bearer header. Carries id, role and name so most requests
//                  need no lookup beyond the is-still-active check.
//   Refresh token  long-lived random secret in an httpOnly cookie, matched to
//                  a row in auth_sessions by its SHA-256. Rotated on every use
//                  (the token just replaced is answered for a few seconds
//                  more, for a second tab refreshing at the same moment);
//                  revoking the row signs that device out immediately.
// ============================================================================

import { createHash, randomBytes } from 'node:crypto'
import jwt from 'jsonwebtoken'
import type { Role } from '@qc/shared/types'

export interface AccessClaims {
  sub: string
  name: string
  role: Role
  /** auth_sessions.id — lets a revoked device be rejected before expiry. */
  sid: string
}

export function signAccessToken(claims: AccessClaims, secret: string, ttlSeconds: number): string {
  return jwt.sign({ name: claims.name, role: claims.role, sid: claims.sid }, secret, {
    subject: claims.sub,
    expiresIn: ttlSeconds,
    algorithm: 'HS256',
    issuer: 'qc-api',
  })
}

export function verifyAccessToken(token: string, secret: string): AccessClaims | null {
  try {
    const payload = jwt.verify(token, secret, { algorithms: ['HS256'], issuer: 'qc-api' })
    if (typeof payload !== 'object' || payload === null) return null
    const { sub, name, role, sid } = payload as jwt.JwtPayload & Partial<AccessClaims>
    if (typeof sub !== 'string' || typeof name !== 'string' || typeof role !== 'string' || typeof sid !== 'string')
      return null
    return { sub, name, role: role as Role, sid }
  } catch {
    return null
  }
}

export function newRefreshToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * How long the refresh token a device just replaced is still answered. Two
 * tabs (or every window, reloading after a deploy) refresh with the same
 * cookie at once: one rotates it, and the others — arriving with the token it
 * replaced — get a fresh access token for the same device instead of being
 * signed out. Past this, the replaced token is spent.
 */
export const REFRESH_REUSE_GRACE_SECONDS = 30

export const REFRESH_COOKIE = 'qc_refresh'
/** Readable by the client (not httpOnly): tells it a refresh cookie exists so
 *  it knows whether to attempt a silent sign-in on load. Carries no secret. */
export const SESSION_MARKER_COOKIE = 'qc_session'
