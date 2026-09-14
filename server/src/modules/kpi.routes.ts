// §15 — the quality dashboard. One overview call assembles every figure for
// a period and its comparison; the thresholds that colour them live in
// app_settings and are edited by an administrator, with the old values in
// the audit log.

import { Router } from 'express'
import { z } from 'zod'
import {
  DEFAULT_KPI_THRESHOLDS,
  RANKING_WEIGHTS,
  pct,
  rankInspectors,
  type KpiFilters,
  type KpiInspectorRanking,
  type KpiInspectorRaw,
  type KpiListCounts,
  type KpiOverview,
  type KpiThresholds,
} from '@qc/shared/kpi'
import type { KpiSpanResponse, KpiThresholdsResponse } from '@qc/shared/api'
import type { AppContext } from '../context'
import type { Queryable } from '../db/pool'
import { withTransaction } from '../db/pool'
import { parse } from '../lib/validate'
import { badRequest } from '../lib/errors'
import { requireCapability, requireUser } from '../auth/middleware'
import { auditChanges } from '../audit/service'
import { buildInsights } from './kpi.insights'
import {
  loadDaily,
  loadDefectRateBands,
  loadDiscipline,
  loadGroups,
  loadHolds,
  loadInspectorRaw,
  loadItemDefects,
  loadPaintByItem,
  loadPareto,
  loadParetoByMachine,
  loadSuppliers,
  loadTotals,
  type PeriodFilters,
} from './kpi.sql'

export const KPI_THRESHOLDS_KEY = 'kpi-thresholds'
const MAX_PERIOD_DAYS = 366

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
const optionalText = z.string().trim().min(1).max(120).optional()

const OverviewQuery = z.object({
  from: day,
  to: day,
  prevFrom: day,
  prevTo: day,
  factory: optionalText,
  workCenterCode: optionalText,
  itemCode: optionalText,
  inspectorId: z.string().uuid().optional(),
  shift: z.enum(['A', 'B', 'C']).optional(),
})

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

  r.get('/overview', async (req, res) => {
    const q = parse(OverviewQuery, req.query)
    checkRange(q.from, q.to, 'Period')
    checkRange(q.prevFrom, q.prevTo, 'Comparison period')
    const { thresholds } = await loadThresholds(ctx.db)
    const tz = ctx.config.FACTORY_TIMEZONE
    const common = { tz, factory: q.factory, workCenterCode: q.workCenterCode, itemCode: q.itemCode, inspectorId: q.inspectorId, shift: q.shift }
    const cur: PeriodFilters = { ...common, from: q.from, to: q.to }
    const prev: PeriodFilters = { ...common, from: q.prevFrom, to: q.prevTo }
    const db = ctx.db
    const [
      current,
      previous,
      daily,
      pareto,
      byMachine,
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
        loadPareto(db, cur),
        loadGroups(db, cur, 'machine'),
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
      factory: q.factory,
      workCenterCode: q.workCenterCode,
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
      defectRateBands,
      pareto: pareto.rows,
      paretoByMachine,
      byMachine: byMachine.rows,
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

  return r
}
