import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import type { ApiErrorBody } from '@qc/shared/api'
import type { Coil, UserProfile } from '@qc/shared/types'
import { MTC_MODEL, type CoilTableOptionsResponse, type CoilTableResponse, type MtcExistingResponse, type MtcSaveResponse, type MtcStreamEvent } from '@qc/shared/mtc'
import { TestApp, type Session } from './harness'
import { apiError, text } from './aiFake'

// MTC — a mill test certificate read into the coil register: allowed person
// by person, read by Claude with the company's key (no access to the
// assistant needed), never stored, reviewed, then saved with an audit trail.

const app = new TestApp()
let admin: Session
let uploader: Session
let inspector: Session
let viewer: Session
const KEY = `sk-ant-api03-${'m_7-'.repeat(20)}MtCk`
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n')

interface ReplyCoil {
  coilNumber: string
  grade?: string | null
  smType?: string | null
  supplier?: string | null
  thickness?: number | null
  width?: number | null
  yield?: number | null
  certificateNumber?: string | null
  page?: number
  uncertain?: string[]
}
const coilOf = (c: ReplyCoil) => ({
  grade: null,
  smType: null,
  supplier: null,
  thickness: null,
  width: null,
  yield: null,
  certificateNumber: null,
  page: 1,
  uncertain: [],
  ...c,
})
const reply = (coils: ReplyCoil[], extra: { documentKind?: string; problem?: string | null } = {}) =>
  text(JSON.stringify({ documentKind: extra.documentKind ?? 'coil-certificate', problem: extra.problem ?? null, coils: coils.map(coilOf) }))

async function extract(bytes: Buffer, name: string, as: Session = uploader) {
  const form = new FormData()
  form.set('file', new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }), name)
  const res = await app.api<string | ApiErrorBody>('POST', '/api/mtc/extract', { token: as.token, raw: form })
  const events: MtcStreamEvent[] =
    res.status === 200
      ? (res.body as string)
          .split('\n\n')
          .filter((f) => f && !f.startsWith(':'))
          .map((f) => JSON.parse(/\ndata: (.+)$/.exec(f)![1]) as MtcStreamEvent)
      : []
  return { res, events, result: events.find((e): e is Extract<MtcStreamEvent, { type: 'result' }> => e.type === 'result')?.result }
}

const save = (rows: object[], as: Session = uploader, fileName = 'MTC 067711.pdf') =>
  app.api<MtcSaveResponse & ApiErrorBody>('POST', '/api/mtc/save', { token: as.token, body: { fileName, rows } })

const coilRow = async (coilNumber: string) =>
  (await app.db.query<Coil & { deleted: boolean }>(
    `SELECT coil_number AS "coilNumber", grade, sm_type AS "smType", supplier, thickness, width, yield, notes, deleted_at IS NOT NULL AS deleted FROM coils WHERE lower(coil_number) = lower($1)`,
    [coilNumber],
  )).rows[0]

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
  const granted = await app.api<UserProfile>('PATCH', `/api/users/${uploader.user.id}`, { token: admin.token, body: { mtcUpload: true } })
  expect(granted.status).toBe(200)
  expect(granted.body.mtcUpload).toBe(true)
  expect((await app.api('PUT', '/api/ai/key', { token: admin.token, body: { apiKey: KEY } })).status).toBe(200)
})
afterAll(() => app.stop())
beforeEach(async () => {
  app.model.reset()
  await app.db.query(`ALTER TABLE coils DISABLE TRIGGER coils_no_delete; DELETE FROM coils; ALTER TABLE coils ENABLE TRIGGER coils_no_delete;`)
})

