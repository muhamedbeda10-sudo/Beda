// ============================================================================
// Inspection sessions, and the atomic sample save that lives under them (§9).
//
// A sample carries its dimensions, defects, coils, an optional paint record,
// an optional PT record and image references. They are written as ONE unit
// inside one transaction: either the complete inspection exists, or nothing
// does. There is no code path that reports partial success, because there is
// no code path that produces it.
// ============================================================================

import { Router } from 'express'
import { z } from 'zod'
import {
  DISPOSITIONS,
  PT_CONSUMABLE_KINDS,
  type GradeMapping,
  type InspectionSession,
  type ItemDimensionOrder,
  type ItemReferenceImage,
  type Machine,
  type PTConsumableProduct,
  type Process,
  type ProductionOrder,
  type WorkCenterDefect,
} from '@qc/shared/types'
import {
  deriveShift,
  dimensionStatus,
  processForMachine,
  ptOverallVerdict,
  can,
  validateSample,
  stockProductionOf,
  isStockOrder,
  stockLineKey,
  normaliseMachineCode,
  STOCK_ORDER_NUMBER,
} from '@qc/shared/rules'
import { instructionsInForce } from './workInstructions.routes'
import type {
  HistoryResponse,
  OpenSessionsResponse,
  PreviousDimension,
  PreviousSetup,
  ReRecordSampleResponse,
  SaveCoilInput,
  SampleSummary,
  SaveSampleResponse,
  SessionNotesResponse,
  SessionWithOrder,
  WizardContext,
  StartSessionRequest,
  StartWithSampleResponse,
} from '@qc/shared/api'
import type { AuditContext } from '@qc/shared/audit'
import type { AppContext } from '../context'
import { withTransaction, PG, pgCode, type Queryable } from '../db/pool'
import { ConflictError, badRequest, forbidden, notFound } from '../lib/errors'
import { parse } from '../lib/validate'
import { requireCapability, requireUser, type AuthUser } from '../auth/middleware'
import { auditChanges, auditCreate, auditDelete, writeAudit } from '../audit/service'
import { auditEvent } from '@qc/shared/audit'
import { dropNulls } from '../lib/rows'
import { assertImagesUsable, linkImages } from './images.links'
import { loadOrderNotes, loadSessionNotes, noteIsEmpty, writeSessionNote } from './notes'
import { ORDER_SELECT, fetchOrdersByIds } from './orders.routes'
import {
  ORDER_SUMMARY_SELECT,
  SAMPLE_SUMMARY_SELECT,
  SESSION_SELECT,
  toSession,
  toSessionWithOrder,
  type OrderSummaryRow,
  type SessionRow,
  SAMPLE_SELECT,
  toSample,
  type SampleRow,
} from './sessions.sql'

const uuid = z.string().uuid()

/** A coil picked from the catalogue must still be in it. A typed coil has no id
 *  and is not checked — the register may simply not have received it yet. */
async function assertCoilsUsable(q: Queryable, coilIds: string[]): Promise<void> {
  const wanted = Array.from(new Set(coilIds))
  if (wanted.length === 0) return
  const { rows } = await q.query<{ id: string }>(`SELECT id FROM coils WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`, [wanted])
  if (rows.length !== wanted.length) throw badRequest('One of the coils is no longer in the coil register. Remove it and pick it again.')
}

/**
 * A machine code as the floor writes it, compared the way `normaliseMachineCode`
 * does: Arabic digits to Western, spaces dropped, lower case, and a purely
 * numeric code without its leading zeros — so "STAM 24", "stam24" and "024"
 * all find the same previous sample.
 */
const NORMALISED_CODE = (col: string) =>
  `(CASE WHEN regexp_replace(lower(translate(${col}, '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789')), '\\s+', '', 'g') ~ '^[0-9]+$'
         THEN COALESCE(NULLIF(ltrim(regexp_replace(lower(translate(${col}, '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789')), '\\s+', '', 'g'), '0'), ''), '0')
         ELSE regexp_replace(lower(translate(${col}, '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789')), '\\s+', '', 'g') END)`

const startSchema = z.union([
  z.object({ orderId: uuid, startQty: z.coerce.number().min(0) }),
  z.object({ workCenterCode: z.string().trim().min(1).max(40), producedQty: z.coerce.number().min(0) }),
])
const closeSchema = z.object({ finalQty: z.coerce.number().min(0), version: z.coerce.number().int().min(0) })
const reopenSchema = z.object({ version: z.coerce.number().int().min(0) })

const optText = (max: number) => z.string().trim().max(max).optional().transform((v) => (v ? v : undefined))
const nullableNum = z.union([z.number().finite(), z.null()])

const saveSampleSchema = z.object({
  submissionId: uuid,
  drawing: z.string().trim().max(200).default(''),
  drawingAlt: optText(200),
  issue: optText(100),
  sampleQty: z.number().positive('Sample quantity must be greater than zero.'),
  dimensions: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(200),
        sequence: z.number().int().min(1),
        nominal: nullableNum,
        tolPlus: nullableNum,
        tolMinus: nullableNum,
        actual: nullableNum,
        unit: z.string().trim().max(20).default('mm'),
        source: z.enum(['item-order', 'item-master', 'carry-forward', 'manual']),
      }),
    )
    .max(200),
  defects: z
    .array(
      z.object({
        defectName: z.string().trim().min(1).max(200),
        qty: z.number().positive(),
        disposition: z.enum(DISPOSITIONS as unknown as [string, ...string[]]),
        notes: optText(2000),
        imageIds: z.array(uuid).max(30).default([]),
      }),
    )
    .max(100),
  coils: z
    .array(
      z.object({
        coilId: uuid.optional(),
        coilNumber: z.string().trim().min(1, 'Every coil needs a coil ID.').max(120),
        grade: optText(60),
        smType: optText(60),
        supplier: optText(200),
        thickness: z.number().finite().optional(),
        width: z.number().finite().optional(),
        yield: z.number().finite().optional(),
        notes: optText(1000),
      }),
    )
    .max(50),
  paint: z.object({ notes: optText(4000), imageIds: z.array(uuid).max(50).default([]) }).optional(),
  pt: z
    .object({
      testFrequencyPct: z.number().finite(),
      consumableLots: z.object({ Cleaner: z.string().trim(), Penetrant: z.string().trim(), Developer: z.string().trim() }),
      weldingWireBatch: optText(100),
      testedLengths: z
        .array(z.object({ lengthMm: z.number().finite(), verdict: z.enum(['Accept', 'Reject / Repair']) }))
        .max(50)
        .default([]),
      notes: optText(4000),
      imageIds: z.array(uuid).max(50).default([]),
    })
    .optional(),
  note: z.object({ text: optText(4000), imageIds: z.array(uuid).max(30).default([]) }).optional(),
  gradeAcknowledgement: z
    .object({
      coilNumbers: z.array(z.string().trim().min(1)).min(1),
      expectedGrade: z.string().trim(),
      foundGrades: z.array(z.string().trim()),
      at: z.string().datetime({ offset: true }),
    })
    .optional(),
})

