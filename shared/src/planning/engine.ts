// ============================================================================
// §25 — the planning engine: every open order line placed on its machine,
// in time, as the machines' calendars allow.
//
//   1. The lines to plan: open (something left to make), not cancelled, not
//      the press's STOCK line, not held by the ERP (unless the settings say
//      so), on a machine. A scenario's events change them first: a line moved,
//      left out, given another due day or quantity, an order added.
//   2. Each line's hours: what is left of it at the machine's pace — the
//      ERP's duration or the machine's own record of what it made, whichever
//      the settings put first; a set rate before both; a line with nothing to
//      go by takes the default and says so.
//   3. Which lines wait for which: a line for the ones its parent id names, an
//      item for its earlier processes in the same order (forming before
//      welding before painting, as the record shows the factory works).
//   4. The order on each machine: the line running now first (an inspection
//      session is open on it), then the rushed ones, then by the sequence
//      rule — the ERP's planned start, the due day, or the order date.
//   5. Placing: each line, once the lines it waits for are placed, at the
//      earliest time its machine is free for the whole of it (a gap left by a
//      line that had to wait is used when the next one fits in it), no sooner
//      than its material, and — after a line it waits for — overlapping it by
//      no more than overlapPct of its run, finishing no sooner than
//      finishLagMinutes after it.
//
// Pure: the same inputs give the same plan, so a scenario is the same engine
// on the same data with its events, and the two can be compared line by line.
// ============================================================================

import { MachineCalendar } from './calendar'
import {
  DEFAULT_PLAN_SETTINGS,
  type CalendarException,
  type DurationSource,
  type MachineCapacity,
  type MachineRate,
  type OperationFlag,
  type PlanEvent,
  type PlanExclusion,
  type PlanLine,
  type PlanMachine,
  type PlanOperation,
  type PlanResult,
  type PlanSettings,
  type PlanSummary,
  type PlanningProcess,
} from './types'
import { MINUTES_PER_DAY, addDays, dayStartWall, isDay, parseWall } from './time'

export interface PlanInputs {
  /** Wall minutes the plan starts from. */
  now: number
  lines: readonly PlanLine[]
  machines: readonly PlanMachine[]
  capacities: readonly MachineCapacity[]
  rates: readonly MachineRate[]
  calendar: readonly CalendarException[]
  settings?: Partial<PlanSettings>
  events?: readonly PlanEvent[]
  /** An order the lines are taken in (line id → rank, lower first), after the running and the rushed; lines not named come after every named one, in the sequence rule's order. */
  priority?: ReadonlyMap<string, number>
}

/** The settings in force: the given ones over the defaults, nested ones merged. */
export function resolveSettings(s: Partial<PlanSettings> | undefined): PlanSettings {
  return {
    ...DEFAULT_PLAN_SETTINGS,
    ...(s ?? {}),
    dependencies: { ...DEFAULT_PLAN_SETTINGS.dependencies, ...(s?.dependencies ?? {}) },
    processRank: { ...DEFAULT_PLAN_SETTINGS.processRank, ...(s?.processRank ?? {}) },
  }
}

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase()

export function isCancelledLine(status: string): boolean {
  const s = status.trim()
  return s.toLowerCase().startsWith('cancel') || s.includes('ملغ') || s.includes('لغاء')
}

export function isHoldLine(status: string): boolean {
  const s = status.trim()
  return s.toLowerCase().startsWith('hold') || s.includes('موقوف') || s.includes('معلق')
}

/** The capacity a machine has: as given, or the default. */
export function capacityOf(capacities: ReadonlyMap<string, MachineCapacity>, machineKey: string, settings: PlanSettings): MachineCapacity {
  return capacities.get(machineKey) ?? { machineKey, hoursPerDay: settings.defaultHoursPerDay, efficiency: 1, worksFridays: false, source: 'default' }
}

/** Each machine's calendar under a scenario's events. */
export function buildCalendars(
  machineKeys: Iterable<string>,
  capacities: readonly MachineCapacity[],
  calendar: readonly CalendarException[],
  settings: PlanSettings,
  events: readonly PlanEvent[] = [],
): Map<string, MachineCalendar> {
  const caps = new Map(capacities.map((c) => [c.machineKey, c]))
  const exceptions = new Map(calendar.map((c) => [c.day, c]))
  const out = new Map<string, MachineCalendar>()
  for (const key of machineKeys) if (!out.has(key)) out.set(key, new MachineCalendar(key, capacityOf(caps, key, settings), exceptions, events))
  return out
}

