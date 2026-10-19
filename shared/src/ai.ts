// ============================================================================
// §20 — the AI assistant. An administrator asks about the factory's record in
// plain words; Claude answers by running read-only SQL over curated views of
// that record (schema `ai`), and every query it ran is shown with its result
// and can be taken to Excel. The assistant reads; it never writes.
//
// What it costs is counted on every call to the model and held to a monthly
// cap an administrator sets, so the bill cannot run away.
// ============================================================================

import type { ResolvedReportStyle } from './reportStyles'
import type { ApiErrorCode } from './api'
import type { AiAutomationPart } from './automation'
import type { AiNoticePart } from './noticeAssistant'
import type { AiPlaybookPart } from './playbook'
import type { AiSavedTablePart } from './savedTables'
import type { AiExcelPart } from './aiExcel'
import type { AiDiagramPart } from './aiDiagram'
import type { AiReportInput, AiReportInputValues } from './aiReportInputs'

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

// ---- Attachments ------------------------------------------------------------------
//
// A question may carry files for Claude to read: photos (handwritten sheets
// too) and PDFs, sent as they are, and spreadsheets (.xlsx, .csv), read on the
// device into text. Each is counted in tokens when it is attached, on the
// model of the person attaching it, so the caps price it before it is sent.
// A conversation sends its files again with every question (read from the
// cache, at a tenth of the price), so it holds a bounded number of them.

export type AiAttachmentKind = 'image' | 'pdf' | 'sheet'
export const AI_ATTACHMENT_KINDS: readonly AiAttachmentKind[] = ['image', 'pdf', 'sheet']

/** Files one question may carry. */
export const AI_MAX_ATTACHMENTS_PER_QUESTION = 5
/** Files one conversation may carry in all (Claude reads at most 20 large images in one request). */
export const AI_MAX_ATTACHMENTS_PER_CONVERSATION = 20
/** A photo's long edge as it is sent: the most Claude reads, which handwriting needs. */
export const AI_IMAGE_LONG_EDGE = 2576
/** A photo's bytes after it is prepared on the device. */
export const AI_MAX_IMAGE_BYTES = 8 * 1024 * 1024
export const AI_MAX_PDF_BYTES = 15 * 1024 * 1024
/** The bytes of photos and PDFs one conversation carries: each request must stay well under Anthropic's 32 MB. */
export const AI_MAX_CONVERSATION_ATTACHMENT_BYTES = 18 * 1024 * 1024
/** A spreadsheet's text as Claude reads it. */
export const AI_MAX_SHEET_CHARS = 300_000
/** What one file may take of Claude's reading, in tokens (a PDF of roughly 60 pages and more is over it). */
export const AI_MAX_ATTACHMENT_TOKENS = 200_000
/** What the files of one conversation may take together. */
export const AI_MAX_CONVERSATION_ATTACHMENT_TOKENS = 400_000

/** A file attached to a question, as the app shows it. */
export interface AiAttachment {
  id: string
  kind: AiAttachmentKind
  /** The file's name as it was picked. */
  name: string
  byteSize: number
  /** What Claude reads of it, as counted when it was attached. */
  tokens: number
  /** A photo's size in pixels, as sent. */
  width?: number
  height?: number
  /** A photo's small preview (a JPEG data URL). */
  thumbnailDataUrl?: string
  /** A spreadsheet's outline: its sheets, rows and columns. */
  summary?: string
}

