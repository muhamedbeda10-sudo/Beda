// ============================================================================
// The bar's tabs at a desktop's width: their names while they fit between the
// brand and the icons, the same names on tighter padding when only that
// fits, and their icons alone (the names in tooltips) when even that does
// not. Measured, not counted: what fits depends on the tabs this person has
// (four for an inspector, six for the assistant's owner), the icons beside
// them and the window.
// ============================================================================

import { useLayoutEffect, useState, type RefObject } from 'react'

export type NavFit = 'full' | 'compact' | 'icons'

/** The bar's width each looser fit was last seen to need; 0 while not known. */
export interface NavNeeds {
  full: number
  compact: number
}

/** Room kept spare before a looser fit is tried again, so a window on the edge does not flicker between two. */
export const NAV_FIT_SLACK = 24

const NONE: NavNeeds = { full: 0, compact: 0 }

/**
 * The next fit, from what the bar measures in the current one: `overflow`,
 * how far its content runs past it (px); `width`, its own. Too wide: one step
 * tighter, remembering what the looser fit needed. Room enough for what the
 * looser fit needed: one step back. Otherwise it stays — the same objects,
 * so nothing renders again.
 */
export function nextNavFit(fit: NavFit, needs: NavNeeds, overflow: number, width: number): { fit: NavFit; needs: NavNeeds } {
  if (overflow > 1) {
    if (fit === 'full') return { fit: 'compact', needs: { ...needs, full: width + overflow + NAV_FIT_SLACK } }
    if (fit === 'compact') return { fit: 'icons', needs: { ...needs, compact: width + overflow + NAV_FIT_SLACK } }
    return { fit, needs }
  }
  if (fit === 'icons' && width >= needs.compact) return { fit: 'compact', needs }
  if (fit === 'compact' && width >= needs.full) return { fit: 'full', needs }
  return { fit, needs }
}

interface FitState {
  key: string
  fit: NavFit
  needs: NavNeeds
}

/**
 * How the tabs fit in `bar` (the header's row: the brand, `nav`, the icons),
 * measured before each paint and again whenever either changes size. `key`
 * names the tabs shown (and anything that widens them, such as a count): a
 * different set starts over from their names.
 */
export function useNavFit(bar: RefObject<HTMLElement>, nav: RefObject<HTMLElement>, key: string): NavFit {
  const [state, setState] = useState<FitState>({ key, fit: 'full', needs: NONE })
  const current: FitState = state.key === key ? state : { key, fit: 'full', needs: NONE }

  useLayoutEffect(() => {
    const row = bar.current
    const tabs = nav.current
    if (!row || !tabs) return
    const check = () => {
      // A tablet or a phone keeps the tabs in the menu: nothing to fit.
      if (tabs.getClientRects().length === 0) return
      // What runs past the row is measured without the row's end padding, which the tabs need clear of them as well.
      const spill = row.scrollWidth - row.clientWidth
      const overflow = spill > 1 ? spill + (parseFloat(getComputedStyle(row).paddingInlineEnd) || 0) : spill
      setState((prev) => {
        const base: FitState = prev.key === key ? prev : { key, fit: 'full', needs: NONE }
        const next = nextNavFit(base.fit, base.needs, overflow, row.clientWidth)
        return next.fit === base.fit && next.needs === base.needs && base === prev ? prev : { key, ...next }
      })
    }
    check()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(check)
    observer.observe(row)
    observer.observe(tabs)
    return () => observer.disconnect()
  }, [bar, nav, key, current.fit])

  return current.fit
}
