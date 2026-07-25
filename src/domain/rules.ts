// ============================================================================
// Business rules (§8). Pure functions — no I/O, no framework. Tested directly.
// ============================================================================

import {
  PAINT_WORK_CENTERS,
  PT_WORK_CENTERS,
  type DimensionStatus,
  type Disposition,
  type GradeMapping,
  type ShiftLetter,
  type WorkCenterCode,
} from './types'

// ---- §8.1 Shift derivation -------------------------------------------------

/**
 * Derive the shift from a sample timestamp. Never typed by the inspector.
 *
 *   A  Morning    08:00 – 15:59
 *   B  Afternoon  16:00 – 18:59
 *   C  Night      19:00 – 07:59  (crosses midnight)
 *
 * A sample at 02:00 belongs to the night shift that started the previous
 * evening — hence `shiftStartDate` differs from the calendar date before 08:00.
 */
export function deriveShift(at: Date | string): ShiftLetter {
  const d = typeof at === 'string' ? new Date(at) : at
  const h = d.getHours()
  if (h >= 8 && h < 16) return 'A'
  if (h >= 16 && h < 19) return 'B'
  return 'C'
}

export function shiftName(s: ShiftLetter): string {
  return s === 'A' ? 'Morning' : s === 'B' ? 'Afternoon' : 'Night'
}

/**
 * The date the shift *started*. For the night shift before 08:00 this is the
 * previous calendar day, so a 02:00 sample groups with the evening it began.
 * Returned as YYYY-MM-DD in local time.
 */
export function shiftStartDate(at: Date | string): string {
  const d = new Date(typeof at === 'string' ? new Date(at) : at)
  if (d.getHours() < 8) d.setDate(d.getDate() - 1)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// ---- §8.2 Dimension status -------------------------------------------------

/** Fraction of the tolerance envelope, measured from each limit inward, that
 *  counts as Warning. Confirmed as 10%. */
export const WARNING_BAND = 0.1

/**
 * Compare a measured value against nominal ± tolerance.
 *
 *   Pass     comfortably inside tolerance
 *   Warning  inside tolerance but within the outer 10% of either side
 *   Fail     outside tolerance
 *
 * The warning band is computed per side, because tolerances are often
 * asymmetric (e.g. +0.5 / -0.1) and a shared band would misreport the tight side.
 */
export function dimensionStatus(input: {
  nominal: number
  tolPlus: number
  tolMinus: number
  actual: number | null | undefined
}): DimensionStatus {
  const { nominal, tolPlus, tolMinus, actual } = input
  if (actual === null || actual === undefined || Number.isNaN(actual)) return 'Pending'

  const upper = nominal + Math.abs(tolPlus)
  const lower = nominal - Math.abs(tolMinus)
  if (actual > upper || actual < lower) return 'Fail'

  // Distance to the nearest limit, as a fraction of that side's tolerance.
  if (actual >= nominal) {
    const span = Math.abs(tolPlus)
    if (span === 0) return 'Pass'
    if ((upper - actual) / span <= WARNING_BAND) return 'Warning'
  } else {
    const span = Math.abs(tolMinus)
    if (span === 0) return 'Pass'
    if ((actual - lower) / span <= WARNING_BAND) return 'Warning'
  }
  return 'Pass'
}

// ---- §5.1 Step gating ------------------------------------------------------

export type WizardStep = 'setup' | 'dimensions' | 'defects' | 'paint' | 'pt' | 'review'

/** The steps a work center gets. An inspector must never see a step that does
 *  not apply, nor be able to skip one that does. */
export function stepsForWorkCenter(code: string): WizardStep[] {
  const c = normaliseWorkCenter(code)
  const steps: WizardStep[] = ['setup', 'dimensions', 'defects']
  if ((PAINT_WORK_CENTERS as readonly string[]).includes(c)) steps.push('paint')
  if ((PT_WORK_CENTERS as readonly string[]).includes(c)) steps.push('pt')
  steps.push('review')
  return steps
}

export function isPaintWorkCenter(code: string): boolean {
  return (PAINT_WORK_CENTERS as readonly string[]).includes(normaliseWorkCenter(code))
}
export function isPTWorkCenter(code: string): boolean {
  return (PT_WORK_CENTERS as readonly string[]).includes(normaliseWorkCenter(code))
}

/** Work centers appear as "58", "58-A", "58-A. Welding Line-LM4" — the leading
 *  digits are the code. */
export function normaliseWorkCenter(code: string): WorkCenterCode | string {
  const m = String(code ?? '').trim().match(/^\d+/)
  return m ? m[0] : String(code ?? '').trim()
}

// ---- §8.4 Grade equivalence ------------------------------------------------

/** Normalise before comparing: lowercase, strip spaces, hyphens, underscores, dots. */
export function normaliseGrade(g: string): string {
  return String(g ?? '')
    .toLowerCase()
    .replace(/[\s\-_.]/g, '')
}

/**
 * Build a lookup of grade equivalence classes from mapping pairs.
 * Equivalence is transitive: A≡B and B≡C implies A≡C. Union-find keeps that
 * closure correct however the pairs were entered.
 */
export function buildGradeIndex(mappings: Pick<GradeMapping, 'gradeA' | 'gradeB'>[]): Map<string, string> {
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    let root = x
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root)!
    // path compression
    let cur = x
    while (parent.get(cur) !== undefined && parent.get(cur) !== root) {
      const next = parent.get(cur)!
      parent.set(cur, root)
      cur = next
    }
    return root
  }
  const union = (a: string, b: string) => {
    if (!parent.has(a)) parent.set(a, a)
    if (!parent.has(b)) parent.set(b, b)
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(rb, ra)
  }
  for (const m of mappings) {
    const a = normaliseGrade(m.gradeA)
    const b = normaliseGrade(m.gradeB)
    if (!a || !b) continue
    union(a, b)
  }
  // Resolve every key to its final root.
  const index = new Map<string, string>()
  for (const key of parent.keys()) index.set(key, find(key))
  return index
}

