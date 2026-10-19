// ============================================================================
// §20 — the assistant's own ways into the database: roles that may read the
// views in schema ai of the domains they stand for, and nothing else.
//
// Migration 0033 creates one role without LOGIN per data domain, holding its
// views (0041 the fifth). Every start creates (or brings back in line) one role per
// combination of domains, a member of the base role and of those domains'
// roles only, with LOGIN and a password derived from JWT_SECRET and the
// role's name, so no extra secret has to be configured anywhere. The password
// reaches PostgreSQL only as a SCRAM verifier, never as plain text that could
// land in a statement log. A question runs as the role of the asker's
// domains, through a small pool made the first time it is needed.
//
// When any of this fails the API still starts: the assistant reports itself
// unavailable ('reader-unavailable') and everything else works as before.
// ============================================================================

import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'
import pg from 'pg'
import { AI_DOMAIN_IDS, type AiDomain } from '@qc/shared/ai'
import type { Config } from '../config'
import type { Db } from '../db/pool'
import { AI_DOMAIN_COMBINATIONS, combinationRole, domainBits, domainRole, domainsOfBits, type AiRoleDomain } from './domains'
import { AI_LONG_QUERY_TIMEOUT_MS } from './runQuery'

/** Serialises concurrent starts: two instances altering one role at once can fail. Next to the migration lock (7_204_930_115). */
const PROVISION_LOCK_KEY = 7_204_930_116
/** Each role's ceiling; its pool stays under it. */
const CONNECTION_LIMIT = 3
const POOL_MAX = 2

/** The password a reader role signs in with: stable for a given secret, different for every role (and so every database). */
export function readerPassword(jwtSecret: string, role: string): string {
  return createHmac('sha256', jwtSecret).update(`qc-ai-reader:v2:${role}`).digest('base64url')
}

/**
 * A SCRAM-SHA-256 verifier for `password`, in the form PostgreSQL stores
 * (RFC 5803). Sent in place of the password, PostgreSQL keeps it as it is.
 */
