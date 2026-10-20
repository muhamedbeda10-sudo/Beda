// ============================================================================
// §25 — Plan against actual: for each day, what the plan published then had
// each machine make, beside what the production record says it made; the
// adherence of each machine (what it made of what was planned, day by day,
// never more than the plan); and how the ERP's own plan fared.
// ============================================================================

import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Target } from 'lucide-react'
import { addDays, type PlanVsActualResponse } from '@qc/shared/planning'
import { EmptyState, Input } from '@/components/ui'
import { cn } from '@/lib/utils'
import { useActual } from '@/services/planning'
import { useAuth } from '@/store/AuthContext'
import { calendarDay } from '@qc/shared/rules'
import { DataGrid, ErrorNote, Figure, Loading, Meter, PartFrame, useGrid, type GridColumn } from './common'
import { dayLabel, qtyLabel } from './format'

type MachineRow = PlanVsActualResponse['machines'][number]

export function ActualSection() {
  const { factoryTimeZone } = useAuth()
  const today = calendarDay(new Date(), factoryTimeZone)
  const [from, setFrom] = useState(addDays(today, -13))
  const [to, setTo] = useState(today)
  const valid = from <= to
  const { data, error, isLoading, refetch } = useActual(valid ? from : to, to)
  const [open, setOpen] = useState<string | null>(null)
  const byMachine = useMemo(() => {
    const m = new Map<string, PlanVsActualResponse['rows']>()
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
    return {
      planned,
      actual,
      adherence: planned > 0 ? (met / planned) * 100 : null,
    }
  }, [data])
  const rows = useMemo(() => [...(data?.machines ?? [])].sort((a, b) => b.plannedQty - a.plannedQty || b.actualQty - a.actualQty), [data])
  const columns = useMemo<GridColumn<MachineRow>[]>(
    () => [
      {
        key: 'machine',
        label: 'Machine',
        value: (m) => m.name,
        cell: (m) => (
          <button
            type="button"
            aria-expanded={open === m.key}
            onClick={() => setOpen(open === m.key ? null : m.key)}
            className="text-left font-semibold text-brand-700 underline-offset-4 hover:underline dark:text-brand-300"
          >
            {m.name}
          </button>
        ),
      },
      {
        key: 'factory',
        label: 'Factory',
        value: (m) => m.factory,
        cell: (m) => m.factory || '—',
      },
      {
        key: 'planned',
        label: 'Planned',
        numeric: true,
        right: true,
        value: (m) => String(Math.round(m.plannedQty)),
        sortValue: (m) => m.plannedQty,
        cell: (m) => qtyLabel(m.plannedQty),
      },
      {
        key: 'made',
        label: 'Made',
        numeric: true,
        right: true,
        value: (m) => String(Math.round(m.actualQty)),
        sortValue: (m) => m.actualQty,
        cell: (m) => qtyLabel(m.actualQty),
      },
      {
        key: 'adherence',
        label: 'Adherence',
        numeric: true,
        value: (m) => (m.adherencePct === null ? '' : String(Math.round(m.adherencePct))),
        sortValue: (m) => m.adherencePct,
        className: 'w-[240px]',
        cell: (m) => (
          <Meter pct={m.adherencePct} label={`Adherence of ${m.name}`} tone={m.adherencePct === null ? 'brand' : m.adherencePct < 60 ? 'danger' : m.adherencePct < 85 ? 'warning' : 'success'} />
        ),
      },
    ],
    [open],
  )
  const view = useGrid(rows, columns)
  return (
    <PartFrame
      toolbar={
        <>
          <Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} aria-label="From" className="h-10 w-auto py-0 text-sm touch:h-11" />
          <span className="text-13 text-muted">to</span>
          <Input type="date" value={to} max={today} onChange={(e) => setTo(e.target.value)} aria-label="To" className="h-10 w-auto py-0 text-sm touch:h-11" />
          <span className="text-13 text-muted">At most 93 days at once. Each day’s published plan beside what the production record says each machine made.</span>
        </>
      }
    >
      {isLoading ? (
        <Loading what="Reading the plans and the record" />
      ) : error || !data ? (
        <div className="p-4">
          <ErrorNote error={error} retry={() => void refetch()} />
        </div>
      ) : (
        <>
          {data.plans.length === 0 && (
            <p className="flex shrink-0 flex-wrap items-center gap-2 border-b border-warning-200 bg-warning-50 px-3 py-2 text-13 text-warning-800 dark:border-warning-500/25 dark:bg-warning-500/10 dark:text-warning-400">
              <span className="min-w-0 flex-1">No plan was published in these days: only what was made shows. Publish a plan and each day after is measured against it.</span>
              <Link to="/planning/plans" className="font-semibold underline-offset-4 hover:underline">
                Go to Plans
              </Link>
            </p>
          )}
          <div className="grid shrink-0 grid-cols-2 gap-2 border-b border-slate-200 p-3 lg:grid-cols-4 dark:border-slate-700">
            <Figure label="Planned pieces" value={qtyLabel(totals.planned)} />
            <Figure label="Made (production record)" value={qtyLabel(totals.actual)} />
            <Figure
              label="Adherence"
              value={totals.adherence === null ? '—' : `${Math.round(totals.adherence)}%`}
              tone={totals.adherence !== null && totals.adherence < 80 ? 'warning' : undefined}
              sub="made of what was planned, day by day"
            />
            <Figure label="ERP lines due to finish" value={data.erp.lines.toLocaleString()} sub={`${data.erp.finishedOnPlan} on plan, ${data.erp.late} late`} />
          </div>
          <DataGrid
            view={view}
            columns={columns}
            rowKey={(m) => m.key}
            total={rows.length}
            noun="machines"
            caption="Planned against made, by machine"
            empty={
              data.plans.length === 0 ? (
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
              ) : (
                <EmptyState icon={<Target className="h-10 w-10" />} title="No machine" hint="None matches the filters." />
              )
            }
            expand={(m) =>
              open === m.key ? (
                <ul className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
                  {(byMachine.get(m.key) ?? []).map((r) => (
                    <li key={r.day} className="flex justify-between gap-2 text-13">
                      <span>{dayLabel(r.day)}</span>
                      <span className={cn('tabular-nums', r.actualQty < r.plannedQty && 'text-danger-700 dark:text-danger-400')}>
                        {qtyLabel(r.actualQty)} of {qtyLabel(r.plannedQty)}
                      </span>
                    </li>
                  ))}
                  {(byMachine.get(m.key) ?? []).length === 0 && <li className="text-13 text-muted">Nothing on either in these days.</li>}
                </ul>
              ) : null
            }
            footer={data.plans.length > 0 ? <span>Plans read: {data.plans.map((p) => `${p.name} (published ${p.publishedAt.slice(0, 10)})`).join(', ')}.</span> : undefined}
          />
        </>
      )}
    </PartFrame>
  )
}
