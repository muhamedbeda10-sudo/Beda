// ============================================================================
// §15 — the quality dashboard. One period against its comparison, every
// KPI the floor's records can support, and a short list of what a quality
// manager would say about them. Administrators only.
// ============================================================================

import { Fragment, createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
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
  SlidersHorizontal,
  Undo2,
  Ruler,
  ShieldAlert,
  Sparkles,
  Target,
  Trophy,
  Users,
  X,
  Table2,
  Truck,
} from 'lucide-react'
import { shiftName } from '@qc/shared/rules'
import type { Disposition, ShiftLetter } from '@qc/shared/types'
import { GENERAL_MONTHS, defaultDashboardLayouts, deltaPct, normaliseDashboardLayout, insightKey, pct, ppm, toneHighIsGood, toneLowIsGood, type DashboardLayouts, type KpiBreakdown, type KpiDrillQuery, type KpiFilters, type KpiFirstPart, type KpiGeneral, type KpiGroupRow, type KpiInsight, type KpiOverview, type KpiThresholds, type KpiTone, type KpiCompareBlock, type KpiCompareBucket, type KpiCompareSeries, type KpiGrain, type KpiGrainChoice, type KpiMaterialDetail, MATERIAL_KIND_LABEL, type MaterialKind } from '@qc/shared/kpi'
import { PROCESSES, PROCESS_LABEL, type Process } from '@qc/shared/types'
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Select, type BadgeTone } from '@/components/ui'
import { InspectorRanking } from '@/components/dashboard/InspectorRanking'
import { PeriodSlicer } from '@/components/dashboard/PeriodSlicer'
import { ChartTableSwitch, FigureScope, useFigureScope } from '@/components/dashboard/figureView'
import { ChartFillContext, ColumnChart, DonutChart, HorizontalBars, LINE_CLASSES, LineChart, PairedBarChart, ParetoChart, PieChart, Sparkline, StackedColumnChart, TrendChart, slicesOf, PIE_CLASSES, PIE_STROKES, SERIES_STROKES, type HBar, type PieSlice } from '@/components/dashboard/charts'
import { Board, BoardContext, ChartGallery, WidgetLabelContext, useBoardsStacked, type BoardState, type BoardWidget } from '@/components/dashboard/Board'
import { DrillModal, type DrillSpec } from '@/components/dashboard/DrillModal'
import { FilterNote, FilterTh, FloatingPanel, MultiSelectMenu, byName, useColumnFilters } from '@/components/dashboard/filters'
import { kpiSheets } from '@/components/dashboard/exportKpi'
import { dataSpan, runsOf } from '@/components/dashboard/labels'
import { COMPARE_PRESETS, PERIOD_PRESETS, addDays, compareRange, describeRange, fromDay, isMonthAligned, monthLabel, presetRange, shortDay, shortRange, type ComparePreset, type PeriodPreset } from '@/components/dashboard/period'
import { holdTile } from '@/components/dashboard/holdTile'
import { downloadWorkbook } from '@/lib/xlsxWrite'
import { usePersistedState } from '@/lib/usePersistedState'
import { cn } from '@/lib/utils'
import { useDashboardLayout, useHiddenInsights, useKpiBreakdown, useKpiComparisons, useKpiGeneral, useKpiMaterials, useKpiOverview, useKpiSpan, useMaster, useUserDirectory } from '@/services/queries'
import { hideInsight, resetDashboardLayout, restoreInsight, saveDashboardLayout } from '@/services/mutations'
import { useAuth } from '@/store/AuthContext'
import { useApp } from '@/store/AppContext'
import { ApiError } from '@/lib/api'
import { sessionDetailPath } from '@/lib/links'
import { When } from '@/components/ui/Tooltip'
import { ExportMenu, InfoTip, Segmented } from '@/components/ui/PageShell'
import { useTableView, ViewNote, ViewTh, type ViewColumn } from '@/components/ui/ColumnFilter'
import { ScrollX } from '@/components/ui/ScrollX'
import { PHONE, useCoarsePointer, useMediaQuery } from '@/lib/media'

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

/** Narrower than 400 px: the smallest phones, where the page's switch takes its short words. */
const NARROW_PHONE = 'not all and (min-width: 400px)'
/** Wide enough for the plant and every factory side by side in one row. */
const WIDE = '(min-width: 1280px)'
/** From Tailwind's md (768 px): a filter row has room for every filter of a chart. */
const TABLET = '(min-width: 768px)'

/**
 * What a widget's body is on a board: a box of the board's height scrolling inside itself; stacked (a phone, a
 * tablet), as tall as it is — the page has the one scroll.
 */
function WidgetBody({ children, className }: { children: ReactNode; className?: string }) {
  const grid = useContext(ChartFillContext)
  return <div className={cn(grid && 'h-full overflow-auto overscroll-contain', className)}>{children}</div>
}

/**
 * A group table's first column, by the width of its frame (TableFrame is the size container): 8rem in a frame up to
 * an upright tablet's (an 820 px tablet's 732 px stacked table, a 1440 px screen's 640 px board box), 12rem from 48rem,
 * 14rem from 60rem.
 */
const FIRST_COLUMN = 'min-w-[8rem] [@container(min-width:48rem)]:min-w-[12rem] [@container(min-width:60rem)]:min-w-[14rem]'

/**
 * The frame of a wide table. Stacked, or outside a board, a sideways scroller with a shadow at the end that hides
 * more (its first column stays put: `table-sticky-first` on the table). On a board the widget's own box scrolls both
 * ways and keeps the header row in view, so the table sits in it as it is. Either way the frame is a size container:
 * the table's first column is sized from the frame's width, not the window's (a half-width board box on a wide screen
 * is narrower than a stacked table on an upright tablet).
 */
function TableFrame({ children }: { children: ReactNode }) {
  const grid = useContext(ChartFillContext)
  return grid ? <div className="min-w-0 [container-type:inline-size]">{children}</div> : <ScrollX shadows="end" className="[container-type:inline-size]">{children}</ScrollX>
}

/** Whether a box that scrolls inside itself hides more below its fold: its fade says so. */
function useMoreBelow(el: HTMLElement | null, on: boolean): boolean {
  const [more, setMore] = useState(false)
  useEffect(() => {
    if (!el || !on) {
      setMore(false)
      return
    }
    let frame = 0
    const read = () => {
      frame = 0
      setMore(el.scrollHeight - el.scrollTop - el.clientHeight > 2)
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(read)
    }
    read()
    el.addEventListener('scroll', schedule, { passive: true })
    // The box with the board's grid, the content with its data: either moves the fold.
    const sized = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null
    const observeAll = () => {
      if (!sized) return
      sized.disconnect()
      sized.observe(el)
      for (const child of Array.from(el.children)) sized.observe(child)
    }
    observeAll()
    const children =
      typeof MutationObserver !== 'undefined'
        ? new MutationObserver(() => {
            observeAll()
            schedule()
          })
        : null
    children?.observe(el, { childList: true })
    return () => {
      if (frame) cancelAnimationFrame(frame)
      el.removeEventListener('scroll', schedule)
      sized?.disconnect()
      children?.disconnect()
    }
  }, [el, on])
  return more
}

/**
 * A figure whose explanation would be a tooltip — a change against the period before — as a button: a mouse still
 * reads the tooltip, and a tap (a finger gets no tooltip) or a click opens the same words in a panel.
 */
function TipButton({ tip, label, className, children }: { tip: string; label: string; className?: string; children: ReactNode }) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-label={label}
        aria-expanded={open}
        data-tip={open ? undefined : tip}
        onClick={() => setOpen((o) => !o)}
        className={cn('-mx-1 inline-flex items-center gap-0.5 rounded-md px-1 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:hover:bg-slate-800 touch:min-h-[36px]', className)}
      >
        {children}
      </button>
      <FloatingPanel anchor={anchor} open={open} onClose={() => setOpen(false)} width={300} label={label}>
        <p className="p-2 text-13 leading-relaxed text-slate-700 dark:text-slate-200">{tip}</p>
      </FloatingPanel>
    </>
  )
}

/** The points of a time axis worth drawing: from the first that holds anything to the last (see dataSpan). */
function trimmed<T>(points: T[], has: (p: T) => boolean): T[] {
  const { from, to } = dataSpan(points.length, (i) => has(points[i]))
  return points.slice(from, to)
}

/** A month axis and its lines cut to the months that hold anything, for every line alike. */
function trimmedLines(labels: string[], lines: { label: string; values: (number | null)[]; className: string }[], has?: (i: number) => boolean): { labels: string[]; lines: typeof lines } {
  const { from, to } = dataSpan(labels.length, has ?? ((i) => lines.some((l) => l.values[i] !== null && l.values[i] !== undefined)))
  return { labels: labels.slice(from, to), lines: lines.map((l) => ({ ...l, values: l.values.slice(from, to) })) }
}

// ---- KPI tile --------------------------------------------------------------

