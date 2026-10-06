// ============================================================================
// §15 — the period slicer: a timeline strip with two handles.
//
// The strip runs day by day across the last two years and scrolls sideways.
// The chosen period is the band between the handles; drag a handle to move
// one end, drag the band to move the whole period, or tap a preset to jump.
// Pointer events carry mouse and finger alike; the handles snap to days and a
// period cannot exceed what the API accepts.
// ============================================================================

import { useEffect, useMemo, useRef, useState } from 'react'
import type { KpiRange } from '@qc/shared/kpi'
import { addDays, fromDay, toDay, PERIOD_PRESETS, presetRange, type PeriodPreset } from './period'
import { cn } from '@/lib/utils'

/** Width of one day on the strip. */
const DAY_PX = 10
/** The strip always offers at least this much, even before there is a record. */
const MIN_SPAN_DAYS = 31
/** The most days the dashboard will answer for. */
const MAX_DAYS = 366

const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const dayIndex = (origin: string, day: string) => Math.round((fromDay(day).getTime() - fromDay(origin).getTime()) / 86_400_000)

type Drag = { kind: 'from' | 'to' | 'band'; pointerId: number; startX: number; from: number; to: number }

export function PeriodSlicer({
  value,
  preset,
  firstDay,
  onChange,
}: {
  value: KpiRange
  preset: PeriodPreset
  /** The first day anything was recorded; the strip starts there. */
  firstDay: string | null
  onChange: (range: KpiRange, preset: PeriodPreset) => void
}) {
  const today = toDay(new Date())
  // The strip runs from the first day of the record to today — never shorter
  // than a month, and never starting after the period it is showing.
  const origin = useMemo(() => {
    const floor = addDays(today, -(MIN_SPAN_DAYS - 1))
    return [firstDay, value.from, floor].filter((d): d is string => !!d).sort()[0]
  }, [today, firstDay, value.from])
  const spanDays = dayIndex(origin, today) + 1
  const scroller = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  /** While dragging, the band follows the pointer; the page is told on release. */
  const [live, setLive] = useState<{ from: number; to: number } | null>(null)

  const sel = live ?? { from: dayIndex(origin, value.from), to: dayIndex(origin, value.to) }
  const clampIndex = (i: number) => Math.max(0, Math.min(spanDays - 1, i))

  // The months along the top, one label where each begins.
  const months = useMemo(() => {
    const out: { label: string; x: number; width: number }[] = []
    let d = fromDay(origin)
    d = new Date(d.getFullYear(), d.getMonth(), 1)
    while (d <= fromDay(today)) {
      const start = Math.max(0, dayIndex(origin, toDay(d)))
      const next = new Date(d.getFullYear(), d.getMonth() + 1, 1)
      const end = Math.min(spanDays, dayIndex(origin, toDay(next)))
      out.push({ label: `${MONTH[d.getMonth()]}${d.getMonth() === 0 || out.length === 0 ? ` ${d.getFullYear()}` : ''}`, x: start * DAY_PX, width: (end - start) * DAY_PX })
      d = next
    }
    return out
  }, [origin, today])

  // Keep the chosen period in view when it changes from outside (a preset).
  useEffect(() => {
    const el = scroller.current
    if (!el || drag) return
    const left = sel.from * DAY_PX
    const right = (sel.to + 1) * DAY_PX
    const viewL = el.scrollLeft
    const viewR = viewL + el.clientWidth
    if (left < viewL || right > viewR) el.scrollTo({ left: Math.max(0, (left + right) / 2 - el.clientWidth / 2), behavior: 'smooth' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.from, value.to])

  function start(kind: Drag['kind'], e: React.PointerEvent) {
    e.preventDefault()
    e.stopPropagation()
    try {
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    } catch {
      /* a synthetic pointer has nothing to capture */
    }
    setDrag({ kind, pointerId: e.pointerId, startX: e.clientX, from: sel.from, to: sel.to })
    setLive({ from: sel.from, to: sel.to })
  }

  function move(e: React.PointerEvent) {
    if (!drag || e.pointerId !== drag.pointerId) return
    const delta = Math.round((e.clientX - drag.startX) / DAY_PX)
    let from = drag.from
    let to = drag.to
    if (drag.kind === 'from') from = clampIndex(Math.min(drag.from + delta, drag.to))
    else if (drag.kind === 'to') to = clampIndex(Math.max(drag.to + delta, drag.from))
    else {
      const len = drag.to - drag.from
      from = clampIndex(drag.from + delta)
      to = from + len
      if (to > spanDays - 1) {
        to = spanDays - 1
        from = to - len
      }
    }
    // A period longer than the API answers for is held at that length.
    if (to - from + 1 > MAX_DAYS) {
      if (drag.kind === 'from') from = to - (MAX_DAYS - 1)
      else to = from + (MAX_DAYS - 1)
    }
    setLive({ from, to })
  }

  function end(e: React.PointerEvent) {
    if (!drag || e.pointerId !== drag.pointerId) return
    const chosen = live ?? { from: drag.from, to: drag.to }
    setDrag(null)
    setLive(null)
    if (chosen.from !== dayIndex(origin, value.from) || chosen.to !== dayIndex(origin, value.to)) {
      onChange({ from: addDays(origin, chosen.from), to: addDays(origin, chosen.to) }, 'custom')
    }
  }

  function nudge(kind: 'from' | 'to', by: number) {
    const from = kind === 'from' ? clampIndex(Math.min(sel.from + by, sel.to)) : sel.from
    const to = kind === 'to' ? clampIndex(Math.max(sel.to + by, sel.from)) : sel.to
    if (to - from + 1 > MAX_DAYS) return
    onChange({ from: addDays(origin, from), to: addDays(origin, to) }, 'custom')
  }

  const fromDate = addDays(origin, sel.from)
  const toDate = addDays(origin, sel.to)
  const days = sel.to - sel.from + 1
  const pretty = (s: string) => {
    const d = fromDay(s)
    return `${d.getDate()} ${MONTH[d.getMonth()]} ${d.getFullYear()}`
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-[11px] font-bold uppercase tracking-wide text-muted">Period</span>
        <span className="text-sm font-bold tabular-nums">
          {pretty(fromDate)} – {pretty(toDate)}
          <span className="ml-2 text-xs font-semibold text-muted">{days} day{days === 1 ? '' : 's'}</span>
        </span>
        <span className="ml-auto flex flex-wrap items-center gap-1">
          {PERIOD_PRESETS.filter((p) => p.key !== 'custom').map((p) => (
            <button
              key={p.key}
              type="button"
              aria-pressed={preset === p.key}
              onClick={() => onChange(presetRange(p.key, new Date()), p.key)}
              className={cn(
                'min-h-[32px] rounded-lg px-2.5 text-xs font-semibold ring-1 transition-colors',
                preset === p.key ? 'bg-brand-600 text-white ring-brand-600' : 'text-slate-600 ring-slate-200 hover:bg-slate-50 dark:text-slate-300 dark:ring-slate-700 dark:hover:bg-slate-800',
              )}
            >
              {p.label}
            </button>
          ))}
        </span>
      </div>

      {/* The strip. It scrolls sideways; the handles and the band are dragged. */}
      <div
        ref={scroller}
        className="relative overflow-x-auto overscroll-x-contain rounded-xl bg-slate-50 ring-1 ring-slate-200 dark:bg-slate-800/60 dark:ring-slate-700"
        style={{ touchAction: 'pan-x' }}
      >
        <div className="relative h-[68px] select-none" style={{ width: spanDays * DAY_PX }} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
          {/* Months */}
          {months.map((m) => (
            <div key={m.label + m.x} className="absolute top-0 h-full border-l border-slate-200 dark:border-slate-700" style={{ left: m.x, width: m.width }}>
              <span className="absolute left-1.5 top-1 whitespace-nowrap text-[10px] font-semibold text-muted">{m.label}</span>
            </div>
          ))}
          {/* Weeks, as ticks along the bottom */}
          {Array.from({ length: Math.ceil(spanDays / 7) }, (_, i) => (
            <span key={i} className="absolute bottom-0 h-1.5 border-l border-slate-300 dark:border-slate-600" style={{ left: i * 7 * DAY_PX }} />
          ))}
          {/* Today */}
          <span className="absolute bottom-0 top-0 border-l-2 border-dashed border-rose-400" style={{ left: (spanDays - 1) * DAY_PX + DAY_PX / 2 }} aria-hidden />

          {/* The band: the chosen period. Dragging it moves the whole period. */}
          <div
            role="slider"
            aria-label="Period"
            aria-valuetext={`${pretty(fromDate)} to ${pretty(toDate)}`}
            tabIndex={-1}
            onPointerDown={(e) => start('band', e)}
            className={cn(
              'absolute bottom-2 top-5 cursor-grab rounded-md bg-brand-500/25 ring-1 ring-brand-500/50 active:cursor-grabbing dark:bg-brand-400/25',
              drag?.kind === 'band' && 'bg-brand-500/35',
            )}
            style={{ left: sel.from * DAY_PX, width: Math.max(DAY_PX, days * DAY_PX), touchAction: 'none' }}
          />
          {/* The handles */}
          {(['from', 'to'] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              aria-label={kind === 'from' ? 'Start of period' : 'End of period'}
              onPointerDown={(e) => start(kind, e)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowLeft') nudge(kind, -1)
                else if (e.key === 'ArrowRight') nudge(kind, 1)
                else return
                e.preventDefault()
              }}
              className={cn(
                'absolute bottom-1 top-4 w-4 -translate-x-1/2 cursor-ew-resize rounded-md bg-brand-600 shadow-card ring-2 ring-white transition-transform hover:scale-x-125 focus:outline-none focus:ring-brand-300 dark:ring-slate-900',
                drag?.kind === kind && 'scale-x-125',
              )}
              style={{ left: (kind === 'from' ? sel.from : sel.to + 1) * DAY_PX, touchAction: 'none' }}
            >
              <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-white/60" aria-hidden />
            </button>
          ))}
        </div>
      </div>
      <p className="text-[11px] text-muted">Drag a handle to move one end, drag the band to move the whole period, scroll the strip to go further back. Up to {MAX_DAYS} days.</p>
    </div>
  )
}
