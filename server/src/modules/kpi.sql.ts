// ============================================================================
// The queries behind the quality dashboard (§15). Every figure comes from the
// inspection records as written: a sample is the unit, a period is a range
// of factory days, and the filters narrow the samples before anything is
// counted. The same CTE feeds every query so the totals, the groupings and
// the trend all agree with one another.
// ============================================================================

import type { Disposition, Process, ShiftLetter } from '@qc/shared/types'
import { PAINT_THICKNESS_NAME } from '@qc/shared/rules'
import type {
  KpiBreakdownDefect,
  KpiBreakdownMonth,
  KpiBreakdownRow,
  KpiDailyPoint,
  KpiDefectDetailRow,
  KpiFactoryTrend,
  KpiFirstPart,
  KpiGroupRow,
  KpiHoldRow,
  KpiInspectorRaw,
  KpiItemDefectRow,
  KpiMachinePareto,
  KpiMachineTrend,
  KpiMonthPoint,
  KpiPaintItemRow,
  KpiParetoRow,
  KpiRateBand,
  KpiSupplierRow,
  KpiTotals,
} from '@qc/shared/kpi'
import { pct, rejectRate } from '@qc/shared/kpi'
import type { Queryable } from '../db/pool'

export interface PeriodFilters {
  tz: string
  /** Inclusive factory day, YYYY-MM-DD. */
  from: string
  /** Inclusive factory day, YYYY-MM-DD. */
  to: string
  factory?: string
  /** A process group from the machine register: only its machines. */
  process?: Process
  /** One or more machine codes; the figures of those machines together. */
  workCenterCodes?: string[]
  itemCode?: string
  inspectorId?: string
  shift?: ShiftLetter
}

/** The machine codes as the SQL wants them: lower-cased, or null for every machine. */
function wcs(f: PeriodFilters): string[] | null {
  const codes = (f.workCenterCodes ?? []).map((c) => c.trim().toLowerCase()).filter(Boolean)
  return codes.length ? codes : null
}

/**
 * $1 tz · $2 from · $3 to · $4 factory · $5 machine · $6 item code ·
 * $7 inspector · $8 shift · $9 process. Days are turned into instants in
 * the factory's zone here, so "the 3rd" means the 3rd on the floor, not in UTC.
 */
function params(f: PeriodFilters): unknown[] {
  return [f.tz, f.from, f.to, f.factory ?? null, wcs(f), f.itemCode ?? null, f.inspectorId ?? null, f.shift ?? null, f.process ?? null]
}

/**
 * The production of the period: sessions closed in it with a final quantity,
 * narrowed by factory, machine and item. Production belongs to a whole
 * session, so an inspector or shift filter leaves this empty. Each session
 * carries the defect pieces of all its samples — the defects of the batch —
 * so the rate is defect pieces per 100 produced.
 */
const PRODUCED = `
produced AS (
  SELECT s.id AS session_id, s.work_center_code AS wc, COALESCE(m.factory, '') AS factory,
         COALESCE(m.display_name, 'Machine ' || s.work_center_code) AS machine_label,
         COALESCE(m.process, 'other') AS process,
         o.item_code, o.item, o.order_number, s.order_id, s.closed_at, s.final_qty::float8 AS produced,
         COALESCE((SELECT sum(d.qty) FROM defect_results d JOIN inspection_samples x ON x.id = d.sample_id
                    WHERE x.session_id = s.id AND x.deleted_at IS NULL AND d.deleted_at IS NULL), 0)::float8 AS defect_pieces
    FROM inspection_sessions s
    JOIN production_orders o ON o.id = s.order_id
    LEFT JOIN LATERAL (
      SELECT m.factory, m.display_name, m.process FROM machines m
       WHERE lower(m.code) = lower(s.work_center_code) AND m.deleted_at IS NULL
       ORDER BY m.created_at LIMIT 1) m ON true
   WHERE s.deleted_at IS NULL AND s.status = 'Closed' AND s.final_qty IS NOT NULL AND s.closed_at IS NOT NULL
     AND s.closed_at >= ($2::date)::timestamp AT TIME ZONE $1
     AND s.closed_at <  (($3::date + 1)::timestamp) AT TIME ZONE $1
     AND ($4::text IS NULL OR COALESCE(m.factory, '') = $4)
     AND ($5::text[] IS NULL OR lower(s.work_center_code) = ANY($5::text[]))
     AND ($6::text IS NULL OR lower(o.item_code) = lower($6))
     AND $7::uuid IS NULL AND $8::text IS NULL
     AND ($9::text IS NULL OR COALESCE(m.process, 'other') = $9)
)`

