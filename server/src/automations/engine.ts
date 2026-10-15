// ============================================================================
// §21 — the automations engine: an in-process scheduler in the API. Every
// ENGINE_TICK_MS it hands back runs lost with an instance, escalates overdue
// follow-ups, now and then removes old bell alerts, and runs the automations
// that are due, at most ENGINE_CONCURRENCY at a time, each within its time
// limit. A long run (a report with its summary) holds one of those places,
// never the ticks: the next tick fills the places still free.
//
// Several instances may all run it. A due automation is taken under a lease,
// in one transaction: its row locked FOR UPDATE SKIP LOCKED (another instance
// passes over it), its next run moved forward and running_until set. Until
// the lease ends no instance takes it again, so it never runs twice at once.
// A run lost with its instance is closed once its lease has run out — as the
// success it was if it got as far as telling people — and a scheduled report
// lost that way is due again at the time it stood for, so it runs once late.
// When the server stops, the runs under way are cut short and handed back at
// once (their lease released, due again), so another instance takes them.
//
// Before a run the engine checks its creator: an active account, given the
// assistant with some data, allowed to create automations (the owner always
// is), and the assistant switched on with its readers up — and a report
// checks again before each section. When not, the automation is blocked, not
// failed: no run, nothing counted, looked at again a few minutes later, and
// it resumes by itself when the reason goes. A run that fails (an SQL error,
// a domain taken away) counts; after AUTOMATION_FAILURES_BEFORE_STOP in a row
// it stops ('failed'), and its creator and the owner are told once. Resuming
// it starts the count again.
//
// A report whose time passed while no instance could run it still runs, late,
// when less than six hours late — the latest of its times, over the days of
// that time — and any earlier times passed are recorded as missed; otherwise
// that run is recorded as missed and the next one scheduled. A watch simply
// runs at the next tick — unless its hours have closed meanwhile: then it
// waits, nothing recorded, for them to open again (its cases keep till then).
//
// The clock is injectable: the tests drive ticks directly at chosen moments.
// ============================================================================

import { AI_PREVIEW_ROWS } from '@qc/shared/ai'
import {
  AUTOMATION_FAILURES_BEFORE_STOP,
  AUTOMATION_WATCH_MAX_ROWS,
  type AutomationBlockedReason,
  type AutomationRun,
  type AutomationTestResponse,
} from '@qc/shared/automation'
import type { Role } from '@qc/shared/types'
import type { Config } from '../config'
import { withTransaction, type Db, type Queryable } from '../db/pool'
import type { AiModelClient } from '../ai/model'
import { previewOf, runReadOnlyQuery } from '../ai/runQuery'
import { withQueryOrigin } from '../ai/slowQueries'
import { escalateOverdue } from './followUps'
import { createNotifications, purgeNotifications } from './notify'
import { activeUserIds, distinctIds } from './people'
import { runReport, runSections, sectionError, type ReportReader } from './report'
import { INTERRUPTED_ERROR, beginRun, closeLostRuns, findRun, skippedRun } from './runs'
import { MISSED_RUN_GRACE_MS, nextReportRun, nextWatchRun, previousReportRun, reportRunsBetween, watchRunAt } from './schedule'
import { isolate } from './text'
import { prepareReport } from './savedReport'
import { AUTOMATION_QUERY_TIMEOUT_MS, queryErrorForPeople, watchBacktest, type AutomationReaders } from './validate'
import { appState, blockedNote, blockedReason, creatorDomains, creatorStates, findAutomation, type AutomationRow } from './views'
import { STOPPING, automationLink, casesOf, runWatch, type RunResult } from './watch'

export { blockedNote }

