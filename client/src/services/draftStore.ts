// ============================================================================
// §9.6 — survive a dead network.
//
// The wizard keeps a local draft. If the app is closed, reloaded, or goes
// offline mid-inspection, the inspector resumes exactly where they were with
// nothing retyped. Factory WiFi is unreliable; this is functional, not a nicety.
//
// Drafts are keyed by session so two sessions never overwrite each other, and
// carry the submission id so a resumed draft saved twice still lands once.
// ============================================================================

import type { Disposition, PTConsumableKind, ShiftLetter } from '@qc/shared/types'

// v2: submission ids are UUIDs (the API validates them). Older drafts are ignored.
const PREFIX = 'qc-draft-v2:'

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

export interface DraftPT {
  testFrequencyPct: string
  consumableLots: Partial<Record<PTConsumableKind, string>>
  sampleSize?: string
  testedWeldLength?: string
  indicationType?: string
  indicationSize?: string
  weldingWireBatch?: string
  acceptOrRepair?: 'Accept' | 'Reject / Repair'
  finalResult?: string
  notes?: string
  imageIds: string[]
}

export interface SampleDraft {
  sessionId: string
  orderId: string
  workCenterCode: string
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
  gradeAcknowledged?: {
    coilNumbers: string[]
    expectedGrade: string
    foundGrades: string[]
    at: string
  }
  updatedAt: string
}

function key(sessionId: string): string {
  return `${PREFIX}${sessionId}`
}

export function loadDraft(sessionId: string): SampleDraft | null {
  try {
    const raw = localStorage.getItem(key(sessionId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as SampleDraft
    if (!parsed?.sessionId) return null
    return parsed
  } catch {
    return null
  }
}

export function saveDraft(draft: SampleDraft): void {
  try {
    localStorage.setItem(key(draft.sessionId), JSON.stringify({ ...draft, updatedAt: new Date().toISOString() }))
  } catch {
    // Storage full or unavailable — the inspector keeps working in memory.
    // Losing the draft is bad; blocking data entry over it would be worse.
    console.warn('[draft] could not persist')
  }
}

export function clearDraft(sessionId: string): void {
  try {
    localStorage.removeItem(key(sessionId))
  } catch {
    /* nothing to do */
  }
}

export function listDrafts(): SampleDraft[] {
  const out: SampleDraft[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k?.startsWith(PREFIX)) continue
      const raw = localStorage.getItem(k)
      if (!raw) continue
      out.push(JSON.parse(raw) as SampleDraft)
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
