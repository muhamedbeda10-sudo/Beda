// ============================================================================
// §21 — what a proposed change of an automation changes, line by line, as
// its card lists it before it is activated: the proposal's draft against the
// automation as it is now (not as it was when the change was asked for: the
// person may have edited it on its page since). Words a person reads, never
// the SQL itself: a query, a chart or a template is named as changed. Names
// and titles are set apart (isolate), so an Arabic one reads right in an
// English line.
// ============================================================================

import type { AutomationDraft, AutomationReportSection, AutomationScheduleSpec, AutomationWatchSpec } from '@qc/shared/automation'
import { isolate } from './text'

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const
const LANGUAGES = { ar: 'Arabic', en: 'English' } as const

/** A value as JSON with its keys in order, so two equal values compare equal however they were built. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

const same = (a: unknown, b: unknown) => canonical(a) === canonical(b)

/** When a report runs, as a person says it: "weekly on Thursday at 08:00". */
export function runsWhen(s: Pick<AutomationScheduleSpec, 'cadence' | 'time' | 'weekdays' | 'weekday' | 'monthDay'>): string {
  if (s.cadence === 'weekly') return `weekly on ${DAYS[s.weekday ?? 0] ?? '?'} at ${s.time}`
  if (s.cadence === 'monthly') return `monthly on day ${s.monthDay ?? '?'} at ${s.time}`
  const days = s.weekdays && s.weekdays.length > 0 && s.weekdays.length < 7 ? ` (${s.weekdays.map((d) => DAYS[d]?.slice(0, 3) ?? '?').join(', ')})` : ''
  return `daily${days} at ${s.time}`
}

/** A name or a title in a line, set apart in its quotes. */
const quoted = (name: string) => `“${isolate(name)}”`

/** "Section 2 “Scrap by machine”". */
const sectionName = (index: number, s: AutomationReportSection) => `Section ${index + 1} ${quoted(s.title)}`

/**
 * The sections of before and after, paired: first those with the same title, then the rest in order. Unpaired ones
 * were added or removed.
 */
function pairSections(before: readonly AutomationReportSection[], after: readonly AutomationReportSection[]): { pairs: [number, number][]; added: number[]; removed: number[] } {
  const taken = new Set<number>()
  const pairOf = new Map<number, number>()
  after.forEach((a, i) => {
    const j = before.findIndex((b, k) => !taken.has(k) && b.title === a.title)
    if (j >= 0) {
      taken.add(j)
      pairOf.set(i, j)
    }
  })
  const left = before.map((_, k) => k).filter((k) => !taken.has(k))
  after.forEach((_, i) => {
    if (pairOf.has(i) || left.length === 0) return
    pairOf.set(i, left.shift()!)
  })
  const pairs = [...pairOf.entries()].sort(([a], [b]) => a - b)
  const paired = new Set(pairs.map(([, j]) => j))
  return {
    pairs,
    added: after.map((_, i) => i).filter((i) => !pairOf.has(i)),
    removed: before.map((_, k) => k).filter((k) => !paired.has(k)),
  }
}

function scheduleChanges(b: AutomationScheduleSpec, a: AutomationScheduleSpec, out: string[]): void {
  const when = (s: AutomationScheduleSpec) => runsWhen(s)
  if (when(b) !== when(a)) out.push(`Runs: ${when(b)} → ${when(a)}`)
  if (!same(b.period, a.period)) out.push(a.period ? (b.period ? 'The days it covers' : 'Covers a period now') : 'No longer covers a period')
  if (b.summary !== a.summary) out.push(a.summary ? 'A summary on top: added' : 'The summary on top: removed')
  const { pairs, added, removed } = pairSections(b.sections, a.sections)
  for (const [i, j] of pairs) {
    const before = b.sections[j]
    const after = a.sections[i]
    if (before.title !== after.title) out.push(`Section ${i + 1}: ${quoted(before.title)} → ${quoted(after.title)}`)
    if (before.sql !== after.sql) out.push(`${sectionName(i, after)}: its query`)
    if (!same(before.chart, after.chart)) out.push(`${sectionName(i, after)}: ${after.chart ? (before.chart ? 'its chart' : 'a chart added') : 'its chart removed'}`)
  }
  if (pairs.some(([, j], k) => k > 0 && j < pairs[k - 1][1])) out.push('The order of the sections')
  for (const i of added) out.push(`${sectionName(i, a.sections[i])}: added`)
  for (const j of removed) out.push(`Section ${quoted(b.sections[j].title)}: removed`)
}

function watchChanges(b: AutomationWatchSpec, a: AutomationWatchSpec, out: string[]): void {
  if (b.sql !== a.sql) out.push('Its query')
  if (b.keyColumn !== a.keyColumn) out.push(`What names a case: ${b.keyColumn} → ${a.keyColumn}`)
  if (b.everyMinutes !== a.everyMinutes) out.push(`Runs every ${b.everyMinutes} → ${a.everyMinutes} minutes`)
  if (!same(b.hours, a.hours)) out.push(a.hours ? `Hours: ${b.hours ? `${b.hours.from}–${b.hours.to}` : 'around the clock'} → ${a.hours.from}–${a.hours.to}` : 'Hours: around the clock now')
  if (!same(b.weekdays, a.weekdays)) out.push('The days it runs')
  if (b.titleTemplate !== a.titleTemplate || (b.bodyTemplate ?? '') !== (a.bodyTemplate ?? '')) out.push('Its message')
  if (b.sessionColumn !== a.sessionColumn || b.sampleColumn !== a.sampleColumn || b.orderColumn !== a.orderColumn) out.push('What its messages link to')
}

/** What `after` changes of `before`, a line each; none when it changes nothing. */
export function describeChanges(before: AutomationDraft, after: AutomationDraft): string[] {
  const out: string[] = []
  if (before.name !== after.name) out.push(`Name: ${quoted(before.name)} → ${quoted(after.name)}`)
  if (before.description !== after.description) out.push('Its description')
  if (before.language !== after.language) out.push(`Language: ${LANGUAGES[before.language]} → ${LANGUAGES[after.language]}`)
  if (before.schedule && after.schedule) scheduleChanges(before.schedule, after.schedule, out)
  if (before.watch && after.watch) watchChanges(before.watch, after.watch, out)
  if (!same(before.recipients, after.recipients)) out.push('Who is told')
  if (!same(before.channels, after.channels)) out.push('Where they are told (bell, chat)')
  if (!same(before.actions, after.actions)) out.push('What it does with each case')
  return out
}
