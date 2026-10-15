import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { ApiErrorBody, AuditOptionsResponse, ChatConversationsResponse, ChatMessagesResponse, ChatUnreadResponse } from '@qc/shared/api'
import type { ChatConversation, ChatMessage, ChatUser, UserProfile } from '@qc/shared/types'
import { TestApp, type Session } from './harness'
import { hashPassword } from '../src/auth/password'
import { hashRefreshToken, newRefreshToken, signAccessToken } from '../src/auth/tokens'
import { writeAudit } from '../src/audit/service'
import { activeUserIds } from '../src/automations/people'
import { sendSystemMessages, systemUser, systemUserId } from '../src/automations/systemChat'

// §21 — the system sender "QC Automations": nobody signs in as it, it is in
// no list of people, and its chat conversations only deliver.

const app = new TestApp()
let admin: Session
let insp: Session
let sup: Session
let viewer: Session
let goneId: string
let systemId: string

const send = (s: Session, conv: string, body: string) =>
  app.api<ChatMessage>('POST', `/api/chat/conversations/${conv}/messages`, { token: s.token, body: { clientId: randomUUID(), body } })

async function addUser(username: string, name: string, role: string): Promise<Session> {
  const res = await app.api<UserProfile>('POST', '/api/users', { token: admin.token, body: { username, password: 'Password#1', name, role } })
  expect(res.status).toBe(201)
  return app.login(username)
}

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  admin = await app.register('admin', 'Admin')
  insp = await app.register('insp', 'Inspector One')
  sup = await addUser('sup', 'Super Visor', 'supervisor')
  viewer = await addUser('view', 'Vera Viewer', 'viewer')
  const gone = await addUser('gone', 'Gone Person', 'inspector')
  goneId = gone.user.id
  expect((await app.api('PATCH', `/api/users/${goneId}`, { token: admin.token, body: { isActive: false } })).status).toBe(200)
  systemId = await systemUserId(app.db)
})
afterAll(() => app.stop())

describe('§21 — the system sender cannot sign in', () => {
  it('exists once, as a viewer named QC Automations, with no password that can match', async () => {
    const { rows } = await app.db.query<{ id: string; username: string; name: string; role: string; isActive: boolean; hash: string }>(
      `SELECT id, username, name, role, is_active AS "isActive", password_hash AS hash FROM users WHERE is_system`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: systemId, username: 'qc-automations', name: 'QC Automations', role: 'viewer', isActive: true })
    expect(rows[0].hash.startsWith('scrypt$')).toBe(false)
    expect(await systemUser(app.db)).toEqual({ id: systemId, name: 'QC Automations' })
    // A second one is refused by the database, and so is turning a person into it.
    await expect(
      app.db.query(`INSERT INTO users (username, name, role, password_hash, is_system) VALUES ('other-system', 'Other', 'viewer', 'x', true)`),
    ).rejects.toThrow()
    await expect(app.db.query(`UPDATE users SET is_system = true WHERE id = $1`, [insp.user.id])).rejects.toThrow(/fixed/)
  })

  it('still lets the first person to register become the administrator', () => {
    expect(admin.user.role).toBe('admin')
    expect(insp.user.role).toBe('inspector')
  })

  it('refuses its sign-in like an unknown name, even with a password hash that would match', async () => {
    const res = await app.api<ApiErrorBody>('POST', '/api/auth/login', { body: { username: 'qc-automations', password: 'anything-at-all' } })
    expect(res.status).toBe(401)
    expect(res.body.error.message).toBe('Incorrect username or password.')
    // Someone with the database sets a real hash: the API still says no.
    await app.db.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [systemId, await hashPassword('Password#1')])
    const again = await app.api<ApiErrorBody>('POST', '/api/auth/login', { body: { username: 'qc-automations', password: 'Password#1' } })
    expect(again.status).toBe(401)
    expect(again.body.error.message).toBe('Incorrect username or password.')
  })

  it('refuses a token or a refresh cookie made for it', async () => {
    const refresh = newRefreshToken()
    const { rows } = await app.db.query<{ id: string }>(
      `INSERT INTO auth_sessions (user_id, refresh_token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day') RETURNING id`,
      [systemId, hashRefreshToken(refresh)],
    )
    const token = signAccessToken({ sub: systemId, name: 'QC Automations', role: 'viewer', sid: rows[0].id }, app.config.JWT_SECRET, 900)
    expect((await app.api('GET', '/api/auth/me', { token })).status).toBe(401)
    expect((await app.api('GET', '/api/sessions/open', { token })).status).toBe(401)
    expect((await app.api('POST', '/api/auth/refresh', { cookie: `qc_refresh=${refresh}` })).status).toBe(401)
  })
})

