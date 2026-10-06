// ============================================================================
// HTTP contract between the client and the API.
//
// Every request body and response shape the two sides exchange is named here,
// so a change on one side fails to compile on the other. Domain entities come
// from ./types; this file only adds the request envelopes and the composed
// read models that screens actually need (a session together with its order,
// a sample together with its children, and so on).
// ============================================================================

import type { DashboardLayouts, KpiThresholds } from './kpi'
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
  StageQuantity,
  UniversalKind,
  SampleCoil,
  SessionStatus,
  UserProfile,
  WorkCenterDefect,
  WorkInstruction,
  WorkInstructionScope,
  WorkInstructionStep,
  SessionNote,
  NoticeMatchMode,
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
  | 'holdCount'
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

/**
 * §4.4 — a session exists only once it has recorded something: the start
 * and the first sample arrive together and are written as one transaction.
 */
export interface StartWithSampleRequest {
  start: StartSessionRequest
  sample: SaveSampleRequest
}

export interface StartWithSampleResponse {
  session: SessionWithOrder
  sample: SaveSampleResponse
  /** The line already had an open session and the sample was recorded in it. */
  joined: boolean
}

/**
 * On a universal machine, what a closing session was: a final product (its
 * quantity is `finalQty`), or the stages it covered with each one's quantity.
 */
export type UniversalCloseChoice = { kind: 'final' } | { kind: 'staged'; stages: StageQuantity[] }

export interface CloseSessionRequest {
  /** The quantity made. On a universal machine's staged session it is the highest stage's, and may be left out. */
  finalQty?: number
  /** On a universal machine (not make-to-stock): final product or stages. The line's first close chooses; later ones follow it. */
  universal?: UniversalCloseChoice
  /** An older client's one stage, read as that stage at `finalQty`. */
  stage?: number
  /** Version the client loaded — the close is rejected if it moved. */
  version: number
}

/** What the close asks of a session on a universal machine. */
export interface SessionStagesResponse {
  /** True on a universal machine (not make-to-stock): the close asks final product or stages. */
  universal: boolean
  /** What the line's first closed session made it; null while no other session on it is closed. */
  lineKind: UniversalKind | null
  /** The stages the line's other sessions covered, with how many sessions each. */
  stages: { stage: number; sessions: number }[]
  /** The stage a new one would be: one past the highest. */
  next: number
}

/** What the wizard needs to open: the session, its order line, and the
 *  configuration for that line's item and machine, in one round trip. */
