// ============================================================================
// §20 — the assistant's charts the dashboard has no drawing for: horizontal
// bars for rankings, stacked areas, a combo of bars and lines on two axes, a
// Pareto, a scatter with its trend line, a heatmap and an SPC control chart.
// Drawn as the dashboard draws (§15): hand-made SVG at the width shown, the
// same palette, axes, figures and read-outs (hover with a mouse, tap with a
// finger), both themes. Every figure is written by the chart's `format`.
// ============================================================================

import { useId } from 'react'
import { cn } from '@/lib/utils'
import { CHAR_WIDTH, CHAR_WIDTH_WIDE, axisNames, slantRoom } from '@/components/dashboard/labels'
import { ChartEmpty, GoalLine, Grid, LABEL_HALO, LEGEND, axisRoom, niceBounds, tickAt, useDrawing, useReadout, type FigureFormat, type ValueAxis } from '@/components/dashboard/charts'
import { trendLine, type ChartSeries, type ControlLimits, type ScatterSeries } from './chartData'

const TEXT = 10
const MUTED = 'fill-muted'
const NAME = 'fill-slate-600 dark:fill-slate-300'
const VALUE = 'fill-slate-700 dark:fill-slate-200'

/** A swatch in a legend: a square for bars, areas and points, a stroke for lines. */
function Swatch({ className, line = false }: { className: string; line?: boolean }) {
  return line ? (
    <svg width="16" height="6" aria-hidden className="shrink-0"><line x1="0" y1="3" x2="16" y2="3" strokeWidth={3} className={className} /></svg>
  ) : (
    <svg width="10" height="10" aria-hidden className="shrink-0"><rect width="10" height="10" rx="2" className={className} /></svg>
  )
}

const fillFor = (stroke: string) => stroke.replace(/stroke-/g, 'fill-')
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s)

/**
 * A value axis spanning the figures themselves, not from zero (a scatter's,
 * a control chart's: lengths of 2,440 to 2,460 mm are not drawn from 0):
 * round steps, at most five, a little room either side.
 */
export function rangeAxis(lo: number, hi: number): ValueAxis {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { min: 0, max: 1, steps: 4 }
  if (hi === lo) {
    const pad = Math.abs(hi) > 0 ? Math.abs(hi) * 0.1 : 1
    return rangeAxis(lo - pad, hi + pad)
  }
  const span = hi - lo
  const raw = span / 4
  const p = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => span / s <= 5) ?? 10 * p
  const min = Math.floor(lo / step) * step
  const max = Math.ceil(hi / step) * step
  return { min, max: max === min ? min + step : max, steps: Math.max(1, Math.round((max - min) / step)) }
}

// ---- Horizontal bars ------------------------------------------------------------------

/** The most rows horizontal bars draw; the rest are in the table. */
export const HBAR_MAX_ROWS = 40

/**
 * Bars lying along the plot, one row per category, its name to the left
 * (long names have the room they need) and its figure at the bar's end: a
 * ranking reads top to bottom. Several series lie side by side in a row.
 */
