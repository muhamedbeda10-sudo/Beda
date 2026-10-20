// ============================================================================
// The Reports page's words and checks (pages/ReportsPage.tsx): the pages of
// the list as one, the line under each report, and whether a report the
// person had open is no longer theirs to run. Pure, so it is tested without a
// browser.
// ============================================================================

import type { SharedReportSummary } from '@qc/shared/reportShares'
import { ApiError } from '@/lib/api'

/** The pages of the list as one, each report once: one changed while the pages were fetched can be on two, and its newer place wins. */
export function mergeSharedPages(pages: readonly { reports: readonly SharedReportSummary[] }[] | undefined): SharedReportSummary[] {
  const seen = new Set<string>()
  const out: SharedReportSummary[] = []
  for (const page of pages ?? []) {
    for (const r of page.reports) {
      if (seen.has(r.id)) continue
      seen.add(r.id)
      out.push(r)
    }
  }
  return out
}

/** What a report's row says under its title: who shared it, and what it asks for. */
export function sharedReportLine(r: Pick<SharedReportSummary, 'ownerName' | 'inputCount' | 'sectionCount'>): string {
  const sections = `${r.sectionCount} ${r.sectionCount === 1 ? 'section' : 'sections'}`
  const asks = r.inputCount > 0 ? ` · asks for ${r.inputCount} ${r.inputCount === 1 ? 'value' : 'values'}` : ''
  return `Shared by ${r.ownerName || 'someone'} · ${sections}${asks}`
}

/** A report that answers "not found": unshared, or deleted, since the person opened it. */
export const sharedReportGone = (error: unknown): boolean => error instanceof ApiError && error.status === 404

/** What the page says of a report that is gone. */
export const SHARED_REPORT_GONE = 'This report is no longer shared with you, or it was deleted. Ask whoever shared it if you still need it.'
