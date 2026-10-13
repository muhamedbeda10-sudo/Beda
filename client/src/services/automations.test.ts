// ============================================================================
// §21 — automations through the cache: activating or discarding a proposal
// changes its card in every cached conversation that holds it, and one
// refused as decided or replaced elsewhere has them fetched again; a change, a
// pause or a deletion reaches the automation's page and every list at once;
// a 404 makes /ai/me be asked again (the permission may be gone).
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import type { AiMessagesResponse } from '@qc/shared/ai'
import type { AiAutomationPart, Automation } from '@qc/shared/automation'
import { ApiError } from '@/lib/api'

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }))
vi.mock('@/lib/api', async () => ({ ...(await vi.importActual<typeof import('@/lib/api')>('@/lib/api')), api: apiMock }))

const { activateProposal, automationKeys, deleteAutomation, discardProposal, pauseAutomation, recheckAccessOn404, runAutomationNow } = await import('./automations')
const { keys } = await import('./queries')

const card: AiAutomationPart = { type: 'automation', proposalId: 'p1', ok: true, state: 'proposed' }
const conversation = (id: string): AiMessagesResponse => ({
  conversation: { id, title: 'Holds', createdAt: '2026-10-10T05:00:00Z', lastMessageAt: '2026-10-10T05:00:00Z', pinnedAt: null, groupId: null, archivedAt: null },
  messages: [{ id: `${id}-a`, role: 'assistant', parts: [{ type: 'text', text: 'Here it is.' }, card], createdAt: '2026-10-10T05:00:05Z' }],
})

const automation = (id: string, over: Partial<Automation> = {}): Automation => ({
  id,
  kind: 'watch',
  name: `Watch ${id}`,
  description: 'd',
  language: 'en',
  status: 'active',
  recipients: [],
  channels: { bell: true, chat: false },
  actions: { notify: true, followUp: null },
  creator: { id: 'u1', name: 'Mona Adel' },
  createdAt: '2026-10-10T05:00:00Z',
  updatedAt: '2026-10-10T05:00:00Z',
  nextRunAt: '2026-10-10T05:05:00Z',
  consecutiveFailures: 0,
  openFollowUps: 0,
  ...over,
})

