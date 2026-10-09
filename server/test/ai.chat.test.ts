import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import Anthropic from '@anthropic-ai/sdk'
import type { ApiErrorBody } from '@qc/shared/api'
import {
  AI_EXPORT_MAX_ROWS,
  AI_MODEL,
  aiCostUsd,
  type AiConversationsResponse,
  type AiMessage,
  type AiMessagesResponse,
  type AiQueryExportResponse,
  type AiQueryPart,
  type AiStatusResponse,
  type AiStreamEvent,
  type AiUsageResponse,
} from '@qc/shared/ai'
import { TestApp, type Session } from './harness'
import { apiError, fallback, runSql, text, thinking, type FakeReply } from './aiFake'
import { KEY_REFUSED_MESSAGE } from '../src/ai/assistant'

// §20 — asking: the answer streams as Server-Sent Events while the model
// writes, queries run in the sandbox and their results go back to it, and
// the conversation is stored so that the next question replays it byte for
// byte. The model is the scripted stand-in (test/aiFake.ts).

const app = new TestApp()
let admin: Session
let other: Session
const KEY = `sk-ant-api03-${'k_9-'.repeat(20)}LaSt`

interface Frame {
  event: string
  data: AiStreamEvent
}

/** The stream as frames, checking each is `event: <type>` + one `data:` line whose type matches. */
function frames(raw: string): Frame[] {
  return raw
    .split('\n\n')
    .filter((f) => f && !f.startsWith(':'))
    .map((f) => {
      const m = /^event: (\w+)\ndata: (.+)$/.exec(f)
      if (!m) throw new Error(`Not an SSE frame: ${JSON.stringify(f)}`)
      const data = JSON.parse(m[2]) as AiStreamEvent
      expect(data.type).toBe(m[1])
      return { event: m[1], data }
    })
}

async function ask(message: string, opts: { conversationId?: string; clientId?: string; as?: Session } = {}) {
  const res = await app.api<string | ApiErrorBody>('POST', '/api/ai/chat', {
    token: (opts.as ?? admin).token,
    body: { message, clientId: opts.clientId ?? randomUUID(), ...(opts.conversationId ? { conversationId: opts.conversationId } : {}) },
  })
  const events = res.status === 200 ? frames(res.body as string).map((f) => f.data) : []
  const done = events.find((e): e is Extract<AiStreamEvent, { type: 'done' }> => e.type === 'done')
  const start = events.find((e): e is Extract<AiStreamEvent, { type: 'start' }> => e.type === 'start')
  return { res, events, done, start, conversationId: start?.conversation.id ?? '' }
}

async function waitFor(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`Timed out waiting for ${what}`)
}

const last = <T>(list: T[]): T => list[list.length - 1]
const callParams = (n: number) => app.model.calls[n].params
const messagesOf = (conversationId: string) => app.api<AiMessagesResponse>('GET', `/api/ai/conversations/${conversationId}/messages`, { token: admin.token })

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  admin = await app.register('admin', 'Admin')
  await app.api('POST', '/api/users', { token: admin.token, body: { username: 'admin2', password: 'Password#1', name: 'Second Admin', role: 'admin' } })
  other = await app.login('admin2')
  for (const code of ['58', '31']) {
    const made = await app.api('POST', '/api/master/machines', { token: admin.token, body: { code, name: `Machine ${code}`, displayName: `${code}. Machine`, process: 'forming' } })
    expect(made.status).toBe(201)
  }
  const set = await app.api('PUT', '/api/ai/key', { token: admin.token, body: { apiKey: KEY } })
  expect(set.status).toBe(200)
})
afterAll(() => app.stop())
// This file asks far more questions than a person may in ten minutes; the limit itself is tested below.
beforeEach(() => app.aiLimiter.reset(admin.user.id))

// The first question of the file, and what the tests after it build on.
let first: Awaited<ReturnType<typeof ask>>
const reply1: FakeReply = {
  content: [thinking('I will count the machines in the register.'), text('Let me count the machines.'), runSql('toolu_01', 'Count the machines', 'SELECT count(*) AS machines FROM ai.machines')],
  usage: { input_tokens: 50, cache_creation_input_tokens: 7000, output_tokens: 900 },
}
const reply2: FakeReply = {
  content: [thinking('Two machines.'), text('There are **2** machines in the register.')],
  usage: { input_tokens: 30, cache_creation_input_tokens: 1200, cache_read_input_tokens: 7000, output_tokens: 600 },
}

