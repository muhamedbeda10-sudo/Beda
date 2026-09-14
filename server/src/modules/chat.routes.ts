// ============================================================================
// §17 — chat. A general channel for everyone, private conversations between
// two people, and groups an administrator makes. Messages are kept forever;
// deleting for everyone blanks one, deleting for me hides it. Nothing here
// pushes: the client polls, and every read checks membership, so a direct
// conversation is readable by its two people and nobody else.
// ============================================================================

import { createHash, randomUUID } from 'node:crypto'
import { Router, type Request } from 'express'
import multer from 'multer'
import { z } from 'zod'
import type {
  ChatConversationsResponse,
  ChatMessagesResponse,
  ChatUnreadResponse,
  CreateConversationRequest,
  EditChatMessageRequest,
  SendChatMessageRequest,
  ToggleReactionRequest,
  UpdateGroupRequest,
} from '@qc/shared/api'
import {
  CHAT_EDIT_WINDOW_MS,
  CHAT_MAX_BODY,
  CHAT_MENTION_KINDS,
  type ChatConversation,
  type ChatMember,
  type ChatMention,
  type ChatMentionKind,
  type ChatMessage,
  type ChatMessagePreview,
  type ChatReaction,
  type ChatUser,
  type StoredFile,
} from '@qc/shared/types'
import type { AppContext } from '../context'
import { withTransaction, type Queryable } from '../db/pool'
import { HttpError, badRequest, forbidden, notFound } from '../lib/errors'
import { parse } from '../lib/validate'
import { requireCapability, requireUser, type AuthUser } from '../auth/middleware'
import { auditDelete } from '../audit/service'
import { NOTICE_FILE_TYPES, buildChatFileStorageKey } from '../images/storage'
import { sniffNoticeFile } from './notices.routes'

const uuid = z.string().uuid()
const PAGE = 40

// ---- Mentions --------------------------------------------------------------

