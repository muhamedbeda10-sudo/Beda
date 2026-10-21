// ============================================================================
// §25 — Planning (a trial): the factories' map with what each machine is on,
// the automatic plan, plans and what-if scenarios, load, lateness, material,
// plan against actual, what the data lacks, and planning's setup. Every
// route needs the Planning screen (§14); making and changing plans needs
// "Make plans and scenarios", publishing "Publish the plan", the calendar,
// capacities, paces, settings and map "Planning setup".
//
// It reads the order sheet, the production record and the inspections and
// writes only planning's own tables (migration 0075).
// ============================================================================

import { Router, type Request } from 'express'
import { z } from 'zod'
import {
  AUTO_PLAN_ID,
  type CalendarResponse,
  type CapacityResponse,
  type ComparisonResponse,
  type DataGapsResponse,
  type FloorResponse,
  type LoadResponse,
  type MaterialsResponse,
  type OverviewResponse,
  type PlanDetail,
  type PlanVsActualResponse,
  type PlansResponse,
  type QuoteResponse,
  type AdviseResponse,
  type RatesResponse,
  type RoutesResponse,
  type SettingsResponse,
} from '@qc/shared/planning'
import type { AppContext } from '../context'
import { requirePermission, requireUser, userCan } from '../auth/middleware'
import { forbidden } from '../lib/errors'
import { parse } from '../lib/validate'
import { clearLayout, floorNow, saveLayout } from '../planning/floor'
import { learnFromRecord } from '../planning/learn'
import { archivePlan, comparePlanWith, createPlan, deletePlan, keepAutoPlan, listPlans, planDetail, publishPlan, updatePlan, type Planner } from '../planning/plans'
import { advise, quote } from '../planning/quote'
import { dataGaps, materials, overview, planLoad, planVsActual } from '../planning/reports'
import { calendarBetween, capacities, clearCalendarDay, clearCapacity, clearRate, rates, routes, saveSettings, setCalendarDay, setCapacity, setRate, settings } from '../planning/setup'

const planId = z.union([z.literal(AUTO_PLAN_ID), z.string().uuid()])
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a day, YYYY-MM-DD')
const version = z.object({ version: z.number().int().min(0) }).strict()

const createSchema = z
  .object({
    kind: z.enum(['plan', 'scenario']),
    name: z.string().trim().min(1).max(120),
    description: z.string().max(2000).optional(),
    fromId: planId.optional(),
    events: z.array(z.unknown()).max(200).optional(),
    settings: z.record(z.unknown()).optional(),
  })
  .strict()

const updateSchema = z
  .object({
    version: z.number().int().min(0),
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().max(2000).optional(),
    events: z.array(z.unknown()).max(200).optional(),
    settings: z.record(z.unknown()).optional(),
  })
  .strict()

const layoutSchema = z
  .object({
    positions: z
      .array(z.object({ machineKey: z.string().trim().min(1).max(60), x: z.number().int(), y: z.number().int(), w: z.number().int(), h: z.number().int() }).strict())
      .max(500),
  })
  .strict()

const capacitySchema = z
  .object({
    hoursPerDay: z.number().finite().min(0).max(24),
    efficiency: z.number().finite().min(0.1).max(3).nullable(),
    worksFridays: z.boolean(),
    note: z.string().max(500).optional(),
  })
  .strict()

const rateSchema = z
  .object({ machineKey: z.string().trim().min(1).max(60), itemFamily: z.string().max(60), piecesPerHour: z.number().finite().positive().max(1e8), note: z.string().max(500).optional() })
  .strict()

const calendarSchema = z.object({ working: z.boolean(), name: z.string().trim().min(1).max(120) }).strict()
const quoteItem = z
  .object({
    itemCode: z.string().trim().min(1).max(120),
    qty: z.number().finite().positive().max(1e9),
    item: z.string().trim().min(1).max(300).optional(),
    weightKg: z.number().finite().min(0).max(1e9).nullable().optional(),
    steps: z.array(z.object({ machineKey: z.string().trim().min(1).max(60), hours: z.number().finite().positive().max(10_000).optional() }).strict()).min(1).max(12).optional(),
  })
  .strict()
