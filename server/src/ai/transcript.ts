// ============================================================================
// §20 — a conversation as it is stored. Two readings of the same rows:
//
//   • the replay: every message of the conversation still in the replay, in
//     order, exactly as it was sent or received. Each request sends it again
//     byte for byte (json columns keep the text as written), so nothing an
//     answer was built on ever changes under it.
//   • the display: per question, the asker's words and one answer made of the
//     text the model wrote and the cards of the queries it ran. Thinking and
//     the tool plumbing stay out of sight.
// ============================================================================

import type Anthropic from '@anthropic-ai/sdk'
import type { AiCell, AiConversation, AiMessage, AiPart, AiQueryPart, AiStopReason, AiTokenUsage } from '@qc/shared/ai'
import type { Queryable } from '../db/pool'
import { parseSuggestions, stripSuggestions } from './suggestions'

type MessageParam = Anthropic.Beta.BetaMessageParam

// ---- Conversations -------------------------------------------------------------

export interface ConversationRecord extends AiConversation {
  model: string
  systemPrompt: string
  tools: Anthropic.Beta.BetaToolUnion[]
}

const CONVERSATION_SELECT = `c.id, c.title, c.created_at AS "createdAt", c.last_message_at AS "lastMessageAt"`

export const toConversation = (c: AiConversation): AiConversation => ({ id: c.id, title: c.title, createdAt: c.createdAt, lastMessageAt: c.lastMessageAt })

/** The person's own conversation, unless it was deleted. Someone else's is "not found", never a hint that it exists. */
export async function findConversation(q: Queryable, id: string, userId: string, forUpdate = false): Promise<ConversationRecord | null> {
  const { rows } = await q.query<ConversationRecord>(
    `SELECT ${CONVERSATION_SELECT}, c.model, c.system_prompt AS "systemPrompt", c.tools
       FROM ai_conversations c
      WHERE c.id = $1 AND c.user_id = $2 AND c.deleted_at IS NULL${forUpdate ? ' FOR UPDATE' : ''}`,
    [id, userId],
  )
  return rows[0] ?? null
}

export async function createConversation(
  q: Queryable,
  c: { userId: string; title: string; model: string; systemPrompt: string; tools: Anthropic.Beta.BetaToolUnion[] },
): Promise<ConversationRecord> {
  const { rows } = await q.query<ConversationRecord>(
    `INSERT INTO ai_conversations AS c (user_id, title, model, system_prompt, tools)
     VALUES ($1, $2, $3, $4, $5::json)
     RETURNING ${CONVERSATION_SELECT}, c.model, c.system_prompt AS "systemPrompt", c.tools`,
    [c.userId, c.title, c.model, c.systemPrompt, JSON.stringify(c.tools)],
  )
  return rows[0]
}

export async function listConversations(q: Queryable, userId: string, before: string | null, limit: number): Promise<{ conversations: AiConversation[]; hasMore: boolean }> {
  const { rows } = await q.query<AiConversation>(
    `SELECT ${CONVERSATION_SELECT} FROM ai_conversations c
      WHERE c.user_id = $1 AND c.deleted_at IS NULL AND ($2::timestamptz IS NULL OR c.last_message_at < $2)
      ORDER BY c.last_message_at DESC, c.id DESC LIMIT $3`,
    [userId, before, limit + 1],
  )
  return { conversations: rows.slice(0, limit), hasMore: rows.length > limit }
}

// ---- The replay ------------------------------------------------------------------

export interface NewMessage {
  role: 'user' | 'assistant'
  kind: 'question' | 'assistant' | 'tool_results' | 'repair'
  /** Exactly what is sent to the model for this message. */
  content: Anthropic.Beta.BetaContentBlockParam[]
  /** The answer as received, when what is replayed differs from it. */
  rawContent?: Anthropic.Beta.BetaContentBlock[]
  /** False: kept for display only (a refused answer), never sent again. */
  inReplay?: boolean
  model?: string
}

/**
 * Append messages to a conversation, numbered after its last one. Returns
 * each message as it will be replayed — read back from its stored JSON, so
 * what the loop sends next is what a later request will send.
 */
