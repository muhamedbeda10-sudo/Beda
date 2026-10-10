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

import { can } from '@qc/shared/rules'
import type { Role } from '@qc/shared/types'
import type { Config } from '../config'
import type { Queryable } from '../db/pool'
import { loadAccess, mayManageNotices } from '../ai/access'
import { currentAiOwner } from '../ai/owner'

/** The person asking, as their account is now. */
export interface NoticeAsker {
  id: string
  name: string
  role: Role
}

/** The account as it is now; null when it can no longer sign in (deactivated, removed, the system sender). */
export async function currentAccount(q: Queryable, userId: string): Promise<NoticeAsker | null> {
  const { rows } = await q.query<NoticeAsker>(
    `SELECT id, name, role FROM users WHERE id = $1 AND is_active AND deleted_at IS NULL AND NOT is_system`,
    [userId],
  )
  return rows[0] ?? null
}

/** Reads every notice and who saw and acknowledged it, as the administrator's Notices page does. */
export const readsEveryNotice = (role: Role): boolean => can(role, 'manage-admin-data')

/** Has a bell at all: a role without one is shown no notices in the app. */
export const receivesNotices = (role: Role): boolean => can(role, 'read-notices')

/** The person, when they may have the assistant write notices now (mayManageNotices); null otherwise. */
export async function noticeManager(q: Queryable, config: Config, userId: string): Promise<NoticeAsker | null> {
  // One after another: `q` may be a transaction's single connection.
  const account = await currentAccount(q, userId)
  if (!account) return null
  const access = await loadAccess(q, userId)
  const owner = (await currentAiOwner(q, config)) === userId
  return mayManageNotices(access, owner, account.role) ? account : null
}

/**
 * What the prompt of a new conversation says about notices, fixed when it
 * starts like the rest of the prompt: a reader of their own bell, an
 * administrator who reads every notice, or one who may also have notices
 * written. The tools read the person again on every call either way.
 */
export type NoticePromptMode = 'reader' | 'administrator' | 'manager'

export function noticePromptMode(role: Role, manages: boolean): NoticePromptMode {
  if (manages) return 'manager'
  return readsEveryNotice(role) ? 'administrator' : 'reader'
}
