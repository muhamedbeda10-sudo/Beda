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
import { RUN_SQL_TOOL, conversationTools, renderSystemPrompt } from '../src/ai/prompt'
import { describeAiSchema } from '../src/ai/schemaDoc'
import { asksForConfirmation, checkAgreement, normalizeQuote } from '../src/automations/confirmation'
import { readConfirmation, readDraft } from '../src/automations/draft'
import { isolate } from '../src/automations/text'
import { AUTOMATION_TOOLS, PROPOSE_AUTOMATION_TOOL_NAME, automationToolHandlers } from '../src/automations/tools'
import { queryErrorForPeople, validateDraft, type QueryFailed, type ValidationContext } from '../src/automations/validate'
import { withTransaction } from '../src/db/pool'

// §21 — an automation is proposed in the assistant's chat and nothing runs
// until the person who asked presses Activate. The tools exist only in new
// conversations of people allowed to automate; what a conversation was sent
// is never changed. Every draft is checked (and run once) before it is kept.
// §22 — the plan is agreed in words first: a proposal carries the person's
// words of agreement from their latest message, never in a conversation's
// first answer; a new version of a proposal supersedes the one it revises.
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

const toolUseId = () => `toolu_${Math.random().toString(36).slice(2, 10)}`

/** What the person writes to agree to the plan, and the words of it the model quotes. */
const AGREED = 'Yes, go ahead.'
const AGREEMENT = 'Yes, go ahead'

/** The person asks for an automation in a new conversation and the assistant describes the plan, asking them to confirm it (§22). */
async function describePlan(as = p.creator, request = 'Tell the supervisors about every new machine.') {
  app.model.reply({
    content: [text('The plan: a watch on the machine register every 5 minutes, telling every supervisor in the bell about each new machine. Shall I propose it?')],
  })
  const res = await ask(app, as, request)
  expect(res.status, JSON.stringify(res.error)).toBe(200)
  return res
}

/**
 * The creator agrees to a plan the assistant described and it proposes the
 * draft, quoting their words: in a new conversation that describes the plan
 * first, or in the one given (after its own plan). The stream and the conversation.
 */
