// ============================================================================
// §25 — Planning in the AI assistant, for a person given the 'planning'
// domain: the tools of a new conversation (loaded only when a question
// needs them, through the tool search).
//
//   • planning_simulate — a what-if: events (a machine down, a rush order,
//     a Friday worked…) and settings worked out against a plan (the
//     automatic one unless said), and the two compared line by line. Nothing
//     is kept: the assistant tries as many as it likes.
//   • planning_save_scenario — a scenario kept as a draft, marked as made by
//     the assistant, for a planner to open in Planning → Simulator, change,
//     and publish if they will: the assistant never publishes. Needs the
//     app permission "Make plans and scenarios" too; revising one of its own
//     drafts of this conversation changes it in place.
//
// Each reads the person's access and permissions again when it runs.
// ============================================================================

import type Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { AUTO_PLAN_ID, PLAN_EVENT_TYPES, comparePlans, formatWall, type AdviceOption, type AdviseRequest, type PlanEvent, type PlanResult, type PlanSettings, type QuoteOutcome, type QuoteRequest } from '@qc/shared/planning'
import type { Config } from '../config'
import type { Db } from '../db/pool'
import type { ToolHandler, ToolOutcome } from '../ai/assistant'
import { isGranted, loadAccess } from '../ai/access'
import { userHas } from '../auth/permissions'
import { HttpError } from '../lib/errors'
import { appendEvents, checkEvents, checkSettings } from './events'
import { mergeSettings } from './data'
import { createPlan, planDetail, publishedPlanId, updatePlan, workOut, type Planner } from './plans'
import { balance } from './balance'
import { advise, quote } from './quote'

type ToolUse = Anthropic.Beta.BetaToolUseBlock

export const PLANNING_SIMULATE_TOOL_NAME = 'planning_simulate'
export const PLANNING_SAVE_TOOL_NAME = 'planning_save_scenario'
export const PLANNING_QUOTE_TOOL_NAME = 'planning_quote'
export const PLANNING_ADVISE_TOOL_NAME = 'planning_advise'
export const PLANNING_BALANCE_TOOL_NAME = 'planning_balance'

/** Lines a result names at most. */
const MAX_CHANGES = 25

const EVENTS_SCHEMA = {
  type: 'array',
  description:
    'What the scenario changes, each an object with its type. Machines by their code (as ai.machines.machine_code); lines by their Order ID (lineKey = ai.order_lines.line_key); times on the factory clock "YYYY-MM-DD HH:MM"; days YYYY-MM-DD. ' +
    PLAN_EVENT_TYPES.map((t) => `${t.type}: ${t.help}`).join(' ') +
    ' Fields: machine-down {machineKey, from, to}; capacity {machineKey, fromDay, toDay, hoursPerDay}; working-day {day, working, machineKey?}; speed {machineKey, speedPct}; ' +
    'move {lineKey, toMachineKey}; priority {lineKey | orderNumber | customer}; not-before {lineKey, at}; material {lineKey | orderNumber, availableDay}; exclude {lineKey | orderNumber}; ' +
    'due {lineKey | orderNumber, dueDate}; quantity {lineKey, remainingQty}; add-order {orderNumber, item, customer, machineKey, qty, hours, dueDate, notBefore?}; ' +
    'new-order {orderNumber, customer, dueDate, rush?, items: [{itemCode, qty, item?, weightKg?, steps?: [{machineKey, hours?}]}]} (an order not on the sheet, planned through each item\'s learnt route and pace). Each may carry a short note.',
  items: { type: 'object' },
}

const SETTINGS_SCHEMA = {
  type: 'object',
  description:
    'Optional: settings that differ from the planners\' for this scenario, e.g. {"sequenceRule": "due"} (erp | due | fifo), {"timeSource": "actual-first"}, {"overlapPct": 0}, {"includeHold": true}, {"materialGate": false}.',
}

