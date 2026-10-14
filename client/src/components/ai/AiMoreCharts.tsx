// ============================================================================
// §20 — more of the assistant's charts (beside ./AiChartKinds,
// ./AiPlanCharts and ./AiQualityCharts): gauges, each figure on a dial to its
// full scale against its target (green on the good side of it, rose on the
// other); a radar, several measures around a circle, one shape per item; a
// bubble chart, a scatter sized by a third measure; a sankey, quantities
// flowing from stage to stage; a calendar, a measure per day laid out in
// weeks. Hand-made SVG at the width shown, the dashboard's palette and
// read-outs, both themes.
// ============================================================================

import { useId, useMemo } from 'react'
import type { AiChartBetter } from '@qc/shared/ai'
import { cn } from '@/lib/utils'
import { CHAR_WIDTH } from '@/components/dashboard/labels'
import { ChartEmpty, GoalLine, Grid, LABEL_HALO, LEGEND, axisRoom, tickAt, useDrawing, useReadout, type FigureFormat } from '@/components/dashboard/charts'
import { Swatch, rangeAxis } from './AiChartKinds'
import type { ChartSeries } from './chartData'
import { calendarOf, sankeyNodes, type SankeyLink } from './chartStats'

const TEXT = 10
const MUTED = 'fill-muted'
const NAME = 'fill-slate-600 dark:fill-slate-300'
const VALUE = 'fill-slate-800 dark:fill-slate-100'
const READ_OUT = 'ml-auto font-semibold tabular-nums text-slate-700 dark:text-slate-200'
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s)

// ---- Gauges ---------------------------------------------------------------------------------

/** A point on a dial of radius r centred at (cx, cy), at a share of its sweep (0 left, 1 right, over the top). */
const dialAt = (cx: number, cy: number, r: number, share: number) => {
  const a = Math.PI * (1 - Math.min(1, Math.max(0, share)))
  return { x: cx + r * Math.cos(a), y: cy - r * Math.sin(a) }
}
const arc = (cx: number, cy: number, r: number, from: number, to: number) => {
  const a = dialAt(cx, cy, r, from)
  const b = dialAt(cx, cy, r, to)
  return `M ${a.x} ${a.y} A ${r} ${r} 0 0 1 ${b.x} ${b.y}`
}

/**
 * Each figure on a half-dial from 0 to the full scale, its arc filled to the figure; with a goal, a mark at it and
 * the arc green on the good side (above it, or below for `better` lower), rose on the other.
 */
