// ============================================================================
// Media queries for the few places where CSS alone cannot decide: a finger or
// a mouse, a phone's width or a desktop's. CSS keeps the `touch:` and `mouse:`
// variants (tailwind.config.js); these are their counterparts in script, for a
// behaviour rather than a look — a search box that waits for a tap on a touch
// screen instead of opening the keyboard by itself, a menu that opens as a
// bottom sheet on a phone.
// ============================================================================

import { useEffect, useState } from 'react'

/** A finger: a phone or a tablet, whatever its width. The `touch:` variant in CSS. */
export const COARSE = '(pointer: coarse)'
/** A mouse, a trackpad or a pen. The `mouse:` variant in CSS. */
export const FINE = '(pointer: fine)'
/** Narrower than Tailwind's `sm` (640 px): a phone held upright. The `max-sm:` variant in CSS. */
export const PHONE = 'not all and (min-width: 640px)'

/** Whether `query` matches now. False where there is no window (a test, a server render). */
export function matchesMedia(query: string): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.(query).matches
}

/** Whether `query` matches, kept up to date as the window turns, is resized or gains a mouse. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => matchesMedia(query))
  useEffect(() => {
    const mq = typeof window !== 'undefined' ? window.matchMedia?.(query) : undefined
    if (!mq) return
    const onChange = () => setMatches(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [query])
  return matches
}

/** Whether the main pointer is a finger, kept up to date. */
export function useCoarsePointer(): boolean {
  return useMediaQuery(COARSE)
}

/**
 * Whether the main pointer is a finger, now — for a value read once as an
 * element mounts: `autoFocus={!isCoarsePointer()}` keeps the keyboard shut
 * until the person taps the box.
 */
export function isCoarsePointer(): boolean {
  return matchesMedia(COARSE)
}
