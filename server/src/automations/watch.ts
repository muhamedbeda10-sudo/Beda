// ============================================================================
// §21 — one run of a watch. Its query runs in the sandbox as its creator's
// current domains, no model involved; each row it returns is a case, named by
// its key column, and each case fires once (ai_automation_hits, unique per
// automation and key). For the cases seen for the first time, in one
// transaction with recording them — so a run that fails half way tells
// nobody and leaves them for the next one:
//
//   • a follow-up each (up to AUTOMATION_MAX_FOLLOW_UPS_PER_RUN), when the
//     watch opens them, and its assignee an alert that it is theirs;
//   • the bell: one alert per case, as long as the run has no more than
//     AUTOMATION_STORM_LIMIT new cases and the automation stays within
//     AUTOMATION_DAILY_CASE_LIMIT cases told one by one in the factory's day;
//     beyond either, each person gets one digest of the run's cases instead
//     (an assignee, one more of the follow-ups now theirs). A person told a
//     case is theirs to follow up is not told it again as a new case;
//   • the chat: one message per person per run, listing their new cases.
//
// People named by a column of the result (the inspector of each case) hear
// about their own cases only, digests included; a value that is not a live
// account is passed over. Each person's links lead where they may look: the
// follow-up when they may see it, otherwise the session, otherwise the
// automation's page for its creator and the owner — and for anyone else no
// link, the alert's words being all there is. Nothing here changes the
// factory's record.
// ============================================================================

import type pg from 'pg'
import type { AiCell } from '@qc/shared/ai'
import {
  AUTOMATION_DAILY_CASE_LIMIT,
  AUTOMATION_MAX_FOLLOW_UPS_PER_RUN,
  AUTOMATION_STORM_LIMIT,
  AUTOMATION_WATCH_MAX_ROWS,
  type AutomationBlockedReason,
  type AutomationWatchSpec,
} from '@qc/shared/automation'
import type { Role } from '@qc/shared/types'
import { withTransaction, type Db, type Queryable } from '../db/pool'
import { runReadOnlyQuery, type QueryRun } from '../ai/runQuery'
import { assignedNotification, followUpLink, followUpsOfLink, openFollowUps, type NewFollowUp } from './followUps'
import { createNotifications, type NewNotification } from './notify'
import { activeUserIds, distinctIds } from './people'
import { factoryDayStart } from './schedule'
import { sendSystemMessageBatch } from './systemChat'
import { fillCaseTemplate, isolate } from './text'
import { AUTOMATION_QUERY_TIMEOUT_MS, caseKey, queryErrorForPeople } from './validate'
import type { AutomationRow } from './views'

/** Why the engine aborts the runs under way when the server stops: each is handed back, to run again at once elsewhere. */
export const STOPPING = 'stopping'

/** Whether a run's signal was aborted because the server is stopping (not by its time limit). */
export const isStopping = (signal: AbortSignal) => signal.aborted && signal.reason === STOPPING

/** What one run did, as its history records it. */
export interface RunResult {
  ok: boolean
  error?: string
  /** Its creator could no longer run it part way (a report between sections): not a failure; it waits, as a blocked one does. */
  blocked?: AutomationBlockedReason
  /** Stopped with the server before it told anyone: handed back, not a failure. */
  interrupted?: boolean
  matched?: number
  fired?: number
  notified: number
  followUps?: number
  /** Cases told one by one (what the daily limit counts). */
  casesNotified: number
  digest: boolean
  notes: string[]
  deliveryId?: string
  /** A watch's result columns, kept for checking later edits. */
  resultColumns?: string[]
}

/** A case of this run: its key, its row, what its messages say, and what it points at. */
export interface WatchCase {
  key: string
  row: AiCell[]
  title: string
  body: string
  /** The session its row names, when it names one. */
  sessionId?: string
  /** Its follow-up, opened by this run or an earlier one, and that follow-up's assignee. */
  followUpId?: string
  followUpAssigneeId?: string | null
  /** Its follow-up was opened by this run: its assignee is told it is theirs. */
  assignedNow?: boolean
}

export const automationLink = (id: string) => `/automations/${id}`
export const sessionLink = (id: string) => `/history?session=${id}`

/** A cell as a user id or a link target: text, or nothing. */
const cellText = (c: AiCell | undefined): string | null => (c === null || c === undefined || c === '' ? null : String(c))

