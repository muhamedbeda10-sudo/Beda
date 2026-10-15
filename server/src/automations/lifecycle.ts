// ============================================================================
// §21 — what people do with automations: activate a proposal (or discard
// it), change one outside the chat, pause, resume, delete. Each change is in
// the audit log under the entity 'Automation' (hidden from everyone but the
// assistant's owner, like its other entries): what changed, in words, never
// a query's SQL — a changed query reads as a changed fingerprint.
//
// Activation is the only way anything starts to run. A proposal activates
// once, by the person who asked for it, while they may create automations
// and until a newer version of it is proposed (§22: it is superseded then;
// and a newer version never activates beside an older one already active),
// and only after the draft (with any changes made on the card) passes the
// same checks again, its queries run as the person's domains now. A watch
// records the cases matching at that moment as already seen, so only cases
// appearing later fire — unless the person asks to be told about those too.
// A proposal that changes an existing automation updates it in place: its
// fired cases are kept, and when its query and key column stay the same
// nothing is recorded afresh — a case it has not told yet still fires.
// ============================================================================

import { createHash } from 'node:crypto'
import { inputValueText } from '@qc/shared/aiReportInputs'
import { describeAiPeriod } from '@qc/shared/ai'
import { auditEvent } from '@qc/shared/audit'
import {
  AUTOMATION_MAX_PER_CREATOR,
  describeHours,
  describeSchedule,
  describeWatchInterval,
  describeWeekdays,
  type AutomationActivateResponse,
  type AutomationDiscardResponse,
  type AutomationDraft,
} from '@qc/shared/automation'
import { withTransaction, type Queryable } from '../db/pool'
import { HttpError, badRequest, notFound } from '../lib/errors'
import { auditChanges, writeAudit } from '../audit/service'
import type { AccessRecord } from '../ai/access'
import { applyEdits, type EditsInputType } from './draft'
import type { EngineDeps } from './engine'
import { assigneeView, namedUserIds, peopleById, recipientViews } from './labels'
import { findProposal, proposalPart } from './proposals'
import { nextReportRun, nextWatchRun, watchRunAt } from './schedule'
import { caseKey, keepsCases, validateDraft, type Validation } from './validate'
import { appState, draftOf, findAutomation, toAutomations, type AutomationRow } from './views'

export { draftOf }

export interface Actor {
  id: string
  name: string
}

const conflict = (message: string) => new HttpError(409, 'conflict', message)

/** A draft that did not pass: a 400 naming the first problem, every problem in the details. */
function invalid(errors: string[]): HttpError {
  return badRequest(errors[0] ?? 'The automation is not valid.', errors.map((message) => ({ path: '', message })))
}

/** The queries of a definition as the audit log names them: a fingerprint, so a change shows and the SQL does not. A saved report it sends is its id and values. */
function queriesFingerprint(d: AutomationDraft): string {
  const report = d.schedule?.report
  const sql = d.watch
    ? d.watch.sql
    : report
      ? `report ${report.reportId}\n${JSON.stringify(report.inputs)}`
      : (d.schedule?.sections ?? []).map((s) => `${s.title}\n${s.sql}`).join('\n\n')
  return createHash('sha256').update(sql).digest('hex').slice(0, 12)
}

/** A definition as the audit log shows it: one value per field, in words. */
async function auditSnapshot(q: Queryable, d: AutomationDraft, creatorName: string): Promise<Record<string, string>> {
  const people = await peopleById(q, namedUserIds(d.recipients, d.actions))
  const snap: Record<string, string> = {
    name: d.name,
    description: d.description,
    recipients: recipientViews(d.recipients, people, null).map((r) => r.label).join(', ') || 'none',
    channels: [d.channels.bell ? 'bell' : '', d.channels.chat ? 'chat' : ''].filter(Boolean).join(', '),
    queries: queriesFingerprint(d),
  }
  if (d.watch) {
    snap.interval = describeWatchInterval(d.watch.everyMinutes)
    snap.hours = d.watch.hours ? describeHours(d.watch.hours) : 'around the clock'
    snap.days = describeWeekdays(d.watch.weekdays)
    snap.notify = d.actions.notify ? 'on' : 'off'
    const f = d.actions.followUp
    snap.followUp = f ? `${assigneeView(f.assignee, people, { name: creatorName }, null).label}, due in ${f.dueHours} h` : 'none'
  }
  if (d.schedule) {
    snap.schedule = describeSchedule(d.schedule)
    snap.period = d.schedule.period ? describeAiPeriod(d.schedule.period) : 'none'
    snap.summary = d.schedule.summary ? 'on' : 'off'
    if (d.schedule.report) {
      // The saved report by its title, and the values it is given, as people read them.
      const { rows } = await q.query<{ title: string }>(`SELECT title FROM ai_reports WHERE id = $1`, [d.schedule.report.reportId])
      snap.report = rows[0]?.title ?? d.schedule.report.reportId
      snap.reportInputs =
        Object.entries(d.schedule.report.inputs)
          .map(([k, v]) => `${k}: ${inputValueText(v)}`)
          .join('; ') || 'each its default'
    }
  }
  return snap
}