// ---- Rates -------------------------------------------------------------------------------

export class RateBook {
  private readonly set = new Map<string, MachineRate>()
  private readonly learnt = new Map<string, MachineRate>()
  constructor(rates: readonly MachineRate[]) {
    for (const r of rates) {
      if (!(r.piecesPerHour > 0)) continue
      const key = `${r.machineKey}|${norm(r.itemCode)}|${norm(r.itemFamily)}`
      ;(r.source === 'set' ? this.set : this.learnt).set(key, r)
    }
  }
  /** A rate someone set for the machine and the line's family, or for the machine. */
  setRate(machineKey: string, family: string | null): MachineRate | null {
    return this.set.get(`${machineKey}||${norm(family)}`) ?? this.set.get(`${machineKey}||`) ?? null
  }
  /** What the machine's record says: the item's own pace, its family's, or the machine's. */
  learntRate(machineKey: string, itemCode: string, family: string | null): { rate: MachineRate; source: DurationSource } | null {
    const item = this.learnt.get(`${machineKey}|${norm(itemCode)}|`)
    if (item) return { rate: item, source: 'rate-item' }
    const fam = family ? this.learnt.get(`${machineKey}||${norm(family)}`) : undefined
    if (fam) return { rate: fam, source: 'rate-family' }
    const machine = this.learnt.get(`${machineKey}||`)
    return machine ? { rate: machine, source: 'rate-machine' } : null
  }
}

/** The hours a line takes on its machine, and where they came from. */
export function lineHours(
  line: PlanLine,
  capacity: MachineCapacity,
  book: RateBook,
  settings: PlanSettings,
  hypotheticalHours?: number,
): { hours: number; source: DurationSource } {
  if (hypotheticalHours !== undefined) return { hours: Math.max(0, hypotheticalHours), source: 'event' }
  const remaining = Math.max(0, line.remainingQty)
  const set = book.setRate(line.machineKey, line.itemFamily)
  if (set) return { hours: remaining / set.piecesPerHour, source: 'set-rate' }
  const fromErp = (): number | null => {
    if (!(line.erpHours !== null && line.erpHours > 0)) return null
    let h = settings.erpDurationMeaning === 'piece' ? line.erpHours * remaining : line.requiredQty > 0 ? (line.erpHours * remaining) / line.requiredQty : line.erpHours
    if (settings.applyEfficiency && capacity.efficiency > 0) h /= capacity.efficiency
    return h
  }
  const fromRecord = () => book.learntRate(line.machineKey, line.itemCode, line.itemFamily)
  if (settings.timeSource === 'erp-first') {
    const e = fromErp()
    if (e !== null) return { hours: e, source: 'erp' }
    const r = fromRecord()
    if (r) return { hours: remaining / r.rate.piecesPerHour, source: r.source }
  } else {
    const r = fromRecord()
    if (r) return { hours: remaining / r.rate.piecesPerHour, source: r.source }
    const e = fromErp()
    if (e !== null) return { hours: e, source: 'erp' }
  }
  return { hours: settings.defaultLineHours, source: 'assumed' }
}

// ---- A small heap ------------------------------------------------------------------------

class Heap<T> {
  private readonly items: T[] = []
  constructor(private readonly before: (a: T, b: T) => boolean) {}
  get size() {
    return this.items.length
  }
  push(v: T) {
    const a = this.items
    a.push(v)
    let i = a.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (!this.before(a[i], a[p])) break
      ;[a[i], a[p]] = [a[p], a[i]]
      i = p
    }
  }
  pop(): T | undefined {
    const a = this.items
    if (a.length === 0) return undefined
    const top = a[0]
    const last = a.pop()!
    if (a.length > 0) {
      a[0] = last
      let i = 0
      while (true) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < a.length && this.before(a[l], a[m])) m = l
        if (r < a.length && this.before(a[r], a[m])) m = r
        if (m === i) break
        ;[a[i], a[m]] = [a[m], a[i]]
        i = m
      }
    }
    return top
  }
}

// ---- The plan --------------------------------------------------------------------------------

interface Work {
  line: PlanLine
  op: PlanOperation
  process: PlanningProcess
  /** Sort key, compared in order. */
  key: (string | number)[]
  release: number
  preds: Work[]
  succs: Work[]
  waiting: number
  running: boolean
}