export function HorizontalBarChart({
  labels,
  series,
  classes,
  unit,
  width,
  format,
  goal,
}: {
  labels: string[]
  series: ChartSeries[]
  classes: (k: number) => string
  unit: string
  width: number
  format: FigureFormat
  goal?: number
}) {
  const id = useId()
  const rows = labels.slice(0, HBAR_MAX_ROWS)
  const d = useDrawing(width, 200)
  const readout = useReadout(d.figure)
  const hover = readout.at
  const known = series.flatMap((s) => s.values.slice(0, rows.length).filter((v): v is number => v !== null))
  if (rows.length === 0 || known.length === 0) return <ChartEmpty />
  const reach = goal === undefined ? known : [...known, goal]
  const axis = niceBounds(Math.min(0, ...reach), Math.max(0, ...reach), true)
  const W = width
  const nameRoom = Math.min(Math.round(W * 0.38), Math.max(60, Math.max(...rows.map((l) => l.length)) * CHAR_WIDTH + 14))
  const maxChars = Math.floor((nameRoom - 14) / CHAR_WIDTH)
  const figureRoom = Math.max(...known.map((v) => `${format(v)}${unit}`.length)) * CHAR_WIDTH_WIDE + 10
  const x0 = nameRoom
  const x1 = W - Math.max(16, figureRoom)
  const bar = series.length > 1 ? 12 : 18
  const rowH = series.length * bar + (series.length - 1) * 2 + 12
  const y0 = 22
  const H = y0 + rows.length * rowH + 8
  const xAt = (v: number) => x0 + ((x1 - x0) * (v - axis.min)) / (axis.max - axis.min)
  const zero = xAt(0)
  return (
    <figure ref={d.figureRef} className={d.figureClass}>
      <svg viewBox={`0 0 ${W} ${H}`} className={d.svgClass} role="img" aria-labelledby={`${id}-t`} {...readout.svg}>
        <title id={`${id}-t`}>{rows.map((l, i) => `${l}: ${series.map((s) => (s.values[i] === null ? '—' : `${format(s.values[i]!)}${unit}`)).join(' / ')}`).join(', ')}</title>
        <g className="text-muted" fontSize={TEXT}>
          {Array.from({ length: axis.steps + 1 }, (_, i) => {
            const v = tickAt(axis.min, axis.max, axis.steps, i)
            const x = xAt(v)
            return (
              <g key={i}>
                <line x1={x} x2={x} y1={y0 - 4} y2={H - 8} stroke="currentColor" strokeOpacity={v === 0 ? 0.6 : 0.18} strokeDasharray={v === 0 ? undefined : '3 3'} />
                <text x={x} y={y0 - 8} textAnchor="middle" fill="currentColor">
                  {format(v)}
                  {unit}
                </text>
              </g>
            )
          })}
        </g>
        {rows.map((l, i) => {
          const top = y0 + i * rowH + 6
          return (
            <g key={l} {...readout.mark(i)} className={cn('transition-opacity', hover !== null && hover !== i && 'opacity-50')}>
              <rect x={0} y={top - 6} width={W} height={rowH} fill="transparent" />
              <text x={x0 - 8} y={top + (rowH - 12) / 2 + 4} textAnchor="end" fontSize={TEXT + 1} fontWeight={600} className={NAME}>
                {cut(l, maxChars)}
              </text>
              {series.map((s, k) => {
                const v = s.values[i]
                if (v === null || v === undefined) return null
                const y = top + k * (bar + 2)
                const xs = [zero, xAt(v)].sort((a, b) => a - b)
                return (
                  <g key={s.label}>
                    <rect x={xs[0]} y={y} width={Math.max(1, xs[1] - xs[0])} height={bar} rx={Math.min(4, bar / 3)} className={classes(k)} />
                    <text x={v >= 0 ? xs[1] + 4 : xs[0] - 4} y={y + bar / 2 + 3.5} textAnchor={v >= 0 ? 'start' : 'end'} fontSize={TEXT} fontWeight={700} className={VALUE}>
                      {format(v)}
                      {unit}
                    </text>
                  </g>
                )
              })}
            </g>
          )
        })}
        {goal !== undefined && (
          <g className="pointer-events-none">
            <line x1={xAt(goal)} x2={xAt(goal)} y1={y0 - 2} y2={H - 8} className="stroke-amber-500" strokeWidth={1.5} strokeDasharray="6 4" />
            <text x={xAt(goal) + 4} y={H - 10} fontSize={TEXT} fontWeight={700} className={cn('fill-amber-600 dark:fill-amber-400', LABEL_HALO)} strokeWidth={3} style={{ paintOrder: 'stroke' }}>
              Target {format(goal)}
              {unit}
            </text>
          </g>
        )}
      </svg>
      <div ref={d.legend} className={LEGEND}>
        {series.length > 1 &&
          series.map((s, k) => (
            <span key={s.label} className="inline-flex items-center gap-1.5">
              <Swatch className={classes(k)} />
              <span dir="auto">{s.label}</span>
            </span>
          ))}
        {labels.length > rows.length && <span>The first {rows.length} of {labels.length} are drawn; the table has them all.</span>}
        {hover !== null && (
          <span className="ml-auto font-semibold text-slate-700 dark:text-slate-200" dir="auto">
            {rows[hover]}: {series.map((s) => (s.values[hover] === null ? '—' : `${format(s.values[hover]!)}${unit}`)).join(' / ')}
          </span>
        )}
      </div>
    </figure>
  )
}

// ---- Stacked areas -------------------------------------------------------------------

