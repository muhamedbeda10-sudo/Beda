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
  ReRecordSampleResponse,
  SampleDetail,
  SampleSummary,
  SaveSampleRequest,
  SaveSampleResponse,
  SessionNotesResponse,
  SessionWithOrder,
  WizardContext,
} from '@qc/shared/api'
import type { Coil, DefectResult, DimensionResult, ImageAsset, Machine, ProductionOrder, WorkInstruction } from '@qc/shared/types'
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
      weldingWireBatch: 'WW-2401',
      testedLengths: [
        { lengthMm: 150, verdict: 'Accept' },
        { lengthMm: 90, verdict: 'Reject / Repair' },
      ],
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

  await app.api('POST', '/api/master/machines', { token: admin.token, body: { code: '58', name: 'A. Welding Line', line: 'LM4', displayName: '58-A. Welding Line-LM4', process: 'welding' } })
  await app.api('POST', '/api/master/machines', { token: admin.token, body: { code: '48', name: 'Painting Line', line: 'LM4', displayName: '48-Painting Line-LM4', process: 'paint' } })
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
    // Marked deleted by an administrator — it must stop appearing, but stay stored.
    expect((await app.api('DELETE', `/api/sessions/${res.body.id}`, { token: inspector.token })).status).toBe(403)
    expect((await app.api('DELETE', `/api/sessions/${res.body.id}`, { token: supervisor.token })).status).toBe(403)
    expect((await app.api('DELETE', `/api/sessions/${res.body.id}`, { token: admin.token })).status).toBe(204)
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
    expect((await app.api('DELETE', `/api/sessions/${started.body.id}`, { token: admin.token })).status).toBe(204)
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
      pt: { testFrequencyPct: 3, consumableLots: { Cleaner: '', Penetrant: 'x', Developer: 'y' }, testedLengths: [], imageIds: [] },
    })
    const res = await app.api<ApiErrorBody>('POST', `/api/sessions/${sessionId}/samples`, { token: inspector.token, body: noLots })
    expect(res.status).toBe(400)
    expect(res.body.error.message).toMatch(/Cleaner lot/)
    const { rows } = await app.db.query('SELECT count(*)::int AS n FROM inspection_samples')
    expect(rows[0].n).toBe(0)
  })

  it('rejects an "Other" defect without a description', async () => {
    const bare = await app.api<ApiErrorBody>('POST', `/api/sessions/${sessionId}/samples`, {
      token: inspector.token,
      body: weldSample('33333333-3333-4333-8333-333333333334', { defects: [{ defectName: 'Other', qty: 1, disposition: 'Hold', imageIds: [] }] }),
    })
    expect(bare.status).toBe(400)
    expect(bare.body.error.message).toMatch(/describe/i)
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
    expect(pt?.weldingWireBatch).toBe('WW-2401')
    expect(pt?.testedLengths.map((l) => [l.seq, l.lengthMm, l.verdict])).toEqual([
      [1, 150, 'Accept'],
      [2, 90, 'Reject / Repair'],
    ])
    // One rejected length rejects the record.
    expect(pt?.acceptOrRepair).toBe('Reject / Repair')
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
    // One defect record of two pieces: the pieces are what the dashboard adds up.
    expect(board.body.sessions[0].defectCount).toBe(1)
    expect(board.body.sessions[0].defectPieces).toBe(2)
    // Two samples of one piece each; the 2503 mm length fails its ±2 tolerance in both.
    expect(board.body.sessions[0].piecesInspected).toBe(2)
    expect(board.body.sessions[0].dimensionFailCount).toBe(2)
    // Two tested lengths on the first sample, two on the second: what counts toward 5% of the final quantity.
    expect(board.body.sessions[0].ptTestedCount).toBe(4)
    expect(board.body.holdCount).toBe(1)
    const history = await app.api<OrderHistory>('GET', `/api/orders/${weldOrder.id}/history`, { token: inspector.token })
    expect(history.body.sessions).toHaveLength(1)
    expect(history.body.samples).toHaveLength(2)
    const list = await app.api<SampleSummary[]>('GET', `/api/sessions/${sessionId}/samples`, { token: inspector.token })
    expect(list.body.map((s) => s.index)).toEqual([1, 2])
  })

  it('shows every session, open or in history, to everyone', async () => {
    // The supervisor opens a session of their own on the paint beam line.
    const theirs = await app.api<SessionWithOrder>('POST', '/api/sessions', { token: supervisor.token, body: { orderId: paintBeamOrder.id, startQty: 5 } })
    expect(theirs.status).toBe(201)

    // Open sessions are shared work (§4.4): an inspector sees and may join the supervisor's.
    const mine = await app.api<OpenSessionsResponse>('GET', '/api/sessions/open', { token: inspector.token })
    expect(mine.body.sessions.map((s) => s.id).sort()).toEqual([sessionId, theirs.body.id].sort())
    expect(mine.body.holdCount).toBe(1)

    const all = await app.api<OpenSessionsResponse>('GET', '/api/sessions/open', { token: supervisor.token })
    expect(all.body.sessions.map((s) => s.id).sort()).toEqual([sessionId, theirs.body.id].sort())

    // History is the factory's record too: an inspector reads everyone's.
    const myHistory = await app.api<HistoryResponse>('GET', '/api/sessions/history', { token: inspector.token })
    expect(myHistory.body.sessions.map((s) => s.id)).toContain(theirs.body.id)
    const myHold = await app.api<HistoryResponse>('GET', '/api/sessions/history?disposition=Hold', { token: inspector.token })
    expect(myHold.body.sessions.map((s) => s.id)).toEqual([sessionId])
    const allHistory = await app.api<HistoryResponse>('GET', '/api/sessions/history', { token: supervisor.token })
    expect(allHistory.body.sessions.length).toBeGreaterThan(1)

    expect((await app.api('DELETE', `/api/sessions/${theirs.body.id}`, { token: admin.token })).status).toBe(204)
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
    // Setup is entered once per session: the latest sample's is offered to the next one.
    expect(ctx.body.previousSetup?.drawing).toBe('BS9059/58')
    expect(ctx.body.previousSetup?.coils.map((c) => c.coilNumber)).toEqual(['C10021'])
    // Sample 2 carried a matching grade, so there is no acknowledgement to carry.
    expect(ctx.body.previousSetup?.gradeAcknowledgement).toBeNull()

    // The same item of the same order on ANOTHER machine (line L-4) is grey:
    // defects before. The same item on a different order (line L-3) is not.
    const elsewhere = await app.api<SessionWithOrder>('POST', '/api/sessions', { token: inspector.token, body: { orderId: weldOrderOnPaintLine.id, startQty: 5 } })
    expect(elsewhere.status).toBe(201)
    expect(elsewhere.body.defectCount).toBe(0)
    expect(elsewhere.body.priorDefectsElsewhere).toBe(true)
    expect((await app.api('DELETE', `/api/sessions/${elsewhere.body.id}`, { token: admin.token })).status).toBe(204)
    const other = await app.api<SessionWithOrder>('POST', '/api/sessions', { token: inspector.token, body: { orderId: paintBeamOrder.id, startQty: 5 } })
    expect(other.body.priorDefectsElsewhere).toBe(false)
    expect((await app.api('DELETE', `/api/sessions/${other.body.id}`, { token: admin.token })).status).toBe(204)

    // The same order line, a later session on the same machine: grey too.
    const later = await app.api<SessionWithOrder>('POST', '/api/sessions', { token: inspector.token, body: { orderId: weldOrder.id, startQty: 5 } })
    expect(later.body.defectCount).toBe(0)
    expect(later.body.priorDefectsElsewhere).toBe(true)
    expect((await app.api('DELETE', `/api/sessions/${later.body.id}`, { token: admin.token })).status).toBe(204)
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
    expect(ok.body.closedByName).toBe(inspector.user.name)
    expect(ok.body.version).toBe(1)
    const again = await app.api<ApiErrorBody>('POST', `/api/sessions/${sessionId}/close`, { token: inspector.token, body: { finalQty: 1, version: 1 } })
    expect(again.status).toBe(400)
  })

  it('keeps a closed session on the board while a defect of it is on Hold', async () => {
    // Closed sessions leave the board — unless a defect is still on Hold.
    const gone = await app.api<OpenSessionsResponse>('GET', '/api/sessions/open', { token: inspector.token })
    expect(gone.body.sessions.some((s) => s.id === sessionId)).toBe(false)
    const held = await app.api<DefectResult>('PATCH', `/api/samples/defects/${defect.id}`, {
      token: supervisor.token,
      body: { disposition: 'Hold', qty: 3, version: 1 },
    })
    expect(held.status).toBe(200)
    const board = await app.api<OpenSessionsResponse>('GET', '/api/sessions/open', { token: inspector.token })
    const closed = board.body.sessions.find((s) => s.id === sessionId)
    expect(closed?.status).toBe('Closed')
    expect(closed?.holdCount).toBe(1)
    // Back to the disposition the history tests below expect.
    expect((await app.api('PATCH', `/api/samples/defects/${defect.id}`, { token: supervisor.token, body: { disposition: 'Repair', qty: 3, version: 2 } })).status).toBe(200)
  })

  it('lets only an administrator mark a sample deleted, and drops it from the counts', async () => {
    const list = await app.api<SampleSummary[]>('GET', `/api/sessions/${sessionId}/samples`, { token: inspector.token })
    const second = list.body.find((sm) => sm.index === 2)!
    expect((await app.api('DELETE', `/api/samples/${second.id}`, { token: supervisor.token })).status).toBe(403)
    expect((await app.api('DELETE', `/api/samples/${second.id}`, { token: admin.token })).status).toBe(204)
    expect((await app.api('DELETE', `/api/samples/${second.id}`, { token: admin.token })).status).toBe(404)
    const after = await app.api<SampleSummary[]>('GET', `/api/sessions/${sessionId}/samples`, { token: inspector.token })
    expect(after.body.map((sm) => sm.index)).toEqual([1])
    const audit = await app.api<AuditListResponse>('GET', '/api/audit', { token: supervisor.token })
    expect(audit.body.entries.some((e) => e.entity === 'InspectionSample' && e.action === 'delete' && e.entityId === second.id)).toBe(true)
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

  it('re-records a sample as one unit from History, keeping its number and auditing the change', async () => {
    const list = await app.api<SampleSummary[]>('GET', `/api/sessions/${sessionId}/samples`, { token: inspector.token })
    const first = list.body.find((sm) => sm.index === 1)!
    const before = await app.api<SampleDetail>('GET', `/api/samples/${first.id}`, { token: inspector.token })
    const body = {
      ...weldSample('99999999-9999-4999-8999-999999999999'),
      drawing: 'BS9059/58-ALT',
      sampleQty: 4,
      dimensions: [{ name: 'Width', sequence: 1, nominal: 125, tolPlus: 0.5, tolMinus: 0.5, actual: 124.2, unit: 'mm', source: 'item-order' as const }],
      defects: [],
      version: before.body.sample.version,
    }
    const { submissionId: _drop, ...reRecord } = body
    // A closed session: the inspector may not, a supervisor may.
    expect((await app.api('PUT', `/api/sessions/${sessionId}/samples/${first.id}`, { token: inspector.token, body: reRecord })).status).toBe(403)
    const stale = await app.api<ApiErrorBody>('PUT', `/api/sessions/${sessionId}/samples/${first.id}`, { token: supervisor.token, body: { ...reRecord, version: 99 } })
    expect(stale.status).toBe(409)
    const ok = await app.api<ReRecordSampleResponse>('PUT', `/api/sessions/${sessionId}/samples/${first.id}`, { token: supervisor.token, body: reRecord })
    expect(ok.status).toBe(200)
    expect(ok.body.index).toBe(1)
    expect(ok.body.version).toBe(before.body.sample.version + 1)

    const after = await app.api<SampleDetail>('GET', `/api/samples/${first.id}`, { token: inspector.token })
    expect(after.body.sample.drawing).toBe('BS9059/58-ALT')
    expect(after.body.sample.sampleQty).toBe(4)
    expect(after.body.dimensions.map((d) => [d.name, d.actual, d.status])).toEqual([['Width', 124.2, 'Fail']])
    expect(after.body.defects).toEqual([])
    expect(after.body.pt?.testedLengths.map((l) => l.lengthMm)).toEqual([150, 90])
    // The retired rows are still there, marked deleted.
    const { rows } = await app.db.query<{ n: number }>('SELECT count(*)::int AS n FROM dimension_results WHERE sample_id = $1 AND deleted_at IS NOT NULL', [first.id])
    expect(rows[0].n).toBe(3)
    const audit = await app.api<AuditListResponse>('GET', '/api/audit', { token: supervisor.token })
    const mine = audit.body.entries.filter((e) => e.entityId === first.id && e.action === 'update')
    expect(mine.some((e) => e.field === 'drawing' && e.newValue === 'BS9059/58-ALT')).toBe(true)
    expect(mine.some((e) => e.field === 'reRecorded')).toBe(true)
  })

  it('reopens a closed session for a supervisor so samples can be added again', async () => {
    const closed = await app.api<SessionWithOrder>('GET', `/api/sessions/${sessionId}`, { token: inspector.token })
    expect(closed.body.status).toBe('Closed')
    expect((await app.api('POST', `/api/sessions/${sessionId}/reopen`, { token: inspector.token, body: { version: closed.body.version } })).status).toBe(403)
    const reopened = await app.api<SessionWithOrder>('POST', `/api/sessions/${sessionId}/reopen`, { token: supervisor.token, body: { version: closed.body.version } })
    expect(reopened.status).toBe(200)
    expect(reopened.body.status).toBe('Open')
    expect(reopened.body.closedAt).toBeUndefined()
    // Close it again so the tests below see a closed session.
    const again = await app.api<SessionWithOrder>('POST', `/api/sessions/${sessionId}/close`, { token: inspector.token, body: { finalQty: 480, version: reopened.body.version } })
    expect(again.status).toBe(200)
  })
})

