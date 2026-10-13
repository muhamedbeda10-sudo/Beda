// ============================================================================
// §15 — the period slicer: a timeline strip with two handles.
//
// One row: the period as two dates, the presets, and a button that shows the
// timeline — a slim strip, day by day from the first record to today, as
// wide as the screen allows (it scrolls sideways only when a day would be
// narrower than 2 px). On it the chosen period is the band between the
// handles; drag a handle to move one end, drag the band — or, with a finger,
// the grip in its middle — to move the whole period. A finger swiping the
// band itself scrolls the strip. Pointer events carry mouse and finger alike;
// the handles snap to days and a period cannot exceed what the API accepts.
// On a phone the row wraps: the dates on a line of their own, the presets on
// two lines rather than a strip scrolled out of sight.
// ============================================================================

import { useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react'
import { CalendarRange, ChevronDown, GripVertical } from 'lucide-react'
import type { KpiRange } from '@qc/shared/kpi'
import { addDays, fromDay, toDay, PERIOD_PRESETS, presetRange, type PeriodPreset } from './period'
import { cn } from '@/lib/utils'
import { usePersistedState } from '@/lib/usePersistedState'
import { useCoarsePointer } from '@/lib/media'

/** Width of one day on the strip: what fits the strip's width, within these bounds. */
const MAX_DAY_PX = 10
const MIN_DAY_PX = 2
/** Room at either end of the strip, so a handle at the first day or at today is not cut by the strip's edge. */
const EDGE = 16
/** The band takes a grip in its middle (to move the period with a finger) while it is at least this wide. */
const GRIP_MIN_BAND = 48
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
  leading,
  trailing,
}: {
  value: KpiRange
  preset: PeriodPreset
  /** The first day anything was recorded; the strip starts there. */
  firstDay: string | null
  onChange: (range: KpiRange, preset: PeriodPreset) => void
  /** Controls at the start of the row (the page's view switch). */
  leading?: ReactNode
  /** Controls at the end of the row (the page's actions). */
  trailing?: ReactNode
}) {
  const [timelineOpen, setTimelineOpen] = usePersistedState<boolean>('qc-dash:timeline-open', false)
  // Under a finger the hint is printed under the strip; a tooltip would only pop up over the toolbar as it opens.
  const coarse = useCoarsePointer()
  const today = toDay(new Date())
  // The strip runs from the first day of the record to today, never shorter
  // than a month. A period that begins before any record (This year, the
  // record starting in September) does not stretch it back: its start handle
  // waits at the strip's start. Only a period wholly before the record moves
  // the strip's start back to it.
  const origin = useMemo(() => {
    const floor = addDays(today, -(MIN_SPAN_DAYS - 1))
    const start = firstDay && value.to >= firstDay ? firstDay : value.from
    return [start, floor].sort()[0]
  }, [today, firstDay, value.from, value.to])
  const spanDays = dayIndex(origin, today) + 1
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
  const [stripWidth, setStripWidth] = useState(0)
  useLayoutEffect(() => {
    if (!scroller) return
    const read = () => setStripWidth(scroller.clientWidth)
    read()
    if (typeof ResizeObserver === 'undefined') return
    const watch = new ResizeObserver(read)
    watch.observe(scroller)
    return () => watch.disconnect()
  }, [scroller])
  // The whole record on screen when a day can be 2 px or more; at most 10 px a day.
  const dayPx = stripWidth > 0 ? Math.max(MIN_DAY_PX, Math.min(MAX_DAY_PX, (stripWidth - 2 * EDGE - 1) / spanDays)) : MAX_DAY_PX
  const xOf = (i: number) => EDGE + i * dayPx
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
      out.push({ label: `${MONTH[d.getMonth()]}${d.getMonth() === 0 || out.length === 0 ? ` ${d.getFullYear()}` : ''}`, x: EDGE + start * dayPx, width: (end - start) * dayPx })
      d = next
    }
    return out
  }, [origin, today, dayPx, spanDays])

  // Keep the chosen period in view when it changes from outside (a preset).
  useEffect(() => {
    const el = scroller
    if (!el || drag) return
    const left = xOf(Math.max(0, sel.from))
    const right = xOf(sel.to + 1)
    const viewL = el.scrollLeft
    const viewR = viewL + el.clientWidth
    if (left < viewL || right > viewR) el.scrollTo({ left: Math.max(0, (left + right) / 2 - el.clientWidth / 2), behavior: 'smooth' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.from, value.to, timelineOpen, scroller, dayPx])

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
    const delta = Math.round((e.clientX - drag.startX) / dayPx)
    // Not a day yet: the period stays as it was (one that began before the strip keeps its start).
    if (delta === 0) {
      setLive({ from: drag.from, to: drag.to })
      return
    }
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
  const pretty = (d: string) => {
    const x = fromDay(d)
    return `${MONTH[x.getMonth()]} ${x.getDate()}, ${x.getFullYear()}`
  }

  /** A date typed in one end: the other end follows when the two would cross or the period would run past what is answered. */
  function typed(kind: 'from' | 'to', day: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day > today) return
    let from = kind === 'from' ? day : value.from
    let to = kind === 'to' ? day : value.to
    if (from > to) {
      if (kind === 'from') to = from
      else from = to
    }
    if (dayIndex(from, to) + 1 > MAX_DAYS) {
      if (kind === 'from') to = addDays(from, MAX_DAYS - 1)
      else from = addDays(to, -(MAX_DAYS - 1))
    }
    if (to > today) to = today
    if (from !== value.from || to !== value.to) onChange({ from, to }, 'custom')
  }

  // Drawn from the strip's first day: a period that began before it starts at its start.
  const shownFrom = Math.max(0, sel.from)

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {leading}
        {/* The two dates share a line on a phone, the count of days under them below 400 px; from a tablet up the count stays on their line. */}
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5 sm:shrink-0 sm:flex-nowrap" role="group" aria-label="Period">
          <input type="date" aria-label="First day of the period" value={value.from} max={today} onChange={(e) => typed('from', e.target.value)} className="input h-9 min-w-0 max-w-[9.25rem] flex-1 basis-[8.5rem] px-2 py-0 text-13 tabular-nums sm:w-[9.25rem] sm:flex-none touch:h-11" />
          <span className="text-muted" aria-hidden>
            –
          </span>
          <input type="date" aria-label="Last day of the period" value={value.to} max={today} onChange={(e) => typed('to', e.target.value)} className="input h-9 min-w-0 max-w-[9.25rem] flex-1 basis-[8.5rem] px-2 py-0 text-13 tabular-nums sm:w-[9.25rem] sm:flex-none touch:h-11" />
          <span className="basis-full whitespace-nowrap text-xs font-semibold tabular-nums text-muted min-[400px]:basis-auto">
            {days} day{days === 1 ? '' : 's'}
          </span>
        </div>
        <div className="flex max-w-full flex-wrap items-center gap-0.5 rounded-lg bg-slate-200/70 p-0.5 dark:bg-slate-800 sm:flex-nowrap sm:overflow-x-auto" role="group" aria-label="Period presets">
          {PERIOD_PRESETS.filter((p) => p.key !== 'custom').map((p) => (
            <button
              key={p.key}
              type="button"
              aria-pressed={preset === p.key}
              onClick={() => onChange(presetRange(p.key, new Date()), p.key)}
              className={cn(
                'h-8 shrink-0 whitespace-nowrap rounded-md px-2.5 text-xs font-semibold transition-colors touch:h-10',
                preset === p.key ? 'bg-white text-brand-700 shadow-sm dark:bg-slate-900 dark:text-brand-300' : 'text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setTimelineOpen((o) => !o)}
          aria-expanded={timelineOpen}
          aria-label={timelineOpen ? 'Hide the timeline' : 'Show the timeline'}
          data-tip={timelineOpen ? 'Hide the timeline' : 'Drag the period on a timeline'}
          className={cn('inline-flex h-9 items-center gap-1 rounded-lg px-2 text-muted transition-colors hover:bg-slate-200/70 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200 touch:h-11 touch:px-3', timelineOpen && 'bg-slate-200/70 text-slate-700 dark:bg-slate-800 dark:text-slate-200')}
        >
          <CalendarRange className="h-4 w-4" />
          <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', timelineOpen && 'rotate-180')} />
        </button>
        {trailing && <div className="ml-auto flex flex-wrap items-center gap-2">{trailing}</div>}
      </div>

      {/* The strip, 40 px high (56 under a finger). It fits the screen, scrolling sideways only for a long record; the handles and the band are dragged. */}
      {timelineOpen && (
        <>
          <div
            ref={setScroller}
            className="relative overflow-x-auto overscroll-x-contain rounded-lg bg-white ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-700"
            style={{ touchAction: 'pan-x' }}
            data-tip={coarse ? undefined : 'Drag a handle to move one end, drag the band to move the whole period. Up to 366 days.'}
          >
            <div className="relative h-10 select-none touch:h-14" style={{ width: spanDays * dayPx + 2 * EDGE }} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
              {/* Months */}
              {months.map((m) => (
                <div key={m.label + m.x} className="absolute top-0 h-full border-l border-slate-200 dark:border-slate-700" style={{ left: m.x, width: m.width }}>
                  <span className="absolute left-1 top-0.5 whitespace-nowrap text-[10px] font-semibold leading-none text-muted">{m.label}</span>
                </div>
              ))}
              {/* Weeks, as ticks along the bottom */}
              {Array.from({ length: Math.ceil(spanDays / 7) }, (_, i) => (
                <span key={i} className="absolute bottom-0 h-1 border-l border-slate-300 dark:border-slate-600" style={{ left: xOf(i * 7) }} />
              ))}
              {/* Today */}
              <span className="absolute bottom-0 top-0 border-l-2 border-dashed border-rose-400" style={{ left: xOf(spanDays - 1) + dayPx / 2 }} aria-hidden />

              {/* The band: the chosen period. A mouse or a pen drags it to move the whole period; a finger on it scrolls the strip. */}
              <div
                role="slider"
                aria-label="Period"
                aria-valuetext={`${pretty(fromDate)} to ${pretty(toDate)}`}
                tabIndex={-1}
                onPointerDown={(e) => {
                  if (e.pointerType !== 'touch') start('band', e)
                }}
                className={cn('absolute bottom-1.5 top-3.5 rounded bg-brand-500/25 ring-1 ring-brand-500/50 dark:bg-brand-400/25 mouse:cursor-grab mouse:active:cursor-grabbing touch:bottom-2 touch:top-4', drag?.kind === 'band' && 'bg-brand-500/35')}
                style={{ left: xOf(shownFrom), width: Math.max(dayPx, (sel.to + 1 - shownFrom) * dayPx), touchAction: 'pan-x' }}
              >
                {/* The grip that moves the whole period, for a finger (a mouse may take the band anywhere). */}
                {(sel.to + 1 - shownFrom) * dayPx >= GRIP_MIN_BAND && (
                  <span
                    aria-hidden
                    onPointerDown={(e) => start('band', e)}
                    className="absolute left-1/2 top-1/2 grid h-full min-h-[20px] w-7 -translate-x-1/2 -translate-y-1/2 cursor-grab place-items-center rounded-md text-brand-700 active:cursor-grabbing dark:text-brand-200 touch:w-10 touch:before:absolute touch:before:-inset-y-2 touch:before:inset-x-0 touch:before:content-['']"
                    style={{ touchAction: 'none' }}
                  >
                    <GripVertical className="h-3.5 w-3.5" />
                  </span>
                )}
              </div>
              {/* The handles: 14 px drawn, a wider reach for a finger on the side of the band. */}
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
                    'absolute bottom-0.5 top-3 w-3.5 -translate-x-1/2 cursor-ew-resize rounded bg-brand-600 shadow-card ring-2 ring-white transition-transform hover:scale-x-125 focus:outline-none focus:ring-brand-300 dark:ring-slate-900',
                    "touch:top-3.5 touch:w-4 touch:before:absolute touch:before:-top-2 touch:before:bottom-0 touch:before:content-['']",
                    kind === 'from' ? 'touch:before:-left-2 touch:before:-right-5' : 'touch:before:-left-5 touch:before:-right-2',
                    drag?.kind === kind && 'scale-x-125',
                  )}
                  style={{ left: xOf(kind === 'from' ? shownFrom : sel.to + 1), touchAction: 'none' }}
                >
                  {/* A grip: two lines down its middle. */}
                  <span className="absolute inset-y-1.5 left-1/2 w-px -translate-x-[2px] bg-white/70" aria-hidden />
                  <span className="absolute inset-y-1.5 left-1/2 w-px translate-x-px bg-white/70" aria-hidden />
                </button>
              ))}
            </div>
          </div>
          {/* A finger gets no tooltip: the how-to, said under the strip. */}
          <p className="hidden text-xs text-muted touch:block">Drag a handle to move one end, or the grip in the band to move the whole period; swipe the strip to scroll it. Up to 366 days.</p>
        </>
      )}
    </div>
  )
}