describe('automations through the cache', () => {
  let qc: QueryClient

  beforeEach(() => {
    apiMock.mockReset()
    qc = new QueryClient()
    qc.setQueryData(keys.aiMessages('c1'), conversation('c1'))
    qc.setQueryData(keys.aiMessages('c2'), conversation('c2'))
    qc.setQueryData(automationKeys.list(null), [automation('a1'), automation('a2')])
    qc.setQueryData(keys.aiMe, { granted: true, owner: false, available: true, automations: true })
  })

  it('activating puts the card as it stands now in every conversation, and the automation on its page and in the lists', async () => {
    const activated: AiAutomationPart = { ...card, state: 'activated', automationId: 'a3' }
    apiMock.mockResolvedValueOnce({ automation: automation('a3'), part: activated })
    await activateProposal(qc, 'p1', { notifyExisting: true })
    expect(apiMock).toHaveBeenCalledWith('/ai/automation-proposals/p1/activate', { method: 'POST', body: { notifyExisting: true } })
    for (const id of ['c1', 'c2']) expect(qc.getQueryData<AiMessagesResponse>(keys.aiMessages(id))?.messages[0].parts[1]).toEqual(activated)
    expect(qc.getQueryData(automationKeys.one('a3'))).toMatchObject({ id: 'a3' })
    expect(qc.getQueryState(automationKeys.list(null))?.isInvalidated).toBe(true)
  })

  it('a refused activation changes nothing', async () => {
    apiMock.mockRejectedValueOnce(new ApiError(400, 'validation', 'recipients: name at least one person.'))
    await expect(activateProposal(qc, 'p1', {})).rejects.toThrow(/recipients/)
    expect(qc.getQueryData<AiMessagesResponse>(keys.aiMessages('c1'))?.messages[0].parts[1]).toBe(card)
    expect(qc.getQueryState(automationKeys.list(null))?.isInvalidated).toBe(false)
    expect(qc.getQueryState(keys.aiMessages('c1'))?.isInvalidated).toBe(false)
  })

  it('a card decided or replaced elsewhere has the conversations fetched again, and the refusal goes on to the card', async () => {
    apiMock.mockRejectedValueOnce(new ApiError(409, 'conflict', 'A newer version of this proposal was made below; activate that one.'))
    await expect(activateProposal(qc, 'p1', {})).rejects.toThrow(/newer version/)
    for (const id of ['c1', 'c2']) expect(qc.getQueryState(keys.aiMessages(id))?.isInvalidated).toBe(true)
    // Nothing is put in its place: the server's answer, fetched again, says how it stands.
    expect(qc.getQueryData<AiMessagesResponse>(keys.aiMessages('c1'))?.messages[0].parts[1]).toBe(card)
    expect(qc.getQueryState(automationKeys.list(null))?.isInvalidated).toBe(false)

    qc.setQueryData(keys.aiMessages('c1'), conversation('c1'))
    apiMock.mockRejectedValueOnce(new ApiError(409, 'conflict', 'This proposal was already activated.'))
    await expect(discardProposal(qc, 'p1')).rejects.toThrow(/already activated/)
    expect(qc.getQueryState(keys.aiMessages('c1'))?.isInvalidated).toBe(true)
  })

  it('discarding marks the card discarded wherever it is', async () => {
    apiMock.mockResolvedValueOnce({ part: { ...card, state: 'discarded' } })
    await discardProposal(qc, 'p1')
    expect(apiMock).toHaveBeenCalledWith('/ai/automation-proposals/p1/discard', { method: 'POST' })
    expect(qc.getQueryData<AiMessagesResponse>(keys.aiMessages('c2'))?.messages[0].parts[1]).toMatchObject({ state: 'discarded' })
  })

  it('a pause reaches the page and the lists at once; a deletion takes it out of them', async () => {
    apiMock.mockResolvedValueOnce(automation('a1', { status: 'paused', nextRunAt: null }))
    await pauseAutomation(qc, 'a1')
    expect(apiMock).toHaveBeenCalledWith('/automations/a1/pause', { method: 'POST' })
    expect(qc.getQueryData<Automation[]>(automationKeys.list(null))?.[0]).toMatchObject({ status: 'paused', nextRunAt: null })
    expect(qc.getQueryData(automationKeys.one('a1'))).toMatchObject({ status: 'paused' })

    apiMock.mockResolvedValueOnce(undefined)
    await deleteAutomation(qc, 'a1')
    expect(apiMock).toHaveBeenCalledWith('/automations/a1', { method: 'DELETE' })
    expect(qc.getQueryData<Automation[]>(automationKeys.list(null))?.map((a) => a.id)).toEqual(['a2'])
    expect(qc.getQueryData(automationKeys.one('a1'))).toBeUndefined()
  })

  it('a run, refused or not, has the page, its runs and the lists asked again', async () => {
    qc.setQueryData(automationKeys.one('a2'), automation('a2'))
    apiMock.mockRejectedValueOnce(new ApiError(429, 'rate_limited', 'It was run less than a minute ago.'))
    await expect(runAutomationNow(qc, 'a2')).rejects.toThrow(/minute/)
    expect(qc.getQueryState(automationKeys.one('a2'))?.isInvalidated).toBe(true)
    expect(qc.getQueryState(automationKeys.list(null))?.isInvalidated).toBe(true)
  })

  it('asks /ai/me again on a 404 only', () => {
    recheckAccessOn404(qc, new ApiError(409, 'conflict', 'busy'))
    expect(qc.getQueryState(keys.aiMe)?.isInvalidated).toBe(false)
    recheckAccessOn404(qc, new ApiError(404, 'not_found', 'No such endpoint.'))
    expect(qc.getQueryState(keys.aiMe)?.isInvalidated).toBe(true)
  })
})
