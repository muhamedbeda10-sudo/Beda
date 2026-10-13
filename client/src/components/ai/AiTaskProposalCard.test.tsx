import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { AiTaskPart } from '@qc/shared/ai'
import { AppProvider } from '@/store/AppContext'
import { PROPOSAL_WAIT } from '@/components/automations/AutomationProposalCard'
import { AiAssistantProvider } from './AiAssistantProvider'
import { AiTaskProposalCard } from './AiTaskProposalCard'

vi.mock('@/store/AuthContext', async (original) => ({
  ...(await original<typeof import('@/store/AuthContext')>()),
  useAuth: () => ({ role: 'supervisor', profile: null, factoryTimeZone: 'Africa/Cairo' }),
}))

// The card drawn to a string, as on a server: what each state says and offers.
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

function html(part: AiTaskPart, writing = false): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <AppProvider>
        <MemoryRouter>
          <AiAssistantProvider>
            <AiTaskProposalCard part={part} writing={writing} />
          </AiAssistantProvider>
        </MemoryRouter>
      </AppProvider>
    </QueryClientProvider>,
  )
}

const text = (part: AiTaskPart, writing = false) =>
  html(part, writing)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()

const card: AiTaskPart = {
  type: 'task',
  proposalId: 't1',
  ok: true,
  state: 'proposed',
  draft: {
    title: 'Recheck the coil stock in bay 3',
    description: 'Count the coils and send a photo of the tags.',
    priority: 'urgent',
    dueAt: '2030-03-14T08:00:00.000Z',
    assignees: [
      { id: 'u1', name: 'Cyril Second' },
      { id: 'u2', name: 'سارة علي' },
    ],
  },
}

describe('the task card', () => {
  it('shows what is to be done, to whom, how urgent and by when, and offers Send task and Discard', () => {
    const t = text(card)
    expect(t).toContain('New task Not sent yet Urgent')
    expect(t).toContain('Recheck the coil stock in bay 3')
    expect(t).toContain('Count the coils and send a photo of the tags.')
    expect(t).toContain('Goes to · 2 Cyril Second سارة علي')
    expect(t).toContain('Deadline Mar 14, 2030, 10:00')
    expect(t).toContain('Send task')
    expect(t).toContain('Discard')
    expect(t).toContain('Each person is told in their bell when you send it.')
    expect(html(card)).not.toContain(PROPOSAL_WAIT)
    // While an answer that may replace it is written, its buttons wait.
    expect(html(card, true)).toContain(`data-tip="${PROPOSAL_WAIT}"`)
  })

  it('says it was sent, with a link to the task', () => {
    const sent = html({ ...card, state: 'sent', taskId: 'task-9', taskNumber: 12 })
    expect(sent).toContain('href="/tasks/task-9"')
    const t = text({ ...card, state: 'sent', taskId: 'task-9', taskNumber: 12 })
    expect(t).toContain('Task T-12 Sent')
    expect(t).toContain('Sent as T-12 · Open task')
    expect(t).not.toContain('Send task')
  })

  it('says it was discarded, or folds away once replaced, with nothing to press', () => {
    expect(text({ ...card, state: 'discarded' })).toContain('Discarded — nothing was sent.')
    const replaced = text({ ...card, state: 'superseded' })
    expect(replaced).toContain('Nothing of it is sent: the newer card below is the one to send. Show it')
    expect(replaced).toContain('Replaced by a newer version below')
    expect(replaced).not.toContain('Count the coils')
    expect(replaced).not.toContain('Send task')
  })

  it('shows a draft the server refused compactly, with no buttons', () => {
    const t = text({ type: 'task', proposalId: 't2', ok: false, state: 'proposed', error: 'title: say what is to be done.' })
    expect(t).toContain('Task card not accepted')
    expect(t).toContain('nothing was sent')
    expect(t).not.toContain('Send task')
  })
})
