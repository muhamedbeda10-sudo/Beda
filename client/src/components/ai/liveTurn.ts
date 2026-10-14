// ============================================================================
// §20 — the answer being written. The stream's events (start, text, progress,
// query_start, query_end, automation, notice, task, playbook, excel, saved-table,
// diagram, done, error) are folded into one value
// the thread draws, and the saved conversation takes over once it holds the
// same answer. The answer is the server's once `start` has named its
// question: it goes on there whatever becomes of the connection, and only
// Stop ends it early. A stream lost after that lets go of the turn
// (detached), and the saved conversation, asked again while the answer runs,
// shows the rest. Pure functions, so the folding is tested without a browser.
// ============================================================================

import type { ApiErrorCode } from '@qc/shared/api'
import type { AiAttachment, AiConversation, AiMessage, AiMessagesResponse, AiPart, AiRunningAnswer, AiStreamEvent } from '@qc/shared/ai'
import { revisedProposalId, supersedeParts } from '@/components/automations/wording'

/** A query the model asked for that has not come back: running, or cut off when the answer ended. */
export interface PendingQuery {
  type: 'pending-query'
  queryId: string
  purpose: string
  sql: string
  state: 'running' | 'interrupted'
}

export type LivePart = AiPart | PendingQuery

/** `detached`: this device let go of the stream after `start` (or lost it); the answer goes on on the server. */
export type LivePhase = 'sending' | 'streaming' | 'done' | 'stopped' | 'error' | 'detached'

export interface LiveTurn {
  /** The send's own key, also its clientId: one per question asked. */
  key: string
  /** Null until the server names the conversation a first question opens. */
  conversationId: string | null
  conversation: AiConversation | null
  question: string
  /** The files the question carries, in order. */
  attachments: AiAttachment[]
  /** When it was sent, by this device's clock. */
  sentAt: string
  /** A message the question was sent after (sentAfter): the question, saved, comes after it. */
  after: string | null
  /** The question as saved, once the server has it. */
  userMessageId: string | null
  parts: LivePart[]
  /** The model's latest word on what it is doing, between queries. */
  progress: string | null
  phase: LivePhase
  /** Stop was pressed and the server asked to end it: it ends at its next step, and its `done` says so. */
  stopping: boolean
  error: { code: ApiErrorCode; message: string } | null
  /** The answer as saved, once done. */
  message: AiMessage | null
}

export function startTurn(key: string, conversationId: string | null, question: string, sentAt: string, after: string | null = null, attachments: AiAttachment[] = []): LiveTurn {
  return { key, conversationId, conversation: null, question, attachments, sentAt, after, userMessageId: null, parts: [], progress: null, phase: 'sending', stopping: false, error: null, message: null }
}

export const isInFlight = (t: LiveTurn | null): boolean => !!t && (t.phase === 'sending' || t.phase === 'streaming')

