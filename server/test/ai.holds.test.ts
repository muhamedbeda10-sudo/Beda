import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import Anthropic from '@anthropic-ai/sdk'
import type { ApiErrorBody } from '@qc/shared/api'
import { AI_JOBS, aiCostUsd, type AiAccess, type AiMeResponse, type AiStreamEvent } from '@qc/shared/ai'
import { TestApp, type Session } from './harness'
import { apiError, text } from './aiFake'
import { ACCESS_NOTICE, HOLD_MINUTES, holdCall, releaseHold } from '../src/ai/access'
import { personalMonthSpend, monthSpend, recordUsage } from '../src/ai/transcript'
import { REPORT_TITLE_SYSTEM } from '../src/ai/answerReportTitle'
import { TITLE_SYSTEM } from '../src/ai/conversationTitle'

// §20 — the caps hold however many calls are under way at once. Before a call
// its worst case is held against the assistant's cap and the person's own, one
// check at a time across the app, and the hold becomes the call's real cost
// the moment it is kept (or goes, when the call cost nothing); a hold a server
// left behind lapses. A cost that cannot be kept never fails the answer. A
// short call (a title) that timed out once sent is counted at its worst. The
// model is the scripted stand-in.

const app = new TestApp()
let owner: Session
let insp: Session
let sup: Session
const KEY = `sk-ant-api03-${'h_4-'.repeat(20)}HoLd`

type Done = Extract<AiStreamEvent, { type: 'done' }>
type ErrorEvent = Extract<AiStreamEvent, { type: 'error' }>

async function ask(as: Session, message: string): Promise<{ status: number; error?: ApiErrorBody['error']; done?: Done; failed?: ErrorEvent; turnId?: string }> {
  const res = await app.api<string | ApiErrorBody>('POST', '/api/ai/chat', { token: as.token, body: { message, clientId: randomUUID() } })
  if (res.status !== 200) return { status: res.status, error: (res.body as ApiErrorBody).error }
  const events = (res.body as string)
    .split('\n\n')
    .filter((f) => f && !f.startsWith(':'))
    .map((f) => JSON.parse(f.slice(f.indexOf('data: ') + 6)) as AiStreamEvent)
  const start = events.find((e): e is Extract<AiStreamEvent, { type: 'start' }> => e.type === 'start')
  return {
    status: res.status,
    done: events.find((e): e is Done => e.type === 'done'),
    failed: events.find((e): e is ErrorEvent => e.type === 'error'),
    turnId: start?.turnId,
  }
}

/** Give the assistant with a cap of its own, in dollars and cents (rounded down). */
async function grant(person: Session, capUsd: number): Promise<AiAccess> {
  const monthlyCapUsd = Math.floor(capUsd * 100) / 100
  const res = await app.api<AiAccess>('PUT', `/api/ai/access/${person.user.id}`, { token: owner.token, body: { enabled: true, domains: ['inspection'], monthlyCapUsd } })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return res.body
}

const holdsOf = async (userId: string) =>
  (await app.db.query<{ usd: number }>(`SELECT usd::float8 AS usd FROM ai_usage_holds WHERE user_id = $1 AND expires_at > now() ORDER BY created_at`, [userId])).rows.map((r) => r.usd)
const spentBy = async (userId: string) => Number((await app.db.query<{ n: number }>(`SELECT COALESCE(sum(cost_usd), 0)::float8 AS n FROM ai_usage WHERE user_id = $1`, [userId])).rows[0].n)

/** Wait until a condition holds, or fail after a few seconds. */
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
    ['insp', 'Inspector One', 'inspector'],
    ['sup', 'Super Visor', 'supervisor'],
  ]) {
    expect((await app.api('POST', '/api/users', { token: owner.token, body: { username, password: 'Password#1', name, role } })).status).toBe(201)
  }
  insp = await app.login('insp')
  sup = await app.login('sup')
  expect((await app.api('PUT', '/api/ai/key', { token: owner.token, body: { apiKey: KEY } })).status).toBe(200)
})
afterAll(() => app.stop())
beforeEach(async () => {
  app.model.reset()
  for (const s of [owner, insp, sup]) app.aiLimiter.reset(s.user.id)
  await app.db.query(`DELETE FROM ai_usage_holds`)
  await grant(insp, 50)
  await grant(sup, 50)
  await app.api('PUT', '/api/ai/settings', { token: owner.token, body: { enabled: true, monthlyCapUsd: 50 } })
})

