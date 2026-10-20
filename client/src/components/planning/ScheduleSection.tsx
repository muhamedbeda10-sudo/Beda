// ============================================================================
// §25 — Schedule: a plan's lines on a timeline, one row per machine, from now
// over the days chosen. Fridays are shaded (the day off), the moment the plan
// was worked out from is a line. Each bar is a line of an order: its colour
// says if it is running, late, waiting for material or added by a scenario.
// Choosing one opens what it is and why it is where it is; from there a
// change (rush it, move it, hold it back, give it another due day) goes into
// the plan if it is a draft the person may change, or into a new scenario
// made from it — the automatic and the published plans are never changed.
// ============================================================================

import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { CalendarClock, Search } from 'lucide-react'
import { MINUTES_PER_DAY, dayStartWall, factoryDayOfWall, addDays, weekday, type PlanDetail, type PlanEventType, type PlanOperation } from '@qc/shared/planning'
import { Badge, Drawer, EmptyState, Input, Select } from '@/components/ui'
import { Segmented } from '@/components/ui/PageShell'
import { cn } from '@/lib/utils'
import { usePersistedState } from '@/lib/usePersistedState'
import { usePlan } from '@/services/planning'
import { ErrorNote, Loading, PlanPicker, SectionCard, StateLegend, usePreferredPlanId } from './common'
import { DURATION_NAME, FLAG_NAME, STATE_BAR, dayLabel, hoursLabel, opState, processName, qtyLabel, tonnes, wallLabel } from './format'
import { EventForm, describeEvent, useAddEvent } from './events'

const RANGES = [
  { value: '7', label: '7 days', px: 140 },
  { value: '14', label: '2 weeks', px: 90 },
  { value: '30', label: 'Month', px: 44 },
  { value: '90', label: '3 months', px: 16 },
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
              {qtyLabel(op.qty)} pcs{op.weightKg ? `, ${tonnes(op.weightKg)}` : ''}
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
                <Badge tone={f === 'running' ? 'green' : f === 'waits-material' || f === 'assumed-hours' ? 'amber' : f === 'hypothetical' ? 'violet' : f === 'no-capacity' || f === 'beyond-horizon' ? 'red' : 'neutral'}>{FLAG_NAME[f]}</Badge>
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
  const labelEvery = dayPx >= 40 ? 1 : dayPx >= 16 ? 7 : 14
  if (rows.length === 0) return <EmptyState icon={<CalendarClock className="h-10 w-10" />} title="Nothing planned in these days" hint="Try a longer span, or another plan." />
  const nowLeft = ((detail.now - from) / MINUTES_PER_DAY) * dayPx
  return (
    <div className="overflow-x-auto rounded-xl ring-1 ring-slate-200 dark:ring-slate-700">
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
              {dayList.map((d, i) =>
                weekday(d) === 5 ? <div key={d} aria-hidden className="absolute inset-y-0 bg-slate-100 dark:bg-slate-800/70" style={{ left: i * dayPx, width: dayPx }} /> : null,
              )}
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
  const [factory, setFactory] = useState('')
  const [open, setOpen] = useState<PlanOperation | null>(null)
  const { data, error, isLoading, refetch } = usePlan(planId)
  const r = RANGES.find((x) => x.value === range) ?? RANGES[1]
  const factories = useMemo(() => [...new Set((data?.machines ?? []).map((m) => m.factory).filter(Boolean))].sort(), [data])
  const machineOf = useMemo(() => new Map((data?.machines ?? []).map((m) => [m.key, m])), [data])
  const needle = q.trim().toLowerCase()
  const filter = useMemo(
    () => (op: PlanOperation) =>
      (!machineFilter || op.machineKey === machineFilter) &&
      (!factory || machineOf.get(op.machineKey)?.factory === factory) &&
      (!needle || op.orderNumber.toLowerCase().includes(needle) || op.item.toLowerCase().includes(needle) || op.customer.toLowerCase().includes(needle) || op.lineKey.toLowerCase().includes(needle)),
    [machineFilter, factory, needle, machineOf],
  )
  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params)
    if (v) next.set(k, v)
    else next.delete(k)
    setParams(next, { replace: true })
  }
  const unplaced = data?.operations.filter((o) => o.start === null) ?? []

  return (
    <SectionCard
      title="Schedule"
      hint="Each machine’s lines on the factory’s clock, from the day the plan was worked out. Choose a bar for what it is, and to try a change."
      actions={<PlanPicker value={planId} onChange={(id) => setParam('plan', id)} />}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Segmented label="Span" value={r.value} onChange={setRange} options={RANGES.map((x) => ({ value: x.value, label: x.label }))} />
        {factories.length > 1 && (
          <Select aria-label="Factory" value={factory} onChange={(e) => setFactory(e.target.value)} className="min-h-[40px] w-auto">
            <option value="">Every factory</option>
            {factories.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </Select>
        )}
        {machineFilter && (
          <button type="button" onClick={() => setParam('machine', '')} className="btn-secondary min-h-[40px] px-3">
            {machineOf.get(machineFilter)?.name ?? machineFilter} ✕
          </button>
        )}
        <label className="relative min-w-[200px] flex-1 sm:max-w-xs">
          <span className="sr-only">Find an order, item or customer</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Order, item, customer" className="min-h-[40px] pl-9" />
        </label>
      </div>
      {isLoading && <Loading />}
      {error && <ErrorNote error={error} retry={() => void refetch()} />}
      {data && (
        <>
          <Timeline detail={data} days={Number(r.value)} dayPx={r.px} filter={filter} onOpen={setOpen} />
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <StateLegend states={['running', 'planned', 'late', 'material', 'hypothetical']} />
            <p className="text-xs text-muted">Shaded: Friday. The red line: when the plan was worked out from ({wallLabel(data.now)}).</p>
          </div>
          {unplaced.length > 0 && (
            <div className="mt-4 rounded-xl bg-danger-50 p-3 text-sm ring-1 ring-inset ring-danger-200 dark:bg-danger-500/10 dark:ring-danger-500/25">
              <p className="font-semibold text-danger-800 dark:text-danger-300">{unplaced.length} lines could not be placed</p>
              <p className="text-danger-800 dark:text-danger-300">Their machine has no working time in the planning horizon: set its hours under Capacity.</p>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {unplaced.slice(0, 30).map((o) => (
                  <li key={o.lineId}>
                    <button type="button" onClick={() => setOpen(o)} className="rounded-md bg-white px-2 py-1 text-xs font-semibold ring-1 ring-inset ring-danger-200 dark:bg-slate-900 dark:ring-danger-500/30">
                      {o.orderNumber} · {machineOf.get(o.machineKey)?.name ?? o.machineKey}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {data.warnings.length > 0 && (
            <ul className="mt-3 list-disc space-y-1 pl-5 text-13 text-warning-800 dark:text-warning-400">
              {data.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          {open && <OpDetail op={open} detail={data} onClose={() => setOpen(null)} />}
        </>
      )}
    </SectionCard>
  )
}
