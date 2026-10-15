// ============================================================================
// MTC — the material registers' tables (coils, welding wire, mesh wire),
// reading a supplier's certificate, and saving what was reviewed. Reading
// streams (a long certificate takes minutes): the API sends `reading`, then
// the result or an error.
// ============================================================================

import { keepPreviousData, useInfiniteQuery, useQuery, type QueryClient } from '@tanstack/react-query'
import type { ColumnValuesResponse } from '@qc/shared/api'
import { AI_IMAGE_LONG_EDGE } from '@qc/shared/ai'
import {
  MTC_MAX_IMAGES,
  MTC_MAX_PDF_BYTES,
  MTC_MAX_SHEET_CHARS,
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
import { pickedKind, sheetText } from '@/components/ai/attachments'
import { AI_PHOTO_QUALITY, AttachRejected, readSheets } from './aiAttachments'
import { ImageRejected, prepareImage } from './imageStore'

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
/** Files that cannot be read as one certificate, with a sentence to show. */
export class CertificateRejected extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CertificateRejected'
  }
}

/**
 * The picked files as one certificate for the server: one PDF as it is; up to
 * MTC_MAX_IMAGES photos of its pages, in the order picked, each brought down on
 * the device to the most Claude reads (and re-encoded as JPEG, which drops its
 * location data); or one spreadsheet (.xlsx or .csv), read here into text.
 * Throws CertificateRejected for anything else.
 */
export async function certificateForm(files: readonly File[]): Promise<{ form: FormData; name: string }> {
  if (files.length === 0) throw new CertificateRejected('Pick the certificate: its PDF, photos of its pages, or its spreadsheet.')
  const kinds = files.map((f) => pickedKind(f))
  const unknown = files.find((_, i) => kinds[i] === null)
  if (unknown) throw new CertificateRejected(`“${unknown.name}” is not a PDF, a photo or a spreadsheet.`)
  const form = new FormData()
  if (kinds.every((k) => k === 'image')) {
    if (files.length > MTC_MAX_IMAGES) throw new CertificateRejected(`Pick at most ${MTC_MAX_IMAGES} photos: one for each page of the certificate.`)
    for (const f of files) {
      try {
        const prepared = await prepareImage(f, AI_PHOTO_QUALITY, AI_IMAGE_LONG_EDGE)
        form.append('images', prepared.blob, `${f.name.replace(/\.[^.]*$/, '') || 'photo'}.jpg`)
      } catch (e) {
        if (e instanceof ImageRejected) throw new CertificateRejected(`“${f.name}”: ${e.message}`)
        throw e
      }
    }
    const name = files.length === 1 ? files[0].name : `${files[0].name} (+${files.length - 1} photos)`
    form.set('fileName', name)
    return { form, name }
  }
  if (files.length > 1) throw new CertificateRejected('Pick one PDF, one spreadsheet, or photos of the pages — one certificate at a time.')
  const file = files[0]
  if (kinds[0] === 'pdf') {
    if (file.size > MTC_MAX_PDF_BYTES) throw new CertificateRejected(`A certificate may be at most ${MTC_MAX_PDF_BYTES / 1024 / 1024} MB. Split the PDF and upload the parts.`)
    form.set('file', file, file.name)
    return { form, name: file.name }
  }
  let sheets
  try {
    sheets = await readSheets(file)
  } catch (e) {
    if (e instanceof AttachRejected) throw new CertificateRejected(e.message)
    throw e
  }
  const read = sheetText(sheets, MTC_MAX_SHEET_CHARS)
  if (!read) throw new CertificateRejected('That spreadsheet is empty.')
  // Every row is an item to register: a spreadsheet cut short would lose some without a word.
  if (read.omittedRows > 0) throw new CertificateRejected('That spreadsheet is too long to read in one go. Split it and upload the parts.')
  form.set('sheet', read.text)
  form.set('fileName', file.name)
  return { form, name: file.name }
}

export async function readCertificate(files: readonly File[], signal: AbortSignal): Promise<MtcExtractResult> {
  const { form } = await certificateForm(files)
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
