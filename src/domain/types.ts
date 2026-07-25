// ============================================================================
// QC Inspection System — domain model
// Mirrors the functional specification. Everything here is quality evidence:
// records are append-only in spirit (soft delete + audit), never overwritten.
// ============================================================================

export type ID = string
export type ISODate = string

// ---- Work centers ----------------------------------------------------------

/** Work-center codes in use. The code decides which wizard steps appear. */
export type WorkCenterCode = '7' | '11' | '22' | '48' | '58'

/** Work centers that get the Paint Sample step. */
export const PAINT_WORK_CENTERS: readonly WorkCenterCode[] = ['7', '11', '48']
/** Work centers that get the PT / Weld Inspection step. */
export const PT_WORK_CENTERS: readonly WorkCenterCode[] = ['22', '58']

export interface Machine {
  id: ID
  /** Work-center code, e.g. "58" */
  code: string
  /** Work-centre / process name, e.g. "A. Welding Line". */
  name: string
  /** Production line, e.g. "LM4". */
  line: string
  /** How the old app labelled a group: "58-A. Welding Line-LM4". */
  displayName: string
  machineNumber?: string
  factory?: string
  deletedAt?: ISODate
}

// ---- Production orders -----------------------------------------------------

export interface ProductionOrder {
  id: ID
  /** Business key used by imports (upsert matches on this). */
  orderNumber: string
  item: string
  itemCode: string
  workCenterCode: string
  machineId?: ID
  requiredQty: number
  finishedQty: number
  /** Read-only context shown before committing to an order. */
  drawing: string
  drawingAlt?: string
  issue?: string
  material: string
  /** Grade expected for this order — compared against coil grades (§8.4). */
  expectedGrade: string
  customer: string
  type: string
  colour: string
  date: ISODate
  /** Dataverse GUID — lets any row be traced back to the source system. */
  legacyId?: string
  /** cr863_orderid, the numeric key the old system matched on. */
  legacyOrderId?: string
  /** Fields with no home in this model, kept verbatim so nothing is lost. */
  legacy?: Record<string, unknown>
  deletedAt?: ISODate
}

export function remainingQty(o: Pick<ProductionOrder, 'requiredQty' | 'finishedQty'>): number {
  return Math.max(0, o.requiredQty - o.finishedQty)
}

// ---- Sessions --------------------------------------------------------------

export type SessionStatus = 'Open' | 'Closed'

export interface InspectionSession {
  id: ID
  seq: number
  orderId: ID
  workCenterCode: string
  inspectorUid: ID
  inspectorName: string
  startedAt: ISODate
  status: SessionStatus
  /** Baseline quantity confirmed when the session was first used (§4). */
  startQtyConfirmed?: {
    qty: number
    byUid: ID
    byName: string
    at: ISODate
  }
  /** Final produced quantity captured when closing. */
  finalQty?: number
  closedAt?: ISODate
  closedByUid?: ID
  deletedAt?: ISODate
  /** Optimistic-concurrency token (§9.4). */
  version: number
}

// ---- Samples ---------------------------------------------------------------

export type ShiftLetter = 'A' | 'B' | 'C'

export interface InspectionSample {
  id: ID
  sessionId: ID
  orderId: ID
  index: number
  /** Derived from createdAt, never typed (§8.1). */
  shift: ShiftLetter
  createdAt: ISODate
  inspectorUid: ID
  inspectorName: string
  drawing: string
  drawingAlt?: string
  issue?: string
  sampleQty: number
  /** Grade-mismatch override, recorded when the inspector acknowledged (§8.4). */
  gradeAcknowledgement?: {
    byUid: ID
    byName: string
    at: ISODate
    coilIds: string[]
    expectedGrade: string
    foundGrades: string[]
  }
  /** Client-generated id making retries idempotent (§9.3). */
  submissionId: string
  deletedAt?: ISODate
  version: number
}

// ---- Dimensions ------------------------------------------------------------

export type DimensionStatus = 'Pass' | 'Fail' | 'Warning' | 'Pending'

export interface DimensionResult {
  id: ID
  sampleId: ID
  name: string
  sequence: number
  /** Null where the source recorded a measurement with no specification to
   *  judge it against — such a row is Pending, never Pass. */
  nominal: number | null
  tolPlus: number | null
  tolMinus: number | null
  actual: number | null
  unit: string
  status: DimensionStatus
  /** Where nominal/tolerance came from (§8.3) — useful when auditing. */
  source: 'item-order' | 'item-master' | 'carry-forward' | 'manual' | 'legacy'
  deletedAt?: ISODate
}

// ---- Defects ---------------------------------------------------------------

/** Every defect must carry one of these — no defect saves without it (§8.5). */
export type Disposition =
  | 'Rejected'
  | 'Hold'
  | 'Repair'
  | 'Used in another order'
  | 'Accept with concession'

export const DISPOSITIONS: readonly Disposition[] = [
  'Rejected',
  'Hold',
  'Repair',
  'Used in another order',
  'Accept with concession',
]

export interface DefectResult {
  id: ID
  sampleId: ID
  defectName: string
  qty: number
  /** Optional at edit time; mandatory before save (§5.4). */
  disposition: Disposition | null
  notes?: string
  imageIds: ID[]
  deletedAt?: ISODate
}

