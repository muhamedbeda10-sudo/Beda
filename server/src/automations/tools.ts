// ============================================================================
// §21 — the assistant's two tools for automations, given to a NEW
// conversation of a person allowed to create them (and only then: what a
// conversation was sent is never changed, so earlier ones go on without
// them, and these stay in theirs should the permission go — they then answer
// "not allowed").
//
//   • propose_automation — the draft, checked and run once as the person's
//     current domains (validate.ts), kept as a proposal whether it passed or
//     not, and shown as a card in the answer. The model is told what the run
//     found, or exactly what to fix. Nothing runs until a person presses
//     Activate on the card.
//   • my_automations — the person's automations, compactly, so the model can
//     explain, list or change them (a change is a new proposal that names
//     the one it replaces).
// ============================================================================

import { randomUUID } from 'node:crypto'
import type Anthropic from '@anthropic-ai/sdk'
import type { AiCell, AiStreamEvent } from '@qc/shared/ai'
import type { AutomationBacktest } from '@qc/shared/automation'
import type { Config } from '../config'
import type { Db } from '../db/pool'
import { loadAccess, mayAutomate } from '../ai/access'
import type { ToolHandler, ToolOutcome } from '../ai/assistant'
import { currentAiOwner } from '../ai/owner'
import { cutChars } from '../ai/blocks'
import { readDraft, DRAFT_INPUT_SCHEMA } from './draft'
import { insertProposals, proposalPart, type ProposalRecord, type StoredProposal } from './proposals'
import { withoutIsolates } from './text'
import { validateDraft, type AutomationReaders } from './validate'
import { AUTOMATION_COLUMNS, AUTOMATION_FROM, appState, blockedReason, creatorStates, type AutomationRow } from './views'

type ToolUse = Anthropic.Beta.BetaToolUseBlock

export const PROPOSE_AUTOMATION_TOOL_NAME = 'propose_automation'
export const MY_AUTOMATIONS_TOOL_NAME = 'my_automations'

export const PROPOSE_AUTOMATION_TOOL: Anthropic.Beta.BetaTool = {
  name: PROPOSE_AUTOMATION_TOOL_NAME,
  description:
    'Propose an automation the person asked for: a watch that tells people about each new case its query returns, or a scheduled report. ' +
    'The app checks the proposal, runs it once and shows it to the person as a card with Activate, Edit and Discard: nothing runs until they press Activate. ' +
    'Returns what the run found (cases matching now, sample cases, or each section\'s rows), or the exact problems to fix before calling again.',
  // Not strict: with run_sql's, this schema's alternatives compile to a grammar larger than the API
  // accepts ("compiled grammar is too large"). draft.ts reads the input with zod and validate.ts
  // holds it to every limit, saying what to fix, so nothing unchecked gets through.
  eager_input_streaming: true,
  input_schema: DRAFT_INPUT_SCHEMA as Anthropic.Beta.BetaTool.InputSchema,
}

export const MY_AUTOMATIONS_TOOL: Anthropic.Beta.BetaTool = {
  name: MY_AUTOMATIONS_TOOL_NAME,
  description:
    "List the person's automations: id, name, kind, status and definition. Use it to explain, list or change them; a change is a new propose_automation call with replacesAutomationId.",
  strict: true,
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
}

/** The tools of a new conversation of a person allowed to create automations, after run_sql. */
export const AUTOMATION_TOOLS: readonly Anthropic.Beta.BetaTool[] = [PROPOSE_AUTOMATION_TOOL, MY_AUTOMATIONS_TOOL]

const NOT_ALLOWED = 'Not allowed: this person may not create automations (any more). Tell them so; nothing was proposed.'
/** What my_automations hands the model, at most (as a query's result). */
const LIST_MAX_CHARS = 60_000
/** Sample rows the model reads of a backtest, and how long a cell. */
const MODEL_SAMPLE_ROWS = 5
const MODEL_CELL_CHARS = 200

