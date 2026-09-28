// ============================================================================
// §15 — the quality dashboard. One period against its comparison, every
// KPI the floor's records can support, and a short list of what a quality
// manager would say about them. Administrators only.
// ============================================================================

import { Fragment, useContext, useMemo, useState, type ReactNode } from 'react'
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
  LayoutDashboard,
  RefreshCw,
  RotateCcw,
  Save,
  Undo2,
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
import { GENERAL_MONTHS, defaultDashboardLayouts, deltaPct, normaliseDashboardLayout, insightKey, pct, ppm, toneHighIsGood, toneLowIsGood, type DashboardLayouts, type KpiBreakdown, type KpiDrillQuery, type KpiFilters, type KpiFirstPart, type KpiGeneral, type KpiGroupRow, type KpiInsight, type KpiOverview, type KpiThresholds, type KpiTone } from '@qc/shared/kpi'
import { PROCESSES, PROCESS_LABEL, type Process } from '@qc/shared/types'
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Select, type BadgeTone } from '@/components/ui'
import { InspectorRanking } from '@/components/dashboard/InspectorRanking'
import { PeriodSlicer } from '@/components/dashboard/PeriodSlicer'
import { ColumnChart, DonutChart, HorizontalBars, LINE_CLASSES, LineChart, PairedBarChart, ParetoChart, PieChart, Sparkline, TrendChart, slicesOf } from '@/components/dashboard/charts'
import { Board, BoardContext, ChartGallery, WidgetLabelContext, type BoardState, type BoardWidget } from '@/components/dashboard/Board'
import { DrillModal, type DrillSpec } from '@/components/dashboard/DrillModal'
import { FilterNote, FilterTh, MultiSelectMenu, byName, useColumnFilters } from '@/components/dashboard/filters'
import { kpiSheets } from '@/components/dashboard/exportKpi'
import { COMPARE_PRESETS, PERIOD_PRESETS, addDays, compareRange, describeRange, isMonthAligned, monthLabel, presetRange, shortDay, toDay, type ComparePreset, type PeriodPreset } from '@/components/dashboard/period'
import { downloadWorkbook } from '@/lib/xlsxWrite'
import { usePersistedState } from '@/lib/usePersistedState'
import { cn, formatDateTime } from '@/lib/utils'
import { useDashboardLayout, useHiddenInsights, useKpiBreakdown, useKpiGeneral, useKpiOverview, useKpiSpan, useMaster, useUsers } from '@/services/queries'
import { hideInsight, resetDashboardLayout, restoreInsight, saveDashboardLayout } from '@/services/mutations'
import { useAuth } from '@/store/AuthContext'
import { useApp } from '@/store/AppContext'
import { ApiError } from '@/lib/api'

// ---- Formatting ------------------------------------------------------------