describe('paint machine', () => {
  it('tells the wizard the process and hands it the paint flow', async () => {
    const started = await app.api<SessionWithOrder>('POST', '/api/sessions', { token: inspector.token, body: { orderId: paintOrder.id, startQty: 450 } })
    const ctx = await app.api<WizardContext>('GET', `/api/sessions/${started.body.id}/wizard`, { token: inspector.token })
    expect(ctx.body.process).toBe('paint')
    expect(ctx.body.machine?.process).toBe('paint')
    expect((await app.api('DELETE', `/api/sessions/${started.body.id}`, { token: admin.token })).status).toBe(204)
  })

  it('needs no drawing, but photos of the sample and three thickness readings', async () => {
    const started = await app.api<SessionWithOrder>('POST', '/api/sessions', { token: inspector.token, body: { orderId: paintOrder.id, startQty: 450 } })
    const sid = started.body.id
    const reading = (actual: number | null) => ({ name: 'Paint thickness', sequence: 1, nominal: 60, tolPlus: 10, tolMinus: 5, actual, unit: 'µm', source: 'item-order' as const })
    const missing = await app.api<ApiErrorBody>('POST', `/api/sessions/${sid}/samples`, {
      token: inspector.token,
      body: { submissionId: '77777777-7777-4777-8777-777777777777', drawing: '', sampleQty: 1, dimensions: [], defects: [], coils: [] },
    })
    expect(missing.status).toBe(400)
    expect(missing.body.error.message).toMatch(/photo/i)

    const photo = await uploadImage(inspector, 9, { sessionId: sid })
    const twoReadings = await app.api<ApiErrorBody>('POST', `/api/sessions/${sid}/samples`, {
      token: inspector.token,
      body: {
        submissionId: '77777777-7777-4777-8777-777777777777',
        drawing: '',
        sampleQty: 1,
        dimensions: [reading(61), reading(59)],
        defects: [],
        coils: [],
        paint: { imageIds: [photo.id] },
      },
    })
    expect(twoReadings.status).toBe(400)
    expect(twoReadings.body.error.message).toMatch(/3 paint thickness readings/i)

    const ok = await app.api<SaveSampleResponse>('POST', `/api/sessions/${sid}/samples`, {
      token: inspector.token,
      body: {
        submissionId: '77777777-7777-4777-8777-777777777777',
        drawing: '',
        sampleQty: 2,
        dimensions: [reading(61), { ...reading(59), sequence: 2 }, { ...reading(75), sequence: 3 }],
        defects: [],
        coils: [],
        paint: { notes: 'RAL7016 ok', imageIds: [photo.id] },
      },
    })
    expect(ok.status).toBe(201)
    const detail = await app.api<SampleDetail>('GET', `/api/samples/${ok.body.sampleId}`, { token: inspector.token })
    expect(detail.body.paint?.imageIds).toEqual([photo.id])
    expect(detail.body.paint?.notes).toBe('RAL7016 ok')
    // The three readings are dimension rows judged against the tolerance: 75 is over 60 + 10.
    expect(detail.body.dimensions.map((d) => [d.sequence, d.actual, d.status])).toEqual([
      [1, 61, 'Pass'],
      [2, 59, 'Pass'],
      [3, 75, 'Fail'],
    ])
  })
})

