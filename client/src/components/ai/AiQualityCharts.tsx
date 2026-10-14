// ============================================================================
// §20 — the assistant's quality charts (SPC), beside its other kinds
// (./AiChartKinds, ./AiPlanCharts): a histogram of readings against their
// specification limits with the process's capability; an X̄-R chart, the
// subgroups' means over their ranges; the attribute charts (p, u, c), each
// point against its own limits; box plots side by side; and an FMEA risk
// matrix. Drawn as the others: hand-made SVG at the width shown, the
// dashboard's palette, axes and read-outs (hover with a mouse, tap with a
// finger), both themes. The statistics are ./chartStats'.
// ============================================================================

import { useId, useMemo } from 'react'
import { cn } from '@/lib/utils'
import { CHAR_WIDTH, axisNames } from '@/components/dashboard/labels'
import { ChartEmpty, GoalLine, Grid, LABEL_HALO, LEGEND, axisRoom, niceBounds, useDrawing, useReadout, type FigureFormat } from '@/components/dashboard/charts'
import { rangeAxis } from './AiChartKinds'
import { binsOf, boxOf, capabilityOf, capabilityTone, normalAt, riskZone, spreadOf, type RiskZone, type Stepped, type XbarR } from './chartStats'

const TEXT = 10
const MUTED = 'fill-muted'
const NAME = 'fill-slate-600 dark:fill-slate-300'
const READ_OUT = 'ml-auto font-semibold tabular-nums text-slate-700 dark:text-slate-200'

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s)
/** An index as a quality engineer reads it: two decimals. */
const index = (v: number | null) => (v === null || !Number.isFinite(v) ? '—' : v.toFixed(2))

/** A specification limit across the plot: a solid rose line named at its top, its name kept inside the drawing. */
function SpecLine({ x, y0, y1, text, left, right }: { x: number; y0: number; y1: number; text: string; left: number; right: number }) {
  const w = text.length * CHAR_WIDTH
  const anchor = x - w / 2 < left ? 'start' : x + w / 2 > right ? 'end' : 'middle'
  return (
    <g className="pointer-events-none">
      <line x1={x} x2={x} y1={y0} y2={y1} strokeWidth={2} className="stroke-rose-600 dark:stroke-rose-400" />
      <text x={anchor === 'start' ? x + 3 : anchor === 'end' ? x - 3 : x} y={y0 - 3} textAnchor={anchor} fontSize={TEXT} fontWeight={700} strokeWidth={3} style={{ paintOrder: 'stroke' }} className={cn('fill-rose-700 dark:fill-rose-300', LABEL_HALO)}>
        {text}
      </text>
    </g>
  )
}

// ---- Histogram and capability ---------------------------------------------------------------

/** An axis of counts: whole steps of 1, 2 or 5 of a power of ten, at most five of them. */
export function countAxis(top: number): { min: number; max: number; steps: number } {
  const most = Math.max(1, top)
  const p = 10 ** Math.max(0, Math.floor(Math.log10(most / 5)))
  const step = [1, 2, 5, 10].map((m) => m * p).find((s) => Math.ceil(most / s) <= 5) ?? 10 * p
  const steps = Math.max(1, Math.ceil(most / step))
  return { min: 0, max: steps * step, steps }
}

/**
 * Readings counted into bins, the normal curve of their mean and spread over them, the specification limits and the
 * target; under it the capability: Cp and Cpk (σ within), Pp and Ppk (σ overall), each coloured by how it reads, and
 * how many readings fall outside.
 */
