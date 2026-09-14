// ============================================================================
// §15 — the quality dashboard. One period against its comparison, every
// KPI the floor's records can support, and a short list of what a quality
// manager would say about them. Administrators only.
// ============================================================================

import { useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Activity,
  AlertOctagon,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  CheckCircle2,
  ClipboardList,
  FileSpreadsheet,
  Info,
  Lightbulb,
  Loader2,
  Minus,
  PauseCircle,
  Printer,
  RefreshCw,
  Ruler,
  ShieldAlert,
  Sparkles,
  Table2,
  Target,
  Users,
  X,
} from 'lucide-react'
import { can, shiftName } from '@qc/shared/rules'
import type { Disposition, ShiftLetter } from '@qc/shared/types'
import { deltaPct, toneHighIsGood, toneLowIsGood, type KpiFilters, type KpiGroupRow, type KpiInsight, type KpiOverview, type KpiThresholds, type KpiTone } from '@qc/shared/kpi'
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Select, type BadgeTone } from '@/components/ui'
import { DonutChart, HorizontalBars, ParetoChart, TrendChart } from '@/components/dashboard/charts'
import { kpiSheets } from '@/components/dashboard/exportKpi'
import { COMPARE_PRESETS, PERIOD_PRESETS, addDays, compareRange, describeRange, isMonthAligned, presetRange, shortDay, toDay, type ComparePreset, type PeriodPreset } from '@/components/dashboard/period'
import { downloadWorkbook } from '@/lib/xlsxWrite'
import { usePersistedState } from '@/lib/usePersistedState'
import { cn, formatDateTime } from '@/lib/utils'
import { useKpiOverview, useMaster, useUsers } from '@/services/queries'
import { useAuth } from '@/store/AuthContext'
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

