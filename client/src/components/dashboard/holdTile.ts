// ============================================================================
// The "On Hold now" tile (§15.4): every Hold behind the filters, counted and
// summed by the server (KpiOverview.holdTotals, aged against the thresholds
// there), never only the oldest fifty the Holds list carries. Pure, so it is
// tested without a browser.
// ============================================================================

import type { KpiHoldTotals } from '@qc/shared/kpi'

export type HoldTone = 'red' | 'amber' | 'neutral' | 'green'

/** How many defects wait on Hold, their pieces, and the tile's colour: red when one is past the red age line, amber past the amber one. */
export function holdTile(totals: KpiHoldTotals): { defects: number; pieces: number; tone: HoldTone } {
  const tone: HoldTone = totals.red > 0 ? 'red' : totals.amber > 0 ? 'amber' : totals.defects > 0 ? 'neutral' : 'green'
  return { defects: totals.defects, pieces: totals.pieces, tone }
}