const FAR = '9999-12-31'

/** The plan of the lines as they stand, with a scenario's events. */
export function runPlan(inputs: PlanInputs): PlanResult {
  const settings = resolveSettings(inputs.settings)
  const events = inputs.events ?? []
  const warnings: string[] = []
  const now = inputs.now
  const machines = new Map(inputs.machines.map((m) => [m.key, m]))
  const lineKeys = new Map(inputs.lines.map((l) => [norm(l.lineKey), l]))
  const orders = new Set(inputs.lines.map((l) => norm(l.orderNumber)))
  const customers = new Set(inputs.lines.map((l) => norm(l.customer)))

  // ---- 1. The lines, as the events change them ----
  const lines: PlanLine[] = inputs.lines.map((l) => ({ ...l }))
  const hypotheticalHours = new Map<string, number>()
  const forced = new Map<string, number>() // line id → not before (wall minutes)
  const rushed = new Set<string>()
  const moved = new Set<string>()
  const excludedByEvent = new Set<string>()
  const materialFrom = new Map<string, number>()
  const matches = (l: PlanLine, lineKey?: string, orderNumber?: string) =>
    (lineKey !== undefined && lineKey !== '' && norm(l.lineKey) === norm(lineKey)) || (orderNumber !== undefined && orderNumber !== '' && norm(l.orderNumber) === norm(orderNumber))
  const knownRef = (e: { id: string; type: string }, lineKey?: string, orderNumber?: string) => {
    if (lineKey && !lineKeys.has(norm(lineKey))) warnings.push(`Event ${e.type} (${e.id}): no open line has the Order ID "${lineKey}".`)
    if (orderNumber && !orders.has(norm(orderNumber))) warnings.push(`Event ${e.type} (${e.id}): no open line belongs to order "${orderNumber}".`)
  }
  for (const e of events) {
    switch (e.type) {
      case 'add-order': {
        const id = `event:${e.id}`
        lines.push({
          id,
          lineKey: `NEW-${e.id}`,
          orderNumber: e.orderNumber,
          itemCode: '',
          item: e.item,
          itemFamily: null,
          customer: e.customer,
          machineKey: e.machineKey,
          requiredQty: e.qty,
          remainingQty: e.qty,
          weightKg: null,
          erpHours: null,
          dueDate: e.dueDate && isDay(e.dueDate) ? e.dueDate : null,
          plannedStart: null,
          plannedFinish: null,
          orderDate: null,
          erpStatus: '',
          hold: false,
          parentId: null,
          modelGroupId: null,
          rawMaterialQty: null,
          rmReceivedQty: null,
          rmPromiseDate: null,
          runningSince: null,
          hypothetical: true,
        })
        hypotheticalHours.set(id, e.hours)
        if (e.notBefore) {
          const at = parseWall(e.notBefore)
          if (at !== null) forced.set(id, at)
        }
        if (!machines.has(e.machineKey)) warnings.push(`Event add-order (${e.id}): the machine "${e.machineKey}" is not in the register; it is planned with the default hours a day.`)
        break
      }
      case 'move':
        knownRef(e, e.lineKey)
        for (const l of lines) if (matches(l, e.lineKey)) ((l.machineKey = e.toMachineKey), moved.add(l.id))
        break
      case 'exclude':
        knownRef(e, e.lineKey, e.orderNumber)
        for (const l of lines) if (matches(l, e.lineKey, e.orderNumber)) excludedByEvent.add(l.id)
        break
      case 'due':
        knownRef(e, e.lineKey, e.orderNumber)
        for (const l of lines) if (matches(l, e.lineKey, e.orderNumber)) l.dueDate = e.dueDate
        break
      case 'quantity':
        knownRef(e, e.lineKey)
        for (const l of lines) if (matches(l, e.lineKey)) l.remainingQty = Math.max(0, e.remainingQty)
        break
      case 'priority':
        knownRef(e, e.lineKey, e.orderNumber)
        if (e.customer && !customers.has(norm(e.customer))) warnings.push(`Event priority (${e.id}): no open line is for the customer "${e.customer}".`)
        for (const l of lines) if (matches(l, e.lineKey, e.orderNumber) || (e.customer && norm(l.customer) === norm(e.customer))) rushed.add(l.id)
        break
      case 'not-before': {
        knownRef(e, e.lineKey)
        const at = parseWall(e.at)
        if (at === null) warnings.push(`Event not-before (${e.id}): "${e.at}" is not a time ("YYYY-MM-DD HH:MM").`)
        else for (const l of lines) if (matches(l, e.lineKey)) forced.set(l.id, Math.max(forced.get(l.id) ?? 0, at))
        break
      }
      case 'material':
        knownRef(e, e.lineKey, e.orderNumber)
        for (const l of lines) if (matches(l, e.lineKey, e.orderNumber)) materialFrom.set(l.id, dayStartWall(e.availableDay))
        break
      default:
        break
    }
  }

  // ---- What is left out ----
  const excluded: PlanExclusion[] = []
  const planned: PlanLine[] = []
  for (const l of lines) {
    const out = (reason: PlanExclusion['reason']) => excluded.push({ lineKey: l.lineKey, orderNumber: l.orderNumber, item: l.item, machineKey: l.machineKey, reason })
    if (excludedByEvent.has(l.id)) out('excluded')
    else if (isCancelledLine(l.erpStatus)) out('cancelled')
    else if (norm(l.orderNumber) === 'stock') out('stock')
    else if (l.remainingQty <= 0) out('done')
    else if (!l.machineKey) out('no-machine')
    else if ((l.hold || isHoldLine(l.erpStatus)) && !settings.includeHold) out('hold')
    else planned.push(l)
  }

  // ---- 2. Hours ----
  const machineKeys = new Set<string>([...planned.map((l) => l.machineKey), ...inputs.machines.map((m) => m.key)])
  const calendars = buildCalendars(machineKeys, inputs.capacities, inputs.calendar, settings, events)
  const caps = new Map(inputs.capacities.map((c) => [c.machineKey, c]))
  const book = new RateBook(inputs.rates)
  const speed = new Map<string, number>()
  for (const e of events) if (e.type === 'speed' && e.speedPct > 0) speed.set(e.machineKey, e.speedPct / 100)

  const works: Work[] = planned.map((line) => {
    const capacity = capacityOf(caps, line.machineKey, settings)
    const { hours: raw, source } = lineHours(line, capacity, book, settings, hypotheticalHours.get(line.id))
    const hours = raw / (speed.get(line.machineKey) ?? 1)
    const machine = machines.get(line.machineKey)
    const flags: OperationFlag[] = []
    if (!machine) flags.push('unknown-machine')
    if (source === 'assumed') flags.push('assumed-hours')
    if (moved.has(line.id)) flags.push('moved')
    if (rushed.has(line.id)) flags.push('rushed')
    if (line.hypothetical) flags.push('hypothetical')
    const running = line.runningSince !== null && !moved.has(line.id)
    if (running) flags.push('running')
    let release = Math.max(now, forced.get(line.id) ?? now)
    const material = materialFrom.get(line.id)
    if (material !== undefined) {
      if (material > release) flags.push('waits-material')
      release = Math.max(release, material)
    } else if (settings.materialGate && line.rmPromiseDate && isDay(line.rmPromiseDate) && !materialReceived(line)) {
      const at = dayStartWall(line.rmPromiseDate)
      if (at > release) {
        release = at
        flags.push('waits-material')
      }
    }
    const required = line.requiredQty > 0 ? line.requiredQty : line.remainingQty
    const keyDay =
      settings.sequenceRule === 'erp' ? (line.plannedStart ?? line.dueDate ?? FAR) : settings.sequenceRule === 'due' ? (line.dueDate ?? line.plannedStart ?? FAR) : (line.orderDate ?? line.plannedStart ?? FAR)
    return {
      line,
      process: machine?.process ?? 'other',
      key: [running ? 0 : 1, rushed.has(line.id) ? 0 : 1, inputs.priority?.get(line.id) ?? Infinity, keyDay, line.dueDate ?? FAR, norm(line.orderNumber), norm(line.lineKey)],
      release: running ? now : release,
      preds: [],
      succs: [],
      waiting: 0,
      running,
      op: {
        lineId: line.id,
        lineKey: line.lineKey,
        orderNumber: line.orderNumber,
        itemCode: line.itemCode,
        item: line.item,
        customer: line.customer,
        machineKey: line.machineKey,
        seq: 0,
        qty: line.remainingQty,
        hours: Math.round(hours * 100) / 100,
        durationSource: source,
        start: null,
        end: null,
        dueDate: line.dueDate,
        lateDays: 0,
        dependsOn: [],
        weightKg: line.weightKg !== null && required > 0 ? Math.round(((line.weightKg * line.remainingQty) / required) * 10) / 10 : null,
        flags,
      },
    }
  })

  // ---- 3. Dependencies ----
  const byKey = new Map(works.map((w) => [norm(w.line.lineKey), w]))
  const link = (before: Work, after: Work) => {
    if (before === after || after.preds.includes(before) || after.running) return
    after.preds.push(before)
    before.succs.push(after)
  }
  if (settings.dependencies.parent) {
    for (const w of works) {
      const parent = w.line.parentId ? byKey.get(norm(w.line.parentId)) : undefined
      if (parent) link(w, parent)
    }
  }
  const rank = (w: Work) => settings.processRank[w.process] ?? 2
  const chain = (groups: Map<string, Work[]>) => {
    for (const group of groups.values()) {
      const ranks = [...new Set(group.map(rank))].sort((a, b) => a - b)
      for (let i = 1; i < ranks.length; i++) {
        const earlier = group.filter((w) => rank(w) === ranks[i - 1])
        for (const w of group.filter((x) => rank(x) === ranks[i])) for (const e of earlier) link(e, w)
      }
    }
  }
  const groupBy = (keyOf: (w: Work) => string | null) => {
    const m = new Map<string, Work[]>()
    for (const w of works) {
      const k = keyOf(w)
      if (k === null) continue
      const g = m.get(k)
      if (g) g.push(w)
      else m.set(k, [w])
    }
    return m
  }
  if (settings.dependencies.sameItem) chain(groupBy((w) => (w.line.itemCode ? `${norm(w.line.orderNumber)}|${norm(w.line.itemCode)}` : null)))
  if (settings.dependencies.orderProcess) chain(groupBy((w) => norm(w.line.orderNumber)))
  for (const w of works) {
    w.waiting = w.preds.length
    w.op.dependsOn = w.preds.map((p) => p.line.lineKey)
  }

  // ---- 4 & 5. Order and place ----
  const before = (a: Work, b: Work) => {
    for (let i = 0; i < a.key.length; i++) {
      if (a.key[i] < b.key[i]) return true
      if (a.key[i] > b.key[i]) return false
    }
    return false
  }
  const ready = new Heap<Work>(before)
  for (const w of works) if (w.waiting === 0) ready.push(w)
  const busy = new Map<string, [number, number][]>()
  const limit = now + settings.horizonDays * MINUTES_PER_DAY
  const overlap = Math.max(0, Math.min(100, settings.overlapPct)) / 100
  const lag = Math.max(0, settings.finishLagMinutes)
  const done = new Set<Work>()
  const remaining = new Set(works)

  const placeOne = (w: Work, ignoreUnplaced: boolean) => {
    const cal = calendars.get(w.line.machineKey)!
    const minutes = Math.max(1, Math.round(w.op.hours * 60))
    let est = w.release
    let minEnd = -Infinity
    let blocked = false
    for (const p of w.preds) {
      if (p.op.start === null || p.op.end === null) {
        if (!ignoreUnplaced || done.has(p)) blocked = true
        continue
      }
      est = Math.max(est, p.op.start + Math.round((1 - overlap) * (p.op.end - p.op.start)))
      minEnd = Math.max(minEnd, p.op.end + lag)
    }
    if (blocked) {
      w.op.flags.push('no-capacity')
      return
    }
    const intervals = busy.get(w.line.machineKey) ?? []
    for (let attempt = 0; attempt < 60; attempt++) {
      const slot = freeSlot(cal, intervals, est, minutes, limit)
      if (!slot) {
        w.op.flags.push(est > limit ? 'beyond-horizon' : 'no-capacity')
        return
      }
      if (slot.end < minEnd) {
        est = slot.start + (minEnd - slot.end)
        continue
      }
      w.op.start = slot.start
      w.op.end = slot.end
      insertInterval(intervals, [slot.start, slot.end])
      busy.set(w.line.machineKey, intervals)
      return
    }
    w.op.flags.push('no-capacity')
  }

  const finish = (w: Work) => {
    done.add(w)
    remaining.delete(w)
    for (const s of w.succs) if (--s.waiting === 0 && remaining.has(s)) ready.push(s)
  }
  while (remaining.size > 0) {
    let w = ready.pop()
    let cycle = false
    if (!w) {
      // What is left waits on itself (a loop in the ERP's parent ids): the first in order goes ahead regardless.
      w = [...remaining].sort((a, b) => (before(a, b) ? -1 : before(b, a) ? 1 : 0))[0]
      cycle = true
      w.op.flags.push('cycle')
    }
    if (done.has(w)) continue
    placeOne(w, cycle)
    finish(w)
  }

  // ---- The result ----
  const operations = works.map((w) => w.op)
  const perMachine = new Map<string, PlanOperation[]>()
  for (const op of operations) {
    const list = perMachine.get(op.machineKey)
    if (list) list.push(op)
    else perMachine.set(op.machineKey, [op])
  }
  for (const list of perMachine.values()) {
    list.sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity) || a.lineKey.localeCompare(b.lineKey))
    list.forEach((op, i) => (op.seq = i + 1))
  }
  for (const op of operations) {
    if (op.end !== null && op.dueDate && isDay(op.dueDate)) {
      const dueEnd = dayStartWall(addDays(op.dueDate, 1))
      op.lateDays = op.end > dueEnd ? Math.ceil((op.end - dueEnd) / MINUTES_PER_DAY) : 0
    }
  }
  operations.sort((a, b) => a.machineKey.localeCompare(b.machineKey) || a.seq - b.seq)
  const order = [...works].sort((a, b) => (before(a, b) ? -1 : before(b, a) ? 1 : 0)).map((w) => w.line.id)
  return { now, operations, excluded, summary: summarise(operations, excluded.length), warnings: [...new Set(warnings)], order }
}