async function proposeInChat(draft: unknown, as = p.creator, conversationId?: string, agreed = AGREED, confirmation: string | null = AGREEMENT) {
  const conversation = conversationId ?? (await describePlan(as)).conversationId
  const input = confirmation === null ? draft : { confirmation, ...(draft as object) }
  app.model.reply({ content: [text('Let me set that up.'), propose(toolUseId(), input)] }, { content: [text('Proposed: press Activate to start it.')] })
  const res = await ask(app, as, agreed, conversation)
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
    // Everyone's new conversation reads notices (§23); the automations' tools come before those.
    expect(toolsOf(plain)).toEqual(['run_sql', 'list_notices', 'notice_details'])
    expect(systemOf(plain)).not.toContain('# Automations')
    await ask(app, p.creator, 'Hello')
    const creator = lastCall()
    expect(toolsOf(creator)).toEqual(['run_sql', 'propose_automation', 'my_automations', 'list_notices', 'notice_details'])
    expect(creator.params.tools![1]).toMatchObject({ eager_input_streaming: true, input_schema: { additionalProperties: false } })
    // Not strict: together with run_sql's, its alternatives compile to a grammar the API refuses as too large.
    expect(creator.params.tools![1]).not.toHaveProperty('strict')
    await ask(app, p.owner, 'Hello')
    // The owner, an administrator, may also have notices written.
    expect(toolsOf()).toEqual(['run_sql', 'propose_automation', 'my_automations', 'list_notices', 'notice_details', 'find_notice_targets', 'propose_notice_change'])

    // Without automations the prompt is the one it always was, byte for byte; with them, one section more.
    const tz = app.config.FACTORY_TIMEZONE
    const schema = await describeAiSchema(app.db, ['inspection'])
    expect(systemOf(plain)).toBe(renderSystemPrompt(tz, schema, ['inspection'], { notices: 'reader' }))
    const asker = { id: p.creator.user.id, name: p.creator.user.name, role: p.creator.user.role }
    const withSection = renderSystemPrompt(tz, schema, ['inspection'], { automations: asker, notices: 'reader' })
    expect(systemOf(creator)).toBe(withSection)
    const section = withSection.slice(withSection.indexOf('# Automations'), withSection.indexOf('# Read-only'))
    expect(section).toContain('Nothing runs until the person presses Activate')
    expect(section).toContain('never changes any data')
    // "Me" in a request is the person asking: the section names them, so the model never has to ask.
    expect(section).toContain(`The person asking is ${JSON.stringify(asker.name)} (user id ${asker.id}, role ${asker.role})`)
    expect(section).toContain(`{"kind": "user", "userId": "${asker.id}"}`)
    expect(withSection.replace(section, '')).toBe(systemOf(plain))

    // §22 — everyone's assistant works as a consultant (asks, explains, offers ways forward) and suggests likely replies.
    for (const prompt of [systemOf(plain), withSection]) {
      const consult = prompt.indexOf('# When a request is unclear or cannot be met as asked')
      expect(consult).toBeGreaterThan(prompt.indexOf('# How you work'))
      expect(consult).toBeLessThan(prompt.indexOf('# Time'))
      expect(prompt).toContain('ask instead of guessing: at most three short questions, each with the choice you would make')
      expect(prompt).toContain('offer two or three ways forward, each with what it gives and what it misses')
      expect(prompt).toContain('marked clearly as needing development - something the assistant cannot do or arrange itself')
      expect(prompt).toContain('Recommend one and say why')
      expect(prompt).toContain('the suggestions are their likely replies, written as they would type them')
      // A clear question is answered: a detail left out with a usual reading is no reason to ask, nor to query the catalog first.
      expect(prompt).toContain('a detail left out that has a usual reading is not an ambiguity')
      expect(prompt).toContain('A clear question needs no queries beyond the ones that answer it.')
      expect(prompt).toContain('close with your questions instead')
      // Nothing reaches the developers; what the person was not given is not "needs development".
      expect(prompt).toContain('nothing in this chat reaches the people who develop the app')
      expect(prompt).toContain('the assistant\'s owner decides what each person gets. Never call it something that needs development.')
    }
    // Automations are agreed in words before any card, with the person's words passed along; a revision names what it revises.
    expect(section).toContain('Agree on the plan in words before any automation card.')
    expect(section).toContain('Ask them to confirm it or change it, and stop there: no propose_automation call in that answer.')
    expect(section).toContain('Choosing one of several options you offered is agreement only when you described that option as a full plan')
    expect(section).toContain('Call propose_automation only after they agree, in a later message, and pass their words of agreement as confirmation, exactly as they wrote them')
    expect(section).toContain('set revisesProposalId to its proposalId: its card is marked as replaced by the new one. Keep everything they did not ask to change, replacesAutomationId included.')
    // The tool asks for the person's words first, as the prompt does.
    const input = (creator.params.tools![1] as { input_schema: { properties: Record<string, { description?: string }>; required: string[] } }).input_schema
    expect(Object.keys(input.properties)[0]).toBe('confirmation')
    expect(input.required).toContain('confirmation')
    expect(input.properties.confirmation.description).toContain('copied exactly as they wrote them in their latest message')
    expect(input.properties.revisesProposalId.description).toMatch(/^Optional\. The proposalId \(from its propose_automation result\) of an earlier proposal of this conversation .* Keep that proposal's replacesAutomationId\./)
    expect(input.required).not.toContain('revisesProposalId')
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
      expect(toolsOf()).toEqual(['run_sql', 'list_notices', 'notice_details'])
      // A propose_automation call there is a tool it never had.
      app.model.reply({ content: [propose('toolu_old', watchDraft())] }, { content: [text('I cannot.')] })
      await ask(app, p.plain, 'Watch the machines', before.conversationId)
      expect(resultsOf()).toEqual([
        { type: 'tool_result', tool_use_id: 'toolu_old', is_error: true, content: 'Unknown tool "propose_automation". The tools are "run_sql", "list_notices", "notice_details".' },
      ])
      expect((await app.db.query(`SELECT 1 FROM ai_automation_proposals WHERE tool_use_id = 'toolu_old'`)).rowCount).toBe(0)

      app.model.reply({ content: [text('Hi again.')] })
      const fresh = await ask(app, p.plain, 'A new conversation')
      expect(toolsOf()).toEqual(['run_sql', 'propose_automation', 'my_automations', 'list_notices', 'notice_details'])
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

  it('tells the model what to change in a query reading data the person cannot read, and the card says it plainly', async () => {
    const res = await proposeInChat(watchDraft({}, { sql: 'SELECT user_id AS machine_code, name AS machine FROM ai.users' }))
    const [part] = automationEvents(res.events)
    expect(part.backtest).toMatchObject({ ok: false, error: 'It reads data you cannot read.' })
    const [result] = resultsOf()
    expect(result.is_error).toBe(true)
    expect(result.content).toContain('- watch.sql: it reads data this person cannot read. Use only the views described in the system prompt.')
    // The card's words are the person's, never in what the model reads.
    expect(result.content).toContain('What it found when run: {"ok":false}')
    expect(result.content).not.toContain('you cannot read')
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

  it('says plainly why an activation fails when the person can no longer read what it reads', async () => {
    await grant(app, p.owner, p.creator, { automations: true, domains: ['inspection', 'materials'] })
    try {
      const part = automationEvents((await proposeInChat(watchDraft({ name: 'Coils' }, { sql: `SELECT coil_id::text AS machine_code, 'x' AS machine FROM ai.coils` }))).events)[0]
      expect(part).toMatchObject({ ok: true, state: 'proposed' })
      // The coil register taken away before Activate is pressed.
      await grant(app, p.owner, p.creator, { automations: true })
      const res = await activate(part.proposalId)
      expect(res.status).toBe(400)
      expect((res.body as ApiErrorBody).error.message).toBe('watch.sql: It reads data you cannot read.')
    } finally {
      await grant(app, p.owner, p.creator, { automations: true })
    }
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

  it('tells the model what to change in a failing query, and people what went wrong in plain words', async () => {
    const notTheirs = watchDraft({}, { sql: 'SELECT user_id AS machine_code FROM ai.users' })
    const forModel = await validateDraft(ctx, notTheirs)
    expect(forModel).toMatchObject({ ok: false, errors: ['watch.sql: it reads data this person cannot read. Use only the views described in the system prompt.'] })
    // The card shows the trial run to the person who asked for it.
    expect(forModel.backtest).toMatchObject({ ok: false, error: 'It reads data you cannot read.' })
    // An activation: the person pressing Activate reads the errors.
    expect(await errorsOf(notTheirs, { readBy: 'person' })).toEqual(['watch.sql: It reads data you cannot read.'])

    const broken = await validateDraft(ctx, watchDraft({}, { sql: 'SELECT nope FROM ai.machines' }))
    expect(broken.ok ? [] : broken.errors).toEqual([expect.stringMatching(/^watch\.sql: column "nope" does not exist \(at character 8\)/)])
    expect(broken.backtest).toMatchObject({ ok: false, error: 'The query failed: column "nope" does not exist.' })

    const section = reportDraft({}, { sections: [{ title: 'Users', sql: 'SELECT count(*) AS n FROM ai.users' }] })
    const report = await validateDraft(ctx, section)
    expect(report.ok ? [] : report.errors).toEqual(['schedule.sections[0] ("Users"): it reads data this person cannot read. Use only the views described in the system prompt.'])
    expect(report.backtest?.sections).toEqual([expect.objectContaining({ title: 'Users', ok: false, error: 'It reads data you cannot read.' })])
    expect(await errorsOf(section, { readBy: 'person' })).toEqual(['schedule.sections[0] ("Users"): It reads data you cannot read.'])

    // What a change names, as the person reads it: no tool to look it up with.
    expect(await errorsOf(watchDraft({ replacesAutomationId: '00000000-0000-4000-8000-000000000000' }), { readBy: 'person' })).toEqual([
      'The automation this proposal changes no longer exists.',
    ])
  })

  it('words every kind of query failure for people, never with the model’s instructions', () => {
    const long = `invalid input syntax for type integer: "${'x'.repeat(500)}"`
    const cases: [QueryFailed, 'creator' | 'asker', string | RegExp][] = [
      [{ failure: 'database', code: '42501', error: 'permission denied for view coils Only the views and functions in schema ai can be read.' }, 'creator', 'It reads data its creator can no longer read.'],
      [{ failure: 'database', code: '42501', dbMessage: 'permission denied for view coils' }, 'asker', 'It reads data you cannot read.'],
      [{ failure: 'database', code: '22012', error: 'division by zero (at character 9)', dbMessage: 'division by zero' }, 'creator', 'The query failed: division by zero.'],
      [{ failure: 'database', code: 'P0001', dbMessage: 'Already a sentence.' }, 'creator', 'The query failed: Already a sentence.'],
      [{ failure: 'database', code: '22P02', dbMessage: long }, 'creator', /^The query failed: invalid input syntax for type integer: "x+…$/],
      [{ failure: 'database', code: 'XX000' }, 'creator', 'The query failed.'],
      [{ failure: 'timeout', code: '57014', error: 'The query took too long (10 s). Narrow it or aggregate.' }, 'creator', 'The query took too long and was stopped.'],
      [{ failure: 'row-too-large', error: 'A row of the result is larger than 256 KB. Select fewer or shorter columns, or aggregate.' }, 'creator', 'A row of its result was too large to read.'],
      [{ failure: 'reply-too-large', error: 'The query failed with an error message longer than 320 KB' }, 'creator', "The database's reply was too large to read."],
      [{ failure: 'stopped', error: 'Stopped.' }, 'creator', 'The query was stopped before it finished.'],
      [{ failure: 'unavailable', error: 'The database could not run the query just now. Try again.' }, 'creator', "The factory's data could not be reached just now."],
      [{ failure: 'rejected', error: 'Only a single SELECT (or WITH … SELECT) is allowed: the assistant can only read the views in schema ai.' }, 'creator', 'The app no longer accepts this query.'],
      [{ error: 'Something else.' }, 'creator', 'The query failed.'],
    ]
    for (const [run, reader, expected] of cases) {
      const said = queryErrorForPeople(run, reader)
      if (typeof expected === 'string') expect(said, JSON.stringify(run)).toBe(expected)
      else expect(said, JSON.stringify(run)).toMatch(expected)
      expect(said).not.toMatch(/prompt|views|schema|tool|model|aggregate|Narrow|character/i)
    }
    expect(Array.from(queryErrorForPeople({ failure: 'database', code: '22P02', dbMessage: long })).length).toBeLessThanOrEqual('The query failed: '.length + 200)
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
    // §22 — the person's words are read on their own, whatever the draft's shape, and never kept in it; the version it revises is.
    const revised = '6f1c1b2e-3d4a-4b5c-8d6e-7f8091a2b3c4'
    const withWords = readDraft({ confirmation: 'Yes, go ahead', ...watchDraft(), revisesProposalId: revised })
    expect(withWords).toEqual({ draft: { ...watchDraft(), revisesProposalId: revised } })
    expect(readDraft({ ...watchDraft(), confirmation: 7 })).toEqual({ errors: [expect.stringMatching(/^confirmation: Expected string/)] })
    expect(readConfirmation({ confirmation: 'Yes, go ahead', kind: 'alarm' })).toBe('Yes, go ahead')
    expect(readConfirmation({ confirmation: 7, ...watchDraft() })).toBeNull()
    expect(readConfirmation(watchDraft())).toBeNull()
    expect(readConfirmation(null)).toBeNull()
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

describe('§22 agreed in words before the card', () => {
  const proposalsOf = async (conversationId: string) =>
    (
      await app.db.query<{ id: string; ok: boolean; state: string; confirmation: string | null; draft: Record<string, unknown> | null }>(
        `SELECT id, ok, state, confirmation, draft FROM ai_automation_proposals WHERE conversation_id = $1 ORDER BY created_at, id`,
        [conversationId],
      )
    ).rows
  /** The result the tool call of the `i`th request of this test got. */
  const resultAt = (i: number) => resultsOf(app.model.calls[i])[0]

  it('refuses a proposal in the first answer of a conversation, even quoting words of the question: nothing kept, no card', async () => {
    app.model.reply(
      { content: [text('Setting it up.'), propose('toolu_first', { confirmation: 'go ahead', ...watchDraft() })] },
      { content: [text('The plan: a watch on the machine register every 5 minutes, telling every supervisor. Shall I propose it?')] },
    )
    const res = await ask(app, p.creator, 'Tell the supervisors about every new machine, go ahead.')
    expect(res.status).toBe(200)
    const refused = resultsOf()
    expect(refused).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'toolu_first',
        is_error: true,
        content: expect.stringMatching(/^Not proposed: this is the first answer of the conversation, so the person has not agreed to a plan yet\. Instead, describe the plan to the person in words/),
      },
    ])
    expect(refused[0].content).toContain('Call propose_automation again only after they agree, in a later message, with confirmation set to their words of agreement exactly as they wrote them.')
    expect(automationEvents(res.events)).toEqual([])
    expect(res.done!.message.parts.some((x) => x.type === 'automation')).toBe(false)
    expect(await proposalsOf(res.conversationId)).toEqual([])

    // The refusal stays in the replay byte for byte; once the person agrees, the proposal goes through.
    const before = lastCall()
    const agreed = await proposeInChat(watchDraft({ name: 'After the plan' }), p.creator, res.conversationId)
    const next = app.model.calls[app.model.calls.length - 2]
    expect(JSON.stringify(next.params.messages.slice(0, before.params.messages.length))).toBe(JSON.stringify(before.params.messages))
    expect(automationEvents(agreed.events)).toEqual([expect.objectContaining({ ok: true, state: 'proposed' })])
  })

  it('refuses words that are not in the person’s latest message, none, or too few; quoted again exactly, the proposal goes through', async () => {
    const plan = await describePlan()
    app.model.reply(
      // Words of the first message, not of this one.
      { content: [propose('toolu_old_words', { confirmation: 'Tell the supervisors', ...watchDraft() })] },
      { content: [propose('toolu_no_words', watchDraft())] },
      { content: [propose('toolu_few_words', { confirmation: '!', ...watchDraft() })] },
      { content: [propose('toolu_words', { confirmation: 'sounds good, DO IT', ...watchDraft({ name: 'Quoted again' }) })] },
      { content: [text('Proposed: press Activate to start it.')] },
    )
    const res = await ask(app, p.creator, 'Sounds good, do it.', plan.conversationId)
    expect(res.status).toBe(200)
    const retry = "The confirmation must be the person's words of agreement, copied exactly from their latest message. If that message agrees to the plan you described, call again with confirmation set to its words exactly as they wrote them. If it does not, describe the plan to the person in words"
    expect(resultAt(2)).toMatchObject({ tool_use_id: 'toolu_old_words', is_error: true })
    expect(resultAt(2).content).toMatch(/^Not proposed: the confirmation "Tell the supervisors" is not in the person's latest message\. /)
    expect(resultAt(2).content).toContain(retry)
    expect(resultAt(2).content).toMatch(/Call propose_automation again only after they agree, in a later message, with confirmation set to their words of agreement exactly as they wrote them\.$/)
    expect(resultAt(3)).toMatchObject({ tool_use_id: 'toolu_no_words', is_error: true, content: expect.stringContaining(`Not proposed: the call has no confirmation. ${retry}`) })
    // Too short to be words: quote the words the message has, or ask for words when it has none - never the same call again.
    expect(resultAt(4)).toMatchObject({
      tool_use_id: 'toolu_few_words',
      is_error: true,
      content:
        'Not proposed: the confirmation "!" is too short to be words of agreement. ' +
        "If the person's latest message has words agreeing to the plan you described, call again with confirmation set to those words exactly as they wrote them. " +
        'If it has no words (an emoji or a single letter), ask them to confirm the plan in words, briefly and without describing it again, and stop there; call propose_automation again only after they do.',
    })
    expect(resultAt(5)).toMatchObject({ tool_use_id: 'toolu_words' })
    expect(resultAt(5).is_error).toBeUndefined()
    // Only the call that passed left a proposal and a card; the words are kept as quoted, never in the draft.
    const parts = automationEvents(res.events)
    expect(parts).toEqual([expect.objectContaining({ ok: true, state: 'proposed', draft: expect.objectContaining({ name: 'Quoted again' }) })])
    expect(parts[0].draft).not.toHaveProperty('confirmation')
    const stored = await proposalsOf(plan.conversationId)
    expect(stored).toEqual([expect.objectContaining({ id: parts[0].proposalId, ok: true, confirmation: 'sounds good, DO IT' })])
    expect(stored[0].draft).not.toHaveProperty('confirmation')
  })

  it('keeps the words of a proposal that does not pass too: they were agreed all the same', async () => {
    const res = await proposeInChat(watchDraft({}, { keyColumn: 'machine_id_typo' }))
    expect(await proposalsOf(res.conversationId)).toEqual([expect.objectContaining({ ok: false, confirmation: AGREEMENT })])
  })

  it('finds the person’s words however they were spelled: diacritics, tatweel, alef, yaa and taa marbuta forms, spacing, case, quotes', async () => {
    const turn = (question: string) => ({ question, answeredBefore: true })
    const cases: [string, string][] = [
      // The person wrote harakat and hamzas; the model quoted bare letters, spaced otherwise.
      ['مُوافِقٌ، أَنشِئْ التَّنبيهَ يا مُديرُ', 'موافق، انشئ  التنبيه'],
      // Alef maqsura and taa marbuta written as yaa and haa; a stretched word.
      ['تمـــام على بركة الله', 'تمام علي بركه الله'],
      // Alef with hamza below and with madda; the lines run together.
      ['  إبدأ\n\nالآن ', 'ابدا الان'],
      // Quotes and punctuation around the words, another case; a presentation form (NFKC) and a direction mark.
      ['Yes, GO ahead!', '"yes, go ahead"'],
      ['‏ﻻ مانع، ابدأ', '«لا مانع»'],
      ['Ｙｅｓ please', 'yes'],
      // Punctuation of another form or spacing inside the words, as keyboards and the model write it.
      ['Yes, let’s go', "Yes, let's go"],
      ['“ok” do it', '"ok" do it'],
      ['تمام، ابدأ', 'تمام, ابدأ'],
      ['موافق? ايوه', 'موافق؟ ايوه'],
      ['yes – go', 'yes - go'],
      ['yes,go ahead', 'yes, go ahead'],
      ['تمام؛ كمل', 'تمام; كمل'],
      // Arabic-Indic (and Persian) digits and the Arabic percent sign, for the change the person asked for.
      ['خليها ٢٠٪', 'خليها 20%'],
      ['make it ۱۵ minutes', 'make it 15 minutes'],
    ]
    for (const [question, quote] of cases) expect(checkAgreement(quote, turn(question)), `${quote} in ${question}`).toEqual({ ok: true, confirmation: quote.trim() })
    expect(normalizeQuote(' «مُوافِقٌ»‏ ')).toBe('موافق')
    expect(normalizeQuote('«Ｙｅｓ،   GO»')).toBe('yes go')
    expect(normalizeQuote('خليها ٢٠٪ أو ۳۰٪')).toBe('خليها 20 او 30')
    // Other words are other words; nothing before a plan was described.
    expect(checkAgreement('لا', turn('نعم ابدأ'))).toMatchObject({ ok: false, refusal: expect.stringContaining('is not in the person\'s latest message') })
    expect(checkAgreement('yes, start', turn('Yes, go ahead'))).toMatchObject({ ok: false })
    expect(checkAgreement('ـ', turn('ـــ'))).toMatchObject({ ok: false, refusal: expect.stringContaining('too short') })
    // A lone emoji or letter is no words, whatever its code points: a thumbs-up with a skin tone is one character as people see it.
    for (const quote of ['👍', '👍🏻', '✅', 'k', '"y"']) {
      expect(checkAgreement(quote, turn(quote)), quote).toMatchObject({ ok: false, refusal: expect.stringContaining('If it has no words (an emoji or a single letter), ask them to confirm the plan in words') })
    }
    expect(checkAgreement('ok 👍', turn('ok 👍'))).toEqual({ ok: true, confirmation: 'ok 👍' })
    expect(checkAgreement('yes', { question: 'yes', answeredBefore: false })).toMatchObject({ ok: false, refusal: expect.stringMatching(/^Not proposed: this is the first answer/) })
    // A refused quote is shown back short.
    const long = checkAgreement('x'.repeat(500), turn('yes'))
    expect(!long.ok && long.refusal).toContain(`"${'x'.repeat(79)}…"`)

    // Through the chat: written with harakat, quoted without.
    const plan = await describePlan(p.creator, 'نبّه المشرفين بكل ماكينة جديدة')
    const res = await proposeInChat(watchDraft({ name: 'ماكينات جديدة', language: 'ar' }), p.creator, plan.conversationId, 'مُوافِقٌ، أَنشِئْهُ', 'موافق، انشئه')
    const [part] = automationEvents(res.events)
    expect(part).toMatchObject({ ok: true, state: 'proposed' })
    expect(await proposalsOf(plan.conversationId)).toEqual([expect.objectContaining({ id: part.proposalId, confirmation: 'موافق، انشئه' })])
  })

  it('goes on without the check in a conversation begun before it, whose tool asks for no confirmation, sent as it was', async () => {
    type Schema = { properties: Record<string, unknown>; required: string[] }
    const earlier = conversationTools(AUTOMATION_TOOLS).map((t) => {
      if (t.name !== PROPOSE_AUTOMATION_TOOL_NAME) return t
      const schema = t.input_schema as unknown as Schema
      const { confirmation: _words, revisesProposalId: _revision, ...properties } = schema.properties
      return { ...t, input_schema: { ...schema, properties, required: schema.required.filter((r) => r !== 'confirmation') } }
    })
    expect(asksForConfirmation(conversationTools(AUTOMATION_TOOLS), PROPOSE_AUTOMATION_TOOL_NAME)).toBe(true)
    expect(asksForConfirmation(earlier as Anthropic.Beta.BetaTool[], PROPOSE_AUTOMATION_TOOL_NAME)).toBe(false)
    expect(asksForConfirmation([RUN_SQL_TOOL], PROPOSE_AUTOMATION_TOOL_NAME)).toBe(false)
    const { rows } = await app.db.query<{ id: string; tools: string }>(
      `INSERT INTO ai_conversations (user_id, title, model, system_prompt, tools) VALUES ($1, 'Before §22', 'claude-sonnet-5-5', 'An earlier prompt.', $2::json)
       RETURNING id, tools::text AS tools`,
      [p.creator.user.id, JSON.stringify(earlier)],
    )
    app.model.reply({ content: [propose('toolu_before', watchDraft({ name: 'Before §22' }))] }, { content: [text('Proposed: press Activate to start it.')] })
    // Its first question, and a proposal with no words of agreement: as its tool and prompt have it.
    const res = await ask(app, p.creator, 'Tell the supervisors about every new machine.', rows[0].id)
    expect(JSON.stringify(lastCall().params.tools)).toBe(rows[0].tools)
    expect(systemOf()).toBe('An earlier prompt.')
    const [part] = automationEvents(res.events)
    expect(part).toMatchObject({ ok: true, state: 'proposed', draft: { name: 'Before §22' } })
    expect(await proposalsOf(rows[0].id)).toEqual([expect.objectContaining({ ok: true, confirmation: null })])
  })
})

describe('§22 a new version of a proposal', () => {
  const stateOf = async (proposalId: string) =>
    (await app.db.query<{ state: string; decidedBy: string | null; decided: boolean }>(
      `SELECT state, decided_by_id AS "decidedBy", decided_at IS NOT NULL AS decided FROM ai_automation_proposals WHERE id = $1`,
      [proposalId],
    )).rows[0]
  const discard = (proposalId: string, as = p.creator) =>
    app.api<AutomationDiscardResponse | ApiErrorBody>('POST', `/api/ai/automation-proposals/${proposalId}/discard`, { token: as.token })
  /** The person asks for a change of the plan: that request is their agreement to it, and the model quotes it. */
  const revise = (conversationId: string, draft: AutomationDraft, request = 'Make it every 15 minutes instead.', words = 'every 15 minutes') =>
    proposeInChat(draft, p.creator, conversationId, request, words)
  /**
   * A propose_automation call in the latest question of a conversation, after the person agreed, run by
   * its handler as an answer runs it: its outcome, whose store (the answer's transaction) is left to the test.
   */
  const callPropose = async (conversationId: string, draft: AutomationDraft) => {
    const turn = await app.db.query<{ id: string }>(`SELECT id FROM ai_turns WHERE conversation_id = $1 ORDER BY created_at DESC, id LIMIT 1`, [conversationId])
    const handlers = automationToolHandlers({
      db: app.db,
      config: app.config,
      readers: app.aiReader,
      userId: p.creator.user.id,
      conversationId,
      turnId: turn.rows[0].id,
      confirmFirst: true,
      emit: () => undefined,
    })
    const tu = { type: 'tool_use', id: toolUseId(), name: PROPOSE_AUTOMATION_TOOL_NAME, input: { confirmation: AGREEMENT, ...draft } } as Anthropic.Beta.BetaToolUseBlock
    const outcome = await handlers[PROPOSE_AUTOMATION_TOOL_NAME].run(tu, new AbortController().signal)
    const told = JSON.parse(outcome.result.content as string) as { proposalId: string; note: string }
    return { ...outcome, told }
  }
  afterAll(async () => {
    await app.db.query(`UPDATE ai_automations SET status = 'paused', next_run_at = NULL`)
  })

  it('supersedes the version it revises once it passes: the older card says so, and can no longer be activated or discarded', async () => {
    const first = await proposeInChat(watchDraft({ name: 'Machines, every 5 minutes' }))
    const old = automationEvents(first.events)[0]
    const res = await revise(first.conversationId, watchDraft({ name: 'Machines, every 15 minutes', revisesProposalId: old.proposalId }, { everyMinutes: 15 }))
    const [revision] = automationEvents(res.events)
    // The card names what it revises, so the open chat marks the older card at once.
    expect(revision).toMatchObject({ ok: true, state: 'proposed', draft: { revisesProposalId: old.proposalId, watch: { everyMinutes: 15 } } })
    expect(JSON.parse(resultsOf()[0].content as string).note).toContain('The card of the version it revises is marked as replaced by this one.')
    expect(await stateOf(old.proposalId)).toEqual({ state: 'superseded', decidedBy: p.creator.user.id, decided: true })
    // Opened again, the conversation shows each card as it stands.
    const shown = await app.api<AiMessagesResponse>('GET', `/api/ai/conversations/${first.conversationId}/messages`, { token: p.creator.token })
    const cards = shown.body.messages.flatMap((m) => m.parts).filter((x): x is AiAutomationPart => x.type === 'automation')
    expect(cards.map((c) => [c.proposalId, c.state])).toEqual([
      [old.proposalId, 'superseded'],
      [revision.proposalId, 'proposed'],
    ])
    expect(cards[0]).toMatchObject({ ok: true, draft: { name: 'Machines, every 5 minutes' } })
    for (const pressed of [await activate(old.proposalId), await discard(old.proposalId)]) {
      expect(pressed.status).toBe(409)
      expect((pressed.body as ApiErrorBody).error.message).toBe('A newer version of this proposal was made below; activate that one.')
    }
    // The new version activates, and only it becomes an automation.
    const activated = await activate(revision.proposalId)
    expect(activated.status, JSON.stringify(activated.body)).toBe(200)
    expect((activated.body as AutomationActivateResponse).automation).toMatchObject({ name: 'Machines, every 15 minutes', watch: { everyMinutes: 15 } })
    expect((await app.db.query(`SELECT 1 FROM ai_automations WHERE name LIKE 'Machines, every %'`)).rowCount).toBe(1)
    expect(await stateOf(old.proposalId)).toMatchObject({ state: 'superseded' })
  })

  it('leaves the older card as it is when the new version does not pass, or when the older one is no longer open', async () => {
    const first = await proposeInChat(watchDraft({ name: 'Still open' }))
    const open = automationEvents(first.events)[0]
    // A new version that fails its checks replaces nothing.
    const failed = automationEvents((await revise(first.conversationId, watchDraft({ revisesProposalId: open.proposalId }, { keyColumn: 'machine_id_typo' }))).events)[0]
    expect(failed).toMatchObject({ ok: false, draft: { revisesProposalId: open.proposalId } })
    expect(await stateOf(open.proposalId)).toMatchObject({ state: 'proposed' })
    // Discarded, it stays discarded; a version of it is a proposal of its own.
    expect((await discard(open.proposalId)).status).toBe(200)
    const afterDiscard = automationEvents((await revise(first.conversationId, watchDraft({ name: 'After the discard', revisesProposalId: open.proposalId }))).events)[0]
    expect(afterDiscard).toMatchObject({ ok: true, state: 'proposed' })
    expect(await stateOf(open.proposalId)).toMatchObject({ state: 'discarded' })
    // A version of one that did not pass, or of one superseded already, marks nothing.
    const ofFailed = automationEvents((await revise(first.conversationId, watchDraft({ name: 'Fixed', revisesProposalId: failed.proposalId }))).events)[0]
    expect(ofFailed).toMatchObject({ ok: true })
    expect(await stateOf(failed.proposalId)).toMatchObject({ state: 'proposed', decided: false })
    const newer = automationEvents((await revise(first.conversationId, watchDraft({ name: 'Newer', revisesProposalId: ofFailed.proposalId }))).events)[0]
    expect(await stateOf(ofFailed.proposalId)).toMatchObject({ state: 'superseded' })
    const again = automationEvents((await revise(first.conversationId, watchDraft({ name: 'Newer still', revisesProposalId: ofFailed.proposalId }))).events)[0]
    expect(again).toMatchObject({ ok: true })
    expect(await stateOf(newer.proposalId)).toMatchObject({ state: 'proposed' })
    expect(await stateOf(ofFailed.proposalId)).toMatchObject({ state: 'superseded' })
  })

  it('tells the model to change the automation instead when the version it revises was activated', async () => {
    const first = await proposeInChat(watchDraft({ name: 'Activated first' }))
    const old = automationEvents(first.events)[0]
    const automation = ((await activate(old.proposalId)).body as AutomationActivateResponse).automation
    const res = await revise(first.conversationId, watchDraft({ name: 'Activated first, every 15 minutes', revisesProposalId: old.proposalId }, { everyMinutes: 15 }))
    const [card] = automationEvents(res.events)
    const said = `revisesProposalId: that proposal was activated and is now the automation ${automation.id}. To change it, set replacesAutomationId to "${automation.id}" and leave revisesProposalId out.`
    expect(card).toMatchObject({ ok: false, error: said })
    expect(resultsOf()[0]).toMatchObject({ is_error: true, content: expect.stringContaining(`- ${said}`) })
    expect(await stateOf(old.proposalId)).toMatchObject({ state: 'activated' })
    // Its automation deleted since: nothing to change, a new one to propose.
    expect((await app.api('DELETE', `/api/automations/${automation.id}`, { token: p.creator.token })).status).toBe(204)
    const gone = automationEvents((await revise(first.conversationId, watchDraft({ revisesProposalId: old.proposalId }))).events)[0]
    expect(gone).toMatchObject({ ok: false, error: expect.stringContaining('the automation it became has since been deleted. Propose this as a new automation') })
  })

  it('never makes a second automation when the older version is activated while the new one is being stored, nor waits on that answer to activate', async () => {
    const first = await proposeInChat(watchDraft({ name: 'Raced, every 5 minutes' }))
    const old = automationEvents(first.events)[0]
    // The model proposes a new version while the older card is open: the model is told it replaces that card.
    const revision = await callPropose(first.conversationId, watchDraft({ name: 'Raced, every 15 minutes', revisesProposalId: old.proposalId }, { everyMinutes: 15 }))
    expect(revision.told.note).toContain('The card of the version it revises is marked as replaced by this one.')
    // The answer's store begins with another proposal of the same step: it holds a key share on the person's row.
    const other = await callPropose(first.conversationId, watchDraft({ name: 'Raced, alongside' }))
    const tx = await app.db.connect()
    try {
      await tx.query('BEGIN')
      await other.store!(tx)
      // Meanwhile the person presses Activate on the older card: it goes through at once, never waiting on the answer
      // (which would deadlock when the answer then marks that card).
      const pressed = await Promise.race([activate(old.proposalId), new Promise<'still waiting'>((resolve) => setTimeout(() => resolve('still waiting'), 5_000))])
      expect(pressed === 'still waiting' ? pressed : pressed.status).toBe(200)
      // The new version is stored after it: the older card keeps what the person decided.
      await revision.store!(tx)
      await tx.query('COMMIT')
    } catch (e) {
      await tx.query('ROLLBACK')
      throw e
    } finally {
      tx.release()
    }
    expect(await stateOf(old.proposalId)).toMatchObject({ state: 'activated' })
    expect(await stateOf(revision.told.proposalId)).toMatchObject({ state: 'proposed', decided: false })
    // Activating the new version would tell the same cases twice, from a second automation: refused, saying what to do.
    const second = await activate(revision.told.proposalId)
    expect(second.status).toBe(409)
    expect((second.body as ApiErrorBody).error.message).toBe('The earlier version this proposal revises was activated meanwhile. Ask the assistant to change that automation instead.')
    expect(await stateOf(revision.told.proposalId)).toMatchObject({ state: 'proposed' })
    expect((await app.db.query(`SELECT 1 FROM ai_automations WHERE name LIKE 'Raced, every %' AND deleted_at IS NULL`)).rowCount).toBe(1)
    // A proposal of its own in that answer is not held back.
    expect((await activate(other.told.proposalId)).status).toBe(200)
  })

  it('activates a new version that changes the very automation the older one became, as that change', async () => {
    const made = automationEvents((await proposeInChat(watchDraft({ name: 'Changed twice' }))).events)[0]
    const automationId = ((await activate(made.proposalId)).body as AutomationActivateResponse).automation.id
    // A change of it is proposed, then a new version of that change, keeping what it changes; the change is activated in between.
    const change = await proposeInChat(watchDraft({ name: 'Changed twice, every 10 minutes', replacesAutomationId: automationId }, { everyMinutes: 10 }))
    const older = automationEvents(change.events)[0]
    const revision = await callPropose(
      change.conversationId,
      watchDraft({ name: 'Changed twice, every 15 minutes', replacesAutomationId: automationId, revisesProposalId: older.proposalId }, { everyMinutes: 15 }),
    )
    expect((await activate(older.proposalId)).status).toBe(200)
    await withTransaction(app.db, (tx) => revision.store!(tx))
    expect(await stateOf(older.proposalId)).toMatchObject({ state: 'activated' })
    const activated = await activate(revision.told.proposalId)
    expect(activated.status, JSON.stringify(activated.body)).toBe(200)
    expect((activated.body as AutomationActivateResponse).automation).toMatchObject({ id: automationId, name: 'Changed twice, every 15 minutes', watch: { everyMinutes: 15 } })
    expect((await app.db.query(`SELECT 1 FROM ai_automations WHERE name LIKE 'Changed twice%' AND deleted_at IS NULL`)).rowCount).toBe(1)
  })

  it('names a revision that is no proposal id, or no proposal of this conversation and person', async () => {
    const elsewhere = automationEvents((await proposeInChat(watchDraft({ name: 'Elsewhere' }))).events)[0]
    const theirs = automationEvents((await proposeInChat(watchDraft({ name: 'Theirs' }), p.creator2)).events)[0]
    const plan = await describePlan()
    const notOne = 'revisesProposalId: no proposal of this conversation has that id (each propose_automation result names its proposalId).'
    for (const [id, error] of [
      ['card-1', 'revisesProposalId: "card-1" is not a proposal id.'],
      ['00000000-0000-4000-8000-000000000000', notOne],
      [elsewhere.proposalId, notOne],
      [theirs.proposalId, notOne],
    ]) {
      const card = automationEvents((await proposeInChat(watchDraft({ revisesProposalId: id }), p.creator, plan.conversationId)).events)[0]
      expect(card, id).toMatchObject({ ok: false, error })
    }
    expect(await stateOf(elsewhere.proposalId)).toMatchObject({ state: 'proposed' })
    expect(await stateOf(theirs.proposalId)).toMatchObject({ state: 'proposed' })
  })
})
