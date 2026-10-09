import { beforeAll, describe, expect, it } from 'vitest'
import { DOMParser as XmlDomParser } from '@xmldom/xmldom'
import type { AiReport, AiReportExportResponse } from '@qc/shared/ai'
import { readWorkbook } from '@/lib/xlsx'
import { writeWorkbook } from '@/lib/xlsxWrite'
import { aiReportExportMessage, aiReportFilename, aiReportSheets } from './exportAiReport'

beforeAll(() => {
  ;(globalThis as { DOMParser?: unknown }).DOMParser = XmlDomParser
})

const report: AiReport = {
  id: 'r1',
  title: 'أكثر العيوب: آخر 30 يوم',
  question: 'إيه أكتر العيوب آخر 30 يوم؟',
  period: { kind: 'last_days', days: 30 },
  adjustable: true,
  sectionCount: 3,
  createdAt: '2026-10-01T08:00:00Z',
  updatedAt: '2026-10-01T08:00:00Z',
  conversationId: 'c1',
  sections: [
    { title: 'Defects by machine', sql: 'SELECT machine, sum(pieces) FROM ai.defects WHERE recorded_day >= {{from}} AND recorded_day < {{to}} + 1 GROUP BY 1' },
    { title: 'Defects by machine', sql: 'SELECT 2' },
    { title: "Report: [holds]?'", sql: 'SELECT broken' },
  ],
}

const data: AiReportExportResponse = {
  report,
  period: { from: '2026-09-10', to: '2026-10-09', label: 'Last 30 days', overridden: false },
  sections: [
    { title: 'Defects by machine', ok: true, columns: ['machine', 'pieces'], rows: [['L1', 30], ['L2', null]], truncated: false },
    { title: 'Defects by machine', ok: true, columns: ['n'], rows: [[1]], truncated: true },
    { title: "Report: [holds]?'", ok: false, error: 'column "broken" does not exist', columns: [], rows: [], truncated: false },
  ],
  ranAt: '2026-10-09T11:05:00.000Z',
}

describe('a report to Excel', () => {
  it('opens on a sheet about the report, then a sheet a section, each named once', () => {
    const sheets = aiReportSheets(data)
    expect(sheets.map((s) => s.name)).toEqual(['Report', '1 Defects by machine', '2 Defects by machine', '3 Report   holds'])
    // The workbook keeps the names as given: they are already valid and distinct.
    const wb = readWorkbook(writeWorkbook(sheets)).sheets
    expect(wb.map((s) => s.name)).toEqual(sheets.map((s) => s.name))
  })

  it('says what was asked, over which days, when, and where each section is', () => {
    const [about] = aiReportSheets(data)
    const rows = about.rows.map((r) => [r[0], r[1]])
    const value = (field: string) => rows.find((r) => r[0] === field)?.[1]
    expect(value('Report')).toBe(report.title)
    expect(value('Question')).toBe(report.question)
    expect(value('Period')).toBe('Last 30 days (10 Sep – 9 Oct 2026)')
    expect(value('Sections')).toBe(3)
    expect(rows.filter((r) => r[0] === 'Sheet').map((r) => r[1])).toEqual(['1 Defects by machine', '2 Defects by machine', '3 Report   holds'])
    expect(rows.filter((r) => r[0] === 'Complete').map((r) => r[1])).toEqual(['Yes', 'No — only the first 1 rows'])
    expect(value('Error')).toBe('column "broken" does not exist')
    expect(rows.filter((r) => r[0] === 'SQL').map((r) => r[1])).toEqual(report.sections.map((s) => s.sql))
  })

  it('writes each section as it came, and a failed one as its error', () => {
    const wb = readWorkbook(writeWorkbook(aiReportSheets(data))).sheets
    expect(wb[1].rows).toEqual([
      ['machine', 'pieces'],
      ['L1', '30'],
      // A NULL is an empty cell (the reader drops it at a row's end).
      ['L2'],
    ])
    expect(wb[3].rows).toEqual([['Error'], ['column "broken" does not exist']])
  })

  it('marks days chosen for the export, and a report with no period', () => {
    const chosen = aiReportSheets({ ...data, period: { from: '2026-09-01', to: '2026-09-30', label: '1 Sep – 30 Sep 2026', overridden: true } })[0]
    expect(chosen.rows.find((r) => r[0] === 'Period')?.[1]).toBe('1 Sep – 30 Sep 2026, chosen for this export')
    const none = aiReportSheets({ ...data, period: null })[0]
    expect(none.rows.find((r) => r[0] === 'Period')?.[1]).toBe('As the queries were asked')
  })

  it('names the file after the report and the moment it ran, without characters a file may not hold', () => {
    expect(aiReportFilename('Top defects: L1/L2?', '2026-10-09T11:05:00.000Z')).toMatch(/^QC-Report-Top-defects-L1-L2-\d{4}-\d{2}-\d{2}-\d{4}\.xlsx$/)
    expect(aiReportFilename('أكثر العيوب', '2026-10-09T11:05:00.000Z')).toMatch(/^QC-Report-أكثر-العيوب-\d{4}-\d{2}-\d{2}-\d{4}\.xlsx$/)
    expect(aiReportFilename('///', '2026-10-09T11:05:00.000Z')).toMatch(/^QC-Report-\d{4}-\d{2}-\d{2}-\d{4}\.xlsx$/)
  })

  it('sums up the export in a sentence', () => {
    expect(aiReportExportMessage(data)).toBe('Exported 3 sections, 3 rows. 1 failed — the workbook says why. A section was cut at the most an export takes.')
    expect(aiReportExportMessage({ ...data, sections: [data.sections[0]] })).toBe('Exported 1 section, 2 rows.')
  })
})