/** The line's raw material is in: received at least what it needs, or something received when the need is not known. */
export function materialReceived(line: Pick<PlanLine, 'rawMaterialQty' | 'rmReceivedQty'>): boolean {
  if (line.rmReceivedQty === null || line.rmReceivedQty <= 0) return false
  if (line.rawMaterialQty === null || line.rawMaterialQty <= 0) return true
  return line.rmReceivedQty >= line.rawMaterialQty
}

function insertInterval(list: [number, number][], iv: [number, number]) {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (list[mid][0] < iv[0]) lo = mid + 1
    else hi = mid
  }
  list.splice(lo, 0, iv)
}

/**
 * The earliest placing of `minutes` of work from `from` that overlaps none of
 * the machine's placed work (sorted, apart): tried in each gap between them
 * long enough on the clock to hold it, then after the last.
 */
function freeSlot(cal: MachineCalendar, busy: readonly [number, number][], from: number, minutes: number, limit: number): { start: number; end: number } | null {
  // The first piece of placed work that ends after `from` (their ends are in order too).
  let lo = 0
  let hi = busy.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (busy[mid][1] <= from) lo = mid + 1
    else hi = mid
  }
  let t = from
  for (let i = lo; ; i++) {
    const nextStart = i < busy.length ? busy[i][0] : Infinity
    // Working minutes are never more than the clock's: a shorter gap cannot hold it.
    if (nextStart - t >= minutes) {
      const p = cal.place(t, minutes, limit)
      if (!p) return null
      if (p.end <= nextStart) return p
    }
    if (i >= busy.length) return null
    t = Math.max(t, busy[i][1])
  }
}

export function summarise(operations: readonly PlanOperation[], excluded: number): PlanSummary {
  let placed = 0
  let late = 0
  let withDue = 0
  let onTime = 0
  let lateWeightKg = 0
  let maxLateDays = 0
  let hours = 0
  let assumedHours = 0
  let lastFinish: number | null = null
  for (const op of operations) {
    hours += op.hours
    if (op.durationSource === 'assumed') assumedHours += op.hours
    if (op.end === null) continue
    placed++
    lastFinish = lastFinish === null ? op.end : Math.max(lastFinish, op.end)
    if (op.dueDate) {
      withDue++
      if (op.lateDays > 0) {
        late++
        lateWeightKg += op.weightKg ?? 0
        maxLateDays = Math.max(maxLateDays, op.lateDays)
      } else onTime++
    }
  }
  return {
    lines: operations.length,
    placed,
    unplaced: operations.length - placed,
    late,
    onTimePct: withDue > 0 ? Math.round((onTime / withDue) * 1000) / 10 : null,
    lateWeightKg: Math.round(lateWeightKg),
    maxLateDays,
    hours: Math.round(hours * 10) / 10,
    assumedHours: Math.round(assumedHours * 10) / 10,
    lastFinish,
    excluded,
  }
}
