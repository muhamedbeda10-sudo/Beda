// ============================================================================
// §25 — Overview: the automatic plan's totals beside the published plan's,
// the factory's load by process for the coming weeks, the customers whose
// lines run late, what was left out and why, and how fresh the data under
// it all is — on one screen, as panels; on a small one they scroll inside.
// ============================================================================

import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { DatabaseZap } from 'lucide-react'
import { EXCLUSION_REASONS, type ExclusionReason, type OverviewResponse, type PlanSummary } from '@qc/shared/planning'
import { cn, formatDateTime } from '@/lib/utils'
import { useOverview } from '@/services/planning'
import { ErrorNote, Figure, Loading, OptimiserNote, PartFrame, Scroller } from './common'
import { dayLabel, loadCell, pctLabel, processName, tonnes, wallLabel } from './format'

const REASON_NAME: Record<ExclusionReason, string> = {
  done: 'Made in full',
  cancelled: 'Cancelled',
  hold: 'Held by the ERP',
  stock: 'Stock orders',
  'no-machine': 'No machine on the line',
  excluded: 'Left out by an event',
  stale: 'Due day too old (Settings)',
}

function Panel({ title, hint, children, className, action }: { title: string; hint?: string; children: ReactNode; className?: string; action?: ReactNode }) {
  return (
    <section className={cn('rounded-xl p-3 ring-1 ring-inset ring-slate-200/80 dark:ring-slate-700/70', className)}>
      <header className="mb-2 flex flex-wrap items-start gap-2">
        <div className="min-w-[14rem] flex-1">
          <h2 className="text-sm font-bold text-slate-900 dark:text-white">{title}</h2>
          {hint && <p className="text-xs text-muted">{hint}</p>}
        </div>
        {action}
      </header>
      {children}
    </section>
  )
}

