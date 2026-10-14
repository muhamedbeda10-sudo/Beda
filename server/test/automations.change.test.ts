import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import type { AiStreamEvent } from '@qc/shared/ai'
import type { ApiErrorBody } from '@qc/shared/api'
import type { AiAutomationPart, AutomationActivateResponse } from '@qc/shared/automation'
import { TestApp } from './harness'
import { text } from './aiFake'
import { ask, plain, reportDraft, setUp, watchDraft, type People } from './automationsKit'
import { describeChanges, runsWhen } from '../src/automations/changes'
import { applyEdits, readChange, type AutomationEdit } from '../src/automations/edit'
import { AUTOMATION_TOOLS } from '../src/automations/tools'

// §21 — change_automation: the model names only what changes; the app applies it to the definition as it is now
// (an automation's, or a card's of the conversation) and proposes the result as propose_automation would, with a
// card that lists what changes. The model is the scripted stand-in.

const app = new TestApp()
let p: People

type AutomationEvent = Extract<AiStreamEvent, { type: 'automation' }>
const automationEvents = (events: AiStreamEvent[]) => events.filter((e): e is AutomationEvent => e.type === 'automation').map((e) => e.part)
const lastCall = () => app.model.calls[app.model.calls.length - 1]
const resultOf = () => {
  const last = lastCall().params.messages[lastCall().params.messages.length - 1]
  return (last.content as Anthropic.Beta.BetaToolResultBlockParam[])[0]
}
const toolUseId = () => `toolu_${Math.random().toString(36).slice(2, 10)}`
const use = (name: string, input: unknown) => ({ type: 'tool_use', id: toolUseId(), name, input }) as Anthropic.Beta.BetaContentBlock

const SQL = 'SELECT count(*)::int AS machines FROM ai.machines'

/** The person asks for something and agrees in the same message; the model makes one call with their words quoted. */
async function callInChat(name: string, input: object, conversationId: string | null, said = 'Yes, change it.', quoted = 'Yes, change it') {
  let conversation = conversationId
  if (!conversation) {
    app.model.reply({ content: [text('The plan: the machine register, every morning at 08:00, to the supervisors. Shall I set it up?')] })
    const first = await ask(app, p.creator, 'Send the supervisors the machine register every morning.')
    conversation = first.conversationId
  }
  app.model.reply({ content: [text('Changing it.'), use(name, { confirmation: quoted, ...input })] }, { content: [text('Done: press Activate on the card.')] })
  const res = await ask(app, p.creator, said, conversation)
  expect(res.status, JSON.stringify(res.error)).toBe(200)
  return { ...res, conversationId: conversation }
}

async function activate(proposalId: string) {
  return app.api<AutomationActivateResponse | ApiErrorBody>('POST', `/api/ai/automation-proposals/${proposalId}/activate`, { token: p.creator.token, body: {} })
}

/** A report proposed and activated from the chat: its automation, and the conversation. */
async function activeReport(draft = reportDraft()) {
  const res = await callInChat('propose_automation', draft, null, 'Yes, go ahead.', 'Yes, go ahead')
  const [card] = automationEvents(res.events)
  expect(card.ok, card.error).toBe(true)
  const done = await activate(card.proposalId)
  expect(done.status, JSON.stringify(done.body)).toBe(200)
  return { automation: (done.body as AutomationActivateResponse).automation, conversationId: res.conversationId, proposalId: card.proposalId }
}

const stateOf = async (proposalId: string) =>
  (await app.db.query<{ state: string }>(`SELECT state FROM ai_automation_proposals WHERE id = $1`, [proposalId])).rows[0]?.state

beforeAll(async () => {
  await app.start()
  p = await setUp(app)
})
afterAll(() => app.stop())
beforeEach(() => {
  app.model.reset()
  for (const s of Object.values(p)) app.aiLimiter.reset(s.user.id)
})

