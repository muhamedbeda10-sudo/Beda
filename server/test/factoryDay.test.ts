// ============================================================================
// The factory day: 08:00 → 08:00 in the factory's time zone, everywhere the
// record is counted by day. A night shift is one shift, on the day it
// started: a sample at 02:00 on 1 April belongs to 31 March, and to March.
//
// One night and one morning, around a month's end (Cairo, UTC+2 in March):
//   night   — opened 20:30 on 31 March, samples at 21:00 and 02:00, closed
//             03:00 on 1 April; one inspector who works nights only;
//   morning — opened 09:00 on 1 April, a sample at 09:30; another inspector.
// What must hold: the database's rule and the TypeScript one agree to the
// minute; the dashboard's periods, daily and monthly points, shifts and days
// worked; History's and PDI's day filters and day columns; the assistant's
// day and month columns; its "today", and a report's "yesterday".
// ============================================================================

import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { HistoryResponse, PDIListResponse, PDIWithOrder, SaveSampleRequest, SessionWithOrder } from '@qc/shared/api'
import type { ProductionOrder } from '@qc/shared/types'
import type { KpiOverview } from '@qc/shared/kpi'
import { factoryDay as sharedFactoryDay, factoryDayStart } from '@qc/shared/rules'
import { resolveAiPeriod } from '@qc/shared/ai'
import { contextDay, contextLine, factoryDay as promptFactoryDay } from '../src/ai/prompt'
import { reportPeriodAt } from '../src/automations/validate'
import { TestApp, type Session } from './harness'

const app = new TestApp()
const TZ = 'Africa/Cairo'
let admin: Session
let nights: Session
let mornings: Session
let night: string
let morning: string

function sample(defects: number): SaveSampleRequest {
  return {
    submissionId: randomUUID(),
    drawing: 'BS9059/31',
    sampleQty: 50,
    dimensions: [{ name: 'Width', sequence: 1, nominal: 125, tolPlus: 0.5, tolMinus: 0.5, actual: 125.1, unit: 'mm', source: 'item-order' }],
    defects: Array.from({ length: defects }, () => ({ defectName: 'Bad edge', qty: 1, disposition: 'Repair' as const, notes: '', imageIds: [] })),
    coils: [],
  }
}

/** A session with samples at the moments given (UTC), closed at `closedAt` with a final quantity, all moved to those moments. */
async function recordAt(who: Session, order: ProductionOrder, startedAt: string, samples: { at: string; shift: string; defects: number }[], closedAt: string): Promise<string> {
  const started = await app.api<SessionWithOrder>('POST', '/api/sessions', { token: who.token, body: { orderId: order.id, startQty: 0 } })
  for (const s of samples) {
    const res = await app.api('POST', `/api/sessions/${started.body.id}/samples`, { token: who.token, body: sample(s.defects) })
    if (res.status !== 201) throw new Error(`sample failed ${res.status} ${JSON.stringify(res.body)}`)
  }
  const ids = (await app.db.query<{ id: string }>(`SELECT id FROM inspection_samples WHERE session_id = $1 ORDER BY created_at, id`, [started.body.id])).rows.map((r) => r.id)
  const current = await app.api<SessionWithOrder>('GET', `/api/sessions/${started.body.id}`, { token: who.token })
  const closed = await app.api('POST', `/api/sessions/${started.body.id}/close`, { token: who.token, body: { finalQty: 500, version: current.body.version } })
  if (closed.status !== 200) throw new Error(`close failed ${closed.status} ${JSON.stringify(closed.body)}`)
  await app.db.query(`UPDATE inspection_sessions SET started_at = $2, closed_at = $3 WHERE id = $1`, [started.body.id, startedAt, closedAt])
  for (const [i, s] of samples.entries()) await app.db.query(`UPDATE inspection_samples SET created_at = $2, shift = $3 WHERE id = $1`, [ids[i], s.at, s.shift])
  return started.body.id
}

const overview = async (from: string, to: string) =>
  (await app.api<KpiOverview>('GET', `/api/kpi/overview?from=${from}&to=${to}&prevFrom=2026-02-01&prevTo=2026-02-28`, { token: admin.token })).body

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  admin = await app.register('admin', 'Admin')
  nights = await app.register('nights', 'Karim Nights')
  mornings = await app.register('mornings', 'Sara Mornings')
  await app.api('POST', '/api/master/machines', {
    token: admin.token,
    body: { code: '31', name: 'Roll Forming', line: 'LM2', displayName: '31-Roll Forming-LM2', process: 'forming', factory: 'Factory 1' },
  })
  await app.api('POST', '/api/master/work-center-defects', { token: admin.token, body: { workCenterCode: '31', defectName: 'Bad edge' } })
  await app.api('POST', '/api/orders/import', {
    token: admin.token,
    body: { rows: [{ lineKey: 'N-1', orderNumber: '20095-QC1-HYH', item: 'XL Light Beam', itemCode: '125185TA3', workCenterCode: '31', requiredQty: 5000, finishedQty: 0, customer: 'Beta Storage', drawing: 'BS9059/31' }] },
  })
  const order = (await app.api<ProductionOrder[]>('GET', '/api/orders', { token: admin.token })).body[0]
  // Cairo is UTC+2 in March and early April 2026.
  night = await recordAt(nights, order, '2026-03-31T18:30:00Z', [
    { at: '2026-03-31T19:00:00Z', shift: 'C', defects: 2 }, // 21:00 on the 31st
    { at: '2026-04-01T00:00:00Z', shift: 'C', defects: 3 }, // 02:00 on the 1st
  ], '2026-04-01T01:00:00Z') // 03:00 on the 1st
  morning = await recordAt(mornings, order, '2026-04-01T07:00:00Z', [{ at: '2026-04-01T07:30:00Z', shift: 'A', defects: 0 }], '2026-04-01T09:00:00Z')
})
afterAll(() => app.stop())

