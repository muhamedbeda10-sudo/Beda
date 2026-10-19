// ============================================================================
// §20 — reports the assistant builds (./reports): two tools of every new
// conversation, loaded through the tool search when a request needs them.
//
//   • save_report builds a report, or changes one the person made: its
//     title, what it shows, the inputs a run asks for besides the period
//     (the orders, a week, the orders to leave out — ./reportInputs), and its
//     sections, each a read-only query shown as a table (with a chart), as
//     headline figures or as a tree; shared with everyone given the
//     assistant, or kept to the person. Before anything is kept, every
//     section is run with the sample values the model gives, as the person's
//     domains read now: a section that fails, a placeholder the report has
//     no input for, a chart its rows cannot draw, a tree whose columns are
//     not there — every problem is told at once, and nothing is kept. What
//     passes is kept with the call and its result in one transaction, and
//     shown as a card in the answer with Open report.
//   • read_report lists the reports the person may open, or gives one in
//     full (its inputs and its sections' SQL), so the model can change it.
//
// A report runs as whoever opens it reads: sharing one shares its queries,
// never data its reader may not see.
// ============================================================================

import { randomUUID } from 'node:crypto'
import type Anthropic from '@anthropic-ai/sdk'
import {
  AI_PREVIEW_ROWS,
  AI_REPORT_SECTION_DISPLAYS,
  resolveAiPeriod,
  type AiReport,
  type AiReportPart,
  type AiReportPeriod,
  type AiReportSection,
  type AiReportSectionDisplay,
  type AiStreamEvent,
} from '@qc/shared/ai'
import { AI_REPORT_DYNAMIC_DEFAULTS, AI_REPORT_INPUT_KINDS, AI_REPORT_MAX_INPUTS, readInputValues, type AiReportInput } from '@qc/shared/aiReportInputs'
import type { Config } from '../config'
import type { Db, Queryable } from '../db/pool'
import { isGranted, loadAccess } from './access'
import type { Readers, ToolHandler, ToolOutcome } from './assistant'
import { CHART_INPUT_SCHEMA, checkChart } from './charts'
import { factoryDay } from './prompt'
import { readInputDefinitions, placeholderProblems } from './reportInputs'
import { AI_REPORT_TITLE_CHARS, PERIOD_KINDS, WEEK_STARTS, changeReport, findReport, insertReport, listReports, sectionSql, toPeriod, type ModelPeriod } from './reports'
import { AI_MAX_SQL_CHARS, AI_QUERY_TIMEOUT_MS, previewOf, runReadOnlyQuery } from './runQuery'
import { withQueryOrigin, withQueryPurpose } from './slowQueries'
import { reportPart } from './reportParts'

type ToolUse = Anthropic.Beta.BetaToolUseBlock

export const SAVE_REPORT_TOOL_NAME = 'save_report'
export const READ_REPORT_TOOL_NAME = 'read_report'

/** Sections a report holds at most; how long a description and a note may be; rows of each section the model is shown after a test run. */
export const AI_REPORT_MAX_SECTIONS = 20
const DESCRIPTION_MAX = 2000
const NOTE_MAX = 300
const SHOWN_ROWS = 5

const text = (description: string) => ({ type: 'string', description })