describe('the MTC permission', () => {
  it('is given person by person by an administrator, shows on the profile and is audited', async () => {
    const me = await app.api<UserProfile>('GET', '/api/auth/me', { token: uploader.token })
    expect(me.body.mtcUpload).toBe(true)
    expect((await app.api<UserProfile>('GET', '/api/auth/me', { token: inspector.token })).body.mtcUpload).toBe(false)
    const { rows } = await app.db.query(`SELECT field, old_value AS "oldValue", new_value AS "newValue" FROM audit_log WHERE entity = 'User' AND entity_id = $1 AND field = 'mtcUpload'`, [
      uploader.user.id,
    ])
    expect(rows).toEqual([{ field: 'mtcUpload', oldValue: 'may not upload MTC', newValue: 'may upload MTC' }])
    // Not an administrator: they cannot give it to themselves.
    expect((await app.api('PATCH', `/api/users/${inspector.user.id}`, { token: uploader.token, body: { mtcUpload: true } })).status).toBe(403)
  })

  it('is needed to read and to save, and nothing of the file is taken in without it', async () => {
    const read = await extract(PDF, 'cert.pdf', inspector)
    expect(read.res.status).toBe(403)
    expect(app.model.counted).toHaveLength(0)
    expect((await save([{ coilNumber: 'X1', overwrite: false }], inspector)).status).toBe(403)
    // Taken away, it stops at once: the token still says nothing about it.
    await app.api('PATCH', `/api/users/${uploader.user.id}`, { token: admin.token, body: { mtcUpload: false } })
    expect((await extract(PDF, 'cert.pdf')).res.status).toBe(403)
    await app.api('PATCH', `/api/users/${uploader.user.id}`, { token: admin.token, body: { mtcUpload: true } })
  })
})