describe('the factory day: one definition, in TypeScript and in the database', () => {
  it('agrees minute by minute across nights, month ends and both changes of clocks', async () => {
    // Every 20 minutes over days that hold the summer-time changes (24 April, 29/30 October 2026) and a year's end.
    const starts = ['2026-03-30T00:00:00Z', '2026-04-22T00:00:00Z', '2026-10-28T00:00:00Z', '2026-12-30T00:00:00Z']
    for (const zone of [TZ, 'UTC', 'America/New_York']) {
      for (const start of starts) {
        const { rows } = await app.db.query<{ ms: number; day: string }>(
          `SELECT (extract(epoch FROM t) * 1000)::float8 AS ms, ai.factory_day(t, $2)::text AS day
             FROM generate_series($1::timestamptz, $1::timestamptz + interval '4 days', interval '20 minutes') t`,
          [start, zone],
        )
        expect(rows.length).toBe(4 * 72 + 1)
        for (const r of rows) expect(r.day, `${new Date(r.ms).toISOString()} in ${zone}`).toBe(sharedFactoryDay(new Date(r.ms), zone))
      }
      for (const day of ['2026-03-31', '2026-04-24', '2026-10-29', '2026-10-30', '2026-12-31']) {
        const { rows } = await app.db.query<{ ms: number }>(`SELECT (extract(epoch FROM ai.factory_day_start($1::date, $2)) * 1000)::float8 AS ms`, [day, zone])
        expect(new Date(rows[0].ms).toISOString(), `${day} in ${zone}`).toBe(factoryDayStart(day, zone).toISOString())
      }
    }
  })
})

describe('the dashboard counts factory days', () => {
  it('puts the night shift’s 02:00 sample on the day the shift started', async () => {
    const lastOfMarch = await overview('2026-03-31', '2026-03-31')
    expect(lastOfMarch.current.samples).toBe(2)
    expect(lastOfMarch.current.defectPieces).toBe(5)
    // The night session was closed at 03:00 on the 1st: its production is the 31st's.
    expect(lastOfMarch.current.piecesProduced).toBe(500)
    expect(lastOfMarch.daily.map((d) => [d.day, d.samples, d.piecesProduced])).toEqual([['2026-03-31', 2, 500]])
    expect(lastOfMarch.byShift.map((r) => [r.key, r.samples])).toEqual([['C', 2]])

    const firstOfApril = await overview('2026-04-01', '2026-04-01')
    expect(firstOfApril.current.samples).toBe(1)
    expect(firstOfApril.byShift.map((r) => [r.key, r.samples])).toEqual([['A', 1]])
  })

  it('draws the days and months of a longer period the same way', async () => {
    const spring = await overview('2026-03-01', '2026-04-30')
    expect(spring.daily.map((d) => [d.day, d.samples])).toEqual([
      ['2026-03-31', 2],
      ['2026-04-01', 1],
    ])
    expect(spring.monthly.map((m) => [m.month, m.samples, m.piecesProduced])).toEqual([
      ['2026-03', 2, 500],
      ['2026-04', 1, 500],
    ])
  })

  it('counts one night shift as one day worked', async () => {
    const both = await overview('2026-03-31', '2026-04-01')
    const ranked = [...both.inspectorRanking!.overall.ranked, ...both.inspectorRanking!.overall.unranked]
    expect(ranked.find((r) => r.inspectorId === nights.user.id)?.activeDays).toBe(1)
    expect(ranked.find((r) => r.inspectorId === mornings.user.id)?.activeDays).toBe(1)
  })
})

