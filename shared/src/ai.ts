// ============================================================================
// §20 — the AI assistant. An administrator asks about the factory's record in
// plain words; Claude answers by running read-only SQL over curated views of
// that record (schema `ai`), and every query it ran is shown with its result
// and can be taken to Excel. The assistant reads; it never writes.
//
// What it costs is counted on every call to the model and held to a monthly
// cap an administrator sets, so the bill cannot run away.
// ============================================================================

import type { ApiErrorCode } from './api'
import type { AiAutomationPart } from './automation'
import type { AiNoticePart } from './noticeAssistant'

/** The model the assistant runs on. */
export const AI_MODEL = 'claude-sonnet-5-5'

/** Out of the box: on once a key is set, at most $50 a month. */
export const AI_DEFAULT_MONTHLY_CAP_USD = 50
/** The most a cap may be set to: a typo of an extra zero or two stays bounded. */
export const AI_MAX_MONTHLY_CAP_USD = 2000

/** The longest question one message may carry. */
export const AI_MAX_MESSAGE_CHARS = 4000
/** Rows of a query the model reads and the answer's card shows. */
export const AI_PREVIEW_ROWS = 200
/** Rows an Excel export of a query takes at most. */
export const AI_EXPORT_MAX_ROWS = 50_000

/** USD per million tokens, by model, as Anthropic bills them. */
export interface AiPrice {
  input: number
  output: number
  /** Writing the prompt cache, five-minute lifetime. */
  cacheWrite5m: number
  /** Writing the prompt cache, one-hour lifetime. */
  cacheWrite1h: number
  cacheRead: number
  /** Rates for a call whose prompt (input, cache reads and writes together) is above `aboveInputTokens`. */
  long?: { aboveInputTokens: number; input: number; output: number; cacheWrite5m: number; cacheWrite1h: number; cacheRead: number }
}

export const AI_PRICES: Readonly<Record<string, AiPrice>> = {
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2 },
  // A refusal may be rescued by another model, billed at its own rates: Sonnet 5.5's is Sonnet 5.
  'claude-sonnet-5': { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2 },
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2 },
  // Opus 5.5's and Fable 5.1's are Opus 5 or Opus 4.8, at the same rates.
  'claude-opus-5': { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  'claude-fable-5-1': { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 0.25 },
  // Haiku 5.5 is billed at a fifth of its long-prompt rate up to 100K prompt tokens; cache at the usual 1.25×/2×/0.1×.
  'claude-haiku-5-5': {
    input: 0.1,
    output: 0.5,
    cacheWrite5m: 0.125,
    cacheWrite1h: 0.2,
    cacheRead: 0.01,
    long: { aboveInputTokens: 100_000, input: 0.5, output: 2.5, cacheWrite5m: 0.625, cacheWrite1h: 1, cacheRead: 0.05 },
  },
}

/** A model not in the table is counted at the dearest known rates: the cap errs on the safe side. */
export const AI_UNKNOWN_MODEL_PRICE: AiPrice = AI_PRICES['claude-fable-5-1']

export interface AiTokenUsage {
  inputTokens: number
  outputTokens: number
  cacheWrite5mTokens: number
  cacheWrite1hTokens: number
  cacheReadTokens: number
}

/** What a call costs, in USD, at the model's rates. */
export function aiCostUsd(model: string, u: AiTokenUsage): number {
  const base = AI_PRICES[model] ?? AI_UNKNOWN_MODEL_PRICE
  const prompt = u.inputTokens + u.cacheReadTokens + u.cacheWrite5mTokens + u.cacheWrite1hTokens
  const price = base.long && prompt > base.long.aboveInputTokens ? base.long : base
  const usd =
    (u.inputTokens * price.input +
      u.outputTokens * price.output +
      u.cacheWrite5mTokens * price.cacheWrite5m +
      u.cacheWrite1hTokens * price.cacheWrite1h +
      u.cacheReadTokens * price.cacheRead) /
    1_000_000
  return Math.round(usd * 1_000_000) / 1_000_000
}

