// ============================================================================
// The queries behind the quality dashboard (§15). Every figure comes from the
// inspection records as written: a sample is the unit, a period is a range
// of factory days, and the filters narrow the samples before anything is
// counted. The same CTE feeds every query so the totals, the groupings and
// the trend all agree with one another.
// ============================================================================

import type { Disposition, ShiftLetter } from '@qc/shared/types'
import { PAINT_THICKNESS_NAME } from '@qc/shared/rules'
import type {
  KpiDailyPoint,
  KpiDimensionRow,
  KpiGroupRow,
  KpiHoldRow,
  KpiIdleMachine,
  KpiParetoRow,
  KpiSupplierRow,
  KpiTotals,
  KpiWireBatchRow,
} from '@qc/shared/kpi'
import { capability, pct } from '@qc/shared/kpi'
import type { Queryable } from '../db/pool'

export interface PeriodFilters {
  tz: string
  /** Inclusive factory day, YYYY-MM-DD. */
  from: string
  /** Inclusive factory day, YYYY-MM-DD. */
  to: string
  factory?: string
  workCenterCode?: string
  itemCode?: string
  inspectorId?: string
  shift?: ShiftLetter
}

/**
 * $1 tz · $2 from · $3 to · $4 factory · $5 machine · $6 item code ·
 * $7 inspector · $8 shift. Days are turned into instants in the factory's
 * zone here, so "the 3rd" means the 3rd on the floor, not in UTC.
 */
function params(f: PeriodFilters): unknown[] {
  return [f.tz, f.from, f.to, f.factory ?? null, f.workCenterCode ?? null, f.itemCode ?? null, f.inspectorId ?? null, f.shift ?? null]
}

/** The samples of the period that pass the filters, with what each one recorded. */
const BASE = `
WITH base AS (
  SELECT sm.id AS sample_id, sm.session_id, sm.order_id, sm.created_at, sm.shift, sm.inspector_id, sm.inspector_name,
         sm.sample_qty, sm.grade_ack_at,
         s.work_center_code AS wc, COALESCE(m.factory, '') AS factory, COALESCE(m.display_name, 'Machine ' || s.work_center_code) AS machine_label,
         o.item_code, o.item, o.order_number, o.customer
    FROM inspection_samples sm
    JOIN inspection_sessions s ON s.id = sm.session_id AND s.deleted_at IS NULL
    JOIN production_orders o ON o.id = sm.order_id
    LEFT JOIN LATERAL (
      SELECT m.factory, m.display_name FROM machines m
       WHERE lower(m.code) = lower(s.work_center_code) AND m.deleted_at IS NULL
       ORDER BY m.created_at LIMIT 1) m ON true
   WHERE sm.deleted_at IS NULL
     AND sm.created_at >= ($2::date)::timestamp AT TIME ZONE $1
     AND sm.created_at <  (($3::date + 1)::timestamp) AT TIME ZONE $1
     AND ($4::text IS NULL OR COALESCE(m.factory, '') = $4)
     AND ($5::text IS NULL OR lower(s.work_center_code) = lower($5))
     AND ($6::text IS NULL OR lower(o.item_code) = lower($6))
     AND ($7::uuid IS NULL OR sm.inspector_id = $7)
     AND ($8::text IS NULL OR sm.shift::text = $8)
),
per_sample AS (
  SELECT b.*,
         COALESCE((SELECT sum(d.qty) FROM defect_results d WHERE d.sample_id = b.sample_id AND d.deleted_at IS NULL), 0)::float8 AS defect_pieces,
         (SELECT count(*) FROM defect_results d WHERE d.sample_id = b.sample_id AND d.deleted_at IS NULL)::int AS defect_records,
         (SELECT count(*) FROM dimension_results r WHERE r.sample_id = b.sample_id AND r.deleted_at IS NULL AND r.actual IS NOT NULL)::int AS dims_measured,
         (SELECT count(*) FROM dimension_results r WHERE r.sample_id = b.sample_id AND r.deleted_at IS NULL AND r.status = 'Fail')::int AS dims_fail
    FROM base b
)`