export function HistogramChart({ readings, lsl, usl, goal, label, unit, width, format }: { readings: number[]; lsl?: number; usl?: number; goal?: number; label: string; unit: string; width: number; format: FigureFormat }) {
  const id = useId()
  const H = 240
  const d = useDrawing(width, H)
  const readout = useReadout(d.figure)
  const hover = readout.at
  const spread = spreadOf(readings)
  // The limits and the target are on the axis too, even outside every reading.
  const bins = useMemo(() => binsOf(readings, [lsl, usl, goal].filter((v): v is number => v !== undefined)), [readings, lsl, usl, goal])
  const cap = useMemo(() => capabilityOf(readings, lsl, usl), [readings, lsl, usl])
  if (!spread || readings.length < 2) return <ChartEmpty height={H} />
  const W = width
  const width0 = bins.edges[1] - bins.edges[0]
  // The curve's peak (a bin's expected count at the mean: n × width × density) is on the axis too.
  const peak = spread.sd > 0 ? readings.length * width0 * normalAt(spread.mean, spread.mean, spread.sd) : 0
  const axis = countAxis(Math.max(...bins.counts, peak))
  const x0 = Math.max(36, axisRoom(axis, '', (v) => String(Math.round(v))))
  const x1 = W - 14
  const y0 = 22
  const y1 = H - 34
  const lo = bins.edges[0]
  const hi = bins.edges[bins.edges.length - 1]
  const xAt = (v: number) => x0 + ((x1 - x0) * (v - lo)) / (hi - lo)
  const yAt = (c: number) => y1 - ((y1 - y0) * c) / axis.max
  // The curve scaled to the counts: a bin's expected count is n × width × density.
  const curve =
    spread.sd > 0
      ? Array.from({ length: 61 }, (_, i) => {
          const x = lo + ((hi - lo) * i) / 60
          return `${xAt(x)},${yAt(Math.min(axis.max, readings.length * width0 * normalAt(x, spread.mean, spread.sd)))}`
        }).join(' ')
      : null
  const every = Math.max(1, Math.ceil((bins.edges.length * Math.max(...bins.edges.map((e) => format(e).length)) * CHAR_WIDTH) / (x1 - x0)))
  const outside = cap ? cap.below + cap.above : 0
  const tone = (v: number | null) => {
    const t = capabilityTone(v)
    return t === 'good' ? 'text-emerald-700 dark:text-emerald-300' : t === 'fair' ? 'text-amber-700 dark:text-amber-300' : t === 'poor' ? 'text-rose-700 dark:text-rose-300' : ''
  }
  return (
    <figure ref={d.figureRef} className={d.figureClass}>
      <svg viewBox={`0 0 ${W} ${H}`} className={d.svgClass} role="img" aria-labelledby={`${id}-t`} {...readout.svg}>
        <title id={`${id}-t`}>{`Histogram of ${label}: ${readings.length} readings, mean ${format(spread.mean)}${unit}, σ ${format(spread.sd)}${unit}${cap ? `, Cpk ${index(cap.cpk)}, Ppk ${index(cap.ppk)}` : ''}`}</title>
        <Grid x0={x0} x1={x1} y0={y0} y1={y1} min={0} max={axis.max} steps={axis.steps} format={(v) => String(Math.round(v))} fontSize={TEXT} />
        {bins.counts.map((c, i) => {
          const a = bins.edges[i]
          const b = bins.edges[i + 1]
          const out = (lsl !== undefined && b <= lsl) || (usl !== undefined && a >= usl)
          return (
            <g key={i} {...readout.mark(i)}>
              <rect x={xAt(a) + 0.5} y={y0} width={Math.max(1, xAt(b) - xAt(a) - 1)} height={y1 - y0} fill="transparent" />
              {c > 0 && <rect x={xAt(a) + 0.5} y={yAt(c)} width={Math.max(1, xAt(b) - xAt(a) - 1)} height={y1 - yAt(c)} rx={1.5} className={out ? 'fill-rose-500' : 'fill-brand-500'} fillOpacity={hover === null || hover === i ? 0.85 : 0.5} />}
            </g>
          )
        })}
        {curve && <polyline points={curve} fill="none" strokeWidth={2} className="pointer-events-none stroke-slate-700 dark:stroke-slate-200" strokeOpacity={0.7} />}
        <g className="text-muted" fontSize={TEXT}>
          {bins.edges.map((e, i) =>
            i % every === 0 ? (
              <text key={i} x={xAt(e)} y={y1 + 14} textAnchor="middle" fill="currentColor">
                {format(e)}
              </text>
            ) : null,
          )}
          <text x={(x0 + x1) / 2} y={y1 + 29} textAnchor="middle" fontWeight={600} fill="currentColor">
            {label}
            {unit ? ` (${unit})` : ''}
          </text>
        </g>
        {lsl !== undefined && <SpecLine x={xAt(lsl)} y0={y0} y1={y1} text={`LSL ${format(lsl)}`} left={x0} right={W} />}
        {usl !== undefined && <SpecLine x={xAt(usl)} y0={y0} y1={y1} text={`USL ${format(usl)}`} left={x0} right={W} />}
        {goal !== undefined && (
          <g className="pointer-events-none">
            <line x1={xAt(goal)} x2={xAt(goal)} y1={y0} y2={y1} strokeWidth={1.5} strokeDasharray="6 4" className="stroke-amber-500" />
            <text x={xAt(goal)} y={y0 - 3} textAnchor="middle" fontSize={TEXT} fontWeight={700} className="fill-amber-600 dark:fill-amber-400">
              Target {format(goal)}
            </text>
          </g>
        )}
      </svg>
      <div ref={d.legend} className={LEGEND}>
        <span>
          n = {readings.length} · mean {format(spread.mean)}
          {unit} · σ {format(spread.sd)}
          {unit}
        </span>
        {cap && (
          <>
            {cap.cp !== null && <span className={cn('font-semibold', tone(cap.cp))}>Cp {index(cap.cp)}</span>}
            <span className={cn('font-semibold', tone(cap.cpk))} data-tip="From the short-term spread (moving range of the readings in order): 1.33 and above is capable">
              Cpk {index(cap.cpk)}
            </span>
            {cap.pp !== null && <span className={cn('font-semibold', tone(cap.pp))}>Pp {index(cap.pp)}</span>}
            <span className={cn('font-semibold', tone(cap.ppk))} data-tip="From the overall spread (every reading's standard deviation)">
              Ppk {index(cap.ppk)}
            </span>
            <span className={outside > 0 ? 'font-semibold text-rose-700 dark:text-rose-300' : ''}>
              {outside === 0 ? 'None outside the limits' : `${outside} outside (${((outside / readings.length) * 100).toFixed(1)}%)`}
            </span>
          </>
        )}
        {readings.length < 25 && cap && <span className="text-amber-700 dark:text-amber-300">Few readings: the indices are rough</span>}
        {hover !== null && bins.counts[hover] !== undefined && (
          <span className={READ_OUT}>
            {format(bins.edges[hover])} to {format(bins.edges[hover + 1])}
            {unit}: {bins.counts[hover]} {bins.counts[hover] === 1 ? 'reading' : 'readings'}
          </span>
        )}
      </div>
    </figure>
  )
}

