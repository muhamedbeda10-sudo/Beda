// ============================================================================
// §25 — a scenario's changes ("events"): the form that adds one, the words
// that describe one, and the way a change reaches a plan — added to a draft
// the person may change, or, on the automatic or the published plan, as a
// new scenario made from it, so the plan itself is never touched.
// ============================================================================

import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { PLAN_EVENT_TYPES, type PlanDetail, type PlanEvent, type PlanEventType, type PlanMachineInfo } from '@qc/shared/planning'
import { Button, Field, Input, Select } from '@/components/ui'
import { useAuth } from '@/store/AuthContext'
import { useCreatePlan, useUpdatePlan } from '@/services/planning'
import { dayLabel } from './format'

/** An event as the form makes it: everything but its id, which the server gives. */
export type NewEvent = { [K in PlanEvent['type']]: Omit<Extract<PlanEvent, { type: K }>, 'id'> & { id?: string } }[PlanEvent['type']]

const machineName = (machines: ReadonlyMap<string, PlanMachineInfo>, key: string) => machines.get(key)?.name ?? `Machine ${key}`
const wall = (s: string) => s.replace('T', ' ')
const line = (e: { lineKey?: string; orderNumber?: string; customer?: string }) =>
  e.lineKey ? `line ${e.lineKey}` : e.orderNumber ? `order ${e.orderNumber}` : e.customer ? `customer ${e.customer}` : '—'

/** A change in plain words. */
export function describeEvent(e: NewEvent, machines: ReadonlyMap<string, PlanMachineInfo>): string {
  switch (e.type) {
    case 'machine-down':
      return `${machineName(machines, e.machineKey)} down from ${e.from} to ${e.to}`
    case 'capacity':
      return `${machineName(machines, e.machineKey)} works ${e.hoursPerDay} h a day from ${dayLabel(e.fromDay)} to ${dayLabel(e.toDay)}`
    case 'working-day':
      return `${dayLabel(e.day, true)} ${e.working ? 'worked' : 'not worked'}${e.machineKey ? ` on ${machineName(machines, e.machineKey)}` : ' by the factory'}`
    case 'speed':
      return `${machineName(machines, e.machineKey)} at ${e.speedPct}% of its pace`
    case 'move':
      return `Line ${e.lineKey} moved to ${machineName(machines, e.toMachineKey)}`
    case 'priority':
      return `Rush ${line(e)}`
    case 'not-before':
      return `Line ${e.lineKey} starts no sooner than ${e.at}`
    case 'material':
      return `Material for ${line(e)} arrives ${dayLabel(e.availableDay)}`
    case 'exclude':
      return `Leave out ${line(e)}`
    case 'due':
      return `Due ${dayLabel(e.dueDate)}: ${line(e)}`
    case 'quantity':
      return `Line ${e.lineKey}: ${e.remainingQty.toLocaleString()} pieces left`
    case 'add-order':
      return `New order ${e.orderNumber}: ${e.qty.toLocaleString()} × ${e.item} on ${machineName(machines, e.machineKey)}, ${e.hours} h${e.dueDate ? `, due ${dayLabel(e.dueDate)}` : ''}`
  }
}

/**
 * Adding a change to a plan: to a draft the person may change, as a new version of it; to any other plan (the
 * automatic one, the published one), as a new scenario made from it, opened in the Simulator.
 */
export function useAddEvent(detail: PlanDetail | undefined) {
  const { can } = useAuth()
  const navigate = useNavigate()
  const update = useUpdatePlan(detail?.plan.id ?? '')
  const create = useCreatePlan()
  const mayEdit = can('edit-planning')
  const add = async (event: NewEvent, name: string) => {
    if (!detail) return
    if (detail.plan.editable) {
      await update.mutateAsync({ version: detail.plan.version, events: [...detail.plan.events, event as PlanEvent] })
      return
    }
    const made = await create.mutateAsync({ kind: 'scenario', name: name.slice(0, 120), fromId: detail.plan.id, events: [event as PlanEvent] })
    navigate(`/planning/simulator?plan=${encodeURIComponent(made.plan.id)}`)
  }
  return { add, mayEdit, pending: update.isPending || create.isPending, error: update.error ?? create.error, intoScenario: !!detail && !detail.plan.editable }
}

const TODAY = () => new Date().toISOString().slice(0, 10)

