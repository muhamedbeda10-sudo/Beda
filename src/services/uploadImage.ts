// ============================================================================
// §9.5 / §10 — images upload BEFORE the record that references them is saved.
// An orphaned file is cheap to clean up; a record pointing at a missing photo
// is unrecoverable evidence loss.
// ============================================================================

import { doc, getDoc, setDoc, writeBatch } from 'firebase/firestore'
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage'
import { getDb, getStorageInstance, firebaseUseStorage } from '@/lib/firebase'
import { COL, stripUndefined } from './repository'
import {
  prepareImage,
  buildStorageKey,
  FIRESTORE_CHUNK_BYTES,
  type PreparedImage,
} from './imageStore'
import { uid } from '@/lib/utils'
import type { ImageAsset } from '@/domain/types'

export interface UploadContext {
  uploadedByUid: string
  uploadedByName: string
  sessionId?: string
  sampleId?: string
  orderId?: string
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => {
      const s = r.result as string
      resolve(s.slice(s.indexOf(',') + 1))
    }
    r.onerror = () => reject(new Error('Could not encode the image.'))
    r.readAsDataURL(blob)
  })
}

/**
 * Upload one image and write its metadata. Returns the asset once the bytes are
 * durably stored, so the caller can safely reference it in a later save.
 */
export async function uploadImage(file: File, ctx: UploadContext): Promise<ImageAsset> {
  const prepared: PreparedImage = await prepareImage(file)
  const id = uid('img')
  const storageKey = buildStorageKey({
    id,
    sessionId: ctx.sessionId,
    sampleId: ctx.sampleId,
    orderId: ctx.orderId,
  })

  const asset: ImageAsset = {
    id,
    storageKey,
    driver: firebaseUseStorage ? 'cloud-storage' : 'firestore',
    originalFilename: prepared.originalFilename,
    mimeType: prepared.mimeType,
    byteSize: prepared.byteSize,
    width: prepared.width,
    height: prepared.height,
    sha256: prepared.sha256,
    uploadedByUid: ctx.uploadedByUid,
    uploadedByName: ctx.uploadedByName,
    uploadedAt: new Date().toISOString(),
    thumbnailDataUrl: prepared.thumbnailDataUrl,
    sessionId: ctx.sessionId,
    sampleId: ctx.sampleId,
    orderId: ctx.orderId,
  }

  if (firebaseUseStorage) {
    // Bytes to Cloud Storage. The key is unique per upload, so this can never
    // replace existing evidence (§10.3).
    await uploadBytes(ref(getStorageInstance(), storageKey), prepared.blob, {
      contentType: prepared.mimeType,
    })
  } else {
    // Free-tier fallback: chunk the bytes across documents, since one Firestore
    // document caps at 1 MiB. Chunks are written in a batch so a partial image
    // can never be left behind.
    const base64 = await blobToBase64(prepared.blob)
    const chunks: string[] = []
    for (let i = 0; i < base64.length; i += FIRESTORE_CHUNK_BYTES) {
      chunks.push(base64.slice(i, i + FIRESTORE_CHUNK_BYTES))
    }
    const batch = writeBatch(getDb())
    chunks.forEach((data, i) => {
      batch.set(doc(getDb(), COL.imageChunks, `${id}_${i}`), {
        imageId: id,
        index: i,
        total: chunks.length,
        data,
      })
    })
    await batch.commit()
  }

  await setDoc(doc(getDb(), COL.images, id), stripUndefined(asset))
  return asset
}

/** Resolve displayable full-resolution content for a stored image. */
export async function resolveImageUrl(asset: ImageAsset): Promise<string> {
  if (asset.driver === 'cloud-storage') {
    return getDownloadURL(ref(getStorageInstance(), asset.storageKey))
  }
  const parts: string[] = []
  for (let i = 0; ; i++) {
    const snap = await getDoc(doc(getDb(), COL.imageChunks, `${asset.id}_${i}`))
    if (!snap.exists()) break
    const d = snap.data() as { data: string; total: number }
    parts.push(d.data)
    if (i + 1 >= d.total) break
  }
  if (parts.length === 0) {
    // Fall back to the thumbnail rather than showing a broken image — the
    // metadata still proves what was uploaded.
    return asset.thumbnailDataUrl ?? ''
  }
  return `data:${asset.mimeType};base64,${parts.join('')}`
}
