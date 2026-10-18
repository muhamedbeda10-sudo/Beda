// ============================================================================
// §9.5 / §10 — images upload BEFORE the record that references them is saved.
// An orphaned file is cheap to clean up; a record pointing at a missing photo
// is unrecoverable evidence loss.
//
// The photo is compressed and hashed on the device, sent to the API, and the
// API stores the bytes (Azure Blob Storage in production) and the metadata
// row before answering. Only then may a record carry the returned id.
// ============================================================================

import type { ImageAsset } from '@qc/shared/types'
import type { UploadImageFields } from '@qc/shared/api'
import { api, apiBlob } from '@/lib/api'
import { prepareImage, type PreparedImage } from './imageStore'
import { cachedBlob } from './mediaCache'

export interface UploadContext {
  sessionId?: string
  sampleId?: string
  orderId?: string
}

export async function uploadImage(file: File, ctx: UploadContext): Promise<ImageAsset> {
  const prepared: PreparedImage = await prepareImage(file)
  const fields: UploadImageFields = {
    originalFilename: prepared.originalFilename,
    mimeType: prepared.mimeType,
    width: prepared.width,
    height: prepared.height,
    sha256: prepared.sha256,
    thumbnailDataUrl: prepared.thumbnailDataUrl,
    sessionId: ctx.sessionId,
    sampleId: ctx.sampleId,
    orderId: ctx.orderId,
  }
  const form = new FormData()
  form.set('file', prepared.blob, prepared.originalFilename)
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) form.set(k, String(v))
  return api<ImageAsset>('/images', { method: 'POST', form })
}

const objectUrls = new Map<string, string>()

/** A stored photo's bytes in full, as it was uploaded: from the device's cache when it has been seen, else the server. */
export function loadImageBlob(id: string): Promise<Blob> {
  return cachedBlob(`/images/${id}/content`, () => apiBlob(`/images/${id}/content`))
}

/**
 * Full-resolution content for a stored image as an object URL. Fetched with
 * the access token (an <img src> cannot carry one), then cached for the life
 * of the page — the bytes are immutable.
 */
export async function resolveImageUrl(asset: Pick<ImageAsset, 'id' | 'thumbnailDataUrl'>): Promise<string> {
  const cached = objectUrls.get(asset.id)
  if (cached) return cached
  try {
    // Fetched once per device; a photo never changes once stored.
    const blob = await loadImageBlob(asset.id)
    const url = URL.createObjectURL(blob)
    objectUrls.set(asset.id, url)
    return url
  } catch {
    // Fall back to the thumbnail rather than showing a broken image — the
    // metadata still proves what was uploaded.
    return asset.thumbnailDataUrl ?? ''
  }
}
