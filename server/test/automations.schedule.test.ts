import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest'
import { describeSchedule, type AutomationScheduleSpec } from '@qc/shared/automation'
import { factoryDayStart, nextReportRun, nextWatchRun, previousReportRun, reportRunsBetween, zonedInstant } from '../src/automations/schedule'
import { MISSED_NOTE, claimDue, missedNote } from '../src/automations/engine'
import { TestApp } from './harness'
import { Clock, depsFor, engineFor, insertAutomation, reportDraft, runsOf, setUp, HOUR, MINUTE, type People } from './automationsKit'

// §21 — when automations run. A scheduled report runs at a factory-time hour
// (daily, on chosen weekdays, weekly, or on a day of the month 1–28), turned
// into an instant through the zone's own rules: a time that happens twice
// runs once, at the first; a time that never happens runs as the clocks jump.
// A report whose time passed while the app was down runs late if less than
// six hours late — the latest of its times, over the days of that time — and
// is recorded as missed otherwise; a run lost with its instance runs again.

type Timing = Pick<AutomationScheduleSpec, 'cadence' | 'time' | 'weekdays' | 'weekday' | 'monthDay'>

const next = (s: Timing, after: string, zone = 'Africa/Cairo') => nextReportRun(s, new Date(after), zone).toISOString()

/** The next n runs after a moment. */
function runs(s: Timing, after: string, n: number, zone = 'Africa/Cairo'): string[] {
  const out: string[] = []
  let at = new Date(after)
  for (let i = 0; i < n; i++) {
    at = nextReportRun(s, at, zone)
    out.push(at.toISOString())
  }
  return out
}

