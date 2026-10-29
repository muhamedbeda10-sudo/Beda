// ============================================================================
// MTC — the material registers' tables (coils, welding wire, mesh wire),
// reading a supplier's certificate, and saving what was reviewed. Reading
// streams (a long certificate takes minutes): the API sends `reading`, then
// the result or an error.
// ============================================================================

import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { ColumnValuesResponse } from '@qc/shared/api'
import { AI_IMAGE_LONG_EDGE } from '@qc/shared/ai'
import {
  MTC_MAX_IMAGES,
  MTC_MAX_PDF_BYTES,
  MTC_MAX_SHEET_CHARS,
  type CoilDetails,
  type CoilSlitting,
  type CoilSlittingInput,
  type DeliveryNote,
  type DeliveryNoteExtractResult,
  type DeliveryNoteInput,
  type DeliveryNoteListResponse,
  type DeliveryNoteStreamEvent,
  type DeliveryNoteUpdate,
  type MtcDocument,
  type MtcStandardsResponse,
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
  // The workbook itself goes too, kept to open again from the register (a CSV is its text alone).
  if (/\.xlsx$/i.test(file.name) && file.size <= MTC_MAX_PDF_BYTES) form.set('original', file, file.name)
  return { form, name: file.name }
}

/** Read one streamed reading to its result; its error as an ApiError with the API's words. */
async function readStream<R>(path: string, form: FormData, signal: AbortSignal, noun: string): Promise<R> {
  const body = await apiStream(path, { form, signal })
  for await (const frame of readSse(body)) {
    const event = JSON.parse(frame.data) as MtcStreamEvent | DeliveryNoteStreamEvent
    if (event.type === 'result') return event.result as R
    if (event.type === 'error') throw new ApiError(0, event.code, event.message)
  }
  throw new ApiError(0, 'internal', `The connection closed before the ${noun} was read. Try again.`)
}

export async function readCertificate(files: readonly File[], signal: AbortSignal): Promise<MtcExtractResult> {
  const { form } = await certificateForm(files)
  return readStream<MtcExtractResult>('/mtc/extract', form, signal, 'certificate')
}

/** Have Claude read a delivery note: the same files a certificate may come as. */
export async function readDeliveryNote(files: readonly File[], signal: AbortSignal): Promise<DeliveryNoteExtractResult> {
  const { form } = await certificateForm(files)
  return readStream<DeliveryNoteExtractResult>('/mtc/delivery-notes/extract', form, signal, 'delivery note')
}

// ---- Kept documents -------------------------------------------------------------------

export const mtcDocumentPath = (id: string, page = 1) => `/mtc/documents/${id}/content${page > 1 ? `?page=${page}` : ''}`

export function useMtcDocument(id: string | null | undefined) {
  return useQuery({ queryKey: ['mtc-documents', id], queryFn: () => api<MtcDocument>(`/mtc/documents/${id}`), enabled: !!id, staleTime: Infinity })
}

// ---- Coils: their grade's limits, details, slitting -----------------------------------

export function useMtcStandards(enabled = true) {
  return useQuery({ queryKey: ['coils', 'standards'], queryFn: () => api<MtcStandardsResponse>('/mtc/coils/standards'), enabled, staleTime: 5 * 60_000 })
}

export function useCoilDetails(id: string | null) {
  return useQuery({ queryKey: ['coils', 'details', id], queryFn: () => api<CoilDetails>(`/mtc/coils/${id}/details`), enabled: !!id })
}

export function useAddSlitting(coilId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: CoilSlittingInput) => api<CoilSlitting>(`/mtc/coils/${coilId}/slittings`, { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['coils', 'details', coilId] }),
  })
}

export function useRemoveSlitting(coilId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api<void>(`/mtc/slittings/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['coils', 'details', coilId] }),
  })
}

// ---- Delivery notes ---------------------------------------------------------------------

export function useDeliveryNotes(search: string, pageSize: number) {
  return useInfiniteQuery({
    queryKey: ['delivery-notes', 'list', search, pageSize],
    queryFn: ({ pageParam }) => api<DeliveryNoteListResponse>(`/mtc/delivery-notes${qs({ search: search || undefined, offset: pageParam, limit: pageSize })}`),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.notes.length, 0)
      return loaded < last.total && last.notes.length > 0 ? loaded : undefined
    },
    placeholderData: keepPreviousData,
  })
}

export function useDeliveryNote(id: string | null) {
  return useQuery({ queryKey: ['delivery-notes', 'one', id], queryFn: () => api<DeliveryNote>(`/mtc/delivery-notes/${id}`), enabled: !!id })
}

/** A note saved (new or corrected) or removed: the notes and the coil register (PO, delivery date) are read again. */
async function afterNoteChange(qc: QueryClient) {
  await Promise.all([qc.invalidateQueries({ queryKey: ['delivery-notes'] }), qc.invalidateQueries({ queryKey: ['coils'] })])
}

export async function saveDeliveryNote(qc: QueryClient, body: DeliveryNoteInput | (DeliveryNoteUpdate & { id: string })): Promise<DeliveryNote> {
  const saved =
    'id' in body
      ? await api<DeliveryNote>(`/mtc/delivery-notes/${body.id}`, { method: 'PUT', body: { ...body, id: undefined } })
      : await api<DeliveryNote>('/mtc/delivery-notes', { method: 'POST', body })
  await afterNoteChange(qc)
  return saved
}

export async function deleteDeliveryNote(qc: QueryClient, id: string): Promise<void> {
  await api<void>(`/mtc/delivery-notes/${id}`, { method: 'DELETE' })
  await afterNoteChange(qc)
}

/** Save the reviewed items; the register's reads (and, for coils, the coil search and the dashboard's material figures) are fetched again. */
export async function saveCertificate(qc: QueryClient, kind: MtcKind, body: MtcSaveRequest): Promise<MtcSaveResponse> {
  const result = await api<MtcSaveResponse>(`/mtc/${kind}/save`, { method: 'POST', body })
  await Promise.all([qc.invalidateQueries({ queryKey: root(kind) }), kind === 'coils' ? qc.invalidateQueries({ queryKey: ['kpi'] }) : Promise.resolve()])
  return result
}
