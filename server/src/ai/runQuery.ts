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
//   3. PREPARE the text through the extended protocol, which refuses a second
//      statement and anything that is not a query. PostgreSQL's own parser
//      answers a mistake in the query's own terms, and a query that parses on
//      its own cannot reach outside the wrapper of step 4
//   4. DECLARE a cursor over the text, wrapped so that PostgreSQL refuses a
//      row longer than the run allows before sending it (ai.assert_row_size;
//      a CTE that writes is refused here too); FETCH in batches until the rows
//      wanted plus one, or the run's share of memory, have been read
//   5. ROLLBACK, always; then destroy the connection, so nothing the query
//      did to its session (an advisory lock, say) outlives it
//
// All the while, every message PostgreSQL sends is measured as it arrives. A
// stop, the time limit or an oversized message cancels the statement inside
// PostgreSQL and drops the connection at once. One huge value must never
// reach pg whole: pg turns a message into one string, and a string past V8's
// limit throws inside the socket's data handler, where nothing can catch it,
// and the API would go down for everyone.
// ============================================================================

import net from 'node:net'
import type { Duplex } from 'node:stream'
import pg from 'pg'
import type { AiCell } from '@qc/shared/ai'

/** The longest query text accepted. */
export const AI_MAX_SQL_CHARS = 20_000
/** A cell the model reads is cut here. */
const MODEL_CELL_CHARS = 1_000
/** Rows a report's section shows when it runs, at most, and their characters: no model reads them, a page draws them. */
export const AI_REPORT_RUN_ROWS = 2_000
export const AI_REPORT_RUN_CHARS = 2_000_000
/** What the model is handed for one query, at most. */
const MODEL_RESULT_CHARS = 60_000
/** A cell going to Excel is cut below the 32 767 characters a cell can hold. */
const EXPORT_CELL_CHARS = 32_000

/** How much of a result one run may hold. */
export interface ResultLimits {
  /** The longest row, in bytes. A longer row fails the query inside the database, or at the latest as it starts to arrive. */
  maxRowBytes: number
  /** Reading stops, and the result is truncated, before the rows kept hold more characters than this. */
  maxChars: number
}

/** A question in the chat. The model reads 60 000 characters at most, so this is ample. */
export const AI_CHAT_LIMITS: ResultLimits = { maxRowBytes: 256 * 1024, maxChars: 5_000_000 }
/** An Excel export: up to AI_EXPORT_MAX_ROWS rows, each cell up to 32 000 characters. */
export const AI_EXPORT_LIMITS: ResultLimits = { maxRowBytes: 1024 * 1024, maxChars: 50_000_000 }

/** What a run stopped through its signal says. */
export const AI_QUERY_STOPPED = 'Stopped.'

export interface RunOptions {
  maxRows: number
  timeoutMs: number
  timeZone: string
  /** AI_CHAT_LIMITS.maxRowBytes unless given. */
  maxRowBytes?: number
  /** AI_CHAT_LIMITS.maxChars unless given. */
  maxChars?: number
  /** Aborting it stops the query at once, inside PostgreSQL too; the run then fails with AI_QUERY_STOPPED. */
  signal?: AbortSignal
}

/**
 * Why a run failed, for words other than the model's (an automation's run
 * history, a delivered report): the text was refused before it ran, there was
 * no reader to run it, the caller stopped it, it took too long, a row or the
 * database's reply was too large, or PostgreSQL itself refused or failed it.
 */
export type QueryFailure = 'rejected' | 'unavailable' | 'stopped' | 'timeout' | 'row-too-large' | 'reply-too-large' | 'database'

/** What one run returned: the rows as read, before anything is cut for the model. */
export interface QueryRun {
  ok: boolean
  columns: string[]
  /** Each column's PostgreSQL type (its OID), by position: known once the query ran. */
  types?: number[]
  rows: AiCell[][]
  /** Not every matching row was kept: more than `maxRows` matched, or the rows kept reached `maxChars`. */
  truncated: boolean
  ms: number
  /** Why it failed, as a sentence the model can act on. */
  error?: string
  /** Why it failed, by kind (with `error`). */
  failure?: QueryFailure
  /** PostgreSQL's SQLSTATE when the database refused the query (42501: a view the role may not read). */
  code?: string
  /** PostgreSQL's own message when it refused or failed the query (failure 'database'), as it said it: no position, hint or advice. */
  dbMessage?: string
}

