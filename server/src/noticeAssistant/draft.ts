// ============================================================================
// §23 — a notice card as the assistant asks for it (propose_notice_change),
// read and checked before anything is kept. The tool's schema guides the
// model; it is not strict, and with eager input streaming the API does not
// check it, so the same shape is read here with zod and then held to the
// Notices page's own rules (noticeSaveSchema: a title, real days in order,
// valid targets, a match mode), with a few more that only a draft needs:
// every target names something that exists, a new notice is shown on some
// day from today, a change changes something, and a withdrawal is of a
// notice still shown or still to come.
// ============================================================================

import { z } from 'zod'
import { AI_NOTICE_ACTIONS, type AiNoticeAction, type AiNoticeDraft, type AiNoticeReach } from '@qc/shared/noticeAssistant'
import { isAiDay } from '@qc/shared/ai'
import { NOTICE_SEVERITIES, NOTICE_TARGET_KINDS, type NoticeMatchMode, type NoticeSeverity, type NoticeTarget, type NoticeTargetKind } from '@qc/shared/types'
import type { Queryable } from '../db/pool'
import { describeIssues } from '../automations/draft'
import { isUuid } from '../automations/people'
import { factoryDay } from '../ai/prompt'
import { NOTICE_SELECT, attachNoticeParts, type NoticeRow } from '../modules/notices'
import { noticeSaveSchema, type StoredNotice } from '../modules/noticesService'
import { resolveTargets } from './targets'
import { draftOfNotice, noticeStatus, reachOf } from './view'

// ---- The tool's input schema --------------------------------------------------------

const DRAFT_SCHEMA = {
  type: 'object',
  description: 'create and update only: the whole notice as it will be. For update, everything the person did not ask to change kept as it is.',
  properties: {
    title: { type: 'string', description: "A short title, one line, in the person's language: exactly as readers will see it (at most 200 characters)." },
    body: { type: 'string', description: "The text: clear and complete, in the person's language (at most 4000 characters)." },
    severity: { type: 'string', enum: [...NOTICE_SEVERITIES], description: 'info: news. warning: something to take care with. critical: a safety or quality risk that must not be missed.' },
    requiresAck: { type: 'boolean', description: 'Each reader must press Acknowledge: true for anything safety- or quality-critical; false for news.' },
    matchMode: {
      type: 'string',
      enum: ['all', 'any'],
      description: 'How the targets combine. all: every kind of target must hold, several values of one kind being alternatives. any: one target of any kind is enough.',
    },
    validFrom: { type: 'string', description: 'The first factory day it is shown, YYYY-MM-DD. Today unless the person says otherwise.' },
    validTo: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description: 'The last factory day it is shown, YYYY-MM-DD; null: until withdrawn. Null unless the person gives an end.',
    },
    targets: {
      type: 'array',
      description: 'Whom or where it is aimed at, each value as find_notice_targets returned it. Empty: everyone, everywhere.',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: [...NOTICE_TARGET_KINDS] },
          value: { type: 'string', description: 'The value exactly as find_notice_targets returned it: a machine code, a user id, a role, an order number…' },
        },
        required: ['kind', 'value'],
        additionalProperties: false,
      },
    },
  },
  required: ['title', 'body', 'severity', 'requiresAck', 'matchMode', 'validFrom', 'validTo', 'targets'],
  additionalProperties: false,
}

/** propose_notice_change's input. Not strict (see tools.ts): read with zod below. */
export const PROPOSE_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: [...AI_NOTICE_ACTIONS],
      description: 'create: a new notice. update: change a notice (the whole new version in draft). withdraw: stop showing it, keeping the record and its acknowledgements. delete: remove it from every list.',
    },
    noticeId: { type: 'string', description: 'update, withdraw and delete: the id of the notice (from list_notices).' },
    draft: DRAFT_SCHEMA,
    revisesProposalId: {
      type: 'string',
      description: 'Optional. The proposalId (from its propose_notice_change result) of an earlier card of this conversation that this one is a new version of: that card is marked as replaced by this one.',
    },
  },
  required: ['action'],
  additionalProperties: false,
}

// ---- Reading it back ------------------------------------------------------------------

/** A field the model may leave out or send as null. */
const optional = <T extends z.ZodTypeAny>(schema: T) => schema.nullish().transform((v) => v ?? undefined)