export function GaugeChart({ labels, values, max, goal, better = 'higher', label, unit, width, format }: { labels: string[]; values: (number | null)[]; max: number; goal?: number; better?: AiChartBetter; label: string; unit: string; width: number; format: FigureFormat }) {
  const id = useId()
  const n = labels.length
  // Dials need room for their scale and target: one a row on the narrowest drawing, two on a phone, three on a page.
  const per = Math.min(n, width < 360 ? 1 : width < 620 ? 2 : 3)
  const lines = Math.ceil(n / per)
  const cw = width / per
  const r = Math.min(cw * 0.36, 92)
  const ch = r + 62
  const H = lines * ch + 6
  const d = useDrawing(width, H)
  if (n === 0) return <ChartEmpty height={160} />
  const good = (v: number) => (goal === undefined ? null : better === 'lower' ? v <= goal : v >= goal)
  return (
    <figure ref={d.figureRef} className={d.figureClass}>
      <svg viewBox={`0 0 ${width} ${H}`} className={d.svgClass} role="img" aria-labelledby={`${id}-t`}>
        <title id={`${id}-t`}>{labels.map((l, i) => `${l}: ${values[i] === null ? '—' : `${format(values[i]!)}${unit}`}`).join(', ') + (goal !== undefined ? `; target ${format(goal)}${unit}` : '')}</title>
        {labels.map((l, i) => {
          const v = values[i]
          const cx = cw * (i % per) + cw / 2
          const cy = Math.floor(i / per) * ch + r + 14
          const share = v === null ? 0 : v / max
          const ok = v === null ? null : good(v)
          const tick = goal === undefined ? null : [dialAt(cx, cy, r - 16, goal / max), dialAt(cx, cy, r + 6, goal / max)]
          return (
            <g key={`${l}-${i}`}>
              <path d={arc(cx, cy, r - 6, 0, 1)} fill="none" strokeWidth={14} strokeLinecap="round" className="stroke-slate-200 dark:stroke-slate-700" />
              {v !== null && share > 0 && (
                <path d={arc(cx, cy, r - 6, 0, share)} fill="none" strokeWidth={14} strokeLinecap="round" className={ok === null ? 'stroke-brand-500' : ok ? 'stroke-emerald-500' : 'stroke-rose-500'} />
              )}
              {tick && <line x1={tick[0].x} y1={tick[0].y} x2={tick[1].x} y2={tick[1].y} strokeWidth={3} className="stroke-amber-500" />}
              <text x={cx} y={cy - 4} textAnchor="middle" fontSize={Math.max(14, Math.min(24, r / 3.4))} fontWeight={700} className={VALUE}>
                {v === null ? '—' : `${format(v)}${unit}`}
              </text>
              <text x={cx - r + 6} y={cy + 14} textAnchor="middle" fontSize={TEXT} className={MUTED}>
                0
              </text>
              <text x={cx + r - 6} y={cy + 14} textAnchor="middle" fontSize={TEXT} className={MUTED}>
                {format(max)}
              </text>
              {goal !== undefined && (
                <text x={cx} y={cy + 14} textAnchor="middle" fontSize={TEXT} fontWeight={600} className="fill-amber-600 dark:fill-amber-400">
                  Target {format(goal)}
                  {unit}
                </text>
              )}
              <text x={cx} y={cy + 32} textAnchor="middle" fontSize={TEXT + 1} fontWeight={600} className={NAME}>
                {cut(n === 1 && l === '(blank)' ? label : l, Math.floor(cw / CHAR_WIDTH) - 2)}
              </text>
            </g>
          )
        })}
      </svg>
      <div ref={d.legend} className={LEGEND}>
        {goal !== undefined && <span>{better === 'lower' ? 'Lower is better: green at or under the target' : 'Higher is better: green at or over the target'}</span>}
      </div>
    </figure>
  )
}

// ---- Radar ----------------------------------------------------------------------------------

