// ============================================================================
// §21 — follow-ups in words: the statuses and how each reads, the filters as
// the API takes them (and what an empty list says), a deadline as "in 3 h"
// or "2 days overdue", where a follow-up's session, sample and order open in
// the app, the people it can be given to, and a deadline typed on the
// factory's clock as the instant the API stores.
// ============================================================================

import type { FollowUp, FollowUpPeopleResponse, FollowUpScope, FollowUpStatus } from '@qc/shared/automation'
import type { BadgeTone } from '@/components/ui'
import { orderHistoryPath, sampleDetailPath, sessionDetailPath } from '@/lib/links'
import { dayInTimeZone } from '@/lib/utils'

export const FOLLOW_UP_STATUS_LABEL: Record<FollowUpStatus, string> = { open: 'Open', in_progress: 'In progress', done: 'Done' }
export const FOLLOW_UP_STATUS_TONE: Record<FollowUpStatus, BadgeTone> = { open: 'amber', in_progress: 'blue', done: 'green' }

// ---- Filters -----------------------------------------------------------------------

/** What the list shows by status: those still to do (the default), one status, or all of them. */
export type FollowUpStatusFilter = 'active' | FollowUpStatus | 'any'

export const STATUS_FILTER_LABEL: Record<FollowUpStatusFilter, string> = {
  active: 'Not done',
  open: 'Open',
  in_progress: 'In progress',
  done: 'Done',
  any: 'Any status',
}

const STATUS_FILTER_VALUES: Record<FollowUpStatusFilter, FollowUpStatus[]> = {
  active: ['open', 'in_progress'],
  open: ['open'],
  in_progress: ['in_progress'],
  done: ['done'],
  any: [],
}

export const isStatusFilter = (v: unknown): v is FollowUpStatusFilter => typeof v === 'string' && v in STATUS_FILTER_VALUES

export interface FollowUpFilters {
  /** "mine": assigned to me or opened by my automations; "all": everyone's (for those who may see it). */
  scope: FollowUpScope
  status: FollowUpStatusFilter
  /** Only those past their deadline and not done. */
  overdue: boolean
  automationId: string | null
  /** The follow-ups of one session (its page's "Needs review"). */
  sessionId?: string | null
}

/**
 * What an automation's "N open" link shows: that automation's follow-ups not
 * done, whatever their deadline — everyone's for someone who may see
 * everyone's, since the count is of all of them (the assistant's owner on
 * another person's automation; its creator's own "Mine" holds them all).
 */
export function automationLinkFilters(mayAll: boolean): Pick<FollowUpFilters, 'scope' | 'status' | 'overdue'> {
  return { scope: mayAll ? 'all' : 'mine', status: 'active', overdue: false }
}

/**
 * What an empty list says: nothing matches the filters; nothing left to do
 * (`anyDone`: every one here is done); or none at all yet. `anyDone` is null
 * when that could not be told.
 */
export function emptyListWords({ filtersSet, status, scope, anyDone }: { filtersSet: boolean; status: FollowUpStatusFilter; scope: FollowUpScope; anyDone: boolean | null }): { title: string; hint?: string } {
  if (filtersSet) return { title: 'No follow-up matches', hint: 'Clear the search or the filters to see more.' }
  if (status !== 'active') return { title: 'No follow-ups' }
  if (anyDone === null) return { title: 'Nothing left to do' }
  if (anyDone) return { title: 'Nothing left to do', hint: scope === 'mine' ? 'Every follow-up of yours is done.' : 'Every follow-up is done.' }
  return scope === 'mine'
    ? { title: 'No follow-ups for you yet', hint: 'When an automation opens a follow-up for you to look into — or one of your automations opens one — it shows here, and in your alerts.' }
    : { title: 'No follow-ups yet', hint: 'When a watch opens a follow-up for a case, it shows here.' }
}

/**
 * The list's request, as GET /api/follow-ups takes it: `?scope=…&status=…`,
 * leaving out what is not set; `before` is the last follow-up of the page
 * already read.
 */
