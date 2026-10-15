// ============================================================================
// Coils — the raw-material catalogue and its traceability (coil → sample →
// order → customer).
// ============================================================================

import { Router } from 'express'
import { z } from 'zod'
import { EXISTING_KEYS_MAX, type CoilUsage, type ExistingKeysResponse, type ImportResult } from '@qc/shared/api'
import type { Coil } from '@qc/shared/types'
import type { AppContext } from '../context'
import { withTransaction } from '../db/pool'
import { parse } from '../lib/validate'
import { requireAnyPermission, requirePermission, requireUser } from '../auth/middleware'
import { writeAudit } from '../audit/service'
import { dropNulls, normaliseKey } from '../lib/rows'

const COIL_SELECT = `id, coil_number AS "coilNumber", grade, sm_type AS "smType", supplier, thickness, width, yield, notes, deleted_at AS "deletedAt"`

const importRow = z.object({
  coilNumber: z.string().trim().min(1).max(120),
  grade: z.string().trim().max(60).optional(),
  smType: z.string().trim().max(60).optional(),
  supplier: z.string().trim().max(200).optional(),
  thickness: z.coerce.number().min(0).optional(),
  width: z.coerce.number().min(0).optional(),
  yield: z.coerce.number().min(0).optional(),
  notes: z.string().trim().max(1000).optional(),
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

  /** §7.7 — idempotent upsert on the coil number. */
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
      })),
    )
    const recordset = `jsonb_to_recordset($1::jsonb) AS i(
      coil_number text, grade text, sm_type text, supplier text, thickness numeric, width numeric, yield numeric, notes text)`

    const result = await withTransaction(ctx.db, async (tx) => {
      const updated = await tx.query(
        `UPDATE coils c SET
            grade = COALESCE(i.grade, c.grade), sm_type = COALESCE(i.sm_type, c.sm_type),
            supplier = COALESCE(i.supplier, c.supplier), thickness = COALESCE(i.thickness, c.thickness),
            width = COALESCE(i.width, c.width), yield = COALESCE(i.yield, c.yield), notes = COALESCE(i.notes, c.notes),
            deleted_at = NULL, deleted_by_id = NULL
          FROM ${recordset}
         WHERE lower(c.coil_number) = lower(i.coil_number)`,
        [payload],
      )
      const inserted = await tx.query(
        `INSERT INTO coils (coil_number, grade, sm_type, supplier, thickness, width, yield, notes)
         SELECT i.coil_number, i.grade, i.sm_type, i.supplier, i.thickness, i.width, i.yield, i.notes
           FROM ${recordset}
          WHERE NOT EXISTS (SELECT 1 FROM coils c WHERE lower(c.coil_number) = lower(i.coil_number))`,
        [payload],
      )
      await writeAudit(tx, [
        {
          at: new Date().toISOString(),
          userId: user.id,
          userName: user.name,
          action: 'update',
          entity: 'Coil',
          entityId: 'bulk-import',
          field: 'import',
          newValue: `${inserted.rowCount ?? 0} inserted, ${updated.rowCount ?? 0} updated`,
        },
      ])
      const body: ImportResult = { inserted: inserted.rowCount ?? 0, updated: updated.rowCount ?? 0 }
      return body
    })
    res.json(result)
  })

  return r
}
