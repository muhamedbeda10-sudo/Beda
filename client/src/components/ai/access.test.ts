import { describe, expect, it } from 'vitest'
import { AI_MODELS, aiMinCallUsd, type AiAccess, type AiMeResponse } from '@qc/shared/ai'
import {
  AI_BLOCK_TEXT,
  CAP_RANGE_TEXT,
  accessChanged,
  accessLive,
  accessRequest,
  aiBlock,
  capFitsModel,
  capTooLowText,
  checkAccessDraft,
  describeModelPrice,
  draftFromAccess,
  effortName,
  formatRate,
  groupByRole,
  isAdministrator,
  minCapUsd,
  modelName,
  newAccessDraft,
  noticesAccessView,
  noticesSwitchHint,
  orderDomains,
  parseCapUsd,
  roleLabel,
  sortAccess,
  toggleDomain,
} from './access'
import { STOP_TEXT } from './format'

const me = (over: Partial<AiMeResponse>): AiMeResponse => ({ granted: true, owner: false, available: true, automations: false, ...over })

const row = (over: Partial<AiAccess>): AiAccess => ({
  userId: 'u1',
  name: 'Mona Adel',
  username: 'mona',
  role: 'inspector',
  active: true,
  enabled: true,
  domains: ['inspection'],
  model: 'claude-sonnet-5-5',
  effort: 'medium',
  monthlyCapUsd: 10,
  spentUsd: 1.25,
  owner: false,
  automations: false,
  notices: false,
  ...over,
})

describe('why the question box is closed', () => {
  it('says nothing while the assistant can answer, before /ai/me answers, or to someone it is not given to', () => {
    expect(aiBlock(undefined)).toBeNull()
    expect(aiBlock(me({}))).toBeNull()
    expect(aiBlock(me({ granted: false, available: false, reason: 'not-granted' }))).toBeNull()
  })

  it('names the person’s own limit, the app’s, or plain unavailability', () => {
    expect(aiBlock(me({ available: false, reason: 'personal-cap' }))).toBe('personal-cap')
    expect(aiBlock(me({ available: false, reason: 'cap-reached' }))).toBe('cap-reached')
    expect(aiBlock(me({ available: false, reason: 'unavailable' }))).toBe('unavailable')
    // No reason, or one this app does not know, is "not available right now".
    expect(aiBlock(me({ available: false }))).toBe('unavailable')
    expect(aiBlock(me({ available: false, reason: 'no-key' as never }))).toBe('unavailable')
  })

  it('words it without an amount, a key or a settings page', () => {
    expect(AI_BLOCK_TEXT['personal-cap']).toBe("You have reached this month's limit for the assistant. It is available again on the 1st.")
    expect(AI_BLOCK_TEXT['cap-reached']).toBe("The assistant's monthly limit is reached. It is available again on the 1st.")
    expect(AI_BLOCK_TEXT.unavailable).toBe('The assistant is not available right now.')
    for (const text of [...Object.values(AI_BLOCK_TEXT), STOP_TEXT.cap]) expect(text).not.toMatch(/\$|\d+\.\d|budget|cost|spent|key|setting|administrat/i)
  })
})

describe('models and effort in words', () => {
  it('prices a model per million tokens, as Anthropic lists it', () => {
    expect(formatRate(2)).toBe('$2')
    expect(formatRate(0.1)).toBe('$0.10')
    expect(formatRate(12.5)).toBe('$12.50')
    expect(describeModelPrice('claude-sonnet-5-5')).toBe('$2 in · $10 out per million tokens')
    expect(describeModelPrice('claude-fable-5-1')).toBe('$10 in · $50 out per million tokens')
  })

  it('says when a long prompt costs more', () => {
    expect(describeModelPrice('claude-haiku-5-5')).toBe('$0.10 in · $0.50 out per million tokens; $0.50 in · $2.50 out for prompts over 100K tokens')
  })

  it('prices every model the owner can choose, and admits an unknown one', () => {
    for (const m of AI_MODELS) expect(describeModelPrice(m.id)).toMatch(/^\$[\d.]+ in · \$[\d.]+ out per million tokens/)
    expect(describeModelPrice('claude-unknown')).toMatch(/not known/)
  })

  it('names models and effort, and an unknown one by its id', () => {
    expect(modelName('claude-opus-5-5')).toBe('Claude Opus 5.5')
    expect(modelName('claude-x')).toBe('claude-x')
    expect(effortName('xhigh')).toBe('Extra high')
    expect(effortName('turbo')).toBe('turbo')
  })
})