export async function appendMessages(q: Queryable, conversationId: string, turnId: string, messages: NewMessage[]): Promise<{ id: string; param: MessageParam }[]> {
  const { rows } = await q.query<{ next: number }>(`SELECT COALESCE(max(seq), 0) + 1 AS next FROM ai_messages WHERE conversation_id = $1`, [conversationId])
  let seq = rows[0].next
  const out: { id: string; param: MessageParam }[] = []
  for (const m of messages) {
    const content = JSON.stringify(m.content)
    const { rows: inserted } = await q.query<{ id: string }>(
      `INSERT INTO ai_messages (conversation_id, turn_id, seq, role, kind, content, raw_content, in_replay, model)
       VALUES ($1, $2, $3, $4, $5, $6::json, $7::json, $8, $9) RETURNING id`,
      [conversationId, turnId, seq++, m.role, m.kind, content, m.rawContent ? JSON.stringify(m.rawContent) : null, m.inReplay ?? true, m.model ?? null],
    )
    out.push({ id: inserted[0].id, param: { role: m.role, content: JSON.parse(content) as Anthropic.Beta.BetaContentBlockParam[] } })
  }
  await q.query(`UPDATE ai_conversations SET last_message_at = now() WHERE id = $1`, [conversationId])
  return out
}

/** Everything the next request sends before its own question, oldest first. */
export async function loadReplay(q: Queryable, conversationId: string): Promise<MessageParam[]> {
  const { rows } = await q.query<{ role: 'user' | 'assistant'; content: Anthropic.Beta.BetaContentBlockParam[] }>(
    `SELECT role, content FROM ai_messages WHERE conversation_id = $1 AND in_replay ORDER BY seq`,
    [conversationId],
  )
  return rows.map((r) => ({ role: r.role, content: r.content }))
}

/**
 * Every tool call must be answered before the conversation goes on. An
 * answer and its results are stored together, so a call left without one
 * means a crash between the two; it is answered now, as interrupted —
 * appended, never by editing what is there.
 */
export async function repairDanglingToolUse(q: Queryable, conversationId: string, turnId: string): Promise<boolean> {
  const { rows } = await q.query<{ role: string; content: Anthropic.Beta.BetaContentBlockParam[] }>(
    `SELECT role, content FROM ai_messages WHERE conversation_id = $1 AND in_replay ORDER BY seq DESC LIMIT 1`,
    [conversationId],
  )
  const last = rows[0]
  if (!last || last.role !== 'assistant') return false
  const calls = last.content.filter((b): b is Anthropic.Beta.BetaToolUseBlockParam => b.type === 'tool_use')
  if (calls.length === 0) return false
  await appendMessages(q, conversationId, turnId, [
    {
      role: 'user',
      kind: 'repair',
      content: calls.map((c) => ({ type: 'tool_result', tool_use_id: c.id, is_error: true, content: 'Interrupted: no result was recorded.' })),
    },
  ])
  return true
}

// ---- Queries and usage -------------------------------------------------------------

export interface QueryRecord {
  id: string
  toolUseId: string
  purpose: string
  sql: string
  ok: boolean
  error?: string
  columns: string[]
  rows: AiCell[][]
  rowCount: number
  truncated: boolean
  ms: number
}

export async function insertQueries(q: Queryable, conversationId: string, turnId: string, queries: QueryRecord[]): Promise<void> {
  for (const r of queries) {
    await q.query(
      `INSERT INTO ai_queries (id, conversation_id, turn_id, tool_use_id, purpose, sql, ok, error, columns, rows, row_count, truncated, ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::json, $10::json, $11, $12, $13)`,
      [r.id, conversationId, turnId, r.toolUseId, r.purpose, r.sql, r.ok, r.error ?? null, JSON.stringify(r.columns), JSON.stringify(r.rows), r.rowCount, r.truncated, Math.round(r.ms)],
    )
  }
}