describe('notes about the order (§5.8)', () => {
  let sid: string
  let noteId: string

  beforeAll(async () => {
    const started = await app.api<SessionWithOrder>('POST', '/api/sessions', { token: inspector.token, body: { orderId: weldOrder.id, startQty: 20 } })
    sid = started.body.id
  })

  it('saves a note with its photo together with the sample, on the session', async () => {
    const photo = await uploadImage(inspector, 21, { sessionId: sid })
    const res = await app.api<SaveSampleResponse>('POST', `/api/sessions/${sid}/samples`, {
      token: inspector.token,
      body: weldSample('99999999-9999-4999-8999-999999999901', { note: { text: '  Customer wants the beams strapped in fives.  ', imageIds: [photo.id] } }),
    })
    expect(res.status).toBe(201)

    const notes = await app.api<SessionNotesResponse>('GET', `/api/sessions/${sid}/notes`, { token: inspector.token })
    expect(notes.status).toBe(200)
    expect(notes.body.notes).toHaveLength(1)
    const [note] = notes.body.notes
    noteId = note.id
    expect(note.text).toBe('Customer wants the beams strapped in fives.')
    expect(note.imageIds).toEqual([photo.id])
    expect(note.authorName).toBe('Inspector One')
    expect(note.sampleId).toBe(res.body.sampleId)
    expect(note.sampleIndex).toBe(1)
    expect(note.workCenterCode).toBe('58')
    expect(note.itemCode).toBe('125185TA3')

    const session = await app.api<SessionWithOrder>('GET', `/api/sessions/${sid}`, { token: inspector.token })
    expect(session.body.noteCount).toBe(1)
  })

  it('writes nothing for a note with neither text nor photos', async () => {
    const res = await app.api<SaveSampleResponse>('POST', `/api/sessions/${sid}/samples`, {
      token: inspector.token,
      body: weldSample('99999999-9999-4999-8999-999999999902', { note: { text: '   ', imageIds: [] } }),
    })
    expect(res.status).toBe(201)
    const notes = await app.api<SessionNotesResponse>('GET', `/api/sessions/${sid}/notes`, { token: inspector.token })
    expect(notes.body.notes).toHaveLength(1)
  })

  it('refuses a note whose photo does not exist, writing nothing', async () => {
    const before = (await app.db.query('SELECT count(*)::int AS n FROM inspection_samples WHERE session_id = $1', [sid])).rows[0].n
    const res = await app.api<ApiErrorBody>('POST', `/api/sessions/${sid}/samples`, {
      token: inspector.token,
      body: weldSample('99999999-9999-4999-8999-999999999903', { note: { text: 'x', imageIds: ['00000000-0000-4000-8000-000000000000'] } }),
    })
    expect(res.status).toBe(400)
    const after = (await app.db.query('SELECT count(*)::int AS n FROM inspection_samples WHERE session_id = $1', [sid])).rows[0].n
    expect(after).toBe(before)
  })

  it('shows the note to a later session on the same line, but not on another machine of the same order', async () => {
    // The same line again: the note is there, with where it was written.
    const sameLine = await app.api<SessionWithOrder>('POST', '/api/sessions', { token: supervisor.token, body: { orderId: weldOrder.id, startQty: 0 } })
    const ctx = await app.api<WizardContext>('GET', `/api/sessions/${sameLine.body.id}/wizard`, { token: supervisor.token })
    expect(ctx.status).toBe(200)
    const fromWelding = ctx.body.orderNotes.find((n) => n.id === noteId)
    expect(fromWelding?.workCenterCode).toBe('58')
    expect(fromWelding?.sessionSeq).toBeGreaterThan(0)
    const viaOrder = await app.api<SessionNotesResponse>('GET', `/api/orders/${weldOrder.id}/notes`, { token: inspector.token })
    expect(viaOrder.body.notes.some((n) => n.id === noteId)).toBe(true)
    // The same order and item on the paint line is another line: its notes are its own.
    const otherMachine = await app.api<SessionWithOrder>('POST', '/api/sessions', { token: supervisor.token, body: { orderId: weldOrderOnPaintLine.id, startQty: 0 } })
    const otherCtx = await app.api<WizardContext>('GET', `/api/sessions/${otherMachine.body.id}/wizard`, { token: supervisor.token })
    expect(otherCtx.body.orderNotes.find((n) => n.id === noteId)).toBeUndefined()
    const viaOther = await app.api<SessionNotesResponse>('GET', `/api/orders/${weldOrderOnPaintLine.id}/notes`, { token: inspector.token })
    expect(viaOther.body.notes.some((n) => n.id === noteId)).toBe(false)
    await app.api('DELETE', `/api/sessions/${sameLine.body.id}`, { token: admin.token })
    await app.api('DELETE', `/api/sessions/${otherMachine.body.id}`, { token: admin.token })
  })

  it('lets only an administrator mark a note deleted, and audits it', async () => {
    expect((await app.api('DELETE', `/api/sessions/${sid}/notes/${noteId}`, { token: supervisor.token })).status).toBe(403)
    expect((await app.api('DELETE', `/api/sessions/${sid}/notes/${noteId}`, { token: admin.token })).status).toBe(204)
    expect((await app.api('DELETE', `/api/sessions/${sid}/notes/${noteId}`, { token: admin.token })).status).toBe(404)
    const notes = await app.api<SessionNotesResponse>('GET', `/api/sessions/${sid}/notes`, { token: inspector.token })
    expect(notes.body.notes).toHaveLength(0)
    const audit = await app.api<AuditListResponse>('GET', '/api/audit', { token: admin.token })
    expect(audit.body.entries.some((e) => e.entity === 'SessionNote' && e.entityId === noteId && e.action === 'delete')).toBe(true)
    expect(audit.body.entries.some((e) => e.entity === 'SessionNote' && e.entityId === noteId && e.action === 'create')).toBe(true)
  })
})

