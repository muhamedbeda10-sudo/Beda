import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider, type InfiniteData } from '@tanstack/react-query'
import type { SharedReport, SharedReportRunResponse, SharedReportsResponse } from '@qc/shared/reportShares'
import { AppProvider } from '@/store/AppContext'
import { sharedReportKeys } from '@/services/reportShares'
import { ReportsPage } from './ReportsPage'

// The Reports page of someone a report is shared with: drawn as on a server, with no AI provider at all — it is for
// people without the assistant too. What it shows comes from the cache, as the server answered it.

vi.mock('@/store/AuthContext', async (original) => ({
  ...(await original<typeof import('@/store/AuthContext')>()),
  useAuth: () => ({ role: 'viewer', profile: null, factoryTimeZone: 'Africa/Cairo', can: () => false }),
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

const ID = '11111111-2222-4333-8444-555555555555'

const report: SharedReport = {
  id: ID,
  title: 'Weekly scrap',
  description: 'Scrap by machine this week.',
  ownerName: 'Cara Creator',
  updatedAt: '2026-10-19T08:00:00.000Z',
  period: null,
  adjustable: false,
  inputs: [],
  sections: [{ title: 'Scrap by machine' }],
  available: true,
  excel: false,
}

const ran: SharedReportRunResponse = {
  report,
  period: null,
  sections: [{ title: 'Scrap by machine', ok: true, columns: ['machine', 'scrap_kg'], rows: [['58', 12.5], ['31', 4]], rowCount: 2, truncated: false, ms: 12 }],
  inputs: {},
  ranAt: '2026-10-20T07:00:00.000Z',
}

function render(path: string, seed: (qc: QueryClient) => void): string {
  const client = new QueryClient()
  seed(client)
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <AppProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/reports/:id?" element={<ReportsPage />} />
          </Routes>
        </MemoryRouter>
      </AppProvider>
    </QueryClientProvider>,
  )
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const opened = (r: SharedReport, run: SharedReportRunResponse | null = { ...ran, report: r }) =>
  render(`/reports/${ID}`, (qc) => {
    qc.setQueryData(sharedReportKeys.report(ID), r)
    if (run) qc.setQueryData(sharedReportKeys.run(ID, null, ''), run)
  })

describe('the Reports page', () => {
  it('lists the reports shared with the person: what each shows, who shared it, when it changed', () => {
    const page: SharedReportsResponse = {
      reports: [{ id: ID, title: 'Weekly scrap', description: 'Scrap by machine this week.', ownerName: 'Cara Creator', updatedAt: '2026-10-19T08:00:00.000Z', inputCount: 1, sectionCount: 2 }],
      hasMore: false,
    }
    const text = render('/reports', (qc) => qc.setQueryData<InfiniteData<SharedReportsResponse>>(sharedReportKeys.list(''), { pages: [page], pageParams: [null] }))
    expect(text).toContain('Reports')
    expect(text).toContain('Weekly scrap Scrap by machine this week. Shared by Cara Creator · 2 sections · asks for 1 value · changed')
  })

  it('opens one without the assistant: its run, Print, and nothing of its owner’s', () => {
    const text = opened(report)
    expect(text).toContain('Weekly scrap')
    expect(text).toContain('Shared with you by Cara Creator')
    expect(text).toContain('Scrap by machine')
    expect(text).toContain('12.5')
    // Opened, it runs (a run on its way says so on its button).
    expect(text).toMatch(/Run again|Running…/)
    expect(text).toContain('Print')
    // No Excel without the permission to export records; no renaming, deleting, sharing, styles or forms.
    for (const absent of ['Export Excel', 'Rename', 'Delete', 'Share with', 'Style', 'form', 'SELECT']) expect(text).not.toContain(absent)
  })

  it('offers Excel to whoever may export records', () => {
    expect(opened({ ...report, excel: true })).toContain('Export Excel')
  })

  it('asks for the inputs its owner defined before it runs, and its period when that can change', () => {
    const asks: SharedReport = {
      ...report,
      adjustable: true,
      period: { kind: 'last_days', days: 7 },
      inputs: [{ name: 'orders', label: 'Orders', kind: 'list', required: true }],
    }
    const text = opened(asks, null)
    expect(text).toContain('Orders')
    expect(text).toContain('Period')
    expect(text).toContain('As saved: Last 7 days')
    expect(text).toContain('Fill in Orders above and press Run.')
  })

  it('says plainly when its owner no longer has the assistant, and runs nothing', () => {
    const text = opened({ ...report, available: false, unavailable: 'Cara Creator no longer has access to the AI assistant, so this report cannot run. Ask them to share it again.' }, null)
    expect(text).toContain('Cara Creator no longer has access to the AI assistant, so this report cannot run. Ask them to share it again.')
    expect(text).not.toMatch(/Run again|Running…/)
  })
})
