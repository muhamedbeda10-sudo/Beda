import { beforeAll, describe, expect, it } from 'vitest'
import { DOMParser as XmlDomParser } from '@xmldom/xmldom'
import { AI_EXPORT_MAX_ROWS, type AiQueryExportResponse } from '@qc/shared/ai'
import { readWorkbook } from '@/lib/xlsx'
import { writeWorkbook } from '@/lib/xlsxWrite'
import { EXCEL_CELL_MAX, aiCellValue, aiExportFilename, aiResultSheets } from './exportAiResult'

beforeAll(() => {
  ;(globalThis as { DOMParser?: unknown }).DOMParser = XmlDomParser
})

const result: AiQueryExportResponse = {
  purpose: 'أكثر العيوب هذا الشهر',
  sql: "SELECT defect_name, sum(pieces) AS pieces FROM ai.defects WHERE recorded_day >= '2026-10-01' GROUP BY 1 ORDER BY 2 DESC",
  columns: ['defect_name', 'pieces', 'on_hold', 'pieces'],
  rows: [
    ['Weld porosity', 30, true, 30],
    ['=HYPERLINK("http://example.com")', 5, false, null],
  ],
  truncated: false,
  ranAt: '2026-10-09T11:05:00.000Z',
}

describe('AI query export', () => {
  it('keeps numbers as numbers and writes booleans, blanks and structured values plainly', () => {
    expect(aiCellValue(12.5)).toBe(12.5)
    expect(aiCellValue(Number.NaN)).toBeNull()
    expect(aiCellValue(true)).toBe('Yes')
    expect(aiCellValue(false)).toBe('No')
    expect(aiCellValue(null)).toBeNull()
    expect(aiCellValue(undefined)).toBeNull()
    expect(aiCellValue('2026-09-01 10:00:00+03')).toBe('2026-09-01 10:00:00+03')
    expect(aiCellValue({ a: 1, b: [2, 3] })).toBe('{"a":1,"b":[2,3]}')
  })

  it("cuts a text to Excel's limit for one cell", () => {
    expect((aiCellValue('x'.repeat(EXCEL_CELL_MAX + 10)) as string).length).toBe(EXCEL_CELL_MAX)
  })

  it('writes the result and the query that produced it, and reads back as written', () => {
    const sheets = aiResultSheets(result, 'إيه أكتر العيوب الشهر ده؟')
    expect(sheets.map((s) => s.name)).toEqual(['Result', 'Query'])
    const wb = readWorkbook(writeWorkbook(sheets)).sheets
    // Column order and repeated names are kept as the query returned them.
    expect(wb[0].rows[0]).toEqual(['defect_name', 'pieces', 'on_hold', 'pieces'])
    expect(wb[0].rows[1]).toEqual(['Weld porosity', '30', 'Yes', '30'])
    // A text that looks like a formula stays text.
    expect(wb[0].rows[2][0]).toBe('=HYPERLINK("http://example.com")')
    const about = Object.fromEntries(wb[1].rows.slice(1).map(([k, v]) => [k, v]))
    expect(about.Question).toBe('إيه أكتر العيوب الشهر ده؟')
    expect(about.Purpose).toBe(result.purpose)
    expect(about.SQL).toBe(result.sql)
    expect(about.Rows).toBe('2')
    expect(about.Complete).toBe('Yes')
  })

  it('says when the export stopped at its row limit, and leaves out a question it does not have', () => {
    const [, query] = aiResultSheets({ ...result, truncated: true })
    expect(query.rows.map((r) => r[0])).not.toContain('Question')
    expect(query.rows.find((r) => r[0] === 'Complete')?.[1]).toBe(`No — only the first ${AI_EXPORT_MAX_ROWS.toLocaleString('en-US')} rows`)
  })

  it('names the file after the moment the query ran', () => {
    expect(aiExportFilename('2026-10-09T11:05:00.000Z')).toMatch(/^QC-AI-\d{4}-\d{2}-\d{2}-\d{4}\.xlsx$/)
  })
})