/** The samples of the period that pass the filters, with what each one recorded. */
const BASE = `
WITH base AS (
  SELECT sm.id AS sample_id, sm.session_id, sm.order_id, sm.created_at, sm.shift, sm.inspector_id, sm.inspector_name,
         sm.sample_qty, sm.grade_ack_at,
         s.work_center_code AS wc, COALESCE(m.factory, '') AS factory, COALESCE(m.display_name, 'Machine ' || s.work_center_code) AS machine_label,
         COALESCE(m.process, 'other') AS process,
         o.item_code, o.item, o.order_number, o.customer
    FROM inspection_samples sm
    JOIN inspection_sessions s ON s.id = sm.session_id AND s.deleted_at IS NULL
    JOIN production_orders o ON o.id = sm.order_id
    LEFT JOIN LATERAL (
      SELECT m.factory, m.display_name, m.process FROM machines m
       WHERE lower(m.code) = lower(s.work_center_code) AND m.deleted_at IS NULL
       ORDER BY m.created_at LIMIT 1) m ON true
   WHERE sm.deleted_at IS NULL
     AND sm.created_at >= ($2::date)::timestamp AT TIME ZONE $1
     AND sm.created_at <  (($3::date + 1)::timestamp) AT TIME ZONE $1
     AND ($4::text IS NULL OR COALESCE(m.factory, '') = $4)
     AND ($5::text[] IS NULL OR lower(s.work_center_code) = ANY($5::text[]))
     AND ($6::text IS NULL OR lower(o.item_code) = lower($6))
     AND ($7::uuid IS NULL OR sm.inspector_id = $7)
     AND ($8::text IS NULL OR sm.shift::text = $8)
     AND ($9::text IS NULL OR COALESCE(m.process, 'other') = $9)
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
  const [agg, dispositions, sessions, production] = await Promise.all([
    q.query<TotalsRow>(
      `${BASE}
       SELECT (SELECT count(DISTINCT session_id) FROM per_sample)::int AS sessions,
              (SELECT count(*) FROM per_sample)::int AS samples,
              (SELECT COALESCE(sum(sample_qty), 0) FROM per_sample)::float8 AS pieces,
              (SELECT COALESCE(sum(defect_pieces), 0) FROM per_sample)::float8 AS "defectPieces",
              (SELECT COALESCE(sum(defect_records), 0) FROM per_sample)::int AS "defectRecords",
              (SELECT count(*) FROM per_sample WHERE defect_pieces = 0)::int AS "firstPass",
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
                WHERE r.deleted_at IS NULL AND r.actual IS NOT NULL AND lower(r.name) = lower($10))::int AS "paintReadings",
              (SELECT avg(r.actual) FROM dimension_results r JOIN base b ON b.sample_id = r.sample_id
                WHERE r.deleted_at IS NULL AND r.actual IS NOT NULL AND lower(r.name) = lower($10))::float8 AS "paintMean",
              (SELECT min(r.actual) FROM dimension_results r JOIN base b ON b.sample_id = r.sample_id
                WHERE r.deleted_at IS NULL AND r.actual IS NOT NULL AND lower(r.name) = lower($10))::float8 AS "paintMin"`,
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
           SELECT m.factory, m.process FROM machines m WHERE lower(m.code) = lower(s.work_center_code) AND m.deleted_at IS NULL ORDER BY m.created_at LIMIT 1) m ON true
        WHERE s.deleted_at IS NULL
          AND s.started_at >= ($2::date)::timestamp AT TIME ZONE $1
          AND s.started_at <  (($3::date + 1)::timestamp) AT TIME ZONE $1
          AND ($4::text IS NULL OR COALESCE(m.factory, '') = $4)
          AND ($5::text[] IS NULL OR lower(s.work_center_code) = ANY($5::text[]))
          AND ($6::text IS NULL OR lower(o.item_code) = lower($6))
          AND ($7::uuid IS NULL OR s.inspector_id = $7)
          AND ($8::text IS NULL OR COALESCE(m.process, 'other') = $8)`,
      [...p.slice(0, 7), f.process ?? null],
    ),
    q.query<{ sessions: number; produced: number; defectPieces: number }>(
      `WITH ${PRODUCED}
       SELECT count(*)::int AS sessions, COALESCE(sum(produced), 0)::float8 AS produced, COALESCE(sum(defect_pieces), 0)::float8 AS "defectPieces" FROM produced`,
      p,
    ),
  ])
  const t = agg.rows[0]
  const byDisposition: Partial<Record<Disposition, number>> = {}
  for (const row of dispositions.rows) byDisposition[row.disposition] = row.pieces
  const started = sessions.rows[0]
  const made = production.rows[0]
  return {
    sessions: started.started,
    samples: t.samples,
    pieces: t.pieces,
    defectPieces: t.defectPieces,
    defectRecords: t.defectRecords,
    piecesProduced: made.produced,
    producedSessions: made.sessions,
    productionDefectPieces: made.defectPieces,
    defectRatePct: rejectRate(made.defectPieces, made.produced),
    inspectedDefectPct: pct(t.defectPieces, t.pieces),
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
  const [sampled, produced] = await Promise.all([
    q.query<{ day: string; samples: number; pieces: number; defectPieces: number; firstPass: number }>(
      `${BASE}
       SELECT to_char((created_at AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS day,
              count(*)::int AS samples, COALESCE(sum(sample_qty), 0)::float8 AS pieces,
              COALESCE(sum(defect_pieces), 0)::float8 AS "defectPieces",
              count(*) FILTER (WHERE defect_pieces = 0)::int AS "firstPass"
         FROM per_sample GROUP BY 1 ORDER BY 1`,
      params(f),
    ),
    // Production lands on the day its session was closed.
    q.query<{ day: string; produced: number; defectPieces: number }>(
      `WITH ${PRODUCED}
       SELECT to_char((closed_at AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS day,
              COALESCE(sum(produced), 0)::float8 AS produced, COALESCE(sum(defect_pieces), 0)::float8 AS "defectPieces"
         FROM produced GROUP BY 1`,
      params(f),
    ),
  ])
  const madeByDay = new Map(produced.rows.map((r) => [r.day, r]))
  const days = Array.from(new Set([...sampled.rows.map((r) => r.day), ...produced.rows.map((r) => r.day)])).sort()
  const sampledByDay = new Map(sampled.rows.map((r) => [r.day, r]))
  return days.map((day) => {
    const s = sampledByDay.get(day)
    const m = madeByDay.get(day)
    return {
      day,
      samples: s?.samples ?? 0,
      pieces: s?.pieces ?? 0,
      defectPieces: s?.defectPieces ?? 0,
      piecesProduced: m?.produced ?? 0,
      productionDefectPieces: m?.defectPieces ?? 0,
      defectRatePct: m ? rejectRate(m.defectPieces, m.produced) : null,
      inspectedDefectPct: s ? pct(s.defectPieces, s.pieces) : null,
      fpyPct: s ? pct(s.firstPass, s.samples) : null,
    }
  })
}

/** How many defect types the period holds, and how many pieces they carry in
 *  total — so the share a bar shows is a share of everything, not of the
 *  fifteen that fitted on the chart. */
export interface ParetoResult {
  rows: KpiParetoRow[]
  /** Every defect type in the period, including those below the chart. */
  types: number
  /** Defect pieces across every type. */
  totalPieces: number
}

/** The fifteen largest defect types. A Pareto whose shares were taken over
 *  only the rows shown would always reach 100% at the last bar, which is the
 *  one thing a Pareto must not say: the shares here are of the whole period. */
export async function loadPareto(q: Queryable, f: PeriodFilters): Promise<ParetoResult> {
  const { rows } = await q.query<{ defectName: string; pieces: number; records: number; types: number; totalPieces: number }>(
    `${BASE},
     by_defect AS (
       SELECT d.defect_name AS "defectName", COALESCE(sum(d.qty), 0)::float8 AS pieces, count(*)::int AS records
         FROM defect_results d JOIN base b ON b.sample_id = d.sample_id
        WHERE d.deleted_at IS NULL GROUP BY d.defect_name)
     SELECT "defectName", pieces, records,
            (SELECT count(*) FROM by_defect)::int AS types,
            (SELECT COALESCE(sum(pieces), 0) FROM by_defect)::float8 AS "totalPieces"
       FROM by_defect ORDER BY pieces DESC, records DESC LIMIT 15`,
    params(f),
  )
  const types = rows[0]?.types ?? 0
  const totalPieces = rows[0]?.totalPieces ?? 0
  let running = 0
  const out = rows.map((r): KpiParetoRow => {
    running += r.pieces
    return {
      defectName: r.defectName,
      pieces: r.pieces,
      records: r.records,
      sharePct: pct(r.pieces, totalPieces) ?? 0,
      cumulativePct: pct(running, totalPieces) ?? 0,
    }
  })
  return { rows: out, types, totalPieces }
}

type GroupKind = 'machine' | 'inspector' | 'shift' | 'item'

/** `group` decides what one row is; `key` is the value the client links with;
 *  `produced` is the same grouping over the period's production, where a
 *  session's production can be attributed to the row at all. */
