import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type Anthropic from '@anthropic-ai/sdk'
import type { ApiErrorBody, AuditListResponse, AuditOptionsResponse, AuditStats } from '@qc/shared/api'
import {
  AI_DOMAIN_IDS,
  aiCostUsd,
  type AiAccess,
  type AiAccessListResponse,
  type AiActivityResponse,
  type AiConversationsResponse,
  type AiMeResponse,
  type AiMessagesResponse,
  type AiQueryPart,
  type AiReportExportResponse,
  type AiReportRunResponse,
  type AiSaveReportResponse,
  type AiStatusResponse,
  type AiStreamEvent,
} from '@qc/shared/ai'
import { TestApp, type Session } from './harness'
import { runSql, text, type FakeReply } from './aiFake'
import { ACCESS_NOTICE } from '../src/ai/access'
import { ROUTER_SYSTEM } from '../src/ai/router'
import { WITHDRAWN_NOT_RUN } from '../src/ai/assistant'
import { NO_ACCESS, findReport, runReportSections, type SectionReader, noAccessTo } from '../src/ai/reports'
import { runReadOnlyQuery } from '../src/ai/runQuery'

// §20 — who may use the assistant, as its owner sets it, person by person:
// on or off, the data they may ask about (enforced by the database), the
// a monthly cap of their own on
// top of the assistant's. Checked on every request and before every call to
// the model. Costs never reach the chat; the assistant's own audit entries
// reach nobody but the owner. The model is the scripted stand-in.

const app = new TestApp()
let owner: Session
let admin2: Session
let insp: Session
let sup: Session
let viewer: Session
const KEY = `sk-ant-api03-${'k_9-'.repeat(20)}LaSt`
const ALL = ['inspection', 'orders', 'materials', 'audit']
const BINDING = 'thinking-binding-controls-2026-08-01'
const FALLBACK = 'server-side-fallback-2026-07-01'

type Done = Extract<AiStreamEvent, { type: 'done' }>

interface Asked {
  status: number
  events: AiStreamEvent[]
  done?: Done
  error?: ApiErrorBody['error']
  conversationId: string
}

async function ask(as: Session, message: string, conversationId?: string, depth?: string): Promise<Asked> {
  const res = await app.api<string | ApiErrorBody>('POST', '/api/ai/chat', {
    token: as.token,
    body: { message, clientId: randomUUID(), ...(conversationId ? { conversationId } : {}), ...(depth ? { depth } : {}) },
  })
  if (res.status !== 200) return { status: res.status, events: [], error: (res.body as ApiErrorBody).error, conversationId: '' }
  const events = (res.body as string)
    .split('\n\n')
    .filter((f) => f && !f.startsWith(':'))
    .map((f) => JSON.parse(f.slice(f.indexOf('data: ') + 6)) as AiStreamEvent)
  const done = events.find((e): e is Done => e.type === 'done')
  const start = events.find((e): e is Extract<AiStreamEvent, { type: 'start' }> => e.type === 'start')
  return { status: res.status, events, done, conversationId: start?.conversation.id ?? '' }
}

const me = async (as: Session) => (await app.api<AiMeResponse>('GET', '/api/ai/me', { token: as.token })).body

interface Grant {
  enabled?: boolean
  domains?: string[]
  monthlyCapUsd?: number
  /** §20 — may have Excel from the assistant. Left out: unchanged. */
  excel?: boolean
}

async function grant(person: Session, g: Grant = {}): Promise<AiAccess> {
  const body = { enabled: true, domains: ALL, monthlyCapUsd: 50, ...g }
  const res = await app.api<AiAccess>('PUT', `/api/ai/access/${person.user.id}`, { token: owner.token, body })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return res.body
}

const lastCall = () => app.model.calls[app.model.calls.length - 1]
const systemOf = (call = lastCall()) => (call.params.system as { text: string }[])[0].text
const reply = (...replies: FakeReply[]) => app.model.reply(...replies)
const answer = (t: string): FakeReply => ({ content: [text(t)] })

/** Wait until a condition holds (a request reaching the scripted model), or fail after a few seconds. */
async function until(condition: () => boolean | Promise<boolean>): Promise<void> {
  for (const started = Date.now(); !(await condition()); ) {
    if (Date.now() - started > 5000) throw new Error('Waited too long.')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  owner = await app.register('admin', 'Owner Admin')
  for (const [username, name, role] of [
    ['admin2', 'Second Admin', 'admin'],
    ['insp', 'Inspector One', 'inspector'],
    ['sup', 'Super Visor', 'supervisor'],
    ['watch', 'Viewer', 'viewer'],
  ]) {
    expect((await app.api('POST', '/api/users', { token: owner.token, body: { username, password: 'Password#1', name, role } })).status).toBe(201)
  }
  admin2 = await app.login('admin2')
  insp = await app.login('insp')
  sup = await app.login('sup')
  viewer = await app.login('watch')
  for (const code of ['58', '31']) {
    expect((await app.api('POST', '/api/master/machines', { token: owner.token, body: { code, name: `Machine ${code}`, displayName: `${code}. Machine`, process: 'forming' } })).status).toBe(201)
  }
  expect((await app.api('PUT', '/api/ai/key', { token: owner.token, body: { apiKey: KEY } })).status).toBe(200)
})
afterAll(() => app.stop())
beforeEach(() => {
  for (const s of [owner, admin2, insp, sup, viewer]) {
    app.aiLimiter.reset(s.user.id)
    app.aiReportLimiter.reset(s.user.id)
  }
})

describe('§20 what anyone signed in learns', () => {
  it('only whether to show the assistant and whether it can answer: no amounts, no model', async () => {
    expect((await app.api('GET', '/api/ai/me')).status).toBe(401)
    expect(await me(owner)).toEqual({ granted: true, owner: true, available: true, automations: true, excel: true, notices: true, mtc: true, domains: [...AI_DOMAIN_IDS] })
    for (const s of [admin2, insp, sup, viewer]) {
      expect(await me(s), s.user.role).toEqual({ granted: false, owner: false, available: false, reason: 'not-granted', automations: false, excel: false, notices: false, mtc: false, domains: [] })
    }
  })
})

