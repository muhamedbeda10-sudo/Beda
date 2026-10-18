// ============================================================================
// Report styles and Excel forms — how a report looks when it leaves the app.
//
// A style is a set of choices, never code: colours, a typeface from a short
// list, where the logo sits, the letterhead's lines, document control (the
// form's number, revision and issue date, as a quality system writes them),
// how tables, figures and sections look, the foot of the page and the
// approval boxes (Prepared / Reviewed / Approved). The app draws every report
// from those choices — on paper (PDF) and in Excel — so a style can never
// break a report, and the assistant can read a sample (a PDF or a photo of a
// report) and propose one without writing anything that runs.
//
// Anyone given the assistant makes styles for their own reports; one with
// the Configuration permission shares a style with everyone and chooses the
// company's default, which answers and reports without a style of their own
// print in. Each save is a version, kept.
//
// An Excel form is the company's own workbook (QF-07, an inspection sheet…)
// kept with a saved report, with where each value goes: a cell takes a field
// of the report (its title, its period, a document number), one of its
// inputs, or a figure of a section (its first row's value, or a total); a
// table takes a section's rows from a starting row, and when they are more
// than the form holds, either rows are inserted (what sits below — totals,
// signatures — moves down with its formatting) or the sheet is copied, page
// after page. The app fills the workbook itself, keeping everything else in it
// as it was.
// ============================================================================

// ---- Styles ------------------------------------------------------------------------

/** The typefaces a style may use: on every computer that prints (Windows and Office), or shipped with the app (Inter). */
export const REPORT_STYLE_FONTS = ['Inter', 'Arial', 'Calibri', 'Cambria', 'Times New Roman'] as const
export type ReportStyleFont = (typeof REPORT_STYLE_FONTS)[number]

export type ReportStyleLogoPosition = 'left' | 'right' | 'center'
export type ReportStyleLogoSize = 'small' | 'medium' | 'large'
export type ReportStyleRule = 'double' | 'single' | 'none'
export type ReportStyleBorders = 'all' | 'rows' | 'none'
export type ReportStyleFigures = 'cards' | 'boxed' | 'plain'
export type ReportStyleOrientation = 'portrait' | 'landscape'

export const REPORT_STYLE_LOGO_POSITIONS: readonly ReportStyleLogoPosition[] = ['left', 'right', 'center']
export const REPORT_STYLE_LOGO_SIZES: readonly ReportStyleLogoSize[] = ['small', 'medium', 'large']
export const REPORT_STYLE_RULES: readonly ReportStyleRule[] = ['double', 'single', 'none']
export const REPORT_STYLE_BORDERS: readonly ReportStyleBorders[] = ['all', 'rows', 'none']
export const REPORT_STYLE_FIGURES: readonly ReportStyleFigures[] = ['cards', 'boxed', 'plain']
export const REPORT_STYLE_ORIENTATIONS: readonly ReportStyleOrientation[] = ['portrait', 'landscape']

export interface ReportStyleColors {
  /** The letterhead's main colour: its rule, section numbers, the figures' accent. */
  primary: string
  /** The second colour of the letterhead's rule. */
  accent: string
  /** Titles and section headings. */
  heading: string
  /** Body text. */
  text: string
  tableHeaderBg: string
  tableHeaderText: string
  /** Every other row of a table, when striped. */
  tableStripe: string
  tableBorder: string
}
export const REPORT_STYLE_COLOR_KEYS: readonly (keyof ReportStyleColors)[] = [
  'primary',
  'accent',
  'heading',
  'text',
  'tableHeaderBg',
  'tableHeaderText',
  'tableStripe',
  'tableBorder',
]

export interface ReportStyleSpec {
  colors: ReportStyleColors
  font: ReportStyleFont
  orientation: ReportStyleOrientation
  logo: { position: ReportStyleLogoPosition; size: ReportStyleLogoSize }
  header: {
    /** Beside the logo, on top. */
    companyName: string
    department: string
    /** "Scheduled report", "Saved report", "AI assistant report" under the department. */
    showKind: boolean
    rule: ReportStyleRule
  }
  /** A quality system's document control, in a box at the top right. */
  docControl: { enabled: boolean; docNo: string; revision: string; issueDate: string }
  table: { borders: ReportStyleBorders; stripes: boolean; compact: boolean }
  figures: ReportStyleFigures
  /** Sections numbered 1, 2, 3. */
  numbering: boolean
  footer: { text: string; pageNumbers: boolean }
  /** Boxes to sign at the end: one per label. */
  approvals: { enabled: boolean; labels: string[] }
}

