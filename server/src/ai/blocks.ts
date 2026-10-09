// ============================================================================
// §20 — the blocks an answer carries for the app rather than for its reader.
// The system prompt of a conversation asks the model to put some things in a
// tagged block of their own: the headline figures an answer opens with
//
//     <kpis>
//     - Defect pieces | 39
//     </kpis>
//
// and the follow-up questions it closes with (<suggestions>). The transcript
// keeps every block as written, since it is replayed byte for byte; only the
// display takes the blocks out of the text and hands what they hold over on
// their own (kpis.ts, suggestions.ts). No extra call.
//
// A block is found however the model wrote its tags (any case, spaces or
// attributes inside them), and a code fence the model put around it goes
// with it. The panel hides the blocks while an answer streams; the server's
// copy takes over when the answer is done.
//
// An answer may also name a tag in its text ("the `<kpis>` block"). A tag
// named that way opens no block: a whole block begins at the last opening tag
// before its closing one, and one whose closing tag never came begins only
// with an opening tag on a line of its own, as the prompt has it written.
// ============================================================================

/** A kind of block, by its tag. */
export interface AnswerBlock {
  /** The tag's name: "kpis", "suggestions". */
  name: string
  /**
   * Where a block whose closing tag never came ends. Such a block begins with
   * an opening tag on a line of its own (or one still being written as the
   * answer's last line); a tag in the middle of a line is text.
   *   • 'rest' — at the end of the answer: a block that closes the answer and
   *     was cut off while it was written. Only the answer's last text is cut,
   *     from the opening tag on.
   *   • 'paragraph' — at its first blank line (or code fence): a block that
   *     opens the answer, where the closing tag left out must not take the
   *     whole answer with it. In any text; to the end when no blank line
   *     comes, as when the answer was cut off inside it.
   */
  unclosed: 'rest' | 'paragraph'
}

interface Compiled {
  /**
   * Every whole block, its body captured: from the last opening tag before
   * its closing tag, so that a tag the answer named earlier is no part of it.
   */
  whole: RegExp
  /** An opening tag on a line of its own: the start of a block whose closing tag may never come. */
  opening: RegExp
  /** An opening tag still being written on the text's last line of its own: its name, perhaps attributes, no ">" yet. */
  writing: RegExp
  /** The opening tag's first characters, which a text cut off may end with. */
  open: string
}

const compiled = new Map<string, Compiled>()

function compile(block: AnswerBlock): Compiled {
  let c = compiled.get(block.name)
  if (!c) {
    const tag = `<${block.name}\\b`
    c = {
      whole: new RegExp(`${tag}[^>]*>((?:(?!${tag})[\\s\\S])*?)<\\/${block.name}\\s*>`, 'gi'),
      opening: new RegExp(`^[ \\t]*${tag}[^>\\r\\n]*>[ \\t]*$`, 'gim'),
      writing: new RegExp(`(?:^|\\n)[ \\t]*${tag}[^>\\r\\n]*$`, 'gi'),
      open: `<${block.name}`,
    }
    compiled.set(block.name, c)
  }
  return c
}

/** Where each tag a pattern finds in a text begins: its "<", after the indentation and line break the pattern takes in. */
function tagsAt(text: string, pattern: RegExp): number[] {
  return [...text.matchAll(pattern)].map((m) => m.index + m[0].indexOf('<'))
}

/** A line that opens or closes a code fence: three or more ` or ~, indented at most three spaces. */
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/
/** A list marker: "- ", "* ", "• ", "1. ", "1) ". */
export const LIST_MARKER = /^(?:[-*•]\s+|\d{1,2}[.)]\s*)/

/** The bodies of every whole block of a kind in a text, in order. */
export function blockBodies(text: string, block: AnswerBlock): string[] {
  return [...text.matchAll(compile(block).whole)].map((m) => m[1])
}

