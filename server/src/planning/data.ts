// ============================================================================
// §25 — what the planning engine is given, read from the factory's record:
// the open order lines (production_orders), the lines an inspection session
// is open on now (inspection_sessions), the machine register, and planning's
// own setup and what it learnt. Read only: nothing here writes a row of the
// order sheet, the production record or the inspections.
//
// Machines are named by ai.machine_key(code), as the assistant compares them.
// The inputs are kept a minute in memory (a planner flicking between the
// tabs asks for the same thing again and again); a change to the setup
// forgets them at once.
// ============================================================================

import {
  DEFAULT_PLAN_SETTINGS,
  capacityOf,
  maintenanceEvents,
  resolveSettings,
  wallOfInstant,
  type CalendarException,
  type DurationMeaningResult,
  type ItemRoute,
  type MachineCapacity,
  type MachineRate,
  type MaintenanceRule,
  type SetupTimeRule,
  type PlanEvent,
  type PlanInputs,
  type PlanLine,
  type PlanMachine,
  type PlanSettings,
  type PlanningProcess,
  type ProcessOrderResult,
} from '@qc/shared/planning'
import { calendarDay } from '@qc/shared/rules'
import type { Queryable } from '../db/pool'

const INPUTS_TTL_MS = 60_000

export interface PlanningBase {
  /** When it was read. */
  readAt: number
  lines: PlanLine[]
  machines: PlanMachine[]
  capacities: MachineCapacity[]
  rates: MachineRate[]
  calendar: CalendarException[]
  /** The items' learnt routes, for an order not on the sheet yet (a new-order event). */
  routes: ItemRoute[]
  /** Changeovers between item families, and each machine's preventive maintenance. */
  setupTimes: SetupTimeRule[]
  maintenance: MaintenanceRule[]
  /** Each machine's pace of the last two weeks as a share of its usual, where learnt. */
  /** Each machine's pace of the last two weeks against its usual, and the days it was seen on. */
  speeds: Map<string, { speedPct: number; recentDays: number }>
  /** The planners' own settings (what they set; the rest is learnt or the defaults). */
  setSettings: Partial<PlanSettings>
  learnt: { processOrder: ProcessOrderResult | null; erpDuration: DurationMeaningResult | null; learntAt: string | null }
}

let cached: { at: number; base: Promise<PlanningBase> } | null = null

/** Forget the inputs kept in memory: the setup changed, or a refresh learnt something new. */
export function forgetPlanningBase(): void {
  cached = null
}

/** The inputs as they stand, read again when older than a minute. */
export function loadPlanningBase(q: Queryable, timeZone: string): Promise<PlanningBase> {
  const now = Date.now()
  if (cached && now - cached.at < INPUTS_TTL_MS) return cached.base
  const base = readPlanningBase(q, timeZone)
  cached = { at: now, base }
  // A failed read is not kept: the next request tries again.
  base.catch(() => {
    if (cached?.base === base) cached = null
  })
  return base
}

/** Partial settings laid over others: what `over` names wins, the nested ones (dependencies, process ranks) key by key. */
export function mergeSettings(under: Partial<PlanSettings>, over: Partial<PlanSettings>): Partial<PlanSettings> {
  const out: Partial<PlanSettings> = { ...under, ...over }
  if (under.dependencies || over.dependencies) out.dependencies = { ...under.dependencies, ...over.dependencies } as PlanSettings['dependencies']
  if (under.processRank || over.processRank) out.processRank = { ...under.processRank, ...over.processRank } as PlanSettings['processRank']
  return out
}

/** Settings laid over others: what `over` names wins, the nested ones merged key by key. */
function layer(under: PlanSettings, over: Partial<PlanSettings>): PlanSettings {
  return resolveSettings({ ...under, ...over, dependencies: { ...under.dependencies, ...over.dependencies }, processRank: { ...under.processRank, ...over.processRank } })
}

/** The settings a plan is worked out with: the defaults, what was learnt, what the planners set, then the plan's own. */
export function effectiveSettings(base: Pick<PlanningBase, 'setSettings' | 'learnt'>, own: Partial<PlanSettings> = {}): PlanSettings {
  const learnt: Partial<PlanSettings> = {}
  if (base.learnt.processOrder?.learnt) learnt.processRank = base.learnt.processOrder.rank
  if (base.learnt.erpDuration?.meaning) learnt.erpDurationMeaning = base.learnt.erpDuration.meaning
  return layer(layer(layer(DEFAULT_PLAN_SETTINGS, learnt), base.setSettings), own)
}