/** The cases a result holds, in its order: rows without a key, and keys seen before in the same result, left out (and counted). */
export function casesOf(w: AutomationWatchSpec, run: QueryRun, name: string): { cases: WatchCase[]; noKey: number; repeated: number } | { error: string } {
  const at = run.columns.indexOf(w.keyColumn)
  if (at < 0) return { error: `The key column "${w.keyColumn}" is not in the query's result any more. Change the automation in the assistant.` }
  const session = w.sessionColumn ? run.columns.indexOf(w.sessionColumn) : -1
  const seen = new Set<string>()
  const cases: WatchCase[] = []
  let noKey = 0
  let repeated = 0
  for (const row of run.rows) {
    const key = caseKey(row[at])
    if (key === null) {
      noKey++
      continue
    }
    if (seen.has(key)) {
      repeated++
      continue
    }
    seen.add(key)
    const c: WatchCase = {
      key,
      row,
      title: fillCaseTemplate(w.titleTemplate, run.columns, row).replace(/\s+/g, ' ').trim() || name,
      body: w.bodyTemplate ? fillCaseTemplate(w.bodyTemplate, run.columns, row).trim() : '',
    }
    const sessionId = session >= 0 ? distinctIds([row[session]])[0] : undefined
    if (sessionId) c.sessionId = sessionId
    cases.push(c)
  }
  return { cases, noKey, repeated }
}

/** The people a case's row names in a column, as text (live accounts are checked by the caller). */
function columnPeople(columns: string[], row: AiCell[], recipientColumns: string[]): string[] {
  return distinctIds(recipientColumns.map((c) => row[columns.indexOf(c)]).filter((v) => v !== undefined))
}

/** How many cases this automation has told one by one since the factory's day began. */
async function toldToday(q: Queryable, automationId: string, now: Date, timeZone: string): Promise<number> {
  const { rows } = await q.query<{ n: number }>(
    `SELECT COALESCE(sum(cases_notified), 0)::int AS n FROM ai_automation_runs WHERE automation_id = $1 AND started_at >= $2`,
    [automationId, factoryDayStart(now, timeZone).toISOString()],
  )
  return rows[0].n
}

/** A list of case titles, at most AUTOMATION_STORM_LIMIT, then how many more. */
function titleLines(titles: string[]): string[] {
  const lines = titles.slice(0, AUTOMATION_STORM_LIMIT).map((t) => `• ${isolate(t)}`)
  if (titles.length > AUTOMATION_STORM_LIMIT) lines.push(`…and ${titles.length - AUTOMATION_STORM_LIMIT} more`)
  return lines
}

/**
 * One chat message listing a person's new cases: at most AUTOMATION_STORM_LIMIT
 * lines, each with where that person may open it (when anywhere), then how
 * many more, with where to see them all (when there is such a place for them).
 */
export function casesMessage(name: string, cases: { title: string; link: string | null }[], moreLink: string | null): string {
  const lines = [`${isolate(name)}: ${cases.length === 1 ? '1 new case' : `${cases.length} new cases`}`]
  for (const c of cases.slice(0, AUTOMATION_STORM_LIMIT)) lines.push(c.link ? `• ${isolate(c.title)} — ${c.link}` : `• ${isolate(c.title)}`)
  if (cases.length > AUTOMATION_STORM_LIMIT) {
    const more = cases.length - AUTOMATION_STORM_LIMIT
    lines.push(moreLink ? `…and ${more} more: ${moreLink}` : `…and ${more} more.`)
  }
  return lines.join('\n')
}

export interface WatchRunArgs {
  db: Db
  timeZone: string
  automation: AutomationRow
  runId: string
  /** The run's start, by the engine's clock. */
  now: Date
  /** The pool of the creator's domains now; null when there is none to run as. */
  pool: pg.Pool | null
  signal: AbortSignal
  /** The assistant's owner now, who (with the creator) may open the automation's page. */
  ownerId: string | null
}

