// ============================================================================
// §20 — the follow-up questions an answer ends with. The system prompt asks
// the model to close every answer with a block
//
//     <suggestions>
//     - first question
//     - second question
//     </suggestions>
//
// The transcript keeps it as written (it is replayed byte for byte); only the
// display takes it out of the text and hands the questions over on their own,
// for the panel to show as chips under the latest answer. No extra call.
// ============================================================================

import { LIST_MARKER, cutChars, lastBlockBody, stripBlocks, type AnswerBlock } from './blocks'

/** At most this many questions are offered. */
export const MAX_SUGGESTIONS = 3
/** A question longer than this is cut: the prompt asks for 120 characters, this is the slack. */
export const MAX_SUGGESTION_CHARS = 200

/**
 * The block, as blocks.ts finds it. One the answer was cut off in the middle
 * of runs to the end of the answer: the panel hides a block while an answer
 * streams by the very same rule (client/src/components/ai/suggestions.ts), so
 * what it hides then is what is taken out here.
 */
export const SUGGESTIONS_BLOCK: AnswerBlock = { name: 'suggestions', unclosed: 'rest' }

/** The questions of one block's body: its list lines, markers dropped, at most three, each within the length allowed. */
function questionsOf(body: string): string[] {
  const out: string[] = []
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim()
    const marker = LIST_MARKER.exec(line)
    if (!marker) continue
    const question = cutChars(line.slice(marker[0].length).trim(), MAX_SUGGESTION_CHARS, false)
    if (question && !out.includes(question)) out.push(question)
    if (out.length === MAX_SUGGESTIONS) break
  }
  return out
}

/**
 * The text with every whole block taken out, and an unfinished one at its very
 * end (an answer cut off while writing it): from an opening tag that is never
 * closed, or from a partial tag such as "<sugg" that ends the text. A code
 * fence the model put around a block goes with it.
 */
export function stripSuggestions(text: string, atEnd: boolean): string {
  return stripBlocks(text, atEnd, [SUGGESTIONS_BLOCK])
}

/**
 * The follow-up questions of an answer's final text: those of its last whole
 * block. Empty when there is none, or it lists nothing.
 */
export function parseSuggestions(finalText: string): string[] {
  const body = lastBlockBody([finalText], SUGGESTIONS_BLOCK)
  return body === null ? [] : questionsOf(body)
}
