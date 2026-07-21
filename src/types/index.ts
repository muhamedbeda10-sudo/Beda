// ============================================================================
// QC System — Domain model
// Mirrors the entities used across the inspection lifecycle:
// Production Orders → Inspection Sessions → Samples → Dimension/Defect results
// ============================================================================

export type ID = string

/** Machine / work-center types. Paint-sample machines (7, 11, 48) skip the
 *  start-session confirmation popup and go straight into the inspection flow. */
export type MachineKind =
  | 'Paint Sample'
  | 'Welding'
  | 'Stamping'
  | 'Assembly'
  | 'Roll Forming'
  | 'Packing'

export interface Machine {
  id: ID
  /** Display code such as "48", "58-A", "7" */
  code: string
  name: string
  kind: MachineKind
  active: boolean
}

export type OrderStatus = 'Active' | 'On Hold' | 'Completed' | 'Cancelled'
export type InspectionCoverage = 'Not Started' | 'In Progress' | 'Inspected'

export interface ProductionOrder {
  id: ID
  /** Business key such as "20095-QC1-HYH" */
  orderId: string
  item: string
  /** e.g. "125185TA3" */
  itemCode: string
  machineId: ID
  requiredQty: number
  finishedQty: number
  color: string
  drawing: string // DWG
  route: string
  date: string // ISO
  status: OrderStatus
  coverage: InspectionCoverage
  // nominal reference dims printed on the order card
  nominalT: number
  nominalW: number
  nominalL: number
}

export type SessionStatus = 'Open' | 'Closed'
export type ConfirmStatus = 'Pending' | 'Confirmed'

export interface InspectionSession {
  id: ID
  seq: number // per-order running sequence shown as the blue circle badge
  orderId: ID // FK -> ProductionOrder.id
  machineId: ID
  inspector: string
  startedAt: string // ISO
  closedAt?: string // ISO
  status: SessionStatus
  confirm: ConfirmStatus
  /** Final / confirmed quantity entered when closing (or set via "Set Qty") */
  finalQty?: number
  note?: string
}

export type SampleResult = 'Pass' | 'Fail' | 'Warning' | 'Pending'

export interface InspectionSample {
  id: ID
  sessionId: ID
  index: number // "1-1", "2-1" -> derived from index
  label: string
  coilId?: string
  result: SampleResult
  createdAt: string
  inspector: string
}

/** A single measured dimension against a target + tolerance band. */
export interface DimensionResult {
  id: ID
  sampleId: ID
  code: string // e.g. "H", "J", "K", "T", "W", "L"
  name: string
  target: number
  tolMinus: number
  tolPlus: number
  measured: number | null
  unit: string
  result: SampleResult
}

export type Disposition = 'Accepted' | 'Rejected' | 'Hold'
export type DefectSeverity = 'Minor' | 'Major' | 'Critical'

export interface VisualDefectResult {
  id: ID
  sampleId: ID
  defectCode: string
  /** Short title, can be Arabic e.g. "ترحيل فى الابعاد" */
  title: string
  description: string
  severity: DefectSeverity
  qty: number
  disposition: Disposition
}

export type ImageOwnerKind = 'sample' | 'defect'

export interface InspectionImage {
  id: ID
  ownerKind: ImageOwnerKind
  ownerId: ID // sampleId or defectId
  sessionId: ID
  /** base64 data URL (persisted in localStorage) */
  dataUrl: string
  caption?: string
  createdAt: string
}

// ---- Lookup / reference tables (Settings) --------------------------------

export interface DefectType {
  id: ID
  code: string
  title: string
  description: string
  defaultSeverity: DefectSeverity
  active: boolean
}

export interface DimensionSpec {
  id: ID
  code: string
  name: string
  target: number
  tolMinus: number
  tolPlus: number
  unit: string
  active: boolean
}

export interface GradeMapping {
  id: ID
  grade: string
  minPassRate: number // %
  maxDefectRate: number // %
  color: string
  label: string
}

export interface PTConsumable {
  id: ID
  code: string
  name: string
  type: string // Penetrant / Developer / Cleaner
  batch: string
  expiry: string
  active: boolean
}

// ---- Audit -----------------------------------------------------------------

export type AuditAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'close'
  | 'reopen'
  | 'import'
  | 'login'

export interface AuditLog {
  id: ID
  at: string // ISO
  user: string
  action: AuditAction
  entity: string
  entityRef: string
  summary: string
}

// ---- Full DB shape ---------------------------------------------------------

export interface DB {
  machines: Machine[]
  orders: ProductionOrder[]
  sessions: InspectionSession[]
  samples: InspectionSample[]
  dimensions: DimensionResult[]
  defects: VisualDefectResult[]
  images: InspectionImage[]
  defectTypes: DefectType[]
  dimensionSpecs: DimensionSpec[]
  gradeMappings: GradeMapping[]
  ptConsumables: PTConsumable[]
  audit: AuditLog[]
  meta: { version: number; seededAt: string }
}