export const REPORT_STYLE_NAME_MAX = 80
export const REPORT_STYLE_TEXT_MAX = 120
export const REPORT_STYLE_MAX_APPROVALS = 4
/** A logo is kept inside the style, as a data URL: small, so every report carries it. */
export const REPORT_STYLE_LOGO_MAX_CHARS = 300_000
/** Styles one person may keep. */
export const REPORT_STYLE_MAX_PER_OWNER = 30

/** The look reports have without a style of their own: LinkMisr's letterhead. */
export const BUILTIN_REPORT_STYLE: ReportStyleSpec = {
  colors: {
    primary: '#1E46A8',
    accent: '#E3202A',
    heading: '#0F172A',
    text: '#0F172A',
    tableHeaderBg: '#EEF2F8',
    tableHeaderText: '#0F172A',
    tableStripe: '#F8FAFC',
    tableBorder: '#CBD5E1',
  },
  font: 'Inter',
  orientation: 'portrait',
  logo: { position: 'left', size: 'medium' },
  header: { companyName: '', department: 'Quality Control Department', showKind: true, rule: 'double' },
  docControl: { enabled: false, docNo: '', revision: '', issueDate: '' },
  table: { borders: 'rows', stripes: true, compact: false },
  figures: 'cards',
  numbering: true,
  footer: { text: 'LinkMisr · Quality Control', pageNumbers: true },
  approvals: { enabled: false, labels: ['Prepared by', 'Reviewed by', 'Approved by'] },
}
export const BUILTIN_REPORT_STYLE_NAME = 'LinkMisr (built in)'

/** A style as a report is drawn in: its choices and its logo (none: the LinkMisr wordmark). */
export interface ResolvedReportStyle {
  /** Null for the built-in look. */
  id: string | null
  name: string
  version: number
  spec: ReportStyleSpec
  logoDataUrl: string | null
}

export const BUILTIN_RESOLVED_STYLE: ResolvedReportStyle = { id: null, name: BUILTIN_REPORT_STYLE_NAME, version: 1, spec: BUILTIN_REPORT_STYLE, logoDataUrl: null }

export interface ReportStyle extends ResolvedReportStyle {
  id: string
  shared: boolean
  /** The company's default: answers and reports without a style of their own print in it. */
  isDefault: boolean
  /** The person asking made it: only they change or delete it. */
  mine: boolean
  ownerName: string
  updatedAt: string
  updatedByName: string
}

export interface ReportStylesResponse {
  styles: ReportStyle[]
  /** The company's default, when one is chosen and the person may see it (a default is always shared). */
  defaultId: string | null
  /** The person may share styles and choose the default (the Configuration permission). */
  canManage: boolean
}

export interface ReportStyleSaveRequest {
  name: string
  spec: ReportStyleSpec
  logoDataUrl: string | null
  /** The version changed, to refuse a stale save. Absent when creating. */
  version?: number
}

/** The style answers print in: the company's default, else the built-in look. */
export interface ReportStyleDefaultResponse {
  style: ResolvedReportStyle
}

export interface ReportStyleShareRequest {
  shared: boolean
}

export interface ReportStyleChooseDefaultRequest {
  /** Null: no default (the built-in look). */
  styleId: string | null
}

export interface ReportStyleVersionsResponse {
  versions: ReportStyleVersion[]
}

/** The style a saved report prints in, as its owner chooses it. */
export interface AiReportStyleRequest {
  /** Null: the company's default. */
  styleId: string | null
}

export interface ReportStyleVersion {
  version: number
  name: string
  spec: ReportStyleSpec
  changedByName: string
  changedAt: string
}

/** A style the assistant proposed: from a sample, a change put in words, or both. Not saved. */
export interface ReportStyleDraftRequest {
  /** Pages of a sample report, as images (a PDF's pages are drawn on the device): JPEG or PNG data URLs. */
  images?: string[]
  /** The style as it stands, to change. */
  spec?: ReportStyleSpec
  /** What to change, in the person's words. */
  instruction?: string
}
export interface ReportStyleDraftResponse {
  spec: ReportStyleSpec
  name: string
  /** Where the logo is on the first sample image, as fractions of its width and height, when there is one. */
  logoBox: { x: number; y: number; w: number; h: number } | null
  /** What the assistant could not carry over, or chose, in a line or two. */
  notes: string
}
export const REPORT_STYLE_SAMPLE_MAX_IMAGES = 3
export const REPORT_STYLE_SAMPLE_MAX_CHARS = 5_000_000
export const REPORT_STYLE_INSTRUCTION_MAX = 1_000

const HEX = /^#[0-9a-f]{6}$/i
export const isHexColor = (v: unknown): v is string => typeof v === 'string' && HEX.test(v)