/** Areas piled one on another over time: the whole as the top line, each part as its band. */
export function StackedAreaChart({
  labels,
  series,
  strokes,
  unit,
  width,
  height,
  format,
}: {
  labels: string[]
  series: ChartSeries[]
  strokes: (k: number) => string
  unit: string
  width: number
  height: number
  format: FigureFormat
}) {
  const id = useId()
  const d = useDrawing(width, height)
  const readout = useReadout(d.figure)
  const hover = readout.at
  const n = labels.length
  const tops = series.map((_, k) => labels.map((__, i) => series.slice(0, k + 1).reduce((t, s) => t + Math.max(0, s.values[i] ?? 0), 0)))
  const totals = tops.length > 0 ? tops[tops.length - 1] : []
  if (n === 0 || totals.every((v) => v === 0)) return <ChartEmpty height={height} />
  const axis = niceBounds(0, Math.max(...totals), true)
  const W = width
  const H = height
  const x0 = Math.min(Math.round(W * 0.35), axisRoom(axis, unit, format))
  const x1 = W - 16
  const y0 = 16
  const y1 = H - 34
  const slot = (x1 - x0) / n
  const xAt = (i: number) => x0 + slot * i + slot / 2
  const yAt = (v: number) => y1 - ((y1 - y0) * (v - axis.min)) / (axis.max - axis.min)
  const every = Math.max(1, Math.ceil(n / Math.max(4, Math.round((12 * (x1 - x0)) / 660))))
  const named = new Map(axisNames(labels, xAt, slot, W, every).map((a) => [a.i, a]))
  return (
    <figure ref={d.figureRef} className={d.figureClass}>
      <svg viewBox={`0 0 ${W} ${H}`} className={d.svgClass} role="img" aria-labelledby={`${id}-t`} {...readout.svg}>
        <title id={`${id}-t`}>{`${series.map((s) => s.label).join(', ')}, stacked over time`}</title>
        <Grid x0={x0} x1={x1} y0={y0} y1={y1} min={axis.min} max={axis.max} steps={axis.steps} unit={unit} format={format} fontSize={TEXT} />
        {series.map((s, k) => {
          const upper = tops[k].map((v, i) => `${xAt(i)},${yAt(v)}`)
          const lower = (k === 0 ? labels.map(() => 0) : tops[k - 1]).map((v, i) => `${xAt(i)},${yAt(v)}`).reverse()
          return (
            <g key={s.label} className="pointer-events-none">
              <polygon points={[...upper, ...lower].join(' ')} className={fillFor(strokes(k))} fillOpacity={0.35} stroke="none" />
              <polyline points={upper.join(' ')} fill="none" strokeWidth={2} strokeLinejoin="round" className={strokes(k)} />
            </g>
          )
        })}
        {labels.map((l, i) => {
          const name = named.get(i)
          return (
            <g key={l} {...readout.mark(i)}>
              <rect x={xAt(i) - slot / 2} y={y0} width={slot} height={y1 - y0} fill="transparent" />
              {name && (
                <text x={name.x} y={y1 + 16} textAnchor={name.anchor} fontSize={TEXT} className={MUTED}>
                  {l}
                </text>
              )}
            </g>
          )
        })}
        {hover !== null && <line x1={xAt(hover)} x2={xAt(hover)} y1={y0} y2={y1} className="pointer-events-none stroke-slate-400" strokeDasharray="3 3" />}
      </svg>
      <div ref={d.legend} className={LEGEND}>
        {series.map((s, k) => (
          <span key={s.label} className="inline-flex items-center gap-1.5">
            <Swatch className={fillFor(strokes(k))} />
            <span dir="auto">{s.label}</span>
            {hover !== null && <span className="font-semibold tabular-nums text-slate-700 dark:text-slate-200">{s.values[hover] === null ? '—' : `${format(s.values[hover]!)}${unit}`}</span>}
          </span>
        ))}
        {hover !== null && (
          <span className="ml-auto font-semibold text-slate-700 dark:text-slate-200">
            {labels[hover]} · {format(totals[hover])}
            {unit}
          </span>
        )}
      </div>
    </figure>
  )
}

// ---- Bars and lines on two axes ---------------------------------------------------------

/**
 * A volume as bars on the left axis and one to three rates as lines on the
 * right one (production with its reject rate): each read on its own scale.
 * The target, when there is one, belongs to the lines' axis.
 */
