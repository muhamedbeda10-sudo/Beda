// §11 — the audit browser. Supervisors and admins read; only an admin may
// mark entries purged, and that purge is itself an audit entry.
//
// §20 — the AI assistant's own entries (its settings, its key, who may use
// it, the saved reports) are the assistant owner's alone: to anyone else they
// are not in the log at all — not listed, counted, offered as a filter value
// or purgeable.

import { Router } from 'express'
import { z } from 'zod'
import type { AuditListResponse, AuditOptionsResponse, AuditStats } from '@qc/shared/api'
import { AUDIT_ACTIONS, type AuditAction, type AuditEntry } from '@qc/shared/types'
import type { AppContext } from '../context'
import { withTransaction } from '../db/pool'
import { parse } from '../lib/validate'
import { requireCapability, requireUser } from '../auth/middleware'
import { currentAiOwner } from '../ai/owner'
import { writeAudit } from '../audit/service'
import { dropNulls } from '../lib/rows'
import { columnFilterClauses, columnOrderBy, columnQuerySchema, columnValues, type SqlColumns } from '../lib/columnFilters'

const AUDIT_SELECT = `
  id::text AS id, at, user_id AS "userId", user_name AS "userName", action, entity, entity_id AS "entityId",
  field, old_value AS "oldValue", new_value AS "newValue", order_number AS "orderNumber", item,
  work_center_code AS "workCenterCode", session_id AS "sessionId", sample_id AS "sampleId"`

/** The log's own filters; Excel's column filters and sort ride along. */
const auditFilterSchema = z
  .object({
    q: z.string().trim().max(120).optional(),
    action: z.enum(AUDIT_ACTIONS).optional(),
    userName: z.string().trim().max(120).optional(),
    entity: z.string().trim().max(60).optional(),
    since: z.string().datetime({ offset: true }).optional(),
  })
  .merge(columnQuerySchema)

/** The columns as the log's table shows them: the text a cell reads, and what the time sorts by. */
function auditColumns(tz: string): SqlColumns {
  return {
    at: { text: `to_char(at AT TIME ZONE '${tz.replace(/'/g, "''")}', 'YYYY-MM-DD')`, sort: 'at' },
    user: { text: 'user_name' },
    action: { text: 'action::text' },
    entity: { text: 'entity' },
    entityId: { text: `COALESCE(entity_id, '')` },
    field: { text: `COALESCE(field, '')` },
    oldValue: { text: `COALESCE(old_value, '')` },
    newValue: { text: `COALESCE(new_value, '')` },
    order: { text: `COALESCE(order_number, '')` },
    item: { text: `COALESCE(item, '')` },
    machine: { text: `COALESCE(work_center_code, '')` },
  }
}

/** The assistant's own entries, its automations' included (§21), which only its owner sees. */
const AI_ENTRIES = `(entity IN ('AiAssistant', 'AiAccess', 'AiReport', 'Automation') OR (entity = 'AppSettings' AND entity_id LIKE 'ai%'))`

/** The entries a reader of the log may see: everything but the assistant's own, unless they own it. */
const visible = (aiOwner: boolean) => (aiOwner ? 'deleted_at IS NULL' : `deleted_at IS NULL AND NOT ${AI_ENTRIES}`)

/** The WHERE clauses of the log's own filters, over audit_log. */
function auditWhere(q: z.infer<typeof auditFilterSchema>, p: (v: unknown) => string, aiOwner: boolean): string[] {
  const clauses = [visible(aiOwner)]
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
  return clauses
}

