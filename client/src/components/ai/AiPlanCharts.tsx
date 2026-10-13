// ============================================================================
// §20 — the assistant's charts for planning and production, beside its other
// kinds (./AiChartKinds): how far each item is toward its target (progress),
// what each stage keeps of the one before (funnel), how a figure moves from a
// start to an end step by step (waterfall), bars in time — a plan, a
// schedule, plan against actual (gantt), two values side by side on each row
// (dumbbell) and the parts of a whole as tiles (treemap). Drawn as the
// others: hand-made SVG at the width shown, the dashboard's palette, axes
// and read-outs (hover with a mouse, tap with a finger), both themes.
// ============================================================================

import { useId } from 'react'
import { cn } from '@/lib/utils'
import { CHAR_WIDTH, CHAR_WIDTH_BOLD, CHAR_WIDTH_WIDE, slantRoom } from '@/components/dashboard/labels'
import { ChartEmpty, Grid, LABEL_HALO, LEGEND, axisRoom, niceBounds, tickAt, useDrawing, useReadout, type FigureFormat } from '@/components/dashboard/charts'
import { Swatch, rangeAxis } from './AiChartKinds'
import type { GanttModel } from './chartData'

const TEXT = 10
const MUTED = 'fill-muted'
const NAME = 'fill-slate-600 dark:fill-slate-300'
const VALUE = 'fill-slate-700 dark:fill-slate-200'
const READ_OUT = 'ml-auto font-semibold tabular-nums text-slate-700 dark:text-slate-200'

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s)
/** A share in %: whole above 10, one decimal below ("7.5%", "0%"). */
export const percentText = (p: number) => `${Math.abs(p) >= 10 || p === 0 ? Math.round(p) : p.toFixed(1)}%`

// ---- Progress ---------------------------------------------------------------------------

/** The most rows a progress chart draws. */
export const PROGRESS_MAX_ROWS = 30

/**
 * How far each row is toward its target: a track for the whole target, filled
 * to what is done (green once it is reached), the share and the figures beside
 * it. `targets` holds each row's own target, the goal for every row, or 100
 * when the figures are percentages already (`percentMode`).
 */
export function ProgressChart({
  labels,
  done,
  targets,
  percentMode,
  unit,
  width,
  format,
}: {
  labels: string[]
  done: (number | null)[]
  targets: (number | null)[]
  percentMode: boolean
  unit: string
  width: number
  format: FigureFormat
}) {
  const id = useId()
  const d = useDrawing(width, 200)
  const readout = useReadout(d.figure)
  const hover = readout.at
  const items = labels.slice(0, PROGRESS_MAX_ROWS).map((label, i) => {
    const v = done[i] ?? null
    const t = targets[i] ?? null
    const pct = v === null || t === null || !(t > 0) ? null : (v / t) * 100
    const figures = pct === null ? '—' : percentMode ? percentText(pct) : `${percentText(pct)} · ${format(v!)}${unit} of ${format(t!)}${unit}`
    return { label, v, t, pct, figures }
  })
  if (items.length === 0 || items.every((it) => it.pct === null)) return <ChartEmpty />
  const W = width
  const nameRoom = Math.min(Math.round(W * 0.34), Math.max(60, Math.max(...items.map((it) => it.label.length)) * CHAR_WIDTH_BOLD + 14))
  const textRoom = Math.min(Math.round(W * 0.38), Math.max(...items.map((it) => it.figures.length)) * CHAR_WIDTH_WIDE + 14)
  const x0 = nameRoom
  const x1 = W - textRoom
  const rowH = 26
  const track = 10
  const y0 = 6
  const H = y0 + items.length * rowH + 4
  const maxChars = Math.floor((nameRoom - 12) / CHAR_WIDTH_BOLD)
  // Over all rows: what is done of what is asked (or, for percentages, their average).
  const counted = items.filter((it) => it.pct !== null)
  const overall = percentMode
    ? `Average ${percentText(counted.reduce((t, it) => t + it.pct!, 0) / counted.length)}`
    : (() => {
        const sumDone = counted.reduce((t, it) => t + it.v!, 0)
        const sumTarget = counted.reduce((t, it) => t + it.t!, 0)
        return `Overall ${percentText((sumDone / sumTarget) * 100)} · ${format(sumDone)}${unit} of ${format(sumTarget)}${unit}`
      })()
  const reached = counted.filter((it) => it.pct! >= 100).length
  return (
    <figure ref={d.figureRef} className={d.figureClass}>
      <svg viewBox={`0 0 ${W} ${H}`} className={d.svgClass} role="img" aria-labelledby={`${id}-t`} {...readout.svg}>
        <title id={`${id}-t`}>{items.map((it) => `${it.label}: ${it.figures}`).join(', ')}</title>
        {items.map((it, i) => {
          const top = y0 + i * rowH
          const mid = top + rowH / 2
          const share = it.pct === null ? 0 : Math.max(0, Math.min(100, it.pct)) / 100
          const done100 = it.pct !== null && it.pct >= 100
          return (
            <g key={`${it.label}-${i}`} {...readout.mark(i)} className={cn('transition-opacity', hover !== null && hover !== i && 'opacity-50')}>
              <rect x={0} y={top} width={W} height={rowH} fill="transparent" />
              <text x={x0 - 8} y={mid + 4} textAnchor="end" fontSize={TEXT + 1} fontWeight={600} className={NAME}>
                {cut(it.label, maxChars)}
              </text>
              <rect x={x0} y={mid - track / 2} width={Math.max(1, x1 - x0)} height={track} rx={track / 2} className="fill-slate-100 dark:fill-slate-800" />
              {share > 0 && <rect x={x0} y={mid - track / 2} width={Math.max(track, (x1 - x0) * share)} height={track} rx={track / 2} className={done100 ? 'fill-emerald-500' : 'fill-brand-500'} />}
              <text x={x1 + 8} y={mid + 4} fontSize={TEXT} fontWeight={700} className={done100 ? 'fill-emerald-700 dark:fill-emerald-400' : VALUE}>
                {it.figures}
              </text>
            </g>
          )
        })}
      </svg>
      <div ref={d.legend} className={LEGEND}>
        <span className="font-semibold text-slate-700 dark:text-slate-200">{overall}</span>
        <span>
          {reached} of {counted.length} reached
        </span>
        {labels.length > items.length && <span>The first {items.length} of {labels.length} are drawn; the table has them all.</span>}
        {hover !== null && items[hover] && (
          <span className={READ_OUT} dir="auto">
            {items[hover].label}: {items[hover].figures}
          </span>
        )}
      </div>
    </figure>
  )
}