// ---- Models, effort and data, as the owner gives them to each person ------------------

/** The models the owner may give a person, cheapest first. */
export const AI_MODELS = [
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', note: 'Fastest and cheapest; fine for simple counts and lists.' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', note: 'The balance of speed, cost and judgement. The default.' },
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', note: 'Stronger reasoning for harder analysis; about twice Sonnet\'s cost.' },
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', note: 'The most capable, and by far the dearest.' },
] as const

export type AiModelId = (typeof AI_MODELS)[number]['id']
export const AI_MODEL_IDS: readonly AiModelId[] = AI_MODELS.map((m) => m.id)
export const isAiModel = (v: string): v is AiModelId => (AI_MODEL_IDS as readonly string[]).includes(v)

/**
 * Where Anthropic hands a request a model refuses, on the server (fallbacks
 * "default", which picks one by the refusal's category). The fallback's
 * attempt is billed at its own rates on top of the refused one, so the most
 * a call may cost counts both. Haiku 5.5 has no server-side fallback.
 */
export const AI_FALLBACK_MODELS: Readonly<Record<AiModelId, readonly string[]>> = {
  'claude-haiku-5-5': [],
  'claude-sonnet-5-5': ['claude-sonnet-5'],
  'claude-opus-5-5': ['claude-opus-5', 'claude-opus-4-8'],
  'claude-fable-5-1': ['claude-opus-5', 'claude-opus-4-8'],
}

/** The most output one call to the model may write (the answer loop's max_tokens). */
export const AI_CALL_OUTPUT_TOKENS = 32_000

/**
 * The least any call's worst case may cost on a model: its whole output, and
 * the dearest fallback's whole output where the model has one. A monthly cap
 * below it (rounded up to the cent, see aiMinCapUsd) can never let a question
 * start. A model this file does not know is counted at the dearest rates.
 */
export function aiMinCallUsd(model: string): number {
  const out = (m: string) => (AI_CALL_OUTPUT_TOKENS * (AI_PRICES[m] ?? AI_UNKNOWN_MODEL_PRICE).output) / 1_000_000
  const fallbacks = isAiModel(model) ? AI_FALLBACK_MODELS[model] : []
  // To the millionth of a dollar, as costs are kept: 0.64 + 0.8 is 1.44, not 1.4400000000000002.
  return Math.round((out(model) + (fallbacks.length > 0 ? Math.max(...fallbacks.map(out)) : 0)) * 1_000_000) / 1_000_000
}

/** The least a monthly cap may be for a person on this model to ask at all, in whole cents. */
export function aiMinCapUsd(model: string): number {
  // Whole millionths first, so a rate like 0.1 cannot round a cent too far.
  return Math.ceil(Math.round(aiMinCallUsd(model) * 1_000_000) / 10_000) / 100
}

/** How much thought a model gives each answer: more is slower and costs more. */
export const AI_EFFORTS = [
  { id: 'low', name: 'Low', note: 'Quickest and cheapest.' },
  { id: 'medium', name: 'Medium', note: 'The default: enough for most questions.' },
  { id: 'high', name: 'High', note: 'More careful on harder analysis.' },
  { id: 'xhigh', name: 'Extra high', note: 'Slower; for involved, multi-step questions.' },
  { id: 'max', name: 'Max', note: 'The most thorough and the most expensive.' },
] as const

export type AiEffort = (typeof AI_EFFORTS)[number]['id']
export const AI_EFFORT_IDS: readonly AiEffort[] = AI_EFFORTS.map((e) => e.id)
export const isAiEffort = (v: string): v is AiEffort => (AI_EFFORT_IDS as readonly string[]).includes(v)

