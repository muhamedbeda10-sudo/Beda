// ============================================================================
// §25 — planning's setup, as the planners set it: the calendar's days, each
// machine's hours a day and efficiency, a machine's pace for a family, and
// the engine's settings; beside each, what the record says (learn.ts). A
// change is audited (entity 'planning-setup'), forgets the inputs kept in
// memory, and takes effect on the next plan worked out — the published plan
// stays as it was published.
// ============================================================================

import {
  PLANNING_PROCESSES,
  capacityOf,
  isDay,
  type CalendarResponse,
  type CapacityResponse,
  type CapacityRow,
  type ItemRoute,
  type MachineStats,
  type RatesResponse,
  type RoutesResponse,
  type SetCalendarDayRequest,
  type SetCapacityRequest,
  type SetRateRequest,
  type SettingsResponse,
  type PlanningProcess,
  type MachineSpeed,
  type SetupTimesResponse,
  type SetSetupTimeRequest,
  type MaintenanceResponse,
  type SetMaintenanceRequest,
} from '@qc/shared/planning'
import type { Config } from '../config'
import { withTransaction, type Db } from '../db/pool'
import { writeAudit } from '../audit/service'
import { ConflictError, badRequest } from '../lib/errors'
import { effectiveSettings, forgetPlanningBase, loadPlanningBase, readLearnt, readSetSettings } from './data'
import { checkSettings, machineKeys } from './events'
import { machineInfos, type Planner } from './plans'

type Change = { field: string; oldValue?: string; newValue?: string; entityId: string }

async function audited(db: Db, planner: Planner, changes: Change[], write: (tx: import('pg').PoolClient) => Promise<void>): Promise<void> {
  await withTransaction(db, async (tx) => {
    await write(tx)
    const at = new Date().toISOString()
    await writeAudit(
      tx,
      changes.map((c) => ({ at, userId: planner.id, userName: planner.name, action: 'update' as const, entity: 'planning-setup', entityId: c.entityId, field: c.field, oldValue: c.oldValue, newValue: c.newValue })),
    )
  })
  forgetPlanningBase()
}

// ---- The calendar ------------------------------------------------------------------------

export async function calendarBetween(db: Db, from: string, to: string): Promise<CalendarResponse> {
  if (!isDay(from) || !isDay(to) || to < from) throw badRequest('from and to: two days, YYYY-MM-DD, from first.')
  const { rows } = await db.query<{ day: string; working: boolean; name: string; updatedByName: string | null }>(
    `SELECT day::text AS day, working, name, updated_by_name AS "updatedByName" FROM planning_calendar WHERE day BETWEEN $1 AND $2 ORDER BY day`,
    [from, to],
  )
  return { from, to, days: rows }
}

export async function setCalendarDay(db: Db, planner: Planner, day: string, req: SetCalendarDayRequest): Promise<void> {
  if (!isDay(day)) throw badRequest('The day: YYYY-MM-DD.')
  const name = req.name.trim()
  if (name === '' || name.length > 120) throw badRequest('name: say what the day is, in at most 120 characters.')
  const before = await db.query<{ working: boolean; name: string }>(`SELECT working, name FROM planning_calendar WHERE day = $1`, [day])
  const old = before.rows[0]
  await audited(db, planner, [{ entityId: `calendar:${day}`, field: 'day', oldValue: old ? `${old.working ? 'working' : 'off'}: ${old.name}` : undefined, newValue: `${req.working ? 'working' : 'off'}: ${name}` }], async (tx) => {
    await tx.query(
      `INSERT INTO planning_calendar (day, working, name, source, updated_by_id, updated_by_name) VALUES ($1, $2, $3, 'set', $4, $5)
       ON CONFLICT (day) DO UPDATE SET working = EXCLUDED.working, name = EXCLUDED.name, source = 'set', updated_by_id = EXCLUDED.updated_by_id,
              updated_by_name = EXCLUDED.updated_by_name, updated_at = now()`,
      [day, req.working, name, planner.id, planner.name],
    )
  })
}

