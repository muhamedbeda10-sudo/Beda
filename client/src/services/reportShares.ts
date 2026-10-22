// ============================================================================
// Saved reports shared with people and roles, through the API
// (shared/reportShares.ts). The owner's Share panel reads and changes whom one
// of their reports is shared with (/ai/reports/:id/shares); a recipient's
// Reports page lists what is shared with them, opens one and runs it
// (/reports/shared…), the assistant or not.
//
// Whether anything is shared is polled with the bell, and again when an
// alert arrives (NoticeBell). Inspectors always have the Reports tab;
// for other roles it appears when a report is shared, without a reload.
// ============================================================================

import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { AiDayRange } from '@qc/shared/ai'
import type {
  ReportShareRequest,
  ReportSharesResponse,
  SharedReport,
  SharedReportRunResponse,
  SharedReportsResponse,
  SharedReportsStatus,
} from '@qc/shared/reportShares'
import { api, apiBlob, qs } from '@/lib/api'
import { NOTICE_POLL_MS, keys, runQs } from './queries'

export const sharedReportKeys = {
  all: ['shared-reports'] as const,
  status: ['shared-reports', 'status'] as const,
  lists: ['shared-reports', 'list'] as const,
  list: (search: string) => ['shared-reports', 'list', search] as const,
  report: (id: string) => ['shared-reports', 'report', id] as const,
  run: (id: string, range: AiDayRange | null, inputs: string) => ['shared-reports', 'run', id, range?.from ?? '', range?.to ?? '', inputs] as const,
  /** The owner's Share panel of one report. */
  shares: (reportId: string) => ['ai', 'report-shares', reportId] as const,
}

/** Reports a page of the Reports page brings. */
export const SHARED_REPORTS_PAGE = 50

/** Whether anything is shared with the person. Polled as the bell is. */
export function useSharedReportsStatus(enabled: boolean) {
  return useQuery({
    queryKey: sharedReportKeys.status,
    queryFn: () => api<SharedReportsStatus>('/reports/shared/status'),
    enabled,
    staleTime: 60_000,
    refetchInterval: NOTICE_POLL_MS,
    refetchIntervalInBackground: false,
  })
}

/** The reports shared with the person, last changed first, matching `search` ('' for all); "Load more" is fetchNextPage. */
export function useSharedReports(search: string) {
  const q = search.trim()
  return useInfiniteQuery({
    queryKey: sharedReportKeys.list(q),
    queryFn: ({ pageParam }) => api<SharedReportsResponse>(`/reports/shared${qs({ q: q || undefined, before: pageParam?.updatedAt, beforeId: pageParam?.id, limit: SHARED_REPORTS_PAGE })}`),
    initialPageParam: null as { updatedAt: string; id: string } | null,
    getNextPageParam: (last: SharedReportsResponse) => {
      const end = last.reports.at(-1)
      return last.hasMore && end ? { updatedAt: end.updatedAt, id: end.id } : null
    },
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  })
}

/** One report shared with the person, as they see it (never its SQL). */
export function useSharedReport(id: string) {
  return useQuery({ queryKey: sharedReportKeys.report(id), queryFn: () => api<SharedReport>(`/reports/shared/${encodeURIComponent(id)}`), staleTime: 30_000, retry: false })
}

/**
 * A shared report run now, as its owner's report view runs one (useAiReportRun): when opened, when its days or
 * values change and on "Run again" — never on a window regaining focus, and a failure is not retried behind the
 * person's back. The tables on screen stay while the next run is on its way.
 */
export function useSharedReportRun(id: string, range: AiDayRange | null, inputs: string, enabled: boolean) {
  const qc = useQueryClient()
  return useQuery({
    queryKey: sharedReportKeys.run(id, range, inputs),
    queryFn: async () => {
      const run = await api<SharedReportRunResponse>(`/reports/shared/${encodeURIComponent(id)}/run${runQs(range, inputs)}`)
      // The report as the run read it: its owner may have changed it since it was opened.
      qc.setQueryData(sharedReportKeys.report(id), run.report)
      return run
    },
    enabled,
    staleTime: 0,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
    placeholderData: keepPreviousData,
  })
}

/** The shared report run again in full over the days and values on screen, as a workbook in its style. */
export const loadSharedReportWorkbook = (id: string, range: AiDayRange | null, inputs: string): Promise<Blob> =>
  apiBlob(`/reports/shared/${encodeURIComponent(id)}/workbook${runQs(range, inputs)}`)

// ---- The owner's Share panel ------------------------------------------------------------

export function useReportShares(reportId: string, enabled: boolean) {
  return useQuery({ queryKey: sharedReportKeys.shares(reportId), queryFn: () => api<ReportSharesResponse>(`/ai/reports/${encodeURIComponent(reportId)}/shares`), enabled, staleTime: 15_000 })
}

/** Share with people and roles, and stop sharing with others: the panel, and the report's count, follow. */
export async function changeReportShares(qc: QueryClient, reportId: string, body: ReportShareRequest): Promise<ReportSharesResponse> {
  const res = await api<ReportSharesResponse>(`/ai/reports/${encodeURIComponent(reportId)}/shares`, { method: 'PUT', body })
  qc.setQueryData(sharedReportKeys.shares(reportId), res)
  void qc.invalidateQueries({ queryKey: keys.aiReport(reportId) })
  return res
}
