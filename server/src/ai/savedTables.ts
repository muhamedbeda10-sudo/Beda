// ============================================================================
// The assistant's saved tables (migration 0050): what it keeps to build on.
// A table is the stored result of a query over the ai views and other saved
// tables, computed again by the database alone on a schedule, or rows the
// assistant wrote out. Questions, reports and automations read it as
// ai_saved.<name>, through the reader roles, like any view.
//
// What keeps a table no wider than its readers:
//   • its query only ever runs through the sandbox (runReadOnlyQuery), as a
//     reader role: the asker's own domains when it is made, and the domains
//     the query reads when it is computed again;
//   • which domains it reads is asked of PostgreSQL every time it is
//     computed, not taken from the text: the query is planned (EXPLAIN, no
//     data read) as the role of every domain but one, once per domain; the
//     domains without which it is refused are the ones it reads. Every view
//     belongs to one domain, and a saved table is granted to the roles that
//     cover its own, so this holds through tables built on tables;
//   • the table is granted to exactly the combination roles that hold all of
//     those domains. Rows the assistant writes out may have been copied from
//     anything the conversation read before, so theirs are the domains of
//     every query the assistant ran or built in it (conversationDomains),
//     asked of PostgreSQL the same way;
//   • it is written in one transaction as the API: built beside the old one,
//     then put in its place with its grants, so a reader sees the old rows or
//     the new ones, never half; and only when its definition has not changed
//     since the computation began (a replace while a scheduled run was under
//     way wins).
//
// Who may do what: anyone given the assistant may make a table and compute
// again any table they may read; whoever made it, and the assistant's owner,
// may replace or remove it. Every change is in the append-only history and
// the audit log.
// ============================================================================

import pg from 'pg'
import { AI_DOMAIN_IDS, type AiCell, type AiDomain } from '@qc/shared/ai'
import {
  SAVED_TABLE_COLUMN_PATTERN,
  SAVED_TABLE_MAX_COLUMNS,
  SAVED_TABLE_MAX_LITERAL_ROWS,
  SAVED_TABLE_MAX_LIVE,
  SAVED_TABLE_MAX_ROWS,
  SAVED_TABLE_NAME_PATTERN,
  SAVED_TABLE_PREVIEW_ROWS,
  SAVED_TABLE_SCHEMA,
  SAVED_TABLE_SUMMARY_MAX,
  type SavedTable,
  type SavedTableColumn,
  type SavedTableColumnType,
  type SavedTableRefresh,
  type SavedTableRowsResponse,
  type SavedTableSource,
} from '@qc/shared/savedTables'
import { auditEvent } from '@qc/shared/audit'
import { auditCreate, auditDelete, writeAudit } from '../audit/service'
import { withTransaction, type Db, type Queryable } from '../db/pool'
import { AI_DOMAIN_COMBINATIONS, canonicalDomains, combinationRole, domainRole, storedDomains } from './domains'
import { AI_QUERY_TIMEOUT_MS, codeOnly, precheckSql, refusedByName, refusedByNameOn, runReadOnlyQuery } from './runQuery'
import { RUN_SQL_TOOL_NAME } from './prompt'
import { withQueryOrigin } from './slowQueries'

/** A computation's query may take this long: the most the runner allows. */
export const SAVED_TABLE_QUERY_TIMEOUT_MS = AI_QUERY_TIMEOUT_MS
/** Planning the query as one role, to learn what it reads. */
const EXPLAIN_TIMEOUT_MS = 5_000
/** What a computation may hold while it is written. */
const COMPUTE_MAX_CHARS = 20_000_000
const COMPUTE_MAX_ROW_BYTES = 256 * 1024
/** Rows written by one INSERT. */
const WRITE_BATCH_ROWS = 2_000
/** How long a computation holds its table: no other starts on it meanwhile, on any instance. */
const LEASE_MINUTES = 10
/** How long the write waits for the readers of the table it replaces. */
const WRITE_LOCK_TIMEOUT = '15s'
/** A nightly table is computed at this factory hour. */
const NIGHTLY_HOUR = 3
/** A scheduled computation that failed is tried again after this long, or at its next time when that comes sooner. */
const RETRY_MINUTES = 60
/** Rows written out, as JSON, at most. */
const LITERAL_MAX_CHARS = 2_000_000

/** The readers a computation runs through: the pool of a set of domains. */
export interface SavedTableReaders {
  readonly ready: boolean
  poolFor(domains: readonly AiDomain[]): pg.Pool | null
}

export interface SavedTableDeps {
  db: Db
  readers: SavedTableReaders
  timeZone: string
}

/** Who is acting, as of now. */
export interface SavedTableActor {
  id: string
  name: string
  /** The assistant's owner: may replace or remove any table they can read. */
  owner: boolean
  /** The domains they may read now. */
  domains: AiDomain[]
}

/** Where a change was made: the answer and the tool call, when the assistant made it. */
export interface SavedTableOrigin {
  conversationId: string
  turnId: string
  toolUseId: string
}

export interface LiteralColumn {
  name: string
  type: SavedTableColumnType
  note?: string
}

/** A table's definition as the assistant gives it. */
export type SavedTableDefinition = {
  name: string
  title: string
  /** What the table shows, plainly; none leaves it empty. */
  summary?: string
  description: string
} & (
  | { source: 'query'; sql: string; refresh: SavedTableRefresh; notes: Record<string, string> }
  | {
      source: 'rows'
      columns: LiteralColumn[]
      rows: unknown[][]
      /** The domains of the data the rows may have been copied from (conversationDomains): only those who hold them all may read them. None: everyone. */
      domains?: AiDomain[]
    }
)

/** What a save, a computation or a removal did; or, when nothing changed, why. */
export type SavedTableOutcome =
  | { ok: true; changeId: string; table: SavedTable }
  | { ok: false; error: string }

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error })

// ---- Reading the definitions -------------------------------------------------------

interface TableRow {
  id: string
  name: string
  title: string
  summary: string
  description: string
  source: SavedTableSource
  sql: string | null
  literal: { columns: LiteralColumn[]; rows: unknown[][] } | null
  columnNotes: Record<string, string>
  refresh: SavedTableRefresh
  domains: string[]
  dependsOn: string[]
  version: number
  columns: { name: string; type: string }[]
  rowCount: number | null
  refreshedAt: string | null
  nextRefreshAt: string | null
  lastError: string | null
  lastErrorAt: string | null
  failures: number
  createdById: string
  createdByName: string
  createdAt: string
  updatedByName: string
  updatedAt: string
}

const TABLE_SELECT = `t.id, t.name, t.title, t.summary, t.description, t.source, t.sql, t.literal, t.column_notes AS "columnNotes", t.refresh,
  t.domains, t.depends_on AS "dependsOn", t.version, t.columns, t.row_count AS "rowCount", t.refreshed_at AS "refreshedAt",
  t.next_refresh_at AS "nextRefreshAt", t.last_error AS "lastError", t.last_error_at AS "lastErrorAt", t.failures,
  t.created_by_id AS "createdById", t.created_by_name AS "createdByName", t.created_at AS "createdAt",
  t.updated_by_name AS "updatedByName", t.updated_at AS "updatedAt"`

const iso = (v: string | null) => (v ? new Date(v).toISOString() : null)

/** Whether someone reading these domains may read the table. */
const readable = (r: Pick<TableRow, 'domains'>, domains: readonly AiDomain[]) => storedDomains(r.domains).length === r.domains.length && r.domains.every((d) => domains.includes(d as AiDomain))

