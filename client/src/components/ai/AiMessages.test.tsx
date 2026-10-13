import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { AiMessage, AiQueryPart } from '@qc/shared/ai'
import type { AiNoticePart } from '@qc/shared/noticeAssistant'
import { PROPOSAL_WAIT } from '@/components/automations/AutomationProposalCard'
import { AppProvider } from '@/store/AppContext'
import { AiAssistantProvider } from './AiAssistantProvider'
import { Answer, UserBubble } from './AiMessages'
import { startTurn, type LivePart, type LiveTurn } from './liveTurn'

// A notice card asks the signed-in person's role (its link to the Notices page is an administrator's).
vi.mock('@/store/AuthContext', async (original) => ({
  ...(await original<typeof import('@/store/AuthContext')>()),
  useAuth: () => ({ role: 'admin', profile: null, factoryTimeZone: 'Africa/Cairo' }),
}))

// An answer drawn to a string, as on a server: the layout effects (a chart reading its width) say they do nothing
// there, which is all the test needs.
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

function render(props: { message?: AiMessage; turn?: LiveTurn; noticesWait?: boolean }): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <AppProvider>
        <MemoryRouter>
          <AiAssistantProvider>
            <Answer {...props} question="Defects by machine in September?" />
          </AiAssistantProvider>
        </MemoryRouter>
      </AppProvider>
    </QueryClientProvider>,
  )
}

const byMachine: AiQueryPart = {
  type: 'query',
  queryId: 'q1',
  purpose: 'Defect pieces by machine',
  sql: 'SELECT machine, defect_pieces FROM ai.x',
  ok: true,
  columns: ['machine', 'defect_pieces'],
  rows: [
    ['RF-01', 12],
    ['RF-02', 7],
  ],
  rowCount: 2,
  truncated: false,
  ms: 41,
  chart: { type: 'bar', x: 'machine', y: ['defect_pieces'], title: 'Defects by machine' },
}
const holds: AiQueryPart = { ...byMachine, queryId: 'q2', purpose: 'Open holds', columns: ['n'], rows: [[4]], rowCount: 1, chart: undefined }

const saved: AiMessage = {
  id: 't1',
  role: 'assistant',
  turnId: 't1',
  createdAt: '2026-10-09T10:00:00.000Z',
  stopReason: 'end_turn',
  costUsd: 0.4321,
  parts: [{ type: 'text', text: 'Looking at September.' }, byMachine, holds, { type: 'text', text: 'There were **19** defect pieces on two machines.' }],
  kpis: [
    { label: 'Defect pieces', value: '19' },
    { label: 'Reject rate', value: '1.29%', trend: 'down-good' },
  ],
}

const writing = (parts: LivePart[]): LiveTurn => ({ ...startTurn('k1', 'c1', 'Defects?', '2026-10-09T10:00:00.000Z'), phase: 'streaming', parts })

describe('an answer as it ended', () => {
  let html = ''
  beforeAll(() => {
    html = render({ message: saved })
  })

  it('opens with its headline figures as cards, the arrow saying whether the move is good', () => {
    expect(html).toContain('aria-label="Headline figures"')
    expect(html).toContain('down, which is good')
    // The figures head the text written after the queries; the text before them stays first.
    expect(html.indexOf('Looking at September.')).toBeLessThan(html.indexOf('Headline figures'))
    expect(html.indexOf('Headline figures')).toBeLessThan(html.indexOf('defect pieces on two machines'))
  })

  it('draws the chart its query asked for after the text, with a switch to the query’s table and its tools under it', () => {
    expect(html).toContain('class="ai-figure')
    expect(html).toContain('Defects by machine')
    expect(html).toMatch(/<svg[^>]*role="img"/)
    expect(html.indexOf('defect pieces on two machines')).toBeLessThan(html.indexOf('ai-figure'))
    // The chart first; its table a press away, Open table and Export Excel under either.
    const figure = html.slice(html.indexOf('ai-figure'))
    expect(figure).toMatch(/aria-label="Show as"/)
    expect(figure).toMatch(/aria-pressed="true"[^>]*>.*?Chart/)
    expect(figure.indexOf('<svg')).toBeLessThan(figure.indexOf('Open table'))
    expect(figure).toContain('Excel')
  })

  it('folds its queries under “How I got this” at the end', () => {
    expect(html).toContain('How I got this (2 queries)')
    expect(html).toMatch(/aria-expanded="false"[^>]*>.*How I got this/)
    expect(html.indexOf('ai-figure')).toBeLessThan(html.indexOf('How I got this'))
  })

  it('shows no cost, anywhere', () => {
    expect(html).not.toContain('0.4321')
    expect(html).not.toMatch(/\$\s?\d/)
  })
})

