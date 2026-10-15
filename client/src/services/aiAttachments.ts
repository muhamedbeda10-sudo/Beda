// ============================================================================
// §20 — attaching a file to a question for the assistant. A photo is brought
// down on the device to the most Claude reads (handwriting needs the pixels)
// and re-encoded as JPEG, which also drops its location data; a PDF goes as
// it is; a spreadsheet is read here into text (components/ai/attachments.ts).
// The server counts each with Anthropic, which refuses a file Claude cannot
// read, and keeps it until the question takes it.
// ============================================================================

import { AI_IMAGE_LONG_EDGE, AI_MAX_PDF_BYTES, type AiAttachment, type AiAttachmentKind, type AiSheetAttachmentRequest } from '@qc/shared/ai'
import { api } from '@/lib/api'
import { parseCSV } from '@/lib/utils'
import { WorkbookReadError, isLegacyExcelFile, isZipFile, readWorkbook } from '@/lib/xlsx'
import { sheetText } from '@/components/ai/attachments'
import { ImageRejected, prepareImage } from './imageStore'

/** A file that cannot be attached, with a sentence to show. */
export class AttachRejected extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AttachRejected'
  }
}

/** Photos keep detail for handwriting: a lighter touch than evidence photos. */
export const AI_PHOTO_QUALITY = 0.88

async function attachPhoto(file: File, signal?: AbortSignal): Promise<AiAttachment> {
  let prepared
  try {
    prepared = await prepareImage(file, AI_PHOTO_QUALITY, AI_IMAGE_LONG_EDGE)
  } catch (e) {
    if (e instanceof ImageRejected) throw new AttachRejected(e.message)
    throw e
  }
  const form = new FormData()
  const name = /\.(jpe?g)$/i.test(prepared.originalFilename) ? prepared.originalFilename : `${prepared.originalFilename.replace(/\.[^.]*$/, '') || 'photo'}.jpg`
  form.set('file', prepared.blob, name)
  form.set('thumbnail', prepared.thumbnailDataUrl)
  return api<AiAttachment>('/ai/attachments', { method: 'POST', form, signal })
}

async function attachPdf(file: File, signal?: AbortSignal): Promise<AiAttachment> {
  if (file.size > AI_MAX_PDF_BYTES) throw new AttachRejected(`That PDF is ${(file.size / 1024 / 1024).toFixed(1)} MB. A PDF may be at most ${AI_MAX_PDF_BYTES / 1024 / 1024} MB.`)
  const head = new Uint8Array(await file.slice(0, 5).arrayBuffer())
  if (String.fromCharCode(...head) !== '%PDF-') throw new AttachRejected('That file is not a PDF.')
  const form = new FormData()
  form.set('file', file, file.name || 'document.pdf')
  return api<AiAttachment>('/ai/attachments', { method: 'POST', form, signal })
}

/** A spreadsheet's sheets as rows: an .xlsx workbook, or a CSV as one sheet. Also how a certificate's spreadsheet is read (MTC). */
export async function readSheets(file: File): Promise<{ name: string; rows: string[][] }[]> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (isLegacyExcelFile(bytes)) throw new AttachRejected('That is an old Excel file (.xls). Save it as .xlsx in Excel, then attach it.')
  if (isZipFile(bytes)) {
    try {
      return readWorkbook(bytes).sheets
    } catch (e) {
      if (e instanceof WorkbookReadError) throw new AttachRejected(e.message)
      throw e
    }
  }
  // A CSV: UTF-8, with or without the mark Excel puts first.
  const text = new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '')
  return [{ name: file.name.replace(/\.[^.]*$/, '') || 'Sheet', rows: parseCSV(text) }]
}

async function attachSheet(file: File, signal?: AbortSignal): Promise<AiAttachment> {
  const read = sheetText(await readSheets(file))
  if (!read) throw new AttachRejected('That spreadsheet is empty.')
  const body: AiSheetAttachmentRequest = { name: file.name || 'spreadsheet.csv', text: read.text, summary: read.summary }
  return api<AiAttachment>('/ai/attachments/sheet', { method: 'POST', body, signal })
}

/** Attach one picked file of a kind pickedKind gave; throws AttachRejected or the API's error. */
export function attachFile(file: File, kind: AiAttachmentKind, signal?: AbortSignal): Promise<AiAttachment> {
  switch (kind) {
    case 'image':
      return attachPhoto(file, signal)
    case 'pdf':
      return attachPdf(file, signal)
    case 'sheet':
      return attachSheet(file, signal)
  }
}

/** Take a file off the question before it is sent (the server keeps a record that it was attached). */
export function detachFile(id: string): Promise<void> {
  return api<void>(`/ai/attachments/${id}`, { method: 'DELETE' })
}
