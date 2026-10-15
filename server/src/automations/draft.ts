// ============================================================================
// §21 — an automation as the assistant writes it (AutomationDraft), and the
// changes a person makes outside the chat (AutomationEdits). The tool's input
// schema below guides the model; it is not strict, and with eager input
// streaming the API does not check it, so the same shape is read here with zod,
// leniently where the model's habits are harmless (null for a field left
// out) and strictly everywhere else. What a draft means — that its queries
// run, its columns exist, its people are real — is validate.ts's to check.
// ============================================================================

import { z } from 'zod'
import { CHART_INPUT_SCHEMA } from '../ai/charts'
import { ROLES } from '@qc/shared/types'
import type { AiReportPeriod } from '@qc/shared/ai'
import type { AiReportInputValues } from '@qc/shared/aiReportInputs'
import type {
  AutomationActions,
  AutomationDraft,
  AutomationRecipient,
  AutomationScheduleSpec,
  AutomationWatchSpec,
  AutomationWeekday,
} from '@qc/shared/automation'
import { PERIOD_KINDS, WEEK_STARTS, toPeriod } from '../ai/reports'

// ---- The tool's input schema --------------------------------------------------------

const PERIOD_INPUT_SCHEMA = {
  type: 'object',
  description:
    'The days the sections cover, counted from the factory day the report runs on. kind: today, yesterday, last_days (with days), this_week or last_week (with weekStart: saturday, sunday or monday), this_month, last_month, this_year, last_year, or fixed (with from and to, YYYY-MM-DD).',
  properties: {
    kind: { type: 'string', enum: [...PERIOD_KINDS] },
    days: { type: 'integer', description: 'last_days only: how many days, today included.' },
    from: { type: 'string', description: 'fixed only: the first day, YYYY-MM-DD.' },
    to: { type: 'string', description: 'fixed only: the last day, YYYY-MM-DD.' },
    weekStart: { type: 'string', enum: [...WEEK_STARTS], description: 'this_week and last_week only.' },
  },
  required: ['kind'],
  additionalProperties: false,
}

const USER_SCHEMA = (what: string) => ({
  type: 'object',
  properties: { kind: { type: 'string', enum: ['user'] }, userId: { type: 'string', description: `The ${what}'s user id (a uuid).` } },
  required: ['kind', 'userId'],
  additionalProperties: false,
})

const COLUMN_SCHEMA = (what: string) => ({
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['column'] },
    column: { type: 'string', description: `A column of the watch's result holding user ids: the ${what} of each case.` },
  },
  required: ['kind', 'column'],
  additionalProperties: false,
})

/**
 * propose_automation's input: an AutomationDraft, after the person's words of
 * agreement (§22: confirmation, first, so the model quotes them before it
 * writes the draft; the draft never keeps them). The schema guides the model
 * but is not strict (see tools.ts); the reader below and validate.ts hold the
 * draft to its shape, lengths, ranges and counts, and confirmation.ts the
 * confirmation to the person's message.
 */
