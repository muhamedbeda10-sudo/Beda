/**
 * Scrap: the weight of scrap a machine made, with a photo of its scrap card and of its scrap box. Recorded from
 * Inspections, read in History under Scrap. Names are kept as recorded.
 */
export interface ScrapType {
  id: string
  name: string
}

export interface ScrapMachine {
  id: string
  code: string
  displayName: string
  factory: string
}

export interface ScrapPerson {
  id: string
  name: string
}

/** The fields a person fills in; the same on create and on correction. */
export interface ScrapFields {
  date: string
  factory: string
  machineId: string
  scrapTypeId: string
  /** Kilograms, above 0. Required. */
  weightKg: number
  /** Optional, as typed: often a production person without an account. */
  responsiblePerson: string
  inspectorId: string
  /** Required: a photo of the scrap card. */
  cardImageId: string
  /** Required: a photo of the scrap box. */
  boxImageId: string
}

export interface CreateScrapRequest extends ScrapFields {
  /** Kept on retries, so a lost response never makes a second record. */
  submissionId: string
}

export interface UpdateScrapRequest extends ScrapFields {
  /** The version the person edited: a stale edit cannot overwrite another person's correction. */
  version: number
}

export interface ScrapRecord {
  id: string
  date: string
  factory: string
  machineId: string
  machineCode: string
  machineName: string
  scrapTypeId: string
  scrapTypeName: string
  weightKg: number
  responsiblePerson: string
  inspectorId: string
  inspectorName: string
  cardImageId: string
  boxImageId: string
  version: number
  createdAt: string
  createdById: string
  createdByName: string
  updatedAt: string
  updatedByName: string
}

export interface ScrapOptions {
  factories: string[]
  machines: ScrapMachine[]
  types: ScrapType[]
  /** The people who may be named as the quality inspector. */
  inspectors: ScrapPerson[]
  /** Responsible people typed before, for suggestions. */
  responsiblePeople: string[]
  /** Everyone named as the inspector on a record, for History's filter (former inspectors too). */
  recordedInspectors: ScrapPerson[]
}

export interface ScrapListQuery {
  q?: string
  factory?: string
  machineId?: string
  scrapTypeId?: string
  inspectorId?: string
  from?: string
  to?: string
  offset?: number
  limit?: number
}

export interface ScrapListResponse {
  records: ScrapRecord[]
  total: number
  /** The sum of weightKg over every record the filters match, not only this page. */
  totalWeightKg: number
  hasMore: boolean
}

/** The most a single weighing may be, in kilograms (the database holds the same limit). */
export const MAX_SCRAP_WEIGHT_KG = 1_000_000

/** The most records one Excel export takes. */
export const MAX_SCRAP_EXPORT = 50_000