// ---- Funnel -------------------------------------------------------------------------------

/**
 * Stages in order, each a bar centred on the one before, as wide as its
 * figure: the share of the first stage beside it, and what it kept of the
 * stage before under that.
 */
export function FunnelChart({ labels, values, unit, width, format }: { labels: string[]; values: (number | null)[]; unit: string; width: number; format: FigureFormat }) {
  const id = useId()
  const d = useDrawing(width, 200)
  const readout = useReadout(d.figure)
  const hover = readout.at
  const stages = labels.map((label, i) => ({ label, v: Math.max(0, values[i] ?? 0) }))
  const first = stages[0]?.v ?? 0
  const top = Math.max(0, ...stages.map((s) => s.v))
  if (stages.length < 2 || !(first > 0) || !(top > 0)) return <ChartEmpty />
  const W = width
  const nameRoom = Math.min(Math.round(W * 0.3), Math.max(60, Math.max(...stages.map((s) => s.label.length)) * CHAR_WIDTH_BOLD + 14))
  const infoRoom = Math.min(Math.round(W * 0.26), 13 * CHAR_WIDTH_WIDE + 14)
  const x0 = nameRoom
  const x1 = W - infoRoom
  const centre = (x0 + x1) / 2
  const rowH = 34
  const barH = 24
  const H = 6 + stages.length * rowH
  const maxChars = Math.floor((nameRoom - 12) / CHAR_WIDTH_BOLD)
  const ofFirst = (v: number) => (v / first) * 100
  const kept = (i: number) => (i === 0 || stages[i - 1].v === 0 ? null : (stages[i].v / stages[i - 1].v) * 100)
  return (
    <figure ref={d.figureRef} className={d.figureClass}>
      <svg viewBox={`0 0 ${W} ${H}`} className={d.svgClass} role="img" aria-labelledby={`${id}-t`} {...readout.svg}>
        <title id={`${id}-t`}>{stages.map((s) => `${s.label}: ${format(s.v)}${unit} (${percentText(ofFirst(s.v))} of the first)`).join(', ')}</title>
        {stages.map((s, i) => {
          const y = 6 + i * rowH
          const w = Math.max(3, ((x1 - x0) * s.v) / top)
          const valueText = `${format(s.v)}${unit}`
          const inside = w >= valueText.length * CHAR_WIDTH_WIDE + 12
          const k = kept(i)
          return (
            <g key={`${s.label}-${i}`} {...readout.mark(i)} className={cn('transition-opacity', hover !== null && hover !== i && 'opacity-50')}>
              <rect x={0} y={y} width={W} height={rowH} fill="transparent" />
              <text x={x0 - 8} y={y + barH / 2 + 4} textAnchor="end" fontSize={TEXT + 1} fontWeight={600} className={NAME}>
                {cut(s.label, maxChars)}
              </text>
              <rect x={centre - w / 2} y={y} width={w} height={barH} rx={4} className="fill-brand-600" fillOpacity={1 - (0.5 * i) / Math.max(1, stages.length - 1)} />
              <text
                x={inside ? centre : centre + w / 2 + 6}
                y={y + barH / 2 + 4}
                textAnchor={inside ? 'middle' : 'start'}
                fontSize={TEXT}
                fontWeight={700}
                className={inside ? 'pointer-events-none fill-white' : VALUE}
              >
                {valueText}
              </text>
              <text x={x1 + 10} y={y + 10} fontSize={TEXT} fontWeight={700} className={VALUE}>
                {percentText(ofFirst(s.v))}
              </text>
              {k !== null && (
                <text x={x1 + 10} y={y + 22} fontSize={TEXT - 1} className={MUTED}>
                  ↓ {percentText(k)} kept
                </text>
              )}
            </g>
          )
        })}
      </svg>
      <div ref={d.legend} className={LEGEND}>
        <span>Each stage as a share of the first; ↓ what it kept of the stage before.</span>
        {hover !== null && stages[hover] && (
          <span className={READ_OUT} dir="auto">
            {stages[hover].label}: {format(stages[hover].v)}
            {unit} · {percentText(ofFirst(stages[hover].v))} of the first
          </span>
        )}
      </div>
    </figure>
  )
}