const auditContext = (by: Actor, id: string) => ({ userId: by.id, userName: by.name, entity: 'Automation', entityId: id })

/** One automation as a viewer sees it. */
export async function automationFor(deps: EngineDeps, id: string, viewerId: string) {
  const row = await findAutomation(deps.db, id)
  if (!row) return null
  const [out] = await toAutomations(deps.db, [row], viewerId, await appState(deps.db, deps.config, deps.readers.ready))
  return out
}

// ---- Proposals ------------------------------------------------------------------------

/**
 * Activate one's own proposal, with any changes made on its card. Checked
 * again in full (its queries run now, as the person's domains), then made an
 * automation — or the change of one — in one transaction that also decides
 * the proposal, so a proposal activates once however many clicks race.
 */
export async function activateProposal(
  deps: EngineDeps,
  proposalId: string,
  by: Actor,
  access: AccessRecord,
  body: { edits?: EditsInputType; notifyExisting?: boolean },
  now = new Date(),
  signal?: AbortSignal,
): Promise<AutomationActivateResponse> {
  const proposal = await findProposal(deps.db, proposalId, by.id)
  if (!proposal) throw notFound('That proposal')
  assertUndecided(proposal)
  let draft = proposal.draft!
  if (body.edits) {
    const edited = applyEdits(draft, body.edits)
    if ('errors' in edited) throw invalid(edited.errors)
    draft = edited.draft
  }
  const checked: Validation = await validateDraft(
    {
      db: deps.db,
      readers: deps.readers,
      timeZone: deps.config.FACTORY_TIMEZONE,
      creatorId: by.id,
      domains: access.domains,
      now,
      runQueries: true,
      stopEarly: true,
      // The person pressing Activate reads what is wrong.
      readBy: 'person',
      signal,
    },
    draft,
  )
  if (!checked.ok) throw invalid(checked.errors)
  const d = checked.draft

  const automationId = await withTransaction(deps.db, async (tx) => {
    const locked = await findProposal(tx, proposalId, by.id, true)
    if (!locked) throw notFound('That proposal')
    assertUndecided(locked)
    // One activation at a time per person: two at once can neither pass the limit together nor both
    // make an automation of two versions of one proposal. NO KEY UPDATE, never FOR UPDATE: an
    // answer's store holds a key share on this row (its proposals' foreign key) while it marks an
    // older version superseded, and waiting for that while holding the proposal would deadlock.
    await tx.query(`SELECT 1 FROM users WHERE id = $1 FOR NO KEY UPDATE`, [by.id])
    await assertRevisedStillOpen(tx, d, by.id)
    const replaces = d.replacesAutomationId ?? null
    let id: string
    // A change keeping its query and key column keeps its cases as they are: those not told yet still fire, as they would have.
    let carriesOn = false
    if (replaces) {
      const before = await findAutomation(tx, replaces, true)
      if (!before || before.creatorId !== by.id) throw conflict('The automation this proposal changes no longer exists.')
      if (before.kind !== d.kind) throw conflict('The automation this proposal changes is of another kind.')
      carriesOn = keepsCases(before.watch, d.watch)
      // A stopped one starts again with its fix; a paused one stays paused.
      const status = before.status === 'failed' ? 'active' : before.status
      await tx.query(
        `UPDATE ai_automations
            SET proposal_id = $2, conversation_id = $3, name = $4, description = $5, language = $6, watch = $7::json, schedule = $8::json,
                recipients = $9::json, channels = $10::json, actions = $11::json, result_columns = COALESCE($12::json, result_columns),
                status = $13, status_note = CASE WHEN $13 = status THEN status_note ELSE NULL END,
                consecutive_failures = CASE WHEN $13 = status THEN consecutive_failures ELSE 0 END,
                next_run_at = $14, updated_by_id = $15, updated_by_name = $16
          WHERE id = $1`,
        [
          replaces,
          proposalId,
          locked.conversationId,
          d.name,
          d.description,
          d.language,
          d.watch ? JSON.stringify(d.watch) : null,
          d.schedule ? JSON.stringify(d.schedule) : null,
          JSON.stringify(d.recipients),
          JSON.stringify(d.channels),
          JSON.stringify(d.actions),
          checked.watchRun ? JSON.stringify(checked.watchRun.columns) : null,
          status,
          status === 'active' ? firstRun(deps, d, now).toISOString() : null,
          by.id,
          by.name,
        ],
      )
      await auditChanges(tx, auditContext(by, replaces), await auditSnapshot(tx, draftOf(before), before.creatorName), await auditSnapshot(tx, d, by.name))
      if (before.status !== status) await auditChanges(tx, auditContext(by, replaces), { status: before.status }, { status })
      id = replaces
    } else {
      const held = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ai_automations WHERE creator_id = $1 AND deleted_at IS NULL`, [by.id])
      if (held.rows[0].n >= AUTOMATION_MAX_PER_CREATOR) throw conflict(`You already have ${AUTOMATION_MAX_PER_CREATOR} automations, the most allowed. Delete one first.`)
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO ai_automations (creator_id, proposal_id, conversation_id, kind, name, description, language, watch, schedule,
                                     recipients, channels, actions, result_columns, next_run_at, updated_by_id, updated_by_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::json, $9::json, $10::json, $11::json, $12::json, $13::json, $14, $1, $15)
         RETURNING id`,
        [
          by.id,
          proposalId,
          locked.conversationId,
          d.kind,
          d.name,
          d.description,
          d.language,
          d.watch ? JSON.stringify(d.watch) : null,
          d.schedule ? JSON.stringify(d.schedule) : null,
          JSON.stringify(d.recipients),
          JSON.stringify(d.channels),
          JSON.stringify(d.actions),
          checked.watchRun ? JSON.stringify(checked.watchRun.columns) : null,
          firstRun(deps, d, now).toISOString(),
          by.name,
        ],
      )
      id = rows[0].id
      await writeAudit(tx, [
        auditEvent('create', auditContext(by, id), now.toISOString(), { field: 'automation', newValue: `${d.name} (${d.kind === 'watch' ? 'watch' : 'scheduled report'})` }),
      ])
    }
    // The cases matching now are seen already: only those appearing later fire, unless asked otherwise.
    if (d.watch && checked.watchRun && !body.notifyExisting && !carriesOn) await recordBaseline(tx, id, d, checked.watchRun.columns, checked.watchRun.rows, now)
    await tx.query(`UPDATE ai_automation_proposals SET state = 'activated', automation_id = $2, decided_by_id = $3, decided_at = $4 WHERE id = $1`, [
      proposalId,
      id,
      by.id,
      now.toISOString(),
    ])
    return id
  })
  const automation = (await automationFor(deps, automationId, by.id))!
  const part = await proposalPart(deps.db, (await findProposal(deps.db, proposalId, by.id))!)
  return { automation, part }
}

