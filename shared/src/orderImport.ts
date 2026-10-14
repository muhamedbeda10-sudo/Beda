// ============================================================================
// §7.7 — the order sheet's columns, read the same way wherever it comes from:
// a file an administrator uploads, or the Access database the sync agent
// reads. Each field has the names the ERP gives it (aliases); a column is
// matched on its name with case, spaces and punctuation ignored.
//
// Two groups. The CORE fields are what inspection, PDI and the dashboard
// work from; an empty cell never overwrites them. The ERP DETAILS (§7.7.1)
// are the rest of the ERP's "Tasks" query (planning, shipping, QC totals,
// delays…), carried for the Access list and the assistant; for them the
// file is the truth, so an empty cell clears what was stored.
// ============================================================================

/** A cell as the importer sends it. `null` only for a field that clears when empty: "the ERP has no value here now". */
export type OrderCellValue = string | number | null

export interface OrderImportField {
  /** Also the CSV template header, and the name error messages use. */
  key: string
  label: string
  /**
   * `date` is a moment (sent as an ISO timestamp); `day` is a calendar day
   * with no time and no time zone (sent as YYYY-MM-DD), so a due date reads
   * the same day wherever the browser is.
   */
  kind: 'text' | 'number' | 'date' | 'day'
  aliases?: readonly string[]
  sample: string
  /** A number that must be whole (a code). */
  integer?: boolean
  /** An empty cell in a mapped column clears the stored value instead of leaving it alone. */
  clearsWhenEmpty?: boolean
}

// Aliases include the Dataverse export's own column names (cr863_…), so the
// ERP file maps itself without renaming a single header. The ERP's Tasks sheet
// has no grade and no issue column: the expected grade is read from the
// raw-material description (deriveOrderValues), and an issue is the
// inspector's to type on the sample.
const ORDER_CORE_FIELDS: readonly OrderImportField[] = [
  { key: 'lineKey', label: 'Order ID', kind: 'text', aliases: ['order id', 'orderid', 'id', 'line id', 'line', 'cr863_orderid'], sample: '100245' },
  { key: 'orderNumber', label: 'Order number', kind: 'text', aliases: ['order', 'order name', 'order no', 'ordernr', 'po', 'cr863_order'], sample: '20480-Ph1.4-SMA' },
  { key: 'itemCode', label: 'Item code', kind: 'text', aliases: ['item id', 'code', 'part code', 'cr863_itemid'], sample: 'LB406015-5TA3' },
  { key: 'item', label: 'Item name', kind: 'text', aliases: ['item', 'description', 'cr863_item'], sample: 'Shuttle Beam' },
  { key: 'workCenterCode', label: 'Machine code', kind: 'text', aliases: ['machine', 'machine code', 'work center', 'work centre', 'wc', 'cr863_workcenter'], sample: '48' },
  { key: 'requiredQty', label: 'Required qty', kind: 'number', aliases: ['required', 'quantity', 'req q', 'cr863_req_q'], sample: '1350' },
  { key: 'finishedQty', label: 'Finished qty', kind: 'number', aliases: ['finished', 'produced', 'finished q', 'cr863_finished_q'], sample: '900' },
  { key: 'drawing', label: 'Drawing', kind: 'text', aliases: ['dwg', 'dwg1', 'cr863_dwg1'], sample: 'BS9059/48' },
  { key: 'drawingAlt', label: 'Alternative drawing', kind: 'text', aliases: ['drawing 2', 'alt drawing', 'dwg2', 'cr863_dwg2'], sample: 'BS9059/48-ALT' },
  { key: 'material', label: 'Material', kind: 'text', aliases: ['raw material', 'raw material description', 'cr863_rawmaterialdescription'], sample: 'RM.ST.CO.HR. : 344 : 1.5 : S315MC : PO' },
  { key: 'customer', label: 'Customer', kind: 'text', aliases: ['client', 'cus name', 'cr863_cusname'], sample: 'Alpha Racking' },
  { key: 'type', label: 'Type', kind: 'text', aliases: ['exp local', 'export local', 'cr863_explocal'], sample: 'Export' },
  { key: 'colour', label: 'Colour', kind: 'text', aliases: ['color', 'ral', 'cr863_color'], sample: 'RAL7016' },
  { key: 'erpStatus', label: 'Status', kind: 'text', aliases: ['access status', 'accessstatus', 'cr863_accessstatus'], sample: 'Active' },
  { key: 'date', label: 'Date', kind: 'date', aliases: ['order date', 'release date', 'cr863_releasedate'], sample: '2026-01-31' },
]

/**
 * §7.7.1 — the ERP details of an order line: every other column of the ERP's
 * "Tasks" query, one value per line. Each alias is the ERP's own header, so
 * the export maps itself. Kept apart from the core fields: an empty cell
 * clears them (the ERP removed the value), and nothing in inspection reads
 * them. `Pivot` is the line's planning week, "01/2026" = week/year.
 */