// ---- Waterfall ------------------------------------------------------------------------------

/**
 * How a figure moves from a start to an end, step by step: the first bar
 * stands on zero (the start), each change floats from where the one before
 * left off — up in green, down in red — and the end total stands on zero
 * after them all, dashed lines carrying the level across.
 */
export function WaterfallChart({ labels, values, unit, width, height, format }: { labels: string[]; values: (number | null)[]; unit: string; width: number; height: number; format: FigureFormat }) {
  const id = useId()
  const d = useDrawing(width, height)
  const readout = useReadout(d.figure)
  const hover = readout.at
  if (labels.length < 1) return <ChartEmpty height={height} />
  let run = 0
  const steps = labels.map((label, i) => {
    const v = values[i] ?? 0
    const from = run
    run += v
    return { label, v, from, to: run, kind: i === 0 ? ('start' as const) : v >= 0 ? ('up' as const) : ('down' as const) }
  })
  const bars = [...steps, { label: 'Total', v: run, from: 0, to: run, kind: 'total' as const }]
  const levels = bars.flatMap((b) => [b.from, b.to])
  const axis = niceBounds(Math.min(0, ...levels), Math.max(0, ...levels), true)
  const W = width
  const n = bars.length
  const plotRight = W - 8
  const roughSlot = (plotRight - 60) / n
  const tilt = bars.some((b) => b.label.length * CHAR_WIDTH + 6 > roughSlot)
  const x0 = Math.max(axisRoom(axis, unit, format), tilt ? slantRoom(bars.map((b) => cut(b.label, 20)), plotRight, CHAR_WIDTH, TEXT) : 0)
  const x1 = plotRight
  const slot = (x1 - x0) / n
  const barW = Math.min(48, slot * 0.64)
  const longest = Math.max(...bars.map((b) => cut(b.label, 20).length))
  const bottom = tilt ? Math.ceil(longest * CHAR_WIDTH * 0.58 + 18) : 22
  const H = Math.max(height, 160)
  const y0 = 18
  const y1 = H - bottom
  const xAt = (i: number) => x0 + slot * i + slot / 2
  const yAt = (v: number) => y1 - ((y1 - y0) * (v - axis.min)) / (axis.max - axis.min)
  const signed = (b: (typeof bars)[number]) => (b.kind === 'up' ? `+${format(b.v)}${unit}` : `${format(b.v)}${unit}`)
  const FILL = { start: 'fill-brand-500', up: 'fill-emerald-500', down: 'fill-rose-500', total: 'fill-brand-700 dark:fill-brand-400' }
  return (
    <figure ref={d.figureRef} className={d.figureClass}>
      <svg viewBox={`0 0 ${W} ${H}`} className={d.svgClass} role="img" aria-labelledby={`${id}-t`} {...readout.svg}>
        <title id={`${id}-t`}>{bars.map((b) => `${b.label}: ${signed(b)}`).join(', ')}</title>
        <Grid x0={x0} x1={x1} y0={y0} y1={y1} min={axis.min} max={axis.max} steps={axis.steps} unit={unit} format={format} fontSize={TEXT} />
        {bars.map((b, i) => {
          const hi = Math.max(b.from, b.to)
          const lo = Math.min(b.from, b.to)
          const x = xAt(i) - barW / 2
          const next = bars[i + 1]
          return (
            <g key={`${b.label}-${i}`} {...readout.mark(i)} className={cn('transition-opacity', hover !== null && hover !== i && 'opacity-50')}>
              <rect x={xAt(i) - slot / 2} y={y0} width={slot} height={y1 - y0} fill="transparent" />
              <rect x={x} y={yAt(hi)} width={barW} height={Math.max(1, yAt(lo) - yAt(hi))} rx={3} className={FILL[b.kind]} />
              {next && b.kind !== 'total' && <line x1={x + barW} x2={xAt(i + 1) - barW / 2} y1={yAt(b.to)} y2={yAt(b.to)} className="pointer-events-none stroke-slate-400" strokeDasharray="3 3" />}
              <text
                x={xAt(i)}
                y={b.kind === 'down' ? yAt(lo) + 12 : yAt(hi) - 5}
                textAnchor="middle"
                fontSize={TEXT}
                fontWeight={700}
                className={cn(VALUE, LABEL_HALO)}
                strokeWidth={3}
                style={{ paintOrder: 'stroke' }}
              >
                {signed(b)}
              </text>
              {tilt ? (
                <text x={xAt(i)} y={y1 + 12} textAnchor="end" fontSize={TEXT} transform={`rotate(-35 ${xAt(i)} ${y1 + 12})`} className={b.kind === 'total' ? 'fill-slate-800 font-semibold dark:fill-slate-100' : MUTED}>
                  {cut(b.label, 20)}
                </text>
              ) : (
                <text x={xAt(i)} y={y1 + 14} textAnchor="middle" fontSize={TEXT} className={b.kind === 'total' ? 'fill-slate-800 font-semibold dark:fill-slate-100' : MUTED}>
                  {b.label}
                </text>
              )}
            </g>
          )
        })}
      </svg>
      <div ref={d.legend} className={LEGEND}>
        <span className="inline-flex items-center gap-1.5">
          <Swatch className="fill-brand-500" /> Start
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Swatch className="fill-emerald-500" /> Up
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Swatch className="fill-rose-500" /> Down
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Swatch className="fill-brand-700" /> Total
        </span>
        {hover !== null && bars[hover] && (
          <span className={READ_OUT} dir="auto">
            {bars[hover].label}: {signed(bars[hover])}
            {bars[hover].kind !== 'total' && bars[hover].kind !== 'start' ? ` → ${format(bars[hover].to)}${unit}` : ''}
          </span>
        )}
      </div>
    </figure>
  )
}

