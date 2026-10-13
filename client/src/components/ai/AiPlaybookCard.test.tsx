import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { AiPlaybookPart } from '@qc/shared/playbook'
import { AppProvider } from '@/store/AppContext'
import { AiAssistantProvider } from './AiAssistantProvider'
import { AiPlaybookCard } from './AiPlaybookCard'

vi.mock('@/store/AuthContext', async (original) => ({
  ...(await original<typeof import('@/store/AuthContext')>()),
  useAuth: () => ({ role: 'supervisor', profile: null, factoryTimeZone: 'Africa/Cairo' }),
}))

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

const text = (part: AiPlaybookPart) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <AppProvider>
        <MemoryRouter>
          <AiAssistantProvider>
            <AiPlaybookCard part={part} />
          </AiAssistantProvider>
        </MemoryRouter>
      </AppProvider>
    </QueryClientProvider>,
  )
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()

const card: AiPlaybookPart = {
  type: 'playbook',
  changeId: 'c1',
  entryId: 'e1',
  action: 'add',
  scope: 'personal',
  kind: 'conclusion',
  text: 'Machine 58 makes most of its defects at night.',
  basis: 'Sep 2026: 61% of 412 defects.',
  state: 'current',
}

describe('the playbook card', () => {
  it('says what was saved, with its basis, Remove and the Playbook page', () => {
    const t = text(card)
    expect(t).toContain('Conclusion saved to the playbook')
    expect(t).toContain('Machine 58 makes most of its defects at night.')
    expect(t).toContain('Basis: Sep 2026: 61% of 412 defects.')
    expect(t).toContain('Followed in your conversations from now on.')
    expect(t).toContain('Remove')
    expect(t).toContain('Open playbook')
  })

  it('offers nothing to press once its entry changed or went, nor for one for everyone', () => {
    expect(text({ ...card, state: 'removed' })).toContain('Removed since')
    expect(text({ ...card, state: 'removed' })).not.toContain('Remove ')
    expect(text({ ...card, state: 'changed' })).toContain('Changed since')
    expect(text({ ...card, action: 'remove', state: 'removed' })).toContain('Conclusion removed from the playbook')
    const shared = text({ ...card, scope: 'shared', kind: 'instruction', basis: '' })
    expect(shared).toContain('Followed for everyone given the assistant.')
    expect(shared).not.toMatch(/\bRemove\b/)
  })
})
