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
// and the machines at the left.
// ============================================================================

import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { CalendarClock } from 'lucide-react'
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
        <div className="relative h-9" style={{ width }}>
          {dayList.map((d, i) =>
            i % labelEvery === 0 ? (
              <span key={d} className="absolute top-0 whitespace-nowrap px-1 pt-2 text-[11px] font-semibold text-muted" style={{ left: i * dayPx }}>
                {dayLabel(d)}
              </span>
            ) : null,
          )}
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
          <div className="relative" style={{ width }}>
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
                  {g.width > 48 && <span className="truncate">{op.orderNumber}</span>}
                </button>
              )
            })}
          </div>
        </div>
      ))}
      {nowLeft >= 0 && nowLeft <= width && <div aria-hidden className="pointer-events-none absolute bottom-0 top-9 z-10 w-0.5 bg-rose-500" style={{ left: LABEL_W + nowLeft }} />}
    </div>
  )
}

export function ScheduleSection() {
  const [params, setParams] = useSearchParams()
  const preferred = usePreferredPlanId()
  const planId = params.get('plan') ?? preferred
  const machineFilter = params.get('machine') ?? ''
  const [range, setRange] = usePersistedState<(typeof RANGES)[number]['value']>('qc-planning:range', '14')
  const [q, setQ] = useState('')
  const [factory, setFactory] = usePersistedState<string>('qc-planning:factory', '')
  const [open, setOpen] = useState<PlanOperation | null>(null)
  const { data, error, isLoading, refetch } = usePlan(planId)
  const r = RANGES.find((x) => x.value === range) ?? RANGES[1]
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
          <Scroller>
            <Timeline detail={data} days={Number(r.value)} dayPx={r.px} filter={filter} onOpen={setOpen} />
          </Scroller>
          <PartFooter>
            <StateLegend states={['running', 'planned', 'late', 'material', 'hypothetical']} />
            <span>Shaded: Friday. The red line: when the plan was worked out from ({wallLabel(data.now)}). Choose a bar for what it is, and to try a change.</span>
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