const GROUP_KEYS: Record<GroupKind, { group: string; key: string; label: string; sub: string; produced: string | null }> = {
  machine: { group: 'lower(wc)', key: 'max(wc)', label: 'max(machine_label)', sub: 'max(factory)', produced: 'lower(wc)' },
  inspector: { group: 'inspector_id::text', key: 'inspector_id::text', label: 'max(inspector_name)', sub: `''`, produced: null },
  shift: { group: 'shift::text', key: 'shift::text', label: 'shift::text', sub: `''`, produced: null },
  item: { group: 'lower(item_code)', key: 'max(item_code)', label: 'max(item)', sub: 'max(item_code)', produced: 'lower(item_code)' },
}

/** A capped list with the size of the list it was cut from. */
export interface CappedRows<T> {
  rows: T[]
  /** How many rows exist in the period, before the cap. */
  total: number
}

export async function loadGroups(q: Queryable, f: PeriodFilters, kind: GroupKind, limit = 25): Promise<CappedRows<KpiGroupRow>> {
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
    total: number
  }>(
    `${BASE}
     SELECT ${g.key} AS key, ${g.label} AS label, ${g.sub} AS sub, count(*) OVER ()::int AS total,
            count(DISTINCT session_id)::int AS sessions, count(*)::int AS samples, COALESCE(sum(sample_qty), 0)::float8 AS pieces,
            COALESCE(sum(defect_pieces), 0)::float8 AS "defectPieces",
            count(*) FILTER (WHERE defect_pieces = 0)::int AS "firstPass",
            COALESCE(sum(dims_measured), 0)::int AS "dimsMeasured", COALESCE(sum(dims_fail), 0)::int AS "dimsFail"
       FROM per_sample GROUP BY ${g.group} ORDER BY samples DESC, key LIMIT ${limit}`,
    params(f),
  )
  const made = new Map<string, { produced: number; defectPieces: number }>()
  if (g.produced) {
    const production = await q.query<{ gkey: string; produced: number; defectPieces: number }>(
      `WITH ${PRODUCED}
       SELECT ${g.produced} AS gkey, COALESCE(sum(produced), 0)::float8 AS produced, COALESCE(sum(defect_pieces), 0)::float8 AS "defectPieces"
         FROM produced GROUP BY 1`,
      params(f),
    )
    for (const r of production.rows) made.set(r.gkey, r)
  }
  return {
    rows: rows.map((r) => {
      const m = g.produced ? made.get(r.key.toLowerCase()) : undefined
      return {
        key: r.key,
        label: r.label,
        sub: r.sub || undefined,
        sessions: r.sessions,
        samples: r.samples,
        pieces: r.pieces,
        defectPieces: r.defectPieces,
        piecesProduced: g.produced ? (m?.produced ?? 0) : null,
        productionDefectPieces: g.produced ? (m?.defectPieces ?? 0) : null,
        defectRatePct: m ? rejectRate(m.defectPieces, m.produced) : null,
        inspectedDefectPct: pct(r.defectPieces, r.pieces),
        fpyPct: pct(r.firstPass, r.samples),
        dimFailPct: pct(r.dimsFail, r.dimsMeasured),
      }
    }),
    total: rows[0]?.total ?? 0,
  }
}

export async function loadSuppliers(q: Queryable, f: PeriodFilters): Promise<CappedRows<KpiSupplierRow>> {
  const { rows } = await q.query<{ supplier: string; grade: string; samples: number; pieces: number; defectPieces: number; total: number }>(
    `${BASE},
     coil_samples AS (
       SELECT DISTINCT c.sample_id, COALESCE(NULLIF(btrim(c.supplier), ''), '(unknown supplier)') AS supplier,
                       COALESCE(NULLIF(btrim(c.grade), ''), '—') AS grade
         FROM sample_coils c JOIN base b ON b.sample_id = c.sample_id WHERE c.deleted_at IS NULL AND b.process = 'forming')
     SELECT cs.supplier, cs.grade, count(*) OVER ()::int AS total, count(*)::int AS samples, COALESCE(sum(ps.sample_qty), 0)::float8 AS pieces,
            COALESCE(sum(ps.defect_pieces), 0)::float8 AS "defectPieces"
       FROM coil_samples cs JOIN per_sample ps ON ps.sample_id = cs.sample_id
      GROUP BY 1, 2 ORDER BY samples DESC LIMIT 15`,
    params(f),
  )
  return {
    rows: rows.map((r) => ({
      supplier: r.supplier,
      grade: r.grade,
      samples: r.samples,
      pieces: r.pieces,
      defectPieces: r.defectPieces,
      inspectedDefectPct: pct(r.defectPieces, r.pieces),
    })),
    total: rows[0]?.total ?? 0,
  }
}

