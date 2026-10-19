// ============================================================================
// §21 — the bell: the person's alerts, what automations and follow-ups told
// them (AlertList), with how many are not opened yet. Polls every few
// minutes while the tab is open; nothing pushes. Notices are not in it: they
// have their own button beside it (NoticesButton, §16). And their follow-ups
// not done (BellFollowUps), for whoever has some: the bell is where the
// Follow-ups page is opened from, with the count of their open ones on its
// tab (red once one is overdue). That count is not in the bell's own: an
// open follow-up is work, not something unread. The same for Tasks
// (BellTasks): the ones to do, and the dones waiting for the sender.
//
// The scheduled reports delivered have their own tab, Reports, apart from the
// alerts: a report is read at leisure, an alert acted on, and a day's reports
// would bury the alerts. Its unread ones count on the bell like any alert.
// ============================================================================

import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Bell, BellRing, FileChartColumn, ListChecks, ListTodo } from 'lucide-react'
import { Drawer } from '@/components/ui'
import { trimNotifications, useNotifications } from '@/services/notifications'
import { followUpKeys, useFollowUpCounts } from '@/services/followUps'
import { taskKeys, useTaskCounts } from '@/services/tasks'
import { useAuth } from '@/store/AuthContext'
import { cn } from '@/lib/utils'
import { AlertList } from './AlertList'
import { BellFollowUps } from './BellFollowUps'
import { BellTasks } from './BellTasks'
import { BellTabs, type BellTabItem } from './BellTabs'
import { CountBadge } from '@/components/ui/CountBadge'
import { unreadAlerts } from './alerts'

type BellTab = 'alerts' | 'reports' | 'follow-ups' | 'tasks'

export function NoticeBell({ className }: { className?: string }) {
  const qc = useQueryClient()
  const { profile, role } = useAuth()
  const { data: alertPages } = useNotifications('alerts')
  const { data: reportPages } = useNotifications('reports')
  const { data: followUps } = useFollowUpCounts(!!profile)
  const { data: tasks } = useTaskCounts(!!profile)
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<BellTab>('alerts')
  const unread = unreadAlerts(alertPages)
  const unreadReports = unreadAlerts(reportPages)
  const total = unread + unreadReports
  const hasFollowUps = followUps?.visible ?? false
  // Tasks are sent to everyone but read-only viewers; a viewer who may send them has them too.
  const hasTasks = role !== 'viewer' || (tasks?.canCreate ?? false)
  const tasksWaiting = (tasks?.assignedOpen ?? 0) + (tasks?.toConfirm ?? 0)
  const tabs: BellTabItem<BellTab>[] = [
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

  // The alerts not opened come first, then the reports; then tasks and overdue follow-ups.
  const openBell = () => {
    setTab(unread > 0 ? 'alerts' : unreadReports > 0 ? 'reports' : hasTasks && tasksWaiting > 0 ? 'tasks' : hasFollowUps && (followUps?.mineOverdue ?? 0) > 0 ? 'follow-ups' : 'alerts')
    setOpen(true)
  }
  const close = () => {
    setOpen(false)
    // Only the newest page of alerts is polled from now on.
    trimNotifications(qc)
  }

  const label = 'Alerts and reports'
  const open_ = followUps?.mineOpen ?? 0
  const overdue = followUps?.mineOverdue ?? 0
  const listUnread = shown === 'reports' ? unreadReports : unread
  const subtitle =
    shown === 'alerts' || shown === 'reports'
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
  const title = shown === 'alerts' ? 'Alerts' : shown === 'reports' ? 'Reports' : shown === 'tasks' ? 'Tasks' : 'Follow-ups'
  const icon =
    shown === 'alerts' ? (
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
      <button type="button" onClick={openBell} className={cn('icon-btn relative', className)} aria-label={total > 0 ? `${label}, ${total} not opened` : label} data-tip="Alerts">
        <Bell className={cn('h-5 w-5', total > 0 && 'animate-[wiggle_1.2s_ease-in-out_1]')} />
        <CountBadge count={total} />
      </button>
      <Drawer open={open} onClose={close} title={title} subtitle={subtitle} icon={icon}>
        {tabs.length > 1 && <BellTabs label="What the bell holds" tabs={tabs} value={shown} onChange={setTab} className="mb-4" />}
        {shown === 'alerts' || shown === 'reports' ? (
          // Keyed by tab: each list keeps its own state (an alert expanded) rather than the other's.
          <AlertList key={shown} category={shown} onLeave={close} />
        ) : shown === 'follow-ups' ? (
          <BellFollowUps onLeave={close} />
        ) : (
          <BellTasks onLeave={close} sender={tasks?.canCreate ?? false} />
        )}
      </Drawer>
    </>
  )
}