/** The stops the machines' maintenance makes over the horizon from now, as machine-down events: the engine plans around them, and every reading of a machine's hours (load, alerts, balancing) takes them out too. */
export function maintenanceStops(base: PlanningBase, now: Date, timeZone: string, settings: PlanSettings): PlanEvent[] {
  const caps = new Map(base.capacities.map((c) => [c.machineKey, c]))
  return maintenanceEvents(base.maintenance, calendarDay(now, timeZone), settings.horizonDays, (k) => capacityOf(caps, k, settings).hoursPerDay)
}

/** The engine's inputs for a plan from now: the base, the effective settings and the plan's events. */
export function planInputs(base: PlanningBase, now: Date, timeZone: string, settings: PlanSettings, events: PlanInputs['events'] = []): PlanInputs {
  // The stops the machines' maintenance makes over the horizon, and (when the settings say so) each slow machine's pace of late.
  const stops = maintenanceStops(base, now, timeZone, settings)
  const slow: PlanEvent[] = settings.useRecentSpeed
    ? [...base.speeds.entries()].filter(([, s]) => s.speedPct > 0 && s.speedPct < 100).map(([machineKey, s]) => ({ id: `speed:${machineKey}`, type: 'speed', machineKey, speedPct: s.speedPct, note: 'Its pace of the last two weeks' }))
    : []
  return {
    now: wallOfInstant(now, timeZone),
    lines: base.lines,
    machines: base.machines,
    capacities: base.capacities,
    rates: base.rates,
    calendar: base.calendar,
    routes: base.routes,
    setupTimes: base.setupTimes,
    settings,
    events: stops.length > 0 || slow.length > 0 ? [...stops, ...slow, ...(events ?? [])] : events,
  }
}

const MACHINES_SQL = `
  SELECT DISTINCT ON (ai.machine_key(m.code)) ai.machine_key(m.code) AS key, m.code,
         COALESCE(NULLIF(btrim(m.display_name), ''), 'Machine ' || m.code) AS name, COALESCE(btrim(m.factory), '') AS factory, m.process
    FROM machines m
   WHERE m.deleted_at IS NULL
   ORDER BY ai.machine_key(m.code), m.created_at`

export async function readMachines(q: Queryable): Promise<PlanMachine[]> {
  const { rows } = await q.query<{ key: string; code: string; name: string; factory: string; process: PlanningProcess | null }>(MACHINES_SQL)
  return rows.map((r) => ({ ...r, known: true }))
}

interface LineRow {
  id: string
  lineKey: string
  orderNumber: string
  itemCode: string
  item: string
  itemFamily: string | null
  customer: string
  machineKey: string
  requiredQty: number
  remainingQty: number
  weightKg: number | null
  erpHours: number | null
  dueDate: string | null
  plannedStart: string | null
  plannedFinish: string | null
  orderDay: string | null
  erpStatus: string
  parentId: string | null
  modelGroupId: string | null
  rawMaterialQty: number | null
  rmReceivedQty: number | null
  rmPromiseDate: string | null
  runningSince: string | null
}

/**
 * The order lines with something left to make (the ERP's remaining quantity
 * where it wrote one, else required less finished), each with the start of
 * the inspection session open on it, if any. Cancelled and held lines come
 * too: the engine says why it leaves each out.
 */
