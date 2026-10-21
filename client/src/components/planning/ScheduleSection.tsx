// ============================================================================
// §25 — Schedule: a plan's lines on a timeline, one row per machine, from now
// over the days chosen. Fridays are shaded (the day off), the moment the plan
// was worked out from is a line. Each bar is a line of an order: its colour
// says if it is running, late, waiting for material or added by a scenario.
// Choosing one opens what it is and why it is where it is; from there a
// change (rush it, move it, hold it back, give it another due day) goes into
// the plan if it is a draft the person may change, or into a new scenario
// made from it — the automatic and the published plans are never changed.
// The timeline scrolls inside its card both ways; the days stay at the top
// and the machines at the left. It zooms like a video editor's timeline: the
// − / + buttons, Ctrl (⌘) + the wheel or a trackpad's pinch over it, or two
// fingers on a tablet, stretch or squeeze the days around the point under
// the pointer, so a span of months can be read down to the hours of a day;
// zoomed in, the day header shows the hours and the tracks a line at each.
// ============================================================================

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { CalendarClock, Minus, Plus } from 'lucide-react'
import { MINUTES_PER_DAY, dayStartWall, factoryDayOfWall, addDays, weekday, type PlanDetail, type PlanEventType, type PlanOperation } from '@qc/shared/planning'
import { Badge, Drawer, EmptyState } from '@/components/ui'
import { FilterSelect, Segmented } from '@/components/ui/PageShell'
import { cn } from '@/lib/utils'
import { usePersistedState } from '@/lib/usePersistedState'
import { usePlan } from '@/services/planning'
import { ErrorNote, Loading, PartFooter, PartFrame, PlanPicker, Scroller, SearchBox, StateLegend, usePreferredPlanId } from './common'
import { DURATION_NAME, FLAG_NAME, STATE_BAR, chosenFactory, dayLabel, factoryKey, factoryName, hoursLabel, opState, processName, qtyLabel, tonnes, wallLabel } from './format'
import { EventForm, describeEvent, useAddEvent } from './events'

// Pixels a day: wide enough that a bar can be read and a day told from the next; a span wider than the card scrolls
// sideways inside it rather than squeezing the days into the window.
const RANGES = [
  { value: '7', label: '7 days', px: 160 },
  { value: '14', label: '2 weeks', px: 110 },
  { value: '30', label: 'Month', px: 64 },
  { value: '90', label: '3 months', px: 28 },
] as const

const LABEL_W = 200
const ROW_H = 44

/** The zoom: the span's pixels a day, times this. Held so a day is never under 8 px nor over 40 px an hour. */
const ZOOM_KEY = 'qc-planning:zoom'
const MIN_DAY_PX = 8
const MAX_DAY_PX = 24 * 40
/** One press of − or +. */
const ZOOM_STEP = Math.SQRT2

/** The least and the most a span may be zoomed. */
export const zoomBounds = (basePx: number): { min: number; max: number } => ({ min: MIN_DAY_PX / basePx, max: MAX_DAY_PX / basePx })

export function clampZoom(zoom: number, basePx: number): number {
  const { min, max } = zoomBounds(basePx)
  return Math.min(max, Math.max(min, Number.isFinite(zoom) && zoom > 0 ? zoom : 1))
}

/** The hour ticks a day gets at this width: as many as still leave a label ("06:00") 40 px of room; one means none. */
export function ticksPerDay(dayPx: number): number {
  for (const n of [24, 12, 8, 6, 4, 3, 2]) if (dayPx / n >= 40) return n
  return 1
}

/** Where a bar sits on the track: px from its left edge, and its width (at least a sliver, to be seen and chosen). */
export function barGeometry(start: number, end: number, from: number, dayPx: number): { left: number; width: number } {
  const left = ((start - from) / MINUTES_PER_DAY) * dayPx
  const width = Math.max(4, ((end - start) / MINUTES_PER_DAY) * dayPx)
  return { left, width }
}

