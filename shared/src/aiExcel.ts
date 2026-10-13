// ============================================================================
// §20 — Excel files the assistant makes: the person asks for data in a
// spreadsheet laid out their way, and the assistant lays the file out: one
// or more sheets, each from its own read-only query, the columns in the order
// and under the names asked for, each written as a whole number, a decimal, a
// percentage, a date or text, with a totals row, a title and a line of notes,
// right to left for an Arabic sheet. The server runs the queries, builds the
// workbook and keeps it for AI_EXCEL_KEEP_DAYS days; the assistant never sees
// its rows. The file is a card in the answer, with Download.
// ============================================================================

/** How a column's values are written: as text, whole numbers, decimals, a percentage (the query returns 0–100), a day, or a day and time. */
export type AiExcelFormat = 'text' | 'integer' | 'decimal' | 'percent' | 'date' | 'datetime'
export const AI_EXCEL_FORMATS: readonly AiExcelFormat[] = ['text', 'integer', 'decimal', 'percent', 'date', 'datetime']

/** What a totals row works out for a column: the sum, the average, or how many rows have a value. */
export type AiExcelTotal = 'sum' | 'average' | 'count'
export const AI_EXCEL_TOTALS: readonly AiExcelTotal[] = ['sum', 'average', 'count']

/** Sheets in a file, columns in a sheet, at most; decimals a column may show. */
export const AI_EXCEL_MAX_SHEETS = 8
export const AI_EXCEL_MAX_COLUMNS = 40
export const AI_EXCEL_MAX_DECIMALS = 4
/** Rows a sheet holds at most: a sheet with more makes no file, and the person is asked to narrow it. */
export const AI_EXCEL_MAX_ROWS = 50_000
/** Days a file is kept for download. */
export const AI_EXCEL_KEEP_DAYS = 30

export interface AiExcelColumn {
  /** The query's column it takes its values from. */
  column: string
  /** Its heading in the sheet. */
  header: string
  format: AiExcelFormat
  /** For decimals and percentages. */
  decimals?: number
}

export interface AiExcelSheet {
  name: string
  title?: string
  notes?: string
  sql: string
  columns: AiExcelColumn[]
  /** A row under the data: its label, and what it works out for some columns (by the query's column). */
  totals?: { label: string; columns: { column: string; total: AiExcelTotal }[] }
  rightToLeft: boolean
}

/** The file as the assistant laid it out, checked and kept. */
export interface AiExcelSpec {
  fileName: string
  sheets: AiExcelSheet[]
}

/** The file as its card shows it: its name, each sheet's columns and rows, its size, and until when it can be downloaded. */
export interface AiExcelPart {
  type: 'excel'
  fileId: string
  fileName: string
  sheets: { name: string; title?: string; columns: string[]; rows: number }[]
  byteSize: number
  expiresAt: string
  /** Its time is over: it can no longer be downloaded. */
  expired?: boolean
}