/** A spreadsheet read on the device, to attach. */
export interface AiSheetAttachmentRequest {
  name: string
  /** The sheets as text, as Claude will read them. */
  text: string
  /** Its sheets, rows and columns in a line, shown on its chip. */
  summary: string
}

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
  // Last on purpose: a set of domains is stored as bits in this order (the reader roles are named by them), so a new domain is appended.
  { id: 'production', name: 'Production record', note: "The ERP's production task record: what each machine made per day, by whom and in which shift, with hours, weights and lengths." },
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
  /** USD per calendar month (UTC). */
  monthlyCapUsd: number
  /** This calendar month (UTC), so far. */
  spentUsd: number
  /** The owner's own row. */
  owner: boolean
  /** May create automations (§21); always true for the owner. */
  automations: boolean
  /** May have the assistant add, change, withdraw and delete notices (§23). Takes effect only while the account may manage notices in the app (§14). */
  notices: boolean
  /** §14 — the account may manage notices in the app now (the Notices screen): the assistant's notices permission needs it. */
  managesNotices: boolean
  /** May have the assistant make Excel files (§20); always true for the owner. */
  excel: boolean
  /** May upload mill test certificates on the MTC tab, whether or not the assistant is on for them; always true for the owner. */
  mtc: boolean
  updatedAt?: string
  updatedByName?: string
}

export interface AiAccessListResponse {
  people: AiAccess[]
}

export interface AiAccessRequest {
  enabled: boolean
  domains: AiDomain[]
  monthlyCapUsd: number
  /** May create automations (§21). Absent: unchanged (false for a new row). */
  automations?: boolean
  /** May manage notices through the assistant (§23), while an administrator. Absent: unchanged (false for a new row). */
  notices?: boolean
  /** May have the assistant make Excel files (§20). Absent: unchanged (false for a new row). */
  excel?: boolean
  /** May upload mill test certificates (MTC tab). Absent: unchanged (false for a new row). */
  mtc?: boolean
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
  /** May have Excel from the assistant (§20): its files, and Excel of its queries, tables and reports. The owner, and people the owner allowed. */
  excel: boolean
  /** May have the assistant write notices (§23): an administrator by role now, given the assistant, the owner or allowed by the owner. */
  notices: boolean
  /** May upload mill test certificates on the MTC tab: the owner, and people the owner allowed, the assistant on for them or not. */
  mtc: boolean
}

// ---- Settings ----------------------------------------------------------------

export interface AiSettings {
  /** Off: nobody can ask, whatever the key and the cap. */
  enabled: boolean
  /** USD per calendar month (UTC, as Anthropic bills); reached, the assistant stops until the 1st. */
  monthlyCapUsd: number
}

/** PUT /ai/settings: the switch and the cap. */
export type AiSettingsRequest = AiSettings

// ---- Models by job ---------------------------------------------------------------------
//
// Which model and effort each job runs on is the app's, fixed here, not a
// setting: everything runs on Sonnet at high effort, and a chat question that
// needs heavy work (a root cause, an FMEA, an investigation over many steps) on
// Opus at high, as Sonnet decides by reading it first (the router). A
// certificate is read on Sonnet, and again on Opus when the first reading came
// back doubtful. Activity shows each question's model and why.

/** The model of every job but the heavy ones. */
export const AI_STANDARD_MODEL: AiModelId = 'claude-sonnet-5-5'
/** The model of a chat question that needs heavy work, and of a doubtful certificate's second reading. */
export const AI_DEEP_MODEL: AiModelId = 'claude-opus-5-5'
/** The effort of every job that thinks. */
export const AI_EFFORT: AiEffort = 'high'

export const AI_JOB_IDS = ['chat-standard', 'chat-deep', 'router', 'title', 'mtc', 'mtc-reread', 'report-template', 'report-summary', 'report-style', 'report-form'] as const
export type AiJob = (typeof AI_JOB_IDS)[number]

export interface AiJobRun {
  model: AiModelId
  effort: AiEffort
}

/** Each job's model and effort. The router and the titles do not think (server: noThinking, the request says so), so their effort is not sent. */
export const AI_JOBS: Readonly<Record<AiJob, AiJobRun>> = {
  'chat-standard': { model: AI_STANDARD_MODEL, effort: AI_EFFORT },
  'chat-deep': { model: AI_DEEP_MODEL, effort: AI_EFFORT },
  router: { model: AI_STANDARD_MODEL, effort: AI_EFFORT },
  title: { model: AI_STANDARD_MODEL, effort: AI_EFFORT },
  mtc: { model: AI_STANDARD_MODEL, effort: AI_EFFORT },
  'mtc-reread': { model: AI_DEEP_MODEL, effort: AI_EFFORT },
  'report-template': { model: AI_STANDARD_MODEL, effort: AI_EFFORT },
  'report-summary': { model: AI_STANDARD_MODEL, effort: AI_EFFORT },
  'report-style': { model: AI_STANDARD_MODEL, effort: AI_EFFORT },
  'report-form': { model: AI_STANDARD_MODEL, effort: AI_EFFORT },
}