describe('§20 calls under way, held against the caps', () => {
  it('lets only as many calls through at once as a person’s own cap has room for', async () => {
    await grant(insp, (await spentBy(insp.user.id)) + 1.5)
    // Two answers' calls checked at the same moment, each of which could cost $1: the second sees the first's hold.
    const both = await Promise.all([holdCall(app.db, insp.user.id, 1), holdCall(app.db, insp.user.id, 1)])
    const held = both.filter((b) => 'holdId' in b)
    expect(held).toHaveLength(1)
    expect(both.find((b) => !('holdId' in b))).toEqual({ stopReason: 'cap', notice: ACCESS_NOTICE.personalCap })
    expect(await holdsOf(insp.user.id)).toEqual([1])
    // Every cap check counts it, the person's own and what they are told.
    expect(await personalMonthSpend(app.db, insp.user.id)).toBeCloseTo((await spentBy(insp.user.id)) + 1, 6)
    expect(((await app.api<AiMeResponse>('GET', '/api/ai/me', { token: insp.token })).body)).toMatchObject({ available: false, reason: 'personal-cap' })
    // Let go (the call cost nothing): the room is back.
    await releaseHold(app.db, (held[0] as { holdId: string }).holdId)
    expect(await holdsOf(insp.user.id)).toEqual([])
    expect('holdId' in (await holdCall(app.db, insp.user.id, 1))).toBe(true)
  })

  it('lets only as many calls through at once, from anyone, as the assistant’s cap has room for', async () => {
    const app$ = await monthSpend(app.db)
    await app.api('PUT', '/api/ai/settings', { token: owner.token, body: { enabled: true, monthlyCapUsd: Math.ceil((app$.spentUsd + 1.5) * 100) / 100 } })
    const both = await Promise.all([holdCall(app.db, insp.user.id, 1), holdCall(app.db, sup.user.id, 1)])
    expect(both.filter((b) => 'holdId' in b)).toHaveLength(1)
    expect(both.find((b) => !('holdId' in b))).toEqual({ stopReason: 'cap', notice: ACCESS_NOTICE.appCap })
    expect((await monthSpend(app.db)).heldUsd).toBeCloseTo(1, 6)
  })

  it('becomes the call’s real cost as it is kept, in one statement; a hold left behind lapses', async () => {
    const before = await spentBy(insp.user.id)
    const held = await holdCall(app.db, insp.user.id, 2.5)
    if (!('holdId' in held)) throw new Error('not held')
    const tokens = { inputTokens: 1000, outputTokens: 100, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0 }
    await recordUsage(app.db, { userId: insp.user.id, conversationId: null, turnId: null, model: AI_JOBS['chat-standard'].model, tokens, costUsd: 0.02, holdId: held.holdId })
    expect(await holdsOf(insp.user.id)).toEqual([])
    expect(await personalMonthSpend(app.db, insp.user.id)).toBeCloseTo(before + 0.02, 6)
    // Let go again (a finally after the cost was kept): nothing happens.
    await releaseHold(app.db, held.holdId)
    expect(await spentBy(insp.user.id)).toBeCloseTo(before + 0.02, 6)

    // A server that stopped mid-call leaves its hold: it counts until it lapses, then no more, and the next check clears it.
    await app.db.query(`INSERT INTO ai_usage_holds (user_id, usd, expires_at) VALUES ($1, 40, now() - interval '1 second')`, [insp.user.id])
    expect(await personalMonthSpend(app.db, insp.user.id)).toBeCloseTo(before + 0.02, 6)
    expect('holdId' in (await holdCall(app.db, insp.user.id, 1))).toBe(true)
    const left = await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ai_usage_holds WHERE expires_at <= now()`)
    expect(left.rows[0].n).toBe(0)
    const fresh = await app.db.query<{ minutes: number }>(`SELECT round(extract(epoch FROM expires_at - created_at) / 60)::int AS minutes FROM ai_usage_holds WHERE user_id = $1`, [insp.user.id])
    expect(fresh.rows[0].minutes).toBe(HOLD_MINUTES)
  })

  it('holds an answer’s call while it is under way, so a second question cannot pass the cap beside it', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    app.model.reply({ content: [text('The first answer.')], hold: gate })
    const first = ask(insp, 'First question')
    // The router's own hold comes and goes first: wait for the answer's call itself, under way and held alone.
    await until(async () => app.model.calls.length === 1 && (await holdsOf(insp.user.id)).length === 1)
    const [held] = await holdsOf(insp.user.id)
    // The person's room is now one call's worst case and a half: the hold leaves less than a second call could cost.
    await grant(insp, (await spentBy(insp.user.id)) + held * 1.5)
    const second = await ask(insp, 'Second question, at once')
    expect(second).toMatchObject({ status: 402, error: { code: 'ai_budget_reached' } })
    expect(app.model.calls).toHaveLength(1)
    release()
    expect((await first).done!.message.stopReason).toBe('end_turn')
    // Settled to what the call cost.
    expect(await holdsOf(insp.user.id)).toEqual([])
  })
})

describe('§20 a cost that cannot be kept', () => {
  beforeAll(async () => {
    // The database refusing the next usage rows of one person, as a full disk or a lost connection would.
    await app.db.query(`
      CREATE SEQUENCE test_usage_refusals;
      CREATE TABLE test_usage_refusal (user_id uuid NOT NULL, times int NOT NULL);
      CREATE FUNCTION test_refuse_usage() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM test_usage_refusal r WHERE r.user_id = NEW.user_id AND nextval('test_usage_refusals') <= r.times) THEN
          RAISE EXCEPTION 'could not extend file: No space left on device';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER test_refuse_usage BEFORE INSERT ON ai_usage FOR EACH ROW EXECUTE FUNCTION test_refuse_usage();`)
  })
  afterAll(async () => {
    await app.db.query(`DROP TRIGGER test_refuse_usage ON ai_usage; DROP FUNCTION test_refuse_usage(); DROP TABLE test_usage_refusal; DROP SEQUENCE test_usage_refusals;`)
  })
  const refuse = async (userId: string, times: number) => {
    await app.db.query(`DELETE FROM test_usage_refusal`)
    await app.db.query(`ALTER SEQUENCE test_usage_refusals RESTART`)
    await app.db.query(`INSERT INTO test_usage_refusal (user_id, times) VALUES ($1, $2)`, [userId, times])
  }

  it('is written again once, and the answer goes on', async () => {
    await refuse(sup.user.id, 1)
    app.model.reply({ content: [text('Answered.')], usage: { input_tokens: 2000, output_tokens: 300 } })
    const res = await ask(sup, 'Anything?')
    expect(res.failed).toBeUndefined()
    expect(res.done!.message.stopReason).toBe('end_turn')
    const kept = await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ai_usage WHERE turn_id = $1 AND output_tokens = 300`, [res.turnId])
    expect(kept.rows[0].n).toBe(1)
    expect(await holdsOf(sup.user.id)).toEqual([])
  })

  it('is said loudly when it cannot be written at all, never failing the answer; its hold keeps counting until it lapses', async () => {
    await refuse(sup.user.id, 2)
    const loud = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      app.model.reply({ content: [text('Answered.')], usage: { input_tokens: 2000, output_tokens: 300 } })
      const res = await ask(sup, 'Anything else?')
      expect(res.failed).toBeUndefined()
      expect(res.done!.message.stopReason).toBe('end_turn')
      expect(loud.mock.calls.some((c) => String(c[0]).includes('THE COST OF A CALL WAS NOT RECORDED') && String(c[0]).includes(`answer ${res.turnId}`))).toBe(true)
      const kept = await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ai_usage WHERE turn_id = $1 AND output_tokens = 300`, [res.turnId])
      expect(kept.rows[0].n).toBe(0)
      expect(await holdsOf(sup.user.id)).toHaveLength(1)
    } finally {
      loud.mockRestore()
      await app.db.query(`DELETE FROM test_usage_refusal`)
    }
  })
})

describe('§20 a short call that fails once sent', () => {
  const titleCosts = async (turnId: string, system: string) =>
    (
      await app.db.query<{ input: number; output: number; cost: number; partial: boolean }>(
        `SELECT input_tokens AS input, output_tokens AS output, cost_usd::float8 AS cost, partial FROM ai_usage WHERE turn_id = $1 AND model = $2 AND partial ORDER BY id`,
        [turnId, AI_JOBS.title.model],
      )
    ).rows.map((r) => ({ ...r, system }))

  it('is counted at its worst when it ran out of time or was stopped, and not at all when Anthropic refused it or it was never sent', async () => {
    // A conversation's title whose call ran out of time: the question's cost includes what it may have been billed.
    app.model.completeWith = (params) => {
      if (params.system === TITLE_SYSTEM) throw new Anthropic.APIUserAbortError()
      throw new Anthropic.APIConnectionError({ message: 'Not scripted in this test.' })
    }
    app.model.reply({ content: [text('Answered.')] })
    const res = await ask(sup, 'How many samples this week?')
    await until(async () => (await titleCosts(res.turnId!, TITLE_SYSTEM)).length === 1)
    const [timedOut] = await titleCosts(res.turnId!, TITLE_SYSTEM)
    const sent = app.model.completions.find((c) => c.params.system === TITLE_SYSTEM)!.params
    expect(timedOut).toMatchObject({ output: sent.max_tokens, partial: true })
    expect(timedOut.input).toBe(Array.from(JSON.stringify([sent.system, sent.messages])).length)
    const tokens = { inputTokens: timedOut.input, outputTokens: timedOut.output, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0 }
    expect(timedOut.cost).toBeCloseTo(aiCostUsd(AI_JOBS.title.model, tokens), 6)
    await until(async () => Number((await app.db.query<{ cost: number }>(`SELECT cost_usd::float8 AS cost FROM ai_turns WHERE id = $1`, [res.turnId])).rows[0].cost) >= timedOut.cost)

    // The title an answer is printed under, timed out in the SDK: the same.
    app.model.completeWith = (params) => {
      if (params.system === REPORT_TITLE_SYSTEM) throw new Anthropic.APIConnectionTimeoutError()
      throw new Anthropic.APIConnectionError({ message: 'Not scripted in this test.' })
    }
    const printed = await app.api<{ named: boolean }>('POST', `/api/ai/turns/${res.turnId}/report-title`, { token: sup.token })
    expect(printed.body).toMatchObject({ named: false })
    expect(await titleCosts(res.turnId!, REPORT_TITLE_SYSTEM)).toHaveLength(2)
    // Its own deadline's signal, as a fetch throws it.
    app.model.completeWith = () => {
      throw new DOMException('The operation timed out.', 'TimeoutError')
    }
    expect((await app.api<{ named: boolean }>('POST', `/api/ai/turns/${res.turnId}/report-title`, { token: sup.token })).body).toMatchObject({ named: false })
    expect(await titleCosts(res.turnId!, REPORT_TITLE_SYSTEM)).toHaveLength(3)

    // Refused by Anthropic with a status, or never sent: nothing was billed, nothing is counted.
    for (const refusal of [apiError(500, 'Internal error'), apiError(429, 'Slow down'), new Anthropic.APIConnectionError({ message: 'ECONNREFUSED' }), new Error('Not sent')]) {
      app.model.completeWith = () => {
        throw refusal
      }
      expect((await app.api<{ named: boolean }>('POST', `/api/ai/turns/${res.turnId}/report-title`, { token: sup.token })).body).toMatchObject({ named: false })
    }
    expect(await titleCosts(res.turnId!, REPORT_TITLE_SYSTEM)).toHaveLength(3)
  })
})
