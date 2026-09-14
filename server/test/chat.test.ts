import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { ApiErrorBody, ChatConversationsResponse, ChatMessagesResponse, ChatUnreadResponse } from '@qc/shared/api'
import type { ChatConversation, ChatMessage, ChatUser, StoredFile } from '@qc/shared/types'
import { TestApp, type Session } from './harness'

const app = new TestApp()
let admin: Session
let insp: Session
let sup: Session
let outsider: Session
let general: ChatConversation
let direct: ChatConversation
let group: ChatConversation

const send = (s: Session, conv: string, body: string, extra: Record<string, unknown> = {}) =>
  app.api<ChatMessage>('POST', `/api/chat/conversations/${conv}/messages`, { token: s.token, body: { clientId: randomUUID(), body, ...extra } })

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  admin = await app.register('admin', 'Admin')
  insp = await app.register('insp', 'Inspector One')
  await app.api('POST', '/api/users', { token: admin.token, body: { username: 'sup', password: 'Password#1', name: 'Super', role: 'supervisor' } })
  sup = await app.login('sup')
  await app.api('POST', '/api/users', { token: admin.token, body: { username: 'other', password: 'Password#1', name: 'Outsider', role: 'inspector' } })
  outsider = await app.login('other')
})
afterAll(() => app.stop())