function OpDetail({ op, detail, onClose }: { op: PlanOperation; detail: PlanDetail; onClose: () => void }) {
  const machines = useMemo(() => new Map(detail.machines.map((m) => [m.key, m])), [detail])
  const add = useAddEvent(detail)
  const [quick, setQuick] = useState<PlanEventType | null>(null)
  const st = opState(op)
  return (
    <Drawer open onClose={onClose} title={`${op.orderNumber} · ${op.item}`} subtitle={`Order ID ${op.lineKey} · ${op.customer || '—'}`} icon={<CalendarClock className="h-5 w-5" />}>
      <div className="space-y-5 text-sm">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
          <div>
            <dt className="text-muted">Machine</dt>
            <dd className="font-semibold">{machines.get(op.machineKey)?.name ?? op.machineKey}</dd>
          </div>
          <div>
            <dt className="text-muted">Place in its queue</dt>
            <dd className="font-semibold">{op.seq}</dd>
          </div>
          <div>
            <dt className="text-muted">Starts</dt>
            <dd className="font-semibold">{wallLabel(op.start)}</dd>
          </div>
          <div>
            <dt className="text-muted">Finishes</dt>
            <dd className="font-semibold">{wallLabel(op.end)}</dd>
          </div>
          <div>
            <dt className="text-muted">Due</dt>
            <dd className={cn('font-semibold', op.lateDays > 0 && 'text-danger-700 dark:text-danger-400')}>
              {op.dueDate ? dayLabel(op.dueDate, true) : 'No due day'}
              {op.lateDays > 0 ? `, ${op.lateDays} days late` : ''}
            </dd>
          </div>
          <div>
            <dt className="text-muted">Left to make</dt>
            <dd className="font-semibold">
              {qtyLabel(op.qty)} pcs
              {op.weightKg ? `, ${tonnes(op.weightKg)}` : ''}
            </dd>
          </div>
          <div className="col-span-2">
            <dt className="text-muted">Machine hours</dt>
            <dd className="font-semibold">
              {hoursLabel(op.hours)} <span className="font-normal text-muted">from {DURATION_NAME[op.durationSource]}</span>
            </dd>
          </div>
          {op.dependsOn.length > 0 && (
            <div className="col-span-2">
              <dt className="text-muted">Waits for</dt>
              <dd className="font-semibold">{op.dependsOn.join(', ')}</dd>
            </div>
          )}
        </dl>
        {(op.flags.length > 0 || st !== 'planned') && (
          <ul className="flex flex-wrap gap-1.5">
            {op.flags.map((f) => (
              <li key={f}>
                <Badge
                  tone={
                    f === 'running'
                      ? 'green'
                      : f === 'waits-material' || f === 'assumed-hours'
                        ? 'amber'
                        : f === 'hypothetical'
                          ? 'violet'
                          : f === 'no-capacity' || f === 'beyond-horizon'
                            ? 'red'
                            : 'neutral'
                  }
                >
                  {FLAG_NAME[f]}
                </Badge>
              </li>
            ))}
          </ul>
        )}
        {add.mayEdit && (
          <section className="rounded-xl bg-slate-50 p-3 ring-1 ring-inset ring-slate-200 dark:bg-slate-800/50 dark:ring-slate-700">
            <h3 className="font-bold">What if</h3>
            <p className="mb-3 text-muted">
              {add.intoScenario ? 'A change here makes a new scenario from this plan; this plan stays as it is.' : 'A change here goes into this draft and works it out again.'}
            </p>
            {quick === null ? (
              <div className="flex flex-wrap gap-2">
                {(
                  [
                    ['priority', 'Rush it'],
                    ['move', 'Move it'],
                    ['not-before', 'Start it later'],
                    ['due', 'Another due day'],
                    ['exclude', 'Leave it out'],
                  ] as const
                ).map(([t, label]) => (
                  <button key={t} type="button" onClick={() => setQuick(t)} className="btn-secondary min-h-[40px] px-3">
                    {label}
                  </button>
                ))}
              </div>
            ) : (
              <EventForm
                detail={detail}
                initial={{ type: quick, ref: op.lineKey }}
                pending={add.pending}
                onAdd={async (e) => {
                  await add.add(e, `What if: ${describeEvent(e, machines)}`)
                  onClose()
                }}
              />
            )}
            {add.error && <ErrorNote error={add.error} />}
          </section>
        )}
      </div>
    </Drawer>
  )
}

