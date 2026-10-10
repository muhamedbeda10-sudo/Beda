// ============================================================================
// §21 — "Needs review" on a session's page in History: the follow-ups linked
// to it that are not done, each opening where it is worked. Someone who sees
// only their own follow-ups is told how many others are open as well.
// ============================================================================

import { Link } from 'react-router-dom'
import { Flag, Loader2 } from 'lucide-react'
import { Section } from '@/components/inspection/SampleDetail'
import { useFollowUpCounts, useSessionFollowUps } from '@/services/followUps'
import { useAuth } from '@/store/AuthContext'
import { DueText, FollowUpStatusBadge } from './parts'
import { textDirection } from '@/lib/direction'

export function SessionFollowUps({ sessionId, openCount }: { sessionId: string; openCount: number }) {
  const { factoryTimeZone: tz } = useAuth()
  const { data: counts, isError: countsFailed } = useFollowUpCounts(openCount > 0)
  const scope = counts?.all ? 'all' : 'mine'
  const { data, isLoading, isError } = useSessionFollowUps(sessionId, scope, openCount > 0 && (counts !== undefined || countsFailed))
  if (openCount <= 0) return null
  const list = data?.followUps ?? []
  const others = Math.max(0, openCount - list.length)
  return (
    <Section icon={<Flag className="h-4 w-4 text-amber-600 dark:text-amber-400" />} title="Needs review" count={openCount}>
      <div className="rounded-2xl bg-amber-50/70 p-3 ring-1 ring-amber-200 dark:bg-amber-500/10 dark:ring-amber-500/25">
        <p className="text-sm text-amber-900 dark:text-amber-200">
          {openCount === 1 ? 'A follow-up on this session is not done yet.' : `${openCount} follow-ups on this session are not done yet.`} The mark goes once{' '}
          {openCount === 1 ? 'it is' : 'they are'} closed.
        </p>
        {isLoading ? (
          <p className="mt-2 flex items-center gap-2 text-sm text-muted">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </p>
        ) : isError ? (
          <p className="mt-2 text-sm text-muted">The follow-ups could not be loaded.</p>
        ) : (
          <>
            {list.length > 0 && (
              <ul className="mt-2 space-y-1.5">
                {list.map((f) => (
                  <li key={f.id}>
                    <Link
                      to={`/follow-ups/${encodeURIComponent(f.id)}`}
                      className="flex min-h-[44px] flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-white px-3 py-2 ring-1 ring-amber-200/80 transition-colors hover:bg-amber-50 dark:bg-slate-900 dark:ring-amber-500/25 dark:hover:bg-slate-800"
                    >
                      {/* A phone gives the title its own line; the rest follows under it. */}
                      <span dir={textDirection(f.title) ?? 'auto'} className="w-full min-w-0 truncate text-sm font-semibold text-slate-800 dark:text-slate-100 sm:w-auto sm:flex-1">
                        {f.title}
                      </span>
                      <FollowUpStatusBadge status={f.status} />
                      <span dir="auto" className="text-xs text-muted">
                        {f.assignee?.name ?? 'Nobody'}
                      </span>
                      <DueText followUp={f} timeZone={tz} className="text-xs" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {others > 0 && (
              <p className="mt-2 text-xs text-muted">
                {list.length > 0 ? `${others} more ${others === 1 ? 'is' : 'are'} with other people.` : `${others === 1 ? 'It is' : 'They are'} with other people.`}
              </p>
            )}
          </>
        )}
      </div>
    </Section>
  )
}
