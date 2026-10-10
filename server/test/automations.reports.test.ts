import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest'
import { aiCostUsd, type AiUsageResponse } from '@qc/shared/ai'
import type { AutomationDelivery } from '@qc/shared/automation'
import { TestApp, factoryDay } from './harness'
import { apiError, text } from './aiFake'
import { Clock, KEY, alertsOf, engineFor, grant, insertAutomation, reportDraft, runsOf, setUp, systemMessagesTo, type People } from './automationsKit'
import { SUMMARY_MAX_TOKENS, SUMMARY_NOTE, SUMMARY_SYSTEM_PROMPT } from '../src/automations/report'

// §21 — scheduled reports: the sections run as the creator's domains over the
// period as of the factory's day; the model writes a short summary when asked
// (counted against the creator's cap and the assistant's, recorded with the
// automation); without one the report still goes out and says why, never
// with an amount. What was delivered is kept, for the people it went to, its
// creator and the owner to open. The model is the scripted stand-in.

const app = new TestApp()
let p: People

const SECTIONS = [
  { title: 'Machines', sql: 'SELECT count(*)::int AS machines FROM ai.machines' },
  { title: 'Registered in the period', sql: 'SELECT machine_code FROM ai.machines WHERE registered_at >= {{from}} AND registered_at < {{to}} + 1 ORDER BY machine_code' },
]
const schedule = (over: Partial<ReturnType<typeof reportDraft>['schedule']> = {}) => ({ ...reportDraft().schedule!, period: { kind: 'last_days' as const, days: 7 }, sections: SECTIONS, summary: true, ...over })

async function deliver(over: Parameters<typeof schedule>[0] = {}, recipients = [{ kind: 'role' as const, role: 'supervisor' as const }, { kind: 'user' as const, userId: '' }]) {
  const clock = new Clock()
  const id = await insertAutomation(app.db, {
    creatorId: p.creator.user.id,
    schedule: schedule(over),
    recipients: recipients.map((r) => (r.kind === 'user' ? { kind: 'user', userId: p.creator2.user.id } : r)),
    channels: { bell: true, chat: true },
    nextRunAt: clock.now(),
  })
  await engineFor(app, clock).tick()
  const runs = await runsOf(app.db, id)
  return { id, runs, run: runs[runs.length - 1] }
}

const delivery = (id: string, as = p.creator) => app.api<AutomationDelivery>('GET', `/api/automations/deliveries/${id}`, { token: as.token })

beforeAll(async () => {
  await app.start()
  p = await setUp(app)
  // The creator's own model: the summary is written on it.
  await grant(app, p.owner, p.creator, { automations: true, model: 'claude-haiku-5-5', effort: 'high' })
})
afterAll(() => app.stop())
beforeEach(async () => {
  app.model.reset()
  await app.db.query(`UPDATE ai_automations SET deleted_at = now(), next_run_at = NULL WHERE deleted_at IS NULL`)
  await app.db.query(`DELETE FROM user_notifications`)
})

