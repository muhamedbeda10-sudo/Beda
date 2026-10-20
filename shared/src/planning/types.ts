// ============================================================================
// §25 — Planning: the shapes the planning engine reads and writes, shared by
// the API (which loads them from the factory's record and keeps what it
// computes) and the app (which draws them). A trial module: it reads the
// order sheet, the production record and the inspections, and writes only
// its own tables — nothing it does changes an order, a record or a session.
//
// Time inside the engine is the factory's wall clock in whole minutes since
// 1970-01-01 00:00 ("wall minutes"): a working day, a shift and a holiday are
// all wall-clock ideas, and a change of clocks moves nothing a planner sees.
// The API turns wall minutes into instants at the edge (time.ts).
// ============================================================================

/** The machine's process, as the register keeps it (machines.process). */
export type PlanningProcess = 'forming' | 'welding' | 'paint' | 'universal' | 'mast' | 'other'
export const PLANNING_PROCESSES: readonly PlanningProcess[] = ['forming', 'universal', 'mast', 'welding', 'paint', 'other']
export const isPlanningProcess = (v: unknown): v is PlanningProcess => typeof v === 'string' && (PLANNING_PROCESSES as readonly string[]).includes(v)

export const PROCESS_NAMES: Record<PlanningProcess, string> = {
  forming: 'Roll forming',
  universal: 'Universal',
  mast: 'Mast',
  welding: 'Welding',
  paint: 'Painting',
  other: 'Other',
}

/** A machine as the engine sees it: keyed by ai.machine_key(code), so "024" and "24" are one machine. */
export interface PlanMachine {
  key: string
  code: string
  name: string
  factory: string
  process: PlanningProcess | null
  /** The register has it; a line may name a machine the register does not. */
  known: boolean
}

/** One open order line to plan: one item of an order on one machine (production_orders). */
export interface PlanLine {
  /** production_orders.id, or the event's own id for an order a scenario adds. */
  id: string
  lineKey: string
  orderNumber: string
  itemCode: string
  item: string
  itemFamily: string | null
  customer: string
  machineKey: string
  requiredQty: number
  /** What is left to make. */
  remainingQty: number
  /** The whole line's weight, kg (the ERP's). */
  weightKg: number | null
  /** The ERP's part duration in hours (Part Dur (Hr)); erpDurationMeaning says whether it is the line's or one piece's. */
  erpHours: number | null
  /** Days, YYYY-MM-DD. */
  dueDate: string | null
  plannedStart: string | null
  plannedFinish: string | null
  orderDate: string | null
  erpStatus: string
  /** The ERP holds the line. */
  hold: boolean
  parentId: string | null
  modelGroupId: string | null
  rawMaterialQty: number | null
  rmReceivedQty: number | null
  rmPromiseDate: string | null
  /** An inspection session is open on the line now: when it started (wall minutes). */
  runningSince: number | null
  /** Added by a scenario, not on the order sheet. */
  hypothetical?: boolean
}

/** A day of the factory's calendar that is not as the week would have it: a holiday, or a Friday worked. */
export interface CalendarException {
  day: string
  working: boolean
  name: string
}

/** What a machine can give in a day, as the engine uses it. */
export interface MachineCapacity {
  machineKey: string
  /** Hours of work in a working factory day (from 08:00). */
  hoursPerDay: number
  /** Planned ÷ actual hours on the machine (1 = works at the ERP's standard); ERP durations are divided by it. */
  efficiency: number
  /** Works on Fridays as a rule. */
  worksFridays: boolean
  source: 'set' | 'inferred' | 'default'
}

/** Pieces an hour a machine makes of an item (or a family, or anything), learnt or set. */
export interface MachineRate {
  machineKey: string
  /** '' = any item of the machine. */
  itemCode: string
  /** '' = any family. */
  itemFamily: string
  piecesPerHour: number
  samples: number
  source: 'set' | 'inferred'
}

// ---- Settings ---------------------------------------------------------------------

export type SequenceRule = 'erp' | 'due' | 'fifo'
export type TimeSource = 'erp-first' | 'actual-first'
/** What the ERP's part duration covers. */
export type ErpDurationMeaning = 'line' | 'piece'

