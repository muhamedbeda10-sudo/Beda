import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import type { AiMessagesResponse, AiReport, AiReportPart, AiReportRunResponse, AiReportsResponse, AiStreamEvent } from '@qc/shared/ai'
import type { AiReportInput } from '@qc/shared/aiReportInputs'
import { fillInputs, inputLiteral, placeholderProblems, readInputDefinitions } from '../src/ai/reportInputs'
import { ensureStarters, STANDARD_TIMES_TABLE } from '../src/ai/starters'
import { TestApp } from './harness'
import { text } from './aiFake'
import { ask, grant, setUp, type People } from './automationsKit'
import { resultJson, systemOf, toolNames, toolUse } from './noticesKit'

// Reports the assistant builds (save_report) and reads (read_report): the
// inputs a run asks for, filled into the SQL as typed literals, never as
// typed; every section test-run before anything is kept, and every problem
// told at once; a shared report open to everyone given the assistant, each
// over the data they may read, changed or deleted only by its maker; and
// the two reports the app starts with, over the order sheet. The model is
// the scripted stand-in.

const app = new TestApp()
let p: People

const saveReport = (input: unknown, id?: string) => toolUse('save_report', input, id)
const readReport = (input: unknown, id?: string) => toolUse('read_report', input, id)
const reportEvents = (events: AiStreamEvent[]): AiReportPart[] => events.filter((e): e is Extract<AiStreamEvent, { type: 'report' }> => e.type === 'report').map((e) => e.part)

/** The result the model was sent back for its last tool call. */
function lastResult(): Anthropic.Beta.BetaToolResultBlockParam {
  const messages = app.model.calls[app.model.calls.length - 1].params.messages
  const content = messages[messages.length - 1].content as Anthropic.Beta.BetaToolResultBlockParam[]
  return content[content.length - 1]
}

const CODES: AiReportInput = { name: 'codes', label: 'Machines', kind: 'list', required: false, help: '58, 31' }

/** Machines, all of them or those asked for: a report of three sections over ai.machines. */
const MACHINES_REPORT = {
  title: 'Machines on the register',
  description: 'How many machines, each one, and each under its code.',
  shared: false,
  inputs: [{ name: 'codes', label: 'Machines', kind: 'list', help: '58, 31' }],
  sections: [
    { title: 'At a glance', display: 'figures', sql: `SELECT count(*) AS "Machines" FROM ai.machines WHERE ({{codes}} IS NULL OR machine_code = ANY({{codes}}))` },
    {
      title: 'Each machine',
      sql: `SELECT machine_code AS code, machine_code::int AS n FROM ai.machines WHERE ({{codes}} IS NULL OR machine_code = ANY({{codes}})) ORDER BY 1`,
      chart: { type: 'bar', x: 'code', y: ['n'] },
      note: 'Each machine with its number.',
    },
    {
      title: 'Under their codes',
      display: 'tree',
      tree: { key: 'k', parent: 'up' },
      sql: `SELECT 'all' AS k, NULL::text AS up, 'All' AS "Name"
            UNION ALL SELECT machine_code, 'all', machine FROM ai.machines WHERE ({{codes}} IS NULL OR machine_code = ANY({{codes}}))
            ORDER BY up NULLS FIRST, k`,
    },
  ],
  // Two machines, so the test run has rows its chart can draw.
  sample: { codes: ['58', '31'] },
}

/** The model calls one tool (in a new conversation of the person's unless given), then answers. */
async function viaChat(block: Anthropic.Beta.BetaContentBlock, as = p.plain, conversationId?: string) {
  app.model.reply({ content: [block] }, { content: [text('Done.')] })
  const res = await ask(app, as, 'Build me a report of the machines', conversationId)
  expect(res.status, JSON.stringify(res.error)).toBe(200)
  return { cards: reportEvents(res.events), result: lastResult(), conversationId: res.conversationId }
}

async function run(as: People[keyof People], id: string, inputs?: unknown) {
  const q = inputs === undefined ? '' : `?inputs=${encodeURIComponent(JSON.stringify(inputs))}`
  return app.api<AiReportRunResponse>('GET', `/api/ai/reports/${id}/run${q}`, { token: as.token })
}

beforeAll(async () => {
  await app.start()
  p = await setUp(app)
})
afterAll(() => app.stop())
beforeEach(() => {
  app.model.reset()
  for (const s of Object.values(p)) {
    app.aiLimiter.reset(s.user.id)
    app.aiReportLimiter.reset(s.user.id)
  }
})

