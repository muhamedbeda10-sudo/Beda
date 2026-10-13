// ============================================================================
// §20 — files a question carries, on the device: what kind a picked file is,
// and a spreadsheet as the text Claude reads (sheet by sheet, as CSV rows,
// within the length a file may have). Pure functions, so they are tested
// without a browser; the uploads are services/aiAttachments.ts.
// ============================================================================

import { AI_MAX_SHEET_CHARS, type AiAttachment, type AiAttachmentKind } from '@qc/shared/ai'

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp'])
const SHEET_EXTENSIONS = new Set(['xlsx', 'xls', 'csv'])

/** What the file chooser offers: photos, PDFs and spreadsheets. */
export const ATTACH_ACCEPT = 'image/*,application/pdf,.pdf,.xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/** A picked file's kind by its name and type; null for one the assistant cannot take. The bytes are checked again on upload. */
export function pickedKind(file: { name: string; type: string }): AiAttachmentKind | null {
  const ext = extensionOf(file.name)
  if (ext === 'pdf' || file.type === 'application/pdf') return 'pdf'
  if (SHEET_EXTENSIONS.has(ext) || file.type === 'text/csv') return 'sheet'
  if (IMAGE_EXTENSIONS.has(ext) || file.type.startsWith('image/')) return 'image'
  return null
}

/** One cell as CSV writes it: quoted when it holds a comma, a quote or a line break. */
function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

export const csvLine = (cells: readonly string[]): string => {
  // Trailing empty cells say nothing.
  let end = cells.length
  while (end > 0 && cells[end - 1].trim() === '') end--
  return cells.slice(0, end).map(csvCell).join(',')
}

const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

/** A sheet's name inside its heading: one line, quotes made plain. */
const sheetName = (name: string) => name.replace(/\s+/g, ' ').replace(/"/g, "'").trim() || 'Sheet'

export interface SheetText {
  /** The sheets as Claude reads them. */
  text: string
  /** Its sheets, rows and columns, for the chip. */
  summary: string
  /** Rows left out to stay within the length a file may have. */
  omittedRows: number
}

/**
 * A workbook (or a CSV, as one sheet) as the text Claude reads: each sheet
 * that holds anything under a heading with its size, then its rows as CSV.
 * Past `maxChars` the rest of the rows are left out, and the text says how
 * many. Null when no sheet holds anything.
 */
export function sheetText(sheets: readonly { name: string; rows: readonly (readonly string[])[] }[], maxChars = AI_MAX_SHEET_CHARS): SheetText | null {
  const filled = sheets.filter((s) => s.rows.length > 0)
  if (filled.length === 0) return null
  // Room for the note on what was left out, which always fits.
  const budget = maxChars - 200
  const parts: string[] = []
  let used = 0
  let omittedRows = 0
  let totalRows = 0
  for (const s of filled) {
    const columns = Math.max(...s.rows.map((r) => r.length))
    totalRows += s.rows.length
    const heading = `## Sheet "${sheetName(s.name)}" (${count(s.rows.length, 'row')} × ${count(columns, 'column')})`
    if (used + heading.length + 1 > budget) {
      omittedRows += s.rows.length
      continue
    }
    parts.push(heading)
    used += heading.length + 1
    for (const [i, row] of s.rows.entries()) {
      const line = csvLine(row)
      if (used + line.length + 1 > budget) {
        omittedRows += s.rows.length - i
        break
      }
      parts.push(line)
      used += line.length + 1
    }
  }
  if (omittedRows > 0) parts.push(`[${count(omittedRows, 'more row')} not included: the file is longer than the assistant can read at once.]`)
  const only = filled.length === 1 ? filled[0] : null
  const summary = only
    ? `${count(only.rows.length, 'row')} × ${count(Math.max(...only.rows.map((r) => r.length)), 'column')}`
    : `${count(filled.length, 'sheet')} · ${count(totalRows, 'row')}`
  return { text: parts.join('\n'), summary: omittedRows > 0 ? `${summary} · ${count(omittedRows, 'row')} left out` : summary, omittedRows }
}

/** A file as the question box holds it until it is sent. */
export interface PendingAttachment {
  /** This device's key for it. */
  key: string
  name: string
  kind: AiAttachmentKind
  state: 'uploading' | 'ready' | 'failed'
  /** Kept once uploaded. */
  attachment?: AiAttachment
  /** Why it failed, in a sentence. */
  error?: string
}

/** The files of a question once all are kept: their ids in order; null while any is still on its way or has failed. */
export function readyIds(pending: readonly PendingAttachment[]): string[] | null {
  if (pending.some((p) => p.state !== 'ready' || !p.attachment)) return null
  return pending.map((p) => p.attachment!.id)
}

/** A file's size for its chip. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