describe('the least a cap may be on a model', () => {
  it('is one call’s whole output and its fallback’s, up to the cent', () => {
    expect(minCapUsd('claude-haiku-5-5')).toBe(0.02)
    expect(minCapUsd('claude-sonnet-5-5')).toBe(0.64)
    expect(minCapUsd('claude-opus-5-5')).toBe(1.44)
    expect(minCapUsd('claude-fable-5-1')).toBe(2.4)
    // An unknown model at the dearest rates, with no fallback, as the server counts it.
    expect(minCapUsd('claude-unknown')).toBe(1.6)
  })

  it('lets through exactly the caps the server lets ask, for every model', () => {
    for (const m of AI_MODELS) {
      // The server's test: a question waits while spent + the least call's worst case is over the cap.
      const serverFloor = aiMinCallUsd(m.id)
      const min = minCapUsd(m.id)
      expect(0 + serverFloor > min).toBe(false)
      expect(0 + serverFloor > Math.round((min - 0.01) * 100) / 100).toBe(true)
      expect(capFitsModel(min, m.id)).toBe(true)
      expect(capFitsModel(Math.round((min - 0.01) * 100) / 100, m.id)).toBe(false)
    }
  })

  it('says why, with the least amount and the model, for the owner', () => {
    expect(capTooLowText('claude-fable-5-1')).toBe(
      "On Claude Fable 5.1 the cap must be at least $2.40, the most one call to the model may cost. Below that they could never ask: they would be told the month's limit is reached, every month.",
    )
    expect(capTooLowText('claude-haiku-5-5')).toMatch(/Claude Haiku 5\.5 .* at least \$0\.02,/)
  })
})

describe('the data a person may ask about', () => {
  it('keeps the app’s order, each once, and only domains it knows', () => {
    expect(orderDomains(['audit', 'inspection', 'audit', 'secrets'])).toEqual(['inspection', 'audit'])
    expect(toggleDomain(['audit'], 'orders', true)).toEqual(['orders', 'audit'])
    expect(toggleDomain(['orders', 'audit'], 'orders', false)).toEqual(['audit'])
  })
})

