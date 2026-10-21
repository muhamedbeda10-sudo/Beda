// ============================================================================
// §25 — plans: the automatic one, drafts, scenarios and the published one.
//
//   • The automatic plan is the engine on the data as it is now, with no
//     events: worked out on every request (from inputs kept a minute), and
//     kept as one row of planning_plans (kind 'auto') at most every ten
//     minutes and by the refresher, for the assistant to read.
//   • A draft plan or a scenario is the same engine with its events and
//     settings. It is worked out again whenever it is opened or changed;
//     what it last worked out is kept, with its totals, for the list and the
//     assistant.
//   • Publishing works a plan out one last time and keeps its lines as they
//     were then: the published plan is what the floor follows and what the
//     plan-against-actual reads, until another is published (the one before
//     is then superseded) or it is archived. One is published at a time.
//
// Every change is a transaction with its audit entries (entity
// 'planning-plan'), held to the version the person saw.
// ============================================================================

import {
  AUTO_PLAN_ID,
  capacityOf,
  comparePlans,
  optimisePlan,
  instantOfWall,
  wallOfInstant,
  type ComparisonResponse,
  type CreatePlanRequest,
  type DurationSource,
  type OperationFlag,
  type PlanDetail,
  type PlanEvent,
  type PlanExclusion,
  type PlanHeader,
  type PlanKind,
  type PlanMachineInfo,
  type PlanOperation,
  type PlanResult,
  type PlanSettings,
  type PlanStatus,
  type PlanSummary,
  type UpdatePlanRequest,
} from '@qc/shared/planning'
import type { Config } from '../config'
import { PG, pgCode, withTransaction, type Db, type Queryable } from '../db/pool'
import { auditChanges, auditCreate, auditDelete } from '../audit/service'
import { ConflictError, HttpError, badRequest, forbidden, notFound } from '../lib/errors'
import { effectiveSettings, loadPlanningBase, mergeSettings, planInputs, type PlanningBase } from './data'
import { appendEvents, checkEvents, checkSettings } from './events'

/** Publishing and archiving the published plan take it, so two at once cannot both leave a plan published. */
const PUBLISH_LOCK_KEY = 7_204_930_126

/** How old the kept automatic plan may be before a request keeps it again. */
const AUTO_KEEP_MS = 10 * 60_000
/** How old a draft's kept lines may be before opening it keeps them again. */
const DRAFT_KEEP_MS = 30 * 60_000

export const AUTO_PLAN_NAME = 'Automatic plan'

export interface Planner {
  id: string
  name: string
  canEdit: boolean
  canPublish: boolean
}

interface PlanRow {
  id: string
  kind: PlanKind
  name: string
  description: string
  status: PlanStatus
  baseId: string | null
  events: PlanEvent[]
  settings: Partial<PlanSettings>
  createdById: string | null
  createdByName: string
  createdVia: 'app' | 'assistant'
  createdAt: string
  updatedAt: string
  computedAt: string | null
  computedFrom: string | null
  lines: number | null
  placed: number | null
  late: number | null
  onTimePct: number | null
  lateWeightKg: number | null
  maxLateDays: number | null
  hours: number | null
  assumedHours: number | null
  excludedCount: number | null
  lastFinishAt: string | null
  excluded: PlanExclusion[]
  warnings: string[]
  publishedAt: string | null
  publishedByName: string | null
  version: number
}

const PLAN_COLUMNS = `p.id, p.kind, p.name, p.description, p.status, p.base_id AS "baseId", p.events, p.settings,
  p.created_by_id AS "createdById", p.created_by_name AS "createdByName", p.created_via AS "createdVia", p.created_at AS "createdAt", p.updated_at AS "updatedAt",
  p.computed_at AS "computedAt", p.computed_from AS "computedFrom", p.lines, p.placed, p.late, p.on_time_pct::float8 AS "onTimePct",
  p.late_weight_kg::float8 AS "lateWeightKg", p.max_late_days AS "maxLateDays", p.hours::float8 AS hours, p.assumed_hours::float8 AS "assumedHours",
  p.excluded_count AS "excludedCount", p.last_finish_at AS "lastFinishAt", p.excluded, p.warnings,
  p.published_at AS "publishedAt", p.published_by_name AS "publishedByName", p.version`

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)

