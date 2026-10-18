import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import type { AiReport } from '@qc/shared/ai'
import type { AutomationDelivery } from '@qc/shared/automation'
import { BUILTIN_REPORT_STYLE, BUILTIN_RESOLVED_STYLE, type ResolvedReportStyle } from '@qc/shared/reportStyles'
import { deliveryFormData, deliveryWorkbookDoc, reportFileName, reportFormData, reportWorkbookDoc, type ReportRunFile } from '../src/reportStyles/documents'
import { factoryStamp, styledWorkbook } from '../src/reportStyles/styledWorkbook'

// What a report and a delivery put in their workbook (the Report sheet's
// lines, a sheet per section) and in a form's cells; and the workbook drawn
// in a style. No database: the documents are built from what a run or a
// delivery holds.

const TZ = 'Africa/Cairo'

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
  shared: false,
  mine: true,
  ownerName: 'Admin',
  madeBy: 'answer',
  inputCount: 1,
  inputs: [{ name: 'orders', label: 'Orders', kind: 'list', required: false }],
  sections: [
    { title: 'Defects by machine', sql: 'SELECT machine, sum(pieces) FROM ai.defects WHERE recorded_day >= {{from}} AND recorded_day < {{to}} + 1 GROUP BY 1' },
    { title: 'Defects by machine', sql: 'SELECT 2' },
    { title: "Report: [holds]?'", sql: 'SELECT broken' },
  ],
}

const run: ReportRunFile = {
  report,
  period: { from: '2026-09-10', to: '2026-10-09', label: 'Last 30 days', overridden: false },
  values: { orders: ['20332', '20378'] },
  sections: [
    { title: 'Defects by machine', ok: true, columns: ['machine', 'pieces'], rows: [['L1', 30], ['L2', null]], truncated: false },
    { title: 'Defects by machine', ok: true, columns: ['n', 'ok', 'detail'], rows: [[1, true, 'كويس']], truncated: true },
    { title: "Report: [holds]?'", ok: false, error: 'column "broken" does not exist', columns: [], rows: [], truncated: false },
  ],
  ranAt: '2026-10-09T11:05:00.000Z',
  style: BUILTIN_RESOLVED_STYLE,
  madeBy: 'Mohamed Beda',
  timeZone: TZ,
}

const delivery: AutomationDelivery = {
  id: 'd1',
  automationId: 'a1',
  automationName: 'Daily rejects',
  ranAt: '2026-10-10T05:00:00Z',
  period: { from: '2026-10-09', to: '2026-10-09', label: 'Yesterday' },
  summary: 'Line 3 had **twice** the rejects of line 1.',
  language: 'en',
  sections: [
    { title: 'Rejects by machine', ok: true, columns: ['machine', 'rejects'], rows: [['RF-01', 12], ['RF-02', 3]], rowCount: 2, truncated: false, ms: 40 },
    { title: 'Holds', ok: false, error: 'column "x" does not exist', columns: [], rows: [], rowCount: 0, truncated: false, ms: 3 },
  ],
  report: { id: 'r1', title: 'Order tracking', open: true },
  inputs: [{ label: 'Orders', value: '20332, 20378' }],
}

const readBook = async (bytes: Buffer) => {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(bytes as unknown as ArrayBuffer)
  return wb
}
const texts = (ws: ExcelJS.Worksheet) => (ws.getSheetValues().flat(2) as unknown[]).filter((v): v is string => typeof v === 'string')

