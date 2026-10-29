// ============================================================================
// Coils — the raw-material catalogue and its traceability (coil → sample →
// order → customer).
// ============================================================================

import { Router } from 'express'
import { z } from 'zod'
import { EXISTING_KEYS_MAX, type CoilUsage, type ExistingKeysResponse, type ImportResult } from '@qc/shared/api'
import type { Coil } from '@qc/shared/types'
import { auditEvent, type AuditDraft } from '@qc/shared/audit'
import type { AppContext } from '../context'
import { withTransaction } from '../db/pool'
import { parse } from '../lib/validate'
import { requireAnyPermission, requirePermission, requireUser } from '../auth/middleware'
import { writeAudit } from '../audit/service'
import { dropNulls, normaliseKey } from '../lib/rows'
import { judgeCoils } from '../mtc/standards'

const COIL_SELECT = `id, coil_number AS "coilNumber", grade, sm_type AS "smType", supplier, thickness, width, yield, notes, deleted_at AS "deletedAt"`

/** A coil's details, the fields an import may change, by the names the audit log and the MTC register give them. */
const COIL_FIELDS = ['grade', 'smType', 'supplier', 'thickness', 'width', 'yield', 'notes', 'heatNumber', 'productForm', 'length', 'tensile', 'elongation', 'mtcNumber'] as const
type CoilState = Record<(typeof COIL_FIELDS)[number], string | number | null>

/** What an import's audit entries say a change came from. */
const IMPORT_SOURCE = 'Coil register import'

/** Audit entries written per statement, well under PostgreSQL's 65,535 parameters. */
const AUDIT_CHUNK = 2_000

/** A value as the audit log keeps it: as text, nothing as empty — the way an MTC upload writes it. */
const auditText = (v: string | number | null | undefined): string => (v === null || v === undefined ? '' : String(v))

const importRow = z.object({
  coilNumber: z.string().trim().min(1).max(120),
  grade: z.string().trim().max(60).optional(),
  smType: z.string().trim().max(60).optional(),
  supplier: z.string().trim().max(200).optional(),
  thickness: z.coerce.number().min(0).optional(),
  width: z.coerce.number().min(0).optional(),
  yield: z.coerce.number().min(0).optional(),
  notes: z.string().trim().max(1000).optional(),
  heatNumber: z.string().trim().max(60).optional(),
  productForm: z.string().trim().max(20).optional(),
  length: z.coerce.number().min(0).optional(),
  tensile: z.coerce.number().min(0).optional(),
  elongation: z.coerce.number().min(0).optional(),
  mtcNumber: z.string().trim().max(120).optional(),
})

