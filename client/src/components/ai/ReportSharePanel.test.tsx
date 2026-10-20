import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReportSharesResponse, ReportShareView } from '@qc/shared/reportShares'
import { AppProvider } from '@/store/AppContext'
import { sharedReportKeys } from '@/services/reportShares'
import { ReportSharePanel, runnerLine, shareChoices } from './ReportSharePanel'

beforeAll(() => {
  const stored = new Map<string, string>([['qc-system-theme', 'light']])
  vi.stubGlobal('localStorage', { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v), removeItem: (k: string) => void stored.delete(k) })
})
afterAll(() => vi.unstubAllGlobals())

const people = [
  { id: 'u1', name: 'Ahmed Ali', username: 'ahmed', role: 'inspector' as const },
  { id: 'u2', name: 'Mona Saad', username: 'mona', role: 'supervisor' as const },
  { id: 'u3', name: 'Vera Viewer', username: 'vera', role: 'viewer' as const },
]
const shares: ReportShareView[] = [
  { kind: 'role', role: 'supervisor', label: 'Every supervisor', sharedAt: '2026-10-19T08:00:00.000Z', sharedByName: 'Cara Creator' },
  { kind: 'user', userId: 'u1', label: 'Ahmed Ali', sharedAt: '2026-10-19T08:00:00.000Z', sharedByName: 'Cara Creator' },
  { kind: 'user', userId: 'u9', label: 'Lea Left', inactive: true, sharedAt: '2026-10-19T08:00:00.000Z', sharedByName: 'Cara Creator' },
]

describe('the Share panel of a report', () => {
  it('offers the people and roles it is not shared with yet', () => {
    const { groups, roles } = shareChoices(people, ['viewer', 'inspector', 'supervisor', 'admin'], shares)
    expect(groups.flatMap(([, list]) => list.map((p) => p.name))).toEqual(['Mona Saad', 'Vera Viewer'])
    expect(roles).toEqual(['viewer', 'inspector', 'admin'])
  })

  it('says what each recipient did with it', () => {
    expect(runnerLine({ runs: 1, exports: 0 })).toBe('1 run')
    expect(runnerLine({ runs: 3, exports: 2 })).toBe('3 runs, 2 exports to Excel')
  })

  it('lists whom it is shared with, an inactive account crossed out, and who ran it', () => {
    const client = new QueryClient()
    const data: ReportSharesResponse = {
      reportId: 'r1',
      shares,
      runners: [{ userId: 'u1', name: 'Ahmed Ali', runs: 2, exports: 1, lastRunAt: '2026-10-20T07:00:00.000Z' }],
      people,
      roles: ['viewer', 'inspector', 'supervisor', 'admin'],
    }
    client.setQueryData(sharedReportKeys.shares('r1'), data)
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <AppProvider>
          <ReportSharePanel reportId="r1" />
        </AppProvider>
      </QueryClientProvider>,
    )
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
    expect(text).toContain('Every supervisor')
    expect(text).toContain('Ahmed Ali')
    expect(html).toContain('aria-label="Stop sharing with Lea Left"')
    expect(html).toMatch(/line-through[^>]*>Lea Left/)
    expect(text).toContain('Who ran it')
    expect(text).toContain('2 runs, 1 export to Excel')
    expect(text).toContain('Share with a person…')
    expect(text).toContain('Share with a role…')
    // The people offered: those it is not shared with.
    expect(text).toContain('Mona Saad (mona)')
    expect(text).not.toContain('Ahmed Ali (ahmed)')
  })
})
