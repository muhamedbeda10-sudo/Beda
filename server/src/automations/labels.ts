// ============================================================================
// §21 — the names an automation's people read as: who a recipient is, whom a
// follow-up goes to. A person no longer active, or a column its watch's
// result no longer has, is marked invalid rather than left out, so the card
// and the page show what needs putting right.
// ============================================================================

import type {
  AutomationActions,
  AutomationAssignee,
  AutomationAssigneeView,
  AutomationRecipient,
  AutomationRecipientView,
} from '@qc/shared/automation'
import type { Role } from '@qc/shared/types'
import type { Queryable } from '../db/pool'

const ROLE_LABELS: Record<Role, string> = {
  viewer: 'Every viewer',
  inspector: 'Every inspector',
  supervisor: 'Every supervisor',
  admin: 'Every administrator',
}

export interface Person {
  name: string
  /** Can be told: active, not removed, not the system sender. */
  active: boolean
}

/** People by id, as far as they exist; one read for a whole list. */
export async function peopleById(q: Queryable, ids: Iterable<string>): Promise<Map<string, Person>> {
  const wanted = [...new Set(ids)].filter((id) => /^[0-9a-f-]{36}$/i.test(id))
  if (wanted.length === 0) return new Map()
  const { rows } = await q.query<{ id: string; name: string; active: boolean }>(
    `SELECT id, name, (is_active AND deleted_at IS NULL AND NOT is_system) AS active FROM users WHERE id = ANY($1::uuid[])`,
    [wanted],
  )
  return new Map(rows.map((r) => [r.id, { name: r.name, active: r.active }]))
}

/** The user ids a definition names, for one read of their names. */
export function namedUserIds(recipients: readonly AutomationRecipient[], actions: AutomationActions | null | undefined): string[] {
  const ids = recipients.flatMap((r) => (r.kind === 'user' ? [r.userId] : []))
  const a = actions?.followUp?.assignee
  if (a?.kind === 'user') ids.push(a.userId)
  return ids
}

/**
 * Recipients with names to read. A person no longer active, or a column the
 * result no longer has (when the columns are known), is marked invalid.
 */
export function recipientViews(recipients: readonly AutomationRecipient[], people: Map<string, Person>, columns: readonly string[] | null): AutomationRecipientView[] {
  return recipients.map((r) => {
    if (r.kind === 'user') {
      const p = people.get(r.userId)
      const view: AutomationRecipientView = { ...r, label: p?.name ?? 'Unknown account' }
      if (!p?.active) view.invalid = true
      return view
    }
    if (r.kind === 'role') return { ...r, label: ROLE_LABELS[r.role] ?? r.role }
    const view: AutomationRecipientView = { ...r, label: `People in "${r.column}"` }
    if (columns && !columns.includes(r.column)) view.invalid = true
    return view
  })
}

/** A follow-up's assignee with a name to read. */
export function assigneeView(a: AutomationAssignee, people: Map<string, Person>, creator: { name: string }, columns: readonly string[] | null): AutomationAssigneeView {
  if (a.kind === 'creator') return { ...a, label: `${creator.name} (creator)` }
  if (a.kind === 'user') {
    const p = people.get(a.userId)
    const view: AutomationAssigneeView = { ...a, label: p?.name ?? 'Unknown account' }
    if (!p?.active) view.invalid = true
    return view
  }
  const view: AutomationAssigneeView = { ...a, label: `The person in "${a.column}"` }
  if (columns && !columns.includes(a.column)) view.invalid = true
  return view
}
