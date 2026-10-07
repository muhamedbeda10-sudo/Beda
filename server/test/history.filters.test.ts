// ============================================================================
// §6 — the History filters are answered over the whole record.
//
// The screen used to narrow the page it had already fetched, so a session that
// matched but sat past the first hundred was invisible. These tests fix the
// contract the other way round: the filter goes to SQL, and the session is
// found wherever it sits — with the count of the whole match returned with it.
// ============================================================================

import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import type { HistoryOptionsResponse, HistoryResponse } from '@qc/shared/api'
import type { ProductionOrder } from '@qc/shared/types'
import { TestApp, type Session, factoryDay } from './harness'

const app = new TestApp()
let admin: Session
let one: Session
let two: Session
let beam: ProductionOrder
let panel: ProductionOrder

/** More sessions than a page holds, so an unfiltered page cannot reach the oldest. */
const RECENT = 12
const PAGE = 5
/** The one session that must be found by filter alone: oldest, other machine,
 *  other order, other inspector, other factory. */
let buried: string

const get = (path: string, token: string) => app.api<HistoryResponse>('GET', `/api/sessions/history?limit=${PAGE}&${path}`, { token })

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  admin = await app.register('admin', 'Admin')
  one = await app.register('insp1', 'Hany Fathy')
  two = await app.register('insp2', 'Mostafa Zaki')

  for (const m of [
    { code: '31', name: 'Roll Forming', line: 'LM2', displayName: '31-Roll Forming-LM2', process: 'forming', factory: 'Plant A' },
    { code: 'STAM 24', name: 'Stamping', line: 'LM5', displayName: 'STAM 24-Stamping-LM5', process: 'forming', factory: 'Plant B' },
  ]) {
    await app.api('POST', '/api/master/machines', { token: admin.token, body: m })
  }
  await app.api('POST', '/api/orders/import', {
    token: admin.token,
    body: {
      rows: [
        {
          lineKey: 'H-1',
          orderNumber: '20552-Ph2.3-RHE',
          item: 'XL Light Beam',
          itemCode: '100155TA3',
          workCenterCode: '31',
          requiredQty: 500,
          finishedQty: 0,
          customer: 'Rehab Steel',
          expectedGrade: '',
          drawing: 'D-1',
        },
        {
          lineKey: 'H-2',
          orderNumber: '19868-Ph2.2B-EHF',
          item: 'Deep Shelf Panel',
          itemCode: '200999ZZ',
          workCenterCode: 'STAM 24',
          requiredQty: 80,
          finishedQty: 0,
          customer: 'El Hoda Foods',
          expectedGrade: '',
          drawing: 'D-2',
        },
      ],
    },
  })
  const orders = (await app.api<ProductionOrder[]>('GET', '/api/orders', { token: admin.token })).body
  beam = orders.find((o) => o.orderNumber === '20552-Ph2.3-RHE')!
  panel = orders.find((o) => o.orderNumber === '19868-Ph2.2B-EHF')!

  // The buried one first, an hour back; the recent ones a minute apart after it.
  buried = (await app.api<{ id: string }>('POST', '/api/sessions', { token: two.token, body: { orderId: panel.id, startQty: 0 } })).body.id
  await app.db.query(`UPDATE inspection_sessions SET started_at = now() - interval '60 minutes' WHERE id = $1`, [buried])
  for (let i = 0; i < RECENT; i++) {
    const made = await app.api<{ id: string }>('POST', '/api/sessions', { token: one.token, body: { orderId: beam.id, startQty: i } })
    await app.db.query(`UPDATE inspection_sessions SET started_at = now() - make_interval(mins => $2) WHERE id = $1`, [made.body.id, RECENT - i])
  }
  // One closed session, so the status filter has something to find. Closing
  // through the API needs a recorded sample; the filter under test is a read.
  await app.db.query(`UPDATE inspection_sessions SET status = 'Closed', closed_at = now(), closed_by_id = $2 WHERE order_id = $1 AND seq = 2`, [
    beam.id,
    one.user.id,
  ])
})
afterAll(() => app.stop())

