import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import type { HistoryResponse } from '@qc/shared/api'
import type { ProductionOrder } from '@qc/shared/types'
import { TestApp, type Session } from './harness'

const app = new TestApp()
let admin: Session
let inspector: Session
let order: ProductionOrder

/** More sessions than a page holds, so the oldest falls past the first page. */
const TOTAL = 12
const PAGE = 5

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  admin = await app.register('admin', 'Admin')
  inspector = await app.register('insp', 'Inspector One')
  await app.api('POST', '/api/master/machines', {
    token: admin.token,
    body: { code: '31', name: 'Roll Forming', line: 'LM2', displayName: '31-Roll Forming-LM2', process: 'forming' },
  })
  await app.api('POST', '/api/orders/import', {
    token: admin.token,
    body: {
      rows: [
        { lineKey: 'H-1', orderNumber: '20552-Ph2.3-RHE', item: 'XL Light Beam', itemCode: '100155TA3', workCenterCode: '31', requiredQty: 500, finishedQty: 0, customer: 'RHE', expectedGrade: '', drawing: 'D-1' },
      ],
    },
  })
  order = (await app.api<ProductionOrder[]>('GET', '/api/orders', { token: admin.token })).body[0]

  // Sessions a minute apart, oldest first, so their order is certain.
  for (let i = 0; i < TOTAL; i++) {
    const created = await app.api<{ id: string }>('POST', '/api/sessions', { token: inspector.token, body: { orderId: order.id, startQty: i } })
    await app.db.query(`UPDATE inspection_sessions SET started_at = now() - make_interval(mins => $2) WHERE id = $1`, [created.body.id, TOTAL - i])
  }
})
afterAll(() => app.stop())

describe('§6 — history pages back to the oldest session', () => {
  it('answers a page and says older sessions remain', async () => {
    const first = await app.api<HistoryResponse>('GET', `/api/sessions/history?limit=${PAGE}`, { token: inspector.token })
    expect(first.status).toBe(200)
    expect(first.body.sessions).toHaveLength(PAGE)
    expect(first.body.hasMore).toBe(true)
    // Newest first: the last session started is the first one listed.
    expect(first.body.sessions[0].startQtyConfirmed?.qty).toBe(TOTAL - 1)
  })

  it('reaches every session by walking back with `before`', async () => {
    const seen: string[] = []
    let before: string | undefined
    let guard = 0
    for (;;) {
      const page: HistoryResponse = (
        await app.api<HistoryResponse>('GET', `/api/sessions/history?limit=${PAGE}${before ? `&before=${encodeURIComponent(before)}` : ''}`, { token: inspector.token })
      ).body
      seen.push(...page.sessions.map((s) => s.id))
      if (!page.hasMore || guard++ > 10) break
      before = page.sessions[page.sessions.length - 1].startedAt
    }
    expect(new Set(seen).size).toBe(TOTAL)
    // The oldest session is out of reach of the first page, and reached by paging.
    const firstPage = (await app.api<HistoryResponse>('GET', `/api/sessions/history?limit=${PAGE}`, { token: inspector.token })).body
    const oldest = seen[seen.length - 1]
    expect(firstPage.sessions.map((s) => s.id)).not.toContain(oldest)
    expect(seen).toContain(oldest)
  })

  it('pages the Hold list the same way', async () => {
    const res = await app.api<HistoryResponse>('GET', '/api/sessions/history?disposition=Hold', { token: inspector.token })
    expect(res.status).toBe(200)
    // No defect was recorded, so nothing is on Hold and nothing is left to fetch.
    expect(res.body.sessions).toEqual([])
    expect(res.body.hasMore).toBe(false)
  })

  it('refuses a cursor that is not an instant', async () => {
    expect((await app.api('GET', '/api/sessions/history?before=yesterday', { token: inspector.token })).status).toBe(400)
  })
})
