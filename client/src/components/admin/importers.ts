// ============================================================================
// §7.7 — what each bulk importer accepts: its fields, aliases for the ERP's
// column names, and the business key rows are matched on.
// ============================================================================

import { type ImportTarget } from '@/services/mutations'


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
}

/**
 * The grade hidden in the ERP's raw-material description, e.g.
 * "RM.ST.CO.HR. : 344 : 1.5 : S315MC : PO" → "S315MC". The description is
 * "code : size : thickness : grade : finish"; anything shorter has no grade.
 */
export function gradeFromMaterial(description: string): string | undefined {
  const parts = description.split(':').map((p) => p.trim())
  return parts.length >= 4 && parts[3] ? parts[3] : undefined
}

/** Rows sent per request. The API merges each batch in one transaction. */
export const BATCH_SIZE = 200

export function normaliseHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, '')
}

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
  // Aliases include the Dataverse export's own column names (cr863_…), so
  // the ERP file maps itself without renaming a single header.
  fields: [
    { key: 'lineKey', label: 'Order ID', kind: 'text', aliases: ['order id', 'orderid', 'id', 'line id', 'line', 'cr863_orderid'], sample: '100245' },
    { key: 'orderNumber', label: 'Order number', kind: 'text', aliases: ['order', 'order name', 'order no', 'ordernr', 'po', 'cr863_order'], sample: '20480-Ph1.4-SMA' },
    { key: 'itemCode', label: 'Item code', kind: 'text', aliases: ['item id', 'code', 'part code', 'cr863_itemid'], sample: 'LB406015-5TA3' },
    { key: 'item', label: 'Item name', kind: 'text', aliases: ['item', 'description', 'cr863_item'], sample: 'Shuttle Beam' },
    { key: 'workCenterCode', label: 'Machine code', kind: 'text', aliases: ['machine', 'machine code', 'work center', 'work centre', 'wc', 'cr863_workcenter'], sample: '48' },
    { key: 'requiredQty', label: 'Required qty', kind: 'number', aliases: ['required', 'quantity', 'req q', 'cr863_req_q'], sample: '1350' },
    { key: 'finishedQty', label: 'Finished qty', kind: 'number', aliases: ['finished', 'produced', 'finished q', 'cr863_finished_q'], sample: '900' },
    { key: 'drawing', label: 'Drawing', kind: 'text', aliases: ['dwg', 'dwg1', 'cr863_dwg1'], sample: 'BS9059/48' },
    { key: 'drawingAlt', label: 'Alternative drawing', kind: 'text', aliases: ['drawing 2', 'alt drawing', 'dwg2', 'cr863_dwg2'], sample: 'BS9059/48-ALT' },
    { key: 'issue', label: 'Issue', kind: 'text', aliases: ['rev', 'revision'], sample: 'Rev C' },
    { key: 'material', label: 'Material', kind: 'text', aliases: ['raw material', 'raw material description', 'cr863_rawmaterialdescription'], sample: 'RM.ST.CO.HR. : 344 : 1.5 : S315MC : PO' },
    { key: 'expectedGrade', label: 'Expected grade', kind: 'text', aliases: ['grade'], sample: 'S315MC' },
    { key: 'customer', label: 'Customer', kind: 'text', aliases: ['client', 'cus name', 'cr863_cusname'], sample: 'Alpha Racking' },
    { key: 'type', label: 'Type', kind: 'text', aliases: ['exp local', 'export local', 'cr863_explocal'], sample: 'Export' },
    { key: 'colour', label: 'Colour', kind: 'text', aliases: ['color', 'ral', 'cr863_color'], sample: 'RAL7016' },
    { key: 'erpStatus', label: 'Status', kind: 'text', aliases: ['access status', 'accessstatus', 'cr863_accessstatus'], sample: 'Active' },
    { key: 'date', label: 'Date', kind: 'date', aliases: ['order date', 'release date', 'cr863_releasedate'], sample: new Date().toISOString().slice(0, 10) },
  ],
  // The ERP has no grade column: it lives inside the raw-material description.
  derive: (values) => {
    if (values.expectedGrade !== undefined || typeof values.material !== 'string') return values
    const grade = gradeFromMaterial(values.material)
    return grade ? { ...values, expectedGrade: grade } : values
  },
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
