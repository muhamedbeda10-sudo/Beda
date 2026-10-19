import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TestApp } from './harness'
import { precheckSql, refusedByName, runReadOnlyQuery } from '../src/ai/runQuery'
import { domainsRead } from '../src/ai/savedTables'

// §20 — the runner's refusal of what reads a table by its name, or runs SQL
// given as text (the *_to_xml family, ts_stat, ts_rewrite, pg_stats…), and of
// the other functions it never runs. On a managed server the database cannot
// take them from the readers (migration 0072 needs a superuser), so the
// runner is what stops them: by the text, and by PostgreSQL's own resolution
// of the query (refusedByName), whatever spelling, quoting, comment or nesting
// the query hides a name in. Every form is tried against the real database,
// as a reader.

const app = new TestApp()
const TZ = () => app.config.FACTORY_TIMEZONE

/** PostgreSQL's reading of a query, on a reader's own connection (the role of every domain), thrown away after. */
async function readAsReader(sql: string): Promise<string | null> {
  const client = await app.aiReader.pool!.connect()
  try {
    return await refusedByName(client, sql)
  } finally {
    client.release(true)
  }
}

/** The forms a call can take: each must be refused by the text, by PostgreSQL's reading, and by the runner. */
const BYPASSES: [string, string][] = [
  ['schema-qualified', `SELECT pg_catalog.table_to_xml('ai.machines', true, false, '')::text AS x`],
  ['a quoted name', `SELECT "table_to_xml"('ai.machines', true, false, '')::text AS x`],
  ['a quoted schema and name', `SELECT "pg_catalog"."table_to_xml"('ai.machines', true, false, '')::text AS x`],
  ['in capitals', `SELECT TABLE_TO_XML('ai.machines', true, false, '')::text AS x`],
  ['a comment before the parenthesis', `SELECT table_to_xml /* a note */ ('ai.machines', true, false, '')::text AS x`],
  ['a line break and a tab before it', `SELECT table_to_xml\n\t('ai.machines', true, false, '')::text AS x`],
  ['named arguments', `SELECT table_to_xml(tbl => 'ai.machines', nulls => true, tableforest => false, targetns => '')::text AS x`],
  ['inside a CTE', `WITH x AS (SELECT query_to_xml('SELECT 1', true, false, '') AS v) SELECT v::text FROM x`],
  ['inside a scalar subquery', `SELECT (SELECT schema_to_xml('ai', true, false, ''))::text AS x`],
  ['in a LATERAL', `SELECT m.machine_code FROM ai.machines m CROSS JOIN LATERAL ts_stat('SELECT to_tsvector(machine) FROM ai.machines') s`],
  ['in LIMIT, which a plan does not show', `SELECT 1 AS one LIMIT length(database_to_xml(true, false, '')::text)`],
  ['in a window frame', `SELECT sum(1) OVER (ROWS BETWEEN length(table_to_xmlschema('ai.machines', true, false, '')::text) PRECEDING AND CURRENT ROW) AS s`],
  ['in ORDER BY', `SELECT machine_code FROM ai.machines ORDER BY length(cursor_to_xmlschema('c', true, false, '')::text)`],
  ['in a branch never taken', `SELECT CASE WHEN false THEN query_to_xml_and_xmlschema('SELECT 1', true, false, '')::text END AS x`],
  ['ts_rewrite running its query', `SELECT ts_rewrite('a'::tsquery, 'SELECT ''a''::tsquery, ''b''::tsquery') AS x`],
  ['pg_stats, quoted and qualified', `SELECT count(*) AS n FROM "pg_catalog"."pg_stats"`],
  ['pg_stats_ext', `SELECT count(*) AS n FROM pg_stats_ext`],
  ['an advisory lock, qualified', `SELECT pg_catalog.pg_advisory_lock(67, 1) AS x`],
  ['pg_sleep in a WHERE', `SELECT 1 AS one WHERE pg_catalog.pg_sleep(0) IS NOT NULL`],
]

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
})
afterAll(() => app.stop())