describe('§21 a report delivered', () => {
  it('runs its sections over its period, asks for a short summary on the creator’s model, and delivers both', async () => {
    app.model.reply({ content: [text('3 machines are registered.\nAll of them this week.\nNothing failed.\nOne more line.\nAnd a fifth.')], usage: { input_tokens: 1200, output_tokens: 300 } })
    const { id, run } = await deliver()
    expect(run).toMatchObject({ ok: true, error: null, notified: 4, note: null })
    expect(run.deliveryId).not.toBeNull()

    // One call: the creator's model, low effort, no tools, the summary's own room.
    expect(app.model.calls).toHaveLength(1)
    const call = app.model.calls[0].params
    expect(call).toMatchObject({ model: 'claude-haiku-5-5', max_tokens: SUMMARY_MAX_TOKENS, thinking: { type: 'adaptive' }, output_config: { effort: 'low' } })
    expect(call).not.toHaveProperty('tools')
    expect(call.system).toEqual([{ type: 'text', text: SUMMARY_SYSTEM_PROMPT }])
    const input = JSON.parse(call.messages[0].content as string)
    expect(input).toMatchObject({
      report: 'Machine register',
      language: 'English',
      period: { from: factoryDay(-6), to: factoryDay(), label: 'Last 7 days' },
      sections: [
        { title: 'Machines', columns: ['machines'], rows: [[2]], rowCount: 1, truncated: false },
        { title: 'Registered in the period', columns: ['machine_code'], rows: [['31'], ['58']], rowCount: 2 },
      ],
    })

    // Counted against the creator, with the automation; no conversation.
    const usage = await app.db.query(`SELECT user_id, conversation_id, turn_id, automation_id, model, cost_usd FROM ai_usage WHERE automation_id = $1`, [id])
    expect(usage.rows).toEqual([
      {
        user_id: p.creator.user.id,
        conversation_id: null,
        turn_id: null,
        automation_id: id,
        model: 'claude-haiku-5-5',
        cost_usd: aiCostUsd('claude-haiku-5-5', { inputTokens: 1200, outputTokens: 300, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0 }),
      },
    ])

    // Kept, with the people it went to.
    const shown = await delivery(run.deliveryId!)
    expect(shown.status).toBe(200)
    expect(shown.body).toMatchObject({
      id: run.deliveryId,
      automationId: id,
      automationName: 'Machine register',
      language: 'en',
      period: { from: factoryDay(-6), to: factoryDay(), label: 'Last 7 days' },
      summary: '3 machines are registered.\nAll of them this week.\nNothing failed.\nOne more line.\nAnd a fifth.',
      sections: [
        { title: 'Machines', ok: true, rows: [[2]], rowCount: 1 },
        { title: 'Registered in the period', ok: true, rows: [['31'], ['58']], rowCount: 2 },
      ],
    })
    expect(shown.body).not.toHaveProperty('summaryNote')
    const recipients = await app.db.query<{ userId: string }>(`SELECT user_id AS "userId" FROM ai_report_delivery_recipients WHERE delivery_id = $1 ORDER BY user_id`, [run.deliveryId])
    expect(recipients.rows.map((r) => r.userId).sort()).toEqual([p.plain.user.id, p.creator2.user.id].sort())

    // The bell and the chat: the title with its period, the summary's first lines, the way to the page.
    const link = `/automations/deliveries/${run.deliveryId}`
    for (const s of [p.plain, p.creator2]) {
      expect(await alertsOf(app.db, s.user.id)).toEqual([
        { kind: 'automation-report', severity: 'info', title: 'Machine register · Last 7 days', body: '3 machines are registered.\nAll of them this week.\nNothing failed.\nOne more line.\n…', link },
      ])
      expect(await systemMessagesTo(app.db, s.user.id)).toEqual([`Machine register · Last 7 days\n3 machines are registered.\nAll of them this week.\nNothing failed.\nOne more line.\n…\n${link}`])
    }
  })

  it('is open to the people it went to, its creator and the owner; to anyone else it does not exist', async () => {
    app.model.reply({ content: [text('Two machines.')] })
    const { run } = await deliver()
    for (const s of [p.plain, p.creator2, p.creator, p.owner]) expect((await delivery(run.deliveryId!, s)).status, s.user.name).toBe(200)
    for (const s of [p.admin2, p.viewer]) expect((await delivery(run.deliveryId!, s)).status, s.user.name).toBe(404)
    expect((await delivery('00000000-0000-4000-8000-000000000000', p.owner)).status).toBe(404)
    expect((await app.api('GET', '/api/automations/deliveries/not-an-id', { token: p.owner.token })).status).toBe(400)
  })

  it('goes out without a summary when it asks for none, calling no model', async () => {
    const { run } = await deliver({ summary: false })
    expect(app.model.calls).toHaveLength(0)
    const shown = (await delivery(run.deliveryId!)).body
    expect(shown).not.toHaveProperty('summary')
    expect(shown).not.toHaveProperty('summaryNote')
    expect(await alertsOf(app.db, p.plain.user.id)).toEqual([expect.objectContaining({ body: 'The report is ready.' })])
  })

  it('goes out without one, saying why in a sentence and never an amount, when a cap is reached, there is no key, or the call fails', async () => {
    const without = async (note: string) => {
      const { run } = await deliver()
      expect(run).toMatchObject({ ok: true, note })
      const shown = (await delivery(run.deliveryId!)).body
      expect(shown).not.toHaveProperty('summary')
      expect(shown.summaryNote).toBe(note)
      expect(shown.summaryNote).not.toMatch(/\$|\d+\.\d\d/)
      expect(shown.sections).toHaveLength(2)
      return run
    }
    // The assistant's cap: no call is made.
    await app.api('PUT', '/api/ai/settings', { token: p.owner.token, body: { enabled: true, monthlyCapUsd: 0 } })
    await without(SUMMARY_NOTE.cap)
    expect(app.model.calls).toHaveLength(0)
    await app.api('PUT', '/api/ai/settings', { token: p.owner.token, body: { enabled: true, monthlyCapUsd: 50 } })
    // The creator's own cap: what they spent this month, and the most the call could cost, would pass it.
    await grant(app, p.owner, p.creator, { automations: true, model: 'claude-haiku-5-5', monthlyCapUsd: 0.02 })
    await app.db.query(`INSERT INTO ai_usage (user_id, model, cost_usd) VALUES ($1, 'claude-haiku-5-5', 0.0199)`, [p.creator.user.id])
    await without(SUMMARY_NOTE.cap)
    expect(app.model.calls).toHaveLength(0)
    await grant(app, p.owner, p.creator, { automations: true, model: 'claude-haiku-5-5', effort: 'high' })
    // No key.
    expect((await app.api('DELETE', '/api/ai/key', { token: p.owner.token })).status).toBe(200)
    await without(SUMMARY_NOTE.unavailable)
    expect((await app.api('PUT', '/api/ai/key', { token: p.owner.token, body: { apiKey: KEY } })).status).toBe(200)
    // The call fails: what it used is still counted.
    app.model.reply({ content: [text('Half a summ')], cutOff: true, error: apiError(500, 'boom') })
    const failed = await without(SUMMARY_NOTE.failed)
    expect(app.model.calls).toHaveLength(1)
    const usage = await app.db.query<{ partial: boolean }>(`SELECT partial FROM ai_usage u JOIN ai_automation_runs r ON r.automation_id = u.automation_id WHERE r.id = $1`, [failed.id])
    expect(usage.rows).toEqual([{ partial: true }])
  })

  it('delivers what ran when a section fails (a failed run), and nothing when none ran', async () => {
    const some = await deliver({ summary: false, sections: [SECTIONS[0], { title: 'Coils', sql: 'SELECT count(*) AS coils FROM ai.coils' }] })
    expect(some.run).toMatchObject({ ok: false, error: expect.stringMatching(/^“Coils” failed: it reads data this person cannot read/), note: '1 of 2 sections failed; the report went out with the rest.' })
    const shown = (await delivery(some.run.deliveryId!)).body
    expect(shown.sections.map((s) => [s.title, s.ok])).toEqual([
      ['Machines', true],
      ['Coils', false],
    ])
    expect((await app.db.query<{ failures: number }>(`SELECT consecutive_failures AS failures FROM ai_automations WHERE id = $1`, [some.id])).rows[0].failures).toBe(1)
    const none = await deliver({ summary: false, sections: [{ title: 'Coils', sql: 'SELECT count(*) AS coils FROM ai.coils' }] })
    expect(none.run).toMatchObject({ ok: false, deliveryId: null, error: expect.stringMatching(/^No section ran/) })
  })

  it('keeps at most AUTOMATION_DELIVERY_MAX_ROWS rows a section', async () => {
    const { run } = await deliver({ summary: false, period: undefined, sections: [{ title: 'Many', sql: 'SELECT g FROM generate_series(1, 2500) g' }] })
    const [section] = (await delivery(run.deliveryId!)).body.sections
    expect(section).toMatchObject({ ok: true, rowCount: 2000, truncated: true })
    expect(section.rows).toHaveLength(2000)
    expect((await delivery(run.deliveryId!)).body.period).toBeNull()
  })
})

