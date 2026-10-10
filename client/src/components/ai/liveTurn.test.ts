import { describe, expect, it } from 'vitest'
import type { AiConversation, AiMessage, AiMessagesResponse, AiQueryPart, AiStatusResponse } from '@qc/shared/ai'
import type { AiAutomationPart, AutomationDraft } from '@qc/shared/automation'
import type { AiNoticePart } from '@qc/shared/noticeAssistant'
import { answerText, applyEvent, endTurn, followsKeptRound, isInFlight, latestAnswerKey, liveAnnouncement, liveView, parseStreamEvent, sentAfter, settleMessages, startTurn, threadItems, type LiveTurn } from './liveTurn'

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

  it('puts a proposed automation’s card where it came, and the same proposal again in its place', () => {
    const card: AiAutomationPart = { type: 'automation', proposalId: 'p1', ok: false, error: 'watch.keyColumn: not a column', state: 'proposed' }
    const fixed: AiAutomationPart = { ...card, ok: true, error: undefined }
    const t = run([{ type: 'start', conversation, userMessageId: 'u1' }, { type: 'progress', text: 'Drafting it' }, { type: 'automation', part: card }])
    expect(t.parts).toEqual([card])
    expect(t.progress).toBeNull()
    expect(applyEvent(t, { type: 'automation', part: fixed }).parts).toEqual([fixed])
    const second: AiAutomationPart = { ...fixed, proposalId: 'p2' }
    expect(applyEvent(applyEvent(t, { type: 'text', delta: 'Here it is.' }), { type: 'automation', part: second }).parts).toEqual([card, { type: 'text', text: 'Here it is.' }, second])
    expect(parseStreamEvent('automation', JSON.stringify({ type: 'automation', part: card }))).toEqual({ type: 'automation', part: card })
  })

  it('marks a card of the answer replaced the moment its newer version arrives, and only one the server accepted', () => {
    const draft: AutomationDraft = { kind: 'report', name: 'Daily rejects', description: 'd', language: 'en', recipients: [], channels: { bell: true, chat: false }, actions: { notify: true, followUp: null } }
    const first: AiAutomationPart = { type: 'automation', proposalId: 'p1', ok: true, state: 'proposed', draft }
    const revision: AiAutomationPart = { type: 'automation', proposalId: 'p2', ok: true, state: 'proposed', draft: { ...draft, revisesProposalId: 'p1' } }
    const t = run([{ type: 'start', conversation, userMessageId: 'u1' }, { type: 'automation', part: first }, { type: 'text', delta: 'Or daily at 7:00:' }])
    expect(applyEvent(t, { type: 'automation', part: revision }).parts).toEqual([{ ...first, state: 'superseded' }, { type: 'text', text: 'Or daily at 7:00:' }, revision])
    // Refused, it replaces nothing: the first card is still the one to decide.
    const refused: AiAutomationPart = { ...revision, ok: false, error: 'revisesProposalId: no such proposal' }
    expect(applyEvent(t, { type: 'automation', part: refused }).parts).toEqual([first, { type: 'text', text: 'Or daily at 7:00:' }, refused])
    // A card of an earlier answer is not in this one: the parts are left as they came.
    const other: AiAutomationPart = { ...revision, draft: { ...draft, revisesProposalId: 'p0' } }
    expect(applyEvent(t, { type: 'automation', part: other }).parts).toEqual([first, { type: 'text', text: 'Or daily at 7:00:' }, other])
  })

  it('puts a notice card where it came, and the same card again in its place', () => {
    const card: AiNoticePart = { type: 'notice', proposalId: 'n1', ok: false, error: 'targets[0]: no machine RF-99', action: 'create', state: 'proposed' }
    const fixed: AiNoticePart = {
      ...card,
      ok: true,
      error: undefined,
      draft: { title: 'Coating', body: 'Check it.', severity: 'warning', requiresAck: true, matchMode: 'all', validFrom: '2026-10-10', validTo: null, targets: [{ kind: 'machine', value: 'RF-03', label: 'RF-03' }] },
      reach: { everyone: false, people: null, placeBound: true },
    }
    const t = run([{ type: 'start', conversation, userMessageId: 'u1' }, { type: 'progress', text: 'Drafting the notice' }, { type: 'notice', part: card }])
    expect(t.parts).toEqual([card])
    expect(t.progress).toBeNull()
    expect(applyEvent(t, { type: 'notice', part: fixed }).parts).toEqual([fixed])
    const second: AiNoticePart = { ...fixed, proposalId: 'n2' }
    expect(applyEvent(applyEvent(t, { type: 'text', delta: 'Here it is.' }), { type: 'notice', part: second }).parts).toEqual([card, { type: 'text', text: 'Here it is.' }, second])
    expect(parseStreamEvent('notice', JSON.stringify({ type: 'notice', part: fixed }))).toEqual({ type: 'notice', part: fixed })
    expect(parseStreamEvent('automation', JSON.stringify({ type: 'notice', part: fixed }))).toBeNull()
  })

  it('knows the round of the tools before an event is kept only once the model writes again', () => {
    expect(followsKeptRound({ type: 'text', delta: 'Here is the new version.' })).toBe(true)
    expect(followsKeptRound({ type: 'progress', text: 'Checking the dates' })).toBe(true)
    // A query or a card may come from a later call of the same round, which is kept only after its last call.
    const card: AiNoticePart = { type: 'notice', proposalId: 'n2', ok: true, action: 'withdraw', state: 'proposed' }
    expect(followsKeptRound({ type: 'notice', part: card })).toBe(false)
    expect(followsKeptRound({ type: 'query_start', queryId: 'q1', purpose: 'Readers', sql: 'SELECT 1' })).toBe(false)
    expect(followsKeptRound({ type: 'query_end', part: query })).toBe(false)
    expect(followsKeptRound({ type: 'start', conversation, userMessageId: 'u1' })).toBe(false)
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

  it('places a question stopped before the stream began by its words, so it is not drawn twice', () => {
    // An earlier exchange, then the same conversation asked again and stopped before 'start' named the question.
    const q0: AiMessage = { id: 'u0', role: 'user', parts: [{ type: 'text', text: 'Holds?' }], createdAt: '2026-10-09T09:00:00Z' }
    const a0: AiMessage = { ...answer, id: 'a0' }
    const asked: AiMessage = { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'Top defects?' }], createdAt: '2026-10-09T10:01:00Z' }
    const stoppedAnswer: AiMessage = { id: 't2', role: 'assistant', parts: [], createdAt: '2026-10-09T10:01:01Z', costUsd: 0, stopReason: 'stopped' }
    const stopped = endTurn(startTurn('k2', 'c1', 'Top defects?', '2026-10-09T10:01:00Z', 'a0'), 'stopped')
    expect(stopped.userMessageId).toBeNull()

    // The server kept the question and its stopped answer: the saved ones are drawn, the live ones not.
    const saved = [q0, a0, asked, stoppedAnswer]
    expect(liveView(stopped, 'c1', saved)).toEqual({ saved, question: false, answer: false })
    // Only the question is kept so far: it is drawn saved, and the stop notice stays live.
    expect(liveView(stopped, 'c1', [q0, a0, asked])).toEqual({ saved: [q0, a0, asked], question: false, answer: true })
    // Nothing was kept (the stop came first): the turn draws itself.
    expect(liveView(stopped, 'c1', [q0, a0])).toEqual({ saved: [q0, a0], question: true, answer: true })
    // The same words asked earlier than the send are not this question.
    const earlier = endTurn(startTurn('k3', 'c1', 'Holds?', '2026-10-09T10:02:00Z', 'a0'), 'stopped')
    expect(liveView(earlier, 'c1', [q0, a0])).toMatchObject({ question: true, answer: true })
    // What it was sent after is gone from the list: nothing places it.
    const lost = endTurn(startTurn('k4', 'c1', 'Top defects?', '2026-10-09T10:02:00Z', 'gone'), 'stopped')
    expect(liveView(lost, 'c1', saved)).toMatchObject({ question: true, answer: true })
    // Sent with nothing of the conversation on the device: the latest question in its words.
    const blind = endTurn(startTurn('k5', 'c1', 'Top defects?', '2026-10-09T10:02:00Z', null), 'stopped')
    expect(liveView(blind, 'c1', saved)).toEqual({ saved, question: false, answer: false })
    // Still being sent (Ask again of the stopped one, say): same words, but not yet this question's place.
    const resent = startTurn('k6', 'c1', 'Top defects?', '2026-10-09T10:03:00Z', 'a0')
    expect(liveView(resent, 'c1', saved)).toEqual({ saved, question: true, answer: true })
  })

  it('sends a quick Ask again after the stopped question, so a failure before its start is still drawn', () => {
    const q0: AiMessage = { id: 'u0', role: 'user', parts: [{ type: 'text', text: 'Holds?' }], createdAt: '2026-10-09T09:00:00Z' }
    const a0: AiMessage = { ...answer, id: 'a0' }
    const stoppedAnswer: AiMessage = { id: 't1', role: 'assistant', parts: [], createdAt: '2026-10-09T10:00:02Z', costUsd: 0, stopReason: 'stopped' }
    // Stopped after 'start' named its question, which this device has not fetched yet.
    const stopped = endTurn(run([{ type: 'start', conversation, userMessageId: 'u1' }], startTurn('k1', 'c1', 'Top defects?', '2026-10-09T10:00:00Z', 'a0')), 'stopped')
    expect(sentAfter(stopped, 'c1', [q0, a0])).toBe('u1')

    // Asked again in the same words, refused before its own start: drawn, error and all — not taken for the stopped one.
    const again = endTurn(startTurn('k2', 'c1', 'Top defects?', '2026-10-09T10:00:03Z', sentAfter(stopped, 'c1', [q0, a0])), 'error', { code: 'conflict', message: 'Still answering the previous question. Wait for it, or stop it.' })
    const saved = [q0, a0, question, stoppedAnswer]
    expect(liveView(again, 'c1', saved)).toEqual({ saved, question: true, answer: true })
    // Anchored on what the cache held instead, the stopped question would have swallowed it.
    expect(liveView({ ...again, after: 'a0' }, 'c1', saved)).toMatchObject({ question: false, answer: false })
    // Kept by the server after all: found after the stopped exchange.
    const kept: AiMessage = { ...question, id: 'u2' }
    expect(liveView(again, 'c1', [...saved, kept])).toEqual({ saved: [...saved, kept], question: false, answer: true })

    // The question before already fetched, another conversation's turn, no turn, a new conversation: the cache's last.
    expect(sentAfter(stopped, 'c1', [q0, a0, question])).toBe('u1')
    expect(sentAfter(stopped, 'c1', saved)).toBe('t1')
    expect(sentAfter(stopped, 'c2', [q0, a0])).toBe('a0')
    expect(sentAfter(null, 'c1', [q0, a0])).toBe('a0')
    expect(sentAfter(endTurn(startTurn('k3', 'c1', 'Top defects?', '2026-10-09T10:00:00Z', 'a0'), 'stopped'), 'c1', [q0, a0])).toBe('a0')
    expect(sentAfter(stopped, null, undefined)).toBeNull()
    expect(sentAfter(null, 'c1', undefined)).toBeNull()
  })

  it('keys an answer by its question, the same while written, once saved and after the next question', () => {
    const streaming = run([{ type: 'start', conversation, userMessageId: 'u1' }, { type: 'query_end', part: query }])
    const writing = threadItems(streaming, liveView(streaming, 'c1', []))
    expect(writing.map((i) => [i.kind, i.key])).toEqual([
      ['question', 'question:k1'],
      ['answer', 'answer:u1'],
    ])

    const done = applyEvent(streaming, { type: 'done', message: answer, status })
    // Done, before the saved list has it: still the turn's, at the same key.
    expect(threadItems(done, liveView(done, 'c1', [])).at(-1)).toEqual({ kind: 'answer', key: 'answer:u1' })
    // Saved: the saved answer takes the same key.
    const settled = threadItems(done, liveView(done, 'c1', [question, answer]))
    expect(settled.map((i) => [i.kind, i.key])).toEqual([
      ['saved', 'u1'],
      ['saved', 'answer:u1'],
    ])
    // The next question asked: the earlier answer keeps its key.
    const next = startTurn('k2', 'c1', 'And last month?', '2026-10-09T10:05:00Z', 'a1')
    const after = threadItems(next, liveView(next, 'c1', [question, answer]))
    expect(after.map((i) => i.key)).toEqual(['u1', 'answer:u1', 'question:k2', 'live:k2'])
  })

  it('never gives two items one key', () => {
    // Two answers to one question (a list the server sent oddly), and an answer with no question before it.
    const odd = [{ ...answer, id: 'a0' }, question, answer, { ...answer, id: 'a2' }]
    const keys = threadItems(null, { saved: odd, question: false, answer: false }).map((i) => i.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).toEqual(['a0', 'u1', 'answer:u1', 'a2'])
  })

  it('settles the finished answer over a half-done copy a refetch left in the cache', () => {
    const half: AiMessage = { id: 'a1', role: 'assistant', parts: [query], createdAt: '2026-10-09T10:00:03Z' }
    const old: AiMessagesResponse = { conversation, messages: [question, half] }
    const next = settleMessages(old, conversation, question, answer)
    expect(next.messages).toEqual([question, answer])
    expect(next.messages[1]).toMatchObject({ costUsd: 0.012, stopReason: 'end_turn' })
    // Nothing cached yet: both are added, in order.
    expect(settleMessages(undefined, conversation, question, answer)).toEqual({ conversation, messages: [question, answer] })
    // Earlier messages stay where they were.
    const earlier: AiMessage = { ...question, id: 'u0' }
    expect(settleMessages({ conversation, messages: [earlier] }, conversation, question, answer).messages).toEqual([earlier, question, answer])
  })

  it('announces the phase of the answer, not every word of the model’s thinking', () => {
    const sending = startTurn('k1', null, 'Top defects?', '2026-10-09T10:00:00Z')
    expect(liveAnnouncement(null)).toBe('')
    expect(liveAnnouncement(sending)).toBe('Thinking…')
    const thinking = run([{ type: 'start', conversation, userMessageId: 'u1' }, { type: 'progress', text: 'Looking at the defects view' }])
    expect(liveAnnouncement(thinking)).toBe('Thinking…')
    expect(liveAnnouncement(applyEvent(thinking, { type: 'progress', text: 'Now the machines' }))).toBe('Thinking…')
    const querying = applyEvent(thinking, { type: 'query_start', queryId: 'q1', purpose: 'Defects', sql: 'SELECT 1' })
    expect(liveAnnouncement(querying)).toBe('Running a query…')
    expect(liveAnnouncement(applyEvent(querying, { type: 'query_end', part: query }))).toBe('Thinking…')
    expect(liveAnnouncement(applyEvent(querying, { type: 'done', message: answer, status }))).toBe('Answer ready.')
    expect(liveAnnouncement(endTurn(querying, 'stopped'))).toBe('Stopped.')
    expect(liveAnnouncement(endTurn(querying, 'error', { code: 'ai_budget_reached', message: 'The monthly cap is reached.' }))).toBe('The monthly cap is reached.')
  })

  it('offers follow-up questions under the last answer only, and none while a question waits for its answer', () => {
    const saved = [question, answer]
    expect(latestAnswerKey(threadItems(null, { saved, question: false, answer: false }))).toBe('answer:u1')
    expect(latestAnswerKey(threadItems(null, { saved: [question], question: false, answer: false }))).toBeNull()
    expect(latestAnswerKey([])).toBeNull()
    // A next question asked: the answer being written is the latest, and the one before it is not.
    const next = run([{ type: 'start', conversation, userMessageId: 'u2' }], startTurn('k2', 'c1', 'And last month?', '2026-10-09T10:01:00Z', 'a1'))
    const items = threadItems(next, liveView(next, 'c1', saved))
    expect(latestAnswerKey(items)).toBe('answer:u2')
  })

  it('copies the text of an answer as markdown, without its queries', () => {
    expect(answerText([query, { type: 'text', text: ' First. ' }, { type: 'text', text: '' }, { type: 'text', text: '| a |\n|---|' }])).toBe('First.\n\n| a |\n|---|')
  })
})