/** One event of the stream applied. Events after the end are ignored. */
export function applyEvent(t: LiveTurn, e: AiStreamEvent): LiveTurn {
  if (!isInFlight(t)) return t
  switch (e.type) {
    case 'start':
      return { ...t, phase: 'streaming', conversationId: e.conversation.id, conversation: e.conversation, userMessageId: e.userMessageId }
    case 'text': {
      if (!e.delta) return t
      const last = t.parts.at(-1)
      const parts = last?.type === 'text' ? [...t.parts.slice(0, -1), { type: 'text' as const, text: last.text + e.delta }] : [...t.parts, { type: 'text' as const, text: e.delta }]
      return { ...t, phase: 'streaming', parts, progress: null }
    }
    case 'progress':
      return { ...t, phase: 'streaming', progress: e.text.trim() || t.progress }
    case 'query_start':
      if (t.parts.some((p) => (p.type === 'query' || p.type === 'pending-query') && p.queryId === e.queryId)) return t
      return { ...t, phase: 'streaming', progress: null, parts: [...t.parts, { type: 'pending-query', queryId: e.queryId, purpose: e.purpose, sql: e.sql, state: 'running' }] }
    case 'query_end': {
      const at = t.parts.findIndex((p) => p.type === 'pending-query' && p.queryId === e.part.queryId)
      const parts = at >= 0 ? t.parts.map((p, i) => (i === at ? e.part : p)) : [...t.parts, e.part]
      return { ...t, phase: 'streaming', progress: null, parts }
    }
    case 'automation': {
      // §21 — a proposal's card, where it came; the same proposal again (sent twice) takes its place.
      const at = t.parts.findIndex((p) => p.type === 'automation' && p.proposalId === e.part.proposalId)
      const parts = at >= 0 ? t.parts.map((p, i) => (i === at ? e.part : p)) : [...t.parts, e.part]
      // §22 — a newer version of a card earlier in this answer: that one says at once it was replaced. A card of an
      // earlier answer is marked in the saved conversation (supersedeAutomationPart).
      const replaced = revisedProposalId(e.part)
      return { ...t, phase: 'streaming', progress: null, parts: replaced ? supersedeParts(parts, replaced) : parts }
    }
    case 'notice': {
      // §23 — a notice card, where it came; the same card again (sent twice) takes its place. A card it replaced in an
      // earlier answer is marked so in the saved conversation, fetched again once the server keeps this one
      // (AiAssistantProvider); until then that card waits (noticeCardsWait).
      const at = t.parts.findIndex((p) => p.type === 'notice' && p.proposalId === e.part.proposalId)
      const parts = at >= 0 ? t.parts.map((p, i) => (i === at ? e.part : p)) : [...t.parts, e.part]
      return { ...t, phase: 'streaming', progress: null, parts }
    }
    case 'playbook': {
      // A playbook change, where it came; the same card again (sent twice) takes its place.
      const at = t.parts.findIndex((p) => p.type === 'playbook' && p.changeId === e.part.changeId)
      const parts = at >= 0 ? t.parts.map((p, i) => (i === at ? e.part : p)) : [...t.parts, e.part]
      return { ...t, phase: 'streaming', progress: null, parts }
    }
    case 'excel': {
      // An Excel file, where it came; the same card again (sent twice) takes its place.
      const at = t.parts.findIndex((p) => p.type === 'excel' && p.fileId === e.part.fileId)
      const parts = at >= 0 ? t.parts.map((p, i) => (i === at ? e.part : p)) : [...t.parts, e.part]
      return { ...t, phase: 'streaming', progress: null, parts }
    }
    case 'diagram': {
      // A diagram, where it came; the same card again (sent twice) takes its place.
      const at = t.parts.findIndex((p) => p.type === 'diagram' && p.diagramId === e.part.diagramId)
      const parts = at >= 0 ? t.parts.map((p, i) => (i === at ? e.part : p)) : [...t.parts, e.part]
      return { ...t, phase: 'streaming', progress: null, parts }
    }
    case 'saved-table': {
      // A saved table made, replaced, computed or removed, where it came; the same card again (sent twice) takes its place.
      const at = t.parts.findIndex((p) => p.type === 'saved-table' && p.changeId === e.part.changeId)
      const parts = at >= 0 ? t.parts.map((p, i) => (i === at ? e.part : p)) : [...t.parts, e.part]
      return { ...t, phase: 'streaming', progress: null, parts }
    }
    case 'task': {
      // A task card, where it came; the same card again (sent twice) takes its place. A card it replaced in an earlier
      // answer is marked so in the saved conversation, fetched again once the server keeps this one (AiAssistantProvider);
      // until then that card waits (taskCardsWait).
      const at = t.parts.findIndex((p) => p.type === 'task' && p.proposalId === e.part.proposalId)
      const parts = at >= 0 ? t.parts.map((p, i) => (i === at ? e.part : p)) : [...t.parts, e.part]
      return { ...t, phase: 'streaming', progress: null, parts }
    }
    case 'title':
      // The conversation renamed by the assistant: nothing of the answer changes.
      return t.conversationId === e.conversation.id ? { ...t, conversation: e.conversation } : t
    case 'done':
      return { ...t, phase: 'done', progress: null, message: e.message, parts: interrupt(t.parts) }
    case 'error':
      return { ...t, phase: 'error', progress: null, error: { code: e.code, message: e.message }, parts: interrupt(t.parts) }
    default:
      return t
  }
}

