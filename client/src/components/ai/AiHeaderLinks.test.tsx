import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AppProvider } from '@/store/AppContext'
import { AiAssistantProvider } from './AiAssistantProvider'
import { AiHeaderLinks } from './AiHeaderLinks'

// The assistant's header links to its own pages: the Playbook for everyone given it, Automations for those who may
// create them — and no Tasks, which are in the bell.

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

function links(automations: boolean): string {
  const qc = new QueryClient()
  qc.setQueryData(['ai', 'me'], { granted: true, owner: false, available: true, automations })
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <AppProvider>
        <MemoryRouter initialEntries={['/playbook']}>
          <AiAssistantProvider>
            <AiHeaderLinks buttonClass="b" onClass="on" />
          </AiAssistantProvider>
        </MemoryRouter>
      </AppProvider>
    </QueryClientProvider>,
  )
}

describe('the assistant’s header links', () => {
  it('offers the Playbook, marked when it is the page, and Automations only to those who may create them; never Tasks', () => {
    const plain = links(false)
    expect(plain).toContain('aria-label="Playbook"')
    expect(plain).toMatch(/aria-label="Playbook" aria-current="page"/)
    expect(plain).not.toContain('aria-label="Automations"')
    expect(plain).not.toContain('Tasks')
    expect(links(true)).toContain('aria-label="Automations"')
  })
})
