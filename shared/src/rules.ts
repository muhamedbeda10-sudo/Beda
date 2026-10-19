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

// ---- §8.1 Shift derivation and the factory day ---------------------------

/**
 * Derive the shift from a sample timestamp. Never typed by the inspector.
 *
 *   A  Morning    08:00 – 15:59
 *   B  Afternoon  16:00 – 18:59
 *   C  Night      19:00 – 07:59  (crosses midnight)
 *
 * A sample at 02:00 belongs to the night shift that started the previous
 * evening, and so to that evening's factory day (`factoryDay`).
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
 * The hour a factory day starts, factory time. A factory (production) day
 * runs 08:00 → 08:00: the morning shift opens it and the night shift
 * (19:00–08:00) closes it, wholly, so a record at 02:00 on the 20th belongs
 * to the 19th. Every place that counts the record by day — the dashboard's
 * periods and points, History's day filters and exports, PDI, saved reports,
 * the assistant's *_day columns — reads the day this way. The database's own
 * copy of the rule is ai.factory_day (migration 0073): the two must agree.
 */
export const FACTORY_DAY_START_HOUR = 8

/** A moment's wall clock, in a named zone or, without one, where the code runs. */
interface WallClock {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

const wallClockFormats = new Map<string, Intl.DateTimeFormat>()

function wallClock(d: Date, timeZone?: string): WallClock {
  if (!timeZone) {
    return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds() }
  }
  let f = wallClockFormats.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' })
    wallClockFormats.set(timeZone, f)
  }
  const parts = f.formatToParts(d)
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') % 24, minute: get('minute'), second: get('second') }
}