export async function clearCalendarDay(db: Db, planner: Planner, day: string): Promise<void> {
  if (!isDay(day)) throw badRequest('The day: YYYY-MM-DD.')
  const before = await db.query<{ working: boolean; name: string }>(`SELECT working, name FROM planning_calendar WHERE day = $1`, [day])
  const old = before.rows[0]
  if (!old) return
  await audited(db, planner, [{ entityId: `calendar:${day}`, field: 'day', oldValue: `${old.working ? 'working' : 'off'}: ${old.name}` }], async (tx) => {
    await tx.query(`DELETE FROM planning_calendar WHERE day = $1`, [day])
  })
}

// ---- Machines' capacity -------------------------------------------------------------------

export async function capacities(db: Db, config: Config): Promise<CapacityResponse> {
  const base = await loadPlanningBase(db, config.FACTORY_TIMEZONE)
  const settings = effectiveSettings(base)
  const stats = await db.query<MachineStats & { learntAt: string; recentPiecesPerHour: number | null; recentDays: number; speedPct: number | null }>(
    `SELECT machine_key AS "machineKey", hours_per_day::float8 AS "hoursPerDay", hours_from AS "hoursFrom", days_observed AS "daysObserved",
            efficiency::float8 AS efficiency, efficiency_samples AS "efficiencySamples", works_fridays AS "worksFridays", fridays_worked AS "fridaysWorked",
            last_work_day::text AS "lastWorkDay", shifts, learnt_at AS "learntAt",
            recent_pieces_per_hour::float8 AS "recentPiecesPerHour", recent_days AS "recentDays", speed_pct AS "speedPct"
       FROM planning_learnt_machines`,
  )
  const set = await db.query<{ key: string; hoursPerDay: number; efficiency: number | null; worksFridays: boolean; note: string; updatedByName: string; updatedAt: string }>(
    `SELECT machine_key AS key, hours_per_day::float8 AS "hoursPerDay", efficiency::float8 AS efficiency, works_fridays AS "worksFridays", note,
            COALESCE(updated_by_name, '') AS "updatedByName", updated_at AS "updatedAt"
       FROM planning_machine_capacity`,
  )
  const statsBy = new Map(stats.rows.map((s) => [s.machineKey, s]))
  const setBy = new Map(set.rows.map((s) => [s.key, s]))
  const caps = new Map(base.capacities.map((c) => [c.machineKey, c]))
  const rows: CapacityRow[] = machineInfos(base, settings)
    .filter((m) => m.known)
    .map((m) => {
      const found = statsBy.get(m.key)
      const s = setBy.get(m.key)
      let stats: MachineStats | null = null
      let speed: MachineSpeed | null = null
      if (found) {
        const { learntAt: _at, recentPiecesPerHour, recentDays, speedPct, ...rest } = found
        stats = rest
        speed = { machineKey: m.key, recentPiecesPerHour, recentDays, speedPct }
      }
      return {
        machine: m,
        stats,
        speed,
        set: s ? { hoursPerDay: s.hoursPerDay, efficiency: s.efficiency, worksFridays: s.worksFridays, note: s.note, updatedByName: s.updatedByName, updatedAt: s.updatedAt } : null,
        effective: capacityOf(caps, m.key, settings),
      }
    })
  const learntAt = stats.rows.reduce<string | null>((a, s) => (a === null || s.learntAt > a ? s.learntAt : a), null)
  return { rows, learntAt }
}

