import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import {
  AUTO_PLAN_ID,
  FRIDAY,
  formatWall,
  weekday,
  type CapacityResponse,
  type ComparisonResponse,
  type DataGapsResponse,
  type FloorResponse,
  type LoadResponse,
  type MaterialsResponse,
  type OverviewResponse,
  type PlanDetail,
  type PlanVsActualResponse,
  type PlansResponse,
  type QuoteResponse,
  type AdviseResponse,
  type BalanceResponse,
  type MaintenanceResponse,
  type SetupTimesResponse,
  type RatesResponse,
  type RoutesResponse,
  type SettingsResponse,
} from '@qc/shared/planning'
import type { AiAccess } from '@qc/shared/ai'
import { TestApp, calendarDay, type Session } from './harness'
import { planningToolHandlers } from '../src/planning/assistant'
import { renderSystemPrompt } from '../src/ai/prompt'
import { describeAiSchema } from '../src/ai/schemaDoc'
import { runReadOnlyQuery } from '../src/ai/runQuery'

// §25 — Planning, a trial module: it reads the order sheet, the production
// record and the inspections, and writes only its own tables.

const app = new TestApp()
let admin: Session
let viewer: Session
const today = calendarDay(0)

/** What the module may never change: the order sheet, the production record, the inspections, the register. */
async function recordChecksum(): Promise<string> {
  const { rows } = await app.db.query<{ sum: string }>(
    `SELECT md5(string_agg(t, '|' ORDER BY t)) AS sum FROM (
       SELECT 'o' || row_to_json(o)::text AS t FROM production_orders o
       UNION ALL SELECT 'r' || row_to_json(r)::text FROM production_task_records r
       UNION ALL SELECT 's' || row_to_json(s)::text FROM inspection_sessions s
       UNION ALL SELECT 'm' || row_to_json(m)::text FROM machines m) x`,
  )
  return rows[0].sum
}

const get = <T>(path: string, as: Session = admin) => app.api<T>('GET', `/api/planning${path}`, { token: as.token })
const send = <T>(method: string, path: string, body: unknown, as: Session = admin) => app.api<T>(method, `/api/planning${path}`, { token: as.token, body })

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  admin = await app.register('admin', 'Admin')
  viewer = await app.register('viewer1', 'Viewer One')
  await app.db.query(`UPDATE users SET role = 'viewer' WHERE id = $1`, [viewer.user.id])
  // Two factories: a roll former and a welder in F1, a paint line in F2.
  await app.db.query(
    `INSERT INTO machines (code, name, display_name, process, factory) VALUES
       ('024', 'Roll former', '24. Roll former', 'forming', 'F1'), ('30', 'Welder', '30. Welder', 'welding', 'F1'), ('40', 'Paint', '40. Paint', 'paint', 'F2')`,
  )
  // Order A: beams formed on 24, welded on 30, painted on 40; order B on the former only; a cancelled and a held line; one done.
  await app.db.query(
    `INSERT INTO production_orders (line_key, order_number, item_code, item, work_center_code, required_qty, finished_qty, part_duration_hours, due_date, planned_start, customer, erp_status, raw_material_qty, rm_received_qty, rm_promise_date, weight_kg)
     VALUES ('A1', 'A', 'BEAM', 'Beam 2000', '24', 100, 0, 10, $1::date + 1, $1::date - 3, 'Big Co', 'Active', 50, 0, $1::date + 2, 1000),
            ('A2', 'A', 'BEAM', 'Beam 2000', '30', 100, 0, 6, $1::date + 2, $1::date - 2, 'Big Co', 'Active', NULL, NULL, NULL, 1000),
            ('A3', 'A', 'BEAM', 'Beam 2000', '40', 100, 0, 4, $1::date + 3, $1::date - 1, 'Big Co', 'Active', NULL, NULL, NULL, 1000),
            ('B1', 'B', 'UPR', 'Upright', '24', 50, 10, 8, $1::date + 20, $1::date, 'Small Co', 'Active', NULL, NULL, NULL, 400),
            ('C1', 'C', 'X', 'Cancelled', '24', 10, 0, 1, NULL, NULL, 'Gone', 'Cancel', NULL, NULL, NULL, NULL),
            ('H1', 'H', 'Y', 'Held', '30', 10, 0, 1, NULL, NULL, 'Held Co', 'Hold', NULL, NULL, NULL, NULL),
            ('D1', 'D', 'Z', 'Done', '30', 10, 10, 1, NULL, NULL, 'Done Co', 'Active', NULL, NULL, NULL, NULL)`,
    [today],
  )
  // An inspection open on B1 now: the former is running it.
  await app.db.query(
    `INSERT INTO inspection_sessions (seq, order_id, work_center_code, inspector_id, inspector_name, started_at)
     SELECT 1, o.id, '24', $1, 'Admin', now() - interval '1 hour' FROM production_orders o WHERE o.line_key = 'B1'`,
    [admin.user.id],
  )
  // Ten days of the production record on the former: 2 shifts of 8 hours, 80 pieces an hour of BEAM.
  for (let i = 1; i <= 10; i++) {
    const day = calendarDay(-i)
    await app.db.query(
      `INSERT INTO production_task_records (line_key, erp_record_id, work_center_code, work_day, produced_qty, actual_hours, planned_hours, duration_hours, required_qty, shift)
       VALUES ('A1', $1, '24', $2, 640, 8, 8, 10, 100, 'صباحي'), ('A1', $3, '24', $2, 640, 8, 8, 10, 100, 'مسائي')`,
      [`a${i}`, day, `b${i}`],
    )
  }
})
afterAll(() => app.stop())