export interface WizardContext {
  /** Null in a preview: the session is created with the first sample (§4.4). */
  session: InspectionSession | null
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
  /** No longer typed: the requirement is 5% of the final quantity. Accepted from older clients only. */
  testFrequencyPct?: number
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

/**
 * §4 — correct a session's quantities after the fact: the quantity rejected
 * before release (typed when an order session opened), the quantity produced
 * (a make-to-stock session), and the final quantity (typed when it closed).
 * Send the ones to change; each is audited like any other correction.
 */
export interface UpdateSessionQuantitiesRequest {
  startQty?: number
  producedQty?: number
  finalQty?: number
  /** A closed session on a universal machine: final product or its stages and their quantities, corrected. */
  universal?: UniversalCloseChoice
  /** Version the client loaded — the change is rejected if it moved. */
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

/** §7 — the defects of one session across its samples, each with the
 *  sample it was recorded on, for deciding Holds from the board. */
export interface SessionDefectsResponse {
  defects: (DefectResult & { sampleIndex: number })[]
}

export interface CorrectDefectRequest {
  disposition: Disposition
  qty: number
  /** Another of the machine's defects, or "Other" (then `notes` describes it). Left out, the type stays. */
  defectName?: string
  /** Left out, the notes stay; null or empty clears them. Required when the defect is "Other". */
  notes?: string | null
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

// ---- Every photo of a session, by what it shows (§10.8) --------------------

export type SessionImageKind = 'defect' | 'paint' | 'pt' | 'note'

export interface SessionImageItem {
  imageId: string
  /** The sample the photo belongs to; a note written outside a sample has none. */
  sampleId: string | null
  sampleIndex: number | null
  /** What the photo is of: the defect name, the note's first words, "Paint", "PT". */
  label: string
  takenAt: string
}

export interface SessionImageGroup {
  kind: SessionImageKind
  items: SessionImageItem[]
}

export interface SessionImagesResponse {
  /** In a fixed order: defects, paint, PT, notes; a kind with no photo is left out. */
  groups: SessionImageGroup[]
  total: number
}

// ---- History ---------------------------------------------------------------

/**
 * How the History list narrows. Every field is applied in SQL over the whole
 * record — not over the page already fetched — so a session that matches ten
 * thousand rows down is still found.
 */
export interface HistoryFilters {
  /** Free text: order number, item, item code, customer, inspector, machine,
   *  or the session's own number (`#12`). */
  q?: string
  status?: SessionStatus
  /** A machine code, compared the way the floor writes it. */
  workCenterCode?: string
  /** The factory a machine belongs to, as the machine catalogue names it. */
  factory?: string
  /** Any part of an item code or name, case-insensitive: typed text narrows as it is typed. */
  item?: string
  inspectorId?: string
  /** Only sessions started (or sampled) at or after this instant. */
  since?: string
  /** A range of factory days, YYYY-MM-DD, both inclusive: sessions started or
   *  sampled on those days. One day is `from` = `to`. */
  from?: string
  to?: string
  /** Land on the sessions that own a defect with this disposition. */
  disposition?: Disposition
}

export interface HistoryResponse {
  sessions: SessionWithOrder[]
  /** Sessions older than the last one here exist; ask again with `before`. */
  hasMore: boolean
  /** Counted over everything that matches the filters, not over this page.
   *  Sent with a first page only — paging back does not change it. */
  totals?: { sessions: number; open: number }
}

/** The most sessions (or PDIs) one export holds; past it the filters must narrow. */
export const EXPORT_MAX_RECORDS = 5000

/** §6 — History to Excel: every session that matches the filters, with its samples, measurements and defects. */
export interface HistoryExportResponse {
  sessions: {
    ref: string
    seq: number
    orderNumber: string
    item: string
    itemCode: string
    customer: string
    workCenterCode: string
    machine: string
    factory: string
    process: string
    /** On a universal machine: final, staged, or null (another machine, or closed before the choice existed). */
    universalKind: UniversalKind | null
    stages: StageQuantity[]
    inspectorName: string
    startedAt: string
    closedAt: string | null
    closedByName: string | null
    status: string
    rejectedBeforeRelease: number | null
    finalQty: number | null
    producedQty: number | null
    samples: number
    piecesInspected: number
    defectPieces: number
    holdPieces: number
  }[]
  samples: { sessionRef: string; index: number; recordedAt: string; inspectorName: string; shift: string | null; sampleQty: number; drawing: string; issue: string; coils: string }[]
  measurements: { sessionRef: string; sampleIndex: number; name: string; nominal: number | null; tolPlus: number | null; tolMinus: number | null; unit: string; actual: number | null; status: string }[]
  defects: { sessionRef: string; sampleIndex: number; defectName: string; qty: number; disposition: string; notes: string }[]
}

/**
 * §6 — History's grouped view: the sessions of an order, an item, a machine or
 * the filters as a whole, each with its counts and defects, for the pop-up
 * that lays them on their order lines. An order is read whole; the others
 * read History's filters as they stand.
 */
export interface HistoryGroupQuery extends HistoryFilters {
  orderNumber?: string
  /** One order line, read whole like an order. */
  orderId?: string
  /** One item, by its exact code. */
  itemCode?: string
  /** With the code, the item's exact name: two items may share a code (…: N2, …: N3). */
  itemName?: string
}

export interface HistoryGroupSession {
  sessionId: string
  seq: number
  orderId: string
  orderNumber: string
  item: string
  itemCode: string
  workCenterCode: string
  machine: string
  factory: string
  status: SessionStatus
  /** The stages of the item the session covered; empty on any other machine. */
  stages: number[]
  startedAt: string
  closedAt: string | null
  inspectorName: string
  samples: number
  piecesInspected: number
  defectPieces: number
  defects: { defectName: string; pieces: number }[]
}

export interface HistoryGroupResponse {
  sessions: HistoryGroupSession[]
  /** How many match; past the limit the newest are listed. */
  total: number
  truncated: boolean
}

/** The most sessions a grouped view lists: the newest. */
export const HISTORY_GROUP_LIMIT = 500

/** The items of the open order lines, for the PDI's item list: one per code and name. */
export interface OrderItemOption {
  itemCode: string
  item: string
  lineCount: number
}

/** What the History filters may offer, drawn from every session on record. */
export interface HistoryOptionsResponse {
  inspectors: { id: string; name: string }[]
  /** Machine codes that actually appear in the record, newest use first. */
  workCenterCodes: string[]
  /** Every item inspected so far: one row per code and name, since two items may share a code. */
  items: { itemCode: string; item: string }[]
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

/** One item a PDI covers: the order's lines of that item, on whichever machines they ran. */
export interface PDIItem {
  itemCode: string
  item: string
  /** The drawing numbers of those lines; one item can carry a drawing per machine. */
  drawings: string[]
  /** The order lines of the item the PDI covers. */
  lineIds: string[]
}

export interface PDIWithOrder extends PDIDocument {
  /** The anchor line: the first line the PDI covers. */
  order: OrderSummary | null
  orderNumber: string
  customer: string
  /** The items covered, by item code. */
  items: PDIItem[]
}

/**
 * A PDI names the order lines it covers: the lines of the items ticked. They
 * must all belong to one order number.
 */
/** A person's own profile photo: a small square JPEG as a data URL, or none (the circle shows their initials). */
export interface AvatarResponse {
  dataUrl: string | null
}

/** The most characters a profile photo's data URL may hold (a 192 px square JPEG is far under it). */
export const AVATAR_MAX_CHARS = 64 * 1024

export interface CreatePDIRequest {
  orderIds: string[]
  notes?: string
  imageIds: string[]
}

/** How the PDI list narrows. Every filter is applied in SQL over every PDI on record. */
export interface PDIListFilters {
  /** Any part of the order number, customer, item, item code, drawing, note or who recorded it. */
  q?: string
  /** Any part of an item code, item name or drawing number. */
  item?: string
  createdById?: string
  /** Factory days, YYYY-MM-DD, both inclusive. */
  from?: string
  to?: string
}

export interface PDIListResponse {
  documents: PDIWithOrder[]
  /** Older PDIs than the last one here exist; ask again with `before`. */
  hasMore: boolean
  /** Counted over everything that matches, sent with a first page only. */
  total?: number
}

export interface PDIOptionsResponse {
  /** Everyone who recorded a PDI, named as they were most recently. */
  createdBy: { id: string; name: string }[]
}

// ---- Audit -----------------------------------------------------------------

export interface AuditStats {
  total: number
  byAction: Partial<Record<AuditAction, number>>
}

/**
 * How the audit browser narrows. Like the History filters, every field is
 * applied in SQL over the whole log — which is the table that grows fastest —
 * so an entry is found however far back it sits.
 */
export interface AuditFilters {
  /** Free text: order, item, machine, field, either value, entity or user. */
  q?: string
  action?: AuditAction
  /** The name as it was recorded on the entry. */
  userName?: string
  entity?: string
  /** Only entries written at or after this instant. */
  since?: string
}

export interface AuditListResponse {
  entries: AuditEntry[]
  /** Entries older than the last one here match too; ask again with `before`. */
  hasMore: boolean
  /** How many match in the whole log. Sent with a first page only. */
  total?: number
}

/** What the audit filters may offer, drawn from the whole log. */
export interface AuditOptionsResponse {
  users: string[]
  entities: string[]
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

/** How far back the record goes: the day of the first inspection, in the
 *  factory's zone, or null before anything was recorded. */
export interface KpiSpanResponse {
  firstDay: string | null
}

export interface KpiThresholdsResponse {
  thresholds: KpiThresholds
  updatedAt?: string
  updatedByName?: string
}

/**
 * §15 — where each chart sits on the dashboard, one layout per page. Everyone
 * reads the fixed default; an administrator may keep an arrangement of their own.
 */
export interface DashboardLayoutResponse {
  layouts: DashboardLayouts
  /** True when this is the default everyone reads; false when it is the caller's own arrangement. */
  isDefault: boolean
  /** When the layout shown was saved. */
  updatedAt?: string
  /** Who saved the default, when it is the default that is shown. */
  updatedByName?: string
}

export interface SaveDashboardLayoutRequest {
  layouts: DashboardLayouts
}

// ---- §16 Notices -----------------------------------------------------------

export interface SaveNoticeRequest {
  title: string
  body: string
  severity: NoticeSeverity
  requiresAck: boolean
  /** Defaults to `all`. */
  matchMode?: NoticeMatchMode
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

// ---- Hidden insights (§15) -------------------------------------------------

/** The insight keys this person has hidden; see `insightKey` in ./kpi. */
export interface HiddenInsightsResponse {
  keys: string[]
}

export interface HiddenInsightRequest {
  key: string
}

// ---- Release notes (§18) ---------------------------------------------------

export interface ReleaseStateResponse {
  /** The newest release this person has dismissed; null before the first. */
  lastSeenReleaseId: string | null
}

export interface MarkReleaseSeenRequest {
  releaseId: string
}

// ---- Access: the imported order lines as a table (§19) -------------------

export interface OrderListFilters {
  /** Free text over order number, line key, item, item code, customer, drawing and machine code. */
  q?: string
  /** A machine code, compared the way the floor writes it. */
  workCenterCode?: string
  factory?: string
  erpStatus?: string
  /** Any part of an item code or name, case-insensitive: typed text narrows as it is typed. */
  item?: string
  /** 'open' — required above finished; 'done' — finished. */
  remaining?: 'open' | 'done'
  /** 'yes' — at least one inspection session on the line; 'no' — none. */
  inspected?: 'yes' | 'no'
}

/** One imported line with what the inspection record adds to it. */
export interface OrderListRow extends ProductionOrder {
  factory: string
  remainingQty: number
  sessions: number
  samples: number
  defectPieces: number
  lastInspectedAt: string | null
}

export interface OrderListResponse {
  orders: OrderListRow[]
  /** Lines matching the filters, counted over the whole table. */
  total: number
  hasMore: boolean
}

export interface OrderListOptionsResponse {
  erpStatuses: string[]
  factories: string[]
  workCenterCodes: string[]
  /** Every item on the sheet: one row per code and name, since two items may share a code. */
  items: { itemCode: string; item: string }[]
}

// ---- §7.7 Order sync from the factory's Access database ----------------------

/** How often the agent syncs on its own; an administrator can ask for one sooner. */
export const ORDER_SYNC_INTERVAL_MINUTES = 15
/** Rows the agent sends in one request. */
export const ORDER_SYNC_BATCH_MAX = 500
/** A run that has not finished after this long is given up, so the next can start. */
export const ORDER_SYNC_STALE_MINUTES = 30
/** A run that would retire more than this share of the live lines retires none: an empty or partial table is a mistake, not news. */
export const ORDER_SYNC_RETIRE_MAX_SHARE = 0.5

export type OrderSyncStatus = 'running' | 'success' | 'warning' | 'failed'

export interface OrderSyncRowError {
  /** The row's place in the run, from 1. */
  row: number
  lineKey?: string
  message: string
}

export interface OrderSyncRun {
  id: string
  keyName: string
  source: string
  status: OrderSyncStatus
  startedAt: string
  finishedAt?: string
  rowsReceived: number
  rowsExpected?: number
  inserted: number
  updated: number
  invalid: number
  retired: number
  /** Columns of the Access table no field reads. */
  unknownColumns: string[]
  /** The first rows that could not be read. */
  errors: OrderSyncRowError[]
  message?: string
}

export interface IntegrationKeyInfo {
  id: string
  name: string
  /** The key's first characters, to tell keys apart. */
  prefix: string
  createdByName: string
  createdAt: string
  lastUsedAt?: string
  revokedAt?: string
}

export interface OrderSyncStatusResponse {
  intervalMinutes: number
  /** Newest first. */
  runs: OrderSyncRun[]
  pendingRequest: { requestedAt: string; requestedByName: string } | null
  keys: IntegrationKeyInfo[]
}

export interface CreateIntegrationKeyRequest {
  name: string
}

export interface CreateIntegrationKeyResponse {
  key: IntegrationKeyInfo
  /** The key itself: shown this once, never stored. */
  secret: string
}

// The agent's side, authenticated with an integration key.

export interface OrderSyncDueResponse {
  due: boolean
  reason: 'requested' | 'interval' | 'first' | 'running' | 'not-yet'
  intervalMinutes: number
}

export interface OrderSyncStartRequest {
  /** The PC and the table read, for the record. */
  source: string
}

export interface OrderSyncStartResponse {
  runId: string
  batchMax: number
}

export interface OrderSyncRowsRequest {
  /** Rows as the Access table gives them: a column name → its value. */
  rows: Record<string, unknown>[]
}

export interface OrderSyncRowsResponse {
  received: number
  inserted: number
  updated: number
  invalid: number
  unknownColumns: string[]
}

export interface OrderSyncFinishRequest {
  /** How many rows the agent read from the table: the run is whole only if every one arrived. */
  total: number
}

export interface OrderSyncFailRequest {
  message: string
}
