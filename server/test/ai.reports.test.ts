import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { ApiErrorBody, AuditListResponse } from '@qc/shared/api'
import {
  AI_MODEL,
  describeAiDays,
  type AiMessage,
  type AiMessagesResponse,
  type AiReport,
  type AiReportExportResponse,
  type AiReportRunResponse,
  type AiReportsResponse,
  type AiSaveReportResponse,
  type AiStatusResponse,
  type AiStreamEvent,
} from '@qc/shared/ai'
import { TestApp, factoryDay, type Session } from './harness'
import { apiError, runSql, text, thinking, type FakeReply } from './aiFake'
import { answerQuestion } from '../src/ai/assistant'
import { FIXED_NOTICE, TEMPLATE_SCHEMA } from '../src/ai/reports'
import { runReadOnlyQuery } from '../src/ai/runQuery'
import { appendMessages, findConversation, finishTurn, loadReplay } from '../src/ai/transcript'

// §20 — saved reports. An answer is kept with its successful queries; one
// call to the model rewrites them into templates over {{from}} and {{to}},
// and only when each template, filled with the period of the day the question
// was asked, returns exactly what its query returned is the period kept
// adjustable. Running a report calls no model. The model is the scripted
// stand-in (test/aiFake.ts).

const app = new TestApp()
let admin: Session
let other: Session
const KEY = `sk-ant-api03-${'k_9-'.repeat(20)}LaSt`

/** The changes typed against coils per day, over the 30 days up to today, as the model wrote the query. */
const PER_DAY = (from: string, toExclusive: string) =>
  `SELECT day::text AS day, count(*)::int AS changes FROM ai.audit_log WHERE entity = 'Coil' AND at >= '${from}' AND at < '${toExclusive}' GROUP BY day ORDER BY day`
const PER_DAY_TEMPLATE = `SELECT day::text AS day, count(*)::int AS changes FROM ai.audit_log WHERE entity = 'Coil' AND at >= {{from}} AND at < {{to}} + 1 GROUP BY day ORDER BY day`
const MACHINES = 'SELECT count(*)::int AS machines FROM ai.machines'
const LAST_30 = { kind: 'last_days', days: 30, from: null, to: null, weekStart: null }

interface Answered {
  turnId: string
  conversationId: string
  message: AiMessage
}

async function ask(message: string, as: Session = admin): Promise<{ done: Extract<AiStreamEvent, { type: 'done' }>; conversationId: string }> {
  const res = await app.api<string>('POST', '/api/ai/chat', { token: as.token, body: { message, clientId: randomUUID() } })
  expect(res.status).toBe(200)
  const events = res.body
    .split('\n\n')
    .filter((f) => f && !f.startsWith(':'))
    .map((f) => JSON.parse(f.slice(f.indexOf('data: ') + 6)) as AiStreamEvent)
  const done = events.find((e): e is Extract<AiStreamEvent, { type: 'done' }> => e.type === 'done')
  if (!done) throw new Error(`No answer: ${JSON.stringify(events)}`)
  const start = events.find((e): e is Extract<AiStreamEvent, { type: 'start' }> => e.type === 'start')!
  return { done, conversationId: start.conversation.id }
}

/** A question answered today by running these queries, in order. */
async function answered(question: string, queries: [string, string][] = [['Changes per day', PER_DAY(factoryDay(-29), factoryDay(1))], ['Machines', MACHINES]], as = admin): Promise<Answered> {
  app.model.reply(
    { content: [thinking('Look it up.'), text('Let me look.'), ...queries.map(([purpose, sql]) => runSql(`toolu_${randomUUID().slice(0, 8)}`, purpose, sql))] },
    { content: [text('Here it is.\n\n<suggestions>\n- And last month?\n</suggestions>')] },
  )
  const { done, conversationId } = await ask(question, as)
  return { turnId: done.message.turnId!, conversationId, message: done.message }
}

/** The model's reply to the one call a save makes. */
const proposal = (templates: string[], period: object | null = LAST_30, title = 'Coil changes, last 30 days'): FakeReply => ({
  content: [thinking('Rewriting the bounds.'), text(JSON.stringify({ title, period, sections: templates.map((template, index) => ({ index, template })) }))],
  usage: { input_tokens: 1500, output_tokens: 400 },
})

const save = (body: object, as: Session = admin) => app.api<AiSaveReportResponse & ApiErrorBody>('POST', '/api/ai/reports', { token: as.token, body })
const run = (id: string, query = '', as: Session = admin) => app.api<AiReportRunResponse & ApiErrorBody>('GET', `/api/ai/reports/${id}/run${query}`, { token: as.token })
const exportReport = (id: string, query = '', as: Session = admin) =>
  app.api<AiReportExportResponse & ApiErrorBody>('GET', `/api/ai/reports/${id}/export${query}`, { token: as.token })

/** An audit row as a person's change to a coil would leave it, at 10:00 factory time on a given day. */
async function coilChangeOn(day: string): Promise<void> {
  await app.db.query(
    `INSERT INTO audit_log (at, user_id, user_name, action, entity, entity_id, field, old_value, new_value)
     VALUES (($1::date + time '10:00') AT TIME ZONE 'Africa/Cairo', $2, 'Admin', 'update', 'Coil', 'K-1', 'supplier', 'A', 'B')`,
    [day, admin.user.id],
  )
}

const callsSoFar = () => app.model.calls.length

