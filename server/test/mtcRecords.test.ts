import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ApiErrorBody } from '@qc/shared/api'
import type { CoilDetails, CoilSlitting, DeliveryNote, DeliveryNoteExtractResult, DeliveryNoteListResponse, MtcSaveResponse, MtcStreamEvent, MtcTableResponse } from '@qc/shared/mtc'
import { TestApp, type Session } from './harness'
import { text } from './aiFake'

// MTC — what the coil register keeps beside its coils: the delivery notes
// (read by Claude, or typed) whose PO and day every coil they list takes,
// whichever comes first; each coil's certified yield, tensile and elongation
// judged against its lab grade (green, red); the certificate kept to open;
// and each coil's slitting.

const app = new TestApp()
let admin: Session
let uploader: Session
let inspector: Session
let viewer: Session
const KEY = `sk-ant-api03-${'d_7-'.repeat(20)}DnRk`
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n')

type Item = Record<string, unknown>
const NOTE = { isDeliveryNote: true, problem: '', noteNumber: '', deliveryDate: '', poNumber: '', supplier: '', coils: [], uncertain: [] }
const noteReply = (note: Item) => text(JSON.stringify({ ...NOTE, ...note }))

async function extractNote(bytes: Buffer, name: string, as: Session = uploader) {
  const form = new FormData()
  form.set('file', new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }), name)
  const res = await app.api<string | ApiErrorBody>('POST', '/api/mtc/delivery-notes/extract', { token: as.token, raw: form })
  const events: MtcStreamEvent[] =
    res.status === 200
      ? (res.body as string)
          .split('\n\n')
          .filter((f) => f && !f.startsWith(':'))
          .map((f) => JSON.parse(/\ndata: (.+)$/.exec(f)![1]) as MtcStreamEvent)
      : []
  const result = (events.find((e) => e.type === 'result') as { result: DeliveryNoteExtractResult } | undefined)?.result
  return { res, events, result }
}

const note = (body: Item, as: Session = uploader) => app.api<DeliveryNote & ApiErrorBody>('POST', '/api/mtc/delivery-notes', { token: as.token, body })
const saveCoils = (rows: Item[], extra: Item = {}) =>
  app.api<MtcSaveResponse & ApiErrorBody>('POST', '/api/mtc/coils/save', {
    token: uploader.token,
    body: { fileName: 'cert.pdf', rows: rows.map((values) => ({ values, overwrite: true })), ...extra },
  })
const coil = async (coilNumber: string) =>
  (
    await app.db.query(
      `SELECT id, po_number AS "poNumber", to_char(delivery_date, 'YYYY-MM-DD') AS "deliveryDate", delivery_note_id AS "noteId",
              std_grade AS "stdGrade", yield_ok AS "yieldOk", tensile_ok AS "tensileOk", elongation_ok AS "elongationOk", mtc_document_id AS "documentId"
         FROM coils WHERE lower(coil_number) = lower($1)`,
      [coilNumber],
    )
  ).rows[0]
const grade = (body: Item) =>
  app.api<{ id: string }>('POST', '/api/lab/grades', {
    token: admin.token,
    body: { family: 'sheet', standard: 'EN 10149-2', thicknessFrom: null, thicknessTo: null, yieldMin: null, yieldMax: null, tensileMin: null, tensileMax: null, elongationMin: null, hardness: '', ...body },
  })

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  admin = await app.register('admin', 'Admin')
  for (const [username, name, role] of [
    ['upl', 'Uploader', 'inspector'],
    ['insp', 'Inspector', 'inspector'],
    ['view', 'Viewer', 'viewer'],
  ]) {
    expect((await app.api('POST', '/api/users', { token: admin.token, body: { username, password: 'Password#1', name, role } })).status).toBe(201)
  }
  uploader = await app.login('upl')
  inspector = await app.login('insp')
  viewer = await app.login('view')
  expect((await app.api('PUT', `/api/ai/access/${uploader.user.id}`, { token: admin.token, body: { enabled: false, domains: ['inspection'], monthlyCapUsd: 50, mtc: true } })).status).toBe(200)
  expect((await app.api('PUT', '/api/ai/key', { token: admin.token, body: { apiKey: KEY } })).status).toBe(200)
})
afterAll(() => app.stop())
beforeEach(async () => {
  app.model.reset()
  for (const t of ['coil_slittings', 'delivery_notes', 'coils']) {
    if (t === 'delivery_notes') await app.db.query(`DELETE FROM delivery_note_coils`)
    await app.db.query(`ALTER TABLE ${t} DISABLE TRIGGER ${t}_no_delete; DELETE FROM ${t}; ALTER TABLE ${t} ENABLE TRIGGER ${t}_no_delete;`)
  }
})

