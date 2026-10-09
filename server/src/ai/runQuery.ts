// ============================================================================
// §20 — running one query the assistant wrote. The database is what keeps it
// harmless: the reader role may read the ai views and nothing else, every
// query runs in a read-only transaction that is always rolled back, and the
// connection is thrown away afterwards. The checks on the text before that
// are only there to answer the model with a clear sentence.
//
//   1. one SELECT (or WITH … SELECT); a trailing semicolon is dropped
//   2. BEGIN REPEATABLE READ, READ ONLY; the factory's time zone; a timeout;
//      `SELECT 1` takes the snapshot, after which the transaction can no
//      longer be made read-write
//   3. DECLARE a cursor over the text through the extended protocol, which
//      refuses a second statement, anything that is not a query and a CTE
//      that writes; FETCH at most the rows wanted plus one
//   4. ROLLBACK, always; then destroy the connection, so nothing the query
//      did to its session (an advisory lock, say) outlives it
// ============================================================================

import pg from 'pg'
import type { AiCell } from '@qc/shared/ai'

/** The longest query text accepted. */
export const AI_MAX_SQL_CHARS = 20_000
/** A cell the model reads is cut here. */
const MODEL_CELL_CHARS = 1_000
/** What the model is handed for one query, at most. */
const MODEL_RESULT_CHARS = 60_000
/** A cell going to Excel is cut below the 32 767 characters a cell can hold. */
const EXPORT_CELL_CHARS = 32_000

export interface RunOptions {
  maxRows: number
  timeoutMs: number
  timeZone: string
}

/** What one run returned: the rows as read, before anything is cut for the model. */
export interface QueryRun {
  ok: boolean
  columns: string[]
  rows: AiCell[][]
  /** More rows matched than `maxRows`. */
  truncated: boolean
  ms: number
  error?: string
}

// ---- The text --------------------------------------------------------------------

/**
 * The query with its string literals, quoted names and comments blanked out,
 * so the checks below read only the code. Only for those checks: PostgreSQL
 * parses the real text.
 */
export function codeOnly(sql: string): string {
  let out = ''
  let i = 0
  const n = sql.length
  while (i < n) {
    const c = sql[i]
    const next = sql[i + 1]
    if (c === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') i++
      out += ' '
    } else if (c === '/' && next === '*') {
      // Block comments nest in PostgreSQL.
      let depth = 1
      i += 2
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++
          i += 2
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--
          i += 2
        } else i++
      }
      out += ' '
    } else if (c === "'" || ((c === 'E' || c === 'e') && next === "'")) {
      const escapes = c !== "'"
      i += escapes ? 2 : 1
      while (i < n) {
        if (escapes && sql[i] === '\\') i += 2
        else if (sql[i] === "'" && sql[i + 1] === "'") i += 2
        else if (sql[i] === "'") {
          i++
          break
        } else i++
      }
      out += "''"
    } else if (c === '"') {
      i++
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') i += 2
        else if (sql[i] === '"') {
          i++
          break
        } else i++
      }
      out += '""'
    } else if (c === '$') {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length)
        i = end < 0 ? n : end + tag[0].length
        out += "''"
      } else {
        out += c
        i++
      }
    } else {
      out += c
      i++
    }
  }
  return out
}

/** Functions and words the assistant never needs. The database stops them anyway; this says so plainly. */
const DENIED: { pattern: RegExp; what: string }[] = [
  { pattern: /\bpg_(try_)?advisory\w*/i, what: 'Advisory locks' },
  { pattern: /\bpg_sleep\w*/i, what: 'pg_sleep' },
  { pattern: /\bset_config\b/i, what: 'set_config' },
  { pattern: /\bpg_terminate_backend\b/i, what: 'pg_terminate_backend' },
  { pattern: /\bpg_cancel_backend\b/i, what: 'pg_cancel_backend' },
  { pattern: /\blo_\w+\s*\(/i, what: 'Large-object functions' },
  { pattern: /\bdblink\w*/i, what: 'dblink' },
  { pattern: /\bpg_read_\w+/i, what: 'Reading server files' },
  { pattern: /\b(query|cursor)_to_xml\w*/i, what: 'Running SQL from text' },
  { pattern: /\bpg_notify\b/i, what: 'pg_notify' },
  { pattern: /\bcopy\b/i, what: 'COPY' },
]

/**
 * The query as it will run, or why it will not. Trims, drops one trailing
 * semicolon, and asks for a single SELECT or WITH.
 */
export function precheckSql(raw: string): { sql: string } | { error: string } {
  let sql = raw.trim()
  if (sql.endsWith(';')) sql = sql.slice(0, -1).trimEnd()
  if (!sql) return { error: 'The query is empty. Send one SELECT (or WITH … SELECT) over the views in schema ai.' }
  if (sql.length > AI_MAX_SQL_CHARS) return { error: `The query is longer than ${AI_MAX_SQL_CHARS} characters. Shorten it.` }
  const code = codeOnly(sql)
  if (!/^(select|with)\b/i.test(code.trimStart())) {
    return { error: 'Only a single SELECT (or WITH … SELECT) is allowed: the assistant can only read the views in schema ai.' }
  }
  // A semicolon left before a closing comment is harmless; any other is a second statement.
  if (code.trimEnd().replace(/;$/, '').includes(';')) {
    return { error: 'Only a single statement is allowed: remove the semicolons and send one SELECT.' }
  }
  for (const d of DENIED) {
    if (d.pattern.test(code)) return { error: `${d.what} cannot be used in the assistant's queries. Send a plain SELECT over the views in schema ai.` }
  }
  return { sql }
}

// ---- Running ---------------------------------------------------------------------

const CURSOR_PREFIX = 'DECLARE ai_cur NO SCROLL CURSOR FOR '

/** The PostgreSQL error as a sentence the model can act on. */
function describeError(err: unknown, opts: RunOptions): string {
  // Anything but PostgreSQL's own answer (a dropped connection, a client timeout) says nothing useful.
  if (!(err instanceof pg.DatabaseError)) return 'The database could not run the query just now. Try again.'
  if (err.code === '57014') {
    const seconds = opts.timeoutMs >= 1000 ? Math.round(opts.timeoutMs / 1000) : Math.round(opts.timeoutMs / 100) / 10
    return `The query took too long (${seconds} s). Narrow it or aggregate.`
  }
  let text = err.message || 'The query failed.'
  // Positions count from the cursor's DECLARE; give them back in the query's own terms.
  const position = Number(err.position)
  if (Number.isFinite(position) && position > CURSOR_PREFIX.length) text += ` (at character ${position - CURSOR_PREFIX.length})`
  if (err.hint) text += ` Hint: ${err.hint}`
  if (err.code === '42501' || err.code === '42P01' || err.code === '3F000') {
    text += ' Only the views and functions in schema ai can be read.'
  } else if (err.code === '25006') {
    text += ' The assistant can only read.'
  }
  return text
}

function toCell(v: unknown): AiCell {
  if (v === null || v === undefined) return null
  if (typeof v === 'string' || typeof v === 'boolean') return v
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v)
  // json / jsonb arrive parsed: an object or array goes back to its compact text.
  return JSON.stringify(v)
}

