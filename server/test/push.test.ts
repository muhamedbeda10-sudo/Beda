import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ApiErrorBody, PushConfigResponse } from '@qc/shared/api'
import type { ChatConversation } from '@qc/shared/types'
import type { ChatConversationsResponse } from '@qc/shared/api'
import { createNotifications } from '../src/automations/notify'
import { STALE_EVENT_MS, chatNotification, dispatchOnce } from '../src/push/dispatcher'
import { TestApp, factoryDay, type Session } from './harness'

// §24 — notifications on a device with the app closed. A person turns them on
// for a device; the bell's alerts, chat messages (not one's own) and notices
// aimed at people reach that device's push service, once each. A device the
// push service says is gone is forgotten; signing out turns a device off.

const app = new TestApp()
let admin: Session
let insp: Session
let sup: Session
let viewer: Session

const endpoint = (name: string) => `https://fcm.googleapis.com/fcm/send/${name}-${randomUUID()}`
const keys = { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' }

async function subscribe(s: Session, ep: string) {
  return app.api<ApiErrorBody>('POST', '/api/push/subscriptions', { token: s.token, body: { endpoint: ep, keys }, headers: { origin: 'https://qc.example.org' } })
}
const dispatch = (now = new Date()) => dispatchOnce({ db: app.db, config: app.config }, app.pushSender, now)
const pushedTo = (ep: string) => app.pushes.filter((p) => p.endpoint === ep).map((p) => p.payload)
const sendChat = (s: Session, conv: string, body: string, extra: Record<string, unknown> = {}) =>
  app.api('POST', `/api/chat/conversations/${conv}/messages`, { token: s.token, body: { clientId: randomUUID(), body, ...extra } })

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  admin = await app.register('admin', 'Admin One')
  for (const [username, name, role] of [
    ['insp', 'Inspector One', 'inspector'],
    ['sup', 'Supervisor One', 'supervisor'],
    ['view', 'Viewer One', 'viewer'],
  ]) {
    expect((await app.api('POST', '/api/users', { token: admin.token, body: { username, password: 'Password#1', name, role } })).status).toBe(201)
  }
  insp = await app.login('insp')
  sup = await app.login('sup')
  viewer = await app.login('view')
})
afterAll(() => app.stop())
beforeEach(async () => {
  app.pushes = []
  app.gonePushEndpoints.clear()
  await app.db.query('DELETE FROM push_subscriptions')
  await app.db.query('DELETE FROM push_events')
})

describe('§24 a device turns notifications on and off', () => {
  it('gives the key to subscribe with, the same every time', async () => {
    const a = await app.api<PushConfigResponse>('GET', '/api/push/config', { token: insp.token })
    const b = await app.api<PushConfigResponse>('GET', '/api/push/config', { token: sup.token })
    expect(a.body.enabled).toBe(true)
    expect(a.body.publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/)
    expect(b.body.publicKey).toBe(a.body.publicKey)
    expect((await app.api('GET', '/api/push/config')).status).toBe(401)
  })

  it('accepts only a browser push service, and moves a device to whoever turned it on last', async () => {
    for (const bad of ['https://evil.example.com/push/1', 'http://fcm.googleapis.com/fcm/send/x', 'https://fcm.googleapis.com.evil.com/x']) {
      expect((await subscribe(insp, bad)).status, bad).toBe(400)
    }
    const ep = endpoint('tablet')
    expect((await subscribe(insp, ep)).status).toBe(204)
    expect((await subscribe(sup, ep)).status).toBe(204)
    const rows = (await app.db.query<{ userId: string }>(`SELECT user_id AS "userId" FROM push_subscriptions WHERE endpoint = $1`, [ep])).rows
    expect(rows).toEqual([{ userId: sup.user.id }])
    // Someone else cannot turn it off; its own person can.
    expect((await app.api('DELETE', '/api/push/subscriptions', { token: insp.token, body: { endpoint: ep } })).status).toBe(204)
    expect((await app.db.query(`SELECT 1 FROM push_subscriptions WHERE endpoint = $1`, [ep])).rowCount).toBe(1)
    expect((await app.api('DELETE', '/api/push/subscriptions', { token: sup.token, body: { endpoint: ep } })).status).toBe(204)
    expect((await app.db.query(`SELECT 1 FROM push_subscriptions WHERE endpoint = $1`, [ep])).rowCount).toBe(0)
  })

  it('sends a test to one’s own devices, and says so when there are none', async () => {
    expect((await app.api<ApiErrorBody>('POST', '/api/push/test', { token: viewer.token })).status).toBe(400)
    await new Promise((r) => setTimeout(r, 10))
    const ep = endpoint('phone')
    await subscribe(insp, ep)
    const res = await app.api<{ sent: number }>('POST', '/api/push/test', { token: insp.token })
    expect(res.body).toEqual({ sent: 1 })
    expect(pushedTo(ep)).toEqual([expect.objectContaining({ kind: 'test', title: 'Notifications are on', url: '/' })])
    expect((await app.api('POST', '/api/push/test', { token: insp.token })).status).toBe(429)
  })
})

