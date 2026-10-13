import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { AiQueryPart } from '@qc/shared/ai'
import { AppProvider } from '@/store/AppContext'
import { PRINT_MAX_ROWS, numericColumns, printedLine, printedRows } from './PrintSheet'
import { AnswerPrint, ReportPrint, chartedQueries, printTitle } from './reportPrints'

vi.mock('@/store/AuthContext', async (original) => ({
  ...(await original<typeof import('@/store/AuthContext')>()),
  useAuth: () => ({ role: 'supervisor', profile: { id: 'u1', username: 'mo', name: 'Mohamed Beda', role: 'supervisor', isActive: true }, factoryTimeZone: 'Africa/Cairo' }),
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

const html = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <AppProvider>{node}</AppProvider>
    </QueryClientProvider>,
  )
const text = (node: React.ReactNode) =>
  html(node)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()

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
  ms: 12,
  chart: { type: 'bar', x: 'machine', y: ['defect_pieces'], title: 'Defects by machine' },
}
const workings: AiQueryPart = { ...byMachine, queryId: 'q2', purpose: 'Checking the period', chart: undefined, rows: [['2026-09-01']], columns: ['first_day'] }

describe('an answer on paper', () => {
  it('has the question as its title, its figures, its text and each chart it drew with its rows; not its workings', () => {
    const t = text(
      <AnswerPrint
        question={'  Defects by machine\n in September? '}
        at="2026-10-13T08:30:00.000Z"
        parts={[workings, byMachine, { type: 'text', text: 'RF-01 made the most **defect pieces**.' }]}
        kpis={[{ label: 'Defect pieces', value: '19' }]}
      />,
    )
    expect(t).toMatch(/^LinkMisr · Quality Control · AI assistant Defects by machine in September\? Answered /)
    expect(t).toContain('Defect pieces 19')
    expect(t).toContain('RF-01 made the most defect pieces .')
    // The section: its title, its chart (drawn, with its read-out), then its rows as a table.
    expect(t).toMatch(/Defect pieces by machine defect pieces: RF-01 12, RF-02 7 .* machine defect_pieces RF-01 12 RF-02 7 Printed/)
    expect(t).not.toContain('Checking the period')
    expect(t).not.toContain('SELECT')
    expect(t).toMatch(/Printed .* by Mohamed Beda$/)
    // A chart, drawn; numbers line up at the end of their column.
    const h = html(<AnswerPrint at="2026-10-13T08:30:00.000Z" parts={[byMachine]} kpis={[]} />)
    expect(h).toMatch(/<svg/)
    expect(h).toContain('class="px-2 py-0.5 text-end tabular-nums">12</td>')
    expect(h).toContain('class="border-b border-slate-500 px-2 py-1 font-semibold text-end">defect_pieces</th>')
  })
})

describe('a report on paper', () => {
  it('places it, gives its summary, then each section: its rows, how many more there were, or why it failed', () => {
    const many = { ...byMachine, chart: undefined, rows: Array.from({ length: 250 }, (_, i) => [`M${i}`, i]), rowCount: 250 }
    const failed: AiQueryPart = { ...byMachine, queryId: 'q3', purpose: 'Holds', ok: false, error: 'You no longer have access to this data.', rows: [], columns: [] }
    const t = text(<ReportPrint kind="Scheduled report" title="تقرير الجودة الأسبوعي" lines={['Delivered 13 Oct 2026, 08:30', 'Covers 6 – 12 Oct 2026']} summary="أهم **ملاحظة**: الخردة زادت." parts={[many, failed]} />)
    expect(t).toMatch(/^LinkMisr · Quality Control · Scheduled report تقرير الجودة الأسبوعي Delivered 13 Oct 2026, 08:30 Covers 6 – 12 Oct 2026 أهم ملاحظة : الخردة زادت\./)
    expect(t).toContain('M199 199')
    expect(t).not.toContain('M200 200')
    expect(t).toContain('The first 200 of 250 rows. Excel holds them all.')
    expect(t).toContain('Holds You no longer have access to this data.')
  })

  it('cuts a long title, counts the rows it prints, and says who printed it', () => {
    expect(printTitle('  a\n b ', 'Answer')).toBe('a b')
    expect(printTitle('', 'Answer')).toBe('Answer')
    expect(printTitle('x'.repeat(300), 'Answer')).toHaveLength(200)
    expect(printedRows({ rows: [[1]], rowCount: 1, truncated: false })).toEqual({ rows: [[1]], note: null })
    expect(printedRows({ rows: [[1]], rowCount: 200, truncated: true }).note).toBe('The first 1 of 200+ rows. Excel holds them all.')
    expect(PRINT_MAX_ROWS).toBe(200)
    expect(printedLine(new Date('2026-10-13T08:30:00Z'), null)).toMatch(/^Printed \S/)
    expect(printedLine(new Date('2026-10-13T08:30:00Z'), 'Mona')).toMatch(/ by Mona$/)
    expect(numericColumns(['a', 'b', 'c'], [['x', 1, null], [null, 2.5, null]])).toEqual([false, true, false])
    expect(chartedQueries([workings, byMachine, { ...byMachine, queryId: 'q4', ok: false }]).map((q) => q.queryId)).toEqual(['q1'])
  })
})
