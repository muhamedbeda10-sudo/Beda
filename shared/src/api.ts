// ============================================================================
// HTTP contract between the client and the API.
//
// Every request body and response shape the two sides exchange is named here,
// so a change on one side fails to compile on the other. Domain entities come
// from ./types; this file only adds the request envelopes and the composed
// read models that screens actually need (a session together with its order,
// a sample together with its children, and so on).
// ============================================================================

import type {
  AuditAction,
  AuditEntry,
  Coil,
  DefectResult,
  DimensionResult,
  DimensionSource,
  Disposition,
  GradeMapping,
  ImageAsset,
  InspectionSample,
  InspectionSession,
  ItemDimensionMaster,
  ItemDimensionOrder,
  ItemReferenceImage,
  Machine,
  PDIDocument,
  PTConsumableKind,
  PTConsumableProduct,
  PTRecord,
  PTVerdict,
  PaintSampleRecord,
  ProductionOrder,
  Role,
  SampleCoil,
  SessionStatus,
  UserProfile,
  WorkCenterDefect,
} from './types'

// ---- Errors ----------------------------------------------------------------

export type ApiErrorCode =
  | 'validation'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'duplicate'
  | 'rate_limited'
  | 'payload_too_large'
  | 'internal'

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode
    message: string
    /** Field-level problems for `validation`; the current row for `conflict`. */
    details?: unknown
  }
}

// ---- Auth ------------------------------------------------------------------

export interface LoginRequest {
  email: string
  password: string
}

export interface RegisterRequest {
  email: string
  password: string
  name: string
}

export interface AuthResponse {
  accessToken: string
  /** Seconds until the access token expires. */
  expiresIn: number
  user: UserProfile
}

export interface AuthConfigResponse {
  /** Whether the login screen offers "Create account". */
  selfRegistrationOpen: boolean
  /** IANA zone the factory runs on; the client derives the displayed shift in it. */
  factoryTimeZone: string
}

// ---- Users (admin) ---------------------------------------------------------

export interface CreateUserRequest {
  email: string
  password: string
  name: string
  role: Role
}

export interface UpdateUserRequest {
  name?: string
  role?: Role
  isActive?: boolean
  /** Admin-set replacement password. */
  password?: string
}

// ---- Master data -----------------------------------------------------------

export const MASTER_KINDS = [
  'machines',
  'item-dimension-order',
  'item-dimension-master',
  'item-reference-images',
  'work-center-defects',
  'grade-mappings',
  'pt-consumables',
] as const

export type MasterKind = (typeof MASTER_KINDS)[number]

export interface MasterRecordByKind {
  machines: Machine
  'item-dimension-order': ItemDimensionOrder
  'item-dimension-master': ItemDimensionMaster
  'item-reference-images': ItemReferenceImage
  'work-center-defects': WorkCenterDefect
  'grade-mappings': GradeMapping
  'pt-consumables': PTConsumableProduct
}

/** Filters a screen may apply server-side. Unknown filters are rejected. */
export interface MasterListQuery {
  item?: string
  workCenterCode?: string
}

// ---- Orders & coils --------------------------------------------------------

export interface OrderSearchQuery {
  /** Prefix matched against the order number and the item code. */
  search?: string
  limit?: number
}

/** Rows as they appear in a CSV import. Unset fields leave the existing value
 *  alone so a partial file can correct one column without wiping the rest. */
export type OrderImportRow = Partial<Omit<ProductionOrder, 'id' | 'deletedAt' | 'machineId'>> & {
  orderNumber: string
}

export type CoilImportRow = Partial<Omit<Coil, 'id' | 'deletedAt'>> & { coilNumber: string }

export type DimensionOrderImportRow = Partial<Omit<ItemDimensionOrder, 'id' | 'deletedAt'>> & {
  item: string
  dimensionName: string
}

export interface ImportRequest<Row> {
  rows: Row[]
}

export interface ImportResult {
  inserted: number
  updated: number
}

/** Which business keys already exist — lets the importer preview new vs update. */
export interface ExistingKeysRequest {
  keys: string[]
}

export interface ExistingKeysResponse {
  /** Normalised keys that already exist (lower-cased, trimmed). */
  existing: string[]
}

/** Coil traceability: coil → sample → order → customer. */
export interface CoilUsage {
  coilNumber: string
  sampleId: string
  sampleIndex: number
  orderId: string
  orderNumber: string
  customer: string
}

// ---- Sessions --------------------------------------------------------------

/** The order fields every session list needs alongside the session. */
export type OrderSummary = Pick<
  ProductionOrder,
  'id' | 'orderNumber' | 'item' | 'itemCode' | 'workCenterCode' | 'customer' | 'expectedGrade'
>

export type SampleSummary = Pick<
  InspectionSample,
  | 'id'
  | 'sessionId'
  | 'index'
  | 'shift'
  | 'createdAt'
  | 'inspectorName'
  | 'sampleQty'
  | 'dimensionCount'
  | 'measuredDimensionCount'
  | 'defectCount'
  | 'coilCount'