export interface PlanSettings {
  /** The order lines run on a machine: the ERP's planned start, the due date, or the order date. */
  sequenceRule: SequenceRule
  /** Where a line's hours come from first: the ERP's duration, or the machine's own record of what it made. */
  timeSource: TimeSource
  /** What the ERP's part duration covers; learnt from the record when it can be. */
  erpDurationMeaning: ErpDurationMeaning
  /** Divide the ERP's hours by the machine's efficiency. */
  applyEfficiency: boolean
  /** How much of an earlier stage's run a later one may overlap: 0 = it waits until the earlier has finished, 50 = it starts once the earlier is half done. */
  overlapPct: number
  /** A later stage finishes at least this long after the earlier one. */
  finishLagMinutes: number
  /** Plan the lines the ERP holds. */
  includeHold: boolean
  /** A line waits for its raw material's promise day when it has not been received. */
  materialGate: boolean
  /** A machine with no capacity set or learnt works this many hours a day. */
  defaultHoursPerDay: number
  /** A line with no time to go by takes this long. */
  defaultLineHours: number
  /** Which lines wait for which. */
  dependencies: { parent: boolean; sameItem: boolean; orderProcess: boolean }
  /** The order processes follow (lower first): learnt from the record when it can be. */
  processRank: Record<PlanningProcess, number>
  /** The day after which nothing is placed: a machine with no capacity in it leaves its lines unplaced. */
  horizonDays: number
  /** How hard the optimiser tries to better the priority order (optimise.ts): not at all, lightly, or in full. */
  optimise: OptimiseEffort
  /** What the optimiser makes smaller. */
  objective: PlanObjective
}

export type OptimiseEffort = 'off' | 'light' | 'full'
/** late-weight-days: days late × tonnes, then late lines; late-lines: late lines, then days late; late-days: days late, then late lines. */
export type PlanObjective = 'late-weight-days' | 'late-lines' | 'late-days'
export const PLAN_OBJECTIVES: readonly PlanObjective[] = ['late-weight-days', 'late-lines', 'late-days']
export const OPTIMISE_EFFORTS: readonly OptimiseEffort[] = ['off', 'light', 'full']

export const DEFAULT_PROCESS_RANK: Record<PlanningProcess, number> = { forming: 1, universal: 1, mast: 1, welding: 2, other: 2, paint: 3 }

export const DEFAULT_PLAN_SETTINGS: PlanSettings = {
  sequenceRule: 'erp',
  timeSource: 'erp-first',
  erpDurationMeaning: 'line',
  applyEfficiency: false,
  overlapPct: 50,
  finishLagMinutes: 60,
  includeHold: false,
  materialGate: true,
  defaultHoursPerDay: 16,
  defaultLineHours: 8,
  dependencies: { parent: true, sameItem: true, orderProcess: false },
  processRank: DEFAULT_PROCESS_RANK,
  horizonDays: 540,
  optimise: 'light',
  objective: 'late-weight-days',
}

// ---- Scenario events ----------------------------------------------------------------
// What a scenario changes, one event at a time. Machines are named by their
// key (the API reads a typed code through ai.machine_key); times are the
// factory's clock, "YYYY-MM-DD HH:MM"; days YYYY-MM-DD.

interface EventBase {
  id: string
  /** Why, in a line: shown beside the event. */
  note?: string
}

export type PlanEvent = EventBase &
  (
    | { type: 'machine-down'; machineKey: string; from: string; to: string }
    | { type: 'capacity'; machineKey: string; fromDay: string; toDay: string; hoursPerDay: number }
    | { type: 'working-day'; day: string; working: boolean; machineKey?: string }
    | { type: 'speed'; machineKey: string; speedPct: number }
    | { type: 'move'; lineKey: string; toMachineKey: string }
    | { type: 'priority'; lineKey?: string; orderNumber?: string; customer?: string }
    | { type: 'not-before'; lineKey: string; at: string }
    | { type: 'material'; lineKey?: string; orderNumber?: string; availableDay: string }
    | { type: 'exclude'; lineKey?: string; orderNumber?: string }
    | { type: 'due'; lineKey?: string; orderNumber?: string; dueDate: string }
    | { type: 'quantity'; lineKey: string; remainingQty: number }
    | { type: 'add-order'; orderNumber: string; item: string; customer: string; machineKey: string; qty: number; hours: number; dueDate: string | null; notBefore?: string }
  )

