// ============================================================================
// §25 — Late lines: the lines a plan finishes after their due day, the most
// late first, with their customer and machine, and the lines it could not
// place at all. Every column sorts and filters from its header; the rows are
// taken to Excel as filtered.
// ============================================================================

import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { AlarmClock, Download } from 'lucide-react'
import { Button, EmptyState } from '@/components/ui'
import { Segmented } from '@/components/ui/PageShell'
import { usePersistedState } from '@/lib/usePersistedState'
import { downloadWorkbook } from '@/lib/xlsxWrite'
import { formatWall, type PlanOperation } from '@qc/shared/planning'
import { usePlan } from '@/services/planning'
import { DataGrid, ErrorNote, Loading, PartFrame, PlanPicker, SearchBox, useGrid, usePreferredPlanId, type GridColumn } from './common'
import { FLAG_NAME, dayLabel, qtyLabel, tonnes, wallLabel } from './format'

/** An order as one delivery: late when its last line is. */
interface LateOrder {
  orderNumber: string
  customer: string
  lines: number
  lateLines: number
  unplaced: number
  /** The earliest due day of its lines. */
  dueDate: string | null
  /** When its last line finishes; null when one could not be placed. */
  completes: number | null
  lateDays: number
  weightKg: number
  /** The machine its last line finishes on. */
  lastMachineKey: string
}