function Totals({ s, now }: { s: PlanSummary; now: number }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
      <Figure label="Lines to make" value={s.lines.toLocaleString()} sub={`${s.excluded.toLocaleString()} left out`} />
      <Figure label="Late lines" value={s.late.toLocaleString()} tone={s.late > 0 ? 'danger' : 'success'} sub={s.maxLateDays > 0 ? `up to ${s.maxLateDays} days late${s.lateOrders !== undefined ? ` · ${s.lateOrders.toLocaleString()} of ${(s.orders ?? 0).toLocaleString()} orders` : ''}` : 'none late'} />
      <Figure label="On time" value={pctLabel(s.onTimePct)} tone={s.onTimePct !== null && s.onTimePct < 85 ? 'warning' : undefined} sub="of lines with a due day" />
      <Figure label="Late weight" value={tonnes(s.lateWeightKg)} tone={s.lateWeightKg > 0 ? 'danger' : undefined} />
      <Figure label="Machine hours" value={Math.round(s.hours).toLocaleString()} sub={s.assumedHours > 0 ? `${Math.round(s.assumedHours).toLocaleString()} h assumed` : 'all from data'} />
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
      <table className="w-full border-separate border-spacing-1 text-13">
        <caption className="sr-only">Planned hours as a share of working hours, by process and week</caption>
        <thead>
          <tr>
            <th scope="col" className="text-left text-xs font-semibold text-muted">
              Process
            </th>
            {weeks.map((w) => (
              <th key={w} scope="col" className="whitespace-nowrap text-center text-xs font-semibold text-muted">
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
                  <td
                    key={w}
                    className={cn('h-9 min-w-[56px] rounded-md text-center font-semibold tabular-nums', loadCell(c?.loadPct ?? null))}
                    title={c ? `${c.plannedHours} of ${c.capacityHours} working hours` : 'No working time'}
                  >
                    {c?.loadPct === null || c === undefined ? '—' : `${c.loadPct}%`}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1.5 text-xs text-muted">Each week starts on Saturday. Over 100%: more work planned than the machines have hours for.</p>
    </div>
  )
}

function Row({ label, value, tone }: { label: string; value: ReactNode; tone?: 'danger' }) {
  return (
    <li className="flex items-center justify-between gap-3 py-1.5 text-sm">
      <span className="min-w-0 truncate">{label}</span>
      <span className={cn('shrink-0 font-semibold tabular-nums', tone === 'danger' && 'text-danger-700 dark:text-danger-400')}>{value}</span>
    </li>
  )
}

export function OverviewSection() {
  const { data, error, isLoading, refetch } = useOverview()
  if (isLoading) return <Loading />
  if (error || !data)
    return (
      <div className="p-4">
        <ErrorNote error={error} retry={() => void refetch()} />
      </div>
    )
  const f = data.freshness
  const reasons = EXCLUSION_REASONS.filter((r) => (data.excludedByReason[r] ?? 0) > 0)
  return (
    <PartFrame>
      <Scroller padded className="space-y-3">
        <Panel
          title="The automatic plan"
          hint="Every open order line placed on its machine from the data as it is now: the order sheet, the production record and the open inspections."
          action={
            <Link to="/planning/floor" className="whitespace-nowrap text-13 font-semibold text-brand-700 underline-offset-4 hover:underline dark:text-brand-300">
              {data.machinesRunning} of {data.machinesTotal} machines running now
            </Link>
          }
        >
          <Totals s={data.auto} now={data.now} />
          <div className="mt-2">
            <OptimiserNote o={data.optimisation} late={data.auto.late} />
          </div>
          {data.slowMachines.length > 0 && (
            <p className="mt-2 text-13 text-amber-800 dark:text-amber-300">
              Running slower than usual over the last two weeks: {data.slowMachines.map((m) => `${m.machineName} (${m.speedPct}%)`).join(', ')}.{' '}
              <Link to="/planning/floor" className="font-semibold underline-offset-4 hover:underline">
                See the machines
              </Link>
              . The plan reads it when Settings → Plan with each machine’s pace of late is on.
            </p>
          )}
        </Panel>

        <div className="grid gap-3 xl:grid-cols-3">
          <Panel title="Load by process" hint="Planned hours of the automatic plan against the machines’ working hours, week by week." className="xl:col-span-2">
            <LoadByProcess load={data.load} />
          </Panel>
          <Panel
            title="Customers with late lines"
            hint="In the automatic plan."
            action={
              <Link to="/planning/late" className="whitespace-nowrap text-13 font-semibold text-brand-700 underline-offset-4 hover:underline dark:text-brand-300">
                All late lines
              </Link>
            }
          >
            {data.lateByCustomer.length === 0 ? (
              <p className="text-sm text-muted">No line is planned to finish late.</p>
            ) : (
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {data.lateByCustomer.map((c) => (
                  <Row key={c.customer} label={c.customer} value={`${c.late} of ${c.lines} late, up to ${c.maxLateDays} d`} tone="danger" />
                ))}
              </ul>
            )}
          </Panel>
        </div>

        <div className="grid gap-3 xl:grid-cols-3">
          <Panel title="Left out of the plan" hint={`${data.auto.excluded.toLocaleString()} open lines the engine does not plan, by why.`}>
            {reasons.length === 0 ? (
              <p className="text-sm text-muted">Every open line is planned.</p>
            ) : (
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {reasons.map((r) => (
                  <Row key={r} label={REASON_NAME[r]} value={(data.excludedByReason[r] ?? 0).toLocaleString()} />
                ))}
              </ul>
            )}
          </Panel>
          {data.published ? (
            <Panel
              title={`Published plan: ${data.published.plan.name}`}
              hint={`Published ${formatDateTime(data.published.plan.publishedAt)} by ${data.published.plan.publishedByName ?? '—'}. Its lines stay as they were published.`}
            >
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                <Row label="Lines to make" value={data.published.summary.lines.toLocaleString()} />
                <Row label="Late lines" value={data.published.summary.late.toLocaleString()} tone={data.published.summary.late > 0 ? 'danger' : undefined} />
                <Row label="On time" value={pctLabel(data.published.summary.onTimePct)} />
                <Row label="Late weight" value={tonnes(data.published.summary.lateWeightKg)} />
                <Row label="Last line done" value={data.published.summary.lastFinish ? wallLabel(data.published.summary.lastFinish).slice(0, 10) : '—'} />
              </ul>
            </Panel>
          ) : (
            <Panel title="No plan is published" hint="Make a plan from the automatic one under Plans and publish it: the floor then follows it, and plan against actual measures it.">
              <Link to="/planning/plans" className="btn-secondary min-h-[40px]">
                Go to Plans
              </Link>
            </Panel>
          )}
          <Panel
            title="The data under the plan"
            hint="A plan is only as good as the data it reads."
            action={
              <Link to="/planning/gaps" className="btn-secondary min-h-[36px] whitespace-nowrap px-2.5 text-13">
                <DatabaseZap className="h-4 w-4" /> {data.gaps === 1 ? '1 thing' : `${data.gaps} things`} to fill in
              </Link>
            }
          >
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              <Row label="Order sheet synced" value={f.ordersSyncedAt || f.ordersImportedAt ? formatDateTime(f.ordersSyncedAt ?? f.ordersImportedAt) : 'Never'} />
              <Row label="Production record imported" value={f.productionImportedAt ? formatDateTime(f.productionImportedAt) : 'Never'} />
              <Row label="Last work day on it" value={f.productionLastWorkDay ? dayLabel(f.productionLastWorkDay, true) : '—'} />
              <Row label="Paces and hours learnt" value={f.learntAt ? formatDateTime(f.learntAt) : 'Not yet'} />
            </ul>
          </Panel>
        </div>
      </Scroller>
    </PartFrame>
  )
}