/**
 * Whether an event comes from a later call of the model than the tool calls
 * before it, so the round they ran in is kept by now: the server runs a
 * round's calls once the model has written it, keeps the round, then calls
 * the model again — and text, and its word on what it is doing, come only
 * while it writes. A query or a card may still be of the round being run.
 */
export const followsKeptRound = (e: AiStreamEvent): boolean => e.type === 'text' || e.type === 'progress'

/** The answer ended on this side before the server had it: the asker stopped it, or the connection or the request failed. */
export function endTurn(t: LiveTurn, phase: 'stopped' | 'error', error?: { code: ApiErrorCode; message: string }): LiveTurn {
  if (!isInFlight(t)) return t
  return { ...t, phase, progress: null, error: phase === 'error' ? (error ?? { code: 'internal', message: 'The answer could not be finished.' }) : null, parts: interrupt(t.parts) }
}

/** Stop pressed (`asked`), or taken back when the server could not be told: the answer goes on until its `done`. */
export function askedToStop(t: LiveTurn, asked = true): LiveTurn {
  if (t.stopping === asked || (asked && !isInFlight(t))) return t
  return { ...t, stopping: asked }
}

const LOST = { code: 'internal' as const, message: 'The connection was lost before the answer finished.' }

/**
 * A turn whose stream ended without saying how the answer ended (no done, no
 * error): the connection closed or failed, or this device let go of it. Once
 * `start` has named the question the server has the answer, and it goes on
 * there whatever became of the connection — only Stop ends it, and the server
 * says so — so the turn is let go of as it stood, its queries still running,
 * and the saved conversation shows the rest. Before `start` nothing of it may
 * have been kept: Stop pressed then (`stopped`) ends it as stopped, and
 * anything else as lost. Either way, a question the server did keep is found
 * in the saved conversation by its words (askedAt), which then draws it.
 */
export function streamEnded(t: LiveTurn, stopped: boolean): LiveTurn {
  if (!isInFlight(t)) return t
  if (t.userMessageId !== null) return { ...t, phase: 'detached', progress: null }
  return stopped ? endTurn(t, 'stopped') : endTurn(t, 'error', LOST)
}

function interrupt(parts: LivePart[]): LivePart[] {
  return parts.some((p) => p.type === 'pending-query' && p.state === 'running') ? parts.map((p) => (p.type === 'pending-query' ? { ...p, state: 'interrupted' as const } : p)) : parts
}

