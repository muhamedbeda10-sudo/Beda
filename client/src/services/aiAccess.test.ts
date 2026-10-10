// ============================================================================
// §20 — who may use the assistant, through the cache: giving it, changing it
// and taking it away reach the owner's table at once, take the person off (or
// put them back on) the list of accounts to add, and make /ai/me be asked
// again — the owner's own access may be the one that changed.
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import type { AiAccess, AiAccessListResponse, AiAccessRequest } from '@qc/shared/ai'

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }))
vi.mock('@/lib/api', async () => ({ ...(await vi.importActual<typeof import('@/lib/api')>('@/lib/api')), api: apiMock }))

const { removeAiAccess, saveAiAccess, upsertAiAccess, withoutAiAccess } = await import('./mutations')
const { keys } = await import('./queries')

const access = (userId: string, over: Partial<AiAccess> = {}): AiAccess => ({
  userId,
  name: `Person ${userId}`,
  username: userId,
  role: 'inspector',
  active: true,
  enabled: true,
  domains: ['inspection'],
  model: 'claude-sonnet-5-5',
  effort: 'medium',
  monthlyCapUsd: 10,
  spentUsd: 0,
  owner: false,
  automations: false,
  notices: false,
  ...over,
})

const list: AiAccessListResponse = { people: [access('a'), access('b')] }

describe('the access list as cached', () => {
  it('replaces a person’s row in place, or adds it at the end', () => {
    const changed = access('b', { effort: 'high' })
    expect(upsertAiAccess(list, changed)?.people).toEqual([list.people[0], changed])
    const added = access('c')
    expect(upsertAiAccess(list, added)?.people.map((p) => p.userId)).toEqual(['a', 'b', 'c'])
    expect(upsertAiAccess(undefined, added)).toBeUndefined()
  })

  it('takes a person out, and leaves the list as it was when they are not in it', () => {
    expect(withoutAiAccess(list, 'a')?.people.map((p) => p.userId)).toEqual(['b'])
    expect(withoutAiAccess(list, 'z')).toBe(list)
    expect(withoutAiAccess(undefined, 'a')).toBeUndefined()
  })
})

describe('giving, changing and taking away the assistant', () => {
  let qc: QueryClient
  const body: AiAccessRequest = { enabled: true, domains: ['inspection', 'orders'], model: 'claude-haiku-5-5', effort: 'low', monthlyCapUsd: 5 }

  beforeEach(() => {
    apiMock.mockReset()
    qc = new QueryClient()
    qc.setQueryData(keys.aiAccess, list)
    qc.setQueryData(keys.aiPeople, [{ id: 'c', name: 'Person c', username: 'c', role: 'viewer' }])
    qc.setQueryData(keys.aiMe, { granted: true, owner: true, available: true })
  })

  it('saving puts the server’s row in the table and asks again who is left to add and what the owner may do', async () => {
    const saved = access('c', { domains: ['inspection', 'orders'], model: 'claude-haiku-5-5', effort: 'low', monthlyCapUsd: 5 })
    apiMock.mockResolvedValueOnce(saved)
    expect(await saveAiAccess(qc, 'c', body)).toBe(saved)
    expect(apiMock).toHaveBeenCalledWith('/ai/access/c', { method: 'PUT', body })
    expect(qc.getQueryData<AiAccessListResponse>(keys.aiAccess)?.people.at(-1)).toEqual(saved)
    expect(qc.getQueryState(keys.aiPeople)?.isInvalidated).toBe(true)
    expect(qc.getQueryState(keys.aiMe)?.isInvalidated).toBe(true)
  })

  it('a refused save changes nothing', async () => {
    apiMock.mockRejectedValueOnce(new Error('Choose at least one kind of data.'))
    await expect(saveAiAccess(qc, 'c', { ...body, domains: [] })).rejects.toThrow(/data/)
    expect(qc.getQueryData(keys.aiAccess)).toBe(list)
    expect(qc.getQueryState(keys.aiMe)?.isInvalidated).toBe(false)
  })

  it('removing takes the row out of the table at once', async () => {
    apiMock.mockResolvedValueOnce(undefined)
    await removeAiAccess(qc, 'a')
    expect(apiMock).toHaveBeenCalledWith('/ai/access/a', { method: 'DELETE' })
    expect(qc.getQueryData<AiAccessListResponse>(keys.aiAccess)?.people.map((p) => p.userId)).toEqual(['b'])
    expect(qc.getQueryState(keys.aiPeople)?.isInvalidated).toBe(true)
    expect(qc.getQueryState(keys.aiMe)?.isInvalidated).toBe(true)
  })
})
