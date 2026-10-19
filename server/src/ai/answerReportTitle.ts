// ============================================================================
// §20 — the title an answer is printed under. An answer printed is a report
// handed to management: it goes out under a title that names what it shows
// ("Dimension J capability — Stam Upright 24, Sep–Oct 2026"), never the
// question as it was typed. The assistant names it once, from the question
// and the start of the answer, when the person first prints it; the title is
// kept with the answer, so printing it again costs nothing and reads the same.
//
//   • The call is the person's: its cost is kept with the answer's, in their
//     month and the app's, like any call, and it is made only while they may
//     ask (the assistant on, their cap not reached).
//   • It never stands in the print's way: a short deadline, and a failure
//     (or the assistant unavailable) prints under a stand-in — the
//     conversation's title when the assistant or the person gave it, else
//     "Quality report" — which is not kept, so the next print asks again.
// ============================================================================

import { AI_ANSWER_REPORT_TITLE_MAX, type AiAnswerReportTitleResponse } from '@qc/shared/ai'
import type { Queryable } from '../db/pool'
import { usageOf } from './assistant'
import { cleanTitle } from './conversationTitle'
import { noThinking, type AiModelClient, type ModelMessage } from './model'
import { recordUsage } from './transcript'

/** A title is a line: room enough, and a cap on the call's cost. */
const REPORT_TITLE_MAX_TOKENS = 80
/** How much of the question and of the answer the call reads: their starts say what the report is. */
const QUESTION_CHARS = 1_000
const ANSWER_CHARS = 2_500
/** How long the print waits for the title before it goes out under a stand-in. */
export const REPORT_TITLE_TIMEOUT_MS = 20_000

/** The stand-in when nothing better can be had: a report's plain name. */
export const REPORT_TITLE_FALLBACK = 'Quality report'

export const REPORT_TITLE_SYSTEM = [
  "You give the title of a report printed from a data assistant's answer in a manufacturing company's quality department, to be handed to management.",
  'Reply with the title only: 3 to 10 words naming what the report shows, as a report title reads: its subject, and the machine, item, order or period when the answer is about one (for example "Dimension J capability - Stam Upright 24, Sep-Oct 2026" or "Daily production vs quality - 14 Oct 2026").',
  'Never a question, never "Answer", "Report about" or "Question". Write it in the language and the script of the question (Arabic stays Arabic, as the person writes it; English stays English).',
  'Keep codes, numbers, machine and order names exactly as written. No quotation marks, no emoji, no full stop at the end.',
].join(' ')

const clip = (text: string, chars: number) => text.replace(/\s+/g, ' ').trim().slice(0, chars)

/** What the call reads: the question, and the start of the answer (its headline figures and first lines). */
export const reportTitleRequest = (question: string, answer: string): string =>
  `Question:\n${clip(question, QUESTION_CHARS)}\n\nAnswer (its start):\n${clip(answer, ANSWER_CHARS)}`

interface TurnRow {
  id: string
  conversationId: string
  question: string
  answerText: string | null
  reportTitle: string | null
  done: boolean
  conversationTitle: string
  titleSource: string
}

/** The answer of this person, with what its title is made from; null when it is not theirs or not there. */
async function loadTurn(q: Queryable, turnId: string, userId: string): Promise<TurnRow | null> {
  const { rows } = await q.query<TurnRow>(
    `SELECT t.id, t.conversation_id AS "conversationId", t.question, t.answer_text AS "answerText", t.report_title AS "reportTitle",
            t.status = 'done' AS done, c.title AS "conversationTitle", c.title_source AS "titleSource"
       FROM ai_turns t JOIN ai_conversations c ON c.id = t.conversation_id AND c.deleted_at IS NULL
      WHERE t.id = $1 AND t.user_id = $2`,
    [turnId, userId],
  )
  return rows[0] ?? null
}

/** Printed under when the assistant cannot name it: the conversation's title, unless that is only the question cut short. */
export function standInTitle(turn: Pick<TurnRow, 'conversationTitle' | 'titleSource'>): string {
  const title = turn.conversationTitle.replace(/\s+/g, ' ').trim()
  return turn.titleSource !== 'question' && title ? title : REPORT_TITLE_FALLBACK
}

export interface ReportTitleRequest {
  db: Queryable
  model: AiModelClient
  /** The app's key, when this person may ask now; null prints under a stand-in without a call. */
  apiKey: string | null
  userId: string
  turnId: string
  /** The model titles are given on (AI_JOBS). */
  titleModel: string
}

/** The answer's printed title: kept, or named now and kept, or a stand-in. Null when the answer is not this person's. */
export async function answerReportTitle(r: ReportTitleRequest): Promise<AiAnswerReportTitleResponse | null> {
  const turn = await loadTurn(r.db, r.turnId, r.userId)
  if (!turn) return null
  if (turn.reportTitle) return { title: turn.reportTitle, named: true }
  const answer = (turn.answerText ?? '').trim()
  if (!r.apiKey || !turn.done || !answer) return { title: standInTitle(turn), named: false }

  let message: ModelMessage
  try {
    message = await r.model.complete(
      r.apiKey,
      {
        model: r.titleModel,
        max_tokens: REPORT_TITLE_MAX_TOKENS,
        ...noThinking(r.titleModel),
        system: REPORT_TITLE_SYSTEM,
        messages: [{ role: 'user', content: reportTitleRequest(turn.question, answer) }],
      },
      { signal: AbortSignal.timeout(REPORT_TITLE_TIMEOUT_MS) },
    )
  } catch (e) {
    // The message only: an error's request details are never logged.
    console.warn(`[ai] answer ${turn.id}: no report title from the assistant:`, e instanceof Error ? e.message : String(e))
    return { title: standInTitle(turn), named: false }
  }
  const usage = usageOf(message, r.titleModel)
  await recordUsage(r.db, {
    userId: r.userId,
    conversationId: turn.conversationId,
    turnId: turn.id,
    model: usage.model,
    tokens: usage.tokens,
    costUsd: usage.costUsd,
    requestId: (message as { _request_id?: string | null })._request_id ?? null,
  })
  const words = message.content
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('')
  const title = cleanTitle(words, AI_ANSWER_REPORT_TITLE_MAX)
  if (!title) return { title: standInTitle(turn), named: false }
  // Two prints at once: the first title kept is the one both print under.
  const { rows } = await r.db.query<{ title: string }>(
    `UPDATE ai_turns SET report_title = COALESCE(report_title, $2) WHERE id = $1 RETURNING report_title AS title`,
    [turn.id, title],
  )
  return { title: rows[0]?.title ?? title, named: true }
}
