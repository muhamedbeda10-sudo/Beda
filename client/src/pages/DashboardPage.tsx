// ============================================================================
// §15 — the quality dashboard. One period against its comparison, every
// KPI the floor's records can support, and a short list of what a quality
// manager would say about them. Administrators only.
// ============================================================================

import { Fragment, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import {
  Activity,
  AlertOctagon,
  Check,
  Eye,
  EyeOff,
  Factory,
  Layers,
  PackageCheck,
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
import { deltaPct, insightKey, ppm, toneHighIsGood, toneLowIsGood, type KpiBreakdown, type KpiFilters, type KpiGeneral, type KpiGroupRow, type KpiInsight, type KpiMachineTrend, type KpiOverview, type KpiThresholds, type KpiTone } from '@qc/shared/kpi'
import { PROCESSES, PROCESS_LABEL, type Process } from '@qc/shared/types'
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Select, type BadgeTone } from '@/components/ui'
import { InspectorRanking } from '@/components/dashboard/InspectorRanking'
import { PeriodSlicer } from '@/components/dashboard/PeriodSlicer'
import { ColumnChart, DonutChart, HorizontalBars, LINE_CLASSES, LineChart, PairedBarChart, ParetoChart, Sparkline, TrendChart } from '@/components/dashboard/charts'
import { kpiSheets } from '@/components/dashboard/exportKpi'
import { COMPARE_PRESETS, PERIOD_PRESETS, addDays, compareRange, describeRange, isMonthAligned, monthLabel, presetRange, shortDay, toDay, type ComparePreset, type PeriodPreset } from '@/components/dashboard/period'
import { downloadWorkbook } from '@/lib/xlsxWrite'
import { usePersistedState } from '@/lib/usePersistedState'
import { cn, formatDateTime } from '@/lib/utils'
import { useHiddenInsights, useKpiBreakdown, useKpiGeneral, useKpiOverview, useKpiSpan, useMaster, useUsers } from '@/services/queries'
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

// ---- The general page and the analysis blocks --------------------------------

function PlainTile({ label, value, sub, icon, tone = 'neutral' }: { label: string; value: string; sub?: ReactNode; icon: ReactNode; tone?: KpiTone }) {
  return (
    <Card className={cn('p-4 ring-1', TONE_RING[tone])}>
      <div className="flex items-start justify-between gap-2">
        <p className="truncate text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
        <span className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-lg', tone === 'neutral' ? 'bg-brand-100 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300' : tone === 'green' ? 'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400' : tone === 'amber' ? 'bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400' : 'bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-400')}>
          {icon}
        </span>
      </div>
      <p className={cn('mt-1 text-2xl font-extrabold tabular-nums tracking-tight', TONE_TEXT[tone])}>{value}</p>
      {sub && <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{sub}</p>}
    </Card>
  )
}

type GeneralPick = 'factory' | 'process' | 'details'

/** The change of a monthly rate against the month before it: the last two months that have one. */
function monthTrend(months: { defectRatePct: number | null }[]): { delta: number | null; last: number | null } {
  const known = months.map((m) => m.defectRatePct).filter((v): v is number => v !== null)
  if (known.length === 0) return { delta: null, last: null }
  const last = known[known.length - 1]
  const before = known.length > 1 ? known[known.length - 2] : null
  return { delta: deltaPct(last, before), last }
}

/** An arrow and a figure for a trend where a fall is good. */
function TrendMark({ delta, title }: { delta: number | null; title?: string }) {
  const up = delta !== null && delta > 0
  const flat = delta !== null && Math.abs(delta) < 0.05
  return (
    <span
      className={cn('inline-flex shrink-0 items-center gap-0.5 text-xs font-semibold tabular-nums', delta === null ? 'text-slate-400' : flat ? 'text-slate-500' : up ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400')}
      title={title ?? (delta === null ? 'No month to compare with' : 'Against the month before')}
    >
      {delta === null || flat ? <Minus className="h-3 w-3" /> : up ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
      {delta === null ? '—' : flat ? 'flat' : `${Math.abs(delta).toFixed(1)}%`}
    </span>
  )
}

const ppmStr = (rate: number | null): string => (rate === null ? '—' : num(ppm(rate)!))

/** Bars for a Pareto: largest first, the running share of the whole, the tail past 12 as one "Others" bar. */
function paretoOf(rows: { label: string; value: number }[]): { label: string; value: number; cumulativePct: number }[] {
  const sorted = rows.filter((r) => r.value > 0).sort((a, b) => b.value - a.value)
  const total = sorted.reduce((n, r) => n + r.value, 0)
  if (total === 0) return []
  const head = sorted.slice(0, 12)
  const tail = sorted.slice(12)
  let running = 0
  const out = head.map((r) => {
    running += r.value
    return { label: r.label, value: r.value, cumulativePct: Math.round((running / total) * 1000) / 10 }
  })
  if (tail.length) out.push({ label: `Others (${tail.length})`, value: tail.reduce((n, r) => n + r.value, 0), cumulativePct: 100 })
  return out
}

/**
 * §15 — the top of the general page: the plant and each factory on three
 * figures only — trend, reject rate and PPM — then every machine on the same
 * three. Nothing about samples, rejected counts or dimensions: those live in
 * the details.
 */
function GeneralOverview({ data, loading, error }: { data: KpiGeneral | null; loading: boolean; error: string | null }) {
  if (error) return <Card className="border border-rose-200 p-4 text-sm text-rose-700 dark:border-rose-500/30 dark:text-rose-300">{error}</Card>
  if (!data) {
    return loading ? (
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="skeleton h-28" />
        ))}
      </div>
    ) : null
  }
  const t = data.thresholds
  const trendSpan = `${monthLabel(data.window.from.slice(0, 7))} – ${monthLabel(data.window.to.slice(0, 7))}`
  const cards = [
    { key: '__plant', label: 'Whole plant', sub: `${num(data.totals.factories)} factories · ${num(data.totals.machines)} machines`, rate: data.totals.defectRatePct, months: data.months },
    ...data.factories.map((f) => ({ key: f.factory, label: f.factory, sub: Array.from(new Set(data.machines.filter((m) => m.factory === f.factory).map((m) => PROCESS_LABEL[m.process]))).join(' · ') || 'no process', rate: f.defectRatePct, months: f.months })),
  ]
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {cards.map((c) => {
          const tone = toneLowIsGood(c.rate, t.defectRateGreen, t.defectRateAmber)
          const trend = monthTrend(c.months)
          return (
            <Card key={c.key} className={cn('p-4 ring-1', TONE_RING[tone], c.key === '__plant' && 'bg-slate-50 dark:bg-slate-800/40')}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-[11px] font-semibold uppercase tracking-wide text-slate-400">{c.label}</p>
                  <p className="truncate text-[11px] text-slate-400">{c.sub}</p>
                </div>
                <TrendMark delta={trend.delta} />
              </div>
              <p className={cn('mt-1 text-2xl font-extrabold tabular-nums tracking-tight', TONE_TEXT[tone])}>
                {pctStr(c.rate)}
                <span className="ml-1 text-[11px] font-semibold uppercase text-slate-400">reject</span>
              </p>
              <div className="mt-1 flex items-end justify-between gap-2">
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  <span className="font-semibold tabular-nums text-slate-700 dark:text-slate-200">{ppmStr(c.rate)}</span> PPM
                </p>
                <Sparkline values={c.months.map((m) => m.defectRatePct)} className={tone === 'red' ? 'stroke-rose-500' : tone === 'amber' ? 'stroke-amber-500' : tone === 'green' ? 'stroke-emerald-500' : 'stroke-brand-500'} />
              </div>
            </Card>
          )
        })}
      </div>
      <p className="text-xs text-slate-400">Reject rate and PPM over {describeRange({ from: data.from, to: data.to })}; the trend line is the last {data.monthsBack} months, {trendSpan}, against the month before.</p>
    </div>
  )
}

