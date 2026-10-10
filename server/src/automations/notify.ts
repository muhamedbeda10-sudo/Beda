// ============================================================================
// §21 — the bell's alerts: one row per person, read or not. What an
// automation finds, a report delivered, a follow-up assigned, overdue or
// changed. Not notices — those are an administrator's broadcasts, with
// acknowledgement — so a busy watch never buries them.
//
// Alerts are no record of anything: the engine removes those older than
// NOTIFICATION_RETENTION_DAYS once a day.
// ============================================================================

import type { UserNotificationKind } from '@qc/shared/automation'
import type { Queryable } from '../db/pool'
import { LIVE_PERSON, distinctIds, isUuid } from './people'

export interface NewNotification {
  kind: UserNotificationKind
  severity: 'info' | 'warning' | 'critical'
  title: string
  body: string
  /** A path in the app, e.g. /follow-ups/<id>; never another site. */
  link: string | null
  automationId?: string
  followUpId?: string
  deliveryId?: string
}

export const NOTIFICATION_RETENTION_DAYS = 90
export const NOTIFICATION_TITLE_MAX = 300
export const NOTIFICATION_BODY_MAX = 4000

/** What an alert is called when what it was given to say is blank (a template over empty cells). */
const FALLBACK_TITLES: Record<UserNotificationKind, string> = {
  'automation-case': 'New case',
  'automation-digest': 'New cases',
  'automation-report': 'Report delivered',
  'automation-stopped': 'An automation stopped',
  'follow-up-assigned': 'A follow-up was assigned to you',
  'follow-up-overdue': 'A follow-up is overdue',
  'follow-up-updated': 'A follow-up was updated',
}

const KINDS = new Set(Object.keys(FALLBACK_TITLES))
const SEVERITIES = new Set(['info', 'warning', 'critical'])
/** A path inside the app: one leading slash, no scheme, no host, no spaces, no backslash (which browsers read as a slash). */
const IN_APP_LINK = /^\/(?!\/)[^\s\\]*$/

/** Text cut to a length, with an ellipsis when something was cut. Values from a query's rows can be any size. */
export function clipText(text: string, max: number): string {
  const chars = Array.from(text)
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('').trimEnd()}…`
}

/**
 * One alert for each of these people who can be told: the ids each once,
 * leaving out accounts that are deactivated, removed or the system sender.
 * Returns the rows written. A link outside the app, an unknown kind or a
 * malformed id is a fault of the caller and throws.
 */
export async function createNotifications(q: Queryable, userIds: string[], n: NewNotification): Promise<number> {
  if (!KINDS.has(n.kind)) throw new Error(`Unknown notification kind: ${String(n.kind)}`)
  if (!SEVERITIES.has(n.severity)) throw new Error(`Unknown notification severity: ${String(n.severity)}`)
  if (n.link !== null && !IN_APP_LINK.test(n.link)) throw new Error(`A notification links inside the app only: ${n.link}`)
  for (const [field, id] of [['automationId', n.automationId], ['followUpId', n.followUpId], ['deliveryId', n.deliveryId]] as const) {
    if (id !== undefined && !isUuid(id)) throw new Error(`A notification's ${field} must be a uuid: ${id}`)
  }
  const ids = distinctIds(userIds)
  if (ids.length === 0) return 0
  const title = clipText(n.title.replace(/\s+/g, ' ').trim(), NOTIFICATION_TITLE_MAX) || FALLBACK_TITLES[n.kind]
  const body = clipText(n.body.trim(), NOTIFICATION_BODY_MAX)
  const { rowCount } = await q.query(
    `INSERT INTO user_notifications (user_id, kind, severity, title, body, link, automation_id, follow_up_id, delivery_id)
     SELECT u.id, $2, $3, $4, $5, $6, $7, $8, $9 FROM users u
      WHERE u.id = ANY($1::uuid[]) AND ${LIVE_PERSON}`,
    [ids, n.kind, n.severity, title, body, n.link, n.automationId ?? null, n.followUpId ?? null, n.deliveryId ?? null],
  )
  return rowCount ?? 0
}

/** Remove alerts older than NOTIFICATION_RETENTION_DAYS before `now`, read or not. Returns how many went. */
export async function purgeNotifications(q: Queryable, now: Date = new Date()): Promise<number> {
  const { rowCount } = await q.query(`DELETE FROM user_notifications WHERE created_at < $1::timestamptz - make_interval(days => $2)`, [
    now.toISOString(),
    NOTIFICATION_RETENTION_DAYS,
  ])
  return rowCount ?? 0
}
