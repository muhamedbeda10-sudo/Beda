// ============================================================================
// §21 — the chat's system sender, "QC Automations" (0035): an account the
// app writes with and nobody signs in as. Each person it writes to has one
// direct conversation with it, made the first time; they read it like any
// other, and a reply is refused (chat.routes.ts) — nobody reads replies.
//
// Only people who use the chat are written to: a viewer has no chat to read.
// ============================================================================

import { CHAT_MAX_BODY, ROLES } from '@qc/shared/types'
import { can } from '@qc/shared/rules'
import type { Queryable } from '../db/pool'
import { parseMentions } from '../modules/chat.routes'
import { LIVE_PERSON, distinctIds } from './people'
import { clipText } from './notify'

/** The roles that have a chat to be written to. */
const CHAT_ROLES = ROLES.filter((r) => can(r, 'use-chat'))

/** The system account: its id and the name its messages carry. */
export async function systemUser(q: Queryable): Promise<{ id: string; name: string }> {
  const { rows } = await q.query<{ id: string; name: string }>(`SELECT id, name FROM users WHERE is_system`)
  if (!rows[0]) throw new Error('The system sender account is missing: migration 0035 creates it.')
  return rows[0]
}

export async function systemUserId(q: Queryable): Promise<string> {
  return (await systemUser(q)).id
}

/**
 * One message from the system sender to each of these people who can read
 * it — live accounts of a role with the chat, each once — in their direct
 * conversation with it (made, with both member rows, when it is the first).
 * Mention tokens in the body (`#[Label](session:ID)`) become chips as in any
 * message. Returns the messages written. Call it inside the caller's
 * transaction for all or nothing.
 */
export async function sendSystemMessages(q: Queryable, userIds: string[], body: string): Promise<number> {
  return sendSystemMessageBatch(
    q,
    userIds.map((userId) => ({ userId, body })),
  )
}

/**
 * Messages from the system sender, each to its own person — a person given
 * more than once gets the first — written as sendSystemMessages writes one.
 * Every conversation is locked in one order (by the person's id) whatever the
 * order given, so two runs writing to the same people at once never wait on
 * each other in a circle. Returns the messages written. Call it inside the
 * caller's transaction for all or nothing; one call per transaction keeps
 * that order.
 */
export async function sendSystemMessageBatch(q: Queryable, items: readonly { userId: string; body: string }[]): Promise<number> {
  const bodies = new Map<string, string>()
  for (const item of items) {
    const [id] = distinctIds([item.userId])
    const text = clipText(item.body.trim(), CHAT_MAX_BODY)
    if (id && text && !bodies.has(id)) bodies.set(id, text)
  }
  if (bodies.size === 0) return 0
  const sender = await systemUser(q)
  const recipients = (
    await q.query<{ id: string }>(
      `SELECT u.id FROM users u WHERE u.id = ANY($1::uuid[]) AND ${LIVE_PERSON} AND u.role::text = ANY($2::text[]) ORDER BY u.id`,
      [[...bodies.keys()], CHAT_ROLES],
    )
  ).rows.map((r) => r.id)
  if (recipients.length === 0) return 0
  const texts = recipients.map((id) => bodies.get(id)!)

  // The direct key is the two ids sorted and joined, exactly as the chat makes it, so there is only ever one.
  const keys = recipients.map((id) => [sender.id, id].sort().join(':'))
  const conversations = await q.query<{ id: string; directKey: string }>(
    `INSERT INTO chat_conversations (kind, direct_key, created_by_id)
     SELECT 'direct', k, $2 FROM unnest($1::text[]) WITH ORDINALITY AS x(k, n) ORDER BY n
     ON CONFLICT (direct_key) WHERE direct_key IS NOT NULL DO UPDATE SET updated_at = now()
     RETURNING id, direct_key AS "directKey"`,
    [keys, sender.id],
  )
  const byKey = new Map(conversations.rows.map((r) => [r.directKey, r.id]))
  const conversationIds = keys.map((k) => byKey.get(k)!)

  await q.query(
    `INSERT INTO chat_members (conversation_id, user_id)
     SELECT c, u FROM unnest($1::uuid[], $2::uuid[]) WITH ORDINALITY AS x(c, u, n) ORDER BY n
     ON CONFLICT (conversation_id, user_id) DO UPDATE SET removed_at = NULL`,
    [conversationIds, recipients],
  )
  await q.query(
    `INSERT INTO chat_members (conversation_id, user_id)
     SELECT c, $2 FROM unnest($1::uuid[]) WITH ORDINALITY AS x(c, n) ORDER BY n
     ON CONFLICT (conversation_id, user_id) DO UPDATE SET removed_at = NULL`,
    [conversationIds, sender.id],
  )
  // The clock, not the transaction's start: a member row made just now must be
  // older than its first message, or the message would not count as unread.
  const messages = await q.query<{ id: string; conversationId: string }>(
    `INSERT INTO chat_messages (conversation_id, sender_id, sender_name, client_id, body, created_at)
     SELECT c, $2, $3, gen_random_uuid(), b, clock_timestamp() FROM unnest($1::uuid[], $4::text[]) WITH ORDINALITY AS x(c, b, n) ORDER BY n
     RETURNING id, conversation_id AS "conversationId"`,
    [conversationIds, sender.id, sender.name, texts],
  )
  const textOf = new Map(conversationIds.map((c, i) => [c, texts[i]]))
  const mentions = messages.rows.flatMap((m) => parseMentions(textOf.get(m.conversationId) ?? '').map((x) => ({ messageId: m.id, ...x })))
  if (mentions.length > 0) {
    await q.query(
      `INSERT INTO chat_mentions (message_id, kind, value, label)
       SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[])
       ON CONFLICT DO NOTHING`,
      [mentions.map((m) => m.messageId), mentions.map((m) => m.kind), mentions.map((m) => m.value), mentions.map((m) => m.label)],
    )
  }
  await q.query(`UPDATE chat_conversations SET last_message_at = clock_timestamp() WHERE id = ANY($1::uuid[])`, [conversationIds])
  // The sender has read what it wrote, as every sender has.
  await q.query(`UPDATE chat_members SET last_read_at = clock_timestamp() WHERE user_id = $2 AND conversation_id = ANY($1::uuid[])`, [
    conversationIds,
    sender.id,
  ])
  return messages.rowCount ?? 0
}
