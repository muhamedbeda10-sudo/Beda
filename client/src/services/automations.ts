// ============================================================================
// §21 — automations through the API: the reads the Automations page, an
// automation's page and a delivered report show, and the writes behind
// their buttons and the proposal card's. Each write puts what the server
// answered into the cache, so every screen showing it follows at once —
// the card in the conversation included, wherever the conversation is open.
//
// The Automations routes exist only for people who may create automations;
// to anyone else they answer 404 (a delivered report answers its recipients
// too). A 404 may be the first sign the permission was withdrawn, so /ai/me
// is asked again then and the routes' guard follows what it says.
// ============================================================================

import { keepPreviousData, useInfiniteQuery, useQuery, type QueryClient } from '@tanstack/react-query'
import type { AiMessagesResponse } from '@qc/shared/ai'
import type {
  AiAutomationPart,
  Automation,
  AutomationActivateRequest,
  AutomationActivateResponse,
  AutomationDelivery,
  AutomationDiscardResponse,
  AutomationEdits,
  AutomationPeopleResponse,
  AutomationRun,
  AutomationRunsResponse,
  AutomationsResponse,
  AutomationTestResponse,
} from '@qc/shared/automation'
import { ApiError, api, qs } from '@/lib/api'
import { replaceAutomationPart } from '@/components/automations/wording'
import { keys } from './queries'

export const automationKeys = {
  /** Everything about automations: the lists, each one, its runs. */
  all: ['automations'] as const,
  /** The list as one creator's (the owner's filter), or everyone's the viewer may see (''). */
  list: (creator: string | null) => ['automations', 'list', creator ?? ''] as const,
  lists: ['automations', 'list'] as const,
  people: ['automations', 'people'] as const,
  one: (id: string) => ['automations', 'one', id] as const,
  runs: (id: string) => ['automations', 'runs', id] as const,
  delivery: (id: string) => ['automations', 'delivery', id] as const,
}

const path = (id: string) => `/automations/${encodeURIComponent(id)}`

/** A refusal that may mean the permission was withdrawn: /ai/me is asked again, and the pages' guard follows it. */
export function recheckAccessOn404(qc: QueryClient, error: unknown): void {
  if (error instanceof ApiError && error.status === 404) void qc.invalidateQueries({ queryKey: keys.aiMe })
}

// ---- Reads -----------------------------------------------------------------------------

/** The automations the viewer may see: their own, or (the owner) everyone's — one person's with `creator`. */
export function useAutomations(creator: string | null, enabled = true) {
  return useQuery({
    queryKey: automationKeys.list(creator),
    queryFn: async () => (await api<AutomationsResponse>(`/automations${qs({ creator })}`)).automations,
    enabled,
    staleTime: 30_000,
    // Next runs and last runs move on their own: kept fresh while the page is open.
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  })
}

/** One automation, with its state worked out afresh (blocked or not, its next run). */
export function useAutomation(id: string | null) {
  return useQuery({
    queryKey: automationKeys.one(id ?? ''),
    queryFn: () => api<Automation>(path(id ?? '')),
    enabled: id !== null,
    staleTime: 30_000,
    refetchInterval: 60_000,
  })
}

/** Its runs, newest first, a page (30) at a time: "Show older runs" is fetchNextPage. */
export function useAutomationRuns(id: string | null) {
  return useInfiniteQuery({
    queryKey: automationKeys.runs(id ?? ''),
    queryFn: ({ pageParam }) => api<AutomationRunsResponse>(`${path(id ?? '')}/runs${qs({ before: pageParam })}`),
    initialPageParam: null as string | null,
    getNextPageParam: (last: AutomationRunsResponse) => (last.hasMore ? (last.runs.at(-1)?.id ?? null) : null),
    enabled: id !== null,
    staleTime: 30_000,
    refetchInterval: 60_000,
  })
}

/** Whom an automation can tell: every active account, and the roles. */
export function useAutomationPeople(enabled = true) {
  return useQuery({ queryKey: automationKeys.people, queryFn: () => api<AutomationPeopleResponse>('/automations/people'), enabled, staleTime: 5 * 60_000 })
}

