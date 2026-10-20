// ============================================================================
// §25 — reading the plans against the factory: the overview (the automatic
// plan's totals, the published one's, the load by process, the late
// customers), plan against actual (each day's published plan beside what
// the production record says each machine made), the raw material each line
// waits for, and what the data lacks for planning — each gap with how much is
// missing and what would close it. Read only.
// ============================================================================

import {
  PLANNING_PROCESSES,
  addDays,
  buildCalendars,
  dailyPlan,
  dayNumber,
  dayStartWall,
  factoryDayOfWall,
  instantOfWall,
  isDay,
  materialReceived,
  weeklyLoad,
  type ActualRow,
  type DataGap,
  type DataGapsResponse,
  type LoadResponse,
  type Freshness,
  type MaterialRow,
  type MaterialState,
  type MaterialsResponse,
  type OverviewResponse,
  type PlanEvent,
  type PlanSettings,
  type PlanResult,
  type PlanVsActualResponse,
  type PlanningProcess,
} from '@qc/shared/planning'
import { calendarDay } from '@qc/shared/rules'
import type { Config } from '../config'
import type { Db } from '../db/pool'
import { badRequest } from '../lib/errors'
import { effectiveSettings, loadPlanningBase } from './data'
import { keptOperations, machineInfos, planDetail, publishedHeader, workOut, type Planner } from './plans'

/** The weeks the overview's load covers. */
const OVERVIEW_WEEKS = 8
/** The longest span plan against actual reads at once. */
const MAX_ACTUAL_DAYS = 93

const OPEN_LINE_SQL = `o.deleted_at IS NULL AND COALESCE(o.erp_remaining_qty, o.required_qty - o.finished_qty) > 0
  AND NOT (lower(btrim(o.erp_status)) LIKE 'cancel%' OR o.erp_status LIKE '%ملغ%' OR o.erp_status LIKE '%لغاء%') AND upper(btrim(o.order_number)) <> 'STOCK'`

export async function freshness(db: Db): Promise<Freshness> {
  const { rows } = await db.query<{ synced: string | null; imported: string | null; production: string | null; lastDay: string | null; learnt: string | null }>(
    `SELECT (SELECT max(finished_at) FROM order_sync_runs WHERE status IN ('success', 'warning')) AS synced,
            (SELECT max(updated_at) FROM production_orders) AS imported,
            (SELECT max(imported_at) FROM production_task_records WHERE deleted_at IS NULL) AS production,
            (SELECT max(work_day)::text FROM production_task_records WHERE deleted_at IS NULL) AS "lastDay",
            (SELECT learnt_at FROM planning_learnt) AS learnt`,
  )
  const r = rows[0]
  return {
    ordersSyncedAt: r.synced,
    ordersImportedAt: r.imported,
    productionImportedAt: r.production,
    productionLastWorkDay: r.lastDay,
    learntAt: r.learnt,
  }
}