describe('§21 edits of a definition', () => {
  const base = reportDraft({}, { sections: [{ title: 'Machines', sql: SQL }, { title: 'Shifts', sql: "SELECT 'night' AS shift WHERE 'x' = 'x'" }] })
  const edit = (...edits: AutomationEdit[]) => applyEdits(base, edits)

  it('replaces text once, or everywhere when asked; sets values, adds and removes list items, in order', () => {
    const done = edit(
      { op: 'replace', path: 'schedule.sections.1.sql', find: "'night'", with: "'night', 'ورديه مسائيه'" },
      { op: 'replace', path: 'schedule.sections.1.sql', find: "'x'", with: "'y'", all: true },
      { op: 'set', path: 'schedule.time', value: '09:00' },
      { op: 'set', path: 'schedule.sections.2', value: { title: 'Again', sql: SQL } },
      { op: 'remove', path: 'schedule.sections.0' },
      { op: 'set', path: 'recipients.1', value: { kind: 'role', role: 'admin' } },
    )
    expect('result' in done && done.result).toMatchObject({
      schedule: {
        time: '09:00',
        sections: [
          { title: 'Shifts', sql: "SELECT 'night', 'ورديه مسائيه' AS shift WHERE 'y' = 'y'" },
          { title: 'Again', sql: SQL },
        ],
      },
      recipients: [{ kind: 'role', role: 'supervisor' }, { kind: 'role', role: 'admin' }],
    })
    // The definition it started from is left as it was.
    expect(base.schedule!.sections).toHaveLength(2)
  })

  it('says exactly why an edit cannot be made, and makes none of them then', () => {
    const failed = edit(
      { op: 'replace', path: 'schedule.sections.1.sql', find: "'x'", with: "'y'" },
      { op: 'replace', path: 'schedule.sections.0.sql', find: 'NOT THERE', with: '' },
      { op: 'replace', path: 'schedule.sections.0.sql', find: '', with: 'x' },
      { op: 'replace', path: 'schedule.summary', find: 'a', with: 'b' },
      { op: 'set', path: 'schedule.sections.5', value: { title: 'Far', sql: SQL } },
      { op: 'set', path: 'schedule.sections.x', value: 1 },
      { op: 'set', path: 'kind', value: 'watch' },
      { op: 'set', path: 'replacesAutomationId', value: 'x' },
      { op: 'set', path: 'schedule.__proto__', value: { polluted: true } },
      { op: 'set', path: 'watch.sql', value: SQL },
      { op: 'remove', path: 'schedule.period' },
    )
    expect('errors' in failed && failed.errors).toEqual([
      'edits[0] (replace schedule.sections.1.sql): find appears 2 times in the field. Give more of the text around the place to change, or set all to replace every one.',
      "edits[1] (replace schedule.sections.0.sql): find was not found in the field. Copy it exactly from the definition as it is now (my_automations, or the card's), spaces and line breaks included.",
      'edits[2] (replace schedule.sections.0.sql): find is empty. Copy the text to replace from the field.',
      'edits[3] (replace schedule.summary): that field holds no text to replace in. Use set to give it a value.',
      'edits[4] (set schedule.sections.5): that list has 2 items: set position 2 to add one at its end.',
      'edits[5] (set schedule.sections.x): x is not a position in that list (0 is the first).',
      'edits[6] (set kind): the path cannot be changed: a change may touch name, description, language, watch, schedule, recipients, channels, actions.',
      'edits[7] (set replacesAutomationId): the path cannot be changed: a change may touch name, description, language, watch, schedule, recipients, channels, actions.',
      'edits[8] (set schedule.__proto__): the path is not a path (fields joined by dots, for example schedule.sections.1.sql).',
      'edits[9] (set watch.sql): the path leads nowhere: watch is not there.',
      'edits[10] (remove schedule.period): there is nothing there to remove.',
    ])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('reads a call: one definition, at least one edit, each of a known kind', () => {
    const id = '6f1c1b2e-3d4a-4b5c-8d6e-7f8091a2b3c4'
    expect(readChange({ confirmation: 'yes', automationId: ` ${id} `, edits: [{ op: 'remove', path: 'name' }] })).toEqual({ automationId: id, proposalId: null, edits: [{ op: 'remove', path: 'name' }] })
    expect(readChange({ automationId: id, proposalId: id, edits: [{ op: 'remove', path: 'name' }] })).toEqual({ errors: ['Give automationId or proposalId: one of them, not both.'] })
    expect(readChange({ edits: [{ op: 'remove', path: 'name' }] })).toEqual({ errors: ['Give automationId or proposalId: one of them, not both.'] })
    expect('errors' in readChange({ automationId: id, edits: [] })).toBe(true)
    expect('errors' in readChange({ automationId: id, edits: [{ op: 'rename', path: 'name' }] })).toBe(true)
  })
})

describe('§21 what a change changes, as its card lists it', () => {
  it('names each part that changes in words, pairing sections by title', () => {
    const before = reportDraft({}, { cadence: 'weekly', weekday: 4, sections: [{ title: 'Output', sql: SQL }, { title: 'Quality', sql: SQL }, { title: 'Old', sql: SQL }] })
    const after = reportDraft(
      { name: 'Machine register (all)', recipients: [{ kind: 'role', role: 'admin' }] },
      {
        cadence: 'weekly',
        weekday: 4,
        time: '09:30',
        summary: true,
        sections: [
          { title: 'Quality', sql: `${SQL} WHERE true` },
          { title: 'Output', sql: SQL, chart: { type: 'bar', x: 'machines', y: ['machines'] } },
          { title: 'New', sql: SQL },
        ],
      },
    )
    expect(describeChanges(before, after).map(plain)).toEqual([
      'Name: “Machine register” → “Machine register (all)”',
      'Runs: weekly on Thursday at 08:00 → weekly on Thursday at 09:30',
      'A summary on top: added',
      'Section 1 “Quality”: its query',
      'Section 2 “Output”: a chart added',
      // A section in the same place under another title is the same one renamed.
      'Section 3: “Old” → “New”',
      'The order of the sections',
      'Who is told',
    ])
    const one = reportDraft()
    const two = reportDraft({}, { sections: [...one.schedule!.sections, { title: 'Extra', sql: SQL }] })
    expect(describeChanges(one, two).map(plain)).toEqual(['Section 2 “Extra”: added'])
    expect(describeChanges(two, one).map(plain)).toEqual(['Section “Extra”: removed'])
    expect(describeChanges(before, before)).toEqual([])
    expect(describeChanges(watchDraft(), watchDraft({}, { everyMinutes: 15, titleTemplate: 'New {{machine}}', hours: { from: '22:00', to: '06:00' } }))).toEqual([
      'Runs every 5 → 15 minutes',
      'Hours: around the clock → 22:00–06:00',
      'Its message',
    ])
    expect(runsWhen({ cadence: 'daily', time: '07:00', weekdays: [0, 1] })).toBe('daily (Sun, Mon) at 07:00')
    expect(runsWhen({ cadence: 'monthly', time: '07:00', monthDay: 3 })).toBe('monthly on day 3 at 07:00')
  })
})

describe('§21 change_automation in the chat', () => {
  it('is among the automation tools of a new conversation', () => {
    expect(AUTOMATION_TOOLS.map((t) => t.name)).toEqual(['propose_automation', 'change_automation', 'my_automations'])
  })

  it('changes part of an active automation: the card lists what changes, and Activate changes that automation', async () => {
    const { automation, conversationId } = await activeReport()
    const res = await callInChat(
      'change_automation',
      {
        automationId: automation.id,
        edits: [
          { op: 'replace', path: 'schedule.sections.0.sql', find: 'FROM ai.machines', with: 'FROM ai.machines WHERE true' },
          { op: 'set', path: 'schedule.time', value: '09:00' },
        ],
      },
      conversationId,
    )
    // Said while it is made and checked, before its card.
    expect(res.events.some((e) => e.type === 'progress' && e.text === 'Making the change, checking it and running it once…')).toBe(true)
    const [card] = automationEvents(res.events)
    expect(card).toMatchObject({ ok: true, state: 'proposed', replacesName: 'Machine register' })
    // Its names set apart, so an Arabic one reads right in the line; the model reads them plain.
    expect(card.changes).toEqual(['Runs: daily at 08:00 → daily at 09:00', 'Section 1 “\u2068Machines\u2069”: its query'])
    expect(card.draft).toMatchObject({ replacesAutomationId: automation.id, schedule: { time: '09:00', sections: [{ title: 'Machines', sql: `${SQL} WHERE true` }] } })
    const told = JSON.parse(resultOf().content as string) as { proposed: boolean; changesOnActivate: string[] }
    expect(told).toMatchObject({ proposed: true, changesOnActivate: card.changes!.map(plain) })
    // Opened again, the card still says what it changes; once activated, the automation is changed and the list goes.
    const shown = async () =>
      (await app.api<{ messages: { parts: AiAutomationPart[] }[] }>('GET', `/api/ai/conversations/${conversationId}/messages`, { token: p.creator.token })).body.messages
        .flatMap((m) => m.parts)
        .find((x) => x.type === 'automation' && x.proposalId === card.proposalId)
    expect((await shown())?.changes).toEqual(card.changes)
    const done = await activate(card.proposalId)
    expect(done.status, JSON.stringify(done.body)).toBe(200)
    expect((done.body as AutomationActivateResponse).automation).toMatchObject({ id: automation.id, schedule: { time: '09:00', sections: [{ sql: `${SQL} WHERE true` }] } })
    expect((await shown())?.changes).toBeUndefined()
  })

  it('applies a change to a card still waiting and replaces that card; to an activated card, it changes its automation', async () => {
    const waiting = await callInChat('propose_automation', reportDraft({ name: 'Waiting report' }), null, 'Yes, go ahead.', 'Yes, go ahead')
    const [first] = automationEvents(waiting.events)
    const res = await callInChat('change_automation', { proposalId: first.proposalId, edits: [{ op: 'set', path: 'schedule.time', value: '07:30' }] }, waiting.conversationId)
    const [second] = automationEvents(res.events)
    expect(second).toMatchObject({ ok: true, draft: { name: 'Waiting report', revisesProposalId: first.proposalId, schedule: { time: '07:30' } } })
    expect(second.changes).toBeUndefined()
    expect(await stateOf(first.proposalId)).toBe('superseded')

    const active = await activeReport(reportDraft({ name: 'Became active' }))
    const onCard = await callInChat('change_automation', { proposalId: active.proposalId, edits: [{ op: 'set', path: 'schedule.time', value: '10:00' }] }, active.conversationId)
    const [change] = automationEvents(onCard.events)
    expect(change).toMatchObject({ ok: true, draft: { replacesAutomationId: active.automation.id }, changes: ['Runs: daily at 08:00 → daily at 10:00'] })
    expect(change.draft).not.toHaveProperty('revisesProposalId')
  })

  it('shows no card for an edit it cannot make, and says what to fix', async () => {
    const { automation, conversationId } = await activeReport(reportDraft({ name: 'Untouched' }))
    const before = (await app.db.query(`SELECT 1 FROM ai_automation_proposals`)).rowCount
    const res = await callInChat('change_automation', { automationId: automation.id, edits: [{ op: 'replace', path: 'schedule.sections.0.sql', find: 'ai.nothing', with: 'x' }] }, conversationId)
    expect(automationEvents(res.events)).toEqual([])
    expect(resultOf()).toMatchObject({ is_error: true, content: expect.stringContaining('Nothing changed, and no card was shown. Fix these edits and call change_automation again:\n- edits[0]') })
    expect((await app.db.query(`SELECT 1 FROM ai_automation_proposals`)).rowCount).toBe(before)
    // Nor for someone else's automation, a card of another conversation, or a definition the edits break.
    const other = await callInChat('change_automation', { automationId: '6f1c1b2e-3d4a-4b5c-8d6e-7f8091a2b3c4', edits: [{ op: 'remove', path: 'name' }] }, conversationId)
    expect(automationEvents(other.events)).toEqual([])
    expect(resultOf()).toMatchObject({ is_error: true, content: "Nothing changed: automationId: none of this person's automations has that id (my_automations lists them)." })
    const broken = await callInChat('change_automation', { automationId: automation.id, edits: [{ op: 'set', path: 'schedule.time', value: 9 }] }, conversationId)
    expect(automationEvents(broken.events)).toEqual([])
    expect(resultOf().content).toContain('with these edits the definition is not one an automation can have')
  })

  it('keeps a change that does not pass as a card of its own, fixed on that card with only the fix; the card it was to replace is replaced then', async () => {
    const waiting = await callInChat('propose_automation', reportDraft({ name: 'To be fixed' }), null, 'Yes, go ahead.', 'Yes, go ahead')
    const [first] = automationEvents(waiting.events)
    const bad = await callInChat(
      'change_automation',
      { proposalId: first.proposalId, edits: [{ op: 'replace', path: 'schedule.sections.0.sql', find: 'ai.machines', with: 'ai.no_such_view' }] },
      waiting.conversationId,
    )
    const [failed] = automationEvents(bad.events)
    expect(failed).toMatchObject({ ok: false, error: expect.stringContaining('schedule.sections[0]') })
    expect(resultOf().content).toContain('Fix them with change_automation on this card (proposalId below), naming only the fixes:')
    expect(resultOf().content).toContain(`proposalId: ${failed.proposalId}`)
    expect(await stateOf(first.proposalId)).toBe('proposed')
    const fixed = await callInChat(
      'change_automation',
      { proposalId: failed.proposalId, edits: [{ op: 'replace', path: 'schedule.sections.0.sql', find: 'ai.no_such_view', with: 'ai.machines' }] },
      waiting.conversationId,
    )
    const [good] = automationEvents(fixed.events)
    expect(good).toMatchObject({ ok: true, draft: { revisesProposalId: first.proposalId } })
    expect(await stateOf(first.proposalId)).toBe('superseded')
  })

  it('is refused without the person agreeing in their latest message, before anything is changed', async () => {
    const { automation, conversationId } = await activeReport(reportDraft({ name: 'Needs agreement' }))
    const res = await callInChat('change_automation', { automationId: automation.id, edits: [{ op: 'set', path: 'name', value: 'X' }] }, conversationId, 'What time does it run?', 'Yes, change it')
    expect(automationEvents(res.events)).toEqual([])
    expect(resultOf()).toMatchObject({ is_error: true })
  })
})