/**
 * Run one query as the reader. Never throws: a refusal, an error or a
 * timeout comes back as `ok: false` with a sentence for the model.
 */
export async function runReadOnlyQuery(pool: pg.Pool | null, rawSql: string, opts: RunOptions): Promise<QueryRun> {
  const started = Date.now()
  const fail = (error: string): QueryRun => ({ ok: false, columns: [], rows: [], truncated: false, ms: Date.now() - started, error })
  const checked = precheckSql(rawSql)
  if ('error' in checked) return fail(checked.error)
  if (!pool) return fail("The assistant's database access is not available right now.")

  let client: pg.PoolClient
  try {
    client = await pool.connect()
  } catch (e) {
    // Not the query's fault, and nothing the model can fix: the reason is for the log.
    console.warn('[ai] the reader could not connect:', e instanceof Error ? e.message : String(e))
    return fail('The database could not run the query just now. Try again.')
  }
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
    await client.query(`SET LOCAL TIME ZONE ${pg.escapeLiteral(opts.timeZone)}`)
    await client.query(`SET LOCAL statement_timeout = ${pg.escapeLiteral(`${Math.max(1, Math.round(opts.timeoutMs))}ms`)}`)
    await client.query('SELECT 1')
    // @types/pg does not know queryMode; pg does (lib/query.js).
    const declare: pg.QueryConfig & { queryMode: 'extended' } = { text: CURSOR_PREFIX + checked.sql, queryMode: 'extended' }
    await client.query(declare)
    const fetch: pg.QueryArrayConfig & { queryMode: 'extended' } = { text: `FETCH ${opts.maxRows + 1} FROM ai_cur`, rowMode: 'array', queryMode: 'extended' }
    const result = await client.query(fetch)
    const rows = (result.rows as unknown[][]).map((r) => r.map(toCell))
    const truncated = rows.length > opts.maxRows
    return {
      ok: true,
      // By position: two columns may share a name.
      columns: result.fields.map((f) => f.name),
      rows: truncated ? rows.slice(0, opts.maxRows) : rows,
      truncated,
      ms: Date.now() - started,
    }
  } catch (e) {
    return fail(describeError(e, opts))
  } finally {
    try {
      await client.query('ROLLBACK')
    } catch {
      /* the connection is gone; it is destroyed below either way */
    }
    client.release(true)
  }
}

// ---- What the model and the card see ------------------------------------------------

export interface QueryPreview {
  columns: string[]
  rows: AiCell[][]
  /** Rows kept. */
  rowCount: number
  truncated: boolean
}

function cut(cell: AiCell, max: number): AiCell {
  return typeof cell === 'string' && cell.length > max ? `${cell.slice(0, max)}…` : cell
}

/** The tool result's text: fixed key order, so the same rows always read the same. */
export function previewJson(p: QueryPreview): string {
  return JSON.stringify({ columns: p.columns, rows: p.rows, rowCount: p.rowCount, truncated: p.truncated })
}

/**
 * The rows the model reads, which the answer's card shows too: every long
 * cell cut, and rows dropped from the end until the whole fits.
 */
export function previewOf(run: QueryRun): QueryPreview {
  const rows = run.rows.map((r) => r.map((c) => cut(c, MODEL_CELL_CHARS)))
  // The text with no rows (rowCount 0, `false`: the longer word), then each
  // row's JSON and a comma between rows, and rowCount's own digits.
  const bare = previewJson({ columns: run.columns, rows: [], rowCount: 0, truncated: false }).length - 1
  let rowsChars = 0
  let keep = 0
  for (const r of rows) {
    const next = rowsChars + JSON.stringify(r).length + (keep > 0 ? 1 : 0)
    if (bare + next + String(keep + 1).length > MODEL_RESULT_CHARS) break
    rowsChars = next
    keep++
  }
  const truncated = run.truncated || keep < rows.length
  rows.length = keep
  return { columns: run.columns, rows, rowCount: keep, truncated }
}

/** Rows for Excel: every row read, each cell within what a spreadsheet cell holds. */
export function exportRows(run: QueryRun): AiCell[][] {
  return run.rows.map((r) => r.map((c) => cut(c, EXPORT_CELL_CHARS)))
}