export type PlanEventType = PlanEvent['type']

export const PLAN_EVENT_TYPES: readonly { type: PlanEventType; name: string; help: string }[] = [
  { type: 'machine-down', name: 'Machine down', help: 'A machine stops between two times (a breakdown, maintenance).' },
  { type: 'capacity', name: 'Hours a day', help: 'A machine works a different number of hours a day for some days (a shift added or taken away).' },
  { type: 'working-day', name: 'Working day', help: 'A day worked or not worked: a Friday worked, or a holiday added — for the factory or one machine.' },
  { type: 'speed', name: 'Machine speed', help: 'A machine works faster or slower than its usual rate (80 = 20% slower).' },
  { type: 'move', name: 'Move a line', help: 'An order line made on another machine.' },
  { type: 'priority', name: 'Rush', help: 'A line, an order or a customer goes ahead of everything else on its machines.' },
  { type: 'not-before', name: 'Start not before', help: 'A line cannot start before a time.' },
  { type: 'material', name: 'Material arrives', help: 'A line’s or an order’s raw material is there only from a day.' },
  { type: 'exclude', name: 'Leave out', help: 'A line or an order is not made (cancelled or held).' },
  { type: 'due', name: 'Due date', help: 'A line or an order is due on another day.' },
  { type: 'quantity', name: 'Quantity', help: 'A line has another quantity left to make.' },
  { type: 'add-order', name: 'New order', help: 'An order that is not on the sheet yet: its machine, quantity, hours and due day.' },
]

// ---- What the engine writes ------------------------------------------------------------

/** Where an operation's hours came from. */
export type DurationSource = 'running' | 'erp' | 'rate-item' | 'rate-family' | 'rate-machine' | 'set-rate' | 'event' | 'assumed'

export type OperationFlag =
  | 'no-capacity'
  | 'beyond-horizon'
  | 'cycle'
  | 'unknown-machine'
  | 'assumed-hours'
  | 'waits-material'
  | 'moved'
  | 'rushed'
  | 'hypothetical'
  | 'running'

/** One order line placed on a machine. */
export interface PlanOperation {
  lineId: string
  lineKey: string
  orderNumber: string
  itemCode: string
  item: string
  customer: string
  machineKey: string
  /** Its place on the machine (1 = first). */
  seq: number
  qty: number
  hours: number
  durationSource: DurationSource
  /** Wall minutes; null when it could not be placed. */
  start: number | null
  end: number | null
  dueDate: string | null
  /** Whole days past its due day's end (08:00 the next morning); 0 when on time. */
  lateDays: number
  /** The lines it waits for (line keys). */
  dependsOn: string[]
  /** The kg it carries (the line's weight in proportion to what is left). */
  weightKg: number | null
  flags: OperationFlag[]
}

/** One line the engine left out, with why. */
export interface PlanExclusion {
  lineKey: string
  orderNumber: string
  item: string
  machineKey: string
  reason: 'done' | 'cancelled' | 'hold' | 'stock' | 'no-machine' | 'excluded'
}

export interface PlanSummary {
  lines: number
  placed: number
  unplaced: number
  late: number
  onTimePct: number | null
  lateWeightKg: number
  maxLateDays: number
  hours: number
  assumedHours: number
  /** Wall minutes of the last finish; null when nothing was placed. */
  lastFinish: number | null
  excluded: number
}

export interface PlanResult {
  /** When it was worked out from (wall minutes). */
  now: number
  operations: PlanOperation[]
  excluded: PlanExclusion[]
  summary: PlanSummary
  /** Things the engine could not use, in plain words (an event naming a line it does not know…). */
  warnings: string[]
  /** The line ids in the order the engine took them (the priority order, or the optimiser's). */
  order?: string[]
  /** When the optimiser ran: what the plain priority order gave, and what it did. */
  optimisation?: PlanOptimisation
}

export interface PlanOptimisation {
  objective: PlanObjective
  effort: OptimiseEffort
  /** The priority order's totals, before the optimiser. */
  baseline: PlanSummary
  /** The objective's figure (tonne-days late, late lines or days late) of the priority order, and of the plan. */
  baselineScore: number
  score: number
  /** Plans worked out while searching. */
  evaluations: number
  /** Moves kept (a line may move more than once). */
  moves: number
  improved: boolean
}
