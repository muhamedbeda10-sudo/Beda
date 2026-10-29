// ============================================================================
// MTC review — the items Claude read, as the person edits them, and what each
// would do on Save. Pure, and the same for every register (coils, welding
// wire, mesh wire): the register's description says which fields there are
// and which of them identify an item.
//
// Each row is compared with the register by its key (text with case ignored):
//   new        not registered: it is added.
//   same       registered with these very values: left alone.
//   different  registered with other values: left alone unless the person
//              ticks Overwrite (then the certificate's values replace the
//              register's, a blank keeping the register's).
//   removed    registered and since removed: Overwrite brings it back.
//   duplicate  the key appears twice in the review: one must go.
// A row with a blocking problem (no identifier, a bad measurement) stops the save.
// ============================================================================

import {
  cleanMtcNumber,
  cleanMtcText,
  mtcChangedFields,
  mtcDuplicateKeys,
  mtcIdField,
  mtcInputFields,
  mtcKeyOf,
  mtcRowProblems,
  type MtcExtractedRow,
  type MtcProblem,
  type MtcRegister,
  type MtcRegisterRow,
  type MtcSaveRow,
  type MtcValues,
} from '@qc/shared/mtc'

/** A row as its inputs hold it: every field as typed. */
export interface ReviewRow {
  /** Stable across edits, for React. */
  id: string
  values: Record<string, string>
  /** Fields Claude was unsure of; a field the person edits is no longer marked. */
  uncertain: string[]
  page?: number
  overwrite: boolean
}

export type ReviewStatus = 'new' | 'same' | 'different' | 'removed' | 'duplicate'

export interface ReviewedRow {
  row: ReviewRow
  values: MtcValues
  status: ReviewStatus
  /** The register's item with this key, when there is one. */
  existing?: MtcValues
  /** The fields an overwrite would change. */
  changed: string[]
  problems: MtcProblem[]
}

let seq = 0
const nextId = () => `mtc-row-${++seq}`

const show = (v: string | number | undefined): string => (v === undefined ? '' : String(v))

/** The review's rows from what Claude read. */
export function toReviewRows(register: MtcRegister, read: readonly MtcExtractedRow[]): ReviewRow[] {
  return read.map((r) => ({
    id: nextId(),
    values: Object.fromEntries(mtcInputFields(register).map((f) => [f.key, show(r.values[f.key])])),
    uncertain: [...r.uncertain],
    page: r.page,
    overwrite: false,
  }))
}

/** An empty row, for an item Claude missed. */
export function blankReviewRow(register: MtcRegister): ReviewRow {
  return { id: nextId(), values: Object.fromEntries(mtcInputFields(register).map((f) => [f.key, ''])), uncertain: [], overwrite: false }
}

/** The row's field edited: the mark of doubt goes, the person has looked. */
export function editReviewRow(row: ReviewRow, field: string, value: string): ReviewRow {
  return { ...row, values: { ...row.values, [field]: value }, uncertain: row.uncertain.filter((f) => f !== field) }
}

/** The item a row describes, as it would be saved. A typed measurement that is not one is kept as NaN, so the checks block it rather than drop it. */
export function valuesOfRow(register: MtcRegister, row: ReviewRow): MtcValues {
  const out: MtcValues = {}
  for (const f of mtcInputFields(register)) {
    const raw = row.values[f.key] ?? ''
    if (f.type === 'number') {
      if (raw.trim() !== '') out[f.key] = cleanMtcNumber(raw) ?? Number.NaN
    } else {
      const v = cleanMtcText(raw)
      if (v !== undefined) out[f.key] = v
    }
  }
  return out
}

/** Every row judged against the register and the rest of the review. */
export function reviewRows(register: MtcRegister, rows: readonly ReviewRow[], existing: readonly MtcRegisterRow[]): ReviewedRow[] {
  const registered = new Map(existing.map((e) => [mtcKeyOf(register, e.values), e]))
  const all = rows.map((r) => valuesOfRow(register, r))
  const dup = mtcDuplicateKeys(register, all)
  return rows.map((row, i) => {
    const values = all[i]
    const key = mtcKeyOf(register, values)
    const found = key ? registered.get(key) : undefined
    const changed = found ? mtcChangedFields(register, found.values, values) : []
    const status: ReviewStatus = dup.has(key) ? 'duplicate' : !found ? 'new' : found.deletedAt ? 'removed' : changed.length === 0 ? 'same' : 'different'
    const problems = mtcRowProblems(register, values)
    if (status === 'duplicate') problems.unshift({ field: mtcIdField(register).key, message: `Listed more than once. Keep one row.`, blocking: true })
    return { row, values, status, existing: found?.values, changed, problems }
  })
}

export interface ReviewSummary {
  total: number
  added: number
  overwritten: number
  /** Registered and not overwritten, or registered with the same values. */
  kept: number
  /** Registered with other values (or removed): each waits for the person's choice. */
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

/** The rows sent to the API: the items to add or overwrite, with the choice made for each. Unchanged ones need no trip. */
export function saveRows(reviewed: readonly ReviewedRow[]): MtcSaveRow[] {
  return reviewed.filter((r) => r.status !== 'same').map((r) => ({ values: r.values, overwrite: r.status === 'new' ? false : r.row.overwrite }))
}
