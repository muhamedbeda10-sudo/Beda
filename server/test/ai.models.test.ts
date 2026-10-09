import { describe, expect, it } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import { AI_FALLBACK_MODELS, AI_MODEL_IDS, AI_PRICES, type AiModelId } from '@qc/shared/ai'
import { usageOf } from '../src/ai/assistant'
import type { ModelMessage } from '../src/ai/model'
import { MAX_TOKENS, minCallWorstCaseUsd, modelRequest, worstCaseUsd } from '../src/ai/models'

// §20 — each model the owner may give a person gets the request it takes,
// and the cap is guarded at that model's own rates.

describe('§20 the request each model takes', () => {
  it('thinks adaptively with summaries and the conversation check on every model, at the effort set', () => {
    for (const model of AI_MODEL_IDS) {
      for (const effort of ['low', 'max'] as const) {
        expect(modelRequest(model, effort, 'drop_block'), model).toMatchObject({
          model,
          output_config: { effort },
          thinking: { type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } },
        })
      }
    }
  })

  it('asks for the server-side fallback on Sonnet, Opus and Fable, never on Haiku', () => {
    for (const model of ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1'] as const) {
      const req = modelRequest(model, 'medium', 'error')
      expect(req.fallbacks, model).toBe('default')
      expect(req.betas, model).toEqual(['server-side-fallback-2026-07-01', 'thinking-binding-controls-2026-08-01'])
    }
    const haiku = modelRequest('claude-haiku-5-5', 'medium', 'error')
    expect(haiku).not.toHaveProperty('fallbacks')
    expect(haiku.betas).toEqual(['thinking-binding-controls-2026-08-01'])
  })
})

