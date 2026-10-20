// ============================================================================
// §25 — the floor now, machine by machine, for the factories' map: what each
// is making by the quality record (the inspection sessions open on it, who
// opened them and since when), its last day on the production record (the
// shift, the workers, what it made), and by the plan — the published one,
// or the automatic one while none is — what it should be on now and next,
// with its queue. Read only.
// ============================================================================

import { AUTO_PLAN_ID, LAYOUT_COLUMNS, LAYOUT_ROWS, wallOfInstant, type FloorResponse, type MachineLayout, type MachineNow, type MachineSession, type PlanOperation, type SaveLayoutRequest } from '@qc/shared/planning'
import type { Config } from '../config'
import { withTransaction, type Db, type Queryable } from '../db/pool'
import { writeAudit } from '../audit/service'
import { badRequest } from '../lib/errors'
import { forgetPlanningBase } from './data'
import { machineKeys } from './events'
import { AUTO_PLAN_NAME, planDetail, publishedPlanId, type Planner } from './plans'

export async function readLayout(q: Queryable): Promise<Map<string, MachineLayout>> {
  const { rows } = await q.query<{ key: string } & MachineLayout>(`SELECT machine_key AS key, x, y, w, h FROM planning_machine_layout`)
  return new Map(rows.map((r) => [r.key, { x: r.x, y: r.y, w: r.w, h: r.h }]))
}

export async function floorNow(db: Db, config: Config, planner: Planner, now = new Date()): Promise<FloorResponse> {
  const tz = config.FACTORY_TIMEZONE
  const published = await publishedPlanId(db)
  const plan = await planDetail(db, config, planner, published?.id ?? AUTO_PLAN_ID, now)
  const layout = await readLayout(db)
  const sessions = await db.query<MachineSession & { machineKey: string; startedAtDate: string }>(
    `SELECT s.id AS "sessionId", ai.machine_key(s.work_center_code) AS "machineKey", btrim(o.line_key) AS "lineKey", btrim(o.order_number) AS "orderNumber",
            btrim(o.item) AS item, btrim(o.customer) AS customer, s.started_at AS "startedAtDate", s.inspector_name AS inspector
       FROM inspection_sessions s
       JOIN production_orders o ON o.id = s.order_id
      WHERE s.status = 'Open' AND s.deleted_at IS NULL
      ORDER BY s.started_at`,
  )
  const last = await db.query<{ machineKey: string; workDay: string; shift: string; workers: string[]; producedQty: number; item: string }>(
    `SELECT DISTINCT ON (ai.machine_key(r.work_center_code)) ai.machine_key(r.work_center_code) AS "machineKey", r.work_day::text AS "workDay",
            btrim(r.shift) AS shift, ARRAY_REMOVE(ARRAY[NULLIF(btrim(r.worker_1), ''), NULLIF(btrim(r.worker_2), ''), NULLIF(btrim(r.worker_3), ''), NULLIF(btrim(r.worker_4), '')], NULL) AS workers,
            COALESCE(r.produced_qty, 0)::float8 AS "producedQty", btrim(r.item) AS item
       FROM production_task_records r
      WHERE r.deleted_at IS NULL AND r.work_day >= current_date - 45 AND btrim(r.work_center_code) <> ''
      ORDER BY ai.machine_key(r.work_center_code), r.work_day DESC, r.day_no DESC NULLS LAST, r.updated_at DESC`,
  )
  const wallNow = wallOfInstant(now, tz)
  const byMachine = new Map<string, PlanOperation[]>()
  for (const op of plan.operations) {
    const l = byMachine.get(op.machineKey)
    if (l) l.push(op)
    else byMachine.set(op.machineKey, [op])
  }
  const sessionsBy = new Map<string, MachineSession[]>()
  for (const s of sessions.rows) {
    const { machineKey, startedAtDate, ...rest } = s
    const l = sessionsBy.get(machineKey) ?? []
    l.push({ ...rest, startedAt: startedAtDate })
    sessionsBy.set(machineKey, l)
  }
  const lastBy = new Map(last.rows.map((r) => [r.machineKey, r]))
  const machines: MachineNow[] = plan.machines
    .filter((m) => m.known)
    .map((m) => {
      const ops = (byMachine.get(m.key) ?? []).filter((o) => o.end !== null && o.end > wallNow).sort((a, b) => a.start! - b.start!)
      const current = ops.find((o) => o.start! <= wallNow) ?? null
      const next = ops.find((o) => o !== current) ?? null
      const own = sessionsBy.get(m.key) ?? []
      const r = lastBy.get(m.key)
      return {
        key: m.key,
        code: m.code,
        name: m.name,
        factory: m.factory,
        process: m.process,
        layout: layout.get(m.key) ?? null,
        hoursPerDay: m.hoursPerDay,
        capacitySource: m.capacitySource,
        sessions: own,
        lastRecord: r ? { workDay: r.workDay, shift: r.shift, workers: r.workers, producedQty: r.producedQty, item: r.item } : null,
        current,
        next,
        queueLines: ops.length,
        queueHours: Math.round(ops.reduce((s, o) => s + o.hours, 0) * 10) / 10,
        lateLines: (byMachine.get(m.key) ?? []).filter((o) => o.lateDays > 0).length,
        status: own.length > 0 ? 'running' : current ? 'planned' : 'idle',
      }
    })
  const factories = [...new Set(machines.map((m) => m.factory || ''))].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
  return { now: wallNow, factories, machines, planId: published?.id ?? AUTO_PLAN_ID, planName: published?.name ?? AUTO_PLAN_NAME }
}

