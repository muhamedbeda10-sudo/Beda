// ============================================================================
// §21 — automations as the API shows them: the stored definition with names
// to read (who a recipient is, whom a follow-up goes to), its state, when it
// runs next, and — worked out afresh on every read — whether its creator can
// run it now. Never a cost: what a report's summary cost is the owner's to
// see on the assistant's settings page, nowhere else.
// ============================================================================

import type { AiDomain } from '@qc/shared/ai'
import type {
  Automation,
  AutomationActions,
  AutomationBlockedReason,
  AutomationChannels,
  AutomationDraft,
  AutomationKind,
  AutomationLanguage,
  AutomationRecipient,
  AutomationScheduleSpec,
  AutomationStatus,
  AutomationWatchSpec,
} from '@qc/shared/automation'
import type { Config } from '../config'
import type { Queryable } from '../db/pool'
import { isGranted, loadAccess, type AccessRecord } from '../ai/access'
import { currentAiOwner } from '../ai/owner'
import { loadAiSettings } from '../ai/settings'
import { assigneeView, namedUserIds, peopleById, recipientViews, type Person } from './labels'
import { linkedReportView, linkedReportViews } from './savedReport'

// ---- Whether the creator can run it --------------------------------------------------

/** What the engine needs to know of a creator: their account and their access. */
export interface CreatorState {
  active: boolean
  access: AccessRecord | null
}

/** Creators' states, one read for a whole list. */
export async function creatorStates(q: Queryable, ids: Iterable<string>): Promise<Map<string, CreatorState>> {
  const wanted = [...new Set(ids)]
  if (wanted.length === 0) return new Map()
  const { rows } = await q.query<{ id: string; active: boolean; hasAccess: boolean }>(
    `SELECT u.id, (u.is_active AND u.deleted_at IS NULL) AS active, EXISTS (SELECT 1 FROM ai_access a WHERE a.user_id = u.id) AS "hasAccess"
       FROM users u WHERE u.id = ANY($1::uuid[])`,
    [wanted],
  )
  const out = new Map<string, CreatorState>()
  // One after another: `q` may be a transaction's single connection.
  for (const r of rows) out.set(r.id, { active: r.active, access: r.hasAccess ? await loadAccess(q, r.id) : null })
  return out
}

/** Whether the assistant itself can run automations: switched on, and its readers up. */
export interface AppState {
  up: boolean
  ownerId: string | null
}

export async function appState(q: Queryable, config: Config, readersReady: boolean): Promise<AppState> {
  const { settings } = await loadAiSettings(q)
  return { up: settings.enabled && readersReady, ownerId: await currentAiOwner(q, config) }
}

/**
 * Why a creator cannot run their automations now, or null when they can: an
 * account that cannot sign in, the assistant taken away (or no data left),
 * the permission withdrawn (the owner needs none), the assistant itself down.
 */
export function blockedReason(creatorId: string, state: CreatorState | undefined, app: AppState): AutomationBlockedReason | null {
  if (!state?.active) return 'creator-inactive'
  if (!isGranted(state.access)) return 'no-access'
  if (creatorId !== app.ownerId && !state.access.automations) return 'no-permission'
  if (!app.up) return 'unavailable'
  return null
}

const BLOCKED_NOTE: Record<AutomationBlockedReason, string> = {
  'creator-inactive': "It cannot run now: its creator's account is not active.",
  'no-access': 'It cannot run now: its creator no longer has the assistant, or no data to read.',
  'no-permission': 'It cannot run now: its creator may no longer create automations.',
  unavailable: 'It cannot run now: the assistant is switched off or cannot reach its data.',
}

/** Why it cannot run, in a sentence. */
export const blockedNote = (reason: AutomationBlockedReason) => BLOCKED_NOTE[reason]

/** The domains a creator's automations run as now; empty when they cannot run. */
export const creatorDomains = (state: CreatorState | undefined): AiDomain[] => (state && isGranted(state.access) ? state.access.domains : [])

// ---- Rows ----------------------------------------------------------------------------

export interface AutomationRow {
  id: string
  creatorId: string
  creatorName: string
  proposalId: string | null
  conversationId: string | null
  conversationUserId: string | null
  conversationLive: boolean | null
  kind: AutomationKind
  name: string
  description: string
  language: AutomationLanguage
  watch: AutomationWatchSpec | null
  schedule: AutomationScheduleSpec | null
  recipients: AutomationRecipient[]
  channels: AutomationChannels
  actions: AutomationActions
  resultColumns: string[] | null
  status: AutomationStatus
  statusNote: string | null
  blockedReason: AutomationBlockedReason | null
  consecutiveFailures: number
  nextRunAt: string | null
  runningUntil: string | null
  retryAt: string | null
  lastRunAt: string | null
  lastRunOk: boolean | null
  /** Why the latest finished run failed; null when it worked (or none has run). */
  lastRunError: string | null
  lastManualRunAt: string | null
  createdAt: string
  updatedAt: string
  updatedByName: string | null
  openFollowUps: number
}

