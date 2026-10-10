import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest'
import type { Automation } from '@qc/shared/automation'
import { AUTOMATION_DAILY_CASE_LIMIT } from '@qc/shared/automation'
import { createPool } from '../src/db/pool'
import { AutomationEngine } from '../src/automations/engine'
import { sendSystemMessageBatch } from '../src/automations/systemChat'
import { isolate } from '../src/automations/text'
import { TestApp } from './harness'
import { text } from './aiFake'
import {
  addMachines,
  alertsOf,
  Clock,
  depsFor,
  engineFor,
  grant,
  insertAutomation,
  reportDraft,
  runsOf,
  setUp,
  systemMessagesTo,
  watchDraft,
  HOUR,
  MINUTE,
  type People,
} from './automationsKit'

// §21 — the engine: due automations taken under a lease (two engines never
// run one twice), each case of a watch fired once, the bell kept from storms
// and held to a daily limit, the chat told once per run, follow-ups opened
// and escalated, failures counted until an automation stops itself, and a
// creator who cannot run it now blocking it — not failing it — until they
// can again. Each person told what is theirs, with links they can open. A
// long run never holds the ticks; stopping hands back the runs under way.
// The clock is the test's.

const app = new TestApp()
let p: People

const series = (from: number, to: number, extra = '') => `SELECT g::text AS machine_code, 'Case ' || g AS machine${extra} FROM generate_series(${from}, ${to}) g ORDER BY g`
const watch = (sql: string, over: Partial<ReturnType<typeof watchDraft>['watch']> = {}) => ({ ...watchDraft().watch!, sql, ...over })
const automation = async (id: string, as = p.owner) => (await app.api<Automation>('GET', `/api/automations/${id}`, { token: as.token })).body
const row = async (id: string) =>
  (
    await app.db.query<{ status: string; failures: number; nextRunAt: string | null; runningUntil: string | null; retryAt: string | null; blockedReason: string | null; statusNote: string | null }>(
      `SELECT status, consecutive_failures AS failures, next_run_at AS "nextRunAt", running_until AS "runningUntil", retry_at AS "retryAt",
              blocked_reason AS "blockedReason", status_note AS "statusNote" FROM ai_automations WHERE id = $1`,
      [id],
    )
  ).rows[0]

beforeAll(async () => {
  await app.start()
  p = await setUp(app)
})
afterAll(() => app.stop())
beforeEach(async () => {
  // Each test's automations only: the engine runs everything due.
  app.model.reset()
  await app.db.query(`UPDATE ai_automations SET deleted_at = now(), next_run_at = NULL WHERE deleted_at IS NULL`)
  await app.db.query(`DELETE FROM user_notifications`)
})

/** Until a condition holds (a call in flight), a few seconds at most. */
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 250; i++) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('It never happened.')
}

describe('§21 the lease', () => {
  it('two engines ticking at once never run an automation twice', async () => {
    const clock = new Clock()
    const ids: string[] = []
    for (let i = 0; i < 12; i++) ids.push(await insertAutomation(app.db, { creatorId: p.creator.user.id, name: `Parallel ${i}`, nextRunAt: clock.now() }))
    // A second instance: its own connections, the same database.
    const other = createPool(app.config.DATABASE_URL, 5)
    try {
      const a = engineFor(app, clock)
      const b = engineFor(app, clock, other)
      await Promise.all([a.tick(), b.tick(), a.tick(), b.tick()])
      for (const id of ids) {
        const runs = await runsOf(app.db, id)
        expect(runs, id).toHaveLength(1)
        expect(runs[0]).toMatchObject({ trigger: 'schedule', ok: true, fired: 2 })
        expect(await row(id)).toMatchObject({ runningUntil: null, nextRunAt: new Date(clock.at.getTime() + 5 * MINUTE).toISOString() })
      }
      // Every case of every automation told once.
      expect((await alertsOf(app.db, p.plain.user.id)).filter((x) => x.kind === 'automation-case')).toHaveLength(24)
      // Nothing is due again until the interval has passed.
      await Promise.all([a.tick(), b.tick()])
      for (const id of ids) expect(await runsOf(app.db, id)).toHaveLength(1)
    } finally {
      await other.end()
    }
  })

  it('never takes an automation whose run is in flight; a run lost with its instance is closed as interrupted', async () => {
    const clock = new Clock()
    const id = await insertAutomation(app.db, { creatorId: p.creator.user.id, nextRunAt: clock.now() })
    await app.db.query(`UPDATE ai_automations SET running_until = $2 WHERE id = $1`, [id, new Date(clock.at.getTime() + 5 * MINUTE).toISOString()])
    await app.db.query(`INSERT INTO ai_automation_runs (automation_id, trigger, started_at) VALUES ($1, 'schedule', $2)`, [id, new Date(clock.at.getTime() - MINUTE).toISOString()])
    const engine = engineFor(app, clock)
    await engine.tick()
    expect(await runsOf(app.db, id)).toHaveLength(1)
    // The lease runs out: the lost run is closed and a new one made.
    clock.advance(6 * MINUTE)
    await engine.tick()
    const runs = await runsOf(app.db, id)
    expect(runs.map((r) => [r.ok, r.error])).toEqual([
      [false, 'Interrupted: the server stopped during this run.'],
      [true, null],
    ])
  })
})

