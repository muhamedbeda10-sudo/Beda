import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ApiErrorBody } from '@qc/shared/api'
import type { ImageAsset } from '@qc/shared/types'
import type {
  CoilDelivery, DeliveredCoilList, DeliveryNote, DeliveryNoteInput, DeliveryNoteList, PurchaseOrder, PurchaseOrderImportResult, PurchaseOrderInput, PurchaseOrderList,
  ReceivedItemList, ReceivingDecisionInput, ReceivingOptions,
} from '@qc/shared/receiving'
import { runReadOnlyQuery } from '../src/ai/runQuery'
import { TestApp, tinyJpeg, type Session } from './harness'

// §27 — receiving: the POs the warehouse receives against, its delivery
// notes to quality, quality's decision on each line, the warehouse closing
// what was decided; the coils on the supplier's paper against the MTC
// register; and the figures the PO lines and notes keep.

const app = new TestApp()
let admin: Session, store: Session, qc: Session, inspector: Session, outsider: Session
const day = '2026-10-20'

const poInput = (patch: Partial<PurchaseOrderInput> = {}): PurchaseOrderInput => ({
  poNumber: 'PO-4500123', supplier: 'Ezz Steel', poDate: '2026-10-01', notes: '',
  lines: [
    { lineNo: 10, itemCode: 'BRK-100', description: 'Bracket', drawing: 'DWG-77 rev B', dimensions: '100 x 50 x 3', quantity: 500, unit: 'pcs', notes: '' },
    { lineNo: 20, itemCode: 'COIL-S350', description: 'Galvanized coil', drawing: '', dimensions: '1.5 x 1250', quantity: 40, unit: 'ton', notes: '' },
  ],
  ...patch,
})
const decide = (as: Session, note: DeliveryNote, index: number, body: Partial<ReceivingDecisionInput>) => {
  const line = note.lineItems[index]
  return app.api<DeliveryNote & ApiErrorBody>('POST', `/api/receiving/notes/${note.id}/lines/${line.id}/decision`, {
    token: as.token, body: { acceptedQty: null, holdReason: '', rejectReason: '', notes: '', imageIds: [], version: line.version, ...body },
  })
}
const bell = async (s: Session) => (await app.db.query<{ kind: string; title: string; body: string; link: string }>(
  `SELECT kind, title, body, link FROM user_notifications WHERE user_id = $1 AND kind = 'receiving' ORDER BY created_at DESC, id DESC`, [s.user.id])).rows
const ai = async (sql: string) => {
  const res = await runReadOnlyQuery(app.aiReader.poolFor(['materials'])!, sql, { maxRows: 100, timeoutMs: 10_000, timeZone: app.config.FACTORY_TIMEZONE })
  if (!res.ok) throw new Error(res.error)
  return res.rows
}

let po: PurchaseOrder

beforeAll(async () => {
  await app.start(); await app.resetDatabase()
  admin = await app.register('admin', 'Administrator')
  const sessions: Session[] = []
  for (const [username, role] of [['store', 'warehouse'], ['qc', 'supervisor'], ['insp', 'inspector'], ['outsider', 'viewer']] as const) {
    expect((await app.api('POST', '/api/users', { token: admin.token, body: { username, password: 'Password#1', name: username, role } })).status).toBe(201)
    sessions.push(await app.login(username))
  }
  ;[store, qc, inspector, outsider] = sessions
})
afterAll(() => app.stop())