/** A tile's change against the period before: its explanation a tap away (TipButton), or plain when there is none. */
function DeltaFigure({ tip, label, className, children }: { tip: string | undefined; label: string; className?: string; children: ReactNode }) {
  if (!tip) return <span className={cn('inline-flex items-center gap-0.5', className)}>{children}</span>
  return (
    <TipButton tip={tip} label={label} className={className}>
      {children}
    </TipButton>
  )
}

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
  vs,
  period: ownPeriod,
}: {
  label: string
  value: string
  unit?: string
  current: number | null
  previous: number | null
  /** The period it is compared with, for the change: "Sep 1 – Sep 30". */
  vs?: string
  /** What the figure covers when it is not the page's period ("now"); null for nothing. */
  period?: string | null
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
  const pagePeriod = useContext(PeriodBadgeContext)
  const period = ownPeriod === undefined ? pagePeriod : ownPeriod
  const fmtValue = (v: number) => (unit === '%' ? pctStr(v) : num(v, 1))
  const deltaTip =
    delta === null || current === null || previous === null
      ? undefined
      : `Relative change: ${fmtValue(current)} now against ${fmtValue(previous)}${vs ? ` in ${vs}` : ''} (${delta > 0 ? '+' : delta < 0 ? '−' : ''}${Math.abs(delta).toFixed(2)}% relative${unit === '%' ? `, ${current - previous >= 0 ? '+' : '−'}${Math.abs(current - previous).toFixed(2)} pp` : ''})`
  return (
    <Card className={cn('min-w-0 p-4 ring-1 transition-shadow hover:shadow-hover', TONE_RING[tone])}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          {/* The whole name, on up to three lines on a phone: "First part released" and "First pass released" cut short look alike. */}
          <p className="line-clamp-3 break-words text-[11px] font-semibold uppercase leading-tight tracking-wide text-muted lg:line-clamp-2">{label}</p>
          {period && <p className="truncate text-[11px] text-muted">{period}</p>}
        </div>
        <span className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-lg max-[419px]:hidden', tone === 'neutral' ? 'bg-brand-100 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300' : tone === 'green' ? 'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400' : tone === 'amber' ? 'bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400' : 'bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-400')}>
          {icon}
        </span>
      </div>
      <p className={cn('mt-1 text-2xl font-extrabold tabular-nums tracking-tight', TONE_TEXT[tone])}>
        {value}
        {unit && value !== '—' && <span className="ml-0.5 text-base font-semibold text-muted">{unit}</span>}
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted">
        {delta === null ? (
          <span className="inline-flex items-center gap-1 text-muted">
            <Minus className="h-3 w-3" /> no comparison
          </span>
        ) : (
          <DeltaFigure tip={deltaTip} label={`${label}: the change`} className={cn('font-semibold tabular-nums', good === null ? 'text-muted' : good ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400')}>
            {flat ? <Minus className="h-3 w-3" /> : up ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
            {flat ? 'flat' : `${Math.abs(delta).toFixed(2)}%`}
            {vs && <span className="ml-0.5 font-medium text-muted">vs {vs}</span>}
          </DeltaFigure>
        )}
        {previous !== null && <span className="text-muted">prev {typeof previous === 'number' ? (unit === '%' ? pctStr(previous) : num(previous, 1)) : '—'}</span>}
        {sub && <span className="basis-full text-muted">{sub}</span>}
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
                  <button type="button" onClick={() => onLink(i.link!)} className="print-hidden mt-1.5 text-xs font-semibold underline-offset-2 hover:underline touch:-my-2 touch:min-h-[44px]">
                    {i.link.kind === 'history-hold' ? 'Open the Hold list' : i.link.kind === 'machine' ? `Filter to machine ${i.link.value}` : i.link.kind === 'item' ? `Filter to item ${i.link.value}` : 'Open'}
                  </button>
                )}
              </div>
              {onHide && (
                <button
                  type="button"
                  onClick={() => onHide(key)}
                  className="print-hidden -mr-1 -mt-1 grid h-9 w-9 shrink-0 place-items-center rounded-lg opacity-60 transition-opacity hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10 touch:h-11 touch:w-11"
                  aria-label={`Hide: ${i.title}`}
                  data-tip="Hide this insight until you show it again"
                >
                  <EyeOff className="h-4 w-4" />
                </button>
              )}
              {onRestore && (
                <button
                  type="button"
                  onClick={() => onRestore(key)}
                  className="print-hidden inline-flex min-h-[36px] shrink-0 items-center gap-1 rounded-lg px-2 text-xs font-semibold underline-offset-2 hover:bg-black/5 hover:underline dark:hover:bg-white/10 touch:min-h-[44px]"
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
  /** What the column's filter lists and searches for a row; a cell that renders plain text needs none. */
  text?: (row: T) => string
  /** A figure the column sorts by, smallest first; null sorts last. */
  sortNum?: (row: T) => number | null
  /** A column of buttons has nothing to filter. */
  filterable?: false
}

/** A cell's plain text, when it renders as text. */
function plainText(node: ReactNode): string {
  return typeof node === 'string' || typeof node === 'number' ? String(node) : ''
}

/** The figure in a cell's text ("1,350", "2.45%"), or null for "—". */
function figureOf(text: string): number | null {
  const cleaned = text.replace(/[^0-9.+-]/g, '')
  const n = Number(cleaned)
  return cleaned !== '' && Number.isFinite(n) ? n : null
}

function Table<T>({
  rows,
  columns,
  rowKey,
  empty = 'Nothing in this period.',
  maxRows,
  total,
  onRowClick,
  sticky = true,
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
  /** The first column, what a row is about, stays in view as the rest scrolls sideways; false when it is not (an age). */
  sticky?: boolean
}) {
  const [showAll, setShowAll] = useState(false)
  const viewColumns = useMemo(
    () =>
      columns.map<ViewColumn<T>>((c) => {
        const text = c.text ?? ((r: T) => plainText(c.render(r)))
        // A right-aligned column holds figures: it sorts by them, smallest first.
        const figures = c.sortNum ?? (c.className?.includes('text-right') ? (r: T) => figureOf(text(r)) : undefined)
        return { key: c.key, value: text, sortValue: figures, numeric: !!figures }
      }),
    [columns],
  )
  const view = useTableView(rows, viewColumns)
  if (rows.length === 0) return <p className="py-6 text-center text-sm text-muted">{empty}</p>
  const filtered = view.active > 0 || view.sort !== null
  const visible = maxRows && !showAll && !filtered ? view.rows.slice(0, maxRows) : view.rows
  return (
    <div>
      <TableFrame>
      <table className={cn('w-full text-sm', sticky && 'table-sticky-first')}>
        <thead className="sticky top-0 z-10 bg-white dark:bg-slate-900">
          <tr className="text-left text-[11px] uppercase tracking-wide text-muted">
            {columns.map((c) =>
              c.filterable === false ? (
                <th key={c.key} className={cn('whitespace-nowrap px-2 py-1.5 font-semibold', c.className)}>
                  {c.label}
                </th>
              ) : (
                <ViewTh key={c.key} view={view} column={c.key} label={c.label} className={cn('px-2 py-1.5 font-semibold', c.className)} />
              ),
            )}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {visible.map((r) => (
            <tr key={rowKey(r)} onClick={onRowClick && (() => onRowClick(r))} className={cn('transition-colors hover:bg-slate-50/80 dark:hover:bg-slate-800/40', onRowClick && 'cursor-pointer')}>
              {columns.map((c, i) => (
                // A figure on one line; a word column wide enough to read without breaking every word onto its own line. The
                // first (sticky, so what a row is about stays in view) is sized from the table's frame: 8rem in a phone's
                // frame, an upright tablet's or a half-width board box, so the figures beside it are in view, and wider
                // only in a frame with room to spare, so a long machine or item name keeps to two lines or so.
                <td key={c.key} className={cn('px-2 py-1.5 align-top', c.className, c.className?.includes('text-right') ? 'whitespace-nowrap' : i === 0 ? FIRST_COLUMN : 'min-w-[10rem]')}>
                  {c.render(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      </TableFrame>
      <ViewNote view={view} total={rows.length} className="mt-1" />
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        {maxRows && rows.length > maxRows && !filtered && (
          <button type="button" onClick={() => setShowAll((s) => !s)} className="print-hidden text-xs font-semibold text-brand-700 hover:underline dark:text-brand-300 touch:min-h-[44px] touch:px-1">
            {showAll ? 'Show fewer' : `Show all ${rows.length}`}
          </button>
        )}
        {/* The table holds the largest few; saying so is the difference between
            a ranking and a claim that this is everything. */}
        {total !== undefined && total > rows.length && (
          <span className="text-xs text-muted">
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

/** A column a phone leaves out of a wide table: the figure behind a rate, read in full from a tablet up. */
const FROM_TABLET = 'hidden md:table-cell'

function groupColumns(t: KpiThresholds, first: Column<KpiGroupRow>): Column<KpiGroupRow>[] {
  return [
    first,
    { key: 'sessions', label: 'Sessions', className: 'text-right tabular-nums', render: (r) => num(r.sessions), text: (r) => num(r.sessions), sortNum: (r) => r.sessions },
    { key: 'samples', label: 'Samples', className: `text-right tabular-nums ${FROM_TABLET}`, render: (r) => num(r.samples), text: (r) => num(r.samples), sortNum: (r) => r.samples },
    { key: 'pieces', label: 'Inspected', className: `text-right tabular-nums ${FROM_TABLET}`, render: (r) => num(r.pieces), text: (r) => num(r.pieces), sortNum: (r) => r.pieces },
    { key: 'defects', label: 'Defect pcs', className: 'text-right tabular-nums', render: (r) => num(r.defectPieces), text: (r) => num(r.defectPieces), sortNum: (r) => r.defectPieces },
    { key: 'produced', label: 'Produced', className: 'text-right tabular-nums', render: (r) => (r.piecesProduced === null ? <span className="text-muted">—</span> : num(r.piecesProduced)), text: (r) => (r.piecesProduced === null ? '—' : num(r.piecesProduced)), sortNum: (r) => r.piecesProduced },
    { key: 'rate', label: 'Defect rate', className: 'text-right', render: (r) => <ToneCell value={r.defectRatePct} tone={toneLowIsGood(r.defectRatePct, t.defectRateGreen, t.defectRateAmber)} />, text: (r) => pctStr(r.defectRatePct), sortNum: (r) => r.defectRatePct },
    { key: 'inspectedRate', label: 'Of inspected', className: `text-right ${FROM_TABLET}`, render: (r) => <ToneCell value={r.inspectedDefectPct} tone="neutral" />, text: (r) => pctStr(r.inspectedDefectPct), sortNum: (r) => r.inspectedDefectPct },
    { key: 'fpy', label: 'FPY', className: 'text-right', render: (r) => <ToneCell value={r.fpyPct} tone={toneHighIsGood(r.fpyPct, t.fpyGreen, t.fpyAmber)} />, text: (r) => pctStr(r.fpyPct), sortNum: (r) => r.fpyPct },
    { key: 'dim', label: 'Dim fail', className: `text-right ${FROM_TABLET}`, render: (r) => <ToneCell value={r.dimFailPct} tone={toneLowIsGood(r.dimFailPct, t.dimFailGreen, t.dimFailAmber)} />, text: (r) => pctStr(r.dimFailPct), sortNum: (r) => r.dimFailPct },
  ]
}

/** The period every chart on the page covers, unless the chart says its own (a month window, all time). */
const PeriodBadgeContext = createContext<string | null>(null)

/**
 * A widget's card: its title, the period it covers, its own controls, and its body. The controls share the title's
 * row while they fit and wrap inside the card when they do not — on a phone, a row of their own under the title —
 * never pushing past the card's edge. `toolbar` is a row under the title for controls too many for the header (a
 * chart's filters). On a board the body scrolls inside the box, with a fade at its foot while more lies below;
 * stacked, it is as tall as it is.
 */
function Section({ title: ownTitle, hint: ownHint, icon, children, className, action, toolbar, period }: { title: string; hint?: string; icon?: ReactNode; children: ReactNode; className?: string; action?: ReactNode; toolbar?: ReactNode; period?: string | null }) {
  // On a board an administrator may have named and described the widget; that wins over the code's words.
  const label = useContext(WidgetLabelContext)
  const pagePeriod = useContext(PeriodBadgeContext)
  const grid = useContext(ChartFillContext)
  const [body, setBody] = useState<HTMLDivElement | null>(null)
  const more = useMoreBelow(body, grid)
  // Its charts' one switch: drawn, or their figures as a table.
  const figures = useFigureScope()
  const title = label.title || ownTitle
  const hint = label.title || label.hint ? label.hint || undefined : ownHint
  const badge = period === undefined ? pagePeriod : period
  return (
    <Card className={cn('relative flex h-full min-h-0 min-w-0 flex-col p-4 sm:p-5', className)}>
      <div className="mb-3 flex shrink-0 flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {icon && <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">{icon}</span>}
          <h2 className="min-w-0 break-words text-base font-bold leading-tight">{title}</h2>
          {hint && <InfoTip text={hint} label={`About ${title}`} />}
        </div>
        {(badge || action || figures.hasCharts) && (
          <div className={cn('flex min-w-0 max-w-full flex-wrap items-center gap-2 sm:justify-end', !!action && 'max-sm:w-full')}>
            {badge && (
              <Badge tone="neutral" tip="The period this chart covers">
                {badge}
              </Badge>
            )}
            {action}
            {figures.hasCharts && <ChartTableSwitch value={figures.view} onChange={figures.setView} />}
          </div>
        )}
      </div>
      {toolbar && <div className="print-hidden mb-3 shrink-0">{toolbar}</div>}
      {/* On paper there is no tooltip: the explanation is printed under the title. */}
      {hint && <p className="mb-2 hidden text-xs text-muted print:block">{hint}</p>}
      <div ref={setBody} className={cn('min-w-0', grid && 'min-h-0 flex-1 overflow-auto overscroll-contain')}>
        <FigureScope scope={figures.scope}>{children}</FigureScope>
      </div>
      {grid && <div aria-hidden className={cn('pointer-events-none absolute inset-x-0 bottom-0 h-10 rounded-b-2xl bg-gradient-to-t from-white to-transparent transition-opacity duration-150 dark:from-slate-900', more ? 'opacity-100' : 'opacity-0')} />}
    </Card>
  )
}

// ---- The general page and the analysis blocks --------------------------------

function PlainTile({ label, value, sub, icon, tone = 'neutral', control, onOpen }: { label: string; value: string; sub?: ReactNode; icon: ReactNode; tone?: KpiTone; control?: ReactNode; onOpen?: () => void }) {
  const period = useContext(PeriodBadgeContext)
  const opens = onOpen
    ? { role: 'button' as const, tabIndex: 0, onClick: onOpen, onKeyDown: (e: { key: string; preventDefault: () => void }) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onOpen()), 'aria-label': `${label}: open the sessions behind it` }
    : {}
  return (
    <Card className={cn('min-w-0 p-4 ring-1', TONE_RING[tone], onOpen && 'cursor-pointer transition-shadow hover:shadow-hover')} {...opens}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="line-clamp-3 break-words text-[11px] font-semibold uppercase leading-tight tracking-wide text-muted lg:line-clamp-2">{label}</p>
          {period && <p className="truncate text-[11px] text-muted">{period}</p>}
          {control && <div className="print-hidden mt-1">{control}</div>}
        </div>
        <span className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-lg max-[419px]:hidden', tone === 'neutral' ? 'bg-brand-100 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300' : tone === 'green' ? 'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400' : tone === 'amber' ? 'bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400' : 'bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-400')}>
          {icon}
        </span>
      </div>
      <p className={cn('mt-1 text-2xl font-extrabold tabular-nums tracking-tight', TONE_TEXT[tone])}>{value}</p>
      {sub && <p className="mt-1 text-xs text-muted">{sub}</p>}
    </Card>
  )
}

type GeneralPick = 'factory' | 'process' | 'details'

/** The change of a monthly rate against the month before it: the last two months that have one, named. */
interface MonthTrend {
  /** Relative change, in percent of the earlier rate. */
  delta: number | null
  last: number | null
  before: number | null
  lastLabel: string | null
  beforeLabel: string | null
}
function monthTrend(rates: (number | null)[], labels: string[]): MonthTrend {
  const known = rates.flatMap((v, i) => (v === null ? [] : [{ v, label: labels[i] ?? null }]))
  const last = known.length ? known[known.length - 1] : null
  const before = known.length > 1 ? known[known.length - 2] : null
  return { delta: deltaPct(last?.v ?? null, before?.v ?? null), last: last?.v ?? null, before: before?.v ?? null, lastLabel: last?.label ?? null, beforeLabel: before?.label ?? null }
}

/**
 * An arrow and a figure for a trend where a fall is good, saying what it is
 * against: "▼ 13.53% vs Sep". The figure is the relative change; under it, in
 * a muted line, the two rates it compares ("1.07% Oct vs 1.57% Sep") — said
 * on the card, not only in the tooltip a finger never sees; the tooltip adds
 * the change in percentage points.
 */
function TrendMark({ trend, align = 'end' }: { trend: MonthTrend; align?: 'start' | 'end' }) {
  const { delta } = trend
  const up = delta !== null && delta > 0
  const flat = delta !== null && Math.abs(delta) < 0.005
  const compared = delta !== null && trend.last !== null && trend.before !== null
  const tip =
    delta === null || trend.last === null || trend.before === null
      ? 'No earlier month to compare with'
      : `Relative change of the reject rate: ${pctStr(trend.last)} in ${trend.lastLabel} against ${pctStr(trend.before)} in ${trend.beforeLabel} (${delta > 0 ? '+' : delta < 0 ? '−' : ''}${Math.abs(delta).toFixed(2)}% relative, ${trend.last - trend.before >= 0 ? '+' : '−'}${Math.abs(trend.last - trend.before).toFixed(2)} pp)`
  return (
    <span className={cn('inline-flex min-w-0 shrink-0 flex-col', align === 'end' ? 'items-end text-right' : 'items-start text-left')} data-tip={tip}>
      <span className={cn('inline-flex items-center gap-0.5 whitespace-nowrap text-xs font-semibold tabular-nums', delta === null ? 'text-muted' : flat ? 'text-muted' : up ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400')}>
        {delta === null || flat ? <Minus className="h-3 w-3" /> : up ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
        {delta === null ? '—' : flat ? 'flat' : `${Math.abs(delta).toFixed(2)}%`}
        {delta !== null && trend.beforeLabel && <span className="ml-0.5 font-medium text-muted">vs {trend.beforeLabel}</span>}
      </span>
      {compared && (
        <span className="text-[11px] tabular-nums leading-tight text-muted">
          {pctStr(trend.last)} {trend.lastLabel} vs {pctStr(trend.before)} {trend.beforeLabel}
        </span>
      )}
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

/** A window of months for a chart's badge: "Oct 2026", or "Sep – Oct 2026" within a year. */
function monthSpan(fromDay: string, toDay: string): string {
  const a = fromDay.slice(0, 7)
  const b = toDay.slice(0, 7)
  if (a === b) return monthLabel(a)
  return a.slice(0, 4) === b.slice(0, 4) ? `${monthLabel(a, false)} – ${monthLabel(b)}` : `${monthLabel(a)} – ${monthLabel(b)}`
}

/** How the trend window reads in a sentence: "this month" or "the last 3 months". */
function windowLength(g: KpiGeneral): string {
  return g.monthsBack <= 1 ? 'this month' : `the last ${g.monthsBack} months`
}

/** The machines the dashboard leaves out (Configuration → Machines), named under its figures so nobody wonders why a machine is missing. */
function ScopeNote({ leftOut }: { leftOut: { code: string; displayName: string }[] }) {
  return (
    <p className="flex items-start gap-1.5 text-xs text-muted">
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>
        {leftOut.length === 0
          ? 'Every figure counts every machine of the register.'
          : `Every figure counts only the machines on the dashboard. Left out: ${leftOut.map((m) => m.displayName || m.code).join(', ')} — set under Configuration › Machines.`}
      </span>
    </p>
  )
}

/**
 * The plant and its factories: on a wide screen side by side in one row, divided between them, each card the same width
 * and height, its parts at the same height as the next card's; on a phone one under another, the whole width; between
 * the two, two or three a row. On paper a grid of three.
 */
function GeneralOverview({ data, loading, error, leftOut }: { data: KpiGeneral | null; loading: boolean; error: string | null; leftOut: { code: string; displayName: string }[] }) {
  const wide = useMediaQuery(WIDE)
  if (error) return <Card className="border border-rose-200 p-4 text-sm text-rose-700 dark:border-rose-500/30 dark:text-rose-300">{error}</Card>
  if (!data) {
    return loading ? (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 md:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className={cn('skeleton h-36', i > 0 && 'max-sm:hidden')} />
        ))}
      </div>
    ) : null
  }
  const t = data.thresholds
  const trendSpan = windowWords(data)
  const period = shortRange({ from: data.from, to: data.to })
  const about = `Reject rate and PPM over ${describeRange({ from: data.from, to: data.to })}; the trend line is ${windowLength(data)}, ${trendSpan}${data.monthsBack > 1 ? ', against the month before' : ''}; it starts on the first month with production.`
  const scopeWords = leftOut.length === 0 ? 'Every figure counts every machine of the register.' : `Every figure counts only the machines on the dashboard. Left out: ${leftOut.map((m) => m.displayName || m.code).join(', ')} — set under Configuration › Machines.`
  const cards = [
    { key: '__plant', label: 'Whole plant', sub: `${num(data.totals.factories)} factories · ${num(data.totals.machines)} machines`, rate: data.totals.defectRatePct, months: data.months },
    ...[...data.factories].sort((a, b) => byName(a.factory, b.factory)).map((f) => ({ key: f.factory, label: f.factory, sub: Array.from(new Set(data.machines.filter((m) => m.factory === f.factory).map((m) => PROCESS_LABEL[m.process]))).join(' · ') || 'no process', rate: f.defectRatePct, months: f.months })),
  ]
  const row = (
    <div
      className={cn('grid gap-3 sm:gap-4', !wide && 'grid-cols-1 sm:grid-cols-2 md:grid-cols-3', 'print:grid-cols-3 print:gap-3')}
      style={wide ? { gridTemplateColumns: `repeat(${cards.length}, minmax(0, 1fr))` } : undefined}
    >
      {cards.map((c) => {
        const tone = toneLowIsGood(c.rate, t.defectRateGreen, t.defectRateAmber)
        const trend = monthTrend(
          c.months.map((m) => m.defectRatePct),
          c.months.map((m) => monthLabel(m.month, false)),
        )
        return (
          // Every card has the same lines in the same order, each one line high, so they line up across the row.
          <Card key={c.key} className={cn('flex min-w-0 flex-col p-3 ring-1 sm:p-4', TONE_RING[tone], c.key === '__plant' && 'bg-slate-50 dark:bg-slate-800/40')}>
            <p className="flex h-5 min-w-0 items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
              <span className="min-w-0 truncate" title={c.label}>
                {c.label}
              </span>
              {c.key === '__plant' && <InfoTip text={`${about}\n\n${scopeWords}`} label="How these figures are counted" />}
              {c.key === '__plant' && leftOut.length > 0 && (
                <Badge tone="amber" tip={scopeWords} className="ml-auto h-[18px] shrink-0 px-1.5 text-[10px] normal-case tracking-normal">
                  {leftOut.length} left out
                </Badge>
              )}
            </p>
            <p className="truncate text-[11px] text-muted" title={c.sub}>
              {c.sub}
            </p>
            <p className={cn('mt-2 whitespace-nowrap text-2xl font-extrabold tabular-nums tracking-tight', TONE_TEXT[tone])}>
              {pctStr(c.rate)}
              <span className="ml-1 text-[11px] font-semibold uppercase text-muted">reject</span>
            </p>
            <div className="mt-1 min-h-[2rem]">
              <TrendMark trend={trend} align="start" />
            </div>
            <div className="mt-auto flex items-end justify-between gap-2 pt-2">
              <p className="shrink-0 text-xs text-muted">
                <span className="font-semibold tabular-nums text-slate-700 dark:text-slate-200">{ppmStr(c.rate)}</span> PPM
                <span className="block text-[11px]">{period}</span>
              </p>
              <Sparkline width={120} height={36} values={c.months.map((m) => m.defectRatePct)} svgClassName="h-auto w-full min-w-[3rem] max-w-[120px] flex-1" className={tone === 'red' ? 'stroke-rose-500' : tone === 'amber' ? 'stroke-amber-500' : tone === 'green' ? 'stroke-emerald-500' : 'stroke-brand-500'} />
            </div>
          </Card>
        )
      })}
    </div>
  )
  return (
    <div className="space-y-4">
      {row}
      {/* On paper the explanation is printed; on screen it is behind the (i) on the first card. */}
      <p className="hidden text-xs text-muted print:block">{about}</p>
      <div className="hidden print:block">
        <ScopeNote leftOut={leftOut} />
      </div>
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

/** The factories (or processes) a pick can be made of, in order. */
function scopeOptions(kind: 'factory' | 'process', general: KpiGeneral, factories: string[]): { key: string; label: string }[] {
  return kind === 'factory'
    ? Array.from(new Set([...factories, ...general.factories.map((f) => f.factory)])).sort(byName).map((f) => ({ key: f, label: f }))
    : PROCESSES.map((p) => ({ key: p, label: PROCESS_LABEL[p] }))
}

/** What is chosen of them; none means all of them together. */
const scopeChosen = (kind: 'factory' | 'process', picks: ScopePicks, options: { key: string }[]): string[] =>
  (kind === 'factory' ? picks.factories : picks.processes).filter((k) => options.some((o) => o.key === k))

/** The factory (or process) buttons of a pick: all of them, or several at once. On the page's second row, beside the switch. */
function ScopeChips({ kind, general, factories, picks, setPicks }: { kind: 'factory' | 'process'; general: KpiGeneral; factories: string[]; picks: ScopePicks; setPicks: (next: ScopePicks | ((prev: ScopePicks) => ScopePicks)) => void }) {
  const options = scopeOptions(kind, general, factories)
  const chosen = scopeChosen(kind, picks, options)
  const toggle = (key: string) =>
    setPicks((prev) =>
      kind === 'factory'
        ? { ...prev, factories: prev.factories.includes(key) ? prev.factories.filter((k) => k !== key) : [...prev.factories, key] }
        : { ...prev, processes: prev.processes.includes(key as Process) ? prev.processes.filter((k) => k !== key) : [...prev.processes, key as Process] },
    )
  const all = () => setPicks((prev) => (kind === 'factory' ? { ...prev, factories: [] } : { ...prev, processes: [] }))
  const chip = (on: boolean) =>
    cn(
      'inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-13 font-semibold ring-1 transition-colors touch:h-11',
      on ? 'bg-brand-600 text-white ring-brand-600' : 'bg-white text-slate-600 ring-slate-200 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-300 dark:ring-slate-700 dark:hover:bg-slate-800',
    )
  if (options.length === 0) return <p className="text-sm text-muted">No {kind === 'factory' ? 'factory' : 'process'} in the machine register yet.</p>
  return (
    <div className="scrollbar-none flex min-w-0 items-center gap-1.5 max-sm:-mx-1 max-sm:overflow-x-auto max-sm:px-1 max-sm:py-0.5 sm:flex-wrap" role="group" aria-label={kind === 'factory' ? 'Factory: tap several to see them together' : 'Process: tap several to see them together'} data-tip="Tap several to see them together">
      <button type="button" aria-pressed={chosen.length === 0} onClick={all} className={chip(chosen.length === 0)}>
        {kind === 'factory' ? 'All factories' : 'All processes'}
      </button>
      {options.map((o) => {
        const on = chosen.includes(o.key)
        return (
          <button key={o.key} type="button" aria-pressed={on} onClick={() => toggle(o.key)} className={chip(on)}>
            {on && <Check className="h-3.5 w-3.5" />}
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

function ScopeView({ kind, general, factories, t, picks, setPicks }: { kind: 'factory' | 'process'; general: KpiGeneral; factories: string[]; t: KpiThresholds; picks: ScopePicks; setPicks: (next: ScopePicks | ((prev: ScopePicks) => ScopePicks)) => void }) {
  const navigate = useNavigate()
  /** The machines of the first-part widgets, several at once, kept on the device. */
  const [fpMachines, setFpMachines] = usePersistedState<string[]>('qc-dash:fp-machines', [])
  const pickedByScope = picks.machines
  const setPickedByScope = (f: (prev: Record<string, string[]>) => Record<string, string[]>) => setPicks((prev) => ({ ...prev, machines: f(prev.machines) }))
  const options = scopeOptions(kind, general, factories)
  // Several at once, chosen on the page's second row (ScopeChips); none chosen means all of them together.
  const chosen = scopeChosen(kind, picks, options)
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
  const windowSpan = monthSpan(general.window.from, general.window.to)
  // The month charts of the pick: the period's months, the pick's factories, and its machines with the highest reject rate.
  // Cut to the months that made anything: This year read in October draws September and October, not eight empty months first.
  const pickMonths = breakdown?.months ?? []
  const pickLabels = pickMonths.map((m) => monthLabel(m.month, false))
  const madeIn = (i: number) => (pickMonths[i]?.made ?? 0) > 0
  const pickFactoryLines = trimmedLines(pickLabels, (breakdown?.series.factories ?? []).slice(0, LINE_CLASSES.length).map((f, i) => ({ label: f.label, values: f.months.map((m) => m.defectRatePct), className: LINE_CLASSES[i] })), madeIn)
  const pickMachines = [...(breakdown?.series.machines ?? [])].filter((m) => m.made > 0).sort((a, b) => (b.defectRatePct ?? -1) - (a.defectRatePct ?? -1) || b.made - a.made).slice(0, LINE_CLASSES.length)
  const pickMachineLines = trimmedLines(pickLabels, pickMachines.map((m, i) => ({ label: m.label, values: m.months.map((x) => x.defectRatePct), className: LINE_CLASSES[i] })), madeIn)
  const detailTitle = picked.length ? `${picked.length === 1 ? 'Machine' : `${picked.length} machines`}: ${machines.filter((m) => picked.includes(m.workCenterCode)).map((m) => m.label).join(', ')}` : scopeLabel
  return (
    <div className="space-y-4">
      <Board
        page="general"
        className={cn('transition-opacity', isFetching && 'opacity-70')}
        widgets={[
          { id: 'g.trend', title: 'Plant trend, last months', node: (
        <Section title="Plant: trend" period={windowSpan} hint={`Pieces made each month, ${windowSpan} (produced + rejected), from the first month with production and at most the last ${GENERAL_MONTHS}, with the plant's reject rate over them and a line for each factory. Neither the period strip nor the picks narrow this chart.`} icon={<Activity className="h-4 w-4" />} className="xl:col-span-3">
          {general.months.some((m) => m.piecesProduced + m.productionDefectPieces > 0) ? (
            <TrendChart points={general.months.map((m) => ({ label: monthLabel(m.month, false), bar: m.piecesProduced + m.productionDefectPieces, line: m.defectRatePct }))} barLabel="Pieces made" lineLabel="Reject rate · plant" lines={factoryLines} />
          ) : (
            <p className="py-10 text-center text-sm text-muted">No session closed with a final quantity in these months.</p>
          )}
        </Section>
          ) },
          { id: 'g.machines', title: 'Machines of the pick', node: (
        <Section title={`${scopeLabel}: machines`} hint={kind === 'process' ? 'Reject rate of each machine over the period, under its process, worst first in each, with its trend. Tick machines to compare them; the breakdown below follows the ticks.' : 'Reject rate of each machine over the period, worst first, with its trend. Tick machines to compare them; the breakdown below follows the ticks.'} icon={<Layers className="h-4 w-4" />} className="xl:col-span-2" action={picked.length > 0 && <button type="button" onClick={clearPick} className="text-xs font-semibold text-muted hover:text-rose-600 touch:min-h-[44px] touch:px-2">Clear {picked.length} ticked</button>}>
          {machines.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">No production closed in this period.</p>
          ) : (
            <div className="space-y-3 pr-1">
              {machineGroups.map((g) => (
                <div key={g.key}>
                  {g.label !== null && (
                    <p className="mb-1 flex items-baseline justify-between px-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
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
                    {/* The name on a line of its own (two at most, never cut to "31…"), then its rate, PPM and bar; the trend beside them from a tablet up. */}
                    <button type="button" onClick={() => togglePick(m.workCenterCode)} aria-pressed={on} className={cn('flex w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/60 touch:py-2.5', on && 'bg-brand-50 ring-1 ring-brand-300 dark:bg-brand-500/10 dark:ring-brand-500/40')}>
                      <span className={cn('grid h-5 w-5 shrink-0 place-items-center rounded border', on ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-300 dark:border-slate-600')}>{on && <Check className="h-3.5 w-3.5" />}</span>
                      <span className="min-w-0 flex-1">
                        <span className="line-clamp-2 break-words text-sm font-medium leading-snug text-slate-700 dark:text-slate-200">
                          <bdi>{m.label}</bdi>
                        </span>
                        {/* The tag on a line of its own, so a two-line name never cuts it short. */}
                        <span className="block text-xs font-normal text-muted">{kind === 'process' ? m.factory : PROCESS_LABEL[m.process]}</span>
                        <span className="mt-1 flex items-center gap-2">
                          <span className="shrink-0 text-xs tabular-nums text-muted"><span className={cn('font-semibold', TONE_TEXT[tone])}>{pctStr(m.defectRatePct)}</span> · {ppmStr(m.defectRatePct)} PPM</span>
                          <span className="block h-1.5 min-w-[2rem] flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"><span className={cn('block h-full rounded-full', tone === 'red' ? 'bg-rose-500' : tone === 'amber' ? 'bg-amber-500' : tone === 'green' ? 'bg-emerald-500' : 'bg-slate-300')} style={{ width: `${Math.min(100, ((m.defectRatePct ?? 0) / maxRate) * 100)}%` }} /></span>
                        </span>
                      </span>
                      <Sparkline values={m.months.map((x) => x.defectRatePct)} width={72} height={24} svgClassName="hidden shrink-0 sm:block" />
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
          {breakdown ? <LineChart labels={pickFactoryLines.labels} series={pickFactoryLines.lines} /> : <div className="skeleton h-48" />}
        </Section>
          ) },
          { id: 'g.machinesByMonth', title: 'Machines by month', node: (
        <Section title={`${scopeLabel}: machines by month`} hint={`The ${pickMachines.length} machines of the pick with the highest reject rate, month by month over ${describeRange({ from: general.from, to: general.to })}. Tick machines above to choose them yourself.`} icon={<Layers className="h-4 w-4" />}>
          {breakdown ? <LineChart labels={pickMachineLines.labels} series={pickMachineLines.lines} /> : <div className="skeleton h-48" />}
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
        <Section title={kind === 'factory' ? 'Rejected by factory, all time' : 'Rejected by process, all time'} period="All time" hint={`Each ${kind}'s share of every rejected piece since ${describeRange({ from: general.allTime.from, to: general.allTime.to })}. Neither the period nor the picks narrow it.`} icon={kind === 'factory' ? <Factory className="h-4 w-4" /> : <Layers className="h-4 w-4" />}>
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

/** One point of a comparison line, as its axis reads it: "3 Sep", "1 – 7 Sep", or "Sep". */
function bucketLabel(b: KpiCompareBucket, grain: KpiGrain): string {
  if (grain === 'day') return shortDay(b.from)
  if (grain === 'week') return b.from === b.to ? shortDay(b.from) : `${shortDay(b.from)} – ${shortDay(b.to)}`
  return monthLabel(b.key, false)
}

const GRAIN_WORD: Record<KpiGrain, string> = { day: 'a day', week: 'a week', month: 'a month' }

const GRAIN_CHOICES: { value: KpiGrainChoice; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'day', label: 'Days' },
  { value: 'week', label: 'Weeks' },
  { value: 'month', label: 'Months' },
]

/** How finely a chart over the period is drawn, picked on the chart itself. Auto follows the period's length. */
function GrainPicker({ value, onChange }: { value: KpiGrainChoice; onChange: (g: KpiGrainChoice) => void }) {
  return (
    <span className="inline-flex rounded-lg p-0.5 ring-1 ring-slate-200 dark:ring-slate-700" role="group" aria-label="Points of the chart">
      {GRAIN_CHOICES.map((g) => (
        <button
          key={g.value}
          type="button"
          aria-pressed={value === g.value}
          onClick={() => onChange(g.value)}
          className={cn('min-h-[30px] rounded-md px-2 text-xs font-semibold transition-colors touch:min-h-[44px] touch:px-2.5', value === g.value ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800')}
        >
          {g.label}
        </button>
      ))}
    </span>
  )
}

/** The largest defects in their own colour on the stacked columns; the rest together. */
const STACKED_DEFECTS = 8

/**
 * §15 — Comparisons. First what does not move with the group picked: a card
 * for each group (its reject rate and PPM over the period, its months), and
 * the groups month by month with their pie. Then one group picked: its
 * machines over the period (days, weeks or months, picked on the chart) and
 * month by month, and how its defects spread over its machines. Last, roll
 * forming's raw material.
 */
function ComparisonsView({ general, t }: { general: KpiGeneral; t: KpiThresholds }) {
  const [process, setProcess] = usePersistedState<Process>('qc-dash:compare-process', 'forming')
  const picked: Process = PROCESSES.includes(process) ? process : 'forming'
  const [grain, setGrain] = usePersistedState<KpiGrainChoice>('qc-dash:compare-grain', 'auto')
  /** Machines chosen for the lines; none chosen draws the most rejected ones. Cleared when the group changes. */
  const [lineMachines, setLineMachines] = useState<string[]>([])
  const { data, isFetching } = useKpiComparisons({ from: general.from, to: general.to, process: picked, grain })
  const [drill, setDrill] = useState<DrillSpec | null>(null)
  const processName = PROCESS_LABEL[picked]
  const periodWords = describeRange({ from: general.from, to: general.to })
  const windowWordsText = data ? describeRange({ from: data.window.from, to: data.window.to }) : ''
  /** The month window on a chart's badge: "Sep – Oct 2026". */
  const windowBadge = data ? monthSpan(data.window.from, data.window.to) : null

  // A group keeps its colour on every chart and pie of the tab.
  const processLines = (block: KpiCompareBlock) =>
    PROCESSES.map((p) => block.series.find((x) => x.key === p))
      .filter((x): x is KpiCompareSeries => x !== undefined && x.made > 0)
      .map((x) => ({ label: PROCESS_LABEL[x.key as Process] ?? x.key, values: x.points.map((pt) => pt.defectRatePct), className: PIE_STROKES[PROCESSES.indexOf(x.key as Process)] }))
  const processSlices = (block: KpiCompareBlock): PieSlice[] =>
    block.series
      .filter((x) => x.productionDefectPieces > 0)
      .sort((a, b) => b.productionDefectPieces - a.productionDefectPieces)
      .map((x) => ({ key: x.key, label: PROCESS_LABEL[x.key as Process] ?? x.key, value: x.productionDefectPieces, className: PIE_CLASSES[PROCESSES.indexOf(x.key as Process)] }))
  const openProcess = (block: KpiCompareBlock, words: string) => (sl: PieSlice) => sl.key && setDrill({ title: `${sl.label}: rejected pieces`, subtitle: words, query: { from: block.from, to: block.to, processes: [sl.key as Process] } })

  // The machines, most rejected first; a machine seen only in the months comes after. A machine keeps its colour on both charts.
  const machines = [...(data?.machines.series ?? [])].filter((m) => m.made > 0).sort((a, b) => b.productionDefectPieces - a.productionDefectPieces || b.made - a.made || a.label.localeCompare(b.label))
  const monthMachines = (data?.machinesWindow.series ?? []).filter((m) => m.made > 0)
  const ranked = [...machines.map((m) => m.key), ...monthMachines.map((m) => m.key).filter((k) => !machines.some((m) => m.key === k))]
  const colourOf = (code: string) => SERIES_STROKES[Math.min(Math.max(ranked.indexOf(code), 0), SERIES_STROKES.length - 1)]
  const options = ranked.map((k) => machines.find((m) => m.key === k) ?? monthMachines.find((m) => m.key === k)!)
  const chosen = lineMachines.filter((c) => ranked.includes(c))
  const drawnKeys = (chosen.length ? chosen : ranked).slice(0, SERIES_STROKES.length)
  const linesOf = (series: KpiCompareSeries[]) =>
    drawnKeys
      .map((k) => series.find((m) => m.key === k))
      .filter((m): m is KpiCompareSeries => m !== undefined && m.made > 0)
      .map((m) => ({ label: m.label, values: m.points.map((pt) => pt.defectRatePct), className: colourOf(m.key) }))
  const leftOut = Math.max(0, (chosen.length || ranked.length) - SERIES_STROKES.length)
  // The period's and the months' points cut to the ones some machine drawn holds: no run of empty days before the first.
  const machinesOverPeriod = data ? trimmedLines(data.machines.buckets.map((bk) => bucketLabel(bk, data.machines.grain)), linesOf(data.machines.series)) : null
  const machinesByMonth = data ? trimmedLines(data.machinesWindow.buckets.map((bk) => bucketLabel(bk, 'month')), linesOf(data.machinesWindow.series)) : null
  const coarse = useCoarsePointer()
  const machinePicker = ranked.length > 0 && (
    <MultiSelectMenu
      options={options.map((m) => ({ value: m.key, label: m.label, sub: m.factory }))}
      selected={chosen}
      onChange={setLineMachines}
      allLabel={ranked.length > SERIES_STROKES.length ? `The ${SERIES_STROKES.length} most rejected` : 'All machines'}
      noun="machines"
      ariaLabel="Machines drawn"
    />
  )

  // The defects on the machines: the largest in their own colour, the rest as Others.
  const defects = data?.defects
  const topDefects = (defects?.rows ?? []).slice(0, STACKED_DEFECTS)
  const restDefects = (defects?.rows ?? []).slice(STACKED_DEFECTS)
  const defectColumns = (defects?.machines ?? []).map((m, i) => ({
    label: m.label,
    segments: [
      ...topDefects.map((d, k) => ({ label: d.defectName, value: d.byMachine[i], className: PIE_CLASSES[k] })),
      ...(restDefects.length ? [{ label: `Others (${restDefects.length})`, value: restDefects.reduce((n, d) => n + d.byMachine[i], 0), className: PIE_CLASSES[PIE_CLASSES.length - 1] }] : []),
    ],
  }))
  const defectLegend = [...topDefects.map((d, k) => ({ label: d.defectName, className: PIE_CLASSES[k] })), ...(restDefects.length ? [{ label: `Others (${restDefects.length})`, className: PIE_CLASSES[PIE_CLASSES.length - 1] }] : [])]
  const defectTotal = (defects?.rows ?? []).reduce((n, d) => n + d.pieces, 0)
  // Excel's filter on the defects table: the defect, each machine's pieces, the total and the share.
  const defectFilters = useColumnFilters(defects?.rows ?? [], [
    { key: 'defect', value: (d) => d.defectName },
    ...(defects?.machines ?? []).map((m, i) => ({ key: `m:${m.key}`, value: (d: (typeof defects & {})['rows'][number]) => num(d.byMachine[i]), numeric: true })),
    { key: 'total', value: (d) => num(d.pieces), numeric: true },
    { key: 'share', value: (d) => pctStr(pct(d.pieces, defectTotal)), numeric: true },
  ])

  const empty = (words: string) => <p className="py-10 text-center text-sm text-muted">Nothing was closed with a final quantity {words}.</p>
  const pickQuery: KpiDrillQuery = { from: general.from, to: general.to, processes: [picked] }

  return (
    <div className="space-y-4">
      <Board
        page="comparisons"
        className={cn('transition-opacity', isFetching && 'opacity-70')}
        widgets={[
          { id: 'c.groupCards', title: 'Reject rate of each group', labelled: false, node: data ? (
            <WidgetBody className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-4">
              {PROCESSES.map((p) => {
                const inPeriod = data.period.series.find((x) => x.key === p)
                const months = data.window.series.find((x) => x.key === p)?.points ?? []
                const rate = inPeriod?.defectRatePct ?? null
                const tone = toneLowIsGood(rate, t.defectRateGreen, t.defectRateAmber)
                return (
                  <Card key={p} className={cn('min-w-0 p-4 ring-1', TONE_RING[tone])}>
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0 flex-1 basis-28">
                        <p className="break-words text-[11px] font-semibold uppercase leading-tight tracking-wide text-muted">{PROCESS_LABEL[p]}</p>
                        <p className="break-words text-[11px] text-muted">{num(inPeriod?.productionDefectPieces ?? 0)} rejected of {num(inPeriod?.made ?? 0)} made</p>
                      </div>
                      <TrendMark
                        trend={monthTrend(
                          months.map((m) => m.defectRatePct),
                          data.window.buckets.map((b) => (data.window.grain === 'month' ? monthLabel(b.key, false) : bucketLabel(b, data.window.grain))),
                        )}
                      />
                    </div>
                    <p className={cn('mt-1 text-2xl font-extrabold tabular-nums tracking-tight', TONE_TEXT[tone])}>
                      {pctStr(rate)}
                      <span className="ml-1 text-[11px] font-semibold uppercase text-muted">reject</span>
                    </p>
                    <div className="mt-1 flex flex-wrap items-end justify-between gap-x-2 gap-y-1">
                      <p className="text-xs text-muted">
                        <span className="font-semibold tabular-nums text-slate-700 dark:text-slate-200">{ppmStr(rate)}</span> PPM
                        <span className="block text-[11px]">{shortRange({ from: data.period.from, to: data.period.to })}</span>
                      </p>
                      <Sparkline width={120} height={36} values={months.map((m) => m.defectRatePct)} svgClassName="h-auto w-full min-w-[4rem] max-w-[120px] flex-1 basis-16" className={tone === 'red' ? 'stroke-rose-500' : tone === 'amber' ? 'stroke-amber-500' : tone === 'green' ? 'stroke-emerald-500' : 'stroke-brand-500'} />
                    </div>
                  </Card>
                )
              })}
            </WidgetBody>
          ) : <div className="skeleton h-full min-h-[7rem]" /> },
          { id: 'c.processMonths', title: 'Groups by month', node: (
            <Section title="Groups by month" period={windowBadge} hint={`Each group's reject rate month by month, ${windowWordsText}: from the first month with production and at most the last ${GENERAL_MONTHS}. Neither the period nor the group picked moves it.`} icon={<Activity className="h-4 w-4" />}>
              {!data ? <div className="skeleton h-48" /> : data.window.series.some((x) => x.made > 0) ? <LineChart labels={data.window.buckets.map((b) => bucketLabel(b, 'month'))} series={processLines(data.window)} /> : empty('in these months')}
            </Section>
          ) },
          { id: 'c.processMonthsPie', title: 'Rejected by group, by month', node: (
            <Section title="Rejected by group" period={windowBadge} hint={`Each group's share of the rejected pieces, ${windowWordsText}. Tap a slice for the sessions behind it.`} icon={<Layers className="h-4 w-4" />}>
              {data ? <PieChart centerLabel="rejected" slices={processSlices(data.window)} onPick={openProcess(data.window, windowWordsText)} /> : <div className="skeleton h-44" />}
            </Section>
          ) },
        ]}
      />

      <div className="flex flex-wrap items-center gap-2 pt-2" role="group" aria-label="Group to compare">
        <h2 className="mr-1 text-lg font-extrabold tracking-tight">Machines of a group</h2>
        {PROCESSES.map((p) => {
          const on = p === picked
          return (
            <button
              key={p}
              type="button"
              aria-pressed={on}
              onClick={() => {
                setProcess(p)
                setLineMachines([])
              }}
              className={cn('inline-flex min-h-[40px] items-center gap-1.5 rounded-xl px-3 text-sm font-semibold ring-1 transition-colors touch:min-h-[44px]', on ? 'bg-brand-600 text-white ring-brand-600' : 'bg-white text-slate-600 ring-slate-200 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-300 dark:ring-slate-700 dark:hover:bg-slate-800')}
            >
              {on && <Check className="h-3.5 w-3.5" />}
              {PROCESS_LABEL[p]}
            </button>
          )
        })}
      </div>

      <Board
        page="comparisons"
        className={cn('transition-opacity', isFetching && 'opacity-70')}
        widgets={[
          { id: 'c.machines', title: 'Machines of the group over the period', node: (
            <Section
              title={`${processName}: machines over the period`}
              hint={`Each machine's reject rate over ${periodWords}, a point ${data ? GRAIN_WORD[data.machines.grain] : 'a day'}; a line runs on over the points when nothing was made.${leftOut > 0 ? ` ${leftOut} more ${leftOut === 1 ? 'machine is' : 'machines are'} not drawn: choose up to ${SERIES_STROKES.length}.` : ''} Pick machines to compare a few.`}
              icon={<Factory className="h-4 w-4" />}
              action={
                <>
                  <GrainPicker value={grain} onChange={setGrain} />
                  {machinePicker}
                </>
              }
            >
              {!data ? <div className="skeleton h-56" /> : machines.length ? <LineChart labels={machinesOverPeriod!.labels} series={machinesOverPeriod!.lines} height={260} connectGaps /> : empty(`on ${processName.toLowerCase()} in this period`)}
            </Section>
          ) },
          { id: 'c.machinesMonths', title: 'Machines of the group by month', node: (
            <Section title={`${processName}: machines by month`} period={windowBadge} hint={`Each machine's reject rate month by month, ${windowWordsText}. The period does not move it; the machines are the ones drawn beside.`} icon={<Activity className="h-4 w-4" />}>
              {!data ? <div className="skeleton h-56" /> : monthMachines.length ? <LineChart labels={machinesByMonth!.labels} series={machinesByMonth!.lines} height={260} /> : empty(`on ${processName.toLowerCase()} in these months`)}
            </Section>
          ) },
          { id: 'c.machineDefects', title: 'Defects on each machine of the group', node: (
            <Section title={`${processName}: defects on each machine`} hint={`The rejected pieces of each machine over ${periodWords}, stacked by defect: the ${STACKED_DEFECTS} largest in their own colour, the rest as Others. ${coarse ? 'Tap' : 'Hover'} a machine for its defects.`} icon={<AlertTriangle className="h-4 w-4" />}>
              {!data ? <div className="skeleton h-56" /> : defectTotal > 0 ? <StackedColumnChart columns={defectColumns} legend={defectLegend} height={260} /> : <p className="py-10 text-center text-sm text-muted">No rejected piece on {processName.toLowerCase()} in this period.</p>}
            </Section>
          ) },
          { id: 'c.machineDefectsTable', title: 'Defects of the group, most first', node: (
            <Section title={`${processName}: defects, most first`} hint={`Each defect's rejected pieces over ${periodWords}, on each machine and in all. Tap a defect for the sessions behind it.`} icon={<ClipboardList className="h-4 w-4" />}>
              {!defects ? (
                <div className="skeleton h-48" />
              ) : defects.rows.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted">No rejected piece on {processName.toLowerCase()} in this period.</p>
              ) : (
                <div>
                  <TableFrame>
                  <table className="table-sticky-first w-full text-sm">
                    <thead className="sticky top-0 z-10 bg-white text-left text-[11px] uppercase tracking-wide text-muted shadow-[0_1px_0_0_rgb(226_232_240)] dark:bg-slate-900 dark:shadow-[0_1px_0_0_rgb(30_41_59)]">
                      <tr>
                        <FilterTh filters={defectFilters} column="defect" label="Defect" />
                        {defects.machines.map((m) => (
                          <FilterTh key={m.key} filters={defectFilters} column={`m:${m.key}`} label={m.label.length > 14 ? `${m.label.slice(0, 13)}…` : m.label} className="text-right" />
                        ))}
                        <FilterTh filters={defectFilters} column="total" label="Total" className="text-right" />
                        <FilterTh filters={defectFilters} column="share" label="Share" className="text-right" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {defectFilters.rows.map((d) => (
                        <tr key={d.defectName} className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50" onClick={() => setDrill({ title: `${d.defectName}: rejected pieces`, subtitle: `${processName} · ${periodWords}`, query: { ...pickQuery, defect: d.defectName } })}>
                          {/* Left-aligned like the column, the name in its own direction: an Arabic one is not pushed to the right. */}
                          <td className="whitespace-nowrap px-2 py-1.5 text-left font-medium">
                            <span dir="auto" className="inline-block">{d.defectName}</span>
                          </td>
                          {d.byMachine.map((v, i) => (
                            <td key={defects.machines[i].key} className={cn('px-2 py-1.5 text-right tabular-nums', v === 0 && 'text-muted')}>
                              {num(v)}
                            </td>
                          ))}
                          <td className="px-2 py-1.5 text-right font-semibold tabular-nums">{num(d.pieces)}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums text-muted">{pctStr(pct(d.pieces, defectTotal))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </TableFrame>
                  <FilterNote filters={defectFilters} total={defects.rows.length} />
                </div>
              )}
            </Section>
          ) },
        ]}
      />
      <RawMaterialSection from={general.from} to={general.to} t={t} />
      <DrillModal spec={drill} onClose={() => setDrill(null)} />
    </div>
  )
}

/** A thickness in a filter: millimetres as typed, the empty string for every thickness. */
const thicknessText = (t: number): string => String(Number(t.toFixed(3)))

/** The supplier filter's value for the coils with no supplier recorded. */
const NO_SUPPLIER = '__none__'
/** A few values named, more counted: "1.5 mm + 2 mm", "4 suppliers"; none is the fallback. */
function listWords(values: string[], none: string, noun: string): string {
  if (values.length === 0) return none
  return values.length <= 2 ? values.join(' + ') : `${values.length} ${noun}`
}

/**
 * §15 — Comparisons, roll forming's raw material: the reject rate and PPM by
 * coil supplier and by thickness, one supplier, thickness and material (black
 * or galvanized, from the coil's grade) over the period, and every supplier,
 * thickness and material together in a table; a row of the table puts the
 * trend on it. A slicer of the roll forming machines narrows all of it; the
 * group picked above does not.
 */
function RawMaterialSection({ from, to, t }: { from: string; to: string; t: KpiThresholds }) {
  const { data: allMachines = [] } = useMaster('machines')
  const rollForming = useMemo(() => allMachines.filter((m) => m.process === 'forming' && m.onDashboard !== false).sort((a, b) => byName(a.displayName || a.code, b.displayName || b.code)), [allMachines])
  const [machineCodes, setMachineCodes] = usePersistedState<string[]>('qc-dash:rf-machines', [])
  // The trend's filters each take several values — the same supplier is often typed more than one way. None ticked is every one.
  /** Thicknesses as written (thicknessText). */
  const [thicknesses, setThicknesses] = usePersistedState<string[]>('qc-dash:rf-thicknesses', [])
  const [material, setMaterial] = usePersistedState<MaterialKind | 'all'>('qc-dash:rf-material', 'all')
  /** Suppliers' names; NO_SUPPLIER is the coils with none recorded. */
  const [suppliers, setSuppliers] = usePersistedState<string[]>('qc-dash:rf-suppliers', [])
  const [grain, setGrain] = usePersistedState<KpiGrainChoice>('qc-dash:rf-grain', 'auto')
  /** Coil grades as recorded. */
  const [grades, setGrades] = usePersistedState<string[]>('qc-dash:rf-grades', [])
  const chosen = machineCodes.filter((c) => rollForming.some((m) => m.code.toLowerCase() === c.toLowerCase()))
  const pickedThicknesses = thicknesses.map(Number).filter((v) => Number.isFinite(v) && v > 0)
  const supplierPicks = suppliers.map((v) => (v === NO_SUPPLIER ? '' : v))
  const { data, isFetching } = useKpiMaterials({ from, to, workCenterCodes: chosen, thicknesses: pickedThicknesses, material, suppliers: supplierPicks, grades, grain })
  const periodWords = describeRange({ from, to })
  const scope = chosen.length === 0 ? 'every roll forming machine' : chosen.length === 1 ? (rollForming.find((m) => m.code.toLowerCase() === chosen[0].toLowerCase())?.displayName ?? chosen[0]) : `${chosen.length} roll forming machines`
  const rateTone = (v: number | null) => toneLowIsGood(v, t.defectRateGreen, t.defectRateAmber)
  const bar = (r: { label: string; made: number; productionDefectPieces: number; defectRatePct: number | null }): HBar => ({
    label: r.label,
    sub: `${num(r.made)} made · ${num(r.productionDefectPieces)} rejected`,
    value: r.defectRatePct,
    tone: rateTone(r.defectRatePct),
    text: r.defectRatePct === null ? '—' : `${pctStr(r.defectRatePct)} · ${ppmStr(r.defectRatePct)} PPM`,
  })
  const supplierWords = listWords(supplierPicks.map((v) => v || 'no supplier recorded'), 'every supplier', 'suppliers')
  const thicknessWords = listWords(pickedThicknesses.map((v) => `${thicknessText(v)} mm`), 'Every thickness', 'thicknesses')
  const gradeWords = grades.length ? listWords(grades, '', 'grades') : material === 'all' ? 'black and galvanized' : MATERIAL_KIND_LABEL[material].toLowerCase()
  const trendWhat = `${thicknessWords} · ${gradeWords}${grades.length && material !== 'all' ? ` (${MATERIAL_KIND_LABEL[material].toLowerCase()})` : ''} · ${supplierWords}`
  const selectClass = '!w-auto min-h-[36px] rounded-lg py-1 text-xs font-semibold touch:min-h-[44px]'
  const details = data?.details ?? []
  const filters = useColumnFilters(details, [
    { key: 'supplier', value: (d) => d.supplier || 'No supplier recorded' },
    { key: 'thickness', value: (d) => (d.thickness === null ? '—' : thicknessText(d.thickness)), numeric: true },
    { key: 'grade', value: (d) => d.grade || '—' },
    { key: 'material', value: (d) => MATERIAL_KIND_LABEL[d.material] },
    { key: 'made', value: (d) => num(d.made), numeric: true },
    { key: 'rejected', value: (d) => num(d.productionDefectPieces), numeric: true },
    { key: 'rate', value: (d) => pctStr(d.defectRatePct), numeric: true },
    { key: 'ppm', value: (d) => ppmStr(d.defectRatePct), numeric: true },
  ])
  // A row is followed when the trend reads exactly it: its one supplier, thickness and grade.
  const rowPicked = (d: KpiMaterialDetail) =>
    supplierPicks.length === 1 &&
    supplierPicks[0].toLowerCase() === d.supplier.toLowerCase() &&
    d.thickness !== null &&
    pickedThicknesses.length === 1 &&
    thicknessText(pickedThicknesses[0]) === thicknessText(d.thickness) &&
    grades.length === (d.grade ? 1 : 0) &&
    (grades[0] ?? '').toUpperCase() === d.grade.toUpperCase()
  const pickRow = (d: KpiMaterialDetail) => {
    if (rowPicked(d)) {
      setSuppliers([])
      setThicknesses([])
      setGrades([])
      setMaterial('all')
      return
    }
    setSuppliers([d.supplier === '' ? NO_SUPPLIER : d.supplier])
    setThicknesses(d.thickness === null ? [] : [thicknessText(d.thickness)])
    setGrades(d.grade ? [d.grade] : [])
    setMaterial('all')
  }

  // The trend's four filters: a row under its title from a tablet up; on a phone a Filters button and a sheet holding them, one a line.
  const wide = useMediaQuery(TABLET)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const trendFilterCount = [suppliers.length > 0, thicknesses.length > 0, grades.length > 0, material !== 'all'].filter(Boolean).length
  const trendFilters = (sheet: boolean) => {
    const menu = sheet ? 'w-full !max-w-none justify-between' : undefined
    return (
      <>
        <MultiSelectMenu
          options={(data?.suppliers ?? []).map((r) => ({ value: r.key || NO_SUPPLIER, label: r.label }))}
          selected={suppliers}
          onChange={setSuppliers}
          allLabel="All suppliers"
          noun="suppliers"
          ariaLabel="Suppliers"
          className={menu}
        />
        <MultiSelectMenu
          options={(data?.thicknessOptions ?? []).map((v) => ({ value: thicknessText(v), label: `${thicknessText(v)} mm` }))}
          selected={thicknesses}
          onChange={setThicknesses}
          allLabel="All thicknesses"
          noun="thicknesses"
          ariaLabel="Thicknesses"
          className={menu}
        />
        <MultiSelectMenu
          options={(data?.gradeOptions ?? []).map((g) => ({ value: g, label: g }))}
          selected={grades}
          onChange={setGrades}
          allLabel="All grades"
          noun="grades"
          ariaLabel="Grades"
          className={menu}
        />
        <Select value={material} onChange={(e) => setMaterial(e.target.value as MaterialKind | 'all')} className={sheet ? 'min-h-[44px] rounded-lg py-1 text-xs font-semibold' : selectClass} aria-label="Material">
          <option value="all">Black and galvanized</option>
          <option value="black">Black</option>
          <option value="galvanized">Galvanized</option>
        </Select>
      </>
    )
  }

  return (
    <div className="space-y-3 pt-2">
      <Modal
        open={filtersOpen && !wide}
        onClose={() => setFiltersOpen(false)}
        title="Filters of the trend"
        icon={<SlidersHorizontal className="h-5 w-5" />}
        footer={
          <>
            <Button
              variant="ghost"
              disabled={trendFilterCount === 0}
              onClick={() => {
                setSuppliers([])
                setThicknesses([])
                setGrades([])
                setMaterial('all')
              }}
            >
              Clear
            </Button>
            <Button variant="primary" onClick={() => setFiltersOpen(false)}>
              Done
            </Button>
          </>
        }
      >
        <div className="space-y-2">
          <p className="text-sm text-muted">The trend reads {trendWhat.toLowerCase()}. None ticked is every one.</p>
          <div className="grid gap-2">{trendFilters(true)}</div>
        </div>
      </Modal>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-extrabold tracking-tight">Roll forming: raw material</h2>
        <MultiSelectMenu
          options={rollForming.map((m) => ({ value: m.code, label: m.displayName || m.code, sub: m.factory ?? undefined }))}
          selected={chosen}
          onChange={setMachineCodes}
          allLabel="All roll forming machines"
          noun="machines"
          ariaLabel="Roll forming machines"
        />
        <span className="text-xs text-muted">The reject rate of what the machines made from each coil, {periodWords}. The group picked above does not move it.</span>
      </div>
      <Board
        page="comparisons"
        className={cn('transition-opacity', isFetching && 'opacity-70')}
        widgets={[
          { id: 'c.suppliers', title: 'Roll forming: reject rate by coil supplier', node: (
            <Section title="Reject rate by coil supplier" hint={`Rejected ÷ (produced + rejected) of what ${scope} made from each supplier's coils, with the PPM. A session's pieces are shared among its coils by its samples.`} icon={<Truck className="h-4 w-4" />}>
              {data ? <HorizontalBars rows={data.suppliers.map(bar)} unit="%" /> : <div className="skeleton h-48" />}
            </Section>
          ) },
          { id: 'c.thickness', title: 'Roll forming: reject rate by thickness', node: (
            <Section title="Reject rate by thickness" hint={`The reject rate of what ${scope} made from coils of each thickness, black and galvanized together, with the PPM.`} icon={<Layers className="h-4 w-4" />}>
              {data ? (
                <HorizontalBars
                  rows={data.thicknesses.map((r) => ({
                    ...bar(r),
                    sub: `${num(r.made)} made · black ${pctStr(r.black.defectRatePct)} · galvanized ${pctStr(r.galvanized.defectRatePct)}`,
                  }))}
                  unit="%"
                />
              ) : <div className="skeleton h-48" />}
            </Section>
          ) },
          { id: 'c.thicknessTrend', title: 'Roll forming: one thickness and material over the period', node: (
            <Section
              title={`${trendWhat}: over the period`}
              hint={`Pieces made and the reject rate of ${scope} on ${trendWhat.toLowerCase()}, a point ${data ? GRAIN_WORD[data.trend.grain] : 'a day'}. Black or galvanized is read off the coil's grade.`}
              icon={<Activity className="h-4 w-4" />}
              action={<GrainPicker value={grain} onChange={setGrain} />}
              toolbar={
                wide ? (
                  <div className="flex flex-wrap items-center gap-2">{trendFilters(false)}</div>
                ) : (
                  <button type="button" onClick={() => setFiltersOpen(true)} className="inline-flex min-h-[40px] items-center gap-2 rounded-lg bg-white px-3 text-xs font-semibold ring-1 ring-slate-200 hover:bg-slate-50 dark:bg-slate-900 dark:ring-slate-700 dark:hover:bg-slate-800 touch:min-h-[44px]">
                    <SlidersHorizontal className="h-4 w-4" /> Filters{trendFilterCount > 0 && <span className="rounded-full bg-brand-600 px-1.5 text-[11px] leading-[18px] text-white">{trendFilterCount}</span>}
                  </button>
                )
              }
            >
              {!data ? (
                <div className="skeleton h-56" />
              ) : data.trend.total.made > 0 ? (
                <>
                  <p className="mb-2 text-sm text-muted">
                    Over the period: <span className={cn('font-bold', TONE_TEXT[rateTone(data.trend.total.defectRatePct)])}>{pctStr(data.trend.total.defectRatePct)}</span> · {ppmStr(data.trend.total.defectRatePct)} PPM · {num(data.trend.total.productionDefectPieces)} rejected of {num(data.trend.total.made)} made
                  </p>
                  <TrendChart points={trimmed(data.trend.buckets.map((b, i) => ({ label: bucketLabel(b, data.trend.grain), bar: data.trend.points[i].made, line: data.trend.points[i].defectRatePct })), (p) => p.bar > 0)} barLabel="Pieces made" lineLabel="Reject rate" connectGaps />
                </>
              ) : (
                <p className="py-10 text-center text-sm text-muted">Nothing of {trendWhat.toLowerCase()} was made on {scope} in this period.</p>
              )}
            </Section>
          ) },
          { id: 'c.materialTable', title: 'Roll forming: every supplier, thickness and material', node: (
            <Section title="Every supplier, thickness and grade" hint={`What ${scope} made of each supplier's coils of each thickness and grade (black or galvanized read off the grade), ${periodWords}. Filter a column; tap a row to follow it over the period above, tap it again to let it go.`} icon={<Table2 className="h-4 w-4" />}>
              {!data ? (
                <div className="skeleton h-48" />
              ) : details.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted">Nothing was made on {scope} in this period.</p>
              ) : (
                <div>
                  <TableFrame>
                  <table className="table-sticky-first w-full text-sm">
                    <thead className="sticky top-0 z-10 bg-white text-left text-[11px] uppercase tracking-wide text-muted shadow-[0_1px_0_0_rgb(226_232_240)] dark:bg-slate-900 dark:shadow-[0_1px_0_0_rgb(30_41_59)]">
                      <tr>
                        <FilterTh filters={filters} column="supplier" label="Supplier" />
                        <FilterTh filters={filters} column="thickness" label="Thickness" />
                        <FilterTh filters={filters} column="grade" label="Grade" />
                        <FilterTh filters={filters} column="material" label="Material" />
                        <FilterTh filters={filters} column="made" label="Made" className="text-right" />
                        <FilterTh filters={filters} column="rejected" label="Rejected" className="text-right" />
                        <FilterTh filters={filters} column="rate" label="Reject rate" className="text-right" />
                        <FilterTh filters={filters} column="ppm" label="PPM" className="text-right" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {filters.rows.map((d) => {
                        const on = rowPicked(d)
                        return (
                          <tr
                            key={`${d.supplier}|${d.thickness ?? ''}|${d.grade}`}
                            className={cn('cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50', on && 'bg-brand-50 dark:bg-brand-500/10')}
                            onClick={() => pickRow(d)}
                            aria-selected={on}
                          >
                            {/* The sticky first cell carries the row's own colour, opaque (dark: brand-500 at 10% over slate-900), so a row followed reads as one under the scroll too. */}
                            <td className={cn('min-w-[8rem] px-2 py-1.5 text-left font-medium', on && 'bg-brand-50 dark:bg-[#131d39]')}>
                              <span dir="auto" className="inline-block">{d.supplier || 'No supplier recorded'}</span>
                            </td>
                            <td className="whitespace-nowrap px-2 py-1.5 tabular-nums">{d.thickness === null ? '—' : `${thicknessText(d.thickness)} mm`}</td>
                            <td className="whitespace-nowrap px-2 py-1.5" dir="auto">{d.grade || '—'}</td>
                            <td className="px-2 py-1.5">{MATERIAL_KIND_LABEL[d.material]}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums">{num(d.made)}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums">{num(d.productionDefectPieces)}</td>
                            <td className={cn('px-2 py-1.5 text-right font-semibold tabular-nums', TONE_TEXT[rateTone(d.defectRatePct)])}>{pctStr(d.defectRatePct)}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums">{ppmStr(d.defectRatePct)}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                  </TableFrame>
                  <FilterNote filters={filters} total={details.length} />
                </div>
              )}
            </Section>
          ) },
        ]}
      />
    </div>
  )
}

/** First part released reads high-is-good: 95% and over is green, 85% amber. */
const releasedTone = (v: number | null): KpiTone => (v === null ? 'neutral' : v >= 95 ? 'green' : v >= 85 ? 'amber' : 'red')
/** The cumulative first pass reads the other way: lower is better, zero is clean. */
const cumTone = (v: number | null): KpiTone => (v === null ? 'neutral' : v === 0 ? 'green' : v <= 15 ? 'amber' : 'red')

/** A pick's four headline figures: reject rate, PPM, first part released and its cumulative. Each opens what is behind it. */
function PickTiles({
  title,
  data,
  t,
  fp,
  openRejects,
  openFirstPart,
}: {
  title: string
  data: KpiBreakdown
  t: KpiThresholds
  /** The first part as the tiles read it: the pick's, or the machines ticked for it. */
  fp: KpiFirstPart
  openRejects: (what: string) => void
  openFirstPart: (what: string, qtyFrom: number) => void
}) {
  // The span as a whole, not the months added up: a universal machine's line counts its sheet quantity once in the span.
  const made = data.totals.made
  const rejected = data.totals.productionDefectPieces
  const rate = data.totals.defectRatePct
  return (
    <WidgetBody className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h2 className="min-w-0 break-words text-lg font-extrabold tracking-tight">{title}</h2>
        <p className="text-xs text-muted">{describeRange({ from: data.filters.from, to: data.filters.to })}</p>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <PlainTile label="Reject rate" value={pctStr(rate)} sub={`${num(rejected)} rejected of ${num(made)} made`} icon={<Target className="h-4 w-4" />} tone={toneLowIsGood(rate, t.defectRateGreen, t.defectRateAmber)} onOpen={rejected > 0 ? () => openRejects('Rejected pieces') : undefined} />
        <PlainTile label="PPM" value={ppmStr(rate)} sub="rejected pieces per million made" icon={<AlertTriangle className="h-4 w-4" />} tone={toneLowIsGood(rate, t.defectRateGreen, t.defectRateAmber)} onOpen={rejected > 0 ? () => openRejects('Rejected pieces') : undefined} />
        <PlainTile label="First part released" value={pctStr(fp.pct)} sub={`${num(fp.clean)} of ${num(fp.sessions)} sessions with nothing rejected before release`} icon={<PackageCheck className="h-4 w-4" />} tone={releasedTone(fp.pct)} onOpen={fp.sessions > fp.clean ? () => openFirstPart('Sessions not clean', 1) : undefined} />
        <PlainTile label="First pass released cumulative" value={pctStr(fp.cumulativePct)} sub={`${num(fp.rejectedPieces)} rejected before release ÷ (${num(fp.clean)} clean sessions + ${num(fp.rejectedPieces)}) · lower is better`} icon={<PackageCheck className="h-4 w-4" />} tone={cumTone(fp.cumulativePct)} onOpen={fp.rejectedPieces > 0 ? () => openFirstPart('Pieces rejected before release', 1) : undefined} />
      </div>
    </WidgetBody>
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
  const fpTone: KpiTone = releasedTone(fp.pct)
  // The first part month by month, from the first month with a session to the last.
  const fpLines = trimmedLines(
    fp.months.map((m) => monthLabel(m.month, false)),
    fp.byMachineMonth.slice(0, LINE_CLASSES.length).map((m, i) => ({ label: m.label, values: m.months.map((x) => (x.sessions > 0 ? pct(x.clean, x.sessions) : null)), className: LINE_CLASSES[i] })),
    (i) => fp.months[i].sessions > 0,
  )
  return [
    { id: 'g.tiles', title: 'Reject rate, PPM, first part', labelled: false, node: <PickTiles title={title} data={data} t={t} fp={fp} openRejects={openRejects} openFirstPart={openFirstPart} /> },
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
          <ParetoChart bars={paretoOf(data.defects.map((d) => ({ label: d.defectName, value: d.pieces })))} valueLabel="Pieces" onPick={(label) => openRejects(`${label}: rejected pieces`, { defect: label })} />
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
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">{x.k}</p>
                <p className={cn('mt-1 text-xl font-extrabold tabular-nums', TONE_TEXT[x.tone])}>{x.v}</p>
                <p className="text-xs text-muted">{x.s}</p>
              </div>
            ))}
          </div>
          <div>
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">By month</p>
            {/* From the first month with a session to the last: This year read in October is not eight empty chips before September. */}
            <ul className="flex flex-wrap gap-2 text-xs">
              {trimmed(fp.months, (m) => m.sessions > 0).map((m) => (
                <li key={m.month} className="rounded-lg bg-slate-50 px-2 py-1 dark:bg-slate-800/60">
                  <span className="font-semibold">{monthLabel(m.month, false)}</span>{' '}
                  {m.sessions > 0 ? <><span className={cn('font-semibold', TONE_TEXT[releasedTone(m.pct)])}>{pctStr(m.pct)}</span> <span className="text-muted">{num(m.clean)} ÷ {num(m.sessions)}</span></> : <span className="text-slate-300">—</span>}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Section>
    ) },
    { id: 'g.firstPartChart', title: 'First part: machines by month', node: (
      <Section title="First part released, by machine" hint={`Each machine's clean sessions ÷ all its sessions, month by month; higher is better. ${fpMachines.length ? 'The machines ticked.' : `The ${Math.min(LINE_CLASSES.length, fp.byMachineMonth.length)} machines with the most pieces rejected before release.`}`} icon={<Layers className="h-4 w-4" />} action={fpFilter}>
        <LineChart labels={fpLines.labels} series={fpLines.lines} height={200} />
      </Section>
    ) },
    { id: 'g.firstPartQty', title: 'First part: sessions by pieces rejected', node: (
      <Section title="Sessions by pieces rejected before release" hint="Of the sessions not clean: how many had 1 piece rejected before release, how many 2, and so on. Tap a column for those sessions." icon={<PackageCheck className="h-4 w-4" />} action={fpFilter}>
        {fp.byQty.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">Every session started clean.</p>
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
  if (rows.length === 0) return <p className="py-6 text-center text-sm text-muted">Every session started clean.</p>
  return (
    <>
      <TableFrame>
        <table className="table-sticky-first w-full text-sm">
          <thead className="sticky top-0 z-10 bg-white dark:bg-slate-900">
            <tr className="text-left text-[11px] uppercase tracking-wide text-muted">
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
                <td className="min-w-[8rem] px-2 py-1.5">{r.machineLabel}{r.factory && <span className="ml-1 text-xs text-muted">{r.factory}</span>}</td>
                <td className="min-w-[8rem] px-2 py-1.5 font-semibold" dir="auto">{r.item}</td>
                <td className="whitespace-nowrap px-2 py-1.5 text-xs text-muted">{r.itemCode}</td>
                <td className="px-2 py-1.5 text-right tabular-nums"><span className="font-semibold">{num(r.notClean)}</span> <span className="text-xs text-muted">of {num(r.sessions)}</span></td>
                <td className="px-2 py-1.5 text-right"><Badge tone="red">{num(r.rejectedPieces)} pcs</Badge></td>
                <td className="print-hidden px-2 py-1.5 text-right">
                  <button type="button" onClick={(e) => { e.stopPropagation(); setOpen(r) }} className="whitespace-nowrap text-xs font-semibold text-brand-700 hover:underline dark:text-brand-300 touch:min-h-[44px] touch:px-1">
                    {r.orders.length === 1 ? '1 order' : `${r.orders.length} orders`}
                  </button>
                </td>
              </tr>
            ))}
            {filters.rows.length === 0 && (
              <tr><td colSpan={6} className="py-6 text-center text-sm text-muted">No row matches the filters.</td></tr>
            )}
          </tbody>
        </table>
      </TableFrame>
      <FilterNote filters={filters} total={rows.length} />
      <Modal open={open !== null} onClose={() => setOpen(null)} title={open ? `${open.item} on ${open.machineLabel}` : ''} icon={<PackageCheck className="h-5 w-5" />} size="lg">
        {open && (
          <div className="space-y-3">
            <p className="text-sm text-muted">
              {num(open.notClean)} of {num(open.sessions)} sessions started with pieces already rejected, {num(open.rejectedPieces)} pieces in all. The orders behind them:
            </p>
            <PartOrders orders={open.orders} navigate={navigate} />
          </div>
        )}
      </Modal>
    </>
  )
}

type PartOrder = PartRow['orders'][number]
/** The orders behind a part not clean on a machine, each with its sessions. */
function PartOrders({ orders, navigate }: { orders: PartOrder[]; navigate: (to: string) => void }) {
  const filters = useColumnFilters(orders, [
    { key: 'order', value: (o) => o.orderNumber },
    { key: 'notClean', value: (o) => num(o.notClean), numeric: true },
    { key: 'pieces', value: (o) => `${num(o.rejectedPieces)} pcs`, numeric: true },
  ])
  return (
    <>
      <ScrollX shadows="end">
      <table className="table-sticky-first w-full text-sm">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wide text-muted">
            <FilterTh filters={filters} column="order" label="Order" />
            <FilterTh filters={filters} column="notClean" label="Sessions not clean" className="text-right" />
            <FilterTh filters={filters} column="pieces" label="Rejected before" className="text-right" />
            <th className="px-2 py-1.5 text-right font-semibold">Open</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {filters.rows.map((o) => (
            <tr key={o.orderNumber}>
              <td className="whitespace-nowrap px-2 py-1.5 font-semibold">{o.orderNumber}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{num(o.notClean)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{num(o.rejectedPieces)} pcs</td>
              <td className="px-2 py-1.5 text-right">
                <span className="inline-flex flex-wrap justify-end gap-1">
                  {o.sessionIds.map((id, i) => (
                    <button key={id} type="button" onClick={() => navigate(sessionDetailPath(id))} className="whitespace-nowrap rounded-md bg-brand-50 px-1.5 py-0.5 text-xs font-semibold text-brand-700 hover:bg-brand-100 dark:bg-brand-500/10 dark:text-brand-300 touch:min-h-[44px] touch:px-3">
                      {o.sessionIds.length === 1 ? 'Session' : `Session ${i + 1}`}
                    </button>
                  ))}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </ScrollX>
      <FilterNote filters={filters} total={orders.length} />
    </>
  )
}

type BreakdownRow = KpiBreakdown['byOrder'][number]

/** A summary row's background on a sticky first cell, opaque (dark: slate-800 at 60% over slate-900): the row's own is see-through. */
const SUMMARY_CELL = 'bg-slate-50 dark:bg-[#182234]'

/**
 * Each month's rejected pieces laid on the order lines or the items, filtered like Excel on every column. The largest
 * `maxRows` rows show first, the rest behind "Show all", so a stacked phone page is not a thousand rows long.
 */
function BreakdownTable({
  rows,
  months,
  what,
  t,
  onOpen,
  onOpenMonth,
  maxRows = 12,
}: {
  rows: BreakdownRow[]
  months: KpiBreakdown['months']
  what: 'order' | 'item'
  t: KpiThresholds
  /** A row opens the sessions behind its rejected pieces. */
  onOpen?: (row: BreakdownRow) => void
  onOpenMonth?: (month: string) => void
  maxRows?: number
}) {
  const [showAll, setShowAll] = useState(false)
  const filters = useColumnFilters(rows, [
    { key: 'label', value: (r) => r.label },
    { key: 'sub', value: (r) => (what === 'order' ? (r.sub ?? '') : r.key) },
    { key: 'pieces', value: (r) => String(r.pieces), numeric: true },
    { key: 'made', value: (r) => pctStr(r.pctOfMade, 3), numeric: true },
    { key: 'period', value: (r) => pctStr(r.shareOfPeriodPct), numeric: true },
  ])
  const narrowed = filters.active > 0 || filters.sort !== null
  const cut = !showAll && !narrowed && filters.rows.length > maxRows
  // The months in their order, each with its rows, until `maxRows` rows are shown.
  let room = cut ? maxRows : Number.POSITIVE_INFINITY
  const groups = months
    .map((m) => {
      const inMonth = filters.rows.filter((r) => r.month === m.month)
      const shown = inMonth.slice(0, Math.max(0, room))
      room -= shown.length
      return { month: m, rows: shown, all: inMonth.length }
    })
    .filter((g) => g.rows.length > 0)
  return (
    <div>
      <TableFrame>
      <table className="table-sticky-first w-full text-sm">
        <thead className="sticky top-0 z-10 bg-white dark:bg-slate-900">
          <tr className="text-left text-[11px] uppercase tracking-wide text-muted">
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
                <td className={cn('whitespace-nowrap px-2 py-1.5 font-bold', SUMMARY_CELL)} colSpan={3}>{monthLabel(g.month.month)}</td>
                <td className="px-2 py-1.5 text-right"><ToneCell value={g.month.defectRatePct} tone={toneLowIsGood(g.month.defectRatePct, t.defectRateGreen, t.defectRateAmber)} /></td>
                <td className="whitespace-nowrap px-2 py-1.5 text-right text-xs text-muted">{num(g.month.productionDefectPieces)} of {num(g.month.made)}</td>
              </tr>
              {g.rows.map((r) => (
                <tr key={`${r.month}|${r.key}`} onClick={onOpen && (() => onOpen(r))} className={cn(onOpen && 'cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/60')}>
                  {/* An order number or an item code is one token: never broken over two lines ("RM-34-" / "0"). */}
                  <td className={cn('px-2 py-1.5 font-semibold', what === 'order' ? 'whitespace-nowrap' : 'min-w-[8rem]')} dir="auto">{r.label}</td>
                  <td className={cn('px-2 py-1.5 text-xs text-muted', what === 'order' ? 'min-w-[8rem]' : 'whitespace-nowrap')} dir="auto">{what === 'order' ? r.sub : r.key}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{num(r.pieces)}</td>
                  {/* The rate and, under it, what it is of: said on the table, not only in the tooltip a finger never sees. */}
                  <td className="whitespace-nowrap px-2 py-1.5 text-right font-semibold tabular-nums" data-tip={`${num(r.pieces)} rejected of ${num(r.made)} made by this ${what} in the month`}>
                    {pctStr(r.pctOfMade, 3)}
                    <span className="block text-[11px] font-normal text-muted">
                      {num(r.pieces)} of {num(r.made)}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-muted">{pctStr(r.shareOfPeriodPct)}</td>
                </tr>
              ))}
            </Fragment>
          ))}
          {groups.length === 0 && (
            <tr><td colSpan={5} className="py-6 text-center text-sm text-muted">{rows.length === 0 ? 'No rejected piece in these months.' : 'No row matches the filters.'}</td></tr>
          )}
        </tbody>
      </table>
      </TableFrame>
      <FilterNote filters={filters} total={rows.length} />
      {!narrowed && filters.rows.length > maxRows && (
        <button type="button" onClick={() => setShowAll((v) => !v)} className="print-hidden mt-2 text-xs font-semibold text-brand-700 hover:underline dark:text-brand-300 touch:min-h-[44px] touch:px-1">
          {showAll ? 'Show fewer' : `Show all ${filters.rows.length}`}
        </button>
      )}
    </div>
  )
}

/**
 * Each defect's rejected pieces month by month and its share of the month's, filtered like Excel on the defect and
 * its total. Only the months that made anything have a column: This year read in October opens on September and
 * October, not on eight empty columns with the figures off to the right.
 */
function DefectsByMonthTable({ data, rejected, rate, onOpen }: { data: KpiBreakdown; rejected: number; rate: number | null; onOpen?: (defect: string | null, month: string | null) => void }) {
  /** A cell with pieces opens the sessions behind them. */
  const opens = (defect: string | null, month: string | null, pieces: number): { onClick?: () => void; className: string } =>
    onOpen && pieces > 0 ? { onClick: () => onOpen(defect, month), className: 'cursor-pointer hover:bg-brand-50 dark:hover:bg-brand-500/10' } : { className: '' }
  const months = data.months.filter((m) => m.made > 0 || m.productionDefectPieces > 0)
  const filters = useColumnFilters(data.defects, [
    { key: 'defect', value: (d) => d.defectName },
    // Each month's pieces of the defect, a column of its own.
    ...months.map((m) => ({ key: `m:${m.month}`, value: (d: (typeof data.defects)[number]) => num(d.months.find((x) => x.month === m.month)?.pieces ?? 0), numeric: true })),
    { key: 'total', value: (d) => String(d.pieces), numeric: true },
  ])
  if (data.defects.length === 0) return <p className="py-6 text-center text-sm text-muted">No rejected piece in these months.</p>
  const shown = filters.active > 0 || filters.sort ? filters.rows : filters.rows.slice(0, 15)
  return (
    <div>
      <TableFrame>
      <table className="table-sticky-first w-full text-sm">
        <thead className="sticky top-0 z-10 bg-white dark:bg-slate-900">
          <tr className="text-left text-[11px] uppercase tracking-wide text-muted">
            <FilterTh filters={filters} column="defect" label="Defect" />
            {months.map((m) => <FilterTh key={m.month} filters={filters} column={`m:${m.month}`} label={monthLabel(m.month, false)} className="text-right" />)}
            <FilterTh filters={filters} column="total" label="Total" className="text-right" />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          <tr className="bg-slate-50 font-semibold dark:bg-slate-800/60">
            <td className={cn('whitespace-nowrap px-2 py-1.5', SUMMARY_CELL)}>All rejected · rate</td>
            {months.map((m) => {
              const o = opens(null, m.month, m.productionDefectPieces)
              return <td key={m.month} onClick={o.onClick} className={cn('whitespace-nowrap px-2 py-1.5 text-right tabular-nums', o.className)}>{m.made > 0 ? <>{num(m.productionDefectPieces)} <span className="text-xs text-muted">{pctStr(m.defectRatePct)}</span></> : <span className="text-slate-300">—</span>}</td>
            })}
            <td onClick={opens(null, null, rejected).onClick} className={cn('whitespace-nowrap px-2 py-1.5 text-right tabular-nums', opens(null, null, rejected).className)}>{num(rejected)} <span className="text-xs text-muted">{pctStr(rate)}</span></td>
          </tr>
          {shown.map((d) => (
            <tr key={d.defectName}>
              <td onClick={opens(d.defectName, null, d.pieces).onClick} className={cn('min-w-[7rem] px-2 py-1.5 text-left', opens(d.defectName, null, d.pieces).className)}><span dir="auto" className="inline-block font-medium">{d.defectName}</span></td>
              {months.map((month) => {
                const m = d.months.find((x) => x.month === month.month) ?? { month: month.month, pieces: 0 }
                const o = opens(d.defectName, m.month, m.pieces)
                return <td key={m.month} onClick={o.onClick} className={cn('whitespace-nowrap px-2 py-1.5 text-right tabular-nums', o.className)}>{m.pieces > 0 ? <>{num(m.pieces)} <span className="text-xs text-muted">{pctStr(pct(m.pieces, month.productionDefectPieces))}</span></> : <span className="text-slate-300">—</span>}</td>
              })}
              <td onClick={opens(d.defectName, null, d.pieces).onClick} className={cn('whitespace-nowrap px-2 py-1.5 text-right font-semibold tabular-nums', opens(d.defectName, null, d.pieces).className)}>{num(d.pieces)} <span className="text-xs font-normal text-muted">{pctStr(d.sharePct)}</span></td>
            </tr>
          ))}
          {shown.length === 0 && (
            <tr><td colSpan={months.length + 2} className="py-6 text-center text-sm text-muted">No row matches the filters.</td></tr>
          )}
        </tbody>
      </table>
      </TableFrame>
      <FilterNote filters={filters} total={data.defects.length} />
    </div>
  )
}

/** One card per machine of the selection: the rate, its trend, and the pieces behind it. */
function MachineCards({ rows, previous, t, onPick }: { rows: KpiGroupRow[]; previous: KpiGroupRow[]; t: KpiThresholds; onPick: (code: string) => void }) {
  if (rows.length === 0) return <p className="py-6 text-center text-sm text-muted">No machine inspected in this period.</p>
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
                  <p className="line-clamp-2 break-words font-bold leading-snug">{m.label}</p>
                  {m.sub && <p className="truncate text-xs text-muted">{m.sub}</p>}
                </div>
                {/* The change, and under it what it is against: on the card, where a finger can read it. */}
                <span className="flex shrink-0 flex-col items-end text-right text-xs" data-tip={prev ? `Was ${pctStr(prev.defectRatePct)} in the comparison period` : 'Nothing in the comparison period'}>
                  <span className={cn('inline-flex items-center gap-0.5 font-semibold tabular-nums', delta === null ? 'text-muted' : flat ? 'text-muted' : up ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400')}>
                    {delta === null ? <Minus className="h-3 w-3" /> : flat ? <Minus className="h-3 w-3" /> : up ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
                    {delta === null ? 'new' : flat ? 'flat' : `${Math.abs(delta).toFixed(2)}%`}
                  </span>
                  <span className="text-[11px] tabular-nums text-muted">{prev ? `was ${pctStr(prev.defectRatePct)}` : 'none before'}</span>
                </span>
              </div>
              <p className={cn('mt-1 text-2xl font-extrabold tabular-nums tracking-tight', TONE_TEXT[tone])}>
                {pctStr(m.defectRatePct)}
                <span className="ml-1 text-xs font-semibold text-muted">defect rate</span>
              </p>
              <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
                <div><dt className="text-muted">Produced</dt><dd className="font-semibold tabular-nums">{m.piecesProduced === null ? '—' : num(produced)}</dd></div>
                <div><dt className="text-muted">Released</dt><dd className="font-semibold tabular-nums text-emerald-700 dark:text-emerald-300">{m.piecesProduced === null ? '—' : num(Math.max(0, produced - defective))}</dd></div>
                <div><dt className="text-muted">Defective</dt><dd className="font-semibold tabular-nums text-rose-600 dark:text-rose-400">{m.piecesProduced === null ? num(m.defectPieces) : num(defective)}</dd></div>
              </dl>
              <p className="mt-1.5 text-[11px] text-muted">{num(m.pieces)} inspected in {num(m.samples)} samples · {pctStr(m.inspectedDefectPct)} of inspected</p>
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
  const { role, can, factoryTimeZone } = useAuth()
  const navigate = useNavigate()
  const allowed = can('view-dashboard')
  const [f, setF] = usePersistedState<DashFilters>('qc-dash:filters', DEFAULT_FILTERS)
  const patch = (p: Partial<DashFilters>) => setF((prev) => ({ ...DEFAULT_FILTERS, ...prev, ...p }))

  // The presets count factory days (08:00 to 08:00) in the factory's zone: at 02:00 "today" is still the night shift's day.
  const range = useMemo(() => {
    const custom = f.customFrom && f.customTo && f.customFrom <= f.customTo ? { from: f.customFrom, to: f.customTo } : undefined
    return presetRange(f.preset, new Date(), custom, factoryTimeZone)
  }, [f.preset, f.customFrom, f.customTo, factoryTimeZone])
  const prev = useMemo(() => compareRange(range, f.compare, isMonthAligned(range)), [range, f.compare])
  /** The comparison period on a KPI card: "▲ 2.10% vs Sep 1 – Sep 30". */
  const prevShort = shortRange(prev)

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
  /** The details' filters in their sheet, on a phone. */
  const [filtersOpen, setFiltersOpen] = useState(false)
  /** The ones this person put away: hidden on every device until shown again. */
  const [hiddenOpen, setHiddenOpen] = useState(false)
  const { data: hiddenState } = useHiddenInsights(allowed)
  // §15 — the board's layout: the fixed default for everyone, or an administrator's own arrangement, made here.
  const { data: layoutState } = useDashboardLayout(allowed)
  const canArrange = can('manage-configuration')
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
  const [chosenView, setView] = usePersistedState<'general' | 'inspectors'>('qc-dash:tab', 'general')
  // The Inspectors tab is an administrator's: a viewer has the general one only, whatever this device last showed.
  const canRank = can('view-inspector-ranking')
  const view = canRank ? chosenView : 'general'
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
  const { data: registered = [] } = useMaster('machines', undefined, allowed)
  // The dashboard offers and counts only the machines it is set to count; the others are named under its figures.
  const machines = useMemo(() => registered.filter((m) => m.onDashboard !== false), [registered])
  const leftOut = useMemo(() => registered.filter((m) => m.onDashboard === false).sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true })), [registered])
  const { data: users = [] } = useUserDirectory(allowed)
  const { data: span } = useKpiSpan(allowed)
  // How much room there is: the boards stacked (no grid to arrange), a phone, the smallest phones.
  const { ref: pageRef, stacked } = useBoardsStacked()
  const phone = useMediaQuery(PHONE)
  const narrowPhone = useMediaQuery(NARROW_PHONE)

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
    const recorded = new Map((data?.inspectors ?? []).map((r) => [r.inspectorId, r.name]))
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
    else if (link.kind === 'session') navigate(sessionDetailPath(link.value))
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
  // From the first day with a sample to the last (a day between them without one stays, as a gap), and the same
  // days a week a bar — Monday to Sunday — for a chart too narrow for a bar a day.
  const { dailyPoints, weeklyPoints } = useMemo(() => {
    if (!data) return { dailyPoints: [], weeklyPoints: [] }
    const byDay = new Map(data.daily.map((d) => [d.day, d]))
    const all: { day: string; total: number; part: number }[] = []
    for (let day = data.filters.from; day <= data.filters.to && all.length < 400; day = addDays(day, 1)) {
      const d = byDay.get(day)
      all.push({ day, total: d?.pieces ?? 0, part: d?.defectPieces ?? 0 })
    }
    const days = trimmed(all, (d) => d.total > 0 || d.part > 0)
    const weeks = runsOf(days.length, (i) => fromDay(days[i].day).getDay() === 1).map(({ from, to }) => {
      const run = days.slice(from, to)
      const first = run[0].day
      const last = run[run.length - 1].day
      return { label: first === last ? shortDay(first) : `${shortDay(first)} – ${shortDay(last)}`, total: run.reduce((n, d) => n + d.total, 0), part: run.reduce((n, d) => n + d.part, 0) }
    })
    return { dailyPoints: days.map((d) => ({ label: shortDay(d.day), total: d.total, part: d.part })), weeklyPoints: weeks }
  }, [data])
  const cur = data?.current
  const prevT = data?.previous
  // Every Hold behind the filters, as the server counts them: the Holds list is only the oldest fifty.
  const onHold = data ? holdTile(data.holdTotals) : null
  const attention = visibleInsights.filter((i) => i.severity === 'critical' || i.severity === 'warning').length
  // What the page reads, said once behind the (i) and printed on paper.
  const about =
    view === 'general' && pick !== 'details'
      ? `${describeRange(range)} · reject rate = rejected ÷ (produced + rejected) · trend over ${general ? windowLength(general) : 'the last months'}`
      : `${describeRange(range)} compared with ${describeRange(prev)}${activeFilters.length > 0 ? ` · ${activeFilters.join(' · ')}` : ''}`

  // The details' seven filters: in their card from 640 px, in a sheet on a phone. One a line in the sheet, so each
  // says what it holds in full; two from 440 px, three from a tablet, four from 1280 so each select reads in full,
  // and all seven in one row from 1536.
  const filterFields = (
    <div className="grid grid-cols-1 gap-3 min-[440px]:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-7">
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
  )

  // The page's actions: on the period's line on a phone and beside the inspector ranking; from a tablet up on the general page at the end of the second row, so the first holds the period whole.
  const pageActions = (
    <>
      {data && (
        <button
          type="button"
          onClick={() => setInsightsOpen(true)}
          className={cn(
            'relative grid h-9 w-9 place-items-center rounded-lg ring-1 transition-colors touch:h-11 touch:w-11',
            attention > 0 ? 'bg-amber-50 text-amber-700 ring-amber-200 hover:bg-amber-100 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-500/30' : 'bg-emerald-50 text-emerald-700 ring-emerald-200 hover:bg-emerald-100 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-500/30',
          )}
          aria-label={`Insights, ${visibleInsights.length} ${visibleInsights.length === 1 ? 'note' : 'notes'}${hiddenInsights.length ? `, ${hiddenInsights.length} hidden` : ''}`}
          data-tip="Insights: what the numbers say"
        >
          <Lightbulb className="h-4 w-4" />
          <span className={cn('absolute -right-1.5 -top-1.5 grid min-w-[18px] place-items-center rounded-full px-1 text-[10px] font-bold leading-[18px] text-white ring-2 ring-white dark:ring-slate-900', attention > 0 ? 'bg-rose-600' : 'bg-emerald-600')}>
            {attention > 0 ? attention : '✓'}
          </span>
        </button>
      )}
      {/* Offered where there is a grid to arrange: a stacked board (a phone, a tablet upright) has nothing to drag. */}
      {canArrange && view === 'general' && !editingLayout && !stacked && (
        <button type="button" onClick={startArranging} aria-label="Arrange the charts" data-tip="Arrange the charts" className="grid h-9 w-9 place-items-center rounded-lg text-muted ring-1 ring-slate-200 transition-colors hover:bg-white hover:text-slate-700 dark:ring-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200 touch:h-11 touch:w-11">
          <LayoutDashboard className="h-4 w-4" />
        </button>
      )}
      <button type="button" onClick={() => void refetch()} disabled={isFetching} aria-label="Refresh" data-tip="Refresh the figures" className="grid h-9 w-9 place-items-center rounded-lg text-muted ring-1 ring-slate-200 transition-colors hover:bg-white hover:text-slate-700 disabled:opacity-60 dark:ring-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200 touch:h-11 touch:w-11">
        <RefreshCw className={cn('h-4 w-4', isFetching && 'animate-spin')} />
      </button>
      <ExportMenu
        items={[
          { label: 'Excel workbook', onClick: exportExcel, disabled: !data, icon: <FileSpreadsheet className="h-4 w-4" /> },
          { label: 'PDF (print)', onClick: () => window.print(), disabled: !data, icon: <Printer className="h-4 w-4" /> },
        ]}
      />
    </>
  )

  return (
    <BoardContext.Provider value={boardState}>
    <PeriodBadgeContext.Provider value={shortRange(range)}>
      {canArrange && editingLayout && <ChartGallery open={galleryOpen} onClose={() => setGalleryOpen(false)} />}
      <DrillModal spec={detailDrill} onClose={() => setDetailDrill(null)} />
    <div ref={pageRef} className="space-y-5">
      {editingLayout && (
        <div className="print-hidden rounded-xl border border-brand-300 bg-brand-50 px-4 py-2 text-sm text-brand-800 dark:border-brand-500/40 dark:bg-brand-500/10 dark:text-brand-100">
          {stacked
            ? 'The charts are arranged on a screen at least 1,024 px wide; here they are stacked in their order. Widen the window, or turn the tablet on its side, to drag them. Charts, Save, Default and Cancel still work.'
            : 'Arranging your own dashboard: drag a chart by its blue bar, pull its bottom-right corner to size it. Save keeps it for you only; everyone else keeps the default. Default puts the default back on yours.'}
        </div>
      )}
      {/* One row: the view, the period with its presets, and the page's actions as icons. What the page reads is behind the (i). */}
      <div className="hidden print:block">
        <h1 className="text-2xl font-extrabold tracking-tight">Quality dashboard</h1>
        <p className="mt-1 text-sm text-muted">{about}</p>
        {general && view === 'general' && pick !== 'details' && (
          <p className="text-sm text-muted">
            Generated <When iso={general.generatedAt} time />
          </p>
        )}
        {data && !(view === 'general' && pick !== 'details') && (
          <p className="text-sm text-muted">
            Generated <When iso={data.generatedAt} time />
          </p>
        )}
      </div>
      <div className="print-hidden">
        <PeriodSlicer
          value={range}
          preset={f.preset}
          firstDay={span?.firstDay ?? null}
          onChange={(next, preset) => patch({ preset, customFrom: next.from, customTo: next.to })}
          leading={
            <>
              {canRank && (
                <Segmented
                  iconsWhenTight
                  label="Dashboard view"
                  value={view}
                  onChange={setView}
                  options={[
                    { value: 'general', label: 'General', icon: <Factory className="h-4 w-4" /> },
                    { value: 'inspectors', label: 'Inspectors', icon: <Trophy className="h-4 w-4" /> },
                  ]}
                />
              )}
              <InfoTip text={about} label="What this page reads" />
            </>
          }
          trailing={phone || view !== 'general' ? pageActions : undefined}
        />
      </div>
      {canArrange && view === 'general' && editingLayout && (
        <div className="print-hidden flex flex-wrap items-center gap-2">
          <Button className="min-h-[40px]" onClick={() => setGalleryOpen(true)} aria-label="Choose the charts shown">
            <LayoutGrid className="h-4 w-4" /> Charts
          </Button>
          <Button variant="primary" className="min-h-[40px]" onClick={() => void saveArrangement()} aria-label="Save the layout for you">
            <Save className="h-4 w-4" /> Save layout
          </Button>
          <Button className="min-h-[40px]" onClick={() => void resetArrangement()} aria-label="Back to the default layout">
            <Undo2 className="h-4 w-4" /> Default
          </Button>
          <Button className="min-h-[40px]" onClick={stopArranging} aria-label="Stop arranging without saving">
            <X className="h-4 w-4" /> Cancel
          </Button>
        </div>
      )}

      {/* §15 — the second row, under the period: on the general page the angle to read it from and, by factory, the
          factories picked; at its end the page's actions (on a phone they stay on the period's line) and Reset, all one
          height. Then the filters of the details, then the plant and its factories. */}
      {view === 'general' && (
        <div className="print-hidden flex flex-wrap items-center gap-2">
          <Segmented
            label="Read it"
            value={pick}
            onChange={setPick}
            options={[
              { value: 'factory', label: narrowPhone ? 'Factory' : 'By factory', icon: narrowPhone ? undefined : <Factory className="h-4 w-4" /> },
              { value: 'process', label: narrowPhone ? 'Compare' : 'Comparisons', icon: narrowPhone ? undefined : <Layers className="h-4 w-4" /> },
              { value: 'details', label: 'Details', icon: narrowPhone ? undefined : <LayoutGrid className="h-4 w-4" /> },
            ]}
          />
          {pick === 'details' && <InfoTip text="The full analysis: the filters below narrow it." label="About the details" />}
          {general && pick === 'factory' && (
            <>
              <span aria-hidden className="mx-1 hidden h-6 w-px bg-slate-200 dark:bg-slate-700 sm:block" />
              {/* On a phone the factories take a line of their own, under the switch. */}
              <div className="order-last min-w-0 basis-full sm:order-none sm:basis-auto">
                <ScopeChips kind="factory" general={general} factories={factories} picks={picks} setPicks={setPicks} />
              </div>
            </>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {!phone && pageActions}
            <button type="button" onClick={resetAll} disabled={!anythingSet} aria-label="Reset all filters and picks" data-tip="Reset all filters and picks" className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-muted ring-1 ring-slate-200 transition-colors hover:bg-white hover:text-slate-700 disabled:opacity-40 disabled:hover:bg-transparent dark:ring-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200 touch:h-11 touch:w-11">
              <RotateCcw className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* Filters — for the details and the inspector ranking. On a phone a Filters button and a sheet holding them, the filters in force as chips under it. */}
      <Card className={cn('print-hidden space-y-3 p-4', !showDetails && 'hidden')}>
        {phone ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <button type="button" onClick={() => setFiltersOpen(true)} className="inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-white px-3 text-sm font-semibold ring-1 ring-slate-200 hover:bg-slate-50 dark:bg-slate-900 dark:ring-slate-700 dark:hover:bg-slate-800">
              <SlidersHorizontal className="h-4 w-4" /> Filters
              {activeFilters.length > 0 && <span className="rounded-full bg-brand-600 px-1.5 text-[11px] leading-[18px] text-white">{activeFilters.length}</span>}
            </button>
            <span className="text-xs text-muted">vs {COMPARE_PRESETS.find((p) => p.key === f.compare)?.label.toLowerCase() ?? 'the period before'}</span>
          </div>
        ) : (
          filterFields
        )}
        {activeFilters.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {activeFilters.map((a) => (
              <Badge key={a} tone="blue">
                {a}
              </Badge>
            ))}
            <button type="button" onClick={() => patch({ factory: '', process: '', workCenterCode: '', itemCode: '', inspectorId: '', shift: '' })} className="inline-flex items-center gap-1 text-xs font-semibold text-muted hover:text-rose-600 touch:min-h-[44px] touch:px-1">
              <X className="h-3.5 w-3.5" /> Clear filters
            </button>
            <button type="button" onClick={resetAll} className="inline-flex items-center gap-1 text-xs font-semibold text-muted hover:text-rose-600 touch:min-h-[44px] touch:px-1">
              <RotateCcw className="h-3.5 w-3.5" /> Reset all
            </button>
          </div>
        )}
      </Card>
      <Modal open={filtersOpen && phone} onClose={() => setFiltersOpen(false)} title="Filters" icon={<SlidersHorizontal className="h-5 w-5" />} footer={<Button variant="primary" onClick={() => setFiltersOpen(false)}>Done</Button>}>
        {filterFields}
      </Modal>

      {/* §15 — the general page: the plant and its factories on three figures, then the angle picked above. */}
      {view === 'general' && (
        <>
          <GeneralOverview data={general ?? null} loading={generalLoading} error={generalError instanceof ApiError ? generalError.message : generalError ? 'The general page could not be loaded.' : null} leftOut={leftOut} />
          {general && pick === 'factory' && <ScopeView kind="factory" general={general} factories={factories} t={general.thresholds} picks={picks} setPicks={setPicks} />}
          {/* The pick keeps its stored key, 'process', so a device that read By process opens on Comparisons. */}
          {general && pick === 'process' && <ComparisonsView general={general} t={general.thresholds} />}
        </>
      )}

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
          <Section title="Insights" period={null} hint="What the numbers say, by rule, not by guess. Most serious first." icon={<Sparkles className="h-4 w-4" />} className="hidden print:block">
            <InsightList insights={visibleInsights} onLink={onLink} />
          </Section>
          {insightsOpen && (
            <Modal open onClose={() => setInsightsOpen(false)} size="xl" icon={<Lightbulb className="h-5 w-5" />} title={<span>Insights <span className="ml-2 text-sm font-semibold text-muted">{describeRange(range)}</span></span>}>
              <p className="mb-3 text-sm text-muted">What the numbers say, by rule, not by guess. Most serious first. Read one? Hide it and it stays hidden for you, on every device, until you show it again.</p>
              {visibleInsights.length > 0 ? (
                <InsightList insights={visibleInsights} onLink={(l) => { setInsightsOpen(false); onLink(l) }} onHide={(k) => void onHide(k)} />
              ) : (
                <p className="rounded-xl border border-dashed border-slate-200 py-6 text-center text-sm text-muted dark:border-slate-700">
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
<WidgetBody>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            {/* Defect pieces per 100 produced, over the sessions closed in the period with a final quantity. */}
            <KpiTile vs={prevShort}
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
            <KpiTile vs={prevShort} label="First-pass yield" value={pctStr(cur.fpyPct)} current={cur.fpyPct} previous={prevT.fpyPct} goodWhen="up" tone={toneHighIsGood(cur.fpyPct, t.fpyGreen, t.fpyAmber)} sub={`samples with no defect · ${num(cur.samples)} samples · target ≥ ${t.fpyGreen}%`} icon={<Target className="h-4 w-4" />} />
            <KpiTile vs={prevShort} label="Dimensions out of tolerance" value={pctStr(cur.dimFailPct)} current={cur.dimFailPct} previous={prevT.dimFailPct} goodWhen="down" tone={toneLowIsGood(cur.dimFailPct, t.dimFailGreen, t.dimFailAmber)} sub={`${num(cur.dimensionsFail)} fail · ${num(cur.dimensionsWarning)} warning of ${num(cur.dimensionsMeasured)} measured`} icon={<Ruler className="h-4 w-4" />} />
            <KpiTile vs={prevShort} label="Pieces inspected" value={num(cur.pieces)} current={cur.pieces} previous={prevT.pieces} goodWhen="up" sub={`${num(cur.samples)} samples · ${num(cur.samplesPerSession, 1)} per session · ${pctStr(cur.inspectedDefectPct)} defective of inspected`} icon={<ClipboardList className="h-4 w-4" />} />
            <KpiTile vs={prevShort} label="Sessions" value={num(cur.sessions)} current={cur.sessions} previous={prevT.sessions} goodWhen="none" sub={`${num(cur.sessionsClosed)} closed · ${num(cur.machinesInspected)} machines · ${num(cur.activeInspectors)} inspectors`} icon={<Users className="h-4 w-4" />} />
            <KpiTile period="Now" label="On Hold now" value={num(onHold?.defects ?? 0)} current={null} previous={null} goodWhen="down" tone={onHold?.tone ?? 'green'} sub={`${num(onHold?.pieces ?? 0)} pieces waiting for a disposition`} icon={<PauseCircle className="h-4 w-4" />} />
          </div>
</WidgetBody>
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
              <TrendChart points={trimmed(data.monthly.map((m) => ({ label: monthLabel(m.month, false), bar: m.piecesProduced, line: m.defectRatePct })), (p) => p.bar > 0 || p.line !== null)} barLabel="Pieces produced" lineLabel="Defect rate" />
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
                  { key: 'd', label: 'Defect', text: (r) => r.defectName, render: (r) => <span dir="auto" className="font-semibold">{r.defectName}</span> },
                  { key: 'p', label: 'Pieces', className: 'text-right tabular-nums font-semibold', render: (r) => num(r.pieces) },
                  { key: 'r', label: 'Records', className: 'text-right tabular-nums', render: (r) => num(r.records) },
                  { key: 'days', label: 'Days seen', className: 'text-right tabular-nums', render: (r) => num(r.days) },
                  { key: 'orders', label: 'Orders', className: 'text-right tabular-nums', render: (r) => num(r.orders) },
                  {
                    key: 'share',
                    label: 'Share',
                    className: 'w-40',
                    text: (r) => pctStr(r.sharePct),
                    sortNum: (r) => r.sharePct,
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
              <PairedBarChart points={dailyPoints} weekly={weeklyPoints} totalLabel="Pieces inspected" partLabel="Defect pieces" />
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
                  <Select value={paretoMachine} onChange={(e) => setParetoMachine(e.target.value)} className="print-hidden min-h-[40px] min-w-0 sm:!w-auto sm:max-w-[16rem] touch:min-h-[44px]" aria-label="Pareto for machine">
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
                valueLabel="Pieces"
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
                  { key: 'item', label: 'Item', text: (r) => `${r.itemCode} ${r.item}`, render: (r) => (<span className="font-semibold">{r.itemCode}<span className="ml-1 text-xs font-normal text-muted">{r.item}</span></span>) },
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
                { key: 'item', label: 'Item', text: (r) => `${r.itemCode} ${r.item}`, render: (r) => (<span className="font-semibold">{r.itemCode}<span className="ml-1 text-xs font-normal text-muted">{r.item}</span></span>) },
                { key: 'defect', label: 'Defect', text: (r) => r.defectName, render: (r) => <span dir="auto">{r.defectName}</span> },
                { key: 'mc', label: 'Machine', render: (r) => r.machineLabel },
                { key: 'pcs', label: 'Pieces', className: 'text-right tabular-nums', render: (r) => num(r.pieces) },
                { key: 'rec', label: 'Records', className: 'text-right tabular-nums', render: (r) => num(r.records) },
                { key: 'share', label: 'Of item', className: 'text-right', text: (r) => pctStr(r.sharePct), sortNum: (r) => r.sharePct, render: (r) => <span className="font-semibold tabular-nums">{pctStr(r.sharePct)}</span> },
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
                  <Button className="print-hidden min-h-[40px] touch:min-h-[44px]" onClick={() => navigate('/history?disposition=Hold')}>
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
                    onClick: () => navigate(sessionDetailPath(h.sessionId)),
                  }))}
              />
            </Section>
              ) },
              { id: 'd.tableMachine', title: 'By machine (table)', node: (
            <Section title="By machine" icon={<Activity className="h-4 w-4" />}>
              <Table rows={data.byMachine} total={data.counts.machines} rowKey={(r) => r.key} maxRows={10} columns={groupColumns(t, { key: 'k', label: 'Machine', text: (r) => r.label, render: (r) => (<span className="font-semibold">{r.label}{r.sub && <span className="ml-1 text-xs font-normal text-muted">{r.sub}</span>}</span>) })} />
            </Section>
              ) },
              { id: 'd.tableInspector', title: 'By inspector (table)', node: (
            <Section title="By inspector" icon={<Users className="h-4 w-4" />}>
              <Table rows={data.byInspector} total={data.counts.inspectors} rowKey={(r) => r.key} maxRows={10} columns={groupColumns(t, { key: 'k', label: 'Inspector', text: (r) => r.label, render: (r) => <span className="font-semibold">{r.label}</span> })} />
            </Section>
              ) },
              { id: 'd.tableShift', title: 'By shift (table)', node: (
            <Section title="By shift" icon={<Users className="h-4 w-4" />}>
              <Table rows={data.byShift} rowKey={(r) => r.key} columns={groupColumns(t, { key: 'k', label: 'Shift', text: (r) => `${r.label} ${shiftName(r.key as ShiftLetter)}`, render: (r) => (<span className="font-semibold">{r.label} <span className="text-xs font-normal text-muted">{shiftName(r.key as ShiftLetter)}</span></span>) })} />
            </Section>
              ) },
              { id: 'd.tableItem', title: 'By item (table)', node: (
            <Section title="By item" icon={<ClipboardList className="h-4 w-4" />}>
              <Table rows={data.byItem} total={data.counts.items} rowKey={(r) => r.key} maxRows={10} columns={groupColumns(t, { key: 'k', label: 'Item', text: (r) => `${r.label} ${r.key}`, render: (r) => (<span className="font-semibold">{r.label}<span className="ml-1 text-xs font-normal text-muted">{r.key}</span></span>) })} />
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
                  { key: 's', label: 'Supplier', text: (s) => s.supplier, render: (s) => <span className="font-semibold">{s.supplier}</span> },
                  { key: 'g', label: 'Grade', render: (s) => s.grade },
                  { key: 'n', label: 'Samples', className: 'text-right tabular-nums', render: (s) => num(s.samples) },
                  { key: 'p', label: 'Pieces', className: 'text-right tabular-nums', render: (s) => num(s.pieces) },
                  { key: 'd', label: 'Defect pcs', className: 'text-right tabular-nums', render: (s) => num(s.defectPieces) },
                  { key: 'r', label: 'Of inspected', className: 'text-right', text: (s) => pctStr(s.inspectedDefectPct), sortNum: (s) => s.inspectedDefectPct, render: (s) => <ToneCell value={s.inspectedDefectPct} tone="neutral" /> },
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
                  <Button className="print-hidden min-h-[40px] touch:min-h-[44px]" onClick={() => navigate('/history?disposition=Hold')}>
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
                sticky={false}
                empty="Nothing on Hold. Good."
                columns={[
                  { key: 'age', label: 'Age', className: 'text-right', text: (h) => `${h.ageDays} d`, sortNum: (h) => h.ageDays, render: (h) => <Badge tone={h.ageDays >= t.holdAgeRedDays ? 'red' : h.ageDays >= t.holdAgeAmberDays ? 'amber' : 'neutral'}>{h.ageDays} d</Badge> },
                  { key: 'o', label: 'Order', text: (h) => h.orderNumber, render: (h) => <span className="whitespace-nowrap font-semibold">{h.orderNumber}</span> },
                  { key: 'i', label: 'Item', render: (h) => h.item },
                  { key: 'm', label: 'Machine', render: (h) => h.workCenterCode },
                  { key: 'd', label: 'Defect', render: (h) => h.defectName },
                  { key: 'q', label: 'Qty', className: 'text-right tabular-nums', render: (h) => num(h.qty) },
                  { key: 'go', label: '', className: 'print-hidden text-right', filterable: false, render: (h) => (<button type="button" onClick={() => navigate(sessionDetailPath(h.sessionId))} className="text-xs font-semibold text-brand-700 hover:underline dark:text-brand-300 touch:-my-2 touch:min-h-[44px] touch:px-2">Session</button>) },
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
                  <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted">{x.k}</dt>
                  <dd className="mt-1 text-xl font-bold tabular-nums">{x.v}</dd>
                  <dd className="text-xs text-muted">{x.s}</dd>
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
          {data.inspectorRanking && (
            <Section
              title="Inspector ranking"
              hint="Scored on the inspection: how much was covered, how completely it was recorded, how rarely it needed correcting, and what was found against peers on the same machine."
              icon={<Trophy className="h-4 w-4" />}
              className={cn('print-break', view !== 'inspectors' && '[@media_screen]:hidden')}
            >
              <InspectorRanking data={data.inspectorRanking} onPick={(id) => patch({ inspectorId: id })} />
            </Section>
          )}

          <p className="text-xs text-muted">
            Generated <When iso={data.generatedAt} time /> · targets: defect rate ≤ {t.defectRateGreen}% / {t.defectRateAmber}%, FPY ≥ {t.fpyGreen}% / {t.fpyAmber}%, Cpk ≥ {t.cpkGreen} / {t.cpkAmber}. An administrator changes them in Configuration → KPI targets.
          </p>
        </div>
      )}

      {isFetching && !isLoading && (
        <div className="print-hidden fixed bottom-4 left-1/2 z-30 inline-flex -translate-x-1/2 items-center gap-2 rounded-full bg-slate-900/90 px-3 py-1.5 text-xs font-semibold text-white shadow-lg dark:bg-white/90 dark:text-slate-900">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Updating
        </div>
      )}
    </div>
    </PeriodBadgeContext.Provider>
    </BoardContext.Provider>
  )
}
