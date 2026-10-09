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

/** At most this many questions are offered. */
export const MAX_SUGGESTIONS = 3
/** A question longer than this is cut: the prompt asks for 120 characters, this is the slack. */
export const MAX_SUGGESTION_CHARS = 200

const OPEN = '<suggestions>'
const CLOSE = '</suggestions>'
/** Every whole block, wherever it is. */
const BLOCK = /<suggestions>([\s\S]*?)<\/suggestions>/g
/** A list marker: "- ", "* ", "• ", "1. ", "1) ". */
const MARKER = /^(?:[-*•]\s+|\d{1,2}[.)]\s*)/

/** The questions of one block's body: its list lines, markers dropped, at most three, each within the length allowed. */
function questionsOf(body: string): string[] {
  const out: string[] = []
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim()
    const marker = MARKER.exec(line)
    if (!marker) continue
    // By characters, not UTF-16 units: an emoji or an Arabic letter is never cut in half.
    const chars = Array.from(line.slice(marker[0].length).trim())
    const question = (chars.length > MAX_SUGGESTION_CHARS ? chars.slice(0, MAX_SUGGESTION_CHARS) : chars).join('').trimEnd()
    if (question && !out.includes(question)) out.push(question)
    if (out.length === MAX_SUGGESTIONS) break
  }
  return out
}

/**
 * The text with every whole block taken out, and an unfinished one at its very
 * end (an answer cut off while writing it): from an opening tag that is never
 * closed, or from a partial tag such as "<sugg" that ends the text.
 */
export function stripSuggestions(text: string, atEnd: boolean): string {
  let out = text.replace(BLOCK, '')
  if (atEnd) {
    const open = out.lastIndexOf(OPEN)
    if (open >= 0 && out.indexOf(CLOSE, open) < 0) out = out.slice(0, open)
    else {
      // "<s", "<su", … "<suggestions" ending the text: the start of a tag the answer never finished.
      for (let n = Math.min(OPEN.length - 1, out.length); n >= 2; n--) {
        if (out.endsWith(OPEN.slice(0, n))) {
          out = out.slice(0, out.length - n)
          break
        }
      }
    }
  }
  // Untouched text stays exactly as written; cut text loses the blank lines the block leaves behind.
  return out === text ? text : out.trimEnd()
}

/**
 * The follow-up questions of an answer's final text: those of its last whole
 * block. Empty when there is none, or it lists nothing.
 */
export function parseSuggestions(finalText: string): string[] {
  let last: string | null = null
  for (const m of finalText.matchAll(BLOCK)) last = m[1]
  return last === null ? [] : questionsOf(last)
}