// ---- Gantt --------------------------------------------------------------------------------

const HOUR = 3_600_000
const DAY = 24 * HOUR
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const two = (n: number) => String(n).padStart(2, '0')
/** A wall-clock instant (parseChartDate's) as words: "Oct 7", "Oct 7, 08:00", "Oct 7, 2027". */
export function wallText(ms: number, time: boolean, year = false): string {
  const t = new Date(ms)
  const day = `${MONTHS[t.getUTCMonth()]} ${t.getUTCDate()}${year ? `, ${t.getUTCFullYear()}` : ''}`
  return time ? `${day}, ${two(t.getUTCHours())}:${two(t.getUTCMinutes())}` : day
}

/** How long a bar lasts, in days for days and in hours (and days) for times. */
export function lastsText(start: number, end: number, dateOnly: boolean): string {
  const ms = Math.max(0, end - start)
  if (dateOnly) {
    const days = Math.round(ms / DAY)
    return `${days} ${days === 1 ? 'day' : 'days'}`
  }
  const hours = ms / HOUR
  if (hours < 48) return `${Number(hours.toFixed(1))} h`
  const days = Math.floor(hours / 24)
  const rest = Math.round(hours - days * 24)
  return rest ? `${days} d ${rest} h` : `${days} d`
}

/** The time axis's marks: hours, days, Mondays, months or years — as many as fit, at most about ten. */
export function ganttTicks(min: number, max: number, dateOnly: boolean, room: number): { at: number; text: string }[] {
  const span = Math.max(1, max - min)
  const most = Math.max(2, Math.min(10, Math.floor(room / 60)))
  const out: { at: number; text: string }[] = []
  const years = new Date(min).getUTCFullYear() !== new Date(max).getUTCFullYear()
  if (!dateOnly && span <= 3 * DAY) {
    const step = [1, 2, 3, 6, 12, 24].find((h) => span / (h * HOUR) <= most) ?? 24
    for (let t = Math.ceil(min / (step * HOUR)) * step * HOUR; t <= max; t += step * HOUR) {
      const d = new Date(t)
      out.push({ at: t, text: d.getUTCHours() === 0 ? wallText(t, false) : `${two(d.getUTCHours())}:00` })
    }
    return out
  }
  if (span <= 21 * DAY) {
    const step = [1, 2, 3, 7].find((k) => span / (k * DAY) <= most) ?? 7
    for (let t = Math.ceil(min / DAY) * DAY; t <= max; t += step * DAY) out.push({ at: t, text: wallText(t, false, years) })
    return out
  }
  if (span <= 120 * DAY) {
    // Mondays: 1970-01-05 was one.
    const monday = 4 * DAY
    const step = [1, 2, 4].find((k) => span / (k * 7 * DAY) <= most) ?? 4
    for (let t = monday + Math.ceil((min - monday) / (7 * DAY)) * 7 * DAY; t <= max; t += step * 7 * DAY) out.push({ at: t, text: wallText(t, false, years) })
    return out
  }
  const first = new Date(min)
  let y = first.getUTCFullYear()
  let m = first.getUTCMonth() + 1
  const months = span / (30 * DAY)
  const step = [1, 2, 3, 6, 12].find((k) => months / k <= most) ?? 12
  for (;;) {
    if (m >= 12) {
      y += Math.floor(m / 12)
      m %= 12
    }
    const t = Date.UTC(y, m, 1)
    if (t > max) break
    if (m % step === 0 || step === 1) out.push({ at: t, text: m === 0 || years ? `${MONTHS[m]} ${y}` : MONTHS[m] })
    m += 1
  }
  return out
}

