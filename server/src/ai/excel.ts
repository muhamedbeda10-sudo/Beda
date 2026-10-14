// ============================================================================
// §20 — Excel files the assistant makes (shared/aiExcel.ts): one tool of a
// new conversation of a person the owner allows (ai_access.excel; the owner
// always may), make_excel, loaded through the tool search when a question
// needs it; the file the server makes from it; its download; and the log of
// every request. A file holds only data the person may read.
//
// make_excel takes the file as the model lays it out at the person's word:
// its name, and per sheet a read-only query over the ai.* views with its
// columns (order, headings, formats), a totals row, a title, notes, and
// whether it reads right to left. Each query runs in full, as run_sql runs
// it, as the person's domains are now: a column the sheet names must be in
// the result, and a number, a percentage or a date must be one in every row.
// A sheet of more than AI_EXCEL_MAX_ROWS rows makes no file, and the model is
// told to ask the person to narrow it. Anything wrong is told to the model,
// every problem at once, and never a value of the data: the model never reads
// the file's rows, only each sheet's columns and how many rows it holds. A
// file that passes is built (./excelBook), kept for AI_EXCEL_KEEP_DAYS days
// and shown as a card; its link downloads that very file.
//
// Every request — made, refused or failed — is logged with what the model
// sent, and every download (migration 0048).
// ============================================================================

import { createHash, randomUUID } from 'node:crypto'
import type Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { parseChartDate, type AiCell, type AiStreamEvent } from '@qc/shared/ai'
import {
  AI_EXCEL_FORMATS,
  AI_EXCEL_KEEP_DAYS,
  AI_EXCEL_MAX_COLUMNS,
  AI_EXCEL_MAX_DECIMALS,
  AI_EXCEL_MAX_ROWS,
  AI_EXCEL_MAX_SHEETS,
  type AiExcelColumn,
  type AiExcelFormat,
  type AiExcelPart,
  type AiExcelSheet,
  type AiExcelSpec,
  type AiExcelTotal,
} from '@qc/shared/aiExcel'
import type { Config } from '../config'
import type { Db, Queryable } from '../db/pool'
import type { ImageStorage } from '../images/storage'
import { notFound } from '../lib/errors'
import type { RateLimiter } from '../lib/rateLimit'
import { describeIssues } from '../automations/draft'
import { isGranted, loadAccess, mayMakeExcel } from './access'
import { HANDED_OVER, type Readers, type ToolHandler, type ToolOutcome } from './assistant'
import { buildWorkbook, type BookSheet } from './excelBook'
import { currentAiOwner } from './owner'
import { factoryClock } from './prompt'
import { AI_EXPORT_LIMITS, AI_MAX_SQL_CHARS, AI_QUERY_TIMEOUT_MS, exportRows, runReadOnlyQuery, type QueryRun } from './runQuery'

type ToolUse = Anthropic.Beta.BetaToolUseBlock

export const MAKE_EXCEL_TOOL_NAME = 'make_excel'
export const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/** How long a sheet's query may run: an export's time. */
const SHEET_QUERY_TIMEOUT_MS = AI_QUERY_TIMEOUT_MS
const DAY_MS = 86_400_000
/** A file's name and a sheet's title, notes and totals label, at most; a sheet's name is cut at Excel's 31. */
const MAX_FILE_NAME = 80
const MAX_TITLE = 120
const MAX_NOTES = 300
const MAX_LABEL = 40
const MAX_SHEET_NAME = 31
const ROWS = AI_EXCEL_MAX_ROWS.toLocaleString('en-US')

