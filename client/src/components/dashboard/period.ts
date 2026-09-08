// ============================================================================
// The dashboard's period and what it is compared with (§15.1). Days are
// calendar days where the user sits, which is the factory: the API turns
// them into instants in the factory's zone. Everything here is pure so the
// arithmetic can be tested without a browser.
// ============================================================================

import type { KpiRange } from '@qc/shared/kpi'

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

/** The range a preset means on a given day. */
export function presetRange(preset: PeriodPreset, today: Date, custom?: KpiRange): KpiRange {
  const y = today.getFullYear()
  const m = today.getMonth()
  const t = toDay(today)
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
 * The comparison range. "Previous period" is the same span of calendar
 * days ending the day before; for a month-to-date range it is the same days
 * of the previous month (1st to the same day number, clamped to the month's
 * end), so "this month so far" is compared with "last month at this point".
 * "Same period last year" shifts both ends back a year.
 */
export function compareRange(range: KpiRange, mode: ComparePreset, monthAligned: boolean): KpiRange {
  if (mode === 'same-last-year') {
    const f = fromDay(range.from)
    const t = fromDay(range.to)
    return { from: toDay(new Date(f.getFullYear() - 1, f.getMonth(), Math.min(f.getDate(), lastDayOfMonth(f.getFullYear() - 1, f.getMonth())))), to: toDay(new Date(t.getFullYear() - 1, t.getMonth(), Math.min(t.getDate(), lastDayOfMonth(t.getFullYear() - 1, t.getMonth())))) }
  }
  if (monthAligned) {
    const f = fromDay(range.from)
    const t = fromDay(range.to)
    const months = (t.getFullYear() - f.getFullYear()) * 12 + (t.getMonth() - f.getMonth()) + 1
    const pf = new Date(f.getFullYear(), f.getMonth() - months, 1)
    const ptMonth = new Date(t.getFullYear(), t.getMonth() - months, 1)
    const pt = new Date(ptMonth.getFullYear(), ptMonth.getMonth(), Math.min(t.getDate(), lastDayOfMonth(ptMonth.getFullYear(), ptMonth.getMonth())))
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

export function describeRange(r: KpiRange): string {
  const f = fromDay(r.from)
  const t = fromDay(r.to)
  const day = (d: Date) => `${d.getDate()} ${MONTHS[d.getMonth()]}`
  if (r.from === r.to) return `${day(f)} ${f.getFullYear()}`
  if (f.getFullYear() === t.getFullYear()) return `${day(f)} – ${day(t)} ${t.getFullYear()}`
  return `${day(f)} ${f.getFullYear()} – ${day(t)} ${t.getFullYear()}`
}

export function shortDay(s: string): string {
  const d = fromDay(s)
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`
}