const MENTION_RE = /([@#])\[([^\]\n]{1,120})\]\((user|order|item|machine|session):([^)\s]{1,120})\)/g

/** The mentions written into a body, each once. */
export function parseMentions(body: string): ChatMention[] {
  const out = new Map<string, ChatMention>()
  for (const m of body.matchAll(MENTION_RE)) {
    const kind = m[3] as ChatMentionKind
    if (!CHAT_MENTION_KINDS.includes(kind)) continue
    out.set(`${kind}:${m[4]}`, { kind, value: m[4], label: m[2] })
  }
  return [...out.values()]
}

/** The body as plain text for previews: chips become their labels. */
export function plainText(body: string): string {
  return body.replace(MENTION_RE, (_, sigil: string, label: string) => `${sigil}${label}`)
}

function preview(m: { id: string; senderId: string; senderName: string; body: string; createdAt: string; deleted: boolean; images: number; files: number }): ChatMessagePreview {
  const text = m.deleted ? 'Message deleted' : m.body.trim() ? plainText(m.body).slice(0, 140) : m.images > 0 ? '📷 Photo' : m.files > 0 ? '📎 File' : ''
  return { id: m.id, senderId: m.senderId, senderName: m.senderName, text, createdAt: m.createdAt }
}

// ---- Membership --------------------------------------------------------------

interface ConversationRow {
  id: string
  kind: ChatConversation['kind']
  name: string
  createdById: string | null
  createdAt: string
  lastMessageAt: string | null
}

const CONVERSATION_SELECT = `c.id, c.kind, c.name, c.created_by_id AS "createdById", c.created_at AS "createdAt", c.last_message_at AS "lastMessageAt"`

/** The conversation, if this reader is in it. A stranger gets "not found", never a hint that it exists. */
async function requireMembership(q: Queryable, conversationId: string, user: AuthUser): Promise<ConversationRow> {
  const { rows } = await q.query<ConversationRow>(
    `SELECT ${CONVERSATION_SELECT} FROM chat_conversations c
      WHERE c.id = $1 AND c.deleted_at IS NULL
        AND (c.kind = 'general' OR EXISTS (SELECT 1 FROM chat_members m WHERE m.conversation_id = c.id AND m.user_id = $2 AND m.removed_at IS NULL))`,
    [conversationId, user.id],
  )
  if (!rows[0]) throw notFound('That conversation')
  return rows[0]
}

async function loadMembers(q: Queryable, conversations: ConversationRow[]): Promise<Map<string, ChatMember[]>> {
  const out = new Map<string, ChatMember[]>()
  const general = conversations.filter((c) => c.kind === 'general')
  const others = conversations.filter((c) => c.kind !== 'general')
  if (general.length > 0) {
    const { rows } = await q.query<ChatMember & { conversationId: string }>(
      `SELECT u.id, u.name, u.username, u.role, m.last_read_at AS "lastReadAt"
         FROM users u LEFT JOIN chat_members m ON m.conversation_id = $1 AND m.user_id = u.id
        WHERE u.deleted_at IS NULL AND u.is_active ORDER BY u.name`,
      [general[0].id],
    )
    out.set(general[0].id, rows.map(({ ...r }) => r))
  }
  if (others.length > 0) {
    const { rows } = await q.query<ChatMember & { conversationId: string }>(
      `SELECT m.conversation_id AS "conversationId", u.id, u.name, u.username, u.role, m.last_read_at AS "lastReadAt"
         FROM chat_members m JOIN users u ON u.id = m.user_id
        WHERE m.conversation_id = ANY($1::uuid[]) AND m.removed_at IS NULL ORDER BY u.name`,
      [others.map((c) => c.id)],
    )
    for (const r of rows) {
      const { conversationId, ...member } = r
      out.set(conversationId, [...(out.get(conversationId) ?? []), member])
    }
  }
  return out
}

// ---- Messages ----------------------------------------------------------------

interface MessageRow {
  id: string
  conversationId: string
  senderId: string
  senderName: string
  body: string
  replyToId: string | null
  createdAt: string
  editedAt: string | null
  deleted: boolean
  readBy: number
  others: number
}

const MESSAGE_SELECT = `
  m.id, m.conversation_id AS "conversationId", m.sender_id AS "senderId", m.sender_name AS "senderName",
  CASE WHEN m.deleted_at IS NULL THEN m.body ELSE '' END AS body, m.reply_to_id AS "replyToId",
  m.created_at AS "createdAt", m.edited_at AS "editedAt", (m.deleted_at IS NOT NULL) AS deleted,
  (SELECT count(*) FROM chat_members r WHERE r.conversation_id = m.conversation_id AND r.user_id <> m.sender_id AND r.removed_at IS NULL AND r.last_read_at >= m.created_at)::int AS "readBy",
  CASE WHEN c.kind = 'general'
       THEN (SELECT count(*) FROM users u WHERE u.deleted_at IS NULL AND u.is_active AND u.id <> m.sender_id)
       ELSE (SELECT count(*) FROM chat_members r WHERE r.conversation_id = m.conversation_id AND r.user_id <> m.sender_id AND r.removed_at IS NULL) END::int AS others`

/** Attachments, reactions, mentions and reply previews for a page of messages. */
async function assemble(q: Queryable, rows: MessageRow[], reader: AuthUser): Promise<ChatMessage[]> {
  if (rows.length === 0) return []
  const ids = rows.map((r) => r.id)
  const replyIds = rows.map((r) => r.replyToId).filter((x): x is string => !!x)
  const [images, files, reactions, mentions, replies] = await Promise.all([
    q.query<{ messageId: string; imageId: string }>(
      `SELECT mi.message_id AS "messageId", mi.image_id AS "imageId" FROM chat_message_images mi JOIN images i ON i.id = mi.image_id AND i.deleted_at IS NULL
        WHERE mi.message_id = ANY($1::uuid[]) ORDER BY mi.position`,
      [ids],
    ),
    q.query<StoredFile & { messageId: string }>(
      `SELECT message_id AS "messageId", id, original_filename AS "originalFilename", mime_type AS "mimeType", byte_size AS "byteSize", sha256,
              uploaded_by_name AS "uploadedByName", uploaded_at AS "uploadedAt"
         FROM chat_files WHERE message_id = ANY($1::uuid[]) AND deleted_at IS NULL ORDER BY uploaded_at`,
      [ids],
    ),
    q.query<{ messageId: string; emoji: string; userId: string; userName: string }>(
      `SELECT message_id AS "messageId", emoji, user_id AS "userId", user_name AS "userName" FROM chat_reactions WHERE message_id = ANY($1::uuid[]) ORDER BY created_at`,
      [ids],
    ),
    q.query<ChatMention & { messageId: string }>(`SELECT message_id AS "messageId", kind, value, label FROM chat_mentions WHERE message_id = ANY($1::uuid[])`, [ids]),
    replyIds.length
      ? q.query<{ id: string; senderName: string; body: string; deleted: boolean; images: number; files: number }>(
          `SELECT m.id, m.sender_name AS "senderName", CASE WHEN m.deleted_at IS NULL THEN m.body ELSE '' END AS body, (m.deleted_at IS NOT NULL) AS deleted,
                  (SELECT count(*) FROM chat_message_images x WHERE x.message_id = m.id)::int AS images,
                  (SELECT count(*) FROM chat_files x WHERE x.message_id = m.id AND x.deleted_at IS NULL)::int AS files
             FROM chat_messages m WHERE m.id = ANY($1::uuid[])`,
          [replyIds],
        )
      : Promise.resolve({ rows: [] as { id: string; senderName: string; body: string; deleted: boolean; images: number; files: number }[] }),
  ])
  const byId = new Map<string, ChatMessage>()
  for (const r of rows) {
    byId.set(r.id, {
      id: r.id,
      conversationId: r.conversationId,
      senderId: r.senderId,
      senderName: r.senderName,
      body: r.body,
      replyTo: null,
      imageIds: [],
      files: [],
      mentions: [],
      reactions: [],
      createdAt: r.createdAt,
      editedAt: r.editedAt,
      deleted: r.deleted,
      readBy: r.readBy,
      others: r.others,
    })
  }
  for (const i of images.rows) byId.get(i.messageId)?.imageIds.push(i.imageId)
  for (const f of files.rows) {
    const { messageId, ...file } = f
    byId.get(messageId)?.files.push(file)
  }
  for (const mn of mentions.rows) {
    const { messageId, ...mention } = mn
    byId.get(messageId)?.mentions.push(mention)
  }
  const grouped = new Map<string, Map<string, ChatReaction>>()
  for (const rx of reactions.rows) {
    const per = grouped.get(rx.messageId) ?? new Map<string, ChatReaction>()
    const entry = per.get(rx.emoji) ?? { emoji: rx.emoji, count: 0, mine: false, names: [] }
    entry.count += 1
    entry.names.push(rx.userName)
    if (rx.userId === reader.id) entry.mine = true
    per.set(rx.emoji, entry)
    grouped.set(rx.messageId, per)
  }
  for (const [messageId, per] of grouped) byId.get(messageId)!.reactions = [...per.values()]
  const replyMap = new Map(replies.rows.map((r) => [r.id, r]))
  for (const r of rows) {
    if (!r.replyToId) continue
    const src = replyMap.get(r.replyToId)
    if (!src) continue
    const p = preview({ id: src.id, senderId: '', senderName: src.senderName, body: src.body, createdAt: '', deleted: src.deleted, images: src.images, files: src.files })
    byId.get(r.id)!.replyTo = { id: src.id, senderName: src.senderName, text: p.text }
  }
  return rows.map((r) => byId.get(r.id)!)
}

async function writeMentions(q: Queryable, messageId: string, body: string): Promise<void> {
  await q.query(`DELETE FROM chat_mentions WHERE message_id = $1`, [messageId])
  for (const m of parseMentions(body)) {
    await q.query(`INSERT INTO chat_mentions (message_id, kind, value, label) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [messageId, m.kind, m.value, m.label])
  }
}

/** Unread and mention counts for the reader across their conversations. */
async function unreadFor(q: Queryable, user: AuthUser): Promise<Map<string, { unread: number; mentions: number }>> {
  const { rows } = await q.query<{ conversationId: string; unread: number; mentions: number }>(
    `WITH mine AS (
       SELECT c.id, COALESCE(m.last_read_at, m.joined_at, u.created_at) AS since
         FROM chat_conversations c
         JOIN users u ON u.id = $1
         LEFT JOIN chat_members m ON m.conversation_id = c.id AND m.user_id = $1 AND m.removed_at IS NULL
        WHERE c.deleted_at IS NULL AND (c.kind = 'general' OR m.user_id IS NOT NULL))
     SELECT mine.id AS "conversationId",
            count(*)::int AS unread,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM chat_mentions x WHERE x.message_id = msg.id AND x.kind = 'user' AND x.value = $1::text))::int AS mentions
       FROM mine JOIN chat_messages msg ON msg.conversation_id = mine.id AND msg.created_at > mine.since
      WHERE msg.sender_id <> $1 AND msg.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM chat_hidden_messages h WHERE h.message_id = msg.id AND h.user_id = $1)
      GROUP BY mine.id`,
    [user.id],
  )
  return new Map(rows.map((r) => [r.conversationId, { unread: r.unread, mentions: r.mentions }]))
}

function titleFor(c: ConversationRow, members: ChatMember[], user: AuthUser): string {
  if (c.kind === 'general') return 'General'
  if (c.kind === 'direct') return members.find((m) => m.id !== user.id)?.name ?? members[0]?.name ?? 'Direct message'
  return c.name
}

async function buildConversations(q: Queryable, rows: ConversationRow[], user: AuthUser): Promise<ChatConversation[]> {
  if (rows.length === 0) return []
  const [members, unread, last] = await Promise.all([
    loadMembers(q, rows),
    unreadFor(q, user),
    q.query<{ conversationId: string; id: string; senderId: string; senderName: string; body: string; createdAt: string; deleted: boolean; images: number; files: number }>(
      `SELECT DISTINCT ON (m.conversation_id) m.conversation_id AS "conversationId", m.id, m.sender_id AS "senderId", m.sender_name AS "senderName",
              CASE WHEN m.deleted_at IS NULL THEN m.body ELSE '' END AS body, m.created_at AS "createdAt", (m.deleted_at IS NOT NULL) AS deleted,
              (SELECT count(*) FROM chat_message_images x WHERE x.message_id = m.id)::int AS images,
              (SELECT count(*) FROM chat_files x WHERE x.message_id = m.id AND x.deleted_at IS NULL)::int AS files
         FROM chat_messages m
        WHERE m.conversation_id = ANY($1::uuid[])
          AND NOT EXISTS (SELECT 1 FROM chat_hidden_messages h WHERE h.message_id = m.id AND h.user_id = $2)
        ORDER BY m.conversation_id, m.created_at DESC, m.id DESC`,
      [rows.map((c) => c.id), user.id],
    ),
  ])
  const lastBy = new Map(last.rows.map((r) => [r.conversationId, r]))
  return rows.map((c) => {
    const ms = members.get(c.id) ?? []
    const u = unread.get(c.id)
    const l = lastBy.get(c.id)
    return {
      id: c.id,
      kind: c.kind,
      title: titleFor(c, ms, user),
      createdById: c.createdById,
      createdAt: c.createdAt,
      lastMessageAt: c.lastMessageAt,
      members: ms,
      unreadCount: u?.unread ?? 0,
      mentionCount: u?.mentions ?? 0,
      lastMessage: l ? preview(l) : null,
    }
  })
}

// ---- Schemas -----------------------------------------------------------------

const sendSchema = z.object({
  clientId: uuid,
  body: z.string().max(CHAT_MAX_BODY).default(''),
  replyToId: uuid.nullable().optional(),
  imageIds: z.array(uuid).max(10).default([]),
  fileIds: z.array(uuid).max(5).default([]),
})
const editSchema = z.object({ body: z.string().trim().min(1).max(CHAT_MAX_BODY) })
const createSchema = z.union([
  z.object({ kind: z.literal('direct'), userId: uuid }),
  z.object({ kind: z.literal('group'), name: z.string().trim().min(1).max(80), memberIds: z.array(uuid).max(200).default([]) }),
])
const updateGroupSchema = z
  .object({ name: z.string().trim().min(1).max(80).optional(), addMemberIds: z.array(uuid).max(200).optional(), removeMemberIds: z.array(uuid).max(200).optional() })
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change.')
const reactionSchema = z.object({ emoji: z.string().min(1).max(16).refine((e) => !/[A-Za-z0-9<>&"'\\/]/.test(e), 'Not an emoji.') })

export function chatRoutes(ctx: AppContext): Router {
  const r = Router()
  const db = ctx.db
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: ctx.config.MAX_DOCUMENT_BYTES, files: 1, fields: 5 } })

  /** Everyone who can be written to. */
  r.get('/users', async (_req, res) => {
    const { rows } = await db.query<ChatUser>(`SELECT id, name, username, role FROM users WHERE deleted_at IS NULL AND is_active ORDER BY name`)
    res.json(rows)
  })

  r.get('/unread', async (req, res) => {
    const user = requireUser(req)
    const map = await unreadFor(db, user)
    const body: ChatUnreadResponse = { unreadTotal: 0, mentionTotal: 0 }
    for (const v of map.values()) {
      body.unreadTotal += v.unread
      body.mentionTotal += v.mentions
    }
    res.json(body)
  })

  r.get('/conversations', async (req, res) => {
    const user = requireUser(req)
    const { rows } = await db.query<ConversationRow>(
      `SELECT ${CONVERSATION_SELECT} FROM chat_conversations c
        WHERE c.deleted_at IS NULL
          AND (c.kind = 'general' OR EXISTS (SELECT 1 FROM chat_members m WHERE m.conversation_id = c.id AND m.user_id = $1 AND m.removed_at IS NULL))
        ORDER BY c.kind = 'general' DESC, c.last_message_at DESC NULLS LAST, c.created_at DESC`,
      [user.id],
    )
    const conversations = await buildConversations(db, rows, user)
    const body: ChatConversationsResponse = {
      conversations,
      unreadTotal: conversations.reduce((n, c) => n + c.unreadCount, 0),
      mentionTotal: conversations.reduce((n, c) => n + c.mentionCount, 0),
    }
    res.json(body)
  })

  r.post('/conversations', async (req, res) => {
    const user = requireUser(req)
    const body = parse(createSchema, req.body) as CreateConversationRequest
    const created = await withTransaction(db, async (tx) => {
      if (body.kind === 'direct') {
        if (body.userId === user.id) throw badRequest('That is you.')
        const other = await tx.query(`SELECT 1 FROM users WHERE id = $1 AND deleted_at IS NULL AND is_active`, [body.userId])
        if (!other.rowCount) throw notFound('That user')
        const key = [user.id, body.userId].sort().join(':')
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO chat_conversations (kind, direct_key, created_by_id) VALUES ('direct', $1, $2)
           ON CONFLICT (direct_key) WHERE direct_key IS NOT NULL DO UPDATE SET updated_at = now() RETURNING id`,
          [key, user.id],
        )
        const id = rows[0].id
        for (const uid of [user.id, body.userId]) {
          await tx.query(
            `INSERT INTO chat_members (conversation_id, user_id) VALUES ($1, $2) ON CONFLICT (conversation_id, user_id) DO UPDATE SET removed_at = NULL`,
            [id, uid],
          )
        }
        return id
      }
      if (user.role !== 'admin') throw forbidden('Only an administrator creates a group.')
      const { rows } = await tx.query<{ id: string }>(`INSERT INTO chat_conversations (kind, name, created_by_id) VALUES ('group', $1, $2) RETURNING id`, [body.name, user.id])
      const id = rows[0].id
      const ids = Array.from(new Set([user.id, ...body.memberIds]))
      const valid = await tx.query<{ id: string }>(`SELECT id FROM users WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL AND is_active`, [ids])
      for (const row of valid.rows) await tx.query(`INSERT INTO chat_members (conversation_id, user_id) VALUES ($1, $2)`, [id, row.id])
      return id
    })
    const row = await requireMembership(db, created, user)
    res.status(201).json((await buildConversations(db, [row], user))[0])
  })

  r.patch('/conversations/:id', requireCapability('manage-admin-data'), async (req, res) => {
    const user = requireUser(req)
    const id = parse(uuid, req.params.id)
    const body = parse(updateGroupSchema, req.body) as UpdateGroupRequest
    await withTransaction(db, async (tx) => {
      const { rows } = await tx.query<{ kind: string }>(`SELECT kind FROM chat_conversations WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [id])
      if (!rows[0]) throw notFound('That conversation')
      if (rows[0].kind !== 'group') throw badRequest('Only a group can be changed.')
      if (body.name) await tx.query(`UPDATE chat_conversations SET name = $2 WHERE id = $1`, [id, body.name])
      for (const uid of body.addMemberIds ?? []) {
        const ok = await tx.query(`SELECT 1 FROM users WHERE id = $1 AND deleted_at IS NULL AND is_active`, [uid])
        if (!ok.rowCount) continue
        await tx.query(`INSERT INTO chat_members (conversation_id, user_id) VALUES ($1, $2) ON CONFLICT (conversation_id, user_id) DO UPDATE SET removed_at = NULL, joined_at = now()`, [id, uid])
      }
      for (const uid of body.removeMemberIds ?? []) {
        await tx.query(`UPDATE chat_members SET removed_at = now() WHERE conversation_id = $1 AND user_id = $2 AND removed_at IS NULL`, [id, uid])
      }
    })
    // The administrator may have removed themself; answer with the row as anyone sees it.
    const { rows } = await db.query<ConversationRow>(`SELECT ${CONVERSATION_SELECT} FROM chat_conversations c WHERE c.id = $1`, [id])
    res.json((await buildConversations(db, rows, user))[0])
  })

  /**
   * An administrator removes a group. The row and its messages stay (soft
   * delete, audited); it leaves every member's list at once. The general
   * channel and a direct conversation are never deleted.
   */
  r.delete('/conversations/:id', requireCapability('manage-admin-data'), async (req, res) => {
    const user = requireUser(req)
    const id = parse(uuid, req.params.id)
    await withTransaction(db, async (tx) => {
      const { rows } = await tx.query<{ kind: string; name: string }>(`SELECT kind, name FROM chat_conversations WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [id])
      if (!rows[0]) throw notFound('That conversation')
      if (rows[0].kind !== 'group') throw badRequest('Only a group can be deleted.')
      await tx.query(`UPDATE chat_conversations SET deleted_at = now(), deleted_by_id = $2, updated_at = now() WHERE id = $1`, [id, user.id])
      await auditDelete(tx, { userId: user.id, userName: user.name, entity: 'ChatGroup', entityId: id })
    })
    res.status(204).end()
  })

  r.get('/conversations/:id/messages', async (req, res) => {
    const user = requireUser(req)
    const id = parse(uuid, req.params.id)
    const q = parse(z.object({ before: z.string().datetime({ offset: true }).optional(), limit: z.coerce.number().int().min(1).max(100).default(PAGE) }), req.query)
    await requireMembership(db, id, user)
    const { rows } = await db.query<MessageRow>(
      `SELECT ${MESSAGE_SELECT} FROM chat_messages m JOIN chat_conversations c ON c.id = m.conversation_id
        WHERE m.conversation_id = $1
          AND ($3::timestamptz IS NULL OR m.created_at < $3)
          AND NOT EXISTS (SELECT 1 FROM chat_hidden_messages h WHERE h.message_id = m.id AND h.user_id = $2)
        ORDER BY m.created_at DESC, m.id DESC LIMIT $4`,
      [id, user.id, q.before ?? null, q.limit + 1],
    )
    const hasMore = rows.length > q.limit
    const page = rows.slice(0, q.limit).reverse()
    const body: ChatMessagesResponse = { messages: await assemble(db, page, user), hasMore }
    res.json(body)
  })

  r.post('/conversations/:id/messages', async (req, res) => {
    const user = requireUser(req)
    const id = parse(uuid, req.params.id)
    const body = parse(sendSchema, req.body) as Required<SendChatMessageRequest>
    if (!body.body.trim() && body.imageIds.length === 0 && body.fileIds.length === 0) throw badRequest('Write something or attach a file.')
    await requireMembership(db, id, user)
    const messageId = await withTransaction(db, async (tx) => {
      const existing = await tx.query<{ id: string }>(`SELECT id FROM chat_messages WHERE sender_id = $1 AND client_id = $2`, [user.id, body.clientId])
      if (existing.rows[0]) return existing.rows[0].id
      if (body.replyToId) {
        const ok = await tx.query(`SELECT 1 FROM chat_messages WHERE id = $1 AND conversation_id = $2`, [body.replyToId, id])
        if (!ok.rowCount) throw badRequest('The message being replied to is not in this conversation.')
      }
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO chat_messages (conversation_id, sender_id, sender_name, client_id, body, reply_to_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [id, user.id, user.name, body.clientId, body.body.trim(), body.replyToId ?? null],
      )
      const mid = rows[0].id
      for (const [i, imageId] of body.imageIds.entries()) {
        const ok = await tx.query(`SELECT 1 FROM images WHERE id = $1 AND deleted_at IS NULL`, [imageId])
        if (!ok.rowCount) throw badRequest('An attached photo was not found.')
        await tx.query(`INSERT INTO chat_message_images (message_id, image_id, position) VALUES ($1, $2, $3)`, [mid, imageId, i])
      }
      for (const fileId of body.fileIds) {
        const { rowCount } = await tx.query(`UPDATE chat_files SET message_id = $1 WHERE id = $2 AND message_id IS NULL AND uploaded_by_id = $3 AND deleted_at IS NULL`, [mid, fileId, user.id])
        if (!rowCount) throw badRequest('An attached file was not found.')
      }
      await writeMentions(tx, mid, body.body)
      await tx.query(`UPDATE chat_conversations SET last_message_at = now() WHERE id = $1`, [id])
      await tx.query(
        `INSERT INTO chat_members (conversation_id, user_id, last_read_at) VALUES ($1, $2, now())
         ON CONFLICT (conversation_id, user_id) DO UPDATE SET last_read_at = now()`,
        [id, user.id],
      )
      return mid
    })
    const { rows } = await db.query<MessageRow>(`SELECT ${MESSAGE_SELECT} FROM chat_messages m JOIN chat_conversations c ON c.id = m.conversation_id WHERE m.id = $1`, [messageId])
    res.status(201).json((await assemble(db, rows, user))[0])
  })

  r.post('/conversations/:id/read', async (req, res) => {
    const user = requireUser(req)
    const id = parse(uuid, req.params.id)
    await requireMembership(db, id, user)
    await db.query(
      `INSERT INTO chat_members (conversation_id, user_id, last_read_at) VALUES ($1, $2, now())
       ON CONFLICT (conversation_id, user_id) DO UPDATE SET last_read_at = now()`,
      [id, user.id],
    )
    res.status(204).end()
  })

  /** The message, if the reader is in its conversation. */
  async function ownMessage(q: Queryable, messageId: string, user: AuthUser): Promise<{ id: string; conversationId: string; senderId: string; createdAt: string; deleted: boolean; kind: string }> {
    const { rows } = await q.query<{ id: string; conversationId: string; senderId: string; createdAt: string; deleted: boolean; kind: string }>(
      `SELECT m.id, m.conversation_id AS "conversationId", m.sender_id AS "senderId", m.created_at AS "createdAt", (m.deleted_at IS NOT NULL) AS deleted, c.kind
         FROM chat_messages m JOIN chat_conversations c ON c.id = m.conversation_id WHERE m.id = $1`,
      [messageId],
    )
    if (!rows[0]) throw notFound('That message')
    await requireMembership(q, rows[0].conversationId, user)
    return rows[0]
  }

  const withinWindow = (createdAt: string) => Date.now() - new Date(createdAt).getTime() <= CHAT_EDIT_WINDOW_MS

  r.patch('/messages/:id', async (req, res) => {
    const user = requireUser(req)
    const id = parse(uuid, req.params.id)
    const body = parse(editSchema, req.body) as EditChatMessageRequest
    await withTransaction(db, async (tx) => {
      const m = await ownMessage(tx, id, user)
      if (m.senderId !== user.id) throw forbidden('Only the sender edits a message.')
      if (m.deleted) throw badRequest('That message was deleted.')
      if (!withinWindow(m.createdAt)) throw badRequest('A message can be edited for one hour after it was sent.')
      await tx.query(`UPDATE chat_messages SET body = $2, edited_at = now() WHERE id = $1`, [id, body.body])
      await writeMentions(tx, id, body.body)
    })
    const { rows } = await db.query<MessageRow>(`SELECT ${MESSAGE_SELECT} FROM chat_messages m JOIN chat_conversations c ON c.id = m.conversation_id WHERE m.id = $1`, [id])
    res.json((await assemble(db, rows, user))[0])
  })

  /** `scope=me` hides it for the reader; `scope=everyone` blanks it for all (sender within the hour, or an administrator in a channel). */
  r.delete('/messages/:id', async (req, res) => {
    const user = requireUser(req)
    const id = parse(uuid, req.params.id)
    const { scope } = parse(z.object({ scope: z.enum(['me', 'everyone']).default('me') }), req.query)
    await withTransaction(db, async (tx) => {
      const m = await ownMessage(tx, id, user)
      if (scope === 'me') {
        await tx.query(`INSERT INTO chat_hidden_messages (message_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, user.id])
        return
      }
      const moderator = user.role === 'admin' && m.kind !== 'direct'
      if (m.senderId !== user.id && !moderator) throw forbidden('Only the sender deletes a message for everyone.')
      if (m.senderId === user.id && !moderator && !withinWindow(m.createdAt)) throw badRequest('A message can be deleted for everyone for one hour after it was sent.')
      await tx.query(`UPDATE chat_messages SET deleted_at = now(), deleted_by_id = $2 WHERE id = $1 AND deleted_at IS NULL`, [id, user.id])
      await tx.query(`DELETE FROM chat_mentions WHERE message_id = $1`, [id])
    })
    res.status(204).end()
  })

  r.post('/messages/:id/reactions', async (req, res) => {
    const user = requireUser(req)
    const id = parse(uuid, req.params.id)
    const { emoji } = parse(reactionSchema, req.body) as ToggleReactionRequest
    await withTransaction(db, async (tx) => {
      const m = await ownMessage(tx, id, user)
      if (m.deleted) throw badRequest('That message was deleted.')
      const { rowCount } = await tx.query(`DELETE FROM chat_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3`, [id, user.id, emoji])
      if (!rowCount) await tx.query(`INSERT INTO chat_reactions (message_id, user_id, user_name, emoji) VALUES ($1, $2, $3, $4)`, [id, user.id, user.name, emoji])
    })
    const { rows } = await db.query<MessageRow>(`SELECT ${MESSAGE_SELECT} FROM chat_messages m JOIN chat_conversations c ON c.id = m.conversation_id WHERE m.id = $1`, [id])
    res.json((await assemble(db, rows, user))[0])
  })

  // ---- Files -----------------------------------------------------------------

  r.post('/files', upload.single('file'), async (req: Request, res) => {
    const user = requireUser(req)
    if (!req.file) throw badRequest('Attach the document as the "file" field.')
    const name = req.file.originalname.slice(0, 255) || 'document'
    const ext = sniffNoticeFile(name, req.file.buffer)
    const id = randomUUID()
    const key = buildChatFileStorageKey(id, ext)
    const sha256 = createHash('sha256').update(req.file.buffer).digest('hex')
    await ctx.images.put(key, req.file.buffer, NOTICE_FILE_TYPES[ext])
    try {
      const { rows } = await db.query<StoredFile>(
        `INSERT INTO chat_files (id, storage_key, driver, original_filename, mime_type, byte_size, sha256, uploaded_by_id, uploaded_by_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id, original_filename AS "originalFilename", mime_type AS "mimeType", byte_size AS "byteSize", sha256, uploaded_by_name AS "uploadedByName", uploaded_at AS "uploadedAt"`,
        [id, key, ctx.images.driver, name, NOTICE_FILE_TYPES[ext], req.file.buffer.length, sha256, user.id, user.name],
      )
      res.status(201).json(rows[0])
    } catch (e) {
      await ctx.images.remove(key).catch(() => undefined)
      throw e
    }
  })

  /** Bytes of a sent file: for members of its conversation only. */
  r.get('/files/:id/content', async (req, res) => {
    const user = requireUser(req)
    const id = parse(uuid, req.params.id)
    const { rows } = await db.query<{ storageKey: string; byteSize: number; sha256: string; originalFilename: string; mimeType: string; messageId: string | null; uploadedById: string | null }>(
      `SELECT storage_key AS "storageKey", byte_size AS "byteSize", sha256, original_filename AS "originalFilename", mime_type AS "mimeType",
              message_id AS "messageId", uploaded_by_id AS "uploadedById"
         FROM chat_files WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    )
    const meta = rows[0]
    if (!meta) throw notFound('That file')
    if (meta.messageId) await ownMessage(db, meta.messageId, user)
    else if (meta.uploadedById !== user.id) throw notFound('That file')
    const etag = `"${meta.sha256}"`
    if (req.headers['if-none-match'] === etag) return res.status(304).end()
    const stored = await ctx.images.get(meta.storageKey)
    if (!stored) throw new HttpError(404, 'not_found', 'The file bytes are missing from storage. The metadata and hash are still on record.')
    const safeName = meta.originalFilename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')
    res.setHeader('Content-Type', meta.mimeType)
    res.setHeader('Content-Disposition', `${meta.mimeType === 'application/pdf' ? 'inline' : 'attachment'}; filename="${safeName}"`)
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
    res.setHeader('ETag', etag)
    res.setHeader('Content-Length', String(stored.byteSize ?? meta.byteSize))
    stored.stream.on('error', (e) => {
      console.error('[chat] stream failed', e)
      if (!res.headersSent) res.status(500).end()
      else res.destroy()
    })
    stored.stream.pipe(res)
  })

  return r
}
