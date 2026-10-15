// ============================================================================
// MTC — mill test certificates read into the factory's material registers:
// coils, welding wire and mesh wire.
//
// Someone the administrator allowed uploads the supplier's PDF; Claude reads it
// on the server, tells which register it belongs to, and lists every item in
// it with that register's fields and nothing more; the person checks the list
// against the paper, corrects it, chooses for each item already registered
// whether to overwrite it, and saves. The PDF itself is never kept: the
// certificate's number goes into each item's notes instead.
//
// The three registers are described once, here (MTC_REGISTERS): their fields,
// the fields that identify an item, the values a choice field takes, the range
// a measurement is expected in. The API, the reader's instructions and the
// review screen are all driven by these descriptions, so a fourth register is
// a description and a table, not a fourth copy of the code.
// ============================================================================

import { AI_MAX_PDF_BYTES, AI_MAX_SHEET_CHARS } from './ai'
import type { ApiErrorCode } from './api'

/** The largest certificate accepted: the same as a PDF given to the assistant. */
export const MTC_MAX_PDF_BYTES = AI_MAX_PDF_BYTES
/** A certificate photographed page by page: at most this many photos in one reading. */
export const MTC_MAX_IMAGES = 10
/** One photo, as the device sends it after bringing it down to the most Claude reads (Anthropic takes up to 5 MB an image). */
export const MTC_MAX_IMAGE_BYTES = 5 * 1024 * 1024
/** A spreadsheet's text, read on the device: the same room as a sheet given to the assistant. */
export const MTC_MAX_SHEET_CHARS = AI_MAX_SHEET_CHARS
/** What Upload MTC offers to pick: the PDF, photos of its pages, or the mill's spreadsheet. */
export const MTC_ACCEPT = 'application/pdf,.pdf,image/*,.jpg,.jpeg,.png,.webp,.xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
/** Items saved in one go: the longest certificates seen hold about a hundred. */
export const MTC_MAX_ROWS = 500
/** numeric(10, 3): seven digits before the point. */
export const MTC_NUMBER_MAX = 9_999_999.999

export const MTC_KINDS = ['coils', 'welding-wire', 'mesh-wire'] as const
export type MtcKind = (typeof MTC_KINDS)[number]
export const isMtcKind = (v: unknown): v is MtcKind => typeof v === 'string' && (MTC_KINDS as readonly string[]).includes(v)

export interface MtcField {
  key: string
  label: string
  type: 'text' | 'number'
  /** Text: the register's limit, in characters. */
  max?: number
  /** Number: shown after the value's label. */
  unit?: 'mm' | 'MPa' | 'kg'
  /** Number: outside it a value is still saved, but the review asks for a second look (a misread digit lands here). */
  plausible?: { min: number; max: number }
  /** The values the reader writes, and the review suggests; anything else may still be typed. */
  choices?: readonly string[]
  /** Part of what identifies the item: required, and never changed by an overwrite. */
  identifies?: boolean
  /** Upper case without spaces, as grades are written ("S420 MC" is "S420MC"): applied to what the reader returns. */
  compact?: boolean
  /** Shown in a monospace font: an identifier read digit by digit. */
  mono?: boolean
}

export interface MtcRegister {
  kind: MtcKind
  /** The sub-tab's name. */
  label: string
  /** One item, in a sentence: "coil". */
  singular: string
  plural: string
  /** The audit trail's entity. */
  entity: string
  fields: readonly MtcField[]
  /** The choice field the table filters on, beside the supplier. */
  filter: string
}

const TEXT = (key: string, label: string, max: number, extra: Partial<MtcField> = {}): MtcField => ({ key, label, type: 'text', max, ...extra })
const NUMBER = (key: string, label: string, unit: MtcField['unit'], plausible: MtcField['plausible'], extra: Partial<MtcField> = {}): MtcField => ({
  key,
  label,
  type: 'number',
  unit,
  plausible,
  ...extra,
})