// ---- A control chart whose limits step from point to point ----------------------------------

/** One panel: the points in order, the centre line, and limits that may change at each point (stepped). */
function StepPanel({
  labels,
  data,
  y0,
  y1,
  x0,
  x1,
  axis,
  unit,
  format,
  hover,
  mark,
  names,
  goal,
}: {
  labels: string[]
  data: Stepped
  y0: number
  y1: number
  x0: number
  x1: number
  axis: { min: number; max: number; steps: number }
  unit: string
  format: FigureFormat
  hover: number | null
  mark: (i: number) => object
  names: { ucl: string; cl: string; lcl: string }
  goal?: number
}) {
  const n = labels.length
  const slot = (x1 - x0) / n
  const xAt = (i: number) => x0 + slot * i + slot / 2
  const yAt = (v: number) => y1 - ((y1 - y0) * (Math.min(axis.max, Math.max(axis.min, v)) - axis.min)) / (axis.max - axis.min)
  const steps = (limits: (number | null)[]) => {
    const parts: string[] = []
    let open = false
    limits.forEach((v, i) => {
      if (v === null) {
        open = false
        return
      }
      parts.push(`${open ? 'L' : 'M'} ${x0 + slot * i} ${yAt(v)} L ${x0 + slot * (i + 1)} ${yAt(v)}`)
      open = true
    })
    return parts.join(' ')
  }
  const last = (limits: (number | null)[]) => [...limits].reverse().find((v) => v !== null) ?? null
  const points = data.values.flatMap((v, i) => (v === null ? [] : [`${xAt(i)},${yAt(v)}`]))
  const named = (v: number | null, text: string, className: string) =>
    v === null ? null : (
      <text x={x1 + 4} y={yAt(v) + 3.5} fontSize={TEXT} fontWeight={700} className={className}>
        {text}
      </text>
    )
  return (
    <g>
      <Grid x0={x0} x1={x1} y0={y0} y1={y1} min={axis.min} max={axis.max} steps={axis.steps} unit={unit} format={format} fontSize={TEXT} />
      <path d={steps(data.ucl)} fill="none" strokeWidth={1.5} strokeDasharray="6 4" className="pointer-events-none stroke-rose-500" />
      <path d={steps(data.lcl)} fill="none" strokeWidth={1.5} strokeDasharray="6 4" className="pointer-events-none stroke-rose-500" />
      <line x1={x0} x2={x1} y1={yAt(data.center)} y2={yAt(data.center)} strokeWidth={1.5} className="pointer-events-none stroke-emerald-600 dark:stroke-emerald-400" />
      {goal !== undefined && <GoalLine x0={x0} x1={x1} y={yAt(goal)} text={`Target ${format(goal)}${unit}`} at="start" />}
      {named(last(data.ucl), names.ucl, 'fill-rose-600 dark:fill-rose-400')}
      {named(data.center, names.cl, 'fill-emerald-700 dark:fill-emerald-400')}
      {named(last(data.lcl), names.lcl, 'fill-rose-600 dark:fill-rose-400')}
      <polyline points={points.join(' ')} fill="none" strokeWidth={2} strokeLinejoin="round" className="pointer-events-none stroke-brand-500" />
      {labels.map((l, i) => {
        const v = data.values[i]
        return (
          <g key={`${l}-${i}`} {...mark(i)}>
            <rect x={xAt(i) - slot / 2} y={y0} width={slot} height={y1 - y0} fill="transparent" />
            {v !== null && (
              <circle cx={xAt(i)} cy={yAt(v)} r={data.out[i] ? 4.5 : hover === i ? 5 : slot >= 6 ? 2.75 : 0} strokeWidth={data.out[i] ? 0 : 2} className={data.out[i] ? 'fill-rose-600' : 'fill-white stroke-brand-500 dark:fill-slate-900'} />
            )}
          </g>
        )
      })}
      {hover !== null && <line x1={xAt(hover)} x2={xAt(hover)} y1={y0} y2={y1} className="pointer-events-none stroke-slate-400" strokeDasharray="3 3" />}
    </g>
  )
}

