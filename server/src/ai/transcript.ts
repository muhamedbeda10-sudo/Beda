// ============================================================================
// §20 — a conversation as it is stored. Two readings of the same rows:
//
//   • the replay: every message of the conversation still in the replay, in
//     order, exactly as it was sent or received. Each request sends it again
//     byte for byte (json columns keep the text as written), so nothing an
//     answer was built on ever changes under it.
//   • the display: per question, the asker's words and one answer made of the
//     text the model wrote and the cards of the queries it ran (each with its
//     chart, when it has one) and of the automations it proposed (§21, each
//     as it stands now: proposed, activated, discarded, or superseded by a
//     newer version of it — §22) and of the notice cards it made (§23, each as
//     it stands now too: proposed, applied, discarded, superseded or stale)
//     and of the tasks it drafted (proposed, sent, discarded or superseded)
//     and the playbook changes it made (each entry as it stands now) and
//     the Excel files it made (each as checked when it was made) and the
//     saved tables it made, changed, computed or removed (each as it stands now)
//     and the diagrams it drew (each as it was drawn),
//     the blocks the model wrote for the app (its headline figures, its
//     follow-up questions) taken out of the text and handed over on their
//     own. Thinking and the tool plumbing stay out of sight.
// ============================================================================

import type Anthropic from '@anthropic-ai/sdk'
import type { AiCell, AiChartSpec, AiConversation, AiConversationScope, AiKpi, AiMessage, AiPart, AiQueryPart, AiRunningAnswer, AiStopReason, AiTokenUsage } from '@qc/shared/ai'
import type { Queryable } from '../db/pool'
import { loadProposalParts } from '../automations/proposals'
import { loadNoticeParts } from '../noticeAssistant/proposals'
import { loadPlaybookParts } from '../playbook/parts'
import { loadTaskParts } from '../tasks/proposals'
import { loadTurnAttachments, type StoredBlock, type StoredMessage } from './attachments'
import { loadSavedTableParts } from './savedTableParts'
import { stripBlocks } from './blocks'
import { loadExcelParts } from './excelParts'
import { loadDiagramParts } from './diagrams'
import { KPIS_BLOCK, parseKpis } from './kpis'
import { SUGGESTIONS_BLOCK, parseSuggestions } from './suggestions'

// ---- Conversations -------------------------------------------------------------

export interface ConversationRecord extends AiConversation {
  model: string
  systemPrompt: string
  tools: Anthropic.Beta.BetaToolUnion[]
}

export const CONVERSATION_SELECT = `c.id, c.title, c.created_at AS "createdAt", c.last_message_at AS "lastMessageAt",
  c.pinned_at AS "pinnedAt", c.group_id AS "groupId", c.archived_at AS "archivedAt"`
/** Whether an answer is being written in the conversation now (one at most: ai_turns_one_running), as lists show it. */
export const ANSWERING = `EXISTS (SELECT 1 FROM ai_turns t WHERE t.conversation_id = c.id AND t.status = 'running') AS answering`

const iso = (v: string | Date | null) => (v === null ? null : new Date(v).toISOString())

export const toConversation = (c: AiConversation): AiConversation => ({
  id: c.id,
  title: c.title,
  createdAt: new Date(c.createdAt).toISOString(),
  lastMessageAt: new Date(c.lastMessageAt).toISOString(),
  pinnedAt: iso(c.pinnedAt),
  groupId: c.groupId,
  archivedAt: iso(c.archivedAt),
  ...(c.answering ? { answering: true } : {}),
})

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

/** Which conversations of a person's each scope of the list holds (see AiConversationScope). */
const SCOPE_WHERE: Record<AiConversationScope, string> = {
  all: 'c.archived_at IS NULL',
  recent: 'c.archived_at IS NULL AND c.pinned_at IS NULL AND c.group_id IS NULL',
  pinned: 'c.pinned_at IS NOT NULL',
  group: 'c.archived_at IS NULL AND c.group_id = $5::uuid',
  archived: 'c.archived_at IS NOT NULL',
}

