// ============================================================================
// §20 — how a request is shaped for each model the owner may give a person,
// and the most a call could cost on it. Each model takes the request a little
// differently (Anthropic's model guides, checked against SDK 0.132.1):
//
//   • every one thinks adaptively. Its summarized thinking is shown as the
//     "thinking…" line, and a history edited between requests is caught by
//     the conversation check (block_binding, beta
//     thinking-binding-controls-2026-08-01), which all four accept with
//     adaptive thinking.
//   • every one takes the effort the owner set, low to max.
//   • Sonnet 5.5, Opus 5.5 and Fable 5.1 are rescued from a safety refusal by
//     another model, server-side (fallbacks "default", beta
//     server-side-fallback-2026-07-01): Sonnet 5 for Sonnet 5.5, Opus 5 or
//     Opus 4.8 for the others. Haiku 5.5 has no server-side fallback: with
//     "default" a refusal stays a refusal, so neither the parameter nor its
//     beta is sent.
//   • a call that falls back is billed twice over: what the refused attempt
//     read and wrote, then the fallback's own attempt at its rates. The most
//     a call could cost counts both.
// ============================================================================

import type Anthropic from '@anthropic-ai/sdk'
import {
  AI_FALLBACK_MODELS,
  AI_MODEL,
  AI_PRICES,
  AI_UNKNOWN_MODEL_PRICE,
  aiMinCallUsd,
  isAiModel,
  type AiEffort,
  type AiModelId,
  type AiPrice,
} from '@qc/shared/ai'
import { attachmentTokens, type StoredMessage } from './attachments'
import type { ModelParams } from './model'

/** Room for thinking and the reply; once more at the larger size when a tool call was cut off. */
export const MAX_TOKENS = 32_000
export const MAX_TOKENS_RETRY = 64_000

const FALLBACK_BETA: Anthropic.Beta.AnthropicBeta = 'server-side-fallback-2026-07-01'
const BINDING_BETA: Anthropic.Beta.AnthropicBeta = 'thinking-binding-controls-2026-08-01'


/**
 * The model-specific part of a question's request. `prefixMismatch`: what
 * the API does with thinking replayed after an edited history — "error" in
 * the tests, where it must fail loudly; "drop_block" in production, where it
 * costs the thinking and not the answer.
 */
export function modelRequest(
  model: AiModelId,
  effort: AiEffort,
  prefixMismatch: 'error' | 'drop_block',
): Pick<ModelParams, 'model' | 'betas' | 'fallbacks' | 'thinking' | 'output_config'> {
  const thinking: Anthropic.Beta.BetaThinkingConfigAdaptive = {
    type: 'adaptive',
    display: 'summarized',
    block_binding: { prefix_mismatch_behavior: prefixMismatch },
  }
  if (AI_FALLBACK_MODELS[model].length === 0) return { model, betas: [BINDING_BETA], thinking, output_config: { effort } }
  return { model, betas: [FALLBACK_BETA, BINDING_BETA], fallbacks: 'default', thinking, output_config: { effort } }
}

/** A model's rates; one not in the table at the dearest known, so the cap errs on the safe side. */
export const modelPrice = (model: string): AiPrice => AI_PRICES[model] ?? AI_UNKNOWN_MODEL_PRICE

/** The rate card a prompt of this many tokens is billed on: a long prompt moves some models onto dearer rates. */
function rateCard(price: AiPrice, promptTokens: number): Omit<AiPrice, 'long'> {
  return price.long && promptTokens > price.long.aboveInputTokens ? price.long : price
}

/** The most one attempt could cost on a model: every input token written to the cache, every output token used. */
function attemptUsd(model: string, inputTokens: number, outputTokens: number): number {
  const price = rateCard(modelPrice(model), inputTokens)
  return (inputTokens * Math.max(price.input, price.cacheWrite5m) + outputTokens * price.output) / 1_000_000
}

type CostedParams = Pick<ModelParams, 'model' | 'system' | 'tools' | 'max_tokens' | 'fallbacks'> & { messages: ModelParams['messages'] | StoredMessage[] }

/**
 * The most a call could cost: its attempt, and when it may fall back, every
 * attempt after it too — a refusal mid-reply is billed for what it wrote, so
 * each may use its whole output. "default" hands it on once, to the dearest
 * model it could pick; a list, down the list. The request as stored: its
 * files by reference, each at its counted tokens.
 */
export function worstCaseUsd(params: CostedParams): number {
  // About three characters a token, rounded the dear way; the files at what they were counted, with a margin.
  const textTokens = Math.ceil(JSON.stringify([params.system, params.tools, params.messages]).length / 3)
  return callWorstCaseUsd(params, textTokens + attachmentTokens(params.messages))
}

function callWorstCaseUsd(params: Pick<CostedParams, 'model' | 'max_tokens' | 'fallbacks'>, inputTokens: number): number {
  const first = attemptUsd(params.model, inputTokens, params.max_tokens)
  const fallbacks = params.fallbacks
  if (!fallbacks) return first
  if (fallbacks === 'default') {
    // Where a model this file does not know falls back is not known either: at the dearest known rates.
    const targets = isAiModel(params.model) ? AI_FALLBACK_MODELS[params.model] : []
    const attempts = targets.map((m) => attemptUsd(m, inputTokens, params.max_tokens))
    return first + (attempts.length > 0 ? Math.max(...attempts) : unknownAttemptUsd(inputTokens, params.max_tokens))
  }
  return fallbacks.reduce((sum, f) => sum + attemptUsd(f.model, inputTokens, f.max_tokens ?? params.max_tokens), first)
}

const unknownAttemptUsd = (inputTokens: number, outputTokens: number) =>
  (inputTokens * Math.max(AI_UNKNOWN_MODEL_PRICE.input, AI_UNKNOWN_MODEL_PRICE.cacheWrite5m) + outputTokens * AI_UNKNOWN_MODEL_PRICE.output) / 1_000_000

/** A conversation's stored system prompt, marked for the cache. */
export const systemBlocks = (systemPrompt: string): Anthropic.Beta.BetaTextBlockParam[] => [
  { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
]

/**
 * The most the first call of an answer could cost on a model: the loop's own
 * test before that call, so a question refused here is one the loop would
 * have stopped without calling the model. Without a conversation (a status
 * has none), the least any call's worst case may be: its whole output, and
 * the fallback's where the model has one.
 */
export function minCallWorstCaseUsd(
  model: string = AI_MODEL,
  start?: { conversation: { systemPrompt: string; tools: Anthropic.Beta.BetaToolUnion[] }; messages: StoredMessage[] },
): number {
  // Shaped as the loop shapes it (the effort and the conversation check change no price).
  const shape = isAiModel(model) ? modelRequest(model, 'medium', 'drop_block') : { model }
  // No conversation: the shared figure the owner's page holds caps to, so both sides draw the line at one cent.
  if (!start) return aiMinCallUsd(model)
  return worstCaseUsd({
    ...shape,
    system: systemBlocks(start.conversation.systemPrompt),
    tools: start.conversation.tools,
    messages: start.messages,
    max_tokens: MAX_TOKENS,
  })
}