describe('§21 the next run of a scheduled report', () => {
  it('runs daily at the factory time, strictly after the moment given (Africa/Cairo)', () => {
    // October: Cairo is on summer time (UTC+3) until the last Thursday of the month.
    expect(next({ cadence: 'daily', time: '08:00' }, '2026-10-10T04:59:00Z')).toBe('2026-10-10T05:00:00.000Z')
    expect(next({ cadence: 'daily', time: '08:00' }, '2026-10-10T05:00:00Z')).toBe('2026-10-11T05:00:00.000Z')
    // Late evening in Cairo is still the same factory day, though UTC is a day ahead.
    expect(next({ cadence: 'daily', time: '23:30' }, '2026-10-10T20:00:00Z')).toBe('2026-10-10T20:30:00.000Z')
    expect(next({ cadence: 'daily', time: '00:15' }, '2026-10-10T21:00:00Z')).toBe('2026-10-10T21:15:00.000Z')
  })

  it('runs only on the weekdays chosen, Saturday to Thursday wrapping past the week end', () => {
    // 2026-10-09 is a Friday.
    const satToThu: Timing = { cadence: 'daily', time: '07:30', weekdays: [6, 0, 1, 2, 3, 4] }
    expect(runs(satToThu, '2026-10-08T05:00:00Z', 3)).toEqual(['2026-10-10T04:30:00.000Z', '2026-10-11T04:30:00.000Z', '2026-10-12T04:30:00.000Z'])
    expect(describeSchedule(satToThu)).toBe('Saturday to Thursday at 07:30')
    expect(runs({ cadence: 'daily', time: '07:30', weekdays: [1, 3] }, '2026-10-10T00:00:00Z', 3)).toEqual([
      '2026-10-12T04:30:00.000Z',
      '2026-10-14T04:30:00.000Z',
      '2026-10-19T04:30:00.000Z',
    ])
    expect(runs({ cadence: 'weekly', time: '09:00', weekday: 0 }, '2026-10-10T00:00:00Z', 2)).toEqual(['2026-10-11T06:00:00.000Z', '2026-10-18T06:00:00.000Z'])
  })

  it('runs monthly on its day, 1 to 28, through short months and leap years', () => {
    expect(runs({ cadence: 'monthly', time: '08:00', monthDay: 28 }, '2026-01-28T07:00:00Z', 3)).toEqual([
      '2026-02-28T06:00:00.000Z',
      '2026-03-28T06:00:00.000Z',
      '2026-04-28T05:00:00.000Z',
    ])
    expect(runs({ cadence: 'monthly', time: '06:00', monthDay: 1 }, '2027-12-15T00:00:00Z', 3)).toEqual([
      '2028-01-01T04:00:00.000Z',
      '2028-02-01T04:00:00.000Z',
      '2028-03-01T04:00:00.000Z',
    ])
    expect(next({ cadence: 'monthly', time: '08:00', monthDay: 28 }, '2028-02-27T12:00:00Z')).toBe('2028-02-28T06:00:00.000Z')
  })

  it("follows a zone's clock changes: a time that happens twice runs once, one that never happens runs as the clocks jump (Europe/Berlin)", () => {
    const berlin = 'Europe/Berlin'
    // 29 March 2026: 02:00 becomes 03:00. 02:30 does not exist that night: it runs at 03:30, the gap later.
    expect(runs({ cadence: 'daily', time: '02:30' }, '2026-03-28T00:00:00Z', 3, berlin)).toEqual([
      '2026-03-28T01:30:00.000Z',
      '2026-03-29T01:30:00.000Z',
      '2026-03-30T00:30:00.000Z',
    ])
    expect(zonedInstant(Date.UTC(2026, 2, 29, 2, 30), berlin).toISOString()).toBe('2026-03-29T01:30:00.000Z')
    // 25 October 2026: 03:00 goes back to 02:00. 02:30 happens twice: it runs once, at the first.
    expect(runs({ cadence: 'daily', time: '02:30' }, '2026-10-24T00:00:00Z', 3, berlin)).toEqual([
      '2026-10-24T00:30:00.000Z',
      '2026-10-25T00:30:00.000Z',
      '2026-10-26T01:30:00.000Z',
    ])
    // Times away from the change keep their wall-clock hour on both sides of it.
    expect(runs({ cadence: 'daily', time: '08:00' }, '2026-03-28T00:00:00Z', 2, berlin)).toEqual(['2026-03-28T07:00:00.000Z', '2026-03-29T06:00:00.000Z'])
  })

  it("follows Cairo's own clock change at midnight, and starts the factory day where its clock does", () => {
    // 24 April 2026 (a Friday): 00:00 becomes 01:00 in Cairo.
    expect(runs({ cadence: 'daily', time: '00:30' }, '2026-04-22T12:00:00Z', 3)).toEqual([
      '2026-04-22T22:30:00.000Z',
      // 00:30 does not exist that night: it runs at 01:30, the hour later.
      '2026-04-23T22:30:00.000Z',
      '2026-04-24T21:30:00.000Z',
    ])
    expect(factoryDayStart(new Date('2026-04-24T05:00:00Z'), 'Africa/Cairo').toISOString()).toBe('2026-04-23T22:00:00.000Z')
    expect(factoryDayStart(new Date('2026-10-10T22:30:00Z'), 'Africa/Cairo').toISOString()).toBe('2026-10-10T21:00:00.000Z')
  })

  it('finds the last time a report was due at or before a moment, consistent with the next, across clock changes', () => {
    const timings: Timing[] = [
      { cadence: 'daily', time: '02:30' },
      { cadence: 'daily', time: '00:30' },
      { cadence: 'daily', time: '08:00', weekdays: [6, 0, 1, 2, 3, 4] },
      { cadence: 'weekly', time: '23:30', weekday: 0 },
      { cadence: 'monthly', time: '01:00', monthDay: 28 },
    ]
    // Around each zone's changes of 2026, a moment every 37 minutes for four days.
    const windows: [string, string][] = [
      ['Europe/Berlin', '2026-03-27T00:00:00Z'],
      ['Europe/Berlin', '2026-10-23T00:00:00Z'],
      ['America/New_York', '2026-03-06T00:00:00Z'],
      ['America/New_York', '2026-10-30T00:00:00Z'],
      ['Africa/Cairo', '2026-04-22T00:00:00Z'],
      ['Africa/Cairo', '2026-10-28T00:00:00Z'],
    ]
    for (const [zone, from] of windows) {
      for (const s of timings) {
        for (let t = Date.parse(from); t < Date.parse(from) + 4 * 24 * HOUR; t += 37 * MINUTE) {
          const at = new Date(t)
          const before = previousReportRun(s, at, zone)!
          const after = nextReportRun(s, at, zone)
          expect(before.getTime(), `${zone} ${JSON.stringify(s)} ${at.toISOString()}`).toBeLessThanOrEqual(t)
          expect(after.getTime()).toBeGreaterThan(t)
          // Nothing due in between: the next after the last one is the next after the moment.
          expect(nextReportRun(s, before, zone).toISOString()).toBe(after.toISOString())
        }
      }
    }
    // Exactly at its time, that time is the last.
    expect(previousReportRun({ cadence: 'daily', time: '08:00' }, new Date('2026-10-10T05:00:00Z'), 'Africa/Cairo')?.toISOString()).toBe('2026-10-10T05:00:00.000Z')
    // Counted from one time (included) to another (not included).
    expect(reportRunsBetween({ cadence: 'daily', time: '08:00' }, new Date('2026-10-10T05:00:00Z'), new Date('2026-10-12T05:00:00Z'), 'Africa/Cairo')).toBe(2)
    expect(reportRunsBetween({ cadence: 'weekly', time: '08:00', weekday: 1 }, new Date('2026-10-10T05:00:00Z'), new Date('2026-10-12T05:00:00Z'), 'Africa/Cairo')).toBe(0)
  })

  it('runs a watch its interval after the run that started', () => {
    expect(nextWatchRun(5, new Date('2026-10-10T10:00:00Z')).toISOString()).toBe('2026-10-10T10:05:00.000Z')
    expect(nextWatchRun(1440, new Date('2026-10-10T10:00:00Z')).toISOString()).toBe('2026-10-11T10:00:00.000Z')
  })
})