const ymd = (y: number, m: number, d: number): string => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`

/** A YYYY-MM-DD day `n` days from another: whole days, no clock involved. */
function addCalendarDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + n))
  return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate())
}

/**
 * The calendar date of a moment where the factory sits (in `timeZone`, or
 * where the code runs without one), YYYY-MM-DD. For dates people keep — a
 * notice's validity, a task's due date, a document's issue date — never for
 * counting production by day: that is `factoryDay`.
 */
export function calendarDay(at: Date | string, timeZone?: string): string {
  const c = wallClock(typeof at === 'string' ? new Date(at) : at, timeZone)
  return ymd(c.year, c.month, c.day)
}

/**
 * The factory day a moment belongs to, YYYY-MM-DD: its calendar date in the
 * factory's zone (or where the code runs, without one), the day before when
 * it is earlier than FACTORY_DAY_START_HOUR. A sample at 02:00 groups with
 * the evening its night shift began.
 */
export function factoryDay(at: Date | string, timeZone?: string): string {
  const c = wallClock(typeof at === 'string' ? new Date(at) : at, timeZone)
  const day = ymd(c.year, c.month, c.day)
  return c.hour < FACTORY_DAY_START_HOUR ? addCalendarDays(day, -1) : day
}

/** The factory month (YYYY-MM) of a moment: the month of its factory day. */
export function factoryMonth(at: Date | string, timeZone?: string): string {
  return factoryDay(at, timeZone).slice(0, 7)
}

/**
 * The moment a wall-clock time happens in a zone (or where the code runs,
 * without one). A time a change of clocks skips is read with the offset in
 * force before the change; one it repeats, as its first occurrence.
 */
export function zonedInstant(year: number, month: number, day: number, hour = 0, minute = 0, second = 0, ms = 0, timeZone?: string): Date {
  if (!timeZone) return new Date(year, month - 1, day, hour, minute, second, ms)
  const wanted = Date.UTC(year, month - 1, day, hour, minute, second, ms)
  // The zone's offset at a moment: its wall clock there, read as UTC, less the moment (to the whole second).
  const offsetAt = (t: number) => {
    const c = wallClock(new Date(t), timeZone)
    return Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second) - Math.floor(t / 1000) * 1000
  }
  const guess = wanted - offsetAt(wanted)
  return new Date(Math.min(guess, wanted - offsetAt(guess)))
}

/** The moment a factory day (YYYY-MM-DD) starts: FACTORY_DAY_START_HOUR on that date, in the factory's zone. */
export function factoryDayStart(day: string, timeZone?: string): Date {
  const [y, m, d] = day.split('-').map(Number)
  return zonedInstant(y, m, d, FACTORY_DAY_START_HOUR, 0, 0, 0, timeZone)
}

// ---- §8.2 Dimension status -------------------------------------------------

/** Fraction of the tolerance envelope, measured from each limit inward, that
 *  counts as Warning. Confirmed as 10%. */
export const WARNING_BAND = 0.1

/** The warning band as a whole fraction (1/10), so the band is decided exactly too. */
const WARNING_BAND_PARTS = Math.round(1 / WARNING_BAND)

/** The decimals a nominal, a tolerance and a reading are stored with: numeric(14, 4). */
export const DIMENSION_DECIMALS = 4

/**
 * A value as a whole number of 1/10⁴ units, rounded half away from zero at
 * the fourth decimal, exactly as PostgreSQL stores it in numeric(14, 4). Read
 * from the number's shortest decimal form (the text the driver sends), never
 * from its binary approximation: 50.15 is 501500 units, not 501499.99….
 */
export function storedUnits(x: number): number {
  const [mantissa, exponent = '0'] = Math.abs(x).toString().split('e')
  const [whole, fraction = ''] = mantissa.split('.')
  // The figures without the decimal point, and where the point falls among them.
  let figures = whole + fraction
  let point = whole.length + Number(exponent)
  if (point < 0) {
    figures = '0'.repeat(-point) + figures
    point = 0
  }
  figures = figures.padEnd(point + DIMENSION_DECIMALS + 1, '0')
  const kept = Number(figures.slice(0, point + DIMENSION_DECIMALS))
  const units = Number(figures[point + DIMENSION_DECIMALS]) >= 5 ? kept + 1 : kept
  return x < 0 ? -units : units
}

/**
 * Compare a measured value against nominal ± tolerance.
 *
 *   Pass     comfortably inside tolerance
 *   Warning  inside tolerance but within the outer 10% of either side
 *   Fail     outside tolerance
 *
 * The warning band is computed per side, because tolerances are often
 * asymmetric (e.g. +0.5 / -0.1) and a shared band would misreport the tight side.
 *
 * Decided in exact decimals at the stored precision, never in floating
 * point: 50.15 +0.05 has its upper limit at 50.2 exactly, so a reading of
 * 50.2 is in tolerance (Warning, on the limit), and 100 ±0.3 read at 100.27
 * is on the edge of the warning band (Warning). Migration 0073 holds the
 * same rule in SQL, over the stored numerics.
 */
export function dimensionStatus(input: {
  nominal: number | null | undefined
  tolPlus: number | null | undefined
  tolMinus: number | null | undefined
  actual: number | null | undefined
}): DimensionStatus {
  const { nominal, tolPlus, tolMinus, actual } = input
  if (actual === null || actual === undefined || !Number.isFinite(actual)) return 'Pending'
  // A measurement with no specification cannot be judged — it is not a pass.
  if (nominal === null || nominal === undefined || !Number.isFinite(nominal)) return 'Pending'
  if (tolPlus === null || tolPlus === undefined || tolMinus === null || tolMinus === undefined || !Number.isFinite(tolPlus) || !Number.isFinite(tolMinus))
    return 'Pending'

  // Whole 1/10⁴ units: every sum and product below is an exact integer.
  const n = storedUnits(nominal)
  const a = storedUnits(actual)
  const plus = Math.abs(storedUnits(tolPlus))
  const minus = Math.abs(storedUnits(tolMinus))
  const upper = n + plus
  const lower = n - minus
  if (a > upper || a < lower) return 'Fail'

  // In the band when the distance to the nearest limit is at most a tenth of that side's tolerance.
  if (a >= n) {
    if (plus === 0) return 'Pass'
    if ((upper - a) * WARNING_BAND_PARTS <= plus) return 'Warning'
  } else {
    if (minus === 0) return 'Pass'
    if ((a - lower) * WARNING_BAND_PARTS <= minus) return 'Warning'
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
 * Whether a machine's wizard loads the item's configured dimensions. A
 * universal machine never does: the same item is pressed or cut differently
 * from one job to the next, so the inspector types what the part needs, and
 * the next sample of that item on that machine starts from the last one —
 * empty when it was never measured there. Every other machine follows its
 * Configuration switch (on unless turned off).
 */
export function takesConfiguredDimensions(process: Process, machine: { usesItemDimensions?: boolean } | null | undefined): boolean {
  if (process === 'universal') return false
  return machine?.usesItemDimensions !== false
}

/**
 * The steps a process gets. An inspector must never see a step that does
 * not apply, nor be able to skip one that does.
 *   forming / universal — setup (drawing, coils), dimensions, defects
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

/** §5.6 — the share of welds a PT inspection must cover, at the least. */
export const PT_MIN_TEST_FREQUENCY_PCT = 5

/**
 * §5.6 — how many pieces a welding session must have PT-tested: 5% of its
 * final quantity, rounded up to a whole piece so the 5% is met, never
 * undershot. Known once the session is closed with its final quantity.
 */
export function ptRequiredFor(finalQty: number): number {
  if (!Number.isFinite(finalQty) || finalQty <= 0) return 0
  return Math.ceil((finalQty * PT_MIN_TEST_FREQUENCY_PCT) / 100 - 1e-9)
}
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
  /** The machine requires the coil a sample was made from (Machine.coilRequired). Not for welding: its connector coil is. */
  coilRequired?: boolean
  coils: Array<{ coilNumber: string; grade?: string }>
  defects: Array<{ defectName: string; disposition: Disposition | null; qty: number; notes?: string | null }>
  /**
   * The measurement rows; a paint sample's thickness readings live here. A
   * figure is null when left blank; one typed that is not a number (a unit
   * typed after it, a stray letter) arrives as NaN and is refused by name.
   */
  dimensions?: Array<{ name: string; nominal: number | null; actual: number | null; tolPlus?: number | null; tolMinus?: number | null }>
  paint?: { imageIds: string[] }
  pt?: {
    /** Older records typed a frequency by hand; the requirement is now worked out from the final quantity. */
    testFrequencyPct?: number | null
    consumableLots: Partial<Record<'Cleaner' | 'Penetrant' | 'Developer', string>>
    /** The connector coil number, typed on the setup step: required. */
    connectorCoilNumber?: string | null
    testedLengths?: Array<{ lengthMm: number; verdict: PTVerdict | null | undefined }>
  }
}

/** A figure that was typed but is not a number: blank (null) is not this. */
function notANumber(value: number | null | undefined): boolean {
  return value !== null && value !== undefined && !Number.isFinite(value)
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

  // A machine that requires its coil (roll forming, the 400 t press): every sample names at least one.
  if (draft.coilRequired && steps.includes('setup') && process !== 'welding' && !draft.coils.some((c) => c.coilNumber?.trim())) {
    issues.push({ step: 'setup', message: 'Add the coil this sample was made from: this machine requires it.', ref: 'coil' })
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
        if (r.actual === null || r.actual === undefined) {
          issues.push({ step: 'paintThickness', message: `Reading ${i + 1} is missing.`, ref: `reading-${i + 1}` })
        }
      })
    }
    // A reading typed that is not a number would be saved as blank: say which one, required or extra.
    readings.forEach((r, i) => {
      if (notANumber(r.actual)) {
        issues.push({ step: 'paintThickness', message: `Reading ${i + 1} is not a number. Type digits only, e.g. 62.5.`, ref: `reading-${i + 1}` })
      }
    })
  }

  // A nominal, tolerance or actual typed that is not a number would be saved as
  // blank — the row then reads Pending, or passes on screen with no limit at
  // all. Each is refused by the dimension's name and the figure.
  // A paint machine has no Dimensions step: anything else measured there is fixed from the review.
  const dimensionsStep: WizardStep = steps.includes('dimensions') ? 'dimensions' : 'review'
  const rows = draft.dimensions ?? []
  rows.forEach((d, i) => {
    if (process === 'paint' && isPaintThicknessName(d.name)) return
    const figures: Array<[string, number | null | undefined]> = [
      ['nominal', d.nominal],
      ['+ tolerance', d.tolPlus],
      ['− tolerance', d.tolMinus],
      ['actual', d.actual],
    ]
    for (const [figure, value] of figures) {
      if (notANumber(value)) {
        issues.push({ step: dimensionsStep, message: `"${d.name}": the ${figure} is not a number. Type digits only, e.g. 12.5.`, ref: `dimension-${i + 1}` })
      }
    }
  })

  // §5.6 — PT step rules.
  if (process === 'welding') {
    const pt = draft.pt
    if (!pt) {
      issues.push({ step: 'pt', message: 'PT / weld inspection details are required.' })
    } else {
      // The connector coil number is traced on every welding sample, like the coil on a forming one.
      if (!pt.connectorCoilNumber?.trim()) {
        issues.push({ step: 'setup', message: 'Connector coil number is required.', ref: 'connectorCoil' })
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

/**
 * What the ERP writes in a drawing column (DWG1, DWG2) when the column holds
 * no drawing: "(V)", "V", "0", "NA", "X", "-". On such a line the drawing is
 * in the other column. Compared without regard to case or spaces.
 */
const NOT_A_DRAWING = new Set(['', '(v)', 'v', '0', 'na', 'n/a', 'x', '-', '--'])

/** A drawing column's value that names a drawing, not a placeholder. */
export function isDrawing(value: string | null | undefined): value is string {
  return typeof value === 'string' && !NOT_A_DRAWING.has(value.trim().toLowerCase())
}

/**
 * The drawings an order line can be inspected against: its DWG1 and DWG2
 * that name a drawing, in that order, each once, without their outer spaces.
 * The first is the one a new session starts with.
 */
export function orderDrawings(o: { drawing?: string | null; drawingAlt?: string | null } | null | undefined): string[] {
  const out: string[] = []
  for (const value of [o?.drawing, o?.drawingAlt]) {
    if (!isDrawing(value)) continue
    const drawing = value.trim()
    if (!out.includes(drawing)) out.push(drawing)
  }
  return out
}

/**
 * Whether a sample on this line must name its drawing: not on a stock line,
 * and not on a line whose sheet gives none to pick (both columns empty or
 * placeholders) — the inspector could not save it otherwise.
 */
export function drawingRequiredFor(o: { orderNumber?: string | null; drawing?: string | null; drawingAlt?: string | null } | null | undefined): boolean {
  return !isStockOrder(o) && orderDrawings(o).length > 0
}

/** The highest stage an item on a universal machine may be given. */
export const MAX_STAGE = 50

/**
 * What is wrong with an order line as the order sheet gave it, one sentence
 * a problem; empty when nothing is. Such a line is kept and shown — Access
 * marks it so someone corrects the sheet; nothing is hidden or refused.
 *   • an order number of only zeros ("0", "000"): no real order is numbered so
 *   • neither an item name nor an item code: nobody can tell what is made
 */
export function orderLineProblems(line: { orderNumber: string; item: string; itemCode: string }): string[] {
  const out: string[] = []
  if (/^0+$/.test(line.orderNumber.trim())) out.push(`The order number is "${line.orderNumber.trim()}".`)
  if (line.item.trim() === '' && line.itemCode.trim() === '') out.push('The line has neither an item name nor an item code.')
  return out
}

/**
 * What is wrong with the stages a session on a universal machine says it
 * covered, or null. `existing` are the stages the line's other sessions
 * covered. The stages are whole numbers from 1 to MAX_STAGE, each once, each
 * with a quantity of zero or more; and with the line's own they leave no gap —
 * stage 3 comes after a 2, and the first session of a line starts at 1.
 */
export function stagesProblem(existing: readonly number[], picked: readonly { stage: number; qty: number }[]): string | null {
  if (picked.length === 0) return 'Choose the stage, or stages, this session covered.'
  const seen = new Set<number>()
  for (const p of picked) {
    if (!Number.isInteger(p.stage) || p.stage < 1 || p.stage > MAX_STAGE) return `A stage is a whole number from 1 to ${MAX_STAGE}.`
    if (seen.has(p.stage)) return `Stage ${p.stage} is given twice.`
    seen.add(p.stage)
    if (!Number.isFinite(p.qty) || p.qty < 0) return `Enter the quantity of stage ${p.stage}.`
  }
  const all = new Set<number>([...existing, ...seen])
  const top = Math.max(...all)
  for (let k = 1; k <= top; k++) {
    if (!all.has(k)) return `Stage ${k} comes before stage ${top}: give it too, or a lower stage.`
  }
  return null
}

/** The quantity a staged session made: its highest stage's. */
export function topStageQty(stages: readonly { stage: number; qty: number }[]): number {
  return stages.reduce((best, s) => (s.stage > best.stage ? s : best), { stage: 0, qty: 0 }).qty
}
