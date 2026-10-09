// ============================================================================
// §20 — the AI assistant. An administrator asks about the factory's record in
// plain words; Claude answers by running read-only SQL over curated views of
// that record (schema `ai`), and every query it ran is shown with its result
// and can be taken to Excel. The assistant reads; it never writes.
//
// What it costs is counted on every call to the model and held to a monthly
// cap an administrator sets, so the bill cannot run away.
// ============================================================================

import type { ApiErrorCode } from './api'

/** The model the assistant runs on. */
export const AI_MODEL = 'claude-sonnet-5-5'

/** Out of the box: on once a key is set, at most $50 a month. */
export const AI_DEFAULT_MONTHLY_CAP_USD = 50
/** The most a cap may be set to: a typo of an extra zero or two stays bounded. */
export const AI_MAX_MONTHLY_CAP_USD = 2000

/** The longest question one message may carry. */
export const AI_MAX_MESSAGE_CHARS = 4000
/** Rows of a query the model reads and the answer's card shows. */
export const AI_PREVIEW_ROWS = 200
/** Rows an Excel export of a query takes at most. */
export const AI_EXPORT_MAX_ROWS = 50_000

/** USD per million tokens, by model, as Anthropic bills them. */
export interface AiPrice {
  input: number
  output: number
  /** Writing the prompt cache, five-minute lifetime. */
  cacheWrite5m: number
  /** Writing the prompt cache, one-hour lifetime. */
  cacheWrite1h: number
  cacheRead: number
}

export const AI_PRICES: Readonly<Record<string, AiPrice>> = {
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2 },
  // A refusal may be rescued by another model, billed at its own rates: Sonnet 5.5's is Sonnet 5.
  'claude-sonnet-5': { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2 },
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2 },
  'claude-fable-5-1': { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 0.25 },
}

/** A model not in the table is counted at the dearest known rates: the cap errs on the safe side. */
export const AI_UNKNOWN_MODEL_PRICE: AiPrice = AI_PRICES['claude-fable-5-1']

export interface AiTokenUsage {
  inputTokens: number
  outputTokens: number
  cacheWrite5mTokens: number
  cacheWrite1hTokens: number
  cacheReadTokens: number
}

/** What a call costs, in USD, at the model's rates. */
export function aiCostUsd(model: string, u: AiTokenUsage): number {
  const price = AI_PRICES[model] ?? AI_UNKNOWN_MODEL_PRICE
  const usd =
    (u.inputTokens * price.input +
      u.outputTokens * price.output +
      u.cacheWrite5mTokens * price.cacheWrite5m +
      u.cacheWrite1hTokens * price.cacheWrite1h +
      u.cacheReadTokens * price.cacheRead) /
    1_000_000
  return Math.round(usd * 1_000_000) / 1_000_000
}

// ---- Settings ----------------------------------------------------------------

export interface AiSettings {
  /** Off: nobody can ask, whatever the key and the cap. */
  enabled: boolean
  /** USD per calendar month (UTC, as Anthropic bills); reached, the assistant stops until the 1st. */
  monthlyCapUsd: number
}

export const AI_DEFAULT_SETTINGS: AiSettings = { enabled: true, monthlyCapUsd: AI_DEFAULT_MONTHLY_CAP_USD }

/** The API key, as far as anyone may see it: whether there is one, where from, and its last four characters. */
export interface AiKeyState {
  set: boolean
  /** `environment`: the server's ANTHROPIC_API_KEY, which wins over a key set here. */
  source: 'environment' | 'app' | null
  last4?: string
  updatedAt?: string
  updatedByName?: string
  /** A key set here that can no longer be read (the server's secret changed): set it again. */
  unreadable?: boolean
}

export interface AiSetKeyRequest {
  apiKey: string
}

/** Why the assistant cannot answer now, when it cannot. */
export type AiUnavailableReason = 'no-key' | 'disabled' | 'reader-unavailable' | 'cap-reached'

export interface AiStatusResponse {
  available: boolean
  reason?: AiUnavailableReason
  model: string
  /** This calendar month (UTC), so far. */
  spentUsd: number
  capUsd: number
  /** The first instant of the month counted, ISO. */
  monthStart: string
}

export interface AiSettingsResponse {
  settings: AiSettings
  key: AiKeyState
  status: AiStatusResponse
  updatedAt?: string
  updatedByName?: string
}

// ---- Conversations -------------------------------------------------------------

export interface AiConversation {
  id: string
  /** The first question, shortened. */
  title: string
  createdAt: string
  lastMessageAt: string
}

export interface AiConversationsResponse {
  conversations: AiConversation[]
  hasMore: boolean
}

export type AiCell = string | number | boolean | null

/** A query the assistant ran, with what came back. */
export interface AiQueryPart {
  type: 'query'
  queryId: string
  /** What the query looks for, in the asker's language. */
  purpose: string
  sql: string
  ok: boolean
  columns: string[]
  /** The first AI_PREVIEW_ROWS rows. */
  rows: AiCell[][]
  /** Rows shown; with `truncated`, more matched. */
  rowCount: number
  truncated: boolean
  ms: number
  error?: string
}

export type AiPart = { type: 'text'; text: string } | AiQueryPart

/** How an answer ended. */
export type AiStopReason =
  /** Answered. */
  | 'end_turn'
  /** Cut at the length a reply may take. */
  | 'max_tokens'
  /** The model declined. */
  | 'refusal'
  /** The asker pressed Stop, or left. */
  | 'stopped'
  /** Too many queries or too long for one question. */
  | 'limit'
  /** The monthly cap was reached mid-answer. */
  | 'cap'
  | 'error'

export interface AiMessage {
  id: string
  role: 'user' | 'assistant'
  parts: AiPart[]
  createdAt: string
  /** An answer's cost, every call it took. */
  costUsd?: number
  stopReason?: AiStopReason
  /** A word on how an answer ended when it did not simply finish. */
  notice?: string
}

export interface AiMessagesResponse {
  conversation: AiConversation
  messages: AiMessage[]
}

export interface AiChatRequest {
  /** Absent: a new conversation. */
  conversationId?: string
  message: string
  /** The sender's key for this send: sent twice, it is asked once. */
  clientId: string
}

/** The answer as it is written: one JSON object per Server-Sent Event, its `type` the event name. */
export type AiStreamEvent =
  | { type: 'start'; conversation: AiConversation; userMessageId: string }
  | { type: 'text'; delta: string }
  /** A line on what the model is doing between queries. */
  | { type: 'progress'; text: string }
  | { type: 'query_start'; queryId: string; purpose: string; sql: string }
  | { type: 'query_end'; part: AiQueryPart }
  | { type: 'done'; message: AiMessage; status: AiStatusResponse }
  | { type: 'error'; code: ApiErrorCode; message: string }

/** A query of an answer run again in full, for Excel. */
export interface AiQueryExportResponse {
  purpose: string
  sql: string
  columns: string[]
  rows: AiCell[][]
  truncated: boolean
  ranAt: string
}

// ---- Usage -------------------------------------------------------------------------

export interface AiUsageResponse {
  /** YYYY-MM, UTC. */
  month: string
  spentUsd: number
  capUsd: number
  calls: number
  questions: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  byDay: { day: string; costUsd: number; calls: number }[]
  byUser: { userId: string; userName: string; costUsd: number; questions: number }[]
}
