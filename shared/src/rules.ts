// ============================================================================
// Business rules (§8). Pure functions — no I/O, no framework. Tested directly.
// ============================================================================

import {
  PAINT_WORK_CENTERS,
  PT_WORK_CENTERS,
  type DimensionSource,
  type DimensionStatus,
  type Disposition,
  type GradeMapping,
  type Process,
  type PTVerdict,
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
export function deriveShift(at: Date | string, timeZone?: string): ShiftLetter {
  const d = typeof at === 'string' ? new Date(at) : at
  const h = timeZone ? hourInTimeZone(d, timeZone) : d.getHours()
  if (h >= 8 && h < 16) return 'A'
  if (h >= 16 && h < 19) return 'B'
  return 'C'
}

/**
 * The hour of the day in a named IANA time zone (e.g. "Africa/Cairo").
 *
 * The API runs on Azure in UTC while the factory keeps local time, so the
 * shift has to be judged in the factory's zone, never the server's. No date
 * library is needed: Intl gives the hour directly.
 */
export function hourInTimeZone(d: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).formatToParts(d)
  const hour = parts.find((p) => p.type === 'hour')?.value
  const n = Number(hour)
  return Number.isFinite(n) ? n % 24 : d.getUTCHours()
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
  nominal: number | null | undefined
  tolPlus: number | null | undefined
  tolMinus: number | null | undefined
  actual: number | null | undefined
}): DimensionStatus {
  const { nominal, tolPlus, tolMinus, actual } = input
  if (actual === null || actual === undefined || Number.isNaN(actual)) return 'Pending'
  // A measurement with no specification cannot be judged — it is not a pass.
  if (nominal === null || nominal === undefined || Number.isNaN(nominal)) return 'Pending'
  if (tolPlus === null || tolPlus === undefined || tolMinus === null || tolMinus === undefined)
    return 'Pending'

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

export type WizardStep = 'setup' | 'dimensions' | 'defects' | 'paint' | 'paintThickness' | 'pt' | 'review'

/**
 * The process of a machine that is not in the register, guessed from the
 * legacy work-centre numbers. The register's own `process` always wins.
 */
export function legacyProcessForCode(code: string): Process {
  const c = normaliseWorkCenter(code)
  if ((PAINT_WORK_CENTERS as readonly string[]).includes(c)) return 'paint'
  if ((PT_WORK_CENTERS as readonly string[]).includes(c)) return 'welding'
  return 'forming'
}

/** The process an inspection on a machine follows: the register's, else the legacy guess. */
export function processForMachine(machine: { process?: Process | null } | null | undefined, code: string): Process {
  return machine?.process ?? legacyProcessForCode(code)
}

/**
 * The steps a process gets. An inspector must never see a step that does
 * not apply, nor be able to skip one that does.
 *   forming / other — setup (drawing, coils), dimensions, defects
 *   welding         — setup (drawing, welding wire), dimensions, VT defects, PT
 *   paint           — paint sample photos, three thickness readings (actual
 *                     values only), defects
 */
export function stepsForProcess(process: Process): WizardStep[] {
  switch (process) {
    case 'paint':
      return ['paint', 'paintThickness', 'defects', 'review']
    case 'welding':
      return ['setup', 'dimensions', 'defects', 'pt', 'review']
    default:
      return ['setup', 'dimensions', 'defects', 'review']
  }
}

/** The name a defect outside the machine's configured list is recorded under; its description goes in the notes. */
export const OTHER_DEFECT_NAME = 'Other'

export function isOtherDefect(name: string): boolean {
  return name.trim().toLowerCase() === OTHER_DEFECT_NAME.toLowerCase()
}

/** The dimension name the paint-thickness readings are saved under (§5.5). */
export const PAINT_THICKNESS_NAME = 'Paint thickness'
/** The least thickness readings a paint sample carries; more are added in threes. */
export const PAINT_THICKNESS_READINGS = 3
/** The unit used when no configuration row names one. */
export const PAINT_THICKNESS_UNIT = 'µm'

export function isPaintThicknessName(name: string): boolean {
  return name.trim().toLowerCase() === PAINT_THICKNESS_NAME.toLowerCase()
}

/** The PT record's verdict: Reject / Repair as soon as one tested length is. */
export function ptOverallVerdict(lengths: Array<{ verdict: PTVerdict | null | undefined }>): PTVerdict | null {
  if (lengths.length === 0) return null
  if (lengths.some((l) => !l.verdict)) return null
  return lengths.some((l) => l.verdict === 'Reject / Repair') ? 'Reject / Repair' : 'Accept'
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
  process: Process
  sampleQty: number
  drawing: string
  /** False on a make-to-stock line, where there is no order drawing to pick. Default true. */
  drawingRequired?: boolean
  coils: Array<{ coilNumber: string; grade?: string }>
  defects: Array<{ defectName: string; disposition: Disposition | null; qty: number; notes?: string | null }>
  /** The measurement rows; a paint sample's thickness readings live here. */
  dimensions?: Array<{ name: string; nominal: number | null; actual: number | null }>
  paint?: { imageIds: string[] }
  pt?: {
    testFrequencyPct: number
    consumableLots: Partial<Record<'Cleaner' | 'Penetrant' | 'Developer', string>>
    testedLengths?: Array<{ lengthMm: number; verdict: PTVerdict | null | undefined }>
  }
}

/**
 * Everything that blocks a save, gathered in one pass so the inspector sees all
 * problems at once rather than one per attempt.
 */
export function validateSample(draft: SampleDraftForValidation): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const process = draft.process
  const steps = stepsForProcess(process)

  // A stock item has no order drawing to pick; anything else must name one.
  if (steps.includes('setup') && draft.drawingRequired !== false && !draft.drawing?.trim()) {
    issues.push({ step: 'setup', message: 'Select a drawing.' })
  }
  // §5.7 — the sample quantity is entered last, on the review step.
  if (!(draft.sampleQty > 0)) {
    issues.push({ step: 'review', message: 'Sample quantity must be greater than zero.' })
  }

  for (const c of draft.coils) {
    if (!c.coilNumber?.trim()) {
      issues.push({ step: 'setup', message: 'Every coil needs a coil ID.', ref: 'coil' })
      break
    }
  }

  // §5.4 / §8.5 — no defect saves without a disposition, and say which one.
  // A defect outside the machine's list is recorded as "Other" and must be described.
  for (const d of draft.defects) {
    if (isOtherDefect(d.defectName) && !d.notes?.trim()) {
      issues.push({ step: 'defects', message: 'Describe the "Other" defect.', ref: d.defectName })
    }
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

  // §5.5 — a paint sample: photos first, then three thickness readings.
  if (process === 'paint') {
    if ((draft.paint?.imageIds.length ?? 0) === 0) {
      issues.push({ step: 'paint', message: 'Take at least one photo of the paint sample.' })
    }
    // The readings are recorded as measured: no required value or tolerance
    // is asked for, so no judgement is made on them here.
    const readings = (draft.dimensions ?? []).filter((d) => isPaintThicknessName(d.name))
    if (readings.length < PAINT_THICKNESS_READINGS) {
      issues.push({ step: 'paintThickness', message: `Enter ${PAINT_THICKNESS_READINGS} paint thickness readings.` })
    } else {
      // The first three are required; a reading added beyond them may be
      // left empty, and an empty one is simply not saved.
      readings.slice(0, PAINT_THICKNESS_READINGS).forEach((r, i) => {
        if (r.actual === null || !Number.isFinite(r.actual)) {
          issues.push({ step: 'paintThickness', message: `Reading ${i + 1} is missing.`, ref: `reading-${i + 1}` })
        }
      })
    }
  }

  // §5.6 — PT step rules.
  if (process === 'welding') {
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
      const lengths = pt.testedLengths ?? []
      if (lengths.length === 0) {
        issues.push({ step: 'pt', message: 'Enter at least one tested weld length.', ref: 'testedLengths' })
      }
      lengths.forEach((l, i) => {
        if (!(l.lengthMm > 0)) {
          issues.push({ step: 'pt', message: `Tested length ${i + 1} must be greater than zero.`, ref: `length-${i + 1}` })
        }
        if (!l.verdict) {
          issues.push({ step: 'pt', message: `Choose Accept or Reject / Repair for tested length ${i + 1}.`, ref: `length-${i + 1}` })
        }
      })
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
  source: DimensionSource
}

export interface DimensionOrderRule {
  itemCode: string
  /** Machine the rule is specific to; unset or empty means every machine. */
  workCenterCode?: string | null
  dimensionName: string
  sequence: number
  nominal?: number | null
  tolPlus: number
  tolMinus: number
  unit: string
}

/** Item codes and machine codes are matched without regard to case or
 *  surrounding whitespace — the ERP export is not consistent about either. */
export function normaliseCode(code: string | null | undefined): string {
  return String(code ?? '').trim().toLowerCase()
}

/**
 * Resolve the dimension rows for an item on a machine. First match wins:
 *   1. the item's dimension-order entry specific to this machine
 *   2. the item's dimension-order entry that applies to every machine
 *   3. carry-forward from the previous sample of the same item
 *   4. nothing — the inspector types it
 *
 * A machine-specific entry therefore replaces the general entry of the same
 * dimension name and keeps its own sequence; general entries the machine does
 * not override are still offered.
 *
 * The configuration rarely carries a nominal — the inspector types it on the
 * first sample. A configured row without one takes the nominal the previous
 * sample saved under the same name, so it is typed once per item and machine
 * rather than once per sample. Tolerances stay the configured ones.
 */
export function resolveDimensions(input: {
  itemCode: string
  workCenterCode: string
  order: DimensionOrderRule[]
  previous: Array<{ name: string; nominal: number | null; tolPlus: number | null; tolMinus: number | null; unit: string }>
  /** Optional filter — paint work centers only offer their configured dims. */
  allowedNames?: string[]
}): ResolvedDimension[] {
  const { order, previous, allowedNames } = input
  const itemCode = normaliseCode(input.itemCode)
  const machine = normaliseCode(input.workCenterCode)
  const allow = allowedNames?.length ? new Set(allowedNames.map((n) => n.toLowerCase())) : null
  const out = new Map<string, ResolvedDimension>()

  const add = (r: ResolvedDimension) => {
    const key = r.name.toLowerCase()
    if (out.has(key)) return
    if (allow && !allow.has(key)) return
    out.set(key, r)
  }

  const forItem = order.filter((x) => normaliseCode(x.itemCode) === itemCode)
  const specific = forItem.filter((x) => normaliseCode(x.workCenterCode) !== '' && normaliseCode(x.workCenterCode) === machine)
  const general = forItem.filter((x) => normaliseCode(x.workCenterCode) === '')
  const bySequence = (a: DimensionOrderRule, b: DimensionOrderRule) => a.sequence - b.sequence

  const previousByName = new Map(previous.map((p) => [p.name.trim().toLowerCase(), p]))

  for (const o of [...specific.sort(bySequence), ...general.sort(bySequence)]) {
    const remembered = previousByName.get(o.dimensionName.trim().toLowerCase())
    // A configured nominal wins — unless it is missing or 0, which is how an
    // ERP sheet says "not set": then the nominal the inspector typed on the
    // previous sample is what the next one starts from.
    const configured = o.nominal !== null && o.nominal !== undefined && o.nominal !== 0 ? o.nominal : null
    const rememberedNominal = remembered?.nominal !== null && remembered?.nominal !== undefined ? remembered.nominal : null
    add({
      name: o.dimensionName,
      sequence: o.sequence,
      nominal: configured ?? rememberedNominal ?? o.nominal ?? null,
      tolPlus: o.tolPlus,
      tolMinus: o.tolMinus,
      unit: o.unit,
      source: 'item-order',
    })
  }
  let next = out.size + 1
  for (const p of previous) {
    add({
      name: p.name,
      sequence: next++,
      nominal: p.nominal,
      tolPlus: p.tolPlus ?? 0,
      tolMinus: p.tolMinus ?? 0,
      unit: p.unit,
      source: 'carry-forward',
    })
  }

  // Configured sequence first; ties (a machine row and a general row that
  // share a number) keep the order they were added in, so the machine's wins.
  return Array.from(out.values()).sort((a, b) => a.sequence - b.sequence)
}

// ---- Session colouring -----------------------------------------------------

/**
 * How a session is coloured in the lists. In order of urgency:
 *   hold   — at least one defect is on Hold, waiting for a decision (amber)
 *   defect — the session recorded defects (red)
 *   prior  — no defects here, but the same item of the same order showed
 *            defects on another machine or in an earlier session (grey)
 *   null   — nothing to flag
 */
export type SessionTone = 'hold' | 'defect' | 'prior' | null

export function sessionTone(s: { defectCount?: number; holdCount?: number; priorDefectsElsewhere?: boolean }): SessionTone {
  if ((s.holdCount ?? 0) > 0) return 'hold'
  if ((s.defectCount ?? 0) > 0) return 'defect'
  if (s.priorDefectsElsewhere) return 'prior'
  return null
}

// ---- §14 q2 Permissions ----------------------------------------------------

import type { Role } from './types'

// ---- Make-to-stock machines ------------------------------------------------

/** The order number of every fixed stock line; never an ERP order. */
export const STOCK_ORDER_NUMBER = 'STOCK'

/** The Order ID of the one stock line kept for a make-to-stock machine. */
export function stockLineKey(machineCode: string): string {
  return `STOCK-${machineCode.trim().toUpperCase()}`
}

/** What a make-to-stock machine produces: two items made together, one quantity. */
export interface StockProduction {
  /** Machine code in the register. */
  machineCode: string
  /** The line the sessions are recorded against, as shown on every screen. */
  item: string
  itemCode: string
  /** The items made together; the quantity entered counts one of each. */
  pieces: readonly string[]
}

/**
 * The machines that produce for stock. There is exactly one: the 400-ton
 * press in Factory 3, which makes right and left connectors together — the
 * quantity of one is the quantity of the other, so a session records one
 * number and inspects them as one item. Not configurable on purpose.
 */
export const STOCK_MACHINES: readonly StockProduction[] = [
  { machineCode: '21', item: 'Connector (right + left)', itemCode: 'CONNECTOR-RL', pieces: ['Right connector', 'Left connector'] },
]

/**
 * A machine code as typed in the register, made comparable: Arabic-Indic
 * digits become Western ones, spaces go, and a purely numeric code loses its
 * leading zeros — so "٢١", " 021 " and "21" are the same machine.
 */
export function normaliseMachineCode(code: string | null | undefined): string {
  const western = (code ?? '').replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0))
  const compact = western.replace(/\s+/g, '').toLowerCase()
  return /^\d+$/.test(compact) ? String(Number(compact)) : compact
}