function toTable(r: TableRow, viewer: { id: string; owner: boolean } | null): SavedTable {
  return {
    id: r.id,
    name: r.name,
    title: r.title,
    summary: r.summary,
    description: r.description,
    source: r.source,
    sql: r.sql,
    refresh: r.refresh,
    domains: storedDomains(r.domains),
    dependsOn: r.dependsOn,
    columns: r.columns.map((c): SavedTableColumn => ({ name: c.name, type: c.type, note: r.columnNotes[c.name] ?? '' })),
    rowCount: r.rowCount,
    version: r.version,
    refreshedAt: iso(r.refreshedAt),
    nextRefreshAt: iso(r.nextRefreshAt),
    lastError: r.lastError,
    lastErrorAt: iso(r.lastErrorAt),
    createdByName: r.createdByName,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedByName: r.updatedByName,
    updatedAt: new Date(r.updatedAt).toISOString(),
    mayRefresh: viewer !== null && r.source === 'query',
    mayRemove: viewer !== null && (viewer.owner || viewer.id === r.createdById),
  }
}

async function findLive(q: Queryable, by: { id?: string; name?: string }, lock = false): Promise<TableRow | null> {
  const { rows } = await q.query<TableRow>(
    `SELECT ${TABLE_SELECT} FROM ai_saved_tables t
      WHERE t.deleted_at IS NULL AND ($1::uuid IS NULL OR t.id = $1) AND ($2::text IS NULL OR t.name = $2)${lock ? ' FOR UPDATE' : ''}`,
    [by.id ?? null, by.name ?? null],
  )
  return rows[0] ?? null
}

/** The live tables someone reading these domains may read, by name. */
export async function listSavedTables(q: Queryable, viewer: { id: string; owner: boolean; domains: readonly AiDomain[] }): Promise<SavedTable[]> {
  const { rows } = await q.query<TableRow>(`SELECT ${TABLE_SELECT} FROM ai_saved_tables t WHERE t.deleted_at IS NULL ORDER BY t.name COLLATE "C"`)
  return rows.filter((r) => readable(r, viewer.domains)).map((r) => toTable(r, viewer))
}

/** One live table, when the viewer may read it. */
export async function findSavedTable(q: Queryable, viewer: { id: string; owner: boolean; domains: readonly AiDomain[] }, by: { id?: string; name?: string }): Promise<SavedTable | null> {
  const row = await findLive(q, by)
  return row && readable(row, viewer.domains) ? toTable(row, viewer) : null
}

/**
 * The saved tables someone reading these domains may read, for the data
 * dictionary of a new conversation: deterministic, so the same tables give the
 * same bytes (what was computed when is left out).
 */
export async function describeSavedTables(q: Queryable, domains: readonly AiDomain[]): Promise<string> {
  const tables = await listSavedTables(q, { id: '', owner: false, domains })
  if (tables.length === 0) return ''
  const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
  const out = [
    `## Saved tables (schema ${SAVED_TABLE_SCHEMA})`,
    '',
    `Tables the assistant saved earlier, read like the views (ai_saved.<name>). Each says where its rows come from and how often they are computed again; check refreshed_at with list_saved_tables when freshness matters.`,
    '',
  ]
  for (const t of tables) {
    out.push(`### ${SAVED_TABLE_SCHEMA}.${t.name}`)
    out.push(oneLine(`${t.title}. ${t.description}`))
    out.push(t.source === 'query' ? `Computed from a query, ${t.refresh === 'never' ? 'once (kept as computed)' : t.refresh === 'hourly' ? 'every hour' : 'every night'}.` : 'Rows written out by hand.')
    for (const c of t.columns) out.push(c.note ? `- ${c.name} ${c.type}: ${oneLine(c.note)}` : `- ${c.name} ${c.type}`)
    out.push('')
  }
  return out.join('\n').trimEnd()
}

// ---- What a query reads ------------------------------------------------------------

/** The saved tables a query names (ai_saved.<name>), once each, in order. */
export function savedTablesNamed(sql: string): string[] {
  const names = new Set<string>()
  for (const m of codeOnly(sql).matchAll(/\bai_saved\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(m[1].toLowerCase())
  return [...names]
}

type Planned = { ok: true } | { ok: false; code: string | undefined; message: string }

/** Plan the query as a pool's role, reading nothing. One statement only: the extended protocol refuses a second. */
async function plans(pool: pg.Pool, sql: string): Promise<Planned> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN READ ONLY')
    await client.query(`SET LOCAL statement_timeout = '${EXPLAIN_TIMEOUT_MS}ms'`)
    await client.query({ name: 'ai_saved_plan', text: `EXPLAIN (COSTS OFF) ${sql}` })
    return { ok: true }
  } catch (e) {
    const err = e as { code?: string; message?: string }
    return { ok: false, code: err.code, message: err.message ?? 'The query could not be planned.' }
  } finally {
    // The connection goes, as the runner's do: nothing the plan left in its session outlives it.
    await client.query('ROLLBACK').catch(() => undefined)
    client.release(true)
  }
}

/**
 * The domains a query reads, as PostgreSQL answers it: planned as the role of
 * every domain, then of every domain but one, once per domain; with a
 * sentence instead when it cannot be planned at all.
 */
export async function domainsRead(readers: SavedTableReaders, sql: string): Promise<{ domains: AiDomain[] } | { error: string }> {
  const all = readers.poolFor(AI_DOMAIN_IDS)
  if (!readers.ready || !all) return { error: 'The assistant cannot read the database right now. Try again later.' }
  // Planning may evaluate a function with constant arguments: never one the runner refuses, however it is written.
  const refused = await refusedByNameOn(all, sql)
  const whole: Planned = refused ? { ok: false, code: refused.code, message: refused.error } : await plans(all, sql)
  if (!whole.ok) {
    const outside = whole.code === '42501' || whole.code === '3F000'
    return { error: `${whole.message}${outside ? ' Only the views and functions in schema ai, and the saved tables in schema ai_saved, can be read.' : ''}` }
  }
  const needed: AiDomain[] = []
  for (const d of AI_DOMAIN_IDS) {
    const pool = readers.poolFor(AI_DOMAIN_IDS.filter((x) => x !== d))
    if (!pool) return { error: 'The assistant cannot read the database right now. Try again later.' }
    const planned = await plans(pool, sql)
    if (!planned.ok) {
      if (planned.code === '42501') needed.push(d)
      else return { error: planned.message }
    }
  }
  return { domains: needed }
}

/**
 * Plan each query as a pool's role, reading nothing, on one connection: each in its own savepoint, so one refused
 * leaves the next its chance. `untilRefused`: stop at the first refused for want of a privilege (42501).
 */
async function planEach(pool: pg.Pool, sqls: readonly string[], untilRefused = false): Promise<Planned[]> {
  const client = await pool.connect()
  const out: Planned[] = []
  try {
    await client.query('BEGIN READ ONLY')
    await client.query(`SET LOCAL statement_timeout = '${EXPLAIN_TIMEOUT_MS}ms'`)
    for (const sql of sqls) {
      await client.query('SAVEPOINT ai_plan')
      try {
        // The extended protocol: one statement only, as the runner sends it.
        const explain: pg.QueryConfig & { queryMode: 'extended' } = { text: `EXPLAIN (COSTS OFF) ${sql}`, queryMode: 'extended' }
        await client.query(explain)
        out.push({ ok: true })
      } catch (e) {
        const err = e as { code?: string; message?: string }
        out.push({ ok: false, code: err.code, message: err.message ?? 'The query could not be planned.' })
      }
      await client.query('ROLLBACK TO SAVEPOINT ai_plan')
      if (untilRefused && out.at(-1)?.ok === false && (out.at(-1) as { code?: string }).code === '42501') break
    }
  } finally {
    // The connection goes, as the runner's do: nothing the plans left in its session outlives it.
    await client.query('ROLLBACK').catch(() => undefined)
    client.release(true)
  }
  return out
}

