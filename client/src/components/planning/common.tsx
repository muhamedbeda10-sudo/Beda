// ============================================================================
// §25 — the pieces every planning section shares: its card with a title and
// a line of what it shows, loading and error states, the plan picker, the
// legend of the states' colours.
// ============================================================================

import type { ReactNode } from 'react'
import type { PlanOptimisation } from '@qc/shared/planning'
import { AlertTriangle, Loader2, RotateCcw } from 'lucide-react'
import { AUTO_PLAN_ID, type PlanHeader } from '@qc/shared/planning'
import { Button, Select } from '@/components/ui'
import { cn } from '@/lib/utils'
import { usePlans } from '@/services/planning'
import { STATE_DOT, STATE_NAME, type OpState } from './format'

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
    <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl bg-danger-50 p-4 text-sm text-danger-800 ring-1 ring-inset ring-danger-200 dark:bg-danger-500/10 dark:text-danger-300 dark:ring-danger-500/25">
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
          The optimiser bettered the priority order: <span className="font-semibold text-slate-900 dark:text-white">{figure(o.baselineScore)} → {figure(o.score)} {name}</span>
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
  const fill = { brand: 'bg-brand-600 dark:bg-brand-400', danger: 'bg-rose-600 dark:bg-rose-500', success: 'bg-emerald-600 dark:bg-emerald-500', warning: 'bg-amber-400' }[tone]
  return (
    <div className="flex items-center gap-2" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
      <div className="h-2 min-w-[60px] flex-1 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
        <div className={cn('h-full rounded-full', fill)} style={{ width: `${v}%` }} />
      </div>
      <span className="w-10 shrink-0 text-right text-xs font-semibold tabular-nums">{pct === null ? '—' : `${Math.round(pct)}%`}</span>
    </div>
  )
}