export async function setCapacity(db: Db, planner: Planner, machine: string, req: SetCapacityRequest): Promise<void> {
  if (!(req.hoursPerDay >= 0 && req.hoursPerDay <= 24)) throw badRequest('hoursPerDay: 0 to 24.')
  if (req.efficiency !== null && !(req.efficiency >= 0.1 && req.efficiency <= 3)) throw badRequest('efficiency: 0.1 to 3 (1 = the ERP’s standard), or empty to learn it.')
  const note = (req.note ?? '').trim().slice(0, 500)
  const key = (await machineKeys(db, [machine])).get(machine) ?? machine
  const before = await db.query<{ hoursPerDay: number; efficiency: number | null; worksFridays: boolean }>(
    `SELECT hours_per_day::float8 AS "hoursPerDay", efficiency::float8 AS efficiency, works_fridays AS "worksFridays" FROM planning_machine_capacity WHERE machine_key = $1`,
    [key],
  )
  const old = before.rows[0]
  const show = (c: { hoursPerDay: number; efficiency: number | null; worksFridays: boolean }) => `${c.hoursPerDay} h/day, efficiency ${c.efficiency ?? 'learnt'}, ${c.worksFridays ? 'works Fridays' : 'Fridays off'}`
  await audited(db, planner, [{ entityId: `capacity:${key}`, field: 'capacity', oldValue: old ? show(old) : undefined, newValue: show(req) }], async (tx) => {
    await tx.query(
      `INSERT INTO planning_machine_capacity (machine_key, hours_per_day, efficiency, works_fridays, note, updated_by_id, updated_by_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (machine_key) DO UPDATE SET hours_per_day = EXCLUDED.hours_per_day, efficiency = EXCLUDED.efficiency, works_fridays = EXCLUDED.works_fridays,
              note = EXCLUDED.note, updated_by_id = EXCLUDED.updated_by_id, updated_by_name = EXCLUDED.updated_by_name, updated_at = now()`,
      [key, req.hoursPerDay, req.efficiency, req.worksFridays, note, planner.id, planner.name],
    )
  })
}

export async function clearCapacity(db: Db, planner: Planner, machine: string): Promise<void> {
  const key = (await machineKeys(db, [machine])).get(machine) ?? machine
  await audited(db, planner, [{ entityId: `capacity:${key}`, field: 'capacity', oldValue: 'set', newValue: 'learnt' }], async (tx) => {
    await tx.query(`DELETE FROM planning_machine_capacity WHERE machine_key = $1`, [key])
  })
}

// ---- Paces ----------------------------------------------------------------------------------

export async function rates(db: Db, machine?: string): Promise<RatesResponse> {
  const key = machine ? ((await machineKeys(db, [machine])).get(machine) ?? machine) : null
  const set = await db.query<RatesResponse['set'][number] & { updatedAtDate: string }>(
    `SELECT machine_key AS "machineKey", '' AS "itemCode", item_family AS "itemFamily", pieces_per_hour::float8 AS "piecesPerHour", 0 AS samples, 'set' AS source,
            note, COALESCE(updated_by_name, '') AS "updatedByName", updated_at AS "updatedAtDate"
       FROM planning_rates WHERE $1::text IS NULL OR machine_key = $1 ORDER BY machine_key, item_family`,
    [key],
  )
  const learnt = await db.query<RatesResponse['learnt'][number] & { learntAt: string }>(
    `SELECT machine_key AS "machineKey", item_code AS "itemCode", item_family AS "itemFamily", pieces_per_hour::float8 AS "piecesPerHour", samples, 'inferred' AS source, learnt_at AS "learntAt"
       FROM planning_learnt_rates WHERE $1::text IS NULL OR machine_key = $1
      ORDER BY machine_key, (item_code = '' AND item_family = '') DESC, (item_code = '') DESC, samples DESC LIMIT 2000`,
    [key],
  )
  return {
    set: set.rows.map(({ updatedAtDate, ...r }) => ({ ...r, updatedAt: updatedAtDate })),
    learnt: learnt.rows.map(({ learntAt: _learntAt, ...r }) => r),
    learntAt: learnt.rows[0]?.learntAt ?? null,
  }
}

