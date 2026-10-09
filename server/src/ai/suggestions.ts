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

/**
 * Every whole block, wherever it is, its tags as the model may write them:
 * any case, spaces or attributes inside them. The panel hides a block while
 * an answer streams by the very same rule (client/src/components/ai/
 * suggestions.ts), so what it hides then is what is taken out here.
 */
const BLOCK = /<suggestions\b[^>]*>([\s\S]*?)<\/suggestions\s*>/gi
/** A tag that opens a block, whether it ever closes or not (the panel's rule too). */
const OPENING = /<suggestions/i
/** The opening tag's first characters, which a text cut off may end with. */
const OPEN = '<suggestions'
/** A line that opens or closes a code fence: three or more ` or ~, indented at most three spaces. */
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/
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
 * The span [start, end) of a block, widened to the code fence around it when
 * the model fenced it as code: taken out alone, it would leave an empty code
 * block behind. A fence that opens just before the block (nothing but space
 * between) and closes just after it, or never closes when the block ends the
 * text.
 */
function withFence(text: string, start: number, end: number): [number, number] {
  // The last line with text before the block, which must end before the block's own line begins.
  const head = text.slice(0, start)
  const lineEnd = head.trimEnd().length
  if (lineEnd === 0 || !head.slice(lineEnd).includes('\n')) return [start, end]
  const openerAt = head.lastIndexOf('\n', lineEnd - 1) + 1
  const opener = head.slice(openerAt, lineEnd)
  const fence = FENCE_LINE.exec(opener)
  // A backtick fence's info string holds no backtick (```a``` is inline code).
  if (!fence || (fence[1][0] === '`' && opener.slice(fence[0].length).includes('`'))) return [start, end]
  // An opening fence only when every fence above it is closed: otherwise this line closes a code block of the answer.
  const above = text.slice(0, openerAt).split('\n').filter((line) => FENCE_LINE.test(line)).length
  if (above % 2 !== 0) return [start, end]
  const rest = text.slice(end)
  if (!rest.trim()) return [openerAt, text.length]
  // The closing fence: the same character, at least as many, alone on its line.
  const after = /^[ \t]*\r?\n(?:[ \t]*\r?\n)*( {0,3})(`{3,}|~{3,})[ \t]*(?=\r?\n|$)/.exec(rest)
  if (!after || after[2][0] !== fence[1][0] || after[2].length < fence[1].length) return [start, end]
  return [openerAt, end + after[0].length]
}

/**
 * The text with every whole block taken out, and an unfinished one at its very
 * end (an answer cut off while writing it): from an opening tag that is never
 * closed, or from a partial tag such as "<sugg" that ends the text. A code
 * fence the model put around a block goes with it.
 */
export function stripSuggestions(text: string, atEnd: boolean): string {
  const cuts: [number, number][] = [...text.matchAll(BLOCK)].map((m) => [m.index, m.index + m[0].length])
  if (atEnd) {
    const after = cuts.length > 0 ? cuts[cuts.length - 1][1] : 0
    const tail = text.slice(after)
    const open = tail.search(OPENING)
    if (open >= 0) cuts.push([after + open, text.length])
    else {
      // "<s", "<su", … "<suggestions" ending the text: the start of a tag the answer never finished.
      const lt = tail.lastIndexOf('<')
      if (lt >= 0 && tail.length - lt >= 2 && OPEN.startsWith(tail.slice(lt).toLowerCase())) cuts.push([after + lt, text.length])
    }
  }
  if (cuts.length === 0) return text
  let out = ''
  let from = 0
  for (const [start, end] of cuts.map(([s, e]) => withFence(text, s, e))) {
    // A fence taken with one block never reaches back over text already taken.
    out += text.slice(from, Math.max(from, start))
    from = Math.max(from, end)
  }
  out += text.slice(from)
  // Cut text loses the blank lines the block leaves behind.
  return out.trimEnd()
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
