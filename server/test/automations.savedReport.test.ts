import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import type { AiStreamEvent } from '@qc/shared/ai'
import { isoWeekOf, type AiReportInputValues } from '@qc/shared/aiReportInputs'
import type { AiAutomationPart, Automation, AutomationActivateResponse, AutomationDelivery, AutomationScheduleSpec } from '@qc/shared/automation'
import { insertReport, changeReport } from '../src/ai/reports'
import { BEYOND_AUTHOR, MISSING_REPORT, NOTHING_IN_COMMON } from '../src/automations/savedReport'
import { TestApp, factoryDay } from './harness'
import { text } from './aiFake'
import { Clock, ask, engineFor, grant, insertAutomation, runsOf, setUp, type People } from './automationsKit'

// §21 — a scheduled report that sends a saved report (My reports): one its
// creator may open, their own or shared; the values its inputs take fixed in
// the schedule, an input left out taking its default on the day of the run;
// the report run as it stands at each run, its figures, trees and notes kept
// in the delivery with the values it ran for. Gone, or no longer shared, the
// run fails and says so. The model is the scripted stand-in.

const app = new TestApp()
let p: People
let shared = ''
let privateId = ''
let weekly = ''

const AGREED = 'Yes, go ahead.'
const AGREEMENT = 'Yes, go ahead'
const toolUseId = () => `toolu_${Math.random().toString(36).slice(2, 10)}`
const automationEvents = (events: AiStreamEvent[]) =>
  events.filter((e): e is Extract<AiStreamEvent, { type: 'automation' }> => e.type === 'automation').map((e) => e.part)

/** Machines, all or those asked for, under three sections: figures, a table, a tree. */
const MACHINES_REPORT = {
  title: 'Machines on the register',
  question: 'Machines on the register',
  period: null,
  adjustable: false,
  inputs: [{ name: 'codes', label: 'Machines', kind: 'list' as const, required: false }],
  sections: [
    { title: 'At a glance', display: 'figures' as const, sql: `SELECT count(*)::int AS "Machines" FROM ai.machines WHERE ({{codes}} IS NULL OR machine_code = ANY({{codes}}))` },
    { title: 'Each machine', sql: `SELECT machine_code AS code FROM ai.machines WHERE ({{codes}} IS NULL OR machine_code = ANY({{codes}})) ORDER BY 1`, note: 'Each by its code.' },
    {
      title: 'Under their codes',
      display: 'tree' as const,
      tree: { key: 'k', parent: 'up' },
      sql: `SELECT 'all' AS k, NULL::text AS up, 'All' AS "Name" UNION ALL SELECT machine_code, 'all', machine FROM ai.machines WHERE ({{codes}} IS NULL OR machine_code = ANY({{codes}})) ORDER BY 2 NULLS FIRST, 1`,
    },
  ],
}

const linkedSchedule = (reportId: string, inputs: Record<string, unknown> = {}): AutomationScheduleSpec => ({
  cadence: 'daily',
  time: '08:00',
  sections: [],
  summary: false,
  // As the model may send them (a list typed as text, say): read against the report's inputs.
  report: { reportId, inputs: inputs as AiReportInputValues },
})

/** The creator agrees to a plan and the assistant proposes a schedule that sends a saved report. */
async function proposeLinked(schedule: unknown) {
  app.model.reply({ content: [text('The plan: send the report every morning at 08:00 to Cyril, in the bell. Shall I?')] })
  const plan = await ask(app, p.creator, 'Send me the machines report every morning')
  const draft = {
    confirmation: AGREEMENT,
    kind: 'report',
    name: 'Machines every morning',
    description: 'The machines report, every morning at 08:00.',
    language: 'en',
    schedule,
    recipients: [{ kind: 'user', userId: p.creator2.user.id }],
    channels: { bell: true, chat: false },
    actions: { notify: true, followUp: null },
  }
  app.model.reply({ content: [{ type: 'tool_use', id: toolUseId(), name: 'propose_automation', input: draft } as Anthropic.Beta.BetaContentBlock] }, { content: [text('Proposed.')] })
  const res = await ask(app, p.creator, AGREED, plan.conversationId)
  expect(res.status, JSON.stringify(res.error)).toBe(200)
  return automationEvents(res.events)[0]
}

async function deliver(schedule: AutomationScheduleSpec) {
  const clock = new Clock()
  const id = await insertAutomation(app.db, { creatorId: p.creator.user.id, schedule, recipients: [{ kind: 'user', userId: p.creator2.user.id }], nextRunAt: clock.now() })
  await engineFor(app, clock).tick()
  const runs = await runsOf(app.db, id)
  return { id, run: runs[runs.length - 1] }
}

const delivery = (id: string, as = p.creator2) => app.api<AutomationDelivery>('GET', `/api/automations/deliveries/${id}`, { token: as.token })