describe('§21 a report whose time passed while the app was down', () => {
  const app = new TestApp()
  let p: People

  beforeAll(async () => {
    await app.start()
    p = await setUp(app)
  })
  afterAll(() => app.stop())
  beforeEach(async () => {
    await app.db.query(`UPDATE ai_automations SET deleted_at = now(), next_run_at = NULL WHERE deleted_at IS NULL`)
  })

  const schedule = { ...reportDraft().schedule!, time: '08:00' }

  it('runs once, late, when less than six hours late', async () => {
    // Due at 08:00 Cairo (05:00 UTC); the app comes back at 13:30 Cairo.
    const clock = new Clock(new Date('2026-10-10T10:30:00Z'))
    const id = await insertAutomation(app.db, { creatorId: p.creator.user.id, schedule, nextRunAt: new Date('2026-10-10T05:00:00Z') })
    const engine = engineFor(app, clock)
    await engine.tick()
    expect((await runsOf(app.db, id)).map((r) => [r.ok, r.note === null, r.deliveryId !== null])).toEqual([[true, true, true]])
    const nextRun = (await app.db.query<{ at: string }>(`SELECT next_run_at AS at FROM ai_automations WHERE id = $1`, [id])).rows[0].at
    expect(nextRun).toBe('2026-10-11T05:00:00.000Z')
    await engine.tick()
    expect(await runsOf(app.db, id)).toHaveLength(1)
  })

  it('records a run missed by six hours or more and schedules the next, once however many were missed', async () => {
    // Down from before Saturday 08:00 until Monday 14:00 Cairo: Monday's 08:00 is six hours late too.
    const clock = new Clock(new Date('2026-10-12T11:00:00Z'))
    const id = await insertAutomation(app.db, { creatorId: p.creator.user.id, schedule, nextRunAt: new Date('2026-10-10T05:00:00Z') })
    const engine = engineFor(app, clock)
    await engine.tick()
    expect(await runsOf(app.db, id)).toEqual([
      expect.objectContaining({ trigger: 'schedule', ok: false, error: null, note: missedNote(3, false), deliveryId: null, startedAt: '2026-10-10T05:00:00.000Z' }),
    ])
    expect(missedNote(3, false)).toBe('Missed 3 runs: the server was not running at their times, so they were skipped.')
    expect((await app.db.query(`SELECT 1 FROM ai_report_deliveries WHERE automation_id = $1`, [id])).rowCount).toBe(0)
    const nextRun = (await app.db.query<{ at: string; failures: number }>(`SELECT next_run_at AS at, consecutive_failures AS failures FROM ai_automations WHERE id = $1`, [id])).rows[0]
    expect(nextRun).toEqual({ at: '2026-10-13T05:00:00.000Z', failures: 0 })
    // At its next time it runs as ever.
    clock.at = new Date('2026-10-13T05:00:30Z')
    await engine.tick()
    expect((await runsOf(app.db, id)).map((r) => r.ok)).toEqual([false, true])
  })

  it('after more than a day down, runs its latest time late and records the earlier ones as missed', async () => {
    // Down from Monday 07:00 until Tuesday 09:00 Cairo: Monday's 08:00 was missed, Tuesday's is an hour late.
    const clock = new Clock(new Date('2026-10-13T06:00:00Z'))
    const id = await insertAutomation(app.db, { creatorId: p.creator.user.id, schedule: { ...schedule, period: { kind: 'today' } }, nextRunAt: new Date('2026-10-12T05:00:00Z') })
    await engineFor(app, clock).tick()
    const runs = await runsOf(app.db, id)
    expect(runs.map((r) => [r.startedAt, r.ok, r.note, r.deliveryId !== null])).toEqual([
      ['2026-10-12T05:00:00.000Z', false, MISSED_NOTE, false],
      [clock.at.toISOString(), true, null, true],
    ])
    const delivered = await app.db.query<{ period: { from: string } }>(`SELECT period FROM ai_report_deliveries WHERE automation_id = $1`, [id])
    expect(delivered.rows.map((r) => r.period.from)).toEqual(['2026-10-13'])
    expect((await app.db.query<{ at: string }>(`SELECT next_run_at AS at FROM ai_automations WHERE id = $1`, [id])).rows[0].at).toBe('2026-10-14T05:00:00.000Z')
  })

  it('says a time passed while its creator could not run it was missed for that reason, not the server', async () => {
    const clock = new Clock(new Date('2026-10-10T12:00:00Z'))
    const id = await insertAutomation(app.db, { creatorId: p.creator.user.id, schedule, nextRunAt: new Date('2026-10-10T05:00:00Z') })
    // Blocked when it fell due; the reason is gone now, seven hours later.
    await app.db.query(`UPDATE ai_automations SET blocked_reason = 'no-access', retry_at = $2 WHERE id = $1`, [id, new Date(clock.at.getTime() - MINUTE).toISOString()])
    await engineFor(app, clock).tick()
    expect((await runsOf(app.db, id)).map((r) => r.note)).toEqual(['Missed: its creator could not run it at its time, so this run was skipped.'])
    expect(missedNote(1, true)).toBe('Missed: its creator could not run it at its time, so this run was skipped.')
  })

  it('covers the days of the time it was due, however late it runs: an end-of-day report run after midnight covers its own day', async () => {
    // Daily at 23:30 Cairo (20:30 UTC in October) over "today"; the app was restarting and runs it at 00:10 Cairo.
    const id = await insertAutomation(app.db, {
      creatorId: p.creator.user.id,
      schedule: { ...schedule, time: '23:30', period: { kind: 'today' } },
      nextRunAt: new Date('2026-10-10T20:30:00Z'),
    })
    await engineFor(app, new Clock(new Date('2026-10-10T21:10:00Z'))).tick()
    const { rows } = await app.db.query<{ period: { from: string; to: string }; ranAt: string }>(`SELECT period, ran_at AS "ranAt" FROM ai_report_deliveries WHERE automation_id = $1`, [id])
    expect(rows).toEqual([{ period: expect.objectContaining({ from: '2026-10-10', to: '2026-10-10' }), ranAt: '2026-10-10T21:10:00.000Z' }])
  })

  it('runs again, once, a report lost with its instance before it was delivered — over the days of its time', async () => {
    const clock = new Clock(new Date('2026-10-10T05:00:10Z'))
    const id = await insertAutomation(app.db, { creatorId: p.creator.user.id, schedule: { ...schedule, period: { kind: 'today' } }, nextRunAt: new Date('2026-10-10T05:00:00Z') })
    // An instance takes it, then dies before finishing.
    expect((await claimDue(depsFor(app), clock.now()))?.kind).toBe('run')
    const engine = engineFor(app, clock)
    // While its lease holds, nothing happens.
    clock.advance(5 * MINUTE)
    await engine.tick()
    expect((await runsOf(app.db, id)).map((r) => r.ok)).toEqual([null])
    // The lease out: the lost run is closed, and the report runs late for its time.
    clock.advance(6 * MINUTE)
    await engine.tick()
    expect((await runsOf(app.db, id)).map((r) => [r.ok, r.error, r.deliveryId !== null])).toEqual([
      [false, 'Interrupted: the server stopped during this run.', false],
      [true, null, true],
    ])
    const { rows } = await app.db.query<{ period: { from: string } }>(`SELECT period FROM ai_report_deliveries WHERE automation_id = $1`, [id])
    expect(rows.map((r) => r.period.from)).toEqual(['2026-10-10'])
    expect((await app.db.query<{ at: string; until: string | null }>(`SELECT next_run_at AS at, running_until AS until FROM ai_automations WHERE id = $1`, [id])).rows[0]).toEqual({
      at: '2026-10-11T05:00:00.000Z',
      until: null,
    })
    // Once: the next ticks find nothing more to do.
    clock.advance(MINUTE)
    await engine.tick()
    expect(await runsOf(app.db, id)).toHaveLength(2)
  })

  it('never runs again a report lost just after it was delivered: its run is closed as the success it was', async () => {
    const clock = new Clock(new Date('2026-10-10T05:00:10Z'))
    const id = await insertAutomation(app.db, { creatorId: p.creator.user.id, schedule, nextRunAt: new Date('2026-10-10T05:00:00Z') })
    const claim = await claimDue(depsFor(app), clock.now())
    if (claim?.kind !== 'run') throw new Error('not claimed')
    // Delivered; the instance died before recording the run.
    const delivery = await app.db.query<{ id: string }>(
      `INSERT INTO ai_report_deliveries (automation_id, run_id, automation_name, language, ran_at, sections) VALUES ($1, $2, 'Machine register', 'en', $3, '[]') RETURNING id`,
      [id, claim.claimed.runId, clock.now().toISOString()],
    )
    clock.advance(11 * MINUTE)
    await engineFor(app, clock).tick()
    expect(await runsOf(app.db, id)).toEqual([
      expect.objectContaining({ ok: true, error: null, deliveryId: delivery.rows[0].id, note: expect.stringContaining('delivered its report') }),
    ])
    expect((await app.db.query(`SELECT 1 FROM ai_report_deliveries WHERE automation_id = $1`, [id])).rowCount).toBe(1)
  })

  it('runs a watch at the next tick, however late', async () => {
    const clock = new Clock(new Date('2026-10-12T11:00:00Z'))
    const id = await insertAutomation(app.db, { creatorId: p.creator.user.id, nextRunAt: new Date(clock.at.getTime() - 30 * HOUR) })
    await engineFor(app, clock).tick()
    expect((await runsOf(app.db, id)).map((r) => r.ok)).toEqual([true])
    const nextRun = (await app.db.query<{ at: string }>(`SELECT next_run_at AS at FROM ai_automations WHERE id = $1`, [id])).rows[0].at
    expect(nextRun).toBe(new Date(clock.at.getTime() + 5 * MINUTE).toISOString())
  })
})
