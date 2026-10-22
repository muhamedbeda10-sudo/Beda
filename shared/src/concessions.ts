/** The concessions register: snapshots keep the record readable after ERP imports change. */
export interface ConcessionMachine {
  id: string
  code: string
  displayName: string
  factory: string
}

export interface ConcessionCategory {
  id: string
  name: string
}

export interface ConcessionItem {
  itemCode: string
  item: string
}

export interface ConcessionOrder {
  orderNumber: string
  customer: string
}

export interface CreateConcessionRequest extends ConcessionItem {
  /** Kept on retries, so a lost response never makes a second record. */
  submissionId: string
  date: string
  factories: string[]
  machineIds: string[]
  orderNumber: string
  description: string
  quantity: string
  categoryId: string
  concessionById: string
  imageIds: string[]
}

export interface Concession extends ConcessionItem {
  id: string
  date: string
  factories: string[]
  machines: ConcessionMachine[]
  customer: string
  orderNumber: string
  description: string
  quantity: string
  categoryId: string
  categoryName: string
  concessionBy: string
  concessionById: string | null
  imageIds: string[]
  createdAt: string
  createdById: string
  createdByName: string
}

export interface ConcessionOptions {
  factories: string[]
  machines: ConcessionMachine[]
  categories: ConcessionCategory[]
  people: { id: string; name: string }[]
}

export interface ConcessionListQuery {
  q?: string
  factory?: string
  machineId?: string
  categoryId?: string
  from?: string
  to?: string
  offset?: number
  limit?: number
}

export interface ConcessionListResponse {
  concessions: Concession[]
  total: number
  hasMore: boolean
}
