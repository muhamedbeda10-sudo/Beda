import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type Anthropic from '@anthropic-ai/sdk'
import type { AiMessagesResponse, AiQueryPart, AiStreamEvent } from '@qc/shared/ai'
import { TestApp, type Session } from './harness'
import { runSql, text, thinking } from './aiFake'
import { stripBlocks } from '../src/ai/blocks'
import { CHART_INPUT_SCHEMA, checkChart } from '../src/ai/charts'
import { KPIS_BLOCK, MAX_KPIS, parseKpis } from '../src/ai/kpis'
import { RUN_SQL_TOOL, TOOL_SEARCH_TOOL, deferred } from '../src/ai/prompt'
import { AUTOMATION_TOOLS } from '../src/automations/tools'
import { NOTICE_MANAGE_TOOLS, NOTICE_READ_TOOLS } from '../src/noticeAssistant/tools'
import { TASK_TOOLS } from '../src/tasks/assistant'
import { PLAYBOOK_TOOLS } from '../src/playbook/assistant'
import type { QueryPreview } from '../src/ai/runQuery'
import { SUGGESTIONS_BLOCK } from '../src/ai/suggestions'

// §20 phase 4 — a professional answer. A conversation begun now asks the
// model to open an answer with its headline figures (<kpis>) and gives
// run_sql an optional chart; the transcript keeps every byte as written and
// as sent, and only the display takes the figures out of the text, while a
// chart is checked against the query's result and kept with the query. A
// conversation begun earlier goes on with the prompt and the tool it was
// given, unchanged.

type Block = Anthropic.Beta.BetaContentBlock

/** A run_sql call that asks for a chart. */
const charted = (id: string, purpose: string, sql: string, chart: unknown): Block =>
  ({ type: 'tool_use', id, name: 'run_sql', input: { purpose, sql, chart } }) as Block

const both = (text: string, atEnd: boolean) => stripBlocks(text, atEnd, [KPIS_BLOCK, SUGGESTIONS_BLOCK])

