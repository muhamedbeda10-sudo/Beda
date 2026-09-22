// ============================================================================
// §15 — the quality dashboard. One period against its comparison, every
// KPI the floor's records can support, and a short list of what a quality
// manager would say about them. Administrators only.
// ============================================================================

import { useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import {
  Activity,
  AlertOctagon,
  Eye,
  EyeOff,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  CheckCircle2,
  ClipboardList,
  FileSpreadsheet,
  Info,
  LayoutGrid,
  Lightbulb,
  Loader2,
  Minus,
  PauseCircle,
  Printer,
  RefreshCw,
  Ruler,
  ShieldAlert,
  Sparkles,
  Target,
  Trophy,
  Users,
  X,
} from 'lucide-react'
import { can, shiftName } from '@qc/shared/rules'
import type { Disposition, ShiftLetter } from '@qc/shared/types'
import { deltaPct, insightKey, toneHighIsGood, toneLowIsGood, type KpiFilters, type KpiGroupRow, type KpiInsight, type KpiOverview, type KpiThresholds, type KpiTone } from '@qc/shared/kpi'
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Select, type BadgeTone } from '@/components/ui'
import { InspectorRanking } from '@/components/dashboard/InspectorRanking'
import { PeriodSlicer } from '@/components/dashboard/PeriodSlicer'
import { ColumnChart, DonutChart, HorizontalBars, PairedBarChart, ParetoChart } from '@/components/dashboard/charts'
import { kpiSheets } from '@/components/dashboard/exportKpi'
import { COMPARE_PRESETS, PERIOD_PRESETS, addDays, compareRange, describeRange, isMonthAligned, presetRange, shortDay, toDay, type ComparePreset, type PeriodPreset } from '@/components/dashboard/period'
import { downloadWorkbook } from '@/lib/xlsxWrite'
import { usePersistedState } from '@/lib/usePersistedState'
import { cn, formatDateTime } from '@/lib/utils'
import { useHiddenInsights, useKpiOverview, useKpiSpan, useMaster, useUsers } from '@/services/queries'
import { hideInsight, restoreInsight } from '@/services/mutations'
import { useAuth } from '@/store/AuthContext'
import { useApp } from '@/store/AppContext'
import { ApiError } from '@/lib/api'

// ---- Formatting ------------------------------------------------------------

const num = (v: number | null | undefined, digits = 0): string => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toLocaleString('en-GB', { maximumFractionDigits: digits, minimumFractionDigits: 0 }))
const pctStr = (v: number | null | undefined, digits = 1): string => (v === null || v === undefined ? '—' : `${v.toFixed(digits)}%`)

const TONE_BADGE: Record<KpiTone, BadgeTone> = { green: 'green', amber: 'amber', red: 'red', neutral: 'neutral' }
const TONE_TEXT: Record<KpiTone, string> = {
  green: 'text-emerald-600 dark:text-emerald-400',
  amber: 'text-amber-600 dark:text-amber-400',
  red: 'text-rose-600 dark:text-rose-400',
  neutral: 'text-slate-700 dark:text-slate-200',
}
const TONE_RING: Record<KpiTone, string> = {
  green: 'ring-emerald-200/80 dark:ring-emerald-500/30',
  amber: 'ring-amber-200/80 dark:ring-amber-500/30',
  red: 'ring-rose-200/80 dark:ring-rose-500/30',
  neutral: 'ring-slate-200/70 dark:ring-slate-800',
}

const DISPOSITION_CLASS: Record<Disposition, string> = {
  Rejected: 'stroke-rose-500',
  Hold: 'stroke-amber-500',
  Repair: 'stroke-brand-500',
  'Used in another order': 'stroke-violet-500',
  'Accept with concession': 'stroke-emerald-500',
}

// ---- KPI tile --------------------------------------------------------------

