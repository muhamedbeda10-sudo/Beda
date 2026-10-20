// ============================================================================
// §25 — planning's setup, each beside what the record says: each machine's
// hours a day, efficiency and Fridays (Capacity); each item's way through
// the factory and each machine's pace (Routes and paces); the holidays and
// Fridays worked (Calendar); how the engine plans (Settings); and what the
// data lacks (Data gaps). Read by everyone with Planning; changed by people
// with Planning setup, every change audited.
// ============================================================================

import { Fragment, useEffect, useMemo, useState } from 'react'
import { CalendarDays, Check, DatabaseZap, RefreshCw, RotateCcw, Save, Search, Trash2 } from 'lucide-react'
import { PLANNING_PROCESSES, PROCESS_NAMES, addDays, type CapacityRow, type PlanSettings } from '@qc/shared/planning'
import { calendarDay } from '@qc/shared/rules'
import { Badge, Button, EmptyState, Field, Input, Select, type BadgeTone } from '@/components/ui'
import { cn, formatDateTime } from '@/lib/utils'
import { useAuth } from '@/store/AuthContext'
import {
  useCalendar,
  useCapacity,
  useGaps,
  useLearnNow,
  useRates,
  useRoutes,
  useSaveSettings,
  useSetCalendarDay,
  useSetCapacity,
  useSetRate,
  useSettings,
} from '@/services/planning'
import { ErrorNote, Loading, Meter, OBJECTIVE_NAME, SectionCard } from './common'
import { dayLabel, hoursLabel, processName } from './format'

const sourceBadge = (s: 'set' | 'inferred' | 'default') =>
  s === 'set' ? <Badge tone="blue">set</Badge> : s === 'inferred' ? <Badge tone="green">learnt</Badge> : <Badge tone="amber">default</Badge>

function LearnButton() {
  const { can } = useAuth()
  const learn = useLearnNow()
  if (!can('manage-planning-setup')) return null
  return (
    <>
      <Button className="min-h-[44px]" disabled={learn.isPending} onClick={() => learn.mutate()} data-tip="Read the production record and the order sheet again now (it is done every six hours)">
        <RefreshCw className={cn('h-4 w-4', learn.isPending && 'animate-spin')} /> Learn again now
      </Button>
      {learn.error && <ErrorNote error={learn.error} />}
    </>
  )
}

// ---- Capacity -------------------------------------------------------------------------------------

function CapacityEdit({ row, onDone }: { row: CapacityRow; onDone: () => void }) {
  const save = useSetCapacity()
  const [hours, setHours] = useState(String(row.set?.hoursPerDay ?? row.effective.hoursPerDay))
  const [eff, setEff] = useState(row.set?.efficiency !== null && row.set?.efficiency !== undefined ? String(row.set.efficiency) : '')
  const [fridays, setFridays] = useState(row.set?.worksFridays ?? row.effective.worksFridays)
  const [note, setNote] = useState(row.set?.note ?? '')
  return (
    <form
      className="grid gap-3 rounded-xl bg-slate-50 p-3 sm:grid-cols-[repeat(4,minmax(0,1fr)),auto] sm:items-end dark:bg-slate-800/50"
      onSubmit={async (e) => {
        e.preventDefault()
        await save.mutateAsync({ machineKey: row.machine.key, req: { hoursPerDay: Number(hours), efficiency: eff === '' ? null : Number(eff), worksFridays: fridays, note } })
        onDone()
      }}
    >
      <Field label="Hours a day">
        <Input type="number" min={0} max={24} step={0.5} required value={hours} onChange={(e) => setHours(e.target.value)} className="min-h-[44px]" />
      </Field>
      <Field label="Efficiency" hint="Empty: learnt. 1 = the ERP’s standard.">
        <Input type="number" min={0.1} max={3} step={0.05} value={eff} onChange={(e) => setEff(e.target.value)} className="min-h-[44px]" />
      </Field>
      <Field label="Fridays">
        <Select value={fridays ? 'yes' : 'no'} onChange={(e) => setFridays(e.target.value === 'yes')} className="min-h-[44px]">
          <option value="no">Off</option>
          <option value="yes">Worked</option>
        </Select>
      </Field>
      <Field label="Note">
        <Input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} className="min-h-[44px]" placeholder="Two shifts of 8 h" />
      </Field>
      <div className="flex gap-2">
        <Button type="submit" variant="primary" className="min-h-[44px]" disabled={save.isPending}>
          <Save className="h-4 w-4" /> Save
        </Button>
        <Button type="button" className="min-h-[44px]" onClick={onDone}>
          Cancel
        </Button>
      </div>
      {save.error && (
        <div className="sm:col-span-5">
          <ErrorNote error={save.error} />
        </div>
      )}
    </form>
  )
}

