// ============================================================================
// §24 — the push dispatcher: an in-process loop in the API, like the
// automations engine. Every few seconds it takes what the triggers queued
// (push_events: a new bell alert, a new chat message) and the notices whose
// first day has come, works out who is told — by the same rules the app shows
// them by — and pushes to the devices those people turned notifications on
// for. Several instances may run it: events are taken with SKIP LOCKED and
// removed as they are taken, notices marked as they are; each goes out once.
//
//   • an alert: to the person it is for; it opens its link.
//   • a chat message: to every member of its conversation but the sender —
//     the general channel's members are everyone who may chat; it opens the
//     conversation, and a conversation's notifications replace each other.
//   • a notice: on the first day it is valid, to everyone it is aimed at when
//     its audience is people (everyone, roles, named people). A notice aimed
//     at a machine, an order, a shift or the like shows when someone opens
//     that work, so it is not pushed.
//
// An event older than STALE_EVENT_MS (the server was down) is dropped, not
// pushed late. Only people with a device subscribed are looked at.
// ============================================================================

import { can } from '@qc/shared/rules'
import { ROLES, type Role } from '@qc/shared/types'
import type { PushPayload } from '@qc/shared/api'
import type { Config } from '../config'
import { withTransaction, type Db, type Queryable } from '../db/pool'
import { factoryDay } from '../ai/prompt'
import { LIVE_PERSON } from '../automations/people'
import { plainText } from '../modules/chat.routes'
import { sendPushes, webPushSender, type PushMessage, type PushSender } from './send'

export const PUSH_TICK_MS = 5_000
/** Events taken in one go. */
const EVENTS_PER_TICK = 200
const NOTICES_PER_TICK = 20
/** A push for something this old is not sent. */
export const STALE_EVENT_MS = 30 * 60_000

const CHAT_ROLES: Role[] = ROLES.filter((r) => can(r, 'use-chat'))
const NOTICE_ROLES: Role[] = ROLES.filter((r) => can(r, 'read-notices'))
/** Only people with a device subscribed: `u` is users. */
const SUBSCRIBED = `EXISTS (SELECT 1 FROM push_subscriptions ps WHERE ps.user_id = u.id)`

export interface PushDeps {
  db: Db
  config: Config
}

// ---- Who is told what -------------------------------------------------------------

async function alertMessages(q: Queryable, ids: string[]): Promise<PushMessage[]> {
  if (ids.length === 0) return []
  const { rows } = await q.query<{ id: string; userId: string; title: string; body: string; link: string | null; severity: PushPayload['severity'] }>(
    `SELECT n.id, n.user_id AS "userId", n.title, n.body, n.link, n.severity
       FROM user_notifications n JOIN users u ON u.id = n.user_id
      WHERE n.id = ANY($1::uuid[]) AND ${LIVE_PERSON} AND ${SUBSCRIBED}`,
    [ids],
  )
  return rows.map((r) => ({ userId: r.userId, payload: { kind: 'alert', title: r.title, body: r.body, url: r.link ?? '/', tag: `alert-${r.id}`, severity: r.severity } }))
}

/** A chat message as its notification reads: who wrote it (and where, in a group), and what — a photo or a file when there are no words. */
export function chatNotification(m: { senderName: string; kind: string; conversationName: string; body: string; images: number; files: number }): { title: string; body: string } {
  const where = m.kind === 'general' ? 'General' : m.kind === 'group' ? m.conversationName.trim() : ''
  const text = plainText(m.body).trim()
  const body = text || (m.images > 0 ? (m.images === 1 ? '📷 Photo' : `📷 ${m.images} photos`) : m.files > 0 ? '📎 File' : '')
  return { title: where ? `${m.senderName} · ${where}` : m.senderName, body }
}

async function chatMessages(q: Queryable, ids: string[]): Promise<PushMessage[]> {
  if (ids.length === 0) return []
  const { rows } = await q.query<{ id: string; conversationId: string; senderId: string; senderName: string; body: string; kind: string; conversationName: string; images: number; files: number }>(
    `SELECT m.id, m.conversation_id AS "conversationId", m.sender_id AS "senderId", m.sender_name AS "senderName", m.body,
            c.kind, c.name AS "conversationName",
            (SELECT count(*)::int FROM chat_message_images i WHERE i.message_id = m.id) AS images,
            (SELECT count(*)::int FROM chat_files f WHERE f.message_id = m.id AND f.deleted_at IS NULL) AS files
       FROM chat_messages m JOIN chat_conversations c ON c.id = m.conversation_id
      WHERE m.id = ANY($1::uuid[]) AND m.deleted_at IS NULL AND c.deleted_at IS NULL
      ORDER BY m.created_at, m.id`,
    [ids],
  )
  const out: PushMessage[] = []
  for (const m of rows) {
    const people = await q.query<{ id: string }>(
      m.kind === 'general'
        ? // Everyone who may chat is in the general channel; $1 is its id, which every live account belongs to.
          `SELECT u.id FROM users u WHERE $1::uuid IS NOT NULL AND ${LIVE_PERSON} AND u.role::text = ANY($2::text[]) AND u.id <> $3 AND ${SUBSCRIBED}`
        : `SELECT u.id FROM chat_members cm JOIN users u ON u.id = cm.user_id
            WHERE cm.conversation_id = $1 AND cm.removed_at IS NULL AND ${LIVE_PERSON} AND u.role::text = ANY($2::text[]) AND u.id <> $3 AND ${SUBSCRIBED}`,
      [m.conversationId, CHAT_ROLES, m.senderId],
    )
    const text = chatNotification(m)
    for (const p of people.rows) {
      out.push({ userId: p.id, payload: { kind: 'chat', ...text, url: `/chat/${m.conversationId}`, tag: `chat-${m.conversationId}`, severity: 'info' } })
    }
  }
  return out
}