beforeAll(async () => {
  await app.start()
  p = await setUp(app)
  // Paula's reports: one shared with everyone given the assistant, one her own alone.
  shared = (await insertReport(app.db, { ...MACHINES_REPORT, userId: p.plain.user.id, conversationId: null, turnId: null, shared: true, madeBy: 'assistant' })).id
  privateId = (await insertReport(app.db, { ...MACHINES_REPORT, title: 'Paula only', userId: p.plain.user.id, conversationId: null, turnId: null, madeBy: 'assistant' })).id
  weekly = (
    await insertReport(app.db, {
      title: 'This week',
      question: 'This week',
      period: null,
      adjustable: false,
      inputs: [
        { name: 'week', label: 'Week', kind: 'number', required: true, dynamicDefault: 'this_week' },
        { name: 'code', label: 'Machine', kind: 'text', required: true },
      ],
      sections: [{ title: 'Week', sql: 'SELECT {{week}}::int AS week, (SELECT machine FROM ai.machines WHERE machine_code = {{code}}) AS machine' }],
      userId: p.creator.user.id,
      conversationId: null,
      turnId: null,
      madeBy: 'assistant',
    })
  ).id
})
afterAll(() => app.stop())
beforeEach(async () => {
  app.model.reset()
  for (const s of Object.values(p)) app.aiLimiter.reset(s.user.id)
  await app.db.query(`UPDATE ai_automations SET deleted_at = now(), next_run_at = NULL WHERE deleted_at IS NULL`)
})