describe('§20 headline figures: reading the block', () => {
  const FIGURES = '<kpis>\n- Defect pieces | 39\n- Reject rate | 1.29% | down-good\n- Holds open | 4 | up-bad\n</kpis>\n\nThere were **39** defect pieces.'

  it('takes each line as a label, a figure and how it moved, and leaves the answer', () => {
    expect(parseKpis([FIGURES])).toEqual([
      { label: 'Defect pieces', value: '39' },
      { label: 'Reject rate', value: '1.29%', trend: 'down-good' },
      { label: 'Holds open', value: '4', trend: 'up-bad' },
    ])
    expect(both(FIGURES, true)).toBe('There were **39** defect pieces.')
    expect(parseKpis(['No block at all.'])).toEqual([])
    expect(parseKpis(['<kpis>\n\n</kpis>'])).toEqual([])
  })

  it('checks every line: at most six, one per label, a figure never cut, a trend only when it is one of the five', () => {
    const lines = [
      '- **Samples** | `1,204`',
      '* عدد العيوب | ٣٩ | Up good',
      '1. Reject rate | 1.29% | down_bad',
      '2) Holds | 4 | sideways',
      'Without a marker | 7 | flat',
      '- Samples | 9',
      `- ${'L'.repeat(70)} | 1`,
      `- Too long a figure | ${'9'.repeat(33)}`,
      '- No figure |',
      '- Only words, no pipe',
      '- A | B | C | D',
      '|---|---|',
      '- Sixth | 6',
      '- Seventh | 7',
    ]
    const kpis = parseKpis([`<kpis>\n${lines.join('\n')}\n</kpis>`])
    expect(kpis).toEqual([
      { label: 'Samples', value: '1,204' },
      { label: 'عدد العيوب', value: '٣٩', trend: 'up-good' },
      { label: 'Reject rate', value: '1.29%', trend: 'down-bad' },
      { label: 'Holds', value: '4' },
      { label: 'Without a marker', value: '7', trend: 'flat' },
      { label: `${'L'.repeat(59)}…`, value: '1' },
    ])
    expect(kpis).toHaveLength(MAX_KPIS)
  })

  it('takes the last whole block of the answer’s texts, and none that never closed', () => {
    expect(parseKpis(['<kpis>\n- First | 1\n</kpis>', 'Then.', '<KPIS class="x">\n- Second | 2\n</kpis >'])).toEqual([{ label: 'Second', value: '2' }])
    expect(parseKpis(['<kpis>\n- Cut | 1\n- Off | 2'])).toEqual([])
  })

  it('takes the block out however it was written, and the blank lines it leaves at the start', () => {
    expect(both('```\n<kpis>\n- A | 1\n</kpis>\n```\n\nThe answer.', true)).toBe('The answer.')
    expect(both('<Kpis>\n- A | 1\n</Kpis>\n\n    indented code', true)).toBe('    indented code')
    expect(both('Let me check.\n\n<kpis>\n- A | 1\n</kpis>\n\nThe answer.', false)).toBe('Let me check.\n\n\n\nThe answer.')
    // With the follow-up questions at the end, both go.
    expect(both('<kpis>\n- A | 1\n</kpis>\n\nThe answer.\n\n<suggestions>\n- Next?\n</suggestions>', true)).toBe('The answer.')
  })

  it('ends a block whose closing tag never came at its first blank line, so the answer after it stays', () => {
    expect(both('<kpis>\n- A | 1\n- B | 2\n\nThe answer.\n\nMore.', false)).toBe('The answer.\n\nMore.')
    expect(both('<kpis>\n- A | 1\n```\n\nThe answer.', false)).toBe('```\n\nThe answer.')
    expect(both('```\n<kpis>\n- A | 1\n```\n\nThe answer.', false)).toBe('The answer.')
    expect(both('<kpis>\n- A | 1\n\nThe answer.\n\n<suggestions>\n- Next?\n</suggestions>', true)).toBe('The answer.')
    // Cut off inside it: all of it goes, a figure half written included.
    expect(both('Let me check.\n\n<kpis>\n- Defect pieces | 39\n- Reject rate | 1.2', true)).toBe('Let me check.')
    // A tag still being written at the very end of the answer, and only there.
    expect(both('<kp', true)).toBe('')
    expect(both('The answer <kp', true)).toBe('The answer')
    expect(both('The answer <kp', false)).toBe('The answer <kp')
    expect(both('a < b', true)).toBe('a < b')
    // Its attributes still being written on a line of its own.
    expect(both('Let me check.\n\n  <kpis lang="en"', true)).toBe('Let me check.')
  })

  it('leaves a tag the answer only names in its text, and takes a block written after it', () => {
    // Named in a sentence, in code or not, a tag opens no block: the sentence and the lines after it stay.
    for (const named of [
      'The answer uses `<kpis>` tags.\nSecond line\n\nMore',
      'Use <kpis> to open an answer.\nNext line.\n\nMore',
      'Use <KPIS lang="en"> to open an answer.\n\nMore',
      'The <kpisx>\nthing.',
      '<kpis> opens the figures.\nSecond line',
    ]) {
      expect(both(named, true), named).toBe(named)
      expect(both(named, false), named).toBe(named)
    }
    // A whole block written after the tag was named begins at its own opening tag.
    const after = 'The `<kpis>` block holds the figures.\n\n<kpis>\n- A | 1\n</kpis>\n\nThe answer.'
    expect(both(after, true)).toBe('The `<kpis>` block holds the figures.\n\n\n\nThe answer.')
    expect(parseKpis([after])).toEqual([{ label: 'A', value: '1' }])
    // An unclosed block on a line of its own after a named tag still ends at its blank line.
    expect(both('Named `<kpis>` here.\n\n  <kpis>  \n- A | 1\n\nThe answer.', false)).toBe('Named `<kpis>` here.\n\n  \n\nThe answer.')
  })
})

