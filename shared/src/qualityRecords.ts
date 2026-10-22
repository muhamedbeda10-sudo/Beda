import type { Permission } from './permissions'
import type { ConcessionMachine, ConcessionOrder, ConcessionItem } from './concessions'

export const QUALITY_KINDS = ['ncr', 'customer-complaint'] as const
export type QualityKind = typeof QUALITY_KINDS[number]
export const NCR_SOURCES = ['Product non-conformity', 'Incident', 'Customer complaint', 'Environmental incident', 'Suggestion for improvement', 'Other', 'Internal audit', 'External audit'] as const
export type NcrSource = typeof NCR_SOURCES[number]
export const NCR_DISPOSITIONS = ['Scrap', 'Replacement', 'Repair', 'Concession'] as const
export const COMPLAINT_ISSUES = ['Deflection defects', 'Inclusions / punctual', 'Surface defects', 'Installation', 'Dimensions', 'Packaging', 'Loading damage', 'Other'] as const
export type ComplaintIssue = typeof COMPLAINT_ISSUES[number]
export const EFFECTIVENESS = ['Pending', 'Effective', 'Not Effective'] as const

export interface FormReference { code: string; issue: string; issueDate: string }
export const QUALITY_FORMS: Record<QualityKind, { title: string; singular: string; path: string; prefix: string; view: Permission; record: Permission; form: FormReference }> = {
  ncr: { title: 'NCR', singular: 'NCR', path: '/ncr', prefix: 'NCR', view: 'view-ncr', record: 'record-ncr', form: { code: 'F-QHSE-03-01', issue: '2', issueDate: '2022-11-17' } },
  'customer-complaint': { title: 'Customer Complaints', singular: 'Customer complaint', path: '/customer-complaints', prefix: 'CC', view: 'view-customer-complaints', record: 'record-customer-complaint', form: { code: 'F-Q-03-01', issue: '01', issueDate: '2016-04-01' } },
}

export interface CorrectiveAction { description: string; responsibility: string; completionDate: string }
export interface NcrData {
  kind: 'ncr'
  orderNumber: string
  customer: string
  factories: string[]
  machineIds: string[]
  machines: ConcessionMachine[]
  process: string
  raisedBy: string
  assignedTo: string
  sources: NcrSource[]
  sourceOther: string
  totalQuantity: string
  rejectedQuantity: string
  description: string
  immediateAction: string
  responsiblePerson: string
  dispositions: typeof NCR_DISPOSITIONS[number][]
  correctiveActionRequired: boolean | null
  rootCause: string
  completedBy: string
  correctiveActions: CorrectiveAction[]
  effectivenessDetails: string
  effectiveness: typeof EFFECTIVENESS[number]
  effectivenessDate: string
}
export interface CustomerComplaintData {
  kind: 'customer-complaint'
  orderNumber: string
  customer: string
  productName: string
  itemCode: string
  contactPerson: string
  email: string
  telephone: string
  dimensions: string
  colour: string
  invoiceNumber: string
  invoiceDate: string
  quantity: string
  nonComplianceDetails: string
  issues: ComplaintIssue[]
  issueOther: string
  description: string
  processedQuantity: string
  lostQuantity: string
  reportDate: string
  reportName: string
  signature: string
}
export type QualityRecordData = NcrData | CustomerComplaintData
export interface QualityRecord {
  id: string
  kind: QualityKind
  reference: string
  date: string
  data: QualityRecordData
  imageIds: string[]
  form: FormReference
  version: number
  createdAt: string
  createdById: string
  createdByName: string
  updatedAt: string
  updatedByName: string
}
export interface SaveQualityRecordRequest {
  submissionId?: string
  version?: number
  reference: string
  date: string
  data: QualityRecordData
  imageIds: string[]
}
export interface QualityRecordListQuery { q?: string; from?: string; to?: string; category?: string; factory?: string; offset?: number; limit?: number }
export interface QualityRecordList { records: QualityRecord[]; total: number; hasMore: boolean }
export interface QualityRecordOptions { factories: string[]; machines: ConcessionMachine[]; people: { id: string; name: string }[] }
export type QualityOrder = ConcessionOrder
export type QualityItem = ConcessionItem

export function emptyQualityData(kind: QualityKind, name: string, today: string): QualityRecordData {
  if (kind === 'ncr') return {
    kind, orderNumber: '', customer: '', factories: [], machineIds: [], machines: [], process: '', raisedBy: name, assignedTo: '', sources: [], sourceOther: '', totalQuantity: '', rejectedQuantity: '', description: '', immediateAction: '', responsiblePerson: '', dispositions: [], correctiveActionRequired: null, rootCause: '', completedBy: '', correctiveActions: [], effectivenessDetails: '', effectiveness: 'Pending', effectivenessDate: '',
  }
  return { kind, orderNumber: '', customer: '', productName: '', itemCode: '', contactPerson: '', email: '', telephone: '', dimensions: '', colour: '', invoiceNumber: '', invoiceDate: '', quantity: '', nonComplianceDetails: '', issues: [], issueOther: '', description: '', processedQuantity: '', lostQuantity: '', reportDate: today, reportName: name, signature: '' }
}