describe('a session with no sample', () => {
  it('cannot be closed, but its inspector can discard it', async () => {
    const started = await app.api<SessionWithOrder>('POST', '/api/sessions', { token: inspector.token, body: { orderId: weldOrder.id, startQty: 5 } })
    const sid = started.body.id
    const close = await app.api<ApiErrorBody>('POST', `/api/sessions/${sid}/close`, { token: inspector.token, body: { finalQty: 5, version: 0 } })
    expect(close.status).toBe(400)
    expect(close.body.error.message).toMatch(/No sample/)
    // Someone else's empty session is not an inspector's to discard; the owner's is.
    const other = await app.register('insp2', 'Inspector Two')
    expect((await app.api('POST', `/api/sessions/${sid}/discard`, { token: other.token })).status).toBe(403)
    expect((await app.api('POST', `/api/sessions/${sid}/discard`, { token: inspector.token })).status).toBe(204)
    const board = await app.api<OpenSessionsResponse>('GET', '/api/sessions/open', { token: admin.token })
    expect(board.body.sessions.some((s) => s.id === sid)).toBe(false)
    const audit = await app.api<AuditListResponse>('GET', '/api/audit', { token: admin.token })
    expect(audit.body.entries.some((e) => e.entity === 'InspectionSession' && e.entityId === sid && e.action === 'delete' && /Discarded/.test(e.newValue ?? ''))).toBe(true)
  })

  it('refuses to discard a session that has samples', async () => {
    const board = await app.api<OpenSessionsResponse>('GET', '/api/sessions/open', { token: admin.token })
    const withSamples = board.body.sessions.find((s) => (s.sampleCount ?? 0) > 0)!
    const res = await app.api<ApiErrorBody>('POST', `/api/sessions/${withSamples.id}/discard`, { token: admin.token })
    expect(res.status).toBe(400)
    expect(res.body.error.message).toMatch(/has samples/)
  })
})