describe('§21 watches', () => {
  it('fires each case once, across runs', async () => {
    const clock = new Clock()
    const engine = engineFor(app, clock)
    const id = await insertAutomation(app.db, { creatorId: p.creator.user.id, nextRunAt: clock.now() })
    await engine.tick()
    clock.advance(5 * MINUTE)
    await engine.tick()
    await addMachines(app.db, ['44'])
    clock.advance(5 * MINUTE)
    await engine.tick()
    expect((await runsOf(app.db, id)).map((r) => [r.matched, r.fired, r.notified, r.casesNotified])).toEqual([
      [2, 2, 2, 2],
      [2, 0, 0, 0],
      [3, 1, 1, 1],
    ])
    const alerts = await alertsOf(app.db, p.plain.user.id)
    expect(alerts.map((a) => a.title).sort()).toEqual(['New machine 31. Machine', 'New machine 44. Machine', 'New machine 58. Machine'])
    // A supervisor may not open the automation's page, and the case names no session: nowhere to lead them.
    expect(alerts[0]).toMatchObject({ kind: 'automation-case', severity: 'info', link: null })
    expect((await app.db.query(`SELECT case_key FROM ai_automation_hits WHERE automation_id = $1`, [id])).rowCount).toBe(3)
    // Only the people named: the supervisors, not anyone else.
    for (const s of [p.owner, p.creator, p.admin2]) expect(await alertsOf(app.db, s.user.id), s.user.name).toEqual([])
    await app.db.query(`UPDATE machines SET deleted_at = now() WHERE code = '44'`)
  })

  it('sends one digest instead of an alert each beyond the storm limit, and keeps to the row cap', async () => {
    const clock = new Clock()
    const id = await insertAutomation(app.db, { creatorId: p.creator.user.id, watch: watch(series(1, 600)), nextRunAt: clock.now() })
    await engineFor(app, clock).tick()
    const [run] = await runsOf(app.db, id)
    expect(run).toMatchObject({ ok: true, matched: 500, fired: 500, notified: 1, casesNotified: 0, digest: true })
    expect(run.note).toContain('more than 500 rows; only the first 500 were looked at')
    expect(run.note).toContain('500 new cases at once: the bell had one digest')
    const [digest] = await alertsOf(app.db, p.plain.user.id)
    expect(digest).toMatchObject({ kind: 'automation-digest', title: 'New machines: 500 new cases', link: null })
    expect(digest.body.split('\n')).toHaveLength(21)
    expect(digest.body.split('\n')[0]).toBe('• New machine Case 1')
    expect(digest.body.split('\n')[20]).toBe('…and 480 more')
    expect((await app.db.query(`SELECT 1 FROM ai_automation_hits WHERE automation_id = $1`, [id])).rowCount).toBe(500)
  })

  it('holds the bell to the daily limit of cases told one by one, a factory day at a time', async () => {
    const clock = new Clock(new Date('2026-10-10T09:00:00Z'))
    const engine = engineFor(app, clock)
    const id = await insertAutomation(app.db, { creatorId: p.creator.user.id, watch: watch(series(1, 2)), nextRunAt: clock.now() })
    // Earlier today it told all but one of the day's allowance.
    await app.db.query(`INSERT INTO ai_automation_runs (automation_id, trigger, started_at, finished_at, ok, cases_notified) VALUES ($1, 'schedule', $2, $2, true, $3)`, [
      id,
      new Date(clock.at.getTime() - HOUR).toISOString(),
      AUTOMATION_DAILY_CASE_LIMIT - 1,
    ])
    await engine.tick()
    expect((await runsOf(app.db, id))[1]).toMatchObject({ fired: 2, digest: true, casesNotified: 0, note: expect.stringContaining(`The day's limit of ${AUTOMATION_DAILY_CASE_LIMIT}`) })
    expect((await alertsOf(app.db, p.plain.user.id)).map((a) => a.kind)).toEqual(['automation-digest'])
    // The next factory day the allowance is whole again.
    await app.db.query(`UPDATE ai_automations SET watch = $2::json WHERE id = $1`, [id, JSON.stringify(watch(series(3, 4)))])
    clock.advance(24 * HOUR)
    await engine.tick()
    expect((await runsOf(app.db, id))[2]).toMatchObject({ fired: 2, digest: false, casesNotified: 2 })
    expect((await alertsOf(app.db, p.plain.user.id)).map((a) => a.kind)).toEqual(['automation-digest', 'automation-case', 'automation-case'])
  })

  it('tells each person named by a case about their own cases, and writes the chat once per person per run', async () => {
    const clock = new Clock()
    const sql = `SELECT g::text AS machine_code, 'Case ' || g AS machine, CASE WHEN g = 1 THEN '${p.creator2.user.id}' ELSE '${p.creator.user.id}' END AS person FROM generate_series(1, 3) g ORDER BY g`
    const id = await insertAutomation(app.db, {
      creatorId: p.owner.user.id,
      watch: watch(sql),
      recipients: [{ kind: 'role', role: 'supervisor' }, { kind: 'column', column: 'person' }],
      channels: { bell: true, chat: true },
      nextRunAt: clock.now(),
    })
    await engineFor(app, clock).tick()
    const titles = async (userId: string) => (await alertsOf(app.db, userId)).map((a) => a.title).sort()
    expect(await titles(p.plain.user.id)).toEqual(['New machine Case 1', 'New machine Case 2', 'New machine Case 3'])
    expect(await titles(p.creator2.user.id)).toEqual(['New machine Case 1'])
    expect(await titles(p.creator.user.id)).toEqual(['New machine Case 2', 'New machine Case 3'])
    // None of them may open the automation's page (the owner made it), and the cases name no session: the lines carry no link.
    expect(await systemMessagesTo(app.db, p.plain.user.id)).toEqual([`New machines: 3 new cases\n• New machine Case 1\n• New machine Case 2\n• New machine Case 3`])
    expect(await systemMessagesTo(app.db, p.creator2.user.id)).toEqual([`New machines: 1 new case\n• New machine Case 1`])
    expect(await systemMessagesTo(app.db, p.creator.user.id)).toEqual([`New machines: 2 new cases\n• New machine Case 2\n• New machine Case 3`])
    // Bell alerts and chat messages, one per person each: 3 + 1 + 2 alerts, 3 messages.
    expect((await runsOf(app.db, id))[0]).toMatchObject({ fired: 3, notified: 9, casesNotified: 3 })
  })

  it('opens a follow-up per new case for the person in the case, links its alerts to it, and escalates it once when overdue', async () => {
    const clock = new Clock()
    const engine = engineFor(app, clock)
    const sql = `SELECT g::text AS machine_code, 'Case ' || g AS machine, '${p.creator2.user.id}' AS person FROM generate_series(1, 2) g ORDER BY g`
    const id = await insertAutomation(app.db, {
      creatorId: p.creator.user.id,
      watch: watch(sql),
      actions: { notify: true, followUp: { assignee: { kind: 'column', column: 'person' }, dueHours: 2 } },
      nextRunAt: clock.now(),
    })
    await engine.tick()
    const followUps = (
      await app.db.query<{ id: string; caseKey: string; assigneeId: string; dueAt: string; status: string }>(
        `SELECT id, case_key AS "caseKey", assignee_id AS "assigneeId", due_at AS "dueAt", status FROM follow_ups WHERE automation_id = $1 ORDER BY case_key`,
        [id],
      )
    ).rows
    expect(followUps.map((f) => [f.caseKey, f.assigneeId, f.status, f.dueAt])).toEqual([
      ['1', p.creator2.user.id, 'open', new Date(clock.at.getTime() + 2 * HOUR).toISOString()],
      ['2', p.creator2.user.id, 'open', new Date(clock.at.getTime() + 2 * HOUR).toISOString()],
    ])
    expect((await runsOf(app.db, id))[0]).toMatchObject({ fired: 2, followUps: 2 })
    const alerts = await alertsOf(app.db, p.plain.user.id)
    expect(alerts.map((a) => [a.kind, a.severity, a.link]).sort()).toEqual(followUps.map((f) => ['automation-case', 'warning', `/follow-ups/${f.id}`]).sort())
    expect((await alertsOf(app.db, p.creator2.user.id)).map((a) => a.kind)).toEqual(['follow-up-assigned', 'follow-up-assigned'])
    expect((await automation(id)).openFollowUps).toBe(2)

    clock.advance(3 * HOUR)
    await engine.tick()
    await engine.tick()
    expect((await alertsOf(app.db, p.creator2.user.id)).filter((a) => a.kind === 'follow-up-overdue')).toHaveLength(2)
    expect((await alertsOf(app.db, p.creator.user.id)).filter((a) => a.kind === 'follow-up-overdue')).toHaveLength(2)
  })
})

