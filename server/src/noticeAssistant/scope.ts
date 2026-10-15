// ============================================================================
// §23 — who is asking about notices, as they are now. The answer loop has
// checked that the person still has the assistant before every tool call;
// their account and role are read here again on every call too, so an
// administrator demoted while a conversation goes on reads only their own
// bell from the next call on, and can no longer have a notice written.
//
//   • everyone with the assistant reads what the app shows them: their bell;
//   • an administrator reads every notice and who read it, as the Notices
//     page shows it;
//   • an administrator the owner allows (the owner implicitly) may also have
//     the assistant draft a notice, a change, a withdrawal or a deletion.
// ============================================================================

import { can, type Permission } from '@qc/shared/permissions'
import type { Role } from '@qc/shared/types'
import type { Config } from '../config'
import type { Queryable } from '../db/pool'
import { loadAccess, mayManageNotices } from '../ai/access'
import { currentAiOwner } from '../ai/owner'
import { PERMISSION_COLUMNS, permissionRecord } from '../auth/permissions'

/** The person asking, as their account is now. */
export interface NoticeAsker {
  id: string
  name: string
  role: Role
  /** §14 — what they may open and do now. */
  permissions: Permission[]
}

/** The account as it is now; null when it can no longer sign in (deactivated, removed, the system sender). */
export async function currentAccount(q: Queryable, userId: string): Promise<NoticeAsker | null> {
  const { rows } = await q.query<Omit<NoticeAsker, 'permissions'> & Parameters<typeof permissionRecord>[1]>(
    `SELECT u.id, u.name, u.role, ${PERMISSION_COLUMNS} FROM users u WHERE u.id = $1 AND u.is_active AND u.deleted_at IS NULL AND NOT u.is_system`,
    [userId],
  )
  const u = rows[0]
  return u ? { id: u.id, name: u.name, role: u.role, permissions: permissionRecord(u.role, u).permissions } : null
}

/** Reads every notice and who saw and acknowledged it, as the Notices page does. */
export const readsEveryNotice = (who: { permissions: readonly Permission[] }): boolean => can(who.permissions, 'manage-notices')

/** Has a bell at all: a person without one is shown no notices in the app. */
export const receivesNotices = (who: { permissions: readonly Permission[] }): boolean => can(who.permissions, 'read-notices')

/** The person, when they may have the assistant write notices now (mayManageNotices); null otherwise. */
export async function noticeManager(q: Queryable, config: Config, userId: string): Promise<NoticeAsker | null> {
  // One after another: `q` may be a transaction's single connection.
  const account = await currentAccount(q, userId)
  if (!account) return null
  const access = await loadAccess(q, userId)
  const owner = (await currentAiOwner(q, config)) === userId
  return mayManageNotices(access, owner, account.permissions) ? account : null
}

/**
 * What the prompt of a new conversation says about notices, fixed when it
 * starts like the rest of the prompt: a reader of their own bell, an
 * administrator who reads every notice, or one who may also have notices
 * written. The tools read the person again on every call either way.
 */
export type NoticePromptMode = 'reader' | 'administrator' | 'manager'

export function noticePromptMode(who: { permissions: readonly Permission[] }, manages: boolean): NoticePromptMode {
  if (manages) return 'manager'
  return readsEveryNotice(who) ? 'administrator' : 'reader'
}
