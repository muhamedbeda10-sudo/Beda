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
  HistoryOptionsResponse,
  HistoryResponse,
  OpenSessionsResponse,
  PreviousDimension,
  PreviousSetup,
  ReRecordSampleResponse,
  SaveCoilInput,
  SampleSummary,
  SaveSampleResponse,
  SessionNotesResponse,
  SessionStagesResponse,
  HistoryExportResponse,
  HistoryGroupResponse,
  HistoryGroupSession,
  SessionWithOrder,
  WizardContext,
  StartSessionRequest,
  StartWithSampleResponse,
  SessionImageGroup,
  SessionImageItem,
  SessionImageKind,
  SessionImagesResponse,
} from '@qc/shared/api'
import { EXPORT_MAX_RECORDS, HISTORY_GROUP_LIMIT } from '@qc/shared/api'
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
export const NORMALISED_CODE = (col: string) =>
  `(CASE WHEN regexp_replace(lower(translate(${col}, '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789')), '\\s+', '', 'g') ~ '^[0-9]+$'
         THEN COALESCE(NULLIF(ltrim(regexp_replace(lower(translate(${col}, '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789')), '\\s+', '', 'g'), '0'), ''), '0')
         ELSE regexp_replace(lower(translate(${col}, '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789')), '\\s+', '', 'g') END)`

const startSchema = z.union([
  z.object({ orderId: uuid, startQty: z.coerce.number().min(0) }),
  z.object({ workCenterCode: z.string().trim().min(1).max(40), producedQty: z.coerce.number().min(0) }),
])
/** A stage of an item on a universal machine. */
const stageSchema = z.coerce.number().int().min(1).max(50)
const closeSchema = z.object({ finalQty: z.coerce.number().min(0), stage: stageSchema.optional(), version: z.coerce.number().int().min(0) })