/**
 * Bars in time: one row per x (its name at the left), a bar per result row
 * from its start to its end on a time axis along the top. Bars of one row that
 * overlap (plan and actual) lie on lanes of their own within it; bars that
 * follow one another share a lane. Coloured and named by the series; today
 * marked when it falls inside.
 */
export function GanttChart({ labels, gantt, fills, width, today }: { labels: string[]; gantt: GanttModel; fills: (k: number) => string; width: number; today?: number }) {
  const id = useId()
  const d = useDrawing(width, 200)
  const readout = useReadout(d.figure)
  const hover = readout.at
  const { bars, names, dateOnly } = gantt
  if (bars.length === 0 || labels.length === 0) return <ChartEmpty />
  // A little room either side, so a one-day bar is not lost at an edge.
  const pad = Math.max(dateOnly ? DAY / 2 : HOUR / 2, (gantt.max - gantt.min) * 0.02)
  const min = gantt.min - pad
  const max = gantt.max + pad
  // Each row's bars into lanes: a bar goes on the first lane it does not overlap.
  const laneOf = new Array<number>(bars.length).fill(0)
  const lanesIn = labels.map(() => 1)
  labels.forEach((_, row) => {
    const ends: number[] = []
    bars
      .map((b, k) => ({ b, k }))
      .filter((x) => x.b.lane === row)
      .sort((a, b) => a.b.start - b.b.start || a.k - b.k)
      .forEach(({ b, k }) => {
        let lane = ends.findIndex((e) => e <= b.start)
        if (lane < 0) {
          lane = Math.min(ends.length, 3)
          if (lane === ends.length) ends.push(b.end)
        }
        ends[lane] = Math.max(ends[lane] ?? 0, b.end)
        laneOf[k] = lane
      })
    lanesIn[row] = Math.max(1, ends.length)
  })
  const W = width
  const nameRoom = Math.min(Math.round(W * 0.32), Math.max(60, Math.max(...labels.map((l) => l.length)) * CHAR_WIDTH_BOLD + 14))
  const x0 = nameRoom
  const x1 = W - 12
  const barH = 12
  const laneH = 16
  const rowTop: number[] = []
  let y = 24
  labels.forEach((_, row) => {
    rowTop.push(y)
    y += lanesIn[row] * laneH + 8
  })
  const H = y + 4
  const xAt = (t: number) => x0 + ((x1 - x0) * (t - min)) / (max - min)
  const ticks = ganttTicks(min, max, dateOnly, x1 - x0)
  const maxChars = Math.floor((nameRoom - 12) / CHAR_WIDTH_BOLD)
  const showToday = today !== undefined && today >= min && today <= max
  const describe = (k: number) => {
    const b = bars[k]
    const shownEnd = dateOnly ? b.end - DAY : b.end
    return `${labels[b.lane]}${b.name ? ` · ${b.name}` : ''}: ${wallText(b.start, !dateOnly)} → ${wallText(shownEnd, !dateOnly)} (${lastsText(b.start, b.end, dateOnly)})`
  }
  return (
    <figure ref={d.figureRef} className={d.figureClass}>
      <svg viewBox={`0 0 ${W} ${H}`} className={d.svgClass} role="img" aria-labelledby={`${id}-t`} {...readout.svg}>
        <title id={`${id}-t`}>{bars.map((_, k) => describe(k)).join('; ')}</title>
        {labels.map((l, row) => (
          <g key={`${l}-${row}`}>
            {row % 2 === 1 && <rect x={0} y={rowTop[row] - 4} width={W} height={lanesIn[row] * laneH + 8} className="fill-slate-50 dark:fill-slate-800/40" />}
            <text x={x0 - 8} y={rowTop[row] + (lanesIn[row] * laneH) / 2 + 2} textAnchor="end" fontSize={TEXT + 1} fontWeight={600} className={NAME}>
              {cut(l, maxChars)}
            </text>
          </g>
        ))}
        <g className="text-muted" fontSize={TEXT}>
          {ticks.map((t) => (
            <g key={t.at}>
              <line x1={xAt(t.at)} x2={xAt(t.at)} y1={18} y2={H - 4} stroke="currentColor" strokeOpacity={0.18} strokeDasharray="3 3" />
              <text x={xAt(t.at)} y={12} textAnchor="middle" fill="currentColor">
                {t.text}
              </text>
            </g>
          ))}
        </g>
        {showToday && (
          <g className="pointer-events-none">
            <line x1={xAt(today!)} x2={xAt(today!)} y1={16} y2={H - 4} className="stroke-amber-500" strokeWidth={1.5} strokeDasharray="5 3" />
            <text x={xAt(today!) + 3} y={H - 6} fontSize={TEXT} fontWeight={700} className={cn('fill-amber-600 dark:fill-amber-400', LABEL_HALO)} strokeWidth={3} style={{ paintOrder: 'stroke' }}>
              Today
            </text>
          </g>
        )}
        {bars.map((b, k) => {
          const bx = xAt(b.start)
          const bw = Math.max(3, xAt(b.end) - bx)
          const by = rowTop[b.lane] + laneOf[k] * laneH + (laneH - barH) / 2
          const fits = b.name !== null && bw >= b.name.length * CHAR_WIDTH + 10
          return (
            <g key={k} {...readout.mark(k)} className={cn('transition-opacity', hover !== null && hover !== k && 'opacity-60')}>
              <rect x={bx} y={by} width={bw} height={barH} rx={3} className={names.length > 0 ? fills(b.color) : 'fill-brand-500'} stroke={hover === k ? 'currentColor' : 'none'} />
              {fits && (
                <text x={bx + 5} y={by + barH - 3} fontSize={TEXT - 1} fontWeight={600} className="pointer-events-none fill-white">
                  {b.name}
                </text>
              )}
            </g>
          )
        })}
      </svg>
      <div ref={d.legend} className={LEGEND}>
        {names.slice(0, 8).map((n, k) => (
          <span key={n} className="inline-flex items-center gap-1.5">
            <Swatch className={fills(k)} />
            <span dir="auto">{n}</span>
          </span>
        ))}
        {names.length > 8 && <span>+{names.length - 8} more</span>}
        {hover !== null && bars[hover] && (
          <span className={READ_OUT} dir="auto">
            {describe(hover)}
          </span>
        )}
      </div>
    </figure>
  )
}