/** "02" → "03", "3" → "4", "A" stays (a revision that is not a number is the person's to change). */
export function nextRevision(revision: string): string {
  const m = /^(\D*)(\d+)$/.exec(revision.trim())
  if (!m) return revision
  const next = String(Number(m[2]) + 1).padStart(m[2].length, '0')
  return `${m[1]}${next}`
}

/** Two specs the same, choice by choice (the order keys were written in aside). */
export function sameSpec(a: ReportStyleSpec, b: ReportStyleSpec): boolean {
  const norm = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(norm) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([x], [y]) => x.localeCompare(y)).map(([k, x]) => [k, norm(x)])) : v
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b))
}

// ---- Excel forms ----------------------------------------------------------------------

/** The report's own fields a form's cell can take. */
export const REPORT_FORM_FIELDS = [
  'report.title',
  'report.description',
  'period.label',
  'period.from',
  'period.to',
  'ran.at',
  'ran.day',
  'doc.no',
  'doc.revision',
  'doc.issueDate',
  'printed.by',
] as const
export type ReportFormField = (typeof REPORT_FORM_FIELDS)[number]
export const REPORT_FORM_FIELD_NAMES: Record<ReportFormField, string> = {
  'report.title': 'Report title',
  'report.description': 'Report description',
  'period.label': 'Period (as words)',
  'period.from': 'Period: first day',
  'period.to': 'Period: last day',
  'ran.at': 'Run at (date and time)',
  'ran.day': 'Run day',
  'doc.no': 'Document No. (from the style)',
  'doc.revision': 'Revision (from the style)',
  'doc.issueDate': 'Issue date (from the style)',
  'printed.by': 'Who made the file',
}

export const REPORT_FORM_AGGREGATES = ['first', 'sum', 'count', 'average', 'min', 'max'] as const
export type ReportFormAggregate = (typeof REPORT_FORM_AGGREGATES)[number]

export type ReportFormValue =
  | { kind: 'field'; field: ReportFormField }
  | { kind: 'input'; name: string }
  /** A section's column: its first row's value, or a figure over all its rows. */
  | { kind: 'section'; section: number; column: string; aggregate: ReportFormAggregate }
  | { kind: 'text'; text: string }

export interface ReportFormCell {
  /** A1 reference on the form's sheet. */
  ref: string
  value: ReportFormValue
}

export type ReportFormOverflow = 'insert' | 'next-sheet'

export interface ReportFormTable {
  /** The section whose rows fill it (0-based, in the report's order). */
  section: number
  /** The first row the rows go in (1-based): it holds the formatting every row takes. */
  startRow: number
  /** The last row the form holds, when rows past it go on a copy of the sheet. */
  lastRow?: number
  overflow: ReportFormOverflow
  /** Each column of the form (a letter) and the section's column it takes. */
  columns: { col: string; column: string }[]
}

export interface ReportFormMapping {
  sheet: string
  cells: ReportFormCell[]
  tables: ReportFormTable[]
}

export const REPORT_FORM_MAX_BYTES = 2 * 1024 * 1024
/** What a form's workbook may unpack to, in all: more is refused (a file made to burst the server's memory). */
export const REPORT_FORM_MAX_UNPACKED_BYTES = 40 * 1024 * 1024
export const REPORT_FORM_MAX_CELLS = 400
export const REPORT_FORM_MAX_TABLES = 6
/** Copies a form's sheet may have when its rows go on page after page. */
export const REPORT_FORM_MAX_PAGES = 50
/** Rows a form takes from a section, in all. */
export const REPORT_FORM_MAX_ROWS = 5_000
export const REPORT_FORM_NAME_MAX = 120

/** A form's sheet as the app shows it: the cells with something in them near the top, and the merged ranges. */
export interface ReportFormSheetPreview {
  name: string
  rowCount: number
  columnCount: number
  cells: { ref: string; text: string; bold?: boolean; fill?: string }[]
  merges: string[]
}

export interface ReportForm {
  id: string
  reportId: string
  name: string
  fileName: string
  byteSize: number
  sheets: ReportFormSheetPreview[]
  mapping: ReportFormMapping | null
  version: number
  /** The report's owner: only they change or delete it. */
  mine: boolean
  updatedAt: string
  updatedByName: string
}

export interface ReportFormsResponse {
  forms: ReportForm[]
}

export interface ReportFormSaveRequest {
  name: string
  mapping: ReportFormMapping | null
  version: number
}

export interface ReportFormSuggestResponse {
  mapping: ReportFormMapping
  notes: string
}

// ---- A1 references ------------------------------------------------------------------------

const REF = /^([A-Z]{1,3})([1-9]\d{0,6})$/

