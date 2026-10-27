import { describe, expect, it } from 'vitest'
import {
  AI_DEFAULT_SETTINGS,
  AI_DEEP_MODEL,
  AI_EFFORT,
  AI_JOB_IDS,
  AI_DEFAULT_DEPTH,
  AI_DEPTH_IDS,
  asksRouter,
  isAiDepth,
  levelForDepth,
  AI_JOBS,
  AI_LEVEL_NAMES,
  AI_STANDARD_MODEL,
  AI_DOMAIN_IDS,
  AI_MODEL_IDS,
  AI_MODELS,
  AI_PRICES,
  AI_ROUTER_FALLBACK,
  AI_UNKNOWN_MODEL_PRICE,
  aiCostUsd,
  isAiDomain,
  isAiEffort,
  isAiModel,
  describeAiDays,
  describeAiPeriod,
  isAiDay,
  isTopLevel,
  stickyLevel,
  resolveAiPeriod,
  readableModelInput,
  readableModelText,
} from './ai'

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

describe('§20 — what the owner can give a person', () => {
  it('prices Haiku 5.5 at its short-prompt rates, and at its long-prompt rates above 100K prompt tokens', () => {
    expect(aiCostUsd('claude-haiku-5-5', { ...none, inputTokens: 1_000_000 - 1, outputTokens: 0 })).toBeCloseTo(0.5, 6)
    expect(aiCostUsd('claude-haiku-5-5', { ...none, inputTokens: 50_000, outputTokens: 1_000 })).toBeCloseTo(0.0055, 6)
    expect(aiCostUsd('claude-haiku-5-5', { ...none, inputTokens: 20_000, cacheReadTokens: 90_000, outputTokens: 1_000 })).toBeCloseTo((20_000 * 0.5 + 90_000 * 0.05 + 1_000 * 2.5) / 1e6, 6)
  })
  it('offers every model it can price, and only known models, efforts and domains', () => {
    for (const id of AI_MODEL_IDS) expect(AI_PRICES[id]).toBeDefined()
    expect(isAiModel('claude-sonnet-5-5')).toBe(true)
    expect(isAiModel('gpt-5')).toBe(false)
    expect(isAiEffort('xhigh')).toBe(true)
    expect(isAiEffort('extreme')).toBe(false)
    // The order is fixed: a set of domains is stored as bits in it, so a new domain goes last.
    expect([...AI_DOMAIN_IDS]).toEqual(['inspection', 'orders', 'materials', 'audit', 'production', 'planning'])
    expect(isAiDomain('chat')).toBe(false)
  })
})

describe('§20 the model and effort of each job, fixed', () => {
  it('runs every job on Sonnet at high, and deep questions and a doubtful certificate’s second reading on Opus at high', () => {
    expect(AI_STANDARD_MODEL).toBe('claude-sonnet-5-5')
    expect(AI_DEEP_MODEL).toBe('claude-opus-5-5')
    expect(AI_EFFORT).toBe('high')
    expect(Object.keys(AI_JOBS).sort()).toEqual([...AI_JOB_IDS].sort())
    for (const job of AI_JOB_IDS) {
      expect(isAiModel(AI_JOBS[job].model), job).toBe(true)
      if (job === 'chat-quick') continue
      expect(AI_JOBS[job].effort, job).toBe('high')
      expect(AI_JOBS[job].model, job).toBe(job === 'chat-deep' || job === 'mtc-reread' ? AI_DEEP_MODEL : AI_STANDARD_MODEL)
    }
    // Haiku answers only what the person asks Quick, at low effort: never the router, a title or a certificate.
    expect(AI_JOBS['chat-quick']).toEqual({ model: 'claude-haiku-5-5', effort: 'low' })
    expect(AI_JOB_IDS.filter((j) => AI_JOBS[j].model === 'claude-haiku-5-5')).toEqual(['chat-quick'])
    // A doubtful certificate is read again on a stronger model than the first reading.
    const order = AI_MODELS.map((m) => m.id)
    expect(order.indexOf(AI_JOBS['mtc-reread'].model)).toBeGreaterThan(order.indexOf(AI_JOBS.mtc.model))
    expect(AI_ROUTER_FALLBACK).toBe('chat-standard')
    expect(AI_DEFAULT_SETTINGS).toEqual({ enabled: true, monthlyCapUsd: 50 })
  })

  it('names every level a turn may carry, the past ones too', () => {
    expect(Object.keys(AI_LEVEL_NAMES).sort()).toEqual(['chat-analysis', 'chat-deep', 'chat-files', 'chat-quick', 'chat-simple', 'chat-standard'])
  })
})

