// ============================================================================
// §23 — the assistant's notice tools, given to NEW conversations only (what a
// conversation was sent is never changed: earlier ones go on without them).
//
//   Everyone with the assistant:
//   • list_notices    — the notices they may see, filtered, compactly;
//   • notice_details  — one of them in full, and for an administrator who
//                       read it and who has not yet (read.ts).
//   Administrators the owner allows (the owner implicitly), when the
//   conversation starts:
//   • find_notice_targets   — the values a notice can be aimed at, from the
//                             sources the Notices page offers (targets.ts);
//   • propose_notice_change — a new notice, a change, a withdrawal or a
//                             deletion, checked (draft.ts) and kept as a card
//                             (proposals.ts) that shows exactly what will go
//                             out and to whom. Nothing changes until the
//                             person presses its button (lifecycle.ts).
//
// Every call reads the person again: their role as it is now decides what
// they read, and whether they may still have a notice written — an
// administrator demoted, or one whose permission the owner took back, gets
// "not allowed" from the writing tools from the next call on.
//
// None is strict: with run_sql's and the automations' tools, a grammar grows
// with every strict schema, and these inputs are read with zod and checked in
// full here anyway, the model told exactly what to fix.
// ============================================================================

import { randomUUID } from 'node:crypto'
import type Anthropic from '@anthropic-ai/sdk'
import type { AiStreamEvent } from '@qc/shared/ai'
import { NOTICE_TARGET_KINDS } from '@qc/shared/types'
import type { AiNoticeAction, AiNoticeDraft } from '@qc/shared/noticeAssistant'
import type { Config } from '../config'
import type { Db, Queryable } from '../db/pool'
import type { ToolHandler, ToolOutcome } from '../ai/assistant'
import { describeIssues } from '../automations/draft'
import { checkCard, readAction, readRevises, PROPOSE_INPUT_SCHEMA } from './draft'
import { checkNoticeRevision, freshNoticePart, insertNoticeProposals, supersedeNoticeProposal, type NoticeProposalRecord } from './proposals'
import { LIST_STATUSES, ListNoticesInput, NOT_VISIBLE, NoticeDetailsInput, listNotices, noticeDetails } from './read'
import { currentAccount, noticeManager } from './scope'
import { FindTargetsInput, findTargets, MAX_TARGET_CANDIDATES } from './targets'
import { audienceText, daysText, reachText } from './view'

type ToolUse = Anthropic.Beta.BetaToolUseBlock

export const LIST_NOTICES_TOOL_NAME = 'list_notices'
export const NOTICE_DETAILS_TOOL_NAME = 'notice_details'
export const FIND_NOTICE_TARGETS_TOOL_NAME = 'find_notice_targets'
export const PROPOSE_NOTICE_CHANGE_TOOL_NAME = 'propose_notice_change'

export const LIST_NOTICES_TOOL: Anthropic.Beta.BetaTool = {
  name: LIST_NOTICES_TOOL_NAME,
  description:
    'List the notices this person can see in the app, newest first: for most people the ones in their bell; for an administrator every notice, with how many saw and acknowledged each. ' +
    'Call it whenever a question is about notices (the ai.* views do not hold them). Returns compact rows (id, title, severity, requiresAck, days, status, audience, created by and when); ' +
    'read one in full with notice_details.',
  eager_input_streaming: true,
  input_schema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: [...LIST_STATUSES],
        description:
          'active (shown today; the default), upcoming (starts on a later day), expired (its last day has passed), withdrawn (stopped early), or all. ' +
          'Use all when looking for a particular notice (to read, change, withdraw or delete it) or when the question is about the past.',
      },
      text: { type: 'string', description: 'Optional. Words to find in the title or the text.' },
      targetKind: { type: 'string', enum: [...NOTICE_TARGET_KINDS], description: 'Optional. Only notices aimed at a target of this kind.' },
      targetValue: { type: 'string', description: "Optional, with targetKind: the target's value or part of its label (a machine code, an order number, a person's name…)." },
      createdFrom: { type: 'string', description: 'Optional. Made on or after this factory day, YYYY-MM-DD.' },
      createdTo: { type: 'string', description: 'Optional. Made on or before this factory day, YYYY-MM-DD.' },
      limit: { type: 'integer', description: 'Optional. At most this many (1 to 100; 50 by default).' },
    },
    additionalProperties: false,
  },
}