describe('an answer’s figures and charts, as they are shown', () => {
  it('says how many rows a chart was drawn from when more matched: the rows the preview holds, however few', () => {
    // A preview cut short by its size, not its count: 37 rows, not the 200 a preview may hold.
    const rows = Array.from({ length: 37 }, (_, i) => [`M${i}`, i + 1])
    const cut: AiQueryPart = { ...byMachine, rows, rowCount: 37, truncated: true }
    const html = render({ message: { ...saved, parts: [cut, { type: 'text', text: 'Done.' }] } })
    expect(html).toContain('Drawn from the first 37 rows; more matched')
    expect(html).not.toContain('first 200 rows')
  })

  it('shows a long value whole, a size smaller and wrapping, and a figure at full size', () => {
    const html = render({ message: { ...saved, kpis: [{ label: 'Worst machine', value: 'LM4 Painting Line' }, { label: 'Defect pieces', value: '1,284' }] } })
    const value = (v: string) => html.match(new RegExp(`<span dir="auto" class="([^"]*)">${v}</span>`))?.[1] ?? ''
    expect(value('LM4 Painting Line')).toContain('break-words')
    expect(value('LM4 Painting Line')).toContain('text-[15px]')
    expect(value('LM4 Painting Line')).not.toContain('truncate')
    expect(value('1,284')).toContain('text-lg')
    expect(value('1,284')).not.toContain('truncate')
  })

  it('captions an Arabic chart from the right, its icon beside its title there', () => {
    const arabic: AiQueryPart = { ...byMachine, chart: { ...byMachine.chart!, title: 'القطع المعيبة حسب الخط' } }
    const html = render({ message: { ...saved, parts: [arabic, { type: 'text', text: 'تم.' }] } })
    expect(html).toMatch(/<figcaption dir="rtl"/)
    expect(render({ message: saved })).toMatch(/<figcaption dir="ltr"/)
  })
})

describe('an answer being written', () => {
  it('keeps its queries open, says what runs, and does not also say it is thinking', () => {
    const html = render({ turn: writing([{ type: 'text', text: 'Looking.' }, { type: 'pending-query', queryId: 'q1', purpose: 'Defect pieces by machine', sql: 'SELECT 1', state: 'running' }]) })
    expect(html).toMatch(/aria-expanded="true"[^>]*>.*How I got this \(1 query\)/)
    expect(html).toContain('Running a query:')
    expect(html).not.toContain('Thinking…')
    // No chart until it has ended: it would move about under the text still coming.
    expect(html).not.toContain('ai-figure')
  })

  it('says it is thinking between a query and the first word after it', () => {
    const html = render({ turn: writing([byMachine]) })
    expect(html).toContain('Thinking…')
    expect(html).toContain('ai-dots')
  })

  it('never shows the figures’ block, and draws its cards once it is whole', () => {
    const half = render({ turn: writing([byMachine, { type: 'text', text: '<kpis>\n- Defect pieces | 19\n- Reject' }]) })
    expect(half).not.toMatch(/&lt;kp|<kpis/i)
    expect(half).not.toContain('Headline figures')
    const whole = render({ turn: writing([byMachine, { type: 'text', text: '<kpis>\n- Defect pieces | 19\n</kpis>\n\nThere were 19' }]) })
    expect(whole).toContain('Headline figures')
    expect(whole).toContain('There were 19')
    expect(whole).toContain('ai-caret')
  })
})

describe('a saved answer’s notice card while a later answer is written', () => {
  const card: AiNoticePart = {
    type: 'notice',
    proposalId: 'n1',
    ok: true,
    action: 'create',
    state: 'proposed',
    draft: { title: 'Check the coating', body: 'Measure every coil.', severity: 'warning', requiresAck: true, matchMode: 'all', validFrom: '2026-10-10', validTo: null, targets: [] },
    reach: { everyone: true, people: 12, placeBound: false },
  }
  const drafted: AiMessage = { ...saved, parts: [{ type: 'text', text: 'Here is the notice.' }, card], kpis: undefined }

  it('waits, Publish and Discard alike, when that answer drafted a notice card that may replace it', () => {
    expect(render({ message: drafted, noticesWait: true }).match(new RegExp(`disabled="" data-tip="${PROPOSAL_WAIT}"`, 'g'))).toHaveLength(2)
    expect(render({ message: drafted })).not.toContain(PROPOSAL_WAIT)
  })
})

describe('a question with files', () => {
  const drawn = (attachments: AiMessage['attachments'], text = 'What does this sheet say?') =>
    renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <AppProvider>
          <UserBubble text={text} attachments={attachments} />
        </AppProvider>
      </QueryClientProvider>,
    )

  it('shows photos as previews and other files as named chips, above the words', () => {
    const html = drawn([
      { id: 'a1', kind: 'image', name: 'sheet.jpg', byteSize: 400_000, tokens: 1800, width: 2000, height: 1500, thumbnailDataUrl: 'data:image/jpeg;base64,AAAA' },
      { id: 'a2', kind: 'pdf', name: 'certificate.pdf', byteSize: 2_100_000, tokens: 9000 },
      { id: 'a3', kind: 'sheet', name: 'orders.xlsx', byteSize: 3000, tokens: 900, summary: '40 rows × 6 columns' },
    ])
    expect(html).toContain('aria-label="Open the photo sheet.jpg"')
    expect(html).toContain('src="data:image/jpeg;base64,AAAA"')
    expect(html).toContain('certificate.pdf')
    expect(html).toContain('2.0 MB')
    expect(html).toContain('40 rows × 6 columns')
    expect(html.indexOf('orders.xlsx')).toBeLessThan(html.indexOf('What does this sheet say?'))
  })

  it('shows files alone without an empty line of text', () => {
    const html = drawn([{ id: 'a1', kind: 'pdf', name: 'report.pdf', byteSize: 1000, tokens: 500 }], '')
    expect(html).toContain('report.pdf')
    expect(html).not.toContain('whitespace-pre-wrap')
  })
})
