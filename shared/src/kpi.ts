// ============================================================================
// Quality KPIs (§15). What the dashboard shows is computed from the records
// the floor already writes — sessions, samples, dimensions, defects, coils,
// paint readings, PT lengths and the audit log — never from a second set of
// numbers. The shapes here are the contract between the KPI service and the
// dashboard; the thresholds below colour a figure green, amber or red until
// an administrator sets the factory's own.
// ============================================================================

import type { Disposition, ShiftLetter } from './types'

// ---- Filters ---------------------------------------------------------------

export interface KpiRange {
  /** Inclusive calendar day, YYYY-MM-DD in the factory's time zone. */
  from: string
  /** Inclusive calendar day. */
  to: string
}

export interface KpiFilters extends KpiRange {
  /** The period the current one is compared with. */
  prevFrom: string
  prevTo: string
  factory?: string
  workCenterCode?: string
  itemCode?: string
  inspectorId?: string
  shift?: ShiftLetter
}

// ---- Thresholds ------------------------------------------------------------

/**
 * The lines between green, amber and red. Rates are percentages, ages are
 * days. An administrator edits them in Configuration; these are the
 * defaults a steel racking line can start from.
 */
export interface KpiThresholds {
  /** Defect pieces per 100 inspected: green at or under, amber at or under, red above. */
  defectRateGreen: number
  defectRateAmber: number
  /** First-pass yield (% of samples with no defect and no failed dimension): green at or above, amber at or above. */
  fpyGreen: number
  fpyAmber: number
  /** Dimensions out of tolerance (% of measured): green at or under, amber at or under. */
  dimFailGreen: number
  dimFailAmber: number
  /** Process capability on a dimension: green at or above, amber at or above. */
  cpkGreen: number
  cpkAmber: number
  /** Readings a dimension needs before Cp/Cpk are worth showing. */
  minReadingsForCpk: number
  /** PT weld lengths rejected (% of tested): green at or under, amber at or under. */
  ptRejectGreen: number
  ptRejectAmber: number
  /** A defect left on Hold this long turns amber, then red. */
  holdAgeAmberDays: number
  holdAgeRedDays: number
  /** A machine with open order lines and no sample for this many days is flagged. */
  idleMachineDays: number
  /** A change worth calling out: current vs previous period, in percent. */
  trendAlertPct: number
}

export const DEFAULT_KPI_THRESHOLDS: KpiThresholds = {
  defectRateGreen: 2,
  defectRateAmber: 5,
  fpyGreen: 95,
  fpyAmber: 85,
  dimFailGreen: 2,
  dimFailAmber: 5,
  cpkGreen: 1.33,
  cpkAmber: 1.0,
  minReadingsForCpk: 20,
  ptRejectGreen: 2,
  ptRejectAmber: 5,
  holdAgeAmberDays: 2,
  holdAgeRedDays: 3,
  idleMachineDays: 3,
  trendAlertPct: 25,
}

export type KpiTone = 'green' | 'amber' | 'red' | 'neutral'

/** Green when low is good (defect rate): at or under green, at or under amber, else red. */
export function toneLowIsGood(value: number | null, green: number, amber: number): KpiTone {
  if (value === null || !Number.isFinite(value)) return 'neutral'
  if (value <= green) return 'green'
  if (value <= amber) return 'amber'
  return 'red'
}

/** Green when high is good (yield, Cpk): at or above green, at or above amber, else red. */
export function toneHighIsGood(value: number | null, green: number, amber: number): KpiTone {
  if (value === null || !Number.isFinite(value)) return 'neutral'
  if (value >= green) return 'green'
  if (value >= amber) return 'amber'
  return 'red'
}

// ---- The overview ----------------------------------------------------------

/** The counts one period yields; the same shape for the current and the previous period. */
export interface KpiTotals {
  sessions: number
  samples: number
  /** Pieces inspected: the sum of sample quantities. */
  pieces: number
  /** Defect pieces recorded (sum of defect quantities). */
  defectPieces: number
  /** Defect rows recorded. */
  defectRecords: number
  /** Defect pieces per 100 inspected pieces; null when nothing was inspected. */
  defectRatePct: number | null
  /** Samples with no defect and no failed dimension, as a % of samples. */
  fpyPct: number | null
  dimensionsMeasured: number
  dimensionsPass: number
  dimensionsWarning: number
  dimensionsFail: number
  /** Failed dimensions as a % of measured. */
  dimFailPct: number | null
  /** Pieces by disposition. */
  byDisposition: Partial<Record<Disposition, number>>
  ptLengthsTested: number
  ptLengthsRejected: number
  ptRejectPct: number | null
  paintReadings: number
  paintMeanMicrons: number | null
  paintMinMicrons: number | null
  activeInspectors: number
  machinesInspected: number
  /** Sessions closed in the period. */
  sessionsClosed: number
  /** Average samples per session started in the period. */
  samplesPerSession: number | null
}

export interface KpiDailyPoint {
  /** Calendar day in the factory's time zone. */
  day: string
  samples: number
  pieces: number
  defectPieces: number
  defectRatePct: number | null
  fpyPct: number | null
}