describe('§20 the most a call could cost, by model', () => {
  const call = (model: string, chars: number) =>
    worstCaseUsd({ model, system: [{ type: 'text', text: 'x'.repeat(chars) }], tools: [], messages: [], max_tokens: MAX_TOKENS })

  it('prices every input token as a cache write and every output token, at the model’s own rates', () => {
    const empty = JSON.stringify([[{ type: 'text', text: '' }], [], []]).length
    const tokens = Math.ceil((empty + 3000) / 3)
    for (const model of AI_MODEL_IDS) {
      const p = AI_PRICES[model]
      expect(call(model, 3000), model).toBeCloseTo((tokens * Math.max(p.input, p.cacheWrite5m) + MAX_TOKENS * p.output) / 1e6, 9)
    }
    expect(minCallWorstCaseUsd('claude-haiku-5-5')).toBeCloseTo((MAX_TOKENS * 0.5) / 1e6, 9)
  })

  it('counts the fallback’s whole attempt on top of the refused one, at the dearest model it could pick', () => {
    const empty = JSON.stringify([[{ type: 'text', text: '' }], [], []]).length
    const tokens = Math.ceil((empty + 3000) / 3)
    const attempt = (model: string) => (tokens * Math.max(AI_PRICES[model].input, AI_PRICES[model].cacheWrite5m) + MAX_TOKENS * AI_PRICES[model].output) / 1e6
    const asked = (model: AiModelId) =>
      worstCaseUsd({ ...modelRequest(model, 'medium', 'error'), system: [{ type: 'text', text: 'x'.repeat(3000) }], tools: [], messages: [], max_tokens: MAX_TOKENS })
    expect(asked('claude-haiku-5-5')).toBeCloseTo(attempt('claude-haiku-5-5'), 9)
    expect(asked('claude-sonnet-5-5')).toBeCloseTo(attempt('claude-sonnet-5-5') + attempt('claude-sonnet-5'), 9)
    expect(asked('claude-opus-5-5')).toBeCloseTo(attempt('claude-opus-5-5') + attempt('claude-opus-5'), 9)
    expect(asked('claude-fable-5-1')).toBeCloseTo(attempt('claude-fable-5-1') + attempt('claude-opus-5'), 9)
    // Every model a fallback may land on has its own rates.
    for (const model of AI_MODEL_IDS) for (const to of AI_FALLBACK_MODELS[model]) expect(AI_PRICES[to], `${model} → ${to}`).toBeDefined()

    // The least worst case, with no prompt yet: what /me and the settings page judge a cap by.
    expect(minCallWorstCaseUsd('claude-haiku-5-5')).toBeCloseTo((MAX_TOKENS * 0.5) / 1e6, 9)
    expect(minCallWorstCaseUsd('claude-sonnet-5-5')).toBeCloseTo((MAX_TOKENS * (10 + 10)) / 1e6, 9)
    expect(minCallWorstCaseUsd('claude-opus-5-5')).toBeCloseTo((MAX_TOKENS * (20 + 25)) / 1e6, 9)
    expect(minCallWorstCaseUsd('claude-fable-5-1')).toBeCloseTo((MAX_TOKENS * (50 + 25)) / 1e6, 9)

    // A list is walked down: every attempt on it may be made. A fallback nobody named is priced at the dearest rates.
    const listed = worstCaseUsd({
      model: 'claude-opus-5-5',
      fallbacks: [{ model: 'claude-opus-5' }, { model: 'claude-opus-4-8', max_tokens: 1000 }],
      system: [{ type: 'text', text: 'x'.repeat(3000) }],
      tools: [],
      messages: [],
      max_tokens: MAX_TOKENS,
    })
    expect(listed).toBeCloseTo(attempt('claude-opus-5-5') + attempt('claude-opus-5') + (tokens * 6.25 + 1000 * 25) / 1e6, 9)
    expect(minCallWorstCaseUsd('claude-unknown-9')).toBeCloseTo((MAX_TOKENS * 50) / 1e6, 9)
  })

  it('stays above what a call that falls back is billed: the refused attempt and the fallback’s, each at its rates', () => {
    // An Opus 5.5 call refused once it had written its all, then answered in full by Opus 5.
    const params = { ...modelRequest('claude-opus-5-5', 'max', 'error'), system: [{ type: 'text' as const, text: 'x'.repeat(12_000) }], tools: [], messages: [], max_tokens: MAX_TOKENS }
    const inputTokens = 4000
    const attempt = { input_tokens: inputTokens, output_tokens: MAX_TOKENS, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null }
    const iterations: Anthropic.Beta.BetaIterationsUsage = [
      { type: 'message', model: 'claude-opus-5-5', ...attempt },
      { type: 'fallback_message', model: 'claude-opus-5', ...attempt },
    ]
    const message = { model: 'claude-opus-5', usage: { ...attempt, iterations } } as unknown as ModelMessage
    const billed = usageOf(message, 'claude-opus-5-5').costUsd
    expect(billed).toBeCloseTo((inputTokens * (4 + 5) + MAX_TOKENS * (20 + 25)) / 1e6, 6)
    expect(worstCaseUsd(params)).toBeGreaterThanOrEqual(billed)
    // One attempt's worth, as before, would not have covered it.
    expect(worstCaseUsd({ ...params, fallbacks: undefined })).toBeLessThan(billed)
  })

  it('moves a long Haiku prompt onto its dearer rate card', () => {
    const long = AI_PRICES['claude-haiku-5-5'].long!
    const short = call('claude-haiku-5-5', 3 * 99_000)
    const over = call('claude-haiku-5-5', 3 * 101_000)
    expect(short).toBeLessThan((99_100 * 0.125 + MAX_TOKENS * 0.5) / 1e6)
    expect(over).toBeGreaterThan((101_000 * long.cacheWrite5m + MAX_TOKENS * long.output) / 1e6)
  })

  it('prices a model it does not know at the dearest rates', () => {
    expect(call('claude-unknown-9', 3000)).toBeCloseTo(call('claude-fable-5-1', 3000), 9)
  })
})
