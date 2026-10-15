import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import type { ApiErrorBody } from '@qc/shared/api'
import { AI_DEFAULT_SETTINGS, AI_MTC_REREAD_MODEL, resolveAiAction, type AiActivityResponse, type AiMeResponse } from '@qc/shared/ai'
import type { MtcExistingResponse, MtcKind, MtcSaveResponse, MtcStreamEvent, MtcTableOptionsResponse, MtcTableResponse } from '@qc/shared/mtc'
import { TestApp, type Session } from './harness'
import { apiError, text } from './aiFake'

// MTC — suppliers' certificates read into the material registers (coils,
// welding wire, mesh wire): allowed person by person by the AI assistant's
// owner with the rest of their AI settings (the assistant itself may be off
// for them), read by Claude with the company's key on the model the owner
// chose, never stored, reviewed, then saved with an audit trail; every
// reading's cost in the owner's Activity.

const app = new TestApp()
let admin: Session
let uploader: Session
let inspector: Session
let viewer: Session
const MTC_MODEL = resolveAiAction(AI_DEFAULT_SETTINGS, 'mtc').model
const KEY = `sk-ant-api03-${'m_7-'.repeat(20)}MtCk`
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n')

const COIL = { grade: null, smType: null, supplier: null, thickness: null, width: null, yield: null, certificateNumber: null, page: 1, uncertain: [] }
const WELD = { classification: null, wireType: null, diameter: null, supplier: null, weightKg: null, yield: null, tensile: null, certificateNumber: null, page: 1, uncertain: [] }
const MESH = { product: null, grade: null, supplier: null, tensile: null, certificateNumber: null, page: 1, uncertain: [] }

type Item = Record<string, unknown>
const reply = (kind: MtcKind | 'other', items: Item[] = [], problem: string | null = null) =>
  text(
    JSON.stringify({
      documentKind: kind,
      problem,
      coils: kind === 'coils' ? items.map((i) => ({ ...COIL, ...i })) : [],
      weldingWires: kind === 'welding-wire' ? items.map((i) => ({ ...WELD, ...i })) : [],
      meshWires: kind === 'mesh-wire' ? items.map((i) => ({ ...MESH, ...i })) : [],
    }),
  )

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

const save = (kind: MtcKind, rows: { values: Item; overwrite: boolean }[], as: Session = uploader, fileName = 'MTC 067711.pdf') =>
  app.api<MtcSaveResponse & ApiErrorBody>('POST', `/api/mtc/${kind}/save`, { token: as.token, body: { fileName, rows } })
const row = (values: Item, overwrite = false) => ({ values, overwrite })

const coilRow = async (coilNumber: string) =>
  (
    await app.db.query(
      `SELECT coil_number AS "coilNumber", grade, sm_type AS "smType", supplier, thickness, width, yield, notes, deleted_at IS NOT NULL AS deleted FROM coils WHERE lower(coil_number) = lower($1)`,
      [coilNumber],
    )
  ).rows[0]

/** The owner's AI settings for a person: the assistant off for them, certificates allowed or not. */
const setMtc = (who: Session, mtc: boolean, monthlyCapUsd = 50) =>
  app.api('PUT', `/api/ai/access/${who.user.id}`, {
    token: admin.token,
    body: { enabled: false, domains: ['inspection'], monthlyCapUsd, mtc },
  })
const me = async (who: Session) => (await app.api<AiMeResponse>('GET', '/api/ai/me', { token: who.token })).body

const table = async (kind: string, q = '', as: Session = inspector) => (await app.api<MtcTableResponse & ApiErrorBody>('GET', `/api/mtc/${kind}/table${q}`, { token: as.token })).body

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
  expect((await setMtc(uploader, true)).status).toBe(200)
  expect((await app.api('PUT', '/api/ai/key', { token: admin.token, body: { apiKey: KEY } })).status).toBe(200)
})
afterAll(() => app.stop())
beforeEach(async () => {
  app.model.reset()
  for (const t of ['coils', 'welding_wires', 'mesh_wires']) {
    await app.db.query(`ALTER TABLE ${t} DISABLE TRIGGER ${t}_no_delete; DELETE FROM ${t}; ALTER TABLE ${t} ENABLE TRIGGER ${t}_no_delete;`)
  }
})

