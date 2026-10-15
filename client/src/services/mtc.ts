// ============================================================================
// MTC — the coil register's table, reading a mill test certificate, and
// saving what was reviewed. Reading streams (a long certificate takes
// minutes): the API sends `reading`, then the result or an error.
// ============================================================================

import { keepPreviousData, useInfiniteQuery, useQuery, type QueryClient } from '@tanstack/react-query'
import {
  COIL_TABLE_PAGE,
  type CoilTableOptionsResponse,
  type CoilTableQuery,
  type CoilTableResponse,
  type MtcExistingResponse,
  type MtcExtractResult,
  type MtcSaveRequest,
  type MtcSaveResponse,
  type MtcStreamEvent,
} from '@qc/shared/mtc'
import { ApiError, api, apiStream, qs } from '@/lib/api'
import { readSse } from '@/lib/sse'

export const mtcKeys = {
  table: (q: Omit<CoilTableQuery, 'offset' | 'limit'>) => ['coils', 'table', q] as const,
  options: ['coils', 'table', 'options'] as const,
  existing: (key: string) => ['coils', 'existing', key] as const,
}

/** The register, a page at a time: the next page is fetched when asked for. */
export function useCoilTable(q: Omit<CoilTableQuery, 'offset' | 'limit'>) {
  return useInfiniteQuery({
    queryKey: mtcKeys.table(q),
    queryFn: ({ pageParam }) => api<CoilTableResponse>(`/coils/table${qs({ ...q, offset: pageParam, limit: COIL_TABLE_PAGE })}`),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.rows.length, 0)
      return loaded < last.total && last.rows.length > 0 ? loaded : undefined
    },
    placeholderData: keepPreviousData,
  })
}

export function useCoilTableOptions() {
  return useQuery({ queryKey: mtcKeys.options, queryFn: () => api<CoilTableOptionsResponse>('/coils/table/options'), staleTime: 60_000 })
}

/** The registered coils behind the review's numbers; `key` is their sorted, lower-cased list (the query's identity). */
export function useExistingCoils(coilNumbers: string[], key: string) {
  return useQuery({
    queryKey: mtcKeys.existing(key),
    queryFn: () => api<MtcExistingResponse>('/mtc/existing', { method: 'POST', body: { coilNumbers } }),
    enabled: coilNumbers.length > 0,
    placeholderData: keepPreviousData,
  })
}

/**
 * Have Claude read a certificate. Resolves with the coils it listed; throws an
 * ApiError with the API's words when it was refused or failed. Aborting
 * `signal` closes the connection, which stops the reading on the server.
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

/** Save the reviewed coils; the register's table, the coil search and the dashboard's material figures are read again. */
export async function saveCertificate(qc: QueryClient, body: MtcSaveRequest): Promise<MtcSaveResponse> {
  const result = await api<MtcSaveResponse>('/mtc/save', { method: 'POST', body })
  await Promise.all([qc.invalidateQueries({ queryKey: ['coils'] }), qc.invalidateQueries({ queryKey: ['kpi'] })])
  return result
}