/** What a person may ask about. The database itself enforces it, not the model. */
export const AI_DOMAINS = [
  { id: 'inspection', name: 'Inspections', note: 'Sessions, samples, defects, measurements, PT, holds, production.' },
  { id: 'orders', name: 'Orders and PDI', note: 'The order sheet (Access), its lines and quantities, PDI documents.' },
  { id: 'materials', name: 'Coils, suppliers and master data', note: 'The coil register, suppliers, item dimensions, defect lists, PT products, work instructions.' },
  { id: 'audit', name: 'Audit log and accounts', note: 'Who changed what and when; the list of accounts and roles.' },
] as const

export type AiDomain = (typeof AI_DOMAINS)[number]['id']
export const AI_DOMAIN_IDS: readonly AiDomain[] = AI_DOMAINS.map((d) => d.id)
export const isAiDomain = (v: string): v is AiDomain => (AI_DOMAIN_IDS as readonly string[]).includes(v)

/** A person's use of the assistant, as the owner set it. */
export interface AiAccess {
  userId: string
  name: string
  username: string
  role: string
  /** The account can sign in. */
  active: boolean
  enabled: boolean
  domains: AiDomain[]
  model: AiModelId
  effort: AiEffort
  /** USD per calendar month (UTC). */
  monthlyCapUsd: number
  /** This calendar month (UTC), so far. */
  spentUsd: number
  /** The owner's own row. */
  owner: boolean
  /** May create automations (§21); always true for the owner. */
  automations: boolean
  /** May have the assistant add, change, withdraw and delete notices (§23). Takes effect only while the account is an administrator. */
  notices: boolean
  updatedAt?: string
  updatedByName?: string
}

export interface AiAccessListResponse {
  people: AiAccess[]
}

export interface AiAccessRequest {
  enabled: boolean
  domains: AiDomain[]
  model: AiModelId
  effort: AiEffort
  monthlyCapUsd: number
  /** May create automations (§21). Absent: unchanged (false for a new row). */
  automations?: boolean
  /** May manage notices through the assistant (§23), while an administrator. Absent: unchanged (false for a new row). */
  notices?: boolean
}

/** What anyone signed in learns about the assistant: no amounts, no models, no settings. */
export type AiMeReason = 'not-granted' | 'personal-cap' | 'cap-reached' | 'unavailable'

export interface AiMeResponse {
  /** The owner gave this person the assistant: show it. */
  granted: boolean
  /** This person controls the assistant. */
  owner: boolean
  /** It can answer now. */
  available: boolean
  reason?: AiMeReason
  /** May create automations (§21): the owner, and people the owner allowed. */
  automations: boolean
}

// ---- Settings ----------------------------------------------------------------

export interface AiSettings {
  /** Off: nobody can ask, whatever the key and the cap. */
  enabled: boolean
  /** USD per calendar month (UTC, as Anthropic bills); reached, the assistant stops until the 1st. */
  monthlyCapUsd: number
}

export const AI_DEFAULT_SETTINGS: AiSettings = { enabled: true, monthlyCapUsd: AI_DEFAULT_MONTHLY_CAP_USD }

/** The API key, as far as anyone may see it: whether there is one, where from, and its last four characters. */
export interface AiKeyState {
  set: boolean
  /** `environment`: the server's ANTHROPIC_API_KEY, which wins over a key set here. */
  source: 'environment' | 'app' | null
  last4?: string
  updatedAt?: string
  updatedByName?: string
  /** A key set here that can no longer be read (the server's secret changed): set it again. */
  unreadable?: boolean
  /** With the environment's key in use: a key also set here, kept for when the server has none. */
  stored?: { last4: string; updatedAt: string; updatedByName: string; unreadable?: boolean } | null
}

export interface AiSetKeyRequest {
  apiKey: string
}

/** Why the assistant cannot answer now, when it cannot. */
export type AiUnavailableReason = 'no-key' | 'disabled' | 'reader-unavailable' | 'cap-reached'

