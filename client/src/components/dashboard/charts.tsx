// ============================================================================
// Small SVG charts for the dashboard (§15). Hand-drawn rather than a chart
// library: the shapes are few and fixed, the bundle stays small for a tablet
// on the factory Wi-Fi, and they print as vectors. Each one is drawn at the
// size it is shown — measured, so its words keep their own size on a phone
// and in a small board box alike — and keeps its text legible in both themes
// with currentColor and the brand palette. A mouse reads a chart by hovering;
// a finger by tapping.
// ============================================================================

import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { useCoarsePointer } from '@/lib/media'
import { CHAR_WIDTH, CHAR_WIDTH_BOLD, CHAR_WIDTH_WIDE, axisNames, labelEvery, slantRoom, spreadLabels } from './labels'

/**
 * True inside a board: the chart fills the box it was given, height and
 * width alike. Outside a board a chart takes the height it asks for.
 */
export const ChartFillContext = createContext(false)

/** The type a dashboard chart writes in, in px as shown: its axes, names and figures, and the smaller second figures. */
const TEXT = 11
const TEXT_SMALL = 10
/** Narrower than this a chart is a phone's: no second value axis (its figures go to the read-out), names numbered. */
const NARROW = 480
/** The least height a chart filling a board's box is drawn at; a smaller box scrolls. */
const MIN_FILL_HEIGHT = 140
/** Narrower than this a day's bar is drawn as a week's, where the chart has the weeks. */
const MIN_DAY_SLOT = 6

/** Measured before the first paint in a browser; in a server render (a test's), where there is nothing to measure, an effect that never runs. */
const useMeasureEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

/** A figure on a chart is outlined in the card's own colour so it reads over a line beneath it. */
const LABEL_HALO = 'stroke-white dark:stroke-slate-900'

/** A slice that lumps several together cannot be opened on its own. */
const isOthers = (label: string) => /^Others\b/.test(label)

/** The read-out's button that opens what a tapped mark stands for (a finger's second step: the first tap reads it out). */
const OPEN_BUTTON = 'print-hidden inline-flex min-h-[32px] items-center rounded-lg bg-brand-50 px-2.5 text-xs font-semibold text-brand-700 hover:bg-brand-100 dark:bg-brand-500/15 dark:text-brand-300 touch:min-h-[40px]'

/**
 * The size a chart is drawn at. Given a `width` (the assistant's, which picks
 * its own; every chart takes one), that and `height`. Otherwise as wide as the chart is shown —
 * measured, and again whenever its card changes width — and, on a board, as
 * tall as its box leaves above the legend. A chart drawn on a fixed 720-wide
 * canvas and scaled to its card wrote its words at 4 px on a phone and 6 in a
 * small board box; drawn at its own size they stay at 11. The legend's height
 * is read only when the box changes, so a read-out that wraps it onto a
 * second line does not move the plot under the pointer. Before it is measured
 * (and in a server render) a drawing is the dashboard's old 720 wide.
 */
function useDrawing(given: number | undefined, height: number) {
  const fill = useContext(ChartFillContext)
  const [figure, setFigure] = useState<HTMLElement | null>(null)
  const legend = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<{ w: number; h: number } | null>(null)
  const measured = given === undefined
  useMeasureEffect(() => {
    if (!figure || !measured) return
    const read = () => {
      const w = Math.floor(figure.clientWidth)
      const h = fill ? Math.floor(figure.clientHeight - (legend.current ? legend.current.offsetHeight + 4 : 0)) : 0
      setBox((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }))
    }
    read()
    if (typeof ResizeObserver === 'undefined') return
    const watch = new ResizeObserver(read)
    watch.observe(figure)
    return () => watch.disconnect()
  }, [figure, measured, fill])
  const filled = measured && fill && !!box && box.h > 0
  const W = given ?? (box && box.w > 0 ? box.w : 720)
  const H = filled && box ? Math.max(MIN_FILL_HEIGHT, box.h) : height
  return {
    W,
    H,
    /** True when H is the board box's height rather than the one asked for. */
    filled,
    figure,
    /** For the <figure>. */
    figureRef: setFigure,
    legend,
    figureClass: fill ? 'relative flex h-full min-h-0 min-w-0 flex-col' : 'relative min-w-0',
    /** On a board the drawing is as tall as its box; elsewhere it keeps its aspect as it scales (on paper, a page's width). */
    svgClass: fill ? 'block w-full shrink-0' : 'block h-auto w-full',
  }
}

/** Which mark of a chart is read out, and whether a finger picked it. */
interface Picked {
  i: number
  tap: boolean
}

/**
 * Which mark of a chart is read out under it, and how a pointer picks one. A
 * mouse reads a mark by resting on it and lets it go by leaving the drawing. A
 * finger or a pen taps: a phone sends no hover, and iOS sends a drawing no
 * mouse events at all, so a tap reads a mark out, a second tap on it puts it
 * away, and so does a tap anywhere else on the page.
 */
function useReadout(figure: HTMLElement | null) {
  const [picked, setPicked] = useState<Picked | null>(null)
  /** The kind of pointer that pressed last: the click after a finger's press is a tap. */
  const pointer = useRef('mouse')
  useEffect(() => {
    if (!picked?.tap) return
    const away = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' && !(figure && figure.contains(e.target as Node))) setPicked(null)
    }
    document.addEventListener('pointerdown', away, true)
    return () => document.removeEventListener('pointerdown', away, true)
  }, [picked, figure])
  return {
    /** The mark read out, or null. */
    at: picked?.i ?? null,
    /** True when a finger picked it: the read-out then carries the Open button of a chart whose marks open. */
    tapped: !!picked?.tap,
    clear: () => setPicked(null),
    /** On the <svg>. */
    svg: {
      onPointerLeave: (e: ReactPointerEvent) => {
        if (e.pointerType === 'mouse') setPicked(null)
      },
    },
    /** On mark i; `onPick` makes it open what it stands for — a click, Enter or Space at once, a tap once it is read out. */
    mark: (i: number, label?: string, onPick?: () => void) => {
      const opens = !!onPick && !(label !== undefined && isOthers(label))
      return {
        onPointerEnter: (e: ReactPointerEvent) => {
          if (e.pointerType === 'mouse') setPicked({ i, tap: false })
        },
        onPointerDown: (e: ReactPointerEvent) => {
          pointer.current = e.pointerType
        },
        onClick: () => {
          const tap = pointer.current !== 'mouse'
          if (opens && (!tap || picked?.i === i)) onPick!()
          else if (tap) setPicked((prev) => (prev?.i === i ? null : { i, tap: true }))
        },
        ...(opens
          ? {
              role: 'button' as const,
              tabIndex: 0,
              'aria-label': `Open ${label}`,
              style: { cursor: 'pointer' },
              onKeyDown: (e: { key: string; preventDefault: () => void }) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onPick!()
                }
              },
            }
          : {}),
      }
    },
  }
}

/** What makes a list row of a chart (a legend's) open its detail: a click, a tap, Enter or Space. */
function pickable(onPick: (() => void) | undefined, label: string) {
  if (!onPick || isOthers(label)) return {}
  return {
    role: 'button' as const,
    tabIndex: 0,
    'aria-label': `Open ${label}`,
    style: { cursor: 'pointer' },
    onClick: onPick,
    onKeyDown: (e: { key: string; preventDefault: () => void }) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onPick()
      }
    },
  }
}

/** Whole numbers as they are; anything else to at most two decimals, trailing zeros dropped. The dashboard's figures; the assistant's charts (§20) pass a `format` of their own. */
const fmt = (n: number, digits = 2): string => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(digits))))

/** How a chart writes a figure: on its axis, on its marks and in its read-outs. */
export type FigureFormat = (n: number) => string

/** The longest of some words, in letters. */
const longestOf = (words: readonly string[]) => words.reduce((n, w) => Math.max(n, w.length), 0)

function niceMax(v: number): number {
  if (!(v > 0)) return 1
  const p = 10 ** Math.floor(Math.log10(v))
  const m = v / p
  const step = m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10
  return step * p
}

/** Round steps for a value axis: 1, 2, 2.5 and 5 of a power of ten. */
const ROUND_STEPS = [1, 2, 2.5, 5]
/** The most steps a fitted value axis takes. */
const MOST_STEPS = 5

export interface ValueAxis {
  min: number
  max: number
  steps: number
}

/**
 * A value axis: round figures in equal steps, zero among them. The
 * dashboard's (and the default) is 0 to niceMax in four steps — the most
 * rounded up to 1, 2, 2.5, 5 or 10 of a power of ten, which may leave near
 * half the plot empty (267 drawn on 0–500). `tight` (the assistant's charts,
 * §20, whose figures may be anything, below zero too) fits the figures
 * instead: the least round step that spans them, from below the least to
 * above the most, in at most five steps (267 on 0–300, 315 on 0–400).
 */