export function followUpsQuery(f: FollowUpFilters, before: string | null = null): string {
  const u = new URLSearchParams()
  u.set('scope', f.scope)
  const statuses = STATUS_FILTER_VALUES[f.status]
  if (statuses.length > 0) u.set('status', statuses.join(','))
  if (f.overdue) u.set('overdue', 'true')
  if (f.automationId) u.set('automationId', f.automationId)
  if (f.sessionId) u.set('sessionId', f.sessionId)
  if (before) u.set('before', before)
  return `?${u.toString()}`
}

// ---- Deadlines ---------------------------------------------------------------------

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** A stretch of time in a word or two: "5 min", "3 h", "2 days" — rounded down, never less than a minute. */
export function durationWords(ms: number): string {
  const span = Math.max(0, ms)
  if (span < HOUR) return `${Math.max(1, Math.floor(span / MINUTE))} min`
  if (span < 2 * DAY) return `${Math.floor(span / HOUR)} h`
  return `${Math.floor(span / DAY)} days`
}

/** Not done and past its deadline, as of `now` (the list's own flag was true when it was fetched). */
export function isOverdue(f: Pick<FollowUp, 'dueAt' | 'status'>, now: Date = new Date()): boolean {
  return f.status !== 'done' && Date.parse(f.dueAt) < now.getTime()
}

export interface DueView {
  /** "in 3 h", "2 days overdue"; empty once done. */
  words: string
  /** done: read past; overdue: red; soon (within a day): amber; later: plain. */
  tone: 'done' | 'overdue' | 'soon' | 'later'
}

/** How a deadline reads next to its date. */
export function dueView(f: Pick<FollowUp, 'dueAt' | 'status'>, now: Date = new Date()): DueView {
  if (f.status === 'done') return { words: '', tone: 'done' }
  const left = Date.parse(f.dueAt) - now.getTime()
  if (left < 0) return { words: `${durationWords(-left)} overdue`, tone: 'overdue' }
  return { words: `in ${durationWords(left)}`, tone: left <= DAY ? 'soon' : 'later' }
}

export const DUE_TONE_CLASS: Record<DueView['tone'], string> = {
  done: 'text-muted',
  overdue: 'font-semibold text-rose-600 dark:text-rose-400',
  soon: 'font-medium text-amber-700 dark:text-amber-400',
  later: 'text-slate-600 dark:text-slate-300',
}

// ---- Where it leads ----------------------------------------------------------------

export interface FollowUpLinks {
  session: string | null
  /** A sample opens over its session's list, so it needs the session too. */
  sample: string | null
  order: string | null
}

export function followUpLinks(f: Pick<FollowUp, 'sessionId' | 'sampleId' | 'orderNumber'>): FollowUpLinks {
  return {
    session: f.sessionId ? sessionDetailPath(f.sessionId) : null,
    sample: f.sessionId && f.sampleId ? sampleDetailPath(f.sessionId, f.sampleId) : null,
    order: f.orderNumber?.trim() ? orderHistoryPath(f.orderNumber.trim()) : null,
  }
}

/**
 * Whether an automation's page is this person's to open: the assistant's
 * owner's, any; someone who may create automations, their own (`own`: the
 * ids of theirs, null until known); anyone else, none — to them it is "not
 * found", so no link leads there.
 */
export function mayOpenAutomation(id: string | null | undefined, who: { owner: boolean; automations: boolean; own: ReadonlySet<string> | null }): boolean {
  if (!id) return false
  if (who.owner) return true
  return who.automations && !!who.own?.has(id)
}

// ---- Whom it can be given to ---------------------------------------------------------

/** Someone a follow-up can be given to, as GET /follow-ups/people lists them. */
export type AssignablePerson = FollowUpPeopleResponse['people'][number]

/** Roles from the widest rights down, as the list groups them. */
const ROLE_ORDER: readonly string[] = ['admin', 'supervisor', 'inspector', 'warehouse', 'viewer']

const roleHeading = (role: string): string => (role ? role.charAt(0).toUpperCase() + role.slice(1) : 'No role')

