// ============================================================================
// §20 — the follow-up questions an answer ends with. The model closes every
// answer with a <suggestions> block; the server takes it out of the saved
// answer and hands the questions over as `AiMessage.suggestions`. While the
// answer is still being written, the block arrives as text like any other,
// so the thread hides it here — from its first characters, so the tag never
// flashes on screen before the server's copy takes over.
// ============================================================================

import type { LivePart } from './liveTurn'

/** Follow-up questions shown under an answer, at most. */
export const AI_MAX_SUGGESTIONS = 3

const OPEN = '<suggestions'
const BLOCK = /<suggestions\b[^>]*>[\s\S]*?<\/suggestions\s*>/gi

/**
 * An answer's text as it may be shown while it is written: without any whole
 * <suggestions> block, without one that is open and not yet closed (all of it
 * to the end), and without a tag still arriving at the very end ("<sugg").
 */
export function hideSuggestions(text: string): string {
  let out = text.replace(BLOCK, '')
  const open = out.search(/<suggestions/i)
  if (open >= 0) out = out.slice(0, open)
  else {
    // A lone "<" or "<sugg…" at the end may be the tag's first characters: held back until the next piece says.
    const lt = out.lastIndexOf('<')
    if (lt >= 0 && out.length - lt <= OPEN.length && OPEN.startsWith(out.slice(lt).toLowerCase())) out = out.slice(0, lt)
  }
  return out === text ? text : out.trimEnd()
}

/**
 * The parts of an answer being written, as drawn: each text without its
 * suggestions block, and a text left empty by that dropped. Queries pass
 * through as they are (the same objects, so their cards are not redrawn).
 */
export function liveDisplayParts(parts: readonly LivePart[]): LivePart[] {
  const out: LivePart[] = []
  for (const p of parts) {
    if (p.type !== 'text') {
      out.push(p)
      continue
    }
    const text = hideSuggestions(p.text)
    if (!text.trim()) continue
    out.push(text === p.text ? p : { type: 'text', text })
  }
  return out
}

/** The questions to offer as chips: trimmed, without blanks or repeats, at most three. */
export function suggestionChips(suggestions: readonly string[] | undefined): string[] {
  if (!suggestions) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const s of suggestions) {
    const q = typeof s === 'string' ? s.trim() : ''
    if (!q || seen.has(q)) continue
    seen.add(q)
    out.push(q)
    if (out.length === AI_MAX_SUGGESTIONS) break
  }
  return out
}

/**
 * A request to put the caret in the question box. `always`: on a touch screen
 * too, raising its keyboard — a follow-up question was tapped to be finished
 * there. Any other request (the panel opening, a new chat, an example) leaves
 * a phone's keyboard down, where it would cover the answer.
 */
export interface ComposerFocus {
  key: number
  always: boolean
}

/** Whether the box takes the caret for a request. */
export const takesCaret = (focus: ComposerFocus, touch: boolean): boolean => !touch || focus.always

/**
 * A request once acted on: its `always` is spent. The panel keeps the last
 * request while the box comes and goes (History, My reports, a report's "Open
 * the conversation"), and the box acts on it again each time it comes back —
 * as on opening, so a phone's keyboard stays down. The same object when there
 * is nothing to spend.
 */
export const spentFocus = (focus: ComposerFocus): ComposerFocus => (focus.always ? { key: focus.key, always: false } : focus)
