// ============================================================================
// §25 — Planning over HTTP (/api/planning): what the app asks for and what it
// gets. Times of a plan travel as wall minutes (time.ts), so the app draws
// them on the factory's clock wherever it is opened; instants that happened
// (a session's start, a sync) travel as ISO strings.
// ============================================================================

import type { DurationMeaningResult, ItemRoute, MachineStats, ProcessOrderResult } from './inference'
import type { LineChange, PlanComparison, WeekLoad } from './analysis'
import type {
  CalendarException,
  MachineCapacity,
  MachineRate,
  PlanEvent,
  PlanExclusion,
  PlanOperation,
  PlanOptimisation,
  PlanSettings,
  PlanSummary,
  PlanningProcess,
} from './types'

export type PlanKind = 'auto' | 'plan' | 'scenario'
export type PlanStatus = 'draft' | 'published' | 'superseded' | 'archived'

/** The automatic plan: worked out from the data as it is now, never kept. */
export const AUTO_PLAN_ID = 'auto'

export interface PlanHeader {
  /** A kept plan's id, or AUTO_PLAN_ID. */
  id: string
  kind: PlanKind
  name: string
  description: string
  status: PlanStatus
  /** The plan a scenario was made from (a kept plan's id, or AUTO_PLAN_ID). */
  baseId: string | null
  createdByName: string
  /** Made in the app, or by the AI assistant at someone's word. */
  createdVia: 'app' | 'assistant'
  createdAt: string
  updatedAt: string
  /** When its operations were last worked out. */
  computedAt: string | null
  publishedAt: string | null
  publishedByName: string | null
  version: number
  eventCount: number
  summary: PlanSummary | null
  /** The person may change it: theirs or they may edit plans, and it is not published, superseded or archived. */
  editable: boolean
}

/** A machine as a plan names it. */
export interface PlanMachineInfo {
  key: string
  code: string
  name: string
  factory: string
  process: PlanningProcess | null
  known: boolean
  hoursPerDay: number
  capacitySource: MachineCapacity['source']
}

export interface PlanDetail {
  plan: PlanHeader & { events: PlanEvent[]; settings: Partial<PlanSettings> }
  /** The settings it was worked out with, in full. */
  effectiveSettings: PlanSettings
  /** Wall minutes it was worked out from. */
  now: number
  operations: PlanOperation[]
  excluded: PlanExclusion[]
  warnings: string[]
  machines: PlanMachineInfo[]
  /** What the optimiser did, when the plan was worked out now (not kept with a published plan). */
  optimisation?: PlanOptimisation
}

export interface PlansResponse {
  plans: PlanHeader[]
}

export interface CreatePlanRequest {
  kind: 'plan' | 'scenario'
  name: string
  description?: string
  /** Start from this plan's events and settings (a kept plan's id, or AUTO_PLAN_ID). */
  fromId?: string
  events?: PlanEvent[]
  settings?: Partial<PlanSettings>
}

export interface UpdatePlanRequest {
  version: number
  name?: string
  description?: string
  events?: PlanEvent[]
  settings?: Partial<PlanSettings>
}

export interface PublishPlanRequest {
  version: number
}

export type ComparisonResponse = PlanComparison & { baseName: string; scenarioName: string }
export type { LineChange }

export interface LoadResponse {
  weeks: string[]
  rows: WeekLoad[]
  machines: PlanMachineInfo[]
}

// ---- The floor now ------------------------------------------------------------------

export interface MachineSession {
  sessionId: string
  lineKey: string
  orderNumber: string
  item: string
  customer: string
  startedAt: string
  inspector: string
}

export interface MachineNow {
  key: string
  code: string
  name: string
  factory: string
  process: PlanningProcess | null
  /** Where it stands on its factory's map; null until someone places it. */
  layout: MachineLayout | null
  hoursPerDay: number
  capacitySource: MachineCapacity['source']
  /** Inspection sessions open on it now: what it is making, by the quality record. */
  sessions: MachineSession[]
  /** Its last day on the production record. */
  lastRecord: { workDay: string; shift: string; workers: string[]; producedQty: number; item: string } | null
  /** By the published plan (or the automatic one when none is published): what it should be on now, and next. */
  current: PlanOperation | null
  next: PlanOperation | null
  /** Its queue in the plan: lines, hours, late lines. */
  queueLines: number
  queueHours: number
  lateLines: number
  status: 'running' | 'planned' | 'idle'
}

export interface MachineLayout {
  x: number
  y: number
  w: number
  h: number
}

/** The grid each factory's map is drawn on, in cells. */
export const LAYOUT_COLUMNS = 24
export const LAYOUT_ROWS = 16

export interface FloorResponse {
  /** Wall minutes now. */
  now: number
  factories: string[]
  machines: MachineNow[]
  /** The plan the queues are read from. */
  planId: string
  planName: string
}