export const ORDER_DETAIL_FIELDS = [
  { key: 'dueDate', label: 'Due date', kind: 'day', aliases: ['due date'], sample: '2026-02-25' },
  { key: 'refinedDate', label: 'Refined date', kind: 'day', aliases: ['refined date'], sample: '2026-06-30' },
  { key: 'planningWeek', label: 'Planning week', kind: 'text', aliases: ['pivot', 'planning week'], sample: '01/2026' },
  { key: 'erpRemainingQty', label: 'Remaining qty (ERP)', kind: 'number', aliases: ['rem q', 'remaining qty'], sample: '0' },
  { key: 'cancelledQty', label: 'Cancelled qty', kind: 'number', aliases: ['canceled qty', 'cancelled qty'], sample: '0' },
  { key: 'acceptedQty', label: 'Accepted qty', kind: 'number', aliases: ['accepted qty'], sample: '24' },
  { key: 'stockQty', label: 'Stock qty', kind: 'number', aliases: ['stock qty'], sample: '0' },
  { key: 'lengthMm', label: 'Length (mm)', kind: 'number', aliases: ['l mm', 'length mm'], sample: '2550' },
  { key: 'widthMm', label: 'Width (mm)', kind: 'number', aliases: ['w mm', 'width mm'], sample: '349' },
  { key: 'thicknessMm', label: 'Thickness (mm)', kind: 'number', aliases: ['t mm', 'thickness mm'], sample: '2.5' },
  { key: 'weightKg', label: 'Weight (kg)', kind: 'number', aliases: ['w kg', 'weight kg'], sample: '419.17' },
  { key: 'stage', label: 'Stage', kind: 'text', sample: '' },
  { key: 'qcCategory', label: 'QC category', kind: 'text', aliases: ['qc category'], sample: 'Normal' },
  { key: 'versionParentId', label: 'Version parent ID', kind: 'text', aliases: ['version parent id'], sample: '0015-19145-Ph1.23-EHF-' },
  { key: 'parentId', label: 'Parent ID', kind: 'text', aliases: ['parent id'], sample: '0015-19145-Ph1.23-EHF-FP00' },
  { key: 'partDurationHours', label: 'Part duration (h)', kind: 'number', aliases: ['part dur hr', 'part duration'], sample: '0.13' },
  { key: 'modelGroupId', label: 'Model group', kind: 'text', aliases: ['model group id', 'model group'], sample: 'FP.MF' },
  { key: 'totalAreaM2', label: 'Total area (m2)', kind: 'number', aliases: ['total area m2', 'total area'], sample: '42.72' },
  { key: 'totalPowderKg', label: 'Total powder (kg)', kind: 'number', aliases: ['total powder kg', 'total powder'], sample: '0' },
  { key: 'erpOrderType', label: 'Order type', kind: 'text', aliases: ['order type'], sample: 'Production' },
  { key: 'rawMaterialQty', label: 'Raw material qty', kind: 'number', aliases: ['raw material qty'], sample: '419.17' },
  { key: 'coilSerialNumber', label: 'Coil serial number', kind: 'text', aliases: ['coil serial number', 'coil serial'], sample: '' },
  { key: 'rawMaterialPowder', label: 'Raw material powder', kind: 'text', aliases: ['raw material powder'], sample: 'RM.PW.CO.HB. : G50 : 180 : Union : LG7035' },
  { key: 'itemFamily', label: 'Item family', kind: 'text', aliases: ['item family'], sample: 'SH' },
  { key: 'itemTranslation', label: 'Item name (Arabic)', kind: 'text', aliases: ['translation', 'item translation'], sample: 'شاتيل ريل' },
  { key: 'totalActualSampleQty', label: 'Actual sample qty', kind: 'number', aliases: ['total actual sample qty'], sample: '5' },
  { key: 'totalHoldQty', label: 'Hold qty', kind: 'number', aliases: ['total hold qty'], sample: '0' },
  { key: 'totalStdSampleQty', label: 'Standard sample qty', kind: 'number', aliases: ['total std sample qty'], sample: '5' },
  { key: 'totalRemQcRecordQty', label: 'QC qty still to record', kind: 'number', aliases: ['total rem qc record qty'], sample: '0' },
  { key: 'plannedStart', label: 'Planned start', kind: 'day', aliases: ['planned start'], sample: '2026-04-06' },
  { key: 'plannedFinish', label: 'Planned finish', kind: 'day', aliases: ['planned finish'], sample: '2026-04-06' },
  { key: 'shippingStatus', label: 'Shipping status', kind: 'text', aliases: ['shipping status'], sample: 'Shipped' },
  { key: 'shippingStartDate', label: 'Shipping start', kind: 'day', aliases: ['shipping start date', 'shipping start'], sample: '2026-04-06' },
  { key: 'shippingEndDate', label: 'Shipping end', kind: 'day', aliases: ['shipping end date', 'shipping end'], sample: '2026-04-06' },
  { key: 'bomId', label: 'BOM ID', kind: 'text', aliases: ['bom id'], sample: '' },
  { key: 'rmReceivedQty', label: 'RM received qty', kind: 'number', aliases: ['rm received qty'], sample: '0' },
  { key: 'rmReceivingDate', label: 'RM receiving date', kind: 'day', aliases: ['rm receiving date'], sample: '' },
  { key: 'delayReasonCode', label: 'Delay reason', kind: 'number', integer: true, aliases: ['delay reason', 'delay reason code'], sample: '24' },
  { key: 'delayPeriod', label: 'Delay period', kind: 'number', aliases: ['delay period'], sample: '0' },
  { key: 'delayComment', label: 'Delay comment', kind: 'text', aliases: ['delay comment'], sample: '' },
  { key: 'statusReason', label: 'Status reason', kind: 'text', aliases: ['status reason'], sample: '' },
  { key: 'rmPromiseDate', label: 'RM promise date', kind: 'day', aliases: ['rm promiss date', 'rm promise date'], sample: '' },
] as const satisfies readonly OrderImportField[]

