// ============================================================================
// MTC — a certificate or delivery note kept as it was uploaded, so the
// register can open it again: the PDF as it is, the photos of its pages (as
// the device brought them down), or the mill's workbook. Kept once Claude has
// read it as one (mtc_documents); a reading of something else keeps nothing.
// ============================================================================

import { randomUUID } from 'node:crypto'
import type { MtcDocument } from '@qc/shared/mtc'
import type { AppContext } from '../context'
import type { MtcSource } from './reader'

/** The workbook behind a spreadsheet's text, when the device sent it (an .xlsx: a zip). */
export const isXlsx = (b: Buffer): boolean => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04

export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/**
 * Keep the file in the image store and record it. Null when there is nothing
 * to keep (a spreadsheet sent as text alone: a CSV). Whatever was put is
 * taken back if the record cannot be written.
 */
export async function keepDocument(ctx: AppContext, source: MtcSource, workbook: Buffer | null, fileName: string, userId: string): Promise<string | null> {
  const id = randomUUID()
  const parts: { key: string; data: Buffer; type: string }[] =
    source.kind === 'pdf'
      ? [{ key: `documents/mtc/${id}.pdf`, data: source.data, type: 'application/pdf' }]
      : source.kind === 'images'
        ? source.images.map((img, i) => ({ key: `images/mtc/${id}-${i + 1}.jpg`, data: img.data, type: img.type }))
        : workbook
          ? [{ key: `documents/mtc/${id}.xlsx`, data: workbook, type: XLSX_TYPE }]
          : []
  if (parts.length === 0) return null
  const put: string[] = []
  try {
    for (const p of parts) {
      await ctx.images.put(p.key, p.data, p.type)
      put.push(p.key)
    }
    await ctx.db.query(
      `INSERT INTO mtc_documents (id, file_name, source, storage_keys, driver, byte_size, uploaded_by_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, fileName.slice(0, 255) || 'document', source.kind, put, ctx.images.driver, parts.reduce((n, p) => n + p.data.length, 0), userId],
    )
    return id
  } catch (e) {
    for (const key of put) await ctx.images.remove(key).catch(() => undefined)
    throw e
  }
}

export interface DocumentRecord extends MtcDocument {
  storageKeys: string[]
}

export async function loadDocument(ctx: AppContext, id: string): Promise<DocumentRecord | null> {
  const { rows } = await ctx.db.query<DocumentRecord>(
    `SELECT id, file_name AS "fileName", source, cardinality(storage_keys) AS pages, byte_size::float8 AS "byteSize", created_at AS "createdAt",
            storage_keys AS "storageKeys"
       FROM mtc_documents WHERE id = $1`,
    [id],
  )
  return rows[0] ?? null
}