export const PLANNING_SIMULATE_TOOL: Anthropic.Beta.BetaTool = {
  name: PLANNING_SIMULATE_TOOL_NAME,
  description:
    'Planning what-if: work out the factory\'s plan with these changes (events, settings) and compare it with a plan line by line - by default the automatic plan (the data as it is now), or "published", or a plan_id from ai.planning_plans. ' +
    'Returns both plans\' totals (lines, late lines, on-time %, late weight, last finish), how many lines turn late or recover, and the lines that move most with their finish in each plan. Nothing is kept: try as many scenarios as the question needs, then explain what changes and why.',
  eager_input_streaming: true,
  input_schema: {
    type: 'object',
    properties: {
      events: EVENTS_SCHEMA,
      settings: SETTINGS_SCHEMA,
      compare_with: { type: 'string', description: 'auto (the default), published, or a plan_id.' },
    },
    required: ['events'],
    additionalProperties: false,
  },
}

export const PLANNING_SAVE_TOOL: Anthropic.Beta.BetaTool = {
  name: PLANNING_SAVE_TOOL_NAME,
  description:
    'Keep a scenario as a draft in Planning for the planners to review: its name, what it is for, its events and settings. It shows in Planning → Simulator marked as made by the assistant; a planner opens it, changes it and publishes it if they decide to - never say it was published or applied. ' +
    'Only when the person asks to keep or propose it. To change a draft this conversation kept, pass its plan_id as revises. Returns its plan_id and the link to open it.',
  eager_input_streaming: true,
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'A short name, in the person\'s language (at most 120 characters).' },
      description: { type: 'string', description: 'What it tries and what it found, in a few lines.' },
      events: EVENTS_SCHEMA,
      settings: SETTINGS_SCHEMA,
      revises: { type: 'string', description: 'Optional: the plan_id of a draft this conversation kept, to change it in place.' },
    },
    required: ['name', 'events'],
    additionalProperties: false,
  },
}

const ITEMS_SCHEMA = {
  type: 'array',
  description: 'The order\'s items: itemCode (ai.order_lines.item_code; find it with run_sql when the person names the item loosely) and qty (pieces). For an item the record has no route for, give steps: [{machineKey, hours}].',
  items: {
    type: 'object',
    properties: {
      itemCode: { type: 'string' },
      qty: { type: 'number' },
      item: { type: 'string', description: 'Its name, for an item not on the sheet.' },
      weightKg: { type: 'number', description: 'The whole item\'s weight; learnt when left out.' },
      steps: { type: 'array', items: { type: 'object', properties: { machineKey: { type: 'string' }, hours: { type: 'number' } }, required: ['machineKey'] } },
    },
    required: ['itemCode', 'qty'],
  },
}

export const PLANNING_QUOTE_TOOL: Anthropic.Beta.BetaTool = {
  name: PLANNING_QUOTE_TOOL_NAME,
  description:
    'Planning: when could a new order be delivered? Lays an order not on the sheet yet (its items and quantities) on the factory\'s plan - the published one when there is one - through each item\'s learnt route and pace, and returns when it would be done taken in its turn and rushed ahead of everything, each item\'s steps with their machines and dates, and what each does to the orders already planned (lines that turn late). ' +
    'Nothing is kept. Use it for "when can we deliver", "can we promise day X", "how long would N pieces of Y take".',
  eager_input_streaming: true,
  input_schema: {
    type: 'object',
    properties: {
      items: ITEMS_SCHEMA,
      customer: { type: 'string' },
      dueDate: { type: 'string', description: 'The day the customer wants it, YYYY-MM-DD, if any.' },
      orderNumber: { type: 'string', description: 'A name for the order; "NEW" when left out.' },
      base_plan: { type: 'string', description: 'published (the default), auto, or a plan_id.' },
    },
    required: ['items'],
    additionalProperties: false,
  },
}

