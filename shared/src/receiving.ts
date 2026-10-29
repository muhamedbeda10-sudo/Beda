// ============================================================================
// §27 — Receiving: the quality of what comes in, from the warehouse's door to
// the quality decision and back.
//
//   1. The purchase orders (POs) and their lines — item, description, drawing,
//      dimensions, quantity — are the register the warehouse receives against.
//      Until the purchasing system's API exists they come from an Excel sheet
//      (Receiving → Purchase orders → Import) or are typed in; the API will
//      fill the same tables, so nothing on the screens changes then.
//   2. The warehouse keeper types the PO's number, ticks the lines that came
//      (with the quantity of each), names the factory that received them, and
//      sends a delivery note to quality receiving. A delivery of coils carries
//      the coil numbers on the supplier's paper (and a photo of it).
//   3. Quality receiving opens the delivery notes awaiting it and decides each
//      line: Accepted, Partly accepted (a quantity accepted, the rest
//      rejected), Rejected (why, with photos), or Hold (a reason from a list:
//      missing samples, missing MTC… and notes). A Hold is decided later.
//   4. Once every line is decided the warehouse sees it back, prints the note
//      (its QR code carries the decision) and closes it; the warehouse's own
//      system takes it from there.
//
// The delivered coils are a register of their own: each coil is matched with
// the MTC register (coils read from the mill's certificate) as it fills, so
// the coils still without a certificate are the list to chase.
// ============================================================================

import type { Permission } from './permissions'

export const RECEIVING_PERMISSIONS: { view: Permission; deliver: Permission; purchaseOrders: Permission; decide: Permission; setup: Permission } = {
  view: 'view-receiving',
  deliver: 'create-delivery-note',
  purchaseOrders: 'manage-purchase-orders',
  decide: 'decide-receiving',
  setup: 'manage-receiving-setup',
}

/** A delivery note holds at most this many lines, and this many coils. */
export const RECEIVING_MAX_LINES = 200
export const RECEIVING_MAX_COILS = 500
/** A PO holds at most this many lines; an import sends this many rows a request. */
export const PURCHASE_ORDER_MAX_LINES = 500
export const PURCHASE_ORDER_IMPORT_CHUNK = 500
/** numeric(14,3): eleven digits before the point. */
export const RECEIVING_QTY_MAX = 99_999_999_999

// ---- Decisions -------------------------------------------------------------------

/** A line's decision. */
export const RECEIVING_DECISIONS = ['accepted', 'partial', 'rejected', 'hold'] as const
export type ReceivingDecision = (typeof RECEIVING_DECISIONS)[number]
/** A line before its decision is pending. */
export type ReceivingLineStatus = 'pending' | ReceivingDecision
export const RECEIVING_LINE_STATUSES: readonly ReceivingLineStatus[] = ['pending', 'accepted', 'partial', 'rejected', 'hold']

export const RECEIVING_STATUS_NAMES: Record<ReceivingLineStatus, string> = {
  pending: 'Awaiting QC',
  accepted: 'Accepted',
  partial: 'Partly accepted',
  rejected: 'Rejected',
  hold: 'Hold',
}

/**
 * A delivery note's state, worked out from its lines: awaiting QC while any
 * line is undecided; on hold when none is but one is on Hold; decided when
 * every line has its decision (the warehouse prints and closes it); closed by
 * the warehouse.
 */
export const DELIVERY_NOTE_STATUSES = ['awaiting-qc', 'hold', 'decided', 'closed'] as const
export type DeliveryNoteStatus = (typeof DELIVERY_NOTE_STATUSES)[number]
export const DELIVERY_NOTE_STATUS_NAMES: Record<DeliveryNoteStatus, string> = {
  'awaiting-qc': 'Awaiting QC',
  hold: 'On hold',
  decided: 'Decided — warehouse to close',
  closed: 'Closed',
}

/** The note's state from its lines' counts, as the database works it out (migration 0089). */
export function deliveryNoteStatus(counts: { pending: number; hold: number }, closed: boolean): DeliveryNoteStatus {
  if (closed) return 'closed'
  if (counts.pending > 0) return 'awaiting-qc'
  if (counts.hold > 0) return 'hold'
  return 'decided'
}