describe('§21 — the system sender is in no list of people', () => {
  it('is not on the Users page and cannot be changed or removed there', async () => {
    const users = await app.api<UserProfile[]>('GET', '/api/users', { token: admin.token })
    expect(users.body.map((u) => u.username).sort()).toEqual(['admin', 'gone', 'insp', 'sup', 'view'])
    expect((await app.api('PATCH', `/api/users/${systemId}`, { token: admin.token, body: { password: 'Password#2' } })).status).toBe(404)
    expect((await app.api('PATCH', `/api/users/${systemId}`, { token: admin.token, body: { isActive: false } })).status).toBe(404)
    expect((await app.api('DELETE', `/api/users/${systemId}`, { token: admin.token })).status).toBe(404)
  })

  it('is not in the chat directory, the general channel or its counts', async () => {
    const users = await app.api<ChatUser[]>('GET', '/api/chat/users', { token: insp.token })
    expect(users.body.map((u) => u.username).sort()).toEqual(['admin', 'insp', 'sup'])
    const list = await app.api<ChatConversationsResponse>('GET', '/api/chat/conversations', { token: insp.token })
    const general = list.body.conversations.find((c) => c.kind === 'general')!
    expect(general.members.map((m) => m.username)).not.toContain('qc-automations')
    const m = await send(admin, general.id, 'Morning.')
    // Everyone active but the sender, the system sender left out: insp, sup, view.
    expect(m.body.others).toBe(3)
  })

  it('is not offered to the assistant’s owner, nor can it be given the assistant', async () => {
    const people = await app.api<{ id: string; username: string }[]>('GET', '/api/ai/people', { token: admin.token })
    expect(people.status).toBe(200)
    expect(people.body.map((p) => p.id)).not.toContain(systemId)
    const put = await app.api('PUT', `/api/ai/access/${systemId}`, {
      token: admin.token,
      body: { enabled: true, domains: ['inspection'], monthlyCapUsd: 50 },
    })
    expect(put.status).toBe(404)
    // Nor is it among the accounts the assistant itself can read.
    const { rows } = await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ai.users WHERE user_id = $1`, [systemId])
    expect(rows[0].n).toBe(0)
  })

  it('is not a name to filter the audit log by, though it writes entries', async () => {
    await writeAudit(app.db, [
      { at: new Date().toISOString(), userId: systemId, userName: 'QC Automations', action: 'create', entity: 'FollowUp', entityId: randomUUID() },
    ])
    const options = await app.api<AuditOptionsResponse>('GET', '/api/audit/options', { token: admin.token })
    expect(options.status).toBe(200)
    expect(options.body.users).not.toContain('QC Automations')
    expect(options.body.users).toContain('Admin')
    expect(options.body.entities).toContain('FollowUp')
  })

  it('is never among the people an automation reaches', async () => {
    expect(await activeUserIds(app.db, { roles: ['viewer'] })).toEqual([viewer.user.id])
    expect(await activeUserIds(app.db, { userIds: [systemId, goneId, insp.user.id, insp.user.id, 'not-an-id'] })).toEqual([insp.user.id])
    const both = await activeUserIds(app.db, { userIds: [insp.user.id], roles: ['supervisor', 'admin'] })
    expect(both.sort()).toEqual([admin.user.id, insp.user.id, sup.user.id].sort())
    expect(await activeUserIds(app.db, {})).toEqual([])
  })

  it('cannot be written to or put in a group', async () => {
    const direct = await app.api<ApiErrorBody>('POST', '/api/chat/conversations', { token: insp.token, body: { kind: 'direct', userId: systemId } })
    expect(direct.status).toBe(404)
    const group = await app.api<ChatConversation>('POST', '/api/chat/conversations', {
      token: admin.token,
      body: { kind: 'group', name: 'Line 58', memberIds: [insp.user.id, systemId] },
    })
    expect(group.status).toBe(201)
    expect(group.body.members.map((m) => m.id)).not.toContain(systemId)
    const changed = await app.api<ChatConversation>('PATCH', `/api/chat/conversations/${group.body.id}`, { token: admin.token, body: { addMemberIds: [systemId] } })
    expect(changed.status).toBe(200)
    expect(changed.body.members.map((m) => m.id)).not.toContain(systemId)
  })
})

describe('§21 — automated chat messages', () => {
  const sessionId = randomUUID()
  let automated: ChatConversation

  it('writes once to each person with a chat, in a conversation of its own', async () => {
    const body = `Machine 58 has 3 defects on Hold.\n#[20570 · XL Beam · 58 #1](session:${sessionId})`
    const written = await sendSystemMessages(app.db, [insp.user.id, sup.user.id, insp.user.id, viewer.user.id, goneId, systemId, 'not-an-id'], body)
    // The inspector and the supervisor; not the viewer (no chat), the deactivated account, itself or a stray value.
    expect(written).toBe(2)
    const list = await app.api<ChatConversationsResponse>('GET', '/api/chat/conversations', { token: insp.token })
    const mine = list.body.conversations.filter((c) => c.kind === 'direct')
    expect(mine).toHaveLength(1)
    automated = mine[0]
    expect(automated.title).toBe('QC Automations')
    expect(automated.automated).toBe(true)
    expect(automated.unreadCount).toBe(1)
    expect(automated.lastMessage?.senderName).toBe('QC Automations')
    expect(automated.lastMessage?.text).toContain('Machine 58 has 3 defects on Hold.')
    expect((await app.api<ChatUnreadResponse>('GET', '/api/chat/unread', { token: insp.token })).body.unreadTotal).toBeGreaterThanOrEqual(1)
    const page = await app.api<ChatMessagesResponse>('GET', `/api/chat/conversations/${automated.id}/messages`, { token: insp.token })
    expect(page.body.messages).toHaveLength(1)
    expect(page.body.messages[0].senderId).toBe(systemId)
    expect(page.body.messages[0].body).toBe(body)
    expect(page.body.messages[0].mentions).toEqual([{ kind: 'session', value: sessionId, label: '20570 · XL Beam · 58 #1' }])
    // The viewer has no conversation with it at all.
    const { rows } = await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM chat_members WHERE user_id = $1`, [viewer.user.id])
    expect(rows[0].n).toBe(0)
  })

  it('keeps writing into the same conversation', async () => {
    expect(await sendSystemMessages(app.db, [insp.user.id], 'A second case.')).toBe(1)
    const list = await app.api<ChatConversationsResponse>('GET', '/api/chat/conversations', { token: insp.token })
    const mine = list.body.conversations.filter((c) => c.kind === 'direct')
    expect(mine.map((c) => c.id)).toEqual([automated.id])
    expect(mine[0].unreadCount).toBe(2)
    const { rows } = await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM chat_conversations WHERE direct_key LIKE '%' || $1 || '%'`, [systemId])
    expect(rows[0].n).toBe(2)
    // Read like any other.
    expect((await app.api('POST', `/api/chat/conversations/${automated.id}/read`, { token: insp.token })).status).toBe(204)
    const after = await app.api<ChatConversationsResponse>('GET', '/api/chat/conversations', { token: insp.token })
    expect(after.body.conversations.find((c) => c.id === automated.id)?.unreadCount).toBe(0)
  })

  it('refuses a reply, and leaves other conversations alone', async () => {
    const reply = await send(insp, automated.id, 'Thanks!')
    expect(reply.status).toBe(403)
    expect((reply.body as unknown as ApiErrorBody).error.message).toBe('Automated messages — replies are not read.')
    const page = await app.api<ChatMessagesResponse>('GET', `/api/chat/conversations/${automated.id}/messages`, { token: insp.token })
    expect(page.body.messages.map((m) => m.senderId)).toEqual([systemId, systemId])
    // A conversation between two people is not automated and takes replies.
    const direct = await app.api<ChatConversation>('POST', '/api/chat/conversations', { token: insp.token, body: { kind: 'direct', userId: sup.user.id } })
    expect(direct.body.automated).toBeUndefined()
    expect((await send(insp, direct.body.id, 'Hello')).status).toBe(201)
    // Nobody else reads it.
    expect((await app.api('GET', `/api/chat/conversations/${automated.id}/messages`, { token: sup.token })).status).toBe(404)
  })

  it('writes nothing for nobody or for nothing', async () => {
    expect(await sendSystemMessages(app.db, [], 'Hello')).toBe(0)
    expect(await sendSystemMessages(app.db, [insp.user.id], '   ')).toBe(0)
    expect(await sendSystemMessages(app.db, [viewer.user.id, goneId], 'Hello')).toBe(0)
  })
})
