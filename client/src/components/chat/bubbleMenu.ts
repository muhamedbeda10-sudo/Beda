// ============================================================================
// Where a message's actions open, and how a finger asks for them. Under a
// mouse on a wide screen they are a small menu beside the bubble, turned to
// whichever side of it has room inside the thread; with a finger, or on a
// screen narrower than a laptop's, they are a sheet from the bottom of the
// screen — the message's last lines sit right above the composer, where a
// menu dropped below them would land out of sight.
// ============================================================================

import { COARSE } from '@/lib/media'

/** A finger, or a window narrower than `lg` (1024 px): the actions open as a bottom sheet. */
export const ACTIONS_AS_SHEET = `${COARSE}, not all and (min-width: 1024px)`

/** How long a finger rests on a bubble before its actions open (a little under the tooltip's 500 ms, which it replaces there). */
export const BUBBLE_LONG_PRESS_MS = 450

/** A vertical span on screen: a bubble, or the part of the thread in view. */
export interface Span {
  top: number
  bottom: number
}

/**
 * Which side of the bubble the menu opens on: below it when it fits inside
 * the thread's visible part, above it when it fits there instead, and
 * otherwise on the side with more room (the thread then scrolls it into view).
 */
export function menuSide(bubble: Span, menuHeight: number, view: Span, gap = 4): 'below' | 'above' {
  const below = view.bottom - bubble.bottom - gap
  const above = bubble.top - view.top - gap
  if (below >= menuHeight) return 'below'
  if (above >= menuHeight) return 'above'
  return above > below ? 'above' : 'below'
}

/**
 * How far to move a menu sideways so it stays inside `[min, max]` (the
 * thread's width, less a margin): none when it fits, else just enough — and
 * a menu wider than the space keeps its start in view.
 */
export function sideShift(left: number, right: number, min: number, max: number): number {
  if (right - left >= max - min) return min - left
  if (left < min) return min - left
  if (right > max) return max - right
  return 0
}
