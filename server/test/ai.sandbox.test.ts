import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { AI_PREVIEW_ROWS } from '@qc/shared/ai'
import { TestApp } from './harness'
import { AI_DOMAIN_COMBINATIONS } from '../src/ai/domains'
import { AiReader, readerPassword, scramVerifier } from '../src/ai/reader'
import { codeOnly, precheckSql, previewJson, previewOf, runReadOnlyQuery, type RunOptions } from '../src/ai/runQuery'
import { describeAiSchema } from '../src/ai/schemaDoc'

// §20 — the assistant's database role and the query runner: whatever the
// model writes, it can read the ai views and nothing else, change nothing,
// and leave nothing behind.

const app = new TestApp()
let role: string
/** The test database's name: the reader role and its password are per database. */
let database: string
const chat: RunOptions = { maxRows: AI_PREVIEW_ROWS, timeoutMs: 10_000, timeZone: 'Africa/Cairo' }
const run = (sql: string, opts: Partial<RunOptions> = {}) => runReadOnlyQuery(app.aiReader.pool, sql, { ...chat, ...opts })

beforeAll(async () => {
  await app.start()
  database = new URL(app.config.DATABASE_URL).pathname.slice(1)
  // Two of the four-bit combination roles of the four-domain days and one of the five-bit ones of the five-domain days,
  // as a database that ran then would still hold them.
  for (const bits of ['0101', '1111', '10101']) {
    await app.db.query(`DROP ROLE IF EXISTS ${pg.escapeIdentifier(`${database}_ai_r_${bits}`)}`)
    await app.db.query(`CREATE ROLE ${pg.escapeIdentifier(`${database}_ai_r_${bits}`)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS`)
  }
  await app.resetDatabase()
  role = app.aiReader.role!
  // Something to read: two machines and an account.
  const admin = await app.register('admin', 'Admin')
  for (const [code, name] of [['58', 'Welding Line-LM4'], ['21', 'Press 400 t']]) {
    await app.api('POST', '/api/master/machines', { token: admin.token, body: { code, name, displayName: `${code}. ${name}`, process: code === '58' ? 'welding' : 'universal' } })
  }
})
afterAll(() => app.stop())