// ---- Dumbbell -----------------------------------------------------------------------------

/** The most rows a dumbbell chart draws. */
export const DUMBBELL_MAX_ROWS = 30

/**
 * Two values on each row, joined: the first a blue dot, the second an amber
 * one, on an axis fitted to them (not from zero), with the difference — the
 * second less the first — at the end of the row.
 */
export function DumbbellChart({
  labels,
  first,
  second,
  names,
  unit,
  width,
  format,
  goal,
}: {
  labels: string[]
  first: (number | null)[]
  second: (number | null)[]
  names: [string, string]
  unit: string
  width: number
  format: FigureFormat
  goal?: number
}) {
  const id = useId()
  const d = useDrawing(width, 200)
  const readout = useReadout(d.figure)
  const hover = readout.at
  const rows = labels.slice(0, DUMBBELL_MAX_ROWS)
  const known = rows.flatMap((_, i) => [first[i], second[i]]).filter((v): v is number => v !== null && v !== undefined)
  if (rows.length === 0 || known.length === 0) return <ChartEmpty />
  const reach = goal === undefined ? known : [...known, goal]
  const axis = rangeAxis(Math.min(...reach), Math.max(...reach))
  const diff = (i: number) => (first[i] === null || first[i] === undefined || second[i] === null || second[i] === undefined ? null : second[i]! - first[i]!)
  const diffText = (i: number) => {
    const v = diff(i)
    return v === null ? '—' : `${v > 0 ? '+' : ''}${format(v)}${unit}`
  }
  const W = width
  const nameRoom = Math.min(Math.round(W * 0.34), Math.max(60, Math.max(...rows.map((l) => l.length)) * CHAR_WIDTH_BOLD + 14))
  const diffRoom = Math.min(Math.round(W * 0.2), Math.max(...rows.map((_, i) => diffText(i).length)) * CHAR_WIDTH_WIDE + 16)
  const x0 = nameRoom
  const x1 = W - diffRoom
  const rowH = 24
  const y0 = 22
  const H = y0 + rows.length * rowH + 6
  const xAt = (v: number) => x0 + ((x1 - x0) * (v - axis.min)) / (axis.max - axis.min)
  const maxChars = Math.floor((nameRoom - 12) / CHAR_WIDTH_BOLD)
  return (
    <figure ref={d.figureRef} className={d.figureClass}>
      <svg viewBox={`0 0 ${W} ${H}`} className={d.svgClass} role="img" aria-labelledby={`${id}-t`} {...readout.svg}>
        <title id={`${id}-t`}>{rows.map((l, i) => `${l}: ${names[0]} ${first[i] === null ? '—' : format(first[i]!)}${unit}, ${names[1]} ${second[i] === null ? '—' : format(second[i]!)}${unit}`).join('; ')}</title>
        <g className="text-muted" fontSize={TEXT}>
          {Array.from({ length: axis.steps + 1 }, (_, i) => {
            const v = tickAt(axis.min, axis.max, axis.steps, i)
            return (
              <g key={i}>
                <line x1={xAt(v)} x2={xAt(v)} y1={y0 - 4} y2={H - 4} stroke="currentColor" strokeOpacity={v === 0 ? 0.6 : 0.18} strokeDasharray={v === 0 ? undefined : '3 3'} />
                <text x={xAt(v)} y={y0 - 8} textAnchor="middle" fill="currentColor">
                  {format(v)}
                  {unit}
                </text>
              </g>
            )
          })}
        </g>
        {goal !== undefined && <line x1={xAt(goal)} x2={xAt(goal)} y1={y0 - 2} y2={H - 4} className="pointer-events-none stroke-amber-500" strokeWidth={1.5} strokeDasharray="6 4" />}
        {rows.map((l, i) => {
          const mid = y0 + i * rowH + rowH / 2
          const a = first[i]
          const b = second[i]
          return (
            <g key={`${l}-${i}`} {...readout.mark(i)} className={cn('transition-opacity', hover !== null && hover !== i && 'opacity-50')}>
              <rect x={0} y={mid - rowH / 2} width={W} height={rowH} fill="transparent" />
              <text x={x0 - 8} y={mid + 4} textAnchor="end" fontSize={TEXT + 1} fontWeight={600} className={NAME}>
                {cut(l, maxChars)}
              </text>
              {a !== null && a !== undefined && b !== null && b !== undefined && <line x1={xAt(a)} x2={xAt(b)} y1={mid} y2={mid} className="stroke-slate-300 dark:stroke-slate-600" strokeWidth={4} strokeLinecap="round" />}
              {a !== null && a !== undefined && <circle cx={xAt(a)} cy={mid} r={5.5} className="fill-brand-500 stroke-white dark:stroke-slate-900" strokeWidth={1.5} />}
              {b !== null && b !== undefined && <circle cx={xAt(b)} cy={mid} r={5.5} className="fill-amber-500 stroke-white dark:stroke-slate-900" strokeWidth={1.5} />}
              <text x={x1 + 10} y={mid + 4} fontSize={TEXT} fontWeight={700} className={VALUE}>
                {diffText(i)}
              </text>
            </g>
          )
        })}
      </svg>
      <div ref={d.legend} className={LEGEND}>
        <span className="inline-flex items-center gap-1.5">
          <Swatch className="fill-brand-500" /> <span dir="auto">{names[0]}</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Swatch className="fill-amber-500" /> <span dir="auto">{names[1]}</span>
        </span>
        <span>
          Difference: <span dir="auto">{names[1]}</span> − <span dir="auto">{names[0]}</span>
        </span>
        {goal !== undefined && (
          <span>
            Target {format(goal)}
            {unit}
          </span>
        )}
        {labels.length > rows.length && <span>The first {rows.length} of {labels.length} are drawn; the table has them all.</span>}
        {hover !== null && rows[hover] !== undefined && (
          <span className={READ_OUT} dir="auto">
            {rows[hover]}: {first[hover] === null ? '—' : `${format(first[hover]!)}${unit}`} → {second[hover] === null ? '—' : `${format(second[hover]!)}${unit}`} ({diffText(hover)})
          </span>
        )}
      </div>
    </figure>
  )
}