/** An event from the wire, or null for anything this client does not know (a newer server's additions are skipped). */
export function parseStreamEvent(event: string, data: string): AiStreamEvent | null {
  let value: unknown
  try {
    value = JSON.parse(data)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  const type = (value as { type?: unknown }).type
  if (typeof type !== 'string' || !KNOWN.has(type)) return null
  // The event's name and its `type` say the same thing; a frame where they differ is not trusted.
  if (event !== 'message' && event !== type) return null
  return value as AiStreamEvent
}

const KNOWN = new Set<string>(['start', 'text', 'progress', 'query_start', 'query_end', 'automation', 'notice', 'task', 'playbook', 'excel', 'saved-table', 'diagram', 'title', 'done', 'error'])

/**
 * What a question is sent after (LiveTurn.after): the last message this device
 * has of the conversation — unless the answer before it, in the same
 * conversation, had its question saved (the server named it) and this device
 * has not fetched it yet. Then that question is the anchor: the new one surely
 * comes after it. Without it, the same words asked again at once after an
 * answer this device let go of (or that failed after its start), refused or
 * cut off before their own start, would be taken for that earlier question,
 * and their error never drawn.
 */
export function sentAfter(prev: LiveTurn | null, conversationId: string | null, cached: readonly AiMessage[] | undefined): string | null {
  if (conversationId === null) return null
  const before = prev && prev.conversationId === conversationId ? prev.userMessageId : null
  if (before && !cached?.some((m) => m.id === before)) return before
  return cached?.at(-1)?.id ?? null
}

/**
 * Where the turn's question sits in the saved list, or -1. By its id once the
 * server has named it. A turn that ended before the stream began (a stop, a
 * lost connection) never learns it, though the server may have saved the
 * question: that one is placed by its words — the latest question asked in
 * them since the message the device last had when it was sent. While a turn
 * is still being sent, its id is moments away and its words could still be
 * an earlier question's, so it is not placed.
 */
export function askedAt(t: LiveTurn, saved: readonly AiMessage[]): number {
  if (t.userMessageId) return saved.findIndex((m) => m.id === t.userMessageId)
  if (isInFlight(t)) return -1
  let from = 0
  if (t.after !== null) {
    from = saved.findIndex((m) => m.id === t.after) + 1
    // What it was sent after is gone from the list (deleted, reloaded short): nothing places it safely.
    if (from === 0) return -1
  }
  for (let i = saved.length - 1; i >= from; i--) {
    const m = saved[i]
    if (m.role === 'user' && answerText(m.parts) === t.question) return i
  }
  return -1
}

/**
 * What of the turn the thread still draws itself, given the conversation as
 * saved: the question until the saved list holds it, the answer until an
 * answer follows that question there. While it is being written, the saved
 * list is cut before the question, so a half-saved answer never shows twice.
 */
export function liveView(t: LiveTurn | null, conversationId: string | null, saved: readonly AiMessage[]): { saved: readonly AiMessage[]; question: boolean; answer: boolean } {
  if (!t || t.conversationId !== conversationId) return { saved, question: false, answer: false }
  const at = askedAt(t, saved)
  if (isInFlight(t)) return { saved: at >= 0 ? saved.slice(0, at) : saved, question: true, answer: true }
  if (at < 0) return { saved, question: true, answer: true }
  const answered = saved.slice(at + 1).some((m) => m.role === 'assistant')
  return { saved, question: false, answer: !answered }
}

/**
 * Whether the turn is one this device let go of in the conversation and still
 * draws itself: its answer goes on on the server, and the saved conversation
 * (not fetched again yet) does not hold it.
 */
export function letGoOf(t: LiveTurn | null, conversationId: string | null, saved: readonly AiMessage[]): t is LiveTurn {
  return !!t && t.phase === 'detached' && conversationId !== null && t.conversationId === conversationId && liveView(t, conversationId, saved).answer
}

/**
 * The parts of the answer being written in a conversation, wherever the
 * thread draws it from: the turn this device reads, a turn it let go of until
 * the saved conversation holds its answer, or else a saved answer the server
 * is still writing. Empty when none is being written there.
 */
export function partsBeingWritten(t: LiveTurn | null, conversationId: string | null, saved: readonly AiMessage[]): readonly LivePart[] {
  if (conversationId === null) return []
  if (t && t.conversationId === conversationId && isInFlight(t)) return t.parts
  if (letGoOf(t, conversationId, saved)) return t.parts
  return saved.find((m) => m.role === 'assistant' && m.running)?.parts ?? []
}

/** A drawn item of the thread, with its React key: a saved message, or the turn's own question or answer. */
export type ThreadItem = { key: string; kind: 'saved'; message: AiMessage } | { key: string; kind: 'question' } | { key: string; kind: 'answer' }

const answerKey = (questionId: string) => `answer:${questionId}`

/**
 * The thread in order: the saved messages, then what of the turn is still
 * drawn live (liveView). An answer is keyed by the question it replies to,
 * which is the same key while it is written, once it is saved and after the
 * next question is asked — so it is one component throughout, and its query
 * cards keep their state (opened, the table and its filters) as it is saved.
 */
export function threadItems(t: LiveTurn | null, view: { saved: readonly AiMessage[]; question: boolean; answer: boolean }): ThreadItem[] {
  const items: ThreadItem[] = []
  const used = new Set<string>()
  // A key taken twice (a list the server sent oddly) falls back to one that cannot be.
  const add = (item: ThreadItem, fallback: string) => {
    const key = used.has(item.key) ? fallback : item.key
    used.add(key)
    items.push({ ...item, key })
  }
  let asked: string | null = null
  for (const m of view.saved) {
    if (m.role === 'user') {
      asked = m.id
      add({ key: m.id, kind: 'saved', message: m }, `message:${m.id}`)
    } else {
      add({ key: asked ? answerKey(asked) : m.id, kind: 'saved', message: m }, `message:${m.id}`)
      asked = null
    }
  }
  if (t && view.question) add({ key: `question:${t.key}`, kind: 'question' }, `question:${t.key}`)
  if (t && view.answer) {
    // The question as saved names the answer; before the server has named it, the turn's own key does.
    const at = askedAt(t, view.saved)
    const questionId = t.userMessageId ?? (at >= 0 ? view.saved[at].id : null)
    add({ key: questionId ? answerKey(questionId) : `live:${t.key}`, kind: 'answer' }, `live:${t.key}`)
  }
  return items
}

/**
 * The conversation's last answer, the one that offers follow-up questions:
 * the last item, when it is an answer. Once a question is asked after it,
 * there is none until that question's answer ends.
 */
export function latestAnswerKey(items: readonly ThreadItem[]): string | null {
  const last = items.at(-1)
  if (!last) return null
  return last.kind === 'answer' || (last.kind === 'saved' && last.message.role === 'assistant') ? last.key : null
}

/**
 * The question and its answer put into the saved conversation as they ended,
 * so the hand-over draws nothing twice. A copy already there (a refetch while
 * the answer was written holds it half-done and marked running, without its
 * last words or how it ended) is replaced, not kept; and that refetch's word
 * that the answer is still being written goes with it.
 */
export function settleMessages(old: AiMessagesResponse | undefined, conversation: AiConversation, asked: AiMessage, answer: AiMessage): AiMessagesResponse {
  const base = old ?? { conversation, messages: [] }
  const fresh = new Map([asked, answer].map((m) => [m.id, m]))
  const have = new Set(base.messages.map((m) => m.id))
  const messages = base.messages.map((m) => fresh.get(m.id) ?? m)
  const add = [asked, answer].filter((m) => !have.has(m.id))
  const next: AiMessagesResponse = { ...base, messages: [...messages, ...add] }
  const running = base.running
  if (running && (running.turnId === answer.turnId || running.questionMessageId === asked.id)) next.running = null
  return next
}

/**
 * What a screen reader hears of the answer being written: a word each time
 * its phase changes — never the model's running commentary, which changes
 * several times a second.
 */
export function liveAnnouncement(t: LiveTurn | null): string {
  if (!t) return ''
  switch (t.phase) {
    case 'sending':
    case 'streaming':
      if (t.stopping) return 'Stopping…'
      return t.parts.some((p) => p.type === 'pending-query' && p.state === 'running') ? 'Running a query…' : 'Thinking…'
    case 'detached':
      return 'Thinking…'
    case 'done':
      return t.message?.stopReason === 'stopped' ? 'Stopped.' : 'Answer ready.'
    case 'stopped':
      return 'Stopped.'
    case 'error':
      return t.error?.message ?? 'The answer could not be finished.'
  }
}

/** What a screen reader hears of an answer the server is writing, as the saved conversation last said it. */
const runningAnnouncement = (running: AiRunningAnswer): string => (running.stopping ? 'Stopping…' : 'Thinking…')

/**
 * What the thread reads out, as its answer changes phase: the turn this
 * device reads; else an answer the server is writing (reopened, or let go
 * of); a turn let go of is ready once the saved conversation holds its answer
 * and no longer says it runs. The turn of another conversation says nothing.
 */
export function threadAnnouncement(t: LiveTurn | null, conversationId: string | null, view: { answer: boolean }, running: AiRunningAnswer | null | undefined): string {
  const mine = t && t.conversationId === conversationId ? t : null
  if (mine && isInFlight(mine)) return liveAnnouncement(mine)
  if (running) return runningAnnouncement(running)
  if (mine?.phase === 'detached') return view.answer ? liveAnnouncement(mine) : 'Answer ready.'
  return liveAnnouncement(mine)
}

/** The text of an answer, as markdown, for the clipboard. */
export function answerText(parts: readonly LivePart[]): string {
  return parts
    .filter((p): p is Extract<LivePart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text.trim())
    .filter(Boolean)
    .join('\n\n')
}
