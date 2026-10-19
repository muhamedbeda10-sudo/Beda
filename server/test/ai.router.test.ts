import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import Anthropic from '@anthropic-ai/sdk'
import { AI_ROUTER_FALLBACK, type AiAccess } from '@qc/shared/ai'
import type { ApiErrorBody } from '@qc/shared/api'
import { ROUTER_SYSTEM, chooseLevel, describeFiles, readRouterReply, routerRequest } from '../src/ai/router'
import type { ModelMessage } from '../src/ai/model'
import { worstCaseUsd } from '../src/ai/models'
import { ScriptedModel, text } from './aiFake'
import { TestApp, type Session } from './harness'

// §20 — a chat question's level, standard (Sonnet) or deep (Opus), read by Sonnet before it is answered: its call
// held against the caps like any other.

const message = (t: string) => ({ content: [text(t)] }) as unknown as ModelMessage
const app = new TestApp()
let owner: Session
let insp: Session
const KEY = `sk-ant-api03-${'r_3-'.repeat(20)}RoUt`
const asker = () => ({ db: app.db, userId: insp.user.id })
const holds = async () => (await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ai_usage_holds WHERE user_id = $1`, [insp.user.id])).rows[0].n
const spent = async () => Number((await app.db.query<{ n: number }>(`SELECT COALESCE(sum(cost_usd), 0)::float8 AS n FROM ai_usage WHERE user_id = $1`, [insp.user.id])).rows[0].n)
async function grant(capUsd: number): Promise<void> {
  const res = await app.api<AiAccess>('PUT', `/api/ai/access/${insp.user.id}`, {
    token: owner.token,
    body: { enabled: true, domains: ['inspection'], monthlyCapUsd: Math.floor(capUsd * 100) / 100 },
  })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
}

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  owner = await app.register('admin', 'Owner Admin')
  expect((await app.api('POST', '/api/users', { token: owner.token, body: { username: 'insp', password: 'Password#1', name: 'Inspector One', role: 'inspector' } })).status).toBe(201)
  insp = await app.login('insp')
  expect((await app.api('PUT', '/api/ai/key', { token: owner.token, body: { apiKey: KEY } })).status).toBe(200)
  await grant(50)
})
afterAll(() => app.stop())

describe('§20 the router', () => {
  it('asks Sonnet, without thinking, in a fixed shape, with the files the question carries and the question before for a follow-up', () => {
    const first = routerRequest({ question: '  How many   coils were held?  ' })
    expect(first).toMatchObject({ model: 'claude-sonnet-5-5', max_tokens: 300, system: ROUTER_SYSTEM, output_config: { format: { type: 'json_schema' } } })
    // Said outright: on Sonnet 5.5 a request silent about thinking thinks, and spends the reply's few tokens on it.
    expect(first.thinking).toEqual({ type: 'between_tools' })
    // Structured outputs are generally available: no beta header.
    expect(first).not.toHaveProperty('betas')
    expect(first.messages).toEqual([{ role: 'user', content: 'The question to sort:\nHow many coils were held?' }])
    const next = routerRequest({ question: 'And last month?', previous: { question: 'Trend of rejects by machine', level: 'chat-analysis' } })
    expect(next.messages[0].content).toBe('The question before it in this conversation (answered as analysis):\nTrend of rejects by machine\n\nThe question to sort:\nAnd last month?')
    const deep = routerRequest({ question: 'Why?', previous: { question: 'Root cause of the holds', level: 'chat-deep' } })
    expect(deep.messages[0].content).toMatch(/^The question before it in this conversation \(answered as deep analysis\):/)
    const withFiles = routerRequest({ question: 'What does this say?', files: ['image', 'pdf', 'image'] })
    expect(withFiles.messages[0].content).toBe('The question to sort:\nWhat does this say?\n\nIt carries 2 photos and a PDF.')
    expect(routerRequest({ question: '', files: ['sheet'] }).messages[0].content).toBe('The question to sort:\n(no words)\n\nIt carries a spreadsheet.')
    // A very long question: its start is enough, and the call stays cheap.
    expect(String(routerRequest({ question: 'x'.repeat(10_000) }).messages[0].content).length).toBeLessThan(2_100)
  })

  it('reads the level and why, and nothing else', () => {
    expect(readRouterReply(message('{"level":"deep","reason":"  Root cause\\nacross lines. "}'))).toEqual({ level: 'chat-deep', reason: 'Root cause across lines.' })
    expect(readRouterReply(message('{"level":"standard","reason":""}'))).toEqual({ level: 'chat-standard', reason: null })
    for (const bad of ['{"level":"simple","reason":"x"}', '{"level":"analysis","reason":"x"}', '{"level":"files","reason":"x"}', '{"reason":"x"}', 'deep', '']) expect(readRouterReply(message(bad)), bad).toBeNull()
  })

  it('never stands in the answer’s way: a failure or an unreadable reply is the standard level, with no reason', async () => {
    const model = new ScriptedModel()
    model.completeWith = () => '{"level":"deep","reason":"A root cause."}'
    expect(await chooseLevel({ model, apiKey: 'k', question: 'Why?', asker: asker() })).toMatchObject({ level: 'chat-deep', reason: 'A root cause.' })
    model.completeWith = () => 'not json'
    const unreadable = await chooseLevel({ model, apiKey: 'k', question: 'How many?', asker: asker() })
    expect(unreadable).toMatchObject({ level: AI_ROUTER_FALLBACK, reason: null })
    // Its call still came back, to be billed.
    expect(unreadable.message).not.toBeNull()
    model.completeWith = () => {
      throw new Error('overloaded')
    }
    expect(await chooseLevel({ model, apiKey: 'k', question: 'How many?', asker: asker() })).toEqual({ level: AI_ROUTER_FALLBACK, reason: null, message: null, holdId: null })
    // The asker gone: stopped with the rest.
    const gone = new AbortController()
    gone.abort()
    model.completeWith = () => '{"level":"deep","reason":"x"}'
    expect((await chooseLevel({ model, apiKey: 'k', question: 'Why?', signal: gone.signal, asker: asker() })).message).toBeNull()
  })

  it('falls back, and says why in the log, when the reply ran out before it named a level', async () => {
    // What the router got on a hard question while it thought: all its tokens on thinking, no level written.
    const model = new ScriptedModel()
    model.complete = async () =>
      ({ content: [{ type: 'thinking', thinking: '', signature: 's' }], stop_reason: 'max_tokens', usage: { input_tokens: 400, output_tokens: 300 } }) as unknown as ModelMessage
    const warnings: string[] = []
    const warn = console.warn
    console.warn = (...a: unknown[]) => void warnings.push(a.join(' '))
    try {
      expect(await chooseLevel({ model, apiKey: 'k', question: 'Root cause of the welding defects this quarter?', asker: asker() })).toMatchObject({ level: AI_ROUTER_FALLBACK, reason: null })
    } finally {
      console.warn = warn
    }
    expect(warnings.join('\n')).toContain('stop: max_tokens')
  })

  it('is held against the caps like any call: never the call that passes one, its hold settled to what it cost', async () => {
    await app.db.query(`DELETE FROM ai_usage_holds`)
    const model = new ScriptedModel()
    model.completeWith = () => '{"level":"standard","reason":"A count."}'
    const worst = worstCaseUsd(routerRequest({ question: 'How many?' }))
    // Room for less than the router's call: it is not made, and the question goes on to its own check.
    await grant(1)
    await app.db.query(`INSERT INTO ai_usage (user_id, model, output_tokens, cost_usd) VALUES ($1, 'claude-haiku-5-5', 0, $2)`, [insp.user.id, 1 - (await spent()) - worst / 2])
    expect(await chooseLevel({ model, apiKey: 'k', question: 'How many?', asker: asker() })).toEqual({ level: AI_ROUTER_FALLBACK, reason: null, message: null, holdId: null })
    expect(model.completions).toHaveLength(0)
    expect(await holds()).toBe(0)
    // Room enough: made under a hold, which the caller settles with the cost.
    await grant(50)
    const routed = await chooseLevel({ model, apiKey: 'k', question: 'How many?', asker: asker() })
    expect(routed).toMatchObject({ level: 'chat-standard', holdId: expect.any(String) })
    expect(await holds()).toBe(1)
    await app.db.query(`DELETE FROM ai_usage_holds`)
    // Out of time once sent: counted at its worst, the hold settled with it; refused by Anthropic: let go, nothing counted.
    const before = await spent()
    model.completeWith = () => {
      throw new Anthropic.APIUserAbortError()
    }
    await chooseLevel({ model, apiKey: 'k', question: 'How many?', asker: asker() })
    expect(await spent()).toBeGreaterThan(before)
    expect(await holds()).toBe(0)
    const after = await spent()
    model.completeWith = () => {
      throw new Error('overloaded')
    }
    await chooseLevel({ model, apiKey: 'k', question: 'How many?', asker: asker() })
    expect(await spent()).toBe(after)
    expect(await holds()).toBe(0)

    // Through the chat: the router's cost is kept with the question, and no hold is left behind.
    app.model.reset()
    app.model.completeWith = (params) => {
      if (params.system !== ROUTER_SYSTEM) throw new Anthropic.APIConnectionError({ message: 'Not scripted in this test.' })
      return '{"level":"standard","reason":"A count."}'
    }
    app.model.reply({ content: [text('Two.')] })
    const res = await app.api<string | ApiErrorBody>('POST', '/api/ai/chat', { token: insp.token, body: { message: 'How many machines?', clientId: randomUUID() } })
    expect(res.status).toBe(200)
    expect(await holds()).toBe(0)
    const router = await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ai_usage WHERE user_id = $1 AND turn_id IS NOT NULL AND output_tokens = 8`, [insp.user.id])
    expect(router.rows[0].n).toBe(1)
  })

  it('names the files by kind', () => {
    expect(describeFiles(['pdf'])).toBe('a PDF')
    expect(describeFiles(['sheet', 'sheet', 'image', 'pdf'])).toBe('2 spreadsheets, a photo and a PDF')
  })
})