/** A chat question's level, as the router gives it: standard (Sonnet) or deep (Opus). Questions with files too. */
export const AI_CHAT_LEVELS = ['chat-standard', 'chat-deep'] as const
export type AiChatLevel = (typeof AI_CHAT_LEVELS)[number]
/** The levels questions were answered at before the levels were fixed (simple, analysis, with files): kept on their turns. */
export type AiPastChatLevel = 'chat-simple' | 'chat-analysis' | 'chat-files'
/** A level a turn may carry. */
export type AiRecordedChatLevel = AiChatLevel | AiPastChatLevel

export const AI_LEVEL_NAMES: Readonly<Record<AiRecordedChatLevel, string>> = {
  'chat-standard': 'Standard',
  'chat-deep': 'Deep analysis',
  'chat-simple': 'Simple question',
  'chat-analysis': 'Analysis',
  'chat-files': 'Question with files',
}

/** The level a question takes when the router cannot be asked. */
export const AI_ROUTER_FALLBACK: AiChatLevel = 'chat-standard'

/**
 * A conversation's level only goes up (§20). The prompt cache — the
 * conversation so far, read again at a tenth of the price — is kept per model
 * and effort: a follow-up answered on Sonnet after Opus would pay for the whole
 * conversation again, and lose the stronger model's footing besides. So once a
 * conversation is deep it stays deep; otherwise the question takes the level
 * it wants. A conversation begun at a past level (all below Opus) goes on as
 * any other below it.
 */
export function stickyLevel(previous: AiRecordedChatLevel | null | undefined, wanted: AiChatLevel): AiChatLevel {
  return previous === 'chat-deep' ? 'chat-deep' : wanted
}

/** Deep already: nothing ranks above it, so the router need not be asked. */
export const isTopLevel = (level: AiRecordedChatLevel | null | undefined): boolean => level === 'chat-deep'

/** A certificate is doubtful when more than this share of its values came back unsure, or when nothing was listed: read again on Opus. */
export const AI_MTC_REREAD_SHARE = 0.3

export const AI_DEFAULT_SETTINGS: AiSettings = {
  enabled: true,
  monthlyCapUsd: AI_DEFAULT_MONTHLY_CAP_USD,
}

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
  /** The first question, shortened, or the name the person gave it. */
  title: string
  createdAt: string
  lastMessageAt: string
  /** When it was pinned to the top of the list; null when it is not. */
  pinnedAt: string | null
  /** The person's group it is in; null for none. */
  groupId: string | null
  /** When it was archived out of the list; null when it is in it. */
  archivedAt: string | null
  /** An answer is being written in it now, on the server: whether or not anyone is watching. */
  answering?: boolean
}

export interface AiConversationsResponse {
  conversations: AiConversation[]
  hasMore: boolean
}

/**
 * Which conversations a page of the list holds:
 *   • recent — in the list, neither pinned nor in a group;
 *   • pinned — pinned, the latest pinned first (all of them, in one page);
 *   • group — in one group (groupId), pinned or not;
 *   • archived — archived;
 *   • all — every one not archived (the list before groups).
 * All but pinned are the latest first, a page at a time.
 */
export type AiConversationScope = 'recent' | 'pinned' | 'group' | 'archived' | 'all'
export const AI_CONVERSATION_SCOPES: readonly AiConversationScope[] = ['recent', 'pinned', 'group', 'archived', 'all']

