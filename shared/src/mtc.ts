// ============================================================================
// MTC — a mill test certificate read into the coil register.
//
// Someone the administrator allowed uploads the mill's PDF; Claude reads it on
// the server and lists every coil in it, with the register's own eight fields
// and nothing more; the person checks that list against the paper, corrects
// it, chooses for each coil already registered whether to overwrite it, and
// saves. The PDF itself is never kept: the certificate's number goes into the
// coil's notes instead.
//
// Everything both sides must agree on lives here: the shapes on the wire, the
// limits, and the checks the review screen shows and the API enforces.
// ============================================================================

import { AI_MAX_PDF_BYTES } from './ai'
import type { ApiErrorCode } from './api'
import type { Coil } from './types'

/** The largest certificate accepted: the same as a PDF given to the assistant. */
export const MTC_MAX_PDF_BYTES = AI_MAX_PDF_BYTES
/** Coils saved in one go: the longest certificates seen hold about a hundred. */
export const MTC_MAX_ROWS = 500
/**
 * The model that reads certificates. The most capable reader of dense and
 * scanned tables: a digit misread in a yield or a coil number costs far more
 * than the difference in price (about half a dollar for a 40-page certificate).
 */
export const MTC_MODEL = 'claude-opus-5-5'

/** What the reader writes as the SM type: hot-rolled black coil, or galvanised. */
export const MTC_SM_TYPES = ['HR', 'GI'] as const
/** The mills' names as the register spells them; any other mill is named by its short name. */
export const MTC_SUPPLIERS = ['Baosteel', 'ArcelorMittal', 'Ezz', 'Tosyali'] as const

/** The register's fields, in its column order. */
export const MTC_COIL_FIELDS = ['coilNumber', 'grade', 'smType', 'supplier', 'thickness', 'width', 'yield', 'notes'] as const
export type MtcCoilField = (typeof MTC_COIL_FIELDS)[number]

export const MTC_FIELD_LABEL: Record<MtcCoilField, string> = {
  coilNumber: 'Coil number',
  grade: 'Grade',
  smType: 'SM type',
  supplier: 'Supplier',
  thickness: 'Thickness',
  width: 'Width',
  yield: 'Yield',
  notes: 'Notes',
}

/** The register's limits, the same as the coil import's. */
export const MTC_TEXT_MAX: Record<'coilNumber' | 'grade' | 'smType' | 'supplier' | 'notes', number> = {
  coilNumber: 120,
  grade: 60,
  smType: 60,
  supplier: 200,
  notes: 1000,
}
/** numeric(10, 3): seven digits before the point. */
export const MTC_NUMBER_MAX = 9_999_999.999

/** A coil as the register holds it: its eight fields. */
export interface MtcCoil {
  coilNumber: string
  grade?: string
  smType?: string
  supplier?: string
  /** mm */
  thickness?: number
  /** mm */
  width?: number
  /** MPa */
  yield?: number
  notes?: string
}

/** A coil as read from the certificate. */
export interface MtcExtractedCoil extends MtcCoil {
  /** The PDF page its row is on, from 1. */
  page?: number
  /** The fields Claude could not read with full confidence, or converted: the review marks them. */
  uncertain: MtcCoilField[]
}

export interface MtcExtractResult {
  fileName: string
  coils: MtcExtractedCoil[]
  /** The document certifies something other than steel coils (wire, welding consumables…): nothing is listed. */
  notCoils: boolean
  /** One sentence for the person when part of the document could not be read, or what it is when it is not a coil certificate. */
  problem?: string
}

/** The events of POST /api/mtc/extract, which streams: reading a long certificate takes minutes. */
export type MtcStreamEvent =
  | { type: 'reading' }
  | { type: 'result'; result: MtcExtractResult }
  | { type: 'error'; code: ApiErrorCode; message: string }

/** POST /api/mtc/existing — the register's rows for these coil numbers, removed ones included. */
export interface MtcExistingRequest {
  coilNumbers: string[]
}
export type MtcExistingResponse = Coil[]

/** One reviewed coil. `overwrite` matters only for a coil already registered: off, it is left as it is. */
export interface MtcSaveRow extends MtcCoil {
  overwrite: boolean
}

export interface MtcSaveRequest {
  /** The certificate's file name, for the audit trail. */
  fileName: string
  rows: MtcSaveRow[]
}

export interface MtcSaveResponse {
  /** Coil numbers, as saved. */
  inserted: string[]
  updated: string[]
  /** Already registered and not overwritten, or overwritten with the same values. */
  skipped: string[]
}

// ---- The coil register's table --------------------------------------------------------

export const COIL_TABLE_SORTS = ['coilNumber', 'newest'] as const
export type CoilTableSort = (typeof COIL_TABLE_SORTS)[number]
export const COIL_TABLE_PAGE = 100
export const COIL_TABLE_PAGE_MAX = 200

