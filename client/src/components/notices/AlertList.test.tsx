import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider, type InfiniteData } from '@tanstack/react-query'
import type { UserNotification, UserNotificationCategory, UserNotificationsResponse } from '@qc/shared/automation'
import { AppProvider } from '@/store/AppContext'
import { notificationKeys } from '@/services/notifications'
import { AlertList } from './AlertList'

// The alerts drawn to a string, as on a server, from a list already fetched: where each one leads, and that one leading
// nowhere is drawn as words to read in place, not as a link. The router's layout effect says it does nothing there.
const consoleError = console.error
beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...rest: unknown[]) => {
    if (String(message).includes('useLayoutEffect does nothing on the server')) return
    consoleError(message, ...rest)
  })
  const stored = new Map<string, string>([['qc-system-theme', 'light']])
  vi.stubGlobal('localStorage', { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v), removeItem: (k: string) => void stored.delete(k) })
})
afterAll(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const alert = (over: Partial<UserNotification>): UserNotification => ({
  id: 'n1',
  kind: 'automation-case',
  severity: 'info',
  title: 'Hold on RF-03',
  body: '',
  link: null,
  createdAt: '2026-10-10T08:00:00.000Z',
  readAt: null,
  ...over,
})

function html(notifications: UserNotification[], category: UserNotificationCategory = 'alerts'): string {
  const qc = new QueryClient()
  const data: InfiniteData<UserNotificationsResponse> = {
    pages: [{ notifications, unreadCount: notifications.filter((n) => n.readAt === null).length, hasMore: false }],
    pageParams: [null],
  }
  qc.setQueryData(notificationKeys.list(category), data)
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <AppProvider>
        <MemoryRouter>
          <AlertList category={category} onLeave={() => undefined} />
        </MemoryRouter>
      </AppProvider>
    </QueryClientProvider>,
  )
}

describe('the bell’s alerts', () => {
  it('opens an alert where it leads, and draws one leading nowhere as words to read in place', () => {
    const h = html([
      alert({ id: 'n1', title: 'Holds: 3 follow-ups assigned to you', kind: 'follow-up-assigned', link: '/follow-ups?automationId=a1' }),
      alert({ id: 'n2', title: 'Coil 77 out of tolerance', link: null }),
      alert({ id: 'n3', title: 'An address outside the app', link: 'https://example.com/x', readAt: '2026-10-10T09:00:00.000Z' }),
    ])
    expect(h).toContain('href="/follow-ups?automationId=a1"')
    // Only the first is a link; the others open in place.
    expect(h.match(/<a /g)).toHaveLength(1)
    expect(h.match(/<button type="button"[^>]*aria-expanded="false"/g)).toHaveLength(2)
    expect(h).not.toContain('example.com')
    expect(h).toContain('Coil 77 out of tolerance')
    expect(h).toContain('An address outside the app')
  })

  it('lists the reports delivered on the Reports tab, each leading to its report', () => {
    const h = html([alert({ id: 'r1', kind: 'automation-report', title: 'Daily QC report', link: '/automations/deliveries/d1' })], 'reports')
    expect(h).toContain('href="/automations/deliveries/d1"')
    expect(h).toContain('Scheduled report')
    expect(h).toContain('Mark all as read')
  })

  it('says so when no report was sent yet', () => {
    expect(html([], 'reports')).toContain('Scheduled reports sent to you show here.')
    expect(html([], 'alerts')).toContain('No alerts')
  })
})