describe('§6 — a filter reaches past the first page', () => {
  it('counts the whole match, not the page', async () => {
    const res = await get('', one.token)
    expect(res.body.sessions).toHaveLength(PAGE)
    expect(res.body.hasMore).toBe(true)
    expect(res.body.totals).toEqual({ sessions: RECENT + 1, open: RECENT })
    // Proof the buried session is out of reach without a filter.
    expect(res.body.sessions.map((s) => s.id)).not.toContain(buried)
  })

  it('finds it by order number', async () => {
    const res = await get('q=19868', one.token)
    expect(res.body.sessions.map((s) => s.id)).toEqual([buried])
    expect(res.body.totals).toEqual({ sessions: 1, open: 1 })
  })

  it('finds it by item, item code and customer', async () => {
    for (const term of ['Deep Shelf', '200999zz', 'el hoda']) {
      const res = await get(`q=${encodeURIComponent(term)}`, one.token)
      expect(res.body.sessions.map((s) => s.id), term).toEqual([buried])
    }
  })

  it('finds it by inspector, by name and by id', async () => {
    expect((await get('q=Mostafa', one.token)).body.sessions.map((s) => s.id)).toEqual([buried])
    expect((await get(`inspectorId=${two.user.id}`, one.token)).body.sessions.map((s) => s.id)).toEqual([buried])
  })

  it('finds it by machine, however the code is spelled', async () => {
    for (const code of ['STAM 24', 'stam24', 'Stam  24']) {
      const res = await get(`workCenterCode=${encodeURIComponent(code)}`, one.token)
      expect(res.body.sessions.map((s) => s.id), code).toEqual([buried])
    }
    // And by the machine's name, typed into the search box.
    expect((await get('q=Stamping', one.token)).body.sessions.map((s) => s.id)).toEqual([buried])
  })

  it('finds it by factory', async () => {
    expect((await get('factory=Plant%20B', one.token)).body.sessions.map((s) => s.id)).toEqual([buried])
    expect((await get('factory=Plant%20A', one.token)).body.totals).toEqual({ sessions: RECENT, open: RECENT - 1 })
  })

  it('narrows by status and by date', async () => {
    const closed = await get('status=Closed', one.token)
    expect(closed.body.totals).toEqual({ sessions: 1, open: 0 })
    expect(closed.body.sessions[0].seq).toBe(2)

    const since = new Date(Date.now() - 30 * 60_000).toISOString()
    const recent = await get(`since=${encodeURIComponent(since)}`, one.token)
    expect(recent.body.totals!.sessions).toBe(RECENT)
    expect(recent.body.sessions.map((s) => s.id)).not.toContain(buried)
  })

  it('filters by any part of an item code or name, case-blind, and offers the items', async () => {
    // The buried session is on the panel (200999ZZ); everything else is the beam (100155TA3).
    const panelOnly = await get('item=200999zz', one.token)
    expect(panelOnly.body.sessions.map((s) => s.id)).toEqual([buried])
    expect((await get('item=shelf', one.token)).body.sessions.map((s) => s.id)).toEqual([buried])
    expect((await get('item=2009', one.token)).body.sessions.map((s) => s.id)).toEqual([buried])
    expect((await get('item=100155TA3', one.token)).body.totals!.sessions).toBe(RECENT)
    expect((await get('item=light%20beam', one.token)).body.totals!.sessions).toBe(RECENT)
    expect((await get('item=nope', one.token)).body.totals!.sessions).toBe(0)
    const options = await app.api<HistoryOptionsResponse>('GET', '/api/sessions/history/options', { token: one.token })
    expect(options.body.items.map((i) => i.itemCode).sort()).toEqual(['100155TA3', '200999ZZ'])
    expect(options.body.items.find((i) => i.itemCode === '200999ZZ')?.item).toBe('Deep Shelf Panel')
  })

  it('finds a session by its number', async () => {
    const res = await get('q=%233', one.token)
    expect(res.body.totals).toEqual({ sessions: 1, open: 1 })
    expect(res.body.sessions[0].seq).toBe(3)
  })

  it('treats a typed wildcard as text, not as a pattern', async () => {
    expect((await get('q=%25', one.token)).body.totals).toEqual({ sessions: 0, open: 0 })
    expect((await get('q=_', one.token)).body.totals).toEqual({ sessions: 0, open: 0 })
  })

  it('keeps the filter while paging back', async () => {
    const seen: string[] = []
    let before: string | undefined
    for (let guard = 0; guard < 10; guard++) {
      const page = (await get(`q=XL%20Light%20Beam${before ? `&before=${encodeURIComponent(before)}` : ''}`, one.token)).body
      seen.push(...page.sessions.map((s) => s.id))
      // The count comes with the first page and is not repeated on the others.
      if (before) expect(page.totals).toBeUndefined()
      else expect(page.totals).toEqual({ sessions: RECENT, open: RECENT - 1 })
      if (!page.hasMore) break
      before = page.sessions[page.sessions.length - 1].startedAt
    }
    expect(new Set(seen).size).toBe(RECENT)
    expect(seen).not.toContain(buried)
  })

  it('offers every inspector and machine in the record, not only the newest page', async () => {
    const res = await app.api<HistoryOptionsResponse>('GET', '/api/sessions/history/options', { token: one.token })
    expect(res.status).toBe(200)
    expect(res.body.inspectors.map((i) => i.name)).toEqual(['Hany Fathy', 'Mostafa Zaki'])
    expect(res.body.workCenterCodes.sort()).toEqual(['31', 'STAM 24'])
  })

  it('lands on a session sampled in the period even when it started before it', async () => {
    const since = new Date(Date.now() - 30 * 60_000).toISOString()
    expect((await get(`since=${encodeURIComponent(since)}`, one.token)).body.sessions.map((s) => s.id)).not.toContain(buried)
    // A sample recorded now on the hour-old session: the dashboard counts it today, so History shows the session today.
    await app.db.query(
      `INSERT INTO inspection_samples (session_id, order_id, index, shift, inspector_id, inspector_name, drawing, sample_qty, submission_id)
       VALUES ($1, $2, 1, 'A', $3, $4, 'D-2', 5, gen_random_uuid())`,
      [buried, panel.id, two.user.id, two.user.name],
    )
    const res = await get(`since=${encodeURIComponent(since)}`, one.token)
    expect(res.body.totals!.sessions).toBe(RECENT + 1)
    // It started an hour ago, so it sorts behind the first page; narrowed to its inspector it is the match.
    const theirs = await get(`since=${encodeURIComponent(since)}&inspectorId=${two.user.id}`, one.token)
    expect(theirs.body.sessions.map((s) => s.id)).toEqual([buried])
  })

  it('finds the sessions of one day, or of a range of days', async () => {
    const day = (offset: number) => {
      return factoryDay(offset)
    }
    // Everything here was started today (some an hour ago), so today alone holds the whole record...
    const today = await get(`from=${day(0)}&to=${day(0)}`, one.token)
    expect(today.status).toBe(200)
    expect(today.body.totals!.sessions).toBe(RECENT + 1)
    // ...a window ending yesterday holds nothing, and a window from yesterday on holds all.
    expect((await get(`from=${day(-30)}&to=${day(-1)}`, one.token)).body.totals!.sessions).toBe(0)
    expect((await get(`from=${day(-1)}`, one.token)).body.totals!.sessions).toBe(RECENT + 1)
    expect((await get(`to=${day(-1)}`, one.token)).body.totals!.sessions).toBe(0)
    // Pushed back to a day last week, the buried session leaves today and is found on its own day.
    await app.db.query(`UPDATE inspection_sessions SET started_at = started_at - interval '7 days' WHERE id = $1`, [buried])
    await app.db.query(`UPDATE inspection_samples SET created_at = created_at - interval '7 days' WHERE session_id = $1`, [buried])
    expect((await get(`from=${day(0)}&to=${day(0)}`, one.token)).body.totals!.sessions).toBe(RECENT)
    const lastWeek = await get(`from=${day(-7)}&to=${day(-7)}`, one.token)
    expect(lastWeek.body.sessions.map((s) => s.id)).toEqual([buried])
    expect((await get(`from=${day(0)}&to=${day(-1)}`, one.token)).status).toBe(400)
    expect((await get('from=2026-1-1', one.token)).status).toBe(400)
  })

  it('refuses a filter it cannot read', async () => {
    expect((await get('status=Sleeping', one.token)).status).toBe(400)
    expect((await get('inspectorId=nobody', one.token)).status).toBe(400)
    expect((await get('since=yesterday', one.token)).status).toBe(400)
  })
})

