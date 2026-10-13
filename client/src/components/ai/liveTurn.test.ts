import { describe, expect, it } from 'vitest'
import type { AiConversation, AiMessage, AiMessagesResponse, AiQueryPart, AiRunningAnswer, AiStatusResponse } from '@qc/shared/ai'
import type { AiAutomationPart, AutomationDraft } from '@qc/shared/automation'
import type { AiExcelPart } from '@qc/shared/aiExcel'
import type { AiNoticePart } from '@qc/shared/noticeAssistant'
import type { AiSavedTablePart } from '@qc/shared/savedTables'
import {
  answerText,
  applyEvent,
  askedToStop,
  endTurn,
  followsKeptRound,
  isInFlight,
  latestAnswerKey,
  letGoOf,
  liveAnnouncement,
  liveView,
  parseStreamEvent,
  partsBeingWritten,
  sentAfter,
  settleMessages,
  startTurn,
  streamEnded,
  threadAnnouncement,
  threadItems,
  type LiveTurn,
} from './liveTurn'

const conversation: AiConversation = { id: 'c1', title: 'Top defects', createdAt: '2026-10-09T10:00:00Z', lastMessageAt: '2026-10-09T10:00:00Z' }
const status: AiStatusResponse = { available: true, model: 'claude-sonnet-5-5', spentUsd: 1, capUsd: 50, monthStart: '2026-10-01T00:00:00Z' }
const query: AiQueryPart = { type: 'query', queryId: 'q1', purpose: 'Defects', sql: 'SELECT 1', ok: true, columns: ['n'], rows: [[1]], rowCount: 1, truncated: false, ms: 12 }
const answer: AiMessage = { id: 'a1', role: 'assistant', parts: [query, { type: 'text', text: 'Weld porosity leads.' }], createdAt: '2026-10-09T10:00:05Z', costUsd: 0.012, stopReason: 'end_turn' }
const question: AiMessage = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Top defects?' }], createdAt: '2026-10-09T10:00:00Z' }
/** The same answer as the server lists it while it is still writing it: what it has done so far, how it ends to come. */
const writtenSoFar: AiMessage = { id: 'a1', role: 'assistant', parts: [query], createdAt: '2026-10-09T10:00:03Z', turnId: 'a1', running: true }
const running: AiRunningAnswer = { turnId: 'a1', clientId: 'k1', question: 'Top defects?', questionMessageId: 'u1', askedAt: '2026-10-09T10:00:00Z', progress: 'Counting the holds', stopping: false }

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

  it('puts an Excel file where it came, and the same file again in its place', () => {
    const file: AiExcelPart = {
      type: 'excel',
      fileId: 'f1',
      fileName: 'Scrap by machine',
      sheets: [{ name: 'Scrap', columns: ['Machine', 'Pieces'], rows: 12 }],
      byteSize: 7000,
      expiresAt: '2026-11-12T08:30:00.000Z',
    }
    const t = run([{ type: 'start', conversation, userMessageId: 'u1' }, { type: 'progress', text: 'Laying out the file' }, { type: 'excel', part: file }])
    expect(t.parts).toEqual([file])
    expect(t.progress).toBeNull()
    const again: AiExcelPart = { ...file, sheets: [{ ...file.sheets[0], rows: 13 }] }
    expect(applyEvent(t, { type: 'excel', part: again }).parts).toEqual([again])
    const second: AiExcelPart = { ...file, fileId: 'f2' }
    expect(applyEvent(applyEvent(t, { type: 'text', delta: 'Here it is.' }), { type: 'excel', part: second }).parts).toEqual([file, { type: 'text', text: 'Here it is.' }, second])
    expect(parseStreamEvent('excel', JSON.stringify({ type: 'excel', part: file }))).toEqual({ type: 'excel', part: file })
    expect(parseStreamEvent('task', JSON.stringify({ type: 'excel', part: file }))).toBeNull()
    expect(followsKeptRound({ type: 'excel', part: file })).toBe(false)
  })

  it('puts a saved table where it came, and the same change again in its place', () => {
    const table: AiSavedTablePart = {
      type: 'saved-table',
      changeId: 's1',
      tableId: 't1',
      name: 'routing_steps',
      title: 'Routing by item family',
      action: 'create',
      source: 'query',
      refresh: 'daily',
      rowCount: 120,
      columns: ['family', 'step_no', 'work_center'],
      state: 'current',
    }
    const t = run([{ type: 'start', conversation, userMessageId: 'u1' }, { type: 'progress', text: 'Saving the routing' }, { type: 'saved-table', part: table }])
    expect(t.parts).toEqual([table])
    expect(t.progress).toBeNull()
    const again: AiSavedTablePart = { ...table, rowCount: 121 }
    expect(applyEvent(t, { type: 'saved-table', part: again }).parts).toEqual([again])
    const second: AiSavedTablePart = { ...table, changeId: 's2', action: 'refresh' }
    expect(applyEvent(applyEvent(t, { type: 'text', delta: 'Saved.' }), { type: 'saved-table', part: second }).parts).toEqual([table, { type: 'text', text: 'Saved.' }, second])
    expect(parseStreamEvent('saved-table', JSON.stringify({ type: 'saved-table', part: table }))).toEqual({ type: 'saved-table', part: table })
    expect(parseStreamEvent('excel', JSON.stringify({ type: 'saved-table', part: table }))).toBeNull()
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

    // Stopped before the stream began, and the server kept the question but no answer: the stop notice stays.
    const stopped = endTurn(startTurn('k2', 'c1', 'Top defects?', '2026-10-09T10:00:00Z'), 'stopped')
    expect(liveView(stopped, 'c1', [question])).toEqual({ saved: [question], question: false, answer: true })
  })

  it('lets go of a turn whose stream ended after its start without saying how, and hands it to the saved conversation', () => {
    const querying = run([{ type: 'start', conversation, userMessageId: 'u1' }, { type: 'progress', text: 'Checking holds' }, { type: 'query_start', queryId: 'q2', purpose: 'Holds', sql: 'SELECT 2' }])
    // The stream ended with neither done nor error (a server that restarted): the answer goes on there.
    const detached = streamEnded(querying, false)
    expect(detached.phase).toBe('detached')
    expect(isInFlight(detached)).toBe(false)
    expect(detached.progress).toBeNull()
    expect(detached.error).toBeNull()
    // Its query is not taken for interrupted: it still runs on the server.
    expect(detached.parts).toEqual([{ type: 'pending-query', queryId: 'q2', purpose: 'Holds', sql: 'SELECT 2', state: 'running' }])
    // Let go of after Stop was pressed (the server was told), or cut off: the same, never "stopped" on this side.
    expect(streamEnded(askedToStop(querying), true)).toMatchObject({ phase: 'detached', stopping: true })
    // Before `start` nothing may have been kept: Stop pressed then stops it, anything else lost it.
    const sending = startTurn('k2', 'c1', 'Holds?', '2026-10-09T10:01:00Z')
    expect(streamEnded(sending, true)).toMatchObject({ phase: 'stopped', error: null })
    expect(streamEnded(sending, false)).toMatchObject({ phase: 'error', error: { message: 'The connection was lost before the answer finished.' } })
    // An ended turn stays as it ended.
    const done = applyEvent(querying, { type: 'done', message: answer, status })
    expect(streamEnded(done, false)).toBe(done)

    // The saved conversation not fetched again yet: the turn draws itself, as it stood.
    expect(liveView(detached, 'c1', [])).toEqual({ saved: [], question: true, answer: true })
    // Fetched: the server's answer, still being written, takes over at the same key — nothing is drawn twice.
    const handed = liveView(detached, 'c1', [question, writtenSoFar])
    expect(handed).toEqual({ saved: [question, writtenSoFar], question: false, answer: false })
    expect(threadItems(detached, liveView(detached, 'c1', [])).at(-1)).toEqual({ kind: 'answer', key: 'answer:u1' })
    expect(threadItems(detached, handed).map((i) => [i.kind, i.key])).toEqual([
      ['saved', 'u1'],
      ['saved', 'answer:u1'],
    ])
    // And once it has ended there, the same.
    expect(liveView(detached, 'c1', [question, answer])).toEqual({ saved: [question, answer], question: false, answer: false })

    // Still drawn from itself only until the saved conversation holds its answer, and only in its own conversation.
    expect(letGoOf(detached, 'c1', [])).toBe(true)
    expect(letGoOf(detached, 'c1', [question, writtenSoFar])).toBe(false)
    expect(letGoOf(detached, 'c2', [])).toBe(false)
    expect(letGoOf(querying, 'c1', [])).toBe(false)
    expect(letGoOf(null, 'c1', [])).toBe(false)
  })

  it('marks Stop pressed on the answer being read, until its done, and takes it back when the server could not be told', () => {
    const streaming = run([{ type: 'start', conversation, userMessageId: 'u1' }])
    const stopping = askedToStop(streaming)
    expect(stopping.stopping).toBe(true)
    expect(isInFlight(stopping)).toBe(true)
    expect(liveAnnouncement(stopping)).toBe('Stopping…')
    expect(askedToStop(stopping)).toBe(stopping)
    expect(askedToStop(stopping, false).stopping).toBe(false)
    // The server's done says how it ended: stopped.
    const stopped = applyEvent(stopping, { type: 'done', message: { ...answer, stopReason: 'stopped' }, status })
    expect(stopped.phase).toBe('done')
    expect(liveAnnouncement(stopped)).toBe('Stopped.')
    // Nothing to stop once it has ended.
    const done = applyEvent(streaming, { type: 'done', message: answer, status })
    expect(askedToStop(done)).toBe(done)
  })

  it('finds the parts of the answer being written in a conversation, wherever the thread draws it from', () => {
    const card: AiNoticePart = { type: 'notice', proposalId: 'n2', ok: true, action: 'withdraw', state: 'proposed' }
    const streaming = run([{ type: 'start', conversation, userMessageId: 'u1' }, { type: 'notice', part: card }])
    expect(partsBeingWritten(streaming, 'c1', [])).toEqual([card])
    expect(partsBeingWritten(streaming, 'c2', [])).toEqual([])
    expect(partsBeingWritten(streaming, null, [])).toEqual([])
    // Let go of: its own parts until the saved conversation holds its answer, then the server's.
    const detached = streamEnded(streaming, false)
    expect(partsBeingWritten(detached, 'c1', [])).toEqual([card])
    expect(partsBeingWritten(detached, 'c1', [question, writtenSoFar])).toEqual([query])
    expect(partsBeingWritten(detached, 'c1', [question, answer])).toEqual([])
    // Reopened while the server writes it, with no turn of this device.
    expect(partsBeingWritten(null, 'c1', [question, writtenSoFar])).toEqual([query])
    expect(partsBeingWritten(null, 'c1', [question, answer])).toEqual([])
    // Ended on this side: nothing is being written.
    expect(partsBeingWritten(applyEvent(streaming, { type: 'done', message: answer, status }), 'c1', [question, answer])).toEqual([])
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

  it('sends the same words asked again after a turn let go of after its start, so a failure before their own start is still drawn', () => {
    const q0: AiMessage = { id: 'u0', role: 'user', parts: [{ type: 'text', text: 'Holds?' }], createdAt: '2026-10-09T09:00:00Z' }
    const a0: AiMessage = { ...answer, id: 'a0' }
    const earlierAnswer: AiMessage = { id: 't1', role: 'assistant', parts: [], createdAt: '2026-10-09T10:00:02Z', costUsd: 0, stopReason: 'stopped' }
    // Let go of after 'start' named its question, which this device has not fetched yet.
    const detached = streamEnded(run([{ type: 'start', conversation, userMessageId: 'u1' }], startTurn('k1', 'c1', 'Top defects?', '2026-10-09T10:00:00Z', 'a0')), false)
    expect(sentAfter(detached, 'c1', [q0, a0])).toBe('u1')

    // Asked again in the same words, refused before its own start: drawn, error and all — not taken for the earlier one.
    const again = endTurn(startTurn('k2', 'c1', 'Top defects?', '2026-10-09T10:00:03Z', sentAfter(detached, 'c1', [q0, a0])), 'error', { code: 'conflict', message: 'Still answering the previous question. Wait for it, or stop it.' })
    const saved = [q0, a0, question, earlierAnswer]
    expect(liveView(again, 'c1', saved)).toEqual({ saved, question: true, answer: true })
    // Anchored on what the cache held instead, the earlier question would have swallowed it.
    expect(liveView({ ...again, after: 'a0' }, 'c1', saved)).toMatchObject({ question: false, answer: false })
    // Kept by the server after all: found after the earlier exchange.
    const kept: AiMessage = { ...question, id: 'u2' }
    expect(liveView(again, 'c1', [...saved, kept])).toEqual({ saved: [...saved, kept], question: false, answer: true })

    // The question before already fetched, another conversation's turn, no turn, a new conversation: the cache's last.
    expect(sentAfter(detached, 'c1', [q0, a0, question])).toBe('u1')
    expect(sentAfter(detached, 'c1', saved)).toBe('t1')
    expect(sentAfter(detached, 'c2', [q0, a0])).toBe('a0')
    expect(sentAfter(null, 'c1', [q0, a0])).toBe('a0')
    expect(sentAfter(endTurn(startTurn('k3', 'c1', 'Top defects?', '2026-10-09T10:00:00Z', 'a0'), 'stopped'), 'c1', [q0, a0])).toBe('a0')
    expect(sentAfter(detached, null, undefined)).toBeNull()
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

  it('settles the finished answer over the copy the server listed while writing it, and no longer says it runs', () => {
    const old: AiMessagesResponse = { conversation, messages: [question, writtenSoFar], running }
    const finished: AiMessage = { ...answer, turnId: 'a1' }
    const next = settleMessages(old, conversation, question, finished)
    expect(next.messages).toEqual([question, finished])
    expect(next.running).toBeNull()
    // Found by its question too, when the answer came without its turn.
    expect(settleMessages(old, conversation, question, answer).running).toBeNull()
    // Another answer still running there is left as it is.
    const other: AiRunningAnswer = { ...running, turnId: 'a9', questionMessageId: 'u9' }
    expect(settleMessages({ ...old, running: other }, conversation, question, finished).running).toBe(other)
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
    expect(liveAnnouncement(streamEnded(querying, false))).toBe('Thinking…')
  })

  it('reads out the answer the server writes once this device only follows it, and when one let go of is ready', () => {
    const streaming = run([{ type: 'start', conversation, userMessageId: 'u1' }])
    const detached = streamEnded(streaming, false)
    const view = (t: LiveTurn | null, saved: AiMessage[]) => liveView(t, 'c1', saved)
    // The turn this device reads speaks for itself, whatever the conversation fetched meanwhile says.
    expect(threadAnnouncement(streaming, 'c1', view(streaming, [question, writtenSoFar]), running)).toBe('Thinking…')
    // Reopened while it runs, or let go of: the server's word, then ready once it no longer says it runs.
    expect(threadAnnouncement(null, 'c1', view(null, [question, writtenSoFar]), running)).toBe('Thinking…')
    expect(threadAnnouncement(null, 'c1', view(null, [question, writtenSoFar]), { ...running, stopping: true })).toBe('Stopping…')
    expect(threadAnnouncement(detached, 'c1', view(detached, []), null)).toBe('Thinking…')
    expect(threadAnnouncement(detached, 'c1', view(detached, [question, writtenSoFar]), running)).toBe('Thinking…')
    expect(threadAnnouncement(detached, 'c1', view(detached, [question, answer]), null)).toBe('Answer ready.')
    // Another conversation's turn says nothing here; nothing at all, nothing to say.
    expect(threadAnnouncement(streaming, 'c2', view(streaming, []), null)).toBe('')
    expect(threadAnnouncement(null, 'c1', view(null, [question, answer]), null)).toBe('')
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