/** The fields of the form, whatever the type: each type reads the ones it needs. */
interface Draft {
  machineKey: string
  toMachineKey: string
  from: string
  to: string
  fromDay: string
  toDay: string
  day: string
  working: 'yes' | 'no'
  hoursPerDay: string
  speedPct: string
  target: 'lineKey' | 'orderNumber' | 'customer'
  ref: string
  at: string
  dueDate: string
  remainingQty: string
  orderNumber: string
  item: string
  customer: string
  qty: string
  hours: string
  note: string
}

const blank = (machine: string): Draft => ({
  machineKey: machine,
  toMachineKey: machine,
  from: `${TODAY()}T08:00`,
  to: `${TODAY()}T16:00`,
  fromDay: TODAY(),
  toDay: TODAY(),
  day: TODAY(),
  working: 'yes',
  hoursPerDay: '16',
  speedPct: '80',
  target: 'lineKey',
  ref: '',
  at: `${TODAY()}T08:00`,
  dueDate: TODAY(),
  remainingQty: '',
  orderNumber: '',
  item: '',
  customer: '',
  qty: '',
  hours: '',
  note: '',
})

/** The event the form describes, or what is missing. */
export function eventOf(type: PlanEventType, d: Draft): NewEvent | string {
  const num = (s: string) => (s.trim() === '' ? NaN : Number(s))
  const note = d.note.trim() || undefined
  const target = d.ref.trim() ? { [d.target]: d.ref.trim() } : null
  switch (type) {
    case 'machine-down':
      return d.to > d.from ? { type, machineKey: d.machineKey, from: wall(d.from), to: wall(d.to), note } : 'The machine comes back after it stops.'
    case 'capacity':
      return d.toDay >= d.fromDay && num(d.hoursPerDay) >= 0 && num(d.hoursPerDay) <= 24
        ? { type, machineKey: d.machineKey, fromDay: d.fromDay, toDay: d.toDay, hoursPerDay: num(d.hoursPerDay), note }
        : 'Hours a day from 0 to 24, and the last day on or after the first.'
    case 'working-day':
      return { type, day: d.day, working: d.working === 'yes', machineKey: d.machineKey || undefined, note }
    case 'speed':
      return num(d.speedPct) >= 10 && num(d.speedPct) <= 500 ? { type, machineKey: d.machineKey, speedPct: num(d.speedPct), note } : 'The pace from 10% to 500%.'
    case 'move':
      return d.ref.trim() ? { type, lineKey: d.ref.trim(), toMachineKey: d.toMachineKey, note } : 'Name the line (its Order ID).'
    case 'priority':
    case 'exclude':
      if (!target) return 'Name the line, the order or the customer.'
      if (type === 'exclude' && d.target === 'customer') return 'Leave out a line or an order.'
      return { type, ...target, note } as NewEvent
    case 'material':
      return target && d.target !== 'customer' ? ({ type, ...target, availableDay: d.day, note } as NewEvent) : 'Name the line or the order.'
    case 'due':
      return target && d.target !== 'customer' ? ({ type, ...target, dueDate: d.dueDate, note } as NewEvent) : 'Name the line or the order.'
    case 'not-before':
      return d.ref.trim() ? { type, lineKey: d.ref.trim(), at: wall(d.at), note } : 'Name the line (its Order ID).'
    case 'quantity':
      return d.ref.trim() && num(d.remainingQty) >= 0 ? { type, lineKey: d.ref.trim(), remainingQty: num(d.remainingQty), note } : 'Name the line and the pieces left.'
    case 'add-order':
      return d.orderNumber.trim() && d.item.trim() && num(d.qty) > 0 && num(d.hours) > 0
        ? { type, orderNumber: d.orderNumber.trim(), item: d.item.trim(), customer: d.customer.trim(), machineKey: d.machineKey, qty: num(d.qty), hours: num(d.hours), dueDate: d.dueDate || null, note }
        : 'An order number, the item, its quantity and its hours on the machine.'
  }
}

