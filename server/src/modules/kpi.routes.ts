// §15 — the quality dashboard. One overview call assembles every figure for
// a period and its comparison; the thresholds that colour them live in
// app_settings and are edited by an administrator, with the old values in
// the audit log.

import { Router } from 'express'
import { z } from 'zod'
import {
  DASHBOARD_COLS,
  DASHBOARD_HINT_MAX,
  DASHBOARD_MAX_H,
  DASHBOARD_TITLE_MAX,
  DEFAULT_KPI_THRESHOLDS,
  GENERAL_MONTHS,
  defaultDashboardLayouts,
  normaliseDashboardLayouts,
  INSIGHT_KEY_MAX,
  RANKING_WEIGHTS,
  pct,
  rankInspectors,
  type KpiBreakdown,
  type KpiFilters,
  type KpiGeneral,
  type KpiInspectorRanking,
  type KpiInspectorRaw,
  type KpiListCounts,
  type KpiOverview,
  type KpiThresholds,
} from '@qc/shared/kpi'
import type { DashboardLayoutResponse, HiddenInsightRequest, HiddenInsightsResponse, KpiSpanResponse, KpiThresholdsResponse, SaveDashboardLayoutRequest } from '@qc/shared/api'
import { PROCESSES, type Process } from '@qc/shared/types'
import type { AppContext } from '../context'
import type { Queryable } from '../db/pool'
import { withTransaction } from '../db/pool'
import { parse } from '../lib/validate'
import { badRequest } from '../lib/errors'
import { requireCapability, requireUser } from '../auth/middleware'
import { auditChanges } from '../audit/service'
import { buildInsights } from './kpi.insights'
import {
  loadBreakdown,
  loadDaily,
  loadDefectDetails,
  loadDefectRateBands,
  loadDiscipline,
  loadFactoryMonths,
  loadFirstDataMonth,
  loadFirstPart,
  loadScopeTotals,
  loadGroups,
  loadHolds,
  loadInspectorRaw,
  loadItemDefects,
  loadMachineMonths,
  loadMonthly,
  loadPaintByItem,
  loadPareto,
  loadParetoByMachine,
  loadSuppliers,
  loadTotals,
  type PeriodFilters,
} from './kpi.sql'

export const KPI_THRESHOLDS_KEY = 'kpi-thresholds'
export const DASHBOARD_LAYOUT_KEY = 'dashboard-layout'
const MAX_PERIOD_DAYS = 366

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
const optionalText = z.string().trim().min(1).max(120).optional()

const OverviewQuery = z.object({
  from: day,
  to: day,
  prevFrom: day,
  prevTo: day,
  factory: optionalText,
  process: optionalText,
  workCenterCode: optionalText,
  itemCode: optionalText,
  inspectorId: z.string().uuid().optional(),
  shift: z.enum(['A', 'B', 'C']).optional(),
})

/** One value, or several separated by commas: "24,25,31". */
function listOf(raw: string | undefined): string[] | undefined {
  const values = (raw ?? '').split(',').map((c) => c.trim()).filter(Boolean)
  return values.length ? Array.from(new Set(values)) : undefined
}
const machineCodes = listOf
const factoryNames = listOf
/** Process groups, each one of the register's; anything else is refused. */
function processNames(raw: string | undefined): Process[] | undefined {
  const values = listOf(raw)
  if (!values) return undefined
  for (const v of values) if (!(PROCESSES as readonly string[]).includes(v)) throw badRequest(`Process "${v}" is not one of the register's groups.`)
  return values as Process[]
}

const GeneralQuery = z.object({ from: day, to: day })

const BreakdownQuery = z.object({
  from: day,
  to: day,
  factory: optionalText,
  process: optionalText,
  workCenterCode: optionalText,
  itemCode: optionalText,
})

const layoutItem = z.object({
  i: z.string().trim().min(1).max(60),
  x: z.number().int().min(0).max(DASHBOARD_COLS - 1),
  y: z.number().int().min(0).max(100000),
  w: z.number().int().min(1).max(DASHBOARD_COLS),
  h: z.number().int().min(1).max(DASHBOARD_MAX_H),
  title: z.string().trim().max(DASHBOARD_TITLE_MAX).optional(),
  hint: z.string().trim().max(DASHBOARD_HINT_MAX).optional(),
  hidden: z.boolean().optional(),
})
const LayoutBody = z.object({ layouts: z.object({ general: z.array(layoutItem).max(100), details: z.array(layoutItem).max(100) }) })

