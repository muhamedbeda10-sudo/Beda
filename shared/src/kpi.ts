// ============================================================================
// Quality KPIs (§15). What the dashboard shows is computed from the records
// the floor already writes — sessions, samples, dimensions, defects, coils,
// paint readings, PT lengths and the audit log — never from a second set of
// numbers. The shapes here are the contract between the KPI service and the
// dashboard; the thresholds below colour a figure green, amber or red until
// an administrator sets the factory's own.
// ============================================================================

import type { Disposition, Process, ShiftLetter } from './types'

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
  /** One or more factories, as the machine register names them; none means every factory. */
  factories?: string[]
  /** One or more process groups of the register; none means every process. */
  processes?: Process[]
  /** One or more machine codes: the figures of those machines together. */
  workCenterCodes?: string[]
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
  /** Defect pieces per 100 produced (sessions closed with a final quantity): green at or under, amber at or under, red above. */
  defectRateGreen: number
  defectRateAmber: number
  /** First-pass yield (% of samples with no defect recorded; dimensions have their own measure): green at or above, amber at or above. */
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
  /** Samples an inspector must have recorded in the period before being
   *  ranked. Below it, a single unlucky shift decides a position. */
  minSamplesForRanking: number
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
  minSamplesForRanking: 20,
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
  /** Defect pieces recorded on the period's samples (sum of defect quantities). */
  defectPieces: number
  /** Defect rows recorded. */
  defectRecords: number
  /**
   * Pieces produced: the final quantities of the sessions closed in the
   * period that carry one. Production belongs to a whole session, so with
   * an inspector or shift filter it is 0 and the rate is null.
   */
  piecesProduced: number
  /** Sessions closed in the period with a final quantity. */
  producedSessions: number
  /** Defect pieces of those sessions, over all their samples: the defects of the batch. */
  productionDefectPieces: number
  /** Defect rate: defect pieces per 100 produced; null without production. */
  defectRatePct: number | null
  /** Defect pieces per 100 inspected (the sample view of the same period). */
  inspectedDefectPct: number | null
  /** First-pass yield: samples with no defect recorded, as a % of samples. A failed dimension does not count against it. */
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
  /** Production of the sessions closed that day, and their defect pieces. */
  piecesProduced: number
  productionDefectPieces: number
  /** Defect rate of the production closed that day. */
  defectRatePct: number | null
  /** Defect pieces per 100 inspected that day. */
  inspectedDefectPct: number | null
  fpyPct: number | null
}

/** How many samples fell in each band of defect rate — the shape of the
 *  period, where a single average hides it. */
export interface KpiRateBand {
  band: string
  samples: number
  pieces: number
}

/** The paint thickness readings of one item, as recorded. */
export interface KpiPaintItemRow {
  itemCode: string
  item: string
  readings: number
  meanMicrons: number
  minMicrons: number
  maxMicrons: number
}

/** The Pareto of one machine's defects, shares of that machine's own pieces. */
export interface KpiMachinePareto {
  workCenterCode: string
  label: string
  rows: KpiParetoRow[]
  totalPieces: number
  types: number
}

