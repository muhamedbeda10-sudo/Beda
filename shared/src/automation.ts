// ============================================================================
// §21 — automations. A person tells the assistant, in their own words, what
// to keep an eye on or what report to send; the assistant writes it down as a
// proposal, and nothing runs until a person presses Activate.
//
//   • A watch is a read-only query the server runs every few minutes, without
//     the model — around the clock, or only in the hours and on the days it
//     is given (factory time). Each row it returns is a case; each case
//     fires once.
//   • A scheduled report runs its queries at a factory-time hour and, when
//     asked, the model writes a short summary on top. Its queries are its
//     own sections, or one of the saved reports (My reports) as it stands
//     at each run, with the values its inputs take fixed in the schedule.
//
// What an automation may do is fixed: tell people (the bell, the chat), and
// open a follow-up — which also marks its session "Needs review" until it is
// closed. It never changes the factory's record.
// ============================================================================

import type { ResolvedReportStyle } from './reportStyles'
import type { AiCell, AiChartSpec, AiDayRange, AiReportPeriod, AiReportSectionRun } from './ai'
import type { AiReportInput, AiReportInputValues } from './aiReportInputs'
import type { Role } from './types'

// ---- Limits ------------------------------------------------------------------------

/** A watch runs at most this often. */
export const AUTOMATION_MIN_EVERY_MINUTES = 5
/** …and at least once a day. */
export const AUTOMATION_MAX_EVERY_MINUTES = 1440
export const AUTOMATION_DEFAULT_EVERY_MINUTES = 5
/** Automations one person may have (not counting deleted ones). */
export const AUTOMATION_MAX_PER_CREATOR = 50
/** Rows a watch's query may return in one run; more are not looked at (the run says so). */
export const AUTOMATION_WATCH_MAX_ROWS = 500
/** New cases notified one by one in a run; beyond this, one digest. */
export const AUTOMATION_STORM_LIMIT = 20
/** New cases notified one by one per automation in a factory day; beyond this, digests only. */
export const AUTOMATION_DAILY_CASE_LIMIT = 200
/** Follow-ups one run may open; the rest of the run's cases get none (the run says so). */
export const AUTOMATION_MAX_FOLLOW_UPS_PER_RUN = 50
/** Failed runs in a row after which a watch or report stops itself. */
export const AUTOMATION_FAILURES_BEFORE_STOP = 5
export const AUTOMATION_MAX_RECIPIENTS = 50
export const AUTOMATION_MAX_SECTIONS = 8
/** Rows of each section kept with a delivered report (what its page and Excel show). */
export const AUTOMATION_DELIVERY_MAX_ROWS = 2000
/** Sample cases a proposal's backtest shows. */
export const AUTOMATION_BACKTEST_SAMPLE_ROWS = 5
export const AUTOMATION_NAME_MAX = 120
export const AUTOMATION_DESCRIPTION_MAX = 1000
export const AUTOMATION_TEMPLATE_MAX = 300
export const FOLLOW_UP_MIN_DUE_HOURS = 1
export const FOLLOW_UP_MAX_DUE_HOURS = 24 * 30
export const FOLLOW_UP_COMMENT_MAX = 2000

// ---- Definition --------------------------------------------------------------------

export type AutomationKind = 'watch' | 'report'

/** The language the person wrote in: what the assistant writes titles and summaries in. */
export type AutomationLanguage = 'ar' | 'en'

/**
 * The hours of the factory day a watch runs in, HH:MM on the 24-hour clock:
 * from `from` (included) to `to` (not included). A `to` at or before `from`
 * crosses midnight — 22:00 to 06:00 is the night — and such a stretch
 * counts as the day it starts on.
 */
export interface AutomationHours {
  from: string
  to: string
}

/**
 * A watch. Its query runs under its creator's current data domains, like
 * their chat. `titleTemplate` and `bodyTemplate` carry `{{column}}`
 * placeholders filled from the case's row.
 */
export interface AutomationWatchSpec {
  sql: string
  /** The column that names a case: one value, one case, fired once. */
  keyColumn: string
  /** How often it looks, within its hours. */
  everyMinutes: number
  /** The hours it runs in (factory time); absent: around the clock. */
  hours?: AutomationHours
  /** The days it runs, 0 = Sunday … 6 = Saturday; absent: every day. */
  weekdays?: AutomationWeekday[]
  titleTemplate: string
  bodyTemplate?: string
  /** Columns whose values link a case to the app: an inspection session id, a sample id, an order number. */
  sessionColumn?: string
  sampleColumn?: string
  orderColumn?: string
}