/** Wait until a condition holds (a request reaching the scripted model), or fail after a few seconds. */
async function until(condition: () => boolean): Promise<void> {
  for (const started = Date.now(); !condition(); ) {
    if (Date.now() - started > 5000) throw new Error('Waited too long.')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** A question asked on an earlier day (its date line says so), answered by running these queries, as the route would have. */
async function answeredOn(askedOn: string, question: string, queries: [string, string][]): Promise<string> {
  const ready = await answered('A conversation to go on in', [['Machines', MACHINES]])
  const conversation = (await findConversation(app.db, ready.conversationId, admin.user.id))!
  const asked = await app.db.query<{ id: string }>(
    `INSERT INTO ai_turns (conversation_id, user_id, client_id, question) VALUES ($1, $2, $3, $4) RETURNING id`,
    [conversation.id, admin.user.id, randomUUID(), question],
  )
  const turnId = asked.rows[0].id
  await appendMessages(app.db, conversation.id, turnId, [
    { role: 'user', kind: 'question', content: [{ type: 'text', text: `<context>Today: ${askedOn} 09:30 (Africa/Cairo)</context>` }, { type: 'text', text: question }] },
  ])
  app.model.reply({ content: queries.map(([purpose, sql], i) => runSql(`toolu_past${i}`, purpose, sql)) }, { content: [text('Here it is.')] })
  const outcome = await answerQuestion({
    db: app.db,
    readers: app.aiReader,
    model: app.model,
    apiKey: KEY,
    config: app.config,
    userId: admin.user.id,
    conversation,
    turnId,
    messages: await loadReplay(app.db, conversation.id),
    modelId: AI_MODEL,
    effort: 'medium',
    emit: () => undefined,
    signal: new AbortController().signal,
  })
  await finishTurn(app.db, turnId, outcome.stopReason, outcome.notice)
  return turnId
}

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  admin = await app.register('admin', 'Admin')
  await app.api('POST', '/api/users', { token: admin.token, body: { username: 'admin2', password: 'Password#1', name: 'Second Admin', role: 'admin' } })
  other = await app.login('admin2')
  // Given the assistant by its owner (admin): reports stay personal all the same, Excel included.
  const granted = await app.api('PUT', `/api/ai/access/${other.user.id}`, {
    token: admin.token,
    body: { enabled: true, domains: ['inspection', 'orders', 'materials', 'audit'], monthlyCapUsd: 50, excel: true },
  })
  expect(granted.status).toBe(200)
  for (const code of ['58', '31']) {
    const made = await app.api('POST', '/api/master/machines', { token: admin.token, body: { code, name: `Machine ${code}`, displayName: `${code}. Machine`, process: 'forming' } })
    expect(made.status).toBe(201)
  }
  for (const offset of [0, -5, -40, -110, -400]) await coilChangeOn(factoryDay(offset))
  const set = await app.api('PUT', '/api/ai/key', { token: admin.token, body: { apiKey: KEY } })
  expect(set.status).toBe(200)
})
afterAll(() => app.stop())
beforeEach(() => {
  for (const s of [admin, other]) {
    app.aiLimiter.reset(s.user.id)
    app.aiReportLimiter.reset(s.user.id)
  }
})

let saved: AiReport
let first: Answered

