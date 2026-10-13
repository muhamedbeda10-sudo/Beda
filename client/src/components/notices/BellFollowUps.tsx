// ============================================================================
// §21 — the bell's Follow-ups: the person's own that are not done (given to
// them, or opened by their automations), overdue first then by deadline, as
// the Follow-ups page lists them. One opens over that page; the page itself,
// with its filters and everyone's for those who may see them, is a tap away.
// ============================================================================

import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, ListChecks, Loader2, MessageSquareText } from 'lucide-react'
import type { FollowUp } from '@qc/shared/automation'
import { EmptyState } from '@/components/ui'
import { DueText, FollowUpStatusBadge } from '@/components/followUps/parts'
import type { FollowUpFilters } from '@/components/followUps/wording'
import { textDirection } from '@/lib/direction'
import { cn } from '@/lib/utils'
import { useFollowUps } from '@/services/followUps'
import { useAuth } from '@/store/AuthContext'

const MINE_ACTIVE: FollowUpFilters = { scope: 'mine', status: 'active', overdue: false, automationId: null }

export function BellFollowUps({ onLeave }: { onLeave: () => void }) {
  const { factoryTimeZone: tz } = useAuth()
  const { data, isLoading, isError, refetch } = useFollowUps(MINE_ACTIVE)
  const rows = useMemo(() => {
    const seen = new Set<string>()
    const out: FollowUp[] = []
    for (const page of data?.pages ?? []) {
      for (const f of page.followUps) {
        if (seen.has(f.id)) continue
        seen.add(f.id)
        out.push(f)
      }
    }
    return out
  }, [data])
  const more = data?.pages.at(-1)?.hasMore ?? false

  return (
    <div className="space-y-3">
      {isLoading && (
        <p className="flex items-center gap-2 py-8 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </p>
      )}
      {isError && !data && (
        <p className="text-sm text-rose-700 dark:text-rose-300">
          The follow-ups could not be loaded.{' '}
          <button type="button" onClick={() => void refetch()} className="font-semibold underline underline-offset-2">
            Try again
          </button>
        </p>
      )}
      {!isLoading && data && rows.length === 0 && <EmptyState icon={<ListChecks className="h-10 w-10" />} title="No open follow-ups" hint="Follow-ups given to you, or opened by your automations, show here until they are done." />}
      {rows.length > 0 && (
        <ul className="space-y-2">
          {rows.map((f) => (
            <li key={f.id}>
              <Link
                to={`/follow-ups/${encodeURIComponent(f.id)}`}
                onClick={onLeave}
                className={cn(
                  'block rounded-2xl px-3 py-2.5 ring-1 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50',
                  f.overdue ? 'ring-rose-200 dark:ring-rose-500/30' : 'ring-slate-200/70 dark:ring-slate-800',
                )}
              >
                <span dir={textDirection(f.title) ?? 'auto'} className="line-clamp-2 break-words text-start text-sm font-semibold text-slate-800 dark:text-slate-100">
                  {f.title}
                </span>
                <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                  <FollowUpStatusBadge status={f.status} />
                  <DueText followUp={f} timeZone={tz} />
                  {f.commentCount > 0 && (
                    <span className="inline-flex items-center gap-1">
                      <MessageSquareText className="h-3.5 w-3.5" /> {f.commentCount}
                    </span>
                  )}
                  {f.automationName && (
                    <span dir="auto" className="min-w-0 truncate">
                      {f.automationName}
                    </span>
                  )}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Link to="/follow-ups" onClick={onLeave} className="inline-flex min-h-[40px] items-center gap-1 text-13 font-semibold text-brand-700 hover:underline dark:text-brand-300">
        {more ? 'See them all on the Follow-ups page' : 'Open the Follow-ups page'} <ArrowRight className="h-3.5 w-3.5 rtl:rotate-180" />
      </Link>
    </div>
  )
}