describe('§20 asking a question', () => {
  it('validates the question before anything starts', async () => {
    for (const body of [
      { message: '   ', clientId: randomUUID() },
      { message: 'x'.repeat(4001), clientId: randomUUID() },
      { message: 'hello', clientId: 'short' },
      { message: 'hello', clientId: randomUUID(), conversationId: 'not-a-uuid' },
    ]) {
      const res = await app.api<ApiErrorBody>('POST', '/api/ai/chat', { token: admin.token, body })
      expect(res.status, JSON.stringify(body).slice(0, 60)).toBe(400)
    }
    const unknown = await ask('hello', { conversationId: randomUUID() })
    expect(unknown.res.status).toBe(404)
    expect(app.model.calls).toEqual([])
  })

  it('streams the answer, runs the query in the sandbox and feeds the result back', async () => {
    app.model.reply(reply1, reply2)
    first = await ask('How many machines are there?')
    const { res, events, done } = first
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform')
    expect(res.headers.get('x-accel-buffering')).toBe('no')
    expect(events.map((e) => e.type)).toEqual(['start', 'progress', 'text', 'text', 'query_start', 'query_end', 'progress', 'text', 'text', 'done'])
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')).toBe('Let me count the machines.There are **2** machines in the register.')
    expect(events[1]).toEqual({ type: 'progress', text: 'I will count the machines in the register.' })

    const start = first.start!
    expect(start.conversation.title).toBe('How many machines are there?')
    const queryStart = events[4] as Extract<AiStreamEvent, { type: 'query_start' }>
    expect(queryStart).toMatchObject({ purpose: 'Count the machines', sql: 'SELECT count(*) AS machines FROM ai.machines' })
    const part = (events[5] as Extract<AiStreamEvent, { type: 'query_end' }>).part
    expect(part).toMatchObject({ type: 'query', queryId: queryStart.queryId, ok: true, columns: ['machines'], rows: [[2]], rowCount: 1, truncated: false })

    // The answer as stored: the text and the query card in order; cost of both calls.
    const cost = aiCostUsd(AI_MODEL, { inputTokens: 50, outputTokens: 900, cacheWrite5mTokens: 7000, cacheWrite1hTokens: 0, cacheReadTokens: 0 })
      + aiCostUsd(AI_MODEL, { inputTokens: 30, outputTokens: 600, cacheWrite5mTokens: 1200, cacheWrite1hTokens: 0, cacheReadTokens: 7000 })
    // (100 + 9 000 + 17 500) / 1e6 + (60 + 6 000 + 3 000 + 1 400) / 1e6
    expect(cost).toBeCloseTo(0.03706, 6)
    expect(done!.message).toMatchObject({
      role: 'assistant',
      parts: [{ type: 'text', text: 'Let me count the machines.' }, part, { type: 'text', text: 'There are **2** machines in the register.' }],
      stopReason: 'end_turn',
    })
    expect(done!.message.costUsd).toBeCloseTo(cost, 6)
    expect(done!.message.notice).toBeUndefined()
    expect(done!.status).toMatchObject({ available: true })
    expect(done!.status.spentUsd).toBeCloseTo(cost, 6)
  })

  it('sends Claude exactly the request the design asks for, with the key set in the app', () => {
    expect(app.model.calls).toHaveLength(2)
    const p = callParams(0)
    expect(app.model.calls[0].apiKey).toBe(KEY)
    expect(p).toMatchObject({
      model: AI_MODEL,
      max_tokens: 32_000,
      betas: ['server-side-fallback-2026-07-01', 'thinking-binding-controls-2026-08-01'],
      fallbacks: 'default',
      // Tests run with "error": an edited history must fail loudly.
      thinking: { type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'error' } },
      output_config: { effort: 'medium' },
      cache_control: { type: 'ephemeral' },
    })
    for (const absent of ['tool_choice', 'temperature', 'top_p', 'top_k']) expect(p).not.toHaveProperty(absent)
    expect(p.system).toEqual([{ type: 'text', text: expect.stringContaining('### ai.machines'), cache_control: { type: 'ephemeral' } }])
    const system = (p.system as { text: string }[])[0].text
    expect(system).toContain('The factory\'s time zone is Africa/Cairo.')
    expect(system).not.toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/)
    expect(p.tools).toEqual([
      expect.objectContaining({ name: 'run_sql', strict: true, eager_input_streaming: true, input_schema: expect.objectContaining({ additionalProperties: false, required: ['purpose', 'sql'] }) }),
    ])
    expect(p.messages).toHaveLength(1)
    const question = p.messages[0]
    expect(question.role).toBe('user')
    const blocks = question.content as { type: string; text: string }[]
    expect(blocks[0].text).toMatch(/^<context>Today: \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(Africa\/Cairo\)<\/context>$/)
    expect(blocks[1]).toEqual({ type: 'text', text: 'How many machines are there?' })

    // The second call: the question, the answer with its tool call verbatim, and every result in one message.
    const q = callParams(1)
    expect(q.messages).toHaveLength(3)
    expect(JSON.stringify(q.messages[0])).toBe(JSON.stringify(p.messages[0]))
    expect(JSON.stringify(q.messages[1])).toBe(JSON.stringify({ role: 'assistant', content: reply1.content }))
    expect(q.messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: '{"columns":["machines"],"rows":[[2]],"rowCount":1,"truncated":false}' }],
    })
    expect(JSON.stringify(q.system)).toBe(JSON.stringify(p.system))
    expect(JSON.stringify(q.tools)).toBe(JSON.stringify(p.tools))
  })

  it('stores the transcript append-only, each message as it was sent, and every call’s cost at once', async () => {
    const id = first.conversationId
    const { rows } = await app.db.query<{ seq: number; role: string; kind: string; content: string; inReplay: boolean }>(
      `SELECT seq, role, kind, content::text AS content, in_replay AS "inReplay" FROM ai_messages WHERE conversation_id = $1 ORDER BY seq`,
      [id],
    )
    expect(rows.map((r) => [r.seq, r.role, r.kind])).toEqual([
      [1, 'user', 'question'],
      [2, 'assistant', 'assistant'],
      [3, 'user', 'tool_results'],
      [4, 'assistant', 'assistant'],
    ])
    expect(rows[0].content).toBe(JSON.stringify(callParams(1).messages[0].content))
    expect(rows[1].content).toBe(JSON.stringify(reply1.content))
    expect(rows[2].content).toBe(JSON.stringify(callParams(1).messages[2].content))
    expect(rows[3].content).toBe(JSON.stringify(reply2.content))
    // Nothing stored is ever changed or removed.
    await expect(app.db.query(`UPDATE ai_messages SET content = '[]' WHERE conversation_id = $1 AND seq = 2`, [id])).rejects.toThrow(/cannot be edited/)
    await expect(app.db.query(`DELETE FROM ai_messages WHERE conversation_id = $1`, [id])).rejects.toThrow(/never deleted/)

    const usage = await app.db.query<{ model: string; inputTokens: number; outputTokens: number; cacheWrite5m: number; cacheRead: number; costUsd: number; requestId: string; partial: boolean }>(
      `SELECT model, input_tokens AS "inputTokens", output_tokens AS "outputTokens", cache_write_5m_tokens AS "cacheWrite5m",
              cache_read_tokens AS "cacheRead", cost_usd AS "costUsd", request_id AS "requestId", partial
         FROM ai_usage WHERE conversation_id = $1 ORDER BY id`,
      [id],
    )
    expect(usage.rows).toEqual([
      { model: AI_MODEL, inputTokens: 50, outputTokens: 900, cacheWrite5m: 7000, cacheRead: 0, costUsd: 0.0266, requestId: 'req_fake_1', partial: false },
      { model: AI_MODEL, inputTokens: 30, outputTokens: 600, cacheWrite5m: 1200, cacheRead: 7000, costUsd: 0.01046, requestId: 'req_fake_2', partial: false },
    ])
    const turn = await app.db.query<{ status: string; stopReason: string; costUsd: number }>(
      `SELECT status, stop_reason AS "stopReason", cost_usd AS "costUsd" FROM ai_turns WHERE conversation_id = $1`,
      [id],
    )
    expect(turn.rows).toEqual([{ status: 'done', stopReason: 'end_turn', costUsd: 0.03706 }])
    const queries = await app.db.query(`SELECT tool_use_id, ok, row_count FROM ai_queries WHERE conversation_id = $1`, [id])
    expect(queries.rows).toEqual([{ tool_use_id: 'toolu_01', ok: true, row_count: 1 }])
  })

  it('replays the conversation byte for byte on the next question, with its own stored prompt and tools', async () => {
    const id = first.conversationId
    const before = await app.db.query<{ systemPrompt: string; tools: string }>(`SELECT system_prompt AS "systemPrompt", tools::text AS tools FROM ai_conversations WHERE id = $1`, [id])
    // The data dictionary changes after the conversation began: it keeps the prompt it started with.
    await app.db.query(`COMMENT ON VIEW ai.machines IS 'The machine register, renamed in a later migration.'`)
    app.model.reply({ content: [text('Still two.')] })
    const second = await ask('And now?', { conversationId: id })
    expect(second.done!.message.parts).toEqual([{ type: 'text', text: 'Still two.' }])

    const prior = callParams(1)
    const next = last(app.model.calls)
    expect(next.params.messages).toHaveLength(5)
    // Byte for byte: the earlier request's messages, then the answer as received, are the start of this one.
    expect(JSON.stringify(next.params.messages.slice(0, 4))).toBe(JSON.stringify([...prior.messages, { role: 'assistant', content: reply2.content }]))
    expect(next.body).toContain(JSON.stringify(prior.messages).slice(0, -1))
    expect(JSON.stringify(next.params.system)).toBe(JSON.stringify(callParams(0).system))
    expect((next.params.system as { text: string }[])[0].text).toBe(before.rows[0].systemPrompt)
    expect(JSON.stringify(next.params.tools)).toBe(before.rows[0].tools)
    expect(before.rows[0].systemPrompt).not.toContain('renamed in a later migration')

    // A new conversation takes the data dictionary as it is now.
    app.model.reply({ content: [text('Hello.')] })
    await ask('Hello')
    expect((last(app.model.calls).params.system as { text: string }[])[0].text).toContain('renamed in a later migration')
  })

  it('shows the conversation as questions and answers, as the stream ended them', async () => {
    const res = await messagesOf(first.conversationId)
    expect(res.status).toBe(200)
    expect(res.body.conversation).toMatchObject({ id: first.conversationId, title: 'How many machines are there?' })
    const roles = res.body.messages.map((m) => m.role)
    expect(roles).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(res.body.messages[0]).toMatchObject({ id: first.start!.userMessageId, parts: [{ type: 'text', text: 'How many machines are there?' }] })
    expect(res.body.messages[1]).toEqual(first.done!.message)
    const list = await app.api<AiConversationsResponse>('GET', '/api/ai/conversations', { token: admin.token })
    expect(list.body.conversations.map((c) => c.title)).toEqual(['Hello', 'How many machines are there?'])
    expect(list.body.hasMore).toBe(false)
  })

  it('asks a question once for one client id', async () => {
    const clientId = randomUUID()
    app.model.reply({ content: [text('Once.')] })
    expect((await ask('Once?', { conversationId: first.conversationId, clientId })).res.status).toBe(200)
    const calls = app.model.calls.length
    const again = await ask('Once?', { conversationId: first.conversationId, clientId })
    expect(again.res.status).toBe(409)
    expect((again.res.body as ApiErrorBody).error).toMatchObject({ code: 'conflict', message: 'This question was already sent.' })
    expect(app.model.calls).toHaveLength(calls)
  })
})

