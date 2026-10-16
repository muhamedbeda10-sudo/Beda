import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { AI_DOMAIN_IDS, AI_PREVIEW_ROWS, type AiDomain } from '@qc/shared/ai'
import { TestApp } from './harness'
import { AI_DOMAIN_COMBINATIONS, combinationRole, domainBits, domainRole, domainsOfBits } from '../src/ai/domains'
import { readerConnectionString, readerPassword } from '../src/ai/reader'
import { runReadOnlyQuery, type RunOptions } from '../src/ai/runQuery'
import { describeAiSchema } from '../src/ai/schemaDoc'

// §20 — what a person may ask about is enforced by PostgreSQL: one role per
// data domain holding its views, one role that signs in per combination of
// domains, a member of the base and of those domains only. Every combination
// can read exactly its views — through the runner and by its grants — and
// nothing in public.

const app = new TestApp()
let database: string
const chat: RunOptions = { maxRows: AI_PREVIEW_ROWS, timeoutMs: 10_000, timeZone: 'Africa/Cairo' }

/** Each view's domain, as the owner reads the design: every view in exactly one. */
const VIEWS: Record<string, 'base' | AiDomain> = {
  machines: 'base',
  inspection_sessions: 'inspection',
  inspection_samples: 'inspection',
  defects: 'inspection',
  dimension_measurements: 'inspection',
  sample_coils: 'inspection',
  pt_records: 'inspection',
  session_stage_quantities: 'inspection',
  session_notes: 'inspection',
  production_sessions: 'inspection',
  inspection_photos: 'inspection',
  order_lines: 'orders',
  pdi_documents: 'orders',
  pdi_lines: 'orders',
  order_sync_runs: 'orders',
  pdi_photos: 'orders',
  coils: 'materials',
  suppliers: 'materials',
  item_dimension_specs: 'materials',
  machine_defect_list: 'materials',
  grade_equivalences: 'materials',
  pt_consumables: 'materials',
  work_instructions: 'materials',
  audit_log: 'audit',
  users: 'audit',
  production_task_records: 'production',
}

const readable = (view: string, domains: AiDomain[]) => VIEWS[view] === 'base' || domains.includes(VIEWS[view] as AiDomain)

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  database = new URL(app.config.DATABASE_URL).pathname.slice(1)
  const admin = await app.register('admin', 'Admin')
  await app.api('POST', '/api/master/machines', { token: admin.token, body: { code: '58', name: 'Welding', displayName: '58. Welding', process: 'welding' } })
})
afterAll(() => app.stop())