export interface AutomationToolContext {
  db: Db
  config: Config
  readers: AutomationReaders
  userId: string
  conversationId: string
  turnId: string
  emit: (event: AiStreamEvent) => void
}

/** The handlers the answer loop runs by name, for a conversation that was given these tools. */
export function automationToolHandlers(ctx: AutomationToolContext): Record<string, ToolHandler> {
  return {
    [PROPOSE_AUTOMATION_TOOL_NAME]: { run: (tu, signal) => propose(ctx, tu, signal) },
    [MY_AUTOMATIONS_TOOL_NAME]: { run: (tu) => myAutomations(ctx, tu) },
  }
}

/** The person's access, when they may create automations now. */
async function allowed(ctx: AutomationToolContext) {
  const access = await loadAccess(ctx.db, ctx.userId)
  const owner = (await currentAiOwner(ctx.db, ctx.config)) === ctx.userId
  return mayAutomate(access, owner) ? access : null
}

const failed = (tu: ToolUse, content: string): ToolOutcome => ({ result: { type: 'tool_result', tool_use_id: tu.id, is_error: true, content } })

async function propose(ctx: AutomationToolContext, tu: ToolUse, signal: AbortSignal): Promise<ToolOutcome> {
  const access = await allowed(ctx)
  if (!access) return failed(tu, NOT_ALLOWED)
  const now = new Date()
  const id = randomUUID()
  const read = readDraft(tu.input)
  let record: ProposalRecord
  let errors: string[] = []
  if ('errors' in read) {
    errors = read.errors
    record = { id, userId: ctx.userId, toolUseId: tu.id, ok: false, error: errors.join('\n'), draft: null, backtest: null }
  } else {
    const checked = await validateDraft(
      { db: ctx.db, readers: ctx.readers, timeZone: ctx.config.FACTORY_TIMEZONE, creatorId: ctx.userId, domains: access.domains, now, runQueries: true, signal },
      read.draft,
    )
    if (!checked.ok) errors = checked.errors
    record = {
      id,
      userId: ctx.userId,
      toolUseId: tu.id,
      ok: checked.ok,
      error: checked.ok ? null : checked.errors.join('\n'),
      draft: checked.draft,
      backtest: checked.backtest,
    }
  }
  const stored = await asStored(ctx, record)
  ctx.emit({ type: 'automation', part: await proposalPart(ctx.db, stored) })
  const store = (tx: Parameters<NonNullable<ToolOutcome['store']>>[0]) => insertProposals(tx, ctx.conversationId, ctx.turnId, [record])
  if (!record.ok) {
    const lines = ['Not proposed. Fix these and call propose_automation again:', ...errors.map((e) => `- ${e}`)]
    if (record.backtest) lines.push(`What it found when run: ${JSON.stringify(backtestForModel(record.backtest))}`)
    return { result: { type: 'tool_result', tool_use_id: tu.id, is_error: true, content: lines.join('\n') }, store }
  }
  const content = {
    proposed: true,
    proposalId: id,
    note:
      'Shown to the person as a card with Activate, Edit and Discard. Nothing runs until they press Activate: say so, and never say it is active.' +
      (record.draft?.kind !== 'watch'
        ? ''
        : record.backtest?.keepsCases
          ? " This change keeps the automation's query and key column, so its cases carry on: those already told are not told again, and those not told yet (casesNotToldYet) fire on its next run."
          : ' On activation the cases matching now are recorded as already seen (unless the person asks to be told about them too); only new cases fire.'),
    backtest: record.backtest ? backtestForModel(record.backtest) : null,
  }
  return { result: { type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(content) }, store }
}