export const queryPart = (r: QueryRecord): AiQueryPart => {
  const part: AiQueryPart = {
    type: 'query',
    queryId: r.id,
    purpose: r.purpose,
    sql: r.sql,
    ok: r.ok,
    columns: r.columns,
    rows: r.rows,
    rowCount: r.rowCount,
    truncated: r.truncated,
    ms: Math.round(r.ms),
  }
  if (r.error) part.error = r.error
  return part
}

export interface UsageRecord {
  userId: string
  conversationId: string
  turnId: string
  model: string
  tokens: AiTokenUsage
  costUsd: number
  requestId?: string | null
  partial?: boolean
}

/** The first instant of the current calendar month in UTC — Anthropic bills by it. */
const MONTH_START_SQL = `(date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`

/** What this calendar month (UTC) has cost so far. Read on every check, never kept in memory, so every instance holds the same cap. */
export async function monthSpend(q: Queryable): Promise<{ spentUsd: number; monthStart: string }> {
  const { rows } = await q.query<{ spent: number; monthStart: string }>(
    `SELECT COALESCE(sum(cost_usd), 0)::numeric(14, 6) AS spent, ${MONTH_START_SQL} AS "monthStart"
       FROM ai_usage WHERE created_at >= ${MONTH_START_SQL}`,
  )
  return { spentUsd: rows[0].spent, monthStart: rows[0].monthStart }
}