/** The queries PostgreSQL's own reading of which calls nothing the runner refuses (refusedByName), on one connection thrown away after. */
async function notRefused(pool: pg.Pool, sqls: readonly string[]): Promise<string[]> {
  const client = await pool.connect()
  const out: string[] = []
  try {
    for (const sql of sqls) {
      // One it cannot read at all is kept: planning it says no more.
      const refused = await refusedByName(client, sql).catch(() => null)
      if (!refused) out.push(sql)
    }
  } finally {
    client.release(true)
  }
  return out
}

/** Every string under a key named `sql` in a tool call's input, however deep, and the saved reports it names by id. */
function sqlOf(input: unknown, sqls: Set<string>, reports: Set<string>): void {
  if (Array.isArray(input)) {
    for (const v of input) sqlOf(v, sqls, reports)
  } else if (input && typeof input === 'object') {
    for (const [key, v] of Object.entries(input)) {
      if (key === 'sql' && typeof v === 'string') sqls.add(v)
      else if ((key === 'reportId' || key === 'report_id') && typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v.trim())) reports.add(v.trim().toLowerCase())
      else sqlOf(v, sqls, reports)
    }
  }
}

/**
 * The domains a query names, read from its text: the ai views and functions it names that belong to a domain, and
 * the saved tables it names, as they were kept (a table removed since too). For a query that can no longer be planned
 * (a template with placeholders, a table removed since): wider than its plan would be, never narrower.
 */
async function domainsNamed(q: Queryable, sqls: readonly string[]): Promise<AiDomain[]> {
  if (sqls.length === 0) return []
  const { rows: db } = await q.query<{ database: string }>(`SELECT current_database() AS database`)
  const roles = AI_DOMAIN_IDS.map((d) => domainRole(db[0].database, d))
  const { rows: owned } = await q.query<{ name: string; domains: AiDomain[] }>(
    `SELECT o.name, array_agg(d.domain ORDER BY d.domain) AS domains
       FROM (SELECT c.relname AS name, c.oid, 'table' AS what FROM pg_class c WHERE c.relnamespace = 'ai'::regnamespace AND c.relkind IN ('v', 'm', 'r', 'p', 'f')
             UNION ALL
             SELECT p.proname, p.oid, 'function' FROM pg_proc p WHERE p.pronamespace = 'ai'::regnamespace) o
      CROSS JOIN unnest($1::text[], $2::text[]) AS d(domain, role)
      WHERE CASE o.what WHEN 'table' THEN has_table_privilege(d.role, o.oid, 'SELECT') ELSE has_function_privilege(d.role, o.oid, 'EXECUTE') END
      GROUP BY o.name`,
    [AI_DOMAIN_IDS, roles],
  )
  // What every domain may use (the shared helpers) belongs to none.
  const byName = new Map(owned.filter((o) => o.domains.length < AI_DOMAIN_IDS.length).map((o) => [o.name.toLowerCase(), o.domains]))
  const found = new Set<AiDomain>()
  const tables = new Set<string>()
  for (const sql of sqls) {
    const code = codeOnly(sql)
    for (const word of code.match(/[A-Za-z_][A-Za-z0-9_$]*/g) ?? []) for (const d of byName.get(word.toLowerCase()) ?? []) found.add(d)
    for (const t of savedTablesNamed(sql)) tables.add(t)
  }
  if (tables.size > 0) {
    const { rows } = await q.query<{ domains: string[] }>(`SELECT domains FROM ai_saved_tables WHERE name = ANY($1::text[])`, [[...tables]])
    for (const r of rows) for (const d of storedDomains(r.domains)) found.add(d)
  }
  return canonicalDomains([...found])
}

/** The domains a set of queries reads together: each planned as domainsRead plans one, or read from its text when it cannot be planned. */
async function domainsReadByAll(deps: SavedTableDeps, texts: Iterable<string>): Promise<{ domains: AiDomain[] } | { error: string }> {
  // Only what could have run: a query the runner refuses never read anything.
  const texted = [...new Set(texts)].flatMap((t) => {
    const checked = precheckSql(t)
    return 'sql' in checked ? [checked.sql] : []
  })
  if (texted.length === 0) return { domains: [] }
  const all = deps.readers.poolFor(AI_DOMAIN_IDS)
  if (!deps.readers.ready || !all) return { error: 'The assistant cannot read the database right now. Try again later.' }
  // Planning may evaluate a function with constant arguments: a query calling one the runner refuses never ran, and is not planned.
  const sqls = await notRefused(all, texted)
  if (sqls.length === 0) return { domains: [] }
  const whole = await planEach(all, sqls)
  const planned = sqls.filter((_, i) => whole[i].ok)
  const needed = new Set<AiDomain>(await domainsNamed(deps.db, sqls.filter((_, i) => !whole[i].ok)))
  for (const d of AI_DOMAIN_IDS) {
    if (needed.has(d) || planned.length === 0) continue
    const pool = deps.readers.poolFor(AI_DOMAIN_IDS.filter((x) => x !== d))
    if (!pool) return { error: 'The assistant cannot read the database right now. Try again later.' }
    const plans = await planEach(pool, planned, true)
    if (plans.some((p) => !p.ok && p.code === '42501')) needed.add(d)
  }
  return { domains: canonicalDomains([...needed]) }
}

/**
 * The domains of the data a conversation has read so far, as far as the assistant may have copied it: those of every
 * query it ran or built there — run_sql, and the SQL of a report, a saved table, a diagram, an Excel file or an
 * automation it made, and of the saved reports it named — each planned as save_table plans a query (domainsRead), or
 * read from its text when it can no longer be planned. A table of rows written out in the conversation is read only
 * by those who hold them all: the rows may be any of that data, copied.
 *
 * A query known to have run (run_sql, kept with its result) counts whatever it read, even a domain the person has
 * lost since: they read it then. Any other counts within the person's domains as they are now: one reading beyond
 * them was refused when it ran (the readers hold only the person's domains), and read nothing.
 */
export async function conversationDomains(
  deps: SavedTableDeps,
  conversationId: string,
  person: { id: string; domains: readonly AiDomain[] },
): Promise<{ domains: AiDomain[] } | { error: string }> {
  const { rows: calls } = await deps.db.query<{ id: string | null; name: string | null; input: unknown }>(
    `SELECT b ->> 'id' AS id, b ->> 'name' AS name, b -> 'input' AS input FROM ai_messages m CROSS JOIN LATERAL json_array_elements(m.content) b
      WHERE m.conversation_id = $1 AND m.role = 'assistant' AND json_typeof(m.content) = 'array' AND b ->> 'type' = 'tool_use'`,
    [conversationId],
  )
  const { rows: ran } = await deps.db.query<{ toolUseId: string; ok: boolean }>(`SELECT tool_use_id AS "toolUseId", ok FROM ai_queries WHERE conversation_id = $1`, [conversationId])
  const outcome = new Map(ran.map((r) => [r.toolUseId, r.ok]))
  const read = new Set<string>()
  const maybe = new Set<string>()
  const reportIds = new Set<string>()
  for (const c of calls) {
    const ok = c.id ? outcome.get(c.id) : undefined
    // A near-miss of the name's case is still the query tool (assistant.ts).
    if (c.name?.toLowerCase() === RUN_SQL_TOOL_NAME && ok !== undefined) {
      // Its result is kept: it read what it read, or (failed) nothing.
      const sql = (c.input as { sql?: unknown } | null)?.sql
      if (ok && typeof sql === 'string') read.add(sql)
    } else sqlOf(c.input, maybe, reportIds)
  }
  if (reportIds.size > 0) {
    // A saved report the person may open: its queries reached the conversation when a schedule sending it was tried.
    const { rows } = await deps.db.query<{ sections: { sql?: unknown }[] }>(
      `SELECT sections FROM ai_reports WHERE id = ANY($1::uuid[]) AND (user_id = $2 OR shared)`,
      [[...reportIds], person.id],
    )
    for (const r of rows) for (const section of r.sections) if (typeof section.sql === 'string') maybe.add(section.sql)
  }
  const certain = await domainsReadByAll(deps, read)
  if ('error' in certain) return certain
  const possible = await domainsReadByAll(deps, maybe)
  if ('error' in possible) return possible
  return { domains: canonicalDomains([...certain.domains, ...possible.domains.filter((d) => person.domains.includes(d))]) }
}

