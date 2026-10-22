import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { emptyQualityData, QUALITY_FORMS, type QualityKind, type QualityRecord, type QualityRecordList, type QualityRecordOptions, type NcrData, type CustomerComplaintData, type SaveQualityRecordRequest } from '@qc/shared/qualityRecords'
import type { ApiErrorBody } from '@qc/shared/api'
import type { ImageAsset, Machine } from '@qc/shared/types'
import { TestApp, tinyJpeg, type Session } from './harness'

const app = new TestApp()
let admin: Session, writer: Session, ncrReader: Session, complaintReader: Session, outsider: Session
let machine: Machine
const day = '2026-10-22'
const path = (kind: QualityKind) => `/api${QUALITY_FORMS[kind].path}`
const ncr = (patch: Partial<NcrData> = {}): NcrData => ({ ...emptyQualityData('ncr', 'Raised person', day) as NcrData, orderNumber: 'ORD-100', factories: ['Factory 1'], machineIds: [machine.id], sources: ['Product non-conformity', 'Customer complaint'], totalQuantity: '100', rejectedQuantity: '5', description: 'NCR full form', process: 'Welding', assignedTo: 'Supervisor', ...patch })
const complaint = (patch: Partial<CustomerComplaintData> = {}): CustomerComplaintData => ({ ...emptyQualityData('customer-complaint', 'Writer', day) as CustomerComplaintData, orderNumber: 'ORD-100', productName: 'Upright', itemCode: 'UP80', issues: ['Dimensions', 'Packaging'], description: 'Complaint full form', quantity: '5 pcs', contactPerson: 'Customer contact', email: 'contact@example.com', telephone: '+20 1234', dimensions: '80 x 60', colour: 'Blue', invoiceNumber: 'INV-123', invoiceDate: '2026-10-20', ...patch })
const body = (kind: QualityKind, data?: SaveQualityRecordRequest['data']): SaveQualityRecordRequest => ({ submissionId: randomUUID(), reference: '', date: day, data: data ?? (kind === 'ncr' ? ncr() : complaint()), imageIds: [] })
const post = (kind: QualityKind, data = body(kind), as = writer) => app.api<QualityRecord & ApiErrorBody>('POST', path(kind), { token: as.token, body: data })
const edit = (record: QualityRecord, data = record.data, overrides: Partial<SaveQualityRecordRequest> = {}, as = writer) => app.api<QualityRecord & ApiErrorBody>('PUT', `${path(record.kind)}/${record.id}`, { token: as.token, body: { reference: record.reference, date: record.date, data, imageIds: record.imageIds, version: record.version, ...overrides } })
const read = (record: QualityRecord, as: Session) => app.api<QualityRecord>('GET', `${path(record.kind)}/${record.id}`, { token: as.token })
const list = (kind: QualityKind, query = '', as = writer) => app.api<QualityRecordList>('GET', `${path(kind)}${query}`, { token: as.token })
async function upload(as = writer) {
  const bytes = tinyJpeg(73)
  const form = new FormData()
  form.set('file', new Blob([bytes], { type: 'image/jpeg' }), 'evidence.jpg')
  for (const [k, v] of Object.entries({ originalFilename: 'evidence.jpg', width: '10', height: '10', sha256: createHash('sha256').update(bytes).digest('hex'), thumbnailDataUrl: 'data:image/jpeg;base64,AAAA' })) form.set(k, v)
  const response = await app.api<ImageAsset>('POST', '/api/images', { token: as.token, raw: form })
  expect(response.status).toBe(201)
  return response.body.id
}