describe('reading a certificate', () => {
  it('sends the PDF to Claude on the MTC model, held to the schema, and returns the cleaned rows', async () => {
    app.model.reply({
      content: [
        reply([
          { coilNumber: '213417-506', grade: 'S450GD+Z275', smType: 'GI', supplier: 'arcelormittal', thickness: 3.5, width: 1285, yield: 464, certificateNumber: '20230055086-00', page: 1 },
          { coilNumber: ' 306043-0-02 ', grade: 's420 mc', smType: 'HR', supplier: 'Ezz', thickness: 2, width: 320, yield: 433, certificateNumber: '067711', page: 2, uncertain: ['yield'] },
          // The same coil in a second table: one row, the second table's value where the first had none.
          { coilNumber: '306043-0-02', grade: 'S420MC', smType: 'HR', supplier: 'Ezz', thickness: 2, width: 320, yield: 433, certificateNumber: '067711', page: 2 },
          { coilNumber: 'S021480625', grade: 'S550GD+Z275', smType: 'GI', supplier: 'Tosyali', thickness: 2.7, width: 347, yield: null, certificateNumber: '21GB12875', page: 1, uncertain: ['width'] },
          { coilNumber: '   ' },
        ]),
      ],
      usage: { input_tokens: 40_000, output_tokens: 3_000 },
    })
    const { res, events, result } = await extract(PDF, 'شهادة MTC.pdf')
    expect(res.status).toBe(200)
    expect(events.map((e) => e.type)).toEqual(['reading', 'result'])
    expect(result).toEqual({
      fileName: 'شهادة MTC.pdf',
      notCoils: false,
      coils: [
        { coilNumber: '213417-506', grade: 'S450GD+Z275', smType: 'GI', supplier: 'ArcelorMittal', thickness: 3.5, width: 1285, yield: 464, notes: 'MTC 20230055086-00', page: 1, uncertain: [] },
        { coilNumber: '306043-0-02', grade: 'S420MC', smType: 'HR', supplier: 'Ezz', thickness: 2, width: 320, yield: 433, notes: 'MTC 067711', page: 2, uncertain: [] },
        { coilNumber: 'S021480625', grade: 'S550GD+Z275', smType: 'GI', supplier: 'Tosyali', thickness: 2.7, width: 347, notes: 'MTC 21GB12875', page: 1, uncertain: ['width', 'yield'] },
      ],
    })

    // Counted, then read, on the MTC model; the PDF as a document; the reply held to the schema.
    expect(app.model.counted).toHaveLength(1)
    expect(app.model.counted[0].model).toBe(MTC_MODEL)
    expect(app.model.calls).toHaveLength(1)
    const params = app.model.calls[0].params
    expect(params.model).toBe(MTC_MODEL)
    expect(params.output_config?.format?.type).toBe('json_schema')
    const content = params.messages[0].content as Anthropic.Beta.BetaContentBlockParam[]
    expect(content[0]).toMatchObject({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF.toString('base64') } })
    expect(String(params.system)).toContain('"213417-506"')
    expect(String(params.system)).toContain('"S450GD+Z275"')

    // The call is counted in the assistant's spend, for this person; the file is kept nowhere.
    const usage = await app.db.query(`SELECT user_id AS "userId", model, input_tokens AS "in", conversation_id AS "conversationId" FROM ai_usage`)
    expect(usage.rows).toEqual([{ userId: uploader.user.id, model: MTC_MODEL, in: 40_000, conversationId: null }])
    expect((await app.db.query(`SELECT count(*)::int AS n FROM ai_attachments`)).rows[0].n).toBe(0)
    // Reading writes nothing to the register.
    expect((await app.db.query(`SELECT count(*)::int AS n FROM coils`)).rows[0].n).toBe(0)
  })

  it('needs no access to the AI assistant', async () => {
    const { rows } = await app.db.query(`SELECT count(*)::int AS n FROM ai_access WHERE user_id = $1`, [uploader.user.id])
    expect(rows[0].n).toBe(0)
    app.model.reply({ content: [reply([{ coilNumber: 'C1' }])] })
    expect((await extract(PDF, 'cert.pdf')).result?.coils).toHaveLength(1)
  })

  it('lists nothing from a document that is not a coil certificate, and says what it is', async () => {
    app.model.reply({ content: [reply([], { documentKind: 'other', problem: 'This is a certificate for galvanized wire, not steel coils.' })] })
    const { result } = await extract(PDF, 'TSG wire.pdf')
    expect(result).toEqual({ fileName: 'TSG wire.pdf', notCoils: true, coils: [], problem: 'This is a certificate for galvanized wire, not steel coils.' })
  })

  it('refuses what is not a PDF, and a PDF Claude cannot read, before anything is billed', async () => {
    const notPdf = await extract(Buffer.from('hello'), 'cert.pdf')
    expect(notPdf.res.status).toBe(400)
    app.model.tokenCount = () => {
      throw apiError(400, 'The PDF has more than 100 pages.')
    }
    const unreadable = await extract(PDF, 'cert.pdf')
    expect(unreadable.res.status).toBe(400)
    expect((unreadable.res.body as ApiErrorBody).error.message).toMatch(/cannot read this PDF/)
    expect(app.model.calls).toHaveLength(0)
  })

  it('tells the person when a certificate is too long for one reading, and still counts what it cost', async () => {
    app.model.reply({ content: [text('{"documentKind":"coil-certificate","problem":null,"coils":[')], stopReason: 'max_tokens', usage: { input_tokens: 9_000, output_tokens: 48_000 } })
    const { events } = await extract(PDF, 'long.pdf')
    expect(events.at(-1)).toEqual({ type: 'error', code: 'validation', message: expect.stringMatching(/Split the PDF/) })
    const usage = await app.db.query(`SELECT output_tokens AS out FROM ai_usage WHERE user_id = $1 ORDER BY id DESC LIMIT 1`, [uploader.user.id])
    expect(usage.rows[0].out).toBe(48_000)
  })

  it('is held to the assistant’s switch and monthly cap', async () => {
    await app.api('PUT', '/api/ai/settings', { token: admin.token, body: { enabled: false, monthlyCapUsd: 100 } })
    expect((await extract(PDF, 'cert.pdf')).res.status).toBe(503)
    await app.api('PUT', '/api/ai/settings', { token: admin.token, body: { enabled: true, monthlyCapUsd: 0.5 } })
    app.model.tokenCount = () => 200_000
    const capped = await extract(PDF, 'cert.pdf')
    expect(capped.res.status).toBe(402)
    expect(app.model.calls).toHaveLength(0)
    await app.api('PUT', '/api/ai/settings', { token: admin.token, body: { enabled: true, monthlyCapUsd: 100 } })
  })
})