describe('§20 saving an answer as a report', () => {
  it('refuses what cannot be kept, before any call to Claude', async () => {
    const calls = callsSoFar()
    first = await answered('How many coil changes per day in the last 30 days, and how many machines?')
    expect(callsSoFar()).toBe(calls + 2)
    for (const body of [{}, { turnId: 'nope' }, { turnId: first.turnId, title: '   ' }, { turnId: first.turnId, title: 'x'.repeat(121) }, { turnId: first.turnId, extra: 1 }, { turnId: first.turnId, adjustable: 'yes' }]) {
      expect((await save(body)).status, JSON.stringify(body)).toBe(400)
    }
    expect((await save({ turnId: randomUUID() })).status).toBe(404)
    // Someone else's answer is not found, never a hint that it exists.
    expect((await save({ turnId: first.turnId }, other)).status).toBe(404)

    // An answer still being written.
    const running = await app.db.query<{ id: string }>(
      `INSERT INTO ai_turns (conversation_id, user_id, client_id, question) VALUES ($1, $2, $3, 'Still going') RETURNING id`,
      [first.conversationId, admin.user.id, randomUUID()],
    )
    const stillGoing = await save({ turnId: running.rows[0].id })
    expect(stillGoing.status).toBe(409)
    await finishTurn(app.db, running.rows[0].id, 'stopped', null)

    // An answer whose only query failed has nothing to keep.
    const failed = await answered('Who are the users?', [['Users', 'SELECT name FROM public.users']])
    expect(failed.message.parts.find((p) => p.type === 'query')).toMatchObject({ ok: false })
    const nothing = await save({ turnId: failed.turnId })
    expect(nothing.status).toBe(400)
    expect(nothing.body.error.message).toMatch(/no query that worked/)
    expect(callsSoFar()).toBe(calls + 4)
  })

  it('makes the period adjustable when every template returns what the answer did', async () => {
    app.model.reply(proposal([PER_DAY_TEMPLATE, MACHINES]))
    const calls = callsSoFar()
    const res = await save({ turnId: first.turnId })
    expect(res.status).toBe(201)
    expect(res.body.notice).toBeUndefined()
    // The status's model: the cheapest a question may run on (Models).
    expect(res.body.status).toMatchObject({ available: true, model: 'claude-haiku-5-5' })
    saved = res.body.report
    expect(saved).toEqual({
      id: expect.any(String),
      title: 'Coil changes, last 30 days',
      question: 'How many coil changes per day in the last 30 days, and how many machines?',
      period: { kind: 'last_days', days: 30 },
      adjustable: true,
      sectionCount: 2,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      conversationId: first.conversationId,
      // Kept from an answer: the asker's own, not shared, with no inputs.
      shared: false,
      mine: true,
      ownerName: expect.any(String),
      madeBy: 'answer',
      inputCount: 0,
      inputs: [],
      sections: [
        { title: 'Changes per day', sql: PER_DAY_TEMPLATE },
        // A query with no period stays exactly as it ran.
        { title: 'Machines', sql: MACHINES },
      ],
    })

    // One call: no tools, low effort, JSON in a fixed shape, the question's day and the queries as input.
    expect(callsSoFar()).toBe(calls + 1)
    const call = app.model.calls[calls]
    expect(call.apiKey).toBe(KEY)
    expect(call.params).toMatchObject({
      model: AI_MODEL,
      max_tokens: 8000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low', format: { type: 'json_schema', schema: TEMPLATE_SCHEMA } },
    })
    expect(call.params).not.toHaveProperty('tools')
    expect(JSON.parse(call.params.messages[0].content as string)).toEqual({
      question: saved.question,
      today: factoryDay(0),
      sections: [
        { index: 0, purpose: 'Changes per day', sql: PER_DAY(factoryDay(-29), factoryDay(1)) },
        { index: 1, purpose: 'Machines', sql: MACHINES },
      ],
    })

    // Counted in the month's spend, against the answer it came from.
    const usage = await app.db.query(`SELECT input_tokens, output_tokens, partial FROM ai_usage WHERE turn_id = $1 ORDER BY id`, [first.turnId])
    expect(usage.rows).toHaveLength(3)
    expect(usage.rows[2]).toEqual({ input_tokens: 1500, output_tokens: 400, partial: false })

    // In the audit log as which report was made, never by its title.
    const audit = await app.db.query(`SELECT action, field, old_value, new_value, user_name FROM audit_log WHERE entity = 'AiReport' AND entity_id = $1`, [saved.id])
    expect(audit.rows).toEqual([{ action: 'create', field: null, old_value: null, new_value: null, user_name: 'Admin' }])

    // The answer now says where it was saved.
    const shown = await app.api<AiMessagesResponse>('GET', `/api/ai/conversations/${first.conversationId}/messages`, { token: admin.token })
    expect(shown.body.messages.find((m) => m.role === 'assistant' && m.turnId === first.turnId)).toMatchObject({ savedReportId: saved.id, suggestions: ['And last month?'] })
    expect((await app.api<AiReport>('GET', `/api/ai/reports/${saved.id}`, { token: admin.token })).body).toEqual(saved)
  })

  it('saves an answer once: asked again, it is the report already made, with no call to Claude', async () => {
    const calls = callsSoFar()
    const again = await save({ turnId: first.turnId, title: 'Another title' })
    expect(again.status).toBe(200)
    expect(again.body.report).toEqual(saved)
    expect(callsSoFar()).toBe(calls)
  })

  it('names the report as the person asked, over Claude’s title', async () => {
    const a = await answered('Coil changes again, last 30 days?')
    app.model.reply(proposal([PER_DAY_TEMPLATE, MACHINES]))
    const res = await save({ turnId: a.turnId, title: '  My   coil report ' })
    expect(res.status).toBe(201)
    expect(res.body.report).toMatchObject({ title: 'My coil report', adjustable: true })
  })

  it('resolves the period at the day the question was asked, not the day it is saved', async () => {
    // A question asked a hundred days ago, as the route stores one, answered by the loop.
    const askedOn = factoryDay(-100)
    const turnId = await answeredOn(askedOn, 'Changes in the last 30 days?', [['Changes per day', PER_DAY(factoryDay(-129), factoryDay(-99))]])

    const calls = callsSoFar()
    app.model.reply(proposal([PER_DAY_TEMPLATE]))
    const res = await save({ turnId })
    expect(JSON.parse(app.model.calls[calls].params.messages[0].content as string).today).toBe(askedOn)
    // Filled with the 30 days up to that day, the template finds the one change the query found.
    expect(res.status).toBe(201)
    expect(res.body.report).toMatchObject({ adjustable: true, period: { kind: 'last_days', days: 30 } })
    expect(res.body.notice).toBeUndefined()
    const now = await run(res.body.report.id)
    expect(now.body.period).toEqual({ from: factoryDay(-29), to: factoryDay(0), label: 'Last 30 days', overridden: false })
    expect(now.body.sections[0].rows).toEqual([[factoryDay(-5), 1], [factoryDay(0), 1]])
  })

  it('keeps the period as asked when a template does not return what the answer did', async () => {
    const a = await answered('Coil changes per day, last 30 days?')
    // An exclusive end left without its + 1: today's change drops out.
    app.model.reply(proposal([PER_DAY_TEMPLATE.replace('{{to}} + 1', '{{to}}'), MACHINES]))
    const res = await save({ turnId: a.turnId })
    expect(res.status).toBe(201)
    expect(res.body.notice).toBe(FIXED_NOTICE.mismatch('Changes per day'))
    expect(res.body.notice).toBe('The period is kept as asked: the adjustable version of “Changes per day” did not return the same result as the answer.')
    expect(res.body.report).toMatchObject({
      title: 'Coil changes, last 30 days',
      period: null,
      adjustable: false,
      sections: [
        { title: 'Changes per day', sql: PER_DAY(factoryDay(-29), factoryDay(1)) },
        { title: 'Machines', sql: MACHINES },
      ],
    })
  })

  it('keeps the period as asked when a template does not take its days from the period alone', async () => {
    // Each would pass a run at the question's own days, where no change lies past today; over other days each shows wrong numbers.
    for (const template of [
      // "Since a week ago": the lower bound alone; rows after the last day chosen would show.
      PER_DAY_TEMPLATE.replace(' AND at < {{to}} + 1', ''),
      // One bound forgotten as the question's date.
      PER_DAY_TEMPLATE.replace('{{to}} + 1', `'${factoryDay(1)}'`),
      // The question's days kept, and the placeholders compared with each other.
      PER_DAY(factoryDay(-29), factoryDay(1)).replace('GROUP BY', 'AND {{from}} <= {{to}} GROUP BY'),
      // A bound left to the clock.
      PER_DAY_TEMPLATE.replace('{{from}}', 'current_date - 29'),
      PER_DAY_TEMPLATE.replace('{{to}} + 1', 'current_date + 1'),
    ]) {
      const a = await answered('Coil changes per day, last 30 days, once again?')
      app.model.reply(proposal([template, MACHINES]))
      const res = await save({ turnId: a.turnId })
      expect(res.status, template).toBe(201)
      expect(res.body.notice, template).toBe(FIXED_NOTICE.notFromPeriod('Changes per day'))
      expect(res.body.report, template).toMatchObject({ adjustable: false, period: null, sections: [{ sql: PER_DAY(factoryDay(-29), factoryDay(1)) }, { sql: MACHINES }] })
    }
  })

  it('keeps the period as asked when a query left as it ran still counts days of its own', async () => {
    const total = (from: string, toExclusive: string) => `SELECT count(*)::int AS changes FROM ai.audit_log WHERE entity = 'Coil' AND at >= '${from}' AND at < '${toExclusive}'`
    for (const kept of [total(factoryDay(-29), factoryDay(1)), "SELECT count(*)::int AS changes FROM ai.audit_log WHERE entity = 'Coil' AND at >= current_date - 29"]) {
      const a = await answered('Coil changes per day and in all, last 30 days?', [['Changes per day', PER_DAY(factoryDay(-29), factoryDay(1))], ['Total changes', kept]])
      // The per-day query made a template; the total, limited to the same days, left as it ran: run over other days, the two would disagree.
      app.model.reply(proposal([PER_DAY_TEMPLATE, kept]))
      const res = await save({ turnId: a.turnId })
      expect(res.status, kept).toBe(201)
      expect(res.body.notice, kept).toBe(FIXED_NOTICE.ownDays('Total changes'))
      expect(res.body.report, kept).toMatchObject({ adjustable: false, period: null, sections: [{ sql: PER_DAY(factoryDay(-29), factoryDay(1)) }, { sql: kept }] })
    }
  })

  it('keeps the period as asked when the answer found nothing a wrong template would not find too', async () => {
    const nobody = (sql: string) => sql.replace("entity = 'Coil'", "entity = 'Nobody'")
    const count = (from: string, toExclusive: string) => `SELECT count(*)::int AS changes FROM ai.audit_log WHERE entity = 'Nobody' AND at >= '${from}' AND at < '${toExclusive}'`
    const cases: [string, string][] = [
      [nobody(PER_DAY(factoryDay(-29), factoryDay(1))), nobody(PER_DAY_TEMPLATE)],
      // Bounds the wrong way round return nothing anywhere: with an answer of nothing, they would pass.
      [nobody(PER_DAY(factoryDay(-29), factoryDay(1))), nobody(PER_DAY_TEMPLATE).replace('at >= {{from}} AND at < {{to}} + 1', 'at >= {{to}} + 1 AND at < {{from}}')],
      // A count of nothing is what days with no data give too.
      [count(factoryDay(-29), factoryDay(1)), `SELECT count(*)::int AS changes FROM ai.audit_log WHERE entity = 'Nobody' AND at >= {{from}} AND at < {{to}} + 1`],
    ]
    for (const [original, template] of cases) {
      const a = await answered('Changes nobody made in the last 30 days?', [['Changes', original]])
      app.model.reply(proposal([template]))
      const res = await save({ turnId: a.turnId })
      expect(res.status, template).toBe(201)
      expect(res.body.notice, template).toBe(FIXED_NOTICE.unproven('Changes'))
      expect(res.body.report, template).toMatchObject({ adjustable: false, period: null, sections: [{ sql: original }] })
    }
  })

  it('checks a query that counts from the clock against the period as it stands the day it is saved', async () => {
    // Asked three days ago; run now, "the last 7 days" of the query are the last 7 days up to today.
    const relative = `SELECT day::text AS day, count(*)::int AS changes FROM ai.audit_log WHERE entity = 'Coil' AND at >= current_date - 6 AND at < current_date + 1 GROUP BY day ORDER BY day`
    const lastWeek = { kind: 'last_days', days: 7, from: null, to: null, weekStart: null }
    const right = await answeredOn(factoryDay(-3), 'Coil changes per day in the last 7 days?', [['Changes per day', relative]])
    app.model.reply(proposal([PER_DAY_TEMPLATE], lastWeek, 'Coil changes, last 7 days'))
    const kept = await save({ turnId: right })
    expect(kept.status).toBe(201)
    expect(kept.body.notice).toBeUndefined()
    expect(kept.body.report).toMatchObject({ adjustable: true, period: { kind: 'last_days', days: 7 }, sections: [{ sql: PER_DAY_TEMPLATE }] })
    expect((await run(kept.body.report.id)).body.sections[0].rows).toEqual([[factoryDay(-5), 1], [factoryDay(0), 1]])

    // A template that kept the clock for its end matches the query run now, and is refused all the same.
    const wrong = await answeredOn(factoryDay(-3), 'Coil changes per day in the last 7 days, again?', [['Changes per day', relative]])
    app.model.reply(proposal([PER_DAY_TEMPLATE.replace('{{to}} + 1', 'current_date + 1')], lastWeek))
    const refused = await save({ turnId: wrong })
    expect(refused.body.notice).toBe(FIXED_NOTICE.notFromPeriod('Changes per day'))
    expect(refused.body.report).toMatchObject({ adjustable: false, sections: [{ sql: relative }] })
  })

  it('makes one call to Claude for an answer saved twice at once, and keeps one report', async () => {
    const a = await answered('Coil changes, saved from two tabs at once?')
    let release = () => {}
    app.model.reply({ ...proposal([PER_DAY_TEMPLATE, MACHINES]), hold: new Promise<void>((resolve) => (release = resolve)) })
    const calls = callsSoFar()
    const first = save({ turnId: a.turnId })
    // The first save is with Claude; the second arrives while it is.
    await until(() => callsSoFar() === calls + 1)
    const second = save({ turnId: a.turnId })
    await new Promise((resolve) => setTimeout(resolve, 150))
    release()
    const [one, two] = await Promise.all([first, second])
    expect([one.status, two.status]).toEqual([201, 200])
    expect(two.body.report).toEqual(one.body.report)
    expect(one.body.report.adjustable).toBe(true)
    expect(callsSoFar()).toBe(calls + 1)
    // The answer's two calls, and the one save.
    const usage = await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ai_usage WHERE turn_id = $1`, [a.turnId])
    expect(usage.rows[0].n).toBe(3)
    expect((await app.db.query(`SELECT 1 FROM ai_reports WHERE turn_id = $1`, [a.turnId])).rowCount).toBe(1)
  })

  it('keeps the period as asked when Claude fails or answers in a way that cannot be used', async () => {
    const failing = await answered('Coil changes, once more?')
    app.model.reply({ content: [text('{"title": "Ha')], error: apiError(500, 'boom') })
    const failed = await save({ turnId: failing.turnId })
    expect(failed.status).toBe(201)
    expect(failed.body.notice).toBe(FIXED_NOTICE.model)
    expect(failed.body.report).toMatchObject({ adjustable: false, period: null, title: 'Coil changes, once more?' })
    // What the failed call used is counted all the same.
    const usage = await app.db.query(`SELECT partial FROM ai_usage WHERE turn_id = $1 ORDER BY id`, [failing.turnId])
    expect(usage.rows.map((r) => r.partial)).toEqual([false, false, true])

    const refusedKey = await answered('Coil changes with a revoked key?')
    app.model.reply({ error: apiError(401, 'invalid x-api-key') })
    const revoked = await save({ turnId: refusedKey.turnId })
    expect(revoked.body.notice).toBe(FIXED_NOTICE.unavailable)
    expect(JSON.stringify(revoked.body)).not.toContain('invalid x-api-key')

    for (const reply of [
      { content: [text('Sure! Here are the templates.')] },
      { content: [text(JSON.stringify({ title: 'T', period: LAST_30, sections: [{ index: 0, template: PER_DAY_TEMPLATE }] }))] },
      { content: [text('{}')], stopReason: 'refusal' as const },
    ]) {
      const a = await answered('Coil changes, yet again?')
      app.model.reply(reply)
      const res = await save({ turnId: a.turnId })
      expect(res.status).toBe(201)
      expect(res.body.notice).toBe(FIXED_NOTICE.unusable)
      expect(res.body.report.adjustable).toBe(false)
    }
  })

  it('keeps nothing but placeholders standing on their own, and runs nothing but one SELECT', async () => {
    const users = async () => (await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM users`)).rows[0].n
    const before = await users()
    const cases: [string, string][] = [
      [PER_DAY_TEMPLATE.replace('ORDER BY day', 'ORDER BY day; DELETE FROM users'), FIXED_NOTICE.templateFails('Changes per day')],
      [PER_DAY_TEMPLATE.replace('{{from}}', '{{since}}'), FIXED_NOTICE.form],
      [PER_DAY_TEMPLATE.replace('{{from}}', '{{ from }}'), FIXED_NOTICE.form],
      [PER_DAY_TEMPLATE.replace('{{from}}', "'{{from}}'"), FIXED_NOTICE.form],
      [PER_DAY_TEMPLATE.replace('{{to}} + 1', "{{to}}'::date + 1"), FIXED_NOTICE.form],
      [PER_DAY_TEMPLATE.replace('ORDER BY day', 'ORDER BY day -- {{to}}'), FIXED_NOTICE.form],
      // A period, and no placeholder in any query.
      [PER_DAY(factoryDay(-29), factoryDay(1)), FIXED_NOTICE.noPlaceholder],
    ]
    for (const [template, notice] of cases) {
      const a = await answered('Coil changes per day?')
      app.model.reply(proposal([template, MACHINES]))
      const res = await save({ turnId: a.turnId })
      expect(res.status, template).toBe(201)
      expect(res.body.notice, template).toBe(notice)
      expect(res.body.report.sections[0].sql).toBe(PER_DAY(factoryDay(-29), factoryDay(1)))
    }
    expect(await users()).toBe(before)
  })

  it('saves a question with no period as it ran, with nothing to say about it', async () => {
    const a = await answered('How many machines?', [['Machines', MACHINES]])
    app.model.reply(proposal([MACHINES], null, 'Machines'))
    const res = await save({ turnId: a.turnId })
    expect(res.status).toBe(201)
    expect(res.body.notice).toBeUndefined()
    expect(res.body.report).toMatchObject({ title: 'Machines', period: null, adjustable: false, sections: [{ title: 'Machines', sql: MACHINES }] })
  })

  it('refuses the call to Claude at the cap, and saves the report as it ran without one', async () => {
    const a = await answered('Coil changes near the cap?')
    const status = (await app.api<AiStatusResponse>('GET', '/api/ai/status', { token: admin.token })).body
    // Room for a few cents, not for the 8 000 tokens the call may write.
    await app.api('PUT', '/api/ai/settings', { token: admin.token, body: { enabled: true, monthlyCapUsd: Math.ceil((status.spentUsd + 0.03) * 100) / 100 } })
    try {
      const calls = callsSoFar()
      const refused = await save({ turnId: a.turnId })
      expect(refused.status).toBe(402)
      expect(refused.body.error).toMatchObject({ code: 'ai_budget_reached', message: expect.stringMatching(/Save it with its period as asked instead/) })
      expect((await app.db.query(`SELECT 1 FROM ai_reports WHERE turn_id = $1`, [a.turnId])).rowCount).toBe(0)

      const asRan = await save({ turnId: a.turnId, adjustable: false })
      expect(asRan.status).toBe(201)
      expect(asRan.body.notice).toBeUndefined()
      expect(asRan.body.report).toMatchObject({ adjustable: false, period: null, sections: [{ sql: PER_DAY(factoryDay(-29), factoryDay(1)) }, { sql: MACHINES }] })
      expect(callsSoFar()).toBe(calls)
    } finally {
      await app.api('PUT', '/api/ai/settings', { token: admin.token, body: { enabled: true, monthlyCapUsd: 50 } })
    }
  })

  it('saves the report as it ran, and says why, when the assistant cannot ask Claude', async () => {
    const a = await answered('Coil changes with no key?')
    const b = await answered('Coil changes while switched off?')
    await app.api('DELETE', '/api/ai/key', { token: admin.token })
    const calls = callsSoFar()
    try {
      const res = await save({ turnId: a.turnId })
      expect(res.status).toBe(201)
      expect(res.body.notice).toBe(FIXED_NOTICE.unavailable)
    } finally {
      await app.api('PUT', '/api/ai/key', { token: admin.token, body: { apiKey: KEY } })
    }
    await app.api('PUT', '/api/ai/settings', { token: admin.token, body: { enabled: false, monthlyCapUsd: 50 } })
    try {
      const res = await save({ turnId: b.turnId })
      expect(res.body.notice).toBe(FIXED_NOTICE.unavailable)
      // Switched off, a report still runs: it costs nothing.
      expect((await run(res.body.report.id)).status).toBe(200)
    } finally {
      await app.api('PUT', '/api/ai/settings', { token: admin.token, body: { enabled: true, monthlyCapUsd: 50 } })
    }
    expect(callsSoFar()).toBe(calls)
  })
})

