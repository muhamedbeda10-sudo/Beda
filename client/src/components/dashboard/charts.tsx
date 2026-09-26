// ============================================================================
// Small SVG charts for the dashboard (§15). Hand-drawn rather than a chart
// library: the shapes are few and fixed, the bundle stays small for a tablet
// on the factory Wi-Fi, and they print as vectors. Each one scales with its
// container through the viewBox and keeps its text legible in both themes
// with currentColor and the brand palette.
// ============================================================================

import { createContext, useContext, useId, useState, type ReactNode } from 'react'

/**
 * True inside a board: the chart fills the box it was given, height and
 * width alike, scaling its drawing to fit. Outside a board a chart keeps
 * its own aspect and takes the height it needs.
 */
export const ChartFillContext = createContext(false)

/** The figure and svg classes for a chart that may fill its box. */
function useChartFrame(): { figure: string; svg: string } {
  const fill = useContext(ChartFillContext)
  return fill ? { figure: 'relative flex h-full min-h-0 flex-col', svg: 'min-h-0 w-full flex-1' } : { figure: 'relative', svg: 'h-auto w-full' }
}
import { cn } from '@/lib/utils'

const fmt = (n: number, digits = 1): string => (Number.isInteger(n) ? String(n) : n.toFixed(digits))

function niceMax(v: number): number {
  if (!(v > 0)) return 1
  const p = 10 ** Math.floor(Math.log10(v))
  const m = v / p
  const step = m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10
  return step * p
}

/** Grid lines with their labels, five steps from 0 to max. */
function Grid({ x0, x1, y0, y1, max, unit = '' }: { x0: number; x1: number; y0: number; y1: number; max: number; unit?: string }) {
  const steps = 4
  return (
    <g className="text-slate-400 dark:text-slate-500" fontSize="10">
      {Array.from({ length: steps + 1 }, (_, i) => {
        const v = (max / steps) * i
        const y = y1 - ((y1 - y0) * i) / steps
        return (
          <g key={i}>
            <line x1={x0} x2={x1} y1={y} y2={y} stroke="currentColor" strokeOpacity={i === 0 ? 0.6 : 0.18} strokeDasharray={i === 0 ? undefined : '3 3'} />
            <text x={x0 - 6} y={y + 3} textAnchor="end" fill="currentColor">
              {fmt(v)}
              {unit}
            </text>
          </g>
        )
      })}
    </g>
  )
}

export interface TrendPoint {
  label: string
  /** Bars, e.g. samples per day. */
  bar: number
  /** Line on its own axis, e.g. defect rate; null draws a gap. */
  line: number | null
}