describe('delivery notes', () => {
  it('are read by Claude: the number, day, PO, supplier and every coil, the file kept to open again', async () => {
    app.model.reply({
      content: [
        noteReply({
          noteNumber: 'DN-5521',
          deliveryDate: '2026-10-12',
          poNumber: 'PO 7781',
          supplier: 'ezz',
          coils: [
            { coilNumber: ' 306043-0-02 ', weightKg: '8,450' },
            { coilNumber: '306043-0-03', weightKg: '' },
            { coilNumber: '306043-0-02', weightKg: '1' },
          ],
          uncertain: ['poNumber'],
        }),
      ],
    })
    const { res, events, result } = await extractNote(PDF, 'DN 5521.pdf')
    expect(res.status).toBe(200)
    expect(events.map((e) => e.type)).toEqual(['reading', 'result'])
    expect(result).toEqual({
      fileName: 'DN 5521.pdf',
      documentId: expect.any(String),
      note: {
        noteNumber: 'DN-5521',
        deliveryDate: '2026-10-12',
        poNumber: 'PO 7781',
        supplier: 'Ezz',
        notes: '',
        // Listed twice: once.
        coils: [
          { coilNumber: '306043-0-02', weightKg: 8450 },
          { coilNumber: '306043-0-03', weightKg: null },
        ],
        uncertain: ['poNumber'],
      },
    })
    expect(String(app.model.calls[0].params.system)).toContain('delivery notes')
    const reading = await app.db.query(`SELECT kind, items, outcome, document_id AS "documentId" FROM mtc_readings ORDER BY created_at DESC LIMIT 1`)
    expect(reading.rows[0]).toEqual({ kind: 'delivery-note', items: 2, outcome: 'read', documentId: result!.documentId })
  })

  it('reads again on the stronger model when the day or the coils could not be read, and keeps nothing of what is not a note', async () => {
    app.model.reply({ content: [noteReply({ noteNumber: 'DN-1', deliveryDate: '12/10/2026', coils: [{ coilNumber: 'A1', weightKg: '' }] })] })
    app.model.reply({ content: [noteReply({ noteNumber: 'DN-1', deliveryDate: '2026-10-12', coils: [{ coilNumber: 'A1', weightKg: '' }] })] })
    const again = await extractNote(PDF, 'blurred.pdf')
    expect(again.events.map((e) => e.type)).toEqual(['reading', 'rereading', 'result'])
    expect(again.result?.note?.deliveryDate).toBe('2026-10-12')

    app.model.reply({ content: [text(JSON.stringify({ ...NOTE, isDeliveryNote: false, problem: 'This is a mill test certificate.' }))] })
    const other = await extractNote(PDF, 'cert.pdf')
    expect(other.result).toEqual({ fileName: 'cert.pdf', note: null, problem: 'This is a mill test certificate.' })
    expect((await app.db.query(`SELECT count(*)::int AS n FROM mtc_documents WHERE file_name = 'cert.pdf'`)).rows[0].n).toBe(0)
  })

  it('give every coil they list its PO and delivery day, whichever comes first, and follow each change of the note', async () => {
    // A coil registered first, from its certificate.
    expect((await saveCoils([{ coilNumber: 'K-1', grade: 'S235JR', thickness: 2, width: 1250 }])).status).toBe(200)
    expect(await coil('K-1')).toMatchObject({ poNumber: null, deliveryDate: null })

    const first = await note({ noteNumber: 'DN-10', deliveryDate: '2026-10-01', poNumber: 'PO-1', supplier: 'Ezz', notes: '', coils: [{ coilNumber: 'k-1', weightKg: 8000 }, { coilNumber: 'K-2', weightKg: null }] })
    expect(first.status).toBe(201)
    expect(first.body.coils.map((c) => [c.coilNumber, c.coilId !== null])).toEqual([
      ['k-1', true],
      ['K-2', false],
    ])
    expect(await coil('K-1')).toMatchObject({ poNumber: 'PO-1', deliveryDate: '2026-10-01', noteId: first.body.id })

    // The coil's certificate comes after its note: the coil finds the note as it is registered.
    await saveCoils([{ coilNumber: 'K-2', grade: 'S235JR' }])
    expect(await coil('K-2')).toMatchObject({ poNumber: 'PO-1', deliveryDate: '2026-10-01' })

    // Corrected: the day and PO follow; a coil taken off the note loses them.
    const fixed = await app.api<DeliveryNote>('PUT', `/api/mtc/delivery-notes/${first.body.id}`, {
      token: uploader.token,
      body: { noteNumber: 'DN-10', deliveryDate: '2026-10-02', poNumber: 'PO-9', supplier: 'Ezz', notes: '', coils: [{ coilNumber: 'K-1', weightKg: 8000 }], version: 1 },
    })
    expect(fixed.status).toBe(200)
    expect(fixed.body.version).toBe(2)
    expect(await coil('K-1')).toMatchObject({ poNumber: 'PO-9', deliveryDate: '2026-10-02' })
    expect(await coil('K-2')).toMatchObject({ poNumber: null, deliveryDate: null, noteId: null })
    // An edit from the version before is refused.
    expect(
      (await app.api('PUT', `/api/mtc/delivery-notes/${first.body.id}`, { token: uploader.token, body: { deliveryDate: '2026-10-03', coils: [], version: 1 } })).status,
    ).toBe(409)

    // A later note listing the same coil wins; removed, the earlier one stands again; brought back by SQL, it wins again.
    const later = await note({ noteNumber: 'DN-11', deliveryDate: '2026-10-20', poNumber: 'PO-2', supplier: 'Ezz', coils: [{ coilNumber: 'K-1', weightKg: null }] })
    expect(await coil('K-1')).toMatchObject({ poNumber: 'PO-2', deliveryDate: '2026-10-20', noteId: later.body.id })
    expect((await app.api('DELETE', `/api/mtc/delivery-notes/${later.body.id}`, { token: uploader.token })).status).toBe(204)
    expect(await coil('K-1')).toMatchObject({ poNumber: 'PO-9', deliveryDate: '2026-10-02', noteId: first.body.id })
    await app.db.query(`UPDATE delivery_notes SET deleted_at = NULL WHERE id = $1`, [later.body.id])
    expect(await coil('K-1')).toMatchObject({ poNumber: 'PO-2' })
    // A line moved from one note to another, and a coil renamed, find their note again.
    const empty = await note({ noteNumber: 'DN-12', deliveryDate: '2026-09-01', poNumber: 'PO-0', supplier: 'Ezz', coils: [] })
    await app.db.query(`UPDATE delivery_note_coils SET delivery_note_id = $1 WHERE delivery_note_id = $2`, [empty.body.id, later.body.id])
    expect(await coil('K-1')).toMatchObject({ poNumber: 'PO-9' })
    await app.db.query(`UPDATE coils SET coil_number = 'K-1B' WHERE coil_number = 'K-1'`)
    expect(await coil('K-1B')).toMatchObject({ poNumber: null, deliveryDate: null })

    // Each figure equals its plain definition, whatever happened above.
    const drift = await app.db.query(
      `SELECT c.coil_number FROM coils c
         LEFT JOIN LATERAL (SELECT n.id, NULLIF(btrim(n.po_number), '') AS po, n.delivery_date FROM delivery_note_coils l
                              JOIN delivery_notes n ON n.id = l.delivery_note_id AND n.deleted_at IS NULL
                             WHERE lower(l.coil_number) = lower(c.coil_number) ORDER BY n.delivery_date DESC, n.created_at DESC LIMIT 1) d ON true
        WHERE (c.delivery_note_id, c.po_number, c.delivery_date) IS DISTINCT FROM (d.id, d.po, d.delivery_date)`,
    )
    expect(drift.rows).toEqual([])

    // The table shows them as columns of the coil register; the assistant reads them on ai.coils.
    const table = (await app.api<MtcTableResponse>('GET', `/api/mtc/coils/table?sort=coilNumber:asc`, { token: viewer.token })).body
    expect(table.rows.find((r) => r.values.coilNumber === 'K-2')?.values).not.toHaveProperty('poNumber')
    const ai = await app.db.query(`SELECT coil_number, po_number, delivery_date::text FROM ai.coils ORDER BY coil_number`)
    expect(ai.rows).toEqual([
      { coil_number: 'K-1B', po_number: null, delivery_date: null },
      { coil_number: 'K-2', po_number: null, delivery_date: null },
    ])
  })

  it('are listed, searched by a coil they hold, and audited', async () => {
    await note({ noteNumber: 'DN-20', deliveryDate: '2026-09-01', poNumber: 'PO-20', supplier: 'Baosteel', coils: [{ coilNumber: 'BX-1', weightKg: 7000 }] })
    await note({ noteNumber: 'DN-21', deliveryDate: '2026-09-05', poNumber: 'PO-21', supplier: 'Baosteel', coils: [{ coilNumber: 'BX-2', weightKg: 7000 }, { coilNumber: 'BX-3', weightKg: null }] })
    const list = (await app.api<DeliveryNoteListResponse>('GET', '/api/mtc/delivery-notes', { token: viewer.token })).body
    expect(list.total).toBe(2)
    expect(list.notes.map((n) => [n.noteNumber, n.coils, n.registered])).toEqual([
      ['DN-21', 2, 0],
      ['DN-20', 1, 0],
    ])
    expect((await app.api<DeliveryNoteListResponse>('GET', '/api/mtc/delivery-notes?search=bx-3', { token: viewer.token })).body.notes.map((n) => n.noteNumber)).toEqual(['DN-21'])
    const audit = await app.db.query(`SELECT action, item, new_value AS "newValue" FROM audit_log WHERE entity = 'DeliveryNote' AND item = 'DN-20'`)
    expect(audit.rows).toEqual([{ action: 'create', item: 'DN-20', newValue: expect.stringContaining('coils BX-1 (7000 kg)') }])
  })

  it('refuse what does not hold together, and anyone without the MTC permission', async () => {
    const ok = { noteNumber: 'DN-30', deliveryDate: '2026-09-01', supplier: 'Ezz', coils: [{ coilNumber: 'Z-1', weightKg: null }] }
    expect((await note(ok, viewer)).status).toBe(403)
    expect((await note(ok, inspector)).status).toBe(403)
    expect((await note({ ...ok, deliveryDate: '2026-02-30' })).status).toBe(400)
    expect((await note({ ...ok, coils: [{ coilNumber: 'Z-1' }, { coilNumber: 'z-1' }] })).status).toBe(400)
    expect((await note(ok)).status).toBe(201)
    // The same supplier's same number is the same note.
    expect((await note({ ...ok, supplier: 'ezz' })).status).toBe(409)
    expect((await note({ ...ok, supplier: 'Baosteel' })).status).toBe(201)
  })
})

