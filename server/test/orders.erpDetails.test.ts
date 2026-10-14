// ============================================================================
// §7.7.1 — the ERP details of an order line: the import writes them (an
// empty cell clears one, a column not carried leaves it), the Access list
// shows, filters and sorts them, the Access sync reads them as the file
// importer does, and the assistant reads them in ai.order_lines.
// ============================================================================

import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import type { CreateIntegrationKeyResponse, OrderListResponse, OrderListRow, OrderSyncStartResponse } from '@qc/shared/api'
import type { AiCell } from '@qc/shared/ai'
import { TestApp, type Session } from './harness'
import { runReadOnlyQuery } from '../src/ai/runQuery'

const app = new TestApp()
let admin: Session

const importRows = (rows: Record<string, unknown>[]) => app.api<{ inserted: number; updated: number; error?: string }>('POST', '/api/orders/import', { token: admin.token, body: { rows } })
const list = (query: string) => app.api<OrderListResponse>('GET', `/api/orders/list?${query}`, { token: admin.token })
async function line(lineKey: string): Promise<OrderListRow> {
  const res = await list(`q=${encodeURIComponent(lineKey)}`)
  expect(res.status).toBe(200)
  const found = res.body.orders.find((o) => o.lineKey === lineKey)
  expect(found, lineKey).toBeDefined()
  return found!
}
async function read(sql: string): Promise<AiCell[][]> {
  const res = await runReadOnlyQuery(app.aiReader.pool, sql, { maxRows: 1000, timeoutMs: 10_000, timeZone: app.config.FACTORY_TIMEZONE })
  if (!res.ok) throw new Error(`${res.error}\n${sql}`)
  return res.rows
}

/** A line as the file importer sends it from the ERP's Tasks query: core fields, then the details. */
const tasksRow = (lineKey: string, extra: Record<string, unknown> = {}) => ({
  lineKey,
  orderNumber: '19145-Ph1.23-EHF-(Rail)',
  item: 'Shuttle Rail : 215-SQ : 2550 : 25',
  itemCode: 'SH.RA.',
  workCenterCode: '19',
  requiredQty: 24,
  finishedQty: 24,
  customer: 'حسن علام',
  erpStatus: 'Active',
  dueDate: '2026-02-25',
  refinedDate: '2026-06-30',
  planningWeek: '01/2026',
  erpRemainingQty: 0,
  acceptedQty: 24,
  lengthMm: 2550,
  widthMm: 349,
  thicknessMm: 2.5,
  weightKg: 419.17,
  parentId: '0015-19145-Ph1.23-EHF-FP00',
  partDurationHours: 0.13,
  totalAreaM2: 42.72,
  itemTranslation: 'شاتيل ريل',
  totalHoldQty: -8,
  plannedStart: '2026-04-06',
  plannedFinish: '2026-04-06',
  shippingStatus: 'Shipped',
  delayReasonCode: 14,
  delayComment: 'PR',
  statusReason: 'Customer Request - 30-6-2026',
  ...extra,
})

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  admin = await app.register('admin', 'Admin')
})
afterAll(() => app.stop())

