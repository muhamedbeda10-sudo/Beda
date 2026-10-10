// ============================================================================
// §21 — follow-ups through the API: the navigation badge's counts, the list
// page by page, one follow-up with its timeline, a session's open ones, the
// people one can be given to, and the writes behind its buttons (status,
// assignee, deadline, a comment).
// Each write puts what the server answered into every cached view of it,
// then refreshes what it may have moved: the lists' filters, the badge, and
// History's "Needs review" (a follow-up closed or reopened changes it).
//
// Who sees which is the server's to say: a follow-up someone may not see is
// "not found" to them, and "all" is everyone's only for those who may.
// ============================================================================

import { useMemo } from 'react'
import { keepPreviousData, useInfiniteQuery, useQuery, type InfiniteData, type QueryClient } from '@tanstack/react-query'
import type {
  AutomationsResponse,
  FollowUp,
  FollowUpCommentRequest,
  FollowUpCountsResponse,
  FollowUpDetail,
  FollowUpPeopleResponse,
  FollowUpsResponse,
  FollowUpUpdateRequest,
} from '@qc/shared/automation'
import { ApiError, api } from '@/lib/api'
import { followUpsQuery, type FollowUpFilters } from '@/components/followUps/wording'
import { keys, NOTICE_POLL_MS } from './queries'

export const followUpKeys = {
  /** Everything about follow-ups: the counts, the lists, each one. */
  all: ['follow-ups'] as const,
  counts: ['follow-ups', 'counts'] as const,
  lists: ['follow-ups', 'list'] as const,
  list: (f: FollowUpFilters) => ['follow-ups', 'list', f] as const,
  one: (id: string) => ['follow-ups', 'one', id] as const,
  /** A session's follow-ups not done yet, as its page lists them. */
  sessions: ['follow-ups', 'session'] as const,
  session: (sessionId: string, scope: FollowUpFilters['scope']) => ['follow-ups', 'session', sessionId, scope] as const,
  /** The people a follow-up can be given to. */
  people: ['follow-ups', 'people'] as const,
}

const path = (id: string) => `/follow-ups/${encodeURIComponent(id)}`

/** A "not found" is an answer, not a hiccup: no retry. */
const retryUnlessGone = (failures: number, error: unknown) => !(error instanceof ApiError && error.status === 404) && failures < 2

// ---- Reads -----------------------------------------------------------------------------

/** The navigation badge: whether the page is there for this person, and their open and overdue ones. Polled like the bell. */
export function useFollowUpCounts(enabled = true) {
  return useQuery({
    queryKey: followUpKeys.counts,
    queryFn: () => api<FollowUpCountsResponse>('/follow-ups/counts'),
    enabled,
    staleTime: 60_000,
    refetchInterval: NOTICE_POLL_MS,
    refetchIntervalInBackground: false,
  })
}

/** The list under the filters, overdue first then by deadline, 50 a page: "Load more" is fetchNextPage. */
export function useFollowUps(filters: FollowUpFilters, enabled = true) {
  return useInfiniteQuery({
    queryKey: followUpKeys.list(filters),
    queryFn: ({ pageParam }) => api<FollowUpsResponse>(`/follow-ups${followUpsQuery(filters, pageParam)}`),
    initialPageParam: null as string | null,
    getNextPageParam: (last: FollowUpsResponse) => (last.hasMore ? (last.followUps.at(-1)?.id ?? null) : null),
    enabled,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  })
}

/** One follow-up with its timeline. Kept fresh while open: someone else may comment or close it. */
export function useFollowUp(id: string | null) {
  return useQuery({
    queryKey: followUpKeys.one(id ?? ''),
    queryFn: () => api<FollowUpDetail>(path(id ?? '')),
    enabled: id !== null,
    staleTime: 15_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    retry: retryUnlessGone,
  })
}

/** A session's follow-ups that are not done — the ones the viewer may see (everyone's for those who see all). */
export function useSessionFollowUps(sessionId: string | null, scope: FollowUpFilters['scope'], enabled = true) {
  return useQuery({
    queryKey: followUpKeys.session(sessionId ?? '', scope),
    queryFn: () => api<FollowUpsResponse>(`/follow-ups${followUpsQuery({ scope, status: 'active', overdue: false, automationId: null, sessionId })}`),
    enabled: enabled && sessionId !== null,
    staleTime: 30_000,
  })
}

