// ============================================================================
// §25 — Material: each line's raw material against when the automatic plan
// would start it — received, part received, promised in time, promised too
// late, or needed with no promise day — so the buyer chases the ones that
// hold a machine back first.
// ============================================================================

import { useState } from 'react'
import type { MaterialState } from '@qc/shared/planning'
import { Badge, type BadgeTone } from '@/components/ui'
import { cn } from '@/lib/utils'
import { useMaterials } from '@/services/planning'
import { ErrorNote, Loading, SectionCard } from './common'
import { dayLabel, qtyLabel, wallLabel } from './format'

const STATES: { id: MaterialState; name: string; tone: BadgeTone; help: string }[] = [
  { id: 'promised-late', name: 'Promised too late', tone: 'red', help: 'Promised after the plan would start the line.' },
  { id: 'no-promise', name: 'No promise day', tone: 'amber', help: 'Needed, not received, and no day promised.' },
  { id: 'partial', name: 'Part received', tone: 'amber', help: 'Some received, less than the line needs.' },
  { id: 'promised-in-time', name: 'Promised in time', tone: 'blue', help: 'Promised by the day the plan starts the line.' },
  { id: 'received', name: 'Received', tone: 'green', help: 'All of it received.' },
]

export function MaterialsSection() {
  const { data, error, isLoading, refetch } = useMaterials()
  const [state, setState] = useState<MaterialState | 'all'>('all')
  if (isLoading) return <Loading what="Reading the material" />
  if (error || !data) return <ErrorNote error={error} retry={() => void refetch()} />
  const rows = data.rows.filter((r) => state === 'all' || r.state === state)
  return (
    <SectionCard title="Raw material" hint={`Each open line’s raw material, from the order sheet, against when the automatic plan would start it. ${data.counts['no-data']} lines carry no material figures and are left out.`}>
      <div role="group" aria-label="Show" className="mb-4 flex flex-wrap gap-2">
        <button type="button" aria-pressed={state === 'all'} onClick={() => setState('all')} className={cn('btn-secondary min-h-[40px] px-3', state === 'all' && 'ring-2 ring-brand-500')}>
          All ({data.rows.length})
        </button>
        {STATES.map((s) => (
          <button key={s.id} type="button" aria-pressed={state === s.id} onClick={() => setState(s.id)} data-tip={s.help} className={cn('btn-secondary min-h-[40px] px-3', state === s.id && 'ring-2 ring-brand-500')}>
            {s.name} ({data.counts[s.id]})
          </button>
        ))}
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">No line here.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="text-left text-xs text-muted">
              <tr className="border-b border-slate-200 dark:border-slate-700">
                <th scope="col" className="py-2 pr-3 font-semibold">Line</th>
                <th scope="col" className="py-2 pr-3 font-semibold">Customer</th>
                <th scope="col" className="py-2 pr-3 font-semibold">Needed / received</th>
                <th scope="col" className="py-2 pr-3 font-semibold">Promised</th>
                <th scope="col" className="py-2 pr-3 font-semibold">Plan starts it</th>
                <th scope="col" className="py-2 font-semibold">State</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {rows.slice(0, 500).map((r) => {
                const s = STATES.find((x) => x.id === r.state)!
                return (
                  <tr key={r.lineKey}>
                    <td className="py-2 pr-3">
                      <span className="block font-semibold">{r.orderNumber}</span>
                      <span className="block max-w-[260px] truncate text-xs text-muted">
                        {r.item} · {r.lineKey}
                      </span>
                    </td>
                    <td className="py-2 pr-3">{r.customer || '—'}</td>
                    <td className="whitespace-nowrap py-2 pr-3 tabular-nums">
                      {qtyLabel(r.rawMaterialQty)} / {qtyLabel(r.rmReceivedQty)}
                    </td>
                    <td className="whitespace-nowrap py-2 pr-3">{dayLabel(r.rmPromiseDate)}</td>
                    <td className="whitespace-nowrap py-2 pr-3">{wallLabel(r.plannedStart)}</td>
                    <td className="py-2">
                      <Badge tone={s.tone}>{s.name}</Badge>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  )
}
