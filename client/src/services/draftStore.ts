// ============================================================================
// §9.6 — survive a dead network.
//
// The wizard keeps a local draft. If the app is closed, reloaded, or goes
// offline mid-inspection, the inspector resumes exactly where they were with
// nothing retyped. Factory WiFi is unreliable; this is functional, not a nicety.
//
// Drafts are keyed by the person and the session: two sessions never
// overwrite each other, and on a shared tablet the next inspector to open a
// session starts their own sample — they never resume the previous person's
// half-entered one and save it under their own name. A draft carries the
// submission id so a resumed draft saved twice still lands once.
// ============================================================================

import type { Disposition, PTConsumableKind, PTVerdict, Process, ShiftLetter } from '@qc/shared/types'

// v4: drafts belong to the person who typed them (v3: they carry the
// machine's process and the PT record lists tested lengths). Older drafts are
// ignored rather than half-migrated — and a v3 draft cannot show whose it is,
// so it is never handed to whoever happens to open its session next: it is
// dropped from the device.
const PREFIX = 'qc-draft-v4:'
/** Drafts from before they had an owner (v1–v3). */
const UNOWNED = /^qc-draft(?:-v[123])?:/

export interface DraftCoil {
  /** Set when the coil was picked from the register; absent when typed by hand. */
  coilId?: string
  coilNumber: string
  grade?: string
  smType?: string
  supplier?: string
  thickness?: string
  width?: string
  yield?: string
  notes?: string
}

export interface DraftDimension {
  name: string
  sequence: number
  nominal: string
  tolPlus: string
  tolMinus: string
  actual: string
  unit: string
  source: 'item-order' | 'item-master' | 'carry-forward' | 'manual'
}

export interface DraftDefect {
  key: string
  defectName: string
  qty: string
  disposition: Disposition | null
  notes?: string
  /** Ids of images already uploaded for this defect. */
  imageIds: string[]
}

export interface DraftTestedLength {
  key: string
  lengthMm: string
  verdict?: PTVerdict
}

export interface DraftPT {
  consumableLots: Partial<Record<PTConsumableKind, string>>
  /** Entered on the setup step of a welding machine. */
  weldingWireBatch?: string
  /** The connector's coil number, entered under the welding wire on the setup step: required. */
  connectorCoilNumber?: string
  testedLengths: DraftTestedLength[]
  notes?: string
  imageIds: string[]
}

export interface DraftNote {
  text: string
  imageIds: string[]
}

export interface SampleDraft {
  /** The person who typed it: only they resume it. */
  userId: string
  sessionId: string
  orderId: string
  workCenterCode: string
  /** The machine's process when the draft was started; decides the steps. */
  process: Process
  /** Set when the draft re-records an existing sample from History. */
  editingSampleId?: string
  /** The version of the sample being re-recorded, for the conflict check. */
  editingVersion?: number
  /** Stable across retries — the server dedupes on it (§9.3). */
  submissionId: string
  step: string
  drawing: string
  drawingAlt?: string
  issue?: string
  sampleQty: string
  shift?: ShiftLetter
  coils: DraftCoil[]
  dimensions: DraftDimension[]
  defects: DraftDefect[]
  paint: { notes?: string; imageIds: string[] }
  pt?: DraftPT
  /** A remark about the order, written on the Review step; saved with the
   *  sample when it has text or a photo. Absent on drafts from before it existed. */
  note?: DraftNote
  gradeAcknowledged?: {
    coilNumbers: string[]
    expectedGrade: string
    foundGrades: string[]
    at: string
  }
  updatedAt: string
}

function key(userId: string, sessionId: string, editingSampleId?: string): string {
  const base = `${PREFIX}${userId}:${sessionId}`
  return editingSampleId ? `${base}:edit:${editingSampleId}` : base
}

/** Removes the drafts from before drafts had an owner: whose they are cannot be shown (see PREFIX). */
export function dropUnownedDrafts(): void {
  try {
    const doomed: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && UNOWNED.test(k)) doomed.push(k)
    }
    doomed.forEach((k) => localStorage.removeItem(k))
  } catch {
    /* storage unavailable: nothing was kept there either */
  }
}

/**
 * Whether the inspector has recorded anything in a draft yet. A draft they
 * only opened and left carries nothing worth keeping, and restoring it would
 * hide what the server knows now — the nominal typed on the previous sample,
 * a changed configuration — so such a draft is rebuilt rather than resumed.
 */
export function draftIsUntouched(d: SampleDraft): boolean {
  if (d.editingSampleId) return false
  if (d.sampleQty.trim() !== '') return false
  if (d.dimensions.some((x) => x.actual.trim() !== '')) return false
  if (d.defects.length > 0) return false
  if (d.paint.imageIds.length > 0 || (d.paint.notes ?? '').trim() !== '') return false
  if (d.note && (d.note.text.trim() !== '' || d.note.imageIds.length > 0)) return false
  if (d.pt && (d.pt.testedLengths.length > 0 || d.pt.imageIds.length > 0)) return false
  return true
}

/** This person's draft for the session (or for re-recording the sample), if they left one on this device. */
export function loadDraft(userId: string, sessionId: string, editingSampleId?: string): SampleDraft | null {
  if (!userId) return null
  dropUnownedDrafts()
  try {
    const raw = localStorage.getItem(key(userId, sessionId, editingSampleId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as SampleDraft
    if (!parsed?.sessionId || parsed.userId !== userId) return null
    return parsed
  } catch {
    return null
  }
}

export function saveDraft(draft: SampleDraft): void {
  // A draft with no owner could be resumed by anyone: it is not kept.
  if (!draft.userId) return
  try {
    localStorage.setItem(key(draft.userId, draft.sessionId, draft.editingSampleId), JSON.stringify({ ...draft, updatedAt: new Date().toISOString() }))
  } catch {
    // Storage full or unavailable — the inspector keeps working in memory.
    // Losing the draft is bad; blocking data entry over it would be worse.
    console.warn('[draft] could not persist')
  }
}

export function clearDraft(userId: string, sessionId: string, editingSampleId?: string): void {
  try {
    localStorage.removeItem(key(userId, sessionId, editingSampleId))
  } catch {
    /* nothing to do */
  }
}

/** This person's drafts on this device. */
export function listDrafts(userId: string): SampleDraft[] {
  const out: SampleDraft[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k?.startsWith(`${PREFIX}${userId}:`)) continue
      const raw = localStorage.getItem(k)
      if (!raw) continue
      const d = JSON.parse(raw) as SampleDraft
      if (d.userId === userId) out.push(d)
    }
  } catch {
    /* ignore */
  }
  return out
}

/** A draft counts as started once the inspector has entered anything at all —
 *  used to decide whether resuming is worth offering. */
export function draftHasContent(d: SampleDraft): boolean {
  return Boolean(
    d.coils.length ||
      d.defects.length ||
      d.dimensions.some((x) => x.actual.trim() !== '') ||
      d.paint.imageIds.length ||
      d.pt,
  )
}