describe('chat', () => {
  it('starts with the general channel for everyone', async () => {
    const res = await app.api<ChatConversationsResponse>('GET', '/api/chat/conversations', { token: insp.token })
    expect(res.status).toBe(200)
    expect(res.body.conversations.map((c) => c.kind)).toEqual(['general'])
    general = res.body.conversations[0]
    expect(general.title).toBe('General')
    expect(general.members.map((m) => m.username).sort()).toEqual(['admin', 'insp', 'other', 'sup'])
    const users = await app.api<ChatUser[]>('GET', '/api/chat/users', { token: insp.token })
    expect(users.body).toHaveLength(4)
  })

  it('sends, counts unread for the others, and marks read', async () => {
    const m = await send(admin, general.id, 'Good morning all. Line 58 starts at 8.')
    expect(m.status).toBe(201)
    expect(m.body.senderName).toBe('Admin')
    expect(m.body.others).toBe(3)
    expect(m.body.readBy).toBe(0)
    // The same client id twice is the same message.
    const clientId = randomUUID()
    const a = await app.api<ChatMessage>('POST', `/api/chat/conversations/${general.id}/messages`, { token: admin.token, body: { clientId, body: 'once' } })
    const b = await app.api<ChatMessage>('POST', `/api/chat/conversations/${general.id}/messages`, { token: admin.token, body: { clientId, body: 'once' } })
    expect(a.body.id).toBe(b.body.id)
    const unread = await app.api<ChatUnreadResponse>('GET', '/api/chat/unread', { token: insp.token })
    expect(unread.body.unreadTotal).toBe(2)
    expect((await app.api<ChatUnreadResponse>('GET', '/api/chat/unread', { token: admin.token })).body.unreadTotal).toBe(0)
    expect((await app.api('POST', `/api/chat/conversations/${general.id}/read`, { token: insp.token })).status).toBe(204)
    expect((await app.api<ChatUnreadResponse>('GET', '/api/chat/unread', { token: insp.token })).body.unreadTotal).toBe(0)
    const page = await app.api<ChatMessagesResponse>('GET', `/api/chat/conversations/${general.id}/messages`, { token: admin.token })
    expect(page.body.messages.map((x) => x.body)).toEqual(['Good morning all. Line 58 starts at 8.', 'once'])
    expect(page.body.messages[0].readBy).toBe(1)
    expect(page.body.hasMore).toBe(false)
  })

  it('keeps a direct conversation between its two people', async () => {
    const created = await app.api<ChatConversation>('POST', '/api/chat/conversations', { token: insp.token, body: { kind: 'direct', userId: sup.user.id } })
    expect(created.status).toBe(201)
    direct = created.body
    expect(direct.kind).toBe('direct')
    expect(direct.title).toBe('Super')
    // Asking again gives the same conversation.
    const again = await app.api<ChatConversation>('POST', '/api/chat/conversations', { token: sup.token, body: { kind: 'direct', userId: insp.user.id } })
    expect(again.body.id).toBe(direct.id)
    expect(again.body.title).toBe('Inspector One')
    const m = await send(insp, direct.id, 'Can you check the coil cert for C10021?')
    expect(m.status).toBe(201)
    // The administrator is not in it: no list, no messages, no send, no file.
    expect((await app.api<ChatConversationsResponse>('GET', '/api/chat/conversations', { token: admin.token })).body.conversations.find((c) => c.id === direct.id)).toBeUndefined()
    expect((await app.api('GET', `/api/chat/conversations/${direct.id}/messages`, { token: admin.token })).status).toBe(404)
    expect((await send(admin, direct.id, 'hello?')).status).toBe(404)
    expect((await app.api('DELETE', `/api/chat/messages/${m.body.id}?scope=everyone`, { token: admin.token })).status).toBe(404)
    // The other person reads it.
    const theirs = await app.api<ChatMessagesResponse>('GET', `/api/chat/conversations/${direct.id}/messages`, { token: sup.token })
    expect(theirs.body.messages).toHaveLength(1)
    expect((await app.api('POST', '/api/chat/conversations', { token: insp.token, body: { kind: 'direct', userId: insp.user.id } })).status).toBe(400)
  })

  it('lets only an administrator make a group, and members see it', async () => {
    expect((await app.api('POST', '/api/chat/conversations', { token: insp.token, body: { kind: 'group', name: 'Welding', memberIds: [sup.user.id] } })).status).toBe(403)
    const created = await app.api<ChatConversation>('POST', '/api/chat/conversations', { token: admin.token, body: { kind: 'group', name: 'Welding', memberIds: [insp.user.id] } })
    expect(created.status).toBe(201)
    group = created.body
    expect(group.members.map((m) => m.username).sort()).toEqual(['admin', 'insp'])
    expect((await app.api('GET', `/api/chat/conversations/${group.id}/messages`, { token: sup.token })).status).toBe(404)
    const changed = await app.api<ChatConversation>('PATCH', `/api/chat/conversations/${group.id}`, { token: admin.token, body: { name: 'Welding LM4', addMemberIds: [sup.user.id], removeMemberIds: [insp.user.id] } })
    expect(changed.body.title).toBe('Welding LM4')
    expect(changed.body.members.map((m) => m.username).sort()).toEqual(['admin', 'sup'])
    expect((await app.api('GET', `/api/chat/conversations/${group.id}/messages`, { token: insp.token })).status).toBe(404)
    expect((await app.api('GET', `/api/chat/conversations/${group.id}/messages`, { token: sup.token })).status).toBe(200)
  })

  it('lets an administrator delete a group, and nothing else', async () => {
    const created = await app.api<ChatConversation>('POST', '/api/chat/conversations', { token: admin.token, body: { kind: 'group', name: 'Paint line', memberIds: [insp.user.id, sup.user.id] } })
    expect(created.status).toBe(201)
    const doomed = created.body
    const unreadOf = async (s: Session) => (await app.api<ChatUnreadResponse>('GET', '/api/chat/unread', { token: s.token })).body.unreadTotal
    const supBefore = await unreadOf(sup)
    expect((await send(insp, doomed.id, 'Booth 2 is down.')).status).toBe(201)
    expect(await unreadOf(sup)).toBe(supBefore + 1)
    // A member who is not an administrator cannot; the general channel and a direct conversation cannot be.
    expect((await app.api('DELETE', `/api/chat/conversations/${doomed.id}`, { token: sup.token })).status).toBe(403)
    expect((await app.api('DELETE', `/api/chat/conversations/${general.id}`, { token: admin.token })).status).toBe(400)
    expect((await app.api('DELETE', `/api/chat/conversations/${direct.id}`, { token: admin.token })).status).toBe(400)
    expect((await app.api('DELETE', `/api/chat/conversations/${doomed.id}`, { token: admin.token })).status).toBe(204)
    // Gone for everyone who was in it, and gone means gone for a second delete too.
    for (const s of [admin, insp, sup]) {
      expect((await app.api<ChatConversationsResponse>('GET', '/api/chat/conversations', { token: s.token })).body.conversations.find((c) => c.id === doomed.id)).toBeUndefined()
      expect((await app.api('GET', `/api/chat/conversations/${doomed.id}/messages`, { token: s.token })).status).toBe(404)
    }
    expect((await app.api('DELETE', `/api/chat/conversations/${doomed.id}`, { token: admin.token })).status).toBe(404)
    expect((await app.api('PATCH', `/api/chat/conversations/${doomed.id}`, { token: admin.token, body: { name: 'Back?' } })).status).toBe(404)
    // The unread count no longer includes the group's messages.
    expect(await unreadOf(sup)).toBe(supBefore)
    // The messages are kept, and the deletion is on record.
    const kept = await app.db.query(`SELECT count(*)::int AS n FROM chat_messages WHERE conversation_id = $1`, [doomed.id])
    expect(kept.rows[0].n).toBe(1)
    const audit = await app.db.query(`SELECT action, entity FROM audit_log WHERE entity_id = $1`, [doomed.id])
    expect(audit.rows).toEqual([{ action: 'delete', entity: 'ChatGroup' }])
  })

  it('carries mentions, replies, reactions, edits and deletions', async () => {
    const body = `@[Inspector One](user:${insp.user.id}) please look at #[20095-QC1-HYH · XL Light Beam](order:${randomUUID()}) on #[58](machine:58)`
    const m = await send(admin, general.id, body)
    expect(m.body.mentions.map((x) => x.kind).sort()).toEqual(['machine', 'order', 'user'])
    const unread = await app.api<ChatUnreadResponse>('GET', '/api/chat/unread', { token: insp.token })
    expect(unread.body.mentionTotal).toBe(1)
    const reply = await send(insp, general.id, 'On it.', { replyToId: m.body.id })
    expect(reply.body.replyTo?.senderName).toBe('Admin')
    expect(reply.body.replyTo?.text).toBe('@Inspector One please look at #20095-QC1-HYH · XL Light Beam on #58')
    const wrong = await send(insp, direct.id, 'x', { replyToId: m.body.id })
    expect(wrong.status).toBe(400)
    // Reactions toggle.
    const liked = await app.api<ChatMessage>('POST', `/api/chat/messages/${m.body.id}/reactions`, { token: insp.token, body: { emoji: '👍' } })
    expect(liked.body.reactions).toEqual([{ emoji: '👍', count: 1, mine: true, names: ['Inspector One'] }])
    const unliked = await app.api<ChatMessage>('POST', `/api/chat/messages/${m.body.id}/reactions`, { token: insp.token, body: { emoji: '👍' } })
    expect(unliked.body.reactions).toEqual([])
    expect((await app.api<ApiErrorBody>('POST', `/api/chat/messages/${m.body.id}/reactions`, { token: insp.token, body: { emoji: 'lol' } })).status).toBe(400)
    // Only the sender edits; only within the hour.
    expect((await app.api('PATCH', `/api/chat/messages/${m.body.id}`, { token: insp.token, body: { body: 'hijack' } })).status).toBe(403)
    const edited = await app.api<ChatMessage>('PATCH', `/api/chat/messages/${m.body.id}`, { token: admin.token, body: { body: 'Edited: please look at #[58](machine:58)' } })
    expect(edited.body.editedAt).not.toBeNull()
    expect(edited.body.mentions).toEqual([{ kind: 'machine', value: '58', label: '58' }])
    await app.db.query(`UPDATE chat_messages SET created_at = now() - interval '2 hours' WHERE id = $1`, [reply.body.id])
    expect((await app.api<ApiErrorBody>('PATCH', `/api/chat/messages/${reply.body.id}`, { token: insp.token, body: { body: 'late' } })).status).toBe(400)
    expect((await app.api('DELETE', `/api/chat/messages/${reply.body.id}?scope=everyone`, { token: insp.token })).status).toBe(400)
    // Delete for me hides it for one reader only.
    expect((await app.api('DELETE', `/api/chat/messages/${reply.body.id}?scope=me`, { token: insp.token })).status).toBe(204)
    const mine = await app.api<ChatMessagesResponse>('GET', `/api/chat/conversations/${general.id}/messages`, { token: insp.token })
    expect(mine.body.messages.find((x) => x.id === reply.body.id)).toBeUndefined()
    const theirs = await app.api<ChatMessagesResponse>('GET', `/api/chat/conversations/${general.id}/messages`, { token: sup.token })
    expect(theirs.body.messages.find((x) => x.id === reply.body.id)?.body).toBe('On it.')
    // Delete for everyone leaves a stand-in.
    expect((await app.api('DELETE', `/api/chat/messages/${m.body.id}?scope=everyone`, { token: admin.token })).status).toBe(204)
    const after = await app.api<ChatMessagesResponse>('GET', `/api/chat/conversations/${general.id}/messages`, { token: sup.token })
    const gone = after.body.messages.find((x) => x.id === m.body.id)!
    expect(gone.deleted).toBe(true)
    expect(gone.body).toBe('')
    expect(gone.mentions).toEqual([])
    // An administrator moderates a channel, not a direct conversation.
    const late = (await app.api<ChatMessagesResponse>('GET', `/api/chat/conversations/${general.id}/messages`, { token: admin.token })).body.messages.find((x) => x.id === reply.body.id)!
    expect((await app.api('DELETE', `/api/chat/messages/${late.id}?scope=everyone`, { token: admin.token })).status).toBe(204)
  })

  it('pages older messages', async () => {
    for (let i = 0; i < 45; i++) await send(sup, general.id, `msg ${i}`)
    const first = await app.api<ChatMessagesResponse>('GET', `/api/chat/conversations/${general.id}/messages`, { token: admin.token })
    expect(first.body.messages).toHaveLength(40)
    expect(first.body.hasMore).toBe(true)
    const older = await app.api<ChatMessagesResponse>('GET', `/api/chat/conversations/${general.id}/messages?before=${encodeURIComponent(first.body.messages[0].createdAt)}`, { token: admin.token })
    expect(older.body.hasMore).toBe(false)
    expect(older.body.messages.length).toBeGreaterThan(0)
    expect(new Date(older.body.messages.at(-1)!.createdAt).getTime()).toBeLessThan(new Date(first.body.messages[0].createdAt).getTime())
    const list = await app.api<ChatConversationsResponse>('GET', '/api/chat/conversations', { token: outsider.token })
    expect(list.body.conversations[0].lastMessage?.text).toBe('msg 44')
    expect(list.body.unreadTotal).toBeGreaterThan(40)
  })

  it('sends a file only its conversation can read', async () => {
    const pdf = Buffer.from('%PDF-1.4\n%%EOF\n')
    const form = new FormData()
    form.set('file', new Blob([pdf], { type: 'application/pdf' }), 'cert.pdf')
    const up = await app.api<StoredFile>('POST', '/api/chat/files', { token: insp.token, raw: form })
    expect(up.status).toBe(201)
    // Before it is sent, only the uploader can read it back.
    expect((await app.api('GET', `/api/chat/files/${up.body.id}/content`, { token: sup.token })).status).toBe(404)
    const m = await send(insp, direct.id, '', { fileIds: [up.body.id] })
    expect(m.status).toBe(201)
    expect(m.body.files[0].originalFilename).toBe('cert.pdf')
    expect((await app.api('GET', `/api/chat/files/${up.body.id}/content`, { token: sup.token })).status).toBe(200)
    expect((await app.api('GET', `/api/chat/files/${up.body.id}/content`, { token: admin.token })).status).toBe(404)
    // Another sender cannot claim the same file.
    expect((await send(sup, direct.id, '', { fileIds: [up.body.id] })).status).toBe(400)
    expect((await send(sup, direct.id, '   ')).status).toBe(400)
  })
})
