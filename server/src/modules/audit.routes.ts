// §11 — the audit browser. Supervisors and admins read; only an admin may
// mark entries purged, and that purge is itself an audit entry.

import { Router } from 'express'
import { z } from 'zod'
import type { AuditListResponse, AuditStats } from '@qc/shared/api'
import type { AuditAction, AuditEntry } from '@qc/shared/types'
import type { AppContext } from '../context'
import { withTransaction } from '../db/pool'
import { parse } from '../lib/validate'
import { requireCapability, requireUser } from '../auth/middleware'
import { writeAudit } from '../audit/service'
import { dropNulls } from '../lib/rows'

const AUDIT_SELECT = `
  id::text AS id, at, user_id AS "userId", user_name AS "userName", action, entity, entity_id AS "entityId",
  field, old_value AS "oldValue", new_value AS "newValue", order_number AS "orderNumber", item,
  work_center_code AS "workCenterCode", session_id AS "sessionId", sample_id AS "sampleId"`

export function auditRoutes(ctx: AppContext): Router {
  const r = Router()
  r.use(requireCapability('edit-closed-session'))

  r.get('/', async (req, res) => {
    const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(2000).default(500) }), req.query)
    const { rows } = await ctx.db.query<AuditEntry>(
      `SELECT ${AUDIT_SELECT} FROM audit_log WHERE deleted_at IS NULL ORDER BY at DESC, id DESC LIMIT $1`,
      [q.limit],
    )
    const body: AuditListResponse = { entries: rows.map(dropNulls) }
    res.json(body)
  })

  r.get('/stats', async (_req, res) => {
    const { rows } = await ctx.db.query<{ action: AuditAction; n: number }>(
      `SELECT action, count(*)::int AS n FROM audit_log WHERE deleted_at IS NULL GROUP BY action`,
    )
    const byAction: Partial<Record<AuditAction, number>> = {}
    let total = 0
    for (const row of rows) {
      byAction[row.action] = row.n
      total += row.n
    }
    const body: AuditStats = { total, byAction }
    res.json(body)
  })

  r.post('/purge', requireCapability('purge-audit-logs'), async (req, res) => {
    const user = requireUser(req)
    const { ids } = parse(z.object({ ids: z.array(z.string().regex(/^\d+$/)).min(1).max(1000) }), req.body)
    const marked = await withTransaction(ctx.db, async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE audit_log SET deleted_at = now(), deleted_by_id = $2, deleted_by_name = $3
          WHERE id = ANY($1::bigint[]) AND deleted_at IS NULL`,
        [ids, user.id, user.name],
      )
      await writeAudit(tx, [
        {
          at: new Date().toISOString(),
          userId: user.id,
          userName: user.name,
          action: 'purge',
          entity: 'AuditLog',
          entityId: `${rowCount ?? 0} entries`,
          newValue: `Marked ${rowCount ?? 0} audit entries deleted`,
        },
      ])
      return rowCount ?? 0
    })
    res.json({ marked })
  })

  return r
}
