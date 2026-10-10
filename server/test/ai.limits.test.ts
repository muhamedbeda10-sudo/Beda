import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { AI_EXPORT_MAX_ROWS, AI_PREVIEW_ROWS, type AiQueryPart, type AiStreamEvent } from '@qc/shared/ai'
import type { ApiErrorBody } from '@qc/shared/api'
import { TestApp, type Session } from './harness'
import { runSql, text } from './aiFake'
import { AI_CHAT_LIMITS, AI_EXPORT_LIMITS, AI_QUERY_STOPPED, previewOf, runReadOnlyQuery, type RunOptions } from '../src/ai/runQuery'

// §20 — what one query may cost the API. However large a value the model's
// SQL makes, it never reaches Node whole: PostgreSQL refuses a long row, the
// connection is cut at any longer message, and reading stops at the run's
// budget. A stop or the time limit cancels the statement inside PostgreSQL.
// Before this, `SELECT repeat('x', 600000000)` took the whole API down.

const app = new TestApp()
let admin: Session
const chat: RunOptions = { maxRows: AI_PREVIEW_ROWS, timeoutMs: 10_000, timeZone: 'Africa/Cairo', ...AI_CHAT_LIMITS }
const exporting: RunOptions = { maxRows: AI_EXPORT_MAX_ROWS, timeoutMs: 30_000, timeZone: 'Africa/Cairo', ...AI_EXPORT_LIMITS }
const run = (sql: string, opts: RunOptions = chat) => runReadOnlyQuery(app.aiReader.pool, sql, opts)

const HUGE_CELL = `SELECT repeat('x', 600000000) AS c`
const MANY_LONG_ROWS = `SELECT repeat('x', 5000000) AS c FROM generate_series(1, 201)`
/** Far longer than any limit here. */
const SLOW = 'SELECT count(*) AS n FROM generate_series(1, 100000) a, generate_series(1, 100000) b'

