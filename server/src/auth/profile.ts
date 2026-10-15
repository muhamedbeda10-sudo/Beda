// ============================================================================
// §14 — an account as the app shows it: who they are, and what they may open
// and do now (their role's set with their own overrides; everything for
// ADMIN+). The sign-in answers and /auth/me give it to the person; the users
// screen lists every account so, with each one's overrides.
// ============================================================================

import type { ManagedUser, Role, UserProfile } from '@qc/shared/types'
import type { Queryable } from '../db/pool'
import { PERMISSION_COLUMNS, permissionRecord } from './permissions'

const PROFILE_SELECT = `u.id, u.username, u.name, u.role, u.is_active AS "isActive", u.created_at AS "createdAt", u.last_login_at AS "lastLoginAt",
  ${PERMISSION_COLUMNS}`

interface ProfileRow {
  id: string
  username: string
  name: string
  role: Role
  isActive: boolean
  createdAt: string
  lastLoginAt: string | null
  adminPlus: boolean
  rolePermissions: string[]
  overrides: { permission: string; granted: boolean }[]
}

function toManaged(r: ProfileRow): ManagedUser {
  const held = permissionRecord(r.role, r)
  return {
    id: r.id,
    username: r.username,
    name: r.name,
    role: r.role,
    isActive: r.isActive,
    createdAt: r.createdAt,
    lastLoginAt: r.lastLoginAt,
    permissions: held.permissions,
    adminPlus: held.adminPlus,
    overrides: held.overrides,
  }
}

/** The account as its person sees it: without the list of overrides, which is the users screen's. */
export function profileOf(m: ManagedUser): UserProfile {
  const { overrides: _overrides, ...profile } = m
  return profile
}

/** A live account (not removed, not the system sender), with its permissions; null when there is none. */
export async function loadManagedUser(q: Queryable, id: string, lock = false): Promise<ManagedUser | null> {
  const { rows } = await q.query<ProfileRow>(
    `SELECT ${PROFILE_SELECT} FROM users u WHERE u.id = $1 AND u.deleted_at IS NULL AND NOT u.is_system${lock ? ' FOR UPDATE OF u' : ''}`,
    [id],
  )
  return rows[0] ? toManaged(rows[0]) : null
}

export async function loadProfile(q: Queryable, id: string): Promise<UserProfile | null> {
  const m = await loadManagedUser(q, id)
  return m ? profileOf(m) : null
}

/** Every live account, by name, with its permissions and overrides. */
export async function listManagedUsers(q: Queryable): Promise<ManagedUser[]> {
  const { rows } = await q.query<ProfileRow>(`SELECT ${PROFILE_SELECT} FROM users u WHERE u.deleted_at IS NULL AND NOT u.is_system ORDER BY u.name, u.username`)
  return rows.map(toManaged)
}
