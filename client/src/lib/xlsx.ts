// Reads the first-class Excel format (.xlsx — Office Open XML SpreadsheetML)
// into plain string grids, the same shape the CSV parser returns, so the bulk
// importers accept a workbook exported straight from the ERP or from Excel.
//
// Scope, deliberately:
//   • Cell *values* only: shared strings, inline strings, numbers, booleans,
//     formula results (the cached value Excel stored), and dates. Formatting,
//     merged cells, comments and charts are irrelevant to an import.
//   • Dates come out as ISO text (`2026-09-04`, `2026-09-04 07:30:00`) because
//     Excel stores them as day serials; the importer's date fields expect text
//     a `Date` can parse, not a serial number.
//   • Numbers are rendered to 15 significant digits, which is what Excel itself
//     shows, so `0.1 + 0.2` reads as `0.3` and not `0.30000000000000004`.
//   • The old binary `.xls` format is detected and refused with a clear message
//     rather than parsed.
//
// The archive is opened with `fflate`; the XML parts are read with the
// platform `DOMParser` (tests install one from `@xmldom/xmldom`). Everything is
// namespace-agnostic (matched by local name) so workbooks written by Excel,
// LibreOffice, Google Sheets and ERP exporters — transitional or strict OOXML,
// prefixed or not — all read the same way.

import { unzipSync } from 'fflate'

export interface WorkbookSheet {
  name: string
  /** Rows in sheet order; blank rows removed; cells positioned by column, gaps as `''`. */
  rows: string[][]
}

export interface Workbook {
  sheets: WorkbookSheet[]
}

/** A file that is not a readable .xlsx workbook. The message is safe to show. */
export class WorkbookReadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkbookReadError'
  }
}

/** ZIP local-file header — every .xlsx / .docx / .zip starts with it. */
export function isZipFile(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
}

/** OLE2 compound document — the pre-2007 binary `.xls` (and `.doc`) container. */
export function isLegacyExcelFile(bytes: Uint8Array): boolean {
  const magic = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
  return bytes.length >= magic.length && magic.every((b, i) => bytes[i] === b)
}

// ---- Archive ----------------------------------------------------------------

class Package {
  private readonly parts: Map<string, Uint8Array>

  constructor(bytes: Uint8Array) {
    let entries: Record<string, Uint8Array>
    try {
      entries = unzipSync(bytes)
    } catch {
      throw new WorkbookReadError('That file is not a readable Excel workbook.')
    }
    this.parts = new Map()
    for (const [path, data] of Object.entries(entries)) this.parts.set(normalisePath(path), data)
  }

  has(path: string): boolean {
    return this.parts.has(normalisePath(path))
  }

  /** The part parsed as XML, or `undefined` when the package has no such part. */
  xml(path: string): Element | undefined {
    const data = this.parts.get(normalisePath(path))
    if (!data) return undefined
    const text = new TextDecoder('utf-8').decode(data)
    const doc = new DOMParser().parseFromString(text, 'application/xml')
    const root = doc.documentElement
    if (!root || root.localName === 'parsererror' || findFirst(root, 'parsererror')) {
      throw new WorkbookReadError(`The workbook part "${path}" is damaged and could not be read.`)
    }
    return root
  }
}

/** Package part names are case-insensitive; `Target`s may be absolute or relative. */
function normalisePath(path: string): string {
  return path.replace(/^\/+/, '').toLowerCase()
}

/** Resolves a relationship target against the folder of the part that owns it. */
function resolveTarget(baseDir: string, target: string): string {
  if (target.startsWith('/')) return normalisePath(target)
  const segments = baseDir ? baseDir.split('/') : []
  for (const seg of target.split('/')) {
    if (seg === '..') segments.pop()
    else if (seg !== '.' && seg !== '') segments.push(seg)
  }
  return normalisePath(segments.join('/'))
}

// ---- XML helpers (namespace-agnostic) ---------------------------------------