export const DRAFT_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    confirmation: {
      type: 'string',
      description:
        "The person's words of agreement to the plan you described, copied exactly as they wrote them in their latest message (for example \"yes, go ahead\", or the change they asked for, such as \"make it 20%\"). " +
        'Call this tool only after you described the plan in words and the person agreed in a later message.',
    },
    kind: { type: 'string', enum: ['watch', 'report'], description: 'watch: tell people about new cases as they appear. report: a scheduled report.' },
    name: { type: 'string', description: "A short name, in the person's language." },
    description: { type: 'string', description: "In plain words, in the person's language: what it watches or reports, and what it does." },
    language: { type: 'string', enum: ['ar', 'en'], description: 'The language the person wrote in: the name, templates and summaries are in it.' },
    watch: {
      type: 'object',
      description: 'kind watch only.',
      properties: {
        sql: { type: 'string', description: 'One SELECT over ai.* views returning one row per case that needs attention now.' },
        keyColumn: { type: 'string', description: 'The result column whose value names a case: unique per row, never empty, the same for that case on every run.' },
        everyMinutes: { type: 'integer', description: 'How often it runs, in minutes: 5 to 1440 (within its hours, when it has them).' },
        hours: {
          type: 'object',
          description:
            'Optional. The hours of the factory day it runs in; left out, it runs around the clock. A to at or before from crosses midnight (22:00 to 06:00 is the night, counted as the day it starts on).',
          properties: {
            from: { type: 'string', description: 'HH:MM, 24-hour, factory time: the first minute it runs.' },
            to: { type: 'string', description: 'HH:MM, 24-hour, factory time: the minute it stops (not included).' },
          },
          required: ['from', 'to'],
          additionalProperties: false,
        },
        weekdays: { type: 'array', items: { type: 'integer' }, description: 'Optional: the days it runs, 0 = Sunday ... 6 = Saturday. Left out: every day.' },
        titleTemplate: { type: 'string', description: 'The message title, with {{column}} placeholders filled from the case.' },
        bodyTemplate: { type: 'string', description: 'Optional. A line or two more, with {{column}} placeholders.' },
        sessionColumn: { type: 'string', description: "Optional. The column holding the case's inspection session id." },
        sampleColumn: { type: 'string', description: "Optional. The column holding the case's sample id." },
        orderColumn: { type: 'string', description: "Optional. The column holding the case's order number." },
      },
      required: ['sql', 'keyColumn', 'everyMinutes', 'titleTemplate'],
      additionalProperties: false,
    },
    schedule: {
      type: 'object',
      description: 'kind report only.',
      properties: {
        cadence: { type: 'string', enum: ['daily', 'weekly', 'monthly'] },
        time: { type: 'string', description: 'HH:MM, 24-hour, factory time.' },
        weekdays: { type: 'array', items: { type: 'integer' }, description: 'daily only, optional: the days it runs, 0 = Sunday ... 6 = Saturday. Left out: every day.' },
        weekday: { type: 'integer', description: 'weekly only: the day it runs, 0 = Sunday ... 6 = Saturday.' },
        monthDay: { type: 'integer', description: 'monthly only: the day of the month it runs, 1 to 28.' },
        period: PERIOD_INPUT_SCHEMA,
        sections: {
          type: 'array',
          description: '1 to 8 sections, each a titled query. With a period, a query takes its days as {{from}} and {{to}}. Leave out when it sends a saved report (report).',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: "The section's title, in the person's language." },
              sql: { type: 'string', description: 'One SELECT over ai.* views.' },
              chart: { ...CHART_INPUT_SCHEMA, description: 'Optional. Draws the section\'s result as a chart in the delivered report, as run_sql\'s chart does (see "Charts").' },
            },
            required: ['title', 'sql'],
            additionalProperties: false,
          },
        },
        report: {
          type: 'object',
          description:
            "Instead of sections: one of the saved reports this person may open (read_report lists them, with each one's inputs), sent as it stands at each run — a change to the report reaches the next delivery. Its sections, figures, trees and charts go out as they show in My reports.",
          properties: {
            reportId: { type: 'string', description: "The saved report's id, from read_report." },
            inputs: {
              type: 'object',
              description:
                'The values its inputs take on every run, by input name, as the report asks for them (a list as a list of texts, a number as a number, a date as YYYY-MM-DD). Leave an input out to take its default on the day of each run (this week, this year, today). {} when every input takes its default.',
            },
          },
          required: ['reportId', 'inputs'],
          additionalProperties: false,
        },
        summary: { type: 'boolean', description: 'Write a short summary on top of the report each time it runs.' },
      },
      required: ['cadence', 'time', 'summary'],
      additionalProperties: false,
    },
    recipients: {
      type: 'array',
      description: 'Who is told: people by user id, every active account of a role, or (a watch) the people a column of the result names.',
      items: {
        anyOf: [
          USER_SCHEMA('person'),
          {
            type: 'object',
            properties: { kind: { type: 'string', enum: ['role'] }, role: { type: 'string', enum: [...ROLES] } },
            required: ['kind', 'role'],
            additionalProperties: false,
          },
          COLUMN_SCHEMA('person to tell'),
        ],
      },
    },
    channels: {
      type: 'object',
      description: "Where they are told: the app's bell, the chat, or both.",
      properties: { bell: { type: 'boolean' }, chat: { type: 'boolean' } },
      required: ['bell', 'chat'],
      additionalProperties: false,
    },
    actions: {
      type: 'object',
      description: 'What a watch does with each new case. A report: notify true, followUp null.',
      properties: {
        notify: { type: 'boolean', description: 'Tell the recipients.' },
        followUp: {
          anyOf: [
            {
              type: 'object',
              description: 'Open a follow-up for each new case, with an assignee and a deadline.',
              properties: {
                assignee: {
                  anyOf: [
                    USER_SCHEMA('assignee'),
                    COLUMN_SCHEMA('assignee'),
                    { type: 'object', properties: { kind: { type: 'string', enum: ['creator'] } }, required: ['kind'], additionalProperties: false },
                  ],
                },
                dueHours: { type: 'integer', description: 'The deadline, in hours from the case: 1 to 720.' },
              },
              required: ['assignee', 'dueHours'],
              additionalProperties: false,
            },
            { type: 'null' },
          ],
        },
      },
      required: ['notify', 'followUp'],
      additionalProperties: false,
    },
    replacesAutomationId: { type: 'string', description: 'Optional. The id of one of the person\'s automations (from my_automations) that this proposal changes.' },
    revisesProposalId: {
      type: 'string',
      description:
        "Optional. The proposalId (from its propose_automation result) of an earlier proposal of this conversation that this one is a new version of: its card is marked as replaced by this one. Keep that proposal's replacesAutomationId. If it was activated, this is proposed as a change of the automation it became.",
    },
  },
  required: ['confirmation', 'kind', 'name', 'description', 'language', 'recipients', 'channels', 'actions'],
  additionalProperties: false,
}