/** Two grades are equivalent if identical after normalisation, or if a mapping
 *  links them directly or transitively. */
export function gradesEquivalent(a: string, b: string, index: Map<string, string>): boolean {
  const na = normaliseGrade(a)
  const nb = normaliseGrade(b)
  if (!na || !nb) return true // nothing to compare against
  if (na === nb) return true
  const ra = index.get(na) ?? na
  const rb = index.get(nb) ?? nb
  return ra === rb
}

export interface GradeMismatch {
  coilNumber: string
  coilGrade: string
}

/** Coils whose grade is not equivalent to the grade expected for the order. */
export function findGradeMismatches(
  expectedGrade: string,
  coils: Array<{ coilNumber: string; grade?: string }>,
  index: Map<string, string>,
): GradeMismatch[] {
  if (!normaliseGrade(expectedGrade)) return []
  return coils
    .filter((c) => normaliseGrade(c.grade ?? '') !== '')
    .filter((c) => !gradesEquivalent(expectedGrade, c.grade!, index))
    .map((c) => ({ coilNumber: c.coilNumber, coilGrade: c.grade! }))
}

// ---- Save-time validation --------------------------------------------------

export interface ValidationIssue {
  step: WizardStep
  message: string
  /** Identifies the offending row so the UI can point at it exactly. */
  ref?: string
}

export interface SampleDraftForValidation {
  workCenterCode: string
  sampleQty: number
  drawing: string
  coils: Array<{ coilNumber: string; grade?: string }>
  defects: Array<{ defectName: string; disposition: Disposition | null; qty: number }>
  pt?: {
    testFrequencyPct: number
    consumableLots: Partial<Record<'Cleaner' | 'Penetrant' | 'Developer', string>>
  }
}

/**
 * Everything that blocks a save, gathered in one pass so the inspector sees all
 * problems at once rather than one per attempt.
 */
export function validateSample(draft: SampleDraftForValidation): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const wc = draft.workCenterCode

  if (!draft.drawing?.trim()) {
    issues.push({ step: 'setup', message: 'Select a drawing.' })
  }
  if (!(draft.sampleQty > 0)) {
    issues.push({ step: 'setup', message: 'Sample quantity must be greater than zero.' })
  }

  // §5.2 — PT/weld work centers require at least one coil.
  if (isPTWorkCenter(wc) && draft.coils.filter((c) => c.coilNumber?.trim()).length === 0) {
    issues.push({
      step: 'setup',
      message: 'At least one coil is required on PT / weld work centers.',
    })
  }
  for (const c of draft.coils) {
    if (!c.coilNumber?.trim()) {
      issues.push({ step: 'setup', message: 'Every coil needs a coil ID.', ref: 'coil' })
      break
    }
  }

  // §5.4 / §8.5 — no defect saves without a disposition, and say which one.
  for (const d of draft.defects) {
    if (!d.disposition) {
      issues.push({
        step: 'defects',
        message: `"${d.defectName}" has no disposition. Choose one before saving.`,
        ref: d.defectName,
      })
    }
    if (!(d.qty > 0)) {
      issues.push({
        step: 'defects',
        message: `"${d.defectName}" needs a quantity greater than zero.`,
        ref: d.defectName,
      })
    }
  }

  // §5.6 — PT step rules.
  if (isPTWorkCenter(wc)) {
    const pt = draft.pt
    if (!pt) {
      issues.push({ step: 'pt', message: 'PT / weld inspection details are required.' })
    } else {
      if (!(pt.testFrequencyPct > 5)) {
        issues.push({
          step: 'pt',
          message: 'Test frequency must be greater than 5%.',
          ref: 'testFrequencyPct',
        })
      }
      for (const kind of ['Cleaner', 'Penetrant', 'Developer'] as const) {
        if (!pt.consumableLots?.[kind]?.trim()) {
          issues.push({
            step: 'pt',
            message: `${kind} lot / batch number is required.`,
            ref: kind,
          })
        }
      }
    }
  }

  return issues
}

