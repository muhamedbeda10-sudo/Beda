import { describe, expect, it } from 'vitest'
import { AI_PRICES, AI_UNKNOWN_MODEL_PRICE, aiCostUsd, describeAiDays, describeAiPeriod, isAiDay, resolveAiPeriod } from './ai'

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


describe('§20 — a saved report\'s period, from the day it runs', () => {
  const today = '2026-10-09' // a Friday
  it('counts back whole factory days', () => {
    expect(resolveAiPeriod({ kind: 'today' }, today)).toEqual({ from: today, to: today })
    expect(resolveAiPeriod({ kind: 'yesterday' }, today)).toEqual({ from: '2026-10-08', to: '2026-10-08' })
    expect(resolveAiPeriod({ kind: 'last_days', days: 30 }, today)).toEqual({ from: '2026-09-10', to: today })
    expect(resolveAiPeriod({ kind: 'last_days', days: 7 }, '2026-03-02')).toEqual({ from: '2026-02-24', to: '2026-03-02' })
  })
  it('starts the week on the day the factory does', () => {
    expect(resolveAiPeriod({ kind: 'this_week', weekStart: 'saturday' }, today)).toEqual({ from: '2026-10-03', to: today })
    expect(resolveAiPeriod({ kind: 'this_week', weekStart: 'sunday' }, today)).toEqual({ from: '2026-10-04', to: today })
    expect(resolveAiPeriod({ kind: 'this_week', weekStart: 'monday' }, today)).toEqual({ from: '2026-10-05', to: today })
    expect(resolveAiPeriod({ kind: 'last_week', weekStart: 'saturday' }, today)).toEqual({ from: '2026-09-26', to: '2026-10-02' })
    // On the week's first day, this week is that day alone.
    expect(resolveAiPeriod({ kind: 'this_week', weekStart: 'saturday' }, '2026-10-03')).toEqual({ from: '2026-10-03', to: '2026-10-03' })
  })
  it('takes months and years whole, leap years and January included', () => {
    expect(resolveAiPeriod({ kind: 'this_month' }, today)).toEqual({ from: '2026-10-01', to: today })
    expect(resolveAiPeriod({ kind: 'last_month' }, today)).toEqual({ from: '2026-09-01', to: '2026-09-30' })
    expect(resolveAiPeriod({ kind: 'last_month' }, '2028-03-15')).toEqual({ from: '2028-02-01', to: '2028-02-29' })
    expect(resolveAiPeriod({ kind: 'last_month' }, '2027-01-05')).toEqual({ from: '2026-12-01', to: '2026-12-31' })
    expect(resolveAiPeriod({ kind: 'this_year' }, today)).toEqual({ from: '2026-01-01', to: today })
    expect(resolveAiPeriod({ kind: 'last_year' }, today)).toEqual({ from: '2025-01-01', to: '2025-12-31' })
    expect(resolveAiPeriod({ kind: 'fixed', from: '2026-09-01', to: '2026-09-30' }, today)).toEqual({ from: '2026-09-01', to: '2026-09-30' })
  })
  it('says the period in words', () => {
    expect(describeAiPeriod({ kind: 'last_days', days: 30 })).toBe('Last 30 days')
    expect(describeAiPeriod({ kind: 'this_month' })).toBe('This month')
    expect(describeAiPeriod({ kind: 'fixed', from: '2026-09-01', to: '2026-09-30' })).toBe('1 Sep – 30 Sep 2026')
    expect(describeAiDays({ from: '2025-12-20', to: '2026-01-10' })).toBe('20 Dec 2025 – 10 Jan 2026')
    expect(describeAiDays({ from: '2026-10-09', to: '2026-10-09' })).toBe('9 Oct 2026')
  })
  it('knows a real day from a malformed one', () => {
    expect(isAiDay('2026-02-28')).toBe(true)
    expect(isAiDay('2026-02-30')).toBe(false)
    expect(isAiDay("2026-01-01' OR 1=1")).toBe(false)
    expect(() => resolveAiPeriod({ kind: 'today' }, 'yesterday')).toThrow()
  })
})