export interface SaveLayoutRequest {
  positions: ({ machineKey: string } & MachineLayout)[]
}

// ---- Overview -------------------------------------------------------------------------

export interface OverviewResponse {
  now: number
  auto: PlanSummary
  /** What the optimiser did to the automatic plan. */
  optimisation?: PlanOptimisation
  published: { plan: PlanHeader; summary: PlanSummary } | null
  byProcess: { process: PlanningProcess; lines: number; hours: number; late: number }[]
  lateByCustomer: { customer: string; late: number; lines: number; maxLateDays: number }[]
  /** The factory's load by process, week by week. */
  load: { process: PlanningProcess; week: string; plannedHours: number; capacityHours: number; loadPct: number | null }[]
  machinesRunning: number
  machinesTotal: number
  freshness: Freshness
  /** How many of the data checks found something missing. */
  gaps: number
}

export interface Freshness {
  ordersSyncedAt: string | null
  ordersImportedAt: string | null
  productionImportedAt: string | null
  productionLastWorkDay: string | null
  learntAt: string | null
}

// ---- Plan against actual ----------------------------------------------------------------

export interface ActualRow {
  machineKey: string
  day: string
  plannedQty: number
  plannedHours: number
  actualQty: number
  actualHours: number | null
}

export interface PlanVsActualResponse {
  from: string
  to: string
  /** The published plans the days were read from, with when each was published. */
  plans: { id: string; name: string; publishedAt: string }[]
  rows: ActualRow[]
  machines: (PlanMachineInfo & { plannedQty: number; actualQty: number; adherencePct: number | null })[]
  /** The ERP's own plan against what was made: its lines due to finish in the span. */
  erp: { lines: number; finishedOnPlan: number; late: number }
}

// ---- Material ----------------------------------------------------------------------------

export type MaterialState = 'received' | 'partial' | 'promised-in-time' | 'promised-late' | 'no-promise' | 'no-data'

export interface MaterialRow {
  lineKey: string
  orderNumber: string
  item: string
  customer: string
  machineKey: string
  rawMaterialQty: number | null
  rmReceivedQty: number | null
  rmPromiseDate: string | null
  /** When the automatic plan starts it (wall minutes). */
  plannedStart: number | null
  dueDate: string | null
  state: MaterialState
}

export interface MaterialsResponse {
  rows: MaterialRow[]
  counts: Record<MaterialState, number>
}

// ---- Setup ---------------------------------------------------------------------------------

export interface CapacityRow {
  machine: PlanMachineInfo
  stats: MachineStats | null
  /** Set by someone, if so. */
  set: { hoursPerDay: number; efficiency: number | null; worksFridays: boolean; note: string; updatedByName: string; updatedAt: string } | null
  /** What the plan uses. */
  effective: MachineCapacity
}

export interface CapacityResponse {
  rows: CapacityRow[]
  learntAt: string | null
}

export interface SetCapacityRequest {
  hoursPerDay: number
  /** Planned ÷ actual (1 = standard); null = learn it. */
  efficiency: number | null
  worksFridays: boolean
  note?: string
}

export interface RatesResponse {
  set: (MachineRate & { note: string; updatedByName: string; updatedAt: string })[]
  learnt: MachineRate[]
  learntAt: string | null
}

export interface SetRateRequest {
  machineKey: string
  itemFamily: string
  piecesPerHour: number
  note?: string
}

export interface RoutesResponse {
  routes: ItemRoute[]
  total: number
  processOrder: ProcessOrderResult
  learntAt: string | null
}

export interface CalendarResponse {
  from: string
  to: string
  days: (CalendarException & { updatedByName: string | null })[]
}

export interface SetCalendarDayRequest {
  working: boolean
  name: string
}

export interface SettingsResponse {
  /** What the planners set; the rest is learnt or the defaults. */
  set: Partial<PlanSettings>
  /** To send back with a change. */
  version: number
  effective: PlanSettings
  learnt: { processOrder: ProcessOrderResult | null; erpDuration: DurationMeaningResult | null; learntAt: string | null }
}

export interface SaveSettingsRequest {
  settings: Partial<PlanSettings>
  version: number
}

// ---- Data the plan is missing -------------------------------------------------------------------

export interface DataGap {
  id: string
  area: 'orders' | 'production' | 'machines' | 'calendar' | 'materials' | 'quality'
  title: string
  detail: string
  /** How much of what it counts has the figure (0–100); null for a yes/no check. */
  filledPct: number | null
  /** How many lack it. */
  missing: number
  severity: 'high' | 'medium' | 'low'
  /** What would close it. */
  fix: string
}

export interface DataGapsResponse {
  gaps: DataGap[]
  openLines: number
  freshness: Freshness
}