export const NOTICE_DETAILS_TOOL: Anthropic.Beta.BetaTool = {
  name: NOTICE_DETAILS_TOOL_NAME,
  description:
    'One notice in full, by its id from list_notices: its title and text, severity, days, audience and whom it reaches, its photos and files. ' +
    "For the person's own notice, whether they read and acknowledged it; for an administrator, who read and acknowledged it when, and — for a notice aimed only at people — who has not yet.",
  eager_input_streaming: true,
  input_schema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'The notice id, from list_notices.' } },
    required: ['id'],
    additionalProperties: false,
  },
}

export const FIND_NOTICE_TARGETS_TOOL: Anthropic.Beta.BetaTool = {
  name: FIND_NOTICE_TARGETS_TOOL_NAME,
  description:
    'Look up the values a notice can be aimed at, from the same lists the Notices page offers: machines, factories, processes, shifts, roles, people (active accounts), and from the order sheet order numbers, order lines, item codes and customers. ' +
    `Use the values it returns, exactly, as the targets of propose_notice_change. Returns at most ${MAX_TARGET_CANDIDATES} values, each with its label (and a detail that tells alike ones apart).`,
  eager_input_streaming: true,
  input_schema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: [...NOTICE_TARGET_KINDS] },
      query: {
        type: 'string',
        description:
          "Optional. Part of the value or its label to narrow the list (a machine's code or name, a person's name). Required for the order sheet: the start of the order number or item code, or part of the customer's name.",
      },
    },
    required: ['kind'],
    additionalProperties: false,
  },
}

export const PROPOSE_NOTICE_CHANGE_TOOL: Anthropic.Beta.BetaTool = {
  name: PROPOSE_NOTICE_CHANGE_TOOL_NAME,
  description:
    'Show the person a card for a new notice, a change to a notice, its withdrawal or its deletion. The card shows exactly how the notice will look, its days, its audience and how many people it reaches, ' +
    'with a button (Publish, Apply changes, Withdraw or Delete) and Discard: nothing changes until the person presses the button. ' +
    'Call it as soon as the request is clear: the card is the confirmation, so no agreement in words is needed first. ' +
    'Returns the card (its proposalId, what it shows, whom it reaches), or the exact problems to fix before calling again.',
  eager_input_streaming: true,
  input_schema: PROPOSE_INPUT_SCHEMA as Anthropic.Beta.BetaTool.InputSchema,
}

/** The tools of every new conversation, after run_sql (and the automations' own). */
export const NOTICE_READ_TOOLS: readonly Anthropic.Beta.BetaTool[] = [LIST_NOTICES_TOOL, NOTICE_DETAILS_TOOL]
/** The tools of a new conversation of a person who may have notices written, after the reading ones. */
export const NOTICE_MANAGE_TOOLS: readonly Anthropic.Beta.BetaTool[] = [FIND_NOTICE_TARGETS_TOOL, PROPOSE_NOTICE_CHANGE_TOOL]

const NOT_ALLOWED =
  'Not allowed: this person may not have the assistant write notices (any more): only an administrator the assistant\'s owner allows. Tell them so; nothing was proposed. They can still manage notices on the Notices page if they are an administrator.'
const GONE = 'Not run: the account of the person asking can no longer sign in.'