describe('a make-to-stock machine', () => {
  let stockOrderId: string
  let sid: string

  beforeAll(async () => {
    await app.api('POST', '/api/master/machines', {
      token: admin.token,
      body: { code: '21', name: '400T Press', displayName: '21-400T Press', factory: 'Factory 3', process: 'forming' },
    })
    await app.api('POST', '/api/master/work-center-defects', { token: admin.token, body: { workCenterCode: '21', defectName: 'Crack' } })
  })

  it('starts a session without an order, on the machine’s fixed STOCK line, with the quantity produced', async () => {
    const res = await app.api<SessionWithOrder>('POST', '/api/sessions', { token: inspector.token, body: { workCenterCode: '21', producedQty: 120 } })
    expect(res.status).toBe(201)
    sid = res.body.id
    expect(res.body.seq).toBe(1)
    expect(res.body.workCenterCode).toBe('21')
    expect(res.body.producedQty).toBe(120)
    expect(res.body.startQtyConfirmed).toBeUndefined()
    expect(res.body.order?.orderNumber).toBe('STOCK')
    expect(res.body.order?.lineKey).toBe('STOCK-21')
    expect(res.body.order?.item).toBe('Connector (right + left)')
    expect(res.body.order?.itemCode).toBe('CONNECTOR-RL')
    stockOrderId = res.body.orderId

    // The next session lands on the same line with the next seq.
    const again = await app.api<SessionWithOrder>('POST', '/api/sessions', { token: inspector.token, body: { workCenterCode: '21', producedQty: 80 } })
    expect(again.body.orderId).toBe(stockOrderId)
    expect(again.body.seq).toBe(2)
    await app.api('DELETE', `/api/sessions/${again.body.id}`, { token: admin.token })
  })

  it('refuses a stock start on a machine that works to order', async () => {
    const res = await app.api<ApiErrorBody>('POST', '/api/sessions', { token: inspector.token, body: { workCenterCode: '58', producedQty: 1 } })
    expect(res.status).toBe(400)
    expect(res.body.error.message).toMatch(/works to order/)
  })

  it('records a sample with coils and defects but no drawing', async () => {
    const ctx = await app.api<WizardContext>('GET', `/api/sessions/${sid}/wizard`, { token: inspector.token })
    expect(ctx.status).toBe(200)
    expect(ctx.body.order.orderNumber).toBe('STOCK')
    expect(ctx.body.workCenterDefects.map((d) => d.defectName)).toEqual(['Crack'])
    const res = await app.api<SaveSampleResponse>('POST', `/api/sessions/${sid}/samples`, {
      token: inspector.token,
      body: {
        submissionId: '99999999-9999-4999-8999-999999999911',
        drawing: '',
        sampleQty: 3,
        dimensions: [{ name: 'Hole pitch', sequence: 1, nominal: 40, tolPlus: 0.5, tolMinus: 0.5, actual: 40.2, unit: 'mm', source: 'manual' }],
        defects: [{ defectName: 'Crack', qty: 1, disposition: 'Rejected', imageIds: [] }],
        // A coil typed by hand, not yet in the register: the number alone.
        coils: [{ coilNumber: 'C55555' }],
      },
    })
    expect(res.status).toBe(201)
    expect(res.body.index).toBe(1)

    // Recorded by number alone: marked as typed, nothing to fill in yet.
    const before = await app.api<SampleDetail>('GET', `/api/samples/${res.body.sampleId}`, { token: inspector.token })
    expect(before.body.coils[0].coilId).toBeUndefined()
    expect(before.body.coils[0].grade).toBeUndefined()
    expect(before.body.coils[0].register).toBeUndefined()
    // Once the coil sheet arrives, the register's details show next to it; the record itself is unchanged.
    await app.api('POST', '/api/coils/import', { token: admin.token, body: { rows: [{ coilNumber: 'c55555', grade: 'S235JR', supplier: 'Ezz Steel', thickness: 3 }] } })
    const after = await app.api<SampleDetail>('GET', `/api/samples/${res.body.sampleId}`, { token: inspector.token })
    expect(after.body.coils[0].grade).toBeUndefined()
    expect(after.body.coils[0].register).toEqual({ grade: 'S235JR', supplier: 'Ezz Steel', thickness: 3 })
    const board = await app.api<OpenSessionsResponse>('GET', '/api/sessions/open', { token: inspector.token })
    const mine = board.body.sessions.find((s) => s.id === sid)
    expect(mine?.defectCount).toBe(1)
    expect(mine?.producedQty).toBe(120)
  })

  it('brings the STOCK line back after a catalogue clear retired it', async () => {
    // What POST /orders/clear does to every line, applied to this one only.
    await app.db.query(`UPDATE production_orders SET deleted_at = now() WHERE id = $1`, [stockOrderId])
    const res = await app.api<SessionWithOrder>('POST', '/api/sessions', { token: inspector.token, body: { workCenterCode: '21', producedQty: 10 } })
    expect(res.status).toBe(201)
    expect(res.body.orderId).toBe(stockOrderId)
    await app.api('DELETE', `/api/sessions/${res.body.id}`, { token: admin.token })
  })
})

