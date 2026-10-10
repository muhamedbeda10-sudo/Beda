// ============================================================================
// §21 — the bell's alerts through the API: what automations and follow-ups
// told this person, newest first, a page at a time, with how many are not
// opened yet. Polled like the notices (every few minutes while the tab is
// visible, never in the background). Opening one marks it read; so does
// "Mark all as read". The cache follows at once, before the server answers.
// ============================================================================

import { useInfiniteQuery, type InfiniteData, type QueryClient } from '@tanstack/react-query'
import type { UserNotificationsResponse } from '@qc/shared/automation'
import { api } from '@/lib/api'
import { firstAlertPage, withAlertRead, withAllAlertsRead } from '@/components/notices/alerts'
import { NOTICE_POLL_MS } from './queries'

export const notificationKeys = {
  list: ['notifications', 'list'] as const,
}

/** Alerts a page brings. */
const PAGE = 30

/** The alerts, newest first: the first page is what the bell polls; "Load more" is fetchNextPage. */
export function useNotifications(enabled = true) {
  return useInfiniteQuery({
    queryKey: notificationKeys.list,
    queryFn: ({ pageParam }) => api<UserNotificationsResponse>(`/notifications?limit=${PAGE}${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ''}`),
    initialPageParam: null as string | null,
    getNextPageParam: (last: UserNotificationsResponse) => (last.hasMore ? (last.notifications.at(-1)?.id ?? null) : null),
    enabled,
    staleTime: 60_000,
    refetchInterval: NOTICE_POLL_MS,
    refetchIntervalInBackground: false,
  })
}

/** One alert opened: read at once on screen; the server is told, and asked again should it refuse. */
export async function markNotificationRead(qc: QueryClient, id: string): Promise<void> {
  await qc.cancelQueries({ queryKey: notificationKeys.list })
  qc.setQueryData<InfiniteData<UserNotificationsResponse>>(notificationKeys.list, (old) => withAlertRead(old, id, new Date().toISOString()))
  try {
    await api<void>(`/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' })
  } catch (e) {
    void qc.invalidateQueries({ queryKey: notificationKeys.list })
    throw e
  }
}

export async function markAllNotificationsRead(qc: QueryClient): Promise<void> {
  await qc.cancelQueries({ queryKey: notificationKeys.list })
  qc.setQueryData<InfiniteData<UserNotificationsResponse>>(notificationKeys.list, (old) => withAllAlertsRead(old, new Date().toISOString()))
  try {
    await api<void>('/notifications/read-all', { method: 'POST' })
  } catch (e) {
    void qc.invalidateQueries({ queryKey: notificationKeys.list })
    throw e
  }
}

/** The list closed: only its newest page is kept, so the bell's poll asks for one page, not every page read. */
export function trimNotifications(qc: QueryClient): void {
  qc.setQueryData<InfiniteData<UserNotificationsResponse>>(notificationKeys.list, (old) => firstAlertPage(old))
}
