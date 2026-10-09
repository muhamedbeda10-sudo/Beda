import { describe, expect, it } from 'vitest'
import type { AiQueryPart } from '@qc/shared/ai'
import type { LivePart } from './liveTurn'
import { AI_MAX_KPIS, hideKpis, kpiCards, kpiTrendView, kpisOf, liveKpis, parseKpis } from './kpis'
import { liveDisplayParts } from './suggestions'

const BLOCK = '<kpis>\n- Defect pieces | 39\n- Reject rate | 1.29% | down-good\n- Holds open | 4 | up-bad\n</kpis>'
const ANSWER = 'In September, **39** defect pieces were found.'

describe('headline figures', () => {
  it('reads a block: label, value as written, and the trend when it is one of the five', () => {
    expect(parseKpis(`${BLOCK}\n\n${ANSWER}`)).toEqual([
      { label: 'Defect pieces', value: '39' },
      { label: 'Reject rate', value: '1.29%', trend: 'down-good' },
      { label: 'Holds open', value: '4', trend: 'up-bad' },
    ])
  })

  it('takes any list marker and any case of the tag and the trend, and Arabic as it is', () => {
    const text = '<KPIs>\n* القطع المعيبة | ٣٩ | Up Good\n• Rate | 2% | FLAT\n1. Holds | 4 | sideways\n2) Lines | 7\n</KPIS>'
    expect(parseKpis(text)).toEqual([
      { label: 'القطع المعيبة', value: '٣٩', trend: 'up-good' },
      { label: 'Rate', value: '2%', trend: 'flat' },
      { label: 'Holds', value: '4' },
      { label: 'Lines', value: '7' },
    ])
  })

  it('skips lines without a value or a marker, repeats of a label, and keeps at most six', () => {
    expect(kpisOf('- Only a label\n- | 5\nNo marker | 3\n- A | 1\n- A | 2')).toEqual([{ label: 'A', value: '1' }])
    const many = Array.from({ length: 9 }, (_, i) => `- K${i} | ${i}`).join('\n')
    expect(kpisOf(many)).toHaveLength(AI_MAX_KPIS)
  })

  it('cuts a label or a value too long, by characters', () => {
    const [k] = kpisOf(`- ${'ع'.repeat(100)} | ${'9'.repeat(60)}`)
    expect(Array.from(k.label)).toHaveLength(80)
    expect(k.value).toHaveLength(40)
  })

  it('reads the last whole block, and nothing from one not closed', () => {
    expect(parseKpis('<kpis>\n- A | 1\n</kpis> then <kpis>\n- B | 2\n</kpis>')).toEqual([{ label: 'B', value: '2' }])
    expect(parseKpis('<kpis>\n- A | 1\n')).toEqual([])
    expect(parseKpis(ANSWER)).toEqual([])
  })

  it('hides a whole block and the blank lines it leaves at the top', () => {
    expect(hideKpis(`${BLOCK}\n\n${ANSWER}`)).toBe(ANSWER)
    expect(hideKpis(`Checking.\n\n${BLOCK}`)).toBe('Checking.')
  })

  it('hides a block still being written, to the end, and the first characters of its tag', () => {
    expect(hideKpis('<kpis>\n- Defect pieces | 3')).toBe('')
    expect(hideKpis(`Checking.\n\n<kpis>\n- A | 1\n</kp`)).toBe('Checking.')
    for (const tail of ['<', '<k', '<kp', '<kpi', '<kpis', '<KP']) expect(hideKpis(`Checking.\n\n${tail}`)).toBe('Checking.')
  })

  it('leaves alone text that only looks like a tag, and returns unchanged text as the same string', () => {
    expect(hideKpis('Fewer than 5 < 6')).toBe('Fewer than 5 < 6')
    expect(hideKpis('A <kbd>key</kbd>')).toBe('A <kbd>key</kbd>')
    const spaced = 'Weld porosity leads.  '
    expect(hideKpis(spaced)).toBe(spaced)
  })

  it('never shows any of the tag at any moment of the stream', () => {
    const full = `${BLOCK}\n\n${ANSWER}`
    for (let i = 1; i <= full.length; i++) {
      const shown = hideKpis(full.slice(0, i))
      expect(shown.toLowerCase()).not.toContain('<k')
      expect(shown).not.toContain('|')
      expect(ANSWER.startsWith(shown.trimEnd())).toBe(true)
    }
  })

  it('draws a streamed answer without its figures’ block or its suggestions, and takes the figures once the block is whole', () => {
    const query: AiQueryPart = { type: 'query', queryId: 'q1', purpose: 'Defects', sql: 'SELECT 1', ok: true, columns: ['n'], rows: [[1]], rowCount: 1, truncated: false, ms: 3 }
    const intro: LivePart = { type: 'text', text: 'Looking.' }
    const writing: LivePart[] = [intro, query, { type: 'text', text: '<kpis>\n- Defect pieces | 39\n- Rej' }]
    expect(liveDisplayParts(writing)).toEqual([intro, query])
    expect(liveKpis(writing)).toEqual([])
    const closed: LivePart[] = [intro, query, { type: 'text', text: `${BLOCK}\n\n${ANSWER}\n\n<suggestions>\n- Next?\n</suggestions>` }]
    expect(liveDisplayParts(closed)).toEqual([intro, query, { type: 'text', text: ANSWER }])
    expect(liveKpis(closed).map((k) => k.label)).toEqual(['Defect pieces', 'Reject rate', 'Holds open'])
  })

  it('checks the saved figures again: blanks, unknown trends and more than six go', () => {
    const saved = [
      { label: ' Pieces ', value: ' 39 ', trend: 'up-good' as const },
      { label: '', value: '1' },
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