/** One defect of one item on one machine: what an item is known to suffer. */
export interface KpiItemDefectRow {
  itemCode: string
  item: string
  defectName: string
  workCenterCode: string
  machineLabel: string
  pieces: number
  records: number
  /** Share of this item's defect pieces, %. */
  sharePct: number
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
  /** Production of the sessions closed in the period for this row; null where a
   *  session's production cannot be attributed (an inspector, a shift). */
  piecesProduced: number | null
  productionDefectPieces: number | null
  /** Defect pieces per 100 produced; null where production cannot be attributed. */
  defectRatePct: number | null
  /** Defect pieces per 100 inspected. */
  inspectedDefectPct: number | null
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
  /** A coil is one input of a session, so its rate is of the pieces inspected from it. */
  inspectedDefectPct: number | null
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

/**
 * One calendar month of the selection: production (sessions closed in it with
 * a final quantity) beside what was inspected in it. The rate is defect
 * pieces per 100 produced, as everywhere on the dashboard.
 */
export interface KpiMonthPoint {
  /** YYYY-MM, in the factory's zone. */
  month: string
  samples: number
  pieces: number
  defectPieces: number
  piecesProduced: number
  productionDefectPieces: number
  defectRatePct: number | null
  inspectedDefectPct: number | null
}

/**
 * One defect type of the selection, with how spread it is: on how many
 * distinct factory days it was recorded and on how many distinct order lines.
 * "50 pieces over 10 days on 4 orders" says more than "50 pieces".
 */
export interface KpiDefectDetailRow {
  defectName: string
  pieces: number
  records: number
  days: number
  orders: number
  /** Of every defect piece in the selection. */
  sharePct: number
}

/** A factory's production and defect rate, month by month, for the general page. */
export interface KpiFactoryTrend {
  factory: string
  piecesProduced: number
  productionDefectPieces: number
  defectRatePct: number | null
  months: { month: string; piecesProduced: number; productionDefectPieces: number; defectRatePct: number | null }[]
}

/**
 * The general page: the whole plant over the period, no other filter, with
 * a trend over the last few calendar months ending in the period, so the
 * cards read the same for everyone and the arrow has months to compare.
 */
export interface KpiGeneral {
  /** The period the figures are counted over. */
  from: string
  to: string
  /** The months the trends run over: the last `monthsBack` calendar months ending in `to`'s month. */
  window: KpiRange
  /** How many calendar months the trend covers, the last one included. */
  monthsBack: number
  generatedAt: string
  thresholds: KpiThresholds
  totals: {
    piecesProduced: number
    productionDefectPieces: number
    /** Produced less the defect pieces of the batch. */
    releasedPieces: number
    defectRatePct: number | null
    producedSessions: number
    samples: number
    pieces: number
    defectPieces: number
    inspectedDefectPct: number | null
    machines: number
    factories: number
  }
  months: KpiMonthPoint[]
  factories: KpiFactoryTrend[]
  /** Every machine with production in the span, largest first. */
  machines: KpiMachineTrend[]
}

/** A machine's reject rate month by month, for the general page's overview. */
export interface KpiMachineTrend {
  workCenterCode: string
  label: string
  factory: string
  process: Process
  piecesProduced: number
  productionDefectPieces: number
  defectRatePct: number | null
  months: { month: string; piecesProduced: number; productionDefectPieces: number; defectRatePct: number | null }[]
}

// ---- The drill-down: a factory, a process or a few machines ----------------

export interface KpiBreakdownFilters extends KpiRange {
  factories?: string[]
  processes?: Process[]
  workCenterCodes?: string[]
  itemCode?: string
}

/** One month of the scope: what was made (produced + rejected) and the rate over it. */
export interface KpiBreakdownMonth {
  month: string
  sessions: number
  piecesProduced: number
  productionDefectPieces: number
  /** produced + rejected. */
  made: number
  defectRatePct: number | null
}

/** A defect of the scope with its month-by-month spread. */
export interface KpiBreakdownDefect {
  defectName: string
  pieces: number
  /** Of every rejected piece in the scope. */
  sharePct: number
  months: { month: string; pieces: number; pctOfMade: number | null }[]
}

/** The rejected pieces of one month laid on one order line or one item. */
export interface KpiBreakdownRow {
  month: string
  /** The order line's id, or the item code: unique within the month. */
  key: string
  label: string
  sub?: string
  pieces: number
  /** What the order line (or item) itself made that month: its produced + its rejected. */
  made: number
  /** Of the row's own made pieces, to three decimals: 2 rejected of 305 made is 0.656%. */
  pctOfMade: number | null
  /** Of the month's rejected pieces. */
  shareOfMonthPct: number | null
  /** Of every rejected piece in the period. */
  shareOfPeriodPct: number | null
}

/**
 * First part released, by session: a session whose line had nothing rejected
 * before the release inspection counts as clean; one with any quantity
 * rejected before release does not. 8 clean of 10 sessions is 80%.
 */
export interface KpiFirstPart {
  sessions: number
  clean: number
  pct: number | null
  /** Pieces rejected before release across the sessions that were not clean. */
  rejectedPieces: number
  /**
   * First pass yield, cumulative, as the floor reads it: the pieces rejected
   * before release over the clean sessions plus those pieces. 9 clean sessions
   * and one with 5 rejected: 5 ÷ (9 + 5) = 36%. Lower is better.
   */
  cumulativePct: number | null
  /** Largest first, so the list reads as a Pareto of where the first part fails. */
  byMachine: { workCenterCode: string; label: string; factory: string; sessions: number; clean: number; pct: number | null; rejectedPieces: number }[]
  /** Each machine's pieces rejected before release month by month, largest machine first. */
  byMachineMonth: { workCenterCode: string; label: string; rejectedPieces: number; months: { month: string; sessions: number; clean: number; rejectedPieces: number; cumulativePct: number | null }[] }[]
  months: { month: string; sessions: number; clean: number; pct: number | null; rejectedPieces: number; cumulativePct: number | null }[]
  /** The sessions that were not clean, newest first, the fifty most recent. */
  failed: { sessionId: string; startedAt: string; orderNumber: string; item: string; itemCode: string; workCenterCode: string; machineLabel: string; rejectedBeforeRelease: number; inspectorName: string }[]
}

/** One member of the scope (a factory or a process) month by month, for a line of its own on the trend. */
export interface KpiBreakdownSeries {
  key: string
  label: string
  months: { month: string; made: number; productionDefectPieces: number; defectRatePct: number | null }[]
}

export interface KpiBreakdown {
  filters: KpiBreakdownFilters
  generatedAt: string
  thresholds: KpiThresholds
  months: KpiBreakdownMonth[]
  /** The scope split by factory and by process, each month by month, so each can be a line on the same chart. */
  series: { factories: KpiBreakdownSeries[]; processes: KpiBreakdownSeries[] }
  defects: KpiBreakdownDefect[]
  byOrder: KpiBreakdownRow[]
  byItem: KpiBreakdownRow[]
  firstPart: KpiFirstPart
}

/** How many calendar months the general page shows, the current one included. */
export const GENERAL_MONTHS = 4

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

/** The longest key the server keeps; a rule id and a subject fit with room. */
export const INSIGHT_KEY_MAX = 200

/**
 * What a person hides when they hide an insight: the rule and its subject,
 * so hiding "machine 14 runs hot" does not hide the same rule about another
 * machine, while a changed percentage in the wording hides nothing new.
 */
export function insightKey(i: Pick<KpiInsight, 'id' | 'link'>): string {
  return (i.link ? `${i.id}:${i.link.kind}:${i.link.value}` : i.id).slice(0, INSIGHT_KEY_MAX)
}

/**
 * Several lists on the dashboard are the largest few of something: the top
 * defect types, machines, items, dimensions, suppliers, wire batches, and the
 * oldest Holds. These are how many exist behind each one, so a table can say
 * what it is showing instead of implying it is everything.
 */
export interface KpiListCounts {
  defectTypes: number
  machines: number
  inspectors: number
  shifts: number
  items: number
  suppliers: number
  paintItems: number
  holds: number
}

/** The defect types that did not fit on the Pareto chart, as one figure. */
export interface KpiParetoOthers {
  types: number
  pieces: number
  sharePct: number
}

export interface KpiOverview {
  filters: KpiFilters
  thresholds: KpiThresholds
  generatedAt: string
  /** How many rows exist behind each capped list. */
  counts: KpiListCounts
  /** Present when defect types were left off the Pareto chart. */
  paretoOthers?: KpiParetoOthers
  /** §16 — how the inspectors placed, overall and per factory. */
  inspectorRanking: KpiInspectorRanking
  current: KpiTotals
  previous: KpiTotals
  daily: KpiDailyPoint[]
  /** The period month by month, for a trend the eye can read across a quarter. */
  monthly: KpiMonthPoint[]
  /** Samples by band of defect rate, in band order. */
  defectRateBands: KpiRateBand[]
  pareto: KpiParetoRow[]
  /** Every defect type of the selection with its spread over days and orders. */
  defectDetails: KpiDefectDetailRow[]
  /** The Pareto again, per machine, largest machine first. */
  paretoByMachine: KpiMachinePareto[]
  byMachine: KpiGroupRow[]
  /** The same machines over the comparison period, for a trend per machine. */
  byMachinePrevious: KpiGroupRow[]
  byInspector: KpiGroupRow[]
  byShift: KpiGroupRow[]
  byItem: KpiGroupRow[]
  /** The defects of the items with the most defect pieces. */
  itemDefects: KpiItemDefectRow[]
  /** Coils are consumed by roll forming; only forming samples count here. */
  suppliers: KpiSupplierRow[]
  paintByItem: KpiPaintItemRow[]
  holds: KpiHoldRow[]
  discipline: KpiDiscipline
  insights: KpiInsight[]
}

// ---- Helpers shared by the service and the dashboard -----------------------

export function pct(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 10000) / 100 : null
}

