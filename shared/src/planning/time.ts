// ============================================================================
// §25 — the factory's wall clock in whole minutes ("wall minutes"), and the
// way between it and the instants the database keeps. A factory day runs
// from 08:00 to 08:00 the next morning (rules.ts, FACTORY_DAY_START_HOUR).
// ============================================================================

import { FACTORY_DAY_START_HOUR, factoryDay, zonedInstant } from '../rules'

export const MINUTES_PER_DAY = 24 * 60
/** Where a factory day begins, in minutes after midnight. */
export const DAY_START_MINUTE = FACTORY_DAY_START_HOUR * 60

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const WALL_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/

/** A YYYY-MM-DD day that is a real day of the calendar. */
export function isDay(v: unknown): v is string {
  if (typeof v !== 'string') return false
  const m = DAY_RE.exec(v)
  if (!m) return false
  const [y, mo, d] = m.slice(1).map(Number)
  const t = new Date(Date.UTC(y, mo - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d
}

/** Whole days since 1970-01-01 of a YYYY-MM-DD day. */
export function dayNumber(day: string): number {
  const [y, m, d] = day.split('-').map(Number)
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000)
}

/** The YYYY-MM-DD day of a day number. */
export function dayOfNumber(n: number): string {
  return new Date(n * 86_400_000).toISOString().slice(0, 10)
}

export const addDays = (day: string, n: number): string => dayOfNumber(dayNumber(day) + n)

/** 0 = Sunday … 5 = Friday, 6 = Saturday. */
export const weekday = (day: string): number => (dayNumber(day) + 4) % 7
export const FRIDAY = 5

/** The start of a factory day (08:00 on it), in wall minutes. */
export const dayStartWall = (day: string): number => dayNumber(day) * MINUTES_PER_DAY + DAY_START_MINUTE

/** The factory day a wall minute belongs to: before 08:00 is still the day before. */
export function factoryDayOfWall(wall: number): string {
  return dayOfNumber(Math.floor((wall - DAY_START_MINUTE) / MINUTES_PER_DAY))
}

/** "YYYY-MM-DD HH:MM" as wall minutes; null when it is no such time. */
export function parseWall(text: string): number | null {
  const m = WALL_RE.exec(text.trim())
  if (!m) return null
  const [y, mo, d, h, mi] = m.slice(1).map(Number)
  if (!isDay(`${m[1]}-${m[2]}-${m[3]}`) || h > 23 || mi > 59) return null
  return Math.floor(Date.UTC(y, mo - 1, d, h, mi) / 60_000)
}

/** Wall minutes as "YYYY-MM-DD HH:MM". */
export function formatWall(wall: number): string {
  return new Date(wall * 60_000).toISOString().slice(0, 16).replace('T', ' ')
}

const clocks = new Map<string, Intl.DateTimeFormat>()

/** An instant as the factory's clock reads it, in wall minutes. */
export function wallOfInstant(at: Date | string | number, timeZone: string): number {
  const d = at instanceof Date ? at : new Date(at)
  let f = clocks.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
    clocks.set(timeZone, f)
  }
  const parts = f.formatToParts(d)
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  return Math.floor(Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute')) / 60_000)
}

/** The instant a wall minute happens at in the factory's zone. */
export function instantOfWall(wall: number, timeZone: string): Date {
  const d = new Date(wall * 60_000)
  return zonedInstant(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), 0, 0, timeZone)
}

/** The factory day an instant belongs to. */
export const factoryDayOfInstant = (at: Date | string, timeZone: string): string => factoryDay(at, timeZone)

/** The Saturday that begins the week a day falls in: the factory's week runs Saturday to Friday, Friday its day off. */
export function weekStart(day: string): string {
  return addDays(day, -((weekday(day) + 1) % 7))
}