// ---- Reading it back ------------------------------------------------------------------

/** A field the model may leave out or send as null. */
const optional = <T extends z.ZodTypeAny>(schema: T) => schema.nullish().transform((v) => v ?? undefined)

const recipientInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), userId: z.string() }).strict(),
  z.object({ kind: z.literal('role'), role: z.enum(ROLES as [string, ...string[]]) }).strict(),
  z.object({ kind: z.literal('column'), column: z.string() }).strict(),
])

const assigneeInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), userId: z.string() }).strict(),
  z.object({ kind: z.literal('column'), column: z.string() }).strict(),
  z.object({ kind: z.literal('creator') }).strict(),
])

const periodInput = z
  .object({
    kind: z.enum(PERIOD_KINDS),
    days: z.number().int().nullish(),
    from: z.string().nullish(),
    to: z.string().nullish(),
    weekStart: z.enum(WEEK_STARTS).nullish(),
  })
  .strict()

const hoursInput = z.object({ from: z.string(), to: z.string() }).strict()

const watchInput = z
  .object({
    sql: z.string(),
    keyColumn: z.string(),
    everyMinutes: z.number().int(),
    hours: optional(hoursInput),
    weekdays: optional(z.array(z.number().int())),
    titleTemplate: z.string(),
    bodyTemplate: optional(z.string()),
    sessionColumn: optional(z.string()),
    sampleColumn: optional(z.string()),
    orderColumn: optional(z.string()),
  })
  .strict()

const scheduleInput = z
  .object({
    cadence: z.enum(['daily', 'weekly', 'monthly']),
    time: z.string(),
    weekdays: optional(z.array(z.number().int())),
    weekday: optional(z.number().int()),
    monthDay: optional(z.number().int()),
    period: optional(periodInput),
    sections: optional(z.array(z.object({ title: z.string(), sql: z.string(), chart: optional(z.unknown()) }).strict())),
    // Its values are read against the report's inputs when the draft is checked (savedReport.checkLinkedReport).
    report: optional(z.object({ reportId: z.string(), inputs: z.record(z.string(), z.unknown()) }).strict()),
    summary: z.boolean(),
  })
  .strict()

const actionsInput = z
  .object({
    notify: z.boolean(),
    followUp: z.object({ assignee: assigneeInput, dueHours: z.number().int() }).strict().nullable(),
  })
  .strict()