describe('§20 charts: checking a chart against its result', () => {
  const result = (columns: string[], rows: QueryPreview['rows'], truncated = false): QueryPreview => ({ columns, rows, rowCount: rows.length, truncated })
  const byMachine = result(
    ['machine', 'defect_pieces', 'samples', 'line'],
    [
      ['58. Welding', 12, 40, 'L1'],
      ['31. Forming', 7, 22, 'L2'],
      ['12. Paint', 0, 15, null],
    ],
  )

  it('lets a chart that fits its result through, as the columns are named', () => {
    expect(checkChart({ type: 'bar', x: 'machine', y: ['defect_pieces', 'samples'], title: '  Defects\nby machine ' }, byMachine)).toEqual({
      chart: { type: 'bar', x: 'machine', y: ['defect_pieces', 'samples'], title: 'Defects by machine' },
    })
    // PostgreSQL folds an unquoted alias to lower case; a type may be spelled loosely.
    expect(checkChart({ type: 'Stacked bar', x: 'Machine', y: 'Defect_Pieces', series: null, title: '' }, byMachine)).toEqual({
      chart: { type: 'stacked-bar', x: 'machine', y: ['defect_pieces'] },
    })
    expect(checkChart({ type: 'line', x: 'machine', y: ['samples'], title: 'T'.repeat(150) }, byMachine).chart?.title).toBe(`${'T'.repeat(99)}…`)
    // Long form, split by a series column.
    const long = result(
      ['day', 'machine', 'n'],
      [
        ['2026-09-01', '58', 1],
        ['2026-09-01', '31', 4],
        ['2026-09-02', '58', 2],
        ['2026-09-02', '31', null],
      ],
    )
    expect(checkChart({ type: 'area', x: 'day', y: ['n'], series: 'machine' }, long)).toEqual({ chart: { type: 'area', x: 'day', y: ['n'], series: 'machine' } })
    expect(checkChart(undefined, byMachine)).toEqual({})
    expect(checkChart(null, byMachine)).toEqual({})
  })

  it('leaves out a chart that does not fit, saying why', () => {
    const note = (chart: unknown, r: QueryPreview = byMachine) => {
      const checked = checkChart(chart, r)
      expect(checked.chart, JSON.stringify(chart)).toBeUndefined()
      return checked.note
    }
    expect(note({ type: 'bar', x: 'machine' })).toMatch(/^Chart not drawn: chart takes type, x and y/)
    expect(note({ type: 'bar', x: 'machine', y: [3] })).toMatch(/^Chart not drawn: chart takes/)
    expect(note({ type: 'radar', x: 'machine', y: ['samples'] })).toBe(
      'Chart not drawn: its type must be one of bar, horizontal-bar, stacked-bar, stacked-bar-100, line, area, stacked-area, pie, combo, pareto, scatter, heatmap, control.',
    )
    expect(note({ type: 'bar', x: 'day', y: ['samples'] })).toBe('Chart not drawn: x "day" is not a column of the result.')
    expect(note({ type: 'bar', x: 'machine', y: ['defects'] })).toBe('Chart not drawn: y "defects" is not a column of the result.')
    expect(note({ type: 'bar', x: 'machine', y: [] })).toBe('Chart not drawn: y takes 1 to 4 columns.')
    expect(note({ type: 'bar', x: 'machine', y: ['samples', 'samples', 'defect_pieces', 'samples', 'line'] })).toBe('Chart not drawn: y takes 1 to 4 columns.')
    expect(note({ type: 'bar', x: 'machine', y: ['machine'] })).toMatch(/"machine" is used twice/)
    expect(note({ type: 'bar', x: 'machine', y: ['line'] })).toBe('Chart not drawn: y column "line" is not numeric (it holds "L1").')
    expect(note({ type: 'bar', x: 'machine', y: ['samples'], series: 'samples' })).toMatch(/"samples" is used twice/)
    expect(note({ type: 'bar', x: 'machine', y: ['samples', 'defect_pieces'], series: 'line' })).toBe('Chart not drawn: with series, y takes exactly one column.')
    expect(note({ type: 'bar', x: 'machine', y: ['samples'], series: 'shift' })).toBe('Chart not drawn: series "shift" is not a column of the result.')
    expect(note({ type: 'bar', x: 'n', y: ['n'] }, result(['n', 'n'], [[1, 2]]))).toBe('Chart not drawn: x "n" names 2 columns of the result; give them distinct aliases.')
    expect(note({ type: 'bar', x: 'machine', y: ['samples'] }, result(['machine', 'samples'], []))).toBe('Chart not drawn: the result has no rows.')
    expect(note({ type: 'bar', x: 'machine', y: ['samples'] }, result(['machine', 'samples'], [['58', 4]]))).toBe('Chart not drawn: a single figure is stated in words, not charted.')
    expect(note({ type: 'bar', x: 'machine', y: ['samples'] }, result(['machine', 'samples'], [['58', null], ['31', null]]))).toBe('Chart not drawn: y column "samples" holds no numbers.')
    expect(note({ type: 'bar', x: 'machine', y: ['samples'] }, result(['machine', 'samples'], [['58', 0], ['31', 0]]))).toBe('Chart not drawn: every value is 0.')
    const nine = result(['day', 'machine', 'n'], Array.from({ length: 9 }, (_, i) => ['2026-09-01', `M${i}`, i + 1]))
    expect(note({ type: 'line', x: 'day', y: ['n'], series: 'machine' }, nine)).toMatch(/^Chart not drawn: series "machine" has 9 values; a chart shows at most 8\./)
    // One point per x, or per x and series: rows on one point would be drawn over each other.
    const repeated = result(['machine', 'n'], [['58', 1], ['58', 2], ['31', 3]])
    expect(note({ type: 'bar', x: 'machine', y: ['n'] }, repeated)).toBe(
      'Chart not drawn: rows repeat a value of x "machine"; return one row per x, or name the column that tells them apart as series.',
    )
    const pairs = result(['day', 'machine', 'n'], [['2026-09-01', '58', 1], ['2026-09-01', '58', 2], ['2026-09-02', '58', 3]])
    expect(note({ type: 'line', x: 'day', y: ['n'], series: 'machine' }, pairs)).toBe('Chart not drawn: rows repeat a pair of x "day" and series "machine"; return one row per pair.')
  })

  it('draws a pie it cannot show as bars, and says that a truncated result is drawn only in part', () => {
    expect(checkChart({ type: 'pie', x: 'machine', y: ['samples'] }, byMachine)).toEqual({ chart: { type: 'pie', x: 'machine', y: ['samples'] } })
    const twelve = result(['category', 'pieces'], Array.from({ length: 12 }, (_, i) => [`C${i + 1}`, i + 1]))
    expect(checkChart({ type: 'pie', x: 'category', y: ['pieces'] }, twelve)).toEqual({
      chart: { type: 'bar', x: 'category', y: ['pieces'] },
      note: 'Chart drawn as a bar chart instead of a pie: a pie shows at most 8 slices and the result has 12.',
    })
    expect(checkChart({ type: 'pie', x: 'machine', y: ['samples', 'defect_pieces'] }, byMachine).note).toBe(
      'Chart drawn as a bar chart instead of a pie: a pie shows one y column and no series.',
    )
    const change = result(['machine', 'change'], [['58', 3], ['31', -2]])
    expect(checkChart({ type: 'pie', x: 'machine', y: ['change'] }, change)).toEqual({
      chart: { type: 'bar', x: 'machine', y: ['change'] },
      note: 'Chart drawn as a bar chart instead of a pie: a pie cannot show negative values.',
    })
    expect(checkChart({ type: 'line', x: 'machine', y: ['samples'] }, { ...byMachine, truncated: true })).toEqual({
      chart: { type: 'line', x: 'machine', y: ['samples'] },
      note: 'The chart shows only the 3 rows returned, not the whole result: aggregate further for a chart of all of it.',
    })
  })

  it('takes each kind of chart with what it needs, and draws one that cannot be as asked another way', () => {
    // A ranking, a 100% stack, a combo with a target, a heatmap, a control chart; donut is a pie.
    expect(checkChart({ type: 'horizontal-bar', x: 'machine', y: ['samples'], goal: 20 }, byMachine)).toEqual({ chart: { type: 'horizontal-bar', x: 'machine', y: ['samples'], goal: 20 } })
    expect(checkChart({ type: 'Donut', x: 'machine', y: ['samples'] }, byMachine).chart?.type).toBe('pie')
    expect(checkChart({ type: 'percent stacked bar', x: 'machine', y: ['samples', 'defect_pieces'] }, byMachine).chart?.type).toBe('stacked-bar-100')
    const days = result(
      ['day', 'produced', 'reject_pct'],
      Array.from({ length: 6 }, (_, i) => [`2026-09-0${i + 1}`, 100 + i * 10, 1 + (i % 3) * 0.5]),
    )
    expect(checkChart({ type: 'combo', x: 'day', y: ['produced', 'reject_pct'], goal: 2 }, days)).toEqual({ chart: { type: 'combo', x: 'day', y: ['produced', 'reject_pct'], goal: 2 } })
    expect(checkChart({ type: 'control', x: 'day', y: ['reject_pct'] }, days)).toEqual({ chart: { type: 'control', x: 'day', y: ['reject_pct'] } })
    const grid = result(
      ['day', 'machine', 'n'],
      [
        ['2026-09-01', '58', 1],
        ['2026-09-01', '31', 4],
        ['2026-09-02', '58', 2],
      ],
    )
    expect(checkChart({ type: 'heatmap', x: 'day', y: ['n'], series: 'machine' }, grid)).toEqual({ chart: { type: 'heatmap', x: 'day', y: ['n'], series: 'machine' } })
    // A scatter's points may share an x; its x is a number.
    const pairs = result(['thickness', 'rejects'], [[1.5, 3], [1.5, 4], [2, 6], [2.5, 9]])
    expect(checkChart({ type: 'scatter', x: 'thickness', y: ['rejects'] }, pairs)).toEqual({ chart: { type: 'scatter', x: 'thickness', y: ['rejects'] } })

    // What each kind cannot take.
    const why = (chart: unknown, r: QueryPreview) => checkChart(chart, r).note
    expect(why({ type: 'combo', x: 'day', y: ['produced'] }, days)).toMatch(/a combo chart takes 2 to 4 y columns/)
    expect(why({ type: 'heatmap', x: 'day', y: ['n'] }, grid)).toBe('Chart not drawn: a heatmap takes one y column and a series column for its rows.')
    expect(why({ type: 'pareto', x: 'day', y: ['produced', 'reject_pct'] }, days)).toBe('Chart not drawn: a Pareto chart takes one y column and no series.')
    expect(why({ type: 'control', x: 'machine', y: ['samples'] }, byMachine)).toBe('Chart not drawn: a control chart needs at least 5 points for its limits.')
    expect(why({ type: 'scatter', x: 'machine', y: ['samples'] }, byMachine)).toMatch(/^Chart not drawn: a scatter chart's x column "machine" must be numeric/)
    // Drawn another way, saying so; a goal on a chart that takes none is left out.
    const change = result(['machine', 'a', 'b'], [['58', 3, 1], ['31', -2, 4]])
    expect(checkChart({ type: 'stacked-bar', x: 'machine', y: ['a', 'b'] }, change)).toEqual({
      chart: { type: 'bar', x: 'machine', y: ['a', 'b'] },
      note: 'Chart drawn as bars side by side instead of stacked: a stack cannot show values below zero.',
    })
    expect(checkChart({ type: 'stacked-area', x: 'machine', y: ['a', 'b'] }, change).chart?.type).toBe('line')
    expect(checkChart({ type: 'pareto', x: 'machine', y: ['a'] }, change).chart?.type).toBe('bar')
    expect(checkChart({ type: 'pie', x: 'machine', y: ['samples'], goal: 3 }, byMachine)).toEqual({
      chart: { type: 'pie', x: 'machine', y: ['samples'] },
      note: 'The goal line is not drawn: a pie chart takes none.',
    })
  })

  it('is offered in the tool as an optional object the API can hold the model to', () => {
    const schema = RUN_SQL_TOOL.input_schema as { properties: Record<string, unknown>; required: string[] }
    expect(schema.required).toEqual(['purpose', 'sql'])
    expect(schema.properties.chart).toBe(CHART_INPUT_SCHEMA)
    expect(CHART_INPUT_SCHEMA).toMatchObject({ type: 'object', required: ['type', 'x', 'y'], additionalProperties: false })
    expect(CHART_INPUT_SCHEMA.properties.type.enum).toEqual([
      'bar',
      'horizontal-bar',
      'stacked-bar',
      'stacked-bar-100',
      'line',
      'area',
      'stacked-area',
      'pie',
      'combo',
      'pareto',
      'scatter',
      'heatmap',
      'control',
    ])
    // Strict tool use takes no length or count limits: those are checked here instead.
    expect(JSON.stringify(RUN_SQL_TOOL)).not.toMatch(/"(minItems|maxItems|minLength|maxLength|minimum|maximum)"/)
  })
})

const app = new TestApp()
let admin: Session

async function ask(message: string, conversationId?: string) {
  const res = await app.api<string>('POST', '/api/ai/chat', {
    token: admin.token,
    body: { message, clientId: randomUUID(), ...(conversationId ? { conversationId } : {}) },
  })
  expect(res.status).toBe(200)
  const events = res.body
    .split('\n\n')
    .filter((f) => f && !f.startsWith(':'))
    .map((f) => JSON.parse(f.slice(f.indexOf('data: ') + 6)) as AiStreamEvent)
  const done = events.find((e): e is Extract<AiStreamEvent, { type: 'done' }> => e.type === 'done')!
  const start = events.find((e): e is Extract<AiStreamEvent, { type: 'start' }> => e.type === 'start')!
  const ends = events.filter((e): e is Extract<AiStreamEvent, { type: 'query_end' }> => e.type === 'query_end').map((e) => e.part)
  return { events, done, ends, conversationId: start.conversation.id }
}

const lastCall = () => app.model.calls[app.model.calls.length - 1]
const messagesOf = (conversationId: string) => app.api<AiMessagesResponse>('GET', `/api/ai/conversations/${conversationId}/messages`, { token: admin.token })
const storedQueries = async (conversationId: string) =>
  (await app.db.query<{ toolUseId: string; ok: boolean; chart: unknown }>(`SELECT tool_use_id AS "toolUseId", ok, chart FROM ai_queries WHERE conversation_id = $1 ORDER BY created_at, tool_use_id`, [conversationId]))
    .rows

const BY_PROCESS = 'SELECT process, count(*) AS machines FROM ai.machines GROUP BY process ORDER BY process'
const TWELVE = `SELECT 'C' || g AS category, g AS pieces FROM generate_series(1, 12) g`
const FINAL =
  '<kpis>\n- Machines | 3\n- Forming | 2 | flat\n</kpis>\n\nThere are **3** machines, **2** of them forming.\n\n<suggestions>\n- Which machine was added last?\n</suggestions>'

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  admin = await app.register('admin', 'Admin')
  for (const [code, process] of [
    ['58', 'forming'],
    ['31', 'forming'],
    ['12', 'welding'],
  ]) {
    const made = await app.api('POST', '/api/master/machines', { token: admin.token, body: { code, name: `Machine ${code}`, displayName: `${code}. Machine`, process } })
    expect(made.status).toBe(201)
  }
  const set = await app.api('PUT', '/api/ai/key', { token: admin.token, body: { apiKey: `sk-ant-api03-${'k_9-'.repeat(20)}LaSt` } })
  expect(set.status).toBe(200)
})
afterAll(() => app.stop())
beforeEach(() => app.aiLimiter.reset(admin.user.id))