export function ComboChart({
  labels,
  series,
  fills,
  strokes,
  unit,
  lineUnit,
  width,
  height,
  format,
  goal,
}: {
  labels: string[]
  series: ChartSeries[]
  fills: (k: number) => string
  strokes: (k: number) => string
  unit: string
  lineUnit: string
  width: number
  height: number
  format: FigureFormat
  goal?: number
}) {
  const id = useId()
  const d = useDrawing(width, height)
  const readout = useReadout(d.figure)
  const hover = readout.at
  const [bars, ...lines] = series
  const n = labels.length
  const barKnown = bars.values.filter((v): v is number => v !== null)
  const lineKnown = lines.flatMap((s) => s.values.filter((v): v is number => v !== null))
  if (n === 0 || barKnown.length + lineKnown.length === 0) return <ChartEmpty height={height} />
  const left = niceBounds(Math.min(0, ...barKnown), Math.max(0, ...barKnown), true)
  const lineReach = goal === undefined ? lineKnown : [...lineKnown, goal]
  const right = niceBounds(Math.min(0, ...lineReach), Math.max(0, ...lineReach), true)
  const W = width
  const H = height
  const x0 = Math.min(Math.round(W * 0.3), axisRoom(left, unit, format))
  const rightRoom = Math.min(Math.round(W * 0.2), axisRoom(right, lineUnit, format))
  const x1 = W - rightRoom
  const y0 = 18
  const y1 = H - 34
  const slot = (x1 - x0) / n
  const xAt = (i: number) => x0 + slot * i + slot / 2
  const yL = (v: number) => y1 - ((y1 - y0) * (v - left.min)) / (left.max - left.min)
  const yR = (v: number) => y1 - ((y1 - y0) * (v - right.min)) / (right.max - right.min)
  const bw = Math.max(2, Math.min(48, slot * 0.6))
  const every = Math.max(1, Math.ceil(n / Math.max(4, Math.round((12 * (x1 - x0)) / 660))))
  const named = new Map(axisNames(labels, xAt, slot, W - rightRoom + 16, every).map((a) => [a.i, a]))
  const marked = slot >= 10
  return (
    <figure ref={d.figureRef} className={d.figureClass}>
      <svg viewBox={`0 0 ${W} ${H}`} className={d.svgClass} role="img" aria-labelledby={`${id}-t`} {...readout.svg}>
        <title id={`${id}-t`}>{`${bars.label} as bars, ${lines.map((s) => s.label).join(', ')} as lines`}</title>
        <Grid x0={x0} x1={x1} y0={y0} y1={y1} min={left.min} max={left.max} steps={left.steps} unit={unit} format={format} fontSize={TEXT} />
        <g className="text-muted" fontSize={TEXT}>
          {Array.from({ length: right.steps + 1 }, (_, i) => {
            const v = tickAt(right.min, right.max, right.steps, i)
            return (
              <text key={i} x={x1 + 6} y={yR(v) + 3} fill="currentColor">
                {format(v)}
                {lineUnit}
              </text>
            )
          })}
        </g>
        {labels.map((l, i) => {
          const v = bars.values[i]
          const name = named.get(i)
          return (
            <g key={l} {...readout.mark(i)} className={cn('transition-opacity', hover !== null && hover !== i && 'opacity-60')}>
              <rect x={xAt(i) - slot / 2} y={y0} width={slot} height={y1 - y0} fill="transparent" />
              {v !== null && v !== undefined && <rect x={xAt(i) - bw / 2} y={Math.min(yL(v), yL(0))} width={bw} height={Math.abs(yL(0) - yL(v))} rx={Math.min(4, bw / 3)} className={fills(0)} fillOpacity={0.85} />}
              {name && (
                <text x={name.x} y={y1 + 16} textAnchor={name.anchor} fontSize={TEXT} className={MUTED}>
                  {l}
                </text>
              )}
            </g>
          )
        })}
        {lines.map((s, k) => {
          const pts = s.values.flatMap((v, i) => (v === null ? [] : [`${xAt(i)},${yR(v)}`]))
          return (
            <g key={s.label} className="pointer-events-none">
              <polyline points={pts.join(' ')} fill="none" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" className={strokes(k + 1)} />
              {s.values.map((v, i) => v !== null && (marked || hover === i) && <circle key={i} cx={xAt(i)} cy={yR(v)} r={hover === i ? 5 : 3} strokeWidth={2} className={cn('fill-white dark:fill-slate-900', strokes(k + 1))} />)}
            </g>
          )
        })}
        {goal !== undefined && <GoalLine x0={x0} x1={x1} y={yR(goal)} text={`Target ${format(goal)}${lineUnit}`} />}
        {hover !== null && <line x1={xAt(hover)} x2={xAt(hover)} y1={y0} y2={y1} className="pointer-events-none stroke-slate-400" strokeDasharray="3 3" />}
      </svg>
      <div ref={d.legend} className={LEGEND}>
        <span className="inline-flex items-center gap-1.5">
          <Swatch className={fills(0)} />
          <span dir="auto">{bars.label}</span>
          {hover !== null && <span className="font-semibold tabular-nums text-slate-700 dark:text-slate-200">{bars.values[hover] === null ? '—' : `${format(bars.values[hover]!)}${unit}`}</span>}
        </span>
        {lines.map((s, k) => (
          <span key={s.label} className="inline-flex items-center gap-1.5">
            <Swatch className={strokes(k + 1)} line />
            <span dir="auto">{s.label}</span>
            {hover !== null && <span className="font-semibold tabular-nums text-slate-700 dark:text-slate-200">{s.values[hover] === null ? '—' : `${format(s.values[hover]!)}${lineUnit}`}</span>}
          </span>
        ))}
        {hover !== null && <span className="ml-auto font-semibold text-slate-700 dark:text-slate-200">{labels[hover]}</span>}
      </div>
    </figure>
  )
}

// ---- Pareto ---------------------------------------------------------------------------

/**
 * Causes largest first with the running share over them on a 0–100% axis,
 * and the 80% line: the "vital few" up to where the line crosses it are
 * drawn strong, the rest muted.
 */