export function EventForm({ detail, onAdd, pending, initial }: { detail: PlanDetail; onAdd: (e: NewEvent) => void | Promise<void>; pending?: boolean; initial?: { type?: PlanEventType; ref?: string } }) {
  const machines = detail.machines.filter((m) => m.known)
  const [type, setType] = useState<PlanEventType>(initial?.type ?? 'machine-down')
  const [d, setD] = useState<Draft>(() => ({ ...blank(machines[0]?.key ?? ''), ref: initial?.ref ?? '' }))
  const [problem, setProblem] = useState<string | null>(null)
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }))
  const lineKeys = useMemo(() => [...new Set(detail.operations.map((o) => o.lineKey))].slice(0, 2000), [detail])
  const orders = useMemo(() => [...new Set(detail.operations.map((o) => o.orderNumber))].slice(0, 2000), [detail])
  const customers = useMemo(() => [...new Set(detail.operations.map((o) => o.customer).filter(Boolean))].slice(0, 500), [detail])
  const help = PLAN_EVENT_TYPES.find((t) => t.type === type)?.help
  const machineSelect = (k: 'machineKey' | 'toMachineKey', label: string, optional = false) => (
    <Field label={label}>
      <Select value={d[k]} onChange={(e) => set(k, e.target.value)} className="min-h-[44px]">
        {optional && <option value="">The whole factory</option>}
        {machines.map((m) => (
          <option key={m.key} value={m.key}>
            {m.name}
          </option>
        ))}
      </Select>
    </Field>
  )
  const refField = (allowCustomer: boolean, allowOrder = true) => (
    <div className="grid gap-3 sm:grid-cols-[auto,1fr]">
      {(allowOrder || allowCustomer) && (
        <Field label="Which">
          <Select value={d.target} onChange={(e) => set('target', e.target.value as Draft['target'])} className="min-h-[44px]">
            <option value="lineKey">A line (Order ID)</option>
            {allowOrder && <option value="orderNumber">An order</option>}
            {allowCustomer && <option value="customer">A customer</option>}
          </Select>
        </Field>
      )}
      <Field label={d.target === 'lineKey' ? 'Order ID' : d.target === 'orderNumber' ? 'Order number' : 'Customer'}>
        <Input value={d.ref} onChange={(e) => set('ref', e.target.value)} list={`planning-${d.target}`} className="min-h-[44px]" autoComplete="off" />
      </Field>
    </div>
  )
  const submit = async () => {
    const e = eventOf(type, d)
    if (typeof e === 'string') {
      setProblem(e)
      return
    }
    setProblem(null)
    await onAdd(e)
  }
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <Field label="Change" hint={help}>
        <Select value={type} onChange={(e) => setType(e.target.value as PlanEventType)} className="min-h-[44px]">
          {PLAN_EVENT_TYPES.map((t) => (
            <option key={t.type} value={t.type}>
              {t.name}
            </option>
          ))}
        </Select>
      </Field>
      {type === 'machine-down' && (
        <div className="grid gap-3 sm:grid-cols-3">
          {machineSelect('machineKey', 'Machine')}
          <Field label="Stops">
            <Input type="datetime-local" value={d.from} onChange={(e) => set('from', e.target.value)} className="min-h-[44px]" />
          </Field>
          <Field label="Back">
            <Input type="datetime-local" value={d.to} onChange={(e) => set('to', e.target.value)} className="min-h-[44px]" />
          </Field>
        </div>
      )}
      {type === 'capacity' && (
        <div className="grid gap-3 sm:grid-cols-4">
          {machineSelect('machineKey', 'Machine')}
          <Field label="From">
            <Input type="date" value={d.fromDay} onChange={(e) => set('fromDay', e.target.value)} className="min-h-[44px]" />
          </Field>
          <Field label="To">
            <Input type="date" value={d.toDay} onChange={(e) => set('toDay', e.target.value)} className="min-h-[44px]" />
          </Field>
          <Field label="Hours a day">
            <Input type="number" min={0} max={24} step={0.5} value={d.hoursPerDay} onChange={(e) => set('hoursPerDay', e.target.value)} className="min-h-[44px]" />
          </Field>
        </div>
      )}
      {type === 'working-day' && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Day">
            <Input type="date" value={d.day} onChange={(e) => set('day', e.target.value)} className="min-h-[44px]" />
          </Field>
          <Field label="Worked">
            <Select value={d.working} onChange={(e) => set('working', e.target.value as Draft['working'])} className="min-h-[44px]">
              <option value="yes">Worked (a Friday, a holiday)</option>
              <option value="no">Not worked</option>
            </Select>
          </Field>
          {machineSelect('machineKey', 'Where', true)}
        </div>
      )}
      {type === 'speed' && (
        <div className="grid gap-3 sm:grid-cols-2">
          {machineSelect('machineKey', 'Machine')}
          <Field label="Its pace, % of usual" hint="80 = a fifth slower; 120 = a fifth faster.">
            <Input type="number" min={10} max={500} value={d.speedPct} onChange={(e) => set('speedPct', e.target.value)} className="min-h-[44px]" />
          </Field>
        </div>
      )}
      {type === 'move' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Order ID">
            <Input value={d.ref} onChange={(e) => set('ref', e.target.value)} list="planning-lineKey" className="min-h-[44px]" autoComplete="off" />
          </Field>
          {machineSelect('toMachineKey', 'To machine')}
        </div>
      )}
      {(type === 'priority' || type === 'exclude') && refField(type === 'priority')}
      {type === 'material' && (
        <>
          {refField(false)}
          <Field label="Arrives">
            <Input type="date" value={d.day} onChange={(e) => set('day', e.target.value)} className="min-h-[44px]" />
          </Field>
        </>
      )}
      {type === 'due' && (
        <>
          {refField(false)}
          <Field label="Due">
            <Input type="date" value={d.dueDate} onChange={(e) => set('dueDate', e.target.value)} className="min-h-[44px]" />
          </Field>
        </>
      )}
      {type === 'not-before' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Order ID">
            <Input value={d.ref} onChange={(e) => set('ref', e.target.value)} list="planning-lineKey" className="min-h-[44px]" autoComplete="off" />
          </Field>
          <Field label="Not before">
            <Input type="datetime-local" value={d.at} onChange={(e) => set('at', e.target.value)} className="min-h-[44px]" />
          </Field>
        </div>
      )}
      {type === 'quantity' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Order ID">
            <Input value={d.ref} onChange={(e) => set('ref', e.target.value)} list="planning-lineKey" className="min-h-[44px]" autoComplete="off" />
          </Field>
          <Field label="Pieces left">
            <Input type="number" min={0} value={d.remainingQty} onChange={(e) => set('remainingQty', e.target.value)} className="min-h-[44px]" />
          </Field>
        </div>
      )}
      {type === 'add-order' && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Order number">
            <Input value={d.orderNumber} onChange={(e) => set('orderNumber', e.target.value)} className="min-h-[44px]" />
          </Field>
          <Field label="Item">
            <Input value={d.item} onChange={(e) => set('item', e.target.value)} className="min-h-[44px]" />
          </Field>
          <Field label="Customer">
            <Input value={d.customer} onChange={(e) => set('customer', e.target.value)} list="planning-customer" className="min-h-[44px]" />
          </Field>
          {machineSelect('machineKey', 'Machine')}
          <Field label="Pieces">
            <Input type="number" min={1} value={d.qty} onChange={(e) => set('qty', e.target.value)} className="min-h-[44px]" />
          </Field>
          <Field label="Hours on the machine">
            <Input type="number" min={0.1} step={0.5} value={d.hours} onChange={(e) => set('hours', e.target.value)} className="min-h-[44px]" />
          </Field>
          <Field label="Due">
            <Input type="date" value={d.dueDate} onChange={(e) => set('dueDate', e.target.value)} className="min-h-[44px]" />
          </Field>
        </div>
      )}
      <Field label="Why (optional)">
        <Input value={d.note} maxLength={300} onChange={(e) => set('note', e.target.value)} className="min-h-[44px]" placeholder="A breakdown, a customer’s call…" />
      </Field>
      <datalist id="planning-lineKey">
        {lineKeys.map((k) => (
          <option key={k} value={k} />
        ))}
      </datalist>
      <datalist id="planning-orderNumber">
        {orders.map((k) => (
          <option key={k} value={k} />
        ))}
      </datalist>
      <datalist id="planning-customer">
        {customers.map((k) => (
          <option key={k} value={k} />
        ))}
      </datalist>
      {problem && (
        <p role="alert" className="text-sm font-semibold text-danger-700 dark:text-danger-400">
          {problem}
        </p>
      )}
      <Button type="submit" variant="primary" className="min-h-[44px]" disabled={pending}>
        <Plus className="h-4 w-4" /> Add the change
      </Button>
    </form>
  )
}
