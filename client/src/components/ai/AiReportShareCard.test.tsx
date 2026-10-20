import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AiMessage, AiReportSharePart } from '@qc/shared/ai'
import { answerBlocks } from './answerLayout'
import { applyEvent, parseStreamEvent, startTurn } from './liveTurn'
import { AiReportShareCard, shareCardLines } from './AiReportShareCard'

const text = (part: AiReportSharePart, onOpen?: (id: string) => void) =>
  renderToStaticMarkup(<AiReportShareCard part={part} onOpen={onOpen} />)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const card: AiReportSharePart = {
  type: 'report-share',
  cardId: 'c1',
  reportId: 'r1',
  title: 'Weekly scrap',
  added: ['Ahmed Ali', 'Every supervisor'],
  removed: [],
  sharedWith: ['Every supervisor', 'Ahmed Ali'],
  state: 'current',
}

describe('the card of a report the assistant shared', () => {
  it('says whom it added and whom the report is shared with, and opens its Share panel', () => {
    expect(text(card, () => {})).toBe('Report sharing Weekly scrap Added: Ahmed Ali, Every supervisor Shared with: Every supervisor, Ahmed Ali Open sharing')
  })

  it('says whom it removed, and that it is shared with nobody', () => {
    expect(shareCardLines({ added: [], removed: ['Ahmed Ali'], sharedWith: [] })).toEqual([
      { label: 'Removed', text: 'Ahmed Ali' },
      { label: 'Shared with', text: 'Nobody' },
    ])
    // A list asked for: whom it is shared with, alone.
    expect(shareCardLines({ added: [], removed: [], sharedWith: ['Every viewer'] })).toEqual([{ label: 'Shared with', text: 'Every viewer' }])
  })

  it('says when the report was deleted since, and opens nothing', () => {
    expect(text({ ...card, state: 'removed' }, () => {})).toBe('Report sharing Deleted since Weekly scrap Added: Ahmed Ali, Every supervisor Shared with: Every supervisor, Ahmed Ali')
  })

  it('takes its place among the text, live and as the conversation is read again, once however often it is sent', () => {
    expect(parseStreamEvent('report-share', JSON.stringify({ type: 'report-share', part: card }))).toEqual({ type: 'report-share', part: card })
    let t = startTurn('k', 'c1', 'q', '2026-10-20T10:00:00Z')
    t = applyEvent(t, { type: 'text', delta: 'Shared it.' })
    t = applyEvent(t, { type: 'report-share', part: card })
    t = applyEvent(t, { type: 'report-share', part: { ...card, sharedWith: ['Every supervisor'] } })
    const blocks = answerBlocks(t.parts, { settled: true, kpis: false, charted: new Set() })
    expect(blocks.map((b) => b.kind)).toEqual(['text', 'report-share'])
    expect(blocks[1]).toMatchObject({ key: 'report-share:c1', part: { sharedWith: ['Every supervisor'] } })
    // A stored answer (history) holds the same part.
    const stored: AiMessage = { id: 'm', role: 'assistant', parts: [{ type: 'text', text: 'Shared it.' }, card], createdAt: '2026-10-20T10:00:00Z' }
    expect(answerBlocks(stored.parts, { settled: true, kpis: false, charted: new Set() }).map((b) => b.kind)).toEqual(['text', 'report-share'])
  })
})