/** How often the engine looks for work. */
export const ENGINE_TICK_MS = 30_000
/** Automations run at the same time by one instance. */
export const ENGINE_CONCURRENCY = 2
/** A run holds its automation this long at most: longer than any run may take, so a live run is never taken over. */
export const RUN_LEASE_MS = 10 * 60_000
/** The longest a watch's run may take, and a report's (up to eight sections of 30 s each, then the summary's two minutes). */
export const WATCH_RUN_TIMEOUT_MS = 2 * 60_000
export const REPORT_RUN_TIMEOUT_MS = 8 * 60_000
/** A blocked automation is looked at again this much later. */
export const BLOCKED_RECHECK_MS = 5 * 60_000
/** "Run now" at most this often per automation. */
export const MANUAL_RUN_EVERY_MS = 60_000
/** Old alerts are removed this often (per instance; doing it twice is harmless). */
const PURGE_EVERY_MS = 24 * 3_600_000
/** Automations one worker takes in one tick, at most: a backstop, never reached in practice. */
const CLAIMS_PER_TICK = 500

export const MISSED_NOTE = 'Missed: the server was not running at its time, so this run was skipped.'

/** Why a report's times passed without a run: the server down, or its creator unable to run it then. */
export function missedNote(count: number, whileBlocked: boolean): string {
  const why = whileBlocked ? 'its creator could not run it' : 'the server was not running'
  if (count <= 1) return whileBlocked ? `Missed: ${why} at its time, so this run was skipped.` : MISSED_NOTE
  return `Missed ${count} runs: ${why} at their times, so they were skipped.`
}

export interface EngineDeps {
  db: Db
  config: Config
  readers: AutomationReaders
  model: AiModelClient
}

/** An automation taken for a run: under its lease, its run begun. */
export interface Claimed {
  automation: AutomationRow
  runId: string
  trigger: 'schedule' | 'manual'
  startedAt: Date
  /** The time a scheduled report's run stands for (its period is of that moment); null for a watch or a run asked for now. */
  slotAt: Date | null
}

type Claim = { kind: 'run'; claimed: Claimed } | { kind: 'blocked' | 'missed' } | null

/**
 * Take the next due automation, if any, in one transaction: locked (skipped
 * by any other instance), its creator checked, its next run moved forward,
 * its lease and run begun. A blocked one is put off. A report runs for the
 * latest of its times passed: earlier ones passed meanwhile are recorded as
 * missed, and that one too when it is six hours late or more.
 */
