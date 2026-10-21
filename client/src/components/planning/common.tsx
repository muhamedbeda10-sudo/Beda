// ============================================================================
// §25 — the pieces every planning section shares. A part fills the room
// under the strip of icons (the page takes the whole of the window under the
// header, PlanningPage) and never scrolls the page: its toolbar stays, its
// card takes the rest, and what is long scrolls inside the card (PartFrame,
// Scroller). A table in it is a DataGrid: Excel's sort and filter on every
// column header (ColumnFilter), the header row pinned while the rows scroll,
// a footer with the count and the filters in force. Also the card with a
// title for the parts made of panels, loading and error states, the plan
// picker, the legend of the states' colours.
// ============================================================================

import { Fragment, forwardRef, type HTMLAttributes, type ReactNode } from 'react'
import type { PlanOptimisation } from '@qc/shared/planning'
import { AlertTriangle, Loader2, RotateCcw, Search, X } from 'lucide-react'
import { AUTO_PLAN_ID, type PlanHeader } from '@qc/shared/planning'
import { Button, Select } from '@/components/ui'
import { ViewTh, useTableView, type TableView, type ViewColumn } from '@/components/ui/ColumnFilter'
import { cn } from '@/lib/utils'
import { usePlans } from '@/services/planning'
import { STATE_DOT, STATE_NAME, type OpState } from './format'

// ---- A part that fills the window ----------------------------------------------------------

/** A part: its toolbar (filters, pickers, actions) on a row that stays, and a card that takes the rest of the room. */
export function PartFrame({ toolbar, children, className }: { toolbar?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {toolbar && <div className="flex flex-wrap items-center gap-2">{toolbar}</div>}
      <section className={cn('card flex min-h-0 flex-1 flex-col overflow-hidden', className)}>{children}</section>
    </div>
  )
}

/** What scrolls inside a part's card; `padded` for panels, bare for a table. The ref is the scrolling box itself. */
export const Scroller = forwardRef<HTMLDivElement, { children: ReactNode; className?: string; padded?: boolean } & HTMLAttributes<HTMLDivElement>>(function Scroller(
  { children, className, padded = false, ...rest },
  ref,
) {
  return (
    <div ref={ref} {...rest} className={cn('grid-scroll min-h-0 flex-1', padded && 'p-4 sm:p-5', className)}>
      {children}
    </div>
  )
})