export async function setRate(db: Db, planner: Planner, req: SetRateRequest): Promise<void> {
  if (!(req.piecesPerHour > 0 && req.piecesPerHour < 1e9)) throw badRequest('piecesPerHour: more than 0.')
  const family = req.itemFamily.trim().toLowerCase().slice(0, 60)
  const key = (await machineKeys(db, [req.machineKey])).get(req.machineKey) ?? req.machineKey
  if (!key) throw badRequest('machineKey: the machine.')
  await audited(db, planner, [{ entityId: `rate:${key}:${family}`, field: 'piecesPerHour', newValue: String(req.piecesPerHour) }], async (tx) => {
    await tx.query(
      `INSERT INTO planning_rates (machine_key, item_family, pieces_per_hour, note, updated_by_id, updated_by_name) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (machine_key, item_family) DO UPDATE SET pieces_per_hour = EXCLUDED.pieces_per_hour, note = EXCLUDED.note,
              updated_by_id = EXCLUDED.updated_by_id, updated_by_name = EXCLUDED.updated_by_name, updated_at = now()`,
      [key, family, req.piecesPerHour, (req.note ?? '').trim().slice(0, 500), planner.id, planner.name],
    )
  })
}

export async function clearRate(db: Db, planner: Planner, machine: string, family: string): Promise<void> {
  const key = (await machineKeys(db, [machine])).get(machine) ?? machine
  const f = family.trim().toLowerCase()
  await audited(db, planner, [{ entityId: `rate:${key}:${f}`, field: 'piecesPerHour', oldValue: 'set' }], async (tx) => {
    await tx.query(`DELETE FROM planning_rates WHERE machine_key = $1 AND item_family = $2`, [key, f])
  })
}

// ---- Routes --------------------------------------------------------------------------------------

export async function routes(db: Db, query: { q?: string; process?: string; limit?: number }): Promise<RoutesResponse> {
  const q = (query.q ?? '').trim().toLowerCase()
  const process = PLANNING_PROCESSES.includes(query.process as PlanningProcess) ? query.process! : null
  const limit = Math.min(Math.max(query.limit ?? 200, 1), 1000)
  const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
  const { rows } = await db.query<ItemRoute & { total: number; learntAt: string }>(
    `SELECT item_code AS "itemCode", item, steps, orders_seen AS orders, confidence_pct AS "confidencePct", kg_per_piece::float8 AS "kgPerPiece", learnt_at AS "learntAt", count(*) OVER ()::int AS total
       FROM planning_learnt_routes
      WHERE ($1 = '' OR item_code LIKE $2 OR lower(item) LIKE $2) AND ($3::text IS NULL OR processes @> ARRAY[$3::text])
      ORDER BY orders_seen DESC, item_code LIMIT $4`,
    [q, pattern, process, limit],
  )
  const learnt = await readLearnt(db)
  return {
    routes: rows.map(({ total: _t, learntAt: _l, ...r }) => r),
    total: rows[0]?.total ?? 0,
    processOrder: learnt.processOrder ?? { rank: effectiveSettings({ setSettings: {}, learnt }).processRank, votes: [], learnt: false },
    learntAt: learnt.learntAt,
  }
}

// ---- Changeovers ------------------------------------------------------------------------------------

export async function setupTimes(db: Db): Promise<SetupTimesResponse> {
  const { rows } = await db.query<SetupTimesResponse['rules'][number]>(
    `SELECT id, machine_key AS "machineKey", process, from_family AS "fromFamily", to_family AS "toFamily", minutes, note, updated_by_name AS "updatedByName", updated_at AS "updatedAt"
       FROM planning_setup_times ORDER BY machine_key NULLS LAST, process NULLS LAST, from_family, to_family`,
  )
  return { rules: rows }
}

const family = (s: string) => s.trim().slice(0, 60)