/** The quantities a decision puts on a line: accepted and rejected, adding up to what came for every decision but Hold. */
export function decisionQuantities(decision: ReceivingDecision, quantity: number, acceptedQty: number | null): { acceptedQty: number | null; rejectedQty: number | null } | { error: string } {
  switch (decision) {
    case 'accepted': return { acceptedQty: quantity, rejectedQty: 0 }
    case 'rejected': return { acceptedQty: 0, rejectedQty: quantity }
    case 'hold': return { acceptedQty: null, rejectedQty: null }
    case 'partial': {
      if (acceptedQty === null || !(acceptedQty > 0) || !(acceptedQty < quantity)) return { error: `Enter the quantity accepted: more than 0 and less than the ${quantity} delivered.` }
      return { acceptedQty, rejectedQty: roundQty(quantity - acceptedQty) }
    }
  }
}

/** A quantity to the database's three decimals. */
export const roundQty = (v: number) => Math.round(v * 1000) / 1000

// ---- Lists -----------------------------------------------------------------------------

/** The lists set up under Receiving → Setup. */
export const RECEIVING_LISTS = ['factory', 'hold-reason', 'unit'] as const
export type ReceivingList = (typeof RECEIVING_LISTS)[number]
export const RECEIVING_LIST_NAMES: Record<ReceivingList, string> = { factory: 'Factories', 'hold-reason': 'Hold reasons', unit: 'Units' }

export interface ReceivingListValue {
  id: string
  list: ReceivingList
  value: string
  position: number
}

export interface ReceivingOptions {
  lists: ReceivingListValue[]
}

// ---- Purchase orders -------------------------------------------------------------------

export const PURCHASE_ORDER_SOURCES = ['manual', 'import', 'api'] as const
export type PurchaseOrderSource = (typeof PURCHASE_ORDER_SOURCES)[number]

export interface PurchaseOrderLineInput {
  /** The PO's own line number; given in order when left out. */
  lineNo: number | null
  itemCode: string
  description: string
  drawing: string
  dimensions: string
  quantity: number
  unit: string
  notes: string
}

export interface PurchaseOrderLine extends PurchaseOrderLineInput {
  id: string
  lineNo: number
  /** On delivery notes not deleted, and of those: decided accepted (or the accepted part), rejected, on Hold, awaiting QC. */
  deliveredQty: number
  acceptedQty: number
  rejectedQty: number
  holdQty: number
  pendingQty: number
}

export interface PurchaseOrderInput {
  poNumber: string
  supplier: string
  /** YYYY-MM-DD, or '' when not known. */
  poDate: string
  notes: string
  lines: PurchaseOrderLineInput[]
}

export interface PurchaseOrder extends Omit<PurchaseOrderInput, 'lines'> {
  id: string
  source: PurchaseOrderSource
  lines: PurchaseOrderLine[]
  deliveryNotes: number
  version: number
  createdAt: string
  createdByName: string
  updatedAt: string
  updatedByName: string
}

export interface PurchaseOrderSummary {
  id: string
  poNumber: string
  supplier: string
  poDate: string
  source: PurchaseOrderSource
  lines: number
  quantity: number
  deliveredQty: number
  updatedAt: string
}

export interface PurchaseOrderList {
  orders: PurchaseOrderSummary[]
  total: number
  hasMore: boolean
}

/** A row of the purchase orders' sheet, as the import sends it: one PO line. */
export interface PurchaseOrderImportRow {
  poNumber: string
  supplier: string
  poDate: string
  lineNo: number | null
  itemCode: string
  description: string
  drawing: string
  dimensions: string
  quantity: number
  unit: string
  notes: string
}

export interface PurchaseOrderImportResult {
  ordersCreated: number
  linesCreated: number
  linesUpdated: number
  linesUnchanged: number
}

// ---- Delivery notes ----------------------------------------------------------------------

export interface DeliveredCoilInput {
  coilNumber: string
  /** kg, when the paper gives it. */
  weight: number | null
  heatNumber: string
}

export interface DeliveredCoil extends DeliveredCoilInput {
  /** Found in the MTC register (read from the mill's certificate): no longer to chase. */
  hasMtc: boolean
  grade: string
  thickness: number | null
}

export interface DeliveryNoteLineInput {
  poLineId: string
  quantity: number
  notes: string
}

export interface DeliveryNoteLine {
  id: string
  poLineId: string
  lineNo: number
  itemCode: string
  description: string
  drawing: string
  dimensions: string
  unit: string
  orderedQty: number
  quantity: number
  notes: string
  status: ReceivingLineStatus
  acceptedQty: number | null
  rejectedQty: number | null
  /** Hold: the reason from the list. */
  holdReason: string
  /** Rejected or partly accepted: why, in detail. */
  rejectReason: string
  decisionNotes: string
  imageIds: string[]
  decidedAt: string | null
  decidedByName: string
  version: number
}

