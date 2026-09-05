import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import type {
  ApiErrorBody,
  AuditListResponse,
  AuditStats,
  CoilUsage,
  HistoryResponse,
  OpenSessionsResponse,
  OrderHistory,
  PDIWithOrder,
  SampleDetail,
  SampleSummary,
  SaveSampleRequest,
  SaveSampleResponse,
  SessionWithOrder,
  WizardContext,
} from '@qc/shared/api'
import type { Coil, DefectResult, DimensionResult, ImageAsset, ProductionOrder } from '@qc/shared/types'
import { TestApp, tinyJpeg, type Session } from './harness'

const app = new TestApp()
let admin: Session
let inspector: Session
let supervisor: Session
let weldOrder: ProductionOrder
let paintOrder: ProductionOrder
let paintBeamOrder: ProductionOrder
let weldOrderOnPaintLine: ProductionOrder

async function uploadImage(s: Session, seed: number, extra: Record<string, string> = {}): Promise<ImageAsset> {
  const bytes = tinyJpeg(seed)
  const form = new FormData()
  form.set('file', new Blob([bytes], { type: 'image/jpeg' }), 'defect.jpg')
  form.set('originalFilename', 'defect.jpg')
  form.set('width', '1600')
  form.set('height', '1200')
  form.set('sha256', createHash('sha256').update(bytes).digest('hex'))
  form.set('thumbnailDataUrl', 'data:image/jpeg;base64,/9j/4AAQSkZJRg==')
  for (const [k, v] of Object.entries(extra)) form.set(k, v)
  const res = await app.api<ImageAsset>('POST', '/api/images', { token: s.token, raw: form })
  if (res.status !== 201) throw new Error(`upload failed ${res.status} ${JSON.stringify(res.body)}`)
  return res.body
}

