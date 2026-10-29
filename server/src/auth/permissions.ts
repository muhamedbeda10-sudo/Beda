// ============================================================================
// §14 — a person's permissions, read from the database: their role's set
// (role_permissions) with their own overrides (user_permissions); everything
// for ADMIN+, the AI assistant's owner. Read again on every request by the
// authentication middleware, and here for the places that ask about someone
// other than the person asking.
// ============================================================================

import { PERMISSION_IDS, effectivePermissions, isPermission, type Permission, type PermissionOverride } from '@qc/shared/permissions'
import type { Role } from '@qc/shared/types'
import type { Queryable } from '../db/pool'

export interface PermissionRecord {
  role: Role
  adminPlus: boolean
  /** Their role's set. */
  rolePermissions: Permission[]
  overrides: PermissionOverride[]
  /** What they hold: the two together, or everything for ADMIN+. */
  permissions: Permission[]
}

/**
 * The columns that give a user's permissions, for a query over `users u`:
 * whether they are ADMIN+, their role's set, and their overrides.
 */
export const PERMISSION_COLUMNS = `
  EXISTS (SELECT 1 FROM ai_owner o WHERE o.user_id = u.id) AS "adminPlus",
  ARRAY(SELECT rp.permission FROM role_permissions rp WHERE rp.role = u.role ORDER BY rp.permission) AS "rolePermissions",
  COALESCE((SELECT json_agg(json_build_object('permission', up.permission, 'granted', up.granted) ORDER BY up.permission)
              FROM user_permissions up WHERE up.user_id = u.id), '[]'::json) AS overrides`

interface PermissionColumns {
  adminPlus: boolean
  rolePermissions: string[]
  overrides: { permission: string; granted: boolean }[]
}

/** The record from a row carrying PERMISSION_COLUMNS; ids the catalog no longer knows are dropped. */
export function permissionRecord(role: Role, row: PermissionColumns): PermissionRecord {
  const rolePermissions = row.rolePermissions.filter(isPermission)
  const overrides = row.overrides
    .filter((o): o is PermissionOverride => isPermission(o.permission))
    .sort((a, b) => PERMISSION_IDS.indexOf(a.permission) - PERMISSION_IDS.indexOf(b.permission))
  return { role, adminPlus: row.adminPlus, rolePermissions, overrides, permissions: effectivePermissions(rolePermissions, overrides, row.adminPlus) }
}

/** A user's permissions, or null for no such live account. */
export async function loadPermissions(q: Queryable, userId: string): Promise<PermissionRecord | null> {
  const { rows } = await q.query<PermissionColumns & { role: Role }>(
    `SELECT u.role, ${PERMISSION_COLUMNS} FROM users u WHERE u.id = $1 AND u.deleted_at IS NULL AND NOT u.is_system`,
    [userId],
  )
  return rows[0] ? permissionRecord(rows[0].role, rows[0]) : null
}

/** Whether a user holds a permission now (false for no such account). */
export async function userHas(q: Queryable, userId: string, permission: Permission): Promise<boolean> {
  const { rows } = await q.query<{ has: boolean }>(`SELECT user_has_permission($1, $2) AS has`, [userId, permission])
  return rows[0]?.has ?? false
}

/** Each role's set, as stored. */
export async function loadRolePermissions(q: Queryable): Promise<Record<Role, Permission[]>> {
  const { rows } = await q.query<{ role: Role; permission: string }>(`SELECT role::text AS role, permission FROM role_permissions`)
  const out: Record<Role, Permission[]> = { viewer: [], warehouse: [], inspector: [], supervisor: [], admin: [] }
  for (const r of rows) if (isPermission(r.permission) && out[r.role]) out[r.role].push(r.permission)
  for (const role of Object.keys(out) as Role[]) out[role] = PERMISSION_IDS.filter((p) => out[role].includes(p))
  return out
}