const targetInput = z
  .object({
    kind: z.enum(NOTICE_TARGET_KINDS as unknown as [NoticeTargetKind, ...NoticeTargetKind[]]),
    value: z.string(),
    // A label copied from find_notice_targets is harmless; the one kept is always the source's own.
    label: optional(z.string()),
  })
  .strict()

const draftInput = z
  .object({
    title: z.string(),
    body: optional(z.string()),
    severity: z.enum(NOTICE_SEVERITIES as unknown as [NoticeSeverity, ...NoticeSeverity[]]),
    requiresAck: z.boolean(),
    matchMode: optional(z.enum(['all', 'any'])),
    validFrom: optional(z.string()),
    validTo: z.string().nullish(),
    targets: optional(z.array(targetInput)),
  })
  .strict()

const proposeInput = z
  .object({
    action: z.enum(AI_NOTICE_ACTIONS as unknown as [AiNoticeAction, ...AiNoticeAction[]]),
    noticeId: optional(z.string()),
    draft: optional(draftInput),
    revisesProposalId: optional(z.string()),
  })
  .strict()

/** The action a call asked for, read whatever else is wrong with it: a card needs one. */
export function readAction(input: unknown): AiNoticeAction | null {
  const parsed = z.object({ action: z.enum(AI_NOTICE_ACTIONS as unknown as [AiNoticeAction, ...AiNoticeAction[]]) }).passthrough().safeParse(input)
  return parsed.success ? parsed.data.action : null
}

/** The revisesProposalId a call names, read whatever else is wrong with it. */
export function readRevises(input: unknown): string | null {
  const parsed = z.object({ revisesProposalId: z.string() }).passthrough().safeParse(input)
  return parsed.success ? parsed.data.revisesProposalId : null
}

// ---- Checking it ------------------------------------------------------------------------

/** A notice as a card acts on it: its card form, and the moment it last changed, to the microsecond. */
export interface CurrentNotice {
  notice: StoredNotice
  draft: AiNoticeDraft
  /** notices.updated_at as PostgreSQL writes it: a millisecond timestamp could not tell two changes apart. */
  updatedAtExact: string
}

/**
 * A notice that is not deleted, for a card. Its last change is read in the
 * same statement as its fields: a change made while its targets and files are
 * being read only makes the card stale, never applied over that change.
 */
export async function loadCurrentNotice(q: Queryable, tz: string, id: string): Promise<CurrentNotice | null> {
  if (!isUuid(id)) return null
  const { rows } = await q.query<NoticeRow & { updatedAtExact: string }>(
    `SELECT ${NOTICE_SELECT}, n.updated_at::text AS "updatedAtExact" FROM notices n WHERE n.id = $2 AND n.deleted_at IS NULL`,
    [tz, id],
  )
  if (!rows[0]) return null
  const { updatedAtExact, ...row } = rows[0]
  const [notice] = await attachNoticeParts(q, [row])
  return { notice, draft: draftOfNotice(notice), updatedAtExact }
}

/** A card checked: what it shows, or the precise problems the model must fix. */
export interface CheckedCard {
  action: AiNoticeAction
  /** update / withdraw / delete: the notice, when it exists. */
  noticeId: string | null
  draft: AiNoticeDraft | null
  before: AiNoticeDraft | null
  noticeUpdatedAt: string | null
  reach: AiNoticeReach | null
  errors: string[]
  /** What the model should know besides (a change to a withdrawn notice does not show it again). */
  notes: string[]
}

/** The whole notice compared, its photos and files aside (a change keeps them) and its targets in any order. */
const sameNotice = (a: AiNoticeDraft, b: AiNoticeDraft): boolean => {
  const targets = (d: AiNoticeDraft) => d.targets.map((t) => `${t.kind}:${t.value}`).sort().join('\n')
  return (
    a.title === b.title &&
    a.body === b.body &&
    a.severity === b.severity &&
    a.requiresAck === b.requiresAck &&
    a.matchMode === b.matchMode &&
    a.validFrom === b.validFrom &&
    a.validTo === b.validTo &&
    targets(a) === targets(b)
  )
}

/**
 * Read and check a call (whose action is known: readAction). Everything wrong
 * is reported at once, so one more call can put it all right. `now` decides
 * the factory day: a new notice's first day by default, and what "shown" means.
 */
