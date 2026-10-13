// ============================================================================
// §21 — the bell's alerts: what automations and follow-ups told this person,
// and the assistant's answers that finished while they were away (§20).
// The ones not opened yet first, then the earlier ones, newest first, a page
// at a time. Opening one reads it and goes where it leads (a follow-up, a
// session, a delivered report); one that leads nowhere opens in place.
//
// The same list serves the bell's Reports tab: the scheduled reports
// delivered, apart from the alerts, with their own count and their own
// "Mark all as read".
// ============================================================================

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { BellRing, CheckCheck, ChevronRight, FileChartColumn, Loader2 } from 'lucide-react'
import type { UserNotification, UserNotificationCategory } from '@qc/shared/automation'
import { Button, EmptyState } from '@/components/ui'
import { markAllNotificationsRead, markNotificationRead, useNotifications } from '@/services/notifications'
import { useApp } from '@/store/AppContext'
import { cn, formatFullTimestamp, timeAgo } from '@/lib/utils'
import { textDirection } from '@/lib/direction'
import { SEVERITY_META } from './NoticeCard'
import { ALERT_KIND_LABEL, alertTarget, alertsOf, splitAlerts, unreadAlerts } from './alerts'

function AlertRow({ alert: n, onOpen, onLeave }: { alert: UserNotification; onOpen: (n: UserNotification) => void; onLeave: () => void }) {
  const [expanded, setExpanded] = useState(false)
  const target = alertTarget(n)
  const unread = n.readAt === null
  const m = SEVERITY_META[n.severity]
  const body = (
    <>
      <span className={cn('mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl', unread ? m.iconBg : 'bg-slate-100 text-muted dark:bg-slate-800')}>
        <m.icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        {/* line-clamp sets its own display: `block` only while expanded, or it would undo the clamp. The direction
            comes from the letters: the values automations write are set apart with isolates, which dir="auto" skips. */}
        <span dir={textDirection(n.title) ?? 'auto'} className={cn('text-sm', unread ? 'font-bold' : 'font-semibold text-slate-600 dark:text-slate-300', expanded ? 'block' : 'line-clamp-2')}>
          {n.title}
        </span>
        {n.body && (
          <span dir={textDirection(n.body) ?? 'auto'} className={cn('mt-0.5 whitespace-pre-line break-words text-xs text-slate-600 dark:text-slate-300', expanded ? 'block' : 'line-clamp-3')}>
            {n.body}
          </span>
        )}
        <span className="mt-1 block text-xs text-muted">
          {ALERT_KIND_LABEL[n.kind]} · <time dateTime={n.createdAt} data-tip={formatFullTimestamp(n.createdAt)}>{timeAgo(n.createdAt)}</time>
        </span>
      </span>
      {unread && <span className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full bg-brand-600 dark:bg-brand-400" aria-label="Not opened yet" />}
      {target && <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted rtl:rotate-180" aria-hidden />}
    </>
  )
  const rowClass = cn(
    'flex w-full items-start gap-3 rounded-2xl px-3 py-3 text-left ring-1 transition-colors hover:bg-slate-50/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:hover:bg-slate-800/40',
    unread ? m.ring : 'ring-slate-200/70 dark:ring-slate-800',
  )
  return (
    <li>
      {target ? (
        <Link
          to={target}
          className={rowClass}
          onClick={() => {
            onOpen(n)
            onLeave()
          }}
        >
          {body}
        </Link>
      ) : (
        <button
          type="button"
          className={rowClass}
          aria-expanded={expanded}
          onClick={() => {
            setExpanded((v) => !v)
            onOpen(n)
          }}
        >
          {body}
        </button>
      )}
    </li>
  )
}

/** What each list says of itself. */
const WORDING: Record<UserNotificationCategory, { icon: ReactNode; loadFailed: string; empty: string; emptyHint: string; markFailed: string }> = {
  alerts: {
    icon: <BellRing className="h-10 w-10" />,
    loadFailed: 'The alerts could not be loaded',
    empty: 'No alerts',
    emptyHint: 'What automations find for you, follow-ups given to you, and the assistant’s answers that finish while you are away show here.',
    markFailed: 'Could not mark the alerts as read.',
  },
  reports: {
    icon: <FileChartColumn className="h-10 w-10" />,
    loadFailed: 'The reports could not be loaded',
    empty: 'No reports',
    emptyHint: 'Scheduled reports sent to you show here.',
    markFailed: 'Could not mark the reports as read.',
  },
}

/** One list of the bell: its alerts, or its reports. `onLeave` closes the bell when one takes the reader elsewhere. */
export function AlertList({ category, onLeave }: { category: UserNotificationCategory; onLeave: () => void }) {
  const qc = useQueryClient()
  const { toast } = useApp()
  const words = WORDING[category]
  const { data, isLoading, isError, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } = useNotifications(category)
  const [marking, setMarking] = useState(false)
  const list = alertsOf(data)
  const { unread, earlier } = splitAlerts(list)
  const unreadCount = unreadAlerts(data)

  const open = (n: UserNotification) => {
    if (n.readAt !== null) return
    void markNotificationRead(qc, n).catch(() => undefined)
  }
  const readAll = async () => {
    setMarking(true)
    try {
      await markAllNotificationsRead(qc, category)
    } catch (e) {
      toast(e instanceof Error ? e.message : words.markFailed, 'error')
    } finally {
      setMarking(false)
    }
  }

  if (isLoading) {
    return (
      <p className="flex items-center gap-2 py-8 text-sm text-muted">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </p>
    )
  }
  if (isError && !data) {
    return <EmptyState icon={words.icon} title={words.loadFailed} hint="Check the connection and try again." action={<Button onClick={() => void refetch()}>Try again</Button>} />
  }
  if (list.length === 0) {
    return <EmptyState icon={words.icon} title={words.empty} hint={words.emptyHint} />
  }
  return (
    <div className="space-y-5">
      {(unread.length > 0 || unreadCount > 0) && (
        <section className="space-y-2">
          <div className="flex min-h-[32px] items-center justify-between gap-2">
            <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-muted">{unread.length > 0 ? 'Not opened yet' : ''}</p>
            {/* Every one of this list not opened, whether its page is loaded or not. */}
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={() => void readAll()}
                disabled={marking}
                className="inline-flex min-h-[32px] items-center gap-1.5 rounded-lg px-2 text-xs font-semibold text-brand-700 hover:bg-brand-50 disabled:opacity-50 dark:text-brand-300 dark:hover:bg-brand-500/10 touch:min-h-[44px]"
              >
                {marking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCheck className="h-3.5 w-3.5" />} Mark all as read
              </button>
            )}
          </div>
          {unread.length > 0 && (
            <ul className="space-y-2">
              {unread.map((n) => (
                <AlertRow key={n.id} alert={n} onOpen={open} onLeave={onLeave} />
              ))}
            </ul>
          )}
        </section>
      )}
      {earlier.length > 0 && (
        <section className="space-y-2">
          <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-muted">Earlier</p>
          <ul className="space-y-2">
            {earlier.map((n) => (
              <AlertRow key={n.id} alert={n} onOpen={open} onLeave={onLeave} />
            ))}
          </ul>
        </section>
      )}
      {hasNextPage && (
        <div className="flex justify-center">
          <Button onClick={() => void fetchNextPage()} disabled={isFetchingNextPage} className="min-h-[44px]">
            {isFetchingNextPage && <Loader2 className="h-4 w-4 animate-spin" />} {isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
    </div>
  )
}
