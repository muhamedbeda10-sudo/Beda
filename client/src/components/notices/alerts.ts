// ============================================================================
// §21 — the bell's alerts: what automations, follow-ups, tasks and the
// assistant (an answer that ended while its asker was away) tell one person
// (UserNotification), beside the quality office's notices. Each is read when
// opened and leads to a page of the app; the bell's count is the notices to
// read and the alerts not opened yet together. Pure helpers, so the bell and
// its tests share them.
// ============================================================================

import type { InfiniteData } from '@tanstack/react-query'
import type { UserNotification, UserNotificationKind, UserNotificationsResponse } from '@qc/shared/automation'
import { appPath } from '@/lib/links'

export const ALERT_KIND_LABEL: Record<UserNotificationKind, string> = {
  'automation-case': 'Automation',
  'automation-digest': 'Automation',
  'automation-report': 'Scheduled report',
  'automation-stopped': 'Automation stopped',
  'follow-up-assigned': 'Follow-up assigned',
  'follow-up-overdue': 'Follow-up overdue',
  'follow-up-updated': 'Follow-up updated',
  'task-assigned': 'New task',
  'task-updated': 'Task updated',
  'task-done': 'Task done: confirm it',
  'task-reopened': 'Task sent back',
  'ai-answer': 'AI assistant',
  'report-shared': 'Report shared with you',
  'planning-alert': 'Planning',
}

export { badgeText } from '@/components/ui/CountBadge'

/** Where an alert leads: a page of this app, or nowhere (its words are all there is). */
export const alertTarget = (n: Pick<UserNotification, 'link'>): string | null => appPath(n.link)

/** The pages read so far as one list: each alert once, newest first. */
export function alertsOf(data: InfiniteData<UserNotificationsResponse> | undefined): UserNotification[] {
  const seen = new Set<string>()
  const out: UserNotification[] = []
  for (const page of data?.pages ?? []) {
    for (const n of page.notifications) {
      if (seen.has(n.id)) continue
      seen.add(n.id)
      out.push(n)
    }
  }
  return out.sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1))
}

/** Not opened yet first, then the earlier ones; each newest first. */
export function splitAlerts(list: readonly UserNotification[]): { unread: UserNotification[]; earlier: UserNotification[] } {
  return { unread: list.filter((n) => n.readAt === null), earlier: list.filter((n) => n.readAt !== null) }
}

/** The count of alerts not opened, as the server last said it (the newest page says it). */
export const unreadAlerts = (data: InfiniteData<UserNotificationsResponse> | undefined): number => data?.pages[0]?.unreadCount ?? 0

/** One alert opened: read in every page that holds it, and one fewer unread. */
export function withAlertRead(data: InfiniteData<UserNotificationsResponse> | undefined, id: string, at: string): InfiniteData<UserNotificationsResponse> | undefined {
  if (!data) return data
  const wasUnread = data.pages.some((p) => p.notifications.some((n) => n.id === id && n.readAt === null))
  if (!wasUnread) return data
  return {
    ...data,
    pages: data.pages.map((p) => ({
      ...p,
      unreadCount: Math.max(0, p.unreadCount - 1),
      notifications: p.notifications.map((n) => (n.id === id && n.readAt === null ? { ...n, readAt: at } : n)),
    })),
  }
}

/** Every alert read at once. */
export function withAllAlertsRead(data: InfiniteData<UserNotificationsResponse> | undefined, at: string): InfiniteData<UserNotificationsResponse> | undefined {
  if (!data) return data
  return {
    ...data,
    pages: data.pages.map((p) => ({ ...p, unreadCount: 0, notifications: p.notifications.map((n) => (n.readAt === null ? { ...n, readAt: at } : n)) })),
  }
}

/** Back to the newest page alone: what the bell keeps polling once its list is closed. */
export function firstAlertPage(data: InfiniteData<UserNotificationsResponse> | undefined): InfiniteData<UserNotificationsResponse> | undefined {
  if (!data || data.pages.length <= 1) return data
  return { pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) }
}