/** Measures around a circle (one axis each), one shape per item, all on one scale from 0 at the centre. */
export function RadarChart({ labels, series, strokes, fills, unit, width, format }: { labels: string[]; series: ChartSeries[]; strokes: (k: number) => string; fills: (k: number) => string; unit: string; width: number; format: FigureFormat }) {
  const id = useId()
  const n = labels.length
  const H = Math.round(Math.min(380, Math.max(260, width * 0.62)))
  const d = useDrawing(width, H)
  const readout = useReadout(d.figure)
  const hover = readout.at
  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null))
  if (n < 3 || all.length === 0) return <ChartEmpty height={H} />
  const top = rangeAxis(0, Math.max(...all))
  const cx = width / 2
  const cy = H / 2 + 4
  const room = Math.min(110, Math.max(...labels.map((l) => l.length)) * CHAR_WIDTH + 10)
  const R = Math.max(60, Math.min(H / 2 - 26, width / 2 - room))
  const at = (i: number, v: number) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / n
    const r = (R * Math.max(0, v)) / top.max
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }
  }
  return (
    <figure ref={d.figureRef} className={d.figureClass}>
      <svg viewBox={`0 0 ${width} ${H}`} className={d.svgClass} role="img" aria-labelledby={`${id}-t`} {...readout.svg}>
        <title id={`${id}-t`}>{series.map((s) => `${s.label}: ${labels.map((l, i) => `${l} ${s.values[i] === null ? '—' : format(s.values[i]!)}${unit}`).join(', ')}`).join('; ')}</title>
        {Array.from({ length: top.steps }, (_, k) => {
          const v = tickAt(top.min, top.max, top.steps, k + 1)
          const ring = labels.map((_, i) => at(i, v))
          return (
            <g key={k}>
              <polygon points={ring.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" strokeWidth={1} className="stroke-slate-200 dark:stroke-slate-700" />
              <text x={cx + 3} y={at(0, v).y + 10} fontSize={TEXT - 1} className={MUTED}>
                {format(v)}
                {unit}
              </text>
            </g>
          )
        })}
        {labels.map((l, i) => {
          const end = at(i, top.max)
          const name = at(i, top.max * 1.1)
          const anchor = Math.abs(name.x - cx) < 8 ? 'middle' : name.x > cx ? 'start' : 'end'
          return (
            <g key={`${l}-${i}`} {...readout.mark(i)}>
              <line x1={cx} y1={cy} x2={end.x} y2={end.y} strokeWidth={1} className="stroke-slate-200 dark:stroke-slate-700" />
              <text x={name.x} y={name.y + 3.5} textAnchor={anchor} fontSize={TEXT + 1} fontWeight={hover === i ? 700 : 600} className={NAME}>
                {cut(l, Math.floor(room / CHAR_WIDTH))}
              </text>
            </g>
          )
        })}
        {series.map((s, k) => {
          const pts = labels.map((_, i) => at(i, s.values[i] ?? 0))
          return (
            <g key={s.label} className="pointer-events-none">
              <polygon points={pts.map((p) => `${p.x},${p.y}`).join(' ')} strokeWidth={2} strokeLinejoin="round" className={cn(fills(k), strokes(k))} fillOpacity={0.14} />
              {pts.map((p, i) => (
                <circle key={i} cx={p.x} cy={p.y} r={hover === i ? 4.5 : 3} className={fills(k)} />
              ))}
            </g>
          )
        })}
      </svg>
      <div ref={d.legend} className={LEGEND}>
        {series.map((s, k) => (
          <span key={s.label} className="inline-flex items-center gap-1.5">
            <Swatch className={strokes(k)} line />
            <span dir="auto">{s.label}</span>
          </span>
        ))}
        {hover !== null && labels[hover] !== undefined && (
          <span className={READ_OUT} dir="auto">
            {labels[hover]}: {series.map((s) => `${series.length > 1 ? `${s.label} ` : ''}${s.values[hover] === null ? '—' : `${format(s.values[hover]!)}${unit}`}`).join(' · ')}
          </span>
        )}
      </div>
    </figure>
  )
}

// ---- Bubbles --------------------------------------------------------------------------------

