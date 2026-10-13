import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { UserNotificationsResponse } from '@qc/shared/automation'
import type { UserProfile } from '@qc/shared/types'
import { TestApp, type Session } from './harness'
import { createNotifications, purgeNotifications, NOTIFICATION_TITLE_MAX, type NewNotification } from '../src/automations/notify'
import { systemUserId } from '../src/automations/systemChat'

// §21 — the bell's alerts: written for the people who can be told, read and
// cleared by each person, never anyone else's.

const app = new TestApp()
let admin: Session
let insp: Session
let sup: Session
let goneId: string

const alert = (over: Partial<NewNotification> = {}): NewNotification => ({
  kind: 'automation-case',
  severity: 'info',
  title: 'Hold on machine 58',
  body: 'Three defects on Hold.',
  link: '/sessions/3b0e9f0e-5d8d-4bb0-9b0b-6d6c0b8a1c11',
  ...over,
})

const list = (s: Session, query = '') => app.api<UserNotificationsResponse>('GET', `/api/notifications${query}`, { token: s.token })

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  admin = await app.register('admin', 'Admin')
  insp = await app.register('insp', 'Inspector One')
  await app.api('POST', '/api/users', { token: admin.token, body: { username: 'sup', password: 'Password#1', name: 'Super', role: 'supervisor' } })
  sup = await app.login('sup')
  const gone = await app.api<UserProfile>('POST', '/api/users', { token: admin.token, body: { username: 'gone', password: 'Password#1', name: 'Gone', role: 'inspector' } })
  goneId = gone.body.id
  await app.api('PATCH', `/api/users/${goneId}`, { token: admin.token, body: { isActive: false } })
})
afterAll(() => app.stop())

describe('§21 — writing alerts', () => {
  it('writes one per person who can be told: each once, never the deactivated, the system sender or a stray value', async () => {
    const systemId = await systemUserId(app.db)
    const n = await createNotifications(app.db, [insp.user.id, insp.user.id, sup.user.id, goneId, systemId, 'nobody', randomUUID()], alert())
    expect(n).toBe(2)
    const { rows } = await app.db.query<{ userId: string }>(`SELECT user_id AS "userId" FROM user_notifications ORDER BY user_id`)
    expect(rows.map((r) => r.userId).sort()).toEqual([insp.user.id, sup.user.id].sort())
    expect(await createNotifications(app.db, [], alert())).toBe(0)
  })

  it('keeps titles to one line within the limit and never blank', async () => {
    await createNotifications(app.db, [admin.user.id], alert({ title: `  A\n  very ${'long '.repeat(200)}`, kind: 'automation-digest' }))
    await createNotifications(app.db, [admin.user.id], alert({ title: '   ', kind: 'follow-up-overdue', link: null }))
    const { rows } = await app.db.query<{ title: string; link: string | null }>(`SELECT title, link FROM user_notifications WHERE user_id = $1 ORDER BY created_at, id`, [
      admin.user.id,
    ])
    expect(Array.from(rows[0].title).length).toBe(NOTIFICATION_TITLE_MAX)
    expect(rows[0].title.startsWith('A very long')).toBe(true)
    expect(rows[0].title.endsWith('…')).toBe(true)
    expect(rows[1]).toEqual({ title: 'A follow-up is overdue', link: null })
  })

  it('refuses a link out of the app, an unknown kind or a malformed id', async () => {
    for (const link of ['https://example.com/x', '//example.com', '/\\example.com', 'sessions/1', '/a b']) {
      await expect(createNotifications(app.db, [insp.user.id], alert({ link }))).rejects.toThrow(/inside the app/)
    }
    await expect(createNotifications(app.db, [insp.user.id], alert({ kind: 'nonsense' as never }))).rejects.toThrow(/kind/)
    await expect(createNotifications(app.db, [insp.user.id], alert({ followUpId: 'x' }))).rejects.toThrow(/uuid/)
    // The database holds the same line.
    await expect(
      app.db.query(`INSERT INTO user_notifications (user_id, kind, severity, title, link) VALUES ($1, 'automation-case', 'info', 'x', 'https://example.com')`, [
        insp.user.id,
      ]),
    ).rejects.toThrow()
  })
})

