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
// name or a number). Whether it still means what the answer meant is then
// checked by running it (see reports.ts); the runner's own checks and the
// read-only sandbox apply to the filled SQL as to any other.
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

const DAY_MS = 86_400_000

/** Days a range covers, both ends counted. */
export function rangeDays(range: AiDayRange): number {
  return Math.round((Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) / DAY_MS) + 1
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
