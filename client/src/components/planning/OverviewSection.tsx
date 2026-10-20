// ============================================================================
// §25 — Overview: the automatic plan's totals beside the published plan's,
// the factory's load by process for the coming weeks, the customers whose
// lines run late, and how fresh the data under it all is.
// ============================================================================

import { Link } from 'react-router-dom'
import { DatabaseZap } from 'lucide-react'
import type { OverviewResponse, PlanSummary } from '@qc/shared/planning'
import { cn, formatDateTime } from '@/lib/utils'
import { useOverview } from '@/services/planning'
import { ErrorNote, Figure, Loading, OptimiserNote, SectionCard } from './common'
import { dayLabel, loadCell, pctLabel, processName, tonnes, wallLabel } from './format'

function Totals({ s, now }: { s: PlanSummary; now: number }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
      <Figure label="Lines to make" value={s.lines.toLocaleString()} sub={`${s.excluded} left out`} />
      <Figure label="Late lines" value={s.late.toLocaleString()} tone={s.late > 0 ? 'danger' : 'success'} sub={s.maxLateDays > 0 ? `up to ${s.maxLateDays} days late` : 'none late'} />
      <Figure label="On time" value={pctLabel(s.onTimePct)} tone={s.onTimePct !== null && s.onTimePct < 85 ? 'warning' : undefined} sub="of lines with a due day" />
      <Figure label="Late weight" value={tonnes(s.lateWeightKg)} tone={s.lateWeightKg > 0 ? 'danger' : undefined} />
      <Figure label="Machine hours" value={Math.round(s.hours).toLocaleString()} sub={s.assumedHours > 0 ? `${Math.round(s.assumedHours)} h assumed` : 'all from data'} />
      <Figure label="Last line done" value={s.lastFinish ? wallLabel(s.lastFinish).slice(0, 10) : '—'} sub={s.lastFinish ? `${Math.round((s.lastFinish - now) / 1440)} days from now` : undefined} />
    </div>
  )
}

function LoadByProcess({ load }: { load: OverviewResponse['load'] }) {
  const weeks = [...new Set(load.map((l) => l.week))].sort()
  const processes = [...new Set(load.map((l) => l.process))]
  if (weeks.length === 0) return <p className="text-sm text-muted">No machine has working time in the coming weeks.</p>
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] border-separate border-spacing-1 text-13">
        <caption className="sr-only">Planned hours as a share of working hours, by process and week</caption>
        <thead>
          <tr>
            <th scope="col" className="text-left font-semibold text-muted">
              Process
            </th>
            {weeks.map((w) => (
              <th key={w} scope="col" className="text-center font-semibold text-muted">
                {dayLabel(w).slice(4)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {processes.map((p) => (
            <tr key={p}>
              <th scope="row" className="whitespace-nowrap pr-2 text-left font-semibold">
                {processName(p)}
              </th>
              {weeks.map((w) => {
                const c = load.find((l) => l.process === p && l.week === w)
                return (
                  <td key={w} className={cn('h-10 rounded-md text-center font-semibold tabular-nums', loadCell(c?.loadPct ?? null))} title={c ? `${c.plannedHours} of ${c.capacityHours} working hours` : 'No working time'}>
                    {c?.loadPct === null || c === undefined ? '—' : `${c.loadPct}%`}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-muted">Each week starts on Saturday. Over 100%: more work planned than the machines have hours for.</p>
    </div>
  )
}

export function OverviewSection() {
  const { data, error, isLoading, refetch } = useOverview()
  if (isLoading) return <Loading />
  if (error || !data) return <ErrorNote error={error} retry={() => void refetch()} />
  const f = data.freshness
  return (
    <div className="space-y-4">
      <SectionCard title="The automatic plan" hint="Every open order line placed on its machine from the data as it is now: the order sheet, the production record and the open inspections.">
        <Totals s={data.auto} now={data.now} />
        <div className="mt-3">
          <OptimiserNote o={data.optimisation} late={data.auto.late} />
        </div>
        <p className="mt-3 text-13 text-muted">
          {data.machinesRunning} of {data.machinesTotal} machines have an inspection open now.{' '}
          <Link to="/planning/floor" className="font-semibold text-brand-700 underline-offset-4 hover:underline dark:text-brand-300">
            See them on the factory map
          </Link>
        </p>
      </SectionCard>

      {data.published ? (
        <SectionCard title={`Published plan: ${data.published.plan.name}`} hint={`Published ${formatDateTime(data.published.plan.publishedAt)} by ${data.published.plan.publishedByName ?? '—'}. Its lines stay as they were published.`}>
          <Totals s={data.published.summary} now={data.now} />
        </SectionCard>
      ) : (
        <SectionCard title="No plan is published" hint="Make a plan from the automatic one under Plans and publish it: the floor then follows it, and plan against actual measures it." >
          <Link to="/planning/plans" className="btn-secondary min-h-[44px]">
            Go to Plans
          </Link>
        </SectionCard>
      )}

      <div className="grid gap-4 lg:grid-cols-[2fr,1fr]">
        <SectionCard title="Load by process" hint="Planned hours of the automatic plan against the machines’ working hours, week by week.">
          <LoadByProcess load={data.load} />
        </SectionCard>
        <SectionCard title="Customers with late lines" hint="In the automatic plan.">
          {data.lateByCustomer.length === 0 ? (
            <p className="text-sm text-muted">No line is planned to finish late.</p>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {data.lateByCustomer.map((c) => (
                <li key={c.customer} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span className="min-w-0 truncate font-medium">{c.customer}</span>
                  <span className="shrink-0 tabular-nums text-danger-700 dark:text-danger-400">
                    {c.late} of {c.lines} late, up to {c.maxLateDays} d
                  </span>
                </li>
              ))}
            </ul>
          )}
          <Link to="/planning/late" className="mt-3 inline-block text-13 font-semibold text-brand-700 underline-offset-4 hover:underline dark:text-brand-300">
            All late lines
          </Link>
        </SectionCard>
      </div>

      <SectionCard
        title="The data under the plan"
        hint="A plan is only as good as the data it reads."
        actions={
          <Link to="/planning/gaps" className="btn-secondary min-h-[44px]">
            <DatabaseZap className="h-4 w-4" /> {data.gaps === 1 ? '1 thing' : `${data.gaps} things`} to fill in
          </Link>
        }
      >
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-muted">Order sheet synced</dt>
            <dd className="font-semibold">{f.ordersSyncedAt || f.ordersImportedAt ? formatDateTime(f.ordersSyncedAt ?? f.ordersImportedAt) : 'Never'}</dd>
          </div>
          <div>
            <dt className="text-muted">Production record imported</dt>
            <dd className="font-semibold">{f.productionImportedAt ? formatDateTime(f.productionImportedAt) : 'Never'}</dd>
          </div>
          <div>
            <dt className="text-muted">Last work day on it</dt>
            <dd className="font-semibold">{f.productionLastWorkDay ? dayLabel(f.productionLastWorkDay, true) : '—'}</dd>
          </div>
          <div>
            <dt className="text-muted">Paces and hours learnt</dt>
            <dd className="font-semibold">{f.learntAt ? formatDateTime(f.learntAt) : 'Not yet'}</dd>
          </div>
        </dl>
      </SectionCard>
    </div>
  )
}
