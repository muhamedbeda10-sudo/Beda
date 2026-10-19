import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { AI_JOBS, type AiAnswerReportTitleResponse, type AiStreamEvent } from '@qc/shared/ai'
import type { ApiErrorBody } from '@qc/shared/api'
import { TestApp, type Session } from './harness'
import { text } from './aiFake'
import { REPORT_TITLE_FALLBACK, REPORT_TITLE_SYSTEM, reportTitleRequest } from '../src/ai/answerReportTitle'

// §20 — an answer printed goes out as a report under a title that names what
// it shows, never the question as typed: named by the assistant the first time
// it is printed and kept; a stand-in, not kept, while it cannot be named.

const app = new TestApp()
let admin: Session
let other: Session
const KEY = `sk-ant-api03-${'k_9-'.repeat(20)}LaSt`

/** Ask a question the scripted model answers with `answer`: the answer's turn and its conversation. */
async function ask(question: string, answer: string): Promise<{ turnId: string; conversationId: string }> {
  app.aiLimiter.reset(admin.user.id)
  app.model.reply({ content: [text(answer)] })
  const res = await app.api<string>('POST', '/api/ai/chat', { token: admin.token, body: { message: question, clientId: randomUUID() } })
  expect(res.status).toBe(200)
  const start = res.body
    .split('\n\n')
    .filter((f) => f.startsWith('event: start'))
    .map((f) => JSON.parse(f.slice(f.indexOf('data: ') + 6)) as Extract<AiStreamEvent, { type: 'start' }>)[0]
  return { turnId: start.turnId!, conversationId: start.conversation.id }
}

const titleOf = (turnId: string, as = admin) => app.api<AiAnswerReportTitleResponse & ApiErrorBody>('POST', `/api/ai/turns/${turnId}/report-title`, { token: as.token })

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  admin = await app.register('admin', 'Admin')
  await app.api('POST', '/api/users', { token: admin.token, body: { username: 'admin2', password: 'Password#1', name: 'Second Admin', role: 'admin' } })
  other = await app.login('admin2')
  expect((await app.api('PUT', `/api/ai/access/${other.user.id}`, { token: admin.token, body: { enabled: true, domains: ['inspection'], monthlyCapUsd: 50 } })).status).toBe(200)
  expect((await app.api('PUT', '/api/ai/key', { token: admin.token, body: { apiKey: KEY } })).status).toBe(200)
})
afterAll(() => app.stop())

describe('§20 the title an answer is printed under', () => {
  it('is named by the assistant from the question and the answer, kept, and costs nothing printed again', async () => {
    const { turnId } = await ask('J، histogram مع Cp وCpk', 'العملية مش قادرة تمسك سماحية البعد J على ماكينة Stam Upright 24.')
    app.model.completions = []
    app.model.completeWith = () => '"قدرة البعد J على ماكينة Stam Upright 24".'
    const first = await titleOf(turnId)
    expect(first.status).toBe(200)
    expect(first.body).toEqual({ title: 'قدرة البعد J على ماكينة Stam Upright 24', named: true })
    expect(app.model.completions).toHaveLength(1)
    const call = app.model.completions[0].params
    expect(call.model).toBe(AI_JOBS.title.model)
    // A title is answered at once: thinking would spend its few tokens (noThinking).
    expect(call.thinking).toEqual({ type: 'between_tools' })
    expect(call.system).toBe(REPORT_TITLE_SYSTEM)
    expect(call.messages[0].content).toBe(reportTitleRequest('J، histogram مع Cp وCpk', 'العملية مش قادرة تمسك سماحية البعد J على ماكينة Stam Upright 24.'))
    // Its cost is the person's, kept with the answer.
    const { rows } = await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ai_usage WHERE turn_id = $1 AND model = $2`, [turnId, AI_JOBS.title.model])
    expect(rows[0].n).toBeGreaterThanOrEqual(1)

    app.model.completeWith = () => 'Something else'
    expect((await titleOf(turnId)).body).toEqual({ title: 'قدرة البعد J على ماكينة Stam Upright 24', named: true })
    expect(app.model.completions).toHaveLength(1)
  })

  it('prints under a stand-in, not kept, when the assistant cannot name it: never the question typed', async () => {
    const { turnId, conversationId } = await ask('scrap last week by machine??', 'Machine 58 had the most scrap.')
    app.model.completeWith = () => {
      throw new Error('overloaded')
    }
    // The conversation is still titled by its question: the stand-in is a report's plain name.
    await app.db.query(`UPDATE ai_conversations SET title = 'scrap last week by machine??', title_source = 'question' WHERE id = $1`, [conversationId])
    expect((await titleOf(turnId)).body).toEqual({ title: REPORT_TITLE_FALLBACK, named: false })
    // Named by the assistant or the person, the conversation's title stands in.
    await app.db.query(`UPDATE ai_conversations SET title = 'Scrap by machine', title_source = 'assistant' WHERE id = $1`, [conversationId])
    expect((await titleOf(turnId)).body).toEqual({ title: 'Scrap by machine', named: false })
    const kept = await app.db.query<{ report_title: string | null }>(`SELECT report_title FROM ai_turns WHERE id = $1`, [turnId])
    expect(kept.rows[0].report_title).toBeNull()
    // Asked again once the assistant can: named and kept.
    app.model.completeWith = () => 'Scrap by machine - last week'
    expect((await titleOf(turnId)).body).toEqual({ title: 'Scrap by machine - last week', named: true })
  })

  it('makes no call while the assistant is off for everyone', async () => {
    const { turnId } = await ask('Holds open', 'Four holds are open.')
    app.model.completions = []
    app.model.completeWith = () => 'Open holds'
    expect((await app.api('PUT', '/api/ai/settings', { token: admin.token, body: { enabled: false, monthlyCapUsd: 50 } })).status).toBe(200)
    try {
      expect((await titleOf(turnId)).body).toMatchObject({ named: false })
      expect(app.model.completions).toHaveLength(0)
    } finally {
      expect((await app.api('PUT', '/api/ai/settings', { token: admin.token, body: { enabled: true, monthlyCapUsd: 50 } })).status).toBe(200)
    }
  })

  it('is the asker’s own: someone else’s answer, or none, is not found', async () => {
    const { turnId } = await ask('Rejects today', 'Two rejects today.')
    expect((await titleOf(turnId, other)).status).toBe(404)
    expect((await titleOf(randomUUID())).status).toBe(404)
    expect((await app.api('POST', '/api/ai/turns/not-an-id/report-title', { token: admin.token })).status).toBe(400)
  })
})
