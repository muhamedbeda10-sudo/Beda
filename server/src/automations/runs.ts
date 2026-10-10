// ============================================================================
// §21 — an automation's run history: when each run started and ended, what
// it found and whom it told, and why it failed. Kept for every run (none of
// it is audited: there would be too many); never a cost.
// ============================================================================

import type { AutomationRun, AutomationRunTrigger, AutomationRunsResponse } from '@qc/shared/automation'
import type { Queryable } from '../db/pool'

/** Runs a page of the history shows. */
export const RUNS_PAGE = 30

interface RunRow {
  id: string
  automationId: string
  trigger: AutomationRunTrigger
  startedAt: string
  finishedAt: string | null
  ok: boolean | null
  error: string | null
  ms: number | null
  matched: number | null
  fired: number | null
  notified: number | null
  followUps: number | null
  digest: boolean
  note: string | null
  deliveryId: string | null
}

const RUN_COLUMNS = `r.id, r.automation_id AS "automationId", r.trigger, r.started_at AS "startedAt", r.finished_at AS "finishedAt", r.ok, r.error,
       r.ms, r.matched, r.fired, r.notified, r.follow_ups AS "followUps", r.digest, r.note, r.delivery_id AS "deliveryId"`

export function toRun(r: RunRow): AutomationRun {
  const run: AutomationRun = { id: r.id, automationId: r.automationId, trigger: r.trigger, startedAt: r.startedAt, finishedAt: r.finishedAt, ok: r.ok }
  if (r.error) run.error = r.error
  if (r.ms !== null) run.ms = r.ms
  if (r.matched !== null) run.matched = r.matched
  if (r.fired !== null) run.fired = r.fired
  if (r.notified !== null) run.notified = r.notified
  if (r.followUps !== null) run.followUps = r.followUps
  if (r.digest) run.digest = true
  if (r.note) run.note = r.note
  if (r.deliveryId) run.deliveryId = r.deliveryId
  return run
}

/** A run's record begun, at the engine's clock; its result comes with finishRun. */
export async function beginRun(q: Queryable, automationId: string, trigger: AutomationRunTrigger, startedAt: Date): Promise<string> {
  const { rows } = await q.query<{ id: string }>(`INSERT INTO ai_automation_runs (automation_id, trigger, started_at) VALUES ($1, $2, $3) RETURNING id`, [
    automationId,
    trigger,
    startedAt.toISOString(),
  ])
  return rows[0].id
}

/** A run that never happened: recorded as it was skipped, finished at once. */
export async function skippedRun(q: Queryable, automationId: string, at: Date, note: string): Promise<void> {
  await q.query(
    `INSERT INTO ai_automation_runs (automation_id, trigger, started_at, finished_at, ok, ms, note) VALUES ($1, 'schedule', $2, $2, false, 0, $3)`,
    [automationId, at.toISOString(), note],
  )
}

export const INTERRUPTED_ERROR = 'Interrupted: the server stopped during this run.'

/** A run left unfinished by an instance that stopped mid-run, as closed: whether it got as far as telling people. */
export interface LostRun {
  id: string
  trigger: AutomationRunTrigger
  startedAt: string
  /** It delivered its report, or recorded its cases (and told people), before the instance stopped. */
  completed: boolean
}

/**
 * Runs left unfinished by an instance that stopped mid-run, closed. One that
 * had already delivered its report, or recorded its new cases (which it does
 * in one transaction with telling people), is closed as the success it was,
 * with what is known of it; any other as interrupted.
 */
export async function closeLostRuns(q: Queryable, automationId: string, at: Date): Promise<LostRun[]> {
  const { rows } = await q.query<LostRun>(
    `WITH lost AS (
       SELECT r.id,
              (SELECT d.id FROM ai_report_deliveries d WHERE d.automation_id = $1 AND d.run_id = r.id LIMIT 1) AS delivery,
              (SELECT count(*)::int FROM ai_automation_hits h WHERE h.automation_id = $1 AND h.run_id = r.id) AS fired
         FROM ai_automation_runs r
        WHERE r.automation_id = $1 AND r.finished_at IS NULL
        FOR UPDATE OF r)
     UPDATE ai_automation_runs r
        SET finished_at = $2,
            ok = (lost.delivery IS NOT NULL OR lost.fired > 0),
            error = CASE WHEN lost.delivery IS NOT NULL OR lost.fired > 0 THEN NULL ELSE '${INTERRUPTED_ERROR}' END,
            delivery_id = lost.delivery,
            fired = CASE WHEN lost.fired > 0 THEN lost.fired ELSE r.fired END,
            note = CASE WHEN lost.delivery IS NOT NULL THEN 'The server stopped just after this run delivered its report; what else it did was not recorded.'
                        WHEN lost.fired > 0 THEN 'The server stopped just after this run told people about its new cases; how many people was not recorded.'
                        ELSE r.note END
       FROM lost
      WHERE r.id = lost.id
      RETURNING r.id, r.trigger, r.started_at AS "startedAt", r.ok AS completed`,
    [automationId, at.toISOString()],
  )
  return rows
}

export async function findRun(q: Queryable, id: string): Promise<AutomationRun | null> {
  const { rows } = await q.query<RunRow>(`SELECT ${RUN_COLUMNS} FROM ai_automation_runs r WHERE r.id = $1`, [id])
  return rows[0] ? toRun(rows[0]) : null
}

/** An automation's runs, newest first, a page at a time: `before` is the last run of the page read. */
export async function listRuns(q: Queryable, automationId: string, before: string | null): Promise<AutomationRunsResponse> {
  const { rows } = await q.query<RunRow>(
    `SELECT ${RUN_COLUMNS} FROM ai_automation_runs r
      WHERE r.automation_id = $1
        AND ($2::uuid IS NULL OR (r.started_at, r.id) < (SELECT b.started_at, b.id FROM ai_automation_runs b WHERE b.id = $2 AND b.automation_id = $1))
      ORDER BY r.started_at DESC, r.id DESC LIMIT $3`,
    [automationId, before, RUNS_PAGE + 1],
  )
  return { runs: rows.slice(0, RUNS_PAGE).map(toRun), hasMore: rows.length > RUNS_PAGE }
}