function weldSample(submissionId: string, overrides: Partial<SaveSampleRequest> = {}): SaveSampleRequest {
  return {
    submissionId,
    drawing: 'BS9059/58',
    sampleQty: 1,
    dimensions: [
      { name: 'Width', sequence: 1, nominal: 125, tolPlus: 0.5, tolMinus: 0.5, actual: 125.1, unit: 'mm', source: 'item-order' },
      { name: 'Thickness', sequence: 2, nominal: 2.5, tolPlus: 0.15, tolMinus: 0.15, actual: null, unit: 'mm', source: 'item-order' },
      { name: 'Length', sequence: 3, nominal: 2500, tolPlus: 2, tolMinus: 2, actual: 2503, unit: 'mm', source: 'manual' },
    ],
    defects: [{ defectName: 'عيب لحام', qty: 2, disposition: 'Hold', notes: 'porosity near the end', imageIds: [] }],
    coils: [{ coilNumber: 'C10021', grade: 'S355JR', supplier: 'Ezz Steel', thickness: 2.5 }],
    pt: {
      testFrequencyPct: 10,
      consumableLots: { Cleaner: 'B24-0388', Penetrant: 'B24-0417', Developer: 'B24-0511' },
      acceptOrRepair: 'Accept',
      imageIds: [],
    },
    ...overrides,
  }
}

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  admin = await app.register('admin', 'Admin')
  inspector = await app.register('insp', 'Inspector One')
  await app.api('POST', '/api/users', { token: admin.token, body: { username: 'sup', password: 'Password#1', name: 'Super', role: 'supervisor' } })
  supervisor = await app.login('sup')

  await app.api('POST', '/api/master/machines', { token: admin.token, body: { code: '58', name: 'A. Welding Line', line: 'LM4', displayName: '58-A. Welding Line-LM4' } })
  await app.api('POST', '/api/master/machines', { token: admin.token, body: { code: '48', name: 'Painting Line', line: 'LM4', displayName: '48-Painting Line-LM4' } })
  await app.api('POST', '/api/master/item-dimension-order', { token: admin.token, body: { itemCode: '125185TA3', item: 'XL Light Beam', dimensionName: 'Width', sequence: 1, nominal: 125, tolPlus: 0.5, tolMinus: 0.5, unit: 'mm' } })
  // The same item measured differently on the paint line, and a dimension only that line has.
  await app.api('POST', '/api/master/item-dimension-order', { token: admin.token, body: { itemCode: '125185ta3', workCenterCode: '48', dimensionName: 'Width', sequence: 2, nominal: 127, tolPlus: 1, tolMinus: 1, unit: 'mm' } })
  await app.api('POST', '/api/master/item-dimension-order', { token: admin.token, body: { itemCode: '125185TA3', workCenterCode: '48', dimensionName: 'Paint thickness', sequence: 1, nominal: 60, tolPlus: 10, tolMinus: 5, unit: 'µm' } })
  await app.api('POST', '/api/master/work-center-defects', { token: admin.token, body: { workCenterCode: '58', defectName: 'عيب لحام' } })
  await app.api('POST', '/api/master/grade-mappings', { token: admin.token, body: { gradeA: 'S355JR', gradeB: 'ST52-3' } })
  await app.api('POST', '/api/master/pt-consumables', { token: admin.token, body: { kind: 'Cleaner', productName: 'SKC-S', lotBatch: 'B24-0388' } })
  await app.api('POST', '/api/orders/import', {
    token: admin.token,
    body: {
      rows: [
        { lineKey: 'L-1', orderNumber: '20095-QC1-HYH', item: 'XL Light Beam', itemCode: '125185TA3', workCenterCode: '58', requiredQty: 2500, finishedQty: 2000, customer: 'Beta Storage', expectedGrade: 'S355JR', drawing: 'BS9059/58', drawingAlt: 'BS9059/58-ALT' },
        { lineKey: 'L-2', orderNumber: '20480-Ph1.4-SMA', item: 'Shuttle Beam', itemCode: 'LB406015-5TA3', workCenterCode: '48', requiredQty: 1350, finishedQty: 900, customer: 'Alpha Racking', expectedGrade: 'ST52-3', drawing: 'BS9059/48' },
        { lineKey: 'L-3', orderNumber: '20480-Ph1.4-SMA', item: 'XL Light Beam', itemCode: '125185TA3', workCenterCode: '48', requiredQty: 100, finishedQty: 0, customer: 'Alpha Racking', expectedGrade: 'S355JR', drawing: 'BS9059/48' },
        // The weld order's beam also runs on the paint line: same order, same item, another machine.
        { lineKey: 'L-4', orderNumber: '20095-QC1-HYH', item: 'XL Light Beam', itemCode: '125185TA3', workCenterCode: '48', requiredQty: 2500, finishedQty: 0, customer: 'Beta Storage', expectedGrade: 'S355JR', drawing: 'BS9059/48' },
      ],
    },
  })
  await app.api('POST', '/api/coils/import', { token: admin.token, body: { rows: [{ coilNumber: 'C10021', grade: 'S355JR', supplier: 'Ezz Steel', thickness: 2.5 }] } })
  const orders = (await app.api<ProductionOrder[]>('GET', '/api/orders', { token: admin.token })).body
  weldOrder = orders.find((o) => o.lineKey === 'L-1')!
  paintOrder = orders.find((o) => o.lineKey === 'L-2')!
  paintBeamOrder = orders.find((o) => o.lineKey === 'L-3')!
  weldOrderOnPaintLine = orders.find((o) => o.lineKey === 'L-4')!
})
afterAll(() => app.stop())