export const PLANNING_ADVISE_TOOL: Anthropic.Beta.BetaTool = {
  name: PLANNING_ADVISE_TOOL_NAME,
  description:
    'Planning: how to have an order done by a day. For an order on the sheet (its orderNumber) or a new one (its items), it tries what a planner would - rush it, work the Fridays, add hours a day on its machines, move its steps to freer machines, all together - works each out and says which meet the day, what each does to the other orders, and what each costs by the settings\' prices. Returns the options and the best one. Nothing is kept; offer planning_save_scenario with an option\'s events if the person wants it kept.',
  eager_input_streaming: true,
  input_schema: {
    type: 'object',
    properties: {
      dueDate: { type: 'string', description: 'The day it must be done by, YYYY-MM-DD.' },
      orderNumber: { type: 'string', description: 'An order on the sheet (ai.order_lines.order_number).' },
      new_order: { type: 'object', description: 'Or a new order: {items, customer?, orderNumber?} as planning_quote takes them.', properties: { items: ITEMS_SCHEMA, customer: { type: 'string' }, orderNumber: { type: 'string' } }, required: ['items'] },
      base_plan: { type: 'string', description: 'published (the default), auto, or a plan_id.' },
    },
    required: ['dueDate'],
    additionalProperties: false,
  },
}

export const PLANNING_BALANCE_TOOL: Anthropic.Beta.BetaTool = {
  name: PLANNING_BALANCE_TOOL_NAME,
  description:
    'Planning: balance the machines. Finds the machines loaded past their hours over the coming weeks (4 by default) and moves lines, one by one, to another machine that makes the same process of the same item by its learnt route and has room, keeping a move when the plan does not get worse. Returns the moves (line, from, to, hours), the plans\' totals before and after, and the machines still overloaded. Nothing is kept; offer planning_save_scenario with the events to keep them.',
  eager_input_streaming: true,
  input_schema: {
    type: 'object',
    properties: {
      weeks: { type: 'number', description: 'The weeks looked at, 1 to 13 (4 by default).' },
      max_moves: { type: 'number', description: 'Moves tried at most, 1 to 50 (12 by default).' },
      base_plan: { type: 'string', description: 'published (the default), auto, or a plan_id.' },
    },
    additionalProperties: false,
  },
}

export const PLANNING_TOOLS: readonly Anthropic.Beta.BetaTool[] = [PLANNING_SIMULATE_TOOL, PLANNING_SAVE_TOOL, PLANNING_QUOTE_TOOL, PLANNING_ADVISE_TOOL, PLANNING_BALANCE_TOOL]

const SimulateInput = z.object({ events: z.unknown(), settings: z.unknown().optional(), compare_with: z.string().trim().max(60).optional() }).passthrough()
const QuoteInput = z.object({ items: z.unknown(), customer: z.string().trim().max(200).optional(), dueDate: z.string().trim().max(10).optional(), orderNumber: z.string().trim().max(120).optional(), base_plan: z.string().trim().max(60).optional() }).passthrough()
const AdviseInput = z
  .object({
    dueDate: z.string().trim().max(10),
    orderNumber: z.string().trim().max(120).optional(),
    new_order: z.object({ items: z.unknown(), customer: z.string().trim().max(200).optional(), orderNumber: z.string().trim().max(120).optional() }).passthrough().optional(),
    base_plan: z.string().trim().max(60).optional(),
  })
  .passthrough()
const BalanceInput = z.object({ weeks: z.number().int().min(1).max(13).optional(), max_moves: z.number().int().min(1).max(50).optional(), base_plan: z.string().trim().max(60).optional() }).passthrough()
const SaveInput = z
  .object({ name: z.string().trim().min(1).max(120), description: z.string().max(2000).optional(), events: z.unknown(), settings: z.unknown().optional(), revises: z.string().trim().max(60).optional() })
  .passthrough()

export interface PlanningToolContext {
  db: Db
  config: Config
  userId: string
  userName: string
  conversationId: string
}

const answered = (tu: ToolUse, content: unknown): ToolOutcome => ({ result: { type: 'tool_result', tool_use_id: tu.id, content: typeof content === 'string' ? content : JSON.stringify(content) } })
const failed = (tu: ToolUse, content: string): ToolOutcome => ({ result: { type: 'tool_result', tool_use_id: tu.id, is_error: true, content } })

const NOT_GIVEN = 'Not allowed: planning is not among the data the assistant can read for this person (the owner gives it). Nothing was worked out.'