export async function runWatch(args: WatchRunArgs): Promise<RunResult> {
  const a = args.automation
  const w = a.watch!
  const run = await runReadOnlyQuery(args.pool, w.sql, { maxRows: AUTOMATION_WATCH_MAX_ROWS, timeoutMs: AUTOMATION_QUERY_TIMEOUT_MS, timeZone: args.timeZone, signal: args.signal })
  const base: RunResult = { ok: false, notified: 0, casesNotified: 0, digest: false, notes: [] }
  if (!run.ok) return { ...base, error: queryErrorForPeople(run) }
  const found = casesOf(w, run, a.name)
  if ('error' in found) return { ...base, matched: run.rows.length, error: found.error, resultColumns: run.columns }
  const notes: string[] = []
  if (run.truncated) notes.push(`The query returned more than ${AUTOMATION_WATCH_MAX_ROWS} rows; only the first ${AUTOMATION_WATCH_MAX_ROWS} were looked at.`)
  if (found.noKey > 0) notes.push(`${found.noKey} row${found.noKey === 1 ? ' had' : 's had'} no key and ${found.noKey === 1 ? 'was' : 'were'} left out.`)
  if (found.repeated > 0) notes.push(`${found.repeated} row${found.repeated === 1 ? ' repeated a key' : 's repeated keys'} and ${found.repeated === 1 ? 'was' : 'were'} counted once.`)

  return withTransaction(args.db, async (tx) => {
    // The keys never seen before, claimed in one statement: a case fires once however runs overlap.
    const inserted = await tx.query<{ key: string }>(
      `INSERT INTO ai_automation_hits (automation_id, case_key, run_id, first_seen_at)
       SELECT $1, k, $2, $3 FROM unnest($4::text[]) AS k
       ON CONFLICT (automation_id, case_key) DO NOTHING
       RETURNING case_key AS key`,
      [a.id, args.runId, args.now.toISOString(), found.cases.map((c) => c.key)],
    )
    const fresh = new Set(inserted.rows.map((r) => r.key))
    const cases = found.cases.filter((c) => fresh.has(c.key))
    const result: RunResult = { ok: true, matched: run.rows.length, fired: cases.length, notified: 0, followUps: 0, casesNotified: 0, digest: false, notes, resultColumns: run.columns }
    if (cases.length === 0) return result

    if (a.actions.followUp) result.followUps = await openCaseFollowUps(tx, a, w, run.columns, cases, args.now, notes)
    await tellCases(tx, a, run.columns, cases, args, result)
    return result
  })
}

/** A follow-up per new case, up to the run's cap; each case then knows its follow-up and whether it was opened now. */
async function openCaseFollowUps(tx: Queryable, a: AutomationRow, w: AutomationWatchSpec, columns: string[], cases: WatchCase[], now: Date, notes: string[]): Promise<number> {
  const f = a.actions.followUp!
  const col = (name: string | undefined) => (name ? columns.indexOf(name) : -1)
  const at = { session: col(w.sessionColumn), sample: col(w.sampleColumn), order: col(w.orderColumn), assignee: f.assignee.kind === 'column' ? col(f.assignee.column) : -1 }
  const due = new Date(now.getTime() + f.dueHours * 3_600_000)
  const chosen = cases.slice(0, AUTOMATION_MAX_FOLLOW_UPS_PER_RUN)
  if (cases.length > chosen.length) notes.push(`Follow-ups were opened for the first ${chosen.length} new cases only; ${cases.length - chosen.length} got none.`)
  const items: NewFollowUp[] = chosen.map((c) => ({
    automationId: a.id,
    caseKey: c.key,
    title: c.title,
    body: c.body,
    assigneeId: f.assignee.kind === 'creator' ? a.creatorId : f.assignee.kind === 'user' ? f.assignee.userId : cellText(c.row[at.assignee]),
    dueAt: due,
    sessionId: at.session >= 0 ? cellText(c.row[at.session]) : null,
    sampleId: at.sample >= 0 ? cellText(c.row[at.sample]) : null,
    orderNumber: at.order >= 0 ? cellText(c.row[at.order]) : null,
    caseColumns: columns,
    caseRow: c.row,
  }))
  // The run tells the assignees itself, within the bell's limits, with the rest of what it tells.
  const opened = new Set(await openFollowUps(tx, items, { automationName: a.name, creatorId: a.creatorId, tellAssignees: false }))
  // Each case knows its follow-up, opened now or before, and whom it is with (as stored: an assignee who cannot be told leaves it unassigned).
  const { rows } = await tx.query<{ id: string; key: string; assigneeId: string | null }>(
    `SELECT id, case_key AS key, assignee_id AS "assigneeId" FROM follow_ups WHERE automation_id = $1 AND case_key = ANY($2::text[])`,
    [a.id, chosen.map((c) => c.key)],
  )
  const byKey = new Map(rows.map((r) => [r.key, r]))
  for (const c of chosen) {
    const fu = byKey.get(c.key)
    if (!fu) continue
    c.followUpId = fu.id
    c.followUpAssigneeId = fu.assigneeId
    if (opened.has(fu.id)) c.assignedNow = true
  }
  return opened.size
}