const num = (v: number | null | undefined, digits = 0): string => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toLocaleString('en-GB', { maximumFractionDigits: digits, minimumFractionDigits: 0 }))
const pctStr = (v: number | null | undefined, digits = 2): string => (v === null || v === undefined ? '—' : `${v.toFixed(digits)}%`)

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
  const flat = delta !== null && Math.abs(delta) < 0.005
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
            {flat ? 'flat' : `${Math.abs(delta).toFixed(2)}%`}
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
  onRowClick,
}: {
  rows: T[]
  columns: Column<T>[]
  rowKey: (r: T) => string
  /** A row opens what is behind it. */
  onRowClick?: (r: T) => void
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
        <thead className="sticky top-0 z-10 bg-white dark:bg-slate-900">
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
            <tr key={rowKey(r)} onClick={onRowClick && (() => onRowClick(r))} className={cn('transition-colors hover:bg-slate-50/80 dark:hover:bg-slate-800/40', onRowClick && 'cursor-pointer')}>
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

function ToneCell({ value, tone, digits = 2 }: { value: number | null; tone: KpiTone; digits?: number }) {
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

function Section({ title: ownTitle, hint: ownHint, icon, children, className, action }: { title: string; hint?: string; icon?: ReactNode; children: ReactNode; className?: string; action?: ReactNode }) {
  // On a board an administrator may have named and described the widget; that wins over the code's words.
  const label = useContext(WidgetLabelContext)
  const title = label.title || ownTitle
  const hint = label.title || label.hint ? label.hint || undefined : ownHint
  return (
    <Card className={cn('flex h-full min-h-0 flex-col p-4 sm:p-5', className)}>
      <div className="mb-3 flex shrink-0 flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          {icon && <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">{icon}</span>}
          <div className="min-w-0">
            <h2 className="text-base font-bold leading-tight">{title}</h2>
            {hint && <p className="text-xs text-slate-500 dark:text-slate-400">{hint}</p>}
          </div>
        </div>
        {action}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </Card>
  )
}

// ---- The general page and the analysis blocks --------------------------------

function PlainTile({ label, value, sub, icon, tone = 'neutral', control, onOpen }: { label: string; value: string; sub?: ReactNode; icon: ReactNode; tone?: KpiTone; control?: ReactNode; onOpen?: () => void }) {
  const opens = onOpen
    ? { role: 'button' as const, tabIndex: 0, onClick: onOpen, onKeyDown: (e: { key: string; preventDefault: () => void }) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onOpen()), 'aria-label': `${label}: open the sessions behind it` }
    : {}
  return (
    <Card className={cn('p-4 ring-1', TONE_RING[tone], onOpen && 'cursor-pointer transition-shadow hover:shadow-hover')} {...opens}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
          {control && <div className="print-hidden mt-1">{control}</div>}
        </div>
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
  const flat = delta !== null && Math.abs(delta) < 0.005
  return (
    <span
      className={cn('inline-flex shrink-0 items-center gap-0.5 text-xs font-semibold tabular-nums', delta === null ? 'text-slate-400' : flat ? 'text-slate-500' : up ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400')}
      title={title ?? (delta === null ? 'No month to compare with' : 'Against the month before')}
    >
      {delta === null || flat ? <Minus className="h-3 w-3" /> : up ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
      {delta === null ? '—' : flat ? 'flat' : `${Math.abs(delta).toFixed(2)}%`}
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
    return { label: r.label, value: r.value, cumulativePct: Math.round((running / total) * 10000) / 100 }
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
/** The trend window in words: "Sept 2026" for one month, "Jun 2026 – Sept 2026" for several. */
function windowWords(g: KpiGeneral): string {
  const a = g.window.from.slice(0, 7)
  const b = g.window.to.slice(0, 7)
  return a === b ? monthLabel(a) : `${monthLabel(a)} – ${monthLabel(b)}`
}

/** How the trend window reads in a sentence: "this month" or "the last 3 months". */
function windowLength(g: KpiGeneral): string {
  return g.monthsBack <= 1 ? 'this month' : `the last ${g.monthsBack} months`
}

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
  const trendSpan = windowWords(data)
  const cards = [
    { key: '__plant', label: 'Whole plant', sub: `${num(data.totals.factories)} factories · ${num(data.totals.machines)} machines`, rate: data.totals.defectRatePct, months: data.months },
    ...[...data.factories].sort((a, b) => byName(a.factory, b.factory)).map((f) => ({ key: f.factory, label: f.factory, sub: Array.from(new Set(data.machines.filter((m) => m.factory === f.factory).map((m) => PROCESS_LABEL[m.process]))).join(' · ') || 'no process', rate: f.defectRatePct, months: f.months })),
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
      <p className="text-xs text-slate-400">Reject rate and PPM over {describeRange({ from: data.from, to: data.to })}; the trend line is {windowLength(data)}, {trendSpan}{data.monthsBack > 1 ? ', against the month before' : ''}; it starts on the first month with production.</p>
    </div>
  )
}

/**
 * §15 — one angle on the general page: by factory or by process. Pick one,
 * see its trend and its machines against one another, tick a few machines to
 * compare them, and the breakdown below follows the pick: defects, their
 * months, the orders and items behind them, and first part released.
 */
/** What is picked on the general page: factories, processes, and the machines ticked under each scope. */
interface ScopePicks {
  factories: string[]
  processes: Process[]
  machines: Record<string, string[]>
}
const NO_PICKS: ScopePicks = { factories: [], processes: [], machines: {} }

function ScopeView({ kind, general, factories, t, picks, setPicks }: { kind: 'factory' | 'process'; general: KpiGeneral; factories: string[]; t: KpiThresholds; picks: ScopePicks; setPicks: (next: ScopePicks | ((prev: ScopePicks) => ScopePicks)) => void }) {
  const navigate = useNavigate()
  /** The machines of the first-part widgets, several at once, kept on the device. */
  const [fpMachines, setFpMachines] = usePersistedState<string[]>('qc-dash:fp-machines', [])
  const chosenFactories = picks.factories
  const chosenProcesses = picks.processes
  const pickedByScope = picks.machines
  const setChosenFactories = (f: (prev: string[]) => string[]) => setPicks((prev) => ({ ...prev, factories: f(prev.factories) }))
  const setChosenProcesses = (f: (prev: Process[]) => Process[]) => setPicks((prev) => ({ ...prev, processes: f(prev.processes) }))
  const setPickedByScope = (f: (prev: Record<string, string[]>) => Record<string, string[]>) => setPicks((prev) => ({ ...prev, machines: f(prev.machines) }))
  const options: { key: string; label: string }[] =
    kind === 'factory'
      ? Array.from(new Set([...factories, ...general.factories.map((f) => f.factory)])).sort(byName).map((f) => ({ key: f, label: f }))
      : PROCESSES.map((p) => ({ key: p, label: PROCESS_LABEL[p] }))
  // Several at once; none chosen means all of them together.
  const chosen = (kind === 'factory' ? chosenFactories : chosenProcesses).filter((k) => options.some((o) => o.key === k))
  const toggleScope = (key: string) => {
    if (kind === 'factory') setChosenFactories((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]))
    else setChosenProcesses((prev) => (prev.includes(key as Process) ? prev.filter((k) => k !== key) : [...prev, key as Process]))
  }
  const allScopes = () => (kind === 'factory' ? setChosenFactories(() => []) : setChosenProcesses(() => []))
  const inScope = (key: string) => chosen.length === 0 || chosen.includes(key)
  const scopeLabel = chosen.length === 0 ? (kind === 'factory' ? 'All factories' : 'All processes') : chosen.map((k) => options.find((o) => o.key === k)?.label ?? k).join(', ')
  const scopeKey = `${kind}:${[...chosen].sort().join('|') || '*'}`
  const machines = general.machines.filter((m) => inScope(kind === 'factory' ? m.factory : m.process))
  // By process the machines are listed under their process; by factory they are one list, worst first, whatever the factory.
  const machineGroups =
    kind === 'process'
      ? PROCESSES.map((p) => ({ key: p, label: PROCESS_LABEL[p] as string | null, machines: machines.filter((m) => m.process === p) })).filter((g) => g.machines.length > 0)
      : [{ key: 'all', label: null as string | null, machines }]
  // The period's rejected pieces by factory or by process, the whole plant: the picks do not narrow the pie.
  const periodScopeRows =
    kind === 'factory'
      ? general.factories.map((f) => ({ key: f.factory, label: f.factory || '(no factory)', value: f.productionDefectPieces }))
      : PROCESSES.map((p) => ({ key: p as string, label: PROCESS_LABEL[p], value: general.machines.filter((m) => m.process === p).reduce((n, m) => n + m.productionDefectPieces, 0) }))
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
  // §15 — what is behind a number: the pick as the breakdown reads it, the scope chips alone, or the whole period.
  const pickQuery: KpiDrillQuery = {
    from: general.from,
    to: general.to,
    factories: kind === 'factory' && chosen.length ? chosen : undefined,
    processes: kind === 'process' && chosen.length ? (chosen as Process[]) : undefined,
    workCenterCodes: picked.length ? picked : undefined,
  }
  const scopeQuery: KpiDrillQuery = { ...pickQuery, workCenterCodes: undefined }
  const spanWords = describeRange({ from: general.from, to: general.to })
  const [drill, setDrill] = useState<DrillSpec | null>(null)
  const maxRate = Math.max(...machines.map((m) => m.defectRatePct ?? 0), 0.0001)
  // The plant trend runs over the trend window to today, whole plant, a line per factory: neither the period strip nor the picks narrow it.
  const windowLabels = general.months.map((m) => monthLabel(m.month, false))
  const factoryLines = [...general.factories].sort((a, b) => byName(a.factory, b.factory)).slice(0, LINE_CLASSES.length).map((f, i) => ({ label: f.factory, values: f.months.map((m) => m.defectRatePct), className: LINE_CLASSES[i] }))
  const windowSpan = windowWords(general)
  // The month charts of the pick: the period's months, the pick's factories, and its machines with the highest reject rate.
  const pickLabels = (breakdown?.months ?? []).map((m) => monthLabel(m.month, false))
  const pickFactoryLines = (breakdown?.series.factories ?? []).slice(0, LINE_CLASSES.length).map((f, i) => ({ label: f.label, values: f.months.map((m) => m.defectRatePct), className: LINE_CLASSES[i] }))
  const pickMachines = [...(breakdown?.series.machines ?? [])].filter((m) => m.made > 0).sort((a, b) => (b.defectRatePct ?? -1) - (a.defectRatePct ?? -1) || b.made - a.made).slice(0, LINE_CLASSES.length)
  const pickMachineLines = pickMachines.map((m, i) => ({ label: m.label, values: m.months.map((x) => x.defectRatePct), className: LINE_CLASSES[i] }))
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

      <Board
        page="general"
        className={cn('transition-opacity', isFetching && 'opacity-70')}
        widgets={[
          { id: 'g.trend', title: 'Plant trend, last months', node: (
        <Section title="Plant: trend" hint={`Pieces made each month, ${windowSpan} (produced + rejected), from the first month with production and at most the last ${GENERAL_MONTHS}, with the plant's reject rate over them and a line for each factory. Neither the period strip nor the picks narrow this chart.`} icon={<Activity className="h-4 w-4" />} className="xl:col-span-3">
          {general.months.some((m) => m.piecesProduced + m.productionDefectPieces > 0) ? (
            <TrendChart points={general.months.map((m) => ({ label: monthLabel(m.month, false), bar: m.piecesProduced + m.productionDefectPieces, line: m.defectRatePct }))} barLabel="Pieces made" lineLabel="Reject rate · plant" lines={factoryLines} />
          ) : (
            <p className="py-10 text-center text-sm text-slate-400">No session closed with a final quantity in these months.</p>
          )}
        </Section>
          ) },
          { id: 'g.machines', title: 'Machines of the pick', node: (
        <Section title={`${scopeLabel}: machines`} hint={kind === 'process' ? 'Reject rate of each machine over the period, under its process, worst first in each, with its trend. Tick machines to compare them; the breakdown below follows the ticks.' : 'Reject rate of each machine over the period, worst first, with its trend. Tick machines to compare them; the breakdown below follows the ticks.'} icon={<Layers className="h-4 w-4" />} className="xl:col-span-2" action={picked.length > 0 && <button type="button" onClick={clearPick} className="text-xs font-semibold text-slate-500 hover:text-rose-600">Clear {picked.length} ticked</button>}>
          {machines.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-400">No production closed in this period.</p>
          ) : (
            <div className="space-y-3 pr-1">
              {machineGroups.map((g) => (
                <div key={g.key}>
                  {g.label !== null && (
                    <p className="mb-1 flex items-baseline justify-between px-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                      <span>{g.label}</span>
                      <span className="tabular-nums">{g.machines.length}</span>
                    </p>
                  )}
                  <ul className="space-y-1.5">
              {g.machines.map((m) => {
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
                </div>
              ))}
            </div>
          )}
        </Section>
          ) },
          { id: 'g.factoriesByMonth', title: 'Factories by month', node: (
        <Section title={`${scopeLabel}: factories by month`} hint={`Reject rate of each factory in the pick, month by month over ${describeRange({ from: general.from, to: general.to })}.`} icon={<Factory className="h-4 w-4" />}>
          {breakdown ? <LineChart labels={pickLabels} series={pickFactoryLines} /> : <div className="skeleton h-48" />}
        </Section>
          ) },
          { id: 'g.machinesByMonth', title: 'Machines by month', node: (
        <Section title={`${scopeLabel}: machines by month`} hint={`The ${pickMachines.length} machines of the pick with the highest reject rate, month by month over ${describeRange({ from: general.from, to: general.to })}. Tick machines above to choose them yourself.`} icon={<Layers className="h-4 w-4" />}>
          {breakdown ? <LineChart labels={pickLabels} series={pickMachineLines} /> : <div className="skeleton h-48" />}
        </Section>
          ) },
                    { id: 'g.pieScope', title: 'Rejected by factory or process', node: (
        <Section title={kind === 'factory' ? 'Rejected by factory' : 'Rejected by process'} hint={`Each ${kind}'s share of the rejected pieces over ${describeRange({ from: general.from, to: general.to })}. The picks do not narrow it. Tap a slice for the sessions behind it.`} icon={kind === 'factory' ? <Factory className="h-4 w-4" /> : <Layers className="h-4 w-4" />}>
          <PieChart
            centerLabel="rejected"
            slices={slicesOf(periodScopeRows)}
            onPick={(sl) => {
              if (!sl.key) return
              setDrill({ title: `${sl.label}: rejected pieces`, subtitle: spanWords, query: { from: general.from, to: general.to, ...(kind === 'factory' ? { factories: [sl.key] } : { processes: [sl.key as Process] }) } })
            }}
          />
        </Section>
          ) },
          { id: 'g.pieScopeTotal', title: 'Rejected by factory or process, all time', node: (
        <Section title={kind === 'factory' ? 'Rejected by factory, all time' : 'Rejected by process, all time'} hint={`Each ${kind}'s share of every rejected piece since ${describeRange({ from: general.allTime.from, to: general.allTime.to })}. Neither the period nor the picks narrow it.`} icon={kind === 'factory' ? <Factory className="h-4 w-4" /> : <Layers className="h-4 w-4" />}>
          <PieChart centerLabel="rejected" slices={slicesOf((kind === 'factory' ? general.allTime.factories : general.allTime.processes).map((x) => ({ label: kind === 'process' ? (PROCESS_LABEL[x.key as Process] ?? x.key) : x.key, value: x.productionDefectPieces })))} />
        </Section>
          ) },
          { id: 'g.pieMachines', title: 'Rejected by machine', node: (
        <Section title={`${scopeLabel}: rejected by machine`} hint={`Each machine's share of the rejected pieces over ${describeRange({ from: general.from, to: general.to })}, in the ${kind === 'factory' ? 'factories' : 'processes'} picked; ticking machines does not narrow it. Tap a slice for the sessions behind it.`} icon={<Layers className="h-4 w-4" />}>
          <PieChart
            centerLabel="rejected"
            slices={slicesOf(machines.map((m) => ({ key: m.workCenterCode, label: m.label, sub: kind === 'factory' ? m.factory : PROCESS_LABEL[m.process], value: m.productionDefectPieces })))}
            onPick={(sl) => sl.key && setDrill({ title: `${sl.label}: rejected pieces`, subtitle: spanWords, query: { ...scopeQuery, workCenterCodes: [sl.key] } })}
          />
        </Section>
          ) },
          ...(breakdown ? scopeDetailWidgets({ title: detailTitle, data: breakdown, t, navigate, fpMachines, setFpMachines, drill: setDrill, pickQuery, spanWords }) : []),
        ]}
      />
      <DrillModal spec={drill} onClose={() => setDrill(null)} />
    </div>
  )
}

/** What a pick's rejected pieces are: which defects, in which months, on which orders and items; and how often the first part was clean. */
function scopeDetailWidgets({
  title,
  data,
  t,
  navigate,
  fpMachines,
  setFpMachines,
  drill,
  pickQuery,
  spanWords,
}: {
  title: string
  data: KpiBreakdown
  t: KpiThresholds
  navigate: (to: string) => void
  fpMachines: string[]
  setFpMachines: (codes: string[]) => void
  /** Open the sessions behind a number. */
  drill: (spec: DrillSpec) => void
  /** The pick as the breakdown reads it. */
  pickQuery: KpiDrillQuery
  spanWords: string
}): BoardWidget[] {
  const openRejects = (what: string, slice: Partial<KpiDrillQuery> = {}) => drill({ title: `${what}`, subtitle: `${title} · ${spanWords}`, query: { ...pickQuery, ...slice } })
  // First part reads the machines ticked for it, else the pick's.
  const fpBase = { from: pickQuery.from, to: pickQuery.to, factories: pickQuery.factories, processes: pickQuery.processes, workCenterCodes: fpMachines.length ? fpMachines : pickQuery.workCenterCodes }
  const openFirstPart = (what: string, qtyFrom: number, qtyTo?: number) => drill({ title: what, subtitle: `${title} · ${spanWords}`, firstPart: { ...fpBase, qtyFrom, qtyTo } })
  // The span as a whole, not the months added up: a universal machine's line counts its sheet quantity once in the span.
  const made = data.totals.made
  const rejected = data.totals.productionDefectPieces
  const rate = data.totals.defectRatePct
  const monthsWithData = data.months.filter((m) => m.made > 0)
  const fpAll = data.firstPart
  // The first-part widgets share one machine filter, several machines at once; none ticked is every machine of the pick.
  const fp = firstPartOf(fpAll, fpMachines)
  const fpFilter = (
    <MultiSelectMenu
      options={fpAll.byMachine.map((m) => ({ value: m.workCenterCode, label: m.label, sub: m.factory }))}
      selected={fpMachines}
      onChange={setFpMachines}
      allLabel="All machines"
      noun="machines"
      ariaLabel="First part: machines"
    />
  )
  /** First part released reads high-is-good: 95% and over is green, 85% amber. */
  const releasedTone = (v: number | null): KpiTone => (v === null ? 'neutral' : v >= 95 ? 'green' : v >= 85 ? 'amber' : 'red')
  const fpTone: KpiTone = releasedTone(fp.pct)
  /** The cumulative yield reads the other way: lower is better, zero is clean. */
  const cumTone = (v: number | null): KpiTone => (v === null ? 'neutral' : v === 0 ? 'green' : v <= 15 ? 'amber' : 'red')
  return [
    { id: 'g.tiles', title: 'Reject rate, PPM, first part', labelled: false, node: (
<div className="h-full space-y-3 overflow-auto">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h2 className="text-lg font-extrabold tracking-tight">{title}</h2>
        <p className="text-xs text-slate-400">{describeRange({ from: data.filters.from, to: data.filters.to })}</p>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <PlainTile label="Reject rate" value={pctStr(rate)} sub={`${num(rejected)} rejected of ${num(made)} made`} icon={<Target className="h-4 w-4" />} tone={toneLowIsGood(rate, t.defectRateGreen, t.defectRateAmber)} onOpen={rejected > 0 ? () => openRejects('Rejected pieces') : undefined} />
        <PlainTile label="PPM" value={ppmStr(rate)} sub="rejected pieces per million made" icon={<AlertTriangle className="h-4 w-4" />} tone={toneLowIsGood(rate, t.defectRateGreen, t.defectRateAmber)} onOpen={rejected > 0 ? () => openRejects('Rejected pieces') : undefined} />
        <PlainTile label="First part released" value={pctStr(fp.pct)} sub={`${num(fp.clean)} of ${num(fp.sessions)} sessions with nothing rejected before release`} icon={<PackageCheck className="h-4 w-4" />} tone={fpTone} onOpen={fp.sessions > fp.clean ? () => openFirstPart('Sessions not clean', 1) : undefined} />
        <PlainTile label="First pass released cumulative" value={pctStr(fp.cumulativePct)} sub={`${num(fp.rejectedPieces)} rejected before release ÷ (${num(fp.clean)} clean sessions + ${num(fp.rejectedPieces)}) · lower is better`} icon={<PackageCheck className="h-4 w-4" />} tone={cumTone(fp.cumulativePct)} onOpen={fp.rejectedPieces > 0 ? () => openFirstPart('Pieces rejected before release', 1) : undefined} />
      </div>
</div>
    ) },
    { id: 'g.pieDefects', title: 'Share of each defect', node: (
        <Section title="Share of each defect" hint="Each defect's share of the rejected pieces in the period; the smaller ones together as Others. Tap a slice for the sessions behind it." icon={<AlertTriangle className="h-4 w-4" />}>
          <PieChart centerLabel="rejected" slices={slicesOf(data.defects.map((d) => ({ label: d.defectName, value: d.pieces })))} onPick={(sl) => openRejects(`${sl.label}: rejected pieces`, { defect: sl.label })} />
        </Section>
    ) },
    { id: 'g.dispositions', title: 'Dispositions', node: (
        <Section title="Dispositions" hint="The period's rejected pieces by what was decided for them. Tap a slice for the sessions behind it." icon={<ClipboardList className="h-4 w-4" />}>
          <PieChart
            centerLabel="rejected"
            slices={(Object.keys(DISPOSITION_CLASS) as Disposition[]).map((d) => ({ label: d, value: data.byDisposition[d] ?? 0, className: DISPOSITION_CLASS[d].replace(/stroke-/g, 'fill-') }))}
            onPick={(sl) => openRejects(`${sl.label}: rejected pieces`, { disposition: sl.label as Disposition })}
          />
        </Section>
    ) },
    { id: 'g.pareto', title: 'Pareto of defects', node: (
        <Section title="Pareto of defects" hint="Rejected pieces by defect, largest first, with the running share: the few defects that make most of the pieces." icon={<AlertTriangle className="h-4 w-4" />} className="xl:col-span-2">
          <ParetoChart bars={paretoOf(data.defects.map((d) => ({ label: d.defectName, value: d.pieces })))} onPick={(label) => openRejects(`${label}: rejected pieces`, { defect: label })} />
        </Section>
    ) },
    { id: 'g.defectsByMonth', title: 'Defects by month', node: (
        <Section title="Defects by month" hint="Each defect's rejected pieces in each month, and its share of that month's rejected pieces against the other defects. Tap a number for the sessions behind it." icon={<Activity className="h-4 w-4" />} className="xl:col-span-3">
          <DefectsByMonthTable
            data={data}
            rejected={rejected}
            rate={rate}
            onOpen={(defect, month) => openRejects(`${defect ?? 'Rejected pieces'}${month ? ` · ${monthLabel(month)}` : ''}`, { ...(defect ? { defect } : {}), ...(month ? { month } : {}) })}
          />
        </Section>
    ) },
    { id: 'g.byOrder', title: 'By order line', node: (
        <Section title="By order line" hint="Each month's rejected pieces laid on the order lines closed in it. Of made is against what that order line itself made (its produced + rejected); Of period is the share of every rejected piece in the period. Tap a row for the sessions behind it." icon={<ClipboardList className="h-4 w-4" />}>
          <BreakdownTable rows={data.byOrder} months={monthsWithData} what="order" t={t} onOpen={(r) => openRejects(`Order ${r.label} · ${monthLabel(r.month)}`, { orderId: r.key, month: r.month })} onOpenMonth={(month) => openRejects(`Rejected pieces · ${monthLabel(month)}`, { month })} />
        </Section>
    ) },
    { id: 'g.byItem', title: 'By item', node: (
        <Section title="By item" hint="The same rejected pieces laid on the items. Tap a row for the sessions behind it." icon={<Layers className="h-4 w-4" />}>
          <BreakdownTable rows={data.byItem} months={monthsWithData} what="item" t={t} onOpen={(r) => openRejects(`${r.label} · ${monthLabel(r.month)}`, { itemCode: r.key, month: r.month })} onOpenMonth={(month) => openRejects(`Rejected pieces · ${monthLabel(month)}`, { month })} />
        </Section>
    ) },
    { id: 'g.firstPartTiles', title: 'First part: yield and months', node: (
      <Section title="First part released" hint="By session: clean when nothing was rejected on the line before the release inspection. Sessions started in the period." icon={<PackageCheck className="h-4 w-4" />} action={fpFilter}>
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {[
              { k: 'First part released', v: pctStr(fp.pct), s: `${num(fp.clean)} clean ÷ ${num(fp.sessions)} sessions`, tone: fpTone, open: undefined },
              { k: 'Not clean', v: num(fp.sessions - fp.clean), s: `of ${num(fp.sessions)} sessions`, tone: fp.sessions - fp.clean > 0 ? ('red' as KpiTone) : ('green' as KpiTone), open: fp.sessions > fp.clean ? () => openFirstPart('Sessions not clean', 1) : undefined },
              { k: 'Rejected before release', v: num(fp.rejectedPieces), s: 'pieces', tone: 'neutral' as KpiTone, open: fp.rejectedPieces > 0 ? () => openFirstPart('Pieces rejected before release', 1) : undefined },
            ].map((x) => (
              <div
                key={x.k}
                className={cn('rounded-xl p-3 ring-1', TONE_RING[x.tone], x.open && 'cursor-pointer hover:shadow-hover')}
                {...(x.open ? { role: 'button', tabIndex: 0, onClick: x.open, onKeyDown: (e: { key: string }) => e.key === 'Enter' && x.open!() } : {})}
              >
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
                  {m.sessions > 0 ? <><span className={cn('font-semibold', TONE_TEXT[releasedTone(m.pct)])}>{pctStr(m.pct)}</span> <span className="text-slate-400">{num(m.clean)} ÷ {num(m.sessions)}</span></> : <span className="text-slate-300">—</span>}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Section>
    ) },
    { id: 'g.firstPartChart', title: 'First part: machines by month', node: (
      <Section title="First part released, by machine" hint={`Each machine's clean sessions ÷ all its sessions, month by month; higher is better. ${fpMachines.length ? 'The machines ticked.' : `The ${Math.min(LINE_CLASSES.length, fp.byMachineMonth.length)} machines with the most pieces rejected before release.`}`} icon={<Layers className="h-4 w-4" />} action={fpFilter}>
        <LineChart labels={fp.months.map((m) => monthLabel(m.month, false))} series={fp.byMachineMonth.slice(0, LINE_CLASSES.length).map((m, i) => ({ label: m.label, values: m.months.map((x) => (x.sessions > 0 ? pct(x.clean, x.sessions) : null)), className: LINE_CLASSES[i] }))} height={200} />
      </Section>
    ) },
    { id: 'g.firstPartQty', title: 'First part: sessions by pieces rejected', node: (
      <Section title="Sessions by pieces rejected before release" hint="Of the sessions not clean: how many had 1 piece rejected before release, how many 2, and so on. Tap a column for those sessions." icon={<PackageCheck className="h-4 w-4" />} action={fpFilter}>
        {fp.byQty.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-400">Every session started clean.</p>
        ) : (
          <ColumnChart
            columns={qtyColumns(fp.byQty)}
            onPick={(i) => {
              const band = qtyColumns(fp.byQty)[i]
              openFirstPart(`Sessions with ${band.label} rejected before release`, band.from, Number.isFinite(band.to) ? band.to : undefined)
            }}
          />
        )}
      </Section>
    ) },
    { id: 'g.firstPartTable', title: 'First part: parts not clean', node: (
      <Section title="Parts not clean, by machine" hint="Each part on each machine: how many of its sessions started with pieces already rejected on the line, and those pieces. Tap a row for the orders behind it." icon={<PackageCheck className="h-4 w-4" />} action={fpFilter}>
        <FirstPartParts rows={fp.byPart} navigate={navigate} />
      </Section>
    ) },
  ]
}

/** The first-part figures of the machines ticked, summed from the pick's; none ticked is the pick as it is. */
function firstPartOf(all: KpiFirstPart, machines: string[]): KpiFirstPart {
  if (machines.length === 0) return all
  const ticked = new Set(machines.map((c) => c.toLowerCase()))
  const on = (code: string) => ticked.has(code.toLowerCase())
  const rows = all.byMachine.filter((m) => on(m.workCenterCode))
  const monthRows = all.byMachineMonth.filter((m) => on(m.workCenterCode))
  const sum = <R,>(list: R[], f: (r: R) => number) => list.reduce((n, r) => n + f(r), 0)
  const sessions = sum(rows, (r) => r.sessions)
  const clean = sum(rows, (r) => r.clean)
  const pieces = sum(rows, (r) => r.rejectedPieces)
  return {
    ...all,
    sessions,
    clean,
    pct: pct(clean, sessions),
    rejectedPieces: pieces,
    cumulativePct: pct(pieces, clean + pieces),
    byMachine: rows,
    byMachineMonth: monthRows,
    months: all.months.map((m) => {
      const inMonth = monthRows.map((r) => r.months.find((x) => x.month === m.month)).filter((x): x is NonNullable<typeof x> => x !== undefined)
      const ms = sum(inMonth, (x) => x.sessions)
      const mc = sum(inMonth, (x) => x.clean)
      const mp = sum(inMonth, (x) => x.rejectedPieces)
      return { month: m.month, sessions: ms, clean: mc, pct: ms > 0 ? pct(mc, ms) : null, rejectedPieces: mp, cumulativePct: ms > 0 ? pct(mp, mc + mp) : null }
    }),
    failed: all.failed.filter((r) => on(r.workCenterCode)),
    byPart: all.byPart.filter((r) => on(r.workCenterCode)),
    byQty: all.byQty.filter((r) => on(r.workCenterCode)),
  }
}

/** The bands of the sessions-by-pieces chart: each count up to 5 on its own, then wider bands. */
const QTY_BANDS: { label: string; from: number; to: number }[] = [
  { label: '1 pc', from: 1, to: 1 },
  { label: '2 pcs', from: 2, to: 2 },
  { label: '3 pcs', from: 3, to: 3 },
  { label: '4 pcs', from: 4, to: 4 },
  { label: '5 pcs', from: 5, to: 5 },
  { label: '6–10', from: 6, to: 10 },
  { label: '11–20', from: 11, to: 20 },
  { label: '21–50', from: 21, to: 50 },
  { label: '51+', from: 51, to: Number.POSITIVE_INFINITY },
]

/** One column per band, 1 to 5 always shown, the wider bands only when a session falls in them; each keeps its band's bounds. */
function qtyColumns(rows: KpiFirstPart['byQty']): { label: string; value: number; sub: string; from: number; to: number }[] {
  const total = rows.reduce((n, r) => n + r.sessions, 0)
  return QTY_BANDS.map((b) => {
    const value = rows.filter((r) => r.qty >= b.from && r.qty <= b.to).reduce((n, r) => n + r.sessions, 0)
    return { label: b.label, value, sub: total > 0 ? `${Math.round((value / total) * 100)}%` : '', from: b.from, to: b.to }
  }).filter((c, i) => i < 5 || c.value > 0)
}

type PartRow = KpiFirstPart['byPart'][number]

/** The parts not clean, one row per part on a machine, filtered like Excel; a row opens the orders behind it. */
function FirstPartParts({ rows, navigate }: { rows: PartRow[]; navigate: (to: string) => void }) {
  const [open, setOpen] = useState<PartRow | null>(null)
  const filters = useColumnFilters(rows, [
    { key: 'machine', value: (r) => r.machineLabel },
    { key: 'part', value: (r) => r.item },
    { key: 'code', value: (r) => r.itemCode },
    { key: 'notClean', value: (r) => String(r.notClean), numeric: true },
    { key: 'pieces', value: (r) => String(r.rejectedPieces), numeric: true },
  ])
  if (rows.length === 0) return <p className="py-6 text-center text-sm text-slate-400">Every session started clean.</p>
  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-white dark:bg-slate-900">
            <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400">
              <FilterTh filters={filters} column="machine" label="Machine" />
              <FilterTh filters={filters} column="part" label="Part" />
              <FilterTh filters={filters} column="code" label="Code" />
              <FilterTh filters={filters} column="notClean" label="Sessions not clean" className="text-right" />
              <FilterTh filters={filters} column="pieces" label="Rejected before" className="text-right" />
              <th className="print-hidden px-2 py-1.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {filters.rows.map((r) => (
              <tr key={`${r.workCenterCode}|${r.itemCode}`} onClick={() => setOpen(r)} className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/60">
                <td className="px-2 py-1.5">{r.machineLabel}{r.factory && <span className="ml-1 text-xs text-slate-400">{r.factory}</span>}</td>
                <td className="px-2 py-1.5 font-semibold" dir="auto">{r.item}</td>
                <td className="px-2 py-1.5 text-xs text-slate-500">{r.itemCode}</td>
                <td className="px-2 py-1.5 text-right tabular-nums"><span className="font-semibold">{num(r.notClean)}</span> <span className="text-xs text-slate-400">of {num(r.sessions)}</span></td>
                <td className="px-2 py-1.5 text-right"><Badge tone="red">{num(r.rejectedPieces)} pcs</Badge></td>
                <td className="print-hidden px-2 py-1.5 text-right">
                  <button type="button" onClick={(e) => { e.stopPropagation(); setOpen(r) }} className="text-xs font-semibold text-brand-700 hover:underline dark:text-brand-300">
                    {r.orders.length === 1 ? '1 order' : `${r.orders.length} orders`}
                  </button>
                </td>
              </tr>
            ))}
            {filters.rows.length === 0 && (
              <tr><td colSpan={6} className="py-6 text-center text-sm text-slate-400">No row matches the filters.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <FilterNote filters={filters} total={rows.length} />
      <Modal open={open !== null} onClose={() => setOpen(null)} title={open ? `${open.item} on ${open.machineLabel}` : ''} icon={<PackageCheck className="h-5 w-5" />} size="lg">
        {open && (
          <div className="space-y-3">
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {num(open.notClean)} of {num(open.sessions)} sessions started with pieces already rejected, {num(open.rejectedPieces)} pieces in all. The orders behind them:
            </p>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400">
                  <th className="px-2 py-1.5 font-semibold">Order</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Sessions not clean</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Rejected before</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Open</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {open.orders.map((o) => (
                  <tr key={o.orderNumber}>
                    <td className="whitespace-nowrap px-2 py-1.5 font-semibold">{o.orderNumber}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{num(o.notClean)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{num(o.rejectedPieces)} pcs</td>
                    <td className="px-2 py-1.5 text-right">
                      <span className="inline-flex flex-wrap justify-end gap-1">
                        {o.sessionIds.map((id, i) => (
                          <button key={id} type="button" onClick={() => navigate(`/wizard/${id}`)} className="rounded-md bg-brand-50 px-1.5 py-0.5 text-xs font-semibold text-brand-700 hover:bg-brand-100 dark:bg-brand-500/10 dark:text-brand-300">
                            {o.sessionIds.length === 1 ? 'Session' : `Session ${i + 1}`}
                          </button>
                        ))}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Modal>
    </>
  )
}

type BreakdownRow = KpiBreakdown['byOrder'][number]

/** Each month's rejected pieces laid on the order lines or the items, filtered like Excel on every column. */
function BreakdownTable({
  rows,
  months,
  what,
  t,
  onOpen,
  onOpenMonth,
}: {
  rows: BreakdownRow[]
  months: KpiBreakdown['months']
  what: 'order' | 'item'
  t: KpiThresholds
  /** A row opens the sessions behind its rejected pieces. */
  onOpen?: (row: BreakdownRow) => void
  onOpenMonth?: (month: string) => void
}) {
  const filters = useColumnFilters(rows, [
    { key: 'label', value: (r) => r.label },
    { key: 'sub', value: (r) => (what === 'order' ? (r.sub ?? '') : r.key) },
    { key: 'pieces', value: (r) => String(r.pieces), numeric: true },
    { key: 'made', value: (r) => pctStr(r.pctOfMade, 3), numeric: true },
    { key: 'period', value: (r) => pctStr(r.shareOfPeriodPct), numeric: true },
  ])
  const groups = months.map((m) => ({ month: m, rows: filters.rows.filter((r) => r.month === m.month) })).filter((g) => g.rows.length > 0)
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-10 bg-white dark:bg-slate-900">
          <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400">
            <FilterTh filters={filters} column="label" label={what === 'order' ? 'Order' : 'Item'} />
            <FilterTh filters={filters} column="sub" label={what === 'order' ? 'Item' : 'Code'} />
            <FilterTh filters={filters} column="pieces" label="Rejected" className="text-right" />
            <FilterTh filters={filters} column="made" label="Of made" className="text-right" />
            <FilterTh filters={filters} column="period" label="Of period" className="text-right" />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {groups.map((g) => (
            <Fragment key={g.month.month}>
              <tr className={cn('bg-slate-50 dark:bg-slate-800/60', onOpenMonth && 'cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800')} onClick={onOpenMonth && (() => onOpenMonth(g.month.month))}>
                <td className="px-2 py-1.5 font-bold" colSpan={3}>{monthLabel(g.month.month)}</td>
                <td className="px-2 py-1.5 text-right"><ToneCell value={g.month.defectRatePct} tone={toneLowIsGood(g.month.defectRatePct, t.defectRateGreen, t.defectRateAmber)} /></td>
                <td className="px-2 py-1.5 text-right text-xs text-slate-400">{num(g.month.productionDefectPieces)} of {num(g.month.made)}</td>
              </tr>
              {g.rows.map((r) => (
                <tr key={`${r.month}|${r.key}`} onClick={onOpen && (() => onOpen(r))} className={cn(onOpen && 'cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/60')}>
                  <td className="px-2 py-1.5 font-semibold" dir="auto">{r.label}</td>
                  <td className="px-2 py-1.5 text-xs text-slate-500" dir="auto">{what === 'order' ? r.sub : r.key}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{num(r.pieces)}</td>
                  <td className="px-2 py-1.5 text-right font-semibold tabular-nums" title={`${num(r.pieces)} rejected of ${num(r.made)} made by this ${what} in the month`}>{pctStr(r.pctOfMade, 3)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-slate-500">{pctStr(r.shareOfPeriodPct)}</td>
                </tr>
              ))}
            </Fragment>
          ))}
          {groups.length === 0 && (
            <tr><td colSpan={5} className="py-6 text-center text-sm text-slate-400">{rows.length === 0 ? 'No rejected piece in these months.' : 'No row matches the filters.'}</td></tr>
          )}
        </tbody>
      </table>
      <FilterNote filters={filters} total={rows.length} />
    </div>
  )
}

/** Each defect's rejected pieces month by month and its share of the month's, filtered like Excel on the defect and its total. */
function DefectsByMonthTable({ data, rejected, rate, onOpen }: { data: KpiBreakdown; rejected: number; rate: number | null; onOpen?: (defect: string | null, month: string | null) => void }) {
  /** A cell with pieces opens the sessions behind them. */
  const opens = (defect: string | null, month: string | null, pieces: number): { onClick?: () => void; className: string } =>
    onOpen && pieces > 0 ? { onClick: () => onOpen(defect, month), className: 'cursor-pointer hover:bg-brand-50 dark:hover:bg-brand-500/10' } : { className: '' }
  const filters = useColumnFilters(data.defects, [
    { key: 'defect', value: (d) => d.defectName },
    { key: 'total', value: (d) => String(d.pieces), numeric: true },
  ])
  if (data.defects.length === 0) return <p className="py-6 text-center text-sm text-slate-400">No rejected piece in these months.</p>
  const shown = filters.active > 0 ? filters.rows : filters.rows.slice(0, 15)
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-10 bg-white dark:bg-slate-900">
          <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400">
            <FilterTh filters={filters} column="defect" label="Defect" />
            {data.months.map((m) => <th key={m.month} className="px-2 py-1.5 text-right font-semibold">{monthLabel(m.month, false)}</th>)}
            <FilterTh filters={filters} column="total" label="Total" className="text-right" />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          <tr className="bg-slate-50 font-semibold dark:bg-slate-800/60">
            <td className="px-2 py-1.5">All rejected · rate</td>
            {data.months.map((m) => {
              const o = opens(null, m.month, m.productionDefectPieces)
              return <td key={m.month} onClick={o.onClick} className={cn('px-2 py-1.5 text-right tabular-nums', o.className)}>{m.made > 0 ? <>{num(m.productionDefectPieces)} <span className="text-xs text-slate-400">{pctStr(m.defectRatePct)}</span></> : <span className="text-slate-300">—</span>}</td>
            })}
            <td onClick={opens(null, null, rejected).onClick} className={cn('px-2 py-1.5 text-right tabular-nums', opens(null, null, rejected).className)}>{num(rejected)} <span className="text-xs text-slate-400">{pctStr(rate)}</span></td>
          </tr>
          {shown.map((d) => (
            <tr key={d.defectName}>
              <td onClick={opens(d.defectName, null, d.pieces).onClick} className={cn('px-2 py-1.5 text-left', opens(d.defectName, null, d.pieces).className)}><span dir="auto" className="inline-block font-medium">{d.defectName}</span></td>
              {d.months.map((m) => {
                const monthRejected = data.months.find((x) => x.month === m.month)?.productionDefectPieces ?? 0
                const o = opens(d.defectName, m.month, m.pieces)
                return <td key={m.month} onClick={o.onClick} className={cn('px-2 py-1.5 text-right tabular-nums', o.className)}>{m.pieces > 0 ? <>{num(m.pieces)} <span className="text-xs text-slate-400">{pctStr(pct(m.pieces, monthRejected))}</span></> : <span className="text-slate-300">—</span>}</td>
              })}
              <td onClick={opens(d.defectName, null, d.pieces).onClick} className={cn('px-2 py-1.5 text-right font-semibold tabular-nums', opens(d.defectName, null, d.pieces).className)}>{num(d.pieces)} <span className="text-xs font-normal text-slate-400">{pctStr(d.sharePct)}</span></td>
            </tr>
          ))}
          {shown.length === 0 && (
            <tr><td colSpan={data.months.length + 2} className="py-6 text-center text-sm text-slate-400">No row matches the filters.</td></tr>
          )}
        </tbody>
      </table>
      <FilterNote filters={filters} total={data.defects.length} />
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
        const flat = delta !== null && Math.abs(delta) < 0.005
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
                  {delta === null ? 'new' : flat ? 'flat' : `${Math.abs(delta).toFixed(2)}%`}
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
  // §15 — the board's layout: the fixed default for everyone, or an administrator's own arrangement, made here.
  const { data: layoutState } = useDashboardLayout(allowed)
  const canArrange = can(role, 'manage-admin-data')
  const [editingLayout, setEditingLayout] = useState(false)
  const [draftLayouts, setDraftLayouts] = useState<DashboardLayouts | null>(null)
  /** The gallery of charts, open while arranging. */
  const [galleryOpen, setGalleryOpen] = useState(false)
  const savedLayouts = layoutState?.layouts ?? defaultDashboardLayouts()
  const boardState = useMemo<BoardState>(
    () => ({
      layouts: editingLayout && draftLayouts ? draftLayouts : savedLayouts,
      editing: editingLayout,
      // The grid reports places only, and only for the widgets on screen: merge them in, so a name, a description,
      // a hidden widget and one not drawn yet keep what they had.
      setLayout: (page, layout) =>
        setDraftLayouts((prev) => {
          const base = prev ?? savedLayouts
          const moved = new Map(layout.map((it) => [it.i, it]))
          const kept = base[page].map((it) => {
            const m = moved.get(it.i)
            return m ? { ...it, x: m.x, y: m.y, w: m.w, h: m.h } : it
          })
          const added = layout.filter((it) => !base[page].some((b) => b.i === it.i))
          return { ...base, [page]: [...kept, ...added] }
        }),
      // Hidden on this administrator's board once saved; shown again at the bottom of the page, so it lands on nothing.
      setHidden: (page, id, hidden) =>
        setDraftLayouts((prev) => {
          const base = prev ?? savedLayouts
          const items = normaliseDashboardLayout(page, base[page])
          const bottom = items.filter((it) => !it.hidden && it.i !== id).reduce((n, it) => Math.max(n, it.y + it.h), 0)
          return { ...base, [page]: items.map((it) => (it.i !== id ? it : hidden ? { ...it, hidden: true } : { ...it, hidden: undefined, x: 0, y: bottom })) }
        }),
      setLabel: (page, id, label) =>
        setDraftLayouts((prev) => {
          const base = prev ?? savedLayouts
          return { ...base, [page]: base[page].map((it) => (it.i === id ? { ...it, title: label.title || undefined, hint: label.hint || undefined } : it)) }
        }),
    }),
    [editingLayout, draftLayouts, savedLayouts],
  )
  const qc = useQueryClient()
  const { toast } = useApp()
  const { visibleInsights, hiddenInsights } = useMemo(() => {
    const all = data?.insights ?? []
    const hidden = new Set(hiddenState?.keys ?? [])
    return { visibleInsights: all.filter((i) => !hidden.has(insightKey(i))), hiddenInsights: all.filter((i) => hidden.has(insightKey(i))) }
  }, [data, hiddenState])
  const startArranging = () => {
    setDraftLayouts(savedLayouts)
    setEditingLayout(true)
  }
  const stopArranging = () => {
    setGalleryOpen(false)
    setEditingLayout(false)
    setDraftLayouts(null)
  }
  const saveArrangement = async () => {
    try {
      await saveDashboardLayout(qc, draftLayouts ?? savedLayouts)
      stopArranging()
      toast('Layout saved for you. Nobody else\'s dashboard changed.', 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save the layout.', 'error')
    }
  }
  const resetArrangement = async () => {
    try {
      await resetDashboardLayout(qc)
      stopArranging()
      toast('Your dashboard is back to the default layout.', 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not reset the layout.', 'error')
    }
  }
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
  const [picks, setPicks] = usePersistedState<ScopePicks>('qc-dash:picks', NO_PICKS)
  const showDetails = view === 'inspectors' || pick === 'details'
  const { data: general, isLoading: generalLoading, error: generalError } = useKpiGeneral(range, allowed)
  /** The Pareto can be read for one machine without narrowing the whole page. */
  const [paretoMachine, setParetoMachine] = usePersistedState('qc-dash:pareto-machine', '')
  /** Back to the page as it opens the first time: this month, no filter, nothing picked. */
  const resetAll = () => {
    setF(DEFAULT_FILTERS)
    setPicks(NO_PICKS)
    setParetoMachine('')
  }
  const anythingSet = JSON.stringify(f) !== JSON.stringify(DEFAULT_FILTERS) || picks.factories.length > 0 || picks.processes.length > 0 || Object.values(picks.machines).some((m) => m.length > 0) || paretoMachine !== ''
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

  // §15 — a Details number opens the sessions behind it. The page reads samples, so the drill does too, with every filter set above.
  const [detailDrill, setDetailDrill] = useState<DrillSpec | null>(null)
  const openDetail = (title: string, slice: Partial<KpiDrillQuery>) =>
    setDetailDrill({
      title,
      subtitle: `Samples recorded ${describeRange(range)}`,
      query: {
        from: filters.from,
        to: filters.to,
        basis: 'sampled',
        factories: filters.factories,
        processes: filters.processes,
        workCenterCodes: filters.workCenterCodes,
        itemCode: filters.itemCode,
        inspectorId: filters.inspectorId,
        shift: filters.shift,
        ...slice,
      },
    })

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
    <BoardContext.Provider value={boardState}>
      {canArrange && editingLayout && <ChartGallery open={galleryOpen} onClose={() => setGalleryOpen(false)} />}
      <DrillModal spec={detailDrill} onClose={() => setDetailDrill(null)} />
    <div className="mx-auto max-w-[110rem] space-y-5">
      {editingLayout && (
        <div className="print-hidden rounded-xl border border-brand-300 bg-brand-50 px-4 py-2 text-sm text-brand-800 dark:border-brand-500/40 dark:bg-brand-500/10 dark:text-brand-100">
          Arranging your own dashboard: drag a chart by its blue bar, pull its bottom-right corner to size it. Save keeps it for you only; everyone else keeps the default. Default puts the default back on yours.
        </div>
      )}
      {/* Heading */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-slate-400">Quality</p>
          <h1 className="mt-1 text-2xl font-extrabold tracking-tight">Dashboard</h1>
          {view === 'general' && pick !== 'details' ? (
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              <span className="font-semibold text-slate-700 dark:text-slate-200">{describeRange(range)}</span> · reject rate = rejected ÷ (produced + rejected) · trend over {general ? windowLength(general) : 'the last months'}
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
          {canArrange && view === 'general' && !editingLayout && (
            <Button className="min-h-[44px]" onClick={startArranging} aria-label="Arrange the charts">
              <LayoutDashboard className="h-4 w-4" /> Arrange
            </Button>
          )}
          {canArrange && view === 'general' && editingLayout && (
            <>
              <Button className="min-h-[44px]" onClick={() => setGalleryOpen(true)} aria-label="Choose the charts shown">
                <LayoutGrid className="h-4 w-4" /> Charts
              </Button>
              <Button variant="primary" className="min-h-[44px]" onClick={() => void saveArrangement()} aria-label="Save the layout for you">
                <Save className="h-4 w-4" /> Save layout
              </Button>
              <Button className="min-h-[44px]" onClick={() => void resetArrangement()} aria-label="Back to the default layout">
                <Undo2 className="h-4 w-4" /> Default
              </Button>
              <Button className="min-h-[44px]" onClick={stopArranging} aria-label="Stop arranging without saving">
                <X className="h-4 w-4" /> Cancel
              </Button>
            </>
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
            <Button className="ml-auto min-h-[40px]" onClick={resetAll} disabled={!anythingSet} aria-label="Reset all filters and picks">
              <RotateCcw className="h-4 w-4" /> Reset all
            </Button>
          </div>
          {general && pick !== 'details' && <ScopeView kind={pick} general={general} factories={factories} t={general.thresholds} picks={picks} setPicks={setPicks} />}
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
            <button type="button" onClick={resetAll} className="inline-flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-rose-600">
              <RotateCcw className="h-3.5 w-3.5" /> Reset all
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
          <div className={cn('space-y-5', !(view === 'general' && pick === 'details') && '[@media_screen]:hidden')}>
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
          <Board
            page="details"
            widgets={[
              { id: 'd.tiles', title: 'KPI tiles', labelled: false, node: (
<div className="h-full overflow-auto">
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
</div>
              ) },
              { id: 'd.machines', title: 'Machines', node: (
          <Section
            title="Machines"
            hint={`Each machine of the selection: defect pieces per 100 produced, against ${describeRange(prev)}; produced, released and defective are the sessions closed in the period. Tap a machine to filter the page to it.${showing(data.byMachine.length, data.counts.machines)}`}
            icon={<Activity className="h-4 w-4" />}
          >
            <MachineCards rows={data.byMachine} previous={data.byMachinePrevious} t={t} onPick={(code) => patch({ workCenterCode: code })} />
          </Section>
              ) },
              { id: 'd.monthly', title: 'Month by month', node: (
            <Section title="Month by month" hint="Pieces produced each month of the period, with the defect rate over them." icon={<Activity className="h-4 w-4" />} className="xl:col-span-2">
              <TrendChart points={data.monthly.map((m) => ({ label: monthLabel(m.month, false), bar: m.piecesProduced, line: m.defectRatePct }))} barLabel="Pieces produced" lineLabel="Defect rate" />
            </Section>
              ) },
              { id: 'd.defectDetails', title: 'Defect details', node: (
            <Section title="Defect details" hint={`Every defect of the selection, largest first: the pieces, on how many distinct days it was recorded, and on how many order lines.${showing(Math.min(12, data.defectDetails.length), data.counts.defectTypes)}`} icon={<AlertTriangle className="h-4 w-4" />} className="xl:col-span-3">
              <Table
                rows={data.defectDetails}
                rowKey={(r) => r.defectName}
                onRowClick={(r) => openDetail(r.defectName, { defect: r.defectName })}
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
              ) },
              { id: 'd.dailyTrend', title: 'Daily trend', node: (
            <Section title="Daily trend" hint="Each day: pieces inspected beside pieces found defective, on one scale." icon={<Activity className="h-4 w-4" />} className="xl:col-span-2">
              <PairedBarChart points={dailyPoints} totalLabel="Pieces inspected" partLabel="Defect pieces" />
            </Section>
              ) },
              { id: 'd.dispositions', title: 'Dispositions', node: (
            <Section title="Dispositions" hint="Defect pieces by what was decided. Tap one for the sessions behind it." icon={<ClipboardList className="h-4 w-4" />}>
              <DonutChart
                centerLabel="defect pieces"
                slices={(Object.keys(DISPOSITION_CLASS) as Disposition[]).map((d) => ({ label: d, value: cur.byDisposition[d] ?? 0, className: DISPOSITION_CLASS[d] }))}
                onPick={(label) => openDetail(`${label}: defect pieces`, { disposition: label as Disposition })}
              />
            </Section>
              ) },
              { id: 'd.pareto', title: 'Pareto of defects', node: (
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
                onPick={(label) => openDetail(`${label}${machinePareto ? ` on ${machinePareto.label}` : ''}`, { defect: label, ...(machinePareto ? { workCenterCodes: [machinePareto.workCenterCode] } : {}) })}
              />
            </Section>
              ) },
              { id: 'd.rateByMachine', title: 'Defect rate by machine', node: (
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
              ) },
              { id: 'd.byShift', title: 'Defects of inspected by shift', node: (
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
              ) },
              { id: 'd.byInspector', title: 'Defects of inspected by inspector', node: (
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
              ) },
              { id: 'd.rateByItem', title: 'Defect rate by item', node: (
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
              ) },
              { id: 'd.topMachines', title: 'Defects by machine', node: (
            <TopDown
              title="Defects by machine"
              hint="Defect pieces of the sessions closed in the period, largest first."
              icon={<Activity className="h-4 w-4" />}
              rows={[...data.byMachine]
                .sort((a, b) => (b.productionDefectPieces ?? b.defectPieces) - (a.productionDefectPieces ?? a.defectPieces))
                .map((m) => ({ key: m.key, label: m.label, sub: m.sub, pieces: m.productionDefectPieces ?? m.defectPieces, rate: m.defectRatePct, onClick: () => patch({ workCenterCode: m.key }) }))}
              t={t}
            />
              ) },
              { id: 'd.topItems', title: 'Defects by item (top down)', node: (
            <TopDown
              title="Defects by item"
              hint="Defect pieces per item, largest first, with the item's defect rate over its production."
              icon={<Layers className="h-4 w-4" />}
              rows={[...data.byItem]
                .sort((a, b) => (b.productionDefectPieces ?? b.defectPieces) - (a.productionDefectPieces ?? a.defectPieces))
                .map((r) => ({ key: r.key, label: r.label, sub: r.key, pieces: r.productionDefectPieces ?? r.defectPieces, rate: r.defectRatePct, onClick: () => patch({ itemCode: r.key }) }))}
              t={t}
            />
              ) },
              { id: 'd.rateBands', title: 'Samples by defect rate', node: (
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
              ) },
              { id: 'd.paintByItem', title: 'Paint thickness by item', node: (
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
              ) },
              { id: 'd.itemDefects', title: 'Defects by item', node: (
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
              ) },
              { id: 'd.suppliers', title: 'Defects of inspected by coil supplier', node: (
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
              ) },
              { id: 'd.holdAgeing', title: 'Hold ageing', node: (
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
              ) },
              { id: 'd.tableMachine', title: 'By machine (table)', node: (
            <Section title="By machine" icon={<Activity className="h-4 w-4" />}>
              <Table rows={data.byMachine} total={data.counts.machines} rowKey={(r) => r.key} maxRows={10} columns={groupColumns(t, { key: 'k', label: 'Machine', render: (r) => (<span className="font-semibold">{r.label}{r.sub && <span className="ml-1 text-xs font-normal text-slate-400">{r.sub}</span>}</span>) })} />
            </Section>
              ) },
              { id: 'd.tableInspector', title: 'By inspector (table)', node: (
            <Section title="By inspector" icon={<Users className="h-4 w-4" />}>
              <Table rows={data.byInspector} total={data.counts.inspectors} rowKey={(r) => r.key} maxRows={10} columns={groupColumns(t, { key: 'k', label: 'Inspector', render: (r) => <span className="font-semibold">{r.label}</span> })} />
            </Section>
              ) },
              { id: 'd.tableShift', title: 'By shift (table)', node: (
            <Section title="By shift" icon={<Users className="h-4 w-4" />}>
              <Table rows={data.byShift} rowKey={(r) => r.key} columns={groupColumns(t, { key: 'k', label: 'Shift', render: (r) => (<span className="font-semibold">{r.label} <span className="text-xs font-normal text-slate-400">{shiftName(r.key as ShiftLetter)}</span></span>) })} />
            </Section>
              ) },
              { id: 'd.tableItem', title: 'By item (table)', node: (
            <Section title="By item" icon={<ClipboardList className="h-4 w-4" />}>
              <Table rows={data.byItem} total={data.counts.items} rowKey={(r) => r.key} maxRows={10} columns={groupColumns(t, { key: 'k', label: 'Item', render: (r) => (<span className="font-semibold">{r.label}<span className="ml-1 text-xs font-normal text-slate-400">{r.key}</span></span>) })} />
            </Section>
              ) },
              { id: 'd.coilSuppliers', title: 'Coil suppliers', node: (
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
              ) },
              { id: 'd.onHold', title: 'On Hold', node: (
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
              ) },
              { id: 'd.discipline', title: 'Recording discipline', node: (
          <Section title="Recording discipline" hint="How the records themselves are kept. Not a KPI of the product; a KPI of the inspection." icon={<CheckCircle2 className="h-4 w-4" />}>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
              {[
                { k: 'Coverage of open lines', v: pctStr(data.discipline.coveragePct), s: `${num(data.discipline.openLinesInspected)} of ${num(data.discipline.openLines)} lines` },
                { k: 'Open sessions, no sample', v: num(data.discipline.emptyOpenSessions), s: 'right now' },
                { k: 'Closed without final qty', v: num(data.discipline.closedWithoutFinalQty), s: 'in the period' },
                { k: 'Coils typed by hand', v: pctStr(data.discipline.typedCoilPct), s: 'not from the register' },
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
              ) },
            ]}
          />
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
    </BoardContext.Provider>
  )
}
