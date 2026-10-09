import { describe, expect, it } from 'vitest'
import type { AiConversation, AiMessage, AiQueryPart, AiStatusResponse } from '@qc/shared/ai'
import { answerText, applyEvent, endTurn, isInFlight, liveView, parseStreamEvent, startTurn, type LiveTurn } from './liveTurn'

const conversation: AiConversation = { id: 'c1', title: 'Top defects', createdAt: '2026-10-09T10:00:00Z', lastMessageAt: '2026-10-09T10:00:00Z' }
const status: AiStatusResponse = { available: true, model: 'claude-sonnet-5-5', spentUsd: 1, capUsd: 50, monthStart: '2026-10-01T00:00:00Z' }
const query: AiQueryPart = { type: 'query', queryId: 'q1', purpose: 'Defects', sql: 'SELECT 1', ok: true, columns: ['n'], rows: [[1]], rowCount: 1, truncated: false, ms: 12 }
const answer: AiMessage = { id: 'a1', role: 'assistant', parts: [query, { type: 'text', text: 'Weld porosity leads.' }], createdAt: '2026-10-09T10:00:05Z', costUsd: 0.012, stopReason: 'end_turn' }
const question: AiMessage = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Top defects?' }], createdAt: '2026-10-09T10:00:00Z' }

function run(events: Parameters<typeof applyEvent>[1][], from: LiveTurn = startTurn('k1', null, 'Top defects?', '2026-10-09T10:00:00Z')): LiveTurn {
  return events.reduce(applyEvent, from)
}

describe('the answer being written', () => {
  it('folds a whole stream: start, thinking, a query, text in pieces, done', () => {
    const t = run([
      { type: 'start', conversation, userMessageId: 'u1' },
      { type: 'progress', text: 'Looking at the defects view' },
      { type: 'query_start', queryId: 'q1', purpose: 'Defects', sql: 'SELECT 1' },
      { type: 'query_end', part: query },
      { type: 'text', delta: 'Weld ' },
      { type: 'text', delta: 'porosity leads.' },
    ])
    expect(t.conversationId).toBe('c1')
    expect(t.userMessageId).toBe('u1')
    expect(t.phase).toBe('streaming')
    expect(t.progress).toBeNull()
    expect(t.parts).toEqual([query, { type: 'text', text: 'Weld porosity leads.' }])
    const done = applyEvent(t, { type: 'done', message: answer, status })
    expect(done.phase).toBe('done')
    expect(done.message).toBe(answer)
    expect(isInFlight(done)).toBe(false)
    // Nothing moves once it has ended.
    expect(applyEvent(done, { type: 'text', delta: 'late' })).toBe(done)
  })

  it('shows progress until text or a query takes over', () => {
    const t = run([{ type: 'start', conversation, userMessageId: 'u1' }, { type: 'progress', text: 'Checking holds' }])
    expect(t.progress).toBe('Checking holds')
    expect(applyEvent(t, { type: 'text', delta: 'x' }).progress).toBeNull()
    expect(applyEvent(t, { type: 'query_start', queryId: 'q9', purpose: 'p', sql: 's' }).progress).toBeNull()
  })

  it('marks a query still running as interrupted when the answer ends', () => {
    const t = run([{ type: 'start', conversation, userMessageId: 'u1' }, { type: 'query_start', queryId: 'q2', purpose: 'p', sql: 's' }])
    expect(endTurn(t, 'stopped').parts).toEqual([{ type: 'pending-query', queryId: 'q2', purpose: 'p', sql: 's', state: 'interrupted' }])
    const failed = applyEvent(t, { type: 'error', code: 'internal', message: 'Claude is busy right now — try again in a minute.' })
    expect(failed.phase).toBe('error')
    expect(failed.error?.message).toMatch(/busy/)
    expect(failed.parts[0]).toMatchObject({ state: 'interrupted' })
  })

  it('records a refusal before the stream as an error, and a stop as stopped', () => {
    const t = startTurn('k2', 'c1', 'q', '2026-10-09T10:00:00Z')
    expect(endTurn(t, 'error', { code: 'ai_budget_reached', message: 'The monthly cap is reached.' })).toMatchObject({ phase: 'error', error: { code: 'ai_budget_reached' } })
    expect(endTurn(t, 'stopped')).toMatchObject({ phase: 'stopped', error: null })
  })

  it('reads only the events it knows, and only when the name matches the type', () => {
    expect(parseStreamEvent('text', '{"type":"text","delta":"a"}')).toEqual({ type: 'text', delta: 'a' })
    expect(parseStreamEvent('message', '{"type":"text","delta":"a"}')).toEqual({ type: 'text', delta: 'a' })
    expect(parseStreamEvent('done', '{"type":"text","delta":"a"}')).toBeNull()
    expect(parseStreamEvent('usage', '{"type":"usage"}')).toBeNull()
    expect(parseStreamEvent('text', 'not json')).toBeNull()
    expect(parseStreamEvent('text', 'null')).toBeNull()
  })

  it('hands over to the saved conversation without showing anything twice', () => {
    const sending = startTurn('k1', null, 'Top defects?', '2026-10-09T10:00:00Z')
    // A new chat: the question and the answer are drawn from the live turn.
    expect(liveView(sending, null, [])).toMatchObject({ question: true, answer: true })
    // Another conversation shows none of it.
    expect(liveView(sending, 'other', [])).toMatchObject({ question: false, answer: false })

    const streaming = applyEvent(sending, { type: 'start', conversation, userMessageId: 'u1' })
    // While it is written, a saved copy of the question (and of a half-saved answer) is cut away.
    const halfSaved = [question, { ...answer, stopReason: undefined }]
    expect(liveView(streaming, 'c1', halfSaved)).toEqual({ saved: [], question: true, answer: true })

    const done = applyEvent(streaming, { type: 'done', message: answer, status })
    expect(liveView(done, 'c1', [question, answer])).toEqual({ saved: [question, answer], question: false, answer: false })
    // Done, but the saved list has not caught up: the turn still draws itself.
    expect(liveView(done, 'c1', [])).toMatchObject({ question: true, answer: true })

    // Stopped, and the server saved the question but no answer: the stop notice stays.
    const stopped = endTurn(streaming, 'stopped')
    expect(liveView(stopped, 'c1', [question])).toEqual({ saved: [question], question: false, answer: true })
  })

  it('copies the text of an answer as markdown, without its queries', () => {
    expect(answerText([query, { type: 'text', text: ' First. ' }, { type: 'text', text: '' }, { type: 'text', text: '| a |\n|---|' }])).toBe('First.\n\n| a |\n|---|')
  })
})
