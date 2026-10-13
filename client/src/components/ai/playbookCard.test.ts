import { describe, expect, it } from 'vitest'
import type { AiMessagesResponse } from '@qc/shared/ai'
import type { AiPlaybookPart } from '@qc/shared/playbook'
import { applyEvent, parseStreamEvent, startTurn } from './liveTurn'
import { answerBlocks } from './answerLayout'
import { playbookCardState, playbookCardTitle, settlePlaybookCards } from './playbookCard'

const card = (over: Partial<AiPlaybookPart> = {}): AiPlaybookPart => ({
  type: 'playbook',
  changeId: 'c1',
  entryId: 'e1',
  action: 'add',
  scope: 'personal',
  kind: 'instruction',
  text: 'Always give rates as %.',
  basis: '',
  state: 'current',
  ...over,
})

const cached = (...parts: AiPlaybookPart[]): AiMessagesResponse => ({
  conversation: { id: 'conv', title: 'Playbook', createdAt: '2026-10-13T08:00:00Z', lastMessageAt: '2026-10-13T08:00:00Z' },
  messages: [
    { id: 'q1', role: 'user', parts: [{ type: 'text', text: 'Remember this' }], createdAt: '2026-10-13T08:00:00Z' },
    { id: 'a1', role: 'assistant', parts: [...parts, { type: 'text', text: 'Saved.' }], createdAt: '2026-10-13T08:00:05Z' },
  ],
})

describe('a playbook card in words', () => {
  it('says what was saved, changed or removed, and how its entry stands now', () => {
    expect(playbookCardTitle(card())).toBe('Instruction saved to the playbook')
    expect(playbookCardTitle(card({ scope: 'shared' }))).toBe('Instruction for everyone saved to the playbook')
    expect(playbookCardTitle(card({ kind: 'conclusion', action: 'change' }))).toBe('Conclusion changed in the playbook')
    expect(playbookCardTitle(card({ action: 'remove' }))).toBe('Instruction removed from the playbook')
    expect(playbookCardState(card())).toBeNull()
    expect(playbookCardState(card({ state: 'changed' }))).toBe('Changed since')
    expect(playbookCardState(card({ state: 'removed' }))).toBe('Removed since')
    expect(playbookCardState(card({ action: 'remove', state: 'removed' }))).toBeNull()
  })
})

describe('the cards of an entry once it changes elsewhere', () => {
  it('marks every card of a removed entry, the others untouched, and leaves an untouched list as it was', () => {
    const old = cached(card(), card({ changeId: 'c2', action: 'change', state: 'current' }), card({ changeId: 'c3', entryId: 'e2' }))
    const next = settlePlaybookCards(old, 'e1', 'removed')!
    expect(next.messages[1].parts.slice(0, 3).map((p) => (p.type === 'playbook' ? p.state : null))).toEqual(['removed', 'removed', 'current'])
    expect(next.messages[0]).toBe(old.messages[0])
    expect(settlePlaybookCards(old, 'nope', 'removed')).toBe(old)
    expect(settlePlaybookCards(undefined, 'e1', 'removed')).toBeUndefined()
    // Changed on the page: the cards say it was changed since; a removed one stays removed.
    const removed = settlePlaybookCards(cached(card({ state: 'removed' })), 'e1', 'changed')
    expect(removed?.messages[1].parts[0]).toMatchObject({ state: 'removed' })
  })
})

describe('a playbook card in the answer being written', () => {
  it('comes where it came, the same card again in its place, and reads among the text', () => {
    const t0 = { ...startTurn('k', 'conv', 'Remember this', '2026-10-13T08:00:00Z'), phase: 'streaming' as const }
    const t1 = applyEvent(applyEvent(t0, { type: 'playbook', part: card() }), { type: 'text', delta: 'Saved.' })
    expect(applyEvent(t1, { type: 'playbook', part: card({ text: 'Again' }) }).parts.map((p) => p.type)).toEqual(['playbook', 'text'])
    expect(parseStreamEvent('playbook', JSON.stringify({ type: 'playbook', part: card() }))).toEqual({ type: 'playbook', part: card() })
    expect(answerBlocks(t1.parts, { settled: true, kpis: false, charted: new Set() }).map((b) => b.key)).toEqual(['playbook:c1', 'text:0'])
  })
})
