// ============================================================================
// §25 — more of planning's setup: changeovers (how long a machine stops
// between two item families — under Routes & paces) and preventive
// maintenance (a machine stops every so many days or running hours — under
// Calendar). Each is a form in the toolbar for people with Planning setup
// and a table with Excel's filters, every change audited; the engine counts
// both in every plan.
// ============================================================================

import { useMemo, useState } from 'react'
import { Check, RefreshCw, Trash2, Wrench } from 'lucide-react'
import { PLANNING_PROCESSES, PROCESS_NAMES, type MaintenanceResponse, type PlanningProcess, type SetupTimesResponse } from '@qc/shared/planning'
import { Button, EmptyState, Input } from '@/components/ui'
import { FilterSelect } from '@/components/ui/PageShell'
import { formatDateTime } from '@/lib/utils'
import { useAuth } from '@/store/AuthContext'
import { useMaintenance, useSetMaintenance, useSetSetupTime, useSetupTimes } from '@/services/planning'
import { DataGrid, ErrorNote, Loading, useGrid, type GridColumn } from './common'
import { dayLabel } from './format'

type Machine = { key: string; name: string }
type SetupRow = SetupTimesResponse['rules'][number]
type MaintenanceRow = MaintenanceResponse['rules'][number]

const ANY = '*'

const scopeName = (r: SetupRow, nameOf: (k: string) => string) => (r.machineKey ? nameOf(r.machineKey) : r.process ? `Every ${PROCESS_NAMES[r.process].toLowerCase()} machine` : 'Every machine')

/** The toolbar's form: a changeover rule set or replaced. */
export function ChangeoverForm({ machines }: { machines: Machine[] }) {
  const set = useSetSetupTime()
  const [scope, setScope] = useState<string>(ANY)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [minutes, setMinutes] = useState('')
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={async (e) => {
        e.preventDefault()
        const machineKey = scope.startsWith('m:') ? scope.slice(2) : null
        const process = scope.startsWith('p:') ? (scope.slice(2) as PlanningProcess) : null
        await set.mutateAsync({ req: { machineKey, process, fromFamily: from.trim(), toFamily: to.trim(), minutes: Number(minutes) } })
        setMinutes('')
      }}
    >
      <FilterSelect label="On" value={scope} onChange={setScope}>
        <option value={ANY}>Every machine</option>
        {PLANNING_PROCESSES.map((p) => (
          <option key={p} value={`p:${p}`}>
            Every {PROCESS_NAMES[p].toLowerCase()} machine
          </option>
        ))}
        {machines.map((m) => (
          <option key={m.key} value={`m:${m.key}`}>
            {m.name}
          </option>
        ))}
      </FilterSelect>
      <Input value={from} onChange={(e) => setFrom(e.target.value)} maxLength={60} placeholder="From family (empty: any)" aria-label="From family; empty for any" className="h-10 w-44 py-0 text-sm touch:h-11" />
      <Input value={to} onChange={(e) => setTo(e.target.value)} maxLength={60} placeholder="To family (empty: any)" aria-label="To family; empty for any" className="h-10 w-44 py-0 text-sm touch:h-11" />
      <Input type="number" min={0} max={1440} step={1} required value={minutes} onChange={(e) => setMinutes(e.target.value)} placeholder="Minutes" aria-label="Minutes the changeover takes" className="h-10 w-28 py-0 text-sm touch:h-11" />
      <Button type="submit" variant="primary" className="min-h-[40px]" disabled={set.isPending || minutes === ''} data-tip="The most specific rule wins: a machine’s over its process’s over everyone’s; both families named over one over none">
        <Check className="h-4 w-4" /> Set the changeover
      </Button>
      {set.error && <ErrorNote error={set.error} />}
    </form>
  )
}