describe('a coil’s certificate against its grade', () => {
  it('is judged by the lab’s grade at its thickness, green or red, and again when the grade or an equivalence changes', async () => {
    const thin = await grade({ grade: 'QX420MC', thicknessFrom: null, thicknessTo: 3, yieldMin: 420, yieldMax: 540, tensileMin: 480, tensileMax: 620, elongationMin: 16 })
    expect(thin.status).toBe(201)
    await grade({ grade: 'QX420MC', thicknessFrom: 3, thicknessTo: null, yieldMin: 400, tensileMin: 460, tensileMax: 600, elongationMin: 19 })
    const saved = await saveCoils([
      { coilNumber: 'J-1', grade: 'QX420MC', thickness: 2, yield: 433, tensile: 530, elongation: 22 },
      // Thick: its own band; the elongation short.
      { coilNumber: 'J-2', grade: 'QX420MC', thickness: 4, yield: 410, tensile: 500, elongation: 18 },
      { coilNumber: 'J-3', grade: 'QY355', thickness: 2, yield: 300 },
    ])
    expect(saved.status).toBe(200)
    expect(await coil('J-1')).toMatchObject({ stdGrade: 'QX420MC', yieldOk: true, tensileOk: true, elongationOk: true })
    expect(await coil('J-2')).toMatchObject({ stdGrade: 'QX420MC', yieldOk: true, tensileOk: true, elongationOk: false })
    expect(await coil('J-3')).toMatchObject({ stdGrade: null, yieldOk: null })

    // The table carries the limits with the row, for the screen's red and green and their tooltips.
    const rows = (await app.api<MtcTableResponse>('GET', `/api/mtc/coils/table?sort=coilNumber:asc`, { token: viewer.token })).body.rows
    expect(rows[1].standard).toEqual({ grade: 'QX420MC', standard: 'EN 10149-2', yieldMin: 400, yieldMax: null, tensileMin: 460, tensileMax: 600, elongationMin: 19 })
    expect(rows[2]).not.toHaveProperty('standard')

    // A stricter grade turns J-1 red; an equivalence gives J-3 a grade.
    await app.api('PUT', `/api/lab/grades/${thin.body.id}`, {
      token: admin.token,
      body: { family: 'sheet', grade: 'QX420MC', standard: 'EN 10149-2', thicknessFrom: null, thicknessTo: 3, yieldMin: 440, yieldMax: 540, tensileMin: 480, tensileMax: 620, elongationMin: 16, hardness: '' },
    })
    expect(await coil('J-1')).toMatchObject({ yieldOk: false })
    expect((await app.api('POST', '/api/master/grade-mappings', { token: admin.token, body: { gradeA: 'QY355', gradeB: 'QX420MC' } })).status).toBe(201)
    expect(await coil('J-3')).toMatchObject({ stdGrade: 'QX420MC', yieldOk: false })
    const ai = await app.db.query(`SELECT coil_number, yield_ok, tensile_ok, elongation_ok, std_grade FROM ai.coils WHERE coil_number = 'J-2'`)
    expect(ai.rows).toEqual([{ coil_number: 'J-2', yield_ok: true, tensile_ok: true, elongation_ok: false, std_grade: 'QX420MC' }])

    // The review judges before saving from the same grades.
    const standards = await app.api<{ grades: { grade: string }[]; gradeMappings: unknown[] }>('GET', '/api/mtc/coils/standards', { token: uploader.token })
    expect(standards.body.grades.filter((g) => g.grade === 'QX420MC')).toHaveLength(2)
  })

  it('links every coil saved from a certificate to the kept file, which opens for the register’s readers', async () => {
    const doc = (await app.db.query<{ id: string }>(`INSERT INTO mtc_documents (file_name, source, storage_keys, driver, byte_size) VALUES ('x.pdf', 'pdf', ARRAY['documents/mtc/x.pdf'], 'local', 1) RETURNING id`)).rows[0].id
    expect((await saveCoils([{ coilNumber: 'L-1' }], { documentId: doc })).status).toBe(200)
    expect(await coil('L-1')).toMatchObject({ documentId: doc })
    const rows = (await app.api<MtcTableResponse>('GET', `/api/mtc/coils/table`, { token: viewer.token })).body.rows
    expect(rows[0].documentId).toBe(doc)
    // Overwritten without a file: the link stays.
    await saveCoils([{ coilNumber: 'L-1', grade: 'S235JR' }])
    expect(await coil('L-1')).toMatchObject({ documentId: doc })
    expect((await saveCoils([{ coilNumber: 'L-2' }], { documentId: '00000000-0000-4000-8000-000000000000' })).status).toBe(400)
  })
})