function storedSummary(r: PlanRow, timeZone: string): PlanSummary | null {
  if (r.computedAt === null || r.lines === null) return null
  const placed = r.placed ?? 0
  return {
    lines: r.lines,
    placed,
    unplaced: r.lines - placed,
    late: r.late ?? 0,
    onTimePct: r.onTimePct,
    lateWeightKg: r.lateWeightKg ?? 0,
    maxLateDays: r.maxLateDays ?? 0,
    hours: r.hours ?? 0,
    assumedHours: r.assumedHours ?? 0,
    lastFinish: r.lastFinishAt ? wallOfInstant(r.lastFinishAt, timeZone) : null,
    excluded: r.excludedCount ?? 0,
  }
}

function header(r: PlanRow, planner: Planner, timeZone: string, summary?: PlanSummary | null): PlanHeader {
  return {
    id: r.kind === 'auto' ? AUTO_PLAN_ID : r.id,
    kind: r.kind,
    name: r.name,
    description: r.description,
    status: r.status,
    baseId: r.baseId,
    createdByName: r.createdByName,
    createdVia: r.createdVia,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    computedAt: r.computedAt,
    publishedAt: r.publishedAt,
    publishedByName: r.publishedByName,
    version: r.version,
    eventCount: r.events.length,
    summary: summary !== undefined ? summary : storedSummary(r, timeZone),
    editable: r.kind !== 'auto' && r.status === 'draft' && planner.canEdit,
  }
}

/** A plan's events, settings and name, to lay something on it: the automatic plan's (nothing), the published one's, or a kept plan's. */
export async function planBasis(q: Queryable, which: 'auto' | 'published' | string): Promise<{ id: string; name: string; events: PlanEvent[]; settings: Partial<PlanSettings> }> {
  if (which === AUTO_PLAN_ID) return { id: AUTO_PLAN_ID, name: AUTO_PLAN_NAME, events: [], settings: {} }
  const id = which === 'published' ? (await publishedPlanId(q))?.id : which
  const row = id ? await planRow(q, id) : null
  if (!row) {
    if (which === 'published') return { id: AUTO_PLAN_ID, name: AUTO_PLAN_NAME, events: [], settings: {} }
    throw notFound('That plan')
  }
  return { id: row.id, name: row.name, events: row.events, settings: row.settings }
}

/** The machines a plan names, with the capacity it gave each. */
export function machineInfos(base: PlanningBase, settings: PlanSettings, keys?: Iterable<string>): PlanMachineInfo[] {
  const caps = new Map(base.capacities.map((c) => [c.machineKey, c]))
  const wanted = keys ? new Set(keys) : null
  return base.machines
    .filter((m) => !wanted || wanted.has(m.key))
    .map((m) => {
      const c = capacityOf(caps, m.key, settings)
      return { key: m.key, code: m.code, name: m.name, factory: m.factory, process: m.process, known: m.known, hoursPerDay: c.hoursPerDay, capacitySource: c.source }
    })
}

/** Plans worked out, kept as long as the inputs they were worked out from (a minute, data.ts): the optimiser is not run again for every request of the same plan. */
const worked = new Map<string, PlanResult>()
let workedFor = 0

/**
 * A plan worked out now from the data: the automatic one, or one with these events and settings; started from another
 * plan's order when given (a scenario from its base), so the two differ by the scenario's changes alone.
 */
export async function workOut(
  db: Queryable,
  config: Config,
  events: readonly PlanEvent[] = [],
  own: Partial<PlanSettings> = {},
  now = new Date(),
  startFrom?: readonly string[],
): Promise<{ base: PlanningBase; settings: PlanSettings; result: PlanResult }> {
  const base = await loadPlanningBase(db, config.FACTORY_TIMEZONE)
  const settings = effectiveSettings(base, own)
  if (workedFor !== base.readAt) {
    worked.clear()
    workedFor = base.readAt
  }
  const key = JSON.stringify([settings, events, startFrom ?? null])
  let result = worked.get(key)
  if (!result) {
    result = optimisePlan(planInputs(base, now, config.FACTORY_TIMEZONE, settings, events), { startFrom })
    worked.set(key, result)
  }
  return { base, settings, result }
}

