// ============================================================================
// Firestore sync adapter.
// - realtime listeners keep the in-memory store in sync across clients
// - persistDiff() writes only the docs that actually changed on each mutation
// - image blobs go to Cloud Storage (not base64 in Firestore)
// This module is only ever imported/used when firebaseEnabled === true.
// ============================================================================
import {
  collection,
  doc,
  writeBatch,
  onSnapshot,
  getDocs,
  type Firestore,
} from 'firebase/firestore'
import { ref, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage'
import { getDb, getStorageInstance } from '@/lib/firebase'
import type { DB } from '@/types'

/** DB array keys that map 1:1 to Firestore collections (each element has `id`). */
export const COLLECTIONS = [
  'machines',
  'orders',
  'sessions',
  'samples',
  'dimensions',
  'defects',
  'images',
  'defectTypes',
  'dimensionSpecs',
  'gradeMappings',
  'ptConsumables',
  'audit',
] as const

export type CollectionKey = (typeof COLLECTIONS)[number]

type Entity = { id: string }

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/** Write only changed / removed docs between two DB snapshots. */
export async function persistDiff(prev: DB, next: DB): Promise<void> {
  const store = getDb()
  const ops: Array<{ kind: 'set' | 'del'; col: string; id: string; data?: unknown }> = []

  for (const key of COLLECTIONS) {
    const prevArr = (prev[key] as unknown as Entity[]) || []
    const nextArr = (next[key] as unknown as Entity[]) || []
    const prevMap = new Map(prevArr.map((e) => [e.id, e]))
    const nextMap = new Map(nextArr.map((e) => [e.id, e]))

    for (const [id, entity] of nextMap) {
      const before = prevMap.get(id)
      if (!before || JSON.stringify(before) !== JSON.stringify(entity)) {
        ops.push({ kind: 'set', col: key, id, data: entity })
      }
    }
    for (const id of prevMap.keys()) {
      if (!nextMap.has(id)) ops.push({ kind: 'del', col: key, id })
    }
  }

  if (ops.length === 0) return

  // Firestore batches allow up to 500 writes.
  for (const group of chunk(ops, 450)) {
    const batch = writeBatch(store)
    for (const op of group) {
      const dref = doc(store, op.col, op.id)
      if (op.kind === 'set') batch.set(dref, op.data as Record<string, unknown>)
      else batch.delete(dref)
    }
    await batch.commit()
  }
}

/** Seed Firestore from a demo DB only if it is currently empty. */
export async function seedIfEmpty(store: Firestore, seed: DB): Promise<boolean> {
  const ordersSnap = await getDocs(collection(store, 'orders'))
  if (!ordersSnap.empty) return false
  const empty: DB = {
    machines: [], orders: [], sessions: [], samples: [], dimensions: [], defects: [],
    images: [], defectTypes: [], dimensionSpecs: [], gradeMappings: [], ptConsumables: [],
    audit: [], meta: seed.meta,
  }
  await persistDiff(empty, seed)
  return true
}

/** Attach realtime listeners; calls onCollection(key, rows) whenever a collection changes. */
export function attachRealtime(onCollection: (key: CollectionKey, rows: unknown[]) => void): () => void {
  const store = getDb()
  const unsubs = COLLECTIONS.map((key) =>
    onSnapshot(
      collection(store, key),
      (snap) => onCollection(key, snap.docs.map((d) => d.data())),
      (err) => console.warn(`[firebase] ${key} listener error`, err),
    ),
  )
  return () => unsubs.forEach((u) => u())
}

// ---- Storage (images) ------------------------------------------------------

/** Upload an image blob and return { url, path }. */
export async function uploadImageBlob(blob: Blob, path: string): Promise<{ url: string; path: string }> {
  const storage = getStorageInstance()
  const r = ref(storage, path)
  await uploadBytes(r, blob, { contentType: blob.type || 'image/jpeg' })
  const url = await getDownloadURL(r)
  return { url, path }
}

export async function deleteStorageObject(path: string): Promise<void> {
  try {
    await deleteObject(ref(getStorageInstance(), path))
  } catch (e) {
    // object may already be gone — non-fatal
    console.warn('[firebase] deleteObject failed', e)
  }
}