/** What a person pressing Activate or Discard on a card that a newer version replaced is told (§22). */
const SUPERSEDED = 'A newer version of this proposal was made below; activate that one.'

function assertUndecided(p: { ok: boolean; draft: AutomationDraft | null; state: string }): void {
  if (p.state === 'activated') throw conflict('This proposal was already activated.')
  if (p.state === 'discarded') throw conflict('This proposal was discarded. Ask the assistant to propose it again.')
  if (p.state === 'superseded') throw conflict(SUPERSEDED)
  if (!p.ok || !p.draft) throw conflict('This proposal did not pass its checks, so it cannot be activated. Ask the assistant to fix it.')
}

/**
 * A new version activates in place of the one it revises, never beside it
 * (§22). The older one is superseded when the new one is stored, unless it was
 * activated first — its card pressed while the assistant was still writing the
 * new version. Then the new version would make a second automation of the
 * same request, telling the same cases twice: refused, unless it changes the
 * very automation the older one became. Called under the person's lock, so an
 * activation of the older version running at the same time has committed.
 */
async function assertRevisedStillOpen(tx: Queryable, d: AutomationDraft, userId: string): Promise<void> {
  if (!d.revisesProposalId) return
  const { rows } = await tx.query<{ automationId: string }>(
    `SELECT p.automation_id AS "automationId"
       FROM ai_automation_proposals p JOIN ai_automations a ON a.id = p.automation_id AND a.deleted_at IS NULL
      WHERE p.id = $1 AND p.user_id = $2 AND p.state = 'activated'`,
    [d.revisesProposalId, userId],
  )
  const became = rows[0]?.automationId
  if (became && became !== d.replacesAutomationId?.toLowerCase()) {
    throw conflict('The earlier version this proposal revises was activated meanwhile. Ask the assistant to change that automation instead.')
  }
}