describe('§21 failing and blocked', () => {
  it('counts failed runs and stops after five in a row, telling the creator and the owner once; resuming starts again', async () => {
    const clock = new Clock()
    const engine = engineFor(app, clock)
    const id = await insertAutomation(app.db, { creatorId: p.creator.user.id, watch: watch(`SELECT (1 / (g - g))::text AS machine_code, 'x' AS machine FROM generate_series(1, 1) g`), nextRunAt: clock.now() })
    for (let i = 0; i < 4; i++) {
      await engine.tick()
      clock.advance(5 * MINUTE)
    }
    expect(await row(id)).toMatchObject({ status: 'active', failures: 4 })
    // A manual run is recorded and counts for nothing.
    const manual = await app.api<{ ok: boolean; trigger: string; error: string }>('POST', `/api/automations/${id}/run`, { token: p.creator.token })
    expect(manual.status).toBe(200)
    expect(manual.body).toMatchObject({ ok: false, trigger: 'manual', error: 'division by zero' })
    expect(await row(id)).toMatchObject({ status: 'active', failures: 4 })
    await engine.tick()
    expect(await row(id)).toMatchObject({ status: 'failed', failures: 5, nextRunAt: null, statusNote: 'Stopped after 5 failed runs in a row. The last one: division by zero' })
    const stopped = (userId: string) => alertsOf(app.db, userId).then((a) => a.filter((x) => x.kind === 'automation-stopped'))
    expect(await stopped(p.creator.user.id)).toEqual([expect.objectContaining({ severity: 'critical', title: 'Automation stopped: New machines', link: `/automations/${id}` })])
    expect(await stopped(p.owner.user.id)).toHaveLength(1)
    expect(await automation(id, p.creator)).toMatchObject({ status: 'failed', nextRunAt: null, consecutiveFailures: 5, lastRunOk: false })
    clock.advance(HOUR)
    await engine.tick()
    expect((await runsOf(app.db, id)).filter((r) => r.trigger === 'schedule')).toHaveLength(5)

    const resumed = await app.api<Automation>('POST', `/api/automations/${id}/resume`, { token: p.creator.token })
    expect(resumed.body).toMatchObject({ status: 'active', consecutiveFailures: 0 })
    expect(resumed.body).not.toHaveProperty('statusNote')
    await app.db.query(`UPDATE ai_automations SET next_run_at = $2 WHERE id = $1`, [id, clock.now().toISOString()])
    await engine.tick()
    expect(await row(id)).toMatchObject({ status: 'active', failures: 1 })
  })

  it('blocks — never fails — while the creator cannot run it, and resumes by itself', async () => {
    const clock = new Clock()
    const engine = engineFor(app, clock)
    const id = await insertAutomation(app.db, { creatorId: p.creator2.user.id, watch: watch(series(1, 1)), nextRunAt: clock.now() })
    const blockedBy = async (reason: string, set: () => Promise<unknown>, unset: () => Promise<unknown>) => {
      await set()
      await engine.tick()
      expect(await row(id), reason).toMatchObject({ blockedReason: reason, failures: 0, retryAt: new Date(clock.at.getTime() + 5 * MINUTE).toISOString() })
      expect(await automation(id), reason).toMatchObject({ status: 'active', blockedReason: reason, nextRunAt: null })
      // Looked at again only later.
      clock.advance(MINUTE)
      await unset()
      await engine.tick()
      clock.advance(4 * MINUTE)
    }
    await blockedBy('no-access', () => grant(app, p.owner, p.creator2, { enabled: false, automations: true }), () => grant(app, p.owner, p.creator2, { automations: true }))
    await blockedBy('no-permission', () => grant(app, p.owner, p.creator2, { automations: false }), () => grant(app, p.owner, p.creator2, { automations: true }))
    await blockedBy(
      'creator-inactive',
      () => app.db.query(`UPDATE users SET is_active = false WHERE id = $1`, [p.creator2.user.id]),
      () => app.db.query(`UPDATE users SET is_active = true WHERE id = $1`, [p.creator2.user.id]),
    )
    const switched = (enabled: boolean) => app.api('PUT', '/api/ai/settings', { token: p.owner.token, body: { enabled, monthlyCapUsd: 50 } })
    await blockedBy('unavailable', () => switched(false), () => switched(true))
    expect(await runsOf(app.db, id)).toEqual([])
    // The reason gone, it runs at the next look.
    clock.advance(MINUTE)
    await engine.tick()
    expect((await runsOf(app.db, id)).map((r) => r.ok)).toEqual([true])
    expect(await row(id)).toMatchObject({ blockedReason: null, retryAt: null, failures: 0 })
    expect(await automation(id)).not.toHaveProperty('blockedReason')
  })

  it('counts a domain taken away as a failure: the query is refused', async () => {
    const clock = new Clock()
    // A watch over the coil register: the materials domain.
    const id = await insertAutomation(app.db, { creatorId: p.creator2.user.id, watch: watch(`SELECT coil_id::text AS machine_code, 'x' AS machine FROM ai.coils`), nextRunAt: clock.now() })
    await engineFor(app, clock).tick()
    expect(await runsOf(app.db, id)).toEqual([expect.objectContaining({ ok: false, error: expect.stringMatching(/cannot read/) })])
    expect(await row(id)).toMatchObject({ failures: 1, blockedReason: null })
  })
})

