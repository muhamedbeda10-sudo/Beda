// ============================================================================
// §20 — an answer the server writes while this device only follows it: the
// conversation is asked again while the server says the answer runs, and the
// list while one of its conversations is answered; a fetch that no longer
// says so ends it, and what that changed is refreshed (the bell too); Stop on
// such an answer goes to the server and says "Stopping…" at once.
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import type { AiConversation, AiConversationsResponse, AiMessage, AiMessagesResponse, AiRunningAnswer } from '@qc/shared/ai'

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }))
vi.mock('@/lib/api', async () => ({ ...(await vi.importActual<typeof import('@/lib/api')>('@/lib/api')), api: apiMock }))

const { AI_ANSWERING_POLL_MS, AI_RUNNING_POLL_MS, aiConversationsPoll, aiMessagesPoll, keys } = await import('@/services/queries')
const { stopAiAnswer, withStopping } = await import('@/services/mutations')
const { messagesConversation, refreshAfterAnswer, runningWatch } = await import('./running')

const conversation: AiConversation = { id: 'c1', title: 'Top defects', createdAt: '2026-10-09T10:00:00Z', lastMessageAt: '2026-10-09T10:00:00Z', pinnedAt: null, groupId: null, archivedAt: null }
const question: AiMessage = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Top defects?' }], createdAt: '2026-10-09T10:00:00Z' }
const soFar: AiMessage = { id: 't1', role: 'assistant', parts: [], createdAt: '2026-10-09T10:00:01Z', turnId: 't1', running: true }
const ended: AiMessage = { ...soFar, running: undefined, stopReason: 'end_turn' }
const running: AiRunningAnswer = { turnId: 't1', clientId: 'k1', question: 'Top defects?', questionMessageId: 'u1', askedAt: '2026-10-09T10:00:00Z', progress: null, stopping: false }
const writing: AiMessagesResponse = { conversation, messages: [question, soFar], running }
const done: AiMessagesResponse = { conversation, messages: [question, ended], running: null }

describe('asking again while an answer runs', () => {
  it('asks the conversation again every 2 s while the server says its answer runs, and not otherwise', () => {
    expect(AI_RUNNING_POLL_MS).toBe(2000)
    expect(aiMessagesPoll(writing)).toBe(2000)
    expect(aiMessagesPoll(done)).toBe(false)
    expect(aiMessagesPoll({ conversation, messages: [question, ended] })).toBe(false)
    expect(aiMessagesPoll(undefined)).toBe(false)
  })

  it('keeps asking while this device follows an answer whose stream it lost, through failed fetches, until the conversation is gone', async () => {
    const { ApiError } = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
    const stale: AiMessagesResponse = { conversation, messages: [question] }
    // The server restarting: the fetch after the stream failed, the copy from before says nothing runs.
    expect(aiMessagesPoll(stale, new ApiError(503, 'internal', 'Restarting'), true)).toBe(2000)
    expect(aiMessagesPoll(stale, new TypeError('Failed to fetch'), true)).toBe(2000)
    expect(aiMessagesPoll(stale, null, false)).toBe(false)
    // Deleted elsewhere, or the assistant taken away: never again, whatever the copy says.
    expect(aiMessagesPoll(writing, new ApiError(404, 'not_found', 'That conversation was not found.'))).toBe(false)
    expect(aiMessagesPoll(stale, new ApiError(403, 'forbidden', 'No assistant.'), true)).toBe(false)
  })

  it('asks the list again every 5 s while one of its conversations is answered, and not otherwise', () => {
    const list = (...answering: (boolean | undefined)[]): AiConversationsResponse => ({ conversations: answering.map((a, i) => ({ ...conversation, id: `c${i}`, answering: a })), hasMore: false })
    expect(AI_ANSWERING_POLL_MS).toBe(5000)
    expect(aiConversationsPoll(list(undefined, true))).toBe(5000)
    expect(aiConversationsPoll(list(false, undefined))).toBe(false)
    expect(aiConversationsPoll(list())).toBe(false)
    expect(aiConversationsPoll(undefined)).toBe(false)
  })
})