export async function overview(db: Db, config: Config, planner: Planner, now = new Date()): Promise<OverviewResponse> {
  const tz = config.FACTORY_TIMEZONE
  const { base, settings, result } = await workOut(db, config, [], {}, now)
  const published = await publishedHeader(db, planner, tz)
  const process = new Map(base.machines.map((m) => [m.key, (m.process ?? 'other') as PlanningProcess]))
  const byProcess = new Map<PlanningProcess, { lines: number; hours: number; late: number }>()
  const byCustomer = new Map<string, { late: number; lines: number; maxLateDays: number }>()
  for (const op of result.operations) {
    const p = process.get(op.machineKey) ?? 'other'
    const a = byProcess.get(p) ?? { lines: 0, hours: 0, late: 0 }
    a.lines++
    a.hours += op.hours
    if (op.lateDays > 0) a.late++
    byProcess.set(p, a)
    const c = byCustomer.get(op.customer || '—') ?? { late: 0, lines: 0, maxLateDays: 0 }
    c.lines++
    if (op.lateDays > 0) {
      c.late++
      c.maxLateDays = Math.max(c.maxLateDays, op.lateDays)
    }
    byCustomer.set(op.customer || '—', c)
  }
  const calendars = buildCalendars(base.machines.map((m) => m.key), base.capacities, base.calendar, settings)
  const load = new Map<string, { process: PlanningProcess; week: string; plannedHours: number; capacityHours: number }>()
  for (const w of weeklyLoad(result.operations, calendars, calendarDay(now, tz), OVERVIEW_WEEKS)) {
    const p = process.get(w.machineKey) ?? 'other'
    const k = `${p}|${w.week}`
    const a = load.get(k) ?? { process: p, week: w.week, plannedHours: 0, capacityHours: 0 }
    a.plannedHours += w.plannedHours
    a.capacityHours += w.capacityHours
    load.set(k, a)
  }
  const running = await db.query<{ n: number }>(
    `SELECT count(DISTINCT ai.machine_key(work_center_code))::int AS n FROM inspection_sessions WHERE status = 'Open' AND deleted_at IS NULL`,
  )
  const gaps = await dataGaps(db, config, now, result)
  const excludedByReason: OverviewResponse['excludedByReason'] = {}
  for (const x of result.excluded) excludedByReason[x.reason] = (excludedByReason[x.reason] ?? 0) + 1
  return {
    now: result.now,
    auto: result.summary,
    optimisation: result.optimisation,
    published: published && published.summary ? { plan: published, summary: published.summary } : null,
    byProcess: PLANNING_PROCESSES.filter((p) => byProcess.has(p)).map((p) => ({ process: p, ...byProcess.get(p)!, hours: Math.round(byProcess.get(p)!.hours) })),
    lateByCustomer: [...byCustomer.entries()]
      .filter(([, c]) => c.late > 0)
      .map(([customer, c]) => ({ customer, ...c }))
      .sort((a, b) => b.late - a.late || b.maxLateDays - a.maxLateDays)
      .slice(0, 12),
    load: [...load.values()]
      .map((l) => ({ ...l, plannedHours: Math.round(l.plannedHours), capacityHours: Math.round(l.capacityHours), loadPct: l.capacityHours > 0 ? Math.round((l.plannedHours / l.capacityHours) * 100) : null }))
      .sort((a, b) => PLANNING_PROCESSES.indexOf(a.process) - PLANNING_PROCESSES.indexOf(b.process) || a.week.localeCompare(b.week)),
    machinesRunning: running.rows[0].n,
    machinesTotal: base.machines.filter((m) => m.known).length,
    freshness: gaps.freshness,
    gaps: gaps.gaps.filter((g) => g.severity !== 'low').length,
    excludedByReason,
  }
}

// ---- Plan against actual ---------------------------------------------------------------------

