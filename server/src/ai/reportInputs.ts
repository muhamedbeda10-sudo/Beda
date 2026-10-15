// ============================================================================
// §20 — a report's inputs in its SQL (shared/aiReportInputs.ts). A section
// names an input as {{name}}, in code (never in a string, a comment or a
// quoted name), standing apart from the text around it, like the period's
// {{from}} and {{to}} (./reportTemplate). A run fills each with a typed
// literal built from the checked value — never the text as typed:
//
//   text, choice  →  (E'…'::text)        escaped by pg
//   list          →  (ARRAY[E'…', …]::text[]), or (NULL::text[]) when empty
//   number        →  (12.5::numeric)      a finite number only
//   date          →  (DATE '2026-10-15')  a real day only
//   empty         →  (NULL::<type>)
//
// so a value cannot be read as SQL, and the query still runs read-only, as
// the reader whose domains it was given.
// ============================================================================

import pg from 'pg'
import {
  AI_REPORT_CHOICES_MAX,
  AI_REPORT_DYNAMIC_DEFAULTS,
  AI_REPORT_INPUT_KINDS,
  AI_REPORT_INPUT_NAME,
  AI_REPORT_MAX_INPUTS,
  AI_REPORT_RESERVED_INPUTS,
  AI_REPORT_VALUE_MAX,
  readInputValue,
  type AiReportDynamicDefault,
  type AiReportInput,
  type AiReportInputKind,
  type AiReportInputValues,
} from '@qc/shared/aiReportInputs'
import { codeOnly } from './runQuery'

