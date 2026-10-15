import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AiReportPart } from '@qc/shared/ai'
import { answerBlocks } from './answerLayout'
import { applyEvent, startTurn } from './liveTurn'
import { AiReportCard, reportCardLine, reportCardSince } from './AiReportCard'

const text = (part: AiReportPart, onOpen?: (id: string) => void) =>
  renderToStaticMarkup(<AiReportCard part={part} onOpen={onOpen} />)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const card: AiReportPart = {
  type: 'report',
  changeId: 'c1',
  reportId: 'r1',
  action: 'create',
  title: 'Order tracking',
  description: 'Each order, its phases and machines.',
  shared: true,
  inputs: ['Orders'],
  sectionCount: 7,
  state: 'current',
}

describe('the card of a report the assistant built', () => {
  it('says what it is, what it asks for, and opens it', () => {
    expect(text(card, () => {})).toBe('Report built Shared Order tracking Each order, its phases and machines. Asks for Orders · 7 sections Open report')
    expect(reportCardLine({ inputs: [], sectionCount: 1 })).toBe('1 section')
  })

  it('says when it was changed or deleted since, and a deleted one does not open', () => {
    expect(reportCardSince({ state: 'changed' })).toBe('Changed since')
    expect(text({ ...card, state: 'removed', action: 'update', shared: false }, () => {})).toBe('Report changed Deleted since Order tracking Each order, its phases and machines. Asks for Orders · 7 sections')
  })

  it('takes its place among the text, live, once however often it is sent', () => {
    let t = startTurn('k', 'c1', 'q', '2026-10-15T10:00:00Z')
    t = applyEvent(t, { type: 'text', delta: 'Built it.' })
    t = applyEvent(t, { type: 'report', part: card })
    t = applyEvent(t, { type: 'report', part: { ...card, title: 'Order tracking 2' } })
    const blocks = answerBlocks(t.parts, { settled: true, kpis: false, charted: new Set() })
    expect(blocks.map((b) => b.kind)).toEqual(['text', 'report'])
    expect(blocks[1]).toMatchObject({ key: 'report:c1', part: { title: 'Order tracking 2' } })
  })
})
