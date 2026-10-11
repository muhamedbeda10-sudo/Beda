// ============================================================================
// Read hooks — one per thing a screen shows. Each wraps an API call in React
// Query, so the screen gets caching, focus re-fetch and a loading flag, and
// the write functions in ./mutations invalidate by key so screens refresh
// after a save.
//
// Every read here is bounded the way the Firestore version was: a prefix
// search, a lookup by id, or a capped page. Nothing loads a whole table.
// ============================================================================

import { infiniteQueryOptions, keepPreviousData, useInfiniteQuery, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
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
  PDIListFilters,
  PDIWithOrder,
  HistoryExportResponse,
  HistoryGroupQuery,
  HistoryGroupResponse,
  OrderItemOption,
  SessionStagesResponse,
  PDIListResponse,
  PDIOptionsResponse,
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
import type { KpiBreakdown, KpiBreakdownFilters, KpiComparisons, KpiGrainChoice, KpiMaterials, MaterialKind, KpiDrillQuery, KpiDrillResponse, KpiFilters, KpiFirstPartDrillQuery, KpiGeneral, KpiOverview, KpiRange } from '@qc/shared/kpi'
import { loadAvatar } from '@/lib/avatarLoader'
import type { AvatarResponse, ColumnValuesResponse, DashboardLayoutResponse, HiddenInsightsResponse, OrderSyncStatusResponse, OrderListFilters, OrderListOptionsResponse, OrderListResponse, ProductionRecordsSummary, ReleaseStateResponse, SessionImagesResponse } from '@qc/shared/api'
import type { ChatUser, Coil, ImageAsset, NoticeAcknowledgement, NoticeAdminRow, Process, ProductionOrder, UserProfile, WorkInstruction, WorkInstructionScope } from '@qc/shared/types'
import type {
  AiAccessListResponse,
  AiConversationsResponse,
  AiDayRange,
  AiMeResponse,
  AiMessagesResponse,
  AiQueryExportResponse,
  AiReport,
  AiReportExportResponse,
  AiReportRunResponse,
  AiReportsResponse,
  AiSettingsResponse,
  AiUsageResponse,
} from '@qc/shared/ai'
import { api, qs } from '@/lib/api'

export const keys = {
  openBoard: ['sessions', 'open'] as const,
  history: (filters: HistoryFilters) => ['sessions', 'history', filters] as const,
  historyOptions: ['sessions', 'history', 'options'] as const,
  myAvatar: ['auth', 'avatar'] as const,
  userAvatar: (userId: string) => ['auth', 'avatars', userId] as const,
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
  kpiComparisons: (q: ComparisonsQuery) => ['kpi', 'comparisons', q] as const,
  kpiMaterials: (q: MaterialsQuery) => ['kpi', 'materials', q] as const,
  hiddenInsights: ['kpi', 'insights', 'hidden'] as const,
  dashboardLayout: ['kpi', 'layout'] as const,
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
  /** §24 — what the production record holds now: its counts, the days it spans, the last import. */
  productionRecordsSummary: ['production-records', 'summary'] as const,
  /** What the signed-in person may do with the assistant: whether it is theirs, whether they own it, whether it can answer. */
  aiMe: ['ai', 'me'] as const,
  aiSettings: ['ai', 'settings'] as const,
  /** Who may use the assistant, as the owner set it. */
  aiAccess: ['ai', 'access'] as const,
  /** The active accounts the owner has not given the assistant to yet. */
  aiPeople: ['ai', 'people'] as const,
  aiConversations: ['ai', 'conversations'] as const,
  aiMessages: (id: string) => ['ai', 'messages', id] as const,
  aiUsage: (month: string) => ['ai', 'usage', month] as const,
  /** Every list of this person's reports, whatever its search. */
  aiReports: ['ai', 'reports'] as const,
  /** The list of reports matching a search ('' for all of them), page after page. */
  aiReportList: (search: string) => ['ai', 'reports', search] as const,
  aiReport: (id: string) => ['ai', 'report', id] as const,
  /** Saving an answer as a report: a mutation's key (not a query's), so the save outlives the answer on screen. */
  aiSaveReport: (turnId: string) => ['ai', 'save-report', turnId] as const,
  /** A report run over its saved period (no range) or over the days chosen for it. */
  aiReportRun: (id: string, range: AiDayRange | null) => ['ai', 'report-run', id, range?.from ?? '', range?.to ?? ''] as const,
  /** Every run of one report, whatever its days. */
  aiReportRuns: (id: string) => ['ai', 'report-run', id] as const,
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
/** A colleague's small photo for the chat's circles, or null (their initials show). Fetched with the other circles on screen. */
export function useUserAvatar(userId: string) {
  return useQuery({ queryKey: keys.userAvatar(userId), queryFn: () => loadAvatar(userId), enabled: userId !== '', staleTime: 10 * 60_000 })
}

/** The signed-in person's own profile photo, for the circle at the top right. */
export function useMyAvatar(enabled: boolean) {
  return useQuery({ queryKey: keys.myAvatar, queryFn: () => api<AvatarResponse>('/auth/me/avatar'), enabled, staleTime: Infinity })
}

export function useHistory(filters: HistoryFilters, limit = 100, enabled = true) {
  return useQuery({
    queryKey: [...keys.history(filters), limit],
    queryFn: () => api<HistoryResponse>(`/sessions/history${qs({ limit, ...filters })}`),
    enabled,
    // The list stays put while a new search settles, instead of blinking empty.
    placeholderData: keepPreviousData,
  })
}

/** §6 — the next page: the same filters, walked back past `before`. */
export async function loadOlderSessions(filters: HistoryFilters, before: string, limit = 100): Promise<HistoryResponse> {
  return api<HistoryResponse>(`/sessions/history${qs({ limit, ...filters, before })}`)
}

/** §6 — the next page of a History sorted by a column: walked by count. */
export async function loadSessionsAt(filters: HistoryFilters, offset: number, limit = 100): Promise<HistoryResponse> {
  return api<HistoryResponse>(`/sessions/history${qs({ limit, ...filters, offset })}`)
}

/** One History column's values under the other filters, for its Excel menu. */
export function loadHistoryValues(filters: HistoryFilters, column: string, search: string): Promise<ColumnValuesResponse> {
  return api<ColumnValuesResponse>(`/sessions/history/values${qs({ ...filters, column, search: search || undefined })}`)
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

/**
 * One sample's full record, from the cache or the API, for a link that knows the sample but not its session (a coil's
 * "Used in"). Cached under the key History's sample view reads, so the view it opens is already filled.
 */
export function fetchSampleDetail(qc: QueryClient, sampleId: string): Promise<SampleDetail> {
  return qc.fetchQuery({ queryKey: keys.sample(sampleId), queryFn: () => api<SampleDetail>(`/samples/${sampleId}`) })
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

/** The stages a session on a universal machine may be given, asked when it closes or is corrected. */
export function useSessionStages(sessionId: string, enabled = true) {
  return useQuery({
    queryKey: ['sessions', sessionId, 'stages'] as const,
    queryFn: () => api<SessionStagesResponse>(`/sessions/${sessionId}/stages`),
    enabled: enabled && sessionId !== '',
  })
}

/** A page of PDIs, newest first, every filter answered over the whole record. */
export function usePdiList(filters: PDIListFilters, limit = 50, enabled = true) {
  return useQuery({
    queryKey: ['pdi', 'list', filters, limit] as const,
    queryFn: () => api<PDIListResponse>(`/pdi${qs({ limit, ...filters })}`),
    enabled,
    placeholderData: keepPreviousData,
  })
}

/** The page of PDIs recorded before `before`, for walking back. */
export function loadOlderPdi(filters: PDIListFilters, before: string, limit = 50): Promise<PDIListResponse> {
  return api<PDIListResponse>(`/pdi${qs({ limit, ...filters, before })}`)
}

/** A page of PDIs at a position, for a list sorted by a column. */
export function loadPdiAt(filters: PDIListFilters, offset: number, limit = 50): Promise<PDIListResponse> {
  return api<PDIListResponse>(`/pdi${qs({ limit, ...filters, offset })}`)
}

/** One PDI column's values under the other filters, for its Excel menu. */
export function loadPdiValues(filters: PDIListFilters, column: string, search: string): Promise<ColumnValuesResponse> {
  return api<ColumnValuesResponse>(`/pdi/values${qs({ ...filters, column, search: search || undefined })}`)
}

export function usePdiOptions(enabled = true) {
  return useQuery({ queryKey: ['pdi', 'options'] as const, queryFn: () => api<PDIOptionsResponse>('/pdi/options'), enabled, staleTime: 5 * 60_000 })
}

/**
 * Order numbers for the PDI's first step: every word typed found anywhere in
 * the number, narrowed to the orders with a line in a factory, on a machine or
 * of an item. One more than `limit` is asked for, so the screen knows when
 * there are more than it shows.
 */
export function useOrderNumbersAnywhere(term: string, filters: { factory?: string; machine?: string; item?: { itemCode: string; item: string } | null }, limit = 100) {
  const t = useDebounced(term.trim())
  const factory = filters.factory ?? ''
  const machine = filters.machine ?? ''
  const item = filters.item ?? null
  const any = t !== '' || item !== null || factory !== '' || machine !== ''
  return useQuery({
    queryKey: keys.orderNumbers(`*|contains|${t}|${factory}|${machine}|${item ? `${item.itemCode}|${item.item}` : ''}|${limit}`),
    queryFn: async () => {
      const rows = await api<OrderNumberSummary[]>(
        `/orders/numbers${qs({ search: t, match: 'contains', factory, machine, ...(item ? { itemCode: item.itemCode, itemName: item.item } : {}), limit: limit + 1 })}`,
      )
      return { orders: rows.slice(0, limit), more: rows.length > limit }
    },
    enabled: any,
    placeholderData: keepPreviousData,
  })
}

/** §15 — the sessions behind a dashboard number. Nothing is fetched until a number is opened. */
export function useKpiDrill(q: KpiDrillQuery | null) {
  return useQuery({
    queryKey: ['kpi', 'drill', q] as const,
    queryFn: () =>
      api<KpiDrillResponse>(
        `/kpi/drill${qs({
          from: q!.from,
          to: q!.to,
          basis: q!.basis,
          factory: q!.factories?.join(','),
          process: q!.processes?.join(','),
          workCenterCode: q!.workCenterCodes?.join(','),
          itemCode: q!.itemCode,
          inspectorId: q!.inspectorId,
          shift: q!.shift,
          orderId: q!.orderId,
          month: q!.month,
          defect: q!.defect,
          disposition: q!.disposition,
        })}`,
      ),
    enabled: q !== null,
  })
}

/** §15 — the sessions that started with pieces already rejected, in a band. */
export function useFirstPartDrill(q: KpiFirstPartDrillQuery | null) {
  return useQuery({
    queryKey: ['kpi', 'first-part-drill', q] as const,
    queryFn: () =>
      api<KpiDrillResponse>(
        `/kpi/first-part/drill${qs({
          from: q!.from,
          to: q!.to,
          factory: q!.factories?.join(','),
          process: q!.processes?.join(','),
          workCenterCode: q!.workCenterCodes?.join(','),
          itemCode: q!.itemCode,
          qtyFrom: q!.qtyFrom,
          qtyTo: q!.qtyTo,
        })}`,
      ),
    enabled: q !== null,
  })
}

/** The items of the open order lines, for the PDI's item list: narrowed to a factory or machine, searched by name or code. */
export function useOrderItems(factory: string, machine: string, search: string, enabled = true) {
  const t = useDebounced(search.trim())
  return useQuery({
    queryKey: ['orders', 'items', factory, machine, t] as const,
    queryFn: () => api<OrderItemOption[]>(`/orders/items${qs({ factory, machine, search: t, limit: 200 })}`),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  })
}

/** §6 — History's grouped view: an order whole, or an item, a machine or the filters. Nothing is fetched until it opens. */
export function useHistoryGroup(q: HistoryGroupQuery | null) {
  return useQuery({
    queryKey: ['history', 'group', q] as const,
    queryFn: () => api<HistoryGroupResponse>(`/sessions/history/group${qs({ ...q })}`),
    enabled: q !== null,
  })
}

/** §6 — every session the History filters match, with its samples, measurements and defects, for Excel. */
export function loadHistoryExport(filters: HistoryFilters): Promise<HistoryExportResponse> {
  return api<HistoryExportResponse>(`/sessions/history/export${qs({ ...filters })}`)
}

/** §4 — every PDI the filters match, for Excel. */
export function loadPdiExport(filters: PDIListFilters): Promise<PDIWithOrder[]> {
  return api<PDIWithOrder[]>(`/pdi/export${qs({ ...filters })}`)
}

/** Every line of one order, on every machine: the items a PDI may cover. */
export function useOrderAllLines(orderNumber: string) {
  return useQuery({
    queryKey: keys.orderLines(`*|${orderNumber}`),
    queryFn: () => api<ProductionOrder[]>(`/orders${qs({ orderNumber, limit: 500 })}`),
    enabled: orderNumber !== '',
  })
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

/** A page of the log at a position, for a log sorted by a column. */
export async function loadAuditAt(filters: AuditFilters, offset: number, limit = 200): Promise<AuditListResponse> {
  return api<AuditListResponse>(`/audit${qs({ limit, ...filters, offset })}`)
}

/** One audit column's values under the other filters, for its Excel menu. */
export function loadAuditValues(filters: AuditFilters, column: string, search: string): Promise<ColumnValuesResponse> {
  return api<ColumnValuesResponse>(`/audit/values${qs({ ...filters, column, search: search || undefined })}`)
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
export interface ComparisonsQuery {
  from: string
  to: string
  process: Process
  /** How finely the machines' line over the period is drawn. */
  grain: KpiGrainChoice
}

/** §15 — Comparisons: the groups by month and over the period, and the machines of one group. */
export function useKpiComparisons(q: ComparisonsQuery | null) {
  return useQuery({
    queryKey: keys.kpiComparisons(q ?? { from: '', to: '', process: 'forming', grain: 'auto' }),
    queryFn: () => api<KpiComparisons>(`/kpi/comparisons${qs({ from: q?.from, to: q?.to, process: q?.process, grain: q?.grain })}`),
    enabled: q !== null,
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  })
}

/** What the roll forming raw material charts read: the period, the machines (none is all), a thickness and a material for the trend. */
export interface MaterialsQuery {
  from: string
  to: string
  workCenterCodes: string[]
  /** The trend's thicknesses; empty is every one. */
  thicknesses: number[]
  material: MaterialKind | 'all'
  /** The trend's suppliers; '' is the coils with none recorded; empty is every one. */
  suppliers: string[]
  /** The trend's coil grades; empty is every one. */
  grades: string[]
  grain: KpiGrainChoice
}

/** §15 — Comparisons: roll forming's reject rate by coil supplier, by thickness, and one thickness and material over the period. */
export function useKpiMaterials(q: MaterialsQuery | null) {
  return useQuery({
    queryKey: keys.kpiMaterials(q ?? { from: '', to: '', workCenterCodes: [], thicknesses: [], material: 'all', suppliers: [], grades: [], grain: 'auto' }),
    queryFn: () =>
      api<KpiMaterials>(
        `/kpi/materials${qs({
          from: q?.from,
          to: q?.to,
          workCenterCode: q?.workCenterCodes.join(',') || undefined,
          // Lists go as JSON arrays: a supplier's name may hold a comma.
          thicknesses: q?.thicknesses.length ? JSON.stringify(q.thicknesses) : undefined,
          material: q?.material,
          suppliers: q?.suppliers.length ? JSON.stringify(q.suppliers) : undefined,
          grades: q?.grades.length ? JSON.stringify(q.grades) : undefined,
          grain: q?.grain,
        })}`,
      ),
    enabled: q !== null,
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  })
}

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

/** §15 — where each chart sits on the dashboard, the same for everyone. */
export function useDashboardLayout(enabled = true) {
  return useQuery({ queryKey: keys.dashboardLayout, queryFn: () => api<DashboardLayoutResponse>('/kpi/layout'), enabled, staleTime: 5 * 60_000 })
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
    queryKey: [...keys.orderList(filters), limit],
    queryFn: () => api<OrderListResponse>(`/orders/list${qs({ limit, ...filters })}`),
    placeholderData: keepPreviousData,
  })
}

/** §19 — the next page of the same filters. */
export async function loadMoreOrders(filters: OrderListFilters, offset: number, limit = 100): Promise<OrderListResponse> {
  return api<OrderListResponse>(`/orders/list${qs({ limit, offset, ...filters })}`)
}

/** One Access column's values under the other filters, for its Excel menu. */
export function loadOrderListValues(filters: OrderListFilters, column: string, search: string): Promise<ColumnValuesResponse> {
  return api<ColumnValuesResponse>(`/orders/list/values${qs({ ...filters, column, search: search || undefined })}`)
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

/** §7.7 — the Access order sync: its runs, a waiting "Sync now", the keys. Refreshed while it is on screen, so a run shows as it finishes. */
export function useOrderSync() {
  return useQuery({ queryKey: ['integrations', 'order-sync'] as const, queryFn: () => api<OrderSyncStatusResponse>('/integrations/order-sync'), refetchInterval: 15_000 })
}

// ---- §24 Production record ---------------------------------------------------

/** The import page's one line about the production record: it follows every batch an import writes, and the "Remove all". */
export function useProductionRecordsSummary(enabled = true) {
  return useQuery({ queryKey: keys.productionRecordsSummary, queryFn: () => api<ProductionRecordsSummary>('/production-records/summary'), enabled })
}

// ---- §20 AI assistant --------------------------------------------------------
// Everyone signed in asks one cheap question, /ai/me; the rest is fetched only
// for someone it says may use the assistant (the chat) or owns it (the
// settings, the access list, the usage). Every other hook takes `enabled`.

/** How many conversations a page of the history holds. */
export const AI_CONVERSATIONS_PAGE = 50

/**
 * Whether the owner gave this person the assistant, whether they own it, and
 * whether it can answer now — no amounts, no model. Kept a minute and asked
 * again when the window comes back, so access given or withdrawn shows
 * without a reload.
 */
export function useAiMe(enabled = true) {
  return useQuery({ queryKey: keys.aiMe, queryFn: () => api<AiMeResponse>('/ai/me'), enabled, staleTime: 60_000, refetchOnWindowFocus: true })
}

/** The switch, the cap, the key's state (never the key) and the month's spend: the owner's page only. */
export function useAiSettings(enabled: boolean) {
  return useQuery({ queryKey: keys.aiSettings, queryFn: () => api<AiSettingsResponse>('/ai/settings'), enabled, staleTime: 60_000 })
}

/** Who may use the assistant, each with their data, model, effort, cap and this month's spend: the owner's page only. */
export function useAiAccess(enabled: boolean) {
  return useQuery({ queryKey: keys.aiAccess, queryFn: () => api<AiAccessListResponse>('/ai/access'), enabled, staleTime: 60_000 })
}

/** An account the owner may give the assistant to. */
export interface AiPerson {
  id: string
  name: string
  username: string
  role: string
}

/** The active accounts not on the access list yet, for "Add person". */
export function useAiPeople(enabled: boolean) {
  return useQuery({ queryKey: keys.aiPeople, queryFn: () => api<AiPerson[]>('/ai/people'), enabled, staleTime: 30_000 })
}

/** This person's conversations, the latest first: the first page. */
export function useAiConversations(enabled: boolean) {
  return useQuery({
    queryKey: keys.aiConversations,
    queryFn: () => api<AiConversationsResponse>(`/ai/conversations${qs({ limit: AI_CONVERSATIONS_PAGE })}`),
    enabled,
    staleTime: 60_000,
  })
}

/** The page of conversations older than the given instant (the last one's latest message). */
export function loadOlderAiConversations(before: string): Promise<AiConversationsResponse> {
  return api<AiConversationsResponse>(`/ai/conversations${qs({ before, limit: AI_CONVERSATIONS_PAGE })}`)
}

/** One conversation, every question and answer with the queries they ran. */
export function useAiMessages(conversationId: string | null, enabled = true) {
  return useQuery({
    queryKey: keys.aiMessages(conversationId ?? ''),
    queryFn: () => api<AiMessagesResponse>(`/ai/conversations/${encodeURIComponent(conversationId ?? '')}/messages`),
    enabled: enabled && conversationId !== null,
    staleTime: 60_000,
  })
}

/** What the assistant cost in a calendar month (UTC, YYYY-MM), by day and by person. */
export function useAiUsage(month: string, enabled: boolean) {
  return useQuery({
    queryKey: keys.aiUsage(month),
    queryFn: () => api<AiUsageResponse>(`/ai/usage${qs({ month })}`),
    enabled,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  })
}

/** A query of an answer run again now, in full (up to AI_EXPORT_MAX_ROWS rows), for Excel. */
export function loadAiQueryExport(queryId: string): Promise<AiQueryExportResponse> {
  return api<AiQueryExportResponse>(`/ai/queries/${encodeURIComponent(queryId)}/export`)
}

/** How many reports a page of "My reports" holds. */
export const AI_REPORTS_PAGE = 50

/** The days of a run as the server takes them: both or neither. */
const rangeQs = (range: AiDayRange | null) => (range ? qs({ from: range.from, to: range.to }) : '')

/** The longest search of My reports the server takes. */
export const AI_REPORT_SEARCH_MAX = 200

/** One page of this person's saved reports, the latest changed first: matching `search` ('' for all), changed before `before` (null for the first page). */
/** A page of My reports after `before`: the last report of the page already read. */
export function loadAiReportsPage(search: string, before: { updatedAt: string; id: string } | null): Promise<AiReportsResponse> {
  return api<AiReportsResponse>(`/ai/reports${qs({ q: search, before: before?.updatedAt, beforeId: before?.id, limit: AI_REPORTS_PAGE })}`)
}

/**
 * My reports as cached: the reports matching a search, page after page, each
 * page starting after the last report of the one before. The server searches
 * (title and question), so a report not loaded yet is found too. When a report
 * changes (renamed, saved, deleted) every page loaded is fetched again, in
 * order, from the new first page on — a report renamed to the top never leaves
 * a gap where the pages used to meet.
 */
export function aiReportListOptions(search: string) {
  const q = search.trim().slice(0, AI_REPORT_SEARCH_MAX)
  return infiniteQueryOptions({
    queryKey: keys.aiReportList(q),
    queryFn: ({ pageParam }) => loadAiReportsPage(q, pageParam),
    initialPageParam: null as { updatedAt: string; id: string } | null,
    getNextPageParam: (last: AiReportsResponse) => {
      const end = last.reports.at(-1)
      return last.hasMore && end ? { updatedAt: end.updatedAt, id: end.id } : null
    },
    staleTime: 60_000,
  })
}

/** This person's saved reports matching a search ('' for all of them); "Older reports" is fetchNextPage. The last search's reports stay while the next one's come. */
export function useAiReports(search: string, enabled: boolean) {
  return useInfiniteQuery({ ...aiReportListOptions(search), enabled, placeholderData: keepPreviousData })
}

/** One saved report: its title, question, period and sections (with their SQL). */
export function useAiReport(id: string | null, enabled: boolean) {
  return useQuery({
    queryKey: keys.aiReport(id ?? ''),
    queryFn: () => api<AiReport>(`/ai/reports/${encodeURIComponent(id ?? '')}`),
    enabled: enabled && id !== null,
    staleTime: 60_000,
  })
}

/**
 * A report run now: every section's SQL through the server's read-only
 * runner, over the saved period or the days chosen (`range`). Free, but it
 * works the database and the server limits how often, so it runs when the
 * report is opened, when its days change and on "Run again" — never on a
 * window regaining focus, and a failure is not retried behind the asker's
 * back. The tables on screen stay while the next run is on its way.
 */
export function useAiReportRun(id: string | null, range: AiDayRange | null, enabled: boolean) {
  const qc = useQueryClient()
  return useQuery({
    queryKey: keys.aiReportRun(id ?? '', range),
    queryFn: () => runAiReport(qc, id ?? '', range),
    enabled: enabled && id !== null,
    staleTime: 0,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
    placeholderData: keepPreviousData,
  })
}

/**
 * The newer of two copies of a report. A run (or an export) carries the
 * report as the server read it before running its sections, which can take a
 * while: a rename made meanwhile is newer, and must not be undone by the run
 * ending. The last run is the latest either copy knows.
 */
export function newerAiReport(cached: AiReport | undefined, fromRun: AiReport): AiReport {
  if (!cached || cached.id !== fromRun.id || Date.parse(cached.updatedAt) <= Date.parse(fromRun.updatedAt)) return fromRun
  const runs = [cached.lastRunAt, fromRun.lastRunAt].filter((t): t is string => !!t)
  const lastRunAt = runs.sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1)
  return lastRunAt ? { ...cached, lastRunAt } : cached
}

/** Run a report now (see useAiReportRun); the report on screen and the list follow what the run moved. */
export async function runAiReport(qc: QueryClient, id: string, range: AiDayRange | null): Promise<AiReportRunResponse> {
  const run = await api<AiReportRunResponse>(`/ai/reports/${encodeURIComponent(id)}/run${rangeQs(range)}`)
  // Its last run moved; its title may have moved too while it ran (a rename), and the newer copy is kept.
  const report = newerAiReport(qc.getQueryData<AiReport>(keys.aiReport(run.report.id)), run.report)
  qc.setQueryData(keys.aiReport(report.id), report)
  void qc.invalidateQueries({ queryKey: keys.aiReports })
  return report === run.report ? run : { ...run, report }
}

/** A report run again in full (up to AI_EXPORT_MAX_ROWS rows a section) over the same days, for Excel. */
export function loadAiReportExport(id: string, range: AiDayRange | null): Promise<AiReportExportResponse> {
  return api<AiReportExportResponse>(`/ai/reports/${encodeURIComponent(id)}/export${rangeQs(range)}`)
}
