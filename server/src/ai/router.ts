// ============================================================================
// §20 — a chat question's level, chosen before it is answered: standard
// (Sonnet, high effort) or deep (Opus, high effort), fixed in the app, not a
// setting (AI_JOBS). One short call to Sonnet reads the question — what files
// it carries, and for a follow-up the question before it and its level — and
// answers in a fixed shape: the level, and why in a few words. The owner sees
// both in Activity, to tell whether it chooses well.
//
//   • It never stands in the answer's way: its own short deadline, and any
//     failure (no answer in time, an unreadable reply) gives the standard
//     level, with no reason.
//   • Its cost is the question's: recorded on the question's turn by the
//     caller, with the answer's own calls.
// ============================================================================

import { AI_JOBS, AI_LEVEL_NAMES, AI_ROUTER_FALLBACK, type AiAttachmentKind, type AiChatLevel, type AiRecordedChatLevel } from '@qc/shared/ai'
import { noThinking, type AiModelClient, type CompleteParams, type ModelMessage } from './model'

/** How long the router may take before the question goes on at the standard level. */
export const ROUTER_TIMEOUT_MS = 8_000
/** A level and a sentence: room enough, and a cap on the call's cost. */
const ROUTER_MAX_TOKENS = 300
/** How much of a question the router reads: its start says what it asks. */
const QUESTION_CHARS = 2_000

const LEVELS: Record<'standard' | 'deep', AiChatLevel> = { standard: 'chat-standard', deep: 'chat-deep' }

export const ROUTER_SYSTEM = [
  'You sort questions put to the data assistant of a steel fabrication factory (quality control: inspections, defects, measurements, coils, orders, production) by how much work answering them takes: most are answered on a strong model, the heaviest on the strongest, which costs twice as much.',
  'Reply with the level and, in at most 12 words, why. Write the reason in English.',
  '- standard: lookups, counts, lists, comparisons, rankings, trends, rates, SPC or capability, charts, Excel files, diagrams, summaries of a period, several queries joined up, reading the files attached (photos, PDFs, spreadsheets) and answering from them. "How many samples today?", "Defect rate by machine this month", "What does this inspection sheet say?"',
  '- deep: finding causes, an investigation across many steps or sources, FMEA, a plan or recommendation weighed against the record, a drawing or report to be judged in depth against the record, anything the asker says is hard or important. "Why did scrap on line 3 double since May?", "Root cause of the welding defects this quarter".',
  'A follow-up takes the level of what it asks now: "and for last month?" after a standard question is standard.',
  'When unsure, choose standard.',
].join('\n')

export const ROUTER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['level', 'reason'],
  properties: {
    level: { type: 'string', enum: ['standard', 'deep'] },
    reason: { type: 'string' },
  },
} as const

export interface RouterInput {
  model: AiModelClient
  apiKey: string
  question: string
  /** The conversation's last question and its level, for a follow-up. */
  previous?: { question: string; level: AiRecordedChatLevel | null } | null
  /** The kinds of the files the question carries, in order; none for a question without. */
  files?: readonly AiAttachmentKind[]
  /** The asker leaving stops the call with the rest. */
  signal?: AbortSignal
}

export interface RouterResult {
  level: AiChatLevel
  /** Why, in a few words; null when the router could not be asked. */
  reason: string | null
  /** The call's reply, for its usage (null when no call came back). */
  message: ModelMessage | null
}

/** What the router reads: the question, and the one before it for a follow-up. */
export function routerRequest(input: Pick<RouterInput, 'question' | 'previous' | 'files'>): CompleteParams {
  const clip = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, QUESTION_CHARS)
  const before = input.previous
    ? `The question before it in this conversation${input.previous.level ? ` (answered as ${AI_LEVEL_NAMES[input.previous.level].toLowerCase()})` : ''}:\n${clip(input.previous.question)}\n\n`
    : ''
  const files = input.files?.length ? `\n\nIt carries ${describeFiles(input.files)}.` : ''
  return {
    model: AI_JOBS.router.model,
    max_tokens: ROUTER_MAX_TOKENS,
    // It answers at once: thinking would spend the reply's few tokens and leave no level (noThinking).
    ...noThinking(AI_JOBS.router.model),
    system: ROUTER_SYSTEM,
    output_config: { format: { type: 'json_schema', schema: ROUTER_SCHEMA as unknown as Record<string, unknown> } },
    messages: [{ role: 'user', content: `${before}The question to sort:\n${clip(input.question) || '(no words)'}${files}` }],
  }
}

const FILE_WORDS: Record<AiAttachmentKind, [string, string]> = { image: ['a photo', 'photos'], pdf: ['a PDF', 'PDFs'], sheet: ['a spreadsheet', 'spreadsheets'] }

/** "2 photos and a PDF": the files a question carries, by kind. */
export function describeFiles(kinds: readonly AiAttachmentKind[]): string {
  const counts = new Map<AiAttachmentKind, number>()
  for (const k of kinds) counts.set(k, (counts.get(k) ?? 0) + 1)
  const parts = [...counts].map(([k, n]) => (n === 1 ? FILE_WORDS[k][0] : `${n} ${FILE_WORDS[k][1]}`))
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0]
}

/** The level a reply names, or null when it names none. */
export function readRouterReply(message: ModelMessage): { level: AiChatLevel; reason: string | null } | null {
  const text = message.content
    .filter((b): b is Extract<(typeof message.content)[number], { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('')
  try {
    const parsed = JSON.parse(text) as { level?: unknown; reason?: unknown }
    const level = typeof parsed.level === 'string' ? LEVELS[parsed.level as keyof typeof LEVELS] : undefined
    if (!level) return null
    const reason = typeof parsed.reason === 'string' ? parsed.reason.replace(/\s+/g, ' ').trim().slice(0, 200) : ''
    return { level, reason: reason || null }
  } catch {
    return null
  }
}

/** The question's level: the router's, or the standard one when it cannot be had in time. */
export async function chooseLevel(input: RouterInput): Promise<RouterResult> {
  const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(ROUTER_TIMEOUT_MS)]) : AbortSignal.timeout(ROUTER_TIMEOUT_MS)
  let message: ModelMessage
  try {
    message = await input.model.complete(input.apiKey, routerRequest(input), { signal })
  } catch (e) {
    // The message only: an error's request details are never logged.
    console.warn('[ai] no level from the router; the question goes on at the standard level:', e instanceof Error ? e.message : String(e))
    return { level: AI_ROUTER_FALLBACK, reason: null, message: null }
  }
  const read = readRouterReply(message)
  if (!read) console.warn(`[ai] the router's reply named no level (stop: ${message.stop_reason ?? 'none'}); the question goes on at the standard level`)
  return read ? { ...read, message } : { level: AI_ROUTER_FALLBACK, reason: null, message }
}