function childElements(el: Element, localName: string): Element[] {
  const out: Element[] = []
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (n as Element).localName === localName) out.push(n as Element)
  }
  return out
}

function firstChild(el: Element, localName: string): Element | undefined {
  return childElements(el, localName)[0]
}

function findFirst(el: Element, localName: string): Element | undefined {
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType !== 1) continue
    const e = n as Element
    if (e.localName === localName) return e
    const deeper = findFirst(e, localName)
    if (deeper) return deeper
  }
  return undefined
}

/** An attribute by local name, whatever prefix (`r:id`, `id`) the writer used. */
function attr(el: Element, localName: string): string | undefined {
  const attrs = el.attributes
  for (let i = 0; i < attrs.length; i++) {
    const a = attrs.item(i)
    if (!a) continue
    if (a.localName === localName || a.name === localName || a.name.endsWith(`:${localName}`)) return a.value
  }
  return undefined
}

/**
 * The text of a rich or plain string: every `<t>` run concatenated, skipping
 * phonetic guides (`<rPh>`), which are hints for East-Asian readings and not
 * part of the value.
 */
function stringItemText(el: Element): string {
  let out = ''
  const walk = (node: Element) => {
    for (let n = node.firstChild; n; n = n.nextSibling) {
      if (n.nodeType !== 1) continue
      const e = n as Element
      if (e.localName === 'rPh') continue
      if (e.localName === 't') out += e.textContent ?? ''
      else walk(e)
    }
  }
  walk(el)
  return out
}

// ---- Relationships ----------------------------------------------------------

interface Relationship {
  id: string
  type: string
  target: string
}

function readRelationships(pkg: Package, partPath: string): Relationship[] {
  const dir = partPath.includes('/') ? partPath.slice(0, partPath.lastIndexOf('/')) : ''
  const file = partPath.slice(dir ? dir.length + 1 : 0)
  const relsPath = `${dir ? `${dir}/` : ''}_rels/${file}.rels`
  const root = pkg.xml(relsPath)
  if (!root) return []
  return childElements(root, 'Relationship').flatMap((r) => {
    const id = attr(r, 'Id')
    const type = attr(r, 'Type')
    const target = attr(r, 'Target')
    if (!id || !type || !target) return []
    if ((attr(r, 'TargetMode') ?? 'Internal').toLowerCase() === 'external') return []
    return [{ id, type, target: resolveTarget(dir, target) }]
  })
}

function relOfType(rels: Relationship[], suffix: string): Relationship | undefined {
  return rels.find((r) => r.type.toLowerCase().endsWith(suffix.toLowerCase()))
}

// ---- Number formats ---------------------------------------------------------

type DateShape = 'date' | 'time' | 'datetime'

/**
 * Excel's built-in date/time formats by id. Ids 27–36 and 50–58 are locale
 * calendars (Japanese, Chinese, Korean, Thai) — all date-only.
 */
const BUILTIN_DATE_FORMATS: Record<number, DateShape> = {
  14: 'date',
  15: 'date',
  16: 'date',
  17: 'date',
  18: 'time',
  19: 'time',
  20: 'time',
  21: 'time',
  22: 'datetime',
  45: 'time',
  46: 'time',
  47: 'time',
}
for (const id of [27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 50, 51, 52, 53, 54, 55, 56, 57, 58]) BUILTIN_DATE_FORMATS[id] = 'date'

/**
 * Classifies a custom format code. Literal text (`"…"`), colour / condition /
 * locale sections (`[Red]`, `[$-409]`) and escaped characters (`\d`) are
 * stripped first so a currency code such as `[$€-1] #,##0.00` is not mistaken
 * for a date because it contains a letter.
 */
export function dateShapeOfFormat(code: string): DateShape | undefined {
  const bare = code
    .replace(/"[^"]*"/g, '')
    .replace(/\[(?!h+\]|m+\]|s+\])[^\]]*\]/gi, '')
    .replace(/\\./g, '')
  const hasTime = /[hs]/i.test(bare) || /AM\/PM|A\/P/i.test(bare)
  const hasDate = /[yd]/i.test(bare) || (/m/i.test(bare) && !hasTime)
  if (hasDate && hasTime) return 'datetime'
  if (hasDate) return 'date'
  if (hasTime) return 'time'
  return undefined
}