// ---- Treemap ------------------------------------------------------------------------------

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Tiles for values, filling a box: squarified (Bruls, Huizing, van Wijk) — the
 * largest first, laid in rows along the shorter side while each row added
 * keeps the tiles nearer square. Each tile's area is its share of the box; a
 * value of nothing gets an empty tile. In the order given.
 */
export function squarify(values: readonly number[], box: Box): Box[] {
  const out: (Box | undefined)[] = new Array(values.length).fill(undefined)
  const items = values
    .map((v, i) => ({ v: Number.isFinite(v) ? Math.max(0, v) : 0, i }))
    .filter((o) => o.v > 0)
    .sort((a, b) => b.v - a.v || a.i - b.i)
  const total = items.reduce((t, o) => t + o.v, 0)
  const empty = { x: box.x, y: box.y, w: 0, h: 0 }
  if (total <= 0 || box.w <= 0 || box.h <= 0) return values.map(() => empty)
  const scale = (box.w * box.h) / total
  const areas = items.map((o) => ({ a: o.v * scale, i: o.i }))
  const worst = (row: readonly { a: number }[], side: number) => {
    const s = row.reduce((t, r) => t + r.a, 0)
    const hi = Math.max(...row.map((r) => r.a))
    const lo = Math.min(...row.map((r) => r.a))
    return Math.max((side * side * hi) / (s * s), (s * s) / (side * side * lo))
  }
  const place = (row: readonly { a: number; i: number }[], b: Box): Box => {
    const s = row.reduce((t, r) => t + r.a, 0)
    if (b.w >= b.h) {
      const cw = s / b.h
      let yy = b.y
      for (const r of row) {
        const hh = r.a / cw
        out[r.i] = { x: b.x, y: yy, w: cw, h: hh }
        yy += hh
      }
      return { x: b.x + cw, y: b.y, w: Math.max(0, b.w - cw), h: b.h }
    }
    const rh = s / b.w
    let xx = b.x
    for (const r of row) {
      const ww = r.a / rh
      out[r.i] = { x: xx, y: b.y, w: ww, h: rh }
      xx += ww
    }
    return { x: b.x, y: b.y + rh, w: b.w, h: Math.max(0, b.h - rh) }
  }
  let rest: Box = { ...box }
  let row: { a: number; i: number }[] = []
  for (const item of areas) {
    const side = Math.min(rest.w, rest.h)
    if (row.length === 0 || worst([...row, item], side) <= worst(row, side)) {
      row.push(item)
      continue
    }
    rest = place(row, rest)
    row = [item]
  }
  if (row.length > 0) place(row, rest)
  return out.map((b) => b ?? empty)
}