describe('slitting', () => {
  it('records the day and the strips’ widths, no wider than the coil, for whoever may; and takes one back', async () => {
    await saveCoils([{ coilNumber: 'S-1', grade: 'S235JR', thickness: 2, width: 1250 }])
    const { id } = await coil('S-1')
    const slit = (body: Item, as: Session = inspector) => app.api<CoilSlitting & ApiErrorBody>('POST', `/api/mtc/coils/${id}/slittings`, { token: as.token, body })
    expect((await slit({ slitDate: '2026-10-15', widths: [400, 400, 400] }, viewer)).status).toBe(403)
    expect((await slit({ slitDate: '2026-10-15', widths: [700, 600] })).status).toBe(400)
    expect((await slit({ slitDate: '2026-10-15', widths: [] })).status).toBe(400)
    const made = await slit({ slitDate: '2026-10-15', widths: [400, 400, 420.5], notes: 'Line 2' })
    expect(made.status).toBe(201)
    expect(made.body).toMatchObject({ slitDate: '2026-10-15', widths: [400, 400, 420.5], totalWidth: 1220.5, notes: 'Line 2', createdByName: 'Inspector' })

    const details = (await app.api<CoilDetails>('GET', `/api/mtc/coils/${id}/details`, { token: viewer.token })).body
    expect(details.coil.values).toMatchObject({ coilNumber: 'S-1', width: 1250 })
    expect(details.slittings.map((s) => s.widths)).toEqual([[400, 400, 420.5]])
    const ai = await app.db.query(`SELECT coil_number, slit_date::text, widths_mm, strips, total_width_mm, trim_mm FROM ai.coil_slittings`)
    expect(ai.rows).toEqual([{ coil_number: 'S-1', slit_date: '2026-10-15', widths_mm: [400, 400, 420.5], strips: 3, total_width_mm: 1220.5, trim_mm: 29.5 }])

    expect((await app.api('DELETE', `/api/mtc/slittings/${made.body.id}`, { token: viewer.token })).status).toBe(403)
    expect((await app.api('DELETE', `/api/mtc/slittings/${made.body.id}`, { token: inspector.token })).status).toBe(204)
    expect((await app.api<CoilDetails>('GET', `/api/mtc/coils/${id}/details`, { token: viewer.token })).body.slittings).toEqual([])
    const audit = await app.db.query(`SELECT action, item, new_value AS "newValue", old_value AS "oldValue" FROM audit_log WHERE entity = 'CoilSlitting' ORDER BY at`)
    expect(audit.rows).toEqual([
      { action: 'create', item: 'S-1', newValue: '2026-10-15: 400 + 400 + 420.5 mm — Line 2', oldValue: null },
      { action: 'delete', item: 'S-1', newValue: null, oldValue: '2026-10-15: 400 + 400 + 420.5 mm' },
    ])
  })
})