/** A scheduled report as it was delivered: its summary and sections as they ran. Never changes once delivered. */
export function useAutomationDelivery(id: string | null) {
  return useQuery({
    queryKey: automationKeys.delivery(id ?? ''),
    queryFn: () => api<AutomationDelivery>(`/automations/deliveries/${encodeURIComponent(id ?? '')}`),
    enabled: id !== null,
    staleTime: Infinity,
    retry: (failures, error) => !(error instanceof ApiError && error.status === 404) && failures < 2,
  })
}

// ---- The proposal card ---------------------------------------------------------------------

/** The card as it stands now, in every cached conversation that holds it. */
function settleProposal(qc: QueryClient, part: AiAutomationPart): void {
  qc.setQueriesData<AiMessagesResponse>({ queryKey: ['ai', 'messages'] }, (old) => replaceAutomationPart(old, part))
}

/** Activate a proposal (the person who asked for it only), with the changes made on its card. */
export async function activateProposal(qc: QueryClient, proposalId: string, body: AutomationActivateRequest): Promise<AutomationActivateResponse> {
  const res = await api<AutomationActivateResponse>(`/ai/automation-proposals/${encodeURIComponent(proposalId)}/activate`, { method: 'POST', body })
  settleProposal(qc, res.part)
  qc.setQueryData(automationKeys.one(res.automation.id), res.automation)
  void qc.invalidateQueries({ queryKey: automationKeys.lists })
  // A change of an existing automation keeps its runs; a new one has none yet.
  void qc.invalidateQueries({ queryKey: automationKeys.runs(res.automation.id) })
  return res
}

export async function discardProposal(qc: QueryClient, proposalId: string): Promise<AutomationDiscardResponse> {
  const res = await api<AutomationDiscardResponse>(`/ai/automation-proposals/${encodeURIComponent(proposalId)}/discard`, { method: 'POST' })
  settleProposal(qc, res.part)
  return res
}

// ---- An automation -----------------------------------------------------------------------

/** One automation as the server answered it, into its page and every list. */
function settleAutomation(qc: QueryClient, a: Automation): Automation {
  qc.setQueryData(automationKeys.one(a.id), a)
  qc.setQueriesData<Automation[]>({ queryKey: automationKeys.lists }, (old) => old?.map((x) => (x.id === a.id ? a : x)))
  return a
}

export async function updateAutomation(qc: QueryClient, id: string, edits: AutomationEdits): Promise<Automation> {
  return settleAutomation(qc, await api<Automation>(path(id), { method: 'PATCH', body: edits }))
}

export async function pauseAutomation(qc: QueryClient, id: string): Promise<Automation> {
  return settleAutomation(qc, await api<Automation>(`${path(id)}/pause`, { method: 'POST' }))
}

/** On again; a stopped (failed) one starts over with its failures forgotten. */
export async function resumeAutomation(qc: QueryClient, id: string): Promise<Automation> {
  return settleAutomation(qc, await api<Automation>(`${path(id)}/resume`, { method: 'POST' }))
}

/** Removed from the lists for good; its follow-ups and the reports it delivered stay. */
export async function deleteAutomation(qc: QueryClient, id: string): Promise<void> {
  await api<void>(path(id), { method: 'DELETE' })
  qc.setQueriesData<Automation[]>({ queryKey: automationKeys.lists }, (old) => old?.filter((x) => x.id !== id))
  qc.removeQueries({ queryKey: automationKeys.one(id) })
  qc.removeQueries({ queryKey: automationKeys.runs(id) })
  void qc.invalidateQueries({ queryKey: automationKeys.lists })
}

/** A real run, now: it tells people and is recorded. Its page and the lists follow (last run, next run, follow-ups). */
export async function runAutomationNow(qc: QueryClient, id: string): Promise<AutomationRun> {
  try {
    return await api<AutomationRun>(`${path(id)}/run`, { method: 'POST' })
  } finally {
    void qc.invalidateQueries({ queryKey: automationKeys.runs(id) })
    void qc.invalidateQueries({ queryKey: automationKeys.one(id) })
    void qc.invalidateQueries({ queryKey: automationKeys.lists })
  }
}

/** A dry run: what it would find and whom it would tell now. Nothing is sent or recorded, so nothing cached moves. */
export function testAutomation(id: string): Promise<AutomationTestResponse> {
  return api<AutomationTestResponse>(`${path(id)}/test`, { method: 'POST' })
}
