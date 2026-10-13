// ============================================================================
// §20 — an Excel file the assistant laid out, as the workbook the server
// builds with ExcelJS, written as a stream so a large sheet never sits whole
// in memory. Per sheet: a title and a line of notes above the table; a bold,
// shaded header frozen at the top with a filter on it; each column's values
// as real numbers, percentages, days and times in the format laid out (text
// as written); a totals row Excel works out itself (SUBTOTAL, so it follows
// the filter); right to left for an Arabic sheet; and a page set up to print
// — A4, as wide as the page, the header on every page, when the data was read
// and the page number at the foot.
// ============================================================================

import { PassThrough } from 'node:stream'
import ExcelJS from 'exceljs'
import { parseChartDate, type AiCell } from '@qc/shared/ai'
import type { AiExcelFormat, AiExcelSheet, AiExcelTotal } from '@qc/shared/aiExcel'

/** A sheet as laid out, with its rows: each in the order of the sheet's columns. */
export interface BookSheet {
  sheet: AiExcelSheet
  rows: AiCell[][]
}

const TITLE_FONT: Partial<ExcelJS.Font> = { bold: true, size: 14 }
const NOTES_FONT: Partial<ExcelJS.Font> = { italic: true, size: 10, color: { argb: 'FF595959' } }
const BOLD: Partial<ExcelJS.Font> = { bold: true }
const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE7EEF5' } }
const HEADER_BORDER: Partial<ExcelJS.Borders> = { bottom: { style: 'thin', color: { argb: 'FF8EA9C1' } } }
const TOTALS_BORDER: Partial<ExcelJS.Borders> = { top: { style: 'thin', color: { argb: 'FF595959' } } }

/** SUBTOTAL's functions that leave out the rows a filter hides: a sum, an average, a count of values. */
const SUBTOTAL_OF: Record<AiExcelTotal, number> = { sum: 109, average: 101, count: 103 }

/** A4. */
const PAPER_A4 = 9
/** Rows written between two turns of the event loop: a large file never holds up the other requests for long. */
const ROWS_PER_TURN = 1_000
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve))
/** A sheet whose columns are wider than this, in characters, prints lying down. */
const PORTRAIT_WIDTH = 95

/** The code Excel shows a column's values with; none for text. */
export function formatCode(format: AiExcelFormat, decimals?: number): string | undefined {
  const places = Math.max(0, Math.min(10, Math.floor(decimals ?? 0)))
  const fraction = places > 0 ? `.${'0'.repeat(places)}` : ''
  switch (format) {
    case 'integer':
      return '#,##0'
    case 'decimal':
      return `#,##0${fraction}`
    case 'percent':
      return `0${fraction}%`
    case 'date':
      return 'yyyy-mm-dd'
    case 'datetime':
      return 'yyyy-mm-dd hh:mm'
    case 'text':
      return undefined
  }
}

/** Characters XML 1.0 cannot hold (tab and line breaks aside): dropped, or the file would not open. */
// eslint-disable-next-line no-control-regex
const clean = (s: string) => s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')

/**
 * A value as its column writes it: a number as a number, a percentage as its
 * fraction (the query gives 2.5 for 2.5%), a day or a time as a date (its
 * clock read as written, whatever the zone of the computer that opens it),
 * yes or no for a boolean, anything else as text.
 */
export function cellOf(v: AiCell, format: AiExcelFormat): ExcelJS.CellValue {
  if (v === null) return null
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (format === 'integer' || format === 'decimal') return typeof v === 'number' ? v : clean(v)
  if (format === 'percent') return typeof v === 'number' ? v / 100 : clean(v)
  if (format === 'date' || format === 'datetime') {
    const at = parseChartDate(v)
    return at ? new Date(at.ms) : clean(String(v))
  }
  return clean(String(v))
}

/** How wide a value reads once shown in its column's format, in characters. */
function shownWidth(v: ExcelJS.CellValue, format: AiExcelFormat, decimals: number | undefined): number {
  if (v === null || v === undefined) return 0
  if (v instanceof Date) return format === 'date' ? 10 : 16
  if (typeof v !== 'number') return String(v).length
  const places = decimals ?? 0
  if (format === 'percent') return (v * 100).toFixed(places).length + 1
  if (format === 'integer' || format === 'decimal') return v.toLocaleString('en-US', { minimumFractionDigits: places, maximumFractionDigits: places }).length
  return String(v).length
}

/** What a total works out over the values written, to the 15 digits Excel keeps: shown until Excel works it out itself. */
function totalOf(kind: AiExcelTotal, values: ExcelJS.CellValue[]): number | undefined {
  if (kind === 'count') return values.filter((v) => v !== null && v !== undefined && v !== '').length
  const numbers = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  const sum = numbers.reduce((a, b) => a + b, 0)
  const total = kind === 'sum' ? sum : numbers.length > 0 ? sum / numbers.length : undefined
  return total === undefined ? undefined : Number(total.toPrecision(15))
}