describe('§20 the owner gives the assistant, person by person', () => {
  it('offers the active accounts not listed yet, and lists who has it, the owner first', async () => {
    const people = await app.api<{ id: string; name: string; username: string; role: string }[]>('GET', '/api/ai/people', { token: owner.token })
    expect(people.status).toBe(200)
    expect(people.body.map((p) => p.username).sort()).toEqual(['admin2', 'insp', 'sup', 'watch'])
    expect(people.body.find((p) => p.username === 'insp')).toEqual({ id: insp.user.id, name: 'Inspector One', username: 'insp', role: 'inspector', managesNotices: false })

    const given = await grant(insp, { domains: ['orders', 'inspection'], monthlyCapUsd: 5 })
    expect(given).toEqual({
      userId: insp.user.id,
      name: 'Inspector One',
      username: 'insp',
      role: 'inspector',
      active: true,
      enabled: true,
      domains: ['inspection', 'orders'],
      monthlyCapUsd: 5,
      spentUsd: 0,
      owner: false,
      automations: false,
      notices: false,
      managesNotices: false,
      excel: false,
      mtc: false,
      updatedAt: expect.any(String),
      updatedByName: 'Owner Admin',
    })
    expect((await app.api<{ username: string }[]>('GET', '/api/ai/people', { token: owner.token })).body.map((p) => p.username)).not.toContain('insp')
    const list = (await app.api<AiAccessListResponse>('GET', '/api/ai/access', { token: owner.token })).body.people
    expect(list.map((p) => [p.username, p.owner])).toEqual([
      ['admin', true],
      ['insp', false],
    ])
    expect(await me(insp)).toEqual({ granted: true, owner: false, available: true, automations: false, excel: false, notices: false, mtc: false, domains: ['inspection', 'orders'] })
  })

  it('audits every change: a person given it in one line, a change field by field', async () => {
    await grant(insp, { domains: ['inspection', 'orders'], monthlyCapUsd: 7.5 })
    // The same again changes nothing, and records nothing.
    await grant(insp, { domains: ['orders', 'inspection'], monthlyCapUsd: 7.5 })
    const audit = await app.db.query(
      `SELECT action, field, old_value AS "oldValue", new_value AS "newValue", user_name AS "by" FROM audit_log WHERE entity = 'AiAccess' AND entity_id = $1 ORDER BY id`,
      [insp.user.id],
    )
    expect(audit.rows).toEqual([
      { action: 'create', field: 'access', oldValue: null, newValue: 'Inspector One (insp): on; Inspections, Orders and PDI; $5.00 a month', by: 'Owner Admin' },
      { action: 'update', field: 'monthlyCapUsd', oldValue: '5.00', newValue: '7.50', by: 'Owner Admin' },
    ])
  })

  it('takes only what the assistant offers, for an account that exists and can sign in', async () => {
    const good = { enabled: true, domains: ['inspection'], monthlyCapUsd: 5 }
    for (const body of [
      { ...good, domains: ['sales'] },
      { ...good, domains: ['orders', 'orders'] },
      // The model is the owner's Models', by what is asked: no longer a person's.
      { ...good, model: 'claude-opus-5-5' },
      { ...good, effort: 'low' },
      { ...good, monthlyCapUsd: -1 },
      { ...good, monthlyCapUsd: 2000.01 },
      { ...good, monthlyCapUsd: 1.234 },
      // A cap no single call fits in, on Sonnet 5.5, the model every question starts on: closed every month, so refused while the person is on.
      { ...good, monthlyCapUsd: 0.63 },
      { ...good, extra: true },
      { enabled: true, domains: ['inspection'] },
    ]) {
      expect((await app.api('PUT', `/api/ai/access/${viewer.user.id}`, { token: owner.token, body })).status, JSON.stringify(body)).toBe(400)
    }
    // The least cap is the owner's page's figure exactly; switched off, any cap is kept.
    const low = await app.api<ApiErrorBody>('PUT', `/api/ai/access/${viewer.user.id}`, { token: owner.token, body: { ...good, monthlyCapUsd: 0.63 } })
    expect(low.body.error.message).toBe('The monthly cap must be at least $0.64, the most one question may cost on Sonnet.')
    expect((await app.api('PUT', `/api/ai/access/${viewer.user.id}`, { token: owner.token, body: { ...good, monthlyCapUsd: 0.64 } })).status).toBe(200)
    expect((await app.api('PUT', `/api/ai/access/${viewer.user.id}`, { token: owner.token, body: { ...good, enabled: false, monthlyCapUsd: 0 } })).status).toBe(200)
    await app.api('DELETE', `/api/ai/access/${viewer.user.id}`, { token: owner.token })
    expect((await app.api('PUT', '/api/ai/access/not-a-uuid', { token: owner.token, body: good })).status).toBe(400)
    expect((await app.api('PUT', `/api/ai/access/${randomUUID()}`, { token: owner.token, body: good })).status).toBe(404)
    const gone = await app.api<{ id: string }>('POST', '/api/users', { token: owner.token, body: { username: 'gone', password: 'Password#1', name: 'Gone', role: 'inspector' } })
    await app.api('PATCH', `/api/users/${gone.body.id}`, { token: owner.token, body: { isActive: false } })
    const inactive = await app.api<ApiErrorBody>('PUT', `/api/ai/access/${gone.body.id}`, { token: owner.token, body: good })
    expect(inactive.status).toBe(400)
    expect(inactive.body.error.message).toMatch(/not active/)
    expect((await app.api('DELETE', `/api/ai/access/${viewer.user.id}`, { token: owner.token })).status).toBe(404)
    expect((await app.db.query(`SELECT 1 FROM ai_access WHERE user_id = ANY($1::uuid[])`, [[viewer.user.id, gone.body.id]])).rowCount).toBe(0)
  })
})