/** How the button on a card reads, and what it does, by action. */
const BUTTON: Record<AiNoticeAction, { button: string; done: string }> = {
  create: { button: 'Publish', done: 'published' },
  update: { button: 'Apply changes', done: 'changed' },
  withdraw: { button: 'Withdraw', done: 'withdrawn' },
  delete: { button: 'Delete', done: 'deleted' },
}

export interface NoticeToolContext {
  db: Db
  config: Config
  userId: string
  conversationId: string
  turnId: string
  emit: (event: AiStreamEvent) => void
  /** The clock: the factory day a new notice starts on by default, and what "shown today" means. */
  now?: () => Date
}

/** The handlers the answer loop runs by name, for a conversation that was given these tools. */
export function noticeToolHandlers(ctx: NoticeToolContext): Record<string, ToolHandler> {
  return {
    [LIST_NOTICES_TOOL_NAME]: { run: (tu) => list(ctx, tu) },
    [NOTICE_DETAILS_TOOL_NAME]: { run: (tu) => details(ctx, tu) },
    [FIND_NOTICE_TARGETS_TOOL_NAME]: { run: (tu) => targets(ctx, tu) },
    [PROPOSE_NOTICE_CHANGE_TOOL_NAME]: { run: (tu) => propose(ctx, tu) },
  }
}

const now = (ctx: NoticeToolContext) => (ctx.now ? ctx.now() : new Date())
const answered = (tu: ToolUse, content: string): ToolOutcome => ({ result: { type: 'tool_result', tool_use_id: tu.id, content } })
const failed = (tu: ToolUse, content: string): ToolOutcome => ({ result: { type: 'tool_result', tool_use_id: tu.id, is_error: true, content } })
const badInput = (tu: ToolUse, tool: string, errors: string[]): ToolOutcome => failed(tu, [`Fix these and call ${tool} again:`, ...errors.map((e) => `- ${e}`)].join('\n'))

async function list(ctx: NoticeToolContext, tu: ToolUse): Promise<ToolOutcome> {
  const asker = await currentAccount(ctx.db, ctx.userId)
  if (!asker) return failed(tu, GONE)
  const input = ListNoticesInput.safeParse(tu.input ?? {})
  if (!input.success) return badInput(tu, LIST_NOTICES_TOOL_NAME, describeIssues(input.error))
  return answered(tu, await listNotices(ctx.db, ctx.config.FACTORY_TIMEZONE, asker, input.data, now(ctx)))
}

async function details(ctx: NoticeToolContext, tu: ToolUse): Promise<ToolOutcome> {
  const asker = await currentAccount(ctx.db, ctx.userId)
  if (!asker) return failed(tu, GONE)
  const input = NoticeDetailsInput.safeParse(tu.input)
  if (!input.success) return badInput(tu, NOTICE_DETAILS_TOOL_NAME, describeIssues(input.error))
  const text = await noticeDetails(ctx.db, ctx.config.FACTORY_TIMEZONE, asker, input.data.id.trim(), now(ctx))
  return text === null ? failed(tu, NOT_VISIBLE) : answered(tu, text)
}

async function targets(ctx: NoticeToolContext, tu: ToolUse): Promise<ToolOutcome> {
  if (!(await noticeManager(ctx.db, ctx.config, ctx.userId))) return failed(tu, NOT_ALLOWED)
  const input = FindTargetsInput.safeParse(tu.input)
  if (!input.success) return badInput(tu, FIND_NOTICE_TARGETS_TOOL_NAME, describeIssues(input.error))
  const found = await findTargets(ctx.db, input.data.kind, input.data.query)
  if ('needsQuery' in found) return failed(tu, found.needsQuery)
  return answered(tu, JSON.stringify({ kind: input.data.kind, ...(input.data.query ? { query: input.data.query } : {}), values: found.candidates, truncated: found.truncated }))
}