export async function claimDue(deps: EngineDeps, now: Date): Promise<Claim> {
  return withTransaction(deps.db, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `SELECT a.id FROM ai_automations a
        WHERE a.deleted_at IS NULL AND a.status = 'active' AND a.next_run_at <= $1
          AND (a.running_until IS NULL OR a.running_until <= $1)
          AND (a.retry_at IS NULL OR a.retry_at <= $1)
        ORDER BY a.next_run_at, a.id
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
      [now.toISOString()],
    )
    if (!rows[0]) return null
    const a = (await findAutomation(tx, rows[0].id))!
    const blocked = blockedReason(a.creatorId, (await creatorStates(tx, [a.creatorId])).get(a.creatorId), await appState(tx, deps.config, deps.readers.ready))
    if (blocked) {
      await tx.query(`UPDATE ai_automations SET blocked_reason = $2, retry_at = $3 WHERE id = $1`, [a.id, blocked, new Date(now.getTime() + BLOCKED_RECHECK_MS).toISOString()])
      return { kind: 'blocked' }
    }
    await closeLostRuns(tx, a.id, now)
    let slotAt: Date | null = null
    let next: Date
    if (a.kind === 'watch') {
      const tz = deps.config.FACTORY_TIMEZONE
      // Due while no instance could run it, and its hours over since: it waits for them to open again.
      const opens = watchRunAt(a.watch!, now, tz)
      if (opens.getTime() > now.getTime()) {
        await tx.query(`UPDATE ai_automations SET next_run_at = $2, retry_at = NULL, blocked_reason = NULL WHERE id = $1`, [a.id, opens.toISOString()])
        return { kind: 'missed' }
      }
      next = nextWatchRun(a.watch!, now, tz)
    } else {
      const tz = deps.config.FACTORY_TIMEZONE
      const s = a.schedule!
      const stored = new Date(a.nextRunAt!)
      // The latest time it was due by now (never before the stored one, which a schedule change may have set off its times).
      const latest = previousReportRun(s, now, tz)
      const slot = latest && latest.getTime() > stored.getTime() ? latest : stored
      next = nextReportRun(s, now, tz)
      // Blocked when it fell due: the times passed were its creator's, not the server's.
      const whileBlocked = a.blockedReason !== null
      const earlier = slot.getTime() > stored.getTime() ? reportRunsBetween(s, stored, slot, tz) : 0
      if (now.getTime() - slot.getTime() >= MISSED_RUN_GRACE_MS) {
        await skippedRun(tx, a.id, stored, missedNote(earlier + 1, whileBlocked))
        await tx.query(`UPDATE ai_automations SET next_run_at = $2, retry_at = NULL, blocked_reason = NULL WHERE id = $1`, [a.id, next.toISOString()])
        return { kind: 'missed' }
      }
      if (earlier > 0) await skippedRun(tx, a.id, stored, missedNote(earlier, whileBlocked))
      slotAt = slot
    }
    const runId = await beginRun(tx, a.id, 'schedule', now)
    await tx.query(`UPDATE ai_automations SET next_run_at = $2, running_until = $3, retry_at = NULL, blocked_reason = NULL WHERE id = $1`, [
      a.id,
      next.toISOString(),
      new Date(now.getTime() + RUN_LEASE_MS).toISOString(),
    ])
    return { kind: 'run', claimed: { automation: { ...a, nextRunAt: next.toISOString() }, runId, trigger: 'schedule', startedAt: now, slotAt } }
  })
}

/** Where a run's next query runs: its creator's domains as they are at that moment, or why the creator cannot run it any more. */
function readerFor(deps: EngineDeps, creatorId: string): ReportReader {
  return async () => {
    const state = (await creatorStates(deps.db, [creatorId])).get(creatorId)
    const blocked = blockedReason(creatorId, state, await appState(deps.db, deps.config, deps.readers.ready))
    return blocked ? { blocked } : deps.readers.poolFor(creatorDomains(state))
  }
}

/**
 * Run a claimed automation within its time limit, record the run, and release
 * the lease. `halt` is the engine stopping: a run it cuts short before telling
 * anyone is handed back (due again at once), not recorded. Never throws.
 */
export async function runClaimed(deps: EngineDeps, c: Claimed, halt?: AbortSignal): Promise<AutomationRun | null> {
  const a = c.automation
  const timeout = a.kind === 'watch' ? WATCH_RUN_TIMEOUT_MS : REPORT_RUN_TIMEOUT_MS
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeout)
  timer.unref()
  const onHalt = () => ac.abort(STOPPING)
  if (halt?.aborted) onHalt()
  else halt?.addEventListener('abort', onHalt, { once: true })
  const started = Date.now()
  const reader = readerFor(deps, a.creatorId)
  let result: RunResult
  try {
    if (a.kind === 'watch') {
      const pool = await reader()
      result =
        pool && 'blocked' in pool
          ? { ok: false, blocked: pool.blocked, error: blockedNote(pool.blocked), notified: 0, casesNotified: 0, digest: false, notes: [] }
          : await runWatch({ db: deps.db, timeZone: deps.config.FACTORY_TIMEZONE, automation: a, runId: c.runId, now: c.startedAt, pool, signal: ac.signal, ownerId: (await appState(deps.db, deps.config, deps.readers.ready)).ownerId })
    } else {
      result = await runReport({
        db: deps.db,
        config: deps.config,
        model: deps.model,
        automation: a,
        runId: c.runId,
        now: c.startedAt,
        slotAt: c.slotAt,
        reader,
        signal: ac.signal,
      })
    }
    // What the clock cut short failed for that reason; a run that got through all the same stands.
    if (ac.signal.aborted && ac.signal.reason !== STOPPING && !result.ok && !result.blocked) result.error = `The run took longer than ${timeout / 60_000} minutes and was stopped.`
  } catch (e) {
    console.error(`[automations] run ${c.runId} of ${a.id} failed`, e)
    result = { ok: false, error: 'The run could not be completed because of a fault on the server.', notified: 0, casesNotified: 0, digest: false, notes: [] }
  } finally {
    clearTimeout(timer)
    halt?.removeEventListener('abort', onHalt)
  }
  try {
    // Cut short by the server stopping before it told anyone: due again at once, on whichever instance takes it.
    if (!result.ok && (result.interrupted || halt?.aborted)) {
      await handBack(deps, c, new Date(c.startedAt.getTime() + (Date.now() - started)))
      return null
    }
    if (result.blocked) {
      await blockRun(deps, c, result.blocked, new Date(c.startedAt.getTime() + (Date.now() - started)))
      return c.trigger === 'manual' ? await findRun(deps.db, c.runId) : null
    }
    await finishRun(deps, c, result, Date.now() - started)
    return await findRun(deps.db, c.runId)
  } catch (e) {
    console.error(`[automations] could not record run ${c.runId} of ${a.id}`, e)
    return null
  }
}

/**
 * A run the server's stopping cut short, given back: a scheduled one leaves
 * no trace and is due again at once — a report at the time it stood for, so
 * its period is unchanged — and a run asked for now is closed as interrupted.
 */
async function handBack(deps: EngineDeps, c: Claimed, at: Date): Promise<void> {
  await withTransaction(deps.db, async (tx) => {
    if (c.trigger === 'schedule') {
      await tx.query(`DELETE FROM ai_automation_runs WHERE id = $1`, [c.runId])
      await tx.query(
        `UPDATE ai_automations SET running_until = NULL, next_run_at = CASE WHEN status = 'active' AND deleted_at IS NULL THEN $2 ELSE next_run_at END WHERE id = $1`,
        [c.automation.id, (c.slotAt ?? c.startedAt).toISOString()],
      )
    } else {
      await tx.query(`UPDATE ai_automation_runs SET finished_at = $2, ok = false, error = $3 WHERE id = $1`, [c.runId, at.toISOString(), INTERRUPTED_ERROR])
      await tx.query(`UPDATE ai_automations SET running_until = NULL WHERE id = $1`, [c.automation.id])
    }
  })
  console.warn(`[automations] run ${c.runId} of ${c.automation.id} was cut short by the server stopping and handed back`)
}

/**
 * A run whose creator could no longer run it part way (a report between its
 * sections): nothing went out and nothing is counted. A scheduled one is
 * blocked as at its claim — due again at the time it stood for, looked at
 * again later — and leaves no trace; a run asked for now says why it stopped.
 */
async function blockRun(deps: EngineDeps, c: Claimed, reason: AutomationBlockedReason, at: Date): Promise<void> {
  await withTransaction(deps.db, async (tx) => {
    if (c.trigger === 'schedule') {
      await tx.query(`DELETE FROM ai_automation_runs WHERE id = $1`, [c.runId])
      await tx.query(
        `UPDATE ai_automations SET running_until = NULL, blocked_reason = $2, retry_at = $3,
                next_run_at = CASE WHEN status = 'active' AND deleted_at IS NULL THEN $4 ELSE next_run_at END
          WHERE id = $1`,
        [c.automation.id, reason, new Date(at.getTime() + BLOCKED_RECHECK_MS).toISOString(), (c.slotAt ?? c.startedAt).toISOString()],
      )
    } else {
      await tx.query(`UPDATE ai_automation_runs SET finished_at = $2, ok = false, error = $3, ms = $4 WHERE id = $1`, [
        c.runId,
        at.toISOString(),
        blockedNote(reason),
        Math.max(0, Math.round(at.getTime() - c.startedAt.getTime())),
      ])
      await tx.query(`UPDATE ai_automations SET running_until = NULL WHERE id = $1`, [c.automation.id])
    }
  })
}

/**
 * Runs lost with an instance, found once their lease has run out: closed
 * (each as far as it got) and the lease released. A scheduled report lost
 * before it was delivered is due again at the time it stood for, so it runs
 * once late — or is recorded as missed, when that is six hours ago or more.
 */
export async function recoverLostRuns(deps: EngineDeps, now: Date): Promise<number> {
  return withTransaction(deps.db, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `SELECT id FROM ai_automations WHERE running_until IS NOT NULL AND running_until <= $1 ORDER BY running_until, id LIMIT 100 FOR UPDATE SKIP LOCKED`,
      [now.toISOString()],
    )
    for (const { id } of rows) {
      const lost = await closeLostRuns(tx, id, now)
      const a = await findAutomation(tx, id)
      const redo = a?.kind === 'report' && a.status === 'active' ? lost.find((r) => r.trigger === 'schedule' && !r.completed) : undefined
      const slot = redo ? previousReportRun(a!.schedule!, new Date(redo.startedAt), deps.config.FACTORY_TIMEZONE) : null
      await tx.query(
        `UPDATE ai_automations SET running_until = NULL,
                next_run_at = CASE WHEN $2::timestamptz IS NOT NULL AND (next_run_at IS NULL OR next_run_at > $2) THEN $2 ELSE next_run_at END
          WHERE id = $1`,
        [id, slot ? slot.toISOString() : null],
      )
    }
    return rows.length
  })
}

/**
 * The run's result recorded and the lease released. A scheduled run counts
 * towards the failures in a row (one that worked starts them again); enough
 * of them stop the automation, and its creator and the owner hear of it once.
 * A manual run is recorded and changes nothing else.
 */
async function finishRun(deps: EngineDeps, c: Claimed, r: RunResult, ms: number): Promise<void> {
  const a = c.automation
  await withTransaction(deps.db, async (tx) => {
    const note = r.notes.length > 0 ? r.notes.join(' ') : null
    await tx.query(
      `UPDATE ai_automation_runs
          SET finished_at = $2, ok = $3, error = $4, ms = $5, matched = $6, fired = $7, notified = $8, follow_ups = $9,
              cases_notified = $10, digest = $11, note = $12, delivery_id = $13
        WHERE id = $1`,
      [
        c.runId,
        new Date(c.startedAt.getTime() + ms).toISOString(),
        r.ok,
        r.ok ? null : (r.error ?? 'The run failed.'),
        Math.round(ms),
        r.matched ?? null,
        r.fired ?? null,
        r.notified,
        r.followUps ?? null,
        r.casesNotified,
        r.digest,
        note,
        r.deliveryId ?? null,
      ],
    )
    const counted = c.trigger === 'schedule'
    const { rows } = await tx.query<{ failures: number; status: string; deleted: boolean }>(
      `UPDATE ai_automations
          SET running_until = NULL, last_run_at = $2, last_run_ok = $3,
              result_columns = COALESCE($4::json, result_columns),
              consecutive_failures = CASE WHEN NOT $5 THEN consecutive_failures WHEN $3 THEN 0 ELSE consecutive_failures + 1 END
        WHERE id = $1
        RETURNING consecutive_failures AS failures, status, deleted_at IS NOT NULL AS deleted`,
      [a.id, c.startedAt.toISOString(), r.ok, r.resultColumns ? JSON.stringify(r.resultColumns) : null, counted],
    )
    const now = rows[0]
    if (!counted || r.ok || !now || now.deleted || now.status !== 'active' || now.failures < AUTOMATION_FAILURES_BEFORE_STOP) return
    // In the words its runs' history uses: what went wrong, for the people who read it, never the model's instructions.
    const statusNote = `Stopped after ${now.failures} failed runs in a row. ${r.error ?? 'The last one failed.'}`
    await tx.query(`UPDATE ai_automations SET status = 'failed', status_note = $2, next_run_at = NULL WHERE id = $1`, [a.id, statusNote])
    const owner = (await appState(tx, deps.config, deps.readers.ready)).ownerId
    await createNotifications(tx, [a.creatorId, ...(owner ? [owner] : [])], {
      kind: 'automation-stopped',
      severity: 'critical',
      title: `Automation stopped: ${isolate(a.name)}`,
      body: `${statusNote} Fix it in the assistant, then resume it on the Automations page.`,
      link: automationLink(a.id),
      automationId: a.id,
    })
  })
}

// ---- "Run now" and "Test" --------------------------------------------------------------

export type ManualRefusal = { refused: 'running' | 'too-soon' } | { refused: 'blocked'; reason: AutomationBlockedReason }

/**
 * Run an automation now, as a person asked (its creator or the owner): once
 * a minute at most, never while a run is in flight, never when its creator
 * cannot run it. A real run: it tells people and records what it found.
 */
export async function runNow(deps: EngineDeps, id: string, now = new Date()): Promise<AutomationRun | ManualRefusal | null> {
  const claim = await withTransaction(deps.db, async (tx): Promise<Claimed | ManualRefusal | null> => {
    const a = await findAutomation(tx, id, true)
    if (!a) return null
    if (a.runningUntil && new Date(a.runningUntil).getTime() > now.getTime()) return { refused: 'running' }
    if (a.lastManualRunAt && now.getTime() - new Date(a.lastManualRunAt).getTime() < MANUAL_RUN_EVERY_MS) return { refused: 'too-soon' }
    const blocked = blockedReason(a.creatorId, (await creatorStates(tx, [a.creatorId])).get(a.creatorId), await appState(tx, deps.config, deps.readers.ready))
    if (blocked) return { refused: 'blocked', reason: blocked }
    await closeLostRuns(tx, a.id, now)
    const runId = await beginRun(tx, a.id, 'manual', now)
    await tx.query(`UPDATE ai_automations SET running_until = $2, last_manual_run_at = $3 WHERE id = $1`, [
      a.id,
      new Date(now.getTime() + RUN_LEASE_MS).toISOString(),
      now.toISOString(),
    ])
    return { automation: a, runId, trigger: 'manual', startedAt: now, slotAt: null }
  })
  if (!claim || 'refused' in claim) return claim
  return runClaimed(deps, claim)
}

/**
 * A dry run: what the automation would find and whom it would tell now.
 * Nothing is sent or recorded. `signal` is the person leaving: the queries
 * still to run stop, inside PostgreSQL too.
 */
export async function testAutomation(deps: EngineDeps, a: AutomationRow, opts: { now?: Date; signal?: AbortSignal } = {}): Promise<AutomationTestResponse> {
  const now = opts.now ?? new Date()
  const tz = deps.config.FACTORY_TIMEZONE
  const ranAt = now.toISOString()
  const state = (await creatorStates(deps.db, [a.creatorId])).get(a.creatorId)
  const blocked = blockedReason(a.creatorId, state, await appState(deps.db, deps.config, deps.readers.ready))
  if (blocked) return { ranAt, ok: false, error: blockedNote(blocked) }
  const pool = deps.readers.poolFor(creatorDomains(state))
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), a.kind === 'watch' ? WATCH_RUN_TIMEOUT_MS : REPORT_RUN_TIMEOUT_MS)
  timer.unref()
  const onLeave = () => ac.abort()
  if (opts.signal?.aborted) onLeave()
  else opts.signal?.addEventListener('abort', onLeave, { once: true })
  try {
    if (a.kind === 'report') {
      // Its own sections, or its saved report as it stands, with the values its inputs take today.
      const prepared = await prepareReport(deps.db, a.creatorId, a.schedule!, now, tz)
      if ('error' in prepared) return { ranAt, ok: false, error: prepared.error }
      const period = prepared.period
      // The rows a card shows, not a delivery's: nothing is kept. Each section as its creator's domains are when it starts.
      const ran = await withQueryOrigin({ source: 'scheduled-report', userId: a.creatorId, purpose: a.name }, () =>
        runSections(readerFor(deps, a.creatorId), prepared.sections, tz, ac.signal, AI_PREVIEW_ROWS),
      )
      if (ran.blocked) return { ranAt, ok: false, error: blockedNote(ran.blocked) }
      const sections = ran.sections.map((s) => ({ ...s, ...previewOf(s) }))
      const recipients = await recipientCount(deps.db, a, [])
      const out: AutomationTestResponse = { ranAt, ok: sections.every((s) => s.ok), sections, recipients }
      if (period) out.period = period
      const failed = sections.find((s) => !s.ok)
      if (failed) out.error = sectionError(failed)
      return out
    }
    const w = a.watch!
    const run = await withQueryOrigin({ source: 'automation', userId: a.creatorId, purpose: a.name }, () =>
      runReadOnlyQuery(pool, w.sql, { maxRows: AUTOMATION_WATCH_MAX_ROWS, timeoutMs: AUTOMATION_QUERY_TIMEOUT_MS, timeZone: tz, signal: ac.signal }),
    )
    if (!run.ok) return { ranAt, ok: false, error: queryErrorForPeople(run) }
    const found = casesOf(w, run, a.name)
    if ('error' in found) return { ranAt, ok: false, error: found.error }
    const { rows } = await deps.db.query<{ key: string }>(`SELECT case_key AS key FROM ai_automation_hits WHERE automation_id = $1 AND case_key = ANY($2::text[])`, [
      a.id,
      found.cases.map((c) => c.key),
    ])
    const seen = new Set(rows.map((r) => r.key))
    const fresh = found.cases.filter((c) => !seen.has(c.key))
    const bt = watchBacktest(w, run, now)
    const recipientColumns = a.recipients.flatMap((r) => (r.kind === 'column' ? [r.column] : []))
    const named = fresh.flatMap((c) => recipientColumns.map((col) => c.row[run.columns.indexOf(col)]).filter((v) => v !== undefined))
    const out: AutomationTestResponse = {
      ranAt,
      ok: true,
      matched: run.rows.length,
      newCases: fresh.length,
      truncated: run.truncated,
      columns: run.columns,
      sampleRows: bt.sampleRows,
      recipients: a.actions.notify ? await recipientCount(deps.db, a, distinctIds(named)) : 0,
    }
    if (bt.sampleTitle !== undefined) out.sampleTitle = bt.sampleTitle
    if (bt.sampleBody !== undefined) out.sampleBody = bt.sampleBody
    return out
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onLeave)
  }
}

/** How many people a run would tell now: the recipients named, every account of their roles, and the people the cases name. */
async function recipientCount(q: Queryable, a: AutomationRow, named: string[]): Promise<number> {
  const users = a.recipients.flatMap((r) => (r.kind === 'user' ? [r.userId] : []))
  const roles = a.recipients.flatMap((r) => (r.kind === 'role' ? [r.role as Role] : []))
  return (await activeUserIds(q, { userIds: [...users, ...named], roles })).length
}

// ---- The scheduler ------------------------------------------------------------------------

export interface EngineOptions {
  /** The clock; the tests set it. */
  now?: () => Date
  concurrency?: number
  tickMs?: number
}

export class AutomationEngine {
  private timer: NodeJS.Timeout | null = null
  private firstTick: NodeJS.Timeout | null = null
  private stopping = false
  /** Aborted by stop(): the runs under way are cut short and handed back. */
  private readonly halt = new AbortController()
  /** Workers taking and running due automations now: never more than the concurrency. */
  private workers = 0
  /** Everything under way (ticks and the workers they started), which stop() waits for. */
  private readonly pending = new Set<Promise<unknown>>()
  /** Escalation and the purge under way: a tick that finds them going joins them. */
  private upkeepRun: Promise<void> | null = null
  private lastPurge = 0
  private readonly now: () => Date

  constructor(
    private readonly deps: EngineDeps,
    private readonly options: EngineOptions = {},
  ) {
    this.now = options.now ?? (() => new Date())
  }

  /** Tick every ENGINE_TICK_MS from now on, the first one soon. */
  start(): void {
    if (this.timer || this.stopping) return
    const every = this.options.tickMs ?? ENGINE_TICK_MS
    const tick = () => {
      this.tick().catch((e) => console.error('[automations] tick failed', e))
    }
    this.timer = setInterval(tick, every)
    this.timer.unref()
    this.firstTick = setTimeout(() => {
      this.firstTick = null
      tick()
    }, Math.min(every, 5_000))
    this.firstTick.unref()
  }

  /**
   * Stop for good: no more ticks and no more automations taken; the runs under
   * way are cut short and handed back (due again at once, for another
   * instance), and what is left of the work under way finishes.
   */
  async stop(): Promise<void> {
    this.stopping = true
    if (this.timer) clearInterval(this.timer)
    if (this.firstTick) clearTimeout(this.firstTick)
    this.timer = null
    this.firstTick = null
    this.halt.abort(STOPPING)
    while (this.pending.size > 0) await Promise.allSettled([...this.pending])
  }

  /**
   * One tick: runs lost with an instance handed back, then the places free
   * (up to the concurrency) take due automations until none is left, while
   * overdue follow-ups are escalated. Resolves when the work it started is
   * done; a tick while every place is taken only does the housekeeping.
   */
  tick(): Promise<void> {
    if (this.stopping) return Promise.resolve()
    return this.track(this.work())
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.pending.add(p)
    const done = () => this.pending.delete(p)
    p.then(done, done)
    return p
  }

  private async work(): Promise<void> {
    const now = this.now()
    try {
      await recoverLostRuns(this.deps, now)
    } catch (e) {
      console.error('[automations] could not hand back lost runs', e)
    }
    if (this.stopping) return
    const room = Math.max(0, Math.max(1, this.options.concurrency ?? ENGINE_CONCURRENCY) - this.workers)
    const started = Array.from({ length: room }, () => this.worker())
    await Promise.all([this.upkeep(now), ...started])
  }

  /** Take due automations one by one and run them, until none is left (or the backstop, or the engine stops). */
  private async worker(): Promise<void> {
    // Counted before the first wait, so ticks at the same moment never start more than the room.
    this.workers++
    try {
      for (let i = 0; i < CLAIMS_PER_TICK && !this.stopping; i++) {
        let claim: Claim
        try {
          claim = await claimDue(this.deps, this.now())
        } catch (e) {
          console.error('[automations] could not take a due automation', e)
          return
        }
        if (!claim) return
        if (claim.kind === 'run') await runClaimed(this.deps, claim.claimed, this.halt.signal)
      }
    } finally {
      this.workers--
    }
  }

  /** Overdue follow-ups escalated, and old alerts removed once a day: one at a time, joined by the ticks meanwhile. */
  private upkeep(now: Date): Promise<void> {
    this.upkeepRun ??= this.housekeeping(now).finally(() => {
      this.upkeepRun = null
    })
    return this.upkeepRun
  }

  /** Never throws. */
  private async housekeeping(now: Date): Promise<void> {
    try {
      // In one transaction: a claim whose alerts fail is not kept, so the next tick tells them.
      await withTransaction(this.deps.db, (tx) =>
        escalateOverdue(tx, now, async (automationId) => {
          const { rows } = await tx.query<{ creatorId: string }>(`SELECT creator_id AS "creatorId" FROM ai_automations WHERE id = $1`, [automationId])
          return rows[0]?.creatorId ?? null
        }),
      )
    } catch (e) {
      console.error('[automations] could not escalate overdue follow-ups', e)
    }
    if (now.getTime() - this.lastPurge < PURGE_EVERY_MS) return
    try {
      await purgeNotifications(this.deps.db, now)
      this.lastPurge = now.getTime()
    } catch (e) {
      console.error('[automations] could not remove old alerts', e)
    }
  }
}