/** Statements of the reader that are running now. */
async function readerRunning(): Promise<number> {
  const { rows } = await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = $1 AND state = 'active'`, [app.aiReader.role])
  return rows[0].n
}

async function waitFor(check: () => Promise<boolean>, what: string, ms = 3000): Promise<void> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`Timed out waiting for ${what}`)
}

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  admin = await app.register('admin', 'Admin')
  const set = await app.api('PUT', '/api/ai/key', { token: admin.token, body: { apiKey: `sk-ant-api03-${'k_9-'.repeat(20)}LaSt` } })
  expect(set.status).toBe(200)
})
afterAll(() => app.stop())

describe('§20 a query’s size', () => {
  it('refuses a huge value inside PostgreSQL, at the chat’s and the export’s limits alike', async () => {
    // Making 600 MB takes PostgreSQL seconds: room enough that only the size can be the answer.
    for (const [opts, kb] of [
      [{ ...chat, timeoutMs: 60_000 }, 256],
      [{ ...exporting, timeoutMs: 60_000 }, 1024],
    ] as const) {
      const res = await run(HUGE_CELL, opts)
      expect(res).toMatchObject({ ok: false, rows: [], error: `A row of the result is larger than ${kb} KB. Select fewer or shorter columns, or aggregate.`, failure: 'row-too-large' })
      expect(res).not.toHaveProperty('dbMessage')
      const many = await run(MANY_LONG_ROWS, opts)
      expect(many.error).toBe(`A row of the result is larger than ${kb} KB. Select fewer or shorter columns, or aggregate.`)
    }
    // Still standing, and the reader still answers.
    expect((await run('SELECT 1 AS one')).rows).toEqual([[1]])
  }, 120_000)

  it('stops reading at the run’s budget and says the result was cut', async () => {
    // 200 008 characters a row: 24 rows fit in the chat's 5 000 000.
    const cut = await run(`SELECT g, repeat('x', 200000) AS s FROM generate_series(1, 201) g`)
    expect(cut).toMatchObject({ ok: true, columns: ['g', 's'], truncated: true })
    expect(cut.rows.map((r) => r[0])).toEqual(Array.from({ length: 24 }, (_, i) => i + 1))
    expect(previewOf(cut).truncated).toBe(true)
    // Exactly what fits is whole.
    const whole = await run(`SELECT g, repeat('x', 200000) AS s FROM generate_series(1, 24) g`)
    expect(whole).toMatchObject({ ok: true, truncated: false })
    expect(whole.rows).toHaveLength(24)
    // An export holds more: 55 rows of 900 008 characters fit in 50 000 000.
    const exported = await run(`SELECT g, repeat('y', 900000) AS s FROM generate_series(1, 100) g`, exporting)
    expect(exported).toMatchObject({ ok: true, truncated: true })
    expect(exported.rows).toHaveLength(55)
    // An ordinary wide export is read whole, in order.
    const wide = await run(`SELECT g, md5(g::text) AS a, md5((g + 1)::text) AS b, now() AS t FROM generate_series(1, 20000) g ORDER BY g`, exporting)
    expect(wide).toMatchObject({ ok: true, truncated: false })
    expect(wide.rows).toHaveLength(20_000)
    expect(wide.rows[19_999][0]).toBe(20_000)
  }, 60_000)

  it('cuts the connection at an error that quotes a huge value, before pg reads it', async () => {
    // PostgreSQL repeats the whole input in "invalid input syntax"; at 600 MB it was a string Node cannot build.
    const res = await run(`SELECT repeat('x', 2000000)::int AS n`)
    expect(res).toMatchObject({ ok: false })
    expect(res.error).toMatch(/^The query failed with an error message longer than 320 KB: it quotes a very long value/)
    expect(res.failure).toBe('reply-too-large')
    await waitFor(async () => (await readerRunning()) === 0, 'the cut statement to end')
    // A short error is still the database's own sentence.
    const short = await run(`SELECT 'abc'::int AS n`)
    expect(short.error).toMatch(/invalid input syntax for type integer: "abc"/)
    // And PostgreSQL's own words, as it said them, for words other than the model's.
    expect(short).toMatchObject({ failure: 'database', code: '22P02', dbMessage: 'invalid input syntax for type integer: "abc"' })
  })

  it('cuts the connection at a row whose text outgrows its stored size, before pg reads it', async () => {
    // A long stored value is kept compressed: the row passes the check inside the database at a fraction of its text.
    const made = await app.api('POST', '/api/master/machines', { token: admin.token, body: { code: '58', name: 'Welding', displayName: '58. Welding', process: 'welding' } })
    expect(made.status).toBe(201)
    await app.db.query(`UPDATE machines SET name = repeat('x', 5000000) WHERE code = '58'`)
    const stored = await app.db.query<{ n: number }>(`SELECT pg_column_size(name) AS n FROM machines WHERE code = '58'`)
    expect(stored.rows[0].n).toBeLessThan(AI_CHAT_LIMITS.maxRowBytes)
    for (const [opts, kb] of [
      [chat, 256],
      [exporting, 1024],
    ] as const) {
      expect((await run(`SELECT work_centre_name FROM ai.machines`, opts)).error).toBe(`A row of the result is larger than ${kb} KB. Select fewer or shorter columns, or aggregate.`)
    }
    // A bit string's text is eight times its stored size.
    expect(await run(`SELECT lpad('', 2100000, '1')::varbit AS bits`)).toMatchObject({
      error: 'A row of the result is larger than 256 KB. Select fewer or shorter columns, or aggregate.',
      failure: 'row-too-large',
    })
    await waitFor(async () => (await readerRunning()) === 0, 'the cut statements to end')
    expect((await run(`SELECT length(work_centre_name) AS n FROM ai.machines`)).rows).toEqual([[5_000_000]])
    await app.db.query(`UPDATE machines SET name = 'Welding' WHERE code = '58'`)
  })

  it('names the failing spot in the query itself, not in the wrapper around it', async () => {
    const res = await run('SELECT (1 AS n')
    expect(res.error).toMatch(/^syntax error at or near "AS" \(at character 11\)/)
    // The database's own message stays as it was: no position, no advice.
    expect(res).toMatchObject({ failure: 'database', code: '42601', dbMessage: 'syntax error at or near "AS"' })
    expect((await run('SELECT (1')).error).toBe('syntax error at end of input (at character 10)')
    const trailing = await run('SELECT machine_code FROM ai.machines -- the register')
    expect(trailing).toMatchObject({ ok: true, columns: ['machine_code'] })
    // A query cannot close the wrapper's parenthesis and carry on outside it.
    const escape = await run(`SELECT repeat('x', 600000000) AS c) ai_s OFFSET 0) ai_q UNION ALL SELECT * FROM (SELECT 'y' AS c`)
    expect(escape).toMatchObject({ ok: false })
    expect(escape.error).toMatch(/^syntax error at or near "\)" \(at character 35\)/)
  })
})

describe('§20 stopping a query', () => {
  it('stops at once when the signal aborts, and cancels the statement inside PostgreSQL', async () => {
    const ac = new AbortController()
    const pending = run(SLOW, { ...chat, signal: ac.signal })
    await waitFor(async () => (await readerRunning()) === 1, 'the query to start')
    const stoppedAt = Date.now()
    ac.abort()
    const res = await pending
    expect(res).toMatchObject({ ok: false, error: AI_QUERY_STOPPED, failure: 'stopped', rows: [] })
    expect(Date.now() - stoppedAt).toBeLessThan(1000)
    // Cancelled there too, long before its 10 s timeout.
    await waitFor(async () => (await readerRunning()) === 0, 'the cancelled statement to end')
  })

  it('never starts when already stopped, and gives up waiting for a connection when stopped', async () => {
    const before = new AbortController()
    before.abort()
    expect(await run('SELECT 1', { ...chat, signal: before.signal })).toMatchObject({ ok: false, error: AI_QUERY_STOPPED })

    // A combination's pool holds two connections: fill it, then stop a third query that is waiting for one.
    const busy = Array.from({ length: 2 }, () => new AbortController())
    const running = busy.map((ac) => run(SLOW, { ...chat, signal: ac.signal }))
    await waitFor(async () => (await readerRunning()) === 2, 'two queries to run')
    const waiting = new AbortController()
    const queued = run('SELECT 1', { ...chat, signal: waiting.signal })
    await new Promise((r) => setTimeout(r, 100))
    waiting.abort()
    expect(await queued).toMatchObject({ ok: false, error: AI_QUERY_STOPPED })
    for (const ac of busy) ac.abort()
    for (const res of await Promise.all(running)) expect(res.error).toBe(AI_QUERY_STOPPED)
    await waitFor(async () => (await readerRunning()) === 0, 'every stopped statement to end')
    // The pool recovers: nothing was left checked out.
    expect((await run('SELECT 2 AS two')).rows).toEqual([[2]])
  })

  it('keeps the whole run, not each batch, to its time limit', async () => {
    // About 15 ms a row: each batch well inside a second, all 201 rows several seconds.
    const started = Date.now()
    const res = await run(`SELECT g, (SELECT count(*) FROM generate_series(1, 200000 + g)) AS n FROM generate_series(1, 400) g`, { ...chat, timeoutMs: 1000 })
    expect(res).toMatchObject({ ok: false, error: 'The query took too long (1 s). Narrow it or aggregate.', failure: 'timeout' })
    expect(Date.now() - started).toBeLessThan(2500)
    await waitFor(async () => (await readerRunning()) === 0, 'the timed-out statement to end')
  })
})

describe('§20 through the API', () => {
  it('answers a question whose query makes a huge value, and the export of it, and stays up', async () => {
    app.model.reply(
      { content: [text('Let me look.'), runSql('toolu_huge', 'One huge value', HUGE_CELL), runSql('toolu_many', 'Many long rows', MANY_LONG_ROWS)] },
      { content: [text('Those results are too large to read.')] },
    )
    const res = await app.api<string>('POST', '/api/ai/chat', { token: admin.token, body: { message: 'Show me everything.', clientId: randomUUID() } })
    expect(res.status).toBe(200)
    const events = res.body
      .split('\n\n')
      .filter((f) => f.startsWith('event: '))
      .map((f) => JSON.parse(f.slice(f.indexOf('\ndata: ') + 7)) as AiStreamEvent)
    const parts = events.filter((e): e is Extract<AiStreamEvent, { type: 'query_end' }> => e.type === 'query_end').map((e) => e.part)
    // On a slow machine, making the 600 MB value can outlast the chat's 10 s instead: refused either way.
    expect(parts.map((p: AiQueryPart) => [p.purpose, p.ok])).toEqual([
      ['One huge value', false],
      ['Many long rows', false],
    ])
    expect(parts[0].error).toMatch(/^(A row of the result is larger than 256 KB\. Select fewer or shorter columns, or aggregate\.|The query took too long \(10 s\)\.)/)
    expect(parts[1].error).toBe('A row of the result is larger than 256 KB. Select fewer or shorter columns, or aggregate.')
    expect(events.some((e) => e.type === 'done')).toBe(true)

    // Excel runs it again, with room for longer rows, and is refused the same way.
    for (const part of parts) {
      const exported = await app.api<ApiErrorBody>('GET', `/api/ai/queries/${part.queryId}/export`, { token: admin.token })
      expect(exported.status).toBe(400)
      expect(exported.body.error.message).toMatch(/^The query could not be run again: A row of the result is larger than 1024 KB\./)
    }
    expect((await app.api('GET', '/api/ai/status', { token: admin.token })).status).toBe(200)
  }, 120_000)
})