/** Every {{word}} in a text, wherever it stands. */
const ANY_PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g
/** A character a placeholder may not touch: it would join a name, a number, a quoted string or name, or another placeholder. */
const STICKY = /[A-Za-z0-9_$.'"\\{}\u0080-\uFFFF]/

const LABEL_MAX = 60
const HELP_MAX = 200

/** The inputs the assistant declared, checked; or every problem with them. */
export function readInputDefinitions(raw: unknown): { inputs: AiReportInput[] } | { problems: string[] } {
  if (raw === undefined || raw === null) return { inputs: [] }
  if (!Array.isArray(raw)) return { problems: ['inputs: a list.'] }
  const problems: string[] = []
  if (raw.length > AI_REPORT_MAX_INPUTS) problems.push(`inputs: at most ${AI_REPORT_MAX_INPUTS}.`)
  const inputs: AiReportInput[] = []
  const names = new Set<string>()
  raw.slice(0, AI_REPORT_MAX_INPUTS).forEach((r, i) => {
    const at = `inputs[${i}]`
    if (!r || typeof r !== 'object') {
      problems.push(`${at}: an object.`)
      return
    }
    const o = r as Record<string, unknown>
    const name = typeof o.name === 'string' ? o.name.trim() : ''
    if (!AI_REPORT_INPUT_NAME.test(name)) problems.push(`${at}.name: lowercase letters, digits and _, starting with a letter (it is {{name}} in the SQL).`)
    else if (AI_REPORT_RESERVED_INPUTS.includes(name)) problems.push(`${at}.name: "${name}" is the period's; name the input otherwise.`)
    else if (names.has(name)) problems.push(`${at}.name: "${name}" is given twice.`)
    names.add(name)
    const label = typeof o.label === 'string' ? o.label.replace(/\s+/g, ' ').trim() : ''
    if (!label || label.length > LABEL_MAX) problems.push(`${at}.label: 1 to ${LABEL_MAX} characters.`)
    const kind = AI_REPORT_INPUT_KINDS.includes(o.kind as AiReportInputKind) ? (o.kind as AiReportInputKind) : null
    if (!kind) problems.push(`${at}.kind: one of ${AI_REPORT_INPUT_KINDS.join(', ')}.`)
    const input: AiReportInput = { name, label, kind: kind ?? 'text', required: o.required === true }
    if (typeof o.help === 'string' && o.help.trim()) {
      if (o.help.trim().length > HELP_MAX) problems.push(`${at}.help: at most ${HELP_MAX} characters.`)
      input.help = o.help.trim()
    }
    if (kind === 'choice') {
      const choices = Array.isArray(o.choices) ? o.choices.filter((c): c is string => typeof c === 'string' && c.trim() !== '').map((c) => c.trim()) : []
      if (choices.length < 2 || choices.length > AI_REPORT_CHOICES_MAX) problems.push(`${at}.choices: 2 to ${AI_REPORT_CHOICES_MAX} values.`)
      if (choices.some((c) => c.length > AI_REPORT_VALUE_MAX)) problems.push(`${at}.choices: each at most ${AI_REPORT_VALUE_MAX} characters.`)
      input.choices = [...new Set(choices)]
    } else if (o.choices !== undefined && o.choices !== null) problems.push(`${at}.choices: only a choice takes them.`)
    if (o.dynamic_default !== undefined && o.dynamic_default !== null) {
      const d = o.dynamic_default as AiReportDynamicDefault
      if (!AI_REPORT_DYNAMIC_DEFAULTS.includes(d)) problems.push(`${at}.dynamic_default: one of ${AI_REPORT_DYNAMIC_DEFAULTS.join(', ')}.`)
      else if ((d === 'today') !== (kind === 'date') && kind !== 'text') problems.push(`${at}.dynamic_default: ${d === 'today' ? 'today is a date' : `${d} is a number`}.`)
      else input.dynamicDefault = d
    }
    if (o.default !== undefined && o.default !== null && kind) {
      const read = readInputValue({ ...input, required: false }, o.default)
      if ('problem' in read) problems.push(`${at}.default: ${read.problem.replace(/^[^:]*: /, '')}`)
      else if (read.value !== null) input.default = read.value
    }
    inputs.push(input)
  })
  return problems.length > 0 ? { problems } : { inputs }
}

/**
 * The inputs a section's SQL names, and every problem with how it names them: a name the report has no input for, a
 * placeholder in a string, a comment or a quoted name, one joined to the text beside it. {{from}} and {{to}} are
 * the period's, allowed when the report has one.
 */
export function placeholderProblems(sql: string, inputs: readonly AiReportInput[], hasPeriod: boolean): { used: string[]; problems: string[] } {
  const problems: string[] = []
  const used = new Set<string>()
  const known = new Set(inputs.map((i) => i.name))
  const all = [...sql.matchAll(ANY_PLACEHOLDER)]
  const rest = sql.replace(ANY_PLACEHOLDER, '')
  if (rest.includes('{{') || rest.includes('}}')) problems.push('it holds {{ or }} that is no placeholder: write each as {{name}}.')
  if ([...codeOnly(sql).matchAll(ANY_PLACEHOLDER)].length !== all.length) problems.push('a placeholder is inside a quoted string, a comment or a quoted name: write it as code, {{name}} alone, never in quotes.')
  for (const m of all) {
    const name = m[1]
    if (m[0] !== `{{${name}}}`) problems.push(`write {{${name}}} with no spaces inside the braces.`)
    if ((name === 'from' || name === 'to') && !hasPeriod) problems.push(`{{${name}}} is the period's, and this report has no period: give it one, or use a date input.`)
    else if (name !== 'from' && name !== 'to' && !known.has(name)) problems.push(`{{${name}}} names no input of the report (${[...known].join(', ') || 'it has none'}).`)
    else used.add(name)
    const before = m.index > 0 ? sql[m.index - 1] : ''
    const after = sql[m.index + m[0].length] ?? ''
    if ((before && STICKY.test(before)) || (after && STICKY.test(after))) problems.push(`{{${name}}} is joined to the text beside it: leave a space or a bracket around it.`)
  }
  return { used: [...used], problems: [...new Set(problems)] }
}

const SQL_TYPE: Record<AiReportInputKind, string> = { text: 'text', choice: 'text', list: 'text[]', number: 'numeric', date: 'date' }

/** One value as a typed SQL literal; throws for anything its kind does not take (the values are checked before). */
export function inputLiteral(kind: AiReportInputKind, value: AiReportInputValues[string]): string {
  if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) return `(NULL::${SQL_TYPE[kind]})`
  switch (kind) {
    case 'list':
      if (!Array.isArray(value)) throw new Error('A list input takes a list.')
      return `(ARRAY[${value.map((v) => pg.escapeLiteral(String(v))).join(', ')}]::text[])`
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('A number input takes a number.')
      return `(${String(value)}::numeric)`
    case 'date':
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('A date input takes a day.')
      return `(DATE '${value}')`
    case 'text':
    case 'choice':
      return `(${pg.escapeLiteral(String(value))}::text)`
  }
}

/** A section's SQL with every input filled in from a run's values; {{from}} and {{to}} are left for the period. */
export function fillInputs(sql: string, inputs: readonly AiReportInput[], values: AiReportInputValues): string {
  const byName = new Map(inputs.map((i) => [i.name, i]))
  return sql.replace(ANY_PLACEHOLDER, (whole, name: string) => {
    const input = byName.get(name)
    if (!input) return whole
    return inputLiteral(input.kind, values[name] ?? null)
  })
}