/**
 * The reject rate: rejected pieces per 100 made. A session's final quantity
 * is the good production; the rejected pieces were made on top of it, so
 * the base is produced + rejected, never produced alone.
 */
export function rejectRate(defectPieces: number, produced: number): number | null {
  return pct(defectPieces, produced + defectPieces)
}

/** The same rate as parts per million, the figure a customer audit asks for. */
export function ppm(rate: number | null): number | null {
  return rate === null ? null : Math.round(rate * 10000)
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

// ============================================================================
// §16 — ranking inspectors.
//
// What is deliberately NOT here: the defect rate or the first-pass yield of
// the work an inspector happened to inspect. Ranking on those rewards the
// inspector who finds least, which is the one incentive a quality department
// must never create — and the product's quality is the line's work, not the
// inspector's. What is ranked is the inspection itself:
//
//   Coverage      30%  how much work was actually inspected, per day worked
//   Completeness  35%  how completely each inspection was recorded
//   Accuracy      20%  how rarely the record had to be corrected afterwards
//   Detection     15%  defects found against what peers find on the same machine
//
// Coverage and accuracy are relative — an inspector is measured against the
// others in the same list, because "enough samples a day" has no absolute
// value. Completeness is absolute: a measurement was either recorded or it
// was not. Detection is relative by construction.
// ============================================================================

/** What the database supplies per inspector, before any scoring. */
export interface KpiInspectorRaw {
  inspectorId: string
  name: string
  /** '' for the overall list; the factory name for a per-factory list. */
  factory: string
  samples: number
  pieces: number
  /** Days on which this inspector recorded anything — the fair denominator. */
  activeDays: number
  /** Order lines and machines covered. */
  lines: number
  machines: number
  /** Dimension rows on their samples, and how many carry a measurement. */
  dimensionRows: number
  dimensionsMeasured: number
  /** Coils recorded on their samples, and how many came from the register. */
  coilsUsed: number
  coilsFromRegister: number
  /** Sessions they closed, and how many carry the final quantity. */
  sessionsClosed: number
  sessionsClosedWithFinalQty: number
  /** Sessions they opened that recorded nothing, and were discarded or left empty. */
  emptySessions: number
  sessionsOpened: number
  /** Later corrections to their dimension and defect records. */
  corrections: number
  /** Their samples that had to be recorded again. */
  reRecorded: number
  /** Defect records they raised, and the peer-relative index of that rate:
   *  1 is exactly what others find on the same machines, 2 is twice as much. */
  defectRecords: number
  detectionIndex: number | null
}

export interface KpiInspectorRank extends KpiInspectorRaw {
  /** 1 is first. */
  rank: number
  /** 0–100. */
  score: number
  coverageScore: number
  completenessScore: number
  accuracyScore: number
  detectionScore: number
  /** The parts of completeness, as percentages, or null where not applicable. */
  dimensionCompletionPct: number | null
  coilFromRegisterPct: number | null
  finalQtyPct: number | null
  emptySessionPct: number | null
  samplesPerActiveDay: number
  correctionsPer100Samples: number
  reRecordedPer100Samples: number
}

export interface KpiInspectorGroup {
  /** '' for the list across every factory the filters match. */
  factory: string
  ranked: KpiInspectorRank[]
  /** Too little work in the period to place fairly. Listed, never ranked. */
  unranked: KpiInspectorRank[]
}

export interface KpiInspectorRanking {
  overall: KpiInspectorGroup
  byFactory: KpiInspectorGroup[]
  /** The bar an inspector must clear to be ranked, from the thresholds. */
  minSamples: number
  weights: typeof RANKING_WEIGHTS
}

export const RANKING_WEIGHTS = {
  coverage: 0.3,
  completeness: 0.35,
  accuracy: 0.2,
  detection: 0.15,
} as const

const round1 = (n: number) => Math.round(n * 10) / 10
const clamp = (n: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, n))