describe('History and PDI read their days as factory days', () => {
  const history = (q: string) => app.api<HistoryResponse>('GET', `/api/sessions/history?limit=50&${q}`, { token: admin.token })

  it('finds the night session on the day its shift started, not on the next', async () => {
    expect((await history('from=2026-03-31&to=2026-03-31')).body.sessions.map((s) => s.id)).toEqual([night])
    expect((await history('from=2026-04-01&to=2026-04-01')).body.sessions.map((s) => s.id)).toEqual([morning])
  })

  it('writes the factory day in History’s day columns', async () => {
    type Values = { values: { value: string; count: number }[] }
    const values = async (column: string) =>
      (await app.api<Values>('GET', `/api/sessions/history/values?column=${column}`, { token: admin.token })).body.values.map((v) => [v.value, v.count])
    expect(await values('date')).toEqual(expect.arrayContaining([['2026-03-31', 1], ['2026-04-01', 1]]))
    // Closed at 03:00 on the 1st: the 31st.
    expect(await values('closed')).toEqual(expect.arrayContaining([['2026-03-31', 1], ['2026-04-01', 1]]))
  })

  it('filters a PDI recorded at 03:00 onto the day before', async () => {
    const order = (await app.api<ProductionOrder[]>('GET', '/api/orders', { token: admin.token })).body[0]
    const pdi = await app.api<PDIWithOrder>('POST', '/api/pdi', { token: mornings.token, body: { orderIds: [order.id], imageIds: [] } })
    expect(pdi.status).toBe(201)
    await app.db.query(`UPDATE pdi_documents SET created_at = '2026-04-01T01:00:00Z' WHERE id = $1`, [pdi.body.id])
    const list = async (from: string, to: string) => (await app.api<PDIListResponse>('GET', `/api/pdi?from=${from}&to=${to}`, { token: admin.token })).body.total
    expect(await list('2026-03-31', '2026-03-31')).toBe(1)
    expect(await list('2026-04-01', '2026-04-01')).toBe(0)
  })
})

describe('the assistant counts factory days', () => {
  it('gives its day and month columns the factory day', async () => {
    // As the assistant reads them: the session's time zone is the factory's.
    const c = await app.db.connect()
    try {
      await c.query(`SET TIME ZONE 'Africa/Cairo'`)
      const days = await c.query<{ day: string; n: number }>(`SELECT recorded_day::text AS day, count(*)::int AS n FROM ai.inspection_samples GROUP BY 1 ORDER BY 1`)
      expect(days.rows).toEqual([
        { day: '2026-03-31', n: 2 },
        { day: '2026-04-01', n: 1 },
      ])
      const closed = await c.query<{ day: string; month: string }>(`SELECT closed_day::text AS day, closed_month AS month FROM ai.production_sessions WHERE session_id = $1`, [night])
      expect(closed.rows).toEqual([{ day: '2026-03-31', month: '2026-03' }])
      const started = await c.query<{ started: string; closed: string }>(
        `SELECT started_day::text AS started, closed_day::text AS closed FROM ai.inspection_sessions WHERE session_id = $1`,
        [night],
      )
      expect(started.rows).toEqual([{ started: '2026-03-31', closed: '2026-03-31' }])
      const pdi = await c.query<{ day: string }>(`SELECT recorded_day::text AS day FROM ai.pdi_documents`)
      expect(pdi.rows).toEqual([{ day: '2026-03-31' }])
    } finally {
      await c.query('RESET TIME ZONE')
      c.release()
    }
  })

  it('is told the factory day a question is asked on, and reads it back', () => {
    const atTwo = new Date('2026-04-01T00:00:00Z') // 02:00 on the 1st
    expect(promptFactoryDay(atTwo, TZ)).toBe('2026-03-31')
    expect(contextLine(atTwo, TZ)).toBe('<context>Today: 2026-04-01 02:00 (Africa/Cairo), factory day 2026-03-31</context>')
    expect(contextDay(contextLine(atTwo, TZ))).toBe('2026-03-31')
    expect(contextDay(contextLine(new Date('2026-04-01T06:30:00Z'), TZ))).toBe('2026-04-01')
    // A line from before the factory day was named on it: its clock says which day.
    expect(contextDay('<context>Today: 2026-04-01 02:00 (Africa/Cairo)</context>')).toBe('2026-03-31')
    expect(contextDay('<context>Today: 2026-04-01 09:30 (Africa/Cairo)</context>')).toBe('2026-04-01')
    expect(contextDay('<context>Today: 2026-04-01</context>')).toBeNull()
  })

  it('runs a report’s "yesterday" over 08:00 yesterday to 08:00 today', async () => {
    const yesterday = { period: { kind: 'yesterday' as const } }
    // At 07:00 on 2 April the factory day is still the 1st: yesterday is the 31st, the night shift included.
    expect(reportPeriodAt(yesterday, new Date('2026-04-02T05:00:00Z'), TZ)).toMatchObject({ from: '2026-03-31', to: '2026-03-31' })
    expect(reportPeriodAt(yesterday, new Date('2026-04-02T06:30:00Z'), TZ)).toMatchObject({ from: '2026-04-01', to: '2026-04-01' })
    expect(resolveAiPeriod({ kind: 'this_month' }, promptFactoryDay(new Date('2026-04-01T05:00:00Z'), TZ))).toEqual({ from: '2026-03-01', to: '2026-03-31' })
    // The period bounds a timestamp at 08:00 on its days, as the reports are told to write it.
    const { rows } = await app.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM inspection_samples
        WHERE deleted_at IS NULL AND created_at >= ai.factory_day_start(DATE '2026-03-31', $1) AND created_at < ai.factory_day_start(DATE '2026-03-31' + 1, $1)`,
      [TZ],
    )
    expect(rows[0].n).toBe(2)
  })
})