export type AutomationCadence = 'daily' | 'weekly' | 'monthly'

/** 0 = Sunday … 6 = Saturday. */
export type AutomationWeekday = 0 | 1 | 2 | 3 | 4 | 5 | 6

export interface AutomationReportSection {
  title: string
  /** With a period, the SQL carries {{from}} and {{to}} like a saved report's. */
  sql: string
  /** How its result is drawn in the delivered report; checked against each run's result. */
  chart?: AiChartSpec
}

/**
 * A saved report a schedule sends: one of the reports its creator may open
 * (their own, or one shared), run as it stands at each run — a change to the
 * report reaches the next delivery. Its inputs take the values given here on
 * every run; one left out takes its default on the day of the run (this
 * week, this year, today).
 */
export interface AutomationSavedReport {
  reportId: string
  inputs: AiReportInputValues
}

/** The saved report a schedule sends, as a person reads it. */
export interface AutomationLinkedReport {
  id: string
  title: string
  /** Deleted, or no longer one its creator may open: the schedule's runs fail until it is changed. */
  missing: boolean
  /** What the report asks for, and the values the schedule gives (one left out: its default on the day). */
  inputs: AiReportInput[]
  values: AiReportInputValues
  sectionCount: number
}

/** A scheduled report: when it runs (factory time) and what it covers. */
export interface AutomationScheduleSpec {
  cadence: AutomationCadence
  /** HH:MM, 24-hour, factory time. */
  time: string
  /** daily: the days it runs (absent: every day). */
  weekdays?: AutomationWeekday[]
  /** weekly: the day it runs. */
  weekday?: AutomationWeekday
  /** monthly: 1–28. */
  monthDay?: number
  /**
   * The days its sections cover, counted from the factory day it runs on; absent: the sections take no period. With a
   * saved report: other days than the report's own (one whose period can change); absent, the report's.
   */
  period?: AiReportPeriod
  /** Its own sections; none when it sends a saved report. */
  sections: AutomationReportSection[]
  /** The saved report it sends, in place of sections of its own. */
  report?: AutomationSavedReport
  /** The assistant writes a short summary on top. */
  summary: boolean
}

/**
 * Who hears about it. A role means every active account of that role at
 * the time of the run; a column (watches only) means the people whose user
 * ids the case's row holds in that column — e.g. the sample's inspector.
 */
export type AutomationRecipient =
  | { kind: 'user'; userId: string }
  | { kind: 'role'; role: Role }
  | { kind: 'column'; column: string }

/** A recipient as the server shows it back, with a name to read. */
export type AutomationRecipientView = AutomationRecipient & {
  label: string
  /** A user who is no longer active, or a column the query no longer returns. */
  invalid?: boolean
}

export interface AutomationChannels {
  bell: boolean
  chat: boolean
}

/** Who a watch's follow-up goes to. */
export type AutomationAssignee =
  | { kind: 'user'; userId: string }
  | { kind: 'column'; column: string }
  | { kind: 'creator' }

export type AutomationAssigneeView = AutomationAssignee & { label: string; invalid?: boolean }

export interface AutomationFollowUpAction {
  assignee: AutomationAssignee
  /** The deadline, counted from the case. */
  dueHours: number
}

/** A watch's effects. A report always tells its recipients. */
export interface AutomationActions {
  /** Tell the recipients about each new case. */
  notify: boolean
  /** Open a follow-up per new case (its session, when known, shows "Needs review" until it is closed). */
  followUp: AutomationFollowUpAction | null
}

/** What the assistant proposed, as the propose_automation tool takes it. */
export interface AutomationDraft {
  kind: AutomationKind
  name: string
  /** In plain words: what it watches or reports, and what it does. */
  description: string
  language: AutomationLanguage
  /** kind 'watch' */
  watch?: AutomationWatchSpec
  /** kind 'report' */
  schedule?: AutomationScheduleSpec
  recipients: AutomationRecipient[]
  channels: AutomationChannels
  /** kind 'watch'; a report's is { notify: true, followUp: null }. */
  actions: AutomationActions
  /** A change to one of the person's automations: activating it updates that one (its fired cases are kept). */
  replacesAutomationId?: string
  /** A new version of a proposal of the same conversation not yet activated: that card is marked as replaced. */
  revisesProposalId?: string
}

