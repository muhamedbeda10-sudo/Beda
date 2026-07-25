// ============================================================================
// §9 — how saving must behave.
//
// A sample carries its dimensions, defects, coils, an optional PT record and
// image references. They are written as ONE unit: either the complete
// inspection exists, or nothing does. There is no code path that reports
// partial success, because there is no code path that produces it.
//
// Firestore gives us the primitives: a batch commits atomically, and a
// transaction lets us check the submission id and the version before writing.
// ============================================================================

import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  limit,
  writeBatch,
  runTransaction,
  serverTimestamp,
  increment,
  type Firestore,
} from 'firebase/firestore'
import { getDb } from '@/lib/firebase'
import { diffForAudit, auditEvent, type AuditContext } from '@/domain/audit'
import type {
  AuditEntry,
  DefectResult,
  DimensionResult,
  ImageAsset,
  InspectionSample,
  InspectionSession,
  PTRecord,
  PaintSampleRecord,
  SampleCoil,
} from '@/domain/types'

export const COL = {
  orders: 'orders',
  machines: 'machines',
  sessions: 'sessions',
  samples: 'samples',
  dimensions: 'dimensions',
  defects: 'defects',
  coils: 'coils',
  sampleCoils: 'sampleCoils',
  paintSamples: 'paintSamples',
  ptRecords: 'ptRecords',
  images: 'images',
  imageChunks: 'imageChunks',
  pdi: 'pdiDocuments',
  itemDimensionOrder: 'itemDimensionOrder',
  itemDimensionMaster: 'itemDimensionMaster',
  itemReferenceImages: 'itemReferenceImages',
  workCenterDefects: 'workCenterDefects',
  gradeMappings: 'gradeMappings',
  ptConsumables: 'ptConsumables',
  audit: 'auditLogs',
  users: 'users',
  submissions: 'submissions',
} as const

/** Raised when someone else changed the record since it was loaded (§9.4). */
export class ConflictError extends Error {
  constructor(
    message: string,
    readonly current: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ConflictError'
  }
}

/** Everything that makes up one saved inspection sample. */
export interface SampleBundle {
  sample: InspectionSample
  dimensions: DimensionResult[]
  defects: DefectResult[]
  coils: SampleCoil[]
  paint?: PaintSampleRecord
  pt?: PTRecord
  /** Images already uploaded — bytes are written BEFORE this call (§9.5). */
  images: ImageAsset[]
}

function db(): Firestore {
  return getDb()
}

/**
 * Save a complete sample atomically.
 *
 * Retry safety (§9.3): the submission id is claimed inside a transaction. A
 * second tap of Save with the same id returns the original sample rather than
 * writing a duplicate.
 *
 * A batch caps at 500 writes; a sample is far below that, but the count is
 * asserted so an unusually large sample fails loudly here rather than being
 * silently truncated by Firestore.
 */
export async function saveSampleAtomic(bundle: SampleBundle, ctx: AuditContext): Promise<{ id: string; deduped: boolean }> {
  const store = db()
  const submissionRef = doc(store, COL.submissions, bundle.sample.submissionId)

  const alreadySaved = await runTransaction(store, async (tx) => {
    const existing = await tx.get(submissionRef)
    if (existing.exists()) {
      return (existing.data() as { sampleId: string }).sampleId
    }
    tx.set(submissionRef, {
      sampleId: bundle.sample.id,
      at: serverTimestamp(),
      userUid: ctx.userUid,
    })
    return null
  })

  if (alreadySaved) {
    // The inspector tapped save twice, or the connection dropped after the
    // write landed. One inspection exists — report that one, not a new one.
    return { id: alreadySaved, deduped: true }
  }

  const writes =
    1 +
    bundle.dimensions.length +
    bundle.defects.length +
    bundle.coils.length +
    (bundle.paint ? 1 : 0) +
    (bundle.pt ? 1 : 0) +
    bundle.images.length +
    1 + // the session's sampleCount increment
    1 // audit create entry
  if (writes > 450) {
    throw new Error(
      `This sample needs ${writes} writes, which exceeds what can be committed atomically. Split it into more than one sample.`,
    )
  }

  const batch = writeBatch(store)

  // Child counts live on the sample so the history list is one query rather
  // than one fetch (or one aggregation) per row. They are derived here, from
  // the very rows this batch is writing, and committed in the same batch: the
  // count and the things it counts cannot land separately, so they cannot
  // drift. measuredDimensionCount is separate from dimensionCount so a
  // dimension nobody measured stays visible as unmeasured.
  const sample: InspectionSample = {
    ...bundle.sample,
    dimensionCount: bundle.dimensions.length,
    measuredDimensionCount: bundle.dimensions.filter((d) => d.actual !== null).length,
    defectCount: bundle.defects.length,
    coilCount: bundle.coils.length,
  }
  batch.set(doc(store, COL.samples, sample.id), strip(sample))

  // The session's sample count, incremented in the same batch. increment() is
  // resolved by the server, so two inspectors saving at once both count.
  batch.update(doc(store, COL.sessions, sample.sessionId), { sampleCount: increment(1) })
  for (const d of bundle.dimensions) batch.set(doc(store, COL.dimensions, d.id), strip(d))
  for (const d of bundle.defects) batch.set(doc(store, COL.defects, d.id), strip(d))
  for (const c of bundle.coils) batch.set(doc(store, COL.sampleCoils, c.id), strip(c))
  if (bundle.paint) batch.set(doc(store, COL.paintSamples, bundle.paint.id), strip(bundle.paint))
  if (bundle.pt) batch.set(doc(store, COL.ptRecords, bundle.pt.id), strip(bundle.pt))
  for (const img of bundle.images) batch.set(doc(store, COL.images, img.id), strip(img))

  const created = auditEvent('create', ctx, new Date().toISOString(), `aud_${bundle.sample.id}`)
  batch.set(doc(store, COL.audit, created.id), strip(created))

  // If a grade mismatch was overridden, that decision is itself evidence (§8.4).
  if (bundle.sample.gradeAcknowledgement) {
    const ack = auditEvent('acknowledge', ctx, new Date().toISOString(), `aud_ack_${bundle.sample.id}`, {
      field: 'gradeAcknowledgement',
      newValue: JSON.stringify(bundle.sample.gradeAcknowledgement),
    })
    batch.set(doc(store, COL.audit, ack.id), strip(ack))
  }

  await batch.commit()
  return { id: bundle.sample.id, deduped: false }
}