describe('§20 running a report', () => {
  it('runs the saved period counted from today, with no call to Claude', async () => {
    const calls = callsSoFar()
    const res = await run(saved.id)
    expect(res.status).toBe(200)
    expect(res.body.period).toEqual({ from: factoryDay(-29), to: factoryDay(0), label: 'Last 30 days', overridden: false })
    expect(res.body.sections).toEqual([
      { title: 'Changes per day', ok: true, columns: ['day', 'changes'], rows: [[factoryDay(-5), 1], [factoryDay(0), 1]], rowCount: 2, truncated: false, ms: expect.any(Number) },
      { title: 'Machines', ok: true, columns: ['machines'], rows: [[2]], rowCount: 1, truncated: false, ms: expect.any(Number) },
    ])
    expect(Date.now() - Date.parse(res.body.ranAt)).toBeLessThan(60_000)
    expect(callsSoFar()).toBe(calls)
    // Stamped as run, without moving it in the list (a rename does).
    expect(res.body.report.lastRunAt).toEqual(expect.any(String))
    expect(res.body.report.updatedAt).toBe(saved.updatedAt)
    const list = await app.api<AiReportsResponse>('GET', '/api/ai/reports', { token: admin.token })
    expect(list.body.reports.find((r) => r.id === saved.id)).toMatchObject({ lastRunAt: res.body.report.lastRunAt, updatedAt: saved.updatedAt })
  })

  it('runs over the days asked for, for that run only', async () => {
    const from = factoryDay(-500)
    const to = factoryDay(-35)
    const res = await run(saved.id, `?from=${from}&to=${to}`)
    expect(res.status).toBe(200)
    expect(res.body.period).toEqual({ from, to, label: describeAiDays({ from, to }), overridden: true })
    expect(res.body.sections[0].rows).toEqual([[factoryDay(-400), 1], [factoryDay(-110), 1], [factoryDay(-40), 1]])
    // Nothing of it is kept: the next run is the saved period again.
    expect((await run(saved.id)).body.period).toMatchObject({ overridden: false, label: 'Last 30 days' })
    expect((await app.api<AiReport>('GET', `/api/ai/reports/${saved.id}`, { token: admin.token })).body.period).toEqual({ kind: 'last_days', days: 30 })
  })

  it('takes only two real days in order, within ten years, and only for a report whose period can change', async () => {
    for (const query of [
      `?from=${factoryDay(-10)}`,
      `?to=${factoryDay(-10)}`,
      `?from=${factoryDay(-1)}&to=${factoryDay(-10)}`,
      '?from=2026-02-30&to=2026-03-01',
      '?from=2026-9-1&to=2026-09-30',
      `?from=${encodeURIComponent("2026-09-01'; DROP TABLE users; --")}&to=2026-09-30`,
      `?from=2026-09-01&to=${encodeURIComponent("2026-09-30' OR '1'='1")}`,
      '?from=2016-01-01&to=2026-01-08',
      '?from=2026-09-01&from=2026-09-02&to=2026-09-30',
    ]) {
      const res = await run(saved.id, query)
      expect(res.status, query).toBe(400)
      expect(res.body.error.code, query).toBe('validation')
    }
    expect((await run(saved.id, '?from=2016-01-01&to=2026-01-07')).status).toBe(200)

    const fixed = (await app.api<AiReportsResponse>('GET', '/api/ai/reports?limit=100', { token: admin.token })).body.reports.find((r) => !r.adjustable)!
    const res = await run(fixed.id, '?from=2026-09-01&to=2026-09-30')
    expect(res.status).toBe(400)
    expect(res.body.error.message).toMatch(/period cannot be changed/)
    const asIs = await run(fixed.id)
    expect(asIs.status).toBe(200)
    expect(asIs.body.period).toBeNull()
  })

  it('exports every section in full, over the same days', async () => {
    const res = await exportReport(saved.id, `?from=${factoryDay(-500)}&to=${factoryDay(0)}`)
    expect(res.status).toBe(200)
    expect(res.body.report.id).toBe(saved.id)
    expect(res.body.period).toMatchObject({ from: factoryDay(-500), to: factoryDay(0), overridden: true })
    expect(res.body.sections).toEqual([
      {
        title: 'Changes per day',
        ok: true,
        columns: ['day', 'changes'],
        rows: [[factoryDay(-400), 1], [factoryDay(-110), 1], [factoryDay(-40), 1], [factoryDay(-5), 1], [factoryDay(0), 1]],
        truncated: false,
      },
      { title: 'Machines', ok: true, columns: ['machines'], rows: [[2]], truncated: false },
    ])
  })

  it('shows a section that fails as failed, and runs the rest', async () => {
    const a = await answered('Machines and the time?', [['Machines', MACHINES], ['Clock', 'SELECT now() AS at']])
    app.model.reply(proposal([MACHINES, 'SELECT now() AS at'], null))
    const report = (await save({ turnId: a.turnId })).body.report
    // A view renamed since: the stored query no longer runs.
    await app.db.query(`UPDATE ai_reports SET sections = $2::json WHERE id = $1`, [report.id, JSON.stringify([{ title: 'Gone', sql: 'SELECT * FROM ai.no_such_view' }, report.sections[1]])])
    const res = await run(report.id)
    expect(res.status).toBe(200)
    expect(res.body.sections[0]).toMatchObject({ title: 'Gone', ok: false, error: expect.stringMatching(/does not exist/), rows: [], columns: [] })
    expect(res.body.sections[1]).toMatchObject({ title: 'Clock', ok: true, rowCount: 1 })
  })

  it('limits how many runs one person makes in a short time', async () => {
    for (let i = 0; i < 59; i++) app.aiReportLimiter.hit(admin.user.id)
    expect((await run(saved.id)).status).toBe(200)
    const limited = await exportReport(saved.id)
    expect(limited.status).toBe(429)
    expect(limited.body.error.code).toBe('rate_limited')
    // Per person.
    expect((await run(saved.id, '', other)).status).toBe(404)
  })
})

