// ============================================================================
// §27 — Receiving: the purchase orders, the warehouse's delivery notes,
// quality receiving's decision on each of their lines, and the coils they
// brought, matched with the MTC register.
//
// What is worked out from the lines — a note's counts and state, a PO line's
// delivered, accepted, rejected, hold and pending quantities — the database
// keeps as they are written (migration 0089), so every screen and the
// assistant read the same figures. A note is changed by the warehouse only
// while quality has decided none of its lines; a decision is changed until
// the warehouse closes the note; every step is in the note's history and the
// audit log.
// ============================================================================

import { createHash } from 'node:crypto'
import { Router } from 'express'
import { z } from 'zod'
import {
  PURCHASE_ORDER_IMPORT_CHUNK, PURCHASE_ORDER_MAX_LINES, RECEIVING_DECISIONS, RECEIVING_LINE_STATUSES, RECEIVING_LISTS, RECEIVING_MAX_COILS, RECEIVING_MAX_LINES,
  RECEIVING_PERMISSIONS, RECEIVING_QTY_MAX, RECEIVING_STATUS_NAMES, DELIVERY_NOTE_STATUSES, decisionQuantities, roundQty,
  type CoilDelivery, type DeliveredCoil, type DeliveredCoilList, type DeliveredCoilRow, type DeliveryNote, type DeliveryNoteEvent, type DeliveryNoteLine, type DeliveryNoteList,
  type DeliveryNoteStatus, type DeliveryNoteSummary, type PurchaseOrder, type PurchaseOrderImportResult, type PurchaseOrderLine, type PurchaseOrderList,
  type PurchaseOrderSummary, type ReceivedItem, type ReceivedItemList, type ReceivingListValue, type ReceivingOptions,
} from '@qc/shared/receiving'
import type { AppContext } from '../context'
import { requireAnyPermission, requirePermission, requireUser, userCan, type AuthUser } from '../auth/middleware'
import { auditChanges, auditCreate, auditDelete } from '../audit/service'
import { createNotifications } from '../automations/notify'
import { LIVE_PERSON } from '../automations/people'
import { withTransaction, type Queryable } from '../db/pool'
import { badRequest, ConflictError, duplicate, forbidden, HttpError, notFound } from '../lib/errors'
import { parse } from '../lib/validate'
import { assertImagesUsable } from './images.links'
import { readableImageIds } from './images.routes'
import { qualityDay } from './qualityRecords.schemas'

const P = RECEIVING_PERMISSIONS
const n = (v: string) => `${v}::float8`
const contains = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
const text = (max: number) => z.string().trim().max(max).default('')
const qty = z.number().finite().gt(0).max(RECEIVING_QTY_MAX).transform(roundQty)
const optionalDay = z.union([z.literal(''), qualityDay]).default('')
const ids = (max: number) => z.array(z.string().uuid()).max(max).default([]).transform((v) => Array.from(new Set(v)))
const page = { offset: z.coerce.number().int().min(0).max(1_000_000).default(0), limit: z.coerce.number().int().min(1).max(5000).default(50) }

const poLineSchema = z.object({
  id: z.string().uuid().optional(),
  lineNo: z.number().int().min(1).max(999_999).nullable().default(null),
  itemCode: z.string().trim().min(1).max(120),
  description: text(500),
  drawing: text(200),
  dimensions: text(500),
  quantity: qty,
  unit: text(30),
  notes: text(2000),
})
const poSchema = z.object({
  poNumber: z.string().trim().min(1).max(60),
  supplier: text(200),
  poDate: optionalDay,
  notes: text(4000),
  lines: z.array(poLineSchema).min(1).max(PURCHASE_ORDER_MAX_LINES),
})
type PoInput = z.infer<typeof poSchema>
const importRowSchema = z.object({
  poNumber: z.string().trim().min(1).max(60),
  supplier: text(200),
  poDate: optionalDay,
  lineNo: z.number().int().min(1).max(999_999).nullable().default(null),
  itemCode: z.string().trim().min(1).max(120),
  description: text(500),
  drawing: text(200),
  dimensions: text(500),
  quantity: qty,
  unit: text(30),
  notes: text(2000),
})
const coilSchema = z.object({
  coilNumber: z.string().trim().min(1).max(120),
  weight: z.number().finite().min(0).max(1_000_000).nullable().default(null),
  heatNumber: text(120),
})
const coilsSchema = z.array(coilSchema).max(RECEIVING_MAX_COILS).default([]).superRefine((coils, ctx) => {
  const seen = new Set<string>()
  for (const [i, c] of coils.entries()) {
    const key = c.coilNumber.toLowerCase()
    if (seen.has(key)) ctx.addIssue({ code: 'custom', path: [i, 'coilNumber'], message: `Coil ${c.coilNumber} is listed twice.` })
    seen.add(key)
  }
})
const noteLineSchema = z.object({ poLineId: z.string().uuid(), quantity: qty, notes: text(2000) })
const noteSchema = z.object({
  poId: z.string().uuid(),
  factory: z.string().trim().min(1, 'Choose the factory that received it.').max(120),
  deliveredOn: qualityDay,
  supplierDnNo: text(120),
  notes: text(4000),
  lines: z.array(noteLineSchema).min(1, 'Choose at least one item that came.').max(RECEIVING_MAX_LINES).superRefine((lines, ctx) => {
    const seen = new Set<string>()
    for (const [i, l] of lines.entries()) {
      if (seen.has(l.poLineId)) ctx.addIssue({ code: 'custom', path: [i, 'poLineId'], message: 'A PO line is listed twice.' })
      seen.add(l.poLineId)
    }
  }),
  coils: coilsSchema,
  imageIds: ids(20),
})
type NoteInput = z.infer<typeof noteSchema>
const decisionSchema = z.object({
  decision: z.enum(RECEIVING_DECISIONS),
  acceptedQty: z.number().finite().min(0).max(RECEIVING_QTY_MAX).nullable().default(null),
  holdReason: text(120),
  rejectReason: text(4000),
  notes: text(4000),
  imageIds: ids(20),
  version: z.number().int().min(0),
})
const listQuery = z.object({
  q: z.string().trim().max(200).default(''),
  status: z.enum(DELIVERY_NOTE_STATUSES).or(z.literal('open')).optional(),
  factory: z.string().trim().max(120).optional(),
  from: qualityDay.optional(),
  to: qualityDay.optional(),
  ...page,
})
const itemsQuery = listQuery.omit({ status: true }).extend({ status: z.enum(RECEIVING_LINE_STATUSES as [string, ...string[]]).optional() })

// ---- Reads -----------------------------------------------------------------------------

const PO_LINE_SELECT = `l.id, l.line_no AS "lineNo", l.item_code AS "itemCode", l.description, l.drawing, l.dimensions, ${n('l.quantity')} AS quantity, l.unit, l.notes,
  ${n('l.delivered_qty')} AS "deliveredQty", ${n('l.accepted_qty')} AS "acceptedQty", ${n('l.rejected_qty')} AS "rejectedQty", ${n('l.hold_qty')} AS "holdQty", ${n('l.pending_qty')} AS "pendingQty"`

async function readPo(q: Queryable, id: string): Promise<PurchaseOrder | undefined> {
  const po = (await q.query<Omit<PurchaseOrder, 'lines'>>(`SELECT p.id, p.po_number AS "poNumber", p.supplier, COALESCE(to_char(p.po_date, 'YYYY-MM-DD'), '') AS "poDate", p.notes, p.source,
      (SELECT count(*)::int FROM delivery_notes d WHERE d.po_id = p.id AND d.deleted_at IS NULL) AS "deliveryNotes", p.version,
      p.created_at AS "createdAt", p.created_by_name AS "createdByName", p.updated_at AS "updatedAt", p.updated_by_name AS "updatedByName"
    FROM purchase_orders p WHERE p.id = $1 AND p.deleted_at IS NULL`, [id])).rows[0]
  if (!po) return undefined
  const lines = (await q.query<PurchaseOrderLine>(`SELECT ${PO_LINE_SELECT} FROM purchase_order_lines l WHERE l.po_id = $1 AND l.deleted_at IS NULL ORDER BY l.line_no`, [id])).rows
  return { ...po, lines }
}