// ---- Proposal (in the assistant's answer) ---------------------------------------------

/** What running a proposal once found. */
export interface AutomationBacktest {
  ranAt: string
  ok: boolean
  error?: string
  /** watch: the rows the query returns now — the cases that already match. */
  matched?: number
  /** watch: the query returned AUTOMATION_WATCH_MAX_ROWS rows or more. */
  truncated?: boolean
  columns?: string[]
  /** watch: up to AUTOMATION_BACKTEST_SAMPLE_ROWS of them. */
  sampleRows?: AiCell[][]
  /** watch: the first sample case's title and body, filled in. */
  sampleTitle?: string
  sampleBody?: string
  /** A change of a watch (replacesAutomationId): of the cases matching now, those its automation has not told yet. */
  newCases?: number
  /**
   * A change of a watch that keeps its query and key column: its cases carry
   * on — those told are not told again, those not told yet fire on its next
   * run — whatever notifyExisting says.
   */
  keepsCases?: boolean
  /** report: the period as of today and each section's result (preview rows). */
  period?: AiDayRange & { label: string }
  sections?: AiReportSectionRun[]
}

/** 'superseded': a newer version of it was proposed in the same conversation (revisesProposalId); it can no longer be activated. */
export type AutomationProposalState = 'proposed' | 'activated' | 'discarded' | 'superseded'

/** A proposal card in an answer. */
export interface AiAutomationPart {
  type: 'automation'
  proposalId: string
  /** The server accepted the draft. When not, `error` says why (the assistant was told too and usually tries again). */
  ok: boolean
  error?: string
  draft?: AutomationDraft
  recipients?: AutomationRecipientView[]
  assignee?: AutomationAssigneeView
  backtest?: AutomationBacktest
  state: AutomationProposalState
  /** Once activated. */
  automationId?: string
  /** The name of the automation it replaces, when it does. */
  replacesName?: string
  /** A report that sends a saved report: which, and the values it gives. */
  linkedReport?: AutomationLinkedReport
  /** A change still waiting: what it changes of that automation as it is now, a line each (none: nothing). */
  changes?: string[]
}

/** The fields a person may change outside the chat (the queries change only through the assistant). */
export interface AutomationEdits {
  name?: string
  description?: string
  recipients?: AutomationRecipient[]
  channels?: AutomationChannels
  actions?: AutomationActions
  /** watch */
  everyMinutes?: number
  /** watch: the hours it runs in; null: around the clock. */
  hours?: AutomationHours | null
  /** report */
  cadence?: AutomationCadence
  time?: string
  /** watch, or a daily report: the days it runs; null: every day. */
  weekdays?: AutomationWeekday[] | null
  weekday?: AutomationWeekday | null
  monthDay?: number | null
  period?: AiReportPeriod | null
  summary?: boolean
  /** A report sending a saved report: the values its inputs take on every run (one left out: its default on the day). */
  reportInputs?: AiReportInputValues
}

export interface AutomationActivateRequest {
  edits?: AutomationEdits
  /**
   * watch: also tell about the cases that match right now (otherwise they are
   * recorded as seen and only new ones fire). A change that keeps its query
   * and key column (backtest.keepsCases) records nothing: its cases carry on.
   */
  notifyExisting?: boolean
}

export interface AutomationActivateResponse {
  automation: Automation
  part: AiAutomationPart
}

export interface AutomationDiscardResponse {
  part: AiAutomationPart
}

// ---- Automations -------------------------------------------------------------------

/** Stored: on, paused by a person, or stopped by the server after failing runs. */
export type AutomationStatus = 'active' | 'paused' | 'failed'

/** Why an active automation does not run right now; it resumes on its own when this clears. */
export type AutomationBlockedReason =
  /** The creator's account is deactivated or removed. */
  | 'creator-inactive'
  /** The creator no longer has the assistant, or no data domain. */
  | 'no-access'
  /** The creator may no longer create automations. */
  | 'no-permission'
  /** The assistant is switched off or cannot read the data. */
  | 'unavailable'

