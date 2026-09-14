// §11 — the audit browser. Supervisors and admins read; only an admin may
// mark entries purged, and that purge is itself an audit entry.

import { Router } from 'express'
import { z } from 'zod'
import type { AuditListResponse, AuditOptionsResponse, AuditStats } from '@qc/shared/api'
import { AUDIT_ACTIONS, type AuditAction, type AuditEntry } from '@qc/shared/types'
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

  /**
   * §11 — a page of the log, newest first. The filters are applied here, in
   * SQL, over every entry: the log is the one table that grows without bound,
   * and a change from last season has to be findable as easily as one from
   * this morning.
   */
  r.get('/', async (req, res) => {
    const q = parse(
      z.object({
        limit: z.coerce.number().int().min(1).max(2000).default(200),
        /** The last entry of the page already read: (at, id) of it. */
        before: z.string().datetime({ offset: true }).optional(),
        beforeId: z.string().regex(/^\d+$/).optional(),
        q: z.string().trim().max(120).optional(),
        action: z.enum(AUDIT_ACTIONS).optional(),
        userName: z.string().trim().max(120).optional(),
        entity: z.string().trim().max(60).optional(),
        since: z.string().datetime({ offset: true }).optional(),
      }),
      req.query,
    )

    const clauses = ['deleted_at IS NULL']
    const params: unknown[] = []
    const p = (v: unknown) => `$${params.push(v)}`

    if (q.action) clauses.push(`action = ${p(q.action)}`)
    if (q.userName) clauses.push(`user_name = ${p(q.userName)}`)
    if (q.entity) clauses.push(`entity = ${p(q.entity)}`)
    if (q.since) clauses.push(`at >= ${p(q.since)}::timestamptz`)
    if (q.q) {
      // What a person types is text: a typed % is a per-cent sign, not a wildcard.
      const t = p(`%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
      clauses.push(`(COALESCE(order_number, '') ILIKE ${t} OR COALESCE(item, '') ILIKE ${t} OR COALESCE(field, '') ILIKE ${t}
                     OR COALESCE(old_value, '') ILIKE ${t} OR COALESCE(new_value, '') ILIKE ${t}
                     OR COALESCE(work_center_code, '') ILIKE ${t} OR entity ILIKE ${t} OR user_name ILIKE ${t} OR entity_id ILIKE ${t})`)
    }

    const where = clauses.join(' AND ')
    const filterParams = [...params]
    // The cursor is not a filter: the total counts the whole match.
    const paged = q.before && q.beforeId ? `${where} AND (at, id) < (${p(q.before)}::timestamptz, ${p(q.beforeId)}::bigint)` : where
    const limit = p(q.limit + 1) // One more than asked for, to know whether older ones remain.

    const [page, counted] = await Promise.all([
      ctx.db.query<AuditEntry>(`SELECT ${AUDIT_SELECT} FROM audit_log WHERE ${paged} ORDER BY at DESC, id DESC LIMIT ${limit}`, params),
      q.before && q.beforeId
        ? null
        : ctx.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE ${where}`, filterParams),
    ])

    const body: AuditListResponse = { entries: page.rows.slice(0, q.limit).map(dropNulls), hasMore: page.rows.length > q.limit }
    if (counted) body.total = counted.rows[0].n
    res.json(body)
  })

  /** §11 — who appears in the log and what they touched, over the whole log,
   *  so the filters are never limited to the page on screen. */
  r.get('/options', async (_req, res) => {
    const [users, entities] = await Promise.all([
      ctx.db.query<{ name: string }>(`SELECT DISTINCT user_name AS name FROM audit_log WHERE deleted_at IS NULL ORDER BY name`),
      ctx.db.query<{ entity: string }>(`SELECT DISTINCT entity FROM audit_log WHERE deleted_at IS NULL ORDER BY entity`),
    ])
    const body: AuditOptionsResponse = { users: users.rows.map((u) => u.name), entities: entities.rows.map((e) => e.entity) }
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
