// ============================================================================
// §25 — a delivery date for a customer, and advice to meet one.
//
// A quote lays an order not on the sheet yet (a new-order event, planned
// through each item's learnt route and pace) on a plan — the published one
// when there is one — and works the plan out again: when the order's last
// line finishes, taken in its turn and rushed ahead of everything, and what
// each does to the orders already there. Nothing is kept: the person keeps
// it as a scenario if they want to.
//
// The advice takes an order (on the sheet, or the same new one) and a day it
// must be done by, tries the remedies a planner would — rush it, work the
// Fridays, add hours a day on its machines, move its steps to the freest of
// the machines that make them, and all of those together — works each out
// and prices it by the settings' prices, so the person sees what meets the
// day and what it costs the other orders and the factory.
// ============================================================================

import { type AdviceOption, type AdviseRequest, type AdviseResponse, FRIDAY, type ItemRoute, type LineChange, type PlanEvent, type PlanOperation, type PlanResult, type PlanSettings, type QuoteOutcome, type QuoteRequest, type QuoteResponse, addDays, capacityOf, comparePlans, dayNumber, factoryDayOfWall, isDay, lateDaysAt, weekday } from '@qc/shared/planning'
import { calendarDay } from '@qc/shared/rules'
import type { Config } from '../config'
import type { Db } from '../db/pool'
import { badRequest } from '../lib/errors'
import { effectiveSettings, type PlanningBase } from './data'
import { appendEvents, checkEvents } from './events'
import { planBasis, workOut, type Planner } from './plans'

/** Lines of other orders a quote names at most. */
const MAX_IMPACTED = 40
/** Fridays the advice works at most. */
const MAX_FRIDAYS = 6

const QUOTE_ORDER = 'NEW'

interface Basis {
  name: string
  events: PlanEvent[]
  settings: Partial<PlanSettings>
}

async function basisOf(db: Db, which: QuoteRequest['basePlan']): Promise<Basis> {
  const b = await planBasis(db, which ?? 'published')
  return { name: b.name, events: b.events, settings: b.settings }
}

/** The new-order event of a request, checked as any event is (machines by code or key, every field named). */
async function newOrderEvent(db: Db, req: Omit<QuoteRequest, 'basePlan'>): Promise<{ event: PlanEvent; errors: string[] }> {
  // Checked as any event is: the fields are not trusted before that (the assistant's input is loose).
  const raw = {
    type: 'new-order',
    orderNumber: (typeof req.orderNumber === 'string' && req.orderNumber.trim()) || QUOTE_ORDER,
    customer: typeof req.customer === 'string' ? req.customer : '',
    dueDate: req.dueDate ?? null,
    items: Array.isArray(req.items) ? req.items : [],
  }
  const checked = await checkEvents(db, [raw])
  return { event: checked.events[0], errors: checked.errors }
}

const withRush = (e: PlanEvent): PlanEvent => ({ ...(e as Extract<PlanEvent, { type: 'new-order' }>), rush: true })

const isOf = (op: { orderNumber: string }, orderNumber: string) => op.orderNumber.trim().toLowerCase() === orderNumber.trim().toLowerCase()

/** Days the order's delivery (its last line done) falls after its lines' due days (0 when in time, or without a due day). */
function lateDaysOf(ops: readonly PlanOperation[]): number {
  const completes = completesOf(ops)
  return completes === null ? ops.reduce((m, o) => Math.max(m, o.lateDays), 0) : ops.reduce((m, o) => Math.max(m, lateDaysAt(completes, o.dueDate)), 0)
}

function completesOf(ops: readonly PlanOperation[]): number | null {
  if (ops.length === 0 || ops.some((o) => o.end === null)) return null
  return ops.reduce((m, o) => Math.max(m, o.end!), 0)
}

/** What the scenario does to the other orders, the target's own lines left out. */
function impact(base: PlanResult, scenario: PlanResult, orderNumber: string): { newlyLate: number; recovered: number; lateWeightKgDelta: number; lateTonneDaysDelta: number; impacted: LineChange[] } {
  const cmp = comparePlans(base, scenario, 10_000)
  const others = cmp.changes.filter((c) => !isOf(c, orderNumber) && !c.only)
  let newlyLate = 0
  let recovered = 0
  for (const c of others) {
    if (c.baseLateDays === 0 && c.scenarioLateDays > 0) newlyLate++
    if (c.baseLateDays > 0 && c.scenarioLateDays === 0) recovered++
  }
  const lateKg = (r: PlanResult) => r.operations.filter((o) => !isOf(o, orderNumber) && o.lateDays > 0).reduce((s, o) => s + (o.weightKg ?? 0), 0)
  const tonneDays = (r: PlanResult) => r.operations.filter((o) => !isOf(o, orderNumber)).reduce((s, o) => s + o.lateDays * (o.weightKg !== null && o.weightKg > 0 ? o.weightKg / 1000 : 1), 0)
  return {
    newlyLate,
    recovered,
    lateWeightKgDelta: Math.round(lateKg(scenario) - lateKg(base)),
    lateTonneDaysDelta: Math.round((tonneDays(scenario) - tonneDays(base)) * 10) / 10,
    impacted: others.slice(0, MAX_IMPACTED),
  }
}