/** When a new (or changed) automation first runs: a watch at once (or when its hours next open), a report at its next time. */
function firstRun(deps: EngineDeps, d: AutomationDraft, now: Date): Date {
  const tz = deps.config.FACTORY_TIMEZONE
  return d.schedule ? nextReportRun(d.schedule, now, tz) : watchRunAt(d.watch!, now, tz)
}

/** The cases a watch's query returns now, recorded as seen without telling anyone. */
async function recordBaseline(tx: Queryable, automationId: string, d: AutomationDraft, columns: string[], rows: unknown[][], now: Date): Promise<void> {
  const at = columns.indexOf(d.watch!.keyColumn)
  if (at < 0) return
  const keys = [...new Set(rows.map((r) => caseKey(r[at] as never)).filter((k): k is string => k !== null))]
  if (keys.length === 0) return
  await tx.query(
    `INSERT INTO ai_automation_hits (automation_id, case_key, run_id, first_seen_at)
     SELECT $1, k, NULL, $2 FROM unnest($3::text[]) AS k
     ON CONFLICT (automation_id, case_key) DO NOTHING`,
    [automationId, now.toISOString(), keys],
  )
}

/** Discard one's own proposal: its card says so; nothing was ever made of it. */
export async function discardProposal(deps: EngineDeps, proposalId: string, by: Actor, now = new Date()): Promise<AutomationDiscardResponse> {
  await withTransaction(deps.db, async (tx) => {
    const p = await findProposal(tx, proposalId, by.id, true)
    if (!p) throw notFound('That proposal')
    if (p.state === 'activated') throw conflict('This proposal was activated: pause or delete the automation on the Automations page instead.')
    if (p.state === 'superseded') throw conflict(SUPERSEDED)
    if (p.state === 'discarded') return
    if (!p.ok) throw conflict('This proposal did not pass its checks; there is nothing to discard.')
    await tx.query(`UPDATE ai_automation_proposals SET state = 'discarded', decided_by_id = $2, decided_at = $3 WHERE id = $1`, [proposalId, by.id, now.toISOString()])
  })
  return { part: await proposalPart(deps.db, (await findProposal(deps.db, proposalId, by.id))!) }
}

// ---- Automations ------------------------------------------------------------------------

/**
 * Change an automation outside the chat: its words, people, channels,
 * actions, interval or schedule. Its queries stay as they are; the columns
 * the change names are checked against its result as last seen.
 */
