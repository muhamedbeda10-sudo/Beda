// ============================================================================
// §23 — a notice card's buttons through the cache: pressing it puts the card
// as it stands now in every cached conversation that holds it and has the
// notices (bell, Notices page) fetched again; Discard changes the card only;
// a conflict settles the card the server sent along and fetches the
// conversations again; any other refusal changes nothing.
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import type { AiMessagesResponse } from '@qc/shared/ai'
import type { AiNoticePart } from '@qc/shared/noticeAssistant'
import { ApiError } from '@/lib/api'

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }))
vi.mock('@/lib/api', async () => ({ ...(await vi.importActual<typeof import('@/lib/api')>('@/lib/api')), api: apiMock }))

const { applyNoticeProposal, discardNoticeProposal } = await import('./noticeProposals')
const { keys } = await import('./queries')

const card: AiNoticePart = {
  type: 'notice',
  proposalId: 'n1',
  ok: true,
  action: 'create',
  state: 'proposed',
  draft: { title: 'Coating', body: 'Check it.', severity: 'warning', requiresAck: true, matchMode: 'all', validFrom: '2026-10-10', validTo: null, targets: [] },
  reach: { everyone: true, people: 42, placeBound: false },
}
const conversation = (id: string): AiMessagesResponse => ({
  conversation: { id, title: 'Notices', createdAt: '2026-10-10T05:00:00Z', lastMessageAt: '2026-10-10T05:00:00Z', pinnedAt: null, groupId: null, archivedAt: null },
  messages: [{ id: `${id}-a`, role: 'assistant', parts: [{ type: 'text', text: 'Here it is.' }, card], createdAt: '2026-10-10T05:00:05Z' }],
})
const cardIn = (qc: QueryClient, id: string) => qc.getQueryData<AiMessagesResponse>(keys.aiMessages(id))?.messages[0].parts[1]

describe('a notice card’s buttons through the cache', () => {
  let qc: QueryClient

  beforeEach(() => {
    apiMock.mockReset()
    qc = new QueryClient()
    qc.setQueryData(keys.aiMessages('c1'), conversation('c1'))
    qc.setQueryData(keys.aiMessages('c2'), conversation('c2'))
    qc.setQueryData(keys.noticeInbox, { notices: [] })
    qc.setQueryData(keys.noticesAdmin, [])
  })

  it('pressing it puts the card as it stands now in every conversation, and has the bell and the Notices page fetched again', async () => {
    const applied: AiNoticePart = { ...card, state: 'applied', noticeId: 'nt1', appliedAt: '2026-10-10T05:01:00Z', appliedByName: 'Mona Adel' }
    apiMock.mockResolvedValueOnce({ part: applied })
    await applyNoticeProposal(qc, 'n1')
    expect(apiMock).toHaveBeenCalledWith('/ai/notice-proposals/n1/apply', { method: 'POST' })
    for (const id of ['c1', 'c2']) expect(cardIn(qc, id)).toEqual(applied)
    expect(qc.getQueryState(keys.noticeInbox)?.isInvalidated).toBe(true)
    expect(qc.getQueryState(keys.noticesAdmin)?.isInvalidated).toBe(true)
  })

  it('discarding changes the card only', async () => {
    const discarded: AiNoticePart = { ...card, state: 'discarded' }
    apiMock.mockResolvedValueOnce({ part: discarded })
    await discardNoticeProposal(qc, 'n1')
    expect(apiMock).toHaveBeenCalledWith('/ai/notice-proposals/n1/discard', { method: 'POST' })
    expect(cardIn(qc, 'c1')).toEqual(discarded)
    expect(qc.getQueryState(keys.noticeInbox)?.isInvalidated).toBe(false)
  })

  it('a card out of date settles as the server sent it, and the conversations and notices are fetched again', async () => {
    const stale: AiNoticePart = { ...card, action: 'update', noticeId: 'nt1', state: 'stale' }
    apiMock.mockRejectedValueOnce(new ApiError(409, 'conflict', 'The notice changed since this card was made. Ask the assistant again.', { part: stale }))
    await expect(applyNoticeProposal(qc, 'n1')).rejects.toThrow(/changed since/)
    for (const id of ['c1', 'c2']) {
      expect(cardIn(qc, id)).toEqual(stale)
      expect(qc.getQueryState(keys.aiMessages(id))?.isInvalidated).toBe(true)
    }
    expect(qc.getQueryState(keys.noticesAdmin)?.isInvalidated).toBe(true)
  })

  it('a conflict without the card leaves it to the conversation fetched again', async () => {
    apiMock.mockRejectedValueOnce(new ApiError(409, 'conflict', 'This card was already applied.'))
    await expect(applyNoticeProposal(qc, 'n1')).rejects.toThrow(/already applied/)
    expect(cardIn(qc, 'c1')).toBe(card)
    expect(qc.getQueryState(keys.aiMessages('c1'))?.isInvalidated).toBe(true)
  })

  it('any other refusal changes nothing', async () => {
    apiMock.mockRejectedValueOnce(new ApiError(404, 'not_found', 'Not found.'))
    await expect(applyNoticeProposal(qc, 'n1')).rejects.toThrow(/Not found/)
    expect(cardIn(qc, 'c1')).toBe(card)
    expect(qc.getQueryState(keys.aiMessages('c1'))?.isInvalidated).toBe(false)
    expect(qc.getQueryState(keys.noticeInbox)?.isInvalidated).toBe(false)
  })
})
