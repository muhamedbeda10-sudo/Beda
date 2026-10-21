// ============================================================================
// §25 — learning from the record (shared planning/inference.ts) and keeping
// what was learnt: each machine's working day and pace, each item's route,
// the order the processes follow and what the ERP's part duration covers.
// Read from the production task record and the order sheet; written whole
// into planning's own planning_learnt_* tables, in one transaction, by one
// instance at a time.
// ============================================================================

import {
  inferErpDurationMeaning,
  inferMachineStats,
  inferProcessOrder,
  inferRates,
  inferRoutes,
  inferSpeed,
  isPlanningProcess,
  type DurationPair,
  type PlanningProcess,
  type ProcessDay,
  type RecordRow,
  type RouteLine,
} from '@qc/shared/planning'
import { calendarDay } from '@qc/shared/rules'
import type { PoolClient } from 'pg'
import type { Db } from '../db/pool'
import { forgetPlanningBase } from './data'

/** Next to the other advisory locks (reader 7_204_930_116): one refresh at a time across the instances. */
export const LEARN_LOCK_KEY = 7_204_930_125

/** The record a pace is learnt from, and the span of a machine's working day. */
const RATE_DAYS = 365
const CAPACITY_DAYS = 120
/** The orders an item's route is read from. */
const ROUTE_DAYS = 730

export interface LearnSummary {
  machines: number
  rates: number
  routes: number
  learntAt: string
}

/** The register's process of each machine key, read once and joined by key (not looked up row by row). */
const MACHINE_KEYS_CTE = `
  mk AS (SELECT DISTINCT ON (ai.machine_key(m.code)) ai.machine_key(m.code) AS key, m.process
           FROM machines m WHERE m.deleted_at IS NULL ORDER BY ai.machine_key(m.code), m.created_at)`