export interface AssigneeChoices {
  /** Whom it is given to now, when the list does not hold them (an account switched off since): still offered, so the field reads who it is. */
  current: { id: string; name: string } | null
  /** Everyone it can be given to — viewers too — by role (the widest rights first, a role the app does not know last), each by name. */
  groups: { role: string; label: string; people: AssignablePerson[] }[]
}

/** The reassign list: the people the server offers, and whom it is given to now. */
export function assigneeChoices(people: readonly AssignablePerson[], assignee: { id: string; name: string } | null): AssigneeChoices {
  const byRole = new Map<string, AssignablePerson[]>()
  for (const p of people) byRole.set(p.role, [...(byRole.get(p.role) ?? []), p])
  const rank = (role: string) => {
    const i = ROLE_ORDER.indexOf(role)
    return i < 0 ? ROLE_ORDER.length : i
  }
  const groups = [...byRole.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([role, list]) => ({ role, label: roleHeading(role), people: [...list].sort((x, y) => x.name.localeCompare(y.name) || x.username.localeCompare(y.username)) }))
  return { current: assignee && !people.some((p) => p.id === assignee.id) ? { id: assignee.id, name: assignee.name } : null, groups }
}

// ---- The factory's clock -------------------------------------------------------------
// Deadlines are the factory's: they read on its clock whatever zone the device is set to.

/**
 * A moment on the factory's clock, short: "Today, 08:00", "Tomorrow, 07:30",
 * "Yesterday, 23:10", "Oct 12, 08:00", "Dec 30, 2025, 08:00".
 */
export function factoryMoment(iso: string | null | undefined, timeZone: string, now: Date = new Date()): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const time = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d)
  const day = dayInTimeZone(d, timeZone)
  const today = dayInTimeZone(now, timeZone)
  if (day === today) return `Today, ${time}`
  if (day === dayInTimeZone(new Date(now.getTime() + DAY), timeZone)) return `Tomorrow, ${time}`
  if (day === dayInTimeZone(new Date(now.getTime() - DAY), timeZone)) return `Yesterday, ${time}`
  const sameYear = day.slice(0, 4) === today.slice(0, 4)
  const date = new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) }).format(d)
  return `${date}, ${time}`
}

/** The whole moment on the factory's clock, for a tooltip: "Sat, Oct 10, 2026, 08:00 factory time". */
export function factoryTimestamp(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const text = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d)
  return `${text} factory time`
}

const WALL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/

const clockOf = (timeZone: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })

/** How far the zone's clock is ahead of UTC at an instant, in ms. */
function offsetAt(at: number, timeZone: string): number {
  const parts = clockOf(timeZone).formatToParts(new Date(at))
  const n = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  const wall = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'))
  return wall - Math.floor(at / 1000) * 1000
}

/** An instant as the factory's clock reads it, for a date-and-time field: "YYYY-MM-DDTHH:MM". */
export function factoryWallTime(iso: string, timeZone: string): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ''
  return new Date(at + offsetAt(at, timeZone)).toISOString().slice(0, 16)
}

/**
 * The instant the factory's clock reads as this wall time ("YYYY-MM-DDTHH:MM"),
 * as an ISO timestamp; null for anything else. Across a clock change the
 * offset is the one in force at the answer: an hour the clock reads twice is
 * its first time, and an hour it skips reads as the same minutes just after
 * the change (02:30 on a night that jumps from 02:00 to 03:00 is 03:30).
 */
export function factoryInstant(wall: string, timeZone: string): string | null {
  const m = WALL.exec(wall)
  if (!m) return null
  const [y, mo, d, h, mi] = m.slice(1).map(Number)
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null
  const asUtc = Date.UTC(y, mo - 1, d, h, mi)
  if (new Date(asUtc).getUTCDate() !== d) return null
  const o1 = offsetAt(asUtc, timeZone)
  const t1 = asUtc - o1
  const o2 = offsetAt(t1, timeZone)
  if (o2 === o1) return new Date(t1).toISOString()
  const t2 = asUtc - o2
  // The offset holds at the second guess: that is the instant. Otherwise the wall time falls in a skipped hour.
  return new Date(offsetAt(t2, timeZone) === o2 ? t2 : Math.max(t1, t2)).toISOString()
}