export function ParetoAiChart({
  labels,
  values,
  cumulative,
  label,
  unit,
  width,
  height,
  format,
}: {
  labels: string[]
  values: (number | null)[]
  cumulative: number[]
  label: string
  unit: string
  width: number
  height: number
  format: FigureFormat
}) {
  const id = useId()
  const d = useDrawing(width, height)
  const readout = useReadout(d.figure)
  const hover = readout.at
  const n = labels.length
  const known = values.map((v) => v ?? 0)
  if (n === 0 || known.every((v) => v === 0)) return <ChartEmpty height={height} />
  const axis = niceBounds(0, Math.max(...known), true)
  const W = width
  const slot0 = (W - 90) / n
  const tilt = labels.some((l) => l.length * CHAR_WIDTH_WIDE > slot0)
  const names = labels.map((l) => (tilt && l.length > 22 ? `${l.slice(0, 21)}…` : l))
  const H = height + (tilt ? 56 : 0)
  const x1 = W - 40
  const every = Math.max(1, Math.ceil(n / Math.max(4, Math.round(((tilt ? 24 : 12) * (x1 - 56)) / 664))))
  const x0 = Math.min(Math.round(W * 0.35), Math.max(axisRoom(axis, unit, format), tilt ? slantRoom(names, x1, CHAR_WIDTH, TEXT, (i) => i % every === 0) : 0))
  const y0 = 18
  const y1 = H - (tilt ? 90 : 34)
  const slot = (x1 - x0) / n
  const bw = Math.max(3, Math.min(44, slot * 0.66))
  const xAt = (i: number) => x0 + slot * i + slot / 2
  const yBar = (v: number) => y1 - ((y1 - y0) * v) / axis.max
  const yPct = (v: number) => y1 - ((y1 - y0) * v) / 100
  const vitalTo = cumulative.findIndex((c) => c >= 80)
  const valued = slot >= 26
  return (
    <figure ref={d.figureRef} className={d.figureClass}>
      <svg viewBox={`0 0 ${W} ${H}`} className={d.svgClass} role="img" aria-labelledby={`${id}-t`} {...readout.svg}>
        <title id={`${id}-t`}>{`Pareto of ${label}: ${labels.map((l, i) => `${l} ${format(known[i])}${unit} (${Math.round(cumulative[i])}% cumulative)`).join(', ')}`}</title>
        <Grid x0={x0} x1={x1} y0={y0} y1={y1} max={axis.max} steps={axis.steps} unit={unit} format={format} fontSize={TEXT} />
        <g className="text-muted" fontSize={TEXT}>
          {[0, 20, 40, 60, 80, 100].map((v) => (
            <text key={v} x={x1 + 6} y={yPct(v) + 3} fill="currentColor">
              {v}%
            </text>
          ))}
        </g>
        <line x1={x0} x2={x1} y1={yPct(80)} y2={yPct(80)} className="stroke-amber-500" strokeDasharray="4 4" strokeOpacity={0.8} />
        {labels.map((l, i) => {
          const vital = vitalTo === -1 || i <= vitalTo
          return (
            <g key={l} {...readout.mark(i)} className={cn('transition-opacity', hover !== null && hover !== i && 'opacity-60')}>
              <rect x={xAt(i) - slot / 2} y={y0} width={slot} height={y1 - y0} fill="transparent" />
              <rect x={xAt(i) - bw / 2} y={yBar(known[i])} width={bw} height={Math.max(0, y1 - yBar(known[i]))} rx={Math.min(4, bw / 3)} className={vital ? 'fill-rose-500' : 'fill-slate-300 dark:fill-slate-600'} />
              {i % every === 0 &&
                (tilt ? (
                  <text x={xAt(i)} y={y1 + 12} textAnchor="end" fontSize={TEXT} fontWeight={600} transform={`rotate(-35 ${xAt(i)} ${y1 + 12})`} className={NAME}>
                    {names[i]}
                  </text>
                ) : (
                  <text x={xAt(i)} y={y1 + 16} textAnchor="middle" fontSize={TEXT} className={MUTED}>
                    {l}
                  </text>
                ))}
            </g>
          )
        })}
        <polyline points={cumulative.map((c, i) => `${xAt(i)},${yPct(c)}`).join(' ')} fill="none" strokeWidth={2.5} strokeLinejoin="round" className="pointer-events-none stroke-brand-600 dark:stroke-brand-400" />
        {cumulative.map((c, i) => (
          <circle key={i} cx={xAt(i)} cy={yPct(c)} r={hover === i ? 5 : 3} strokeWidth={2} className="pointer-events-none fill-white stroke-brand-600 dark:fill-slate-900 dark:stroke-brand-400" />
        ))}
        {/* Each bar's figure over the line's markers, outlined so it reads where they meet. */}
        {valued &&
          labels.map((l, i) => (
            <text key={`v-${l}`} x={xAt(i)} y={yBar(known[i]) - 4} textAnchor="middle" fontSize={TEXT} fontWeight={700} className={cn('pointer-events-none', VALUE, LABEL_HALO)} strokeWidth={3} style={{ paintOrder: 'stroke' }}>
              {format(known[i])}
            </text>
          ))}
      </svg>
      <div ref={d.legend} className={LEGEND}>
        <span className="inline-flex items-center gap-1.5">
          <Swatch className="fill-rose-500" /> <span>The vital few (up to 80%)</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Swatch className="stroke-brand-600 dark:stroke-brand-400" line /> <span>Cumulative share</span>
        </span>
        {hover !== null && (
          <span className="ml-auto font-semibold tabular-nums text-slate-700 dark:text-slate-200" dir="auto">
            {labels[hover]}: {format(known[hover])}
            {unit} · {Math.round(cumulative[hover])}% cumulative
          </span>
        )}
      </div>
    </figure>
  )
}

// ---- Scatter --------------------------------------------------------------------------

/**
 * One point per row on two numeric axes, each fitted to its own figures, and
 * a least-squares line through all of them with Pearson's r: how strongly
 * the two move together. Hovering or tapping a point reads it out.
 */
