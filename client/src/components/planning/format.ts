// ============================================================================
// §25 — how planning shows its figures: times on the factory's clock (a plan
// travels as wall minutes, so it reads the same wherever it is opened),
// hours, weights, and one colour per state the same on every section — the
// map, the schedule, the lists.
// ============================================================================

import { MINUTES_PER_DAY, PROCESS_NAMES, dayNumber, factoryDayOfWall, formatWall, type OperationFlag, type PlanOperation, type PlanningProcess } from '@qc/shared/planning'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Sat 24 Oct" for a YYYY-MM-DD day. */
export function dayLabel(day: string | null | undefined, withYear = false): string {
  if (!day) return '—'
  const [y, m, d] = day.split('-').map(Number)
  const wd = WEEKDAYS[(dayNumber(day) + 4) % 7]
  return `${wd} ${d} ${MONTHS[m - 1]}${withYear ? ` ${y}` : ''}`
}

/** "Sat 24 Oct 14:30" for a wall minute. */
export function wallLabel(wall: number | null | undefined): string {
  if (wall === null || wall === undefined) return '—'
  const text = formatWall(wall)
  return `${dayLabel(text.slice(0, 10))} ${text.slice(11)}`
}

/** The factory day a wall minute belongs to, as "Sat 24 Oct". */
export const factoryDayLabel = (wall: number | null | undefined) => (wall === null || wall === undefined ? '—' : dayLabel(factoryDayOfWall(wall)))

export const hoursLabel = (h: number | null | undefined) => (h === null || h === undefined ? '—' : `${h >= 100 ? Math.round(h).toLocaleString() : Math.round(h * 10) / 10} h`)

export const tonnes = (kg: number | null | undefined) => (kg === null || kg === undefined ? '—' : kg >= 1000 ? `${(kg / 1000).toFixed(kg >= 10_000 ? 0 : 1)} t` : `${Math.round(kg)} kg`)

export const pctLabel = (p: number | null | undefined) => (p === null || p === undefined ? '—' : `${Math.round(p * 10) / 10}%`)

export const qtyLabel = (n: number | null | undefined) => (n === null || n === undefined ? '—' : Math.round(n).toLocaleString())

/** Days from one wall minute to another, rounded, as "in 3 days", "today", "2 days ago". */
export function inDays(wall: number | null, now: number): string {
  if (wall === null) return '—'
  const d = Math.round((wall - now) / MINUTES_PER_DAY)
  if (d === 0) return 'today'
  return d > 0 ? `in ${d} day${d === 1 ? '' : 's'}` : `${-d} day${d === -1 ? '' : 's'} ago`
}

export const processName = (p: PlanningProcess | null | undefined) => (p ? PROCESS_NAMES[p] : 'Not in the register')

// ---- States, one colour each ---------------------------------------------------------------

export type OpState = 'running' | 'late' | 'material' | 'hypothetical' | 'unplaced' | 'planned'

/** What an operation is, for its colour: the most pressing thing about it first. */
export function opState(op: Pick<PlanOperation, 'flags' | 'lateDays' | 'start'>): OpState {
  if (op.start === null) return 'unplaced'
  if (op.flags.includes('running')) return 'running'
  if (op.lateDays > 0) return 'late'
  if (op.flags.includes('waits-material')) return 'material'
  if (op.flags.includes('hypothetical')) return 'hypothetical'
  return 'planned'
}

/** A bar's fill and its text: AA contrast in both themes. */
export const STATE_BAR: Record<OpState, string> = {
  running: 'bg-emerald-700 text-white ring-emerald-800 dark:bg-emerald-500 dark:text-emerald-950',
  late: 'bg-rose-600 text-white ring-rose-700 dark:bg-rose-400 dark:text-rose-950',
  material: 'bg-amber-400 text-amber-950 ring-amber-500 dark:bg-amber-400 dark:text-amber-950',
  hypothetical: 'bg-violet-600 text-white ring-violet-700 dark:bg-violet-400 dark:text-violet-950',
  unplaced: 'bg-slate-300 text-slate-800 ring-slate-400 dark:bg-slate-600 dark:text-slate-100',
  planned: 'bg-brand-600 text-white ring-brand-700 dark:bg-brand-300 dark:text-brand-950',
}

/** A small dot of the same colour, for legends and lists. */
export const STATE_DOT: Record<OpState, string> = {
  running: 'bg-emerald-700 dark:bg-emerald-500',
  late: 'bg-rose-600 dark:bg-rose-400',
  material: 'bg-amber-400',
  hypothetical: 'bg-violet-600 dark:bg-violet-400',
  unplaced: 'bg-slate-400 dark:bg-slate-500',
  planned: 'bg-brand-600 dark:bg-brand-300',
}

export const STATE_NAME: Record<OpState, string> = {
  running: 'Running now',
  late: 'Late',
  material: 'Waits for material',
  hypothetical: 'Added by the scenario',
  unplaced: 'Not placed',
  planned: 'Planned',
}

export const FLAG_NAME: Record<OperationFlag, string> = {
  'no-capacity': 'No working time to place it',
  'beyond-horizon': 'Beyond the planning horizon',
  cycle: 'Its parent ids loop: placed regardless',
  'unknown-machine': 'Machine not in the register',
  'assumed-hours': 'No duration to go by: default hours',
  'waits-material': 'Waits for its raw material',
  moved: 'Moved to another machine',
  rushed: 'Rushed',
  hypothetical: 'Added by the scenario',
  running: 'Running now (inspection open)',
}

export const DURATION_NAME: Record<PlanOperation['durationSource'], string> = {
  running: 'Running now',
  erp: 'ERP part duration',
  'rate-item': 'Machine’s pace for this item',
  'rate-family': 'Machine’s pace for the family',
  'rate-machine': 'Machine’s usual pace',
  'set-rate': 'Pace a planner set',
  event: 'Scenario’s hours',
  assumed: 'Default hours (nothing to go by)',
}

/** A load % as a heat cell: under, fair, full, over. Text colours keep AA on each fill. */
export function loadCell(pct: number | null): string {
  if (pct === null) return 'bg-slate-100 text-slate-500 dark:bg-slate-800/60 dark:text-slate-400'
  if (pct > 100) return 'bg-rose-600 text-white dark:bg-rose-400 dark:text-rose-950'
  if (pct >= 85) return 'bg-amber-300 text-amber-950 dark:bg-amber-400 dark:text-amber-950'
  if (pct >= 50) return 'bg-brand-200 text-brand-950 dark:bg-brand-500/60 dark:text-white'
  if (pct > 0) return 'bg-brand-50 text-brand-900 dark:bg-brand-500/20 dark:text-brand-100'
  return 'bg-white text-slate-500 dark:bg-slate-900 dark:text-slate-400'
}