// ---- Computing ---------------------------------------------------------------------

interface Computed {
  columns: { name: string; type: string }[]
  rows: AiCell[][]
  domains: AiDomain[]
  dependsOn: string[]
  ms: number
}

/** PostgreSQL's names of these types; a pseudo-type (record, unknown) is kept as text. */
async function typeNames(q: Queryable, oids: readonly number[]): Promise<Map<number, string>> {
  const { rows } = await q.query<{ oid: number; name: string; pseudo: boolean }>(
    `SELECT oid::int AS oid, format_type(oid, NULL) AS name, typtype = 'p' AS pseudo FROM pg_type WHERE oid = ANY($1::oid[])`,
    [oids],
  )
  return new Map(rows.map((r) => [r.oid, r.pseudo ? 'text' : r.name]))
}

/** Problems with a result's column names, as a saved table needs them. */
function columnProblems(columns: readonly string[]): string[] {
  const problems: string[] = []
  if (columns.length === 0) problems.push('The query returns no columns.')
  if (columns.length > SAVED_TABLE_MAX_COLUMNS) problems.push(`A saved table has at most ${SAVED_TABLE_MAX_COLUMNS} columns; the query returns ${columns.length}.`)
  const bad = columns.filter((c) => !SAVED_TABLE_COLUMN_PATTERN.test(c))
  if (bad.length > 0) problems.push(`Name every column in lowercase letters, digits and _ (alias it with AS): ${bad.slice(0, 5).map((c) => JSON.stringify(c)).join(', ')}.`)
  const seen = new Set<string>()
  const twice = new Set(columns.filter((c) => (seen.has(c) ? true : (seen.add(c), false))))
  if (twice.size > 0) problems.push(`Each column needs its own name: ${[...twice].slice(0, 5).join(', ')} appear more than once.`)
  return problems
}

/**
 * A query's table, computed: what it reads, asked of PostgreSQL, then the
 * query run as the role of those domains (or, for a table being made, refused
 * when the person making it may not read them all).
 */
async function computeQuery(deps: SavedTableDeps, sql: string, maker: AiDomain[] | null): Promise<Computed | { error: string }> {
  const checked = precheckSql(sql)
  if ('error' in checked) return { error: checked.error }
  const read = await domainsRead(deps.readers, checked.sql)
  if ('error' in read) return read
  if (maker) {
    const missing = read.domains.filter((d) => !maker.includes(d))
    if (missing.length > 0) return { error: `The query reads data this person may not read (${missing.join(', ')}).` }
  }
  // Reading no domain's views at all, any role reads the same rows: the maker's, or for a computation the first.
  const as = read.domains.length > 0 ? read.domains : (maker ?? [AI_DOMAIN_IDS[0]])
  const pool = deps.readers.poolFor(as)
  const run = await runReadOnlyQuery(pool, checked.sql, {
    maxRows: SAVED_TABLE_MAX_ROWS,
    timeoutMs: SAVED_TABLE_QUERY_TIMEOUT_MS,
    timeZone: deps.timeZone,
    maxRowBytes: COMPUTE_MAX_ROW_BYTES,
    maxChars: COMPUTE_MAX_CHARS,
  })
  if (!run.ok) return { error: run.error ?? 'The query failed.' }
  if (run.truncated) {
    return {
      error: `The query returns more than ${SAVED_TABLE_MAX_ROWS.toLocaleString('en-US')} rows (or more data than a saved table may hold). Aggregate it (GROUP BY), or narrow the period.`,
    }
  }
  const problems = columnProblems(run.columns)
  if (problems.length > 0) return { error: problems.join(' ') }
  const types = await typeNames(deps.db, run.types ?? [])
  return {
    columns: run.columns.map((name, i) => ({ name, type: types.get(run.types?.[i] ?? 25) ?? 'text' })),
    rows: run.rows,
    domains: read.domains,
    dependsOn: savedTablesNamed(checked.sql),
    ms: run.ms,
  }
}

const LITERAL_TYPES: Record<SavedTableColumnType, string> = {
  text: 'text',
  number: 'numeric',
  integer: 'bigint',
  date: 'date',
  timestamp: 'timestamp with time zone',
  boolean: 'boolean',
}

/** One value written out, as its column takes it; a sentence when it does not fit. */
function literalCell(v: unknown, type: SavedTableColumnType): { cell: AiCell } | { error: string } {
  if (v === null || v === undefined || v === '') return { cell: null }
  switch (type) {
    case 'text':
      return typeof v === 'object' ? { cell: JSON.stringify(v) } : { cell: String(v) }
    case 'number': {
      const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim()) : NaN
      return Number.isFinite(n) ? { cell: n } : { error: 'a number' }
    }
    case 'integer': {
      const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim()) : NaN
      return Number.isSafeInteger(n) ? { cell: n } : { error: 'a whole number' }
    }
    case 'boolean':
      return typeof v === 'boolean' ? { cell: v } : v === 'true' || v === 'false' ? { cell: v === 'true' } : { error: 'true or false' }
    case 'date':
      return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? { cell: v } : { error: 'a date as YYYY-MM-DD' }
    case 'timestamp':
      return typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? { cell: v } : { error: 'a date and time, as YYYY-MM-DD HH:MM (factory time) or ISO 8601' }
  }
}

/** Rows written out, checked and as their columns take them; read by those who hold `domains`. */
function computeLiteral(columns: LiteralColumn[], rows: unknown[][], domains: readonly AiDomain[] = []): Computed | { error: string } {
  const problems = columnProblems(columns.map((c) => c.name))
  if (rows.length > SAVED_TABLE_MAX_LITERAL_ROWS) problems.push(`Rows written out are at most ${SAVED_TABLE_MAX_LITERAL_ROWS.toLocaleString('en-US')}; build a longer table from a query.`)
  if (JSON.stringify(rows).length > LITERAL_MAX_CHARS) problems.push('The rows are too long to write out; build the table from a query.')
  if (problems.length > 0) return { error: problems.join(' ') }
  const out: AiCell[][] = []
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (!Array.isArray(row) || row.length !== columns.length) return { error: `Row ${i + 1} has ${Array.isArray(row) ? row.length : 0} values; each row needs ${columns.length}, one per column, in order.` }
    const cells: AiCell[] = []
    for (let j = 0; j < columns.length; j++) {
      const c = literalCell(row[j], columns[j].type)
      if ('error' in c) return { error: `Row ${i + 1}, column ${columns[j].name}: ${JSON.stringify(row[j])} is not ${c.error}.` }
      cells.push(c.cell)
    }
    out.push(cells)
  }
  return { columns: columns.map((c) => ({ name: c.name, type: LITERAL_TYPES[c.type] })), rows: out, domains: canonicalDomains(domains), dependsOn: [], ms: 0 }
}