export function LateSection() {
  const [params, setParams] = useSearchParams()
  const preferred = usePreferredPlanId()
  const planId = params.get('plan') ?? preferred
  const { data, error, isLoading, refetch } = usePlan(planId)
  const [q, setQ] = useState('')
  const machines = useMemo(() => new Map((data?.machines ?? []).map((m) => [m.key, m])), [data])
  const machineName = (o: PlanOperation) => machines.get(o.machineKey)?.name ?? o.machineKey
  const needle = q.trim().toLowerCase()
  const rows = useMemo(
    () =>
      (data?.operations ?? [])
        .filter((o) => o.lateDays > 0 || o.start === null)
        .filter((o) => !needle || [o.customer, o.orderNumber, o.item, o.lineKey, machines.get(o.machineKey)?.name ?? ''].some((x) => x.toLowerCase().includes(needle)))
        .sort((a, b) => (b.start === null ? 1e9 : b.lateDays) - (a.start === null ? 1e9 : a.lateDays)),
    [data, needle, machines],
  )
  const columns = useMemo<GridColumn<PlanOperation>[]>(
    () => [
      {
        key: 'order',
        label: 'Order',
        value: (o) => o.orderNumber,
        cell: (o) => <span className="font-semibold">{o.orderNumber}</span>,
      },
      {
        key: 'item',
        label: 'Item',
        value: (o) => o.item,
        noValues: true,
        cell: (o) => (
          <span className="block max-w-[260px] truncate" title={o.item}>
            {o.item}
          </span>
        ),
      },
      {
        key: 'line',
        label: 'Order ID',
        value: (o) => o.lineKey,
        noValues: true,
        cell: (o) => <span className="text-muted">{o.lineKey}</span>,
      },
      {
        key: 'customer',
        label: 'Customer',
        value: (o) => o.customer,
        cell: (o) => o.customer || '—',
      },
      {
        key: 'machine',
        label: 'Machine',
        value: machineName,
        cell: machineName,
      },
      {
        key: 'due',
        label: 'Due',
        value: (o) => dayLabel(o.dueDate),
        sortValue: (o) => o.dueDate,
        cell: (o) => dayLabel(o.dueDate),
        className: 'whitespace-nowrap',
      },
      {
        key: 'finish',
        label: 'Finishes',
        value: (o) => (o.end === null ? 'Not placed' : dayLabel(formatWall(o.end).slice(0, 10))),
        sortValue: (o) => o.end,
        cell: (o) => (o.end === null ? <span className="font-semibold text-danger-700 dark:text-danger-400">Not placed</span> : wallLabel(o.end)),
        className: 'whitespace-nowrap',
      },
      {
        key: 'late',
        label: 'Days late',
        numeric: true,
        right: true,
        value: (o) => (o.start === null ? '' : String(o.lateDays)),
        sortValue: (o) => (o.start === null ? null : o.lateDays),
        cell: (o) => (o.start === null ? '—' : <span className="font-semibold text-danger-700 dark:text-danger-400">{o.lateDays} d</span>),
      },
      {
        key: 'qty',
        label: 'Pieces left',
        numeric: true,
        right: true,
        value: (o) => String(Math.round(o.qty)),
        sortValue: (o) => o.qty,
        cell: (o) => qtyLabel(o.qty),
      },
      {
        key: 'weight',
        label: 'Weight',
        numeric: true,
        right: true,
        value: (o) => (o.weightKg === null ? '' : String(Math.round(o.weightKg))),
        sortValue: (o) => o.weightKg,
        cell: (o) => tonnes(o.weightKg),
      },
      {
        key: 'why',
        label: 'Why',
        value: (o) => o.flags.map((f) => FLAG_NAME[f]).join('; '),
        noValues: true,
        cell: (o) => (
          <span className="block max-w-[280px] truncate text-xs text-muted" title={o.flags.map((f) => FLAG_NAME[f]).join('; ')}>
            {o.flags.map((f) => FLAG_NAME[f]).join('; ')}
          </span>
        ),
      },
    ],
    [machines],
  )
  const view = useGrid(rows, columns)
  const [by, setBy] = usePersistedState<'lines' | 'orders'>('qc-planning:late-by', 'lines')
  // Orders delivered whole: every order with a late or unplaced line, by its last line.
  const orderRows = useMemo(() => {
    const m = new Map<string, LateOrder & { lastEnd: number }>()
    for (const o of data?.operations ?? []) {
      const key = o.orderNumber.trim().toLowerCase()
      let r = m.get(key)
      if (!r) m.set(key, (r = { orderNumber: o.orderNumber, customer: o.customer, lines: 0, lateLines: 0, unplaced: 0, dueDate: null, completes: null, lateDays: 0, weightKg: 0, lastMachineKey: o.machineKey, lastEnd: -1 }))
      r.lines++
      if (o.lateDays > 0) r.lateLines++
      if (o.end === null) r.unplaced++
      if (o.dueDate && (!r.dueDate || o.dueDate < r.dueDate)) r.dueDate = o.dueDate
      r.lateDays = Math.max(r.lateDays, o.lateDays)
      r.weightKg += o.weightKg ?? 0
      if (o.end !== null && o.end > r.lastEnd) {
        r.lastEnd = o.end
        r.lastMachineKey = o.machineKey
      }
    }
    return [...m.values()]
      .filter((r) => r.lateLines > 0 || r.unplaced > 0)
      .filter((r) => !needle || [r.customer, r.orderNumber, machines.get(r.lastMachineKey)?.name ?? ''].some((x) => x.toLowerCase().includes(needle)))
      .map(({ lastEnd, ...r }) => ({ ...r, completes: r.unplaced > 0 ? null : lastEnd }))
      .sort((a, b) => (b.completes === null ? 1e9 : b.lateDays) - (a.completes === null ? 1e9 : a.lateDays) || b.weightKg - a.weightKg)
  }, [data, needle, machines])
  const orderColumns = useMemo<GridColumn<LateOrder>[]>(
    () => [
      { key: 'order', label: 'Order', value: (r) => r.orderNumber, cell: (r) => <span className="font-semibold">{r.orderNumber}</span>, className: 'whitespace-nowrap' },
      { key: 'customer', label: 'Customer', value: (r) => r.customer, cell: (r) => r.customer || '—' },
      { key: 'lines', label: 'Lines', numeric: true, right: true, value: (r) => String(r.lines), sortValue: (r) => r.lines, cell: (r) => r.lines.toLocaleString() },
      { key: 'lateLines', label: 'Late lines', numeric: true, right: true, value: (r) => String(r.lateLines), sortValue: (r) => r.lateLines, cell: (r) => r.lateLines.toLocaleString() },
      { key: 'due', label: 'Due', value: (r) => dayLabel(r.dueDate), sortValue: (r) => r.dueDate, cell: (r) => dayLabel(r.dueDate), className: 'whitespace-nowrap' },
      {
        key: 'completes',
        label: 'Delivered whole',
        value: (r) => (r.completes === null ? 'Not placed' : wallLabel(r.completes)),
        sortValue: (r) => r.completes,
        noValues: true,
        className: 'whitespace-nowrap',
        cell: (r) => (r.completes === null ? <span className="font-semibold text-danger-700 dark:text-danger-400">{r.unplaced} not placed</span> : wallLabel(r.completes)),
      },
      { key: 'lastMachine', label: 'Last line on', value: (r) => machines.get(r.lastMachineKey)?.name ?? r.lastMachineKey, cell: (r) => machines.get(r.lastMachineKey)?.name ?? r.lastMachineKey },
      {
        key: 'late',
        label: 'Days late',
        numeric: true,
        right: true,
        value: (r) => String(r.lateDays),
        sortValue: (r) => r.lateDays,
        cell: (r) => (r.lateDays > 0 ? <span className="font-semibold text-danger-700 dark:text-danger-400">{r.lateDays} d</span> : '—'),
      },
      { key: 'weight', label: 'Weight', numeric: true, right: true, value: (r) => String(Math.round(r.weightKg)), sortValue: (r) => r.weightKg, cell: (r) => tonnes(r.weightKg) },
    ],
    [machines],
  )
  const orderView = useGrid(orderRows, orderColumns)
  const exportIt = () =>
    downloadWorkbook('Late lines.xlsx', [
      {
        name: 'Late lines',
        header: ['Order ID', 'Order', 'Item', 'Customer', 'Machine', 'Due', 'Finishes', 'Days late', 'Pieces left', 'Weight kg', 'Why'],
        rows: view.rows.map((o) => [
          o.lineKey,
          o.orderNumber,
          o.item,
          o.customer,
          machineName(o),
          o.dueDate,
          o.end === null ? 'Not placed' : formatWall(o.end),
          o.lateDays,
          o.qty,
          o.weightKg,
          o.flags.map((f) => FLAG_NAME[f]).join('; '),
        ]),
      },
    ])
  return (
    <PartFrame
      toolbar={
        <>
          <PlanPicker
            value={planId}
            onChange={(id) => {
              const next = new URLSearchParams(params)
              next.set('plan', id)
              setParams(next, { replace: true })
            }}
          />
          <Segmented
            label="By"
            value={by}
            onChange={setBy}
            options={[
              { value: 'lines', label: 'Lines' },
              { value: 'orders', label: 'Orders delivered whole' },
            ]}
          />
          <SearchBox value={q} onChange={setQ} placeholder="Customer, order, item, machine" label="Find a customer, order, item or machine" />
          <span className="hidden text-13 text-muted xl:inline">
            {by === 'lines' ? 'Finishing after the due day ends (08:00 the next morning), the latest first; and the lines the plan could not place.' : 'Each order as one delivery: done when its last line is, late by that line.'}
          </span>
          <span className="flex-1" />
          <Button className="min-h-[40px]" onClick={exportIt} disabled={by !== 'lines' || view.rows.length === 0}>
            <Download className="h-4 w-4" /> Excel
          </Button>
        </>
      }
    >
      {isLoading ? (
        <Loading />
      ) : error || !data ? (
        <div className="p-4">
          <ErrorNote error={error} retry={() => void refetch()} />
        </div>
      ) : by === 'orders' ? (
        <DataGrid
          view={orderView}
          columns={orderColumns}
          rowKey={(r) => r.orderNumber}
          total={orderRows.length}
          noun="late orders"
          caption="The orders delivered late as a whole"
          empty={<EmptyState icon={<AlarmClock className="h-10 w-10" />} title="No late order" hint={needle || orderView.active > 0 ? 'None matches the search or the filters.' : 'Every order of this plan is delivered whole by its due day.'} />}
        />
      ) : (
        <DataGrid
          view={view}
          columns={columns}
          rowKey={(o) => o.lineId}
          total={rows.length}
          noun="late lines"
          caption="The late lines of the plan"
          empty={
            <EmptyState
              icon={<AlarmClock className="h-10 w-10" />}
              title="No late line"
              hint={needle || view.active > 0 ? 'None matches the search or the filters.' : 'Every line of this plan finishes by its due day.'}
            />
          }
        />
      )}
    </PartFrame>
  )
}