>

export interface SessionWithOrder extends InspectionSession {
  order: OrderSummary | null
}

export interface OpenSessionsResponse {
  sessions: SessionWithOrder[]
  /** Samples of those sessions, so the board shows what has been recorded. */
  samples: SampleSummary[]
  /** Defects currently dispositioned Hold, across the factory. */
  holdCount: number
}

export interface SessionListQuery {
  status?: SessionStatus
  limit?: number
}

export interface StartSessionRequest {
  orderId: string
  startQty: number
}

export interface CloseSessionRequest {
  finalQty: number
  /** Version the client loaded — the close is rejected if it moved. */
  version: number
}

/** What the wizard needs to open: the session, its order, and the configuration
 *  for that order's item and work centre, in one round trip. */
export interface WizardContext {
  session: InspectionSession
  order: ProductionOrder
  dimensionOrder: ItemDimensionOrder[]
  dimensionMaster: ItemDimensionMaster[]
  referenceImages: ItemReferenceImage[]
  workCenterDefects: WorkCenterDefect[]
  gradeMappings: GradeMapping[]
  ptConsumables: PTConsumableProduct[]
  /** Samples already saved in this session, oldest first. */
  samples: SampleSummary[]
}

/** The order's inspection history, shown before a session is started. */
export interface OrderHistory {
  sessions: InspectionSession[]
  samples: SampleSummary[]
}

// ---- Samples ---------------------------------------------------------------

export interface SaveDimensionInput {
  name: string
  sequence: number
  nominal: number | null
  tolPlus: number | null
  tolMinus: number | null
  actual: number | null
  unit: string
  source: DimensionSource
}

export interface SaveDefectInput {
  defectName: string
  qty: number
  disposition: Disposition
  notes?: string
  imageIds: string[]
}

export interface SaveCoilInput {
  coilNumber: string
  grade?: string
  smType?: string
  supplier?: string
  thickness?: number
  width?: number
  yield?: number
  notes?: string
}

export interface SavePTInput {
  testFrequencyPct: number
  consumableLots: Record<PTConsumableKind, string>
  sampleSize?: string
  testedWeldLength?: string
  indicationType?: string
  indicationSize?: string
  weldingWireBatch?: string
  acceptOrRepair?: PTVerdict
  finalResult?: string
  notes?: string
  imageIds: string[]
}

/**
 * A complete inspection sample, saved as one unit (§9). Either everything in
 * it exists afterwards, or nothing does.
 */
export interface SaveSampleRequest {
  /** Client-generated UUID. A retry with the same id returns the first save. */
  submissionId: string
  drawing: string
  drawingAlt?: string
  issue?: string
  sampleQty: number
  dimensions: SaveDimensionInput[]
  defects: SaveDefectInput[]
  coils: SaveCoilInput[]
  paint?: { notes?: string; imageIds: string[] }
  pt?: SavePTInput
  gradeAcknowledgement?: {
    coilNumbers: string[]
    expectedGrade: string
    foundGrades: string[]
    at: string
  }
}

export interface SaveSampleResponse {
  sampleId: string
  index: number
  /** True when the submission id had already been saved. */
  deduped: boolean
}

/** One sample with everything recorded against it. */
export interface SampleDetail {
  sample: InspectionSample
  dimensions: DimensionResult[]
  defects: DefectResult[]
  coils: SampleCoil[]
  paint: PaintSampleRecord | null
  pt: PTRecord | null
}

export interface CorrectDimensionRequest {
  actual: number | null
  version: number
}

export interface CorrectDefectRequest {
  disposition: Disposition
  qty: number
  version: number
}

// ---- History ---------------------------------------------------------------

export interface HistoryQuery {
  limit?: number
  /** Land on the sessions that own a defect with this disposition. */
  disposition?: Disposition
}

export interface HistoryResponse {
  sessions: SessionWithOrder[]
}

// ---- Images ----------------------------------------------------------------

export interface UploadImageFields {
  originalFilename: string
  mimeType: string
  width: number
  height: number
  sha256: string
  thumbnailDataUrl: string
  sessionId?: string
  sampleId?: string
  orderId?: string
}

export type ImageAssetResponse = ImageAsset

// ---- PDI -------------------------------------------------------------------

export interface PDIWithOrder extends PDIDocument {
  order: OrderSummary | null
}

export interface CreatePDIRequest {
  orderId: string
  notes?: string
  imageIds: string[]
}

// ---- Audit -----------------------------------------------------------------

export interface AuditQuery {
  limit?: number
}

export interface AuditStats {
  total: number
  byAction: Partial<Record<AuditAction, number>>
}

export interface AuditListResponse {
  entries: AuditEntry[]
}

export interface PurgeAuditRequest {
  ids: string[]
}

// ---- Health ----------------------------------------------------------------

export interface HealthResponse {
  ok: boolean
  version: string
  database: 'up' | 'down'
}