interface TotalsRow {
  sessions: number
  samples: number
  pieces: number
  defectPieces: number
  defectRecords: number
  firstPass: number
  dimsMeasured: number
  dimsFail: number
  dimsWarning: number
  dimsPass: number
  activeInspectors: number
  machines: number
  ptTested: number
  ptRejected: number
  paintReadings: number
  paintMean: number | null
  paintMin: number | null
}

export async function loadTotals(q: Queryable, f: PeriodFilters): Promise<KpiTotals> {
  const p = params(f)
  const [agg, dispositions, sessions] = await Promise.all([
    q.query<TotalsRow>(
      `${BASE}
       SELECT (SELECT count(DISTINCT session_id) FROM per_sample)::int AS sessions,
              (SELECT count(*) FROM per_sample)::int AS samples,
              (SELECT COALESCE(sum(sample_qty), 0) FROM per_sample)::float8 AS pieces,
              (SELECT COALESCE(sum(defect_pieces), 0) FROM per_sample)::float8 AS "defectPieces",
              (SELECT COALESCE(sum(defect_records), 0) FROM per_sample)::int AS "defectRecords",
              (SELECT count(*) FROM per_sample WHERE defect_pieces = 0 AND dims_fail = 0)::int AS "firstPass",
              (SELECT COALESCE(sum(dims_measured), 0) FROM per_sample)::int AS "dimsMeasured",
              (SELECT COALESCE(sum(dims_fail), 0) FROM per_sample)::int AS "dimsFail",
              (SELECT count(*) FROM dimension_results r JOIN base b ON b.sample_id = r.sample_id
                WHERE r.deleted_at IS NULL AND r.actual IS NOT NULL AND r.status = 'Warning')::int AS "dimsWarning",
              (SELECT count(*) FROM dimension_results r JOIN base b ON b.sample_id = r.sample_id
                WHERE r.deleted_at IS NULL AND r.actual IS NOT NULL AND r.status = 'Pass')::int AS "dimsPass",
              (SELECT count(DISTINCT inspector_id) FROM per_sample)::int AS "activeInspectors",
              (SELECT count(DISTINCT lower(wc)) FROM per_sample)::int AS machines,
              (SELECT count(*) FROM pt_tested_lengths l JOIN pt_records pr ON pr.id = l.pt_record_id AND pr.deleted_at IS NULL
                 JOIN base b ON b.sample_id = pr.sample_id WHERE l.deleted_at IS NULL)::int AS "ptTested",
              (SELECT count(*) FROM pt_tested_lengths l JOIN pt_records pr ON pr.id = l.pt_record_id AND pr.deleted_at IS NULL
                 JOIN base b ON b.sample_id = pr.sample_id WHERE l.deleted_at IS NULL AND l.verdict = 'Reject / Repair')::int AS "ptRejected",
              (SELECT count(*) FROM dimension_results r JOIN base b ON b.sample_id = r.sample_id
                WHERE r.deleted_at IS NULL AND r.actual IS NOT NULL AND lower(r.name) = lower($9))::int AS "paintReadings",
              (SELECT avg(r.actual) FROM dimension_results r JOIN base b ON b.sample_id = r.sample_id
                WHERE r.deleted_at IS NULL AND r.actual IS NOT NULL AND lower(r.name) = lower($9))::float8 AS "paintMean",
              (SELECT min(r.actual) FROM dimension_results r JOIN base b ON b.sample_id = r.sample_id
                WHERE r.deleted_at IS NULL AND r.actual IS NOT NULL AND lower(r.name) = lower($9))::float8 AS "paintMin"`,
      [...p, PAINT_THICKNESS_NAME],
    ),
    q.query<{ disposition: Disposition; pieces: number }>(
      `${BASE}
       SELECT d.disposition, COALESCE(sum(d.qty), 0)::float8 AS pieces
         FROM defect_results d JOIN base b ON b.sample_id = d.sample_id
        WHERE d.deleted_at IS NULL GROUP BY d.disposition`,
      p,
    ),
    // Sessions are counted by when they started; the sample filters that
    // apply to a session (factory, machine, item, inspector) apply here too.
    q.query<{ started: number; closed: number; samples: number }>(
      `SELECT count(*)::int AS started,
              count(*) FILTER (WHERE s.status = 'Closed')::int AS closed,
              COALESCE(sum((SELECT count(*) FROM inspection_samples x WHERE x.session_id = s.id AND x.deleted_at IS NULL)), 0)::int AS samples
         FROM inspection_sessions s
         JOIN production_orders o ON o.id = s.order_id
         LEFT JOIN LATERAL (
           SELECT m.factory FROM machines m WHERE lower(m.code) = lower(s.work_center_code) AND m.deleted_at IS NULL ORDER BY m.created_at LIMIT 1) m ON true
        WHERE s.deleted_at IS NULL
          AND s.started_at >= ($2::date)::timestamp AT TIME ZONE $1
          AND s.started_at <  (($3::date + 1)::timestamp) AT TIME ZONE $1
          AND ($4::text IS NULL OR COALESCE(m.factory, '') = $4)
          AND ($5::text IS NULL OR lower(s.work_center_code) = lower($5))
          AND ($6::text IS NULL OR lower(o.item_code) = lower($6))
          AND ($7::uuid IS NULL OR s.inspector_id = $7)`,
      p.slice(0, 7),
    ),
  ])
  const t = agg.rows[0]
  const byDisposition: Partial<Record<Disposition, number>> = {}
  for (const row of dispositions.rows) byDisposition[row.disposition] = row.pieces
  const started = sessions.rows[0]
  return {
    sessions: started.started,
    samples: t.samples,
    pieces: t.pieces,
    defectPieces: t.defectPieces,
    defectRecords: t.defectRecords,
    defectRatePct: pct(t.defectPieces, t.pieces),
    fpyPct: pct(t.firstPass, t.samples),
    dimensionsMeasured: t.dimsMeasured,
    dimensionsPass: t.dimsPass,
    dimensionsWarning: t.dimsWarning,
    dimensionsFail: t.dimsFail,
    dimFailPct: pct(t.dimsFail, t.dimsMeasured),
    byDisposition,
    ptLengthsTested: t.ptTested,
    ptLengthsRejected: t.ptRejected,
    ptRejectPct: pct(t.ptRejected, t.ptTested),
    paintReadings: t.paintReadings,
    paintMeanMicrons: t.paintMean === null ? null : Math.round(t.paintMean * 10) / 10,
    paintMinMicrons: t.paintMin,
    activeInspectors: t.activeInspectors,
    machinesInspected: t.machines,
    sessionsClosed: started.closed,
    samplesPerSession: started.started > 0 ? Math.round((started.samples / started.started) * 10) / 10 : null,
  }
}