/** Every column of an automation row, with its creator's name and its open follow-ups; `a` is ai_automations. */
export const AUTOMATION_COLUMNS = `a.id, a.creator_id AS "creatorId", cu.name AS "creatorName", a.proposal_id AS "proposalId",
       a.conversation_id AS "conversationId", c.user_id AS "conversationUserId", (c.deleted_at IS NULL) AS "conversationLive",
       a.kind, a.name, a.description, a.language, a.watch, a.schedule, a.recipients, a.channels, a.actions,
       a.result_columns AS "resultColumns", a.status, a.status_note AS "statusNote", a.blocked_reason AS "blockedReason",
       a.consecutive_failures AS "consecutiveFailures", a.next_run_at AS "nextRunAt", a.running_until AS "runningUntil",
       a.retry_at AS "retryAt", a.last_run_at AS "lastRunAt", a.last_run_ok AS "lastRunOk", a.last_manual_run_at AS "lastManualRunAt",
       a.created_at AS "createdAt", a.updated_at AS "updatedAt", a.updated_by_name AS "updatedByName",
       (SELECT r.error FROM ai_automation_runs r WHERE r.automation_id = a.id AND r.finished_at IS NOT NULL ORDER BY r.started_at DESC, r.id DESC LIMIT 1) AS "lastRunError",
       (SELECT count(*)::int FROM follow_ups f WHERE f.automation_id = a.id AND f.status <> 'done') AS "openFollowUps"`

export const AUTOMATION_FROM = `ai_automations a JOIN users cu ON cu.id = a.creator_id LEFT JOIN ai_conversations c ON c.id = a.conversation_id`

/** An automation's definition, as a draft again: what an edit starts from. */
export function draftOf(a: AutomationRow): AutomationDraft {
  const d: AutomationDraft = {
    kind: a.kind,
    name: a.name,
    description: a.description,
    language: a.language,
    recipients: a.recipients,
    channels: a.channels,
    actions: a.actions,
  }
  if (a.watch) d.watch = a.watch
  if (a.schedule) d.schedule = a.schedule
  return d
}

/** One automation, unless deleted; `forUpdate` locks its row. */
export async function findAutomation(q: Queryable, id: string, forUpdate = false): Promise<AutomationRow | null> {
  const { rows } = await q.query<AutomationRow>(
    `SELECT ${AUTOMATION_COLUMNS} FROM ${AUTOMATION_FROM} WHERE a.id = $1 AND a.deleted_at IS NULL${forUpdate ? ' FOR UPDATE OF a' : ''}`,
    [id],
  )
  return rows[0] ?? null
}

/** Automations as the API shows them, for one viewer; one read of names and creators for the lot. */
export async function toAutomations(q: Queryable, rows: AutomationRow[], viewerId: string, app: AppState): Promise<Automation[]> {
  const people = await peopleById(q, rows.flatMap((r) => namedUserIds(r.recipients, r.actions)))
  const creators = await creatorStates(q, rows.map((r) => r.creatorId))
  // The saved reports they send, each as its automation's creator may open it now.
  const linked = await linkedReportViews(q, rows)
  return rows.map((r) => {
    const out = toAutomation(r, viewerId, people, blockedReason(r.creatorId, creators.get(r.creatorId), app))
    const report = linkedReportView(linked, r.creatorId, r.schedule)
    if (report) out.linkedReport = report
    return out
  })
}

export function toAutomation(r: AutomationRow, viewerId: string, people: Map<string, Person>, blocked: AutomationBlockedReason | null): Automation {
  const out: Automation = {
    id: r.id,
    kind: r.kind,
    name: r.name,
    description: r.description,
    language: r.language,
    status: r.status,
    recipients: recipientViews(r.recipients, people, r.kind === 'watch' ? r.resultColumns : null),
    channels: r.channels,
    actions: r.actions,
    creator: { id: r.creatorId, name: r.creatorName },
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    // Only an active automation its creator can run has a next run.
    nextRunAt: r.status === 'active' && !blocked ? r.nextRunAt : null,
    consecutiveFailures: r.consecutiveFailures,
    openFollowUps: r.openFollowUps,
  }
  if (r.status === 'active' && blocked) out.blockedReason = blocked
  if (r.statusNote) out.statusNote = r.statusNote
  if (r.watch) out.watch = r.watch
  if (r.schedule) out.schedule = r.schedule
  if (r.actions.followUp) out.assignee = assigneeView(r.actions.followUp.assignee, people, { name: r.creatorName }, r.resultColumns)
  // The conversation it came from, when it is still the viewer's own.
  if (r.conversationId && r.conversationUserId === viewerId && r.conversationLive) out.conversationId = r.conversationId
  if (r.updatedByName) out.updatedByName = r.updatedByName
  if (r.lastRunAt) out.lastRunAt = r.lastRunAt
  if (r.lastRunOk !== null) out.lastRunOk = r.lastRunOk
  if (r.lastRunOk === false && r.lastRunError) out.lastRunError = r.lastRunError
  return out
}