describe('§20 — an answer of the assistant, ready', () => {
  it('names its answer, and is written once per answer however often it is told', async () => {
    const conv = await app.db.query<{ id: string }>(`INSERT INTO ai_conversations (user_id, title, model, system_prompt, tools) VALUES ($1, 'Rejects', 'claude-sonnet-5-5', 'x', '[]') RETURNING id`, [admin.user.id])
    const turn = await app.db.query<{ id: string }>(
      `INSERT INTO ai_turns (conversation_id, user_id, client_id, question, status, stop_reason, finished_at) VALUES ($1, $2, $3, 'Rejects?', 'done', 'end_turn', now()) RETURNING id`,
      [conv.rows[0].id, admin.user.id, randomUUID()],
    )
    const ready = alert({ kind: 'ai-answer', title: 'Answer ready: Rejects', body: 'Machine 58 leads.', link: `/ai?c=${conv.rows[0].id}`, aiTurnId: turn.rows[0].id })
    expect(await createNotifications(app.db, [admin.user.id], ready)).toBe(1)
    // Told again (another instance closing the same answer): nothing more.
    expect(await createNotifications(app.db, [admin.user.id], ready)).toBe(0)
    expect((await app.db.query(`SELECT kind, title FROM user_notifications WHERE ai_turn_id = $1`, [turn.rows[0].id])).rows).toEqual([{ kind: 'ai-answer', title: 'Answer ready: Rejects' }])
    // Every ai-answer names its answer, and nothing else names one.
    await expect(createNotifications(app.db, [admin.user.id], alert({ kind: 'ai-answer' }))).rejects.toThrow(/aiTurnId/)
    await expect(createNotifications(app.db, [admin.user.id], alert({ aiTurnId: turn.rows[0].id }))).rejects.toThrow(/aiTurnId/)
    await expect(createNotifications(app.db, [admin.user.id], { ...ready, aiTurnId: 'x' })).rejects.toThrow(/uuid/)
    await expect(app.db.query(`INSERT INTO user_notifications (user_id, kind, severity, title) VALUES ($1, 'ai-answer', 'info', 'x')`, [admin.user.id])).rejects.toThrow()
    // It is an alert, in the Alerts list.
    const alerts = await list(admin, '?category=alerts')
    expect(alerts.body.notifications.some((n) => n.kind === 'ai-answer' && n.link === `/ai?c=${conv.rows[0].id}`)).toBe(true)
  })
})

describe('§21 — reading alerts', () => {
  it('lists the reader’s own, newest first, a page at a time', async () => {
    // 34 more for the inspector, a second apart, so 35 in all.
    for (let i = 0; i < 34; i++) await createNotifications(app.db, [insp.user.id], alert({ title: `Case ${i}` }))
    await app.db.query(
      `UPDATE user_notifications n SET created_at = now() - make_interval(secs => x.rn)
         FROM (SELECT id, row_number() OVER (ORDER BY created_at DESC, id DESC) AS rn FROM user_notifications WHERE user_id = $1) x
        WHERE n.id = x.id`,
      [insp.user.id],
    )
    const first = await list(insp)
    expect(first.status).toBe(200)
    expect(first.body.notifications).toHaveLength(30)
    expect(first.body.unreadCount).toBe(35)
    expect(first.body.hasMore).toBe(true)
    const times = first.body.notifications.map((n) => n.createdAt)
    expect([...times].sort().reverse()).toEqual(times)
    expect(first.body.notifications[0]).toMatchObject({ kind: 'automation-case', severity: 'info', readAt: null, title: 'Case 33' })

    const second = await list(insp, `?before=${first.body.notifications[29].id}`)
    expect(second.body.notifications).toHaveLength(5)
    expect(second.body.hasMore).toBe(false)
    const all = [...first.body.notifications, ...second.body.notifications].map((n) => n.id)
    expect(new Set(all).size).toBe(35)

    const small = await list(insp, '?limit=2')
    expect(small.body.notifications).toHaveLength(2)
    expect((await list(insp, '?limit=0')).status).toBe(400)
    expect((await list(insp, '?before=not-an-id')).status).toBe(400)
  })

  it('never shows or touches anyone else’s', async () => {
    const theirs = (await list(insp)).body.notifications[0]
    const supList = await list(sup)
    expect(supList.body.notifications.map((n) => n.id)).not.toContain(theirs.id)
    expect(supList.body.notifications).toHaveLength(1)
    // Someone else's id as a cursor finds nothing; as a read, "not found".
    expect((await list(sup, `?before=${theirs.id}`)).body.notifications).toEqual([])
    expect((await app.api('POST', `/api/notifications/${theirs.id}/read`, { token: sup.token })).status).toBe(404)
    expect((await app.api('POST', `/api/notifications/${randomUUID()}/read`, { token: sup.token })).status).toBe(404)
    expect((await list(insp)).body.notifications[0].readAt).toBeNull()
    expect((await app.api('GET', '/api/notifications')).status).toBe(401)
  })

  it('marks one read, then all', async () => {
    const top = (await list(insp)).body.notifications[0]
    expect((await app.api('POST', `/api/notifications/${top.id}/read`, { token: insp.token })).status).toBe(204)
    const after = await list(insp)
    expect(after.body.unreadCount).toBe(34)
    const readAt = after.body.notifications[0].readAt
    expect(readAt).not.toBeNull()
    // Reading it again keeps the first time.
    expect((await app.api('POST', `/api/notifications/${top.id}/read`, { token: insp.token })).status).toBe(204)
    expect((await list(insp)).body.notifications[0].readAt).toBe(readAt)

    expect((await app.api('POST', '/api/notifications/read-all', { token: insp.token })).status).toBe(204)
    expect((await list(insp)).body.unreadCount).toBe(0)
    // Only the reader's own.
    expect((await list(sup)).body.unreadCount).toBe(1)
  })
})

