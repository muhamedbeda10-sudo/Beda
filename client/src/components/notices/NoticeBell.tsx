// ============================================================================
// §16 — the bell. A count of what is still to be read, and the list behind
// it: what needs attention first, then everything earlier as an archive.
// Polls every few minutes while the tab is open; nothing pushes.
//
// §21 — beside the notices, the person's alerts: what automations and
// follow-ups told them (AlertList). The count on the bell is both together;
// the notices themselves read and acknowledge exactly as before. Someone who
// receives no notices (a viewer) has the alerts alone. And their follow-ups
// not done (BellFollowUps), for whoever has some: the bell is where the
// Follow-ups page is opened from, with the count of their open ones on its
// tab (red once one is overdue). That count is not in the bell's own: an
// open follow-up is work, not something unread. The same for Tasks
// (BellTasks): the ones to do, and the dones waiting for the sender. Those
// who write notices open the Notices page from the Notices tab.
//
// The scheduled reports delivered have their own tab, Reports, apart from the
// alerts: a report is read at leisure, an alert acted on, and a day's reports
// would bury the alerts. Its unread ones count on the bell like any alert.
// ============================================================================

import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { can } from '@qc/shared/rules'
import { ArrowRight, Bell, BellRing, Check, ChevronDown, ChevronUp, FileChartColumn, ListChecks, ListTodo, Loader2, Megaphone } from 'lucide-react'
import type { NoticeForUser } from '@qc/shared/types'
import { Badge, Button, Drawer, EmptyState } from '@/components/ui'
import { useNoticeInbox } from '@/services/queries'
import { acknowledgeNotice, markNoticeSeen } from '@/services/mutations'
import { trimNotifications, useNotifications } from '@/services/notifications'
import { followUpKeys, useFollowUpCounts } from '@/services/followUps'
import { taskKeys, useTaskCounts } from '@/services/tasks'
import { useAuth } from '@/store/AuthContext'
import { useApp } from '@/store/AppContext'
import { cn, timeAgo } from '@/lib/utils'
import { textDirection } from '@/lib/direction'
import { NoticeCard, SEVERITY_META, validityText } from './NoticeCard'
import { AlertList } from './AlertList'
import { BellFollowUps } from './BellFollowUps'
import { BellTasks } from './BellTasks'
import { BellTabs, type BellTabItem } from './BellTabs'
import { badgeText, bellCount, unreadAlerts } from './alerts'

type BellTab = 'notices' | 'alerts' | 'reports' | 'follow-ups' | 'tasks'

function InboxRow({ notice, open, onToggle }: { notice: NoticeForUser; open: boolean; onToggle: () => void }) {
  const qc = useQueryClient()
  const { toast } = useApp()
  const [busy, setBusy] = useState(false)
  const m = SEVERITY_META[notice.severity]
  const ack = async () => {
    setBusy(true)
    try {
      await acknowledgeNotice(qc, notice.id)
      toast('Acknowledged.', 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not acknowledge.', 'error')
    } finally {
      setBusy(false)
    }
  }
  const badge = notice.pending ? <Badge tone={notice.requiresAck ? 'violet' : 'blue'}>{notice.requiresAck ? 'Acknowledge' : 'New'}</Badge> : null
  return (
    <li className={cn('rounded-2xl ring-1 transition-shadow', notice.pending ? m.ring : 'ring-slate-200/70 dark:ring-slate-800', open && 'shadow-card')}>
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-start gap-3 rounded-2xl px-3 py-3 text-left hover:bg-slate-50/70 dark:hover:bg-slate-800/40">
        <span className={cn('mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl', notice.pending ? m.iconBg : 'bg-slate-100 text-muted dark:bg-slate-800')}>
          <m.icon className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          {/* The title in its own direction (an Arabic one starts at the right, its end clipped, not its start), on two
              lines at most while folded, and whole once open: the card under it leaves its own title out. */}
          <span
            dir={textDirection(notice.title) ?? 'auto'}
            className={cn('break-words text-start text-sm', open ? 'block' : 'line-clamp-2', notice.pending ? 'font-bold' : 'font-semibold text-slate-600 dark:text-slate-300')}
          >
            {notice.title}
          </span>
          {/* On a phone the badge waits on this line, under the title, so the title has the row's width. */}
          <span className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted">
            {badge && <span className="sm:hidden">{badge}</span>}
            <span>
              {timeAgo(notice.createdAt)} · <span className="whitespace-nowrap">{validityText(notice)}</span>
              {!notice.active ? ' · expired' : ''}
              {notice.acknowledgedAt ? ' · acknowledged' : notice.seenAt ? ' · read' : ''}
            </span>
          </span>
        </span>
        {badge && <span className="shrink-0 max-sm:hidden">{badge}</span>}
        {open ? <ChevronUp className="mt-1 h-4 w-4 shrink-0 text-muted" /> : <ChevronDown className="mt-1 h-4 w-4 shrink-0 text-muted" />}
      </button>
      {open && (
        <div className="px-3 pb-3 animate-page-in">
          <NoticeCard
            notice={notice}
            hideHeader
            className="ring-0 p-0 bg-transparent dark:bg-transparent"
            actions={
              notice.pending && notice.requiresAck ? (
                <Button variant="primary" onClick={ack} disabled={busy} className="min-h-[44px]">
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} I have read this — acknowledge
                </Button>
              ) : undefined
            }
          />
        </div>
      )}
    </li>
  )
}

