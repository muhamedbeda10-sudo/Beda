import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { AiQueryPart } from '@qc/shared/ai'
import { AppProvider } from '@/store/AppContext'
import { PRINT_MAX_ROWS, numericColumns, printedLine, printedRows } from './PrintSheet'
import { AnswerPrint, ReportPrint, chartedQueries, printTitle, shownQueries } from './reportPrints'
import { pageRules, printFileName } from './usePrint'

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

const photos: AiQueryPart = {
  ...byMachine,
  queryId: 'q5',
  purpose: 'Photos of the scratches',
  chart: undefined,
  columns: ['photo_id', 'defect_name', 'order_number', 'recorded_at'],
  rows: [
    ['0b0c3c1e-6d2a-4c1e-9a43-0f6b3c2d1e01', 'Scratch', '20619-Ph3.3', '2026-09-27 11:29:28.034+03'],
    ['0b0c3c1e-6d2a-4c1e-9a43-0f6b3c2d1e02', 'Scratch', '20581-HMN', '2026-09-30 10:34:06+03'],
  ],
}

describe('an answer on paper', () => {
  it('goes out under the title the assistant gave it, with the letterhead, its figures, its text and each chart alone; not the question, nor its workings', () => {
    const t = text(
      <AnswerPrint
        title="Defects by machine - September 2026"
        at="2026-10-13T08:30:00.000Z"
        parts={[workings, byMachine, { type: 'text', text: 'RF-01 made the most **defect pieces**.' }]}
        kpis={[{ label: 'Defect pieces', value: '19' }]}
      />,
    )
    expect(t).toMatch(/^LINK MISR ADVANCED STORAGE SOLUTIONS Quality Control Department AI assistant report Defects by machine - September 2026 Prepared 13 Oct 2026, \d\d:30 Defect pieces 19/)
    expect(t).toContain('Defect pieces 19')
    expect(t).toContain('RF-01 made the most defect pieces .')
    // The chart, drawn with its read-out; the rows behind it stay in Excel.
    expect(t).toMatch(/Defect pieces by machine defect pieces: RF-01 12, RF-02 7/)
    expect(t).not.toMatch(/machine defect_pieces RF-01 12 RF-02 7/)
    expect(t).not.toContain('Checking the period')
    expect(t).not.toContain('SELECT')
    expect(t).toMatch(/Printed .* by Mohamed Beda$/)
    expect(html(<AnswerPrint title="T" at="2026-10-13T08:30:00.000Z" parts={[byMachine]} kpis={[]} />)).toMatch(/<svg/)
  })

  it('shows the photos a query found, each with its caption, waiting for them before it prints', () => {
    const h = html(<AnswerPrint title="Scratches" at="2026-10-13T08:30:00.000Z" parts={[photos, byMachine]} kpis={[]} />)
    const t = text(<AnswerPrint title="Scratches" at="2026-10-13T08:30:00.000Z" parts={[photos, byMachine]} kpis={[]} />)
    expect(t).toMatch(/1 Photos of the scratches Scratch 20619-Ph3\.3 · 2026-09-27 11:29 Scratch 20581-HMN · 2026-09-30 10:34 2 Defect pieces by machine/)
    expect(t).not.toContain('0b0c3c1e')
    expect(h).toContain('class="print-photos"')
    expect(h).toContain('data-print-pending')
    expect(shownQueries([workings, photos, byMachine]).map((q) => q.queryId)).toEqual(['q5', 'q1'])
  })
})

describe('a report on paper', () => {
  it('places it, gives its summary, then each section numbered: its rows, how many more there were, or why it failed', () => {
    const many = { ...byMachine, chart: undefined, rows: Array.from({ length: 250 }, (_, i) => [`M${i}`, i]), rowCount: 250 }
    const failed: AiQueryPart = { ...byMachine, queryId: 'q3', purpose: 'Holds', ok: false, error: 'You no longer have access to this data.', rows: [], columns: [] }
    const t = text(
      <ReportPrint
        kind="Scheduled report"
        title="تقرير الجودة الأسبوعي"
        lines={['Delivered 13 Oct 2026, 08:30', 'Covers 6 – 12 Oct 2026']}
        summary="أهم **ملاحظة**: الخردة زادت."
        sections={[{ part: many }, { part: failed }]}
      />,
    )
    expect(t).toMatch(/Quality Control Department Scheduled report تقرير الجودة الأسبوعي Delivered 13 Oct 2026, 08:30 Covers 6 – 12 Oct 2026 أهم ملاحظة : الخردة زادت\./)
    expect(t).toContain('1 Defect pieces by machine machine defect_pieces M0 0')
    expect(t).toContain('M199 199')
    expect(t).not.toContain('M200 200')
    expect(t).toContain('The first 200 of 250 rows. Excel holds them all.')
    expect(t).toContain('2 Holds You no longer have access to this data.')
    // Numbers line up at the end of their column.
    const h = html(<ReportPrint kind="Saved report" title="R" lines={[]} sections={[{ part: { ...byMachine, chart: undefined } }]} />)
    expect(h).toContain('class="px-2 py-1 text-end tabular-nums">12</td>')
    expect(h).toContain('class="px-2 py-1.5 font-bold text-end">defect_pieces</th>')
  })

  it('shows a section of headline figures as figures, and a charted one as its chart alone', () => {
    const figures: AiQueryPart = { ...byMachine, chart: undefined, columns: ['Customer', 'Pieces'], rows: [['ACME', 349]] }
    const t = text(<ReportPrint kind="Saved report" title="R" lines={[]} sections={[{ part: figures, display: 'figures' }, { part: byMachine }]} />)
    expect(t).toContain('Customer ACME')
    expect(t).toContain('Pieces 349')
    expect(t).toMatch(/2 Defect pieces by machine defect pieces: RF-01 12, RF-02 7/)
    expect(t).not.toMatch(/machine defect_pieces RF-01/)
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

describe('the file and its pages', () => {
  it('names the PDF after the report and its day, without marks a file name cannot hold', () => {
    expect(printFileName({ title: 'F1 / F3 / F4: Production vs Quality (daily)', day: '2026-10-14' })).toBe('F1 F3 F4 Production vs Quality (daily) 2026-10-14')
    expect(printFileName({ title: 'قدرة البعد J على ماكينة 24' })).toBe('قدرة البعد J على ماكينة 24')
    expect(printFileName({ title: '  ?? ' })).toBe('Report')
  })

  it('prints A4 standing, each page with the company and the report at its foot, and its number of the whole', () => {
    const css = pageRules({ title: 'Scrap "weekly"\nreview' })
    expect(css).toContain('size: A4 portrait;')
    expect(css).toContain('@bottom-left { content: "LinkMisr · Quality Control — Scrap \\"weekly\\" review";')
    expect(css).toContain('@bottom-right { content: "Page " counter(page) " of " counter(pages);')
  })
})