export async function checkCard(q: Queryable, tz: string, action: AiNoticeAction, input: unknown, now: Date): Promise<CheckedCard> {
  const out: CheckedCard = { action, noticeId: null, draft: null, before: null, noticeUpdatedAt: null, reach: null, errors: [], notes: [] }
  const parsed = proposeInput.safeParse(input)
  if (!parsed.success) {
    out.errors = describeIssues(parsed.error)
    return out
  }
  const call = parsed.data
  const today = factoryDay(now, tz)
  const wantsDraft = action === 'create' || action === 'update'
  if (wantsDraft && !call.draft) out.errors.push(`draft: ${action === 'create' ? 'a new notice' : 'a change'} needs the whole notice as it will be.`)
  if (!wantsDraft && call.draft) out.errors.push(`draft: a ${action === 'withdraw' ? 'withdrawal' : 'deletion'} carries no draft; leave it out.`)
  if (action === 'create' && call.noticeId) out.errors.push('noticeId: a new notice has none yet; leave it out (to change a notice, use action "update").')

  let current: CurrentNotice | null = null
  if (action !== 'create') {
    if (!call.noticeId) out.errors.push(`noticeId: name the notice to ${action === 'update' ? 'change' : action} (its id from list_notices).`)
    else {
      current = await loadCurrentNotice(q, tz, call.noticeId)
      if (!current) out.errors.push(`noticeId: no notice has the id "${call.noticeId.slice(0, 60)}" (or it was deleted). Find it with list_notices.`)
      else {
        out.noticeId = current.notice.id
        out.before = current.draft
        out.noticeUpdatedAt = current.updatedAtExact
        const status = noticeStatus(current.notice, today)
        if (action === 'withdraw' && status === 'withdrawn') out.errors.push('noticeId: that notice is withdrawn already; there is nothing to withdraw.')
        if (action === 'withdraw' && status === 'expired') out.errors.push(`noticeId: that notice ended on ${current.notice.validTo}; it is no longer shown, so there is nothing to withdraw.`)
        if (action === 'update' && status === 'withdrawn') out.notes.push('That notice is withdrawn: the change does not show it again.')
      }
    }
  }

  if (call.draft) {
    const d = call.draft
    const validFrom = d.validFrom ?? today
    const validTo = d.validTo ?? null
    if (!isAiDay(validFrom)) out.errors.push(`draft.validFrom: "${validFrom.slice(0, 40)}" is not a day; write YYYY-MM-DD.`)
    if (validTo !== null && !isAiDay(validTo)) out.errors.push(`draft.validTo: "${validTo.slice(0, 40)}" is not a day; write YYYY-MM-DD, or null for until withdrawn.`)
    // The page's own rules first, on the targets as written: kinds, values in their form, how many.
    const asSaved = noticeSaveSchema.safeParse({
      title: d.title,
      body: d.body ?? '',
      severity: d.severity,
      requiresAck: d.requiresAck,
      matchMode: d.matchMode ?? 'all',
      validFrom,
      validTo,
      targets: (d.targets ?? []).map((t) => ({ kind: t.kind, value: t.value })),
    })
    if (!asSaved.success) out.errors.push(...describeIssues(asSaved.error, 'draft'))
    else {
      const resolved = await resolveTargets(q, asSaved.data.targets as { kind: NoticeTargetKind; value: string }[], current?.notice.targets ?? [])
      out.errors.push(...resolved.errors.map((e) => `draft.${e}`))
      const s = asSaved.data
      const draft: AiNoticeDraft = {
        title: s.title,
        body: s.body,
        severity: s.severity as NoticeSeverity,
        requiresAck: s.requiresAck,
        matchMode: s.matchMode as NoticeMatchMode,
        validFrom: s.validFrom,
        validTo: s.validTo,
        targets: resolved.targets,
      }
      // A change keeps the notice's photos and files: the card says how many.
      if (current?.draft.attachments) draft.attachments = current.draft.attachments
      if (action === 'create' && draft.validTo !== null && draft.validTo < today) {
        out.errors.push(`draft.validTo: ${draft.validTo} is before today (${today}): the notice would never be shown.`)
      }
      if (action === 'update' && current && sameNotice(draft, current.draft)) {
        out.errors.push('draft: it is the notice exactly as it is. Change what the person asked for, or tell them nothing needs changing.')
      }
      out.draft = draft
    }
  }

  if (out.errors.length === 0) {
    const shown: { targets: NoticeTarget[]; matchMode: NoticeMatchMode } | null = out.draft ?? out.before
    if (shown) out.reach = await reachOf(q, shown.targets, shown.matchMode)
  }
  return out
}