/**
 * A page of a person's conversations in one scope of the list: the pinned
 * ones all at once, the latest pinned first; the others the latest message
 * first, from just after `before` (the last one of the page read, its id
 * breaking a tie at the API's millisecond precision).
 */
export async function listConversations(
  q: Queryable,
  userId: string,
  opts: { scope: AiConversationScope; groupId?: string | null; before: string | null; beforeId?: string | null; limit: number },
): Promise<{ conversations: AiConversation[]; hasMore: boolean }> {
  if (opts.scope === 'pinned') {
    const { rows } = await q.query<AiConversation>(
      `SELECT ${CONVERSATION_SELECT}, ${ANSWERING} FROM ai_conversations c WHERE c.user_id = $1 AND c.deleted_at IS NULL AND ${SCOPE_WHERE.pinned} ORDER BY c.pinned_at DESC, c.id DESC`,
      [userId],
    )
    return { conversations: rows.map(toConversation), hasMore: false }
  }
  const { rows } = await q.query<AiConversation>(
    `SELECT ${CONVERSATION_SELECT}, ${ANSWERING} FROM ai_conversations c
      WHERE c.user_id = $1 AND c.deleted_at IS NULL AND ${SCOPE_WHERE[opts.scope]}
        AND ($2::timestamptz IS NULL
             OR ($4::uuid IS NULL AND date_trunc('milliseconds', c.last_message_at) < $2)
             OR ($4::uuid IS NOT NULL AND (date_trunc('milliseconds', c.last_message_at), c.id) < ($2, $4::uuid)))
      ORDER BY date_trunc('milliseconds', c.last_message_at) DESC, c.id DESC LIMIT $3`,
    [userId, opts.before, opts.limit + 1, opts.beforeId ?? null, ...(opts.scope === 'group' ? [opts.groupId ?? null] : [])],
  )
  return { conversations: rows.slice(0, opts.limit).map(toConversation), hasMore: rows.length > opts.limit }
}

// ---- The replay ------------------------------------------------------------------

export interface NewMessage {
  role: 'user' | 'assistant'
  kind: 'question' | 'assistant' | 'tool_results' | 'repair'
  /** Exactly what is sent to the model for this message; a question's files by reference (attachments.ts). */
  content: StoredBlock[]
  /** The answer as received, when what is replayed differs from it. */
  rawContent?: Anthropic.Beta.BetaContentBlock[]
  /** False: kept for display only (a refused answer), never sent again. */
  inReplay?: boolean
  /**
   * An answer's step stored before its tools run (never in the replay yet): should the answer be cut short, it is
   * finished from here, each tool run once, rather than asked of the model again. It joins the replay with its results.
   */
  pending?: boolean
  model?: string
}

/**
 * Append messages to a conversation, numbered after its last one. Returns
 * each message as it will be replayed — read back from its stored JSON, so
 * what the loop sends next is what a later request will send.
 */
/**
 * A message as the database keeps it: JSON whose every string Postgres can read. A NUL — which the model can write in
 * a tool's input — is left out: kept, it would make the message unreadable to the database's JSON operators (a turn's
 * words for the search, read as it closes, among them).
 */
// eslint-disable-next-line no-control-regex
const storable = (value: unknown): string => JSON.stringify(value, (_key, v: unknown) => (typeof v === 'string' ? v.replace(/\u0000/g, '') : v))

