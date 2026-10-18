import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import { crc32 } from 'node:zlib'
import { AI_JOBS, type AiReport, type AiReportRunResponse } from '@qc/shared/ai'
import type { ApiErrorBody } from '@qc/shared/api'
import type { AutomationDelivery } from '@qc/shared/automation'
import {
  BUILTIN_REPORT_STYLE,
  REPORT_STYLE_MAX_PER_OWNER,
  type ReportForm,
  type ReportFormMapping,
  type ReportFormsResponse,
  type ReportFormSuggestResponse,
  type ReportStyle,
  type ReportStyleDefaultResponse,
  type ReportStyleDraftResponse,
  type ReportStyleSpec,
  type ReportStylesResponse,
  type ReportStyleVersionsResponse,
} from '@qc/shared/reportStyles'
import { TestApp, type Session } from './harness'
import { text } from './aiFake'
import { insertAutomation, setUp, type People } from './automationsKit'
import { insertReport } from '../src/ai/reports'

// Report styles and Excel forms: a style is choices the app draws, kept in
// versions, shared and made the company's default only by someone with the
// Configuration permission; the assistant proposes one from a sample or from
// words, checked like anything typed. A form is the company's own workbook
// kept with a saved report, filled from a run (or a delivery) with rows
// inserted or carried on to copies of the sheet. Excel of a report is drawn
// in its style.

const app = new TestApp()
let p: People
/** The owner (an administrator, so with the Configuration permission). */
let owner: Session
/** An inspector given the assistant (no Configuration permission). */
let inspector: Session

const PNG_1X1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

