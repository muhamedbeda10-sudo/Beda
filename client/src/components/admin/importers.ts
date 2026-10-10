// ============================================================================
// §7.7 — what each bulk importer accepts: its fields, aliases for the ERP's
// column names, and the business key rows are matched on.
// ============================================================================

import { type ImportTarget } from '@/services/mutations'
import { ORDER_IMPORT_FIELDS, deriveOrderValues, gradeFromMaterial, normaliseHeader } from '@qc/shared/orderImport'
import { PRODUCTION_RECORD_FIELDS, PRODUCTION_RECORD_KEYS } from '@qc/shared/productionImport'

export { gradeFromMaterial, normaliseHeader }


export type CellValue = string | number

export interface ImportField {
  /** Also the CSV template header, and the name error messages use. */
  key: string
  label: string
  kind: 'text' | 'number' | 'date'
  aliases?: string[]
  sample: string
}

export interface Importer {
  id: string
  title: string
  description: string
  /** Which API importer receives the rows. */
  target: ImportTarget
  templateFile: string
  fields: ImportField[]
  /** Fields that together form the business key. Import is blocked if unmapped. */
  businessKeys: string[]
  /** Further key parts that may be empty (or unmapped) — e.g. the machine of a
   *  dimension row, where empty means "every machine". */
  optionalKeys?: string[]
  /** Fills in fields the sheet does not carry as columns but implies — run on
   *  each row after its mapped cells are read and before it is validated. */
  derive?: (values: Record<string, CellValue>) => Record<string, CellValue>
  /** The header the CSV template writes for a field instead of its key: the
   *  ERP's own column name, so the template reads like the export it stands
   *  in for. A field left out keeps its key. Every one must map back to its
   *  field through the aliases, or the template would not import itself. */
  templateHeaders?: Readonly<Record<string, string>>
}

/** Rows sent per request. The API merges each batch in one transaction. */
export const BATCH_SIZE = 200

export function normaliseKeyPart(v: unknown): string {
  return String(v ?? '').trim().toLowerCase()
}

/**
 * A cell's value as the API receives it, or the reason it cannot be sent.
 * Numbers drop thousands separators; dates become ISO timestamps so the
 * server never has to guess a spreadsheet's date format.
 */
export function coerceCell(field: ImportField, raw: string): { value: CellValue } | { error: string } {
  if (field.kind === 'number') {
    const n = Number(raw.replace(/,/g, ''))
    return Number.isFinite(n) ? { value: n } : { error: `${field.label} is not a number ("${raw}")` }
  }
  if (field.kind === 'date') {
    const d = new Date(raw)
    return Number.isNaN(d.getTime()) ? { error: `${field.label} is not a date ("${raw}")` } : { value: d.toISOString() }
  }
  return { value: raw }
}

export function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

export const ORDERS_IMPORTER: Importer = {
  id: 'orders',
  title: 'Production orders',
  description:
    'One row per order line: an item on a machine under an order. Lines are matched and updated on the Order ID; the order number repeats across the lines of one order.',
  target: 'orders',
  templateFile: 'production-orders-template.csv',
  businessKeys: ['lineKey'],
  // The same fields and aliases the Access sync reads, kept in one place.
  fields: ORDER_IMPORT_FIELDS.map((f) => ({ ...f, sample: f.key === 'date' ? new Date().toISOString().slice(0, 10) : f.sample })),
  derive: deriveOrderValues,
}

