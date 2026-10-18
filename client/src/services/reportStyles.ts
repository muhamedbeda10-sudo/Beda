// ============================================================================
// Report styles and Excel forms through the API (shared/src/reportStyles.ts):
// the styles a person may use, saving and removing their own, sharing and the
// company's default (Configuration), a style's versions, and the assistant's
// proposal from a sample or from words; a saved report's style; its Excel
// forms — added, mapped (by hand or by the assistant), removed — and the
// files: a report or a delivery as a workbook in its style, and a form filled.
// ============================================================================

import { useQuery, type QueryClient } from '@tanstack/react-query'
import type { AiDayRange, AiReport } from '@qc/shared/ai'
import type {
  AiReportStyleRequest,
  ReportForm,
  ReportFormMapping,
  ReportFormSaveRequest,
  ReportFormsResponse,
  ReportFormSuggestResponse,
  ReportStyle,
  ReportStyleChooseDefaultRequest,
  ReportStyleDefaultResponse,
  ReportStyleDraftRequest,
  ReportStyleDraftResponse,
  ReportStyleSaveRequest,
  ReportStyleShareRequest,
  ReportStylesResponse,
  ReportStyleVersionsResponse,
  ResolvedReportStyle,
} from '@qc/shared/reportStyles'
import { api, apiBlob } from '@/lib/api'
import { keys, runQs } from './queries'

export const reportStyleKeys = {
  all: ['report-styles'] as const,
  list: ['report-styles', 'list'] as const,
  default: ['report-styles', 'default'] as const,
  versions: (id: string) => ['report-styles', 'versions', id] as const,
  forms: (reportId: string) => ['report-forms', reportId] as const,
}

const stylePath = (id: string) => `/report-styles/${encodeURIComponent(id)}`
const formPath = (id: string) => `/report-forms/${encodeURIComponent(id)}`

// ---- Styles ----------------------------------------------------------------------------------

export function useReportStyles(enabled = true) {
  return useQuery({ queryKey: reportStyleKeys.list, queryFn: () => api<ReportStylesResponse>('/report-styles'), enabled, staleTime: 60_000 })
}

/** The style answers print in: the company's default, else the built-in look. */
export function loadDefaultReportStyle(qc: QueryClient): Promise<ResolvedReportStyle> {
  return qc.fetchQuery({ queryKey: reportStyleKeys.default, queryFn: () => api<ReportStyleDefaultResponse>('/report-styles/default'), staleTime: 60_000 }).then((r) => r.style)
}

export function useReportStyleVersions(id: string | null) {
  return useQuery({ queryKey: reportStyleKeys.versions(id ?? ''), queryFn: () => api<ReportStyleVersionsResponse>(`${stylePath(id ?? '')}/versions`), enabled: id !== null })
}

/** After any change to a style: the list, the default and every report's run (which carries the style it prints in). */
function settled(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: reportStyleKeys.all })
  void qc.invalidateQueries({ queryKey: ['ai', 'report-run'] })
}

export async function saveReportStyle(qc: QueryClient, id: string | null, body: ReportStyleSaveRequest): Promise<ReportStyle> {
  const saved = id ? await api<ReportStyle>(stylePath(id), { method: 'PUT', body }) : await api<ReportStyle>('/report-styles', { method: 'POST', body })
  settled(qc)
  return saved
}

export async function deleteReportStyle(qc: QueryClient, id: string): Promise<void> {
  await api<void>(stylePath(id), { method: 'DELETE' })
  settled(qc)
}

export async function shareReportStyle(qc: QueryClient, id: string, shared: boolean): Promise<ReportStyle> {
  const body: ReportStyleShareRequest = { shared }
  const style = await api<ReportStyle>(`${stylePath(id)}/share`, { method: 'POST', body })
  settled(qc)
  return style
}

export async function chooseDefaultReportStyle(qc: QueryClient, styleId: string | null): Promise<ReportStylesResponse> {
  const body: ReportStyleChooseDefaultRequest = { styleId }
  const list = await api<ReportStylesResponse>('/report-styles/default', { method: 'PUT', body })
  qc.setQueryData(reportStyleKeys.list, list)
  settled(qc)
  return list
}