/** What the reader writes as a coil's SM type: hot-rolled black coil, or galvanised. */
export const MTC_SM_TYPES = ['HR', 'GI'] as const
export const MTC_WIRE_TYPES = ['Flux-cored', 'Solid'] as const
export const MTC_MESH_PRODUCTS = ['Galvanized', 'Bright'] as const
/** The steel mills' names as the coil register spells them; any other supplier is named by its short name. */
export const MTC_SUPPLIERS = ['Baosteel', 'ArcelorMittal', 'Ezz', 'Tosyali'] as const

export const MTC_REGISTERS: Readonly<Record<MtcKind, MtcRegister>> = {
  coils: {
    kind: 'coils',
    label: 'Coils',
    singular: 'coil',
    plural: 'coils',
    entity: 'Coil',
    filter: 'smType',
    fields: [
      TEXT('coilNumber', 'Coil number', 120, { identifies: true, mono: true }),
      TEXT('grade', 'Grade', 60, { compact: true }),
      TEXT('smType', 'SM type', 60, { choices: MTC_SM_TYPES }),
      TEXT('supplier', 'Supplier', 200),
      NUMBER('thickness', 'Thickness', 'mm', { min: 0.1, max: 25 }),
      NUMBER('width', 'Width', 'mm', { min: 10, max: 2500 }),
      NUMBER('yield', 'Yield', 'MPa', { min: 100, max: 1500 }),
      TEXT('notes', 'Notes', 1000),
    ],
  },
  'welding-wire': {
    kind: 'welding-wire',
    label: 'Welding wire',
    singular: 'welding wire batch',
    plural: 'welding wire batches',
    entity: 'WeldingWire',
    filter: 'wireType',
    fields: [
      TEXT('batchNumber', 'Batch number', 120, { identifies: true, mono: true }),
      TEXT('classification', 'Classification', 60, { compact: true }),
      TEXT('wireType', 'Type', 60, { choices: MTC_WIRE_TYPES }),
      NUMBER('diameter', 'Diameter', 'mm', { min: 0.6, max: 6 }),
      TEXT('supplier', 'Supplier', 200),
      NUMBER('weightKg', 'Weight', 'kg', { min: 1, max: 100_000 }),
      NUMBER('yield', 'Yield', 'MPa', { min: 250, max: 1000 }),
      NUMBER('tensile', 'Tensile', 'MPa', { min: 300, max: 1200 }),
      TEXT('notes', 'Notes', 1000),
    ],
  },
  'mesh-wire': {
    kind: 'mesh-wire',
    label: 'Mesh wire',
    singular: 'mesh wire',
    plural: 'mesh wires',
    entity: 'MeshWire',
    filter: 'product',
    fields: [
      TEXT('castNumber', 'Cast number', 120, { identifies: true, mono: true }),
      NUMBER('diameter', 'Diameter', 'mm', { min: 1, max: 16 }, { identifies: true }),
      TEXT('product', 'Product', 60, { choices: MTC_MESH_PRODUCTS }),
      TEXT('grade', 'Grade', 60, { compact: true }),
      TEXT('supplier', 'Supplier', 200),
      NUMBER('tensile', 'Tensile', 'MPa', { min: 250, max: 1200 }),
      TEXT('notes', 'Notes', 1000),
    ],
  },
}

/** An item's fields: text, a number, or nothing. */
export type MtcValues = Record<string, string | number | undefined>

/** An item as a register holds it. */
export interface MtcRegisterRow {
  id: string
  values: MtcValues
  deletedAt?: string | null
  /** When it was registered (the table's Added column). */
  createdAt?: string
}

/** An item as read from the certificate. */
export interface MtcExtractedRow {
  values: MtcValues
  /** The PDF page its row is on, from 1. */
  page?: number
  /** The fields Claude could not read with full confidence, or converted: the review marks them. */
  uncertain: string[]
}

export interface MtcExtractResult {
  fileName: string
  /** The register the certificate belongs to; null when it is none of them (nothing is listed). */
  kind: MtcKind | null
  rows: MtcExtractedRow[]
  /** One sentence for the person when part of the document could not be read, or what it is when it fits no register. */
  problem?: string
}