/** Bars for volume with a line for a rate over the same days. */
/** Bars for volume with a line for a rate over the same days; more lines on the rate axis when `lines` is given. Values are written on the marks while they fit. */
export function TrendChart({ points, barLabel, lineLabel, lineUnit = '%', height = 220, lines = [] }: { points: TrendPoint[]; barLabel: string; lineLabel: string; lineUnit?: string; height?: number; lines?: LineSeries[] }) {
  const [hover, setHover] = useState<number | null>(null)
  const frame = useChartFrame()
  const id = useId()
  const W = 720
  const H = height
  const pad = { l: 40, r: 44, t: 16, b: 34 }
  const x0 = pad.l
  const x1 = W - pad.r
  const y0 = pad.t
  const y1 = H - pad.b
  const n = points.length
  if (n === 0) return <ChartEmpty height={height} />
  const barMax = niceMax(Math.max(...points.map((p) => p.bar)))
  const lineMax = niceMax(Math.max(...points.map((p) => p.line ?? 0), ...lines.flatMap((l) => l.values.map((v) => v ?? 0))))
  const labelled = n <= 16
  const slot = (x1 - x0) / n
  const bw = Math.max(2, Math.min(28, slot * 0.6))
  const xAt = (i: number) => x0 + slot * i + slot / 2
  const yBar = (v: number) => y1 - ((y1 - y0) * v) / barMax
  const yLine = (v: number) => y1 - ((y1 - y0) * v) / lineMax
  const segments: string[] = []
  let current: string[] = []
  points.forEach((p, i) => {
    if (p.line === null) {
      if (current.length) segments.push(current.join(' '))
      current = []
    } else current.push(`${xAt(i)},${yLine(p.line)}`)
  })
  if (current.length) segments.push(current.join(' '))
  const every = Math.max(1, Math.ceil(n / 12))
  const h = hover !== null ? points[hover] : null
  return (
    <figure className={frame.figure}>
      <svg viewBox={`0 0 ${W} ${H}`} className={frame.svg} role="img" aria-labelledby={`${id}-t`} onMouseLeave={() => setHover(null)}>
        <title id={`${id}-t`}>
          {barLabel} and {lineLabel} by day
        </title>
        <Grid x0={x0} x1={x1} y0={y0} y1={y1} max={barMax} />
        <g className="text-slate-400 dark:text-slate-500" fontSize="10">
          {Array.from({ length: 5 }, (_, i) => {
            const v = (lineMax / 4) * i
            return (
              <text key={i} x={x1 + 6} y={yLine(v) + 3} fill="currentColor">
                {fmt(v)}
                {lineUnit}
              </text>
            )
          })}
        </g>
        {points.map((p, i) => (
          <g key={p.label} onMouseEnter={() => setHover(i)}>
            <rect x={xAt(i) - slot / 2} y={y0} width={slot} height={y1 - y0} fill="transparent" />
            <rect x={xAt(i) - bw / 2} y={yBar(p.bar)} width={bw} height={Math.max(0, y1 - yBar(p.bar))} rx={3} className={cn('fill-brand-300 transition-opacity dark:fill-brand-600', hover !== null && hover !== i && 'opacity-50')} />
            {labelled && p.bar > 0 && (
              <text x={xAt(i)} y={Math.max(y0 + 9, yBar(p.bar) - 4)} textAnchor="middle" fontSize="10" fontWeight={700} className="fill-slate-600 dark:fill-slate-300">
                {fmt(p.bar)}
              </text>
            )}
            {i % every === 0 && (
              <text x={xAt(i)} y={y1 + 16} textAnchor="middle" fontSize="10" className="fill-slate-500 dark:fill-slate-400">
                {p.label}
              </text>
            )}
          </g>
        ))}
        {segments.map((d, i) => (
          <polyline key={i} points={d} fill="none" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" className="stroke-rose-500" />
        ))}
        {points.map((p, i) => p.line !== null && <circle key={p.label} cx={xAt(i)} cy={yLine(p.line)} r={hover === i ? 5 : 3} className="fill-white stroke-rose-500 dark:fill-slate-900" strokeWidth={2} />)}
        {labelled && points.map((p, i) => p.line !== null && (
          <text key={`v-${p.label}`} x={xAt(i) + bw / 2 + 4} y={yLine(p.line) - 6} fontSize="10" fontWeight={700} className="fill-rose-600 dark:fill-rose-400">
            {fmt(p.line)}{lineUnit}
          </text>
        ))}
        {lines.map((l) => {
          const segs: string[] = []
          let cur: string[] = []
          l.values.forEach((v, i) => {
            if (v === null) {
              if (cur.length) segs.push(cur.join(' '))
              cur = []
            } else cur.push(`${xAt(i)},${yLine(v)}`)
          })
          if (cur.length) segs.push(cur.join(' '))
          return (
            <g key={l.label}>
              {segs.map((d, i) => <polyline key={i} points={d} fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" className={l.className} />)}
              {l.values.map((v, i) => v !== null && <circle key={i} cx={xAt(i)} cy={yLine(v)} r={hover === i ? 4 : 2.5} className={cn('fill-white dark:fill-slate-900', l.className)} strokeWidth={2} />)}
              {labelled && lines.length <= 3 && l.values.map((v, i) => v !== null && (
                <text key={`t-${i}`} x={xAt(i) + bw / 2 + 4} y={yLine(v) + 10} fontSize="9" fontWeight={600} className="fill-slate-500 dark:fill-slate-400">
                  {fmt(v)}{lineUnit}
                </text>
              ))}
            </g>
          )
        })}
        {h && (
          <line x1={xAt(hover!)} x2={xAt(hover!)} y1={y0} y2={y1} className="stroke-slate-400" strokeDasharray="3 3" />
        )}
      </svg>
      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
        <span className="inline-flex items-center gap-1.5">
          <i className="inline-block h-2.5 w-2.5 rounded-sm bg-brand-300 dark:bg-brand-600" /> {barLabel}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <i className="inline-block h-0.5 w-4 rounded bg-rose-500" /> {lineLabel}
        </span>
        {lines.map((l) => (
          <span key={l.label} className="inline-flex items-center gap-1.5">
            <svg width="16" height="6" aria-hidden><line x1="0" y1="3" x2="16" y2="3" strokeWidth={3} className={l.className} /></svg>
            {l.label}
            {h && <span className="font-semibold tabular-nums text-slate-700 dark:text-slate-200">{l.values[hover!] === null ? '—' : `${fmt(l.values[hover!]!)}${lineUnit}`}</span>}
          </span>
        ))}
        {h && (
          <span className="ml-auto font-semibold tabular-nums text-slate-700 dark:text-slate-200">
            {h.label}: {fmt(h.bar)} · {h.line === null ? '—' : `${fmt(h.line)}${lineUnit}`}
          </span>
        )}
      </div>
    </figure>
  )
}

export interface ParetoBar {
  label: string
  value: number
  cumulativePct: number
}

/** Bars sorted largest first with the running share drawn over them. */
export function ParetoChart({ bars, height = 240 }: { bars: ParetoBar[]; height?: number }) {
  const frame = useChartFrame()
  const id = useId()
  const [hover, setHover] = useState<number | null>(null)
  const W = 720
  const H = height
  const pad = { l: 40, r: 40, t: 16, b: 58 }
  const x0 = pad.l
  const x1 = W - pad.r
  const y0 = pad.t
  const y1 = H - pad.b
  const n = bars.length
  if (n === 0) return <ChartEmpty height={height} />
  const max = niceMax(Math.max(...bars.map((b) => b.value)))
  const slot = (x1 - x0) / n
  const bw = Math.max(4, Math.min(40, slot * 0.66))
  const xAt = (i: number) => x0 + slot * i + slot / 2
  const yBar = (v: number) => y1 - ((y1 - y0) * v) / max
  const yPct = (v: number) => y1 - ((y1 - y0) * v) / 100
  const line = bars.map((b, i) => `${xAt(i)},${yPct(b.cumulativePct)}`).join(' ')
  const eighty = bars.findIndex((b) => b.cumulativePct >= 80)
  return (
    <figure className={frame.figure}>
      <svg viewBox={`0 0 ${W} ${H}`} className={frame.svg} role="img" aria-labelledby={`${id}-t`} onMouseLeave={() => setHover(null)}>
        <title id={`${id}-t`}>Pareto of defects</title>
        <Grid x0={x0} x1={x1} y0={y0} y1={y1} max={max} />
        <g className="text-slate-400 dark:text-slate-500" fontSize="10">
          {[0, 25, 50, 75, 100].map((v) => (
            <text key={v} x={x1 + 6} y={yPct(v) + 3} fill="currentColor">
              {v}%
            </text>
          ))}
        </g>
        <line x1={x0} x2={x1} y1={yPct(80)} y2={yPct(80)} className="stroke-amber-500" strokeDasharray="4 4" strokeOpacity={0.7} />
        {bars.map((b, i) => {
          const vital = eighty === -1 || i <= eighty
          const label = b.label.length > 14 ? `${b.label.slice(0, 13)}…` : b.label
          return (
            <g key={b.label} onMouseEnter={() => setHover(i)}>
              <rect x={xAt(i) - bw / 2} y={yBar(b.value)} width={bw} height={Math.max(0, y1 - yBar(b.value))} rx={4} className={cn(vital ? 'fill-rose-500' : 'fill-slate-300 dark:fill-slate-600', hover !== null && hover !== i && 'opacity-60')} />
              <text x={xAt(i)} y={yBar(b.value) - 4} textAnchor="middle" fontSize="10" className="fill-slate-600 dark:fill-slate-300">
                {fmt(b.value)}
              </text>
              <text transform={`translate(${xAt(i)} ${y1 + 8}) rotate(-28)`} textAnchor="end" fontSize="10" className="fill-slate-500 dark:fill-slate-400">
                {label}
              </text>
            </g>
          )
        })}
        <polyline points={line} fill="none" strokeWidth={2} className="stroke-brand-600 dark:stroke-brand-300" strokeLinejoin="round" />
        {bars.map((b, i) => (
          <circle key={b.label} cx={xAt(i)} cy={yPct(b.cumulativePct)} r={3} className="fill-white stroke-brand-600 dark:fill-slate-900 dark:stroke-brand-300" strokeWidth={2} />
        ))}
      </svg>
      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
        <span className="inline-flex items-center gap-1.5">
          <i className="inline-block h-2.5 w-2.5 rounded-sm bg-rose-500" /> Vital few (to 80%)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <i className="inline-block h-0.5 w-4 rounded bg-brand-600 dark:bg-brand-300" /> Cumulative share
        </span>
        {hover !== null && (
          <span className="ml-auto font-semibold tabular-nums text-slate-700 dark:text-slate-200">
            {bars[hover].label}: {fmt(bars[hover].value)} pieces · {fmt(bars[hover].cumulativePct)}% cumulative
          </span>
        )}
      </div>
    </figure>
  )
}

export interface Slice {
  label: string
  value: number
  className: string
}

/** A donut with the total in the middle and the legend beside it. */
export function DonutChart({ slices, centerLabel, size = 160 }: { slices: Slice[]; centerLabel: string; size?: number }) {
  const total = slices.reduce((n, s) => n + s.value, 0)
  const r = 46
  const c = 2 * Math.PI * r
  let offset = 0
  return (
    <div className="flex flex-wrap items-center gap-5">
      <svg viewBox="0 0 120 120" width={size} height={size} role="img" aria-label={centerLabel}>
        <circle cx="60" cy="60" r={r} fill="none" strokeWidth="16" className="stroke-slate-100 dark:stroke-slate-800" />
        {total > 0 &&
          slices
            .filter((s) => s.value > 0)
            .map((s) => {
              const len = (s.value / total) * c
              const el = (
                <circle
                  key={s.label}
                  cx="60"
                  cy="60"
                  r={r}
                  fill="none"
                  strokeWidth="16"
                  strokeDasharray={`${len} ${c - len}`}
                  strokeDashoffset={-offset}
                  transform="rotate(-90 60 60)"
                  className={cn('transition-[stroke-dasharray] duration-500', s.className)}
                />
              )
              offset += len
              return el
            })}
        <text x="60" y="57" textAnchor="middle" fontSize="20" fontWeight="700" className="fill-slate-800 dark:fill-white">
          {fmt(total)}
        </text>
        <text x="60" y="73" textAnchor="middle" fontSize="9" className="fill-slate-500 dark:fill-slate-400">
          {centerLabel}
        </text>
      </svg>
      <ul className="min-w-[10rem] flex-1 space-y-1.5 text-sm">
        {slices.map((s) => (
          <li key={s.label} className="flex items-center gap-2">
            <i className={cn('inline-block h-2.5 w-2.5 rounded-full', s.className.replace(/stroke-/g, 'bg-'))} />
            <span className="flex-1 text-slate-600 dark:text-slate-300">{s.label}</span>
            <span className="font-semibold tabular-nums">{fmt(s.value)}</span>
            <span className="w-12 text-right text-xs tabular-nums text-slate-400">{total > 0 ? `${Math.round((s.value / total) * 100)}%` : '—'}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export interface HBar {
  label: string
  sub?: string
  value: number | null
  tone: 'green' | 'amber' | 'red' | 'neutral'
  /** Text shown after the bar. */
  text: string
  onClick?: () => void
}

const TONE_BAR: Record<HBar['tone'], string> = {
  green: 'bg-emerald-500',
  amber: 'bg-amber-500',
  red: 'bg-rose-500',
  neutral: 'bg-slate-300 dark:bg-slate-600',
}

/** Horizontal bars, one per row, coloured by how the value compares with its target. */
export function HorizontalBars({ rows, max, unit = '' }: { rows: HBar[]; max?: number; unit?: string }) {
  if (rows.length === 0) return <ChartEmpty height={80} />
  const top = max ?? niceMax(Math.max(...rows.map((r) => r.value ?? 0)))
  return (
    <ul className="space-y-2">
      {rows.map((r) => {
        const w = r.value === null ? 0 : Math.min(100, (r.value / top) * 100)
        const inner = (
          <>
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="truncate font-medium text-slate-700 dark:text-slate-200">
                {r.label}
                {r.sub && <span className="ml-1.5 text-xs font-normal text-slate-400">{r.sub}</span>}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-slate-500 dark:text-slate-400">{r.text}</span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
              <div className={cn('h-full rounded-full transition-[width] duration-500', TONE_BAR[r.tone])} style={{ width: `${w}%` }} aria-hidden />
            </div>
            <span className="sr-only">
              {r.value === null ? 'no value' : `${fmt(r.value)}${unit}`}
            </span>
          </>
        )
        return (
          <li key={r.label + (r.sub ?? '')}>
            {r.onClick ? (
              <button type="button" onClick={r.onClick} className="block w-full rounded-lg px-1 py-0.5 text-left transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/60">
                {inner}
              </button>
            ) : (
              <div className="px-1 py-0.5">{inner}</div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

export function ChartEmpty({ height = 160, children = 'Nothing in this period.' }: { height?: number; children?: ReactNode }) {
  return (
    <div className="grid place-items-center rounded-xl border border-dashed border-slate-200 text-sm text-slate-400 dark:border-slate-700" style={{ minHeight: height }}>
      {children}
    </div>
  )
}

export interface PairedPoint {
  label: string
  /** The larger bar, e.g. pieces inspected. */
  total: number
  /** The bar drawn beside it, e.g. defect pieces. */
  part: number
}

/** Two bars per day on one axis: what was inspected and what was found wrong.
 *  One scale, so the eye compares heights directly — no second axis to read. */
export function PairedBarChart({ points, totalLabel, partLabel, height = 220 }: { points: PairedPoint[]; totalLabel: string; partLabel: string; height?: number }) {
  const [hover, setHover] = useState<number | null>(null)
  const frame = useChartFrame()
  const id = useId()
  const W = 720
  const H = height
  const pad = { l: 44, r: 12, t: 30, b: 34 }
  const x0 = pad.l
  const x1 = W - pad.r
  const y0 = pad.t
  const y1 = H - pad.b
  const n = points.length
  if (n === 0) return <ChartEmpty height={height} />
  const max = niceMax(Math.max(...points.map((p) => Math.max(p.total, p.part))))
  const slot = (x1 - x0) / n
  const bw = Math.max(2, Math.min(16, slot * 0.32))
  const xAt = (i: number) => x0 + slot * i + slot / 2
  const yAt = (v: number) => y1 - ((y1 - y0) * v) / max
  const every = Math.max(1, Math.ceil(n / 12))
  const h = hover !== null ? points[hover] : null
  // The value sits on its bar. Where the days are packed too close for that,
  // it stands upright beside the bar's top instead of overlapping its neighbour.
  const upright = slot < 44
  const label = (x: number, v: number, cls: string) =>
    v > 0 && (
      <text
        x={x}
        y={yAt(v) - 4}
        textAnchor={upright ? 'start' : 'middle'}
        fontSize={upright ? 9 : 10}
        fontWeight={700}
        transform={upright ? `rotate(-90 ${x} ${yAt(v) - 4})` : undefined}
        className={cls}
      >
        {fmt(v)}
      </text>
    )
  return (
    <figure className={frame.figure}>
      <svg viewBox={`0 0 ${W} ${H}`} className={frame.svg} role="img" aria-labelledby={`${id}-t`} onMouseLeave={() => setHover(null)}>
        <title id={`${id}-t`}>
          {totalLabel} and {partLabel} by day
        </title>
        <Grid x0={x0} x1={x1} y0={y0} y1={y1} max={max} />
        {points.map((p, i) => (
          <g key={p.label} onMouseEnter={() => setHover(i)} className={cn('transition-opacity', hover !== null && hover !== i && 'opacity-50')}>
            <rect x={xAt(i) - slot / 2} y={y0} width={slot} height={y1 - y0} fill="transparent" />
            <rect x={xAt(i) - bw - 1} y={yAt(p.total)} width={bw} height={Math.max(0, y1 - yAt(p.total))} rx={2} className="fill-brand-300 dark:fill-brand-600" />
            <rect x={xAt(i) + 1} y={yAt(p.part)} width={bw} height={Math.max(0, y1 - yAt(p.part))} rx={2} className="fill-rose-500" />
            {label(xAt(i) - bw / 2 - 1, p.total, 'fill-brand-700 dark:fill-brand-200')}
            {label(xAt(i) + bw / 2 + 1, p.part, 'fill-rose-600 dark:fill-rose-300')}
            {i % every === 0 && (
              <text x={xAt(i)} y={y1 + 16} textAnchor="middle" fontSize="10" className="fill-slate-500 dark:fill-slate-400">
                {p.label}
              </text>
            )}
          </g>
        ))}
      </svg>
      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
        <span className="inline-flex items-center gap-1.5">
          <i className="inline-block h-2.5 w-2.5 rounded-sm bg-brand-300 dark:bg-brand-600" /> {totalLabel}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <i className="inline-block h-2.5 w-2.5 rounded-sm bg-rose-500" /> {partLabel}
        </span>
        {h && (
          <span className="ml-auto font-semibold tabular-nums text-slate-700 dark:text-slate-200">
            {h.label}: {fmt(h.total)} inspected · {fmt(h.part)} defective
          </span>
        )}
      </div>
    </figure>
  )
}

export interface Column {
  label: string
  value: number
  /** Written under the value, e.g. the pieces behind a count of samples. */
  sub?: string
  tone?: keyof typeof TONE_BAR
}

/** Columns in a fixed order — a histogram: how many fell in each band. */
export function ColumnChart({ columns, height = 200, unit = '' }: { columns: Column[]; height?: number; unit?: string }) {
  const frame = useChartFrame()
  const id = useId()
  const W = 520
  const H = height
  const pad = { l: 40, r: 8, t: 22, b: 44 }
  const x0 = pad.l
  const x1 = W - pad.r
  const y0 = pad.t
  const y1 = H - pad.b
  if (columns.length === 0 || columns.every((c) => c.value === 0)) return <ChartEmpty height={height} />
  const max = niceMax(Math.max(...columns.map((c) => c.value)))
  const slot = (x1 - x0) / columns.length
  const bw = Math.min(56, slot * 0.66)
  const xAt = (i: number) => x0 + slot * i + slot / 2
  const yAt = (v: number) => y1 - ((y1 - y0) * v) / max
  const fill: Record<keyof typeof TONE_BAR, string> = {
    green: 'fill-emerald-500',
    amber: 'fill-amber-500',
    red: 'fill-rose-500',
    neutral: 'fill-brand-400 dark:fill-brand-500',
  }
  return (
    <figure className={frame.figure}>
      <svg viewBox={`0 0 ${W} ${H}`} className={frame.svg} role="img" aria-labelledby={`${id}-t`}>
        <title id={`${id}-t`}>{columns.map((c) => `${c.label}: ${fmt(c.value)}${unit}`).join(', ')}</title>
        <Grid x0={x0} x1={x1} y0={y0} y1={y1} max={max} unit={unit} />
        {columns.map((c, i) => (
          <g key={c.label}>
            <rect x={xAt(i) - bw / 2} y={yAt(c.value)} width={bw} height={Math.max(0, y1 - yAt(c.value))} rx={4} className={fill[c.tone ?? 'neutral']} />
            {c.value > 0 && (
              <text x={xAt(i)} y={yAt(c.value) - 5} textAnchor="middle" fontSize="11" fontWeight={700} className="fill-slate-700 dark:fill-slate-200">
                {fmt(c.value)}
                {unit}
              </text>
            )}
            <text x={xAt(i)} y={y1 + 15} textAnchor="middle" fontSize="11" fontWeight={600} className="fill-slate-600 dark:fill-slate-300">
              {c.label}
            </text>
            {c.sub && (
              <text x={xAt(i)} y={y1 + 29} textAnchor="middle" fontSize="9.5" className="fill-slate-400">
                {c.sub}
              </text>
            )}
          </g>
        ))}
      </svg>
    </figure>
  )
}

export interface LineSeries {
  label: string
  /** One value per label in `labels`; null draws a gap. */
  values: (number | null)[]
  /** Tailwind stroke class, e.g. "stroke-brand-500". */
  className: string
}

/** A few lines over the same x axis — one per factory, month by month. */
export function LineChart({ labels, series, unit = '%', height = 220 }: { labels: string[]; series: LineSeries[]; unit?: string; height?: number }) {
  const [hover, setHover] = useState<number | null>(null)
  const frame = useChartFrame()
  const id = useId()
  const W = 720
  const H = height
  const pad = { l: 44, r: 16, t: 16, b: 34 }
  const x0 = pad.l
  const x1 = W - pad.r
  const y0 = pad.t
  const y1 = H - pad.b
  const n = labels.length
  if (n === 0 || series.length === 0 || series.every((s) => s.values.every((v) => v === null))) return <ChartEmpty height={height} />
  const max = niceMax(Math.max(...series.flatMap((s) => s.values.map((v) => v ?? 0))))
  const slot = (x1 - x0) / n
  const xAt = (i: number) => x0 + slot * i + slot / 2
  const yAt = (v: number) => y1 - ((y1 - y0) * v) / max
  const segmentsOf = (values: (number | null)[]): string[] => {
    const out: string[] = []
    let current: string[] = []
    values.forEach((v, i) => {
      if (v === null) {
        if (current.length) out.push(current.join(' '))
        current = []
      } else current.push(`${xAt(i)},${yAt(v)}`)
    })
    if (current.length) out.push(current.join(' '))
    return out
  }
  const every = Math.max(1, Math.ceil(n / 12))
  return (
    <figure className={frame.figure}>
      <svg viewBox={`0 0 ${W} ${H}`} className={frame.svg} role="img" aria-labelledby={`${id}-t`} onMouseLeave={() => setHover(null)}>
        <title id={`${id}-t`}>{series.map((s) => s.label).join(', ')} over time</title>
        <Grid x0={x0} x1={x1} y0={y0} y1={y1} max={max} unit={unit} />
        {labels.map((l, i) => (
          <g key={l} onMouseEnter={() => setHover(i)}>
            <rect x={xAt(i) - slot / 2} y={y0} width={slot} height={y1 - y0} fill="transparent" />
            {i % every === 0 && (
              <text x={xAt(i)} y={y1 + 16} textAnchor="middle" fontSize="10" className="fill-slate-500 dark:fill-slate-400">
                {l}
              </text>
            )}
          </g>
        ))}
        {series.map((s) =>
          segmentsOf(s.values).map((d, i) => <polyline key={`${s.label}-${i}`} points={d} fill="none" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" className={s.className} />),
        )}
        {series.map((s) =>
          s.values.map((v, i) => v !== null && <circle key={`${s.label}-${i}`} cx={xAt(i)} cy={yAt(v)} r={hover === i ? 5 : 3} className={cn('fill-white dark:fill-slate-900', s.className)} strokeWidth={2} />),
        )}
        {n <= 8 && series.length <= 6 && series.map((s) =>
          s.values.map((v, i) => v !== null && (
            <text key={`${s.label}-t-${i}`} x={xAt(i)} y={yAt(v) - 7} textAnchor="middle" fontSize="9" fontWeight={700} className="fill-slate-600 dark:fill-slate-300">
              {fmt(v)}{unit}
            </text>
          )),
        )}
        {hover !== null && <line x1={xAt(hover)} x2={xAt(hover)} y1={y0} y2={y1} className="stroke-slate-400" strokeDasharray="3 3" />}
      </svg>
      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
        {series.map((s) => (
          <span key={s.label} className="inline-flex items-center gap-1.5">
            <svg width="16" height="6" aria-hidden><line x1="0" y1="3" x2="16" y2="3" strokeWidth={3} className={s.className} /></svg>
            {s.label}
            {hover !== null && (
              <span className="font-semibold tabular-nums text-slate-700 dark:text-slate-200">
                {s.values[hover] === null ? '—' : `${fmt(s.values[hover]!)}${unit}`}
              </span>
            )}
          </span>
        ))}
        {hover !== null && <span className="ml-auto font-semibold text-slate-700 dark:text-slate-200">{labels[hover]}</span>}
      </div>
    </figure>
  )
}

/** Up to six lines that stay apart in both themes. */
export const LINE_CLASSES = ['stroke-brand-500', 'stroke-rose-500', 'stroke-emerald-500', 'stroke-amber-500', 'stroke-violet-500', 'stroke-sky-500']

/** A tiny line for a card: a few values, no axes, the last point marked. null draws a gap. */
export function Sparkline({ values, className = 'stroke-brand-500', width = 96, height = 28 }: { values: (number | null)[]; className?: string; width?: number; height?: number }) {
  const n = values.length
  const known = values.filter((v): v is number => v !== null)
  if (n < 2 || known.length === 0) return <svg width={width} height={height} aria-hidden />
  const max = Math.max(...known, 0.0001)
  const pad = 3
  const xAt = (i: number) => pad + ((width - pad * 2) * i) / (n - 1)
  const yAt = (v: number) => height - pad - ((height - pad * 2) * v) / max
  const segments: string[] = []
  let current: string[] = []
  values.forEach((v, i) => {
    if (v === null) {
      if (current.length) segments.push(current.join(' '))
      current = []
    } else current.push(`${xAt(i)},${yAt(v)}`)
  })
  if (current.length) segments.push(current.join(' '))
  const lastIdx = values.length - 1 - [...values].reverse().findIndex((v) => v !== null)
  const last = values[lastIdx]
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden className="shrink-0">
      {segments.map((d, i) => <polyline key={i} points={d} fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" className={className} />)}
      {last !== null && last !== undefined && <circle cx={xAt(lastIdx)} cy={yAt(last)} r={2.5} className={cn('fill-white dark:fill-slate-900', className)} strokeWidth={2} />}
    </svg>
  )
}