/** "C12" → { col: 3, row: 12 } (1-based); null for anything else. */
export function parseCellRef(ref: string): { col: number; row: number } | null {
  const m = REF.exec(ref.trim().toUpperCase())
  if (!m) return null
  let col = 0
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64)
  if (col > 16_384) return null
  return { col, row: Number(m[2]) }
}

/** 3 → "C". */
export function columnName(col: number): string {
  let s = ''
  let n = col
  while (n > 0) {
    const r = (n - 1) % 26
    s = String.fromCharCode(65 + r) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

/** "c" → 3; 0 for anything else. */
export function columnNumber(letters: string): number {
  const trimmed = letters.trim()
  if (!/^[A-Za-z]{1,3}$/.test(trimmed)) return 0
  const ref = parseCellRef(`${trimmed}1`)
  return ref ? ref.col : 0
}

/**
 * What is wrong with a form's mapping against the form's sheets and the
 * report's sections (their columns), each in a line; empty when nothing is.
 */
export function reportFormMappingProblems(
  mapping: ReportFormMapping,
  sheets: readonly Pick<ReportFormSheetPreview, 'name'>[],
  sections: readonly { title: string; columns: readonly string[] | null }[],
  inputs: readonly string[],
): string[] {
  const out: string[] = []
  if (!sheets.some((s) => s.name === mapping.sheet)) out.push(`The form has no sheet named “${mapping.sheet}”.`)
  if (mapping.cells.length > REPORT_FORM_MAX_CELLS) out.push(`A form fills at most ${REPORT_FORM_MAX_CELLS} cells.`)
  if (mapping.tables.length > REPORT_FORM_MAX_TABLES) out.push(`A form holds at most ${REPORT_FORM_MAX_TABLES} tables.`)
  const columnOf = (section: number, column: string, where: string) => {
    const s = sections[section]
    if (!s) {
      out.push(`${where}: the report has no section ${section + 1}.`)
      return
    }
    // A section that has not run yet: its columns are not known, and are checked when the form is filled.
    if (s.columns && !s.columns.includes(column)) out.push(`${where}: section ${section + 1} (“${s.title}”) has no column “${column}”.`)
  }
  const used = new Set<string>()
  for (const c of mapping.cells) {
    const ref = parseCellRef(c.ref)
    const where = `Cell ${c.ref}`
    if (!ref) {
      out.push(`“${c.ref}” is not a cell (write it as C3).`)
      continue
    }
    const key = `${ref.col}:${ref.row}`
    if (used.has(key)) out.push(`${where} is filled twice.`)
    used.add(key)
    const v = c.value
    if (v.kind === 'input' && !inputs.includes(v.name)) out.push(`${where}: the report has no input “${v.name}”.`)
    if (v.kind === 'section') columnOf(v.section, v.column, where)
    if (v.kind === 'text' && v.text.length > 500) out.push(`${where}: the text is longer than 500 characters.`)
  }
  const modes = new Set(mapping.tables.map((t) => t.overflow))
  if (modes.size > 1) out.push('The tables of one form take more rows the same way: all insert rows, or all go on to a copy of the sheet.')
  const ranges: { from: number; to: number }[] = []
  mapping.tables.forEach((t, i) => {
    const where = `Table ${i + 1}`
    if (!Number.isInteger(t.startRow) || t.startRow < 1 || t.startRow > 100_000) out.push(`${where}: its first row is not a row.`)
    if (t.overflow === 'next-sheet') {
      if (!Number.isInteger(t.lastRow) || (t.lastRow ?? 0) < t.startRow) out.push(`${where}: give the last row the form holds (at or after the first).`)
    }
    if (t.columns.length === 0) out.push(`${where}: give at least one column.`)
    const cols = new Set<number>()
    for (const c of t.columns) {
      const n = columnNumber(c.col)
      if (!n) out.push(`${where}: “${c.col}” is not a column letter.`)
      else if (cols.has(n)) out.push(`${where}: column ${c.col.toUpperCase()} is filled twice.`)
      cols.add(n)
      columnOf(t.section, c.column, where)
    }
    const to = t.overflow === 'next-sheet' ? (t.lastRow ?? t.startRow) : t.startRow
    if (ranges.some((r) => !(to < r.from || t.startRow > r.to))) out.push(`${where} overlaps another table's rows.`)
    ranges.push({ from: t.startRow, to })
    for (const c of mapping.cells) {
      const ref = parseCellRef(c.ref)
      if (ref && ref.row >= t.startRow && ref.row <= to && cols.has(ref.col)) out.push(`Cell ${c.ref} is inside ${where.toLowerCase()}'s rows.`)
    }
  })
  return out
}