export function ScatterChart({
  groups,
  fills,
  xName,
  yName,
  unit,
  width,
  height,
  format,
  goal,
}: {
  groups: ScatterSeries[]
  fills: (k: number) => string
  xName: string
  yName: string
  unit: string
  width: number
  height: number
  format: FigureFormat
  goal?: number
}) {
  const id = useId()
  const d = useDrawing(width, height)
  const readout = useReadout(d.figure)
  const hover = readout.at
  const all = groups.flatMap((g, k) => g.points.map((p) => ({ ...p, k })))
  if (all.length < 2) return <ChartEmpty height={height} />
  const xs = rangeAxis(Math.min(...all.map((p) => p.x)), Math.max(...all.map((p) => p.x)))
  const yReach = all.map((p) => p.y).concat(goal === undefined ? [] : [goal])
  const ys = rangeAxis(Math.min(...yReach), Math.max(...yReach))
  const W = width
  const H = height + 14
  const named = yName !== ''
  const x0 = Math.min(Math.round(W * 0.3), axisRoom(ys, unit, format) + (named ? 16 : 0))
  const x1 = W - 18
  const y0 = 16
  const y1 = H - 46
  const xAt = (v: number) => x0 + ((x1 - x0) * (v - xs.min)) / (xs.max - xs.min)
  const yAt = (v: number) => y1 - ((y1 - y0) * (v - ys.min)) / (ys.max - ys.min)
  const fit = trendLine(all)
  const r = all.length > 400 ? 2 : all.length > 120 ? 2.5 : 3.5
  const picked = hover !== null ? all[hover] : null
  return (
    <figure ref={d.figureRef} className={d.figureClass}>
      <svg viewBox={`0 0 ${W} ${H}`} className={d.svgClass} role="img" aria-labelledby={`${id}-t`} {...readout.svg}>
        <title id={`${id}-t`}>{`${yName || 'y'} against ${xName}: ${all.length} points${fit ? `, r = ${fit.r.toFixed(2)}` : ''}`}</title>
        <Grid x0={x0} x1={x1} y0={y0} y1={y1} min={ys.min} max={ys.max} steps={ys.steps} unit={unit} format={format} fontSize={TEXT} />
        <g className="text-muted" fontSize={TEXT}>
          {Array.from({ length: xs.steps + 1 }, (_, i) => {
            const v = tickAt(xs.min, xs.max, xs.steps, i)
            return (
              <g key={i}>
                <line x1={xAt(v)} x2={xAt(v)} y1={y0} y2={y1} stroke="currentColor" strokeOpacity={0.12} strokeDasharray="3 3" />
                <text x={xAt(v)} y={y1 + 14} textAnchor="middle" fill="currentColor">
                  {format(v)}
                </text>
              </g>
            )
          })}
          <text x={(x0 + x1) / 2} y={y1 + 32} textAnchor="middle" fontWeight={600} fill="currentColor">
            {xName}
          </text>
          {named && (
            <text x={10} y={(y0 + y1) / 2} textAnchor="middle" fontWeight={600} fill="currentColor" transform={`rotate(-90 10 ${(y0 + y1) / 2})`}>
              {yName}
            </text>
          )}
        </g>
        {fit && (
          <line
            x1={xAt(xs.min)}
            x2={xAt(xs.max)}
            y1={yAt(Math.min(ys.max, Math.max(ys.min, fit.intercept + fit.slope * xs.min)))}
            y2={yAt(Math.min(ys.max, Math.max(ys.min, fit.intercept + fit.slope * xs.max)))}
            className="pointer-events-none stroke-slate-500 dark:stroke-slate-400"
            strokeWidth={1.5}
            strokeDasharray="6 4"
          />
        )}
        {goal !== undefined && <GoalLine x0={x0} x1={x1} y={yAt(goal)} text={`Target ${format(goal)}${unit}`} />}
        {all.map((p, i) => (
          <circle key={i} cx={xAt(p.x)} cy={yAt(p.y)} r={hover === i ? r + 2.5 : r} className={cn(fills(p.k), 'stroke-white dark:stroke-slate-900')} strokeWidth={hover === i ? 1.5 : 0.75} fillOpacity={hover === null || hover === i ? 0.8 : 0.35} {...readout.mark(i)} />
        ))}
      </svg>
      <div ref={d.legend} className={LEGEND}>
        {groups.length > 1 &&
          groups.map((g, k) => (
            <span key={g.label} className="inline-flex items-center gap-1.5">
              <Swatch className={fills(k)} />
              <span dir="auto">{g.label}</span>
            </span>
          ))}
        {fit && (
          <span className="inline-flex items-center gap-1.5" data-tip="Pearson's r: 1 or −1 move together exactly, 0 not at all">
            <Swatch className="stroke-slate-500" line /> Trend · r = {fit.r.toFixed(2)}
          </span>
        )}
        {picked && (
          <span className="ml-auto font-semibold tabular-nums text-slate-700 dark:text-slate-200" dir="auto">
            {groups.length > 1 ? `${groups[picked.k].label} · ` : ''}
            {xName} {format(picked.x)} · {yName ? `${yName} ` : ''}
            {format(picked.y)}
            {unit}
          </span>
        )}
      </div>
    </figure>
  )
}

// ---- Heatmap --------------------------------------------------------------------------

/**
 * A grid of one measure across two categories: rows the series (machines),
 * columns x (days), each cell shaded by its value — darker is more; below
 * zero in rose. A cell wide enough carries its figure.
 */