export function coilsRoutes(ctx: AppContext): Router {
  const r = Router()

  /** Prefix search on coil number; grade and supplier too once something is typed. */
  // Coil search's (§14), and the inspection's coil picker.
  r.get('/', requireAnyPermission('view-coil-search', 'record-inspection'), async (req, res) => {
    const q = parse(
      z.object({ search: z.string().trim().max(120).default(''), limit: z.coerce.number().int().min(1).max(100).default(25) }),
      req.query,
    )
    const prefix = `${q.search.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    const { rows } = await ctx.db.query<Coil>(
      `SELECT ${COIL_SELECT} FROM coils
        WHERE deleted_at IS NULL
          AND (lower(coil_number) LIKE $1
               OR ($2 <> '' AND (lower(grade) LIKE $1 OR lower(supplier) LIKE $1)))
        ORDER BY coil_number
        LIMIT $3`,
      [prefix, q.search, q.limit],
    )
    res.json(rows.map(dropNulls))
  })

  /** Where each coil has been used — the traceability the search exists for. */
  r.get('/usage', requireAnyPermission('view-coil-search', 'record-inspection'), async (req, res) => {
    const numbers = parse(z.string().default(''), req.query.coilNumbers)
      .split(',')
      .map(normaliseKey)
      .filter(Boolean)
      .slice(0, 100)
    if (numbers.length === 0) return res.json([])
    const { rows } = await ctx.db.query<CoilUsage>(
      `SELECT sc.coil_number AS "coilNumber", sm.id AS "sampleId", sm.index AS "sampleIndex",
              o.id AS "orderId", o.order_number AS "orderNumber", o.customer
         FROM sample_coils sc
         JOIN inspection_samples sm ON sm.id = sc.sample_id AND sm.deleted_at IS NULL
         JOIN inspection_sessions s ON s.id = sm.session_id AND s.deleted_at IS NULL
         JOIN production_orders o ON o.id = sm.order_id
        WHERE sc.deleted_at IS NULL AND lower(sc.coil_number) = ANY($1::text[])
        ORDER BY sm.created_at DESC
        LIMIT 500`,
      [numbers],
    )
    res.json(rows)
  })

  r.post('/existing-keys', requirePermission('import-data'), async (req, res) => {
    const { keys } = parse(z.object({ keys: z.array(z.string().trim().min(1)).max(EXISTING_KEYS_MAX) }), req.body)
    const wanted = Array.from(new Set(keys.map(normaliseKey)))
    const { rows } = await ctx.db.query<{ key: string }>(`SELECT lower(coil_number) AS key FROM coils WHERE lower(coil_number) = ANY($1::text[])`, [wanted])
    const body: ExistingKeysResponse = { existing: rows.map((x) => x.key) }
    res.json(body)
  })

  /**
   * §7.7 — idempotent upsert on the coil number (matched without regard to
   * case). A field the row does not carry keeps the stored value; a coil the
   * row would not change is not written and is counted as unchanged; each
   * change, and each coil brought back from deleted, is audited field by field.
   */
  r.post('/import', requirePermission('import-data'), async (req, res) => {
    const user = requireUser(req)
    const { rows } = parse(z.object({ rows: z.array(importRow).min(1).max(1000) }), req.body)
    const byKey = new Map<string, z.infer<typeof importRow>>()
    for (const row of rows) byKey.set(normaliseKey(row.coilNumber), row)
    const payload = JSON.stringify(
      Array.from(byKey.values()).map((c) => ({
        coil_number: c.coilNumber,
        grade: c.grade ?? null,
        sm_type: c.smType ?? null,
        supplier: c.supplier ?? null,
        thickness: c.thickness ?? null,
        width: c.width ?? null,
        yield: c.yield ?? null,
        notes: c.notes ?? null,
        heat_number: c.heatNumber ?? null,
        product_form: c.productForm ?? null,
        length: c.length ?? null,
        tensile: c.tensile ?? null,
        elongation: c.elongation ?? null,
        mtc_number: c.mtcNumber ?? null,
      })),
    )
    const recordset = `jsonb_to_recordset($1::jsonb) AS i(
      coil_number text, grade text, sm_type text, supplier text, thickness numeric, width numeric, yield numeric, notes text,
      heat_number text, product_form text, length numeric, tensile numeric, elongation numeric, mtc_number text)`

    const result = await withTransaction(ctx.db, async (tx) => {
      // The coils the batch names, locked, so what is read as "before" is what the update replaces.
      const matched = await tx.query(`SELECT 1 FROM coils WHERE lower(coil_number) = ANY($1::text[]) FOR UPDATE`, [Array.from(byKey.keys())])
      // Only a coil the row changes is written: a field it does not carry keeps
      // the stored value, figures compared as stored (three decimals); a coil
      // marked deleted comes back, because the register says it is current.
      const changed = await tx.query<CoilState & { id: string; coilNumber: string; old: CoilState; restored: boolean }>(
        `UPDATE coils c SET
            grade = n.grade, sm_type = n.sm_type, supplier = n.supplier, thickness = n.thickness,
            width = n.width, yield = n.yield, notes = n.notes, heat_number = n.heat_number, product_form = n.product_form,
            length = n.length, tensile = n.tensile, elongation = n.elongation, mtc_number = n.mtc_number, deleted_at = NULL, deleted_by_id = NULL
          FROM (SELECT p.id, p.deleted_at,
                       jsonb_build_object('grade', p.grade, 'smType', p.sm_type, 'supplier', p.supplier, 'thickness', p.thickness,
                                          'width', p.width, 'yield', p.yield, 'notes', p.notes, 'heatNumber', p.heat_number,
                                          'productForm', p.product_form, 'length', p.length, 'tensile', p.tensile,
                                          'elongation', p.elongation, 'mtcNumber', p.mtc_number) AS old,
                       COALESCE(i.grade, p.grade) AS grade, COALESCE(i.sm_type, p.sm_type) AS sm_type,
                       COALESCE(i.supplier, p.supplier) AS supplier,
                       COALESCE(i.thickness, p.thickness)::numeric(10, 3) AS thickness, COALESCE(i.width, p.width)::numeric(10, 3) AS width,
                       COALESCE(i.yield, p.yield)::numeric(10, 3) AS yield, COALESCE(i.notes, p.notes) AS notes,
                       COALESCE(i.heat_number, p.heat_number) AS heat_number, COALESCE(i.product_form, p.product_form) AS product_form,
                       COALESCE(i.length, p.length)::numeric(10, 3) AS length, COALESCE(i.tensile, p.tensile)::numeric(10, 3) AS tensile,
                       COALESCE(i.elongation, p.elongation)::numeric(10, 3) AS elongation, COALESCE(i.mtc_number, p.mtc_number) AS mtc_number,
                       p.grade AS was_grade, p.sm_type AS was_sm_type, p.supplier AS was_supplier, p.thickness AS was_thickness,
                       p.width AS was_width, p.yield AS was_yield, p.notes AS was_notes, p.heat_number AS was_heat_number,
                       p.product_form AS was_product_form, p.length AS was_length, p.tensile AS was_tensile,
                       p.elongation AS was_elongation, p.mtc_number AS was_mtc_number
                  FROM coils p JOIN ${recordset} ON lower(p.coil_number) = lower(i.coil_number)) n
         WHERE c.id = n.id
           AND (n.deleted_at IS NOT NULL
                OR (n.grade, n.sm_type, n.supplier, n.thickness, n.width, n.yield, n.notes,
                    n.heat_number, n.product_form, n.length, n.tensile, n.elongation, n.mtc_number)
                   IS DISTINCT FROM (n.was_grade, n.was_sm_type, n.was_supplier, n.was_thickness, n.was_width, n.was_yield, n.was_notes,
                    n.was_heat_number, n.was_product_form, n.was_length, n.was_tensile, n.was_elongation, n.was_mtc_number))
         RETURNING c.id, c.coil_number AS "coilNumber", n.old, n.deleted_at IS NOT NULL AS restored,
                   c.grade, c.sm_type AS "smType", c.supplier, c.thickness, c.width, c.yield, c.notes, c.heat_number AS "heatNumber",
                   c.product_form AS "productForm", c.length, c.tensile, c.elongation, c.mtc_number AS "mtcNumber"`,
        [payload],
      )
      const inserted = await tx.query<{ id: string; coilNumber: string }>(
        `INSERT INTO coils (coil_number, grade, sm_type, supplier, thickness, width, yield, notes, heat_number, product_form, length, tensile, elongation, mtc_number)
         SELECT i.coil_number, i.grade, i.sm_type, i.supplier, i.thickness, i.width, i.yield, i.notes,
                i.heat_number, i.product_form, i.length, i.tensile, i.elongation, i.mtc_number
           FROM ${recordset}
          WHERE NOT EXISTS (SELECT 1 FROM coils c WHERE lower(c.coil_number) = lower(i.coil_number))
         RETURNING id, coil_number AS "coilNumber"`,
        [payload],
      )
      const at = new Date().toISOString()
      const auditCtx = (id: string) => ({ userId: user.id, userName: user.name, entity: 'Coil', entityId: id })
      const unchanged = (matched.rowCount ?? 0) - changed.rows.length
      // One summary for the batch, then each coil's own trail, field by field, as an MTC upload writes it.
      const entries: AuditDraft[] = [
        auditEvent('update', auditCtx('bulk-import'), at, {
          field: 'import',
          newValue: `${inserted.rows.length} inserted, ${changed.rows.length} updated, ${unchanged} unchanged`,
        }),
      ]
      for (const c of inserted.rows) entries.push(auditEvent('create', auditCtx(c.id), at, { field: 'source', newValue: `${IMPORT_SOURCE}: ${c.coilNumber}` }))
      for (const c of changed.rows) {
        if (c.restored) entries.push(auditEvent('restore', auditCtx(c.id), at, { field: 'source', newValue: IMPORT_SOURCE }))
        for (const field of COIL_FIELDS) {
          const before = auditText(c.old[field])
          const after = auditText(c[field])
          if (before !== after) entries.push(auditEvent('update', auditCtx(c.id), at, { field, oldValue: before, newValue: after }))
        }
      }
      for (let i = 0; i < entries.length; i += AUDIT_CHUNK) await writeAudit(tx, entries.slice(i, i + AUDIT_CHUNK))
      // Their certified strengths against their grade, as an MTC upload judges them.
      await judgeCoils(tx, [...inserted.rows.map((c) => c.id), ...changed.rows.map((c) => c.id)])
      const body: ImportResult = { inserted: inserted.rows.length, updated: changed.rows.length, unchanged }
      return body
    })
    res.json(result)
  })

  return r
}
