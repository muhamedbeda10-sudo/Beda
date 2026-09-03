// ============================================================================
// §10 — images. Bytes are stored BEFORE the metadata row, and the metadata
// row BEFORE any record may reference the image (§9.5). The client compresses
// on the device and sends a JPEG plus what it measured; the API re-validates
// the bytes, recomputes the hash, and refuses anything that disagrees.
// ============================================================================

import { createHash } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import multer from 'multer'
import { z } from 'zod'
import type { ImageAsset } from '@qc/shared/types'
import type { AppContext } from '../context'
import { HttpError, badRequest, notFound } from '../lib/errors'
import { parse } from '../lib/validate'
import { requireUser } from '../auth/middleware'
import { dropNulls } from '../lib/rows'
import { buildStorageKey, sniffImageMime } from '../images/storage'

export const IMAGE_SELECT = `
  id, storage_key AS "storageKey", driver, original_filename AS "originalFilename", mime_type AS "mimeType",
  byte_size AS "byteSize", width, height, sha256, uploaded_by_id AS "uploadedById", uploaded_by_name AS "uploadedByName",
  uploaded_at AS "uploadedAt", thumbnail_data_url AS "thumbnailDataUrl", session_id AS "sessionId",
  sample_id AS "sampleId", order_id AS "orderId", deleted_at AS "deletedAt"`

const MAX_THUMBNAIL_CHARS = 96 * 1024

const fieldsSchema = z.object({
  originalFilename: z.string().trim().min(1).max(255),
  width: z.coerce.number().int().min(1).max(20000),
  height: z.coerce.number().int().min(1).max(20000),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'sha256 must be 64 hex characters'),
  thumbnailDataUrl: z
    .string()
    .max(MAX_THUMBNAIL_CHARS)
    .regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/, 'thumbnail must be a base64 JPEG data URL'),
  sessionId: z.string().uuid().optional(),
  sampleId: z.string().uuid().optional(),
  orderId: z.string().uuid().optional(),
})

export function imagesRoutes(ctx: AppContext): Router {
  const r = Router()
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: ctx.config.MAX_IMAGE_BYTES, files: 1, fields: 10 },
  })

  r.post('/', upload.single('file'), async (req, res) => {
    const user = requireUser(req)
    const file = req.file
    if (!file) throw badRequest('Attach the image as the "file" field.')
    const fields = parse(fieldsSchema, req.body)

    const sniffed = sniffImageMime(file.buffer.subarray(0, 16))
    if (sniffed !== 'image/jpeg') throw badRequest('Only JPEG images are accepted after on-device compression.')
    const sha256 = createHash('sha256').update(file.buffer).digest('hex')
    if (sha256 !== fields.sha256) {
      throw badRequest('The image was altered in transit: its hash does not match. Please retry the upload.')
    }

    const id = randomUUID()
    const storageKey = buildStorageKey({ id, sessionId: fields.sessionId, orderId: fields.orderId })
    await ctx.images.put(storageKey, file.buffer, 'image/jpeg')

    try {
      const { rows } = await ctx.db.query<ImageAsset>(
        `INSERT INTO images (id, storage_key, driver, original_filename, mime_type, byte_size, width, height, sha256,
                             uploaded_by_id, uploaded_by_name, thumbnail_data_url, session_id, sample_id, order_id)
         VALUES ($1,$2,$3,$4,'image/jpeg',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING ${IMAGE_SELECT}`,
        [
          id,
          storageKey,
          ctx.images.driver,
          fields.originalFilename,
          file.buffer.length,
          fields.width,
          fields.height,
          sha256,
          user.id,
          user.name,
          fields.thumbnailDataUrl,
          fields.sessionId ?? null,
          fields.sampleId ?? null,
          fields.orderId ?? null,
        ],
      )
      res.status(201).json(dropNulls(rows[0]))
    } catch (e) {
      // The metadata row failed, so the bytes must not stay behind as an
      // orphan nothing can ever reference.
      await ctx.images.remove(storageKey).catch(() => undefined)
      throw e
    }
  })

  r.get('/', async (req, res) => {
    const ids = parse(z.string().default(''), req.query.ids).split(',').filter(Boolean)
    parse(z.array(z.string().uuid()).max(200), ids)
    if (ids.length === 0) return res.json([])
    const { rows } = await ctx.db.query<ImageAsset>(`SELECT ${IMAGE_SELECT} FROM images WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`, [ids])
    res.json(rows.map(dropNulls))
  })

  /** Full-resolution bytes. Signed-in only; immutable, so cacheable per user. */
  r.get('/:id/content', async (req, res) => {
    const id = parse(z.string().uuid(), req.params.id)
    const { rows } = await ctx.db.query<{ storageKey: string; mimeType: string; byteSize: number; sha256: string }>(
      `SELECT storage_key AS "storageKey", mime_type AS "mimeType", byte_size AS "byteSize", sha256 FROM images WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    )
    const meta = rows[0]
    if (!meta) throw notFound('That image')
    const etag = `"${meta.sha256}"`
    if (req.headers['if-none-match'] === etag) return res.status(304).end()

    const stored = await ctx.images.get(meta.storageKey)
    if (!stored) throw new HttpError(404, 'not_found', 'The image bytes are missing from storage. The metadata and hash are still on record.')
    res.setHeader('Content-Type', meta.mimeType)
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
    res.setHeader('ETag', etag)
    if (stored.byteSize ?? meta.byteSize) res.setHeader('Content-Length', String(stored.byteSize ?? meta.byteSize))
    stored.stream.on('error', (e) => {
      console.error('[images] stream failed', e)
      if (!res.headersSent) res.status(500).end()
      else res.destroy()
    })
    stored.stream.pipe(res)
  })

  return r
}
