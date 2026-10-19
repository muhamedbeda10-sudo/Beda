// ============================================================================
// The dashboard's period and what it is compared with (§15.1). Days are
// factory days (08:00 to 08:00 where the factory sits, which is where the
// user sits): the API turns them into instants in the factory's zone, so
// "today" at 02:00 is still the day the night shift started. Everything here
// is pure so the arithmetic can be tested without a browser.
// ============================================================================

import type { KpiRange } from '@qc/shared/kpi'
import { factoryDay } from '@qc/shared/rules'

export type PeriodPreset = 'this-month' | 'last-month' | 'last-7' | 'last-30' | 'this-quarter' | 'this-year' | 'custom'
export type ComparePreset = 'previous-period' | 'same-last-year'

export const PERIOD_PRESETS: { key: PeriodPreset; label: string }[] = [
  { key: 'this-month', label: 'This month' },
  { key: 'last-month', label: 'Last month' },
  { key: 'last-7', label: 'Last 7 days' },
  { key: 'last-30', label: 'Last 30 days' },
  { key: 'this-quarter', label: 'This quarter' },
  { key: 'this-year', label: 'This year' },
  { key: 'custom', label: 'Custom' },
]

export const COMPARE_PRESETS: { key: ComparePreset; label: string }[] = [
  { key: 'previous-period', label: 'Previous period' },
  { key: 'same-last-year', label: 'Same period last year' },
]

export function toDay(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function fromDay(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function addDays(s: string, n: number): string {
  const d = fromDay(s)
  d.setDate(d.getDate() + n)
  return toDay(d)
}

export function daysInRange(r: KpiRange): number {
  return Math.round((fromDay(r.to).getTime() - fromDay(r.from).getTime()) / 86_400_000) + 1
}

function lastDayOfMonth(y: number, m: number): number {
  return new Date(y, m + 1, 0).getDate()
}

/** Whether a day is the last of its month. */
function isMonthEnd(d: Date): boolean {
  return d.getDate() === lastDayOfMonth(d.getFullYear(), d.getMonth())
}

/**
 * The range a preset means at a moment: counted from the factory day it
 * falls in (shared factoryDay), in the factory's zone when one is given,
 * else where the browser sits.
 */
export function presetRange(preset: PeriodPreset, now: Date, custom?: KpiRange, timeZone?: string): KpiRange {
  const t = factoryDay(now, timeZone)
  const today = fromDay(t)
  const y = today.getFullYear()
  const m = today.getMonth()
  switch (preset) {
    case 'this-month':
      return { from: toDay(new Date(y, m, 1)), to: t }
    case 'last-month': {
      const first = new Date(y, m - 1, 1)
      return { from: toDay(first), to: toDay(new Date(first.getFullYear(), first.getMonth(), lastDayOfMonth(first.getFullYear(), first.getMonth()))) }
    }
    case 'last-7':
      return { from: addDays(t, -6), to: t }
    case 'last-30':
      return { from: addDays(t, -29), to: t }
    case 'this-quarter':
      return { from: toDay(new Date(y, Math.floor(m / 3) * 3, 1)), to: t }
    case 'this-year':
      return { from: toDay(new Date(y, 0, 1)), to: t }
    case 'custom':
      return custom ?? { from: toDay(new Date(y, m, 1)), to: t }
  }
}

/**
 * The day of month `month` (a Date on its 1st) that stands for `d`: the same
 * day number, clamped to the month's end. As the end of a range, a month's
 * last day stands for the other month's last day, so a whole month is
 * compared with a whole month.
 */
function sameDayIn(month: Date, d: Date, asEnd: boolean): Date {
  const last = lastDayOfMonth(month.getFullYear(), month.getMonth())
  return new Date(month.getFullYear(), month.getMonth(), asEnd && isMonthEnd(d) ? last : Math.min(d.getDate(), last))
}

/**
 * The comparison range. "Previous period" is the same span of days ending
 * the day before; for a range starting on the 1st it is the same days of the
 * months before (1st to the same day number, clamped to the month's end), so
 * "this month so far" is compared with "last month at this point", and a
 * range ending on its month's last day ends on the last day of the month it
 * is compared with: September with all of August, a quarter with the whole
 * quarter before. "Same period last year" shifts both ends back a year, by
 * the same rule.
 */
export function compareRange(range: KpiRange, mode: ComparePreset, monthAligned: boolean): KpiRange {
  if (mode === 'same-last-year') {
    const f = fromDay(range.from)
    const t = fromDay(range.to)
    return { from: toDay(sameDayIn(new Date(f.getFullYear() - 1, f.getMonth(), 1), f, false)), to: toDay(sameDayIn(new Date(t.getFullYear() - 1, t.getMonth(), 1), t, true)) }
  }
  if (monthAligned) {
    const f = fromDay(range.from)
    const t = fromDay(range.to)
    const months = (t.getFullYear() - f.getFullYear()) * 12 + (t.getMonth() - f.getMonth()) + 1
    const pf = new Date(f.getFullYear(), f.getMonth() - months, 1)
    const pt = sameDayIn(new Date(t.getFullYear(), t.getMonth() - months, 1), t, true)
    return { from: toDay(pf), to: toDay(pt) }
  }
  const n = daysInRange(range)
  const to = addDays(range.from, -1)
  return { from: addDays(to, -(n - 1)), to }
}

/** Whether a range starts on the 1st, so its comparison should be by month rather than by day count. */
export function isMonthAligned(range: KpiRange): boolean {
  return range.from.endsWith('-01')
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** A period in the application's one date format: "Sep 1 – Sep 8, 2026", "Dec 20, 2025 – Jan 5, 2026", "Sep 8, 2026". */
export function describeRange(r: KpiRange): string {
  const f = fromDay(r.from)
  const t = fromDay(r.to)
  const day = (d: Date) => `${MONTHS[d.getMonth()]} ${d.getDate()}`
  if (r.from === r.to) return `${day(f)}, ${f.getFullYear()}`
  if (f.getFullYear() === t.getFullYear()) return `${day(f)} – ${day(t)}, ${t.getFullYear()}`
  return `${day(f)}, ${f.getFullYear()} – ${day(t)}, ${t.getFullYear()}`
}

/** A period without its year, for a badge on a chart: "Oct 1 – Oct 6", "Oct 6". */
export function shortRange(r: KpiRange): string {
  return r.from === r.to ? shortDay(r.from) : `${shortDay(r.from)} – ${shortDay(r.to)}`
}

/** "Sep 8". */
export function shortDay(s: string): string {
  const d = fromDay(s)
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`
}

/** "Sep 2026" for a YYYY-MM. */
export function monthLabel(month: string, withYear = true): string {
  const [y, m] = month.split('-').map(Number)
  const name = MONTHS[m - 1]
  return withYear ? `${name} ${y}` : name
}