describe('§20 the depth the person picks', () => {
  it('offers Quick, Standard and Deep, Standard first chosen', () => {
    expect([...AI_DEPTH_IDS]).toEqual(['quick', 'standard', 'deep'])
    expect(AI_DEFAULT_DEPTH).toBe('standard')
    expect(isAiDepth('deep')).toBe(true)
    expect(isAiDepth('max')).toBe(false)
    expect(isAiDepth(undefined)).toBe(false)
  })

  it('answers Quick and Deep as picked, whatever the conversation was, and asks the router for Standard alone', () => {
    for (const previous of [null, 'chat-quick', 'chat-standard', 'chat-deep'] as const) {
      expect(levelForDepth('quick', previous, null)).toBe('chat-quick')
      expect(levelForDepth('deep', previous, null)).toBe('chat-deep')
      expect(asksRouter('quick', previous)).toBe(false)
      expect(asksRouter('deep', previous)).toBe(false)
    }
    expect(asksRouter('standard', null)).toBe(true)
    expect(asksRouter('standard', 'chat-quick')).toBe(true)
    expect(asksRouter('standard', 'chat-deep')).toBe(false)
  })

  it('gives Standard the router’s level, a deep conversation staying deep', () => {
    expect(levelForDepth('standard', null, 'chat-standard')).toBe('chat-standard')
    expect(levelForDepth('standard', 'chat-quick', 'chat-standard')).toBe('chat-standard')
    expect(levelForDepth('standard', 'chat-standard', 'chat-deep')).toBe('chat-deep')
    // The router not asked: the conversation is deep already.
    expect(levelForDepth('standard', 'chat-deep', null)).toBe('chat-deep')
  })
})

describe('§20 a conversation’s level only goes up', () => {
  it('keeps a deep conversation deep, and otherwise gives the question the level it wants', () => {
    expect(stickyLevel(null, 'chat-standard')).toBe('chat-standard')
    expect(stickyLevel(null, 'chat-deep')).toBe('chat-deep')
    expect(stickyLevel('chat-deep', 'chat-standard')).toBe('chat-deep')
    expect(stickyLevel('chat-standard', 'chat-deep')).toBe('chat-deep')
    // A conversation begun at a past level goes on as any other below Opus.
    expect(stickyLevel('chat-simple', 'chat-standard')).toBe('chat-standard')
    expect(stickyLevel('chat-files', 'chat-deep')).toBe('chat-deep')
    expect(isTopLevel('chat-deep')).toBe(true)
    expect(isTopLevel('chat-standard')).toBe(false)
    expect(isTopLevel('chat-analysis')).toBe(false)
    expect(isTopLevel(null)).toBe(false)
  })
})

describe('text the model wrote with its letters as codes', () => {
  it('reads as it was meant: Arabic, and a character beyond the first plane', () => {
    expect(readableModelText('\\u0627\\u0644\\u0639\\u064a\\u0648\\u0628 by machine')).toBe('العيوب by machine')
    expect(readableModelText('Done \\uD83D\\uDC4D')).toBe('Done 👍')
    expect(readableModelText('\\u00e9t\\u00C9')).toBe('étÉ')
    // Nothing escaped: the same text.
    expect(readableModelText('العيوب حسب الماكينة')).toBe('العيوب حسب الماكينة')
  })

  it('leaves what would change an SQL string or a pattern: ASCII, control characters, half a pair, not a code', () => {
    expect(readableModelText("name ~ '\\u0027' OR x = '\\u005c'")).toBe("name ~ '\\u0027' OR x = '\\u005c'")
    expect(readableModelText('\\u0000')).toBe('\\u0000')
    expect(readableModelText('\\uD83D alone')).toBe('\\uD83D alone')
    expect(readableModelText('\\u06 and \\u06zz')).toBe('\\u06 and \\u06zz')
  })

  it('reads a tool’s whole input that way, its SQL and the columns its chart names alike, without changing it', () => {
    const input = {
      purpose: '\\u0627\\u0644\\u0639\\u064a\\u0648\\u0628',
      sql: 'SELECT machine AS "\\u0627\\u0644\\u0645\\u0627\\u0643\\u064a\\u0646\\u0629", count(*) AS n FROM ai.sample_defects GROUP BY 1',
      chart: { type: 'bar', x: '\\u0627\\u0644\\u0645\\u0627\\u0643\\u064a\\u0646\\u0629', y: ['n'], title: '\\u0639\\u064a\\u0648\\u0628', goal: 5 },
      long: false,
    }
    const before = structuredClone(input)
    expect(readableModelInput(input)).toEqual({
      purpose: 'العيوب',
      sql: 'SELECT machine AS "الماكينة", count(*) AS n FROM ai.sample_defects GROUP BY 1',
      chart: { type: 'bar', x: 'الماكينة', y: ['n'], title: 'عيوب', goal: 5 },
      long: false,
    })
    expect(input).toEqual(before)
    expect(readableModelInput(null)).toBeNull()
  })
})