function KpiTile({
  label,
  value,
  unit,
  current,
  previous,
  goodWhen,
  tone = 'neutral',
  sub,
  icon,
}: {
  label: string
  value: string
  unit?: string
  current: number | null
  previous: number | null
  /** Which direction of change is good: a falling defect rate, a rising yield. */
  goodWhen: 'down' | 'up' | 'none'
  tone?: KpiTone
  sub?: ReactNode
  icon: ReactNode
}) {
  const delta = deltaPct(current, previous)
  const up = delta !== null && delta > 0
  const flat = delta !== null && Math.abs(delta) < 0.05
  const good = goodWhen === 'none' || flat ? null : goodWhen === 'up' ? up : !up
  return (
    <Card className={cn('p-4 ring-1 transition-shadow hover:shadow-hover', TONE_RING[tone])}>
      <div className="flex items-start justify-between gap-2">
        <p className="truncate text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
        <span className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-lg', tone === 'neutral' ? 'bg-brand-100 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300' : tone === 'green' ? 'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400' : tone === 'amber' ? 'bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400' : 'bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-400')}>
          {icon}
        </span>
      </div>
      <p className={cn('mt-1 text-2xl font-extrabold tabular-nums tracking-tight', TONE_TEXT[tone])}>
        {value}
        {unit && value !== '—' && <span className="ml-0.5 text-base font-semibold text-slate-400">{unit}</span>}
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500 dark:text-slate-400">
        {delta === null ? (
          <span className="inline-flex items-center gap-1 text-slate-400">
            <Minus className="h-3 w-3" /> no comparison
          </span>
        ) : (
          <span className={cn('inline-flex items-center gap-0.5 font-semibold tabular-nums', good === null ? 'text-slate-500' : good ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400')}>
            {flat ? <Minus className="h-3 w-3" /> : up ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
            {flat ? 'flat' : `${Math.abs(delta).toFixed(1)}%`}
          </span>
        )}
        {previous !== null && <span className="text-slate-400">prev {typeof previous === 'number' ? (unit === '%' ? pctStr(previous) : num(previous, 1)) : '—'}</span>}
        {sub && <span className="basis-full text-slate-400">{sub}</span>}
      </div>
    </Card>
  )
}

// ---- Insights --------------------------------------------------------------

const SEVERITY: Record<KpiInsight['severity'], { icon: typeof Info; cls: string; label: string }> = {
  critical: { icon: AlertOctagon, cls: 'border-rose-200 bg-rose-50/70 text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200', label: 'Critical' },
  warning: { icon: AlertTriangle, cls: 'border-amber-200 bg-amber-50/70 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200', label: 'Warning' },
  info: { icon: Info, cls: 'border-brand-200 bg-brand-50/70 text-brand-800 dark:border-brand-500/30 dark:bg-brand-500/10 dark:text-brand-100', label: 'Note' },
  good: { icon: CheckCircle2, cls: 'border-emerald-200 bg-emerald-50/70 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200', label: 'Good' },
}

/**
 * The cards. `onHide` puts a hide control on each card; `onRestore` puts a
 * show-again control on each, for the list of the ones already hidden. On
 * paper neither prints.
 */
function InsightList({
  insights,
  onLink,
  onHide,
  onRestore,
  muted = false,
}: {
  insights: KpiInsight[]
  onLink: (link: NonNullable<KpiInsight['link']>) => void
  onHide?: (key: string) => void
  onRestore?: (key: string) => void
  /** The hidden ones: drawn quieter so they read as put away. */
  muted?: boolean
}) {
  return (
    <ul className="grid grid-cols-1 gap-2 lg:grid-cols-2">
      {insights.map((i, idx) => {
        const s = SEVERITY[i.severity]
        const key = insightKey(i)
        return (
          <li key={key} className={cn('animate-page-in rounded-xl border p-3', s.cls, muted && 'opacity-70')} style={{ animationDelay: `${Math.min(idx, 8) * 40}ms` }}>
            <div className="flex items-start gap-2.5">
              <s.icon className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="font-semibold leading-snug">{i.title}</p>
                <p className="mt-0.5 text-sm opacity-90">{i.detail}</p>
                {i.action && <p className="mt-1.5 text-sm font-medium">→ {i.action}</p>}
                {i.link && (
                  <button type="button" onClick={() => onLink(i.link!)} className="print-hidden mt-1.5 text-xs font-semibold underline decoration-dotted underline-offset-2 hover:opacity-80">
                    {i.link.kind === 'history-hold' ? 'Open the Hold list' : i.link.kind === 'machine' ? `Filter to machine ${i.link.value}` : i.link.kind === 'item' ? `Filter to item ${i.link.value}` : 'Open'}
                  </button>
                )}
              </div>
              {onHide && (
                <button
                  type="button"
                  onClick={() => onHide(key)}
                  className="print-hidden -mr-1 -mt-1 grid h-9 w-9 shrink-0 place-items-center rounded-lg opacity-60 transition-opacity hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10"
                  aria-label={`Hide: ${i.title}`}
                  title="Hide this insight until you show it again"
                >
                  <EyeOff className="h-4 w-4" />
                </button>
              )}
              {onRestore && (
                <button
                  type="button"
                  onClick={() => onRestore(key)}
                  className="print-hidden inline-flex min-h-[36px] shrink-0 items-center gap-1 rounded-lg px-2 text-xs font-semibold underline decoration-dotted underline-offset-2 hover:bg-black/5 dark:hover:bg-white/10"
                  aria-label={`Show again: ${i.title}`}
                >
                  <Eye className="h-4 w-4" /> Show again
                </button>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}

// ---- Tables ----------------------------------------------------------------

interface Column<T> {
  key: string
  label: string
  className?: string
  render: (row: T) => ReactNode
}

function Table<T>({
  rows,
  columns,
  rowKey,
  empty = 'Nothing in this period.',
  maxRows,
  total,
}: {
  rows: T[]
  columns: Column<T>[]
  rowKey: (r: T) => string
  empty?: string
  maxRows?: number
  /** How many rows exist in the period when `rows` is the largest few of them. */
  total?: number
}) {
  const [showAll, setShowAll] = useState(false)
  if (rows.length === 0) return <p className="py-6 text-center text-sm text-slate-400">{empty}</p>
  const visible = maxRows && !showAll ? rows.slice(0, maxRows) : rows
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400">
            {columns.map((c) => (
              <th key={c.key} className={cn('whitespace-nowrap px-2 py-1.5 font-semibold', c.className)}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {visible.map((r) => (
            <tr key={rowKey(r)} className="transition-colors hover:bg-slate-50/80 dark:hover:bg-slate-800/40">
              {columns.map((c) => (
                <td key={c.key} className={cn('px-2 py-1.5 align-top', c.className)}>
                  {c.render(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        {maxRows && rows.length > maxRows && (
          <button type="button" onClick={() => setShowAll((s) => !s)} className="print-hidden text-xs font-semibold text-brand-700 hover:underline dark:text-brand-300">
            {showAll ? 'Show fewer' : `Show all ${rows.length}`}
          </button>
        )}
        {/* The table holds the largest few; saying so is the difference between
            a ranking and a claim that this is everything. */}
        {total !== undefined && total > rows.length && (
          <span className="text-xs text-slate-400">
            The largest {rows.length} of {total} — narrow the filters for the rest.
          </span>
        )}
      </div>
    </div>
  )
}

function ToneCell({ value, tone, digits = 1 }: { value: number | null; tone: KpiTone; digits?: number }) {
  return <span className={cn('font-semibold tabular-nums', TONE_TEXT[tone])}>{pctStr(value, digits)}</span>
}

function groupColumns(t: KpiThresholds, first: Column<KpiGroupRow>): Column<KpiGroupRow>[] {
  return [
    first,
    { key: 'sessions', label: 'Sessions', className: 'text-right tabular-nums', render: (r) => num(r.sessions) },
    { key: 'samples', label: 'Samples', className: 'text-right tabular-nums', render: (r) => num(r.samples) },
    { key: 'pieces', label: 'Inspected', className: 'text-right tabular-nums', render: (r) => num(r.pieces) },
    { key: 'defects', label: 'Defect pcs', className: 'text-right tabular-nums', render: (r) => num(r.defectPieces) },
    { key: 'produced', label: 'Produced', className: 'text-right tabular-nums', render: (r) => (r.piecesProduced === null ? <span className="text-slate-400">—</span> : num(r.piecesProduced)) },
    { key: 'rate', label: 'Defect rate', className: 'text-right', render: (r) => <ToneCell value={r.defectRatePct} tone={toneLowIsGood(r.defectRatePct, t.defectRateGreen, t.defectRateAmber)} /> },
    { key: 'inspectedRate', label: 'Of inspected', className: 'text-right', render: (r) => <ToneCell value={r.inspectedDefectPct} tone="neutral" /> },
    { key: 'fpy', label: 'FPY', className: 'text-right', render: (r) => <ToneCell value={r.fpyPct} tone={toneHighIsGood(r.fpyPct, t.fpyGreen, t.fpyAmber)} /> },
    { key: 'dim', label: 'Dim fail', className: 'text-right', render: (r) => <ToneCell value={r.dimFailPct} tone={toneLowIsGood(r.dimFailPct, t.dimFailGreen, t.dimFailAmber)} /> },
  ]
}

function Section({ title, hint, icon, children, className, action }: { title: string; hint?: string; icon?: ReactNode; children: ReactNode; className?: string; action?: ReactNode }) {
  return (
    <Card className={cn('p-4 sm:p-5', className)}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          {icon && <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">{icon}</span>}
          <div className="min-w-0">
            <h2 className="text-base font-bold leading-tight">{title}</h2>
            {hint && <p className="text-xs text-slate-500 dark:text-slate-400">{hint}</p>}
          </div>
        </div>
        {action}
      </div>
      {children}
    </Card>
  )
}

// ---- The page --------------------------------------------------------------

interface DashFilters {
  preset: PeriodPreset
  compare: ComparePreset
  customFrom: string
  customTo: string
  factory: string
  workCenterCode: string
  itemCode: string
  inspectorId: string
  shift: '' | ShiftLetter
}

const DEFAULT_FILTERS: DashFilters = {
  preset: 'this-month',
  compare: 'previous-period',
  customFrom: '',
  customTo: '',
  factory: '',
  workCenterCode: '',
  itemCode: '',
  inspectorId: '',
  shift: '',
}

/**
 * What a "largest few" list is showing. Every headline figure on this page is
 * counted over every record the filters match; these lists are the largest few
 * of something, and a chart that does not say so reads as the whole truth.
 *
 * Nothing is added while a list is complete — nor while it is empty, where
 * "0 of 4" would say less than the empty chart already does. `rank` names the
 * order the few were picked in: the Holds are the oldest, not the largest.
 */
function showing(shown: number, total: number, rank: 'largest' | 'oldest' = 'largest'): string {
  return shown > 0 && total > shown ? ` Showing the ${rank === 'oldest' ? `${shown} oldest` : `largest ${shown}`} of ${total}.` : ''
}

export function DashboardPage() {
  const { role } = useAuth()
  const navigate = useNavigate()
  const allowed = can(role, 'view-dashboard')
  const [f, setF] = usePersistedState<DashFilters>('qc-dash:filters', DEFAULT_FILTERS)
  const patch = (p: Partial<DashFilters>) => setF((prev) => ({ ...DEFAULT_FILTERS, ...prev, ...p }))

  const today = toDay(new Date())
  const range = useMemo(() => {
    const custom = f.customFrom && f.customTo && f.customFrom <= f.customTo ? { from: f.customFrom, to: f.customTo } : undefined
    return presetRange(f.preset, new Date(), custom)
  }, [f.preset, f.customFrom, f.customTo])
  const prev = useMemo(() => compareRange(range, f.compare, isMonthAligned(range)), [range, f.compare])

  const filters: KpiFilters = useMemo(
    () => ({
      from: range.from,
      to: range.to,
      prevFrom: prev.from,
      prevTo: prev.to,
      factory: f.factory || undefined,
      workCenterCode: f.workCenterCode || undefined,
      itemCode: f.itemCode.trim() || undefined,
      inspectorId: f.inspectorId || undefined,
      shift: f.shift || undefined,
    }),
    [range, prev, f.factory, f.workCenterCode, f.itemCode, f.inspectorId, f.shift],
  )

  const { data, isLoading, isFetching, error, refetch } = useKpiOverview(allowed ? filters : null)
  const [insightsOpen, setInsightsOpen] = useState(false)
  /** The ones this person put away: hidden on every device until shown again. */
  const [hiddenOpen, setHiddenOpen] = useState(false)
  const { data: hiddenState } = useHiddenInsights(allowed)
  const qc = useQueryClient()
  const { toast } = useApp()
  const { visibleInsights, hiddenInsights } = useMemo(() => {
    const all = data?.insights ?? []
    const hidden = new Set(hiddenState?.keys ?? [])
    return { visibleInsights: all.filter((i) => !hidden.has(insightKey(i))), hiddenInsights: all.filter((i) => hidden.has(insightKey(i))) }
  }, [data, hiddenState])
  const onHide = async (key: string) => {
    try {
      await hideInsight(qc, key)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not hide the insight.', 'error')
    }
  }
  const onRestore = async (key: string) => {
    try {
      await restoreInsight(qc, key)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not show the insight again.', 'error')
    }
  }
  /** Which half of the dashboard is on screen. Printing renders both, so the
   *  PDF is the whole dashboard whichever tab is open. */
  const [view, setView] = usePersistedState<'overview' | 'inspectors'>('qc-dash:view', 'overview')
  /** The Pareto can be read for one machine without narrowing the whole page. */
  const [paretoMachine, setParetoMachine] = usePersistedState('qc-dash:pareto-machine', '')
  const { data: machines = [] } = useMaster('machines', undefined, allowed)
  const { data: users = [] } = useUsers()
  const { data: span } = useKpiSpan(allowed)

  /**
   * The inspector filter used to offer every account, whether or not the
   * person had recorded anything — so a name stayed on the list after the
   * last of their sessions was deleted. It now offers the people the period's
   * record actually names first, from the ranking, which carries every one of
   * them rather than the capped top of the table. An account with nothing
   * recorded is still offered, under its own heading, so "did anyone check
   * this?" can still be asked; and someone whose account was removed but
   * whose inspections remain is offered from the record itself.
   */
  const machinePareto = useMemo(
    () => (paretoMachine ? data?.paretoByMachine.find((m) => m.workCenterCode === paretoMachine) : undefined),
    [data, paretoMachine],
  )

  const inspectorChoices = useMemo(() => {
    const ranking = data ? [...data.inspectorRanking.overall.ranked, ...data.inspectorRanking.overall.unranked] : []
    const recorded = new Map(ranking.map((r) => [r.inspectorId, r.name]))
    const byName = (a: { id: string; name: string }, b: { id: string; name: string }) => a.name.localeCompare(b.name)
    const withRecord = Array.from(recorded, ([id, name]) => ({ id, name: users.find((u) => u.id === id)?.name ?? name })).sort(byName)
    const without = users
      .filter((u) => !recorded.has(u.id) && (u.isActive || u.id === f.inspectorId))
      .map((u) => ({ id: u.id, name: u.name }))
      .sort(byName)
    return { withRecord, without }
  }, [data, users, f.inspectorId])

  const factories = useMemo(() => Array.from(new Set(machines.map((m) => m.factory ?? '').filter(Boolean))).sort(), [machines])
  const machineOptions = useMemo(
    () => machines.filter((m) => !f.factory || (m.factory ?? '') === f.factory).sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [machines, f.factory],
  )
  const activeFilters = [f.factory && `Factory ${f.factory}`, f.workCenterCode && `Machine ${f.workCenterCode}`, f.itemCode && `Item ${f.itemCode}`, f.inspectorId && (users.find((u) => u.id === f.inspectorId)?.name ?? inspectorChoices.withRecord.find((r) => r.id === f.inspectorId)?.name ?? 'Inspector'), f.shift && `${shiftName(f.shift)} shift`].filter(Boolean) as string[]

  const onLink = (link: NonNullable<KpiInsight['link']>) => {
    if (link.kind === 'history-hold') navigate('/history?disposition=Hold')
    else if (link.kind === 'machine') patch({ workCenterCode: link.value })
    else if (link.kind === 'item') patch({ itemCode: link.value })
    else if (link.kind === 'session') navigate(`/wizard/${link.value}`)
  }

  const exportExcel = () => {
    if (!data) return
    downloadWorkbook(`QC-dashboard-${range.from}_${range.to}.xlsx`, kpiSheets({ ...data, insights: visibleInsights }))
  }

  if (!allowed) {
    return (
      <div className="mx-auto max-w-lg py-10">
        <EmptyState icon={<ShieldAlert className="h-10 w-10" />} title="The dashboard is for administrators" hint="Ask an administrator to open it for you, or to share an export." />
      </div>
    )
  }

  const t = data?.thresholds
  // Every day of the period on the axis, so a day without a sample shows as a gap rather than vanishing.
  const dailyPoints = useMemo(() => {
    if (!data) return []
    const byDay = new Map(data.daily.map((d) => [d.day, d]))
    const out: { label: string; total: number; part: number }[] = []
    for (let day = data.filters.from; day <= data.filters.to && out.length < 400; day = addDays(day, 1)) {
      const d = byDay.get(day)
      out.push({ label: shortDay(day), total: d?.pieces ?? 0, part: d?.defectPieces ?? 0 })
    }
    return out
  }, [data])
  const cur = data?.current
  const prevT = data?.previous
  const holdPieces = data?.holds.reduce((n, h) => n + h.qty, 0) ?? 0
  const attention = visibleInsights.filter((i) => i.severity === 'critical' || i.severity === 'warning').length

  return (
    <div className="mx-auto max-w-[110rem] space-y-5">
      {/* Heading */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-slate-400">Quality</p>
          <h1 className="mt-1 text-2xl font-extrabold tracking-tight">Dashboard</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            <span className="font-semibold text-slate-700 dark:text-slate-200">{describeRange(range)}</span> compared with {describeRange(prev)}
            {activeFilters.length > 0 && <span> · {activeFilters.join(' · ')}</span>}
            {data && <span className="hidden print:inline"> · generated {formatDateTime(data.generatedAt)}</span>}
          </p>
        </div>
        <div className="print-hidden flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-xl p-0.5 ring-1 ring-slate-200 dark:ring-slate-700">
            {(
              [
                ['overview', 'Overview', LayoutGrid],
                ['inspectors', 'Inspectors', Trophy],
              ] as const
            ).map(([key, label, Icon]) => (
              <button
                key={key}
                type="button"
                onClick={() => setView(key)}
                aria-pressed={view === key}
                className={cn(
                  'inline-flex min-h-[40px] items-center gap-1.5 rounded-[10px] px-3 text-sm font-semibold transition-colors',
                  view === key ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800',
                )}
              >
                <Icon className="h-4 w-4" /> {label}
              </button>
            ))}
          </div>
          {data && (
            <button
              type="button"
              onClick={() => setInsightsOpen(true)}
              className={cn(
                'relative grid h-11 w-11 place-items-center rounded-xl ring-1 transition-colors',
                attention > 0 ? 'bg-amber-50 text-amber-700 ring-amber-200 hover:bg-amber-100 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-500/30' : 'bg-emerald-50 text-emerald-700 ring-emerald-200 hover:bg-emerald-100 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-500/30',
              )}
              aria-label={`Insights, ${visibleInsights.length} ${visibleInsights.length === 1 ? 'note' : 'notes'}${hiddenInsights.length ? `, ${hiddenInsights.length} hidden` : ''}`}
            >
              <Lightbulb className="h-5 w-5" />
              <span className={cn('absolute -right-1.5 -top-1.5 grid min-w-[20px] place-items-center rounded-full px-1 text-[10px] font-bold leading-[20px] text-white ring-2 ring-white dark:ring-slate-900', attention > 0 ? 'bg-rose-600' : 'bg-emerald-600')}>
                {attention > 0 ? attention : '✓'}
              </span>
            </button>
          )}
          <Button className="min-h-[44px]" onClick={() => void refetch()} disabled={isFetching} aria-label="Refresh">
            <RefreshCw className={cn('h-4 w-4', isFetching && 'animate-spin')} /> Refresh
          </Button>
          <Button className="min-h-[44px]" onClick={exportExcel} disabled={!data}>
            <FileSpreadsheet className="h-4 w-4" /> Excel
          </Button>
          <Button variant="primary" className="min-h-[44px]" onClick={() => window.print()} disabled={!data}>
            <Printer className="h-4 w-4" /> PDF
          </Button>
        </div>
      </div>

      {/* Filters */}
      <Card className="print-hidden space-y-3 p-4">
        {/* §15 — the period is a timeline strip: two handles to drag, presets to jump. */}
        <PeriodSlicer
          value={range}
          preset={f.preset}
          firstDay={span?.firstDay ?? null}
          onChange={(next, preset) => patch({ preset, customFrom: next.from, customTo: next.to })}
        />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Field label="Compare with">
            <Select value={f.compare} onChange={(e) => patch({ compare: e.target.value as ComparePreset })}>
              {COMPARE_PRESETS.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Factory">
            <Select value={f.factory} onChange={(e) => patch({ factory: e.target.value, workCenterCode: '' })}>
              <option value="">All factories</option>
              {factories.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Machine">
            <Select value={f.workCenterCode} onChange={(e) => patch({ workCenterCode: e.target.value })}>
              <option value="">All machines</option>
              {machineOptions.map((m) => (
                <option key={m.id} value={m.code}>
                  {m.displayName}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Item code">
            <Input list="dash-items" value={f.itemCode} onChange={(e) => patch({ itemCode: e.target.value })} placeholder="All items" />
            <datalist id="dash-items">{data?.byItem.map((i) => <option key={i.key} value={i.key}>{i.label}</option>)}</datalist>
          </Field>
          <Field label="Inspector">
            <Select value={f.inspectorId} onChange={(e) => patch({ inspectorId: e.target.value })}>
              <option value="">All inspectors</option>
              {inspectorChoices.withRecord.length > 0 && (
                <optgroup label="Recorded in this period">
                  {inspectorChoices.withRecord.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </optgroup>
              )}
              {inspectorChoices.without.length > 0 && (
                <optgroup label="Nothing recorded in this period">
                  {inspectorChoices.without.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </Select>
          </Field>
          <Field label="Shift">
            <Select value={f.shift} onChange={(e) => patch({ shift: e.target.value as DashFilters['shift'] })}>
              <option value="">All shifts</option>
              {(['A', 'B', 'C'] as ShiftLetter[]).map((s) => (
                <option key={s} value={s}>
                  {s} · {shiftName(s)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {activeFilters.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {activeFilters.map((a) => (
              <Badge key={a} tone="blue">
                {a}
              </Badge>
            ))}
            <button type="button" onClick={() => patch({ factory: '', workCenterCode: '', itemCode: '', inspectorId: '', shift: '' })} className="inline-flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-rose-600">
              <X className="h-3.5 w-3.5" /> Clear filters
            </button>
          </div>
        )}
      </Card>

      {error && (
        <Card className="border border-rose-200 p-4 text-sm text-rose-700 dark:border-rose-500/30 dark:text-rose-300">
          {error instanceof ApiError ? error.message : 'The dashboard could not be loaded.'}
        </Card>
      )}

      {isLoading && !data && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="skeleton h-28" />
          ))}
        </div>
      )}

      {data && t && cur && prevT && (
        <div className={cn('space-y-5 transition-opacity', isFetching && 'opacity-70')}>
          {/* Everything but the ranking. Hidden on screen when the Inspectors
              tab is open; still printed, so the PDF stays the whole dashboard. */}
          <div className={cn('space-y-5', view !== 'overview' && '[@media_screen]:hidden')}>
          {/* Tiles */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            {/* Defect pieces per 100 produced, over the sessions closed in the period with a final quantity. */}
            <KpiTile
              label="Defect rate"
              value={pctStr(cur.defectRatePct)}
              current={cur.defectRatePct}
              previous={prevT.defectRatePct}
              goodWhen="down"
              tone={toneLowIsGood(cur.defectRatePct, t.defectRateGreen, t.defectRateAmber)}
              sub={
                filters.inspectorId || filters.shift
                  ? 'Production belongs to a whole session: not by inspector or shift. Of inspected: ' + pctStr(cur.inspectedDefectPct)
                  : cur.producedSessions === 0
                    ? `No session closed with a final quantity in this period · of inspected ${pctStr(cur.inspectedDefectPct)}`
                    : `${num(cur.productionDefectPieces)} defect pcs of ${num(cur.piecesProduced)} produced · ${num(cur.producedSessions)} closed sessions · target ≤ ${t.defectRateGreen}%`
              }
              icon={<AlertTriangle className="h-4 w-4" />}
            />
            <KpiTile label="First-pass yield" value={pctStr(cur.fpyPct)} current={cur.fpyPct} previous={prevT.fpyPct} goodWhen="up" tone={toneHighIsGood(cur.fpyPct, t.fpyGreen, t.fpyAmber)} sub={`samples with no defect · ${num(cur.samples)} samples · target ≥ ${t.fpyGreen}%`} icon={<Target className="h-4 w-4" />} />
            <KpiTile label="Dimensions out of tolerance" value={pctStr(cur.dimFailPct)} current={cur.dimFailPct} previous={prevT.dimFailPct} goodWhen="down" tone={toneLowIsGood(cur.dimFailPct, t.dimFailGreen, t.dimFailAmber)} sub={`${num(cur.dimensionsFail)} fail · ${num(cur.dimensionsWarning)} warning of ${num(cur.dimensionsMeasured)} measured`} icon={<Ruler className="h-4 w-4" />} />
            <KpiTile label="Pieces inspected" value={num(cur.pieces)} current={cur.pieces} previous={prevT.pieces} goodWhen="up" sub={`${num(cur.samples)} samples · ${num(cur.samplesPerSession, 1)} per session · ${pctStr(cur.inspectedDefectPct)} defective of inspected`} icon={<ClipboardList className="h-4 w-4" />} />
            <KpiTile label="Sessions" value={num(cur.sessions)} current={cur.sessions} previous={prevT.sessions} goodWhen="none" sub={`${num(cur.sessionsClosed)} closed · ${num(cur.machinesInspected)} machines · ${num(cur.activeInspectors)} inspectors`} icon={<Users className="h-4 w-4" />} />
            <KpiTile label="On Hold now" value={num(data.holds.length)} current={null} previous={null} goodWhen="down" tone={data.holds.some((h) => h.ageDays >= t.holdAgeRedDays) ? 'red' : data.holds.some((h) => h.ageDays >= t.holdAgeAmberDays) ? 'amber' : data.holds.length ? 'neutral' : 'green'} sub={`${num(holdPieces)} pieces waiting for a disposition`} icon={<PauseCircle className="h-4 w-4" />} />
          </div>

          {/* Insights live behind the bulb; on paper they print in full. */}
          <Section title="Insights" hint="What the numbers say, by rule, not by guess. Most serious first." icon={<Sparkles className="h-4 w-4" />} className="hidden print:block">
            <InsightList insights={visibleInsights} onLink={onLink} />
          </Section>
          {insightsOpen && (
            <Modal open onClose={() => setInsightsOpen(false)} size="xl" icon={<Lightbulb className="h-5 w-5" />} title={<span>Insights <span className="ml-2 text-sm font-semibold text-slate-400">{describeRange(range)}</span></span>}>
              <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">What the numbers say, by rule, not by guess. Most serious first. Read one? Hide it and it stays hidden for you, on every device, until you show it again.</p>
              {visibleInsights.length > 0 ? (
                <InsightList insights={visibleInsights} onLink={(l) => { setInsightsOpen(false); onLink(l) }} onHide={(k) => void onHide(k)} />
              ) : (
                <p className="rounded-xl border border-dashed border-slate-200 py-6 text-center text-sm text-slate-400 dark:border-slate-700">
                  {hiddenInsights.length > 0 ? 'Every insight for this period is hidden.' : 'Nothing to say about this period.'}
                </p>
              )}
              {hiddenInsights.length > 0 && (
                <div className="mt-4 border-t border-slate-200 pt-3 dark:border-slate-700">
                  <button
                    type="button"
                    onClick={() => setHiddenOpen((v) => !v)}
                    aria-expanded={hiddenOpen}
                    className="inline-flex min-h-[40px] items-center gap-2 rounded-lg px-2 text-sm font-semibold text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800"
                  >
                    {hiddenOpen ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                    {hiddenInsights.length} hidden {hiddenInsights.length === 1 ? 'insight' : 'insights'} · {hiddenOpen ? 'Put away' : 'Show'}
                  </button>
                  {hiddenOpen && (
                    <div className="mt-2">
                      <InsightList insights={hiddenInsights} muted onLink={(l) => { setInsightsOpen(false); onLink(l) }} onRestore={(k) => void onRestore(k)} />
                    </div>
                  )}
                </div>
              )}
            </Modal>
          )}

          {/* Trend + dispositions */}
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <Section title="Daily trend" hint="Each day: pieces inspected beside pieces found defective, on one scale." icon={<Activity className="h-4 w-4" />} className="xl:col-span-2">
              <PairedBarChart points={dailyPoints} totalLabel="Pieces inspected" partLabel="Defect pieces" />
            </Section>
            <Section title="Dispositions" hint="Defect pieces by what was decided." icon={<ClipboardList className="h-4 w-4" />}>
              <DonutChart
                centerLabel="defect pieces"
                slices={(Object.keys(DISPOSITION_CLASS) as Disposition[]).map((d) => ({ label: d, value: cur.byDisposition[d] ?? 0, className: DISPOSITION_CLASS[d] }))}
              />
            </Section>
          </div>

          {/* Pareto + machines */}
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <Section
              title="Pareto of defects"
              hint={
                machinePareto
                  ? `${machinePareto.label}: shares of that machine's own defect pieces${machinePareto.types > machinePareto.rows.length ? `, ${machinePareto.types - machinePareto.rows.length} smaller types not drawn` : ''}.`
                  : `Which few defects make most of the pieces. Shares are of every defect piece in the period.${
                      data.paretoOthers ? ` ${data.paretoOthers.types} smaller types are grouped as "Others".` : ''
                    }`
              }
              icon={<AlertTriangle className="h-4 w-4" />}
              className="xl:col-span-2"
              action={
                data.paretoByMachine.length > 0 && (
                  <Select value={paretoMachine} onChange={(e) => setParetoMachine(e.target.value)} className="print-hidden min-h-[40px] max-w-[16rem]" aria-label="Pareto for machine">
                    <option value="">All machines</option>
                    {data.paretoByMachine.map((m) => (
                      <option key={m.workCenterCode} value={m.workCenterCode}>
                        {m.label}
                      </option>
                    ))}
                  </Select>
                )
              }
            >
              <ParetoChart
                bars={
                  machinePareto
                    ? [
                        ...machinePareto.rows.map((p) => ({ label: p.defectName, value: p.pieces, cumulativePct: p.cumulativePct })),
                        ...(machinePareto.types > machinePareto.rows.length
                          ? [{ label: `Others (${machinePareto.types - machinePareto.rows.length})`, value: machinePareto.totalPieces - machinePareto.rows.reduce((n, r) => n + r.pieces, 0), cumulativePct: 100 }]
                          : []),
                      ]
                    : [
                        ...data.pareto.map((p) => ({ label: p.defectName, value: p.pieces, cumulativePct: p.cumulativePct })),
                        // The tail as one bar, so the line reaches 100% where it truly does.
                        ...(data.paretoOthers ? [{ label: `Others (${data.paretoOthers.types})`, value: data.paretoOthers.pieces, cumulativePct: 100 }] : []),
                      ]
                }
              />
            </Section>
            <Section title="Defect rate by machine" hint={`Defect pieces per 100 produced on the machine (sessions closed in the period). Tap a machine to filter the page to it.${showing(Math.min(12, data.byMachine.length), data.counts.machines)}`} icon={<Activity className="h-4 w-4" />}>
              <HorizontalBars
                unit="%"
                rows={data.byMachine.slice(0, 12).map((m) => ({
                  label: m.label,
                  sub: m.sub,
                  value: m.defectRatePct,
                  tone: toneLowIsGood(m.defectRatePct, t.defectRateGreen, t.defectRateAmber),
                  text: m.defectRatePct === null ? `no closed production · ${pctStr(m.inspectedDefectPct)} of inspected` : `${pctStr(m.defectRatePct)} · ${num(m.productionDefectPieces)} of ${num(m.piecesProduced)} produced`,
                  onClick: () => patch({ workCenterCode: m.key }),
                }))}
              />
            </Section>
          </div>

          {/* Who and what: one bar per row, coloured against the target. */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Section title="Defects of inspected by shift" hint="Same machines, different hours. A session's production cannot be split by shift, so this is defect pieces per 100 inspected." icon={<Users className="h-4 w-4" />}>
              <HorizontalBars
                unit="%"
                rows={data.byShift.map((r) => ({
                  label: `${r.label} · ${shiftName(r.key as ShiftLetter)}`,
                  value: r.inspectedDefectPct,
                  tone: 'neutral' as const,
                  text: `${pctStr(r.inspectedDefectPct)} · ${num(r.defectPieces)} of ${num(r.pieces)} inspected`,
                  onClick: () => patch({ shift: r.key as ShiftLetter }),
                }))}
              />
            </Section>
            <Section title="Defects of inspected by inspector" hint={`Defect pieces per 100 inspected by each person: production belongs to the session, not the inspector. Tap a name to filter the page to them.${showing(Math.min(10, data.byInspector.length), data.counts.inspectors)}`} icon={<Users className="h-4 w-4" />}>
              <HorizontalBars
                unit="%"
                rows={data.byInspector.slice(0, 10).map((r) => ({
                  label: r.label,
                  value: r.inspectedDefectPct,
                  tone: 'neutral' as const,
                  text: `${pctStr(r.inspectedDefectPct)} · ${num(r.samples)} samples`,
                  onClick: () => patch({ inspectorId: r.key }),
                }))}
              />
            </Section>
            <Section title="Defect rate by item" hint={`Defect pieces per 100 produced of the item (sessions closed in the period). Tap an item to filter the page to it.${showing(Math.min(10, data.byItem.length), data.counts.items)}`} icon={<ClipboardList className="h-4 w-4" />}>
              <HorizontalBars
                unit="%"
                rows={data.byItem.slice(0, 10).map((r) => ({
                  label: r.label,
                  sub: r.key,
                  value: r.defectRatePct,
                  tone: toneLowIsGood(r.defectRatePct, t.defectRateGreen, t.defectRateAmber),
                  text: r.defectRatePct === null ? `no closed production · ${pctStr(r.inspectedDefectPct)} of inspected` : `${pctStr(r.defectRatePct)} · ${num(r.productionDefectPieces)} of ${num(r.piecesProduced)} produced`,
                  onClick: () => patch({ itemCode: r.key }),
                }))}
              />
            </Section>
          </div>

          {/* The shape of the period, and the paint line's readings per item. */}
          <div className="print-break grid grid-cols-1 gap-4 xl:grid-cols-3">
            <Section title="Samples by defect rate" hint="How many samples had no defect, a few, or many. An average hides this shape." icon={<AlertTriangle className="h-4 w-4" />}>
              <ColumnChart
                columns={data.defectRateBands.map((b, i) => ({
                  label: b.band,
                  value: b.samples,
                  sub: b.samples > 0 ? `${num(b.pieces)} pcs` : undefined,
                  tone: i === 0 ? 'green' : i <= 2 ? 'neutral' : i === 3 ? 'amber' : 'red',
                }))}
              />
            </Section>
            <Section
              title="Paint thickness by item"
              hint={`Readings as recorded on paint samples, in µm.${showing(Math.min(10, data.paintByItem.length), data.counts.paintItems)}`}
              icon={<Sparkles className="h-4 w-4" />}
              className="xl:col-span-2"
            >
              <Table
                rows={data.paintByItem}
                total={data.counts.paintItems}
                rowKey={(r) => r.itemCode}
                maxRows={10}
                empty="No paint thickness readings in this period."
                columns={[
                  { key: 'item', label: 'Item', render: (r) => (<span className="font-semibold">{r.itemCode}<span className="ml-1 text-xs font-normal text-slate-400">{r.item}</span></span>) },
                  { key: 'n', label: 'Readings', className: 'text-right tabular-nums', render: (r) => num(r.readings) },
                  { key: 'mean', label: 'Average µm', className: 'text-right tabular-nums font-semibold', render: (r) => num(r.meanMicrons, 1) },
                  { key: 'min', label: 'Min µm', className: 'text-right tabular-nums', render: (r) => num(r.minMicrons, 1) },
                  { key: 'max', label: 'Max µm', className: 'text-right tabular-nums', render: (r) => num(r.maxMicrons, 1) },
                ]}
              />
            </Section>
          </div>

          {/* What each item is known to suffer, and where. */}
          <Section title="Defects by item" hint="For the items with the most defect pieces: each defect, the machine it came from, and its share of that item's defect pieces." icon={<ClipboardList className="h-4 w-4" />}>
            <Table
              rows={data.itemDefects}
              rowKey={(r) => `${r.itemCode}|${r.defectName}|${r.workCenterCode}`}
              maxRows={15}
              empty="No defects recorded in this period."
              columns={[
                { key: 'item', label: 'Item', render: (r) => (<span className="font-semibold">{r.itemCode}<span className="ml-1 text-xs font-normal text-slate-400">{r.item}</span></span>) },
                { key: 'defect', label: 'Defect', render: (r) => <span dir="auto">{r.defectName}</span> },
                { key: 'mc', label: 'Machine', render: (r) => r.machineLabel },
                { key: 'pcs', label: 'Pieces', className: 'text-right tabular-nums', render: (r) => num(r.pieces) },
                { key: 'rec', label: 'Records', className: 'text-right tabular-nums', render: (r) => num(r.records) },
                { key: 'share', label: 'Of item', className: 'text-right', render: (r) => <span className="font-semibold tabular-nums">{pctStr(r.sharePct)}</span> },
              ]}
            />
          </Section>

          {/* Materials, and what is waiting */}
          <div className="print-break grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Section title="Defects of inspected by coil supplier" hint={`Roll forming only — the coil is consumed there. Defect pieces per 100 inspected from each supplier and grade.${showing(Math.min(10, data.suppliers.length), data.counts.suppliers)}`} icon={<ClipboardList className="h-4 w-4" />}>
              <HorizontalBars
                unit="%"
                rows={data.suppliers.slice(0, 10).map((s) => ({
                  label: s.supplier,
                  sub: s.grade,
                  value: s.inspectedDefectPct,
                  tone: 'neutral' as const,
                  text: `${pctStr(s.inspectedDefectPct)} · ${num(s.defectPieces)} of ${num(s.pieces)} inspected`,
                }))}
              />
            </Section>
            <Section
              title="Hold ageing"
              hint={`Days a defect has waited for a disposition; amber from ${t.holdAgeAmberDays}, red from ${t.holdAgeRedDays}. Tap to open the session.${showing(
                Math.min(10, data.holds.length),
                data.counts.holds,
                'oldest',
              )}`}
              icon={<PauseCircle className="h-4 w-4" />}
              action={
                data.holds.length > 0 && (
                  <Button className="print-hidden min-h-[40px]" onClick={() => navigate('/history?disposition=Hold')}>
                    Open in History
                  </Button>
                )
              }
            >
              <HorizontalBars
                unit=" d"
                max={Math.max(t.holdAgeRedDays * 2, ...data.holds.map((h) => h.ageDays))}
                rows={[...data.holds]
                  .sort((a, b) => b.ageDays - a.ageDays)
                  .slice(0, 10)
                  .map((h) => ({
                    label: `${h.orderNumber} · ${h.defectName}`,
                    sub: `${h.item} · machine ${h.workCenterCode}`,
                    value: h.ageDays,
                    tone: h.ageDays >= t.holdAgeRedDays ? 'red' : h.ageDays >= t.holdAgeAmberDays ? 'amber' : 'neutral',
                    text: `${num(h.ageDays)} d · ${num(h.qty)} pcs`,
                    onClick: () => navigate(`/wizard/${h.sessionId}`),
                  }))}
              />
            </Section>
          </div>

          {/* Group tables */}
          <div className="print-break grid grid-cols-1 gap-4 xl:grid-cols-2">
            <Section title="By machine" icon={<Activity className="h-4 w-4" />}>
              <Table rows={data.byMachine} total={data.counts.machines} rowKey={(r) => r.key} maxRows={10} columns={groupColumns(t, { key: 'k', label: 'Machine', render: (r) => (<span className="font-semibold">{r.label}{r.sub && <span className="ml-1 text-xs font-normal text-slate-400">{r.sub}</span>}</span>) })} />
            </Section>
            <Section title="By inspector" icon={<Users className="h-4 w-4" />}>
              <Table rows={data.byInspector} total={data.counts.inspectors} rowKey={(r) => r.key} maxRows={10} columns={groupColumns(t, { key: 'k', label: 'Inspector', render: (r) => <span className="font-semibold">{r.label}</span> })} />
            </Section>
            <Section title="By shift" icon={<Users className="h-4 w-4" />}>
              <Table rows={data.byShift} rowKey={(r) => r.key} columns={groupColumns(t, { key: 'k', label: 'Shift', render: (r) => (<span className="font-semibold">{r.label} <span className="text-xs font-normal text-slate-400">{shiftName(r.key as ShiftLetter)}</span></span>) })} />
            </Section>
            <Section title="By item" icon={<ClipboardList className="h-4 w-4" />}>
              <Table rows={data.byItem} total={data.counts.items} rowKey={(r) => r.key} maxRows={10} columns={groupColumns(t, { key: 'k', label: 'Item', render: (r) => (<span className="font-semibold">{r.label}<span className="ml-1 text-xs font-normal text-slate-400">{r.key}</span></span>) })} />
            </Section>
          </div>

          {/* Materials + Holds */}
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <Section title="Coil suppliers" hint="Roll forming only. Defect pieces per 100 inspected from each supplier and grade." icon={<ClipboardList className="h-4 w-4" />}>
              <Table
                rows={data.suppliers}
                total={data.counts.suppliers}
                rowKey={(s) => `${s.supplier}|${s.grade}`}
                maxRows={10}
                empty="No coil from the register was used in this period."
                columns={[
                  { key: 's', label: 'Supplier', render: (s) => <span className="font-semibold">{s.supplier}</span> },
                  { key: 'g', label: 'Grade', render: (s) => s.grade },
                  { key: 'n', label: 'Samples', className: 'text-right tabular-nums', render: (s) => num(s.samples) },
                  { key: 'p', label: 'Pieces', className: 'text-right tabular-nums', render: (s) => num(s.pieces) },
                  { key: 'd', label: 'Defect pcs', className: 'text-right tabular-nums', render: (s) => num(s.defectPieces) },
                  { key: 'r', label: 'Of inspected', className: 'text-right', render: (s) => <ToneCell value={s.inspectedDefectPct} tone="neutral" /> },
                ]}
              />
            </Section>
            <Section
              title="On Hold"
              hint={`Defects waiting for a disposition; amber from ${t.holdAgeAmberDays} days, red from ${t.holdAgeRedDays}.${
                data.counts.holds > data.holds.length ? ` The oldest ${data.holds.length} of ${data.counts.holds} — all of them are in History.` : ''
              }`}
              icon={<PauseCircle className="h-4 w-4" />}
              action={
                data.holds.length > 0 && (
                  <Button className="print-hidden min-h-[40px]" onClick={() => navigate('/history?disposition=Hold')}>
                    Open in History
                  </Button>
                )
              }
            >
              <Table
                rows={data.holds}
                total={data.counts.holds}
                rowKey={(h) => h.defectId}
                maxRows={10}
                empty="Nothing on Hold. Good."
                columns={[
                  { key: 'age', label: 'Age', className: 'text-right', render: (h) => <Badge tone={h.ageDays >= t.holdAgeRedDays ? 'red' : h.ageDays >= t.holdAgeAmberDays ? 'amber' : 'neutral'}>{h.ageDays} d</Badge> },
                  { key: 'o', label: 'Order', render: (h) => <span className="font-semibold">{h.orderNumber}</span> },
                  { key: 'i', label: 'Item', render: (h) => h.item },
                  { key: 'm', label: 'Machine', render: (h) => h.workCenterCode },
                  { key: 'd', label: 'Defect', render: (h) => h.defectName },
                  { key: 'q', label: 'Qty', className: 'text-right tabular-nums', render: (h) => num(h.qty) },
                  { key: 'go', label: '', className: 'print-hidden text-right', render: (h) => (<button type="button" onClick={() => navigate(`/wizard/${h.sessionId}`)} className="text-xs font-semibold text-brand-700 hover:underline dark:text-brand-300">Session</button>) },
                ]}
              />
            </Section>
          </div>

          {/* Discipline */}
          <Section title="Recording discipline" hint="How the records themselves are kept. Not a KPI of the product; a KPI of the inspection." icon={<CheckCircle2 className="h-4 w-4" />}>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
              {[
                { k: 'Coverage of open lines', v: pctStr(data.discipline.coveragePct, 0), s: `${num(data.discipline.openLinesInspected)} of ${num(data.discipline.openLines)} lines` },
                { k: 'Open sessions, no sample', v: num(data.discipline.emptyOpenSessions), s: 'right now' },
                { k: 'Closed without final qty', v: num(data.discipline.closedWithoutFinalQty), s: 'in the period' },
                { k: 'Coils typed by hand', v: pctStr(data.discipline.typedCoilPct, 0), s: 'not from the register' },
                { k: 'Re-recorded / corrected', v: `${num(data.discipline.samplesReRecorded)} / ${num(data.discipline.corrections)}`, s: 'samples / fields' },
                { k: 'Discarded sessions', v: num(data.discipline.sessionsDiscarded), s: 'no sample recorded' },
                { k: 'Grade mismatches acknowledged', v: num(data.discipline.gradeAcknowledgements), s: 'coil vs expected' },
                { k: 'Notes written', v: num(data.discipline.notes), s: 'on order lines' },
              ].map((x) => (
                <div key={x.k} className="rounded-xl bg-slate-50 p-3 dark:bg-slate-800/60">
                  <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{x.k}</dt>
                  <dd className="mt-1 text-xl font-bold tabular-nums">{x.v}</dd>
                  <dd className="text-xs text-slate-400">{x.s}</dd>
                </div>
              ))}
            </dl>
          </Section>
          </div>

          {/* §16 — who inspected, and how well. Its own tab, and its own page
              in the PDF. Administrator-only, like the dashboard itself. */}
          <Section
            title="Inspector ranking"
            hint="Scored on the inspection: how much was covered, how completely it was recorded, how rarely it needed correcting, and what was found against peers on the same machine."
            icon={<Trophy className="h-4 w-4" />}
            className={cn('print-break', view !== 'inspectors' && '[@media_screen]:hidden')}
          >
            <InspectorRanking data={data.inspectorRanking} onPick={(id) => patch({ inspectorId: id })} />
          </Section>

          <p className="text-xs text-slate-400">
            Generated {formatDateTime(data.generatedAt)} · targets: defect rate ≤ {t.defectRateGreen}% / {t.defectRateAmber}%, FPY ≥ {t.fpyGreen}% / {t.fpyAmber}%, Cpk ≥ {t.cpkGreen} / {t.cpkAmber}. An administrator changes them in Configuration → KPI targets.
          </p>
        </div>
      )}

      {isFetching && !isLoading && (
        <div className="print-hidden fixed bottom-4 right-4 z-30 inline-flex items-center gap-2 rounded-full bg-slate-900/90 px-3 py-1.5 text-xs font-semibold text-white shadow-lg dark:bg-white/90 dark:text-slate-900">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Updating
        </div>
      )}
    </div>
  )
}
