// ============================================================================
// QC Inspection System — domain model
// Mirrors the functional specification. Everything here is quality evidence:
// records are append-only in spirit (soft delete + audit), never overwritten.
//
// These shapes are what the API returns and the client renders. Column names
// in PostgreSQL are the snake_case form of the same identifiers (see
// server/migrations); the API maps between the two in one place.
// ============================================================================

import type { Permission, PermissionOverride } from './permissions'

export type ID = string
export type ISODate = string

// ---- Work centers ----------------------------------------------------------

/** Legacy work-centre numbers. Kept only to guess a process for a machine
 *  that is not in the register; the register's `process` is the authority. */
export type WorkCenterCode = '7' | '11' | '22' | '48' | '58'

/** Legacy: work centres that got the Paint Sample step before the register carried a process. */
export const PAINT_WORK_CENTERS: readonly WorkCenterCode[] = ['7', '11', '48']
/** Legacy: work centres that got the PT / Weld Inspection step before the register carried a process. */
export const PT_WORK_CENTERS: readonly WorkCenterCode[] = ['22', '58']

/**
 * What a machine does. The process decides which wizard steps an inspection
 * on that machine gets and which work instructions it shows:
 *   forming — roll forming, punching, cutting, bending and other fabrication:
 *             setup (drawing, coils), dimensions, defects
 *   welding — setup (drawing, welding wire), dimensions, VT defects, PT
 *   paint   — paint sample photos, paint thickness readings, defects
 *   other   — the forming flow
 */
export type Process = 'forming' | 'welding' | 'paint' | 'universal'

/** In the order the dashboard's process filter lists them. */
export const PROCESSES: readonly Process[] = ['forming', 'welding', 'paint', 'universal']

export const PROCESS_LABEL: Record<Process, string> = {
  forming: 'Roll forming / fabrication',
  welding: 'Welding',
  paint: 'Painting',
  universal: 'Universal machines',
}

export interface Machine {
  id: ID
  /**
   * The machine's code — unique across active machines. Orders, defects and
   * machine-specific dimensions refer to it. The leading digits are the
   * work-centre number that decides which wizard steps appear.
   */
  code: string
  /** Work-centre / process name, e.g. "A. Welding Line". */
  name: string
  /** Production line, e.g. "LM4". */
  line: string
  /** How the floor labels a group: "58-A. Welding Line-LM4". */
  displayName: string
  machineNumber?: string
  factory?: string
  /** Decides the inspection flow on this machine. */
  process: Process
  /**
   * Whether the wizard loads the item's configured dimensions on this
   * machine. Off for machines where the inspector measures what the part
   * needs and types nominal and tolerance once; the next sample then starts
   * from the previous one's rows. Defaults to on.
   */
  usesItemDimensions: boolean
  /**
   * Whether the dashboard counts this machine. Off for machines inspected but
   * not weighed with production (manual welding): their sessions and History
   * stay, every dashboard figure leaves them out. Defaults to on.
   */
  onDashboard: boolean
  /**
   * Whether every sample on this machine must name the coil it was made from
   * (roll forming, the 400 t press). Not for welding, whose connector coil
   * number is always required, nor paint, which records no coils. Off unless
   * turned on; absent from older answers.
   */
  coilRequired?: boolean
  deletedAt?: ISODate | null
}

// ---- Production orders -----------------------------------------------------

/**
 * One ORDER LINE: an item produced on one machine under an order. The ERP
 * exports one row per line, each with its own Order ID; an order number
 * therefore repeats across the lines of one order.
 */
export interface ProductionOrder {
  id: ID
  /** The ERP's Order ID — unique per line. Imports match on this. */
  lineKey: string
  /** The order the line belongs to. Repeats across the order's lines. */
  orderNumber: string
  item: string
  itemCode: string
  /** Code of the machine the line is produced on (see Machine.code). */
  workCenterCode: string
  /** The ERP's access status: Active, Hold, Stock or Cancel. A cancelled
   *  line is kept for history but never offered for inspection. */
  erpStatus: string
  machineId?: ID | null
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
  deletedAt?: ISODate | null
}

