// ============================================================================
// §25 — planning's setup, each beside what the record says: each machine's
// hours a day, efficiency and Fridays (Capacity); each item's way through
// the factory and each machine's pace (Routes and paces); the holidays and
// Fridays worked (Calendar); how the engine plans (Settings); and what the
// data lacks (Data gaps). Read by everyone with Planning; changed by people
// with Planning setup, every change audited. Each fills the window: the
// form or the actions in the toolbar, the table scrolling inside its card
// with Excel's filters on its headers.
// ============================================================================

import { useEffect, useMemo, useState } from 'react'
import { CalendarDays, Check, DatabaseZap, Gauge, RefreshCw, RotateCcw, Route as RouteIcon, Save, Trash2 } from 'lucide-react'
import { PLANNING_PROCESSES, PROCESS_NAMES, addDays, type CalendarResponse, type CapacityRow, type ItemRoute, type MachineRate, type PlanSettings } from '@qc/shared/planning'
import { calendarDay } from '@qc/shared/rules'
import { Badge, Button, EmptyState, Field, Input, Select, type BadgeTone } from '@/components/ui'
import { FilterSelect, Segmented } from '@/components/ui/PageShell'
import { cn, formatDateTime } from '@/lib/utils'
import { usePersistedState } from '@/lib/usePersistedState'
import { useAuth } from '@/store/AuthContext'
import { useCalendar, useCapacity, useGaps, useLearnNow, useRates, useRoutes, useSaveSettings, useSetCalendarDay, useSetCapacity, useSetRate, useSettings } from '@/services/planning'
import { DataGrid, ErrorNote, Loading, Meter, OBJECTIVE_NAME, PartFrame, Scroller, SearchBox, useGrid, type GridColumn } from './common'
import { dayLabel, hoursLabel, processName } from './format'

const sourceName = (s: 'set' | 'inferred' | 'default') => (s === 'set' ? 'set' : s === 'inferred' ? 'learnt' : 'default')
const sourceBadge = (s: 'set' | 'inferred' | 'default') => <Badge tone={s === 'set' ? 'blue' : s === 'inferred' ? 'green' : 'amber'}>{sourceName(s)}</Badge>

function LearnButton() {
  const { can } = useAuth()
  const learn = useLearnNow()
  if (!can('manage-planning-setup')) return null
  return (
    <>
      <Button className="min-h-[40px]" disabled={learn.isPending} onClick={() => learn.mutate()} data-tip="Read the production record and the order sheet again now (it is done every six hours)">
        <RefreshCw className={cn('h-4 w-4', learn.isPending && 'animate-spin')} /> Learn again now
      </Button>
      {learn.error && <ErrorNote error={learn.error} />}
    </>
  )
}

const Fail = ({ error, retry }: { error: unknown; retry?: () => void }) => (
  <div className="p-4">
    <ErrorNote error={error} retry={retry} />
  </div>
)

// ---- Capacity -------------------------------------------------------------------------------------

