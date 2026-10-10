// ============================================================================
// §21 — the bell's alerts (automations/notify.ts): each person reads and
// clears their own, and nobody else's. An id that is not theirs is "not
// found", never a hint that it exists.
// ============================================================================

import { Router } from 'express'
import { z } from 'zod'
import type { UserNotification, UserNotificationsResponse } from '@qc/shared/automation'
import type { AppContext } from '../context'
import { notFound } from '../lib/errors'
import { parse } from '../lib/validate'
import { requireUser } from '../auth/middleware'

const uuid = z.string().uuid()
const PAGE = 30

const NOTIFICATION_SELECT = `n.id, n.kind, n.severity, n.title, n.body, n.link, n.created_at AS "createdAt", n.read_at AS "readAt"`

export function notificationsRoutes(ctx: AppContext): Router {
  const r = Router()
  const db = ctx.db

  /** Newest first, walked back with `before` (the last one read): its (created_at, id) is where the page starts. */
  r.get('/', async (req, res) => {
    const user = requireUser(req)
    const q = parse(z.object({ before: uuid.optional(), limit: z.coerce.number().int().min(1).max(100).default(PAGE) }), req.query)
    const params: unknown[] = [user.id, q.limit + 1]
    // The cursor must be one of the reader's own; anyone else's finds nothing.
    const after = q.before
      ? `AND (n.created_at, n.id) < (SELECT c.created_at, c.id FROM user_notifications c WHERE c.id = $${params.push(q.before)} AND c.user_id = $1)`
      : ''
    const [page, unread] = await Promise.all([
      db.query<UserNotification>(
        `SELECT ${NOTIFICATION_SELECT} FROM user_notifications n
          WHERE n.user_id = $1 ${after}
          ORDER BY n.created_at DESC, n.id DESC LIMIT $2`,
        params,
      ),
      db.query<{ n: number }>(`SELECT count(*)::int AS n FROM user_notifications WHERE user_id = $1 AND read_at IS NULL`, [user.id]),
    ])
    const body: UserNotificationsResponse = {
      notifications: page.rows.slice(0, q.limit),
      unreadCount: unread.rows[0].n,
      hasMore: page.rows.length > q.limit,
    }
    res.json(body)
  })

  r.post('/read-all', async (req, res) => {
    const user = requireUser(req)
    await db.query(`UPDATE user_notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`, [user.id])
    res.status(204).end()
  })

  /** Opened: read from now on. Reading it again changes nothing. */
  r.post('/:id/read', async (req, res) => {
    const user = requireUser(req)
    const id = parse(uuid, req.params.id)
    const { rowCount } = await db.query(`UPDATE user_notifications SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND user_id = $2`, [
      id,
      user.id,
    ])
    if (!rowCount) throw notFound('That alert')
    res.status(204).end()
  })

  return r
}
