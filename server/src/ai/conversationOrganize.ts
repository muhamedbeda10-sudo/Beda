// ============================================================================
// §20 — keeping one's conversations in order (migration 0052): a title of
// one's own, pinned to the top, in a group, archived out of the list. All of
// it is the person's own, as their conversations are: someone else's
// conversation or group is "not found", never a hint that it exists.
//
//   • a pinned conversation is listed first; pinning one that is archived
//     brings it back into the list, archiving one unpins it;
//   • a conversation is in one group at most; a group removed sends its
//     conversations back to the list, in the same transaction;
//   • a renamed conversation keeps its name: nothing the assistant does
//     changes a title the person gave.
//
// These are the person's own arrangement of their list, not the factory's
// record: like removing a conversation, they leave no audit entry.
// ============================================================================

import {
  AI_CONVERSATION_GROUP_NAME_MAX,
  AI_CONVERSATION_TITLE_MAX,
  AI_MAX_CONVERSATION_GROUPS,
  AI_MAX_PINNED_CONVERSATIONS,
  type AiConversation,
  type AiConversationGroup,
  type AiConversationUpdate,
} from '@qc/shared/ai'
import type { Queryable } from '../db/pool'
import { HttpError, badRequest, duplicate, notFound } from '../lib/errors'
import { CONVERSATION_SELECT, toConversation } from './transcript'

/** A title or a group's name as it is kept: on one line, without spaces at its ends. */
export const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

/** Its length as a person counts it: an emoji is one character, not two. */
export const charLength = (s: string) => Array.from(s).length

/** What is wrong with a conversation's title, or null. */
export function conversationTitleProblem(title: string): string | null {
  if (title === '') return 'Give the conversation a title.'
  if (charLength(title) > AI_CONVERSATION_TITLE_MAX) return `A conversation's title is at most ${AI_CONVERSATION_TITLE_MAX} characters.`
  return null
}

/** What is wrong with a group's name, or null. */
export function groupNameProblem(name: string): string | null {
  if (name === '') return 'Give the group a name.'
  if (charLength(name) > AI_CONVERSATION_GROUP_NAME_MAX) return `A group's name is at most ${AI_CONVERSATION_GROUP_NAME_MAX} characters.`
  return null
}

const conflict = (message: string) => new HttpError(409, 'conflict', message)

// ---- Conversations ---------------------------------------------------------------

interface LockedConversation {
  id: string
  title: string
  pinnedAt: string | null
  groupId: string | null
  archivedAt: string | null
}

/**
 * Change one of the person's conversations: what the update gives changes,
 * the rest stays. In the caller's transaction; the conversation is locked
 * while it changes, so two changes at once are one after the other.
 */
