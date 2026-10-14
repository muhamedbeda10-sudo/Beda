// ============================================================================
// §20 — the assistant's slow queries (migration 0056). Every query it runs
// goes through runReadOnlyQuery, which tells the observer set here how long
// it took; one that took SLOW_QUERY_MS or more is kept, with where it ran and
// for whom, so the owner sees which questions are heavy and the views or
// indexes behind them can be fixed rather than the time limit raised.
//
// Where a query runs is set around the work that runs it (withQueryOrigin):
// a chat's tool call, a report's run, a scheduled report, an Excel file, a
// saved table, an export. It follows the work through every await
// (AsyncLocalStorage), so nothing in between has to carry it; a query run
// outside any is kept as 'other'.
// ============================================================================

import { AsyncLocalStorage } from 'node:async_hooks'
import type { AiSlowQuery, AiSlowQuerySource } from '@qc/shared/ai'
import type { Db } from '../db/pool'
import { observeQueries, type QueryRun } from './runQuery'

/** A query that took this long or longer is kept. */
export const SLOW_QUERY_MS = 10_000
/** How long a slow query is kept. */
const KEEP_DAYS = 90
/** What is kept of a query's purpose and of its error. */
const PURPOSE_MAX = 500
const ERROR_MAX = 1000
const SQL_MAX = 100_000

/** Where a query runs, and for whom. */
export interface QueryOrigin {
  source: AiSlowQuerySource
  userId: string | null
  conversationId?: string | null
  /** What it is for, in a few words: the query's purpose, a report's or file's name and its section. */
  purpose?: string | null
}

const origins = new AsyncLocalStorage<QueryOrigin>()

/** Run `work` with its queries known to come from `origin`; inside another origin, what is not said is kept from it. */
export function withQueryOrigin<T>(origin: Partial<QueryOrigin>, work: () => Promise<T>): Promise<T> {
  const outer = origins.getStore()
  return origins.run({ source: 'other', userId: null, ...outer, ...origin }, work)
}

/** Run `work` with its queries' purpose followed by `part` (a report's section, a file's sheet): "Weekly scrap · By machine". */
export function withQueryPurpose<T>(part: string, work: () => Promise<T>): Promise<T> {
  const outer = origins.getStore()
  const purpose = outer?.purpose ? `${outer.purpose} · ${part}` : part
  return origins.run({ source: 'other', userId: null, ...outer, purpose }, work)
}

/** Where a query run now would be kept as coming from; null outside any origin. */
export const currentQueryOrigin = (): QueryOrigin | null => origins.getStore() ?? null

const cut = (s: string | null | undefined, max: number): string | null => (s ? (s.length > max ? `${s.slice(0, max - 1)}…` : s) : null)

/** How a run ended, as kept: a query stopped by the person or the clock of its answer is not the query's slowness. */
function outcomeOf(run: QueryRun): 'ok' | 'timeout' | 'error' | null {
  if (run.ok) return 'ok'
  if (run.failure === 'stopped') return null
  return run.failure === 'timeout' ? 'timeout' : 'error'
}

/** Keep one slow query, and let go of those older than KEEP_DAYS. */
export async function recordSlowQuery(db: Db, origin: QueryOrigin, sql: string, run: QueryRun): Promise<void> {
  const outcome = outcomeOf(run)
  if (!outcome) return
  await db.query(
    `WITH gone AS (DELETE FROM ai_slow_queries WHERE at < now() - make_interval(days => $9))
     INSERT INTO ai_slow_queries (source, user_id, conversation_id, purpose, sql, duration_ms, outcome, error, row_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $10)`,
    [
      origin.source,
      origin.userId,
      origin.conversationId ?? null,
      cut(origin.purpose, PURPOSE_MAX),
      cut(sql, SQL_MAX) ?? '',
      Math.max(0, Math.round(run.ms)),
      outcome,
      outcome === 'ok' ? null : cut(run.error, ERROR_MAX),
      KEEP_DAYS,
      run.ok ? run.rows.length : null,
    ],
  )
}

/**
 * From now on, every query the assistant runs that took SLOW_QUERY_MS or more is kept in `db` (createApp). Kept on the
 * side: the query's own answer never waits for it, nor fails with it.
 */
export function keepSlowQueries(db: Db): void {
  observeQueries((sql, run) => {
    if (run.ms < SLOW_QUERY_MS) return
    const origin = origins.getStore() ?? { source: 'other', userId: null }
    void recordSlowQuery(db, origin, sql, run).catch((e) => console.warn('[ai] a slow query could not be kept:', e instanceof Error ? e.message : String(e)))
  })
}

/** The slow queries, newest first, with the name of whom each ran for. */
export async function listSlowQueries(db: Db, limit: number): Promise<AiSlowQuery[]> {
  const { rows } = await db.query<AiSlowQuery>(
    `SELECT s.id::text AS id, s.at, s.source, s.user_id AS "userId", u.name AS "userName", s.conversation_id AS "conversationId",
            s.purpose, s.sql, s.duration_ms AS "durationMs", s.outcome, s.error, s.row_count AS "rowCount"
       FROM ai_slow_queries s LEFT JOIN users u ON u.id = s.user_id
      ORDER BY s.at DESC, s.id DESC
      LIMIT $1`,
    [limit],
  )
  return rows
}