export async function recordUsage(q: Queryable, u: UsageRecord): Promise<void> {
  await q.query(
    `INSERT INTO ai_usage (user_id, conversation_id, turn_id, model, input_tokens, output_tokens, cache_write_5m_tokens,
                           cache_write_1h_tokens, cache_read_tokens, cost_usd, request_id, partial)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      u.userId,
      u.conversationId,
      u.turnId,
      u.model,
      u.tokens.inputTokens,
      u.tokens.outputTokens,
      u.tokens.cacheWrite5mTokens,
      u.tokens.cacheWrite1hTokens,
      u.tokens.cacheReadTokens,
      u.costUsd,
      u.requestId ?? null,
      u.partial ?? false,
    ],
  )
}

// ---- Turns ---------------------------------------------------------------------------

/** Close a question's turn with how it ended and everything it cost. */
export async function finishTurn(q: Queryable, turnId: string, stopReason: AiStopReason, notice: string | null): Promise<void> {
  await q.query(
    `UPDATE ai_turns
        SET status = 'done', stop_reason = $2, notice = $3, finished_at = now(),
            cost_usd = (SELECT COALESCE(sum(u.cost_usd), 0) FROM ai_usage u WHERE u.turn_id = $1)
      WHERE id = $1 AND status = 'running'`,
    [turnId, stopReason, notice],
  )
}

// ---- The display -------------------------------------------------------------------

interface TurnRow {
  id: string
  question: string
  status: 'running' | 'done'
  stopReason: AiStopReason | null
  notice: string | null
  costUsd: number
  createdAt: string
  finishedAt: string | null
}

interface MessageRow {
  id: string
  turnId: string
  role: 'user' | 'assistant'
  kind: NewMessage['kind']
  content: { type: string; text?: string; id?: string }[]
  rawContent: { type: string; text?: string; id?: string }[] | null
  createdAt: string
}

/**
 * The conversation as the panel shows it: each question, then its answer —
 * the model's text with the cards of the queries it ran, in the order they
 * came, the follow-up questions it closed with taken out of its text and
 * offered on their own, and the report it was saved as, if it was. One turn
 * only, when `turnId` is given.
 */
export async function loadDisplayMessages(q: Queryable, conversationId: string, turnId?: string): Promise<AiMessage[]> {
  const params = [conversationId, turnId ?? null]
  const turns = await q.query<TurnRow>(
    `SELECT id, question, status, stop_reason AS "stopReason", notice, cost_usd AS "costUsd", created_at AS "createdAt", finished_at AS "finishedAt"
       FROM ai_turns WHERE conversation_id = $1 AND ($2::uuid IS NULL OR id = $2) ORDER BY created_at, id`,
    params,
  )
  const messages = await q.query<MessageRow>(
    `SELECT id, turn_id AS "turnId", role, kind, content, raw_content AS "rawContent", created_at AS "createdAt"
       FROM ai_messages WHERE conversation_id = $1 AND ($2::uuid IS NULL OR turn_id = $2) ORDER BY seq`,
    params,
  )
  const queries = await q.query<QueryRecord>(
    `SELECT id, tool_use_id AS "toolUseId", purpose, sql, ok, error, columns, rows, row_count AS "rowCount", truncated, ms
       FROM ai_queries WHERE conversation_id = $1 AND ($2::uuid IS NULL OR turn_id = $2)`,
    params,
  )
  // The owner's reports only: a conversation is never anyone else's to see.
  const reports = await q.query<{ turnId: string; id: string }>(
    `SELECT DISTINCT ON (r.turn_id) r.turn_id AS "turnId", r.id
       FROM ai_reports r JOIN ai_conversations c ON c.id = r.conversation_id AND c.user_id = r.user_id
      WHERE r.conversation_id = $1 AND ($2::uuid IS NULL OR r.turn_id = $2) AND r.deleted_at IS NULL AND r.turn_id IS NOT NULL
      ORDER BY r.turn_id, r.created_at DESC`,
    params,
  )
  const reportByTurn = new Map(reports.rows.map((r) => [r.turnId, r.id]))
  const queryByToolUse = new Map(queries.rows.map((r) => [r.toolUseId, r]))
  const byTurn = new Map<string, MessageRow[]>()
  for (const m of messages.rows) {
    const list = byTurn.get(m.turnId)
    if (list) list.push(m)
    else byTurn.set(m.turnId, [m])
  }

  const out: AiMessage[] = []
  for (const t of turns.rows) {
    const rows = byTurn.get(t.id) ?? []
    const question = rows.find((m) => m.kind === 'question')
    out.push({ id: question?.id ?? `${t.id}:q`, role: 'user', parts: [{ type: 'text', text: t.question }], createdAt: question?.createdAt ?? t.createdAt, turnId: t.id })

    const parts: AiPart[] = []
    let lastAt: string | null = null
    for (const m of rows) {
      if (m.kind !== 'assistant') continue
      lastAt = m.createdAt
      for (const block of m.rawContent ?? m.content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          const prev = parts[parts.length - 1]
          // A reply split into blocks (a fallback mid-sentence, say) reads as one text.
          if (prev?.type === 'text') prev.text += block.text
          else parts.push({ type: 'text', text: block.text })
        } else if (block.type === 'tool_use' && block.id) {
          const run = queryByToolUse.get(block.id)
          if (run) parts.push(queryPart(run))
        }
      }
    }
    const { parts: shown, suggestions } = withoutSuggestions(parts)
    if (shown.length === 0 && t.status !== 'done') continue
    const answer: AiMessage = { id: t.id, role: 'assistant', parts: shown, createdAt: t.finishedAt ?? lastAt ?? t.createdAt, turnId: t.id }
    if (t.status === 'done') {
      answer.costUsd = t.costUsd
      if (t.stopReason) answer.stopReason = t.stopReason
      if (t.notice) answer.notice = t.notice
    }
    if (suggestions.length > 0) answer.suggestions = suggestions
    const savedReportId = reportByTurn.get(t.id)
    if (savedReportId) answer.savedReportId = savedReportId
    out.push(answer)
  }
  return out
}

/**
 * An answer's parts as shown: the follow-up block out of every text, and an
 * unfinished one out of the text the answer ends with; the questions of the
 * final text's last block on their own. A text that held nothing but the
 * block is dropped.
 */
function withoutSuggestions(parts: AiPart[]): { parts: AiPart[]; suggestions: string[] } {
  const last = parts[parts.length - 1]
  const suggestions = last?.type === 'text' ? parseSuggestions(last.text) : []
  const shown: AiPart[] = []
  parts.forEach((p, i) => {
    if (p.type !== 'text') {
      shown.push(p)
      return
    }
    const text = stripSuggestions(p.text, i === parts.length - 1)
    if (text === p.text) shown.push(p)
    else if (text.trim() !== '') shown.push({ type: 'text', text })
  })
  return { parts: shown, suggestions }
}