/** Where machines stand on their factories' maps: each one given replaces its place; overlaps are the planner's to tidy. */
export async function saveLayout(db: Db, planner: Planner, req: SaveLayoutRequest): Promise<void> {
  for (const p of req.positions) {
    if (p.x < 0 || p.y < 0 || p.w < 1 || p.h < 1 || p.x + p.w > LAYOUT_COLUMNS || p.y + p.h > LAYOUT_ROWS) throw badRequest(`${p.machineKey}: off the map (${LAYOUT_COLUMNS} × ${LAYOUT_ROWS} cells).`)
  }
  const keys = await machineKeys(db, req.positions.map((p) => p.machineKey))
  await withTransaction(db, async (tx) => {
    const at = new Date().toISOString()
    for (const p of req.positions) {
      const key = keys.get(p.machineKey) ?? p.machineKey
      await tx.query(
        `INSERT INTO planning_machine_layout (machine_key, x, y, w, h, updated_by_id, updated_by_name) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (machine_key) DO UPDATE SET x = EXCLUDED.x, y = EXCLUDED.y, w = EXCLUDED.w, h = EXCLUDED.h, updated_by_id = EXCLUDED.updated_by_id,
                updated_by_name = EXCLUDED.updated_by_name, updated_at = now()`,
        [key, p.x, p.y, p.w, p.h, planner.id, planner.name],
      )
    }
    if (req.positions.length > 0) {
      await writeAudit(tx, [
        { at, userId: planner.id, userName: planner.name, action: 'update', entity: 'planning-layout', entityId: 'map', field: 'machines', newValue: req.positions.map((p) => keys.get(p.machineKey) ?? p.machineKey).join(', ') },
      ])
    }
  })
  forgetPlanningBase()
}

/** Machines taken off the map. */
export async function clearLayout(db: Db, planner: Planner, machineKeysToClear: string[]): Promise<void> {
  const keys = await machineKeys(db, machineKeysToClear)
  await withTransaction(db, async (tx) => {
    await tx.query(`DELETE FROM planning_machine_layout WHERE machine_key = ANY($1::text[])`, [[...keys.values()]])
    await writeAudit(tx, [
      { at: new Date().toISOString(), userId: planner.id, userName: planner.name, action: 'delete', entity: 'planning-layout', entityId: 'map', field: 'machines', oldValue: [...keys.values()].join(', ') },
    ])
  })
}