export function draftReportStyle(body: ReportStyleDraftRequest, signal?: AbortSignal): Promise<ReportStyleDraftResponse> {
  return api<ReportStyleDraftResponse>('/report-styles/draft', { method: 'POST', body, signal })
}

/** The style a saved report prints in (null: the company's default). */
export async function setReportStyle(qc: QueryClient, reportId: string, styleId: string | null): Promise<AiReport> {
  const body: AiReportStyleRequest = { styleId }
  const report = await api<AiReport>(`/ai/reports/${encodeURIComponent(reportId)}/style`, { method: 'PATCH', body })
  qc.setQueryData(keys.aiReport(report.id), report)
  void qc.invalidateQueries({ queryKey: ['ai', 'report-run', report.id] })
  return report
}

// ---- Forms ------------------------------------------------------------------------------------

export function useReportForms(reportId: string | null) {
  return useQuery({
    queryKey: reportStyleKeys.forms(reportId ?? ''),
    queryFn: () => api<ReportFormsResponse>(`/report-forms?reportId=${encodeURIComponent(reportId ?? '')}`),
    enabled: reportId !== null,
    staleTime: 60_000,
  })
}

export async function uploadReportForm(qc: QueryClient, reportId: string, file: File): Promise<ReportForm> {
  const form = new FormData()
  form.append('reportId', reportId)
  form.append('file', file, file.name)
  const saved = await api<ReportForm>('/report-forms', { method: 'POST', form })
  void qc.invalidateQueries({ queryKey: reportStyleKeys.forms(reportId) })
  return saved
}

export async function saveReportForm(qc: QueryClient, form: ReportForm, name: string, mapping: ReportFormMapping | null): Promise<ReportForm> {
  const body: ReportFormSaveRequest = { name, mapping, version: form.version }
  const saved = await api<ReportForm>(formPath(form.id), { method: 'PUT', body })
  void qc.invalidateQueries({ queryKey: reportStyleKeys.forms(form.reportId) })
  return saved
}

export async function deleteReportForm(qc: QueryClient, form: ReportForm): Promise<void> {
  await api<void>(formPath(form.id), { method: 'DELETE' })
  void qc.invalidateQueries({ queryKey: reportStyleKeys.forms(form.reportId) })
}

/** The assistant's mapping, from the columns each section had in the run on screen (null: not run, or failed). */
export function suggestReportForm(id: string, columns: (string[] | null)[], signal?: AbortSignal): Promise<ReportFormSuggestResponse> {
  return api<ReportFormSuggestResponse>(`${formPath(id)}/suggest`, { method: 'POST', body: { columns }, signal })
}

export const loadReportFormFile = (id: string): Promise<Blob> => apiBlob(`${formPath(id)}/file`)

// ---- Files ------------------------------------------------------------------------------------

/** A saved report run again in full over the days and values on screen, as a workbook in its style. */
export const loadReportWorkbook = (reportId: string, range: AiDayRange | null, inputs: string): Promise<Blob> =>
  apiBlob(`/ai/reports/${encodeURIComponent(reportId)}/workbook${runQs(range, inputs)}`)

/** One of a report's forms, filled from the report run again in full over the days and values on screen. */
export const loadFilledReportForm = (reportId: string, formId: string, range: AiDayRange | null, inputs: string): Promise<Blob> =>
  apiBlob(`/ai/reports/${encodeURIComponent(reportId)}/forms/${encodeURIComponent(formId)}/fill${runQs(range, inputs)}`)

export const loadDeliveryWorkbook = (deliveryId: string): Promise<Blob> => apiBlob(`/automations/deliveries/${encodeURIComponent(deliveryId)}/workbook`)

export const loadFilledDeliveryForm = (deliveryId: string, formId: string): Promise<Blob> =>
  apiBlob(`/automations/deliveries/${encodeURIComponent(deliveryId)}/forms/${encodeURIComponent(formId)}`)
