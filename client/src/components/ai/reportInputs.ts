// ============================================================================
// §20 — what a report's form holds and how its sections are laid out besides a
// table: the inputs as typed (a draft each) and the values a run sends, the
// key of a run by its values, the headline figures of a figures section and
// the rows of a tree section in the order they read. Pure, so it is tested
// without a browser; the server checks every value again before a run.
// ============================================================================

import type { AiCell, AiReportTree } from '@qc/shared/ai'
import { inputDefault, readInputValues, type AiReportInput, type AiReportInputValue, type AiReportInputValues } from '@qc/shared/aiReportInputs'
import { factoryDay } from '@qc/shared/rules'

/** What a field shows for a value: a list joined with commas, nothing as empty. */
export function valueDraft(value: AiReportInputValue | undefined): string {
  if (value === null || value === undefined) return ''
  return Array.isArray(value) ? value.join(', ') : String(value)
}

/** The fields of a form: the values a run used, else each input's default on `today`. */
export function inputDrafts(inputs: readonly AiReportInput[], values: AiReportInputValues | null, today: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const input of inputs) {
    out[input.name] = valueDraft(values && Object.prototype.hasOwnProperty.call(values, input.name) ? values[input.name] : inputDefault(input, today))
  }
  return out
}

/** The values the fields hold, checked as the server checks them; or every problem, by the inputs' labels. */
export function readDrafts(inputs: readonly AiReportInput[], drafts: Record<string, string>, today: string): { values: AiReportInputValues } | { problems: string[] } {
  const sent: Record<string, unknown> = {}
  for (const input of inputs) sent[input.name] = drafts[input.name] ?? ''
  return readInputValues(inputs, sent, today)
}

/** Whether a report's inputs can run as they start (every required one has a default), so opening it runs it at once. */
export function runsOnOpen(inputs: readonly AiReportInput[], today: string): boolean {
  return 'values' in readInputValues(inputs, null, today)
}

/** A run's values as one text, the same for the same values: its place in the cache and what the server is sent. */
export function inputsKey(values: AiReportInputValues | null): string {
  if (!values) return ''
  const names = Object.keys(values).sort()
  return JSON.stringify(Object.fromEntries(names.map((n) => [n, values[n]])))
}

/** The values a run used, in words, for print and the run line: "Orders: 20332, 20333 · Week: 26". */
export function inputsLine(inputs: readonly AiReportInput[], values: AiReportInputValues | null | undefined): string {
  if (!values) return ''
  return inputs
    .filter((i) => values[i.name] !== null && values[i.name] !== undefined && !(Array.isArray(values[i.name]) && (values[i.name] as string[]).length === 0))
    .map((i) => `${i.label}: ${valueDraft(values[i.name])}`)
    .join(' · ')
}

/** The headline figures of a figures section: the first row's columns, each under its name. */
export function sectionFigures(columns: readonly string[], rows: readonly AiCell[][]): { label: string; value: AiCell }[] {
  const row = rows[0]
  if (!row) return []
  return columns.map((label, c) => ({ label, value: row[c] ?? null }))
}

export interface TreeRow {
  /** The row's place in the result. */
  index: number
  depth: number
  /** Its key, as text. */
  key: string
  /** Its ancestors' keys, nearest last: it shows when every one of them is open. */
  path: string[]
  childCount: number
}

/**
 * The rows of a tree section in the order they read: each under the row its parent column names, children in the
 * order the result gives them. A row whose parent is empty or names no row is at the top; a row met again (a key
 * given twice, a loop of parents) is shown once. The key and parent columns are left out of what is shown.
 */
export function treeRows(columns: readonly string[], rows: readonly AiCell[][], tree: AiReportTree): { rows: TreeRow[]; shown: number[] } | null {
  const k = columns.indexOf(tree.key)
  const p = columns.indexOf(tree.parent)
  if (k < 0 || p < 0) return null
  const text = (v: AiCell | undefined) => (v === null || v === undefined ? '' : String(v))
  const keys = new Set(rows.map((r) => text(r[k])).filter(Boolean))
  const children = new Map<string, number[]>()
  const roots: number[] = []
  rows.forEach((r, i) => {
    const parent = text(r[p])
    const key = text(r[k])
    if (!parent || !keys.has(parent) || parent === key) roots.push(i)
    else children.set(parent, [...(children.get(parent) ?? []), i])
  })
  const out: TreeRow[] = []
  const placed = new Set<number>()
  const seenKeys = new Set<string>()
  const walk = (i: number, depth: number, path: string[]) => {
    if (placed.has(i)) return
    placed.add(i)
    const key = text(rows[i][k])
    // A key given twice: its children sit under its first row only.
    const kids = key && !seenKeys.has(key) ? (children.get(key) ?? []) : []
    if (key) seenKeys.add(key)
    out.push({ index: i, depth, key, path, childCount: kids.filter((c) => !placed.has(c)).length })
    for (const c of kids) walk(c, depth + 1, [...path, key])
  }
  for (const i of roots) walk(i, 0, [])
  // Rows only a loop of parents reaches: at the top, so none is lost.
  rows.forEach((_, i) => {
    if (!placed.has(i)) walk(i, 0, [])
  })
  const shown = columns.map((_, c) => c).filter((c) => c !== k && c !== p)
  return { rows: out, shown }
}

/**
 * Today's factory day, YYYY-MM-DD (08:00 to 08:00 in the factory's zone): what
 * the form's defaults start from, the day the server counts a run's defaults
 * and period from (it fills its own for a run sent without values).
 */
export function reportToday(timeZone: string, at: Date = new Date()): string {
  return factoryDay(at, timeZone)
}

/** The calendar date on this device, YYYY-MM-DD: the date a printed page carries. */
export function localDay(at: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

/**
 * A tree section as a plain table, for print and wherever rows cannot open: the rows in the order they read, the
 * first column shown stepped in by its depth, the key and parent columns left out. Null when the tree's columns are
 * not in the result.
 */
export function treeAsTable(columns: readonly string[], rows: readonly AiCell[][], tree: AiReportTree): { columns: string[]; rows: AiCell[][] } | null {
  const laid = treeRows(columns, rows, tree)
  if (!laid || laid.shown.length === 0) return null
  const [first] = laid.shown
  return {
    columns: laid.shown.map((c) => columns[c]),
    rows: laid.rows.map((r) =>
      laid.shown.map((c) => {
        const v = rows[r.index][c] ?? null
        if (c !== first || r.depth === 0) return v
        return `${' '.repeat(r.depth)}${v === null ? '' : String(v)}`
      }),
    ),
  }
}