/** The room the names of the limit lines take at the right of a panel. */
const limitRoom = (W: number, texts: string[]) => Math.min(Math.round(W * 0.22), Math.max(...texts.map((t) => t.length)) * CHAR_WIDTH + 12)

/** The names along x under a control chart. */
function XNames({ labels, x0, x1, y, W }: { labels: string[]; x0: number; x1: number; y: number; W: number }) {
  const n = labels.length
  const slot = (x1 - x0) / n
  const xAt = (i: number) => x0 + slot * i + slot / 2
  const every = Math.max(1, Math.ceil(n / Math.max(4, Math.round((12 * (x1 - x0)) / 660))))
  return (
    <>
      {axisNames(labels, xAt, slot, W, every).map((a) => (
        <text key={a.i} x={a.x} y={y} textAnchor={a.anchor} fontSize={TEXT} className={MUTED}>
          {labels[a.i]}
        </text>
      ))}
    </>
  )
}

const outCount = (out: boolean[]) => out.filter(Boolean).length
function InControl({ out, what }: { out: number; what: string }) {
  return (
    <span className={cn('font-semibold', out > 0 ? 'text-rose-700 dark:text-rose-300' : 'text-emerald-700 dark:text-emerald-300')}>
      {out === 0 ? `${what}: in control` : `${what}: ${out} ${out === 1 ? 'point' : 'points'} outside the limits`}
    </span>
  )
}

