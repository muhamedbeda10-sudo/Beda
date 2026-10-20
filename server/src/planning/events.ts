// ============================================================================
// §25 — a plan's events and settings as they arrive (from the app, or from
// the AI assistant): checked field by field, every problem named. A machine
// may be written by its code ("024", "STAM 24") or its key: either becomes
// ai.machine_key(code), as the engine names machines.
// ============================================================================

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { OPTIMISE_EFFORTS, PLANNING_PROCESSES, PLAN_OBJECTIVES, isDay, parseWall, type PlanEvent, type PlanSettings } from '@qc/shared/planning'
import type { Queryable } from '../db/pool'

/** The most events one plan holds. */
export const MAX_PLAN_EVENTS = 200

const day = z.string().trim().refine(isDay, 'a day, YYYY-MM-DD')
const time = z.string().trim().refine((s) => parseWall(s) !== null, 'a time on the factory clock, "YYYY-MM-DD HH:MM"')
const ref = z.string().trim().min(1).max(120)
const optRef = ref.optional()
const machine = z.string().trim().min(1).max(60)
const note = z.string().trim().max(300).optional()
const id = z.string().trim().min(1).max(60).optional()

const eventSchema = z.discriminatedUnion('type', [
  z.object({ id, note, type: z.literal('machine-down'), machineKey: machine, from: time, to: time }).strict(),
  z.object({ id, note, type: z.literal('capacity'), machineKey: machine, fromDay: day, toDay: day, hoursPerDay: z.number().finite().min(0).max(24) }).strict(),
  z.object({ id, note, type: z.literal('working-day'), day, working: z.boolean(), machineKey: machine.optional() }).strict(),
  z.object({ id, note, type: z.literal('speed'), machineKey: machine, speedPct: z.number().finite().min(10).max(500) }).strict(),
  z.object({ id, note, type: z.literal('move'), lineKey: ref, toMachineKey: machine }).strict(),
  z.object({ id, note, type: z.literal('priority'), lineKey: optRef, orderNumber: optRef, customer: z.string().trim().min(1).max(200).optional() }).strict(),
  z.object({ id, note, type: z.literal('not-before'), lineKey: ref, at: time }).strict(),
  z.object({ id, note, type: z.literal('material'), lineKey: optRef, orderNumber: optRef, availableDay: day }).strict(),
  z.object({ id, note, type: z.literal('exclude'), lineKey: optRef, orderNumber: optRef }).strict(),
  z.object({ id, note, type: z.literal('due'), lineKey: optRef, orderNumber: optRef, dueDate: day }).strict(),
  z.object({ id, note, type: z.literal('quantity'), lineKey: ref, remainingQty: z.number().finite().min(0).max(1e9) }).strict(),
  z
    .object({
      id,
      note,
      type: z.literal('add-order'),
      orderNumber: z.string().trim().min(1).max(120),
      item: z.string().trim().min(1).max(300),
      customer: z.string().trim().max(200).default(''),
      machineKey: machine,
      qty: z.number().finite().positive().max(1e9),
      hours: z.number().finite().positive().max(10_000),
      dueDate: day.nullable().default(null),
      notBefore: time.optional(),
    })
    .strict(),
])

export const eventsSchema = z.array(eventSchema).max(MAX_PLAN_EVENTS)

/** What each event needs besides its type, checked once it parsed. */
function eventProblems(e: z.infer<typeof eventSchema>, i: number): string[] {
  const at = `events[${i}] (${e.type})`
  const out: string[] = []
  if ((e.type === 'exclude' || e.type === 'due' || e.type === 'material') && !e.lineKey && !e.orderNumber) out.push(`${at}: name a lineKey or an orderNumber.`)
  if (e.type === 'priority' && !e.lineKey && !e.orderNumber && !e.customer) out.push(`${at}: name a lineKey, an orderNumber or a customer.`)
  if (e.type === 'machine-down' && parseWall(e.to)! <= parseWall(e.from)!) out.push(`${at}: "to" must be after "from".`)
  if (e.type === 'capacity' && e.toDay < e.fromDay) out.push(`${at}: toDay must not be before fromDay.`)
  return out
}

