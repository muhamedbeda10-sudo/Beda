// ============================================================================
// A bar fixed along the bottom of the screen (the inspection's Back / Next,
// a selection's toolbar) says how tall it is, as --app-bottom-inset on the
// document. What floats in the bottom corner — the assistant's button and its
// card (index.css: .ai-fab, .ai-popup-compact) — sits above it instead of over
// the buttons a person is pressing. A bar that goes, or is hidden (0 high),
// gives the space back.
// ============================================================================

import { useCallback, useRef } from 'react'

export const BOTTOM_INSET_VAR = '--app-bottom-inset'

/** The bars on screen now and their heights: the tallest one counts (two at once are not expected, but harmless). */
const heights = new Map<Element, number>()

function publish(): void {
  const tallest = Math.max(0, ...heights.values())
  const root = document.documentElement.style
  if (tallest > 0) root.setProperty(BOTTOM_INSET_VAR, `${Math.ceil(tallest)}px`)
  else root.removeProperty(BOTTOM_INSET_VAR)
}

/** A ref for a bottom bar: while the element is attached, its height is the inset; detached, it is not. */
export function useBottomBarRef<T extends HTMLElement>(): (el: T | null) => void {
  const observed = useRef<{ el: T; observer: ResizeObserver } | null>(null)
  const release = useCallback(() => {
    const o = observed.current
    if (!o) return
    o.observer.disconnect()
    heights.delete(o.el)
    observed.current = null
    publish()
  }, [])
  // No cleanup effect: React hands the ref null when the bar goes, which releases it. (An effect's cleanup would also
  // run in StrictMode's rehearsal, after the ref was set and with no second call to set it again.)
  return useCallback(
    (el: T | null) => {
      if (observed.current?.el === el) return
      release()
      if (!el || typeof ResizeObserver === 'undefined') return
      const observer = new ResizeObserver(() => {
        // offsetHeight is 0 while the bar is hidden (display: none at a breakpoint).
        heights.set(el, el.offsetHeight)
        publish()
      })
      observer.observe(el)
      heights.set(el, el.offsetHeight)
      observed.current = { el, observer }
      publish()
    },
    [release],
  )
}
