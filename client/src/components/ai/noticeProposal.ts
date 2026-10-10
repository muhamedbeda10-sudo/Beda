// ============================================================================
// §23 — a notice card in words and checks: what it does (a new notice, a
// change, a withdrawal, a deletion) and how it stands, the days a notice
// shows, how its targets combine and whom it reaches, what a change changes
// (before → after, field by field), what becomes of its photos and files,
// the draft as the reader will see it, the card as it stands now in the
// cached conversation, and when the cards wait for the answer being written.
// Pure, so it is tested without a browser.
// ============================================================================

import type { AiMessagesResponse } from '@qc/shared/ai'
import type { AiNoticeAction, AiNoticeDraft, AiNoticePart, AiNoticeProposalState, AiNoticeReach } from '@qc/shared/noticeAssistant'
import { NOTICE_TARGET_KINDS, NOTICE_TARGET_LABEL, type Notice, type NoticeSeverity, type NoticeTarget, type NoticeTargetKind } from '@qc/shared/types'
import type { BadgeTone } from '@/components/ui'
import { ApiError } from '@/lib/api'
import { formatDate } from '@/lib/utils'
import { isInFlight, type LiveTurn } from './liveTurn'

// ---- What it does, and how it stands ------------------------------------------------------

/** The card's heading. */
export const NOTICE_ACTION_TITLE: Record<AiNoticeAction, string> = {
  create: 'New notice',
  update: 'Change to a notice',
  withdraw: 'Withdraw notice',
  delete: 'Delete notice',
}

/** Its button, and the button while it works. */
export const NOTICE_ACTION_BUTTON: Record<AiNoticeAction, string> = { create: 'Publish', update: 'Apply changes', withdraw: 'Withdraw', delete: 'Delete' }
export const NOTICE_ACTION_BUSY: Record<AiNoticeAction, string> = { create: 'Publishing…', update: 'Applying…', withdraw: 'Withdrawing…', delete: 'Deleting…' }
/** Said when the button failed and the server gave no reason of its own. */
export const NOTICE_ACTION_FAILED: Record<AiNoticeAction, string> = { create: 'Could not publish it.', update: 'Could not apply the changes.', withdraw: 'Could not withdraw it.', delete: 'Could not delete it.' }

/** Said beside the buttons while the card waits: the card is the confirmation, so it says what the button does. */
export const NOTICE_ACTION_HINT: Record<AiNoticeAction, string> = {
  create: 'Nothing goes out until you press Publish. Photos and files are added on the Notices page.',
  update: 'Nothing changes until you press Apply changes.',
  withdraw: 'It keeps showing until you press Withdraw.',
  delete: 'Nothing is deleted until you press Delete and confirm.',
}

/** A card the server did not accept, by what it was for. */
export const NOTICE_REFUSED: Record<AiNoticeAction, string> = {
  create: 'Notice draft not accepted',
  update: 'Change not accepted',
  withdraw: 'Withdrawal not accepted',
  delete: 'Deletion not accepted',
}

/** What pressing the button did, once it was pressed. */
export const NOTICE_APPLIED: Record<AiNoticeAction, string> = { create: 'Published', update: 'Changed', withdraw: 'Withdrawn', delete: 'Deleted' }

const NOT_YET: Record<AiNoticeAction, string> = { create: 'Not published yet', update: 'Not applied yet', withdraw: 'Not withdrawn yet', delete: 'Not deleted yet' }

/** The state chip: "Not published yet", "Published", "Discarded", "Replaced", "Out of date". */
export function noticeStateLabel(action: AiNoticeAction, state: AiNoticeProposalState): string {
  switch (state) {
    case 'proposed':
      return NOT_YET[action]
    case 'applied':
      return NOTICE_APPLIED[action]
    case 'discarded':
      return 'Discarded'
    case 'superseded':
      return 'Replaced'
    case 'stale':
      return 'Out of date'
  }
}

