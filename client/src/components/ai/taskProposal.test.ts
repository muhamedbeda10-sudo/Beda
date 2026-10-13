import { describe, expect, it } from 'vitest'
import type { AiMessagesResponse, AiTaskPart } from '@qc/shared/ai'
import { ApiError } from '@/lib/api'
import { applyEvent, endTurn, parseStreamEvent, startTurn, type LiveTurn } from './liveTurn'
import { answerBlocks } from './answerLayout'
import { TASK_CARD_STATE_LABEL, hasOpenTaskCard, recipientsText, replaceTaskPart, sentToast, taskCardsWait, taskPartOf } from './taskProposal'

const card = (over: Partial<AiTaskPart> = {}): AiTaskPart => ({
  type: 'task',
  proposalId: 't1',
  ok: true,
  state: 'proposed',
  draft: {
    title: 'Recheck the coil stock in bay 3',
    description: 'Count the coils.',
    priority: 'high',
    dueAt: '2026-10-14T07:00:00.000Z',
    assignees: [
      { id: 'u1', name: 'Cyril Second' },
      { id: 'u2', name: 'Sara Ali' },
    ],
  },
  ...over,
})

const cached = (...parts: AiTaskPart[]): AiMessagesResponse => ({
  conversation: { id: 'c1', title: 'Tasks', createdAt: '2026-10-13T08:00:00Z', lastMessageAt: '2026-10-13T08:00:00Z' },
  messages: [
    { id: 'q1', role: 'user', parts: [{ type: 'text', text: 'Send Cyril a task' }], createdAt: '2026-10-13T08:00:00Z' },
    { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Here is the card.' }, ...parts], createdAt: '2026-10-13T08:00:05Z' },
  ],
})

describe('a task card in words', () => {
  it('says how it stands and whom it goes to', () => {
    expect(TASK_CARD_STATE_LABEL).toEqual({ proposed: 'Not sent yet', sent: 'Sent', discarded: 'Discarded', superseded: 'Replaced' })
    expect(recipientsText([])).toBe('no one')
    expect(recipientsText(['Cyril Second'])).toBe('Cyril Second')
    expect(recipientsText(['Cyril Second', 'Sara Ali'])).toBe('Cyril Second and Sara Ali')
    expect(recipientsText(['Cyril Second', 'Sara Ali', 'Omar', 'Mona'])).toBe('Cyril Second and 3 others')
    expect(sentToast(card({ state: 'sent', taskId: 'x', taskNumber: 12 }))).toBe('T-12 sent to Cyril Second and Sara Ali.')
  })
})

describe('the card in the cached conversation', () => {
  it('puts the card as it stands now in every answer that holds it, and leaves the rest as it was', () => {
    const old = cached(card(), card({ proposalId: 't2' }))
    const sent = card({ state: 'sent', taskId: 'task1', taskNumber: 7 })
    const next = replaceTaskPart(old, sent)!
    expect(next.messages[1].parts).toEqual([{ type: 'text', text: 'Here is the card.' }, sent, card({ proposalId: 't2' })])
    expect(next.messages[0]).toBe(old.messages[0])
    expect(replaceTaskPart(old, card({ proposalId: 'other' }))).toBe(old)
    expect(replaceTaskPart(undefined, sent)).toBeUndefined()
  })

  it('knows when another card still waits, and so may have been replaced', () => {
    expect(hasOpenTaskCard(cached(card()), 't1')).toBe(false)
    expect(hasOpenTaskCard(cached(card(), card({ proposalId: 't2' })), 't2')).toBe(true)
    expect(hasOpenTaskCard(cached(card({ state: 'sent', taskId: 'x', taskNumber: 1 })), 't2')).toBe(false)
    expect(hasOpenTaskCard(cached(card({ ok: false, draft: undefined, error: 'title' })), 't2')).toBe(false)
    expect(hasOpenTaskCard(undefined, 't1')).toBe(false)
  })

  it('makes the saved cards wait while the answer being written there drafts one', () => {
    const asking: LiveTurn = { ...startTurn('k1', 'c1', 'Change it', '2026-10-13T08:01:00Z'), phase: 'streaming' }
    expect(taskCardsWait(asking, 'c1')).toBe(false)
    const drafting = applyEvent(asking, { type: 'task', part: card({ proposalId: 't3' }) })
    expect(taskCardsWait(drafting, 'c1')).toBe(true)
    expect(taskCardsWait(drafting, 'c2')).toBe(false)
    expect(taskCardsWait(drafting, null)).toBe(false)
    // A refused draft replaces nothing; an answer that has ended holds nothing back.
    expect(taskCardsWait(applyEvent(asking, { type: 'task', part: card({ proposalId: 't4', ok: false, draft: undefined }) }), 'c1')).toBe(false)
    expect(taskCardsWait(endTurn(drafting, 'stopped'), 'c1')).toBe(false)
  })

  it('reads the card a refusal sends along', () => {
    const sent = card({ state: 'sent', taskId: 'x', taskNumber: 4 })
    expect(taskPartOf(new ApiError(409, 'conflict', 'This task was sent already.', { part: sent }), 't1')).toEqual(sent)
    expect(taskPartOf(new ApiError(409, 'conflict', 'This task was sent already.', { part: sent }), 't2')).toBeNull()
    expect(taskPartOf(new ApiError(409, 'conflict', 'Conflict.'), 't1')).toBeNull()
    expect(taskPartOf(new Error('boom'), 't1')).toBeNull()
  })
})

describe('a task card in the answer being written', () => {
  it('comes where it came, the same card again in its place, and reads among the text once settled', () => {
    const turn = applyEvent({ ...startTurn('k1', 'c1', 'Send it', '2026-10-13T08:01:00Z'), phase: 'streaming' }, { type: 'task', part: card({ ok: false, draft: undefined, error: 'title: say what is to be done.' }) })
    const fixed = applyEvent(turn, { type: 'task', part: card() })
    expect(fixed.parts).toEqual([card()])
    const more = applyEvent(applyEvent(fixed, { type: 'text', delta: 'The card is ready.' }), { type: 'task', part: card({ proposalId: 't2' }) })
    expect(more.parts.map((p) => p.type)).toEqual(['task', 'text', 'task'])
    expect(parseStreamEvent('task', JSON.stringify({ type: 'task', part: card() }))).toEqual({ type: 'task', part: card() })
    expect(parseStreamEvent('notice', JSON.stringify({ type: 'task', part: card() }))).toBeNull()
    const blocks = answerBlocks(more.parts, { settled: true, kpis: false, charted: new Set() })
    expect(blocks.map((b) => b.key)).toEqual(['task:t1', 'text:0', 'task:t2'])
  })
})