function outcome(base: PlanningBase, baseResult: PlanResult, result: PlanResult, orderNumber: string): QuoteOutcome {
  const machines = new Map(base.machines.map((m) => [m.key, m]))
  const ops = result.operations.filter((o) => isOf(o, orderNumber)).sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity) || a.lineKey.localeCompare(b.lineKey))
  const completes = completesOf(ops)
  const i = impact(baseResult, result, orderNumber)
  return {
    lines: ops.map((o) => ({
      lineKey: o.lineKey,
      itemCode: o.itemCode,
      item: o.item,
      process: machines.get(o.machineKey)?.process ?? null,
      machineKey: o.machineKey,
      machineName: machines.get(o.machineKey)?.name ?? `Machine ${o.machineKey}`,
      qty: o.qty,
      hours: o.hours,
      durationSource: o.durationSource,
      start: o.start,
      end: o.end,
      lateDays: o.lateDays,
      flags: o.flags,
    })),
    completes,
    completesDay: completes === null ? null : factoryDayOfWall(completes),
    lateDays: lateDaysOf(ops),
    newlyLate: i.newlyLate,
    recovered: i.recovered,
    lateWeightKgDelta: i.lateWeightKgDelta,
    impacted: i.impacted,
  }
}

/** The items a new-order event could not plan: those the engine warned about. */
const unknownItemsOf = (result: PlanResult, eventId: string) =>
  result.warnings.flatMap((w) => {
    const m = w.match(new RegExp(`^Event new-order \\(${eventId}\\): no route is learnt for the item "(.+)" —`))
    return m ? [m[1]] : []
  })

export async function quote(db: Db, config: Config, _planner: Planner, req: QuoteRequest, now = new Date()): Promise<QuoteResponse> {
  if (!Array.isArray(req.items) || req.items.length === 0) throw badRequest('Name at least one item and its quantity.')
  const today = calendarDay(now, config.FACTORY_TIMEZONE)
  if (req.dueDate !== undefined && req.dueDate !== null) {
    if (!isDay(req.dueDate)) throw badRequest('dueDate: a day, YYYY-MM-DD.')
    if (req.dueDate < today) throw badRequest('The day wanted is past: name a day from today on.')
  }
  const basis = await basisOf(db, req.basePlan)
  const plain = await newOrderEvent(db, req)
  if (plain.errors.length > 0) throw badRequest(plain.errors.join(' '), { errors: plain.errors })
  const orderNumber = (plain.event as Extract<PlanEvent, { type: 'new-order' }>).orderNumber
  const { base, result: baseResult } = await workOut(db, config, basis.events, basis.settings, now)
  if (base.lines.some((l) => isOf(l, orderNumber))) throw badRequest(`An order "${orderNumber}" is on the sheet already: ask for advice on it instead, or name the new order otherwise.`)
  // Laid on the plan: its id may change if the plan's events hold it already, so the laid event is the one kept.
  const laid = appendEvents(basis.events, [plain.event])
  const event = laid[laid.length - 1]
  const asIs = await workOut(db, config, laid, basis.settings, now, baseResult.order)
  const rush = await workOut(db, config, [...basis.events, withRush(event)], basis.settings, now, baseResult.order)
  return {
    orderNumber,
    baseName: basis.name,
    now: baseResult.now,
    dueDate: req.dueDate ?? null,
    asIs: outcome(base, baseResult, asIs.result, orderNumber),
    rushed: outcome(base, baseResult, rush.result, orderNumber),
    unknownItems: unknownItemsOf(asIs.result, event.id),
    warnings: asIs.result.warnings.filter((w) => !w.includes('no route is learnt')),
    events: [event],
  }
}

// ---- Advice ---------------------------------------------------------------------------------------

