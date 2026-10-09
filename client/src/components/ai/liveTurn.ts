// ============================================================================
// §20 — the answer being written. The stream's events (start, text, progress,
// query_start, query_end, done, error) are folded into one value the thread
// draws, and the saved conversation takes over once it holds the same answer.
// Pure functions, so the folding is tested without a browser.
// ============================================================================

import type { ApiErrorCode } from '@qc/shared/api'
import type { AiConversation, AiMessage, AiPart, AiStreamEvent } from '@qc/shared/ai'

/** A query the model asked for that has not come back: running, or cut off when the answer ended. */
export interface PendingQuery {
  type: 'pending-query'
  queryId: string
  purpose: string
  sql: string
  state: 'running' | 'interrupted'
}

export type LivePart = AiPart | PendingQuery

export type LivePhase = 'sending' | 'streaming' | 'done' | 'stopped' | 'error'

export interface LiveTurn {
  /** The send's own key, also its clientId: one per question asked. */
  key: string
  /** Null until the server names the conversation a first question opens. */
  conversationId: string | null
  conversation: AiConversation | null
  question: string
  /** When it was sent, by this device's clock. */
  sentAt: string
  /** The question as saved, once the server has it. */
  userMessageId: string | null
  parts: LivePart[]
  /** The model's latest word on what it is doing, between queries. */
  progress: string | null
  phase: LivePhase
  error: { code: ApiErrorCode; message: string } | null
  /** The answer as saved, once done. */
  message: AiMessage | null
}

export function startTurn(key: string, conversationId: string | null, question: string, sentAt: string): LiveTurn {
  return { key, conversationId, conversation: null, question, sentAt, userMessageId: null, parts: [], progress: null, phase: 'sending', error: null, message: null }
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
    case 'done':
      return { ...t, phase: 'done', progress: null, message: e.message, parts: interrupt(t.parts) }
    case 'error':
      return { ...t, phase: 'error', progress: null, error: { code: e.code, message: e.message }, parts: interrupt(t.parts) }
    default:
      return t
  }
}

/** The answer ended on this side: the asker stopped it, or the connection or the request failed. */
export function endTurn(t: LiveTurn, phase: 'stopped' | 'error', error?: { code: ApiErrorCode; message: string }): LiveTurn {
  if (!isInFlight(t)) return t
  return { ...t, phase, progress: null, error: phase === 'error' ? (error ?? { code: 'internal', message: 'The answer could not be finished.' }) : null, parts: interrupt(t.parts) }
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

const KNOWN = new Set<string>(['start', 'text', 'progress', 'query_start', 'query_end', 'done', 'error'])

/**
 * What of the turn the thread still draws itself, given the conversation as
 * saved: the question until the saved list holds it, the answer until an
 * answer follows that question there. While it is being written, the saved
 * list is cut before the question, so a half-saved answer never shows twice.
 */
export function liveView(t: LiveTurn | null, conversationId: string | null, saved: AiMessage[]): { saved: AiMessage[]; question: boolean; answer: boolean } {
  if (!t || t.conversationId !== conversationId) return { saved, question: false, answer: false }
  const at = t.userMessageId ? saved.findIndex((m) => m.id === t.userMessageId) : -1
  if (isInFlight(t)) return { saved: at >= 0 ? saved.slice(0, at) : saved, question: true, answer: true }
  if (at < 0) return { saved, question: true, answer: true }
  const answered = saved.slice(at + 1).some((m) => m.role === 'assistant')
  return { saved, question: false, answer: !answered }
}

/** The text of an answer, as markdown, for the clipboard. */
export function answerText(parts: readonly LivePart[]): string {
  return parts
    .filter((p): p is Extract<LivePart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text.trim())
    .filter(Boolean)
    .join('\n\n')
}
