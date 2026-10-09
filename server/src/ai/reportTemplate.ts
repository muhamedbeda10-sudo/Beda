// ============================================================================
// §20 — a saved report's period, made changeable. A report keeps each query of
// the answer as a template in which the period's first and last factory days
// are the placeholders {{from}} and {{to}}; only the API fills them, with
// DATE 'YYYY-MM-DD' literals built from days already checked to be real
// calendar days. Nothing a person types ever reaches the SQL as text.
//
// The template comes from the model, so it is held to a narrow form before it
// is kept: no placeholder but those two, each standing on its own in the code
// (never inside a quoted string, a comment or a quoted name, never glued to a
// name or a number). It must also take its days from the period and from
// nothing else: both placeholders, the data held between a lower and an upper
// bound made of them, no placeholder compared with constants only, and no day
// of its own left over (a date written out, a day made from numbers, the
// clock). One run at the question's period cannot see those faults when the
// data happens to agree, so they are read from the text. Whether the template
// still means what the answer meant is then checked by running it (see
// reports.ts); the runner's own checks and the read-only sandbox apply to the
// filled SQL as to any other.
// ============================================================================

import { AI_REPORT_MAX_DAYS, isAiDay, type AiCell, type AiDayRange } from '@qc/shared/ai'
import { codeOnly } from './runQuery'