function InsightList({ insights, onLink }: { insights: KpiInsight[]; onLink: (link: NonNullable<KpiInsight['link']>) => void }) {
  return (
    <ul className="grid grid-cols-1 gap-2 lg:grid-cols-2">
      {insights.map((i, idx) => {
        const s = SEVERITY[i.severity]
        return (
          <li key={i.id} className={cn('animate-page-in rounded-xl border p-3', s.cls)} style={{ animationDelay: `${Math.min(idx, 8) * 40}ms` }}>
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
    { key: 'pieces', label: 'Pieces', className: 'text-right tabular-nums', render: (r) => num(r.pieces) },
    { key: 'defects', label: 'Defect pcs', className: 'text-right tabular-nums', render: (r) => num(r.defectPieces) },
    { key: 'rate', label: 'Defect rate', className: 'text-right', render: (r) => <ToneCell value={r.defectRatePct} tone={toneLowIsGood(r.defectRatePct, t.defectRateGreen, t.defectRateAmber)} /> },
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
  const [showTables, setShowTables] = useState(false)
  const { data: machines = [] } = useMaster('machines', undefined, allowed)
  const { data: users = [] } = useUsers()

  const factories = useMemo(() => Array.from(new Set(machines.map((m) => m.factory ?? '').filter(Boolean))).sort(), [machines])
  const machineOptions = useMemo(
    () => machines.filter((m) => !f.factory || (m.factory ?? '') === f.factory).sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [machines, f.factory],
  )
  const activeFilters = [f.factory && `Factory ${f.factory}`, f.workCenterCode && `Machine ${f.workCenterCode}`, f.itemCode && `Item ${f.itemCode}`, f.inspectorId && (users.find((u) => u.id === f.inspectorId)?.name ?? 'Inspector'), f.shift && `${shiftName(f.shift)} shift`].filter(Boolean) as string[]

  const onLink = (link: NonNullable<KpiInsight['link']>) => {
    if (link.kind === 'history-hold') navigate('/history?disposition=Hold')
    else if (link.kind === 'machine') patch({ workCenterCode: link.value })
    else if (link.kind === 'item') patch({ itemCode: link.value })
    else if (link.kind === 'session') navigate(`/wizard/${link.value}`)
  }

  const exportExcel = () => {
    if (!data) return
    downloadWorkbook(`QC-dashboard-${range.from}_${range.to}.xlsx`, kpiSheets(data))
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
    const out: { label: string; bar: number; line: number | null }[] = []
    for (let day = data.filters.from; day <= data.filters.to && out.length < 400; day = addDays(day, 1)) {
      const d = byDay.get(day)
      out.push({ label: shortDay(day), bar: d?.samples ?? 0, line: d?.defectRatePct ?? null })
    }
    return out
  }, [data])
  const cur = data?.current
  const prevT = data?.previous
  const holdPieces = data?.holds.reduce((n, h) => n + h.qty, 0) ?? 0
  const attention = data?.insights.filter((i) => i.severity === 'critical' || i.severity === 'warning').length ?? 0

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
          {data && (
            <button
              type="button"
              onClick={() => setInsightsOpen(true)}
              className={cn(
                'relative grid h-11 w-11 place-items-center rounded-xl ring-1 transition-colors',
                attention > 0 ? 'bg-amber-50 text-amber-700 ring-amber-200 hover:bg-amber-100 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-500/30' : 'bg-emerald-50 text-emerald-700 ring-emerald-200 hover:bg-emerald-100 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-500/30',
              )}
              aria-label={`Insights, ${data.insights.length} ${data.insights.length === 1 ? 'note' : 'notes'}`}
            >
              <Lightbulb className="h-5 w-5" />
              <span className={cn('absolute -right-1.5 -top-1.5 grid min-w-[20px] place-items-center rounded-full px-1 text-[10px] font-bold leading-[20px] text-white ring-2 ring-white dark:ring-slate-900', attention > 0 ? 'bg-rose-600' : 'bg-emerald-600')}>
                {attention > 0 ? attention : '✓'}
              </span>
            </button>
          )}
          <Button className="min-h-[44px]" onClick={() => setShowTables((v) => !v)} disabled={!data} aria-pressed={showTables}>
            <Table2 className="h-4 w-4" /> {showTables ? 'Hide tables' : 'Tables'}
          </Button>
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
      <Card className="print-hidden p-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
          <Field label="Period">
            <Select value={f.preset} onChange={(e) => patch({ preset: e.target.value as PeriodPreset, customFrom: f.customFrom || range.from, customTo: f.customTo || range.to })}>
              {PERIOD_PRESETS.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </Select>
          </Field>
          {f.preset === 'custom' ? (
            <>
              <Field label="From">
                <Input type="date" value={f.customFrom} max={today} onChange={(e) => patch({ customFrom: e.target.value })} />
              </Field>
              <Field label="To">
                <Input type="date" value={f.customTo} max={today} onChange={(e) => patch({ customTo: e.target.value })} />
              </Field>
            </>
          ) : (
            <Field label="Compare with">
              <Select value={f.compare} onChange={(e) => patch({ compare: e.target.value as ComparePreset })}>
                {COMPARE_PRESETS.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {f.preset === 'custom' && (
            <Field label="Compare with">
              <Select value={f.compare} onChange={(e) => patch({ compare: e.target.value as ComparePreset })}>
                {COMPARE_PRESETS.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </Field>
          )}
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
              {users
                .filter((u) => u.isActive || u.id === f.inspectorId)
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
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
          {/* Tiles */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <KpiTile label="Defect rate" value={pctStr(cur.defectRatePct)} current={cur.defectRatePct} previous={prevT.defectRatePct} goodWhen="down" tone={toneLowIsGood(cur.defectRatePct, t.defectRateGreen, t.defectRateAmber)} sub={`${num(cur.defectPieces)} defect pcs in ${num(cur.pieces)} inspected · target ≤ ${t.defectRateGreen}%`} icon={<AlertTriangle className="h-4 w-4" />} />
            <KpiTile label="First-pass yield" value={pctStr(cur.fpyPct)} current={cur.fpyPct} previous={prevT.fpyPct} goodWhen="up" tone={toneHighIsGood(cur.fpyPct, t.fpyGreen, t.fpyAmber)} sub={`${num(cur.samples)} samples · target ≥ ${t.fpyGreen}%`} icon={<Target className="h-4 w-4" />} />
            <KpiTile label="Dimensions out of tolerance" value={pctStr(cur.dimFailPct)} current={cur.dimFailPct} previous={prevT.dimFailPct} goodWhen="down" tone={toneLowIsGood(cur.dimFailPct, t.dimFailGreen, t.dimFailAmber)} sub={`${num(cur.dimensionsFail)} fail · ${num(cur.dimensionsWarning)} warning of ${num(cur.dimensionsMeasured)} measured`} icon={<Ruler className="h-4 w-4" />} />
            <KpiTile label="PT weld rejects" value={pctStr(cur.ptRejectPct)} current={cur.ptRejectPct} previous={prevT.ptRejectPct} goodWhen="down" tone={toneLowIsGood(cur.ptRejectPct, t.ptRejectGreen, t.ptRejectAmber)} sub={`${num(cur.ptLengthsRejected)} of ${num(cur.ptLengthsTested)} lengths`} icon={<Activity className="h-4 w-4" />} />
            <KpiTile label="Pieces inspected" value={num(cur.pieces)} current={cur.pieces} previous={prevT.pieces} goodWhen="up" sub={`${num(cur.samples)} samples · ${num(cur.samplesPerSession, 1)} per session`} icon={<ClipboardList className="h-4 w-4" />} />
            <KpiTile label="Sessions" value={num(cur.sessions)} current={cur.sessions} previous={prevT.sessions} goodWhen="none" sub={`${num(cur.sessionsClosed)} closed · ${num(cur.machinesInspected)} machines · ${num(cur.activeInspectors)} inspectors`} icon={<Users className="h-4 w-4" />} />
            <KpiTile label="On Hold now" value={num(data.holds.length)} current={null} previous={null} goodWhen="down" tone={data.holds.some((h) => h.ageDays >= t.holdAgeRedDays) ? 'red' : data.holds.some((h) => h.ageDays >= t.holdAgeAmberDays) ? 'amber' : data.holds.length ? 'neutral' : 'green'} sub={`${num(holdPieces)} pieces waiting for a disposition`} icon={<PauseCircle className="h-4 w-4" />} />
            <KpiTile label="Paint thickness" value={cur.paintMeanMicrons === null ? '—' : num(cur.paintMeanMicrons, 1)} unit="µm" current={cur.paintMeanMicrons} previous={prevT.paintMeanMicrons} goodWhen="none" sub={cur.paintReadings ? `${num(cur.paintReadings)} readings · min ${num(cur.paintMinMicrons, 1)} µm` : 'No paint readings'} icon={<Sparkles className="h-4 w-4" />} />
          </div>

          {/* Insights live behind the bulb; on paper they print in full. */}
          <Section title="Insights" hint="What the numbers say, by rule, not by guess. Most serious first." icon={<Sparkles className="h-4 w-4" />} className="hidden print:block">
            <InsightList insights={data.insights} onLink={onLink} />
          </Section>
          {insightsOpen && (
            <Modal open onClose={() => setInsightsOpen(false)} size="xl" icon={<Lightbulb className="h-5 w-5" />} title={<span>Insights <span className="ml-2 text-sm font-semibold text-slate-400">{describeRange(range)}</span></span>}>
              <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">What the numbers say, by rule, not by guess. Most serious first.</p>
              <InsightList insights={data.insights} onLink={(l) => { setInsightsOpen(false); onLink(l) }} />
            </Modal>
          )}

          {/* Trend + dispositions */}
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <Section title="Daily trend" hint="Samples per day with the defect rate over them." icon={<Activity className="h-4 w-4" />} className="xl:col-span-2">
              <TrendChart points={dailyPoints} barLabel="Samples" lineLabel="Defect rate" />
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
              hint={`Which few defects make most of the pieces. Shares are of every defect piece in the period.${
                data.paretoOthers ? ` ${data.paretoOthers.types} smaller types are grouped as "Others".` : ''
              }`}
              icon={<AlertTriangle className="h-4 w-4" />}
              className="xl:col-span-2"
            >
              <ParetoChart
                bars={[
                  ...data.pareto.map((p) => ({ label: p.defectName, value: p.pieces, cumulativePct: p.cumulativePct })),
                  // The tail as one bar, so the line reaches 100% where it truly does.
                  ...(data.paretoOthers ? [{ label: `Others (${data.paretoOthers.types})`, value: data.paretoOthers.pieces, cumulativePct: 100 }] : []),
                ]}
              />
            </Section>
            <Section title="Defect rate by machine" hint={`Tap a machine to filter the page to it.${showing(Math.min(12, data.byMachine.length), data.counts.machines)}`} icon={<Activity className="h-4 w-4" />}>
              <HorizontalBars
                unit="%"
                rows={data.byMachine.slice(0, 12).map((m) => ({
                  label: m.label,
                  sub: m.sub,
                  value: m.defectRatePct,
                  tone: toneLowIsGood(m.defectRatePct, t.defectRateGreen, t.defectRateAmber),
                  text: `${pctStr(m.defectRatePct)} · ${num(m.pieces)} pcs`,
                  onClick: () => patch({ workCenterCode: m.key }),
                }))}
              />
            </Section>
          </div>

          {/* Who and what: one bar per row, coloured against the target. */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Section title="Defect rate by shift" hint="Same machines, different hours." icon={<Users className="h-4 w-4" />}>
              <HorizontalBars
                unit="%"
                rows={data.byShift.map((r) => ({
                  label: `${r.label} · ${shiftName(r.key as ShiftLetter)}`,
                  value: r.defectRatePct,
                  tone: toneLowIsGood(r.defectRatePct, t.defectRateGreen, t.defectRateAmber),
                  text: `${pctStr(r.defectRatePct)} · ${num(r.pieces)} pcs`,
                  onClick: () => patch({ shift: r.key as ShiftLetter }),
                }))}
              />
            </Section>
            <Section title="Defect rate by inspector" hint={`Tap a name to filter the page to them.${showing(Math.min(10, data.byInspector.length), data.counts.inspectors)}`} icon={<Users className="h-4 w-4" />}>
              <HorizontalBars
                unit="%"
                rows={data.byInspector.slice(0, 10).map((r) => ({
                  label: r.label,
                  value: r.defectRatePct,
                  tone: toneLowIsGood(r.defectRatePct, t.defectRateGreen, t.defectRateAmber),
                  text: `${pctStr(r.defectRatePct)} · ${num(r.samples)} samples`,
                  onClick: () => patch({ inspectorId: r.key }),
                }))}
              />
            </Section>
            <Section title="Defect rate by item" hint={`Tap an item to filter the page to it.${showing(Math.min(10, data.byItem.length), data.counts.items)}`} icon={<ClipboardList className="h-4 w-4" />}>
              <HorizontalBars
                unit="%"
                rows={data.byItem.slice(0, 10).map((r) => ({
                  label: r.label,
                  sub: r.key,
                  value: r.defectRatePct,
                  tone: toneLowIsGood(r.defectRatePct, t.defectRateGreen, t.defectRateAmber),
                  text: `${pctStr(r.defectRatePct)} · ${num(r.pieces)} pcs`,
                  onClick: () => patch({ itemCode: r.key }),
                }))}
              />
            </Section>
          </div>

          {/* Process and materials */}
          <div className="print-break grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Section
              title="Capability (Cpk)"
              hint={`Per dimension, worst first; green from ${t.cpkGreen}, amber from ${t.cpkAmber}. Needs ${t.minReadingsForCpk} readings.${showing(
                Math.min(10, data.dimensions.filter((d) => d.cpk !== null).length),
                data.counts.dimensions,
              )}`}
              icon={<Ruler className="h-4 w-4" />}
            >
              <HorizontalBars
                max={2}
                rows={data.dimensions
                  .filter((d) => d.cpk !== null)
                  .slice(0, 10)
                  .map((d) => ({
                    label: `${d.name} · ${d.itemCode}`,
                    sub: d.item,
                    value: d.cpk === null ? null : Math.max(0, d.cpk),
                    tone: toneHighIsGood(d.cpk, t.cpkGreen, t.cpkAmber),
                    text: `Cpk ${num(d.cpk, 2)} · ${num(d.readings)} readings${d.centering !== null && Math.abs(d.centering) >= 0.5 ? ' · off centre' : ''}`,
                    onClick: () => patch({ itemCode: d.itemCode }),
                  }))}
              />
            </Section>
            <Section title="Defect rate by coil supplier" hint={`Pieces made from each supplier and grade.${showing(Math.min(10, data.suppliers.length), data.counts.suppliers)}`} icon={<ClipboardList className="h-4 w-4" />}>
              <HorizontalBars
                unit="%"
                rows={data.suppliers.slice(0, 10).map((s) => ({
                  label: s.supplier,
                  sub: s.grade,
                  value: s.defectRatePct,
                  tone: toneLowIsGood(s.defectRatePct, t.defectRateGreen, t.defectRateAmber),
                  text: `${pctStr(s.defectRatePct)} · ${num(s.pieces)} pcs`,
                }))}
              />
            </Section>
            <Section title="PT rejects by wire batch" hint={`Lengths rejected as a share of tested.${showing(Math.min(10, data.wireBatches.length), data.counts.wireBatches)}`} icon={<Activity className="h-4 w-4" />}>
              <HorizontalBars
                unit="%"
                rows={data.wireBatches.slice(0, 10).map((w) => ({
                  label: w.batch,
                  value: w.rejectPct,
                  tone: toneLowIsGood(w.rejectPct, t.ptRejectGreen, t.ptRejectAmber),
                  text: `${pctStr(w.rejectPct)} · ${num(w.lengthsRejected)} of ${num(w.lengthsTested)}`,
                }))}
              />
            </Section>
          </div>

          {/* Waiting: Holds by age, machines without a sample */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
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
            <Section title="Idle machines" hint={`Open order lines and no sample for ${t.idleMachineDays}+ days. Tap to filter.`} icon={<PauseCircle className="h-4 w-4" />}>
              <HorizontalBars
                unit=" d"
                max={Math.max(t.idleMachineDays * 4, ...data.idleMachines.map((m) => m.daysSinceSample ?? 0))}
                rows={data.idleMachines.slice(0, 10).map((m) => ({
                  label: m.label,
                  sub: `${m.factory ? `${m.factory} · ` : ''}${num(m.openLines)} open line${m.openLines === 1 ? '' : 's'}`,
                  value: m.daysSinceSample ?? Math.max(t.idleMachineDays * 4, ...data.idleMachines.map((x) => x.daysSinceSample ?? 0)),
                  tone: m.daysSinceSample === null || m.daysSinceSample >= t.idleMachineDays * 2 ? 'red' : 'amber',
                  text: m.daysSinceSample === null ? 'never inspected' : `${num(m.daysSinceSample)} d since last sample`,
                  onClick: () => patch({ workCenterCode: m.workCenterCode }),
                }))}
              />
            </Section>
          </div>

          {showTables && (
            <>
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

          {/* Capability */}
          <Section title="Process capability" hint={`Mean, spread and failures per dimension from the readings of the period; Cp and Cpk once a dimension has ${t.minReadingsForCpk} readings. Worst first.`} icon={<Ruler className="h-4 w-4" />} className="print-break">
            <Table
              rows={data.dimensions}
              total={data.counts.dimensions}
              rowKey={(d) => `${d.itemCode}|${d.name}`}
              maxRows={12}
              empty="No dimension has enough readings in this period."
              columns={[
                { key: 'item', label: 'Item', render: (d) => (<span className="font-semibold">{d.itemCode}<span className="ml-1 text-xs font-normal text-slate-400">{d.item}</span></span>) },
                { key: 'dim', label: 'Dimension', render: (d) => `${d.name} (${d.unit})` },
                { key: 'n', label: 'Readings', className: 'text-right tabular-nums', render: (d) => num(d.readings) },
                { key: 'nom', label: 'Nominal', className: 'text-right tabular-nums', render: (d) => (d.nominal === null ? '—' : `${num(d.nominal, 3)} +${num(d.tolPlus, 3)} / −${num(d.tolMinus, 3)}`) },
                { key: 'mean', label: 'Mean', className: 'text-right tabular-nums', render: (d) => num(d.mean, 3) },
                { key: 'sd', label: 'Std dev', className: 'text-right tabular-nums', render: (d) => num(d.stdDev, 3) },
                { key: 'cp', label: 'Cp', className: 'text-right tabular-nums', render: (d) => num(d.cp, 2) },
                { key: 'cpk', label: 'Cpk', className: 'text-right', render: (d) => <span className={cn('font-semibold tabular-nums', TONE_TEXT[toneHighIsGood(d.cpk, t.cpkGreen, t.cpkAmber)])}>{num(d.cpk, 2)}</span> },
                { key: 'centre', label: 'Centring', render: (d) => (d.centering === null ? '—' : <span className="inline-flex items-center gap-1.5"><span className="relative inline-block h-1.5 w-16 rounded-full bg-slate-200 dark:bg-slate-700"><span className="absolute top-1/2 h-3 w-1 -translate-y-1/2 rounded-full bg-brand-600 dark:bg-brand-300" style={{ left: `calc(${((d.centering + 1) / 2) * 100}% - 2px)` }} /></span><span className="text-xs tabular-nums text-slate-400">{d.centering > 0 ? '+' : ''}{d.centering.toFixed(2)}</span></span>) },
                { key: 'fail', label: 'Fail', className: 'text-right', render: (d) => <ToneCell value={d.failPct} tone={toneLowIsGood(d.failPct, t.dimFailGreen, t.dimFailAmber)} /> },
              ]}
            />
          </Section>

          {/* Materials + Holds */}
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <Section title="Coil suppliers" hint="Defect rate of the pieces made from each supplier and grade." icon={<ClipboardList className="h-4 w-4" />}>
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
                  { key: 'r', label: 'Defect rate', className: 'text-right', render: (s) => <ToneCell value={s.defectRatePct} tone={toneLowIsGood(s.defectRatePct, t.defectRateGreen, t.defectRateAmber)} /> },
                ]}
              />
            </Section>
            <Section title="Welding wire batches" hint="PT results per wire batch." icon={<Activity className="h-4 w-4" />}>
              <Table
                rows={data.wireBatches}
                total={data.counts.wireBatches}
                rowKey={(w) => w.batch}
                maxRows={10}
                empty="No PT lengths in this period."
                columns={[
                  { key: 'b', label: 'Batch', render: (w) => <span className="font-semibold">{w.batch}</span> },
                  { key: 't', label: 'Tested', className: 'text-right tabular-nums', render: (w) => num(w.lengthsTested) },
                  { key: 'r', label: 'Rejected', className: 'text-right tabular-nums', render: (w) => num(w.lengthsRejected) },
                  { key: 'p', label: 'Reject rate', className: 'text-right', render: (w) => <ToneCell value={w.rejectPct} tone={toneLowIsGood(w.rejectPct, t.ptRejectGreen, t.ptRejectAmber)} /> },
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
            <Section title="Idle machines" hint={`Open order lines and no sample for ${t.idleMachineDays}+ days.`} icon={<PauseCircle className="h-4 w-4" />}>
              <Table
                rows={data.idleMachines}
                rowKey={(m) => m.workCenterCode}
                maxRows={10}
                empty="Every machine with open orders was inspected recently."
                columns={[
                  { key: 'm', label: 'Machine', render: (m) => (<span className="font-semibold">{m.label}{m.factory && <span className="ml-1 text-xs font-normal text-slate-400">{m.factory}</span>}</span>) },
                  { key: 'l', label: 'Open lines', className: 'text-right tabular-nums', render: (m) => num(m.openLines) },
                  { key: 'd', label: 'Last sample', className: 'text-right', render: (m) => (m.daysSinceSample === null ? <Badge tone="red">never</Badge> : <Badge tone={m.daysSinceSample >= t.idleMachineDays * 2 ? 'red' : 'amber'}>{m.daysSinceSample} d ago</Badge>) },
                ]}
              />
            </Section>
          </div>

            </>
          )}

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