const rate = z.number().min(0).max(100)
const ThresholdsBody = z
  .object({
    defectRateGreen: rate,
    defectRateAmber: rate,
    fpyGreen: rate,
    fpyAmber: rate,
    dimFailGreen: rate,
    dimFailAmber: rate,
    cpkGreen: z.number().min(0).max(10),
    cpkAmber: z.number().min(0).max(10),
    minReadingsForCpk: z.number().int().min(3).max(1000),
    ptRejectGreen: rate,
    ptRejectAmber: rate,
    holdAgeAmberDays: z.number().int().min(0).max(365),
    holdAgeRedDays: z.number().int().min(0).max(365),
    idleMachineDays: z.number().int().min(1).max(365),
    trendAlertPct: z.number().min(1).max(1000),
    minSamplesForRanking: z.number().int().min(1).max(1000),
  })
  .strict()
  .superRefine((t, ctx) => {
    const ordered: [keyof KpiThresholds, keyof KpiThresholds, string][] = [
      ['defectRateGreen', 'defectRateAmber', 'Defect rate: green must not exceed amber.'],
      ['dimFailGreen', 'dimFailAmber', 'Dimension failures: green must not exceed amber.'],
      ['ptRejectGreen', 'ptRejectAmber', 'PT rejects: green must not exceed amber.'],
      ['holdAgeAmberDays', 'holdAgeRedDays', 'Hold age: amber must not exceed red.'],
      ['fpyAmber', 'fpyGreen', 'First-pass yield: amber must not exceed green.'],
      ['cpkAmber', 'cpkGreen', 'Cpk: amber must not exceed green.'],
    ]
    for (const [low, high, message] of ordered) {
      if (t[low] > t[high]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [high], message })
    }
  })

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