/** Keep what a plan worked out: its lines (all of them again), its totals, what it left out and what it could not use. */
export async function keepResult(tx: Queryable, planId: string, result: PlanResult, from: Date, timeZone: string): Promise<void> {
  await tx.query(`DELETE FROM planning_operations WHERE plan_id = $1`, [planId])
  const ops = result.operations
  const at = (w: number | null) => (w === null ? null : instantOfWall(w, timeZone).toISOString())
  if (ops.length > 0) {
    await tx.query(
      `INSERT INTO planning_operations (plan_id, line_id, order_line_id, line_key, order_number, item_code, item, customer, machine_key, seq, qty, hours,
                                        duration_source, start_at, end_at, due_date, late_days, depends_on, weight_kg, flags)
       SELECT $1, li, CASE WHEN li ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN li::uuid END, lk, onum, ic, it, cu, mk, sq, q, h, ds, sa, ea, dd::date, ld,
              ARRAY(SELECT jsonb_array_elements_text(dep)), w, ARRAY(SELECT jsonb_array_elements_text(fl))
         FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::int[], $10::numeric[], $11::numeric[],
                     $12::text[], $13::timestamptz[], $14::timestamptz[], $15::text[], $16::int[], $17::jsonb[], $18::numeric[], $19::jsonb[])
           AS t(li, lk, onum, ic, it, cu, mk, sq, q, h, ds, sa, ea, dd, ld, dep, w, fl)`,
      [
        planId,
        ops.map((o) => o.lineId),
        ops.map((o) => o.lineKey),
        ops.map((o) => o.orderNumber),
        ops.map((o) => o.itemCode),
        ops.map((o) => o.item),
        ops.map((o) => o.customer),
        ops.map((o) => o.machineKey),
        ops.map((o) => o.seq),
        ops.map((o) => o.qty),
        ops.map((o) => o.hours),
        ops.map((o) => o.durationSource),
        ops.map((o) => at(o.start)),
        ops.map((o) => at(o.end)),
        ops.map((o) => o.dueDate),
        ops.map((o) => o.lateDays),
        ops.map((o) => JSON.stringify(o.dependsOn)),
        ops.map((o) => o.weightKg),
        ops.map((o) => JSON.stringify(o.flags)),
      ],
    )
  }
  const s = result.summary
  await tx.query(
    `UPDATE planning_plans SET computed_at = now(), computed_from = $2, lines = $3, placed = $4, late = $5, on_time_pct = $6, late_weight_kg = $7,
            max_late_days = $8, hours = $9, assumed_hours = $10, excluded_count = $11, last_finish_at = $12, excluded = $13, warnings = $14
      WHERE id = $1`,
    [planId, from, s.lines, s.placed, s.late, s.onTimePct, s.lateWeightKg, s.maxLateDays, s.hours, s.assumedHours, s.excluded, at(s.lastFinish), JSON.stringify(result.excluded), JSON.stringify(result.warnings)],
  )
}