export function CapacitySection() {
  const { data, error, isLoading, refetch } = useCapacity()
  const { can } = useAuth()
  const clear = useSetCapacity()
  const [editing, setEditing] = useState<string | null>(null)
  const mayEdit = can('manage-planning-setup')
  if (isLoading) return <Loading what="Reading the machines" />
  if (error || !data) return <ErrorNote error={error} retry={() => void refetch()} />
  return (
    <SectionCard
      title="Machines’ capacity"
      hint="Hours each machine works in a working day (from 08:00): set by a planner, else learnt from the production record (the median of the hours its rows add up to on the days it worked, last 120 days), else the default."
      actions={<LearnButton />}
    >
      <p className="mb-3 text-13 text-muted">Learnt {data.learntAt ? formatDateTime(data.learntAt) : 'not yet'}. Efficiency is planned ÷ actual hours on the machine’s rows: the ERP’s durations are divided by it when the settings say so.</p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] text-sm">
          <thead className="text-left text-xs text-muted">
            <tr className="border-b border-slate-200 dark:border-slate-700">
              <th scope="col" className="py-2 pr-3 font-semibold">Machine</th>
              <th scope="col" className="py-2 pr-3 font-semibold">Plan uses</th>
              <th scope="col" className="py-2 pr-3 font-semibold">Learnt</th>
              <th scope="col" className="py-2 pr-3 font-semibold">Efficiency</th>
              <th scope="col" className="py-2 pr-3 font-semibold">Fridays</th>
              <th scope="col" className="py-2 font-semibold">
                <span className="sr-only">Change</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {data.rows.map((r) => (
              <Fragment key={r.machine.key}>
                <tr className="align-top">
                  <td className="py-2 pr-3">
                    <span className="block font-semibold">{r.machine.name}</span>
                    <span className="block text-xs text-muted">
                      {r.machine.factory || '—'} · {processName(r.machine.process)}
                    </span>
                  </td>
                  <td className="whitespace-nowrap py-2 pr-3">
                    <span className="mr-1.5 font-semibold tabular-nums">{hoursLabel(r.effective.hoursPerDay)}</span>
                    {sourceBadge(r.effective.source)}
                    {r.set?.note && <span className="block text-xs text-muted">{r.set.note}</span>}
                  </td>
                  <td className="py-2 pr-3 text-13">
                    {r.stats?.hoursPerDay !== null && r.stats?.hoursPerDay !== undefined ? (
                      <>
                        {hoursLabel(r.stats.hoursPerDay)} over {r.stats.daysObserved} days
                        {r.stats.hoursFrom === 'planned' && <span className="block text-xs text-muted">from planned hours (actual not recorded)</span>}
                        {r.stats.shifts.length > 0 && <span className="block text-xs text-muted">{r.stats.shifts.join('، ')}</span>}
                      </>
                    ) : (
                      <span className="text-muted">{r.stats ? `${r.stats.daysObserved} days: too few` : 'Nothing on the record'}</span>
                    )}
                  </td>
                  <td className="py-2 pr-3 tabular-nums">
                    {r.effective.efficiency.toFixed(2)}
                    {r.stats?.efficiency !== null && r.stats?.efficiency !== undefined && <span className="block text-xs text-muted">learnt {r.stats.efficiency.toFixed(2)}</span>}
                  </td>
                  <td className="py-2 pr-3">{r.effective.worksFridays ? 'Worked' : 'Off'}</td>
                  <td className="py-2">
                    {mayEdit && editing !== r.machine.key && (
                      <div className="flex gap-1.5">
                        <Button className="min-h-[40px] px-3" onClick={() => setEditing(r.machine.key)}>
                          Set
                        </Button>
                        {r.set && (
                          <Button className="min-h-[40px] px-3" disabled={clear.isPending} aria-label={`Back to the learnt hours of ${r.machine.name}`} onClick={() => clear.mutate({ machineKey: r.machine.key, req: null })}>
                            <RotateCcw className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
                {editing === r.machine.key && (
                  <tr>
                    <td colSpan={6} className="py-2">
                      <CapacityEdit row={r} onDone={() => setEditing(null)} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </SectionCard>
  )
}

// ---- Routes and paces ------------------------------------------------------------------------------

function RateForm({ machines }: { machines: { key: string; name: string }[] }) {
  const set = useSetRate()
  const [machineKey, setMachine] = useState(machines[0]?.key ?? '')
  const [family, setFamily] = useState('')
  const [pph, setPph] = useState('')
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={async (e) => {
        e.preventDefault()
        await set.mutateAsync({ req: { machineKey, itemFamily: family.trim(), piecesPerHour: Number(pph) } })
        setPph('')
      }}
    >
      <Field label="Machine">
        <Select value={machineKey} onChange={(e) => setMachine(e.target.value)} className="min-h-[44px]">
          {machines.map((m) => (
            <option key={m.key} value={m.key}>
              {m.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Item family" hint="Empty: everything on the machine.">
        <Input value={family} onChange={(e) => setFamily(e.target.value)} maxLength={60} className="min-h-[44px] w-36" />
      </Field>
      <Field label="Pieces an hour">
        <Input type="number" min={0.001} step="any" required value={pph} onChange={(e) => setPph(e.target.value)} className="min-h-[44px] w-36" />
      </Field>
      <Button type="submit" variant="primary" className="min-h-[44px]" disabled={set.isPending}>
        <Check className="h-4 w-4" /> Set the pace
      </Button>
      {set.error && <ErrorNote error={set.error} />}
    </form>
  )
}

export function RoutesSection() {
  const [q, setQ] = useState('')
  const [process, setProcess] = useState('')
  const [machine, setMachine] = useState('')
  const routes = useRoutes(q.trim(), process)
  const rates = useRates(machine || undefined)
  const capacity = useCapacity()
  const { can } = useAuth()
  const clear = useSetRate()
  const machines = useMemo(() => (capacity.data?.rows ?? []).map((r) => ({ key: r.machine.key, name: r.machine.name })), [capacity.data])
  const nameOf = useMemo(() => new Map(machines.map((m) => [m.key, m.name])), [machines])
  const order = routes.data?.processOrder
  return (
    <div className="space-y-4">
      <SectionCard
        title="Items’ routes"
        hint="The processes each item passes through, learnt from the order sheet: its lines of one order on machines of different processes. Later processes of an item wait for its earlier ones."
        actions={<LearnButton />}
      >
        {order && (
          <p className="mb-3 text-13">
            <span className="font-semibold">The order the factory works in:</span>{' '}
            {[...new Set(Object.values(order.rank))]
              .sort((a, b) => a - b)
              .map((rank) =>
                PLANNING_PROCESSES.filter((p) => order.rank[p] === rank)
                  .map((p) => PROCESS_NAMES[p])
                  .join(' / '),
              )
              .join(' → ')}{' '}
            <span className="text-muted">({order.learnt ? 'learnt from the days each process first worked on an order' : 'the default: too little on the record to learn it'})</span>
          </p>
        )}
        <div className="mb-3 flex flex-wrap gap-2">
          <label className="relative min-w-[220px] flex-1 sm:max-w-xs">
            <span className="sr-only">Find an item</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Item code or name" className="min-h-[44px] pl-9" />
          </label>
          <Select aria-label="Process" value={process} onChange={(e) => setProcess(e.target.value)} className="min-h-[44px] w-auto">
            <option value="">Every process</option>
            {PLANNING_PROCESSES.map((p) => (
              <option key={p} value={p}>
                Through {PROCESS_NAMES[p].toLowerCase()}
              </option>
            ))}
          </Select>
        </div>
        {routes.isLoading ? (
          <Loading what="Reading the routes" />
        ) : routes.error ? (
          <ErrorNote error={routes.error} />
        ) : routes.data && routes.data.routes.length === 0 ? (
          <p className="text-sm text-muted">No route learnt{q ? ' matches' : ' yet: they are learnt every six hours'}.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="text-left text-xs text-muted">
                <tr className="border-b border-slate-200 dark:border-slate-700">
                  <th scope="col" className="py-2 pr-3 font-semibold">Item</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">Route</th>
                  <th scope="col" className="py-2 font-semibold">Seen on</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {routes.data?.routes.map((r) => (
                  <tr key={r.itemCode} className="align-top">
                    <td className="py-2 pr-3">
                      <span className="block font-semibold">{r.itemCode.toUpperCase()}</span>
                      <span className="block max-w-[280px] truncate text-xs text-muted">{r.item}</span>
                    </td>
                    <td className="py-2 pr-3">
                      <ol className="flex flex-wrap items-center gap-1.5">
                        {r.steps.map((s, i) => (
                          <li key={s.process} className="flex items-center gap-1.5">
                            {i > 0 && <span aria-hidden className="text-muted">→</span>}
                            <span className="rounded-md bg-slate-100 px-2 py-1 text-xs dark:bg-slate-800" title={s.machines.map((m) => `${nameOf.get(m.machineKey) ?? m.machineKey}: ${m.lines}`).join(', ')}>
                              <span className="font-semibold">{PROCESS_NAMES[s.process]}</span>{' '}
                              <span className="text-muted">{s.machines.slice(0, 2).map((m) => nameOf.get(m.machineKey) ?? m.machineKey).join(', ')}{s.machines.length > 2 ? '…' : ''}</span>
                            </span>
                          </li>
                        ))}
                      </ol>
                    </td>
                    <td className="whitespace-nowrap py-2 text-13">
                      {r.orders} order{r.orders === 1 ? '' : 's'}
                      <span className="block text-xs text-muted">{r.confidencePct}% took this route</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {routes.data && routes.data.total > routes.data.routes.length && <p className="mt-2 text-xs text-muted">The {routes.data.routes.length} seen most of {routes.data.total}: search for the rest.</p>}
          </div>
        )}
      </SectionCard>

      <SectionCard title="Machines’ paces" hint="Pieces an hour, learnt from the production record (the median of finished pieces ÷ hours, by item, by family and for the machine), or set by a planner for a family. A set pace goes before everything.">
        {can('manage-planning-setup') && machines.length > 0 && (
          <div className="mb-4 rounded-xl bg-slate-50 p-3 dark:bg-slate-800/50">
            <RateForm machines={machines} />
          </div>
        )}
        <Select aria-label="Machine" value={machine} onChange={(e) => setMachine(e.target.value)} className="mb-3 min-h-[44px] w-auto">
          <option value="">Every machine</option>
          {machines.map((m) => (
            <option key={m.key} value={m.key}>
              {m.name}
            </option>
          ))}
        </Select>
        {rates.isLoading ? (
          <Loading what="Reading the paces" />
        ) : rates.error ? (
          <ErrorNote error={rates.error} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="text-left text-xs text-muted">
                <tr className="border-b border-slate-200 dark:border-slate-700">
                  <th scope="col" className="py-2 pr-3 font-semibold">Machine</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">For</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">Pieces an hour</th>
                  <th scope="col" className="py-2 font-semibold">From</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {[...(rates.data?.set ?? []), ...(rates.data?.learnt ?? [])].slice(0, 400).map((r) => (
                  <tr key={`${r.source}|${r.machineKey}|${r.itemCode}|${r.itemFamily}`}>
                    <td className="py-2 pr-3 font-semibold">{nameOf.get(r.machineKey) ?? r.machineKey}</td>
                    <td className="py-2 pr-3">{r.itemCode ? `Item ${r.itemCode.toUpperCase()}` : r.itemFamily ? `Family ${r.itemFamily.toUpperCase()}` : 'Everything'}</td>
                    <td className="py-2 pr-3 tabular-nums">{Math.round(r.piecesPerHour * 10) / 10}</td>
                    <td className="py-2">
                      {r.source === 'set' ? (
                        <span className="flex items-center gap-2">
                          {sourceBadge('set')}
                          {can('manage-planning-setup') && (
                            <Button className="min-h-[36px] px-2" aria-label="Remove this pace" disabled={clear.isPending} onClick={() => clear.mutate({ req: { machineKey: r.machineKey, itemFamily: r.itemFamily, piecesPerHour: 1 }, clear: true })}>
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          )}
                        </span>
                      ) : (
                        <span className="text-13 text-muted">{r.samples} days on the record</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  )
}

// ---- Calendar ---------------------------------------------------------------------------------------

export function CalendarSection() {
  const { factoryTimeZone, can } = useAuth()
  const today = calendarDay(new Date(), factoryTimeZone)
  const from = addDays(today, -31)
  const to = addDays(today, 400)
  const { data, error, isLoading, refetch } = useCalendar(from, to)
  const set = useSetCalendarDay()
  const [day, setDay] = useState(today)
  const [working, setWorking] = useState(false)
  const [name, setName] = useState('')
  const mayEdit = can('manage-planning-setup')
  return (
    <SectionCard
      title="Calendar"
      hint="Friday is the day off; every other day is worked unless it is listed here. Egypt’s fixed holidays are in already; the moving ones (the Eids, the Islamic New Year, the Prophet’s birthday, Sham El-Nessim) are added when announced."
    >
      {mayEdit && (
        <form
          className="mb-4 flex flex-wrap items-end gap-3 rounded-xl bg-slate-50 p-3 dark:bg-slate-800/50"
          onSubmit={async (e) => {
            e.preventDefault()
            await set.mutateAsync({ day, req: { working, name: name.trim() } })
            setName('')
          }}
        >
          <Field label="Day">
            <Input type="date" value={day} onChange={(e) => setDay(e.target.value)} required className="min-h-[44px]" />
          </Field>
          <Field label="It is">
            <Select value={working ? 'yes' : 'no'} onChange={(e) => setWorking(e.target.value === 'yes')} className="min-h-[44px]">
              <option value="no">A holiday</option>
              <option value="yes">Worked (a Friday)</option>
            </Select>
          </Field>
          <div className="min-w-[200px] flex-1">
            <Field label="What it is">
              <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} placeholder="Eid al-Adha" className="min-h-[44px]" />
            </Field>
          </div>
          <Button type="submit" variant="primary" className="min-h-[44px]" disabled={set.isPending}>
            <CalendarDays className="h-4 w-4" /> Add the day
          </Button>
          {set.error && <ErrorNote error={set.error} />}
        </form>
      )}
      {isLoading && <Loading what="Reading the calendar" />}
      {error && <ErrorNote error={error} retry={() => void refetch()} />}
      {data && data.days.length === 0 && <EmptyState icon={<CalendarDays className="h-10 w-10" />} title="No day listed" hint="Every day but Friday is worked." />}
      {data && data.days.length > 0 && (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {data.days.map((d) => (
            <li key={d.day} className={cn('flex flex-wrap items-center gap-3 py-2 text-sm', d.day < today && 'opacity-70')}>
              <span className="w-36 shrink-0 font-semibold tabular-nums">{dayLabel(d.day, true)}</span>
              <Badge tone={d.working ? 'green' : 'amber'}>{d.working ? 'Worked' : 'Holiday'}</Badge>
              <span className="min-w-0 flex-1">{d.name}</span>
              <span className="text-xs text-muted">{d.updatedByName ?? 'Fixed holiday'}</span>
              {mayEdit && (
                <Button className="min-h-[36px] px-2" aria-label={`Remove ${d.name}`} disabled={set.isPending} onClick={() => set.mutate({ day: d.day, req: null })}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  )
}

// ---- Settings ------------------------------------------------------------------------------------------

export function SettingsSection() {
  const { data, error, isLoading, refetch } = useSettings()
  const save = useSaveSettings()
  const { can } = useAuth()
  const mayEdit = can('manage-planning-setup')
  const [draft, setDraft] = useState<Partial<PlanSettings>>({})
  useEffect(() => setDraft(data?.set ?? {}), [data])
  if (isLoading) return <Loading what="Reading the settings" />
  if (error || !data) return <ErrorNote error={error} retry={() => void refetch()} />
  const e = { ...data.effective, ...draft, dependencies: { ...data.effective.dependencies, ...draft.dependencies } }
  const set = (patch: Partial<PlanSettings>) => setDraft((d) => ({ ...d, ...patch }))
  const changed = JSON.stringify(draft) !== JSON.stringify(data.set)
  const learnt = data.learnt
  const row = (label: string, hint: string, control: JSX.Element) => (
    <div className="grid gap-1 py-3 sm:grid-cols-[1fr,260px] sm:items-center sm:gap-4">
      <div>
        <p className="font-semibold">{label}</p>
        <p className="text-13 text-muted">{hint}</p>
      </div>
      {control}
    </div>
  )
  return (
    <SectionCard
      title="How the plan is worked out"
      hint="For every plan; a scenario may change some for itself. What nobody set is learnt from the record, or the default."
      actions={
        mayEdit ? (
          <>
            <Button className="min-h-[44px]" disabled={!changed} onClick={() => setDraft(data.set)}>
              <RotateCcw className="h-4 w-4" /> Undo
            </Button>
            <Button variant="primary" className="min-h-[44px]" disabled={!changed || save.isPending} onClick={() => save.mutate({ settings: draft, version: data.version })}>
              <Save className="h-4 w-4" /> Save
            </Button>
          </>
        ) : undefined
      }
    >
      {save.error && <ErrorNote error={save.error} />}
      <fieldset disabled={!mayEdit} className="divide-y divide-slate-100 dark:divide-slate-800">
        <legend className="sr-only">Planning settings</legend>
        {row(
          'Order of the lines on a machine',
          'After the line running now and the rushed ones.',
          <Select value={e.sequenceRule} onChange={(x) => set({ sequenceRule: x.target.value as PlanSettings['sequenceRule'] })} className="min-h-[44px]">
            <option value="erp">The ERP’s planned start</option>
            <option value="due">The due day</option>
            <option value="fifo">The order date</option>
          </Select>,
        )}
        {row(
          'Where a line’s hours come from first',
          'The other is used when the first has nothing for the line; a pace a planner set goes before both.',
          <Select value={e.timeSource} onChange={(x) => set({ timeSource: x.target.value as PlanSettings['timeSource'] })} className="min-h-[44px]">
            <option value="erp-first">The ERP’s part duration</option>
            <option value="actual-first">The machine’s pace on the record</option>
          </Select>,
        )}
        {row(
          'What the ERP’s part duration covers',
          learnt.erpDuration?.meaning
            ? `Learnt: ${learnt.erpDuration.meaning === 'line' ? 'the whole line' : 'one piece'} (${learnt.erpDuration.lineVotes} lines say the line, ${learnt.erpDuration.pieceVotes} a piece).`
            : 'Not learnt yet: too few lines are on both the order sheet and the production record.',
          <Select value={e.erpDurationMeaning} onChange={(x) => set({ erpDurationMeaning: x.target.value as PlanSettings['erpDurationMeaning'] })} className="min-h-[44px]">
            <option value="line">The whole line’s hours</option>
            <option value="piece">One piece’s hours</option>
          </Select>,
        )}
        {row(
          'Use each machine’s efficiency',
          'Divide the ERP’s hours by the machine’s learnt efficiency (planned ÷ actual).',
          <Select value={e.applyEfficiency ? 'yes' : 'no'} onChange={(x) => set({ applyEfficiency: x.target.value === 'yes' })} className="min-h-[44px]">
            <option value="no">No</option>
            <option value="yes">Yes</option>
          </Select>,
        )}
        {row(
          'A later stage may overlap the earlier one',
          '0% = welding waits until forming has finished; 50% = it starts once forming is half done.',
          <Select value={String(e.overlapPct)} onChange={(x) => set({ overlapPct: Number(x.target.value) })} className="min-h-[44px]">
            {[0, 25, 50, 75, 100].map((p) => (
              <option key={p} value={p}>
                {p}%
              </option>
            ))}
          </Select>,
        )}
        {row(
          'Which lines wait for which',
          'An item’s later process waits for its earlier one in the same order; a line waits for the lines whose parent id it is.',
          <div className="space-y-1.5 text-sm">
            {(
              [
                ['sameItem', 'Same item, same order'],
                ['parent', 'Parent ids'],
                ['orderProcess', 'Whole order, process by process'],
              ] as const
            ).map(([k, label]) => (
              <label key={k} className="flex items-center gap-2">
                <input type="checkbox" className="h-4 w-4" checked={e.dependencies[k]} onChange={(x) => set({ dependencies: { ...(draft.dependencies ?? {}), [k]: x.target.checked } as PlanSettings['dependencies'] })} />
                {label}
              </label>
            ))}
          </div>,
        )}
        {row(
          'Lines the ERP holds',
          'Lines with the status Hold.',
          <Select value={e.includeHold ? 'yes' : 'no'} onChange={(x) => set({ includeHold: x.target.value === 'yes' })} className="min-h-[44px]">
            <option value="no">Left out</option>
            <option value="yes">Planned</option>
          </Select>,
        )}
        {row(
          'Wait for raw material',
          'A line whose material is not received starts no sooner than its promise day.',
          <Select value={e.materialGate ? 'yes' : 'no'} onChange={(x) => set({ materialGate: x.target.value === 'yes' })} className="min-h-[44px]">
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </Select>,
        )}
        {row(
          'Default hours a day',
          'For a machine with no hours set or learnt.',
          <Input type="number" min={0} max={24} step={0.5} value={e.defaultHoursPerDay} onChange={(x) => set({ defaultHoursPerDay: Number(x.target.value) })} className="min-h-[44px]" />,
        )}
        {row(
          'The optimiser',
          'After the priority order, it tries moving late lines ahead on their machines and keeps what makes the objective smaller. Light tries a few dozen plans; full a few hundred; a big record gets fewer. Same data, same plan, every time.',
          <Select value={e.optimise} onChange={(x) => set({ optimise: x.target.value as PlanSettings['optimise'] })} className="min-h-[44px]">
            <option value="off">Off: the priority order</option>
            <option value="light">Light</option>
            <option value="full">Full</option>
          </Select>,
        )}
        {row(
          'What it makes smaller',
          'Tonne-days late weighs a heavy order’s delay more than a light one’s (a line with no weight counts as a tonne); late lines counts each line once; days late adds the days.',
          <Select value={e.objective} onChange={(x) => set({ objective: x.target.value as PlanSettings['objective'] })} className="min-h-[44px]">
            {(Object.keys(OBJECTIVE_NAME) as PlanSettings['objective'][]).map((k) => (
              <option key={k} value={k}>
                {OBJECTIVE_NAME[k]}
              </option>
            ))}
          </Select>,
        )}
        {row(
          'Default hours of a line',
          'For a line with no duration and no pace to go by.',
          <Input type="number" min={0.1} step={0.5} value={e.defaultLineHours} onChange={(x) => set({ defaultLineHours: Number(x.target.value) })} className="min-h-[44px]" />,
        )}
      </fieldset>
    </SectionCard>
  )
}

// ---- Data gaps -------------------------------------------------------------------------------------------

const SEVERITY: Record<'high' | 'medium' | 'low', { name: string; tone: BadgeTone }> = {
  high: { name: 'Needed', tone: 'red' },
  medium: { name: 'Would help', tone: 'amber' },
  low: { name: 'Later', tone: 'neutral' },
}

export function GapsSection() {
  const { data, error, isLoading, refetch } = useGaps()
  if (isLoading) return <Loading what="Checking the data" />
  if (error || !data) return <ErrorNote error={error} retry={() => void refetch()} />
  return (
    <SectionCard title="What the data lacks" hint={`Checked over the ${data.openLines.toLocaleString()} open order lines and the machines. Each filled in makes every plan better; nothing here stops the plan from being worked out.`}>
      {data.gaps.length === 0 ? (
        <EmptyState icon={<DatabaseZap className="h-10 w-10" />} title="Nothing missing" />
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {data.gaps.map((g) => (
            <li key={g.id} className="rounded-xl p-4 ring-1 ring-inset ring-slate-200 dark:ring-slate-700">
              <div className="flex items-start gap-2">
                <h3 className="min-w-0 flex-1 font-bold">{g.title}</h3>
                <Badge tone={SEVERITY[g.severity].tone}>{SEVERITY[g.severity].name}</Badge>
              </div>
              <p className="mt-1 text-13 text-muted">{g.detail}</p>
              {g.filledPct !== null && (
                <div className="mt-2">
                  <Meter pct={g.filledPct} label={`${g.title}: filled`} tone={g.filledPct < 50 ? 'danger' : g.filledPct < 85 ? 'warning' : 'success'} />
                  <p className="mt-0.5 text-xs text-muted">{g.missing.toLocaleString()} without it</p>
                </div>
              )}
              <p className="mt-2 text-13">
                <span className="font-semibold">To close it:</span> {g.fix}
              </p>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  )
}