/** Target kinds that name people; any other kind ties a notice to a piece of work, which is not pushed. */
const PEOPLE_KINDS = new Set(['user', 'role'])

/**
 * The people a notice is aimed at, when its audience is people: everyone who
 * reads notices (no targets), or the roles and people named — all of them,
 * or any of them, as its match mode says. Null when it is aimed at work.
 */
export async function noticeAudience(q: Queryable, notice: { id: string; matchMode: string }): Promise<string[] | null> {
  const targets = (await q.query<{ kind: string; value: string }>(`SELECT kind, value FROM notice_targets WHERE notice_id = $1`, [notice.id])).rows
  if (targets.some((t) => !PEOPLE_KINDS.has(t.kind))) return null
  const roles = targets.filter((t) => t.kind === 'role').map((t) => t.value)
  const users = targets.filter((t) => t.kind === 'user').map((t) => t.value.toLowerCase())
  const byRole = `u.role::text = ANY($2::text[])`
  const byUser = `u.id::text = ANY($3::text[])`
  // 'all': each kind named must match (a kind not named does not care); 'any': one of them is enough. No targets: everyone.
  const matches =
    notice.matchMode === 'any' && targets.length > 0
      ? `(${byRole} OR ${byUser})`
      : `((cardinality($2::text[]) = 0 OR ${byRole}) AND (cardinality($3::text[]) = 0 OR ${byUser}))`
  const { rows } = await q.query<{ id: string }>(
    `SELECT u.id FROM users u WHERE ${LIVE_PERSON} AND u.role::text = ANY($1::text[]) AND ${matches} AND ${SUBSCRIBED} ORDER BY u.id`,
    [NOTICE_ROLES, roles, users],
  )
  return rows.map((r) => r.id)
}

/** Notices whose first day has come, marked pushed; and what goes to whom. */
async function dueNotices(q: Queryable, config: Config, now: Date): Promise<PushMessage[]> {
  const today = factoryDay(now, config.FACTORY_TIMEZONE)
  const { rows } = await q.query<{ id: string; title: string; body: string; severity: PushPayload['severity']; matchMode: string }>(
    `SELECT id, title, body, severity, match_mode AS "matchMode" FROM notices
      WHERE push_sent_at IS NULL AND deleted_at IS NULL AND withdrawn_at IS NULL
        AND valid_from <= $1::date AND (valid_to IS NULL OR valid_to >= $1::date)
      ORDER BY created_at, id LIMIT $2 FOR UPDATE SKIP LOCKED`,
    [today, NOTICES_PER_TICK],
  )
  const out: PushMessage[] = []
  for (const n of rows) {
    const people = await noticeAudience(q, n)
    for (const id of people ?? []) {
      out.push({ userId: id, payload: { kind: 'notice', title: `Notice: ${n.title}`, body: n.body, url: '/', tag: `notice-${n.id}`, severity: n.severity } })
    }
  }
  if (rows.length > 0) await q.query(`UPDATE notices SET push_sent_at = $2 WHERE id = ANY($1::uuid[])`, [rows.map((r) => r.id), now.toISOString()])
  return out
}

/**
 * One round: take the queued events and the due notices (in one transaction,
 * so another instance takes none of them), then send. Returns the pushes the
 * push services accepted.
 */
export async function dispatchOnce(deps: PushDeps, send: PushSender, now = new Date()): Promise<number> {
  const messages = await withTransaction(deps.db, async (tx) => {
    const events = await tx.query<{ kind: 'alert' | 'chat'; refId: string; createdAt: string }>(
      `DELETE FROM push_events WHERE id IN (SELECT id FROM push_events ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
       RETURNING kind, ref_id AS "refId", created_at AS "createdAt"`,
      [EVENTS_PER_TICK],
    )
    const fresh = events.rows.filter((e) => now.getTime() - new Date(e.createdAt).getTime() < STALE_EVENT_MS)
    const ids = (kind: string) => fresh.filter((e) => e.kind === kind).map((e) => e.refId)
    return [...(await alertMessages(tx, ids('alert'))), ...(await chatMessages(tx, ids('chat'))), ...(await dueNotices(tx, deps.config, now))]
  })
  return sendPushes(deps.db, deps.config, messages, send)
}

export interface PushDispatcherOptions {
  send?: PushSender
  now?: () => Date
  tickMs?: number
}

export class PushDispatcher {
  private timer: NodeJS.Timeout | null = null
  private running: Promise<void> | null = null
  private stopping = false

  constructor(
    private readonly deps: PushDeps,
    private readonly options: PushDispatcherOptions = {},
  ) {}

  start(): void {
    if (this.timer || this.stopping || !this.deps.config.PUSH_ENABLED) return
    this.timer = setInterval(() => void this.tick(), this.options.tickMs ?? PUSH_TICK_MS)
    this.timer.unref()
  }

  /** One round, never two at once on this instance. Never throws. */
  tick(): Promise<void> {
    if (this.stopping) return Promise.resolve()
    this.running ??= (async () => {
      try {
        await dispatchOnce(this.deps, this.options.send ?? webPushSender, this.options.now?.() ?? new Date())
      } catch (e) {
        console.error('[push] dispatch failed', e)
      } finally {
        this.running = null
      }
    })()
    return this.running
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.running
  }
}
