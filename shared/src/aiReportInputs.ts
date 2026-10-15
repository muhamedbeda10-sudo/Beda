// ============================================================================
// §20 — what a person fills in when a report runs, besides its period: the
// orders to look at, a planning week, the orders to leave out, a machine.
// The assistant declares a report's inputs when it builds the report
// (save_report); each section's SQL names them as {{name}}, and every run
// fills them in from what the person typed, checked against the input's kind
// (server/src/ai/reportInputs.ts) — never as the person typed it.
//
//   • text: one word or phrase;            {{name}} is a text value
//   • list: several, typed apart by commas, spaces or lines;
//                                          {{name}} is a text[] (NULL when empty)
//   • number: a number;                    {{name}} is a numeric
//   • date: a day;                         {{name}} is a date
//   • choice: one of the values given;     {{name}} is a text value
//
// An input left empty is NULL in the SQL; a required one must be filled in.
// A default is the value the form starts from: one written out, or one of
// the moment the report runs (this week's number, this year, today).
// ============================================================================

export type AiReportInputKind = 'text' | 'list' | 'number' | 'date' | 'choice'
export const AI_REPORT_INPUT_KINDS: readonly AiReportInputKind[] = ['text', 'list', 'number', 'date', 'choice']

/** A default of the moment the report runs: this ISO week's number, this year, today. */
export type AiReportDynamicDefault = 'this_week' | 'this_year' | 'today'
export const AI_REPORT_DYNAMIC_DEFAULTS: readonly AiReportDynamicDefault[] = ['this_week', 'this_year', 'today']

export type AiReportInputValue = string | number | string[] | null

export interface AiReportInput {
  /** As the SQL names it, {{name}}: lowercase letters, digits and _. */
  name: string
  /** What the form calls it, in the person's language. */
  label: string
  kind: AiReportInputKind
  required: boolean
  /** A hint under the field: what to type ("20332, or 20332-Ph2.2 for one phase"). */
  help?: string
  /** The value the form starts from, written out. */
  default?: AiReportInputValue
  /** Or one of the moment it runs. */
  dynamicDefault?: AiReportDynamicDefault
  /** A choice's values. */
  choices?: string[]
}

/** The values of a run, by input name. */
export type AiReportInputValues = Record<string, AiReportInputValue>

/** Inputs a report takes at most; values a list takes at most; how long a value may be. */
export const AI_REPORT_MAX_INPUTS = 8
export const AI_REPORT_LIST_MAX = 100
export const AI_REPORT_VALUE_MAX = 100
export const AI_REPORT_CHOICES_MAX = 30
export const AI_REPORT_INPUT_NAME = /^[a-z][a-z0-9_]{0,30}$/
/** Names the period takes. */
export const AI_REPORT_RESERVED_INPUTS: readonly string[] = ['from', 'to']

/** The ISO week (Monday first) and its year of a day written YYYY-MM-DD. */
export function isoWeekOf(day: string): { week: number; year: number } {
  const [y, m, d] = day.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  // The Thursday of the same week decides its year and its number.
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7))
  const year = date.getUTCFullYear()
  const week = Math.ceil(((date.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7)
  return { week, year }
}

/** A default's value on `today` (a factory day, YYYY-MM-DD). */
export function dynamicDefaultValue(d: AiReportDynamicDefault, today: string): string | number {
  if (d === 'today') return today
  const iso = isoWeekOf(today)
  return d === 'this_week' ? iso.week : iso.year
}

/** The value an input starts from on `today`: its dynamic default, else its written one, else empty. */
export function inputDefault(input: AiReportInput, today: string): AiReportInputValue {
  if (input.dynamicDefault) {
    const v = dynamicDefaultValue(input.dynamicDefault, today)
    return input.kind === 'text' || input.kind === 'choice' ? String(v) : v
  }
  return input.default ?? (input.kind === 'list' ? [] : null)
}

/** A list as typed: split at commas, semicolons, spaces and line breaks; blanks dropped, each once, in order. */
export function splitList(typed: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of typed.split(/[,;،\s]+/)) {
    const v = part.trim()
    if (!v || seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/
const isDay = (s: string) => {
  const m = DAY.exec(s)
  if (!m) return false
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3])
}

/**
 * One input's value from what was sent or typed, checked against its kind: a number for a number, a real day for a
 * date, one of the choices for a choice, at most AI_REPORT_LIST_MAX values of at most AI_REPORT_VALUE_MAX characters
 * for a list. Empty is null (an empty list too). A problem names the input by its label.
 */
export function readInputValue(input: AiReportInput, raw: unknown): { value: AiReportInputValue } | { problem: string } {
  const empty = raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '') || (Array.isArray(raw) && raw.length === 0)
  if (empty) return input.required ? { problem: `${input.label}: required.` } : { value: null }
  switch (input.kind) {
    case 'list': {
      const parts = Array.isArray(raw) ? raw.flatMap((v) => (typeof v === 'string' || typeof v === 'number' ? splitList(String(v)) : [])) : typeof raw === 'string' || typeof raw === 'number' ? splitList(String(raw)) : null
      if (!parts) return { problem: `${input.label}: a list of values.` }
      const values = [...new Set(parts)]
      if (values.length === 0) return input.required ? { problem: `${input.label}: required.` } : { value: null }
      if (values.length > AI_REPORT_LIST_MAX) return { problem: `${input.label}: at most ${AI_REPORT_LIST_MAX} values.` }
      if (values.some((v) => v.length > AI_REPORT_VALUE_MAX)) return { problem: `${input.label}: each value at most ${AI_REPORT_VALUE_MAX} characters.` }
      return { value: values }
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN
      if (!Number.isFinite(n)) return { problem: `${input.label}: a number.` }
      return { value: n }
    }
    case 'date': {
      const s = typeof raw === 'string' ? raw.trim() : ''
      if (!isDay(s)) return { problem: `${input.label}: a day, YYYY-MM-DD.` }
      return { value: s }
    }
    case 'choice': {
      const s = typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim() : ''
      if (!(input.choices ?? []).includes(s)) return { problem: `${input.label}: one of ${(input.choices ?? []).join(', ')}.` }
      return { value: s }
    }
    case 'text': {
      if (typeof raw !== 'string' && typeof raw !== 'number') return { problem: `${input.label}: a text.` }
      const s = String(raw).trim()
      if (s.length > AI_REPORT_VALUE_MAX) return { problem: `${input.label}: at most ${AI_REPORT_VALUE_MAX} characters.` }
      return { value: s }
    }
  }
}

/**
 * Every input's value for a run: what was sent, else (when nothing was sent for it) its default on `today`. Every
 * problem at once.
 */
export function readInputValues(inputs: readonly AiReportInput[], sent: Record<string, unknown> | null | undefined, today: string): { values: AiReportInputValues } | { problems: string[] } {
  const values: AiReportInputValues = {}
  const problems: string[] = []
  for (const input of inputs) {
    const raw = sent && Object.prototype.hasOwnProperty.call(sent, input.name) ? sent[input.name] : inputDefault(input, today)
    const read = readInputValue(input, raw)
    if ('problem' in read) problems.push(read.problem)
    else values[input.name] = read.value
  }
  return problems.length > 0 ? { problems } : { values }
}

/** A value as a person reads it: a list joined with commas, nothing as —. */
export function inputValueText(value: AiReportInputValue): string {
  if (value === null || value === undefined) return '—'
  return Array.isArray(value) ? value.join(', ') : String(value)
}
