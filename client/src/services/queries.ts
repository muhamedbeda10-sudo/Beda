// ============================================================================
// Read hooks — one per thing a screen shows. Each wraps an API call in React
// Query, so the screen gets caching, focus re-fetch and a loading flag, and
// the write functions in ./mutations invalidate by key so screens refresh
// after a save.
//
// Every read here is bounded the way the Firestore version was: a prefix
// search, a lookup by id, or a capped page. Nothing loads a whole table.
// ============================================================================

import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import type {
  AuditFilters,
  AuditListResponse,
  AuditOptionsResponse,
  AuditStats,
  CoilUsage,
  HistoryFilters,
  HistoryOptionsResponse,
  HistoryResponse,
  MasterKind,
  MasterListQuery,
  MasterRecordByKind,
  OpenSessionsResponse,
  OrderHistory,
  OrderNumberSummary,
  PDIWithOrder,
  SampleDetail,
  SampleSummary,
  SessionWithOrder,
  StartSessionRequest,
  WizardContext,
  SessionNotesResponse,
  SessionDefectsResponse,
  KpiSpanResponse,
  KpiThresholdsResponse,
  NoticeInboxResponse,
  ChatConversationsResponse,
  ChatMessagesResponse,
  ChatUnreadResponse,
} from '@qc/shared/api'
import type { KpiBreakdown, KpiBreakdownFilters, KpiFilters, KpiGeneral, KpiOverview, KpiRange } from '@qc/shared/kpi'
import type { HiddenInsightsResponse, OrderListFilters, OrderListOptionsResponse, OrderListResponse, ReleaseStateResponse, SessionImagesResponse } from '@qc/shared/api'
import type { ChatUser, Coil, ImageAsset, NoticeAcknowledgement, NoticeAdminRow, ProductionOrder, UserProfile, WorkInstruction, WorkInstructionScope } from '@qc/shared/types'
import { api, qs } from '@/lib/api'

export const keys = {
  openBoard: ['sessions', 'open'] as const,
  history: (filters: HistoryFilters) => ['sessions', 'history', filters] as const,
  historyOptions: ['sessions', 'history', 'options'] as const,
  session: (id: string) => ['sessions', id] as const,
  wizard: (id: string) => ['sessions', id, 'wizard'] as const,
  wizardPreview: (key: string) => ['sessions', 'preview', key] as const,
  sessionSamples: (id: string) => ['sessions', id, 'samples'] as const,
  sessionNotes: (id: string) => ['sessions', id, 'notes'] as const,
  sessionDefects: (id: string) => ['sessions', id, 'defects'] as const,
  sample: (id: string) => ['samples', id] as const,
  orderSearch: (term: string) => ['orders', 'search', term] as const,
  orderNumbers: (key: string) => ['orders', 'numbers', key] as const,
  orderLines: (key: string) => ['orders', 'lines', key] as const,
  orderHistory: (id: string) => ['orders', id, 'history'] as const,
  order: (id: string) => ['orders', id] as const,
  orderNotes: (id: string) => ['orders', id, 'notes'] as const,
  coilSearch: (term: string) => ['coils', 'search', term] as const,
  coilUsage: (numbers: string) => ['coils', 'usage', numbers] as const,
  images: (ids: string) => ['images', ids] as const,
  master: (kind: MasterKind, filters?: MasterListQuery) => ['master', kind, filters ?? {}] as const,
  pdi: ['pdi'] as const,
  audit: (filters: AuditFilters) => ['audit', 'list', filters] as const,
  auditOptions: ['audit', 'options'] as const,
  auditStats: ['audit', 'stats'] as const,
  users: ['users'] as const,
  workInstructions: (process?: string, history?: boolean) => ['work-instructions', process ?? 'all', history ? 'history' : 'in-force'] as const,
  kpiOverview: (filters: KpiFilters) => ['kpi', 'overview', filters] as const,
  kpiThresholds: ['kpi', 'thresholds'] as const,
  kpiSpan: ['kpi', 'span'] as const,
  kpiGeneral: (range: KpiRange) => ['kpi', 'general', range] as const,
  kpiBreakdown: (filters: KpiBreakdownFilters) => ['kpi', 'breakdown', filters] as const,
  hiddenInsights: ['kpi', 'insights', 'hidden'] as const,
  noticeInbox: ['notices', 'inbox'] as const,
  noticesAdmin: ['notices', 'admin'] as const,
  noticeAcks: (id: string) => ['notices', id, 'acknowledgements'] as const,
  chatUnread: ['chat', 'unread'] as const,
  chatConversations: ['chat', 'conversations'] as const,
  chatMessages: (id: string) => ['chat', 'messages', id] as const,
  chatUsers: ['chat', 'users'] as const,
  releaseState: ['releases', 'state'] as const,
  orderList: (filters: OrderListFilters) => ['orders', 'list', filters] as const,
  sessionImages: (id: string) => ['sessions', id, 'images'] as const,
  orderListOptions: ['orders', 'list', 'options'] as const,
}