const channelsInput = z.object({ bell: z.boolean(), chat: z.boolean() }).strict()

export const DraftInput = z
  .object({
    // Read on its own (readConfirmation) and checked before the draft is: never part of it. Optional here, as a
    // conversation begun before §22 was given a tool that asks for none.
    confirmation: optional(z.string()),
    kind: z.enum(['watch', 'report']),
    name: z.string(),
    description: z.string(),
    language: z.enum(['ar', 'en']),
    watch: optional(watchInput),
    schedule: optional(scheduleInput),
    recipients: z.array(recipientInput),
    channels: channelsInput,
    actions: actionsInput,
    replacesAutomationId: optional(z.string()),
    revisesProposalId: optional(z.string()),
  })
  .strict()

/**
 * The person's words of agreement the model passed with its call (§22), or
 * null when it passed none: read whatever the draft's own shape, so a call
 * without them is refused before the draft is looked at.
 */
export function readConfirmation(input: unknown): string | null {
  const parsed = z.object({ confirmation: z.string() }).passthrough().safeParse(input)
  return parsed.success ? parsed.data.confirmation : null
}

/** zod's complaints, one line each, naming where: what the model reads to fix its call. */
export function describeIssues(error: z.ZodError, prefix = ''): string[] {
  return error.issues.map((i) => {
    const where = [prefix, ...i.path.map(String)].filter(Boolean).join('.')
    return where ? `${where}: ${i.message}` : i.message
  })
}

/**
 * What the model wrote, read as a draft; or what is wrong with its shape. The
 * period is resolved to the shared type. The confirmation is not the draft's:
 * it is left out of it.
 */
export function readDraft(input: unknown): { draft: AutomationDraft } | { errors: string[] } {
  const parsed = DraftInput.safeParse(input)
  if (!parsed.success) return { errors: describeIssues(parsed.error) }
  const d = parsed.data
  const errors: string[] = []
  const draft: AutomationDraft = {
    kind: d.kind,
    name: d.name,
    description: d.description,
    language: d.language,
    recipients: d.recipients as AutomationRecipient[],
    channels: d.channels,
    actions: d.actions as AutomationActions,
  }
  if (d.watch) draft.watch = stripUndefined(d.watch) as AutomationWatchSpec
  if (d.schedule) {
    const { period, ...rest } = d.schedule
    const schedule = stripUndefined(rest) as Omit<AutomationScheduleSpec, 'weekdays' | 'weekday'> & { weekdays?: number[]; weekday?: number }
    let resolved: AiReportPeriod | null = null
    if (period) {
      resolved = toPeriod(period)
      if (!resolved) errors.push(`schedule.period: ${JSON.stringify(period)} is not a period a report can have (last_days needs days 1 to 3660; fixed needs from and to, YYYY-MM-DD, in order).`)
    }
    draft.schedule = { ...(schedule as AutomationScheduleSpec), sections: (schedule.sections ?? []) as AutomationScheduleSpec['sections'], ...(resolved ? { period: resolved } : {}) }
  }
  if (d.replacesAutomationId) draft.replacesAutomationId = d.replacesAutomationId
  if (d.revisesProposalId) draft.revisesProposalId = d.revisesProposalId
  return errors.length > 0 ? { errors } : { draft }
}

/** An object without its undefined fields: what is stored and replayed reads the same however it was built. */
function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
}

// ---- Changes outside the chat ---------------------------------------------------------

const weekday = z.number().int().min(0, 'A weekday is 0 (Sunday) to 6 (Saturday).').max(6, 'A weekday is 0 (Sunday) to 6 (Saturday).')

/**
 * AutomationEdits as a request carries them; a period may come as the model
 * writes one (unused fields null). The queries are not among them: they
 * change only through the assistant.
 */
export const EditsInput = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    recipients: z.array(recipientInput).optional(),
    channels: channelsInput.optional(),
    actions: actionsInput.optional(),
    everyMinutes: z.number().int().optional(),
    hours: hoursInput.nullable().optional(),
    cadence: z.enum(['daily', 'weekly', 'monthly']).optional(),
    time: z.string().optional(),
    weekdays: z.array(weekday).nullable().optional(),
    weekday: weekday.nullable().optional(),
    monthDay: z.number().int().nullable().optional(),
    period: periodInput.nullable().optional(),
    summary: z.boolean().optional(),
    reportInputs: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

