// ============================================================================
// §21 — the pieces every view of a follow-up shares: its status, its
// deadline in words, the "Needs review" mark a session wears while one is
// open, and the case it was opened for, column by column.
// ============================================================================

import { Flag } from 'lucide-react'
import type { FollowUp, FollowUpStatus } from '@qc/shared/automation'
import type { AiCell } from '@qc/shared/ai'
import { Badge } from '@/components/ui'
import { cn } from '@/lib/utils'
import { DUE_TONE_CLASS, FOLLOW_UP_STATUS_LABEL, FOLLOW_UP_STATUS_TONE, dueView, factoryMoment, factoryTimestamp } from './wording'

export function FollowUpStatusBadge({ status }: { status: FollowUpStatus }) {
  return <Badge tone={FOLLOW_UP_STATUS_TONE[status]}>{FOLLOW_UP_STATUS_LABEL[status]}</Badge>
}

/** The deadline: when, on the factory's clock, and how far off or overdue — red once missed. */
export function DueText({ followUp: f, timeZone, stacked = false, className }: { followUp: Pick<FollowUp, 'dueAt' | 'status'>; timeZone: string; stacked?: boolean; className?: string }) {
  const due = dueView(f)
  return (
    <span className={cn(stacked ? 'flex flex-col' : 'inline-flex flex-wrap items-baseline gap-x-1.5', className)}>
      <time dateTime={f.dueAt} data-tip={factoryTimestamp(f.dueAt, timeZone)} className={cn('tabular-nums', due.tone === 'overdue' ? DUE_TONE_CLASS.overdue : due.tone === 'done' && 'text-muted')}>
        {factoryMoment(f.dueAt, timeZone)}
      </time>
      {due.words && <span className={cn('text-xs', DUE_TONE_CLASS[due.tone])}>{due.words}</span>}
    </span>
  )
}

/**
 * A session with follow-ups not done: "Needs review" until they are closed.
 * `compact`: the flag alone, its words in the tooltip (and to a screen
 * reader) — for a one-line table cell, where the words would push the
 * session's own status out of sight.
 */
export function NeedsReviewBadge({ count, compact = false }: { count: number; compact?: boolean }) {
  if (count <= 0) return null
  const tip = `${compact ? 'Needs review: ' : ''}${count} open follow-up${count === 1 ? '' : 's'}: it reads “Needs review” until ${count === 1 ? 'it is' : 'they are'} closed`
  return (
    <Badge tone="amber" icon={<Flag className="h-3 w-3" aria-hidden />} tip={tip}>
      {compact ? <span className="sr-only">Needs review</span> : 'Needs review'}
    </Badge>
  )
}

/** A cell of the case as text: nothing as a dash, yes or no for a flag. */
export function caseCellText(v: AiCell | undefined): string {
  if (v === null || v === undefined || v === '') return '—'
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  return String(v)
}

/** The case's row as the watch saw it when it fired: each column and its value. */
export function CaseValues({ columns, row }: { columns: readonly string[]; row: readonly AiCell[] }) {
  if (columns.length === 0) return <p className="text-sm text-muted">The case carried no columns.</p>
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-2 rounded-2xl bg-slate-50 p-3 ring-1 ring-slate-200/70 dark:bg-slate-800/40 dark:ring-slate-800 sm:grid-cols-2">
      {columns.map((c, i) => (
        <div key={`${c}-${i}`} className="min-w-0">
          <dt className="truncate text-[11px] font-semibold uppercase tracking-wide text-muted" dir="auto" data-tip={c}>
            {c}
          </dt>
          <dd className="break-words text-sm font-medium tabular-nums" dir="auto">
            {caseCellText(row[i])}
          </dd>
        </div>
      ))}
    </dl>
  )
}