/** A kept plan's lines as they were kept. */
export async function keptOperations(q: Queryable, planId: string, timeZone: string): Promise<PlanOperation[]> {
  const { rows } = await q.query<{
    lineId: string
    lineKey: string
    orderNumber: string
    itemCode: string
    item: string
    customer: string
    machineKey: string
    seq: number
    qty: number
    hours: number
    durationSource: DurationSource
    startAt: string | null
    endAt: string | null
    dueDate: string | null
    lateDays: number
    dependsOn: string[]
    weightKg: number | null
    flags: OperationFlag[]
  }>(
    `SELECT line_id AS "lineId", line_key AS "lineKey", order_number AS "orderNumber", item_code AS "itemCode", item, customer, machine_key AS "machineKey",
            seq, qty::float8 AS qty, hours::float8 AS hours, duration_source AS "durationSource", start_at AS "startAt", end_at AS "endAt",
            due_date::text AS "dueDate", late_days AS "lateDays", depends_on AS "dependsOn", weight_kg::float8 AS "weightKg", flags
       FROM planning_operations WHERE plan_id = $1 ORDER BY machine_key, seq`,
    [planId],
  )
  return rows.map((r) => ({
    lineId: r.lineId,
    lineKey: r.lineKey,
    orderNumber: r.orderNumber,
    itemCode: r.itemCode,
    item: r.item,
    customer: r.customer,
    machineKey: r.machineKey,
    seq: r.seq,
    qty: r.qty,
    hours: r.hours,
    durationSource: r.durationSource,
    start: r.startAt ? wallOfInstant(r.startAt, timeZone) : null,
    end: r.endAt ? wallOfInstant(r.endAt, timeZone) : null,
    dueDate: r.dueDate,
    lateDays: r.lateDays,
    dependsOn: r.dependsOn,
    weightKg: r.weightKg,
    flags: r.flags,
  }))
}

async function planRow(q: Queryable, id: string, lock = false): Promise<PlanRow | null> {
  if (id === AUTO_PLAN_ID) {
    const { rows } = await q.query<PlanRow>(`SELECT ${PLAN_COLUMNS} FROM planning_plans p WHERE p.kind = 'auto' AND p.deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`)
    return rows[0] ?? null
  }
  if (!isUuid(id)) return null
  const { rows } = await q.query<PlanRow>(`SELECT ${PLAN_COLUMNS} FROM planning_plans p WHERE p.id = $1 AND p.deleted_at IS NULL AND p.kind <> 'auto'${lock ? ' FOR UPDATE' : ''}`, [id])
  return rows[0] ?? null
}

/** The automatic plan's row, made the first time it is needed. */
async function autoRow(db: Db): Promise<PlanRow> {
  const found = await planRow(db, AUTO_PLAN_ID)
  if (found) return found
  await db.query(
    `INSERT INTO planning_plans (kind, name, description, created_by_name) VALUES ('auto', $1, 'Worked out from the order sheet, the production record and the open inspections as they stand, with no changes.', 'Planning')
     ON CONFLICT DO NOTHING`,
    [AUTO_PLAN_NAME],
  )
  return (await planRow(db, AUTO_PLAN_ID))!
}

/** Keep the automatic plan as it works out now (the assistant reads it). */
export async function keepAutoPlan(db: Db, config: Config, now = new Date()): Promise<void> {
  const row = await autoRow(db)
  const { result } = await workOut(db, config, [], {}, now)
  await withTransaction(db, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(`SELECT id FROM planning_plans WHERE id = $1 FOR UPDATE SKIP LOCKED`, [row.id])
    if (!rows[0]) return // another request is keeping it now
    await keepResult(tx, row.id, result, now, config.FACTORY_TIMEZONE)
  })
}

const audit = (planner: { id: string; name: string }, id: string) => ({ userId: planner.id, userName: planner.name, entity: 'planning-plan', entityId: id })

/** What a plan's audit entries compare. */
const snapshot = (r: Pick<PlanRow, 'name' | 'description' | 'status' | 'events' | 'settings'>) => ({
  name: r.name,
  description: r.description,
  status: r.status,
  events: JSON.stringify(r.events),
  settings: JSON.stringify(r.settings),
})

// ---- Reading ---------------------------------------------------------------------------------

export async function listPlans(db: Db, config: Config, planner: Planner): Promise<PlanHeader[]> {
  const { rows } = await db.query<PlanRow>(
    `SELECT ${PLAN_COLUMNS} FROM planning_plans p WHERE p.deleted_at IS NULL AND p.kind <> 'auto'
      ORDER BY (p.status = 'published') DESC, (p.status = 'draft') DESC, p.updated_at DESC LIMIT 300`,
  )
  const { result } = await workOut(db, config)
  const auto = await autoRow(db)
  return [header(auto, planner, config.FACTORY_TIMEZONE, result.summary), ...rows.map((r) => header(r, planner, config.FACTORY_TIMEZONE))]
}