// ---- The text --------------------------------------------------------------------

/** A character that continues a name (PostgreSQL's ident_cont; any non-ASCII character counts as a letter). */
const NAME_CHAR = /[A-Za-z0-9_$\u0080-\uFFFF]/
/** A quoted name that means the same unquoted: codeOnly shows it as it is. */
const PLAIN_NAME = /^[A-Za-z_][A-Za-z0-9_$]*$/
/**
 * A dollar quote's opening tag, as PostgreSQL reads one, of any length.
 * Sticky: matched where the scan stands, without copying the rest of the text.
 */
const DOLLAR_TAG = /\$(?:[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\u0080-\uFFFF]*)?\$/y

/**
 * The query with its string literals, comments and quoted names blanked out,
 * so the checks below read only the code. A quoted name that is a plain word
 * stays visible: "pg_sleep"(1) calls pg_sleep. Only for those checks:
 * PostgreSQL parses the real text, and where this reading and PostgreSQL's
 * could differ, this one shows more of the text as code, never less.
 */
export function codeOnly(sql: string): string {
  let out = ''
  // The first character of the run of name characters `out` ends in, or null.
  // Kept as the scan goes: looking back for it at every $ took seconds on a
  // long query, with the whole API waiting.
  let runHead: string | null = null
  const blank = (s: string) => {
    out += s
    runHead = null
  }
  // Inside a name PostgreSQL reads E' and $ as more of it (`name'x\'`, `a$b$`);
  // a run that starts with a digit or $ is a number or a parameter, not a name.
  const inName = () => runHead !== null && !/[0-9$]/.test(runHead)
  let i = 0
  const n = sql.length
  while (i < n) {
    const c = sql[i]
    const next = sql[i + 1]
    if (c === '-' && next === '-') {
      // PostgreSQL ends a line comment at either line break.
      while (i < n && sql[i] !== '\n' && sql[i] !== '\r') i++
      blank(' ')
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
      blank(' ')
    } else if (c === "'" || ((c === 'E' || c === 'e') && next === "'" && !inName())) {
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
      blank("''")
    } else if (c === '"') {
      let name = ''
      i++
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          name += '"'
          i += 2
        } else if (sql[i] === '"') {
          i++
          break
        } else name += sql[i++]
      }
      // A plain word holds no quote or semicolon, so showing it changes no other check.
      blank(PLAIN_NAME.test(name) ? ` ${name} ` : '""')
    } else {
      const tag = c === '$' && !inName() ? dollarTagAt(sql, i) : null
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length)
        i = end < 0 ? n : end + tag.length
        blank("''")
      } else {
        out += c
        if (!NAME_CHAR.test(c)) runHead = null
        else if (runHead === null) runHead = c
        i++
      }
    }
  }
  return out
}

/** The dollar-quote tag that opens at sql[i], if one does. */
function dollarTagAt(sql: string, i: number): string | null {
  DOLLAR_TAG.lastIndex = i
  return DOLLAR_TAG.exec(sql)?.[0] ?? null
}

/**
 * Functions and words the assistant never needs, refused with a plain
 * sentence. Defence in depth only, and not all of it is the database's to
 * stop: it refuses the file, large-object and dblink functions and any change
 * of role, but pg_sleep runs until the statement timeout, and
 * pg_cancel_backend / pg_terminate_backend reach the reader's own other
 * sessions (another person's query).
 */