export const MAKE_EXCEL_TOOL: Anthropic.Beta.BetaTool = {
  name: MAKE_EXCEL_TOOL_NAME,
  description:
    "Make an Excel file of the factory's data, laid out as the person asks: one or more sheets, each from its own read-only SQL query over the ai.* views (as run_sql takes it), with the columns in the order, under the headings and in the formats asked for, an optional totals row, a title and a line of notes. " +
    `The server runs each query in full, builds the file and shows it to the person as a card with Download (kept ${AI_EXCEL_KEEP_DAYS} days). You never see its rows: the result says each sheet's columns and how many rows it holds. A sheet holds at most ${ROWS} rows; with more, no file is made. ` +
    'Returns what each sheet holds, or every problem to fix before calling again.',
  eager_input_streaming: true,
  input_schema: {
    type: 'object',
    properties: {
      fileName: { type: 'string', description: `The file's name, without .xlsx, in the person's language (at most ${MAX_FILE_NAME} characters).` },
      sheets: {
        type: 'array',
        description: `1 to ${AI_EXCEL_MAX_SHEETS} sheets, in order.`,
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: `The sheet's tab (at most ${MAX_SHEET_NAME} characters).` },
            title: { type: 'string', description: "Optional. A title written above the table, in the person's language." },
            notes: { type: 'string', description: 'Optional. A line under the title: the period, the filters, what the figures are.' },
            sql: { type: 'string', description: 'One read-only SELECT over the ai.* views, as run_sql takes it, returning every row the sheet should hold, in the order wanted.' },
            columns: {
              type: 'array',
              description: `Optional. The sheet's columns in order (at most ${AI_EXCEL_MAX_COLUMNS}). Left out: every column of the result, under its own name.`,
              items: {
                type: 'object',
                properties: {
                  column: { type: 'string', description: "The query's column, exactly as the query names it." },
                  header: { type: 'string', description: "Its heading in the sheet, in the person's language. Left out: the column's own name." },
                  format: {
                    type: 'string',
                    enum: [...AI_EXCEL_FORMATS],
                    description:
                      'text (also a code, or a number that names something: an order or a session number); integer (whole numbers, with thousands); decimal; percent (the query returns 0-100: 2.5 for 2.5%); date (a day); datetime (a day and time). Left out: read from the values.',
                  },
                  decimals: { type: 'integer', description: `For decimal and percent: 0 to ${AI_EXCEL_MAX_DECIMALS} (default 2 for decimal, 1 for percent).` },
                },
                required: ['column'],
                additionalProperties: false,
              },
            },
            totals: {
              type: 'object',
              description: 'Optional. A totals row under the data, worked out by Excel (so it follows a filter).',
              properties: {
                label: { type: 'string', description: "Its label, in the first column without a total (default \"Total\"), in the person's language." },
                sum: { type: 'array', items: { type: 'string' }, description: "Columns to add up (the query's names): counts, quantities, amounts." },
                average: { type: 'array', items: { type: 'string' }, description: 'Columns to average: rates, lengths.' },
                count: { type: 'array', items: { type: 'string' }, description: 'Columns whose values to count.' },
              },
              additionalProperties: false,
            },
            rightToLeft: { type: 'boolean', description: 'The sheet reads right to left: an Arabic sheet.' },
          },
          required: ['name', 'sql'],
          additionalProperties: false,
        },
      },
    },
    required: ['fileName', 'sheets'],
    additionalProperties: false,
  },
}

export const EXCEL_TOOLS: readonly Anthropic.Beta.BetaTool[] = [MAKE_EXCEL_TOOL]

const ColumnInput = z.object({ column: z.string(), header: z.string().nullish(), format: z.string().nullish(), decimals: z.number().nullish() }).passthrough()
const SheetInput = z
  .object({
    name: z.string(),
    title: z.string().nullish(),
    notes: z.string().nullish(),
    sql: z.string(),
    columns: z.array(ColumnInput).nullish(),
    totals: z
      .object({ label: z.string().nullish(), sum: z.array(z.string()).nullish(), average: z.array(z.string()).nullish(), count: z.array(z.string()).nullish() })
      .passthrough()
      .nullish(),
    rightToLeft: z.boolean().nullish(),
  })
  .passthrough()
const Input = z.object({ fileName: z.string(), sheets: z.array(SheetInput) }).passthrough()