// ---- Writing -----------------------------------------------------------------------

const qualified = (name: string) => `${SAVED_TABLE_SCHEMA}.${pg.escapeIdentifier(name)}`

/** A value as text for its column to cast: what the reader read, back as PostgreSQL writes it. */
const asText = (v: AiCell): string | null => (v === null ? null : typeof v === 'string' ? v : String(v))

/** The combination roles that hold every one of these domains: those that may read a table built from them. */
async function readersOf(q: Queryable, domains: readonly AiDomain[]): Promise<string[]> {
  const { rows } = await q.query<{ database: string }>(`SELECT current_database() AS database`)
  const index = (d: AiDomain) => AI_DOMAIN_IDS.indexOf(d)
  return AI_DOMAIN_COMBINATIONS.filter((bits) => domains.every((d) => bits[index(d)] === '1')).map((bits) => combinationRole(rows[0].database, bits))
}

/**
 * Put the computed rows in place of the table's, with its grants and its
 * comments: built beside it, then renamed over it, in the caller's
 * transaction.
 */
async function writeTable(tx: Queryable, name: string, title: string, computed: Computed, notes: Record<string, string>): Promise<void> {
  const next = `${name}__next`
  await tx.query(`SET LOCAL lock_timeout = '${WRITE_LOCK_TIMEOUT}'`)
  await tx.query(`DROP TABLE IF EXISTS ${qualified(next)}`)
  const defs = computed.columns.map((c) => `${pg.escapeIdentifier(c.name)} ${c.type}`)
  await tx.query(`CREATE TABLE ${qualified(next)} (${defs.join(', ')})`)
  const casts = computed.columns.map((c, i) => `u.c${i}::${c.type}`).join(', ')
  const arrays = computed.columns.map((_, i) => `$${i + 1}::text[]`).join(', ')
  const names = computed.columns.map((_, i) => `c${i}`).join(', ')
  for (let start = 0; start < computed.rows.length; start += WRITE_BATCH_ROWS) {
    const batch = computed.rows.slice(start, start + WRITE_BATCH_ROWS)
    const params = computed.columns.map((_, i) => batch.map((r) => asText(r[i])))
    await tx.query(`INSERT INTO ${qualified(next)} SELECT ${casts} FROM unnest(${arrays}) AS u(${names})`, params)
  }
  await tx.query(`DROP TABLE IF EXISTS ${qualified(name)}`)
  await tx.query(`ALTER TABLE ${qualified(next)} RENAME TO ${pg.escapeIdentifier(name)}`)
  const roles = await readersOf(tx, computed.domains)
  if (roles.length > 0) await tx.query(`GRANT SELECT ON ${qualified(name)} TO ${roles.map((r) => pg.escapeIdentifier(r)).join(', ')}`)
  await tx.query(`COMMENT ON TABLE ${qualified(name)} IS ${pg.escapeLiteral(title)}`)
  for (const c of computed.columns) {
    const note = notes[c.name]
    if (note) await tx.query(`COMMENT ON COLUMN ${qualified(name)}.${pg.escapeIdentifier(c.name)} IS ${pg.escapeLiteral(note)}`)
  }
}

/** When a table on this schedule is next computed, as SQL ($tz the factory's time zone). */
const nextRefreshSql = (refresh: string, tz: string) =>
  `(CASE ${refresh}
      WHEN 'hourly' THEN date_trunc('hour', now()) + interval '1 hour'
      WHEN 'daily' THEN (SELECT (CASE WHEN x.at > x.local THEN x.at ELSE x.at + interval '1 day' END) AT TIME ZONE ${tz}
                           FROM (SELECT date_trunc('day', now() AT TIME ZONE ${tz}) + interval '${NIGHTLY_HOUR} hours' AS at, now() AT TIME ZONE ${tz} AS local) x)
    END)`

const columnsJson = (c: Computed) => JSON.stringify(c.columns)

async function recordChange(
  tx: Queryable,
  change: { tableId: string; version: number; action: 'create' | 'replace' | 'update' | 'refresh' | 'remove'; definition?: unknown; rowCount?: number; columns?: string },
  by: { id: string; name: string },
  origin: SavedTableOrigin | undefined,
): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO ai_saved_table_changes (table_id, version, action, definition, row_count, columns, by_id, by_name, conversation_id, turn_id, tool_use_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [
      change.tableId,
      change.version,
      change.action,
      change.definition === undefined ? null : JSON.stringify(change.definition),
      change.rowCount ?? null,
      change.columns ?? null,
      by.id,
      by.name,
      origin?.conversationId ?? null,
      origin?.turnId ?? null,
      origin?.toolUseId ?? null,
    ],
  )
  return rows[0].id
}

/** The definition as kept in the history: what the assistant gave, nothing computed. */
function definitionRecord(def: SavedTableDefinition): Record<string, unknown> {
  const base = { name: def.name, title: def.title, summary: def.summary ?? '', description: def.description, source: def.source }
  return def.source === 'query' ? { ...base, sql: def.sql, refresh: def.refresh, notes: def.notes } : { ...base, columns: def.columns, rows: def.rows }
}

/** A table's definition, checked before anything runs. */
function definitionProblems(def: SavedTableDefinition): string[] {
  const problems: string[] = []
  if (!SAVED_TABLE_NAME_PATTERN.test(def.name)) problems.push('name: 2 to 48 lowercase letters, digits and _, starting with a letter (for example routing_steps).')
  if (def.name.endsWith('__next')) problems.push('name: may not end in __next.')
  if (!def.title.trim()) problems.push('title: what the table is, in a few words.')
  if (def.source === 'rows') {
    if (def.columns.length === 0) problems.push('columns: at least one.')
  }
  return problems
}

// ---- Saving, computing again, removing ------------------------------------------------

/**
 * Make a table, or replace one the actor made (or any, for the owner), and
 * compute it now. `replace`: false refuses a name already used; true refuses a
 * name not used yet.
 */
