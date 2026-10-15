// ============================================================================
// §20 — a chat question's level, chosen before it is answered (chatMode
// "auto"): simple, analysis or deep, each answered on the model and effort the
// owner set for it (Models). One short call to the cheapest model reads the
// question — and, for a follow-up, the question before it and its level — and
// answers in a fixed shape: the level, and why in a few words. The owner sees
// both in Activity, to tell whether the router chooses well.
//
//   • It never stands in the answer's way: its own short deadline, and any
//     failure (no answer in time, an unreadable reply) gives the middle level,
//     the safe one, with no reason.
//   • Its cost is the question's: recorded on the question's turn by the
//     caller, with the answer's own calls.
// ============================================================================

import type Anthropic from '@anthropic-ai/sdk'
import { AI_ROUTER_FALLBACK, AI_ROUTER_MODEL, type AiChatLevel, type AiChatTier } from '@qc/shared/ai'
import type { AiModelClient, CompleteParams, ModelMessage } from './model'

/** How long the router may take before the question goes on at the middle level. */
export const ROUTER_TIMEOUT_MS = 8_000
/** A level and a sentence: room enough, and a cap on the call's cost. */
const ROUTER_MAX_TOKENS = 200
/** How much of a question the router reads: its start says what it asks. */
const QUESTION_CHARS = 2_000
const STRUCTURED_OUTPUTS_BETA: Anthropic.Beta.AnthropicBeta = 'structured-outputs-2025-11-13'

const LEVELS: Record<'simple' | 'analysis' | 'deep', AiChatTier> = { simple: 'chat-simple', analysis: 'chat-analysis', deep: 'chat-deep' }

export const ROUTER_SYSTEM = [
  'You sort questions put to the data assistant of a steel fabrication factory (quality control: inspections, defects, measurements, coils, orders, production) by how much work answering them takes, so each is answered on a model that fits it.',
  'Reply with the level and, in at most 12 words, why. Write the reason in English.',
  '- simple: one lookup or count, a short list, a single figure, a definition, a greeting or thanks. "How many samples today?", "Which orders are on machine 22?", "What does PT mean?"',
  '- analysis: comparing, ranking, trends over time, rates, SPC or capability, a chart, an Excel file, a diagram, a summary of a period, several queries joined up. "Defect rate by machine this month", "Trend of rejects for item X", "Excel of last week\'s holds".',
  '- deep: finding causes, an investigation across many steps or sources, FMEA, a plan or recommendation weighed against the record, anything the asker says is hard or important. "Why did scrap on line 3 double since May?", "Root cause of the welding defects this quarter".',
  'A follow-up takes the level of what it asks now: "and for last month?" after an analysis is still an analysis; "thanks" is simple.',
  'When unsure between two levels, choose the higher one.',
].join('\n')

export const ROUTER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['level', 'reason'],
  properties: {
    level: { type: 'string', enum: ['simple', 'analysis', 'deep'] },
    reason: { type: 'string' },
  },
} as const

export interface RouterInput {
  model: AiModelClient
  apiKey: string
  question: string
  /** The conversation's last question and its level, for a follow-up. */
  previous?: { question: string; level: AiChatLevel | null } | null
  /** The asker leaving stops the call with the rest. */
  signal?: AbortSignal
}

export interface RouterResult {
  level: AiChatTier
  /** Why, in a few words; null when the router could not be asked. */
  reason: string | null
  /** The call's reply, for its usage (null when no call came back). */
  message: ModelMessage | null
}

/** What the router reads: the question, and the one before it for a follow-up. */
export function routerRequest(input: Pick<RouterInput, 'question' | 'previous'>): CompleteParams {
  const clip = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, QUESTION_CHARS)
  const before = input.previous
    ? `The question before it in this conversation${input.previous.level ? ` (answered as ${input.previous.level.replace('chat-', '')})` : ''}:\n${clip(input.previous.question)}\n\n`
    : ''
  return {
    model: AI_ROUTER_MODEL,
    max_tokens: ROUTER_MAX_TOKENS,
    betas: [STRUCTURED_OUTPUTS_BETA],
    system: ROUTER_SYSTEM,
    output_config: { format: { type: 'json_schema', schema: ROUTER_SCHEMA as unknown as Record<string, unknown> } },
    messages: [{ role: 'user', content: `${before}The question to sort:\n${clip(input.question) || '(no words)'}` }],
  }
}

/** The level a reply names, or null when it names none. */
export function readRouterReply(message: ModelMessage): { level: AiChatTier; reason: string | null } | null {
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

/** The question's level: the router's, or the middle one when it cannot be had in time. */
export async function chooseLevel(input: RouterInput): Promise<RouterResult> {
  const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(ROUTER_TIMEOUT_MS)]) : AbortSignal.timeout(ROUTER_TIMEOUT_MS)
  let message: ModelMessage
  try {
    message = await input.model.complete(input.apiKey, routerRequest(input), { signal })
  } catch (e) {
    // The message only: an error's request details are never logged.
    console.warn('[ai] no level from the router; the question goes on as an analysis:', e instanceof Error ? e.message : String(e))
    return { level: AI_ROUTER_FALLBACK, reason: null, message: null }
  }
  const read = readRouterReply(message)
  return read ? { ...read, message } : { level: AI_ROUTER_FALLBACK, reason: null, message }
}
