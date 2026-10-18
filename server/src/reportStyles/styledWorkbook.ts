// ============================================================================
// A report as an Excel workbook, drawn in its style (shared/src/reportStyles.ts).
// The same content the plain export had — a "Report" sheet saying what it is,
// over which days, when it ran, its inputs, and for each section its sheet,
// its rows and (for a saved report) the SQL behind them; then a sheet per
// section — now under the company's letterhead: the logo (or the LinkMisr
// wordmark), the company and department, the document control box, the
// style's colours and typeface, ruled and striped tables whose header row
// repeats on every printed page, the approval boxes, and the page set up for
// paper (A4, the style's orientation, one page wide, the foot's text and
// page numbers).
// ============================================================================

import ExcelJS from 'exceljs'
import type { AiCell } from '@qc/shared/ai'
import type { ReportStyleSpec, ResolvedReportStyle } from '@qc/shared/reportStyles'
import { jpegSize } from '../ai/attachments'

/** Excel holds at most this many characters in a cell; a longer text makes it "repair" the file. */
const EXCEL_CELL_MAX = 32_767
/** Excel's own sheet-name limit and forbidden characters. */
const SHEET_NAME_MAX = 31

export interface WorkbookSection {
  title: string
  ok: boolean
  error?: string
  columns: string[]
  rows: AiCell[][]
  truncated?: boolean
  /** The SQL as it ran, for a saved report: what makes its figures traceable. */
  sql?: string
}

export interface WorkbookDoc {
  /** "Saved report", "Scheduled report". */
  kind: string
  title: string
  /** What places it, in order: label and value ("Period", "Run at", an input…). */
  about: [string, string | number][]
  sections: WorkbookSection[]
  /** Under the sections on the Report sheet: what "complete" means for this kind. */
  truncatedNote: (rows: number) => string
  madeBy: string
  madeAt: string
  timeZone: string
}

// ---- Values ---------------------------------------------------------------------------------

/** A cell as Excel takes it: numbers stay numbers, yes/no for a boolean, JSON for anything structured. */
function cellValue(v: unknown): string | number | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  const text = typeof v === 'string' ? v : JSON.stringify(v)
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  return clean.length > EXCEL_CELL_MAX ? clean.slice(0, EXCEL_CELL_MAX) : clean
}