export interface CoilTableQuery {
  search?: string
  supplier?: string
  smType?: string
  sort?: CoilTableSort
  offset?: number
  limit?: number
}

export interface CoilTableResponse {
  rows: Coil[]
  /** Every coil the filters match, not only this page. */
  total: number
}

export interface CoilTableOptionsResponse {
  suppliers: string[]
  smTypes: string[]
}

// ---- Checks -----------------------------------------------------------------------------

/** Text as the register keeps it: one line, single spaces, nothing when empty. */
export function cleanMtcText(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.replace(/\s+/g, ' ').trim()
  return t === '' ? undefined : t
}

/** A measurement as the register keeps it: three decimals; nothing for a blank, a non-number or a negative. */
export function cleanMtcNumber(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.').trim())
  if (!Number.isFinite(n) || n < 0) return undefined
  return Math.round(n * 1000) / 1000
}

/** The key two coil numbers are the same coil by: the register's unique key ignores case. */
export const mtcCoilKey = (coilNumber: string): string => coilNumber.trim().toLowerCase()

/** The eight fields of a registered coil, as a reviewed row compares with them. */
export function mtcCoilOf(c: Coil): MtcCoil {
  const out: MtcCoil = { coilNumber: c.coilNumber }
  for (const f of ['grade', 'smType', 'supplier', 'notes'] as const) {
    const v = cleanMtcText(c[f])
    if (v !== undefined) out[f] = v
  }
  for (const f of ['thickness', 'width', 'yield'] as const) {
    const v = cleanMtcNumber(c[f])
    if (v !== undefined) out[f] = v
  }
  return out
}

/**
 * The coil as it would be after an overwrite: the certificate's values, and
 * the register's where the certificate has none (a blank never erases a
 * value, as in the coil import).
 */
export function mtcMerged(existing: MtcCoil, incoming: MtcCoil): MtcCoil {
  const out: MtcCoil = { ...existing, coilNumber: existing.coilNumber }
  for (const f of MTC_COIL_FIELDS) {
    if (f === 'coilNumber') continue
    const v = incoming[f]
    if (v !== undefined) (out as unknown as Record<string, unknown>)[f] = v
  }
  return out
}

/** The fields an overwrite would change, in column order. */
export function mtcChangedFields(existing: MtcCoil, incoming: MtcCoil): MtcCoilField[] {
  const merged = mtcMerged(existing, incoming)
  return MTC_COIL_FIELDS.filter((f) => f !== 'coilNumber' && merged[f] !== existing[f])
}

export interface MtcProblem {
  field: MtcCoilField
  message: string
  /** True: the row cannot be saved as it is. False: worth a second look at the paper. */
  blocking: boolean
}

/** Outside these a value is still saved, but the review asks for a second look: a misread digit lands here. */
export const MTC_PLAUSIBLE = {
  thickness: { min: 0.1, max: 25 },
  width: { min: 10, max: 2500 },
  yield: { min: 100, max: 1500 },
} as const

/** What is wrong with one row, before the batch is considered. */
export function mtcRowProblems(row: MtcCoil): MtcProblem[] {
  const problems: MtcProblem[] = []
  const number = row.coilNumber.trim()
  if (number === '') problems.push({ field: 'coilNumber', message: 'A coil number is required.', blocking: true })
  for (const f of ['coilNumber', 'grade', 'smType', 'supplier', 'notes'] as const) {
    const v = f === 'coilNumber' ? number : row[f]
    if (v && v.length > MTC_TEXT_MAX[f]) problems.push({ field: f, message: `At most ${MTC_TEXT_MAX[f]} characters.`, blocking: true })
  }
  for (const f of ['thickness', 'width', 'yield'] as const) {
    const v = row[f]
    if (v === undefined) continue
    if (!Number.isFinite(v) || v < 0 || v > MTC_NUMBER_MAX) {
      problems.push({ field: f, message: 'Not a valid measurement.', blocking: true })
      continue
    }
    const range = MTC_PLAUSIBLE[f]
    if (v < range.min || v > range.max) {
      const unit = f === 'yield' ? 'MPa' : 'mm'
      problems.push({ field: f, message: `Unusual (${range.min}–${range.max} ${unit} expected): check it.`, blocking: false })
    }
  }
  return problems
}

/** The coil numbers that appear more than once in the batch (by the register's key). */
export function mtcDuplicateKeys(rows: readonly { coilNumber: string }[]): Set<string> {
  const seen = new Set<string>()
  const dup = new Set<string>()
  for (const r of rows) {
    const k = mtcCoilKey(r.coilNumber)
    if (k === '') continue
    if (seen.has(k)) dup.add(k)
    seen.add(k)
  }
  return dup
}
