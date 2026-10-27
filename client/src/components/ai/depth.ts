// ============================================================================
// §20 — the depth the person picks above the question box (Quick, Standard,
// Deep: AI_DEPTHS), remembered on this device for the questions after it.
// Deep is not remembered: it costs about twice as much, so it lasts until the
// page is opened again, which starts from the last Quick or Standard picked
// rather than sending every later question to the strongest model unasked.
// ============================================================================

import { AI_DEFAULT_DEPTH, isAiDepth, type AiDepth } from '@qc/shared/ai'

export const DEPTH_KEY = 'qc-ai-depth'

/** The Quick or Standard picked last on this device; Standard when none, or storage is blocked. */
export function readDepth(): AiDepth {
  try {
    const raw = localStorage.getItem(DEPTH_KEY)
    return isAiDepth(raw) && raw !== 'deep' ? raw : AI_DEFAULT_DEPTH
  } catch {
    return AI_DEFAULT_DEPTH
  }
}

/** Remembers Quick or Standard; Deep leaves what is remembered as it was. */
export function writeDepth(depth: AiDepth): void {
  if (depth === 'deep') return
  try {
    if (depth === AI_DEFAULT_DEPTH) localStorage.removeItem(DEPTH_KEY)
    else localStorage.setItem(DEPTH_KEY, depth)
  } catch {
    // A private window or blocked storage: the next visit starts at Standard.
  }
}
