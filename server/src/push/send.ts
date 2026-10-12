// ============================================================================
// §24 — sending pushes: each message to every device its person turned
// notifications on for, signed with the server's VAPID keys. A device the
// push service says is gone (404, 410) is forgotten at once; any other
// failure is logged and not retried — a notification late by minutes is
// worth less than none, and the bell and the chat still hold everything.
// ============================================================================

import webpush from 'web-push'
import type { PushPayload } from '@qc/shared/api'
import type { Config } from '../config'
import type { Queryable } from '../db/pool'
import { clipText } from '../automations/notify'
import { vapidKeys, vapidSubject } from './keys'

/** One device's push subscription. */
export interface PushTarget {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

export interface PushOptions {
  /** Seconds the push service keeps it for a device that is off. */
  TTL: number
  urgency: 'very-low' | 'low' | 'normal' | 'high'
  vapidDetails: { subject: string; publicKey: string; privateKey: string }
  timeout: number
}

/** Sends one push; resolves with the push service's status, or rejects with an error carrying statusCode. */
export type PushSender = (target: PushTarget, payload: string, options: PushOptions) => Promise<{ statusCode: number }>

export const webPushSender: PushSender = (target, payload, options) => webpush.sendNotification(target, payload, options)

export interface PushMessage {
  userId: string
  payload: PushPayload
}

/** The push services browsers use (Chrome, Edge, Firefox, Safari): a device's endpoint is one of them, never anything else. */
const PUSH_SERVICE_HOST = /^https:\/\/(fcm\.googleapis\.com|[a-z0-9-]+\.push\.services\.mozilla\.com|updates\.push\.services\.mozilla\.com|[a-z0-9.-]+\.notify\.windows\.com|web\.push\.apple\.com|[a-z0-9.-]+\.push\.apple\.com)\//i

export const isPushEndpoint = (endpoint: string): boolean => endpoint.length <= 2000 && PUSH_SERVICE_HOST.test(endpoint)

export const PUSH_TITLE_MAX = 120
export const PUSH_BODY_MAX = 240
/** How long a push waits for a device that is switched off: past a shift, it is old news. */
const PUSH_TTL_SECONDS = 6 * 3600
const SEND_TIMEOUT_MS = 10_000
const PARALLEL = 10

/** A payload kept within what a notification shows (and a push may carry). */
export function shapePayload(p: PushPayload): PushPayload {
  return {
    ...p,
    title: clipText(p.title.replace(/\s+/g, ' ').trim(), PUSH_TITLE_MAX) || 'LinkMisr QC',
    body: clipText(p.body.replace(/[ \t]+/g, ' ').trim(), PUSH_BODY_MAX),
  }
}

/**
 * Send each message to every device of its person. Returns how many pushes
 * the push services accepted. Never throws for a device's sake.
 */
export async function sendPushes(q: Queryable, config: Config, messages: PushMessage[], send: PushSender): Promise<number> {
  if (!config.PUSH_ENABLED || messages.length === 0) return 0
  const userIds = [...new Set(messages.map((m) => m.userId))]
  const { rows } = await q.query<{ id: string; userId: string; endpoint: string; p256dh: string; auth: string }>(
    `SELECT id, user_id AS "userId", endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ANY($1::uuid[])`,
    [userIds],
  )
  if (rows.length === 0) return 0
  const keys = await vapidKeys(q, config)
  const vapidDetails = { subject: await vapidSubject(q, config), publicKey: keys.publicKey, privateKey: keys.privateKey }
  const devicesOf = new Map<string, typeof rows>()
  for (const r of rows) devicesOf.set(r.userId, [...(devicesOf.get(r.userId) ?? []), r])

  const jobs = messages.flatMap((m) => {
    const payload = shapePayload(m.payload)
    const urgency: PushOptions['urgency'] = payload.severity === 'critical' || payload.kind === 'chat' ? 'high' : 'normal'
    return (devicesOf.get(m.userId) ?? []).map((d) => ({ d, body: JSON.stringify(payload), urgency }))
  })
  let accepted = 0
  const gone: string[] = []
  const reached: string[] = []
  for (let i = 0; i < jobs.length; i += PARALLEL) {
    await Promise.all(
      jobs.slice(i, i + PARALLEL).map(async ({ d, body, urgency }) => {
        try {
          await send({ endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: d.auth } }, body, { TTL: PUSH_TTL_SECONDS, urgency, vapidDetails, timeout: SEND_TIMEOUT_MS })
          accepted++
          reached.push(d.id)
        } catch (e) {
          const status = (e as { statusCode?: number }).statusCode
          if (status === 404 || status === 410) gone.push(d.id)
          else console.warn(`[push] a push was not accepted (${status ?? 'no answer'}): ${e instanceof Error ? e.message : String(e)}`)
        }
      }),
    )
  }
  if (gone.length > 0) await q.query(`DELETE FROM push_subscriptions WHERE id = ANY($1::uuid[])`, [gone])
  if (reached.length > 0) await q.query(`UPDATE push_subscriptions SET last_sent_at = now() WHERE id = ANY($1::uuid[])`, [[...new Set(reached)]])
  return accepted
}
