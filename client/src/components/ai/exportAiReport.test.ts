import { describe, expect, it } from 'vitest'
import { aiReportFilename } from './exportAiReport'

describe('a report to Excel', () => {
  it('names the file after the report and the moment it ran, without characters a file may not hold', () => {
    expect(aiReportFilename('Top defects: L1/L2?', '2026-10-09T11:05:00.000Z')).toMatch(/^QC-Report-Top-defects-L1-L2-\d{4}-\d{2}-\d{2}-\d{4}\.xlsx$/)
    expect(aiReportFilename('أكثر العيوب', '2026-10-09T11:05:00.000Z')).toMatch(/^QC-Report-أكثر-العيوب-\d{4}-\d{2}-\d{2}-\d{4}\.xlsx$/)
    expect(aiReportFilename('///', '2026-10-09T11:05:00.000Z')).toMatch(/^QC-Report-\d{4}-\d{2}-\d{2}-\d{4}\.xlsx$/)
  })
})