/** A conversation's title at most, in characters. */
export const AI_CONVERSATION_TITLE_MAX = 80
/** The longest title an answer is printed under. */
export const AI_ANSWER_REPORT_TITLE_MAX = 100

/**
 * The title an answer is printed under, as a report handed to management: named by the assistant once (kept with
 * the answer), else the conversation's title when it is not the question itself, else a plain "Quality report".
 */
export interface AiAnswerReportTitleResponse {
  title: string
  /** Named by the assistant for this answer (kept): false for a stand-in, asked again next time. */
  named: boolean
}
/** Conversations one person may have pinned at once. */
export const AI_MAX_PINNED_CONVERSATIONS = 30
/** A group's name at most, in characters. */
export const AI_CONVERSATION_GROUP_NAME_MAX = 60
/** Groups one person may have. */
export const AI_MAX_CONVERSATION_GROUPS = 100

/** A change to one conversation: what is given changes, the rest stays. */
export interface AiConversationUpdate {
  title?: string
  pinned?: boolean
  /** A group of the person's, or null to take it out of its group. */
  groupId?: string | null
  archived?: boolean
}

/** A person's group of conversations. */
export interface AiConversationGroup {
  id: string
  name: string
  /** Its conversations not archived. */
  conversationCount: number
  /** The latest message in any of them; null for an empty group. */
  lastMessageAt: string | null
  createdAt: string
}

export interface AiConversationGroupsResponse {
  groups: AiConversationGroup[]
}

/** The words searched for: at least this many characters, at most that many. */
export const AI_CONVERSATION_SEARCH_MIN = 2
export const AI_CONVERSATION_SEARCH_MAX = 100
/** Conversations one search returns at most. */
export const AI_CONVERSATION_SEARCH_LIMIT = 40

/** A conversation a search found: where the words are, and the words around them. */
export interface AiConversationSearchHit {
  conversation: AiConversation
  /** In its title, in a question asked in it, or in an answer (the latest such). */
  where: 'title' | 'question' | 'answer'
  /** For a question or an answer: the words around the match, cut with … where the text goes on. Empty for a title. */
  snippet: string
  /** Where the match is in the snippet (UTF-16 offsets), to mark it; null when it cannot be told. */
  match: { start: number; length: number } | null
}

export interface AiConversationSearchResponse {
  hits: AiConversationSearchHit[]
  /** More conversations matched than were returned. */
  hasMore: boolean
}

export type AiCell = string | number | boolean | null

/**
 * A result with a column of this name holds photos (ai.inspection_photos, ai.pdi_photos): the app draws it as the
 * photos themselves, each captioned by its row's other columns — in an answer, a saved or scheduled report, on paper.
 */
export const AI_PHOTO_COLUMN = 'photo_id'

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

/**
 * The charts the assistant draws. bar, horizontal-bar: compare categories
 * (horizontal for rankings and long names). stacked-bar, stacked-bar-100,
 * stacked-area, pie: the parts of a whole (100: each column as shares).
 * line, area: a trend. combo: a volume as bars with a rate as a line on its
 * own axis. pareto: causes largest first with their running share. scatter:
 * how two measures move together, with a trend line. heatmap: a measure
 * across two categories (machine by day). control: an individuals control
 * chart (SPC) with its centre line and 3-sigma limits. progress: how far
 * each item is toward its target (an order's pieces made of those required).
 * funnel: what is left after each stage. waterfall: how a figure moves from
 * a start to an end, step by step. gantt: bars in time, from a start to an
 * end (a plan, a schedule). dumbbell: two values per category side by side
 * (planned and actual). treemap: the parts of a whole as tiles, grouped.
 *
 * For quality (SPC): histogram — the spread of readings against their
 * specification limits, with the process's capability (Cp, Cpk, Pp, Ppk);
 * xbar-r — subgroups' means and ranges, each with its limits; p-chart — the
 * share defective of samples of any size; u-chart — defects per unit;
 * c-chart — defects per equal sample; box-plot — the spread of readings in
 * each group side by side. And: gauge — one figure (or a few) on a dial
 * against its target; radar — several measures around a circle, one shape
 * per item; bubble — a scatter whose points are sized by a third measure;
 * sankey — how quantities flow from one stage to the next; calendar — a
 * measure per day laid out as weeks; risk-matrix — failure modes placed by
 * severity and occurrence (FMEA), with their risk priority.
 */
