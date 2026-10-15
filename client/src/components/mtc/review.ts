// ============================================================================
// MTC review — the rows Claude read, as the person edits them, and what each
// would do on Save. Pure: the screen renders it, the tests check it.
//
// Each row is compared with the register by its coil number (case ignored):
//   new        not registered: it is added.
//   same       registered with these very values: left alone.
//   different  registered with other values: left alone unless the person
//              ticks Overwrite (then the certificate's values replace the
//              register's, a blank keeping the register's).
//   removed    registered and since removed: Overwrite brings it back.
//   duplicate  the number appears twice in the review: one must go.
// A row with a blocking problem (no number, a bad measurement) stops the save.
// ============================================================================

import {
  MTC_COIL_FIELDS,
  cleanMtcNumber,
  cleanMtcText,
  mtcChangedFields,
  mtcCoilKey,
  mtcCoilOf,
  mtcDuplicateKeys,
  mtcRowProblems,
  type MtcCoil,
  type MtcCoilField,
  type MtcExtractedCoil,
  type MtcProblem,
  type MtcSaveRow,
} from '@qc/shared/mtc'
import type { Coil } from '@qc/shared/types'

/** A row as its inputs hold it: every field as typed. */
export interface ReviewRow {
  /** Stable across edits, for React. */
  id: string
  values: Record<MtcCoilField, string>
  /** Fields Claude was unsure of; a field the person edits is no longer marked. */
  uncertain: MtcCoilField[]
  page?: number
  overwrite: boolean
}

export type ReviewStatus = 'new' | 'same' | 'different' | 'removed' | 'duplicate'

export interface ReviewedRow {
  row: ReviewRow
  coil: MtcCoil
  status: ReviewStatus
  /** The register's coil with this number, when there is one. */
  existing?: MtcCoil
  /** The fields an overwrite would change. */
  changed: MtcCoilField[]
  problems: MtcProblem[]
}

let seq = 0
const nextId = () => `mtc-row-${++seq}`

const show = (v: string | number | undefined): string => (v === undefined ? '' : String(v))

/** The review's rows from what Claude read. */
export function toReviewRows(coils: readonly MtcExtractedCoil[]): ReviewRow[] {
  return coils.map((c) => ({
    id: nextId(),
    values: Object.fromEntries(MTC_COIL_FIELDS.map((f) => [f, show(c[f])])) as Record<MtcCoilField, string>,
    uncertain: [...c.uncertain],
    page: c.page,
    overwrite: false,
  }))
}

/** An empty row, for a coil Claude missed. */
export function blankReviewRow(): ReviewRow {
  return { id: nextId(), values: Object.fromEntries(MTC_COIL_FIELDS.map((f) => [f, ''])) as Record<MtcCoilField, string>, uncertain: [], overwrite: false }
}

/** The row's field edited: the mark of doubt goes, the person has looked. */
export function editReviewRow(row: ReviewRow, field: MtcCoilField, value: string): ReviewRow {
  return { ...row, values: { ...row.values, [field]: value }, uncertain: row.uncertain.filter((f) => f !== field) }
}

const NUMBER_FIELDS = new Set<MtcCoilField>(['thickness', 'width', 'yield'])

/** A typed measurement that is not one: kept as NaN so the checks block it rather than dropping it silently. */
function typedNumber(v: string): number | undefined {
  if (v.trim() === '') return undefined
  return cleanMtcNumber(v) ?? Number.NaN
}

/** The coil a row describes, as it would be saved. */
export function coilOfRow(row: ReviewRow): MtcCoil {
  const coil: MtcCoil = { coilNumber: cleanMtcText(row.values.coilNumber) ?? '' }
  for (const f of MTC_COIL_FIELDS) {
    if (f === 'coilNumber') continue
    const raw = row.values[f]
    const v = NUMBER_FIELDS.has(f) ? typedNumber(raw) : cleanMtcText(raw)
    if (v !== undefined) (coil as unknown as Record<string, unknown>)[f] = v
  }
  return coil
}

/** Every row judged against the register and the rest of the review. */
export function reviewRows(rows: readonly ReviewRow[], existing: readonly Coil[]): ReviewedRow[] {
  const registered = new Map(existing.map((c) => [mtcCoilKey(c.coilNumber), c]))
  const coils = rows.map(coilOfRow)
  const dup = mtcDuplicateKeys(coils)
  return rows.map((row, i) => {
    const coil = coils[i]
    const key = mtcCoilKey(coil.coilNumber)
    const found = key ? registered.get(key) : undefined
    const current = found ? mtcCoilOf(found) : undefined
    const changed = current ? mtcChangedFields(current, coil) : []
    const status: ReviewStatus = dup.has(key) ? 'duplicate' : !found ? 'new' : found.deletedAt ? 'removed' : changed.length === 0 ? 'same' : 'different'
    const problems = mtcRowProblems(coil)
    if (status === 'duplicate') problems.unshift({ field: 'coilNumber', message: 'This coil number is listed more than once. Keep one row.', blocking: true })
    return { row, coil, status, existing: current, changed, problems }
  })
}

export interface ReviewSummary {
  total: number
  added: number
  overwritten: number
  /** Registered and not overwritten, or registered with the same values. */
  kept: number
  /** Registered with other values: each waits for the person's choice. */
  different: number
  blocking: number
  warnings: number
  uncertain: number
}

/** What Save would do, and what stands in its way. */
export function summarise(reviewed: readonly ReviewedRow[]): ReviewSummary {
  const s: ReviewSummary = { total: reviewed.length, added: 0, overwritten: 0, kept: 0, different: 0, blocking: 0, warnings: 0, uncertain: 0 }
  for (const r of reviewed) {
    if (r.problems.some((p) => p.blocking)) s.blocking += 1
    else if (r.problems.length > 0) s.warnings += 1
    if (r.row.uncertain.length > 0) s.uncertain += 1
    if (r.status === 'new') s.added += 1
    else if (r.status === 'different' || r.status === 'removed') {
      s.different += 1
      if (r.row.overwrite) s.overwritten += 1
      else s.kept += 1
    } else if (r.status === 'same') s.kept += 1
  }
  return s
}

/** The rows sent to the API: the coils to add or overwrite, with the choice made for each. Unchanged ones need no trip. */
export function saveRows(reviewed: readonly ReviewedRow[]): MtcSaveRow[] {
  return reviewed.filter((r) => r.status !== 'same').map((r) => ({ ...r.coil, overwrite: r.status === 'new' ? false : r.row.overwrite }))
}