/** A value that settles `ms` after it stops changing, so typing an
 *  eight-character order number costs one query, not eight. */
export function useDebounced<T>(value: T, ms = 300): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return settled
}

// ---- Sessions --------------------------------------------------------------

export function useOpenBoard() {
  return useQuery({ queryKey: keys.openBoard, queryFn: () => api<OpenSessionsResponse>('/sessions/open'), refetchInterval: 60_000 })
}

/** §6 — a first page of the sessions the filters match. The filters go to the
 *  API, not to the page in hand, so nothing matching is left behind. */
export function useHistory(filters: HistoryFilters, limit = 100) {
  return useQuery({
    queryKey: keys.history(filters),
    queryFn: () => api<HistoryResponse>(`/sessions/history${qs({ limit, ...filters })}`),
    // The list stays put while a new search settles, instead of blinking empty.
    placeholderData: keepPreviousData,
  })
}

/** §6 — the next page: the same filters, walked back past `before`. */
export async function loadOlderSessions(filters: HistoryFilters, before: string, limit = 100): Promise<HistoryResponse> {
  return api<HistoryResponse>(`/sessions/history${qs({ limit, ...filters, before })}`)
}

/** §6 — every inspector and machine in the record, for the History filters. */
export function useHistoryOptions() {
  return useQuery({ queryKey: keys.historyOptions, queryFn: () => api<HistoryOptionsResponse>('/sessions/history/options'), staleTime: 5 * 60_000 })
}

export function useSession(id: string | null) {
  return useQuery({ queryKey: keys.session(id ?? ''), queryFn: () => api<SessionWithOrder>(`/sessions/${id}`), enabled: !!id })
}

export function useWizardContext(sessionId: string) {
  return useQuery({
    queryKey: keys.wizard(sessionId),
    queryFn: () => api<WizardContext>(`/sessions/${sessionId}/wizard`),
    enabled: !!sessionId,
    staleTime: 60_000,
    // A draft is built from this once; it must be what the server knows now.
    refetchOnMount: 'always',
  })
}

/** The wizard's context for a line before its session exists (§4.4): the session is created with the first sample. */
export function useWizardPreview(start: StartSessionRequest | null) {
  const key = start ? ('orderId' in start ? `order:${start.orderId}` : `stock:${start.workCenterCode}`) : ''
  return useQuery({
    queryKey: keys.wizardPreview(key),
    queryFn: () => api<WizardContext>(`/sessions/preview${qs({ ...start })}`),
    enabled: start !== null,
    staleTime: 60_000,
    refetchOnMount: 'always',
  })
}

export function useSessionSamples(sessionId: string | null) {
  return useQuery({
    queryKey: keys.sessionSamples(sessionId ?? ''),
    queryFn: () => api<SampleSummary[]>(`/sessions/${sessionId}/samples`),
    enabled: !!sessionId,
  })
}

/** §7 — a session's defects with their samples, for deciding Holds from the board. */
export function useSessionDefects(sessionId: string | null) {
  return useQuery({
    queryKey: keys.sessionDefects(sessionId ?? ''),
    queryFn: () => api<SessionDefectsResponse>(`/samples/defects${qs({ sessionId })}`),
    enabled: !!sessionId,
  })
}

export function useSessionNotes(sessionId: string | null) {
  return useQuery({
    queryKey: keys.sessionNotes(sessionId ?? ''),
    queryFn: async () => (await api<SessionNotesResponse>(`/sessions/${sessionId}/notes`)).notes,
    enabled: !!sessionId,
  })
}

export function useSampleDetail(sampleId: string | null) {
  return useQuery({ queryKey: keys.sample(sampleId ?? ''), queryFn: () => api<SampleDetail>(`/samples/${sampleId}`), enabled: !!sampleId })
}

// ---- Orders & coils --------------------------------------------------------

export function useOrderSearch(term: string, limit = 40, enabled = true) {
  const t = useDebounced(term.trim())
  return useQuery({
    queryKey: keys.orderSearch(`${t}|${limit}`),
    queryFn: () => api<ProductionOrder[]>(`/orders${qs({ search: t, limit })}`),
    enabled,
    placeholderData: keepPreviousData,
  })
}