/** A proposal as the card shows it before it is stored: proposed, with its creator's name and what it replaces. */
async function asStored(ctx: AutomationToolContext, p: ProposalRecord): Promise<StoredProposal> {
  const replaces = p.draft?.replacesAutomationId ?? null
  const { rows } = await ctx.db.query<{ creatorName: string; replacesName: string | null }>(
    `SELECT u.name AS "creatorName",
            (SELECT a.name FROM ai_automations a WHERE a.id::text = $2 AND a.deleted_at IS NULL) AS "replacesName"
       FROM users u WHERE u.id = $1`,
    [ctx.userId, replaces],
  )
  return { ...p, conversationId: ctx.conversationId, state: 'proposed', automationId: null, creatorName: rows[0]?.creatorName ?? '', replacesName: rows[0]?.replacesName ?? null }
}

const modelCell = (c: AiCell): AiCell => (typeof c === 'string' ? cutChars(c, MODEL_CELL_CHARS, true) : c)

/**
 * What the model reads of a run: the figures and a few rows, not the whole
 * card. A query that failed is only marked so: the card words its failure for
 * the person, and the problems listed with it tell the model what to change.
 */
function backtestForModel(b: AutomationBacktest): Record<string, unknown> {
  if (!b.ok && !b.sections) return { ok: false }
  if (b.sections) {
    return {
      period: b.period ?? null,
      sections: b.sections.map((s) => ({
        title: s.title,
        ok: s.ok,
        columns: s.columns,
        rows: s.rows.slice(0, MODEL_SAMPLE_ROWS).map((r) => r.map(modelCell)),
        rowCount: s.rowCount,
        truncated: s.truncated,
      })),
    }
  }
  return {
    casesMatchingNow: b.matched ?? 0,
    ...(b.newCases !== undefined ? { casesNotToldYet: b.newCases } : {}),
    truncated: b.truncated ?? false,
    columns: b.columns ?? [],
    sampleCases: (b.sampleRows ?? []).slice(0, MODEL_SAMPLE_ROWS).map((r) => r.map(modelCell)),
    ...(b.sampleTitle !== undefined ? { sampleTitle: withoutIsolates(b.sampleTitle) } : {}),
    ...(b.sampleBody !== undefined ? { sampleBody: withoutIsolates(b.sampleBody) } : {}),
  }
}

async function myAutomations(ctx: AutomationToolContext, tu: ToolUse): Promise<ToolOutcome> {
  if (!(await allowed(ctx))) return failed(tu, NOT_ALLOWED)
  const { rows } = await ctx.db.query<AutomationRow>(
    `SELECT ${AUTOMATION_COLUMNS} FROM ${AUTOMATION_FROM} WHERE a.creator_id = $1 AND a.deleted_at IS NULL ORDER BY a.created_at, a.id`,
    [ctx.userId],
  )
  const app = await appState(ctx.db, ctx.config, ctx.readers.ready)
  const states = await creatorStates(ctx.db, [ctx.userId])
  const list = rows.map((r) => {
    const blocked = r.status === 'active' ? blockedReason(r.creatorId, states.get(r.creatorId), app) : null
    return {
      id: r.id,
      name: r.name,
      kind: r.kind,
      status: r.status,
      ...(blocked ? { blockedReason: blocked } : {}),
      ...(r.statusNote ? { statusNote: r.statusNote } : {}),
      description: r.description,
      language: r.language,
      ...(r.watch ? { watch: r.watch } : {}),
      ...(r.schedule ? { schedule: r.schedule } : {}),
      recipients: r.recipients,
      channels: r.channels,
      actions: r.actions,
    }
  })
  // Within what a query's result may hold: the latest automations dropped first, and said so.
  let kept = list
  let text = JSON.stringify({ automations: kept, truncated: false })
  while (text.length > LIST_MAX_CHARS && kept.length > 0) {
    kept = kept.slice(0, -1)
    text = JSON.stringify({ automations: kept, truncated: true, total: list.length })
  }
  return { result: { type: 'tool_result', tool_use_id: tu.id, content: text } }
}