describe('the MTC permission', () => {
  it('is given person by person by the AI assistant’s owner, with the assistant off for them, and is audited', async () => {
    expect(await me(uploader)).toMatchObject({ granted: false, mtc: true })
    expect(await me(inspector)).toMatchObject({ granted: false, mtc: false })
    expect((await me(admin)).mtc).toBe(true)
    const { rows } = await app.db.query(`SELECT action, new_value AS "newValue" FROM audit_log WHERE entity = 'AiAccess' AND entity_id = $1`, [uploader.user.id])
    expect(rows).toEqual([{ action: 'create', newValue: expect.stringContaining('may upload MTC certificates') }])
    // The owner's alone to give: anyone else does not even see the route.
    expect((await app.api('PUT', `/api/ai/access/${inspector.user.id}`, { token: uploader.token, body: { enabled: false, domains: ['inspection'], monthlyCapUsd: 5, mtc: true } })).status).toBe(404)
    // The Users page no longer carries it.
    expect((await app.api('PATCH', `/api/users/${inspector.user.id}`, { token: admin.token, body: { mtcUpload: true } })).status).toBe(400)
  })

  it('is needed to read and to save, and nothing of the file is taken in without it', async () => {
    expect((await extract(PDF, 'cert.pdf', inspector)).res.status).toBe(403)
    expect(app.model.counted).toHaveLength(0)
    for (const kind of ['coils', 'welding-wire', 'mesh-wire'] as const) {
      expect((await save(kind, [row({ coilNumber: 'X1', batchNumber: 'B1', castNumber: 'C1', diameter: 4 })], inspector)).status).toBe(403)
    }
    // Taken away, it stops at once: the token says nothing about it.
    await setMtc(uploader, false)
    expect((await extract(PDF, 'cert.pdf')).res.status).toBe(403)
    await setMtc(uploader, true)
  })
})