/**
 * The setup of a session's latest sample: drawing, issue, coils and an
 * acknowledged grade mismatch. Setup is entered once per session (§5.1), so
 * the next sample starts from it. Null until the session has a sample.
 */
async function loadPreviousSetup(q: Queryable, sessionId: string): Promise<PreviousSetup | null> {
  const last = (
    await q.query<{ id: string; drawing: string; drawingAlt: string | null; issue: string | null; coilNumbers: string[] | null; expectedGrade: string | null; foundGrades: string[] | null }>(
      `SELECT id, drawing, drawing_alt AS "drawingAlt", issue, grade_ack_coil_numbers AS "coilNumbers",
              grade_ack_expected_grade AS "expectedGrade", grade_ack_found_grades AS "foundGrades"
         FROM inspection_samples WHERE session_id = $1 AND deleted_at IS NULL
        ORDER BY created_at DESC, index DESC LIMIT 1`,
      [sessionId],
    )
  ).rows[0]
  if (!last) return null
  const coils = await q.query<SaveCoilInput>(
    `SELECT coil_id AS "coilId", coil_number AS "coilNumber", grade, sm_type AS "smType", supplier, thickness, width, yield, notes
       FROM sample_coils WHERE sample_id = $1 AND deleted_at IS NULL ORDER BY id`,
    [last.id],
  )
  return {
    drawing: last.drawing,
    drawingAlt: last.drawingAlt,
    issue: last.issue,
    coils: coils.rows.map(dropNulls),
    gradeAcknowledgement: last.coilNumbers ? { coilNumbers: last.coilNumbers, expectedGrade: last.expectedGrade ?? '', foundGrades: last.foundGrades ?? [] } : null,
  }
}

/** The register's row for a machine code, or null when the code is not registered. */
async function loadMachine(q: Queryable, code: string): Promise<Machine | null> {
  const { rows } = await q.query<Machine>(
    `SELECT id, code, name, line, display_name AS "displayName", machine_number AS "machineNumber", factory, process,
            uses_item_dimensions AS "usesItemDimensions"
       FROM machines WHERE lower(code) = lower($1) AND deleted_at IS NULL LIMIT 1`,
    [code],
  )
  return rows[0] ? dropNulls(rows[0]) : null
}

/**
 * The one fixed STOCK line of a make-to-stock machine, created on first use
 * and brought back after a catalogue clear retired it. Refused on a machine
 * that works to order.
 */
