import { describe, expect, it } from 'vitest'
import type { AiQueryPart } from '@qc/shared/ai'
import type { LivePart } from './liveTurn'
import { AI_MAX_SUGGESTIONS, AI_STARTER_QUESTIONS, hideSuggestions, liveDisplayParts, spentFocus, suggestionChips, takesCaret, withPicked, type ComposerFocus } from './suggestions'

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

describe('the question box taking the caret', () => {
  it('takes it on a keyboard always, on a touch screen only for a follow-up question tapped', () => {
    expect(takesCaret({ key: 1, always: false }, false)).toBe(true)
    expect(takesCaret({ key: 1, always: false }, true)).toBe(false)
    expect(takesCaret({ key: 1, always: true }, true)).toBe(true)
  })

  it("raises a phone's keyboard once for a follow-up question, not each time the box comes back", () => {
    // A chip tapped: the box takes the caret, the keyboard too, and the request is spent.
    const tapped: ComposerFocus = { key: 4, always: true }
    expect(takesCaret(tapped, true)).toBe(true)
    const kept = spentFocus(tapped)
    expect(kept).toEqual({ key: 4, always: false })
    // History, then a conversation picked: the box is mounted again with the panel's last request — the keyboard stays down.
    expect(takesCaret(kept, true)).toBe(false)
    // Nothing to spend: the same request, so the panel does not draw again.
    expect(spentFocus(kept)).toBe(kept)
  })
})

describe('the first questions offered', () => {
  // Words for data only some people are given: inspections, orders and PDI, coils and master data, the audit log and accounts.
  // (A machine's production line is the machine register's own.)
  const DOMAIN_WORDS =
    /defect|hold|session|inspect|sample|measure|dimension|production(?! line)|order|pdi|coil|supplier|material|grade|consumable|instruction|audit|account|user|role|عيب|عيوب|هولد|جلس|فحص|عينة|عينات|قياس|إنتاج|انتاج|طلب|أوردر|لفائف|لفة|كويل|مورد|خام|سجل|حساب|مستخدم/i

  it('asks nothing that needs data a person may not have been given', () => {
    for (const q of AI_STARTER_QUESTIONS) expect(q).not.toMatch(DOMAIN_WORDS)
  })

  it('asks about the assistant itself or the machine register, which everyone given it can read', () => {
    for (const q of AI_STARTER_QUESTIONS) expect(q).toMatch(/ask you|machine|أسألك|ماكين/i)
  })

  it('offers English and Arabic alike', () => {
    expect(AI_STARTER_QUESTIONS.some((q) => /[\u0600-\u06FF]/.test(q))).toBe(true)
    expect(AI_STARTER_QUESTIONS.some((q) => /^[\x20-\x7E]+$/.test(q))).toBe(true)
  })
})

describe('a card picked into the question box', () => {
  const q = 'Draw me a chart. Ask me what it should show.'
  it('fills an empty box with its question', () => {
    expect(withPicked('', q)).toBe(q)
    expect(withPicked('  \n ', q)).toBe(q)
  })
  it('keeps what was typed, the question on a line of its own after it', () => {
    expect(withPicked('Rejects on line 3 ', q)).toBe(`Rejects on line 3\n\n${q}`)
  })
  it('does not put the same question in twice', () => {
    const once = withPicked('Rejects on line 3', q)
    expect(withPicked(once, q)).toBe(once)
  })
})
