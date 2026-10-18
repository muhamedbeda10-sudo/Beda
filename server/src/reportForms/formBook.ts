// ============================================================================
// A company's Excel form, read and filled (shared/src/reportStyles.ts).
//
// Read: what the app shows of each sheet — the cells with something in them
// near the top, bold and filled as they are, and the merged ranges — so a
// person (and the assistant) can say where each value goes.
//
// Filled: the form as it is, with the report's values put where the mapping
// says. A table's rows start at its first row, which holds the formatting
// each row takes. When a section has more rows than the form holds:
//   • insert — rows are inserted under the first one, each a copy of it (its
//     borders, merges, height); what sits below (totals, signatures, a stamp)
//     moves down with its merges and pictures, and formulas are rewritten to
//     follow: a total over the first row (SUM(D7:D7)) takes every row filled;
//   • next-sheet — the form's sheet is copied, as many times as the rows need,
//     before anything is written; every copy takes the report's fields, and the
//     rows continue on it from the first row.
// Everything else in the workbook stays as it was. Excel works its formulas out
// again when the file opens.
// ============================================================================

import ExcelJS from 'exceljs'
import { parseChartDate, type AiCell } from '@qc/shared/ai'
import {
  REPORT_FORM_MAX_PAGES,
  REPORT_FORM_MAX_ROWS,
  columnName,
  columnNumber,
  parseCellRef,
  type ReportFormMapping,
  type ReportFormSheetPreview,
  type ReportFormTable,
  type ReportFormValue,
} from '@qc/shared/reportStyles'
import { FormFileError, checkWorkbookZip } from './zipGuard'

/** The part of a sheet shown and described: enough for any form's header and first rows. */
const PREVIEW_ROWS = 80
const PREVIEW_COLUMNS = 30
const PREVIEW_MAX_CELLS = 1_500
const PREVIEW_TEXT_MAX = 120

export async function loadWorkbook(bytes: Buffer): Promise<ExcelJS.Workbook> {
  checkWorkbookZip(bytes)
  const wb = new ExcelJS.Workbook()
  try {
    await wb.xlsx.load(bytes as unknown as ArrayBuffer)
  } catch {
    throw new FormFileError('This workbook could not be read. Open it in Excel, save it again as .xlsx, and upload it.')
  }
  if (wb.worksheets.length === 0) throw new FormFileError('This workbook has no sheet.')
  return wb
}

const argbHex = (argb: string | undefined) => (argb && /^[0-9A-F]{8}$/i.test(argb) ? `#${argb.slice(2).toUpperCase()}` : undefined)

/** Each sheet as the app shows it. */
export function previewSheets(wb: ExcelJS.Workbook): ReportFormSheetPreview[] {
  return wb.worksheets.map((ws) => {
    const cells: ReportFormSheetPreview['cells'] = []
    const lastRow = Math.min(ws.rowCount, PREVIEW_ROWS)
    for (let r = 1; r <= lastRow && cells.length < PREVIEW_MAX_CELLS; r++) {
      const row = ws.getRow(r)
      for (let c = 1; c <= Math.min(ws.columnCount, PREVIEW_COLUMNS); c++) {
        const cell = row.getCell(c)
        if (cell.isMerged && cell.master.address !== cell.address) continue
        const text = cellText(cell)
        const fill = cell.fill && cell.fill.type === 'pattern' && cell.fill.pattern === 'solid' ? argbHex((cell.fill.fgColor as { argb?: string } | undefined)?.argb) : undefined
        if (!text && !fill) continue
        cells.push({ ref: cell.address, text: text.slice(0, PREVIEW_TEXT_MAX), ...(cell.font?.bold ? { bold: true } : {}), ...(fill && fill !== '#FFFFFF' ? { fill } : {}) })
      }
    }
    const merges = ((ws.model as { merges?: string[] }).merges ?? []).filter((m) => {
      const top = parseCellRef(m.split(':')[0])
      return top !== null && top.row <= PREVIEW_ROWS && top.col <= PREVIEW_COLUMNS
    })
    return { name: ws.name, rowCount: ws.rowCount, columnCount: ws.columnCount, cells, merges }
  })
}

function cellText(cell: ExcelJS.Cell): string {
  const v = cell.value
  if (v === null || v === undefined) return ''
  if (typeof v === 'object' && 'formula' in v) return `=${(v as ExcelJS.CellFormulaValue).formula}`
  if (typeof v === 'object' && 'sharedFormula' in v) return '=…'
  try {
    return (cell.text ?? '').replace(/\s+/g, ' ').trim()
  } catch {
    return ''
  }
}

// ---- Filling ----------------------------------------------------------------------------