async function mayPlan(ctx: PlanningToolContext): Promise<boolean> {
  const access = await loadAccess(ctx.db, ctx.userId)
  return isGranted(access) && access.domains.includes('planning')
}

const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('\n')

/** A plan's totals as the model reads them: times on the factory clock. */
function totals(r: PlanResult['summary']) {
  return { ...r, lastFinish: r.lastFinish === null ? null : formatWall(r.lastFinish) }
}

async function simulate(ctx: PlanningToolContext, tu: ToolUse): Promise<ToolOutcome> {
  if (!(await mayPlan(ctx))) return failed(tu, NOT_GIVEN)
  const input = SimulateInput.safeParse(tu.input ?? {})
  if (!input.success) return failed(tu, issues(input.error))
  const events = await checkEvents(ctx.db, input.data.events)
  const settings = checkSettings(input.data.settings)
  const errors = [...events.errors, ...settings.errors]
  if (errors.length > 0) return failed(tu, ['Not worked out. Fix these and call again:', ...errors.map((e) => `- ${e}`)].join('\n'))
  const planner: Planner = { id: ctx.userId, name: ctx.userName, canEdit: false, canPublish: false }
  const now = new Date()
  // Both worked out now, from the same data: the plan compared with (its own changes, for a kept one), then the same
  // with the scenario's on top, so the difference is the scenario's alone.
  let baseName = 'Automatic plan'
  let baseEvents: PlanEvent[] = []
  let baseSettings: Partial<PlanSettings> = {}
  const target = (input.data.compare_with ?? AUTO_PLAN_ID).toLowerCase()
  if (target !== AUTO_PLAN_ID) {
    try {
      const id = target === 'published' ? ((await publishedPlanId(ctx.db))?.id ?? null) : target
      if (id === null) return failed(tu, 'No plan is published now: compare with "auto" instead.')
      const d = await planDetail(ctx.db, ctx.config, planner, id, now)
      baseName = d.plan.name
      baseEvents = d.plan.events
      baseSettings = d.plan.settings
    } catch (e) {
      if (e instanceof HttpError) return failed(tu, `compare_with: ${e.message}`)
      throw e
    }
  }
  const { result: base } = await workOut(ctx.db, ctx.config, baseEvents, baseSettings, now)
  const { result } = await workOut(ctx.db, ctx.config, appendEvents(baseEvents, events.events), mergeSettings(baseSettings, settings.settings), now, base.order)
  const cmp = comparePlans(base, result, MAX_CHANGES)
  const at = (w: number | null) => (w === null ? null : formatWall(w))
  return answered(tu, {
    comparedWith: baseName,
    base: totals(cmp.base),
    scenario: totals(cmp.scenario),
    newlyLate: cmp.newlyLate,
    recovered: cmp.recovered,
    finishLater: cmp.later,
    finishSooner: cmp.sooner,
    changes: cmp.changes.map((c) => ({
      lineKey: c.lineKey,
      order: c.orderNumber,
      item: c.item,
      customer: c.customer,
      machine: c.machineKey,
      due: c.dueDate,
      baseFinish: at(c.baseEnd),
      scenarioFinish: at(c.scenarioEnd),
      shiftDays: c.shiftDays,
      baseLateDays: c.baseLateDays,
      scenarioLateDays: c.scenarioLateDays,
      only: c.only ?? undefined,
    })),
    warnings: result.warnings,
    events: events.events,
    note: 'Nothing was kept. Times are the factory clock; a factory day ends 08:00 the next morning. Explain the change in plain words; offer to keep it as a scenario (planning_save_scenario) only if useful.',
  })
}