/** An X̄-R chart: the subgroups' means over their ranges, each with limits from the subgroup's own size. */
export function XbarRChart({ labels, xbar, label, unit, width, format, goal }: { labels: string[]; xbar: XbarR; label: string; unit: string; width: number; format: FigureFormat; goal?: number }) {
  const id = useId()
  const H = 330
  const d = useDrawing(width, H)
  const readout = useReadout(d.figure)
  const hover = readout.at
  const n = labels.length
  if (n < 2) return <ChartEmpty height={H} />
  const m = xbar.means
  const r = xbar.ranges
  const known = (s: Stepped) => [...s.values, ...s.ucl, ...s.lcl, s.center].filter((v): v is number => v !== null)
  const mAxis = rangeAxis(Math.min(...known(m), ...(goal === undefined ? [] : [goal])), Math.max(...known(m), ...(goal === undefined ? [] : [goal])))
  const rAxis = niceBounds(0, Math.max(...known(r)), true)
  const W = width
  const mNames = { ucl: `UCL ${format(m.ucl.at(-1) ?? m.center)}`, cl: `X̄̄ ${format(m.center)}`, lcl: `LCL ${format(m.lcl.at(-1) ?? m.center)}` }
  const rNames = { ucl: `UCL ${format(r.ucl.at(-1) ?? r.center)}`, cl: `R̄ ${format(r.center)}`, lcl: r.lcl.some((v) => v !== null) ? `LCL ${format(r.lcl.at(-1) ?? 0)}` : '' }
  const x0 = Math.min(Math.round(W * 0.3), Math.max(axisRoom(mAxis, unit, format), axisRoom(rAxis, unit, format)))
  const x1 = W - limitRoom(W, [...Object.values(mNames), ...Object.values(rNames)])
  const sizes = new Set(xbar.sizes)
  return (
    <figure ref={d.figureRef} className={d.figureClass}>
      <svg viewBox={`0 0 ${W} ${H}`} className={d.svgClass} role="img" aria-labelledby={`${id}-t`} {...readout.svg}>
        <title id={`${id}-t`}>{`X̄-R chart of ${label}: ${n} subgroups, grand mean ${format(m.center)}${unit}, mean range ${format(r.center)}${unit}; ${outCount(m.out)} means and ${outCount(r.out)} ranges outside their limits`}</title>
        <text x={x0} y={11} fontSize={TEXT} fontWeight={700} className={NAME}>
          Subgroup means (X̄)
        </text>
        <StepPanel labels={labels} data={m} x0={x0} x1={x1} y0={18} y1={176} axis={mAxis} unit={unit} format={format} hover={hover} mark={readout.mark} names={mNames} goal={goal} />
        <text x={x0} y={198} fontSize={TEXT} fontWeight={700} className={NAME}>
          Subgroup ranges (R)
        </text>
        <StepPanel labels={labels} data={r} x0={x0} x1={x1} y0={205} y1={H - 30} axis={rAxis} unit={unit} format={format} hover={hover} mark={(i) => readout.mark(i)} names={rNames} />
        <XNames labels={labels} x0={x0} x1={x1} y={H - 14} W={x1 + 10} />
      </svg>
      <div ref={d.legend} className={LEGEND}>
        <InControl out={outCount(m.out)} what="Means" />
        <InControl out={outCount(r.out)} what="Ranges" />
        <span>
          σ within ≈ {format(xbar.sigma)}
          {unit} · n = {[...sizes].join(', ')} per subgroup
        </span>
        {xbar.left > 0 && <span>{xbar.left} subgroups of one reading left out</span>}
        {hover !== null && labels[hover] !== undefined && (
          <span className={READ_OUT} dir="auto">
            {labels[hover]}: X̄ {format(m.values[hover]!)}
            {unit} · R {format(r.values[hover]!)}
            {unit} · n {xbar.sizes[hover]}
          </span>
        )}
      </div>
    </figure>
  )
}

/** A p-, u- or c-chart: each sample's share defective, defects per unit or defects, against limits of its own size. */
export function AttributeChart({ kind, labels, stepped, label, unit, width, format }: { kind: 'p-chart' | 'u-chart' | 'c-chart'; labels: string[]; stepped: Stepped; label: string; unit: string; width: number; format: FigureFormat }) {
  const id = useId()
  const H = 240
  const d = useDrawing(width, H)
  const readout = useReadout(d.figure)
  const hover = readout.at
  const n = labels.length
  if (n < 2) return <ChartEmpty height={H} />
  const known = [...stepped.values, ...stepped.ucl, ...stepped.lcl, stepped.center].filter((v): v is number => v !== null)
  const axis = niceBounds(0, Math.max(...known), true)
  const W = width
  const centre = kind === 'p-chart' ? 'p̄' : kind === 'u-chart' ? 'ū' : 'c̄'
  const names = { ucl: `UCL ${format(stepped.ucl.at(-1) ?? stepped.center)}${unit}`, cl: `${centre} ${format(stepped.center)}${unit}`, lcl: stepped.lcl.some((v) => v !== null) ? `LCL ${format(stepped.lcl.at(-1) ?? 0)}${unit}` : '' }
  const x0 = Math.min(Math.round(W * 0.3), axisRoom(axis, unit, format))
  const x1 = W - limitRoom(W, Object.values(names))
  const out = outCount(stepped.out)
  return (
    <figure ref={d.figureRef} className={d.figureClass}>
      <svg viewBox={`0 0 ${W} ${H}`} className={d.svgClass} role="img" aria-labelledby={`${id}-t`} {...readout.svg}>
        <title id={`${id}-t`}>{`${kind} of ${label}: centre ${format(stepped.center)}${unit}, ${out} points outside their limits`}</title>
        <StepPanel labels={labels} data={stepped} x0={x0} x1={x1} y0={14} y1={H - 34} axis={axis} unit={unit} format={format} hover={hover} mark={readout.mark} names={names} />
        <XNames labels={labels} x0={x0} x1={x1} y={H - 18} W={x1 + 10} />
      </svg>
      <div ref={d.legend} className={LEGEND}>
        <InControl out={out} what={label} />
        {kind !== 'c-chart' && <span>Limits widen for smaller samples</span>}
        {hover !== null && labels[hover] !== undefined && (
          <span className={READ_OUT} dir="auto">
            {labels[hover]}: {stepped.values[hover] === null ? '—' : `${format(stepped.values[hover]!)}${unit}`}
            {stepped.ucl[hover] !== null ? ` (limits ${stepped.lcl[hover] === null ? '0' : format(stepped.lcl[hover]!)}–${format(stepped.ucl[hover]!)}${unit})` : ''}
          </span>
        )}
      </div>
    </figure>
  )
}

