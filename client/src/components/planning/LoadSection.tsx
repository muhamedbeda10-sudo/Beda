// ============================================================================
// §25 — Load: each machine's planned hours against the hours it has, week by
// week (Saturday to Friday), as a heat map: where the plan asks more than a
// machine can give, and where there is room for a rush order.
// ============================================================================

import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Download } from 'lucide-react'
import { Button } from '@/components/ui'
import { Segmented } from '@/components/ui/PageShell'
import { cn } from '@/lib/utils'
import { usePersistedState } from '@/lib/usePersistedState'
import { downloadWorkbook } from '@/lib/xlsxWrite'
import { useLoad } from '@/services/planning'
import { ErrorNote, Loading, PlanPicker, SectionCard, usePreferredPlanId } from './common'
import { dayLabel, loadCell, processName } from './format'

export function LoadSection() {
  const [params, setParams] = useSearchParams()
  const preferred = usePreferredPlanId()
  const planId = params.get('plan') ?? preferred
  const [weeks, setWeeks] = usePersistedState<'4' | '8' | '13'>('qc-planning:load-weeks', '8')
  const { data, error, isLoading, refetch } = useLoad(planId, Number(weeks))
  const table = useMemo(() => {
    if (!data) return []
    const cells = new Map(data.rows.map((r) => [`${r.machineKey}|${r.week}`, r]))
    return data.machines
      .filter((m) => data.rows.some((r) => r.machineKey === m.key && (r.plannedHours > 0 || m.known)))
      .sort((a, b) => a.factory.localeCompare(b.factory) || a.name.localeCompare(b.name, undefined, { numeric: true }))
      .map((m) => ({ m, cells: data.weeks.map((w) => cells.get(`${m.key}|${w}`) ?? null) }))
  }, [data])
  const exportIt = () => {
    if (!data) return
    downloadWorkbook('Machine load.xlsx', [
      {
        name: 'Load',
        header: ['Factory', 'Machine', 'Process', ...data.weeks.flatMap((w) => [`${w} planned h`, `${w} working h`, `${w} %`])],
        rows: table.map(({ m, cells }) => [m.factory, m.name, processName(m.process), ...cells.flatMap((c) => [c?.plannedHours ?? 0, c?.capacityHours ?? 0, c?.loadPct ?? null])]),
      },
    ])
  }
  return (
    <SectionCard
      title="Machine load"
      hint="Planned hours as a share of each machine’s working hours, week by week (Saturday to Friday). Over 100%: the plan asks more than the machine has."
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
          <Button className="min-h-[44px]" onClick={exportIt} disabled={!data}>
            <Download className="h-4 w-4" /> Excel
          </Button>
        </>
      }
    >
      <div className="mb-3">
        <Segmented
          label="Weeks"
          value={weeks}
          onChange={setWeeks}
          options={[
            { value: '4', label: '4 weeks' },
            { value: '8', label: '8 weeks' },
            { value: '13', label: 'A quarter' },
          ]}
        />
      </div>
      {isLoading && <Loading />}
      {error && <ErrorNote error={error} retry={() => void refetch()} />}
      {data && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-separate border-spacing-1 text-13">
            <caption className="sr-only">Load of each machine by week</caption>
            <thead>
              <tr>
                <th scope="col" className="sticky left-0 z-10 bg-white text-left font-semibold text-muted dark:bg-slate-900">
                  Machine
                </th>
                {data.weeks.map((w) => (
                  <th key={w} scope="col" className="whitespace-nowrap text-center font-semibold text-muted">
                    {dayLabel(w).slice(4)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.map(({ m, cells }) => (
                <tr key={m.key}>
                  <th scope="row" className="sticky left-0 z-10 max-w-[220px] bg-white pr-2 text-left dark:bg-slate-900">
                    <span className="block truncate font-semibold">{m.name}</span>
                    <span className="block truncate text-[11px] font-normal text-muted">
                      {m.factory || '—'} · {m.hoursPerDay} h/day {m.capacitySource === 'default' ? '(default)' : m.capacitySource === 'inferred' ? '(learnt)' : '(set)'}
                    </span>
                  </th>
                  {cells.map((c, i) => (
                    <td
                      key={data.weeks[i]}
                      className={cn('h-11 min-w-[64px] rounded-md text-center font-semibold tabular-nums', loadCell(c?.loadPct ?? null))}
                      title={c ? `${c.plannedHours} planned of ${c.capacityHours} working hours` : 'No working time'}
                    >
                      {c?.loadPct === null || !c ? '—' : `${c.loadPct}%`}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" aria-label="What the colours mean">
            {[
              [10, 'Under half'],
              [60, 'Half to 85%'],
              [90, '85% to full'],
              [120, 'Over full'],
            ].map(([p, label]) => (
              <li key={label} className="inline-flex items-center gap-1.5">
                <span aria-hidden className={cn('h-3 w-5 rounded-sm ring-1 ring-inset ring-slate-200 dark:ring-slate-700', loadCell(p as number))} />
                {label}
              </li>
            ))}
          </ul>
        </div>
      )}
    </SectionCard>
  )
}