export const SAVE_REPORT_TOOL: Anthropic.Beta.BetaTool = {
  name: SAVE_REPORT_TOOL_NAME,
  description:
    'Build a report the person keeps and runs again whenever they like (My reports), or change one they made: inputs a run asks for (orders, a week number, orders to leave out, a machine…), and sections, each one read-only query over the ai.* views and saved tables, shown as a table (with a chart), as headline figures, or as a tree. ' +
    'Every section is run once with the sample values before anything is kept: a section that fails, a placeholder with no input, a chart its rows cannot draw — every problem comes back at once, and nothing is kept. ' +
    'Returns the report and each section\'s first rows from the test run, or every problem to fix before calling again.',
  eager_input_streaming: true,
  input_schema: {
    type: 'object',
    properties: {
      report_id: text('Optional. To change a report the person made (read_report gives its id and its whole definition): give the whole report as it should now be.'),
      title: text(`Its title, in the person's language (at most ${AI_REPORT_TITLE_CHARS} characters).`),
      description: text(`What it shows and how its figures are worked out, for anyone who opens it (at most ${DESCRIPTION_MAX} characters).`),
      shared: { type: 'boolean', description: 'True: everyone given the assistant may open it, each over the data they may read. False: the person alone.' },
      period: {
        type: 'object',
        description: "Optional. A period the person can change when it runs; sections then bound their dates with {{from}} and {{to}} (the period's first and last day). Leave it out when no section is about a period.",
        properties: {
          kind: { type: 'string', enum: [...PERIOD_KINDS] },
          days: { type: 'integer', description: 'last_days: how many.' },
          weekStart: { type: 'string', enum: [...WEEK_STARTS], description: 'this_week, last_week.' },
          from: text('fixed: YYYY-MM-DD.'),
          to: text('fixed: YYYY-MM-DD.'),
        },
        required: ['kind'],
        additionalProperties: false,
      },
      inputs: {
        type: 'array',
        description: `Optional, at most ${AI_REPORT_MAX_INPUTS}. What the form asks for before a run; a section names each as {{name}}, in code, never in quotes. text and choice are text, list is text[] (NULL when empty), number is numeric, date is date; an empty optional input is NULL.`,
        items: {
          type: 'object',
          properties: {
            name: text('Lowercase letters, digits and _: {{name}} in the SQL.'),
            label: text("What the form calls it, in the person's language."),
            kind: { type: 'string', enum: [...AI_REPORT_INPUT_KINDS] },
            required: { type: 'boolean' },
            help: text('Optional. A hint under the field: what to type.'),
            default: { description: 'Optional. The value the form starts from: a text, a number, a day, or a list of texts.' },
            dynamic_default: { type: 'string', enum: [...AI_REPORT_DYNAMIC_DEFAULTS], description: "Optional. A default of the moment it runs: this ISO week's number, this year, today." },
            choices: { type: 'array', items: { type: 'string' }, description: "A choice's values." },
          },
          required: ['name', 'label', 'kind', 'required'],
          additionalProperties: false,
        },
      },
      sections: {
        type: 'array',
        description: `1 to ${AI_REPORT_MAX_SECTIONS}, in the order shown.`,
        items: {
          type: 'object',
          properties: {
            title: text('What it shows, in the person\'s language.'),
            sql: text('One read-only SELECT over the ai.* views and saved tables, as run_sql takes it, naming the inputs as {{name}} (and the period as {{from}} and {{to}}).'),
            display: {
              type: 'string',
              enum: [...AI_REPORT_SECTION_DISPLAYS],
              description: "table (the default): its rows, with chart when given. figures: headline figures, the first row's columns as cards (one row, each column a figure under a short readable alias). tree: rows nested under the row their parent column names (tree gives the two columns).",
            },
            chart: CHART_INPUT_SCHEMA,
            tree: {
              type: 'object',
              description: 'For display tree: the column naming each row, and the column naming the row it sits under (NULL or empty at the top). Neither is shown; every other column is, so select only those to show. Rows keep their order under their parent: order them as they should read.',
              properties: { key: text('A column of the result.'), parent: text('A column of the result.') },
              required: ['key', 'parent'],
              additionalProperties: false,
            },
            note: text(`Optional. A line under the title: what it counts and how (at most ${NOTE_MAX} characters).`),
          },
          required: ['title', 'sql'],
          additionalProperties: false,
        },
      },
      sample: {
        type: 'object',
        description: 'Values of the inputs for the test run, by name: real ones from the data (a real order number, this week), so the run shows the report works. Inputs left out run with their default.',
      },
    },
    required: ['title', 'description', 'shared', 'sections'],
    additionalProperties: false,
  },
}

export const READ_REPORT_TOOL: Anthropic.Beta.BetaTool = {
  name: READ_REPORT_TOOL_NAME,
  description:
    'The reports the person may open (their own and the shared ones): without report_id, a list (id, title, what it shows, its inputs, who made it); with report_id, the whole report — its inputs and each section\'s SQL and display — to change it with save_report.',
  eager_input_streaming: true,
  input_schema: {
    type: 'object',
    properties: {
      report_id: text('Optional. The report to read in full.'),
      search: text('Optional. Words of its title, for the list.'),
    },
    additionalProperties: false,
  },
}