export interface DeliveryNoteEvent {
  id: string
  kind: 'created' | 'edited' | 'decided' | 'coils' | 'closed' | 'reopened'
  lineId: string | null
  itemCode: string
  status: ReceivingLineStatus | null
  text: string
  byName: string
  at: string
}

export interface DeliveryNoteInput {
  poId: string
  factory: string
  /** The day it reached the store. */
  deliveredOn: string
  supplierDnNo: string
  notes: string
  lines: DeliveryNoteLineInput[]
  coils: DeliveredCoilInput[]
  /** Photos of the supplier's papers (the coils' list). */
  imageIds: string[]
}

export interface DeliveryNoteSummary {
  id: string
  reference: string
  poId: string
  poNumber: string
  supplier: string
  factory: string
  deliveredOn: string
  supplierDnNo: string
  status: DeliveryNoteStatus
  lines: number
  pendingLines: number
  holdLines: number
  acceptedLines: number
  partialLines: number
  rejectedLines: number
  coils: number
  createdAt: string
  createdByName: string
  closedAt: string | null
}

export interface DeliveryNote extends DeliveryNoteSummary {
  notes: string
  lineItems: DeliveryNoteLine[]
  coilList: DeliveredCoil[]
  imageIds: string[]
  events: DeliveryNoteEvent[]
  createdById: string
  closedByName: string
  version: number
}

export interface DeliveryNoteList {
  notes: DeliveryNoteSummary[]
  total: number
  hasMore: boolean
}

export interface DeliveryNoteListQuery {
  q?: string
  status?: string
  factory?: string
  from?: string
  to?: string
  offset?: number
  limit?: number
}

/** POST /api/receiving/notes/:id/lines/:lineId/decision */
export interface ReceivingDecisionInput {
  decision: ReceivingDecision
  /** Partly accepted: the quantity accepted (the rest is rejected). */
  acceptedQty: number | null
  holdReason: string
  rejectReason: string
  notes: string
  imageIds: string[]
  version: number
}

/** A line as the register of received items lists it: the line with its note and PO. */
export interface ReceivedItem {
  id: string
  noteId: string
  reference: string
  poNumber: string
  supplier: string
  factory: string
  deliveredOn: string
  lineNo: number
  itemCode: string
  description: string
  drawing: string
  dimensions: string
  unit: string
  quantity: number
  status: ReceivingLineStatus
  acceptedQty: number | null
  rejectedQty: number | null
  holdReason: string
  rejectReason: string
  decisionNotes: string
  decidedAt: string | null
  decidedByName: string
  noteStatus: DeliveryNoteStatus
}

export interface ReceivedItemList {
  items: ReceivedItem[]
  total: number
  hasMore: boolean
}

export interface ReceivedItemListQuery {
  q?: string
  status?: string
  factory?: string
  from?: string
  to?: string
  offset?: number
  limit?: number
}

/** A coil delivered, with its note: the register of coils matched with the MTC register. */
export interface DeliveredCoilRow extends DeliveredCoil {
  noteId: string
  reference: string
  poNumber: string
  supplier: string
  factory: string
  deliveredOn: string
}

export interface DeliveredCoilList {
  coils: DeliveredCoilRow[]
  total: number
  missing: number
  hasMore: boolean
}

/** Coil search: the delivery a coil came on (its number lower-cased, as the search keys it). */
export interface CoilDelivery {
  coilNumber: string
  noteId: string
  reference: string
  deliveredOn: string
  poNumber: string
  supplier: string
  factory: string
}

export interface DeliveredCoilListQuery {
  q?: string
  /** missing: no certificate yet; matched: found in the MTC register. */
  mtc?: 'missing' | 'matched'
  offset?: number
  limit?: number
}

// ---- The coils' paper -----------------------------------------------------------------------

/**
 * Coil numbers as typed or pasted from the supplier's paper: one coil a line,
 * its number first, then (optionally) its weight in kg and its heat number,
 * separated by a tab (cells copied from Excel), else a semicolon, else a
 * comma. Repeats are kept once; a line with no number is left out.
 */