/**
 * The people a follow-up can be given to: every active account, viewers
 * included. Only those who may reassign one are answered (supervisors,
 * administrators, the assistant's owner, anyone who created an automation);
 * to anyone else it is "not found". So it is asked for only once a
 * follow-up offers to be reassigned.
 */
export function useAssignablePeople(enabled: boolean) {
  return useQuery({
    queryKey: followUpKeys.people,
    queryFn: async () => (await api<FollowUpPeopleResponse>('/follow-ups/people')).people,
    enabled,
    staleTime: 5 * 60_000,
    retry: retryUnlessGone,
  })
}

/**
 * The automations whose page this person may open — their own; the
 * assistant's owner, everyone's (they are told so by `owner` and need not
 * ask). The Automations page's list (services/automations.ts, the same key
 * and shape), read here without its module so the follow-ups stay out of
 * the assistant's chunks. Only for people who may create automations: to
 * anyone else the list does not exist. Null until it is known.
 */
export function useOwnAutomationIds(enabled: boolean): ReadonlySet<string> | null {
  const { data } = useQuery({
    queryKey: ['automations', 'list', ''] as const,
    queryFn: async () => (await api<AutomationsResponse>('/automations')).automations,
    enabled,
    staleTime: 60_000,
  })
  return useMemo(() => (enabled && data ? new Set(data.map((a) => a.id)) : null), [enabled, data])
}

// ---- Writes ------------------------------------------------------------------------------

/** A list row is the follow-up without its timeline. */
function rowOf(f: FollowUp | FollowUpDetail): FollowUp {
  const row: FollowUp & { events?: unknown } = { ...f }
  delete row.events
  return row
}

/** The follow-up as the server answered it, in place in every loaded page of a list (as a row: no timeline). */
export function withFollowUp(data: InfiniteData<FollowUpsResponse> | undefined, f: FollowUp | FollowUpDetail): InfiniteData<FollowUpsResponse> | undefined {
  if (!data || !data.pages.some((p) => p.followUps.some((x) => x.id === f.id))) return data
  const row = rowOf(f)
  return { ...data, pages: data.pages.map((p) => ({ ...p, followUps: p.followUps.map((x) => (x.id === f.id ? row : x)) })) }
}

function settle(qc: QueryClient, before: FollowUp | undefined, after: FollowUpDetail): FollowUpDetail {
  qc.setQueryData(followUpKeys.one(after.id), after)
  qc.setQueriesData<InfiniteData<FollowUpsResponse>>({ queryKey: followUpKeys.lists }, (old) => withFollowUp(old, after))
  // The lists' filters (status, overdue) and their order may no longer hold: they are asked again; so are the badge and the sessions' panels.
  void qc.invalidateQueries({ queryKey: followUpKeys.lists })
  void qc.invalidateQueries({ queryKey: followUpKeys.sessions })
  void qc.invalidateQueries({ queryKey: followUpKeys.counts })
  // History's "Needs review" follows a follow-up closed or reopened, or one whose session it is.
  const sessionId = after.sessionId ?? before?.sessionId
  if (sessionId && (before === undefined || (before.status === 'done') !== (after.status === 'done'))) {
    void qc.invalidateQueries({ queryKey: ['sessions', 'history'] })
    void qc.invalidateQueries({ queryKey: keys.session(sessionId), exact: true })
  }
  return after
}

/** A change of status, assignee or deadline; closing ('done') takes a closing note. */
export async function updateFollowUp(qc: QueryClient, id: string, body: FollowUpUpdateRequest): Promise<FollowUpDetail> {
  const before = qc.getQueryData<FollowUpDetail>(followUpKeys.one(id))
  return settle(qc, before, await api<FollowUpDetail>(path(id), { method: 'PATCH', body }))
}

export async function commentOnFollowUp(qc: QueryClient, id: string, body: FollowUpCommentRequest): Promise<FollowUpDetail> {
  const before = qc.getQueryData<FollowUpDetail>(followUpKeys.one(id))
  const after = await api<FollowUpDetail>(`${path(id)}/comments`, { method: 'POST', body })
  // A comment moves nothing History shows.
  return settle(qc, before ?? after, after)
}