/** A section's rows as the form takes them. */
export interface FormSection {
  title: string
  ok: boolean
  error?: string
  columns: string[]
  rows: AiCell[][]
}

/** Everything a form's cells and tables can take. */
export interface FormData {
  fields: Record<string, string>
  inputs: Record<string, string>
  sections: FormSection[]
}

export class FormFillError extends Error {}

interface Range {
  c1: number
  r1: number
  c2: number
  r2: number
}
const parseRange = (range: string): Range | null => {
  const [a, b = a] = range.split(':')
  const p = parseCellRef(a)
  const q = parseCellRef(b)
  return p && q ? { c1: p.col, r1: p.row, c2: q.col, r2: q.row } : null
}
const rangeText = (r: Range) => `${columnName(r.c1)}${r.r1}:${columnName(r.c2)}${r.r2}`

/**
 * A formula with its row numbers moved: `move(row, absolute)` gives each
 * reference's new row. References to another sheet ('Sheet 2'!A1) and inside
 * quoted text stay as they are.
 */
export function moveFormulaRows(formula: string, move: (row: number, absolute: boolean, end: 'single' | 'start' | 'end') => number): string {
  let out = ''
  let i = 0
  const ref = /(\$?)([A-Z]{1,3})(\$?)(\d{1,7})(?::(\$?)([A-Z]{1,3})(\$?)(\d{1,7}))?/y
  while (i < formula.length) {
    const ch = formula[i]
    if (ch === '"') {
      const close = formula.indexOf('"', i + 1)
      const end = close < 0 ? formula.length : close + 1
      out += formula.slice(i, end)
      i = end
      continue
    }
    if (ch === "'") {
      // A quoted sheet name, then its reference: kept as written.
      const close = formula.indexOf("'", i + 1)
      const end = close < 0 ? formula.length : close + 1
      out += formula.slice(i, end)
      i = end
      ref.lastIndex = i
      if (formula[i] === '!') {
        out += '!'
        i++
        ref.lastIndex = i
        const m = ref.exec(formula)
        if (m) {
          out += m[0]
          i = ref.lastIndex
        }
      }
      continue
    }
    const before = i > 0 ? formula[i - 1] : ''
    ref.lastIndex = i
    const m = /[A-Za-z_$]/.test(ch) && !/[A-Za-z0-9_.]/.test(before) ? ref.exec(formula) : null
    const after = m ? formula[ref.lastIndex] ?? '' : ''
    // A function's name (SUM( ) or another sheet's name before "!" is no reference.
    if (m && after !== '(' && after !== '!' && !/[A-Za-z0-9_]/.test(after)) {
      if (m[5] !== undefined) {
        const r1 = move(Number(m[4]), m[3] === '$', 'start')
        const r2 = move(Number(m[8]), m[7] === '$', 'end')
        out += `${m[1]}${m[2]}${m[3]}${r1}:${m[5]}${m[6]}${m[7]}${r2}`
      } else {
        out += `${m[1]}${m[2]}${m[3]}${move(Number(m[4]), m[3] === '$', 'single')}`
      }
      i = ref.lastIndex
      continue
    }
    // A word (a function, a name, another sheet): copied whole, so its letters and digits are not read as a reference.
    const word = /[A-Za-z_][A-Za-z0-9_.]*/y
    word.lastIndex = i
    const w = /[A-Za-z_]/.test(ch) ? word.exec(formula) : null
    if (w) {
      out += w[0]
      i = word.lastIndex
      continue
    }
    out += ch
    i++
  }
  return out
}

function formulaOf(cell: ExcelJS.Cell): string | null {
  const v = cell.value
  if (v && typeof v === 'object' && 'formula' in v && typeof (v as ExcelJS.CellFormulaValue).formula === 'string') return (v as ExcelJS.CellFormulaValue).formula
  return null
}

/**
 * `count` rows inserted under `start`, each a copy of it; what was below
 * moves down by `count` with its merges, pictures, formulas and the print
 * area. A range ending on `start` (a total over the table) grows to take the
 * new rows; a merge spanning `start` grows too.
 */