function validDay(s: string): boolean {
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

/** Today's calendar day where the factory sits. */
function factoryToday(tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}

/** The YYYY-MM that is `n` months before this one. */
function monthsBefore(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number)
  const idx = y * 12 + (m - 1) - n
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`
}

/** Whole months from `from` to `to` (both YYYY-MM): 2026-06 to 2026-09 is 3. */
function monthsBetween(from: string, to: string): number {
  const [fy, fm] = from.split('-').map(Number)
  const [ty, tm] = to.split('-').map(Number)
  return ty * 12 + tm - (fy * 12 + fm)
}

function checkRange(from: string, to: string, label: string): void {
  if (!validDay(from) || !validDay(to)) throw badRequest(`${label}: not a calendar day.`)
  const n = daysBetween(from, to)
  if (n < 0) throw badRequest(`${label}: "from" is after "to".`)
  if (n + 1 > MAX_PERIOD_DAYS) throw badRequest(`${label}: at most ${MAX_PERIOD_DAYS} days.`)
}

/** The stored thresholds over the defaults, so a new key added later still has a value. */
export async function loadThresholds(q: Queryable): Promise<KpiThresholdsResponse> {
  const { rows } = await q.query<{ value: Partial<KpiThresholds>; updatedAt: string | null; updatedByName: string | null }>(
    `SELECT value, updated_at AS "updatedAt", updated_by_name AS "updatedByName" FROM app_settings WHERE key = $1`,
    [KPI_THRESHOLDS_KEY],
  )
  const row = rows[0]
  const thresholds: KpiThresholds = { ...DEFAULT_KPI_THRESHOLDS }
  if (row) {
    for (const key of Object.keys(DEFAULT_KPI_THRESHOLDS) as (keyof KpiThresholds)[]) {
      const v = row.value[key]
      if (typeof v === 'number' && Number.isFinite(v)) thresholds[key] = v
    }
  }
  return { thresholds, updatedAt: row?.updatedAt ?? undefined, updatedByName: row?.updatedByName ?? undefined }
}

/**
 * §16 — one inspector's work across every factory, as a single row. Counts
 * add up because a machine belongs to one factory and an order line to one
 * machine; the days worked are taken from the period's own count, since an
 * inspector on two factories on one day worked one day; and the detection
 * index is re-weighted by the pieces behind each factory's figure.
 */
function foldFactories(perFactory: KpiInspectorRaw[], activeDays: Map<string, number>): KpiInspectorRaw[] {
  const byInspector = new Map<string, KpiInspectorRaw[]>()
  for (const row of perFactory) {
    const rows = byInspector.get(row.inspectorId)
    if (rows) rows.push(row)
    else byInspector.set(row.inspectorId, [row])
  }
  return Array.from(byInspector, ([inspectorId, rows]) => {
    const sum = (pick: (r: KpiInspectorRaw) => number) => rows.reduce((n, r) => n + pick(r), 0)
    const weighed = rows.filter((r) => r.detectionIndex !== null)
    const weighedPieces = weighed.reduce((n, r) => n + r.pieces, 0)
    return {
      inspectorId,
      name: rows[0].name,
      factory: '',
      samples: sum((r) => r.samples),
      pieces: sum((r) => r.pieces),
      activeDays: activeDays.get(`${inspectorId}|`) ?? 0,
      lines: sum((r) => r.lines),
      machines: sum((r) => r.machines),
      dimensionRows: sum((r) => r.dimensionRows),
      dimensionsMeasured: sum((r) => r.dimensionsMeasured),
      coilsUsed: sum((r) => r.coilsUsed),
      coilsFromRegister: sum((r) => r.coilsFromRegister),
      sessionsClosed: sum((r) => r.sessionsClosed),
      sessionsClosedWithFinalQty: sum((r) => r.sessionsClosedWithFinalQty),
      emptySessions: sum((r) => r.emptySessions),
      sessionsOpened: sum((r) => r.sessionsOpened),
      corrections: sum((r) => r.corrections),
      reRecorded: sum((r) => r.reRecorded),
      defectRecords: sum((r) => r.defectRecords),
      detectionIndex: weighedPieces > 0 ? weighed.reduce((n, r) => n + (r.detectionIndex ?? 0) * r.pieces, 0) / weighedPieces : null,
    }
  })
}

export function kpiRoutes(ctx: AppContext): Router {
  const r = Router()
  r.use(requireCapability('view-dashboard'))

  /** The first day anything was recorded — where the period strip begins. */
  r.get('/span', async (_req, res) => {
    const { rows } = await ctx.db.query<{ firstDay: string | null }>(
      `SELECT to_char(LEAST(
                (SELECT min(started_at) FROM inspection_sessions WHERE deleted_at IS NULL),
                (SELECT min(created_at) FROM inspection_samples WHERE deleted_at IS NULL)
              ) AT TIME ZONE $1, 'YYYY-MM-DD') AS "firstDay"`,
      [ctx.config.FACTORY_TIMEZONE],
    )
    const body: KpiSpanResponse = { firstDay: rows[0]?.firstDay ?? null }
    res.json(body)
  })

  r.get('/thresholds', async (_req, res) => {
    res.json(await loadThresholds(ctx.db))
  })

  r.put('/thresholds', requireCapability('manage-admin-data'), async (req, res) => {
    const user = requireUser(req)
    const next = parse(ThresholdsBody, req.body)
    const body = await withTransaction(ctx.db, async (tx) => {
      const before = (await loadThresholds(tx)).thresholds
      await tx.query(
        `INSERT INTO app_settings (key, value, updated_by_id, updated_by_name, updated_at)
         VALUES ($1, $2::jsonb, $3, $4, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by_id = EXCLUDED.updated_by_id,
           updated_by_name = EXCLUDED.updated_by_name, updated_at = now()`,
        [KPI_THRESHOLDS_KEY, JSON.stringify(next), user.id, user.name],
      )
      await auditChanges(tx, { userId: user.id, userName: user.name, entity: 'AppSettings', entityId: KPI_THRESHOLDS_KEY }, { ...before }, { ...next })
      return loadThresholds(tx)
    })
    res.json(body)
  })

  // ---- The board's layout -----------------------------------------------------
  // One layout per page, the same for everyone; an administrator moves and
  // sizes the widgets. Stored beside the thresholds; the defaults show
  // until one is saved, and a widget added later lands below the rest.

  async function loadLayout(q: Queryable): Promise<DashboardLayoutResponse> {
    const { rows } = await q.query<{ value: unknown; updatedAt: string; updatedByName: string | null }>(
      `SELECT value, updated_at AS "updatedAt", updated_by_name AS "updatedByName" FROM app_settings WHERE key = $1`,
      [DASHBOARD_LAYOUT_KEY],
    )
    const row = rows[0]
    if (!row) return { layouts: defaultDashboardLayouts(), isDefault: true }
    return { layouts: normaliseDashboardLayouts(row.value), isDefault: false, updatedAt: row.updatedAt, updatedByName: row.updatedByName ?? undefined }
  }

  r.get('/layout', async (_req, res) => {
    res.json(await loadLayout(ctx.db))
  })

  r.put('/layout', requireCapability('manage-admin-data'), async (req, res) => {
    const user = requireUser(req)
    const body = parse(LayoutBody, req.body) as SaveDashboardLayoutRequest
    // Unknown widgets are dropped and missing ones appended, so what is stored is always whole.
    const layouts = normaliseDashboardLayouts(body.layouts)
    const out = await withTransaction(ctx.db, async (tx) => {
      const before = await loadLayout(tx)
      await tx.query(
        `INSERT INTO app_settings (key, value, updated_by_id, updated_by_name, updated_at)
         VALUES ($1, $2::jsonb, $3, $4, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by_id = EXCLUDED.updated_by_id,
           updated_by_name = EXCLUDED.updated_by_name, updated_at = now()`,
        [DASHBOARD_LAYOUT_KEY, JSON.stringify(layouts), user.id, user.name],
      )
      await auditChanges(
        tx,
        { userId: user.id, userName: user.name, entity: 'AppSettings', entityId: DASHBOARD_LAYOUT_KEY },
        { general: JSON.stringify(before.layouts.general), details: JSON.stringify(before.layouts.details) },
        { general: JSON.stringify(layouts.general), details: JSON.stringify(layouts.details) },
      )
      return loadLayout(tx)
    })
    res.json(out)
  })

  /** Back to the defaults: the saved layout is removed, and every page reads the code's own arrangement. */
  r.delete('/layout', requireCapability('manage-admin-data'), async (req, res) => {
    const user = requireUser(req)
    const out = await withTransaction(ctx.db, async (tx) => {
      const before = await loadLayout(tx)
      await tx.query(`DELETE FROM app_settings WHERE key = $1`, [DASHBOARD_LAYOUT_KEY])
      if (!before.isDefault) {
        await auditChanges(
          tx,
          { userId: user.id, userName: user.name, entity: 'AppSettings', entityId: DASHBOARD_LAYOUT_KEY },
          { general: JSON.stringify(before.layouts.general), details: JSON.stringify(before.layouts.details) },
          { general: 'default', details: 'default' },
        )
      }
      return loadLayout(tx)
    })
    res.json(out)
  })

  r.get('/overview', async (req, res) => {
    const q = parse(OverviewQuery, req.query)
    checkRange(q.from, q.to, 'Period')
    checkRange(q.prevFrom, q.prevTo, 'Comparison period')
    const { thresholds } = await loadThresholds(ctx.db)
    const tz = ctx.config.FACTORY_TIMEZONE
    const common = { tz, factories: factoryNames(q.factory), processes: processNames(q.process), workCenterCodes: machineCodes(q.workCenterCode), itemCode: q.itemCode, inspectorId: q.inspectorId, shift: q.shift }
    const cur: PeriodFilters = { ...common, from: q.from, to: q.to }
    const prev: PeriodFilters = { ...common, from: q.prevFrom, to: q.prevTo }
    const db = ctx.db
    const [
      current,
      previous,
      daily,
      monthly,
      pareto,
      defectDetails,
      byMachine,
      byMachinePrevious,
      byInspector,
      byShift,
      byItem,
      suppliers,
      holds,
      disciplineRaw,
      inspectorRaw,
      defectRateBands,
      paretoByMachine,
      itemDefects,
      paintByItem,
    ] = await Promise.all([
        loadTotals(db, cur),
        loadTotals(db, prev),
        loadDaily(db, cur),
        loadMonthly(db, cur),
        loadPareto(db, cur),
        loadDefectDetails(db, cur),
        loadGroups(db, cur, 'machine'),
        loadGroups(db, prev, 'machine'),
        loadGroups(db, cur, 'inspector'),
        loadGroups(db, cur, 'shift'),
        loadGroups(db, cur, 'item'),
        loadSuppliers(db, cur),
        loadHolds(db, cur),
        loadDiscipline(db, cur),
        loadInspectorRaw(db, cur),
        loadDefectRateBands(db, cur),
        loadParetoByMachine(db, cur),
        loadItemDefects(db, cur),
        loadPaintByItem(db, cur),
      ])

    // §16 — the ranking: one list across everything the filters match, and one
    // per factory, since the factories do not run the same work and a place
    // won in one says little about another.
    const factories = Array.from(new Set(inspectorRaw.perFactory.map((r) => r.factory))).sort((a, b) => a.localeCompare(b))
    const inspectorRanking: KpiInspectorRanking = {
      overall: rankInspectors(foldFactories(inspectorRaw.perFactory, inspectorRaw.activeDays), thresholds.minSamplesForRanking),
      byFactory: factories.map((name) => ({
        ...rankInspectors(
          inspectorRaw.perFactory.filter((r) => r.factory === name),
          thresholds.minSamplesForRanking,
        ),
        factory: name,
      })),
      minSamples: thresholds.minSamplesForRanking,
      weights: RANKING_WEIGHTS,
    }
    const filters: KpiFilters = {
      from: q.from,
      to: q.to,
      prevFrom: q.prevFrom,
      prevTo: q.prevTo,
      factories: factoryNames(q.factory),
      processes: processNames(q.process),
      workCenterCodes: machineCodes(q.workCenterCode),
      itemCode: q.itemCode,
      inspectorId: q.inspectorId,
      shift: q.shift,
    }
    const discipline = {
      closedWithoutFinalQty: disciplineRaw.closedWithoutFinalQty,
      samplesReRecorded: disciplineRaw.samplesReRecorded,
      corrections: disciplineRaw.corrections,
      sessionsDiscarded: disciplineRaw.sessionsDiscarded,
      typedCoilPct: disciplineRaw.coilsUsed > 0 ? Math.round((disciplineRaw.coilsTyped / disciplineRaw.coilsUsed) * 1000) / 10 : null,
      gradeAcknowledgements: disciplineRaw.gradeAcknowledgements,
      notes: disciplineRaw.notes,
      emptyOpenSessions: disciplineRaw.emptyOpenSessions,
      coveragePct: disciplineRaw.openLines > 0 ? Math.round((disciplineRaw.openLinesInspected / disciplineRaw.openLines) * 1000) / 10 : null,
      openLines: disciplineRaw.openLines,
      openLinesInspected: disciplineRaw.openLinesInspected,
    }
    // The figures above are counted over every record the filters match. These
    // lists are the largest few of something, so the page is told how many
    // exist behind each one and never implies the few are all there is.
    const counts: KpiListCounts = {
      defectTypes: pareto.types,
      machines: byMachine.total,
      inspectors: byInspector.total,
      shifts: byShift.total,
      items: byItem.total,
      suppliers: suppliers.total,
      paintItems: paintByItem.total,
      holds: holds.total,
    }
    const shownPieces = pareto.rows.reduce((n, row) => n + row.pieces, 0)
    const otherTypes = pareto.types - pareto.rows.length
    const draft = {
      filters,
      thresholds,
      generatedAt: new Date().toISOString(),
      counts,
      ...(otherTypes > 0
        ? {
            paretoOthers: {
              types: otherTypes,
              pieces: Math.round((pareto.totalPieces - shownPieces) * 100) / 100,
              sharePct: pct(pareto.totalPieces - shownPieces, pareto.totalPieces) ?? 0,
            },
          }
        : {}),
      current,
      previous,
      daily,
      monthly,
      defectRateBands,
      pareto: pareto.rows,
      defectDetails,
      paretoByMachine,
      byMachine: byMachine.rows,
      byMachinePrevious: byMachinePrevious.rows,
      byInspector: byInspector.rows,
      byShift: byShift.rows,
      byItem: byItem.rows,
      itemDefects,
      suppliers: suppliers.rows,
      paintByItem: paintByItem.rows,
      holds: holds.rows,
      discipline,
      inspectorRanking,
    }
    const body: KpiOverview = { ...draft, insights: buildInsights(draft, thresholds) }
    res.json(body)
  })

  // ---- The general page -------------------------------------------------------
  // The whole plant over the last few calendar months, the current one to
  // date, with no filter: the same picture for everyone, whatever the
  // analysis page is narrowed to.

  r.get('/general', async (req, res) => {
    const tz = ctx.config.FACTORY_TIMEZONE
    const q = req.query.from === undefined && req.query.to === undefined ? null : parse(GeneralQuery, req.query)
    if (q) checkRange(q.from, q.to, 'Period')
    const { thresholds } = await loadThresholds(ctx.db)
    const today = factoryToday(tz)
    // The period the cards are counted over; the trend window is always the
    // last months to today, whatever the period, so the month lines stay put.
    // It starts no earlier than the first month with production: a plant new
    // to the system does not open its trend on empty months.
    const thisMonth = today.slice(0, 7)
    const firstDataMonth = await loadFirstDataMonth(ctx.db, tz)
    const earliest = monthsBefore(thisMonth, GENERAL_MONTHS - 1)
    const windowMonth = firstDataMonth === null || firstDataMonth > thisMonth ? thisMonth : firstDataMonth > earliest ? firstDataMonth : earliest
    const windowFrom = `${windowMonth}-01`
    const monthsBack = monthsBetween(windowMonth, thisMonth) + 1
    const to = q?.to ?? today
    const from = q?.from ?? windowFrom
    const period: PeriodFilters = { tz, from, to }
    const window: PeriodFilters = { tz, from: windowFrom, to: today }
    const allTimeFrom = firstDataMonth !== null && firstDataMonth <= thisMonth ? `${firstDataMonth}-01` : `${thisMonth}-01`
    const [totals, months, factoriesInPeriod, machinesInPeriod, factoryTrends, machineTrends, allTime] = await Promise.all([
      loadTotals(ctx.db, period),
      loadMonthly(ctx.db, window),
      loadFactoryMonths(ctx.db, period),
      loadMachineMonths(ctx.db, period),
      loadFactoryMonths(ctx.db, window),
      loadMachineMonths(ctx.db, window),
      loadScopeTotals(ctx.db, { tz, from: allTimeFrom, to: today }),
    ])
    // The figures of the period, with the months of the trend window beside
    // them: a factory or machine seen in either is listed, with the period's
    // figures where it has any and the window's months where it has any.
    const emptyMonths = months.map((m) => ({ month: m.month, piecesProduced: 0, productionDefectPieces: 0, defectRatePct: null }))
    const factoryMonths = new Map(factoryTrends.map((f) => [f.factory, f.months]))
    const factoryNamesSeen = Array.from(new Set([...factoriesInPeriod.map((f) => f.factory), ...factoryTrends.map((f) => f.factory)]))
    const factories = factoryNamesSeen
      .map((name) => {
        const inPeriod = factoriesInPeriod.find((f) => f.factory === name)
        return { factory: name, piecesProduced: inPeriod?.piecesProduced ?? 0, productionDefectPieces: inPeriod?.productionDefectPieces ?? 0, defectRatePct: inPeriod?.defectRatePct ?? null, months: factoryMonths.get(name) ?? emptyMonths }
      })
      .sort((a, b) => b.piecesProduced - a.piecesProduced || a.factory.localeCompare(b.factory))
    const machineMonths = new Map(machineTrends.map((m) => [m.workCenterCode.toLowerCase(), m]))
    const machineCodesSeen = Array.from(new Set([...machinesInPeriod.map((m) => m.workCenterCode.toLowerCase()), ...machineTrends.map((m) => m.workCenterCode.toLowerCase())]))
    const machines = machineCodesSeen
      .map((code) => {
        const inPeriod = machinesInPeriod.find((m) => m.workCenterCode.toLowerCase() === code)
        const inWindow = machineMonths.get(code)
        const base = inPeriod ?? inWindow!
        return { ...base, piecesProduced: inPeriod?.piecesProduced ?? 0, productionDefectPieces: inPeriod?.productionDefectPieces ?? 0, defectRatePct: inPeriod?.defectRatePct ?? null, months: inWindow?.months ?? emptyMonths }
      })
      .sort((a, b) => (b.defectRatePct ?? -1) - (a.defectRatePct ?? -1) || b.piecesProduced - a.piecesProduced || a.label.localeCompare(b.label))
    const body: KpiGeneral = {
      from,
      to,
      window: { from: windowFrom, to: today },
      monthsBack,
      generatedAt: new Date().toISOString(),
      thresholds,
      totals: {
        piecesProduced: totals.piecesProduced,
        productionDefectPieces: totals.productionDefectPieces,
        releasedPieces: Math.max(0, totals.piecesProduced - totals.productionDefectPieces),
        defectRatePct: totals.defectRatePct,
        producedSessions: totals.producedSessions,
        samples: totals.samples,
        pieces: totals.pieces,
        defectPieces: totals.defectPieces,
        inspectedDefectPct: totals.inspectedDefectPct,
        machines: totals.machinesInspected,
        factories: factories.length,
      },
      months,
      factories,
      machines,
      allTime,
    }
    res.json(body)
  })

  /** The drill-down of the general page: a factory, a process or a few machines
   *  over a period, month by month, with first part released. */
  r.get('/breakdown', async (req, res) => {
    const q = parse(BreakdownQuery, req.query)
    checkRange(q.from, q.to, 'Period')
    const { thresholds } = await loadThresholds(ctx.db)
    const f: PeriodFilters = { tz: ctx.config.FACTORY_TIMEZONE, from: q.from, to: q.to, factories: factoryNames(q.factory), processes: processNames(q.process), workCenterCodes: machineCodes(q.workCenterCode), itemCode: q.itemCode }
    const [breakdown, firstPart] = await Promise.all([loadBreakdown(ctx.db, f), loadFirstPart(ctx.db, f)])
    const body: KpiBreakdown = {
      filters: { from: q.from, to: q.to, factories: f.factories, processes: f.processes, workCenterCodes: f.workCenterCodes, itemCode: q.itemCode },
      generatedAt: new Date().toISOString(),
      thresholds,
      ...breakdown,
      firstPart,
    }
    res.json(body)
  })

  // ---- Hidden insights ------------------------------------------------------
  // Per person, by the insight's key (rule and subject). Hiding an insight
  // hides it on every device until the same person shows it again; the row
  // is kept and stamped either way.

  const hiddenKeySchema = z.object({ key: z.string().trim().min(1).max(INSIGHT_KEY_MAX) })

  async function hiddenInsights(db: Queryable, userId: string): Promise<HiddenInsightsResponse> {
    const { rows } = await db.query<{ key: string }>(
      `SELECT insight_key AS key FROM insight_dismissals WHERE user_id = $1 AND restored_at IS NULL ORDER BY hidden_at DESC, insight_key`,
      [userId],
    )
    return { keys: rows.map((r) => r.key) }
  }

  r.get('/insights/hidden', async (req, res) => {
    res.json(await hiddenInsights(ctx.db, requireUser(req).id))
  })

  r.post('/insights/hide', async (req, res) => {
    const user = requireUser(req)
    const body = parse(hiddenKeySchema, req.body) as HiddenInsightRequest
    await ctx.db.query(
      `INSERT INTO insight_dismissals (user_id, insight_key) VALUES ($1, $2)
         ON CONFLICT (user_id, insight_key) DO UPDATE SET hidden_at = now(), restored_at = NULL`,
      [user.id, body.key],
    )
    res.json(await hiddenInsights(ctx.db, user.id))
  })

  r.post('/insights/restore', async (req, res) => {
    const user = requireUser(req)
    const body = parse(hiddenKeySchema, req.body) as HiddenInsightRequest
    await ctx.db.query(`UPDATE insight_dismissals SET restored_at = now() WHERE user_id = $1 AND insight_key = $2 AND restored_at IS NULL`, [user.id, body.key])
    res.json(await hiddenInsights(ctx.db, user.id))
  })

  return r
}