const basePlan = z.union([z.literal('auto'), z.literal('published'), z.string().uuid()]).optional()
const quoteSchema = z
  .object({ orderNumber: z.string().trim().max(120).optional(), customer: z.string().trim().max(200).optional(), dueDate: day.nullable().optional(), items: z.array(quoteItem).min(1).max(50), basePlan })
  .strict()
const adviseSchema = z
  .object({ orderNumber: z.string().trim().min(1).max(120).optional(), newOrder: quoteSchema.omit({ basePlan: true }).optional(), dueDate: day, basePlan })
  .strict()
const settingsSchema = z.object({ settings: z.record(z.unknown()), version: z.number().int().min(0) }).strict()

export function planningRoutes(ctx: AppContext): Router {
  const r = Router()
  const { db, config } = ctx
  r.use(requirePermission('view-planning'))

  const plannerOf = (req: Request): Planner => {
    const u = requireUser(req)
    return { id: u.id, name: u.name, canEdit: userCan(u, 'edit-planning'), canPublish: userCan(u, 'publish-plan') }
  }
  const setupBy = (req: Request): Planner => {
    const u = requireUser(req)
    if (!userCan(u, 'manage-planning-setup')) throw forbidden('Planning’s setup is changed by people with the permission “Planning setup”.')
    return plannerOf(req)
  }

  // ---- What the factory looks like now ----

  r.get('/overview', async (req, res) => {
    const body: OverviewResponse = await overview(db, config, plannerOf(req))
    res.json(body)
  })

  r.get('/floor', async (req, res) => {
    const body: FloorResponse = await floorNow(db, config, plannerOf(req))
    res.json(body)
  })

  r.put('/layout', async (req, res) => {
    const planner = setupBy(req)
    await saveLayout(db, planner, parse(layoutSchema, req.body))
    res.status(204).end()
  })

  r.delete('/layout/:machineKey', async (req, res) => {
    const planner = setupBy(req)
    await clearLayout(db, planner, [String(req.params.machineKey)])
    res.status(204).end()
  })

  // ---- A delivery date for a customer, and advice to meet one (nothing kept) ----

  r.post('/quote', async (req, res) => {
    const body: QuoteResponse = await quote(db, config, plannerOf(req), parse(quoteSchema, req.body))
    res.json(body)
  })

  r.post('/advise', async (req, res) => {
    const body: AdviseResponse = await advise(db, config, plannerOf(req), parse(adviseSchema, req.body))
    res.json(body)
  })

  // ---- Plans and scenarios ----

  r.get('/plans', async (req, res) => {
    const body: PlansResponse = { plans: await listPlans(db, config, plannerOf(req)) }
    res.json(body)
  })

  r.post('/plans', async (req, res) => {
    const planner = plannerOf(req)
    const body = parse(createSchema, req.body)
    const id = await createPlan(db, config, planner, body as Parameters<typeof createPlan>[3])
    const detail: PlanDetail = await planDetail(db, config, planner, id)
    res.status(201).json(detail)
  })

  r.get('/plans/:id', async (req, res) => {
    const id = parse(planId, req.params.id)
    const body: PlanDetail = await planDetail(db, config, plannerOf(req), id)
    res.json(body)
  })

  r.patch('/plans/:id', async (req, res) => {
    const planner = plannerOf(req)
    const id = parse(z.string().uuid(), req.params.id)
    await updatePlan(db, config, planner, id, parse(updateSchema, req.body) as Parameters<typeof updatePlan>[4])
    const body: PlanDetail = await planDetail(db, config, planner, id)
    res.json(body)
  })

  r.post('/plans/:id/publish', async (req, res) => {
    const planner = plannerOf(req)
    const id = parse(z.string().uuid(), req.params.id)
    await publishPlan(db, config, planner, id, parse(version, req.body).version)
    const body: PlanDetail = await planDetail(db, config, planner, id)
    res.json(body)
  })

  r.post('/plans/:id/archive', async (req, res) => {
    const planner = plannerOf(req)
    const id = parse(z.string().uuid(), req.params.id)
    await archivePlan(db, planner, id, parse(version, req.body).version)
    const body: PlanDetail = await planDetail(db, config, planner, id)
    res.json(body)
  })

  r.delete('/plans/:id', async (req, res) => {
    const planner = plannerOf(req)
    const id = parse(z.string().uuid(), req.params.id)
    await deletePlan(db, planner, id, parse(z.coerce.number().int().min(0), req.query.version))
    res.status(204).end()
  })

  r.get('/plans/:id/compare', async (req, res) => {
    const id = parse(planId, req.params.id)
    const withId = req.query.with === undefined ? undefined : parse(planId, req.query.with)
    const body: ComparisonResponse = await comparePlanWith(db, config, plannerOf(req), id, withId)
    res.json(body)
  })

  r.get('/plans/:id/load', async (req, res) => {
    const id = parse(planId, req.params.id)
    const weeks = parse(z.coerce.number().int().min(1).max(26).default(8), req.query.weeks)
    const body: LoadResponse = await planLoad(db, config, plannerOf(req), id, weeks)
    res.json(body)
  })

  // ---- Reading the plans against the factory ----

  r.get('/actual', async (req, res) => {
    const q = parse(z.object({ from: day, to: day }), req.query)
    const body: PlanVsActualResponse = await planVsActual(db, config, q.from, q.to)
    res.json(body)
  })

  r.get('/materials', async (_req, res) => {
    const body: MaterialsResponse = await materials(db, config)
    res.json(body)
  })

  r.get('/gaps', async (_req, res) => {
    const body: DataGapsResponse = await dataGaps(db, config)
    res.json(body)
  })

  // ---- Setup ----

  r.get('/setup/settings', async (_req, res) => {
    const body: SettingsResponse = await settings(db, config)
    res.json(body)
  })

  r.put('/setup/settings', async (req, res) => {
    const planner = setupBy(req)
    const body = parse(settingsSchema, req.body)
    await saveSettings(db, planner, body.settings, body.version)
    res.json(await settings(db, config))
  })

  r.get('/setup/calendar', async (req, res) => {
    const q = parse(z.object({ from: day, to: day }), req.query)
    const body: CalendarResponse = await calendarBetween(db, q.from, q.to)
    res.json(body)
  })

  r.put('/setup/calendar/:day', async (req, res) => {
    const planner = setupBy(req)
    await setCalendarDay(db, planner, parse(day, req.params.day), parse(calendarSchema, req.body))
    res.status(204).end()
  })

  r.delete('/setup/calendar/:day', async (req, res) => {
    const planner = setupBy(req)
    await clearCalendarDay(db, planner, parse(day, req.params.day))
    res.status(204).end()
  })

  r.get('/setup/capacity', async (_req, res) => {
    const body: CapacityResponse = await capacities(db, config)
    res.json(body)
  })

  r.put('/setup/capacity/:machineKey', async (req, res) => {
    const planner = setupBy(req)
    await setCapacity(db, planner, String(req.params.machineKey), parse(capacitySchema, req.body))
    res.status(204).end()
  })

  r.delete('/setup/capacity/:machineKey', async (req, res) => {
    const planner = setupBy(req)
    await clearCapacity(db, planner, String(req.params.machineKey))
    res.status(204).end()
  })

  r.get('/setup/rates', async (req, res) => {
    const machine = parse(z.string().trim().min(1).max(60).optional(), req.query.machine)
    const body: RatesResponse = await rates(db, machine)
    res.json(body)
  })

  r.put('/setup/rates', async (req, res) => {
    const planner = setupBy(req)
    await setRate(db, planner, parse(rateSchema, req.body))
    res.status(204).end()
  })

  r.delete('/setup/rates', async (req, res) => {
    const planner = setupBy(req)
    const q = parse(z.object({ machine: z.string().trim().min(1).max(60), family: z.string().max(60).default('') }), req.query)
    await clearRate(db, planner, q.machine, q.family)
    res.status(204).end()
  })

  r.get('/setup/routes', async (req, res) => {
    const q = parse(z.object({ q: z.string().max(120).optional(), process: z.string().max(20).optional(), limit: z.coerce.number().int().min(1).max(1000).optional() }), req.query)
    const body: RoutesResponse = await routes(db, q)
    res.json(body)
  })

  /** Learn again from the record now (it is also learnt every six hours), then keep the automatic plan. */
  r.post('/setup/learn', async (req, res) => {
    setupBy(req)
    const learnt = await learnFromRecord(db, config.FACTORY_TIMEZONE)
    if (learnt) await keepAutoPlan(db, config)
    res.json({ learnt })
  })

  return r
}
