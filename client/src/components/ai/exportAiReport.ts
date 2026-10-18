// ============================================================================
// §20 — the name a saved report's workbook is saved under. The workbook
// itself — a "Report" sheet saying what was asked, over which days, when it
// ran, its values and for each section its sheet, its rows and its SQL, then
// a sheet per section — is made by the server, in the report's style
// (server/src/reportStyles/styledWorkbook.ts).
// ============================================================================

import { aiStamp } from './exportAiResult'

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