/**
 * The order numbers that have lines on a machine, prefix-searched — step two
 * of the new-inspection screen. Nothing is fetched until a machine is chosen.
 */
export function useOrderNumbers(machine: string, term: string, limit = 40, enabled = true) {
  const t = useDebounced(term.trim())
  return useQuery({
    queryKey: keys.orderNumbers(`${machine}|${t}|${limit}`),
    queryFn: () => api<OrderNumberSummary[]>(`/orders/numbers${qs({ machine, search: t, limit })}`),
    enabled: enabled && machine !== '',
    placeholderData: keepPreviousData,
  })
}

/** The lines (items) of one order on one machine — step three. An order can
 *  have well over a hundred items on one machine, so the whole set is asked
 *  for and narrowed on the screen. */
export function useOrderLines(machine: string, orderNumber: string, enabled = true) {
  return useQuery({
    queryKey: keys.orderLines(`${machine}|${orderNumber}`),
    queryFn: () => api<ProductionOrder[]>(`/orders${qs({ machine, orderNumber, limit: 500 })}`),
    enabled: enabled && machine !== '' && orderNumber !== '',
  })
}

/** One order line in full — everything the ERP export carried for it. */
export function useOrder(orderId: string | null) {
  return useQuery({ queryKey: keys.order(orderId ?? ''), queryFn: () => api<ProductionOrder>(`/orders/${orderId}`), enabled: !!orderId })
}

/** Notes written about an order on any of its lines, newest first. */
export function useOrderNotes(orderId: string | null) {
  return useQuery({
    queryKey: keys.orderNotes(orderId ?? ''),
    queryFn: async () => (await api<SessionNotesResponse>(`/orders/${orderId}/notes`)).notes,
    enabled: !!orderId,
  })
}

export function useOrderHistory(orderId: string | null) {
  return useQuery({ queryKey: keys.orderHistory(orderId ?? ''), queryFn: () => api<OrderHistory>(`/orders/${orderId}/history`), enabled: !!orderId })
}

export function useCoilSearch(term: string, limit = 25) {
  const t = useDebounced(term.trim())
  return useQuery({
    queryKey: keys.coilSearch(`${t}|${limit}`),
    queryFn: () => api<Coil[]>(`/coils${qs({ search: t, limit })}`),
    placeholderData: keepPreviousData,
  })
}

export function useCoilUsage(coilNumbers: string[]) {
  const key = Array.from(new Set(coilNumbers)).sort().join(',')
  return useQuery({
    queryKey: keys.coilUsage(key),
    queryFn: () => api<CoilUsage[]>(`/coils/usage${qs({ coilNumbers: key })}`),
    enabled: key.length > 0,
  })
}

// ---- Images ----------------------------------------------------------------

/** Metadata (including thumbnails) for the photos a record references. */
export function useImages(ids: string[]) {
  const key = Array.from(new Set(ids.filter(Boolean))).sort().join(',')
  return useQuery({
    queryKey: keys.images(key),
    queryFn: () => api<ImageAsset[]>(`/images${qs({ ids: key })}`),
    enabled: key.length > 0,
    // Metadata and thumbnails never change once stored; an hour keeps a
    // History session from re-asking for the same thumbnails on every open.
    staleTime: 60 * 60_000,
  })
}

// ---- Master data -----------------------------------------------------------

export function useMaster<K extends MasterKind>(kind: K, filters?: MasterListQuery, enabled = true) {
  return useQuery({
    queryKey: keys.master(kind, filters),
    queryFn: () => api<MasterRecordByKind[K][]>(`/master/${kind}${qs({ ...filters })}`),
    enabled,
    staleTime: 60_000,
  })
}

// ---- PDI, audit, users -----------------------------------------------------

export function usePdiList(limit = 50) {
  return useQuery({ queryKey: keys.pdi, queryFn: () => api<PDIWithOrder[]>(`/pdi${qs({ limit })}`) })
}

/** §11 — a first page of the log entries the filters match, counted over the
 *  whole log. The filters are answered in SQL, never by sifting this page. */
export function useAuditList(filters: AuditFilters, limit = 200) {
  return useQuery({
    queryKey: keys.audit(filters),
    queryFn: () => api<AuditListResponse>(`/audit${qs({ limit, ...filters })}`),
    placeholderData: keepPreviousData,
  })
}

/** §11 — the next page: the same filters, walked back past one entry. */
export async function loadOlderAudit(filters: AuditFilters, before: string, beforeId: string, limit = 200): Promise<AuditListResponse> {
  return api<AuditListResponse>(`/audit${qs({ limit, ...filters, before, beforeId })}`)
}

