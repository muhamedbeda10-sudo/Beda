// ============================================================================
// §20 — what a request to run a saved report asks for: other days than its
// own (both or neither, real calendar days) and the values of its inputs (one
// JSON object in the query string), checked against the report as it is now.
// The same for its maker's run from My reports and for a run by someone it is
// shared with (./reportShares): the same days, the same values, the same
// refusals.
// ============================================================================

import { z } from 'zod'
import { isAiDay, type AiDayRange, type AiReport } from '@qc/shared/ai'
import { readInputValues, type AiReportInputValues } from '@qc/shared/aiReportInputs'
import { badRequest } from '../lib/errors'
import { parse } from '../lib/validate'
import { factoryDay } from './prompt'
import { runPeriod, type RunPeriod } from './reports'
import { rangeProblem } from './reportTemplate'

/**
 * The days a person runs a report over, both or neither. Only real calendar
 * days in YYYY-MM-DD pass: they become SQL date literals.
 */
const reportDay = z.string().refine(isAiDay, 'A day is YYYY-MM-DD, and a real date.')

/** A run's input values, as the query string carries them: one JSON object, by input name (checked against the report's inputs). */
const reportInputsQuery = z.object({
  inputs: z
    .string()
    .max(8_000)
    .optional()
    .transform((v, issue) => {
      if (v === undefined || v === '') return null
      try {
        const parsed: unknown = JSON.parse(v)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
      } catch {
        /* told below */
      }
      issue.addIssue({ code: z.ZodIssueCode.custom, message: 'inputs: a JSON object of the values, by input name.' })
      return z.NEVER
    }),
})

const reportRunQuery = z
  .object({ from: reportDay.optional(), to: reportDay.optional() })
  .superRefine((v, issue) => {
    if ((v.from === undefined) !== (v.to === undefined)) {
      issue.addIssue({ code: z.ZodIssueCode.custom, message: 'Give both the first and the last day, or neither.' })
      return
    }
    const problem = v.from && v.to ? rangeProblem({ from: v.from, to: v.to }) : null
    if (problem) issue.addIssue({ code: z.ZodIssueCode.custom, message: problem })
  })
  .transform((v) => (v.from && v.to ? { from: v.from, to: v.to } : null))

export interface RunRequest {
  /** Other days than the report's own; null runs its own. */
  range: AiDayRange | null
  /** What was typed into its inputs, not yet checked against them; null for nothing typed. */
  typed: Record<string, unknown> | null
}

/** A run's request as the query string carries it, its shape checked (400 otherwise). */
export function readRunRequest(query: Record<string, unknown>): RunRequest {
  const { inputs: sent, ...days } = query
  const range = parse(reportRunQuery, days)
  const { inputs: typed } = parse(reportInputsQuery, { inputs: sent })
  return { range, typed }
}

/**
 * The days and values a run of `report` takes, as of now where the factory sits: a person asking for days a report
 * with fixed days cannot take is told so, and a value is checked against its input's kind (what was left alone takes
 * its default as of today). Throws 400 with every problem.
 */
export function runOf(report: Pick<AiReport, 'adjustable' | 'period' | 'inputs'>, request: RunRequest, timeZone: string): { period: RunPeriod | null; values: AiReportInputValues } {
  if (request.range && !report.adjustable) throw badRequest("This report's period cannot be changed: it runs over the days its queries name.")
  const today = factoryDay(new Date(), timeZone)
  const read = readInputValues(report.inputs, request.typed, today)
  if ('problems' in read) throw badRequest(read.problems.join(' '))
  // Today where the factory sits, at the moment of the run: "the last 30 days" ends today.
  return { period: runPeriod(report, request.range, today), values: read.values }
}