export const REPORT_TOOLS: readonly Anthropic.Beta.BetaTool[] = [SAVE_REPORT_TOOL, READ_REPORT_TOOL]

// ---- Checking what the model sent ------------------------------------------------------

const oneLine = (s: unknown) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '')
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export interface ReportDraft {
  reportId: string | null
  title: string
  description: string
  shared: boolean
  period: AiReportPeriod | null
  inputs: AiReportInput[]
  sections: (AiReportSection & { rawChart?: unknown })[]
  sample: Record<string, unknown>
}

/** The report the model sent, its shape checked (not yet run); or every problem with it. */
export function readReportDraft(input: unknown): { draft: ReportDraft } | { problems: string[] } {
  if (!isRecord(input)) return { problems: ['The input must be an object.'] }
  const problems: string[] = []
  const title = oneLine(input.title)
  if (!title || title.length > AI_REPORT_TITLE_CHARS) problems.push(`title: 1 to ${AI_REPORT_TITLE_CHARS} characters.`)
  const description = typeof input.description === 'string' ? input.description.trim() : ''
  if (!description || description.length > DESCRIPTION_MAX) problems.push(`description: 1 to ${DESCRIPTION_MAX} characters.`)
  if (typeof input.shared !== 'boolean') problems.push('shared: true or false.')
  const reportId = typeof input.report_id === 'string' && input.report_id.trim() ? input.report_id.trim() : null
  if (reportId && !/^[0-9a-f-]{36}$/i.test(reportId)) problems.push('report_id: the id read_report gives.')

  let period: AiReportPeriod | null = null
  if (input.period !== undefined && input.period !== null) {
    const p = input.period as Record<string, unknown>
    period = isRecord(p) && (PERIOD_KINDS as readonly string[]).includes(String(p.kind)) ? toPeriod(p as unknown as ModelPeriod) : null
    if (!period) problems.push('period: a kind (and days for last_days, weekStart for a week, from and to for fixed) that makes a period.')
  }

  const defs = readInputDefinitions(input.inputs)
  if ('problems' in defs) problems.push(...defs.problems)
  const inputs = 'inputs' in defs ? defs.inputs : []

  const sections: ReportDraft['sections'] = []
  const given = Array.isArray(input.sections) ? input.sections : []
  if (given.length === 0 || given.length > AI_REPORT_MAX_SECTIONS) problems.push(`sections: 1 to ${AI_REPORT_MAX_SECTIONS}.`)
  given.slice(0, AI_REPORT_MAX_SECTIONS).forEach((raw, i) => {
    const at = `sections[${i}]`
    if (!isRecord(raw)) {
      problems.push(`${at}: an object.`)
      return
    }
    const sTitle = oneLine(raw.title)
    if (!sTitle || sTitle.length > AI_REPORT_TITLE_CHARS) problems.push(`${at}.title: 1 to ${AI_REPORT_TITLE_CHARS} characters.`)
    const sql = typeof raw.sql === 'string' ? raw.sql.trim() : ''
    if (!sql) problems.push(`${at}.sql: required.`)
    else if (sql.length > AI_MAX_SQL_CHARS) problems.push(`${at}.sql: at most ${AI_MAX_SQL_CHARS} characters.`)
    const display = (raw.display ?? 'table') as AiReportSectionDisplay
    if (!AI_REPORT_SECTION_DISPLAYS.includes(display)) problems.push(`${at}.display: one of ${AI_REPORT_SECTION_DISPLAYS.join(', ')}.`)
    const section: ReportDraft['sections'][number] = { title: sTitle, sql }
    if (display !== 'table') section.display = display
    if (display === 'tree') {
      const tree = isRecord(raw.tree) ? { key: oneLine(raw.tree.key), parent: oneLine(raw.tree.parent) } : null
      if (!tree?.key || !tree.parent) problems.push(`${at}.tree: a tree names its key and parent columns.`)
      else if (tree.key === tree.parent) problems.push(`${at}.tree: key and parent are two columns.`)
      else section.tree = tree
    } else if (raw.tree !== undefined && raw.tree !== null) problems.push(`${at}.tree: only display tree takes it.`)
    if (raw.chart !== undefined && raw.chart !== null) {
      if (display !== 'table') problems.push(`${at}.chart: only a table section takes a chart.`)
      else section.rawChart = raw.chart
    }
    const note = oneLine(raw.note)
    if (note.length > NOTE_MAX) problems.push(`${at}.note: at most ${NOTE_MAX} characters.`)
    else if (note) section.note = note
    if (sql) {
      const placed = placeholderProblems(sql, inputs, period !== null)
      problems.push(...placed.problems.map((p) => `${at}.sql: ${p}`))
    }
    sections.push(section)
  })
  if (problems.length > 0) return { problems }
  return {
    draft: {
      reportId,
      title,
      description,
      shared: input.shared === true,
      period,
      inputs,
      sections,
      sample: isRecord(input.sample) ? input.sample : {},
    },
  }
}