export async function loadDaily(q: Queryable, f: PeriodFilters): Promise<KpiDailyPoint[]> {
  const { rows } = await q.query<{ day: string; samples: number; pieces: number; defectPieces: number; firstPass: number }>(
    `${BASE}
     SELECT to_char((created_at AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS day,
            count(*)::int AS samples, COALESCE(sum(sample_qty), 0)::float8 AS pieces,
            COALESCE(sum(defect_pieces), 0)::float8 AS "defectPieces",
            count(*) FILTER (WHERE defect_pieces = 0 AND dims_fail = 0)::int AS "firstPass"
       FROM per_sample GROUP BY 1 ORDER BY 1`,
    params(f),
  )
  return rows.map((r) => ({
    day: r.day,
    samples: r.samples,
    pieces: r.pieces,
    defectPieces: r.defectPieces,
    defectRatePct: pct(r.defectPieces, r.pieces),
    fpyPct: pct(r.firstPass, r.samples),
  }))
}

export async function loadPareto(q: Queryable, f: PeriodFilters): Promise<KpiParetoRow[]> {
  const { rows } = await q.query<{ defectName: string; pieces: number; records: number }>(
    `${BASE}
     SELECT d.defect_name AS "defectName", COALESCE(sum(d.qty), 0)::float8 AS pieces, count(*)::int AS records
       FROM defect_results d JOIN base b ON b.sample_id = d.sample_id
      WHERE d.deleted_at IS NULL GROUP BY d.defect_name ORDER BY pieces DESC, records DESC LIMIT 15`,
    params(f),
  )
  const total = rows.reduce((n, r) => n + r.pieces, 0)
  let running = 0
  return rows.map((r) => {
    running += r.pieces
    return { ...r, sharePct: pct(r.pieces, total) ?? 0, cumulativePct: pct(running, total) ?? 0 }
  })
}