describe('sessions', () => {
  let session: SessionWithOrder

  it('starts a session with the confirmed starting quantity and seq 1', async () => {
    const res = await app.api<SessionWithOrder>('POST', '/api/sessions', { token: inspector.token, body: { orderId: weldOrder.id, startQty: 500 } })
    expect(res.status).toBe(201)
    session = res.body
    expect(session.seq).toBe(1)
    expect(session.status).toBe('Open')
    expect(session.workCenterCode).toBe('58')
    expect(session.inspectorName).toBe('Inspector One')
    expect(session.startQtyConfirmed?.qty).toBe(500)
    expect(session.startQtyConfirmed?.byName).toBe('Inspector One')
    expect(session.order?.orderNumber).toBe('20095-QC1-HYH')
    expect(session.sampleCount).toBe(0)
    expect(session.version).toBe(0)
  })

  it('gives the next session on the same order seq 2', async () => {
    const res = await app.api<SessionWithOrder>('POST', '/api/sessions', { token: inspector.token, body: { orderId: weldOrder.id, startQty: 10 } })
    expect(res.body.seq).toBe(2)
    // Marked deleted by a supervisor — it must stop appearing, but stay stored.
    expect((await app.api('DELETE', `/api/sessions/${res.body.id}`, { token: inspector.token })).status).toBe(403)
    expect((await app.api('DELETE', `/api/sessions/${res.body.id}`, { token: supervisor.token })).status).toBe(204)
    expect((await app.api('GET', `/api/sessions/${res.body.id}`, { token: inspector.token })).status).toBe(404)
    const { rows } = await app.db.query('SELECT deleted_at FROM inspection_sessions WHERE id = $1', [res.body.id])
    expect(rows[0].deleted_at).not.toBeNull()
  })

  it('lists it on the open board with the Hold badge at zero', async () => {
    const board = await app.api<OpenSessionsResponse>('GET', '/api/sessions/open', { token: inspector.token })
    expect(board.body.sessions.map((s) => s.id)).toEqual([session.id])
    expect(board.body.samples).toEqual([])
    expect(board.body.holdCount).toBe(0)
  })

  it('answers the wizard context in one call', async () => {
    const ctx = await app.api<WizardContext>('GET', `/api/sessions/${session.id}/wizard`, { token: inspector.token })
    expect(ctx.status).toBe(200)
    expect(ctx.body.order.orderNumber).toBe('20095-QC1-HYH')
    expect(ctx.body.machine?.displayName).toBe('58-A. Welding Line-LM4')
    // Only the item's general rows: the paint-line rows belong to machine 48.
    expect(ctx.body.dimensionOrder.map((d) => [d.dimensionName, d.nominal])).toEqual([['Width', 125]])
    expect(ctx.body.workCenterDefects.map((d) => d.defectName)).toEqual(['عيب لحام'])
    expect(ctx.body.gradeMappings).toHaveLength(1)
    expect(ctx.body.ptConsumables).toHaveLength(1)
    expect(ctx.body.samples).toEqual([])
  })

  it('hands the wizard the machine-specific rows alongside the general ones', async () => {
    // One photo of the item for every machine, one only for the paint line.
    const general = await uploadImage(admin, 11)
    const paintOnly = await uploadImage(admin, 12)
    await app.api('POST', '/api/master/item-reference-images', { token: admin.token, body: { itemCode: '125185TA3', imageId: general.id } })
    await app.api('POST', '/api/master/item-reference-images', { token: admin.token, body: { itemCode: '125185ta3', workCenterCode: '48', imageId: paintOnly.id } })
    const weld = await app.api<WizardContext>('GET', `/api/sessions/${session.id}/wizard`, { token: inspector.token })
    expect(weld.body.referenceImages.map((r) => r.imageId)).toEqual([general.id])

    const started = await app.api<SessionWithOrder>('POST', '/api/sessions', { token: inspector.token, body: { orderId: paintBeamOrder.id, startQty: 5 } })
    expect(started.status).toBe(201)
    const ctx = await app.api<WizardContext>('GET', `/api/sessions/${started.body.id}/wizard`, { token: inspector.token })
    expect(ctx.body.dimensionOrder.map((d) => [d.dimensionName, d.nominal, d.workCenterCode ?? null])).toEqual([
      ['Paint thickness', 60, '48'],
      ['Width', 125, null],
      ['Width', 127, '48'],
    ])
    expect(ctx.body.referenceImages.map((r) => [r.imageId, r.workCenterCode ?? null])).toEqual([
      [general.id, null],
      [paintOnly.id, '48'],
    ])
    expect((await app.api('DELETE', `/api/sessions/${started.body.id}`, { token: supervisor.token })).status).toBe(204)
  })
})