describe('§20 one answer at a time', () => {
  it('refuses a second question while the first is being answered, and takes it once the first is done', async () => {
    let release!: () => void
    app.model.reply({ content: [text('Working on it.')], hold: new Promise<void>((r) => (release = r)) })
    const calls = app.model.calls.length
    const pending = ask('A slow one', { conversationId: first.conversationId })
    await waitFor(() => app.model.calls.length > calls, 'the first question to reach the model')
    const second = await ask('Another', { conversationId: first.conversationId })
    expect(second.res.status).toBe(409)
    expect((second.res.body as ApiErrorBody).error.message).toMatch(/Still answering/)
    release()
    expect((await pending).done!.message.parts).toEqual([{ type: 'text', text: 'Working on it.' }])
    app.model.reply({ content: [text('Now.')] })
    expect((await ask('Another', { conversationId: first.conversationId })).res.status).toBe(200)
  })

  it('closes an answer a restart cut off, when the next question comes', async () => {
    const stale = await app.db.query<{ id: string }>(
      `INSERT INTO ai_turns (conversation_id, user_id, client_id, question, created_at) VALUES ($1, $2, $3, 'cut off', now() - interval '7 minutes') RETURNING id`,
      [first.conversationId, admin.user.id, randomUUID()],
    )
    app.model.reply({ content: [text('Here.')] })
    expect((await ask('After a restart', { conversationId: first.conversationId })).res.status).toBe(200)
    const { rows } = await app.db.query(`SELECT status, stop_reason, notice FROM ai_turns WHERE id = $1`, [stale.rows[0].id])
    expect(rows[0]).toMatchObject({ status: 'done', stop_reason: 'error', notice: expect.stringMatching(/restarted/) })
  })

  it('stops when the asker leaves: the call is aborted, its usage recorded, the turn closed', async () => {
    app.model.reply({ content: [text('Counting every sample ever recorded')], usage: { input_tokens: 4000 }, hold: new Promise(() => undefined) })
    const ac = new AbortController()
    const res = await fetch(`${app.baseUrl}/api/ai/chat`, {
      method: 'POST',
      headers: { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Count everything', clientId: randomUUID() }),
      signal: ac.signal,
    })
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    let seen = ''
    while (!seen.includes('event: text')) seen += new TextDecoder().decode((await reader.read()).value)
    ac.abort()
    const turn = async () =>
      (await app.db.query<{ status: string; stop_reason: string; id: string }>(`SELECT id, status, stop_reason FROM ai_turns WHERE question = 'Count everything'`)).rows[0]
    await waitFor(async () => (await turn())?.status === 'done', 'the stopped turn to close')
    const t = await turn()
    expect(t.stop_reason).toBe('stopped')
    const usage = await app.db.query(`SELECT input_tokens, output_tokens, partial FROM ai_usage WHERE turn_id = $1`, [t.id])
    // Output: at least half a token per streamed character.
    expect(usage.rows).toEqual([{ input_tokens: 4000, output_tokens: Math.ceil('Counting every sample ever recorded'.length / 2), partial: true }])
    // Nothing of the cut-off answer is in the replay.
    const kinds = await app.db.query(`SELECT kind FROM ai_messages WHERE turn_id = $1`, [t.id])
    expect(kinds.rows).toEqual([{ kind: 'question' }])
  })
})

describe('§20 how answers end', () => {
  it('keeps a refused answer for display but never sends it again', async () => {
    app.model.reply({ content: [text('I cannot help with that.')], stopReason: 'refusal', stopDetails: { category: 'general_harms', explanation: null } as Anthropic.Beta.BetaRefusalStopDetails })
    const refused = await ask('Something it declines')
    expect(refused.done!.message).toMatchObject({ stopReason: 'refusal', parts: [{ type: 'text', text: 'I cannot help with that.' }] })
    expect(refused.done!.message.notice).toMatch(/declined to answer this \(general harms\)/)
    const stored = await app.db.query(`SELECT in_replay FROM ai_messages WHERE conversation_id = $1 AND role = 'assistant'`, [refused.conversationId])
    expect(stored.rows).toEqual([{ in_replay: false }])

    app.model.reply({ content: [text('Sure.')] })
    await ask('Something else', { conversationId: refused.conversationId })
    const sent = last(app.model.calls).params.messages
    expect(sent.map((m) => m.role)).toEqual(['user', 'user'])
    expect(JSON.stringify(sent)).not.toContain('I cannot help with that.')
    // Still shown.
    const shown = await messagesOf(refused.conversationId)
    expect(shown.body.messages.map((m) => m.stopReason ?? m.role)).toEqual(['user', 'refusal', 'user', 'end_turn'])
  })

  it('answers a bad tool call with an error instead of running it, and passes query errors back', async () => {
    app.model.reply(
      {
        content: [
          { type: 'tool_use', id: 'toolu_bad', name: 'run_sql', input: { purpose: 'No SQL' } } as Anthropic.Beta.BetaContentBlock,
          { type: 'tool_use', id: 'toolu_other', name: 'drop_everything', input: {} } as Anthropic.Beta.BetaContentBlock,
          { type: 'tool_use', id: 'toolu_case', name: 'Run_SQL', input: { purpose: 'Users', sql: 'SELECT name FROM public.users' } } as Anthropic.Beta.BetaContentBlock,
        ],
      },
      { content: [text('I could not read that.')] },
    )
    const res = await ask('Try odd tools')
    const results = last(app.model.calls).params.messages[2].content as Anthropic.Beta.BetaToolResultBlockParam[]
    expect(results).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu_bad', is_error: true, content: JSON.stringify({ INVALID_JSON: JSON.stringify({ purpose: 'No SQL' }) }) },
      { type: 'tool_result', tool_use_id: 'toolu_other', is_error: true, content: 'Unknown tool "drop_everything". The only tool is "run_sql".' },
      { type: 'tool_result', tool_use_id: 'toolu_case', is_error: true, content: expect.stringMatching(/permission denied/) },
    ])
    const parts = res.done!.message.parts.filter((p): p is AiQueryPart => p.type === 'query')
    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatchObject({ ok: false, purpose: 'Users', error: expect.stringMatching(/permission denied/), rows: [], columns: [] })
  })

  it('never runs a tool call cut off at max_tokens: asks again once with more room, without editing the history', async () => {
    app.model.reply(
      { content: [runSql('toolu_cut', 'Cut', 'SELECT 1 AS one')], stopReason: 'max_tokens' },
      { content: [runSql('toolu_full', 'Full', 'SELECT 1 AS one')] },
      { content: [text('One.')] },
    )
    const calls = app.model.calls.length
    const res = await ask('Big answer')
    const mine = app.model.calls.slice(calls)
    expect(mine.map((c) => c.params.max_tokens)).toEqual([32_000, 64_000, 64_000])
    expect(JSON.stringify(mine[1].params.messages)).toBe(JSON.stringify(mine[0].params.messages))
    const queries = await app.db.query(`SELECT tool_use_id FROM ai_queries WHERE conversation_id = $1`, [res.conversationId])
    expect(queries.rows).toEqual([{ tool_use_id: 'toolu_full' }])
    expect(res.done!.message.stopReason).toBe('end_turn')
  })

  it('replays a fallback answer by the API’s rule and prices each attempt at its own model', async () => {
    const content = [
      thinking('First model thinking.'),
      text('Partly written, '),
      fallback(AI_MODEL, 'claude-sonnet-5'),
      thinking('Second model thinking.'),
      text('finished by the fallback.'),
    ]
    app.model.reply({
      content,
      model: 'claude-sonnet-5',
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        iterations: [
          { type: 'message', model: null, input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null },
          { type: 'fallback_message', model: 'claude-sonnet-5', input_tokens: 1000, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null },
        ],
      },
    })
    const res = await ask('Something that falls back')
    expect(res.done!.message.parts).toEqual([{ type: 'text', text: 'Partly written, finished by the fallback.' }])
    const stored = await app.db.query<{ content: unknown[]; raw: unknown[]; model: string }>(
      `SELECT content, raw_content AS raw, model FROM ai_messages WHERE conversation_id = $1 AND role = 'assistant'`,
      [res.conversationId],
    )
    // Before the hand-over only the text (and the marker) is echoed.
    expect(stored.rows[0].content).toEqual(content.slice(1))
    expect(stored.rows[0].raw).toEqual(content)
    expect(stored.rows[0].model).toBe('claude-sonnet-5')
    const usage = await app.db.query(`SELECT model, input_tokens, output_tokens, cost_usd FROM ai_usage WHERE conversation_id = $1`, [res.conversationId])
    expect(usage.rows).toEqual([{ model: 'claude-sonnet-5', input_tokens: 2000, output_tokens: 400, cost_usd: (2000 * 2 + 400 * 10) / 1_000_000 }])
    app.model.reply({ content: [text('Next.')] })
    await ask('Go on', { conversationId: res.conversationId })
    expect(JSON.stringify(last(app.model.calls).params.messages[1])).toBe(JSON.stringify({ role: 'assistant', content: content.slice(1) }))
  })

  it('stops at the monthly cap before a call that could pass it, keeping what was answered', async () => {
    const before = (await app.api<AiStatusResponse>('GET', '/api/ai/status', { token: admin.token })).body
    const cap = Math.ceil((before.spentUsd + 1) * 100) / 100
    await app.api('PUT', '/api/ai/settings', { token: admin.token, body: { enabled: true, monthlyCapUsd: cap } })
    try {
      app.model.reply({ content: [runSql('toolu_cap', 'Count', 'SELECT count(*) AS n FROM ai.users')], usage: { input_tokens: 1000, output_tokens: 80_000 } })
      const res = await ask('An expensive question')
      expect(res.done!.message.stopReason).toBe('cap')
      expect(res.done!.message.notice).toMatch(/spending cap \(\$\d+\.\d\d\) would be passed/)
      expect(res.done!.message.parts).toEqual([expect.objectContaining({ type: 'query', ok: true, rows: [[2]] })])
      expect(app.model.pending).toBe(0)
      // The tool call and its result were stored together: the transcript can go on.
      const kinds = await app.db.query(`SELECT kind FROM ai_messages WHERE conversation_id = $1 ORDER BY seq`, [res.conversationId])
      expect(kinds.rows.map((r) => r.kind)).toEqual(['question', 'assistant', 'tool_results'])
    } finally {
      await app.api('PUT', '/api/ai/settings', { token: admin.token, body: { enabled: true, monthlyCapUsd: 50 } })
    }
  })

  it('reports Anthropic’s errors as a short error event and closes the turn', async () => {
    const cases: [FakeReply, string, string | RegExp][] = [
      [{ error: apiError(401, 'invalid x-api-key') }, 'ai_unavailable', KEY_REFUSED_MESSAGE],
      [{ error: apiError(429, 'rate limited') }, 'rate_limited', 'Claude is busy right now — try again in a minute.'],
      [{ error: apiError(400, 'messages: bad thing') }, 'internal', /could not take this request/],
      [{ content: [text('Half an ans')], error: apiError(500, 'boom') }, 'internal', /had a problem answering/],
    ]
    for (const [reply, code, message] of cases) {
      app.model.reply(reply)
      const res = await ask(`Fails with ${code}`)
      expect(res.res.status).toBe(200)
      const error = last(res.events)
      expect(error).toMatchObject({ type: 'error', code })
      expect((error as { message: string }).message).toEqual(typeof message === 'string' ? message : expect.stringMatching(message))
      expect(JSON.stringify(res.events)).not.toContain('invalid x-api-key')
      const turn = await app.db.query(`SELECT status, stop_reason FROM ai_turns WHERE conversation_id = $1`, [res.conversationId])
      expect(turn.rows).toEqual([{ status: 'done', stop_reason: 'error' }])
    }
  })

  it('tries once more when an open stream reports the API overloaded', async () => {
    const overloaded = new Anthropic.APIError(undefined, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 'Overloaded', undefined, 'overloaded_error')
    app.model.reply({ content: [text('Sta')], error: overloaded }, { content: [text('Answered.')] })
    const res = await ask('Busy moment')
    expect(res.done!.message.parts).toEqual([{ type: 'text', text: 'Answered.' }])
    const usage = await app.db.query(`SELECT partial FROM ai_usage WHERE conversation_id = $1 ORDER BY id`, [res.conversationId])
    expect(usage.rows).toEqual([{ partial: true }, { partial: false }])
  })
})