describe('saving the reviewed coils', () => {
  it('adds new coils, leaves registered ones unless asked, and overwrites without erasing', async () => {
    await app.db.query(
      `INSERT INTO coils (coil_number, grade, sm_type, supplier, thickness, width, yield, notes) VALUES
         ('OLD-1', 'S355MC', 'HR', 'Ezz', 2, 1000, 380, 'from the sheet'),
         ('OLD-2', 'S355MC', 'HR', 'Ezz', 2, 1000, 380, 'from the sheet')`,
    )
    const res = await save([
      { coilNumber: '213417-506', grade: 'S450GD+Z275', smType: 'GI', supplier: 'ArcelorMittal', thickness: 3.5, width: 1285, yield: 464, notes: 'MTC 20230055086-00', overwrite: false },
      { coilNumber: 'old-1', grade: 'S420MC', yield: 433, notes: 'MTC 067711', overwrite: false },
      // A blank keeps the register's value: the supplier and width stay.
      { coilNumber: 'OLD-2', grade: 'S420MC', thickness: '2.4', yield: 433, notes: 'MTC 067711', overwrite: true },
    ])
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ inserted: ['213417-506'], updated: ['OLD-2'], skipped: ['OLD-1'] })
    expect(await coilRow('213417-506')).toMatchObject({ grade: 'S450GD+Z275', smType: 'GI', supplier: 'ArcelorMittal', thickness: 3.5, width: 1285, yield: 464, notes: 'MTC 20230055086-00' })
    expect(await coilRow('OLD-1')).toMatchObject({ grade: 'S355MC', yield: 380, notes: 'from the sheet' })
    expect(await coilRow('OLD-2')).toMatchObject({ grade: 'S420MC', smType: 'HR', supplier: 'Ezz', thickness: 2.4, width: 1000, yield: 433, notes: 'MTC 067711' })

    const audit = await app.db.query<{ action: string; field: string; oldValue: string | null; newValue: string | null; userName: string }>(
      `SELECT a.action, a.field, a.old_value AS "oldValue", a.new_value AS "newValue", a.user_name AS "userName"
         FROM audit_log a JOIN coils c ON c.id::text = a.entity_id WHERE a.entity = 'Coil' ORDER BY c.coil_number, a.id`,
    )
    expect(audit.rows).toEqual([
      {
        action: 'create',
        field: 'source',
        oldValue: null,
        newValue: 'MTC upload: MTC 067711.pdf — grade S450GD+Z275; smType GI; supplier ArcelorMittal; thickness 3.5; width 1285; yield 464; notes MTC 20230055086-00',
        userName: 'Uploader',
      },
      { action: 'update', field: 'grade', oldValue: 'S355MC', newValue: 'S420MC', userName: 'Uploader' },
      { action: 'update', field: 'thickness', oldValue: '2', newValue: '2.4', userName: 'Uploader' },
      { action: 'update', field: 'yield', oldValue: '380', newValue: '433', userName: 'Uploader' },
      { action: 'update', field: 'notes', oldValue: 'from the sheet', newValue: 'MTC 067711', userName: 'Uploader' },
      { action: 'update', field: 'source', oldValue: null, newValue: 'MTC upload: MTC 067711.pdf', userName: 'Uploader' },
    ])
  })

  it('brings back a removed coil only when asked to overwrite it', async () => {
    await app.db.query(`INSERT INTO coils (coil_number, grade, deleted_at) VALUES ('GONE-1', 'S235JR', now()), ('GONE-2', 'S235JR', now())`)
    const res = await save([
      { coilNumber: 'GONE-1', grade: 'S235JR', overwrite: true },
      { coilNumber: 'GONE-2', grade: 'S235JR', overwrite: false },
    ])
    expect(res.body).toEqual({ inserted: [], updated: ['GONE-1'], skipped: ['GONE-2'] })
    expect((await coilRow('GONE-1')).deleted).toBe(false)
    expect((await coilRow('GONE-2')).deleted).toBe(true)
  })

  it('skips an overwrite that changes nothing', async () => {
    await app.db.query(`INSERT INTO coils (coil_number, grade, yield) VALUES ('SAME', 'S315MC', 349)`)
    const res = await save([{ coilNumber: 'SAME', grade: 'S315MC', yield: 349, overwrite: true }])
    expect(res.body).toEqual({ inserted: [], updated: [], skipped: ['SAME'] })
    const audited = await app.db.query(`SELECT count(*)::int AS n FROM audit_log a JOIN coils c ON c.id::text = a.entity_id WHERE a.entity = 'Coil'`)
    expect(audited.rows[0].n).toBe(0)
  })

  it('refuses the whole batch when a row is wrong: a coil twice, no number, a bad measurement', async () => {
    expect((await save([{ coilNumber: 'A1', overwrite: false }, { coilNumber: 'a1', overwrite: false }])).status).toBe(400)
    expect((await save([{ coilNumber: '  ', overwrite: false }])).status).toBe(400)
    expect((await save([{ coilNumber: 'A2', thickness: -1, overwrite: false }])).status).toBe(400)
    expect((await save([{ coilNumber: 'A3', yield: 'abc', overwrite: false }])).status).toBe(400)
    expect((await save([{ coilNumber: 'A4', grade: 'G'.repeat(61), overwrite: false }])).status).toBe(400)
    expect((await app.db.query(`SELECT count(*)::int AS n FROM coils`)).rows[0].n).toBe(0)
  })

  it('shows the review what is already registered, removed coils included', async () => {
    await app.db.query(`INSERT INTO coils (coil_number, grade, deleted_at) VALUES ('E-1', 'S315MC', NULL), ('E-2', 'S355MC', now())`)
    const res = await app.api<MtcExistingResponse>('POST', '/api/mtc/existing', { token: inspector.token, body: { coilNumbers: ['e-1', 'E-2', 'E-3', ''] } })
    expect(res.status).toBe(200)
    expect(res.body.map((c) => ({ coilNumber: c.coilNumber, grade: c.grade, deleted: !!c.deletedAt })).sort((a, b) => a.coilNumber.localeCompare(b.coilNumber))).toEqual([
      { coilNumber: 'E-1', grade: 'S315MC', deleted: false },
      { coilNumber: 'E-2', grade: 'S355MC', deleted: true },
    ])
  })
})