async function ensureStockLine(tx: Queryable, workCenterCode: string): Promise<string> {
  const production = stockProductionOf(workCenterCode)
  if (!production) throw badRequest('This machine works to order: pick the order and the item to inspect.')
  const machine = await loadMachine(tx, workCenterCode)
  if (!machine) throw badRequest('That machine is not in the register.')
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO production_orders (line_key, order_number, item, item_code, work_center_code, machine_id, erp_status)
     VALUES ($1, $2, $3, $4, $5, $6, 'Stock')
     ON CONFLICT (lower(line_key) text_pattern_ops) DO UPDATE
       SET item = EXCLUDED.item, item_code = EXCLUDED.item_code, work_center_code = EXCLUDED.work_center_code,
           machine_id = EXCLUDED.machine_id, deleted_at = NULL, deleted_by_id = NULL
     RETURNING id`,
    [stockLineKey(machine.code), STOCK_ORDER_NUMBER, production.item, production.itemCode, machine.code, machine.id],
  )
  return rows[0].id
}

async function loadSessionWithOrder(q: Queryable, id: string, lock = false): Promise<SessionWithOrder | null> {
  const { rows } = await q.query<SessionRow & OrderSummaryRow>(
    `SELECT ${SESSION_SELECT}, ${ORDER_SUMMARY_SELECT}
       FROM inspection_sessions s LEFT JOIN production_orders o ON o.id = s.order_id
      WHERE s.id = $1 AND s.deleted_at IS NULL${lock ? ' FOR UPDATE OF s' : ''}`,
    [id],
  )
  return rows[0] ? toSessionWithOrder(rows[0]) : null
}

function auditCtxFor(user: { id: string; name: string }, s: SessionWithOrder, entity: string, entityId: string, sampleId?: string): AuditContext {
  return {
    userId: user.id,
    userName: user.name,
    entity,
    entityId,
    orderNumber: s.order?.orderNumber,
    item: s.order?.item,
    workCenterCode: s.workCenterCode,
    sessionId: s.id,
    sampleId,
  }
}

export function sessionsRoutes(ctx: AppContext): Router {
  const r = Router()
  const { db } = ctx

  /** The board: what is open now, the samples recorded so far, and the Hold badge. */
  /**
   * Whose sessions a request may list. An inspector sees only the sessions
   * they opened; a supervisor or administrator sees everyone's. The rule is
   * applied here, in SQL, so a list can never leak past the client's filters.
   */
  /**
   * Sessions are the factory's record, not the inspector's: everyone signed
   * in reads the board and the history in full (§14). What a role may change
   * is still decided per action.
   */
  function visibleTo(_user: AuthUser, _firstParam: number): { clause: string; params: unknown[] } {
    return { clause: 'TRUE', params: [] }
  }

  /**
   * The board: every open session, plus a closed one that still holds a
   * defect on Hold. Open sessions are everyone's to see and to join — two
   * inspectors record on the same one, each sample under its own name —
   * so the board is not narrowed to the viewer's own (§4.4).
   */
  r.get('/open', async (req, res) => {
    requireUser(req)
    const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(500).default(200) }), req.query)
    const visible = { clause: 'TRUE', params: [] as unknown[] }
    const onlyVisible = { clause: 'TRUE', params: [] as unknown[] }
    const sessions = await db.query<SessionRow & OrderSummaryRow>(
      `SELECT ${SESSION_SELECT}, ${ORDER_SUMMARY_SELECT}
         FROM inspection_sessions s LEFT JOIN production_orders o ON o.id = s.order_id
        WHERE s.deleted_at IS NULL AND ${visible.clause}
          AND (s.status = 'Open' OR EXISTS (
                SELECT 1 FROM defect_results d JOIN inspection_samples x ON x.id = d.sample_id
                 WHERE x.session_id = s.id AND x.deleted_at IS NULL AND d.deleted_at IS NULL AND d.disposition = 'Hold'))
        ORDER BY s.status = 'Open' DESC, s.started_at DESC LIMIT $1`,
      [q.limit, ...visible.params],
    )
    const ids = sessions.rows.map((s) => s.id)
    const [samples, hold] = await Promise.all([
      ids.length
        ? db.query<SampleSummary>(
            `SELECT ${SAMPLE_SUMMARY_SELECT} FROM inspection_samples sm WHERE sm.session_id = ANY($1::uuid[]) AND sm.deleted_at IS NULL ORDER BY sm.index`,
            [ids],
          )
        : Promise.resolve({ rows: [] as SampleSummary[] }),
      // Defects on Hold across the sessions this person may see, open or closed.
      db.query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM defect_results d
           JOIN inspection_samples sm ON sm.id = d.sample_id AND sm.deleted_at IS NULL
           JOIN inspection_sessions s ON s.id = sm.session_id AND s.deleted_at IS NULL
          WHERE d.disposition = 'Hold' AND d.deleted_at IS NULL AND ${onlyVisible.clause}`,
        onlyVisible.params,
      ),
    ])
    const body: OpenSessionsResponse = {
      sessions: sessions.rows.map(toSessionWithOrder),
      samples: samples.rows,
      holdCount: hold.rows[0].n,
    }
    res.json(body)
  })

  /**
   * §6 — a page of sessions, newest first, walked back with `before` so no
   * session is ever out of reach: the floor keeps recording, and a record
   * that falls past the first page is still the factory's evidence.
   */
  r.get('/history', async (req, res) => {
    requireUser(req)
    const q = parse(
      z.object({
        limit: z.coerce.number().int().min(1).max(500).default(100),
        disposition: z.enum(DISPOSITIONS as unknown as [string, ...string[]]).optional(),
        /** Sessions started before this instant: the end of the page already read. */
        before: z.string().datetime({ offset: true }).optional(),
      }),
      req.query,
    )
    // One more than asked for, so the page knows whether older ones remain.
    const { rows } = await db.query<SessionRow & OrderSummaryRow>(
      `SELECT ${SESSION_SELECT}, ${ORDER_SUMMARY_SELECT}
         FROM inspection_sessions s LEFT JOIN production_orders o ON o.id = s.order_id
        WHERE s.deleted_at IS NULL
          AND ($2::timestamptz IS NULL OR s.started_at < $2)
          AND ($3::text IS NULL OR EXISTS (
                SELECT 1 FROM inspection_samples sm
                JOIN defect_results d ON d.sample_id = sm.id AND d.deleted_at IS NULL
               WHERE sm.session_id = s.id AND sm.deleted_at IS NULL AND d.disposition::text = $3))
        ORDER BY s.started_at DESC, s.seq DESC LIMIT $1`,
      [q.limit + 1, q.before ?? null, q.disposition ?? null],
    )
    const body: HistoryResponse = { sessions: rows.slice(0, q.limit).map(toSessionWithOrder), hasMore: rows.length > q.limit }
    res.json(body)
  })

  /**
   * §4 — open a session against an order, confirming the starting quantity.
   * Called inside the transaction of the first sample (§4.4), so a session
   * never exists without one.
   */
  async function createSession(tx: Queryable, user: AuthUser, body: StartSessionRequest): Promise<SessionWithOrder> {
    {
      // A make-to-stock machine has no order to pick: its one fixed STOCK line
      // is kept (or restored, after a catalogue clear) and the session opens
      // against it with the quantity that came out.
      const orderId = 'orderId' in body ? body.orderId : await ensureStockLine(tx, body.workCenterCode)
      // Lock the order so two inspectors starting at once get distinct seqs.
      const order = (await tx.query<ProductionOrder>(
        `SELECT id, order_number AS "orderNumber", item, work_center_code AS "workCenterCode"
           FROM production_orders WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [orderId],
      )).rows[0]
      if (!order) throw badRequest('That order does not exist.')
      const seq = (await tx.query<{ next: number }>(
        `SELECT COALESCE(max(seq), 0) + 1 AS next FROM inspection_sessions WHERE order_id = $1`,
        [order.id],
      )).rows[0].next
      const { rows } =
        'orderId' in body
          ? await tx.query<{ id: string }>(
              `INSERT INTO inspection_sessions
                 (seq, order_id, work_center_code, inspector_id, inspector_name, start_qty, start_qty_by_id, start_qty_by_name, start_qty_at)
               VALUES ($1, $2, $3, $4, $5, $6, $4, $5, now()) RETURNING id`,
              [seq, order.id, order.workCenterCode, user.id, user.name, body.startQty],
            )
          : await tx.query<{ id: string }>(
              `INSERT INTO inspection_sessions (seq, order_id, work_center_code, inspector_id, inspector_name, produced_qty)
               VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
              [seq, order.id, order.workCenterCode, user.id, user.name, body.producedQty],
            )
      const session = (await loadSessionWithOrder(tx, rows[0].id))!
      await auditCreate(tx, auditCtxFor(user, session, 'InspectionSession', session.id))
      return session
    }
  }

  /** Kept for the API's sake; the app itself opens a session with its first sample. */
  r.post('/', requireCapability('record-inspection'), async (req, res) => {
    const user = requireUser(req)
    const body = parse(startSchema, req.body)
    const created = await withTransaction(db, (tx) => createSession(tx, user, body))
    res.status(201).json(created)
  })

  /** §4.4 — the session and its first sample, written together or not at all. */
  r.post('/start-with-sample', requireCapability('record-inspection'), async (req, res) => {
    const user = requireUser(req)
    const body = parse(z.object({ start: startSchema, sample: saveSampleSchema }), req.body)
    const outcome = await withTransaction(db, async (tx): Promise<StartWithSampleResponse> => {
      // A retry after the first attempt landed: answer with what exists.
      const dup = (await tx.query<{ id: string; index: number; sessionId: string }>(
        `SELECT id, index, session_id AS "sessionId" FROM inspection_samples WHERE submission_id = $1`,
        [body.sample.submissionId],
      )).rows[0]
      if (dup) {
        const session = await loadSessionWithOrder(tx, dup.sessionId)
        if (!session) throw notFound('That session')
        return { session, sample: { sampleId: dup.id, index: dup.index, deduped: true }, joined: false }
      }
      // One session per line at a time: if one is already open on it, the
      // sample joins it under this inspector's name instead of opening a twin.
      const lineId = 'orderId' in body.start ? body.start.orderId : (await tx.query<{ id: string }>(`SELECT id FROM production_orders WHERE lower(line_key) = lower($1) AND deleted_at IS NULL`, [stockLineKey(body.start.workCenterCode)])).rows[0]?.id
      const open = lineId
        ? (await tx.query<{ id: string }>(`SELECT id FROM inspection_sessions WHERE order_id = $1 AND status = 'Open' AND deleted_at IS NULL ORDER BY started_at DESC LIMIT 1 FOR UPDATE`, [lineId])).rows[0]
        : undefined
      const opened = open ? (await loadSessionWithOrder(tx, open.id, true))! : await createSession(tx, user, body.start)
      const sample = await saveSampleInSession(tx, user, opened, body.sample)
      const session = (await loadSessionWithOrder(tx, opened.id))!
      return { session, sample, joined: !!open }
    }).catch(async (e) => {
      if (e instanceof DuplicateSubmission) {
        const { rows } = await db.query<{ id: string; index: number; sessionId: string }>(`SELECT id, index, session_id AS "sessionId" FROM inspection_samples WHERE submission_id = $1`, [e.submissionId])
        const session = rows[0] ? await loadSessionWithOrder(db, rows[0].sessionId) : null
        if (rows[0] && session) return { session, sample: { sampleId: rows[0].id, index: rows[0].index, deduped: true }, joined: false } satisfies StartWithSampleResponse
      }
      throw e
    })
    res.status(outcome.sample.deduped ? 200 : 201).json(outcome)
  })

  /** What the wizard needs before a session exists: the line, the machine, the configuration (§4.4). */
  r.get('/preview', async (req, res) => {
    const start = parse(startSchema, req.query)
    const orderId = 'orderId' in start ? start.orderId : null
    const wc = 'orderId' in start ? null : start.workCenterCode
    let order: ProductionOrder | undefined
    if (orderId) [order] = await fetchOrdersByIds(db, [orderId])
    else {
      const stock = stockProductionOf(wc)
      if (!stock) throw badRequest('That machine does not work to stock; pick an order line.')
      // The STOCK line may not exist yet; the preview describes it without writing it.
      const { rows } = await db.query<ProductionOrder>(`SELECT ${ORDER_SELECT} FROM production_orders WHERE lower(line_key) = lower($1) AND deleted_at IS NULL`, [stockLineKey(wc!)])
      order = rows[0] ?? {
        id: '',
        lineKey: stockLineKey(wc!),
        orderNumber: 'STOCK',
        item: stock.item,
        itemCode: stock.itemCode,
        workCenterCode: wc!,
        requiredQty: 0,
        finishedQty: 0,
        erpStatus: 'Active',
        drawing: '',
        expectedGrade: '',
        customer: '',
      } as ProductionOrder
    }
    if (!order) throw notFound('That order line')
    res.json(await buildWizardContext(db, null, order))
  })

  r.get('/:id', async (req, res) => {
    const session = await loadSessionWithOrder(db, parse(uuid, req.params.id))
    if (!session) throw notFound('That session')
    res.json(session)
  })

  /** Everything the wizard needs in one round trip. */
  r.get('/:id/wizard', async (req, res) => {
    const id = parse(uuid, req.params.id)
    const session = await loadSessionWithOrder(db, id)
    if (!session) throw notFound('That session')
    const [order] = await fetchOrdersByIds(db, [session.orderId])
    if (!order) throw notFound('The session’s order')
    res.json(await buildWizardContext(db, session, order))
  })

  /** The wizard's context for a session, or for one about to be opened on a line (session null). */
  async function buildWizardContext(q: Queryable, session: SessionWithOrder | null, order: ProductionOrder): Promise<WizardContext> {
    const id = session?.id ?? null
    const wc = session?.workCenterCode ?? order.workCenterCode
    const machine = await loadMachine(q, wc)
    const process = processForMachine(machine, wc)
    const [dimOrder, refImages, wcDefects, grades, consumables, samples, previousDims, previousWire, instructions, previousSetup, orderNotes] = await Promise.all([
      // The item's general rows plus the rows specific to this machine; the
      // shared resolver decides which wins (§8.3).
      q.query<ItemDimensionOrder>(
        `SELECT id, item_code AS "itemCode", item, work_center_code AS "workCenterCode", dimension_name AS "dimensionName",
                sequence, nominal, tol_plus AS "tolPlus", tol_minus AS "tolMinus", unit
           FROM item_dimension_order
          WHERE lower(item_code) = lower($1) AND deleted_at IS NULL
            AND (work_center_code IS NULL OR lower(work_center_code) = lower($2))
          ORDER BY sequence`,
        [order.itemCode, wc],
      ),
      // The item's general photos plus those specific to this machine.
      q.query<ItemReferenceImage>(
        `SELECT id, item_code AS "itemCode", item, work_center_code AS "workCenterCode", image_id AS "imageId", caption
           FROM item_reference_images
          WHERE lower(item_code) = lower($1) AND deleted_at IS NULL
            AND (work_center_code IS NULL OR lower(work_center_code) = lower($2))
          ORDER BY work_center_code NULLS FIRST, created_at`,
        [order.itemCode, wc],
      ),
      q.query<WorkCenterDefect>(
        `SELECT id, work_center_code AS "workCenterCode", defect_name AS "defectName"
           FROM work_center_defects WHERE lower(work_center_code) = lower($1) AND deleted_at IS NULL ORDER BY defect_name`,
        [wc],
      ),
      q.query<GradeMapping>(`SELECT id, grade_a AS "gradeA", grade_b AS "gradeB" FROM grade_mappings WHERE deleted_at IS NULL`),
      q.query<PTConsumableProduct>(
        `SELECT id, kind, product_name AS "productName", lot_batch AS "lotBatch" FROM pt_consumables WHERE deleted_at IS NULL ORDER BY kind, product_name`,
      ),
      q.query<SampleSummary>(
        `SELECT ${SAMPLE_SUMMARY_SELECT} FROM inspection_samples sm WHERE sm.session_id = $1 AND sm.deleted_at IS NULL ORDER BY sm.index`,
        [id],
      ),
      // The nominal an inspector typed on the last sample of this item on
      // this machine — this session's own latest sample first — is offered
      // again on the next one, so it is typed once.
      q.query<PreviousDimension>(
        `SELECT d.name, d.nominal, d.tol_plus AS "tolPlus", d.tol_minus AS "tolMinus", d.unit
           FROM dimension_results d
          WHERE d.deleted_at IS NULL
            AND d.sample_id = (
              SELECT sm.id
                FROM inspection_samples sm
                JOIN inspection_sessions s ON s.id = sm.session_id
                JOIN production_orders o ON o.id = sm.order_id
               WHERE sm.deleted_at IS NULL AND s.deleted_at IS NULL
                 AND ${NORMALISED_CODE('s.work_center_code')} = $3
                 -- The same item by code, or — when the ERP export left the
                 -- code blank — the same order line.
                 AND ((btrim($2) <> '' AND lower(o.item_code) = lower($2)) OR sm.order_id = $4::uuid)
               ORDER BY (sm.session_id = $1::uuid) DESC, (sm.order_id = $4::uuid) DESC, sm.created_at DESC
               LIMIT 1)
          ORDER BY d.sequence, d.name`,
        [id, order.itemCode, normaliseMachineCode(wc), order.id || null],
      ),
      // The welding wire batch of this session's latest sample, offered again.
      q.query<{ batch: string | null }>(
        `SELECT p.welding_wire_batch AS batch
           FROM pt_records p JOIN inspection_samples sm ON sm.id = p.sample_id
          WHERE sm.session_id = $1 AND sm.deleted_at IS NULL AND p.deleted_at IS NULL
          ORDER BY sm.created_at DESC LIMIT 1`,
        [id],
      ),
      instructionsInForce(q, process),
      id ? loadPreviousSetup(q, id) : Promise.resolve(null),
      // A stock line that was never written yet has no id and no notes.
      order.id ? loadOrderNotes(q, order.id) : Promise.resolve([]),
    ])
    const plain = session ? (({ order: _summary, ...rest }) => rest)(session) : null
    // A machine switched off in Configuration takes no configured dimensions:
    // the inspector types them, and the previous sample's rows carry forward.
    const loadsDimensions = machine?.usesItemDimensions !== false
    const body: WizardContext = {
      session: plain,
      order,
      machine,
      dimensionOrder: loadsDimensions ? dimOrder.rows.map(dropNulls) : [],
      referenceImages: refImages.rows.map(dropNulls),
      workCenterDefects: wcDefects.rows,
      gradeMappings: grades.rows,
      ptConsumables: consumables.rows,
      samples: samples.rows,
      previousDimensions: previousDims.rows,
      process,
      previousWeldingWireBatch: previousWire.rows[0]?.batch ?? null,
      previousSetup,
      workInstructions: instructions,
      orderNotes,
    }
    return body
  }

  /** §5.8 — the notes written during this session, newest first. */
  r.get('/:id/notes', async (req, res) => {
    const id = parse(uuid, req.params.id)
    const session = await loadSessionWithOrder(db, id)
    if (!session) throw notFound('That session')
    const body: SessionNotesResponse = { notes: await loadSessionNotes(db, id) }
    res.json(body)
  })

  /** Mark a note deleted — administrators only; the row and its photos stay. */
  r.delete('/:id/notes/:noteId', requireCapability('delete-note'), async (req, res) => {
    const user = requireUser(req)
    const id = parse(uuid, req.params.id)
    const noteId = parse(uuid, req.params.noteId)
    await withTransaction(db, async (tx) => {
      const session = await loadSessionWithOrder(tx, id)
      if (!session) throw notFound('That session')
      const { rows } = await tx.query<{ id: string; sample_id: string | null }>(
        `UPDATE session_notes SET deleted_at = now(), deleted_by_id = $3
          WHERE id = $1 AND session_id = $2 AND deleted_at IS NULL RETURNING id, sample_id`,
        [noteId, id, user.id],
      )
      if (!rows[0]) throw notFound('That note')
      await auditDelete(tx, auditCtxFor(user, session, 'SessionNote', noteId, rows[0].sample_id ?? undefined))
    })
    res.status(204).end()
  })

  r.get('/:id/samples', async (req, res) => {
    const id = parse(uuid, req.params.id)
    const { rows } = await db.query<SampleSummary>(
      `SELECT ${SAMPLE_SUMMARY_SELECT} FROM inspection_samples sm WHERE sm.session_id = $1 AND sm.deleted_at IS NULL ORDER BY sm.index`,
      [id],
    )
    res.json(rows)
  })

  /** §8.6 — close with the confirmed final quantity. Rejected if the session moved. */
  r.post('/:id/close', requireCapability('record-inspection'), async (req, res) => {
    const user = requireUser(req)
    const id = parse(uuid, req.params.id)
    const body = parse(closeSchema, req.body)
    const closed = await withTransaction(db, async (tx) => {
      const before = await loadSessionWithOrder(tx, id, true)
      if (!before) throw notFound('That session')
      if (before.version !== body.version) throw new ConflictError(before)
      if (before.status === 'Closed') throw badRequest('This session is already closed.')
      // A session is an inspection record: with no sample it recorded nothing,
      // so it cannot be closed as one — it is discarded instead.
      if ((before.sampleCount ?? 0) === 0) throw badRequest('No sample has been recorded in this session. Record one before closing, or discard the session.')
      await tx.query(
        `UPDATE inspection_sessions SET status = 'Closed', final_qty = $2, closed_at = now(), closed_by_id = $3, version = version + 1 WHERE id = $1`,
        [id, body.finalQty, user.id],
      )
      const after = (await loadSessionWithOrder(tx, id))!
      await auditChanges(
        tx,
        auditCtxFor(user, before, 'InspectionSession', id),
        { status: before.status, finalQty: before.finalQty, closedAt: before.closedAt, closedById: before.closedById },
        { status: after.status, finalQty: after.finalQty, closedAt: after.closedAt, closedById: after.closedById },
      )
      return after
    })
    res.json(closed)
  })

  /** §10 — a session is marked deleted, never erased. */
  /**
   * Discard a session that recorded nothing: no sample was saved in it. The
   * inspector who opened it may discard it (a supervisor anyone's), so an
   * inspection started by mistake does not linger on the board as an empty
   * record. Marked deleted like everything else, and audited.
   */
  r.post('/:id/discard', requireCapability('record-inspection'), async (req, res) => {
    const user = requireUser(req)
    const id = parse(uuid, req.params.id)
    await withTransaction(db, async (tx) => {
      const session = await loadSessionWithOrder(tx, id, true)
      if (!session) throw notFound('That session')
      // The inspector who opened it, or a role that oversees everyone's sessions.
      if (session.inspectorId !== user.id && !can(user.role, 'view-all-sessions')) throw forbidden()
      if ((session.sampleCount ?? 0) > 0) throw badRequest('This session has samples: it is a record now. An administrator can delete it from History.')
      await tx.query(`UPDATE inspection_sessions SET deleted_at = now(), deleted_by_id = $2 WHERE id = $1`, [id, user.id])
      await writeAudit(tx, [
        auditEvent('delete', auditCtxFor(user, session, 'InspectionSession', id), new Date().toISOString(), {
          field: 'reason',
          newValue: 'Discarded: no sample was recorded.',
        }),
      ])
    })
    res.status(204).end()
  })

  r.delete('/:id', requireCapability('delete-session'), async (req, res) => {
    const user = requireUser(req)
    const id = parse(uuid, req.params.id)
    await withTransaction(db, async (tx) => {
      const session = await loadSessionWithOrder(tx, id, true)
      if (!session) throw notFound('That session')
      await tx.query(`UPDATE inspection_sessions SET deleted_at = now(), deleted_by_id = $2 WHERE id = $1`, [id, user.id])
      await auditDelete(tx, auditCtxFor(user, session, 'InspectionSession', id))
    })
    res.status(204).end()
  })

  /** §9 — save a complete sample atomically. */
  r.post('/:id/samples', requireCapability('record-inspection'), async (req, res) => {
    const user = requireUser(req)
    const sessionId = parse(uuid, req.params.id)
    const body = parse(saveSampleSchema, req.body)

    const outcome = await withTransaction(db, async (tx): Promise<SaveSampleResponse> => {
      // Lock the session: sample indexes are assigned under this lock, and a
      // closed session cannot gain samples.
      const session = await loadSessionWithOrder(tx, sessionId, true)
      if (!session) throw notFound('That session')
      if (session.status === 'Closed') throw badRequest('This session is closed. Samples cannot be added to it.')
      if (session.inspectorId !== user.id && !can(user.role, 'edit-open-session')) throw forbidden()

      // §9.3 — a retry with the same submission id returns the first save.
      const dup = (await tx.query<{ id: string; index: number }>(
        `SELECT id, index FROM inspection_samples WHERE submission_id = $1`,
        [body.submissionId],
      )).rows[0]
      if (dup) return { sampleId: dup.id, index: dup.index, deduped: true }
      return saveSampleInSession(tx, user, session, body)
    }).catch(async (e) => {
      if (e instanceof DuplicateSubmission) {
        const { rows } = await db.query<{ id: string; index: number }>(`SELECT id, index FROM inspection_samples WHERE submission_id = $1`, [e.submissionId])
        if (rows[0]) return { sampleId: rows[0].id, index: rows[0].index, deduped: true } satisfies SaveSampleResponse
      }
      throw e
    })

    res.status(outcome.deduped ? 200 : 201).json(outcome)
  })

  /** The sample's rows and its audit, under the session's lock. */
  async function saveSampleInSession(tx: Queryable, user: AuthUser, session: SessionWithOrder, body: z.infer<typeof saveSampleSchema>): Promise<SaveSampleResponse> {
    const sessionId = session.id
    {
      const [order] = await fetchOrdersByIds(tx, [session.orderId])
      if (!order) throw notFound('The session’s order')
      const wc = session.workCenterCode
      const process = processForMachine(await loadMachine(tx, wc), wc)

      const { imageIds } = await validateSampleBody(tx, process, body, !isStockOrder(order))

      const index = (await tx.query<{ next: number }>(
        `SELECT COALESCE(max(index), 0) + 1 AS next FROM inspection_samples WHERE session_id = $1`,
        [sessionId],
      )).rows[0].next
      const now = new Date()
      const shift = deriveShift(now, ctx.config.FACTORY_TIMEZONE)
      const ack = body.gradeAcknowledgement

      let sampleId: string
      try {
        sampleId = (await tx.query<{ id: string }>(
          `INSERT INTO inspection_samples
             (session_id, order_id, index, shift, created_at, inspector_id, inspector_name, drawing, drawing_alt, issue,
              sample_qty, grade_ack_by_id, grade_ack_by_name, grade_ack_at, grade_ack_coil_numbers,
              grade_ack_expected_grade, grade_ack_found_grades, submission_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
          [
            sessionId,
            session.orderId,
            index,
            shift,
            now,
            user.id,
            user.name,
            body.drawing,
            body.drawingAlt ?? null,
            body.issue ?? null,
            body.sampleQty,
            ack ? user.id : null,
            ack ? user.name : null,
            ack ? ack.at : null,
            ack ? ack.coilNumbers : null,
            ack ? ack.expectedGrade : null,
            ack ? ack.foundGrades : null,
            body.submissionId,
          ],
        )).rows[0].id
      } catch (e) {
        // Two identical submissions raced past the check above; the other one
        // won. Surface it as the dedupe it is, not as an error.
        if (pgCode(e) === PG.UNIQUE_VIOLATION) {
          throw new DuplicateSubmission(body.submissionId)
        }
        throw e
      }

      await writeSampleChildren(tx, sampleId, process, body, imageIds)

      const auditCtx = auditCtxFor(user, session, 'InspectionSample', sampleId, sampleId)
      const at = now.toISOString()
      const entries = [auditEvent('create', auditCtx, at)]
      // §5.8 — a remark about the order rides along with the sample, as one unit.
      if (!noteIsEmpty(body.note)) {
        const noteId = await writeSessionNote(tx, { sessionId, orderId: session.orderId, sampleId, author: user, note: body.note })
        entries.push(auditEvent('create', auditCtxFor(user, session, 'SessionNote', noteId, sampleId), at))
      }
      // §8.4 — an overridden grade mismatch is itself evidence.
      if (ack) {
        entries.push(
          auditEvent('acknowledge', auditCtx, at, {
            field: 'gradeAcknowledgement',
            newValue: JSON.stringify({ ...ack, byId: user.id, byName: user.name }),
          }),
        )
      }
      await writeAudit(tx, entries)
      return { sampleId, index, deduped: false }
    }
  }

  /**
   * Re-record a sample from History (§9.4): the whole record is replaced as
   * one unit. The previous child rows are marked deleted — never erased — and
   * the new ones written; the sample keeps its number, shift, time and
   * inspector, and every scalar change is audited field by field.
   */
  r.put('/:id/samples/:sampleId', requireCapability('record-inspection'), async (req, res) => {
    const user = requireUser(req)
    const sessionId = parse(uuid, req.params.id)
    const sampleId = parse(uuid, req.params.sampleId)
    const body = parse(reRecordSchema, req.body)

    const outcome = await withTransaction(db, async (tx): Promise<ReRecordSampleResponse> => {
      const session = await loadSessionWithOrder(tx, sessionId, true)
      if (!session) throw notFound('That session')
      // An open session may be corrected by anyone who records; a closed one
      // only by a role allowed to correct closed records (§14).
      const capability = session.status === 'Open' ? 'edit-open-session' : 'edit-closed-session'
      if (!can(user.role, capability)) throw forbidden()

      const before = (
        await tx.query<SampleRow>(`SELECT ${SAMPLE_SELECT} FROM inspection_samples sm WHERE sm.id = $1 AND sm.session_id = $2 AND sm.deleted_at IS NULL FOR UPDATE`, [
          sampleId,
          sessionId,
        ])
      ).rows[0]
      if (!before) throw notFound('That sample')
      if (before.version !== body.version) throw new ConflictError(dropNulls(toSample(before)))

      const wc = session.workCenterCode
      const process = processForMachine(await loadMachine(tx, wc), wc)
      const { imageIds } = await validateSampleBody(tx, process, body, !isStockOrder(session.order))

      // Retire the current child rows; nothing is erased.
      const counts = await retireSampleChildren(tx, sampleId, user.id)
      await tx.query(
        `UPDATE inspection_samples
            SET drawing = $2, drawing_alt = $3, issue = $4, sample_qty = $5, version = version + 1
          WHERE id = $1`,
        [sampleId, body.drawing, body.drawingAlt ?? null, body.issue ?? null, body.sampleQty],
      )
      await writeSampleChildren(tx, sampleId, process, body, imageIds)

      const auditCtx = auditCtxFor(user, session, 'InspectionSample', sampleId, sampleId)
      await auditChanges(
        tx,
        auditCtx,
        {
          drawing: before.drawing,
          drawingAlt: before.drawingAlt,
          issue: before.issue,
          sampleQty: before.sampleQty,
          dimensions: counts.dimensions,
          defects: counts.defects,
          coils: counts.coils,
        },
        {
          drawing: body.drawing,
          drawingAlt: body.drawingAlt ?? null,
          issue: body.issue ?? null,
          sampleQty: body.sampleQty,
          dimensions: body.dimensions.length,
          defects: body.defects.length,
          coils: body.coils.length,
        },
      )
      const at = new Date().toISOString()
      const entries = [auditEvent('update', auditCtx, at, { field: 'reRecorded', newValue: 'The whole sample was re-recorded from History.' })]
      // A note written while re-recording is a new remark; earlier ones stand.
      if (!noteIsEmpty(body.note)) {
        const noteId = await writeSessionNote(tx, { sessionId, orderId: session.orderId, sampleId, author: user, note: body.note })
        entries.push(auditEvent('create', auditCtxFor(user, session, 'SessionNote', noteId, sampleId), at))
      }
      await writeAudit(tx, entries)
      return { sampleId, index: before.index, version: before.version + 1 }
    })
    res.json(outcome)
  })

  /** Reopen a closed session so samples can be added again. Closed-record rights required. */
  r.post('/:id/reopen', requireCapability('edit-closed-session'), async (req, res) => {
    const user = requireUser(req)
    const id = parse(uuid, req.params.id)
    const body = parse(reopenSchema, req.body)
    const reopened = await withTransaction(db, async (tx) => {
      const before = await loadSessionWithOrder(tx, id, true)
      if (!before) throw notFound('That session')
      if (before.version !== body.version) throw new ConflictError(before)
      if (before.status === 'Open') throw badRequest('This session is already open.')
      await tx.query(`UPDATE inspection_sessions SET status = 'Open', closed_at = NULL, closed_by_id = NULL, version = version + 1 WHERE id = $1`, [id])
      const after = (await loadSessionWithOrder(tx, id))!
      await auditChanges(
        tx,
        auditCtxFor(user, before, 'InspectionSession', id),
        { status: before.status, closedAt: before.closedAt, closedById: before.closedById },
        { status: after.status, closedAt: after.closedAt, closedById: after.closedById },
      )
      return after
    })
    res.json(reopened)
  })

  return r
}

const reRecordSchema = saveSampleSchema.omit({ submissionId: true }).extend({ version: z.coerce.number().int().min(0) })

/** The same business rules the wizard applies, enforced where they cannot be bypassed (§5, §8). */
async function validateSampleBody(
  tx: Queryable,
  process: Process,
  body: Omit<z.infer<typeof saveSampleSchema>, 'submissionId'>,
  drawingRequired = true,
): Promise<{ imageIds: string[] }> {
  const issues = validateSample({
    process,
    drawingRequired,
    sampleQty: body.sampleQty,
    drawing: body.drawing,
    coils: body.coils.map((c) => ({ coilNumber: c.coilNumber, grade: c.grade })),
    defects: body.defects.map((d) => ({ defectName: d.defectName, disposition: d.disposition as never, qty: d.qty, notes: d.notes })),
    dimensions: body.dimensions.map((d) => ({ name: d.name, nominal: d.nominal ?? null, actual: d.actual ?? null })),
    paint: body.paint ? { imageIds: body.paint.imageIds } : { imageIds: [] },
    pt: body.pt
      ? { testFrequencyPct: body.pt.testFrequencyPct, consumableLots: body.pt.consumableLots, testedLengths: body.pt.testedLengths }
      : undefined,
  })
  if (issues.length > 0) throw badRequest(issues[0].message, issues)
  if (process === 'paint' && !body.paint) throw badRequest('A paint sample record is required on this machine.')

  const imageIds = [...body.defects.flatMap((d) => d.imageIds), ...(body.paint?.imageIds ?? []), ...(body.pt?.imageIds ?? [])]
  // The note's photos must exist too, but they belong to the session, not the sample.
  await assertImagesUsable(tx, [...imageIds, ...(body.note?.imageIds ?? [])])
  return { imageIds }
}

/** Mark every child row of a sample deleted, returning how many of each were live. */
async function retireSampleChildren(tx: Queryable, sampleId: string, byId: string): Promise<{ dimensions: number; defects: number; coils: number }> {
  const dims = await tx.query(`UPDATE dimension_results SET deleted_at = now(), deleted_by_id = $2 WHERE sample_id = $1 AND deleted_at IS NULL`, [sampleId, byId])
  const defects = await tx.query(`UPDATE defect_results SET deleted_at = now(), deleted_by_id = $2 WHERE sample_id = $1 AND deleted_at IS NULL`, [sampleId, byId])
  const coils = await tx.query(`UPDATE sample_coils SET deleted_at = now(), deleted_by_id = $2 WHERE sample_id = $1 AND deleted_at IS NULL`, [sampleId, byId])
  await tx.query(`UPDATE paint_samples SET deleted_at = now(), deleted_by_id = $2 WHERE sample_id = $1 AND deleted_at IS NULL`, [sampleId, byId])
  await tx.query(
    `UPDATE pt_tested_lengths l SET deleted_at = now(), deleted_by_id = $2
       FROM pt_records p WHERE p.id = l.pt_record_id AND p.sample_id = $1 AND l.deleted_at IS NULL`,
    [sampleId, byId],
  )
  await tx.query(`UPDATE pt_records SET deleted_at = now(), deleted_by_id = $2 WHERE sample_id = $1 AND deleted_at IS NULL`, [sampleId, byId])
  return { dimensions: dims.rowCount ?? 0, defects: defects.rowCount ?? 0, coils: coils.rowCount ?? 0 }
}

/** Write a sample's measurements, defects, coils, paint and PT rows, and claim its photos. */
async function writeSampleChildren(
  tx: Queryable,
  sampleId: string,
  process: Process,
  body: Omit<z.infer<typeof saveSampleSchema>, 'submissionId'>,
  imageIds: string[],
): Promise<void> {
  for (const d of body.dimensions) {
    await tx.query(
      `INSERT INTO dimension_results (sample_id, name, sequence, nominal, tol_plus, tol_minus, actual, unit, status, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        sampleId,
        d.name,
        d.sequence,
        d.nominal,
        d.tolPlus,
        d.tolMinus,
        d.actual,
        d.unit,
        dimensionStatus({ nominal: d.nominal, tolPlus: d.tolPlus, tolMinus: d.tolMinus, actual: d.actual }),
        d.source,
      ],
    )
  }
  for (const d of body.defects) {
    const defectId = (await tx.query<{ id: string }>(
      `INSERT INTO defect_results (sample_id, defect_name, qty, disposition, notes) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [sampleId, d.defectName, d.qty, d.disposition, d.notes ?? null],
    )).rows[0].id
    await linkImages(tx, 'defect_images', 'defect_id', defectId, d.imageIds)
  }
  await assertCoilsUsable(tx, body.coils.flatMap((c) => (c.coilId ? [c.coilId] : [])))
  for (const c of body.coils) {
    await tx.query(
      `INSERT INTO sample_coils (sample_id, coil_id, coil_number, grade, sm_type, supplier, thickness, width, yield, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [sampleId, c.coilId ?? null, c.coilNumber, c.grade ?? null, c.smType ?? null, c.supplier ?? null, c.thickness ?? null, c.width ?? null, c.yield ?? null, c.notes ?? null],
    )
  }
  if (body.paint && process === 'paint') {
    const paintId = (await tx.query<{ id: string }>(`INSERT INTO paint_samples (sample_id, notes) VALUES ($1, $2) RETURNING id`, [sampleId, body.paint.notes ?? null]))
      .rows[0].id
    await linkImages(tx, 'paint_sample_images', 'paint_sample_id', paintId, body.paint.imageIds)
  }
  if (body.pt && process === 'welding') {
    const pt = body.pt
    // The record's verdict follows its lengths: Reject / Repair as soon as one is.
    const verdict = ptOverallVerdict(pt.testedLengths)
    const ptId = (await tx.query<{ id: string }>(
      `INSERT INTO pt_records
         (sample_id, test_frequency_pct, cleaner_lot, penetrant_lot, developer_lot, welding_wire_batch, accept_or_repair, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [sampleId, pt.testFrequencyPct, pt.consumableLots.Cleaner, pt.consumableLots.Penetrant, pt.consumableLots.Developer, pt.weldingWireBatch ?? null, verdict, pt.notes ?? null],
    )).rows[0].id
    for (const [i, l] of pt.testedLengths.entries()) {
      await tx.query(`INSERT INTO pt_tested_lengths (pt_record_id, seq, length_mm, verdict) VALUES ($1, $2, $3, $4)`, [ptId, i + 1, l.lengthMm, l.verdict])
    }
    await linkImages(tx, 'pt_record_images', 'pt_record_id', ptId, pt.imageIds)
  }
  if (imageIds.length > 0) {
    await tx.query(`UPDATE images SET sample_id = $1 WHERE id = ANY($2::uuid[]) AND sample_id IS NULL`, [sampleId, imageIds])
  }
}

class DuplicateSubmission extends Error {
  constructor(readonly submissionId: string) {
    super('duplicate submission')
  }
}

export { loadSessionWithOrder, auditCtxFor, toSession }
export type { InspectionSession }
