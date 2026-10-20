// ============================================================================
// §25 — Late lines: the lines a plan finishes after their due day, the most
// late first, with their customer and machine, and the lines it could not
// place at all; filtered by customer or machine, taken to Excel.
// ============================================================================

import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { AlarmClock, Download, Search } from 'lucide-react'
import { Button, EmptyState, Input } from '@/components/ui'
import { downloadWorkbook } from '@/lib/xlsxWrite'
import { formatWall } from '@qc/shared/planning'
import { usePlan } from '@/services/planning'
import { ErrorNote, Loading, PlanPicker, SectionCard, usePreferredPlanId } from './common'
import { FLAG_NAME, dayLabel, qtyLabel, tonnes, wallLabel } from './format'

export function LateSection() {
  const [params, setParams] = useSearchParams()
  const preferred = usePreferredPlanId()
  const planId = params.get('plan') ?? preferred
  const { data, error, isLoading, refetch } = usePlan(planId)
  const [q, setQ] = useState('')
  const machines = useMemo(() => new Map((data?.machines ?? []).map((m) => [m.key, m])), [data])
  const needle = q.trim().toLowerCase()
  const rows = useMemo(
    () =>
      (data?.operations ?? [])
        .filter((o) => o.lateDays > 0 || o.start === null)
        .filter((o) => !needle || [o.customer, o.orderNumber, o.item, o.lineKey, machines.get(o.machineKey)?.name ?? ''].some((x) => x.toLowerCase().includes(needle)))
        .sort((a, b) => (b.start === null ? 1e9 : b.lateDays) - (a.start === null ? 1e9 : a.lateDays)),
    [data, needle, machines],
  )
  const exportIt = () =>
    downloadWorkbook('Late lines.xlsx', [
      {
        name: 'Late lines',
        header: ['Order ID', 'Order', 'Item', 'Customer', 'Machine', 'Due', 'Finishes', 'Days late', 'Pieces left', 'Weight kg', 'Why'],
        rows: rows.map((o) => [o.lineKey, o.orderNumber, o.item, o.customer, machines.get(o.machineKey)?.name ?? o.machineKey, o.dueDate, o.end === null ? 'Not placed' : formatWall(o.end), o.lateDays, o.qty, o.weightKg, o.flags.map((f) => FLAG_NAME[f]).join('; ')]),
      },
    ])
  return (
    <SectionCard
      title="Late lines"
      hint="The lines this plan finishes after their due day ends (08:00 the next morning), the latest first; and the lines it could not place."
      actions={
        <>
          <PlanPicker
            value={planId}
            onChange={(id) => {
              const next = new URLSearchParams(params)
              next.set('plan', id)
              setParams(next, { replace: true })
            }}
          />
          <Button className="min-h-[44px]" onClick={exportIt} disabled={rows.length === 0}>
            <Download className="h-4 w-4" /> Excel
          </Button>
        </>
      }
    >
      <label className="relative mb-3 block max-w-sm">
        <span className="sr-only">Find a customer, order, item or machine</span>
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Customer, order, item, machine" className="min-h-[44px] pl-9" />
      </label>
      {isLoading && <Loading />}
      {error && <ErrorNote error={error} retry={() => void refetch()} />}
      {data && rows.length === 0 && <EmptyState icon={<AlarmClock className="h-10 w-10" />} title="No late line" hint={needle ? 'None matches the search.' : 'Every line of this plan finishes by its due day.'} />}
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="text-left text-xs text-muted">
              <tr className="border-b border-slate-200 dark:border-slate-700">
                <th scope="col" className="py-2 pr-3 font-semibold">Line</th>
                <th scope="col" className="py-2 pr-3 font-semibold">Customer</th>
                <th scope="col" className="py-2 pr-3 font-semibold">Machine</th>
                <th scope="col" className="py-2 pr-3 font-semibold">Due</th>
                <th scope="col" className="py-2 pr-3 font-semibold">Finishes</th>
                <th scope="col" className="py-2 pr-3 font-semibold">Late</th>
                <th scope="col" className="py-2 font-semibold">Left</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {rows.slice(0, 500).map((o) => (
                <tr key={o.lineId} className="align-top">
                  <td className="py-2 pr-3">
                    <span className="block font-semibold">{o.orderNumber}</span>
                    <span className="block max-w-[260px] truncate text-xs text-muted">
                      {o.item} · {o.lineKey}
                    </span>
                  </td>
                  <td className="py-2 pr-3">{o.customer || '—'}</td>
                  <td className="py-2 pr-3">{machines.get(o.machineKey)?.name ?? o.machineKey}</td>
                  <td className="whitespace-nowrap py-2 pr-3">{dayLabel(o.dueDate)}</td>
                  <td className="whitespace-nowrap py-2 pr-3">{o.end === null ? <span className="font-semibold text-danger-700 dark:text-danger-400">Not placed</span> : wallLabel(o.end)}</td>
                  <td className="whitespace-nowrap py-2 pr-3 font-semibold tabular-nums text-danger-700 dark:text-danger-400">{o.start === null ? '—' : `${o.lateDays} d`}</td>
                  <td className="whitespace-nowrap py-2 tabular-nums">
                    {qtyLabel(o.qty)} pcs{o.weightKg ? `, ${tonnes(o.weightKg)}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > 500 && <p className="mt-2 text-xs text-muted">The first 500 of {rows.length}; Excel has them all.</p>}
        </div>
      )}
    </SectionCard>
  )
}