beforeAll(async () => {
  await app.start(); await app.resetDatabase()
  admin = await app.register('admin', 'Administrator')
  const sessions: Session[] = []
  for (const username of ['writer', 'ncr-reader', 'complaint-reader', 'outsider']) {
    expect((await app.api('POST', '/api/users', { token: admin.token, body: { username, password: 'Password#1', name: username, role: 'viewer' } })).status).toBe(201)
    sessions.push(await app.login(username))
  }
  ;[writer, ncrReader, complaintReader, outsider] = sessions
  for (const [as, permissions] of [
    [writer, ['view-ncr', 'record-ncr', 'view-customer-complaints', 'record-customer-complaint']],
    [ncrReader, ['view-ncr']], [complaintReader, ['view-customer-complaints']],
  ] as const) expect((await app.api('PUT', `/api/users/${as.user.id}/permissions`, { token: admin.token, body: { overrides: permissions.map((permission) => ({ permission, granted: true })) } })).status).toBe(200)
  machine = (await app.api<Machine>('POST', '/api/master/machines', { token: admin.token, body: { code: '31', name: 'Welding', line: 'LM1', displayName: '31 Welding', process: 'welding', factory: 'Factory 1' } })).body
  expect((await app.api('POST', '/api/orders/import', { token: admin.token, body: { rows: [
    { lineKey: 'QR-1', orderNumber: 'ORD-100', customer: 'Customer A', item: 'Upright', itemCode: 'UP80', workCenterCode: '31' },
    { lineKey: 'QR-2', orderNumber: 'ORD-200', customer: 'Customer A', item: 'Beam', itemCode: 'BM10', workCenterCode: '31' },
  ] } })).status).toBe(200)
})
afterAll(() => app.stop())