async function save(ctx: PlanningToolContext, tu: ToolUse): Promise<ToolOutcome> {
  if (!(await mayPlan(ctx))) return failed(tu, NOT_GIVEN)
  if (!(await userHas(ctx.db, ctx.userId, 'edit-planning')))
    return failed(tu, 'Not allowed: keeping scenarios needs the app permission “Make plans and scenarios”, which this person does not have. Nothing was kept; the what-if above still stands.')
  const input = SaveInput.safeParse(tu.input ?? {})
  if (!input.success) return failed(tu, issues(input.error))
  const planner: Planner = { id: ctx.userId, name: ctx.userName, canEdit: true, canPublish: false }
  try {
    let id: string
    if (input.data.revises) {
      const { rows } = await ctx.db.query<{ id: string; version: number }>(
        `SELECT id, version FROM planning_plans WHERE id::text = $1 AND ai_conversation_id = $2 AND created_by_id = $3 AND status = 'draft' AND deleted_at IS NULL`,
        [input.data.revises, ctx.conversationId, ctx.userId],
      )
      if (!rows[0]) return failed(tu, `revises: no draft of this conversation has the plan_id ${input.data.revises} (it may have been published, archived or deleted). Keep a new one instead.`)
      id = rows[0].id
      await updatePlan(ctx.db, ctx.config, planner, id, {
        version: rows[0].version,
        name: input.data.name,
        description: input.data.description,
        events: input.data.events as never,
        settings: (input.data.settings ?? {}) as Partial<PlanSettings>,
      })
    } else {
      id = await createPlan(
        ctx.db,
        ctx.config,
        planner,
        { kind: 'scenario', name: input.data.name, description: input.data.description, events: input.data.events as never, settings: (input.data.settings ?? {}) as Partial<PlanSettings> },
        { via: 'assistant', conversationId: ctx.conversationId },
      )
    }
    const { rows } = await ctx.db.query<{ late: number; lines: number; onTimePct: number | null }>(
      `SELECT late, lines, on_time_pct::float8 AS "onTimePct" FROM planning_plans WHERE id = $1`,
      [id],
    )
    return answered(tu, {
      kept: true,
      planId: id,
      link: `/planning/simulator?plan=${id}`,
      totals: rows[0],
      note: 'Kept as a draft scenario marked as made by the assistant. Give the person the link; a planner reviews it and publishes it if they decide to. It was not published.',
    })
  } catch (e) {
    if (e instanceof HttpError) return failed(tu, `Not kept: ${e.message}`)
    throw e
  }
}

const wallOrNull = (w: number | null) => (w === null ? null : formatWall(w))

async function quoteTool(ctx: PlanningToolContext, tu: ToolUse): Promise<ToolOutcome> {
  if (!(await mayPlan(ctx))) return failed(tu, NOT_GIVEN)
  const input = QuoteInput.safeParse(tu.input ?? {})
  if (!input.success) return failed(tu, issues(input.error))
  const planner: Planner = { id: ctx.userId, name: ctx.userName, canEdit: false, canPublish: false }
  try {
    const q = await quote(ctx.db, ctx.config, planner, {
      items: input.data.items as QuoteRequest['items'],
      customer: input.data.customer,
      dueDate: input.data.dueDate ?? null,
      orderNumber: input.data.orderNumber,
      basePlan: (input.data.base_plan as QuoteRequest['basePlan']) ?? 'published',
    })
    const outcome = (o: QuoteOutcome) => ({
      completes: wallOrNull(o.completes),
      completesDay: o.completesDay,
      daysLate: o.lateDays,
      lines: o.lines.map((l) => ({ item: l.item, itemCode: l.itemCode, process: l.process, machine: l.machineName, pieces: l.qty, hours: l.hours, hoursFrom: l.durationSource, starts: wallOrNull(l.start), finishes: wallOrNull(l.end), flags: l.flags })),
      otherOrders: { turnLate: o.newlyLate, recover: o.recovered, lateWeightKgAdded: o.lateWeightKgDelta, mostMoved: o.impacted.slice(0, 10).map((c) => ({ lineKey: c.lineKey, order: c.orderNumber, customer: c.customer, before: wallOrNull(c.baseEnd), after: wallOrNull(c.scenarioEnd), shiftDays: c.shiftDays, lateDaysBefore: c.baseLateDays, lateDaysAfter: c.scenarioLateDays })) },
    })
    return answered(tu, {
      order: q.orderNumber,
      laidOn: q.baseName,
      dueDate: q.dueDate,
      inItsTurn: outcome(q.asIs),
      rushed: outcome(q.rushed),
      itemsNotPlanned: q.unknownItems,
      warnings: q.warnings,
      events: q.events,
      note: 'Nothing was kept. Times are the factory clock. Give the person the day it completes (in its turn, and rushed) and what rushing costs the other orders; a promise is only as good as the data (learnt routes and paces). To keep it, planning_save_scenario with these events.',
    })
  } catch (e) {
    if (e instanceof HttpError) return failed(tu, `Not worked out: ${e.message}`)
    throw e
  }
}