/** The table of changeover rules. */
export function ChangeoverGrid({ machines }: { machines: Machine[] }) {
  const { data, error, isLoading, refetch } = useSetupTimes()
  const { can } = useAuth()
  const clear = useSetSetupTime()
  const mayEdit = can('manage-planning-setup')
  const nameOf = useMemo(() => {
    const m = new Map(machines.map((x) => [x.key, x.name]))
    return (k: string) => m.get(k) ?? `Machine ${k}`
  }, [machines])
  const rows = data?.rules ?? []
  const columns = useMemo<GridColumn<SetupRow>[]>(
    () => [
      { key: 'scope', label: 'On', value: (r) => scopeName(r, nameOf), cell: (r) => <span className="font-semibold">{scopeName(r, nameOf)}</span> },
      { key: 'from', label: 'From family', value: (r) => r.fromFamily || 'Any', cell: (r) => r.fromFamily || <span className="text-muted">Any</span> },
      { key: 'to', label: 'To family', value: (r) => r.toFamily || 'Any', cell: (r) => r.toFamily || <span className="text-muted">Any</span> },
      { key: 'minutes', label: 'Minutes', numeric: true, right: true, value: (r) => String(r.minutes), sortValue: (r) => r.minutes, cell: (r) => r.minutes.toLocaleString() },
      { key: 'note', label: 'Note', value: (r) => r.note ?? '', noValues: true, cell: (r) => r.note || <span className="text-muted">—</span> },
      { key: 'by', label: 'Set by', value: (r) => r.updatedByName, cell: (r) => <span className="text-13 text-muted">{r.updatedByName}, {formatDateTime(r.updatedAt)}</span> },
      {
        key: 'remove',
        label: '',
        plain: true,
        value: () => '',
        cell: (r) =>
          mayEdit ? (
            <Button className="min-h-[36px] px-2" aria-label="Remove this changeover" data-tip="Remove this changeover" disabled={clear.isPending} onClick={() => clear.mutate({ req: null, id: r.id })}>
              <Trash2 className="h-4 w-4" />
            </Button>
          ) : null,
      },
    ],
    [nameOf, mayEdit, clear.mutate, clear.isPending],
  )
  const view = useGrid(rows, columns)
  if (isLoading) return <Loading what="Reading the changeovers" />
  if (error || !data)
    return (
      <div className="p-4">
        <ErrorNote error={error} retry={() => void refetch()} />
      </div>
    )
  return (
    <DataGrid
      view={view}
      columns={columns}
      rowKey={(r) => r.id}
      total={rows.length}
      noun="changeovers"
      caption="Changeovers between item families"
      empty={<EmptyState icon={<RefreshCw className="h-10 w-10" />} title="No changeover set" hint="The plan counts no time between two families until one is set here. A line’s family is the item family on the order sheet, or its item code." />}
      footer={<span>Counted in front of a line when the family before it on the machine differs; the most specific rule wins. A line’s family is its item family on the sheet, else its item code.</span>}
    />
  )
}

/** The toolbar's form: a maintenance rule added. */
export function MaintenanceForm({ machines }: { machines: Machine[] }) {
  const set = useSetMaintenance()
  const [machineKey, setMachine] = useState(machines[0]?.key ?? '')
  const [name, setName] = useState('')
  const [by, setBy] = useState<'days' | 'hours'>('days')
  const [every, setEvery] = useState('')
  const [duration, setDuration] = useState('')
  const [lastDone, setLastDone] = useState('')
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={async (e) => {
        e.preventDefault()
        await set.mutateAsync({
          req: { machineKey, name: name.trim(), everyDays: by === 'days' ? Number(every) : null, everyRunHours: by === 'hours' ? Number(every) : null, durationHours: Number(duration), lastDone: lastDone || null },
        })
        setName('')
        setLastDone('')
        setEvery('')
        setDuration('')
      }}
    >
      <FilterSelect label="Machine" value={machineKey} onChange={setMachine}>
        {machines.map((m) => (
          <option key={m.key} value={m.key}>
            {m.name}
          </option>
        ))}
      </FilterSelect>
      <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} placeholder="What: oil change" aria-label="What the maintenance is" className="h-10 w-40 py-0 text-sm touch:h-11" />
      <span className="text-13 text-muted">every</span>
      <Input type="number" min={1} step="any" required value={every} onChange={(e) => setEvery(e.target.value)} placeholder="30" aria-label="Every how many" className="h-10 w-20 py-0 text-sm touch:h-11" />
      <FilterSelect label="Days or running hours" value={by} onChange={(v) => setBy(v as 'days' | 'hours')}>
        <option value="days">days</option>
        <option value="hours">running hours</option>
      </FilterSelect>
      <span className="text-13 text-muted">for</span>
      <Input type="number" min={0.25} step={0.25} required value={duration} onChange={(e) => setDuration(e.target.value)} placeholder="4" aria-label="Hours it takes" className="h-10 w-20 py-0 text-sm touch:h-11" />
      <span className="text-13 text-muted">h, last done</span>
      <Input type="date" value={lastDone} onChange={(e) => setLastDone(e.target.value)} aria-label="Last done (optional)" className="h-10 w-auto py-0 text-sm touch:h-11" />
      <Button type="submit" variant="primary" className="min-h-[40px]" disabled={set.isPending || !machineKey}>
        <Wrench className="h-4 w-4" /> Add
      </Button>
      {set.error && <ErrorNote error={set.error} />}
    </form>
  )
}

