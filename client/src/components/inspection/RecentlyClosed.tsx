// ============================================================================
// The sessions closed today, under the board: what the floor finished since
// the factory's day began, so a quiet board still says what was done. Read
// from History (closed sessions started or sampled since yesterday), kept to
// those whose close falls on today in the factory's time zone.
// ============================================================================

import { useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { CheckCircle2, ChevronRight } from 'lucide-react'
import { Badge } from '@/components/ui'
import { SessionToneBadge } from '@/components/inspection/SessionTone'
import { useHistory } from '@/services/queries'
import { useAuth } from '@/store/AuthContext'
import { isStockOrder, sessionTone } from '@/domain'
import { sessionDetailPath } from '@/lib/links'
import { cn, dayInTimeZone, formatFullTimestamp, formatTime } from '@/lib/utils'
import type { HistoryFilters } from '@qc/shared/api'

/** The most the panel lists; the rest are a click away in History. */
const SHOWN = 8
/** Enough for a busy day's closes; a session closed today was started or sampled since yesterday in all but rare cases. */
const FETCH = 200
const DAY_MS = 86_400_000

export function RecentlyClosed({ machineName }: { machineName: (code: string) => string }) {
  const navigate = useNavigate()
  const { factoryTimeZone } = useAuth()
  const now = Date.now()
  const today = dayInTimeZone(new Date(now), factoryTimeZone)
  const yesterday = dayInTimeZone(new Date(now - DAY_MS), factoryTimeZone)
  const filters = useMemo<HistoryFilters>(() => ({ status: 'Closed', from: yesterday, to: today }), [yesterday, today])
  const { data, isLoading, isError } = useHistory(filters, FETCH)

  const closed = useMemo(
    () =>
      (data?.sessions ?? [])
        .filter((s) => s.closedAt && dayInTimeZone(new Date(s.closedAt), factoryTimeZone) === today)
        .sort((a, b) => ((a.closedAt ?? '') < (b.closedAt ?? '') ? 1 : -1)),
    [data, factoryTimeZone, today],
  )
  const shown = closed.slice(0, SHOWN)

  return (
    <section aria-labelledby="recently-closed-title" className="space-y-2">
      <div className="flex items-center gap-2 border-b border-slate-200 pb-1.5 dark:border-slate-800">
        <CheckCircle2 className="h-3.5 w-3.5 text-muted" />
        <h2 id="recently-closed-title" className="text-xs font-bold uppercase tracking-wide text-muted">
          Recently closed · today
        </h2>
        {!isLoading && !isError && <span className="rounded-md bg-slate-200/70 px-1.5 text-[11px] font-semibold tabular-nums leading-[18px] text-muted dark:bg-slate-800">{closed.length}</span>}
        <Link to="/history" className="ml-auto inline-flex min-h-[32px] items-center gap-0.5 rounded-md px-1 text-13 font-semibold text-brand-600 hover:underline dark:text-brand-400 touch:min-h-[44px]">
          All in History <ChevronRight className="h-3.5 w-3.5" />
        </Link>
      </div>
      {isLoading ? (
        <p className="py-2 text-13 text-muted">Loading the sessions closed today…</p>
      ) : isError ? (
        <p className="py-2 text-13 text-muted">The sessions closed today could not be loaded. They are in History.</p>
      ) : closed.length === 0 ? (
        <p className="py-2 text-13 text-muted">No session has been closed yet today.</p>
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-[11px] font-semibold uppercase tracking-wide text-muted dark:bg-slate-800/60">
                <tr>
                  <th className="px-3 py-2">Closed</th>
                  <th className="px-3 py-2">Order</th>
                  <th className="hidden px-3 py-2 md:table-cell">Item</th>
                  <th className="hidden px-3 py-2 sm:table-cell">Machine</th>
                  <th className="hidden px-3 py-2 lg:table-cell">Inspector</th>
                  <th className="px-3 py-2">Signal</th>
                  <th className="px-3 py-2 text-right">Final qty</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {shown.map((s) => (
                  <tr
                    key={s.id}
                    tabIndex={0}
                    onClick={() => navigate(sessionDetailPath(s.id))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        navigate(sessionDetailPath(s.id))
                      }
                    }}
                    aria-label={`Session #${s.seq} of ${s.order?.orderNumber ?? 'stock'}, closed today`}
                    className="data-row cursor-pointer hover:bg-slate-50 focus:outline-none focus-visible:bg-info-50 dark:hover:bg-slate-800/50 dark:focus-visible:bg-[#16233f]"
                  >
                    <td className="whitespace-nowrap px-3 tabular-nums text-muted">
                      {/* Today's closes need only the time; the whole moment is in the tooltip. */}
                      <time dateTime={s.closedAt} data-tip={formatFullTimestamp(s.closedAt)}>
                        {formatTime(s.closedAt)}
                      </time>
                    </td>
                    <td className="whitespace-nowrap px-3 font-bold">
                      {isStockOrder(s.order) ? <Badge tone="violet">For stock</Badge> : (s.order?.orderNumber ?? '—')}
                      <span className="ml-2 text-xs font-medium tabular-nums text-muted">#{s.seq}</span>
                    </td>
                    <td className="hidden max-w-[16rem] truncate px-3 md:table-cell" data-tip={s.order?.item || undefined}>
                      {s.order?.item || '—'}
                    </td>
                    <td className="hidden max-w-[14rem] truncate px-3 sm:table-cell">{machineName(s.workCenterCode)}</td>
                    <td className="hidden px-3 lg:table-cell">{s.inspectorName}</td>
                    <td className="px-3">
                      {sessionTone(s) ? <SessionToneBadge session={s} compact /> : <span className="text-muted">—</span>}
                    </td>
                    <td className={cn('px-3 text-right tabular-nums', s.finalQty === 0 && 'text-muted')}>{s.finalQty ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {closed.length > SHOWN && (
            <Link to="/history" className="flex min-h-[40px] items-center justify-center gap-1 border-t border-slate-100 text-13 font-semibold text-brand-600 hover:bg-slate-50 dark:border-slate-800 dark:text-brand-400 dark:hover:bg-slate-800/50">
              {closed.length - SHOWN} more closed today, in History <ChevronRight className="h-3.5 w-3.5" />
            </Link>
          )}
        </div>
      )}
    </section>
  )
}