/**
 * §15 — one angle on the general page: by factory or by process. Pick one,
 * see its trend and its machines against one another, tick a few machines to
 * compare them, and the breakdown below follows the pick: defects, their
 * months, the orders and items behind them, and first part released.
 */
function ScopeView({ kind, general, factories, t }: { kind: 'factory' | 'process'; general: KpiGeneral; factories: string[]; t: KpiThresholds }) {
  const [chosenFactories, setChosenFactories] = usePersistedState<string[]>('qc-dash:scope-factories', [])
  const [chosenProcesses, setChosenProcesses] = usePersistedState<Process[]>('qc-dash:scope-processes', [])
  const [pickedByScope, setPickedByScope] = usePersistedState<Record<string, string[]>>('qc-dash:scope-machines', {})
  const options: { key: string; label: string }[] =
    kind === 'factory'
      ? Array.from(new Set([...factories, ...general.factories.map((f) => f.factory)])).sort().map((f) => ({ key: f, label: f }))
      : PROCESSES.map((p) => ({ key: p, label: PROCESS_LABEL[p] }))
  // Several at once; none chosen means all of them together.
  const chosen = (kind === 'factory' ? chosenFactories : chosenProcesses).filter((k) => options.some((o) => o.key === k))
  const toggleScope = (key: string) => {
    if (kind === 'factory') setChosenFactories((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]))
    else setChosenProcesses((prev) => (prev.includes(key as Process) ? prev.filter((k) => k !== key) : [...prev, key as Process]))
  }
  const allScopes = () => (kind === 'factory' ? setChosenFactories([]) : setChosenProcesses([]))
  const inScope = (key: string) => chosen.length === 0 || chosen.includes(key)
  const scopeLabel = chosen.length === 0 ? (kind === 'factory' ? 'All factories' : 'All processes') : chosen.map((k) => options.find((o) => o.key === k)?.label ?? k).join(', ')
  const scopeKey = `${kind}:${[...chosen].sort().join('|') || '*'}`
  const machines = general.machines.filter((m) => inScope(kind === 'factory' ? m.factory : m.process))
  const picked = (pickedByScope[scopeKey] ?? []).filter((code) => machines.some((m) => m.workCenterCode === code))
  const togglePick = (code: string) =>
    setPickedByScope((prev) => {
      const now = prev[scopeKey] ?? []
      return { ...prev, [scopeKey]: now.includes(code) ? now.filter((c) => c !== code) : [...now, code] }
    })
  const clearPick = () => setPickedByScope((prev) => ({ ...prev, [scopeKey]: [] }))
  const { data: breakdown, isFetching } = useKpiBreakdown({
    from: general.from,
    to: general.to,
    factories: kind === 'factory' && chosen.length ? chosen : undefined,
    processes: kind === 'process' && chosen.length ? (chosen as Process[]) : undefined,
    workCenterCodes: picked.length ? picked : undefined,
  })
  const maxRate = Math.max(...machines.map((m) => m.defectRatePct ?? 0), 0.0001)
  // One line per member of the pick on the trend: the factories or the processes chosen, or all of them.
  const memberSeries = (breakdown ? (kind === 'factory' ? breakdown.series.factories : breakdown.series.processes) : []).filter((x) => inScope(x.key))
  const memberLines = memberSeries.slice(0, LINE_CLASSES.length).map((x, i) => ({ label: kind === 'process' ? (PROCESS_LABEL[x.key as Process] ?? x.key) : x.label, values: x.months.map((m) => m.defectRatePct), className: LINE_CLASSES[i] }))
  // The month charts under the pick run over the trend window to today; the period strip does not narrow them.
  const windowLabels = general.months.map((m) => monthLabel(m.month, false))
  const factoryLines = general.factories.slice(0, LINE_CLASSES.length).map((f, i) => ({ label: f.factory, values: f.months.map((m) => m.defectRatePct), className: LINE_CLASSES[i] }))
  const machinesForLines = (picked.length ? machines.filter((m) => picked.includes(m.workCenterCode)) : machines).slice(0, LINE_CLASSES.length)
  const machineLines = machinesForLines.map((m, i) => ({ label: m.label, values: m.months.map((x) => x.defectRatePct), className: LINE_CLASSES[i] }))
  const windowSpan = `${monthLabel(general.window.from.slice(0, 7))} – ${monthLabel(general.window.to.slice(0, 7))}`
  const detailTitle = picked.length ? `${picked.length === 1 ? 'Machine' : `${picked.length} machines`}: ${machines.filter((m) => picked.includes(m.workCenterCode)).map((m) => m.label).join(', ')}` : scopeLabel
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label={kind === 'factory' ? 'Factory' : 'Process'}>
        <button
          type="button"
          aria-pressed={chosen.length === 0}
          onClick={allScopes}
          className={cn('min-h-[40px] rounded-xl px-3 text-sm font-semibold ring-1 transition-colors', chosen.length === 0 ? 'bg-brand-600 text-white ring-brand-600' : 'bg-white text-slate-600 ring-slate-200 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-300 dark:ring-slate-700 dark:hover:bg-slate-800')}
        >
          {kind === 'factory' ? 'All factories' : 'All processes'}
        </button>
        {options.map((o) => {
          const on = chosen.includes(o.key)
          return (
            <button
              key={o.key}
              type="button"
              aria-pressed={on}
              onClick={() => toggleScope(o.key)}
              className={cn('inline-flex min-h-[40px] items-center gap-1.5 rounded-xl px-3 text-sm font-semibold ring-1 transition-colors', on ? 'bg-brand-600 text-white ring-brand-600' : 'bg-white text-slate-600 ring-slate-200 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-300 dark:ring-slate-700 dark:hover:bg-slate-800')}
            >
              {on && <Check className="h-3.5 w-3.5" />}
              {o.label}
            </button>
          )
        })}
        <span className="text-xs text-slate-400">Tap several to see them together.</span>
        {options.length === 0 && <p className="text-sm text-slate-400">No {kind === 'factory' ? 'factory' : 'process'} in the machine register yet.</p>}
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
        <Section title={`${scopeLabel}: trend`} hint={`Pieces made each month of ${describeRange({ from: general.from, to: general.to })} (produced + rejected) with the reject rate over them, and a line for each ${kind} in the pick.`} icon={<Activity className="h-4 w-4" />} className="xl:col-span-3">
          {breakdown ? (
            breakdown.months.some((m) => m.made > 0) ? (
              <TrendChart points={breakdown.months.map((m) => ({ label: monthLabel(m.month, false), bar: m.made, line: m.defectRatePct }))} barLabel="Pieces made" lineLabel={`Reject rate · ${scopeLabel}`} lines={memberLines.length > 1 || (memberLines.length === 1 && chosen.length === 0) ? memberLines : []} />
            ) : (
              <p className="py-10 text-center text-sm text-slate-400">No session closed with a final quantity in this period.</p>
            )
          ) : (
            <div className="skeleton h-48" />
          )}
        </Section>
        <Section title={`${scopeLabel}: machines`} hint="Reject rate of each machine over the period, worst first, with its trend. Tick machines to compare them; the breakdown below follows the ticks." icon={<Layers className="h-4 w-4" />} className="xl:col-span-2" action={picked.length > 0 && <button type="button" onClick={clearPick} className="text-xs font-semibold text-slate-500 hover:text-rose-600">Clear {picked.length} ticked</button>}>
          {machines.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-400">No production closed in this period.</p>
          ) : (
            <ul className="max-h-[26rem] space-y-1.5 overflow-y-auto pr-1">
              {machines.map((m) => {
                const on = picked.includes(m.workCenterCode)
                const tone = toneLowIsGood(m.defectRatePct, t.defectRateGreen, t.defectRateAmber)
                return (
                  <li key={m.workCenterCode}>
                    <button type="button" onClick={() => togglePick(m.workCenterCode)} aria-pressed={on} className={cn('flex w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/60', on && 'bg-brand-50 ring-1 ring-brand-300 dark:bg-brand-500/10 dark:ring-brand-500/40')}>
                      <span className={cn('grid h-5 w-5 shrink-0 place-items-center rounded border', on ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-300 dark:border-slate-600')}>{on && <Check className="h-3.5 w-3.5" />}</span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline justify-between gap-2 text-sm">
                          <span className="truncate font-medium text-slate-700 dark:text-slate-200">{m.label}<span className="ml-1.5 text-xs font-normal text-slate-400">{kind === 'process' ? m.factory : PROCESS_LABEL[m.process]}</span></span>
                          <span className="shrink-0 text-xs tabular-nums text-slate-500 dark:text-slate-400"><span className={cn('font-semibold', TONE_TEXT[tone])}>{pctStr(m.defectRatePct)}</span> · {ppmStr(m.defectRatePct)} PPM</span>
                        </span>
                        <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"><span className={cn('block h-full rounded-full', tone === 'red' ? 'bg-rose-500' : tone === 'amber' ? 'bg-amber-500' : tone === 'green' ? 'bg-emerald-500' : 'bg-slate-300')} style={{ width: `${Math.min(100, ((m.defectRatePct ?? 0) / maxRate) * 100)}%` }} /></span>
                      </span>
                      <Sparkline values={m.months.map((x) => x.defectRatePct)} width={56} height={20} />
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </Section>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Section title="Factories by month" hint={`Reject rate of every factory, ${windowSpan}. The period strip does not narrow this chart.`} icon={<Factory className="h-4 w-4" />}>
          <LineChart labels={windowLabels} series={factoryLines} />
        </Section>
        <Section title="Machines by month" hint={`${picked.length ? 'The ticked machines' : `The ${machinesForLines.length} worst machines of ${scopeLabel}`}, ${windowSpan}. The period strip does not narrow this chart; tick machines to choose the lines.`} icon={<Layers className="h-4 w-4" />}>
          <LineChart labels={windowLabels} series={machineLines} />
        </Section>
      </div>

      {breakdown && <ScopeDetails title={detailTitle} data={breakdown} t={t} dim={isFetching} />}
    </div>
  )
}

/** What a pick's rejected pieces are: which defects, in which months, on which orders and items; and how often the first part was clean. */
function ScopeDetails({ title, data, t, dim }: { title: string; data: KpiBreakdown; t: KpiThresholds; dim: boolean }) {
  const navigate = useNavigate()
  const made = data.months.reduce((n, m) => n + m.made, 0)
  const rejected = data.months.reduce((n, m) => n + m.productionDefectPieces, 0)
  const rate = made > 0 ? Math.round((rejected / made) * 10000) / 100 : null
  const monthsWithData = data.months.filter((m) => m.made > 0)
  const fp = data.firstPart
  const fpTone: KpiTone = fp.pct === null ? 'neutral' : fp.pct >= 95 ? 'green' : fp.pct >= 85 ? 'amber' : 'red'
  /** The cumulative yield reads the other way: lower is better, zero is clean. */
  const cumTone = (v: number | null): KpiTone => (v === null ? 'neutral' : v === 0 ? 'green' : v <= 15 ? 'amber' : 'red')
  const group = (rows: KpiBreakdown['byOrder']) => monthsWithData.map((m) => ({ month: m, rows: rows.filter((r) => r.month === m.month) })).filter((g) => g.rows.length > 0)
  const breakdownTable = (rows: KpiBreakdown['byOrder'], what: string) => (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400">
            <th className="px-2 py-1.5 font-semibold">{what}</th>
            <th className="px-2 py-1.5 text-right font-semibold">Rejected</th>
            <th className="px-2 py-1.5 text-right font-semibold">Of made</th>
            <th className="px-2 py-1.5 text-right font-semibold">Of period</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {group(rows).map((g) => (
            <Fragment key={g.month.month}>
              <tr className="bg-slate-50 dark:bg-slate-800/60">
                <td className="px-2 py-1.5 font-bold" colSpan={2}>{monthLabel(g.month.month)}</td>
                <td className="px-2 py-1.5 text-right"><ToneCell value={g.month.defectRatePct} tone={toneLowIsGood(g.month.defectRatePct, t.defectRateGreen, t.defectRateAmber)} /></td>
                <td className="px-2 py-1.5 text-right text-xs text-slate-400">{num(g.month.productionDefectPieces)} of {num(g.month.made)}</td>
              </tr>
              {g.rows.map((r) => (
                <tr key={`${r.month}|${r.key}`}>
                  <td className="px-2 py-1.5"><span className="font-semibold">{r.label}</span>{r.sub && <span className="ml-1 text-xs text-slate-400">{r.sub}</span>}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{num(r.pieces)}</td>
                  <td className="px-2 py-1.5 text-right font-semibold tabular-nums" title={`${num(r.pieces)} rejected of ${num(r.made)} made by this ${what.toLowerCase()} in the month`}>{pctStr(r.pctOfMade, 3)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-slate-500">{pctStr(r.shareOfPeriodPct, 0)}</td>
                </tr>
              ))}
            </Fragment>
          ))}
          {group(rows).length === 0 && (
            <tr><td colSpan={4} className="py-6 text-center text-sm text-slate-400">No rejected piece in these months.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
  return (
    <div className={cn('space-y-4 transition-opacity', dim && 'opacity-70')}>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h2 className="text-lg font-extrabold tracking-tight">{title}</h2>
        <p className="text-xs text-slate-400">{describeRange({ from: data.filters.from, to: data.filters.to })}</p>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <PlainTile label="Reject rate" value={pctStr(rate)} sub={`${num(rejected)} rejected of ${num(made)} made`} icon={<Target className="h-4 w-4" />} tone={toneLowIsGood(rate, t.defectRateGreen, t.defectRateAmber)} />
        <PlainTile label="PPM" value={ppmStr(rate)} sub="rejected pieces per million made" icon={<AlertTriangle className="h-4 w-4" />} tone={toneLowIsGood(rate, t.defectRateGreen, t.defectRateAmber)} />
        <PlainTile label="First part released" value={pctStr(fp.pct, 0)} sub={`${num(fp.clean)} of ${num(fp.sessions)} sessions with nothing rejected before release`} icon={<PackageCheck className="h-4 w-4" />} tone={fpTone} />
        <PlainTile label="First pass yield cumulative" value={pctStr(fp.cumulativePct, 0)} sub={`${num(fp.rejectedPieces)} rejected before release ÷ (${num(fp.clean)} clean sessions + ${num(fp.rejectedPieces)}) · lower is better`} icon={<PackageCheck className="h-4 w-4" />} tone={cumTone(fp.cumulativePct)} />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
        <Section title="Pareto of defects" hint="Rejected pieces by defect, largest first, with the running share: the few defects that make most of the pieces." icon={<AlertTriangle className="h-4 w-4" />} className="xl:col-span-2">
          <ParetoChart bars={paretoOf(data.defects.map((d) => ({ label: d.defectName, value: d.pieces })))} />
        </Section>
        <Section title="Defects by month" hint="Each defect's rejected pieces in each month, and its share of that month's rejected pieces against the other defects." icon={<Activity className="h-4 w-4" />} className="xl:col-span-3">
          {data.defects.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-400">No rejected piece in these months.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400">
                    <th className="px-2 py-1.5 font-semibold">Defect</th>
                    {data.months.map((m) => <th key={m.month} className="px-2 py-1.5 text-right font-semibold">{monthLabel(m.month, false)}</th>)}
                    <th className="px-2 py-1.5 text-right font-semibold">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  <tr className="bg-slate-50 font-semibold dark:bg-slate-800/60">
                    <td className="px-2 py-1.5">All rejected · rate</td>
                    {data.months.map((m) => <td key={m.month} className="px-2 py-1.5 text-right tabular-nums">{m.made > 0 ? <>{num(m.productionDefectPieces)} <span className="text-xs text-slate-400">{pctStr(m.defectRatePct)}</span></> : <span className="text-slate-300">—</span>}</td>)}
                    <td className="px-2 py-1.5 text-right tabular-nums">{num(rejected)} <span className="text-xs text-slate-400">{pctStr(rate)}</span></td>
                  </tr>
                  {data.defects.slice(0, 15).map((d) => (
                    <tr key={d.defectName}>
                      <td className="px-2 py-1.5" dir="auto">{d.defectName}</td>
                      {d.months.map((m) => {
                        const monthRejected = data.months.find((x) => x.month === m.month)?.productionDefectPieces ?? 0
                        return <td key={m.month} className="px-2 py-1.5 text-right tabular-nums">{m.pieces > 0 ? <>{num(m.pieces)} <span className="text-xs text-slate-400">{pctStr(monthRejected > 0 ? Math.round((m.pieces / monthRejected) * 1000) / 10 : null, 0)}</span></> : <span className="text-slate-300">—</span>}</td>
                      })}
                      <td className="px-2 py-1.5 text-right font-semibold tabular-nums">{num(d.pieces)} <span className="text-xs font-normal text-slate-400">{pctStr(d.sharePct, 0)}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Section title="By order line" hint="Each month's rejected pieces laid on the order lines closed in it. Of made is against what that order line itself made (its produced + rejected); Of period is the share of every rejected piece in the period." icon={<ClipboardList className="h-4 w-4" />}>
          {breakdownTable(data.byOrder, 'Order')}
        </Section>
        <Section title="By item" hint="The same rejected pieces laid on the items." icon={<Layers className="h-4 w-4" />}>
          {breakdownTable(data.byItem, 'Item')}
        </Section>
      </div>

      <Section title="First part released" hint="By session: clean when nothing was rejected on the line before the release inspection. Sessions started in the period." icon={<PackageCheck className="h-4 w-4" />}>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
          <div className="space-y-3 xl:col-span-2">
            <div className="grid grid-cols-3 gap-2">
              {[
                { k: 'First pass yield cumulative', v: pctStr(fp.cumulativePct, 1), s: `${num(fp.rejectedPieces)} ÷ (${num(fp.clean)} clean + ${num(fp.rejectedPieces)})`, tone: cumTone(fp.cumulativePct) },
                { k: 'Not clean', v: num(fp.sessions - fp.clean), s: `of ${num(fp.sessions)} sessions`, tone: fp.sessions - fp.clean > 0 ? ('red' as KpiTone) : ('green' as KpiTone) },
                { k: 'Rejected before release', v: num(fp.rejectedPieces), s: 'pieces', tone: 'neutral' as KpiTone },
              ].map((x) => (
                <div key={x.k} className={cn('rounded-xl p-3 ring-1', TONE_RING[x.tone])}>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{x.k}</p>
                  <p className={cn('mt-1 text-xl font-extrabold tabular-nums', TONE_TEXT[x.tone])}>{x.v}</p>
                  <p className="text-xs text-slate-400">{x.s}</p>
                </div>
              ))}
            </div>
            <div>
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">By month</p>
              <ul className="flex flex-wrap gap-2 text-xs">
                {fp.months.map((m) => (
                  <li key={m.month} className="rounded-lg bg-slate-50 px-2 py-1 dark:bg-slate-800/60">
                    <span className="font-semibold">{monthLabel(m.month, false)}</span>{' '}
                    {m.sessions > 0 ? <><span className={cn('font-semibold', TONE_TEXT[cumTone(m.cumulativePct)])}>{pctStr(m.cumulativePct, 1)}</span> <span className="text-slate-400">{num(m.rejectedPieces)} ÷ ({num(m.clean)} + {num(m.rejectedPieces)})</span></> : <span className="text-slate-300">—</span>}
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <div className="xl:col-span-3">
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Pieces rejected before release, by machine, month by month</p>
            <LineChart labels={fp.months.map((m) => monthLabel(m.month, false))} series={fp.byMachineMonth.slice(0, LINE_CLASSES.length).map((m, i) => ({ label: m.label, values: m.months.map((x) => (x.sessions > 0 ? x.rejectedPieces : null)), className: LINE_CLASSES[i] }))} unit="" height={200} />
          </div>
        </div>
        {fp.failed.length > 0 && (
          <div className="mt-4">
            <Table
              rows={fp.failed}
              rowKey={(r) => r.sessionId}
              maxRows={8}
              columns={[
                { key: 'd', label: 'Started', className: 'whitespace-nowrap', render: (r) => shortDay(r.startedAt.slice(0, 10)) },
                { key: 'o', label: 'Order', render: (r) => <span className="font-semibold">{r.orderNumber}</span> },
                { key: 'i', label: 'Item', render: (r) => <span className="text-slate-600 dark:text-slate-300">{r.item}</span> },
                { key: 'm', label: 'Machine', render: (r) => r.machineLabel },
                { key: 'w', label: 'Inspector', render: (r) => r.inspectorName },
                { key: 'q', label: 'Rejected before', className: 'text-right', render: (r) => <Badge tone="red">{num(r.rejectedBeforeRelease)} pcs</Badge> },
                { key: 'go', label: '', className: 'print-hidden text-right', render: (r) => (<button type="button" onClick={() => navigate(`/wizard/${r.sessionId}`)} className="text-xs font-semibold text-brand-700 hover:underline dark:text-brand-300">Session</button>) },
              ]}
            />
          </div>
        )}
      </Section>
    </div>
  )
}

/** One card per machine of the selection: the rate, its trend, and the pieces behind it. */
function MachineCards({ rows, previous, t, onPick }: { rows: KpiGroupRow[]; previous: KpiGroupRow[]; t: KpiThresholds; onPick: (code: string) => void }) {
  if (rows.length === 0) return <p className="py-6 text-center text-sm text-slate-400">No machine inspected in this period.</p>
  const before = new Map(previous.map((r) => [r.key.toLowerCase(), r]))
  const sorted = [...rows].sort((a, b) => (b.defectRatePct ?? -1) - (a.defectRatePct ?? -1) || b.defectPieces - a.defectPieces)
  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {sorted.map((m) => {
        const prev = before.get(m.key.toLowerCase())
        const delta = deltaPct(m.defectRatePct, prev?.defectRatePct ?? null)
        const up = delta !== null && delta > 0
        const flat = delta !== null && Math.abs(delta) < 0.05
        const tone = toneLowIsGood(m.defectRatePct, t.defectRateGreen, t.defectRateAmber)
        const produced = m.piecesProduced ?? 0
        const defective = m.productionDefectPieces ?? 0
        return (
          <li key={m.key}>
            <button type="button" onClick={() => onPick(m.key)} className={cn('block w-full rounded-2xl p-4 text-left ring-1 transition-shadow hover:shadow-hover', TONE_RING[tone])}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-bold">{m.label}</p>
                  {m.sub && <p className="truncate text-xs text-slate-400">{m.sub}</p>}
                </div>
                <span className={cn('inline-flex shrink-0 items-center gap-0.5 text-xs font-semibold tabular-nums', delta === null ? 'text-slate-400' : flat ? 'text-slate-500' : up ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400')} title={prev ? `Was ${pctStr(prev.defectRatePct)} in the comparison period` : 'Nothing in the comparison period'}>
                  {delta === null ? <Minus className="h-3 w-3" /> : flat ? <Minus className="h-3 w-3" /> : up ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
                  {delta === null ? 'new' : flat ? 'flat' : `${Math.abs(delta).toFixed(1)}%`}
                </span>
              </div>
              <p className={cn('mt-1 text-2xl font-extrabold tabular-nums tracking-tight', TONE_TEXT[tone])}>
                {pctStr(m.defectRatePct)}
                <span className="ml-1 text-xs font-semibold text-slate-400">defect rate</span>
              </p>
              <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
                <div><dt className="text-slate-400">Produced</dt><dd className="font-semibold tabular-nums">{m.piecesProduced === null ? '—' : num(produced)}</dd></div>
                <div><dt className="text-slate-400">Released</dt><dd className="font-semibold tabular-nums text-emerald-700 dark:text-emerald-300">{m.piecesProduced === null ? '—' : num(Math.max(0, produced - defective))}</dd></div>
                <div><dt className="text-slate-400">Defective</dt><dd className="font-semibold tabular-nums text-rose-600 dark:text-rose-400">{m.piecesProduced === null ? num(m.defectPieces) : num(defective)}</dd></div>
              </dl>
              <p className="mt-1.5 text-[11px] text-slate-400">{num(m.pieces)} inspected in {num(m.samples)} samples · {pctStr(m.inspectedDefectPct)} of inspected</p>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

/** The fixed right side: one list, largest defect count first, each row tappable to filter the page. */
function TopDown({ title, hint, icon, rows, t }: { title: string; hint: string; icon: ReactNode; rows: { key: string; label: string; sub?: string; pieces: number; rate: number | null; onClick: () => void }[]; t: KpiThresholds }) {
  const shown = rows.filter((r) => r.pieces > 0).slice(0, 10)
  return (
    <Section title={title} hint={hint} icon={icon}>
      <HorizontalBars
        rows={shown.map((r) => ({
          label: r.label,
          sub: r.sub,
          value: r.pieces,
          tone: toneLowIsGood(r.rate, t.defectRateGreen, t.defectRateAmber),
          text: `${num(r.pieces)} pcs${r.rate === null ? '' : ` · ${pctStr(r.rate)}`}`,
          onClick: r.onClick,
        }))}
      />
    </Section>
  )
}

// ---- The page --------------------------------------------------------------

interface DashFilters {
  preset: PeriodPreset
  compare: ComparePreset
  customFrom: string
  customTo: string
  factory: string
  /** A process group of the register; narrows the machine list and every figure. */
  process: '' | Process
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
  process: '',
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
      factories: f.factory ? [f.factory] : undefined,
      processes: f.process ? [f.process] : undefined,
      workCenterCodes: f.workCenterCode ? [f.workCenterCode] : undefined,
      itemCode: f.itemCode.trim() || undefined,
      inspectorId: f.inspectorId || undefined,
      shift: f.shift || undefined,
    }),
    [range, prev, f.factory, f.process, f.workCenterCode, f.itemCode, f.inspectorId, f.shift],
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
  const [view, setView] = usePersistedState<'general' | 'inspectors'>('qc-dash:tab', 'general')
  /** Which angle the general page is read from; Details is the full analysis behind the filters. */
  const [pick, setPick] = usePersistedState<GeneralPick>('qc-dash:pick', 'factory')
  const showDetails = view === 'inspectors' || pick === 'details'
  const { data: general, isLoading: generalLoading, error: generalError } = useKpiGeneral(range, allowed)
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
  // The process narrows the machine list the way the factory does, so the
  // Machine select only ever offers what the page is already showing.
  const machineOptions = useMemo(
    () => machines.filter((m) => (!f.factory || (m.factory ?? '') === f.factory) && (!f.process || (m.process ?? 'forming') === f.process)).sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [machines, f.factory, f.process],
  )
  const activeFilters = [f.factory && `Factory ${f.factory}`, f.process && PROCESS_LABEL[f.process], f.workCenterCode && `Machine ${f.workCenterCode}`, f.itemCode && `Item ${f.itemCode}`, f.inspectorId && (users.find((u) => u.id === f.inspectorId)?.name ?? inspectorChoices.withRecord.find((r) => r.id === f.inspectorId)?.name ?? 'Inspector'), f.shift && `${shiftName(f.shift)} shift`].filter(Boolean) as string[]

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
          {view === 'general' && pick !== 'details' ? (
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              <span className="font-semibold text-slate-700 dark:text-slate-200">{describeRange(range)}</span> · reject rate = rejected ÷ (produced + rejected) · trend over the last {general?.monthsBack ?? 4} months
              {general && <span className="hidden print:inline"> · generated {formatDateTime(general.generatedAt)}</span>}
            </p>
          ) : (
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              <span className="font-semibold text-slate-700 dark:text-slate-200">{describeRange(range)}</span> compared with {describeRange(prev)}
              {activeFilters.length > 0 && <span> · {activeFilters.join(' · ')}</span>}
              {data && <span className="hidden print:inline"> · generated {formatDateTime(data.generatedAt)}</span>}
            </p>
          )}
        </div>
        <div className="print-hidden flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-xl p-0.5 ring-1 ring-slate-200 dark:ring-slate-700">
            {(
              [
                ['general', 'General', Factory],
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

      {/* §15 — the period is a timeline strip: two handles to drag, presets to jump. It rules every page. */}
      <Card className="print-hidden p-4">
        <PeriodSlicer
          value={range}
          preset={f.preset}
          firstDay={span?.firstDay ?? null}
          onChange={(next, preset) => patch({ preset, customFrom: next.from, customTo: next.to })}
        />
      </Card>

      {/* §15 — the general page: the plant and its factories on three figures, then one angle to read it from. */}
      {view === 'general' && (
        <>
          <GeneralOverview data={general ?? null} loading={generalLoading} error={generalError instanceof ApiError ? generalError.message : generalError ? 'The general page could not be loaded.' : null} />
          <div className="print-hidden flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-bold uppercase tracking-[0.18em] text-slate-400">Read it</span>
            <div className="inline-flex rounded-xl p-0.5 ring-1 ring-slate-200 dark:ring-slate-700">
              {(
                [
                  ['factory', 'By factory', Factory],
                  ['process', 'By process', Layers],
                  ['details', 'Details', LayoutGrid],
                ] as const
              ).map(([key, label, Icon]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setPick(key)}
                  aria-pressed={pick === key}
                  className={cn('inline-flex min-h-[40px] items-center gap-1.5 rounded-[10px] px-3 text-sm font-semibold transition-colors', pick === key ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800')}
                >
                  <Icon className="h-4 w-4" /> {label}
                </button>
              ))}
            </div>
            {pick === 'details' && <span className="text-xs text-slate-400">The full analysis: the filters below narrow it.</span>}
          </div>
          {general && pick !== 'details' && <ScopeView kind={pick} general={general} factories={factories} t={general.thresholds} />}
        </>
      )}


      {/* Filters — for the details and the inspector ranking. */}
      <Card className={cn('print-hidden space-y-3 p-4', !showDetails && 'hidden')}>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-7">
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
          <Field label="Process">
            <Select value={f.process} onChange={(e) => patch({ process: e.target.value as DashFilters['process'], workCenterCode: '' })}>
              <option value="">All processes</option>
              {PROCESSES.map((p) => (
                <option key={p} value={p}>
                  {PROCESS_LABEL[p]}
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
            <button type="button" onClick={() => patch({ factory: '', process: '', workCenterCode: '', itemCode: '', inspectorId: '', shift: '' })} className="inline-flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-rose-600">
              <X className="h-3.5 w-3.5" /> Clear filters
            </button>
          </div>
        )}
      </Card>

      {error && showDetails && (
        <Card className="border border-rose-200 p-4 text-sm text-rose-700 dark:border-rose-500/30 dark:text-rose-300">
          {error instanceof ApiError ? error.message : 'The dashboard could not be loaded.'}
        </Card>
      )}

      {isLoading && !data && showDetails && (
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
          <div className={cn('grid grid-cols-1 gap-4 xl:grid-cols-4', !(view === 'general' && pick === 'details') && '[@media_screen]:hidden')}>
          <div className="min-w-0 space-y-5 xl:col-span-3">
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

          {/* §15 — the analysis: each machine of the selection, the months, and how spread each defect is. */}
          <Section
            title="Machines"
            hint={`Each machine of the selection: defect pieces per 100 produced, against ${describeRange(prev)}; produced, released and defective are the sessions closed in the period. Tap a machine to filter the page to it.${showing(data.byMachine.length, data.counts.machines)}`}
            icon={<Activity className="h-4 w-4" />}
          >
            <MachineCards rows={data.byMachine} previous={data.byMachinePrevious} t={t} onPick={(code) => patch({ workCenterCode: code })} />
          </Section>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
            <Section title="Month by month" hint="Pieces produced each month of the period, with the defect rate over them." icon={<Activity className="h-4 w-4" />} className="xl:col-span-2">
              <TrendChart points={data.monthly.map((m) => ({ label: monthLabel(m.month, false), bar: m.piecesProduced, line: m.defectRatePct }))} barLabel="Pieces produced" lineLabel="Defect rate" />
            </Section>
            <Section title="Defect details" hint={`Every defect of the selection, largest first: the pieces, on how many distinct days it was recorded, and on how many order lines.${showing(Math.min(12, data.defectDetails.length), data.counts.defectTypes)}`} icon={<AlertTriangle className="h-4 w-4" />} className="xl:col-span-3">
              <Table
                rows={data.defectDetails}
                rowKey={(r) => r.defectName}
                maxRows={12}
                total={data.counts.defectTypes}
                empty="No defects recorded in this period."
                columns={[
                  { key: 'd', label: 'Defect', render: (r) => <span dir="auto" className="font-semibold">{r.defectName}</span> },
                  { key: 'p', label: 'Pieces', className: 'text-right tabular-nums font-semibold', render: (r) => num(r.pieces) },
                  { key: 'r', label: 'Records', className: 'text-right tabular-nums', render: (r) => num(r.records) },
                  { key: 'days', label: 'Days seen', className: 'text-right tabular-nums', render: (r) => num(r.days) },
                  { key: 'orders', label: 'Orders', className: 'text-right tabular-nums', render: (r) => num(r.orders) },
                  {
                    key: 'share',
                    label: 'Share',
                    className: 'w-40',
                    render: (r) => (
                      <span className="flex items-center gap-2">
                        <span className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"><span className="block h-full rounded-full bg-rose-500" style={{ width: `${Math.min(100, r.sharePct)}%` }} /></span>
                        <span className="w-12 text-right text-xs font-semibold tabular-nums">{pctStr(r.sharePct)}</span>
                      </span>
                    ),
                  },
                ]}
              />
            </Section>
          </div>

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

          </div>
          {/* The fixed right side: top down, the machines then the items, by defect pieces. */}
          <aside className="space-y-4 xl:sticky xl:top-20 xl:self-start">
            <TopDown
              title="Defects by machine"
              hint="Defect pieces of the sessions closed in the period, largest first."
              icon={<Activity className="h-4 w-4" />}
              rows={[...data.byMachine]
                .sort((a, b) => (b.productionDefectPieces ?? b.defectPieces) - (a.productionDefectPieces ?? a.defectPieces))
                .map((m) => ({ key: m.key, label: m.label, sub: m.sub, pieces: m.productionDefectPieces ?? m.defectPieces, rate: m.defectRatePct, onClick: () => patch({ workCenterCode: m.key }) }))}
              t={t}
            />
            <TopDown
              title="Defects by item"
              hint="Defect pieces per item, largest first, with the item's defect rate over its production."
              icon={<Layers className="h-4 w-4" />}
              rows={[...data.byItem]
                .sort((a, b) => (b.productionDefectPieces ?? b.defectPieces) - (a.productionDefectPieces ?? a.defectPieces))
                .map((r) => ({ key: r.key, label: r.label, sub: r.key, pieces: r.productionDefectPieces ?? r.defectPieces, rate: r.defectRatePct, onClick: () => patch({ itemCode: r.key }) }))}
              t={t}
            />
          </aside>
          </div>

          {/* Everything that was on the Overview page, full width, unchanged. */}
          <div className={cn('space-y-5', !(view === 'general' && pick === 'details') && '[@media_screen]:hidden')}>
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
