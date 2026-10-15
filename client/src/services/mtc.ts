// ============================================================================
// MTC — the material registers' tables (coils, welding wire, mesh wire),
// reading a supplier's certificate, and saving what was reviewed. Reading
// streams (a long certificate takes minutes): the API sends `reading`, then
// the result or an error.
// ============================================================================

import { keepPreviousData, useInfiniteQuery, useQuery, type QueryClient } from '@tanstack/react-query'
import type { ColumnValuesResponse } from '@qc/shared/api'
import {
  type MtcExistingResponse,
  type MtcExtractResult,
  type MtcKind,
  type MtcSaveRequest,
  type MtcSaveResponse,
  type MtcStreamEvent,
  type MtcTableOptionsResponse,
  type MtcTableQuery,
  type MtcTableResponse,
} from '@qc/shared/mtc'
import { ApiError, api, apiStream, qs } from '@/lib/api'
import { readSse } from '@/lib/sse'

/** Where each register's reads are cached: the coils' under ['coils'], which the coil import refreshes too. */
const root = (kind: MtcKind) => (kind === 'coils' ? ['coils'] : [kind])

export const mtcKeys = {
  table: (kind: MtcKind, q: Omit<MtcTableQuery, 'offset' | 'limit'>) => [...root(kind), 'table', q] as const,
  options: (kind: MtcKind) => [...root(kind), 'table', 'options'] as const,
  existing: (kind: MtcKind, key: string) => [...root(kind), 'existing', key] as const,
}

/** A register, a page at a time: the next page is fetched when asked for. */
export function useMtcTable(kind: MtcKind, q: Omit<MtcTableQuery, 'offset' | 'limit'>, pageSize: number) {
  return useInfiniteQuery({
    queryKey: [...mtcKeys.table(kind, q), pageSize],
    queryFn: ({ pageParam }) => api<MtcTableResponse>(`/mtc/${kind}/table${qs({ ...q, offset: pageParam, limit: pageSize })}`),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.rows.length, 0)
      return loaded < last.total && last.rows.length > 0 ? loaded : undefined
    },
    placeholderData: keepPreviousData,
  })
}

/** One column's values under the table's other filters, for its header menu. */
export function loadMtcValues(kind: MtcKind, q: Omit<MtcTableQuery, 'offset' | 'limit'>, column: string, search: string): Promise<ColumnValuesResponse> {
  return api<ColumnValuesResponse>(`/mtc/${kind}/values${qs({ ...q, column, columnSearch: search || undefined })}`)
}

export function useMtcOptions(kind: MtcKind) {
  return useQuery({ queryKey: mtcKeys.options(kind), queryFn: () => api<MtcTableOptionsResponse>(`/mtc/${kind}/options`), staleTime: 60_000 })
}

/** The welding wire batches matching what is typed: the PT step's suggestions (any batch may still be typed). */
export function useWeldingWireSuggestions(search: string, enabled: boolean) {
  return useQuery({
    queryKey: [...mtcKeys.table('welding-wire', { search, sort: 'createdAt:desc' }), 'suggest'],
    queryFn: () => api<MtcTableResponse>(`/mtc/welding-wire/table${qs({ search, sort: 'createdAt:desc', limit: 20 })}`),
    enabled,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  })
}

/** The registered items behind the review's identifiers; `key` is their sorted, lower-cased list (the query's identity). */
export function useExistingItems(kind: MtcKind, ids: string[], key: string) {
  return useQuery({
    queryKey: mtcKeys.existing(kind, key),
    queryFn: () => api<MtcExistingResponse>(`/mtc/${kind}/existing`, { method: 'POST', body: { ids } }),
    enabled: ids.length > 0,
    placeholderData: keepPreviousData,
  })
}

/**
 * Have Claude read a certificate. Resolves with the register it belongs to and
 * its items; throws an ApiError with the API's words when it was refused or
 * failed. Aborting `signal` closes the connection, which stops the reading on
 * the server.
 */
export async function readCertificate(file: File, signal: AbortSignal): Promise<MtcExtractResult> {
  const form = new FormData()
  form.set('file', file, file.name)
  const body = await apiStream('/mtc/extract', { form, signal })
  for await (const frame of readSse(body)) {
    const event = JSON.parse(frame.data) as MtcStreamEvent
    if (event.type === 'result') return event.result
    if (event.type === 'error') throw new ApiError(0, event.code, event.message)
  }
  throw new ApiError(0, 'internal', 'The connection closed before the certificate was read. Try again.')
}

/** Save the reviewed items; the register's reads (and, for coils, the coil search and the dashboard's material figures) are fetched again. */
export async function saveCertificate(qc: QueryClient, kind: MtcKind, body: MtcSaveRequest): Promise<MtcSaveResponse> {
  const result = await api<MtcSaveResponse>(`/mtc/${kind}/save`, { method: 'POST', body })
  await Promise.all([qc.invalidateQueries({ queryKey: root(kind) }), kind === 'coils' ? qc.invalidateQueries({ queryKey: ['kpi'] }) : Promise.resolve()])
  return result
}