interface Remedy {
  id: string
  name: string
  detail: string
  events: PlanEvent[]
  /** What it costs the factory, given the day the order is then done (the extra hours count until then, not until the due day). */
  cost: (completesDay: string | null) => { cost: number; lines: string[] }
}

/** The Fridays from tomorrow up to the due day. */
function fridaysUntil(today: string, dueDate: string): string[] {
  const out: string[] = []
  for (let d = addDays(today, 1); d <= dueDate && out.length < MAX_FRIDAYS; d = addDays(d, 1)) if (weekday(d) === FRIDAY) out.push(d)
  return out
}

/** Working days (not Fridays) from today up to the due day. */
function workingDaysUntil(today: string, dueDate: string): number {
  let n = 0
  for (let d = today; d <= dueDate; d = addDays(d, 1)) if (weekday(d) !== FRIDAY) n++
  return n
}

const money = (n: number) => Math.round(n * 100) / 100

/** The freest other machine that makes the same process of the item, by the plan's queues; null when there is none. */
function alternative(route: ItemRoute | undefined, process: string | null, current: string, queueDays: ReadonlyMap<string, number>): string | null {
  if (!route || !process) return null
  const step = route.steps.find((s) => s.process === process)
  if (!step) return null
  const others = step.machines.filter((m) => m.machineKey !== current).sort((a, b) => (queueDays.get(a.machineKey) ?? 0) - (queueDays.get(b.machineKey) ?? 0) || b.lines - a.lines)
  const best = others[0]
  if (!best) return null
  return (queueDays.get(best.machineKey) ?? 0) < (queueDays.get(current) ?? 0) ? best.machineKey : null
}

