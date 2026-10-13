import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type Anthropic from '@anthropic-ai/sdk'
import { AI_MODEL, type AiStreamEvent } from '@qc/shared/ai'
import { TestApp, type Session } from './harness'
import { runSql, text } from './aiFake'
import { toolUse } from './noticesKit'
import { AnswerRunner, CUT_OFF_NOTICE, MAX_RESUMES, TOO_MANY_RESUMES_NOTICE, answerExcerpt, progressOf } from '../src/ai/answerRunner'

// §20 — answers written on the server whatever happens to the request: an
// answer lost with its instance is taken over and continued from the step
// it had reached (never asked of the model again, its tools run once each),
// its limits counted across the hand-over; Stop is seen wherever the answer
// is written; a stopping server hands its answers back at once; an answer
// handed over too often, or left long ago, is closed.

const app = new TestApp()
let admin: Session
const KEY = `sk-ant-api03-${'k_9-'.repeat(20)}LaSt`

type Turn = { id: string; status: string; stop_reason: string | null; notice: string | null; runner: string | null; calls: number; resumes: number; conversation_id: string }
const turnOf = async (question: string) =>
  (await app.db.query<Turn>(`SELECT id, status, stop_reason, notice, runner, calls, resumes, conversation_id FROM ai_turns WHERE question = $1`, [question])).rows[0]

async function waitFor(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`Timed out waiting for ${what}`)
}

/** Ask without waiting for the answer: the stream is read in the background, as a browser would. */
function askInBackground(message: string, conversationId?: string): Promise<string> {
  return app
    .api<string>('POST', '/api/ai/chat', { token: admin.token, body: { message, clientId: randomUUID(), ...(conversationId ? { conversationId } : {}) } })
    .then((r) => r.body)
}

/** The answer's instance went silent: as far as the database knows, it is gone. Its own run learns so at its next heartbeat. */
async function loseInstance(turnId: string): Promise<void> {
  await app.db.query(`UPDATE ai_turns SET runner = 'a-gone-instance', heartbeat_at = now() - interval '1 minute' WHERE id = $1`, [turnId])
  await app.answers.heartbeat()
  await waitFor(() => !app.answers.isRunning(turnId), 'the run here to give the answer up')
}

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  admin = await app.register('admin', 'Admin')
  for (const code of ['58', '31']) {
    expect((await app.api('POST', '/api/master/machines', { token: admin.token, body: { code, name: `Machine ${code}`, displayName: `${code}. Machine`, process: 'forming' } })).status).toBe(201)
  }
  expect((await app.api('PUT', '/api/ai/key', { token: admin.token, body: { apiKey: KEY } })).status).toBe(200)
})
afterAll(() => app.stop())
beforeEach(() => app.aiLimiter.reset(admin.user.id))

