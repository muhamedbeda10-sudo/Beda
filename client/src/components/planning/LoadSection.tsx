// ============================================================================
// §25 — Load: each machine's planned hours against the hours it has, week by
// week (Saturday to Friday), as a heat map: where the plan asks more than a
// machine can give, and where there is room for a rush order. The machines
// filter from the header; the weeks stay in view while the rows scroll.
// ============================================================================

import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Download, Grid3x3 } from 'lucide-react'
import { PLANNING_PROCESSES, PROCESS_NAMES, type LoadResponse, type PlanMachineInfo, type WeekLoad } from '@qc/shared/planning'
import { Button, EmptyState } from '@/components/ui'
import { FilterSelect, Segmented } from '@/components/ui/PageShell'
import { useTableView, ViewTh, type ViewColumn } from '@/components/ui/ColumnFilter'
import { cn } from '@/lib/utils'
import { usePersistedState } from '@/lib/usePersistedState'
import { downloadWorkbook } from '@/lib/xlsxWrite'
import { useLoad } from '@/services/planning'
import { ErrorNote, Loading, PartFooter, PartFrame, PlanPicker, Scroller, usePreferredPlanId } from './common'
import { chosenFactory, dayLabel, factoryKey, factoryName, loadCell, processName } from './format'

interface Row {
  m: PlanMachineInfo
  cells: (WeekLoad | null)[]
}

const sourceName = (s: PlanMachineInfo['capacitySource']) => (s === 'default' ? 'default' : s === 'inferred' ? 'learnt' : 'set')

function rowsOf(data: LoadResponse | undefined): Row[] {
  if (!data) return []
  const cells = new Map(data.rows.map((r) => [`${r.machineKey}|${r.week}`, r]))
  return data.machines
    .filter((m) => data.rows.some((r) => r.machineKey === m.key && (r.plannedHours > 0 || m.known)))
    .sort((a, b) => a.factory.localeCompare(b.factory) || a.name.localeCompare(b.name, undefined, { numeric: true }))
    .map((m) => ({
      m,
      cells: data.weeks.map((w) => cells.get(`${m.key}|${w}`) ?? null),
    }))
}

/** The machine column sorts and filters from its header; the factory and the process are picked in the toolbar. */
const COLUMNS: ViewColumn<Row>[] = [{ key: 'machine', value: (r) => r.m.name }]

export function LoadSection() {
  const [params, setParams] = useSearchParams()
  const preferred = usePreferredPlanId()
  const planId = params.get('plan') ?? preferred
  const [weeks, setWeeks] = usePersistedState<'4' | '8' | '13'>('qc-planning:load-weeks', '8')
  const [factory, setFactory] = usePersistedState<string>('qc-planning:factory', '')
  const [process, setProcess] = usePersistedState<string>('qc-planning:load-process', '')
  const { data, error, isLoading, refetch } = useLoad(planId, Number(weeks))
  const all = useMemo(() => rowsOf(data), [data])
  const factories = useMemo(() => [...new Set(all.map((r) => r.m.factory))].sort(), [all])
  // The remembered factory (shared with the map and the schedule) counts only while it is one of this plan's.
  const chosen = chosenFactory(factory, factories)
  const rows = useMemo(() => all.filter((r) => (chosen === null || r.m.factory === chosen) && (!process || r.m.process === process)), [all, chosen, process])
  const view = useTableView(rows, COLUMNS)
  const exportIt = () => {
    if (!data) return
    downloadWorkbook('Machine load.xlsx', [
      {
        name: 'Load',
        header: ['Factory', 'Machine', 'Process', ...data.weeks.flatMap((w) => [`${w} planned h`, `${w} working h`, `${w} %`])],
        rows: view.rows.map(({ m, cells }) => [m.factory, m.name, processName(m.process), ...cells.flatMap((c) => [c?.plannedHours ?? 0, c?.capacityHours ?? 0, c?.loadPct ?? null])]),
      },
    ])
  }
  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params)
    if (v) next.set(k, v)
    else next.delete(k)
    setParams(next, { replace: true })
  }
  return (
    <PartFrame
      toolbar={
        <>
          <PlanPicker value={planId} onChange={(id) => setParam('plan', id)} />
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
          {factories.length > 1 && (
            <FilterSelect label="Factory" value={chosen === null ? '' : factoryKey(chosen)} onChange={setFactory}>
              <option value="">Every factory</option>
              {factories.map((f) => (
                <option key={factoryKey(f)} value={factoryKey(f)}>
                  {factoryName(f)}
                </option>
              ))}
            </FilterSelect>
          )}
          <FilterSelect label="Process" value={process} onChange={setProcess}>
            <option value="">Every process</option>
            {PLANNING_PROCESSES.map((p) => (
              <option key={p} value={p}>
                {PROCESS_NAMES[p]}
              </option>
            ))}
          </FilterSelect>
          <span className="flex-1" />
          <Button className="min-h-[40px]" onClick={exportIt} disabled={!data || view.rows.length === 0}>
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
      ) : (
        <>
          <Scroller>
            {view.rows.length === 0 ? (
              <div className="p-4">
                <EmptyState icon={<Grid3x3 className="h-10 w-10" />} title="No machine" hint="None has planned hours or working time in these weeks, or none matches the filters." />
              </div>
            ) : (
              <table className="sticky-first w-full border-separate border-spacing-1 text-13">
                <caption className="sr-only">Load of each machine by week</caption>
                <thead className="text-xs text-muted">
                  <tr>
                    <ViewTh view={view} column="machine" label="Machine" className="px-2 py-1 text-left font-semibold" />
                    {data.weeks.map((w) => (
                      <th key={w} scope="col" className="whitespace-nowrap px-1 py-1 text-center font-semibold">
                        {dayLabel(w).slice(4)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {view.rows.map(({ m, cells }) => (
                    <tr key={m.key} className="bg-white dark:bg-slate-900">
                      <th scope="row" className="max-w-[240px] px-2 text-left">
                        <span className="block truncate font-semibold">{m.name}</span>
                        <span className="block truncate text-[11px] font-normal text-muted">
                          {m.factory || '—'} · {processName(m.process)} · {m.hoursPerDay} h/day ({sourceName(m.capacitySource)})
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
            )}
          </Scroller>
          <PartFooter>
            <span>
              <span className="font-semibold tabular-nums text-slate-900 dark:text-slate-100">{view.rows.length.toLocaleString()}</span> machines
              {view.active > 0 && (
                <>
                  {' '}
                  of {rows.length.toLocaleString()} · filtered ·{' '}
                  <button type="button" onClick={view.clear} className="font-semibold text-brand-700 hover:underline dark:text-brand-300">
                    Clear filters
                  </button>
                </>
              )}
            </span>
            <ul className="flex flex-wrap gap-x-3 gap-y-1" aria-label="What the colours mean">
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
            <span>Planned hours as a share of the machine’s working hours, Saturday to Friday. Over 100%: the plan asks more than the machine has.</span>
          </PartFooter>
        </>
      )}
    </PartFrame>
  )
}