/** A defect quantity counts defective pieces of the batch (§15): the final quantity is the batch, so it cannot be below them. */
const reopenSchema = z.object({ version: z.coerce.number().int().min(0) })
const quantitiesSchema = z
  .object({
    startQty: z.coerce.number().min(0).optional(),
    producedQty: z.coerce.number().min(0).optional(),
    finalQty: z.coerce.number().min(0).optional(),
    stage: stageSchema.optional(),
    version: z.coerce.number().int().min(0),
  })
  .refine((b) => b.startQty !== undefined || b.producedQty !== undefined || b.finalQty !== undefined || b.stage !== undefined, { message: 'Nothing to change.' })

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
      testFrequencyPct: z.number().finite().optional(),
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
      historyFilterSchema.extend({
        limit: z.coerce.number().int().min(1).max(500).default(100),
        /** Sessions started before this instant: the end of the page already read. */
        before: z.string().datetime({ offset: true }).optional(),
      }),
      req.query,
    )
    const { where, params } = historyWhere(q, ctx.config.FACTORY_TIMEZONE)
    const p = (v: unknown) => `$${params.push(v)}`
    const filterParams = [...params]
    // The cursor is not a filter: the totals below count the whole match, and
    // only the page walks back from where the last one ended.
    const paged = q.before ? `${where} AND s.started_at < ${p(q.before)}::timestamptz` : where
    const limit = p(q.limit + 1) // One more than asked for, so the page knows whether older ones remain.

    const page = db.query<SessionRow & OrderSummaryRow>(
      `SELECT ${SESSION_SELECT}, ${ORDER_SUMMARY_SELECT}
         FROM inspection_sessions s LEFT JOIN production_orders o ON o.id = s.order_id
        WHERE ${paged}
        ORDER BY s.started_at DESC, s.seq DESC LIMIT ${limit}`,
      params,
    )
    // How many match in total, counted once: the first page carries it, and
    // walking back does not change it.
    const totals = q.before
      ? null
      : db.query<{ sessions: number; open: number }>(
          `SELECT count(*)::int AS sessions, count(*) FILTER (WHERE s.status = 'Open')::int AS open
             FROM inspection_sessions s LEFT JOIN production_orders o ON o.id = s.order_id
            WHERE ${where}`,
          filterParams,
        )
    const [rows, counted] = await Promise.all([page, totals])

    const body: HistoryResponse = { sessions: rows.rows.slice(0, q.limit).map(toSessionWithOrder), hasMore: rows.rows.length > q.limit }
    if (counted) body.totals = counted.rows[0]
    res.json(body)
  })

  /**
   * §6 — History's grouped view: the sessions of an order (read whole), or of
   * an item, a machine or the filters as they stand, newest first, each with
   * its counts and its defects. Bounded at HISTORY_GROUP_LIMIT sessions.
   */
  r.get('/history/group', async (req, res) => {
    requireUser(req)
    const q = parse(
      historyFilterSchema.extend({
        orderNumber: z.string().trim().min(1).max(120).optional(),
        itemCode: z.string().trim().min(1).max(120).optional(),
      }),
      req.query,
    )
    // An order is its whole record: the other filters do not narrow it.
    const { where, params } = q.orderNumber ? { where: 's.deleted_at IS NULL', params: [] as unknown[] } : historyWhere(q, ctx.config.FACTORY_TIMEZONE)
    const p = (v: unknown) => `$${params.push(v)}`
    const clauses = [where]
    if (q.orderNumber) clauses.push(`lower(btrim(o.order_number)) = lower(btrim(${p(q.orderNumber)}))`)
    if (q.itemCode) clauses.push(`lower(btrim(o.item_code)) = lower(btrim(${p(q.itemCode)}))`)
    const { rows } = await db.query<HistoryGroupSession & { total: number }>(
      `SELECT s.id AS "sessionId", s.seq, s.order_id AS "orderId", COALESCE(o.order_number, '') AS "orderNumber", COALESCE(o.item, '') AS item,
              COALESCE(o.item_code, '') AS "itemCode", s.work_center_code AS "workCenterCode", COALESCE(m.display_name, s.work_center_code) AS machine,
              COALESCE(m.factory, '') AS factory, s.status, s.stage, s.started_at AS "startedAt", s.closed_at AS "closedAt", s.inspector_name AS "inspectorName",
              (SELECT count(*)::int FROM inspection_samples x WHERE x.session_id = s.id AND x.deleted_at IS NULL) AS samples,
              (SELECT COALESCE(sum(x.sample_qty), 0)::float8 FROM inspection_samples x WHERE x.session_id = s.id AND x.deleted_at IS NULL) AS "piecesInspected",
              (SELECT COALESCE(sum(d.qty), 0)::float8 FROM defect_results d JOIN inspection_samples x ON x.id = d.sample_id
                WHERE x.session_id = s.id AND x.deleted_at IS NULL AND d.deleted_at IS NULL) AS "defectPieces",
              COALESCE((SELECT jsonb_agg(jsonb_build_object('defectName', t.defect_name, 'pieces', t.pieces) ORDER BY t.pieces DESC, t.defect_name)
                          FROM (SELECT d.defect_name, sum(d.qty)::float8 AS pieces
                                  FROM defect_results d JOIN inspection_samples x ON x.id = d.sample_id
                                 WHERE x.session_id = s.id AND x.deleted_at IS NULL AND d.deleted_at IS NULL
                                 GROUP BY d.defect_name) t), '[]') AS defects,
              count(*) OVER ()::int AS total
         FROM inspection_sessions s
         LEFT JOIN production_orders o ON o.id = s.order_id
         LEFT JOIN LATERAL (
           SELECT m.display_name, m.factory FROM machines m
            WHERE lower(m.code) = lower(s.work_center_code) AND m.deleted_at IS NULL ORDER BY m.created_at LIMIT 1) m ON true
        WHERE ${clauses.join(' AND ')}
        ORDER BY s.started_at DESC, s.seq DESC
        LIMIT ${p(HISTORY_GROUP_LIMIT)}`,
      params,
    )
    const iso = (v: string | Date | null) => (v === null ? null : new Date(v).toISOString())
    const total = rows[0]?.total ?? 0
    const body: HistoryGroupResponse = {
      sessions: rows.map(({ total: _t, ...r }) => ({ ...r, startedAt: iso(r.startedAt)!, closedAt: iso(r.closedAt) })),
      total,
      truncated: total > rows.length,
    }
    res.json(body)
  })

  /**
   * §6 — History to Excel: every session the filters match, oldest first,
   * with its samples, measurements and defects. Bounded: past
   * EXPORT_MAX_RECORDS sessions the filters must narrow.
   */
  r.get('/history/export', requireCapability('export-records'), async (req, res) => {
    const q = parse(historyFilterSchema, req.query)
    const { where, params } = historyWhere(q, ctx.config.FACTORY_TIMEZONE)
    const counted = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM inspection_sessions s LEFT JOIN production_orders o ON o.id = s.order_id WHERE ${where}`,
      params,
    )
    if (counted.rows[0].n > EXPORT_MAX_RECORDS) {
      throw badRequest(`${counted.rows[0].n} sessions match; one export holds ${EXPORT_MAX_RECORDS}. Narrow the date range or the filters.`)
    }
    const sessions = await db.query<HistoryExportResponse['sessions'][number]>(
      `SELECT s.id AS ref, s.seq, COALESCE(o.order_number, '') AS "orderNumber", COALESCE(o.item, '') AS item, COALESCE(o.item_code, '') AS "itemCode",
              COALESCE(o.customer, '') AS customer, s.work_center_code AS "workCenterCode",
              COALESCE(m.display_name, s.work_center_code) AS machine, COALESCE(m.factory, '') AS factory, COALESCE(m.process, '') AS process,
              s.stage, s.inspector_name AS "inspectorName", s.started_at AS "startedAt", s.closed_at AS "closedAt",
              (SELECT u.name FROM users u WHERE u.id = s.closed_by_id) AS "closedByName", s.status,
              s.start_qty::float8 AS "rejectedBeforeRelease", s.final_qty::float8 AS "finalQty", s.produced_qty::float8 AS "producedQty",
              (SELECT count(*)::int FROM inspection_samples x WHERE x.session_id = s.id AND x.deleted_at IS NULL) AS samples,
              (SELECT COALESCE(sum(x.sample_qty), 0)::float8 FROM inspection_samples x WHERE x.session_id = s.id AND x.deleted_at IS NULL) AS "piecesInspected",
              (SELECT COALESCE(sum(d.qty), 0)::float8 FROM defect_results d JOIN inspection_samples x ON x.id = d.sample_id
                WHERE x.session_id = s.id AND x.deleted_at IS NULL AND d.deleted_at IS NULL) AS "defectPieces",
              (SELECT COALESCE(sum(d.qty), 0)::float8 FROM defect_results d JOIN inspection_samples x ON x.id = d.sample_id
                WHERE x.session_id = s.id AND x.deleted_at IS NULL AND d.deleted_at IS NULL AND d.disposition = 'Hold') AS "holdPieces"
         FROM inspection_sessions s
         LEFT JOIN production_orders o ON o.id = s.order_id
         LEFT JOIN LATERAL (
           SELECT m.display_name, m.factory, m.process FROM machines m
            WHERE lower(m.code) = lower(s.work_center_code) AND m.deleted_at IS NULL ORDER BY m.created_at LIMIT 1) m ON true
        WHERE ${where}
        ORDER BY s.started_at, s.seq`,
      params,
    )
    const ids = sessions.rows.map((r) => r.ref)
    const [samples, measurements, defects] = await Promise.all([
      db.query<HistoryExportResponse['samples'][number]>(
        `SELECT x.session_id AS "sessionRef", x.index, x.created_at AS "recordedAt", x.inspector_name AS "inspectorName", x.shift,
                x.sample_qty::float8 AS "sampleQty", x.drawing, COALESCE(x.issue, '') AS issue,
                COALESCE((SELECT string_agg(c.coil_number, ', ' ORDER BY c.coil_number) FROM sample_coils c
                           WHERE c.sample_id = x.id AND c.deleted_at IS NULL), '') AS coils
           FROM inspection_samples x WHERE x.session_id = ANY($1::uuid[]) AND x.deleted_at IS NULL
          ORDER BY x.created_at, x.index`,
        [ids],
      ),
      db.query<HistoryExportResponse['measurements'][number]>(
        `SELECT x.session_id AS "sessionRef", x.index AS "sampleIndex", r.name, r.nominal::float8 AS nominal, r.tol_plus::float8 AS "tolPlus",
                r.tol_minus::float8 AS "tolMinus", COALESCE(r.unit, '') AS unit, r.actual::float8 AS actual, r.status
           FROM dimension_results r JOIN inspection_samples x ON x.id = r.sample_id AND x.deleted_at IS NULL
          WHERE x.session_id = ANY($1::uuid[]) AND r.deleted_at IS NULL
          ORDER BY x.created_at, x.index, r.sequence`,
        [ids],
      ),
      db.query<HistoryExportResponse['defects'][number]>(
        `SELECT x.session_id AS "sessionRef", x.index AS "sampleIndex", d.defect_name AS "defectName", d.qty::float8 AS qty,
                d.disposition::text AS disposition, COALESCE(d.notes, '') AS notes
           FROM defect_results d JOIN inspection_samples x ON x.id = d.sample_id AND x.deleted_at IS NULL
          WHERE x.session_id = ANY($1::uuid[]) AND d.deleted_at IS NULL
          ORDER BY x.created_at, x.index, d.defect_name`,
        [ids],
      ),
    ])
    const iso = (v: string | Date | null) => (v === null ? null : new Date(v).toISOString())
    const body: HistoryExportResponse = {
      sessions: sessions.rows.map((r) => ({ ...r, startedAt: iso(r.startedAt)!, closedAt: iso(r.closedAt) })),
      samples: samples.rows.map((r) => ({ ...r, recordedAt: iso(r.recordedAt)! })),
      measurements: measurements.rows,
      defects: defects.rows,
    }
    res.json(body)
  })

  /**
   * §6 — what the History filters may offer: every inspector who ever opened
   * a session and every machine that ever ran one. Drawn from the record
   * itself, so a filter is never limited to the page on screen.
   */
  r.get('/history/options', async (req, res) => {
    requireUser(req)
    const [inspectors, machines, items] = await Promise.all([
      db.query<{ id: string; name: string }>(
        // Whoever opened a session or recorded a sample in one, named as they
        // were most recently.
        `SELECT DISTINCT ON (id) id, name FROM (
           SELECT s.inspector_id AS id, s.inspector_name AS name, s.started_at AS at
             FROM inspection_sessions s WHERE s.deleted_at IS NULL
           UNION ALL
           SELECT x.inspector_id, x.inspector_name, x.created_at
             FROM inspection_samples x JOIN inspection_sessions s ON s.id = x.session_id AND s.deleted_at IS NULL
            WHERE x.deleted_at IS NULL) w
          ORDER BY id, at DESC`,
      ),
      db.query<{ code: string }>(
        `SELECT DISTINCT s.work_center_code AS code
           FROM inspection_sessions s WHERE s.deleted_at IS NULL AND btrim(s.work_center_code) <> ''`,
      ),
      // The items that were inspected: one row per code, named as its latest session's line names it.
      db.query<{ itemCode: string; item: string }>(
        `SELECT DISTINCT ON (lower(btrim(o.item_code))) btrim(o.item_code) AS "itemCode", btrim(o.item) AS item
           FROM inspection_sessions s JOIN production_orders o ON o.id = s.order_id
          WHERE s.deleted_at IS NULL AND btrim(o.item_code) <> ''
          ORDER BY lower(btrim(o.item_code)), s.started_at DESC`,
      ),
    ])
    const body: HistoryOptionsResponse = {
      inspectors: inspectors.rows.sort((a, b) => a.name.localeCompare(b.name)),
      workCenterCodes: machines.rows.map((m) => m.code).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
      items: items.rows,
    }
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

  /**
   * §10.8 — every photo taken in the session, in one answer, grouped by what
   * it shows, so a reader sees them all without opening sample after sample.
   * Only live rows: a deleted sample, defect, note or image takes its photos
   * with it.
   */
  r.get('/:id/images', async (req, res) => {
    const id = parse(uuid, req.params.id)
    const session = await loadSessionWithOrder(db, id)
    if (!session) throw notFound('That session')
    const { rows } = await db.query<SessionImageItem & { kind: SessionImageKind }>(
      `SELECT 'defect'::text AS kind, i.id AS "imageId", sm.id AS "sampleId", sm.index AS "sampleIndex", d.defect_name AS label, i.uploaded_at AS "takenAt", di.position
         FROM defect_images di
         JOIN defect_results d ON d.id = di.defect_id AND d.deleted_at IS NULL
         JOIN inspection_samples sm ON sm.id = d.sample_id AND sm.deleted_at IS NULL
         JOIN images i ON i.id = di.image_id AND i.deleted_at IS NULL
        WHERE sm.session_id = $1
       UNION ALL
       SELECT 'paint', i.id, sm.id, sm.index, 'Paint', i.uploaded_at, pi.position
         FROM paint_sample_images pi
         JOIN paint_samples ps ON ps.id = pi.paint_sample_id AND ps.deleted_at IS NULL
         JOIN inspection_samples sm ON sm.id = ps.sample_id AND sm.deleted_at IS NULL
         JOIN images i ON i.id = pi.image_id AND i.deleted_at IS NULL
        WHERE sm.session_id = $1
       UNION ALL
       SELECT 'pt', i.id, sm.id, sm.index, 'PT / weld', i.uploaded_at, pti.position
         FROM pt_record_images pti
         JOIN pt_records pr ON pr.id = pti.pt_record_id AND pr.deleted_at IS NULL
         JOIN inspection_samples sm ON sm.id = pr.sample_id AND sm.deleted_at IS NULL
         JOIN images i ON i.id = pti.image_id AND i.deleted_at IS NULL
        WHERE sm.session_id = $1
       UNION ALL
       SELECT 'note', i.id, sm.id, sm.index, left(n.text, 80), i.uploaded_at, ni.position
         FROM session_note_images ni
         JOIN session_notes n ON n.id = ni.note_id AND n.deleted_at IS NULL
         LEFT JOIN inspection_samples sm ON sm.id = n.sample_id AND sm.deleted_at IS NULL
         JOIN images i ON i.id = ni.image_id AND i.deleted_at IS NULL
        WHERE n.session_id = $1
       ORDER BY "sampleIndex" NULLS LAST, "takenAt", position`,
      [id],
    )
    const order: SessionImageKind[] = ['defect', 'paint', 'pt', 'note']
    const groups: SessionImageGroup[] = order
      .map((kind) => ({ kind, items: rows.filter((r) => r.kind === kind).map(({ kind: _k, ...item }) => item) }))
      .filter((g) => g.items.length > 0)
    const body: SessionImagesResponse = { groups, total: rows.length }
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

  /** §4 — what the close asks of a session on a universal machine: its stage, when the line already has a session. */
  r.get('/:id/stages', async (req, res) => {
    requireUser(req)
    const id = parse(uuid, req.params.id)
    const session = await loadSessionWithOrder(db, id)
    if (!session) throw notFound('That session')
    const { universal: _universal, ...body } = await stageOptions(db, session)
    res.json(body satisfies SessionStagesResponse)
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
      // The defect quantities are the defective pieces of the batch, so the batch cannot be smaller than them.
      // The final quantity is the good production; the rejected pieces were made on top of it, so no floor applies.
      // On a universal machine the session is a stage of its line: the first is stage 1, a later one says which.
      const options = await stageOptions(tx, before)
      let stage: number | null = null
      if (options.universal) {
        if (!options.asks) stage = 1
        else {
          if (body.stage === undefined) throw badRequest('This item already has a session on this machine: choose the stage this one was.')
          if (body.stage > options.next) throw badRequest(`The stage can be at most ${options.next}: one of the item's stages, or the next one.`)
          stage = body.stage
        }
      }
      await tx.query(
        `UPDATE inspection_sessions SET status = 'Closed', final_qty = $2, stage = $4, closed_at = now(), closed_by_id = $3, version = version + 1 WHERE id = $1`,
        [id, body.finalQty, user.id, stage],
      )
      const after = (await loadSessionWithOrder(tx, id))!
      await auditChanges(
        tx,
        auditCtxFor(user, before, 'InspectionSession', id),
        { status: before.status, finalQty: before.finalQty, stage: before.stage ?? null, closedAt: before.closedAt, closedById: before.closedById },
        { status: after.status, finalQty: after.finalQty, stage: after.stage ?? null, closedAt: after.closedAt, closedById: after.closedById },
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

  /**
   * §4 — correct a session's quantities after the fact. The quantity rejected
   * before release is typed when an order session opens, the quantity produced
   * when a stock session opens, and the final quantity when a session closes;
   * each is as mis-keyed as any other figure. An open session's are corrected
   * by its inspector (or anyone who may edit open sessions); a closed session's
   * by whoever may edit closed records. Every change is written to the audit
   * log, and the rejected quantity is re-attributed to whoever corrected it.
   */
  r.patch('/:id/quantities', requireCapability('record-inspection'), async (req, res) => {
    const user = requireUser(req)
    const id = parse(uuid, req.params.id)
    const body = parse(quantitiesSchema, req.body)
    const updated = await withTransaction(db, async (tx) => {
      const before = await loadSessionWithOrder(tx, id, true)
      if (!before) throw notFound('That session')
      if (before.version !== body.version) throw new ConflictError(before)
      const may = before.status === 'Open' ? before.inspectorId === user.id || can(user.role, 'edit-open-session') : can(user.role, 'edit-closed-session')
      if (!may) throw forbidden()
      const stock = isStockOrder(before.order)
      if (body.startQty !== undefined && stock) throw badRequest('A make-to-stock session has no rejected quantity before release.')
      if (body.producedQty !== undefined && !stock) throw badRequest('Only a make-to-stock session has a quantity produced.')
      if (body.finalQty !== undefined && before.status !== 'Closed') throw badRequest('The final quantity is recorded when the session closes.')
      if (body.stage !== undefined) {
        if (before.status !== 'Closed') throw badRequest('The stage is given when the session closes.')
        const options = await stageOptions(tx, before)
        if (!options.universal) throw badRequest('Only a session on a universal machine has a stage.')
        if (body.stage > options.next) throw badRequest(`The stage can be at most ${options.next}: one of the item's stages, or the next one.`)
      }
      const sets: string[] = ['version = version + 1']
      const params: unknown[] = [id]
      const p = (v: unknown) => `$${params.push(v)}`
      if (body.startQty !== undefined) sets.push(`start_qty = ${p(body.startQty)}, start_qty_by_id = ${p(user.id)}, start_qty_by_name = ${p(user.name)}, start_qty_at = now()`)
      if (body.producedQty !== undefined) sets.push(`produced_qty = ${p(body.producedQty)}`)
      if (body.finalQty !== undefined) sets.push(`final_qty = ${p(body.finalQty)}`)
      if (body.stage !== undefined) sets.push(`stage = ${p(body.stage)}`)
      await tx.query(`UPDATE inspection_sessions SET ${sets.join(', ')} WHERE id = $1`, params)

      const after = (await loadSessionWithOrder(tx, id))!
      await auditChanges(
        tx,
        auditCtxFor(user, before, 'InspectionSession', id),
        { startQty: before.startQtyConfirmed?.qty ?? null, producedQty: before.producedQty ?? null, finalQty: before.finalQty ?? null, stage: before.stage ?? null },
        { startQty: after.startQtyConfirmed?.qty ?? null, producedQty: after.producedQty ?? null, finalQty: after.finalQty ?? null, stage: after.stage ?? null },
      )
      return after
    })
    res.json(updated)
  })

  return r
}