export type AiChartType =
  | 'bar'
  | 'horizontal-bar'
  | 'stacked-bar'
  | 'stacked-bar-100'
  | 'line'
  | 'area'
  | 'stacked-area'
  | 'pie'
  | 'combo'
  | 'pareto'
  | 'scatter'
  | 'heatmap'
  | 'control'
  | 'progress'
  | 'funnel'
  | 'waterfall'
  | 'gantt'
  | 'dumbbell'
  | 'treemap'
  | 'histogram'
  | 'xbar-r'
  | 'p-chart'
  | 'u-chart'
  | 'c-chart'
  | 'box-plot'
  | 'gauge'
  | 'radar'
  | 'bubble'
  | 'sankey'
  | 'calendar'
  | 'risk-matrix'
export const AI_CHART_TYPES: readonly AiChartType[] = [
  'bar',
  'horizontal-bar',
  'stacked-bar',
  'stacked-bar-100',
  'line',
  'area',
  'stacked-area',
  'pie',
  'combo',
  'pareto',
  'scatter',
  'heatmap',
  'control',
  'progress',
  'funnel',
  'waterfall',
  'gantt',
  'dumbbell',
  'treemap',
  'histogram',
  'xbar-r',
  'p-chart',
  'u-chart',
  'c-chart',
  'box-plot',
  'gauge',
  'radar',
  'bubble',
  'sankey',
  'calendar',
  'risk-matrix',
]

/** Which way is better for a gauge's figure: higher (output, yield) or lower (rejects, downtime). */
export type AiChartBetter = 'higher' | 'lower'

/**
 * A chart of a query's result: `x` the category or day column, `y` 1–4 numeric columns (a gantt's two: start and end
 * dates), `series` a column to split by (long to wide; a gantt's bars' names, a treemap's groups, a sankey's targets).
 */
export interface AiChartSpec {
  type: AiChartType
  x: string
  y: string[]
  series?: string
  title?: string
  /**
   * A target drawn across the plot as a dashed line (bar, horizontal-bar, line, area, combo's line axis, control,
   * dumbbell, histogram, xbar-r's means, box-plot); a progress chart's target for every row, when it has one y
   * column; a gauge's target.
   */
  goal?: number
  /** The lower and upper specification limits of a histogram (its capability) or a box plot. */
  lsl?: number
  usl?: number
  /** A gauge's full scale. */
  max?: number
  /** Which way is better for a gauge's figure, against its goal. */
  better?: AiChartBetter
}

/**
 * A date or a time as a query writes it ("2026-10-13", "2026-10-13 08:30:00+03", "2026-10-13T08:30"), read as the
 * clock on the wall reads it: the offset is set aside, since the assistant's queries run on the factory's clock and
 * a chart shows what that clock read. `ms` orders and spaces the values (as if UTC); `dateOnly`, a day with no time.
 * Null when it is no such text.
 */