describe('§21 housekeeping', () => {
  it('removes alerts older than 90 days, once a day', async () => {
    const clock = new Clock()
    const insert = (days: number) =>
      app.db.query(`INSERT INTO user_notifications (user_id, kind, severity, title, created_at) VALUES ($1, 'automation-case', 'info', $2, $3)`, [
        p.plain.user.id,
        `${days} days old`,
        new Date(clock.at.getTime() - days * 24 * HOUR).toISOString(),
      ])
    await insert(91)
    await insert(89)
    await engineFor(app, clock).tick()
    expect((await alertsOf(app.db, p.plain.user.id)).map((a) => a.title)).toEqual(['89 days old'])
  })
})

describe('§21 who is told what, and where it leads', () => {
  const session = '0b8a3a3e-6a3f-4f3e-9c1a-2f6d5e4c3b2a'

  it("leads each person where they may look: the session, else the automation's page for its creator and the owner, else nowhere", async () => {
    const clock = new Clock()
    // Case 1 names a session; case 2 does not.
    const sql = `SELECT g::text AS machine_code, 'Case ' || g AS machine, CASE WHEN g = 1 THEN '${session}' END AS session_id FROM generate_series(1, 2) g ORDER BY g`
    const id = await insertAutomation(app.db, {
      creatorId: p.creator.user.id,
      watch: watch(sql, { sessionColumn: 'session_id' }),
      recipients: [{ kind: 'role', role: 'inspector' }, { kind: 'user', userId: p.plain.user.id }, { kind: 'user', userId: p.owner.user.id }],
      channels: { bell: true, chat: true },
      nextRunAt: clock.now(),
    })
    await engineFor(app, clock).tick()
    // One run's alerts share their moment: compared by title.
    const links = async (userId: string) => (await alertsOf(app.db, userId)).map((a) => [a.title, a.link]).sort((x, y) => String(x[0]).localeCompare(String(y[0])))
    const own = `/automations/${id}`
    const toSession = `/history?session=${session}`
    // The creator and the owner may open the automation's page.
    expect(await links(p.creator.user.id)).toEqual([['New machine Case 1', toSession], ['New machine Case 2', own]])
    expect(await links(p.owner.user.id)).toEqual([['New machine Case 1', toSession], ['New machine Case 2', own]])
    // Anyone else: the session, or no link at all rather than a page that sends them away.
    for (const s of [p.creator2, p.plain]) expect(await links(s.user.id), s.user.name).toEqual([['New machine Case 1', toSession], ['New machine Case 2', null]])
    expect((await systemMessagesTo(app.db, p.creator2.user.id)).slice(-1)).toEqual([`New machines: 2 new cases\n• New machine Case 1 — ${toSession}\n• New machine Case 2`])
    expect((await systemMessagesTo(app.db, p.creator.user.id)).slice(-1)).toEqual([`New machines: 2 new cases\n• New machine Case 1 — ${toSession}\n• New machine Case 2 — ${own}`])
  })

  it('keeps cases that read alike as alerts of their own, and ends a long chat list where the person may see the rest', async () => {
    const clock = new Clock()
    const engine = engineFor(app, clock)
    const alike = await insertAutomation(app.db, { creatorId: p.creator.user.id, watch: watch(series(1, 2), { titleTemplate: 'Same words' }), nextRunAt: clock.now() })
    await engine.tick()
    expect((await alertsOf(app.db, p.plain.user.id)).map((a) => a.title)).toEqual(['Same words', 'Same words'])
    expect((await runsOf(app.db, alike))[0]).toMatchObject({ fired: 2, notified: 2, casesNotified: 2 })

    const many = await insertAutomation(app.db, {
      creatorId: p.creator.user.id,
      watch: watch(series(1, 22)),
      recipients: [{ kind: 'role', role: 'supervisor' }, { kind: 'user', userId: p.creator.user.id }],
      channels: { bell: false, chat: true },
      nextRunAt: clock.now(),
    })
    await engine.tick()
    const last = async (userId: string) => (await systemMessagesTo(app.db, userId)).at(-1)!.split('\n')
    expect(await last(p.plain.user.id)).toHaveLength(22)
    expect((await last(p.plain.user.id))[21]).toBe('…and 2 more.')
    expect((await last(p.creator.user.id))[21]).toBe(`…and 2 more: /automations/${many}`)
  })

  it('tells an assignee once — that the follow-up is theirs — and leads others to it only when they may see it', async () => {
    const clock = new Clock()
    const id = await insertAutomation(app.db, {
      creatorId: p.creator.user.id,
      watch: watch(series(1, 1)),
      recipients: [{ kind: 'role', role: 'inspector' }, { kind: 'role', role: 'supervisor' }, { kind: 'role', role: 'viewer' }],
      actions: { notify: true, followUp: { assignee: { kind: 'user', userId: p.creator2.user.id }, dueHours: 4 } },
      nextRunAt: clock.now(),
    })
    await engineFor(app, clock).tick()
    const fu = (await app.db.query<{ id: string }>(`SELECT id FROM follow_ups WHERE automation_id = $1`, [id])).rows[0].id
    const kinds = async (userId: string) => (await alertsOf(app.db, userId)).map((a) => [a.kind, a.link])
    // The assignee: one alert, the follow-up's, not a second as a new case.
    expect(await kinds(p.creator2.user.id)).toEqual([['follow-up-assigned', `/follow-ups/${fu}`]])
    // The creator and a supervisor may see it; a viewer who is neither may not, and the case names no session.
    expect(await kinds(p.creator.user.id)).toEqual([['automation-case', `/follow-ups/${fu}`]])
    expect(await kinds(p.plain.user.id)).toEqual([['automation-case', `/follow-ups/${fu}`]])
    expect(await kinds(p.viewer.user.id)).toEqual([['automation-case', null]])
    expect((await runsOf(app.db, id))[0]).toMatchObject({ fired: 1, followUps: 1, casesNotified: 1, digest: false })
  })

  it('holds the follow-ups’ alerts to the storm limit too: an assignee of many gets one digest of them', async () => {
    const clock = new Clock()
    const id = await insertAutomation(app.db, {
      creatorId: p.creator.user.id,
      watch: watch(series(1, 25)),
      recipients: [{ kind: 'role', role: 'supervisor' }],
      actions: { notify: true, followUp: { assignee: { kind: 'user', userId: p.creator2.user.id }, dueHours: 4 } },
      nextRunAt: clock.now(),
    })
    await engineFor(app, clock).tick()
    expect((await app.db.query(`SELECT 1 FROM follow_ups WHERE automation_id = $1`, [id])).rowCount).toBe(25)
    const assignee = await alertsOf(app.db, p.creator2.user.id)
    expect(assignee).toEqual([
      expect.objectContaining({ kind: 'follow-up-assigned', title: 'New machines: 25 follow-ups assigned to you', link: `/follow-ups?automationId=${id}` }),
    ])
    expect(assignee[0].body.split('\n')).toHaveLength(21)
    // The supervisors' digest leads to the follow-ups, which they may see.
    expect(await alertsOf(app.db, p.plain.user.id)).toEqual([
      expect.objectContaining({ kind: 'automation-digest', title: 'New machines: 25 new cases', link: `/follow-ups?automationId=${id}` }),
    ])
    expect((await runsOf(app.db, id))[0]).toMatchObject({ fired: 25, followUps: 25, notified: 2, casesNotified: 0, digest: true })
  })

  it("gives a person named by a case only their own cases, in a digest too: never the titles of anyone else's", async () => {
    const clock = new Clock()
    const sql = `SELECT g::text AS machine_code, 'Case of ' || CASE WHEN g = 1 THEN 'Cyril' ELSE 'Cara' END || ' #' || g AS machine,
                        CASE WHEN g = 1 THEN '${p.creator2.user.id}' ELSE '${p.creator.user.id}' END AS person
                   FROM generate_series(1, 25) g ORDER BY g`
    const id = await insertAutomation(app.db, {
      creatorId: p.owner.user.id,
      watch: watch(sql),
      recipients: [{ kind: 'column', column: 'person' }, { kind: 'role', role: 'supervisor' }],
      channels: { bell: true, chat: false },
      nextRunAt: clock.now(),
    })
    await engineFor(app, clock).tick()
    // Cyril's one case is an alert of its own.
    expect(await alertsOf(app.db, p.creator2.user.id)).toEqual([expect.objectContaining({ kind: 'automation-case', title: 'New machine Case of Cyril #1' })])
    // Cara's digest lists hers only.
    const [cara] = await alertsOf(app.db, p.creator.user.id)
    expect(cara).toMatchObject({ kind: 'automation-digest', title: 'New machines: 24 new cases' })
    expect(cara.body).not.toContain('Cyril')
    expect(cara.body.split('\n')[0]).toBe('• New machine Case of Cara #2')
    // The supervisors, named by their role, hear of every case.
    expect(await alertsOf(app.db, p.plain.user.id)).toEqual([expect.objectContaining({ kind: 'automation-digest', title: 'New machines: 25 new cases' })])
    expect((await runsOf(app.db, id))[0]).toMatchObject({ digest: true, casesNotified: 1, notified: 3 })
  })

  it('sets each filled-in value apart, so an order number keeps its order in an Arabic title', async () => {
    const clock = new Clock()
    const sql = `SELECT '1' AS machine_code, 'تشقق لحام' AS defect, '20095-QC1-HYH' AS order_number`
    const id = await insertAutomation(app.db, {
      creatorId: p.creator.user.id,
      name: 'عيوب على الحجز',
      language: 'ar',
      watch: watch(sql, { titleTemplate: 'حجز: {{defect}} — {{order_number}}', bodyTemplate: undefined }),
      recipients: [{ kind: 'user', userId: p.creator.user.id }],
      channels: { bell: true, chat: true },
      nextRunAt: clock.now(),
    })
    await engineFor(app, clock).tick()
    const title = `حجز: ${isolate('تشقق لحام')} — ${isolate('20095-QC1-HYH')}`
    expect((await alertsOf(app.db, p.creator.user.id, true)).map((a) => a.title)).toEqual([title])
    expect((await systemMessagesTo(app.db, p.creator.user.id, true)).slice(-1)).toEqual([`${isolate('عيوب على الحجز')}: 1 new case\n• ${isolate(title)} — /automations/${id}`])
  })

  it('writes the chat of two runs at once in one order, so they never wait on each other in a circle', async () => {
    const [a, b] = [p.plain.user.id, p.creator.user.id]
    await sendSystemMessageBatch(app.db, [{ userId: a, body: 'warm-up' }, { userId: b, body: 'warm-up' }])
    const c1 = await app.db.connect()
    const c2 = await app.db.connect()
    try {
      await c1.query('BEGIN')
      await c2.query('BEGIN')
      // One run tells A by role and B by a column; the other B by name and A by a column: given in opposite orders.
      await sendSystemMessageBatch(c1, [{ userId: a, body: 'W1 everyone' }, { userId: b, body: 'W1 own' }])
      const second = sendSystemMessageBatch(c2, [{ userId: b, body: 'W2 everyone' }, { userId: a, body: 'W2 own' }]).then(
        () => 'ok',
        (e: Error) => `error: ${e.message}`,
      )
      await new Promise((r) => setTimeout(r, 200))
      await c1.query('COMMIT')
      expect(await second).toBe('ok')
      await c2.query('COMMIT')
    } finally {
      await c1.query('ROLLBACK').catch(() => undefined)
      await c2.query('ROLLBACK').catch(() => undefined)
      c1.release()
      c2.release()
    }
    expect((await systemMessagesTo(app.db, a)).slice(-2)).toEqual(['W1 everyone', 'W2 own'])
  })
})