const DENIED: { pattern: RegExp; what: string }[] = [
  { pattern: /\bpg_(try_)?advisory\w*/i, what: 'Advisory locks' },
  { pattern: /\bpg_sleep\w*/i, what: 'pg_sleep' },
  { pattern: /\bset_config\b/i, what: 'set_config' },
  { pattern: /\bpg_terminate_backend\b/i, what: 'pg_terminate_backend' },
  { pattern: /\bpg_cancel_backend\b/i, what: 'pg_cancel_backend' },
  { pattern: /\blo_\w+\s*\(/i, what: 'Large-object functions' },
  { pattern: /\bdblink\w*/i, what: 'dblink' },
  { pattern: /\bpg_read_\w+/i, what: 'Reading server files' },
  { pattern: /\b(query|cursor)_to_xml\w*|\bts_(stat|rewrite)\b/i, what: 'Running SQL from text' },
  { pattern: /\bpg_notify\b/i, what: 'pg_notify' },
  { pattern: /\bcopy\b/i, what: 'COPY' },
  // codeOnly blanks a quoted name with escapes in it, so U&"pg\005fsleep" would hide what it names.
  { pattern: /\bu&""/i, what: 'Unicode-escaped names' },
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

/** The function in schema ai (migration 0031) that refuses a long row; the runner's own, left out of the data dictionary. */
export const ROW_SIZE_CHECK = 'assert_row_size'

const PREPARE_PREFIX = 'PREPARE ai_chk AS '
const DECLARE_PREFIX = 'DECLARE ai_cur NO SCROLL CURSOR FOR SELECT ai_q.* FROM (SELECT * FROM ('
/**
 * The end of the cursor's wrapper. The line break keeps a trailing -- comment
 * from swallowing it; OFFSET 0 keeps PostgreSQL from merging the query into
 * the check, which would compute a column twice (a subquery in it, say). The
 * row's stored size is cheap to take, where writing a 600 MB value out as text
 * just to measure it takes longer than the chat's timeout; the exact size on
 * the wire is watched as it arrives (watchMessageSizes).
 */
const declareSuffix = (maxRowBytes: number) => `\n) ai_s OFFSET 0) ai_q WHERE ai.${ROW_SIZE_CHECK}(pg_column_size(ai_q.*), ${maxRowBytes})`

/** Rows asked for by one FETCH, at most. */
const FETCH_ROWS_MAX = 1_000
/** What the wire adds to a row's text: 4 bytes a column (1 664 columns at most) and the message's own framing. */
const WIRE_SLACK_BYTES = 64 * 1024
/** How long a cancel request may take to deliver before it is given up. */
const CANCEL_TIMEOUT_MS = 5_000
/**
 * How long one of the assistant's queries may run: in a chat, a saved or
 * scheduled report, an Excel file, a saved table, an export. The database is
 * the one the inspectors save to, so a longer limit lets one heavy query hold
 * it longer; automations' watches keep their own, shorter one.
 */
export const AI_QUERY_TIMEOUT_MS = 60_000

/** PostgreSQL's CancelRequest code (1234 << 16 | 5678). */
const CANCEL_REQUEST_CODE = 80_877_102

function tookTooLong(timeoutMs: number): string {
  const seconds = timeoutMs >= 1000 ? Math.round(timeoutMs / 1000) : Math.round(timeoutMs / 100) / 10
  return `The query took too long (${seconds} s). Narrow it or aggregate.`
}

/** The same sentence ai.assert_row_size raises (it divides by 1024 the same way). */
function rowTooLarge(maxRowBytes: number): string {
  return `A row of the result is larger than ${Math.floor(maxRowBytes / 1024)} KB. Select fewer or shorter columns, or aggregate.`
}

function replyTooLarge(limitBytes: number): string {
  return `The query failed with an error message longer than ${Math.floor(limitBytes / 1024)} KB: it quotes a very long value (a cast or function applied to long text, say). Work on shorter values.`
}

/** What could not be had from the database (a dropped connection, a client timeout): nothing in it the model can fix. */
const DATABASE_UNREACHABLE = 'The database could not run the query just now. Try again.'

/** A failed run: the sentence for the model, and the rest for words of other kinds. */
type Failed = Pick<QueryRun, 'error' | 'failure' | 'code' | 'dbMessage'> & { error: string; failure: QueryFailure }

/**
 * The PostgreSQL error as a sentence the model can act on, and what it was.
 * `at`: where the query's own text starts in the statement that failed.
 */
function describeError(err: unknown, limits: { timeoutMs: number; maxRowBytes: number }, at: { prefix: number; chars: number }): Failed {
  // Anything but PostgreSQL's own answer (a dropped connection, a client timeout) says nothing useful.
  if (!(err instanceof pg.DatabaseError)) return { error: DATABASE_UNREACHABLE, failure: 'unavailable' }
  if (err.code === '57014') return { error: tookTooLong(limits.timeoutMs), failure: 'timeout', code: err.code }
  // ai.assert_row_size refusing a row (program_limit_exceeded, in its own words).
  if (err.code === '54000' && err.message === rowTooLarge(limits.maxRowBytes)) return { error: err.message, failure: 'row-too-large', code: err.code }
  return { error: errorText(err, at), failure: 'database', ...(err.code ? { code: err.code } : {}), ...(err.message ? { dbMessage: err.message } : {}) }
}

/** PostgreSQL's message, where in the query it points, its hint, and what the model may read. */
function errorText(err: pg.DatabaseError, at: { prefix: number; chars: number }): string {
  let text = err.message || 'The query failed.'
  // Positions count from the start of the statement sent; give them back in the query's own terms.
  const position = Number(err.position) - at.prefix
  // One past the last character is "at end of input".
  if (Number.isFinite(position) && position >= 1 && position <= at.chars + 1) text += ` (at character ${position})`
  if (err.hint) text += ` Hint: ${err.hint}`
  if (err.code === '42501' || err.code === '42P01' || err.code === '3F000') {
    text += ' Only the views and functions in schema ai, and the saved tables in schema ai_saved, can be read.'
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

/** What a row costs to hold, roughly: a string's length, 8 for anything else. */
function charsOf(row: AiCell[]): number {
  let n = 0
  for (const c of row) n += typeof c === 'string' ? c.length : 8
  return n
}

/** A reader connection, or why there is none. Waiting for one ends as soon as the run is stopped. */
async function connect(pool: pg.Pool, signal: AbortSignal | undefined): Promise<pg.PoolClient | Error | 'stopped'> {
  const connecting = pool.connect()
  let onAbort: (() => void) | undefined
  const stopped = new Promise<'stopped'>((resolve) => {
    onAbort = () => resolve('stopped')
    signal?.addEventListener('abort', onAbort, { once: true })
  })
  try {
    const first = await Promise.race([connecting, stopped])
    // A connection that arrives after the stop goes straight back, closed.
    if (first === 'stopped') connecting.then((c) => c.release(true), () => undefined)
    return first
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e))
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * Ask PostgreSQL to cancel what a connection is running: a CancelRequest on a
 * new socket, as libpq sends one. It needs no sign-in and no room in the
 * pool. Best effort: the statement timeout stops the query in any case.
 */
function cancelBackend(client: pg.PoolClient): void {
  // pg keeps these from the connection's start-up (BackendKeyData); its types do not list them.
  const { processID, secretKey, host, port } = client as unknown as { processID: number | null; secretKey: number | null; host: string; port: number }
  if (processID == null || secretKey == null) return
  const packet = Buffer.alloc(16)
  packet.writeInt32BE(16, 0)
  packet.writeInt32BE(CANCEL_REQUEST_CODE, 4)
  packet.writeInt32BE(processID, 8)
  packet.writeInt32BE(secretKey, 12)
  const socket = host.startsWith('/') ? net.connect(`${host}/.s.PGSQL.${port}`) : net.connect(port, host)
  socket.setTimeout(CANCEL_TIMEOUT_MS, () => socket.destroy())
  socket.on('error', (e) => console.warn('[ai] could not cancel a query:', e.message))
  // PostgreSQL reads the request and closes the socket.
  socket.end(packet)
}

/**
 * Call `onTooLarge` (once) as soon as PostgreSQL announces a message longer
 * than `limit` bytes on this connection: before pg has read the message, let
 * alone made a string of it. ai.assert_row_size already refuses a long row
 * inside the database; this also covers an error that quotes a huge value
 * (`repeat('x', 600000000)::int`). Returns how to stop watching.
 */
function watchMessageSizes(client: pg.PoolClient, limit: number, onTooLarge: (type: string) => void): () => void {
  // pg reads the server's messages from this stream (TLS or not); its types do not list it.
  const stream = (client as unknown as { connection?: { stream?: Duplex } }).connection?.stream
  if (!stream || typeof stream.prependListener !== 'function') {
    // Never run a query unwatched: a pg upgrade that moves this fails every query, loudly.
    console.error("[ai] cannot watch the reader's connection: pg no longer has connection.stream")
    throw new Error('The reader connection cannot be watched.')
  }
  // Messages are a type byte, a 4-byte length that counts itself, then the body; a header may straddle chunks.
  const header = Buffer.alloc(5)
  let have = 0
  let skip = 0
  const onData = (chunk: Buffer) => {
    let i = 0
    while (i < chunk.length) {
      if (skip > 0) {
        const n = Math.min(skip, chunk.length - i)
        skip -= n
        i += n
        continue
      }
      const n = Math.min(5 - have, chunk.length - i)
      chunk.copy(header, have, i, i + n)
      have += n
      i += n
      if (have < 5) return
      have = 0
      const length = header.readUInt32BE(1)
      if (length > limit) {
        stream.off('data', onData)
        onTooLarge(String.fromCharCode(header[0]))
        return
      }
      skip = length - 4
    }
  }
  // Ahead of pg's own listener, which buffers a message until it is whole.
  stream.prependListener('data', onData)
  return () => stream.off('data', onData)
}

/** Told of every run, as it ends (slowQueries.ts keeps the slow ones). One at a time: set again, it replaces the last. */
let observer: ((sql: string, run: QueryRun) => void) | null = null

/** Tell `watch` of every query run from now on, with its SQL and how it ended. */
export function observeQueries(watch: ((sql: string, run: QueryRun) => void) | null): void {
  observer = watch
}

/**
 * Run one query as the reader. Never throws: a refusal, an error, a timeout
 * or a stop comes back as `ok: false` with a sentence for the model. The
 * observer, when one is set, is told of it as it ends.
 */
export async function runReadOnlyQuery(pool: pg.Pool | null, rawSql: string, opts: RunOptions): Promise<QueryRun> {
  const run = await runOnce(pool, rawSql, opts)
  try {
    observer?.(rawSql, run)
  } catch (e) {
    // Watching is never the query's failure.
    console.warn('[ai] a query observer failed:', e instanceof Error ? e.message : String(e))
  }
  return run
}

async function runOnce(pool: pg.Pool | null, rawSql: string, opts: RunOptions): Promise<QueryRun> {
  const started = Date.now()
  const fail = (why: Failed): QueryRun => ({ ok: false, columns: [], rows: [], truncated: false, ms: Date.now() - started, ...why })
  const checked = precheckSql(rawSql)
  if ('error' in checked) return fail({ error: checked.error, failure: 'rejected' })
  if (!pool) return fail({ error: "The assistant's database access is not available right now.", failure: 'unavailable' })
  const stopped: Failed = { error: AI_QUERY_STOPPED, failure: 'stopped' }
  const { signal } = opts
  if (signal?.aborted) return fail(stopped)
  const maxRowBytes = Math.max(1024, Math.floor(opts.maxRowBytes ?? AI_CHAT_LIMITS.maxRowBytes))
  const maxChars = Math.max(1, Math.floor(opts.maxChars ?? AI_CHAT_LIMITS.maxChars))

  const client = await connect(pool, signal)
  if (client === 'stopped') return fail(stopped)
  if (client instanceof Error) {
    // Not the query's fault, and nothing the model can fix: the reason is for the log.
    console.warn('[ai] the reader could not connect:', client.message)
    return fail({ error: DATABASE_UNREACHABLE, failure: 'unavailable' })
  }

  // Why the run was cut short, when it was; the first reason wins.
  let interrupted: Failed | null = null
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    client.release(true)
  }
  // Stop the statement inside PostgreSQL and stop waiting for it here: whatever is in flight fails at once.
  const interrupt = (why: Failed) => {
    if (interrupted !== null || closed) return
    interrupted = why
    cancelBackend(client)
    close()
  }
  const onAbort = () => interrupt(stopped)
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()
  // The whole run, not each statement, keeps to the time allowed; the statement timeout stays as the database's own guard.
  const timer = setTimeout(() => interrupt({ error: tookTooLong(opts.timeoutMs), failure: 'timeout' }), opts.timeoutMs)
  let unwatch = () => {}
  const sql = checked.sql
  const at = { prefix: 0, chars: Array.from(sql).length }
  // No message, and so no row, longer than this reaches pg.
  const wireLimit = maxRowBytes + WIRE_SLACK_BYTES
  try {
    unwatch = watchMessageSizes(client, wireLimit, (type) =>
      interrupt(type === 'D' ? { error: rowTooLarge(maxRowBytes), failure: 'row-too-large' } : { error: replyTooLarge(wireLimit), failure: 'reply-too-large' }),
    )
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
    await client.query(`SET LOCAL TIME ZONE ${pg.escapeLiteral(opts.timeZone)}`)
    await client.query(`SET LOCAL statement_timeout = ${pg.escapeLiteral(`${Math.max(1, Math.round(opts.timeoutMs))}ms`)}`)
    await client.query('SELECT 1')
    // @types/pg does not know queryMode; pg does (lib/query.js).
    at.prefix = PREPARE_PREFIX.length
    const prepare: pg.QueryConfig & { queryMode: 'extended' } = { text: PREPARE_PREFIX + sql, queryMode: 'extended' }
    await client.query(prepare)
    at.prefix = DECLARE_PREFIX.length
    const declare: pg.QueryConfig & { queryMode: 'extended' } = { text: DECLARE_PREFIX + sql + declareSuffix(maxRowBytes), queryMode: 'extended' }
    await client.query(declare)

    // A batch never holds more than the run's own budget, however long its rows are.
    const batch = Math.max(1, Math.min(FETCH_ROWS_MAX, Math.floor(maxChars / wireLimit)))
    const rows: AiCell[][] = []
    let columns: string[] = []
    let types: number[] = []
    let chars = 0
    let truncated = false
    while (!truncated) {
      const want = Math.min(batch, opts.maxRows + 1 - rows.length)
      const fetch: pg.QueryArrayConfig & { queryMode: 'extended' } = { text: `FETCH ${want} FROM ai_cur`, rowMode: 'array', queryMode: 'extended' }
      const result = await client.query(fetch)
      // By position: two columns may share a name.
      columns = result.fields.map((f) => f.name)
      types = result.fields.map((f) => f.dataTypeID)
      for (const read of result.rows as unknown[][]) {
        const row = read.map(toCell)
        chars += charsOf(row)
        if (rows.length === opts.maxRows || chars > maxChars) {
          truncated = true
          break
        }
        rows.push(row)
      }
      // Fewer than asked for: the cursor has no more.
      if (result.rows.length < want) break
    }
    return { ok: true, columns, types, rows, truncated, ms: Date.now() - started }
  } catch (e) {
    if (interrupted !== null) return fail(interrupted)
    return fail(describeError(e, { timeoutMs: opts.timeoutMs, maxRowBytes }, at))
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    unwatch()
    if (!closed) {
      try {
        await client.query('ROLLBACK')
      } catch {
        /* the connection is gone; it is destroyed below either way */
      }
      close()
    }
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

/**
 * The rows a report shows when it runs (no model reads them): every row read, each long cell cut as the model's are,
 * the whole within AI_REPORT_RUN_CHARS so a page never takes a reply it cannot draw.
 */
export function reportPreview(run: QueryRun): QueryPreview {
  const rows: AiCell[][] = []
  let chars = 0
  let truncated = run.truncated
  for (const r of run.rows) {
    const row = r.map((c) => cut(c, MODEL_CELL_CHARS))
    chars += JSON.stringify(row).length + 1
    if (chars > AI_REPORT_RUN_CHARS) {
      truncated = true
      break
    }
    rows.push(row)
  }
  return { columns: run.columns, rows, rowCount: rows.length, truncated }
}

/** Rows for Excel: every row read, each cell within what a spreadsheet cell holds. */
export function exportRows(run: QueryRun): AiCell[][] {
  return run.rows.map((r) => r.map((c) => cut(c, EXPORT_CELL_CHARS)))
}
