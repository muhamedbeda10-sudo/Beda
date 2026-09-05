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
  kind: 'text' | 'number'
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
}

/** Rows sent per request. The API merges each batch in one transaction. */
export const BATCH_SIZE = 200

export function normaliseHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function normaliseKeyPart(v: unknown): string {
  return String(v ?? '').trim().toLowerCase()
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
  fields: [
    { key: 'lineKey', label: 'Order ID', kind: 'text', aliases: ['order id', 'orderid', 'id', 'line id', 'line'], sample: '100245' },
    { key: 'orderNumber', label: 'Order number', kind: 'text', aliases: ['order', 'order name', 'order no', 'ordernr', 'po'], sample: '20480-Ph1.4-SMA' },
    { key: 'itemCode', label: 'Item code', kind: 'text', aliases: ['item id', 'code', 'part code'], sample: 'LB406015-5TA3' },
    { key: 'item', label: 'Item name', kind: 'text', aliases: ['item', 'description'], sample: 'Shuttle Beam' },
    { key: 'workCenterCode', label: 'Machine code', kind: 'text', aliases: ['machine', 'machine code', 'work center', 'work centre', 'wc'], sample: '48' },
    { key: 'requiredQty', label: 'Required qty', kind: 'number', aliases: ['required', 'quantity'], sample: '1350' },
    { key: 'finishedQty', label: 'Finished qty', kind: 'number', aliases: ['finished', 'produced'], sample: '900' },
    { key: 'drawing', label: 'Drawing', kind: 'text', aliases: ['dwg'], sample: 'BS9059/48' },
    { key: 'drawingAlt', label: 'Alternative drawing', kind: 'text', aliases: ['drawing 2', 'alt drawing'], sample: 'BS9059/48-ALT' },
    { key: 'issue', label: 'Issue', kind: 'text', aliases: ['rev', 'revision'], sample: 'Rev C' },
    { key: 'material', label: 'Material', kind: 'text', sample: 'Steel' },
    { key: 'expectedGrade', label: 'Expected grade', kind: 'text', aliases: ['grade'], sample: 'ST52-3' },
    { key: 'customer', label: 'Customer', kind: 'text', aliases: ['client'], sample: 'Alpha Racking' },
    { key: 'type', label: 'Type', kind: 'text', sample: 'Export' },
    { key: 'colour', label: 'Colour', kind: 'text', aliases: ['color', 'ral'], sample: 'RAL7016' },
    { key: 'date', label: 'Date', kind: 'text', aliases: ['order date'], sample: new Date().toISOString().slice(0, 10) },
  ],
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
    { key: 'itemCode', label: 'Item code', kind: 'text', aliases: ['item id', 'code', 'part code'], sample: 'LB406015-5TA3' },
    { key: 'item', label: 'Item name', kind: 'text', aliases: ['item', 'product', 'description'], sample: 'XL Light Beam' },
    { key: 'workCenterCode', label: 'Machine code', kind: 'text', aliases: ['machine', 'machine code', 'work center', 'work centre', 'wc'], sample: '' },
    { key: 'dimensionName', label: 'Dimension name', kind: 'text', aliases: ['dimension', 'name', 'characteristic'], sample: 'Width' },
    { key: 'sequence', label: 'Sequence', kind: 'number', aliases: ['seq', 'order', 'no'], sample: '1' },
    { key: 'nominal', label: 'Nominal', kind: 'number', aliases: ['target', 'nom'], sample: '125' },
    { key: 'tolPlus', label: 'Tolerance +', kind: 'number', aliases: ['tol plus', 'upper', 'plus'], sample: '0.5' },
    { key: 'tolMinus', label: 'Tolerance −', kind: 'number', aliases: ['tol minus', 'lower', 'minus'], sample: '0.5' },
    { key: 'unit', label: 'Unit', kind: 'text', aliases: ['uom'], sample: 'mm' },
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
    { key: 'code', label: 'Machine code', kind: 'text', aliases: ['machine code', 'code', 'work center', 'work centre', 'wc'], sample: '58' },
    { key: 'name', label: 'Machine name', kind: 'text', aliases: ['machine', 'machine name', 'name'], sample: 'A. Welding Line' },
    { key: 'factory', label: 'Factory', kind: 'text', aliases: ['plant', 'site'], sample: 'Factory 1' },
    { key: 'line', label: 'Line', kind: 'text', sample: 'LM4' },
    { key: 'machineNumber', label: 'Machine number', kind: 'text', aliases: ['machine no', 'number'], sample: '' },
  ],
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