/** The stock production of a machine, or null for a machine that works to order. */
export function stockProductionOf(machineCode: string | null | undefined): StockProduction | null {
  const code = normaliseMachineCode(machineCode)
  if (code === '') return null
  return STOCK_MACHINES.find((m) => normaliseMachineCode(m.machineCode) === code) ?? null
}

/** A machine that produces for stock — sessions on it are started without an order. */
export function isStockMachine(machineCode: string | null | undefined): boolean {
  return stockProductionOf(machineCode) !== null
}

/** A stock line (or a session's order summary of one). */
export function isStockOrder(o: { orderNumber?: string | null } | null | undefined): boolean {
  return (o?.orderNumber ?? '').trim().toUpperCase() === STOCK_ORDER_NUMBER
}

export type Capability =
  | 'record-inspection'
  /** See every inspector's sessions on the board and in History, not only one's own. */
  | 'view-all-sessions'
  | 'edit-open-session'
  | 'edit-closed-session'
  | 'delete-defect'
  /** Mark a session or a sample deleted — administrators only, from History. */
  | 'delete-session'
  | 'delete-sample'
  /** Mark a note about an order deleted — administrators only. */
  | 'delete-note'
  /** The quality dashboard: KPIs, trends, insights — administrators only. */
  | 'view-dashboard'
  | 'override-grade-mismatch'
  | 'manage-admin-data'
  | 'purge-audit-logs'

const CAPABILITIES: Record<Role, Capability[]> = {
  inspector: ['record-inspection', 'edit-open-session'],
  supervisor: [
    'record-inspection',
    'view-all-sessions',
    'edit-open-session',
    'edit-closed-session',
    'delete-defect',
    'override-grade-mismatch',
  ],
  admin: [
    'record-inspection',
    'view-all-sessions',
    'edit-open-session',
    'edit-closed-session',
    'delete-defect',
    'delete-session',
    'delete-sample',
    'delete-note',
    'view-dashboard',
    'override-grade-mismatch',
    'manage-admin-data',
    'purge-audit-logs',
  ],
}

export function can(role: Role | undefined, capability: Capability): boolean {
  if (!role) return false
  return CAPABILITIES[role]?.includes(capability) ?? false
}
