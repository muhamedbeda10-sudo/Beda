// ============================================================================
// §25 — Material: each line's raw material against when the automatic plan
// would start it — received, part received, promised in time, promised too
// late, or needed with no promise day — so the buyer chases the ones that
// hold a machine back first. A state picker in the toolbar, every column
// filterable from its header.
// ============================================================================

import { useMemo, useState } from 'react'
import type { MaterialRow, MaterialState } from '@qc/shared/planning'
import { Badge, EmptyState, type BadgeTone } from '@/components/ui'
import { FilterSelect } from '@/components/ui/PageShell'
import { useMaterials } from '@/services/planning'
import { DataGrid, ErrorNote, Loading, PartFrame, SearchBox, useGrid, type GridColumn } from './common'
import { dayLabel, qtyLabel, wallLabel } from './format'

const STATES: {
  id: MaterialState
  name: string
  tone: BadgeTone
  help: string
}[] = [
  {
    id: 'promised-late',
    name: 'Promised too late',
    tone: 'red',
    help: 'Promised after the plan would start the line.',
  },
  {
    id: 'no-promise',
    name: 'No promise day',
    tone: 'amber',
    help: 'Needed, not received, and no day promised.',
  },
  {
    id: 'partial',
    name: 'Part received',
    tone: 'amber',
    help: 'Some received, less than the line needs.',
  },
  {
    id: 'promised-in-time',
    name: 'Promised in time',
    tone: 'blue',
    help: 'Promised by the day the plan starts the line.',
  },
  {
    id: 'received',
    name: 'Received',
    tone: 'green',
    help: 'All of it received.',
  },
]
const stateOf = (r: MaterialRow) => STATES.find((x) => x.id === r.state)

export function MaterialsSection() {
  const { data, error, isLoading, refetch } = useMaterials()
  const [state, setState] = useState<MaterialState | 'all'>('all')
  const [q, setQ] = useState('')
  const needle = q.trim().toLowerCase()
  const rows = useMemo(
    () => (data?.rows ?? []).filter((r) => (state === 'all' || r.state === state) && (!needle || [r.customer, r.orderNumber, r.item, r.lineKey].some((x) => x.toLowerCase().includes(needle)))),
    [data, state, needle],
  )
  const columns = useMemo<GridColumn<MaterialRow>[]>(
    () => [
      {
        key: 'order',
        className: 'whitespace-nowrap',
        label: 'Order',
        value: (r) => r.orderNumber,
        cell: (r) => <span className="font-semibold">{r.orderNumber}</span>,
      },
      {
        key: 'item',
        label: 'Item',
        value: (r) => r.item,
        noValues: true,
        cell: (r) => (
          <span className="block max-w-[260px] truncate" title={r.item}>
            {r.item}
          </span>
        ),
      },
      {
        key: 'line',
        label: 'Order ID',
        value: (r) => r.lineKey,
        noValues: true,
        cell: (r) => <span className="text-muted">{r.lineKey}</span>,
      },
      {
        key: 'customer',
        label: 'Customer',
        value: (r) => r.customer,
        cell: (r) => r.customer || '—',
      },
      {
        key: 'needed',
        label: 'Needed',
        numeric: true,
        right: true,
        value: (r) => (r.rawMaterialQty === null ? '' : String(Math.round(r.rawMaterialQty))),
        sortValue: (r) => r.rawMaterialQty,
        cell: (r) => qtyLabel(r.rawMaterialQty),
      },
      {
        key: 'received',
        label: 'Received',
        numeric: true,
        right: true,
        value: (r) => (r.rmReceivedQty === null ? '' : String(Math.round(r.rmReceivedQty))),
        sortValue: (r) => r.rmReceivedQty,
        cell: (r) => qtyLabel(r.rmReceivedQty),
      },
      {
        key: 'promised',
        label: 'Promised',
        value: (r) => dayLabel(r.rmPromiseDate),
        sortValue: (r) => r.rmPromiseDate,
        cell: (r) => dayLabel(r.rmPromiseDate),
        className: 'whitespace-nowrap',
      },
      {
        key: 'start',
        label: 'Plan starts it',
        value: (r) => wallLabel(r.plannedStart),
        sortValue: (r) => r.plannedStart,
        noValues: true,
        cell: (r) => wallLabel(r.plannedStart),
        className: 'whitespace-nowrap',
      },
      {
        key: 'due',
        label: 'Due',
        value: (r) => dayLabel(r.dueDate),
        sortValue: (r) => r.dueDate,
        cell: (r) => dayLabel(r.dueDate),
        className: 'whitespace-nowrap',
      },
      {
        key: 'state',
        label: 'State',
        value: (r) => stateOf(r)?.name ?? r.state,
        cell: (r) => {
          const s = stateOf(r)
          return s ? (
            <Badge tone={s.tone} tip={s.help}>
              {s.name}
            </Badge>
          ) : (
            r.state
          )
        },
      },
    ],
    [],
  )
  const view = useGrid(rows, columns)
  return (
    <PartFrame
      toolbar={
        <>
          <FilterSelect label="State" value={state} onChange={(v) => setState(v as MaterialState | 'all')}>
            <option value="all">Every state ({data?.rows.length ?? 0})</option>
            {STATES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({data?.counts[s.id] ?? 0})
              </option>
            ))}
          </FilterSelect>
          <SearchBox value={q} onChange={setQ} placeholder="Customer, order, item" label="Find a customer, order or item" />
          <span className="hidden text-13 text-muted lg:inline">
            Each open line’s raw material, from the order sheet, against when the automatic plan would start it.
            {data ? ` ${data.counts['no-data'].toLocaleString()} lines carry no material figures and are left out.` : ''}
          </span>
        </>
      }
    >
      {isLoading ? (
        <Loading what="Reading the material" />
      ) : error || !data ? (
        <div className="p-4">
          <ErrorNote error={error} retry={() => void refetch()} />
        </div>
      ) : (
        <DataGrid
          view={view}
          columns={columns}
          rowKey={(r) => r.lineKey}
          total={rows.length}
          noun="lines"
          caption="Raw material by line"
          empty={<EmptyState title="No line here" hint="None matches the state, the search or the filters." />}
        />
      )}
    </PartFrame>
  )
}