describe('§7.7.1 — the ERP details of an order line', () => {
  it('imports them with the line, and the Access list returns each as it was written: days as days, figures as figures', async () => {
    const res = await importRows([tasksRow('462484'), tasksRow('462494', { planningWeek: '52/2025', dueDate: '2025-12-28' })])
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ inserted: 2, updated: 0, unchanged: 0 })
    const o = await line('462484')
    expect(o).toMatchObject({
      dueDate: '2026-02-25', refinedDate: '2026-06-30', planningWeek: '01/2026', erpRemainingQty: 0, acceptedQty: 24,
      lengthMm: 2550, widthMm: 349, thicknessMm: 2.5, weightKg: 419.17, parentId: '0015-19145-Ph1.23-EHF-FP00', partDurationHours: 0.13,
      totalAreaM2: 42.72, itemTranslation: 'شاتيل ريل', totalHoldQty: -8, plannedStart: '2026-04-06', plannedFinish: '2026-04-06',
      shippingStatus: 'Shipped', delayReasonCode: 14, delayComment: 'PR', statusReason: 'Customer Request - 30-6-2026',
    })
    // A detail the ERP gave no value is absent, not an empty string or a zero.
    expect(o.stage).toBeUndefined()
    expect(o.cancelledQty).toBeUndefined()
  })

  it('updates an existing line: a detail sent as null is cleared, one not sent stays, and an empty core field never clears', async () => {
    const res = await importRows([
      {
        lineKey: '462484',
        finishedQty: 20,
        dueDate: '2026-03-10',
        delayComment: null,
        plannedFinish: null,
        weightKg: null,
        stage: 'S2',
      },
    ])
    expect(res.body).toEqual({ inserted: 0, updated: 1, unchanged: 0 })
    const o = await line('462484')
    expect(o).toMatchObject({ finishedQty: 20, dueDate: '2026-03-10', stage: 'S2', plannedStart: '2026-04-06', delayReasonCode: 14, orderNumber: '19145-Ph1.23-EHF-(Rail)', customer: 'حسن علام' })
    expect(o.delayComment).toBeUndefined()
    expect(o.plannedFinish).toBeUndefined()
    expect(o.weightKg).toBeUndefined()
  })

  it('treats an empty detail text as cleared and refuses a detail it cannot read', async () => {
    expect((await importRows([{ lineKey: '462494', statusReason: '   ' }])).status).toBe(200)
    expect((await line('462494')).statusReason).toBeUndefined()
    expect((await importRows([{ lineKey: '462494', dueDate: '2026-02-30' }])).status).toBe(400)
    expect((await importRows([{ lineKey: '462494', delayReasonCode: 2.5 }])).status).toBe(400)
    expect((await importRows([{ lineKey: '462494', weightKg: '12kg' }])).status).toBe(400)
    // Nothing of a refused batch is written.
    expect((await line('462494')).dueDate).toBe('2025-12-28')
  })

  it('filters and sorts the Access list on a detail, the planning week by year then week', async () => {
    await importRows([tasksRow('462500', { planningWeek: '3/2026', dueDate: '2026-02-25' })])
    const byDue = await list(`cf=${encodeURIComponent(JSON.stringify({ dueDate: { values: ['2026-02-25'] } }))}`)
    expect(byDue.status).toBe(200)
    expect(byDue.body.orders.map((o) => o.lineKey)).toEqual(['462500'])
    const byWeek = await list('sort=planningWeek:asc')
    expect(byWeek.body.orders.map((o) => `${o.lineKey} ${o.planningWeek}`)).toEqual(['462494 52/2025', '462484 01/2026', '462500 3/2026'])
    const values = await app.api<{ values: { value: string }[] }>('GET', `/api/orders/list/values?column=shippingStatus`, { token: admin.token })
    expect(values.status).toBe(200)
    expect(values.body.values.map((v) => v.value)).toContain('Shipped')
  })

  it('gives the assistant the details in ai.order_lines, with the planning week as numbers', async () => {
    expect(
      await read(`SELECT line_key, due_date::text, planning_week, planning_week_no, planning_week_year, weight_kg, total_hold_qty, delay_reason_code, item_translation, delay_comment
                    FROM ai.order_lines ORDER BY line_key`),
    ).toEqual([
      ['462484', '2026-03-10', '01/2026', 1, 2026, null, -8, 14, 'شاتيل ريل', null],
      ['462494', '2025-12-28', '52/2025', 52, 2025, 419.17, -8, 14, 'شاتيل ريل', 'PR'],
      ['462500', '2026-02-25', '3/2026', 3, 2026, 419.17, -8, 14, 'شاتيل ريل', 'PR'],
    ])
  })
})

describe('§7.7.1 — the Access sync reads the details as the file importer does', () => {
  it('writes the details of the ERP columns it carries, and clears one it carries empty', async () => {
    const created = await app.api<CreateIntegrationKeyResponse>('POST', '/api/integrations/keys', { token: admin.token, body: { name: 'Planning PC' } })
    const auth = { authorization: `Bearer ${created.body.secret}` }
    const agent = <T>(path: string, body: unknown) => app.api<T>('POST', `/api/agent/order-sync${path}`, { body, headers: auth })
    const run = async (rows: Record<string, unknown>[]) => {
      const start = await agent<OrderSyncStartResponse>('/runs', { source: 'PLANNING-PC · Tasks' })
      expect(start.status).toBe(201)
      expect((await agent(`/runs/${start.body.runId}/rows`, { rows })).status).toBe(200)
      expect((await agent(`/runs/${start.body.runId}/finish`, { total: rows.length })).status).toBe(200)
    }
    const accessRow = (extra: Record<string, unknown>) => ({ ID: 470001, Order: '20615-SGR', Item: 'Beam', 'Work Center': 7, 'Req_Q': 10, ...extra })
    await run([accessRow({ 'Due Date': '2026-05-04T00:00:00', Pivot: '19/2026', DelayReason: 9, 'Shipping Status': 'Not Shipped' })])
    expect(await line('470001')).toMatchObject({ dueDate: '2026-05-04', planningWeek: '19/2026', delayReasonCode: 9, shippingStatus: 'Not Shipped' })
    await run([accessRow({ 'Due Date': null, Pivot: '20/2026' })])
    const o = await line('470001')
    expect(o.dueDate).toBeUndefined()
    expect(o).toMatchObject({ planningWeek: '20/2026', delayReasonCode: 9, shippingStatus: 'Not Shipped' })
  })
})
