import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import type { ApiErrorBody, AuditListResponse } from '@qc/shared/api'
import type { AiMessagesResponse, AiStreamEvent } from '@qc/shared/ai'
import type { AiAutomationPart, AutomationActivateResponse, AutomationDiscardResponse, AutomationDraft } from '@qc/shared/automation'
import { TestApp, factoryDay } from './harness'
import { text } from './aiFake'
import {
  ask,
  addMachines,
  alertsOf,
  Clock,
  engineFor,
  grant,
  insertAutomation,
  reportDraft,
  setUp,
  watchDraft,
  MACHINES_SQL,
  MINUTE,
  type People,
} from './automationsKit'
import { renderSystemPrompt } from '../src/ai/prompt'
import { describeAiSchema } from '../src/ai/schemaDoc'
import { readDraft } from '../src/automations/draft'
import { isolate } from '../src/automations/text'
import { validateDraft, type ValidationContext } from '../src/automations/validate'

// §21 — an automation is proposed in the assistant's chat and nothing runs
// until the person who asked presses Activate. The tools exist only in new
// conversations of people allowed to automate; what a conversation was sent
// is never changed. Every draft is checked (and run once) before it is kept.
// The model is the scripted stand-in.

const app = new TestApp()
let p: People

type AutomationEvent = Extract<AiStreamEvent, { type: 'automation' }>

const propose = (id: string, input: unknown): Anthropic.Beta.BetaContentBlock =>
  ({ type: 'tool_use', id, name: 'propose_automation', input }) as Anthropic.Beta.BetaContentBlock
const listMine = (id: string): Anthropic.Beta.BetaContentBlock => ({ type: 'tool_use', id, name: 'my_automations', input: {} }) as Anthropic.Beta.BetaContentBlock

const lastCall = () => app.model.calls[app.model.calls.length - 1]
const toolsOf = (call = lastCall()) => (call.params.tools ?? []).map((t) => (t as { name: string }).name)
const systemOf = (call = lastCall()) => (call.params.system as { text: string }[])[0].text
const resultsOf = (call = lastCall()) => {
  const last = call.params.messages[call.params.messages.length - 1]
  return last.content as Anthropic.Beta.BetaToolResultBlockParam[]
}
const automationEvents = (events: AiStreamEvent[]) => events.filter((e): e is AutomationEvent => e.type === 'automation').map((e) => e.part)

/** The creator proposes a draft in a new conversation (or the one given); the stream and the conversation. */
async function proposeInChat(draft: unknown, as = p.creator, conversationId?: string) {
  app.model.reply({ content: [text('Let me set that up.'), propose(`toolu_${Math.random().toString(36).slice(2, 10)}`, draft)] }, { content: [text('Proposed: press Activate to start it.')] })
  const res = await ask(app, as, 'Tell the supervisors about every new machine.', conversationId)
  expect(res.status, JSON.stringify(res.error)).toBe(200)
  return res
}

async function activate(proposalId: string, as = p.creator, body: unknown = {}) {
  return app.api<AutomationActivateResponse | ApiErrorBody>('POST', `/api/ai/automation-proposals/${proposalId}/activate`, { token: as.token, body })
}

beforeAll(async () => {
  await app.start()
  p = await setUp(app)
})
afterAll(() => app.stop())
beforeEach(() => {
  app.model.reset()
  for (const s of Object.values(p)) app.aiLimiter.reset(s.user.id)
})