// ---- §8.3 Nominal / tolerance resolution -----------------------------------

export interface ResolvedDimension {
  name: string
  sequence: number
  nominal: number | null
  tolPlus: number
  tolMinus: number
  unit: string
  source: 'item-order' | 'item-master' | 'carry-forward' | 'manual'
}

/**
 * Resolve the dimension rows for an item. First match wins:
 *   1. the item's configured dimension order entry (also gives sequence)
 *   2. the item's master dimension record
 *   3. carry-forward from the previous sample of the same item
 *   4. nothing — the inspector types it
 */
export function resolveDimensions(input: {
  item: string
  order: Array<{ item: string; dimensionName: string; sequence: number; nominal?: number; tolPlus: number; tolMinus: number; unit: string }>
  master: Array<{ item: string; dimensionName: string; nominal: number; tolPlus: number; tolMinus: number; unit: string }>
  previous: Array<{ name: string; nominal: number; tolPlus: number; tolMinus: number; unit: string }>
  /** Optional filter — paint work centers only offer their configured dims. */
  allowedNames?: string[]
}): ResolvedDimension[] {
  const { item, order, master, previous, allowedNames } = input
  const allow = allowedNames?.length ? new Set(allowedNames.map((n) => n.toLowerCase())) : null
  const out = new Map<string, ResolvedDimension>()

  const add = (r: ResolvedDimension) => {
    const key = r.name.toLowerCase()
    if (out.has(key)) return
    if (allow && !allow.has(key)) return
    out.set(key, r)
  }

  for (const o of order.filter((x) => x.item === item).sort((a, b) => a.sequence - b.sequence)) {
    add({
      name: o.dimensionName,
      sequence: o.sequence,
      nominal: o.nominal ?? null,
      tolPlus: o.tolPlus,
      tolMinus: o.tolMinus,
      unit: o.unit,
      source: 'item-order',
    })
  }
  let next = out.size + 1
  for (const m of master.filter((x) => x.item === item)) {
    add({
      name: m.dimensionName,
      sequence: next++,
      nominal: m.nominal,
      tolPlus: m.tolPlus,
      tolMinus: m.tolMinus,
      unit: m.unit,
      source: 'item-master',
    })
  }
  for (const p of previous) {
    add({
      name: p.name,
      sequence: next++,
      nominal: p.nominal,
      tolPlus: p.tolPlus,
      tolMinus: p.tolMinus,
      unit: p.unit,
      source: 'carry-forward',
    })
  }

  return Array.from(out.values()).sort((a, b) => a.sequence - b.sequence)
}

// ---- §14 q2 Permissions ----------------------------------------------------

import type { Role } from './types'

export type Capability =
  | 'record-inspection'
  | 'edit-open-session'
  | 'edit-closed-session'
  | 'delete-defect'
  | 'delete-session'
  | 'override-grade-mismatch'
  | 'manage-admin-data'
  | 'purge-audit-logs'

const CAPABILITIES: Record<Role, Capability[]> = {
  inspector: ['record-inspection', 'edit-open-session'],
  supervisor: [
    'record-inspection',
    'edit-open-session',
    'edit-closed-session',
    'delete-defect',
    'delete-session',
    'override-grade-mismatch',
  ],
  admin: [
    'record-inspection',
    'edit-open-session',
    'edit-closed-session',
    'delete-defect',
    'delete-session',
    'override-grade-mismatch',
    'manage-admin-data',
    'purge-audit-logs',
  ],
}

export function can(role: Role | undefined, capability: Capability): boolean {
  if (!role) return false
  return CAPABILITIES[role]?.includes(capability) ?? false
}
