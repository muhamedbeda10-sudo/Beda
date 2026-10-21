import { createHash } from 'node:crypto'
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import type Anthropic from '@anthropic-ai/sdk'
import type { ApiErrorBody } from '@qc/shared/api'
import type { AiMeResponse, AiMessagesResponse, AiQueryPart, AiSaveReportResponse, AiStreamEvent } from '@qc/shared/ai'
import type { AiExcelPart, AiExcelSpec } from '@qc/shared/aiExcel'
import { formatOf, removeExpiredExcelFiles, resultColumn, sheetNameOf } from '../src/ai/excel'
import { readAll } from '../src/ai/attachments'
import { TestApp, type Session } from './harness'
import { text } from './aiFake'
import { addMachines, ask, grant, setUp, type People } from './automationsKit'
import { resultJson, systemOf, toolNames, toolUse } from './noticesKit'

// Excel files the assistant makes (make_excel), for the people the owner
// allows: laid out at the person's word, each sheet's query run in full as
// their domains read, the file built and kept by the server for 30 days and
// shown as a card; the model never sees its rows. Every request is logged,
// made or refused, and every download. The model is the scripted stand-in.

const app = new TestApp()
let p: People

/** Machines with figures worked out from their code: a count, a decimal, a rate, a day and a time. */
const FIGURES = `SELECT machine_code, machine, length(machine) AS letters, length(machine) * 1.25 AS weight, 12.5 AS rate, DATE '2026-10-01' AS made_on, TIMESTAMP '2026-10-01 08:30' AS made_at FROM ai.machines ORDER BY machine_code`

const makeExcel = (input: unknown, id?: string) => toolUse('make_excel', input, id)
const excelEvents = (events: AiStreamEvent[]): AiExcelPart[] => events.filter((e): e is Extract<AiStreamEvent, { type: 'excel' }> => e.type === 'excel').map((e) => e.part)

/** A download as the browser gets it: its status, headers and bytes. */
async function download(as: Session, id: string) {
  const res = await fetch(`${app.baseUrl}/api/ai/excel-files/${id}/download`, { headers: { authorization: `Bearer ${as.token}` } })
  return { status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) }
}

const readBook = async (bytes: Buffer) => {
  const book = new ExcelJS.Workbook()
  await book.xlsx.load(bytes as unknown as ArrayBuffer)
  return book
}

/** The result the model was sent back for its last tool call. */
function lastResult(): Anthropic.Beta.BetaToolResultBlockParam {
  const messages = app.model.calls[app.model.calls.length - 1].params.messages
  const content = messages[messages.length - 1].content as Anthropic.Beta.BetaToolResultBlockParam[]
  return content[content.length - 1]
}

/** The model calls make_excel once (in a new conversation of the person's unless given). */
async function viaChat(as: Session, input: unknown, conversationId?: string) {
  app.model.reply({ content: [makeExcel(input)] }, { content: [text('The file is ready.')] })
  const res = await ask(app, as, 'Send me the machines in Excel', conversationId)
  expect(res.status, JSON.stringify(res.error)).toBe(200)
  return { cards: excelEvents(res.events), result: lastResult(), conversationId: res.conversationId }
}

interface LogRow {
  status: string
  userName: string
  userRole: string
  request: unknown
  problems: string | null
  sheetRows: number[] | null
  byteSize: number | null
  sha256: string | null
  storageKey: string | null
  expiresIn: number | null
}

const logOf = async (id: string): Promise<LogRow> =>
  (
    await app.db.query<LogRow>(
      `SELECT status, user_name AS "userName", user_role AS "userRole", request, problems, sheet_rows AS "sheetRows", byte_size AS "byteSize", sha256,
              storage_key AS "storageKey", round(extract(epoch FROM expires_at - created_at) / 86400)::int AS "expiresIn"
         FROM ai_excel_files WHERE id = $1`,
      [id],
    )
  ).rows[0]

const LAID_OUT = {
  fileName: 'Machines: October / 2026',
  sheets: [
    {
      name: '  The machines,   by code and by their figures  ',
      title: 'Machines in the register',
      notes: 'All active machines.',
      sql: FIGURES,
      columns: [
        { column: 'MACHINE', header: 'Machine' },
        { column: 'machine_code', header: 'Code', format: 'text' },
        { column: 'weight', header: 'Weight (kg)', decimals: 1 },
        { column: 'letters', header: 'Letters' },
        { column: 'rate', header: 'Rate', format: 'percent' },
        { column: 'made_on', header: 'Made on' },
        { column: 'made_at', header: 'Made at' },
      ],
      totals: { label: 'Total', sum: ['weight', 'letters'], average: ['rate'], count: ['machine_code'] },
      rightToLeft: false,
    },
    { name: 'آلات', sql: `SELECT machine_code AS "الكود" FROM ai.machines ORDER BY 1 DESC`, rightToLeft: true },
  ],
}

