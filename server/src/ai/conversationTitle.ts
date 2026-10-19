// ============================================================================
// §20 — a new conversation's title, in a few words, by the assistant: asked
// of the cheapest model from the first question while the answer is being
// written, so the list says what the conversation is about rather than its
// first 80 characters. A question of files only keeps the first file's name.
//
//   • It replaces only the first question shortened (title_source
//     'question'): a title the person gave is never touched, even one given
//     while this call was out.
//   • The call is the person's: its cost is kept with the question's, in
//     their month and the app's, like any call.
//   • It never stands in the answer's way: it has its own short deadline, is
//     not stopped by Stop, and a failure leaves the first question as the
//     title, quietly.
// ============================================================================

import { AI_CONVERSATION_TITLE_MAX, type AiConversation } from '@qc/shared/ai'
import type { Queryable } from '../db/pool'
import { usageOf } from './assistant'
import { noThinking, type AiModelClient, type ModelMessage } from './model'
import { CONVERSATION_SELECT, recordUsage, toConversation } from './transcript'

/** A title is a few words: this is room enough, and a cap on the call's cost. */
const TITLE_MAX_TOKENS = 60
/** How much of the question the call reads: its start says what it is about. */
const QUESTION_CHARS = 1_500
/** How long the call may take before the first question stays the title. */
export const TITLE_TIMEOUT_MS = 15_000

export const TITLE_SYSTEM = [
  'You name conversations between a person in a manufacturing company and its data assistant, for their list of conversations.',
  'Reply with the title only: 2 to 7 words saying what the question is about.',
  'Write it in the language and the script of the question (Arabic stays Arabic, as the person writes it; English stays English).',
  'Keep codes, numbers, machine and order names exactly as written. No quotation marks, no emoji, no full stop at the end, never "Question about".',
].join(' ')

/** What the person asked, as the title call reads it: its start says what it is about. */
export const titleRequest = (question: string): string => question.replace(/\s+/g, ' ').trim().slice(0, QUESTION_CHARS)

/**
 * The model's reply as a title: its first line, without the quotes, the
 * "Title:" or the full stop it may have added, on one line, at most the
 * `max` characters (never cutting an emoji). Null when nothing
 * is left.
 */
export function cleanTitle(reply: string, max = AI_CONVERSATION_TITLE_MAX): string | null {
  let t = reply.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? ''
  t = t.replace(/^(title|العنوان)\s*[:：]\s*/i, '')
  // Quotes, marks and a full stop in any order around it: taken off until none is left.
  for (let before = ''; before !== t; ) {
    before = t
    t = t.replace(/^[\s"'“”‘’«»`*#]+|[\s"'“”‘’«»`*.。]+$/g, '')
  }
  t = t.replace(/\s+/g, ' ').trim()
  if (!t) return null
  const chars = Array.from(t)
  return chars.length <= max ? t : `${chars.slice(0, max - 1).join('').trimEnd()}…`
}

export interface TitleRequest {
  db: Queryable
  model: AiModelClient
  apiKey: string
  userId: string
  conversationId: string
  turnId: string
  question: string
  /** The model titles are given on (AI_JOBS). */
  titleModel: string
}

/**
 * Ask for the conversation's title and keep it, unless the person named the
 * conversation meanwhile. The conversation as it is then, or null when the
 * title was not changed (the call failed, said nothing, or was too late).
 */
export async function giveConversationTitle(r: TitleRequest): Promise<AiConversation | null> {
  let message: ModelMessage
  try {
    message = await r.model.complete(
      r.apiKey,
      {
        model: r.titleModel,
        max_tokens: TITLE_MAX_TOKENS,
        ...noThinking(r.titleModel),
        system: TITLE_SYSTEM,
        messages: [{ role: 'user', content: titleRequest(r.question) }],
      },
      { signal: AbortSignal.timeout(TITLE_TIMEOUT_MS) },
    )
  } catch (e) {
    // The message only: an error's request details are never logged.
    console.warn(`[ai] conversation ${r.conversationId}: no title from the assistant:`, e instanceof Error ? e.message : String(e))
    return null
  }
  const usage = usageOf(message, r.titleModel)
  await recordUsage(r.db, {
    userId: r.userId,
    conversationId: r.conversationId,
    turnId: r.turnId,
    model: usage.model,
    tokens: usage.tokens,
    costUsd: usage.costUsd,
    requestId: (message as { _request_id?: string | null })._request_id ?? null,
  })
  const words = message.content
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('')
  const title = cleanTitle(words)
  if (!title) return null
  const { rows } = await r.db.query<AiConversation>(
    `UPDATE ai_conversations c SET title = $2, title_source = 'assistant'
      WHERE c.id = $1 AND c.title_source = 'question' AND c.deleted_at IS NULL
      RETURNING ${CONVERSATION_SELECT}`,
    [r.conversationId, title],
  )
  return rows[0] ? toConversation(rows[0]) : null
}