export async function saveTable(
  deps: SavedTableDeps,
  actor: SavedTableActor,
  def: SavedTableDefinition,
  replace = false,
  origin?: SavedTableOrigin,
  /** Replace only the table as it was at this version: a change made since is not overwritten. */
  expectVersion?: number,
): Promise<SavedTableOutcome> {
  const problems = definitionProblems(def)
  if (problems.length > 0) return fail(problems.join(' '))
  const existing = await findLive(deps.db, { name: def.name })
  const checked = checkReplace(existing, actor, replace, def.name)
  if (checked) return fail(checked)
  if (!existing) {
    const { rows } = await deps.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ai_saved_tables WHERE deleted_at IS NULL`)
    if (rows[0].n >= SAVED_TABLE_MAX_LIVE) return fail(`There are already ${SAVED_TABLE_MAX_LIVE} saved tables: remove ones no longer needed first (list_saved_tables).`)
  }

  const computed =
    def.source === 'query'
      ? await withQueryOrigin({ source: 'saved-table', userId: actor.id, purpose: def.name }, () => computeQuery(deps, def.sql, actor.domains))
      : computeLiteral(def.columns, def.rows, def.domains)
  if ('error' in computed) return fail(`Nothing was saved: ${computed.error}`)
  // Rows copied from data the person no longer reads would be a table they could not read: as a query reading it is refused.
  const unread = computed.domains.filter((d) => !actor.domains.includes(d))
  if (def.source === 'rows' && unread.length > 0) return fail(`Nothing was saved: the rows may come from data this person may no longer read (${unread.join(', ')}).`)
  const notes = def.source === 'query' ? noteMap(def.notes, computed) : noteMap(Object.fromEntries(def.columns.map((c) => [c.name, c.note ?? ''])), computed)
  const refresh: SavedTableRefresh = def.source === 'query' ? def.refresh : 'never'

  try {
    return await withTransaction(deps.db, async (tx) => {
      // One save of a name at a time; the table as it is now, under that lock.
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`ai_saved:${def.name}`])
      const now = await findLive(tx, { name: def.name }, true)
      const again = checkReplace(now, actor, replace, def.name)
      if (again) return fail(again)
      if (expectVersion !== undefined && now?.version !== expectVersion) return fail(CHANGED_MEANWHILE)
      await writeTable(tx, def.name, def.title, computed, notes)
      const values = [
        def.title.trim(),
        def.description.trim(),
        def.source,
        def.source === 'query' ? precheckedSql(def.sql) : null,
        def.source === 'rows' ? JSON.stringify({ columns: def.columns, rows: def.rows }) : null,
        JSON.stringify(notes),
        refresh,
        computed.domains,
        computed.dependsOn,
        columnsJson(computed),
        computed.rows.length,
        computed.ms,
        actor.id,
        actor.name,
        deps.timeZone,
        oneLineSummary(def.summary),
      ]
      const schedule = nextRefreshSql('$7::text', '$15::text')
      let id: string
      let version: number
      if (now) {
        const { rows } = await tx.query<{ id: string; version: number }>(
          `UPDATE ai_saved_tables SET title = $1, description = $2, source = $3, sql = $4, literal = $5, column_notes = $6, refresh = $7,
                  domains = $8, depends_on = $9, columns = $10, row_count = $11, refresh_ms = $12, refreshed_at = now(),
                  last_error = NULL, last_error_at = NULL, failures = 0, next_refresh_at = ${schedule},
                  updated_by_id = $13, updated_by_name = $14, version = version + 1, summary = $16
            WHERE id = $17 RETURNING id, version`,
          [...values, now.id],
        )
        ;({ id, version } = rows[0])
      } else {
        const { rows } = await tx.query<{ id: string; version: number }>(
          `INSERT INTO ai_saved_tables (title, description, source, sql, literal, column_notes, refresh, domains, depends_on, columns, row_count,
                                        refresh_ms, refreshed_at, next_refresh_at, created_by_id, created_by_name, updated_by_id, updated_by_name, summary, name)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now(), ${schedule}, $13, $14, $13, $14, $16, $17) RETURNING id, version`,
          [...values, def.name],
        )
        ;({ id, version } = rows[0])
      }
      const action = now ? 'replace' : 'create'
      const changeId = await recordChange(tx, { tableId: id, version, action, definition: definitionRecord(def), rowCount: computed.rows.length, columns: columnsJson(computed) }, actor, origin)
      const ctx = { userId: actor.id, userName: actor.name, entity: 'AiSavedTable', entityId: id }
      if (now) {
        await writeAudit(tx, [auditEvent('update', ctx, new Date().toISOString(), { field: 'definition', oldValue: `version ${version - 1}`, newValue: `${def.name}: version ${version}` })])
      } else {
        await auditCreate(tx, ctx)
      }
      const table = (await findLive(tx, { id }))!
      return { ok: true as const, changeId, table: toTable(table, actor) }
    })
  } catch (e) {
    return writeFailure(e)
  }
}

/** A summary as it is kept: on one line, cut to its length. */
function oneLineSummary(summary: string | undefined): string {
  return (summary ?? '').replace(/\s+/g, ' ').trim().slice(0, SAVED_TABLE_SUMMARY_MAX)
}

/** The query's text as it is kept: trimmed, without its trailing semicolon. */
function precheckedSql(sql: string): string {
  const checked = precheckSql(sql)
  return 'sql' in checked ? checked.sql : sql.trim()
}

/** Notes for the columns the table has, cut to their length. */
function noteMap(notes: Record<string, string>, computed: Computed): Record<string, string> {
  const out: Record<string, string> = {}
  for (const c of computed.columns) {
    const note = notes[c.name]?.replace(/\s+/g, ' ').trim()
    if (note) out[c.name] = note.slice(0, 300)
  }
  return out
}

function checkReplace(existing: TableRow | null, actor: SavedTableActor, replace: boolean, name: string): string | null {
  if (existing && !replace) {
    return `A saved table named ${name} already exists (${existing.title}, made by ${existing.createdByName}). Choose another name, or set replace to true to replace it.`
  }
  if (!existing && replace) return `There is no saved table named ${name} to replace. Leave replace out to make it.`
  if (existing && !(actor.owner || existing.createdById === actor.id)) {
    return `The saved table ${name} was made by ${existing.createdByName}: only they, or the assistant's owner, may replace it. Choose another name.`
  }
  if (existing && !readable(existing, actor.domains)) return `A saved table named ${name} already exists. Choose another name.`
  return null
}

/** A write the database refused: a lock it could not have in time, most often. */
function writeFailure(e: unknown): { ok: false; error: string } {
  const code = (e as { code?: string }).code
  if (code === '55P03') return fail('The table is being read right now and could not be replaced in time. Try again in a minute.')
  if (code === '22P02' || code === '22007' || code === '22008' || code === '22003') return fail(`A value does not fit its column: ${(e as Error).message}`)
  throw e
}

/**
 * Compute a query's table again, now. Taken under a lease, so it never runs
 * twice at once on any instance; written only when its definition is still
 * the one computed. `by`: who asked (null: the schedule).
 */
export async function refreshTable(
  deps: SavedTableDeps,
  tableId: string,
  by: { id: string; name: string } | null,
  origin?: SavedTableOrigin,
): Promise<SavedTableOutcome> {
  const { rows } = await deps.db.query<TableRow>(
    `UPDATE ai_saved_tables t SET refreshing_until = now() + make_interval(mins => $2)
      WHERE t.id = $1 AND t.deleted_at IS NULL AND t.source = 'query' AND (t.refreshing_until IS NULL OR t.refreshing_until < now())
      RETURNING ${TABLE_SELECT}`,
    [tableId, LEASE_MINUTES],
  )
  const row = rows[0]
  if (!row) {
    const live = await findLive(deps.db, { id: tableId })
    if (!live) return fail('There is no such saved table.')
    if (live.source !== 'query') return fail('Rows written out are not computed: change them with update_saved_table.')
    return fail('The table is being computed right now. Wait a minute and look again.')
  }
  const started = Date.now()
  let computed: Computed | { error: string }
  try {
    computed = await withQueryOrigin({ source: 'saved-table', purpose: row.name }, () => computeQuery(deps, row.sql!, null))
  } catch (e) {
    computed = { error: e instanceof Error ? e.message : String(e) }
  }
  try {
    return await withTransaction(deps.db, async (tx) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`ai_saved:${row.name}`])
      const now = await findLive(tx, { id: row.id }, true)
      // Replaced or removed while it was computed: the newer definition stands.
      if (!now || now.version !== row.version) {
        await tx.query(`UPDATE ai_saved_tables SET refreshing_until = NULL WHERE id = $1`, [row.id])
        return fail('The table was changed while it was being computed; its new definition stands.')
      }
      if ('error' in computed) {
        await tx.query(
          `UPDATE ai_saved_tables SET last_error = $2, last_error_at = now(), failures = failures + 1, refreshing_until = NULL,
                  next_refresh_at = CASE WHEN refresh = 'never' THEN NULL ELSE LEAST(${nextRefreshSql('refresh', '$3')}, now() + make_interval(mins => $4)) END
            WHERE id = $1`,
          [row.id, computed.error.slice(0, 1000), deps.timeZone, RETRY_MINUTES],
        )
        return fail(`It could not be computed, so it keeps its rows of ${row.refreshedAt ? new Date(row.refreshedAt).toISOString() : 'before'}: ${computed.error}`)
      }
      // Its title and notes as they are now: an update may have changed them while it was computed.
      await writeTable(tx, now.name, now.title, computed, now.columnNotes)
      await tx.query(
        `UPDATE ai_saved_tables SET domains = $2, depends_on = $3, columns = $4, row_count = $5, refresh_ms = $6, refreshed_at = now(),
                last_error = NULL, last_error_at = NULL, failures = 0, refreshing_until = NULL,
                next_refresh_at = ${nextRefreshSql('refresh', '$7')}
          WHERE id = $1`,
        [row.id, computed.domains, computed.dependsOn, columnsJson(computed), computed.rows.length, Date.now() - started, deps.timeZone],
      )
      // A computation someone asked for is in the history; the schedule's are only in the table.
      const changeId = by ? await recordChange(tx, { tableId: row.id, version: row.version, action: 'refresh', rowCount: computed.rows.length, columns: columnsJson(computed) }, by, origin) : ''
      const table = (await findLive(tx, { id: row.id }))!
      return { ok: true as const, changeId, table: toTable(table, null) }
    })
  } catch (e) {
    await deps.db.query(`UPDATE ai_saved_tables SET refreshing_until = NULL WHERE id = $1`, [row.id]).catch(() => undefined)
    return writeFailure(e)
  }
}