beforeAll(async () => {
  await app.start()
  p = await setUp(app)
})
afterAll(() => app.stop())
beforeEach(() => {
  app.model.reset()
  for (const s of Object.values(p)) {
    app.aiLimiter.reset(s.user.id)
    app.aiReportLimiter.reset(s.user.id)
  }
})

describe('who may have Excel files made', () => {
  it('is the owner, and the people the owner allows: only they get the tool and its part of the prompt', async () => {
    app.model.reply({ content: [text('Hi.')] })
    await ask(app, p.plain, 'Hello')
    expect(toolNames(app)).not.toContain('make_excel')
    expect(systemOf(app)).not.toContain('# Excel files')
    expect(systemOf(app)).toContain('alerts, regular reports or Excel files when you have no tool to set them up or make them')

    app.model.reply({ content: [text('Hi.')] })
    await ask(app, p.owner, 'Hello')
    // The owner reads every domain: planning's five tools come after it, then the saved tables' five.
    expect(toolNames(app).at(-11)).toBe('make_excel')

    const allowed = await grant(app, p.owner, p.plain, { excel: true })
    expect(allowed.excel).toBe(true)
    app.model.reply({ content: [text('Hi.')] })
    await ask(app, p.plain, 'Hello')
    expect(toolNames(app).at(-6)).toBe('make_excel')
    const system = systemOf(app)
    const section = system.slice(system.indexOf('# Excel files'), system.indexOf('\n#', system.indexOf('# Excel files') + 2))
    expect(section).toContain('you never see its rows')
    expect(section).toContain('Never assume a period for a file.')
    expect(section).toContain('a department or section can be a factory, a process, a production line or a machine: ask which')
    expect(section).toContain('A sheet holds at most 50,000 rows. With more, no file is made')
    expect(section).toContain('it can be downloaded for 30 days')

    // The owner's change is in the audit log, field by field.
    const audit = await app.db.query(`SELECT field, old_value AS "old", new_value AS "new" FROM audit_log WHERE entity = 'AiAccess' AND entity_id = $1 AND field = 'excel'`, [p.plain.user.id])
    expect(audit.rows).toEqual([{ field: 'excel', old: 'may not have made', new: 'may have made' }])
  })
})