export function niceBounds(lo: number, hi: number, tight = false): ValueAxis {
  const top = Math.max(0, hi)
  const bottom = Math.min(0, lo)
  if (!tight && bottom === 0) return { min: 0, max: niceMax(top), steps: 4 }
  const span = top - bottom
  if (!(span > 0) || !Number.isFinite(span)) return { min: 0, max: 1, steps: 4 }
  // n·10^k, exact for k < 0 (2.5 / 10, not 2.5 × 0.1); a hair over a whole number of steps (floating point's) is not another step.
  const at = (n: number, k: number) => (k < 0 ? n / 10 ** -k : n * 10 ** k)
  const above = (s: number) => Math.max(0, Math.ceil(top / s - 1e-9))
  const below = (s: number) => Math.max(0, Math.ceil(-bottom / s - 1e-9))
  // From the round step a fifth of the span is at least, up: once a step is the whole span, the figures take two at most.
  for (let k = Math.floor(Math.log10(span / MOST_STEPS)); ; k++) {
    for (const n of ROUND_STEPS) {
      const step = at(n, k)
      const steps = above(step) + below(step)
      if (steps <= MOST_STEPS) return { min: below(step) === 0 ? 0 : -below(step) * step, max: above(step) * step, steps: Math.max(1, steps) }
    }
  }
}

/** The figure at grid line i of `steps` from min to max; a hair from zero (floating point's) is zero. */
function tickAt(min: number, max: number, steps: number, i: number): number {
  const v = min + ((max - min) / steps) * i
  return Math.abs(v) <= Math.abs(max - min) * 1e-9 ? 0 : v
}

/** The left margin a value axis needs for its figures (written at 10 or 11 px, 6 left of the plot): at least the dashboard's 44. */
function axisRoom(axis: ValueAxis, unit: string, format: FigureFormat): number {
  let longest = 0
  for (let i = 0; i <= axis.steps; i++) longest = Math.max(longest, `${format(tickAt(axis.min, axis.max, axis.steps, i))}${unit}`.length)
  return Math.max(44, Math.ceil(longest * CHAR_WIDTH_WIDE + 10))
}

/** Grid lines with their labels, `steps` steps from min (0 unless given) to max; the zero line drawn solid. */
function Grid({ x0, x1, y0, y1, max, min = 0, steps = 4, unit = '', format = fmt, fontSize = 10 }: { x0: number; x1: number; y0: number; y1: number; max: number; min?: number; steps?: number; unit?: string; format?: FigureFormat; fontSize?: number }) {
  return (
    <g className="text-muted" fontSize={fontSize}>
      {Array.from({ length: steps + 1 }, (_, i) => {
        const v = tickAt(min, max, steps, i)
        const y = y1 - ((y1 - y0) * i) / steps
        const zero = v === 0
        return (
          <g key={i}>
            <line x1={x0} x2={x1} y1={y} y2={y} stroke="currentColor" strokeOpacity={zero ? 0.6 : 0.18} strokeDasharray={zero ? undefined : '3 3'} />
            <text x={x0 - 6} y={y + 3} textAnchor="end" fill="currentColor">
              {format(v)}
              {unit}
            </text>
          </g>
        )
      })}
    </g>
  )
}

/** The legend row under a chart, and its read-out: the figures of the mark picked. */
const LEGEND = 'mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted'
const READOUT = 'ml-auto font-semibold tabular-nums text-slate-700 dark:text-slate-200'

export interface TrendPoint {
  label: string
  /** Bars, e.g. samples per day. */
  bar: number
  /** Line on its own axis, e.g. defect rate; null draws a gap. */
  line: number | null
}

/**
 * Bars for volume with a line for a rate on its own axis over the same days;
 * more lines on the rate axis when `lines` is given. Values are written on the
 * marks while they fit. A null breaks the line; with `connectGaps` it runs on
 * to the next known point. On a phone the rate's axis is left out: its figures
 * are on the points while they fit, and in the read-out of the one tapped.
 */
export function TrendChart({ points, barLabel, lineLabel, lineUnit = '%', height = 220, lines = [], connectGaps = false, width }: { points: TrendPoint[]; barLabel: string; lineLabel: string; lineUnit?: string; height?: number; lines?: LineSeries[]; connectGaps?: boolean; width?: number }) {
  const d = useDrawing(width, height)
  const readout = useReadout(d.figure)
  const hover = readout.at
  const id = useId()
  const { W, H } = d
  const n = points.length
  if (n === 0) return <ChartEmpty height={height} />
  const barMax = niceMax(Math.max(...points.map((p) => p.bar)))
  const lineMax = niceMax(Math.max(...points.map((p) => p.line ?? 0), ...lines.flatMap((l) => l.values.map((v) => v ?? 0))))
  const narrow = W < NARROW
  const pad = { l: axisRoom({ min: 0, max: barMax, steps: 4 }, '', fmt), r: narrow ? 14 : 44, t: 16, b: 34 }
  const x0 = pad.l
  const x1 = W - pad.r
  const y0 = pad.t
  const y1 = H - pad.b
  const slot = (x1 - x0) / n
  const bw = Math.max(2, Math.min(28, slot * 0.6))
  const xAt = (i: number) => x0 + slot * i + slot / 2
  const yBar = (v: number) => y1 - ((y1 - y0) * v) / barMax
  const yLine = (v: number) => y1 - ((y1 - y0) * v) / lineMax
  const segments: string[] = []
  let current: string[] = []
  points.forEach((p, i) => {
    if (p.line === null) {
      if (connectGaps) return
      if (current.length) segments.push(current.join(' '))
      current = []
    } else current.push(`${xAt(i)},${yLine(p.line)}`)
  })
  if (current.length) segments.push(current.join(' '))
  // A figure on every mark only while each has the room: the bar's centred in its column, the rate's beside the bar
  // (over the next bar, outlined, but clear of the next point's own figure).
  const barText = longestOf(points.map((p) => fmt(p.bar))) * CHAR_WIDTH_BOLD
  const rateText = longestOf(points.flatMap((p) => (p.line === null ? [] : [`${fmt(p.line)}${lineUnit}`]))) * CHAR_WIDTH_BOLD
  const labelled = n <= 16 && barText + 2 <= slot && rateText + 4 <= slot
  const every = labelEvery(n, x1 - x0, longestOf(points.map((p) => p.label)))
  const h = hover !== null ? points[hover] : null
  return (
    <figure ref={d.figureRef} className={d.figureClass}>
      <svg viewBox={`0 0 ${W} ${H}`} height={H} className={d.svgClass} role="img" aria-labelledby={`${id}-t`} {...readout.svg}>
        <title id={`${id}-t`}>{`${barLabel} and ${lineLabel} over time`}</title>
        <Grid x0={x0} x1={x1} y0={y0} y1={y1} max={barMax} fontSize={TEXT} />
        {!narrow && (
          <g className="text-muted" fontSize={TEXT}>
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
        )}
        {points.map((p, i) => (
          <g key={p.label} {...readout.mark(i)}>
            <rect x={xAt(i) - slot / 2} y={y0} width={slot} height={y1 - y0} fill="transparent" />
            <rect x={xAt(i) - bw / 2} y={yBar(p.bar)} width={bw} height={Math.max(0, y1 - yBar(p.bar))} rx={3} className={cn('fill-brand-300 transition-opacity dark:fill-brand-600', hover !== null && hover !== i && 'opacity-50')} />
            {labelled && p.bar > 0 && (
              // Inside the foot of a bar tall enough to hold it, clear of the rate lines' points; above a short one.
              <text
                x={xAt(i)}
                y={y1 - yBar(p.bar) >= 22 ? y1 - 6 : Math.max(y0 + 9, yBar(p.bar) - 4)}
                textAnchor="middle"
                fontSize={TEXT}
                fontWeight={700}
                className={y1 - yBar(p.bar) >= 22 && bw >= 22 ? 'fill-brand-900 dark:fill-white' : 'fill-slate-600 dark:fill-slate-300'}
              >
                {fmt(p.bar)}
              </text>
            )}
            {i % every === 0 && (
              <text x={xAt(i)} y={y1 + 16} textAnchor="middle" fontSize={TEXT} className="fill-muted">
                {p.label}
              </text>
            )}
          </g>
        ))}
        {segments.map((s, i) => (
          <polyline key={i} points={s} fill="none" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" className="pointer-events-none stroke-rose-500" />
        ))}
        {points.map((p, i) => p.line !== null && <circle key={p.label} cx={xAt(i)} cy={yLine(p.line)} r={hover === i ? 5 : 3} className="pointer-events-none fill-white stroke-rose-500 dark:fill-slate-900" strokeWidth={2} />)}
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
            <g key={l.label} className="pointer-events-none">
              {segs.map((s, i) => <polyline key={i} points={s} fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" className={l.className} />)}
              {l.values.map((v, i) => v !== null && <circle key={i} cx={xAt(i)} cy={yLine(v)} r={hover === i ? 4 : 2.5} className={cn('fill-white dark:fill-slate-900', l.className)} strokeWidth={2} />)}
            </g>
          )
        })}
        {/* The figures last, over every line, so no line crosses one. */}
        {labelled &&
          points.map((p, i) => {
            // Every rate figure at this point — the main line's and each extra line's — spread so none covers another.
            const marks = [
              ...(p.line !== null ? [{ key: 'main', v: p.line, cls: 'fill-rose-600 dark:fill-rose-400', size: TEXT, weight: 700 }] : []),
              ...(lines.length <= 3 ? lines.flatMap((l) => (l.values[i] !== null && l.values[i] !== undefined ? [{ key: l.label, v: l.values[i]!, cls: 'fill-muted', size: TEXT_SMALL, weight: 600 }] : [])) : []),
            ]
            const ys = spreadLabels(marks.map((m) => yLine(m.v) + 3), 13, y0 + 8, y1 - 2)
            return marks.map((m, k) => {
              const text = `${fmt(m.v)}${lineUnit}`
              // Beside the bar, kept inside the drawing: the last point's figure would run past its right edge.
              const x = Math.min(xAt(i) + bw / 2 + 4, W - 2 - text.length * CHAR_WIDTH_BOLD)
              return (
                <text key={`v-${p.label}-${m.key}`} x={x} y={ys[k]} fontSize={m.size} fontWeight={m.weight} className={cn('pointer-events-none', m.cls, LABEL_HALO)} strokeWidth={3} style={{ paintOrder: 'stroke' }}>
                  {text}
                </text>
              )
            })
          })}
        {h && <line x1={xAt(hover!)} x2={xAt(hover!)} y1={y0} y2={y1} className="pointer-events-none stroke-slate-400" strokeDasharray="3 3" />}
      </svg>
      <div ref={d.legend} className={LEGEND}>
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
          <span className={READOUT}>
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