/** The last whole block's body of a kind over several texts, in order; null when none has one. */
export function lastBlockBody(texts: readonly string[], block: AnswerBlock): string | null {
  let last: string | null = null
  for (const text of texts) {
    const bodies = blockBodies(text, block)
    if (bodies.length > 0) last = bodies[bodies.length - 1]
  }
  return last
}

/** Text cut to a number of characters (not UTF-16 units: an emoji or an Arabic letter is never cut in half), with an ellipsis when it was cut. */
export function cutChars(text: string, max: number, ellipsis: boolean): string {
  const chars = Array.from(text)
  if (chars.length <= max) return text
  return ellipsis ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : chars.slice(0, max).join('').trimEnd()
}

/** Where an unclosed block that opens at `at` ends: before the first blank line or fence line after its tag's own line, or at the end of the text. */
function paragraphEnd(text: string, at: number): number {
  let lineEnd = text.indexOf('\n', at)
  if (lineEnd < 0) return text.length
  let end = lineEnd
  for (;;) {
    const next = lineEnd + 1
    const nextEnd = text.indexOf('\n', next)
    const line = text.slice(next, nextEnd < 0 ? text.length : nextEnd).replace(/\r$/, '')
    if (line.trim() === '' || FENCE_LINE.test(line)) return end
    end = nextEnd < 0 ? text.length : nextEnd
    if (nextEnd < 0) return end
    lineEnd = nextEnd
  }
}

/** The spans [start, end) of one kind of block in a text, before fences. */
function spansOf(text: string, block: AnswerBlock, atEnd: boolean): [number, number][] {
  const c = compile(block)
  const spans: [number, number][] = [...text.matchAll(c.whole)].map((m) => [m.index, m.index + m[0].length])
  if (block.unclosed === 'paragraph') {
    // Every opening tag on a line of its own that is not inside a block already found: a whole one, or the paragraph of one before it.
    for (const at of tagsAt(text, c.opening)) {
      if (spans.some(([s, e]) => at >= s && at < e)) continue
      spans.push([at, paragraphEnd(text, at)])
    }
  }
  if (atEnd) {
    const after = spans.reduce((max, [, e]) => Math.max(max, e), 0)
    const tail = text.slice(after)
    // A block that closes the answer: from its opening tag on. Either kind: a tag still being written on the last line.
    const open = [...(block.unclosed === 'rest' ? tagsAt(tail, c.opening) : []), ...tagsAt(tail, c.writing)]
    if (open.length > 0) spans.push([after + open[0], text.length])
    else {
      // "<s", "<su", … "<suggestions" ending the text: the start of a tag the answer never finished.
      const lt = tail.lastIndexOf('<')
      if (lt >= 0 && tail.length - lt >= 2 && c.open.startsWith(tail.slice(lt).toLowerCase())) spans.push([after + lt, text.length])
    }
  }
  return spans
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
 * The text with every block of the given kinds taken out: every whole one;
 * an unclosed one as its kind says (AnswerBlock.unclosed); and, at the very
 * end of the answer (`atEnd`), a tag still being written ("<sugg", "<kp").
 * A code fence the model put around a block goes with it, and so do the blank
 * lines a block leaves at the start or the end of the text.
 */
export function stripBlocks(text: string, atEnd: boolean, blocks: readonly AnswerBlock[]): string {
  const spans = blocks.flatMap((b) => spansOf(text, b, atEnd)).map(([s, e]) => withFence(text, s, e))
  if (spans.length === 0) return text
  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  let out = ''
  let from = 0
  for (const [start, end] of spans) {
    // A span never reaches back over text already taken (a fence taken with one block, or blocks inside each other).
    out += text.slice(from, Math.max(from, start))
    from = Math.max(from, end)
  }
  out += text.slice(from)
  // A block that opened the text leaves its blank lines behind; the first line keeps its indentation.
  if (text.slice(0, spans[0][0]).trim() === '') out = out.replace(/^(?:[ \t]*\r?\n)+/, '')
  return out.trimEnd()
}