describe('§25 planning', () => {
  let before: string

  it('is a screen of its own: an administrator has it, a viewer does not until given it', async () => {
    before = await recordChecksum()
    expect((await get('/overview', viewer)).status).toBe(403)
    expect((await get('/overview')).status).toBe(200)
    const roles = await app.db.query<{ role: string }>(`SELECT role FROM role_permissions WHERE permission = 'view-planning' ORDER BY role`)
    expect(roles.rows.map((r) => r.role)).toEqual(['admin'])
  })

  it('plans every open line on its machine: stages in order, the running line first, the rest left out with why', async () => {
    const res = await get<PlanDetail>(`/plans/${AUTO_PLAN_ID}`)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const d = res.body
    const op = (k: string) => d.operations.find((o) => o.lineKey === k)!
    expect(d.operations.map((o) => o.lineKey).sort()).toEqual(['A1', 'A2', 'A3', 'B1'])
    expect(Object.fromEntries(d.excluded.map((e) => [e.lineKey, e.reason]))).toEqual({ C1: 'cancelled', H1: 'hold' })
    expect(op('B1')).toMatchObject({ machineKey: '24', seq: 1, flags: ['running'], qty: 40 })
    expect(op('A1').start!).toBeGreaterThanOrEqual(op('B1').end!)
    expect(op('A2').dependsOn).toEqual(['A1'])
    expect(op('A3').dependsOn).toEqual(['A2'])
    expect(op('A3').start!).toBeGreaterThan(op('A2').start!)
    // A1 waits for its raw material, promised in two days.
    expect(op('A1').flags).toContain('waits-material')
    // The promise day, or the Saturday after it when it falls on a Friday.
    const promised = calendarDay(2)
    expect(formatWall(op('A1').start!)).toBe(`${weekday(promised) === FRIDAY ? calendarDay(3) : promised} 08:00`)
    expect(d.plan).toMatchObject({ id: AUTO_PLAN_ID, kind: 'auto', editable: false })
  })

  it('learns each machine’s day and pace from the production record, and the capacity it gives', async () => {
    const learnt = await send<{ learnt: { machines: number; rates: number } }>('POST', '/setup/learn', {})
    expect(learnt.status, JSON.stringify(learnt.body)).toBe(200)
    expect(learnt.body.learnt.machines).toBe(1)
    const cap = await get<CapacityResponse>('/setup/capacity')
    const former = cap.body.rows.find((r) => r.machine.key === '24')!
    expect(former.stats).toMatchObject({ hoursPerDay: 16, hoursFrom: 'actual', daysObserved: 10, efficiency: 1 })
    expect(former.effective).toMatchObject({ hoursPerDay: 16, source: 'inferred' })
    const rates = await get<RatesResponse>('/setup/rates?machine=024')
    expect(rates.body.learnt.find((r) => r.itemCode === '' && r.itemFamily === '')).toMatchObject({ piecesPerHour: 80, samples: 20 })
    const routes = await get<RoutesResponse>('/setup/routes?q=beam')
    expect(routes.body.routes[0]).toMatchObject({ itemCode: 'beam', orders: 1 })
    expect(routes.body.routes[0].steps.map((s) => s.process)).toEqual(['forming', 'welding', 'paint'])
  })

  it('makes a scenario from the automatic plan, compares it line by line, and keeps it to the version seen', async () => {
    const made = await send<PlanDetail>('POST', '/plans', {
      kind: 'scenario',
      name: 'Former down',
      events: [{ type: 'machine-down', machineKey: '0024', from: `${calendarDay(1)} 08:00`, to: `${calendarDay(6)} 08:00`, note: 'Bearing' }],
    })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    const plan = made.body.plan
    expect(plan).toMatchObject({ kind: 'scenario', status: 'draft', editable: true, eventCount: 1, createdVia: 'app' })
    expect(plan.events[0]).toMatchObject({ type: 'machine-down', machineKey: '24' })
    const cmp = await get<ComparisonResponse>(`/plans/${plan.id}/compare`)
    expect(cmp.status).toBe(200)
    expect(cmp.body.baseName).toBe('Automatic plan')
    expect(cmp.body.later).toBeGreaterThan(0)
    expect(cmp.body.changes.some((c) => c.lineKey === 'A1')).toBe(true)
    const bad = await send('POST', '/plans', { kind: 'scenario', name: 'Bad', events: [{ type: 'machine-down', machineKey: '24', from: 'tomorrow', to: 'later' }] })
    expect(bad.status).toBe(400)
    // Changed by someone else meanwhile: refused, with the version now.
    const ok = await send<PlanDetail>('PATCH', `/plans/${plan.id}`, { version: plan.version, name: 'Former down a week' })
    expect(ok.status).toBe(200)
    expect(ok.body.plan.version).toBe(plan.version + 1)
    expect((await send('PATCH', `/plans/${plan.id}`, { version: plan.version, name: 'Stale' })).status).toBe(409)
    const load = await get<LoadResponse>(`/plans/${plan.id}/load?weeks=2`)
    expect(load.status).toBe(200)
    expect(load.body.weeks).toHaveLength(2)
    expect(load.body.rows.some((r) => r.machineKey === '24')).toBe(true)
  })

  it('quotes a delivery day for an order not on the sheet, through the items’ learnt routes, and advises how to meet a day', async () => {
    // BEAM's learnt route: former 24 → welder 30 → paint 40 (learnt from order A), 10 kg a piece.
    const q = await send<QuoteResponse>('POST', '/quote', { customer: 'New Co', dueDate: calendarDay(2), items: [{ itemCode: 'beam', qty: 40 }] })
    expect(q.status, JSON.stringify(q.body)).toBe(200)
    expect(q.body.orderNumber).toBe('NEW')
    expect(q.body.asIs.lines.map((l) => l.machineKey)).toEqual(['24', '30', '40'])
    expect(q.body.asIs.lines[0]).toMatchObject({ itemCode: 'beam', item: 'Beam 2000', qty: 40, durationSource: 'rate-item' })
    expect(q.body.asIs.completes).not.toBeNull()
    expect(q.body.rushed.completes!).toBeLessThanOrEqual(q.body.asIs.completes!)
    expect(q.body.unknownItems).toEqual([])
    expect(q.body.events[0]).toMatchObject({ type: 'new-order', items: [{ itemCode: 'beam', qty: 40 }] })
    // An item the record does not know is not planned, and said so; given its steps, it is.
    const unknown = await send<QuoteResponse>('POST', '/quote', { items: [{ itemCode: 'ZZZ', qty: 5 }, { itemCode: 'beam', qty: 1 }] })
    expect(unknown.body.unknownItems).toEqual(['ZZZ'])
    const stepped = await send<QuoteResponse>('POST', '/quote', { items: [{ itemCode: 'ZZZ', qty: 5, item: 'New thing', steps: [{ machineKey: '0024', hours: 2 }] }] })
    expect(stepped.body.asIs.lines.map((l) => [l.machineKey, l.hours, l.durationSource])).toEqual([['24', 2, 'event']])
    expect((await send('POST', '/quote', { items: [] })).status).toBe(400)
    // Advice for order A by tomorrow: the options are worked out, each with what it does to the others; one is best.
    const a = await send<AdviseResponse>('POST', '/advise', { orderNumber: 'A', dueDate: calendarDay(1) })
    expect(a.status, JSON.stringify(a.body)).toBe(200)
    expect(a.body.target).toMatchObject({ orderNumber: 'A', lines: 3, isNew: false })
    expect(a.body.options.map((o) => o.id)).toEqual(expect.arrayContaining(['rush', 'rush-hours-2', 'rush-hours-4', 'all']))
    expect(a.body.bestId).not.toBeNull()
    expect(a.body.priced).toBe(false)
    for (const o of a.body.options) expect(typeof o.meetsDue).toBe('boolean')
    // For a new order too, and never for an order the plan does not have or a day gone by.
    const n = await send<AdviseResponse>('POST', '/advise', { newOrder: { items: [{ itemCode: 'beam', qty: 40 }] }, dueDate: calendarDay(3) })
    expect(n.status, JSON.stringify(n.body)).toBe(200)
    expect(n.body.target.isNew).toBe(true)
    expect(n.body.asIs.events[0]).toMatchObject({ type: 'new-order' })
    expect((await send('POST', '/advise', { orderNumber: 'NOPE', dueDate: calendarDay(3) })).status).toBe(400)
    expect((await send('POST', '/advise', { orderNumber: 'A', dueDate: calendarDay(-1) })).status).toBe(400)
  })

  it('counts changeovers and maintenance stops in the plan, balances the machines, and tells the planners by the bell', async () => {
    // A changeover of 90 minutes on every former between any two families: A1 (BEAM) runs after B1 (UPR, running now) on the former.
    const before = (await get<PlanDetail>(`/plans/${AUTO_PLAN_ID}`)).body
    const a1Before = before.operations.find((o) => o.lineKey === 'A1')!
    const made = await send<{ id: string }>('PUT', '/setup/changeovers', { machineKey: null, process: 'forming', fromFamily: '', toFamily: '', minutes: 90 })
    expect(made.status, JSON.stringify(made.body)).toBe(200)
    const after = (await get<PlanDetail>(`/plans/${AUTO_PLAN_ID}`)).body
    const a1 = after.operations.find((o) => o.lineKey === 'A1')!
    expect(a1.setupMinutes).toBe(90)
    expect(a1.flags).toContain('changeover')
    expect(a1.end! - a1.start!).toBeGreaterThan(a1Before.end! - a1Before.start!)
    const list = await get<SetupTimesResponse>('/setup/changeovers')
    expect(list.body.rules).toHaveLength(1)
    expect((await send('PUT', '/setup/changeovers', { machineKey: '24', process: 'forming', fromFamily: '', toFamily: '', minutes: 5 })).status).toBe(400)
    expect((await send('PUT', '/setup/changeovers', { machineKey: null, process: null, fromFamily: '', toFamily: '', minutes: 10 }, viewer)).status).toBe(403)
    expect((await send('DELETE', `/setup/changeovers/${list.body.rules[0].id}`, undefined)).status).toBe(204)
    expect((await get<SetupTimesResponse>('/setup/changeovers')).body.rules).toHaveLength(0)
    // Maintenance: the welder stops 8 hours every 7 days from yesterday: a stop lands in the plan as a machine-down the welder's lines run around.
    const m = await send<{ id: string }>('POST', '/setup/maintenance', { machineKey: '30', name: 'Oil change', everyDays: 7, everyRunHours: null, durationHours: 8, lastDone: calendarDay(-1) })
    expect(m.status, JSON.stringify(m.body)).toBe(201)
    const planned = (await get<PlanDetail>(`/plans/${AUTO_PLAN_ID}`)).body
    expect(planned.plan.events).toEqual([]) // the stops are the setup's, not the plan's events
    const rules = await get<MaintenanceResponse>('/setup/maintenance')
    expect(rules.body.rules.map((r) => r.name)).toEqual(['Oil change'])
    expect((await send('PUT', `/setup/maintenance/${m.body.id}`, { machineKey: '30', name: 'Oil and belts', everyDays: 14, everyRunHours: null, durationHours: 8, lastDone: null })).status).toBe(204)
    expect((await get<MaintenanceResponse>('/setup/maintenance')).body.rules[0]).toMatchObject({ name: 'Oil and belts', everyDays: 14 })
    expect((await send('DELETE', `/setup/maintenance/${m.body.id}`, undefined)).status).toBe(204)
    // Balancing: with no machine loaded past its hours, nothing moves and it says so.
    const bal = await send<BalanceResponse>('POST', '/balance', { weeks: 2 })
    expect(bal.status, JSON.stringify(bal.body)).toBe(200)
    expect(bal.body.moves).toEqual([])
    expect(bal.body.warnings[0]).toMatch(/No machine is loaded past its hours/)
    // Alerts: the first run only takes note; a rise of as many late lines as the settings say is told to everyone with Planning, once.
    const s = (await get<SettingsResponse>('/setup/settings')).body
    expect((await send('PUT', '/setup/settings', { settings: { ...s.set, alertLateRise: 1, alertOverloadPct: 0 }, version: s.version })).status).toBe(200)
    const { keepAutoPlan } = await import('../src/planning/plans')
    const { planningAlerts } = await import('../src/planning/alerts')
    const first = await planningAlerts(app.db, app.config, await keepAutoPlan(app.db, app.config))
    expect(first).toBe(0)
    await app.db.query(`UPDATE planning_learnt SET alerts_state = jsonb_set(alerts_state, '{lateTold}', '0')`)
    const told = await planningAlerts(app.db, app.config, await keepAutoPlan(app.db, app.config))
    expect(told).toBeGreaterThan(0)
    const bell = await app.db.query<{ kind: string; title: string; link: string }>(`SELECT kind, title, link FROM user_notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [admin.user.id])
    expect(bell.rows[0]).toMatchObject({ kind: 'planning-alert', link: '/planning/late' })
    expect(bell.rows[0].title).toMatch(/more lines run late/)
    // Told once: the same state again writes nothing.
    expect(await planningAlerts(app.db, app.config, await keepAutoPlan(app.db, app.config))).toBe(0)
    await send('PUT', '/setup/settings', { settings: s.set, version: s.version + 1 })
  })

  it('publishes one plan at a time, keeps a published one as it was, and never deletes one that was published', async () => {
    const a = (await send<PlanDetail>('POST', '/plans', { kind: 'plan', name: 'Week plan' })).body.plan
    const pub = await send<PlanDetail>('POST', `/plans/${a.id}/publish`, { version: a.version })
    expect(pub.status, JSON.stringify(pub.body)).toBe(200)
    expect(pub.body.plan).toMatchObject({ status: 'published', editable: false })
    expect((await send('PATCH', `/plans/${a.id}`, { version: pub.body.plan.version, name: 'x' })).status).toBe(409)
    const b = (await send<PlanDetail>('POST', '/plans', { kind: 'plan', name: 'Next week', fromId: a.id })).body.plan
    expect(b.baseId).toBe(a.id)
    await send('POST', `/plans/${b.id}/publish`, { version: b.version })
    const list = await get<PlansResponse>('/plans')
    expect(list.body.plans.filter((p) => p.status === 'published').map((p) => p.name)).toEqual(['Next week'])
    expect(list.body.plans.find((p) => p.id === a.id)!.status).toBe('superseded')
    expect(list.body.plans[0]).toMatchObject({ id: AUTO_PLAN_ID, kind: 'auto' })
    const superseded = list.body.plans.find((p) => p.id === a.id)!
    expect((await app.api('DELETE', `/api/planning/plans/${a.id}?version=${superseded.version}`, { token: admin.token })).status).toBe(409)
    const floor = await get<FloorResponse>('/floor')
    expect(floor.body).toMatchObject({ planName: 'Next week', factories: ['F1', 'F2'] })
    const former = floor.body.machines.find((m) => m.key === '24')!
    expect(former.status).toBe('running')
    expect(former.sessions[0]).toMatchObject({ lineKey: 'B1', inspector: 'Admin' })
    expect(former.lastRecord).toMatchObject({ workDay: calendarDay(-1) })
    const audit = await app.db.query(`SELECT action FROM audit_log WHERE entity = 'planning-plan' AND entity_id = $1 ORDER BY at`, [a.id])
    expect(audit.rows.map((r) => r.action)).toEqual(['create', 'update', 'update'])
  })

  it('reads plan against actual, the material each line waits for, the overview and what the data lacks', async () => {
    const actual = await get<PlanVsActualResponse>(`/actual?from=${calendarDay(-3)}&to=${today}`)
    expect(actual.status, JSON.stringify(actual.body)).toBe(200)
    expect(actual.body.rows.some((r) => r.machineKey === '24' && r.actualQty === 1280)).toBe(true)
    expect(actual.body.plans.map((p) => p.name)).toContain('Next week')
    const mat = await get<MaterialsResponse>('/materials')
    expect(mat.body.rows.find((r) => r.lineKey === 'A1')).toMatchObject({ state: 'promised-late' })
    const ov = await get<OverviewResponse>('/overview')
    expect(ov.body.auto.lines).toBe(4)
    expect(ov.body.published?.plan.name).toBe('Next week')
    expect(ov.body.machinesRunning).toBe(1)
    const gaps = await get<DataGapsResponse>('/gaps')
    expect(gaps.body.openLines).toBe(5)
    expect(gaps.body.gaps.map((g) => g.id)).toEqual(expect.arrayContaining(['machine-hours', 'machine-map', 'moving-holidays', 'changeovers']))
  })

  it('changes the setup only for people with Planning setup, audited, and the next plan follows it', async () => {
    const other = await app.register('planner', 'Planner')
    await app.api('PUT', `/api/users/${other.user.id}/permissions`, { token: admin.token, body: { overrides: [{ permission: 'view-planning', granted: true }] } })
    expect((await send('PUT', '/setup/capacity/30', { hoursPerDay: 8, efficiency: null, worksFridays: false }, other)).status).toBe(403)
    expect((await send('POST', '/plans', { kind: 'scenario', name: 'No' }, other)).status).toBe(403)
    expect((await get('/overview', other)).status).toBe(200)
    expect((await send('PUT', '/setup/capacity/030', { hoursPerDay: 20, efficiency: 0.8, worksFridays: true, note: 'Two shifts' })).status).toBe(204)
    const cap = await get<CapacityResponse>('/setup/capacity')
    expect(cap.body.rows.find((r) => r.machine.key === '30')!.effective).toMatchObject({ hoursPerDay: 20, efficiency: 0.8, worksFridays: true, source: 'set' })
    expect((await send('PUT', `/setup/calendar/${calendarDay(30)}`, { working: false, name: 'Eid' })).status).toBe(204)
    expect((await send('PUT', '/setup/rates', { machineKey: '40', itemFamily: '', piecesPerHour: 50 })).status).toBe(204)
    const s = await get<SettingsResponse>('/setup/settings')
    const saved = await send<SettingsResponse>('PUT', '/setup/settings', { settings: { sequenceRule: 'due', overlapPct: 0 }, version: s.body.version })
    expect(saved.status, JSON.stringify(saved.body)).toBe(200)
    expect(saved.body.effective).toMatchObject({ sequenceRule: 'due', overlapPct: 0 })
    expect((await send('PUT', '/setup/settings', { settings: { overlapPct: 10 }, version: s.body.version })).status).toBe(409)
    expect((await send('PUT', '/setup/settings', { settings: { overlapPct: 900 }, version: saved.body.version })).status).toBe(400)
    const auto = (await get<PlanDetail>(`/plans/${AUTO_PLAN_ID}`)).body
    expect(auto.operations.find((o) => o.lineKey === 'A3')).toMatchObject({ durationSource: 'set-rate', hours: 2 })
    const audit = await app.db.query(`SELECT count(*)::int AS n FROM audit_log WHERE entity = 'planning-setup'`)
    expect(audit.rows[0].n).toBeGreaterThanOrEqual(4)
    expect((await send('PUT', '/layout', { positions: [{ machineKey: '024', x: 0, y: 0, w: 3, h: 2 }, { machineKey: '30', x: 4, y: 0, w: 2, h: 2 }] })).status).toBe(204)
    expect((await send('PUT', '/layout', { positions: [{ machineKey: '40', x: 23, y: 0, w: 3, h: 2 }] })).status).toBe(400)
    const floor = await get<FloorResponse>('/floor')
    expect(floor.body.machines.find((m) => m.key === '24')!.layout).toEqual({ x: 0, y: 0, w: 3, h: 2 })
  })

  it('gives the assistant planning as its own domain: its views, its what-ifs, and a scenario kept only with the permission', async () => {
    const tool = (name: string, input: unknown): Anthropic.Beta.BetaToolUseBlock => ({ type: 'tool_use', id: `tu_${name}`, name, input })
    // Someone the owner has not given planning: nothing is worked out.
    const notGiven = planningToolHandlers({ db: app.db, config: app.config, userId: viewer.user.id, userName: 'Viewer One', conversationId: '00000000-0000-4000-8000-000000000001' })
    const denied = await notGiven.planning_simulate.run(tool('planning_simulate', { events: [] }), new AbortController().signal)
    expect(denied.result.is_error).toBe(true)
    expect(String(denied.result.content)).toMatch(/planning is not among the data/)
    // The owner's own row: planning is theirs to give themselves.
    const access = await app.api<{ people: AiAccess[] }>('GET', '/api/ai/access', { token: admin.token })
    const own = access.body.people.find((p) => p.userId === admin.user.id)!
    const granted = await app.api<AiAccess>('PUT', `/api/ai/access/${admin.user.id}`, {
      token: admin.token,
      body: { enabled: true, domains: [...new Set([...(own?.domains ?? []), 'planning'])], monthlyCapUsd: own?.monthlyCapUsd ?? 5 },
    })
    expect(granted.status, JSON.stringify(granted.body)).toBe(200)
    const handlers = planningToolHandlers({ db: app.db, config: app.config, userId: admin.user.id, userName: 'Admin', conversationId: '00000000-0000-4000-8000-000000000001' })
    const sim = await handlers.planning_simulate.run(
      tool('planning_simulate', { events: [{ type: 'priority', customer: 'small co' }, { type: 'working-day', day: calendarDay(7), working: true }] }),
      new AbortController().signal,
    )
    expect(sim.result.is_error, String(sim.result.content)).toBeFalsy()
    const body = JSON.parse(String(sim.result.content))
    expect(body).toMatchObject({ comparedWith: 'Automatic plan', base: { lines: 4 }, scenario: { lines: 4 } })
    const quoted = await handlers.planning_quote.run(tool('planning_quote', { items: [{ itemCode: 'beam', qty: 10 }], customer: 'New Co' }), new AbortController().signal)
    expect(quoted.result.is_error, String(quoted.result.content)).toBeFalsy()
    expect(JSON.parse(String(quoted.result.content))).toMatchObject({ order: 'NEW', inItsTurn: { lines: [{ machine: '24. Roll former' }, { machine: '30. Welder' }, { machine: '40. Paint' }] } })
    const advised = await handlers.planning_advise.run(tool('planning_advise', { orderNumber: 'A', dueDate: calendarDay(2) }), new AbortController().signal)
    expect(advised.result.is_error, String(advised.result.content)).toBeFalsy()
    expect(JSON.parse(String(advised.result.content)).options.length).toBeGreaterThan(2)
    const bad = await handlers.planning_simulate.run(tool('planning_simulate', { events: [{ type: 'speed', machineKey: '24' }] }), new AbortController().signal)
    expect(bad.result.is_error).toBe(true)
    expect(String(bad.result.content)).toMatch(/speedPct/)
    // An ai_conversations row for the plan to point at.
    const conv = await app.db.query<{ id: string }>(
      `INSERT INTO ai_conversations (user_id, title, model, system_prompt, tools) VALUES ($1, 't', 'claude-sonnet-5-5', '', '[]') RETURNING id`,
      [admin.user.id],
    ).catch(() => null)
    const conversationId = conv?.rows[0]?.id ?? '00000000-0000-4000-8000-000000000001'
    const saver = planningToolHandlers({ db: app.db, config: app.config, userId: admin.user.id, userName: 'Admin', conversationId })
    const kept = await saver.planning_save_scenario.run(tool('planning_save_scenario', { name: 'Rush Small Co', events: [{ type: 'priority', customer: 'Small Co' }] }), new AbortController().signal)
    expect(kept.result.is_error, String(kept.result.content)).toBeFalsy()
    const keptBody = JSON.parse(String(kept.result.content))
    expect(keptBody).toMatchObject({ kept: true, link: `/planning/simulator?plan=${keptBody.planId}` })
    const listed = (await get<PlansResponse>('/plans')).body.plans.find((p) => p.id === keptBody.planId)!
    expect(listed).toMatchObject({ createdVia: 'assistant', status: 'draft', kind: 'scenario' })
    const revised = await saver.planning_save_scenario.run(
      tool('planning_save_scenario', { name: 'Rush Small Co, Friday too', events: [{ type: 'priority', customer: 'Small Co' }], revises: keptBody.planId }),
      new AbortController().signal,
    )
    expect(JSON.parse(String(revised.result.content)).planId).toBe(keptBody.planId)
    // Without the app permission to make plans, nothing is kept.
    await app.api('PUT', `/api/users/${viewer.user.id}/permissions`, { token: admin.token, body: { overrides: [] } })
    await app.api('PUT', `/api/ai/access/${viewer.user.id}`, { token: admin.token, body: { enabled: true, domains: ['planning'], monthlyCapUsd: 5 } })
    const viewerTools = planningToolHandlers({ db: app.db, config: app.config, userId: viewer.user.id, userName: 'Viewer One', conversationId })
    const refused = await viewerTools.planning_save_scenario.run(tool('planning_save_scenario', { name: 'X', events: [] }), new AbortController().signal)
    expect(refused.result.is_error).toBe(true)
    expect(String(refused.result.content)).toMatch(/Make plans and scenarios/)

    // The views, through the planning domain's own reader, and nothing of it for another domain.
    const opts = { maxRows: 200, timeoutMs: 10_000, timeZone: app.config.FACTORY_TIMEZONE }
    const read = await runReadOnlyQuery(app.aiReader.poolFor(['planning']), `SELECT plan_kind, count(*) AS n FROM ai.planning_operations GROUP BY 1 ORDER BY 1`, opts)
    expect(read.ok, read.ok ? '' : read.error).toBe(true)
    const refusedRead = await runReadOnlyQuery(app.aiReader.poolFor(['orders']), `SELECT 1 FROM ai.planning_plans`, opts)
    expect(refusedRead.ok).toBe(false)
    const prompt = renderSystemPrompt(app.config.FACTORY_TIMEZONE, await describeAiSchema(app.db, ['planning']), ['planning'], { tasks: true })
    expect(prompt).toContain('# Planning (a trial module)')
    expect(prompt).toContain('### ai.planning_operations')
    expect(renderSystemPrompt(app.config.FACTORY_TIMEZONE, await describeAiSchema(app.db, ['orders']), ['orders'])).not.toContain('planning_simulate')
  })

  it('holds to one published plan and one settings version under two people at once, and keeps change ids apart', async () => {
    const x = (await send<PlanDetail>('POST', '/plans', { kind: 'plan', name: 'X' })).body.plan
    const y = (await send<PlanDetail>('POST', '/plans', { kind: 'plan', name: 'Y' })).body.plan
    const both = await Promise.all([send('POST', `/plans/${x.id}/publish`, { version: x.version }), send('POST', `/plans/${y.id}/publish`, { version: y.version })])
    expect(both.map((r) => r.status)).toEqual([200, 200])
    const published = await app.db.query(`SELECT name FROM planning_plans WHERE status = 'published' AND deleted_at IS NULL`)
    expect(published.rowCount).toBe(1)
    const s = (await get<SettingsResponse>('/setup/settings')).body
    const saves = await Promise.all([
      send('PUT', '/setup/settings', { settings: { ...s.set, overlapPct: 25 }, version: s.version }),
      send('PUT', '/setup/settings', { settings: { ...s.set, overlapPct: 75 }, version: s.version }),
    ])
    expect(saves.map((r) => r.status).sort()).toEqual([200, 409])
    // A scenario from a plan whose change has the id an added one also has: both kept, under ids of their own.
    const base = (await send<PlanDetail>('POST', '/plans', { kind: 'scenario', name: 'Base', events: [{ id: 'a1', type: 'add-order', orderNumber: 'N1', item: 'Frame', machineKey: '30', qty: 5, hours: 2 }] })).body.plan
    const on = await send<PlanDetail>('POST', '/plans', { kind: 'scenario', name: 'On top', fromId: base.id, events: [{ id: 'a1', type: 'add-order', orderNumber: 'N2', item: 'Frame', machineKey: '30', qty: 5, hours: 2 }] })
    expect(on.status, JSON.stringify(on.body)).toBe(201)
    expect(new Set(on.body.plan.events.map((e) => e.id)).size).toBe(2)
    expect(on.body.operations.filter((o) => o.flags.includes('hypothetical'))).toHaveLength(2)
    // Its base deleted, it is compared with the automatic plan.
    await app.api('DELETE', `/api/planning/plans/${base.id}?version=${base.version}`, { token: admin.token })
    const cmp = await get<ComparisonResponse>(`/plans/${on.body.plan.id}/compare`)
    expect(cmp.status).toBe(200)
    expect(cmp.body.baseName).toBe('Automatic plan')
  })

  it('moves a plan’s updated_at only when someone changes it, and stops a plan archived from being in force', async () => {
    const p = (await send<PlanDetail>('POST', '/plans', { kind: 'plan', name: 'Kept' })).body.plan
    const before = await app.db.query<{ at: string }>(`SELECT updated_at AS at FROM planning_plans WHERE id = $1`, [p.id])
    await new Promise((r) => setTimeout(r, 20))
    await app.db.query(`UPDATE planning_plans SET computed_at = now() WHERE id = $1`, [p.id])
    expect((await app.db.query<{ at: string }>(`SELECT updated_at AS at FROM planning_plans WHERE id = $1`, [p.id])).rows[0].at).toBe(before.rows[0].at)
    const pub = (await send<PlanDetail>('POST', `/plans/${p.id}/publish`, { version: p.version })).body.plan
    expect((await app.db.query<{ at: string }>(`SELECT updated_at AS at FROM planning_plans WHERE id = $1`, [p.id])).rows[0].at).not.toBe(before.rows[0].at)
    await send('POST', `/plans/${p.id}/archive`, { version: pub.version })
    const later = await get<PlanVsActualResponse>(`/actual?from=${calendarDay(2)}&to=${calendarDay(3)}`)
    expect(later.body.plans.map((x) => x.id)).not.toContain(p.id)
  })

  it('describes every column of its views to the assistant, each *_at backed by an index', async () => {
    const { rows } = await app.db.query<{ view: string; column: string }>(
      `SELECT c.relname AS view, a.attname AS column FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
        WHERE c.relnamespace = 'ai'::regnamespace AND c.relname LIKE 'planning\\_%' AND a.attnum > 0 AND NOT a.attisdropped
          AND col_description(c.oid, a.attnum) IS NULL`,
    )
    expect(rows.map((r) => `${r.view}.${r.column}`)).toEqual([])
  })

  it('has changed nothing of the order sheet, the production record, the inspections or the register', async () => {
    expect(await recordChecksum()).toBe(before)
  })
})
