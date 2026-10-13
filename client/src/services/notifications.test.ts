// ============================================================================
// §21 — an alert opened reads as read at once, before the server answers;
// if the server refuses, the list is asked again rather than left wrong.
// Alerts and Reports are two lists: reading one leaves the other as it is.
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, type InfiniteData } from '@tanstack/react-query'
import type { UserNotification, UserNotificationsResponse } from '@qc/shared/automation'

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }))
vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: apiMock }))

const { markAllNotificationsRead, markNotificationRead, notificationKeys, trimNotifications } = await import('./notifications')

const alert = (id: string, readAt: string | null = null, kind: UserNotification['kind'] = 'automation-case'): UserNotification => ({
  id,
  kind,
  severity: 'info',
  title: id,
  body: '',
  link: null,
  createdAt: '2026-10-10T08:00:00.000Z',
  readAt,
})

const seed = (qc: QueryClient) => {
  qc.setQueryData<InfiniteData<UserNotificationsResponse>>(notificationKeys.list('alerts'), {
    pages: [
      { notifications: [alert('a'), alert('b')], unreadCount: 3, hasMore: true },
      { notifications: [alert('c')], unreadCount: 3, hasMore: false },
    ],
    pageParams: [null, 'b'],
  })
  qc.setQueryData<InfiniteData<UserNotificationsResponse>>(notificationKeys.list('reports'), {
    pages: [
      { notifications: [alert('r1', null, 'automation-report')], unreadCount: 2, hasMore: true },
      { notifications: [alert('r2', null, 'automation-report')], unreadCount: 2, hasMore: false },
    ],
    pageParams: [null, 'r1'],
  })
}

const cached = (qc: QueryClient) => qc.getQueryData<InfiniteData<UserNotificationsResponse>>(notificationKeys.list('alerts'))
const reports = (qc: QueryClient) => qc.getQueryData<InfiniteData<UserNotificationsResponse>>(notificationKeys.list('reports'))

describe('reading alerts', () => {
  let qc: QueryClient

  beforeEach(() => {
    apiMock.mockReset()
    qc = new QueryClient()
    seed(qc)
  })

  it('marks one read on screen and tells the server', async () => {
    apiMock.mockResolvedValue(undefined)
    await markNotificationRead(qc, alert('c'))
    expect(apiMock).toHaveBeenCalledWith('/notifications/c/read', { method: 'POST' })
    expect(cached(qc)?.pages[1].notifications[0].readAt).not.toBeNull()
    expect(cached(qc)?.pages[0].unreadCount).toBe(2)
    expect(reports(qc)?.pages[0].unreadCount).toBe(2)
  })

  it('marks a report read in the Reports list, the alerts left as they are', async () => {
    apiMock.mockResolvedValue(undefined)
    await markNotificationRead(qc, alert('r2', null, 'automation-report'))
    expect(apiMock).toHaveBeenCalledWith('/notifications/r2/read', { method: 'POST' })
    expect(reports(qc)?.pages[1].notifications[0].readAt).not.toBeNull()
    expect(reports(qc)?.pages[0].unreadCount).toBe(1)
    expect(cached(qc)?.pages[0].unreadCount).toBe(3)
  })

  it('asks the list again when the server refuses, and says so', async () => {
    apiMock.mockRejectedValue(new Error('That alert is not found.'))
    const invalidate = vi.spyOn(qc, 'invalidateQueries')
    await expect(markNotificationRead(qc, alert('a'))).rejects.toThrow('not found')
    expect(invalidate).toHaveBeenCalledWith({ queryKey: notificationKeys.list('alerts') })
  })

  it('marks one list all read at once, and only that list', async () => {
    apiMock.mockResolvedValue(undefined)
    await markAllNotificationsRead(qc, 'reports')
    expect(apiMock).toHaveBeenCalledWith('/notifications/read-all?category=reports', { method: 'POST' })
    expect(reports(qc)?.pages.every((p) => p.unreadCount === 0 && p.notifications.every((n) => n.readAt !== null))).toBe(true)
    expect(cached(qc)?.pages[0].unreadCount).toBe(3)
    await markAllNotificationsRead(qc, 'alerts')
    expect(apiMock).toHaveBeenCalledWith('/notifications/read-all?category=alerts', { method: 'POST' })
    expect(cached(qc)?.pages.every((p) => p.unreadCount === 0 && p.notifications.every((n) => n.readAt !== null))).toBe(true)
  })

  it('keeps only the newest page of each list once the bell is closed', () => {
    trimNotifications(qc)
    expect(cached(qc)?.pages).toHaveLength(1)
    expect(cached(qc)?.pageParams).toEqual([null])
    expect(reports(qc)?.pages).toHaveLength(1)
    expect(reports(qc)?.pageParams).toEqual([null])
  })
})