/** Someone the run tells, and what they may open. */
interface Person {
  id: string
  /** Sees every follow-up: a supervisor, an administrator, the assistant's owner. */
  seesAllFollowUps: boolean
  /** May open the automation's page: its creator and the owner. */
  opensAutomation: boolean
}

async function peopleOf(q: Queryable, ids: string[], a: AutomationRow, ownerId: string | null): Promise<Map<string, Person>> {
  if (ids.length === 0) return new Map()
  const { rows } = await q.query<{ id: string; role: Role }>(`SELECT id, role::text AS role FROM users WHERE id = ANY($1::uuid[])`, [ids])
  return new Map(
    rows.map((r) => [
      r.id,
      { id: r.id, seesAllFollowUps: r.role === 'supervisor' || r.role === 'admin' || r.id === ownerId, opensAutomation: r.id === a.creatorId || r.id === ownerId },
    ]),
  )
}

/** Where a case leads one person: its follow-up if they may see it, otherwise its session, otherwise the automation's page if they may open it. */
function caseLink(c: WatchCase, p: Person, a: AutomationRow): string | null {
  if (c.followUpId && (p.seesAllFollowUps || p.id === c.followUpAssigneeId || p.id === a.creatorId)) return followUpLink(c.followUpId)
  if (c.sessionId) return sessionLink(c.sessionId)
  if (p.opensAutomation) return automationLink(a.id)
  return null
}

/** Where a list of cases leads one person: the automation's page if they may open it, otherwise its follow-ups when some of them are theirs to see. */
function listLink(cases: WatchCase[], p: Person, a: AutomationRow): string | null {
  if (p.opensAutomation) return automationLink(a.id)
  if (cases.some((c) => c.followUpId && (p.seesAllFollowUps || p.id === c.followUpAssigneeId))) return followUpsOfLink(a.id)
  return null
}

/** Alerts to write, the same one for many people written once. */
class Alerts {
  private readonly groups = new Map<string, { n: NewNotification; userIds: string[] }>()

  /** `about` is what the alert tells (a case's key; a digest): two cases that read alike are still two alerts. */
  add(userId: string, n: NewNotification, about: string): void {
    const key = JSON.stringify([about, n.kind, n.title, n.body, n.link, n.followUpId ?? null])
    const g = this.groups.get(key)
    if (g) g.userIds.push(userId)
    else this.groups.set(key, { n, userIds: [userId] })
  }

  async write(q: Queryable): Promise<number> {
    let written = 0
    for (const { n, userIds } of this.groups.values()) written += await createNotifications(q, userIds, n)
    return written
  }
}

/**
 * The bell and the chat, for the run's new cases: the people the recipients
 * name told of theirs (when the watch notifies), and the assignees of the
 * follow-ups it opened told they are theirs.
 */