/** Defects on Hold right now — not a period figure: a Hold is open until someone decides. */
export async function loadHolds(q: Queryable, f: PeriodFilters): Promise<CappedRows<KpiHoldRow>> {
  const { rows } = await q.query<KpiHoldRow & { total: number }>(
    `SELECT d.id AS "defectId", sm.session_id AS "sessionId", sm.id AS "sampleId", o.order_number AS "orderNumber", o.item,
            s.work_center_code AS "workCenterCode", d.defect_name AS "defectName", d.qty::float8 AS qty,
            floor(EXTRACT(EPOCH FROM (now() - sm.created_at)) / 86400)::int AS "ageDays", count(*) OVER ()::int AS total
       FROM defect_results d
       JOIN inspection_samples sm ON sm.id = d.sample_id AND sm.deleted_at IS NULL
       JOIN inspection_sessions s ON s.id = sm.session_id AND s.deleted_at IS NULL
       JOIN production_orders o ON o.id = sm.order_id
       LEFT JOIN LATERAL (
         SELECT m.factory, m.process FROM machines m WHERE lower(m.code) = lower(s.work_center_code) AND m.deleted_at IS NULL ORDER BY m.created_at LIMIT 1) m ON true
      WHERE d.deleted_at IS NULL AND d.disposition = 'Hold'
        AND ($1::text IS NULL OR COALESCE(m.factory, '') = $1)
        AND ($2::text[] IS NULL OR lower(s.work_center_code) = ANY($2::text[]))
        AND ($3::text IS NULL OR lower(o.item_code) = lower($3))
        AND ($4::uuid IS NULL OR sm.inspector_id = $4)
        AND ($5::text IS NULL OR COALESCE(m.process, 'other') = $5)
      ORDER BY sm.created_at LIMIT 50`,
    [f.factory ?? null, wcs(f), f.itemCode ?? null, f.inspectorId ?? null, f.process ?? null],
  )
  // The oldest fifty: a Hold owes a decision, and the oldest owe it most.
  return { rows: rows.map(({ total: _total, ...row }) => row), total: rows[0]?.total ?? 0 }
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
           SELECT m.factory, m.process FROM machines m WHERE lower(m.code) = lower(s.work_center_code) AND m.deleted_at IS NULL ORDER BY m.created_at LIMIT 1) m ON true
        WHERE s.deleted_at IS NULL
          AND ($4::text IS NULL OR COALESCE(m.factory, '') = $4)
          AND ($5::text[] IS NULL OR lower(s.work_center_code) = ANY($5::text[]))
          AND ($6::text IS NULL OR lower(o.item_code) = lower($6))
          AND ($7::uuid IS NULL OR s.inspector_id = $7)
          AND ($8::text IS NULL OR COALESCE(m.process, 'other') = $8)`,
      [...p.slice(0, 7), f.process ?? null],
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
          AND ($4::text[] IS NULL OR lower(COALESCE(work_center_code, '')) = ANY($4::text[]))
          AND ($5::uuid IS NULL OR user_id = $5)`,
      [f.tz, f.from, f.to, wcs(f), f.inspectorId ?? null],
    ),
    q.query<{ openLines: number }>(
      `SELECT count(*)::int AS "openLines"
         FROM production_orders o
         LEFT JOIN LATERAL (
           SELECT m.factory, m.process FROM machines m WHERE lower(m.code) = lower(o.work_center_code) AND m.deleted_at IS NULL ORDER BY m.created_at LIMIT 1) m ON true
        WHERE o.deleted_at IS NULL AND lower(o.erp_status) <> 'cancel' AND o.required_qty > o.finished_qty
          AND ($1::text IS NULL OR COALESCE(m.factory, '') = $1)
          AND ($2::text[] IS NULL OR lower(o.work_center_code) = ANY($2::text[]))
          AND ($3::text IS NULL OR lower(o.item_code) = lower($3))
          AND ($4::text IS NULL OR COALESCE(m.process, 'other') = $4)`,
      [f.factory ?? null, wcs(f), f.itemCode ?? null, f.process ?? null],
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


/**
 * §16 — the raw figures behind the inspector ranking, one row per inspector
 * per factory, plus the days each inspector actually recorded on.
 *
 * Every measure here is of the inspection, never of the product: how much was
 * inspected, how completely it was recorded, how often the record had to be
 * fixed afterwards, and how the defects found compare with what other
 * inspectors find on the same machine. `rankInspectors` in @qc/shared/kpi
 * turns these into scores; the folding of factories into one overall list is
 * done in TypeScript, where the days worked can be counted once across them.
 */
export interface InspectorRawResult {
  /** One row per inspector per factory. */
  perFactory: KpiInspectorRaw[]
  /** Distinct factory days an inspector recorded on: `${inspectorId}|${factory}`
   *  for one factory, and `${inspectorId}|` for all of them together. */
  activeDays: Map<string, number>
}

export async function loadInspectorRaw(q: Queryable, f: PeriodFilters): Promise<InspectorRawResult> {
  const p = params(f)
  const [figures, days] = await Promise.all([
    q.query<Omit<KpiInspectorRaw, 'activeDays'>>(
      `${BASE},
       -- What each inspector recorded, per factory.
       per_inspector AS (
         SELECT ps.inspector_id, max(ps.inspector_name) AS name, ps.factory,
                count(*)::int AS samples,
                COALESCE(sum(ps.sample_qty), 0)::float8 AS pieces,
                count(DISTINCT ps.order_id)::int AS lines,
                count(DISTINCT lower(ps.wc))::int AS machines,
                COALESCE(sum(ps.defect_records), 0)::int AS "defectRecords"
           FROM per_sample ps GROUP BY ps.inspector_id, ps.factory),
       -- How completely each inspection was recorded.
       completeness AS (
         SELECT b.inspector_id, b.factory,
                count(r.id)::int AS "dimensionRows",
                count(r.id) FILTER (WHERE r.actual IS NOT NULL)::int AS "dimensionsMeasured"
           FROM base b LEFT JOIN dimension_results r ON r.sample_id = b.sample_id AND r.deleted_at IS NULL
          GROUP BY b.inspector_id, b.factory),
       coils AS (
         SELECT b.inspector_id, b.factory,
                count(c.id)::int AS "coilsUsed",
                count(c.id) FILTER (WHERE c.coil_id IS NOT NULL)::int AS "coilsFromRegister"
           FROM base b LEFT JOIN sample_coils c ON c.sample_id = b.sample_id AND c.deleted_at IS NULL
          GROUP BY b.inspector_id, b.factory),
       -- Sessions counted by who opened them, over the same period and filters.
       sessions AS (
         SELECT s.inspector_id, COALESCE(m.factory, '') AS factory,
                count(*)::int AS "sessionsOpened",
                count(*) FILTER (WHERE s.status = 'Closed')::int AS "sessionsClosed",
                count(*) FILTER (WHERE s.status = 'Closed' AND s.final_qty IS NOT NULL)::int AS "sessionsClosedWithFinalQty",
                count(*) FILTER (WHERE NOT EXISTS (
                  SELECT 1 FROM inspection_samples x WHERE x.session_id = s.id AND x.deleted_at IS NULL))::int AS "emptySessions"
           FROM inspection_sessions s
           JOIN production_orders o ON o.id = s.order_id
           LEFT JOIN LATERAL (
             SELECT m.factory, m.process FROM machines m WHERE lower(m.code) = lower(s.work_center_code) AND m.deleted_at IS NULL
              ORDER BY m.created_at LIMIT 1) m ON true
          WHERE s.deleted_at IS NULL
            AND s.started_at >= ($2::date)::timestamp AT TIME ZONE $1
            AND s.started_at <  (($3::date + 1)::timestamp) AT TIME ZONE $1
            AND ($4::text IS NULL OR COALESCE(m.factory, '') = $4)
            AND ($5::text[] IS NULL OR lower(s.work_center_code) = ANY($5::text[]))
            AND ($6::text IS NULL OR lower(o.item_code) = lower($6))
            AND ($7::uuid IS NULL OR s.inspector_id = $7)
            AND ($9::text IS NULL OR COALESCE(m.process, 'other') = $9)
          GROUP BY s.inspector_id, COALESCE(m.factory, '')),
       -- What had to be corrected afterwards, attributed to the record's owner
       -- rather than to whoever made the correction.
       fixes AS (
         SELECT b.inspector_id, b.factory,
                count(*) FILTER (WHERE a.entity IN ('DimensionResult', 'DefectResult') AND a.action = 'update')::int AS corrections,
                count(*) FILTER (WHERE a.entity = 'InspectionSample' AND a.field = 'reRecorded')::int AS "reRecorded"
           FROM base b JOIN audit_log a ON a.sample_id = b.sample_id AND a.deleted_at IS NULL
          GROUP BY b.inspector_id, b.factory),
       -- Detection, machine by machine: this inspector's defect records per
       -- piece against what everyone ELSE on that machine records. A machine
       -- they worked alone has no peer rate and is left out of the index.
       per_machine AS (
         SELECT lower(ps.wc) AS wc, ps.inspector_id, ps.factory,
                COALESCE(sum(ps.sample_qty), 0)::float8 AS pieces,
                COALESCE(sum(ps.defect_records), 0)::float8 AS records
           FROM per_sample ps GROUP BY 1, 2, 3),
       machine_totals AS (
         SELECT wc, sum(pieces) AS pieces, sum(records) AS records FROM per_machine GROUP BY wc),
       comparable AS (
         SELECT pm.inspector_id, pm.factory, pm.pieces,
                (pm.records / pm.pieces) / ((mt.records - pm.records) / (mt.pieces - pm.pieces)) AS ratio
           FROM per_machine pm JOIN machine_totals mt ON mt.wc = pm.wc
          WHERE pm.pieces > 0 AND mt.pieces > pm.pieces AND (mt.records - pm.records) > 0),
       detection AS (
         -- Weighted by the pieces they saw on each machine, so a machine they
         -- barely worked does not decide their index.
         SELECT inspector_id, factory, (sum(ratio * pieces) / sum(pieces))::float8 AS "detectionIndex"
           FROM comparable GROUP BY inspector_id, factory)
       SELECT pi.inspector_id AS "inspectorId", pi.name, pi.factory,
              pi.samples, pi.pieces, pi.lines, pi.machines, pi."defectRecords",
              COALESCE(c."dimensionRows", 0) AS "dimensionRows", COALESCE(c."dimensionsMeasured", 0) AS "dimensionsMeasured",
              COALESCE(co."coilsUsed", 0) AS "coilsUsed", COALESCE(co."coilsFromRegister", 0) AS "coilsFromRegister",
              COALESCE(se."sessionsOpened", 0) AS "sessionsOpened", COALESCE(se."sessionsClosed", 0) AS "sessionsClosed",
              COALESCE(se."sessionsClosedWithFinalQty", 0) AS "sessionsClosedWithFinalQty",
              COALESCE(se."emptySessions", 0) AS "emptySessions",
              COALESCE(fx.corrections, 0) AS corrections, COALESCE(fx."reRecorded", 0) AS "reRecorded",
              dt."detectionIndex"
         FROM per_inspector pi
         LEFT JOIN completeness c ON c.inspector_id = pi.inspector_id AND c.factory = pi.factory
         LEFT JOIN coils co ON co.inspector_id = pi.inspector_id AND co.factory = pi.factory
         LEFT JOIN sessions se ON se.inspector_id = pi.inspector_id AND se.factory = pi.factory
         LEFT JOIN fixes fx ON fx.inspector_id = pi.inspector_id AND fx.factory = pi.factory
         LEFT JOIN detection dt ON dt.inspector_id = pi.inspector_id AND dt.factory = pi.factory`,
      p,
    ),
    // Days worked, counted once per factory and once across all of them: an
    // inspector on two factories on the same day worked one day, not two.
    q.query<{ inspectorId: string; factory: string | null; days: number }>(
      `${BASE},
       worked AS (SELECT DISTINCT inspector_id, factory, (created_at AT TIME ZONE $1)::date AS day FROM per_sample)
       SELECT inspector_id AS "inspectorId",
              CASE WHEN grouping(factory) = 1 THEN NULL ELSE factory END AS factory,
              count(DISTINCT day)::int AS days
         FROM worked GROUP BY GROUPING SETS ((inspector_id, factory), (inspector_id))`,
      p,
    ),
  ])
  const activeDays = new Map<string, number>()
  for (const d of days.rows) activeDays.set(`${d.inspectorId}|${d.factory ?? ''}`, d.days)
  return {
    perFactory: figures.rows.map((r) => ({ ...r, activeDays: activeDays.get(`${r.inspectorId}|${r.factory}`) ?? 0 })),
    activeDays,
  }
}

/**
 * The shape of the period: how many samples had no defect, a few, or many.
 * A single average defect rate hides whether the line runs clean with the odd
 * bad sample or runs uniformly rough, and that difference decides the action.
 */
export const RATE_BANDS = ['0%', '≤1%', '1–3%', '3–5%', '5–10%', '>10%'] as const

export async function loadDefectRateBands(q: Queryable, f: PeriodFilters): Promise<KpiRateBand[]> {
  const { rows } = await q.query<{ band: string; samples: number; pieces: number }>(
    `${BASE}
     SELECT CASE
              WHEN defect_pieces = 0 THEN '0%'
              WHEN defect_pieces / sample_qty <= 0.01 THEN '≤1%'
              WHEN defect_pieces / sample_qty <= 0.03 THEN '1–3%'
              WHEN defect_pieces / sample_qty <= 0.05 THEN '3–5%'
              WHEN defect_pieces / sample_qty <= 0.10 THEN '5–10%'
              ELSE '>10%' END AS band,
            count(*)::int AS samples, COALESCE(sum(sample_qty), 0)::float8 AS pieces
       FROM per_sample WHERE sample_qty > 0 GROUP BY 1`,
    params(f),
  )
  const found = new Map(rows.map((r) => [r.band, r]))
  return RATE_BANDS.map((band) => ({ band, samples: found.get(band)?.samples ?? 0, pieces: found.get(band)?.pieces ?? 0 }))
}

/** Paint thickness per item, from the readings as recorded on paint samples. */
export async function loadPaintByItem(q: Queryable, f: PeriodFilters): Promise<CappedRows<KpiPaintItemRow>> {
  const { rows } = await q.query<KpiPaintItemRow & { total: number }>(
    `${BASE}
     SELECT max(b.item_code) AS "itemCode", max(b.item) AS item, count(*) OVER ()::int AS total,
            count(*)::int AS readings, avg(r.actual)::float8 AS "meanMicrons",
            min(r.actual)::float8 AS "minMicrons", max(r.actual)::float8 AS "maxMicrons"
       FROM dimension_results r JOIN base b ON b.sample_id = r.sample_id
      WHERE r.deleted_at IS NULL AND r.actual IS NOT NULL AND lower(r.name) = lower($10)
      GROUP BY lower(b.item_code) ORDER BY readings DESC LIMIT 25`,
    [...params(f), PAINT_THICKNESS_NAME],
  )
  return {
    rows: rows.map((r) => ({
      itemCode: r.itemCode,
      item: r.item,
      readings: r.readings,
      meanMicrons: Math.round(r.meanMicrons * 10) / 10,
      minMicrons: r.minMicrons,
      maxMicrons: r.maxMicrons,
    })),
    total: rows[0]?.total ?? 0,
  }
}

/** The Pareto of each machine's defects — the ten largest types, shares of
 *  that machine's own defect pieces — machines with most defect pieces first. */
export async function loadParetoByMachine(q: Queryable, f: PeriodFilters): Promise<KpiMachinePareto[]> {
  const { rows } = await q.query<{ code: string; label: string; defectName: string; pieces: number; records: number; total: number; types: number }>(
    `${BASE},
     by_machine AS (
       SELECT lower(b.wc) AS wc, max(b.wc) AS code, max(b.machine_label) AS label, d.defect_name AS "defectName",
              COALESCE(sum(d.qty), 0)::float8 AS pieces, count(*)::int AS records
         FROM defect_results d JOIN base b ON b.sample_id = d.sample_id
        WHERE d.deleted_at IS NULL GROUP BY lower(b.wc), d.defect_name),
     totals AS (SELECT wc, sum(pieces)::float8 AS total, count(*)::int AS types FROM by_machine GROUP BY wc),
     ranked AS (SELECT m.*, row_number() OVER (PARTITION BY m.wc ORDER BY m.pieces DESC, m.records DESC) AS rn FROM by_machine m)
     SELECT r.code, r.label, r."defectName", r.pieces, r.records, t.total, t.types
       FROM ranked r JOIN totals t ON t.wc = r.wc
      WHERE r.rn <= 10 ORDER BY t.total DESC, r.code, r.rn`,
    params(f),
  )
  const out: KpiMachinePareto[] = []
  for (const r of rows) {
    let m = out[out.length - 1]
    if (!m || m.workCenterCode !== r.code) {
      m = { workCenterCode: r.code, label: r.label, rows: [], totalPieces: r.total, types: r.types }
      out.push(m)
    }
    const running = m.rows.reduce((n, x) => n + x.pieces, 0) + r.pieces
    m.rows.push({
      defectName: r.defectName,
      pieces: r.pieces,
      records: r.records,
      sharePct: pct(r.pieces, r.total) ?? 0,
      cumulativePct: pct(running, r.total) ?? 0,
    })
  }
  return out
}

/** What each item is known to suffer: for the ten items with the most defect
 *  pieces, their five largest defects with the machine each came from. */
export async function loadItemDefects(q: Queryable, f: PeriodFilters): Promise<KpiItemDefectRow[]> {
  const { rows } = await q.query<KpiItemDefectRow & { total: number }>(
    `${BASE},
     by_item_defect AS (
       SELECT lower(b.item_code) AS ic, max(b.item_code) AS "itemCode", max(b.item) AS item, d.defect_name AS "defectName",
              max(b.wc) AS "workCenterCode", max(b.machine_label) AS "machineLabel",
              COALESCE(sum(d.qty), 0)::float8 AS pieces, count(*)::int AS records
         FROM defect_results d JOIN base b ON b.sample_id = d.sample_id
        WHERE d.deleted_at IS NULL GROUP BY lower(b.item_code), d.defect_name, lower(b.wc)),
     item_totals AS (SELECT ic, sum(pieces)::float8 AS total FROM by_item_defect GROUP BY ic ORDER BY total DESC LIMIT 10),
     ranked AS (
       SELECT x.*, it.total, row_number() OVER (PARTITION BY x.ic ORDER BY x.pieces DESC, x.records DESC) AS rn
         FROM by_item_defect x JOIN item_totals it ON it.ic = x.ic)
     SELECT "itemCode", item, "defectName", "workCenterCode", "machineLabel", pieces, records, total
       FROM ranked WHERE rn <= 5 ORDER BY total DESC, ic, rn`,
    params(f),
  )
  return rows.map((r) => ({
    itemCode: r.itemCode,
    item: r.item,
    defectName: r.defectName,
    workCenterCode: r.workCenterCode,
    machineLabel: r.machineLabel,
    pieces: r.pieces,
    records: r.records,
    sharePct: pct(r.pieces, r.total) ?? 0,
  }))
}

// ---- Months, defect spread, and the general page ----------------------------

/** The selection month by month: what was inspected in each, and what was
 *  produced (sessions closed in it with a final quantity). */
export async function loadMonthly(q: Queryable, f: PeriodFilters): Promise<KpiMonthPoint[]> {
  const [sampled, produced] = await Promise.all([
    q.query<{ month: string; samples: number; pieces: number; defectPieces: number }>(
      `${BASE}
       SELECT to_char(created_at AT TIME ZONE $1, 'YYYY-MM') AS month,
              count(*)::int AS samples, COALESCE(sum(sample_qty), 0)::float8 AS pieces,
              COALESCE(sum(defect_pieces), 0)::float8 AS "defectPieces"
         FROM per_sample GROUP BY 1 ORDER BY 1`,
      params(f),
    ),
    q.query<{ month: string; produced: number; defectPieces: number }>(
      `WITH ${PRODUCED}
       SELECT to_char(closed_at AT TIME ZONE $1, 'YYYY-MM') AS month,
              COALESCE(sum(produced), 0)::float8 AS produced, COALESCE(sum(defect_pieces), 0)::float8 AS "defectPieces"
         FROM produced GROUP BY 1`,
      params(f),
    ),
  ])
  const madeByMonth = new Map(produced.rows.map((r) => [r.month, r]))
  const sampledByMonth = new Map(sampled.rows.map((r) => [r.month, r]))
  // Every month of the period on the axis, so a quiet month shows as zero rather than vanishing.
  const months: string[] = []
  for (let m = f.from.slice(0, 7); m <= f.to.slice(0, 7) && months.length < 60; m = nextMonth(m)) months.push(m)
  return months.map((month) => {
    const s = sampledByMonth.get(month)
    const m = madeByMonth.get(month)
    return {
      month,
      samples: s?.samples ?? 0,
      pieces: s?.pieces ?? 0,
      defectPieces: s?.defectPieces ?? 0,
      piecesProduced: m?.produced ?? 0,
      productionDefectPieces: m?.defectPieces ?? 0,
      defectRatePct: m ? rejectRate(m.defectPieces, m.produced) : null,
      inspectedDefectPct: s ? pct(s.defectPieces, s.pieces) : null,
    }
  })
}

/** YYYY-MM after this one. */
export function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
}

