// ============================================================================
// §23 — a notice in the words the assistant and its cards use: whether it is
// shown today, its days, its audience, and whom it reaches. Reach follows the
// app's own rule (modules/notices.ts): no targets — everyone; aimed only at
// people (users, roles) — those people, counted now among the live accounts
// that receive notices at all; aimed at a place (a machine, an order, a
// shift…) — whoever works there, which no list can name in advance.
// ============================================================================

import type { AiNoticeDraft, AiNoticeReach } from '@qc/shared/noticeAssistant'
import { can } from '@qc/shared/rules'
import { NOTICE_TARGET_LABEL, ROLES, type NoticeMatchMode, type NoticeTarget, type Role } from '@qc/shared/types'
import type { Queryable } from '../db/pool'
import { isUuid } from '../automations/people'
import { isPlaceBound } from '../modules/notices'
import type { StoredNotice } from '../modules/noticesService'

/** Where a notice stands on a factory day. Deleted notices are nowhere: nothing reads them. */
export type NoticeStatus = 'active' | 'upcoming' | 'expired' | 'withdrawn'
export const NOTICE_STATUSES: readonly NoticeStatus[] = ['active', 'upcoming', 'expired', 'withdrawn']

export function noticeStatus(n: { withdrawnAt?: string | null; validFrom: string; validTo: string | null }, today: string): NoticeStatus {
  if (n.withdrawnAt) return 'withdrawn'
  if (n.validFrom > today) return 'upcoming'
  if (n.validTo !== null && n.validTo < today) return 'expired'
  return 'active'
}

/** The days it is shown, in words. */
export function daysText(validFrom: string, validTo: string | null): string {
  if (validTo === null) return `from ${validFrom}, until withdrawn`
  return validFrom === validTo ? `on ${validFrom} only` : `${validFrom} to ${validTo}`
}

/** One target as people read it: its kind and its label (the value when it has none). */
export const targetText = (t: Pick<NoticeTarget, 'kind' | 'value' | 'label'>): string => `${NOTICE_TARGET_LABEL[t.kind]}: ${t.label || t.value}`

/** Whom a notice is aimed at, in words: each target, or everyone. */
export const audienceText = (targets: readonly NoticeTarget[]): string[] => (targets.length === 0 ? ['Everyone'] : targets.map(targetText))

/** A moment as the factory's clock showed it: YYYY-MM-DD HH:MM. */
export function factoryTime(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso))
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`
}

/** A stored notice as a card shows it: its words, look, days and audience, and how many photos and files it carries. */
export function draftOfNotice(n: StoredNotice): AiNoticeDraft {
  const draft: AiNoticeDraft = {
    title: n.title,
    body: n.body,
    severity: n.severity,
    requiresAck: n.requiresAck,
    matchMode: n.matchMode ?? 'all',
    validFrom: n.validFrom,
    validTo: n.validTo ?? null,
    targets: n.targets.map((t) => ({ kind: t.kind, value: t.value, label: t.label })),
  }
  const attachments = n.imageIds.length + n.files.length
  if (attachments > 0) draft.attachments = attachments
  return draft
}

/** The roles whose accounts have a bell: a notice reaches nobody else. */
export const NOTICE_READER_ROLES: readonly Role[] = ROLES.filter((r) => can(r, 'read-notices'))

/** An account that is told: live, not the system sender, of a role with a bell. Requires the alias `u` for users. */
const READER_ACCOUNT = `u.is_active AND u.deleted_at IS NULL AND NOT u.is_system AND u.role::text = ANY($1::text[])`

/**
 * Whom a notice reaches, by its targets and how they combine. `people` counts
 * the accounts it names (everyone, users, roles) as they are now; null when it
 * reaches people only where they work. Under `any` a notice can do both: the
 * people it names at once, and whoever meets it at the place it names.
 */
export async function reachOf(q: Queryable, targets: readonly NoticeTarget[], mode: NoticeMatchMode): Promise<AiNoticeReach> {
  const roles = [...NOTICE_READER_ROLES]
  if (targets.length === 0) {
    const { rows } = await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM users u WHERE ${READER_ACCOUNT}`, [roles])
    return { everyone: true, people: rows[0].n, placeBound: false }
  }
  const users = [...new Set(targets.filter((t) => t.kind === 'user' && isUuid(t.value)).map((t) => t.value.toLowerCase()))]
  const named = [...new Set(targets.filter((t) => t.kind === 'role').map((t) => t.value.trim().toLowerCase()))]
  const namesPeople = targets.some((t) => t.kind === 'user' || t.kind === 'role')
  const placeBound = isPlaceBound([...targets], undefined, mode)
  // Under `all` a place narrows everyone else down to whoever is there; under `any` with no person named, only the place reaches anyone.
  if (placeBound && (mode === 'all' || !namesPeople)) return { everyone: false, people: null, placeBound: true }
  // `all`: each kind present must hold (the values of one kind are alternatives); `any`: one is enough.
  const params: unknown[] = [roles]
  const byUser = () => `u.id = ANY($${params.push(users)}::uuid[])`
  const byRole = () => `lower(u.role::text) = ANY($${params.push(named)}::text[])`
  const kinds = new Set(targets.map((t) => t.kind))
  const cond =
    mode === 'all'
      ? [kinds.has('user') ? byUser() : '', kinds.has('role') ? byRole() : ''].filter(Boolean).join(' AND ')
      : `(${byUser()} OR ${byRole()})`
  const { rows } = await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM users u WHERE ${READER_ACCOUNT} AND ${cond}`, params)
  return { everyone: false, people: rows[0].n, placeBound }
}

const peopleCount = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`

/** Whom it reaches, in words, as the assistant tells it (the card words it in its own way). */
export function reachText(r: AiNoticeReach): string {
  if (r.everyone) return `Everyone (${peopleCount(r.people ?? 0)})`
  if (r.people === null) return 'Whoever works at the place it names, when they meet it there'
  if (r.placeBound) return `${peopleCount(r.people)} at once, and whoever works at the place it names`
  return peopleCount(r.people)
}