export function remainingQty(o: Pick<ProductionOrder, 'requiredQty' | 'finishedQty'>): number {
  return Math.max(0, o.requiredQty - o.finishedQty)
}

// ---- Sessions --------------------------------------------------------------

export type SessionStatus = 'Open' | 'Closed'

/**
 * A general remark about the order — text, photos, or both — written on the
 * Review step. It belongs to the session that wrote it (who, when, which
 * machine, while saving which sample) and is shown to every later session on
 * the same order.
 */
export interface SessionNote {
  id: ID
  sessionId: ID
  orderId: ID
  /** The sample whose save carried the note, when written from the wizard. */
  sampleId?: ID | null
  text: string
  authorId: ID
  authorName: string
  createdAt: ISODate
  imageIds: ID[]
  /** Where the note was written, so a note from another machine reads in context. */
  sessionSeq: number
  workCenterCode: string
  sampleIndex?: number | null
  item: string
  itemCode: string
  version: number
}

export interface InspectionSession {
  id: ID
  seq: number
  orderId: ID
  workCenterCode: string
  inspectorId: ID
  inspectorName: string
  startedAt: ISODate
  status: SessionStatus
  /** Baseline quantity confirmed when the session was first used (§4). */
  startQtyConfirmed?: {
    qty: number
    byId: ID
    byName: string
    at: ISODate
  }
  /** Final produced quantity captured when closing. */
  finalQty?: number
  /**
   * On a universal machine, given when the session closes: 'final' — the item
   * is a finished product with no stages, and the final quantity is a new
   * quantity of it; 'staged' — the stages the session covered, in `stages`.
   * Absent while open, on any other machine, and on a session closed before
   * the choice existed (its stage is in `stages` all the same).
   */
  universalKind?: UniversalKind
  /** The stages of the item this session covered, each with its quantity; lowest first. */
  stages?: StageQuantity[]
  /** On a make-to-stock machine: how many pieces (pairs, for a right/left
   *  item) came out, entered when the session is started. */
  producedQty?: number
  closedAt?: ISODate
  closedById?: ID
  /** Who closed it, as named at the time it is read. */
  closedByName?: string
  deletedAt?: ISODate | null
  /** How many samples this session holds. Computed by the API. */
  sampleCount?: number
  /** Defects recorded across the session's samples. Computed by the API. */
  defectCount?: number
  /** Pieces those defects cover (the sum of their quantities): the number the
   *  dashboard adds up as "defect pieces". Computed by the API. */
  defectPieces?: number
  /** Of those, the ones dispositioned Hold. Computed by the API. */
  holdCount?: number
  /** Pieces inspected: the sum of the samples' quantities. Computed by the API. */
  piecesInspected?: number
  /** Dimension readings out of tolerance across the samples. Computed by the API. */
  dimensionFailCount?: number
  /** PT-tested weld lengths across the samples: what counts toward the 5% of the final quantity. Computed by the API. */
  ptTestedCount?: number
  /** The same item of the same order already showed defects on another
   *  machine or in an earlier session. Computed by the API. */
  priorDefectsElsewhere?: boolean
  /** Notes about the order written during this session. Computed by the API. */
  noteCount?: number
  /** §21 — follow-ups linked to this session that are not done: above 0 it reads "Needs review". Computed by the API. */
  openFollowUps?: number
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
  inspectorId: ID
  inspectorName: string
  drawing: string
  drawingAlt?: string
  issue?: string
  sampleQty: number
  /** Grade-mismatch override, recorded when the inspector acknowledged (§8.4). */
  gradeAcknowledgement?: {
    byId: ID
    byName: string
    at: ISODate
    coilNumbers: string[]
    expectedGrade: string
    foundGrades: string[]
  }
  /** Client-generated id making retries idempotent (§9.3). */
  submissionId: string
  /**
   * Child counts, computed by the API from the rows themselves.
   *
   * `measuredDimensionCount` is deliberately separate from `dimensionCount`:
   * a dimension row that was never measured must stay visible as unmeasured
   * rather than counting toward a completion figure.
   */
  dimensionCount?: number
  measuredDimensionCount?: number
  defectCount?: number
  /** Defects of this sample still on Hold. Computed by the API. */
  holdCount?: number
  coilCount?: number
  deletedAt?: ISODate | null
  version: number
}