export const NOTICE_STATE_TONE: Record<AiNoticeProposalState, BadgeTone> = { proposed: 'amber', applied: 'green', discarded: 'neutral', superseded: 'neutral', stale: 'neutral' }

/**
 * Why a card out of date can no longer be applied. A change, a withdrawal or
 * a deletion: the notice changed (or went) after the card was made. A new
 * notice: an earlier version of the card was published meanwhile, so this
 * one would publish it twice.
 */
export function staleText(action: AiNoticeAction): string {
  return action === 'create' ? 'An earlier version was published meanwhile; ask the assistant to change that notice instead.' : 'The notice changed since; ask the assistant again.'
}

/** The toast once the button worked: the notice by its title, and where the change is recorded. */
export function appliedToast(action: AiNoticeAction, title: string): string {
  const t = `“${title.trim() || 'The notice'}”`
  switch (action) {
    case 'create':
      return `${t} is published. The change is in the audit log.`
    case 'update':
      return `${t} is changed. The change is in the audit log.`
    case 'withdraw':
      return `${t} is withdrawn: it stops showing at once. The change is in the audit log.`
    case 'delete':
      return `${t} is deleted. The change is in the audit log.`
  }
}

/** The notice the card is about, by its title: as it will be (a new notice, a change), else as it is. */
export function noticeTitle(part: Pick<AiNoticePart, 'draft' | 'before'>): string {
  return (part.draft?.title ?? part.before?.title ?? '').trim()
}

// ---- Days, targets and reach -----------------------------------------------------------------