describe('§21 a schedule that sends a saved report', () => {
  let part: AiAutomationPart

  it('is proposed with the values its inputs take, read as the report reads them, and tried once', async () => {
    part = await proposeLinked(linkedSchedule(shared, { codes: '58' }))
    expect(part.ok, part.error).toBe(true)
    // A list typed as text is a list; stored as the report takes it.
    expect(part.draft!.schedule!.report).toEqual({ reportId: shared, inputs: { codes: ['58'] } })
    expect(part.draft!.schedule!.sections).toEqual([])
    expect(part.linkedReport).toEqual({ id: shared, title: 'Machines on the register', missing: false, inputs: MACHINES_REPORT.inputs, values: { codes: ['58'] }, sectionCount: 3 })
    // Tried as it will go out: the report's sections, with how each shows its rows.
    expect(part.backtest!.sections!.map((s) => [s.title, s.display ?? 'table', s.rows])).toEqual([
      ['At a glance', 'figures', [[1]]],
      ['Each machine', 'table', [['58']]],
      ['Under their codes', 'tree', [['all', null, 'All'], ['58', 'all', '58. Machine']]],
    ])
    expect(part.backtest!.sections![1].note).toBe('Each by its code.')
    expect(part.backtest!.sections![2].tree).toEqual({ key: 'k', parent: 'up' })
  })

  it('is activated as it was proposed, and its page names the report and the values', async () => {
    const res = await app.api<AutomationActivateResponse>('POST', `/api/ai/automation-proposals/${part.proposalId}/activate`, { token: p.creator.token, body: {} })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const a = res.body.automation
    expect(a.schedule!.report).toEqual({ reportId: shared, inputs: { codes: ['58'] } })
    expect(a.linkedReport).toMatchObject({ title: 'Machines on the register', missing: false, values: { codes: ['58'] } })

    // Its values change on its page, checked against the report's inputs.
    const changed = await app.api<Automation>('PATCH', `/api/automations/${a.id}`, { token: p.creator.token, body: { reportInputs: { codes: '31 58' } } })
    expect(changed.status, JSON.stringify(changed.body)).toBe(200)
    expect(changed.body.schedule!.report!.inputs).toEqual({ codes: ['31', '58'] })
    expect(changed.body.linkedReport!.values).toEqual({ codes: ['31', '58'] })
    const wrong = await app.api('PATCH', `/api/automations/${a.id}`, { token: p.creator.token, body: { reportInputs: { nope: 'x' } } })
    expect(wrong.status).toBe(400)
    expect(JSON.stringify(wrong.body)).toContain('has no such input')
  })

  it('refuses a report its creator may not open, sections beside it, inputs the report has not, and a required input without a value', async () => {
    const theirs = await proposeLinked(linkedSchedule(privateId))
    expect(theirs.ok).toBe(false)
    expect(theirs.error).toContain('no report with that id that this person may open')

    const mixed = await proposeLinked({ ...linkedSchedule(shared, { codes: ['58'], machine: '58' }), sections: [{ title: 'Extra', sql: 'SELECT 1' }], period: { kind: 'yesterday' } })
    expect(mixed.ok).toBe(false)
    expect(mixed.error).toContain('has no sections of its own')
    expect(mixed.error).toContain('schedule.report.inputs.machine: the report "Machines on the register" has no such input')
    expect(mixed.error).toContain('fixed in its queries; leave the period out')

    const required = await proposeLinked(linkedSchedule(weekly))
    expect(required.ok).toBe(false)
    expect(required.error).toContain('Machine: required. Give it a value: it has no default.')
  })

  it('delivers the report as it stands, with its figures and tree, the values it ran for, and the way to open it', async () => {
    const { run } = await deliver(linkedSchedule(shared, { codes: ['31'] }))
    expect(run).toMatchObject({ ok: true, error: null })
    const shown = await delivery(run.deliveryId!)
    expect(shown.status).toBe(200)
    expect(shown.body.report).toEqual({ id: shared, title: 'Machines on the register', open: true })
    expect(shown.body.inputs).toEqual([{ label: 'Machines', value: '31' }])
    expect(shown.body.sections.map((s) => [s.display ?? 'table', s.rows])).toEqual([
      ['figures', [[1]]],
      ['table', [['31']]],
      ['tree', [['all', null, 'All'], ['31', 'all', '31. Machine']]],
    ])

    // A change to the report reaches the next delivery.
    await changeReport(app.db, shared, p.plain.user.id, {
      title: 'Machines, renamed',
      description: null,
      period: null,
      adjustable: false,
      sections: [MACHINES_REPORT.sections[0]],
      inputs: MACHINES_REPORT.inputs,
      shared: true,
    })
    const next = await deliver(linkedSchedule(shared, { codes: ['31'] }))
    const again = await delivery(next.run.deliveryId!)
    expect(again.body.report!.title).toBe('Machines, renamed')
    expect(again.body.sections).toHaveLength(1)
  })

  it('takes an input left out as its default on the day of the run', async () => {
    const { run } = await deliver(linkedSchedule(weekly, { code: '58' }))
    expect(run).toMatchObject({ ok: true })
    const shown = await delivery(run.deliveryId!, p.creator)
    const week = isoWeekOf(factoryDay()).week
    expect(shown.body.inputs).toEqual([
      { label: 'Week', value: String(week) },
      { label: 'Machine', value: '58' },
    ])
    expect(shown.body.sections[0].rows).toEqual([[week, '58. Machine']])
    // Its recipient may not open the creator's own report: the delivery says so.
    expect((await delivery(run.deliveryId!)).body.report).toMatchObject({ id: weekly, open: false })
  })

  it("runs someone else's report within the domains its author's queries were kept as, whatever its creator may read", async () => {
    // The creator reads the audit trail too; Paula, who wrote the shared report, the inspections only.
    await grant(app, p.owner, p.creator, { automations: true, domains: ['inspection', 'audit'] })
    try {
      // Her report as it stands, with a section on the accounts (audit): kept as if it had got past her own check.
      const reportId = (
        await insertReport(app.db, {
          title: 'Machines and people',
          question: 'Machines and people',
          period: null,
          adjustable: false,
          sections: [
            { title: 'Machines', sql: 'SELECT count(*)::int AS machines FROM ai.machines' },
            { title: 'People', sql: 'SELECT name FROM ai.users ORDER BY 1' },
          ],
          userId: p.plain.user.id,
          conversationId: null,
          turnId: null,
          shared: true,
          madeBy: 'assistant',
        })
      ).id
      const kept = await app.db.query<{ domains: string[] }>(`SELECT author_domains AS domains FROM ai_reports WHERE id = $1`, [reportId])
      expect(kept.rows[0].domains).toEqual(['inspection'])

      const { run } = await deliver(linkedSchedule(reportId))
      expect(run).toMatchObject({ ok: false, error: `“People”: ${BEYOND_AUTHOR}` })
      const shown = await delivery(run.deliveryId!, p.creator)
      expect(shown.body.sections.map((x) => [x.title, x.ok, x.rows, x.error ?? null])).toEqual([
        ['Machines', true, [[2]], null],
        ['People', false, [], BEYOND_AUTHOR],
      ])
      // Proposed in the chat, its trial run is bounded the same way.
      const proposed = await proposeLinked(linkedSchedule(reportId))
      expect(proposed.ok).toBe(false)
      expect(proposed.error).toContain(`its section "People": ${BEYOND_AUTHOR}`)

      // Her domains and the creator's in nothing in common: not run at all.
      await app.db.query(`UPDATE ai_reports SET author_domains = '{orders}' WHERE id = $1`, [reportId])
      const none = (await deliver(linkedSchedule(reportId))).run
      expect(none).toMatchObject({ ok: false, error: `No section ran. “Machines”: ${NOTHING_IN_COMMON}` })

      // The app's own report, and the creator's own, run as the creator's domains.
      await app.db.query(`UPDATE ai_reports SET author_domains = NULL WHERE id = $1`, [reportId])
      expect((await deliver(linkedSchedule(reportId))).run).toMatchObject({ ok: true })
      await app.db.query(`UPDATE ai_reports SET author_domains = '{inspection}', user_id = $2 WHERE id = $1`, [reportId, p.creator.user.id])
      expect((await deliver(linkedSchedule(reportId))).run).toMatchObject({ ok: true })
    } finally {
      await grant(app, p.owner, p.creator, { automations: true })
    }
  })

  it('fails, and says why, once the report is gone or no longer shared with its creator', async () => {
    await app.db.query(`UPDATE ai_reports SET shared = false WHERE id = $1`, [shared])
    const { run } = await deliver(linkedSchedule(shared, { codes: ['31'] }))
    expect(run).toMatchObject({ ok: false, error: MISSING_REPORT, deliveryId: null })
    await app.db.query(`UPDATE ai_reports SET shared = true WHERE id = $1`, [shared])
  })
})
