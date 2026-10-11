import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { ApiErrorBody, OpenSessionsResponse, SaveSampleRequest, StartWithSampleResponse, WizardContext } from '@qc/shared/api'
import type { ProductionOrder } from '@qc/shared/types'
import { TestApp, type Session } from './harness'

const app = new TestApp()
let admin: Session
let ayman: Session
let magdy: Session
let weldOrder: ProductionOrder

function sample(overrides: Partial<SaveSampleRequest> = {}): SaveSampleRequest {
  return {
    submissionId: randomUUID(),
    drawing: 'BS9059/58',
    sampleQty: 5,
    dimensions: [{ name: 'Width', sequence: 1, nominal: 125, tolPlus: 0.5, tolMinus: 0.5, actual: 125.1, unit: 'mm', source: 'item-order' }],
    defects: [],
    coils: [{ coilNumber: 'C10021', grade: 'S355JR', supplier: 'Ezz Steel', thickness: 2.5 }],
    pt: { testFrequencyPct: 10, consumableLots: { Cleaner: 'B24-0388', Penetrant: 'B24-0417', Developer: 'B24-0511' }, weldingWireBatch: 'WW-2401', connectorCoilNumber: 'CC-2401', testedLengths: [{ lengthMm: 150, verdict: 'Accept' }], imageIds: [] },
    ...overrides,
  }
}

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  admin = await app.register('admin', 'Admin')
  ayman = await app.register('ayman', 'Ayman Rafat')
  magdy = await app.register('magdy', 'Mohamed Magdy')
  await app.api('POST', '/api/master/machines', { token: admin.token, body: { code: '58', name: 'A. Welding Line', line: 'LM4', displayName: '58-A. Welding Line-LM4', process: 'welding' } })
  await app.api('POST', '/api/master/machines', { token: admin.token, body: { code: '21', name: 'Press', line: 'LM3', displayName: '21-Press', process: 'forming', factory: 'Factory 3' } })
  await app.api('POST', '/api/master/item-dimension-order', { token: admin.token, body: { itemCode: '125185TA3', item: 'XL Light Beam', dimensionName: 'Width', sequence: 1, nominal: 125, tolPlus: 0.5, tolMinus: 0.5, unit: 'mm' } })
  await app.api('POST', '/api/master/pt-consumables', { token: admin.token, body: { kind: 'Cleaner', productName: 'SKC-S', lotBatch: 'B24-0388' } })
  await app.api('POST', '/api/orders/import', {
    token: admin.token,
    body: { rows: [{ lineKey: 'L-1', orderNumber: '20570-EHF', item: 'XL Light Beam', itemCode: '125185TA3', workCenterCode: '58', requiredQty: 116, finishedQty: 0, customer: 'Beta Storage', expectedGrade: 'S355JR', drawing: 'BS9059/58' }] },
  })
  weldOrder = (await app.api<ProductionOrder[]>('GET', '/api/orders', { token: admin.token })).body[0]
})
afterAll(() => app.stop())