export interface AiStatusResponse {
  available: boolean
  reason?: AiUnavailableReason
  model: string
  /** This calendar month (UTC), so far. */
  spentUsd: number
  capUsd: number
  /** The first instant of the month counted, ISO. */
  monthStart: string
}

export interface AiSettingsResponse {
  settings: AiSettings
  key: AiKeyState
  status: AiStatusResponse
  updatedAt?: string
  updatedByName?: string
}

// ---- Conversations -------------------------------------------------------------

export interface AiConversation {
  id: string
  /** The first question, shortened. */
  title: string
  createdAt: string
  lastMessageAt: string
}

export interface AiConversationsResponse {
  conversations: AiConversation[]
  hasMore: boolean
}

export type AiCell = string | number | boolean | null

/** A query the assistant ran, with what came back. */
export interface AiQueryPart {
  type: 'query'
  queryId: string
  /** What the query looks for, in the asker's language. */
  purpose: string
  sql: string
  ok: boolean
  columns: string[]
  /** The first AI_PREVIEW_ROWS rows. */
  rows: AiCell[][]
  /** Rows shown; with `truncated`, more matched. */
  rowCount: number
  truncated: boolean
  ms: number
  error?: string
  /** How the model asked for the result to be drawn, checked against its columns. */
  chart?: AiChartSpec
}

export type AiChartType = 'bar' | 'line' | 'area' | 'pie' | 'stacked-bar'
export const AI_CHART_TYPES: readonly AiChartType[] = ['bar', 'line', 'area', 'pie', 'stacked-bar']

/** A chart of a query's result: `x` the category or day column, `y` 1–4 numeric columns, `series` a column to split by (long to wide). */
export interface AiChartSpec {
  type: AiChartType
  x: string
  y: string[]
  series?: string
  title?: string
}

export type AiKpiTrend = 'up-good' | 'up-bad' | 'down-good' | 'down-bad' | 'flat'
export const AI_KPI_TRENDS: readonly AiKpiTrend[] = ['up-good', 'up-bad', 'down-good', 'down-bad', 'flat']

/** A headline figure of an answer, as the model put it at the top. */
export interface AiKpi {
  label: string
  value: string
  trend?: AiKpiTrend
}

/** An answer's pieces in order. An automation proposal (§21) and a notice card (§23) are cards the person applies or discards. */
export type AiPart = { type: 'text'; text: string } | AiQueryPart | AiAutomationPart | AiNoticePart

/** How an answer ended. */
export type AiStopReason =
  /** Answered. */
  | 'end_turn'
  /** Cut at the length a reply may take. */
  | 'max_tokens'
  /** The model declined. */
  | 'refusal'
  /** The asker pressed Stop, or left. */
  | 'stopped'
  /** Too many queries or too long for one question. */
  | 'limit'
  /** The monthly cap was reached mid-answer. */
  | 'cap'
  | 'error'

export interface AiMessage {
  id: string
  role: 'user' | 'assistant'
  parts: AiPart[]
  createdAt: string
  /** An answer's cost, every call it took. */
  costUsd?: number
  stopReason?: AiStopReason
  /** A word on how an answer ended when it did not simply finish. */
  notice?: string
  /** The question and answer this message belongs to: what "Save as report" saves. */
  turnId?: string
  /** An answer's follow-up questions, as the model offered them (at most 3). */
  suggestions?: string[]
  /** An answer's headline figures, as the model put them at the top (at most 6). */
  kpis?: AiKpi[]
  /** The report this answer was saved as, when it was. */
  savedReportId?: string
}

export interface AiMessagesResponse {
  conversation: AiConversation
  messages: AiMessage[]
}

export interface AiChatRequest {
  /** Absent: a new conversation. */
  conversationId?: string
  message: string
  /** The sender's key for this send: sent twice, it is asked once. */
  clientId: string
}