export function HeatmapChart({ labels, rows, unit, width, format }: { labels: string[]; rows: ChartSeries[]; unit: string; width: number; format: FigureFormat }) {
  const id = useId()
  const d = useDrawing(width, 200)
  const readout = useReadout(d.figure)
  const hover = readout.at
  const n = labels.length
  const known = rows.flatMap((s) => s.values.filter((v): v is number => v !== null))
  if (n === 0 || rows.length === 0 || known.length === 0) return <ChartEmpty />
  const top = Math.max(...known.map(Math.abs)) || 1
  const W = width
  const nameRoom = Math.min(Math.round(W * 0.3), Math.max(...rows.map((r) => r.label.length)) * CHAR_WIDTH + 14)
  const x0 = nameRoom
  const x1 = W - 8
  const cw = (x1 - x0) / n
  const ch = Math.max(18, Math.min(30, 260 / rows.length))
  const tilt = labels.some((l) => l.length * CHAR_WIDTH > cw)
  const every = Math.max(1, Math.ceil((tilt ? 14 : 9) / cw))
  const y0 = 6
  const y1 = y0 + rows.length * ch
  const H = y1 + (tilt ? 64 : 22)
  const written = cw >= Math.max(26, Math.max(...known.map((v) => format(v).length)) * 6 + 6) && ch >= 18
  const maxChars = Math.floor((nameRoom - 12) / CHAR_WIDTH)
  return (
    <figure ref={d.figureRef} className={d.figureClass}>
      <svg viewBox={`0 0 ${W} ${H}`} className={d.svgClass} role="img" aria-labelledby={`${id}-t`} {...readout.svg}>
        <title id={`${id}-t`}>{`${rows.length} rows by ${n} columns, from ${format(Math.min(...known))}${unit} to ${format(Math.max(...known))}${unit}`}</title>
        {rows.map((row, k) => (
          <g key={row.label}>
            <text x={x0 - 6} y={y0 + k * ch + ch / 2 + 3.5} textAnchor="end" fontSize={TEXT + 1} fontWeight={600} className={NAME}>
              {cut(row.label, maxChars)}
            </text>
            {labels.map((_, i) => {
              const v = row.values[i]
              const cell = k * n + i
              const share = v === null ? 0 : Math.abs(v) / top
              return (
                <g key={i} {...readout.mark(cell)}>
                  <rect
                    x={x0 + i * cw + 1}
                    y={y0 + k * ch + 1}
                    width={Math.max(1, cw - 2)}
                    height={ch - 2}
                    rx={3}
                    className={v === null ? 'fill-slate-100 dark:fill-slate-800' : v < 0 ? 'fill-rose-500' : 'fill-brand-600'}
                    fillOpacity={v === null ? 1 : 0.08 + 0.92 * share}
                    stroke={hover === cell ? 'currentColor' : 'none'}
                  />
                  {written && v !== null && (
                    <text x={x0 + i * cw + cw / 2} y={y0 + k * ch + ch / 2 + 3.5} textAnchor="middle" fontSize={TEXT} fontWeight={600} className={share > 0.55 ? 'pointer-events-none fill-white' : 'pointer-events-none fill-slate-700 dark:fill-slate-200'}>
                      {format(v)}
                    </text>
                  )}
                </g>
              )
            })}
          </g>
        ))}
        {labels.map((l, i) =>
          i % every !== 0 ? null : tilt ? (
            <text key={l} x={x0 + i * cw + cw / 2} y={y1 + 10} textAnchor="end" fontSize={TEXT} transform={`rotate(-40 ${x0 + i * cw + cw / 2} ${y1 + 10})`} className={MUTED}>
              {cut(l, 18)}
            </text>
          ) : (
            <text key={l} x={x0 + i * cw + cw / 2} y={y1 + 14} textAnchor="middle" fontSize={TEXT} className={MUTED}>
              {l}
            </text>
          ),
        )}
      </svg>
      <div ref={d.legend} className={LEGEND}>
        <span className="inline-flex items-center gap-1.5">
          <span>Less</span>
          <span aria-hidden className="h-2.5 w-24 rounded-full bg-gradient-to-r from-brand-600/10 to-brand-600" />
          <span>More</span>
        </span>
        {hover !== null && (
          <span className="ml-auto font-semibold tabular-nums text-slate-700 dark:text-slate-200" dir="auto">
            {rows[Math.floor(hover / n)]?.label} · {labels[hover % n]}:{' '}
            {rows[Math.floor(hover / n)]?.values[hover % n] === null ? '—' : `${format(rows[Math.floor(hover / n)].values[hover % n]!)}${unit}`}
          </span>
        )}
      </div>
    </figure>
  )
}

// ---- Control chart (SPC) -------------------------------------------------------------------

/**
 * An individuals control chart: the values in order with their centre line
 * (the mean) and limits three sigma either side (sigma from the average
 * moving range). A point beyond a limit is out of control: drawn red, and
 * counted under the chart.
 */