describe('§6 — Excel’s column filter and sort on History, over the whole record', () => {
  const cf = (filters: object) => `cf=${encodeURIComponent(JSON.stringify(filters))}`
  type Values = { values: { value: string; count: number }[]; truncated: boolean }
  const values = (query: string) => app.api<Values>('GET', `/api/sessions/history/values?${query}`, { token: one.token })

  it('keeps the values ticked in a column and counts the whole match', async () => {
    const res = await get(cf({ machine: { values: ['STAM 24-Stamping-LM5'] } }), one.token)
    expect(res.body.sessions.map((s) => s.id)).toEqual([buried])
    expect(res.body.totals).toEqual({ sessions: 1, open: 1 })
    const closed = await get(cf({ status: { values: ['Closed'] } }), one.token)
    expect(closed.body.totals).toEqual({ sessions: 1, open: 0 })
  })

  it('keeps the rows whose cell contains a text, with the other filters', async () => {
    const res = await get(`factory=Plant%20A&${cf({ customer: { contains: 'rehab' }, seq: { values: ['#3', '#4'] } })}`, one.token)
    expect(res.body.sessions.map((s) => s.seq).sort()).toEqual([3, 4])
  })

  it('sorts by a column and walks the pages by count', async () => {
    const first = await get('sort=seq:asc', one.token)
    // The panel's session is #1 of its own line, as is the beam's first: both lead.
    expect(first.body.sessions.slice(0, 2).map((s) => s.seq)).toEqual([1, 1])
    expect(first.body.hasMore).toBe(true)
    const next = await get('sort=seq:asc&offset=5', one.token)
    expect(next.body.sessions.map((s) => s.seq)).toEqual([5, 6, 7, 8, 9])
    expect(next.body.totals).toBeUndefined()
    const byInspector = await get('sort=inspector:desc', one.token)
    expect(byInspector.body.sessions[0].inspectorName).toBe('Mostafa Zaki')
  })

  it("lists a column's values under the other filters, counted, searched", async () => {
    const inspectors = await values('column=inspector')
    expect(inspectors.status).toBe(200)
    expect(inspectors.body.values).toEqual([
      { value: 'Hany Fathy', count: RECENT },
      { value: 'Mostafa Zaki', count: 1 },
    ])
    const underFactory = await values('column=inspector&factory=Plant%20B')
    expect(underFactory.body.values).toEqual([{ value: 'Mostafa Zaki', count: 1 }])
    const seqs = await values('column=seq&search=1')
    expect(seqs.body.values.map((v) => v.value)).toEqual(['#1', '#10', '#11', '#12'])
  })

  it('refuses a column it does not have', async () => {
    expect((await get(cf({ password: { contains: 'x' } }), one.token)).status).toBe(400)
    expect((await get('sort=password:asc', one.token)).status).toBe(400)
    expect((await values('column=password')).status).toBe(400)
  })
})