export async function updateAutomation(deps: EngineDeps, id: string, by: Actor, edits: EditsInputType, now = new Date()): Promise<void> {
  await withTransaction(deps.db, async (tx) => {
    const a = await findAutomation(tx, id, true)
    if (!a) throw notFound('That automation')
    const before = draftOf(a)
    const edited = applyEdits(before, edits)
    if ('errors' in edited) throw invalid(edited.errors)
    const checked = await validateDraft(
      { db: tx, readers: deps.readers, timeZone: deps.config.FACTORY_TIMEZONE, creatorId: a.creatorId, domains: [], now, runQueries: false, knownColumns: a.resultColumns, editing: a.id },
      edited.draft,
    )
    if (!checked.ok) throw invalid(checked.errors)
    const d = checked.draft
    const changes = await auditChanges(tx, auditContext(by, id), await auditSnapshot(tx, before, a.creatorName), await auditSnapshot(tx, d, a.creatorName))
    if (changes === 0) return
    // When it runs next follows a new interval, new hours or days, or a new schedule at once.
    let next = a.nextRunAt ? new Date(a.nextRunAt) : null
    if (a.status === 'active') {
      const tz = deps.config.FACTORY_TIMEZONE
      if (d.watch && JSON.stringify(watchTiming(d)) !== JSON.stringify(watchTiming(before))) {
        const due = a.lastRunAt ? nextWatchRun(d.watch, new Date(a.lastRunAt), tz) : now
        next = watchRunAt(d.watch, due.getTime() < now.getTime() ? now : due, tz)
      }
      if (d.schedule && JSON.stringify(scheduleTiming(d)) !== JSON.stringify(scheduleTiming(before))) next = nextReportRun(d.schedule, now, tz)
    }
    await tx.query(
      `UPDATE ai_automations SET name = $2, description = $3, watch = $4::json, schedule = $5::json, recipients = $6::json, channels = $7::json,
              actions = $8::json, next_run_at = $9, updated_by_id = $10, updated_by_name = $11
        WHERE id = $1`,
      [
        id,
        d.name,
        d.description,
        d.watch ? JSON.stringify(d.watch) : null,
        d.schedule ? JSON.stringify(d.schedule) : null,
        JSON.stringify(d.recipients),
        JSON.stringify(d.channels),
        JSON.stringify(d.actions),
        next ? next.toISOString() : null,
        by.id,
        by.name,
      ],
    )
  })
}

const scheduleTiming = (d: AutomationDraft) => {
  const s = d.schedule
  return s ? [s.cadence, s.time, s.weekdays ?? null, s.weekday ?? null, s.monthDay ?? null] : null
}

const watchTiming = (d: AutomationDraft) => {
  const w = d.watch
  return w ? [w.everyMinutes, w.hours ?? null, w.weekdays ?? null] : null
}

/** Pause an automation: it stops running until resumed. */
export async function pauseAutomation(deps: EngineDeps, id: string, by: Actor): Promise<void> {
  await withTransaction(deps.db, async (tx) => {
    const a = await findAutomation(tx, id, true)
    if (!a) throw notFound('That automation')
    if (a.status === 'paused') return
    await tx.query(`UPDATE ai_automations SET status = 'paused', next_run_at = NULL, retry_at = NULL, updated_by_id = $2, updated_by_name = $3 WHERE id = $1`, [id, by.id, by.name])
    await auditChanges(tx, auditContext(by, id), { status: a.status }, { status: 'paused' })
  })
}

/** Resume a paused or stopped automation: it runs again, its failures counted from nothing. */
export async function resumeAutomation(deps: EngineDeps, id: string, by: Actor, now = new Date()): Promise<void> {
  await withTransaction(deps.db, async (tx) => {
    const a = await findAutomation(tx, id, true)
    if (!a) throw notFound('That automation')
    if (a.status === 'active') return
    const next = firstRun(deps, draftOf(a), now)
    await tx.query(
      `UPDATE ai_automations SET status = 'active', status_note = NULL, consecutive_failures = 0, next_run_at = $2, retry_at = NULL,
              updated_by_id = $3, updated_by_name = $4
        WHERE id = $1`,
      [id, next.toISOString(), by.id, by.name],
    )
    await auditChanges(tx, auditContext(by, id), { status: a.status }, { status: 'active' })
  })
}

/** Delete an automation (kept, out of sight): it never runs again; its follow-ups and history stay. */
export async function deleteAutomation(deps: EngineDeps, id: string, by: Actor, now = new Date()): Promise<void> {
  await withTransaction(deps.db, async (tx) => {
    const a = await findAutomation(tx, id, true)
    if (!a) throw notFound('That automation')
    await tx.query(`UPDATE ai_automations SET deleted_at = $2, next_run_at = NULL, retry_at = NULL, updated_by_id = $3, updated_by_name = $4 WHERE id = $1`, [
      id,
      now.toISOString(),
      by.id,
      by.name,
    ])
    await writeAudit(tx, [auditEvent('delete', auditContext(by, id), now.toISOString(), { field: 'automation', oldValue: a.name })])
  })
}