export async function updateConversation(tx: Queryable, userId: string, id: string, update: AiConversationUpdate): Promise<AiConversation> {
  if (update.pinned === true && update.archived === true) throw badRequest('A conversation cannot be pinned and archived at once.')
  const { rows } = await tx.query<LockedConversation>(
    `SELECT c.id, c.title, c.pinned_at AS "pinnedAt", c.group_id AS "groupId", c.archived_at AS "archivedAt"
       FROM ai_conversations c WHERE c.id = $1 AND c.user_id = $2 AND c.deleted_at IS NULL FOR UPDATE`,
    [id, userId],
  )
  const now = rows[0]
  if (!now) throw notFound('That conversation')

  const sets: string[] = []
  const values: unknown[] = [id]
  const set = (sql: string, value?: unknown) => {
    if (value === undefined) sets.push(sql)
    else {
      values.push(value)
      sets.push(sql.replace('?', `$${values.length}`))
    }
  }

  if (update.title !== undefined && update.title !== now.title) {
    set('title = ?', update.title)
    set(`title_source = 'person'`)
  }
  if (update.groupId !== undefined && update.groupId !== now.groupId) {
    if (update.groupId !== null) {
      const group = await tx.query(`SELECT 1 FROM ai_conversation_groups WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR SHARE`, [update.groupId, userId])
      if (!group.rowCount) throw notFound('That group')
    }
    set('group_id = ?', update.groupId)
  }
  const archive = update.archived === true || (update.archived === undefined && now.archivedAt !== null && update.pinned !== true)
  if (update.pinned === true && now.pinnedAt === null) {
    // One person's pins are counted under a lock of their own, so two pins at once cannot pass the limit together.
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`ai_pins:${userId}`])
    const { rows: pinned } = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ai_conversations WHERE user_id = $1 AND deleted_at IS NULL AND pinned_at IS NOT NULL AND id <> $2`,
      [userId, id],
    )
    if (pinned[0].n >= AI_MAX_PINNED_CONVERSATIONS) throw conflict(`At most ${AI_MAX_PINNED_CONVERSATIONS} conversations can be pinned. Unpin one first.`)
    set('pinned_at = now()')
  } else if (update.pinned === false || (archive && now.pinnedAt !== null)) {
    if (now.pinnedAt !== null) set('pinned_at = NULL')
  }
  if (archive && now.archivedAt === null) set('archived_at = now()')
  if (!archive && now.archivedAt !== null) set('archived_at = NULL')

  if (sets.length > 0) await tx.query(`UPDATE ai_conversations SET ${sets.join(', ')} WHERE id = $1`, values)
  const { rows: after } = await tx.query<AiConversation>(`SELECT ${CONVERSATION_SELECT} FROM ai_conversations c WHERE c.id = $1`, [id])
  return toConversation(after[0])
}

// ---- Groups ----------------------------------------------------------------------

interface GroupRow {
  id: string
  name: string
  conversationCount: number
  lastMessageAt: string | null
  createdAt: string
}

const toGroup = (g: GroupRow): AiConversationGroup => ({
  id: g.id,
  name: g.name,
  conversationCount: g.conversationCount,
  lastMessageAt: g.lastMessageAt === null ? null : new Date(g.lastMessageAt).toISOString(),
  createdAt: new Date(g.createdAt).toISOString(),
})

const GROUP_SELECT = `g.id, g.name, g.created_at AS "createdAt",
  (SELECT count(*)::int FROM ai_conversations c WHERE c.group_id = g.id AND c.deleted_at IS NULL AND c.archived_at IS NULL) AS "conversationCount",
  (SELECT max(c.last_message_at) FROM ai_conversations c WHERE c.group_id = g.id AND c.deleted_at IS NULL AND c.archived_at IS NULL) AS "lastMessageAt"`

/** The person's groups, by name. */
export async function listGroups(q: Queryable, userId: string): Promise<AiConversationGroup[]> {
  const { rows } = await q.query<GroupRow>(
    `SELECT ${GROUP_SELECT} FROM ai_conversation_groups g WHERE g.user_id = $1 AND g.deleted_at IS NULL ORDER BY lower(g.name), g.id`,
    [userId],
  )
  return rows.map(toGroup)
}

async function findGroup(q: Queryable, userId: string, id: string): Promise<AiConversationGroup | null> {
  const { rows } = await q.query<GroupRow>(`SELECT ${GROUP_SELECT} FROM ai_conversation_groups g WHERE g.id = $1 AND g.user_id = $2 AND g.deleted_at IS NULL`, [id, userId])
  return rows[0] ? toGroup(rows[0]) : null
}

/** The live group of this name, whatever its case, other than `except`. */
async function sameName(tx: Queryable, userId: string, name: string, except: string | null): Promise<boolean> {
  const { rows } = await tx.query(
    `SELECT 1 FROM ai_conversation_groups WHERE user_id = $1 AND deleted_at IS NULL AND lower(name) = lower($2) AND ($3::uuid IS NULL OR id <> $3)`,
    [userId, name, except],
  )
  return rows.length > 0
}

const takenName = (name: string) => duplicate(`You already have a group named "${name}".`)

/** Is a unique violation of the live-name index: two makes of one name at once. */
const isNameRace = (e: unknown) => (e as { code?: string; constraint?: string }).code === '23505' && (e as { constraint?: string }).constraint === 'ai_conversation_groups_name_live'

/** Make a group. In the caller's transaction. */
export async function createGroup(tx: Queryable, userId: string, name: string): Promise<AiConversationGroup> {
  // One person's groups are counted and named under a lock of their own.
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`ai_groups:${userId}`])
  const { rows: count } = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ai_conversation_groups WHERE user_id = $1 AND deleted_at IS NULL`, [userId])
  if (count[0].n >= AI_MAX_CONVERSATION_GROUPS) throw conflict(`At most ${AI_MAX_CONVERSATION_GROUPS} groups. Remove one you no longer use first.`)
  if (await sameName(tx, userId, name, null)) throw takenName(name)
  try {
    const { rows } = await tx.query<{ id: string }>(`INSERT INTO ai_conversation_groups (user_id, name) VALUES ($1, $2) RETURNING id`, [userId, name])
    return (await findGroup(tx, userId, rows[0].id))!
  } catch (e) {
    if (isNameRace(e)) throw takenName(name)
    throw e
  }
}

/** Rename a group. In the caller's transaction. */
export async function renameGroup(tx: Queryable, userId: string, id: string, name: string): Promise<AiConversationGroup> {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`ai_groups:${userId}`])
  const { rows } = await tx.query<{ name: string }>(`SELECT name FROM ai_conversation_groups WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE`, [id, userId])
  if (!rows[0]) throw notFound('That group')
  if (rows[0].name !== name) {
    if (await sameName(tx, userId, name, id)) throw takenName(name)
    try {
      await tx.query(`UPDATE ai_conversation_groups SET name = $2 WHERE id = $1`, [id, name])
    } catch (e) {
      if (isNameRace(e)) throw takenName(name)
      throw e
    }
  }
  return (await findGroup(tx, userId, id))!
}

/** Remove a group: its conversations go back to the list, none of them removed. In the caller's transaction. */
export async function removeGroup(tx: Queryable, userId: string, id: string): Promise<void> {
  const { rows } = await tx.query(`SELECT 1 FROM ai_conversation_groups WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE`, [id, userId])
  if (!rows[0]) throw notFound('That group')
  // Removed ones too: the group's row stays, but nothing points at it any more.
  await tx.query(`UPDATE ai_conversations SET group_id = NULL WHERE group_id = $1`, [id])
  await tx.query(`UPDATE ai_conversation_groups SET deleted_at = now() WHERE id = $1`, [id])
}