/** Every defect type of the selection, largest first, with how spread it is:
 *  the distinct factory days it was recorded on and the distinct order lines. */
export async function loadDefectDetails(q: Queryable, f: PeriodFilters, limit = 40): Promise<KpiDefectDetailRow[]> {
  const { rows } = await q.query<{ defectName: string; pieces: number; records: number; days: number; orders: number; totalPieces: number }>(
    `${BASE},
     by_defect AS (
       SELECT d.defect_name AS "defectName", COALESCE(sum(d.qty), 0)::float8 AS pieces, count(*)::int AS records,
              count(DISTINCT (b.created_at AT TIME ZONE $1)::date)::int AS days,
              count(DISTINCT b.order_id)::int AS orders
         FROM defect_results d JOIN base b ON b.sample_id = d.sample_id
        WHERE d.deleted_at IS NULL GROUP BY d.defect_name)
     SELECT "defectName", pieces, records, days, orders,
            (SELECT COALESCE(sum(pieces), 0) FROM by_defect)::float8 AS "totalPieces"
       FROM by_defect ORDER BY pieces DESC, records DESC, "defectName" LIMIT ${limit}`,
    params(f),
  )
  const total = rows[0]?.totalPieces ?? 0
  return rows.map((r) => ({
    defectName: r.defectName,
    pieces: r.pieces,
    records: r.records,
    days: r.days,
    orders: r.orders,
    sharePct: pct(r.pieces, total) ?? 0,
  }))
}