/** §11 — every entry the filters match, up to `limit`, for the CSV export. */
export async function loadAuditMatches(filters: AuditFilters, limit = 2000): Promise<AuditListResponse> {
  return api<AuditListResponse>(`/audit${qs({ limit, ...filters })}`)
}

/** §11 — every user and entity in the log, for the audit filters. */
export function useAuditOptions() {
  return useQuery({ queryKey: keys.auditOptions, queryFn: () => api<AuditOptionsResponse>('/audit/options'), staleTime: 5 * 60_000 })
}

export function useAuditStats() {
  return useQuery({ queryKey: keys.auditStats, queryFn: () => api<AuditStats>('/audit/stats') })
}

/** The documents in force for a process (or every document), oldest issue last. */
export function useWorkInstructions(process?: WorkInstructionScope, history = false, enabled = true) {
  return useQuery({
    queryKey: keys.workInstructions(process, history),
    queryFn: () =>
      api<WorkInstruction[]>(`/work-instructions${qs({ process: process && process !== 'all' ? process : undefined, history: history ? '1' : undefined })}`),
    enabled,
    staleTime: 60_000,
  })
}

export function useUsers() {
  return useQuery({ queryKey: keys.users, queryFn: () => api<UserProfile[]>('/users') })
}

// ---- §15 Dashboard ---------------------------------------------------------

/** The whole overview for a period and its comparison; kept for a few minutes so
 *  switching a tab and back does not re-run every query on the free tier. */
export function useKpiOverview(filters: KpiFilters | null) {
  return useQuery({
    queryKey: keys.kpiOverview(filters ?? ({} as KpiFilters)),
    queryFn: () => api<KpiOverview>(`/kpi/overview${qs({ ...filters, factories: undefined, processes: undefined, workCenterCodes: undefined, factory: filters?.factories?.join(','), process: filters?.processes?.join(','), workCenterCode: filters?.workCenterCodes?.join(',') })}`),
    enabled: filters !== null,
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
  })
}

/** Where the period strip begins: the first day anything was recorded. */
/** §15 — the drill-down of the general page: a factory, a process or a few machines, month by month. */
export function useKpiBreakdown(filters: KpiBreakdownFilters | null) {
  return useQuery({
    queryKey: keys.kpiBreakdown(filters ?? ({} as KpiBreakdownFilters)),
    queryFn: () => api<KpiBreakdown>(`/kpi/breakdown${qs({ from: filters?.from, to: filters?.to, itemCode: filters?.itemCode, factory: filters?.factories?.join(','), process: filters?.processes?.join(','), workCenterCode: filters?.workCenterCodes?.join(',') })}`),
    enabled: filters !== null,
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  })
}

/** §15 — the general page: the plant over the last months, no filter. */
export function useKpiGeneral(range: KpiRange, enabled = true) {
  return useQuery({ queryKey: keys.kpiGeneral(range), queryFn: () => api<KpiGeneral>(`/kpi/general${qs({ from: range.from, to: range.to })}`), enabled, staleTime: 60_000, placeholderData: keepPreviousData })
}

export function useKpiSpan(enabled = true) {
  return useQuery({ queryKey: keys.kpiSpan, queryFn: () => api<KpiSpanResponse>('/kpi/span'), enabled, staleTime: 60 * 60_000 })
}

/** §15 — the insight keys this person has hidden, on every device. */
export function useHiddenInsights(enabled = true) {
  return useQuery({ queryKey: keys.hiddenInsights, queryFn: () => api<HiddenInsightsResponse>('/kpi/insights/hidden'), enabled, staleTime: 5 * 60_000 })
}

export function useKpiThresholds(enabled = true) {
  return useQuery({ queryKey: keys.kpiThresholds, queryFn: () => api<KpiThresholdsResponse>('/kpi/thresholds'), enabled, staleTime: 5 * 60_000 })
}

// ---- §16 Notices -----------------------------------------------------------

/** The bell polls quietly: every three minutes while the tab is visible, never in the background (free tier). */
export const NOTICE_POLL_MS = 3 * 60_000

export function useNoticeInbox(enabled = true) {
  return useQuery({
    queryKey: keys.noticeInbox,
    queryFn: () => api<NoticeInboxResponse>('/notices/inbox'),
    enabled,
    staleTime: 60_000,
    refetchInterval: NOTICE_POLL_MS,
    refetchIntervalInBackground: false,
  })
}

export function useAdminNotices(enabled = true) {
  return useQuery({ queryKey: keys.noticesAdmin, queryFn: () => api<NoticeAdminRow[]>('/notices/admin'), enabled })
}