/** The events of POST /api/mtc/extract, which streams: reading a long certificate takes minutes. */
export type MtcStreamEvent =
  | { type: 'reading' }
  /** The first reading came back too doubtful: read again on a stronger model (named). */
  | { type: 'rereading'; model: string }
  | { type: 'result'; result: MtcExtractResult }
  | { type: 'error'; code: ApiErrorCode; message: string }

/** POST /api/mtc/:kind/existing — the register's items whose first key field is one of these (removed ones included). */
export interface MtcExistingRequest {
  ids: string[]
}
export type MtcExistingResponse = MtcRegisterRow[]

/** One reviewed item. `overwrite` matters only for an item already registered: off, it is left as it is. */
export interface MtcSaveRow {
  values: MtcValues
  overwrite: boolean
}

/** POST /api/mtc/:kind/save */
export interface MtcSaveRequest {
  /** The certificate's file name, for the audit trail. */
  fileName: string
  rows: MtcSaveRow[]
}

export interface MtcSaveResponse {
  /** Each item by its key, as saved ("213417-506", "62920 · Ø3.9"). */
  inserted: string[]
  updated: string[]
  /** Already registered and not overwritten, or overwritten with the same values. */
  skipped: string[]
}

// ---- A register's table -----------------------------------------------------------------

export const MTC_TABLE_PAGE = 100
export const MTC_TABLE_PAGE_MAX = 200
/** The table's own column beside the register's fields: when the item was registered (sort by it for the newest first). */
export const MTC_ADDED_COLUMN = 'createdAt'

/**
 * GET /api/mtc/:kind/table — the same filters as History: words anywhere,
 * then Excel's filter and sort on each column (`cf`: the column filters as
 * JSON; `sort`: "column:asc|desc"), answered over the whole register.
 * GET /api/mtc/:kind/values takes the same, with `column`.
 */
export interface MtcTableQuery {
  search?: string
  cf?: string
  sort?: string
  offset?: number
  limit?: number
}

export interface MtcTableResponse {
  rows: MtcRegisterRow[]
  /** Every item the filters match, not only this page. */
  total: number
}

/** GET /api/mtc/:kind/options — the table's filter choices, as registered. */
export interface MtcTableOptionsResponse {
  suppliers: string[]
  filterValues: string[]
}

// ---- Values -----------------------------------------------------------------------------

/** Text as a register keeps it: one line, single spaces, nothing when empty. */
export function cleanMtcText(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.replace(/\s+/g, ' ').trim()
  return t === '' ? undefined : t
}

/** A measurement as a register keeps it: three decimals; nothing for a blank, a non-number or a negative. */
export function cleanMtcNumber(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.').trim())
  if (!Number.isFinite(n) || n < 0) return undefined
  return Math.round(n * 1000) / 1000
}

/** One field of an item, cleaned by its kind. */
export function cleanMtcValue(field: MtcField, v: unknown): string | number | undefined {
  return field.type === 'number' ? cleanMtcNumber(v) : cleanMtcText(v)
}

/** An item's fields, every one cleaned; fields the register does not have are dropped. */
export function mtcValuesOf(register: MtcRegister, raw: Record<string, unknown>): MtcValues {
  const out: MtcValues = {}
  for (const f of register.fields) {
    const v = cleanMtcValue(f, raw[f.key])
    if (v !== undefined) out[f.key] = v
  }
  return out
}

export const mtcKeyFields = (register: MtcRegister): MtcField[] => register.fields.filter((f) => f.identifies)
/** The field an item is first looked up by: the register's identifier (coil, batch or cast number). */
export const mtcIdField = (register: MtcRegister): MtcField => register.fields[0]

/**
 * The key two items are the same item by: their key fields, text with case
 * ignored (as the registers' unique indexes do). Empty when a key field is
 * missing: such an item cannot be matched, or saved.
 */
export function mtcKeyOf(register: MtcRegister, values: MtcValues): string {
  const parts: string[] = []
  for (const f of mtcKeyFields(register)) {
    const v = values[f.key]
    if (v === undefined || v === '' || (typeof v === 'number' && !Number.isFinite(v))) return ''
    parts.push(typeof v === 'number' ? String(v) : String(v).trim().toLowerCase())
  }
  return parts.join('|')
}

