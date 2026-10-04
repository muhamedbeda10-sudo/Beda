// ============================================================================
// §7.7 — the order sheet's columns, read the same way wherever it comes from:
// a file an administrator uploads, or the Access database the sync agent
// reads. Each field has the names the ERP gives it (aliases); a column is
// matched on its name with case, spaces and punctuation ignored.
// ============================================================================

export type OrderCellValue = string | number

export interface OrderImportField {
  /** Also the CSV template header, and the name error messages use. */
  key: string
  label: string
  kind: 'text' | 'number' | 'date'
  aliases?: string[]
  sample: string
}

// Aliases include the Dataverse export's own column names (cr863_…), so the
// ERP file maps itself without renaming a single header.
export const ORDER_IMPORT_FIELDS: readonly OrderImportField[] = [
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
  { key: 'date', label: 'Date', kind: 'date', aliases: ['order date', 'release date', 'cr863_releasedate'], sample: '2026-01-31' },
]

/** A column name as it is matched: lower case, letters and digits only. */
export function normaliseHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, '')
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

/** Fills in what the sheet implies but does not carry: the ERP has no grade column, it lives in the raw-material description. */
export function deriveOrderValues(values: Record<string, OrderCellValue>): Record<string, OrderCellValue> {
  if (values.expectedGrade !== undefined || typeof values.material !== 'string') return values
  const grade = gradeFromMaterial(values.material)
  return grade ? { ...values, expectedGrade: grade } : values
}

/** Which column feeds which field, and the columns no field reads. */
export interface OrderColumnMatch {
  /** Field key → the column's own name. */
  byField: Record<string, string>
  unknown: string[]
}

/** Matches columns to fields on their names; the first column of a name wins. */
export function matchOrderColumns(columns: readonly string[]): OrderColumnMatch {
  const byNorm = new Map<string, string>()
  for (const c of columns) {
    const n = normaliseHeader(c)
    if (n && !byNorm.has(n)) byNorm.set(n, c)
  }
  const byField: Record<string, string> = {}
  for (const f of ORDER_IMPORT_FIELDS) {
    const hit = [f.key, f.label, ...(f.aliases ?? [])].map(normaliseHeader).map((n) => byNorm.get(n)).find((c) => c !== undefined)
    if (hit !== undefined) byField[f.key] = hit
  }
  const used = new Set(Object.values(byField))
  return { byField, unknown: columns.filter((c) => !used.has(c)) }
}

/**
 * One source row (a column name → its value, as a database or a JSON body
 * gives it) as the importer's fields. Empty cells are left out, so they never
 * overwrite a stored value. Numbers drop thousands separators; dates become
 * ISO timestamps.
 */
export function mapOrderRow(raw: Record<string, unknown>, match: OrderColumnMatch): { values: Record<string, OrderCellValue> } | { error: string } {
  const values: Record<string, OrderCellValue> = {}
  for (const f of ORDER_IMPORT_FIELDS) {
    const column = match.byField[f.key]
    if (column === undefined) continue
    const v = raw[column]
    if (v === null || v === undefined) continue
    const text = typeof v === 'string' ? v.trim() : v instanceof Date ? v.toISOString() : String(v)
    if (text === '') continue
    if (f.kind === 'number') {
      const n = typeof v === 'number' ? v : Number(text.replace(/,/g, ''))
      if (!Number.isFinite(n)) return { error: `${f.label} is not a number ("${text}")` }
      values[f.key] = n
    } else if (f.kind === 'date') {
      const d = new Date(text)
      if (Number.isNaN(d.getTime())) return { error: `${f.label} is not a date ("${text}")` }
      values[f.key] = d.toISOString()
    } else {
      values[f.key] = text
    }
  }
  return { values: deriveOrderValues(values) }
}
