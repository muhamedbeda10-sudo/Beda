import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import type { AiMessagesResponse } from '@qc/shared/ai'
import type { AiSavedTablePart } from '@qc/shared/savedTables'
import { settleSavedTableCards } from '@/services/savedTables'
import { AiSavedTableCard, savedTableCardLine, savedTableCardSince } from './AiSavedTableCard'

const text = (part: AiSavedTablePart) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <AiSavedTableCard part={part} />
    </MemoryRouter>,
  )
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const card: AiSavedTablePart = {
  type: 'saved-table',
  changeId: 'c1',
  tableId: 't1',
  name: 'routing_steps',
  title: 'Routing by item family',
  action: 'create',
  source: 'query',
  refresh: 'daily',
  rowCount: 1250,
  columns: ['family', 'step_no', 'work_center', 'orders', 'share_pct', 'first_seen', 'last_seen', 'median_hours', 'p90_hours', 'samples'],
  state: 'current',
}

describe('the saved-table card', () => {
  it('says what was saved, what it is read as, its rows, how it is kept and its columns', () => {
    const t = text(card)
    expect(t).toContain('Saved table')
    expect(t).toContain('Routing by item family')
    expect(t).toContain('ai_saved.routing_steps')
    expect(t).toContain('1,250 rows · Every night')
    expect(t).toContain('family step_no work_center')
    expect(t).toContain('+2 more')
    expect(t).toContain('Open saved tables')
    expect(renderToStaticMarkup(<MemoryRouter><AiSavedTableCard part={card} /></MemoryRouter>)).toContain('href="/saved-tables"')
  })

  it('says when the table was replaced or removed since, and what a removal card is', () => {
    expect(savedTableCardSince(card)).toBeNull()
    expect(savedTableCardSince({ ...card, state: 'changed' })).toBe('Replaced since')
    expect(savedTableCardSince({ ...card, state: 'removed' })).toBe('Removed since')
    expect(savedTableCardSince({ action: 'remove', state: 'removed' })).toBeNull()
    expect(text({ ...card, state: 'removed' })).toContain('Removed since')
    const removal = text({ ...card, action: 'remove', state: 'removed' })
    expect(removal).toContain('Saved table removed')
    expect(removal).not.toContain('rows')
  })

  it('says rows written out as such, and one row in the singular', () => {
    expect(savedTableCardLine({ rowCount: 1, source: 'rows', refresh: 'never' })).toBe('1 row · Written out')
    expect(savedTableCardLine({ rowCount: 3, source: 'query', refresh: 'never' })).toBe('3 rows · Kept as computed')
    expect(savedTableCardLine({ rowCount: null, source: 'query', refresh: 'hourly' })).toBe('Every hour')
  })

  it('is marked removed in every cached conversation once the table is removed', () => {
    const old: AiMessagesResponse = {
      conversation: { id: 'c', title: 't', createdAt: '2026-10-13T10:00:00Z', lastMessageAt: '2026-10-13T10:00:00Z' },
      messages: [
        { id: 'a', role: 'assistant', parts: [{ type: 'text', text: 'Saved.' }, card], createdAt: '2026-10-13T10:00:00Z' },
        { id: 'b', role: 'assistant', parts: [{ type: 'text', text: 'Nothing here.' }], createdAt: '2026-10-13T10:01:00Z' },
      ],
    }
    const settled = settleSavedTableCards(old, 't1')!
    expect(settled.messages[0].parts[1]).toMatchObject({ state: 'removed' })
    expect(settled.messages[1]).toBe(old.messages[1])
    expect(settleSavedTableCards(settled, 't1')).toBe(settled)
    expect(settleSavedTableCards(old, 'other')).toBe(old)
  })
})