type GroupKind = 'machine' | 'inspector' | 'shift' | 'item'

/** `group` decides what one row is; `key` is the value the client links with. */
const GROUP_KEYS: Record<GroupKind, { group: string; key: string; label: string; sub: string }> = {
  machine: { group: 'lower(wc)', key: 'max(wc)', label: 'max(machine_label)', sub: 'max(factory)' },
  inspector: { group: 'inspector_id::text', key: 'inspector_id::text', label: 'max(inspector_name)', sub: `''` },
  shift: { group: 'shift::text', key: 'shift::text', label: 'shift::text', sub: `''` },
  item: { group: 'lower(item_code)', key: 'max(item_code)', label: 'max(item)', sub: 'max(item_code)' },
}

export async function loadGroups(q: Queryable, f: PeriodFilters, kind: GroupKind, limit = 25): Promise<KpiGroupRow[]> {
  const g = GROUP_KEYS[kind]
  const { rows } = await q.query<{
    key: string
    label: string
    sub: string
    sessions: number
    samples: number
    pieces: number
    defectPieces: number
    firstPass: number
    dimsMeasured: number
    dimsFail: number
  }>(
    `${BASE}
     SELECT ${g.key} AS key, ${g.label} AS label, ${g.sub} AS sub,
            count(DISTINCT session_id)::int AS sessions, count(*)::int AS samples, COALESCE(sum(sample_qty), 0)::float8 AS pieces,
            COALESCE(sum(defect_pieces), 0)::float8 AS "defectPieces",
            count(*) FILTER (WHERE defect_pieces = 0 AND dims_fail = 0)::int AS "firstPass",
            COALESCE(sum(dims_measured), 0)::int AS "dimsMeasured", COALESCE(sum(dims_fail), 0)::int AS "dimsFail"
       FROM per_sample GROUP BY ${g.group} ORDER BY samples DESC, key LIMIT ${limit}`,
    params(f),
  )
  return rows.map((r) => ({
    key: r.key,
    label: r.label,
    sub: r.sub || undefined,
    sessions: r.sessions,
    samples: r.samples,
    pieces: r.pieces,
    defectPieces: r.defectPieces,
    defectRatePct: pct(r.defectPieces, r.pieces),
    fpyPct: pct(r.firstPass, r.samples),
    dimFailPct: pct(r.dimsFail, r.dimsMeasured),
  }))
}

export async function loadDimensions(q: Queryable, f: PeriodFilters, minReadingsForCpk: number): Promise<KpiDimensionRow[]> {
  const { rows } = await q.query<{
    itemCode: string
    item: string
    name: string
    unit: string
    readings: number
    mean: number
    stdDev: number | null
    nominal: number | null
    tolPlus: number | null
    tolMinus: number | null
    pass: number
    fail: number
  }>(
    `${BASE}
     SELECT b.item_code AS "itemCode", max(b.item) AS item, r.name, max(r.unit) AS unit,
            count(*)::int AS readings, avg(r.actual)::float8 AS mean, stddev_samp(r.actual)::float8 AS "stdDev",
            avg(r.nominal)::float8 AS nominal, avg(r.tol_plus)::float8 AS "tolPlus", avg(r.tol_minus)::float8 AS "tolMinus",
            count(*) FILTER (WHERE r.status = 'Pass')::int AS pass, count(*) FILTER (WHERE r.status = 'Fail')::int AS fail
       FROM dimension_results r JOIN base b ON b.sample_id = r.sample_id
      WHERE r.deleted_at IS NULL AND r.actual IS NOT NULL AND r.nominal IS NOT NULL AND lower(r.name) <> lower($9)
      GROUP BY b.item_code, r.name
     HAVING count(*) >= 3
      ORDER BY readings DESC LIMIT 60`,
    [...params(f), PAINT_THICKNESS_NAME],
  )
  const out = rows.map((r): KpiDimensionRow => {
    const cap = r.readings >= minReadingsForCpk ? capability(r) : { cp: null, cpk: null, centering: capability(r).centering }
    return {
      itemCode: r.itemCode,
      item: r.item,
      name: r.name,
      unit: r.unit,
      readings: r.readings,
      mean: Math.round(r.mean * 1000) / 1000,
      stdDev: r.stdDev === null ? null : Math.round(r.stdDev * 1000) / 1000,
      nominal: r.nominal,
      tolPlus: r.tolPlus,
      tolMinus: r.tolMinus,
      cp: cap.cp,
      cpk: cap.cpk,
      passPct: pct(r.pass, r.readings) ?? 0,
      failPct: pct(r.fail, r.readings) ?? 0,
      centering: cap.centering === null ? null : Math.round(cap.centering * 100) / 100,
    }
  })
  // The dimensions that need attention first: a known Cpk, lowest first; then by fail rate.
  return out.sort((a, b) => {
    if (a.cpk !== null && b.cpk !== null) return a.cpk - b.cpk
    if (a.cpk !== null) return -1
    if (b.cpk !== null) return 1
    return b.failPct - a.failPct || b.readings - a.readings
  })
}