/** The timeline itself, sized to its days; it lives in a scroller, with its day header pinned at the top and the machines at the left. */
export function Timeline({ detail, days, dayPx, filter, onOpen }: { detail: PlanDetail; days: number; dayPx: number; filter: (op: PlanOperation) => boolean; onOpen: (op: PlanOperation) => void }) {
  const firstDay = factoryDayOfWall(detail.now)
  const from = dayStartWall(firstDay)
  const to = from + days * MINUTES_PER_DAY
  const width = days * dayPx
  const machines = useMemo(() => new Map(detail.machines.map((m) => [m.key, m])), [detail])
  const rows = useMemo(() => {
    const by = new Map<string, PlanOperation[]>()
    for (const op of detail.operations) {
      if (op.start === null || op.end === null || op.end <= from || op.start >= to || !filter(op)) continue
      const l = by.get(op.machineKey)
      if (l) l.push(op)
      else by.set(op.machineKey, [op])
    }
    return [...by.entries()]
      .map(([key, ops]) => ({ key, machine: machines.get(key), ops }))
      .sort((a, b) => (a.machine?.factory ?? '').localeCompare(b.machine?.factory ?? '') || (a.machine?.name ?? a.key).localeCompare(b.machine?.name ?? b.key, undefined, { numeric: true }))
  }, [detail, from, to, filter, machines])
  const dayList = Array.from({ length: days }, (_, i) => addDays(firstDay, i))
  // A day's label ("Sat 24 Oct") needs some 70 px: every day while that fits, every other day at a month's scale, else each Saturday.
  const labelEvery = dayPx >= 72 ? 1 : dayPx >= 40 ? 2 : 7
  // Zoomed in, a second line of the header names the hours, and the tracks draw a line at each.
  const ticks = ticksPerDay(dayPx)
  const headH = ticks > 1 ? 52 : 36
  const tickPx = dayPx / ticks
  const trackGrid = {
    backgroundImage: ticks > 1 ? 'linear-gradient(to right, var(--plan-grid) 1px, transparent 1px), linear-gradient(to right, var(--plan-grid-fine) 1px, transparent 1px)' : 'linear-gradient(to right, var(--plan-grid) 1px, transparent 1px)',
    backgroundSize: ticks > 1 ? `${dayPx}px 100%, ${tickPx}px 100%` : `${dayPx}px 100%`,
  }
  if (rows.length === 0)
    return (
      <div className="p-4">
        <EmptyState icon={<CalendarClock className="h-10 w-10" />} title="Nothing planned in these days" hint="Try a longer span, another factory, or another plan." />
      </div>
    )
  const nowLeft = ((detail.now - from) / MINUTES_PER_DAY) * dayPx
  return (
    <div style={{ width: LABEL_W + width }} className="relative">
      {/* Days */}
      <div className="sticky top-0 z-20 flex border-b border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
        <div style={{ width: LABEL_W }} className="sticky left-0 z-30 shrink-0 border-r border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-muted dark:border-slate-700 dark:bg-slate-900">
          Machine
        </div>
        <div className="plan-track flex" style={{ width, height: headH, ...trackGrid }}>
          {dayList.map((d, i) => (
            <div key={d} className="relative shrink-0" style={{ width: dayPx }}>
              {/* The day's name keeps to the right of the machines while any of its day is in view (a wide, zoomed
                  day scrolls under it), so the day under the bars is always named. */}
              {i % labelEvery === 0 && (
                <span className="sticky top-0 inline-block max-w-full truncate whitespace-nowrap px-1 pt-2 text-[11px] font-semibold text-muted" style={{ left: LABEL_W }}>
                  {dayLabel(d)}
                </span>
              )}
              {ticks > 1 &&
                Array.from({ length: ticks - 1 }, (_, k) => k + 1).map((k) => (
                  <span key={k} className="absolute bottom-0.5 whitespace-nowrap px-1 text-[10px] tabular-nums text-muted" style={{ left: k * tickPx }}>
                    {String(Math.round((k * 24) / ticks)).padStart(2, '0')}:00
                  </span>
                ))}
            </div>
          ))}
        </div>
      </div>
      {rows.map((r) => (
        <div key={r.key} className="flex border-b border-slate-100 last:border-b-0 dark:border-slate-800" style={{ height: ROW_H }}>
          <div style={{ width: LABEL_W }} className="sticky left-0 z-10 flex shrink-0 flex-col justify-center border-r border-slate-200 bg-white px-3 dark:border-slate-700 dark:bg-slate-900">
            <span className="truncate text-13 font-semibold">{r.machine?.name ?? `Machine ${r.key}`}</span>
            <span className="truncate text-[11px] text-muted">
              {r.machine?.factory || '—'} · {processName(r.machine?.process)}
            </span>
          </div>
          <div className="plan-track relative" style={{ width, ...trackGrid }}>
            {dayList.map((d, i) => (weekday(d) === 5 ? <div key={d} aria-hidden className="absolute inset-y-0 bg-slate-100 dark:bg-slate-800/70" style={{ left: i * dayPx, width: dayPx }} /> : null))}
            {r.ops.map((op) => {
              const g = barGeometry(Math.max(op.start!, from), Math.min(op.end!, to), from, dayPx)
              const st = opState(op)
              return (
                <button
                  key={op.lineId}
                  type="button"
                  onClick={() => onOpen(op)}
                  data-tip={`${op.orderNumber} · ${op.item} — ${wallLabel(op.start)} to ${wallLabel(op.end)}${op.lateDays > 0 ? `, ${op.lateDays} d late` : ''}`}
                  aria-label={`${op.orderNumber}, ${op.item}, on ${r.machine?.name ?? r.key}, ${wallLabel(op.start)} to ${wallLabel(op.end)}${op.lateDays > 0 ? `, ${op.lateDays} days late` : ''}`}
                  className={cn(
                    'absolute top-1.5 flex h-[32px] items-center overflow-hidden rounded-md px-1.5 text-left text-[11px] font-semibold leading-tight ring-1 ring-inset focus:outline-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-brand-500',
                    STATE_BAR[st],
                  )}
                  style={{ left: g.left, width: g.width }}
                >
                  {g.width > 48 && (
                    <span className="truncate">
                      {op.orderNumber}
                      {g.width > 200 && <span className="font-normal opacity-90"> · {op.item}</span>}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      ))}
      {nowLeft >= 0 && nowLeft <= width && <div aria-hidden className="pointer-events-none absolute bottom-0 z-10 w-0.5 bg-rose-500" style={{ left: LABEL_W + nowLeft, top: headH }} />}
    </div>
  )
}

export function ScheduleSection() {
  const [params, setParams] = useSearchParams()
  const preferred = usePreferredPlanId()
  const planId = params.get('plan') ?? preferred
  const machineFilter = params.get('machine') ?? ''
  const [range, setRange] = usePersistedState<(typeof RANGES)[number]['value']>('qc-planning:range', '14')
  const [zoom, setZoom] = usePersistedState<number>(ZOOM_KEY, 1)
  const [q, setQ] = useState('')
  const [factory, setFactory] = usePersistedState<string>('qc-planning:factory', '')
  const [open, setOpen] = useState<PlanOperation | null>(null)
  const { data, error, isLoading, refetch } = usePlan(planId)
  const r = RANGES.find((x) => x.value === range) ?? RANGES[1]
  const dayPx = r.px * clampZoom(zoom, r.px)
  const scroller = useRef<HTMLDivElement>(null)
  // The point to hold still while the days change width: how many days in it lies, and where in the box it shows.
  const anchor = useRef<{ day: number; px: number } | null>(null)
  const zoomBy = (factor: number, clientX?: number) => {
    const el = scroller.current
    if (el) {
      const px = clientX === undefined ? Math.min(el.clientWidth, LABEL_W + (el.clientWidth - LABEL_W) / 2) : clientX - el.getBoundingClientRect().left
      anchor.current = { day: (el.scrollLeft + px - LABEL_W) / dayPx, px }
    }
    setZoom(clampZoom(clampZoom(zoom, r.px) * factor, r.px))
  }
  const zoomRef = useRef(zoomBy)
  zoomRef.current = zoomBy
  useLayoutEffect(() => {
    const el = scroller.current
    const a = anchor.current
    if (!el || !a) return
    anchor.current = null
    el.scrollLeft = Math.max(0, LABEL_W + a.day * dayPx - a.px)
  }, [dayPx])
  // Ctrl (⌘) + the wheel, which is also what a trackpad's pinch sends: not React's onWheel, which may not prevent the
  // browser zooming the page with it.
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      zoomRef.current(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025)), e.clientX)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [data === undefined])
  // Two fingers on the timeline: the distance between them stretches or squeezes the days around their midpoint.
  const fingers = useRef(new Map<number, { x: number; y: number }>())
  const pinch = useRef<number | null>(null)
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'touch') return
    fingers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    pinch.current = null
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const f = fingers.current
    if (e.pointerType !== 'touch' || !f.has(e.pointerId)) return
    f.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (f.size !== 2) return
    const [a, b] = [...f.values()]
    const d = Math.hypot(a.x - b.x, a.y - b.y)
    if (pinch.current !== null && d > 0 && Math.abs(d / pinch.current - 1) > 0.03) {
      zoomBy(d / pinch.current, (a.x + b.x) / 2)
      pinch.current = d
    } else if (pinch.current === null) pinch.current = d
  }
  const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    fingers.current.delete(e.pointerId)
    pinch.current = null
  }
  const factories = useMemo(() => [...new Set((data?.machines ?? []).map((m) => m.factory))].sort(), [data])
  // The remembered factory (shared with the map and the load) counts only while it is one of this plan's.
  const chosen = chosenFactory(factory, factories)
  const machineOf = useMemo(() => new Map((data?.machines ?? []).map((m) => [m.key, m])), [data])
  const needle = q.trim().toLowerCase()
  const filter = useMemo(
    () => (op: PlanOperation) =>
      (!machineFilter || op.machineKey === machineFilter) &&
      (chosen === null || machineOf.get(op.machineKey)?.factory === chosen) &&
      (!needle || op.orderNumber.toLowerCase().includes(needle) || op.item.toLowerCase().includes(needle) || op.customer.toLowerCase().includes(needle) || op.lineKey.toLowerCase().includes(needle)),
    [machineFilter, chosen, needle, machineOf],
  )
  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params)
    if (v) next.set(k, v)
    else next.delete(k)
    setParams(next, { replace: true })
  }
  const unplaced = data?.operations.filter((o) => o.start === null).length ?? 0

  return (
    <PartFrame
      toolbar={
        <>
          <PlanPicker value={planId} onChange={(id) => setParam('plan', id)} />
          <Segmented label="Span" value={r.value} onChange={setRange} options={RANGES.map((x) => ({ value: x.value, label: x.label }))} />
          <ZoomControl zoom={clampZoom(zoom, r.px)} {...zoomBounds(r.px)} onStep={(f) => zoomBy(f)} onReset={() => zoomBy(1 / clampZoom(zoom, r.px))} />
          {factories.length > 1 && (
            <FilterSelect label="Factory" value={chosen === null ? '' : factoryKey(chosen)} onChange={setFactory}>
              <option value="">Every factory</option>
              {factories.map((f) => (
                <option key={factoryKey(f)} value={factoryKey(f)}>
                  {factoryName(f)}
                </option>
              ))}
            </FilterSelect>
          )}
          {machineFilter && (
            <button type="button" onClick={() => setParam('machine', '')} className="btn-secondary h-10 min-h-0 px-3 text-sm" data-tip="Every machine again">
              {machineOf.get(machineFilter)?.name ?? machineFilter} ✕
            </button>
          )}
          <SearchBox value={q} onChange={setQ} placeholder="Order, item, customer" label="Find an order, item or customer" />
        </>
      }
    >
      {isLoading ? (
        <Loading />
      ) : error || !data ? (
        <div className="p-4">
          <ErrorNote error={error} retry={() => void refetch()} />
        </div>
      ) : (
        <>
          <Scroller ref={scroller} className="touch-pan-x touch-pan-y" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}>
            <Timeline detail={data} days={Number(r.value)} dayPx={dayPx} filter={filter} onOpen={setOpen} />
          </Scroller>
          <PartFooter>
            <StateLegend states={['running', 'planned', 'late', 'material', 'hypothetical']} />
            <span>Shaded: Friday. The red line: when the plan was worked out from ({wallLabel(data.now)}). Choose a bar for what it is, and to try a change. Zoom with − / +, Ctrl + the wheel, a pinch.</span>
            {unplaced > 0 && (
              <Link to={`/planning/late?plan=${encodeURIComponent(planId)}`} className="font-semibold text-danger-700 underline-offset-4 hover:underline dark:text-danger-400">
                {unplaced} lines could not be placed: their machine has no working time in the horizon
              </Link>
            )}
            {data.warnings.length > 0 && (
              <span className="text-warning-800 dark:text-warning-400" title={data.warnings.join('\n')}>
                {data.warnings[0]}
                {data.warnings.length > 1 ? ` (+${data.warnings.length - 1} more)` : ''}
              </span>
            )}
          </PartFooter>
          {open && <OpDetail op={open} detail={data} onClose={() => setOpen(null)} />}
        </>
      )}
    </PartFrame>
  )
}