// ---- Dimensions ------------------------------------------------------------

export type DimensionStatus = 'Pass' | 'Fail' | 'Warning' | 'Pending'

export type DimensionSource = 'item-order' | 'item-master' | 'carry-forward' | 'manual'

export interface DimensionResult {
  id: ID
  sampleId: ID
  name: string
  sequence: number
  /** Null where a measurement was recorded with no specification to judge it
   *  against — such a row is Pending, never Pass. */
  nominal: number | null
  tolPlus: number | null
  tolMinus: number | null
  actual: number | null
  unit: string
  status: DimensionStatus
  /** Where nominal/tolerance came from (§8.3) — useful when auditing. */
  source: DimensionSource
  version: number
  deletedAt?: ISODate | null
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
  /** Optional while editing a draft; mandatory before save (§5.4). The API
   *  rejects a null disposition, so a stored row always carries one. */
  disposition: Disposition | null
  notes?: string
  imageIds: ID[]
  version: number
  deletedAt?: ISODate | null
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
  deletedAt?: ISODate | null
}

/** A coil as attached to one sample (snapshot — the catalogue may change later). */
/** What the coil register knows about a coil today, as opposed to what the sample recorded. */
export interface CoilRegisterDetails {
  grade?: string
  smType?: string
  supplier?: string
  thickness?: number
  width?: number
  yield?: number
}

export interface SampleCoil {
  id: ID
  sampleId: ID
  /** The catalogue coil that was picked; unset when the number was typed by hand. */
  coilId?: ID | null
  coilNumber: string
  grade?: string
  smType?: string
  supplier?: string
  thickness?: number
  width?: number
  yield?: number
  notes?: string
  /**
   * The register's current row for this number, attached only when the
   * sample's own snapshot carries no details (a coil typed by hand, or picked
   * before its sheet was loaded). The snapshot above is what was recorded;
   * this is what the register says now.
   */
  register?: CoilRegisterDetails
  deletedAt?: ISODate | null
}

// ---- Paint sample ----------------------------------------------------------

export interface PaintSampleRecord {
  id: ID
  sampleId: ID
  notes?: string
  imageIds: ID[]
  deletedAt?: ISODate | null
}

// ---- PT / weld -------------------------------------------------------------

export type PTConsumableKind = 'Cleaner' | 'Penetrant' | 'Developer'

export const PT_CONSUMABLE_KINDS: readonly PTConsumableKind[] = ['Cleaner', 'Penetrant', 'Developer']

export type PTVerdict = 'Accept' | 'Reject / Repair'

/** One tested weld length and its own verdict (§5.6). */
export interface PTTestedLength {
  id?: ID
  seq: number
  lengthMm: number
  verdict: PTVerdict
}

export interface PTRecord {
  id: ID
  sampleId: ID
  /** Typed by hand on older records only; the requirement is 5% of the session's final quantity (§5.6). */
  testFrequencyPct?: number | null
  /** Lot/batch per consumable kind — the chemical audit trail, all mandatory. */
  consumableLots: Record<PTConsumableKind, string>
  sampleSize?: string
  testedWeldLength?: string
  indicationType?: string
  indicationSize?: string
  weldingWireBatch?: string
  /** The connector's coil number; required on welding samples saved since it was added, absent on older ones. */
  connectorCoilNumber?: string
  /** Every tested length with its verdict; the record's verdict is Reject / Repair when any length is. */
  testedLengths: PTTestedLength[]
  acceptOrRepair?: PTVerdict
  finalResult?: string
  notes?: string
  imageIds: ID[]
  deletedAt?: ISODate | null
}

// ---- Images ----------------------------------------------------------------

export type ImageDriver = 'local' | 'azure-blob'

/** Metadata for a stored image. The bytes live behind the image store driver;
 *  the hash is what proves the file was never swapped (§10). */
