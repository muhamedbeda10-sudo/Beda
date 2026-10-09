import { describe, expect, it } from 'vitest'
import type { AiQueryPart } from '@qc/shared/ai'
import type { LivePart } from './liveTurn'
import { AI_MAX_KPIS, kpiCards, kpiTrendView, kpisOf, liveKpis, parseKpis } from './kpis'
import { liveDisplayParts } from './suggestions'

const BLOCK = '<kpis>\n- Defect pieces | 39\n- Reject rate | 1.29% | down-good\n- Holds open | 4 | up-bad\n</kpis>'
const ANSWER = 'In September, **39** defect pieces were found.'
const query: AiQueryPart = { type: 'query', queryId: 'q1', purpose: 'Defects', sql: 'SELECT 1', ok: true, columns: ['n'], rows: [[1]], rowCount: 1, truncated: false, ms: 3 }

describe('headline figures, read as the server reads them', () => {
  it('reads a block: label, value as written, and the trend when it is one of the five', () => {
    expect(parseKpis([`${BLOCK}\n\n${ANSWER}`])).toEqual([
      { label: 'Defect pieces', value: '39' },
      { label: 'Reject rate', value: '1.29%', trend: 'down-good' },
      { label: 'Holds open', value: '4', trend: 'up-bad' },
    ])
    expect(parseKpis(['No block at all.'])).toEqual([])
    expect(parseKpis(['<kpis>\n\n</kpis>'])).toEqual([])
  })

  it('checks every line: at most six, one per label, a figure never cut, a trend only when it is one of the five', () => {
    // The very lines the server's own test reads, with the very figures it keeps.
    const lines = [
      '- **Samples** | `1,204`',
      '* عدد العيوب | ٣٩ | Up good',
      '1. Reject rate | 1.29% | down_bad',
      '2) Holds | 4 | sideways',
      'Without a marker | 7 | flat',
      '- Samples | 9',
      `- ${'L'.repeat(70)} | 1`,
      `- Too long a figure | ${'9'.repeat(33)}`,
      '- No figure |',
      '- Only words, no pipe',
      '- A | B | C | D',
      '|---|---|',
      '- Sixth | 6',
      '- Seventh | 7',
    ]
    const kpis = parseKpis([`<kpis>\n${lines.join('\n')}\n</kpis>`])
    expect(kpis).toEqual([
      { label: 'Samples', value: '1,204' },
      { label: 'عدد العيوب', value: '٣٩', trend: 'up-good' },
      { label: 'Reject rate', value: '1.29%', trend: 'down-bad' },
      { label: 'Holds', value: '4' },
      { label: 'Without a marker', value: '7', trend: 'flat' },
      { label: `${'L'.repeat(59)}…`, value: '1' },
    ])
    expect(kpis).toHaveLength(AI_MAX_KPIS)
  })

  it('keeps "1.5 mm" a label, folds white space, and takes a dash in a trend', () => {
    expect(kpisOf('1.5 mm   gap | 12\n- Rate | 2% | Up – bad')).toEqual([
      { label: '1.5 mm gap', value: '12' },
      { label: 'Rate', value: '2%', trend: 'up-bad' },
    ])
    // A figure cut by characters, never a letter in half.
    const [k] = kpisOf(`- ${'ع'.repeat(100)} | ${'٩'.repeat(32)}`)
    expect(Array.from(k.label)).toHaveLength(60)
    expect(k.label.endsWith('…')).toBe(true)
    expect(Array.from(k.value)).toHaveLength(32)
  })

  it('takes the last whole block of the answer’s texts, and none that never closed', () => {
    expect(parseKpis(['<kpis>\n- First | 1\n</kpis>', 'Then.', '<KPIS class="x">\n- Second | 2\n</kpis >'])).toEqual([{ label: 'Second', value: '2' }])
    expect(parseKpis(['<kpis>\n- Cut | 1\n- Off | 2'])).toEqual([])
    // A last block with no figure in it is the last block: the earlier one is not read instead.
    expect(parseKpis(['<kpis>\n- First | 1\n</kpis>', '<kpis>\nnothing\n</kpis>'])).toEqual([])
  })
})

describe('headline figures while the answer is written', () => {
  it('never shows any of the block at any moment of the stream, and the answer after it as it comes', () => {
    const full = `${BLOCK}\n\n${ANSWER}`
    for (let i = 1; i <= full.length; i++) {
      const shown = liveDisplayParts([query, { type: 'text', text: full.slice(0, i) }])
      const text = shown.length > 1 && shown[1].type === 'text' ? shown[1].text : ''
      expect(text.toLowerCase()).not.toContain('<k')
      expect(text).not.toContain('|')
      expect(ANSWER.startsWith(text.trimEnd())).toBe(true)
    }
  })

  it('draws the cards as soon as the block is whole, and none before', () => {
    const intro: LivePart = { type: 'text', text: 'Looking.' }
    const writing: LivePart[] = [intro, query, { type: 'text', text: '<kpis>\n- Defect pieces | 39\n- Rej' }]
    expect(liveDisplayParts(writing)).toEqual([intro, query])
    expect(liveKpis(writing)).toEqual([])
    const closed: LivePart[] = [intro, query, { type: 'text', text: `${BLOCK}\n\n${ANSWER}\n\n<suggestions>\n- Next?\n</suggestions>` }]
    expect(liveDisplayParts(closed)).toEqual([intro, query, { type: 'text', text: ANSWER }])
    expect(liveKpis(closed).map((k) => k.label)).toEqual(['Defect pieces', 'Reject rate', 'Holds open'])
  })

  it('shows the answer after a block whose closing tag never came, from its first blank line, as the saved answer will', () => {
    const open: LivePart[] = [query, { type: 'text', text: '<kpis>\n- A | 1\n- B | 2\n\nThe answer.' }]
    expect(liveDisplayParts(open)).toEqual([query, { type: 'text', text: 'The answer.' }])
    expect(liveKpis(open)).toEqual([])
  })
})

describe('headline figures as saved', () => {
  it('checks the saved figures again: blanks, repeats, unknown trends and more than six go', () => {
    const saved = [
      { label: ' Pieces ', value: ' 39 ', trend: 'up-good' as const },
      { label: '', value: '1' },
      { label: 'Pieces', value: '40' },
      { label: 'Odd', value: '2', trend: 'sideways' as never },
      ...Array.from({ length: 8 }, (_, i) => ({ label: `K${i}`, value: String(i) })),
    ]
    const cards = kpiCards(saved)
    expect(cards[0]).toEqual({ label: 'Pieces', value: '39', trend: 'up-good' })
    expect(cards[1]).toEqual({ label: 'Odd', value: '2' })
    expect(cards).toHaveLength(AI_MAX_KPIS)
    expect(kpiCards(undefined)).toEqual([])
  })

  it('draws a trend as its arrow and whether it is good news', () => {
    expect(kpiTrendView('down-good')).toMatchObject({ direction: 'down', tone: 'good' })
    expect(kpiTrendView('up-bad')).toMatchObject({ direction: 'up', tone: 'bad' })
    expect(kpiTrendView('up-good')).toMatchObject({ direction: 'up', tone: 'good' })
    expect(kpiTrendView('down-bad')).toMatchObject({ direction: 'down', tone: 'bad' })
    expect(kpiTrendView('flat')).toMatchObject({ direction: 'flat', tone: 'neutral' })
    expect(kpiTrendView(undefined)).toBeNull()
  })
})
