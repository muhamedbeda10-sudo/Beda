// ============================================================================
// §20 — a saved report to Excel. The server runs every section again in full
// (up to AI_EXPORT_MAX_ROWS rows each) over the period on screen; the
// workbook opens on a "Report" sheet that says what was asked, over which
// days, when it ran, and for each section its sheet, its rows and the SQL
// that produced them — then one sheet per section, in the report's order.
// ============================================================================

import { describeAiDays, type AiReportExportResponse } from '@qc/shared/ai'
import { sheetName, type CellValue, type SheetSpec } from '@/lib/xlsxWrite'
import { aiCellValue, aiStamp } from './exportAiResult'
import { sectionSqlForRun } from './reports'

/** The period of an export in words, and whether it was the saved one. */
function periodCell(p: NonNullable<AiReportExportResponse['period']>): string {
  const days = describeAiDays(p)
  const label = p.label.trim()
  const words = !label || label === days ? days : `${label} (${days})`
  return p.overridden ? `${words}, chosen for this export` : words
}

export function aiReportSheets(r: AiReportExportResponse): SheetSpec[] {
  // Named here, in the order the workbook takes them, so the Report sheet can say where each section is.
  const taken = new Set<string>()
  const reportSheet = sheetName('Report', taken)
  const names = r.sections.map((s, i) => sheetName(`${i + 1} ${s.title}`, taken))

  const about: CellValue[][] = [
    ['Report', aiCellValue(r.report.title)],
    ['Question', aiCellValue(r.report.question)],
    ['Period', r.period ? periodCell(r.period) : 'As the queries were asked'],
    ['Run at', aiStamp(r.ranAt)],
    ['Sections', r.sections.length],
  ]
  r.sections.forEach((s, i) => {
    about.push([], [`Section ${i + 1}`, aiCellValue(s.title)], ['Sheet', names[i]])
    if (s.ok) {
      about.push(['Rows', s.rows.length], ['Complete', s.truncated ? `No — only the first ${s.rows.length.toLocaleString('en-US')} rows` : 'Yes'])
    } else {
      about.push(['Error', aiCellValue(s.error || 'The query failed.')])
    }
    // As it ran: a template's {{from}} and {{to}} are the export's days, so the SQL runs as it reads.
    const section = r.report.sections[i]
    if (section?.sql) about.push(['SQL', aiCellValue(sectionSqlForRun(r.report, section.sql, r.period))])
  })

  return [
    { name: reportSheet, header: ['Field', 'Value'], rows: about },
    ...r.sections.map((s, i): SheetSpec =>
      s.ok
        ? { name: names[i], header: s.columns, rows: s.rows.map((row) => row.map(aiCellValue)) }
        : { name: names[i], header: ['Error'], rows: [[aiCellValue(s.error || 'The query failed.')]] },
    ),
  ]
}

/** QC-Report-Top-defects-2026-10-09-1405.xlsx: the report's title, and the moment it ran. */
export function aiReportFilename(title: string, ranAt: string): string {
  const name = title
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 50)
    .replace(/[-.]+$/, '')
  const at = aiStamp(ranAt).replace(' ', '-').replace(':', '')
  return name ? `QC-Report-${name}-${at}.xlsx` : `QC-Report-${at}.xlsx`
}

/** What a toast says once the workbook is saved. */
export function aiReportExportMessage(r: AiReportExportResponse): string {
  const ok = r.sections.filter((s) => s.ok)
  const rows = ok.reduce((n, s) => n + s.rows.length, 0)
  const sections = `${r.sections.length} ${r.sections.length === 1 ? 'section' : 'sections'}`
  const failed = r.sections.length - ok.length
  const cut = ok.some((s) => s.truncated)
  let text = `Exported ${sections}, ${rows.toLocaleString('en-US')} ${rows === 1 ? 'row' : 'rows'}.`
  if (failed) text += ` ${failed} failed — the workbook says why.`
  if (cut) text += ' A section was cut at the most an export takes.'
  return text
}