/** Each factory's production month by month, for the general page's trend.
 *  A factory is the register's; a machine without one counts as "(no factory)". */
export async function loadFactoryMonths(q: Queryable, f: PeriodFilters): Promise<KpiFactoryTrend[]> {
  const { rows } = await q.query<{ factory: string; month: string; produced: number; defectPieces: number }>(
    `WITH ${PRODUCED}
     SELECT factory, to_char(closed_at AT TIME ZONE $1, 'YYYY-MM') AS month,
            COALESCE(sum(produced), 0)::float8 AS produced, COALESCE(sum(defect_pieces), 0)::float8 AS "defectPieces"
       FROM produced GROUP BY 1, 2 ORDER BY 1, 2`,
    params(f),
  )
  const months: string[] = []
  for (let m = f.from.slice(0, 7); m <= f.to.slice(0, 7) && months.length < 60; m = nextMonth(m)) months.push(m)
  const byFactory = new Map<string, Map<string, { produced: number; defectPieces: number }>>()
  for (const r of rows) {
    const name = r.factory || '(no factory)'
    if (!byFactory.has(name)) byFactory.set(name, new Map())
    byFactory.get(name)!.set(r.month, r)
  }
  return Array.from(byFactory, ([factory, perMonth]) => {
    const produced = Array.from(perMonth.values()).reduce((n, r) => n + r.produced, 0)
    const defectPieces = Array.from(perMonth.values()).reduce((n, r) => n + r.defectPieces, 0)
    return {
      factory,
      piecesProduced: produced,
      productionDefectPieces: defectPieces,
      defectRatePct: rejectRate(defectPieces, produced),
      months: months.map((month) => {
        const m = perMonth.get(month)
        return { month, piecesProduced: m?.produced ?? 0, productionDefectPieces: m?.defectPieces ?? 0, defectRatePct: m ? rejectRate(m.defectPieces, m.produced) : null }
      }),
    }
  }).sort((a, b) => b.piecesProduced - a.piecesProduced || a.factory.localeCompare(b.factory))
}