/** A moment where the factory sits: "2026-10-09 14:05". */
export function factoryStamp(iso: string, timeZone: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d)
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`
}

/** A name Excel opens, unique in the workbook (case aside). */
function sheetName(wanted: string, taken: Set<string>): string {
  const base = wanted.replace(/[:\\/?*[\]]/g, ' ').replace(/^'+|'+$/g, '').replace(/\s+/g, ' ').trim().slice(0, SHEET_NAME_MAX) || 'Sheet'
  let name = base
  for (let n = 2; taken.has(name.toLowerCase()); n++) {
    const suffix = ` (${n})`
    name = `${base.slice(0, SHEET_NAME_MAX - suffix.length)}${suffix}`
  }
  taken.add(name.toLowerCase())
  return name
}

// ---- The style in Excel's terms ------------------------------------------------------------------

const argb = (hex: string) => `FF${hex.replace('#', '').toUpperCase()}`

/** Inter is shipped with the app, not with Office: in Excel it is Calibri, which every copy has. */
const excelFont = (spec: ReportStyleSpec) => (spec.font === 'Inter' ? 'Calibri' : spec.font)

interface Look {
  font: string
  spec: ReportStyleSpec
  thin: Partial<ExcelJS.Border>
}

const lookOf = (spec: ReportStyleSpec): Look => ({ font: excelFont(spec), spec, thin: { style: 'thin', color: { argb: argb(spec.colors.tableBorder) } } })

function textFont(look: Look, extra: Partial<ExcelJS.Font> = {}): Partial<ExcelJS.Font> {
  return { name: look.font, size: 10, color: { argb: argb(look.spec.colors.text) }, ...extra }
}

/** A table's header row and its rows, ruled, shaded and striped as the style says. */
function styleTable(ws: ExcelJS.Worksheet, look: Look, headerRow: number, lastRow: number, columns: number): void {
  const { spec, thin } = look
  for (let r = headerRow; r <= lastRow; r++) {
    const row = ws.getRow(r)
    const header = r === headerRow
    const striped = !header && spec.table.stripes && (r - headerRow) % 2 === 0
    for (let c = 1; c <= columns; c++) {
      const cell = row.getCell(c)
      // Rows keep no height of their own: Excel fits each to its wrapped text. Compact is a size smaller.
      const size = spec.table.compact ? 9 : 10
      cell.font = header ? textFont(look, { size, bold: true, color: { argb: argb(spec.colors.tableHeaderText) } }) : textFont(look, { size })
      if (header) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(spec.colors.tableHeaderBg) } }
      else if (striped) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(spec.colors.tableStripe) } }
      cell.alignment = { vertical: header ? 'middle' : 'top', wrapText: header || typeof cell.value === 'string', horizontal: typeof cell.value === 'number' ? 'right' : undefined }
      if (spec.table.borders === 'all') cell.border = { top: thin, bottom: thin, left: thin, right: thin }
      else if (spec.table.borders === 'rows') cell.border = { bottom: thin, ...(header ? { top: thin } : {}) }
      else if (header) cell.border = { bottom: { style: 'medium', color: { argb: argb(spec.colors.primary) } } }
    }
  }
}

/** Widths from what the columns hold, between readable and not too wide to print. */
function fitColumns(ws: ExcelJS.Worksheet, fromRow: number, columns: number, min = 8, max = 60): void {
  for (let c = 1; c <= columns; c++) {
    let longest = min
    ws.getColumn(c).eachCell({ includeEmpty: false }, (cell, rowNumber) => {
      if (rowNumber < fromRow) return
      const text = cell.value === null || cell.value === undefined ? '' : String(cell.value)
      longest = Math.max(longest, ...text.split('\n').map((l) => Math.min(l.length, max)))
    })
    ws.getColumn(c).width = Math.min(max, longest + 2)
  }
}

/** Paper as the style says: A4, its orientation, one page wide; the foot's text and page numbers on every page. */
function pageSetup(ws: ExcelJS.Worksheet, look: Look, title: string, repeatRow?: number): void {
  ws.pageSetup = {
    paperSize: 9,
    orientation: look.spec.orientation,
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    margins: { left: 0.5, right: 0.5, top: 0.6, bottom: 0.7, header: 0.3, footer: 0.3 },
    horizontalCentered: true,
    ...(repeatRow ? { printTitlesRow: `${repeatRow}:${repeatRow}` } : {}),
  }
  const escape = (s: string) => s.replace(/&/g, '&&')
  const left = look.spec.footer.text ? `&L&8${escape(look.spec.footer.text)}` : ''
  const centre = `&C&8${escape(title.slice(0, 80))}`
  const right = look.spec.footer.pageNumbers ? '&R&8Page &P of &N' : ''
  ws.headerFooter = { oddFooter: `${left}${centre}${right}` }
}

// ---- The letterhead --------------------------------------------------------------------------------

/** A PNG's width and height from its header; null for bytes that are not a PNG. */
function pngSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47 || bytes.subarray(12, 16).toString('latin1') !== 'IHDR') return null
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

const LOGO_HEIGHT_PX = { small: 36, medium: 52, large: 72 } as const
/** The letterhead spans this many columns of the Report sheet (A–F). */
const HEAD_COLUMNS = 6

/**
 * The letterhead on top of a sheet: the logo (or the wordmark), the company
 * and department, what kind of report it is, the document control box, the
 * rule; then the title. Answers the row the content starts at.
 */
function letterhead(wb: ExcelJS.Workbook, ws: ExcelJS.Worksheet, look: Look, style: ResolvedReportStyle, kind: string, title: string): number {
  const { spec } = look
  const logoRows = 3
  for (let r = 1; r <= logoRows; r++) ws.getRow(r).height = 20

  // Where each part sits, by where the logo goes: the logo, the company's lines, the document control box.
  const docCols = spec.docControl.enabled ? 2 : 0
  const place = {
    left: { logoCol: 1, textFrom: 3, textTo: HEAD_COLUMNS - docCols, textRow: 1, align: 'right' as const, docCol: HEAD_COLUMNS - 1 },
    right: { logoCol: HEAD_COLUMNS - 1, textFrom: 1 + docCols, textTo: HEAD_COLUMNS - 2, textRow: 1, align: 'left' as const, docCol: 1 },
    center: { logoCol: 3, textFrom: 1, textTo: HEAD_COLUMNS, textRow: logoRows + 1, align: 'center' as const, docCol: HEAD_COLUMNS - 1 },
  }[spec.logo.position]

  // The logo, or the company's wordmark.
  const logo = style.logoDataUrl ? /^data:image\/(png|jpeg);base64,(.+)$/.exec(style.logoDataUrl) : null
  let logoPlaced = false
  if (logo) {
    const bytes = Buffer.from(logo[2], 'base64')
    const size = logo[1] === 'png' ? pngSize(bytes) : jpegSize(bytes)
    if (size) {
      const height = LOGO_HEIGHT_PX[spec.logo.size]
      const width = Math.min(240, Math.round((size.width / size.height) * height))
      const id = wb.addImage({ base64: style.logoDataUrl!, extension: logo[1] as 'png' | 'jpeg' })
      ws.addImage(id, { tl: { col: place.logoCol - 1 + 0.1, row: 0.2 }, ext: { width, height }, editAs: 'oneCell' })
      logoPlaced = true
    }
  }
  if (!logoPlaced) {
    const mark = ws.getCell(1, place.logoCol)
    mark.value = {
      richText: [
        { text: 'LINK', font: { name: look.font, size: 20, bold: true, color: { argb: 'FF1E46A8' } } },
        { text: 'MISR', font: { name: look.font, size: 20, bold: true, color: { argb: 'FFE3202A' } } },
      ],
    }
    ws.getCell(2, place.logoCol).value = 'ADVANCED STORAGE SOLUTIONS'
    ws.getCell(2, place.logoCol).font = { name: look.font, size: 7, bold: true, color: { argb: 'FF1E46A8' } }
  }

  // The company, department and kind.
  const lines: { text: string; font: Partial<ExcelJS.Font> }[] = []
  if (spec.header.companyName) lines.push({ text: spec.header.companyName, font: textFont(look, { size: 12, bold: true, color: { argb: argb(spec.colors.heading) } }) })
  if (spec.header.department) lines.push({ text: spec.header.department.toUpperCase(), font: textFont(look, { size: 9, bold: true, color: { argb: argb(spec.colors.primary) } }) })
  if (spec.header.showKind) lines.push({ text: kind.toUpperCase(), font: textFont(look, { size: 8, bold: true, color: { argb: 'FF64748B' } }) })
  lines.forEach((line, i) => {
    const r = place.textRow + i
    if (place.textTo > place.textFrom) ws.mergeCells(r, place.textFrom, r, place.textTo)
    const cell = ws.getCell(r, place.textFrom)
    cell.value = line.text
    cell.font = line.font
    cell.alignment = { horizontal: place.align, vertical: 'middle' }
  })
  let next = Math.max(logoRows, place.textRow + lines.length - 1) + 1

  // Document control, a small ruled box at the top right (top left under a right-hand logo).
  if (spec.docControl.enabled) {
    const at = place.docCol
    const entries: [string, string][] = [
      ['Doc. No.', spec.docControl.docNo],
      ['Rev.', spec.docControl.revision],
      ['Issue date', spec.docControl.issueDate],
    ]
    const box = spec.logo.position === 'center' ? next : 1
    entries.forEach(([label, value], i) => {
      const l = ws.getCell(box + i, at)
      const v = ws.getCell(box + i, at + 1)
      l.value = label
      v.value = value
      l.font = textFont(look, { size: 8, bold: true, color: { argb: 'FF475569' } })
      v.font = textFont(look, { size: 9, bold: true })
      for (const c of [l, v]) c.border = { top: look.thin, bottom: look.thin, left: look.thin, right: look.thin }
    })
    if (spec.logo.position === 'center') next += entries.length
  }

  // The rule under the letterhead.
  const ruleRow = ws.getRow(next)
  ruleRow.height = 6
  if (spec.header.rule !== 'none') {
    for (let c = 1; c <= HEAD_COLUMNS; c++) {
      const cell = ruleRow.getCell(c)
      cell.border = {
        bottom: { style: spec.header.rule === 'double' ? 'thick' : 'medium', color: { argb: argb(spec.colors.primary) } },
      }
    }
    if (spec.header.rule === 'double') {
      const second = ws.getRow(next + 1)
      second.height = 4
      for (let c = 1; c <= HEAD_COLUMNS; c++) second.getCell(c).border = { bottom: { style: 'thin', color: { argb: argb(spec.colors.accent) } } }
      next++
    }
  }
  next += 2

  ws.mergeCells(next, 1, next, HEAD_COLUMNS)
  const t = ws.getCell(next, 1)
  t.value = cellValue(title)
  t.font = textFont(look, { size: 16, bold: true, color: { argb: argb(spec.colors.heading) } })
  t.alignment = { vertical: 'middle', wrapText: true }
  ws.getRow(next).height = 26
  return next + 2
}

/** The approval boxes at the end: a label over each, and lines for the name, signature and date. */
function approvals(ws: ExcelJS.Worksheet, look: Look, from: number): number {
  const labels = look.spec.approvals.labels
  if (!look.spec.approvals.enabled || labels.length === 0) return from
  const span = Math.max(1, Math.floor(HEAD_COLUMNS / labels.length))
  labels.forEach((label, i) => {
    const c1 = 1 + i * span
    const c2 = i === labels.length - 1 ? HEAD_COLUMNS : c1 + span - 1
    const rows: [string, number][] = [
      [label, 20],
      ['Name:', 18],
      ['Signature:', 30],
      ['Date:', 18],
    ]
    rows.forEach(([text, height], k) => {
      const r = from + k
      if (c2 > c1) ws.mergeCells(r, c1, r, c2)
      const cell = ws.getCell(r, c1)
      cell.value = text
      cell.font = k === 0 ? textFont(look, { bold: true, color: { argb: argb(look.spec.colors.tableHeaderText) } }) : textFont(look, { size: 8, color: { argb: 'FF64748B' } })
      if (k === 0) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(look.spec.colors.tableHeaderBg) } }
      cell.alignment = { vertical: k === 2 ? 'top' : 'middle' }
      for (let c = c1; c <= c2; c++) {
        ws.getCell(r, c).border = { top: look.thin, bottom: look.thin, left: c === c1 ? look.thin : undefined, right: c === c2 ? look.thin : undefined }
      }
      ws.getRow(r).height = Math.max(ws.getRow(r).height ?? 0, height)
    })
  })
  return from + 4
}

// ---- The workbook ------------------------------------------------------------------------------------

export async function styledWorkbook(doc: WorkbookDoc, style: ResolvedReportStyle): Promise<Buffer> {
  const look = lookOf(style.spec)
  const wb = new ExcelJS.Workbook()
  wb.creator = doc.madeBy
  wb.created = new Date(doc.madeAt)
  wb.title = doc.title

  const taken = new Set<string>()
  const reportName = sheetName('Report', taken)
  const names = doc.sections.map((s, i) => sheetName(`${i + 1} ${s.title}`, taken))

  // ---- The Report sheet: what it is, and where each section is.
  const ws = wb.addWorksheet(reportName, { views: [{ showGridLines: false }] })
  ws.columns = [{ width: 18 }, { width: 24 }, { width: 16 }, { width: 16 }, { width: 14 }, { width: 22 }]
  let row = letterhead(wb, ws, look, style, doc.kind, doc.title)

  const field = (label: string, value: string | number | null, opts: { wrap?: boolean } = {}) => {
    ws.getCell(row, 1).value = label
    ws.getCell(row, 1).font = textFont(look, { bold: true, color: { argb: 'FF475569' } })
    ws.getCell(row, 1).alignment = { vertical: 'top' }
    ws.mergeCells(row, 2, row, HEAD_COLUMNS)
    const v = ws.getCell(row, 2)
    v.value = value
    v.font = textFont(look)
    v.alignment = { vertical: 'top', wrapText: opts.wrap ?? true, horizontal: 'left' }
    const text = value === null ? '' : String(value)
    // Merged cells do not grow with their text: a long value gets the lines it needs.
    const lines = text.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / 90)), 0)
    if (lines > 1) ws.getRow(row).height = Math.min(409, 14 * lines)
    row++
  }

  for (const [label, value] of doc.about) field(label, cellValue(value))
  field('Sections', doc.sections.length)
  row++

  // The sections, as a table: where each is, how many rows, whether it is complete.
  const header = row
  const heads = ['#', 'Section', 'Sheet', 'Rows', 'Complete']
  heads.forEach((h, i) => (ws.getCell(row, i === 4 ? 5 : i + 1).value = h))
  ws.mergeCells(row, 5, row, HEAD_COLUMNS)
  row++
  doc.sections.forEach((s, i) => {
    ws.getCell(row, 1).value = look.spec.numbering ? i + 1 : null
    ws.getCell(row, 2).value = cellValue(s.title)
    ws.getCell(row, 3).value = { text: names[i], hyperlink: `#'${names[i].replace(/'/g, "''")}'!A1` }
    ws.getCell(row, 4).value = s.ok ? s.rows.length : null
    ws.mergeCells(row, 5, row, HEAD_COLUMNS)
    ws.getCell(row, 5).value = s.ok ? (s.truncated ? doc.truncatedNote(s.rows.length) : 'Yes') : cellValue(`Failed: ${s.error || 'the query failed.'}`)
    row++
  })
  styleTable(ws, look, header, row - 1, HEAD_COLUMNS)
  for (let r = header + 1; r < row; r++) ws.getCell(r, 3).font = textFont(look, { underline: true, color: { argb: argb(look.spec.colors.primary) } })

  // The SQL behind each section (a saved report's): its figures can be traced and checked later.
  const withSql = doc.sections.map((s, i) => ({ s, i })).filter(({ s }) => s.sql)
  if (withSql.length > 0) {
    row++
    ws.getCell(row, 1).value = 'Queries'
    ws.getCell(row, 1).font = textFont(look, { bold: true, size: 11, color: { argb: argb(look.spec.colors.heading) } })
    row++
    for (const { s, i } of withSql) field(`Section ${i + 1}`, cellValue(s.sql))
  }

  row++
  field('Made', `${factoryStamp(doc.madeAt, doc.timeZone)} by ${doc.madeBy}`)
  row++
  approvals(ws, look, row)
  pageSetup(ws, look, doc.title)

  // ---- A sheet per section: its title, then its rows under a header that stays on screen and on every page.
  doc.sections.forEach((s, i) => {
    const sheet = wb.addWorksheet(names[i], { views: [{ state: 'frozen', ySplit: 3, showGridLines: false }] })
    const title = sheet.getCell(1, 1)
    title.value = cellValue(look.spec.numbering ? `${i + 1}. ${s.title}` : s.title)
    title.font = textFont(look, { size: 13, bold: true, color: { argb: argb(look.spec.colors.heading) } })
    sheet.getRow(1).height = 22
    if (!s.ok) {
      sheet.getCell(3, 1).value = 'Error'
      sheet.getCell(4, 1).value = cellValue(s.error || 'The query failed.')
      styleTable(sheet, look, 3, 4, 1)
      sheet.getColumn(1).width = 80
      pageSetup(sheet, look, doc.title)
      return
    }
    const columns = s.columns.length
    sheet.getRow(3).values = s.columns.map((c) => cellValue(c))
    s.rows.forEach((r, k) => {
      sheet.getRow(4 + k).values = s.columns.map((_, c) => cellValue(r[c]))
    })
    const last = 3 + s.rows.length
    if (columns > 0) {
      styleTable(sheet, look, 3, last, columns)
      fitColumns(sheet, 3, columns)
      if (s.rows.length > 0) sheet.autoFilter = { from: { row: 3, column: 1 }, to: { row: last, column: columns } }
    }
    if (s.truncated) {
      const note = sheet.getCell(last + 2, 1)
      note.value = doc.truncatedNote(s.rows.length)
      note.font = textFont(look, { italic: true, size: 9, color: { argb: 'FF64748B' } })
    }
    pageSetup(sheet, look, doc.title, 3)
  })

  return Buffer.from(await wb.xlsx.writeBuffer())
}