// ---- The tools ------------------------------------------------------------------------

export interface ReportToolContext {
  db: Db
  config: Config
  readers: Readers
  userId: string
  conversationId: string
  turnId: string
  emit: (event: AiStreamEvent) => void
}

const failed = (tu: ToolUse, content: string): ToolOutcome => ({ result: { type: 'tool_result', tool_use_id: tu.id, is_error: true, content } })
const ok = (tu: ToolUse, content: unknown): ToolOutcome => ({ result: { type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(content) } })

async function save(ctx: ReportToolContext, tu: ToolUse, signal: AbortSignal): Promise<ToolOutcome> {
  const read = readReportDraft(tu.input)
  if ('problems' in read) return failed(tu, ['Nothing was kept. Fix these and call save_report again:', ...read.problems.map((p) => `- ${p}`)].join('\n'))
  const { draft } = read
  const access = await loadAccess(ctx.db, ctx.userId)
  if (!isGranted(access)) return failed(tu, 'Not allowed: this person no longer has the assistant.')

  let before: AiReport | null = null
  if (draft.reportId) {
    before = await findReport(ctx.db, draft.reportId, ctx.userId)
    if (!before) return failed(tu, `No report ${draft.reportId} that this person may open: read_report lists them.`)
    if (!before.mine) return failed(tu, `"${before.title}" was made by ${before.ownerName || 'someone else'}: only they may change it. Build a new report instead (no report_id).`)
  }

  // The test run: the sample values (or each input's default), the period as of today, as the person reads now.
  const today = factoryDay(new Date(), ctx.config.FACTORY_TIMEZONE)
  const values = readInputValues(draft.inputs, draft.sample, today)
  if ('problems' in values) return failed(tu, ['Nothing was kept. The sample values for the test run:', ...values.problems.map((p) => `- sample: ${p}`)].join('\n'))
  const days = draft.period ? resolveAiPeriod(draft.period, today) : null
  const pool = ctx.readers.poolFor(access.domains)
  const shape = { adjustable: draft.period !== null, inputs: draft.inputs }
  const problems: string[] = []
  const shown: unknown[] = []
  const sections: AiReportSection[] = []
  await withQueryOrigin({ source: 'report', userId: ctx.userId, purpose: `Building "${draft.title}"` }, async () => {
    for (const [i, s] of draft.sections.entries()) {
      if (signal.aborted) return
      const run = await withQueryPurpose(s.title, () =>
        runReadOnlyQuery(pool, sectionSql(shape, s, days, values.values), { maxRows: AI_PREVIEW_ROWS, timeoutMs: AI_QUERY_TIMEOUT_MS, timeZone: ctx.config.FACTORY_TIMEZONE, signal }),
      )
      const at = `sections[${i}] "${s.title}"`
      if (!run.ok) {
        problems.push(`${at}: ${run.error ?? 'the query failed.'}`)
        continue
      }
      const preview = previewOf(run)
      const { rawChart, ...section } = s
      if (rawChart !== undefined) {
        const chart = checkChart(rawChart, preview)
        if (!chart.chart) problems.push(`${at}: ${chart.note ?? 'its chart cannot be drawn from its rows.'} Change the chart, or the sample so the test run has rows it can draw.`)
        else section.chart = chart.chart
      }
      if (s.display === 'tree' && s.tree) {
        for (const c of [s.tree.key, s.tree.parent]) if (!preview.columns.includes(c)) problems.push(`${at}: the tree's column "${c}" is not one of the result's (${preview.columns.join(', ')}).`)
      }
      if (s.display === 'figures' && preview.rows.length !== 1) problems.push(`${at}: figures show one row, and the test run returned ${preview.rows.length}: aggregate the section to one row.`)
      sections.push(section)
      shown.push({ section: s.title, columns: preview.columns, rows: preview.rows.slice(0, SHOWN_ROWS), rowCount: preview.rowCount, truncated: preview.truncated })
    }
  })
  if (signal.aborted) return failed(tu, 'Nothing was kept: the answer was stopped.')
  if (problems.length > 0) return failed(tu, ['Nothing was kept. Fix these and call save_report again:', ...problems.map((p) => `- ${p}`)].join('\n'))

  const reportId = before?.id ?? randomUUID()
  const changeId = randomUUID()
  const action = before ? 'update' : 'create'
  const kept = {
    title: draft.title,
    description: draft.description,
    period: draft.period,
    adjustable: draft.period !== null,
    sections,
    inputs: draft.inputs,
    shared: draft.shared,
  }
  // The domains its test run read as: a schedule of someone else's that sends it reads within them.
  const authorDomains = access.domains
  ctx.emit({ type: 'report', part: reportPart(changeId, { id: reportId, ...kept }, action, 'current') })
  return {
    ...ok(tu, {
      saved: true,
      action,
      reportId,
      title: draft.title,
      shared: draft.shared,
      testRun: { inputs: values.values, period: days, sections: shown },
      note: `The person opens it from the card (Open report) or from My reports${draft.shared ? '; everyone given the assistant can open it, each over the data they may read' : ''}. Check the test run's rows are what was asked; if not, fix the report with save_report (report_id ${reportId}). Say in a few sentences what it shows and what to type in it.`,
    }),
    store: async (tx: Queryable) => {
      if (before) await changeReport(tx, reportId, ctx.userId, { ...kept, authorDomains })
      else
        await insertReport(tx, {
          id: reportId,
          userId: ctx.userId,
          conversationId: ctx.conversationId,
          turnId: null,
          question: draft.title,
          madeBy: 'assistant',
          authorDomains,
          ...kept,
        })
      await tx.query(`INSERT INTO ai_report_changes (id, report_id, conversation_id, turn_id, tool_use_id, user_id, action) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
        changeId,
        reportId,
        ctx.conversationId,
        ctx.turnId,
        tu.id,
        ctx.userId,
        action,
      ])
    },
  }
}

async function readReports(ctx: ReportToolContext, tu: ToolUse): Promise<ToolOutcome> {
  const input = isRecord(tu.input) ? tu.input : {}
  const id = typeof input.report_id === 'string' ? input.report_id.trim() : ''
  if (id) {
    const report = /^[0-9a-f-]{36}$/i.test(id) ? await findReport(ctx.db, id, ctx.userId) : null
    if (!report) return failed(tu, `No report ${id} that this person may open.`)
    return ok(tu, {
      id: report.id,
      title: report.title,
      description: report.description ?? report.question,
      shared: report.shared,
      mine: report.mine,
      madeBy: report.ownerName,
      period: report.adjustable ? report.period : null,
      inputs: report.inputs,
      sections: report.sections,
    })
  }
  const search = typeof input.search === 'string' && input.search.trim() ? input.search.trim() : null
  const { reports, hasMore } = await listReports(ctx.db, ctx.userId, { before: null, limit: 30, search })
  return ok(tu, {
    reports: reports.map((r) => ({ id: r.id, title: r.title, description: r.description ?? r.question, inputs: r.inputCount, sections: r.sectionCount, shared: r.shared, mine: r.mine, madeBy: r.ownerName })),
    more: hasMore,
  })
}

export function reportToolHandlers(ctx: ReportToolContext): Record<string, ToolHandler> {
  return {
    [SAVE_REPORT_TOOL_NAME]: { run: (tu, signal) => save(ctx, tu, signal) },
    [READ_REPORT_TOOL_NAME]: { run: (tu) => readReports(ctx, tu) },
  }
}