/** Learn again from the record; null when another instance is at it. */
export async function learnFromRecord(pool: Db, timeZone: string, now = new Date()): Promise<LearnSummary | null> {
  // The lock first, on a connection of its own: another instance at it means this one reads nothing.
  const db = await pool.connect()
  try {
    const { rows: locked } = await db.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock($1) AS ok`, [LEARN_LOCK_KEY])
    if (!locked[0].ok) return null
    try {
      return await learnLocked(db, timeZone, now)
    } finally {
      await db.query(`SELECT pg_advisory_unlock($1)`, [LEARN_LOCK_KEY])
    }
  } finally {
    db.release()
  }
}

async function learnLocked(db: PoolClient, timeZone: string, now: Date): Promise<LearnSummary> {
  const today = calendarDay(now, timeZone)
  const records = await db.query<RecordRow>(
    `SELECT btrim(r.line_key) AS "lineKey", ai.machine_key(r.work_center_code) AS "machineKey",
            COALESCE(btrim(o.item_code), '') AS "itemCode", NULLIF(btrim(o.item_family), '') AS "itemFamily",
            r.work_day::text AS "workDay", r.produced_qty::float8 AS "producedQty", r.actual_hours::float8 AS "actualHours",
            r.planned_hours::float8 AS "plannedHours", r.duration_hours::float8 AS "durationHours", r.required_qty::float8 AS "requiredQty",
            r.stage_no AS "stageNo", btrim(r.shift) AS shift
       FROM production_task_records r
       LEFT JOIN production_orders o ON lower(o.line_key) = lower(r.line_key) AND o.deleted_at IS NULL
      WHERE r.deleted_at IS NULL AND r.work_day >= $1::date - $2::int AND r.work_day <= $1::date`,
    [today, RATE_DAYS],
  )
  const firstDays = await db.query<ProcessDay & { process: string | null }>(
    `WITH ${MACHINE_KEYS_CTE}
     SELECT btrim(o.order_number) AS "orderNumber", btrim(o.item_code) AS "itemCode", m.process, min(r.work_day)::text AS "firstDay"
       FROM production_task_records r
       JOIN production_orders o ON lower(o.line_key) = lower(r.line_key) AND o.deleted_at IS NULL
       JOIN mk m ON m.key = ai.machine_key(o.work_center_code)
      WHERE r.deleted_at IS NULL AND r.work_day IS NOT NULL AND r.work_day >= $1::date - $2::int
      GROUP BY 1, 2, 3`,
    [today, ROUTE_DAYS],
  )
  const routeLines = await db.query<RouteLine & { process: string | null }>(
    `WITH ${MACHINE_KEYS_CTE}
     SELECT btrim(o.order_number) AS "orderNumber", btrim(o.item_code) AS "itemCode", btrim(o.item) AS item,
            ai.machine_key(o.work_center_code) AS "machineKey", m.process,
            o.weight_kg::float8 AS "weightKg", o.required_qty::float8 AS "requiredQty"
       FROM production_orders o
       LEFT JOIN mk m ON m.key = ai.machine_key(o.work_center_code)
      WHERE o.deleted_at IS NULL AND btrim(o.item_code) <> '' AND btrim(o.work_center_code) <> '' AND upper(btrim(o.order_number)) <> 'STOCK'
        AND o.order_date >= now() - make_interval(days => $1)`,
    [ROUTE_DAYS],
  )
  const pairs = await db.query<DurationPair>(
    `SELECT o.part_duration_hours::float8 AS "erpHours", o.required_qty::float8 AS "requiredQty",
            max(r.duration_hours)::float8 AS "taskDurationHours", sum(r.actual_hours)::float8 AS "actualHours"
       FROM production_orders o
       JOIN production_task_records r ON lower(r.line_key) = lower(o.line_key) AND r.deleted_at IS NULL
      WHERE o.deleted_at IS NULL AND o.part_duration_hours > 0 AND o.required_qty > 1
      GROUP BY o.id
      LIMIT 5000`,
  )

  const asProcess = (p: string | null): PlanningProcess | null => (p && isPlanningProcess(p) ? p : null)
  const stats = inferMachineStats(records.rows, today, CAPACITY_DAYS)
  const speeds = new Map(inferSpeed(records.rows, today).map((s) => [s.machineKey, s]))
  const rates = inferRates(records.rows)
  const processOrder = inferProcessOrder(firstDays.rows.flatMap((d) => (asProcess(d.process) ? [{ ...d, process: asProcess(d.process)! }] : [])))
  const routes = inferRoutes(
    routeLines.rows.map((l) => ({ ...l, process: asProcess(l.process) })),
    processOrder.rank,
  )
  const erpDuration = inferErpDurationMeaning(pairs.rows)

  const tx = db
  const at = new Date()
  await tx.query('BEGIN')
  try {
    await tx.query(`DELETE FROM planning_learnt_machines`)
    await tx.query(`DELETE FROM planning_learnt_rates`)
    await tx.query(`DELETE FROM planning_learnt_routes`)
    if (stats.length > 0) {
      await tx.query(
        `INSERT INTO planning_learnt_machines (machine_key, hours_per_day, hours_from, days_observed, efficiency, efficiency_samples, works_fridays, fridays_worked, last_work_day, shifts, learnt_at, recent_pieces_per_hour, recent_days, speed_pct)
         SELECT k, h, f, d, e, es, wf, fw, lw::date, COALESCE(ARRAY(SELECT jsonb_array_elements_text(sh)), '{}'), $11, rp, rd, sp
           FROM unnest($1::text[], $2::numeric[], $3::text[], $4::int[], $5::numeric[], $6::int[], $7::bool[], $8::int[], $9::text[], $10::jsonb[], $12::numeric[], $13::int[], $14::int[])
             AS t(k, h, f, d, e, es, wf, fw, lw, sh, rp, rd, sp)`,
        [
          stats.map((s) => s.machineKey),
          stats.map((s) => s.hoursPerDay),
          stats.map((s) => s.hoursFrom),
          stats.map((s) => s.daysObserved),
          stats.map((s) => s.efficiency),
          stats.map((s) => s.efficiencySamples),
          stats.map((s) => s.worksFridays),
          stats.map((s) => s.fridaysWorked),
          stats.map((s) => s.lastWorkDay),
          stats.map((s) => JSON.stringify(s.shifts)),
          at,
          stats.map((s) => speeds.get(s.machineKey)?.recentPiecesPerHour ?? null),
          stats.map((s) => speeds.get(s.machineKey)?.recentDays ?? 0),
          stats.map((s) => speeds.get(s.machineKey)?.speedPct ?? null),
        ],
      )
    }
    if (rates.length > 0) {
      await tx.query(
        `INSERT INTO planning_learnt_rates (machine_key, item_code, item_family, pieces_per_hour, samples, learnt_at)
         SELECT * , $6::timestamptz FROM unnest($1::text[], $2::text[], $3::text[], $4::numeric[], $5::int[])`,
        [rates.map((r) => r.machineKey), rates.map((r) => r.itemCode), rates.map((r) => r.itemFamily), rates.map((r) => r.piecesPerHour), rates.map((r) => r.samples), at],
      )
    }
    if (routes.length > 0) {
      await tx.query(
        `INSERT INTO planning_learnt_routes (item_code, item, processes, steps, orders_seen, confidence_pct, kg_per_piece, learnt_at)
         SELECT c, i, ARRAY(SELECT jsonb_array_elements_text(p)), s, o, cp, kg, $8
           FROM unnest($1::text[], $2::text[], $3::jsonb[], $4::jsonb[], $5::int[], $6::int[], $7::numeric[]) AS t(c, i, p, s, o, cp, kg)`,
        [
          routes.map((r) => r.itemCode),
          routes.map((r) => r.item),
          routes.map((r) => JSON.stringify(r.steps.map((s) => s.process))),
          routes.map((r) => JSON.stringify(r.steps)),
          routes.map((r) => r.orders),
          routes.map((r) => r.confidencePct),
          routes.map((r) => r.kgPerPiece),
          at,
        ],
      )
    }
    await tx.query(`UPDATE planning_learnt SET process_order = $1, erp_duration = $2, learnt_at = $3`, [JSON.stringify(processOrder), JSON.stringify(erpDuration), at])
    await tx.query('COMMIT')
  } catch (e) {
    await tx.query('ROLLBACK').catch(() => undefined)
    throw e
  }
  forgetPlanningBase()
  return { machines: stats.length, rates: rates.length, routes: routes.length, learntAt: at.toISOString() }
}