/** A plan with its lines: the automatic one and a draft worked out now; a published, superseded or archived one as it was kept. */
export async function planDetail(db: Db, config: Config, planner: Planner, id: string, now = new Date()): Promise<PlanDetail> {
  const tz = config.FACTORY_TIMEZONE
  const row = id === AUTO_PLAN_ID ? await autoRow(db) : await planRow(db, id)
  if (!row) throw notFound('That plan')
  if (row.kind === 'auto' || row.status === 'draft') {
    const { base, settings, result } = await workOut(db, config, row.events, row.settings, now)
    const stale = row.computedAt === null || now.getTime() - Date.parse(row.computedAt) > (row.kind === 'auto' ? AUTO_KEEP_MS : DRAFT_KEEP_MS)
    if (stale) {
      // Kept for the list and the assistant; a request that cannot take the row now leaves it to the next.
      await withTransaction(db, async (tx) => {
        const { rows } = await tx.query(`SELECT id FROM planning_plans WHERE id = $1 AND version = $2 FOR UPDATE SKIP LOCKED`, [row.id, row.version])
        if (rows[0]) await keepResult(tx, row.id, result, now, tz)
      }).catch((e) => console.warn('[planning] a plan could not be kept:', e instanceof Error ? e.message : String(e)))
    }
    return {
      plan: { ...header(row, planner, tz, result.summary), events: row.events, settings: row.settings },
      effectiveSettings: settings,
      now: result.now,
      operations: result.operations,
      excluded: result.excluded,
      warnings: result.warnings,
      machines: machineInfos(base, settings, new Set([...result.operations.map((o) => o.machineKey), ...base.machines.filter((m) => m.known).map((m) => m.key)])),
      optimisation: result.optimisation,
    }
  }
  const base = await loadPlanningBase(db, tz)
  const settings = effectiveSettings(base, row.settings)
  const operations = await keptOperations(db, row.id, tz)
  return {
    plan: { ...header(row, planner, tz), events: row.events, settings: row.settings },
    effectiveSettings: settings,
    now: row.computedFrom ? wallOfInstant(row.computedFrom, tz) : wallOfInstant(now, tz),
    operations,
    excluded: row.excluded,
    warnings: row.warnings,
    machines: machineInfos(base, settings, new Set([...operations.map((o) => o.machineKey), ...base.machines.filter((m) => m.known).map((m) => m.key)])),
  }
}

/** The published plan's header with its kept totals, if one is published. */
export async function publishedHeader(q: Queryable, planner: Planner, timeZone: string): Promise<PlanHeader | null> {
  const { rows } = await q.query<PlanRow>(`SELECT ${PLAN_COLUMNS} FROM planning_plans p WHERE p.status = 'published' AND p.deleted_at IS NULL`)
  return rows[0] ? header(rows[0], planner, timeZone) : null
}

/** The published plan's row, if one is published. */
export async function publishedPlanId(q: Queryable): Promise<{ id: string; name: string } | null> {
  const { rows } = await q.query<{ id: string; name: string }>(`SELECT id, name FROM planning_plans WHERE status = 'published' AND deleted_at IS NULL`)
  return rows[0] ?? null
}

/**
 * Two plans line by line: a plan against the one it was made from (or the automatic plan), both worked out now from
 * the same data with their own events, so what differs is the plans' changes, not what happened since one was kept.
 * A base that was deleted since is compared as the automatic plan.
 */
export async function comparePlanWith(db: Db, config: Config, _planner: Planner, id: string, withId?: string): Promise<ComparisonResponse> {
  const row = id === AUTO_PLAN_ID ? await autoRow(db) : await planRow(db, id)
  if (!row) throw notFound('That plan')
  const wanted = withId || row.baseId || AUTO_PLAN_ID
  const base = wanted === AUTO_PLAN_ID ? null : await planRow(db, wanted)
  if (withId && withId !== AUTO_PLAN_ID && !base) throw notFound('The plan to compare with')
  const now = new Date()
  const a = await workOut(db, config, base?.events ?? [], base?.settings ?? {}, now)
  const b = await workOut(db, config, row.events, row.settings, now, a.result.order)
  return { ...comparePlans(a.result, b.result), baseName: base?.name ?? AUTO_PLAN_NAME, scenarioName: row.name }
}