describe('§21 — the bell’s two lists: alerts, and the reports delivered', () => {
  it('lists, counts and reads each apart; without a category, all of them as before', async () => {
    await app.api('POST', '/api/users', { token: admin.token, body: { username: 'reader', password: 'Password#1', name: 'Report Reader', role: 'viewer' } })
    const reader = await app.login('reader')
    await createNotifications(app.db, [reader.user.id], alert({ title: 'Case A' }))
    await createNotifications(app.db, [reader.user.id], alert({ title: 'Stopped', kind: 'automation-stopped', severity: 'warning' }))
    await createNotifications(app.db, [reader.user.id], alert({ title: 'Daily QC 1', kind: 'automation-report', link: null }))
    await createNotifications(app.db, [reader.user.id], alert({ title: 'Daily QC 2', kind: 'automation-report', link: null }))
    await createNotifications(app.db, [reader.user.id], alert({ title: 'Daily QC 3', kind: 'automation-report', link: null }))

    const reports = await list(reader, '?category=reports')
    expect(reports.status).toBe(200)
    expect(reports.body.notifications.map((n) => n.kind)).toEqual(['automation-report', 'automation-report', 'automation-report'])
    expect(reports.body.unreadCount).toBe(3)
    const alerts = await list(reader, '?category=alerts')
    // A report that stopped is an alert: someone has to act on it.
    expect(alerts.body.notifications.map((n) => n.title).sort()).toEqual(['Case A', 'Stopped'])
    expect(alerts.body.unreadCount).toBe(2)
    expect((await list(reader)).body.unreadCount).toBe(5)

    // Pages walk within the category.
    const first = await list(reader, '?category=reports&limit=2')
    expect(first.body.notifications).toHaveLength(2)
    expect(first.body.hasMore).toBe(true)
    const rest = await list(reader, `?category=reports&limit=2&before=${first.body.notifications[1].id}`)
    expect(rest.body.notifications.map((n) => n.kind)).toEqual(['automation-report'])
    expect(rest.body.hasMore).toBe(false)

    // "Mark all as read" on the Reports tab leaves the alerts unread, and the other way round.
    expect((await app.api('POST', '/api/notifications/read-all?category=reports', { token: reader.token })).status).toBe(204)
    expect((await list(reader, '?category=reports')).body.unreadCount).toBe(0)
    expect((await list(reader, '?category=alerts')).body.unreadCount).toBe(2)
    expect((await app.api('POST', '/api/notifications/read-all?category=alerts', { token: reader.token })).status).toBe(204)
    expect((await list(reader)).body.unreadCount).toBe(0)

    expect((await list(reader, '?category=everything')).status).toBe(400)
    expect((await app.api('POST', '/api/notifications/read-all?category=everything', { token: reader.token })).status).toBe(400)
    await app.db.query(`DELETE FROM user_notifications WHERE user_id = $1`, [reader.user.id])
  })
})

describe('§21 — old alerts go', () => {
  it('removes those older than 90 days, read or not', async () => {
    const ids = (await list(insp, '?limit=3')).body.notifications.map((n) => n.id)
    await app.db.query(`UPDATE user_notifications SET created_at = now() - interval '91 days' WHERE id = ANY($1::uuid[])`, [ids])
    await app.db.query(`UPDATE user_notifications SET created_at = now() - interval '89 days' WHERE id = (SELECT id FROM user_notifications WHERE user_id = $1)`, [
      sup.user.id,
    ])
    const before = (await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM user_notifications`)).rows[0].n
    expect(await purgeNotifications(app.db)).toBe(3)
    const after = (await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM user_notifications`)).rows[0].n
    expect(after).toBe(before - 3)
    expect((await list(sup)).body.notifications).toHaveLength(1)
    // As of a later day, the supervisor's goes too.
    expect(await purgeNotifications(app.db, new Date(Date.now() + 2 * 86_400_000))).toBe(1)
  })
})