/** The two placeholders, the only ones a template may hold. */
const PLACEHOLDERS = /\{\{(from|to)\}\}/g
/** A character a placeholder may not touch: it would join a name, a number, a quoted string or name, or another placeholder. */
const STICKY = /[A-Za-z0-9_$.'"\\{}\u0080-\uFFFF]/

export type TemplateCheck =
  /** Usable as it is; `placeholders` says how many it holds (0: a query with no period). */
  | { ok: true; placeholders: number }
  | { ok: false; reason: string }

/** Whether a template the model wrote may be kept, and how many placeholders it holds. */
export function checkTemplate(template: string): TemplateCheck {
  const found = [...template.matchAll(PLACEHOLDERS)]
  const rest = template.replace(PLACEHOLDERS, '')
  if (rest.includes('{{') || rest.includes('}}')) return { ok: false, reason: 'it holds a placeholder other than {{from}} and {{to}}' }
  if (found.length === 0) return { ok: true, placeholders: 0 }
  // The code alone, strings, comments and quoted names blanked: a placeholder in them is gone from it.
  if ([...codeOnly(template).matchAll(PLACEHOLDERS)].length !== found.length) {
    return { ok: false, reason: 'a placeholder is inside a quoted string, a comment or a quoted name' }
  }
  for (const m of found) {
    const before = m.index > 0 ? template[m.index - 1] : ''
    const after = template[m.index + m[0].length] ?? ''
    if ((before && STICKY.test(before)) || (after && STICKY.test(after))) {
      return { ok: false, reason: 'a placeholder is joined to the text next to it' }
    }
  }
  return { ok: true, placeholders: found.length }
}

/** A day range as the SQL of one run sees it; throws for anything but two real days in order. */
export function fillTemplate(template: string, range: AiDayRange): string {
  // Checked again here, where the text is made: whatever a caller passes, only YYYY-MM-DD reaches the SQL.
  if (!isAiDay(range.from) || !isAiDay(range.to) || range.from > range.to) throw new Error(`Not a day range: ${range.from}..${range.to}`)
  return template.replace(PLACEHOLDERS, (_, which: 'from' | 'to') => `DATE '${range[which]}'`)
}

// ---- Whether a query takes its days from the period alone -------------------------------

/** A day or a month written out, anywhere in the text: '2026-09-01', '2026-09' (a closed_month), 01/09/2026. */
const WRITTEN_DAY = /(?<!\d)(?:1[89]|2\d)\d{2}-(?:0[1-9]|1[0-2])(?!\d)|(?<![\d/.-])\d{1,2}[/.-]\d{1,2}[/.-]\d{4}(?!\d)/
/** The clock, by any of its names in the code: the moment the query runs. */
const CLOCK =
  /\bnow\s*\(|\b(?:current_date|current_timestamp|current_time|localtimestamp|localtime)\b|\b(?:transaction_timestamp|statement_timestamp|clock_timestamp|timeofday)\s*\(/i
/** The clock in a string PostgreSQL reads as a moment ('now', 'today', …), wherever it stands. */
const CLOCK_WORD = /'\s*(?:now|today|yesterday|tomorrow)\s*'/i
/** A day made from numbers or text. */
const MADE_DAY = /\b(?:make_date|make_timestamp|make_timestamptz|to_date|to_timestamp)\s*\(/i

/** Whether a query counts from the moment it runs: now(), current_date, 'today' and the like. */
export function readsClock(sql: string): boolean {
  return CLOCK.test(codeOnly(sql)) || CLOCK_WORD.test(sql)
}

/**
 * What in a query fixes days of its own, other than {{from}} and {{to}}; null
 * when nothing does. Read from the whole text, comments included: a day
 * mentioned where none is needed only keeps a report's period fixed.
 */
export function ownDays(sql: string): string | null {
  if (readsClock(sql)) return 'it reads the clock'
  if (WRITTEN_DAY.test(sql)) return 'it names a day'
  if (MADE_DAY.test(codeOnly(sql))) return 'it makes a day from numbers or text'
  return null
}

const COMPARISONS = new Set(['=', '<', '>', '<=', '>=', '<>', '!='])
/** Words that end an operand: the clauses and connectives around a comparison. */
const STOP_WORDS = new Set([
  'and', 'or', 'not', 'where', 'on', 'having', 'when', 'then', 'else', 'end', 'case', 'select', 'from', 'is', 'in', 'like', 'ilike',
  'similar', 'between', 'symmetric', 'by', 'join', 'left', 'right', 'full', 'inner', 'outer', 'cross', 'natural', 'using', 'limit',
  'offset', 'as', 'group', 'order', 'union', 'intersect', 'except', 'filter', 'over', 'partition', 'distinct', 'returning', 'isnull',
  'notnull', 'escape', 'asc', 'desc', 'nulls', 'fetch', 'window', 'lateral', 'values', 'exists', 'any', 'all', 'some',
])
/** Words an expression of placeholders may hold and still be a constant: type names, and the literals' own words. */
const CONSTANT_WORDS = new Set([
  'date', 'timestamp', 'timestamptz', 'time', 'timetz', 'interval', 'with', 'without', 'zone', 'int', 'integer', 'bigint',
  'smallint', 'numeric', 'decimal', 'real', 'double', 'precision', 'text', 'varchar', 'null', 'true', 'false',
])
const ARITHMETIC = new Set(['+', '-', '*', '/', '%', '^'])
const OPERATOR_CHARS = /^[+\-*/<>=~!@#%^&|`?]+$/

const isPlaceholder = (t: string | undefined) => t === '{{from}}' || t === '{{to}}'
const isWord = (t: string | undefined): t is string => t !== undefined && /^[a-z_\u0080-\uFFFF]/.test(t)
const isBoundary = (t: string) => t === ',' || t === ';' || t === '=>' || COMPARISONS.has(t) || STOP_WORDS.has(t)
const isConstant = (t: string) =>
  isPlaceholder(t) || t === "''" || /^[\d.]/.test(t) || t === '::' || t === '(' || t === ')' || ARITHMETIC.has(t) || CONSTANT_WORDS.has(t)

/** A query's code as tokens: placeholders, words (lower case), numbers, strings (blanked to ''), operators, signs. */
function tokensOf(sql: string): string[] {
  const out: string[] = []
  const re = /\{\{(?:from|to)\}\}|''|[A-Za-z_\u0080-\uFFFF][\w$\u0080-\uFFFF]*|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+|::|[+\-*/<>=~!@#%^&|`?]+|\S/g
  for (const [t] of codeOnly(sql).matchAll(re)) {
    if (!OPERATOR_CHARS.test(t) || t.length === 1) {
      out.push(isPlaceholder(t) ? t : t.toLowerCase())
      continue
    }
    // PostgreSQL's own reading: a longer operator ends in + or - only when it holds one of ~ ! @ # % ^ & | ` ? (so >=-1 is >= and -1).
    let cut = t.length
    if (!/[~!@#%^&|`?]/.test(t)) while (cut > 1 && (t[cut - 1] === '+' || t[cut - 1] === '-')) cut--
    out.push(t.slice(0, cut), ...t.slice(cut))
  }
  return out
}

/** The operand next to toks[from], walking one way: its tokens (a group in parentheses whole), and the boundary it stops at. */
function operand(toks: string[], from: number, step: 1 | -1): { toks: string[]; stop: number } {
  const opens = step < 0 ? ')' : '('
  const closes = step < 0 ? '(' : ')'
  const out: string[] = []
  let depth = 0
  let i = from
  for (; i >= 0 && i < toks.length; i += step) {
    const t = toks[i]
    if (t === opens) depth++
    else if (t === closes) {
      if (depth === 0) break
      depth--
    } else if (depth === 0 && isBoundary(t)) break
    out.push(t)
  }
  return { toks: out, stop: i }
}

/** The position of the parenthesis that encloses toks[at], or -1. */
function enclosing(toks: string[], at: number): number {
  let depth = 0
  for (let i = at; i >= 0; i--) {
    if (toks[i] === ')') depth++
    else if (toks[i] === '(') {
      if (depth === 0) return i
      depth--
    }
  }
  return -1
}

/** The parenthesis that closes the one at `open`. */
function matching(toks: string[], open: number): number {
  let depth = 0
  for (let i = open; i < toks.length; i++) {
    if (toks[i] === '(') depth++
    else if (toks[i] === ')' && --depth === 0) return i
  }
  return toks.length
}

/** What one placeholder does in a query: bounds the data from below, from above, both (=, or a function given the whole period), nothing, or is compared with constants only. */
type Role = 'lower' | 'upper' | 'both' | 'none' | 'constant'

/** The role of the placeholder at toks[at], read outwards: through parentheses and function calls to the comparison it stands in. */
function roleAt(toks: string[], at: number): Role {
  let lo = at
  let hi = at
  /** The outermost function call the placeholder is an argument of, while no comparison is found. */
  let call: [number, number] | null = null
  for (;;) {
    const left = operand(toks, lo - 1, -1)
    const right = operand(toks, hi + 1, 1)
    const lt = toks[left.stop]
    const rt = toks[right.stop]
    if ((lt === '(' || lt === ',') && (rt === ')' || rt === ',')) {
      const open = lt === '(' ? left.stop : enclosing(toks, left.stop - 1)
      const name = open > 0 ? toks[open - 1] : undefined
      if (isWord(name) && !STOP_WORDS.has(name)) {
        // An argument: the call is the operand now.
        const close = rt === ')' ? right.stop : matching(toks, open)
        call = [open, close]
        lo = open - 1
        hi = close
        continue
      }
      // A group around the operand alone is looked through; a list (IN (…), a row) bounds nothing.
      if (lt === '(' && rt === ')') {
        lo = left.stop
        hi = right.stop
        continue
      }
      return 'none'
    }
    // In a comparison: the other side must read the data, and the operator says which bound it is.
    const compared = COMPARISONS.has(lt)
      ? { op: lt, other: operand(toks, left.stop - 1, -1), placeholderOnRight: true }
      : COMPARISONS.has(rt)
        ? { op: rt, other: operand(toks, right.stop + 1, 1), placeholderOnRight: false }
        : null
    if (compared) {
      if (compared.other.toks.length === 0) return 'none'
      if (compared.other.toks.every(isConstant)) return 'constant'
      if (compared.op === '=') return 'both'
      if (compared.op === '<>' || compared.op === '!=') return 'none'
      // x >= P and P <= x hold x from below; x < P and P > x from above.
      const greater = compared.op.startsWith('>')
      return greater === compared.placeholderOnRight ? 'lower' : 'upper'
    }
    // BETWEEN P AND …, BETWEEN … AND P.
    let between = -1
    let side: 'lower' | 'upper' = 'lower'
    if (lt === 'between' || (lt === 'symmetric' && toks[left.stop - 1] === 'between')) between = lt === 'between' ? left.stop : left.stop - 1
    else if (lt === 'and') {
      let b = operand(toks, left.stop - 1, -1).stop
      if (toks[b] === 'symmetric') b--
      if (toks[b] === 'between') {
        between = b
        side = 'upper'
      }
    }
    if (between >= 0) {
      if (toks[between - 1] === 'not') return 'none'
      const subject = operand(toks, between - 1, -1)
      if (subject.toks.length === 0) return 'none'
      return subject.toks.every(isConstant) ? 'constant' : side
    }
    // A function given the period, such as ai.production_between({{from}}, {{to}}), holds its rows within it when it is given both days.
    if (call) {
      const args = toks.slice(call[0], call[1] + 1)
      return args.includes('{{from}}') && args.includes('{{to}}') ? 'both' : 'none'
    }
    return 'none'
  }
}

/**
 * Why a template does not take its days from the period alone; null when it
 * does. It must use both placeholders, hold the data between a lower and an
 * upper bound made of them (or hand both to a function such as
 * ai.production_between), compare no placeholder with constants only, and
 * keep no day of its own.
 */
export function periodProblem(template: string): string | null {
  const own = ownDays(template)
  if (own) return own
  if (!template.includes('{{from}}') || !template.includes('{{to}}')) return 'it does not use both {{from}} and {{to}}'
  const toks = tokensOf(template)
  let lower = false
  let upper = false
  for (const [i, t] of toks.entries()) {
    if (!isPlaceholder(t)) continue
    const role = roleAt(toks, i)
    if (role === 'constant') return 'a placeholder is compared with constants only, not with the data'
    if (role === 'lower' || role === 'both') lower = true
    if (role === 'upper' || role === 'both') upper = true
  }
  if (!lower || !upper) return `it does not hold the data between the period's first and last day`
  return null
}

const DAY_MS = 86_400_000

/** Days a range covers, both ends counted. */
export function rangeDays(range: AiDayRange): number {
  return Math.round((Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) / DAY_MS) + 1
}

/** The first day of the days no record reaches: the factory's data begins a century later. */
const NO_DATA_FROM = '1900-01-01'

/** A range as long as `range`, over days that hold no data at all. */
export function noDataRange(range: AiDayRange): AiDayRange {
  const to = new Date(Date.parse(`${NO_DATA_FROM}T00:00:00Z`) + (rangeDays(range) - 1) * DAY_MS).toISOString().slice(0, 10)
  return { from: NO_DATA_FROM, to }
}

/** Why a range a person asked for cannot be run, or null when it can. */
export function rangeProblem(range: AiDayRange): string | null {
  if (!isAiDay(range.from) || !isAiDay(range.to)) return 'A day is YYYY-MM-DD, and a real date.'
  if (range.from > range.to) return 'The first day comes after the last.'
  if (rangeDays(range) > AI_REPORT_MAX_DAYS) return `A report runs over at most ${AI_REPORT_MAX_DAYS} days.`
  return null
}

/**
 * Whether the query orders its rows: an ORDER BY of the query itself, not one
 * inside a subquery, a window or an aggregate. Its rows are then compared in
 * order; without one, as a multiset.
 */
export function ordersRows(sql: string): boolean {
  const code = codeOnly(sql)
  let depth = 0
  let top = ''
  for (const c of code) {
    if (c === '(') depth++
    else if (c === ')') depth = Math.max(0, depth - 1)
    // Everything nested stays out, as a space, so words on either side of it never run together.
    top += depth === 0 && c !== ')' ? c : ' '
  }
  return /\border\s+by\b/i.test(top)
}

interface Result {
  columns: string[]
  rows: AiCell[][]
}

/** Two results the same: the same columns in the same order, and the same rows (in order, or as a multiset). Numbers exactly. */
export function sameResult(a: Result, b: Result, ordered: boolean): boolean {
  if (a.columns.length !== b.columns.length || a.columns.some((c, i) => c !== b.columns[i])) return false
  if (a.rows.length !== b.rows.length) return false
  // JSON tells 1 from "1" and null from "null", and writes a number with every digit it has.
  const key = (row: AiCell[]) => JSON.stringify(row)
  if (ordered) return a.rows.every((row, i) => key(row) === key(b.rows[i]))
  const counts = new Map<string, number>()
  for (const row of a.rows) counts.set(key(row), (counts.get(key(row)) ?? 0) + 1)
  for (const row of b.rows) {
    const k = key(row)
    const n = counts.get(k) ?? 0
    if (n === 0) return false
    counts.set(k, n - 1)
  }
  return true
}