export async function loadSuppliers(q: Queryable, f: PeriodFilters): Promise<KpiSupplierRow[]> {
  const { rows } = await q.query<{ supplier: string; grade: string; samples: number; pieces: number; defectPieces: number }>(
    `${BASE},
     coil_samples AS (
       SELECT DISTINCT c.sample_id, COALESCE(NULLIF(btrim(c.supplier), ''), '(unknown supplier)') AS supplier,
                       COALESCE(NULLIF(btrim(c.grade), ''), '—') AS grade
         FROM sample_coils c JOIN base b ON b.sample_id = c.sample_id WHERE c.deleted_at IS NULL)
     SELECT cs.supplier, cs.grade, count(*)::int AS samples, COALESCE(sum(ps.sample_qty), 0)::float8 AS pieces,
            COALESCE(sum(ps.defect_pieces), 0)::float8 AS "defectPieces"
       FROM coil_samples cs JOIN per_sample ps ON ps.sample_id = cs.sample_id
      GROUP BY 1, 2 ORDER BY samples DESC LIMIT 15`,
    params(f),
  )
  return rows.map((r) => ({ ...r, defectRatePct: pct(r.defectPieces, r.pieces) }))
}

export async function loadWireBatches(q: Queryable, f: PeriodFilters): Promise<KpiWireBatchRow[]> {
  const { rows } = await q.query<{ batch: string; lengthsTested: number; lengthsRejected: number }>(
    `${BASE}
     SELECT COALESCE(NULLIF(btrim(pr.welding_wire_batch), ''), '(no batch)') AS batch,
            count(*)::int AS "lengthsTested", count(*) FILTER (WHERE l.verdict = 'Reject / Repair')::int AS "lengthsRejected"
       FROM pt_records pr JOIN base b ON b.sample_id = pr.sample_id
       JOIN pt_tested_lengths l ON l.pt_record_id = pr.id AND l.deleted_at IS NULL
      WHERE pr.deleted_at IS NULL GROUP BY 1 ORDER BY "lengthsTested" DESC LIMIT 15`,
    params(f),
  )
  return rows.map((r) => ({ ...r, rejectPct: pct(r.lengthsRejected, r.lengthsTested) }))
}