/** Each machine's production and reject rate month by month, for the general page's overview. */
export async function loadMachineMonths(q: Queryable, f: PeriodFilters): Promise<KpiMachineTrend[]> {
  const { rows } = await q.query<{ code: string; label: string; factory: string; process: Process; month: string; produced: number; defectPieces: number }>(
    `WITH ${PRODUCED}
     SELECT max(wc) AS code, max(machine_label) AS label, max(factory) AS factory, max(process) AS process,
            to_char(closed_at AT TIME ZONE $1, 'YYYY-MM') AS month,
            COALESCE(sum(produced), 0)::float8 AS produced, COALESCE(sum(defect_pieces), 0)::float8 AS "defectPieces"
       FROM produced GROUP BY lower(wc), 5 ORDER BY 1, 5`,
    params(f),
  )
  const months: string[] = []
  for (let m = f.from.slice(0, 7); m <= f.to.slice(0, 7) && months.length < 60; m = nextMonth(m)) months.push(m)
  const byMachine = new Map<string, { code: string; label: string; factory: string; process: Process; perMonth: Map<string, { produced: number; defectPieces: number }> }>()
  for (const r of rows) {
    const key = r.code.toLowerCase()
    if (!byMachine.has(key)) byMachine.set(key, { code: r.code, label: r.label, factory: r.factory, process: r.process, perMonth: new Map() })
    byMachine.get(key)!.perMonth.set(r.month, r)
  }
  return Array.from(byMachine.values())
    .map((m) => {
      const produced = Array.from(m.perMonth.values()).reduce((n, r) => n + r.produced, 0)
      const defectPieces = Array.from(m.perMonth.values()).reduce((n, r) => n + r.defectPieces, 0)
      return {
        workCenterCode: m.code,
        label: m.label,
        factory: m.factory,
        process: m.process,
        piecesProduced: produced,
        productionDefectPieces: defectPieces,
        defectRatePct: rejectRate(defectPieces, produced),
        months: months.map((month) => {
          const x = m.perMonth.get(month)
          return { month, piecesProduced: x?.produced ?? 0, productionDefectPieces: x?.defectPieces ?? 0, defectRatePct: x ? rejectRate(x.defectPieces, x.produced) : null }
        }),
      }
    })
    .sort((a, b) => (b.defectRatePct ?? -1) - (a.defectRatePct ?? -1) || b.piecesProduced - a.piecesProduced || a.label.localeCompare(b.label))
}

// ---- The drill-down ----------------------------------------------------------

/** PRODUCED plus its defects, so the rejected pieces of a month can be laid on
 *  a defect, an order line or an item. */
export interface BreakdownResult {
  months: KpiBreakdownMonth[]
  defects: KpiBreakdownDefect[]
  byOrder: KpiBreakdownRow[]
  byItem: KpiBreakdownRow[]
}

