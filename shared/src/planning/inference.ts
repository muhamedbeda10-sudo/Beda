// ============================================================================
// §25 — what the factory's own record says about planning, learnt rather than
// typed: how many hours a day each machine works and how fast it makes what
// it makes (the ERP's production task record), in what order the processes
// follow each other (the days each process first worked on an order), which
// machines each item passes through (the order sheet), and whether the ERP's
// part duration is a line's hours or one piece's. Each figure says how many
// rows it rests on, so the planner can tell a figure to trust from a guess,
// and anything someone sets wins over it.
// ============================================================================

import { DEFAULT_PROCESS_RANK, PLANNING_PROCESSES, type ErpDurationMeaning, type MachineRate, type PlanningProcess } from './types'
import { FRIDAY, addDays, dayNumber, weekday } from './time'

/** One row of the production task record, as inference reads it (with its order line's item, when known). */
export interface RecordRow {
  lineKey: string
  machineKey: string
  itemCode: string
  itemFamily: string | null
  workDay: string | null
  producedQty: number | null
  actualHours: number | null
  plannedHours: number | null
  /** The task's whole planned duration (repeated on its rows). */
  durationHours: number | null
  requiredQty: number | null
  stageNo: number | null
  shift: string
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase()
const round = (x: number, places = 2) => Math.round(x * 10 ** places) / 10 ** places

/** A day's work with too little time to read a pace from. */
const MIN_ROW_HOURS = 0.25

/** The least rows a pace rests on: an item's, its family's, a machine's. */
export const RATE_MIN_SAMPLES = { item: 2, family: 3, machine: 3 }

/**
 * Pieces an hour, from the rows that made finished pieces in a recorded time
 * (stage rows carry their pieces elsewhere and are left out): the median of
 * the rows' paces, so one mistyped day does not move it. By the machine and
 * the item, the family, and the machine alone.
 */
export function inferRates(rows: readonly RecordRow[]): MachineRate[] {
  const groups = new Map<string, { machineKey: string; itemCode: string; itemFamily: string; paces: number[] }>()
  const add = (machineKey: string, itemCode: string, itemFamily: string, pace: number) => {
    const key = `${machineKey}|${itemCode}|${itemFamily}`
    const g = groups.get(key)
    if (g) g.paces.push(pace)
    else groups.set(key, { machineKey, itemCode, itemFamily, paces: [pace] })
  }
  for (const r of rows) {
    if (!r.machineKey || r.stageNo !== null) continue
    if (!(r.producedQty !== null && r.producedQty > 0 && r.actualHours !== null && r.actualHours >= MIN_ROW_HOURS)) continue
    const pace = r.producedQty / r.actualHours
    if (!Number.isFinite(pace)) continue
    if (r.itemCode) add(r.machineKey, norm(r.itemCode), '', pace)
    if (r.itemFamily) add(r.machineKey, '', norm(r.itemFamily), pace)
    add(r.machineKey, '', '', pace)
  }
  const out: MachineRate[] = []
  for (const g of groups.values()) {
    const need = g.itemCode ? RATE_MIN_SAMPLES.item : g.itemFamily ? RATE_MIN_SAMPLES.family : RATE_MIN_SAMPLES.machine
    if (g.paces.length < need) continue
    out.push({ machineKey: g.machineKey, itemCode: g.itemCode, itemFamily: g.itemFamily, piecesPerHour: round(median(g.paces), 3), samples: g.paces.length, source: 'inferred' })
  }
  return out.sort((a, b) => a.machineKey.localeCompare(b.machineKey) || a.itemFamily.localeCompare(b.itemFamily) || a.itemCode.localeCompare(b.itemCode))
}

/** A machine's pace of late against its usual one. */
export interface MachineSpeed {
  machineKey: string
  /** Median pieces an hour over its rows of the last `recentDays` days (any item); null with too few. */
  recentPiecesPerHour: number | null
  /** Days of those it worked. */
  recentDays: number
  /** Recent ÷ usual × 100; null without both, or with fewer than 3 recent days. */
  speedPct: number | null
}

/** Days a machine's recent pace is read over, and the days it needs to say anything. */
export const SPEED_RECENT_DAYS = 14
const SPEED_MIN_DAYS = 3

/**
 * Each machine's pace over the last two weeks against its pace over the
 * whole record given, any item: a machine running a fifth slower than usual
 * says 80. The pace of a day is its rows' pieces an hour, median over days.
 */
export function inferSpeed(rows: readonly RecordRow[], today: string, recentDays = SPEED_RECENT_DAYS): MachineSpeed[] {
  const since = addDays(today, -recentDays)
  const all = new Map<string, number[]>()
  const recent = new Map<string, Map<string, number[]>>()
  for (const r of rows) {
    if (!r.machineKey || r.stageNo !== null) continue
    if (!(r.producedQty !== null && r.producedQty > 0 && r.actualHours !== null && r.actualHours >= MIN_ROW_HOURS)) continue
    const pace = r.producedQty / r.actualHours
    if (!Number.isFinite(pace)) continue
    const a = all.get(r.machineKey)
    if (a) a.push(pace)
    else all.set(r.machineKey, [pace])
    if (r.workDay && r.workDay >= since && r.workDay <= today) {
      let byDay = recent.get(r.machineKey)
      if (!byDay) recent.set(r.machineKey, (byDay = new Map()))
      const d = byDay.get(r.workDay)
      if (d) d.push(pace)
      else byDay.set(r.workDay, [pace])
    }
  }
  const out: MachineSpeed[] = []
  for (const [machineKey, paces] of all) {
    const byDay = recent.get(machineKey)
    const days = byDay ? [...byDay.values()].map((p) => median(p)) : []
    const recentPace = days.length >= SPEED_MIN_DAYS ? round(median(days), 3) : null
    const usual = paces.length >= RATE_MIN_SAMPLES.machine ? median(paces) : null
    out.push({
      machineKey,
      recentPiecesPerHour: recentPace,
      recentDays: days.length,
      speedPct: recentPace !== null && usual !== null && usual > 0 ? Math.round((recentPace / usual) * 100) : null,
    })
  }
  return out.sort((a, b) => a.machineKey.localeCompare(b.machineKey))
}

/** What a machine's record says about its working days. */
export interface MachineStats {
  machineKey: string
  /** Median hours worked on the days it worked; null with too few days. */
  hoursPerDay: number | null
  /** Which hours it rests on: the actual hours, or the ERP's planned hours where the actual were not recorded. */
  hoursFrom: 'actual' | 'planned' | null
  daysObserved: number
  /** Planned ÷ actual hours over the rows that have both (1 = the ERP's standard); null with too few. */
  efficiency: number | null
  efficiencySamples: number
  worksFridays: boolean
  fridaysWorked: number
  lastWorkDay: string | null
  /** The shift names seen, most used first. */
  shifts: string[]
}

/** The least days a machine's hours a day rest on. */
export const CAPACITY_MIN_DAYS = 5
const EFFICIENCY_MIN_ROWS = 5

/**
 * Each machine's working day from the days in `windowDays` up to `today`:
 * the hours of all its rows on a day added up (it makes one line at a time),
 * the median over the days it worked, at most 24. Fridays count as worked
 * as a rule when it worked half the Fridays of the span, and at least four.
 */
export function inferMachineStats(rows: readonly RecordRow[], today: string, windowDays = 120): MachineStats[] {
  const from = dayNumber(addDays(today, -windowDays))
  const to = dayNumber(today)
  interface Acc {
    actual: Map<string, number>
    planned: Map<string, number>
    effPlanned: number
    effActual: number
    effRows: number
    last: string | null
    shifts: Map<string, number>
    first: number
  }
  const by = new Map<string, Acc>()
  for (const r of rows) {
    if (!r.machineKey || !r.workDay) continue
    const n = dayNumber(r.workDay)
    let a = by.get(r.machineKey)
    if (!a) {
      a = { actual: new Map(), planned: new Map(), effPlanned: 0, effActual: 0, effRows: 0, last: null, shifts: new Map(), first: Infinity }
      by.set(r.machineKey, a)
    }
    if (a.last === null || r.workDay > a.last) a.last = r.workDay
    if (n < from || n > to) continue
    a.first = Math.min(a.first, n)
    if (r.actualHours !== null && r.actualHours > 0) a.actual.set(r.workDay, (a.actual.get(r.workDay) ?? 0) + r.actualHours)
    if (r.plannedHours !== null && r.plannedHours > 0) a.planned.set(r.workDay, (a.planned.get(r.workDay) ?? 0) + r.plannedHours)
    if (r.actualHours !== null && r.actualHours >= MIN_ROW_HOURS && r.plannedHours !== null && r.plannedHours > 0) {
      a.effPlanned += r.plannedHours
      a.effActual += r.actualHours
      a.effRows++
    }
    const shift = r.shift.trim()
    if (shift) a.shifts.set(shift, (a.shifts.get(shift) ?? 0) + 1)
  }
  const out: MachineStats[] = []
  for (const [machineKey, a] of by) {
    const useActual = a.actual.size >= CAPACITY_MIN_DAYS
    const days = useActual ? a.actual : a.planned.size >= CAPACITY_MIN_DAYS ? a.planned : null
    const worked = new Set([...a.actual.keys(), ...a.planned.keys()])
    const fridaysWorked = [...worked].filter((d) => weekday(d) === FRIDAY).length
    let fridaysInSpan = 0
    if (Number.isFinite(a.first)) for (let n = a.first; n <= to; n++) if ((n + 4) % 7 === FRIDAY) fridaysInSpan++
    out.push({
      machineKey,
      hoursPerDay: days ? round(Math.min(24, median([...days.values()])), 1) : null,
      hoursFrom: days ? (useActual ? 'actual' : 'planned') : null,
      daysObserved: worked.size,
      efficiency: a.effRows >= EFFICIENCY_MIN_ROWS && a.effActual > 0 ? round(Math.max(0.3, Math.min(2, a.effPlanned / a.effActual)), 2) : null,
      efficiencySamples: a.effRows,
      worksFridays: fridaysWorked >= 4 && fridaysInSpan > 0 && fridaysWorked / fridaysInSpan >= 0.5,
      fridaysWorked,
      lastWorkDay: a.last,
      shifts: [...a.shifts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 5).map(([s]) => s),
    })
  }
  return out.sort((a, b) => a.machineKey.localeCompare(b.machineKey))
}

/** A process's first day of work on an order (an item of it, when known). */
export interface ProcessDay {
  orderNumber: string
  itemCode: string
  process: PlanningProcess
  firstDay: string
}

export interface ProcessOrderResult {
  rank: Record<PlanningProcess, number>
  /** How often process `before` started first on an order where `after` also worked: [before, after, times]. */
  votes: [PlanningProcess, PlanningProcess, number][]
  /** The order rests on the record; false = the defaults (too little seen). */
  learnt: boolean
}

/** One process goes before another when it started first this many times, and at least twice as often as the other way. */
const ORDER_MIN_VOTES = 3

/**
 * The order the processes follow, from the days each first worked on the
 * same order: one goes before another only when the record clearly says so;
 * processes that start together (forming, universal, mast) share a rank. A
 * rank is the longest chain of "before"s leading to it; a process the record
 * says nothing about keeps its default rank.
 */
export function inferProcessOrder(days: readonly ProcessDay[]): ProcessOrderResult {
  const first = new Map<string, Map<PlanningProcess, string>>()
  for (const d of days) {
    const key = norm(d.orderNumber)
    if (!key) continue
    let m = first.get(key)
    if (!m) first.set(key, (m = new Map()))
    const had = m.get(d.process)
    if (!had || d.firstDay < had) m.set(d.process, d.firstDay)
  }
  const count = new Map<string, number>()
  for (const m of first.values()) {
    const entries = [...m.entries()]
    for (const [a, da] of entries)
      for (const [b, db] of entries) {
        if (a === b || da >= db) continue
        count.set(`${a}>${b}`, (count.get(`${a}>${b}`) ?? 0) + 1)
      }
  }
  const votes: [PlanningProcess, PlanningProcess, number][] = []
  const edges: [PlanningProcess, PlanningProcess][] = []
  for (const a of PLANNING_PROCESSES)
    for (const b of PLANNING_PROCESSES) {
      if (a === b) continue
      const ab = count.get(`${a}>${b}`) ?? 0
      if (ab > 0) votes.push([a, b, ab])
      const ba = count.get(`${b}>${a}`) ?? 0
      if (ab >= ORDER_MIN_VOTES && ab >= 2 * ba) edges.push([a, b])
    }
  if (edges.length === 0) return { rank: { ...DEFAULT_PROCESS_RANK }, votes, learnt: false }
  // Longest path from the sources; a loop (which the 2:1 rule makes unlikely) is cut by the bound.
  const rank: Record<PlanningProcess, number> = { ...DEFAULT_PROCESS_RANK }
  const involved = new Set(edges.flat())
  for (const p of involved) rank[p] = 1
  for (let pass = 0; pass < PLANNING_PROCESSES.length; pass++) {
    let changed = false
    for (const [a, b] of edges) {
      if (rank[b] < rank[a] + 1) {
        rank[b] = rank[a] + 1
        changed = true
      }
    }
    if (!changed) break
  }
  return { rank, votes: votes.sort((x, y) => y[2] - x[2]), learnt: true }
}

/** An order line as routes are read from: an item of an order on a machine. */
export interface RouteLine {
  orderNumber: string
  itemCode: string
  item: string
  machineKey: string
  process: PlanningProcess | null
  /** The line's weight and quantity, when the sheet has them: the item's weight a piece is learnt from them. */
  weightKg?: number | null
  requiredQty?: number | null
}

export interface ItemRoute {
  itemCode: string
  item: string
  /** The processes it passes through, in order, with the machines seen at each (most used first). */
  steps: { process: PlanningProcess; machines: { machineKey: string; lines: number }[] }[]
  /** Orders it was seen on. */
  orders: number
  /** Share of those orders on which it took its usual processes (0–100). */
  confidencePct: number
  /** The median kg a piece over its lines that carry a weight; null when none does. */
  kgPerPiece: number | null
}

/**
 * Each item's way through the factory: the processes of its order lines in
 * an order (the item on several machines of one order is one item passing
 * through them), in the processes' order, the machines seen at each.
 */
export function inferRoutes(lines: readonly RouteLine[], rank: Record<PlanningProcess, number>): ItemRoute[] {
  const items = new Map<string, { item: string; orders: Map<string, Set<PlanningProcess>>; machines: Map<PlanningProcess, Map<string, number>>; kgPerPiece: number[] }>()
  for (const l of lines) {
    const code = l.itemCode.trim()
    if (!code || !l.machineKey) continue
    const key = norm(code)
    let it = items.get(key)
    if (!it) items.set(key, (it = { item: l.item, orders: new Map(), machines: new Map(), kgPerPiece: [] }))
    if (l.weightKg !== null && l.weightKg !== undefined && l.weightKg > 0 && l.requiredQty !== null && l.requiredQty !== undefined && l.requiredQty > 0) it.kgPerPiece.push(l.weightKg / l.requiredQty)
    const process = l.process ?? 'other'
    const order = norm(l.orderNumber)
    let set = it.orders.get(order)
    if (!set) it.orders.set(order, (set = new Set()))
    set.add(process)
    let ms = it.machines.get(process)
    if (!ms) it.machines.set(process, (ms = new Map()))
    ms.set(l.machineKey, (ms.get(l.machineKey) ?? 0) + 1)
  }
  const out: ItemRoute[] = []
  for (const [key, it] of items) {
    const patterns = new Map<string, number>()
    for (const set of it.orders.values()) {
      const p = [...set].sort().join('+')
      patterns.set(p, (patterns.get(p) ?? 0) + 1)
    }
    const usual = [...patterns.entries()].sort((a, b) => b[1] - a[1])[0]
    const steps = [...it.machines.entries()]
      .sort((a, b) => (rank[a[0]] ?? 2) - (rank[b[0]] ?? 2) || a[0].localeCompare(b[0]))
      .map(([process, ms]) => ({ process, machines: [...ms.entries()].sort((a, b) => b[1] - a[1]).map(([machineKey, n]) => ({ machineKey, lines: n })) }))
    out.push({ itemCode: key, item: it.item, steps, orders: it.orders.size, confidencePct: Math.round((usual[1] / it.orders.size) * 100), kgPerPiece: it.kgPerPiece.length > 0 ? Math.round(median(it.kgPerPiece) * 1000) / 1000 : null })
  }
  return out.sort((a, b) => a.itemCode.localeCompare(b.itemCode))
}

/** A line's ERP part duration beside what the record says of the same line. */
export interface DurationPair {
  erpHours: number
  requiredQty: number
  /** The task's planned duration on the production record, when it has the line. */
  taskDurationHours: number | null
  /** The actual hours the record has for the line, when it was made. */
  actualHours: number | null
}

export interface DurationMeaningResult {
  meaning: ErpDurationMeaning | null
  lineVotes: number
  pieceVotes: number
}

/**
 * Whether the ERP's part duration is the hours of the whole line or of one
 * piece: compared first with the production record's planned duration of the
 * same task (which is the whole task's), and where that is missing with the
 * actual hours spent on the line — whichever reading is nearer, on a log scale.
 */
export function inferErpDurationMeaning(pairs: readonly DurationPair[]): DurationMeaningResult {
  let lineVotes = 0
  let pieceVotes = 0
  for (const p of pairs) {
    if (!(p.erpHours > 0 && p.requiredQty > 1)) continue
    const target = p.taskDurationHours && p.taskDurationHours > 0 ? p.taskDurationHours : p.actualHours && p.actualHours > 0 ? p.actualHours : null
    if (target === null) continue
    const asLine = Math.abs(Math.log(p.erpHours / target))
    const asPiece = Math.abs(Math.log((p.erpHours * p.requiredQty) / target))
    if (asLine < asPiece) lineVotes++
    else if (asPiece < asLine) pieceVotes++
  }
  const total = lineVotes + pieceVotes
  const meaning: ErpDurationMeaning | null = total < 5 ? null : lineVotes >= pieceVotes * 2 ? 'line' : pieceVotes >= lineVotes * 2 ? 'piece' : null
  return { meaning, lineVotes, pieceVotes }
}