export function scramVerifier(password: string, salt = randomBytes(16), iterations = 4096): string {
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256')
  const clientKey = createHmac('sha256', salted).update('Client Key').digest()
  const storedKey = createHash('sha256').update(clientKey).digest()
  const serverKey = createHmac('sha256', salted).update('Server Key').digest()
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`
}

// ---- What the reader's rows look like -------------------------------------------
// The assistant reads values as PostgreSQL writes them: a timestamp stays
// "2026-09-01 10:00:00+03" in factory time rather than turning into a Date in
// the server's zone. Numbers and booleans become JSON numbers and booleans.
// These parsers belong to the reader's pools only; the API's own pool keeps
// its global ones (db/pool.ts).

const INTEGER_OIDS = new Set([20, 21, 23]) // int8, int2, int4
const DECIMAL_OIDS = new Set([700, 701, 1700]) // float4, float8, numeric
const BOOL_OID = 16
const JSON_OIDS = new Set([114, 3802]) // json, jsonb

const asText = (v: string) => v

function asNumber(integer: boolean) {
  return (v: string): number | string => {
    const n = Number(v)
    if (!Number.isFinite(n)) return v
    // A bigint past 2^53 or a long numeric would lose digits as a number: keep its text.
    if (integer && !Number.isSafeInteger(n)) return v
    return n
  }
}

function asJson(v: string): unknown {
  try {
    return JSON.parse(v)
  } catch {
    return v
  }
}

export const readerTypes: pg.CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: string) => {
    if (format === 'binary') return asText
    if (INTEGER_OIDS.has(oid)) return asNumber(true)
    if (DECIMAL_OIDS.has(oid)) return asNumber(false)
    if (oid === BOOL_OID) return (v: string) => v === 't'
    if (JSON_OIDS.has(oid)) return asJson
    return asText
  }) as pg.CustomTypesConfig['getTypeParser'],
}

/** A reader's connection string: the API's own, with the role and its password in place of the API's user. */
export function readerConnectionString(databaseUrl: string, role: string, password: string): string {
  const url = new URL(databaseUrl)
  url.username = encodeURIComponent(role)
  url.password = encodeURIComponent(password)
  return url.toString()
}

/**
 * Settings every session of a reader role starts with, as SQL (fixed text,
 * nothing from outside: search_path is a list, which a quoted string would
 * turn into one schema's name). The runner sets its own limits in each
 * transaction as well.
 */
const ROLE_SETTINGS = [
  'search_path = ai, pg_catalog',
  'default_transaction_read_only = on',
  `statement_timeout = '10s'`,
  `lock_timeout = '2s'`,
  `idle_in_transaction_session_timeout = '15s'`,
]

// ---- The readers ---------------------------------------------------------------

export class AiReader {
  /** The database the roles belong to; null until provisioned, and after a failure. */
  private database: string | null = null
  private config: Config | null = null
  /** Pools by combination (bits), made when first needed. */
  private pools = new Map<string, pg.Pool>()
  /** Why the readers could not be set up, for the log. */
  failure: string | null = null

  get ready(): boolean {
    return this.database !== null
  }

  /** The role that signs in for exactly these domains; null when not ready, or for no domain. */
  roleFor(domains: readonly AiDomain[]): string | null {
    if (!this.database || domains.length === 0) return null
    return combinationRole(this.database, domainBits(domains))
  }

  /** The pool that signs in as the role of exactly these domains; null when not ready, or for no domain. */
  poolFor(domains: readonly AiDomain[]): pg.Pool | null {
    const role = this.roleFor(domains)
    if (!role || !this.config) return null
    const bits = domainBits(domains)
    let pool = this.pools.get(bits)
    if (!pool) {
      pool = makePool(this.config, role)
      this.pools.set(bits, pool)
    }
    return pool
  }

  /** The role of every domain: what the owner's checks and the tests read through. */
  get role(): string | null {
    return this.roleFor(AI_DOMAIN_IDS)
  }

  /** The pool of every domain. Questions never use it: each runs as its asker's own domains. */
  get pool(): pg.Pool | null {
    return this.poolFor(AI_DOMAIN_IDS)
  }

  /**
   * Bring every combination role in line — LOGIN, its password, its domains
   * and nothing else, its settings and the factory's time zone — then prove
   * one can sign in. Idempotent: the API runs it at every start and the tests
   * after every reset. Never throws.
   */
  async provision(db: Db, config: Config): Promise<boolean> {
    await this.end()
    try {
      const { rows } = await db.query<{ database: string }>(`SELECT current_database() AS database`)
      const database = rows[0].database
      const domainRoles = (['base', ...AI_DOMAIN_IDS] as AiRoleDomain[]).map((d) => domainRole(database, d))
      const found = await db.query<{ rolname: string }>(`SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])`, [domainRoles])
      const missing = domainRoles.filter((r) => !found.rows.some((f) => f.rolname === r))
      if (missing.length > 0) throw new Error(`role ${missing[0]} does not exist (migration 0033 or 0041 has not run)`)
      // Every combination holds the schema: whatever in it everyone may use, every domain may use.
      const open = await openToEveryone(db)
      if (open) throw new Error(`${open} in schema ai can be used by every role; revoke it from PUBLIC in its migration and grant it to its domain`)

      const client = await db.connect()
      try {
        await client.query('BEGIN')
        await client.query('SELECT pg_advisory_xact_lock($1)', [PROVISION_LOCK_KEY])
        for (const bits of AI_DOMAIN_COMBINATIONS) await provisionCombination(client, database, bits, config)
        await client.query('COMMIT')
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw e
      } finally {
        client.release()
      }

      // One sign-in proves the passwords and the server's authentication take them.
      this.database = database
      this.config = config
      const probe = await this.pool!.connect()
      probe.release(true)
      this.failure = null
      // Not a reason to stop: the runner refuses them by name. But the database itself should, and the owner of the server should know.
      const byName = await readersByName(db)
      if (byName.length > 0) {
        console.warn(
          `[ai] every role may still use ${byName.join(', ')}: they read what planning cannot see. Only a superuser can take them from PUBLIC (migration 0072); the assistant's runner refuses them meanwhile.`,
        )
      }
      return true
    } catch (e) {
      await this.end()
      this.failure = e instanceof Error ? e.message : String(e)
      console.warn(`[ai] the assistant's database readers are not available: ${this.failure}`)
      return false
    }
  }

  async end(): Promise<void> {
    const pools = [...this.pools.values()]
    this.pools.clear()
    this.database = null
    this.config = null
    await Promise.all(pools.map((p) => p.end().catch(() => undefined)))
  }
}

/**
 * Something in schema ai that every role may use, or null. A function made
 * there can be run by everyone unless its migration revokes that (a default
 * set for one schema cannot): a domain's function would then be every
 * domain's. Views start with no grant, but one granted to PUBLIC counts too.
 */
async function openToEveryone(db: Db): Promise<string | null> {
  const { rows } = await db.query<{ name: string }>(
    `SELECT name FROM (
       SELECT 'function ' || p.oid::regprocedure::text AS name FROM pg_proc p
        WHERE p.pronamespace = 'ai'::regnamespace AND has_function_privilege('public', p.oid, 'EXECUTE')
       UNION ALL
       SELECT CASE c.relkind WHEN 'v' THEN 'view ' WHEN 'm' THEN 'view ' ELSE 'table ' END || c.oid::regclass::text FROM pg_class c
        WHERE c.relnamespace = 'ai'::regnamespace AND c.relkind IN ('r', 'v', 'm', 'p', 'f')
          AND has_table_privilege('public', c.oid, 'SELECT')) o
      ORDER BY name LIMIT 1`,
  )
  return rows[0]?.name ?? null
}

/**
 * PostgreSQL's own functions and views that read a table named in a string,
 * or run a query given as text (READS_BY_NAME), that every role may still use;
 * migration 0072 takes them from PUBLIC where it runs as a superuser.
 */