describe('inputs in the SQL', () => {
  const inputs: AiReportInput[] = [CODES, { name: 'week', label: 'Week', kind: 'number', required: true }, { name: 'day', label: 'Day', kind: 'date', required: false }, { name: 'who', label: 'Who', kind: 'text', required: false }]

  it('fills each placeholder with a typed literal, a typed quote escaped and never read as SQL', () => {
    const sql = 'SELECT 1 WHERE a = ANY({{codes}}) AND w = {{week}} AND d = {{day}} AND n = {{who}}'
    expect(fillInputs(sql, inputs, { codes: ['58', "x'); DROP TABLE users; --"], week: 26, day: '2026-06-22', who: "O'Neil" })).toBe(
      "SELECT 1 WHERE a = ANY((ARRAY['58', 'x''); DROP TABLE users; --']::text[])) AND w = (26::numeric) AND d = (DATE '2026-06-22') AND n = ('O''Neil'::text)",
    )
    // Nothing given: a typed NULL, so `{{x}} IS NULL` holds.
    expect(fillInputs(sql, inputs, { codes: null, week: 1, day: null, who: null })).toContain('ANY((NULL::text[]))')
    expect(fillInputs(sql, inputs, { codes: [], week: 1, day: null, who: null })).toContain('d = (NULL::date)')
    // A value of the wrong kind never reaches the SQL.
    expect(() => inputLiteral('number', 'DROP' as never)).toThrow()
    expect(() => inputLiteral('date', "2026-01-01'; --")).toThrow()
  })

  it('finds every misplaced or unknown placeholder', () => {
    const problems = (sql: string, period = false) => placeholderProblems(sql, inputs, period).problems.join(' ')
    expect(problems('SELECT {{codes}}, {{week}}')).toBe('')
    expect(problems('SELECT {{nope}}')).toContain('{{nope}} names no input of the report (codes, week, day, who)')
    expect(problems("SELECT '{{who}}'")).toContain('inside a quoted string')
    expect(problems('SELECT x{{who}}')).toContain('joined to the text beside it')
    expect(problems('SELECT {{from}}')).toContain('this report has no period')
    expect(problems('SELECT {{from}}', true)).toBe('')
    expect(problems('SELECT {{ who }}')).toContain('with no spaces inside the braces')
  })

  it('reads the inputs the model declares, and every problem with them', () => {
    expect(readInputDefinitions([{ name: 'week', label: 'Week', kind: 'number', required: true, dynamic_default: 'this_week' }])).toEqual({
      inputs: [{ name: 'week', label: 'Week', kind: 'number', required: true, dynamicDefault: 'this_week' }],
    })
    const read = readInputDefinitions([
      { name: 'from', label: 'From', kind: 'date' },
      { name: 'Bad Name', label: 'X', kind: 'text' },
      { name: 'pick', label: 'Pick', kind: 'choice', choices: ['one'] },
      { name: 'd', label: 'Day', kind: 'date', dynamic_default: 'this_week' },
    ])
    expect('problems' in read && read.problems.join(' ')).toMatch(/"from" is the period's.*lowercase letters.*2 to 30 values.*this_week is a number/)
  })
})

describe('save_report', () => {
  let reportId = ''

  it('is in every new conversation, loaded on demand, with its part of the prompt', async () => {
    app.model.reply({ content: [text('Hi.')] })
    await ask(app, p.plain, 'Hello')
    expect(toolNames(app)).toEqual(expect.arrayContaining(['save_report', 'read_report']))
    const system = systemOf(app)
    expect(system).toContain('# Reports you build')
    expect(system).toContain('build it with save_report')
    // An order number stands for its phases, compared exactly.
    expect(system).toContain("left(lower(o.order_number), length(btrim(p.v)) + 1) = lower(btrim(p.v)) || '-'")
    expect(system).not.toMatch(/ILIKE p/)
  })

  it('test-runs every section with the sample, keeps the report and shows its card, live and in the history', async () => {
    const { cards, result, conversationId } = await viaChat(saveReport(MACHINES_REPORT))
    const told = resultJson<{ saved: boolean; action: string; reportId: string; testRun: { inputs: Record<string, unknown>; sections: { section: string; rows: unknown[][] }[] } }>(result)
    expect(told.saved).toBe(true)
    expect(told.action).toBe('create')
    expect(told.testRun.inputs).toEqual({ codes: ['58', '31'] })
    expect(told.testRun.sections.map((s) => s.rows)).toEqual([[[2]], [['31', 31], ['58', 58]], [['all', null, 'All'], ['31', 'all', '31. Machine'], ['58', 'all', '58. Machine']]])
    reportId = told.reportId

    expect(cards).toEqual([
      { type: 'report', changeId: expect.any(String), reportId, action: 'create', title: 'Machines on the register', description: MACHINES_REPORT.description, shared: false, inputs: ['Machines'], sectionCount: 3, state: 'current' },
    ])
    const saved = await app.api<AiMessagesResponse>('GET', `/api/ai/conversations/${conversationId}/messages`, { token: p.plain.token })
    expect(saved.body.messages.at(-1)!.parts.find((x) => x.type === 'report')).toEqual(cards[0])

    const report = await app.api<AiReport>('GET', `/api/ai/reports/${reportId}`, { token: p.plain.token })
    expect(report.body).toMatchObject({ title: 'Machines on the register', madeBy: 'assistant', mine: true, shared: false, inputCount: 1, inputs: [CODES] })
    expect(report.body.sections.map((s) => s.display ?? 'table')).toEqual(['figures', 'table', 'tree'])
    expect(report.body.sections[1].chart).toMatchObject({ type: 'bar', x: 'code' })
    const changes = await app.db.query(`SELECT action, user_id AS "userId" FROM ai_report_changes WHERE report_id = $1`, [reportId])
    expect(changes.rows).toEqual([{ action: 'create', userId: p.plain.user.id }])
  })

  it('runs over the values typed, each one checked, and over all when none is given', async () => {
    const all = await run(p.plain, reportId)
    expect(all.status).toBe(200)
    expect(all.body.inputs).toEqual({ codes: null })
    expect(all.body.sections[0].rows).toEqual([[2]])
    expect(all.body.sections[0]).toMatchObject({ display: 'figures' })
    expect(all.body.sections[2]).toMatchObject({ display: 'tree', tree: { key: 'k', parent: 'up' } })
    expect(all.body.sections[1].note).toBe('Each machine with its number.')

    const one = await run(p.plain, reportId, { codes: '31' })
    expect(one.body.inputs).toEqual({ codes: ['31'] })
    expect(one.body.sections[1].rows).toEqual([['31', 31]])

    // A quote typed in is a value like any other: no rows, no error.
    const odd = await run(p.plain, reportId, { codes: ["58') OR true; --"] })
    expect(odd.status).toBe(200)
    expect(odd.body.sections.every((s) => s.ok)).toBe(true)
    expect(odd.body.sections[0].rows).toEqual([[0]])

    const bad = await run(p.plain, reportId, { codes: Array.from({ length: 101 }, (_, i) => String(i)) })
    expect(bad.status).toBe(400)
    expect(JSON.stringify(bad.body)).toContain('Machines: at most 100 values')
    expect((await app.api('GET', `/api/ai/reports/${reportId}/run?inputs=nope`, { token: p.plain.token })).status).toBe(400)
  })

  it('tells the model every problem at once and keeps nothing', async () => {
    const before = (await app.db.query(`SELECT count(*)::int AS n FROM ai_reports`)).rows[0].n
    // How the report is written is checked first: nothing runs while it is wrong.
    const shape = await viaChat(saveReport({ ...MACHINES_REPORT, shared: 'yes', sections: [{ title: 'Unknown', sql: 'SELECT {{machine}}' }, { title: 'Quoted', sql: "SELECT '{{codes}}'" }] }))
    expect(shape.cards).toEqual([])
    expect(String(shape.result.content)).toMatch(/Nothing was kept[\s\S]*shared: true or false[\s\S]*\{\{machine\}\} names no input of the report \(codes\)[\s\S]*inside a quoted string/)

    // Then every section runs, and what its rows cannot show is told.
    const { cards, result } = await viaChat(
      saveReport({
        ...MACHINES_REPORT,
        sections: [
          { title: 'Two rows', display: 'figures', sql: 'SELECT machine_code FROM ai.machines' },
          { title: 'Wrong tree', display: 'tree', tree: { key: 'nokey', parent: 'up' }, sql: "SELECT 'a' AS k, NULL AS up" },
          { title: 'Broken', sql: 'SELECT nothing FROM nowhere' },
        ],
      }),
    )
    expect(cards).toEqual([])
    expect(result.is_error).toBe(true)
    const said = String(result.content)
    expect(said).toContain('Nothing was kept')
    expect(said).toContain('figures show one row, and the test run returned 2')
    expect(said).toContain('the tree\'s column "nokey" is not one of the result\'s')
    expect(said).toContain('"Broken"')
    expect((await app.db.query(`SELECT count(*)::int AS n FROM ai_reports`)).rows[0].n).toBe(before)
  })

  it('asks for a required input before a run, starting from its default', async () => {
    const { result } = await viaChat(
      saveReport({
        title: 'One machine',
        description: 'One machine, by its code.',
        shared: false,
        inputs: [{ name: 'code', label: 'Machine', kind: 'text', required: true }],
        sections: [{ title: 'It', sql: 'SELECT machine FROM ai.machines WHERE machine_code = {{code}}' }],
        sample: { code: '58' },
      }),
    )
    const id = resultJson<{ reportId: string }>(result).reportId
    const missing = await run(p.plain, id)
    expect(missing.status).toBe(400)
    expect(JSON.stringify(missing.body)).toContain('Machine: required.')
    expect((await run(p.plain, id, { code: '58' })).body.sections[0].rows).toEqual([['58. Machine']])
  })

  it('shares a report with everyone given the assistant, each over what they may read; only its maker changes it', async () => {
    // Not shared: nobody else sees it.
    expect((await app.api('GET', `/api/ai/reports/${reportId}`, { token: p.creator.token })).status).toBe(404)
    expect((await app.api<AiReportsResponse>('GET', '/api/ai/reports', { token: p.creator.token })).body.reports.map((r) => r.id)).not.toContain(reportId)

    // The maker changes it in the same conversation's way: the whole report again, with its id, now shared.
    const { cards, result } = await viaChat(saveReport({ ...MACHINES_REPORT, report_id: reportId, shared: true }))
    expect(resultJson<{ action: string }>(result).action).toBe('update')
    expect(cards[0]).toMatchObject({ action: 'update', shared: true, reportId })

    const listed = (await app.api<AiReportsResponse>('GET', '/api/ai/reports', { token: p.creator.token })).body.reports.find((r) => r.id === reportId)
    expect(listed).toMatchObject({ shared: true, mine: false, ownerName: 'Paula Plain', madeBy: 'assistant' })
    expect((await run(p.creator, reportId, { codes: ['58'] })).body.sections[0].rows).toEqual([[1]])

    // Theirs to run, not to change.
    expect((await app.api('PATCH', `/api/ai/reports/${reportId}`, { token: p.creator.token, body: { title: 'Mine now' } })).status).toBe(404)
    expect((await app.api('DELETE', `/api/ai/reports/${reportId}`, { token: p.creator.token })).status).toBe(404)
    const taken = await viaChat(saveReport({ ...MACHINES_REPORT, report_id: reportId, title: 'Taken' }), p.creator)
    expect(taken.result.is_error).toBe(true)
    expect(String(taken.result.content)).toContain('only they may change it')
    expect((await app.api<AiReport>('GET', `/api/ai/reports/${reportId}`, { token: p.plain.token })).body.title).toBe('Machines on the register')

    // Read by the other as their access stands: taken away, no run.
    await grant(app, p.owner, p.creator, { enabled: false })
    expect((await run(p.creator, reportId)).status).toBe(403)
    await grant(app, p.owner, p.creator, { automations: true })
  })

  it('read_report lists the reports the person may open, and gives one in full', async () => {
    const list = await viaChat(readReport({}), p.creator)
    const listed = resultJson<{ reports: { id: string; mine: boolean; madeBy: string }[] }>(list.result)
    expect(listed.reports).toContainEqual(expect.objectContaining({ id: reportId, mine: false, madeBy: 'Paula Plain' }))
    const one = await viaChat(readReport({ report_id: reportId }), p.creator)
    const full = resultJson<{ sections: { sql: string }[]; inputs: AiReportInput[] }>(one.result)
    expect(full.inputs).toEqual([CODES])
    expect(full.sections[0].sql).toContain('{{codes}}')
    const none = await viaChat(readReport({ report_id: '00000000-0000-4000-8000-000000000000' }), p.creator)
    expect(none.result.is_error).toBe(true)
  })
})

describe('the reports the app starts with', () => {
  it('makes Order tracking, Week tracking and the standard times once, shared, as the owner', async () => {
    await grant(app, p.owner, p.plain, { domains: ['inspection', 'orders', 'production'] })
    const lines: [string, string, string, string, number, number, number, string, string | null, string][] = [
      // line key, order, item, machine, required, finished, weight, due, parent id, week
      ['L1', '20332-Ph2.2-EHF', 'Frame', '58', 10, 10, 0, '2026-06-20', '0118-20332-Ph2.2-EHF-0000', '26/2026'],
      ['L2', '20332-Ph2.2-EHF', 'Beam', '58', 10, 10, 50, '2026-06-20', '0118-20332-Ph2.2-EHF-0100', '26/2026'],
      ['L3', '20332-Ph2.2-EHF', 'Beam', '31', 10, 4, 50, '2026-06-20', '0118-20332-Ph2.2-EHF-0100', '26/2026'],
      ['L4', '20332-Ph3-EHF', 'Plate', '31', 5, 0, 20, '2026-06-25', null, '26/2026'],
      ['L5', '203321-X', 'Other', '58', 7, 7, 1, '2026-06-25', null, '27/2026'],
    ]
    for (const [key, order, item, machine, req, fin, kg, due, parent, week] of lines) {
      await app.db.query(
        `INSERT INTO production_orders (line_key, order_number, item, item_code, work_center_code, required_qty, finished_qty, weight_kg, due_date, parent_id, planning_week, customer, erp_status)
         VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8, $9, $10, 'ACME', 'Released')`,
        [key, order, item, machine, req, fin, kg, due, parent, week],
      )
    }

    const deps = { db: app.db, config: app.config, readers: app.aiReader }
    const made = await ensureStarters(deps)
    expect(made.reports.sort()).toEqual(['order-tracking', 'week-tracking'])
    expect(made.table).toBe('made')
    expect((await ensureStarters(deps)).reports).toEqual([])
    const table = await app.db.query(`SELECT refresh FROM ai_saved_tables WHERE name = $1`, [STANDARD_TIMES_TABLE])
    expect(table.rows).toEqual([{ refresh: 'daily' }])

    const reports = (await app.api<AiReportsResponse>('GET', '/api/ai/reports', { token: p.plain.token })).body.reports
    const order = reports.find((r) => r.title === 'Order tracking')!
    const week = reports.find((r) => r.title === 'Week tracking')!
    expect(order).toMatchObject({ shared: true, mine: false, madeBy: 'starter', inputCount: 1 })

    // 20332 is both its phases, never 203321; one phase alone by its name.
    const both = await run(p.plain, order.id, { orders: '20332' })
    expect(both.status, JSON.stringify(both.body)).toBe(200)
    expect(both.body.sections.filter((s) => !s.ok)).toEqual([])
    const glance = both.body.sections[0]
    const figure = (name: string) => glance.rows[0][glance.columns.indexOf(name)]
    expect(glance.columns).toContain('Customer')
    expect(both.body.sections[1].rows.map((r) => r[0])).toEqual(['20332-Ph2.2-EHF', '20332-Ph3-EHF'])
    const phase = await run(p.plain, order.id, { orders: ['20332-ph2.2-ehf'] })
    expect(phase.body.sections[1].rows.map((r) => r[0])).toEqual(['20332-Ph2.2-EHF'])
    expect(figure('Customer')).toBe('ACME')

    // The tree: the main item, its part under it, and each machine under that.
    const tree = phase.body.sections.find((s) => s.display === 'tree')!
    const at = (c: string) => tree.columns.indexOf(c)
    expect(tree.rows.map((r) => [r[at('Level')], r[at('Machine')]])).toEqual([
      ['Main item', ''],
      ['Machine', '58. Machine'],
      ['Part', '31. Machine, 58. Machine'],
      ['Machine', '31. Machine'],
      ['Machine', '58. Machine'],
    ])
    expect(tree.columns).not.toContain('lvl')

    // The week: its lines, an order left out.
    const all = await run(p.plain, week.id, { week: 26, year: 2026 })
    expect(all.body.sections.filter((s) => !s.ok)).toEqual([])
    const lineCount = (r: AiReportRunResponse) => r.sections[0].rows[0][r.sections[0].columns.indexOf('Lines')]
    expect(lineCount(all.body)).toBe(4)
    const less = await run(p.plain, week.id, { week: 26, year: 2026, exclude: ['20332-Ph3-EHF'] })
    expect(lineCount(less.body)).toBe(3)
    const missing = less.body.sections.at(-1)!
    expect(missing.rows.map((r) => r[missing.columns.indexOf('Machine')])).toEqual(['31. Machine'])
  })
})