describe('separate quality registers', () => {
  it('enforces each screen and recording permission on choices, lists, detail, creation and corrections', async () => {
    for (const kind of ['ncr', 'customer-complaint'] as const) {
      for (const suffix of ['', '/options', '/orders', '/items?orderNumber=ORD-100', `/${randomUUID()}`]) expect((await app.api('GET', path(kind) + suffix, { token: outsider.token })).status).toBe(403)
      expect((await post(kind, body(kind), outsider)).status).toBe(403)
    }
    const nr = await post('ncr'); expect(nr.status, JSON.stringify(nr.body)).toBe(201)
    expect((await read(nr.body, ncrReader)).status).toBe(200)
    expect((await read(nr.body, complaintReader)).status).toBe(403)
    expect((await edit(nr.body, nr.body.data, {}, ncrReader)).status).toBe(403)
    expect((await app.api('GET', `${path('customer-complaint')}/${nr.body.id}`, { token: writer.token })).status).toBe(404)
    expect((await post('customer-complaint', body('customer-complaint'), complaintReader)).status).toBe(403)
  })

  it('records every NCR field, snapshots document control and derives the customer and machines from the register', async () => {
    const data = ncr({ customer: 'Forged', immediateAction: 'Segregate stock', responsiblePerson: 'Shift leader', dispositions: ['Repair', 'Concession'], correctiveActionRequired: true, rootCause: 'Incorrect jig', completedBy: 'Engineer', correctiveActions: [{ description: 'Replace jig', responsibility: 'Maintenance', completionDate: '2026-10-25' }], effectivenessDetails: 'Next batch checked', effectiveness: 'Effective', effectivenessDate: '2026-10-26' })
    const result = await post('ncr', body('ncr', data))
    expect(result.status, JSON.stringify(result.body)).toBe(201)
    expect(result.body.reference).toMatch(/^NCR-2026-\d{6}$/)
    expect(result.body.form).toEqual({ code: 'F-QHSE-03-01', issue: '2', issueDate: '2022-11-17' })
    expect(result.body.data).toMatchObject({ ...data, customer: 'Customer A', machines: [{ id: machine.id, code: '31', displayName: '31 Welding', factory: 'Factory 1' }] })
    expect(result.body.createdById).toBe(writer.user.id)
    expect((await app.db.query("SELECT action FROM audit_log WHERE entity = 'NCR' AND entity_id = $1", [result.body.id])).rows).toEqual([{ action: 'create' }])
  })

  it('records all complaint fields from the order, including contact, invoice, quantities, signature and multiple issues', async () => {
    const data = complaint({ customer: 'Forged', nonComplianceDetails: 'Damaged packaging', issueOther: 'Details', processedQuantity: '10', lostQuantity: '2 replaced', signature: 'Signed copy attached' })
    const result = await post('customer-complaint', body('customer-complaint', data))
    expect(result.status, JSON.stringify(result.body)).toBe(201)
    expect(result.body.reference).toMatch(/^CC-2026-\d{6}$/)
    expect(result.body.form).toEqual({ code: 'F-Q-03-01', issue: '01', issueDate: '2016-04-01' })
    expect(result.body.data).toEqual({ ...data, customer: 'Customer A' })
    const opened = await read(result.body, complaintReader)
    expect(opened.status).toBe(200); expect(opened.body.data).toEqual(result.body.data)
    const options = (await app.api<QualityRecordOptions>('GET', `${path('ncr')}/options`, { token: ncrReader.token })).body
    expect(options.factories).toContain('Factory 1'); expect(options.people.map((p) => p.id)).toContain(writer.user.id)
  })

  it('accepts an audit or environmental NCR without an order, machines or product quantities', async () => {
    const result = await post('ncr', body('ncr', ncr({ orderNumber: '', factories: [], machineIds: [], sources: ['Internal audit'], totalQuantity: '', rejectedQuantity: '' })))
    expect(result.status, JSON.stringify(result.body)).toBe(201)
    expect(result.body.data).toMatchObject({ orderNumber: '', machines: [], customer: '' })
  })

  it('allocates distinct references concurrently and replays the same submission without duplicates', async () => {
    const data = body('ncr')
    const repeated = await Promise.all([post('ncr', data), post('ncr', data)])
    expect(repeated.map((r) => r.status).sort()).toEqual([200, 201]); expect(repeated[0].body.id).toBe(repeated[1].body.id)
    expect((await post('ncr', { ...data, data: { ...data.data, description: 'Changed' } })).status).toBe(409)
    expect((await post('ncr', data, admin)).status).toBe(409)
    const many = await Promise.all(Array.from({ length: 4 }, () => post('ncr')))
    expect(many.map((r) => r.status)).toEqual([201, 201, 201, 201])
    expect(new Set(many.map((r) => r.body.reference)).size).toBe(4)
    const custom = await post('customer-complaint', { ...body('customer-complaint'), reference: 'CUSTOM-001' })
    expect(custom.status).toBe(201)
    expect((await post('customer-complaint', { ...body('customer-complaint'), reference: ' custom-001 ' })).status).toBe(409)
  })

  it('updates follow-up fields atomically, audits the changes and rejects stale edits', async () => {
    const created = (await post('ncr')).body
    const data = { ...created.data as NcrData, rootCause: 'Follow-up root cause', correctiveActionRequired: true, correctiveActions: [{ description: 'Train operators', responsibility: 'Supervisor', completionDate: '2026-11-01' }] }
    const updated = await edit(created, data)
    expect(updated.status, JSON.stringify(updated.body)).toBe(200); expect(updated.body.version).toBe(1)
    expect(updated.body.createdById).toBe(created.createdById)
    expect((await edit(updated.body)).body.version).toBe(1)
    const stale = await edit(created, { ...data, rootCause: 'Overwriting newer work' })
    expect(stale.status).toBe(409); expect(stale.body.error.code).toBe('conflict')
    expect((await read(created, ncrReader)).body.data).toMatchObject({ rootCause: 'Follow-up root cause' })
    const audits = (await app.db.query<{ field: string }>("SELECT field FROM audit_log WHERE entity = 'NCR' AND entity_id = $1 AND action = 'update'", [created.id])).rows.map((r) => r.field)
    expect(audits.sort()).toEqual(['correctiveActionRequired', 'correctiveActions', 'rootCause'].sort())
  })

  it('keeps images private to the correct register, retains removed evidence and can restore it on an edit', async () => {
    const image = await upload()
    const created = (await post('ncr', { ...body('ncr'), imageIds: [image] })).body
    const content = (as: Session) => app.api('GET', `/api/images/${image}/content`, { token: as.token })
    expect((await content(ncrReader)).status).toBe(200); expect((await content(complaintReader)).status).toBe(404)
    const removed = (await edit(created, created.data, { imageIds: [] })).body
    expect(removed.imageIds).toEqual([]); expect((await content(ncrReader)).status).toBe(404)
    expect((await app.db.query('SELECT removed_at FROM quality_record_images WHERE record_id = $1', [created.id])).rows[0].removed_at).toBeTruthy()
    const restored = await edit(removed, removed.data, { imageIds: [image] })
    expect(restored.status).toBe(200); expect(restored.body.imageIds).toEqual([image]); expect((await content(ncrReader)).status).toBe(200)
    const privatePhoto = await upload(admin)
    expect((await post('customer-complaint', { ...body('customer-complaint'), imageIds: [privatePhoto] })).status).toBe(403)
    await expect(app.db.query('DELETE FROM quality_record_images WHERE record_id = $1', [created.id])).rejects.toThrow()
  })

  it('rejects invalid dates, quantities, unknown sources and items belonging to a different order', async () => {
    const before = (await app.db.query('SELECT count(*) AS n FROM quality_records')).rows[0].n
    for (const data of [ncr({ rejectedQuantity: '101' }), ncr({ totalQuantity: '' }), ncr({ sources: [] }), ncr({ orderNumber: 'MISSING' }), ncr({ machineIds: [randomUUID()] }), ncr({ effectiveness: 'Effective', effectivenessDate: '' }), ncr({ correctiveActions: [{ description: 'Action', responsibility: 'Person', completionDate: '2026-02-30' }] })]) expect((await post('ncr', body('ncr', data))).status).toBe(400)
    for (const data of [complaint({ orderNumber: 'ORD-200' }), complaint({ email: 'bad email' }), complaint({ invoiceDate: '2026-02-30' }), complaint({ issues: [] })]) expect((await post('customer-complaint', body('customer-complaint', data))).status).toBe(400)
    expect((await post('ncr', { ...body('ncr'), date: '2026-02-30' })).status).toBe(400)
    expect((await post('ncr', body('ncr', complaint()))).status).toBe(400)
    expect((await post('ncr', { ...body('ncr'), imageIds: [randomUUID()] })).status).toBe(400)
    expect((await app.db.query('SELECT count(*) AS n FROM quality_records')).rows[0].n).toBe(before)
  })

  it('searches and filters every record and paginates, with literal search wildcards', async () => {
    const older = (await post('customer-complaint', { ...body('customer-complaint', complaint({ description: 'Find complaint 100% complete' })), date: '2026-10-20' })).body
    const newer = (await post('customer-complaint', { ...body('customer-complaint', complaint({ description: 'Find complaint new' })), date: '2026-10-21' })).body
    const first = (await list('customer-complaint', '?q=Find%20complaint&limit=1')).body
    expect(first.total).toBe(2); expect(first.hasMore).toBe(true); expect(first.records[0].id).toBe(newer.id)
    const second = (await list('customer-complaint', '?q=Find%20complaint&limit=1&offset=1')).body
    expect(second.records[0].id).toBe(older.id); expect(second.hasMore).toBe(false)
    expect((await list('customer-complaint', '?q=100%25&category=Dimensions&from=2026-10-20&to=2026-10-20')).body.records.map((r) => r.id)).toEqual([older.id])
    expect((await list('ncr', '?category=Internal%20audit')).body.records.every((r) => (r.data as NcrData).sources.includes('Internal audit'))).toBe(true)
    expect((await list('ncr', '?category=Invalid')).status).toBe(400)
  })

  it('preserves snapshots and supports follow-up after machines and ERP rows are retired', async () => {
    const nr = (await post('ncr')).body
    const cc = (await post('customer-complaint')).body
    await app.db.query("UPDATE machines SET display_name = 'New name', factory = 'Factory 2', deleted_at = now() WHERE id = $1", [machine.id])
    await app.db.query("UPDATE production_orders SET customer = 'Renamed customer', item = 'Renamed item', deleted_at = now() WHERE order_number = 'ORD-100'")
    const updatedNcr = await edit(nr, { ...nr.data as NcrData, rootCause: 'Follow-up after retirement' })
    expect(updatedNcr.status, JSON.stringify(updatedNcr.body)).toBe(200)
    expect(updatedNcr.body.data).toMatchObject({ customer: 'Customer A', machines: [{ id: machine.id, displayName: '31 Welding', factory: 'Factory 1' }] })
    expect((await edit(cc, { ...cc.data as CustomerComplaintData, lostQuantity: '2' })).status).toBe(200)
    expect((await read(cc, complaintReader)).body.data).toMatchObject({ customer: 'Customer A', productName: 'Upright' })
    const complaintOptions = (await app.api<QualityRecordOptions>('GET', `${path('customer-complaint')}/options`, { token: complaintReader.token })).body
    expect(complaintOptions.machines).toEqual([])
    expect(complaintOptions.factories).toEqual([])
    await expect(app.db.query('DELETE FROM quality_records WHERE id = $1', [nr.id])).rejects.toThrow()
  })
})