const processRank = z.object(Object.fromEntries(PLANNING_PROCESSES.map((p) => [p, z.number().int().min(1).max(9)])) as Record<(typeof PLANNING_PROCESSES)[number], z.ZodNumber>).partial().strict()

export const settingsSchema = z
  .object({
    sequenceRule: z.enum(['erp', 'due', 'fifo']),
    timeSource: z.enum(['erp-first', 'actual-first']),
    erpDurationMeaning: z.enum(['line', 'piece']),
    applyEfficiency: z.boolean(),
    overlapPct: z.number().finite().min(0).max(100),
    finishLagMinutes: z.number().int().min(0).max(7 * 24 * 60),
    includeHold: z.boolean(),
    materialGate: z.boolean(),
    defaultHoursPerDay: z.number().finite().min(0).max(24),
    defaultLineHours: z.number().finite().min(0.1).max(1000),
    dependencies: z.object({ parent: z.boolean(), sameItem: z.boolean(), orderProcess: z.boolean() }).partial().strict(),
    processRank,
    horizonDays: z.number().int().min(7).max(1095),
    optimise: z.enum(OPTIMISE_EFFORTS as [string, ...string[]]),
    objective: z.enum(PLAN_OBJECTIVES as [string, ...string[]]),
  })
  .partial()
  .strict()

export interface CheckedEvents {
  events: PlanEvent[]
  errors: string[]
}

/** Events as given, checked; every machine named turned into its key, every event given an id. */
export async function checkEvents(q: Queryable, input: unknown): Promise<CheckedEvents> {
  const parsed = eventsSchema.safeParse(input ?? [])
  if (!parsed.success) {
    return { events: [], errors: parsed.error.issues.map((i) => `events${i.path.length ? `[${i.path.join('].')}` : ''}: ${i.message}`) }
  }
  const errors = parsed.data.flatMap(eventProblems)
  const codes = new Set<string>()
  for (const e of parsed.data) {
    if ('machineKey' in e && e.machineKey) codes.add(e.machineKey)
    if (e.type === 'move') codes.add(e.toMachineKey)
  }
  const keys = await machineKeys(q, [...codes])
  const k = (code: string) => keys.get(code) ?? code
  const seen = new Set<string>()
  const events = parsed.data.map((e): PlanEvent => {
    let eid = e.id && !seen.has(e.id) ? e.id : randomUUID().slice(0, 8)
    while (seen.has(eid)) eid = randomUUID().slice(0, 8)
    seen.add(eid)
    const base = { ...e, id: eid }
    if ('machineKey' in base && base.machineKey) (base as { machineKey: string }).machineKey = k(base.machineKey)
    if (base.type === 'move') base.toMachineKey = k(base.toMachineKey)
    return base as PlanEvent
  })
  return { events, errors }
}

/** Events added to others, each id unique across both: an added one whose id is taken gets a new one. */
export function appendEvents(existing: readonly PlanEvent[], added: readonly PlanEvent[]): PlanEvent[] {
  const taken = new Set(existing.map((e) => e.id))
  return [
    ...existing,
    ...added.map((e) => {
      let id = e.id
      while (taken.has(id)) id = randomUUID().slice(0, 8)
      taken.add(id)
      return id === e.id ? e : { ...e, id }
    }),
  ]
}

/** ai.machine_key of each code, as the database works it out. */
export async function machineKeys(q: Queryable, codes: string[]): Promise<Map<string, string>> {
  if (codes.length === 0) return new Map()
  const { rows } = await q.query<{ code: string; key: string }>(`SELECT c AS code, ai.machine_key(c) AS key FROM unnest($1::text[]) c`, [codes])
  return new Map(rows.map((r) => [r.code, r.key]))
}

/** Settings as given, checked. */
export function checkSettings(input: unknown): { settings: Partial<PlanSettings>; errors: string[] } {
  const parsed = settingsSchema.safeParse(input ?? {})
  if (!parsed.success) return { settings: {}, errors: parsed.error.issues.map((i) => `settings${i.path.length ? `.${i.path.join('.')}` : ''}: ${i.message}`) }
  return { settings: parsed.data as Partial<PlanSettings>, errors: [] }
}