export function useNoticeAcknowledgements(id: string | null) {
  return useQuery({ queryKey: keys.noticeAcks(id ?? ''), queryFn: () => api<NoticeAcknowledgement[]>(`/notices/${id}/acknowledgements`), enabled: id !== null })
}

// ---- §17 Chat --------------------------------------------------------------

/** The open conversation asks every 30 s; the tab's badge every 3 minutes; nothing in the background. */
export const CHAT_POLL_MS = 30_000
export const CHAT_BADGE_POLL_MS = 3 * 60_000

export function useChatUnread(enabled = true) {
  return useQuery({
    queryKey: keys.chatUnread,
    queryFn: () => api<ChatUnreadResponse>('/chat/unread'),
    enabled,
    staleTime: 60_000,
    refetchInterval: CHAT_BADGE_POLL_MS,
    refetchIntervalInBackground: false,
  })
}

export function useChatConversations(enabled = true) {
  return useQuery({
    queryKey: keys.chatConversations,
    queryFn: () => api<ChatConversationsResponse>('/chat/conversations'),
    enabled,
    staleTime: 10_000,
    refetchInterval: CHAT_POLL_MS,
    refetchIntervalInBackground: false,
  })
}

/** The latest page of a conversation, refreshed while it is open. Older pages are fetched by the thread as it scrolls up. */
export function useChatMessages(conversationId: string | null) {
  return useQuery({
    queryKey: keys.chatMessages(conversationId ?? ''),
    queryFn: () => api<ChatMessagesResponse>(`/chat/conversations/${conversationId}/messages`),
    enabled: conversationId !== null,
    staleTime: 5_000,
    refetchInterval: CHAT_POLL_MS,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  })
}

export function useChatUsers(enabled = true) {
  return useQuery({ queryKey: keys.chatUsers, queryFn: () => api<ChatUser[]>('/chat/users'), enabled, staleTime: 5 * 60_000 })
}

/** §18 — how far this administrator has read the release notes. */
export function useReleaseState(enabled: boolean) {
  return useQuery({ queryKey: keys.releaseState, queryFn: () => api<ReleaseStateResponse>('/releases/state'), enabled, staleTime: 5 * 60_000 })
}

/** §19 — Access: the imported lines, filtered in SQL, first page. */
export function useOrderList(filters: OrderListFilters, limit = 100) {
  return useQuery({
    queryKey: keys.orderList(filters),
    queryFn: () => api<OrderListResponse>(`/orders/list${qs({ limit, ...filters })}`),
    placeholderData: keepPreviousData,
  })
}

/** §19 — the next page of the same filters. */
export async function loadMoreOrders(filters: OrderListFilters, offset: number, limit = 100): Promise<OrderListResponse> {
  return api<OrderListResponse>(`/orders/list${qs({ limit, offset, ...filters })}`)
}

export function useOrderListOptions() {
  return useQuery({ queryKey: keys.orderListOptions, queryFn: () => api<OrderListOptionsResponse>('/orders/list/options'), staleTime: 5 * 60_000 })
}

/** §10.8 — every photo of a session, grouped by what it shows. */
export function useSessionImages(sessionId: string | null) {
  return useQuery({
    queryKey: keys.sessionImages(sessionId ?? ''),
    queryFn: () => api<SessionImagesResponse>(`/sessions/${sessionId}/images`),
    enabled: !!sessionId,
    staleTime: 60_000,
  })
}

/** The lines of the given order numbers, all at once: what an order chosen first has to offer. */
export function useLinesOfOrders(orderNumbers: string[], enabled = true) {
  const key = Array.from(new Set(orderNumbers.map((n) => n.trim()).filter(Boolean))).sort()
  return useQuery({
    queryKey: ['orders', 'lines', key] as const,
    queryFn: async () => (await Promise.all(key.map((n) => api<ProductionOrder[]>(`/orders${qs({ orderNumber: n, includeCancelled: true, limit: 500 })}`)))).flat(),
    enabled: enabled && key.length > 0,
    staleTime: 60_000,
  })
}

/** Every line on the given machines, all at once: what a machine chosen first has to offer. */
export function useLinesOfMachines(codes: string[], enabled = true) {
  const key = Array.from(new Set(codes.map((c) => c.trim()).filter(Boolean))).sort()
  return useQuery({
    queryKey: ['orders', 'lines-of-machines', key] as const,
    queryFn: async () => (await Promise.all(key.map((c) => api<ProductionOrder[]>(`/orders${qs({ machine: c, includeCancelled: true, limit: 500 })}`)))).flat(),
    enabled: enabled && key.length > 0,
    staleTime: 60_000,
  })
}