export type EditsInputType = z.infer<typeof EditsInput>

/**
 * A definition with a person's changes on top: the result is a draft again,
 * for the same checks a proposal gets. A change that does not fit the kind
 * (an interval for a report, a cadence for a watch) is an error, not silently
 * dropped; the days (weekdays) belong to a watch and to a daily report alike.
 */
export function applyEdits(draft: AutomationDraft, edits: EditsInputType): { draft: AutomationDraft } | { errors: string[] } {
  const errors: string[] = []
  const next: AutomationDraft = structuredClone(draft)
  if (edits.name !== undefined) next.name = edits.name
  if (edits.description !== undefined) next.description = edits.description
  if (edits.recipients !== undefined) next.recipients = edits.recipients as AutomationRecipient[]
  if (edits.channels !== undefined) next.channels = edits.channels
  if (edits.actions !== undefined) next.actions = edits.actions as AutomationActions
  const scheduleEdits = ['cadence', 'time', 'weekday', 'monthDay', 'period', 'summary', 'reportInputs'] as const
  if (next.kind === 'watch') {
    const w = next.watch
    if (w) {
      if (edits.everyMinutes !== undefined) w.everyMinutes = edits.everyMinutes
      if (edits.hours !== undefined) {
        if (edits.hours === null) delete w.hours
        else w.hours = edits.hours
      }
      if (edits.weekdays !== undefined) {
        if (edits.weekdays === null) delete w.weekdays
        else w.weekdays = edits.weekdays as AutomationWeekday[]
      }
    }
    for (const k of scheduleEdits) if (edits[k] !== undefined) errors.push(`${k}: only a scheduled report has one; this is a watch.`)
  } else if (next.schedule) {
    if (edits.everyMinutes !== undefined) errors.push('everyMinutes: only a watch has an interval; this is a scheduled report.')
    if (edits.hours !== undefined) errors.push('hours: only a watch has hours it runs in; this is a scheduled report, which runs at its time.')
    const s: AutomationScheduleSpec = next.schedule
    if (edits.cadence !== undefined) s.cadence = edits.cadence
    if (edits.time !== undefined) s.time = edits.time
    if (edits.weekdays !== undefined) setOrDrop(s, 'weekdays', edits.weekdays as AutomationWeekday[] | null)
    if (edits.weekday !== undefined) setOrDrop(s, 'weekday', edits.weekday as AutomationWeekday | null)
    if (edits.monthDay !== undefined) setOrDrop(s, 'monthDay', edits.monthDay)
    if (edits.summary !== undefined) s.summary = edits.summary
    if (edits.reportInputs !== undefined) {
      // Checked against the report's inputs with the rest of the draft (savedReport.checkLinkedReport).
      if (s.report) s.report = { ...s.report, inputs: edits.reportInputs as AiReportInputValues }
      else errors.push('reportInputs: only a schedule that sends a saved report has inputs; this one has sections of its own.')
    }
    if (edits.period !== undefined) {
      if (edits.period === null) delete s.period
      else {
        const period = toPeriod(edits.period)
        if (period) s.period = period
        else errors.push(`period: ${JSON.stringify(edits.period)} is not a period a report can have.`)
      }
    }
    // A change of cadence takes the fields the old one used away with it, unless they were given anew.
    if (edits.cadence !== undefined) {
      if (s.cadence !== 'daily' && edits.weekdays === undefined) delete s.weekdays
      if (s.cadence !== 'weekly' && edits.weekday === undefined) delete s.weekday
      if (s.cadence !== 'monthly' && edits.monthDay === undefined) delete s.monthDay
    }
  }
  return errors.length > 0 ? { errors } : { draft: next }
}

function setOrDrop<K extends 'weekdays' | 'weekday' | 'monthDay'>(s: AutomationScheduleSpec, key: K, value: AutomationScheduleSpec[K] | null): void {
  if (value === null) delete s[key]
  else s[key] = value
}
