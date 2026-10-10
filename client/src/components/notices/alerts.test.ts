import { describe, expect, it } from 'vitest'
import type { InfiniteData } from '@tanstack/react-query'
import type { UserNotification, UserNotificationsResponse } from '@qc/shared/automation'
import { alertTarget, alertsOf, badgeText, bellCount, firstAlertPage, splitAlerts, unreadAlerts, withAlertRead, withAllAlertsRead } from './alerts'

const alert = (id: string, createdAt: string, readAt: string | null = null, link: string | null = `/follow-ups/${id}`): UserNotification => ({
  id,
  kind: 'follow-up-assigned',
  severity: 'warning',
  title: `Alert ${id}`,
  body: '',
  link,
  createdAt,
  readAt,
})

const pages = (...ps: { list: UserNotification[]; unread: number; hasMore?: boolean }[]): InfiniteData<UserNotificationsResponse> => ({
  pages: ps.map((p) => ({ notifications: p.list, unreadCount: p.unread, hasMore: p.hasMore ?? false })),
  pageParams: ps.map((_, i) => (i === 0 ? null : `p${i}`)),
})

describe('the bell’s count', () => {
  it('adds the notices to read and the alerts not opened', () => {
    expect(bellCount(2, 3)).toBe(5)
    expect(bellCount(0, 0)).toBe(0)
    expect(bellCount(-1, 4)).toBe(4)
  })

  it('caps what the badge shows', () => {
    expect(badgeText(7)).toBe('7')
    expect(badgeText(99)).toBe('99')
    expect(badgeText(100)).toBe('99+')
  })
})

describe('the alerts list', () => {
  const a = alert('a', '2026-10-10T10:00:00.000Z')
  const b = alert('b', '2026-10-10T09:00:00.000Z', '2026-10-10T09:30:00.000Z')
  const c = alert('c', '2026-10-09T08:00:00.000Z')

  it('joins the pages, each alert once, newest first', () => {
    // A refetched first page can repeat what the next page holds.
    const data = pages({ list: [a, b], unread: 2, hasMore: true }, { list: [b, c], unread: 2 })
    expect(alertsOf(data).map((n) => n.id)).toEqual(['a', 'b', 'c'])
    expect(alertsOf(undefined)).toEqual([])
  })

  it('puts the ones not opened first, then the earlier ones', () => {
    const { unread, earlier } = splitAlerts([a, b, c])
    expect(unread.map((n) => n.id)).toEqual(['a', 'c'])
    expect(earlier.map((n) => n.id)).toEqual(['b'])
  })

  it('takes the unread count from the newest page', () => {
    expect(unreadAlerts(pages({ list: [a], unread: 4 }, { list: [c], unread: 3 }))).toBe(4)
    expect(unreadAlerts(undefined)).toBe(0)
  })

  it('marks one read in every page that holds it, once', () => {
    const data = pages({ list: [a, b], unread: 2, hasMore: true }, { list: [c], unread: 2 })
    const once = withAlertRead(data, 'a', '2026-10-10T11:00:00.000Z')
    expect(alertsOf(once).find((n) => n.id === 'a')?.readAt).toBe('2026-10-10T11:00:00.000Z')
    expect(unreadAlerts(once)).toBe(1)
    // Already read: nothing changes, the count least of all.
    expect(withAlertRead(once, 'a', '2026-10-10T12:00:00.000Z')).toBe(once)
    expect(withAlertRead(once, 'b', '2026-10-10T12:00:00.000Z')).toBe(once)
  })

  it('marks everything read at once', () => {
    const all = withAllAlertsRead(pages({ list: [a, b], unread: 2 }, { list: [c], unread: 2 }), '2026-10-10T11:00:00.000Z')
    expect(unreadAlerts(all)).toBe(0)
    expect(alertsOf(all).every((n) => n.readAt !== null)).toBe(true)
    expect(alertsOf(all).find((n) => n.id === 'b')?.readAt).toBe('2026-10-10T09:30:00.000Z')
  })

  it('keeps only the newest page once the list is closed', () => {
    const data = pages({ list: [a], unread: 1, hasMore: true }, { list: [c], unread: 1 })
    expect(firstAlertPage(data)).toEqual({ pages: [data.pages[0]], pageParams: [null] })
    const single = pages({ list: [a], unread: 1 })
    expect(firstAlertPage(single)).toBe(single)
  })
})

describe('where an alert leads', () => {
  it('follows a page of the app, with its query', () => {
    expect(alertTarget({ link: '/follow-ups/f1' })).toBe('/follow-ups/f1')
    expect(alertTarget({ link: '/history?session=s1' })).toBe('/history?session=s1')
    expect(alertTarget({ link: '/automations/deliveries/d1#top' })).toBe('/automations/deliveries/d1#top')
  })

  it('follows nothing that would leave the app', () => {
    for (const link of [null, '', 'https://evil.example/x', '//evil.example', '/\\evil.example', 'javascript:alert(1)', '/..//evil.example', '/%2e%2e//evil.example', ' /follow-ups/\u0000x']) {
      expect(alertTarget({ link })).toBeNull()
    }
  })
})