/** An item named by its key, for people: "62920 · Ø3.9 mm". */
export function mtcKeyLabel(register: MtcRegister, values: MtcValues): string {
  return mtcKeyFields(register)
    .map((f) => {
      const v = values[f.key]
      if (v === undefined) return '—'
      return f.type === 'number' ? `${f.key === 'diameter' ? 'Ø' : ''}${v}${f.unit ? ` ${f.unit}` : ''}` : String(v)
    })
    .join(' · ')
}

/**
 * The item as it would be after an overwrite: the certificate's values, and
 * the register's where the certificate has none (a blank never erases a
 * value). Key fields never change.
 */
export function mtcMerged(register: MtcRegister, existing: MtcValues, incoming: MtcValues): MtcValues {
  const out: MtcValues = { ...existing }
  for (const f of register.fields) {
    if (f.identifies) continue
    const v = incoming[f.key]
    if (v !== undefined) out[f.key] = v
  }
  return out
}

/** The fields an overwrite would change, in column order. */
export function mtcChangedFields(register: MtcRegister, existing: MtcValues, incoming: MtcValues): string[] {
  const merged = mtcMerged(register, existing, incoming)
  return register.fields.filter((f) => !f.identifies && merged[f.key] !== existing[f.key]).map((f) => f.key)
}

export interface MtcProblem {
  field: string
  message: string
  /** True: the row cannot be saved as it is. False: worth a second look at the paper. */
  blocking: boolean
}

/**
 * What is wrong with one item, before the batch is considered. A number that
 * is not one arrives as NaN (the review keeps what was typed): it blocks.
 */
export function mtcRowProblems(register: MtcRegister, values: MtcValues): MtcProblem[] {
  const problems: MtcProblem[] = []
  for (const f of register.fields) {
    const v = values[f.key]
    if (v === undefined || v === '') {
      if (f.identifies) problems.push({ field: f.key, message: `${f.label} is required.`, blocking: true })
      continue
    }
    if (f.type === 'text') {
      if (typeof v !== 'string') problems.push({ field: f.key, message: 'Not valid text.', blocking: true })
      else if (f.max !== undefined && v.length > f.max) problems.push({ field: f.key, message: `At most ${f.max} characters.`, blocking: true })
      continue
    }
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > MTC_NUMBER_MAX) {
      problems.push({ field: f.key, message: 'Not a valid measurement.', blocking: true })
      continue
    }
    if (f.identifies && v === 0) {
      problems.push({ field: f.key, message: `${f.label} is required.`, blocking: true })
      continue
    }
    const range = f.plausible
    if (range && (v < range.min || v > range.max)) {
      const unit = f.unit ? ` ${f.unit}` : ''
      problems.push({ field: f.key, message: `Unusual (${range.min}–${range.max}${unit} expected): check it.`, blocking: false })
    }
  }
  return problems
}

/**
 * How doubtful a reading is: the share of its values Claude marked unsure,
 * the notes left out (a certificate with no number is no doubt). Nothing
 * listed is wholly doubtful.
 */
export function mtcDoubtShare(register: MtcRegister, rows: readonly { uncertain: readonly string[] }[]): number {
  const fields = register.fields.filter((f) => f.key !== 'notes').map((f) => f.key)
  if (rows.length === 0 || fields.length === 0) return 1
  const unsure = rows.reduce((n, r) => n + r.uncertain.filter((u) => fields.includes(u)).length, 0)
  return unsure / (rows.length * fields.length)
}

/** The keys that appear more than once in the batch. */
export function mtcDuplicateKeys(register: MtcRegister, rows: readonly MtcValues[]): Set<string> {
  const seen = new Set<string>()
  const dup = new Set<string>()
  for (const r of rows) {
    const k = mtcKeyOf(register, r)
    if (k === '') continue
    if (seen.has(k)) dup.add(k)
    seen.add(k)
  }
  return dup
}
