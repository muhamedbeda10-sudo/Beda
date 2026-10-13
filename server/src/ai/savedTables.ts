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
//     those domains — rows written out, to every role;
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
import { AI_DOMAIN_COMBINATIONS, combinationRole, storedDomains } from './domains'
import { codeOnly, precheckSql, runReadOnlyQuery } from './runQuery'

/** A computation's query may take this long: the most the runner allows. */
export const SAVED_TABLE_QUERY_TIMEOUT_MS = 30_000
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
  | { source: 'rows'; columns: LiteralColumn[]; rows: unknown[][] }
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
  const whole = await plans(all, sql)
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

/** Rows written out, checked and as their columns take them. */
function computeLiteral(columns: LiteralColumn[], rows: unknown[][]): Computed | { error: string } {
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
  return { columns: columns.map((c) => ({ name: c.name, type: LITERAL_TYPES[c.type] })), rows: out, domains: [], dependsOn: [], ms: 0 }
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
  change: { tableId: string; version: number; action: 'create' | 'replace' | 'refresh' | 'remove'; definition?: unknown; rowCount?: number; columns?: string },
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

  const computed = def.source === 'query' ? await computeQuery(deps, def.sql, actor.domains) : computeLiteral(def.columns, def.rows)
  if ('error' in computed) return fail(`Nothing was saved: ${computed.error}`)
  const notes = def.source === 'query' ? noteMap(def.notes, computed) : noteMap(Object.fromEntries(def.columns.map((c) => [c.name, c.note ?? ''])), computed)
  const refresh: SavedTableRefresh = def.source === 'query' ? def.refresh : 'never'

  try {
    return await withTransaction(deps.db, async (tx) => {
      // One save of a name at a time; the table as it is now, under that lock.
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`ai_saved:${def.name}`])
      const now = await findLive(tx, { name: def.name }, true)
      const again = checkReplace(now, actor, replace, def.name)
      if (again) return fail(again)
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
    if (live.source !== 'query') return fail('Rows written out are not computed: replace the table to change them.')
    return fail('The table is being computed right now. Wait a minute and look again.')
  }
  const started = Date.now()
  let computed: Computed | { error: string }
  try {
    computed = await computeQuery(deps, row.sql!, null)
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
      await writeTable(tx, row.name, row.title, computed, row.columnNotes)
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
  const run = await runReadOnlyQuery(deps.readers.poolFor(viewer.domains), `SELECT * FROM ${qualified(row.name)}`, {
    maxRows: SAVED_TABLE_PREVIEW_ROWS,
    timeoutMs: 10_000,
    timeZone: deps.timeZone,
  })
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