describe('§21 the tools and the prompt: new conversations of people allowed to automate', () => {
  it('gives them to the owner and to people allowed, never to anyone else, and the prompt says how to use them', async () => {
    app.model.reply({ content: [text('Hello.')] }, { content: [text('Hello.')] }, { content: [text('Hello.')] })
    await ask(app, p.plain, 'Hello')
    const plain = lastCall()
    expect(toolsOf(plain)).toEqual(['run_sql'])
    expect(systemOf(plain)).not.toContain('# Automations')
    await ask(app, p.creator, 'Hello')
    const creator = lastCall()
    expect(toolsOf(creator)).toEqual(['run_sql', 'propose_automation', 'my_automations'])
    expect(creator.params.tools![1]).toMatchObject({ eager_input_streaming: true, input_schema: { additionalProperties: false } })
    // Not strict: together with run_sql's, its alternatives compile to a grammar the API refuses as too large.
    expect(creator.params.tools![1]).not.toHaveProperty('strict')
    await ask(app, p.owner, 'Hello')
    expect(toolsOf()).toEqual(['run_sql', 'propose_automation', 'my_automations'])

    // Without automations the prompt is the one it always was, byte for byte; with them, one section more.
    const tz = app.config.FACTORY_TIMEZONE
    const schema = await describeAiSchema(app.db, ['inspection'])
    expect(systemOf(plain)).toBe(renderSystemPrompt(tz, schema, ['inspection']))
    const asker = { id: p.creator.user.id, name: p.creator.user.name, role: p.creator.user.role }
    const withSection = renderSystemPrompt(tz, schema, ['inspection'], { automations: asker })
    expect(systemOf(creator)).toBe(withSection)
    const section = withSection.slice(withSection.indexOf('# Automations'), withSection.indexOf('# Read-only'))
    expect(section).toContain('Nothing runs until the person presses Activate')
    expect(section).toContain('never changes any data')
    // "Me" in a request is the person asking: the section names them, so the model never has to ask.
    expect(section).toContain(`The person asking is ${JSON.stringify(asker.name)} (user id ${asker.id}, role ${asker.role})`)
    expect(section).toContain(`{"kind": "user", "userId": "${asker.id}"}`)
    expect(withSection.replace(section, '')).toBe(systemOf(plain))
  })

  it('keeps what a conversation was sent: tools given later reach new conversations only, and taken away they answer "not allowed"', async () => {
    app.model.reply({ content: [text('Hi.')] })
    const before = await ask(app, p.plain, 'Before the permission')
    const stored = async (id: string) =>
      (await app.db.query<{ tools: string; prompt: string }>(`SELECT tools::text AS tools, system_prompt AS prompt FROM ai_conversations WHERE id = $1`, [id])).rows[0]
    const old = await stored(before.conversationId)

    await grant(app, p.owner, p.plain, { automations: true })
    try {
      app.model.reply({ content: [text('Still here.')] })
      await ask(app, p.plain, 'And now?', before.conversationId)
      // The earlier conversation goes on with the tools and prompt it began with, byte for byte.
      expect(JSON.stringify(lastCall().params.tools)).toBe(old.tools)
      expect(systemOf()).toBe(old.prompt)
      expect(toolsOf()).toEqual(['run_sql'])
      // A propose_automation call there is a tool it never had.
      app.model.reply({ content: [propose('toolu_old', watchDraft())] }, { content: [text('I cannot.')] })
      await ask(app, p.plain, 'Watch the machines', before.conversationId)
      expect(resultsOf()).toEqual([
        { type: 'tool_result', tool_use_id: 'toolu_old', is_error: true, content: 'Unknown tool "propose_automation". The only tool is "run_sql".' },
      ])
      expect((await app.db.query(`SELECT 1 FROM ai_automation_proposals WHERE tool_use_id = 'toolu_old'`)).rowCount).toBe(0)

      app.model.reply({ content: [text('Hi again.')] })
      const fresh = await ask(app, p.plain, 'A new conversation')
      expect(toolsOf()).toEqual(['run_sql', 'propose_automation', 'my_automations'])
      const freshStored = await stored(fresh.conversationId)

      // The permission withdrawn: the conversation keeps its tools, which now refuse; nothing is proposed or shown.
      await grant(app, p.owner, p.plain, { automations: false })
      app.model.reply({ content: [propose('toolu_gone', watchDraft())] }, { content: [text('Not allowed.')] })
      const refused = await ask(app, p.plain, 'Watch the machines', fresh.conversationId)
      expect(JSON.stringify(lastCall().params.tools)).toBe(freshStored.tools)
      expect(resultsOf()).toEqual([{ type: 'tool_result', tool_use_id: 'toolu_gone', is_error: true, content: expect.stringMatching(/^Not allowed/) }])
      expect(automationEvents(refused.events)).toEqual([])
      app.model.reply({ content: [listMine('toolu_list_gone')] }, { content: [text('Not allowed.')] })
      await ask(app, p.plain, 'What automations do I have?', fresh.conversationId)
      expect(resultsOf()[0]).toMatchObject({ is_error: true, content: expect.stringMatching(/^Not allowed/) })
    } finally {
      await grant(app, p.owner, p.plain, { automations: false })
    }
  })
})