export function parseCoilList(text: string): { coils: DeliveredCoilInput[]; problems: string[] } {
  const coils: DeliveredCoilInput[] = []
  const problems: string[] = []
  const seen = new Set<string>()
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim()
    if (!line) continue
    const separator = line.includes('\t') ? '\t' : line.includes(';') ? ';' : ','
    const parts = line.split(separator).map((p) => p.trim())
    const coilNumber = parts[0] ?? ''
    if (!coilNumber) continue
    if (coilNumber.length > 120) { problems.push(`Line ${i + 1}: the coil number is longer than 120 characters.`); continue }
    const weightText = (parts[1] ?? '').replace(/\s*kg$/i, '').replace(/,/g, '')
    const weight = weightText === '' ? null : Number(weightText)
    if (weight !== null && !(Number.isFinite(weight) && weight >= 0 && weight <= 1_000_000)) { problems.push(`Line ${i + 1}: “${parts[1]}” is not a weight in kg.`); continue }
    const key = coilNumber.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    coils.push({ coilNumber, weight, heatNumber: (parts[2] ?? '').slice(0, 120) })
  }
  return { coils, problems }
}

/** The coils back as the text box shows them. */
export const coilListText = (coils: readonly DeliveredCoilInput[]) =>
  coils.map((c) => [c.coilNumber, c.weight ?? '', c.heatNumber].join('\t').replace(/\t+$/, '')).join('\n')

// ---- The purchase orders' sheet ---------------------------------------------------------------

interface ImportField {
  key: keyof PurchaseOrderImportRow
  label: string
  aliases: string[]
  required?: boolean
}

/** The sheet's columns, matched by their names (case, spaces and marks aside). */
export const PURCHASE_ORDER_IMPORT_FIELDS: readonly ImportField[] = [
  { key: 'poNumber', label: 'PO Number', aliases: ['PO', 'PO No', 'PO #', 'Purchase Order', 'Purchase Order No', 'Order No', 'رقم أمر الشراء'], required: true },
  { key: 'supplier', label: 'Supplier', aliases: ['Vendor', 'Supplier Name', 'Vendor Name', 'المورد'] },
  { key: 'poDate', label: 'PO Date', aliases: ['Date', 'Order Date', 'التاريخ'] },
  { key: 'lineNo', label: 'Line', aliases: ['Line No', 'Line Number', 'Pos', 'Position', 'Item No', 'رقم البند'] },
  { key: 'itemCode', label: 'Item Code', aliases: ['Item', 'Code', 'Part No', 'Part Number', 'Material', 'Material Code', 'كود الصنف'], required: true },
  { key: 'description', label: 'Description', aliases: ['Item Description', 'Item Name', 'Name', 'Material Description', 'الوصف'] },
  { key: 'drawing', label: 'Drawing', aliases: ['Drawing No', 'Drawing Number', 'DWG', 'DWG No', 'الرسمة'] },
  { key: 'dimensions', label: 'Dimensions', aliases: ['Dimension', 'Size', 'Specs', 'Specification', 'الأبعاد', 'المقاس'] },
  { key: 'quantity', label: 'Quantity', aliases: ['Qty', 'Ordered Qty', 'Order Qty', 'PO Qty', 'الكمية'], required: true },
  { key: 'unit', label: 'Unit', aliases: ['UOM', 'UoM', 'Unit of Measure', 'الوحدة'] },
  { key: 'notes', label: 'Notes', aliases: ['Remarks', 'Comment', 'Comments', 'ملاحظات'] },
]

const header = (h: string) => h.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

/** An Excel day serial, YYYY-MM-DD, or a day written day first (29/10/2026) as YYYY-MM-DD; '' otherwise. */
export function sheetDay(raw: string): string {
  const t = (raw ?? '').trim()
  let y: number, m: number, d: number
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t)
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t)
  if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])]
  else if (dmy) [y, m, d] = [Number(dmy[3]), Number(dmy[2]), Number(dmy[1])]
  else if (/^\d{5}(\.\d+)?$/.test(t)) return new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(t)) * 86_400_000).toISOString().slice(0, 10)
  else return ''
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? date.toISOString().slice(0, 10) : ''
}

const sheetNumber = (raw: string): number | null => {
  const t = (raw ?? '').trim().replace(/,(?=\d{3}\b)/g, '').replace(',', '.')
  if (!t || !/^-?\d+(\.\d+)?$/.test(t)) return null
  return Number(t)
}