async function tellCases(tx: Queryable, a: AutomationRow, columns: string[], cases: WatchCase[], args: WatchRunArgs, result: RunResult): Promise<void> {
  const notify = a.actions.notify
  const users = a.recipients.flatMap((r) => (r.kind === 'user' ? [r.userId] : []))
  const roles = a.recipients.flatMap((r) => (r.kind === 'role' ? [r.role as Role] : []))
  const recipientColumns = a.recipients.flatMap((r) => (r.kind === 'column' ? [r.column] : []))
  const missing = recipientColumns.filter((c) => !columns.includes(c))
  if (notify && missing.length > 0) result.notes.push(`The result has no column ${missing.map((c) => `"${c}"`).join(', ')} to take people from.`)
  const everyone = notify ? await activeUserIds(tx, { userIds: users, roles }) : []
  // The people the cases name, each checked once.
  const named = new Set(notify ? await activeUserIds(tx, { userIds: cases.flatMap((c) => columnPeople(columns, c.row, recipientColumns)) }) : [])

  // Each person's cases, in the run's order: everyone named in the recipients hears of every case; a person named by a case's row, of theirs.
  const told = new Map<string, WatchCase[]>()
  const tell = (id: string, c: WatchCase) => {
    const list = told.get(id)
    if (list) list.push(c)
    else told.set(id, [c])
  }
  if (notify) {
    for (const c of cases) {
      for (const id of everyone) tell(id, c)
      for (const id of columnPeople(columns, c.row, recipientColumns)) if (named.has(id) && !everyone.includes(id)) tell(id, c)
    }
    if (told.size === 0) result.notes.push('Nobody to tell: none of the recipients is an active account.')
  }
  // The follow-ups opened now with someone to tell, by assignee.
  const assigned = new Map<string, WatchCase[]>()
  for (const c of cases) {
    if (!c.assignedNow || !c.followUpAssigneeId) continue
    const list = assigned.get(c.followUpAssigneeId)
    if (list) list.push(c)
    else assigned.set(c.followUpAssigneeId, [c])
  }
  if (told.size === 0 && assigned.size === 0) return
  const people = await peopleOf(tx, [...new Set([...told.keys(), ...assigned.keys()])], a, args.ownerId)
  const severity = a.actions.followUp ? 'warning' : 'info'
  const caseAlert = (c: WatchCase, p: Person): NewNotification => ({
    kind: 'automation-case',
    severity,
    title: c.title,
    body: c.body,
    link: caseLink(c, p, a),
    automationId: a.id,
    followUpId: c.followUpId,
  })
  const assignedAlert = (c: WatchCase) => assignedNotification({ id: c.followUpId!, title: c.title, body: c.body, automationId: a.id, automationName: a.name })

  if (a.channels.bell || assigned.size > 0) {
    const room = AUTOMATION_DAILY_CASE_LIMIT - (await toldToday(tx, a.id, args.now, args.timeZone))
    const oneByOne = cases.length <= AUTOMATION_STORM_LIMIT && cases.length <= room
    const alerts = new Alerts()
    const alone = new Set<string>()
    let digests = 0
    for (const p of people.values()) {
      const mine = assigned.get(p.id) ?? []
      // A case that is now theirs to follow up is told once: as theirs.
      const others = a.channels.bell ? (told.get(p.id) ?? []).filter((c) => !mine.includes(c)) : []
      if (oneByOne || mine.length === 1) {
        for (const c of mine) {
          alerts.add(p.id, assignedAlert(c), `case:${c.key}`)
          alone.add(c.key)
        }
      } else if (mine.length > 1) {
        alerts.add(
          p.id,
          {
            kind: 'follow-up-assigned',
            severity: 'warning',
            title: `${isolate(a.name)}: ${mine.length} follow-ups assigned to you`,
            body: titleLines(mine.map((c) => c.title)).join('\n'),
            link: followUpsOfLink(a.id),
            automationId: a.id,
          },
          'digest',
        )
        digests++
      }
      if (oneByOne || others.length === 1) {
        for (const c of others) {
          alerts.add(p.id, caseAlert(c, p), `case:${c.key}`)
          alone.add(c.key)
        }
      } else if (others.length > 1) {
        // One alert for the lot: how many, the first titles, and where they can be seen (when anywhere, for this person).
        alerts.add(
          p.id,
          {
            kind: 'automation-digest',
            severity,
            title: `${isolate(a.name)}: ${others.length} new cases`,
            body: titleLines(others.map((c) => c.title)).join('\n'),
            link: listLink(others, p, a),
            automationId: a.id,
          },
          'digest',
        )
        digests++
      }
    }
    result.notified += await alerts.write(tx)
    // What the day's limit counts: the cases told by an alert of their own.
    result.casesNotified = alone.size
    if (digests > 0) {
      result.digest = true
      result.notes.push(
        cases.length > AUTOMATION_STORM_LIMIT
          ? `${cases.length} new cases at once: the bell had one digest instead of an alert each.`
          : `The day's limit of ${AUTOMATION_DAILY_CASE_LIMIT} alerts one by one was reached: the bell had one digest.`,
      )
    }
  }

  if (notify && a.channels.chat && told.size > 0) {
    // One message per person, with their own links; written in one go, in one order (see sendSystemMessageBatch).
    const messages: { userId: string; body: string }[] = []
    for (const [id, list] of told) {
      const p = people.get(id)
      if (!p) continue
      messages.push({ userId: id, body: casesMessage(a.name, list.map((c) => ({ title: c.title, link: caseLink(c, p, a) })), listLink(list, p, a)) })
    }
    result.notified += await sendSystemMessageBatch(tx, messages)
  }
}
