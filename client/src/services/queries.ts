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
  AuditListResponse,
  AuditStats,
  CoilUsage,
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
  WizardContext,
  SessionNotesResponse,
  KpiThresholdsResponse,
} from '@qc/shared/api'
import type { KpiFilters, KpiOverview } from '@qc/shared/kpi'
import type { Coil, Disposition, ImageAsset, ProductionOrder, UserProfile, WorkInstruction, WorkInstructionScope } from '@qc/shared/types'
import { api, qs } from '@/lib/api'

export const keys = {
  openBoard: ['sessions', 'open'] as const,
  history: (disposition?: Disposition | null) => ['sessions', 'history', disposition ?? 'all'] as const,
  session: (id: string) => ['sessions', id] as const,
  wizard: (id: string) => ['sessions', id, 'wizard'] as const,
  sessionSamples: (id: string) => ['sessions', id, 'samples'] as const,
  sessionNotes: (id: string) => ['sessions', id, 'notes'] as const,
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
  audit: ['audit', 'list'] as const,
  auditStats: ['audit', 'stats'] as const,
  users: ['users'] as const,
  workInstructions: (process?: string, history?: boolean) => ['work-instructions', process ?? 'all', history ? 'history' : 'in-force'] as const,
  kpiOverview: (filters: KpiFilters) => ['kpi', 'overview', filters] as const,
  kpiThresholds: ['kpi', 'thresholds'] as const,
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

export function useHistory(disposition: Disposition | null, limit = 100) {
  return useQuery({
    queryKey: keys.history(disposition),
    queryFn: () => api<HistoryResponse>(`/sessions/history${qs({ limit, disposition })}`),
  })
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

export function useSessionSamples(sessionId: string | null) {
  return useQuery({
    queryKey: keys.sessionSamples(sessionId ?? ''),
    queryFn: () => api<SampleSummary[]>(`/sessions/${sessionId}/samples`),
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

export function useAuditList(limit = 500) {
  return useQuery({ queryKey: keys.audit, queryFn: () => api<AuditListResponse>(`/audit${qs({ limit })}`) })
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
    queryFn: () => api<KpiOverview>(`/kpi/overview${qs({ ...filters })}`),
    enabled: filters !== null,
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
  })
}

export function useKpiThresholds(enabled = true) {
  return useQuery({ queryKey: keys.kpiThresholds, queryFn: () => api<KpiThresholdsResponse>('/kpi/thresholds'), enabled, staleTime: 5 * 60_000 })
}