/**
 * The parts of a whole as tiles, each as large as its share: grouped by the
 * series when there is one (each group a block of its colour, its tiles
 * inside it), else each tile its own colour. A tile large enough carries its
 * name, its figure and its share.
 */
export function TreemapChart({ labels, series, grouped, fills, unit, width, format }: { labels: string[]; series: { label: string; values: (number | null)[] }[]; grouped: boolean; fills: (k: number) => string; unit: string; width: number; format: FigureFormat }) {
  const id = useId()
  const W = width
  const H = Math.round(Math.max(220, Math.min(380, W * 0.55)))
  const d = useDrawing(width, H)
  const readout = useReadout(d.figure)
  const hover = readout.at
  type Tile = { name: string; group: string; k: number; v: number; box: Box }
  const tiles: Tile[] = []
  const groups = series.map((s, k) => ({ label: s.label, k, total: s.values.reduce<number>((t, v) => t + (v !== null && v > 0 ? v : 0), 0) }))
  const all = groups.reduce((t, g) => t + g.total, 0)
  if (!(all > 0)) return <ChartEmpty height={H} />
  const frame: Box = { x: 0, y: 0, w: W, h: H }
  if (grouped) {
    const blocks = squarify(groups.map((g) => g.total), frame)
    groups.forEach((g, gi) => {
      const b = blocks[gi]
      if (b.w <= 0 || b.h <= 0) return
      const inner = squarify(series[gi].values.map((v) => (v !== null && v > 0 ? v : 0)), b)
      labels.forEach((name, i) => {
        const v = series[gi].values[i]
        if (v !== null && v > 0) tiles.push({ name, group: g.label, k: g.k, v, box: inner[i] })
      })
    })
  } else {
    const values = series[0].values.map((v) => (v !== null && v > 0 ? v : 0))
    const boxes = squarify(values, frame)
    labels.forEach((name, i) => {
      if (values[i] > 0) tiles.push({ name, group: '', k: i, v: values[i], box: boxes[i] })
    })
  }
  const share = (v: number) => percentText((v / all) * 100)
  return (
    <figure ref={d.figureRef} className={d.figureClass}>
      <svg viewBox={`0 0 ${W} ${H}`} className={d.svgClass} role="img" aria-labelledby={`${id}-t`} {...readout.svg}>
        <title id={`${id}-t`}>{tiles.map((t) => `${t.group ? `${t.group} · ` : ''}${t.name}: ${format(t.v)}${unit} (${share(t.v)})`).join(', ')}</title>
        {tiles.map((t, i) => {
          const { x, y, w, h } = t.box
          const chars = Math.floor((w - 10) / CHAR_WIDTH)
          const named = w >= 48 && h >= 24 && chars >= 3
          const figured = named && h >= 40
          return (
            <g key={`${t.group}-${t.name}-${i}`} {...readout.mark(i)}>
              <rect
                x={x + 1}
                y={y + 1}
                width={Math.max(0, w - 2)}
                height={Math.max(0, h - 2)}
                rx={3}
                className={fills(t.k)}
                fillOpacity={hover === null || hover === i ? 0.92 : 0.55}
                stroke={hover === i ? 'currentColor' : 'none'}
              />
              {named && (
                <text x={x + 6} y={y + 15} fontSize={TEXT + 1} fontWeight={700} className="pointer-events-none fill-white">
                  {cut(t.name, chars)}
                </text>
              )}
              {figured && (
                <text x={x + 6} y={y + 29} fontSize={TEXT - 1} className="pointer-events-none fill-white" fillOpacity={0.9}>
                  {cut(`${format(t.v)}${unit} · ${share(t.v)}`, chars)}
                </text>
              )}
            </g>
          )
        })}
      </svg>
      <div ref={d.legend} className={LEGEND}>
        {grouped &&
          groups
            .filter((g) => g.total > 0)
            .map((g) => (
              <span key={g.label} className="inline-flex items-center gap-1.5">
                <Swatch className={fills(g.k)} />
                <span dir="auto">{g.label}</span>
                <span className="tabular-nums">
                  {format(g.total)}
                  {unit} · {share(g.total)}
                </span>
              </span>
            ))}
        <span>
          Total {format(all)}
          {unit}
        </span>
        {hover !== null && tiles[hover] && (
          <span className={READ_OUT} dir="auto">
            {tiles[hover].group ? `${tiles[hover].group} · ` : ''}
            {tiles[hover].name}: {format(tiles[hover].v)}
            {unit} ({share(tiles[hover].v)})
          </span>
        )}
      </div>
    </figure>
  )
}
