// ============================================================================
// §21 — the bell's alerts (automations/notify.ts): each person reads and
// clears their own, and nobody else's. An id that is not theirs is "not
// found", never a hint that it exists.
//
// The bell shows them as two lists, Alerts and Reports (the scheduled reports
// delivered): `category` picks one for the page, its unread count and "mark
// all as read". Without it, all of them, as before.
// ============================================================================

import { Router } from 'express'
import { z } from 'zod'
import {
  REPORT_NOTIFICATION_KINDS,
  USER_NOTIFICATION_CATEGORIES,
  type UserNotification,
  type UserNotificationCategory,
  type UserNotificationsResponse,
} from '@qc/shared/automation'
import type { AppContext } from '../context'
import { notFound } from '../lib/errors'
import { parse } from '../lib/validate'
import { requireUser } from '../auth/middleware'

const uuid = z.string().uuid()
const PAGE = 30

const NOTIFICATION_SELECT = `n.id, n.kind, n.severity, n.title, n.body, n.link, n.created_at AS "createdAt", n.read_at AS "readAt"`

const categoryQuery = z.object({ category: z.enum(USER_NOTIFICATION_CATEGORIES).optional() })

/** The condition that keeps one category's rows, its kinds added to `params`; none for every category. */
function categoryFilter(category: UserNotificationCategory | undefined, params: unknown[]): string {
  if (!category) return ''
  const kinds = `$${params.push(REPORT_NOTIFICATION_KINDS)}::text[]`
  return category === 'reports' ? `AND kind = ANY(${kinds})` : `AND kind <> ALL(${kinds})`
}

export function notificationsRoutes(ctx: AppContext): Router {
  const r = Router()
  const db = ctx.db

  /** Newest first, walked back with `before` (the last one read): its (created_at, id) is where the page starts. */
  r.get('/', async (req, res) => {
    const user = requireUser(req)
    const q = parse(categoryQuery.extend({ before: uuid.optional(), limit: z.coerce.number().int().min(1).max(100).default(PAGE) }), req.query)
    const params: unknown[] = [user.id, q.limit + 1]
    const kinds = categoryFilter(q.category, params)
    // The cursor must be one of the reader's own; anyone else's finds nothing.
    const after = q.before
      ? `AND (n.created_at, n.id) < (SELECT c.created_at, c.id FROM user_notifications c WHERE c.id = $${params.push(q.before)} AND c.user_id = $1)`
      : ''
    const unreadParams: unknown[] = [user.id]
    const [page, unread] = await Promise.all([
      db.query<UserNotification>(
        `SELECT ${NOTIFICATION_SELECT} FROM user_notifications n
          WHERE n.user_id = $1 ${kinds} ${after}
          ORDER BY n.created_at DESC, n.id DESC LIMIT $2`,
        params,
      ),
      db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM user_notifications WHERE user_id = $1 AND read_at IS NULL ${categoryFilter(q.category, unreadParams)}`,
        unreadParams,
      ),
    ])
    const body: UserNotificationsResponse = {
      notifications: page.rows.slice(0, q.limit),
      unreadCount: unread.rows[0].n,
      hasMore: page.rows.length > q.limit,
    }
    res.json(body)
  })

  /** Every one not read yet, or every one of a category (?category=reports): the bell's "Mark all as read" on one tab. */
  r.post('/read-all', async (req, res) => {
    const user = requireUser(req)
    const q = parse(categoryQuery, req.query)
    const params: unknown[] = [user.id]
    await db.query(`UPDATE user_notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL ${categoryFilter(q.category, params)}`, params)
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