/** What the model reads of a card's notice: how it will read and to whom it goes, not the whole card. */
function shownForModel(d: AiNoticeDraft): Record<string, unknown> {
  return {
    title: d.title,
    severity: d.severity,
    requiresAck: d.requiresAck,
    days: daysText(d.validFrom, d.validTo),
    audience: audienceText(d.targets),
    ...(new Set(d.targets.map((t) => t.kind)).size > 1 ? { matchMode: d.matchMode } : {}),
  }
}

async function propose(ctx: NoticeToolContext, tu: ToolUse): Promise<ToolOutcome> {
  if (!(await noticeManager(ctx.db, ctx.config, ctx.userId))) return failed(tu, NOT_ALLOWED)
  const action = readAction(tu.input)
  // A card needs an action: without one, nothing is kept or shown.
  if (!action) return badInput(tu, PROPOSE_NOTICE_CHANGE_TOOL_NAME, ['action: one of create, update, withdraw, delete.'])
  const checked = await checkCard(ctx.db, ctx.config.FACTORY_TIMEZONE, action, tu.input, now(ctx))
  const errors = [...checked.errors]
  let revises: string | null = null
  let supersedes: string | null = null
  const asked = readRevises(tu.input)
  if (asked) {
    const revision = await checkNoticeRevision(ctx.db, ctx.conversationId, ctx.userId, asked, action)
    errors.push(...revision.errors)
    revises = revision.revises
    supersedes = revision.supersedes
  }
  const ok = errors.length === 0
  // A card that did not pass shows what is wrong, not a notice that would not be the one asked for.
  const record: NoticeProposalRecord = {
    id: randomUUID(),
    userId: ctx.userId,
    toolUseId: tu.id,
    action,
    noticeId: checked.noticeId,
    draft: ok ? checked.draft : null,
    before: checked.before,
    noticeUpdatedAt: checked.noticeId ? checked.noticeUpdatedAt : null,
    reach: ok ? checked.reach : null,
    revisesProposalId: revises,
    ok,
    error: ok ? null : errors.join('\n'),
  }
  ctx.emit({ type: 'notice', part: freshNoticePart(record, ctx.conversationId) })
  const store = async (tx: Queryable) => {
    await insertNoticeProposals(tx, ctx.conversationId, ctx.turnId, [record])
    // Only a version that passed replaces the one before it: a failed one leaves that card as it was.
    if (record.ok && supersedes) await supersedeNoticeProposal(tx, supersedes, ctx.userId)
  }
  if (!ok) {
    const lines = [`Not proposed. Fix these and call ${PROPOSE_NOTICE_CHANGE_TOOL_NAME} again:`, ...errors.map((e) => `- ${e}`)]
    return { result: { type: 'tool_result', tool_use_id: tu.id, is_error: true, content: lines.join('\n') }, store }
  }
  const { button, done } = BUTTON[action]
  const shown = record.draft ?? record.before!
  const notes = [
    `Shown to the person as a card with ${button} and Discard. Nothing changes until they press ${button}: say so, and never say the notice is ${done}.`,
    ...checked.notes,
  ]
  if (action === 'update' && shown.attachments) notes.push("The notice's photos and files stay as they are; to add or remove some, the person uses the Notices page.")
  if (action === 'create') notes.push('To add photos or files, the person opens the notice on the Notices page once it is published.')
  if (supersedes) notes.push('The card of the version it revises is marked as replaced by this one.')
  // A notice going out to people none of whom receives notices (a viewer), or, under all, to people and a role none of them has.
  const reach = record.reach!
  if (record.draft && !reach.everyone && reach.people === 0 && !reach.placeBound) {
    notes.push('It reaches nobody now (the people it names do not receive notices, or no one matches every kind under all): tell the person, and suggest other targets or matchMode any.')
  }
  const content = {
    proposed: true,
    proposalId: record.id,
    action,
    ...(record.noticeId ? { noticeId: record.noticeId } : {}),
    notice: shownForModel(shown),
    reach: reachText(reach),
    note: notes.join(' '),
  }
  return { result: { type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(content) }, store }
}
