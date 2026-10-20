// ============================================================================
// §25 — Plan against actual: for each day, what the plan published then had
// each machine make, beside what the production record says it made; the
// adherence of each machine (what it made of what was planned, day by day,
// never more than the plan); and how the ERP's own plan fared.
// ============================================================================

import { Fragment, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Target } from 'lucide-react'
import { addDays } from '@qc/shared/planning'
import { EmptyState, Field, Input } from '@/components/ui'
import { cn } from '@/lib/utils'
import { useActual } from '@/services/planning'
import { useAuth } from '@/store/AuthContext'
import { calendarDay } from '@qc/shared/rules'
import { ErrorNote, Figure, Loading, Meter, SectionCard } from './common'
import { dayLabel, qtyLabel } from './format'

export function ActualSection() {
  const { factoryTimeZone } = useAuth()
  const today = calendarDay(new Date(), factoryTimeZone)
  const [from, setFrom] = useState(addDays(today, -13))
  const [to, setTo] = useState(today)
  const valid = from <= to
  const { data, error, isLoading, refetch } = useActual(valid ? from : to, to)
  const [open, setOpen] = useState<string | null>(null)
  const byMachine = useMemo(() => {
    const m = new Map<string, NonNullable<typeof data>['rows']>()
    for (const r of data?.rows ?? []) {
      const l = m.get(r.machineKey)
      if (l) l.push(r)
      else m.set(r.machineKey, [r])
    }
    return m
  }, [data])
  const totals = useMemo(() => {
    const planned = (data?.machines ?? []).reduce((s, m) => s + m.plannedQty, 0)
    const actual = (data?.machines ?? []).reduce((s, m) => s + m.actualQty, 0)
    const met = (data?.rows ?? []).reduce((s, r) => s + Math.min(r.plannedQty, r.actualQty), 0)
    return { planned, actual, adherence: planned > 0 ? (met / planned) * 100 : null }
  }, [data])
  return (
    <SectionCard title="Plan against actual" hint="Each day’s published plan beside what the production record says each machine made that day.">
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="From">
          <Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="min-h-[44px]" />
        </Field>
        <Field label="To">
          <Input type="date" value={to} max={today} onChange={(e) => setTo(e.target.value)} className="min-h-[44px]" />
        </Field>
        <p className="pb-3 text-13 text-muted">At most 93 days at once.</p>
      </div>
      {isLoading && <Loading what="Reading the plans and the record" />}
      {error && <ErrorNote error={error} retry={() => void refetch()} />}
      {data && (
        <div className="space-y-4">
          {data.plans.length === 0 && (
            <EmptyState
              icon={<Target className="h-10 w-10" />}
              title="No plan was published in these days"
              hint="Publish a plan and each day after is measured against it. Until then, only what was made shows."
              action={
                <Link to="/planning/plans" className="btn-secondary min-h-[44px]">
                  Go to Plans
                </Link>
              }
            />
          )}
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            <Figure label="Planned pieces" value={qtyLabel(totals.planned)} />
            <Figure label="Made (production record)" value={qtyLabel(totals.actual)} />
            <Figure label="Adherence" value={totals.adherence === null ? '—' : `${Math.round(totals.adherence)}%`} tone={totals.adherence !== null && totals.adherence < 80 ? 'warning' : undefined} sub="made of what was planned, day by day" />
            <Figure label="ERP lines due to finish" value={data.erp.lines.toLocaleString()} sub={`${data.erp.finishedOnPlan} on plan, ${data.erp.late} late`} />
          </div>
          {data.plans.length > 0 && (
            <p className="text-13 text-muted">
              Plans read: {data.plans.map((p) => `${p.name} (published ${p.publishedAt.slice(0, 10)})`).join(', ')}.
            </p>
          )}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="text-left text-xs text-muted">
                <tr className="border-b border-slate-200 dark:border-slate-700">
                  <th scope="col" className="py-2 pr-3 font-semibold">Machine</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">Planned</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">Made</th>
                  <th scope="col" className="w-[220px] py-2 font-semibold">Adherence</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {[...data.machines]
                  .sort((a, b) => b.plannedQty - a.plannedQty || b.actualQty - a.actualQty)
                  .map((m) => (
                    <Fragment key={m.key}>
                      <tr>
                        <td className="py-2 pr-3">
                          <button type="button" aria-expanded={open === m.key} onClick={() => setOpen(open === m.key ? null : m.key)} className="text-left font-semibold text-brand-700 underline-offset-4 hover:underline dark:text-brand-300">
                            {m.name}
                          </button>
                          <span className="block text-xs text-muted">{m.factory || '—'}</span>
                        </td>
                        <td className="py-2 pr-3 tabular-nums">{qtyLabel(m.plannedQty)}</td>
                        <td className="py-2 pr-3 tabular-nums">{qtyLabel(m.actualQty)}</td>
                        <td className="py-2">
                          <Meter pct={m.adherencePct} label={`Adherence of ${m.name}`} tone={m.adherencePct === null ? 'brand' : m.adherencePct < 60 ? 'danger' : m.adherencePct < 85 ? 'warning' : 'success'} />
                        </td>
                      </tr>
                      {open === m.key && (
                        <tr>
                          <td colSpan={4} className="bg-slate-50 px-3 py-2 dark:bg-slate-800/40">
                            <ul className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
                              {(byMachine.get(m.key) ?? []).map((r) => (
                                <li key={r.day} className="flex justify-between gap-2 text-13">
                                  <span>{dayLabel(r.day)}</span>
                                  <span className={cn('tabular-nums', r.actualQty < r.plannedQty && 'text-danger-700 dark:text-danger-400')}>
                                    {qtyLabel(r.actualQty)} of {qtyLabel(r.plannedQty)}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </SectionCard>
  )
}
