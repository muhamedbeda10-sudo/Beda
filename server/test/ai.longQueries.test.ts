import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type Anthropic from '@anthropic-ai/sdk'
import { AI_PREVIEW_ROWS, type AiStreamEvent } from '@qc/shared/ai'
import { TestApp, type Session } from './harness'
import { text } from './aiFake'
import { LONG_QUERY_LINE, TIMEOUT_ADVICE } from '../src/ai/assistant'
import { AI_CHAT_LIMITS, AI_QUERY_STOPPED, LONG_QUERY_BUSY, describePlan, planSummary, runReadOnlyQuery, type RunOptions } from '../src/ai/runQuery'

// §20 — a question that needs the whole record: a query stopped for time says
// where its time went, and one that truly needs it all runs as a long
// analysis (run_sql with long), up to 10 minutes, one at a time across the app.

const app = new TestApp()
let admin: Session
const chat: RunOptions = { maxRows: AI_PREVIEW_ROWS, timeoutMs: 10_000, timeZone: 'Africa/Cairo', ...AI_CHAT_LIMITS }
const SLOW = 'SELECT count(*) AS n FROM generate_series(1, 100000) a, generate_series(1, 100000) b'
const longSql = (id: string, purpose: string, sql: string) => ({ type: 'tool_use', id, name: 'run_sql', input: { purpose, sql, long: true } }) as unknown as Anthropic.Beta.BetaContentBlock

async function waitFor(check: () => Promise<boolean>, what: string, ms = 5000): Promise<void> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`Timed out waiting for ${what}`)
}

const longRunning = async () =>
  (await app.db.query(`SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database()) AND granted AND objid = 20620001`)).rowCount === 1

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  admin = await app.register('admin', 'Admin')
  expect((await app.api('PUT', '/api/ai/key', { token: admin.token, body: { apiKey: `sk-ant-api03-${'k_9-'.repeat(20)}LaSt` } })).status).toBe(200)
})
afterAll(() => app.stop())

describe('§20 where a slow query’s time goes', () => {
  it('names the largest tables a plan reads, in the views’ words, whole or not, and the subqueries it works out row by row', () => {
    const plan = {
      'Node Type': 'Hash Join',
      Plans: [
        { 'Node Type': 'Seq Scan', 'Relation Name': 'dimension_results', 'Plan Rows': 1_800_000 },
        { 'Node Type': 'Index Scan', 'Relation Name': 'inspection_samples', 'Plan Rows': 150_000 },
        { 'Node Type': 'Seq Scan', 'Relation Name': 'machines', 'Plan Rows': 30 },
        { 'Node Type': 'Aggregate', 'Parent Relationship': 'SubPlan', Plans: [{ 'Node Type': 'Index Scan', 'Relation Name': 'defect_results', 'Plan Rows': 3 }] },
      ],
    }
    expect(describePlan(plan)).toBe(
      "PostgreSQL's plan for it reads about 1,800,000 dimension measurements (all of them) and about 150,000 samples, and works out 1 subquery row by row.",
    )
    expect(describePlan({ 'Node Type': 'Result' })).toBeNull()
  })

  it('plans a query as the reader, without running it, and gives nothing for one it cannot plan', async () => {
    const summary = await planSummary(app.aiReader.pool, 'SELECT count(*) FROM generate_series(1, 10) g', { timeZone: 'Africa/Cairo' })
    expect(summary).toBeNull()
    expect(await planSummary(app.aiReader.pool, 'SELECT * FROM public.users', { timeZone: 'Africa/Cairo' })).toBeNull()
    expect(await planSummary(app.aiReader.pool, 'DELETE FROM ai.machines', { timeZone: 'Africa/Cairo' })).toBeNull()
    expect(TIMEOUT_ADVICE).toMatch(/"long": true/)
  })
})

describe('§20 a long analysis', () => {
  it('runs one at a time across the app: another is refused at once, a usual query still runs', async () => {
    const holder = new AbortController()
    const first = runReadOnlyQuery(app.aiReader.pool, SLOW, { ...chat, signal: holder.signal, exclusive: true })
    await waitFor(longRunning, 'the long analysis to hold its lock')
    const second = await runReadOnlyQuery(app.aiReader.pool, 'SELECT 1 AS one', { ...chat, exclusive: true })
    expect(second).toMatchObject({ ok: false, failure: 'busy', error: LONG_QUERY_BUSY })
    expect((await runReadOnlyQuery(app.aiReader.pool, 'SELECT 2 AS two', chat)).rows).toEqual([[2]])
    holder.abort()
    expect((await first).error).toBe(AI_QUERY_STOPPED)
    // Ended, it lets the next one run.
    await waitFor(async () => !(await longRunning()), 'the lock to be let go')
    expect((await runReadOnlyQuery(app.aiReader.pool, 'SELECT 3 AS three', { ...chat, exclusive: true })).rows).toEqual([[3]])
  })

  it('tells the person it may take minutes and that they may leave; refused while another runs, the model is told what to do', async () => {
    app.model.reply({ content: [text('A large one.'), longSql('toolu_long', 'Everything, every machine', 'SELECT count(*) AS n FROM ai.machines')] }, { content: [text('Done.')] })
    const res = await app.api<string>('POST', '/api/ai/chat', { token: admin.token, body: { message: 'Everything, all years.', clientId: randomUUID() } })
    expect(res.status).toBe(200)
    const events = res.body
      .split('\n\n')
      .filter((f) => f.startsWith('event: '))
      .map((f) => JSON.parse(f.slice(f.indexOf('\ndata: ') + 7)) as AiStreamEvent)
    expect(events).toContainEqual({ type: 'progress', text: LONG_QUERY_LINE })
    const ended = events.find((e): e is Extract<AiStreamEvent, { type: 'query_end' }> => e.type === 'query_end')!
    expect(ended.part.ok).toBe(true)

    const holder = new AbortController()
    const held = runReadOnlyQuery(app.aiReader.pool, SLOW, { ...chat, signal: holder.signal, exclusive: true })
    await waitFor(longRunning, 'another long analysis to run')
    try {
      app.model.reply({ content: [longSql('toolu_long2', 'Everything again', 'SELECT count(*) AS n FROM ai.machines')] }, { content: [text('Busy, then.')] })
      const busy = await app.api<string>('POST', '/api/ai/chat', { token: admin.token, body: { message: 'Again, all years.', clientId: randomUUID() } })
      const result = app.model.calls.at(-1)!.params.messages.at(-1)!.content as Anthropic.Beta.BetaToolResultBlockParam[]
      expect(busy.status).toBe(200)
      expect(result[0]).toMatchObject({ type: 'tool_result', is_error: true, content: LONG_QUERY_BUSY })
    } finally {
      holder.abort()
      await held
    }
  })
})