/** Where `value` sits between zero and the best in the list, as 0–100. With
 *  one inspector, or with every value equal, everyone scores full: a list of
 *  one has no one to be better than. */
function relative(value: number, best: number): number {
  if (!(best > 0)) return 100
  return clamp((value / best) * 100)
}

/** The mirror of `relative` for a measure where less is better. */
function relativeInverse(value: number, worst: number): number {
  if (!(worst > 0)) return 100
  return clamp(100 - (value / worst) * 100)
}

/** A weighted mean over the parts that apply, with the weight of a part that
 *  does not apply shared among the rest — an inspector who used no coil is
 *  not marked down for the coil register. */
function meanOfApplicable(parts: { value: number | null; weight: number }[]): number {
  let sum = 0
  let weight = 0
  for (const p of parts) {
    if (p.value === null) continue
    sum += p.value * p.weight
    weight += p.weight
  }
  return weight > 0 ? sum / weight : 0
}

/**
 * Score and order one list of inspectors. `minSamples` decides who is ranked
 * at all; those below it are scored the same way but listed apart, because a
 * position won on four samples is noise, not performance.
 */
export function rankInspectors(rows: KpiInspectorRaw[], minSamples: number): KpiInspectorGroup {
  const eligible = rows.filter((r) => r.samples >= minSamples)
  // The yardsticks come from the inspectors being ranked — not from those
  // with too little work, whose rates swing on a single sample.
  const scale = eligible.length > 0 ? eligible : rows
  const bestPerDay = Math.max(0, ...scale.map((r) => (r.activeDays > 0 ? r.samples / r.activeDays : 0)))
  const bestPieces = Math.max(0, ...scale.map((r) => r.pieces))
  const bestLines = Math.max(0, ...scale.map((r) => r.lines))
  const worstCorrections = Math.max(0, ...scale.map((r) => (r.samples > 0 ? (r.corrections / r.samples) * 100 : 0)))
  const worstReRecorded = Math.max(0, ...scale.map((r) => (r.samples > 0 ? (r.reRecorded / r.samples) * 100 : 0)))

  const scored = rows.map((r): KpiInspectorRank => {
    const samplesPerActiveDay = r.activeDays > 0 ? r.samples / r.activeDays : 0
    const correctionsPer100Samples = r.samples > 0 ? (r.corrections / r.samples) * 100 : 0
    const reRecordedPer100Samples = r.samples > 0 ? (r.reRecorded / r.samples) * 100 : 0

    // Coverage — how much of the factory's work this inspector actually saw.
    const coverageScore =
      relative(samplesPerActiveDay, bestPerDay) * 0.5 + relative(r.pieces, bestPieces) * 0.3 + relative(r.lines, bestLines) * 0.2

    // Completeness — whether each inspection was recorded in full.
    const dimensionCompletionPct = r.dimensionRows > 0 ? (r.dimensionsMeasured / r.dimensionRows) * 100 : null
    const coilFromRegisterPct = r.coilsUsed > 0 ? (r.coilsFromRegister / r.coilsUsed) * 100 : null
    const finalQtyPct = r.sessionsClosed > 0 ? (r.sessionsClosedWithFinalQty / r.sessionsClosed) * 100 : null
    const emptySessionPct = r.sessionsOpened > 0 ? (r.emptySessions / r.sessionsOpened) * 100 : null
    const completenessScore = meanOfApplicable([
      { value: dimensionCompletionPct, weight: 0.45 },
      { value: coilFromRegisterPct, weight: 0.25 },
      { value: finalQtyPct, weight: 0.2 },
      { value: emptySessionPct === null ? null : 100 - emptySessionPct, weight: 0.1 },
    ])

    // Accuracy — how rarely someone had to go back and fix the record.
    const accuracyScore =
      relativeInverse(correctionsPer100Samples, worstCorrections) * 0.6 + relativeInverse(reRecordedPer100Samples, worstReRecorded) * 0.4

    // Detection — found against what peers find on the same machines. Parity
    // with peers is 50; twice the peer rate is full marks. An inspector with
    // no peer on any machine they worked has nothing to compare against and
    // sits at parity rather than being rewarded or punished for it.
    const detectionScore = r.detectionIndex === null ? 50 : clamp((Math.min(r.detectionIndex, 2) / 2) * 100)

    const score =
      coverageScore * RANKING_WEIGHTS.coverage +
      completenessScore * RANKING_WEIGHTS.completeness +
      accuracyScore * RANKING_WEIGHTS.accuracy +
      detectionScore * RANKING_WEIGHTS.detection

    return {
      ...r,
      rank: 0,
      score: round1(score),
      coverageScore: round1(coverageScore),
      completenessScore: round1(completenessScore),
      accuracyScore: round1(accuracyScore),
      detectionScore: round1(detectionScore),
      dimensionCompletionPct: dimensionCompletionPct === null ? null : round1(dimensionCompletionPct),
      coilFromRegisterPct: coilFromRegisterPct === null ? null : round1(coilFromRegisterPct),
      finalQtyPct: finalQtyPct === null ? null : round1(finalQtyPct),
      emptySessionPct: emptySessionPct === null ? null : round1(emptySessionPct),
      samplesPerActiveDay: round1(samplesPerActiveDay),
      correctionsPer100Samples: round1(correctionsPer100Samples),
      reRecordedPer100Samples: round1(reRecordedPer100Samples),
    }
  })

  // Highest score first; a tie goes to whoever inspected more, then by name,
  // so the order is the same on every refresh.
  const order = (a: KpiInspectorRank, b: KpiInspectorRank) => b.score - a.score || b.samples - a.samples || a.name.localeCompare(b.name)
  const ranked = scored.filter((r) => r.samples >= minSamples).sort(order)
  ranked.forEach((r, i) => (r.rank = i + 1))
  const unranked = scored.filter((r) => r.samples < minSamples).sort((a, b) => b.samples - a.samples || a.name.localeCompare(b.name))
  return { factory: rows[0]?.factory ?? '', ranked, unranked }
}

