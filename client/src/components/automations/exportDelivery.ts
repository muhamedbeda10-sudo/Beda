// ============================================================================
// §21 — a delivered scheduled report to Excel. What was delivered is kept
// with the delivery (each section's rows up to AUTOMATION_DELIVERY_MAX_ROWS),
// so the workbook is built from it as it is, never run again: it shows what
// the recipients were sent. Laid out as a saved report's workbook is
// (./exportAiReport): a "Report" sheet saying what it is (the saved report it
// sent, and its values), when it ran, over which days, its summary, and for each section its sheet and rows — then a
// sheet per section, in order.
// ============================================================================

import { describeAiDays } from '@qc/shared/ai'
import type { AutomationDelivery } from '@qc/shared/automation'
import { sheetName, type CellValue, type SheetSpec } from '@/lib/xlsxWrite'
import { aiCellValue, aiStamp } from '@/components/ai/exportAiResult'
import { aiReportFilename } from '@/components/ai/exportAiReport'

/** The days a delivery covered, in words: "Yesterday (9 Oct 2026)". */
function periodCell(p: NonNullable<AutomationDelivery['period']>): string {
  const days = describeAiDays(p)
  const label = p.label.trim()
  return !label || label === days ? days : `${label} (${days})`
}

export function deliverySheets(d: AutomationDelivery): SheetSpec[] {
  const taken = new Set<string>()
  const reportSheet = sheetName('Report', taken)
  const names = d.sections.map((s, i) => sheetName(`${i + 1} ${s.title}`, taken))

  const about: CellValue[][] = [
    ['Report', aiCellValue(d.automationName)],
    ['Delivered', aiStamp(d.ranAt)],
    // The saved report it sent, and the values it ran for that day.
    ...(d.report ? [['Saved report', aiCellValue(d.report.title)] as CellValue[]] : []),
    ...(d.inputs ?? []).map((i): CellValue[] => [i.label, aiCellValue(i.value)]),
    ['Period', d.period ? periodCell(d.period) : d.report ? 'As the report covers' : 'Its queries take no period'],
  ]
  if (d.summary) about.push(['Summary', aiCellValue(d.summary)])
  else if (d.summaryNote) about.push(['Summary', aiCellValue(d.summaryNote)])
  about.push(['Sections', d.sections.length])
  d.sections.forEach((s, i) => {
    about.push([], [`Section ${i + 1}`, aiCellValue(s.title)], ['Sheet', names[i]])
    if (s.ok) about.push(['Rows', s.rows.length], ['Complete', s.truncated ? `No — only the first ${s.rows.length.toLocaleString('en-US')} rows were delivered` : 'Yes'])
    else about.push(['Error', aiCellValue(s.error || 'The query failed.')])
  })

  return [
    { name: reportSheet, header: ['Field', 'Value'], rows: about },
    ...d.sections.map((s, i): SheetSpec =>
      s.ok
        ? { name: names[i], header: s.columns, rows: s.rows.map((row) => row.map(aiCellValue)) }
        : { name: names[i], header: ['Error'], rows: [[aiCellValue(s.error || 'The query failed.')]] },
    ),
  ]
}

/** QC-Report-Daily-rejects-2026-10-10-0800.xlsx: the automation's name, and when it ran. */
export const deliveryFilename = (d: Pick<AutomationDelivery, 'automationName' | 'ranAt'>): string => aiReportFilename(d.automationName, d.ranAt)

/** What a toast says once the workbook is saved. */
export function deliveryExportMessage(d: AutomationDelivery): string {
  const ok = d.sections.filter((s) => s.ok)
  const rows = ok.reduce((n, s) => n + s.rows.length, 0)
  let text = `Exported ${d.sections.length} ${d.sections.length === 1 ? 'section' : 'sections'}, ${rows.toLocaleString('en-US')} ${rows === 1 ? 'row' : 'rows'}.`
  const failed = d.sections.length - ok.length
  if (failed) text += ` ${failed} failed — the workbook says why.`
  if (ok.some((s) => s.truncated)) text += ' A section holds only the rows that were delivered.'
  return text
}