const CHANGED_MEANWHILE = 'The table was changed by someone else meanwhile: look at it again (list_saved_tables) before you change it.'

/** What a change to a table in place gives: what is given changes, the rest stays. */
export interface SavedTableChanges {
  title?: string
  summary?: string
  description?: string
  /** Notes by column, merged into the table's: an empty one removes that column's note. */
  columnNotes?: Record<string, string>
  /** For a query's table: how often it is computed again. */
  refresh?: SavedTableRefresh
  /** For a query's table: a new query, computed at once. */
  sql?: string
  /** For rows written out: the columns, when they change (rows must come with them). */
  columns?: LiteralColumn[]
  /** For rows written out: every row, in place of the table's. */
  rows?: unknown[][]
  /** For rows written out: rows added after the table's. */
  addRows?: unknown[][]
  /** For rows written out: the domains of the data new rows may have been copied from (conversationDomains), added to the table's own. */
  readFrom?: AiDomain[]
}

/** Whether the changes touch what the table holds, and so compute it again. */
export const changesData = (c: SavedTableChanges) => c.sql !== undefined || c.columns !== undefined || c.rows !== undefined || c.addRows !== undefined

/** Who made a live table, found by its id or its name; null when there is none. */
export async function tableMaker(q: Queryable, by: { id?: string; name?: string }): Promise<string | null> {
  return (await findLive(q, by))?.createdById ?? null
}

/** What is wrong with changes to a table of this source, before anything is read or run. */
export function changeProblems(source: SavedTableSource, c: SavedTableChanges): string[] {
  const problems: string[] = []
  const given = Object.values(c).some((v) => v !== undefined)
  if (!given) problems.push('Say what to change: title, summary, description, columnNotes, refresh, sql, or (for rows written out) columns, rows or addRows.')
  if (c.title !== undefined && !c.title.trim()) problems.push('title: what the table is, in a few words.')
  if (source === 'query') {
    if (c.columns !== undefined || c.rows !== undefined || c.addRows !== undefined) problems.push('columns, rows and addRows are for rows written out; this table is computed from a query: change its sql.')
    if (c.sql !== undefined && !c.sql.trim()) problems.push('sql: the SELECT the table is computed from.')
  } else {
    if (c.sql !== undefined) problems.push('sql is for a table computed from a query; this one holds rows written out: change its rows.')
    if (c.refresh !== undefined && c.refresh !== 'never') problems.push('refresh: rows written out are kept as written; only a query\'s table is computed again.')
    if (c.columns !== undefined && c.rows === undefined) problems.push('columns: give the rows with them (rows), in the order of the new columns.')
    if (c.rows !== undefined && c.addRows !== undefined) problems.push('rows and addRows: give one; rows replaces them all, addRows adds after them.')
    if (c.columns !== undefined && c.columns.length === 0) problems.push('columns: at least one.')
  }
  return problems
}

/**
 * Change a table in place: whoever made it, or the owner. Its title, summary,
 * description, notes or schedule change at once, its rows and version stay
 * (an "update" in the history). A new query, new rows or rows added make it
 * a replace, computed now — under the same name, so whatever reads it reads
 * the new rows — and only of the table as it was read here.
 */
export async function updateTable(
  deps: SavedTableDeps,
  actor: SavedTableActor,
  tableId: string,
  changes: SavedTableChanges,
  origin?: SavedTableOrigin,
): Promise<SavedTableOutcome & { dataChanged?: boolean }> {
  const row = await findLive(deps.db, { id: tableId })
  if (!row || !readable(row, actor.domains)) return fail('There is no such saved table.')
  if (!(actor.owner || row.createdById === actor.id)) return fail(`The saved table ${row.name} was made by ${row.createdByName}: only they, or the assistant's owner, may change it.`)
  const problems = changeProblems(row.source, changes)
  if (problems.length > 0) return fail(problems.join(' '))

  const notes = { ...row.columnNotes }
  for (const [column, note] of Object.entries(changes.columnNotes ?? {})) {
    const clean = note.replace(/\s+/g, ' ').trim()
    if (clean) notes[column] = clean.slice(0, 300)
    else delete notes[column]
  }

  if (changesData(changes)) {
    const base = { name: row.name, title: changes.title ?? row.title, summary: changes.summary ?? row.summary, description: changes.description ?? row.description }
    let def: SavedTableDefinition
    if (row.source === 'query') {
      def = { ...base, source: 'query', sql: changes.sql ?? row.sql!, refresh: changes.refresh ?? row.refresh, notes }
    } else {
      const literal = row.literal!
      // New columns bring their own notes, a note given apart overriding one; the table's columns keep theirs, merged.
      const columns = changes.columns
        ? changes.columns.map((c) => ({ ...c, note: changes.columnNotes?.[c.name] !== undefined ? notes[c.name] : c.note }))
        : literal.columns.map((c) => ({ ...c, note: notes[c.name] }))
      const rows = changes.rows ?? [...literal.rows, ...(changes.addRows ?? [])]
      // Never wider than before: what its rows were copied from stays, and what the new ones may be is added.
      def = { ...base, source: 'rows', columns, rows, domains: canonicalDomains([...storedDomains(row.domains), ...(changes.readFrom ?? [])]) }
    }
    const outcome = await saveTable(deps, actor, def, true, origin, row.version)
    return outcome.ok ? { ...outcome, dataChanged: true } : outcome
  }

  try {
    return await withTransaction(deps.db, async (tx) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`ai_saved:${row.name}`])
      const now = await findLive(tx, { id: row.id }, true)
      if (!now) return fail('There is no such saved table.')
      if (now.version !== row.version) return fail(CHANGED_MEANWHILE)
      const refresh = changes.refresh ?? now.refresh
      const kept = Object.fromEntries(Object.entries(notes).filter(([c]) => now.columns.some((x) => x.name === c)))
      await tx.query(
        `UPDATE ai_saved_tables
            SET title = $2, summary = $3, description = $4, column_notes = $5, refresh = $6,
                next_refresh_at = CASE WHEN $6 = refresh THEN next_refresh_at ELSE ${nextRefreshSql('$6::text', '$7::text')} END,
                updated_by_id = $8, updated_by_name = $9
          WHERE id = $1`,
        [
          now.id,
          (changes.title ?? now.title).trim(),
          changes.summary === undefined ? now.summary : oneLineSummary(changes.summary),
          (changes.description ?? now.description).trim(),
          JSON.stringify(kept),
          refresh,
          deps.timeZone,
          actor.id,
          actor.name,
        ],
      )
      // What questions and automations see of it in the database: its title and its columns' notes.
      await tx.query(`SET LOCAL lock_timeout = '${WRITE_LOCK_TIMEOUT}'`)
      await tx.query(`COMMENT ON TABLE ${qualified(now.name)} IS ${pg.escapeLiteral((changes.title ?? now.title).trim())}`)
      for (const c of now.columns) {
        if ((kept[c.name] ?? '') !== (now.columnNotes[c.name] ?? '')) {
          await tx.query(`COMMENT ON COLUMN ${qualified(now.name)}.${pg.escapeIdentifier(c.name)} IS ${kept[c.name] ? pg.escapeLiteral(kept[c.name]) : 'NULL'}`)
        }
      }
      const definition = Object.fromEntries(Object.entries({ ...changes, columnNotes: changes.columnNotes }).filter(([, v]) => v !== undefined))
      const changeId = await recordChange(tx, { tableId: now.id, version: now.version, action: 'update', definition, rowCount: now.rowCount ?? undefined, columns: JSON.stringify(now.columns) }, actor, origin)
      await writeAudit(tx, [
        auditEvent('update', { userId: actor.id, userName: actor.name, entity: 'AiSavedTable', entityId: now.id }, new Date().toISOString(), {
          field: 'definition',
          oldValue: `version ${now.version}`,
          newValue: `${now.name}: ${Object.keys(definition).join(', ')}`,
        }),
      ])
      const table = (await findLive(tx, { id: now.id }))!
      return { ok: true as const, changeId, table: toTable(table, actor), dataChanged: false }
    })
  } catch (e) {
    return writeFailure(e)
  }
}