export async function readersByName(db: Db): Promise<string[]> {
  const { rows } = await db.query<{ name: string }>(
    `SELECT p.oid::regprocedure::text AS name FROM pg_proc p
      WHERE p.pronamespace = 'pg_catalog'::regnamespace AND p.proname = ANY($1::text[]) AND has_function_privilege('public', p.oid, 'EXECUTE')
        AND p.oid <> 'pg_catalog.ts_rewrite(tsquery, tsquery, tsquery)'::regprocedure
     UNION ALL
     SELECT c.oid::regclass::text FROM pg_class c
      WHERE c.relnamespace = 'pg_catalog'::regnamespace AND c.relname = ANY($2::text[]) AND has_table_privilege('public', c.oid, 'SELECT')
     ORDER BY 1`,
    [READS_BY_NAME.functions, READS_BY_NAME.views],
  )
  return rows.map((r) => r.name)
}

/** What migration 0072 takes from PUBLIC: the functions by name (ts_rewrite only in its form that runs a query), and the views. */
export const READS_BY_NAME = {
  functions: [
    'table_to_xml',
    'table_to_xmlschema',
    'table_to_xml_and_xmlschema',
    'query_to_xml',
    'query_to_xmlschema',
    'query_to_xml_and_xmlschema',
    'cursor_to_xml',
    'cursor_to_xmlschema',
    'schema_to_xml',
    'schema_to_xmlschema',
    'schema_to_xml_and_xmlschema',
    'database_to_xml',
    'database_to_xmlschema',
    'database_to_xml_and_xmlschema',
    'ts_stat',
    'ts_rewrite',
  ],
  views: ['pg_stats', 'pg_stats_ext', 'pg_stats_ext_exprs'],
} as const

/**
 * One combination role, as it must be. Utility statements take no
 * parameters: names and values are quoted here. Only what a role that may
 * create roles can change is touched; a role found with any power beyond
 * reading (made a superuser behind the API's back, say) fails the start.
 */
async function provisionCombination(client: pg.PoolClient, database: string, bits: string, config: Config): Promise<void> {
  const role = combinationRole(database, bits)
  const ident = pg.escapeIdentifier(role)
  const verifier = pg.escapeLiteral(scramVerifier(readerPassword(config.JWT_SECRET, role)))
  const existing = await client.query<{ oid: number; unsafe: boolean }>(
    `SELECT oid, (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls) AS unsafe FROM pg_roles WHERE rolname = $1`,
    [role],
  )
  if (existing.rows[0]?.unsafe) throw new Error(`role ${role} has more than read rights; fix it in the database`)
  if (existing.rows[0]) {
    await client.query(`ALTER ROLE ${ident} LOGIN INHERIT CONNECTION LIMIT ${CONNECTION_LIMIT} PASSWORD ${verifier}`)
  } else {
    await client.query(
      `CREATE ROLE ${ident} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT ${CONNECTION_LIMIT} PASSWORD ${verifier}`,
    )
  }

  // Its domains and nothing else: memberships it should not have go, the ones it lacks come.
  const wanted = (['base', ...domainsOfBits(bits)] as AiRoleDomain[]).map((d) => domainRole(database, d))
  const held = await client.query<{ rolname: string }>(
    `SELECT g.rolname FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = $1`,
    [role],
  )
  for (const { rolname } of held.rows) {
    if (!wanted.includes(rolname)) await client.query(`REVOKE ${pg.escapeIdentifier(rolname)} FROM ${ident}`)
  }
  for (const domain of wanted) {
    if (!held.rows.some((h) => h.rolname === domain)) await client.query(`GRANT ${pg.escapeIdentifier(domain)} TO ${ident}`)
  }
  // A membership someone else granted survives a REVOKE by the API (it only warns): then the role is not what it must be.
  const now = await client.query<{ rolname: string }>(
    `SELECT DISTINCT g.rolname FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = $1`,
    [role],
  )
  const extra = now.rows.find((h) => !wanted.includes(h.rolname))
  if (extra || now.rows.length !== wanted.length) {
    throw new Error(`role ${role} belongs to ${extra ? extra.rolname : 'other roles than its domains'}; fix it in the database`)
  }

  for (const setting of ROLE_SETTINGS) await client.query(`ALTER ROLE ${ident} SET ${setting}`)
  await client.query(`ALTER ROLE ${ident} SET timezone = ${pg.escapeLiteral(config.FACTORY_TIMEZONE)}`)
}

function makePool(config: Config, role: string): pg.Pool {
  const connectionString = readerConnectionString(config.DATABASE_URL, role, readerPassword(config.JWT_SECRET, role))
  const needsTls = /sslmode=require|\.postgres\.database\.azure\.com/i.test(config.DATABASE_URL)
  const pool = new pg.Pool({
    connectionString,
    max: POOL_MAX,
    ssl: needsTls ? { rejectUnauthorized: true } : undefined,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    // A backstop behind the statement timeout the runner sets (a long analysis's, AI_LONG_QUERY_TIMEOUT_MS, at most), a quarter of a minute later.
    query_timeout: AI_LONG_QUERY_TIMEOUT_MS + 15_000,
    application_name: 'qc-ai-reader',
    types: readerTypes,
  })
  // An idle connection the server closes must not take the process down.
  pool.on('error', (e) => console.warn('[ai] reader connection lost:', e.message))
  return pool
}