describe('make_excel', () => {
  it('makes the file as laid out, shows it as a card, and downloads that very file, its rows unseen by the model', async () => {
    await grant(app, p.owner, p.plain, { excel: true })
    const { cards, result, conversationId } = await viaChat(p.plain, LAID_OUT)
    // What no file system takes is made a space; a sheet's name is one line, cut at Excel's 31 characters.
    expect(cards).toHaveLength(1)
    const card = cards[0]
    expect(card).toEqual({
      type: 'excel',
      fileId: expect.any(String),
      fileName: 'Machines October 2026',
      sheets: [
        { name: 'The machines, by code and by th', title: 'Machines in the register', columns: ['Machine', 'Code', 'Weight (kg)', 'Letters', 'Rate', 'Made on', 'Made at'], rows: 2 },
        { name: 'آلات', columns: ['الكود'], rows: 2 },
      ],
      byteSize: expect.any(Number),
      expiresAt: expect.any(String),
    })
    // The model learns the columns and how many rows, never a value.
    const sent = resultJson<{ made: boolean; fileName: string; sheets: { name: string; columns: string[]; rows: number }[]; note: string }>(result)
    expect(sent).toEqual({ made: true, fileName: 'Machines October 2026', sheets: card.sheets.map((s) => ({ name: s.name, columns: s.columns, rows: s.rows })), note: expect.stringContaining('never figures from it') })
    for (const value of ['31. Machine', '58', '13.75', '2026-10-01']) expect(String(result.content)).not.toContain(value)

    // Logged: who asked and as what, what the model sent, the rows by sheet, the bytes and their hash, kept 30 days.
    const log = await logOf(card.fileId)
    expect(log).toMatchObject({ status: 'made', userName: 'Paula Plain', userRole: 'supervisor', request: LAID_OUT, problems: null, sheetRows: [2, 2], byteSize: card.byteSize, expiresIn: 30 })
    const stored = await readAll(app.images, log.storageKey!)
    expect(createHash('sha256').update(stored!).digest('hex')).toBe(log.sha256)
    const spec = (await app.db.query<{ spec: AiExcelSpec }>(`SELECT spec FROM ai_excel_files WHERE id = $1`, [card.fileId])).rows[0].spec
    expect(spec.sheets[0].columns.map((c) => [c.column, c.format, c.decimals])).toEqual([
      ['machine', 'text', undefined],
      ['machine_code', 'text', undefined],
      ['weight', 'decimal', 1],
      ['letters', 'integer', undefined],
      ['rate', 'percent', 1],
      ['made_on', 'date', undefined],
      ['made_at', 'datetime', undefined],
    ])
    await expect(app.db.query(`UPDATE ai_excel_files SET file_name = 'Other' WHERE id = $1`, [card.fileId])).rejects.toThrow(/a log/)
    await expect(app.db.query(`DELETE FROM ai_excel_files WHERE id = $1`, [card.fileId])).rejects.toThrow()

    // The answer, read again, shows the card where the tool was called.
    const history = await app.api<AiMessagesResponse>('GET', `/api/ai/conversations/${conversationId}/messages`, { token: p.plain.token })
    expect(history.body.messages.find((m) => m.role === 'assistant')!.parts).toEqual([card, { type: 'text', text: 'The file is ready.' }])

    // The download is the file as it was made: a machine added since is not in it.
    await addMachines(app.db, ['77'])
    const got = await download(p.plain, card.fileId)
    expect(got.status).toBe(200)
    expect(got.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    expect(got.headers.get('content-disposition')).toBe(`attachment; filename="Machines October 2026.xlsx"; filename*=UTF-8''Machines%20October%202026.xlsx`)
    expect(got.headers.get('cache-control')).toBe('private, no-store')
    expect(got.bytes.equals(stored!)).toBe(true)
    const book = await readBook(got.bytes)
    const ws = book.worksheets[0]
    expect(ws.name).toBe('The machines, by code and by th')
    expect(ws.getCell('A1').value).toBe('Machines in the register')
    expect(ws.getRow(4).values).toEqual([undefined, 'Machine', 'Code', 'Weight (kg)', 'Letters', 'Rate', 'Made on', 'Made at'])
    expect(ws.getRow(5).values).toEqual([undefined, '31. Machine', '31', 13.75, 11, 0.125, new Date(Date.UTC(2026, 9, 1)), new Date(Date.UTC(2026, 9, 1, 8, 30))])
    expect(ws.getRow(7).values).toEqual([
      undefined,
      'Total',
      { formula: 'SUBTOTAL(103,B5:B6)', result: 2 },
      { formula: 'SUBTOTAL(109,C5:C6)', result: 27.5 },
      { formula: 'SUBTOTAL(109,D5:D6)', result: 22 },
      { formula: 'SUBTOTAL(101,E5:E6)', result: 0.125 },
    ])
    expect(book.worksheets[1].views[0]).toMatchObject({ rightToLeft: true })
    expect(book.worksheets[1].getColumn(1).values).toEqual([undefined, 'الكود', '58', '31'])
    const downloads = await app.db.query(`SELECT user_id AS "userId" FROM ai_excel_downloads WHERE file_id = $1`, [card.fileId])
    expect(downloads.rows).toEqual([{ userId: p.plain.user.id }])

    // Only its maker, while they may have files made, in a conversation they still have: someone else allowed files
    // finds no such file; someone not allowed, or without the assistant, is refused.
    expect((await download(p.creator, card.fileId)).status).toBe(403)
    await grant(app, p.owner, p.creator, { automations: true, excel: true })
    expect((await download(p.creator, card.fileId)).status).toBe(404)
    await grant(app, p.owner, p.creator, { automations: true, excel: false })
    expect((await download(p.admin2, card.fileId)).status).toBe(403)
    expect((await download(p.plain, '00000000-0000-4000-8000-000000000000')).status).toBe(404)
    expect((await download(p.plain, 'x')).status).toBe(400)
    await grant(app, p.owner, p.plain, { excel: false })
    expect((await download(p.plain, card.fileId)).status).toBe(403)
    await grant(app, p.owner, p.plain, { excel: true })
    expect((await download(p.plain, card.fileId)).status).toBe(200)
    expect((await app.api('DELETE', `/api/ai/conversations/${conversationId}`, { token: p.plain.token })).status).toBe(204)
    expect((await download(p.plain, card.fileId)).status).toBe(404)
    await app.db.query(`UPDATE machines SET deleted_at = now() WHERE code = '77'`)
  })

  it('tells the model every problem at once, never a value of the data, makes nothing, and logs the refusal', async () => {
    await grant(app, p.owner, p.plain, { excel: true })
    const files = async () => (await app.db.query(`SELECT 1 FROM ai_excel_files WHERE status = 'made'`)).rowCount
    const before = await files()
    const input = {
      fileName: ' / ',
      sheets: [
        {
          name: 'Machines',
          sql: FIGURES,
          columns: [{ column: 'nope' }, { column: 'machine', format: 'percent' }, { column: 'weight', format: 'money' }, { column: 'rate', decimals: 7 }, { column: 'made_on', format: 'integer' }],
        },
        { name: 'machines', sql: FIGURES, columns: [{ column: 'machine' }, { column: 'letters' }], totals: { sum: ['machine', 'nope'], count: ['letters'], average: ['letters'] } },
        { name: 'Orders', sql: 'SELECT * FROM ai.order_lines' },
        { name: ' [ ] ', sql: '   ' },
        { name: 'Empty totals', sql: FIGURES, columns: [{ column: 'machine' }], totals: {} },
      ],
    }
    const { cards, result } = await viaChat(p.plain, input)
    expect(cards).toEqual([])
    expect(result.is_error).toBe(true)
    const said = String(result.content)
    expect(said.split('\n')[0]).toBe('No file was made. Fix these and call make_excel again, or tell the person what stands in the way:')
    for (const problem of [
      'fileName: give the file a name.',
      'sheets[0] ("Machines").columns[0]: "nope" is not a column of the query\'s result (it returns "machine_code", "machine", "letters", "weight", "rate", "made_on", "made_at").',
      'sheets[0] ("Machines").columns[1] ("machine") is percent, but row 1 holds something that is not a number: use format text, or select a number.',
      'sheets[0] ("Machines").columns[2].format: one of text, integer, decimal, percent, date, datetime.',
      'sheets[0] ("Machines").columns[3].decimals: a whole number from 0 to 4.',
      'sheets[0] ("Machines").columns[4] ("made_on") is integer, but row 1 holds something that is not a number',
      // Two sheets may not share a name, whatever the case.
      'sheets[1] ("machines (2)").totals.sum: "machine" is text; only numbers are added up or averaged (count it instead).',
      'sheets[1] ("machines (2)").totals.sum: "nope" is not one of the sheet\'s columns.',
      'sheets[1] ("machines (2)").totals: "letters" is named twice; give each column one total.',
      'sheets[2] ("Orders").sql: the query failed: permission denied',
      'sheets[3].name: give the sheet a name.',
      'sheets[3].sql: one SELECT of at most',
      'sheets[4] ("Empty totals").totals: name the columns to add up, average or count, or leave totals out.',
    ]) {
      expect(said).toContain(problem)
    }
    for (const value of ['31. Machine', '2026-10-01']) expect(said).not.toContain(value)
    expect(await files()).toBe(before)
    // Logged as refused: what the model sent and what it was told.
    const refused = await app.db.query<{ request: unknown; problems: string; fileName: string | null }>(
      `SELECT request, problems, file_name AS "fileName" FROM ai_excel_files WHERE status = 'refused' AND tool_use_id = $1`,
      [result.tool_use_id],
    )
    expect(refused.rows[0]).toMatchObject({ request: input, fileName: null })
    expect(refused.rows[0].problems).toContain('fileName: give the file a name.')

    // Too many sheets, none, and a shape that is no file at all.
    expect(String((await viaChat(p.plain, { fileName: 'Many', sheets: Array.from({ length: 9 }, (_, i) => ({ name: `S${i}`, sql: 'SELECT 1 AS one' })) })).result.content)).toContain('sheets: 1 to 8 sheets.')
    expect(String((await viaChat(p.plain, { fileName: 'None', sheets: [] })).result.content)).toContain('sheets: 1 to 8 sheets.')
    expect((await viaChat(p.plain, { sheets: 'all' })).result.is_error).toBe(true)
    expect(await files()).toBe(before)
  })

  it('makes no file for a sheet of more than 50,000 rows, and says to narrow it', async () => {
    await grant(app, p.owner, p.plain, { excel: true })
    const { cards, result } = await viaChat(p.plain, { fileName: 'Big', sheets: [{ name: 'All', sql: 'SELECT g AS n FROM generate_series(1, 50001) g' }] })
    expect(cards).toEqual([])
    expect(String(result.content)).toContain('sheets[0] ("All"): the query returns more than 50,000 rows, the most a sheet holds, so no file was made. Tell the person, and ask how to narrow it')
    // 50,000 exactly is a file.
    const full = await viaChat(p.plain, { fileName: 'Full', sheets: [{ name: 'All', sql: 'SELECT g AS n FROM generate_series(1, 50000) g' }] })
    expect(full.cards[0].sheets[0].rows).toBe(50_000)
    // So is a sheet with nothing in it: its numbers are numbers by their type, and its total waits for rows.
    const none = await viaChat(p.plain, { fileName: 'None', sheets: [{ name: 'Nothing', sql: 'SELECT g AS n FROM generate_series(1, 0) g', totals: { sum: ['n'] } }] })
    expect(none.cards[0].sheets[0]).toMatchObject({ rows: 0, columns: ['n'] })
  })

  it('refuses a call once the owner takes the permission away, and logs it', async () => {
    await grant(app, p.owner, p.plain, { excel: true })
    const first = await viaChat(p.plain, { fileName: 'Machines', sheets: [{ name: 'Machines', sql: 'SELECT machine_code FROM ai.machines' }] })
    expect(first.cards).toHaveLength(1)
    await grant(app, p.owner, p.plain, { excel: false })
    // The conversation keeps the tool it began with; the call is refused all the same.
    const again = await viaChat(p.plain, { fileName: 'Machines', sheets: [{ name: 'Machines', sql: 'SELECT machine_code FROM ai.machines' }] }, first.conversationId)
    expect(again.cards).toEqual([])
    expect(String(again.result.content)).toContain("Not allowed: the assistant's owner has not given this person Excel files.")
    expect((await app.db.query(`SELECT status, user_role AS "role" FROM ai_excel_files WHERE tool_use_id = $1`, [again.result.tool_use_id])).rows).toEqual([{ status: 'refused', role: 'supervisor' }])
  })

  it('keeps a file 30 days: then it cannot be downloaded, its bytes go, and its log stays, with the tokens of its answer', async () => {
    await grant(app, p.owner, p.plain, { excel: true })
    const { cards, conversationId } = await viaChat(p.plain, { fileName: 'Machines', sheets: [{ name: 'Machines', sql: 'SELECT machine_code FROM ai.machines' }] })
    const id = cards[0].fileId
    expect((await download(p.plain, id)).status).toBe(200)
    const key = (await logOf(id)).storageKey!
    // Its time over (a log row changes only by its removal: the guard is lifted to move the clock).
    await app.db.query(`ALTER TABLE ai_excel_files DISABLE TRIGGER ai_excel_files_keep`)
    await app.db.query(`UPDATE ai_excel_files SET expires_at = now() - interval '1 minute' WHERE id = $1`, [id])
    await app.db.query(`ALTER TABLE ai_excel_files ENABLE TRIGGER ai_excel_files_keep`)
    const late = await download(p.plain, id)
    expect(late.status).toBe(410)
    expect(JSON.parse(late.bytes.toString()).error.message).toBe('This file is no longer kept (files are kept 30 days). Ask the assistant for it again.')
    const history = await app.api<AiMessagesResponse>('GET', `/api/ai/conversations/${conversationId}/messages`, { token: p.plain.token })
    expect(history.body.messages.find((m) => m.role === 'assistant')!.parts[0]).toMatchObject({ type: 'excel', fileId: id, expired: true })

    expect(await removeExpiredExcelFiles(app.db, app.images)).toBe(1)
    expect(await app.images.get(key)).toBeNull()
    expect(await removeExpiredExcelFiles(app.db, app.images)).toBe(0)
    await expect(app.db.query(`UPDATE ai_excel_files SET removed_at = now() WHERE id = $1`, [id])).rejects.toThrow(/a log/)

    const log = await app.db.query(`SELECT status, file_name AS "fileName", removed_at IS NOT NULL AS removed, input_tokens > 0 AS "tokens", downloads FROM ai_excel_log WHERE id = $1`, [id])
    expect(log.rows).toEqual([{ status: 'made', fileName: 'Machines', removed: true, tokens: true, downloads: 1 }])
    await expect(app.db.query(`DELETE FROM ai_excel_downloads`)).rejects.toThrow(/append-only/)
  })
})

describe('Excel of a query or a saved report', () => {
  it('is for the owner and the people allowed Excel files, as /ai/me tells the app', async () => {
    await grant(app, p.owner, p.plain, { excel: false })
    const me = async (as: Session) => (await app.api<AiMeResponse>('GET', '/api/ai/me', { token: as.token })).body
    expect(await me(p.plain)).toMatchObject({ granted: true, excel: false })
    expect(await me(p.owner)).toMatchObject({ excel: true })

    app.model.reply({ content: [toolUse('run_sql', { purpose: 'Machines', sql: 'SELECT machine_code FROM ai.machines' })] }, { content: [text('Two machines.')] })
    const asked = await ask(app, p.plain, 'Which machines?')
    const done = asked.events.find((e): e is Extract<AiStreamEvent, { type: 'done' }> => e.type === 'done')!
    const query = done.message.parts.find((x): x is AiQueryPart => x.type === 'query')!
    const saved = await app.api<AiSaveReportResponse>('POST', '/api/ai/reports', { token: p.plain.token, body: { turnId: done.message.turnId, adjustable: false } })
    expect(saved.status).toBe(201)
    const exports = async () => [
      (await app.api('GET', `/api/ai/queries/${query.queryId}/export`, { token: p.plain.token })).status,
      (await app.api('GET', `/api/ai/reports/${saved.body.report.id}/export`, { token: p.plain.token })).status,
    ]
    const refused = await app.api<ApiErrorBody>('GET', `/api/ai/queries/${query.queryId}/export`, { token: p.plain.token })
    expect(refused.body.error.message).toBe("The assistant's owner has not given you Excel files.")
    expect(await exports()).toEqual([403, 403])
    // The report itself still runs: only its Excel is held back.
    expect((await app.api('GET', `/api/ai/reports/${saved.body.report.id}/run`, { token: p.plain.token })).status).toBe(200)

    await grant(app, p.owner, p.plain, { excel: true })
    expect(await me(p.plain)).toMatchObject({ excel: true })
    expect(await exports()).toEqual([200, 200])
  })
})

describe('the rules a file is checked by', () => {
  it('finds a column as written, or in any case when nothing is named so; reads a format from the values', () => {
    expect(resultColumn(['a', 'B', 'b'], 'B')).toBe(1)
    expect(resultColumn(['a', 'B'], 'b')).toBe(1)
    expect(resultColumn(['A', 'a'], 'x')).toBe(-1)
    expect(resultColumn(['x', 'x'], 'x')).toBe(-1)
    expect(resultColumn(['X', 'x'], 'X')).toBe(0)
    expect(formatOf([1, 2, null])).toBe('integer')
    expect(formatOf([1, 2.5])).toBe('decimal')
    expect(formatOf(['2026-10-01', null, ''])).toBe('date')
    expect(formatOf(['2026-10-01', '2026-10-01 08:30:00+03'])).toBe('datetime')
    expect(formatOf(['58', 3])).toBe('text')
    expect(formatOf([null])).toBe('text')
    expect(formatOf([true])).toBe('text')
    // The query's own types decide first, with no rows too: a period with nothing in it still adds up its numbers.
    expect(formatOf([], 23)).toBe('integer')
    expect(formatOf([], 1700)).toBe('decimal')
    expect(formatOf([3, 4], 701)).toBe('integer')
    expect(formatOf([3.5, 4], 1700)).toBe('decimal')
    expect(formatOf([], 1082)).toBe('date')
    expect(formatOf([], 1184)).toBe('datetime')
    expect(formatOf([true], 16)).toBe('text')
    expect(formatOf(['2026-10-01'], 25)).toBe('date')
  })

  it('names a sheet as Excel takes it: no forbidden characters, 31 at most, no apostrophe at an end, unique, never History', () => {
    const taken = new Set<string>(['history'])
    expect(sheetNameOf('By machine / factory: A?', taken)).toBe('By machine factory A')
    expect(sheetNameOf("'Operator's shift'", taken)).toBe("Operator's shift")
    expect(sheetNameOf('a'.repeat(40), taken)).toBe('a'.repeat(31))
    expect(sheetNameOf('A'.repeat(40), taken)).toBe(`${'A'.repeat(27)} (2)`)
    expect(sheetNameOf('History', taken)).toBe('History (2)')
    expect(sheetNameOf(' [*] ', taken)).toBe('')
  })
})
