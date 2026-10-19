import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { NoticeInboxResponse } from '@qc/shared/api'
import type { NoticeForUser } from '@qc/shared/types'
import { AppProvider } from '@/store/AppContext'
import { AiAssistantProvider } from '@/components/ai/AiAssistantProvider'
import { keys } from '@/services/queries'
import { NoticesButton, NoticesPanel } from './NoticesButton'

// The Notices button and what it holds, drawn to a string as on a server from an inbox already fetched. The router's
// and the provider's layout effects say they do nothing there, which is all the test needs.
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

const notice = (over: Partial<NoticeForUser>): NoticeForUser => ({
  id: 'n1',
  title: 'Line 58: new die from today',
  body: 'Check the first five pieces.',
  severity: 'warning',
  requiresAck: true,
  matchMode: 'all',
  validFrom: '2026-10-19',
  validTo: null,
  targets: [],
  imageIds: [],
  files: [],
  createdById: null,
  createdByName: 'Quality office',
  createdAt: '2026-10-19T06:00:00.000Z',
  updatedAt: '2026-10-19T06:00:00.000Z',
  active: true,
  seenAt: null,
  acknowledgedAt: null,
  pending: true,
  ...over,
})

function html(node: React.ReactNode, inbox?: NoticeInboxResponse): string {
  const qc = new QueryClient()
  if (inbox) qc.setQueryData(keys.noticeInbox, inbox)
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <AppProvider>
        <MemoryRouter>
          <AiAssistantProvider>{node}</AiAssistantProvider>
        </MemoryRouter>
      </AppProvider>
    </QueryClientProvider>,
  )
}

const inbox: NoticeInboxResponse = {
  notices: [notice({}), notice({ id: 'n2', title: 'Shift B: helmets on the floor', pending: false, seenAt: '2026-10-18T09:00:00.000Z' })],
  pendingCount: 1,
}

describe('the Notices button, apart from the bell', () => {
  it('shows how many notices wait to be read, on a megaphone of its own', () => {
    const button = html(<NoticesButton receives manage={false} />, inbox)
    expect(button).toContain('aria-label="Notices, 1 to read"')
    // The shared count badge (ui/CountBadge.tsx): round, rose, holding the count.
    expect(button).toMatch(/class="[^"]*rounded-full[^"]*bg-rose-600[^"]*">1</)
    expect(html(<NoticesButton receives manage={false} />, { notices: [], pendingCount: 0 })).toContain('aria-label="Notices"')
  })

  it('is not there for someone who neither receives notices nor writes them', () => {
    expect(html(<NoticesButton receives={false} manage={false} />)).toBe('')
    // Someone who only writes them has it, with nothing to read.
    expect(html(<NoticesButton receives={false} manage />)).toContain('aria-label="Notices"')
  })
})

describe('what the Notices button holds', () => {
  const noop = () => undefined

  it('lists the notices waiting first, then the earlier ones', () => {
    const panel = html(<NoticesPanel receives manage={false} notices={inbox.notices} loading={false} onWrite={noop} onLeave={noop} />)
    expect(panel.indexOf('Needs your attention')).toBeLessThan(panel.indexOf('Line 58: new die from today'))
    expect(panel.indexOf('Line 58: new die from today')).toBeLessThan(panel.indexOf('Earlier'))
    expect(panel.indexOf('Earlier')).toBeLessThan(panel.indexOf('Shift B: helmets on the floor'))
    // A reader writes none: no button to.
    expect(panel).not.toContain('New notice')
    expect(panel).not.toContain('Manage notices')
  })

  it('offers whoever writes notices New notice by hand, New in the assistant when it may write them, and the Notices page', () => {
    const both = html(<NoticesPanel receives manage notices={inbox.notices} loading={false} onWrite={noop} onAssistant={noop} onLeave={noop} />)
    expect(both).toContain('New notice')
    expect(both).toContain('New in the assistant')
    expect(both).toContain('href="/notices"')
    expect(both.indexOf('New notice')).toBeLessThan(both.indexOf('Needs your attention'))
    // Without the assistant for notices, by hand only.
    const byHand = html(<NoticesPanel receives manage notices={inbox.notices} loading={false} onWrite={noop} onLeave={noop} />)
    expect(byHand).toContain('New notice')
    expect(byHand).not.toContain('New in the assistant')
    // A writer who receives none has the buttons and no list.
    const writerOnly = html(<NoticesPanel receives={false} manage notices={[]} loading={false} onWrite={noop} onLeave={noop} />)
    expect(writerOnly).toContain('New notice')
    expect(writerOnly).not.toContain('No notices')
  })
})
