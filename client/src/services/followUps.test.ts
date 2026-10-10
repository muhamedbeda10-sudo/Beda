// ============================================================================
// §21 — a follow-up changed in its drawer shows changed everywhere at once:
// in its own cache, in every list page that holds it, on the navigation's
// badge — and in History's "Needs review" when it is closed or reopened.
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, type InfiniteData } from '@tanstack/react-query'
import type { FollowUp, FollowUpDetail, FollowUpsResponse } from '@qc/shared/automation'

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }))
vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: apiMock }))

const { commentOnFollowUp, followUpKeys, updateFollowUp, withFollowUp } = await import('./followUps')

const followUp = (over: Partial<FollowUp> = {}): FollowUp => ({
  id: 'f1',
  automationId: 'a1',
  automationName: 'Line 3 rejects',
  caseKey: 'k1',
  title: 'Sample 2009-1 failed',
  body: '',
  status: 'open',
  assignee: { id: 'u1', name: 'Mona' },
  dueAt: '2026-10-11T08:00:00.000Z',
  overdue: false,
  sessionId: 's1',
  caseColumns: ['sample'],
  caseRow: ['2009-1'],
  createdAt: '2026-10-10T08:00:00.000Z',
  updatedAt: '2026-10-10T08:00:00.000Z',
  commentCount: 0,
  canEdit: true,
  canReassign: false,
  ...over,
})

const detail = (over: Partial<FollowUp> = {}): FollowUpDetail => ({ ...followUp(over), events: [] })

const list = (...pages: FollowUp[][]): InfiniteData<FollowUpsResponse> => ({
  pages: pages.map((followUps, i) => ({ followUps, hasMore: i < pages.length - 1 })),
  pageParams: pages.map((_, i) => (i === 0 ? null : `p${i}`)),
})

describe('a follow-up in the lists', () => {
  it('replaces its row in whichever page holds it, as a row without its timeline', () => {
    const other = followUp({ id: 'f2' })
    const data = list([other], [followUp()])
    const next = withFollowUp(data, detail({ status: 'in_progress' }))
    expect(next?.pages[1].followUps[0].status).toBe('in_progress')
    expect(next?.pages[1].followUps[0]).not.toHaveProperty('events')
    expect(next?.pages[0].followUps[0]).toBe(other)
  })

  it('leaves a list that does not hold it untouched', () => {
    const data = list([followUp({ id: 'f2' })])
    expect(withFollowUp(data, followUp())).toBe(data)
    expect(withFollowUp(undefined, followUp())).toBeUndefined()
  })
})

describe('a change to a follow-up', () => {
  let qc: QueryClient
  let invalidated: string[]

  beforeEach(() => {
    apiMock.mockReset()
    qc = new QueryClient()
    invalidated = []
    qc.invalidateQueries = vi.fn(async (filters?: { queryKey?: readonly unknown[]; exact?: boolean }) => {
      invalidated.push(JSON.stringify(filters?.queryKey ?? []))
    }) as unknown as QueryClient['invalidateQueries']
  })

  it('patches it, puts the answer in its cache and the lists, and asks the lists and the badge again', async () => {
    qc.setQueryData(followUpKeys.one('f1'), detail())
    const filters = { scope: 'mine', status: 'active', overdue: false, automationId: null } as const
    qc.setQueryData(followUpKeys.list(filters), list([followUp()]))
    apiMock.mockResolvedValue(detail({ status: 'in_progress' }))

    await updateFollowUp(qc, 'f1', { status: 'in_progress' })

    expect(apiMock).toHaveBeenCalledWith('/follow-ups/f1', { method: 'PATCH', body: { status: 'in_progress' } })
    expect(qc.getQueryData<FollowUpDetail>(followUpKeys.one('f1'))?.status).toBe('in_progress')
    expect(qc.getQueryData<InfiniteData<FollowUpsResponse>>(followUpKeys.list(filters))?.pages[0].followUps[0].status).toBe('in_progress')
    expect(invalidated).toEqual(expect.arrayContaining([JSON.stringify(followUpKeys.lists), JSON.stringify(followUpKeys.sessions), JSON.stringify(followUpKeys.counts)]))
    // Still not done: History's mark has not moved.
    expect(invalidated).not.toContain(JSON.stringify(['sessions', 'history']))
  })

  it('refreshes History’s "Needs review" when it is closed', async () => {
    qc.setQueryData(followUpKeys.one('f1'), detail({ status: 'in_progress' }))
    apiMock.mockResolvedValue(detail({ status: 'done', closingNote: 'Recalibrated the gauge.' }))
    await updateFollowUp(qc, 'f1', { status: 'done', closingNote: 'Recalibrated the gauge.' })
    expect(invalidated).toEqual(expect.arrayContaining([JSON.stringify(['sessions', 'history']), JSON.stringify(['sessions', 's1'])]))
  })

  it('…and when it is reopened', async () => {
    qc.setQueryData(followUpKeys.one('f1'), detail({ status: 'done' }))
    apiMock.mockResolvedValue(detail({ status: 'open' }))
    await updateFollowUp(qc, 'f1', { status: 'open' })
    expect(invalidated).toContain(JSON.stringify(['sessions', 'history']))
  })

  it('posts a comment and leaves History alone', async () => {
    qc.setQueryData(followUpKeys.one('f1'), detail())
    apiMock.mockResolvedValue(detail({ commentCount: 1 }))
    const after = await commentOnFollowUp(qc, 'f1', { body: 'On it.' })
    expect(apiMock).toHaveBeenCalledWith('/follow-ups/f1/comments', { method: 'POST', body: { body: 'On it.' } })
    expect(after.commentCount).toBe(1)
    expect(invalidated).not.toContain(JSON.stringify(['sessions', 'history']))
  })

  it('passes a refusal on, with nothing cached changed', async () => {
    qc.setQueryData(followUpKeys.one('f1'), detail())
    apiMock.mockRejectedValue(new Error('Write a closing note to close the follow-up.'))
    await expect(updateFollowUp(qc, 'f1', { status: 'done' })).rejects.toThrow('closing note')
    expect(qc.getQueryData<FollowUpDetail>(followUpKeys.one('f1'))?.status).toBe('open')
  })
})