describe('a machine that takes dimensions from the inspector', () => {
  it('hands the wizard no configured dimensions while switched off, and them again once on', async () => {
    const machines = await app.api<Machine[]>('GET', '/api/master/machines', { token: admin.token })
    const weld = machines.body.find((m) => m.code === '58')!
    expect(weld.usesItemDimensions).toBe(true)
    const started = await app.api<SessionWithOrder>('POST', '/api/sessions', { token: inspector.token, body: { orderId: weldOrder.id, startQty: 0 } })
    const sid = started.body.id
    const before = await app.api<WizardContext>('GET', `/api/sessions/${sid}/wizard`, { token: inspector.token })
    expect(before.body.dimensionOrder.length).toBeGreaterThan(0)

    const { id: _id, deletedAt: _d, ...fields } = weld
    const off = await app.api<Machine>('PUT', `/api/master/machines/${weld.id}`, { token: admin.token, body: { ...fields, usesItemDimensions: false } })
    expect(off.status).toBe(200)
    const manual = await app.api<WizardContext>('GET', `/api/sessions/${sid}/wizard`, { token: inspector.token })
    expect(manual.body.machine?.usesItemDimensions).toBe(false)
    expect(manual.body.dimensionOrder).toEqual([])
    // What the inspector typed on the last sample still carries forward.
    expect(manual.body.previousDimensions.length).toBeGreaterThan(0)

    await app.api('PUT', `/api/master/machines/${weld.id}`, { token: admin.token, body: { ...fields, usesItemDimensions: true } })
    const again = await app.api<WizardContext>('GET', `/api/sessions/${sid}/wizard`, { token: inspector.token })
    expect(again.body.dimensionOrder.length).toBeGreaterThan(0)
    await app.api('DELETE', `/api/sessions/${sid}`, { token: admin.token })
  })
})