export async function planVsActual(db: Db, config: Config, from: string, to: string): Promise<PlanVsActualResponse> {
  if (!isDay(from) || !isDay(to) || to < from) throw badRequest('from and to: two days, YYYY-MM-DD, from first.')
  if (dayNumber(to) - dayNumber(from) + 1 > MAX_ACTUAL_DAYS) throw badRequest(`At most ${MAX_ACTUAL_DAYS} days at once.`)
  const tz = config.FACTORY_TIMEZONE
  const base = await loadPlanningBase(db, tz)
  const settings = effectiveSettings(base)
  const end = instantOfWall(dayStartWall(addDays(to, 1)), tz)
  const { rows: plans } = await db.query<{ id: string; name: string; publishedAt: string; archivedAt: string | null; events: PlanEvent[]; settings: Partial<PlanSettings> }>(
    `SELECT id, name, published_at AS "publishedAt", archived_at AS "archivedAt", events, settings FROM planning_plans
      WHERE published_at IS NOT NULL AND published_at < $1 AND deleted_at IS NULL ORDER BY published_at`,
    [end],
  )
  // Each day reads the plan in force when it began, or the one published during it; a plan archived before the day
  // began was in force no more.
  const days: string[] = []
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d)
  const inForce = new Map<string, string>()
  for (const d of days) {
    const dayStart = instantOfWall(dayStartWall(d), tz).getTime()
    const dayEnd = instantOfWall(dayStartWall(addDays(d, 1)), tz).getTime()
    const p = [...plans].reverse().find((x) => Date.parse(x.publishedAt) < dayEnd)
    if (p && (p.archivedAt === null || Date.parse(p.archivedAt) > dayStart)) inForce.set(d, p.id)
  }
  const planned = new Map<string, { qty: number; hours: number }>()
  const used = [...new Set(inForce.values())]
  for (const id of used) {
    const plan = plans.find((p) => p.id === id)!
    const ops = await keptOperations(db, id, tz)
    // Its lines spread over its days as it planned them: its own events (a machine down…) and every machine it names.
    const calendars = buildCalendars(new Set([...base.machines.map((m) => m.key), ...ops.map((o) => o.machineKey)]), base.capacities, base.calendar, effectiveSettings(base, plan.settings), plan.events)
    for (const r of dailyPlan(ops, calendars, from, to)) {
      if (inForce.get(r.day) !== id) continue
      planned.set(`${r.machineKey}|${r.day}`, { qty: r.qty, hours: r.hours })
    }
  }
  const { rows: actual } = await db.query<{ machineKey: string; day: string; qty: number; hours: number | null }>(
    `SELECT ai.machine_key(work_center_code) AS "machineKey", work_day::text AS day, COALESCE(sum(produced_qty), 0)::float8 AS qty, sum(actual_hours)::float8 AS hours
       FROM production_task_records
      WHERE deleted_at IS NULL AND work_day BETWEEN $1 AND $2 AND btrim(work_center_code) <> ''
      GROUP BY 1, 2`,
    [from, to],
  )
  const rowsBy = new Map<string, ActualRow>()
  for (const [k, p] of planned) {
    const [machineKey, day] = k.split('|')
    rowsBy.set(k, { machineKey, day, plannedQty: p.qty, plannedHours: p.hours, actualQty: 0, actualHours: null })
  }
  for (const a of actual) {
    const k = `${a.machineKey}|${a.day}`
    const r = rowsBy.get(k) ?? { machineKey: a.machineKey, day: a.day, plannedQty: 0, plannedHours: 0, actualQty: 0, actualHours: null }
    r.actualQty = a.qty
    r.actualHours = a.hours
    rowsBy.set(k, r)
  }
  const rows = [...rowsBy.values()].sort((a, b) => a.machineKey.localeCompare(b.machineKey) || a.day.localeCompare(b.day))
  const sums = new Map<string, { plannedQty: number; actualQty: number; met: number }>()
  for (const r of rows) {
    const s = sums.get(r.machineKey) ?? { plannedQty: 0, actualQty: 0, met: 0 }
    s.plannedQty += r.plannedQty
    s.actualQty += r.actualQty
    s.met += Math.min(r.plannedQty, r.actualQty)
    sums.set(r.machineKey, s)
  }
  const machines = machineInfos(base, settings, sums.keys()).map((m) => {
    const s = sums.get(m.key)!
    return { ...m, plannedQty: Math.round(s.plannedQty), actualQty: Math.round(s.actualQty), adherencePct: s.plannedQty > 0 ? Math.round((s.met / s.plannedQty) * 100) : null }
  })
  const erp = await db.query<{ lines: number; onPlan: number; late: number }>(
    `WITH l AS (
       SELECT o.planned_finish, COALESCE(o.erp_remaining_qty, o.required_qty - o.finished_qty) <= 0 AS done,
              (SELECT max(r.work_day) FROM production_task_records r WHERE lower(r.line_key) = lower(o.line_key) AND r.deleted_at IS NULL) AS last_day
         FROM production_orders o
        WHERE o.deleted_at IS NULL AND o.planned_finish BETWEEN $1 AND $2
          AND NOT (lower(btrim(o.erp_status)) LIKE 'cancel%' OR o.erp_status LIKE '%ملغ%' OR o.erp_status LIKE '%لغاء%'))
     SELECT count(*)::int AS lines,
            count(*) FILTER (WHERE done AND (last_day IS NULL OR last_day <= planned_finish))::int AS "onPlan",
            count(*) FILTER (WHERE (done AND last_day > planned_finish) OR (NOT done AND planned_finish < $3::date))::int AS late
       FROM l`,
    [from, to, calendarDay(new Date(), tz)],
  )
  return {
    from,
    to,
    plans: plans.filter((p) => used.includes(p.id)).map((p) => ({ id: p.id, name: p.name, publishedAt: p.publishedAt })),
    rows,
    machines,
    erp: { lines: erp.rows[0].lines, finishedOnPlan: erp.rows[0].onPlan, late: erp.rows[0].late },
  }
}

