// ============================================================================
// Dataverse choice decoding.
//
// The numbering is NOT consistent between columns — session status starts at
// ...002 while everything else starts at ...000. Every table below is taken
// from the Dataverse metadata, not inferred from the data. An unknown value is
// never guessed: it is returned as a failure so the run reports it.
// ============================================================================

export const SESSION_STATUS = {
  898710002: 'Open',
  898710003: 'Closed',
}

export const SHIFT = {
  898710000: 'A', // Morning
  898710001: 'B', // Afternoon
  898710002: 'C', // Night
}

export const DIMENSION_STATUS = {
  898710000: 'Pass',
  898710001: 'Fail',
  898710002: 'Warning',
}

export const DEFECT_STATUS = {
  898710000: 'Rejected',
  898710001: 'Hold',
  898710002: 'Repair',
  898710003: 'Used in another order',
  898710004: 'Accept with concession',
}

/** Only two values exist. Creation was recorded as Update (e.g. "New Coil" with
 *  a null old value), so there is no Create — do not invent one. */
export const AUDIT_ACTION = {
  898710000: 'update',
  898710001: 'delete',
}

/** Order status really lives in cr863_accessstatus; cr863_status is empty in
 *  all 28,871 rows. Losing this would hide that 7,232 orders are cancelled. */
export const ORDER_STATUS = new Set(['Active', 'Cancel', 'Hold', 'Stock'])

const ROUTE_BY_NORMALISED = {
  local: 'Local',
  export: 'Export',
  'export-ks': 'Export-KS',
}

export class DecodeFailure {
  constructor(field, value, reason) {
    this.field = field
    this.value = value
    this.reason = reason
  }
}

/**
 * Decode a choice value. Returns { value } or { failure } — never a guess.
 * A null/undefined source value decodes to `fallback` without being a failure,
 * because "not set" is a real state in this data.
 */
export function decodeChoice(table, field, raw, fallback = null) {
  if (raw === null || raw === undefined || raw === '') return { value: fallback }
  const key = Number(raw)
  const hit = table[key]
  if (hit === undefined) {
    return { failure: new DecodeFailure(field, raw, 'value not present in the Dataverse choice metadata') }
  }
  return { value: hit }
}

/** Route/market. Three values exist, plus lowercase strays and two nulls. */
export function decodeRoute(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return { value: null }
  const norm = String(raw).trim().toLowerCase()
  const hit = ROUTE_BY_NORMALISED[norm]
  if (!hit) return { failure: new DecodeFailure('cr863_explocal', raw, 'unrecognised route') }
  return { value: hit }
}

/** Order status, taken verbatim from cr863_accessstatus. */
export function decodeOrderStatus(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return { value: null }
  const v = String(raw).trim()
  if (!ORDER_STATUS.has(v)) {
    return { failure: new DecodeFailure('cr863_accessstatus', raw, 'unrecognised order status') }
  }
  return { value: v }
}

/**
 * Pull the steel grade out of the raw-material description.
 *
 *   "RM.ST.CO.PRG. : 298 : 2.4 : S420GD+Z275MAC : ZCL"  ->  "S420GD+Z275MAC"
 *
 * Only the five-segment form is trusted; 65% of orders carry no description at
 * all. Anything else returns null, and the grade-mismatch check must then skip
 * silently rather than compare against an invented value.
 */
export function extractGrade(rawMaterialDescription) {
  if (!rawMaterialDescription) return null
  const parts = String(rawMaterialDescription).split(':').map((p) => p.trim())
  if (parts.length !== 5) return null
  const grade = parts[3]
  return grade && grade !== '0' ? grade : null
}

/** Dataverse dates are ISO-8601 UTC strings. Kept verbatim — reformatting a
 *  historical timestamp is a silent change to the record. */
export function isoOrNull(raw) {
  if (!raw) return null
  const s = String(raw)
  return Number.isNaN(new Date(s).getTime()) ? null : s
}

export function numOrNull(raw) {
  if (raw === null || raw === undefined || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

export function strOrNull(raw) {
  if (raw === null || raw === undefined) return null
  const s = String(raw).trim()
  return s === '' ? null : s
}

/** Legacy users are Dataverse GUIDs, not Firebase uids. Namespacing them keeps
 *  the two identity spaces from ever colliding. */
export function legacyUid(guid) {
  return guid ? `legacy:${guid}` : 'legacy:unknown'
}
