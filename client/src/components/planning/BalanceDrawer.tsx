// ============================================================================
// §25 — balancing the machines, from the Load part: the machines loaded past
// their hours in the coming weeks, the moves that lighten them (each line
// to another machine of its process that has room, by its learnt route),
// and what the plan gains; kept as a scenario in one press.
// ============================================================================

import { useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowRightLeft, Save } from 'lucide-react'
import type { BalanceMove, BalanceResponse } from '@qc/shared/planning'
import { Button, Drawer, EmptyState } from '@/components/ui'
import { useAuth } from '@/store/AuthContext'
import { useBalance, useCreatePlan } from '@/services/planning'
import { DataGrid, ErrorNote, Figure, Loading, useGrid, type GridColumn } from './common'
import { hoursLabel, pctLabel, tonnes } from './format'

export function BalanceDrawer({ weeks, nameOf, onClose }: { weeks: number; nameOf: (k: string) => string; onClose: () => void }) {
  const { can } = useAuth()
  const navigate = useNavigate()
  const balance = useBalance()
  const create = useCreatePlan()
  useEffect(() => {
    balance.mutate({ weeks })
    // Once, when opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const b = balance.data
  const columns = useMemo<GridColumn<BalanceMove>[]>(
    () => [
      { key: 'order', label: 'Order', value: (m) => m.orderNumber, cell: (m) => <span className="font-semibold">{m.orderNumber}</span>, className: 'whitespace-nowrap' },
      { key: 'item', label: 'Item', value: (m) => m.item, noValues: true, cell: (m) => <span className="block max-w-[220px] truncate" title={m.item}>{m.item}</span> },
      { key: 'customer', label: 'Customer', value: (m) => m.customer, cell: (m) => m.customer || '—' },
      { key: 'from', label: 'From', value: (m) => nameOf(m.fromMachineKey), cell: (m) => nameOf(m.fromMachineKey) },
      { key: 'to', label: 'To', value: (m) => nameOf(m.toMachineKey), cell: (m) => <span className="font-semibold">{nameOf(m.toMachineKey)}</span> },
      { key: 'hours', label: 'Hours', numeric: true, right: true, value: (m) => String(m.hours), sortValue: (m) => m.hours, cell: (m) => hoursLabel(m.hours) },
    ],
    [nameOf],
  )
  const view = useGrid(b?.moves ?? [], columns)
  const keep = async (r: BalanceResponse) => {
    const made = await create.mutateAsync({ kind: 'scenario', name: `Balance the machines: ${r.moves.length} moves`.slice(0, 120), events: r.events })
    navigate(`/planning/simulator?plan=${encodeURIComponent(made.plan.id)}`)
  }
  return (
    <Drawer open onClose={onClose} title="Suggest moves" subtitle={`Lines moved from machines loaded past their hours over the next ${weeks} weeks to machines of the same process with room`} icon={<ArrowRightLeft className="h-5 w-5" />}>
      {balance.isPending ? (
        <Loading what="Trying the moves" />
      ) : balance.error ? (
        <ErrorNote error={balance.error} />
      ) : b ? (
        <div className="flex h-full min-h-0 flex-col gap-3 text-sm">
          <div className="grid grid-cols-2 gap-2">
            <Figure label="Late lines" value={`${b.before.late.toLocaleString()} → ${b.after.late.toLocaleString()}`} tone={b.after.late < b.before.late ? 'success' : undefined} />
            <Figure label="On time" value={`${pctLabel(b.before.onTimePct)} → ${pctLabel(b.after.onTimePct)}`} />
            <Figure label="Late weight" value={`${tonnes(b.before.lateWeightKg)} → ${tonnes(b.after.lateWeightKg)}`} />
            <Figure label="Still overloaded" value={b.stillOverloaded.length} tone={b.stillOverloaded.length > 0 ? 'warning' : 'success'} sub={b.stillOverloaded.map((m) => `${m.machineName} ${m.loadPct}%`).join(', ') || 'none'} />
          </div>
          <p className="text-13 text-muted">
            Loaded past their hours before: {b.overloaded.length === 0 ? 'none' : b.overloaded.map((m) => `${m.machineName} (${m.loadPct}%)`).join(', ')}. On {b.baseName}.
          </p>
          {b.warnings.map((w) => (
            <p key={w} className="text-13 text-warning-800 dark:text-warning-400">
              {w}
            </p>
          ))}
          <div className="flex min-h-[16rem] flex-1 flex-col overflow-hidden rounded-xl ring-1 ring-inset ring-slate-200 dark:ring-slate-700">
            <DataGrid view={view} columns={columns} rowKey={(m) => m.lineKey} total={b.moves.length} noun="moves" caption="The moves" empty={<EmptyState title="No move" hint="No line could be moved to a machine with room." />} />
          </div>
          {create.error && <ErrorNote error={create.error} />}
          {b.moves.length > 0 && can('edit-planning') && (
            <Button variant="primary" className="min-h-[44px]" disabled={create.isPending} onClick={() => void keep(b)}>
              <Save className="h-4 w-4" /> Keep as a scenario
            </Button>
          )}
        </div>
      ) : null}
    </Drawer>
  )
}