// ---- Raw material ---------------------------------------------------------------------------------

export function materialState(line: { rawMaterialQty: number | null; rmReceivedQty: number | null; rmPromiseDate: string | null }, plannedStartDay: string | null): MaterialState {
  const need = line.rawMaterialQty ?? 0
  const got = line.rmReceivedQty ?? 0
  if (need <= 0 && got <= 0 && !line.rmPromiseDate) return 'no-data'
  if (materialReceived(line)) return 'received'
  if (got > 0) return 'partial'
  if (!line.rmPromiseDate) return 'no-promise'
  return plannedStartDay === null || line.rmPromiseDate <= plannedStartDay ? 'promised-in-time' : 'promised-late'
}

export async function materials(db: Db, config: Config, now = new Date()): Promise<MaterialsResponse> {
  // Worked out without the gate, so a line's start says when it could start were the material there.
  const { base, result } = await workOut(db, config, [], { materialGate: false }, now)
  const lines = new Map(base.lines.map((l) => [l.id, l]))
  const counts: Record<MaterialState, number> = { received: 0, partial: 0, 'promised-in-time': 0, 'promised-late': 0, 'no-promise': 0, 'no-data': 0 }
  const rows: MaterialRow[] = []
  for (const op of result.operations) {
    const l = lines.get(op.lineId)
    if (!l) continue
    const startDay = op.start !== null ? factoryDayOfWall(op.start) : null
    const state = materialState(l, startDay)
    counts[state]++
    if (state === 'no-data') continue
    rows.push({
      lineKey: l.lineKey,
      orderNumber: l.orderNumber,
      item: l.item,
      customer: l.customer,
      machineKey: l.machineKey,
      rawMaterialQty: l.rawMaterialQty,
      rmReceivedQty: l.rmReceivedQty,
      rmPromiseDate: l.rmPromiseDate,
      plannedStart: op.start,
      dueDate: op.dueDate,
      state,
    })
  }
  const order: MaterialState[] = ['promised-late', 'no-promise', 'partial', 'promised-in-time', 'received', 'no-data']
  rows.sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state) || (a.plannedStart ?? Infinity) - (b.plannedStart ?? Infinity))
  return { rows: rows.slice(0, 2000), counts }
}

// ---- What the data lacks ----------------------------------------------------------------------------

const pct = (n: number, of: number) => (of > 0 ? Math.round((n / of) * 100) : null)
const severityOf = (filled: number | null): DataGap['severity'] => (filled === null ? 'medium' : filled < 50 ? 'high' : filled < 85 ? 'medium' : 'low')