export function ControlChart({
  labels,
  values,
  limits,
  label,
  unit,
  width,
  height,
  format,
  goal,
}: {
  labels: string[]
  values: (number | null)[]
  limits: ControlLimits
  label: string
  unit: string
  width: number
  height: number
  format: FigureFormat
  goal?: number
}) {
  const id = useId()
  const d = useDrawing(width, height)
  const readout = useReadout(d.figure)
  const hover = readout.at
  const n = labels.length
  const known = values.filter((v): v is number => v !== null)
  if (n === 0 || known.length < 2) return <ChartEmpty height={height} />
  const reach = [...known, limits.ucl, limits.lcl, ...(goal === undefined ? [] : [goal])]
  const axis = rangeAxis(Math.min(...reach), Math.max(...reach))
  const W = width
  const H = height
  const lineNames = [`UCL ${format(limits.ucl)}`, `CL ${format(limits.mean)}`, `LCL ${format(limits.lcl)}`]
  const x0 = Math.min(Math.round(W * 0.3), axisRoom(axis, unit, format))
  const x1 = W - Math.min(Math.round(W * 0.22), Math.max(...lineNames.map((t) => t.length)) * CHAR_WIDTH + 12)
  const y0 = 14
  const y1 = H - 34
  const slot = (x1 - x0) / n
  const xAt = (i: number) => x0 + slot * i + slot / 2
  const yAt = (v: number) => y1 - ((y1 - y0) * (v - axis.min)) / (axis.max - axis.min)
  const out = values.map((v) => v !== null && (v > limits.ucl || v < limits.lcl))
  const outCount = out.filter(Boolean).length
  const every = Math.max(1, Math.ceil(n / Math.max(4, Math.round((12 * (x1 - x0)) / 660))))
  const named = new Map(axisNames(labels, xAt, slot, x1 + 10, every).map((a) => [a.i, a]))
  const pts = values.flatMap((v, i) => (v === null ? [] : [`${xAt(i)},${yAt(v)}`]))
  const marked = slot >= 6
  const limitLine = (v: number, text: string, center = false) => (
    <g className="pointer-events-none">
      <line x1={x0} x2={x1} y1={yAt(v)} y2={yAt(v)} className={center ? 'stroke-emerald-600 dark:stroke-emerald-400' : 'stroke-rose-500'} strokeWidth={1.5} strokeDasharray={center ? undefined : '6 4'} />
      <text x={x1 + 4} y={yAt(v) + 3.5} fontSize={TEXT} fontWeight={700} className={center ? 'fill-emerald-700 dark:fill-emerald-400' : 'fill-rose-600 dark:fill-rose-400'}>
        {text}
      </text>
    </g>
  )
  return (
    <figure ref={d.figureRef} className={d.figureClass}>
      <svg viewBox={`0 0 ${W} ${H}`} className={d.svgClass} role="img" aria-labelledby={`${id}-t`} {...readout.svg}>
        <title id={`${id}-t`}>{`Control chart of ${label}: mean ${format(limits.mean)}${unit}, limits ${format(limits.lcl)} to ${format(limits.ucl)}${unit}, ${outCount} points outside`}</title>
        <Grid x0={x0} x1={x1} y0={y0} y1={y1} min={axis.min} max={axis.max} steps={axis.steps} unit={unit} format={format} fontSize={TEXT} />
        {limitLine(limits.ucl, lineNames[0])}
        {limitLine(limits.mean, lineNames[1], true)}
        {limitLine(limits.lcl, lineNames[2])}
        {goal !== undefined && <GoalLine x0={x0} x1={x1} y={yAt(goal)} text={`Target ${format(goal)}${unit}`} at="start" />}
        <polyline points={pts.join(' ')} fill="none" strokeWidth={2} strokeLinejoin="round" className="pointer-events-none stroke-brand-500" />
        {labels.map((l, i) => {
          const v = values[i]
          const name = named.get(i)
          return (
            <g key={l} {...readout.mark(i)}>
              <rect x={xAt(i) - slot / 2} y={y0} width={slot} height={y1 - y0} fill="transparent" />
              {v !== null && (out[i] || marked || hover === i) && (
                <circle cx={xAt(i)} cy={yAt(v)} r={out[i] ? 4.5 : hover === i ? 5 : 2.75} strokeWidth={out[i] ? 0 : 2} className={out[i] ? 'fill-rose-600' : 'fill-white stroke-brand-500 dark:fill-slate-900'} />
              )}
              {name && (
                <text x={name.x} y={y1 + 16} textAnchor={name.anchor} fontSize={TEXT} className={MUTED}>
                  {l}
                </text>
              )}
            </g>
          )
        })}
        {hover !== null && <line x1={xAt(hover)} x2={xAt(hover)} y1={y0} y2={y1} className="pointer-events-none stroke-slate-400" strokeDasharray="3 3" />}
      </svg>
      <div ref={d.legend} className={LEGEND}>
        <span className={cn('font-semibold', outCount > 0 ? 'text-rose-700 dark:text-rose-300' : 'text-emerald-700 dark:text-emerald-300')}>
          {outCount === 0 ? 'In control: every point within the limits' : `${outCount} ${outCount === 1 ? 'point' : 'points'} outside the limits`}
        </span>
        <span>σ ≈ {format(limits.sigma)}{unit}</span>
        {hover !== null && (
          <span className="ml-auto font-semibold tabular-nums text-slate-700 dark:text-slate-200" dir="auto">
            {labels[hover]}: {values[hover] === null ? '—' : `${format(values[hover]!)}${unit}`}
          </span>
        )}
      </div>
    </figure>
  )
}