/** The answer as it is written: one JSON object per Server-Sent Event, its `type` the event name. */
export type AiStreamEvent =
  | { type: 'start'; conversation: AiConversation; userMessageId: string }
  | { type: 'text'; delta: string }
  /** A line on what the model is doing between queries. */
  | { type: 'progress'; text: string }
  | { type: 'query_start'; queryId: string; purpose: string; sql: string }
  | { type: 'query_end'; part: AiQueryPart }
  /** A proposed automation (§21), checked and tried once. */
  | { type: 'automation'; part: AiAutomationPart }
  /** A notice card (§23): a new notice, a change, a withdrawal or a deletion, waiting for its button. */
  | { type: 'notice'; part: AiNoticePart }
  | { type: 'done'; message: AiMessage; status: AiStatusResponse }
  | { type: 'error'; code: ApiErrorCode; message: string }

/** A query of an answer run again in full, for Excel. */
export interface AiQueryExportResponse {
  purpose: string
  sql: string
  columns: string[]
  rows: AiCell[][]
  truncated: boolean
  ranAt: string
}

// ---- Usage -------------------------------------------------------------------------

export interface AiUsageResponse {
  /** YYYY-MM, UTC. */
  month: string
  spentUsd: number
  capUsd: number
  calls: number
  questions: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  byDay: { day: string; costUsd: number; calls: number }[]
  byUser: { userId: string; userName: string; costUsd: number; questions: number }[]
  /** Scheduled reports' summaries (§21), by automation. Also counted in byDay and in their creator's byUser. */
  byAutomation: { automationId: string; name: string; creatorName: string; costUsd: number; runs: number }[]
}

// ---- Saved reports -------------------------------------------------------------------

/** A report's period, kept as it was asked, so "last 30 days" stays the last 30 days. */
export type AiReportPeriod =
  | { kind: 'today' }
  | { kind: 'yesterday' }
  | { kind: 'last_days'; days: number }
  | { kind: 'this_week'; weekStart: AiWeekStart }
  | { kind: 'last_week'; weekStart: AiWeekStart }
  | { kind: 'this_month' }
  | { kind: 'last_month' }
  | { kind: 'this_year' }
  | { kind: 'last_year' }
  /** Dates the question named ("in September 2026"); still changeable when run. */
  | { kind: 'fixed'; from: string; to: string }

export type AiWeekStart = 'saturday' | 'sunday' | 'monday'

/** Factory days, YYYY-MM-DD, both inclusive. */
export interface AiDayRange {
  from: string
  to: string
}

export const AI_REPORT_MAX_DAYS = 3660

const DAY_MS = 86_400_000
const isYmd = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s
const toUtc = (ymd: string) => Date.parse(`${ymd}T00:00:00Z`)
const fromUtc = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const addDays = (ymd: string, n: number) => fromUtc(toUtc(ymd) + n * DAY_MS)
const WEEKDAY: Record<AiWeekStart, number> = { sunday: 0, monday: 1, saturday: 6 }

/** Whether a string is a real calendar day, YYYY-MM-DD. */
export const isAiDay = isYmd