/**
 * §4 — the stages a session on a universal machine may be given. One line (an
 * item of an order on the machine) passes through several stages, a session
 * each: the first session on the line is stage 1 without asking; a later one
 * is given one of the line's stages or the next one when it closes. A
 * make-to-stock line has no stages. A sibling recorded before stages existed
 * counts as stage 1.
 */
async function stageOptions(tx: Queryable, session: SessionWithOrder): Promise<SessionStagesResponse & { universal: boolean }> {
  const none = { universal: false, asks: false, stages: [], next: 1 }
  if (isStockOrder(session.order)) return none
  const machine = (await tx.query<{ process: string }>(
    `SELECT process FROM machines WHERE lower(code) = lower($1) AND deleted_at IS NULL ORDER BY created_at LIMIT 1`,
    [session.workCenterCode],
  )).rows[0]
  if (machine?.process !== 'universal') return none
  const { rows } = await tx.query<{ stage: number; n: number }>(
    `SELECT COALESCE(stage, 1)::int AS stage, count(*)::int AS n FROM inspection_sessions
      WHERE order_id = $1 AND id <> $2 AND deleted_at IS NULL GROUP BY 1 ORDER BY 1`,
    [session.orderId, session.id],
  )
  const stages = rows.map((r) => ({ stage: r.stage, sessions: r.n }))
  return { universal: true, asks: stages.length > 0, stages, next: Math.max(0, ...stages.map((x) => x.stage)) + 1 }
}