export interface Automation {
  id: string
  kind: AutomationKind
  name: string
  description: string
  language: AutomationLanguage
  status: AutomationStatus
  blockedReason?: AutomationBlockedReason
  /** Why it failed (status 'failed'), or a word on its state. */
  statusNote?: string
  watch?: AutomationWatchSpec
  schedule?: AutomationScheduleSpec
  /** A report that sends a saved report: which, and the values it gives. */
  linkedReport?: AutomationLinkedReport
  recipients: AutomationRecipientView[]
  channels: AutomationChannels
  actions: AutomationActions
  assignee?: AutomationAssigneeView
  creator: { id: string; name: string }
  /** The conversation it was proposed in, when it still belongs to the viewer. */
  conversationId?: string
  createdAt: string
  updatedAt: string
  updatedByName?: string
  lastRunAt?: string
  lastRunOk?: boolean
  /** Why its last run failed, when it did (lastRunOk false). */
  lastRunError?: string
  /** When it runs next (null when it does not: paused, failed, blocked). */
  nextRunAt: string | null
  consecutiveFailures: number
  openFollowUps: number
}

export interface AutomationsResponse {
  automations: Automation[]
}

export type AutomationUpdateRequest = AutomationEdits

export type AutomationRunTrigger = 'schedule' | 'manual'

/** One run, as its history shows it. Never a cost. */
export interface AutomationRun {
  id: string
  automationId: string
  trigger: AutomationRunTrigger
  startedAt: string
  finishedAt: string | null
  ok: boolean | null
  error?: string
  ms?: number
  /** watch: rows the query returned. */
  matched?: number
  /** watch: cases seen for the first time. */
  fired?: number
  /** Bell alerts and chat messages the run sent, every one counted: a person may account for several (an alert per case, a digest, a chat message). Not people. */
  notified?: number
  followUps?: number
  /** The run's cases went out as one digest. */
  digest?: boolean
  /** A short word on anything left out (row cap, follow-up cap, recipients skipped, report without summary). */
  note?: string
  /** report: what was delivered. */
  deliveryId?: string
}

export interface AutomationRunsResponse {
  runs: AutomationRun[]
  hasMore: boolean
}

/** A dry run: what the automation would do now, without telling anyone or recording anything. */
export interface AutomationTestResponse {
  ranAt: string
  ok: boolean
  error?: string
  /** watch */
  matched?: number
  newCases?: number
  truncated?: boolean
  columns?: string[]
  sampleRows?: AiCell[][]
  sampleTitle?: string
  sampleBody?: string
  /** People it would tell now. */
  recipients?: number
  /** report: sections over the period as of today (no summary). */
  period?: AiDayRange & { label: string }
  sections?: AiReportSectionRun[]
}

/** A scheduled report as it was delivered: what its notification opens. */
export interface AutomationDelivery {
  id: string
  automationId: string
  automationName: string
  ranAt: string
  period: (AiDayRange & { label: string }) | null
  summary?: string
  /** Why there is no summary when one was asked for. */
  summaryNote?: string
  language: AutomationLanguage
  sections: AiReportSectionRun[]
  /** The saved report it was, when it sent one; `open`: the viewer may open it in My reports. */
  report?: { id: string; title: string; open: boolean }
  /** The values its inputs took on this run, as read. */
  inputs?: { label: string; value: string }[]
  /** The style it prints in: its saved report's, else the company's default; absent, the built-in look. */
  style?: ResolvedReportStyle
  /** Its saved report's Excel forms, filled from what was delivered. */
  forms?: { id: string; name: string }[]
}

/** People and roles a recipient can be. */
export interface AutomationPeopleResponse {
  people: { id: string; name: string; username: string; role: Role }[]
  roles: Role[]
}

// ---- Follow-ups --------------------------------------------------------------------

export type FollowUpStatus = 'open' | 'in_progress' | 'done'
export const FOLLOW_UP_STATUSES: readonly FollowUpStatus[] = ['open', 'in_progress', 'done']

export interface FollowUp {
  id: string
  automationId: string | null
  automationName: string
  caseKey: string
  title: string
  body: string
  status: FollowUpStatus
  assignee: { id: string; name: string } | null
  dueAt: string
  /** Not done and past its deadline. */
  overdue: boolean
  escalatedAt?: string
  sessionId?: string
  /** How the session reads in the app (order, item, machine). */
  sessionLabel?: string
  sampleId?: string
  orderNumber?: string
  /** The case's row when it fired. */
  caseColumns: string[]
  caseRow: AiCell[]
  createdAt: string
  updatedAt: string
  closedAt?: string
  closedByName?: string
  closingNote?: string
  commentCount: number
  /** What the viewer may do. */
  canEdit: boolean
  canReassign: boolean
}