describe('§20 a report keeps its charts', () => {
  it('draws each section as the answer drew it, from every run’s own rows', async () => {
    const chart = { type: 'bar', x: 'day', y: ['changes'], title: 'Changes per day', goal: 1 }
    app.model.reply(
      { content: [text('Let me look.'), runSql('toolu_chart1', 'Changes per day', PER_DAY(factoryDay(-29), factoryDay(1)), chart)] },
      { content: [text('Here it is.')] },
    )
    const { done } = await ask('Coil changes per day, with a chart')
    const madeIt = await save({ turnId: done.message.turnId, adjustable: false })
    expect(madeIt.status).toBe(201)
    expect(madeIt.body.report.sections).toEqual([{ title: 'Changes per day', sql: PER_DAY(factoryDay(-29), factoryDay(1)), chart }])
    const ran = await run(madeIt.body.report.id)
    expect(ran.status).toBe(200)
    expect(ran.body.sections[0].chart).toEqual(chart)
  })
})

describe('§20 reports are personal', () => {
  it('hides one administrator’s reports from another, and from everyone else', async () => {
    const id = saved.id
    expect((await app.api<AiReportsResponse>('GET', '/api/ai/reports', { token: other.token })).body).toEqual({ reports: [], hasMore: false })
    expect((await app.api('GET', `/api/ai/reports/${id}`, { token: other.token })).status).toBe(404)
    expect((await app.api('PATCH', `/api/ai/reports/${id}`, { token: other.token, body: { title: 'Mine now' } })).status).toBe(404)
    expect((await app.api('DELETE', `/api/ai/reports/${id}`, { token: other.token })).status).toBe(404)
    expect((await run(id, '', other)).status).toBe(404)
    expect((await exportReport(id, '', other)).status).toBe(404)
    expect((await app.api<AiReport>('GET', `/api/ai/reports/${id}`, { token: admin.token })).body.title).toBe('Coil changes, last 30 days')

    await app.api('POST', '/api/users', { token: admin.token, body: { username: 'insp', password: 'Password#1', name: 'Inspector', role: 'inspector' } })
    const inspector = await app.login('insp')
    for (const [method, path] of [
      ['GET', '/api/ai/reports'],
      ['GET', `/api/ai/reports/${id}`],
      ['GET', `/api/ai/reports/${id}/run`],
      ['POST', '/api/ai/reports'],
    ] as const) {
      expect((await app.api(method, path, { token: inspector.token, body: method === 'POST' ? { turnId: first.turnId } : undefined })).status, path).toBe(403)
    }
  })

  it('lists the person’s reports, last changed first, a page at a time, and finds them by title or question', async () => {
    const all = (await app.api<AiReportsResponse>('GET', '/api/ai/reports?limit=100', { token: admin.token })).body
    expect(all.reports.length).toBeGreaterThan(5)
    const updated = all.reports.map((r) => r.updatedAt)
    expect([...updated].sort().reverse()).toEqual(updated)
    expect(all.reports[0]).not.toHaveProperty('sections')
    expect(all.reports.find((r) => r.id === saved.id)).toMatchObject({ sectionCount: 2, adjustable: true, period: { kind: 'last_days', days: 30 } })
    const page = (await app.api<AiReportsResponse>('GET', '/api/ai/reports?limit=2', { token: admin.token })).body
    expect(page).toEqual({ reports: all.reports.slice(0, 2), hasMore: true })
    const next = (await app.api<AiReportsResponse>('GET', `/api/ai/reports?limit=2&before=${encodeURIComponent(page.reports[1].updatedAt)}`, { token: admin.token })).body
    expect(next.reports).toEqual(all.reports.slice(2, 4))
    const found = (await app.api<AiReportsResponse>('GET', `/api/ai/reports?q=${encodeURIComponent('MY COIL')}`, { token: admin.token })).body
    expect(found.reports.map((r) => r.title)).toEqual(['My coil report'])
    const byQuestion = (await app.api<AiReportsResponse>('GET', `/api/ai/reports?q=${encodeURIComponent('near the cap')}`, { token: admin.token })).body
    expect(byQuestion.reports.map((r) => r.question)).toEqual(['Coil changes near the cap?'])
    // A search is text, not a pattern.
    expect((await app.api<AiReportsResponse>('GET', `/api/ai/reports?q=${encodeURIComponent('%')}`, { token: admin.token })).body.reports).toEqual([])
  })

  it('reaches every report a page at a time, even two changed in the same millisecond', async () => {
    // Every report of the person changed at one instant: only the id tells them apart.
    await app.db.query(`UPDATE ai_reports SET updated_at = '2026-10-01T08:00:00.123456Z' WHERE user_id = $1 AND deleted_at IS NULL`, [admin.user.id])
    const all = (await app.api<AiReportsResponse>('GET', '/api/ai/reports?limit=100', { token: admin.token })).body.reports
    const seen: string[] = []
    let cursor = ''
    for (let guard = 0; guard < 50; guard++) {
      const page = (await app.api<AiReportsResponse>('GET', `/api/ai/reports?limit=2${cursor}`, { token: admin.token })).body
      seen.push(...page.reports.map((r) => r.id))
      if (!page.hasMore) break
      const end = page.reports[page.reports.length - 1]
      cursor = `&before=${encodeURIComponent(end.updatedAt)}&beforeId=${end.id}`
    }
    expect(seen).toEqual(all.map((r) => r.id))
    expect(new Set(seen).size).toBe(all.length)
  })

  it('renames a report, in the audit log as a new title without the words', async () => {
    const res = await app.api<AiReport>('PATCH', `/api/ai/reports/${saved.id}`, { token: admin.token, body: { title: '  Coil   changes  ' } })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ id: saved.id, title: 'Coil changes', sections: saved.sections })
    expect(res.body.updatedAt > saved.updatedAt).toBe(true)
    // The same title again changes nothing.
    expect((await app.api('PATCH', `/api/ai/reports/${saved.id}`, { token: admin.token, body: { title: 'Coil changes' } })).status).toBe(200)
    for (const body of [{ title: '' }, { title: '   ' }, { title: 'x'.repeat(121) }, {}, { title: 'ok', sections: [] }]) {
      expect((await app.api('PATCH', `/api/ai/reports/${saved.id}`, { token: admin.token, body })).status, JSON.stringify(body)).toBe(400)
    }
    const audit = await app.db.query(`SELECT action, field, old_value, new_value FROM audit_log WHERE entity = 'AiReport' AND entity_id = $1 ORDER BY id`, [saved.id])
    expect(audit.rows).toEqual([
      { action: 'create', field: null, old_value: null, new_value: null },
      { action: 'update', field: 'title', old_value: null, new_value: null },
    ])
  })

  it('deletes a report from the list, keeping its record, and the answer can be saved again', async () => {
    expect((await app.api('DELETE', `/api/ai/reports/${saved.id}`, { token: admin.token })).status).toBe(204)
    expect((await app.api('GET', `/api/ai/reports/${saved.id}`, { token: admin.token })).status).toBe(404)
    expect((await run(saved.id)).status).toBe(404)
    expect((await app.api('DELETE', `/api/ai/reports/${saved.id}`, { token: admin.token })).status).toBe(404)
    const list = (await app.api<AiReportsResponse>('GET', '/api/ai/reports?limit=100', { token: admin.token })).body
    expect(list.reports.map((r) => r.id)).not.toContain(saved.id)
    const audit = await app.db.query(`SELECT action, field, old_value FROM audit_log WHERE entity = 'AiReport' AND entity_id = $1 AND action = 'delete'`, [saved.id])
    expect(audit.rows).toEqual([{ action: 'delete', field: null, old_value: null }])
    await expect(app.db.query(`DELETE FROM ai_reports WHERE id = $1`, [saved.id])).rejects.toThrow(/Hard delete is not allowed/)

    // The answer no longer points at it, and can be kept again.
    const shown = await app.api<AiMessagesResponse>('GET', `/api/ai/conversations/${first.conversationId}/messages`, { token: admin.token })
    expect(shown.body.messages.find((m) => m.role === 'assistant')).not.toHaveProperty('savedReportId')
    const again = await save({ turnId: first.turnId, adjustable: false })
    expect(again.status).toBe(201)
    expect(again.body.report.id).not.toBe(saved.id)
  })

  it('keeps a report, and so its title (often the question word for word), out of the audit log anyone but the owner reads', async () => {
    const question = 'Which inspector has the worst error rate, to decide whom to let go?'
    const a = await answered(question)
    const res = await save({ turnId: a.turnId, adjustable: false })
    expect(res.status).toBe(201)
    const id = res.body.report.id
    expect(res.body.report.title).toBe(question)
    expect((await app.api('PATCH', `/api/ai/reports/${id}`, { token: admin.token, body: { title: 'Error rates before the layoffs' } })).status).toBe(200)
    expect((await app.api('DELETE', `/api/ai/reports/${id}`, { token: admin.token })).status).toBe(204)

    await app.api('POST', '/api/users', { token: admin.token, body: { username: 'super', password: 'Password#1', name: 'Supervisor', role: 'supervisor' } })
    const supervisor = await app.login('super')
    expect((await app.api('GET', '/api/ai/reports', { token: supervisor.token })).status).toBe(403)
    // A supervisor reads the log, but not the assistant's entries: reports are personal.
    const log = await app.api<AuditListResponse>('GET', '/api/audit?entity=AiReport&limit=2000', { token: supervisor.token })
    expect(log.status).toBe(200)
    expect(log.body.entries).toEqual([])
    // The owner sees what was done to which report, by whom: nothing of what it is called.
    const owners = await app.api<AuditListResponse>('GET', '/api/audit?entity=AiReport&limit=2000', { token: admin.token })
    expect(owners.body.entries.filter((e) => e.entityId === id).map((e) => [e.action, e.userName, e.field ?? null, e.oldValue ?? null, e.newValue ?? null])).toEqual([
      ['delete', 'Admin', null, null, null],
      ['update', 'Admin', 'title', null, null],
      ['create', 'Admin', null, null, null],
    ])
    expect(JSON.stringify(owners.body)).not.toMatch(/let go|layoffs/i)
    // Nor does a search of the log find it by its words.
    for (const q of ['let go', 'layoffs']) {
      const found = await app.api<AuditListResponse>('GET', `/api/audit?q=${encodeURIComponent(q)}`, { token: supervisor.token })
      expect(found.body.entries, q).toEqual([])
    }
  })

  it('never puts a title or SQL in the audit log, and leaves the reports’ entries out of what the assistant reads', async () => {
    const audit = await app.db.query<{ v: string | null }>(`SELECT COALESCE(old_value, new_value) AS v FROM audit_log WHERE entity = 'AiReport'`)
    expect(audit.rows.length).toBeGreaterThan(5)
    for (const r of audit.rows) expect(r.v).toBeNull()
    const read = await runReadOnlyQuery(app.aiReader.pool, `SELECT count(*)::int AS n FROM ai.audit_log WHERE entity = 'AiReport'`, { maxRows: 10, timeoutMs: 10_000, timeZone: 'Africa/Cairo' })
    expect(read).toMatchObject({ ok: true, rows: [[0]] })
    const coils = await runReadOnlyQuery(app.aiReader.pool, `SELECT count(*)::int AS n FROM ai.audit_log WHERE entity = 'Coil'`, { maxRows: 10, timeoutMs: 10_000, timeZone: 'Africa/Cairo' })
    expect(coils.rows).toEqual([[5]])
  })

  it('gives the assistant’s database reader no way into the reports', async () => {
    const role = app.aiReader.role!
    const { rows } = await app.db.query<{ can: boolean }>(`SELECT has_table_privilege($1, 'public.ai_reports', 'SELECT, INSERT, UPDATE, DELETE') AS can`, [role])
    expect(rows[0].can).toBe(false)
    const res = await runReadOnlyQuery(app.aiReader.pool, 'SELECT title, sections FROM public.ai_reports', { maxRows: 10, timeoutMs: 10_000, timeZone: 'Africa/Cairo' })
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/permission denied/) })
  })
})