export async function appendMessages(q: Queryable, conversationId: string, turnId: string, messages: NewMessage[]): Promise<{ id: string; param: StoredMessage }[]> {
  const { rows } = await q.query<{ next: number }>(`SELECT COALESCE(max(seq), 0) + 1 AS next FROM ai_messages WHERE conversation_id = $1`, [conversationId])
  let seq = rows[0].next
  const out: { id: string; param: StoredMessage }[] = []
  for (const m of messages) {
    const content = storable(m.content)
    const { rows: inserted } = await q.query<{ id: string }>(
      `INSERT INTO ai_messages (conversation_id, turn_id, seq, role, kind, content, raw_content, in_replay, pending, model)
       VALUES ($1, $2, $3, $4, $5, $6::json, $7::json, $8, $9, $10) RETURNING id`,
      [conversationId, turnId, seq++, m.role, m.kind, content, m.rawContent ? storable(m.rawContent) : null, m.pending ? false : (m.inReplay ?? true), !!m.pending, m.model ?? null],
    )
    out.push({ id: inserted[0].id, param: { role: m.role, content: JSON.parse(content) as StoredBlock[] } })
  }
  // Asked in again, an archived conversation is back in the list.
  await q.query(`UPDATE ai_conversations SET last_message_at = now(), archived_at = NULL WHERE id = $1`, [conversationId])
  return out
}

