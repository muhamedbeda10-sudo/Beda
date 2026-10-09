// ============================================================================
// §20 — a query of an answer to Excel. The server runs it again in full (up
// to AI_EXPORT_MAX_ROWS rows, fewer when the rows are wide); the workbook holds the result on one sheet and,
// on a second, what was asked and the SQL that answered it, so the figures
// can be traced and checked later.
// ============================================================================

import type { AiQueryExportResponse } from '@qc/shared/ai'
import type { CellValue, SheetSpec } from '@/lib/xlsxWrite'

/** Excel holds at most this many characters in a cell; a longer text makes it "repair" the file. */
export const EXCEL_CELL_MAX = 32_767

/** A cell as Excel takes it: numbers stay numbers, yes/no for a boolean, JSON for anything structured. */
export function aiCellValue(v: unknown): CellValue {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  const text = typeof v === 'string' ? v : JSON.stringify(v)
  return text.length > EXCEL_CELL_MAX ? text.slice(0, EXCEL_CELL_MAX) : text
}

/** A local date and time that sorts as text: 2026-10-09 14:05. */
function stamp(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function aiResultSheets(r: AiQueryExportResponse, question?: string): SheetSpec[] {
  const about: CellValue[][] = []
  if (question?.trim()) about.push(['Question', aiCellValue(question.trim())])
  about.push(
    ['Purpose', aiCellValue(r.purpose)],
    ['Run at', stamp(r.ranAt)],
    ['Rows', r.rows.length],
    ['Complete', r.truncated ? `No — only the first ${r.rows.length.toLocaleString('en-US')} rows` : 'Yes'],
    ['SQL', aiCellValue(r.sql)],
  )
  return [
    { name: 'Result', header: r.columns, rows: r.rows.map((row) => row.map(aiCellValue)) },
    { name: 'Query', header: ['Field', 'Value'], rows: about },
  ]
}

/** QC-AI-2026-10-09-1405.xlsx: the moment it was run, so two exports of a day never collide. */
export function aiExportFilename(ranAt: string): string {
  return `QC-AI-${stamp(ranAt).replace(' ', '-').replace(':', '')}.xlsx`
}