describe('§21 a proposal from the chat', () => {
  let proposal: AiAutomationPart
  let conversationId: string
  let proposedWith: ReturnType<typeof lastCall>

  it('checks the draft, runs it once, shows the card and tells the model what it found; nothing runs', async () => {
    const res = await proposeInChat(watchDraft())
    conversationId = res.conversationId
    const [part] = automationEvents(res.events)
    expect(part).toMatchObject({
      type: 'automation',
      ok: true,
      state: 'proposed',
      draft: { kind: 'watch', name: 'New machines', watch: { sql: MACHINES_SQL, keyColumn: 'machine_code' } },
      recipients: [{ kind: 'role', role: 'supervisor', label: 'Every supervisor' }],
      backtest: { ok: true, matched: 2, truncated: false, columns: ['machine_code', 'machine'], sampleRows: [['31', '31. Machine'], ['58', '58. Machine']], sampleTitle: `New machine ${isolate('31. Machine')}`, sampleBody: `Code ${isolate('31')}` },
    })
    expect(part).not.toHaveProperty('error')
    proposal = part
    // The model read what the run found, and that nothing runs until Activate.
    const [result] = resultsOf()
    expect(result.is_error).toBeUndefined()
    const told = JSON.parse(result.content as string)
    expect(told).toMatchObject({ proposed: true, proposalId: part.proposalId, backtest: { casesMatchingNow: 2, sampleTitle: 'New machine 31. Machine' } })
    expect(told.note).toMatch(/Nothing runs until they press Activate/)
    // The answer shows the card in place, as the stream did.
    expect(res.done!.message.parts.map((x) => x.type)).toEqual(['text', 'automation', 'text'])
    expect(res.done!.message.parts[1]).toEqual(part)
    expect((await app.db.query(`SELECT 1 FROM ai_automations`)).rowCount).toBe(0)
    proposedWith = lastCall()
  })

  it('replays the conversation byte for byte after a proposal', async () => {
    const prior = proposedWith
    const answer = (await app.db.query<{ content: string }>(`SELECT content::text AS content FROM ai_messages WHERE conversation_id = $1 AND kind = 'assistant' ORDER BY seq DESC LIMIT 1`, [conversationId])).rows[0]
    app.model.reply({ content: [text('Anything else?')] })
    await ask(app, p.creator, 'Thanks', conversationId)
    const next = lastCall()
    expect(JSON.stringify(next.params.messages.slice(0, prior.params.messages.length))).toBe(JSON.stringify(prior.params.messages))
    expect(JSON.stringify(next.params.messages[prior.params.messages.length].content)).toBe(answer.content)
    expect(JSON.stringify(next.params.tools)).toBe(JSON.stringify(prior.params.tools))
    expect(JSON.stringify(next.params.system)).toBe(JSON.stringify(prior.params.system))
  })

  it('keeps a draft that does not pass, shows why, and asks the model to fix it', async () => {
    const res = await proposeInChat(watchDraft({}, { keyColumn: 'machine_id_typo' }))
    const [part] = automationEvents(res.events)
    expect(part).toMatchObject({ ok: false, state: 'proposed', error: expect.stringContaining('watch.keyColumn: the result has no column "machine_id_typo"') })
    const [result] = resultsOf()
    expect(result.is_error).toBe(true)
    expect(result.content).toMatch(/^Not proposed\. Fix these and call propose_automation again:\n- watch\.keyColumn/)
    expect(result.content).toContain('casesMatchingNow')
    // Input the tool could not read at all: its shape is named.
    const bad = await proposeInChat({ ...watchDraft(), colour: 'red' })
    expect(automationEvents(bad.events)[0]).toMatchObject({ ok: false, error: expect.stringContaining('Unrecognized key') })
    expect(automationEvents(bad.events)[0]).not.toHaveProperty('draft')
    const rows = await app.db.query<{ ok: boolean }>(`SELECT ok FROM ai_automation_proposals WHERE conversation_id IN ($1, $2)`, [res.conversationId, bad.conversationId])
    expect(rows.rows).toEqual([{ ok: false }, { ok: false }])
    expect((await activate(part.proposalId)).status).toBe(409)
  })

  it('shows each card in its current state when the conversation is opened again', async () => {
    const shown = async () => {
      const res = await app.api<AiMessagesResponse>('GET', `/api/ai/conversations/${conversationId}/messages`, { token: p.creator.token })
      return res.body.messages.flatMap((m) => m.parts).find((x): x is AiAutomationPart => x.type === 'automation')!
    }
    expect(await shown()).toEqual(proposal)
    const activated = await activate(proposal.proposalId)
    expect(activated.status, JSON.stringify(activated.body)).toBe(200)
    const after = await shown()
    expect(after).toMatchObject({ state: 'activated', automationId: (activated.body as AutomationActivateResponse).automation.id })
    expect(after).toEqual((activated.body as AutomationActivateResponse).part)
  })
})