/** The days a period covers, counted from `today` (a factory day, YYYY-MM-DD). */
export function resolveAiPeriod(period: AiReportPeriod, today: string): AiDayRange {
  if (!isYmd(today)) throw new Error(`Not a day: ${today}`)
  const [y, m] = today.split('-').map(Number)
  const firstOfMonth = (year: number, month: number) => fromUtc(Date.UTC(year, month - 1, 1))
  const lastOfMonth = (year: number, month: number) => fromUtc(Date.UTC(year, month, 0))
  switch (period.kind) {
    case 'today':
      return { from: today, to: today }
    case 'yesterday': {
      const d = addDays(today, -1)
      return { from: d, to: d }
    }
    case 'last_days': {
      const days = Math.min(Math.max(1, Math.floor(period.days)), AI_REPORT_MAX_DAYS)
      return { from: addDays(today, -(days - 1)), to: today }
    }
    case 'this_week':
    case 'last_week': {
      const weekday = new Date(toUtc(today)).getUTCDay()
      const back = (weekday - WEEKDAY[period.weekStart] + 7) % 7
      const start = addDays(today, -back)
      return period.kind === 'this_week' ? { from: start, to: today } : { from: addDays(start, -7), to: addDays(start, -1) }
    }
    case 'this_month':
      return { from: firstOfMonth(y, m), to: today }
    case 'last_month': {
      const py = m === 1 ? y - 1 : y
      const pm = m === 1 ? 12 : m - 1
      return { from: firstOfMonth(py, pm), to: lastOfMonth(py, pm) }
    }
    case 'this_year':
      return { from: `${y}-01-01`, to: today }
    case 'last_year':
      return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` }
    case 'fixed':
      return { from: period.from, to: period.to }
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const dayLabel = (ymd: string, withYear: boolean) => {
  const [y, m, d] = ymd.split('-').map(Number)
  return `${d} ${MONTHS[m - 1]}${withYear ? ` ${y}` : ''}`
}

/** A day range in words: "1 Sep – 30 Sep 2026", "9 Oct 2026". */
export function describeAiDays(r: AiDayRange): string {
  if (r.from === r.to) return dayLabel(r.from, true)
  const sameYear = r.from.slice(0, 4) === r.to.slice(0, 4)
  return `${dayLabel(r.from, !sameYear)} – ${dayLabel(r.to, true)}`
}

/** A period in words: "Last 30 days", "This month", "1 Sep – 30 Sep 2026". */
export function describeAiPeriod(period: AiReportPeriod): string {
  switch (period.kind) {
    case 'today':
      return 'Today'
    case 'yesterday':
      return 'Yesterday'
    case 'last_days':
      return period.days === 1 ? 'Today' : `Last ${period.days} days`
    case 'this_week':
      return 'This week'
    case 'last_week':
      return 'Last week'
    case 'this_month':
      return 'This month'
    case 'last_month':
      return 'Last month'
    case 'this_year':
      return 'This year'
    case 'last_year':
      return 'Last year'
    case 'fixed':
      return describeAiDays(period)
  }
}

export interface AiReportSection {
  /** The query's purpose, as the answer showed it. */
  title: string
  /** With an adjustable period, the SQL carries {{from}} and {{to}}. */
  sql: string
}

export interface AiReportSummary {
  id: string
  title: string
  question: string
  period: AiReportPeriod | null
  /** Whether the period can be changed when the report runs. */
  adjustable: boolean
  sectionCount: number
  createdAt: string
  updatedAt: string
  lastRunAt?: string
}

export interface AiReport extends AiReportSummary {
  conversationId?: string
  sections: AiReportSection[]
}

export interface AiReportsResponse {
  reports: AiReportSummary[]
  hasMore: boolean
}

export interface AiSaveReportRequest {
  turnId: string
  title?: string
  /** False: save the queries as they ran, with no model call to make the period changeable. */
  adjustable?: boolean
}

export interface AiSaveReportResponse {
  report: AiReport
  /** Why the period could not be made changeable, when it could not. */
  notice?: string
  status: AiStatusResponse
}

/** One section of a report, run. */
export interface AiReportSectionRun {
  title: string
  ok: boolean
  error?: string
  columns: string[]
  rows: AiCell[][]
  rowCount: number
  truncated: boolean
  ms: number
}

export interface AiReportRunResponse {
  report: AiReport
  /** The days it ran over, and whether they were chosen for this run. */
  period: (AiDayRange & { label: string; overridden: boolean }) | null
  sections: AiReportSectionRun[]
  ranAt: string
}

export interface AiReportExportResponse {
  report: AiReport
  period: (AiDayRange & { label: string; overridden: boolean }) | null
  sections: { title: string; ok: boolean; error?: string; columns: string[]; rows: AiCell[][]; truncated: boolean }[]
  ranAt: string
}