export interface KpiParetoRow {
  defectName: string
  pieces: number
  records: number
  /** Share of all defect pieces in the period, %. */
  sharePct: number
  /** Running share including this row, %. */
  cumulativePct: number
}

export interface KpiGroupRow {
  key: string
  label: string
  /** Extra context for the label, e.g. the factory of a machine. */
  sub?: string
  sessions: number
  samples: number
  pieces: number
  defectPieces: number
  defectRatePct: number | null
  fpyPct: number | null
  dimFailPct: number | null
}

export interface KpiDimensionRow {
  itemCode: string
  item: string
  name: string
  unit: string
  readings: number
  mean: number
  stdDev: number | null
  nominal: number | null
  tolPlus: number | null
  tolMinus: number | null
  cp: number | null
  cpk: number | null
  passPct: number
  failPct: number
  /** Where the mean sits between the limits: −1 at the lower limit, +1 at the upper, 0 at nominal. */
  centering: number | null
}

export interface KpiSupplierRow {
  supplier: string
  grade: string
  samples: number
  pieces: number
  defectPieces: number
  defectRatePct: number | null
}

export interface KpiWireBatchRow {
  batch: string
  lengthsTested: number
  lengthsRejected: number
  rejectPct: number | null
}

export interface KpiHoldRow {
  defectId: string
  sessionId: string
  sampleId: string
  orderNumber: string
  item: string
  workCenterCode: string
  defectName: string
  qty: number
  ageDays: number
}

export interface KpiIdleMachine {
  workCenterCode: string
  label: string
  factory: string
  openLines: number
  /** Days since the last sample on it, or null when it never had one. */
  daysSinceSample: number | null
}

export interface KpiDiscipline {
  /** Closed in the period without a final quantity. */
  closedWithoutFinalQty: number
  /** Samples re-recorded from History in the period. */
  samplesReRecorded: number
  /** Field corrections on dimensions and defects in the period. */
  corrections: number
  /** Sessions discarded with no sample in the period. */
  sessionsDiscarded: number
  /** Coils typed by hand (not picked from the register), % of coils used. */
  typedCoilPct: number | null
  /** Grade mismatches acknowledged in the period. */
  gradeAcknowledgements: number
  /** Notes written in the period. */
  notes: number
  /** Open sessions right now with no sample. */
  emptyOpenSessions: number
  /** Open order lines with at least one sample in the period, % of open lines. */
  coveragePct: number | null
  openLines: number
  openLinesInspected: number
}

export type KpiInsightSeverity = 'critical' | 'warning' | 'info' | 'good'

export interface KpiInsight {
  id: string
  severity: KpiInsightSeverity
  title: string
  detail: string
  /** What to do about it, when the rule has a recommendation. */
  action?: string
  /** Where to look: a History filter, a machine, an item. */
  link?: { kind: 'history-hold' | 'machine' | 'item' | 'session'; value: string }
}

export interface KpiOverview {
  filters: KpiFilters
  thresholds: KpiThresholds
  generatedAt: string
  current: KpiTotals
  previous: KpiTotals
  daily: KpiDailyPoint[]
  pareto: KpiParetoRow[]
  byMachine: KpiGroupRow[]
  byInspector: KpiGroupRow[]
  byShift: KpiGroupRow[]
  byItem: KpiGroupRow[]
  dimensions: KpiDimensionRow[]
  suppliers: KpiSupplierRow[]
  wireBatches: KpiWireBatchRow[]
  holds: KpiHoldRow[]
  idleMachines: KpiIdleMachine[]
  discipline: KpiDiscipline
  insights: KpiInsight[]
}

// ---- Helpers shared by the service and the dashboard -----------------------

export function pct(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 10000) / 100 : null
}

/** Change from the previous value in percent, null when there was nothing before. */
export function deltaPct(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || !Number.isFinite(previous) || previous === 0) return null
  return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10
}

/**
 * Process capability from a sample of readings against a two-sided
 * tolerance. Cp needs both limits; Cpk the nearer one. Null when the spread
 * is zero or the limits are missing.
 */
export function capability(input: { mean: number; stdDev: number | null; nominal: number | null; tolPlus: number | null; tolMinus: number | null }): {
  cp: number | null
  cpk: number | null
  centering: number | null
} {
  const { mean, stdDev, nominal, tolPlus, tolMinus } = input
  if (nominal === null || tolPlus === null || tolMinus === null) return { cp: null, cpk: null, centering: null }
  const usl = nominal + tolPlus
  const lsl = nominal - tolMinus
  const span = usl - lsl
  const centering = span > 0 ? Math.max(-1, Math.min(1, ((mean - nominal) / (span / 2)) * 1)) : null
  if (stdDev === null || !(stdDev > 0) || span <= 0) return { cp: null, cpk: null, centering }
  const cp = span / (6 * stdDev)
  const cpk = Math.min((usl - mean) / (3 * stdDev), (mean - lsl) / (3 * stdDev))
  return { cp: Math.round(cp * 100) / 100, cpk: Math.round(cpk * 100) / 100, centering }
}