/** `notices`: this person receives notices (by role); without, the bell holds their alerts alone. */
export function NoticeBell({ className, notices: receivesNotices = true }: { className?: string; notices?: boolean }) {
  const qc = useQueryClient()
  const { profile, role } = useAuth()
  const { data, isLoading } = useNoticeInbox(receivesNotices)
  const { data: alertPages } = useNotifications('alerts')
  const { data: reportPages } = useNotifications('reports')
  const { data: followUps } = useFollowUpCounts(!!profile)
  const { data: tasks } = useTaskCounts(!!profile)
  const manageNotices = can(role, 'manage-admin-data')
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<BellTab>('notices')
  const [expanded, setExpanded] = useState<string | null>(null)
  const pending = receivesNotices ? (data?.pendingCount ?? 0) : 0
  const unread = unreadAlerts(alertPages)
  const unreadReports = unreadAlerts(reportPages)
  const total = bellCount(pending, unread + unreadReports)
  const notices = data?.notices ?? []
  const attention = notices.filter((n) => n.pending)
  const earlier = notices.filter((n) => !n.pending)
  const hasFollowUps = followUps?.visible ?? false
  // Tasks are sent to everyone but read-only viewers; a viewer who may send them has them too.
  const hasTasks = role !== 'viewer' || (tasks?.canCreate ?? false)
  const tasksWaiting = (tasks?.assignedOpen ?? 0) + (tasks?.toConfirm ?? 0)
  const tabs: BellTabItem<BellTab>[] = [
    ...(receivesNotices ? [{ value: 'notices' as const, label: 'Notices', icon: <Megaphone className="h-4 w-4" />, count: pending }] : []),
    { value: 'alerts', label: 'Alerts', icon: <BellRing className="h-4 w-4" />, count: unread },
    { value: 'reports', label: 'Reports', icon: <FileChartColumn className="h-4 w-4" />, count: unreadReports },
    ...(hasFollowUps ? [{ value: 'follow-ups' as const, label: 'Follow-ups', icon: <ListChecks className="h-4 w-4" />, count: followUps?.mineOpen ?? 0, urgent: (followUps?.mineOverdue ?? 0) > 0 }] : []),
    ...(hasTasks ? [{ value: 'tasks' as const, label: 'Tasks', icon: <ListTodo className="h-4 w-4" />, count: tasksWaiting, urgent: (tasks?.assignedOverdue ?? 0) > 0 }] : []),
  ]
  const shown: BellTab = tabs.some((t) => t.value === tab) ? tab : tabs[0].value

  // A new alert is often a follow-up or a task just given to this person: their counts are asked again with it.
  const lastUnread = useRef(unread)
  useEffect(() => {
    if (unread > lastUnread.current) {
      void qc.invalidateQueries({ queryKey: followUpKeys.counts })
      void qc.invalidateQueries({ queryKey: taskKeys.counts })
      void qc.invalidateQueries({ queryKey: taskKeys.lists })
    }
    lastUnread.current = unread
  }, [unread, qc])

  const toggle = (n: NoticeForUser) => {
    const next = expanded === n.id ? null : n.id
    setExpanded(next)
    // Opening a notice that needs no acknowledgement is reading it.
    if (next && n.pending && !n.requiresAck) void markNoticeSeen(qc, n.id).catch(() => undefined)
  }

  // Notices waiting come first (one may need acknowledging); then the alerts not opened, the reports; then tasks and overdue follow-ups.
  const openBell = () => {
    setTab(pending > 0 ? 'notices' : unread > 0 ? 'alerts' : unreadReports > 0 ? 'reports' : hasTasks && tasksWaiting > 0 ? 'tasks' : hasFollowUps && (followUps?.mineOverdue ?? 0) > 0 ? 'follow-ups' : 'notices')
    setOpen(true)
  }
  const close = () => {
    setOpen(false)
    // Only the newest page of alerts is polled from now on.
    trimNotifications(qc)
  }

  const label = receivesNotices ? 'Notices and alerts' : 'Alerts'
  const open_ = followUps?.mineOpen ?? 0
  const overdue = followUps?.mineOverdue ?? 0
  const listUnread = shown === 'reports' ? unreadReports : unread
  const subtitle =
    shown === 'notices'
      ? pending > 0
        ? `${pending} to read`
        : 'Nothing waiting for you'
      : shown === 'alerts' || shown === 'reports'
        ? listUnread > 0
          ? `${listUnread} not opened yet`
          : 'Nothing new for you'
        : shown === 'tasks'
          ? tasksWaiting > 0
            ? `${tasks?.assignedOpen ?? 0} to do${tasks?.toConfirm ? `, ${tasks.toConfirm} to confirm` : ''}`
            : 'Nothing waiting for you'
          : open_ > 0
            ? `${open_} open${overdue > 0 ? `, ${overdue} overdue` : ''}`
            : 'None open'
  const title = shown === 'notices' ? 'Notices' : shown === 'alerts' ? 'Alerts' : shown === 'reports' ? 'Reports' : shown === 'tasks' ? 'Tasks' : 'Follow-ups'
  const icon =
    shown === 'notices' ? (
      <Bell className="h-5 w-5" />
    ) : shown === 'alerts' ? (
      <BellRing className="h-5 w-5" />
    ) : shown === 'reports' ? (
      <FileChartColumn className="h-5 w-5" />
    ) : shown === 'tasks' ? (
      <ListTodo className="h-5 w-5" />
    ) : (
      <ListChecks className="h-5 w-5" />
    )

  return (
    <>
      <button type="button" onClick={openBell} className={cn('icon-btn relative', className)} aria-label={total > 0 ? `${label}, ${total} to read` : label}>
        <Bell className={cn('h-5 w-5', total > 0 && 'animate-[wiggle_1.2s_ease-in-out_1]')} />
        {total > 0 && (
          <span className="absolute -right-0.5 -top-0.5 grid min-w-[18px] place-items-center rounded-full bg-rose-600 px-1 text-[10px] font-bold leading-[18px] text-white ring-2 ring-white dark:ring-slate-900">
            {badgeText(total)}
          </span>
        )}
      </button>
      <Drawer open={open} onClose={close} title={title} subtitle={subtitle} icon={icon}>
        {tabs.length > 1 && <BellTabs label="What the bell holds" tabs={tabs} value={shown} onChange={setTab} className="mb-4" />}
        {shown === 'alerts' || shown === 'reports' ? (
          // Keyed by tab: each list keeps its own state (an alert expanded) rather than the other's.
          <AlertList key={shown} category={shown} onLeave={close} />
        ) : shown === 'follow-ups' ? (
          <BellFollowUps onLeave={close} />
        ) : shown === 'tasks' ? (
          <BellTasks onLeave={close} sender={tasks?.canCreate ?? false} />
        ) : (
          <>
            {isLoading && (
              <p className="flex items-center gap-2 py-8 text-sm text-muted">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </p>
            )}
            {!isLoading && notices.length === 0 && <EmptyState icon={<Bell className="h-10 w-10" />} title="No notices" hint="Notices from the quality office will show here." />}
            {attention.length > 0 && (
              <section className="space-y-2">
                <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-muted">Needs your attention</p>
                <ul className="space-y-2">
                  {attention.map((n) => (
                    <InboxRow key={n.id} notice={n} open={expanded === n.id} onToggle={() => toggle(n)} />
                  ))}
                </ul>
              </section>
            )}
            {earlier.length > 0 && (
              <section className={cn('space-y-2', attention.length > 0 && 'mt-5')}>
                <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-muted">Earlier</p>
                <ul className="space-y-2">
                  {earlier.map((n) => (
                    <InboxRow key={n.id} notice={n} open={expanded === n.id} onToggle={() => toggle(n)} />
                  ))}
                </ul>
              </section>
            )}
            {/* Whoever writes notices opens their page from here: to write one, change it, or see who read it. */}
            {manageNotices && (
              <Link to="/notices" onClick={close} className={cn('inline-flex min-h-[40px] items-center gap-1 text-13 font-semibold text-brand-700 hover:underline dark:text-brand-300', notices.length > 0 && 'mt-3')}>
                Open the Notices page <ArrowRight className="h-3.5 w-3.5 rtl:rotate-180" />
              </Link>
            )}
          </>
        )}
      </Drawer>
    </>
  )
}