describe('§20 the data domains', () => {
  it('put every view in schema ai in exactly one domain', async () => {
    const { rows } = await app.db.query<{ name: string }>(`SELECT viewname AS name FROM pg_views WHERE schemaname = 'ai' ORDER BY 1`)
    expect(rows.map((r) => r.name).sort()).toEqual(Object.keys(VIEWS).sort())
    for (const { name } of rows) {
      const holders = await app.db.query<{ domain: string }>(
        `SELECT d AS domain FROM unnest($1::text[]) d WHERE has_table_privilege($2 || '_ai_' || d, 'ai.' || $3, 'SELECT')`,
        [['base', ...AI_DOMAIN_IDS], database, name],
      )
      expect(holders.rows.map((h) => h.domain), name).toEqual([VIEWS[name]])
    }
  })

  it('make each combination a member of the base and of its own domains only', async () => {
    expect(AI_DOMAIN_COMBINATIONS).toHaveLength(31)
    expect(AI_DOMAIN_COMBINATIONS[0]).toBe('00001')
    expect(AI_DOMAIN_COMBINATIONS[30]).toBe('11111')
    for (const bits of AI_DOMAIN_COMBINATIONS) {
      const { rows } = await app.db.query<{ name: string }>(
        `SELECT g.rolname AS name FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles r ON r.oid = m.member
          WHERE r.rolname = $1 ORDER BY 1`,
        [combinationRole(database, bits)],
      )
      const wanted = ['base', ...domainsOfBits(bits)].map((d) => domainRole(database, d as 'base' | AiDomain)).sort()
      expect(rows.map((r) => r.name), bits).toEqual(wanted)
    }
  })

  it('let every combination read exactly its views, by its grants and through the runner, and nothing in public', async () => {
    const publicTables = await app.db.query<{ oid: number }>(
      `SELECT c.oid FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'v', 'm', 'p', 'f', 'S')`,
    )
    for (const bits of AI_DOMAIN_COMBINATIONS) {
      const domains = domainsOfBits(bits)
      const role = combinationRole(database, bits)
      expect(app.aiReader.roleFor(domains)).toBe(role)
      const pool = app.aiReader.poolFor(domains)
      for (const view of Object.keys(VIEWS)) {
        const can = await app.db.query<{ can: boolean }>(`SELECT has_table_privilege($1, 'ai.' || $2, 'SELECT') AS can`, [role, view])
        expect(can.rows[0].can, `${bits} ${view}`).toBe(readable(view, domains))
        const run = await runReadOnlyQuery(pool, `SELECT 1 AS one FROM ai.${view} LIMIT 1`, chat)
        if (readable(view, domains)) expect(run.ok, `${bits} ${view}: ${run.error}`).toBe(true)
        else expect(run, `${bits} ${view}`).toMatchObject({ ok: false, code: '42501', error: expect.stringMatching(/permission denied for view/) })
      }
      // Production is an inspection figure; the helpers are everyone's.
      const production = await runReadOnlyQuery(pool, `SELECT count(*) AS n FROM ai.production_between('2026-01-01', '2026-12-31')`, chat)
      expect(production.ok, `${bits} production_between`).toBe(domains.includes('inspection'))
      const helpers = await runReadOnlyQuery(pool, `SELECT ai.machine_key('024') AS k, ai.material_kind('DX51D') AS m`, chat)
      expect(helpers.rows, bits).toEqual([['24', 'galvanized']])
      const reachable = await app.db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM unnest($2::oid[]) t(oid) WHERE has_table_privilege($1, t.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')`,
        [role, publicTables.rows.map((t) => t.oid)],
      )
      expect(reachable.rows[0].n, bits).toBe(0)
      const users = await runReadOnlyQuery(pool, 'SELECT username FROM public.users', chat)
      expect(users).toMatchObject({ ok: false, code: '42501' })
    }
  }, 60_000)

  it('give a combination no way into another domain, not even by changing role', async () => {
    const role = combinationRole(database, domainBits(['inspection']))
    const client = new pg.Client({ connectionString: readerConnectionString(app.config.DATABASE_URL, role, readerPassword(app.config.JWT_SECRET, role)) })
    await client.connect()
    try {
      for (const target of [domainRole(database, 'orders'), domainRole(database, 'production'), combinationRole(database, '11111'), 'qc']) {
        await expect(client.query(`SET ROLE ${pg.escapeIdentifier(target)}`), target).rejects.toThrow(/permission denied/)
      }
      // A role of its own domains it may become; it reads no more for it.
      await client.query(`SET ROLE ${pg.escapeIdentifier(domainRole(database, 'inspection'))}`)
      await expect(client.query('SELECT 1 FROM ai.order_lines')).rejects.toThrow(/permission denied/)
    } finally {
      await client.end()
    }
  })

  it('bring a combination back in line at the next start, and refuse to start with one that can do more than read', async () => {
    const role = combinationRole(database, '10000')
    // Someone gives it another domain behind the API's back: the next start takes it away.
    await app.db.query(`GRANT ${pg.escapeIdentifier(domainRole(database, 'audit'))} TO ${pg.escapeIdentifier(role)}`)
    expect(await app.aiReader.provision(app.db, app.config)).toBe(true)
    const held = await app.db.query(
      `SELECT 1 FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = $1 AND g.rolname = $2`,
      [role, domainRole(database, 'audit')],
    )
    expect(held.rowCount).toBe(0)
    // A role that may create databases is not one the API signs in as.
    await app.db.query(`ALTER ROLE ${pg.escapeIdentifier(role)} CREATEDB`)
    try {
      expect(await app.aiReader.provision(app.db, app.config)).toBe(false)
      expect(app.aiReader.ready).toBe(false)
      expect(app.aiReader.failure).toMatch(/more than read rights/)
    } finally {
      await app.db.query(`ALTER ROLE ${pg.escapeIdentifier(role)} NOCREATEDB`)
    }
    expect(await app.aiReader.provision(app.db, app.config)).toBe(true)
  })

  it('keep every function in schema ai to its domain, none open to all, and refuse to start while one is', async () => {
    const FUNCTIONS: Record<string, 'base' | AiDomain> = {
      'ai.assert_row_size(integer,integer)': 'base',
      'ai.machine_key(text)': 'base',
      'ai.material_kind(text)': 'base',
      'ai.production_between(date,date,text,boolean)': 'inspection',
    }
    const { rows } = await app.db.query<{ name: string; open: boolean }>(
      `SELECT p.oid::regprocedure::text AS name, has_function_privilege('public', p.oid, 'EXECUTE') AS open
         FROM pg_proc p WHERE p.pronamespace = 'ai'::regnamespace ORDER BY 1`,
    )
    expect(rows.map((r) => r.name)).toEqual(Object.keys(FUNCTIONS).sort())
    for (const { name, open } of rows) {
      expect(open, name).toBe(false)
      const holders = await app.db.query<{ domain: string }>(
        `SELECT d AS domain FROM unnest($1::text[]) d WHERE has_function_privilege($2 || '_ai_' || d, $3::regprocedure, 'EXECUTE')`,
        [['base', ...AI_DOMAIN_IDS], database, name],
      )
      expect(holders.rows.map((h) => h.domain), name).toEqual([FUNCTIONS[name]])
    }

    // A function a later migration adds can be run by everyone unless that migration revokes it
    // (a default set for one schema cannot): the readers do not start until it does.
    await app.db.query(`CREATE FUNCTION ai.later_helper() RETURNS int LANGUAGE sql AS 'SELECT 1'`)
    try {
      expect(await app.aiReader.provision(app.db, app.config)).toBe(false)
      expect(app.aiReader.failure).toBe('function ai.later_helper() in schema ai can be used by every role; revoke it from PUBLIC in its migration and grant it to its domain')
      await app.db.query(`REVOKE EXECUTE ON FUNCTION ai.later_helper() FROM PUBLIC`)
      expect(await app.aiReader.provision(app.db, app.config)).toBe(true)
      // So too a view someone gives to everyone.
      await app.db.query(`GRANT SELECT ON ai.coils TO PUBLIC`)
      expect(await app.aiReader.provision(app.db, app.config)).toBe(false)
      expect(app.aiReader.failure).toMatch(/^view ai\.coils in schema ai can be used by every role/)
    } finally {
      await app.db.query(`REVOKE SELECT ON ai.coils FROM PUBLIC`)
      await app.db.query(`DROP FUNCTION IF EXISTS ai.later_helper()`)
    }
    expect(await app.aiReader.provision(app.db, app.config)).toBe(true)
  })

  it('describe to the model the views of the domains given, and only those, the same way every time', async () => {
    const all = await describeAiSchema(app.db)
    expect([...all.matchAll(/^### ai\.(\w+)$/gm)].map((m) => m[1]).sort()).toEqual(Object.keys(VIEWS).sort())
    for (const bits of AI_DOMAIN_COMBINATIONS) {
      const domains = domainsOfBits(bits)
      const doc = await describeAiSchema(app.db, domains)
      expect(doc).toBe(await describeAiSchema(app.db, [...domains].reverse()))
      const views = [...doc.matchAll(/^### ai\.(\w+)$/gm)].map((m) => m[1])
      expect(views, bits).toEqual(Object.keys(VIEWS).filter((v) => readable(v, domains)).sort())
      // The helpers for everyone; production only with the inspections.
      expect(doc).toContain('### ai.machine_key(code text) returns text')
      expect(doc.includes('### ai.production_between('), bits).toBe(domains.includes('inspection'))
      expect(doc).not.toContain('assert_row_size')
    }
  })
})