/**
 * Bars sorted largest first with the running share drawn over them. Each bar
 * is named under it, slanted; on a phone it is numbered instead, the names
 * listed under the chart against their numbers, and the share's axis gives
 * way to a mark on its 80% line.
 */
export function ParetoChart({ bars, height = 240, onPick, width }: { bars: ParetoBar[]; height?: number; onPick?: (label: string) => void; width?: number }) {
  const d = useDrawing(width, height)
  const coarse = useCoarsePointer()
  const readout = useReadout(d.figure)
  const hover = readout.at
  const id = useId()
  const { W, H } = d
  const n = bars.length
  if (n === 0) return <ChartEmpty height={height} />
  const narrow = W < NARROW
  const max = niceMax(Math.max(...bars.map((b) => b.value)))
  const pad = { l: axisRoom({ min: 0, max, steps: 4 }, '', fmt), r: narrow ? 30 : 40, t: 16, b: narrow ? 26 : 66 }
  const x0 = pad.l
  const x1 = W - pad.r
  const y0 = pad.t
  const y1 = H - pad.b
  const slot = (x1 - x0) / n
  const bw = Math.max(4, Math.min(40, slot * 0.66))
  const xAt = (i: number) => x0 + slot * i + slot / 2
  const yBar = (v: number) => y1 - ((y1 - y0) * v) / max
  const yPct = (v: number) => y1 - ((y1 - y0) * v) / 100
  const line = bars.map((b, i) => `${xAt(i)},${yPct(b.cumulativePct)}`).join(' ')
  const eighty = bars.findIndex((b) => b.cumulativePct >= 80)
  const valued = longestOf(bars.map((b) => fmt(b.value))) * CHAR_WIDTH_BOLD + 2 <= slot
  const picked = hover !== null ? bars[hover] : null
  return (
    <figure ref={d.figureRef} className={d.figureClass}>
      <svg viewBox={`0 0 ${W} ${H}`} height={H} className={d.svgClass} role="img" aria-labelledby={`${id}-t`} {...readout.svg}>
        <title id={`${id}-t`}>Pareto of defects</title>
        <Grid x0={x0} x1={x1} y0={y0} y1={y1} max={max} fontSize={TEXT} />
        {narrow ? (
          <text x={x1 + 4} y={yPct(80) + 3} fontSize={TEXT_SMALL} fontWeight={600} className="fill-amber-600 dark:fill-amber-400">
            80%
          </text>
        ) : (
          <g className="text-muted" fontSize={TEXT}>
            {[0, 25, 50, 75, 100].map((v) => (
              <text key={v} x={x1 + 6} y={yPct(v) + 3} fill="currentColor">
                {v}%
              </text>
            ))}
          </g>
        )}
        <line x1={x0} x2={x1} y1={yPct(80)} y2={yPct(80)} className="stroke-amber-500" strokeDasharray="4 4" strokeOpacity={0.7} />
        {bars.map((b, i) => {
          const vital = eighty === -1 || i <= eighty
          const label = b.label.length > 14 ? `${b.label.slice(0, 13)}…` : b.label
          return (
            <g key={b.label} {...readout.mark(i, b.label, onPick && (() => onPick(b.label)))}>
              <rect x={xAt(i) - slot / 2} y={y0} width={slot} height={y1 - y0} fill="transparent" />
              <rect x={xAt(i) - bw / 2} y={yBar(b.value)} width={bw} height={Math.max(0, y1 - yBar(b.value))} rx={4} className={cn(vital ? 'fill-rose-500' : 'fill-slate-300 dark:fill-slate-600', hover !== null && hover !== i && 'opacity-60')} />
              {valued && (
                <text x={xAt(i)} y={yBar(b.value) - 4} textAnchor="middle" fontSize={TEXT} className="fill-slate-600 dark:fill-slate-300">
                  {fmt(b.value)}
                </text>
              )}
              {narrow ? (
                <text x={xAt(i)} y={y1 + 16} textAnchor="middle" fontSize={TEXT} fontWeight={600} className="fill-muted">
                  {i + 1}
                </text>
              ) : (
                <text transform={`translate(${xAt(i)} ${y1 + 8}) rotate(-28)`} textAnchor="end" fontSize={TEXT} className="fill-muted">
                  {label}
                </text>
              )}
            </g>
          )
        })}
        <polyline points={line} fill="none" strokeWidth={2} className="pointer-events-none stroke-brand-600 dark:stroke-brand-300" strokeLinejoin="round" />
        {bars.map((b, i) => (
          <circle key={b.label} cx={xAt(i)} cy={yPct(b.cumulativePct)} r={3} className="pointer-events-none fill-white stroke-brand-600 dark:fill-slate-900 dark:stroke-brand-300" strokeWidth={2} />
        ))}
      </svg>
      <div ref={d.legend}>
        <div className={LEGEND}>
          <span className="inline-flex items-center gap-1.5">
            <i className="inline-block h-2.5 w-2.5 rounded-sm bg-rose-500" /> Vital few (to 80%)
          </span>
          <span className="inline-flex items-center gap-1.5">
            <i className="inline-block h-0.5 w-4 rounded bg-brand-600 dark:bg-brand-300" /> Cumulative share
          </span>
          {onPick && !picked && <span className="print-hidden ml-auto text-muted">{coarse ? 'Tap a bar for its figures and sessions' : 'Tap a bar for its sessions'}</span>}
          {picked && (
            <span className={cn(READOUT, 'inline-flex flex-wrap items-center justify-end gap-x-2 gap-y-1')}>
              <span dir="auto">{picked.label}</span>: {fmt(picked.value)} pieces · {fmt(picked.cumulativePct)}% cumulative
              {readout.tapped && onPick && !isOthers(picked.label) && (
                <button type="button" onClick={() => onPick(picked.label)} className={OPEN_BUTTON}>
                  Open sessions →
                </button>
              )}
            </span>
          )}
        </div>
        {/* On a phone the bars carry numbers; their names, in order, here. A name opens its sessions at once. */}
        {narrow && (
          <ol className="mt-2 grid grid-cols-1 gap-x-3 min-[340px]:grid-cols-2">
            {bars.map((b, i) => {
              const opens = !!onPick && !isOthers(b.label)
              const body = (
                <>
                  <span className="w-5 shrink-0 text-right font-semibold tabular-nums text-muted">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate" dir="auto">
                    {b.label}
                  </span>
                  <span className="shrink-0 font-semibold tabular-nums">{fmt(b.value)}</span>
                </>
              )
              return (
                <li key={b.label} className={cn('text-xs', hover === i && 'rounded-md bg-slate-100 dark:bg-slate-800')}>
                  {opens ? (
                    <button type="button" onClick={() => onPick!(b.label)} className="flex min-h-[32px] w-full items-center gap-2 rounded-md px-1 text-left text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800 touch:min-h-[40px]" aria-label={`Open ${b.label}`}>
                      {body}
                    </button>
                  ) : (
                    <span className="flex min-h-[32px] items-center gap-2 px-1 text-slate-600 dark:text-slate-300">{body}</span>
                  )}
                </li>
              )
            })}
          </ol>
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
export function DonutChart({ slices, centerLabel, size = 160, onPick }: { slices: Slice[]; centerLabel: string; size?: number; onPick?: (label: string) => void }) {
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
        <text x="60" y="73" textAnchor="middle" fontSize="9" className="fill-muted">
          {centerLabel}
        </text>
      </svg>
      <ul className="min-w-[10rem] flex-1 space-y-1.5 text-sm">
        {slices.map((s) => (
          <li key={s.label} className={cn('flex items-start gap-2 py-0.5 touch:py-2.5', onPick && s.value > 0 && 'rounded-md hover:bg-slate-50 dark:hover:bg-slate-800')} {...(s.value > 0 ? pickable(onPick && (() => onPick(s.label)), s.label) : {})}>
            <i className={cn('mt-1.5 inline-block h-2.5 w-2.5 shrink-0 rounded-full', s.className.replace(/stroke-/g, 'bg-'))} />
            <span className="min-w-0 flex-1 break-words leading-snug text-slate-600 dark:text-slate-300">{s.label}</span>
            <span className="font-semibold tabular-nums">{fmt(s.value)}</span>
            <span className="w-12 text-right text-xs tabular-nums text-muted">{total > 0 ? `${Math.round((s.value / total) * 100)}%` : '—'}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Fill classes for the slices of a pie, in the order the slices come; the last one is for "Others". */
export const PIE_CLASSES = ['fill-brand-500', 'fill-rose-500', 'fill-emerald-500', 'fill-amber-500', 'fill-violet-500', 'fill-sky-500', 'fill-pink-500', 'fill-teal-500', 'fill-orange-500', 'fill-muted']

export interface PieSlice {
  /** What the slice stands for, when its label is not enough to find it again: a machine code, a factory. */
  key?: string
  label: string
  sub?: string
  value: number
  /** A fill-* class. */
  className: string
}

/**
 * The slices of a pie: the largest `keep` rows of `rows` in their own colour,
 * the rest of them as one "Others" slice. Rows worth nothing are left out.
 */
export function slicesOf(rows: { key?: string; label: string; sub?: string; value: number }[], keep = PIE_CLASSES.length - 1): PieSlice[] {
  const sorted = rows.filter((r) => r.value > 0).sort((a, b) => b.value - a.value)
  const head = sorted.slice(0, keep).map((r, i) => ({ ...r, className: PIE_CLASSES[i] }))
  const tail = sorted.slice(keep)
  if (tail.length) head.push({ label: `Others (${tail.length})`, value: tail.reduce((n, r) => n + r.value, 0), className: PIE_CLASSES[PIE_CLASSES.length - 1] })
  return head
}

/**
 * A pie with the share written on every slice wide enough to carry it, the
 * total in the middle, and the legend beside it: each slice's pieces and
 * share. On a board it fills its box; the legend scrolls when it is long. Its
 * words are sized for the size it is shown at, never under 10 px. A slice
 * clicked opens what it stands for; a slice tapped is first picked out in the
 * legend, with an Open button there — a second tap on it opens it too. A
 * legend row opens at once: it already says what it is.
 */
export function PieChart({ slices, centerLabel, unit = '', onPick, format = fmt }: { slices: PieSlice[]; centerLabel: string; unit?: string; onPick?: (slice: PieSlice) => void; format?: FigureFormat }) {
  const fill = useContext(ChartFillContext)
  const [wrap, setWrap] = useState<HTMLElement | null>(null)
  const [svg, setSvg] = useState<SVGSVGElement | null>(null)
  const readout = useReadout(wrap)
  const [shown, setShown] = useState(0)
  useMeasureEffect(() => {
    if (!svg) return
    const read = () => setShown(Math.round(svg.getBoundingClientRect().width))
    read()
    if (typeof ResizeObserver === 'undefined') return
    const watch = new ResizeObserver(read)
    watch.observe(svg)
    return () => watch.disconnect()
  }, [svg])
  // The drawing is 200 across, shown at `shown` px (176 by default): its words are sized in the drawing's units so they keep their px.
  const k = 200 / (shown > 0 ? shown : 176)
  const total = slices.reduce((n, s) => n + s.value, 0)
  const cx = 100
  const cy = 100
  const r = 78
  const hole = 40
  const arc = (from: number, to: number): string => {
    // A ring sector from angle `from` to `to` (turns, clockwise from twelve o'clock).
    const a0 = (from - 0.25) * 2 * Math.PI
    const a1 = (to - 0.25) * 2 * Math.PI
    const big = to - from > 0.5 ? 1 : 0
    const o0 = [cx + r * Math.cos(a0), cy + r * Math.sin(a0)]
    const o1 = [cx + r * Math.cos(a1), cy + r * Math.sin(a1)]
    const i0 = [cx + hole * Math.cos(a0), cy + hole * Math.sin(a0)]
    const i1 = [cx + hole * Math.cos(a1), cy + hole * Math.sin(a1)]
    return `M${o0[0]},${o0[1]} A${r},${r} 0 ${big} 1 ${o1[0]},${o1[1]} L${i1[0]},${i1[1]} A${hole},${hole} 0 ${big} 0 ${i0[0]},${i0[1]} Z`
  }
  let at = 0
  const drawn = slices
    .filter((s) => s.value > 0)
    .map((s) => {
      const share = total > 0 ? s.value / total : 0
      const from = at
      at += share
      const mid = (from + share / 2 - 0.25) * 2 * Math.PI
      const lr = (r + hole) / 2
      return { ...s, share, from, to: at, lx: cx + lr * Math.cos(mid), ly: cy + lr * Math.sin(mid) }
    })
  if (total <= 0) return <ChartEmpty height={fill ? 120 : 160} />
  const picked = readout.at
  const open = (s: PieSlice) => onPick && (() => onPick(s))
  return (
    <div ref={setWrap} className={cn('flex gap-4', fill ? 'h-full min-h-0 flex-col sm:flex-row' : 'flex-wrap items-center')}>
      <svg ref={setSvg} viewBox="0 0 200 200" className={cn(fill ? 'mx-auto h-auto max-h-full min-h-0 w-auto flex-1 sm:mx-0' : 'h-44 w-44')} role="img" aria-label={`${centerLabel}: ${format(total)}${unit}`} {...readout.svg}>
        {drawn.length === 1 ? (
          <circle cx={cx} cy={cy} r={(r + hole) / 2} fill="none" strokeWidth={r - hole} className={drawn[0].className.replace(/fill-/g, 'stroke-')} {...readout.mark(0, drawn[0].label, open(drawn[0]))} />
        ) : (
          drawn.map((s, i) => (
            <path
              key={s.label}
              d={arc(s.from, s.to)}
              className={cn(s.className, 'stroke-white transition-opacity dark:stroke-slate-900', onPick && !isOthers(s.label) && 'hover:opacity-80', picked !== null && picked !== i && 'opacity-50')}
              strokeWidth="1.5"
              {...readout.mark(i, s.label, open(s))}
            />
          ))
        )}
        {drawn.map((s) => s.share >= 0.06 && (
          <text key={`t-${s.label}`} x={s.lx} y={s.ly} textAnchor="middle" dominantBaseline="middle" fontSize={TEXT * k} fontWeight="700" className="pointer-events-none fill-white" style={{ paintOrder: 'stroke', stroke: 'rgba(15,23,42,.45)', strokeWidth: 2 }}>
            {Math.round(s.share * 100)}%
          </text>
        ))}
        <text x={cx} y={cy - 4} textAnchor="middle" fontSize={Math.max(16, 15 * k)} fontWeight="700" className="pointer-events-none fill-slate-800 dark:fill-white">
          {format(total)}{unit}
        </text>
        <text x={cx} y={cy + 4 + TEXT_SMALL * k} textAnchor="middle" fontSize={TEXT_SMALL * k} className="pointer-events-none fill-muted">
          {centerLabel}
        </text>
      </svg>
      <ul className={cn('min-w-0 space-y-1 text-sm', fill ? 'max-h-full shrink-0 overflow-auto sm:w-[46%]' : 'min-w-[10rem] flex-1')}>
        {drawn.map((s, i) => (
          <li
            key={s.label}
            className={cn('flex flex-wrap items-start gap-x-2 py-0.5 touch:py-2.5', onPick && !isOthers(s.label) && 'rounded-md hover:bg-slate-50 dark:hover:bg-slate-800', picked === i && 'rounded-md bg-slate-100 ring-1 ring-slate-200 dark:bg-slate-800 dark:ring-slate-700')}
            {...pickable(open(s), s.label)}
          >
            <i className={cn('mt-1.5 inline-block h-2.5 w-2.5 shrink-0 rounded-full', s.className.replace(/fill-/g, 'bg-'))} />
            {/* Two lines under a mouse, the whole name in the tooltip; a finger gets no tooltip, so the whole name. */}
            <span className="line-clamp-2 min-w-0 flex-1 break-words leading-snug text-slate-600 dark:text-slate-300 touch:line-clamp-none" data-tip={s.sub ? `${s.label} · ${s.sub}` : s.label}>
              {s.label}
              {s.sub && <span className="ml-1 text-xs text-muted">{s.sub}</span>}
            </span>
            <span className="font-semibold tabular-nums">{format(s.value)}</span>
            <span className="w-14 text-right text-xs tabular-nums text-muted">{`${Math.round(s.share * 10000) / 100}%`}</span>
            {/* Tapped on the pie: this row is its read-out, and the row (a button already) opens it. */}
            {picked === i && readout.tapped && onPick && !isOthers(s.label) && (
              <span className="flex basis-full justify-end pt-1" aria-hidden>
                <span className={OPEN_BUTTON}>Open sessions →</span>
              </span>
            )}
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

/**
 * Horizontal bars, one per row, coloured by how the value compares with its
 * target. A row's name takes two lines rather than being cut, and its second
 * line ("1,815 made · 24 rejected") a line of its own under it.
 */
export function HorizontalBars({ rows, max, unit = '' }: { rows: HBar[]; max?: number; unit?: string }) {
  if (rows.length === 0) return <ChartEmpty height={80} />
  const top = max ?? niceMax(Math.max(...rows.map((r) => r.value ?? 0)))
  return (
    <ul className="space-y-2">
      {rows.map((r) => {
        const w = r.value === null ? 0 : Math.min(100, (r.value / top) * 100)
        const inner = (
          <>
            {/* The figures beside the name while both fit; a long one ("no closed production · …") goes under it rather than squeeze it. */}
            <div className="flex flex-wrap items-start justify-between gap-x-2 text-sm">
              <span className="min-w-[9rem] flex-1">
                <span className="line-clamp-2 break-words font-medium leading-snug text-slate-700 dark:text-slate-200" dir="auto">
                  {r.label}
                </span>
                {r.sub && (
                  <span className="block break-words text-xs font-normal leading-snug text-muted" dir="auto">
                    {r.sub}
                  </span>
                )}
              </span>
              <span className="ml-auto shrink-0 pt-0.5 text-right text-xs tabular-nums text-muted">{r.text}</span>
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
          <li key={r.label + (r.sub ?? '')} className="relative">
            {r.onClick ? (
              <button type="button" onClick={r.onClick} className="block w-full rounded-lg px-1 py-0.5 text-left transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/60 touch:py-2">
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
    <div className="grid place-items-center rounded-xl border border-dashed border-slate-200 text-sm text-muted dark:border-slate-700" style={{ minHeight: height }}>
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

/**
 * Two bars per day on one axis: what was inspected and what was found wrong.
 * One scale, so the eye compares heights directly — no second axis to read.
 * With `weekly` (the same points a week each), a chart too narrow for a bar a
 * day — a long period on a phone — draws a bar a week instead.
 */
export function PairedBarChart({ points: days, totalLabel, partLabel, height = 220, weekly, width }: { points: PairedPoint[]; totalLabel: string; partLabel: string; height?: number; weekly?: PairedPoint[]; width?: number }) {
  const d = useDrawing(width, height)
  const readout = useReadout(d.figure)
  const hover = readout.at
  const id = useId()
  const { W, H } = d
  const pad = { l: 44, r: 12, t: 30, b: 34 }
  const x0 = pad.l
  const x1 = W - pad.r
  const y0 = pad.t
  const y1 = H - pad.b
  const byWeek = !!weekly && weekly.length > 0 && (x1 - x0) / Math.max(1, days.length) < MIN_DAY_SLOT
  const points = byWeek ? weekly! : days
  const n = points.length
  if (n === 0) return <ChartEmpty height={height} />
  const max = niceMax(Math.max(...points.map((p) => Math.max(p.total, p.part))))
  const slot = (x1 - x0) / n
  const bw = Math.max(2, Math.min(16, slot * 0.32))
  const xAt = (i: number) => x0 + slot * i + slot / 2
  const yAt = (v: number) => y1 - ((y1 - y0) * v) / max
  const every = labelEvery(n, x1 - x0, longestOf(points.map((p) => p.label)))
  const h = hover !== null ? points[hover] : null
  // The value sits on its bar. Where the bars are packed too close for that, it
  // stands upright beside the bar's top instead of overlapping its neighbour;
  // closer still, there is no room for one at all, and the read-out says it.
  const widest = longestOf(points.flatMap((p) => [fmt(p.total), fmt(p.part)])) * CHAR_WIDTH_BOLD
  const upright = slot < 44 || widest > 2 * bw + 2
  const labelled = slot >= 26
  const label = (x: number, v: number, cls: string) =>
    labelled &&
    v > 0 && (
      <text
        x={x}
        y={yAt(v) - 4}
        textAnchor={upright ? 'start' : 'middle'}
        fontSize={upright ? TEXT_SMALL : TEXT}
        fontWeight={700}
        transform={upright ? `rotate(-90 ${x} ${yAt(v) - 4})` : undefined}
        className={cls}
      >
        {fmt(v)}
      </text>
    )
  return (
    <figure ref={d.figureRef} className={d.figureClass}>
      <svg viewBox={`0 0 ${W} ${H}`} height={H} className={d.svgClass} role="img" aria-labelledby={`${id}-t`} {...readout.svg}>
        <title id={`${id}-t`}>{`${totalLabel} and ${partLabel} by ${byWeek ? 'week' : 'day'}`}</title>
        <Grid x0={x0} x1={x1} y0={y0} y1={y1} max={max} fontSize={TEXT} />
        {points.map((p, i) => (
          <g key={p.label} {...readout.mark(i)} className={cn('transition-opacity', hover !== null && hover !== i && 'opacity-50')}>
            <rect x={xAt(i) - slot / 2} y={y0} width={slot} height={y1 - y0} fill="transparent" />
            <rect x={xAt(i) - bw - 1} y={yAt(p.total)} width={bw} height={Math.max(0, y1 - yAt(p.total))} rx={2} className="fill-brand-300 dark:fill-brand-600" />
            <rect x={xAt(i) + 1} y={yAt(p.part)} width={bw} height={Math.max(0, y1 - yAt(p.part))} rx={2} className="fill-rose-500" />
            {label(xAt(i) - bw / 2 - 1, p.total, 'fill-brand-700 dark:fill-brand-200')}
            {label(xAt(i) + bw / 2 + 1, p.part, 'fill-rose-600 dark:fill-rose-300')}
            {i % every === 0 && (
              <text x={xAt(i)} y={y1 + 16} textAnchor="middle" fontSize={TEXT} className="fill-muted">
                {p.label}
              </text>
            )}
          </g>
        ))}
      </svg>
      <div ref={d.legend} className={LEGEND}>
        <span className="inline-flex items-center gap-1.5">
          <i className="inline-block h-2.5 w-2.5 rounded-sm bg-brand-300 dark:bg-brand-600" /> {totalLabel}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <i className="inline-block h-2.5 w-2.5 rounded-sm bg-rose-500" /> {partLabel}
        </span>
        {byWeek && <span>A bar a week</span>}
        {h && (
          <span className={READOUT}>
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

/**
 * Columns in a fixed order — a histogram: how many fell in each band. A
 * column clicked opens what it stands for; tapped, it is first read out under
 * the chart with an Open button, and a second tap on it opens it too.
 */
export function ColumnChart({ columns, height = 200, unit = '', onPick, width }: { columns: Column[]; height?: number; unit?: string; onPick?: (index: number) => void; width?: number }) {
  const d = useDrawing(width, height)
  const readout = useReadout(d.figure)
  const hover = readout.at
  const id = useId()
  const { W, H } = d
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
  const picked = hover !== null ? columns[hover] : null
  return (
    <figure ref={d.figureRef} className={d.figureClass}>
      <svg viewBox={`0 0 ${W} ${H}`} height={H} className={d.svgClass} role="img" aria-labelledby={`${id}-t`} {...readout.svg}>
        <title id={`${id}-t`}>{columns.map((c) => `${c.label}: ${fmt(c.value)}${unit}`).join(', ')}</title>
        <Grid x0={x0} x1={x1} y0={y0} y1={y1} max={max} unit={unit} fontSize={TEXT} />
        {columns.map((c, i) => (
          <g key={c.label} {...(c.value > 0 ? readout.mark(i, c.label, onPick && (() => onPick(i))) : {})}>
            {onPick && c.value > 0 && <rect x={xAt(i) - slot / 2} y={y0} width={slot} height={y1 - y0} fill="transparent" />}
            <rect x={xAt(i) - bw / 2} y={yAt(c.value)} width={bw} height={Math.max(0, y1 - yAt(c.value))} rx={4} className={cn(fill[c.tone ?? 'neutral'], 'transition-opacity', hover !== null && hover !== i && 'opacity-50')} />
            {c.value > 0 && (
              <text x={xAt(i)} y={yAt(c.value) - 5} textAnchor="middle" fontSize={TEXT} fontWeight={700} className="fill-slate-700 dark:fill-slate-200">
                {fmt(c.value)}
                {unit}
              </text>
            )}
            <text x={xAt(i)} y={y1 + 15} textAnchor="middle" fontSize={TEXT} fontWeight={600} className="fill-slate-600 dark:fill-slate-300">
              {c.label}
            </text>
            {c.sub && (
              <text x={xAt(i)} y={y1 + 29} textAnchor="middle" fontSize={TEXT_SMALL} className="fill-muted">
                {c.sub}
              </text>
            )}
          </g>
        ))}
      </svg>
      <div ref={d.legend} className={cn(LEGEND, !picked && 'hidden')}>
        {picked && (
          <span className={cn(READOUT, 'inline-flex flex-wrap items-center justify-end gap-x-2 gap-y-1')}>
            {picked.label}: {fmt(picked.value)}
            {unit}
            {picked.sub && ` · ${picked.sub}`}
            {readout.tapped && onPick && (
              <button type="button" onClick={() => onPick(hover!)} className={OPEN_BUTTON}>
                Open sessions →
              </button>
            )}
          </span>
        )}
      </div>
    </figure>
  )
}

/** One part of a stacked column: a defect's pieces on one machine. */
export interface StackSegment {
  label: string
  value: number
  /** A fill-* class; the same series keeps the same class on every column. */
  className: string
}

/**
 * Columns of stacked parts: a column a machine, a part a defect, so one
 * defect can be followed across the machines. The total is written on each
 * column; hovering or tapping one lists its parts, largest first. `width`: the
 * drawing's width, for a chart drawn at the size it is shown (the
 * assistant's, §20); without it the chart measures its own. `fitted`: drawn
 * for any query's result (the assistant's, whose results may hold a column a
 * day): the value axis fitted to the totals, and with many columns only every
 * few named and totalled, as the line charts do; off on the dashboard, where
 * every machine is named while the names stand apart. Slanted names get the
 * room at the left the first ones need, and on a phone are cut shorter (the
 * read-out names a column in full). `format`: how figures are written.
 */
export function StackedColumnChart({
  columns,
  legend,
  height = 240,
  unit = '',
  width,
  fitted = false,
  format = fmt,
}: {
  columns: { label: string; segments: StackSegment[] }[]
  legend: { label: string; className: string }[]
  height?: number
  unit?: string
  width?: number
  fitted?: boolean
  format?: FigureFormat
}) {
  const d = useDrawing(width, height)
  const readout = useReadout(d.figure)
  const hover = readout.at
  const id = useId()
  const W = d.W
  const n = columns.length
  const totals = columns.map((c) => c.segments.reduce((t, sg) => t + sg.value, 0))
  if (n === 0 || totals.every((v) => v === 0)) return <ChartEmpty height={height} />
  const axis = niceBounds(0, Math.max(...totals), fitted)
  const slot0 = (W - 56) / n
  // Slanted names when a straight one would not fit its column.
  const tilt = columns.some((c) => c.label.length * CHAR_WIDTH_WIDE > slot0)
  const cap = W < NARROW ? 16 : 26
  const names = columns.map((c) => (tilt && c.label.length > cap ? `${c.label.slice(0, cap - 1)}…` : c.label))
  const pad = { l: 44, r: 12, t: 22, b: tilt ? 96 : 34 }
  // The slanted names take their room below; the plot keeps its height (on a board, the box's height is all there is).
  const H = d.filled ? d.H : height + (tilt ? 62 : 0)
  const x1 = W - pad.r
  // Thinned: fitted, as many names as fit the width; on the dashboard every one, unless slanted names would touch.
  const everyFor = (x0: number) => (fitted ? Math.max(1, Math.ceil(n / Math.max(4, Math.round(((tilt ? 24 : 12) * (x1 - x0)) / 664)))) : Math.max(1, Math.ceil(16 / ((x1 - x0) / n))))
  // Slanted, the margin holds the first names (reckoned with the names a narrower margin would show: as many or more); fitted, the axis' figures as well.
  const x0 = Math.min(Math.round(W * 0.35), Math.max(fitted ? axisRoom(axis, unit, format) : pad.l, tilt ? slantRoom(names, x1, CHAR_WIDTH_WIDE, 11, (i) => i % everyFor(pad.l) === 0) : 0))
  const y0 = pad.t
  const y1 = H - pad.b
  const slot = (x1 - x0) / n
  const bw = Math.min(64, slot * 0.6)
  const xAt = (i: number) => x0 + slot * i + slot / 2
  const hAt = (v: number) => ((y1 - y0) * v) / axis.max
  const every = everyFor(x0)
  // A total only on a column wide enough for it.
  const totalled = slot >= 24
  return (
    <figure ref={d.figureRef} className={d.figureClass}>
      <svg viewBox={`0 0 ${W} ${H}`} height={H} className={d.svgClass} role="img" aria-labelledby={`${id}-t`} {...readout.svg}>
        <title id={`${id}-t`}>{columns.map((c, i) => `${c.label}: ${format(totals[i])}${unit}`).join(', ')}</title>
        <Grid x0={x0} x1={x1} y0={y0} y1={y1} max={axis.max} steps={axis.steps} unit={unit} format={format} fontSize={fitted ? 10 : TEXT} />
        {columns.map((c, i) => {
          let top = y1
          return (
            <g key={c.label} {...readout.mark(i)}>
              <rect x={xAt(i) - slot / 2} y={y0} width={slot} height={y1 - y0} fill="transparent" />
              {c.segments.map((sg) => {
                if (sg.value <= 0) return null
                const h = hAt(sg.value)
                top -= h
                return <rect key={sg.label} x={xAt(i) - bw / 2} y={top} width={bw} height={Math.max(0, h)} className={cn(sg.className, 'stroke-white transition-opacity dark:stroke-slate-900', hover !== null && hover !== i && 'opacity-50')} strokeWidth={1} />
              })}
              {totalled && totals[i] > 0 && (
                <text x={xAt(i)} y={top - 5} textAnchor="middle" fontSize="11" fontWeight={700} className="fill-slate-700 dark:fill-slate-200">
                  {format(totals[i])}
                  {unit}
                </text>
              )}
              {i % every !== 0 ? null : tilt ? (
                <text x={xAt(i)} y={y1 + 12} textAnchor="end" fontSize="11" fontWeight={600} transform={`rotate(-35 ${xAt(i)} ${y1 + 12})`} className="fill-slate-600 dark:fill-slate-300" data-tip={c.label}>
                  {names[i]}
                </text>
              ) : (
                <text x={xAt(i)} y={y1 + 15} textAnchor="middle" fontSize="11" fontWeight={600} className="fill-slate-600 dark:fill-slate-300">
                  {c.label}
                </text>
              )}
            </g>
          )
        })}
      </svg>
      <div ref={d.legend} className={LEGEND}>
        {hover === null
          ? legend.map((l) => (
              <span key={l.label} className="inline-flex items-center gap-1.5">
                <svg width="10" height="10" aria-hidden className="shrink-0"><rect width="10" height="10" rx="2" className={l.className} /></svg>
                <span dir="auto">{l.label}</span>
              </span>
            ))
          : [...columns[hover].segments]
              .filter((sg) => sg.value > 0)
              .sort((a, b) => b.value - a.value)
              .map((sg) => (
                <span key={sg.label} className="inline-flex items-center gap-1.5">
                  <svg width="10" height="10" aria-hidden className="shrink-0"><rect width="10" height="10" rx="2" className={sg.className} /></svg>
                  <span dir="auto">{sg.label}</span> <span className="font-semibold tabular-nums text-slate-700 dark:text-slate-200">{format(sg.value)}{unit}</span>
                </span>
              ))}
        {hover !== null && <span className="ml-auto font-semibold text-slate-700 dark:text-slate-200" dir="auto">{columns[hover].label}</span>}
      </div>
    </figure>
  )
}

/** One series of grouped bars: a value per category (null for none) and a fill-* class. */
export interface BarSeries {
  label: string
  values: (number | null)[]
  className: string
}

/**
 * Bars for one to a few series side by side over the same categories — the
 * assistant's bar charts (§20), drawn for any query's result: the value axis
 * fitted to the figures (niceBounds' `tight`), a figure below zero hanging
 * down from the zero line, and the left margin as wide as the axis' figures
 * and the first slanted names need. The value is written on each bar while
 * there is room; names too long to stand straight under their bars are
 * slanted, and when there are many only as many as fit the width are
 * written. Hovering or tapping a category reads every series out under the
 * chart, as the line charts do. `width`: the drawing's width, for a chart
 * drawn at the size it is shown. `format`: how figures are written.
 */
export function GroupedBarChart({ labels, series, unit = '', height = 220, width = 720, format = fmt }: { labels: string[]; series: BarSeries[]; unit?: string; height?: number; width?: number; format?: FigureFormat }) {
  const d = useDrawing(width, height)
  const readout = useReadout(d.figure)
  const hover = readout.at
  const id = useId()
  const W = width
  const n = labels.length
  const known = series.flatMap((s) => s.values.filter((v): v is number => v !== null && v !== undefined))
  if (n === 0 || series.length === 0 || known.every((v) => v === 0)) return <ChartEmpty height={height} />
  const axis = niceBounds(Math.min(0, ...known), Math.max(...known), true)
  const slot0 = (W - 56) / n
  // Slanted names when a straight one would not fit its column.
  const tilt = labels.some((l) => l.length * CHAR_WIDTH_WIDE > slot0)
  const names = labels.map((l) => (tilt && l.length > 26 ? `${l.slice(0, 25)}…` : l))
  const pad = { l: 44, r: 12, t: 22, b: tilt ? 96 : 34 }
  // The slanted names take their room below; the plot keeps its height.
  const H = height + (tilt ? 62 : 0)
  const x1 = W - pad.r
  const everyFor = (x0: number) => Math.max(1, Math.ceil(n / Math.max(4, Math.round(((tilt ? 24 : 12) * (x1 - x0)) / 664))))
  // The margin holds the axis' figures and the first slanted names (reckoned with the names a narrower margin would show: as many or more).
  const x0 = Math.min(Math.round(W * 0.35), Math.max(axisRoom(axis, unit, format), tilt ? slantRoom(names, x1, CHAR_WIDTH, 10, (i) => i % everyFor(pad.l) === 0) : 0))
  const y0 = pad.t
  const y1 = H - pad.b
  const slot = (x1 - x0) / n
  const gap = series.length > 1 ? 2 : 0
  const group = Math.min(slot * 0.72, (series.length > 1 ? 26 : 56) * series.length)
  const bw = Math.max(1.5, (group - gap * (series.length - 1)) / series.length)
  const xAt = (i: number) => x0 + slot * i + slot / 2
  const barX = (i: number, k: number) => xAt(i) - group / 2 + k * (bw + gap)
  const yAt = (v: number) => y1 - ((y1 - y0) * (v - axis.min)) / (axis.max - axis.min)
  const base = yAt(0)
  const every = everyFor(x0)
  // A figure on every bar only while each has the room for one.
  const labelled = bw >= 16 && n * series.length <= 32
  const valueOf = (s: BarSeries, i: number) => {
    const v = s.values[i]
    return v === null || v === undefined || v === 0 ? null : v
  }
  // What a screen reader hears: the series, then each category's figures while there are few enough to hear out.
  const figure = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${format(v)}${unit}`)
  const summary = `${series.map((s) => s.label).join(', ')}: ${n <= 24 ? labels.map((l, i) => `${l} ${series.map((s) => figure(s.values[i])).join(' / ')}`).join(', ') : `${n} categories`}`
  return (
    <figure ref={d.figureRef} className={d.figureClass}>
      <svg viewBox={`0 0 ${W} ${H}`} className={d.svgClass} role="img" aria-labelledby={`${id}-t`} {...readout.svg}>
        <title id={`${id}-t`}>{summary}</title>
        <Grid x0={x0} x1={x1} y0={y0} y1={y1} min={axis.min} max={axis.max} steps={axis.steps} unit={unit} format={format} />
        {labels.map((l, i) => (
          <g key={l} {...readout.mark(i)} className={cn('transition-opacity', hover !== null && hover !== i && 'opacity-50')}>
            <rect x={xAt(i) - slot / 2} y={y0} width={slot} height={y1 - y0} fill="transparent" />
            {series.map((s, k) => {
              const v = valueOf(s, i)
              if (v === null) return null
              return <rect key={s.label} x={barX(i, k)} y={Math.min(yAt(v), base)} width={bw} height={Math.abs(base - yAt(v))} rx={Math.min(4, bw / 3)} className={s.className} />
            })}
            {labelled &&
              series.map((s, k) => {
                const v = valueOf(s, i)
                if (v === null) return null
                return (
                  <text key={`t-${s.label}`} x={barX(i, k) + bw / 2} y={v > 0 ? yAt(v) - 4 : Math.min(yAt(v) + 12, y1 - 3)} textAnchor="middle" fontSize="10" fontWeight={700} className="fill-slate-700 dark:fill-slate-200">
                    {format(v)}
                    {unit}
                  </text>
                )
              })}
            {i % every === 0 &&
              (tilt ? (
                <text x={xAt(i)} y={y1 + 12} textAnchor="end" fontSize="10" fontWeight={600} transform={`rotate(-35 ${xAt(i)} ${y1 + 12})`} className="fill-slate-600 dark:fill-slate-300">
                  {names[i]}
                </text>
              ) : (
                <text x={xAt(i)} y={y1 + 16} textAnchor="middle" fontSize="10" className="fill-muted">
                  {l}
                </text>
              ))}
          </g>
        ))}
      </svg>
      <div ref={d.legend} className={LEGEND}>
        {series.map((s) => (
          <span key={s.label} className="inline-flex items-center gap-1.5">
            <svg width="10" height="10" aria-hidden className="shrink-0"><rect width="10" height="10" rx="2" className={s.className} /></svg>
            <span dir="auto">{s.label}</span>
            {hover !== null && (
              <span className="font-semibold tabular-nums text-slate-700 dark:text-slate-200">
                {s.values[hover] === null || s.values[hover] === undefined ? '—' : `${format(s.values[hover]!)}${unit}`}
              </span>
            )}
          </span>
        ))}
        {hover !== null && <span className="ml-auto font-semibold text-slate-700 dark:text-slate-200" dir="auto">{labels[hover]}</span>}
      </div>
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

/**
 * A few lines over the same x axis — one per factory, month by month. A null
 * breaks the line; with `connectGaps` the line runs on to the next known
 * point instead, for days or weeks when nothing was made. With `area` each
 * line's ground is shaded down to zero. A figure below zero takes the axis
 * below zero with it (the assistant's charts; the dashboard's never are).
 */
export function LineChart({
  labels,
  series,
  unit = '%',
  height = 220,
  connectGaps = false,
  area = false,
  width,
  fitted = false,
  format = fmt,
}: {
  labels: string[]
  series: LineSeries[]
  unit?: string
  height?: number
  connectGaps?: boolean
  /** Each line's ground shaded beneath it, faintly (the assistant's area charts); off on the dashboard. */
  area?: boolean
  /** The drawing's width, for a chart drawn at a size its caller picks (the assistant's); without it the chart measures its own. Names along x as many as fit it. */
  width?: number
  /**
   * Drawn for any query's result (the assistant's, which may hold a point a day for years): the value axis fitted
   * to the figures, the left margin as wide as its figures, the names along x as many as stand apart at their
   * length ("Oct 28, 2025") and none past the edge, and the points marked only where they stand apart (and the
   * one hovered). Off on the dashboard, whose names are short and points few.
   */
  fitted?: boolean
  /** How figures are written. */
  format?: FigureFormat
}) {
  const d = useDrawing(width, height)
  const readout = useReadout(d.figure)
  const hover = readout.at
  const id = useId()
  const { W, H } = d
  // The assistant's words are drawn at 10 px, as its own margins reckon them; the dashboard's at 11.
  const text = fitted ? 10 : TEXT
  const pad = { l: 44, r: 16, t: 16, b: 34 }
  const n = labels.length
  if (n === 0 || series.length === 0 || series.every((s) => s.values.every((v) => v === null))) return <ChartEmpty height={height} />
  const known = series.flatMap((s) => s.values.filter((v): v is number => v !== null))
  const axis = niceBounds(Math.min(0, ...known), Math.max(0, ...known), fitted)
  const x0 = fitted ? Math.min(Math.round(W * 0.35), axisRoom(axis, unit, format)) : pad.l
  const x1 = W - pad.r
  const y0 = pad.t
  const y1 = H - pad.b
  const slot = (x1 - x0) / n
  const xAt = (i: number) => x0 + slot * i + slot / 2
  const yAt = (v: number) => y1 - ((y1 - y0) * (v - axis.min)) / (axis.max - axis.min)
  const segmentsOf = (values: (number | null)[]): string[] => {
    const out: string[] = []
    let current: string[] = []
    values.forEach((v, i) => {
      if (v === null) {
        if (connectGaps) return
        if (current.length) out.push(current.join(' '))
        current = []
      } else current.push(`${xAt(i)},${yAt(v)}`)
    })
    if (current.length) out.push(current.join(' '))
    return out
  }
  // Fitted, twelve names along x at the dashboard's old width and as many in proportion at another, then no more than stand
  // apart at their length; on the dashboard, every name that has the room of its letters.
  const every = fitted ? Math.max(1, Math.ceil(n / Math.max(4, Math.round((12 * (x1 - x0)) / 660)))) : labelEvery(n, x1 - x0, longestOf(labels))
  const named = new Map((fitted ? axisNames(labels, xAt, slot, W, every) : labels.flatMap((_, i) => (i % every === 0 ? [{ i, x: xAt(i), anchor: 'middle' as const }] : []))).map((a) => [a.i, a]))
  // Points packed closer than a marker's width are a line, not a chain of rings: fitted, only the hovered one is marked —
  // and a point with no line to it (alone between gaps), which nothing else would draw.
  const marked = !fitted || slot >= 8
  const alone = (values: (number | null)[], i: number) =>
    connectGaps ? values.filter((v) => v !== null).length === 1 : (values[i - 1] ?? null) === null && (values[i + 1] ?? null) === null
  // An area's ground: the zero line.
  const ground = yAt(0)
  // The figures written at each point only while there are few points and lines, and the room to write them beside a point.
  const figured = n <= 8 && series.length <= 6 && (fitted || slot >= 44)
  return (
    <figure ref={d.figureRef} className={d.figureClass}>
      <svg viewBox={`0 0 ${W} ${H}`} height={H} className={d.svgClass} role="img" aria-labelledby={`${id}-t`} {...readout.svg}>
        <title id={`${id}-t`}>{`${series.map((s) => s.label).join(', ')} over time`}</title>
        <Grid x0={x0} x1={x1} y0={y0} y1={y1} min={axis.min} max={axis.max} steps={axis.steps} unit={unit} format={format} fontSize={text} />
        {labels.map((l, i) => {
          const name = named.get(i)
          return (
            <g key={l} {...readout.mark(i)}>
              <rect x={xAt(i) - slot / 2} y={y0} width={slot} height={y1 - y0} fill="transparent" />
              {name && (
                <text x={name.x} y={y1 + 16} textAnchor={name.anchor} fontSize={text} className="fill-muted">
                  {l}
                </text>
              )}
            </g>
          )
        })}
        {area &&
          series.map((s) =>
            segmentsOf(s.values).map((seg, i) => {
              const pts = seg.split(' ')
              const first = pts[0].split(',')[0]
              const last = pts[pts.length - 1].split(',')[0]
              return <polygon key={`${s.label}-a${i}`} points={`${first},${ground} ${seg} ${last},${ground}`} className={cn('pointer-events-none', s.className.replace(/stroke-/g, 'fill-'))} fillOpacity={series.length > 1 ? 0.1 : 0.16} stroke="none" />
            }),
          )}
        {series.map((s) =>
          segmentsOf(s.values).map((seg, i) => <polyline key={`${s.label}-${i}`} points={seg} fill="none" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" className={cn('pointer-events-none', s.className)} />),
        )}
        {series.map((s) =>
          s.values.map((v, i) => v !== null && (marked || hover === i || alone(s.values, i)) && <circle key={`${s.label}-${i}`} cx={xAt(i)} cy={yAt(v)} r={hover === i ? 5 : 3} className={cn('pointer-events-none fill-white dark:fill-slate-900', s.className)} strokeWidth={2} />),
        )}
        {figured &&
          labels.map((_, i) => {
            // The figures at one point, spread so none covers another; to the right of the point, clear of its marker.
            const marks = series.flatMap((s) => (s.values[i] !== null && s.values[i] !== undefined ? [{ key: s.label, v: s.values[i]! }] : []))
            const ys = spreadLabels(marks.map((m) => yAt(m.v) + 3), 12, y0 + 8, y1 - 2)
            return marks.map((m, k) => {
              const words = `${format(m.v)}${unit}`
              // Kept inside the drawing: the last point's figures would run past its right edge.
              const x = fitted ? xAt(i) + 8 : Math.min(xAt(i) + 8, W - 2 - words.length * CHAR_WIDTH_WIDE)
              return (
                <text key={`${m.key}-t-${i}`} x={x} y={ys[k]} fontSize={fitted ? 9 : TEXT_SMALL} fontWeight={700} className={cn('pointer-events-none fill-slate-600 dark:fill-slate-300', LABEL_HALO)} strokeWidth={3} style={{ paintOrder: 'stroke' }}>
                  {words}
                </text>
              )
            })
          })}
        {hover !== null && <line x1={xAt(hover)} x2={xAt(hover)} y1={y0} y2={y1} className="pointer-events-none stroke-slate-400" strokeDasharray="3 3" />}
      </svg>
      <div ref={d.legend} className={LEGEND}>
        {series.map((s) => (
          <span key={s.label} className="inline-flex items-center gap-1.5">
            <svg width="16" height="6" aria-hidden className="shrink-0"><line x1="0" y1="3" x2="16" y2="3" strokeWidth={3} className={s.className} /></svg>
            <span dir="auto">{s.label}</span>
            {hover !== null && (
              <span className="font-semibold tabular-nums text-slate-700 dark:text-slate-200">
                {s.values[hover] === null ? '—' : `${format(s.values[hover]!)}${unit}`}
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

/** Sixteen lines that stay apart, for comparing every machine of a group at once; the last is the catch-all. */
export const SERIES_STROKES = [
  'stroke-brand-500', 'stroke-rose-500', 'stroke-emerald-500', 'stroke-amber-500', 'stroke-violet-500', 'stroke-sky-500', 'stroke-pink-500', 'stroke-teal-500',
  'stroke-orange-500', 'stroke-lime-600', 'stroke-cyan-600', 'stroke-fuchsia-500', 'stroke-indigo-400', 'stroke-yellow-500', 'stroke-red-700', 'stroke-slate-400',
]

/** The pie's colours as strokes, in the same order, so a line and its slice share a colour. */
export const PIE_STROKES = ['stroke-brand-500', 'stroke-rose-500', 'stroke-emerald-500', 'stroke-amber-500', 'stroke-violet-500', 'stroke-sky-500', 'stroke-pink-500', 'stroke-teal-500', 'stroke-orange-500', 'stroke-slate-400']

/**
 * A tiny line for a card: a few values, no axes, the last point marked. null draws a gap. `className` sizes the
 * drawing on the page (by default it keeps its own size): `h-auto w-full max-w-[120px]` lets it narrow with a small card.
 */
export function Sparkline({ values, className = 'stroke-brand-500', width = 96, height = 28, svgClassName = 'shrink-0' }: { values: (number | null)[]; className?: string; width?: number; height?: number; svgClassName?: string }) {
  const n = values.length
  const known = values.filter((v): v is number => v !== null)
  if (n < 2 || known.length === 0) return <svg width={width} height={height} aria-hidden className={svgClassName} />
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
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden className={svgClassName}>
      {segments.map((d, i) => <polyline key={i} points={d} fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" className={className} />)}
      {last !== null && last !== undefined && <circle cx={xAt(lastIdx)} cy={yAt(last)} r={2.5} className={cn('fill-white dark:fill-slate-900', className)} strokeWidth={2} />}
    </svg>
  )
}