describe('a session exists only with its first sample (§4.4)', () => {
  it('previews the wizard for a line before any session exists', async () => {
    const res = await app.api<WizardContext>('GET', `/api/sessions/preview?orderId=${weldOrder.id}&startQty=0`, { token: ayman.token })
    expect(res.status).toBe(200)
    expect(res.body.session).toBeNull()
    expect(res.body.order.orderNumber).toBe('20570-EHF')
    expect(res.body.machine?.code).toBe('58')
    expect(res.body.process).toBe('welding')
    expect(res.body.dimensionOrder.map((d) => d.dimensionName)).toEqual(['Width'])
    expect(res.body.samples).toEqual([])
    // A stock machine previews its fixed line even before the line is written.
    const stock = await app.api<WizardContext>('GET', `/api/sessions/preview?workCenterCode=21&producedQty=10`, { token: ayman.token })
    expect(stock.status).toBe(200)
    expect(stock.body.order.orderNumber).toBe('STOCK')
    expect(stock.body.order.itemCode).toBe('CONNECTOR-RL')
    const notStock = await app.api<ApiErrorBody>('GET', `/api/sessions/preview?workCenterCode=58&producedQty=10`, { token: ayman.token })
    expect(notStock.status).toBe(400)
  })

  it('refuses a bad first sample and leaves no session behind', async () => {
    const bad = await app.api<ApiErrorBody>('POST', '/api/sessions/start-with-sample', {
      token: ayman.token,
      body: { start: { orderId: weldOrder.id, startQty: 116 }, sample: sample({ pt: undefined }) },
    })
    expect(bad.status).toBe(400)
    const { rows } = await app.db.query('SELECT count(*)::int AS n FROM inspection_sessions')
    expect(rows[0].n).toBe(0)
  })

  it('opens the session and records the first sample together', async () => {
    const res = await app.api<StartWithSampleResponse>('POST', '/api/sessions/start-with-sample', {
      token: ayman.token,
      body: { start: { orderId: weldOrder.id, startQty: 116 }, sample: sample() },
    })
    expect(res.status).toBe(201)
    expect(res.body.joined).toBe(false)
    expect(res.body.session.seq).toBe(1)
    expect(res.body.session.inspectorName).toBe('Ayman Rafat')
    expect(res.body.session.startQtyConfirmed?.qty).toBe(116)
    expect(res.body.session.sampleCount).toBe(1)
    expect(res.body.sample.index).toBe(1)
    // A retry with the same submission id is the same session and sample.
    const body = { start: { orderId: weldOrder.id, startQty: 116 }, sample: sample({ submissionId: '22222222-2222-4222-8222-222222222222' }) }
    const first = await app.api<StartWithSampleResponse>('POST', '/api/sessions/start-with-sample', { token: ayman.token, body })
    const again = await app.api<StartWithSampleResponse>('POST', '/api/sessions/start-with-sample', { token: ayman.token, body })
    expect(again.status).toBe(200)
    expect(again.body.sample.deduped).toBe(true)
    expect(again.body.sample.sampleId).toBe(first.body.sample.sampleId)
    expect(again.body.session.id).toBe(first.body.session.id)
  })

  it('lets a second inspector join the open session, each sample under its own name', async () => {
    const board = await app.api<OpenSessionsResponse>('GET', '/api/sessions/open', { token: magdy.token })
    expect(board.body.sessions).toHaveLength(1)
    expect(board.body.sessions[0].inspectorName).toBe('Ayman Rafat')
    const sessionId = board.body.sessions[0].id
    // Starting "a new inspection" on the same line joins it rather than opening a twin.
    const res = await app.api<StartWithSampleResponse>('POST', '/api/sessions/start-with-sample', {
      token: magdy.token,
      body: { start: { orderId: weldOrder.id, startQty: 116 }, sample: sample() },
    })
    expect(res.status).toBe(201)
    expect(res.body.joined).toBe(true)
    expect(res.body.session.id).toBe(sessionId)
    expect(res.body.session.sampleCount).toBe(3)
    // And recording straight into it works too.
    const direct = await app.api('POST', `/api/sessions/${sessionId}/samples`, { token: magdy.token, body: sample() })
    expect(direct.status).toBe(201)
    const ctx = await app.api<WizardContext>('GET', `/api/sessions/${sessionId}/wizard`, { token: ayman.token })
    expect(ctx.body.samples.map((s) => s.inspectorName)).toEqual(['Ayman Rafat', 'Ayman Rafat', 'Mohamed Magdy', 'Mohamed Magdy'])
    const { rows } = await app.db.query('SELECT count(*)::int AS n FROM inspection_sessions')
    expect(rows[0].n).toBe(1)
  })

  it('opens a new session on the line once the open one is closed', async () => {
    const board = await app.api<OpenSessionsResponse>('GET', '/api/sessions/open', { token: ayman.token })
    const open = board.body.sessions[0]
    const closed = await app.api('POST', `/api/sessions/${open.id}/close`, { token: ayman.token, body: { finalQty: 110, version: open.version } })
    expect(closed.status).toBe(200)
    const res = await app.api<StartWithSampleResponse>('POST', '/api/sessions/start-with-sample', {
      token: magdy.token,
      body: { start: { orderId: weldOrder.id, startQty: 6 }, sample: sample() },
    })
    expect(res.status).toBe(201)
    expect(res.body.joined).toBe(false)
    expect(res.body.session.seq).toBe(2)
    expect(res.body.session.inspectorName).toBe('Mohamed Magdy')
  })

  it('carries the nominal typed on the first sample to the next one, however the machine code is written', async () => {
    // A line of the same item on the same machine, written with a leading zero, as an ERP export sometimes does.
    await app.api('POST', '/api/orders/import', {
      token: admin.token,
      body: { rows: [{ lineKey: 'L-2', orderNumber: '20571-EHF', item: 'XL Light Beam', itemCode: '125185TA3', workCenterCode: '058', requiredQty: 50, finishedQty: 0, customer: 'Beta Storage', expectedGrade: 'S355JR', drawing: 'BS9059/58' }] },
    })
    const other = (await app.api<ProductionOrder[]>('GET', '/api/orders', { token: admin.token })).body.find((o) => o.lineKey === 'L-2')!
    // The latest sample on machine 58 typed a manual "Length" nominal.
    const res = await app.api<StartWithSampleResponse>('POST', '/api/sessions/start-with-sample', {
      token: ayman.token,
      body: {
        start: { orderId: weldOrder.id, startQty: 1 },
        sample: sample({ dimensions: [{ name: 'Width', sequence: 1, nominal: 125, tolPlus: 0.5, tolMinus: 0.5, actual: 125, unit: 'mm', source: 'item-order' }, { name: 'Length', sequence: 2, nominal: 2500, tolPlus: 2, tolMinus: 2, actual: 2501, unit: 'mm', source: 'manual' }] }),
      },
    })
    expect(res.status).toBe(201)
    const preview = await app.api<WizardContext>('GET', `/api/sessions/preview?orderId=${other.id}&startQty=0`, { token: magdy.token })
    expect(preview.status).toBe(200)
    expect(preview.body.previousDimensions.map((d) => [d.name, d.nominal])).toEqual([
      ['Width', 125],
      ['Length', 2500],
    ])
  })

  it('carries typed dimensions on a line whose ERP export left the item code blank', async () => {
    await app.api('POST', '/api/master/machines', { token: admin.token, body: { code: '24', name: 'Stam Upright', line: 'LM1', displayName: '24-Stam Upright', process: 'forming', usesItemDimensions: false } })
    await app.api('POST', '/api/orders/import', {
      token: admin.token,
      body: { rows: [{ lineKey: 'STAM-1', orderNumber: '20601-GMA', item: 'XL Upright (NP Punching) : 10040', itemCode: '', workCenterCode: '24', requiredQty: 100, finishedQty: 0, customer: 'GMA', expectedGrade: '', drawing: 'D-1' }] },
    })
    const line = (await app.api<ProductionOrder[]>('GET', '/api/orders', { token: admin.token })).body.find((o) => o.lineKey === 'STAM-1')!
    const first = await app.api<StartWithSampleResponse>('POST', '/api/sessions/start-with-sample', {
      token: ayman.token,
      body: {
        start: { orderId: line.id, startQty: 0 },
        sample: sample({ drawing: 'D-1', pt: undefined, coils: [], dimensions: [{ name: 'Width', sequence: 1, nominal: 100, tolPlus: 1, tolMinus: 1, actual: 100.2, unit: 'mm', source: 'manual' }, { name: 'Height', sequence: 2, nominal: 80, tolPlus: 1, tolMinus: 1, actual: 80.1, unit: 'mm', source: 'manual' }] }),
      },
    })
    expect(first.status).toBe(201)
    const ctx = await app.api<WizardContext>('GET', `/api/sessions/${first.body.session.id}/wizard`, { token: ayman.token })
    expect(ctx.body.dimensionOrder).toEqual([])
    expect(ctx.body.previousDimensions.map((d) => [d.name, d.nominal])).toEqual([
      ['Width', 100],
      ['Height', 80],
    ])
  })

  it('opens a stock session with its first sample', async () => {
    const res = await app.api<StartWithSampleResponse>('POST', '/api/sessions/start-with-sample', {
      token: ayman.token,
      body: { start: { workCenterCode: '21', producedQty: 40 }, sample: sample({ drawing: '', pt: undefined, coils: [] }) },
    })
    expect(res.status).toBe(201)
    expect(res.body.session.order?.orderNumber).toBe('STOCK')
    expect(res.body.session.producedQty).toBe(40)
  })
})