/** Cell-style index → date shape, for the styles that render a serial as a date. */
function readDateStyles(pkg: Package, stylesPath: string | undefined): Map<number, DateShape> {
  const shapes = new Map<number, DateShape>()
  const root = stylesPath ? pkg.xml(stylesPath) : undefined
  if (!root) return shapes

  const custom = new Map<number, DateShape>()
  const numFmts = firstChild(root, 'numFmts')
  if (numFmts) {
    for (const f of childElements(numFmts, 'numFmt')) {
      const id = Number(attr(f, 'numFmtId'))
      const shape = dateShapeOfFormat(attr(f, 'formatCode') ?? '')
      if (Number.isInteger(id) && shape) custom.set(id, shape)
    }
  }

  const cellXfs = firstChild(root, 'cellXfs')
  if (cellXfs) {
    childElements(cellXfs, 'xf').forEach((xf, index) => {
      const id = Number(attr(xf, 'numFmtId') ?? '0')
      const shape = custom.get(id) ?? BUILTIN_DATE_FORMATS[id]
      if (shape) shapes.set(index, shape)
    })
  }
  return shapes
}

// ---- Values -----------------------------------------------------------------

const MS_PER_DAY = 86_400_000

/**
 * Excel day serial → calendar fields in UTC. The 1900 system counts from
 * 1899-12-31 and (faithfully to Lotus 1-2-3) believes 1900 was a leap year, so
 * serials from 61 on are one day "late" and count from 1899-12-30 instead.
 * The 1904 system (older Mac workbooks) counts from 1904-01-01.
 */
export function serialToIso(serial: number, shape: DateShape, date1904: boolean): string {
  let epoch: number
  if (date1904) epoch = Date.UTC(1904, 0, 1)
  else if (serial < 61) epoch = Date.UTC(1899, 11, 31)
  else epoch = Date.UTC(1899, 11, 30)
  const d = new Date(epoch + Math.round(serial * MS_PER_DAY))
  const pad = (n: number) => String(n).padStart(2, '0')
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  if (shape === 'date') return date
  // A time format shows only the clock, but a serial of 1 or more still
  // carries a date (an ERP export formatted "mm:ss" is a full timestamp).
  // Keep it: an import can drop a date it does not need, not invent one.
  if (shape === 'time' && serial < 1) return time
  return `${date} ${time}`
}

/** A stored number the way Excel displays it: at most 15 significant digits. */
export function formatNumber(raw: string): string {
  const n = Number(raw)
  if (!Number.isFinite(n)) return raw
  return String(Number(n.toPrecision(15)))
}