describe('§21 long runs, stopping, and lost work', () => {
  it('never holds the ticks for a long run: a watch due meanwhile runs in the place still free', async () => {
    const clock = new Clock()
    let release!: () => void
    app.model.reply({ content: [text('Summary.')], hold: new Promise<void>((r) => (release = r)) })
    const reportId = await insertAutomation(app.db, { creatorId: p.creator.user.id, schedule: { ...reportDraft().schedule!, summary: true }, nextRunAt: clock.now() })
    const watchId = await insertAutomation(app.db, { creatorId: p.creator.user.id, nextRunAt: new Date(clock.at.getTime() + MINUTE) })
    const engine = engineFor(app, clock)
    const first = engine.tick()
    await until(() => app.model.calls.length === 1)
    // The watch falls due while the report's summary is being written.
    clock.advance(3 * MINUTE)
    await engine.tick()
    expect((await runsOf(app.db, watchId)).map((r) => r.ok)).toEqual([true])
    expect((await runsOf(app.db, reportId)).map((r) => r.ok)).toEqual([null])
    release()
    await first
    expect((await runsOf(app.db, reportId)).map((r) => r.ok)).toEqual([true])
  })

  it('stops for good: takes nothing more, and hands back the run under way, due again at once at the time it stood for', async () => {
    const clock = new Clock()
    app.model.reply({ content: [text('Summary.')], hold: new Promise<void>(() => undefined) })
    const slot = clock.now()
    const reportId = await insertAutomation(app.db, { creatorId: p.creator.user.id, schedule: { ...reportDraft().schedule!, summary: true }, nextRunAt: slot })
    const watchId = await insertAutomation(app.db, { creatorId: p.creator.user.id, nextRunAt: new Date(clock.at.getTime() + MINUTE) })
    const engine = new AutomationEngine(depsFor(app), { now: clock.now, concurrency: 1 })
    const ticking = engine.tick()
    await until(() => app.model.calls.length === 1)
    clock.advance(2 * MINUTE)
    await engine.stop()
    await ticking
    // Nothing went out and nothing is counted; the run left no trace, and its lease is free for another instance.
    expect(await runsOf(app.db, reportId)).toEqual([])
    expect((await app.db.query(`SELECT 1 FROM ai_report_deliveries WHERE automation_id = $1`, [reportId])).rowCount).toBe(0)
    expect(await row(reportId)).toMatchObject({ runningUntil: null, nextRunAt: slot.toISOString(), failures: 0 })
    // The watch that fell due meanwhile was not taken.
    expect(await runsOf(app.db, watchId)).toEqual([])
    // A tick after stopping does nothing.
    await engine.tick()
    expect(await runsOf(app.db, watchId)).toEqual([])
  })

  it('never ticks after stop(), not even the first tick start() set', async () => {
    const clock = new Clock()
    const id = await insertAutomation(app.db, { creatorId: p.creator.user.id, nextRunAt: clock.now() })
    const engine = new AutomationEngine(depsFor(app), { now: clock.now, tickMs: 100 })
    engine.start()
    await engine.stop()
    await new Promise((r) => setTimeout(r, 500))
    expect(await runsOf(app.db, id)).toEqual([])
  })

  it('stops a report whose creator can no longer run it between its sections: nothing goes out, nothing is counted, and it waits', async () => {
    const clock = new Clock()
    const schedule = { ...reportDraft().schedule!, sections: [reportDraft().schedule!.sections[0], { title: 'Again', sql: 'SELECT count(*)::int AS machines FROM ai.machines' }] }
    const id = await insertAutomation(app.db, { creatorId: p.creator.user.id, schedule, nextRunAt: clock.now() })
    // The assistant's readers go down once the first section has its connection.
    let pools = 0
    const readers = {
      get ready() {
        return pools === 0
      },
      poolFor: (domains: Parameters<typeof app.aiReader.poolFor>[0]) => {
        pools++
        return app.aiReader.poolFor(domains)
      },
    }
    await new AutomationEngine({ ...depsFor(app), readers }, { now: clock.now }).tick()
    expect(pools).toBe(1)
    expect(await runsOf(app.db, id)).toEqual([])
    expect((await app.db.query(`SELECT 1 FROM ai_report_deliveries WHERE automation_id = $1`, [id])).rowCount).toBe(0)
    const after = await row(id)
    expect(after).toMatchObject({ blockedReason: 'unavailable', failures: 0, runningUntil: null, nextRunAt: clock.at.toISOString() })
    // Looked at again five minutes after it stopped.
    expect(new Date(after.retryAt!).getTime() - clock.at.getTime()).toBeGreaterThanOrEqual(5 * MINUTE)
    expect(new Date(after.retryAt!).getTime() - clock.at.getTime()).toBeLessThan(5 * MINUTE + 30_000)
  })

  it('escalates in one transaction: a fault part way leaves nobody marked as told, and the next tick tells them all', async () => {
    const clock = new Clock()
    const automationId = await insertAutomation(app.db, { creatorId: p.creator.user.id, nextRunAt: null })
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      const { rows } = await app.db.query<{ id: string }>(
        `INSERT INTO follow_ups (automation_id, automation_name, creator_id, case_key, title, assignee_id, due_at)
         VALUES ($1, 'W', $2, $3, $4, $5, $6) RETURNING id`,
        [automationId, p.creator.user.id, `k${i}`, `Case ${i}`, p.creator2.user.id, new Date(clock.at.getTime() - (3 - i) * HOUR).toISOString()],
      )
      ids.push(rows[0].id)
    }
    // A passing fault on the second alert (a dropped connection, a deadlock…), made by a trigger.
    await app.db.query(`CREATE OR REPLACE FUNCTION test_fail_alert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.follow_up_id = '${ids[1]}' THEN RAISE EXCEPTION 'transient fault'; END IF; RETURN NEW; END $$`)
    await app.db.query(`CREATE TRIGGER test_fail_alert BEFORE INSERT ON user_notifications FOR EACH ROW EXECUTE FUNCTION test_fail_alert()`)
    const engine = engineFor(app, clock)
    try {
      await engine.tick()
      expect((await app.db.query(`SELECT 1 FROM follow_ups WHERE automation_id = $1 AND escalated_at IS NOT NULL`, [automationId])).rowCount).toBe(0)
    } finally {
      await app.db.query(`DROP TRIGGER test_fail_alert ON user_notifications`)
      await app.db.query(`DROP FUNCTION test_fail_alert()`)
    }
    clock.advance(MINUTE)
    await engine.tick()
    const state = await app.db.query<{ escalated: boolean; alerts: number; events: number }>(
      `SELECT f.escalated_at IS NOT NULL AS escalated,
              (SELECT count(*)::int FROM user_notifications n WHERE n.follow_up_id = f.id AND n.kind = 'follow-up-overdue') AS alerts,
              (SELECT count(*)::int FROM follow_up_events e WHERE e.follow_up_id = f.id AND e.kind = 'escalated') AS events
         FROM follow_ups f WHERE f.automation_id = $1 ORDER BY f.case_key`,
      [automationId],
    )
    // Each told once: its assignee and its creator.
    expect(state.rows).toEqual(ids.map(() => ({ escalated: true, alerts: 2, events: 1 })))
  })
})