// ---- Writing ---------------------------------------------------------------------------------

export interface MadeBy {
  via: 'app' | 'assistant'
  conversationId?: string | null
}

/** A new draft plan or scenario, worked out and kept at once. */
export async function createPlan(db: Db, config: Config, planner: Planner, req: CreatePlanRequest, madeBy: MadeBy = { via: 'app' }): Promise<string> {
  if (!planner.canEdit) throw forbidden('Making plans needs the permission “Make plans and scenarios”.')
  const name = req.name.trim()
  if (name === '' || name.length > 120) throw badRequest('name: 1 to 120 characters.')
  let events: PlanEvent[] = []
  let settings: Partial<PlanSettings> = {}
  let baseId: string | null = AUTO_PLAN_ID
  if (req.fromId && req.fromId !== AUTO_PLAN_ID) {
    const from = await planRow(db, req.fromId)
    if (!from) throw notFound('The plan to start from')
    events = from.events
    settings = from.settings
    baseId = from.id
  }
  if (req.events !== undefined) {
    const checked = await checkEvents(db, req.events)
    if (checked.errors.length > 0) throw badRequest(checked.errors.join(' '), { errors: checked.errors })
    events = appendEvents(events, checked.events)
  }
  if (req.settings !== undefined) {
    const checked = checkSettings(req.settings)
    if (checked.errors.length > 0) throw badRequest(checked.errors.join(' '), { errors: checked.errors })
    settings = mergeSettings(settings, checked.settings)
  }
  const now = new Date()
  const { result } = await workOut(db, config, events, settings, now)
  return withTransaction(db, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO planning_plans (kind, name, description, base_id, events, settings, created_by_id, created_by_name, created_via, ai_conversation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [req.kind, name, (req.description ?? '').trim().slice(0, 2000), baseId, JSON.stringify(events), JSON.stringify(settings), planner.id, planner.name, madeBy.via, madeBy.conversationId ?? null],
    )
    const id = rows[0].id
    await keepResult(tx, id, result, now, config.FACTORY_TIMEZONE)
    await auditCreate(tx, audit(planner, id))
    return id
  })
}

/** A draft changed (name, description, events, settings), worked out again and kept. */
export async function updatePlan(db: Db, config: Config, planner: Planner, id: string, req: UpdatePlanRequest): Promise<void> {
  if (!planner.canEdit) throw forbidden('Changing plans needs the permission “Make plans and scenarios”.')
  const events = req.events !== undefined ? await checkEvents(db, req.events) : null
  if (events && events.errors.length > 0) throw badRequest(events.errors.join(' '), { errors: events.errors })
  const settings = req.settings !== undefined ? checkSettings(req.settings) : null
  if (settings && settings.errors.length > 0) throw badRequest(settings.errors.join(' '), { errors: settings.errors })
  const name = req.name?.trim()
  if (name !== undefined && (name === '' || name.length > 120)) throw badRequest('name: 1 to 120 characters.')
  const now = new Date()
  await withTransaction(db, async (tx) => {
    const row = await planRow(tx, id, true)
    if (!row) throw notFound('That plan')
    if (row.version !== req.version) throw new ConflictError({ version: row.version })
    if (row.status !== 'draft') throw new HttpError(409, 'conflict', 'Only a draft can be changed: make a new scenario from this plan instead.')
    const next = {
      name: name ?? row.name,
      description: req.description !== undefined ? req.description.trim().slice(0, 2000) : row.description,
      status: row.status,
      events: events ? events.events : row.events,
      settings: settings ? settings.settings : row.settings,
    }
    await tx.query(`UPDATE planning_plans SET name = $2, description = $3, events = $4, settings = $5, version = version + 1 WHERE id = $1`, [
      row.id,
      next.name,
      next.description,
      JSON.stringify(next.events),
      JSON.stringify(next.settings),
    ])
    const { result } = await workOut(tx, config, next.events, next.settings, now)
    await keepResult(tx, row.id, result, now, config.FACTORY_TIMEZONE)
    await auditChanges(tx, audit(planner, row.id), snapshot(row), snapshot(next))
  })
}