/** §6 — what History narrows by. The export reads the same filters. */
const historyFilterSchema = z.object({
  disposition: z.enum(DISPOSITIONS as unknown as [string, ...string[]]).optional(),
  /** Free text over the order, the item, the customer, the inspector,
   *  the machine and the session number. */
  q: z.string().trim().max(120).optional(),
  status: z.enum(['Open', 'Closed']).optional(),
  workCenterCode: z.string().trim().max(60).optional(),
  item: z.string().trim().max(120).optional(),
  factory: z.string().trim().max(120).optional(),
  inspectorId: z.string().uuid().optional(),
  since: z.string().datetime({ offset: true }).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a day, YYYY-MM-DD').optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a day, YYYY-MM-DD').optional(),
})

/**
 * History's filters as SQL over inspection_sessions `s` joined to its order
 * line `o`: the clause and its parameters, to which a caller may add more.
 */
function historyWhere(q: z.infer<typeof historyFilterSchema>, tz: string): { where: string; params: unknown[] } {
  // The filters, as SQL over the whole table. They are built here — not
  // applied to a page already fetched — so a session that matches is found
  // wherever it sits in the record.
  const clauses = ['s.deleted_at IS NULL']
  const params: unknown[] = []
  const p = (v: unknown) => `$${params.push(v)}`

  if (q.disposition) {
    clauses.push(`EXISTS (SELECT 1 FROM inspection_samples sm
                            JOIN defect_results d ON d.sample_id = sm.id AND d.deleted_at IS NULL
                           WHERE sm.session_id = s.id AND sm.deleted_at IS NULL AND d.disposition::text = ${p(q.disposition)})`)
  }
  if (q.status) clauses.push(`s.status = ${p(q.status)}`)
  if (q.inspectorId) {
    // Two inspectors may share a session (§4.4): the one who opened it and
    // any who recorded a sample in it. A filter by inspector finds both —
    // otherwise a sample recorded in a colleague's session is on the
    // dashboard under this name and nowhere to be found in History.
    const who = p(q.inspectorId)
    clauses.push(`(s.inspector_id = ${who}::uuid OR EXISTS (
                    SELECT 1 FROM inspection_samples x WHERE x.session_id = s.id AND x.deleted_at IS NULL AND x.inspector_id = ${who}::uuid))`)
  }
  if (q.since) {
    // A session started earlier but still being sampled is part of this
    // period too: the dashboard puts a sample on the day it was recorded,
    // so History must land on the same session for the same date range.
    const since = p(q.since)
    clauses.push(`(s.started_at >= ${since}::timestamptz OR EXISTS (
                    SELECT 1 FROM inspection_samples x WHERE x.session_id = s.id AND x.deleted_at IS NULL AND x.created_at >= ${since}::timestamptz))`)
  }
  if (q.from || q.to) {
    // Factory days, both ends inclusive, in the factory's zone — the same
    // reading of a day the dashboard uses. A session is in the range when it
    // started in it or a sample was recorded in it.
    if (q.from && q.to && q.from > q.to) throw badRequest('The range ends before it starts.')
    const zone = p(tz)
    const start = q.from ? `(${p(q.from)}::date)::timestamp AT TIME ZONE ${zone}` : null
    const end = q.to ? `((${p(q.to)}::date + 1)::timestamp) AT TIME ZONE ${zone}` : null
    const within = (col: string) => [start && `${col} >= ${start}`, end && `${col} < ${end}`].filter(Boolean).join(' AND ')
    clauses.push(`(${within('s.started_at')} OR EXISTS (
                    SELECT 1 FROM inspection_samples x WHERE x.session_id = s.id AND x.deleted_at IS NULL AND ${within('x.created_at')}))`)
  }
  if (q.workCenterCode) {
    // "STAM 24", "stam24" and "024" all name the same machine on the floor.
    clauses.push(`${NORMALISED_CODE('s.work_center_code')} = ${NORMALISED_CODE(p(q.workCenterCode) + '::text')}`)
  }
  if (q.factory) {
    clauses.push(`EXISTS (SELECT 1 FROM machines m
                           WHERE m.deleted_at IS NULL AND lower(btrim(COALESCE(m.factory, ''))) = lower(btrim(${p(q.factory)}))
                             AND ${NORMALISED_CODE('m.code')} = ${NORMALISED_CODE('s.work_center_code')})`)
  }
  if (q.item) {
    // Any part of the code or the name, as typed: no need to pick one from the list.
    const t = p(`%${q.item.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
    clauses.push(`(o.item_code ILIKE ${t} OR o.item ILIKE ${t})`)
  }
  if (q.q) {
    // A literal search: the wildcards a person types are text, not pattern.
    const like = `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    const t = p(like)
    const seq = /^#?\d+$/.test(q.q) ? Number(q.q.replace('#', '')) : null
    clauses.push(`(o.order_number ILIKE ${t} OR o.item ILIKE ${t} OR o.item_code ILIKE ${t} OR o.customer ILIKE ${t}
                   OR s.inspector_name ILIKE ${t} OR s.work_center_code ILIKE ${t}
                   OR EXISTS (SELECT 1 FROM inspection_samples x WHERE x.session_id = s.id AND x.deleted_at IS NULL AND x.inspector_name ILIKE ${t})
                   OR EXISTS (SELECT 1 FROM machines m
                               WHERE m.deleted_at IS NULL AND ${NORMALISED_CODE('m.code')} = ${NORMALISED_CODE('s.work_center_code')}
                                 AND (m.display_name ILIKE ${t} OR m.name ILIKE ${t} OR m.line ILIKE ${t}))
                   OR (${p(seq)}::int IS NOT NULL AND s.seq = ${p(seq)}::int))`)
  }

  return { where: clauses.join(' AND '), params }
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
      [sampleId, pt.testFrequencyPct ?? null, pt.consumableLots.Cleaner, pt.consumableLots.Penetrant, pt.consumableLots.Developer, pt.weldingWireBatch ?? null, verdict, pt.notes ?? null],
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
