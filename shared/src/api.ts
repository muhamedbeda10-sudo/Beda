// ============================================================================
// HTTP contract between the client and the API.
//
// Every request body and response shape the two sides exchange is named here,
// so a change on one side fails to compile on the other. Domain entities come
// from ./types; this file only adds the request envelopes and the composed
// read models that screens actually need (a session together with its order,
// a sample together with its children, and so on).
// ============================================================================

import type { KpiThresholds } from './kpi'
import type {
  ChatConversation,
  ChatMessage,
  NoticeForUser,
  NoticeSeverity,
  NoticeTarget,
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
  ItemDimensionOrder,
  ItemReferenceImage,
  Machine,
  PaintSampleRecord,
  PDIDocument,
  Process,
  ProductionOrder,
  PTConsumableKind,
  PTConsumableProduct,
  PTRecord,
  PTVerdict,
  Role,
  SampleCoil,
  SessionStatus,
  UserProfile,
  WorkCenterDefect,
  WorkInstruction,
  WorkInstructionScope,
  WorkInstructionStep,
  SessionNote,
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
  username: string
  password: string
}

export interface RegisterRequest {
  username: string
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
  username: string
  password: string
  name: string
  role: Role
}

export interface UpdateUserRequest {
  /** A new login name; must still be free. */
  username?: string
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
  'item-reference-images',
  'work-center-defects',
  'grade-mappings',
  'pt-consumables',
] as const

export type MasterKind = (typeof MASTER_KINDS)[number]

export interface MasterRecordByKind {
  machines: Machine
  'item-dimension-order': ItemDimensionOrder
  'item-reference-images': ItemReferenceImage
  'work-center-defects': WorkCenterDefect
  'grade-mappings': GradeMapping
  'pt-consumables': PTConsumableProduct
}

/** Filters a screen may apply server-side. Unknown filters are ignored. */
export interface MasterListQuery {
  itemCode?: string
  workCenterCode?: string
  factory?: string
}

// ---- Orders & coils --------------------------------------------------------

export interface OrderSearchQuery {
  /** Prefix matched against the order number, the item code and the line key. */
  search?: string
  /** Cancelled lines are left out unless this is set. */
  includeCancelled?: boolean
  /** Only lines produced on this machine. */
  machine?: string
  /** Only the lines of this order (exact, case-insensitive). */
  orderNumber?: string
  limit?: number
}

/** One order as the new-inspection screen lists it: the number plus how many
 *  lines it has on the machine being filtered. */
export interface OrderNumberSummary {
  orderNumber: string
  customer: string
  lineCount: number
}

/** Rows as they appear in a CSV import. Unset fields leave the existing value
 *  alone so a partial file can correct one column without wiping the rest.
 *  A line that does not exist yet must carry its order number. */
export type OrderImportRow = Partial<Omit<ProductionOrder, 'id' | 'deletedAt' | 'machineId'>> & {
  lineKey: string
}

export type CoilImportRow = Partial<Omit<Coil, 'id' | 'deletedAt'>> & { coilNumber: string }

export type DimensionOrderImportRow = Partial<Omit<ItemDimensionOrder, 'id' | 'deletedAt'>> & {
  itemCode: string
  dimensionName: string
}

export type MachineImportRow = Partial<Omit<Machine, 'id' | 'deletedAt'>> & { code: string; name: string }

export type DefectImportRow = { workCenterCode: string; defectName: string }

export interface ImportRequest<Row> {
  rows: Row[]
}

export interface ImportResult {
  inserted: number
  updated: number
}

/** Answer to clearing the order catalogue before a fresh export is loaded. */
export interface ClearOrdersResult {
  /** Lines marked deleted. Sessions recorded against them keep their history. */
  removed: number
}

/** Which business keys already exist — lets the importer preview new vs update. */
export interface ExistingKeysRequest {
  keys: string[]
}

/**
 * Most business keys one `existing-keys` request may ask about. The client
 * splits a larger file into requests of this size; the API rejects more.
 */
export const EXISTING_KEYS_MAX = 5000

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
  'id' | 'lineKey' | 'orderNumber' | 'item' | 'itemCode' | 'workCenterCode' | 'customer' | 'expectedGrade' | 'erpStatus'
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

/**
 * Start a session. Against an order line: the line and the quantity already
 * rejected before release. On a make-to-stock machine: the machine and how
 * many pieces came out — the API keeps the machine's fixed STOCK line.
 */
export type StartSessionRequest = { orderId: string; startQty: number } | { workCenterCode: string; producedQty: number }

export interface CloseSessionRequest {
  finalQty: number
  /** Version the client loaded — the close is rejected if it moved. */
  version: number
}

/** What the wizard needs to open: the session, its order line, and the
 *  configuration for that line's item and machine, in one round trip. */