export function parseChartDate(value: unknown): { ms: number; dateOnly: boolean } | null {
  if (typeof value !== 'string') return null
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(?:Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(value.trim())
  if (!m) return null
  const [y, mo, d, h, mi, sec] = m.slice(1).map((v) => (v === undefined ? undefined : Number(v)))
  if (mo! < 1 || mo! > 12 || d! < 1 || d! > 31 || (h ?? 0) > 23 || (mi ?? 0) > 59 || (sec ?? 0) > 59) return null
  const ms = Date.UTC(y!, mo! - 1, d!, h ?? 0, mi ?? 0, sec ?? 0)
  if (new Date(ms).getUTCDate() !== d) return null
  return { ms, dateOnly: h === undefined }
}

export type AiKpiTrend = 'up-good' | 'up-bad' | 'down-good' | 'down-bad' | 'flat'
export const AI_KPI_TRENDS: readonly AiKpiTrend[] = ['up-good', 'up-bad', 'down-good', 'down-bad', 'flat']

/** A headline figure of an answer, as the model put it at the top. */
export interface AiKpi {
  label: string
  value: string
  trend?: AiKpiTrend
}

/** A task the assistant drafted, as its card shows it. */
export interface AiTaskDraft {
  title: string
  description: string
  priority: 'normal' | 'high' | 'urgent'
  dueAt: string | null
  assignees: { id: string; name: string }[]
}

/** A task card: Send task and Discard while proposed; then sent (with the task made), discarded, or replaced by a later draft. */
export interface AiTaskPart {
  type: 'task'
  proposalId: string
  ok: boolean
  /** Why it was not proposed (the model fixes it and calls again). */
  error?: string
  draft?: AiTaskDraft
  state: 'proposed' | 'sent' | 'discarded' | 'superseded'
  taskId?: string
  taskNumber?: number
}

/** A task card's Send task or Discard: the card as it stands after it. A refusal (409) carries it as `details.part`. */
export interface AiTaskProposalResponse {
  part: AiTaskPart
}

/**
 * An answer's pieces in order. An automation proposal (§21), a notice card (§23) and a task card are cards the person
 * applies or discards; a playbook card says what the assistant saved, with Remove; an Excel card is a file to download;
 * a saved-table card says what table the assistant made, changed, computed again or removed; a diagram card is a
 * diagram it drew (aiDiagram.ts); a report card opens a report it built or changed.
 */
export type AiPart =
  | { type: 'text'; text: string }
  | AiQueryPart
  | AiAutomationPart
  | AiNoticePart
  | AiTaskPart
  | AiPlaybookPart
  | AiExcelPart
  | AiSavedTablePart
  | AiDiagramPart
  | AiReportPart

/** A report the assistant built or changed (save_report), as a card in its answer, with Open report. */
export interface AiReportPart {
  type: 'report'
  changeId: string
  reportId: string
  action: 'create' | 'update'
  title: string
  description?: string
  shared: boolean
  /** Its inputs' labels, in order. */
  inputs: string[]
  sectionCount: number
  /** As this card left it, changed since, or deleted. */
  state: 'current' | 'changed' | 'removed'
}

/** How an answer ended. */
export type AiStopReason =
  /** Answered. */
  | 'end_turn'
  /** Cut at the length a reply may take. */
  | 'max_tokens'
  /** The model declined. */
  | 'refusal'
  /** The asker pressed Stop. (Leaving the page does not stop an answer: it goes on, and the bell says when it is ready.) */
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
  /** A question's files, in the order they were attached. */
  attachments?: AiAttachment[]
  /** An answer still being written on the server: what it has done so far, not how it ends. */
  running?: boolean
}

/**
 * The answer being written in a conversation, on the server. It goes on when the asker closes the page; only Stop
 * ends it early. A server that restarts hands it on, and it continues from its last step.
 */
export interface AiRunningAnswer {
  turnId: string
  /** The send's key, as the asker's device sent it (AiChatRequest.clientId). */
  clientId: string
  /** The question as typed. */
  question: string
  /** The question's saved message: what the answer follows. */
  questionMessageId: string | null
  askedAt: string
  /** A line on what it is doing now (thinking, or the query it runs); null between steps. */
  progress: string | null
  /** Stop was pressed; it ends at its next step. */
  stopping: boolean
}

export interface AiMessagesResponse {
  conversation: AiConversation
  messages: AiMessage[]
  /** The answer being written now, when there is one. While it runs, ask again every few seconds for its progress. */
  running?: AiRunningAnswer | null
}

/** POST /ai/conversations/:id/stop: whether an answer was being written and is now stopping. */
export interface AiStopResponse {
  stopping: boolean
}