const NOTE_SUMMARY = `d.id, d.reference, d.po_id AS "poId", p.po_number AS "poNumber", p.supplier, d.factory, to_char(d.delivered_on, 'YYYY-MM-DD') AS "deliveredOn",
  d.supplier_dn_no AS "supplierDnNo", d.status, d.lines, d.pending_lines AS "pendingLines", d.hold_lines AS "holdLines", d.accepted_lines AS "acceptedLines",
  d.partial_lines AS "partialLines", d.rejected_lines AS "rejectedLines", d.coils, d.created_at AS "createdAt", d.created_by_name AS "createdByName", d.closed_at AS "closedAt"`

async function readNote(q: Queryable, id: string): Promise<DeliveryNote | undefined> {
  const note = (await q.query<Omit<DeliveryNote, 'lineItems' | 'coilList' | 'imageIds' | 'events'>>(`SELECT ${NOTE_SUMMARY}, d.notes, d.created_by_id AS "createdById",
      d.closed_by_name AS "closedByName", d.version
    FROM delivery_notes d JOIN purchase_orders p ON p.id = d.po_id WHERE d.id = $1 AND d.deleted_at IS NULL`, [id])).rows[0]
  if (!note) return undefined
  // One after another: inside a transaction they share one connection.
  const lines = await q.query<DeliveryNoteLine>(`SELECT l.id, l.po_line_id AS "poLineId", pl.line_no AS "lineNo", pl.item_code AS "itemCode", pl.description, pl.drawing, pl.dimensions, pl.unit,
        ${n('pl.quantity')} AS "orderedQty", ${n('l.quantity')} AS quantity, l.notes, l.status, ${n('l.accepted_qty')} AS "acceptedQty", ${n('l.rejected_qty')} AS "rejectedQty",
        l.hold_reason AS "holdReason", l.reject_reason AS "rejectReason", l.decision_notes AS "decisionNotes",
        COALESCE((SELECT array_agg(x.image_id ORDER BY x.position) FROM delivery_note_images x WHERE x.line_id = l.id AND x.removed_at IS NULL), '{}') AS "imageIds",
        l.decided_at AS "decidedAt", l.decided_by_name AS "decidedByName", l.version
      FROM delivery_note_lines l JOIN purchase_order_lines pl ON pl.id = l.po_line_id WHERE l.note_id = $1 ORDER BY l.position`, [id])
  const coils = await q.query<DeliveredCoil>(`SELECT c.coil_number AS "coilNumber", ${n('c.weight')} AS weight, c.heat_number AS "heatNumber", r.id IS NOT NULL AS "hasMtc",
        COALESCE(r.grade, '') AS grade, ${n('r.thickness')} AS thickness
      FROM delivery_note_coils c LEFT JOIN coils r ON lower(r.coil_number) = lower(btrim(c.coil_number)) AND r.deleted_at IS NULL
      WHERE c.note_id = $1 ORDER BY c.position`, [id])
  const images = await q.query<{ id: string }>(`SELECT image_id AS id FROM delivery_note_images WHERE note_id = $1 AND line_id IS NULL AND removed_at IS NULL ORDER BY position`, [id])
  const events = await q.query<DeliveryNoteEvent>(`SELECT id, kind, line_id AS "lineId", item_code AS "itemCode", status, text, by_name AS "byName", at FROM delivery_note_events
    WHERE note_id = $1 ORDER BY at, id`, [id])
  return { ...note, lineItems: lines.rows, coilList: coils.rows, imageIds: images.rows.map((r) => r.id), events: events.rows }
}

// ---- Writes -----------------------------------------------------------------------------

