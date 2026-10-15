import { describe, expect, it } from 'vitest'
import { AI_MODEL, AI_REPORT_MAX_DAYS } from '@qc/shared/ai'
import { checkTemplate, fillTemplate, noDataRange, ordersRows, ownDays, periodProblem, rangeDays, rangeProblem, readsClock, sameResult } from '../src/ai/reportTemplate'
import { readProposal, reportTitle, runPeriod, templateRequest, TEMPLATE_SCHEMA } from '../src/ai/reports'
import type { ModelMessage } from '../src/ai/model'

// §20 — a saved report's period, made changeable: the narrow form a template
// the model wrote must keep, how the API alone fills it, and how two results
// are compared before a template is trusted. No database here.

const answer = (text: string, stopReason: ModelMessage['stop_reason'] = 'end_turn'): ModelMessage =>
  ({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: AI_MODEL,
    content: [{ type: 'thinking', thinking: 'Rewriting.', signature: 'sig' }, { type: 'text', text, citations: null }],
    stop_reason: stopReason,
    stop_sequence: null,
    stop_details: null,
    container: null,
    context_management: null,
    usage: { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  }) as unknown as ModelMessage

describe('§20 report templates: the form a template must keep', () => {
  it('takes {{from}} and {{to}} standing on their own in the code', () => {
    for (const t of [
      'SELECT count(*) AS n FROM ai.audit_log WHERE at >= {{from}} AND at < {{to}} + 1',
      'SELECT day, count(*) FROM ai.audit_log WHERE day BETWEEN {{from}} AND {{to}} GROUP BY day',
      "SELECT sum(produced) FROM ai.production_between({{from}}, {{to}}, 'day')",
      'SELECT * FROM ai.audit_log WHERE at >= {{from}}::timestamptz',
      'SELECT * FROM ai.audit_log WHERE day>={{from}} AND day<={{to}}',
    ]) {
      expect(checkTemplate(t), t).toEqual({ ok: true, placeholders: 2 - (t.includes('{{to}}') ? 0 : 1) })
    }
    expect(checkTemplate('SELECT count(*) FROM ai.machines')).toEqual({ ok: true, placeholders: 0 })
  })

  it('refuses any other placeholder, and the two in any other spelling', () => {
    for (const t of [
      'SELECT 1 WHERE x >= {{x}}',
      'SELECT 1 WHERE x >= {{ from }}',
      'SELECT 1 WHERE x >= {{FROM}}',
      'SELECT 1 WHERE x >= {{from}} AND y = {{',
      'SELECT 1 WHERE x >= {{from}} AND y = }}',
      'SELECT 1 WHERE x >= {{{from}}}',
      "SELECT '{{1,2},{3,4}}'::int[] WHERE x >= {{from}}",
    ]) {
      expect(checkTemplate(t), t).toMatchObject({ ok: false, reason: expect.any(String) })
    }
  })

  it('refuses a placeholder inside a string, a comment or a quoted name, or glued to its neighbours', () => {
    for (const t of [
      "SELECT 1 WHERE x >= '{{from}}'",
      "SELECT 1 WHERE x >= E'{{from}}'",
      'SELECT 1 WHERE x >= $$ {{from}} $$',
      'SELECT 1 -- {{from}}\nWHERE true',
      'SELECT 1 /* {{to}} */',
      'SELECT "{{from}}" FROM ai.machines',
      'SELECT 1 WHERE x >= a{{from}}',
      'SELECT 1 WHERE x >= {{from}}a',
      'SELECT 1 WHERE x >= 1{{from}}',
      'SELECT 1 WHERE x >= {{from}}{{to}}',
      'SELECT 1 WHERE x >= ai.{{from}}',
      'SELECT 1 WHERE x >= "a"{{from}}',
    ]) {
      expect(checkTemplate(t), t).toMatchObject({ ok: false })
    }
  })

  it('fills the placeholders with date literals, and only from real days', () => {
    expect(fillTemplate('SELECT 1 WHERE at >= {{from}} AND at < {{to}} + 1 AND d BETWEEN {{from}} AND {{to}}', { from: '2026-09-01', to: '2026-09-30' })).toBe(
      "SELECT 1 WHERE at >= DATE '2026-09-01' AND at < DATE '2026-09-30' + 1 AND d BETWEEN DATE '2026-09-01' AND DATE '2026-09-30'",
    )
    // Whatever a caller hands in, nothing but YYYY-MM-DD of a real day reaches the SQL.
    for (const range of [
      { from: "2026-09-01'; DROP TABLE users; --", to: '2026-09-30' },
      { from: '2026-09-01', to: "2026-09-30' OR '1'='1" },
      { from: '2026-02-30', to: '2026-03-01' },
      { from: '2026-9-1', to: '2026-09-30' },
      { from: '2026-10-01', to: '2026-09-30' },
    ]) {
      expect(() => fillTemplate('SELECT {{from}}, {{to}}', range), JSON.stringify(range)).toThrow(/Not a day range/)
    }
  })

  it('checks the days a person asks for', () => {
    expect(rangeProblem({ from: '2026-09-01', to: '2026-09-30' })).toBeNull()
    expect(rangeDays({ from: '2026-09-01', to: '2026-09-30' })).toBe(30)
    expect(rangeDays({ from: '2024-02-28', to: '2024-03-01' })).toBe(3)
    expect(rangeProblem({ from: '2026-09-30', to: '2026-09-01' })).toMatch(/after the last/)
    expect(rangeProblem({ from: '2026-02-29', to: '2026-03-01' })).toMatch(/real date/)
    expect(rangeProblem({ from: "2026-01-01'", to: '2026-03-01' })).toMatch(/real date/)
    // 3660 days at most, both ends counted.
    expect(rangeProblem({ from: '2016-01-01', to: '2026-01-07' })).toBeNull()
    expect(rangeDays({ from: '2016-01-01', to: '2026-01-07' })).toBe(AI_REPORT_MAX_DAYS)
    expect(rangeProblem({ from: '2016-01-01', to: '2026-01-08' })).toMatch(/at most 3660 days/)
  })
})

describe('§20 report templates: days from the period, and from nothing else', () => {
  const where = (cond: string) => `SELECT day, count(*) AS n FROM ai.audit_log WHERE entity = 'Coil' AND ${cond} GROUP BY day ORDER BY day`

  it('takes a template that holds the data between bounds made of both placeholders', () => {
    for (const t of [
      where('at >= {{from}} AND at < {{to}} + 1'),
      where('day BETWEEN {{from}} AND {{to}}'),
      where('day BETWEEN SYMMETRIC {{from}} AND {{to}}'),
      where('{{from}} <= day AND day <= {{to}}'),
      where('at >= {{from}}::timestamptz AND at < ({{to}} + 1)::timestamptz'),
      where("date_trunc('day', at) >= {{from}} AND date_trunc('day', at) < {{to}} + interval '1 day'"),
      where("at >= date_trunc('month', {{from}}) AND (at AT TIME ZONE 'Africa/Cairo')::date <= {{to}}"),
      where('day = {{from}} OR day = {{to}}'),
      "SELECT sum(produced) AS produced FROM ai.production_between({{from}}, {{to}}, 'day')",
      "SELECT machine, sum(produced) FROM ai.production_between({{from}}, {{to}}, p_all_machines => true) GROUP BY machine",
      "SELECT d::date AS day, count(a.audit_id) AS n FROM generate_series({{from}}, {{to}}, interval '1 day') d LEFT JOIN ai.audit_log a ON a.day = d::date GROUP BY 1 ORDER BY 1",
      // Placeholders may also be counted with, once the data is bounded: changes per day of the period.
      'SELECT count(*)::numeric / ({{to}} - {{from}} + 1) AS per_day FROM ai.audit_log WHERE day >= {{from}} AND day <= {{to}}',
      // The period before, as long as the period: still both days, still bounded on both sides.
      'SELECT count(*) AS n FROM ai.audit_log WHERE day >= {{from}} - ({{to}} - {{from}} + 1) AND day < {{from}}',
      "SELECT count(*) FILTER (WHERE day >= {{from}} AND day <= {{to}}) AS n FROM ai.audit_log WHERE entity = 'Coil'",
    ]) {
      expect(periodProblem(t), t).toBeNull()
    }
  })

  it('refuses a bound left out, or a day of its own left in', () => {
    const cases: [string, RegExp][] = [
      // "Since a week ago": a lower bound alone shows rows past the last day chosen.
      [where('at >= {{from}}'), /both \{\{from\}\} and \{\{to\}\}/],
      [where('at >= {{from}} AND at < {{from}}'), /both/],
      // The original's days kept, and the placeholders compared with each other.
      [where("at >= '2026-09-10' AND at < '2026-10-10' AND {{from}} <= {{to}}"), /names a day/],
      [where('at >= {{from}} AND {{from}} <= {{to}}'), /compared with constants only/],
      [where('{{to}} - {{from}} < 31 AND at >= {{from}} AND at < {{to}} + 1'), /compared with constants only/],
      // One bound forgotten as a date, or left to the clock.
      [where("at >= {{from}} AND at < '2026-10-10'"), /names a day/],
      [where("at >= {{from}} AND at < {{to}} + 1 AND closed_month = '2026-09'"), /names a day/],
      [where('at >= current_date - 6 AND at < {{to}} + 1'), /reads the clock/],
      [where('at >= {{from}} AND at < CURRENT_DATE + 1 AND {{to}} IS NOT NULL'), /reads the clock/],
      [where('at >= {{from}} AND at < now()::date + 1 AND day <= {{to}}'), /reads the clock/],
      [where("day BETWEEN {{from}} AND {{to}} AND at < 'today'::date + 1"), /reads the clock/],
      [where('day BETWEEN {{from}} AND {{to}} AND at > make_date(2026, 9, 1)'), /makes a day/],
      // Bounded on one side only, the other placeholder doing nothing.
      [where('at >= {{from}} AND {{to}} IS NOT NULL'), /does not hold the data/],
      [where('at >= {{from}} AND at >= {{to}}'), /does not hold the data/],
      [where('day NOT BETWEEN {{from}} AND {{to}}'), /does not hold the data/],
      [where('day IN ({{from}}, {{to}})'), /does not hold the data/],
      [where('day <> {{from}} AND day <> {{to}}'), /does not hold the data/],
      ['SELECT count(*) FROM ai.production_between({{from}}, {{from}} + 30) WHERE {{to}} IS NOT NULL', /does not hold the data/],
    ]
    for (const [t, why] of cases) expect(periodProblem(t), t).toMatch(why)
  })

  it('tells a query with days of its own from one with none', () => {
    expect(ownDays('SELECT count(*)::int AS machines FROM ai.machines')).toBeNull()
    expect(ownDays("SELECT count(*) FROM ai.sessions WHERE order_number = '20095-QC1-HYH' AND item_code = 'LB406015-5TA3'")).toBeNull()
    expect(ownDays("SELECT count(*) FROM ai.audit_log WHERE at >= '2026-09-10' AND at < '2026-10-10'")).toMatch(/names a day/)
    expect(ownDays("SELECT count(*) FROM ai.audit_log WHERE at >= DATE '2026-09-10 08:00'")).toMatch(/names a day/)
    expect(ownDays("SELECT count(*) FROM ai.audit_log WHERE to_char(at, 'DD/MM/YYYY') = '10/09/2026'")).toMatch(/names a day/)
    expect(ownDays('SELECT count(*) FROM ai.audit_log WHERE at >= current_date - 29')).toMatch(/reads the clock/)
    expect(ownDays("SELECT count(*) FROM ai.audit_log WHERE at >= now() - interval '30 days'")).toMatch(/reads the clock/)
    expect(ownDays("SELECT count(*) FROM ai.audit_log WHERE day = 'yesterday'")).toMatch(/reads the clock/)
    expect(ownDays('SELECT count(*) FROM ai.audit_log WHERE day >= make_date(2026, 9, 1)')).toMatch(/makes a day/)
    // The clock's name inside a string is not the clock; a day in a comment still counts (it only keeps the period fixed).
    expect(readsClock("SELECT 'now() or current_date' AS note FROM ai.machines")).toBe(false)
    expect(readsClock('SELECT localtimestamp')).toBe(true)
    expect(ownDays('SELECT 1 -- since 2026-09-01')).toMatch(/names a day/)
  })

  it('finds days that hold no data, as many as the period has', () => {
    expect(noDataRange({ from: '2026-09-10', to: '2026-10-09' })).toEqual({ from: '1900-01-01', to: '1900-01-30' })
    expect(noDataRange({ from: '2026-10-09', to: '2026-10-09' })).toEqual({ from: '1900-01-01', to: '1900-01-01' })
    expect(rangeDays(noDataRange({ from: '2016-01-01', to: '2026-01-07' }))).toBe(AI_REPORT_MAX_DAYS)
  })
})

describe('§20 report templates: comparing a template with its query', () => {
  it('compares in order only when the query itself orders its rows', () => {
    expect(ordersRows('SELECT day, count(*) FROM ai.audit_log GROUP BY day ORDER BY day')).toBe(true)
    expect(ordersRows('SELECT a FROM t UNION ALL SELECT b FROM u order\n  by 1')).toBe(true)
    expect(ordersRows('WITH x AS (SELECT a FROM t ORDER BY a) SELECT a FROM x')).toBe(false)
    expect(ordersRows('SELECT a, row_number() OVER (ORDER BY a) FROM t')).toBe(false)
    expect(ordersRows("SELECT string_agg(a, ',' ORDER BY a) FROM t")).toBe(false)
    expect(ordersRows("SELECT 'ORDER BY' AS words -- order by\nFROM t")).toBe(false)
    expect(ordersRows('SELECT (SELECT 1 ORDER BY 1) AS x FROM t ORDER BY x')).toBe(true)
  })

  it('wants the same columns and the very same rows; numbers exactly', () => {
    const a = { columns: ['day', 'n'], rows: [['2026-09-01', 2], ['2026-09-02', 3]] }
    expect(sameResult(a, { columns: ['day', 'n'], rows: [['2026-09-01', 2], ['2026-09-02', 3]] }, true)).toBe(true)
    expect(sameResult(a, { columns: ['day', 'n'], rows: [['2026-09-02', 3], ['2026-09-01', 2]] }, false)).toBe(true)
    expect(sameResult(a, { columns: ['day', 'n'], rows: [['2026-09-02', 3], ['2026-09-01', 2]] }, true)).toBe(false)
    expect(sameResult(a, { columns: ['day', 'count'], rows: a.rows }, false)).toBe(false)
    expect(sameResult(a, { columns: ['n', 'day'], rows: a.rows }, false)).toBe(false)
    expect(sameResult(a, { columns: ['day', 'n'], rows: [['2026-09-01', 2], ['2026-09-02', 3.0000001]] }, false)).toBe(false)
    expect(sameResult(a, { columns: ['day', 'n'], rows: [['2026-09-01', 2], ['2026-09-02', '3']] }, false)).toBe(false)
    expect(sameResult(a, { columns: ['day', 'n'], rows: [['2026-09-01', 2]] }, false)).toBe(false)
    // A multiset: the same row twice is not the same as two different rows.
    const twice = { columns: ['x'], rows: [[1], [1], [2]] }
    expect(sameResult(twice, { columns: ['x'], rows: [[1], [2], [2]] }, false)).toBe(false)
    expect(sameResult(twice, { columns: ['x'], rows: [[2], [1], [1]] }, false)).toBe(true)
    expect(sameResult({ columns: ['x'], rows: [[null]] }, { columns: ['x'], rows: [['null']] }, false)).toBe(false)
  })
})

describe('§20 report templates: what the model is asked, and what is taken from its answer', () => {
  const sections = [
    { title: 'Changes per day', sql: "SELECT day, count(*) AS n FROM ai.audit_log WHERE at >= '2026-09-10' GROUP BY day" },
    { title: 'Machines', sql: 'SELECT count(*) AS n FROM ai.machines' },
  ]

  it('asks once, with no tools, at low effort, for JSON in a fixed shape', () => {
    const params = templateRequest({ question: 'Changes in the last 30 days?', askedOn: '2026-10-09', sections }, { model: AI_MODEL, effort: 'low' })
    expect(params).toMatchObject({
      model: AI_MODEL,
      max_tokens: 8000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low', format: { type: 'json_schema', schema: TEMPLATE_SCHEMA } },
    })
    expect(params).not.toHaveProperty('tools')
    expect(params).not.toHaveProperty('tool_choice')
    expect(JSON.parse(params.messages[0].content as string)).toEqual({
      question: 'Changes in the last 30 days?',
      today: '2026-10-09',
      sections: [
        { index: 0, purpose: 'Changes per day', sql: sections[0].sql },
        { index: 1, purpose: 'Machines', sql: sections[1].sql },
      ],
    })
    // Structured outputs take no length or number limits, and every object closes its properties.
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return
      const o = node as Record<string, unknown>
      for (const banned of ['minimum', 'maximum', 'minLength', 'maxLength', 'pattern']) expect(o).not.toHaveProperty(banned)
      if (o.type === 'object') expect(o.additionalProperties).toBe(false)
      Object.values(o).forEach(walk)
    }
    walk(TEMPLATE_SCHEMA)
  })

  it('reads a well-formed answer into the shared period type', () => {
    const json = {
      title: '  Changes   per day ',
      period: { kind: 'last_days', days: 30, from: null, to: null, weekStart: null },
      sections: [
        { index: 1, template: sections[1].sql },
        { index: 0, template: 'SELECT day, count(*) AS n FROM ai.audit_log WHERE at >= {{from}} GROUP BY day' },
      ],
    }
    expect(readProposal(answer(JSON.stringify(json)), 2)).toEqual({
      title: 'Changes per day',
      period: { kind: 'last_days', days: 30 },
      templates: [json.sections[1].template, sections[1].sql],
    })
    const week = readProposal(answer(JSON.stringify({ ...json, period: { kind: 'this_week', days: null, from: null, to: null, weekStart: null } })), 2)
    expect(week).toMatchObject({ period: { kind: 'this_week', weekStart: 'saturday' } })
    const fixed = readProposal(answer(JSON.stringify({ ...json, period: { kind: 'fixed', days: null, from: '2026-09-01', to: '2026-09-30', weekStart: null } })), 2)
    expect(fixed).toMatchObject({ period: { kind: 'fixed', from: '2026-09-01', to: '2026-09-30' } })
    expect(readProposal(answer(JSON.stringify({ ...json, title: 'x'.repeat(300), period: null })), 2)).toMatchObject({ title: 'x'.repeat(80), period: null })
  })

  it('refuses an answer it cannot use', () => {
    const good = { title: 'T', period: { kind: 'last_days', days: 30, from: null, to: null, weekStart: null }, sections: [{ index: 0, template: 'SELECT 1' }, { index: 1, template: 'SELECT 2' }] }
    const cases: [ModelMessage, RegExp][] = [
      [answer('not json'), /not JSON/],
      [answer(JSON.stringify(good), 'max_tokens'), /max_tokens/],
      [answer(JSON.stringify(good), 'refusal'), /refusal/],
      [answer(JSON.stringify({ ...good, sections: [good.sections[0]] })), /1 sections for 2/],
      [answer(JSON.stringify({ ...good, sections: [good.sections[0], good.sections[0]] })), /index 0/],
      [answer(JSON.stringify({ ...good, sections: [good.sections[0], { index: 5, template: 'x' }] })), /index 5/],
      [answer(JSON.stringify({ ...good, period: { ...good.period, days: 0 } })), /not one a report can have/],
      [answer(JSON.stringify({ ...good, period: { ...good.period, days: 4000 } })), /not one a report can have/],
      [answer(JSON.stringify({ ...good, period: { kind: 'fixed', days: null, from: '2026-09-31', to: '2026-10-01', weekStart: null } })), /not one/],
      [answer(JSON.stringify({ ...good, period: { kind: 'fixed', days: null, from: '2026-10-01', to: '2026-09-01', weekStart: null } })), /not one/],
      [answer(JSON.stringify({ ...good, period: { kind: 'decade' } })), /shape/],
    ]
    for (const [message, problem] of cases) expect(readProposal(message, 2)).toEqual({ problem: expect.stringMatching(problem) })
  })

  it('names a report by the title given, else by its question', () => {
    expect(reportTitle('  My   report ', 'Question?')).toBe('My report')
    expect(reportTitle(null, 'How many machines are there?')).toBe('How many machines are there?')
    expect(reportTitle('', 'Question?')).toBe('Question?')
    expect(Array.from(reportTitle('ع'.repeat(200), 'q'))).toHaveLength(120)
  })

  it('runs over the saved period counted from today, or the days asked for', () => {
    const report = {
      id: 'r',
      title: 'T',
      question: 'Q',
      period: { kind: 'last_days', days: 30 } as const,
      adjustable: true,
      sectionCount: 1,
      createdAt: '',
      updatedAt: '',
      sections: [],
    }
    expect(runPeriod(report, null, '2026-10-09')).toEqual({ from: '2026-09-10', to: '2026-10-09', label: 'Last 30 days', overridden: false })
    expect(runPeriod(report, { from: '2026-09-01', to: '2026-09-30' }, '2026-10-09')).toEqual({ from: '2026-09-01', to: '2026-09-30', label: '1 Sep – 30 Sep 2026', overridden: true })
    expect(runPeriod({ ...report, adjustable: false, period: null }, null, '2026-10-09')).toBeNull()
  })
})
