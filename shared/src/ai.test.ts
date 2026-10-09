import { describe, expect, it } from 'vitest'
import { AI_PRICES, AI_UNKNOWN_MODEL_PRICE, aiCostUsd } from './ai'

const none = { inputTokens: 0, outputTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0 }

describe('§20 — what an AI call costs', () => {
  it('prices each kind of token at the model\'s rate', () => {
    expect(aiCostUsd('claude-sonnet-5-5', { ...none, inputTokens: 1_000_000 })).toBe(2)
    expect(aiCostUsd('claude-sonnet-5-5', { ...none, outputTokens: 1_000_000 })).toBe(10)
    expect(aiCostUsd('claude-sonnet-5-5', { ...none, cacheReadTokens: 1_000_000 })).toBe(0.2)
    expect(aiCostUsd('claude-sonnet-5-5', { ...none, cacheWrite5mTokens: 1_000_000 })).toBe(2.5)
    expect(aiCostUsd('claude-sonnet-5-5', { inputTokens: 3_000, outputTokens: 500, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 20_000 })).toBeCloseTo(0.015, 6)
  })
  it('counts a model it does not know at the dearest rates', () => {
    expect(aiCostUsd('claude-unknown', { ...none, outputTokens: 1_000_000 })).toBe(AI_UNKNOWN_MODEL_PRICE.output)
    expect(Math.max(...Object.values(AI_PRICES).map((p) => p.output))).toBe(AI_UNKNOWN_MODEL_PRICE.output)
  })
})