/** The timeline's zoom: −, the scale (a press puts it back to 1×), +. */
function ZoomControl({ zoom, min, max, onStep, onReset }: { zoom: number; min: number; max: number; onStep: (factor: number) => void; onReset: () => void }) {
  const btn = 'grid h-9 w-9 shrink-0 place-items-center text-muted transition-colors hover:text-slate-800 disabled:opacity-40 disabled:hover:text-muted dark:hover:text-white touch:h-11 touch:w-11'
  return (
    <div role="group" aria-label="Zoom" className="inline-flex h-9 items-center rounded-lg bg-slate-200/70 p-0.5 dark:bg-slate-800 touch:h-11">
      <button type="button" onClick={() => onStep(1 / ZOOM_STEP)} disabled={zoom <= min + 1e-9} aria-label="Zoom out" data-tip="Zoom out (Ctrl + wheel)" className={btn}>
        <Minus className="h-4 w-4" />
      </button>
      <button type="button" onClick={onReset} aria-label={`Zoom ${Math.round(zoom * 100)}%, back to 100%`} data-tip="Back to 100%" className="h-8 min-w-[3.5rem] rounded-md bg-white px-2 text-13 font-semibold tabular-nums text-slate-700 shadow-sm dark:bg-slate-900 dark:text-slate-200 touch:h-10">
        {Math.round(zoom * 100)}%
      </button>
      <button type="button" onClick={() => onStep(ZOOM_STEP)} disabled={zoom >= max - 1e-9} aria-label="Zoom in" data-tip="Zoom in (Ctrl + wheel)" className={btn}>
        <Plus className="h-4 w-4" />
      </button>
    </div>
  )
}