// ---- Box plots ------------------------------------------------------------------------------

/** Each group's readings as a box (the middle half, its median), whiskers to 1.5 IQR, the rest as dots; limits and target across. */
export function BoxPlotChart({ labels, groups, lsl, usl, goal, label, unit, width, format }: { labels: string[]; groups: number[][]; lsl?: number; usl?: number; goal?: number; label: string; unit: string; width: number; format: FigureFormat }) {
  const id = useId()
  const H = 240
  const d = useDrawing(width, H)
  const readout = useReadout(d.figure)
  const hover = readout.at
  const boxes = useMemo(() => groups.map(boxOf), [groups])
  const all = groups.flat()
  if (all.length === 0) return <ChartEmpty height={H} />
  const lines = [lsl, usl, goal].filter((v): v is number => v !== undefined)
  const axis = rangeAxis(Math.min(...all, ...lines), Math.max(...all, ...lines))
  const W = width
  const x0 = Math.min(Math.round(W * 0.3), axisRoom(axis, unit, format))
  const x1 = W - 14
  const y0 = 14
  const y1 = H - 34
  const n = labels.length
  const slot = (x1 - x0) / n
  const xAt = (i: number) => x0 + slot * i + slot / 2
  const yAt = (v: number) => y1 - ((y1 - y0) * (v - axis.min)) / (axis.max - axis.min)
  const bw = Math.min(46, slot * 0.55)
  const specLine = (v: number, text: string) => (
    <g className="pointer-events-none">
      <line x1={x0} x2={x1} y1={yAt(v)} y2={yAt(v)} strokeWidth={1.5} className="stroke-rose-600 dark:stroke-rose-400" />
      <text x={x1 - 2} y={yAt(v) - 4} textAnchor="end" fontSize={TEXT} fontWeight={700} strokeWidth={3} style={{ paintOrder: 'stroke' }} className={cn('fill-rose-700 dark:fill-rose-300', LABEL_HALO)}>
        {text}
      </text>
    </g>
  )
  const picked = hover !== null ? boxes[hover] : null
  return (
    <figure ref={d.figureRef} className={d.figureClass}>
      <svg viewBox={`0 0 ${W} ${H}`} className={d.svgClass} role="img" aria-labelledby={`${id}-t`} {...readout.svg}>
        <title id={`${id}-t`}>{`Box plots of ${label} by group: ${labels.map((l, i) => `${l} median ${boxes[i] ? format(boxes[i]!.median) : '—'}${unit}`).join(', ')}`}</title>
        <Grid x0={x0} x1={x1} y0={y0} y1={y1} min={axis.min} max={axis.max} steps={axis.steps} unit={unit} format={format} fontSize={TEXT} />
        {lsl !== undefined && specLine(lsl, `LSL ${format(lsl)}`)}
        {usl !== undefined && specLine(usl, `USL ${format(usl)}`)}
        {goal !== undefined && <GoalLine x0={x0} x1={x1} y={yAt(goal)} text={`Target ${format(goal)}${unit}`} at="start" />}
        {boxes.map((b, i) =>
          b === null ? null : (
            <g key={`${labels[i]}-${i}`} {...readout.mark(i)}>
              <rect x={xAt(i) - slot / 2} y={y0} width={slot} height={y1 - y0} fill="transparent" />
              <line x1={xAt(i)} x2={xAt(i)} y1={yAt(b.high)} y2={yAt(b.q3)} strokeWidth={1.5} className="stroke-slate-500 dark:stroke-slate-400" />
              <line x1={xAt(i)} x2={xAt(i)} y1={yAt(b.q1)} y2={yAt(b.low)} strokeWidth={1.5} className="stroke-slate-500 dark:stroke-slate-400" />
              <line x1={xAt(i) - bw / 4} x2={xAt(i) + bw / 4} y1={yAt(b.high)} y2={yAt(b.high)} strokeWidth={1.5} className="stroke-slate-500 dark:stroke-slate-400" />
              <line x1={xAt(i) - bw / 4} x2={xAt(i) + bw / 4} y1={yAt(b.low)} y2={yAt(b.low)} strokeWidth={1.5} className="stroke-slate-500 dark:stroke-slate-400" />
              <rect x={xAt(i) - bw / 2} y={yAt(b.q3)} width={bw} height={Math.max(1, yAt(b.q1) - yAt(b.q3))} rx={3} strokeWidth={1.5} className="fill-brand-500/25 stroke-brand-600 dark:stroke-brand-400" fillOpacity={hover === null || hover === i ? 1 : 0.5} />
              <line x1={xAt(i) - bw / 2} x2={xAt(i) + bw / 2} y1={yAt(b.median)} y2={yAt(b.median)} strokeWidth={2.5} className="stroke-brand-700 dark:stroke-brand-300" />
              <circle cx={xAt(i)} cy={yAt(b.mean)} r={2.5} className="fill-slate-700 dark:fill-slate-200" />
              {b.outliers.map((o, k) => (
                <circle key={k} cx={xAt(i)} cy={yAt(o)} r={3} strokeWidth={1.5} className="fill-white stroke-rose-500 dark:fill-slate-900" />
              ))}
            </g>
          ),
        )}
        {labels.map((l, i) => (
          <text key={`${l}-${i}`} x={xAt(i)} y={y1 + 15} textAnchor="middle" fontSize={TEXT} className={MUTED}>
            {cut(l, Math.max(4, Math.floor(slot / CHAR_WIDTH)))}
          </text>
        ))}
      </svg>
      <div ref={d.legend} className={LEGEND}>
        <span>Box: the middle half · line: median · dot: mean · whiskers: 1.5 × IQR · circles: outliers</span>
        {picked && hover !== null && (
          <span className={READ_OUT} dir="auto">
            {labels[hover]}: n {picked.n} · median {format(picked.median)}
            {unit} · Q1 {format(picked.q1)} · Q3 {format(picked.q3)} · {format(picked.low)}–{format(picked.high)}
            {unit}
            {picked.outliers.length > 0 ? ` · ${picked.outliers.length} outliers` : ''}
          </span>
        )}
      </div>
    </figure>
  )
}