describe('the owner’s draft of one person’s access', () => {
  it('reads a cap as dollars with at most two decimals, within the bounds', () => {
    expect(parseCapUsd('25')).toBe(25)
    expect(parseCapUsd(' 7.5 ')).toBe(7.5)
    expect(parseCapUsd('0')).toBe(0)
    expect(parseCapUsd('2000')).toBe(2000)
    for (const bad of ['', '-1', '1.234', '2000.01', 'abc', '1e3', '10$']) expect(parseCapUsd(bad)).toBeNull()
  })

  it('starts a newcomer narrow: on, the inspection record, Sonnet at medium effort, a small cap within the app’s, no automations', () => {
    expect(newAccessDraft(50)).toEqual({ enabled: true, domains: ['inspection'], model: 'claude-sonnet-5-5', effort: 'medium', cap: '10', automations: false, notices: false })
    expect(newAccessDraft(4).cap).toBe('4')
    // Never a cap they could not ask with, even under a tiny app-wide cap (the drawer names that one).
    expect(newAccessDraft(0.1).cap).toBe('0.64')
    expect(newAccessDraft(-1).cap).toBe('0.64')
    expect(checkAccessDraft(newAccessDraft(0))).toBeNull()
  })

  it('asks for at least one kind of data and a cap the server takes', () => {
    const d = draftFromAccess(row({}))
    expect(checkAccessDraft(d)).toBeNull()
    expect(checkAccessDraft({ ...d, domains: [] })).toMatch(/at least one/)
    expect(checkAccessDraft({ ...d, cap: '5000' })).toBe(CAP_RANGE_TEXT)
  })

  it('refuses a cap under what one call to the chosen model may cost, which would close the assistant to them every month', () => {
    const d = draftFromAccess(row({}))
    // The reported case: Fable 5.1 with a $1 cap.
    expect(checkAccessDraft({ ...d, model: 'claude-fable-5-1', cap: '1' })).toBe(capTooLowText('claude-fable-5-1'))
    expect(checkAccessDraft({ ...d, model: 'claude-fable-5-1', cap: '2.39' })).toBe(capTooLowText('claude-fable-5-1'))
    expect(checkAccessDraft({ ...d, model: 'claude-fable-5-1', cap: '2.40' })).toBeNull()
    expect(checkAccessDraft({ ...d, model: 'claude-opus-5-5', cap: '1.43' })).toBe(capTooLowText('claude-opus-5-5'))
    expect(checkAccessDraft({ ...d, model: 'claude-sonnet-5-5', cap: '0' })).toBe(capTooLowText('claude-sonnet-5-5'))
    expect(checkAccessDraft({ ...d, model: 'claude-haiku-5-5', cap: '0.01' })).toBe(capTooLowText('claude-haiku-5-5'))
    expect(checkAccessDraft({ ...d, model: 'claude-haiku-5-5', cap: '0.02' })).toBeNull()
    // Switching someone off is never held up by their cap.
    expect(checkAccessDraft({ ...d, enabled: false, model: 'claude-fable-5-1', cap: '1' })).toBeNull()
    expect(checkAccessDraft({ ...d, enabled: false, cap: '0' })).toBeNull()
  })

  it('sends the draft as the server takes it, domains in order', () => {
    expect(accessRequest({ enabled: false, domains: ['audit', 'inspection'], model: 'claude-haiku-5-5', effort: 'low', cap: '12.50', automations: true, notices: true })).toEqual({
      enabled: false,
      domains: ['inspection', 'audit'],
      model: 'claude-haiku-5-5',
      effort: 'low',
      monthlyCapUsd: 12.5,
      automations: true,
      notices: true,
    })
  })

  it('reads the automations permission back, the owner’s always on', () => {
    expect(draftFromAccess(row({ automations: true })).automations).toBe(true)
    expect(draftFromAccess(row({})).automations).toBe(false)
    expect(draftFromAccess(row({ owner: true, automations: false })).automations).toBe(true)
  })

  it('reads the notices permission back: as stored, the owner’s on while an administrator', () => {
    expect(draftFromAccess(row({ role: 'admin', notices: true })).notices).toBe(true)
    expect(draftFromAccess(row({ role: 'admin' })).notices).toBe(false)
    // Stored for someone who is not an administrator now: read back as it is, so it can be turned off.
    expect(draftFromAccess(row({ role: 'supervisor', notices: true })).notices).toBe(true)
    expect(draftFromAccess(row({ role: 'admin', owner: true })).notices).toBe(true)
    expect(draftFromAccess(row({ role: 'supervisor', owner: true })).notices).toBe(false)
  })

  it('knows when the draft says something new', () => {
    const saved = row({ domains: ['audit', 'inspection'], monthlyCapUsd: 10 })
    const d = draftFromAccess(saved)
    expect(d.domains).toEqual(['inspection', 'audit'])
    expect(accessChanged(saved, d)).toBe(false)
    // The same cap typed otherwise is no change.
    expect(accessChanged(saved, { ...d, cap: '10.00' })).toBe(false)
    expect(accessChanged(saved, { ...d, cap: '11' })).toBe(true)
    expect(accessChanged(saved, { ...d, enabled: false })).toBe(true)
    expect(accessChanged(saved, { ...d, domains: ['inspection'] })).toBe(true)
    expect(accessChanged(saved, { ...d, model: 'claude-opus-5-5' })).toBe(true)
    expect(accessChanged(saved, { ...d, effort: 'max' })).toBe(true)
    expect(accessChanged(saved, { ...d, automations: true })).toBe(true)
    expect(accessChanged(saved, { ...d, notices: true })).toBe(true)
  })
})