describe('§20 a function that reads by name, however the query writes it', () => {
  it('is refused by the text, by PostgreSQL’s own reading of the query, and so by the runner', async () => {
    for (const [form, sql] of BYPASSES) {
      expect(precheckSql(sql), form).toMatchObject({ error: expect.stringMatching(/cannot be used in the assistant's queries/) })
      expect(await readAsReader(sql), form).toMatch(/cannot be used in the assistant's queries/)
      const run = await runReadOnlyQuery(app.aiReader.pool, sql, { maxRows: 10, timeoutMs: 5000, timeZone: TZ() })
      expect(run, form).toMatchObject({ ok: false, failure: 'rejected' })
    }
  })

  it('is refused by PostgreSQL’s reading alone, where the text shows nothing: a name in Unicode escapes', async () => {
    // U&"…" names a function in escapes the text cannot read as its name; PostgreSQL resolves it all the same.
    const escaped = `SELECT U&"table\\005fto_xml"('ai.machines', true, false, '')::text AS x`
    expect(await readAsReader(escaped)).toMatch(/Running SQL from text, or reading a table by its name, cannot be used/)
    const stats = `SELECT count(*) AS n FROM U&"pg\\005fstats"`
    expect(await readAsReader(stats)).toMatch(/statistics of tables cannot be used/)
    // A quoted name in capitals is another name: there is no such function, and nothing runs.
    await expect(readAsReader(`SELECT "TABLE_TO_XML"('ai.machines', true, false, '')::text AS x`)).rejects.toThrow(/does not exist/)
  })

  it('is refused before a query is planned to learn what it reads: planning may evaluate it, and its error could carry the data', async () => {
    // A stable function of constants in a comparison is worked out while the query is planned.
    const leak = `SELECT 1 AS one WHERE 1 = (U&"table\\005fto_xml"('ai.users', true, false, '')::text)::int`
    const read = await domainsRead(app.aiReader, leak)
    expect(read).toMatchObject({ error: expect.stringMatching(/cannot be used in the assistant's queries/) })
    expect(JSON.stringify(read)).not.toMatch(/invalid input syntax/)
  })

  it('leaves every other query as it is: names in strings, duplicate columns, comments, CTEs and windows', async () => {
    const fine = [
      `SELECT 'table_to_xml(' AS said, machine_code, machine_code FROM ai.machines -- table_to_xml`,
      `WITH m AS (SELECT machine_code FROM ai.machines) SELECT machine_code, count(*) OVER () AS n FROM m ORDER BY 1 LIMIT 5`,
      `SELECT xmlelement(name x, 'a')::text AS x, to_tsvector('simple', 'stat') AS v`,
    ]
    for (const sql of fine) {
      expect(await readAsReader(sql), sql).toBeNull()
      const run = await runReadOnlyQuery(app.aiReader.pool, sql, { maxRows: 10, timeoutMs: 5000, timeZone: TZ() })
      expect(run.ok, `${sql}: ${run.error}`).toBe(true)
    }
    // Nothing of the reading is kept: no view, no prepared statement, no transaction left open.
    const client = await app.aiReader.pool!.connect()
    try {
      expect(await refusedByName(client, fine[0])).toBeNull()
      expect((await client.query(`SELECT to_regclass('pg_temp.ai_names') AS v`)).rows[0].v).toBeNull()
      expect((await client.query(`SELECT count(*)::int AS n FROM pg_prepared_statements`)).rows[0].n).toBe(0)
      expect((await client.query(`SELECT now() = statement_timestamp() AS outside`)).rows[0].outside).toBe(true)
    } finally {
      client.release(true)
    }
  })

  it('cannot be reached any other way: no operator, cast, type or aggregate of PostgreSQL’s calls one', async () => {
    // Every function the runner refuses, as the catalog names them.
    const { rows } = await app.db.query<{ kind: string; n: number }>(`
      WITH refused AS (
        SELECT oid FROM pg_proc
         WHERE proname ~ '^(table|query|cursor|schema|database)_to_xml' OR proname IN ('ts_stat', 'ts_rewrite', 'set_config', 'pg_notify', 'pg_terminate_backend', 'pg_cancel_backend')
            OR proname ~ '^(pg_(try_)?advisory|pg_sleep|lo_|dblink|pg_read_)')
      SELECT 'operator' AS kind, count(*)::int AS n FROM pg_operator WHERE oprcode IN (SELECT oid FROM refused) OR oprrest IN (SELECT oid FROM refused) OR oprjoin IN (SELECT oid FROM refused)
      UNION ALL SELECT 'cast', count(*)::int FROM pg_cast WHERE castfunc IN (SELECT oid FROM refused)
      UNION ALL SELECT 'type', count(*)::int FROM pg_type
        WHERE ARRAY[typinput, typoutput, typreceive, typsend, typmodin, typmodout, typanalyze, typsubscript]::oid[] && ARRAY(SELECT oid FROM refused)
      UNION ALL SELECT 'aggregate', count(*)::int FROM pg_aggregate
        WHERE ARRAY[aggtransfn, aggfinalfn, aggcombinefn, aggserialfn, aggdeserialfn, aggmtransfn, aggminvtransfn, aggmfinalfn]::oid[] && ARRAY(SELECT oid FROM refused)
      UNION ALL SELECT 'refused', count(*)::int FROM refused`)
    const counts = Object.fromEntries(rows.map((r) => [r.kind, r.n]))
    expect(counts.refused).toBeGreaterThan(20)
    expect(counts).toMatchObject({ operator: 0, cast: 0, type: 0, aggregate: 0 })
  })
})