/** A scatter whose points are sized (by area) by a third measure, each named when it has room. */
export function BubbleChart({ bubbles, fills, xName, yName, sizeName, unit, width, height, format, goal }: { bubbles: { x: number; y: number; size: number; label: string }[]; fills: (k: number) => string; xName: string; yName: string; sizeName: string; unit: string; width: number; height: number; format: FigureFormat; goal?: number }) {
  const id = useId()
  const H = height + 30
  const d = useDrawing(width, H)
  const readout = useReadout(d.figure)
  const hover = readout.at
  if (bubbles.length < 2) return <ChartEmpty height={H} />
  const biggest = Math.max(...bubbles.map((b) => b.size)) || 1
  const rMax = Math.min(34, width / 14)
  const rOf = (s: number) => Math.max(3, rMax * Math.sqrt(s / biggest))
  const xs = rangeAxis(Math.min(...bubbles.map((b) => b.x)), Math.max(...bubbles.map((b) => b.x)))
  const yReach = bubbles.map((b) => b.y).concat(goal === undefined ? [] : [goal])
  const ys = rangeAxis(Math.min(...yReach), Math.max(...yReach))
  const x0 = Math.min(Math.round(width * 0.3), axisRoom(ys, unit, format) + 16)
  const x1 = width - rMax - 6
  const y0 = rMax + 4
  const y1 = H - 46
  const xAt = (v: number) => x0 + ((x1 - x0) * (v - xs.min)) / (xs.max - xs.min)
  const yAt = (v: number) => y1 - ((y1 - y0) * (v - ys.min)) / (ys.max - ys.min)
  // The largest drawn first, so a small one stays in sight over it.
  const order = bubbles.map((_, i) => i).sort((a, b) => bubbles[b].size - bubbles[a].size)
  const picked = hover !== null ? bubbles[hover] : null
  return (
    <figure ref={d.figureRef} className={d.figureClass}>
      <svg viewBox={`0 0 ${width} ${H}`} className={d.svgClass} role="img" aria-labelledby={`${id}-t`} {...readout.svg}>
        <title id={`${id}-t`}>{`${yName} against ${xName}, sized by ${sizeName}: ${bubbles.length} bubbles`}</title>
        <Grid x0={x0} x1={x1} y0={y0} y1={y1} min={ys.min} max={ys.max} steps={ys.steps} unit={unit} format={format} fontSize={TEXT} />
        <g className="text-muted" fontSize={TEXT}>
          {Array.from({ length: xs.steps + 1 }, (_, i) => {
            const v = tickAt(xs.min, xs.max, xs.steps, i)
            return (
              <text key={i} x={xAt(v)} y={y1 + 14} textAnchor="middle" fill="currentColor">
                {format(v)}
              </text>
            )
          })}
          <text x={(x0 + x1) / 2} y={y1 + 32} textAnchor="middle" fontWeight={600} fill="currentColor">
            {xName}
          </text>
          <text x={10} y={(y0 + y1) / 2} textAnchor="middle" fontWeight={600} fill="currentColor" transform={`rotate(-90 10 ${(y0 + y1) / 2})`}>
            {yName}
          </text>
        </g>
        {goal !== undefined && <GoalLine x0={x0} x1={x1} y={yAt(goal)} text={`Target ${format(goal)}${unit}`} />}
        {order.map((i) => {
          const b = bubbles[i]
          const r = rOf(b.size)
          return (
            <g key={i} {...readout.mark(i)}>
              <circle cx={xAt(b.x)} cy={yAt(b.y)} r={r} strokeWidth={hover === i ? 2 : 1} className={cn(fills(i), 'stroke-white dark:stroke-slate-900')} fillOpacity={hover === null || hover === i ? 0.7 : 0.3} />
              {b.label && r >= 12 && (
                <text x={xAt(b.x)} y={yAt(b.y) + 3.5} textAnchor="middle" fontSize={TEXT} fontWeight={600} strokeWidth={3} style={{ paintOrder: 'stroke' }} className={cn('pointer-events-none', VALUE, LABEL_HALO)}>
                  {cut(b.label, Math.floor((r * 2.6) / CHAR_WIDTH))}
                </text>
              )}
            </g>
          )
        })}
      </svg>
      <div ref={d.legend} className={LEGEND}>
        <span>Bubble size: {sizeName}</span>
        {picked && (
          <span className={READ_OUT} dir="auto">
            {picked.label ? `${picked.label} · ` : ''}
            {xName} {format(picked.x)} · {yName} {format(picked.y)}
            {unit} · {sizeName} {format(picked.size)}
          </span>
        )}
      </div>
    </figure>
  )
}

// ---- Sankey ---------------------------------------------------------------------------------