describe('a saved report’s workbook', () => {
  it('says what it shows, its values, its days and when it ran; each section’s SQL as it ran', () => {
    const doc = reportWorkbookDoc(run)
    expect(doc.kind).toBe('Saved report')
    expect(doc.about).toEqual([
      ['Question', 'إيه أكتر العيوب آخر 30 يوم؟'],
      ['Orders', '20332, 20378'],
      ['Period', 'Last 30 days (10 Sep – 9 Oct 2026)'],
      ['Run at', '2026-10-09 14:05'],
    ])
    // The template's days filled in: the SQL runs as it reads.
    expect(doc.sections[0].sql).toContain("recorded_day >= DATE '2026-09-10'")
    expect(doc.sections[2].sql).toBe('SELECT broken')
    expect(reportWorkbookDoc({ ...run, period: { ...run.period!, overridden: true } }).about[2][1]).toContain('chosen for this file')
    expect(reportWorkbookDoc({ ...run, period: null }).about[2]).toEqual(['Period', 'As the queries were asked'])
  })

  it('opens on the Report sheet, then a sheet a section, each named once and as Excel allows', async () => {
    const wb = await readBook(await styledWorkbook(reportWorkbookDoc(run), BUILTIN_RESOLVED_STYLE))
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Report', '1 Defects by machine', '2 Defects by machine', '3 Report holds'])
    const cover = texts(wb.getWorksheet('Report')!)
    expect(cover).toEqual(expect.arrayContaining(['Question', 'Orders', '20332, 20378', 'Failed: column "broken" does not exist', 'No — only the first 1 rows']))
    // Without a logo of its own: the company's wordmark.
    const mark = wb.getWorksheet('Report')!.getCell(1, 1).value as ExcelJS.CellRichTextValue
    expect(mark.richText.map((r) => r.text).join('')).toBe('LINKMISR')
    // Each section's rows as they came: numbers stay numbers, yes/no for a boolean, text as written.
    const second = wb.getWorksheet('2 Defects by machine')!
    expect(second.getRow(4).values).toEqual([undefined, 1, 'Yes', 'كويس'])
    expect(second.getCell(6, 1).value).toBe('No — only the first 1 rows')
    expect(wb.getWorksheet('3 Report holds')!.getCell(4, 1).value).toBe('column "broken" does not exist')
  })

  it('is drawn in its style: typeface, colours, borders, page, document control and signatures', async () => {
    const style: ResolvedReportStyle = {
      id: 's1',
      name: 'Green',
      version: 3,
      logoDataUrl: null,
      spec: {
        ...BUILTIN_REPORT_STYLE,
        font: 'Inter',
        orientation: 'landscape',
        colors: { ...BUILTIN_REPORT_STYLE.colors, tableHeaderBg: '#0A7B3E', tableHeaderText: '#FFFFFF', tableStripe: '#EEF7F1' },
        table: { borders: 'all', stripes: true, compact: true },
        numbering: false,
        docControl: { enabled: true, docNo: 'QF-09', revision: '04', issueDate: '2026-02-01' },
        approvals: { enabled: true, labels: ['Prepared by', 'Approved by'] },
        footer: { text: 'LinkMisr & Co · QA', pageNumbers: true },
      },
    }
    const wb = await readBook(await styledWorkbook(reportWorkbookDoc(run), style))
    const sheet = wb.getWorksheet('1 Defects by machine')!
    // Not numbered: the title as it is.
    expect(sheet.getCell(1, 1).value).toBe('Defects by machine')
    const head = sheet.getCell(3, 1)
    expect((head.fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FF0A7B3E')
    expect(head.font.color?.argb).toBe('FFFFFFFF')
    // Inter is not in Office: Calibri. Compact rows are a size smaller.
    expect(head.font.name).toBe('Calibri')
    expect(head.font.size).toBe(9)
    expect(sheet.getCell(4, 1).border.left?.style).toBe('thin')
    expect((sheet.getCell(5, 1).fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FFEEF7F1')
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 3 })
    expect(sheet.autoFilter).toBeTruthy()
    expect(sheet.pageSetup.orientation).toBe('landscape')
    expect(sheet.pageSetup.printTitlesRow).toBe('3:3')
    // An ampersand is doubled in a header or footer, as Excel reads it.
    expect(sheet.headerFooter.oddFooter).toContain('&L&8LinkMisr && Co · QA')
    expect(sheet.headerFooter.oddFooter).toContain('Page &P of &N')
    const cover = texts(wb.getWorksheet('Report')!)
    expect(cover).toEqual(expect.arrayContaining(['Doc. No.', 'QF-09', 'Rev.', '04', 'Prepared by', 'Approved by', 'Signature:']))
  })
})

describe('a delivered report’s workbook', () => {
  it('names the saved report it sent, the values it ran for, its days and its summary', () => {
    const doc = deliveryWorkbookDoc({ delivery, inputNames: [{ name: 'orders', label: 'Orders' }], style: BUILTIN_RESOLVED_STYLE, madeBy: 'Paula', timeZone: TZ })
    expect(doc.kind).toBe('Scheduled report')
    expect(doc.title).toBe('Daily rejects')
    expect(doc.about).toEqual([
      ['Delivered', '2026-10-10 08:00'],
      ['Saved report', 'Order tracking'],
      ['Orders', '20332, 20378'],
      ['Period', 'Yesterday (9 Oct 2026)'],
      ['Summary', 'Line 3 had **twice** the rejects of line 1.'],
    ])
    const plain = deliveryWorkbookDoc({ delivery: { ...delivery, report: undefined, inputs: undefined, period: null, summary: undefined, summaryNote: 'No summary: the cap was reached.' }, inputNames: [], style: BUILTIN_RESOLVED_STYLE, madeBy: 'Paula', timeZone: TZ })
    expect(plain.about).toEqual([
      ['Delivered', '2026-10-10 08:00'],
      ['Period', 'Its queries take no period'],
      ['Summary', 'No summary: the cap was reached.'],
    ])
    expect(plain.truncatedNote(2)).toBe('No — only the first 2 rows were delivered')
  })
})

describe('what a form’s cells take', () => {
  it('from a run: the report’s fields, its inputs as written, the style’s document control', () => {
    const style = { ...BUILTIN_RESOLVED_STYLE, spec: { ...BUILTIN_REPORT_STYLE, docControl: { enabled: true, docNo: 'QF-07', revision: '02', issueDate: '2026-01-10' } } }
    const data = reportFormData({ ...run, style })
    expect(data.fields).toMatchObject({
      'report.title': report.title,
      'period.label': 'Last 30 days (10 Sep – 9 Oct 2026)',
      'period.from': '2026-09-10',
      'period.to': '2026-10-09',
      'ran.at': '2026-10-09 14:05',
      'ran.day': '2026-10-09',
      'doc.no': 'QF-07',
      'doc.revision': '02',
      'printed.by': 'Mohamed Beda',
    })
    expect(data.inputs).toEqual({ orders: '20332, 20378' })
  })

  it('from a delivery: each input by its name, read back from the label it was kept under', () => {
    const data = deliveryFormData({ delivery, inputNames: [{ name: 'orders', label: 'Orders' }, { name: 'week', label: 'Week' }], style: BUILTIN_RESOLVED_STYLE, madeBy: 'Paula', timeZone: TZ })
    expect(data.inputs).toEqual({ orders: '20332, 20378', week: '' })
    expect(data.fields['report.title']).toBe('Order tracking')
    expect(data.fields['period.label']).toBe('Yesterday (9 Oct 2026)')
  })
})

describe('a file’s name', () => {
  it('is the report’s name and when it ran where the factory sits, without what a file name cannot hold', () => {
    expect(reportFileName('Top defects: L1/L2?', '2026-10-09T11:05:00.000Z', TZ)).toBe('QC-Report-Top-defects-L1-L2-2026-10-09-1405.xlsx')
    expect(reportFileName('أكثر العيوب', '2026-10-09T11:05:00.000Z', TZ)).toBe('QC-Report-أكثر-العيوب-2026-10-09-1405.xlsx')
    expect(reportFileName('///', '2026-10-09T11:05:00.000Z', TZ)).toBe('QC-Report-2026-10-09-1405.xlsx')
    expect(factoryStamp('2026-10-09T23:30:00.000Z', TZ)).toBe('2026-10-10 02:30')
  })
})