/**
 * The purchase orders' sheet (its first sheet, read as a grid of text): the
 * first row that names a PO number, an item and a quantity is the header;
 * every row under it with all three is a PO line. A row without them is
 * counted as skipped with why, so the person sees what was left out.
 */
export function parsePurchaseOrderSheet(rows: readonly (readonly string[])[]): { rows: PurchaseOrderImportRow[]; skipped: string[]; missingColumns: string[] } {
  let headerAt = -1
  let byField = new Map<keyof PurchaseOrderImportRow, number>()
  let missing: string[] = PURCHASE_ORDER_IMPORT_FIELDS.filter((f) => f.required).map((f) => f.label)
  for (let r = 0; r < Math.min(rows.length, 20) && headerAt < 0; r++) {
    const found = new Map<keyof PurchaseOrderImportRow, number>()
    const names = rows[r].map((c) => header(String(c ?? '')))
    for (const f of PURCHASE_ORDER_IMPORT_FIELDS) {
      const wanted = [f.key, f.label, ...f.aliases].map(header)
      const at = names.findIndex((n) => n !== '' && wanted.includes(n))
      if (at >= 0 && ![...found.values()].includes(at)) found.set(f.key, at)
    }
    const lacking = PURCHASE_ORDER_IMPORT_FIELDS.filter((f) => f.required && !found.has(f.key)).map((f) => f.label)
    if (!lacking.length) { headerAt = r; byField = found } else if (lacking.length < missing.length) missing = lacking
  }
  if (headerAt < 0) return { rows: [], skipped: [], missingColumns: missing }
  const out: PurchaseOrderImportRow[] = []
  const skipped: string[] = []
  for (let r = headerAt + 1; r < rows.length; r++) {
    const cell = (k: keyof PurchaseOrderImportRow) => { const i = byField.get(k); return i === undefined ? '' : String(rows[r][i] ?? '').trim() }
    const poNumber = cell('poNumber'), itemCode = cell('itemCode'), quantity = sheetNumber(cell('quantity'))
    if (!poNumber && !itemCode && !cell('quantity')) continue
    const why = !poNumber ? 'no PO number' : !itemCode ? 'no item code' : quantity === null || quantity <= 0 ? 'no quantity' : quantity > RECEIVING_QTY_MAX ? 'a quantity too large' : poNumber.length > 60 ? 'a PO number longer than 60 characters' : ''
    if (why) { skipped.push(`Row ${r + 1}: ${why}.`); continue }
    const lineNo = sheetNumber(cell('lineNo'))
    out.push({
      poNumber, itemCode: itemCode.slice(0, 120), quantity: roundQty(quantity!),
      supplier: cell('supplier').slice(0, 200), poDate: sheetDay(cell('poDate')),
      lineNo: lineNo !== null && Number.isInteger(lineNo) && lineNo > 0 && lineNo < 1_000_000 ? lineNo : null,
      description: cell('description').slice(0, 500), drawing: cell('drawing').slice(0, 200), dimensions: cell('dimensions').slice(0, 500),
      unit: cell('unit').slice(0, 30), notes: cell('notes').slice(0, 2000),
    })
  }
  return { rows: out, skipped, missingColumns: [] }
}

// ---- The paper's QR code ----------------------------------------------------------------------

/**
 * What a delivery note's QR code holds: where to open it in the app, then its
 * decision line by line, so a phone without the app still reads it.
 */
export function deliveryNoteQrText(note: Pick<DeliveryNote, 'reference' | 'poNumber' | 'supplier' | 'factory' | 'deliveredOn' | 'lineItems'>, link: string): string {
  const lines = note.lineItems.map((l) => {
    const qty = l.status === 'partial' ? ` ${l.acceptedQty}/${l.quantity}` : ` ${l.quantity}`
    const by = l.decidedByName ? ` by ${l.decidedByName}` : ''
    return `${l.itemCode}${qty} ${l.unit}`.trim() + `: ${RECEIVING_STATUS_NAMES[l.status]}${by}`
  })
  const text = [link, `${note.reference} · PO ${note.poNumber}`, [note.supplier, note.factory, note.deliveredOn].filter(Boolean).join(' · '), ...lines].join('\n')
  // A QR code holds about 2 900 bytes at its lowest correction: past a long note, the link alone says the rest.
  return new TextEncoder().encode(text).length > 1800 ? [link, `${note.reference} · PO ${note.poNumber}`, `${note.lineItems.length} lines`].join('\n') : text
}