const oneLine = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()

/**
 * A column of a result by the name given: as written, or, when nothing is
 * named so, in any case (PostgreSQL folds an unquoted alias to lower case).
 * -1 when it is no column of the result, or names two.
 */
export function resultColumn(columns: readonly string[], name: string): number {
  const at = (same: (c: string) => boolean) => columns.flatMap((c, i) => (same(c) ? [i] : []))
  let found = at((c) => c === name)
  if (found.length === 0) found = at((c) => c.toLowerCase() === name.toLowerCase())
  return found.length === 1 ? found[0] : -1
}

/** PostgreSQL's types, by OID, that say how a column is written whatever its values (or with none). */
const PG_FORMATS = new Map<number, AiExcelFormat | 'number'>([
  [20, 'integer'], // int8
  [21, 'integer'], // int2
  [23, 'integer'], // int4
  [700, 'number'], // float4
  [701, 'number'], // float8
  [1700, 'number'], // numeric
  [1082, 'date'],
  [1114, 'datetime'], // timestamp
  [1184, 'datetime'], // timestamptz
  [16, 'text'], // boolean: yes or no
])

/**
 * How a column is written, when the sheet does not say: by its type in the
 * query (`type`, PostgreSQL's OID) — whole numbers, numbers (whole when every
 * value is), days, times — and otherwise by its values: numbers, days, times,
 * or text. A column of text that holds only days is written as days.
 */
export function formatOf(values: readonly AiCell[], type?: number): AiExcelFormat {
  const known = values.filter((v) => v !== null && v !== '')
  const typed = type === undefined ? undefined : PG_FORMATS.get(type)
  if (typed === 'number') return known.every((v) => typeof v === 'number' && Number.isInteger(v)) && known.length > 0 ? 'integer' : 'decimal'
  if (typed) return typed
  if (known.length === 0) return 'text'
  if (known.every((v) => typeof v === 'number')) return known.every((v) => Number.isInteger(v)) ? 'integer' : 'decimal'
  const dates = known.map(parseChartDate)
  if (dates.every((d) => d !== null)) return dates.every((d) => d!.dateOnly) ? 'date' : 'datetime'
  return 'text'
}

/** What a format asks of a column's values, against every row: null when they hold. Never a value: only where. */
function formatProblem(format: AiExcelFormat, values: readonly AiCell[]): string | null {
  const known = (v: AiCell) => v !== null && v !== ''
  if (format === 'integer' || format === 'decimal' || format === 'percent') {
    const at = values.findIndex((v) => known(v) && typeof v !== 'number')
    return at < 0 ? null : `row ${at + 1} holds something that is not a number: use format text, or select a number`
  }
  if (format === 'date' || format === 'datetime') {
    const at = values.findIndex((v) => known(v) && !parseChartDate(v))
    return at < 0 ? null : `row ${at + 1} holds something that is not a day or a time: select it as a date or a timestamp, or use format text`
  }
  return null
}