/** Stages in columns by how far along they are, each as tall as what flows through it, the flows as bands between them. */
export function SankeyChart({ links, fills, unit, width, format, label }: { links: SankeyLink[]; fills: (k: number) => string; unit: string; width: number; format: FigureFormat; label: string }) {
  const id = useId()
  const nodes = useMemo(() => sankeyNodes(links), [links])
  const columns = nodes.length > 0 ? Math.max(...nodes.map((n) => n.column)) + 1 : 1
  const busiest = Math.max(1, ...Array.from({ length: columns }, (_, c) => nodes.filter((n) => n.column === c).length))
  const H = Math.round(Math.max(220, Math.min(460, busiest * 46)))
  const d = useDrawing(width, H)
  const readout = useReadout(d.figure)
  const hover = readout.at
  if (nodes.length < 2) return <ChartEmpty height={H} />
  const nameRoom = Math.min(130, Math.max(...nodes.map((n) => n.name.length)) * CHAR_WIDTH + 12)
  const x0 = 6
  const x1 = width - nameRoom
  const nodeW = 12
  const gap = 10
  const colX = (c: number) => (columns === 1 ? x0 : x0 + ((x1 - x0 - nodeW) * c) / (columns - 1))
  // One scale for every column: the fullest column fills the height.
  const totals = Array.from({ length: columns }, (_, c) => nodes.filter((n) => n.column === c).reduce((t, n) => t + n.value, 0))
  const counts = Array.from({ length: columns }, (_, c) => nodes.filter((n) => n.column === c).length)
  const k = Math.min(...totals.map((t, c) => (H - 16 - gap * (counts[c] - 1)) / (t || 1)))
  const box = new Map<string, { x: number; y: number; h: number; k: number }>()
  for (let c = 0; c < columns; c++) {
    const inCol = nodes.map((n, i) => ({ n, i })).filter(({ n }) => n.column === c)
    const used = inCol.reduce((t, { n }) => t + n.value * k, 0) + gap * (inCol.length - 1)
    let y = (H - used) / 2
    for (const { n, i } of inCol) {
      box.set(n.name, { x: colX(c), y, h: Math.max(2, n.value * k), k: i })
      y += n.value * k + gap
    }
  }
  // Where each band leaves its stage and reaches the next, stacked in the order given.
  const outAt = new Map<string, number>()
  const inAt = new Map<string, number>()
  const bands = links.map((l, i) => {
    const a = box.get(l.from)!
    const b = box.get(l.to)!
    const h = l.value * k
    const ya = a.y + (outAt.get(l.from) ?? 0)
    const yb = b.y + (inAt.get(l.to) ?? 0)
    outAt.set(l.from, (outAt.get(l.from) ?? 0) + h)
    inAt.set(l.to, (inAt.get(l.to) ?? 0) + h)
    const xa = a.x + nodeW
    const xb = b.x
    const mid = (xa + xb) / 2
    return { i, l, color: a.k, d: `M ${xa} ${ya} C ${mid} ${ya}, ${mid} ${yb}, ${xb} ${yb} L ${xb} ${yb + h} C ${mid} ${yb + h}, ${mid} ${ya + h}, ${xa} ${ya + h} Z` }
  })
  const picked = hover !== null ? links[hover] : null
  return (
    <figure ref={d.figureRef} className={d.figureClass}>
      <svg viewBox={`0 0 ${width} ${H}`} className={d.svgClass} role="img" aria-labelledby={`${id}-t`} {...readout.svg}>
        <title id={`${id}-t`}>{`${label}: ${links.map((l) => `${l.from} to ${l.to} ${format(l.value)}${unit}`).join(', ')}`}</title>
        {bands.map((b) => (
          <path key={b.i} d={b.d} className={fills(b.color)} fillOpacity={hover === null ? 0.32 : hover === b.i ? 0.6 : 0.12} {...readout.mark(b.i)} />
        ))}
        {nodes.map((n) => {
          const b = box.get(n.name)!
          const last = n.column === columns - 1
          return (
            <g key={n.name} className="pointer-events-none">
              <rect x={b.x} y={b.y} width={nodeW} height={b.h} rx={2} className={fills(b.k)} />
              <text x={last ? b.x + nodeW + 5 : b.x + nodeW + 5} y={b.y + b.h / 2 + 3.5} fontSize={TEXT + 1} fontWeight={600} strokeWidth={3} style={{ paintOrder: 'stroke' }} className={cn(NAME, LABEL_HALO)}>
                {cut(n.name, Math.floor((last ? nameRoom : 140) / CHAR_WIDTH))}
              </text>
              {b.h >= 26 && (
                <text x={b.x + nodeW + 5} y={b.y + b.h / 2 + 16} fontSize={TEXT} strokeWidth={3} style={{ paintOrder: 'stroke' }} className={cn(MUTED, LABEL_HALO)}>
                  {format(n.value)}
                  {unit}
                </text>
              )}
            </g>
          )
        })}
      </svg>
      <div ref={d.legend} className={LEGEND}>
        <span>Band width: {label}</span>
        {picked && (
          <span className={READ_OUT} dir="auto">
            {picked.from} → {picked.to}: {format(picked.value)}
            {unit}
          </span>
        )}
      </div>
    </figure>
  )
}