export interface AiChatRequest {
  /** Absent: a new conversation. */
  conversationId?: string
  /** The question; may be empty when it carries files. */
  message: string
  /** The sender's key for this send: sent twice, it is asked once. */
  clientId: string
  /** Files attached for this question (POST /ai/attachments), in order. */
  attachmentIds?: string[]
}

/** The answer as it is written: one JSON object per Server-Sent Event, its `type` the event name. */
export type AiStreamEvent =
  | { type: 'start'; conversation: AiConversation; userMessageId: string; turnId?: string }
  | { type: 'text'; delta: string }
  /** A line on what the model is doing between queries. */
  | { type: 'progress'; text: string }
  | { type: 'query_start'; queryId: string; purpose: string; sql: string }
  | { type: 'query_end'; part: AiQueryPart }
  /** A proposed automation (§21), checked and tried once. */
  | { type: 'automation'; part: AiAutomationPart }
  /** A notice card (§23): a new notice, a change, a withdrawal or a deletion, waiting for its button. */
  | { type: 'notice'; part: AiNoticePart }
  /** A task card: a task drafted, waiting for Send task. */
  | { type: 'task'; part: AiTaskPart }
  /** A playbook card: an instruction or conclusion saved, changed or removed. */
  | { type: 'playbook'; part: AiPlaybookPart }
  /** An Excel file the assistant made, ready to download. */
  | { type: 'excel'; part: AiExcelPart }
  /** A saved table the assistant made, changed, computed again or removed. */
  | { type: 'saved-table'; part: AiSavedTablePart }
  /** A diagram the assistant drew, checked and kept. */
  | { type: 'diagram'; part: AiDiagramPart }
  /** A report the assistant built or changed. */
  | { type: 'report'; part: AiReportPart }
  /** A new conversation's title, as the assistant gave it: a few words on what it is about. */
  | { type: 'title'; conversation: AiConversation }
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
  /** Each UTC day with spend or a question: what it cost, the calls to the model, the questions asked. */
  byDay: { day: string; costUsd: number; calls: number; questions: number }[]
  byUser: { userId: string; userName: string; costUsd: number; questions: number }[]
  /** Scheduled reports' summaries (§21), by automation. Also counted in byDay and in their creator's byUser. */
  byAutomation: { automationId: string; name: string; creatorName: string; costUsd: number; runs: number }[]
}

// ---- Activity: each question and what it cost (the owner's) ----------------------------

/**
 * One thing the assistant was asked to do in a month, newest first: a person's
 * question (with everything its answer cost, a report saved from it
 * included), or a scheduled report's summary (§21). What the owner reads on
 * the settings page, and nobody else.
 */
export interface AiActivityItem {
  /** The question's turn id, or the summary's usage row (as text). Unique within its kind. */
  id: string
  kind: 'question' | 'automation' | 'mtc'
  /** ISO time it was asked (or the summary written, or the certificate read). */
  at: string
  userId: string
  userName: string
  /** The question as asked, the automation's name, or the certificate's file name and what was read from it. */
  text: string
  costUsd: number
  /** The models that served it, in the order first used (a refusal's fallback adds one, a certificate read again another). */
  models: string[]
  /** A question: the level it was answered at, and why the router gave it (null when the level was fixed, or for anything else). */
  level: AiRecordedChatLevel | null
  levelReason: string | null
  /** Queries run on the record to answer it. */
  lookups: number
  /** A call was cut off: part of the cost is an estimate. */
  partial: boolean
  /** How the answer ended; null while it is still being written, and for a summary. */
  stopReason: AiStopReason | null
}

export interface AiActivityResponse {
  /** YYYY-MM, UTC. */
  month: string
  items: AiActivityItem[]
  /** Where the next page starts (pass back as before), or null at the end. */
  next: string | null
  /** Everyone with activity in the month, for the filter. */
  people: { id: string; name: string }[]
}

/** Rows an Activity page brings. */
export const AI_ACTIVITY_PAGE = 50

// ---- Slow queries: the owner's -----------------------------------------------------------

