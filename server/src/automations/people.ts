// ============================================================================
// §21 — the people an automation may reach: live accounts of the factory,
// each once, never the system sender. A role means its accounts at the time
// of the run, not when the automation was made.
// ============================================================================

import { ROLES, type Role } from '@qc/shared/types'
import type { Queryable } from '../db/pool'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v)

/** The values that are uuids, lower-cased, each once, in their first order. Anything else (a query's stray cell) is left out. */
export function distinctIds(values: readonly unknown[]): string[] {
  const out = new Set<string>()
  for (const v of values) if (isUuid(v)) out.add(v.toLowerCase())
  return [...out]
}

/** An account that can be told something now. Requires the alias `u` for users. */
export const LIVE_PERSON = `u.is_active AND u.deleted_at IS NULL AND NOT u.is_system`

/**
 * The live accounts among these people and the members of these roles,
 * each once, by name. Ids that are not live accounts are dropped.
 */
export async function activeUserIds(q: Queryable, sel: { userIds?: string[]; roles?: Role[] }): Promise<string[]> {
  const ids = distinctIds(sel.userIds ?? [])
  const roles = [...new Set(sel.roles ?? [])].filter((r) => ROLES.includes(r))
  if (ids.length === 0 && roles.length === 0) return []
  const { rows } = await q.query<{ id: string }>(
    `SELECT u.id FROM users u
      WHERE ${LIVE_PERSON} AND (u.id = ANY($1::uuid[]) OR u.role::text = ANY($2::text[]))
      ORDER BY lower(u.name), u.id`,
    [ids, roles],
  )
  return rows.map((r) => r.id)
}