describe('§20 a question runs on Sonnet at high, or on Opus at high when the router finds it deep', () => {
  let conversationId = ''
  /** The router's reply: a level and why, or a failure; anything else asked by a completion is not scripted. */
  const routeAs = (level: 'standard' | 'deep' | Error, reason = 'Because.') => {
    app.model.completeWith = (params) => {
      if (params.system !== ROUTER_SYSTEM) throw new Error('not scripted')
      if (level instanceof Error) throw level
      return JSON.stringify({ level, reason })
    }
  }
  const routerCalls = () => app.model.completions.filter((c) => c.params.system === ROUTER_SYSTEM)
  afterAll(async () => {
    app.model.completeWith = () => {
      throw new Error('not scripted')
    }
  })

  it('answers a granted inspector at the level the router gives, the request shaped for its model, with no cost in sight', async () => {
    await grant(insp, { domains: ['inspection', 'orders'], monthlyCapUsd: 5 })
    routeAs('standard', 'One count of machines.')
    reply(
      { content: [text('Let me count.'), runSql('toolu_h1', 'Count the machines', 'SELECT count(*) AS n FROM ai.machines')], usage: { input_tokens: 2000, output_tokens: 300 } },
      { content: [text('There are **2** machines.')], usage: { input_tokens: 2100, output_tokens: 100 } },
    )
    const calls = app.model.calls.length
    const routed = routerCalls().length
    const res = await ask(insp, 'How many machines?')
    expect(res.status).toBe(200)
    conversationId = res.conversationId

    // The router read the question first, on Sonnet, in a fixed shape.
    const router = routerCalls().slice(routed)
    expect(router).toHaveLength(1)
    expect(router[0].params).toMatchObject({ model: 'claude-sonnet-5-5', max_tokens: 300, thinking: { type: 'between_tools' }, output_config: { format: { type: 'json_schema' } } })
    expect(JSON.stringify(router[0].params.messages)).toContain('How many machines?')

    // A standard question: Sonnet 5.5 at high effort, with its server-side fallback.
    const params = app.model.calls[calls].params
    expect(params).toMatchObject({
      model: 'claude-sonnet-5-5',
      output_config: { effort: 'high' },
      fallbacks: 'default',
      betas: [FALLBACK, BINDING],
      thinking: { type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'error' } },
      max_tokens: 32_000,
    })

    // Whether they may ask on, and nothing of the assistant's figures or model.
    expect(res.done!.status).toEqual({ available: true, model: '', spentUsd: 0, capUsd: 0, monthStart: expect.any(String) })
    expect(res.done!.message).not.toHaveProperty('costUsd')
    const shown = await app.api<AiMessagesResponse>('GET', `/api/ai/conversations/${conversationId}/messages`, { token: insp.token })
    expect(shown.body.messages.every((m) => !('costUsd' in m))).toBe(true)

    // Billed at each call's model's rates — the router's call with the question's — and the turn knows its level, why, and what it ran on.
    const usage = await app.db.query<{ model: string; costUsd: number }>(`SELECT model, cost_usd AS "costUsd" FROM ai_usage WHERE conversation_id = $1 ORDER BY id`, [conversationId])
    const at = (input: number, output: number) => aiCostUsd('claude-sonnet-5-5', { inputTokens: input, outputTokens: output, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0 })
    expect(usage.rows).toEqual([
      { model: 'claude-sonnet-5-5', costUsd: at(120, 8) },
      { model: 'claude-sonnet-5-5', costUsd: at(2000, 300) },
      { model: 'claude-sonnet-5-5', costUsd: at(2100, 100) },
    ])
    const turn = await app.db.query(`SELECT model, effort, level, level_reason AS "levelReason" FROM ai_turns WHERE conversation_id = $1`, [conversationId])
    expect(turn.rows).toEqual([{ model: 'claude-sonnet-5-5', effort: 'high', level: 'chat-standard', levelReason: 'One count of machines.' }])
    expect((await app.api<AiAccessListResponse>('GET', '/api/ai/access', { token: owner.token })).body.people.find((p) => p.userId === insp.user.id)!.spentUsd).toBeCloseTo(
      at(120, 8) + at(2000, 300) + at(2100, 100),
      6,
    )

    // The owner sees the level and why in Activity; the person sees neither.
    const activity = await app.api<AiActivityResponse>('GET', `/api/ai/activity?user=${insp.user.id}`, { token: owner.token })
    expect(activity.body.items[0]).toMatchObject({ kind: 'question', text: 'How many machines?', level: 'chat-standard', levelReason: 'One count of machines.' })
  })

  it('raises a conversation’s level when a question asks more, and never lowers it: its cache holds', async () => {
    const prompt = systemOf()
    // The router failing (no answer in time, say): the standard level, with no reason; never a refusal.
    routeAs(new Error('overloaded'))
    reply(answer('A trend.'))
    let routed = routerCalls().length
    expect((await ask(insp, 'And the trend?', conversationId)).status).toBe(200)
    expect(JSON.stringify(routerCalls()[routed].params.messages)).toContain('answered as standard')
    expect(lastCall().params).toMatchObject({ model: 'claude-sonnet-5-5', output_config: { effort: 'high' } })

    routeAs('deep', 'Causes across several sources.')
    reply({ ...answer('Here is why.'), model: 'claude-opus-5-5' })
    routed = routerCalls().length
    expect((await ask(insp, 'Why did the defects rise?', conversationId)).status).toBe(200)
    expect(JSON.stringify(routerCalls()[routed].params.messages)).toContain('answered as standard')
    expect(lastCall().params).toMatchObject({ model: 'claude-opus-5-5', output_config: { effort: 'high' }, fallbacks: 'default', betas: [FALLBACK, BINDING] })
    // The conversation keeps the prompt it began with, byte for byte, whatever model answers.
    expect(systemOf()).toBe(prompt)

    // Deep already, the router is not asked: a light follow-up stays on Opus, in the conversation's cache.
    routeAs('standard', 'A thank-you.')
    reply({ ...answer('You are welcome.'), model: 'claude-opus-5-5' })
    routed = routerCalls().length
    expect((await ask(insp, 'Thanks!', conversationId)).status).toBe(200)
    expect(routerCalls()).toHaveLength(routed)
    expect(lastCall().params).toMatchObject({ model: 'claude-opus-5-5', output_config: { effort: 'high' } })

    const kept = 'Kept at Deep analysis: the conversation is there already, and keeps its cache.'
    const turns = await app.db.query(`SELECT model, effort, level, level_reason AS "levelReason" FROM ai_turns WHERE conversation_id = $1 ORDER BY created_at`, [conversationId])
    expect(turns.rows.slice(1)).toEqual([
      { model: 'claude-sonnet-5-5', effort: 'high', level: 'chat-standard', levelReason: null },
      { model: 'claude-opus-5-5', effort: 'high', level: 'chat-deep', levelReason: 'Causes across several sources.' },
      { model: 'claude-opus-5-5', effort: 'high', level: 'chat-deep', levelReason: kept },
    ])
  })

  it('goes on as a standard conversation from a level of before the levels were fixed', async () => {
    await app.db.query(`UPDATE ai_turns SET level = 'chat-simple', model = 'claude-haiku-5-5', effort = 'low' WHERE conversation_id = $1`, [conversationId])
    // Back below deep: the router is asked again, told the level as it was.
    routeAs('standard', 'A count.')
    reply(answer('Two.'))
    const routed = routerCalls().length
    expect((await ask(insp, 'How many now?', conversationId)).status).toBe(200)
    expect(JSON.stringify(routerCalls()[routed].params.messages)).toContain('answered as simple question')
    expect(lastCall().params).toMatchObject({ model: 'claude-sonnet-5-5', output_config: { effort: 'high' } })
    const last = await app.db.query(`SELECT level FROM ai_turns WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1`, [conversationId])
    expect(last.rows).toEqual([{ level: 'chat-standard' }])
  })

  it('answers Quick on Haiku at low and Deep on Opus as the person picks them, the router not asked; Standard asks it again', async () => {
    routeAs('deep', 'Should not be asked.')
    reply(answer('Twelve.'))
    let routed = routerCalls().length
    const quick = await ask(insp, 'How many machines?', undefined, 'quick')
    expect(quick.status).toBe(200)
    expect(routerCalls()).toHaveLength(routed)
    // Haiku has no server-side fallback: none is asked for.
    expect(lastCall().params).toMatchObject({ model: 'claude-haiku-5-5', output_config: { effort: 'low' } })
    expect(lastCall().params).not.toHaveProperty('fallbacks')

    // Deep, picked: Opus at once, whatever the router would say.
    reply({ ...answer('Here is why.'), model: 'claude-opus-5-5' })
    expect((await ask(insp, 'And the trend?', quick.conversationId, 'deep')).status).toBe(200)
    expect(routerCalls()).toHaveLength(routed)
    expect(lastCall().params).toMatchObject({ model: 'claude-opus-5-5', output_config: { effort: 'high' } })

    // Quick again after Deep: the person's pick wins over a deep conversation staying deep.
    reply(answer('Twelve.'))
    expect((await ask(insp, 'And now?', quick.conversationId, 'quick')).status).toBe(200)
    expect(lastCall().params).toMatchObject({ model: 'claude-haiku-5-5', output_config: { effort: 'low' } })

    // Standard after that Quick: the conversation has been deep, so it is deep again, in its cache; the router is not asked.
    reply({ ...answer('Twelve.'), model: 'claude-opus-5-5' })
    expect((await ask(insp, 'And today?', quick.conversationId, 'standard')).status).toBe(200)
    expect(routerCalls()).toHaveLength(routed)
    expect(lastCall().params).toMatchObject({ model: 'claude-opus-5-5', output_config: { effort: 'high' } })

    const turns = await app.db.query(`SELECT model, effort, level, level_reason AS "levelReason" FROM ai_turns WHERE conversation_id = $1 ORDER BY created_at`, [quick.conversationId])
    expect(turns.rows).toEqual([
      { model: 'claude-haiku-5-5', effort: 'low', level: 'chat-quick', levelReason: 'Quick, as the person picked it.' },
      { model: 'claude-opus-5-5', effort: 'high', level: 'chat-deep', levelReason: 'Deep analysis, as the person picked it.' },
      { model: 'claude-haiku-5-5', effort: 'low', level: 'chat-quick', levelReason: 'Quick, as the person picked it.' },
      { model: 'claude-opus-5-5', effort: 'high', level: 'chat-deep', levelReason: 'Kept at Deep analysis: the conversation is there already, and keeps its cache.' },
    ])

    // A conversation never deep: Standard after Quick asks the router, told the question before it was asked Quick.
    reply(answer('Twelve.'))
    const light = await ask(insp, 'How many machines?', undefined, 'quick')
    routeAs('standard', 'One count.')
    reply(answer('Twelve.'))
    routed = routerCalls().length
    expect((await ask(insp, 'And today?', light.conversationId, 'standard')).status).toBe(200)
    expect(routerCalls()).toHaveLength(routed + 1)
    expect(JSON.stringify(routerCalls()[routed].params.messages)).toContain('answered as quick')
    expect(lastCall().params).toMatchObject({ model: 'claude-sonnet-5-5', output_config: { effort: 'high' } })
    // A depth the app does not offer is refused.
    expect((await ask(insp, 'How many?', undefined, 'max')).status).toBe(400)
  })

  it('describes to the model only the views of the person’s domains', async () => {
    const prompt = systemOf(app.model.calls.find((c) => c.params.messages.length === 1 && JSON.stringify(c.params.messages).includes('How many machines?'))!)
    for (const view of ['machines', 'inspection_sessions', 'defects', 'order_lines', 'pdi_documents']) expect(prompt, view).toContain(`### ai.${view}\n`)
    for (const view of ['coils', 'suppliers', 'audit_log', 'users', 'work_instructions']) expect(prompt, view).not.toContain(`### ai.${view}\n`)
    expect(prompt).toContain('### ai.production_between(')
    expect(prompt).toContain('# Meanings that are easy to get wrong')
    expect(prompt).toContain('- inspection records: sessions, samples, defects')
    expect(prompt).not.toContain('the coil register, suppliers and master data')
    // Notices (§23) are put out by administrators, and the person is told so; nothing else of the prompt is about them.
    expect(prompt.slice(0, prompt.indexOf('# Notices')) + prompt.slice(prompt.indexOf('# Read-only'))).not.toMatch(/administrator/i)

    // Coils and master data only: none of the meanings or links that concern other data.
    await grant(viewer, { domains: ['materials'], monthlyCapUsd: 5 })
    reply(answer('Hello.'))
    expect((await ask(viewer, 'Hello')).status).toBe(200)
    const materials = systemOf()
    expect(materials).toContain('### ai.coils\n')
    expect(materials).toContain('### ai.machines\n')
    for (const view of ['inspection_sessions', 'order_lines', 'audit_log', 'users']) expect(materials, view).not.toContain(`### ai.${view}\n`)
    expect(materials).not.toContain('production_between')
    expect(materials).not.toContain('# Meanings that are easy to get wrong')
    expect(materials).not.toContain('/history?session=')
  })

  it('lets the database refuse a view beyond the person’s domains, and tells the model why', async () => {
    reply(
      { content: [runSql('toolu_d1', 'Accounts', 'SELECT count(*) AS n FROM ai.users'), runSql('toolu_d2', 'Order lines', 'SELECT count(*) AS n FROM ai.order_lines')] },
      answer('I can count the order lines, not the accounts.'),
    )
    const res = await ask(insp, 'How many accounts and order lines?')
    const results = lastCall().params.messages[2].content as Anthropic.Beta.BetaToolResultBlockParam[]
    expect(results[0]).toMatchObject({ tool_use_id: 'toolu_d1', is_error: true, content: expect.stringMatching(/permission denied for view users.*Only the views and functions in schema ai, and the saved tables in schema ai_saved, can be read/) })
    expect(results[1]).toEqual({ type: 'tool_result', tool_use_id: 'toolu_d2', content: '{"columns":["n"],"rows":[[0]],"rowCount":1,"truncated":false}' })
    expect(res.done!.message.parts.filter((p) => p.type === 'query').map((p) => (p as AiQueryPart).ok)).toEqual([false, true])
  })
})