export interface WizardContext {
  session: InspectionSession
  order: ProductionOrder
  /** The machine the line runs on, when it is in the register. */
  machine: Machine | null
  /** General rows for the item plus the rows specific to this machine.
   *  Empty when the machine is set to take dimensions from the inspector. */
  dimensionOrder: ItemDimensionOrder[]
  referenceImages: ItemReferenceImage[]
  workCenterDefects: WorkCenterDefect[]
  gradeMappings: GradeMapping[]
  ptConsumables: PTConsumableProduct[]
  /** Samples already saved in this session, oldest first. */
  samples: SampleSummary[]
  /** The dimension rows of the most recent sample of this item on this
   *  machine — this session's own latest sample when it has one — so the
   *  nominal the inspector typed once is offered again. */
  previousDimensions: PreviousDimension[]
  /** The process the session's machine runs; decides the wizard's steps. */
  process: Process
  /** The welding wire batch of this session's latest sample, offered again. */
  previousWeldingWireBatch: string | null
  /** The setup of this session's latest sample — drawing, issue, coils and
   *  an acknowledged grade mismatch. Setup is entered once per session, so
   *  the next sample starts from it and skips the Setup step. Null on the
   *  first sample. */
  previousSetup: PreviousSetup | null
  /** Every note written on this order line so far — the same order, item and
   *  machine, across its sessions — newest first, so the Review step shows
   *  what is already known here. */
  orderNotes: SessionNote[]
  /** The controlled documents that apply to this process, by step. */
  workInstructions: WorkInstruction[]
}

export interface PreviousSetup {
  drawing: string
  drawingAlt: string | null
  issue: string | null
  coils: SaveCoilInput[]
  gradeAcknowledgement: { coilNumbers: string[]; expectedGrade: string; foundGrades: string[] } | null
}

// ---- Work instructions -----------------------------------------------------

/** Multipart fields sent with the PDF (`file`) when uploading a work instruction. */
export interface UploadWorkInstructionFields {
  code: string
  title: string
  issueNo: string
  issueDate?: string
  process: WorkInstructionScope
  step: WorkInstructionStep
}

export interface UpdateWorkInstructionRequest {
  title?: string
  issueNo?: string
  issueDate?: string | null
  process?: WorkInstructionScope
  step?: WorkInstructionStep
  sortOrder?: number
}

/** A dimension row as it was saved on an earlier sample. */
export interface PreviousDimension {
  name: string
  nominal: number | null
  tolPlus: number | null
  tolMinus: number | null
  unit: string
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
  /** The catalogue coil that was picked. Omitted for a number typed by hand. */
  coilId?: string
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
  /** The welding wire batch number, entered on the setup step. */
  weldingWireBatch?: string
  /** At least one tested length, each with its verdict. */
  testedLengths: Array<{ lengthMm: number; verdict: PTVerdict }>
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
  /** A remark about the order, written on the Review step. Ignored when it
   *  has neither text nor photos; otherwise saved with the sample as one unit. */
  note?: SaveNoteInput
  gradeAcknowledgement?: {
    coilNumbers: string[]
    expectedGrade: string
    foundGrades: string[]
    at: string
  }
}

/**
 * Re-record a sample from History: the whole record is replaced as one unit.
 * The previous measurements, defects, coils, paint and PT rows are marked
 * deleted and the new ones written; the sample keeps its number, shift,
 * time and inspector. Refused when the sample moved since it was loaded.
 */
export interface ReRecordSampleRequest extends Omit<SaveSampleRequest, 'submissionId'> {
  version: number
}

export interface ReRecordSampleResponse {
  sampleId: string
  index: number
  version: number
}

export interface ReopenSessionRequest {
  version: number
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

// ---- Order notes -----------------------------------------------------------

export interface SaveNoteInput {
  text?: string
  imageIds: string[]
}

/** Notes written during one session, newest first. */
export interface SessionNotesResponse {
  notes: SessionNote[]
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

// ---- §15 Dashboard ---------------------------------------------------------

export interface KpiThresholdsResponse {
  thresholds: KpiThresholds
  updatedAt?: string
  updatedByName?: string
}

// ---- §16 Notices -----------------------------------------------------------

export interface SaveNoticeRequest {
  title: string
  body: string
  severity: NoticeSeverity
  requiresAck: boolean
  validFrom: string
  validTo: string | null
  targets: NoticeTarget[]
  imageIds: string[]
  fileIds: string[]
}

export interface NoticeInboxResponse {
  notices: NoticeForUser[]
  /** Active notices still to be read or acknowledged. */
  pendingCount: number
}

/** Where a reader is about to work: an existing session, or a machine and line before one starts. */
export type MatchNoticesRequest = { sessionId: string } | { workCenterCode: string; orderId?: string }

export interface MatchNoticesResponse {
  notices: NoticeForUser[]
}

export interface AcknowledgeNoticeRequest {
  context?: { sessionId?: string; workCenterCode?: string; orderNumber?: string; itemCode?: string }
}

// ---- §17 Chat --------------------------------------------------------------

export interface ChatConversationsResponse {
  conversations: ChatConversation[]
  unreadTotal: number
  mentionTotal: number
}

export interface ChatUnreadResponse {
  unreadTotal: number
  mentionTotal: number
}

export interface ChatMessagesResponse {
  messages: ChatMessage[]
  /** Older messages exist before the first one returned. */
  hasMore: boolean
}

export interface SendChatMessageRequest {
  /** Idempotency key made on the device, so a retried send never duplicates. */
  clientId: string
  body: string
  replyToId?: string | null
  imageIds?: string[]
  fileIds?: string[]
}

export interface EditChatMessageRequest {
  body: string
}

export type CreateConversationRequest = { kind: 'direct'; userId: string } | { kind: 'group'; name: string; memberIds: string[] }

export interface UpdateGroupRequest {
  name?: string
  addMemberIds?: string[]
  removeMemberIds?: string[]
}

export interface ToggleReactionRequest {
  emoji: string
}