/** The line at a card's foot: counts, the filters in force, a legend, notes. */
export function PartFooter({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-slate-200 px-3 py-1.5 text-xs text-muted dark:border-slate-700', className)}>{children}</div>
}

/** A search box for a toolbar. */
export function SearchBox({ value, onChange, placeholder, label, className }: { value: string; onChange: (v: string) => void; placeholder: string; label: string; className?: string }) {
  return (
    <div className={cn('relative min-w-[200px] flex-1 sm:max-w-xs', className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={label} className="input h-10 py-0 pl-9 pr-9 text-sm touch:h-11" />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear the search"
          className="absolute right-1.5 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-md text-muted hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200 touch:h-9 touch:w-9"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  )
}

// ---- A table with Excel's filters ----------------------------------------------------------

export interface GridColumn<T> extends ViewColumn<T> {
  label: string
  cell: (r: T) => ReactNode
  /** Figures: right-aligned, sorted smallest first. */
  right?: boolean
  className?: string
  /** No menu: a column of buttons. */
  plain?: boolean
}

export const useGrid = <T,>(rows: T[], columns: GridColumn<T>[]): TableView<T> => useTableView(rows, columns)

/** Rows a table draws at most: past it, the footer says to filter (an export has them all). */
const ROW_CAP = 1000

const TH = 'px-3 py-2 font-semibold shadow-[inset_0_-1px_0_rgb(226,232,240)] dark:shadow-[inset_0_-1px_0_rgb(51,65,85)]'

/**
 * The table of a part: the view's rows (filtered and sorted by the headers' menus), the header pinned while they
 * scroll, and the footer with how many show. `expand` draws a row under a row (an edit form, a day's detail).
 */
export function DataGrid<T>({
  view,
  columns,
  rowKey,
  total,
  noun,
  empty,
  expand,
  rowClass,
  caption,
  footer,
}: {
  view: TableView<T>
  columns: GridColumn<T>[]
  rowKey: (r: T) => string
  /** The rows before the filters. */
  total: number
  noun: string
  /** Shown when nothing is left. */
  empty: ReactNode
  expand?: (r: T) => ReactNode
  rowClass?: (r: T) => string | undefined
  caption?: string
  /** More for the footer: notes, a legend. */
  footer?: ReactNode
}) {
  const shown = view.rows.length > ROW_CAP ? view.rows.slice(0, ROW_CAP) : view.rows
  return (
    <>
      <Scroller>
        {view.rows.length === 0 ? (
          <div className="p-4">{empty}</div>
        ) : (
          <table className="w-full text-sm">
            {caption && <caption className="sr-only">{caption}</caption>}
            <thead className="text-left text-xs text-muted">
              <tr>
                {columns.map((c) =>
                  c.plain ? (
                    <th key={c.key} scope="col" className={cn(TH, c.right && 'text-right', c.className)}>
                      {c.label ? c.label : <span className="sr-only">Actions</span>}
                    </th>
                  ) : (
                    <ViewTh key={c.key} view={view} column={c.key} label={c.label} className={cn(TH, c.right && 'text-right', c.className)} />
                  ),
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {shown.map((r) => {
                const more = expand?.(r)
                return (
                  <Fragment key={rowKey(r)}>
                    <tr className={cn('align-top', rowClass?.(r))}>
                      {columns.map((c) => (
                        <td key={c.key} className={cn('px-3 py-2', c.right && 'text-right tabular-nums', c.className)}>
                          {c.cell(r)}
                        </td>
                      ))}
                    </tr>
                    {more && (
                      <tr>
                        <td colSpan={columns.length} className="bg-slate-50 px-3 py-2 dark:bg-slate-800/40">
                          {more}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        )}
      </Scroller>
      <PartFooter>
        <span>
          {shown.length < view.rows.length ? (
            <>
              The first {ROW_CAP.toLocaleString()} of <span className="font-semibold text-slate-900 dark:text-slate-100">{view.rows.length.toLocaleString()}</span> {noun}: filter to see the rest
            </>
          ) : (
            <>
              <span className="font-semibold tabular-nums text-slate-900 dark:text-slate-100">{view.rows.length.toLocaleString()}</span> {noun}
            </>
          )}
          {view.active > 0 && (
            <>
              {' '}
              of {total.toLocaleString()} · {view.active} {view.active === 1 ? 'column' : 'columns'} filtered ·{' '}
              <button type="button" onClick={view.clear} className="font-semibold text-brand-700 hover:underline dark:text-brand-300">
                Clear filters
              </button>
            </>
          )}
        </span>
        {footer}
      </PartFooter>
    </>
  )
}

export function SectionCard({ title, hint, actions, children, className }: { title: string; hint?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('card p-4 sm:p-5', className)}>
      <header className="mb-4 flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-bold text-slate-900 dark:text-white">{title}</h2>
          {hint && <p className="mt-0.5 max-w-3xl text-13 text-muted">{hint}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </header>
      {children}
    </section>
  )
}

export function Loading({ what = 'Working out the plan' }: { what?: string }) {
  return (
    <p role="status" className="flex items-center justify-center gap-2 py-12 text-sm text-muted">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {what}…
    </p>
  )
}

export function ErrorNote({ error, retry }: { error: unknown; retry?: () => void }) {
  const message = error instanceof Error ? error.message : 'It could not be read.'
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-3 rounded-xl bg-danger-50 p-4 text-sm text-danger-800 ring-1 ring-inset ring-danger-200 dark:bg-danger-500/10 dark:text-danger-300 dark:ring-danger-500/25"
    >
      <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">{message}</span>
      {retry && (
        <Button className="min-h-[40px]" onClick={retry}>
          <RotateCcw className="h-4 w-4" /> Try again
        </Button>
      )}
    </div>
  )
}

/** What a plan is called in a picker: its name, and its state when it is not a draft. */
export function planOptionLabel(p: PlanHeader): string {
  if (p.kind === 'auto') return 'Automatic plan (from the data now)'
  const what = p.kind === 'scenario' ? 'Scenario' : 'Plan'
  const state = p.status === 'draft' ? '' : ` (${p.status})`
  return `${what}: ${p.name}${state}`
}

/** The plan a section shows: the automatic one, the published one, or any kept plan or scenario. */
export function PlanPicker({ value, onChange, label = 'Plan', className }: { value: string; onChange: (id: string) => void; label?: string; className?: string }) {
  const { data } = usePlans()
  const plans = data?.plans ?? []
  const shown = plans.filter((p) => p.status !== 'archived' || p.id === value)
  return (
    <Select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className={cn('min-h-[44px] w-auto max-w-full', className)}>
      {shown.length === 0 && <option value={AUTO_PLAN_ID}>Automatic plan (from the data now)</option>}
      {shown.map((p) => (
        <option key={p.id} value={p.id}>
          {planOptionLabel(p)}
        </option>
      ))}
    </Select>
  )
}

/** The plan to show first: the published one when there is one, else the automatic plan. */
export function usePreferredPlanId(): string {
  const { data } = usePlans()
  return data?.plans.find((p) => p.status === 'published')?.id ?? AUTO_PLAN_ID
}

export function StateLegend({ states }: { states: OpState[] }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted" aria-label="What the colours mean">
      {states.map((s) => (
        <li key={s} className="inline-flex items-center gap-1.5">
          <span aria-hidden className={cn('h-2.5 w-2.5 rounded-sm', STATE_DOT[s])} />
          {STATE_NAME[s]}
        </li>
      ))}
    </ul>
  )
}

/** A figure with its name, for a section's row of totals. */
export function Figure({ label, value, tone, sub }: { label: string; value: ReactNode; tone?: 'danger' | 'success' | 'warning'; sub?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl bg-slate-50 px-3 py-2.5 ring-1 ring-inset ring-slate-200/70 dark:bg-slate-800/50 dark:ring-slate-700/60">
      <p className="truncate text-xs font-medium text-muted">{label}</p>
      <p
        className={cn(
          'mt-0.5 text-xl font-bold tabular-nums text-slate-900 dark:text-white',
          tone === 'danger' && 'text-danger-700 dark:text-danger-400',
          tone === 'success' && 'text-success-700 dark:text-success-400',
          tone === 'warning' && 'text-warning-800 dark:text-warning-400',
        )}
      >
        {value}
      </p>
      {sub && <p className="mt-0.5 truncate text-xs text-muted">{sub}</p>}
    </div>
  )
}

export const OBJECTIVE_NAME: Record<PlanOptimisation['objective'], string> = {
  'late-weight-days': 'tonne-days late',
  'order-complete': 'orders delivered whole (tonne-days late by order)',
  'late-lines': 'late lines',
  'late-days': 'days late',
}

const figure = (n: number) => (Number.isInteger(n) ? n.toLocaleString() : (Math.round(n * 10) / 10).toLocaleString())

/** What the optimiser did to a plan, in a line: the objective's figure for the priority order against the plan's. */
export function OptimiserNote({ o, late }: { o: PlanOptimisation | undefined; late: number }) {
  if (!o) return null
  if (o.effort === 'off') return <p className="text-13 text-muted">The optimiser is off: the plan is the priority order.</p>
  if (o.evaluations === 0) return <p className="text-13 text-muted">The optimiser was not run on a record this size: the plan is the priority order.</p>
  const name = OBJECTIVE_NAME[o.objective]
  return (
    <p className="text-13 text-muted">
      {o.improved ? (
        <>
          The optimiser bettered the priority order:{' '}
          <span className="font-semibold text-slate-900 dark:text-white">
            {figure(o.baselineScore)} → {figure(o.score)} {name}
          </span>
          {o.objective !== 'late-lines' && ` (${o.baseline.late} → ${late} late lines)`}, {o.moves} move{o.moves === 1 ? '' : 's'} kept of {o.evaluations} tried.
        </>
      ) : (
        <>
          The optimiser found nothing better than the priority order ({figure(o.score)} {name}, {o.evaluations} plans tried).
        </>
      )}
    </p>
  )
}

/** A thin bar of how much of something is filled, with its figure beside it. */
export function Meter({ pct, tone = 'brand', label }: { pct: number | null; tone?: 'brand' | 'danger' | 'success' | 'warning'; label: string }) {
  const v = pct === null ? 0 : Math.max(0, Math.min(100, pct))
  const fill = {
    brand: 'bg-brand-600 dark:bg-brand-400',
    danger: 'bg-rose-600 dark:bg-rose-500',
    success: 'bg-emerald-600 dark:bg-emerald-500',
    warning: 'bg-amber-400',
  }[tone]
  return (
    <div className="flex items-center gap-2" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
      <div className="h-2 min-w-[60px] flex-1 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
        <div className={cn('h-full rounded-full', fill)} style={{ width: `${v}%` }} />
      </div>
      <span className="w-10 shrink-0 text-right text-xs font-semibold tabular-nums">{pct === null ? '—' : `${Math.round(pct)}%`}</span>
    </div>
  )
}