describe('§20 when the owner changes a person’s data', () => {
  let conversationId = ''
  let prompt = ''
  let reportId = ''
  let inspectionQueryId = ''

  it('keeps an old conversation’s prompt; a revoked view fails there, and new conversations describe what is left', async () => {
    await grant(insp, { domains: ['inspection', 'orders'], monthlyCapUsd: 5 })
    reply(
      {
        content: [
          runSql('toolu_r1', 'Sessions', 'SELECT count(*) AS n FROM ai.inspection_sessions'),
          runSql('toolu_r2', 'Order lines', 'SELECT count(*) AS n FROM ai.order_lines'),
        ],
      },
      answer('None of either.'),
    )
    const first = await ask(insp, 'How many sessions and order lines?')
    conversationId = first.conversationId
    prompt = systemOf()
    inspectionQueryId = (first.done!.message.parts.find((p) => p.type === 'query') as AiQueryPart).queryId
    const saved = await app.api<AiSaveReportResponse>('POST', '/api/ai/reports', { token: insp.token, body: { turnId: first.done!.message.turnId, adjustable: false } })
    expect(saved.status).toBe(201)
    reportId = saved.body.report.id
    expect(saved.body.status).toEqual({ available: true, model: '', spentUsd: 0, capUsd: 0, monthStart: expect.any(String) })

    // Allowed Excel, so the exports below show what their domains now let them read.
    await grant(insp, { domains: ['orders'], monthlyCapUsd: 5, excel: true })
    reply({ content: [runSql('toolu_r3', 'Sessions again', 'SELECT count(*) AS n FROM ai.inspection_sessions')] }, answer('I can no longer read the inspections.'))
    await ask(insp, 'And now?', conversationId)
    expect(systemOf()).toBe(prompt)
    const result = (lastCall().params.messages.at(-1)!.content as Anthropic.Beta.BetaToolResultBlockParam[])[0]
    expect(result).toMatchObject({ is_error: true, content: expect.stringMatching(/permission denied for view inspection_sessions/) })

    reply(answer('Hello.'))
    await ask(insp, 'A new conversation')
    expect(systemOf()).toContain('### ai.order_lines\n')
    expect(systemOf()).not.toContain('### ai.inspection_sessions\n')
  })

  it('runs a saved report as the person’s current domains: a section on revoked data says so, the rest runs', async () => {
    const run = await app.api<AiReportRunResponse>('GET', `/api/ai/reports/${reportId}/run`, { token: insp.token })
    expect(run.status).toBe(200)
    // Refused by the database for want of the inspections: said in the domain's name, for the person to ask for it.
    expect(run.body.sections.map((s) => [s.title, s.ok, s.error ?? null])).toEqual([
      ['Sessions', false, noAccessTo('Inspections')],
      ['Order lines', true, null],
    ])
    const exported = await app.api<AiReportExportResponse>('GET', `/api/ai/reports/${reportId}/export`, { token: insp.token })
    expect(exported.body.sections.map((s) => [s.ok, s.error ?? null])).toEqual([
      [false, noAccessTo('Inspections')],
      [true, null],
    ])
    const query = await app.api<ApiErrorBody>('GET', `/api/ai/queries/${inspectionQueryId}/export`, { token: insp.token })
    expect(query.status).toBe(400)
    expect(query.body.error.message).toBe('The query could not be run again: you no longer have access to this data.')
    // Given back, it runs again (and Excel goes, as the rest of these tests have it).
    await grant(insp, { domains: ['inspection', 'orders'], monthlyCapUsd: 5, excel: false })
    const again = await app.api<AiReportRunResponse>('GET', `/api/ai/reports/${reportId}/run`, { token: insp.token })
    expect(again.body.sections.every((s) => s.ok)).toBe(true)
  })

  it('asks for the person’s domains again before every section of a run: a change while it runs counts from the next', async () => {
    const report = (await findReport(app.db, reportId, insp.user.id))!
    expect(report.sections.map((s) => s.title)).toEqual(['Sessions', 'Order lines'])
    // The owner takes the inspections away after the first section, then the assistant altogether.
    for (const [later, error] of [
      [app.aiReader.poolFor(['orders']), undefined],
      ['withdrawn', NO_ACCESS],
    ] as const) {
      let asked = 0
      const reader: SectionReader = async () => (asked++ === 0 ? app.aiReader.poolFor(['inspection', 'orders']) : later)
      const ran = await runReportSections(reader, report, null, { timeZone: 'Africa/Cairo' })
      expect(asked).toBe(2)
      expect(ran.map((s) => [s.title, s.ok])).toEqual([
        ['Sessions', true],
        ['Order lines', later !== 'withdrawn'],
      ])
      expect(ran[1].error).toBe(error)
      if (later === 'withdrawn') expect(ran[1].rows).toEqual([])
    }
  })

  it('keeps no report for a person the owner stops while Claude makes its period adjustable', async () => {
    reply({ content: [runSql('toolu_k1', 'Machines', 'SELECT count(*) AS n FROM ai.machines')] }, answer('Two machines.'))
    const asked = await ask(insp, 'How many machines?')
    let release!: () => void
    reply({ content: [text('{"title": "Machines", "period": null, "sections": []}')], hold: new Promise<void>((r) => (release = r)) })
    const calls = app.model.calls.length
    const saving = app.api<ApiErrorBody>('POST', '/api/ai/reports', { token: insp.token, body: { turnId: asked.done!.message.turnId } })
    await until(() => app.model.calls.length > calls)
    await grant(insp, { enabled: false, domains: ['inspection', 'orders'] })
    release()
    const refused = await saving
    expect(refused.status).toBe(403)
    expect(refused.body.error).toEqual({ code: 'forbidden', message: 'You do not have access to the assistant.' })
    expect((await app.db.query(`SELECT 1 FROM ai_reports WHERE turn_id = $1`, [asked.done!.message.turnId])).rowCount).toBe(0)
    // The call was made, and is counted: the answer's two, and this one.
    expect((await app.db.query(`SELECT 1 FROM ai_usage WHERE turn_id = $1`, [asked.done!.message.turnId])).rowCount).toBe(3)
    await grant(insp, { domains: ['inspection', 'orders'], monthlyCapUsd: 5 })
  })

  it('applies a domain taken away mid-answer to the next query, even one the call under way asked for', async () => {
    await grant(insp, { domains: ['inspection', 'audit'], monthlyCapUsd: 5 })
    let release!: () => void
    reply(
      {
        content: [runSql('toolu_m1', 'Accounts', 'SELECT count(*) AS n FROM ai.users'), runSql('toolu_m2', 'Machines', 'SELECT count(*) AS n FROM ai.machines')],
        hold: new Promise<void>((r) => (release = r)),
      },
      { content: [runSql('toolu_m3', 'Sessions', 'SELECT count(*) AS n FROM ai.inspection_sessions')] },
      answer('The accounts and the inspections are no longer mine to read.'),
    )
    const calls = app.model.calls.length
    const pending = ask(insp, 'Accounts and machines, then sessions')
    await until(() => app.model.calls.length > calls)
    // While the model writes the queries, the owner leaves the person the orders only.
    await grant(insp, { domains: ['orders'], monthlyCapUsd: 5 })
    release()
    const res = await pending
    const ran = (p: AiQueryPart) => [p.purpose, p.ok]
    expect(res.done!.message.parts.filter((p): p is AiQueryPart => p.type === 'query').map(ran)).toEqual([
      ['Accounts', false],
      ['Machines', true],
      ['Sessions', false],
    ])
    // Nothing of a view taken away reached the person, not even from the call that asked before the change.
    const ends = res.events.filter((e): e is Extract<AiStreamEvent, { type: 'query_end' }> => e.type === 'query_end').map((e) => e.part)
    expect(ends.map(ran)).toEqual([
      ['Accounts', false],
      ['Machines', true],
      ['Sessions', false],
    ])
    expect(ends[0].rows).toEqual([])
    const firstResults = app.model.calls[calls + 1].params.messages.at(-1)!.content as Anthropic.Beta.BetaToolResultBlockParam[]
    expect(firstResults[0]).toMatchObject({ tool_use_id: 'toolu_m1', is_error: true, content: expect.stringMatching(/permission denied for view users/) })
    expect(firstResults[1]).toMatchObject({ tool_use_id: 'toolu_m2', content: expect.stringContaining('"rows":[[2]]') })
    const results = lastCall().params.messages.at(-1)!.content as Anthropic.Beta.BetaToolResultBlockParam[]
    expect(results[0]).toMatchObject({ tool_use_id: 'toolu_m3', is_error: true, content: expect.stringMatching(/permission denied for view inspection_sessions/) })
    await grant(insp, { domains: ['inspection', 'orders'], monthlyCapUsd: 5 })
  })

  it('stops a person the owner switches off, gives nothing to ask about, or removes — at once; given back, their conversations are there', async () => {
    const reachable = async () => (await app.api('GET', '/api/ai/conversations', { token: insp.token })).status
    for (const g of [{ enabled: false }, { domains: [] }]) {
      await grant(insp, { domains: ['orders'], ...g })
      expect(await me(insp)).toEqual({ granted: false, owner: false, available: false, reason: 'not-granted', automations: false, excel: false, notices: false, mtc: false, domains: [] })
      expect(await reachable()).toBe(403)
      expect((await ask(insp, 'Still there?')).status).toBe(403)
      expect((await app.api('GET', `/api/ai/reports/${reportId}/run`, { token: insp.token })).status).toBe(403)
    }
    await grant(insp, { domains: ['orders'] })
    expect(await reachable()).toBe(200)

    expect((await app.api('DELETE', `/api/ai/access/${insp.user.id}`, { token: owner.token })).status).toBe(204)
    expect(await me(insp)).toMatchObject({ granted: false, reason: 'not-granted' })
    expect(await reachable()).toBe(403)
    expect((await app.api<{ username: string }[]>('GET', '/api/ai/people', { token: owner.token })).body.map((p) => p.username)).toContain('insp')
    const removed = await app.db.query(`SELECT action, old_value AS "oldValue" FROM audit_log WHERE entity = 'AiAccess' AND entity_id = $1 AND action = 'delete'`, [insp.user.id])
    expect(removed.rows).toEqual([{ action: 'delete', oldValue: 'Inspector One (insp): on; Orders and PDI; $50.00 a month' }])

    await grant(insp, { domains: ['inspection', 'orders'], monthlyCapUsd: 5 })
    const list = await app.api<AiConversationsResponse>('GET', '/api/ai/conversations', { token: insp.token })
    expect(list.body.conversations.map((c) => c.id)).toContain(conversationId)
  })

  it('stops a running answer once the person loses access: the call under way finishes, none of its queries runs', async () => {
    const revocations: [string, () => Promise<unknown>][] = [
      ['switched off', () => grant(insp, { enabled: false, domains: ['inspection'] })],
      ['removed', () => app.api('DELETE', `/api/ai/access/${insp.user.id}`, { token: owner.token })],
      ['deactivated', () => app.api('PATCH', `/api/users/${insp.user.id}`, { token: owner.token, body: { isActive: false } })],
    ]
    for (const [how, revoke] of revocations) {
      await grant(insp, { domains: ['inspection', 'audit'], monthlyCapUsd: 5 })
      let release!: () => void
      reply(
        {
          content: [text('Let me look. '), runSql('toolu_w1', 'Accounts', 'SELECT * FROM ai.users'), runSql('toolu_w2', 'Machines', 'SELECT count(*) AS n FROM ai.machines')],
          hold: new Promise<void>((r) => (release = r)),
        },
        answer('Never sent.'),
      )
      const calls = app.model.calls.length
      const pending = ask(insp, `A long one (${how})`)
      await until(() => app.model.calls.length > calls)
      await revoke()
      release()
      const res = await pending
      expect(res.done!.message, how).toMatchObject({ stopReason: 'stopped', notice: ACCESS_NOTICE.withdrawn })
      // The call under way finished and its text is kept; no query of it ran, nothing was shown, no further call was made.
      expect(res.done!.message.parts, how).toEqual([{ type: 'text', text: 'Let me look. ' }])
      expect(res.events.filter((e) => e.type === 'query_start' || e.type === 'query_end'), how).toEqual([])
      expect((await app.db.query(`SELECT 1 FROM ai_queries WHERE conversation_id = $1`, [res.conversationId])).rowCount, how).toBe(0)
      expect(app.model.calls.length - calls, how).toBe(1)
      expect(app.model.pending, how).toBe(1)
      app.model.reset()
      if (how === 'deactivated') {
        expect((await app.api('PATCH', `/api/users/${insp.user.id}`, { token: owner.token, body: { isActive: true } })).status).toBe(200)
        insp = await app.login('insp')
      }

      // Given back, the conversation goes on: each query the model asked for has its answer, that it never ran.
      await grant(insp, { domains: ['inspection', 'audit'], monthlyCapUsd: 5 })
      reply(answer('Ask me again.'))
      expect((await ask(insp, 'Still there?', res.conversationId)).done!.message.stopReason).toBe('end_turn')
      const replayed = lastCall().params.messages.find((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'))!
      expect(replayed.content).toEqual([
        { type: 'tool_result', tool_use_id: 'toolu_w1', is_error: true, content: WITHDRAWN_NOT_RUN },
        { type: 'tool_result', tool_use_id: 'toolu_w2', is_error: true, content: WITHDRAWN_NOT_RUN },
      ])
    }
  })

  it('takes the assistant from a deactivated account at once', async () => {
    await grant(insp, { domains: ['inspection', 'orders'], monthlyCapUsd: 5 })
    expect((await app.api('PATCH', `/api/users/${insp.user.id}`, { token: owner.token, body: { isActive: false } })).status).toBe(200)
    expect((await app.api('GET', '/api/ai/me', { token: insp.token })).status).toBe(401)
    expect((await app.api<AiAccessListResponse>('GET', '/api/ai/access', { token: owner.token })).body.people.find((p) => p.userId === insp.user.id)).toMatchObject({ active: false, enabled: true })
    expect((await app.api('PATCH', `/api/users/${insp.user.id}`, { token: owner.token, body: { isActive: true } })).status).toBe(200)
    insp = await app.login('insp')
    expect(await me(insp)).toEqual({ granted: true, owner: false, available: true, automations: false, excel: false, notices: false, mtc: false, domains: ['inspection', 'orders'] })
  })
})

describe('§20 the caps, a person’s own and the assistant’s', () => {
  const spentBy = async (userId: string) =>
    Number((await app.db.query<{ n: number }>(`SELECT COALESCE(sum(cost_usd), 0)::float8 AS n FROM ai_usage WHERE user_id = $1`, [userId])).rows[0].n)

  it('holds a person to their own cap, saying so without an amount, and leaves the others be', async () => {
    await grant(insp, { domains: ['inspection'], monthlyCapUsd: 1 })
    await app.db.query(`INSERT INTO ai_usage (user_id, model, output_tokens, cost_usd) VALUES ($1, 'claude-haiku-5-5', 0, $2)`, [insp.user.id, 1 - (await spentBy(insp.user.id)) - 0.001])
    expect(await me(insp)).toEqual({ granted: true, owner: false, available: false, reason: 'personal-cap', automations: false, excel: false, notices: false, mtc: false, domains: ['inspection'] })
    const refused = await ask(insp, 'One more?')
    expect(refused.status).toBe(402)
    expect(refused.error).toEqual({ code: 'ai_budget_reached', message: "You have reached this month's limit for the assistant. It is available again on the 1st." })
    expect(await me(owner)).toEqual({ granted: true, owner: true, available: true, automations: true, excel: true, notices: true, mtc: true, domains: [...AI_DOMAIN_IDS] })
    // The owner sees the figures on the settings page.
    const listed = (await app.api<AiAccessListResponse>('GET', '/api/ai/access', { token: owner.token })).body.people.find((p) => p.userId === insp.user.id)!
    expect(listed.spentUsd).toBeCloseTo(0.999, 6)
  })

  it('holds everyone to the assistant’s cap; only the owner is told where to raise it', async () => {
    await grant(insp, { domains: ['inspection'], monthlyCapUsd: 50 })
    const status = (await app.api<AiStatusResponse>('GET', '/api/ai/status', { token: owner.token })).body
    await app.api('PUT', '/api/ai/settings', { token: owner.token, body: { enabled: true, monthlyCapUsd: Math.ceil((status.spentUsd + 0.005) * 100) / 100 } })
    try {
      expect(await me(insp)).toEqual({ granted: true, owner: false, available: false, reason: 'cap-reached', automations: false, excel: false, notices: false, mtc: false, domains: ['inspection'] })
      const refused = await ask(insp, 'At the cap?')
      expect(refused.error).toEqual({ code: 'ai_budget_reached', message: "The assistant's monthly limit is reached. It is available again on the 1st." })
      const ownerAsks = await ask(owner, 'At the cap?')
      expect(ownerAsks.error).toEqual({
        code: 'ai_budget_reached',
        message: "The assistant's monthly limit is reached. It is available again on the 1st. You can raise it under Administration → AI assistant.",
      })
      // Switched off: a person is told only that it is not available.
      await app.api('PUT', '/api/ai/settings', { token: owner.token, body: { enabled: false, monthlyCapUsd: 50 } })
      expect(await me(insp)).toEqual({ granted: true, owner: false, available: false, reason: 'unavailable', automations: false, excel: false, notices: false, mtc: false, domains: ['inspection'] })
      expect((await ask(insp, 'Off?')).error).toEqual({ code: 'ai_unavailable', message: 'The assistant is not available right now. Try again later.' })
      expect((await ask(owner, 'Off?')).error?.message).toMatch(/switched off/)
    } finally {
      await app.api('PUT', '/api/ai/settings', { token: owner.token, body: { enabled: true, monthlyCapUsd: 50 } })
    }
  })

  it('stops an answer before a call that could pass the person’s own cap', async () => {
    const spent = await spentBy(insp.user.id)
    // A standard question, on Sonnet 5.5: room for one call's worst case (32 000 tokens at $10 a million, as much again for
    // its fallback, and the prompt), not two once the first has written 40 000 tokens.
    app.model.completeWith = (params) => {
      if (params.system !== ROUTER_SYSTEM) throw new Error('not scripted')
      return '{"level":"standard","reason":"One count."}'
    }
    await grant(insp, { domains: ['inspection'], monthlyCapUsd: Math.ceil((spent + 0.95) * 100) / 100 })
    reply({ content: [runSql('toolu_c1', 'Machines', 'SELECT count(*) AS n FROM ai.machines')], usage: { input_tokens: 1000, output_tokens: 40_000 } }, answer('Never sent.'))
    const res = await ask(insp, 'An expensive one')
    expect(res.done!.message).toMatchObject({ stopReason: 'cap', notice: ACCESS_NOTICE.personalCap })
    expect(res.done!.message.notice).not.toMatch(/\$/)
    expect(res.done!.status).toEqual({ available: false, reason: 'cap-reached', model: '', spentUsd: 0, capUsd: 0, monthStart: expect.any(String) })
    expect(app.model.pending).toBe(1)
    app.model.reset()
    await grant(insp, { domains: ['inspection', 'orders'], monthlyCapUsd: 50 })
  })
})

describe('§20 the assistant’s own audit entries', () => {
  const AI_ENTITIES = ['AiAssistant', 'AiAccess', 'AiReport']
  const isAi = (e: { entity: string; entityId: string }) => AI_ENTITIES.includes(e.entity) || (e.entity === 'AppSettings' && e.entityId.startsWith('ai'))

  it('are nowhere in the log for anyone but the owner: not listed, counted, offered, searched or purged', async () => {
    const all = (await app.db.query<{ entity: string; entityId: string; n: number }>(
      `SELECT entity, entity_id AS "entityId", count(*)::int AS n FROM audit_log WHERE deleted_at IS NULL GROUP BY 1, 2`,
    )).rows
    const total = all.reduce((n, r) => n + r.n, 0)
    const aiTotal = all.filter(isAi).reduce((n, r) => n + r.n, 0)
    // Something of each kind to hide, and something else to show.
    for (const entity of AI_ENTITIES) expect(all.some((r) => r.entity === entity), entity).toBe(true)
    expect(all.some((r) => r.entity === 'AppSettings' && r.entityId === 'ai-assistant')).toBe(true)
    expect(total - aiTotal).toBeGreaterThan(0)

    for (const s of [admin2, sup]) {
      const list = await app.api<AuditListResponse>('GET', '/api/audit?limit=2000', { token: s.token })
      expect(list.body.entries.filter(isAi), s.user.role).toEqual([])
      expect(list.body.total).toBe(total - aiTotal)
      const stats = await app.api<AuditStats>('GET', '/api/audit/stats', { token: s.token })
      expect(stats.body.total).toBe(total - aiTotal)
      const options = await app.api<AuditOptionsResponse>('GET', '/api/audit/options', { token: s.token })
      for (const entity of AI_ENTITIES) expect(options.body.entities).not.toContain(entity)
      const values = await app.api<{ values: { value: string }[] }>('GET', '/api/audit/values?column=entity', { token: s.token })
      for (const entity of AI_ENTITIES) expect(values.body.values.map((v) => v.value)).not.toContain(entity)
      const searched = await app.api<AuditListResponse>('GET', `/api/audit?q=${encodeURIComponent('Inspector One (insp)')}`, { token: s.token })
      expect(searched.body.entries).toEqual([])
      const byEntity = await app.api<AuditListResponse>('GET', '/api/audit?entity=AiAccess', { token: s.token })
      expect(byEntity.body.entries).toEqual([])
    }

    const ownerList = await app.api<AuditListResponse>('GET', '/api/audit?limit=2000', { token: owner.token })
    expect(ownerList.body.total).toBe(total)
    expect(ownerList.body.entries.filter(isAi)).toHaveLength(aiTotal)
    expect((await app.api<AuditStats>('GET', '/api/audit/stats', { token: owner.token })).body.total).toBe(total)
    expect((await app.api<AuditOptionsResponse>('GET', '/api/audit/options', { token: owner.token })).body.entities).toEqual(expect.arrayContaining(AI_ENTITIES))

    // An administrator purging by id cannot reach them.
    const target = ownerList.body.entries.find((e) => e.entity === 'AiAccess')!
    const purged = await app.api<{ marked: number }>('POST', '/api/audit/purge', { token: admin2.token, body: { ids: [target.id] } })
    expect(purged.body).toEqual({ marked: 0 })
    expect((await app.db.query(`SELECT deleted_at FROM audit_log WHERE id = $1`, [target.id])).rows[0].deleted_at).toBeNull()
  })

  it('are never in the trail the assistant itself reads', async () => {
    const res = await runReadOnlyQuery(
      app.aiReader.pool,
      `SELECT count(*) FILTER (WHERE entity IN ('AiAssistant', 'AiAccess', 'AiReport') OR (entity = 'AppSettings' AND entity_id LIKE 'ai%'))::int AS ai, count(*)::int AS n FROM ai.audit_log`,
      { maxRows: 10, timeoutMs: 10_000, timeZone: 'Africa/Cairo' },
    )
    expect(res.ok, res.error).toBe(true)
    expect(res.rows[0][0]).toBe(0)
    expect(res.rows[0][1]).toBeGreaterThan(0)
  })

  it('never let a query’s own condition see what the trail hides, not through an error either', async () => {
    const hidden = (
      await app.db.query<{ entityId: string; oldValue: string | null; newValue: string | null }>(
        `SELECT entity_id AS "entityId", old_value AS "oldValue", new_value AS "newValue" FROM audit_log
          WHERE entity IN ('AiAssistant', 'AiAccess', 'AiReport', 'Notice', 'ChatGroup') OR (entity = 'AppSettings' AND entity_id LIKE 'ai%')`,
      )
    ).rows
    // What only the hidden entries say: the access lines with their caps, the key's label, the owner's pin.
    // Something to find: the access lines with their caps, the key's label.
    const secrets = hidden.flatMap((h) => [h.oldValue, h.newValue])
    expect(secrets.some((v) => / a month$/.test(v ?? ''))).toBe(true)
    expect(secrets.some((v) => v?.includes('LaSt'))).toBe(true)

    const pool = app.aiReader.poolFor(['audit'])
    let failed = 0
    for (const column of ['new_value', 'old_value', 'entity_id', 'field', 'entity']) {
      // Every value of the column the trail shows: an error may quote one of those, and nothing else.
      const shown = (await app.db.query<{ v: string }>(`SELECT DISTINCT ${column}::text AS v FROM ai.audit_log WHERE ${column} IS NOT NULL`)).rows.map((r) => r.v)
      for (const cast of ['date', 'uuid', 'int', 'numeric', 'timestamptz']) {
        const run = await runReadOnlyQuery(pool, `SELECT count(*) FROM ai.audit_log WHERE ${column}::${cast} IS NOT NULL`, { maxRows: 10, timeoutMs: 10_000, timeZone: 'Africa/Cairo' })
        if (run.ok) continue
        failed++
        const quoted = /"(.*)"/s.exec(run.error ?? '')
        expect(quoted, `${column}::${cast}: ${run.error}`).not.toBeNull()
        expect(shown, `${column}::${cast}`).toContain(quoted![1])
      }
    }
    expect(failed).toBeGreaterThan(0)
    // Because the view is a barrier; replaced without it by a later migration, this says so.
    const options = await app.db.query<{ options: string[] | null }>(`SELECT reloptions AS options FROM pg_class WHERE oid = 'ai.audit_log'::regclass`)
    expect(options.rows[0].options).toContain('security_barrier=true')
  })
})