/** `B` → 1, `AA` → 26. */
export function columnIndex(ref: string): number | undefined {
  const letters = /^[A-Z]+/i.exec(ref)?.[0]
  if (!letters) return undefined
  let n = 0
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

interface SheetContext {
  sharedStrings: string[]
  dateStyles: Map<number, DateShape>
  date1904: boolean
}

function cellValue(c: Element, ctx: SheetContext): string {
  const type = attr(c, 't') ?? 'n'
  if (type === 'inlineStr') {
    const is = firstChild(c, 'is')
    return is ? stringItemText(is) : ''
  }
  const raw = firstChild(c, 'v')?.textContent ?? ''
  switch (type) {
    case 's': {
      const index = Number(raw)
      return Number.isInteger(index) ? (ctx.sharedStrings[index] ?? '') : ''
    }
    case 'str':
    case 'd':
      return raw
    case 'b':
      return raw.trim() === '1' ? 'TRUE' : 'FALSE'
    case 'e':
      // #N/A, #REF! … — an error is not a value the importer can use.
      return ''
    default: {
      if (raw.trim() === '') return ''
      const styleIndex = Number(attr(c, 's') ?? '-1')
      const shape = ctx.dateStyles.get(styleIndex)
      const n = Number(raw)
      if (shape && Number.isFinite(n)) return serialToIso(n, shape, ctx.date1904)
      return formatNumber(raw)
    }
  }
}

function readSheetRows(root: Element, ctx: SheetContext): string[][] {
  const sheetData = firstChild(root, 'sheetData')
  const rows: string[][] = []
  if (!sheetData) return rows

  let lastRow = -1
  for (const row of childElements(sheetData, 'row')) {
    const declared = Number(attr(row, 'r'))
    const rowIndex = Number.isInteger(declared) && declared >= 1 ? declared - 1 : lastRow + 1
    lastRow = rowIndex
    const cells: string[] = []
    let lastCol = -1
    for (const c of childElements(row, 'c')) {
      const ref = attr(c, 'r')
      const colIndex = (ref ? columnIndex(ref) : undefined) ?? lastCol + 1
      lastCol = colIndex
      const value = cellValue(c, ctx)
      if (value === '') continue
      while (cells.length < colIndex) cells.push('')
      cells[colIndex] = value
    }
    if (cells.length === 0) continue
    while (rows.length < rowIndex) rows.push([])
    rows[rowIndex] = cells
  }
  // Same contract as the CSV parser: rows without any content disappear.
  return rows.filter((r) => r.some((v) => v.trim() !== ''))
}

// ---- Entry point ------------------------------------------------------------

/**
 * Reads every worksheet of an .xlsx file. Throws `WorkbookReadError` with a
 * user-facing message for anything that is not a well-formed workbook.
 */
export function readWorkbook(bytes: Uint8Array): Workbook {
  const pkg = new Package(bytes)

  const rootRels = readRelationships(pkg, '')
  const workbookPath =
    relOfType(rootRels, '/officeDocument')?.target ?? (pkg.has('xl/workbook.xml') ? 'xl/workbook.xml' : undefined)
  const workbook = workbookPath ? pkg.xml(workbookPath) : undefined
  if (!workbookPath || !workbook) {
    throw new WorkbookReadError('That file is a ZIP archive but not an Excel workbook (.xlsx).')
  }

  const rels = readRelationships(pkg, workbookPath)
  const workbookDir = workbookPath.includes('/') ? workbookPath.slice(0, workbookPath.lastIndexOf('/')) : ''

  const sharedStringsPath = relOfType(rels, '/sharedStrings')?.target ?? resolveTarget(workbookDir, 'sharedStrings.xml')
  const sharedStrings: string[] = []
  const sst = pkg.has(sharedStringsPath) ? pkg.xml(sharedStringsPath) : undefined
  if (sst) for (const si of childElements(sst, 'si')) sharedStrings.push(stringItemText(si))

  const stylesPath = relOfType(rels, '/styles')?.target ?? resolveTarget(workbookDir, 'styles.xml')
  const dateStyles = readDateStyles(pkg, pkg.has(stylesPath) ? stylesPath : undefined)

  const date1904 = ['1', 'true'].includes((attr(firstChild(workbook, 'workbookPr') ?? workbook, 'date1904') ?? '').toLowerCase())
  const ctx: SheetContext = { sharedStrings, dateStyles, date1904 }

  const sheetsEl = firstChild(workbook, 'sheets')
  const sheets: WorkbookSheet[] = []
  for (const sheet of sheetsEl ? childElements(sheetsEl, 'sheet') : []) {
    const relId = attr(sheet, 'id')
    const target = rels.find((r) => r.id === relId)?.target
    const root = target ? pkg.xml(target) : undefined
    if (!root) continue
    sheets.push({ name: attr(sheet, 'name') ?? `Sheet ${sheets.length + 1}`, rows: readSheetRows(root, ctx) })
  }
  if (sheets.length === 0) throw new WorkbookReadError('That workbook has no worksheets.')
  return { sheets }
}
