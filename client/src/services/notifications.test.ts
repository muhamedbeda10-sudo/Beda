// ============================================================================
// §21 — an alert opened reads as read at once, before the server answers;
// if the server refuses, the list is asked again rather than left wrong.
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, type InfiniteData } from '@tanstack/react-query'
import type { UserNotification, UserNotificationsResponse } from '@qc/shared/automation'

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }))
vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: apiMock }))

const { markAllNotificationsRead, markNotificationRead, notificationKeys, trimNotifications } = await import('./notifications')

const alert = (id: string, readAt: string | null = null): UserNotification => ({
  id,
  kind: 'automation-case',
  severity: 'info',
  title: id,
  body: '',
  link: null,
  createdAt: '2026-10-10T08:00:00.000Z',
  readAt,
})

const seed = (qc: QueryClient) =>
  qc.setQueryData<InfiniteData<UserNotificationsResponse>>(notificationKeys.list, {
    pages: [
      { notifications: [alert('a'), alert('b')], unreadCount: 3, hasMore: true },
      { notifications: [alert('c')], unreadCount: 3, hasMore: false },
    ],
    pageParams: [null, 'b'],
  })

const cached = (qc: QueryClient) => qc.getQueryData<InfiniteData<UserNotificationsResponse>>(notificationKeys.list)

describe('reading alerts', () => {
  let qc: QueryClient

  beforeEach(() => {
    apiMock.mockReset()
    qc = new QueryClient()
    seed(qc)
  })

  it('marks one read on screen and tells the server', async () => {
    apiMock.mockResolvedValue(undefined)
    await markNotificationRead(qc, 'c')
    expect(apiMock).toHaveBeenCalledWith('/notifications/c/read', { method: 'POST' })
    expect(cached(qc)?.pages[1].notifications[0].readAt).not.toBeNull()
    expect(cached(qc)?.pages[0].unreadCount).toBe(2)
  })

  it('asks the list again when the server refuses, and says so', async () => {
    apiMock.mockRejectedValue(new Error('That alert is not found.'))
    const invalidate = vi.spyOn(qc, 'invalidateQueries')
    await expect(markNotificationRead(qc, 'a')).rejects.toThrow('not found')
    expect(invalidate).toHaveBeenCalledWith({ queryKey: notificationKeys.list })
  })

  it('marks them all read at once', async () => {
    apiMock.mockResolvedValue(undefined)
    await markAllNotificationsRead(qc)
    expect(apiMock).toHaveBeenCalledWith('/notifications/read-all', { method: 'POST' })
    expect(cached(qc)?.pages.every((p) => p.unreadCount === 0 && p.notifications.every((n) => n.readAt !== null))).toBe(true)
  })

  it('keeps only the newest page once the bell is closed', () => {
    trimNotifications(qc)
    expect(cached(qc)?.pages).toHaveLength(1)
    expect(cached(qc)?.pageParams).toEqual([null])
  })
})