// ---- The dashboard board (§15) ----------------------------------------------
// The charts of the dashboard sit on a 12-column grid an administrator can
// rearrange: each widget has a place and a size, one layout per page, the
// same for everyone.

export type DashboardPage = 'general' | 'details'

export interface DashboardLayoutItem {
  /** The widget id, one of DASHBOARD_WIDGETS[page]. */
  i: string
  x: number
  y: number
  w: number
  h: number
}

export type DashboardLayouts = Record<DashboardPage, DashboardLayoutItem[]>

export const DASHBOARD_COLS = 12
/** A row of the grid in pixels; a widget's `h` is a count of these. */
export const DASHBOARD_ROW_HEIGHT = 36
export const DASHBOARD_MAX_H = 80

/** The widgets each page can show, in their default reading order, with a default size. */
export const DASHBOARD_WIDGETS: Record<DashboardPage, { id: string; title: string; w: number; h: number }[]> = {
  general: [
    { id: 'g.trend', title: 'Trend of the pick', w: 12, h: 9 },
    { id: 'g.factoriesByMonth', title: 'Factories by month', w: 6, h: 8 },
    { id: 'g.machinesByMonth', title: 'Machines by month', w: 6, h: 8 },
    { id: 'g.tiles', title: 'Reject rate, PPM, first part', w: 12, h: 5 },
    { id: 'g.pareto', title: 'Pareto of defects', w: 5, h: 9 },
    { id: 'g.defectsByMonth', title: 'Defects by month', w: 7, h: 9 },
    { id: 'g.byOrder', title: 'By order line', w: 6, h: 10 },
    { id: 'g.byItem', title: 'By item', w: 6, h: 10 },
    { id: 'g.firstPartTiles', title: 'First part: yield and months', w: 4, h: 8 },
    { id: 'g.firstPartChart', title: 'First part: machines by month', w: 8, h: 8 },
    { id: 'g.firstPartTable', title: 'First part: sessions not clean', w: 12, h: 9 },
  ],
  details: [
    { id: 'd.tiles', title: 'KPI tiles', w: 12, h: 8 },
    { id: 'd.machines', title: 'Machines', w: 12, h: 9 },
    { id: 'd.monthly', title: 'Month by month', w: 5, h: 8 },
    { id: 'd.defectDetails', title: 'Defect details', w: 7, h: 8 },
    { id: 'd.dailyTrend', title: 'Daily trend', w: 8, h: 8 },
    { id: 'd.dispositions', title: 'Dispositions', w: 4, h: 8 },
    { id: 'd.pareto', title: 'Pareto of defects', w: 8, h: 9 },
    { id: 'd.rateByMachine', title: 'Defect rate by machine', w: 4, h: 9 },
    { id: 'd.byShift', title: 'Defects of inspected by shift', w: 4, h: 8 },
    { id: 'd.byInspector', title: 'Defects of inspected by inspector', w: 4, h: 8 },
    { id: 'd.rateByItem', title: 'Defect rate by item', w: 4, h: 8 },
    { id: 'd.topMachines', title: 'Defects by machine', w: 6, h: 8 },
    { id: 'd.topItems', title: 'Defects by item (top down)', w: 6, h: 8 },
    { id: 'd.rateBands', title: 'Samples by defect rate', w: 4, h: 8 },
    { id: 'd.paintByItem', title: 'Paint thickness by item', w: 8, h: 8 },
    { id: 'd.itemDefects', title: 'Defects by item', w: 12, h: 10 },
    { id: 'd.suppliers', title: 'Defects of inspected by coil supplier', w: 6, h: 9 },
    { id: 'd.holdAgeing', title: 'Hold ageing', w: 6, h: 9 },
    { id: 'd.tableMachine', title: 'By machine (table)', w: 6, h: 10 },
    { id: 'd.tableInspector', title: 'By inspector (table)', w: 6, h: 10 },
    { id: 'd.tableShift', title: 'By shift (table)', w: 6, h: 8 },
    { id: 'd.tableItem', title: 'By item (table)', w: 6, h: 10 },
    { id: 'd.coilSuppliers', title: 'Coil suppliers', w: 6, h: 9 },
    { id: 'd.onHold', title: 'On Hold', w: 6, h: 9 },
    { id: 'd.discipline', title: 'Recording discipline', w: 12, h: 7 },
  ],
}

