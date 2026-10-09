import { describe, expect, it } from 'vitest'
import type { AiQueryPart } from '@qc/shared/ai'
import type { LivePart } from './liveTurn'
import { AI_MAX_SUGGESTIONS, hideSuggestions, liveDisplayParts, suggestionChips } from './suggestions'

const ANSWER = 'Weld porosity leads with **30** pieces.'
const BLOCK = '<suggestions>\n- Which machines had it most?\n- كم قطعة الشهر اللي فات؟\n</suggestions>'

describe('follow-up questions while the answer is written', () => {
  it('hides a whole block, and the blank lines before it', () => {
    expect(hideSuggestions(`${ANSWER}\n\n${BLOCK}`)).toBe(ANSWER)
    expect(hideSuggestions(`${ANSWER}\n\n${BLOCK}\n`)).toBe(ANSWER)
  })

  it('hides a block still being written, to the end', () => {
    expect(hideSuggestions(`${ANSWER}\n\n<suggestions>\n- Which machines`)).toBe(ANSWER)
    expect(hideSuggestions(`${ANSWER}\n\n<suggestions`)).toBe(ANSWER)
    expect(hideSuggestions(`${ANSWER}\n\n<suggestions>\n- a\n</sugg`)).toBe(ANSWER)
  })

  it('holds back the first characters of the tag at the very end', () => {
    for (const tail of ['<', '<s', '<su', '<sugg', '<suggestion', '<SUGG']) expect(hideSuggestions(`${ANSWER}\n\n${tail}`)).toBe(ANSWER)
  })

  it('leaves text alone that only looks like the start of a tag', () => {
    expect(hideSuggestions('Fewer than 5 < 6')).toBe('Fewer than 5 < 6')
    expect(hideSuggestions('Use <b>bold</b>')).toBe('Use <b>bold</b>')
    expect(hideSuggestions('A <span')).toBe('A <span')
    expect(hideSuggestions(ANSWER)).toBe(ANSWER)
    // Unchanged text comes back as the same string, trailing space and all.
    const spaced = 'Weld porosity leads.  '
    expect(hideSuggestions(spaced)).toBe(spaced)
  })

  it('reads the tag in any case', () => {
    expect(hideSuggestions(`${ANSWER}\n<Suggestions>\n- a\n</SUGGESTIONS>`)).toBe(ANSWER)
  })

  it('never shows any of the tag at any moment of the stream', () => {
    const full = `${ANSWER}\n\n${BLOCK}`
    for (let i = 1; i <= full.length; i++) {
      const shown = hideSuggestions(full.slice(0, i))
      expect(shown.toLowerCase()).not.toContain('<s')
      // What is shown only ever grows into the answer's own text.
      expect(ANSWER.startsWith(shown.trimEnd())).toBe(true)
    }
  })

  it('draws the parts without the block, dropping a text it empties and keeping queries as they are', () => {
    const query: AiQueryPart = { type: 'query', queryId: 'q1', purpose: 'Defects', sql: 'SELECT 1', ok: true, columns: ['n'], rows: [[1]], rowCount: 1, truncated: false, ms: 3 }
    const intro: LivePart = { type: 'text', text: 'Looking.' }
    const parts: LivePart[] = [intro, query, { type: 'text', text: `\n\n${BLOCK.slice(0, 20)}` }]
    const shown = liveDisplayParts(parts)
    expect(shown).toEqual([intro, query])
    expect(shown[0]).toBe(intro)
    expect(shown[1]).toBe(query)
    expect(liveDisplayParts([query, { type: 'text', text: `${ANSWER}\n\n<sugg` }])).toEqual([query, { type: 'text', text: ANSWER }])
  })

  it('offers at most three questions, trimmed, without blanks or repeats', () => {
    expect(suggestionChips(undefined)).toEqual([])
    expect(suggestionChips([' a ', '', 'a', 'b', 'c', 'd'])).toEqual(['a', 'b', 'c'])
    expect(suggestionChips(['x', 'y', 'z', 'w'])).toHaveLength(AI_MAX_SUGGESTIONS)
  })
})