describe('§20 the reader roles', () => {
  it('are per database and per combination of domains, provisioned with LOGIN, a SCRAM verifier and the factory time zone', async () => {
    expect(app.aiReader.ready).toBe(true)
    expect(role).toBe(`${database}_ai_r_111111`)
    const { rows } = await app.db.query<{ rolname: string; rolcanlogin: boolean; rolsuper: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolinherit: boolean; rolconnlimit: number; rolconfig: string[] }>(
      `SELECT rolname, rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolinherit, rolconnlimit, rolconfig FROM pg_roles WHERE rolname LIKE $1 ORDER BY rolname`,
      [`${database}\\_ai\\_r\\_%`],
    )
    // Six bits, one per domain, every combination but none: the four-bit roles of the four-domain days (0041) and the
    // five-bit ones of the five-domain days (0075) are gone.
    expect(AI_DOMAIN_COMBINATIONS).toHaveLength(63)
    expect(rows.map((r) => r.rolname.slice(`${database}_ai_r_`.length))).toEqual([...AI_DOMAIN_COMBINATIONS])
    expect(rows.map((r) => r.rolname)).toEqual(expect.arrayContaining([`${database}_ai_r_000001`, `${database}_ai_r_101010`, `${database}_ai_r_111111`]))
    for (const r of rows) {
      expect(r, r.rolname).toMatchObject({ rolcanlogin: true, rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolinherit: true, rolconnlimit: 3 })
      expect(r.rolconfig).toEqual(
        expect.arrayContaining([
          'search_path=ai, pg_catalog',
          'default_transaction_read_only=on',
          'statement_timeout=10s',
          'lock_timeout=2s',
          'idle_in_transaction_session_timeout=15s',
          'TimeZone=Africa/Cairo',
        ]),
      )
      // The tests connect as a superuser, which may read the stored verifier: never the password itself.
      const stored = await app.db.query<{ rolpassword: string }>(`SELECT rolpassword FROM pg_authid WHERE rolname = $1`, [r.rolname])
      expect(stored.rows[0].rolpassword).toMatch(/^SCRAM-SHA-256\$4096:/)
      expect(stored.rows[0].rolpassword).not.toContain(readerPassword(app.config.JWT_SECRET, r.rolname))
    }
    // The single reader of the first version is gone.
    expect((await app.db.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [`${database}_ai_reader`])).rowCount).toBe(0)
  })

  it('derives a different password for every role, database and secret, and sends a verifier in RFC 5803 form', () => {
    const a = readerPassword(app.config.JWT_SECRET, 'qc_test_ai_r_11111')
    expect(readerPassword(app.config.JWT_SECRET, 'qc_dev_ai_r_11111')).not.toBe(a)
    expect(readerPassword(app.config.JWT_SECRET, 'qc_test_ai_r_10100')).not.toBe(a)
    expect(readerPassword('another-secret-another-secret-another', 'qc_test_ai_r_11111')).not.toBe(a)
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    // The verifier for the RFC 7677 example: user's password "pencil" with its salt.
    const salt = Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64')
    expect(scramVerifier('pencil', salt)).toBe(
      'SCRAM-SHA-256$4096:W22ZaJ0SNY7soEsUEjb6gQ==$WG5d8oPm3OtcPnkdi4Uo7BkeZkBFzpcXkuLmtbsT4qY=:wfPLwcE6nTWhTAmQ7tl2KeoiWGPlZqQxSrmfPwDl2dU=',
    )
  })

  it('is idempotent, and a failure leaves the assistant unavailable instead of throwing', async () => {
    expect(await app.aiReader.provision(app.db, app.config)).toBe(true)
    const broken = new AiReader()
    const ok = await broken.provision(app.db, { ...app.config, DATABASE_URL: 'postgresql://qc:qc@127.0.0.1:1/qc_test' })
    expect(ok).toBe(false)
    expect(broken.ready).toBe(false)
    expect(broken.failure).toBeTruthy()
    await broken.end()
  })

  it('cannot read a single table in public — the assistant’s own records included', async () => {
    const { rows } = await app.db.query<{ name: string; readable: boolean }>(
      `SELECT c.relname AS name, has_table_privilege($1, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS readable
         FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'v', 'm', 'p', 'f', 'S')`,
      [role],
    )
    expect(rows.length).toBeGreaterThan(50)
    expect(rows.filter((r) => r.readable).map((r) => r.name)).toEqual([])
    for (const table of ['users', 'auth_sessions', 'ai_credentials', 'ai_messages', 'chat_messages', 'app_settings']) {
      const res = await run(`SELECT * FROM public.${table}`)
      expect(res.ok, table).toBe(false)
      expect(res.error).toMatch(/permission denied/)
    }
    expect((await run('SELECT rolpassword FROM pg_catalog.pg_authid')).error).toMatch(/permission denied/)
  })

  it('can read every view and run every function in schema ai', async () => {
    const { rows } = await app.db.query<{ name: string }>(`SELECT viewname AS name FROM pg_views WHERE schemaname = 'ai' ORDER BY 1`)
    expect(rows.length).toBe(36)
    for (const { name } of rows) {
      const res = await run(`SELECT * FROM ai.${name} LIMIT 5`)
      expect(res.ok, `${name}: ${res.error}`).toBe(true)
    }
    const fn = await run(`SELECT ai.machine_key(' ٠٢١ ') AS k, ai.material_kind('DX51D+Z275') AS m, count(*) AS n FROM ai.production_between('2026-01-01', '2026-12-31', 'month')`)
    expect(fn.ok, fn.error).toBe(true)
    expect(fn.rows).toEqual([['21', 'galvanized', 0]])
    // What the data dictionary promises of machine_key, and no more.
    const keys = await run(`SELECT ai.machine_key('024'), ai.machine_key(' 24 '), ai.machine_key('٢٤'), ai.machine_key('STAM 24'), ai.machine_key('stam24')`)
    expect(keys.rows).toEqual([['24', '24', '24', 'stam24', 'stam24']])
    // search_path is ai: an unqualified view name is found.
    const machines = await run(`SELECT machine_code, machine, process, makes_to_stock FROM machines ORDER BY machine_code`)
    expect(machines.rows).toEqual([
      ['21', '21. Press 400 t', 'universal', true],
      ['58', '58. Welding Line-LM4', 'welding', false],
    ])
  })

  it('exposes no secret or binary column', async () => {
    const { rows } = await app.db.query<{ col: string }>(
      `SELECT table_name || '.' || column_name AS col FROM information_schema.columns
        WHERE table_schema = 'ai' AND column_name ~* '(password|hash|token|data_url|storage_key|prefix|secret|ip_address|user_agent|thumbnail|body|username|sha256|api_key|ciphertext)'`,
    )
    expect(rows).toEqual([])
  })

  it('describes every view and function from the catalog, the same way every time', async () => {
    const doc = await describeAiSchema(app.db)
    expect(doc).toBe(await describeAiSchema(app.db))
    expect(doc).toContain('### ai.inspection_sessions')
    expect(doc).toContain('- rejected_before_release double precision: Pieces already rejected on the line before the first-part release inspection')
    expect(doc).toContain('### ai.production_between(p_from date, p_to date, p_per text DEFAULT')
    expect(doc).toContain("p_all_machines boolean DEFAULT false) returns TABLE(")
    expect(doc).toContain('pass p_all_machines => true (the 4th argument) to include machines with counts_on_dashboard = false')
    expect(doc).toContain('- counts_on_dashboard boolean: false = the machine is left out of the dashboard')
    expect(doc).toContain('- invalid integer: Rows of the run that could not be read (the true count of failed rows).')
    expect(doc).toContain('- errors_kept integer: How many of the unreadable rows are kept in errors_sample (at most 50); use invalid for the count.')
    expect(doc).toContain('- dashboard_supplier text: Supplier as the dashboard')
    expect(doc).toContain('as do "STAM 24" and "stam24" (but "STAM 24" and "24" do not)')
    // The runner's own row check is no business of the model's.
    expect(doc).not.toContain('assert_row_size')
    const views = [...doc.matchAll(/^### ai\.(\w+)$/gm)].map((m) => m[1])
    expect(views).toEqual([...views].sort())
    expect(views).toHaveLength(36)
  })
})

describe('§20 the query runner', () => {
  it('accepts one SELECT or WITH, and says plainly what it refuses', () => {
    expect(precheckSql('  SELECT 1;  ')).toEqual({ sql: 'SELECT 1' })
    expect(precheckSql('/* why */ -- note\n with x as (select 1) select * from x')).toHaveProperty('sql')
    expect(precheckSql("SELECT ';' AS semi, $$ pg_sleep(1) $$ AS quoted")).toHaveProperty('sql')
    for (const sql of [
      'INSERT INTO ai.machines VALUES (1)',
      'DELETE FROM users',
      'DROP TABLE users',
      'SET ROLE qc',
      'COPY users TO STDOUT',
      'SELECT 1; SELECT 2',
      'SELECT 1; DROP TABLE users',
      "SELECT set_config('role', 'qc', false)",
      'SELECT pg_sleep(30)',
      'SELECT pg_advisory_lock(7204930115)',
      "SELECT query_to_xml('select 1', true, false, '')",
      "SELECT lo_import('/etc/passwd')",
      "SELECT pg_read_file('/etc/passwd')",
      "SELECT * FROM ts_stat('SELECT to_tsvector(pg_sleep(5)::text)')",
      "SELECT ts_rewrite('a'::tsquery, 'SELECT ''a''::tsquery, pg_sleep(5)::text::tsquery')",
      '',
      'x'.repeat(20_001),
    ]) {
      expect(precheckSql(sql), sql.slice(0, 40)).toHaveProperty('error')
    }
    expect(codeOnly(`SELECT 'it''s' AS "a""b", E'\\'' /* c /* nested */ */ -- d`)).toBe(`SELECT '' AS "", ''    `)
  })

  it('reads a name however it is written, so the refusals cannot be hidden', () => {
    for (const sql of [
      // A quoted name that is a plain word is the same function.
      'SELECT "pg_sleep"(1)',
      'SELECT pg_catalog."pg_terminate_backend"(1)',
      `SELECT "set_config"('search_path', 'public', true)`,
      `SELECT "pg_catalog"."query_to_xml"('SELECT 1', true, false, '')`,
      // Unicode escapes spell any name.
      'SELECT U&"pg\\005fsleep"(1)',
      `SELECT u&"pg!005fsleep" UESCAPE '!' (1)`,
      // E' inside a name opens a plain string: its backslash escapes nothing.
      `SELECT name'x\\', pg_sleep(5) AS z --'`,
      // $ inside a name is part of it, not a dollar quote.
      'SELECT 1 AS a$b$, pg_sleep(5) AS c$b$',
      // A line comment ends at a carriage return too.
      'SELECT 1 -- note\r, pg_sleep(5)',
      // A dollar quote's tag may be any length: the quote ends at the same long tag, not at the next '.
      `SELECT $${'q'.repeat(250)}$ ' $${'q'.repeat(250)}$ AS a, pg_sleep(5) AS b --'`,
    ]) {
      expect(precheckSql(sql), sql).toEqual({ error: expect.stringMatching(/cannot be used in the assistant's queries/) })
    }
    expect(codeOnly('SELECT "pg_sleep"(1), "a b", "x""y"')).toBe('SELECT  pg_sleep (1), "", ""')
    expect(codeOnly(`SELECT name'x\\', 1 --'`)).toBe(`SELECT name'', 1  `)
    expect(codeOnly('SELECT 1 AS a$b$, 2 AS c$b$')).toBe('SELECT 1 AS a$b$, 2 AS c$b$')
    expect(codeOnly('SELECT $q$ pg_sleep(1) $q$, $é$ ; $é$, 1$t$x$t$')).toBe("SELECT '', '', 1''")
    expect(codeOnly('SELECT 1 -- a\rFROM x')).toBe('SELECT 1  \rFROM x')
    // One pass over the text, however many $ it holds: the longest query is read at once, not in seconds.
    const dollars = `SELECT ${'a$'.repeat(9_990)}`
    const started = performance.now()
    expect(codeOnly(dollars)).toBe(dollars)
    expect(codeOnly(`SELECT a${'$'.repeat(19_990)}`)).toBe(`SELECT a${'$'.repeat(19_990)}`)
    expect(performance.now() - started).toBeLessThan(500)
    // Plain quoted names and literals stay acceptable.
    expect(precheckSql('SELECT "machine_code", U&\'d\\0061t\' FROM ai."machines"')).toHaveProperty('sql')
  })

  it('refuses the same calls at the database or bounds them, past the text checks', async () => {
    // What the text checks are a courtesy for: run straight on the role's own connection.
    const client = await app.aiReader.pool!.connect()
    try {
      await expect(client.query(`SELECT "pg_read_file"('/etc/passwd')`)).rejects.toThrow(/permission denied/)
      await expect(client.query(`SELECT "set_config"('role', 'qc', true)`)).rejects.toThrow(/permission denied/)
      await client.query(`SET statement_timeout = '200ms'`)
      await expect(client.query('SELECT "pg_sleep"(2)')).rejects.toThrow(/statement timeout/)
    } finally {
      client.release(true)
    }
  })

  it('reads values as PostgreSQL writes them, in factory time, by position', async () => {
    const res = await run(
      `SELECT 1::int AS n, 2.50::numeric AS d, 9007199254740993::bigint AS big, true AS b, '{"a": [1, 2]}'::jsonb AS j,
              '2026-01-15 07:00:00+00'::timestamptz AS t, '2026-01-02'::date AS day, NULL AS nothing, 'x' AS n`,
    )
    expect(res.ok, res.error).toBe(true)
    expect(res.columns).toEqual(['n', 'd', 'big', 'b', 'j', 't', 'day', 'nothing', 'n'])
    expect(res.rows).toEqual([[1, 2.5, '9007199254740993', true, '{"a":[1,2]}', '2026-01-15 09:00:00+02', '2026-01-02', null, 'x']])
    // A literal timestamp in the query is factory time too.
    const lit = await run(`SELECT '2026-01-15 09:00'::timestamptz = '2026-01-15 07:00:00+00'::timestamptz AS same`)
    expect(lit.rows).toEqual([[true]])
  })

  it('refuses writes, data-modifying CTEs and escalation at the database', async () => {
    const cases: [string, RegExp][] = [
      ['WITH gone AS (DELETE FROM ai.machines RETURNING *) SELECT * FROM gone', /data-modifying|read-only|cannot delete/i],
      ['WITH x AS (INSERT INTO public.ai_usage (user_id, model, cost_usd) VALUES (gen_random_uuid(), $$m$$, 0) RETURNING id) SELECT * FROM x', /data-modifying|permission denied|read-only/i],
      ['SELECT * FROM ai.machines FOR UPDATE', /read-only|cannot|permission/i],
      ["SELECT nextval('public.ai_usage_id_seq')", /permission denied|read-only/i],
      ['SELECT 1 FROM ai.users u, LATERAL (SELECT u.name) x WHERE 1/0 = 1', /division by zero/],
    ]
    for (const [sql, error] of cases) {
      const res = await run(sql)
      expect(res.ok, sql).toBe(false)
      expect(res.error, sql).toMatch(error)
    }
    // Without the runner's checks, straight on the role's own connection.
    const client = await app.aiReader.pool!.connect()
    try {
      for (const sql of ['SET ROLE qc', "SELECT set_config('role', 'qc', false)", 'SET SESSION AUTHORIZATION qc', 'CREATE TABLE ai.x (n int)', 'DROP VIEW ai.machines', 'UPDATE ai.users SET name = $$x$$']) {
        await expect(client.query(sql), sql).rejects.toThrow(/permission denied|read-only|must be|not allowed|cannot/i)
      }
      // pg_sleep is refused before it gets here; past the timeout it is stopped all the same.
      await client.query(`SET statement_timeout = '200ms'`)
      await expect(client.query('SELECT pg_sleep(2)')).rejects.toThrow(/statement timeout/)
      // The extended protocol takes one statement only.
      const two: pg.QueryConfig & { queryMode: 'extended' } = { text: 'SELECT 1; SELECT 2', queryMode: 'extended' }
      await expect(client.query(two)).rejects.toThrow(/multiple commands/)
    } finally {
      client.release(true)
    }
  })

  it('stops a query at its timeout', async () => {
    const slow = 'SELECT count(*) FROM generate_series(1, 30000) a, generate_series(1, 30000) b'
    const started = Date.now()
    const res = await run(slow, { timeoutMs: 300 })
    expect(res.ok).toBe(false)
    expect(res.error).toBe('The query took too long (0.3 s). Narrow it or aggregate.')
    expect(Date.now() - started).toBeLessThan(3000)
    const second = await run(slow, { timeoutMs: 1000 })
    expect(second.error).toBe('The query took too long (1 s). Narrow it or aggregate.')
  })

  it('leaves no advisory lock behind, even one taken inside a view function', async () => {
    // A function in ai the reader may call (default privileges grant it) that takes the migration lock key.
    await app.db.query(`CREATE FUNCTION ai.grab_lock() RETURNS boolean LANGUAGE sql AS $$ SELECT pg_advisory_lock(7204930115) IS NOT NULL $$`)
    try {
      const res = await run('SELECT ai.grab_lock() AS held')
      expect(res.ok, res.error).toBe(true)
      expect(res.rows).toEqual([[true]])
      // The connection was destroyed, and the lock with it.
      let held = 1
      for (let i = 0; i < 50 && held > 0; i++) {
        held = (await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'`)).rows[0].n
        if (held > 0) await new Promise((r) => setTimeout(r, 20))
      }
      expect(held).toBe(0)
      const { rows } = await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = $1 AND state <> 'idle'`, [role])
      expect(rows[0].n).toBe(0)
    } finally {
      await app.db.query('DROP FUNCTION ai.grab_lock()')
    }
  })

  it('caps the rows, cuts long cells and keeps what the model reads under its size', async () => {
    const many = await run('SELECT g FROM generate_series(1, 250) g ORDER BY g')
    expect(many.rows).toHaveLength(AI_PREVIEW_ROWS)
    expect(many.truncated).toBe(true)
    expect(many.rows[AI_PREVIEW_ROWS - 1]).toEqual([AI_PREVIEW_ROWS])
    const exact = await run('SELECT g FROM generate_series(1, 200) g')
    expect(exact.truncated).toBe(false)

    const wide = await run(`SELECT repeat('x', 5000) AS s`)
    const cut = previewOf(wide)
    expect(cut.rows[0][0]).toBe(`${'x'.repeat(1000)}…`)
    expect(cut.truncated).toBe(false)

    const big = await run(`SELECT g, repeat('y', 900) AS s FROM generate_series(1, 200) g`)
    const fitted = previewOf(big)
    expect(fitted.truncated).toBe(true)
    expect(fitted.rowCount).toBe(fitted.rows.length)
    expect(fitted.rowCount).toBeLessThan(200)
    const json = previewJson(fitted)
    expect(json.length).toBeLessThanOrEqual(60_000)
    expect(json.length).toBeGreaterThan(59_000)
    expect(Object.keys(JSON.parse(json))).toEqual(['columns', 'rows', 'rowCount', 'truncated'])
  })

  it('names the failing spot in the query itself', async () => {
    const res = await run('SELECT machine_code FROM ai.machines WHERE nope = 1')
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/column "nope" does not exist \(at character 44\)/)
    const missing = await run('SELECT * FROM ai.nothing_here')
    expect(missing.error).toMatch(/does not exist.*Only the views and functions in schema ai, and the saved tables in schema ai_saved, can be read/)
  })
})