export type FollowUpEventKind = 'comment' | 'status' | 'assignee' | 'due' | 'escalated' | 'created'

/** The follow-up's timeline: comments and what changed. */
export interface FollowUpEvent {
  id: string
  kind: FollowUpEventKind
  authorName: string
  body: string
  createdAt: string
}

export interface FollowUpDetail extends FollowUp {
  events: FollowUpEvent[]
}

export type FollowUpScope = 'mine' | 'all'

export interface FollowUpsResponse {
  followUps: FollowUp[]
  hasMore: boolean
}

export interface FollowUpCountsResponse {
  /** The follow-ups page has something for this person (they have follow-ups, or may see everyone's). */
  visible: boolean
  /** May see everyone's. */
  all: boolean
  mineOpen: number
  mineOverdue: number
}

export interface FollowUpUpdateRequest {
  status?: FollowUpStatus
  assigneeId?: string
  /** ISO timestamp. */
  dueAt?: string
  /** Required when status becomes 'done'. */
  closingNote?: string
}

export interface FollowUpCommentRequest {
  body: string
}

/**
 * The people a follow-up can be given to: every active account, viewers
 * included, never the system sender. Answered only to those who may reassign
 * a follow-up (supervisors, administrators, the assistant's owner, and anyone
 * who created an automation); to anyone else the endpoint does not exist.
 */
export interface FollowUpPeopleResponse {
  people: { id: string; name: string; username: string; role: Role }[]
}

// ---- Notifications (the bell) --------------------------------------------------------

export type UserNotificationKind =
  | 'automation-case'
  | 'automation-digest'
  | 'automation-report'
  | 'automation-stopped'
  | 'follow-up-assigned'
  | 'follow-up-overdue'
  | 'follow-up-updated'
  | 'task-assigned'
  | 'task-updated'
  | 'task-done'
  | 'task-reopened'
  /** An answer of the AI assistant finished while its asker was not watching it. */
  | 'ai-answer'
  /** A saved report was shared with the person (directly, or with their role): it opens on the Reports page. */
  | 'report-shared'
  /** §25 — planning: the automatic plan's late lines rose, or a machine is loaded past its hours (Planning → Settings says when). */
  | 'planning-alert'
  /** §27 — receiving: a delivery note awaits quality's decision, or quality decided one the person sent. */
  | 'receiving'

export interface UserNotification {
  id: string
  kind: UserNotificationKind
  severity: 'info' | 'warning' | 'critical'
  title: string
  body: string
  /** A path in the app to open, e.g. /follow-ups/<id>, /sessions/<id>, /automations/deliveries/<id>. */
  link: string | null
  createdAt: string
  readAt: string | null
}

export interface UserNotificationsResponse {
  notifications: UserNotification[]
  unreadCount: number
  hasMore: boolean
}

/**
 * The bell's two lists of these: Reports, the scheduled reports delivered and
 * the saved reports shared with the person, and Alerts, everything else (a report that stopped is an alert: someone has to
 * act on it). Each lists, counts and is read in full on its own.
 */
export type UserNotificationCategory = 'alerts' | 'reports'

export const USER_NOTIFICATION_CATEGORIES = ['alerts', 'reports'] as const satisfies readonly UserNotificationCategory[]

/** The kinds the Reports list holds; every other kind is an alert. */
export const REPORT_NOTIFICATION_KINDS: readonly UserNotificationKind[] = ['automation-report', 'report-shared']

export const notificationCategory = (kind: UserNotificationKind): UserNotificationCategory => (REPORT_NOTIFICATION_KINDS.includes(kind) ? 'reports' : 'alerts')

// ---- Wording -----------------------------------------------------------------------

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const

export const isAutomationTime = (s: string): boolean => /^([01]\d|2[0-3]):[0-5]\d$/.test(s)

export const isAutomationWeekday = (n: unknown): n is AutomationWeekday => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 6

/** Two HH:MM times that differ: a stretch of the day (one crossing midnight when `to` comes first). */
export const isAutomationHours = (h: unknown): h is AutomationHours => {
  if (!h || typeof h !== 'object') return false
  const { from, to } = h as { from?: unknown; to?: unknown }
  return typeof from === 'string' && typeof to === 'string' && isAutomationTime(from) && isAutomationTime(to) && from !== to
}