describe('§20 the loop’s guards', () => {
  it('answers a tool call left without its result (a crash) as interrupted before the next question — appended, not edited', async () => {
    app.model.reply({ content: [text('Fine.')] })
    const res = await ask('Start')
    const turn = await app.db.query<{ id: string }>(`SELECT id FROM ai_turns WHERE conversation_id = $1`, [res.conversationId])
    // What a crash between an answer and its results would leave behind.
    await app.db.query(
      `INSERT INTO ai_messages (conversation_id, turn_id, seq, role, kind, content) VALUES ($1, $2, 3, 'assistant', 'assistant', $3::json)`,
      [res.conversationId, turn.rows[0].id, JSON.stringify([runSql('toolu_lost', 'Lost', 'SELECT 1')])],
    )
    app.model.reply({ content: [text('Back.')] })
    await ask('Again', { conversationId: res.conversationId })
    const sent = last(app.model.calls).params.messages
    expect(sent.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant', 'user', 'user'])
    expect(sent[3].content).toEqual([{ type: 'tool_result', tool_use_id: 'toolu_lost', is_error: true, content: 'Interrupted: no result was recorded.' }])
    const kinds = await app.db.query(`SELECT kind FROM ai_messages WHERE conversation_id = $1 ORDER BY seq`, [res.conversationId])
    expect(kinds.rows.map((r) => r.kind)).toEqual(['question', 'assistant', 'assistant', 'repair', 'question', 'assistant'])
  })

  it('carries on after pause_turn without a new message, and stops when the context window is full', async () => {
    app.model.reply({ content: [text('Part one, ')], stopReason: 'pause_turn' }, { content: [text('part two.')] })
    const calls = app.model.calls.length
    const paused = await ask('A long one')
    expect(paused.done!.message).toMatchObject({ stopReason: 'end_turn', parts: [{ type: 'text', text: 'Part one, part two.' }] })
    const resumed = app.model.calls[calls + 1].params.messages
    expect(resumed.map((m) => m.role)).toEqual(['user', 'assistant'])

    app.model.reply({ content: [text('So much')], stopReason: 'model_context_window_exceeded' })
    const full = await ask('More', { conversationId: paused.conversationId })
    expect(full.done!.message).toMatchObject({ stopReason: 'limit', notice: 'This conversation is too long to go on. Start a new one.' })
  })

  it('stops after ten calls to the model for one question', async () => {
    for (let i = 0; i < 10; i++) app.model.reply({ content: [runSql(`toolu_loop_${i}`, `Step ${i}`, `SELECT ${i} AS step`)] })
    const calls = app.model.calls.length
    const res = await ask('Never satisfied')
    expect(app.model.calls.length - calls).toBe(10)
    expect(res.done!.message.stopReason).toBe('limit')
    expect(res.done!.message.notice).toMatch(/more steps than one answer may take/)
    expect(res.done!.message.parts.filter((p) => p.type === 'query')).toHaveLength(10)
  })

  it('asks again when the tool input could not be parsed at all, recording what the failed call used', async () => {
    app.model.reply(
      { content: [text('Let me')], error: new Anthropic.AnthropicError('Unable to parse tool parameter JSON from model.') },
      { content: [text('Answered after a retry.')] },
    )
    const res = await ask('Parse trouble')
    expect(res.done!.message.parts).toEqual([{ type: 'text', text: 'Answered after a retry.' }])
    const usage = await app.db.query(`SELECT partial FROM ai_usage WHERE conversation_id = $1 ORDER BY id`, [res.conversationId])
    expect(usage.rows).toEqual([{ partial: true }, { partial: false }])
  })
})

describe('§20 conversations are personal', () => {
  it('hides one administrator’s conversations from another', async () => {
    const id = first.conversationId
    expect((await app.api('GET', `/api/ai/conversations/${id}/messages`, { token: other.token })).status).toBe(404)
    expect((await app.api('DELETE', `/api/ai/conversations/${id}`, { token: other.token })).status).toBe(404)
    expect((await ask('Mine now?', { conversationId: id, as: other })).res.status).toBe(404)
    const part = first.done!.message.parts.find((p): p is AiQueryPart => p.type === 'query')!
    expect((await app.api('GET', `/api/ai/queries/${part.queryId}/export`, { token: other.token })).status).toBe(404)
    const list = await app.api<AiConversationsResponse>('GET', '/api/ai/conversations', { token: other.token })
    expect(list.body.conversations).toEqual([])
  })

  it('pages the list by the latest message', async () => {
    const all = await app.api<AiConversationsResponse>('GET', '/api/ai/conversations', { token: admin.token })
    expect(all.body.conversations.length).toBeGreaterThan(3)
    const page = await app.api<AiConversationsResponse>('GET', '/api/ai/conversations?limit=2', { token: admin.token })
    expect(page.body.hasMore).toBe(true)
    expect(page.body.conversations).toEqual(all.body.conversations.slice(0, 2))
    const before = encodeURIComponent(page.body.conversations[1].lastMessageAt)
    const next = await app.api<AiConversationsResponse>('GET', `/api/ai/conversations?limit=2&before=${before}`, { token: admin.token })
    expect(next.body.conversations).toEqual(all.body.conversations.slice(2, 4))
  })

  it('deletes a conversation from the list, keeping its record', async () => {
    app.model.reply({ content: [text('Bye.')] })
    const res = await ask('To be deleted')
    expect((await app.api('DELETE', `/api/ai/conversations/${res.conversationId}`, { token: admin.token })).status).toBe(204)
    expect((await messagesOf(res.conversationId)).status).toBe(404)
    expect((await ask('Back?', { conversationId: res.conversationId })).res.status).toBe(404)
    const list = await app.api<AiConversationsResponse>('GET', '/api/ai/conversations', { token: admin.token })
    expect(list.body.conversations.map((c) => c.id)).not.toContain(res.conversationId)
    const kept = await app.db.query(`SELECT deleted_at IS NOT NULL AS deleted FROM ai_conversations WHERE id = $1`, [res.conversationId])
    expect(kept.rows).toEqual([{ deleted: true }])
    await expect(app.db.query(`DELETE FROM ai_conversations WHERE id = $1`, [res.conversationId])).rejects.toThrow(/Hard delete is not allowed/)
  })
})

describe('§20 Excel and usage', () => {
  it('exports a query by running it again now, in full', async () => {
    const part = first.done!.message.parts.find((p): p is AiQueryPart => p.type === 'query')!
    const now = await app.api<AiQueryExportResponse>('GET', `/api/ai/queries/${part.queryId}/export`, { token: admin.token })
    expect(now.status).toBe(200)
    expect(now.body).toMatchObject({ purpose: 'Count the machines', sql: 'SELECT count(*) AS machines FROM ai.machines', columns: ['machines'], rows: [[2]], truncated: false })
    expect(Date.now() - Date.parse(now.body.ranAt)).toBeLessThan(60_000)
    await app.api('POST', '/api/master/machines', { token: admin.token, body: { code: '77', name: 'Machine 77', displayName: '77. Paint', process: 'paint' } })
    const later = await app.api<AiQueryExportResponse>('GET', `/api/ai/queries/${part.queryId}/export`, { token: admin.token })
    expect(later.body.rows).toEqual([[3]])
    expect((await app.api('GET', `/api/ai/queries/${randomUUID()}/export`, { token: admin.token })).status).toBe(404)

    // The full result, up to the export's own cap.
    app.model.reply({ content: [runSql('toolu_many', 'Many rows', 'SELECT g FROM generate_series(1, 50001) g')] }, { content: [text('Lots.')] })
    const res = await ask('Many rows please')
    const many = res.done!.message.parts.find((p): p is AiQueryPart => p.type === 'query')!
    expect(many).toMatchObject({ rowCount: 200, truncated: true })
    const full = await app.api<AiQueryExportResponse>('GET', `/api/ai/queries/${many.queryId}/export`, { token: admin.token })
    expect(full.body.rows).toHaveLength(AI_EXPORT_MAX_ROWS)
    expect(full.body.truncated).toBe(true)
    expect(full.body.rows[AI_EXPORT_MAX_ROWS - 1]).toEqual([AI_EXPORT_MAX_ROWS])
  })

  it('reports the month’s usage by day and by person', async () => {
    const res = await app.api<AiUsageResponse>('GET', '/api/ai/usage', { token: admin.token })
    expect(res.status).toBe(200)
    const totals = (
      await app.db.query<{ spent: number; calls: number; input: number; output: number }>(
        `SELECT sum(cost_usd)::numeric(14, 6) AS spent, count(*)::int AS calls, sum(input_tokens)::int AS input, sum(output_tokens)::int AS output FROM ai_usage`,
      )
    ).rows[0]
    const questions = (await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ai_turns`)).rows[0].n
    const month = new Date().toISOString().slice(0, 7)
    expect(res.body).toMatchObject({ month, spentUsd: totals.spent, capUsd: 50, calls: totals.calls, questions, inputTokens: totals.input, outputTokens: totals.output })
    expect(res.body.cacheReadTokens).toBe(7000)
    expect(res.body.cacheWriteTokens).toBe(8200)
    expect(res.body.byDay).toEqual([{ day: new Date().toISOString().slice(0, 10), costUsd: totals.spent, calls: totals.calls }])
    expect(res.body.byUser).toEqual([{ userId: admin.user.id, userName: 'Admin', costUsd: totals.spent, questions: expect.any(Number) }])
    const empty = await app.api<AiUsageResponse>('GET', '/api/ai/usage?month=2020-01', { token: admin.token })
    expect(empty.body).toMatchObject({ month: '2020-01', spentUsd: 0, calls: 0, questions: 0, byDay: [], byUser: [] })
    expect((await app.api('GET', '/api/ai/usage?month=2020-13', { token: admin.token })).status).toBe(400)
  })

  it('limits how many questions one person sends in a short time', async () => {
    // With no key every question is refused, but each one still counts.
    await app.api('POST', '/api/users', { token: admin.token, body: { username: 'admin3', password: 'Password#1', name: 'Third Admin', role: 'admin' } })
    const third = await app.login('admin3')
    await app.api('DELETE', '/api/ai/key', { token: admin.token })
    try {
      const statuses: number[] = []
      for (let i = 0; i < 31; i++) statuses.push((await ask(`Question ${i}`, { as: third })).res.status)
      expect(statuses.slice(0, 30).every((s) => s === 503)).toBe(true)
      expect(statuses[30]).toBe(429)
    } finally {
      await app.api('PUT', '/api/ai/key', { token: admin.token, body: { apiKey: KEY } })
    }
  })
})

describe('§20 the answer as stored', () => {
  it('reads back the same messages the stream delivered', async () => {
    const res = await messagesOf(first.conversationId)
    const answers = res.body.messages.filter((m: AiMessage) => m.role === 'assistant')
    expect(answers.find((m) => m.id === first.done!.message.id)).toEqual(first.done!.message)
    expect(answers.every((m) => m.stopReason && typeof m.costUsd === 'number')).toBe(true)
  })
})