/** Where one of the assistant's queries ran. */
export type AiSlowQuerySource = 'chat' | 'report' | 'scheduled-report' | 'excel' | 'saved-table' | 'export' | 'automation' | 'other'

/** A query of the assistant that took 10 seconds or more: kept 90 days, so the heavy ones can be fixed. */
export interface AiSlowQuery {
  id: string
  at: string
  source: AiSlowQuerySource
  userId: string | null
  userName: string | null
  conversationId: string | null
  /** What it was for: the query's purpose, a report's or file's name and its section. */
  purpose: string | null
  sql: string
  durationMs: number
  /** 'timeout': stopped at the time limit; 'error': it failed otherwise. */
  outcome: 'ok' | 'timeout' | 'error'
  error: string | null
  /** Rows it returned, when it finished. */
  rowCount: number | null
}

export interface AiSlowQueriesResponse {
  queries: AiSlowQuery[]
  /** What counts as slow, in seconds. */
  thresholdSeconds: number
  /** The time limit of one query, in seconds. */
  limitSeconds: number
}

/** Slow queries the owner's list shows, newest first. */
export const AI_SLOW_QUERIES_SHOWN = 200

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

/**
 * How a section shows its rows: a table (with its chart, when it has one); headline figures, the first row's
 * columns as cards (a figure apiece: its column's name, its value); or a tree, rows nested under the row their
 * parent column names (a main item, its parts, the machines each passed).
 */
export type AiReportSectionDisplay = 'table' | 'figures' | 'tree'
export const AI_REPORT_SECTION_DISPLAYS: readonly AiReportSectionDisplay[] = ['table', 'figures', 'tree']

/** A tree's columns: the one naming each row, and the one naming the row it sits under (empty or null at the top). */
export interface AiReportTree {
  key: string
  parent: string
}

export interface AiReportSection {
  /** The query's purpose, as the answer showed it. */
  title: string
  /** With an adjustable period, the SQL carries {{from}} and {{to}}; with inputs, {{name}} for each. */
  sql: string
  /** How its result is drawn, as the answer drew it; checked again against each run's result. */
  chart?: AiChartSpec
  /** How its rows are shown; a table unless the assistant built it otherwise. */
  display?: AiReportSectionDisplay
  tree?: AiReportTree
  /** A line under its title: what it counts and how. */
  note?: string
}

/** Who made a report: kept from an answer, built by the assistant (save_report), or one the app starts with. */
export type AiReportMadeBy = 'answer' | 'assistant' | 'starter'

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
  /** What the report shows, in a sentence or two (one the assistant built); absent for one kept from an answer. */
  description?: string
  /** Open to everyone given the assistant; each runs it over the data they may read. */
  shared: boolean
  /** The person asking made it: only they may rename, change or delete it. */
  mine: boolean
  /** Who made it. */
  ownerName: string
  madeBy: AiReportMadeBy
  /** How many inputs the form asks for. */
  inputCount: number
}

export interface AiReport extends AiReportSummary {
  conversationId?: string
  sections: AiReportSection[]
  /** What a run asks for besides the period. */
  inputs: AiReportInput[]
  /** The style its owner chose for it (reportStyles); absent: the company's default. */
  styleId?: string
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
  /** The section's chart, when its result this time can be drawn so. */
  chart?: AiChartSpec
  display?: AiReportSectionDisplay
  tree?: AiReportTree
  note?: string
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
  /** The inputs' values the run used (what was typed, or each one's default). */
  inputs: AiReportInputValues
  ranAt: string
  /** The style it prints in: its own, else the company's default; absent, the built-in look. */
  style?: ResolvedReportStyle
}

export interface AiReportExportResponse {
  report: AiReport
  period: (AiDayRange & { label: string; overridden: boolean }) | null
  sections: { title: string; ok: boolean; error?: string; columns: string[]; rows: AiCell[][]; truncated: boolean }[]
  inputs: AiReportInputValues
  ranAt: string
}

