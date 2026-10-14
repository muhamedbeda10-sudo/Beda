// ============================================================================
// §20 — Slow queries, on the assistant's settings page, for its owner alone
// (the page and GET /ai/slow-queries both refuse anyone else): every query of
// the assistant that took 10 seconds or more in the last 90 days — where it
// ran, for whom, what it was for, how long it took and how it ended, and its
// SQL — so the heavy questions can be fixed (a view, an index) rather than
// the time limit raised.
// ============================================================================

import { useState } from 'react'
import { Check, ChevronDown, ChevronUp, Copy, Gauge, Loader2 } from 'lucide-react'
import type { AiSlowQuery, AiSlowQuerySource } from '@qc/shared/ai'
import { Badge, Button, Card, EmptyState } from '@/components/ui'
import { textDirection } from '@/lib/direction'
import { cn, formatDateTime } from '@/lib/utils'
import { useAiSlowQueries } from '@/services/queries'
import { Notice } from './AiNotice'

/** Where a query ran, as the list says it. */
export const SLOW_QUERY_SOURCE: Record<AiSlowQuerySource, string> = {
  chat: 'Chat',
  report: 'Saved report',
  'scheduled-report': 'Scheduled report',
  excel: 'Excel file',
  'saved-table': 'Saved table',
  export: 'Export to Excel',
  automation: 'Automation',
  other: 'Other',
}

/** How long a query took, as people say it: "12.3 s", "1 min 2 s". */
export function slowQueryDuration(ms: number): string {
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)} s`
  return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`
}

export function AiSlowQueriesSection({ enabled }: { enabled: boolean }) {
  const { data, isLoading, isError, refetch } = useAiSlowQueries(enabled)
  const queries = data?.queries ?? []
  const timedOut = queries.filter((q) => q.outcome === 'timeout').length

  return (
    <section className="space-y-3" aria-label="Slow queries">
      <div className="pt-2">
        <h2 className="text-lg font-bold">Slow queries</h2>
        <p className="text-sm text-muted">
          Every query of the assistant that took {data?.thresholdSeconds ?? 10} seconds or more in the last 90 days. A query stops at{' '}
          {data?.limitSeconds ?? 60} seconds. The same slow question coming back usually means a view or an index to fix, not a longer limit.
        </p>
      </div>

      {isLoading && (
        <p className="flex items-center gap-2 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </p>
      )}
      {isError && !data && (
        <Notice tone="red" action={<Button className="h-8 min-h-0 px-3 py-0 text-xs" onClick={() => void refetch()}>Try again</Button>}>
          The slow queries could not be loaded.
        </Notice>
      )}
      {data && queries.length === 0 && (
        <Card>
          <EmptyState icon={<Gauge className="h-10 w-10" />} title="No slow queries" hint={`No query of the assistant has taken ${data.thresholdSeconds} seconds or more.`} />
        </Card>
      )}
      {queries.length > 0 && (
        <>
          <p className="text-sm text-muted">
            {queries.length} {queries.length === 1 ? 'query' : 'queries'}
            {timedOut > 0 ? `, ${timedOut} stopped at the limit` : ''}. Newest first.
          </p>
          <Card className="overflow-hidden">
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {queries.map((q) => (
                <SlowQueryRow key={q.id} query={q} />
              ))}
            </ul>
          </Card>
        </>
      )}
    </section>
  )
}

/** One query: what it was for, where, for whom, when; how long and how it ended; its SQL when opened. */
function SlowQueryRow({ query: q }: { query: AiSlowQuery }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const meta = [SLOW_QUERY_SOURCE[q.source], q.userName, formatDateTime(q.at), q.rowCount !== null ? `${q.rowCount.toLocaleString('en-US')} rows` : null].filter(Boolean)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(q.sql)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-start gap-3 px-4 py-3 text-start transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/40 touch:min-h-[56px]"
      >
        <span className="min-w-0 flex-1">
          <span dir={textDirection(q.purpose ?? '') ?? 'auto'} className={cn('block min-w-0 break-words text-start text-sm font-medium', !open && 'line-clamp-1')}>
            {q.purpose || 'A query'}
          </span>
          <span className="mt-0.5 block text-xs text-muted">{meta.join(' · ')}</span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          <span className="text-sm font-bold tabular-nums">{slowQueryDuration(q.durationMs)}</span>
          {q.outcome === 'timeout' ? <Badge tone="red">Stopped at the limit</Badge> : q.outcome === 'error' ? <Badge tone="amber">Failed</Badge> : null}
        </span>
        {open ? <ChevronUp aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-muted" /> : <ChevronDown aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-muted" />}
      </button>
      {open && (
        <div className="space-y-2 px-4 pb-3">
          {q.error && <p className="text-xs text-rose-700 dark:text-rose-300">{q.error}</p>}
          <div className="relative">
            <pre dir="ltr" className="max-h-72 overflow-auto rounded-xl bg-slate-50 p-3 pe-12 text-xs leading-relaxed text-slate-800 ring-1 ring-slate-200 dark:bg-slate-900/60 dark:text-slate-200 dark:ring-slate-800">
              {q.sql}
            </pre>
            <button
              type="button"
              onClick={() => void copy()}
              aria-label="Copy the SQL"
              data-tip={copied ? 'Copied' : 'Copy the SQL'}
              className="absolute end-2 top-2 grid h-8 w-8 place-items-center rounded-lg bg-white text-slate-500 ring-1 ring-slate-200 hover:text-brand-700 dark:bg-slate-800 dark:ring-slate-700 touch:h-11 touch:w-11"
            >
              {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
            </button>
          </div>
        </div>
      )}
    </li>
  )
}