/** Defects on Hold right now — not a period figure: a Hold is open until someone decides. */
export async function loadHolds(q: Queryable, f: PeriodFilters): Promise<KpiHoldRow[]> {
  const { rows } = await q.query<KpiHoldRow>(
    `SELECT d.id AS "defectId", sm.session_id AS "sessionId", sm.id AS "sampleId", o.order_number AS "orderNumber", o.item,
            s.work_center_code AS "workCenterCode", d.defect_name AS "defectName", d.qty::float8 AS qty,
            floor(EXTRACT(EPOCH FROM (now() - sm.created_at)) / 86400)::int AS "ageDays"
       FROM defect_results d
       JOIN inspection_samples sm ON sm.id = d.sample_id AND sm.deleted_at IS NULL
       JOIN inspection_sessions s ON s.id = sm.session_id AND s.deleted_at IS NULL
       JOIN production_orders o ON o.id = sm.order_id
       LEFT JOIN LATERAL (
         SELECT m.factory FROM machines m WHERE lower(m.code) = lower(s.work_center_code) AND m.deleted_at IS NULL ORDER BY m.created_at LIMIT 1) m ON true
      WHERE d.deleted_at IS NULL AND d.disposition = 'Hold'
        AND ($1::text IS NULL OR COALESCE(m.factory, '') = $1)
        AND ($2::text IS NULL OR lower(s.work_center_code) = lower($2))
        AND ($3::text IS NULL OR lower(o.item_code) = lower($3))
        AND ($4::uuid IS NULL OR sm.inspector_id = $4)
      ORDER BY sm.created_at LIMIT 50`,
    [f.factory ?? null, f.workCenterCode ?? null, f.itemCode ?? null, f.inspectorId ?? null],
  )
  return rows
}

/** Machines with open order lines and no recent sample: work that is not being inspected. */
export async function loadIdleMachines(q: Queryable, f: PeriodFilters, idleDays: number): Promise<KpiIdleMachine[]> {
  const { rows } = await q.query<KpiIdleMachine>(
    `SELECT m.code AS "workCenterCode", m.display_name AS label, COALESCE(m.factory, '') AS factory,
            (SELECT count(*) FROM production_orders o
              WHERE o.deleted_at IS NULL AND lower(o.work_center_code) = lower(m.code)
                AND lower(o.erp_status) <> 'cancel' AND o.required_qty > o.finished_qty)::int AS "openLines",
            (SELECT floor(EXTRACT(EPOCH FROM (now() - max(sm.created_at))) / 86400)::int
               FROM inspection_samples sm JOIN inspection_sessions s ON s.id = sm.session_id AND s.deleted_at IS NULL
              WHERE sm.deleted_at IS NULL AND lower(s.work_center_code) = lower(m.code)) AS "daysSinceSample"
       FROM machines m
      WHERE m.deleted_at IS NULL
        AND ($1::text IS NULL OR COALESCE(m.factory, '') = $1)
        AND ($2::text IS NULL OR lower(m.code) = lower($2))
      ORDER BY m.factory, m.code`,
    [f.factory ?? null, f.workCenterCode ?? null],
  )
  return rows.filter((r) => r.openLines > 0 && (r.daysSinceSample === null || r.daysSinceSample >= idleDays))
}

export interface DisciplineRaw {
  closedWithoutFinalQty: number
  samplesReRecorded: number
  corrections: number
  sessionsDiscarded: number
  coilsUsed: number
  coilsTyped: number
  gradeAcknowledgements: number
  notes: number
  emptyOpenSessions: number
  openLines: number
  openLinesInspected: number
}