// ---- Coils -----------------------------------------------------------------

export interface Coil {
  id: ID
  /** Business key — coil number stamped on the raw material. */
  coilNumber: string
  grade?: string
  smType?: string
  supplier?: string
  thickness?: number
  width?: number
  yield?: number
  notes?: string
  deletedAt?: ISODate
}

/** A coil as attached to one sample (snapshot — the catalogue may change later). */
export interface SampleCoil {
  id: ID
  sampleId: ID
  coilNumber: string
  grade?: string
  smType?: string
  supplier?: string
  thickness?: number
  width?: number
  yield?: number
  notes?: string
  deletedAt?: ISODate
}

// ---- Paint sample ----------------------------------------------------------

export interface PaintSampleRecord {
  id: ID
  sampleId: ID
  notes?: string
  imageIds: ID[]
  deletedAt?: ISODate
}

// ---- PT / weld -------------------------------------------------------------

export type PTConsumableKind = 'Cleaner' | 'Penetrant' | 'Developer'

export interface PTRecord {
  id: ID
  sampleId: ID
  /** Must be greater than 5 (§5.6). */
  testFrequencyPct: number
  /** Lot/batch per consumable kind — the chemical audit trail, all mandatory. */
  consumableLots: Record<PTConsumableKind, string>
  sampleSize?: string
  testedWeldLength?: string
  indicationType?: string
  indicationSize?: string
  weldingWireBatch?: string
  acceptOrRepair?: 'Accept' | 'Reject / Repair'
  finalResult?: string
  notes?: string
  imageIds: ID[]
  deletedAt?: ISODate
}

// ---- Images ----------------------------------------------------------------

/** Metadata for a stored image. The bytes live behind the image store driver;
 *  the hash is what proves the file was never swapped (§10). */
export interface ImageAsset {
  id: ID
  /** Key the storage driver resolves — never a client-supplied filename. */
  storageKey: string
  driver: 'firestore' | 'cloud-storage'
  originalFilename: string
  mimeType: string
  byteSize: number
  width: number
  height: number
  sha256: string
  uploadedByUid: ID
  uploadedByName: string
  uploadedAt: ISODate
  /** Small preview used in lists so a 50-photo page doesn't stall (§10.7). */
  thumbnailDataUrl?: string
  /** Context so an orphan can be traced/cleaned. */
  sessionId?: ID
  sampleId?: ID
  orderId?: ID
  deletedAt?: ISODate
}

// ---- PDI -------------------------------------------------------------------

export interface PDIDocument {
  id: ID
  orderId: ID
  notes?: string
  imageIds: ID[]
  createdAt: ISODate
  createdByUid: ID
  deletedAt?: ISODate
}

// ---- Admin / master data ---------------------------------------------------

/** Dimension order per item — drives pre-fill and display sequence (§7). */
export interface ItemDimensionOrder {
  id: ID
  item: string
  dimensionName: string
  sequence: number
  nominal?: number
  tolPlus: number
  tolMinus: number
  unit: string
  deletedAt?: ISODate
}

/** Item master dimension — fallback when no per-item order entry exists. */
export interface ItemDimensionMaster {
  id: ID
  item: string
  dimensionName: string
  /** Optional: the source carries tolerances only. */
  nominal?: number
  tolPlus: number
  tolMinus: number
  unit: string
  deletedAt?: ISODate
}

export interface ItemReferenceImage {
  id: ID
  item: string
  imageId: ID
  caption?: string
  deletedAt?: ISODate
}

/** Which dimensions a work centre filters to. The source holds a single row
 *  (Paint Thickness @ 48) — incomplete configuration, migrated verbatim. */
export interface WorkCenterDimension {
  id: ID
  workCenterCode: string
  dimensionName: string
  deletedAt?: ISODate
}

/** Which defect names are offered on which work center (§5.1). */
export interface WorkCenterDefect {
  id: ID
  workCenterCode: string
  defectName: string
  deletedAt?: ISODate
}

/** A pair of equivalent grade names. Equivalence is transitive (§8.4). */
export interface GradeMapping {
  id: ID
  gradeA: string
  gradeB: string
  deletedAt?: ISODate
}

export interface PTConsumableProduct {
  id: ID
  kind: PTConsumableKind
  productName: string
  lotBatch: string
  deletedAt?: ISODate
}

// ---- Audit -----------------------------------------------------------------

export type AuditAction = 'create' | 'update' | 'delete' | 'restore' | 'purge' | 'acknowledge'

/** Field-level change record. Written for every edit after the initial save. */
export interface AuditEntry {
  id: ID
  at: ISODate
  userUid: ID
  userName: string
  action: AuditAction
  entity: string
  entityId: ID
  field?: string
  oldValue?: string
  newValue?: string
  /** Context so the change can be found again (§11). */
  orderNumber?: string
  item?: string
  workCenterCode?: string
  sessionId?: ID
  sampleId?: ID
}

// ---- Users -----------------------------------------------------------------

export type Role = 'inspector' | 'supervisor' | 'admin'

export interface UserProfile {
  uid: ID
  email: string
  name: string
  role: Role
}