describe('reading a certificate', () => {
  it('reads coils on the model the owner chose, held to the schema, and returns the cleaned rows', async () => {
    app.model.reply({
      content: [
        reply('coils', [
          { coilNumber: '213417-506', grade: 'S450GD+Z275', smType: 'GI', supplier: 'arcelormittal', thickness: 3.5, width: 1285, yield: 464, certificateNumber: '20230055086-00' },
          { coilNumber: ' 306043-0-02 ', grade: 's420 mc', smType: 'HR', supplier: 'Ezz', thickness: 2, width: 320, yield: 433, certificateNumber: '067711', page: 2, uncertain: ['yield'] },
          // The same coil in a second table: one row, the second table's value where the first had none.
          { coilNumber: '306043-0-02', grade: 'S420MC', smType: 'HR', supplier: 'Ezz', thickness: 2, width: 320, yield: 433, certificateNumber: '067711', page: 2 },
          { coilNumber: 'S021480625', grade: 'S550GD+Z275', smType: 'GI', supplier: 'Tosyali', thickness: 2.7, width: 347, yield: null, certificateNumber: '21GB12875', uncertain: ['width'] },
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
      kind: 'coils',
      rows: [
        {
          values: { coilNumber: '213417-506', grade: 'S450GD+Z275', smType: 'GI', supplier: 'ArcelorMittal', thickness: 3.5, width: 1285, yield: 464, notes: 'MTC 20230055086-00' },
          page: 1,
          uncertain: [],
        },
        { values: { coilNumber: '306043-0-02', grade: 'S420MC', smType: 'HR', supplier: 'Ezz', thickness: 2, width: 320, yield: 433, notes: 'MTC 067711' }, page: 2, uncertain: [] },
        { values: { coilNumber: 'S021480625', grade: 'S550GD+Z275', smType: 'GI', supplier: 'Tosyali', thickness: 2.7, width: 347, notes: 'MTC 21GB12875' }, page: 1, uncertain: ['width', 'yield'] },
      ],
    })

    // Counted, then read, on the recommended model and effort for certificates; the PDF as a document; the reply held to the schema.
    expect(MTC_MODEL).toBe('claude-sonnet-5-5')
    expect(app.model.counted.map((c) => c.model)).toEqual([MTC_MODEL])
    expect(app.model.calls).toHaveLength(1)
    const params = app.model.calls[0].params
    expect(params.model).toBe(MTC_MODEL)
    expect(params.output_config?.effort).toBe('high')
    expect(params.output_config?.format?.type).toBe('json_schema')
    const content = params.messages[0].content as Anthropic.Beta.BetaContentBlockParam[]
    expect(content[0]).toMatchObject({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF.toString('base64') } })
    for (const rule of ['"213417-506"', '"S450GD+Z275"', '"E71T-1C"', '"FE360B"', 'never the required values']) expect(String(params.system)).toContain(rule)

    // The call is counted in the assistant's spend, for this person; the file is kept nowhere; nothing is registered yet.
    const usage = await app.db.query(`SELECT user_id AS "userId", model, input_tokens AS "in", conversation_id AS "conversationId" FROM ai_usage`)
    expect(usage.rows).toEqual([{ userId: uploader.user.id, model: MTC_MODEL, in: 40_000, conversationId: null }])
    expect((await app.db.query(`SELECT count(*)::int AS n FROM ai_attachments`)).rows[0].n).toBe(0)
    expect((await app.db.query(`SELECT count(*)::int AS n FROM coils`)).rows[0].n).toBe(0)
  })

  it('reads on the model and effort the owner set for certificates in Models, and needs no access to the assistant', async () => {
    const set = await app.api('PUT', '/api/ai/settings', {
      token: admin.token,
      body: { enabled: true, monthlyCapUsd: 100, actions: { mtc: { model: 'claude-opus-5-5', effort: 'medium' } } },
    })
    expect(set.status).toBe(200)
    // The assistant is off for them: they cannot ask it anything, and still read certificates.
    expect((await app.db.query(`SELECT enabled FROM ai_access WHERE user_id = $1`, [uploader.user.id])).rows).toEqual([{ enabled: false }])
    expect((await me(uploader)).granted).toBe(false)
    app.model.reply({ content: [reply('coils', [{ coilNumber: 'C1' }])] })
    expect((await extract(PDF, 'cert.pdf')).result?.rows).toHaveLength(1)
    expect(app.model.calls[0].params.model).toBe('claude-opus-5-5')
    expect(app.model.calls[0].params.output_config?.effort).toBe('medium')
    const audit = await app.db.query(`SELECT old_value AS "oldValue", new_value AS "newValue" FROM audit_log WHERE entity = 'AppSettings' AND field = 'model: Reading a certificate (MTC)'`)
    expect(audit.rows).toEqual([{ oldValue: 'Auto · effort Auto', newValue: 'Claude Opus 5.5 · effort medium' }])
    // The owner alone sets it.
    expect(
      (await app.api('PUT', '/api/ai/settings', { token: uploader.token, body: { enabled: true, monthlyCapUsd: 100, actions: { mtc: { model: 'claude-haiku-5-5', effort: 'auto' } } } })).status,
    ).toBe(404)
    await app.api('PUT', '/api/ai/settings', { token: admin.token, body: { enabled: true, monthlyCapUsd: 100, actions: AI_DEFAULT_SETTINGS.actions } })
  })

  it('reads an unclear certificate again on the stronger model, by itself, and bills both readings to it', async () => {
    // Four of six values unsure: a poor scan.
    app.model.reply({ content: [reply('coils', [{ coilNumber: 'C9', grade: 'S350GD', thickness: 2, width: 1000, uncertain: ['grade', 'thickness', 'width', 'yield'] }])], usage: { input_tokens: 30_000, output_tokens: 1_000 } })
    app.model.reply({
      content: [reply('coils', [{ coilNumber: 'C9', grade: 'S350GD+Z275', smType: 'GI', supplier: 'Baosteel', thickness: 2.5, width: 1250, yield: 380, certificateNumber: 'B77' }])],
      usage: { input_tokens: 30_000, output_tokens: 2_000 },
    })
    const { events, result } = await extract(PDF, 'scan.pdf')
    expect(events.map((e) => e.type)).toEqual(['reading', 'rereading', 'result'])
    expect(events[1]).toEqual({ type: 'rereading', model: AI_MTC_REREAD_MODEL })
    expect(app.model.calls.map((c) => [c.params.model, c.params.output_config?.effort])).toEqual([
      [MTC_MODEL, 'high'],
      [AI_MTC_REREAD_MODEL, 'high'],
    ])
    // The second reading is the one handed over.
    expect(result?.rows).toEqual([
      { values: { coilNumber: 'C9', grade: 'S350GD+Z275', smType: 'GI', supplier: 'Baosteel', thickness: 2.5, width: 1250, yield: 380, notes: 'MTC B77' }, page: 1, uncertain: [] },
    ])
    const reading = await app.db.query(`SELECT id, outcome, items, reread FROM mtc_readings ORDER BY created_at DESC LIMIT 1`)
    expect(reading.rows[0]).toMatchObject({ outcome: 'read', items: 1, reread: true })
    const usage = await app.db.query(`SELECT model, output_tokens AS out FROM ai_usage WHERE mtc_reading_id = $1 ORDER BY id`, [reading.rows[0].id])
    expect(usage.rows).toEqual([
      { model: MTC_MODEL, out: 1_000 },
      { model: AI_MTC_REREAD_MODEL, out: 2_000 },
    ])
    const activity = await app.api<AiActivityResponse>('GET', '/api/ai/activity?kind=mtc', { token: admin.token })
    expect(activity.body.items[0].text).toContain('read again on a stronger model')
  })

  it('a clear certificate is read once; and with re-reading switched off, an unclear one too', async () => {
    app.model.reply({ content: [reply('coils', [{ coilNumber: 'C10', grade: 'S350GD', smType: 'HR', supplier: 'Ezz', thickness: 2, width: 1000, yield: 380, uncertain: ['yield'] }])] })
    expect((await extract(PDF, 'clear.pdf')).events.map((e) => e.type)).toEqual(['reading', 'result'])
    expect(app.model.calls).toHaveLength(1)

    await app.api('PUT', '/api/ai/settings', { token: admin.token, body: { enabled: true, monthlyCapUsd: 100, mtcReread: false } })
    app.model.reply({ content: [reply('coils', [{ coilNumber: 'C11', uncertain: ['grade', 'thickness', 'width', 'yield'] }])] })
    const { events, result } = await extract(PDF, 'scan.pdf')
    expect(events.map((e) => e.type)).toEqual(['reading', 'result'])
    expect(app.model.calls).toHaveLength(2)
    expect(result?.rows[0].values.coilNumber).toBe('C11')
    expect((await app.db.query(`SELECT reread FROM mtc_readings ORDER BY created_at DESC LIMIT 1`)).rows).toEqual([{ reread: false }])
    await app.api('PUT', '/api/ai/settings', { token: admin.token, body: { enabled: true, monthlyCapUsd: 100, mtcReread: true } })
  })

  it('does not read again on the same model: certificates already set to the strongest', async () => {
    await app.api('PUT', '/api/ai/settings', { token: admin.token, body: { enabled: true, monthlyCapUsd: 100, actions: { mtc: { model: AI_MTC_REREAD_MODEL, effort: 'auto' } } } })
    app.model.reply({ content: [reply('coils', [{ coilNumber: 'C12', uncertain: ['grade', 'thickness', 'width', 'yield'] }])] })
    expect((await extract(PDF, 'scan.pdf')).events.map((e) => e.type)).toEqual(['reading', 'result'])
    expect(app.model.calls).toHaveLength(1)
    await app.api('PUT', '/api/ai/settings', { token: admin.token, body: { enabled: true, monthlyCapUsd: 100, actions: AI_DEFAULT_SETTINGS.actions } })
  })

  it('tells a welding wire certificate apart and reads its batch, the deposited metal’s results and the weight', async () => {
    app.model.reply({
      content: [
        reply('welding-wire', [
          { batchNumber: '22285', classification: 'E71T-1C', wireType: 'Flux-cored', diameter: 1.2, supplier: 'Shiqiao', weightKg: 50000, yield: 485, tensile: 515, uncertain: ['weightKg'] },
        ]),
      ],
    })
    const { result } = await extract(PDF, '20261015065126.pdf')
    expect(result).toEqual({
      fileName: '20261015065126.pdf',
      kind: 'welding-wire',
      rows: [
        {
          values: { batchNumber: '22285', classification: 'E71T-1C', wireType: 'Flux-cored', diameter: 1.2, supplier: 'Shiqiao', weightKg: 50000, yield: 485, tensile: 515 },
          page: 1,
          uncertain: ['weightKg'],
        },
      ],
    })
  })

  it('reads mesh wire by cast and diameter, a cast drawn to two diameters being two rows', async () => {
    app.model.reply({
      content: [
        reply('mesh-wire', [
          { castNumber: '62920', diameter: 3.9, product: 'galvanized', grade: 'FE 360 B', supplier: 'TSG', tensile: 658, certificateNumber: '240733' },
          { castNumber: '62920', diameter: 4.8, product: 'Galvanized', grade: 'FE360B', supplier: 'TSG', tensile: 652, certificateNumber: '240733' },
          { castNumber: '701688', diameter: null, product: 'Bright', grade: 'FE360B', supplier: 'TSG', tensile: 690, certificateNumber: '240726', page: 2 },
        ]),
      ],
    })
    const { result } = await extract(PDF, 'Certificate - LINK MISR.pdf')
    expect(result?.kind).toBe('mesh-wire')
    expect(result?.rows.map((r) => r.values)).toEqual([
      { castNumber: '62920', diameter: 3.9, product: 'Galvanized', grade: 'FE360B', supplier: 'TSG', tensile: 658, notes: 'MTC 240733' },
      { castNumber: '62920', diameter: 4.8, product: 'Galvanized', grade: 'FE360B', supplier: 'TSG', tensile: 652, notes: 'MTC 240733' },
      // Its diameter unread: kept for the person to complete, marked.
      { castNumber: '701688', product: 'Bright', grade: 'FE360B', supplier: 'TSG', tensile: 690, notes: 'MTC 240726' },
    ])
    expect(result?.rows[2].uncertain).toEqual(['diameter'])
  })

  it('lists nothing from a document that fits no register, and says what it is', async () => {
    app.model.reply({ content: [reply('other', [], 'This is an invoice, not a certificate.')] })
    expect((await extract(PDF, 'invoice.pdf')).result).toEqual({ fileName: 'invoice.pdf', kind: null, rows: [], problem: 'This is an invoice, not a certificate.' })
  })

  it('refuses what is not a PDF, and a PDF Claude cannot read, before anything is billed', async () => {
    expect((await extract(Buffer.from('hello'), 'cert.pdf')).res.status).toBe(400)
    app.model.tokenCount = () => {
      throw apiError(400, 'The PDF has more than 100 pages.')
    }
    const unreadable = await extract(PDF, 'cert.pdf')
    expect(unreadable.res.status).toBe(400)
    expect((unreadable.res.body as ApiErrorBody).error.message).toMatch(/cannot read this PDF/)
    expect(app.model.calls).toHaveLength(0)
  })

  it('tells the person when a certificate is too long for one reading, and still counts what it cost', async () => {
    app.model.reply({ content: [text('{"documentKind":"coils","problem":null,"coils":[')], stopReason: 'max_tokens', usage: { input_tokens: 9_000, output_tokens: 48_000 } })
    const { events } = await extract(PDF, 'long.pdf')
    expect(events.at(-1)).toEqual({ type: 'error', code: 'validation', message: expect.stringMatching(/Split the PDF/) })
    const usage = await app.db.query(`SELECT output_tokens AS out FROM ai_usage WHERE user_id = $1 ORDER BY id DESC LIMIT 1`, [uploader.user.id])
    expect(usage.rows[0].out).toBe(48_000)
  })

  it('shows the owner, in Activity, who read which certificate and what it cost, counted in the month’s spend', async () => {
    // Clear readings, each read once.
    const clear = { grade: 'S350GD', smType: 'HR', supplier: 'Baosteel', thickness: 2, width: 1000, yield: 380 }
    app.model.reply({
      content: [reply('coils', [{ coilNumber: 'A1', ...clear }, { coilNumber: 'A2', ...clear }, { coilNumber: 'A3', ...clear }])],
      usage: { input_tokens: 30_000, output_tokens: 2_000 },
    })
    await extract(PDF, 'Baosteel 14192.pdf')
    app.model.reply({
      content: [reply('welding-wire', [{ batchNumber: '22285', classification: 'E71T-1C', wireType: 'Flux-cored', diameter: 1.2, supplier: 'Shiqiao', weightKg: 1000, yield: 485, tensile: 515 }])],
      usage: { input_tokens: 3_000, output_tokens: 500 },
    })
    await extract(PDF, 'Shiqiao.pdf')
    app.model.reply({ content: [reply('other', [], 'An invoice.')] })
    await extract(PDF, 'invoice.pdf')
    const activity = await app.api<AiActivityResponse>('GET', '/api/ai/activity?kind=mtc', { token: admin.token })
    expect(activity.status).toBe(200)
    // Newest first; the readings of the tests before are further down.
    expect(activity.body.items.slice(0, 3).map((i) => ({ kind: i.kind, userName: i.userName, text: i.text }))).toEqual([
      { kind: 'mtc', userName: 'Uploader', text: 'invoice.pdf — not a certificate of coils or wire' },
      { kind: 'mtc', userName: 'Uploader', text: 'Shiqiao.pdf — 1 welding wire batch read' },
      { kind: 'mtc', userName: 'Uploader', text: 'Baosteel 14192.pdf — 3 coils read' },
    ])
    // Sonnet 5.5: 30,000 in at $2 and 2,000 out at $10 a million.
    expect(Number(activity.body.items[2].costUsd)).toBeCloseTo(0.08, 6)
    expect(activity.body.people.map((p) => p.name)).toContain('Uploader')
    const all = await app.api<AiActivityResponse>('GET', '/api/ai/activity', { token: admin.token })
    expect(all.body.items.filter((i) => i.kind === 'mtc').length).toBe(activity.body.items.length)
    expect(activity.body.items.map((i) => i.text)).toContain('long.pdf — could not be read')
    // Nobody but the owner sees it.
    expect((await app.api('GET', '/api/ai/activity', { token: uploader.token })).status).toBe(404)
    const readings = await app.db.query(`SELECT file_name, kind, items, outcome FROM mtc_readings ORDER BY created_at DESC LIMIT 3`)
    expect(readings.rows.reverse()).toEqual([
      { file_name: 'Baosteel 14192.pdf', kind: 'coils', items: 3, outcome: 'read' },
      { file_name: 'Shiqiao.pdf', kind: 'welding-wire', items: 1, outcome: 'read' },
      { file_name: 'invoice.pdf', kind: null, items: 0, outcome: 'not-certificate' },
    ])
  })

  it('is held to the person’s own monthly cap, set with the permission', async () => {
    await setMtc(uploader, true, 0.01)
    app.model.tokenCount = () => 50_000
    const capped = await extract(PDF, 'cert.pdf')
    expect(capped.res.status).toBe(402)
    expect((capped.res.body as ApiErrorBody).error.message).toMatch(/this month’s AI limit/)
    expect(app.model.calls).toHaveLength(0)
    await setMtc(uploader, true)
  })

  it('is held to the assistant’s switch and monthly cap', async () => {
    await app.api('PUT', '/api/ai/settings', { token: admin.token, body: { enabled: false, monthlyCapUsd: 100 } })
    expect((await extract(PDF, 'cert.pdf')).res.status).toBe(503)
    await app.api('PUT', '/api/ai/settings', { token: admin.token, body: { enabled: true, monthlyCapUsd: 0.5 } })
    app.model.tokenCount = () => 200_000
    expect((await extract(PDF, 'cert.pdf')).res.status).toBe(402)
    expect(app.model.calls).toHaveLength(0)
    await app.api('PUT', '/api/ai/settings', { token: admin.token, body: { enabled: true, monthlyCapUsd: 100 } })
  })
})

describe('saving the reviewed items', () => {
  it('adds new coils, leaves registered ones unless asked, and overwrites without erasing', async () => {
    await app.db.query(
      `INSERT INTO coils (coil_number, grade, sm_type, supplier, thickness, width, yield, notes) VALUES
         ('OLD-1', 'S355MC', 'HR', 'Ezz', 2, 1000, 380, 'from the sheet'),
         ('OLD-2', 'S355MC', 'HR', 'Ezz', 2, 1000, 380, 'from the sheet')`,
    )
    const res = await save('coils', [
      row({ coilNumber: '213417-506', grade: 'S450GD+Z275', smType: 'GI', supplier: 'ArcelorMittal', thickness: 3.5, width: 1285, yield: 464, notes: 'MTC 20230055086-00' }),
      row({ coilNumber: 'old-1', grade: 'S420MC', yield: 433, notes: 'MTC 067711' }),
      // A blank keeps the register's value: the supplier and width stay.
      row({ coilNumber: 'OLD-2', grade: 'S420MC', thickness: '2.4', yield: 433, notes: 'MTC 067711' }, true),
    ])
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ inserted: ['213417-506'], updated: ['OLD-2'], skipped: ['OLD-1'] })
    expect(await coilRow('213417-506')).toMatchObject({ grade: 'S450GD+Z275', smType: 'GI', supplier: 'ArcelorMittal', thickness: 3.5, width: 1285, yield: 464, notes: 'MTC 20230055086-00' })
    expect(await coilRow('OLD-1')).toMatchObject({ grade: 'S355MC', yield: 380, notes: 'from the sheet' })
    expect(await coilRow('OLD-2')).toMatchObject({ grade: 'S420MC', smType: 'HR', supplier: 'Ezz', thickness: 2.4, width: 1000, yield: 433, notes: 'MTC 067711' })

    const audit = await app.db.query(
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

  it('brings back a removed item only when asked to overwrite it, and skips an overwrite that changes nothing', async () => {
    await app.db.query(`INSERT INTO coils (coil_number, grade, deleted_at) VALUES ('GONE-1', 'S235JR', now()), ('GONE-2', 'S235JR', now()), ('SAME', 'S315MC', NULL)`)
    const res = await save('coils', [row({ coilNumber: 'GONE-1', grade: 'S235JR' }, true), row({ coilNumber: 'GONE-2', grade: 'S235JR' }), row({ coilNumber: 'SAME', grade: 'S315MC' }, true)])
    expect(res.body).toEqual({ inserted: [], updated: ['GONE-1'], skipped: ['GONE-2', 'SAME'] })
    expect((await coilRow('GONE-1')).deleted).toBe(false)
    expect((await coilRow('GONE-2')).deleted).toBe(true)
  })

  it('registers welding wire by batch, audited as such', async () => {
    const res = await save('welding-wire', [
      row({ batchNumber: '22285', classification: 'E71T-1C', wireType: 'Flux-cored', diameter: 1.2, supplier: 'Shiqiao', weightKg: 50000, yield: 485, tensile: 515 }),
    ])
    expect(res.body).toEqual({ inserted: ['22285'], updated: [], skipped: [] })
    const { rows } = await app.db.query(`SELECT batch_number, classification, wire_type, diameter, weight_kg, yield, tensile FROM welding_wires`)
    expect(rows).toEqual([{ batch_number: '22285', classification: 'E71T-1C', wire_type: 'Flux-cored', diameter: 1.2, weight_kg: 50000, yield: 485, tensile: 515 }])
    const audit = await app.db.query(`SELECT action FROM audit_log WHERE entity = 'WeldingWire'`)
    expect(audit.rows).toEqual([{ action: 'create' }])
    // The same batch again, in another case: the same batch.
    expect((await save('welding-wire', [row({ batchNumber: '22285', tensile: 520 })])).body).toEqual({ inserted: [], updated: [], skipped: ['22285'] })
  })

  it('registers mesh wire by cast and diameter: another diameter of a cast is another wire', async () => {
    await app.db.query(`INSERT INTO mesh_wires (cast_number, diameter, product, tensile) VALUES ('62920', 3.900, 'Galvanized', 640)`)
    const res = await save('mesh-wire', [
      row({ castNumber: '62920', diameter: 3.9, product: 'Galvanized', grade: 'FE360B', supplier: 'TSG', tensile: 658, notes: 'MTC 240733' }, true),
      row({ castNumber: '62920', diameter: '4.80', product: 'Galvanized', grade: 'FE360B', supplier: 'TSG', tensile: 652, notes: 'MTC 240733' }),
    ])
    expect(res.body).toEqual({ inserted: ['62920 · Ø4.8 mm'], updated: ['62920 · Ø3.9 mm'], skipped: [] })
    const { rows } = await app.db.query(`SELECT cast_number, diameter, tensile FROM mesh_wires ORDER BY diameter`)
    expect(rows).toEqual([
      { cast_number: '62920', diameter: 3.9, tensile: 658 },
      { cast_number: '62920', diameter: 4.8, tensile: 652 },
    ])
    // A mesh wire with no diameter cannot be told apart: refused.
    expect((await save('mesh-wire', [row({ castNumber: '701688', tensile: 690 })])).status).toBe(400)
  })

  it('refuses the whole batch when a row is wrong: an item twice, no identifier, a bad measurement, too long', async () => {
    expect((await save('coils', [row({ coilNumber: 'A1' }), row({ coilNumber: 'a1' })])).status).toBe(400)
    expect((await save('mesh-wire', [row({ castNumber: 'M1', diameter: 4 }), row({ castNumber: 'M1', diameter: 4.0 })])).status).toBe(400)
    expect((await save('coils', [row({ coilNumber: '  ' })])).status).toBe(400)
    expect((await save('coils', [row({ coilNumber: 'A2', thickness: -1 })])).status).toBe(400)
    expect((await save('coils', [row({ coilNumber: 'A3', yield: 'abc' })])).status).toBe(400)
    expect((await save('coils', [row({ coilNumber: 'A4', grade: 'G'.repeat(61) })])).status).toBe(400)
    expect((await save('welding-wire', [row({ batchNumber: 'B1', classification: 42 })])).status).toBe(400)
    expect((await app.api('POST', '/api/mtc/pipes/save', { token: uploader.token, body: { fileName: 'x.pdf', rows: [row({})] } })).status).toBe(404)
    expect((await app.db.query(`SELECT count(*)::int AS n FROM coils`)).rows[0].n).toBe(0)
  })

  it('shows the review what is already registered, removed items included', async () => {
    await app.db.query(`INSERT INTO coils (coil_number, grade, deleted_at) VALUES ('E-1', 'S315MC', NULL), ('E-2', 'S355MC', now())`)
    const res = await app.api<MtcExistingResponse>('POST', '/api/mtc/coils/existing', { token: inspector.token, body: { ids: ['e-1', 'E-2', 'E-3', ''] } })
    expect(res.status).toBe(200)
    expect(res.body.map((c) => ({ values: c.values, deleted: !!c.deletedAt })).sort((a, b) => String(a.values.coilNumber).localeCompare(String(b.values.coilNumber)))).toEqual([
      { values: { coilNumber: 'E-1', grade: 'S315MC' }, deleted: false },
      { values: { coilNumber: 'E-2', grade: 'S355MC' }, deleted: true },
    ])
  })
})

describe('the registers’ tables', () => {
  beforeEach(async () => {
    await app.db.query(
      `INSERT INTO coils (coil_number, grade, sm_type, supplier, notes, created_at) VALUES
         ('B-200', 'S315MC', 'HR', 'Baosteel', 'MTC XQ1M023-01', now() - interval '3 days'),
         ('A-100', 'S450GD+Z275', 'GI', 'ArcelorMittal', 'MTC 20230055086-00', now() - interval '2 days'),
         ('C-300', 'S420MC', 'hr', 'ezz', NULL, now() - interval '1 day'),
         ('D-400', 'S420MC', 'HR', 'Ezz', NULL, now())`,
    )
    await app.db.query(`INSERT INTO coils (coil_number, deleted_at) VALUES ('Z-999', now())`)
    await app.db.query(`INSERT INTO welding_wires (batch_number, wire_type, supplier) VALUES ('22285', 'Flux-cored', 'Shiqiao'), ('31001', 'Solid', 'ESAB')`)
    await app.db.query(`INSERT INTO mesh_wires (cast_number, diameter, product, supplier) VALUES ('62920', 4.8, 'Galvanized', 'TSG'), ('62920', 3.9, 'Galvanized', 'TSG'), ('701688', 3, 'Bright', 'TSG')`)
  })

  it('are open to everyone signed in, a viewer too, a page at a time with the total', async () => {
    const first = await table('coils', '?limit=2', viewer)
    expect(first.total).toBe(4)
    expect(first.rows.map((c) => c.values.coilNumber)).toEqual(['A-100', 'B-200'])
    expect((await table('coils', '?limit=2&offset=2', viewer)).rows.map((c) => c.values.coilNumber)).toEqual(['C-300', 'D-400'])
    expect((await table('welding-wire', '', viewer)).rows.map((w) => w.values.batchNumber)).toEqual(['22285', '31001'])
    // By cast, then diameter.
    expect((await table('mesh-wire', '', viewer)).rows.map((w) => `${w.values.castNumber}/${w.values.diameter}`)).toEqual(['62920/3.9', '62920/4.8', '701688/3'])
    expect((await app.api('GET', '/api/mtc/pipes/table', { token: viewer.token })).status).toBe(404)
  })

  it('search the text fields, and filter and sort each column as History does, over the whole register', async () => {
    const cf = (f: object) => `cf=${encodeURIComponent(JSON.stringify(f))}`
    expect((await table('coils', '?search=23-01')).rows.map((c) => c.values.coilNumber)).toEqual(['B-200'])
    expect((await table('coils', '?search=gd%2Bz')).rows.map((c) => c.values.coilNumber)).toEqual(['A-100'])
    expect((await table('coils', '?search=%25')).total).toBe(0)
    expect((await table('coils', `?${cf({ supplier: { values: ['Ezz', 'ezz'] } })}`)).rows.map((c) => c.values.coilNumber)).toEqual(['C-300', 'D-400'])
    expect((await table('coils', `?${cf({ smType: { values: ['GI'] } })}`)).rows.map((c) => c.values.coilNumber)).toEqual(['A-100'])
    expect((await table('coils', `?${cf({ notes: { contains: 'xq1' } })}`)).rows.map((c) => c.values.coilNumber)).toEqual(['B-200'])
    // The newest first: sorted by when each was registered.
    expect((await table('coils', '?sort=createdAt:desc')).rows.map((c) => c.values.coilNumber)).toEqual(['D-400', 'C-300', 'A-100', 'B-200'])
    expect((await table('welding-wire', `?${cf({ wireType: { values: ['Solid'] } })}`)).rows.map((w) => w.values.batchNumber)).toEqual(['31001'])
    // A measurement filters by its text as the table shows it, and sorts by its value.
    expect((await table('mesh-wire', `?${cf({ diameter: { values: ['4.8'] } })}`)).rows.map((w) => w.values.castNumber)).toEqual(['62920'])
    expect((await table('mesh-wire', '?sort=diameter:desc')).rows.map((w) => w.values.diameter)).toEqual([4.8, 3.9, 3])
    expect((await app.api('GET', '/api/mtc/coils/table?sort=password:asc', { token: inspector.token })).status).toBe(400)
  })

  it('list a column’s values for its menu, under the other filters', async () => {
    const values = (kind: string, q: string) => app.api<{ values: { value: string; count: number }[] }>('GET', `/api/mtc/${kind}/values${q}`, { token: viewer.token })
    const suppliers = await values('coils', '?column=supplier')
    expect(suppliers.status).toBe(200)
    expect(suppliers.body.values).toEqual([
      { value: 'ArcelorMittal', count: 1 },
      { value: 'Baosteel', count: 1 },
      { value: 'Ezz', count: 1 },
      { value: 'ezz', count: 1 },
    ])
    const gi = await values('coils', `?column=supplier&cf=${encodeURIComponent(JSON.stringify({ smType: { values: ['GI'] } }))}`)
    expect(gi.body.values).toEqual([{ value: 'ArcelorMittal', count: 1 }])
    expect((await values('mesh-wire', '?column=diameter')).body.values.map((v) => v.value)).toEqual(['3', '3.9', '4.8'])
  })

  it('offer the registered suppliers and filter values for the review, once each whatever their case', async () => {
    const coils = (await app.api<MtcTableOptionsResponse>('GET', '/api/mtc/coils/options', { token: viewer.token })).body
    expect(coils.suppliers.map((s) => s.toLowerCase())).toEqual(['arcelormittal', 'baosteel', 'ezz'])
    expect(coils.filterValues.map((s) => s.toUpperCase())).toEqual(['GI', 'HR'])
    const weld = (await app.api<MtcTableOptionsResponse>('GET', '/api/mtc/welding-wire/options', { token: viewer.token })).body
    expect(weld).toEqual({ suppliers: ['ESAB', 'Shiqiao'], filterValues: ['Flux-cored', 'Solid'] })
  })
})