export function weekdayName(d: AutomationWeekday): string {
  return WEEKDAY_NAMES[d]
}

const ordinal = (n: number): string => {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th'
  return `${n}${s}`
}

/** "Every 5 minutes", "Every hour", "Every 2 hours 30 minutes", "Once a day". */
export function describeWatchInterval(everyMinutes: number): string {
  if (everyMinutes >= 1440) return 'Once a day'
  const h = Math.floor(everyMinutes / 60)
  const m = everyMinutes % 60
  if (h === 0) return `Every ${m} minute${m === 1 ? '' : 's'}`
  if (m === 0) return h === 1 ? 'Every hour' : `Every ${h} hours`
  return `Every ${h} hour${h === 1 ? '' : 's'} ${m} minute${m === 1 ? '' : 's'}`
}

/** Whether a list of days means every day: none given, or all seven. */
export const isEveryDay = (weekdays: readonly AutomationWeekday[] | undefined | null): boolean => {
  const n = new Set(weekdays ?? []).size
  return n === 0 || n === 7
}

/** "Every day" (none or all seven given), "Every Sunday", "Saturday to Thursday" (a run of days, wrapping past Saturday), "Sunday, Tuesday, Thursday". */
export function describeWeekdays(weekdays: readonly AutomationWeekday[] | undefined | null): string {
  if (isEveryDay(weekdays)) return 'Every day'
  const days = [...new Set(weekdays ?? [])].sort((a, b) => a - b)
  if (days.length === 1) return `Every ${weekdayName(days[0])}`
  // A run of consecutive days, wrapping past Saturday (e.g. Saturday to Thursday), reads as a range.
  const set = new Set(days)
  const start = days.find((d) => !set.has(((d + 6) % 7) as AutomationWeekday))
  if (start !== undefined) {
    let end = start
    let count = 1
    while (set.has(((end + 1) % 7) as AutomationWeekday) && count < days.length) {
      end = ((end + 1) % 7) as AutomationWeekday
      count++
    }
    if (count === days.length && count >= 3) return `${weekdayName(start)} to ${weekdayName(end)}`
  }
  return days.map((d) => weekdayName(d)).join(', ')
}

/** "05:00 to 10:00"; "22:00 to 06:00" (the night: it crosses midnight). */
export const describeHours = (h: AutomationHours): string => `${h.from} to ${h.to}`

/**
 * When a watch looks: "Every 5 minutes", "Every 5 minutes from 05:00 to
 * 10:00", "Every 5 minutes, Saturday to Thursday", "Every hour from 22:00 to
 * 06:00, Monday to Friday". Times are the factory's.
 */
export function describeWatchTiming(w: Pick<AutomationWatchSpec, 'everyMinutes' | 'hours' | 'weekdays'>): string {
  let out = describeWatchInterval(w.everyMinutes)
  if (w.hours) out += ` from ${describeHours(w.hours)}`
  if (!isEveryDay(w.weekdays)) out += `, ${describeWeekdays(w.weekdays)}`
  return out
}

/** "Every day at 08:00", "Saturday to Thursday at 07:30", "Every Sunday at 09:00", "On the 1st of every month at 08:00". */
export function describeSchedule(s: Pick<AutomationScheduleSpec, 'cadence' | 'time' | 'weekdays' | 'weekday' | 'monthDay'>): string {
  if (s.cadence === 'weekly') return `Every ${weekdayName(s.weekday ?? 0)} at ${s.time}`
  if (s.cadence === 'monthly') return `On the ${ordinal(s.monthDay ?? 1)} of every month at ${s.time}`
  return `${describeWeekdays(s.weekdays)} at ${s.time}`
}

/** The column names a template refers to, in order, once each. */
export function templatePlaceholders(template: string): string[] {
  const out: string[] = []
  for (const m of template.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) if (!out.includes(m[1])) out.push(m[1])
  return out
}

/** A template filled from a row: `{{column}}` → the cell as text ('' for null); an unknown column stays as written. */
export function renderAutomationTemplate(template: string, columns: readonly string[], row: readonly AiCell[]): string {
  return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (whole, name: string) => {
    const i = columns.indexOf(name)
    if (i < 0) return whole
    const v = row[i]
    return v === null || v === undefined ? '' : String(v)
  })
}