describe('telling when an answer followed through its conversation has ended', () => {
  it('reads which conversation a query of the cache holds the messages of', () => {
    expect(messagesConversation(keys.aiMessages('c1'))).toBe('c1')
    // The query of no conversation (a new chat), and any other query, hold none.
    expect(messagesConversation(keys.aiMessages(''))).toBeNull()
    expect(messagesConversation(keys.aiConversations)).toBeNull()
    expect(messagesConversation(['notifications', 'list', 'alerts'])).toBeNull()
  })

  it('tells once, when a fetch no longer says the answer runs, conversation by conversation', () => {
    const watch = runningWatch()
    // Opened after it ended: nothing ran, nothing to tell.
    expect(watch('c2', done, false)).toBe(false)
    expect(watch('c1', writing, false)).toBe(false)
    expect(watch('c1', writing, false)).toBe(false)
    // Another conversation's fetch says nothing of this one.
    expect(watch('c2', done, false)).toBe(false)
    expect(watch('c1', done, false)).toBe(true)
    expect(watch('c1', done, false)).toBe(false)
  })

  it('takes note of what this device put in itself without telling: the stream’s own end refreshes that', () => {
    const watch = runningWatch()
    expect(watch('c1', writing, false)).toBe(false)
    expect(watch('c1', done, true)).toBe(false)
    expect(watch('c1', done, false)).toBe(false)
  })

  it('refreshes what the answer changed elsewhere once it has ended, the bell too', () => {
    const qc = new QueryClient()
    const invalidate = vi.fn().mockResolvedValue(undefined)
    qc.invalidateQueries = invalidate as unknown as QueryClient['invalidateQueries']
    refreshAfterAnswer(qc)
    const refreshed = invalidate.mock.calls.map(([arg]) => JSON.stringify((arg as { queryKey: unknown[] }).queryKey))
    expect(refreshed.sort()).toEqual(
      [keys.aiConversations, keys.aiMe, keys.aiSettings, keys.aiAccess, ['ai', 'usage'], ['notifications']].map((k) => JSON.stringify(k)).sort(),
    )
  })
})

describe('Stop on an answer the server writes', () => {
  let qc: QueryClient
  beforeEach(() => {
    apiMock.mockReset()
    qc = new QueryClient()
  })

  it('marks the running answer as stopping, and leaves anything else as it is', () => {
    expect(withStopping(writing)?.running).toEqual({ ...running, stopping: true })
    const stopping = withStopping(writing)
    expect(withStopping(stopping)).toBe(stopping)
    expect(withStopping(done)).toBe(done)
    expect(withStopping(undefined)).toBeUndefined()
  })

  it('asks the server to stop it, and says "Stopping…" at once while the conversation goes on being asked', async () => {
    apiMock.mockResolvedValueOnce({ stopping: true })
    qc.setQueryData(keys.aiMessages('c1'), writing)
    await stopAiAnswer(qc, 'c1')
    expect(apiMock).toHaveBeenCalledWith('/ai/conversations/c1/stop', { method: 'POST' })
    const after = qc.getQueryData<AiMessagesResponse>(keys.aiMessages('c1'))
    expect(after?.running?.stopping).toBe(true)
    expect(aiMessagesPoll(after)).toBe(2000)
  })

  it('fetches the conversation again when nothing was being written any more, or the copy here is older than the answer', async () => {
    const invalidate = vi.fn().mockResolvedValue(undefined)
    qc.invalidateQueries = invalidate as unknown as QueryClient['invalidateQueries']
    apiMock.mockResolvedValueOnce({ stopping: false })
    qc.setQueryData(keys.aiMessages('c1'), writing)
    await stopAiAnswer(qc, 'c1')
    expect(invalidate).toHaveBeenCalledWith({ queryKey: keys.aiMessages('c1') })
    expect(qc.getQueryData<AiMessagesResponse>(keys.aiMessages('c1'))?.running?.stopping).toBe(false)
    // Stopping, but cached from before the answer began (a stream this device let go of): fetched, to show it.
    invalidate.mockClear()
    apiMock.mockResolvedValueOnce({ stopping: true })
    qc.setQueryData(keys.aiMessages('c2'), { conversation: { ...conversation, id: 'c2' }, messages: [] })
    await stopAiAnswer(qc, 'c2')
    expect(invalidate).toHaveBeenCalledWith({ queryKey: keys.aiMessages('c2') })
  })
})