async function adviseTool(ctx: PlanningToolContext, tu: ToolUse): Promise<ToolOutcome> {
  if (!(await mayPlan(ctx))) return failed(tu, NOT_GIVEN)
  const input = AdviseInput.safeParse(tu.input ?? {})
  if (!input.success) return failed(tu, issues(input.error))
  const planner: Planner = { id: ctx.userId, name: ctx.userName, canEdit: false, canPublish: false }
  try {
    const a = await advise(ctx.db, ctx.config, planner, {
      dueDate: input.data.dueDate,
      orderNumber: input.data.orderNumber,
      newOrder: input.data.new_order as AdviseRequest['newOrder'],
      basePlan: (input.data.base_plan as AdviseRequest['basePlan']) ?? 'published',
    })
    const option = (o: AdviceOption) => ({ id: o.id, name: o.name, detail: o.detail, completes: wallOrNull(o.completes), meetsDue: o.meetsDue, daysLate: o.lateDays, otherOrdersTurnLate: o.newlyLate, otherOrdersRecover: o.recovered, lateTonneDaysAdded: o.lateTonneDaysDelta, cost: o.cost, costLines: o.costLines, events: o.events })
    return answered(tu, {
      target: a.target,
      dueDate: a.dueDate,
      laidOn: a.baseName,
      asIs: option(a.asIs),
      options: a.options.map(option),
      best: a.bestId,
      priced: a.priced,
      warnings: a.warnings,
      note: 'Nothing was kept. Explain the best option and what it costs the other orders (and the factory, when priced); the person decides. To keep one, planning_save_scenario with its events.',
    })
  } catch (e) {
    if (e instanceof HttpError) return failed(tu, `Not worked out: ${e.message}`)
    throw e
  }
}

async function balanceTool(ctx: PlanningToolContext, tu: ToolUse): Promise<ToolOutcome> {
  if (!(await mayPlan(ctx))) return failed(tu, NOT_GIVEN)
  const input = BalanceInput.safeParse(tu.input ?? {})
  if (!input.success) return failed(tu, issues(input.error))
  const planner: Planner = { id: ctx.userId, name: ctx.userName, canEdit: false, canPublish: false }
  try {
    const b = await balance(ctx.db, ctx.config, planner, { weeks: input.data.weeks, maxMoves: input.data.max_moves, basePlan: (input.data.base_plan as 'auto' | 'published' | string | undefined) ?? 'published' })
    return answered(tu, {
      laidOn: b.baseName,
      weeks: b.weeks,
      overloadedBefore: b.overloaded,
      moves: b.moves,
      before: totals(b.before),
      after: totals(b.after),
      stillOverloaded: b.stillOverloaded,
      events: b.events,
      warnings: b.warnings,
      note: 'Nothing was kept. Say which lines move where and what the plan gains; to keep the moves, planning_save_scenario with these events.',
    })
  } catch (e) {
    if (e instanceof HttpError) return failed(tu, `Not worked out: ${e.message}`)
    throw e
  }
}

export function planningToolHandlers(ctx: PlanningToolContext): Record<string, ToolHandler> {
  return {
    [PLANNING_SIMULATE_TOOL_NAME]: { run: (tu) => simulate(ctx, tu) },
    [PLANNING_SAVE_TOOL_NAME]: { run: (tu) => save(ctx, tu) },
    [PLANNING_QUOTE_TOOL_NAME]: { run: (tu) => quoteTool(ctx, tu) },
    [PLANNING_ADVISE_TOOL_NAME]: { run: (tu) => adviseTool(ctx, tu) },
    [PLANNING_BALANCE_TOOL_NAME]: { run: (tu) => balanceTool(ctx, tu) },
  }
}