/** A file name a browser keeps: what no file system takes made spaces. */
const fileNameOf = (raw: string) => oneLine(raw.replace(/[\\/:*?"<>|]/g, ' ')).slice(0, MAX_FILE_NAME).trim()

/**
 * A sheet's name as Excel takes it: no : \ / ? * [ ], at most 31 characters,
 * no apostrophe at either end, and unique in the file whatever the case
 * ("History" is Excel's own). '' when nothing is left of it.
 */
export function sheetNameOf(raw: string, taken: Set<string>): string {
  const base = oneLine(raw.replace(/[:\\/?*[\]]/g, ' '))
    .slice(0, MAX_SHEET_NAME)
    .replace(/^['\s]+|['\s]+$/g, '')
  if (base === '') return ''
  let name = base
  for (let n = 2; taken.has(name.toLowerCase()); n++) {
    const suffix = ` (${n})`
    name = base.slice(0, MAX_SHEET_NAME - suffix.length).trimEnd() + suffix
  }
  taken.add(name.toLowerCase())
  return name
}

export interface ExcelCheck {
  spec: AiExcelSpec
  /** Each sheet with its rows, in the order of its columns. */
  sheets: BookSheet[]
  card: AiExcelPart['sheets']
}

/**
 * The file as the model laid it out, checked: its shape, then each sheet's
 * query run in full (as the person's domains read), its rows against the
 * limit, its columns and formats against every row, its totals against its
 * columns. Every problem, or the file as it will be made.
 */
export async function checkExcel(input: unknown, run: (sql: string) => Promise<QueryRun>): Promise<{ errors: string[] } | ExcelCheck> {
  const parsed = Input.safeParse(input)
  if (!parsed.success) return { errors: describeIssues(parsed.error) }
  const i = parsed.data
  const errors: string[] = []
  const fileName = fileNameOf(i.fileName)
  if (fileName === '') errors.push('fileName: give the file a name.')
  if (i.sheets.length === 0 || i.sheets.length > AI_EXCEL_MAX_SHEETS) errors.push(`sheets: 1 to ${AI_EXCEL_MAX_SHEETS} sheets.`)
  const taken = new Set<string>(['history'])
  const sheets: BookSheet[] = []
  const card: AiExcelPart['sheets'] = []
  for (const [k, s] of i.sheets.slice(0, AI_EXCEL_MAX_SHEETS).entries()) {
    const name = sheetNameOf(s.name, taken)
    const where = `sheets[${k}]${name ? ` ("${name}")` : ''}`
    const problems: string[] = []
    if (name === '') problems.push(`${where}.name: give the sheet a name.`)
    const title = oneLine(s.title).slice(0, MAX_TITLE)
    const notes = oneLine(s.notes).slice(0, MAX_NOTES)
    if (s.sql.trim() === '' || s.sql.length > AI_MAX_SQL_CHARS) problems.push(`${where}.sql: one SELECT of at most ${AI_MAX_SQL_CHARS} characters.`)
    if (problems.length > 0) {
      errors.push(...problems)
      continue
    }
    const result = await run(s.sql)
    if (!result.ok) {
      errors.push(`${where}.sql: the query failed: ${result.error}`)
      continue
    }
    if (result.truncated) {
      errors.push(
        result.rows.length >= AI_EXCEL_MAX_ROWS
          ? `${where}: the query returns more than ${ROWS} rows, the most a sheet holds, so no file was made. Tell the person, and ask how to narrow it (a shorter period, fewer machines, or a summary instead of every row).`
          : `${where}: the rows are too large for one file, so no file was made. Ask the person to narrow it, or select fewer or shorter columns.`,
      )
      continue
    }
    const rows = exportRows(result)
    const valuesOf = (index: number) => rows.map((r) => r[index] ?? null)
    // The sheet's columns: as listed, or every column of the result under its own name.
    const listed = s.columns && s.columns.length > 0 ? s.columns : result.columns.map((c) => ({ column: c, header: null, format: null, decimals: null }))
    if (listed.length > AI_EXCEL_MAX_COLUMNS) {
      errors.push(`${where}.columns: at most ${AI_EXCEL_MAX_COLUMNS}; the sheet has ${listed.length}${s.columns ? '' : ' (every column of the result): list the ones wanted'}.`)
      continue
    }
    const columns: AiExcelColumn[] = []
    const at: number[] = []
    for (const [c, col] of listed.entries()) {
      const index = resultColumn(result.columns, col.column.trim())
      if (index < 0) {
        problems.push(`${where}.columns[${c}]: "${col.column}" is not a column of the query's result (it returns ${result.columns.map((x) => `"${x}"`).join(', ')}).`)
        continue
      }
      const rawFormat = col.format?.trim().toLowerCase()
      if (rawFormat && !(AI_EXCEL_FORMATS as readonly string[]).includes(rawFormat)) {
        problems.push(`${where}.columns[${c}].format: one of ${AI_EXCEL_FORMATS.join(', ')}.`)
        continue
      }
      const format = (rawFormat as AiExcelFormat | undefined) ?? formatOf(valuesOf(index), result.types?.[index])
      const wrong = formatProblem(format, valuesOf(index))
      if (wrong) {
        problems.push(`${where}.columns[${c}] ("${result.columns[index]}") is ${format}, but ${wrong}.`)
        continue
      }
      const column: AiExcelColumn = { column: result.columns[index], header: oneLine(col.header).slice(0, MAX_TITLE) || result.columns[index], format }
      if (format === 'decimal' || format === 'percent') {
        const decimals = col.decimals ?? (format === 'decimal' ? 2 : 1)
        if (!Number.isInteger(decimals) || decimals < 0 || decimals > AI_EXCEL_MAX_DECIMALS) {
          problems.push(`${where}.columns[${c}].decimals: a whole number from 0 to ${AI_EXCEL_MAX_DECIMALS}.`)
          continue
        }
        column.decimals = decimals
      }
      columns.push(column)
      at.push(index)
    }
    // The totals row: what each named column works out, a sum or an average only of numbers.
    let totals: AiExcelSheet['totals']
    if (s.totals) {
      const asked: { column: string; total: AiExcelTotal }[] = [
        ...(s.totals.sum ?? []).map((column) => ({ column, total: 'sum' as const })),
        ...(s.totals.average ?? []).map((column) => ({ column, total: 'average' as const })),
        ...(s.totals.count ?? []).map((column) => ({ column, total: 'count' as const })),
      ]
      const kept: { column: string; total: AiExcelTotal }[] = []
      for (const t of asked) {
        const col = columns.find((c) => c.column === t.column.trim()) ?? columns.find((c) => c.column.toLowerCase() === t.column.trim().toLowerCase())
        if (!col) {
          problems.push(`${where}.totals.${t.total}: "${t.column}" is not one of the sheet's columns.`)
          continue
        }
        if (t.total !== 'count' && !(col.format === 'integer' || col.format === 'decimal' || col.format === 'percent')) {
          problems.push(`${where}.totals.${t.total}: "${col.column}" is ${col.format}; only numbers are added up or averaged (count it instead).`)
          continue
        }
        if (kept.some((x) => x.column === col.column)) {
          problems.push(`${where}.totals: "${col.column}" is named twice; give each column one total.`)
          continue
        }
        kept.push({ column: col.column, total: t.total })
      }
      if (asked.length === 0) problems.push(`${where}.totals: name the columns to add up, average or count, or leave totals out.`)
      totals = { label: oneLine(s.totals.label).slice(0, MAX_LABEL) || 'Total', columns: kept }
    }
    if (problems.length > 0) {
      errors.push(...problems)
      continue
    }
    const sheet: AiExcelSheet = { name, sql: s.sql, columns, rightToLeft: s.rightToLeft ?? false }
    if (title) sheet.title = title
    if (notes) sheet.notes = notes
    if (totals) sheet.totals = totals
    sheets.push({ sheet, rows: rows.map((r) => at.map((x) => r[x] ?? null)) })
    const shown: AiExcelPart['sheets'][number] = { name, columns: columns.map((c) => c.header), rows: rows.length }
    if (title) shown.title = title
    card.push(shown)
  }
  if (errors.length > 0) return { errors }
  return { spec: { fileName, sheets: sheets.map((s) => s.sheet) }, sheets, card }
}

// ---- The tool -----------------------------------------------------------------------------

export interface ExcelToolContext {
  db: Db
  config: Config
  readers: Readers
  /** Where the files are kept. */
  store: ImageStorage
  /** Files share the reports' limit: each runs up to eight queries in full. */
  limiter: RateLimiter
  userId: string
  /** The name the person signed in with: logged if the account is gone by the time the file is asked for. */
  userName: string
  conversationId: string
  turnId: string
  emit: (event: AiStreamEvent) => void
}

/** Who asked, as the log keeps them. */
interface Asker {
  name: string
  role: string
}

const NOT_GIVEN = "Not allowed: the assistant's owner has not given this person Excel files. Tell them so; the owner decides who may."

const failed = (tu: ToolUse, content: string): ToolOutcome => ({ result: { type: 'tool_result', tool_use_id: tu.id, is_error: true, content } })

/** What the model sent, as jsonb holds it (it takes no \u0000). */
const requestJson = (input: unknown) => JSON.stringify(input ?? null).replace(/\\u0000/g, '')

interface MadeFile {
  id: string
  fileName: string
  spec: AiExcelSpec
  card: AiExcelPart['sheets']
  sheetRows: number[]
  byteSize: number
  sha256: string
  storageKey: string
  expiresAt: Date
}

async function logRequest(ctx: ExcelToolContext, tu: ToolUse, who: Asker, entry: { status: 'made'; file: MadeFile } | { status: 'refused' | 'failed'; problems: string }): Promise<void> {
  const file = entry.status === 'made' ? entry.file : null
  await ctx.db.query(
    `INSERT INTO ai_excel_files (id, conversation_id, turn_id, tool_use_id, user_id, user_name, user_role, status, request, problems,
                                 file_name, spec, card, sheet_rows, byte_size, sha256, storage_key, expires_at)
     VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12::json, $13::json, $14, $15, $16, $17, $18)`,
    [
      file?.id ?? null,
      ctx.conversationId,
      ctx.turnId,
      tu.id,
      ctx.userId,
      who.name,
      who.role,
      entry.status,
      requestJson(tu.input),
      entry.status === 'made' ? null : entry.problems,
      file?.fileName ?? null,
      file ? JSON.stringify(file.spec) : null,
      file ? JSON.stringify(file.card) : null,
      file?.sheetRows ?? null,
      file?.byteSize ?? null,
      file?.sha256 ?? null,
      file?.storageKey ?? null,
      file?.expiresAt ?? null,
    ],
  )
}

/** No file: the request is logged with why, and the model is told every problem. */
async function refuse(ctx: ExcelToolContext, tu: ToolUse, who: Asker, problems: string[]): Promise<ToolOutcome> {
  await logRequest(ctx, tu, who, { status: 'refused', problems: problems.join('\n') })
  return failed(tu, ['No file was made. Fix these and call make_excel again, or tell the person what stands in the way:', ...problems.map((p) => `- ${p}`)].join('\n'))
}

/** A fault, or a stop: logged as failed, as far as the log can still be written. */
async function fault(ctx: ExcelToolContext, tu: ToolUse, who: Asker, why: string): Promise<ToolOutcome> {
  await logRequest(ctx, tu, who, { status: 'failed', problems: why }).catch((e) => console.error('[ai] could not log a failed Excel file', e))
  return failed(tu, `No file was made: ${why}`)
}

/**
 * Cut short while it ran: by the asker's Stop or the clock, logged as failed; handed over to another run, nothing is
 * logged — the step is not kept, and the run that continues it makes the file.
 */
async function cutShort(ctx: ExcelToolContext, tu: ToolUse, who: Asker, signal: AbortSignal): Promise<ToolOutcome> {
  if (signal.reason === HANDED_OVER) return failed(tu, 'No file was made: the answer was handed over.')
  return fault(ctx, tu, who, 'stopped before the file was made.')
}

/** The person as they are now, as the log keeps them: their name and role. */
async function askerNow(q: Queryable, userId: string): Promise<Asker | null> {
  const { rows } = await q.query<Asker>(`SELECT name, role::text AS role FROM users WHERE id = $1 AND deleted_at IS NULL AND is_active`, [userId])
  return rows[0] ?? null
}

export const excelStorageKey = (id: string) => `documents/ai-excel/${id}.xlsx`

export function excelToolHandlers(ctx: ExcelToolContext): Record<string, ToolHandler> {
  return { [MAKE_EXCEL_TOOL_NAME]: { run: (tu, signal) => make(ctx, tu, signal) } }
}

async function make(ctx: ExcelToolContext, tu: ToolUse, signal: AbortSignal): Promise<ToolOutcome> {
  let who: Asker = { name: ctx.userName, role: 'none' }
  try {
    // A step finished after the answer was cut short runs its calls again: one already logged is not made twice.
    const before = await ctx.db.query<{ status: 'made' | 'refused' | 'failed'; card: AiExcelPart['sheets']; fileName: string; problems: string | null }>(
      `SELECT status, card, file_name AS "fileName", problems FROM ai_excel_files WHERE conversation_id = $1 AND tool_use_id = $2`,
      [ctx.conversationId, tu.id],
    )
    const logged = before.rows[0]
    if (logged?.status === 'made') {
      const content = {
        made: true,
        fileName: logged.fileName,
        sheets: logged.card.map((s) => ({ name: s.name, columns: s.columns, rows: s.rows })),
        note: 'Made before the answer was interrupted; it is the card the person has. You have not seen its rows: never give figures from it.',
      }
      return { result: { type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(content) } }
    }
    if (logged) return { result: { type: 'tool_result', tool_use_id: tu.id, is_error: true, content: `No file was made, before the answer was interrupted: ${logged.problems ?? logged.status}` } }

    const person = await askerNow(ctx.db, ctx.userId)
    if (person) who = person
    const access = await loadAccess(ctx.db, ctx.userId)
    if (!person || !isGranted(access)) return await refuse(ctx, tu, who, ['Not allowed: this person no longer has the assistant.'])
    const owner = (await currentAiOwner(ctx.db, ctx.config)) === ctx.userId
    if (!mayMakeExcel(access, owner)) return await refuse(ctx, tu, who, [NOT_GIVEN])
    const wait = ctx.limiter.hit(ctx.userId)
    if (wait > 0) return await refuse(ctx, tu, who, [`Too many files and report runs in a short time: the person can ask again in ${wait} seconds.`])

    // Every sheet in full, one after another, all of them within one export's room.
    const pool = ctx.readers.poolFor(access.domains)
    let room = AI_EXPORT_LIMITS.maxChars
    const checked = await checkExcel(tu.input, async (sql) => {
      const run = await runReadOnlyQuery(pool, sql, {
        maxRows: AI_EXCEL_MAX_ROWS,
        timeoutMs: SHEET_QUERY_TIMEOUT_MS,
        timeZone: ctx.config.FACTORY_TIMEZONE,
        maxRowBytes: AI_EXPORT_LIMITS.maxRowBytes,
        maxChars: Math.max(1, room),
        signal,
      })
      for (const row of run.rows) for (const c of row) room -= typeof c === 'string' ? c.length : 8
      return run
    })
    if (signal.aborted) return await cutShort(ctx, tu, who, signal)
    if ('errors' in checked) return await refuse(ctx, tu, who, checked.errors)

    const created = new Date()
    const bytes = await buildWorkbook(checked.sheets, { stamp: factoryClock(created, ctx.config.FACTORY_TIMEZONE), created })
    const id = randomUUID()
    const file: MadeFile = {
      id,
      fileName: checked.spec.fileName,
      spec: checked.spec,
      card: checked.card,
      sheetRows: checked.card.map((s) => s.rows),
      byteSize: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      storageKey: excelStorageKey(id),
      expiresAt: new Date(created.getTime() + AI_EXCEL_KEEP_DAYS * DAY_MS),
    }
    await ctx.store.put(file.storageKey, bytes, XLSX_CONTENT_TYPE)
    try {
      await logRequest(ctx, tu, who, { status: 'made', file })
    } catch (e) {
      // Never a file without its log: the bytes go again.
      await ctx.store.remove(file.storageKey).catch((err) => console.error('[ai] could not take back an Excel file', err))
      throw e
    }
    const part: AiExcelPart = { type: 'excel', fileId: id, fileName: file.fileName, sheets: file.card, byteSize: file.byteSize, expiresAt: file.expiresAt.toISOString() }
    ctx.emit({ type: 'excel', part })
    const content = {
      made: true,
      fileName: file.fileName,
      sheets: file.card.map((s) => ({ name: s.name, columns: s.columns, rows: s.rows })),
      note:
        `Shown to the person as a card with Download, kept ${AI_EXCEL_KEEP_DAYS} days. You have not seen its rows: say in a sentence or two what the file holds ` +
        '(its sheets, the period, the filters), never figures from it.',
    }
    return { result: { type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(content) } }
  } catch (e) {
    // What failed only because the answer was cut short is no fault of the server.
    if (signal.aborted) return await cutShort(ctx, tu, who, signal)
    console.error('[ai] an Excel file could not be made', e)
    return await fault(ctx, tu, who, 'a fault on the server. Say so to the person; they may ask again.')
  }
}

// ---- Download -----------------------------------------------------------------------------

export interface StoredExcelFile {
  fileName: string
  storageKey: string
  byteSize: number
  /** Its time is over, or its bytes are gone. */
  expired: boolean
}

/** A file made for the person, in a conversation they still have. */
export async function findExcelFile(q: Queryable, userId: string, id: string): Promise<StoredExcelFile> {
  const { rows } = await q.query<StoredExcelFile>(
    `SELECT f.file_name AS "fileName", f.storage_key AS "storageKey", f.byte_size AS "byteSize",
            (f.removed_at IS NOT NULL OR f.expires_at <= now()) AS expired
       FROM ai_excel_files f JOIN ai_conversations c ON c.id = f.conversation_id
      WHERE f.id = $1 AND f.user_id = $2 AND f.status = 'made' AND c.deleted_at IS NULL`,
    [id, userId],
  )
  if (!rows[0]) throw notFound('That file')
  return rows[0]
}

/** A download, kept. */
export async function logExcelDownload(q: Queryable, fileId: string, userId: string): Promise<void> {
  await q.query(`INSERT INTO ai_excel_downloads (file_id, user_id) VALUES ($1, $2)`, [fileId, userId])
}

// ---- Keeping ------------------------------------------------------------------------------

/**
 * Takes the bytes of files whose time is over out of storage, oldest first,
 * `limit` at a time; each is marked removed once its bytes are gone (a file
 * whose bytes could not be removed is tried again next time). The number
 * removed.
 */
export async function removeExpiredExcelFiles(db: Db, store: ImageStorage, limit = 100): Promise<number> {
  const { rows } = await db.query<{ id: string; storageKey: string }>(
    `SELECT id, storage_key AS "storageKey" FROM ai_excel_files
      WHERE status = 'made' AND removed_at IS NULL AND expires_at <= now()
      ORDER BY expires_at LIMIT $1`,
    [limit],
  )
  let removed = 0
  for (const r of rows) {
    try {
      await store.remove(r.storageKey)
    } catch (e) {
      console.error('[ai] could not remove an expired Excel file', r.id, e)
      continue
    }
    const done = await db.query(`UPDATE ai_excel_files SET removed_at = now() WHERE id = $1 AND removed_at IS NULL`, [r.id])
    removed += done.rowCount ?? 0
  }
  return removed
}

/** Every hour, on every instance: two removing the same file at once both find its bytes gone, and one marks it. */
export class ExcelFileSweeper {
  private timer: NodeJS.Timeout | null = null
  private running: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly deps: { db: Db; store: ImageStorage },
    private readonly everyMs = 60 * 60_000,
  ) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.sweep(), this.everyMs)
    this.timer.unref()
    this.sweep()
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.running
  }

  private sweep(): void {
    this.running = this.running
      .then(() => removeExpiredExcelFiles(this.deps.db, this.deps.store))
      .catch((e) => console.error('[ai] could not remove expired Excel files', e))
  }
}
