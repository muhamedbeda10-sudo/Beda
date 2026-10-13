// ============================================================================
// Every chart in the app shows its figures as a table too, at a switch: Chart
// or Table. A card that holds charts — a dashboard widget, an answer's
// figure, a report's section — offers one switch for all of them in its
// header; a chart on its own carries its own above it. Each chart says what
// its table holds: the rows and columns of the figures it draws, written as
// it writes them. On paper the chosen view prints, without the switch.
// ============================================================================

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react'
import { BarChart3, Table2 } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * True inside a board: the chart fills the box it was given, height and
 * width alike. Outside a board a chart takes the height it asks for.
 */
export const ChartFillContext = createContext(false)

export type FigureView = 'chart' | 'table'

export interface FigureColumn {
  label: string
  /** Numbers: right-aligned, written by the table's format with this unit. */
  numeric?: boolean
  unit?: string
}

/** A chart's figures as a table: its columns, and a row per point (bar, slice, day…). */
export interface FigureTableSpec {
  columns: FigureColumn[]
  rows: (string | number | null)[][]
  /** How numbers are written: the chart's own format, else whole numbers grouped and two decimals at most. */
  format?: (n: number) => string
}

export interface FigureScopeValue {
  view: FigureView
  /** A chart inside the scope says it is there (its switch then shows); the returned function says it went. */
  register: () => () => void
}

const FigureViewContext = createContext<FigureScopeValue | null>(null)

/** Measured before the first paint in a browser; in a server render, an effect that never runs. */
const useEarlyEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

const noop = () => () => undefined
/** Inside something that shows the figures its own way (the assistant's answers and reports): always the chart, and no switch of its own. */
const CHART_ONLY: FigureScopeValue = { view: 'chart', register: noop }

export function ChartOnly({ children }: { children: ReactNode }) {
  return <FigureViewContext.Provider value={CHART_ONLY}>{children}</FigureViewContext.Provider>
}

/** A card's one switch for the charts inside it: what they show, and whether there is any to switch. */
export function useFigureScope() {
  const [view, setView] = useState<FigureView>('chart')
  const [count, setCount] = useState(0)
  const register = useCallback(() => {
    setCount((c) => c + 1)
    return () => setCount((c) => c - 1)
  }, [])
  const scope = useMemo<FigureScopeValue>(() => ({ view, register }), [view, register])
  return { scope, view, setView, hasCharts: count > 0 }
}

export function FigureScope({ scope, children }: { scope: FigureScopeValue; children: ReactNode }) {
  return <FigureViewContext.Provider value={scope}>{children}</FigureViewContext.Provider>
}

/**
 * A chart, or its table: as its card's switch says, or — a chart on its own —
 * as its own switch above it says. `table` is asked for only when shown.
 */
export function Figure({ table, children }: { table: () => FigureTableSpec; children: ReactNode }) {
  const scope = useContext(FigureViewContext)
  const [own, setOwn] = useState<FigureView>('chart')
  const register = scope?.register
  useEarlyEffect(() => (register ? register() : undefined), [register])
  const view = scope ? scope.view : own
  const body = view === 'table' ? <FigureTable spec={table()} /> : children
  if (scope) return <>{body}</>
  return (
    <div className="min-w-0">
      <div className="print-hidden mb-1.5 flex justify-end">
        <ChartTableSwitch value={own} onChange={setOwn} />
      </div>
      {body}
    </div>
  )
}

/** The switch: Chart or Table, the one shown pressed. */
export function ChartTableSwitch({ value, onChange, className }: { value: FigureView; onChange: (v: FigureView) => void; className?: string }) {
  const option = (v: FigureView, label: string, icon: ReactNode) => (
    <button
      type="button"
      aria-pressed={value === v}
      onClick={() => onChange(v)}
      className={cn(
        'inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-semibold transition-colors touch:h-9 touch:px-3',
        value === v ? 'bg-white text-brand-700 shadow-sm dark:bg-slate-900 dark:text-brand-300' : 'text-muted hover:text-slate-700 dark:hover:text-slate-200',
      )}
    >
      {icon}
      {label}
    </button>
  )
  return (
    <div role="group" aria-label="Show as" className={cn('print-hidden inline-flex shrink-0 items-center gap-0.5 rounded-lg bg-slate-100 p-0.5 dark:bg-slate-800', className)}>
      {option('chart', 'Chart', <BarChart3 aria-hidden className="h-3.5 w-3.5" />)}
      {option('table', 'Table', <Table2 aria-hidden className="h-3.5 w-3.5" />)}
    </div>
  )
}

/** Whole numbers grouped by thousands, others to two decimals at most. */
const plain = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 })

/** A chart's figures as a table: its own words, numbers right-aligned in its own format. */
export function FigureTable({ spec }: { spec: FigureTableSpec }) {
  const fill = useContext(ChartFillContext)
  const format = spec.format ?? plain
  const text = (v: string | number | null, c: FigureColumn | undefined) => {
    if (v === null || v === '') return '—'
    if (typeof v === 'number') return c?.numeric ? `${Number.isFinite(v) ? format(v) : String(v)}${c.unit ?? ''}` : String(v)
    return v
  }
  return (
    <div className={cn('overflow-auto overscroll-contain rounded-xl ring-1 ring-slate-200 dark:ring-slate-800', !fill && 'max-h-[26rem]')}>
      <table className="w-full border-collapse text-13">
        <thead className="sticky top-0 z-[1] bg-slate-50 text-[11px] uppercase tracking-wide text-muted dark:bg-slate-800">
          <tr>
            {spec.columns.map((c, i) => (
              <th key={i} scope="col" className={cn('whitespace-nowrap px-3 py-2 font-semibold', c.numeric ? 'text-right' : 'text-left')}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {spec.rows.length === 0 ? (
            <tr>
              <td colSpan={Math.max(1, spec.columns.length)} className="px-3 py-6 text-center text-muted">
                Nothing in this period.
              </td>
            </tr>
          ) : (
            spec.rows.map((r, i) => (
              <tr key={i} className="border-t border-slate-100 even:bg-slate-50/60 dark:border-slate-800 dark:even:bg-slate-800/30">
                {r.map((v, k) => {
                  const c = spec.columns[k]
                  return (
                    <td key={k} dir={c?.numeric ? undefined : 'auto'} className={cn('px-3 py-1.5', c?.numeric ? 'whitespace-nowrap text-right font-medium tabular-nums' : 'text-start text-slate-700 dark:text-slate-200')}>
                      {text(v, c)}
                    </td>
                  )
                })}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}

/** A share of a total in %, to one decimal; nothing of nothing is null. */
export const shareOf = (v: number, total: number): number | null => (total > 0 ? Math.round((v / total) * 1000) / 10 : null)
