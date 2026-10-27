// ============================================================================
// §20 — the questions the assistant offers: the first ones, in an empty
// conversation, and the follow-up questions an answer ends with. The model
// closes every answer with a <suggestions> block; the server takes it out of
// the saved answer and hands the questions over as `AiMessage.suggestions`.
// While the answer is still being written, the block arrives as text like any
// other, so the thread hides it here — by the server's own rules (./blocks),
// from its first characters, so the tag never flashes on screen before the
// server's copy takes over.
// ============================================================================

import { stripBlocks, type TaggedBlock } from './blocks'
import { KPIS_BLOCK } from './kpis'
import type { LivePart } from './liveTurn'

/**
 * What someone not sure where to start might ask, under the cards of what the
 * assistant can do (./capabilities); a tap puts it in the box to send or
 * change. Each is answerable whatever data the person was given: what the
 * assistant can read for them (its instructions list it). The answer's
 * follow-up questions then come from the data they do have.
 */
export const AI_STARTER_QUESTIONS: readonly string[] = [
  'What can I ask you about, and what would be a good first question?',
  'أقدر أسألك عن إيه بالظبط؟ اقترح عليا كام سؤال مفيد.',
]

/** Follow-up questions shown under an answer, at most. */
export const AI_MAX_SUGGESTIONS = 3

/** The block, as ./blocks finds it: it closes the answer, so one cut off in the middle runs to the end. */
export const SUGGESTIONS_BLOCK: TaggedBlock = { name: 'suggestions', unclosed: 'rest' }

/**
 * An answer's text as it may be shown while it is written: without any whole
 * <suggestions> block, without one that is open and not yet closed (all of it
 * to the end), and without a tag still arriving at the very end ("<sugg").
 */
export function hideSuggestions(text: string): string {
  return stripBlocks(text, true, [SUGGESTIONS_BLOCK])
}

/**
 * The parts of an answer being written, as drawn: each text without the
 * blocks the model writes for the app — its headline figures (./kpis, drawn
 * as cards instead) and its follow-up questions — exactly as the server takes
 * them out of the saved answer: whole ones from every text, one left open as
 * its kind says, and a tag still being written from the text the answer ends
 * with. A text left empty by that is dropped. Queries pass through as they are
 * (the same objects, so their cards are not redrawn).
 */
export function liveDisplayParts(parts: readonly LivePart[]): LivePart[] {
  const out: LivePart[] = []
  parts.forEach((p, i) => {
    if (p.type !== 'text') {
      out.push(p)
      return
    }
    const text = stripBlocks(p.text, i === parts.length - 1, [KPIS_BLOCK, SUGGESTIONS_BLOCK])
    if (!text.trim()) return
    out.push(text === p.text ? p : { type: 'text', text })
  })
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

/**
 * The box's text once a card's question is picked: the question alone in an empty box; after what was typed, on a
 * line of its own, so nothing typed is lost. Picked twice, it is not put in again.
 */
export function withPicked(typed: string, question: string): string {
  const kept = typed.trimEnd()
  if (!kept.trim()) return question
  if (kept.endsWith(question)) return typed
  return `${kept}\n\n${question}`
}