async function readLines(q: Queryable, timeZone: string): Promise<PlanLine[]> {
  const { rows } = await q.query<LineRow>(
    `WITH running AS (
       SELECT s.order_id, min(s.started_at) AS since
         FROM inspection_sessions s
        WHERE s.status = 'Open' AND s.deleted_at IS NULL
        GROUP BY s.order_id)
     SELECT o.id, btrim(o.line_key) AS "lineKey", btrim(o.order_number) AS "orderNumber", btrim(o.item_code) AS "itemCode", btrim(o.item) AS item,
            NULLIF(btrim(o.item_family), '') AS "itemFamily", btrim(o.customer) AS customer, ai.machine_key(o.work_center_code) AS "machineKey",
            o.required_qty::float8 AS "requiredQty",
            GREATEST(0, COALESCE(o.erp_remaining_qty, o.required_qty - o.finished_qty))::float8 AS "remainingQty",
            o.weight_kg::float8 AS "weightKg", o.part_duration_hours::float8 AS "erpHours",
            o.due_date::text AS "dueDate", o.planned_start::text AS "plannedStart", o.planned_finish::text AS "plannedFinish",
            (o.order_date AT TIME ZONE $1)::date::text AS "orderDay",
            btrim(o.erp_status) AS "erpStatus",
            CASE WHEN lower(btrim(o.parent_id)) IN ('', 'null', 'deleted', 'del') THEN NULL ELSE btrim(o.parent_id) END AS "parentId",
            NULLIF(btrim(o.model_group_id), '') AS "modelGroupId",
            o.raw_material_qty::float8 AS "rawMaterialQty", o.rm_received_qty::float8 AS "rmReceivedQty", o.rm_promise_date::text AS "rmPromiseDate",
            r.since AS "runningSince"
       FROM production_orders o
       LEFT JOIN running r ON r.order_id = o.id
      WHERE o.deleted_at IS NULL
        AND (COALESCE(o.erp_remaining_qty, o.required_qty - o.finished_qty) > 0 OR r.order_id IS NOT NULL)`,
    [timeZone],
  )
  return rows.map((r) => ({
    id: r.id,
    lineKey: r.lineKey,
    orderNumber: r.orderNumber,
    itemCode: r.itemCode,
    item: r.item,
    itemFamily: r.itemFamily,
    customer: r.customer,
    machineKey: r.machineKey,
    requiredQty: r.requiredQty,
    remainingQty: r.remainingQty,
    weightKg: r.weightKg,
    erpHours: r.erpHours,
    dueDate: r.dueDate,
    plannedStart: r.plannedStart,
    plannedFinish: r.plannedFinish,
    orderDate: r.orderDay,
    erpStatus: r.erpStatus,
    hold: false,
    parentId: r.parentId,
    modelGroupId: r.modelGroupId,
    rawMaterialQty: r.rawMaterialQty,
    rmReceivedQty: r.rmReceivedQty,
    rmPromiseDate: r.rmPromiseDate,
    runningSince: r.runningSince ? wallOfInstant(r.runningSince, timeZone) : null,
  }))
}

/** Each machine's capacity: what a planner set, else what the record says, machine by machine. */
async function readCapacities(q: Queryable): Promise<MachineCapacity[]> {
  const { rows } = await q.query<{ key: string; setHours: number | null; setEff: number | null; setFridays: boolean | null; learntHours: number | null; learntEff: number | null; learntFridays: boolean | null }>(
    `SELECT COALESCE(c.machine_key, l.machine_key) AS key,
            c.hours_per_day::float8 AS "setHours", c.efficiency::float8 AS "setEff", c.works_fridays AS "setFridays",
            l.hours_per_day::float8 AS "learntHours", l.efficiency::float8 AS "learntEff", l.works_fridays AS "learntFridays"
       FROM planning_machine_capacity c
       FULL JOIN planning_learnt_machines l ON l.machine_key = c.machine_key`,
  )
  const out: MachineCapacity[] = []
  for (const r of rows) {
    if (r.setHours !== null) {
      out.push({ machineKey: r.key, hoursPerDay: r.setHours, efficiency: r.setEff ?? r.learntEff ?? 1, worksFridays: r.setFridays ?? false, source: 'set' })
    } else if (r.learntHours !== null) {
      out.push({ machineKey: r.key, hoursPerDay: r.learntHours, efficiency: r.learntEff ?? 1, worksFridays: r.learntFridays ?? false, source: 'inferred' })
    }
  }
  return out
}

async function readRates(q: Queryable): Promise<MachineRate[]> {
  const set = await q.query<MachineRate>(
    `SELECT machine_key AS "machineKey", '' AS "itemCode", item_family AS "itemFamily", pieces_per_hour::float8 AS "piecesPerHour", 0 AS samples, 'set' AS source FROM planning_rates`,
  )
  const learnt = await q.query<MachineRate>(
    `SELECT machine_key AS "machineKey", item_code AS "itemCode", item_family AS "itemFamily", pieces_per_hour::float8 AS "piecesPerHour", samples, 'inferred' AS source FROM planning_learnt_rates`,
  )
  return [...set.rows, ...learnt.rows]
}