export async function advise(db: Db, config: Config, _planner: Planner, req: AdviseRequest, now = new Date()): Promise<AdviseResponse> {
  const tz = config.FACTORY_TIMEZONE
  const today = calendarDay(now, tz)
  if (!req.dueDate || !isDay(req.dueDate)) throw badRequest('Name the day the order must be done by, YYYY-MM-DD.')
  if (req.dueDate < today) throw badRequest('The day is past: name a day from today on.')
  if (!req.orderNumber && !req.newOrder) throw badRequest('Name an order on the sheet, or a new one by its items.')
  const basis = await basisOf(db, req.basePlan)
  const { base, settings, result: baseResult } = await workOut(db, config, basis.events, basis.settings, now)
  const warnings: string[] = []

  // The target: an order on the sheet (its open lines), or a new one laid on the plan first.
  let orderNumber: string
  let own: PlanEvent[] = []
  let isNew = false
  if (req.newOrder) {
    if (typeof req.newOrder !== 'object') throw badRequest('newOrder: the order by its items.')
    const ev = await newOrderEvent(db, { ...req.newOrder, dueDate: req.dueDate })
    if (ev.errors.length > 0) throw badRequest(ev.errors.join(' '), { errors: ev.errors })
    orderNumber = (ev.event as Extract<PlanEvent, { type: 'new-order' }>).orderNumber
    // Laid on the plan under an id its events do not hold.
    const laid = appendEvents(basis.events, [ev.event])
    own = [laid[laid.length - 1]]
    isNew = true
  } else {
    orderNumber = req.orderNumber!.trim()
    if (!baseResult.operations.some((o) => isOf(o, orderNumber))) throw badRequest(`No open line of the plan belongs to order "${orderNumber}".`)
  }
  // The order laid on the plan as it stands: the plan itself for an order on the sheet.
  const asIsRun = own.length > 0 ? await workOut(db, config, appendEvents(basis.events, own), basis.settings, now, baseResult.order) : { result: baseResult }
  const targetOps = asIsRun.result.operations.filter((o) => isOf(o, orderNumber))
  if (targetOps.length === 0) throw badRequest(isNew ? 'None of the items could be planned: the record knows no route for them. Give each item its steps (a machine and its hours).' : `No open line of the plan belongs to order "${orderNumber}".`)
  const machines = [...new Set(targetOps.map((o) => o.machineKey))]
  const caps = new Map(base.capacities.map((c) => [c.machineKey, c]))
  const names = new Map(base.machines.map((m) => [m.key, m.name]))
  const nameOf = (k: string) => names.get(k) ?? `Machine ${k}`
  const priced = settings.costFridayMachineDay > 0 || settings.costExtraMachineHour > 0 || settings.costLateTonneDay > 0

  // Each machine's queue in days of its own work, by the plan: for the move remedy.
  const queueDays = new Map<string, number>()
  for (const o of baseResult.operations) {
    const c = capacityOf(caps, o.machineKey, settings)
    queueDays.set(o.machineKey, (queueDays.get(o.machineKey) ?? 0) + (c.hoursPerDay > 0 ? o.hours / c.hoursPerDay : 0))
  }
  const routes = new Map(base.routes.map((r) => [r.itemCode.toLowerCase(), r]))
  const processOf = new Map(base.machines.map((m) => [m.key, m.process]))

  // ---- The remedies ----
  const rushEvent = (): PlanEvent[] => (isNew ? [withRush(own[0])] : [{ id: 'adv-rush', type: 'priority', orderNumber }])
  const fridays = fridaysUntil(today, req.dueDate)
  const fridayEvents = (days: string[]): PlanEvent[] => days.flatMap((day) => machines.map((m): PlanEvent => ({ id: `adv-fri-${day}-${m}`, type: 'working-day', day, working: true, machineKey: m })))
  // A machine's hours a day as the plan has them: the setup's, or more when the plan's own events give it more over these days.
  const hoursNow = (m: string): number => {
    let h = capacityOf(caps, m, settings).hoursPerDay
    for (const e of basis.events) if (e.type === 'capacity' && e.machineKey === m && e.fromDay <= req.dueDate && e.toDay >= today) h = Math.max(h, e.hoursPerDay)
    return h
  }
  const extraEvents = (plus: number): PlanEvent[] => machines.map((m): PlanEvent => ({ id: `adv-h${plus}-${m}`, type: 'capacity', machineKey: m, fromDay: today, toDay: req.dueDate, hoursPerDay: Math.min(24, hoursNow(m) + plus) }))
  const fridayCost = (days: string[]) => ({ cost: days.length * machines.length * settings.costFridayMachineDay, lines: days.length > 0 ? [`${days.length} Friday${days.length === 1 ? '' : 's'} × ${machines.length} machines`] : [] })
  const extraCost = (plus: number, completesDay: string | null) => {
    const days = workingDaysUntil(today, completesDay && completesDay < req.dueDate ? completesDay : req.dueDate)
    const hours = machines.reduce((s, m) => s + Math.max(0, Math.min(24, hoursNow(m) + plus) - hoursNow(m)), 0)
    return { cost: hours * days * settings.costExtraMachineHour, lines: [`${plus} h × ${machines.length} machines × ${days} days`] }
  }
  const both = (a: { cost: number; lines: string[] }, b: { cost: number; lines: string[] }) => ({ cost: a.cost + b.cost, lines: [...a.lines, ...b.lines] })
  const free = () => ({ cost: 0, lines: [] })
  const machineList = machines.map(nameOf).join(', ')

  const remedies: Remedy[] = []
  remedies.push({ id: 'rush', name: 'Rush it', detail: `Ahead of everything else on ${machineList}.`, events: rushEvent(), cost: free })
  if (fridays.length > 0) {
    const first = fridays.slice(0, 1)
    remedies.push({ id: 'rush-friday', name: 'Rush it and work next Friday', detail: `${machineList} work ${first[0]}.`, events: [...rushEvent(), ...fridayEvents(first)], cost: () => fridayCost(first) })
    if (fridays.length > 1)
      remedies.push({ id: 'rush-fridays', name: 'Rush it and work every Friday until then', detail: `${machineList} work ${fridays.join(', ')}.`, events: [...rushEvent(), ...fridayEvents(fridays)], cost: () => fridayCost(fridays) })
  }
  for (const plus of [2, 4]) {
    remedies.push({
      id: `rush-hours-${plus}`,
      name: `Rush it and add ${plus} hours a day`,
      detail: `${machineList} work ${plus} more hours a day from today until it is done.`,
      events: [...rushEvent(), ...extraEvents(plus)],
      cost: (done) => extraCost(plus, done),
    })
  }
  // Move: each line of the order to the freest other machine of its process, when there is one.
  const moves: PlanEvent[] = []
  const moved: string[] = []
  if (isNew) {
    const ev = own[0] as Extract<PlanEvent, { type: 'new-order' }>
    const items = ev.items.map((it, i) => {
      const route = routes.get(it.itemCode.toLowerCase())
      if (!route || (it.steps && it.steps.length > 0)) return it
      // This item's own steps, by the lines' keys (the engine names them NEW-<event>-<item>-<step>), in step order.
      const ownOps = targetOps.filter((o) => o.lineKey.startsWith(`NEW-${ev.id}-${i + 1}-`)).sort((a, b) => a.lineKey.localeCompare(b.lineKey, undefined, { numeric: true }))
      const steps = ownOps.map((o) => {
        const alt = alternative(route, processOf.get(o.machineKey) ?? null, o.machineKey, queueDays)
        if (alt) moved.push(`${it.itemCode}: ${nameOf(o.machineKey)} → ${nameOf(alt)}`)
        return { machineKey: alt ?? o.machineKey }
      })
      return steps.length > 0 ? { ...it, steps } : it
    })
    if (moved.length > 0) moves.push({ ...ev, rush: true, items })
  } else {
    for (const o of targetOps) {
      const alt = alternative(routes.get(o.itemCode.toLowerCase()), processOf.get(o.machineKey) ?? null, o.machineKey, queueDays)
      if (alt) {
        moves.push({ id: `adv-move-${o.lineKey}`, type: 'move', lineKey: o.lineKey, toMachineKey: alt })
        moved.push(`${o.lineKey}: ${nameOf(o.machineKey)} → ${nameOf(alt)}`)
      }
    }
    if (moves.length > 0) moves.unshift(...rushEvent())
  }
  if (moves.length > 0) remedies.push({ id: 'rush-move', name: 'Rush it on freer machines', detail: moved.join('; '), events: moves, cost: free })
  remedies.push({
    id: 'all',
    name: 'Everything: rush, Fridays and 4 more hours a day',
    detail: `${machineList}: every Friday until then and 4 more hours a day.`,
    events: [...rushEvent(), ...fridayEvents(fridays), ...extraEvents(4)],
    cost: (done) => both(fridayCost(fridays), extraCost(4, done)),
  })

  // ---- Each worked out, against the plan as it stands ----
  const evaluate = async (r: Remedy): Promise<AdviceOption> => {
    // A new order's remedies carry its own event (rushed, or on other machines); "as it stands" lays it on as it is.
    const events = isNew ? appendEvents(basis.events, r.events.length > 0 ? r.events : own) : appendEvents(basis.events, [...own, ...r.events])
    const { result } = await workOut(db, config, events, basis.settings, now, baseResult.order)
    const ops = result.operations.filter((o) => isOf(o, orderNumber))
    const completes = completesOf(ops)
    const completesDay = completes === null ? null : factoryDayOfWall(completes)
    const i = impact(baseResult, result, orderNumber)
    const priceOf = r.cost(completesDay)
    const lateCost = Math.max(0, i.lateTonneDaysDelta) * settings.costLateTonneDay
    const costLines = [...priceOf.lines, ...(lateCost > 0 ? [`${i.lateTonneDaysDelta} tonne-days late added to other orders`] : [])]
    return {
      id: r.id,
      name: r.name,
      detail: r.detail,
      events: isNew ? (r.events.length > 0 ? r.events : own) : [...own, ...r.events],
      completes,
      completesDay,
      meetsDue: completesDay !== null && completesDay <= req.dueDate,
      lateDays: completesDay === null ? 999 : Math.max(0, dayNumber(completesDay) - dayNumber(req.dueDate)),
      newlyLate: i.newlyLate,
      recovered: i.recovered,
      lateTonneDaysDelta: i.lateTonneDaysDelta,
      cost: priced ? money(priceOf.cost + lateCost) : null,
      costLines,
    }
  }
  const asIs = await evaluate({ id: 'as-is', name: 'As the plan stands', detail: isNew ? 'Taken in its turn, by the sequence rule.' : 'Nothing changed.', events: [], cost: free })
  const options: AdviceOption[] = []
  for (const r of remedies) options.push(await evaluate(r))
  const meets = options.filter((o) => o.meetsDue)
  const byCost = (a: AdviceOption, b: AdviceOption) => (a.cost ?? 0) - (b.cost ?? 0) || a.newlyLate - b.newlyLate || a.lateTonneDaysDelta - b.lateTonneDaysDelta
  const best = asIs.meetsDue ? asIs : meets.length > 0 ? [...meets].sort(byCost)[0] : [...options].sort((a, b) => a.lateDays - b.lateDays || byCost(a, b))[0]
  if (fridays.length === 0) warnings.push('No Friday falls before the day: the Friday options are not offered.')
  if (!priced) warnings.push('Nothing is priced: set the prices under Planning → Settings for the options to carry a cost.')
  return {
    target: { orderNumber, lines: targetOps.length, machines, isNew },
    dueDate: req.dueDate,
    baseName: basis.name,
    now: baseResult.now,
    asIs,
    options,
    bestId: best?.id ?? null,
    priced,
    warnings: [...warnings, ...asIsRun.result.warnings],
  }
}