describe('the coil register’s table', () => {
  beforeEach(async () => {
    await app.db.query(
      `INSERT INTO coils (coil_number, grade, sm_type, supplier, notes, created_at) VALUES
         ('B-200', 'S315MC', 'HR', 'Baosteel', 'MTC XQ1M023-01', now() - interval '3 days'),
         ('A-100', 'S450GD+Z275', 'GI', 'ArcelorMittal', 'MTC 20230055086-00', now() - interval '2 days'),
         ('C-300', 'S420MC', 'hr', 'ezz', NULL, now() - interval '1 day'),
         ('D-400', 'S420MC', 'HR', 'Ezz', NULL, now())`,
    )
    await app.db.query(`INSERT INTO coils (coil_number, deleted_at) VALUES ('Z-999', now())`)
  })

  it('is open to everyone signed in, a viewer too, a page at a time with the total', async () => {
    const res = await app.api<CoilTableResponse>('GET', '/api/coils/table?limit=2', { token: viewer.token })
    expect(res.status).toBe(200)
    expect(res.body.total).toBe(4)
    expect(res.body.rows.map((c) => c.coilNumber)).toEqual(['A-100', 'B-200'])
    const next = await app.api<CoilTableResponse>('GET', '/api/coils/table?limit=2&offset=2', { token: viewer.token })
    expect(next.body.rows.map((c) => c.coilNumber)).toEqual(['C-300', 'D-400'])
  })

  it('searches the number, grade, supplier and notes, filters exactly, and sorts the newest first', async () => {
    const get = async (q: string) => (await app.api<CoilTableResponse>('GET', `/api/coils/table${q}`, { token: inspector.token })).body
    expect((await get('?search=23-01')).rows.map((c) => c.coilNumber)).toEqual(['B-200'])
    expect((await get('?search=gd%2Bz')).rows.map((c) => c.coilNumber)).toEqual(['A-100'])
    expect((await get('?search=%25')).total).toBe(0)
    expect((await get('?supplier=EZZ')).rows.map((c) => c.coilNumber)).toEqual(['C-300', 'D-400'])
    expect((await get('?smType=GI')).rows.map((c) => c.coilNumber)).toEqual(['A-100'])
    expect((await get('?sort=newest')).rows.map((c) => c.coilNumber)).toEqual(['D-400', 'C-300', 'A-100', 'B-200'])
  })

  it('offers the registered suppliers and SM types as filters, once each whatever their case', async () => {
    const res = await app.api<CoilTableOptionsResponse>('GET', '/api/coils/table/options', { token: viewer.token })
    expect(res.body.suppliers).toHaveLength(3)
    expect(res.body.suppliers.map((s) => s.toLowerCase())).toEqual(['arcelormittal', 'baosteel', 'ezz'])
    expect(res.body.smTypes.map((s) => s.toUpperCase())).toEqual(['GI', 'HR'])
  })
})