describe('§21 activation', () => {
  it('only the person who asked, while allowed; once; with the same checks again', async () => {
    const res = await proposeInChat(watchDraft({ name: 'Once only' }))
    const part = automationEvents(res.events)[0]
    // Not theirs (another creator, the owner): it does not exist. Not allowed to automate: nor does the route.
    for (const s of [p.creator2, p.owner, p.plain, p.viewer, p.admin2]) expect((await activate(part.proposalId, s)).status, s.user.name).toBe(404)
    expect((await app.api('POST', `/api/ai/automation-proposals/${part.proposalId}/discard`, { token: p.plain.token })).status).toBe(404)
    // Changes on the card are checked like the draft.
    const wrong = await activate(part.proposalId, p.creator, { edits: { everyMinutes: 2 } })
    expect(wrong.status).toBe(400)
    expect((wrong.body as ApiErrorBody).error.message).toMatch(/watch\.everyMinutes: from 5 to 1440 minutes/)
    expect((await activate(part.proposalId, p.creator, { edits: { schedule: 'x' } })).status).toBe(400)
    expect((await activate(part.proposalId, p.creator, { edits: { cadence: 'weekly' } })).status).toBe(400)

    const ok = await activate(part.proposalId, p.creator, { edits: { name: 'Once only, renamed', everyMinutes: 15 } })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    const { automation, part: card } = ok.body as AutomationActivateResponse
    expect(automation).toMatchObject({
      kind: 'watch',
      name: 'Once only, renamed',
      status: 'active',
      watch: { everyMinutes: 15 },
      creator: { id: p.creator.user.id, name: 'Cara Creator' },
      conversationId: res.conversationId,
      consecutiveFailures: 0,
      openFollowUps: 0,
    })
    expect(automation.nextRunAt).not.toBeNull()
    expect(card).toMatchObject({ state: 'activated', automationId: automation.id })
    const again = await activate(part.proposalId)
    expect(again.status).toBe(409)
    expect((again.body as ApiErrorBody).error.message).toBe('This proposal was already activated.')
    // Two clicks at once still make one.
    const twice = await proposeInChat(watchDraft({ name: 'Raced' }))
    const raced = await Promise.all([activate(automationEvents(twice.events)[0].proposalId), activate(automationEvents(twice.events)[0].proposalId)])
    expect(raced.map((r) => r.status).sort()).toEqual([200, 409])
    expect((await app.db.query(`SELECT 1 FROM ai_automations WHERE name = 'Raced'`)).rowCount).toBe(1)

    // Audited, for the owner's eyes only.
    const owner = await app.api<AuditListResponse>('GET', '/api/audit?entity=Automation&limit=100', { token: p.owner.token })
    expect(owner.body.entries.map((e) => [e.action, e.entityId, e.newValue])).toContainEqual(['create', automation.id, 'Once only, renamed (watch)'])
    const other = await app.api<AuditListResponse>('GET', '/api/audit?limit=2000', { token: p.admin2.token })
    expect(other.body.entries.some((e) => e.entity === 'Automation')).toBe(false)
  })

  it('records the cases matching now as seen, unless asked to tell about them too', async () => {
    const baseline = automationEvents((await proposeInChat(watchDraft({ name: 'Baseline' }))).events)[0]
    const told = automationEvents((await proposeInChat(watchDraft({ name: 'Tell existing' }))).events)[0]
    const b = (await activate(baseline.proposalId)).body as AutomationActivateResponse
    const t = (await activate(told.proposalId, p.creator, { notifyExisting: true })).body as AutomationActivateResponse
    const hits = async (id: string) => (await app.db.query<{ key: string; run: string | null }>(`SELECT case_key AS key, run_id AS run FROM ai_automation_hits WHERE automation_id = $1 ORDER BY case_key`, [id])).rows
    expect(await hits(b.automation.id)).toEqual([
      { key: '31', run: null },
      { key: '58', run: null },
    ])
    expect(await hits(t.automation.id)).toEqual([])
    // Only these two run: the engine runs everything due, so the earlier ones of this file are paused.
    await app.db.query(`UPDATE ai_automations SET status = 'paused', next_run_at = NULL WHERE id NOT IN ($1, $2)`, [b.automation.id, t.automation.id])
    const clock = new Clock()
    const engine = engineFor(app, clock)
    await engine.tick()
    const fired = async (id: string) => (await app.db.query<{ fired: number }>(`SELECT fired FROM ai_automation_runs WHERE automation_id = $1 ORDER BY started_at`, [id])).rows.map((r) => r.fired)
    expect(await fired(b.automation.id)).toEqual([0])
    expect(await fired(t.automation.id)).toEqual([2])
    expect((await alertsOf(app.db, p.plain.user.id)).filter((a) => a.kind === 'automation-case').map((a) => a.title).sort()).toEqual(['New machine 31. Machine', 'New machine 58. Machine'])
    // A machine added later fires on both.
    await addMachines(app.db, ['77'])
    clock.advance(5 * MINUTE)
    await engine.tick()
    expect(await fired(b.automation.id)).toEqual([0, 1])
    expect(await fired(t.automation.id)).toEqual([2, 1])
    await app.db.query(`UPDATE ai_automations SET status = 'paused', next_run_at = NULL`)
  })

  it('discards a proposal once; a discarded one cannot be activated, an activated one cannot be discarded', async () => {
    const part = automationEvents((await proposeInChat(watchDraft({ name: 'Thrown away' }))).events)[0]
    const discard = (s = p.creator) => app.api<AutomationDiscardResponse>('POST', `/api/ai/automation-proposals/${part.proposalId}/discard`, { token: s.token })
    expect((await discard(p.creator2)).status).toBe(404)
    const res = await discard()
    expect(res.status).toBe(200)
    expect(res.body.part).toMatchObject({ proposalId: part.proposalId, state: 'discarded' })
    expect((await discard()).status).toBe(200)
    expect((await activate(part.proposalId)).status).toBe(409)
    const kept = automationEvents((await proposeInChat(watchDraft({ name: 'Kept' }))).events)[0]
    expect((await activate(kept.proposalId)).status).toBe(200)
    expect((await app.api('POST', `/api/ai/automation-proposals/${kept.proposalId}/discard`, { token: p.creator.token })).status).toBe(409)
  })

  it('changes an existing automation in place when the proposal replaces it, keeping its fired cases', async () => {
    const first = (await activate(automationEvents((await proposeInChat(watchDraft({ name: 'Original' }))).events)[0].proposalId)).body as AutomationActivateResponse
    const id = first.automation.id
    const keys = async () => (await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ai_automation_hits WHERE automation_id = $1`, [id])).rows[0].n
    const before = await keys()
    // my_automations shows it to the model, with its id.
    app.model.reply({ content: [listMine('toolu_list')] }, { content: [text('You have these.')] })
    const listed = await ask(app, p.creator, 'What automations do I have?')
    const mine = JSON.parse(resultsOf()[0].content as string) as { automations: { id: string; name: string; kind: string; status: string; watch?: { sql: string } }[]; truncated: boolean }
    expect(mine.truncated).toBe(false)
    expect(mine.automations.find((a) => a.id === id)).toMatchObject({ name: 'Original', kind: 'watch', watch: { sql: MACHINES_SQL } })
    expect(listed.done!.message.parts.every((x) => x.type === 'text')).toBe(true)

    const change = automationEvents((await proposeInChat(watchDraft({ name: 'Original, every hour', replacesAutomationId: id }, { everyMinutes: 60 }))).events)[0]
    expect(change).toMatchObject({ ok: true, replacesName: 'Original' })
    const changed = (await activate(change.proposalId)).body as AutomationActivateResponse
    expect(changed.automation).toMatchObject({ id, name: 'Original, every hour', watch: { everyMinutes: 60 } })
    expect(await keys()).toBe(before)
    expect((await app.db.query(`SELECT 1 FROM ai_automations WHERE name LIKE 'Original%'`)).rowCount).toBe(1)
    const audit = await app.api<AuditListResponse>('GET', `/api/audit?entity=Automation&limit=100`, { token: p.owner.token })
    const fields = audit.body.entries.filter((e) => e.entityId === id && e.action === 'update').map((e) => [e.field, e.oldValue, e.newValue])
    expect(fields).toEqual(expect.arrayContaining([['name', 'Original', 'Original, every hour'], ['interval', 'Every 5 minutes', 'Every hour']]))
    // Someone else's automation cannot be replaced.
    const theirs = await insertAutomation(app.db, { creatorId: p.creator2.user.id, nextRunAt: null, status: 'paused' })
    const stolen = automationEvents((await proposeInChat(watchDraft({ replacesAutomationId: theirs }))).events)[0]
    expect(stolen).toMatchObject({ ok: false, error: expect.stringContaining("replacesAutomationId: none of this person's automations has that id") })
  })

  it('keeps its cases going through a change that keeps its query: one not told yet still fires; a new query starts from what matches now', async () => {
    const sql = `SELECT machine_code, machine FROM ai.machines WHERE machine_code LIKE '9%' ORDER BY machine_code`
    await addMachines(app.db, ['90'])
    const first = (await activate(automationEvents((await proposeInChat(watchDraft({ name: 'Hourly machines' }, { sql, everyMinutes: 60 }))).events)[0].proposalId)).body as AutomationActivateResponse
    const id = first.automation.id
    await app.db.query(`UPDATE ai_automations SET status = 'paused', next_run_at = NULL WHERE id <> $1`, [id])
    const clock = new Clock()
    const engine = engineFor(app, clock)
    await engine.tick()
    // A machine registered after its run; before the next, its title is changed in the chat.
    await addMachines(app.db, ['91'])
    const change = automationEvents((await proposeInChat(watchDraft({ name: 'Hourly machines', replacesAutomationId: id }, { sql, everyMinutes: 60, titleTemplate: 'Machine added: {{machine}}' }))).events)[0]
    // The card and the model hear that its cases carry on, and how many are not told yet.
    expect(change.backtest).toMatchObject({ matched: 2, newCases: 1, keepsCases: true })
    expect(JSON.parse(resultsOf()[0].content as string)).toMatchObject({ backtest: { casesMatchingNow: 2, casesNotToldYet: 1 }, note: expect.stringContaining('its cases carry on') })
    expect((await activate(change.proposalId)).status).toBe(200)
    clock.advance(61 * MINUTE)
    await engine.tick()
    const fired = async () => (await app.db.query<{ fired: number }>(`SELECT fired FROM ai_automation_runs WHERE automation_id = $1 ORDER BY started_at`, [id])).rows.map((r) => r.fired)
    expect(await fired()).toEqual([0, 1])
    expect((await alertsOf(app.db, p.plain.user.id)).map((a) => a.title)).toContain('Machine added: 91. Machine')

    // A new query: what matches now and was never told is recorded as seen, unless the person asks otherwise.
    await addMachines(app.db, ['92'])
    const requery = automationEvents(
      (await proposeInChat(watchDraft({ name: 'Hourly machines', replacesAutomationId: id }, { sql: sql.replace('ORDER BY', "AND machine_code <> '0' ORDER BY"), everyMinutes: 60 }))).events,
    )[0]
    expect(requery.backtest).toMatchObject({ matched: 3, newCases: 1, keepsCases: false })
    expect((await activate(requery.proposalId)).status).toBe(200)
    clock.advance(61 * MINUTE)
    await engine.tick()
    expect(await fired()).toEqual([0, 1, 0])
    await app.db.query(`UPDATE ai_automations SET status = 'paused', next_run_at = NULL`)
  })

  it('runs no query for an activation that fails its other checks, and counts every attempt against the person’s runs', async () => {
    const part = automationEvents((await proposeInChat(watchDraft({ name: 'Never tried' }))).events)[0]
    const pools = vi.spyOn(app.aiReader, 'poolFor')
    try {
      const res = await activate(part.proposalId, p.creator, { edits: { recipients: [{ kind: 'user', userId: '00000000-0000-4000-8000-000000000000' }] } })
      expect(res.status).toBe(400)
      expect((res.body as ApiErrorBody).error.message).toContain('no active account has the id')
      expect(pools).not.toHaveBeenCalled()
    } finally {
      pools.mockRestore()
    }
    for (let i = 0; i < 60; i++) app.aiReportLimiter.hit(p.creator.user.id)
    try {
      const limited = await activate(part.proposalId)
      expect(limited.status).toBe(429)
      expect((limited.body as ApiErrorBody).error.code).toBe('rate_limited')
    } finally {
      app.aiReportLimiter.reset(p.creator.user.id)
    }
    expect((await activate(part.proposalId)).status).toBe(200)
    await app.db.query(`UPDATE ai_automations SET status = 'paused', next_run_at = NULL`)
  })
})

describe('§21 checking a draft', () => {
  let ctx: ValidationContext

  beforeAll(() => {
    ctx = {
      db: app.db,
      readers: app.aiReader,
      timeZone: app.config.FACTORY_TIMEZONE,
      creatorId: p.creator2.user.id,
      domains: ['inspection'],
      now: new Date(),
      runQueries: true,
    }
  })

  const errorsOf = async (draft: AutomationDraft, over: Partial<ValidationContext> = {}) => {
    const v = await validateDraft({ ...ctx, ...over }, draft)
    return v.ok ? [] : v.errors
  }

  it('names every problem, field by field', async () => {
    const user = (id: string) => ({ kind: 'user' as const, userId: id })
    const w = watchDraft()
    const r = reportDraft()
    const s = r.schedule!
    const cases: [string, AutomationDraft, RegExp][] = [
      ['no name', { ...w, name: '  ' }, /^name: give the automation a name/],
      ['long name', { ...w, name: 'x'.repeat(121) }, /^name: at most 120 characters/],
      ['no description', { ...w, description: '' }, /^description: say in plain words/],
      ['long description', { ...w, description: 'x'.repeat(1001) }, /^description: at most 1000/],
      ['watch without its part', { ...w, watch: undefined }, /^watch: a watch needs its query/],
      ['watch with a schedule', { ...w, schedule: s }, /^schedule: only a report has a schedule/],
      ['report without a schedule', { ...r, schedule: undefined }, /^schedule: a report needs its schedule/],
      ['report with a watch', { ...r, watch: w.watch }, /^watch: only a watch has a query of its own/],
      ['too often', watchDraft({}, { everyMinutes: 4 }), /^watch\.everyMinutes: from 5 to 1440/],
      ['too rarely', watchDraft({}, { everyMinutes: 1441 }), /^watch\.everyMinutes: from 5 to 1440/],
      ['no title', watchDraft({}, { titleTemplate: ' ' }), /^watch\.titleTemplate: give each case a title/],
      ['long title', watchDraft({}, { titleTemplate: 'x'.repeat(301) }), /^watch\.titleTemplate: at most 300/],
      ['long body', watchDraft({}, { bodyTemplate: 'x'.repeat(301) }), /^watch\.bodyTemplate: at most 300/],
      ['no key', watchDraft({}, { keyColumn: '' }), /^watch\.keyColumn: name the result column/],
      ['not a SELECT', watchDraft({}, { sql: 'DELETE FROM ai.machines' }), /^watch\.sql: Only a single SELECT/],
      ['two statements', watchDraft({}, { sql: 'SELECT 1 AS a; SELECT 2' }), /^watch\.sql: Only a single statement/],
      ['an error', watchDraft({}, { sql: 'SELECT nope FROM ai.machines' }), /^watch\.sql: column "nope" does not exist/],
      ['data not theirs', watchDraft({}, { sql: 'SELECT user_id AS machine_code FROM ai.users' }), /^watch\.sql: it reads data this person cannot read/],
      ['key not in the result', watchDraft({}, { keyColumn: 'code' }), /^watch\.keyColumn: the result has no column "code" \(it has "machine_code", "machine"\)/],
      ['key empty', watchDraft({}, { sql: `SELECT NULLIF(machine_code, '31') AS machine_code, machine FROM ai.machines` }), /^watch\.keyColumn: "machine_code" is empty in 1 of the \d+ rows/],
      ['key repeated', watchDraft({}, { sql: `SELECT 'same' AS machine_code, machine FROM ai.machines` }), /^watch\.keyColumn: "machine_code" repeats \("same"\)/],
      ['two columns of the key name', watchDraft({}, { sql: `SELECT machine_code, machine_code, machine FROM ai.machines` }), /^watch\.keyColumn: two columns of the result are named "machine_code"/],
      ['unknown placeholder', watchDraft({}, { titleTemplate: 'New {{machine_name}}' }), /^watch\.titleTemplate: \{\{machine_name\}\} is not a column of the result/],
      ['unknown placeholder in the body', watchDraft({}, { bodyTemplate: '{{x}}' }), /^watch\.bodyTemplate: \{\{x\}\} is not a column/],
      ['unknown session column', watchDraft({}, { sessionColumn: 'session_id' }), /^watch\.sessionColumn: the result has no column "session_id"/],
      ['unknown recipient column', watchDraft({ recipients: [{ kind: 'column', column: 'inspector_id' }] }), /^recipients: the result has no column "inspector_id"/],
      ['unknown assignee column', watchDraft({ actions: { notify: true, followUp: { assignee: { kind: 'column', column: 'owner_id' }, dueHours: 4 } } }), /^actions\.followUp\.assignee\.column: the result has no column "owner_id"/],
      ['no sections', reportDraft({}, { sections: [] }), /^schedule\.sections: from 1 to 8 sections/],
      ['nine sections', reportDraft({}, { sections: Array.from({ length: 9 }, (_, i) => ({ title: `S${i}`, sql: 'SELECT 1 AS one' })) }), /^schedule\.sections: from 1 to 8/],
      ['untitled section', reportDraft({}, { sections: [{ title: '', sql: 'SELECT 1 AS one' }] }), /^schedule\.sections\[0\]\.title: give the section a title/],
      ['section not a SELECT', reportDraft({}, { sections: [{ title: 'A', sql: 'UPDATE x SET y = 1' }] }), /^schedule\.sections\[0\]\.sql: Only a single SELECT/],
      ['placeholders with no period', reportDraft({}, { sections: [{ title: 'A', sql: 'SELECT count(*) AS n FROM ai.machines WHERE registered_at >= {{from}} AND registered_at < {{to}} + 1' }] }), /it uses \{\{from\}\} and \{\{to\}\}, but the report has no period/],
      ['a placeholder in a string', reportDraft({}, { period: { kind: 'yesterday' }, sections: [{ title: 'A', sql: `SELECT '{{from}}' AS x` }] }), /a placeholder is inside a quoted string/],
      ['one bound only', reportDraft({}, { period: { kind: 'yesterday' }, sections: [{ title: 'A', sql: 'SELECT count(*) AS n FROM ai.machines WHERE registered_at >= {{from}}' }] }), /^schedule\.sections\[0\]\.sql: .*Bound the data by both days/],
      ['a section that fails', reportDraft({}, { sections: [{ title: 'Broken', sql: 'SELECT nope FROM ai.machines' }] }), /^schedule\.sections\[0\] \("Broken"\): column "nope" does not exist/],
      ['a bad time', reportDraft({}, { time: '8:00' }), /^schedule\.time: HH:MM/],
      ['no weekdays', reportDraft({}, { weekdays: [] }), /^schedule\.weekdays: the days it runs/],
      ['a weekday that is none', reportDraft({}, { weekdays: [7 as never] }), /^schedule\.weekdays: the days it runs/],
      ['weekly with no day', reportDraft({}, { cadence: 'weekly' }), /^schedule\.weekday: the day a weekly report runs/],
      ['a weekday for a daily report', reportDraft({}, { weekday: 1 }), /^schedule\.weekday: only a weekly report/],
      ['the 29th', reportDraft({}, { cadence: 'monthly', monthDay: 29 }), /^schedule\.monthDay: the day of the month, 1 to 28/],
      ['a month day for a weekly report', reportDraft({}, { cadence: 'weekly', weekday: 1, monthDay: 3 }), /^schedule\.monthDay: only a monthly report/],
      ['weekdays for a weekly report', reportDraft({}, { cadence: 'weekly', weekday: 1, weekdays: [1] }), /^schedule\.weekdays: only a daily report/],
      ['people from a column in a report', reportDraft({ recipients: [{ kind: 'column', column: 'x' }] }), /^recipients\[0\]: a report has no case rows/],
      ['a report that tells nobody', reportDraft({ actions: { notify: false, followUp: null } }), /^actions\.notify: a report always tells its recipients/],
      ['a report with follow-ups', reportDraft({ actions: { notify: true, followUp: { assignee: { kind: 'creator' }, dueHours: 4 } } }), /^actions\.followUp: a report opens no follow-ups/],
      ['a watch that does nothing', watchDraft({ actions: { notify: false, followUp: null } }), /^actions: a watch must tell people/],
      ['no deadline', watchDraft({ actions: { notify: true, followUp: { assignee: { kind: 'creator' }, dueHours: 0 } } }), /^actions\.followUp\.dueHours: from 1 to 720/],
      ['too long a deadline', watchDraft({ actions: { notify: true, followUp: { assignee: { kind: 'creator' }, dueHours: 721 } } }), /^actions\.followUp\.dueHours: from 1 to 720/],
      ['an assignee who is no id', watchDraft({ actions: { notify: true, followUp: { assignee: user('bob'), dueHours: 4 } } }), /^actions\.followUp\.assignee\.userId: "bob" is not a user id/],
      ['an assignee who is nobody', watchDraft({ actions: { notify: true, followUp: { assignee: user('00000000-0000-4000-8000-000000000000'), dueHours: 4 } } }), /^actions\.followUp\.assignee\.userId: no active account/],
      ['nobody to tell', watchDraft({ recipients: [] }), /^recipients: name at least one/],
      ['too many to tell', watchDraft({ recipients: Array.from({ length: 51 }, (_, i) => ({ kind: 'column' as const, column: `c${i}` })) }), /^recipients: at most 50/],
      ['a recipient who is no id', watchDraft({ recipients: [user('bob')] }), /^recipients\[0\]\.userId: "bob" is not a user id/],
      ['a recipient who is nobody', watchDraft({ recipients: [user('00000000-0000-4000-8000-000000000000')] }), /^recipients\[0\]\.userId: no active account has the id/],
      ['no channel', watchDraft({ channels: { bell: false, chat: false } }), /^channels: choose the bell, the chat, or both/],
      ['replacing something that is no id', watchDraft({ replacesAutomationId: 'abc' }), /^replacesAutomationId: "abc" is not an automation id/],
    ]
    for (const [what, draft, expected] of cases) {
      const errors = await errorsOf(draft)
      expect(errors.some((e) => expected.test(e)), `${what}: ${JSON.stringify(errors)}`).toBe(true)
    }
  })

  it('refuses the system sender, inactive accounts, another kind replaced, and the 51st automation', async () => {
    const system = (await app.db.query<{ id: string }>(`SELECT id FROM users WHERE is_system`)).rows[0].id
    expect(await errorsOf(watchDraft({ recipients: [{ kind: 'user', userId: system }] }))).toEqual([`recipients[0].userId: no active account has the id ${system}.`])
    await app.db.query(`UPDATE users SET is_active = false WHERE id = $1`, [p.viewer.user.id])
    expect(await errorsOf(watchDraft({ recipients: [{ kind: 'user', userId: p.viewer.user.id }] }))).toEqual([`recipients[0].userId: no active account has the id ${p.viewer.user.id}.`])
    await app.db.query(`UPDATE users SET is_active = true WHERE id = $1`, [p.viewer.user.id])
    const report = await insertAutomation(app.db, { creatorId: p.creator2.user.id, kind: 'report', status: 'paused', nextRunAt: null })
    expect(await errorsOf(watchDraft({ replacesAutomationId: report }))).toEqual(['replacesAutomationId: that automation is a report; a change keeps its kind.'])
    const held = (await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ai_automations WHERE creator_id = $1 AND deleted_at IS NULL`, [p.creator2.user.id])).rows[0].n
    for (let i = held; i < 50; i++) await insertAutomation(app.db, { creatorId: p.creator2.user.id, status: 'paused', nextRunAt: null })
    expect(await errorsOf(watchDraft())).toEqual(['This person already has 50 automations, the most allowed. Delete one, or change one of them instead.'])
    // A change takes no room.
    expect(await errorsOf(watchDraft({ replacesAutomationId: (await app.db.query<{ id: string }>(`SELECT id FROM ai_automations WHERE creator_id = $1 AND kind = 'watch' LIMIT 1`, [p.creator2.user.id])).rows[0].id }))).toEqual([])
    await app.db.query(`UPDATE ai_automations SET deleted_at = now() WHERE creator_id = $1`, [p.creator2.user.id])
  })

  it('reads the tool input strictly, naming what is wrong', () => {
    expect(readDraft({ ...watchDraft(), extra: 1 })).toEqual({ errors: [expect.stringContaining('Unrecognized key')] })
    expect(readDraft({ ...watchDraft(), kind: 'alarm' })).toEqual({ errors: [expect.stringMatching(/^kind: Invalid enum value/)] })
    expect(readDraft({ ...reportDraft(), schedule: { ...reportDraft().schedule, period: { kind: 'last_days', days: 0 } } })).toEqual({
      errors: [expect.stringMatching(/^schedule\.period: .* is not a period a report can have/)],
    })
    // Fields left out as null are fine; the period becomes the shared type.
    const read = readDraft({ ...reportDraft(), replacesAutomationId: null, schedule: { ...reportDraft().schedule, weekdays: null, period: { kind: 'last_days', days: 7, from: null, to: null, weekStart: null } } })
    expect(read).toEqual({ draft: expect.objectContaining({ schedule: expect.objectContaining({ period: { kind: 'last_days', days: 7 } }) }) })
    expect('draft' in read && read.draft.schedule).not.toHaveProperty('weekdays')
  })

  it('backtests: a watch counts what matches now; a report runs its sections over its period as of today', async () => {
    const codes = (await app.db.query<{ code: string }>(`SELECT code FROM machines WHERE deleted_at IS NULL ORDER BY code`)).rows.map((r) => r.code)
    const watch = await validateDraft(ctx, watchDraft({}, { sql: `SELECT machine_code, machine FROM ai.machines WHERE machine_code IN ('31', '58') ORDER BY machine_code DESC` }))
    expect(watch.ok).toBe(true)
    expect(watch.backtest).toMatchObject({ ok: true, matched: 2, truncated: false, sampleRows: [['58', '58. Machine'], ['31', '31. Machine']], sampleTitle: `New machine ${isolate('58. Machine')}`, sampleBody: `Code ${isolate('58')}` })
    const today = factoryDay()
    const report = await validateDraft(
      ctx,
      reportDraft({}, {
        period: { kind: 'last_days', days: 7 },
        sections: [
          { title: 'Machines', sql: 'SELECT count(*)::int AS machines FROM ai.machines' },
          { title: 'Registered this week', sql: 'SELECT machine_code FROM ai.machines WHERE registered_at >= {{from}} AND registered_at < {{to}} + 1 ORDER BY machine_code' },
        ],
      }),
    )
    expect(report.ok, JSON.stringify(report)).toBe(true)
    expect(report.backtest).toMatchObject({
      ok: true,
      period: { from: factoryDay(-6), to: today, label: 'Last 7 days' },
      sections: [
        { title: 'Machines', ok: true, columns: ['machines'], rows: [[codes.length]], rowCount: 1 },
        { title: 'Registered this week', ok: true, columns: ['machine_code'], rows: codes.map((c) => [c]), rowCount: codes.length },
      ],
    })
  })
})