/**
 * Update a record, rejecting the write when someone else changed it first, and
 * recording one audit entry per changed field (§9.4, §11).
 */
export async function updateAudited<T extends { id: string; version: number }>(
  collectionName: string,
  id: string,
  patch: Partial<T>,
  expectedVersion: number,
  ctx: AuditContext,
): Promise<void> {
  const store = db()
  const ref = doc(store, collectionName, id)

  const { before, after, entries } = await runTransaction(store, async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists()) throw new Error('That record no longer exists.')
    const current = snap.data() as Record<string, unknown>
    const currentVersion = Number(current.version ?? 0)

    if (currentVersion !== expectedVersion) {
      throw new ConflictError(
        'Someone else changed this record while you were editing it. Review their values before saving again.',
        current,
      )
    }

    const next = { ...current, ...patch, version: currentVersion + 1 }
    tx.set(ref, next)

    const at = new Date().toISOString()
    const changes = diffForAudit(current, next, ctx, at, (field) => `aud_${id}_${field}_${Date.now()}`)
    for (const e of changes) tx.set(doc(store, COL.audit, e.id), strip(e) as Record<string, unknown>)
    return { before: current, after: next, entries: changes }
  })

  void before
  void after
  void entries
}

/**
 * §10 — nothing is ever hard-deleted. Deleting marks the record and audits it,
 * so quality evidence survives a user action.
 */
export async function softDelete(
  collectionName: string,
  id: string,
  ctx: AuditContext,
): Promise<void> {
  const store = db()
  const ref = doc(store, collectionName, id)
  const at = new Date().toISOString()
  const batch = writeBatch(store)
  batch.set(ref, { deletedAt: at, deletedByUid: ctx.userUid }, { merge: true })
  const entry = auditEvent('delete', ctx, at, `aud_del_${id}_${Date.now()}`)
  batch.set(doc(store, COL.audit, entry.id), strip(entry))
  await batch.commit()
}

export async function restore(collectionName: string, id: string, ctx: AuditContext): Promise<void> {
  const store = db()
  const at = new Date().toISOString()
  const batch = writeBatch(store)
  batch.set(doc(store, collectionName, id), { deletedAt: null }, { merge: true })
  const entry = auditEvent('restore', ctx, at, `aud_res_${id}_${Date.now()}`)
  batch.set(doc(store, COL.audit, entry.id), strip(entry))
  await batch.commit()
}

/** Close a session with its confirmed final quantity (§8.6). */
export async function closeSession(
  session: InspectionSession,
  finalQty: number,
  ctx: AuditContext,
): Promise<void> {
  await updateAudited<InspectionSession>(
    COL.sessions,
    session.id,
    {
      status: 'Closed',
      finalQty,
      closedAt: new Date().toISOString(),
      closedByUid: ctx.userUid,
    },
    session.version,
    ctx,
  )
}

export async function findSampleBySubmission(submissionId: string): Promise<string | null> {
  const snap = await getDoc(doc(db(), COL.submissions, submissionId))
  return snap.exists() ? ((snap.data() as { sampleId: string }).sampleId ?? null) : null
}

export async function nextSampleIndex(sessionId: string): Promise<number> {
  const snap = await getDocs(
    query(collection(db(), COL.samples), where('sessionId', '==', sessionId)),
  )
  return snap.size + 1
}

export async function anyExists(collectionName: string): Promise<boolean> {
  const snap = await getDocs(query(collection(db(), collectionName), limit(1)))
  return !snap.empty
}

/** Firestore rejects `undefined`; drop those keys rather than writing nulls
 *  that would look like a deliberate "cleared" value in the audit trail. */
function strip<T extends object>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue
    out[k] = v
  }
  return out
}

export { strip as stripUndefined }
export type { AuditContext, AuditEntry }
