import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AiExcelPart } from '@qc/shared/aiExcel'
import { AppProvider } from '@/store/AppContext'
import { AiExcelCard, excelKeptLine, excelRowCount } from './AiExcelCard'

vi.mock('@/store/AuthContext', async (original) => ({
  ...(await original<typeof import('@/store/AuthContext')>()),
  useAuth: () => ({ role: 'supervisor', profile: null, factoryTimeZone: 'Africa/Cairo' }),
}))

beforeAll(() => {
  const stored = new Map<string, string>([['qc-system-theme', 'light']])
  vi.stubGlobal('localStorage', { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v), removeItem: (k: string) => void stored.delete(k) })
})
afterAll(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const html = (part: AiExcelPart) =>
  renderToStaticMarkup(
    <AppProvider>
      <AiExcelCard part={part} />
    </AppProvider>,
  )
const text = (part: AiExcelPart) =>
  html(part)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()

const file: AiExcelPart = {
  type: 'excel',
  fileId: 'f1',
  fileName: 'خردة أكتوبر',
  sheets: [
    { name: 'By machine', title: 'Scrap by machine', columns: ['Machine', 'Pieces', 'Weight (kg)', 'A', 'B', 'C', 'D', 'E', 'F', 'G'], rows: 57 },
    { name: 'Total', columns: ['Pieces'], rows: 1 },
  ],
  byteSize: 7_300,
  expiresAt: '2026-11-12T08:30:00.000Z',
}

describe('the Excel card', () => {
  it('shows the file, its size, each sheet with its columns and rows, and Download', () => {
    const t = text(file)
    expect(t).toContain('Excel file · 7 KB')
    expect(t).toContain('Excel file · 7 KB خردة أكتوبر By machine')
    expect(t).toContain('By machine 10 columns · 57 rows Scrap by machine')
    // Eight columns at most, then how many more.
    expect(t).toContain('Machine Pieces Weight (kg) A B C D E +2 more')
    expect(t).toContain('Total 1 column · 1 row')
    expect(t).toContain('Download Excel')
    expect(t).toContain('Kept until Nov 12')
    expect(html(file)).toContain('aria-label="Excel file: خردة أكتوبر"')
  })

  it('offers no download once the file is no longer kept, and says to ask again', () => {
    const t = text({ ...file, expired: true })
    expect(t).not.toContain('Download Excel')
    expect(t).toContain('No longer kept: files are kept 30 days. Ask again for a new one.')
  })

  it('counts rows as people say them', () => {
    expect(excelRowCount(1)).toBe('1 row')
    expect(excelRowCount(50_000)).toBe('50,000 rows')
    expect(excelKeptLine({ expiresAt: '2026-11-12T08:30:00.000Z' })).toBe('Kept until Nov 12.')
  })
})