describe('the atomic sample save', () => {
  let sessionId: string
  let saved: SaveSampleResponse
  const submissionId = '11111111-1111-4111-8111-111111111111'

  beforeAll(async () => {
    const board = await app.api<OpenSessionsResponse>('GET', '/api/sessions/open', { token: inspector.token })
    sessionId = board.body.sessions[0].id
  })

  it('rejects a sample that breaks a business rule, writing nothing', async () => {
    const noLots = weldSample('22222222-2222-4222-8222-222222222222', {
      pt: { testFrequencyPct: 3, consumableLots: { Cleaner: '', Penetrant: 'x', Developer: 'y' }, imageIds: [] },
    })
    const res = await app.api<ApiErrorBody>('POST', `/api/sessions/${sessionId}/samples`, { token: inspector.token, body: noLots })
    expect(res.status).toBe(400)
    expect(res.body.error.message).toMatch(/greater than 5%/)
    const { rows } = await app.db.query('SELECT count(*)::int AS n FROM inspection_samples')
    expect(rows[0].n).toBe(0)
  })

  it('rejects a defect without a disposition', async () => {
    const res = await app.api<ApiErrorBody>('POST', `/api/sessions/${sessionId}/samples`, {
      token: inspector.token,
      body: weldSample('33333333-3333-4333-8333-333333333333', { defects: [{ defectName: 'x', qty: 1, disposition: null as never, imageIds: [] }] }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects a sample that references a photo that does not exist', async () => {
    const res = await app.api<ApiErrorBody>('POST', `/api/sessions/${sessionId}/samples`, {
      token: inspector.token,
      body: weldSample('44444444-4444-4444-8444-444444444444', {
        defects: [{ defectName: 'x', qty: 1, disposition: 'Hold', imageIds: ['00000000-0000-4000-8000-000000000000'] }],
      }),
    })
    expect(res.status).toBe(400)
    expect(res.body.error.message).toMatch(/photos is missing/)
  })

  it('rejects a coil that claims to come from the register but is not in it', async () => {
    const res = await app.api<ApiErrorBody>('POST', `/api/sessions/${sessionId}/samples`, {
      token: inspector.token,
      body: weldSample('55555555-5555-4555-8555-555555555555', {
        coils: [{ coilId: '00000000-0000-4000-8000-000000000000', coilNumber: 'C99999' }],
      }),
    })
    expect(res.status).toBe(400)
    expect(res.body.error.message).toMatch(/coil register/)
  })

  it('saves the whole sample as one unit', async () => {
    const photo = await uploadImage(inspector, 7, { sessionId })
    const catalogueCoil = (await app.api<Coil[]>('GET', '/api/coils?search=C10021', { token: inspector.token })).body[0]
    const body = weldSample(submissionId, {
      defects: [{ defectName: 'عيب لحام', qty: 2, disposition: 'Hold', imageIds: [photo.id] }],
      coils: [{ coilId: catalogueCoil.id, coilNumber: 'C10021', grade: 'S355JR', supplier: 'Ezz Steel', thickness: 2.5 }],
      gradeAcknowledgement: { coilNumbers: ['C10021'], expectedGrade: 'S355JR', foundGrades: ['S275'], at: new Date().toISOString() },
    })
    const res = await app.api<SaveSampleResponse>('POST', `/api/sessions/${sessionId}/samples`, { token: inspector.token, body })
    expect(res.status).toBe(201)
    saved = res.body
    expect(saved.index).toBe(1)
    expect(saved.deduped).toBe(false)

    const detail = await app.api<SampleDetail>('GET', `/api/samples/${saved.sampleId}`, { token: inspector.token })
    expect(detail.status).toBe(200)
    const { sample, dimensions, defects, coils, pt, paint } = detail.body
    expect(sample.index).toBe(1)
    expect(sample.submissionId).toBe(submissionId)
    expect(['A', 'B', 'C']).toContain(sample.shift)
    expect(sample.dimensionCount).toBe(3)
    expect(sample.measuredDimensionCount).toBe(2)
    expect(sample.defectCount).toBe(1)
    expect(sample.coilCount).toBe(1)
    expect(sample.gradeAcknowledgement?.byName).toBe('Inspector One')
    expect(sample.gradeAcknowledgement?.coilNumbers).toEqual(['C10021'])
    expect(dimensions.map((d) => [d.name, d.status])).toEqual([
      ['Width', 'Pass'],
      ['Thickness', 'Pending'],
      ['Length', 'Fail'],
    ])
    expect(dimensions[0].actual).toBe(125.1)
    expect(defects[0].disposition).toBe('Hold')
    expect(defects[0].imageIds).toEqual([photo.id])
    expect(coils[0].coilNumber).toBe('C10021')
    expect(coils[0].coilId).toBe(catalogueCoil.id)
    expect(pt?.consumableLots).toEqual({ Cleaner: 'B24-0388', Penetrant: 'B24-0417', Developer: 'B24-0511' })
    expect(pt?.acceptOrRepair).toBe('Accept')
    expect(paint).toBeNull()

    // The photo now knows which sample it belongs to.
    const img = await app.api<ImageAsset[]>('GET', `/api/images?ids=${photo.id}`, { token: inspector.token })
    expect(img.body[0].sampleId).toBe(saved.sampleId)
  })

  it('returns the first save on a retry with the same submission id', async () => {
    const res = await app.api<SaveSampleResponse>('POST', `/api/sessions/${sessionId}/samples`, { token: inspector.token, body: weldSample(submissionId) })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ sampleId: saved.sampleId, index: 1, deduped: true })
    const { rows } = await app.db.query('SELECT count(*)::int AS n FROM inspection_samples')
    expect(rows[0].n).toBe(1)
  })

  it('numbers the next sample 2 and shows both on the board and in the order history', async () => {
    const res = await app.api<SaveSampleResponse>('POST', `/api/sessions/${sessionId}/samples`, {
      token: inspector.token,
      body: weldSample('55555555-5555-4555-8555-555555555555', { defects: [] }),
    })
    expect(res.body.index).toBe(2)
    const board = await app.api<OpenSessionsResponse>('GET', '/api/sessions/open', { token: inspector.token })
    expect(board.body.samples.map((s) => s.index)).toEqual([1, 2])
    expect(board.body.sessions[0].sampleCount).toBe(2)
    expect(board.body.holdCount).toBe(1)
    const history = await app.api<OrderHistory>('GET', `/api/orders/${weldOrder.id}/history`, { token: inspector.token })
    expect(history.body.sessions).toHaveLength(1)
    expect(history.body.samples).toHaveLength(2)
    const list = await app.api<SampleSummary[]>('GET', `/api/sessions/${sessionId}/samples`, { token: inspector.token })
    expect(list.body.map((s) => s.index)).toEqual([1, 2])
  })

  it('shows an inspector only their own sessions; a supervisor sees everyone’s', async () => {
    // The supervisor opens a session of their own on the paint beam line.
    const theirs = await app.api<SessionWithOrder>('POST', '/api/sessions', { token: supervisor.token, body: { orderId: paintBeamOrder.id, startQty: 5 } })
    expect(theirs.status).toBe(201)

    const mine = await app.api<OpenSessionsResponse>('GET', '/api/sessions/open', { token: inspector.token })
    expect(mine.body.sessions.map((s) => s.id)).toEqual([sessionId])
    expect(mine.body.samples.every((sm) => sm.sessionId === sessionId)).toBe(true)
    expect(mine.body.holdCount).toBe(1)

    const all = await app.api<OpenSessionsResponse>('GET', '/api/sessions/open', { token: supervisor.token })
    expect(all.body.sessions.map((s) => s.id).sort()).toEqual([sessionId, theirs.body.id].sort())

    const myHistory = await app.api<HistoryResponse>('GET', '/api/sessions/history', { token: inspector.token })
    expect(myHistory.body.sessions.map((s) => s.id)).toEqual([sessionId])
    const myHold = await app.api<HistoryResponse>('GET', '/api/sessions/history?disposition=Hold', { token: inspector.token })
    expect(myHold.body.sessions.map((s) => s.id)).toEqual([sessionId])
    const allHistory = await app.api<HistoryResponse>('GET', '/api/sessions/history', { token: supervisor.token })
    expect(allHistory.body.sessions.length).toBeGreaterThan(1)

    expect((await app.api('DELETE', `/api/sessions/${theirs.body.id}`, { token: supervisor.token })).status).toBe(204)
  })

  it('flags the session by its defects and offers the last sample’s nominal to the next one', async () => {
    // Sample 1 holds a defect on Hold, sample 2 is clean: the session is amber.
    const board = await app.api<OpenSessionsResponse>('GET', '/api/sessions/open', { token: inspector.token })
    const flagged = board.body.sessions[0]
    expect(flagged.defectCount).toBe(1)
    expect(flagged.holdCount).toBe(1)
    expect(flagged.priorDefectsElsewhere).toBe(false)

    // The wizard hands back the rows of the latest sample, so the inspector's
    // nominal for "Length" (not configured) is typed once.
    const ctx = await app.api<WizardContext>('GET', `/api/sessions/${sessionId}/wizard`, { token: inspector.token })
    expect(ctx.body.previousDimensions.map((d) => [d.name, d.nominal])).toEqual([
      ['Width', 125],
      ['Thickness', 2.5],
      ['Length', 2500],
    ])

    // The same item of the same order on ANOTHER machine (line L-4) is grey:
    // defects before. The same item on a different order (line L-3) is not.
    const elsewhere = await app.api<SessionWithOrder>('POST', '/api/sessions', { token: inspector.token, body: { orderId: weldOrderOnPaintLine.id, startQty: 5 } })
    expect(elsewhere.status).toBe(201)
    expect(elsewhere.body.defectCount).toBe(0)
    expect(elsewhere.body.priorDefectsElsewhere).toBe(true)
    expect((await app.api('DELETE', `/api/sessions/${elsewhere.body.id}`, { token: supervisor.token })).status).toBe(204)
    const other = await app.api<SessionWithOrder>('POST', '/api/sessions', { token: inspector.token, body: { orderId: paintBeamOrder.id, startQty: 5 } })
    expect(other.body.priorDefectsElsewhere).toBe(false)
    expect((await app.api('DELETE', `/api/sessions/${other.body.id}`, { token: supervisor.token })).status).toBe(204)

    // The same order line, a later session on the same machine: grey too.
    const later = await app.api<SessionWithOrder>('POST', '/api/sessions', { token: inspector.token, body: { orderId: weldOrder.id, startQty: 5 } })
    expect(later.body.defectCount).toBe(0)
    expect(later.body.priorDefectsElsewhere).toBe(true)
    expect((await app.api('DELETE', `/api/sessions/${later.body.id}`, { token: supervisor.token })).status).toBe(204)
  })

  it('wrote create and acknowledge audit entries with the order context', async () => {
    const audit = await app.api<AuditListResponse>('GET', '/api/audit', { token: supervisor.token })
    const created = audit.body.entries.filter((e) => e.entity === 'InspectionSample' && e.action === 'create')
    expect(created).toHaveLength(2)
    expect(created[0].orderNumber).toBe('20095-QC1-HYH')
    expect(created[0].workCenterCode).toBe('58')
    const ack = audit.body.entries.find((e) => e.action === 'acknowledge')
    expect(ack?.sampleId).toBe(saved.sampleId)
    expect((await app.api('GET', '/api/audit', { token: inspector.token })).status).toBe(403)
  })

  it('traces the coil back to the order and customer', async () => {
    const usage = await app.api<CoilUsage[]>('GET', '/api/coils/usage?coilNumbers=c10021', { token: inspector.token })
    expect(usage.body).toHaveLength(2)
    expect(usage.body[0].orderNumber).toBe('20095-QC1-HYH')
    expect(usage.body[0].customer).toBe('Beta Storage')
  })
})

describe('corrections (§9.4, §14)', () => {
  let sessionId: string
  let dim: DimensionResult
  let defect: DefectResult

  beforeAll(async () => {
    const board = await app.api<OpenSessionsResponse>('GET', '/api/sessions/open', { token: inspector.token })
    sessionId = board.body.sessions[0].id
    const first = board.body.samples.find((s) => s.index === 1)!
    const detail = await app.api<SampleDetail>('GET', `/api/samples/${first.id}`, { token: inspector.token })
    dim = detail.body.dimensions.find((d) => d.name === 'Length')!
    defect = detail.body.defects[0]
  })

  it('corrects a measurement, re-evaluates its status and audits the change', async () => {
    const res = await app.api<DimensionResult>('PATCH', `/api/samples/dimensions/${dim.id}`, {
      token: inspector.token,
      body: { actual: 2501.9, version: dim.version },
    })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('Warning')
    expect(res.body.version).toBe(1)
    const audit = await app.api<AuditListResponse>('GET', '/api/audit', { token: admin.token })
    const fields = audit.body.entries.filter((e) => e.entity === 'DimensionResult' && e.entityId === dim.id).map((e) => e.field).sort()
    expect(fields).toEqual(['actual', 'status'])
  })

  it('rejects a stale version with the current row', async () => {
    const res = await app.api<ApiErrorBody>('PATCH', `/api/samples/dimensions/${dim.id}`, {
      token: inspector.token,
      body: { actual: 2500, version: 0 },
    })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('conflict')
    expect((res.body.error.details as DimensionResult).version).toBe(1)
  })

  it('corrects a defect', async () => {
    const res = await app.api<DefectResult>('PATCH', `/api/samples/defects/${defect.id}`, {
      token: inspector.token,
      body: { disposition: 'Repair', qty: 3, version: defect.version },
    })
    expect(res.status).toBe(200)
    expect(res.body.disposition).toBe('Repair')
    expect(res.body.qty).toBe(3)
    expect(res.body.imageIds).toHaveLength(1)
  })

  it('closes the session with a version check', async () => {
    const stale = await app.api<ApiErrorBody>('POST', `/api/sessions/${sessionId}/close`, { token: inspector.token, body: { finalQty: 480, version: 99 } })
    expect(stale.status).toBe(409)
    const ok = await app.api<SessionWithOrder>('POST', `/api/sessions/${sessionId}/close`, { token: inspector.token, body: { finalQty: 480, version: 0 } })
    expect(ok.status).toBe(200)
    expect(ok.body.status).toBe('Closed')
    expect(ok.body.finalQty).toBe(480)
    expect(ok.body.closedAt).toBeTruthy()
    expect(ok.body.version).toBe(1)
    const again = await app.api<ApiErrorBody>('POST', `/api/sessions/${sessionId}/close`, { token: inspector.token, body: { finalQty: 1, version: 1 } })
    expect(again.status).toBe(400)
  })

  it('refuses new samples on a closed session', async () => {
    const res = await app.api<ApiErrorBody>('POST', `/api/sessions/${sessionId}/samples`, {
      token: inspector.token,
      body: weldSample('66666666-6666-4666-8666-666666666666'),
    })
    expect(res.status).toBe(400)
    expect(res.body.error.message).toMatch(/closed/)
  })

  it('lets only a supervisor correct a closed session', async () => {
    const byInspector = await app.api<ApiErrorBody>('PATCH', `/api/samples/dimensions/${dim.id}`, { token: inspector.token, body: { actual: 2500, version: 1 } })
    expect(byInspector.status).toBe(403)
    const bySupervisor = await app.api<DimensionResult>('PATCH', `/api/samples/dimensions/${dim.id}`, { token: supervisor.token, body: { actual: 2500, version: 1 } })
    expect(bySupervisor.status).toBe(200)
    expect(bySupervisor.body.status).toBe('Pass')
  })

  it('shows the closed session in history, and filters by disposition', async () => {
    const history = await app.api<HistoryResponse>('GET', '/api/sessions/history', { token: inspector.token })
    expect(history.body.sessions.map((s) => s.status)).toEqual(['Closed'])
    const repair = await app.api<HistoryResponse>('GET', '/api/sessions/history?disposition=Repair', { token: inspector.token })
    expect(repair.body.sessions).toHaveLength(1)
    const hold = await app.api<HistoryResponse>('GET', '/api/sessions/history?disposition=Hold', { token: inspector.token })
    expect(hold.body.sessions).toHaveLength(0)
  })
})

describe('paint work centre', () => {
  it('requires the paint record and stores its photos', async () => {
    const started = await app.api<SessionWithOrder>('POST', '/api/sessions', { token: inspector.token, body: { orderId: paintOrder.id, startQty: 450 } })
    const sid = started.body.id
    const missing = await app.api<ApiErrorBody>('POST', `/api/sessions/${sid}/samples`, {
      token: inspector.token,
      body: { submissionId: '77777777-7777-4777-8777-777777777777', drawing: 'BS9059/48', sampleQty: 1, dimensions: [], defects: [], coils: [] },
    })
    expect(missing.status).toBe(400)
    expect(missing.body.error.message).toMatch(/paint sample/i)

    const photo = await uploadImage(inspector, 9, { sessionId: sid })
    const ok = await app.api<SaveSampleResponse>('POST', `/api/sessions/${sid}/samples`, {
      token: inspector.token,
      body: {
        submissionId: '77777777-7777-4777-8777-777777777777',
        drawing: 'BS9059/48',
        sampleQty: 2,
        dimensions: [],
        defects: [],
        coils: [],
        paint: { notes: 'RAL7016 ok', imageIds: [photo.id] },
      },
    })
    expect(ok.status).toBe(201)
    const detail = await app.api<SampleDetail>('GET', `/api/samples/${ok.body.sampleId}`, { token: inspector.token })
    expect(detail.body.paint?.imageIds).toEqual([photo.id])
    expect(detail.body.paint?.notes).toBe('RAL7016 ok')
  })
})

describe('images', () => {
  it('rejects a non-JPEG and a hash mismatch', async () => {
    const form = new FormData()
    form.set('file', new Blob([Buffer.from('not an image')], { type: 'image/jpeg' }), 'x.jpg')
    form.set('originalFilename', 'x.jpg')
    form.set('width', '10')
    form.set('height', '10')
    form.set('sha256', 'a'.repeat(64))
    form.set('thumbnailDataUrl', 'data:image/jpeg;base64,/9j/4AAQSkZJRg==')
    const notImage = await app.api<ApiErrorBody>('POST', '/api/images', { token: inspector.token, raw: form })
    expect(notImage.status).toBe(400)

    const bytes = tinyJpeg(3)
    const form2 = new FormData()
    form2.set('file', new Blob([bytes], { type: 'image/jpeg' }), 'x.jpg')
    form2.set('originalFilename', 'x.jpg')
    form2.set('width', '10')
    form2.set('height', '10')
    form2.set('sha256', 'b'.repeat(64))
    form2.set('thumbnailDataUrl', 'data:image/jpeg;base64,/9j/4AAQSkZJRg==')
    const mismatch = await app.api<ApiErrorBody>('POST', '/api/images', { token: inspector.token, raw: form2 })
    expect(mismatch.status).toBe(400)
    expect(mismatch.body.error.message).toMatch(/hash/)
  })

  it('serves the stored bytes back with an immutable ETag', async () => {
    const asset = await uploadImage(inspector, 11)
    expect(asset.driver).toBe('local')
    expect(asset.byteSize).toBe(tinyJpeg(11).length)
    const res = await fetch(`${app.baseUrl}/api/images/${asset.id}/content`, { headers: { authorization: `Bearer ${inspector.token}` } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    expect(res.headers.get('etag')).toBe(`"${asset.sha256}"`)
    expect(Buffer.from(await res.arrayBuffer()).equals(tinyJpeg(11))).toBe(true)
    const cached = await fetch(`${app.baseUrl}/api/images/${asset.id}/content`, {
      headers: { authorization: `Bearer ${inspector.token}`, 'if-none-match': `"${asset.sha256}"` },
    })
    expect(cached.status).toBe(304)
    expect((await app.api('GET', `/api/images/${asset.id}/content`)).status).toBe(401)
  })
})

describe('PDI documents', () => {
  it('creates and lists with the order attached', async () => {
    const photo = await uploadImage(inspector, 21, { orderId: weldOrder.id })
    const created = await app.api<PDIWithOrder>('POST', '/api/pdi', { token: inspector.token, body: { orderId: weldOrder.id, notes: 'ready', imageIds: [photo.id] } })
    expect(created.status).toBe(201)
    expect(created.body.order?.orderNumber).toBe('20095-QC1-HYH')
    expect(created.body.imageIds).toEqual([photo.id])
    expect(created.body.createdByName).toBe('Inspector One')
    const list = await app.api<PDIWithOrder[]>('GET', '/api/pdi', { token: inspector.token })
    expect(list.body).toHaveLength(1)
  })
})

describe('audit trail protection (§11)', () => {
  it('cannot be edited or deleted at the database', async () => {
    await expect(app.db.query(`UPDATE audit_log SET new_value = 'tampered'`)).rejects.toThrow(/cannot be edited/)
    await expect(app.db.query('DELETE FROM audit_log')).rejects.toThrow(/Hard delete is not allowed/)
  })

  it('purging marks entries deleted and records the purge itself', async () => {
    const before = await app.api<AuditListResponse>('GET', '/api/audit', { token: admin.token })
    const stats = await app.api<AuditStats>('GET', '/api/audit/stats', { token: admin.token })
    expect(stats.body.total).toBe(before.body.entries.length)
    const ids = before.body.entries.slice(0, 2).map((e) => e.id)
    expect((await app.api('POST', '/api/audit/purge', { token: supervisor.token, body: { ids } })).status).toBe(403)
    const purge = await app.api<{ marked: number }>('POST', '/api/audit/purge', { token: admin.token, body: { ids } })
    expect(purge.body.marked).toBe(2)
    const after = await app.api<AuditListResponse>('GET', '/api/audit', { token: admin.token })
    expect(after.body.entries.length).toBe(before.body.entries.length - 2 + 1)
    expect(after.body.entries[0].action).toBe('purge')
    const { rows } = await app.db.query('SELECT count(*)::int AS n FROM audit_log WHERE deleted_at IS NOT NULL')
    expect(rows[0].n).toBe(2)
  })
})

describe('evidence cannot be hard-deleted', () => {
  it('blocks DELETE on every evidence table', async () => {
    for (const table of ['inspection_sessions', 'inspection_samples', 'dimension_results', 'defect_results', 'sample_coils', 'pt_records', 'images', 'pdi_documents']) {
      await expect(app.db.query(`DELETE FROM ${table}`)).rejects.toThrow(/Hard delete is not allowed/)
    }
  })
})