export async function loadDiscipline(q: Queryable, f: PeriodFilters): Promise<DisciplineRaw> {
  const p = params(f)
  const [fromBase, sessionsRow, auditRow, linesRow] = await Promise.all([
    q.query<{ coilsUsed: number; coilsTyped: number; gradeAcks: number; notes: number; linesInspected: number }>(
      `${BASE}
       SELECT (SELECT count(*) FROM sample_coils c JOIN base b ON b.sample_id = c.sample_id WHERE c.deleted_at IS NULL)::int AS "coilsUsed",
              (SELECT count(*) FROM sample_coils c JOIN base b ON b.sample_id = c.sample_id WHERE c.deleted_at IS NULL AND c.coil_id IS NULL)::int AS "coilsTyped",
              (SELECT count(*) FROM base WHERE grade_ack_at IS NOT NULL)::int AS "gradeAcks",
              (SELECT count(*) FROM session_notes n JOIN inspection_sessions s ON s.id = n.session_id
                WHERE n.deleted_at IS NULL AND s.id IN (SELECT DISTINCT session_id FROM base)
                  AND n.created_at >= ($2::date)::timestamp AT TIME ZONE $1
                  AND n.created_at <  (($3::date + 1)::timestamp) AT TIME ZONE $1)::int AS notes,
              (SELECT count(DISTINCT order_id) FROM base)::int AS "linesInspected"`,
      p,
    ),
    q.query<{ closedNoFinal: number; emptyOpen: number }>(
      `SELECT count(*) FILTER (WHERE s.status = 'Closed' AND s.final_qty IS NULL
                AND s.closed_at >= ($2::date)::timestamp AT TIME ZONE $1
                AND s.closed_at <  (($3::date + 1)::timestamp) AT TIME ZONE $1)::int AS "closedNoFinal",
              count(*) FILTER (WHERE s.status = 'Open'
                AND NOT EXISTS (SELECT 1 FROM inspection_samples x WHERE x.session_id = s.id AND x.deleted_at IS NULL))::int AS "emptyOpen"
         FROM inspection_sessions s
         JOIN production_orders o ON o.id = s.order_id
         LEFT JOIN LATERAL (
           SELECT m.factory FROM machines m WHERE lower(m.code) = lower(s.work_center_code) AND m.deleted_at IS NULL ORDER BY m.created_at LIMIT 1) m ON true
        WHERE s.deleted_at IS NULL
          AND ($4::text IS NULL OR COALESCE(m.factory, '') = $4)
          AND ($5::text IS NULL OR lower(s.work_center_code) = lower($5))
          AND ($6::text IS NULL OR lower(o.item_code) = lower($6))
          AND ($7::uuid IS NULL OR s.inspector_id = $7)`,
      p.slice(0, 7),
    ),
    // The audit log knows the machine of an entry; the other filters do not apply to it.
    q.query<{ reRecorded: number; corrections: number; discarded: number }>(
      `SELECT count(*) FILTER (WHERE action = 'update' AND entity = 'InspectionSample' AND field = 'reRecorded')::int AS "reRecorded",
              count(*) FILTER (WHERE action = 'update' AND entity IN ('DimensionResult', 'DefectResult'))::int AS corrections,
              count(*) FILTER (WHERE action = 'delete' AND entity = 'InspectionSession' AND new_value LIKE 'Discarded%')::int AS discarded
         FROM audit_log
        WHERE deleted_at IS NULL
          AND at >= ($2::date)::timestamp AT TIME ZONE $1
          AND at <  (($3::date + 1)::timestamp) AT TIME ZONE $1
          AND ($4::text IS NULL OR lower(COALESCE(work_center_code, '')) = lower($4))
          AND ($5::uuid IS NULL OR user_id = $5)`,
      [f.tz, f.from, f.to, f.workCenterCode ?? null, f.inspectorId ?? null],
    ),
    q.query<{ openLines: number }>(
      `SELECT count(*)::int AS "openLines"
         FROM production_orders o
         LEFT JOIN LATERAL (
           SELECT m.factory FROM machines m WHERE lower(m.code) = lower(o.work_center_code) AND m.deleted_at IS NULL ORDER BY m.created_at LIMIT 1) m ON true
        WHERE o.deleted_at IS NULL AND lower(o.erp_status) <> 'cancel' AND o.required_qty > o.finished_qty
          AND ($1::text IS NULL OR COALESCE(m.factory, '') = $1)
          AND ($2::text IS NULL OR lower(o.work_center_code) = lower($2))
          AND ($3::text IS NULL OR lower(o.item_code) = lower($3))`,
      [f.factory ?? null, f.workCenterCode ?? null, f.itemCode ?? null],
    ),
  ])
  const b = fromBase.rows[0]
  return {
    closedWithoutFinalQty: sessionsRow.rows[0].closedNoFinal,
    samplesReRecorded: auditRow.rows[0].reRecorded,
    corrections: auditRow.rows[0].corrections,
    sessionsDiscarded: auditRow.rows[0].discarded,
    coilsUsed: b.coilsUsed,
    coilsTyped: b.coilsTyped,
    gradeAcknowledgements: b.gradeAcks,
    notes: b.notes,
    emptyOpenSessions: sessionsRow.rows[0].emptyOpen,
    openLines: linesRow.rows[0].openLines,
    openLinesInspected: Math.min(b.linesInspected, linesRow.rows[0].openLines),
  }
}