describe('work instructions', () => {
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n')
  let firstId: string

  async function uploadInstruction(s: Session, fields: Record<string, string>, bytes: Buffer = pdf, filename = 'wi.pdf') {
    const form = new FormData()
    form.append('file', new Blob([bytes], { type: 'application/pdf' }), filename)
    for (const [k, v] of Object.entries(fields)) form.append(k, v)
    return app.api<WorkInstruction>('POST', '/api/work-instructions', { token: s.token, raw: form })
  }

  it('lets an admin upload a PDF for a process and step, and refuses anything else', async () => {
    const notPdf = await uploadInstruction(admin, { code: 'WI-X', title: 'Not a PDF', process: 'welding', step: 'defects' }, Buffer.from('hello'))
    expect(notPdf.status).toBe(400)
    const asInspector = await uploadInstruction(inspector, { code: 'WI-X', title: 'No', process: 'welding', step: 'defects' })
    expect(asInspector.status).toBe(403)
    const res = await uploadInstruction(admin, { code: 'WI-PD-03-04', title: 'Visual test method', issueNo: '1', issueDate: '2025-01-02', process: 'welding', step: 'defects' })
    expect(res.status).toBe(201)
    expect(res.body.code).toBe('WI-PD-03-04')
    expect(res.body.issueDate).toMatch(/^2025-01-02/)
    expect(res.body.byteSize).toBe(pdf.length)
    firstId = res.body.id
  })

  it('serves the bytes back to any signed-in user, and offers the document on the right wizard step', async () => {
    const content = await app.api<string>('GET', `/api/work-instructions/${firstId}/content`, { token: inspector.token })
    expect(content.status).toBe(200)
    expect(content.headers.get('content-type')).toBe('application/pdf')
    const weldSession = await app.api<SessionWithOrder>('POST', '/api/sessions', { token: inspector.token, body: { orderId: weldOrder.id, startQty: 1 } })
    const ctx = await app.api<WizardContext>('GET', `/api/sessions/${weldSession.body.id}/wizard`, { token: inspector.token })
    expect(ctx.body.process).toBe('welding')
    expect(ctx.body.workInstructions.map((w) => [w.code, w.step])).toEqual([['WI-PD-03-04', 'defects']])
    await app.api('DELETE', `/api/sessions/${weldSession.body.id}`, { token: admin.token })
    // A paint machine does not see a welding document.
    const paintSession = await app.api<SessionWithOrder>('POST', '/api/sessions', { token: inspector.token, body: { orderId: paintOrder.id, startQty: 1 } })
    const paintCtx = await app.api<WizardContext>('GET', `/api/sessions/${paintSession.body.id}/wizard`, { token: inspector.token })
    expect(paintCtx.body.workInstructions).toEqual([])
    await app.api('DELETE', `/api/sessions/${paintSession.body.id}`, { token: admin.token })
  })

  it('supersedes the issue in force when a new issue of the same code is uploaded', async () => {
    const next = await uploadInstruction(admin, { code: 'wi-pd-03-04', title: 'Visual test method', issueNo: '2', process: 'welding', step: 'defects' })
    expect(next.status).toBe(201)
    const inForce = await app.api<WorkInstruction[]>('GET', '/api/work-instructions?process=welding', { token: inspector.token })
    expect(inForce.body.map((w) => [w.id, w.issueNo])).toEqual([[next.body.id, '2']])
    const history = await app.api<WorkInstruction[]>('GET', '/api/work-instructions?history=1', { token: admin.token })
    const old = history.body.find((w) => w.id === firstId)!
    expect(old.supersededById).toBe(next.body.id)
    // The old issue's bytes are still readable.
    expect((await app.api('GET', `/api/work-instructions/${firstId}/content`, { token: inspector.token })).status).toBe(200)

    expect((await app.api('DELETE', `/api/work-instructions/${next.body.id}`, { token: admin.token })).status).toBe(204)
    const after = await app.api<WorkInstruction[]>('GET', '/api/work-instructions', { token: inspector.token })
    expect(after.body).toEqual([])
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
    for (const table of ['inspection_sessions', 'inspection_samples', 'dimension_results', 'defect_results', 'sample_coils', 'pt_records', 'images', 'pdi_documents', 'session_notes', 'session_note_images']) {
      await expect(app.db.query(`DELETE FROM ${table}`)).rejects.toThrow(/Hard delete is not allowed/)
    }
  })
})
