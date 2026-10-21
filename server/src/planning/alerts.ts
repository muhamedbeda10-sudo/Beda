// ============================================================================
// §25 — the bell tells the planners when the plan needs a look: the
// automatic plan's late lines rose by as many as the settings say since they
// were last told, or a machine is loaded past the share they set over the
// next two weeks. Said once per state (planning_learnt.alerts_state keeps
// what was last told), to everyone with the Planning screen. Read by the
// refresher after it keeps the automatic plan.
// ============================================================================

import { buildCalendars, machineLoad, type PlanResult } from '@qc/shared/planning'
import { calendarDay } from '@qc/shared/rules'
import { createNotifications } from '../automations/notify'
import { LIVE_PERSON } from '../automations/people'
import type { Config } from '../config'
import type { Db } from '../db/pool'
import { effectiveSettings, loadPlanningBase, maintenanceStops } from './data'

interface AlertsState {
  /** The late lines the planners were last told of. */
  lateTold?: number
  /** The machines told as overloaded, with the day they were told. */
  overloadedTold?: Record<string, string>
}

const OVERLOAD_WEEKS = 2

/** Everyone with the Planning screen. */
async function planners(db: Db): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(`SELECT u.id FROM users u WHERE ${LIVE_PERSON} AND user_has_permission(u.id, 'view-planning')`)
  return rows.map((r) => r.id)
}

/** What the plan says now, against what was last told; writes the alerts due and remembers them. Returns how many alerts were written. */
export async function planningAlerts(db: Db, config: Config, result: PlanResult, now = new Date()): Promise<number> {
  const base = await loadPlanningBase(db, config.FACTORY_TIMEZONE)
  const settings = effectiveSettings(base)
  if (settings.alertLateRise <= 0 && settings.alertOverloadPct <= 0) return 0
  const { rows } = await db.query<{ state: AlertsState }>(`SELECT alerts_state AS state FROM planning_learnt`)
  const state: AlertsState = rows[0]?.state ?? {}
  const next: AlertsState = { ...state }
  const today = calendarDay(now, config.FACTORY_TIMEZONE)
  const notes: { title: string; body: string; severity: 'warning' | 'critical'; link: string }[] = []

  // Late lines: up by the rise since last told (first time: told the figure, no alert).
  const late = result.summary.late
  if (settings.alertLateRise > 0) {
    if (state.lateTold === undefined) next.lateTold = late
    else if (late - state.lateTold >= settings.alertLateRise) {
      notes.push({
        title: `Planning: ${late - state.lateTold} more lines run late`,
        body: `The automatic plan now has ${late} late lines (${state.lateTold} when last told), up to ${result.summary.maxLateDays} days late. See which under Planning → Late lines.`,
        severity: late - state.lateTold >= settings.alertLateRise * 3 ? 'critical' : 'warning',
        link: '/planning/late',
      })
      next.lateTold = late
    } else if (late < state.lateTold) next.lateTold = late
  }

  // Overload: a machine loaded past the share over the next weeks, told once until it is under again.
  if (settings.alertOverloadPct > 0) {
    const calendars = buildCalendars(base.machines.map((m) => m.key), base.capacities, base.calendar, settings, maintenanceStops(base, now, config.FACTORY_TIMEZONE, settings))
    const names = new Map(base.machines.map((m) => [m.key, m.name]))
    const told = { ...(state.overloadedTold ?? {}) }
    const fresh: string[] = []
    for (const [k, l] of machineLoad(result.operations, calendars, today, OVERLOAD_WEEKS)) {
      const pct = l.capacityHours > 0 ? Math.round(l.pct) : 0
      if (pct >= settings.alertOverloadPct) {
        if (!told[k]) {
          told[k] = today
          fresh.push(`${names.get(k) ?? `Machine ${k}`} (${pct}%)`)
        }
      } else delete told[k]
    }
    next.overloadedTold = told
    if (fresh.length > 0) {
      notes.push({
        title: `Planning: ${fresh.length === 1 ? 'a machine is' : `${fresh.length} machines are`} loaded past ${settings.alertOverloadPct}%`,
        body: `Over the next ${OVERLOAD_WEEKS} weeks the plan asks more of ${fresh.join(', ')} than ${fresh.length === 1 ? 'it has' : 'they have'}. See the load under Planning → Load, and what could move under Suggest moves.`,
        severity: 'warning',
        link: '/planning/load',
      })
    }
  }

  let written = 0
  if (notes.length > 0) {
    const people = await planners(db)
    for (const n of notes) written += await createNotifications(db, people, { kind: 'planning-alert', severity: n.severity, title: n.title, body: n.body, link: n.link })
  }
  if (JSON.stringify(next) !== JSON.stringify(state)) await db.query(`UPDATE planning_learnt SET alerts_state = $1`, [JSON.stringify(next)])
  return written
}