/** A zip of these parts, stored (not compressed): enough to be what an upload claims. */
function storedZip(parts: Record<string, string>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, content] of Object.entries(parts)) {
    const n = Buffer.from(name)
    const data = Buffer.from(content)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(n.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(n.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, n, data)
    centrals.push(central, n)
    offset += 30 + n.length + data.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(parts).length, 8)
  end.writeUInt16LE(Object.keys(parts).length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

const spec = (over: Partial<ReportStyleSpec> = {}): ReportStyleSpec => ({ ...BUILTIN_REPORT_STYLE, ...over })
const styles = (as: Session) => app.api<ReportStylesResponse & ApiErrorBody>('GET', '/api/report-styles', { token: as.token })
const create = (as: Session, body: object) => app.api<ReportStyle & ApiErrorBody>('POST', '/api/report-styles', { token: as.token, body })
const change = (as: Session, id: string, body: object) => app.api<ReportStyle & ApiErrorBody>('PUT', `/api/report-styles/${id}`, { token: as.token, body })

async function madeReport(as: Session, over: { shared?: boolean } = {}): Promise<AiReport> {
  return insertReport(app.db, {
    userId: as.user.id,
    conversationId: null,
    turnId: null,
    title: 'Machine register',
    question: 'Which machines are there?',
    period: null,
    adjustable: false,
    sections: [
      { title: 'Machines', sql: 'SELECT machine_code, machine FROM ai.machines ORDER BY machine_code' },
      { title: 'Count', sql: 'SELECT count(*)::int AS machines FROM ai.machines' },
    ],
    inputs: [],
    shared: over.shared ?? false,
    madeBy: 'assistant',
  })
}

/** A form as a quality system has it: a heading, a date cell, a table from row 6 with a total under it, a signature line. */
async function formWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('QF-07')
  ws.getCell('A1').value = 'Machine check sheet'
  ws.getCell('A1').font = { bold: true }
  ws.mergeCells('A1:C1')
  ws.getCell('A3').value = 'Date:'
  ws.getCell('A5').value = 'Code'
  ws.getCell('B5').value = 'Machine'
  ws.getCell('C5').value = 'Count'
  ws.getCell('A6').border = { bottom: { style: 'thin' } }
  ws.getCell('C6').value = 1
  ws.getCell('A7').value = 'Total'
  ws.getCell('C7').value = { formula: 'SUM(C6:C6)' }
  ws.getCell('A9').value = 'Signed:'
  ws.mergeCells('B9:C9')
  return Buffer.from(await wb.xlsx.writeBuffer())
}

async function upload(as: Session, reportId: string, bytes: Buffer, name = 'QF-07 Machine check.xlsx') {
  const form = new FormData()
  form.append('reportId', reportId)
  form.append('file', new Blob([new Uint8Array(bytes)]), name)
  const res = await fetch(`${app.baseUrl}/api/report-forms`, { method: 'POST', headers: { authorization: `Bearer ${as.token}` }, body: form })
  return { status: res.status, body: (await res.json()) as ReportForm & ApiErrorBody }
}

async function download(path: string, as: Session): Promise<{ status: number; type: string | null; disposition: string | null; bytes: Buffer }> {
  const res = await fetch(`${app.baseUrl}${path}`, { headers: { authorization: `Bearer ${as.token}` } })
  return { status: res.status, type: res.headers.get('content-type'), disposition: res.headers.get('content-disposition'), bytes: Buffer.from(await res.arrayBuffer()) }
}

const readBook = async (bytes: Buffer) => {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(bytes as unknown as ArrayBuffer)
  return wb
}

beforeAll(async () => {
  await app.start()
  p = await setUp(app)
  owner = p.owner
  inspector = p.creator
})
afterAll(() => app.stop())

describe('report styles', () => {
  it('are for people given the assistant: everyone else is refused', async () => {
    expect((await styles(p.viewer)).status).toBe(403)
    expect((await styles(p.admin2)).status).toBe(403)
    const none = await app.api<ReportStyleDefaultResponse>('GET', '/api/report-styles/default', { token: inspector.token })
    expect(none.status).toBe(200)
    expect(none.body.style.id).toBeNull()
  })

  it('are made, checked, versioned, and changed only by the one who made them', async () => {
    const bad = await create(inspector, { name: 'Bad', spec: spec({ colors: { ...BUILTIN_REPORT_STYLE.colors, primary: 'blue' } }), logoDataUrl: null })
    expect(bad.status).toBe(400)
    const fake = await create(inspector, { name: 'Fake logo', spec: spec(), logoDataUrl: 'data:image/png;base64,/9j/4AAQSkZJRg==' })
    expect(fake.status).toBe(400)

    const made = await create(inspector, {
      name: '  Quality   forms ',
      spec: spec({ colors: { ...BUILTIN_REPORT_STYLE.colors, primary: '#0a7b3e' }, docControl: { enabled: true, docNo: 'QF-07', revision: '02', issueDate: '2026-01-10' } }),
      logoDataUrl: PNG_1X1,
    })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    expect(made.body).toMatchObject({ name: 'Quality forms', version: 1, mine: true, shared: false, isDefault: false, logoDataUrl: PNG_1X1 })
    expect(made.body.spec.colors.primary).toBe('#0A7B3E')

    // The look changed and the revision left alone: the revision moves on, issued today.
    const changed = await change(inspector, made.body.id, { name: 'Quality forms', spec: { ...made.body.spec, table: { ...made.body.spec.table, borders: 'all' } }, logoDataUrl: PNG_1X1, version: 1 })
    expect(changed.status, JSON.stringify(changed.body)).toBe(200)
    expect(changed.body.version).toBe(2)
    expect(changed.body.spec.docControl.revision).toBe('03')
    expect(changed.body.spec.docControl.issueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(changed.body.spec.docControl.issueDate).not.toBe('2026-01-10')

    // The revision set by hand in the same save is kept as typed.
    const typed = await change(inspector, made.body.id, {
      name: 'Quality forms',
      spec: { ...changed.body.spec, numbering: false, docControl: { ...changed.body.spec.docControl, revision: '05' } },
      logoDataUrl: PNG_1X1,
      version: 2,
    })
    expect(typed.body.spec.docControl.revision).toBe('05')

    // A save from a stale page is refused.
    const stale = await change(inspector, made.body.id, { name: 'Again', spec: made.body.spec, logoDataUrl: null, version: 1 })
    expect(stale.status).toBe(409)
    // Someone else's is not theirs to see, nor to change.
    expect((await change(p.creator2, made.body.id, { name: 'Mine now', spec: made.body.spec, logoDataUrl: null, version: 3 })).status).toBe(404)

    const versions = await app.api<ReportStyleVersionsResponse>('GET', `/api/report-styles/${made.body.id}/versions`, { token: inspector.token })
    expect(versions.body.versions.map((v) => v.version)).toEqual([3, 2, 1])
    expect(versions.body.versions[2].spec.docControl.revision).toBe('02')

    const audit = await app.db.query<{ action: string; field: string | null }>(`SELECT action, field FROM audit_log WHERE entity = 'ReportStyle' AND entity_id = $1 ORDER BY at, id`, [made.body.id])
    expect(audit.rows[0].action).toBe('create')
    expect(audit.rows.map((r) => r.field)).toEqual(expect.arrayContaining(['table', 'docControl', 'numbering']))
  })

  it('are shared and made the default only with the Configuration permission; the default is always shared', async () => {
    const mine = await create(inspector, { name: 'Shared look', spec: spec({ font: 'Cambria' }), logoDataUrl: null })
    expect((await app.api('POST', `/api/report-styles/${mine.body.id}/share`, { token: inspector.token, body: { shared: true } })).status).toBe(403)
    expect((await styles(inspector)).body.canManage).toBe(false)

    // The owner cannot see it until it is shared: an administrator manages the shared ones.
    expect((await app.api('PUT', '/api/report-styles/default', { token: owner.token, body: { styleId: mine.body.id } })).status).toBe(404)
    const own = await create(owner, { name: 'Company', spec: spec({ orientation: 'landscape' }), logoDataUrl: null })
    const notShared = await app.api<ApiErrorBody>('PUT', '/api/report-styles/default', { token: owner.token, body: { styleId: own.body.id } })
    expect(notShared.status).toBe(400)
    expect((await app.api('POST', `/api/report-styles/${own.body.id}/share`, { token: owner.token, body: { shared: true } })).status).toBe(200)
    const chosen = await app.api<ReportStylesResponse>('PUT', '/api/report-styles/default', { token: owner.token, body: { styleId: own.body.id } })
    expect(chosen.status).toBe(200)
    expect(chosen.body.defaultId).toBe(own.body.id)

    // Everyone given the assistant sees it, as the default answers print in.
    const seen = await styles(inspector)
    expect(seen.body.defaultId).toBe(own.body.id)
    expect(seen.body.styles[0]).toMatchObject({ id: own.body.id, isDefault: true, mine: false, ownerName: 'Owner Admin' })
    const def = await app.api<ReportStyleDefaultResponse>('GET', '/api/report-styles/default', { token: inspector.token })
    expect(def.body.style).toMatchObject({ id: own.body.id, name: 'Company' })
    expect(def.body.style.spec.orientation).toBe('landscape')

    const unshare = await app.api<ApiErrorBody>('POST', `/api/report-styles/${own.body.id}/share`, { token: owner.token, body: { shared: false } })
    expect(unshare.status).toBe(409)

    // Removing the default leaves none: the built-in look.
    expect((await app.api('DELETE', `/api/report-styles/${own.body.id}`, { token: owner.token })).status).toBe(204)
    expect((await app.api<ReportStyleDefaultResponse>('GET', '/api/report-styles/default', { token: inspector.token })).body.style.id).toBeNull()
    await expect(app.db.query(`DELETE FROM report_styles WHERE id = $1`, [own.body.id])).rejects.toThrow()
  })

  it('are kept at most REPORT_STYLE_MAX_PER_OWNER a person', async () => {
    const have = (await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM report_styles WHERE owner_id = $1 AND deleted_at IS NULL`, [p.creator2.user.id])).rows[0].n
    for (let i = have; i < REPORT_STYLE_MAX_PER_OWNER; i++) expect((await create(p.creator2, { name: `Style ${i}`, spec: spec(), logoDataUrl: null })).status).toBe(201)
    const over = await create(p.creator2, { name: 'One too many', spec: spec(), logoDataUrl: null })
    expect(over.status).toBe(409)
  })

  it('are proposed by the assistant from a sample, each choice checked, its cost the person’s', async () => {
    app.aiLimiter.reset(inspector.user.id)
    app.model.reset()
    const proposed = {
      name: 'From the QF sample',
      spec: { ...spec(), colors: { ...spec().colors, primary: '#123ABC' }, font: 'Comic Sans' },
      logoBox: { x: 0.05, y: 0.02, w: 0.2, h: 1.4 },
      notes: 'Comic Sans is not available.',
    }
    app.model.reply({ content: [text(JSON.stringify(proposed))], usage: { input_tokens: 3000, output_tokens: 500 } })
    const res = await app.api<ReportStyleDraftResponse & ApiErrorBody>('POST', '/api/report-styles/draft', {
      token: inspector.token,
      body: { images: [PNG_1X1], instruction: 'Make it look like this' },
    })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    // The font it could not choose stays as it was; the rest of what it chose is kept.
    expect(res.body.spec.font).toBe(BUILTIN_REPORT_STYLE.font)
    expect(res.body.spec.colors.primary).toBe('#123ABC')
    expect(res.body.logoBox).toEqual({ x: 0.05, y: 0.02, w: 0.2, h: 1 })
    expect(res.body.notes).toContain('Comic Sans')
    const call = app.model.calls[0].params
    expect(call.model).toBe(AI_JOBS['report-style'].model)
    const content = call.messages[0].content as { type: string }[]
    expect(content[0].type).toBe('image')
    const usage = await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ai_usage WHERE user_id = $1 AND model = $2`, [inspector.user.id, AI_JOBS['report-style'].model])
    expect(usage.rows[0].n).toBe(1)

    // Nothing to read from: refused before any call.
    const empty = await app.api('POST', '/api/report-styles/draft', { token: inspector.token, body: {} })
    expect(empty.status).toBe(400)
    expect(app.model.calls).toHaveLength(1)
  })

  it('a report prints in the style its owner chose, else the default', async () => {
    const report = await madeReport(inspector)
    const style = await create(inspector, { name: 'For the register', spec: spec({ figures: 'boxed' }), logoDataUrl: null })
    const chosen = await app.api<AiReport>('PATCH', `/api/ai/reports/${report.id}/style`, { token: inspector.token, body: { styleId: style.body.id } })
    expect(chosen.status).toBe(200)
    expect(chosen.body.styleId).toBe(style.body.id)
    app.aiReportLimiter.reset(inspector.user.id)
    const run = await app.api<AiReportRunResponse>('GET', `/api/ai/reports/${report.id}/run`, { token: inspector.token })
    expect(run.body.style).toMatchObject({ id: style.body.id, name: 'For the register' })
    // Someone else's style is not one to choose.
    const theirs = await create(owner, { name: 'Private', spec: spec(), logoDataUrl: null })
    expect((await app.api('PATCH', `/api/ai/reports/${report.id}/style`, { token: inspector.token, body: { styleId: theirs.body.id } })).status).toBe(404)
    // Back to the default (none chosen: the built-in look).
    await app.api('PATCH', `/api/ai/reports/${report.id}/style`, { token: inspector.token, body: { styleId: null } })
    app.aiReportLimiter.reset(inspector.user.id)
    expect((await app.api<AiReportRunResponse>('GET', `/api/ai/reports/${report.id}/run`, { token: inspector.token })).body.style?.id).toBeNull()
  })
})

describe('Excel of a report, in its style', () => {
  it('is the report run in full, under the letterhead, its tables in the style’s colours', async () => {
    await app.api('PUT', `/api/ai/access/${inspector.user.id}`, { token: owner.token, body: { enabled: true, domains: ['inspection'], monthlyCapUsd: 50, automations: true, excel: true } })
    const report = await madeReport(inspector)
    const style = await create(inspector, {
      name: 'Green',
      spec: spec({
        colors: { ...BUILTIN_REPORT_STYLE.colors, tableHeaderBg: '#0A7B3E', tableHeaderText: '#FFFFFF' },
        docControl: { enabled: true, docNo: 'QF-09', revision: '01', issueDate: '2026-02-01' },
        approvals: { enabled: true, labels: ['Prepared by', 'Approved by'] },
        orientation: 'landscape',
      }),
      logoDataUrl: PNG_1X1,
    })
    await app.api('PATCH', `/api/ai/reports/${report.id}/style`, { token: inspector.token, body: { styleId: style.body.id } })
    app.aiReportLimiter.reset(inspector.user.id)
    const file = await download(`/api/ai/reports/${report.id}/workbook`, inspector)
    expect(file.status, file.bytes.toString()).toBe(200)
    expect(file.type).toContain('spreadsheetml')
    expect(file.disposition).toContain('QC-Report-Machine-register-')
    const wb = await readBook(file.bytes)
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Report', '1 Machines', '2 Count'])
    const cover = wb.getWorksheet('Report')!
    const values = cover.getSheetValues().flat().filter((v) => typeof v === 'string') as string[]
    expect(values).toEqual(expect.arrayContaining(['Doc. No.', 'QF-09', 'Prepared by', 'Approved by', 'Machine register']))
    expect(cover.getImages()).toHaveLength(1)
    expect(cover.pageSetup.orientation).toBe('landscape')
    const machines = wb.getWorksheet('1 Machines')!
    expect(machines.getRow(3).values).toEqual([undefined, 'machine_code', 'machine'])
    expect((machines.getCell(3, 1).fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FF0A7B3E')
    expect(machines.getCell(4, 1).value).toBe('31')
    expect(machines.getCell(5, 1).value).toBe('58')

    // Excel is for someone the owner allowed it.
    await app.api('PUT', `/api/ai/access/${inspector.user.id}`, { token: owner.token, body: { enabled: true, domains: ['inspection'], monthlyCapUsd: 50, automations: true, excel: false } })
    expect((await download(`/api/ai/reports/${report.id}/workbook`, inspector)).status).toBe(403)
    await app.api('PUT', `/api/ai/access/${inspector.user.id}`, { token: owner.token, body: { enabled: true, domains: ['inspection'], monthlyCapUsd: 50, automations: true, excel: true } })
  })
})

describe('Excel forms', () => {
  let report: AiReport
  let form: ReportForm
  const mapping = (over: Partial<ReportFormMapping> = {}): ReportFormMapping => ({
    sheet: 'QF-07',
    cells: [
      { ref: 'B3', value: { kind: 'field', field: 'ran.day' } },
      { ref: 'B9', value: { kind: 'field', field: 'printed.by' } },
    ],
    tables: [{ section: 0, startRow: 6, overflow: 'insert', columns: [{ col: 'A', column: 'machine_code' }, { col: 'B', column: 'machine' }] }],
    ...over,
  })

  beforeAll(async () => {
    report = await madeReport(inspector)
  })

  it('takes a workbook checked before it is opened, on one’s own report', async () => {
    const notXlsx = await upload(inspector, report.id, Buffer.from('just text'))
    expect(notXlsx.status).toBe(400)
    const macros = storedZip({ '[Content_Types].xml': '<Types/>', 'xl/workbook.xml': '<workbook/>', 'xl/vbaProject.bin': 'x' })
    const refused = await upload(inspector, report.id, macros, 'macros.xlsx')
    expect(refused.status).toBe(400)
    expect(refused.body.error.message).toContain('macros')
    // Only the report's owner adds forms to it.
    expect((await upload(p.creator2, report.id, await formWorkbook())).status).toBe(404)

    const added = await upload(inspector, report.id, await formWorkbook())
    expect(added.status, JSON.stringify(added.body)).toBe(201)
    form = added.body
    expect(form).toMatchObject({ name: 'QF-07 Machine check', fileName: 'QF-07 Machine check.xlsx', mapping: null, mine: true, version: 1 })
    expect(form.sheets[0].name).toBe('QF-07')
    expect(form.sheets[0].cells).toEqual(expect.arrayContaining([{ ref: 'A1', text: 'Machine check sheet', bold: true }, { ref: 'A5', text: 'Code' }]))
    expect(form.sheets[0].merges).toEqual(expect.arrayContaining(['A1:C1', 'B9:C9']))
    const listed = await app.api<ReportFormsResponse>('GET', `/api/report-forms?reportId=${report.id}`, { token: inspector.token })
    expect(listed.body.forms.map((f) => f.id)).toEqual([form.id])
  })

  it('keeps where each value goes once it reads against the form and the report', async () => {
    const wrong = await app.api<ApiErrorBody>('PUT', `/api/report-forms/${form.id}`, {
      token: inspector.token,
      body: { name: form.name, version: 1, mapping: mapping({ sheet: 'Nope', cells: [{ ref: 'B3', value: { kind: 'section', section: 5, column: 'x', aggregate: 'first' } }] }) },
    })
    expect(wrong.status).toBe(400)
    expect(wrong.body.error.message).toContain('no sheet named')
    const saved = await app.api<ReportForm & ApiErrorBody>('PUT', `/api/report-forms/${form.id}`, { token: inspector.token, body: { name: 'QF-07', version: 1, mapping: mapping() } })
    expect(saved.status, JSON.stringify(saved.body)).toBe(200)
    expect(saved.body).toMatchObject({ name: 'QF-07', version: 2 })
    form = saved.body
    expect((await app.api('PUT', `/api/report-forms/${form.id}`, { token: inspector.token, body: { name: 'QF-07', version: 1, mapping: mapping() } })).status).toBe(409)
  })

  it('is filled from the report run in full: rows inserted, what sits below moved down with its formula', async () => {
    app.aiReportLimiter.reset(inspector.user.id)
    const file = await download(`/api/ai/reports/${report.id}/forms/${form.id}/fill`, inspector)
    expect(file.status, file.bytes.toString()).toBe(200)
    expect(file.disposition).toContain('QF-07')
    const ws = (await readBook(file.bytes)).getWorksheet('QF-07')!
    expect(ws.getCell('A6').value).toBe('31')
    expect(ws.getCell('B7').value).toBe('58. Machine')
    // The total moved down a row and sums the rows inserted.
    expect(ws.getCell('A8').value).toBe('Total')
    expect((ws.getCell('C8').value as ExcelJS.CellFormulaValue).formula).toBe('SUM(C6:C7)')
    // A cell under the table moved with it, and its merge too.
    expect(ws.getCell('B10').value).toBe('Cara Creator')
    expect(ws.model.merges).toEqual(expect.arrayContaining(['B10:C10']))
    expect(String(ws.getCell('B3').value)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('carries rows past a fixed table on to copies of the sheet', async () => {
    const paged = await app.api<ReportForm & ApiErrorBody>('PUT', `/api/report-forms/${form.id}`, {
      token: inspector.token,
      body: { name: 'QF-07', version: form.version, mapping: mapping({ tables: [{ section: 0, startRow: 6, lastRow: 6, overflow: 'next-sheet', columns: [{ col: 'A', column: 'machine_code' }] }] }) },
    })
    expect(paged.status, JSON.stringify(paged.body)).toBe(200)
    form = paged.body
    app.aiReportLimiter.reset(inspector.user.id)
    const wb = await readBook((await download(`/api/ai/reports/${report.id}/forms/${form.id}/fill`, inspector)).bytes)
    expect(wb.worksheets.map((w) => w.name)).toEqual(['QF-07', 'QF-07 (2)'])
    expect(wb.getWorksheet('QF-07')!.getCell('A6').value).toBe('31')
    expect(wb.getWorksheet('QF-07 (2)')!.getCell('A6').value).toBe('58')
    expect(wb.getWorksheet('QF-07 (2)')!.getCell('B9').value).toBe('Cara Creator')
  })

  it('is matched by the assistant to the columns the report showed, what does not fit left out', async () => {
    app.aiLimiter.reset(inspector.user.id)
    app.model.reset()
    app.model.reply({
      content: [
        text(
          JSON.stringify({
            mapping: {
              sheet: 'QF-07',
              cells: [
                { ref: 'b3', kind: 'field', field: 'ran.day', input: null, section: null, column: null, aggregate: null, text: null },
                { ref: 'C7', kind: 'section', field: null, input: null, section: 1, column: 'machines', aggregate: 'first', text: null },
                { ref: 'D1', kind: 'section', field: null, input: null, section: 0, column: 'not a column', aggregate: 'first', text: null },
              ],
              tables: [{ section: 0, startRow: 6, lastRow: null, overflow: 'insert', columns: [{ col: 'A', column: 'machine_code' }, { col: 'B', column: 'machine' }] }],
            },
            notes: 'Matched the table and the date.',
          }),
        ),
      ],
    })
    const res = await app.api<ReportFormSuggestResponse & ApiErrorBody>('POST', `/api/report-forms/${form.id}/suggest`, {
      token: inspector.token,
      body: { columns: [['machine_code', 'machine'], ['machines']] },
    })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.mapping.cells.map((c) => c.ref)).toEqual(['B3', 'C7'])
    expect(res.body.mapping.tables).toHaveLength(1)
    expect(res.body.notes).toContain('left out')
    expect(app.model.calls[0].params.model).toBe(AI_JOBS['report-form'].model)
    // Someone who may open the report but not change it may not ask.
    expect((await app.api('POST', `/api/report-forms/${form.id}/suggest`, { token: p.creator2.token, body: { columns: [[], []] } })).status).toBe(404)
  })

  it('is filled from a delivery of its report, as it was delivered; recipients only', async () => {
    const automationId = await insertAutomation(app.db, { creatorId: inspector.user.id, kind: 'report', recipients: [{ kind: 'user', userId: p.plain.user.id }] })
    const run = await app.db.query<{ id: string }>(
      `INSERT INTO ai_automation_runs (automation_id, trigger, started_at, finished_at, ok) VALUES ($1, 'schedule', now(), now(), true) RETURNING id`,
      [automationId],
    )
    const sections = [
      { title: 'Machines', ok: true, columns: ['machine_code', 'machine'], rows: [['7', 'Seven'], ['8', 'Eight'], ['9', 'Nine']], rowCount: 3, truncated: false },
      { title: 'Count', ok: true, columns: ['machines'], rows: [[3]], rowCount: 1, truncated: false },
    ]
    const delivered = await app.db.query<{ id: string }>(
      `INSERT INTO ai_report_deliveries (automation_id, run_id, automation_name, language, ran_at, period, sections, report_id)
       VALUES ($1, $2, 'Morning register', 'en', now(), NULL, $3::json, $4) RETURNING id`,
      [automationId, run.rows[0].id, JSON.stringify(sections), report.id],
    )
    const id = delivered.rows[0].id
    await app.db.query(`INSERT INTO ai_report_delivery_recipients (delivery_id, user_id) VALUES ($1, $2)`, [id, p.plain.user.id])
    const d = await app.api<AutomationDelivery>('GET', `/api/automations/deliveries/${id}`, { token: p.plain.token })
    expect(d.status).toBe(200)
    expect(d.body.forms).toEqual([{ id: form.id, name: 'QF-07' }])
    expect(d.body.style).toBeUndefined()

    const filled = await download(`/api/automations/deliveries/${id}/forms/${form.id}`, p.plain)
    expect(filled.status, filled.bytes.toString()).toBe(200)
    const wb = await readBook(filled.bytes)
    expect(wb.worksheets.map((w) => w.name)).toEqual(['QF-07', 'QF-07 (2)', 'QF-07 (3)'])
    expect(wb.getWorksheet('QF-07 (3)')!.getCell('A6').value).toBe('9')

    const book = await download(`/api/automations/deliveries/${id}/workbook`, p.plain)
    expect(book.status).toBe(200)
    const sheets = (await readBook(book.bytes)).worksheets.map((w) => w.name)
    expect(sheets).toEqual(['Report', '1 Machines', '2 Count'])

    expect((await download(`/api/automations/deliveries/${id}/workbook`, p.creator2)).status).toBe(404)
    expect((await download(`/api/automations/deliveries/${id}/forms/${form.id}`, p.creator2)).status).toBe(404)
  })

  it('is removed by the report’s owner only, the record kept', async () => {
    expect((await app.api('DELETE', `/api/report-forms/${form.id}`, { token: p.creator2.token })).status).toBe(404)
    expect((await app.api('DELETE', `/api/report-forms/${form.id}`, { token: inspector.token })).status).toBe(204)
    const kept = await app.db.query<{ deleted: boolean }>(`SELECT deleted_at IS NOT NULL AS deleted FROM report_forms WHERE id = $1`, [form.id])
    expect(kept.rows[0].deleted).toBe(true)
  })
})
