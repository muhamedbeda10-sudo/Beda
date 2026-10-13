// ============================================================================
// §21 — the bell's alerts through the API: what automations and follow-ups
// told this person, newest first, a page at a time, with how many are not
// opened yet. Polled like the notices (every few minutes while the tab is
// visible, never in the background). Opening one marks it read; so does
// "Mark all as read". The cache follows at once, before the server answers.
//
// Two lists, each its own query: Alerts, and Reports (the scheduled reports
// delivered). Each has its pages, its unread count and its "Mark all as read".
// ============================================================================

import { useInfiniteQuery, type InfiniteData, type QueryClient } from '@tanstack/react-query'
import {
  notificationCategory,
  USER_NOTIFICATION_CATEGORIES,
  type UserNotification,
  type UserNotificationCategory,
  type UserNotificationsResponse,
} from '@qc/shared/automation'
import { api } from '@/lib/api'
import { firstAlertPage, withAlertRead, withAllAlertsRead } from '@/components/notices/alerts'
import { NOTICE_POLL_MS } from './queries'

export const notificationKeys = {
  all: ['notifications'] as const,
  list: (category: UserNotificationCategory) => ['notifications', 'list', category] as const,
}

/** Alerts a page brings. */
const PAGE = 30

/** One list, newest first: the first page is what the bell polls; "Load more" is fetchNextPage. */
export function useNotifications(category: UserNotificationCategory, enabled = true) {
  return useInfiniteQuery({
    queryKey: notificationKeys.list(category),
    queryFn: ({ pageParam }) =>
      api<UserNotificationsResponse>(`/notifications?category=${category}&limit=${PAGE}${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ''}`),
    initialPageParam: null as string | null,
    getNextPageParam: (last: UserNotificationsResponse) => (last.hasMore ? (last.notifications.at(-1)?.id ?? null) : null),
    enabled,
    staleTime: 60_000,
    refetchInterval: NOTICE_POLL_MS,
    refetchIntervalInBackground: false,
  })
}

/** One opened: read at once on screen, in the list its kind belongs to; the server is told, and asked again should it refuse. */
export async function markNotificationRead(qc: QueryClient, n: Pick<UserNotification, 'id' | 'kind'>): Promise<void> {
  const key = notificationKeys.list(notificationCategory(n.kind))
  await qc.cancelQueries({ queryKey: key })
  qc.setQueryData<InfiniteData<UserNotificationsResponse>>(key, (old) => withAlertRead(old, n.id, new Date().toISOString()))
  try {
    await api<void>(`/notifications/${encodeURIComponent(n.id)}/read`, { method: 'POST' })
  } catch (e) {
    void qc.invalidateQueries({ queryKey: key })
    throw e
  }
}

/** Every one of a list read: the other list stays as it is. */
export async function markAllNotificationsRead(qc: QueryClient, category: UserNotificationCategory): Promise<void> {
  const key = notificationKeys.list(category)
  await qc.cancelQueries({ queryKey: key })
  qc.setQueryData<InfiniteData<UserNotificationsResponse>>(key, (old) => withAllAlertsRead(old, new Date().toISOString()))
  try {
    await api<void>(`/notifications/read-all?category=${category}`, { method: 'POST' })
  } catch (e) {
    void qc.invalidateQueries({ queryKey: key })
    throw e
  }
}

/** The bell closed: only each list's newest page is kept, so its poll asks for one page, not every page read. */
export function trimNotifications(qc: QueryClient): void {
  for (const category of USER_NOTIFICATION_CATEGORIES) {
    qc.setQueryData<InfiniteData<UserNotificationsResponse>>(notificationKeys.list(category), (old) => firstAlertPage(old))
  }
}