/** The default layout of a page: the widgets in reading order, packed left to right, row by row. */
export function defaultDashboardLayout(page: DashboardPage): DashboardLayoutItem[] {
  const out: DashboardLayoutItem[] = []
  let x = 0
  let y = 0
  let rowH = 0
  for (const w of DASHBOARD_WIDGETS[page]) {
    if (x + w.w > DASHBOARD_COLS) {
      x = 0
      y += rowH
      rowH = 0
    }
    out.push({ i: w.id, x, y, w: w.w, h: w.h })
    x += w.w
    rowH = Math.max(rowH, w.h)
  }
  return out
}

export function defaultDashboardLayouts(): DashboardLayouts {
  return { general: defaultDashboardLayout('general'), details: defaultDashboardLayout('details') }
}

/**
 * A stored layout brought up to date: unknown widgets dropped, sizes kept
 * within the grid, and widgets the code has since added placed below at
 * their default size, so a layout saved before a widget existed still shows it.
 */
export function normaliseDashboardLayout(page: DashboardPage, stored: unknown): DashboardLayoutItem[] {
  const known = new Map(DASHBOARD_WIDGETS[page].map((w) => [w.id, w]))
  const out: DashboardLayoutItem[] = []
  const seen = new Set<string>()
  const int = (v: unknown, lo: number, hi: number, fallback: number): number => {
    const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback
    return Math.min(hi, Math.max(lo, n))
  }
  if (Array.isArray(stored)) {
    for (const raw of stored) {
      if (!raw || typeof raw !== 'object') continue
      const r = raw as Record<string, unknown>
      const id = typeof r.i === 'string' ? r.i : ''
      const spec = known.get(id)
      if (!spec || seen.has(id)) continue
      const w = int(r.w, 1, DASHBOARD_COLS, spec.w)
      out.push({ i: id, x: int(r.x, 0, DASHBOARD_COLS - w, 0), y: int(r.y, 0, 100000, 0), w, h: int(r.h, 1, DASHBOARD_MAX_H, spec.h) })
      seen.add(id)
    }
  }
  let bottom = out.reduce((n, it) => Math.max(n, it.y + it.h), 0)
  for (const spec of DASHBOARD_WIDGETS[page]) {
    if (seen.has(spec.id)) continue
    out.push({ i: spec.id, x: 0, y: bottom, w: spec.w, h: spec.h })
    bottom += spec.h
  }
  return out
}

export function normaliseDashboardLayouts(stored: unknown): DashboardLayouts {
  const o = stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : {}
  return { general: normaliseDashboardLayout('general', o.general), details: normaliseDashboardLayout('details', o.details) }
}