export function insertRowsBelow(ws: ExcelJS.Worksheet, start: number, count: number): void {
  if (count <= 0) return
  const merges = [...(((ws.model as { merges?: string[] }).merges ?? []) as string[])].map(parseRange).filter((r): r is Range => r !== null)
  const below = merges.filter((m) => m.r1 > start)
  const spanning = merges.filter((m) => m.r1 <= start && m.r2 > start)
  const ofRow = merges.filter((m) => m.r1 === start && m.r2 === start)
  for (const m of [...below, ...spanning]) ws.unMergeCells(rangeText(m))

  const template = ws.getRow(start)
  const height = template.height
  // The template row's formulas, to give each copy its own row.
  const templateFormulas: { col: number; formula: string }[] = []
  template.eachCell({ includeEmpty: false }, (cell, col) => {
    const f = formulaOf(cell)
    if (f) templateFormulas.push({ col, formula: f })
  })

  ws.duplicateRow(start, count, true)

  for (const m of below) ws.mergeCells(rangeText({ ...m, r1: m.r1 + count, r2: m.r2 + count }))
  for (const m of spanning) ws.mergeCells(rangeText({ ...m, r2: m.r2 + count }))
  for (let k = 1; k <= count; k++) {
    const row = ws.getRow(start + k)
    if (height) row.height = height
    for (const m of ofRow) {
      try {
        ws.mergeCells(rangeText({ ...m, r1: start + k, r2: start + k }))
      } catch {
        // Already merged by the copy.
      }
    }
    for (const f of templateFormulas) {
      row.getCell(f.col).value = { formula: moveFormulaRows(f.formula, (r, abs) => (r === start && !abs ? r + k : r)) } as ExcelJS.CellFormulaValue
    }
  }

  // Formulas below and beside: references below `start` move down; a range ending on `start` takes the new rows.
  ws.eachRow({ includeEmpty: false }, (row, r) => {
    if (r >= start && r <= start + count) return
    row.eachCell({ includeEmpty: false }, (cell) => {
      const f = formulaOf(cell)
      if (!f) return
      const moved = moveFormulaRows(f, (row, _abs, end) => (row > start ? row + count : end === 'end' && row === start ? row + count : row))
      if (moved !== f) cell.value = { formula: moved } as ExcelJS.CellFormulaValue
    })
  })

  // Pictures anchored below the row move down with what they sit on.
  for (const image of ws.getImages()) {
    const range = image.range as unknown as { tl: { nativeRow: number }; br?: { nativeRow: number } }
    if (range.tl.nativeRow >= start) {
      range.tl.nativeRow += count
      if (range.br) range.br.nativeRow += count
    }
  }

  const area = ws.pageSetup?.printArea
  if (typeof area === 'string') {
    ws.pageSetup.printArea = area
      .split(',')
      .map((part) => {
        const r = parseRange(part.replace(/\$/g, ''))
        if (!r) return part
        return rangeText({ ...r, r1: r.r1 > start ? r.r1 + count : r.r1, r2: r.r2 >= start ? r.r2 + count : r.r2 })
      })
      .join(',')
  }
}

/** A copy of a sheet, as it is, after the last sheet: for a form whose rows go on page after page. */
function copySheet(wb: ExcelJS.Workbook, ws: ExcelJS.Worksheet, name: string): ExcelJS.Worksheet {
  const copy = wb.addWorksheet(name)
  const model = ws.model as unknown as Record<string, unknown>
  copy.model = { ...model, name, id: copy.id, mergeCells: model.merges } as unknown as ExcelJS.WorksheetModel
  return copy
}

const DATE_FORMAT = /[dmy]/i

/** A value put in a cell: a number as a number, a day or a time as a date when the cell is formatted for one, else as text. */
function put(cell: ExcelJS.Cell, v: AiCell): void {
  if (v === null || v === undefined) {
    cell.value = null
    return
  }
  if (typeof v === 'boolean') {
    cell.value = v ? 'Yes' : 'No'
    return
  }
  if (typeof v === 'number') {
    cell.value = v
    return
  }
  const at = parseChartDate(v)
  if (at && cell.numFmt && DATE_FORMAT.test(cell.numFmt) && cell.numFmt !== 'General') {
    cell.value = new Date(at.ms)
    return
  }
  // eslint-disable-next-line no-control-regex
  cell.value = String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
}

/** A section's column, by name: refused when the run has no such column. */
function columnIndex(section: FormSection, column: string, sectionIndex: number): number {
  const i = section.columns.indexOf(column)
  if (i < 0) throw new FormFillError(`Section ${sectionIndex + 1} (“${section.title}”) no longer has a column “${column}”. Change the form's mapping.`)
  return i
}

function sectionOf(data: FormData, index: number): FormSection {
  const s = data.sections[index]
  if (!s) throw new FormFillError(`The report has no section ${index + 1} any more. Change the form's mapping.`)
  if (!s.ok) throw new FormFillError(`Section ${index + 1} (“${s.title}”) failed, so the form cannot be filled: ${s.error ?? 'its query failed.'}`)
  return s
}