describe('§24 what is pushed', () => {
  it('pushes a bell alert to its person only, and queues nothing while no device is subscribed', async () => {
    await createNotifications(app.db, [insp.user.id], { kind: 'follow-up-assigned', severity: 'warning', title: 'A follow-up for you', body: 'Hold on line 3', link: '/follow-ups' })
    expect((await app.db.query('SELECT 1 FROM push_events')).rowCount).toBe(0)
    const ep = endpoint('insp')
    await subscribe(insp, ep)
    await subscribe(sup, endpoint('sup'))
    await createNotifications(app.db, [insp.user.id], { kind: 'follow-up-assigned', severity: 'warning', title: 'A follow-up for you', body: 'Hold on line 3', link: '/follow-ups' })
    expect(await dispatch()).toBe(1)
    expect(app.pushes).toEqual([
      { endpoint: ep, payload: expect.objectContaining({ kind: 'alert', title: 'A follow-up for you', body: 'Hold on line 3', url: '/follow-ups', severity: 'warning' }) },
    ])
    // Each event once.
    expect(await dispatch()).toBe(0)
  })

  it('pushes a chat message to the other members, never to its sender, opening the conversation', async () => {
    const insEp = endpoint('insp')
    const supEp = endpoint('sup')
    const admEp = endpoint('admin')
    await subscribe(insp, insEp)
    await subscribe(sup, supEp)
    await subscribe(admin, admEp)
    const direct = (await app.api<ChatConversation>('POST', '/api/chat/conversations', { token: insp.token, body: { kind: 'direct', userId: sup.user.id } })).body
    await sendChat(insp, direct.id, 'Check @[Supervisor One](user:' + sup.user.id + ') the coil cert')
    await dispatch()
    expect(pushedTo(insEp)).toEqual([])
    expect(pushedTo(admEp)).toEqual([])
    expect(pushedTo(supEp)).toEqual([{ kind: 'chat', title: 'Inspector One', body: 'Check @Supervisor One the coil cert', url: `/chat/${direct.id}`, tag: `chat-${direct.id}`, severity: 'info' }])

    // The general channel: everyone who may chat, but the sender.
    app.pushes = []
    const general = (await app.api<ChatConversationsResponse>('GET', '/api/chat/conversations', { token: insp.token })).body.conversations.find((c) => c.kind === 'general')!
    await sendChat(admin, general.id, 'Shift meeting at 2')
    await dispatch()
    expect(app.pushes.map((p) => p.endpoint).sort()).toEqual([insEp, supEp].sort())
    expect(pushedTo(insEp)[0]).toMatchObject({ title: 'Admin One · General', body: 'Shift meeting at 2' })
  })

  it('names a group and a photo in words', () => {
    expect(chatNotification({ senderName: 'Mona', kind: 'group', conversationName: 'Welding', body: '', images: 1, files: 0 })).toEqual({ title: 'Mona · Welding', body: '📷 Photo' })
    expect(chatNotification({ senderName: 'Mona', kind: 'direct', conversationName: '', body: '', images: 3, files: 0 })).toEqual({ title: 'Mona', body: '📷 3 photos' })
  })

  it('pushes a notice for people once, on its first day; never one aimed at a machine', async () => {
    const insEp = endpoint('insp')
    const supEp = endpoint('sup')
    await subscribe(insp, insEp)
    await subscribe(sup, supEp)
    const post = (body: Record<string, unknown>) => app.api<{ id: string }>('POST', '/api/notices', { token: admin.token, body: { severity: 'warning', requiresAck: false, validTo: null, ...body } })
    const forInspectors = await post({ title: 'Gloves on the press', body: 'From today.', validFrom: factoryDay(), targets: [{ kind: 'role', value: 'inspector', label: 'Inspector' }] })
    expect(forInspectors.status).toBe(201)
    await post({ title: 'Weld start on 58', validFrom: factoryDay(), targets: [{ kind: 'machine', value: '58', label: '58' }] })
    const tomorrow = await post({ title: 'Audit tomorrow', validFrom: factoryDay(1) })
    await dispatch()
    expect(pushedTo(insEp)).toEqual([{ kind: 'notice', title: 'Notice: Gloves on the press', body: 'From today.', url: '/', tag: `notice-${forInspectors.body.id}`, severity: 'warning' }])
    expect(pushedTo(supEp)).toEqual([])
    // Once.
    await dispatch()
    expect(app.pushes).toHaveLength(1)
    // Tomorrow's, for everyone, goes out tomorrow.
    await dispatch(new Date(Date.now() + 24 * 3600_000))
    expect(app.pushes.filter((p) => p.payload.tag === `notice-${tomorrow.body.id}`).map((p) => p.endpoint).sort()).toEqual([insEp, supEp].sort())
  })

  it('forgets a device its push service says is gone, and drops events too old to matter', async () => {
    const ep = endpoint('old-phone')
    await subscribe(insp, ep)
    app.gonePushEndpoints.add(ep)
    await createNotifications(app.db, [insp.user.id], { kind: 'follow-up-overdue', severity: 'critical', title: 'Overdue', body: '', link: null })
    expect(await dispatch()).toBe(0)
    expect((await app.db.query(`SELECT 1 FROM push_subscriptions WHERE endpoint = $1`, [ep])).rowCount).toBe(0)

    const fresh = endpoint('new-phone')
    await subscribe(insp, fresh)
    await createNotifications(app.db, [insp.user.id], { kind: 'follow-up-overdue', severity: 'critical', title: 'Overdue', body: '', link: null })
    expect(await dispatch(new Date(Date.now() + STALE_EVENT_MS + 60_000))).toBe(0)
    expect(app.pushes).toEqual([])
  })
})