async function event(tx: Queryable, noteId: string, user: AuthUser, e: { kind: DeliveryNoteEvent['kind']; lineId?: string; itemCode?: string; status?: string; text?: string }) {
  await tx.query(`INSERT INTO delivery_note_events (note_id, line_id, kind, item_code, status, text, by_id, by_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [noteId, e.lineId ?? null, e.kind, e.itemCode ?? '', e.status ?? null, e.text ?? '', user.id, user.name])
}

/** The next note number of a year: DN-26-0001. */
async function nextReference(tx: Queryable, year: number): Promise<string> {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const { rows } = await tx.query<{ n: number }>(`INSERT INTO delivery_note_counters (year, last_number) VALUES ($1, 1)
      ON CONFLICT (year) DO UPDATE SET last_number = delivery_note_counters.last_number + 1 RETURNING last_number AS n`, [year])
    const reference = `DN-${String(year % 100).padStart(2, '0')}-${String(rows[0].n).padStart(4, '0')}`
    if (!(await tx.query('SELECT 1 FROM delivery_notes WHERE reference = $1', [reference])).rows.length) return reference
  }
  throw new Error('No delivery note number is free.')
}

async function writeCoils(tx: Queryable, noteId: string, coils: NoteInput['coils']): Promise<void> {
  await tx.query('DELETE FROM delivery_note_coils WHERE note_id = $1', [noteId])
  if (!coils.length) return
  await tx.query(`INSERT INTO delivery_note_coils (note_id, position, coil_number, weight, heat_number)
    SELECT $1, x.position, x.coil_number, x.weight, x.heat_number FROM json_to_recordset($2::json) AS x(position int, coil_number text, weight numeric, heat_number text)`,
  [noteId, JSON.stringify(coils.map((c, i) => ({ position: i + 1, coil_number: c.coilNumber, weight: c.weight, heat_number: c.heatNumber })))])
}

/** The images of the note (its papers, lineId null) or of one line's decision, in order. */
async function attachImages(tx: Queryable, noteId: string, lineId: string | null, imageIds: string[]): Promise<void> {
  await tx.query(`UPDATE delivery_note_images SET removed_at = now() WHERE note_id = $1 AND line_id IS NOT DISTINCT FROM $2 AND removed_at IS NULL AND NOT (image_id = ANY($3::uuid[]))`,
    [noteId, lineId, imageIds])
  for (const [position, id] of imageIds.entries()) {
    await tx.query(`INSERT INTO delivery_note_images (note_id, image_id, line_id, position) VALUES ($1,$2,$3,$4)
      ON CONFLICT (note_id, image_id) DO UPDATE SET position = EXCLUDED.position, line_id = EXCLUDED.line_id, removed_at = NULL`, [noteId, id, lineId, position])
  }
}

async function checkImages(tx: Queryable, user: AuthUser, wanted: string[], already: string[]): Promise<void> {
  await assertImagesUsable(tx, wanted)
  // Images already on the record stay usable by whoever may change it.
  const fresh = wanted.filter((i) => !already.includes(i))
  if ((await readableImageIds(tx, user, fresh)).size !== fresh.length) throw forbidden('One of these images is not available to you.')
}

/** The live people who may decide deliveries, but the one who acts. */
async function deciders(q: Queryable, except: string): Promise<string[]> {
  const { rows } = await q.query<{ id: string }>(`SELECT u.id FROM users u WHERE ${LIVE_PERSON} AND u.id <> $2 AND user_has_permission(u.id, $1)`, [P.decide, except])
  return rows.map((r) => r.id)
}

const quantityText = (v: number | null, unit: string) => (v === null ? '' : `${Number(v.toFixed(3))}${unit ? ` ${unit}` : ''}`)

/** A decision in a sentence, for the note's history and the bell. */
function decisionText(d: { status: string; quantity: number; acceptedQty: number | null; rejectedQty: number | null; holdReason: string; rejectReason: string; notes: string }, unit: string): string {
  const head = d.status === 'partial' ? `Partly accepted: ${quantityText(d.acceptedQty, unit)} accepted, ${quantityText(d.rejectedQty, unit)} rejected`
    : d.status === 'hold' ? `Hold: ${d.holdReason}`
    : `${RECEIVING_STATUS_NAMES[d.status as keyof typeof RECEIVING_STATUS_NAMES]} (${quantityText(d.quantity, unit)})`
  return [head, d.rejectReason && `Why: ${d.rejectReason}`, d.notes].filter(Boolean).join(' — ')
}

/** Lines of one PO, live, by id. */
async function poLinesOf(tx: Queryable, poId: string, lineIds: string[]) {
  const { rows } = await tx.query<{ id: string; itemCode: string; unit: string }>(`SELECT id, item_code AS "itemCode", unit FROM purchase_order_lines
    WHERE id = ANY($1::uuid[]) AND po_id = $2 AND deleted_at IS NULL`, [lineIds, poId])
  if (rows.length !== new Set(lineIds).size) throw badRequest('One of the items is not on this PO any more. Open the PO again.')
  return new Map(rows.map((r) => [r.id, r]))
}

/** The note's lines as sent: new ones added, quantities changed, the ones left out removed (all undecided). */
async function writeLines(tx: Queryable, noteId: string, lines: NoteInput['lines']): Promise<void> {
  await tx.query('DELETE FROM delivery_note_lines WHERE note_id = $1 AND NOT (po_line_id = ANY($2::uuid[]))', [noteId, lines.map((l) => l.poLineId)])
  await tx.query(`INSERT INTO delivery_note_lines (note_id, po_line_id, position, quantity, notes)
    SELECT $1, x.po_line_id, x.position, x.quantity, x.notes FROM json_to_recordset($2::json) AS x(po_line_id uuid, position int, quantity numeric, notes text)
    ON CONFLICT (note_id, po_line_id) DO UPDATE SET position = EXCLUDED.position, quantity = EXCLUDED.quantity, notes = EXCLUDED.notes
    WHERE (delivery_note_lines.position, delivery_note_lines.quantity, delivery_note_lines.notes) IS DISTINCT FROM (EXCLUDED.position, EXCLUDED.quantity, EXCLUDED.notes)`,
  [noteId, JSON.stringify(lines.map((l, i) => ({ po_line_id: l.poLineId, position: i + 1, quantity: l.quantity, notes: l.notes })))])
}

const linesShape = (lines: { itemCode: string; quantity: number; notes: string }[]) => lines.map((l) => `${l.itemCode} × ${l.quantity}${l.notes ? ` (${l.notes})` : ''}`).join('; ')
const coilsShape = (coils: { coilNumber: string; weight: number | null; heatNumber: string }[]) => coils.map((c) => [c.coilNumber, c.weight ?? '', c.heatNumber].join(' ').trim()).join('; ')

/** A PO's lines as sent: each kept line by its id, a new one numbered after the last when it has no number. */
async function writePoLines(tx: Queryable, poId: string, lines: PoInput['lines'], existing: PurchaseOrderLine[]): Promise<void> {
  const byId = new Map(existing.map((l) => [l.id, l]))
  for (const l of lines) if (l.id && !byId.has(l.id)) throw badRequest('One of the lines is not on this PO any more. Open the PO again.')
  const kept = new Set(lines.flatMap((l) => (l.id ? [l.id] : [])))
  const gone = existing.filter((l) => !kept.has(l.id))
  const used = gone.filter((l) => l.deliveredQty > 0)
  if (used.length) throw badRequest(`Line ${used[0].lineNo} (${used[0].itemCode}) has been delivered: it cannot be removed.`)
  // Taken out of the way first: line numbers may be swapped.
  if (gone.length) await tx.query('UPDATE purchase_order_lines SET deleted_at = now() WHERE id = ANY($1::uuid[])', [gone.map((l) => l.id)])
  // A line keeps its number unless given another; a new one without a number follows the last.
  const known = lines.map((l) => l.lineNo ?? (l.id ? byId.get(l.id)!.lineNo : null))
  let next = Math.max(0, ...known.filter((x): x is number => x !== null))
  const resolved = lines.map((l, i) => ({ ...l, lineNo: known[i] ?? ++next }))
  const seen = new Set<number>()
  for (const l of resolved) { if (seen.has(l.lineNo)) throw badRequest(`Line number ${l.lineNo} is used twice.`); seen.add(l.lineNo) }
  // Two steps so that renumbering never meets itself: out of the way, then into place.
  const moving = resolved.filter((l) => l.id && byId.get(l.id)!.lineNo !== l.lineNo)
  if (moving.length) await tx.query('UPDATE purchase_order_lines SET line_no = line_no + 900000 WHERE id = ANY($1::uuid[]) AND line_no < 100000', [moving.map((l) => l.id)])
  for (const l of resolved) {
    if (l.id) {
      await tx.query(`UPDATE purchase_order_lines SET line_no = $2, item_code = $3, description = $4, drawing = $5, dimensions = $6, quantity = $7, unit = $8, notes = $9, updated_at = now()
        WHERE id = $1 AND (line_no, item_code, description, drawing, dimensions, quantity, unit, notes) IS DISTINCT FROM ($2, $3, $4, $5, $6, $7::numeric, $8, $9)`,
      [l.id, l.lineNo, l.itemCode, l.description, l.drawing, l.dimensions, l.quantity, l.unit, l.notes])
    } else {
      await tx.query(`INSERT INTO purchase_order_lines (po_id, line_no, item_code, description, drawing, dimensions, quantity, unit, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [poId, l.lineNo, l.itemCode, l.description, l.drawing, l.dimensions, l.quantity, l.unit, l.notes])
    }
  }
}

const poShape = (p: { poNumber: string; supplier: string; poDate: string; notes: string; lines: { lineNo: number | null; itemCode: string; description: string; drawing: string; dimensions: string; quantity: number; unit: string; notes: string }[] }) => ({
  poNumber: p.poNumber, supplier: p.supplier, poDate: p.poDate, notes: p.notes,
  lines: p.lines.map((l) => [l.lineNo ?? '', l.itemCode, l.description, l.drawing, l.dimensions, l.quantity, l.unit, l.notes].join(' | ')).join('\n'),
})

async function poNumberFree(tx: Queryable, poNumber: string, except?: string): Promise<void> {
  const { rows } = await tx.query<{ id: string }>('SELECT id FROM purchase_orders WHERE lower(btrim(po_number)) = lower(btrim($1)) AND deleted_at IS NULL', [poNumber])
  if (rows.some((r) => r.id !== except)) throw duplicate(`PO ${poNumber} already exists. Open it to change it.`)
}

