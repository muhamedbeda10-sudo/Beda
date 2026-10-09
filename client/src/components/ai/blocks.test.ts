import { describe, expect, it } from 'vitest'
import { blockBodies, cutChars, lastBlockBody, stripBlocks } from './blocks'
import { KPIS_BLOCK } from './kpis'
import { SUGGESTIONS_BLOCK } from './suggestions'

// The cases of the server's own test of these rules (server/test/ai.answers.test.ts): what the thread hides
// while an answer is written must be what the server leaves out of the saved answer.
const both = (text: string, atEnd: boolean) => stripBlocks(text, atEnd, [KPIS_BLOCK, SUGGESTIONS_BLOCK])

describe('the blocks an answer carries for the app', () => {
  it('takes a block out however it was written, and the blank lines it leaves at the start', () => {
    expect(both('<kpis>\n- A | 1\n</kpis>\n\nThe answer.', true)).toBe('The answer.')
    expect(both('```\n<kpis>\n- A | 1\n</kpis>\n```\n\nThe answer.', true)).toBe('The answer.')
    expect(both('<Kpis>\n- A | 1\n</Kpis>\n\n    indented code', true)).toBe('    indented code')
    expect(both('Let me check.\n\n<kpis>\n- A | 1\n</kpis>\n\nThe answer.', false)).toBe('Let me check.\n\n\n\nThe answer.')
    expect(both('<kpis>\n- A | 1\n</kpis>\n\nThe answer.\n\n<suggestions>\n- Next?\n</suggestions>', true)).toBe('The answer.')
  })

  it('ends a figures block whose closing tag never came at its first blank line, so the answer after it stays', () => {
    expect(both('<kpis>\n- A | 1\n- B | 2\n\nThe answer.\n\nMore.', false)).toBe('The answer.\n\nMore.')
    expect(both('<kpis>\n- A | 1\n```\n\nThe answer.', false)).toBe('```\n\nThe answer.')
    expect(both('```\n<kpis>\n- A | 1\n```\n\nThe answer.', false)).toBe('The answer.')
    expect(both('<kpis>\n- A | 1\n\nThe answer.\n\n<suggestions>\n- Next?\n</suggestions>', true)).toBe('The answer.')
    // Cut off inside it: all of it goes, a figure half written included.
    expect(both('Let me check.\n\n<kpis>\n- Defect pieces | 39\n- Reject rate | 1.2', true)).toBe('Let me check.')
  })

  it('runs a questions block left open to the end of the answer, from the text the answer ends with only', () => {
    expect(both('The answer.\n\n<suggestions>\n- Which machines', true)).toBe('The answer.')
    expect(both('The answer.\n\n<suggestions>\n- Which machines', false)).toBe('The answer.\n\n<suggestions>\n- Which machines')
  })

  it('holds back a tag still being written at the very end of the answer, and only there', () => {
    expect(both('<kp', true)).toBe('')
    expect(both('The answer <kp', true)).toBe('The answer')
    expect(both('The answer <kp', false)).toBe('The answer <kp')
    // On screen, a lone "<" waits for the next piece too.
    expect(both('The answer <', true)).toBe('The answer')
    expect(both('a < b', true)).toBe('a < b')
    expect(both('A <kbd>key</kbd> <span', true)).toBe('A <kbd>key</kbd> <span')
  })

  it('leaves a tag the answer only names in its text, and takes a block written after it', () => {
    // Named in a sentence, in code or not, a tag opens no block: the sentence and the lines after it stay.
    for (const named of [
      'The answer uses `<kpis>` tags.\nSecond line\n\nMore',
      'Use <kpis> to open an answer.\nNext line.\n\nMore',
      'Use <KPIS lang="en"> to open an answer.\n\nMore',
      'The <kpisx>\nthing.',
      '<kpis> opens the figures.\nSecond line',
      'The `<suggestions>` block holds follow-ups.\nMore text',
    ]) {
      expect(both(named, true), named).toBe(named)
      expect(both(named, false), named).toBe(named)
    }
    // A whole block written after the tag was named begins at its own opening tag.
    const after = 'The `<kpis>` block holds the figures.\n\n<kpis>\n- A | 1\n</kpis>\n\nThe answer.'
    expect(both(after, true)).toBe('The `<kpis>` block holds the figures.\n\n\n\nThe answer.')
    expect(both('The `<suggestions>` block.\n\n<suggestions>\n- Next?\n</suggestions>', true)).toBe('The `<suggestions>` block.')
    // An unclosed block on a line of its own after a named tag still ends at its blank line.
    expect(both('Named `<kpis>` here.\n\n  <kpis>  \n- A | 1\n\nThe answer.', false)).toBe('Named `<kpis>` here.\n\n  \n\nThe answer.')
    // A tag still being written on the last line, attributes and all, is held back.
    expect(both('The answer.\n\n<suggestions class="x', true)).toBe('The answer.')
  })

  it('gives back text it leaves alone as the same string', () => {
    const spaced = 'Weld porosity leads.  '
    expect(both(spaced, true)).toBe(spaced)
  })

  it('reads the bodies of whole blocks only, the last over several texts', () => {
    expect(blockBodies('<kpis>\n- A | 1\n</kpis> <kpis>B</kpis> <kpis>open', KPIS_BLOCK)).toEqual(['\n- A | 1\n', 'B'])
    expect(lastBlockBody(['<kpis>1</kpis>', 'none', '<KPIS a="b">2</kpis >'], KPIS_BLOCK)).toBe('2')
    expect(lastBlockBody(['none'], KPIS_BLOCK)).toBeNull()
  })

  it('cuts text by characters, never a letter in half', () => {
    expect(cutChars('abcdef', 4, true)).toBe('abc…')
    expect(cutChars('abcdef', 4, false)).toBe('abcd')
    expect(cutChars('abc', 4, true)).toBe('abc')
    expect(Array.from(cutChars('😀'.repeat(5), 3, false))).toHaveLength(3)
  })
})