/** A changeover rule set or replaced (the same scope and families replace the rule they had). */
export async function setSetupTime(db: Db, planner: Planner, req: SetSetupTimeRequest): Promise<string> {
  if (req.machineKey !== null && req.process !== null) throw badRequest('A rule is one machine’s, one process’s, or everyone’s: not a machine and a process.')
  if (req.process !== null && !PLANNING_PROCESSES.includes(req.process)) throw badRequest(`process: one of ${PLANNING_PROCESSES.join(', ')}.`)
  if (!(Number.isInteger(req.minutes) && req.minutes >= 0 && req.minutes <= 1440)) throw badRequest('minutes: 0 to 1440.')
  const key = req.machineKey === null ? null : ((await machineKeys(db, [req.machineKey])).get(req.machineKey) ?? req.machineKey)
  const from = family(req.fromFamily)
  const to = family(req.toFamily)
  const note = (req.note ?? '').trim().slice(0, 500)
  const scope = key ?? req.process ?? 'all'
  let id = ''
  await audited(db, planner, [{ entityId: `changeover:${scope}:${from || '*'}>${to || '*'}`, field: 'minutes', newValue: `${req.minutes} min${note ? ` (${note})` : ''}` }], async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO planning_setup_times (machine_key, process, from_family, to_family, minutes, note, updated_by_id, updated_by_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (COALESCE(machine_key, ''), COALESCE(process, ''), lower(from_family), lower(to_family))
       DO UPDATE SET minutes = EXCLUDED.minutes, note = EXCLUDED.note, updated_by_id = EXCLUDED.updated_by_id, updated_by_name = EXCLUDED.updated_by_name, updated_at = now()
       RETURNING id`,
      [key, req.process, from, to, req.minutes, note, planner.id, planner.name],
    )
    id = rows[0].id
  })
  return id
}

export async function clearSetupTime(db: Db, planner: Planner, id: string): Promise<void> {
  const { rows } = await db.query<{ machineKey: string | null; process: string | null; fromFamily: string; toFamily: string; minutes: number }>(
    `SELECT machine_key AS "machineKey", process, from_family AS "fromFamily", to_family AS "toFamily", minutes FROM planning_setup_times WHERE id = $1`,
    [id],
  )
  const old = rows[0]
  if (!old) return
  await audited(db, planner, [{ entityId: `changeover:${old.machineKey ?? old.process ?? 'all'}:${old.fromFamily || '*'}>${old.toFamily || '*'}`, field: 'minutes', oldValue: `${old.minutes} min` }], async (tx) => {
    await tx.query(`DELETE FROM planning_setup_times WHERE id = $1`, [id])
  })
}

// ---- Maintenance -------------------------------------------------------------------------------------

export async function maintenance(db: Db): Promise<MaintenanceResponse> {
  const { rows } = await db.query<MaintenanceResponse['rules'][number]>(
    `SELECT id, machine_key AS "machineKey", name, every_days AS "everyDays", every_run_hours::float8 AS "everyRunHours", duration_hours::float8 AS "durationHours",
            last_done::text AS "lastDone", start_time AS "startTime", note, updated_by_name AS "updatedByName", updated_at AS "updatedAt"
       FROM planning_maintenance ORDER BY machine_key, name`,
  )
  return { rules: rows }
}

const describeMaintenance = (r: SetMaintenanceRequest) =>
  `${r.name}: every ${r.everyDays !== null ? `${r.everyDays} days` : `${r.everyRunHours} running hours`}, ${r.durationHours} h${r.lastDone ? `, last ${r.lastDone}` : ''}`

/** A maintenance rule added, or replaced by its id. */
export async function setMaintenance(db: Db, planner: Planner, req: SetMaintenanceRequest, id?: string): Promise<string> {
  const name = req.name.trim()
  if (name === '' || name.length > 120) throw badRequest('name: what the maintenance is, in at most 120 characters.')
  if (req.everyDays === null && req.everyRunHours === null) throw badRequest('Say every how many days, or every how many running hours.')
  if (req.everyDays !== null && !(Number.isInteger(req.everyDays) && req.everyDays >= 1 && req.everyDays <= 3650)) throw badRequest('everyDays: 1 to 3650.')
  if (req.everyRunHours !== null && !(req.everyRunHours > 0 && req.everyRunHours <= 1e6)) throw badRequest('everyRunHours: more than 0.')
  if (!(req.durationHours > 0 && req.durationHours <= 240)) throw badRequest('durationHours: up to 240.')
  if (req.lastDone !== null && !isDay(req.lastDone)) throw badRequest('lastDone: a day, YYYY-MM-DD, or empty.')
  const startTime = req.startTime ? req.startTime.trim() : null
  if (startTime !== null && !/^[0-2][0-9]:[0-5][0-9]$/.test(startTime)) throw badRequest('startTime: HH:MM, or empty for 08:00.')
  const key = (await machineKeys(db, [req.machineKey])).get(req.machineKey) ?? req.machineKey
  const note = (req.note ?? '').trim().slice(0, 500)
  const old = id ? (await db.query<{ machineKey: string; name: string }>(`SELECT machine_key AS "machineKey", name FROM planning_maintenance WHERE id = $1`, [id])).rows[0] : undefined
  if (id && !old) throw badRequest('No maintenance rule has that id.')
  let out = id ?? ''
  await audited(db, planner, [{ entityId: `maintenance:${key}:${name}`, field: 'rule', oldValue: old ? `${old.name} on ${old.machineKey}` : undefined, newValue: describeMaintenance({ ...req, name }) }], async (tx) => {
    if (id) {
      await tx.query(
        `UPDATE planning_maintenance SET machine_key = $2, name = $3, every_days = $4, every_run_hours = $5, duration_hours = $6, last_done = $7, start_time = $8, note = $9,
                updated_by_id = $10, updated_by_name = $11, updated_at = now() WHERE id = $1`,
        [id, key, name, req.everyDays, req.everyRunHours, req.durationHours, req.lastDone, startTime, note, planner.id, planner.name],
      )
    } else {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO planning_maintenance (machine_key, name, every_days, every_run_hours, duration_hours, last_done, start_time, note, updated_by_id, updated_by_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [key, name, req.everyDays, req.everyRunHours, req.durationHours, req.lastDone, startTime, note, planner.id, planner.name],
      )
      out = rows[0].id
    }
  })
  return out
}

export async function clearMaintenance(db: Db, planner: Planner, id: string): Promise<void> {
  const { rows } = await db.query<{ machineKey: string; name: string }>(`SELECT machine_key AS "machineKey", name FROM planning_maintenance WHERE id = $1`, [id])
  const old = rows[0]
  if (!old) return
  await audited(db, planner, [{ entityId: `maintenance:${old.machineKey}:${old.name}`, field: 'rule', oldValue: `${old.name} on ${old.machineKey}` }], async (tx) => {
    await tx.query(`DELETE FROM planning_maintenance WHERE id = $1`, [id])
  })
}

// ---- Settings ----------------------------------------------------------------------------------------

export async function settings(db: Db, config: Config): Promise<SettingsResponse> {
  const base = await loadPlanningBase(db, config.FACTORY_TIMEZONE)
  const set = await readSetSettings(db)
  return { set: set.settings, version: set.version, effective: effectiveSettings({ ...base, setSettings: set.settings }), learnt: base.learnt }
}

/** The planners' settings replaced whole (what is not named goes back to learnt or default). */
export async function saveSettings(db: Db, planner: Planner, input: unknown, version: number): Promise<void> {
  const checked = checkSettings(input)
  if (checked.errors.length > 0) throw badRequest(checked.errors.join(' '), { errors: checked.errors })
  const before = await readSetSettings(db)
  // Held to the version seen in the write itself: two saves of the same version cannot both go through.
  await audited(db, planner, [{ entityId: 'settings', field: 'settings', oldValue: JSON.stringify(before.settings), newValue: JSON.stringify(checked.settings) }], async (tx) => {
    const { rowCount } = await tx.query(
      `UPDATE planning_settings SET settings = $1, updated_by_id = $2, updated_by_name = $3, updated_at = now(), version = version + 1 WHERE version = $4`,
      [JSON.stringify(checked.settings), planner.id, planner.name, version],
    )
    if (!rowCount) throw new ConflictError({ version: (await readSetSettings(tx)).version })
  })
}
