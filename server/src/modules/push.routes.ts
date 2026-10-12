// ============================================================================
// §24 — a device's push notifications: the key it subscribes with, turning
// them on (the device's subscription, for the person signed in) and off, and
// a test push to one's own devices. Anyone signed in; a device belongs to the
// last person who turned notifications on with it, and signing out turns it off.
// ============================================================================

import { Router } from 'express'
import { z } from 'zod'
import type { PushConfigResponse } from '@qc/shared/api'
import type { AppContext } from '../context'
import { HttpError, badRequest } from '../lib/errors'
import { parse } from '../lib/validate'
import { requireUser } from '../auth/middleware'
import { rememberOrigin, vapidKeys } from '../push/keys'
import { isPushEndpoint, sendPushes, webPushSender } from '../push/send'

/** Devices one person may have notifications on: the oldest beyond this are forgotten. */
export const PUSH_DEVICES_PER_PERSON = 10
/** A test push at most this often per person. */
const TEST_EVERY_MS = 10_000

const base64url = (max: number) => z.string().trim().min(8).max(max).regex(/^[A-Za-z0-9_-]+=*$/, 'Not a base64url key.')
const subscribeSchema = z.object({
  endpoint: z.string().trim().url().refine(isPushEndpoint, 'That is not a push service this app sends to.'),
  keys: z.object({ p256dh: base64url(200), auth: base64url(100) }),
  expirationTime: z.number().nullable().optional(),
})
const unsubscribeSchema = z.object({ endpoint: z.string().trim().min(1).max(2000) })

export function pushRoutes(ctx: AppContext): Router {
  const r = Router()
  const db = ctx.db
  const send = ctx.pushSender ?? webPushSender
  const lastTest = new Map<string, number>()

  r.get('/config', async (_req, res) => {
    const body: PushConfigResponse = ctx.config.PUSH_ENABLED ? { enabled: true, publicKey: (await vapidKeys(db, ctx.config)).publicKey } : { enabled: false, publicKey: null }
    res.json(body)
  })

  r.post('/subscriptions', async (req, res) => {
    const user = requireUser(req)
    if (!ctx.config.PUSH_ENABLED) throw new HttpError(409, 'conflict', 'Notifications are switched off on this server.')
    const body = parse(subscribeSchema, req.body)
    await db.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
                                            user_agent = EXCLUDED.user_agent, updated_at = now()`,
      [user.id, body.endpoint, body.keys.p256dh, body.keys.auth, String(req.get('user-agent') ?? '').slice(0, 300)],
    )
    await db.query(
      `DELETE FROM push_subscriptions WHERE user_id = $1 AND id NOT IN
         (SELECT id FROM push_subscriptions WHERE user_id = $1 ORDER BY updated_at DESC, id LIMIT $2)`,
      [user.id, PUSH_DEVICES_PER_PERSON],
    )
    await rememberOrigin(db, req.get('origin'))
    res.status(204).end()
  })

  r.delete('/subscriptions', async (req, res) => {
    const user = requireUser(req)
    const body = parse(unsubscribeSchema, req.body)
    await db.query(`DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2`, [body.endpoint, user.id])
    res.status(204).end()
  })

  /** A test notification to every device the person turned notifications on for. */
  r.post('/test', async (req, res) => {
    const user = requireUser(req)
    const last = lastTest.get(user.id) ?? 0
    if (Date.now() - last < TEST_EVERY_MS) throw new HttpError(429, 'rate_limited', 'A test was just sent. Try again in a few seconds.')
    lastTest.set(user.id, Date.now())
    const sent = await sendPushes(db, ctx.config, [{ userId: user.id, payload: { kind: 'test', title: 'Notifications are on', body: 'This device will be told about alerts, chat messages and notices.', url: '/', tag: 'test', severity: 'info' } }], send)
    if (sent === 0) throw badRequest('No device of yours has notifications on, or the push service did not accept it.')
    res.json({ sent })
  })

  return r
}
