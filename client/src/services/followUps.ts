// ============================================================================
// §21 — follow-ups through the API: the navigation badge's counts, the list
// page by page, one follow-up with its timeline, a session's open ones, and
// the writes behind its buttons (status, assignee, deadline, a comment).
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
  AutomationPeopleResponse,
  AutomationsResponse,
  FollowUp,
  FollowUpCommentRequest,
  FollowUpCountsResponse,
  FollowUpDetail,
  FollowUpsResponse,
  FollowUpUpdateRequest,
} from '@qc/shared/automation'
import type { ChatUser, Role, UserProfile } from '@qc/shared/types'
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

/** Someone a follow-up can be given to. */
export interface AssignablePerson {
  id: string
  name: string
  role: Role
}

/**
 * The people a follow-up can be reassigned to, from the list this person may
 * read: every active account for someone who may create automations (their
 * recipients' list), every account for an administrator, the chat's people
 * for a supervisor (viewers are not in the chat, so not offered there).
 */
export function useAssignablePeople(source: 'automations' | 'users' | 'chat' | null) {
  // The Automations page's list of people (services/automations.ts, the same key), read here without its module.
  const automations = useQuery({
    queryKey: ['automations', 'people'] as const,
    queryFn: () => api<AutomationPeopleResponse>('/automations/people'),
    enabled: source === 'automations',
    staleTime: 5 * 60_000,
  })
  const users = useQuery({ queryKey: keys.users, queryFn: () => api<UserProfile[]>('/users'), enabled: source === 'users', staleTime: 5 * 60_000 })
  const chat = useQuery({ queryKey: keys.chatUsers, queryFn: () => api<ChatUser[]>('/chat/users'), enabled: source === 'chat', staleTime: 5 * 60_000 })
  const people: AssignablePerson[] =
    source === 'automations'
      ? (automations.data?.people ?? []).map(({ id, name, role }) => ({ id, name, role }))
      : source === 'users'
        ? (users.data ?? []).filter((u) => u.isActive).map(({ id, name, role }) => ({ id, name, role }))
        : source === 'chat'
          ? (chat.data ?? []).map(({ id, name, role }) => ({ id, name, role }))
          : []
  const current = source === 'automations' ? automations : source === 'users' ? users : chat
  return { people: [...people].sort((a, b) => a.name.localeCompare(b.name)), isLoading: source !== null && current.isLoading, isError: source !== null && current.isError }
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