/** What the data lacks; `auto` is the automatic plan when the caller has worked it out already. */
export async function dataGaps(db: Db, config: Config, now = new Date(), auto?: PlanResult): Promise<DataGapsResponse> {
  const tz = config.FACTORY_TIMEZONE
  const today = calendarDay(now, tz)
  const { rows } = await db.query<Record<string, number>>(
    `WITH mk AS (SELECT DISTINCT ai.machine_key(code) AS key FROM machines WHERE deleted_at IS NULL)
     SELECT count(*)::int AS total,
            count(*) FILTER (WHERE o.due_date IS NOT NULL)::int AS due,
            count(*) FILTER (WHERE o.part_duration_hours > 0)::int AS duration,
            count(*) FILTER (WHERE o.planned_start IS NOT NULL)::int AS planned,
            count(*) FILTER (WHERE NULLIF(btrim(o.item_family), '') IS NOT NULL)::int AS family,
            count(*) FILTER (WHERE o.weight_kg > 0)::int AS weight,
            count(*) FILTER (WHERE o.raw_material_qty > 0)::int AS "rmNeed",
            count(*) FILTER (WHERE o.raw_material_qty > 0 AND (o.rm_promise_date IS NOT NULL OR o.rm_received_qty >= o.raw_material_qty))::int AS "rmPlanned",
            count(*) FILTER (WHERE lower(btrim(COALESCE(o.parent_id, ''))) NOT IN ('', 'null', 'deleted', 'del'))::int AS parent,
            count(*) FILTER (WHERE btrim(o.work_center_code) = '')::int AS "noMachine",
            count(*) FILTER (WHERE btrim(o.work_center_code) <> '' AND mk.key IS NULL)::int AS "unknownMachine",
            count(*) FILTER (WHERE o.delay_reason_code IS NOT NULL)::int AS delays
       FROM production_orders o
       LEFT JOIN mk ON mk.key = ai.machine_key(o.work_center_code)
      WHERE ${OPEN_LINE_SQL}`,
  )
  const o = rows[0]
  const machines = await db.query<{ total: number; learnt: number; set: number; mapped: number }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE l.hours_per_day IS NOT NULL)::int AS learnt,
            count(*) FILTER (WHERE c.machine_key IS NOT NULL)::int AS set,
            count(*) FILTER (WHERE y.machine_key IS NOT NULL)::int AS mapped
       FROM (SELECT DISTINCT ai.machine_key(code) AS key FROM machines WHERE deleted_at IS NULL) m
       LEFT JOIN planning_learnt_machines l ON l.machine_key = m.key
       LEFT JOIN planning_machine_capacity c ON c.machine_key = m.key
       LEFT JOIN planning_machine_layout y ON y.machine_key = m.key`,
  )
  const record = await db.query<{ rows: number; withHours: number }>(
    `SELECT count(*)::int AS rows, count(*) FILTER (WHERE actual_hours > 0)::int AS "withHours"
       FROM production_task_records WHERE deleted_at IS NULL AND work_day >= $1::date - 90`,
    [today],
  )
  const holidays = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM planning_calendar WHERE source = 'set' AND NOT working AND day BETWEEN $1::date AND $1::date + 365`, [today])
  const fresh = await freshness(db)
  const base = await loadPlanningBase(db, tz)
  const result = auto ?? (await workOut(db, config, [], {}, now)).result
  const assumed = result.operations.filter((op) => op.durationSource === 'assumed').length

  const gaps: DataGap[] = []
  const line = (id: string, title: string, have: number, of: number, detail: string, fix: string, area: DataGap['area'] = 'orders') => {
    const filled = pct(have, of)
    if (of === 0 || have >= of) return
    gaps.push({ id, area, title, detail, filledPct: filled, missing: of - have, severity: severityOf(filled), fix })
  }
  const total = o.total
  line('due-date', 'Due dates', o.due, total, 'Open lines with a due date: lateness is measured against it.', 'Fill Due Date on the order sheet (Access).')
  line('erp-duration', 'Part durations', o.duration, total, 'Open lines with the ERP’s part duration (Part Dur (Hr)); without it a line’s hours come from the machine’s pace on the production record, or the default.', 'Fill Part Dur (Hr) in the ERP, or let the production record teach each machine’s pace.')
  line('planned-start', 'Planned starts', o.planned, total, 'Open lines with the ERP’s planned start: the order lines run on a machine follow it.', 'Fill Planned Start in the ERP, or plan by due day (Planning → Settings).')
  line('item-family', 'Item families', o.family, total, 'Open lines with an item family: a machine’s pace for a family is used when the item’s own is not known.', 'Fill Item Family on the order sheet.')
  line('weight', 'Weights', o.weight, total, 'Open lines with a weight: late weight and load in tonnes need it.', 'Fill the weight on the order sheet.')
  if (o.rmNeed > 0) line('material-promise', 'Raw material promise days', o.rmPlanned, o.rmNeed, 'Open lines that need raw material and have it received or a promise day: the rest may start before their material is in.', 'Fill RM Promiss Date for lines whose material is not received.', 'materials')
  if (o.noMachine > 0) gaps.push({ id: 'no-machine', area: 'orders', title: 'Lines with no machine', detail: 'Open lines with no machine code cannot be planned.', filledPct: pct(total - o.noMachine, total), missing: o.noMachine, severity: 'high', fix: 'Give each line its machine (work center) on the order sheet.' })
  if (o.unknownMachine > 0) gaps.push({ id: 'unknown-machine', area: 'machines', title: 'Machines missing from the register', detail: 'Open lines name machines the register does not have: they are planned on the default hours, with no factory or process.', filledPct: pct(total - o.unknownMachine, total), missing: o.unknownMachine, severity: 'medium', fix: 'Add the machines under Configuration → Machines (code, factory, process).' })
  if (o.parent === 0 && total > 0) gaps.push({ id: 'parent', area: 'orders', title: 'Links between lines', detail: 'No open line names a parent line, so stages are linked only by the same item on several machines of one order.', filledPct: 0, missing: total, severity: 'low', fix: 'If the ERP links components to assemblies, export Parent ID as the parent line’s Order ID.' })
  const m = machines.rows[0]
  line('machine-hours', 'Machines’ working hours', m.learnt + m.set, m.total, 'Machines whose hours a day are learnt from the production record (5 days or more in the last 120) or set by a planner; the rest work the default.', 'Import the production record regularly with actual hours, or set the hours under Planning → Capacity.', 'machines')
  line('machine-map', 'Machines on the factories’ map', m.mapped, m.total, 'Machines placed on their factory’s map.', 'Place them under Planning → Factory map → Edit the map.', 'machines')
  const r = record.rows[0]
  if (r.rows > 0) line('actual-hours', 'Actual hours on the production record', r.withHours, r.rows, 'Production rows of the last 90 days with the time taken: paces and working hours are learnt from them.', 'Record the actual hours in the ERP’s production task record.', 'production')
  const daysOld = (iso: string | null) => (iso ? (now.getTime() - Date.parse(iso)) / 86_400_000 : Infinity)
  if (daysOld(fresh.productionImportedAt) > 2) {
    gaps.push({ id: 'production-fresh', area: 'production', title: 'Production record not fresh', detail: fresh.productionImportedAt ? `Last imported ${fresh.productionImportedAt.slice(0, 10)}${fresh.productionLastWorkDay ? `, up to the work day ${fresh.productionLastWorkDay}` : ''}: plan against actual and the learnt paces lag behind.` : 'The production record has never been imported.', filledPct: null, missing: 1, severity: 'high', fix: 'Import the ERP’s production task record every day (Data import → Production record).' })
  }
  if (daysOld(fresh.ordersSyncedAt ?? fresh.ordersImportedAt) > 1) {
    gaps.push({ id: 'orders-fresh', area: 'orders', title: 'Order sheet not fresh', detail: `The order sheet was last brought in ${(fresh.ordersSyncedAt ?? fresh.ordersImportedAt ?? 'never').slice(0, 10)}.`, filledPct: null, missing: 1, severity: 'high', fix: 'Keep the Access sync running, or import the order sheet daily.' })
  }
  if (holidays.rows[0].n === 0) {
    gaps.push({ id: 'moving-holidays', area: 'calendar', title: 'Moving holidays not set', detail: 'Egypt’s fixed holidays are in the calendar; the Eids, the Islamic New Year, the Prophet’s birthday and Sham El-Nessim for the coming year are not.', filledPct: null, missing: 1, severity: 'medium', fix: 'Add them under Calendar when the government announces them.' })
  }
  if (!base.learnt.erpDuration?.meaning) {
    gaps.push({ id: 'erp-duration-meaning', area: 'orders', title: 'What the ERP’s part duration covers', detail: 'The record could not tell whether Part Dur (Hr) is the whole line’s hours or one piece’s: the plan reads it as the line’s.', filledPct: null, missing: 1, severity: 'medium', fix: 'Say which under Planning → Settings, or import more of the production record.' })
  }
  if (assumed > 0) gaps.push({ id: 'assumed-hours', area: 'orders', title: 'Lines with no time to go by', detail: `${assumed} lines of the automatic plan have no part duration and no pace on their machine: each is given the default hours.`, filledPct: pct(result.operations.length - assumed, result.operations.length), missing: assumed, severity: severityOf(pct(result.operations.length - assumed, result.operations.length)), fix: 'Fill Part Dur (Hr), or set the machine’s pace under Planning → Routes & paces.' })
  if (o.delays > 0) gaps.push({ id: 'delay-reasons', area: 'orders', title: 'Names of the delay reasons', detail: 'The order sheet gives delay reasons as numbers; what each number means is not in the data.', filledPct: null, missing: 1, severity: 'low', fix: 'Send the list of delay reason codes and their names.' })
  for (const g of [
    { id: 'changeovers', title: 'Changeover times', detail: 'How long a machine takes to change from one item, profile or colour to another is not in the data: the plan puts no time between lines.', fix: 'Send changeover times per machine (or per process: profile change, colour change).' },
    { id: 'alternatives', title: 'Machines that can stand in for each other', detail: 'Which other machines can make an item is not in the data: a scenario can move a line, the automatic plan does not.', fix: 'Send, per item family, the machines that can make it.' },
    { id: 'downtime', title: 'Breakdowns and maintenance', detail: 'Stops and planned maintenance are not recorded: a machine is taken as working its hours every working day.', fix: 'Record downtime (or add it to a scenario as Machine down).' },
    { id: 'stock', title: 'Raw material on hand', detail: 'The coil register holds each coil’s properties, not its weight on hand or what is reserved: material readiness rests on the order sheet’s received and promised figures.', fix: 'Send the coil stock (weight on hand per coil) if it is kept.' },
  ]) {
    gaps.push({ ...g, area: g.id === 'stock' ? 'materials' : 'machines', filledPct: null, missing: 1, severity: 'low' })
  }
  const rank = { high: 0, medium: 1, low: 2 }
  gaps.sort((a, b) => rank[a.severity] - rank[b.severity] || (a.filledPct ?? 101) - (b.filledPct ?? 101))
  return { gaps, openLines: total, freshness: fresh }
}


// ---- A plan's load --------------------------------------------------------------------------------------

/** Each machine's planned hours against its working hours, week by week, for a plan. */
export async function planLoad(db: Db, config: Config, planner: Planner, id: string, weeks: number, now = new Date()): Promise<LoadResponse> {
  const tz = config.FACTORY_TIMEZONE
  const detail = await planDetail(db, config, planner, id, now)
  const base = await loadPlanningBase(db, tz)
  const calendars = buildCalendars(detail.machines.map((m) => m.key), base.capacities, base.calendar, detail.effectiveSettings, detail.plan.events)
  const from = factoryDayOfWall(detail.now)
  const rows = weeklyLoad(detail.operations, calendars, from, weeks)
  const first = rows[0]?.week ?? from
  return { weeks: Array.from({ length: weeks }, (_, i) => addDays(first, i * 7)), rows, machines: detail.machines }
}