/** A factory day (YYYY-MM-DD) as the app writes days, taken as that day wherever the device is. */
export function dayText(day: string): string {
  return formatDate(/^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day}T00:00:00` : day)
}

/** The days a notice shows: "From Oct 10 until withdrawn", "Oct 10 only", "Oct 10 – Oct 20". */
export function daysText(d: Pick<AiNoticeDraft, 'validFrom' | 'validTo'>): string {
  if (!d.validTo) return `From ${dayText(d.validFrom)} until withdrawn`
  if (d.validTo === d.validFrom) return `${dayText(d.validFrom)} only`
  return `${dayText(d.validFrom)} – ${dayText(d.validTo)}`
}

/** How several targets combine, in a sentence; null with one target or none (there is nothing to combine). */
export function matchModeText(d: Pick<AiNoticeDraft, 'targets' | 'matchMode'>): string | null {
  if (d.targets.length <= 1) return null
  if (d.matchMode === 'any') return 'One of these is enough.'
  return new Set(d.targets.map((t) => t.kind)).size > 1 ? 'Every kind must hold at once; any one value of each kind.' : 'Any one of these.'
}

/** A target as it reads on its own: "Machine RF-03". */
export const targetText = (t: NoticeTarget): string => `${NOTICE_TARGET_LABEL[t.kind]} ${t.label || t.value}`

type PlaceKind = Exclude<NoticeTargetKind, 'user' | 'role'>
const PLACE_WORD: Record<PlaceKind, string> = {
  factory: 'factory',
  machine: 'machine',
  process: 'process',
  'order-number': 'order',
  'order-line': 'order line',
  'item-code': 'item',
  customer: 'customer',
  shift: 'shift',
}
const isPlace = (kind: NoticeTargetKind): kind is PlaceKind => kind !== 'user' && kind !== 'role'

/** Where a place-bound notice shows, by the kinds of place it names, in the app's order: "machine/order". */
export function placeWords(targets: readonly NoticeTarget[]): string {
  const kinds = new Set(targets.map((t) => t.kind))
  const words = [...new Set(NOTICE_TARGET_KINDS.filter((k) => kinds.has(k) && isPlace(k)).map((k) => PLACE_WORD[k as PlaceKind]))]
  return words.length > 0 ? words.join('/') : 'place'
}

const peopleText = (n: number): string => (n === 1 ? '1 person' : `${n.toLocaleString('en-US')} people`)

/** It reaches no one: no active account among those it names (a notice shown at a place still reaches whoever works there). */
export function reachesNobody(reach: AiNoticeReach, d: Pick<AiNoticeDraft, 'matchMode'>): boolean {
  if (reach.everyone || reach.people !== 0) return false
  return !reach.placeBound || d.matchMode === 'all'
}

/**
 * Whom a notice reaches, as the card's line says it: "Everyone (42 people)",
 * "3 people", "Shown at the machine/order to whoever works there" — and, for
 * people named next to a place, whether the place is one more way to reach
 * someone (any) or a condition on those people (all).
 */
export function reachText(reach: AiNoticeReach, d: Pick<AiNoticeDraft, 'targets' | 'matchMode'>): string {
  if (reach.everyone) return reach.people !== null ? `Everyone (${peopleText(reach.people)})` : 'Everyone'
  if (reachesNobody(reach, d)) return 'Nobody: no active account matches'
  if (reach.placeBound) {
    const place = `the ${placeWords(d.targets)}`
    if (reach.people === null || reach.people === 0) return `Shown at ${place} to whoever works there`
    return d.matchMode === 'any' ? `${peopleText(reach.people)}, and whoever works at ${place}` : `Up to ${peopleText(reach.people)}, when they work at ${place}`
  }
  return peopleText(reach.people ?? 0)
}

// ---- A change, field by field ------------------------------------------------------------

export const NOTICE_SEVERITY_LABEL: Record<NoticeSeverity, string> = { info: 'Information', warning: 'Warning', critical: 'Critical' }

export type NoticeField = 'title' | 'body' | 'severity' | 'requiresAck' | 'validFrom' | 'validTo' | 'targets' | 'matchMode'

/** One field a change changes: its value before and after, in words; for the targets, those added and removed too. */
export interface NoticeChange {
  field: NoticeField
  label: string
  before: string
  after: string
  added?: NoticeTarget[]
  removed?: NoticeTarget[]
}

const targetKey = (t: NoticeTarget): string => `${t.kind}:${t.value}`
const targetsText = (targets: readonly NoticeTarget[]): string => (targets.length === 0 ? 'Everyone, everywhere' : targets.map(targetText).join(', '))
const matchWords = (d: AiNoticeDraft): string => (d.matchMode === 'any' ? 'One of them is enough' : 'Every kind at once')

/**
 * What a change changes, in the order the notice reads: its words, its look,
 * its days and its audience. A target is the same target when its kind and
 * value are (a label read again differently is no change); how targets
 * combine counts only where there is more than one to combine. Its photos
 * and files are never part of it: a change keeps them.
 */
export function noticeChanges(before: AiNoticeDraft, after: AiNoticeDraft): NoticeChange[] {
  const out: NoticeChange[] = []
  const add = (field: NoticeField, label: string, b: string, a: string) => {
    if (b !== a) out.push({ field, label, before: b, after: a })
  }
  add('title', 'Title', before.title, after.title)
  add('body', 'Text', before.body, after.body)
  add('severity', 'Severity', NOTICE_SEVERITY_LABEL[before.severity], NOTICE_SEVERITY_LABEL[after.severity])
  add('requiresAck', 'Acknowledgement', before.requiresAck ? 'Required' : 'Not required', after.requiresAck ? 'Required' : 'Not required')
  add('validFrom', 'Shown from', dayText(before.validFrom), dayText(after.validFrom))
  add('validTo', 'Shown until', before.validTo ? dayText(before.validTo) : 'Until withdrawn', after.validTo ? dayText(after.validTo) : 'Until withdrawn')
  const was = new Set(before.targets.map(targetKey))
  const now = new Set(after.targets.map(targetKey))
  const added = after.targets.filter((t) => !was.has(targetKey(t)))
  const removed = before.targets.filter((t) => !now.has(targetKey(t)))
  if (added.length > 0 || removed.length > 0) out.push({ field: 'targets', label: 'Aimed at', before: targetsText(before.targets), after: targetsText(after.targets), added, removed })
  if (before.matchMode !== after.matchMode && (before.targets.length > 1 || after.targets.length > 1)) add('matchMode', 'Targets combine', matchWords(before), matchWords(after))
  return out
}

/** What the card says of the photos and files the notice carries: null when it has none (and for a new notice, which has none yet). */
export function attachmentsNote(action: AiNoticeAction, attachments: number | undefined): string | null {
  const n = attachments ?? 0
  if (n <= 0 || action === 'create') return null
  if (action === 'update') return `Photos and files stay (${n}); add more on the Notices page.`
  if (action === 'withdraw') return `Its photos and files (${n}) stay with it on the Notices page.`
  return `Its photos and files (${n}) go with it.`
}

/**
 * A draft as a notice, for the reader's view of it (NoticeCard, in its
 * preview mode): no photos or files are drawn — the card says how many
 * stay — and no author or dates of its own.
 */
export function previewNotice(d: AiNoticeDraft): Notice {
  return {
    id: '',
    title: d.title,
    body: d.body,
    severity: d.severity,
    requiresAck: d.requiresAck,
    matchMode: d.matchMode,
    validFrom: d.validFrom,
    validTo: d.validTo,
    targets: d.targets,
    imageIds: [],
    files: [],
    createdById: null,
    createdByName: '',
    createdAt: '',
    updatedAt: '',
  }
}

// ---- The card in the cached conversation ----------------------------------------------------

/**
 * The conversation as cached, with a card as it stands now (after its button
 * or Discard): every answer holding a card of that proposal gets the new one;
 * nothing else changes, and an untouched list is the same object.
 */
export function replaceNoticePart(old: AiMessagesResponse | undefined, part: AiNoticePart): AiMessagesResponse | undefined {
  if (!old) return old
  let changed = false
  const messages = old.messages.map((m) => {
    if (!m.parts.some((p) => p.type === 'notice' && p.proposalId === part.proposalId)) return m
    changed = true
    return { ...m, parts: m.parts.map((p) => (p.type === 'notice' && p.proposalId === part.proposalId ? part : p)) }
  })
  return changed ? { ...old, messages } : old
}

/**
 * Whether the cached conversation holds a card still waiting for its button,
 * other than `except`: a newer card may have replaced it (the server marks it
 * so as it keeps the newer one), so the conversation is worth fetching again.
 */
export function hasOpenNoticeCard(old: AiMessagesResponse | undefined, except: string): boolean {
  return !!old?.messages.some((m) => m.parts.some((p) => p.type === 'notice' && p.ok && p.state === 'proposed' && p.proposalId !== except))
}

/**
 * Whether the cards of a conversation's saved answers wait before they can be
 * decided: the answer being written in it has drafted a notice card that
 * passed, which may be a newer version of one of them. The server marks the
 * one it replaces only as it keeps the round that drafted it, after every
 * call of that round — and a card pressed before then would go out just
 * before its replacement is kept. So their buttons wait until the answer
 * ends; the conversation fetched meanwhile says which one it replaced.
 */
export function noticeCardsWait(live: LiveTurn | null, conversationId: string | null): boolean {
  return !!live && conversationId !== null && live.conversationId === conversationId && isInFlight(live) && live.parts.some((p) => p.type === 'notice' && p.ok)
}

/** The card as a refusal says it stands now (out of date, applied already), when the server sent it along. */
export function noticePartOf(e: unknown, proposalId: string): AiNoticePart | null {
  if (!(e instanceof ApiError) || !e.details || typeof e.details !== 'object') return null
  const part = (e.details as { part?: unknown }).part
  if (!part || typeof part !== 'object') return null
  const p = part as Partial<AiNoticePart>
  return p.type === 'notice' && p.proposalId === proposalId && typeof p.state === 'string' ? (p as AiNoticePart) : null
}
