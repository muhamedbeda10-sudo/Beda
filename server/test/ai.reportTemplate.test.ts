import { describe, expect, it } from 'vitest'
import { AI_MODEL, AI_REPORT_MAX_DAYS } from '@qc/shared/ai'
import { checkTemplate, fillTemplate, ordersRows, rangeDays, rangeProblem, sameResult } from '../src/ai/reportTemplate'
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
    const params = templateRequest({ question: 'Changes in the last 30 days?', askedOn: '2026-10-09', sections })
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