/** Every item's learnt route, with its weight a piece: read whole, as the engine looks them up by item code. */
export async function readRoutes(q: Queryable): Promise<ItemRoute[]> {
  const { rows } = await q.query<ItemRoute>(
    `SELECT item_code AS "itemCode", item, steps, orders_seen AS orders, confidence_pct AS "confidencePct", kg_per_piece::float8 AS "kgPerPiece" FROM planning_learnt_routes`,
  )
  return rows
}

export async function readSetupTimes(q: Queryable): Promise<SetupTimeRule[]> {
  const { rows } = await q.query<SetupTimeRule>(
    `SELECT id, machine_key AS "machineKey", process, from_family AS "fromFamily", to_family AS "toFamily", minutes, note FROM planning_setup_times ORDER BY updated_at`,
  )
  return rows
}

export async function readMaintenance(q: Queryable): Promise<MaintenanceRule[]> {
  const { rows } = await q.query<MaintenanceRule>(
    `SELECT id, machine_key AS "machineKey", name, every_days AS "everyDays", every_run_hours::float8 AS "everyRunHours", duration_hours::float8 AS "durationHours",
            last_done::text AS "lastDone", start_time AS "startTime"
       FROM planning_maintenance ORDER BY machine_key, name`,
  )
  return rows
}

async function readSpeeds(q: Queryable): Promise<Map<string, { speedPct: number; recentDays: number }>> {
  const { rows } = await q.query<{ key: string; speedPct: number; recentDays: number }>(`SELECT machine_key AS key, speed_pct AS "speedPct", recent_days AS "recentDays" FROM planning_learnt_machines WHERE speed_pct IS NOT NULL`)
  return new Map(rows.map((r) => [r.key, { speedPct: r.speedPct, recentDays: r.recentDays }]))
}

export async function readCalendar(q: Queryable): Promise<CalendarException[]> {
  const { rows } = await q.query<CalendarException>(`SELECT day::text AS day, working, name FROM planning_calendar ORDER BY day`)
  return rows
}

export async function readSetSettings(q: Queryable): Promise<{ settings: Partial<PlanSettings>; version: number; updatedByName: string | null; updatedAt: string }> {
  const { rows } = await q.query<{ settings: Partial<PlanSettings>; version: number; updatedByName: string | null; updatedAt: string }>(
    `SELECT settings, version, updated_by_name AS "updatedByName", updated_at AS "updatedAt" FROM planning_settings`,
  )
  const r = rows[0]
  return { settings: r?.settings ?? {}, version: r?.version ?? 0, updatedByName: r?.updatedByName ?? null, updatedAt: r?.updatedAt ?? new Date(0).toISOString() }
}

export async function readLearnt(q: Queryable): Promise<PlanningBase['learnt']> {
  const { rows } = await q.query<{ processOrder: ProcessOrderResult | null; erpDuration: DurationMeaningResult | null; learntAt: string | null }>(
    `SELECT process_order AS "processOrder", erp_duration AS "erpDuration", learnt_at AS "learntAt" FROM planning_learnt`,
  )
  const r = rows[0]
  return { processOrder: r?.processOrder ?? null, erpDuration: r?.erpDuration ?? null, learntAt: r?.learntAt ?? null }
}

async function readPlanningBase(q: Queryable, timeZone: string): Promise<PlanningBase> {
  const machines = await readMachines(q)
  const lines = await readLines(q, timeZone)
  // A line may name a machine the register does not have: the engine still plans it, on the default hours.
  const known = new Set(machines.map((m) => m.key))
  for (const l of lines) {
    if (l.machineKey && !known.has(l.machineKey)) {
      known.add(l.machineKey)
      machines.push({ key: l.machineKey, code: l.machineKey, name: `Machine ${l.machineKey}`, factory: '', process: null, known: false })
    }
  }
  const [capacities, rates, calendar, routes, setupTimes, maintenance, speeds, set, learnt] = [
    await readCapacities(q),
    await readRates(q),
    await readCalendar(q),
    await readRoutes(q),
    await readSetupTimes(q),
    await readMaintenance(q),
    await readSpeeds(q),
    await readSetSettings(q),
    await readLearnt(q),
  ]
  return { readAt: Date.now(), lines, machines, capacities, rates, calendar, routes, setupTimes, maintenance, speeds, setSettings: set.settings, learnt }
}