/** 0 → A, 25 → Z, 26 → AA. */
export function columnLetter(index: number): string {
  let s = ''
  let n = index + 1
  while (n > 0) {
    const r = (n - 1) % 26
    s = String.fromCharCode(65 + r) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

/** Text in a printed header or footer: & starts a code there, so its own & is doubled. */
const footerText = (s: string) => clean(s).replace(/&/g, '&&')

async function writeSheet(book: ExcelJS.stream.xlsx.WorkbookWriter, { sheet, rows }: BookSheet, stamp: string): Promise<void> {
  const columns = sheet.columns
  // A title and notes, then a blank row, then the table.
  const lead = (sheet.title ? 1 : 0) + (sheet.notes ? 1 : 0)
  const headerRow = lead > 0 ? lead + 2 : 1
  const firstDataRow = headerRow + 1
  const lastDataRow = headerRow + rows.length
  const lastColumn = columnLetter(columns.length - 1)
  const values = rows.map((row) => columns.map((c, i) => cellOf(row[i] ?? null, c.format)))
  const widths = columns.map((c, i) => {
    let w = c.header.length
    for (const row of values) w = Math.max(w, shownWidth(row[i], c.format, c.decimals))
    return Math.min(60, Math.max(8, w + 2))
  })

  const ws = book.addWorksheet(sheet.name, {
    views: [{ state: 'frozen', xSplit: 0, ySplit: headerRow, rightToLeft: sheet.rightToLeft }],
    pageSetup: {
      paperSize: PAPER_A4 as ExcelJS.PaperSize,
      orientation: widths.reduce((a, b) => a + b, 0) > PORTRAIT_WIDTH ? 'landscape' : 'portrait',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      printTitlesRow: `${headerRow}:${headerRow}`,
      margins: { left: 0.4, right: 0.4, top: 0.6, bottom: 0.6, header: 0.3, footer: 0.3 },
    },
    headerFooter: { oddFooter: `&L${footerText(stamp)}&R&P / &N` },
  })
  widths.forEach((w, i) => {
    ws.getColumn(i + 1).width = w
  })

  if (sheet.title) {
    const row = ws.addRow([clean(sheet.title)])
    row.getCell(1).font = TITLE_FONT
    row.commit()
  }
  if (sheet.notes) {
    const row = ws.addRow([clean(sheet.notes)])
    row.getCell(1).font = NOTES_FONT
    row.commit()
  }
  if (lead > 0) ws.addRow([]).commit()

  const header = ws.addRow(columns.map((c) => clean(c.header)))
  columns.forEach((_, i) => {
    const cell = header.getCell(i + 1)
    cell.font = BOLD
    cell.fill = HEADER_FILL
    cell.border = HEADER_BORDER
  })
  header.commit()

  const codes = columns.map((c) => formatCode(c.format, c.decimals))
  for (const [r, v] of values.entries()) {
    const row = ws.addRow(v)
    codes.forEach((code, i) => {
      if (code && v[i] !== null) row.getCell(i + 1).numFmt = code
    })
    row.commit()
    if (r % ROWS_PER_TURN === ROWS_PER_TURN - 1) await nextTurn()
  }

  const totals = sheet.totals
  const kinds = columns.map((c) => totals?.columns.find((t) => t.column === c.column)?.total ?? null)
  if (totals && rows.length > 0 && kinds.some(Boolean)) {
    // The label goes in the first column that works nothing out.
    const labelAt = kinds.findIndex((k) => !k)
    const cells: ExcelJS.CellValue[] = kinds.map((kind, i) => {
      if (!kind) return i === labelAt ? clean(totals.label) : null
      const letter = columnLetter(i)
      return {
        formula: `SUBTOTAL(${SUBTOTAL_OF[kind]},${letter}${firstDataRow}:${letter}${lastDataRow})`,
        result: totalOf(kind, values.map((r) => r[i])),
      }
    })
    const row = ws.addRow(cells)
    kinds.forEach((kind, i) => {
      const cell = row.getCell(i + 1)
      cell.font = BOLD
      cell.border = TOTALS_BORDER
      // A count is a whole number, whatever the column holds.
      const code = kind === 'count' ? formatCode('integer') : kind ? codes[i] : undefined
      if (code) cell.numFmt = code
    })
    row.commit()
  }

  ws.autoFilter = `A${headerRow}:${lastColumn}${lastDataRow}`
  ws.commit()
}

/**
 * The workbook's bytes: one sheet per sheet laid out, in order. `stamp`: when
 * the data was read, in the factory's time, printed at the foot of each page.
 */
export async function buildWorkbook(sheets: readonly BookSheet[], opts: { stamp: string; created: Date }): Promise<Buffer> {
  const out = new PassThrough()
  const chunks: Buffer[] = []
  out.on('data', (chunk: Buffer) => chunks.push(chunk))
  const ended = new Promise<void>((resolve, reject) => {
    out.on('end', resolve)
    out.on('error', reject)
  })
  // Shared strings: the form every spreadsheet program reads; a column's repeated names are kept once.
  const book = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: out, useStyles: true, useSharedStrings: true })
  book.creator = 'QC Inspection Recorder — AI assistant'
  book.created = opts.created
  for (const s of sheets) await writeSheet(book, s, opts.stamp)
  await book.commit()
  await ended
  return Buffer.concat(chunks)
}