export async function loadBreakdown(q: Queryable, f: PeriodFilters): Promise<BreakdownResult> {
  const p = params(f)
  const [monthRows, defectRows, orderRows, itemRows] = await Promise.all([
    q.query<{ month: string; sessions: number; produced: number; defectPieces: number }>(
      `WITH ${PRODUCED}
       SELECT to_char(closed_at AT TIME ZONE $1, 'YYYY-MM') AS month, count(*)::int AS sessions,
              COALESCE(sum(produced), 0)::float8 AS produced, COALESCE(sum(defect_pieces), 0)::float8 AS "defectPieces"
         FROM produced GROUP BY 1 ORDER BY 1`,
      p,
    ),
    q.query<{ month: string; defectName: string; pieces: number }>(
      `WITH ${PRODUCED}
       SELECT to_char(pr.closed_at AT TIME ZONE $1, 'YYYY-MM') AS month, d.defect_name AS "defectName", COALESCE(sum(d.qty), 0)::float8 AS pieces
         FROM produced pr
         JOIN inspection_samples x ON x.session_id = pr.session_id AND x.deleted_at IS NULL
         JOIN defect_results d ON d.sample_id = x.id AND d.deleted_at IS NULL
        GROUP BY 1, 2 ORDER BY 1, 3 DESC`,
      p,
    ),
    q.query<{ month: string; orderNumber: string; item: string; itemCode: string; pieces: number }>(
      `WITH ${PRODUCED}
       SELECT to_char(closed_at AT TIME ZONE $1, 'YYYY-MM') AS month, order_number AS "orderNumber", max(item) AS item, max(item_code) AS "itemCode",
              COALESCE(sum(defect_pieces), 0)::float8 AS pieces
         FROM produced GROUP BY 1, 2 HAVING COALESCE(sum(defect_pieces), 0) > 0 ORDER BY 1, 5 DESC`,
      p,
    ),
    q.query<{ month: string; itemCode: string; item: string; pieces: number }>(
      `WITH ${PRODUCED}
       SELECT to_char(closed_at AT TIME ZONE $1, 'YYYY-MM') AS month, max(item_code) AS "itemCode", max(item) AS item,
              COALESCE(sum(defect_pieces), 0)::float8 AS pieces
         FROM produced GROUP BY 1, lower(item_code) HAVING COALESCE(sum(defect_pieces), 0) > 0 ORDER BY 1, 4 DESC`,
      p,
    ),
  ])
  const months: string[] = []
  for (let m = f.from.slice(0, 7); m <= f.to.slice(0, 7) && months.length < 60; m = nextMonth(m)) months.push(m)
  const perMonth = new Map(monthRows.rows.map((r) => [r.month, r]))
  const monthsOut: KpiBreakdownMonth[] = months.map((month) => {
    const r = perMonth.get(month)
    const produced = r?.produced ?? 0
    const defectPieces = r?.defectPieces ?? 0
    return { month, sessions: r?.sessions ?? 0, piecesProduced: produced, productionDefectPieces: defectPieces, made: produced + defectPieces, defectRatePct: r ? rejectRate(defectPieces, produced) : null }
  })
  const madeOf = new Map(monthsOut.map((m) => [m.month, m.made]))
  const rejectedOf = new Map(monthsOut.map((m) => [m.month, m.productionDefectPieces]))
  const totalRejected = monthsOut.reduce((n, m) => n + m.productionDefectPieces, 0)

  const byDefect = new Map<string, Map<string, number>>()
  for (const r of defectRows.rows) {
    if (!byDefect.has(r.defectName)) byDefect.set(r.defectName, new Map())
    byDefect.get(r.defectName)!.set(r.month, r.pieces)
  }
  const defects: KpiBreakdownDefect[] = Array.from(byDefect, ([defectName, per]) => {
    const pieces = Array.from(per.values()).reduce((n, v) => n + v, 0)
    return {
      defectName,
      pieces,
      sharePct: pct(pieces, totalRejected) ?? 0,
      months: months.map((month) => ({ month, pieces: per.get(month) ?? 0, pctOfMade: (madeOf.get(month) ?? 0) > 0 ? pct(per.get(month) ?? 0, madeOf.get(month)!) : null })),
    }
  }).sort((a, b) => b.pieces - a.pieces || a.defectName.localeCompare(b.defectName))

  const row = (month: string, key: string, label: string, sub: string | undefined, pieces: number): KpiBreakdownRow => ({
    month,
    key,
    label,
    sub,
    pieces,
    pctOfMade: (madeOf.get(month) ?? 0) > 0 ? pct(pieces, madeOf.get(month)!) : null,
    shareOfMonthPct: (rejectedOf.get(month) ?? 0) > 0 ? pct(pieces, rejectedOf.get(month)!) : null,
  })
  return {
    months: monthsOut,
    defects,
    byOrder: orderRows.rows.map((r) => row(r.month, r.orderNumber, r.orderNumber, `${r.itemCode} · ${r.item}`, r.pieces)),
    byItem: itemRows.rows.map((r) => row(r.month, r.itemCode, r.item, r.itemCode, r.pieces)),
  }
}

/**
 * First part released, by session: sessions started in the period, clean
 * when nothing was rejected on the line before the release inspection.
 * $1 tz · $2 from · $3 to · $4 factory · $5 machines · $6 item · $7 process.
 */
const FIRST_PART = `
WITH sessions AS (
  SELECT s.id, s.started_at, COALESCE(s.start_qty, 0)::float8 AS rejected_before, s.work_center_code AS wc, s.inspector_name,
         COALESCE(m.factory, '') AS factory, COALESCE(m.display_name, 'Machine ' || s.work_center_code) AS machine_label,
         o.order_number, o.item, o.item_code
    FROM inspection_sessions s
    JOIN production_orders o ON o.id = s.order_id
    LEFT JOIN LATERAL (
      SELECT m.factory, m.display_name, m.process FROM machines m
       WHERE lower(m.code) = lower(s.work_center_code) AND m.deleted_at IS NULL
       ORDER BY m.created_at LIMIT 1) m ON true
   WHERE s.deleted_at IS NULL
     AND s.started_at >= ($2::date)::timestamp AT TIME ZONE $1
     AND s.started_at <  (($3::date + 1)::timestamp) AT TIME ZONE $1
     AND ($4::text IS NULL OR COALESCE(m.factory, '') = $4)
     AND ($5::text[] IS NULL OR lower(s.work_center_code) = ANY($5::text[]))
     AND ($6::text IS NULL OR lower(o.item_code) = lower($6))
     AND ($7::text IS NULL OR COALESCE(m.process, 'other') = $7)
)`

export async function loadFirstPart(q: Queryable, f: PeriodFilters): Promise<KpiFirstPart> {
  const p = [f.tz, f.from, f.to, f.factory ?? null, wcs(f), f.itemCode ?? null, f.process ?? null]
  const [totals, byMachine, byMonth, failed] = await Promise.all([
    q.query<{ sessions: number; clean: number }>(`${FIRST_PART} SELECT count(*)::int AS sessions, count(*) FILTER (WHERE rejected_before = 0)::int AS clean FROM sessions`, p),
    q.query<{ code: string; label: string; factory: string; sessions: number; clean: number }>(
      `${FIRST_PART}
       SELECT max(wc) AS code, max(machine_label) AS label, max(factory) AS factory, count(*)::int AS sessions, count(*) FILTER (WHERE rejected_before = 0)::int AS clean
         FROM sessions GROUP BY lower(wc) ORDER BY sessions DESC, code`,
      p,
    ),
    q.query<{ month: string; sessions: number; clean: number }>(
      `${FIRST_PART}
       SELECT to_char(started_at AT TIME ZONE $1, 'YYYY-MM') AS month, count(*)::int AS sessions, count(*) FILTER (WHERE rejected_before = 0)::int AS clean
         FROM sessions GROUP BY 1 ORDER BY 1`,
      p,
    ),
    q.query<{ sessionId: string; startedAt: string; orderNumber: string; item: string; itemCode: string; workCenterCode: string; machineLabel: string; rejectedBeforeRelease: number; inspectorName: string }>(
      `${FIRST_PART}
       SELECT id AS "sessionId", started_at AS "startedAt", order_number AS "orderNumber", item, item_code AS "itemCode", wc AS "workCenterCode",
              machine_label AS "machineLabel", rejected_before AS "rejectedBeforeRelease", inspector_name AS "inspectorName"
         FROM sessions WHERE rejected_before > 0 ORDER BY started_at DESC LIMIT 50`,
      p,
    ),
  ])
  const months: string[] = []
  for (let m = f.from.slice(0, 7); m <= f.to.slice(0, 7) && months.length < 60; m = nextMonth(m)) months.push(m)
  const perMonth = new Map(byMonth.rows.map((r) => [r.month, r]))
  const t = totals.rows[0]
  return {
    sessions: t.sessions,
    clean: t.clean,
    pct: pct(t.clean, t.sessions),
    byMachine: byMachine.rows.map((r) => ({ workCenterCode: r.code, label: r.label, factory: r.factory, sessions: r.sessions, clean: r.clean, pct: pct(r.clean, r.sessions) })),
    months: months.map((month) => {
      const r = perMonth.get(month)
      return { month, sessions: r?.sessions ?? 0, clean: r?.clean ?? 0, pct: r ? pct(r.clean, r.sessions) : null }
    }),
    failed: failed.rows.map((r) => ({ ...r, startedAt: new Date(r.startedAt).toISOString() })),
  }
}