/** Everything the next request sends before its own question, oldest first; files by reference. */
export async function loadReplay(q: Queryable, conversationId: string): Promise<StoredMessage[]> {
  const { rows } = await q.query<{ role: 'user' | 'assistant'; content: StoredBlock[] }>(
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
  const { rows } = await q.query<{ role: string; content: StoredBlock[] }>(
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
  /** How the result is drawn, as checkChart let it through; null or absent: no chart. */
  chart?: AiChartSpec | null
}

export async function insertQueries(q: Queryable, conversationId: string, turnId: string, queries: QueryRecord[]): Promise<void> {
  for (const r of queries) {
    await q.query(
      `INSERT INTO ai_queries (id, conversation_id, turn_id, tool_use_id, purpose, sql, ok, error, columns, rows, row_count, truncated, ms, chart)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::json, $10::json, $11, $12, $13, $14::json)`,
      [
        r.id,
        conversationId,
        turnId,
        r.toolUseId,
        r.purpose,
        r.sql,
        r.ok,
        r.error ?? null,
        JSON.stringify(r.columns),
        JSON.stringify(r.rows),
        r.rowCount,
        r.truncated,
        Math.round(r.ms),
        r.chart ? JSON.stringify(r.chart) : null,
      ],
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
  if (r.chart) part.chart = r.chart
  return part
}

export interface UsageRecord {
  userId: string
  /** The answer the call was for; null for a call that served no conversation (a scheduled report's summary). */
  conversationId: string | null
  turnId: string | null
  /** §21 — the automation whose report the call summarised. */
  automationId?: string | null
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

/** What one person's questions have cost this calendar month (UTC): their own cap is held to it. */
export async function personalMonthSpend(q: Queryable, userId: string): Promise<number> {
  const { rows } = await q.query<{ spent: number }>(
    `SELECT COALESCE(sum(cost_usd), 0)::numeric(14, 6) AS spent FROM ai_usage WHERE user_id = $1 AND created_at >= ${MONTH_START_SQL}`,
    [userId],
  )
  return Number(rows[0].spent)
}

export async function recordUsage(q: Queryable, u: UsageRecord): Promise<void> {
  await q.query(
    `INSERT INTO ai_usage (user_id, conversation_id, turn_id, model, input_tokens, output_tokens, cache_write_5m_tokens,
                           cache_write_1h_tokens, cache_read_tokens, cost_usd, request_id, partial, automation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
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
      u.automationId ?? null,
    ],
  )
}

// ---- Turns ---------------------------------------------------------------------------

/** Close a question's turn with how it ended and everything it cost. Whether this call closed it: the first to close it wins. */
export async function finishTurn(q: Queryable, turnId: string, stopReason: AiStopReason, notice: string | null): Promise<boolean> {
  const { rowCount } = await q.query(
    `UPDATE ai_turns
        SET status = 'done', stop_reason = $2, notice = $3, finished_at = now(), progress = NULL, answer_text = ai_turn_answer_text_or_null($1),
            cost_usd = (SELECT COALESCE(sum(u.cost_usd), 0) FROM ai_usage u WHERE u.turn_id = $1)
      WHERE id = $1 AND status = 'running'`,
    [turnId, stopReason, notice],
  )
  return (rowCount ?? 0) > 0
}

/**
 * The step of a turn stored before its tools ran, when the turn was cut short there: the message, and what the model
 * is sent for it. Only the conversation's last message can be one.
 */
export async function pendingStep(q: Queryable, turnId: string): Promise<{ id: string; content: Anthropic.Beta.BetaContentBlockParam[] } | null> {
  const { rows } = await q.query<{ id: string; content: Anthropic.Beta.BetaContentBlockParam[]; last: boolean }>(
    `SELECT m.id, m.content, NOT EXISTS (SELECT 1 FROM ai_messages later WHERE later.conversation_id = m.conversation_id AND later.seq > m.seq) AS last
       FROM ai_messages m WHERE m.turn_id = $1 AND m.pending ORDER BY m.seq DESC LIMIT 1`,
    [turnId],
  )
  return rows[0]?.last ? { id: rows[0].id, content: rows[0].content } : null
}

/** A pending step with its results: it joins the replay. */
export async function settleStep(q: Queryable, messageId: string): Promise<boolean> {
  const { rowCount } = await q.query(`UPDATE ai_messages SET pending = false, in_replay = true WHERE id = $1 AND pending`, [messageId])
  return (rowCount ?? 0) > 0
}

/** The answer being written in a conversation now, as whoever reopens it is told; null when none is. */
export async function runningAnswer(q: Queryable, conversationId: string): Promise<AiRunningAnswer | null> {
  const { rows } = await q.query<{
    turnId: string
    clientId: string
    question: string
    questionMessageId: string | null
    askedAt: string
    progress: string | null
    stopping: boolean
  }>(
    `SELECT t.id AS "turnId", t.client_id AS "clientId", t.question, t.created_at AS "askedAt", t.progress,
            (t.stop_requested_at IS NOT NULL) AS stopping,
            (SELECT m.id FROM ai_messages m WHERE m.turn_id = t.id AND m.kind = 'question' ORDER BY m.seq LIMIT 1) AS "questionMessageId"
       FROM ai_turns t WHERE t.conversation_id = $1 AND t.status = 'running'`,
    [conversationId],
  )
  const r = rows[0]
  return r ? { ...r, askedAt: new Date(r.askedAt).toISOString() } : null
}

// ---- The display -------------------------------------------------------------------

interface TurnRow {
  id: string
  question: string
  status: 'running' | 'done'
  stopReason: AiStopReason | null
  notice: string | null
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
 * the model's text with the cards of the queries it ran, the automations it
 * proposed and the notice cards it made, in the order they came; the headline figures it opened with
 * and the follow-up questions it closed with taken out of its text and
 * handed over on their own; and the report it was saved as, if it was. One
 * turn only, when `turnId` is given.
 */
export async function loadDisplayMessages(q: Queryable, conversationId: string, turnId?: string): Promise<AiMessage[]> {
  const params = [conversationId, turnId ?? null]
  const turns = await q.query<TurnRow>(
    `SELECT id, question, status, stop_reason AS "stopReason", notice, created_at AS "createdAt", finished_at AS "finishedAt"
       FROM ai_turns WHERE conversation_id = $1 AND ($2::uuid IS NULL OR id = $2) ORDER BY created_at, id`,
    params,
  )
  const messages = await q.query<MessageRow>(
    `SELECT id, turn_id AS "turnId", role, kind, content, raw_content AS "rawContent", created_at AS "createdAt"
       FROM ai_messages WHERE conversation_id = $1 AND ($2::uuid IS NULL OR turn_id = $2) ORDER BY seq`,
    params,
  )
  const queries = await q.query<QueryRecord>(
    `SELECT id, tool_use_id AS "toolUseId", purpose, sql, ok, error, columns, rows, row_count AS "rowCount", truncated, ms, chart
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
  const proposalByToolUse = await loadProposalParts(q, conversationId, turnId)
  const noticeByToolUse = await loadNoticeParts(q, conversationId, turnId)
  const taskByToolUse = await loadTaskParts(q, conversationId, turnId)
  const playbookByToolUse = await loadPlaybookParts(q, conversationId, turnId)
  const excelByToolUse = await loadExcelParts(q, conversationId, turnId)
  const savedTableByToolUse = await loadSavedTableParts(q, conversationId, turnId)
  const diagramByToolUse = await loadDiagramParts(q, conversationId, turnId)
  const attachmentsByTurn = await loadTurnAttachments(q, conversationId, turnId)
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
    const asked: AiMessage = { id: question?.id ?? `${t.id}:q`, role: 'user', parts: [{ type: 'text', text: t.question }], createdAt: question?.createdAt ?? t.createdAt, turnId: t.id }
    const files = attachmentsByTurn.get(t.id)
    if (files) asked.attachments = files
    out.push(asked)

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
          const proposal = proposalByToolUse.get(block.id)
          const notice = noticeByToolUse.get(block.id)
          const task = taskByToolUse.get(block.id)
          const playbook = playbookByToolUse.get(block.id)
          const excel = excelByToolUse.get(block.id)
          const savedTable = savedTableByToolUse.get(block.id)
          const diagram = diagramByToolUse.get(block.id)
          if (run) parts.push(queryPart(run))
          else if (proposal) parts.push(proposal)
          else if (notice) parts.push(notice)
          else if (task) parts.push(task)
          else if (playbook) parts.push(playbook)
          else if (excel) parts.push(excel)
          else if (savedTable) parts.push(savedTable)
          else if (diagram) parts.push(diagram)
        }
      }
    }
    const { parts: shown, suggestions, kpis } = withoutBlocks(parts)
    const answer: AiMessage = { id: t.id, role: 'assistant', parts: shown, createdAt: t.finishedAt ?? lastAt ?? t.createdAt, turnId: t.id }
    if (t.status !== 'done') {
      // Still being written, on the server: shown as far as it has got, even before its first step, so whoever
      // reopens the conversation sees it is under way. How it ends, its figures and its suggestions come when it does.
      answer.running = true
      out.push(answer)
      continue
    }
    // What an answer cost is the owner's to see, on the settings page: never in the chat.
    if (t.stopReason) answer.stopReason = t.stopReason
    if (t.notice) answer.notice = t.notice
    if (suggestions.length > 0) answer.suggestions = suggestions
    if (kpis.length > 0) answer.kpis = kpis
    const savedReportId = reportByTurn.get(t.id)
    if (savedReportId) answer.savedReportId = savedReportId
    out.push(answer)
  }
  return out
}

/**
 * An answer's parts as shown: every block for the app out of every text, and
 * an unfinished one out of the text the answer ends with; the figures of the
 * last whole <kpis> block, and the questions of the final text's last
 * <suggestions> block, on their own. A text that held nothing but blocks is
 * dropped.
 */
function withoutBlocks(parts: AiPart[]): { parts: AiPart[]; suggestions: string[]; kpis: AiKpi[] } {
  const last = parts[parts.length - 1]
  const suggestions = last?.type === 'text' ? parseSuggestions(last.text) : []
  const kpis = parseKpis(parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])))
  const shown: AiPart[] = []
  parts.forEach((p, i) => {
    if (p.type !== 'text') {
      shown.push(p)
      return
    }
    const text = stripBlocks(p.text, i === parts.length - 1, [KPIS_BLOCK, SUGGESTIONS_BLOCK])
    if (text === p.text) shown.push(p)
    else if (text.trim() !== '') shown.push({ type: 'text', text })
  })
  return { parts: shown, suggestions, kpis }
}