describe('§21 what summaries cost: the owner’s page only', () => {
  it('shows the cost by automation to the owner, also counted in the creator’s line; to anyone else the page does not exist', async () => {
    app.model.reply({ content: [text('Fine.')], usage: { input_tokens: 2000, output_tokens: 400 } })
    const { id } = await deliver()
    const month = new Date().toISOString().slice(0, 7)
    const usage = await app.api<AiUsageResponse>('GET', `/api/ai/usage?month=${month}`, { token: p.owner.token })
    expect(usage.status).toBe(200)
    const cost = aiCostUsd('claude-haiku-5-5', { inputTokens: 2000, outputTokens: 400, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0 })
    expect(usage.body.byAutomation.find((a) => a.automationId === id)).toEqual({ automationId: id, name: 'Machine register', creatorName: 'Cara Creator', costUsd: cost, runs: 1 })
    expect(usage.body.byUser.find((u) => u.userId === p.creator.user.id)!.costUsd).toBeGreaterThanOrEqual(cost)
    for (const s of [p.creator, p.plain, p.admin2]) expect((await app.api('GET', `/api/ai/usage?month=${month}`, { token: s.token })).status, s.user.name).toBe(404)
    // Nor in the run's history or the delivery.
    const runs = await app.api<{ runs: Record<string, unknown>[] }>('GET', `/api/automations/${id}/runs`, { token: p.creator.token })
    expect(JSON.stringify(runs.body)).not.toMatch(/cost/i)
    const delivered = await delivery(runs.body.runs[0].deliveryId as string)
    expect(JSON.stringify(delivered.body)).not.toMatch(/cost/i)
  })
})