export function auditRoutes(ctx: AppContext): Router {
  const r = Router()
  r.use(requireCapability('edit-closed-session'))

  /** Whether the reader owns the assistant, read again on every request. Nothing is pinned from here. */
  const ownsAi = async (userId: string) => (await currentAiOwner(ctx.db, ctx.config)) === userId

  /**
   * §11 — a page of the log, newest first. The filters are applied here, in
   * SQL, over every entry: the log is the one table that grows without bound,
   * and a change from last season has to be findable as easily as one from
   * this morning.
   */
  r.get('/', async (req, res) => {
    const aiOwner = await ownsAi(requireUser(req).id)
    const q = parse(
      auditFilterSchema.extend({
        limit: z.coerce.number().int().min(1).max(2000).default(200),
        /** The last entry of the page already read: (at, id) of it. */
        before: z.string().datetime({ offset: true }).optional(),
        beforeId: z.string().regex(/^\d+$/).optional(),
        /** With a column sort, pages walk by position instead. */
        offset: z.coerce.number().int().min(0).max(100000).default(0),
      }),
      req.query,
    )

    const params: unknown[] = []
    const p = (v: unknown) => `$${params.push(v)}`
    const columns = auditColumns(ctx.config.FACTORY_TIMEZONE)
    const where = [...auditWhere(q, p, aiOwner), ...columnFilterClauses(columns, q.cf, p)].join(' AND ')
    const filterParams = [...params]
    // Newest first, walked back by (at, id); sorted by a column, walked by position.
    const sorted = !!q.sort
    const keyset = !sorted && q.before && q.beforeId
    // The cursor is not a filter: the total counts the whole match.
    const paged = keyset ? `${where} AND (at, id) < (${p(q.before)}::timestamptz, ${p(q.beforeId)}::bigint)` : where
    const orderBy = columnOrderBy(columns, q.sort, 'at DESC, id DESC')
    const limit = p(q.limit + 1) // One more than asked for, to know whether older ones remain.
    const offset = sorted ? ` OFFSET ${p(q.offset)}` : ''
    const firstPage = sorted ? q.offset === 0 : !keyset

    const [page, counted] = await Promise.all([
      ctx.db.query<AuditEntry>(`SELECT ${AUDIT_SELECT} FROM audit_log WHERE ${paged} ORDER BY ${orderBy} LIMIT ${limit}${offset}`, params),
      firstPage ? ctx.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE ${where}`, filterParams) : null,
    ])

    const body: AuditListResponse = { entries: page.rows.slice(0, q.limit).map(dropNulls), hasMore: page.rows.length > q.limit }
    if (counted) body.total = counted.rows[0].n
    res.json(body)
  })

  /** One column's values under every other filter, over the whole log, for its Excel menu. */
  r.get('/values', async (req, res) => {
    const aiOwner = await ownsAi(requireUser(req).id)
    const q = parse(auditFilterSchema.extend({ column: z.string().max(60), search: z.string().max(200).optional() }), req.query)
    const params: unknown[] = []
    const p = (v: unknown) => `$${params.push(v)}`
    const where = auditWhere(q, p, aiOwner)
    res.json(await columnValues(ctx.db, { columns: auditColumns(ctx.config.FACTORY_TIMEZONE), column: q.column, from: 'FROM audit_log', where, params, filters: q.cf, search: q.search }))
  })

  /** §11 — who appears in the log and what they touched, over the whole log,
   *  so the filters are never limited to the page on screen. */
  r.get('/options', async (req, res) => {
    const where = visible(await ownsAi(requireUser(req).id))
    const [users, entities] = await Promise.all([
      // The system sender (§21) writes entries (a follow-up opened, escalated) but is nobody to filter by.
      ctx.db.query<{ name: string }>(
        `SELECT DISTINCT user_name AS name FROM audit_log
          WHERE ${where} AND user_id IS DISTINCT FROM (SELECT id FROM users WHERE is_system)
          ORDER BY name`,
      ),
      ctx.db.query<{ entity: string }>(`SELECT DISTINCT entity FROM audit_log WHERE ${where} ORDER BY entity`),
    ])
    const body: AuditOptionsResponse = { users: users.rows.map((u) => u.name), entities: entities.rows.map((e) => e.entity) }
    res.json(body)
  })

  r.get('/stats', async (req, res) => {
    const where = visible(await ownsAi(requireUser(req).id))
    const { rows } = await ctx.db.query<{ action: AuditAction; n: number }>(`SELECT action, count(*)::int AS n FROM audit_log WHERE ${where} GROUP BY action`)
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
    // Only entries the reader can see: an id guessed at cannot reach the assistant's own.
    const where = visible(await ownsAi(user.id))
    const marked = await withTransaction(ctx.db, async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE audit_log SET deleted_at = now(), deleted_by_id = $2, deleted_by_name = $3
          WHERE id = ANY($1::bigint[]) AND ${where}`,
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