export interface ImageAsset {
  id: ID
  /** Key the storage driver resolves — never a client-supplied filename. */
  storageKey: string
  driver: ImageDriver
  originalFilename: string
  mimeType: string
  byteSize: number
  width: number
  height: number
  sha256: string
  uploadedById: ID
  uploadedByName: string
  uploadedAt: ISODate
  /** Small preview used in lists so a 50-photo page doesn't stall (§10.7). */
  thumbnailDataUrl?: string
  /** Context so an orphan can be traced/cleaned. */
  sessionId?: ID | null
  sampleId?: ID | null
  orderId?: ID | null
  deletedAt?: ISODate | null
}

// ---- PDI -------------------------------------------------------------------

export interface PDIDocument {
  id: ID
  orderId: ID
  notes?: string
  imageIds: ID[]
  createdAt: ISODate
  createdById: ID
  createdByName: string
  deletedAt?: ISODate | null
}

// ---- Admin / master data ---------------------------------------------------

/**
 * Dimension order per item — drives pre-fill and display sequence (§7).
 * Keyed by item code. A row that names a machine applies to that machine only
 * and overrides the general row of the same dimension; a row without one
 * applies to every machine.
 */
export interface ItemDimensionOrder {
  id: ID
  itemCode: string
  /** Item name, for display only. */
  item: string
  /** Machine the row is specific to; unset means every machine. */
  workCenterCode?: string | null
  dimensionName: string
  sequence: number
  nominal?: number | null
  tolPlus: number
  tolMinus: number
  unit: string
  deletedAt?: ISODate | null
}

export interface ItemReferenceImage {
  id: ID
  itemCode: string
  /** Item name, for display only. */
  item: string
  /** Machine the photo is specific to; unset means every machine. */
  workCenterCode?: string | null
  imageId: ID
  caption?: string
  deletedAt?: ISODate | null
}

/** Which defect names are offered on which work center (§5.1). */
export interface WorkCenterDefect {
  id: ID
  workCenterCode: string
  defectName: string
  deletedAt?: ISODate | null
}

/** A pair of equivalent grade names. Equivalence is transitive (§8.4). */
export interface GradeMapping {
  id: ID
  gradeA: string
  gradeB: string
  deletedAt?: ISODate | null
}

export interface PTConsumableProduct {
  id: ID
  kind: PTConsumableKind
  productName: string
  lotBatch: string
  deletedAt?: ISODate | null
}

// ---- Work instructions -----------------------------------------------------

/** The wizard step a work instruction is offered on. */
export type WorkInstructionStep = 'setup' | 'dimensions' | 'defects' | 'pt' | 'paint' | 'paintThickness'

export const WORK_INSTRUCTION_STEPS: readonly WorkInstructionStep[] = ['setup', 'dimensions', 'defects', 'pt', 'paint', 'paintThickness']

export const WORK_INSTRUCTION_STEP_LABEL: Record<WorkInstructionStep, string> = {
  setup: 'Setup',
  dimensions: 'Dimensions',
  defects: 'Defects (VT)',
  pt: 'PT / weld',
  paint: 'Paint sample',
  paintThickness: 'Paint thickness',
}

/** Which machines see the document: one process, or every machine. */
export type WorkInstructionScope = Process | 'all'

/**
 * A controlled document (a PDF) the inspector can open from a wizard step:
 * acceptance limits, test methods, repair instructions. Uploading a new
 * issue under the same code supersedes the previous one, which stays on
 * record so an old inspection can still be read against the issue that was
 * in force at the time.
 */
export interface WorkInstruction {
  id: ID
  /** The document control code, e.g. WI-PD-03-01. */
  code: string
  title: string
  issueNo: string
  issueDate?: ISODate | null
  process: WorkInstructionScope
  step: WorkInstructionStep
  originalFilename: string
  byteSize: number
  sha256: string
  uploadedByName: string
  uploadedAt: ISODate
  sortOrder: number
  supersededAt?: ISODate | null
  supersededById?: ID | null
  deletedAt?: ISODate | null
}

// ---- Audit -----------------------------------------------------------------

/** Every action an audit entry may record — the list a filter narrows by. */
export const AUDIT_ACTIONS = ['create', 'update', 'delete', 'restore', 'purge', 'acknowledge'] as const