describe('§27 receiving', () => {
  it('opens to whoever may see Receiving; the warehouse sends, quality decides', async () => {
    for (const path of ['/api/receiving/options', '/api/receiving/notes', '/api/receiving/items', '/api/receiving/coils', '/api/receiving/purchase-orders']) {
      expect((await app.api('GET', path, { token: outsider.token })).status).toBe(403)
      expect((await app.api('GET', path, { token: inspector.token })).status).toBe(200)
    }
    expect((await app.api('POST', '/api/receiving/purchase-orders', { token: inspector.token, body: poInput() })).status).toBe(403)
    expect((await app.api('POST', '/api/receiving/purchase-orders', { token: qc.token, body: poInput() })).status).toBe(403)
    expect((await app.api('POST', '/api/receiving/lists', { token: store.token, body: { list: 'factory', value: 'Factory 9' } })).status).toBe(403)
    // The warehouse lands on Receiving: it is the one screen it opens.
    const me = await app.api<{ permissions: string[] }>('GET', '/api/auth/me', { token: store.token })
    expect(me.body.permissions).toEqual(['view-receiving', 'create-delivery-note', 'manage-purchase-orders'])
  })

  it('keeps the lists: hold reasons and units seeded, factories added under Setup', async () => {
    const options = (await app.api<ReceivingOptions>('GET', '/api/receiving/options', { token: store.token })).body
    expect(options.lists.filter((l) => l.list === 'hold-reason').map((l) => l.value)).toContain('Missing MTC')
    expect(options.lists.filter((l) => l.list === 'unit').map((l) => l.value)).toContain('pcs')
    for (const value of ['Factory 1', 'Factory 2']) expect((await app.api('POST', '/api/receiving/lists', { token: qc.token, body: { list: 'factory', value } })).status).toBe(201)
    expect((await app.api('POST', '/api/receiving/lists', { token: qc.token, body: { list: 'factory', value: 'factory 1' } })).status).toBe(409)
  })

  it('records a PO by hand, finds it by its number, and refuses the number twice', async () => {
    const res = await app.api<PurchaseOrder>('POST', '/api/receiving/purchase-orders', { token: store.token, body: poInput() })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    po = res.body
    expect(po.lines.map((l) => [l.lineNo, l.itemCode, l.quantity, l.deliveredQty])).toEqual([[10, 'BRK-100', 500, 0], [20, 'COIL-S350', 40, 0]])
    expect(po.source).toBe('manual')
    const found = await app.api<PurchaseOrder>('GET', '/api/receiving/purchase-orders/lookup?number=%20po-4500123%20', { token: inspector.token })
    expect(found.body.id).toBe(po.id)
    expect((await app.api('GET', '/api/receiving/purchase-orders/lookup?number=PO-0', { token: store.token })).status).toBe(404)
    expect((await app.api('POST', '/api/receiving/purchase-orders', { token: store.token, body: poInput({ poNumber: 'po-4500123' }) })).status).toBe(409)
  })

  it('imports the purchase orders’ sheet: new POs made, lines matched by number or item, the rest left', async () => {
    const rows = [
      { poNumber: 'PO-4500123', supplier: '', poDate: '', lineNo: 10, itemCode: 'BRK-100', description: 'Bracket', drawing: 'DWG-77 rev C', dimensions: '100 x 50 x 3', quantity: 500, unit: 'pcs', notes: '' },
      { poNumber: 'PO-4500123', supplier: '', poDate: '', lineNo: null, itemCode: 'BOLT-M12', description: 'Bolt M12', drawing: '', dimensions: 'M12 x 40', quantity: 2000, unit: 'pcs', notes: '' },
      { poNumber: 'PO-4500999', supplier: 'Bolts Co', poDate: '2026-10-05', lineNo: null, itemCode: 'NUT-M12', description: 'Nut', drawing: '', dimensions: '', quantity: 1000, unit: 'pcs', notes: '' },
    ]
    const res = await app.api<PurchaseOrderImportResult>('POST', '/api/receiving/purchase-orders/import', { token: store.token, body: { rows } })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body).toEqual({ ordersCreated: 1, linesCreated: 2, linesUpdated: 1, linesUnchanged: 0 })
    po = (await app.api<PurchaseOrder>('GET', `/api/receiving/purchase-orders/${po.id}`, { token: store.token })).body
    expect(po.lines.map((l) => [l.lineNo, l.itemCode, l.drawing])).toEqual([[10, 'BRK-100', 'DWG-77 rev C'], [20, 'COIL-S350', ''], [21, 'BOLT-M12', '']])
    // Again: nothing new.
    expect((await app.api<PurchaseOrderImportResult>('POST', '/api/receiving/purchase-orders/import', { token: store.token, body: { rows } })).body)
      .toEqual({ ordersCreated: 0, linesCreated: 0, linesUpdated: 0, linesUnchanged: 3 })
    const list = (await app.api<PurchaseOrderList>('GET', '/api/receiving/purchase-orders?q=nut', { token: store.token })).body
    expect(list.orders.map((o) => [o.poNumber, o.source, o.lines])).toEqual([['PO-4500999', 'import', 1]])
  })

  let note: DeliveryNote
  it('sends a delivery note to quality: numbered, with its coils, and the PO lines count what came', async () => {
    const body: DeliveryNoteInput & { submissionId: string } = {
      poId: po.id, factory: 'Factory 1', deliveredOn: day, supplierDnNo: 'EZ-889', notes: 'Truck 12',
      lines: [{ poLineId: po.lines[0].id, quantity: 200, notes: '' }, { poLineId: po.lines[1].id, quantity: 12.5, notes: '3 coils' }],
      coils: [{ coilNumber: '456596-0-0-0', weight: 4200, heatNumber: 'H1' }, { coilNumber: '456597-0-0-0', weight: null, heatNumber: '' }, { coilNumber: '456598-0-0-0', weight: 4100, heatNumber: '' }],
      imageIds: [], submissionId: randomUUID(),
    }
    expect((await app.api('POST', '/api/receiving/notes', { token: inspector.token, body })).status).toBe(403)
    const res = await app.api<DeliveryNote & ApiErrorBody>('POST', '/api/receiving/notes', { token: store.token, body })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    note = res.body
    expect(note.reference).toBe('DN-26-0001')
    expect(note.status).toBe('awaiting-qc')
    expect([note.lines, note.pendingLines, note.coils]).toEqual([2, 2, 3])
    expect(note.lineItems.map((l) => [l.itemCode, l.quantity, l.orderedQty, l.drawing, l.status])).toEqual([['BRK-100', 200, 500, 'DWG-77 rev C', 'pending'], ['COIL-S350', 12.5, 40, '', 'pending']])
    expect(note.events.map((e) => e.kind)).toEqual(['created'])
    // The same submission again is the same note.
    const again = await app.api<DeliveryNote>('POST', '/api/receiving/notes', { token: store.token, body })
    expect([again.status, again.body.id]).toEqual([200, note.id])
    po = (await app.api<PurchaseOrder>('GET', `/api/receiving/purchase-orders/${po.id}`, { token: store.token })).body
    expect(po.lines.map((l) => [l.deliveredQty, l.pendingQty])).toEqual([[200, 200], [12.5, 12.5], [0, 0]])
    // Quality hears of it; the one who sent it does not.
    for (const s of [qc, admin]) expect((await bell(s))[0]).toMatchObject({ title: 'Delivery DN-26-0001 to receive: PO PO-4500123 · Ezz Steel', link: `/receiving/notes/${note.id}` })
    expect(await bell(store)).toEqual([])
    expect(await bell(inspector)).toEqual([])
  })

  it('refuses a line of another PO, an empty note and no factory', async () => {
    const other = (await app.api<PurchaseOrder>('GET', '/api/receiving/purchase-orders/lookup?number=PO-4500999', { token: store.token })).body
    const base = { poId: po.id, factory: 'Factory 1', deliveredOn: day, supplierDnNo: '', notes: '', coils: [], imageIds: [], submissionId: randomUUID() }
    expect((await app.api('POST', '/api/receiving/notes', { token: store.token, body: { ...base, lines: [{ poLineId: other.lines[0].id, quantity: 1, notes: '' }] } })).status).toBe(400)
    expect((await app.api('POST', '/api/receiving/notes', { token: store.token, body: { ...base, lines: [] } })).status).toBe(400)
    expect((await app.api('POST', '/api/receiving/notes', { token: store.token, body: { ...base, factory: ' ', lines: [{ poLineId: po.lines[0].id, quantity: 1, notes: '' }] } })).status).toBe(400)
  })

  it('lets the warehouse correct the note until quality decides a line', async () => {
    const res = await app.api<DeliveryNote & ApiErrorBody>('PUT', `/api/receiving/notes/${note.id}`, {
      token: store.token,
      body: { poId: po.id, factory: 'Factory 2', deliveredOn: day, supplierDnNo: 'EZ-889', notes: 'Truck 12', imageIds: [], version: note.version,
        lines: [{ poLineId: po.lines[0].id, quantity: 250, notes: '' }, { poLineId: po.lines[1].id, quantity: 12.5, notes: '3 coils' }], coils: note.coilList },
    })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    note = res.body
    expect([note.factory, note.lineItems[0].quantity]).toEqual(['Factory 2', 250])
    expect(note.events.map((e) => e.kind)).toEqual(['created', 'edited'])
    expect((await app.api<PurchaseOrder>('GET', `/api/receiving/purchase-orders/${po.id}`, { token: store.token })).body.lines[0].deliveredQty).toBe(250)
  })

  it('takes quality’s decisions: a reason for Hold and rejection, a quantity for partly accepted', async () => {
    expect((await decide(store, note, 0, { decision: 'accepted' })).status).toBe(403)
    expect((await decide(qc, note, 0, { decision: 'hold' })).status).toBe(400)
    expect((await decide(qc, note, 0, { decision: 'rejected' })).status).toBe(400)
    expect((await decide(qc, note, 0, { decision: 'partial', acceptedQty: 250, rejectReason: 'Burrs' })).status).toBe(400)
    let res = await decide(qc, note, 0, { decision: 'partial', acceptedQty: 230, rejectReason: 'Burrs on 20 pieces', notes: 'Sorted at the door' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    note = res.body
    expect(note.lineItems[0]).toMatchObject({ status: 'partial', acceptedQty: 230, rejectedQty: 20, rejectReason: 'Burrs on 20 pieces', decidedByName: 'qc' })
    expect(note.status).toBe('awaiting-qc')
    // A decision read on an older version is refused.
    expect((await decide(qc, { ...note, lineItems: [{ ...note.lineItems[0], version: 0 }, note.lineItems[1]] }, 0, { decision: 'accepted' })).status).toBe(409)
    // The warehouse can no longer change it.
    expect((await app.api('PUT', `/api/receiving/notes/${note.id}`, { token: store.token, body: { poId: po.id, factory: 'Factory 1', deliveredOn: day, supplierDnNo: '', notes: '', imageIds: [], version: note.version, lines: [{ poLineId: po.lines[0].id, quantity: 1, notes: '' }], coils: [] } })).status).toBe(400)
    res = await decide(qc, note, 1, { decision: 'hold', holdReason: 'Missing MTC', notes: 'Two certificates to come' })
    note = res.body
    expect(note.status).toBe('hold')
    expect((await bell(store))[0]).toMatchObject({ title: 'Delivery DN-26-0001 is on hold: PO PO-4500123', body: '1 partly accepted, 1 on hold.' })
    // Closing waits for the Hold.
    expect((await app.api('POST', `/api/receiving/notes/${note.id}/close`, { token: store.token, body: { version: note.version } })).status).toBe(400)
    po = (await app.api<PurchaseOrder>('GET', `/api/receiving/purchase-orders/${po.id}`, { token: store.token })).body
    expect(po.lines.map((l) => [l.acceptedQty, l.rejectedQty, l.holdQty, l.pendingQty])).toEqual([[230, 20, 0, 0], [0, 0, 12.5, 0], [0, 0, 0, 0]])
  })

  it('lists the items by decision: Accepted, Hold, Rejected', async () => {
    const list = async (status: string) => (await app.api<ReceivedItemList>('GET', `/api/receiving/items?status=${status}`, { token: inspector.token })).body.items.map((i) => i.itemCode)
    expect(await list('hold')).toEqual(['COIL-S350'])
    expect(await list('partial')).toEqual(['BRK-100'])
    expect(await list('accepted')).toEqual([])
    const notes = (await app.api<DeliveryNoteList>('GET', '/api/receiving/notes?status=hold', { token: store.token })).body
    expect(notes.notes.map((n) => n.reference)).toEqual(['DN-26-0001'])
    expect((await app.api<DeliveryNoteList>('GET', '/api/receiving/notes?q=456597', { token: store.token })).body.total).toBe(1)
  })

  it('matches the delivered coils with the MTC register: the ones whose certificate came leave the list to chase', async () => {
    const coils = async (mtc?: string) => (await app.api<DeliveredCoilList>('GET', `/api/receiving/coils${mtc ? `?mtc=${mtc}` : ''}`, { token: inspector.token })).body
    expect((await coils('missing')).coils.map((c) => c.coilNumber)).toEqual(['456596-0-0-0', '456597-0-0-0', '456598-0-0-0'])
    expect((await app.api('POST', '/api/coils/import', { token: admin.token, body: { rows: [{ coilNumber: '456596-0-0-0', grade: 'S350GD', supplier: 'Ezz Steel', thickness: 1.5 }] } })).status).toBe(200)
    const after = await coils()
    expect([after.total, after.missing]).toEqual([3, 2])
    expect(after.coils.find((c) => c.coilNumber === '456596-0-0-0')).toMatchObject({ hasMtc: true, grade: 'S350GD', thickness: 1.5 })
    expect((await coils('matched')).coils.map((c) => c.coilNumber)).toEqual(['456596-0-0-0'])
    // Coil search names the delivery a coil came on, to whoever may open Receiving.
    const by = await app.api<CoilDelivery[]>('GET', '/api/receiving/by-coils?numbers=456596-0-0-0,NOPE', { token: inspector.token })
    expect(by.body).toEqual([{ coilNumber: '456596-0-0-0', noteId: note.id, reference: 'DN-26-0001', deliveredOn: day, poNumber: 'PO-4500123', supplier: 'Ezz Steel', factory: 'Factory 2' }])
    expect((await app.api('GET', '/api/receiving/by-coils?numbers=456596-0-0-0', { token: outsider.token })).status).toBe(403)
    // Quality adds a coil the paper missed.
    const res = await app.api<DeliveryNote & ApiErrorBody>('PUT', `/api/receiving/notes/${note.id}/coils`, {
      token: qc.token, body: { coils: [...note.coilList, { coilNumber: '456599-0-0-0', weight: null, heatNumber: '' }], imageIds: [], version: note.version },
    })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    note = res.body
    expect(note.coils).toBe(4)
    expect(note.events.at(-1)?.kind).toBe('coils')
    expect((await app.api('PUT', `/api/receiving/notes/${note.id}/coils`, { token: qc.token, body: { coils: [{ coilNumber: 'A', weight: null, heatNumber: '' }, { coilNumber: 'a', weight: null, heatNumber: '' }], imageIds: [], version: note.version } })).status).toBe(400)
  })

  it('takes the Hold off, and the warehouse closes and prints what is decided; setup reopens', async () => {
    let res = await decide(qc, note, 1, { decision: 'accepted', notes: 'MTC came' })
    note = res.body
    expect(note.status).toBe('decided')
    expect((await bell(store))[0]).toMatchObject({ title: 'Delivery DN-26-0001 decided: PO PO-4500123', body: '1 accepted, 1 partly accepted. Print it and close it.' })
    expect(note.events.filter((e) => e.kind === 'decided').map((e) => e.status)).toEqual(['partial', 'hold', 'accepted'])
    res = await app.api<DeliveryNote & ApiErrorBody>('POST', `/api/receiving/notes/${note.id}/close`, { token: store.token, body: { version: note.version } })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    note = res.body
    expect([note.status, note.closedByName]).toEqual(['closed', 'store'])
    // Closed: nothing changes it.
    expect((await decide(qc, note, 0, { decision: 'accepted' })).status).toBe(400)
    expect((await app.api('PUT', `/api/receiving/notes/${note.id}/coils`, { token: qc.token, body: { coils: [], imageIds: [], version: note.version } })).status).toBe(400)
    expect((await app.api('POST', `/api/receiving/notes/${note.id}/reopen`, { token: store.token, body: { version: note.version, reason: 'x' } })).status).toBe(403)
    res = await app.api<DeliveryNote & ApiErrorBody>('POST', `/api/receiving/notes/${note.id}/reopen`, { token: qc.token, body: { version: note.version, reason: 'Count was wrong' } })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.status).toBe('decided')
    note = res.body
  })

  it('keeps a decision’s photos for whoever may open Receiving', async () => {
    const bytes = tinyJpeg(77)
    const form = new FormData()
    form.set('file', new Blob([bytes], { type: 'image/jpeg' }), 'defect.jpg')
    for (const [k, v] of Object.entries({ originalFilename: 'defect.jpg', width: '10', height: '10', sha256: createHash('sha256').update(bytes).digest('hex'), thumbnailDataUrl: 'data:image/jpeg;base64,AAAA' })) form.set(k, v)
    const uploaded = await app.api<ImageAsset>('POST', '/api/images', { token: qc.token, raw: form })
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(201)
    const res = await decide(qc, note, 0, { decision: 'rejected', rejectReason: 'All burred', imageIds: [uploaded.body.id] })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    note = res.body
    expect(note.lineItems[0].imageIds).toEqual([uploaded.body.id])
    const readBy = async (as: Session) => (await app.api<ImageAsset[]>('GET', `/api/images?ids=${uploaded.body.id}`, { token: as.token })).body.map((i) => i.id)
    expect(await readBy(store)).toEqual([uploaded.body.id])
    expect(await readBy(outsider)).toEqual([])
  })

  it('gives the assistant the POs, the notes, their lines and the coils, with the same figures', async () => {
    expect(await ai(`SELECT item_code, delivered_qty, accepted_qty, rejected_qty, remaining_qty FROM ai.purchase_order_lines WHERE po_number = 'PO-4500123' ORDER BY line_no`))
      .toEqual([['BRK-100', 250, 0, 250, 250], ['COIL-S350', 12.5, 12.5, 0, 27.5], ['BOLT-M12', 0, 0, 0, 2000]])
    expect(await ai(`SELECT reference, status, accepted_lines, rejected_lines, coils FROM ai.delivery_notes`)).toEqual([['DN-26-0001', 'decided', 1, 1, 4]])
    expect(await ai(`SELECT item_code, decision, reject_reason FROM ai.delivery_note_lines ORDER BY po_line_no`)).toEqual([['BRK-100', 'rejected', 'All burred'], ['COIL-S350', 'accepted', '']])
    expect(await ai(`SELECT coil_number FROM ai.delivered_coils WHERE NOT has_mtc ORDER BY coil_number`)).toEqual([['456597-0-0-0'], ['456598-0-0-0'], ['456599-0-0-0']])
  })

  it('deletes: the warehouse its own undecided note, setup any; the PO lines forget what it brought', async () => {
    const other = await app.api<DeliveryNote>('POST', '/api/receiving/notes', { token: store.token, body: {
      poId: po.id, factory: 'Factory 1', deliveredOn: day, supplierDnNo: '', notes: '', lines: [{ poLineId: po.lines[2].id, quantity: 100, notes: '' }], coils: [], imageIds: [], submissionId: randomUUID(),
    } })
    expect(other.body.reference).toBe('DN-26-0002')
    expect((await app.api('DELETE', `/api/receiving/notes/${note.id}`, { token: store.token })).status).toBe(403)
    expect((await app.api('DELETE', `/api/receiving/notes/${other.body.id}`, { token: store.token })).status).toBe(204)
    expect((await app.api('DELETE', `/api/receiving/purchase-orders/${po.id}`, { token: qc.token })).status).toBe(400)
    expect((await app.api('DELETE', `/api/receiving/notes/${note.id}`, { token: qc.token })).status).toBe(204)
    po = (await app.api<PurchaseOrder>('GET', `/api/receiving/purchase-orders/${po.id}`, { token: store.token })).body
    expect(po.lines.map((l) => l.deliveredQty)).toEqual([0, 0, 0])
    expect((await app.api('DELETE', `/api/receiving/purchase-orders/${po.id}`, { token: qc.token })).status).toBe(204)
    const audit = await app.db.query<{ entity: string; action: string }>(`SELECT DISTINCT entity, action FROM audit_log WHERE entity IN ('PurchaseOrder', 'DeliveryNote', 'DeliveryNoteLine') ORDER BY 1, 2`)
    expect(audit.rows.map((r) => `${r.entity}:${r.action}`)).toEqual(expect.arrayContaining(['DeliveryNote:create', 'DeliveryNote:delete', 'DeliveryNoteLine:update', 'PurchaseOrder:create', 'PurchaseOrder:delete']))
  })

  it('lets a PO be corrected, keeping delivered lines', async () => {
    const created = (await app.api<PurchaseOrder>('POST', '/api/receiving/purchase-orders', { token: store.token, body: poInput({ poNumber: 'PO-7' }) })).body
    await app.api('POST', '/api/receiving/notes', { token: store.token, body: {
      poId: created.id, factory: 'Factory 1', deliveredOn: day, supplierDnNo: '', notes: '', lines: [{ poLineId: created.lines[0].id, quantity: 5, notes: '' }], coils: [], imageIds: [], submissionId: randomUUID(),
    } })
    const lines = created.lines.map((l) => ({ id: l.id, lineNo: l.lineNo, itemCode: l.itemCode, description: l.description, drawing: l.drawing, dimensions: l.dimensions, quantity: l.quantity, unit: l.unit, notes: l.notes }))
    const put = (body: object) => app.api<PurchaseOrder & ApiErrorBody>('PUT', `/api/receiving/purchase-orders/${created.id}`, { token: store.token, body: { ...poInput({ poNumber: 'PO-7' }), version: created.version, ...body } })
    expect((await put({ lines: [lines[1]] })).status).toBe(400)
    const res = await put({ lines: [{ ...lines[0], lineNo: 20 }, { ...lines[1], lineNo: 10, quantity: 45 }, { lineNo: null, itemCode: 'NEW', description: '', drawing: '', dimensions: '', quantity: 1, unit: 'pcs', notes: '' }] })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.lines.map((l) => [l.lineNo, l.itemCode, l.quantity, l.deliveredQty])).toEqual([[10, 'COIL-S350', 45, 0], [20, 'BRK-100', 500, 5], [21, 'NEW', 1, 0]])
    expect((await put({ lines })).status).toBe(409)
  })
})