describe('§20 an answer lost with its instance', () => {
  it('is taken over and continued from the step it had reached, its calls counted across the hand-over', async () => {
    app.model.reply(
      { content: [text('First the machines.'), runSql('toolu_bg_count', 'Count the machines', 'SELECT count(*)::int AS machines FROM ai.machines')] },
      { content: [text('Halfway through the answer')], hold: new Promise(() => undefined) },
    )
    const calls = app.model.calls.length
    const stream = askInBackground('Count the machines, slowly')
    await waitFor(() => app.model.calls.length === calls + 2, 'the second call')
    const t = await turnOf('Count the machines, slowly')
    expect(t).toMatchObject({ status: 'running', runner: app.answers.id, calls: 2 })

    // The instance goes silent mid-call: its run stops here without keeping anything of that call but its cost.
    await loseInstance(t.id)
    // The stream that asked ends without an answer: the asker's device follows it in the conversation.
    const raw = await stream
    expect(raw).toContain('event: start')
    expect(raw).not.toContain('event: done')
    expect(raw).not.toContain('event: error')
    expect((await app.db.query(`SELECT partial FROM ai_usage WHERE turn_id = $1 ORDER BY id`, [t.id])).rows).toEqual([{ partial: false }, { partial: true }])

    // Taken over: continued from its kept step, the cut-off call made again, not the whole answer.
    app.model.reply({ content: [text('There are **2** machines.')] })
    expect(await app.answers.sweep()).toBe(1)
    await waitFor(async () => (await turnOf('Count the machines, slowly')).status === 'done', 'the answer to end')
    const after = await turnOf('Count the machines, slowly')
    expect(after).toMatchObject({ stop_reason: 'end_turn', resumes: 1, calls: 3, runner: app.answers.id })
    const resent = app.model.calls[calls + 2].params.messages
    expect(resent.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(JSON.stringify(resent)).not.toContain('Halfway')
    const kinds = await app.db.query(`SELECT kind, in_replay, pending FROM ai_messages WHERE turn_id = $1 ORDER BY seq`, [t.id])
    expect(kinds.rows).toEqual([
      { kind: 'question', in_replay: true, pending: false },
      { kind: 'assistant', in_replay: true, pending: false },
      { kind: 'tool_results', in_replay: true, pending: false },
      { kind: 'assistant', in_replay: true, pending: false },
    ])
    // Nobody watched it end: the bell says it is ready.
    const bell = await app.db.query(`SELECT title, body, link FROM user_notifications WHERE ai_turn_id = $1`, [t.id])
    expect(bell.rows).toEqual([{ title: expect.stringMatching(/^Answer ready: /), body: 'There are 2 machines.', link: `/ai?c=${t.conversation_id}` }])
  })

  it('finishes a step cut short after it was stored, each of its tools run once: none asked of the model again', async () => {
    // The step's second call waits for a lock on the machine register; while it waits, the instance goes.
    app.model.reply({
      content: [
        toolUse('update_playbook', { action: 'add', kind: 'instruction', text: 'Give machine counts by factory.' }, 'toolu_bg_pb'),
        runSql('toolu_bg_wait', 'Machines', 'SELECT count(*)::int AS machines FROM ai.machines'),
      ],
    })
    const lock = await app.db.connect()
    await lock.query('BEGIN')
    await lock.query('LOCK TABLE machines IN ACCESS EXCLUSIVE MODE')
    const calls = app.model.calls.length
    let t: Turn
    try {
      void askInBackground('Remember this, then count')
      const waiting = async () =>
        ((await app.db.query(`SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND application_name = 'qc-ai-reader'`)).rowCount ?? 0) > 0
      await waitFor(waiting, 'the query to wait for the lock')
      t = await turnOf('Remember this, then count')
      // The step is stored, waiting for its results; the playbook entry is made already.
      expect((await app.db.query(`SELECT kind, in_replay, pending FROM ai_messages WHERE turn_id = $1 ORDER BY seq`, [t.id])).rows).toEqual([
        { kind: 'question', in_replay: true, pending: false },
        { kind: 'assistant', in_replay: false, pending: true },
      ])
      await loseInstance(t.id)
    } finally {
      await lock.query('COMMIT')
      lock.release()
    }
    // Nothing of the step's results was kept by the run that gave it up.
    expect((await app.db.query(`SELECT 1 FROM ai_messages WHERE turn_id = $1 AND kind = 'tool_results'`, [t.id])).rowCount).toBe(0)

    app.model.reply({ content: [text('Saved, and there are 2 machines.')] })
    expect(await app.answers.sweep()).toBe(1)
    await waitFor(async () => (await turnOf('Remember this, then count')).status === 'done', 'the answer to end')
    // One model call for the step, one after it: the step was not asked for again.
    expect(app.model.calls.length - calls).toBe(2)
    expect(await turnOf('Remember this, then count')).toMatchObject({ stop_reason: 'end_turn', calls: 2, resumes: 1 })
    // The playbook entry once, the query run, the step and its results in the replay.
    expect((await app.db.query(`SELECT count(*)::int AS n FROM ai_playbook_entries WHERE body = 'Give machine counts by factory.'`)).rows).toEqual([{ n: 1 }])
    const results = (await app.db.query<{ content: Anthropic.Beta.BetaToolResultBlockParam[] }>(`SELECT content FROM ai_messages WHERE turn_id = $1 AND kind = 'tool_results'`, [t.id])).rows[0].content
    expect(results.map((r) => r.tool_use_id)).toEqual(['toolu_bg_pb', 'toolu_bg_wait'])
    expect(JSON.parse(String(results[0].content))).toMatchObject({ saved: true, note: expect.stringMatching(/before the answer was interrupted/) })
    expect((await app.db.query(`SELECT ok FROM ai_queries WHERE turn_id = $1`, [t.id])).rows).toEqual([{ ok: true }])
    expect((await app.db.query(`SELECT in_replay, pending FROM ai_messages WHERE turn_id = $1 AND kind = 'assistant' ORDER BY seq LIMIT 1`, [t.id])).rows).toEqual([
      { in_replay: true, pending: false },
    ])
  })

  it('makes a question sent meanwhile wait, and looks for the lost answer at once', async () => {
    app.model.reply({ content: [text('Slowly')], hold: new Promise(() => undefined) })
    void askInBackground('A long answer')
    await waitFor(async () => (await turnOf('A long answer'))?.calls === 1, 'the call')
    const t = await turnOf('A long answer')
    await loseInstance(t.id)
    app.model.reply({ content: [text('Continued.')] })
    const next = await app.api<{ error: { message: string } }>('POST', '/api/ai/chat', { token: admin.token, body: { message: 'Meanwhile', clientId: randomUUID(), conversationId: t.conversation_id } })
    expect(next.status).toBe(409)
    expect(next.body.error.message).toMatch(/Still answering/)
    // Taken over without waiting for the next sweep.
    await waitFor(async () => (await turnOf('A long answer')).status === 'done', 'the lost answer to be continued')
    expect(await turnOf('A long answer')).toMatchObject({ stop_reason: 'end_turn', resumes: 1 })
  })

  it('is ended once handed over more than MAX_RESUMES times, and one left long ago without a heartbeat is closed without a word', async () => {
    const { rows } = await app.db.query<{ id: string }>(`INSERT INTO ai_conversations (user_id, title, model, system_prompt, tools) VALUES ($1, 'Unlucky', $2, 'x', '[]') RETURNING id`, [admin.user.id, AI_MODEL])
    const [unlucky] = (
      await app.db.query<{ id: string }>(
        `INSERT INTO ai_turns (conversation_id, user_id, client_id, question, resumes, runner, heartbeat_at) VALUES ($1, $2, $3, 'Unlucky', $4, 'x', now() - interval '1 minute') RETURNING id`,
        [rows[0].id, admin.user.id, randomUUID(), MAX_RESUMES],
      )
    ).rows
    const old = await app.db.query<{ id: string }>(`INSERT INTO ai_conversations (user_id, title, model, system_prompt, tools) VALUES ($1, 'Old', $2, 'x', '[]') RETURNING id`, [admin.user.id, AI_MODEL])
    const [left] = (
      await app.db.query<{ id: string }>(
        `INSERT INTO ai_turns (conversation_id, user_id, client_id, question, created_at) VALUES ($1, $2, $3, 'Left long ago', now() - interval '2 hours') RETURNING id`,
        [old.rows[0].id, admin.user.id, randomUUID()],
      )
    ).rows
    const calls = app.model.calls.length
    expect(await app.answers.sweep()).toBe(2)
    expect(app.model.calls).toHaveLength(calls)
    expect(await turnOf('Unlucky')).toMatchObject({ status: 'done', stop_reason: 'error', notice: TOO_MANY_RESUMES_NOTICE })
    expect(await turnOf('Left long ago')).toMatchObject({ status: 'done', stop_reason: 'error', notice: CUT_OFF_NOTICE })
    expect((await app.db.query(`SELECT severity, title FROM user_notifications WHERE ai_turn_id = $1`, [unlucky.id])).rows).toEqual([
      { severity: 'warning', title: expect.stringMatching(/^Answer not finished: /) },
    ])
    expect((await app.db.query(`SELECT 1 FROM user_notifications WHERE ai_turn_id = $1`, [left.id])).rowCount).toBe(0)
  })
})

describe('§20 Stop and stopping, across instances', () => {
  it('stops an answer written on another instance at that instance’s next heartbeat', async () => {
    app.model.reply({ content: [text('On and on')], hold: new Promise(() => undefined) })
    void askInBackground('Written elsewhere')
    await waitFor(async () => (await turnOf('Written elsewhere'))?.calls === 1, 'the call')
    const t = await turnOf('Written elsewhere')
    // Stop pressed on another instance: only the mark on the turn reaches this one.
    await app.db.query(`UPDATE ai_turns SET stop_requested_at = now() WHERE id = $1`, [t.id])
    await app.answers.heartbeat()
    await waitFor(async () => (await turnOf('Written elsewhere')).status === 'done', 'the answer to stop')
    expect(await turnOf('Written elsewhere')).toMatchObject({ stop_reason: 'stopped' })
  })

  it('hands its answers back at once when it stops, for the next instance to continue', async () => {
    const other = new AnswerRunner({ db: app.db, config: app.config, readers: app.aiReader, model: app.model, images: app.images, reportLimiter: app.aiReportLimiter })
    app.model.reply({ content: [text('Begun')], hold: new Promise(() => undefined) })
    void askInBackground('Handed back')
    await waitFor(async () => (await turnOf('Handed back'))?.calls === 1, 'the call')
    const t = await turnOf('Handed back')
    await loseInstance(t.id)
    // Another instance takes it over, then stops (a deploy) while it writes it.
    app.model.reply({ content: [text('Still going')], hold: new Promise(() => undefined) })
    expect(await other.sweep()).toBe(1)
    await waitFor(async () => (await turnOf('Handed back')).calls === 2, 'the other instance\'s call')
    await other.stop()
    const handed = await app.db.query<{ runner: string | null; status: string; back: boolean }>(
      `SELECT runner, status, heartbeat_at = '-infinity'::timestamptz AS back FROM ai_turns WHERE id = $1`,
      [t.id],
    )
    expect(handed.rows).toEqual([{ runner: null, status: 'running', back: true }])
    // Taken at once, not after the lease.
    app.model.reply({ content: [text('Finished here.')] })
    expect(await app.answers.sweep()).toBe(1)
    await waitFor(async () => (await turnOf('Handed back')).status === 'done', 'the answer to end')
    expect(await turnOf('Handed back')).toMatchObject({ stop_reason: 'end_turn', resumes: 2, calls: 3 })
  })
})

describe('§20 what an answer says of itself', () => {
  it('stores a line on what it is doing, and opens the bell with its words without the markdown', () => {
    const progress = (e: AiStreamEvent) => progressOf(e)
    expect(progress({ type: 'progress', text: '  Counting\nthe   machines ' })).toBe('Counting the machines')
    expect(progress({ type: 'query_start', queryId: 'q', purpose: 'Rejects by machine', sql: 'SELECT 1' })).toBe('Looking it up: Rejects by machine')
    expect(progress({ type: 'text', delta: 'x' })).toBe('Writing the answer…')
    expect(progress({ type: 'query_end', part: { type: 'query', queryId: 'q', purpose: '', sql: '', ok: true, columns: [], rows: [], rowCount: 0, truncated: false, ms: 1 } })).toBeNull()
    expect(answerExcerpt('## Rejects\n\n**Machine 58** leads with [3 holds](/history?x=1).\n\n| a | b |\n|---|---|\n| 1 | 2 |')).toBe('Rejects Machine 58 leads with 3 holds. a b 1 2')
    expect(answerExcerpt('x'.repeat(500))).toHaveLength(240)
  })
})