// ---- Risk matrix (FMEA) ---------------------------------------------------------------------

const ZONE: Record<RiskZone, string> = {
  high: 'fill-rose-500/25 dark:fill-rose-500/30',
  medium: 'fill-amber-400/25 dark:fill-amber-400/25',
  low: 'fill-emerald-500/15 dark:fill-emerald-500/20',
}
const ZONE_DOT: Record<RiskZone, string> = { high: 'fill-rose-600', medium: 'fill-amber-500', low: 'fill-emerald-600' }

/**
 * Failure modes on a grid of severity (up) by occurrence (across), its cells shaded by risk, each mode a numbered
 * dot; beside it the modes ranked by RPN (S × O × D) or, without detection, by S × O.
 */
export function RiskMatrixChart({ risks, width }: { risks: { label: string; s: number; o: number; d: number | null }[]; width: number }) {
  const id = useId()
  const scale: 5 | 10 = risks.every((r) => r.s <= 5 && r.o <= 5 && (r.d === null || r.d <= 5)) ? 5 : 10
  const ranked = useMemo(
    () =>
      risks
        .map((r, i) => ({ ...r, i, rpn: r.s * r.o * (r.d ?? 1), zone: riskZone(r.s, r.o, scale) }))
        .sort((a, b) => b.rpn - a.rpn || b.s - a.s || a.i - b.i)
        .map((r, k) => ({ ...r, rank: k + 1 })),
    [risks, scale],
  )
  const narrow = width < 560
  const grid = Math.min(narrow ? width - 40 : width * 0.5, 340)
  const cell = grid / scale
  const x0 = 32
  const y0 = 10
  const H = y0 + grid + 34
  const d = useDrawing(width, H)
  const readout = useReadout(d.figure)
  const hover = readout.at
  const hasD = risks.some((r) => r.d !== null)
  // Modes in one cell sit side by side.
  const inCell = new Map<string, number>()
  const place = ranked.map((r) => {
    const key = `${r.s}:${r.o}`
    const k = inCell.get(key) ?? 0
    inCell.set(key, k + 1)
    return { r, k }
  })
  const per = Math.max(1, Math.floor(cell / 15))
  return (
    <figure ref={d.figureRef} className={d.figureClass}>
      <div className={cn('flex gap-4', narrow ? 'flex-col' : 'items-start')}>
        <svg viewBox={`0 0 ${x0 + grid + 8} ${H}`} className="block h-auto shrink-0" style={{ width: x0 + grid + 8, maxWidth: '100%' }} role="img" aria-labelledby={`${id}-t`} {...readout.svg}>
          <title id={`${id}-t`}>{`Risk matrix of ${risks.length} failure modes: ${ranked.filter((r) => r.zone === 'high').length} high, ${ranked.filter((r) => r.zone === 'medium').length} medium`}</title>
          {Array.from({ length: scale }, (_, si) =>
            Array.from({ length: scale }, (_, oi) => {
              const s = scale - si
              const o = oi + 1
              return <rect key={`${s}-${o}`} x={x0 + oi * cell + 0.5} y={y0 + si * cell + 0.5} width={cell - 1} height={cell - 1} rx={2} className={ZONE[riskZone(s, o, scale)]} />
            }),
          )}
          <g className="text-muted" fontSize={TEXT}>
            {Array.from({ length: scale }, (_, k) => (
              <g key={k}>
                <text x={x0 - 6} y={y0 + (scale - 1 - k) * cell + cell / 2 + 3.5} textAnchor="end" fill="currentColor">
                  {k + 1}
                </text>
                <text x={x0 + k * cell + cell / 2} y={y0 + grid + 13} textAnchor="middle" fill="currentColor">
                  {k + 1}
                </text>
              </g>
            ))}
            <text x={x0 + grid / 2} y={y0 + grid + 28} textAnchor="middle" fontWeight={600} fill="currentColor">
              Occurrence
            </text>
            <text x={9} y={y0 + grid / 2} textAnchor="middle" fontWeight={600} fill="currentColor" transform={`rotate(-90 9 ${y0 + grid / 2})`}>
              Severity
            </text>
          </g>
          {place.map(({ r, k }) => {
            const cx = x0 + (r.o - 1) * cell + 9 + (k % per) * 15
            const cy = y0 + (scale - r.s) * cell + 9 + Math.floor(k / per) * 15
            return (
              <g key={r.i} {...readout.mark(r.rank - 1)}>
                <circle cx={cx} cy={cy} r={hover === r.rank - 1 ? 8.5 : 7} className={ZONE_DOT[r.zone]} stroke={hover === r.rank - 1 ? 'currentColor' : 'none'} />
                <text x={cx} y={cy + 3.5} textAnchor="middle" fontSize={TEXT - 1} fontWeight={700} className="pointer-events-none fill-white">
                  {r.rank}
                </text>
              </g>
            )
          })}
        </svg>
        <ol className="min-w-0 flex-1 space-y-1 text-xs">
          {ranked.map((r) => (
            <li key={r.i} className={cn('flex items-baseline gap-2 rounded-md px-1.5 py-0.5', hover === r.rank - 1 && 'bg-slate-100 dark:bg-slate-800')}>
              <span className={cn('grid h-4 w-4 shrink-0 place-items-center rounded-full text-[9px] font-bold text-white', r.zone === 'high' ? 'bg-rose-600' : r.zone === 'medium' ? 'bg-amber-500' : 'bg-emerald-600')}>{r.rank}</span>
              <span dir="auto" className="min-w-0 flex-1 break-words text-slate-700 dark:text-slate-200">
                {r.label}
              </span>
              <span className="shrink-0 tabular-nums text-muted">
                S{r.s} · O{r.o}
                {r.d !== null ? ` · D${r.d}` : ''}
              </span>
              <span className="w-14 shrink-0 text-end font-semibold tabular-nums text-slate-700 dark:text-slate-200">{hasD ? `RPN ${r.rpn}` : `${r.s * r.o}`}</span>
            </li>
          ))}
        </ol>
      </div>
      <div ref={d.legend} className={LEGEND}>
        <span>
          Scale 1–{scale} · ranked by {hasD ? 'RPN = severity × occurrence × detection' : 'severity × occurrence'}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm bg-rose-500/60" /> High
          <span className="ms-2 h-2.5 w-2.5 rounded-sm bg-amber-400/60" /> Medium
          <span className="ms-2 h-2.5 w-2.5 rounded-sm bg-emerald-500/50" /> Low
        </span>
      </div>
    </figure>
  )
}