describe('notices through the assistant, on the owner’s page', () => {
  it('knows an administrator by the app’s own rule: the role that manages its data', () => {
    expect(isAdministrator('admin')).toBe(true)
    for (const role of ['supervisor', 'inspector', 'viewer', '', 'superuser', 'ADMIN']) expect(isAdministrator(role)).toBe(false)
  })

  it('says whether it is in effect: allowed administrators and the owner while one; allowed otherwise is held', () => {
    expect(noticesAccessView({ owner: false, notices: true, role: 'admin' }).key).toBe('can')
    expect(noticesAccessView({ owner: false, notices: false, role: 'admin' }).key).toBe('no')
    expect(noticesAccessView({ owner: true, notices: false, role: 'admin' }).key).toBe('can')
    expect(noticesAccessView({ owner: true, notices: true, role: 'supervisor' }).key).toBe('no')
    const held = noticesAccessView({ owner: false, notices: true, role: 'supervisor' })
    expect(held.key).toBe('held')
    expect(held.tip).toMatch(/only administrators manage notices/)
    expect(noticesAccessView({ owner: false, notices: false, role: 'inspector' }).tip).toMatch(/can still ask about the ones they see/)
  })

  it('says under the switch why it cannot be turned on, or what it allows', () => {
    expect(noticesSwitchHint({ admin: true, owner: false, stored: false })).toMatch(/^They may have the assistant write a notice.*nothing changes until they press its button/)
    expect(noticesSwitchHint({ admin: false, owner: false, stored: false })).toBe('Only administrators manage notices. Like everyone with the assistant, they can still ask about the notices they see.')
    expect(noticesSwitchHint({ admin: false, owner: false, stored: true })).toMatch(/not in effect .* Turn it off to drop it\.$/)
    expect(noticesSwitchHint({ admin: true, owner: true, stored: false })).toBe('You always can, as the assistant’s owner, while you are an administrator.')
    expect(noticesSwitchHint({ admin: false, owner: true, stored: true })).toMatch(/^Only administrators manage notices: as the owner/)
  })
})

describe('the table of who can use it', () => {
  it('puts the owner first, then accounts that can sign in, each by name', () => {
    const people = [
      row({ userId: 'z', name: 'Zeinab', active: false }),
      row({ userId: 'b', name: 'Basem' }),
      row({ userId: 'o', name: 'Mohamed Beda', owner: true }),
      row({ userId: 'a', name: 'Amr' }),
    ]
    expect(sortAccess(people).map((p) => p.userId)).toEqual(['o', 'a', 'b', 'z'])
  })

  it('counts a row as live only when the account can sign in, it is on, it has data and a cap one call fits in', () => {
    expect(accessLive(row({}))).toBe(true)
    expect(accessLive(row({ active: false }))).toBe(false)
    expect(accessLive(row({ enabled: false }))).toBe(false)
    expect(accessLive(row({ domains: [] }))).toBe(false)
    expect(accessLive(row({ model: 'claude-fable-5-1', monthlyCapUsd: 1, spentUsd: 0 }))).toBe(false)
    expect(accessLive(row({ model: 'claude-fable-5-1', monthlyCapUsd: 2.4 }))).toBe(true)
  })

  it('groups the accounts to add by role, the widest rights first, each by name', () => {
    const groups = groupByRole([
      { name: 'Omar', role: 'inspector' },
      { name: 'Hana', role: 'admin' },
      { name: 'Adel', role: 'inspector' },
      { name: 'Guest', role: 'auditor' },
      { name: 'Sara', role: 'viewer' },
    ])
    expect(groups.map(([role, list]) => [role, list.map((p) => p.name)])).toEqual([
      ['admin', ['Hana']],
      ['inspector', ['Adel', 'Omar']],
      ['viewer', ['Sara']],
      ['auditor', ['Guest']],
    ])
    expect(roleLabel('supervisor')).toBe('Supervisor')
  })
})