function CapacityEdit({ row, onDone }: { row: CapacityRow; onDone: () => void }) {
  const save = useSetCapacity()
  const [hours, setHours] = useState(String(row.set?.hoursPerDay ?? row.effective.hoursPerDay))
  const [eff, setEff] = useState(row.set?.efficiency !== null && row.set?.efficiency !== undefined ? String(row.set.efficiency) : '')
  const [fridays, setFridays] = useState(row.set?.worksFridays ?? row.effective.worksFridays)
  const [note, setNote] = useState(row.set?.note ?? '')
  return (
    <form
      className="grid gap-3 sm:grid-cols-[repeat(4,minmax(0,1fr)),auto] sm:items-end"
      onSubmit={async (e) => {
        e.preventDefault()
        await save.mutateAsync({
          machineKey: row.machine.key,
          req: {
            hoursPerDay: Number(hours),
            efficiency: eff === '' ? null : Number(eff),
            worksFridays: fridays,
            note,
          },
        })
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

const learntLine = (r: CapacityRow) =>
  r.stats?.hoursPerDay !== null && r.stats?.hoursPerDay !== undefined
    ? `${hoursLabel(r.stats.hoursPerDay)} over ${r.stats.daysObserved} days`
    : r.stats
      ? `${r.stats.daysObserved} days: too few`
      : 'Nothing on the record'

export function CapacitySection() {
  const { data, error, isLoading, refetch } = useCapacity()
  const { can } = useAuth()
  const clear = useSetCapacity()
  const [editing, setEditing] = useState<string | null>(null)
  const mayEdit = can('manage-planning-setup')
  const rows = data?.rows ?? []
  const columns = useMemo<GridColumn<CapacityRow>[]>(
    () => [
      {
        key: 'machine',
        label: 'Machine',
        value: (r) => r.machine.name,
        cell: (r) => <span className="font-semibold">{r.machine.name}</span>,
      },
      {
        key: 'factory',
        label: 'Factory',
        value: (r) => r.machine.factory,
        cell: (r) => r.machine.factory || '—',
      },
      {
        key: 'process',
        label: 'Process',
        value: (r) => processName(r.machine.process),
        cell: (r) => processName(r.machine.process),
      },
      {
        key: 'hours',
        label: 'Plan uses',
        numeric: true,
        value: (r) => String(r.effective.hoursPerDay),
        sortValue: (r) => r.effective.hoursPerDay,
        className: 'whitespace-nowrap',
        cell: (r) => (
          <>
            <span className="mr-1.5 font-semibold tabular-nums">{hoursLabel(r.effective.hoursPerDay)}</span>
            {sourceBadge(r.effective.source)}
            {r.set?.note && <span className="block text-xs text-muted">{r.set.note}</span>}
          </>
        ),
      },
      {
        key: 'source',
        label: 'From',
        value: (r) => sourceName(r.effective.source),
        cell: (r) => (r.set ? `${r.set.updatedByName}, ${formatDateTime(r.set.updatedAt)}` : sourceName(r.effective.source)),
        className: 'text-13',
      },
      {
        key: 'learnt',
        label: 'Learnt',
        value: learntLine,
        noValues: true,
        sortValue: (r) => r.stats?.hoursPerDay ?? null,
        className: 'text-13',
        cell: (r) => (
          <>
            {learntLine(r)}
            {r.stats?.hoursFrom === 'planned' && <span className="block text-xs text-muted">from planned hours (actual not recorded)</span>}
            {r.stats && r.stats.shifts.length > 0 && <span className="block text-xs text-muted">{r.stats.shifts.join('، ')}</span>}
          </>
        ),
      },
      {
        key: 'efficiency',
        label: 'Efficiency',
        numeric: true,
        right: true,
        value: (r) => r.effective.efficiency.toFixed(2),
        sortValue: (r) => r.effective.efficiency,
        cell: (r) => (
          <>
            {r.effective.efficiency.toFixed(2)}
            {r.stats?.efficiency !== null && r.stats?.efficiency !== undefined && <span className="block text-xs text-muted">learnt {r.stats.efficiency.toFixed(2)}</span>}
          </>
        ),
      },
      {
        key: 'fridays',
        label: 'Fridays',
        value: (r) => (r.effective.worksFridays ? 'Worked' : 'Off'),
        cell: (r) => (r.effective.worksFridays ? 'Worked' : 'Off'),
      },
      {
        key: 'set',
        label: '',
        plain: true,
        value: () => '',
        cell: (r) =>
          mayEdit && editing !== r.machine.key ? (
            <div className="flex gap-1.5">
              <Button className="min-h-[36px] px-2.5" onClick={() => setEditing(r.machine.key)}>
                Set
              </Button>
              {r.set && (
                <Button
                  className="min-h-[36px] px-2.5"
                  disabled={clear.isPending}
                  aria-label={`Back to the learnt hours of ${r.machine.name}`}
                  data-tip="Back to the learnt hours"
                  onClick={() => clear.mutate({ machineKey: r.machine.key, req: null })}
                >
                  <RotateCcw className="h-4 w-4" />
                </Button>
              )}
            </div>
          ) : null,
      },
    ],
    [mayEdit, editing, clear.mutate, clear.isPending],
  )
  const view = useGrid(rows, columns)
  return (
    <PartFrame
      toolbar={
        <>
          <LearnButton />
          <span className="text-13 text-muted">
            Hours each machine works in a working day (from 08:00): set by a planner, else learnt from the production record (the median of its hours a day, last 120 days), else the default. Learnt{' '}
            {data?.learntAt ? formatDateTime(data.learntAt) : 'not yet'}.
          </span>
        </>
      }
    >
      {isLoading ? (
        <Loading what="Reading the machines" />
      ) : error || !data ? (
        <Fail error={error} retry={() => void refetch()} />
      ) : (
        <DataGrid
          view={view}
          columns={columns}
          rowKey={(r) => r.machine.key}
          total={rows.length}
          noun="machines"
          caption="Machines’ capacity"
          empty={<EmptyState icon={<Gauge className="h-10 w-10" />} title="No machine" hint="None matches the filters." />}
          expand={(r) => (editing === r.machine.key ? <CapacityEdit row={r} onDone={() => setEditing(null)} /> : null)}
          footer={<span>Efficiency is planned ÷ actual hours on the machine’s rows: the ERP’s durations are divided by it when the settings say so.</span>}
        />
      )}
    </PartFrame>
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
      className="flex flex-wrap items-center gap-2"
      onSubmit={async (e) => {
        e.preventDefault()
        await set.mutateAsync({
          req: {
            machineKey,
            itemFamily: family.trim(),
            piecesPerHour: Number(pph),
          },
        })
        setPph('')
      }}
    >
      <FilterSelect label="Machine of the new pace" value={machineKey} onChange={setMachine}>
        {machines.map((m) => (
          <option key={m.key} value={m.key}>
            {m.name}
          </option>
        ))}
      </FilterSelect>
      <Input
        value={family}
        onChange={(e) => setFamily(e.target.value)}
        maxLength={60}
        placeholder="Item family (empty: all)"
        aria-label="Item family; empty for everything on the machine"
        className="h-10 w-44 py-0 text-sm touch:h-11"
      />
      <Input
        type="number"
        min={0.001}
        step="any"
        required
        value={pph}
        onChange={(e) => setPph(e.target.value)}
        placeholder="Pieces an hour"
        aria-label="Pieces an hour"
        className="h-10 w-36 py-0 text-sm touch:h-11"
      />
      <Button type="submit" variant="primary" className="min-h-[40px]" disabled={set.isPending} data-tip="A set pace goes before everything learnt">
        <Check className="h-4 w-4" /> Set the pace
      </Button>
      {set.error && <ErrorNote error={set.error} />}
    </form>
  )
}

type RateRow = MachineRate & {
  note?: string
  updatedByName?: string
  updatedAt?: string
}

export function RoutesSection() {
  const [tab, setTab] = usePersistedState<'routes' | 'paces'>('qc-planning:routes-tab', 'routes')
  const [q, setQ] = useState('')
  const [process, setProcess] = useState('')
  const [machine, setMachine] = useState('')
  const routes = useRoutes(q.trim(), process)
  const rates = useRates(machine || undefined)
  const capacity = useCapacity()
  const { can } = useAuth()
  const clear = useSetRate()
  const machines = useMemo(
    () =>
      (capacity.data?.rows ?? []).map((r) => ({
        key: r.machine.key,
        name: r.machine.name,
      })),
    [capacity.data],
  )
  const nameOf = useMemo(() => new Map(machines.map((m) => [m.key, m.name])), [machines])
  const order = routes.data?.processOrder
  const mayEdit = can('manage-planning-setup')

  const routeRows = routes.data?.routes ?? []
  const routeColumns = useMemo<GridColumn<ItemRoute>[]>(
    () => [
      {
        key: 'code',
        label: 'Item code',
        value: (r) => r.itemCode.toUpperCase(),
        noValues: true,
        cell: (r) => <span className="font-semibold">{r.itemCode.toUpperCase()}</span>,
      },
      {
        key: 'item',
        label: 'Item',
        value: (r) => r.item,
        noValues: true,
        cell: (r) => (
          <span className="block max-w-[280px] truncate" title={r.item}>
            {r.item}
          </span>
        ),
      },
      {
        key: 'route',
        label: 'Route',
        value: (r) => r.steps.map((s) => PROCESS_NAMES[s.process]).join(' → '),
        cell: (r) => (
          <ol className="flex flex-wrap items-center gap-1.5">
            {r.steps.map((s, i) => (
              <li key={s.process} className="flex items-center gap-1.5">
                {i > 0 && (
                  <span aria-hidden className="text-muted">
                    →
                  </span>
                )}
                <span className="rounded-md bg-slate-100 px-2 py-1 text-xs dark:bg-slate-800" title={s.machines.map((m) => `${nameOf.get(m.machineKey) ?? m.machineKey}: ${m.lines}`).join(', ')}>
                  <span className="font-semibold">{PROCESS_NAMES[s.process]}</span>{' '}
                  <span className="text-muted">
                    {s.machines
                      .slice(0, 2)
                      .map((m) => nameOf.get(m.machineKey) ?? m.machineKey)
                      .join(', ')}
                    {s.machines.length > 2 ? '…' : ''}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        ),
      },
      {
        key: 'orders',
        label: 'Orders',
        numeric: true,
        right: true,
        value: (r) => String(r.orders),
        sortValue: (r) => r.orders,
        cell: (r) => r.orders.toLocaleString(),
      },
      {
        key: 'confidence',
        label: 'Took this route',
        numeric: true,
        right: true,
        value: (r) => String(r.confidencePct),
        sortValue: (r) => r.confidencePct,
        cell: (r) => `${r.confidencePct}%`,
      },
      {
        key: 'kg',
        label: 'Kg a piece',
        numeric: true,
        right: true,
        value: (r) => (r.kgPerPiece === null ? '' : String(r.kgPerPiece)),
        sortValue: (r) => r.kgPerPiece,
        cell: (r) => (r.kgPerPiece === null ? <span className="text-muted">—</span> : r.kgPerPiece.toLocaleString()),
      },
    ],
    [nameOf],
  )
  const routeView = useGrid(routeRows, routeColumns)

  const rateRows = useMemo<RateRow[]>(() => [...(rates.data?.set ?? []), ...(rates.data?.learnt ?? [])], [rates.data])
  const forName = (r: RateRow) => (r.itemCode ? `Item ${r.itemCode.toUpperCase()}` : r.itemFamily ? `Family ${r.itemFamily.toUpperCase()}` : 'Everything')
  const rateColumns = useMemo<GridColumn<RateRow>[]>(
    () => [
      {
        key: 'machine',
        label: 'Machine',
        value: (r) => nameOf.get(r.machineKey) ?? r.machineKey,
        cell: (r) => <span className="font-semibold">{nameOf.get(r.machineKey) ?? r.machineKey}</span>,
      },
      {
        key: 'for',
        label: 'For',
        value: forName,
        noValues: true,
        cell: forName,
      },
      {
        key: 'pph',
        label: 'Pieces an hour',
        numeric: true,
        right: true,
        value: (r) => String(Math.round(r.piecesPerHour * 10) / 10),
        sortValue: (r) => r.piecesPerHour,
        cell: (r) => (Math.round(r.piecesPerHour * 10) / 10).toLocaleString(),
      },
      {
        key: 'source',
        label: 'From',
        value: (r) => (r.source === 'set' ? 'set' : 'learnt'),
        cell: (r) =>
          r.source === 'set' ? (
            <span className="flex items-center gap-2">
              {sourceBadge('set')}
              <span className="text-13 text-muted">
                {r.updatedByName}, {r.updatedAt ? formatDateTime(r.updatedAt) : ''}
              </span>
            </span>
          ) : (
            <span className="text-13 text-muted">{r.samples} days on the record</span>
          ),
      },
      {
        key: 'remove',
        label: '',
        plain: true,
        value: () => '',
        cell: (r) =>
          r.source === 'set' && mayEdit ? (
            <Button
              className="min-h-[36px] px-2"
              aria-label="Remove this pace"
              data-tip="Remove this pace"
              disabled={clear.isPending}
              onClick={() =>
                clear.mutate({
                  req: {
                    machineKey: r.machineKey,
                    itemFamily: r.itemFamily,
                    piecesPerHour: 1,
                  },
                  clear: true,
                })
              }
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          ) : null,
      },
    ],
    [nameOf, mayEdit, clear.mutate, clear.isPending],
  )
  const rateView = useGrid(rateRows, rateColumns)

  const orderLine = order
    ? [...new Set(Object.values(order.rank))]
        .sort((a, b) => a - b)
        .map((rank) =>
          PLANNING_PROCESSES.filter((p) => order.rank[p] === rank)
            .map((p) => PROCESS_NAMES[p])
            .join(' / '),
        )
        .join(' → ')
    : null

  return (
    <PartFrame
      toolbar={
        <>
          <Segmented
            label="Routes or paces"
            value={tab}
            onChange={setTab}
            options={[
              {
                value: 'routes',
                label: 'Items’ routes',
                icon: <RouteIcon className="h-4 w-4" />,
              },
              {
                value: 'paces',
                label: 'Machines’ paces',
                icon: <Gauge className="h-4 w-4" />,
              },
            ]}
          />
          {tab === 'routes' ? (
            <>
              <SearchBox value={q} onChange={setQ} placeholder="Item code or name" label="Find an item" />
              <FilterSelect label="Process" value={process} onChange={setProcess}>
                <option value="">Every process</option>
                {PLANNING_PROCESSES.map((p) => (
                  <option key={p} value={p}>
                    Through {PROCESS_NAMES[p].toLowerCase()}
                  </option>
                ))}
              </FilterSelect>
            </>
          ) : (
            <>
              <FilterSelect label="Machine" value={machine} onChange={setMachine}>
                <option value="">Every machine</option>
                {machines.map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.name}
                  </option>
                ))}
              </FilterSelect>
              {mayEdit && machines.length > 0 && <RateForm machines={machines} />}
            </>
          )}
          <span className="flex-1" />
          <LearnButton />
        </>
      }
    >
      {tab === 'routes' ? (
        routes.isLoading ? (
          <Loading what="Reading the routes" />
        ) : routes.error || !routes.data ? (
          <Fail error={routes.error} />
        ) : (
          <DataGrid
            view={routeView}
            columns={routeColumns}
            rowKey={(r) => r.itemCode}
            total={routeRows.length}
            noun="items"
            caption="Items’ routes"
            empty={
              <EmptyState
                icon={<RouteIcon className="h-10 w-10" />}
                title="No route"
                hint={q || process ? 'None matches the search or the filters.' : 'Routes are learnt from the order sheet every six hours.'}
              />
            }
            footer={
              <>
                {routes.data.total > routeRows.length && (
                  <span>
                    The {routeRows.length} seen most of {routes.data.total.toLocaleString()}: search for the rest.
                  </span>
                )}
                {orderLine && (
                  <span>
                    <span className="font-semibold">The order the factory works in:</span> {orderLine} (
                    {order?.learnt ? 'learnt from the days each process first worked on an order' : 'the default: too little on the record to learn it'})
                  </span>
                )}
                <span>Later processes of an item wait for its earlier ones.</span>
              </>
            }
          />
        )
      ) : rates.isLoading ? (
        <Loading what="Reading the paces" />
      ) : rates.error ? (
        <Fail error={rates.error} />
      ) : (
        <DataGrid
          view={rateView}
          columns={rateColumns}
          rowKey={(r) => `${r.source}|${r.machineKey}|${r.itemCode}|${r.itemFamily}`}
          total={rateRows.length}
          noun="paces"
          caption="Machines’ paces"
          empty={<EmptyState icon={<Gauge className="h-10 w-10" />} title="No pace" hint="None is set or learnt for this machine yet." />}
          footer={
            <span>
              Pieces an hour, learnt from the production record (the median of finished pieces ÷ hours, by item, by family and for the machine), or set by a planner for a family. A set pace goes
              before everything.
            </span>
          }
        />
      )}
    </PartFrame>
  )
}

// ---- Calendar ---------------------------------------------------------------------------------------

type CalendarDay = CalendarResponse['days'][number]

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
  const rows = data?.days ?? []
  const columns = useMemo<GridColumn<CalendarDay>[]>(
    () => [
      {
        key: 'day',
        label: 'Day',
        value: (d) => dayLabel(d.day, true),
        sortValue: (d) => d.day,
        cell: (d) => <span className="font-semibold tabular-nums">{dayLabel(d.day, true)}</span>,
        className: 'whitespace-nowrap',
      },
      {
        key: 'kind',
        label: 'It is',
        value: (d) => (d.working ? 'Worked' : 'Holiday'),
        cell: (d) => <Badge tone={d.working ? 'green' : 'amber'}>{d.working ? 'Worked' : 'Holiday'}</Badge>,
      },
      {
        key: 'name',
        label: 'What it is',
        value: (d) => d.name,
        noValues: true,
        cell: (d) => d.name,
      },
      {
        key: 'by',
        label: 'Set by',
        value: (d) => d.updatedByName ?? 'Fixed holiday',
        cell: (d) => <span className="text-muted">{d.updatedByName ?? 'Fixed holiday'}</span>,
      },
      {
        key: 'remove',
        label: '',
        plain: true,
        value: () => '',
        cell: (d) =>
          mayEdit ? (
            <Button className="min-h-[36px] px-2" aria-label={`Remove ${d.name}`} data-tip="Remove this day" disabled={set.isPending} onClick={() => set.mutate({ day: d.day, req: null })}>
              <Trash2 className="h-4 w-4" />
            </Button>
          ) : null,
      },
    ],
    [mayEdit, set.mutate, set.isPending],
  )
  const view = useGrid(rows, columns)
  return (
    <PartFrame
      toolbar={
        <>
          {mayEdit && (
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={async (e) => {
                e.preventDefault()
                await set.mutateAsync({
                  day,
                  req: { working, name: name.trim() },
                })
                setName('')
              }}
            >
              <Input type="date" value={day} onChange={(e) => setDay(e.target.value)} required aria-label="Day" className="h-10 w-auto py-0 text-sm touch:h-11" />
              <FilterSelect label="It is" value={working ? 'yes' : 'no'} onChange={(v) => setWorking(v === 'yes')}>
                <option value="no">A holiday</option>
                <option value="yes">Worked (a Friday)</option>
              </FilterSelect>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={120}
                placeholder="What it is: Eid al-Adha"
                aria-label="What it is"
                className="h-10 w-52 py-0 text-sm touch:h-11"
              />
              <Button type="submit" variant="primary" className="min-h-[40px]" disabled={set.isPending}>
                <CalendarDays className="h-4 w-4" /> Add the day
              </Button>
              {set.error && <ErrorNote error={set.error} />}
            </form>
          )}
          <span className="text-13 text-muted">Friday is the day off; every other day is worked unless it is listed here.</span>
        </>
      }
    >
      {isLoading ? (
        <Loading what="Reading the calendar" />
      ) : error || !data ? (
        <Fail error={error} retry={() => void refetch()} />
      ) : (
        <DataGrid
          view={view}
          columns={columns}
          rowKey={(d) => d.day}
          total={rows.length}
          noun="days"
          caption="Holidays and Fridays worked"
          rowClass={(d) => (d.day < today ? 'opacity-70' : undefined)}
          empty={<EmptyState icon={<CalendarDays className="h-10 w-10" />} title="No day listed" hint="Every day but Friday is worked." />}
          footer={
            <span>
              Egypt’s fixed holidays are in already; the moving ones (the Eids, the Islamic New Year, the Prophet’s birthday, Sham El-Nessim) are added when announced. From a month ago to 400 days
              ahead.
            </span>
          }
        />
      )}
    </PartFrame>
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
  if (error || !data) return <Fail error={error} retry={() => void refetch()} />
  const e = {
    ...data.effective,
    ...draft,
    dependencies: { ...data.effective.dependencies, ...draft.dependencies },
  }
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
    <PartFrame
      toolbar={
        <>
          <span className="text-13 text-muted">How every plan is worked out; a scenario may change some for itself. What nobody set is learnt from the record, or the default.</span>
          <span className="flex-1" />
          {mayEdit && (
            <>
              <Button className="min-h-[40px]" disabled={!changed} onClick={() => setDraft(data.set)}>
                <RotateCcw className="h-4 w-4" /> Undo
              </Button>
              <Button variant="primary" className="min-h-[40px]" disabled={!changed || save.isPending} onClick={() => save.mutate({ settings: draft, version: data.version })}>
                <Save className="h-4 w-4" /> Save
              </Button>
            </>
          )}
        </>
      }
    >
      <Scroller padded>
        {save.error && <ErrorNote error={save.error} />}
        <fieldset disabled={!mayEdit} className="divide-y divide-slate-100 dark:divide-slate-800">
          <legend className="sr-only">Planning settings</legend>
          {row(
            'Order of the lines on a machine',
            'After the line running now and the rushed ones.',
            <Select
              value={e.sequenceRule}
              onChange={(x) =>
                set({
                  sequenceRule: x.target.value as PlanSettings['sequenceRule'],
                })
              }
              className="min-h-[44px]"
            >
              <option value="erp">The ERP’s planned start</option>
              <option value="due">The due day</option>
              <option value="fifo">The order date</option>
            </Select>,
          )}
          {row(
            'Where a line’s hours come from first',
            'The other is used when the first has nothing for the line; a pace a planner set goes before both.',
            <Select
              value={e.timeSource}
              onChange={(x) =>
                set({
                  timeSource: x.target.value as PlanSettings['timeSource'],
                })
              }
              className="min-h-[44px]"
            >
              <option value="erp-first">The ERP’s part duration</option>
              <option value="actual-first">The machine’s pace on the record</option>
            </Select>,
          )}
          {row(
            'What the ERP’s part duration covers',
            learnt.erpDuration?.meaning
              ? `Learnt: ${learnt.erpDuration.meaning === 'line' ? 'the whole line' : 'one piece'} (${learnt.erpDuration.lineVotes} lines say the line, ${learnt.erpDuration.pieceVotes} a piece).`
              : 'Not learnt yet: too few lines are on both the order sheet and the production record.',
            <Select
              value={e.erpDurationMeaning}
              onChange={(x) =>
                set({
                  erpDurationMeaning: x.target.value as PlanSettings['erpDurationMeaning'],
                })
              }
              className="min-h-[44px]"
            >
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
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={e.dependencies[k]}
                    onChange={(x) =>
                      set({
                        dependencies: {
                          ...(draft.dependencies ?? {}),
                          [k]: x.target.checked,
                        } as PlanSettings['dependencies'],
                      })
                    }
                  />
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
            'Leave out lines with a due day older than',
            'Days. An open line whose due day is this long past (an order the ERP never closed) is left out, as "stale" on the overview; 0 = plan every open line. The line running now is never left out.',
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={0}
                max={3650}
                step={1}
                value={e.ignoreDueOlderThanDays}
                onChange={(x) =>
                  set({
                    ignoreDueOlderThanDays: Math.max(0, Math.floor(Number(x.target.value) || 0)),
                  })
                }
                aria-label="Days; 0 = off"
                className="min-h-[44px]"
              />
              <span className="shrink-0 text-13 text-muted">days{e.ignoreDueOlderThanDays === 0 ? ' (off)' : ''}</span>
            </div>,
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
            'Tonne-days late weighs a heavy order’s delay more than a light one’s (a line with no weight counts as a tonne); late lines counts each line once; days late adds the days. Orders delivered whole: an order is as late as its last line, weighed by its whole weight, and its lines are moved together — for a factory that ships an order in one go.',
            <Select value={e.objective} onChange={(x) => set({ objective: x.target.value as PlanSettings['objective'] })} className="min-h-[44px]">
              {(Object.keys(OBJECTIVE_NAME) as PlanSettings['objective'][]).map((k) => (
                <option key={k} value={k}>
                  {OBJECTIVE_NAME[k]}
                </option>
              ))}
            </Select>,
          )}
          {row(
            'Price of a machine working a Friday',
            'For the advice under Delivery date: what a machine working a day off costs, in the factory’s currency. 0 = not priced.',
            <Input type="number" min={0} step={1} value={e.costFridayMachineDay} onChange={(x) => set({ costFridayMachineDay: Math.max(0, Number(x.target.value) || 0) })} className="min-h-[44px]" />,
          )}
          {row(
            'Price of an extra machine hour',
            'What an hour beyond a machine’s day costs (overtime, a longer shift). 0 = not priced.',
            <Input type="number" min={0} step={1} value={e.costExtraMachineHour} onChange={(x) => set({ costExtraMachineHour: Math.max(0, Number(x.target.value) || 0) })} className="min-h-[44px]" />,
          )}
          {row(
            'Price of a tonne a day late',
            'What a tonne of another order delayed a day costs (penalties, goodwill): the advice weighs its options against the other orders with it. 0 = not priced.',
            <Input type="number" min={0} step={1} value={e.costLateTonneDay} onChange={(x) => set({ costLateTonneDay: Math.max(0, Number(x.target.value) || 0) })} className="min-h-[44px]" />,
          )}
          {row(
            'Default hours of a line',
            'For a line with no duration and no pace to go by.',
            <Input type="number" min={0.1} step={0.5} value={e.defaultLineHours} onChange={(x) => set({ defaultLineHours: Number(x.target.value) })} className="min-h-[44px]" />,
          )}
        </fieldset>
      </Scroller>
    </PartFrame>
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
  if (error || !data) return <Fail error={error} retry={() => void refetch()} />
  return (
    <PartFrame
      toolbar={
        <span className="text-13 text-muted">
          Checked over the {data.openLines.toLocaleString()} open order lines and the machines. Each filled in makes every plan better; nothing here stops the plan from being worked out.
        </span>
      }
    >
      <Scroller padded>
        {data.gaps.length === 0 ? (
          <EmptyState icon={<DatabaseZap className="h-10 w-10" />} title="Nothing missing" />
        ) : (
          <ul className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
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
      </Scroller>
    </PartFrame>
  )
}