export type OrderDetailField = (typeof ORDER_DETAIL_FIELDS)[number]
export type OrderDetailKey = OrderDetailField['key']

/** An ERP detail's value: a number for a figure, YYYY-MM-DD for a day, else text; null when the ERP has none. */
export type OrderLineErpDetails = {
  [F in OrderDetailField as F['key']]: (F['kind'] extends 'number' ? number : string) | null
}

export const ORDER_DETAIL_KEYS: readonly OrderDetailKey[] = ORDER_DETAIL_FIELDS.map((f) => f.key)

/** Every column the order sheet may carry: the core fields, then the ERP details. */
export const ORDER_IMPORT_FIELDS: readonly OrderImportField[] = [
  ...ORDER_CORE_FIELDS,
  ...ORDER_DETAIL_FIELDS.map((f): OrderImportField => ({ ...f, clearsWhenEmpty: true })),
]

const isRealDay = (y: number, mo: number, d: number): boolean => {
  const t = new Date(Date.UTC(y, mo - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d
}
const ymd = (y: number, mo: number, d: number): string => `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`

/**
 * A calendar day as an export writes it: ISO ("2026-01-05", with or without
 * a time, as the workbook reader gives a date cell), or the day-first form
 * Access and Excel write in Egypt ("05/01/2026", "5-1-2026"). The day only;
 * no time zone is applied. Anything else is not a day.
 */
export function parseDay(value: string | null | undefined): string | null {
  if (!value) return null
  const s = value.trim()
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s)
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
    return isRealDay(y, mo, d) ? ymd(y, mo, d) : null
  }
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[T ].*)?$/.exec(s)
  if (m) {
    const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])]
    return isRealDay(y, mo, d) ? ymd(y, mo, d) : null
  }
  return null
}

/**
 * One cell's text as the field's value, or why it cannot be. Numbers drop
 * thousands separators; a date becomes an ISO timestamp so the server never
 * guesses a spreadsheet's format; a day becomes YYYY-MM-DD. The one reading
 * shared by the file importer and the Access sync.
 */
export function readOrderCell(field: OrderImportField, text: string): { value: string | number } | { error: string } {
  if (field.kind === 'number') {
    const n = Number(text.replace(/,/g, ''))
    if (!Number.isFinite(n)) return { error: `${field.label} is not a number ("${text}")` }
    if (field.integer && !Number.isInteger(n)) return { error: `${field.label} is not a whole number ("${text}")` }
    return { value: n }
  }
  if (field.kind === 'date') {
    const d = new Date(text)
    return Number.isNaN(d.getTime()) ? { error: `${field.label} is not a date ("${text}")` } : { value: d.toISOString() }
  }
  if (field.kind === 'day') {
    const day = parseDay(text)
    return day ? { value: day } : { error: `${field.label} is not a day ("${text}")` }
  }
  return { value: text }
}

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
  if (typeof values.material !== 'string') return values
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
 * gives it) as the importer's fields. An empty cell of a core field is left
 * out, so it never overwrites a stored value; an empty cell of an ERP detail
 * is null, which clears it. A column the row does not carry at all is left
 * out either way.
 */
export function mapOrderRow(raw: Record<string, unknown>, match: OrderColumnMatch): { values: Record<string, OrderCellValue> } | { error: string } {
  const values: Record<string, OrderCellValue> = {}
  for (const f of ORDER_IMPORT_FIELDS) {
    const column = match.byField[f.key]
    if (column === undefined || !Object.prototype.hasOwnProperty.call(raw, column)) continue
    const v = raw[column]
    const text = v === null || v === undefined ? '' : typeof v === 'string' ? v.trim() : v instanceof Date ? v.toISOString() : String(v)
    if (text === '') {
      if (f.clearsWhenEmpty) values[f.key] = null
      continue
    }
    const cell = readOrderCell(f, text)
    if ('error' in cell) return cell
    values[f.key] = cell.value
  }
  return { values: deriveOrderValues(values) }
}