export type AuditAction = (typeof AUDIT_ACTIONS)[number]

/** Field-level change record. Written for every edit after the initial save. */
export interface AuditEntry {
  id: ID
  at: ISODate
  userId: ID
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

/** What a line on a universal machine is: a finished product, or an item that passes through stages. */
export type UniversalKind = 'final' | 'staged'

/** One stage of an item a session covered, and the quantity it made of it. */
export interface StageQuantity {
  stage: number
  qty: number
}

/** A viewer reads the board, History and the dashboard and changes nothing; the rest record. */
export type Role = 'viewer' | 'inspector' | 'supervisor' | 'admin'

export const ROLES: readonly Role[] = ['viewer', 'inspector', 'supervisor', 'admin']

export interface UserProfile {
  id: ID
  /** The login name: lower-case letters, digits, dot, dash, underscore. */
  username: string
  name: string
  role: Role
  isActive: boolean
  createdAt?: ISODate
  lastLoginAt?: ISODate | null
  /** §14 — what they may open and do now: their role's set with their own overrides; everything for ADMIN+. */
  permissions: Permission[]
  /** §14 — the AI assistant's owner: above the roles, and changed by nobody else. */
  adminPlus: boolean
}

/** An account as a list of people shows it (a notice's audience, the dashboard's inspectors): no permissions. */
export type DirectoryUser = Pick<UserProfile, 'id' | 'username' | 'name' | 'role' | 'isActive'>

/** §14 — an account as the users screen lists it: with its own differences from its role. */
export interface ManagedUser extends UserProfile {
  overrides: PermissionOverride[]
}

// ---- Notices (§16) ---------------------------------------------------------

export type NoticeSeverity = 'info' | 'warning' | 'critical'
export const NOTICE_SEVERITIES: readonly NoticeSeverity[] = ['info', 'warning', 'critical']

/**
 * What a notice is aimed at. Values of one kind are alternatives (any of
 * these machines); different kinds all have to hold (this machine AND this
 * order). A notice with no target of a kind does not care about that kind.
 */
export type NoticeTargetKind = 'factory' | 'machine' | 'process' | 'order-number' | 'order-line' | 'item-code' | 'customer' | 'shift' | 'user' | 'role'
export const NOTICE_TARGET_KINDS: readonly NoticeTargetKind[] = ['factory', 'machine', 'process', 'order-number', 'order-line', 'item-code', 'customer', 'shift', 'user', 'role']
export const NOTICE_TARGET_LABEL: Record<NoticeTargetKind, string> = {
  factory: 'Factory',
  machine: 'Machine',
  process: 'Process',
  'order-number': 'Order number',
  'order-line': 'Order line',
  'item-code': 'Item code',
  customer: 'Customer',
  shift: 'Shift',
  user: 'User',
  role: 'Role',
}

export interface NoticeTarget {
  kind: NoticeTargetKind
  /** The matched value: a machine code, an order number, an order line id, a user id, a role. */
  value: string
  /** How the value reads to people, captured when the target was set. */
  label: string
}

export interface NoticeFile {
  id: ID
  originalFilename: string
  mimeType: string
  byteSize: number
  sha256: string
  uploadedByName: string
  uploadedAt: ISODate
}

/**
 * How a notice's targets combine. `all`: values of one kind are
 * alternatives and the kinds all have to hold (this machine AND this
 * order). `any`: one target of any kind is enough (this machine OR this
 * order OR this person).
 */
export type NoticeMatchMode = 'all' | 'any'
export const NOTICE_MATCH_MODES: readonly NoticeMatchMode[] = ['all', 'any']

export interface Notice {
  id: ID
  title: string
  body: string
  severity: NoticeSeverity
  /** The reader must press Acknowledge; otherwise closing it is enough. */
  requiresAck: boolean
  matchMode: NoticeMatchMode
  /** Shown from this factory day. */
  validFrom: string
  /** Shown through this factory day; null until withdrawn. */
  validTo: string | null
  targets: NoticeTarget[]
  imageIds: ID[]
  files: NoticeFile[]
  createdById: ID | null
  createdByName: string
  createdAt: ISODate
  updatedAt: ISODate
  withdrawnAt?: ISODate | null
  withdrawnByName?: string | null
}

/** A notice as one reader sees it. */
export interface NoticeForUser extends Notice {
  /** Still shown today: within validity and not withdrawn. */
  active: boolean
  seenAt: ISODate | null
  acknowledgedAt: ISODate | null
  /** Still to be read (and acknowledged, when required) by this reader. */
  pending: boolean
}

export interface NoticeAcknowledgement {
  userId: ID
  userName: string
  seenAt: ISODate
  acknowledgedAt: ISODate | null
  /** Where the reader was when they read it, when it came up in context. */
  context?: { sessionId?: string; workCenterCode?: string; orderNumber?: string; itemCode?: string } | null
}

/** A notice in the administrator's list with how far it has travelled. */
export interface NoticeAdminRow extends Notice {
  active: boolean
  seenCount: number
  acknowledgedCount: number
}

// ---- Chat (§17) ------------------------------------------------------------

/** A stored document (PDF or workbook) attached to a notice or a message. */
export type StoredFile = NoticeFile

export type ChatConversationKind = 'general' | 'direct' | 'group'

export interface ChatUser {
  id: ID
  name: string
  username: string
  role: Role
}

export interface ChatMember extends ChatUser {
  lastReadAt: ISODate | null
}

export interface ChatMessagePreview {
  id: ID
  senderId: ID
  senderName: string
  /** Plain text of the message, or a short stand-in for a deleted one or an attachment. */
  text: string
  createdAt: ISODate
}

export interface ChatConversation {
  id: ID
  kind: ChatConversationKind
  /** How the reader sees it: the other person's name for a direct one, the group's name otherwise. */
  title: string
  createdById: ID | null
  createdAt: ISODate
  lastMessageAt: ISODate | null
  members: ChatMember[]
  unreadCount: number
  /** Unread messages that mention the reader by name. */
  mentionCount: number
  lastMessage: ChatMessagePreview | null
  /**
   * §21 — a direct conversation with the app's automations sender ("QC
   * Automations"): it only delivers messages; replies are refused, so the
   * screen shows no composer.
   */
  automated?: boolean
}

/**
 * A mention inside a message body: `@[Name](user:ID)` for a person,
 * `#[Label](order:ID)`, `#[Code](item:CODE)`, `#[Code](machine:CODE)` or
 * `#[Label](session:ID)` for a thing on the floor. The body keeps the
 * tokens; the screen shows chips.
 */
export type ChatMentionKind = 'user' | 'order' | 'item' | 'machine' | 'session'
export const CHAT_MENTION_KINDS: readonly ChatMentionKind[] = ['user', 'order', 'item', 'machine', 'session']

export interface ChatMention {
  kind: ChatMentionKind
  value: string
  label: string
}

export interface ChatReaction {
  emoji: string
  count: number
  mine: boolean
  names: string[]
}

export interface ChatReplyPreview {
  id: ID
  senderName: string
  text: string
}

export interface ChatMessage {
  id: ID
  conversationId: ID
  senderId: ID
  senderName: string
  body: string
  replyTo: ChatReplyPreview | null
  imageIds: ID[]
  files: StoredFile[]
  mentions: ChatMention[]
  reactions: ChatReaction[]
  createdAt: ISODate
  editedAt: ISODate | null
  /** Deleted for everyone: the body is gone, the row stays as "message deleted". */
  deleted: boolean
  /** Members other than the sender who have read up to this message. */
  readBy: number
  /** Members other than the sender. */
  others: number
}

/** Edit and delete-for-everyone are allowed this long after sending. */
export const CHAT_EDIT_WINDOW_MS = 60 * 60 * 1000
export const CHAT_MAX_BODY = 4000
/**
 * Documents (PDF, Excel) as chat attachments are switched off for now: photos
 * only. The composer hides the file button and the API refuses an upload or
 * a message carrying file ids. Files sent while it was on stay readable.
 */
export const CHAT_FILE_ATTACHMENTS_ENABLED = false