export function receivingRoutes(ctx: AppContext): Router {
  const r = Router()
  r.use(requirePermission(P.view))

  r.get('/options', async (_req, res) => {
    const { rows } = await ctx.db.query<ReceivingListValue>(`SELECT id, list, value, position FROM receiving_list_values WHERE deleted_at IS NULL ORDER BY list, position, lower(value)`)
    const body: ReceivingOptions = { lists: rows }
    res.json(body)
  })

  // ---- Purchase orders --------------------------------------------------------------------

  r.get('/purchase-orders', async (req, res) => {
    const q = parse(z.object({ q: z.string().trim().max(200).default(''), ...page }), req.query)
    const params: unknown[] = []
    const p = (v: unknown) => `$${params.push(v)}`
    const clauses = ['o.deleted_at IS NULL']
    if (q.q) {
      const like = p(contains(q.q))
      clauses.push(`(concat_ws(' ', o.po_number, o.supplier, o.notes) ILIKE ${like}
        OR EXISTS (SELECT 1 FROM purchase_order_lines l WHERE l.po_id = o.id AND l.deleted_at IS NULL AND concat_ws(' ', l.item_code, l.description, l.drawing) ILIKE ${like}))`)
    }
    const where = clauses.join(' AND ')
    const total = (await ctx.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM purchase_orders o WHERE ${where}`, params)).rows[0].n
    const limit = p(q.limit), offset = p(q.offset)
    const { rows } = await ctx.db.query<PurchaseOrderSummary>(`SELECT o.id, o.po_number AS "poNumber", o.supplier, COALESCE(to_char(o.po_date, 'YYYY-MM-DD'), '') AS "poDate", o.source,
        s.lines, s.quantity, s.delivered AS "deliveredQty", o.updated_at AS "updatedAt"
      FROM purchase_orders o
      CROSS JOIN LATERAL (SELECT count(*)::int AS lines, COALESCE(sum(l.quantity), 0)::float8 AS quantity, COALESCE(sum(l.delivered_qty), 0)::float8 AS delivered
        FROM purchase_order_lines l WHERE l.po_id = o.id AND l.deleted_at IS NULL) s
      WHERE ${where} ORDER BY o.updated_at DESC, o.id DESC LIMIT ${limit} OFFSET ${offset}`, params)
    const body: PurchaseOrderList = { orders: rows, total, hasMore: q.offset + rows.length < total }
    res.json(body)
  })

  /** The warehouse types a PO's number: the PO with its lines and what is still to come of each. */
  r.get('/purchase-orders/lookup', async (req, res) => {
    const { number } = parse(z.object({ number: z.string().trim().min(1).max(60) }), req.query)
    const { rows } = await ctx.db.query<{ id: string }>('SELECT id FROM purchase_orders WHERE lower(btrim(po_number)) = lower(btrim($1)) AND deleted_at IS NULL', [number])
    const po = rows[0] && (await readPo(ctx.db, rows[0].id))
    if (!po) throw notFound(`PO ${number}`)
    res.json(po)
  })

  r.get('/purchase-orders/:id', async (req, res) => {
    const po = await readPo(ctx.db, parse(z.string().uuid(), req.params.id))
    if (!po) throw notFound('Purchase order')
    res.json(po)
  })

  r.post('/purchase-orders', requirePermission(P.purchaseOrders), async (req, res) => {
    const user = requireUser(req)
    const body = parse(poSchema, req.body)
    if (body.lines.some((l) => l.id)) throw badRequest('A new PO has no saved lines yet.')
    const po = await withTransaction(ctx.db, async (tx) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('po:' || lower(btrim($1)), 0))`, [body.poNumber])
      await poNumberFree(tx, body.poNumber)
      const { rows } = await tx.query<{ id: string }>(`INSERT INTO purchase_orders (po_number, supplier, po_date, notes, source, created_by_id, created_by_name, updated_by_id, updated_by_name)
        VALUES ($1, $2, NULLIF($3, '')::date, $4, 'manual', $5, $6, $5, $6) RETURNING id`, [body.poNumber, body.supplier, body.poDate, body.notes, user.id, user.name])
      await writePoLines(tx, rows[0].id, body.lines, [])
      await auditCreate(tx, { userId: user.id, userName: user.name, entity: 'PurchaseOrder', entityId: rows[0].id, item: body.poNumber })
      return (await readPo(tx, rows[0].id))!
    })
    res.status(201).json(po)
  })

  r.put('/purchase-orders/:id', requirePermission(P.purchaseOrders), async (req, res) => {
    const user = requireUser(req)
    const id = parse(z.string().uuid(), req.params.id)
    const body = parse(poSchema.extend({ version: z.number().int().min(0) }), req.body)
    const po = await withTransaction(ctx.db, async (tx) => {
      await tx.query('SELECT 1 FROM purchase_orders WHERE id = $1 FOR UPDATE', [id])
      const old = await readPo(tx, id)
      if (!old) throw notFound('Purchase order')
      if (old.version !== body.version) throw new ConflictError(old)
      if (body.poNumber.toLowerCase() !== old.poNumber.toLowerCase()) {
        await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('po:' || lower(btrim($1)), 0))`, [body.poNumber])
        await poNumberFree(tx, body.poNumber, id)
      }
      const before = poShape(old)
      await writePoLines(tx, id, body.lines, old.lines)
      const fresh = (await readPo(tx, id))!
      const changed = await auditChanges(tx, { userId: user.id, userName: user.name, entity: 'PurchaseOrder', entityId: id, item: body.poNumber }, before, poShape({ ...body, lines: fresh.lines }))
      if (!changed) return old
      await tx.query(`UPDATE purchase_orders SET po_number = $2, supplier = $3, po_date = NULLIF($4, '')::date, notes = $5, updated_at = now(), updated_by_id = $6, updated_by_name = $7,
        version = version + 1 WHERE id = $1`, [id, body.poNumber, body.supplier, body.poDate, body.notes, user.id, user.name])
      return (await readPo(tx, id))!
    })
    res.json(po)
  })

  r.delete('/purchase-orders/:id', requirePermission(P.setup), async (req, res) => {
    const user = requireUser(req)
    const id = parse(z.string().uuid(), req.params.id)
    await withTransaction(ctx.db, async (tx) => {
      const old = (await tx.query<{ poNumber: string }>('SELECT po_number AS "poNumber" FROM purchase_orders WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id])).rows[0]
      if (!old) throw notFound('Purchase order')
      if ((await tx.query('SELECT 1 FROM delivery_notes WHERE po_id = $1 AND deleted_at IS NULL LIMIT 1', [id])).rows.length) {
        throw badRequest(`PO ${old.poNumber} has delivery notes: delete them first.`)
      }
      await tx.query('UPDATE purchase_orders SET deleted_at = now(), deleted_by_id = $2, version = version + 1 WHERE id = $1', [id, user.id])
      await auditDelete(tx, { userId: user.id, userName: user.name, entity: 'PurchaseOrder', entityId: id, item: old.poNumber })
    })
    res.status(204).end()
  })

  /**
   * The purchase orders' sheet, read on the client (shared/receiving
   * parsePurchaseOrderSheet), in chunks. A PO not there yet is made; a line
   * is found by its number, else by its item among the lines without a
   * number given; what changed on it is written; lines the sheet does not
   * name are left as they are.
   */
  r.post('/purchase-orders/import', requirePermission(P.purchaseOrders), async (req, res) => {
    const user = requireUser(req)
    const { rows } = parse(z.object({ rows: z.array(importRowSchema).min(1).max(PURCHASE_ORDER_IMPORT_CHUNK) }), req.body)
    const result = await withTransaction(ctx.db, async (tx) => {
      const out: PurchaseOrderImportResult = { ordersCreated: 0, linesCreated: 0, linesUpdated: 0, linesUnchanged: 0 }
      const groups = new Map<string, typeof rows>()
      for (const row of rows) groups.set(row.poNumber.toLowerCase(), [...(groups.get(row.poNumber.toLowerCase()) ?? []), row])
      for (const group of groups.values()) {
        const head = group[0]
        await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('po:' || lower(btrim($1)), 0))`, [head.poNumber])
        let po = (await tx.query<{ id: string; supplier: string; poDate: string }>(`SELECT id, supplier, COALESCE(to_char(po_date, 'YYYY-MM-DD'), '') AS "poDate"
          FROM purchase_orders WHERE lower(btrim(po_number)) = lower(btrim($1)) AND deleted_at IS NULL FOR UPDATE`, [head.poNumber])).rows[0]
        let changed = false
        if (!po) {
          po = (await tx.query<{ id: string; supplier: string; poDate: string }>(`INSERT INTO purchase_orders (po_number, supplier, po_date, source, created_by_id, created_by_name, updated_by_id, updated_by_name)
            VALUES ($1, $2, NULLIF($3, '')::date, 'import', $4, $5, $4, $5) RETURNING id, supplier, COALESCE(to_char(po_date, 'YYYY-MM-DD'), '') AS "poDate"`,
          [head.poNumber, group.find((g) => g.supplier)?.supplier ?? '', group.find((g) => g.poDate)?.poDate ?? '', user.id, user.name])).rows[0]
          out.ordersCreated++
          await auditCreate(tx, { userId: user.id, userName: user.name, entity: 'PurchaseOrder', entityId: po.id, item: head.poNumber })
        } else {
          const supplier = group.find((g) => g.supplier)?.supplier, poDate = group.find((g) => g.poDate)?.poDate
          const next = { supplier: supplier ?? po.supplier, poDate: poDate ?? po.poDate }
          if (await auditChanges(tx, { userId: user.id, userName: user.name, entity: 'PurchaseOrder', entityId: po.id, item: head.poNumber }, { supplier: po.supplier, poDate: po.poDate }, next)) {
            await tx.query(`UPDATE purchase_orders SET supplier = $2, po_date = NULLIF($3, '')::date WHERE id = $1`, [po.id, next.supplier, next.poDate])
            changed = true
          }
        }
        const existing = (await tx.query<PurchaseOrderLine>(`SELECT ${PO_LINE_SELECT} FROM purchase_order_lines l WHERE l.po_id = $1 AND l.deleted_at IS NULL ORDER BY l.line_no`, [po.id])).rows
        const taken = new Set<string>()
        let next = Math.max(0, ...existing.map((l) => l.lineNo), ...group.map((g) => g.lineNo ?? 0))
        for (const row of group) {
          const match = row.lineNo !== null ? existing.find((l) => l.lineNo === row.lineNo)
            : existing.find((l) => !taken.has(l.id) && l.itemCode.toLowerCase() === row.itemCode.toLowerCase())
          if (match && taken.has(match.id)) throw badRequest(`PO ${row.poNumber}: line ${match.lineNo} is on the sheet twice.`)
          if (match) {
            taken.add(match.id)
            const before = { itemCode: match.itemCode, description: match.description, drawing: match.drawing, dimensions: match.dimensions, quantity: match.quantity, unit: match.unit, notes: match.notes }
            const after = { itemCode: row.itemCode, description: row.description, drawing: row.drawing, dimensions: row.dimensions, quantity: row.quantity, unit: row.unit, notes: row.notes }
            if (await auditChanges(tx, { userId: user.id, userName: user.name, entity: 'PurchaseOrderLine', entityId: match.id, item: `${row.poNumber} line ${match.lineNo}` }, before, after)) {
              await tx.query(`UPDATE purchase_order_lines SET item_code = $2, description = $3, drawing = $4, dimensions = $5, quantity = $6, unit = $7, notes = $8, updated_at = now() WHERE id = $1`,
                [match.id, row.itemCode, row.description, row.drawing, row.dimensions, row.quantity, row.unit, row.notes])
              out.linesUpdated++
              changed = true
            } else out.linesUnchanged++
          } else {
            const lineNo = row.lineNo ?? ++next
            const { rows: inserted } = await tx.query<{ id: string }>(`INSERT INTO purchase_order_lines (po_id, line_no, item_code, description, drawing, dimensions, quantity, unit, notes)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [po.id, lineNo, row.itemCode, row.description, row.drawing, row.dimensions, row.quantity, row.unit, row.notes])
            existing.push({ id: inserted[0].id, lineNo, itemCode: row.itemCode, description: row.description, drawing: row.drawing, dimensions: row.dimensions, quantity: row.quantity, unit: row.unit, notes: row.notes, deliveredQty: 0, acceptedQty: 0, rejectedQty: 0, holdQty: 0, pendingQty: 0 })
            taken.add(inserted[0].id)
            out.linesCreated++
            changed = true
          }
        }
        if (changed) await tx.query(`UPDATE purchase_orders SET updated_at = now(), updated_by_id = $2, updated_by_name = $3, version = version + 1 WHERE id = $1`, [po.id, user.id, user.name])
      }
      return out
    })
    res.json(result)
  })

  // ---- Delivery notes --------------------------------------------------------------------

  r.get('/notes', async (req, res) => {
    const q = parse(listQuery, req.query)
    if (q.from && q.to && q.from > q.to) throw badRequest('The range ends before it starts.')
    const params: unknown[] = []
    const p = (v: unknown) => `$${params.push(v)}`
    const clauses = ['d.deleted_at IS NULL']
    if (q.status === 'open') clauses.push(`d.status <> 'closed'`)
    else if (q.status) clauses.push(`d.status = ${p(q.status)}`)
    if (q.factory) clauses.push(`lower(d.factory) = lower(${p(q.factory)})`)
    if (q.from) clauses.push(`d.delivered_on >= ${p(q.from)}::date`)
    if (q.to) clauses.push(`d.delivered_on <= ${p(q.to)}::date`)
    if (q.q) {
      const like = p(contains(q.q))
      clauses.push(`(concat_ws(' ', d.reference, p.po_number, p.supplier, d.supplier_dn_no, d.factory, d.notes, d.created_by_name) ILIKE ${like}
        OR EXISTS (SELECT 1 FROM delivery_note_lines l JOIN purchase_order_lines pl ON pl.id = l.po_line_id WHERE l.note_id = d.id AND concat_ws(' ', pl.item_code, pl.description, pl.drawing) ILIKE ${like})
        OR EXISTS (SELECT 1 FROM delivery_note_coils c WHERE c.note_id = d.id AND c.coil_number ILIKE ${like}))`)
    }
    const where = clauses.join(' AND ')
    const total = (await ctx.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM delivery_notes d JOIN purchase_orders p ON p.id = d.po_id WHERE ${where}`, params)).rows[0].n
    const limit = p(q.limit), offset = p(q.offset)
    const { rows } = await ctx.db.query<DeliveryNoteSummary>(`SELECT ${NOTE_SUMMARY} FROM delivery_notes d JOIN purchase_orders p ON p.id = d.po_id
      WHERE ${where} ORDER BY d.created_at DESC, d.id DESC LIMIT ${limit} OFFSET ${offset}`, params)
    const body: DeliveryNoteList = { notes: rows, total, hasMore: q.offset + rows.length < total }
    res.json(body)
  })

  r.get('/notes/:id', async (req, res) => {
    const note = await readNote(ctx.db, parse(z.string().uuid(), req.params.id))
    if (!note) throw notFound('Delivery note')
    res.json(note)
  })

  r.post('/notes', requirePermission(P.deliver), async (req, res) => {
    const user = requireUser(req)
    const body = parse(noteSchema.extend({ submissionId: z.string().uuid() }), req.body)
    const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex')
    const result = await withTransaction(ctx.db, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [body.submissionId])
      const prior = (await tx.query<{ id: string; hash: string; by: string; deleted: boolean }>(`SELECT id, request_hash AS hash, created_by_id AS by, deleted_at IS NOT NULL AS deleted
        FROM delivery_notes WHERE submission_id = $1`, [body.submissionId])).rows[0]
      if (prior) {
        if (prior.by !== user.id || prior.hash !== hash) throw new HttpError(409, 'conflict', 'This submission was already saved with different values.')
        if (prior.deleted) throw notFound('Delivery note')
        return { note: (await readNote(tx, prior.id))!, created: false }
      }
      const po = (await tx.query<{ poNumber: string; supplier: string }>(`SELECT po_number AS "poNumber", supplier FROM purchase_orders WHERE id = $1 AND deleted_at IS NULL FOR SHARE`, [body.poId])).rows[0]
      if (!po) throw notFound('Purchase order')
      const poLines = await poLinesOf(tx, body.poId, body.lines.map((l) => l.poLineId))
      await checkImages(tx, user, body.imageIds, [])
      // One number at a time: two notes never take the same one.
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('delivery-note-reference', 0))`)
      const reference = await nextReference(tx, Number(body.deliveredOn.slice(0, 4)))
      const { rows } = await tx.query<{ id: string }>(`INSERT INTO delivery_notes (reference, po_id, factory, delivered_on, supplier_dn_no, notes, submission_id, request_hash,
          created_by_id, created_by_name, updated_by_id, updated_by_name)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$9,$10) RETURNING id`,
      [reference, body.poId, body.factory, body.deliveredOn, body.supplierDnNo, body.notes, body.submissionId, hash, user.id, user.name])
      const id = rows[0].id
      await writeLines(tx, id, body.lines)
      await writeCoils(tx, id, body.coils)
      await attachImages(tx, id, null, body.imageIds)
      const items = body.lines.map((l) => ({ itemCode: poLines.get(l.poLineId)!.itemCode, quantity: l.quantity, notes: l.notes }))
      await event(tx, id, user, { kind: 'created', text: `${linesShape(items)}${body.coils.length ? ` · ${body.coils.length} coils` : ''}` })
      await auditCreate(tx, { userId: user.id, userName: user.name, entity: 'DeliveryNote', entityId: id, item: `${reference} PO ${po.poNumber}` })
      await createNotifications(tx, await deciders(tx, user.id), {
        kind: 'receiving', severity: 'info',
        title: `Delivery ${reference} to receive: PO ${po.poNumber}${po.supplier ? ` · ${po.supplier}` : ''}`,
        body: `${body.factory} · ${body.lines.length} ${body.lines.length === 1 ? 'item' : 'items'}${body.coils.length ? ` · ${body.coils.length} coils` : ''}, sent by ${user.name}.`,
        link: `/receiving/notes/${id}`,
      })
      return { note: (await readNote(tx, id))!, created: true }
    })
    res.status(result.created ? 201 : 200).json(result.note)
  })

  /** The warehouse corrects what it sent, while quality has decided none of it. */
  r.put('/notes/:id', requirePermission(P.deliver), async (req, res) => {
    const user = requireUser(req)
    const id = parse(z.string().uuid(), req.params.id)
    const body = parse(noteSchema.extend({ version: z.number().int().min(0) }), req.body)
    const note = await withTransaction(ctx.db, async (tx) => {
      await tx.query('SELECT 1 FROM delivery_notes WHERE id = $1 FOR UPDATE', [id])
      const old = await readNote(tx, id)
      if (!old) throw notFound('Delivery note')
      if (old.version !== body.version) throw new ConflictError(old)
      if (old.poId !== body.poId) throw badRequest('A delivery note stays on its PO: delete it and send a new one.')
      if (old.status === 'closed' || old.lineItems.some((l) => l.status !== 'pending')) throw badRequest('Quality has started deciding this delivery: it can no longer be changed here. Ask quality receiving.')
      const poLines = await poLinesOf(tx, old.poId, body.lines.map((l) => l.poLineId))
      await checkImages(tx, user, body.imageIds, old.imageIds)
      const items = body.lines.map((l) => ({ itemCode: poLines.get(l.poLineId)!.itemCode, quantity: l.quantity, notes: l.notes }))
      const before = { factory: old.factory, deliveredOn: old.deliveredOn, supplierDnNo: old.supplierDnNo, notes: old.notes, lines: linesShape(old.lineItems), coils: coilsShape(old.coilList), imageIds: old.imageIds }
      const after = { factory: body.factory, deliveredOn: body.deliveredOn, supplierDnNo: body.supplierDnNo, notes: body.notes, lines: linesShape(items), coils: coilsShape(body.coils), imageIds: body.imageIds }
      const changed = await auditChanges(tx, { userId: user.id, userName: user.name, entity: 'DeliveryNote', entityId: id, item: `${old.reference} PO ${old.poNumber}` }, before, after)
      if (!changed) return old
      await tx.query(`UPDATE delivery_notes SET factory = $2, delivered_on = $3, supplier_dn_no = $4, notes = $5, updated_at = now(), updated_by_id = $6, updated_by_name = $7,
        version = version + 1 WHERE id = $1`, [id, body.factory, body.deliveredOn, body.supplierDnNo, body.notes, user.id, user.name])
      await writeLines(tx, id, body.lines)
      if (before.coils !== after.coils) await writeCoils(tx, id, body.coils)
      await attachImages(tx, id, null, body.imageIds)
      await event(tx, id, user, { kind: 'edited', text: linesShape(items) })
      return (await readNote(tx, id))!
    })
    res.json(note)
  })

  /** The coils on the supplier's paper, and the paper's photos: the warehouse or quality, until the note is closed. */
  r.put('/notes/:id/coils', requireAnyPermission(P.deliver, P.decide), async (req, res) => {
    const user = requireUser(req)
    const id = parse(z.string().uuid(), req.params.id)
    const body = parse(z.object({ coils: coilsSchema, imageIds: ids(20), version: z.number().int().min(0) }), req.body)
    const note = await withTransaction(ctx.db, async (tx) => {
      await tx.query('SELECT 1 FROM delivery_notes WHERE id = $1 FOR UPDATE', [id])
      const old = await readNote(tx, id)
      if (!old) throw notFound('Delivery note')
      if (old.version !== body.version) throw new ConflictError(old)
      if (old.status === 'closed') throw badRequest('This delivery note is closed.')
      await checkImages(tx, user, body.imageIds, old.imageIds)
      const before = { coils: coilsShape(old.coilList), imageIds: old.imageIds }
      const after = { coils: coilsShape(body.coils), imageIds: body.imageIds }
      const changed = await auditChanges(tx, { userId: user.id, userName: user.name, entity: 'DeliveryNote', entityId: id, item: `${old.reference} PO ${old.poNumber}` }, before, after)
      if (!changed) return old
      if (before.coils !== after.coils) await writeCoils(tx, id, body.coils)
      await attachImages(tx, id, null, body.imageIds)
      await tx.query('UPDATE delivery_notes SET updated_at = now(), updated_by_id = $2, updated_by_name = $3, version = version + 1 WHERE id = $1', [id, user.id, user.name])
      if (before.coils !== after.coils) await event(tx, id, user, { kind: 'coils', text: `${body.coils.length} coils on the supplier’s paper` })
      return (await readNote(tx, id))!
    })
    res.json(note)
  })

  r.post('/notes/:id/lines/:lineId/decision', requirePermission(P.decide), async (req, res) => {
    const user = requireUser(req)
    const id = parse(z.string().uuid(), req.params.id)
    const lineId = parse(z.string().uuid(), req.params.lineId)
    const body = parse(decisionSchema, req.body)
    const note = await withTransaction(ctx.db, async (tx) => {
      const head = (await tx.query<{ status: DeliveryNoteStatus; createdById: string; reference: string; poNumber: string }>(`SELECT d.status, d.created_by_id AS "createdById", d.reference,
          p.po_number AS "poNumber" FROM delivery_notes d JOIN purchase_orders p ON p.id = d.po_id WHERE d.id = $1 AND d.deleted_at IS NULL FOR UPDATE OF d`, [id])).rows[0]
      if (!head) throw notFound('Delivery note')
      if (head.status === 'closed') throw badRequest('This delivery note is closed. Whoever sets receiving up can reopen it.')
      const old = (await readNote(tx, id))!
      const line = old.lineItems.find((l) => l.id === lineId)
      if (!line) throw notFound('Delivery line')
      if (line.version !== body.version) throw new ConflictError(old)
      const q = decisionQuantities(body.decision, line.quantity, body.acceptedQty)
      if ('error' in q) throw badRequest(q.error)
      if (body.decision === 'hold' && !body.holdReason) throw badRequest('Choose why it is on Hold.')
      if ((body.decision === 'rejected' || body.decision === 'partial') && !body.rejectReason) throw badRequest('Write why it is rejected.')
      await checkImages(tx, user, body.imageIds, line.imageIds)
      const next = {
        status: body.decision, acceptedQty: q.acceptedQty, rejectedQty: q.rejectedQty,
        holdReason: body.decision === 'hold' ? body.holdReason : '',
        rejectReason: body.decision === 'rejected' || body.decision === 'partial' ? body.rejectReason : '',
        decisionNotes: body.notes, imageIds: body.imageIds,
      }
      const before = { status: line.status, acceptedQty: line.acceptedQty, rejectedQty: line.rejectedQty, holdReason: line.holdReason, rejectReason: line.rejectReason, decisionNotes: line.decisionNotes, imageIds: line.imageIds }
      const changed = await auditChanges(tx, { userId: user.id, userName: user.name, entity: 'DeliveryNoteLine', entityId: lineId, item: `${old.reference} ${line.itemCode}` }, before, next)
      if (!changed) return old
      await tx.query(`UPDATE delivery_note_lines SET status = $2, accepted_qty = $3, rejected_qty = $4, hold_reason = $5, reject_reason = $6, decision_notes = $7,
          decided_at = now(), decided_by_id = $8, decided_by_name = $9, version = version + 1 WHERE id = $1`,
      [lineId, next.status, next.acceptedQty, next.rejectedQty, next.holdReason, next.rejectReason, next.decisionNotes, user.id, user.name])
      await attachImages(tx, id, lineId, body.imageIds)
      await event(tx, id, user, { kind: 'decided', lineId, itemCode: line.itemCode, status: next.status,
        text: decisionText({ ...next, quantity: line.quantity, notes: next.decisionNotes }, line.unit) })
      const fresh = (await readNote(tx, id))!
      // The warehouse hears once the note is decided whole, or comes to rest on Hold.
      if (fresh.status !== head.status && (fresh.status === 'decided' || fresh.status === 'hold')) {
        const counts = [[fresh.acceptedLines, 'accepted'], [fresh.partialLines, 'partly accepted'], [fresh.rejectedLines, 'rejected'], [fresh.holdLines, 'on hold']] as const
        await createNotifications(tx, [head.createdById].filter((u) => u !== user.id), {
          kind: 'receiving', severity: fresh.rejectedLines || fresh.partialLines || fresh.holdLines ? 'warning' : 'info',
          title: fresh.status === 'decided' ? `Delivery ${fresh.reference} decided: PO ${fresh.poNumber}` : `Delivery ${fresh.reference} is on hold: PO ${fresh.poNumber}`,
          body: `${counts.filter(([c]) => c > 0).map(([c, w]) => `${c} ${w}`).join(', ')}${fresh.status === 'decided' ? '. Print it and close it.' : '.'}`,
          link: `/receiving/notes/${id}`,
        })
      }
      return fresh
    })
    res.json(note)
  })

  /** The warehouse closes a note quality decided whole: what follows is the warehouse's own system. */
  r.post('/notes/:id/close', requirePermission(P.deliver), async (req, res) => {
    const user = requireUser(req)
    const id = parse(z.string().uuid(), req.params.id)
    const { version } = parse(z.object({ version: z.number().int().min(0) }), req.body)
    const note = await withTransaction(ctx.db, async (tx) => {
      await tx.query('SELECT 1 FROM delivery_notes WHERE id = $1 FOR UPDATE', [id])
      const old = await readNote(tx, id)
      if (!old) throw notFound('Delivery note')
      if (old.version !== version) throw new ConflictError(old)
      if (old.status !== 'decided') throw badRequest(old.status === 'closed' ? 'This delivery note is already closed.' : 'Quality has not decided every line yet.')
      await tx.query(`UPDATE delivery_notes SET closed_at = now(), closed_by_id = $2, closed_by_name = $3, updated_at = now(), updated_by_id = $2, updated_by_name = $3,
        version = version + 1 WHERE id = $1`, [id, user.id, user.name])
      await auditChanges(tx, { userId: user.id, userName: user.name, entity: 'DeliveryNote', entityId: id, item: `${old.reference} PO ${old.poNumber}` }, { status: old.status }, { status: 'closed' })
      await event(tx, id, user, { kind: 'closed' })
      return (await readNote(tx, id))!
    })
    res.json(note)
  })

  r.post('/notes/:id/reopen', requirePermission(P.setup), async (req, res) => {
    const user = requireUser(req)
    const id = parse(z.string().uuid(), req.params.id)
    const { version, reason } = parse(z.object({ version: z.number().int().min(0), reason: z.string().trim().min(1, 'Write why it is reopened.').max(1000) }), req.body)
    const note = await withTransaction(ctx.db, async (tx) => {
      await tx.query('SELECT 1 FROM delivery_notes WHERE id = $1 FOR UPDATE', [id])
      const old = await readNote(tx, id)
      if (!old) throw notFound('Delivery note')
      if (old.version !== version) throw new ConflictError(old)
      if (old.status !== 'closed') throw badRequest('This delivery note is not closed.')
      await tx.query(`UPDATE delivery_notes SET closed_at = NULL, closed_by_id = NULL, closed_by_name = '', updated_at = now(), updated_by_id = $2, updated_by_name = $3,
        version = version + 1 WHERE id = $1`, [id, user.id, user.name])
      await auditChanges(tx, { userId: user.id, userName: user.name, entity: 'DeliveryNote', entityId: id, item: `${old.reference} PO ${old.poNumber}` }, { status: 'closed' }, { status: 'reopened' })
      await event(tx, id, user, { kind: 'reopened', text: reason })
      return (await readNote(tx, id))!
    })
    res.json(note)
  })

  /** Whoever sets receiving up deletes any note; the warehouse its own, while undecided. */
  r.delete('/notes/:id', requireAnyPermission(P.deliver, P.setup), async (req, res) => {
    const user = requireUser(req)
    const id = parse(z.string().uuid(), req.params.id)
    await withTransaction(ctx.db, async (tx) => {
      const old = (await tx.query<{ reference: string; createdById: string; lines: number; pending: number; closed: boolean }>(`SELECT reference, created_by_id AS "createdById", lines,
          pending_lines AS pending, closed_at IS NOT NULL AS closed FROM delivery_notes WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [id])).rows[0]
      if (!old) throw notFound('Delivery note')
      if (!userCan(user, P.setup) && (old.createdById !== user.id || old.closed || old.pending !== old.lines)) {
        throw forbidden('Only a delivery note you sent, before quality decides any of it, can be deleted here.')
      }
      await tx.query('UPDATE delivery_notes SET deleted_at = now(), deleted_by_id = $2, version = version + 1 WHERE id = $1', [id, user.id])
      await auditDelete(tx, { userId: user.id, userName: user.name, entity: 'DeliveryNote', entityId: id, item: old.reference })
    })
    res.status(204).end()
  })

  // ---- The registers ------------------------------------------------------------------------

  /** Every item received with its decision: Accepted, Hold, Rejected… as one list filtered. */
  r.get('/items', async (req, res) => {
    const q = parse(itemsQuery, req.query)
    if (q.from && q.to && q.from > q.to) throw badRequest('The range ends before it starts.')
    const params: unknown[] = []
    const p = (v: unknown) => `$${params.push(v)}`
    const clauses = ['d.deleted_at IS NULL']
    if (q.status) clauses.push(`l.status = ${p(q.status)}`)
    if (q.factory) clauses.push(`lower(d.factory) = lower(${p(q.factory)})`)
    if (q.from) clauses.push(`d.delivered_on >= ${p(q.from)}::date`)
    if (q.to) clauses.push(`d.delivered_on <= ${p(q.to)}::date`)
    if (q.q) clauses.push(`concat_ws(' ', d.reference, p.po_number, p.supplier, pl.item_code, pl.description, pl.drawing, pl.dimensions, l.hold_reason, l.reject_reason, l.decision_notes, l.decided_by_name) ILIKE ${p(contains(q.q))}`)
    const from = `FROM delivery_note_lines l JOIN delivery_notes d ON d.id = l.note_id JOIN purchase_order_lines pl ON pl.id = l.po_line_id JOIN purchase_orders p ON p.id = d.po_id`
    const where = clauses.join(' AND ')
    const total = (await ctx.db.query<{ n: number }>(`SELECT count(*)::int AS n ${from} WHERE ${where}`, params)).rows[0].n
    const limit = p(q.limit), offset = p(q.offset)
    const { rows } = await ctx.db.query<ReceivedItem>(`SELECT l.id, d.id AS "noteId", d.reference, p.po_number AS "poNumber", p.supplier, d.factory, to_char(d.delivered_on, 'YYYY-MM-DD') AS "deliveredOn",
        pl.line_no AS "lineNo", pl.item_code AS "itemCode", pl.description, pl.drawing, pl.dimensions, pl.unit, ${n('l.quantity')} AS quantity, l.status,
        ${n('l.accepted_qty')} AS "acceptedQty", ${n('l.rejected_qty')} AS "rejectedQty", l.hold_reason AS "holdReason", l.reject_reason AS "rejectReason",
        l.decision_notes AS "decisionNotes", l.decided_at AS "decidedAt", l.decided_by_name AS "decidedByName", d.status AS "noteStatus"
      ${from} WHERE ${where} ORDER BY d.delivered_on DESC, d.created_at DESC, l.position LIMIT ${limit} OFFSET ${offset}`, params)
    const body: ReceivedItemList = { items: rows, total, hasMore: q.offset + rows.length < total }
    res.json(body)
  })

  /** The coils delivered, matched with the MTC register: the ones still without a certificate are the list to chase. */
  r.get('/coils', async (req, res) => {
    const q = parse(z.object({ q: z.string().trim().max(200).default(''), mtc: z.enum(['missing', 'matched']).optional(), ...page }), req.query)
    const params: unknown[] = []
    const p = (v: unknown) => `$${params.push(v)}`
    const clauses = ['d.deleted_at IS NULL']
    if (q.q) clauses.push(`concat_ws(' ', c.coil_number, c.heat_number, d.reference, p.po_number, p.supplier, d.factory) ILIKE ${p(contains(q.q))}`)
    const from = `FROM delivery_note_coils c JOIN delivery_notes d ON d.id = c.note_id JOIN purchase_orders p ON p.id = d.po_id
      LEFT JOIN coils r ON lower(r.coil_number) = lower(btrim(c.coil_number)) AND r.deleted_at IS NULL`
    const base = clauses.join(' AND ')
    const counts = (await ctx.db.query<{ total: number; missing: number }>(`SELECT count(*)::int AS total, count(*) FILTER (WHERE r.id IS NULL)::int AS missing ${from} WHERE ${base}`, params)).rows[0]
    const where = q.mtc === 'missing' ? `${base} AND r.id IS NULL` : q.mtc === 'matched' ? `${base} AND r.id IS NOT NULL` : base
    const total = q.mtc === 'missing' ? counts.missing : q.mtc === 'matched' ? counts.total - counts.missing : counts.total
    const limit = p(q.limit), offset = p(q.offset)
    const { rows } = await ctx.db.query<DeliveredCoilRow>(`SELECT c.coil_number AS "coilNumber", ${n('c.weight')} AS weight, c.heat_number AS "heatNumber", r.id IS NOT NULL AS "hasMtc",
        COALESCE(r.grade, '') AS grade, ${n('r.thickness')} AS thickness, d.id AS "noteId", d.reference, p.po_number AS "poNumber", p.supplier, d.factory,
        to_char(d.delivered_on, 'YYYY-MM-DD') AS "deliveredOn"
      ${from} WHERE ${where} ORDER BY d.delivered_on DESC, d.created_at DESC, c.position LIMIT ${limit} OFFSET ${offset}`, params)
    const body: DeliveredCoilList = { coils: rows, total, missing: counts.missing, hasMore: q.offset + rows.length < total }
    res.json(body)
  })

  /** Coil search: the deliveries the coils on screen came on. */
  r.get('/by-coils', async (req, res) => {
    const numbers = parse(z.string().max(5000).default(''), req.query.numbers).split(',').map((x) => x.trim().toLowerCase()).filter(Boolean).slice(0, 100)
    if (!numbers.length) return res.json([])
    const { rows } = await ctx.db.query<CoilDelivery>(`SELECT lower(btrim(c.coil_number)) AS "coilNumber", d.id AS "noteId", d.reference, to_char(d.delivered_on, 'YYYY-MM-DD') AS "deliveredOn",
        p.po_number AS "poNumber", p.supplier, d.factory
      FROM delivery_note_coils c JOIN delivery_notes d ON d.id = c.note_id AND d.deleted_at IS NULL JOIN purchase_orders p ON p.id = d.po_id
      WHERE lower(btrim(c.coil_number)) = ANY($1::text[]) ORDER BY d.delivered_on DESC, d.created_at DESC LIMIT 500`, [numbers])
    res.json(rows)
  })

  // ---- Setup -------------------------------------------------------------------------------

  r.post('/lists', requirePermission(P.setup), async (req, res) => {
    const user = requireUser(req)
    const v = parse(z.object({ list: z.enum(RECEIVING_LISTS), value: z.string().trim().min(1).max(120) }), req.body)
    const row = await withTransaction(ctx.db, async (tx) => {
      const inserted = await tx.query<ReceivingListValue>(`INSERT INTO receiving_list_values (list, value, position)
        VALUES ($1, $2, COALESCE((SELECT max(position) + 1 FROM receiving_list_values WHERE list = $1 AND deleted_at IS NULL), 1))
        ON CONFLICT DO NOTHING RETURNING id, list, value, position`, [v.list, v.value])
      if (!inserted.rows[0]) throw duplicate(`${v.value} is already on the list.`)
      await auditCreate(tx, { userId: user.id, userName: user.name, entity: 'ReceivingList', entityId: inserted.rows[0].id, item: `${v.list}: ${v.value}` })
      return inserted.rows[0]
    })
    res.status(201).json(row)
  })

  r.delete('/lists/:id', requirePermission(P.setup), async (req, res) => {
    const user = requireUser(req)
    const id = parse(z.string().uuid(), req.params.id)
    await withTransaction(ctx.db, async (tx) => {
      const old = (await tx.query<{ list: string; value: string }>('UPDATE receiving_list_values SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING list, value', [id])).rows[0]
      if (!old) throw notFound('List value')
      await auditDelete(tx, { userId: user.id, userName: user.name, entity: 'ReceivingList', entityId: id, item: `${old.list}: ${old.value}` })
    })
    res.status(204).end()
  })

  return r
}