// ---- Calendar -------------------------------------------------------------------------------

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Days in weeks (columns), Monday at the top, each shaded by its figure — darker is more; months named above. */
export function CalendarChart({ days, label, unit, width, format }: { days: { ms: number; day: string; value: number | null }[]; label: string; unit: string; width: number; format: FigureFormat }) {
  const id = useId()
  const { cells, weeks, start } = useMemo(() => calendarOf(days), [days])
  const x0 = 30
  const cs = Math.max(8, Math.min(22, (width - x0 - 8) / Math.max(1, weeks)))
  const y0 = 18
  const H = y0 + cs * 7 + 8
  const d = useDrawing(width, H)
  const readout = useReadout(d.figure)
  const hover = readout.at
  const known = cells.filter((c) => c.value !== null).map((c) => c.value!)
  if (cells.length === 0 || known.length === 0) return <ChartEmpty height={H} />
  const lo = Math.min(0, ...known)
  const hi = Math.max(...known)
  const share = (v: number) => (hi === lo ? 1 : (v - lo) / (hi - lo))
  const W = x0 + weeks * cs + 8
  // A month's name over the first week that holds its first day.
  const months: { week: number; text: string }[] = []
  // The first week is named for the month of the first day drawn, not the Monday before it.
  const firstDay = Math.min(...days.map((x) => x.ms))
  for (let w = 0; w < weeks; w++) {
    for (let k = 0; k < 7; k++) {
      const ms = start + (w * 7 + k) * 86_400_000
      const date = new Date(ms)
      if ((date.getUTCDate() === 1 && ms >= firstDay) || (w === 0 && ms === firstDay)) {
        months.push({ week: w, text: MONTHS[date.getUTCMonth()] })
        break
      }
    }
  }
  const picked = hover !== null ? cells[hover] : null
  return (
    <figure ref={d.figureRef} className={d.figureClass}>
      <svg viewBox={`0 0 ${Math.max(W, width)} ${H}`} className={d.svgClass} role="img" aria-labelledby={`${id}-t`} {...readout.svg}>
        <title id={`${id}-t`}>{`${label} by day, ${cells.length} days, from ${format(Math.min(...known))}${unit} to ${format(hi)}${unit}`}</title>
        {[0, 2, 4].map((k) => (
          <text key={k} x={x0 - 4} y={y0 + k * cs + cs / 2 + 3.5} textAnchor="end" fontSize={TEXT - 1} className={MUTED}>
            {WEEKDAYS[k]}
          </text>
        ))}
        {months.map((m, i) =>
          i > 0 && m.week - months[i - 1].week < 3 ? null : (
            <text key={`${m.text}-${m.week}`} x={x0 + m.week * cs} y={y0 - 5} fontSize={TEXT} fontWeight={600} className={NAME}>
              {m.text}
            </text>
          ),
        )}
        {cells.map((c, i) => (
          <rect
            key={c.day}
            x={x0 + c.week * cs + 1}
            y={y0 + c.weekday * cs + 1}
            width={cs - 2}
            height={cs - 2}
            rx={2}
            className={c.value === null ? 'fill-slate-100 dark:fill-slate-800' : c.value < 0 ? 'fill-rose-500' : 'fill-brand-600'}
            fillOpacity={c.value === null ? 1 : 0.1 + 0.9 * share(c.value)}
            stroke={hover === i ? 'currentColor' : 'none'}
            {...readout.mark(i)}
          />
        ))}
      </svg>
      <div ref={d.legend} className={LEGEND}>
        <span className="inline-flex items-center gap-1.5">
          <span>Less</span>
          <span aria-hidden className="h-2.5 w-24 rounded-full bg-gradient-to-r from-brand-600/10 to-brand-600" />
          <span>More</span>
        </span>
        {picked && (
          <span className={READ_OUT}>
            {picked.day}: {picked.value === null ? '—' : `${format(picked.value)}${unit}`}
          </span>
        )}
      </div>
    </figure>
  )
}