/** What a cell takes. */
export function formValue(value: ReportFormValue, data: FormData): AiCell {
  switch (value.kind) {
    case 'text':
      return value.text
    case 'field':
      return data.fields[value.field] ?? ''
    case 'input':
      return data.inputs[value.name] ?? ''
    case 'section': {
      const s = sectionOf(data, value.section)
      const i = columnIndex(s, value.column, value.section)
      const values = s.rows.map((r) => r[i] ?? null)
      if (value.aggregate === 'first') return values[0] ?? null
      if (value.aggregate === 'count') return values.filter((v) => v !== null && v !== '').length
      const numbers = values.filter((v): v is number => typeof v === 'number')
      if (numbers.length === 0) return null
      if (value.aggregate === 'sum') return numbers.reduce((a, b) => a + b, 0)
      if (value.aggregate === 'average') return numbers.reduce((a, b) => a + b, 0) / numbers.length
      if (value.aggregate === 'min') return Math.min(...numbers)
      return Math.max(...numbers)
    }
  }
}

/** The form filled, as the bytes of a workbook. */
export async function fillForm(bytes: Buffer, mapping: ReportFormMapping, data: FormData): Promise<Buffer> {
  const wb = await loadWorkbook(bytes)
  const ws = wb.getWorksheet(mapping.sheet)
  if (!ws) throw new FormFillError(`The form has no sheet named “${mapping.sheet}” any more. Change the form's mapping.`)

  // Each table's rows, as its columns take them: checked before anything is written.
  const tables = mapping.tables.map((t) => {
    const s = sectionOf(data, t.section)
    const cols = t.columns.map((c) => ({ col: columnNumber(c.col), index: columnIndex(s, c.column, t.section) }))
    return { table: t, rows: s.rows, cols }
  })
  const total = tables.reduce((n, t) => n + t.rows.length, 0)
  if (total > REPORT_FORM_MAX_ROWS) throw new FormFillError(`The form would take ${total.toLocaleString('en-US')} rows; it takes at most ${REPORT_FORM_MAX_ROWS.toLocaleString('en-US')}. Narrow the report's period or filters.`)
  const cellValues = mapping.cells.map((c) => ({ ref: parseCellRef(c.ref)!, value: formValue(c.value, data) }))

  const writeRows = (sheet: ExcelJS.Worksheet, t: (typeof tables)[number], rows: AiCell[][], firstRow: number) => {
    rows.forEach((row, i) => {
      const r = sheet.getRow(firstRow + i)
      for (const c of t.cols) put(r.getCell(c.col), row[c.index] ?? null)
    })
  }

  if (tables.length > 0 && tables[0].table.overflow === 'next-sheet') {
    const capacity = (t: ReportFormTable) => (t.lastRow ?? t.startRow) - t.startRow + 1
    const pages = Math.max(1, ...tables.map((t) => Math.ceil(t.rows.length / capacity(t.table))))
    if (pages > REPORT_FORM_MAX_PAGES) throw new FormFillError(`The rows would take ${pages} copies of the form; it makes at most ${REPORT_FORM_MAX_PAGES}. Narrow the report's period or filters.`)
    // Copies made from the form as it is, before anything is written on it.
    const taken = new Set(wb.worksheets.map((w) => w.name.toLowerCase()))
    const sheets = [ws]
    for (let p = 2; p <= pages; p++) {
      let name = `${ws.name} (${p})`.slice(0, 31)
      for (let k = 2; taken.has(name.toLowerCase()); k++) name = `${ws.name.slice(0, 24)} (${p}.${k})`.slice(0, 31)
      taken.add(name.toLowerCase())
      sheets.push(copySheet(wb, ws, name))
    }
    sheets.forEach((sheet, p) => {
      for (const c of cellValues) put(sheet.getCell(c.ref.row, c.ref.col), c.value)
      for (const t of tables) {
        const cap = capacity(t.table)
        writeRows(sheet, t, t.rows.slice(p * cap, (p + 1) * cap), t.table.startRow)
      }
    })
  } else {
    // Bottom first, so a table's inserted rows do not move one above it.
    const ordered = [...tables].sort((a, b) => b.table.startRow - a.table.startRow)
    for (const t of ordered) {
      insertRowsBelow(ws, t.table.startRow, Math.max(0, t.rows.length - 1))
      writeRows(ws, t, t.rows, t.table.startRow)
    }
    // A cell below a table moved down with what was inserted above it.
    const shift = (row: number) => tables.reduce((n, t) => n + (t.table.startRow < row ? Math.max(0, t.rows.length - 1) : 0), 0)
    for (const c of cellValues) put(ws.getCell(c.ref.row + shift(c.ref.row), c.ref.col), c.value)
  }

  wb.calcProperties.fullCalcOnLoad = true
  return Buffer.from(await wb.xlsx.writeBuffer())
}