describe('§20 a professional answer in a conversation', () => {
  let conversationId = ''
  const reply1 = {
    content: [
      thinking('Count by process, and chart it.'),
      text('Let me count the machines by process.'),
      charted('toolu_c1', 'Machines by process', BY_PROCESS, { type: 'bar', x: 'process', y: ['machines'], title: 'Machines by process' }),
      charted('toolu_c2', 'Pieces by category', TWELVE, { type: 'pie', x: 'category', y: ['pieces'] }),
      charted('toolu_c3', 'Processes, drawn wrongly', BY_PROCESS, { type: 'line', x: 'machines', y: ['process'] }),
    ],
  }

  it('asks a new conversation for headline figures and offers its tool a chart', async () => {
    app.model.reply({ content: [text('Hello.')] })
    await ask('Hello')
    const p = lastCall().params
    const system = (p.system as { text: string }[])[0].text
    expect(system).toContain('# Headline figures')
    expect(system).toContain('<kpis>\n- Defect pieces | 39\n- Reject rate | 1.29% | down-good\n- Holds open | 4 | up-bad\n</kpis>')
    expect(system).toContain('# Charts')
    expect(system).toMatch(/never chart a single number/i)
    // The figures open the answer; the questions still close it.
    expect(system.indexOf('# Headline figures')).toBeLessThan(system.indexOf('# Follow-up questions'))
    // The owner asks here, who may create automations (§21): the automations' tools follow run_sql; then the
    // notices' (§23), the owner being an administrator who may have them written; then the tasks'.
    expect(p.tools).toEqual([RUN_SQL_TOOL, TOOL_SEARCH_TOOL, ...[...AUTOMATION_TOOLS, ...NOTICE_READ_TOOLS, ...NOTICE_MANAGE_TOOLS, ...TASK_TOOLS, ...PLAYBOOK_TOOLS].map(deferred)])
  })

  it('draws the charts that fit their results, live and in the history, and tells the model about the rest', async () => {
    app.model.reply(reply1, { content: [text(FINAL)] })
    const res = await ask('How many machines are there by process?')
    conversationId = res.conversationId

    // Live: each card as its query ends, with the chart it is drawn as.
    expect(res.ends).toHaveLength(3)
    const [bar, pie, wrong] = res.ends
    expect(bar).toMatchObject({ ok: true, columns: ['process', 'machines'], rows: [['forming', 2], ['welding', 1]], chart: { type: 'bar', x: 'process', y: ['machines'], title: 'Machines by process' } })
    expect(pie).toMatchObject({ ok: true, rowCount: 12, chart: { type: 'bar', x: 'category', y: ['pieces'] } })
    expect(wrong).toMatchObject({ ok: true, rows: [['forming', 2], ['welding', 1]] })
    expect(wrong).not.toHaveProperty('chart')

    // The answer: its figures and questions on their own, the text without them, the cards as they streamed.
    const answer = res.done.message
    expect(answer.kpis).toEqual([
      { label: 'Machines', value: '3' },
      { label: 'Forming', value: '2', trend: 'flat' },
    ])
    expect(answer.suggestions).toEqual(['Which machine was added last?'])
    expect(answer.parts).toEqual([
      { type: 'text', text: 'Let me count the machines by process.' },
      bar,
      pie,
      wrong,
      { type: 'text', text: 'There are **3** machines, **2** of them forming.' },
    ])
    const shown = await messagesOf(conversationId)
    expect(shown.body.messages[1]).toEqual(answer)

    // Kept with each query: the chart as drawn, or none.
    expect(await storedQueries(conversationId)).toEqual([
      { toolUseId: 'toolu_c1', ok: true, chart: { type: 'bar', x: 'process', y: ['machines'], title: 'Machines by process' } },
      { toolUseId: 'toolu_c2', ok: true, chart: { type: 'bar', x: 'category', y: ['pieces'] } },
      { toolUseId: 'toolu_c3', ok: true, chart: null },
    ])

    // The model reads the rows as ever, and a word after them where the chart was not drawn as asked.
    const results = app.model.calls[app.model.calls.length - 1].params.messages[2].content as Anthropic.Beta.BetaToolResultBlockParam[]
    expect(results[0]).toEqual({ type: 'tool_result', tool_use_id: 'toolu_c1', content: '{"columns":["process","machines"],"rows":[["forming",2],["welding",1]],"rowCount":2,"truncated":false}' })
    expect(results[1]).toEqual({
      type: 'tool_result',
      tool_use_id: 'toolu_c2',
      content: [
        { type: 'text', text: expect.stringMatching(/^\{"columns":\["category","pieces"\],"rows":\[\["C1",1\],/) },
        { type: 'text', text: 'Chart drawn as a bar chart instead of a pie: a pie shows at most 8 slices and the result has 12.' },
      ],
    })
    expect(results[2]).toEqual({
      type: 'tool_result',
      tool_use_id: 'toolu_c3',
      content: [
        { type: 'text', text: '{"columns":["process","machines"],"rows":[["forming",2],["welding",1]],"rowCount":2,"truncated":false}' },
        { type: 'text', text: 'Chart not drawn: y column "process" is not numeric (it holds "forming").' },
      ],
    })

    // The transcript keeps the answer as written: the blocks are taken out of the display only.
    const stored = await app.db.query<{ kind: string; content: string }>(`SELECT kind, content::text AS content FROM ai_messages WHERE conversation_id = $1 ORDER BY seq`, [conversationId])
    expect(stored.rows.map((r) => r.kind)).toEqual(['question', 'assistant', 'tool_results', 'assistant'])
    expect(stored.rows[1].content).toBe(JSON.stringify(reply1.content))
    expect(stored.rows[2].content).toBe(JSON.stringify(results))
    expect(stored.rows[3].content).toBe(JSON.stringify([text(FINAL)]))
  })

  it('replays it all byte for byte on the next question, with the prompt and tool it began with', async () => {
    const first = app.model.calls[app.model.calls.length - 2].params
    const prior = lastCall().params
    const conversation = await app.db.query<{ systemPrompt: string; tools: string }>(
      `SELECT system_prompt AS "systemPrompt", tools::text AS tools FROM ai_conversations WHERE id = $1`,
      [conversationId],
    )
    app.model.reply({ content: [text('<kpis>\n- Welding | 1\n</kpis>\n\nOne welding machine.')] })
    const next = await ask('And welding?', conversationId)
    const sent = lastCall()
    expect(JSON.stringify(sent.params.messages.slice(0, prior.messages.length + 1))).toBe(JSON.stringify([...prior.messages, { role: 'assistant', content: [text(FINAL)] }]))
    expect(sent.body).toContain(JSON.stringify(prior.messages).slice(0, -1))
    expect(JSON.stringify(prior.messages.slice(0, first.messages.length))).toBe(JSON.stringify(first.messages))
    expect(JSON.stringify(sent.params.system)).toBe(JSON.stringify(first.system))
    expect((sent.params.system as { text: string }[])[0].text).toBe(conversation.rows[0].systemPrompt)
    expect(JSON.stringify(sent.params.tools)).toBe(conversation.rows[0].tools)
    expect(JSON.stringify(sent.params.tools)).toBe(JSON.stringify(first.tools))
    expect(next.done.message).toMatchObject({ kpis: [{ label: 'Welding', value: '1' }], parts: [{ type: 'text', text: 'One welding machine.' }] })

    // Each answer keeps its own figures and charts in the history.
    const shown = await messagesOf(conversationId)
    const answers = shown.body.messages.filter((m) => m.role === 'assistant')
    expect(answers.map((m) => m.kpis)).toEqual([
      [
        { label: 'Machines', value: '3' },
        { label: 'Forming', value: '2', trend: 'flat' },
      ],
      [{ label: 'Welding', value: '1' }],
    ])
    expect(answers[0].parts.filter((p): p is AiQueryPart => p.type === 'query').map((p) => p.chart?.type ?? null)).toEqual(['bar', 'bar', null])
  })

  it('draws nothing for a query that failed, and tells the model only its error', async () => {
    app.model.reply(
      { content: [charted('toolu_f1', 'A view that is not there', 'SELECT x FROM ai.nothing_here', { type: 'bar', x: 'x', y: ['x'] })] },
      { content: [text('That view is not available.')] },
    )
    const res = await ask('Something broken')
    expect(res.ends).toEqual([expect.objectContaining({ ok: false, error: expect.any(String) })])
    expect(res.ends[0]).not.toHaveProperty('chart')
    const results = lastCall().params.messages[2].content as Anthropic.Beta.BetaToolResultBlockParam[]
    expect(results).toEqual([{ type: 'tool_result', tool_use_id: 'toolu_f1', is_error: true, content: res.ends[0].error }])
    expect(await storedQueries(res.conversationId)).toEqual([{ toolUseId: 'toolu_f1', ok: false, chart: null }])
  })

  it('shows no figures of an answer cut off while it wrote them, nor any of the half-written block', async () => {
    app.model.reply(
      { content: [text('Let me count.'), runSql('toolu_k1', 'Count the machines', 'SELECT count(*) AS n FROM ai.machines')] },
      { content: [text('<kpis>\n- Machines | 3\n- Forming | 2 | fl')], stopReason: 'max_tokens' },
    )
    const res = await ask('A long one')
    expect(res.done.message).toMatchObject({ stopReason: 'max_tokens', parts: [{ type: 'text', text: 'Let me count.' }, expect.objectContaining({ type: 'query' })] })
    expect(res.done.message).not.toHaveProperty('kpis')
  })

  it('goes on with the prompt and tool a conversation began with before charts: nothing stored is changed', async () => {
    // A conversation as phase 3 began it: the tool without chart, a prompt that never asked for figures.
    const { chart: _chart, ...properties } = (RUN_SQL_TOOL.input_schema as { properties: Record<string, unknown> }).properties
    const oldTool = { ...RUN_SQL_TOOL, input_schema: { ...RUN_SQL_TOOL.input_schema, properties } }
    app.model.reply({ content: [text('Hello.')] })
    const { conversationId: old } = await ask('An old conversation')
    await app.db.query(`UPDATE ai_conversations SET system_prompt = 'An earlier prompt.', tools = $2::json WHERE id = $1`, [old, JSON.stringify([oldTool])])
    const tools = (await app.db.query<{ tools: string }>(`SELECT tools::text AS tools FROM ai_conversations WHERE id = $1`, [old])).rows[0].tools

    app.model.reply(
      { content: [runSql('toolu_o1', 'Machines by process', BY_PROCESS)] },
      { content: [text('Two processes.')] },
    )
    const res = await ask('By process?', old)
    const sent = lastCall().params
    expect(JSON.stringify(sent.tools)).toBe(tools)
    expect(JSON.stringify(sent.tools)).not.toContain('"chart"')
    expect((sent.system as { text: string }[])[0].text).toBe('An earlier prompt.')
    expect(res.ends[0]).not.toHaveProperty('chart')
    expect(res.done.message).not.toHaveProperty('kpis')
    expect(res.done.message.parts).toEqual([res.ends[0], { type: 'text', text: 'Two processes.' }])
  })
})