/** Remove a table: whoever made it, or the owner; never while another live table is built on it. */
export async function removeTable(deps: SavedTableDeps, actor: SavedTableActor, tableId: string, origin?: SavedTableOrigin): Promise<SavedTableOutcome> {
  try {
    return await withTransaction(deps.db, async (tx) => {
      const row = await findLive(tx, { id: tableId }, true)
      if (!row || !readable(row, actor.domains)) return fail('There is no such saved table.')
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`ai_saved:${row.name}`])
      if (!(actor.owner || row.createdById === actor.id)) return fail(`The saved table ${row.name} was made by ${row.createdByName}: only they, or the assistant's owner, may remove it.`)
      const { rows: built } = await tx.query<{ name: string }>(
        `SELECT name FROM ai_saved_tables WHERE deleted_at IS NULL AND id <> $1 AND $2 = ANY(depends_on) ORDER BY name`,
        [row.id, row.name],
      )
      if (built.length > 0) return fail(`Other saved tables are built on ${row.name}: ${built.map((b) => b.name).join(', ')}. Remove or replace them first.`)
      await tx.query(`SET LOCAL lock_timeout = '${WRITE_LOCK_TIMEOUT}'`)
      await tx.query(`DROP TABLE IF EXISTS ${qualified(row.name)}`)
      await tx.query(`UPDATE ai_saved_tables SET deleted_at = now(), next_refresh_at = NULL, refreshing_until = NULL, updated_by_id = $2, updated_by_name = $3 WHERE id = $1`, [
        row.id,
        actor.id,
        actor.name,
      ])
      const changeId = await recordChange(tx, { tableId: row.id, version: row.version, action: 'remove' }, actor, origin)
      await auditDelete(tx, { userId: actor.id, userName: actor.name, entity: 'AiSavedTable', entityId: row.id })
      const { rows } = await tx.query<TableRow>(`SELECT ${TABLE_SELECT} FROM ai_saved_tables t WHERE t.id = $1`, [row.id])
      return { ok: true as const, changeId, table: toTable(rows[0], actor) }
    })
  } catch (e) {
    return writeFailure(e)
  }
}

/** The first rows of a table, read as the viewer's own domains. */
export async function previewTable(deps: SavedTableDeps, viewer: SavedTableActor, tableId: string): Promise<SavedTableRowsResponse | null> {
  const row = await findLive(deps.db, { id: tableId })
  if (!row || !readable(row, viewer.domains)) return null
  const run = await withQueryOrigin({ source: 'saved-table', userId: viewer.id, purpose: row.name }, () =>
    runReadOnlyQuery(deps.readers.poolFor(viewer.domains), `SELECT * FROM ${qualified(row.name)}`, {
      maxRows: SAVED_TABLE_PREVIEW_ROWS,
      timeoutMs: 10_000,
      timeZone: deps.timeZone,
    }),
  )
  if (!run.ok) throw new Error(run.error ?? 'The table could not be read.')
  return { columns: run.columns, rows: run.rows, truncated: run.truncated, rowCount: row.rowCount }
}

// ---- The schedule ---------------------------------------------------------------------

/**
 * The tables due, in an order that computes a table after the due tables it
 * is built on (a loop, should one ever form, in any order).
 */
export function refreshOrder<T extends { name: string; dependsOn: string[] }>(due: T[]): T[] {
  const byName = new Map(due.map((t) => [t.name, t]))
  const out: T[] = []
  const seen = new Set<string>()
  const visit = (t: T, path: Set<string>) => {
    if (seen.has(t.name) || path.has(t.name)) return
    path.add(t.name)
    for (const d of t.dependsOn) {
      const dep = byName.get(d)
      if (dep && dep !== t) visit(dep, path)
    }
    path.delete(t.name)
    seen.add(t.name)
    out.push(t)
  }
  for (const t of due) visit(t, new Set())
  return out
}

/** Every table due now, computed one after another. Returns how many were computed (or tried). */
export async function refreshDue(deps: SavedTableDeps, limit = 20): Promise<number> {
  if (!deps.readers.ready) return 0
  const { rows } = await deps.db.query<{ id: string; name: string; dependsOn: string[] }>(
    `SELECT id, name, depends_on AS "dependsOn" FROM ai_saved_tables
      WHERE deleted_at IS NULL AND next_refresh_at <= now() AND (refreshing_until IS NULL OR refreshing_until < now())
      ORDER BY next_refresh_at LIMIT $1`,
    [limit],
  )
  for (const t of refreshOrder(rows)) {
    try {
      await refreshTable(deps, t.id, null)
    } catch (e) {
      console.warn(`[ai] saved table ${t.name} could not be computed:`, e instanceof Error ? e.message : String(e))
    }
  }
  return rows.length
}

/** Computes the saved tables when they are due, on every instance (a lease keeps each computation to one). */
export class SavedTableRefresher {
  private timer: NodeJS.Timeout | null = null
  private running: Promise<unknown> | null = null

  constructor(
    private readonly deps: SavedTableDeps,
    private readonly everyMs = 60_000,
  ) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), this.everyMs)
    this.timer.unref()
  }

  private tick(): void {
    if (this.running) return
    this.running = refreshDue(this.deps)
      .catch((e) => console.warn('[ai] saved tables could not be computed:', e instanceof Error ? e.message : String(e)))
      .finally(() => {
        this.running = null
      })
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.running
  }
}