/** The table of maintenance rules. */
export function MaintenanceGrid({ machines }: { machines: Machine[] }) {
  const { data, error, isLoading, refetch } = useMaintenance()
  const { can } = useAuth()
  const clear = useSetMaintenance()
  const mayEdit = can('manage-planning-setup')
  const nameOf = useMemo(() => {
    const m = new Map(machines.map((x) => [x.key, x.name]))
    return (k: string) => m.get(k) ?? `Machine ${k}`
  }, [machines])
  const rows = data?.rules ?? []
  const every = (r: MaintenanceRow) => (r.everyDays !== null ? `${r.everyDays} days` : `${r.everyRunHours} running hours`)
  const columns = useMemo<GridColumn<MaintenanceRow>[]>(
    () => [
      { key: 'machine', label: 'Machine', value: (r) => nameOf(r.machineKey), cell: (r) => <span className="font-semibold">{nameOf(r.machineKey)}</span> },
      { key: 'name', label: 'What', value: (r) => r.name, noValues: true, cell: (r) => r.name },
      { key: 'every', label: 'Every', value: every, cell: every },
      { key: 'duration', label: 'Hours', numeric: true, right: true, value: (r) => String(r.durationHours), sortValue: (r) => r.durationHours, cell: (r) => r.durationHours.toLocaleString() },
      { key: 'last', label: 'Last done', value: (r) => (r.lastDone ? dayLabel(r.lastDone, true) : 'Never'), sortValue: (r) => r.lastDone, cell: (r) => (r.lastDone ? dayLabel(r.lastDone, true) : <span className="text-muted">Never: counted from today</span>), className: 'whitespace-nowrap' },
      { key: 'start', label: 'Starts at', value: (r) => r.startTime ?? '08:00', cell: (r) => r.startTime ?? '08:00' },
      { key: 'by', label: 'Set by', value: (r) => r.updatedByName, cell: (r) => <span className="text-13 text-muted">{r.updatedByName}, {formatDateTime(r.updatedAt)}</span> },
      {
        key: 'remove',
        label: '',
        plain: true,
        value: () => '',
        cell: (r) =>
          mayEdit ? (
            <Button className="min-h-[36px] px-2" aria-label={`Remove ${r.name}`} data-tip="Remove this maintenance" disabled={clear.isPending} onClick={() => clear.mutate({ req: null, id: r.id })}>
              <Trash2 className="h-4 w-4" />
            </Button>
          ) : null,
      },
    ],
    [nameOf, mayEdit, clear.mutate, clear.isPending],
  )
  const view = useGrid(rows, columns)
  if (isLoading) return <Loading what="Reading the maintenance" />
  if (error || !data)
    return (
      <div className="p-4">
        <ErrorNote error={error} retry={() => void refetch()} />
      </div>
    )
  return (
    <DataGrid
      view={view}
      columns={columns}
      rowKey={(r) => r.id}
      total={rows.length}
      noun="maintenance rules"
      caption="Preventive maintenance"
      empty={<EmptyState icon={<Wrench className="h-10 w-10" />} title="No maintenance set" hint="A machine stops every so many days (or running hours) for so many hours: the plan runs around the stops." />}
      footer={<span>Every plan stops the machine for each of these, from the last time (from today when never done; one due before today is done today). Running hours are read as days of the machine’s own work.</span>}
    />
  )
}