/** Publish: the plan worked out one last time and kept as it is; the published one before is superseded. */
export async function publishPlan(db: Db, config: Config, planner: Planner, id: string, version: number): Promise<void> {
  if (!planner.canPublish) throw forbidden('Publishing the plan needs the permission “Publish the plan”.')
  const now = new Date()
  await withTransaction(db, async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock($1)`, [PUBLISH_LOCK_KEY])
    const row = await planRow(tx, id, true)
    if (!row) throw notFound('That plan')
    if (row.version !== version) throw new ConflictError({ version: row.version })
    if (row.status !== 'draft') throw new HttpError(409, 'conflict', 'Only a draft can be published.')
    const before = await tx.query<PlanRow>(`SELECT ${PLAN_COLUMNS} FROM planning_plans p WHERE p.status = 'published' AND p.deleted_at IS NULL FOR UPDATE`)
    for (const old of before.rows) {
      await tx.query(`UPDATE planning_plans SET status = 'superseded', version = version + 1 WHERE id = $1`, [old.id])
      await auditChanges(tx, audit(planner, old.id), snapshot(old), snapshot({ ...old, status: 'superseded' }))
    }
    const { result } = await workOut(tx, config, row.events, row.settings, now)
    await keepResult(tx, row.id, result, now, config.FACTORY_TIMEZONE)
    await tx.query(`UPDATE planning_plans SET status = 'published', published_at = $2, published_by_id = $3, published_by_name = $4, archived_at = NULL, version = version + 1 WHERE id = $1`, [
      row.id,
      now,
      planner.id,
      planner.name,
    ])
    await auditChanges(tx, audit(planner, row.id), snapshot(row), snapshot({ ...row, status: 'published' }))
  }).catch((e: unknown) => {
    // The one-published index, should anything publish around the lock: a conflict to try again, not a failure.
    if (pgCode(e) === PG.UNIQUE_VIOLATION) throw new HttpError(409, 'conflict', 'Another plan was published at the same moment. Look at the plans again before publishing.')
    throw e
  })
}

/** Archive: set aside; a published plan archived leaves the factory with no published plan. */
export async function archivePlan(db: Db, planner: Planner, id: string, version: number): Promise<void> {
  await withTransaction(db, async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock($1)`, [PUBLISH_LOCK_KEY])
    const row = await planRow(tx, id, true)
    if (!row) throw notFound('That plan')
    if (row.version !== version) throw new ConflictError({ version: row.version })
    if (row.status === 'archived') return
    if (row.status === 'published' ? !planner.canPublish : !planner.canEdit) throw forbidden(row.status === 'published' ? 'Archiving the published plan needs the permission “Publish the plan”.' : 'Archiving plans needs the permission “Make plans and scenarios”.')
    await tx.query(`UPDATE planning_plans SET status = 'archived', archived_at = now(), version = version + 1 WHERE id = $1`, [row.id])
    await auditChanges(tx, audit(planner, row.id), snapshot(row), snapshot({ ...row, status: 'archived' }))
  })
}

/** Delete: a draft or an archived plan taken out of the lists (kept, marked deleted). The published one and those it replaced stay. */
export async function deletePlan(db: Db, planner: Planner, id: string, version: number): Promise<void> {
  if (!planner.canEdit) throw forbidden('Deleting plans needs the permission “Make plans and scenarios”.')
  await withTransaction(db, async (tx) => {
    const row = await planRow(tx, id, true)
    if (!row) throw notFound('That plan')
    if (row.version !== version) throw new ConflictError({ version: row.version })
    if (row.status === 'published' || row.status === 'superseded') throw new HttpError(409, 'conflict', 'A plan that was published is kept for plan against actual: archive it instead.')
    await tx.query(`UPDATE planning_plans SET deleted_at = now(), deleted_by_id = $2, version = version + 1 WHERE id = $1`, [row.id, planner.id])
    await auditDelete(tx, audit(planner, row.id))
  })
}