export const COILS_IMPORTER: Importer = {
  id: 'coils',
  title: 'Coils',
  description: 'Existing coils are matched and updated on the coil number.',
  target: 'coils',
  templateFile: 'coils-template.csv',
  businessKeys: ['coilNumber'],
  fields: [
    { key: 'coilNumber', label: 'Coil number', kind: 'text', aliases: ['coil', 'coil id', 'coil no'], sample: 'C10021' },
    { key: 'grade', label: 'Grade', kind: 'text', sample: 'S355JR' },
    { key: 'smType', label: 'SM type', kind: 'text', aliases: ['sm', 'type'], sample: 'HR' },
    { key: 'supplier', label: 'Supplier', kind: 'text', aliases: ['vendor', 'mill'], sample: 'Ezz Steel' },
    { key: 'thickness', label: 'Thickness', kind: 'number', aliases: ['thk'], sample: '2.5' },
    { key: 'width', label: 'Width', kind: 'number', sample: '1250' },
    { key: 'yield', label: 'Yield', kind: 'number', aliases: ['yield strength'], sample: '355' },
    { key: 'notes', label: 'Notes', kind: 'text', aliases: ['remarks', 'comment'], sample: '' },
  ],
}

export const PRODUCTION_IMPORTER: Importer = {
  id: 'production',
  title: 'Item dimensions',
  description:
    'Item dimensions and the sequence they are measured in, keyed by item code. Leave the machine column empty for a dimension that applies on every machine; fill it to make the row specific to one machine.',
  target: 'item-dimension-order',
  templateFile: 'item-dimensions-template.csv',
  businessKeys: ['itemCode', 'dimensionName'],
  optionalKeys: ['workCenterCode'],
  fields: [
    { key: 'itemCode', label: 'Item ID', kind: 'text', aliases: ['item code', 'item id', 'code', 'part code'], sample: 'LB406015-5TA3' },
    { key: 'dimensionName', label: 'Dimension name', kind: 'text', aliases: ['dimension', 'name', 'characteristic'], sample: 'Width' },
    { key: 'tolPlus', label: 'Tolerance +', kind: 'number', aliases: ['tol plus', 'tolerance plus', 'upper', 'plus'], sample: '0.5' },
    { key: 'tolMinus', label: 'Tolerance −', kind: 'number', aliases: ['tol minus', 'tolerance minus', 'lower', 'minus'], sample: '0.5' },
    { key: 'sequence', label: 'Sequence', kind: 'number', aliases: ['seq', 'order', 'no', 'sequence number'], sample: '1' },
    { key: 'workCenterCode', label: 'Machine (optional)', kind: 'text', aliases: ['machine', 'machine code', 'work center', 'work centre', 'wc'], sample: '' },
  ],
}

export const MACHINES_IMPORTER: Importer = {
  id: 'machines',
  title: 'Machines',
  description: 'The machine register. Existing machines are matched and updated on the machine code.',
  target: 'machines',
  templateFile: 'machines-template.csv',
  businessKeys: ['code'],
  fields: [
    { key: 'code', label: 'Machine code', kind: 'text', aliases: ['machine code', 'code', 'machine number', 'work center', 'work centre', 'wc'], sample: '58' },
    { key: 'name', label: 'Machine name', kind: 'text', aliases: ['machine', 'machine name', 'name', 'line'], sample: 'A. Welding Line' },
    { key: 'factory', label: 'Factory', kind: 'text', aliases: ['plant', 'site'], sample: 'LM4' },
    { key: 'process', label: 'Process', kind: 'text', aliases: ['type', 'machine type', 'process type', 'operation'], sample: 'welding' },
  ],
  optionalKeys: ['factory', 'process'],
}

export const DEFECTS_IMPORTER: Importer = {
  id: 'defects',
  title: 'Machine defects',
  description: 'The defect names offered on each machine. Matched on machine code + defect name.',
  target: 'work-center-defects',
  templateFile: 'machine-defects-template.csv',
  businessKeys: ['workCenterCode', 'defectName'],
  fields: [
    { key: 'workCenterCode', label: 'Machine code', kind: 'text', aliases: ['machine', 'machine code', 'work center', 'work centre', 'wc'], sample: '58' },
    { key: 'defectName', label: 'Defect name', kind: 'text', aliases: ['defect', 'name'], sample: 'عيب لحام' },
  ],
}
