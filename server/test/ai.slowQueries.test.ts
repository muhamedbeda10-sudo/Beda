// ============================================================================
// §20 — the assistant's slow queries (migration 0056): every query it runs is
// told to an observer with where it ran and for whom (withQueryOrigin, across
// awaits); one that took SLOW_QUERY_MS or more is kept 90 days and listed to
// the owner alone.
// ============================================================================

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import type { AiSlowQueriesResponse } from '@qc/shared/ai'
import { TestApp } from './harness'
import { text } from './aiFake'
import { ask, setUp, type People } from './automationsKit'
import { AI_QUERY_TIMEOUT_MS, observeQueries, runReadOnlyQuery, type QueryRun } from '../src/ai/runQuery'
import { SLOW_QUERY_MS, currentQueryOrigin, keepSlowQueries, recordSlowQuery, withQueryOrigin, withQueryPurpose, type QueryOrigin } from '../src/ai/slowQueries'

const app = new TestApp()
let p: People
const seen: { sql: string; origin: QueryOrigin | null; ms: number }[] = []

const run = (over: Partial<QueryRun>): QueryRun => ({ ok: true, columns: ['n'], rows: [[1], [2]], truncated: false, ms: 12_345, ...over })

beforeAll(async () => {
  await app.start()
  p = await setUp(app)
})
afterAll(async () => {
  keepSlowQueries(app.db)
  await app.stop()
})
beforeEach(() => {
  app.model.reset()
  seen.length = 0
  // Every run watched here, slow or not: what it would be kept as.
  observeQueries((sql, r) => seen.push({ sql, origin: currentQueryOrigin(), ms: r.ms }))
})

describe('where a query of the assistant ran', () => {
  it('follows the work that ran it, a section after its report', async () => {
    const pool = app.aiReader.poolFor(['inspection'])
    await withQueryOrigin({ source: 'report', userId: p.creator.user.id, purpose: 'Weekly scrap' }, () =>
      withQueryPurpose('By machine', async () => {
        await Promise.resolve()
        return runReadOnlyQuery(pool, 'SELECT 1 AS one', { maxRows: 10, timeoutMs: 5_000, timeZone: 'Africa/Cairo' })
      }),
    )
    await runReadOnlyQuery(pool, 'SELECT 2 AS two', { maxRows: 10, timeoutMs: 5_000, timeZone: 'Africa/Cairo' })
    expect(seen.map((s) => [s.sql, s.origin])).toEqual([
      ['SELECT 1 AS one', { source: 'report', userId: p.creator.user.id, purpose: 'Weekly scrap · By machine' }],
      ['SELECT 2 AS two', null],
    ])
  })

  it("is a chat's, with its asker, its conversation and the query's purpose, when the answer runs it", async () => {
    app.model.reply(
      { content: [text('Counting.'), { type: 'tool_use', id: 'toolu_slow', name: 'run_sql', input: { purpose: 'Count the machines', sql: 'SELECT count(*)::int AS n FROM ai.machines' } } as Anthropic.Beta.BetaContentBlock] },
      { content: [text('There are some machines.')] },
    )
    const res = await ask(app, p.creator, 'How many machines are there?')
    expect(res.status, JSON.stringify(res.error)).toBe(200)
    const chat = seen.find((s) => s.sql.includes('ai.machines'))
    expect(chat?.origin).toEqual({ source: 'chat', userId: p.creator.user.id, conversationId: res.conversationId, purpose: 'Count the machines' })
  })

  it('takes a minute at most: the limit every query of the assistant shares, beyond what counts as slow', () => {
    expect(AI_QUERY_TIMEOUT_MS).toBe(60_000)
    expect(SLOW_QUERY_MS).toBe(10_000)
  })
})

describe('the slow queries kept', () => {
  const list = (token: string) => app.api<AiSlowQueriesResponse>('GET', '/api/ai/slow-queries', { token })

  it('keeps how it ended and for whom, lets go of those older than 90 days, never one that was stopped, and shows them to the owner alone', async () => {
    await app.db.query(`INSERT INTO ai_slow_queries (at, source, sql, duration_ms, outcome) VALUES (now() - interval '100 days', 'other', 'SELECT old', 11000, 'ok')`)
    const origin: QueryOrigin = { source: 'excel', userId: p.creator.user.id, purpose: 'خردة أكتوبر' }
    await recordSlowQuery(app.db, origin, 'SELECT finished', run({}))
    await recordSlowQuery(app.db, { source: 'chat', userId: p.creator.user.id }, 'SELECT slowest', run({ ok: false, rows: [], ms: 60_002, failure: 'timeout', error: 'The query took too long (60 s). Narrow it or aggregate.' }))
    await recordSlowQuery(app.db, { source: 'chat', userId: null }, 'SELECT stopped', run({ ok: false, rows: [], failure: 'stopped', error: 'stopped' }))

    const owner = await list(p.owner.token)
    expect(owner.status).toBe(200)
    expect(owner.body).toMatchObject({ thresholdSeconds: 10, limitSeconds: 60 })
    expect(owner.body.queries.map((q) => [q.sql, q.source, q.outcome, q.durationMs, q.rowCount, q.userName, q.purpose, q.error])).toEqual([
      ['SELECT slowest', 'chat', 'timeout', 60_002, null, p.creator.user.name, null, 'The query took too long (60 s). Narrow it or aggregate.'],
      ['SELECT finished', 'excel', 'ok', 12_345, 2, p.creator.user.name, 'خردة أكتوبر', null],
    ])
    // Anyone else: as if there were no such page.
    expect((await list(p.creator.token)).status).toBe(404)
  })
})
