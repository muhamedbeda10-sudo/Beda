import { describe, expect, it } from 'vitest'
import {
  AI_ACTION_IDS,
  AI_ACTIONS,
  AI_CHAT_TIERS,
  AI_DEFAULT_SETTINGS,
  AI_DOMAIN_IDS,
  AI_MODEL_IDS,
  AI_MODELS,
  AI_MTC_REREAD_MODEL,
  AI_PRICES,
  AI_ROUTER_FALLBACK,
  AI_ROUTER_MODEL,
  AI_UNKNOWN_MODEL_PRICE,
  aiChatModels,
  aiCheapestChatModel,
  aiCostUsd,
  isAiAction,
  isAiChatMode,
  isAiDomain,
  isAiEffort,
  isAiModel,
  describeAiDays,
  describeAiPeriod,
  isAiDay,
  isTopLevel,
  resolveAiAction,
  stickyLevel,
  resolveAiPeriod,
  type AiAction,
  type AiActionSetting,
  type AiSettings,
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
    expect([...AI_DOMAIN_IDS]).toEqual(['inspection', 'orders', 'materials', 'audit', 'production'])
    expect(isAiDomain('chat')).toBe(false)
  })
})

describe('§20 Models: the model and effort of each thing the assistant does', () => {
  const settings = (over: Partial<Record<AiAction, AiActionSetting>> = {}, chatMode: AiSettings['chatMode'] = 'auto') => ({
    chatMode,
    actions: { ...AI_DEFAULT_SETTINGS.actions, ...over },
  })

  it('names every action once, each with a recommended model and effort', () => {
    expect(AI_ACTIONS.map((a) => a.id)).toEqual([...AI_ACTION_IDS])
    for (const a of AI_ACTIONS) {
      expect(isAiModel(a.recommended.model), a.id).toBe(true)
      expect(isAiEffort(a.recommended.effort), a.id).toBe(true)
    }
    expect(AI_CHAT_TIERS.every((t) => isAiAction(t) && isAiChatMode(t))).toBe(true)
    expect(isAiChatMode('auto')).toBe(true)
    expect(isAiChatMode('chat-files')).toBe(false)
    expect(isAiAction('translate')).toBe(false)
    expect(AI_ACTIONS.map((a) => a.id)).toContain(AI_ROUTER_FALLBACK)
  })

  it('runs Auto on the recommended model and effort, and a choice as chosen, field by field', () => {
    expect(resolveAiAction(AI_DEFAULT_SETTINGS, 'chat-simple')).toEqual({ model: 'claude-haiku-5-5', effort: 'low' })
    expect(resolveAiAction(AI_DEFAULT_SETTINGS, 'chat-deep')).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
    expect(resolveAiAction(AI_DEFAULT_SETTINGS, 'mtc')).toEqual({ model: 'claude-sonnet-5-5', effort: 'high' })
    expect(resolveAiAction(settings({ mtc: { model: 'claude-opus-5-5', effort: 'auto' } }), 'mtc')).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
    expect(resolveAiAction(settings({ mtc: { model: 'auto', effort: 'low' } }), 'mtc')).toEqual({ model: 'claude-sonnet-5-5', effort: 'low' })
    // Settings saved before an action existed: that action runs as recommended.
    const older = { actions: { ...AI_DEFAULT_SETTINGS.actions } } as { actions: Partial<AiSettings['actions']> }
    delete older.actions['report-summary']
    expect(resolveAiAction(older as Pick<AiSettings, 'actions'>, 'report-summary')).toEqual({ model: 'claude-haiku-5-5', effort: 'low' })
  })

  it('knows the models a chat question may run on, and the cheapest of them, by the chat mode', () => {
    expect(aiChatModels(AI_DEFAULT_SETTINGS).sort()).toEqual(['claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5'])
    expect(aiCheapestChatModel(AI_DEFAULT_SETTINGS)).toBe('claude-haiku-5-5')
    // A level fixed for every question: that level's model, and the files' (a question with files has its own).
    expect(aiChatModels(settings({}, 'chat-deep')).sort()).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5'])
    expect(aiCheapestChatModel(settings({}, 'chat-deep'))).toBe('claude-sonnet-5-5')
    expect(aiCheapestChatModel(settings({ 'chat-deep': { model: 'claude-fable-5-1', effort: 'auto' }, 'chat-files': { model: 'claude-fable-5-1', effort: 'auto' } }, 'chat-deep'))).toBe(
      'claude-fable-5-1',
    )
    // The other actions never count: they are not a person's questions.
    expect(aiChatModels(settings({ mtc: { model: 'claude-fable-5-1', effort: 'auto' } }))).not.toContain('claude-fable-5-1')
  })

  it('reads an unclear certificate again on a stronger model than the recommended one', () => {
    const order = AI_MODELS.map((m) => m.id)
    expect(order.indexOf(AI_MTC_REREAD_MODEL)).toBeGreaterThan(order.indexOf(resolveAiAction(AI_DEFAULT_SETTINGS, 'mtc').model))
    expect(AI_ROUTER_MODEL).toBe('claude-haiku-5-5')
    expect(AI_DEFAULT_SETTINGS).toMatchObject({ chatMode: 'auto', mtcReread: true })
  })
})

describe('§20 a conversation’s level only goes up', () => {
  it('keeps the level when a question asks less, and raises it when one asks more', () => {
    expect(stickyLevel(null, 'chat-simple')).toBe('chat-simple')
    expect(stickyLevel('chat-deep', 'chat-simple')).toBe('chat-deep')
    expect(stickyLevel('chat-analysis', 'chat-deep')).toBe('chat-deep')
    expect(stickyLevel('chat-simple', 'chat-analysis')).toBe('chat-analysis')
    // A question with files is an analysis's equal: neither moves the other.
    expect(stickyLevel('chat-analysis', 'chat-files')).toBe('chat-analysis')
    expect(stickyLevel('chat-files', 'chat-analysis')).toBe('chat-files')
    expect(stickyLevel('chat-simple', 'chat-files')).toBe('chat-files')
    expect(isTopLevel('chat-deep')).toBe(true)
    expect(isTopLevel('chat-analysis')).toBe(false)
    expect(isTopLevel(null)).toBe(false)
  })
})
