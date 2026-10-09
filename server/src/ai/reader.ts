// ============================================================================
// §20 — the assistant's own way into the database: a role that may read the
// views in schema ai and nothing else.
//
// Migration 0031 creates the role (one per database, without LOGIN). Every
// start gives it LOGIN and a password derived from JWT_SECRET, so no extra
// secret has to be configured anywhere, and builds a small pool that signs in
// as it. The password reaches PostgreSQL only as a SCRAM verifier, never as
// plain text that could land in a statement log.
//
// When any of this fails the API still starts: the assistant reports itself
// unavailable ('reader-unavailable') and everything else works as before.
// ============================================================================

import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'
import pg from 'pg'
import type { Config } from '../config'
import type { Db } from '../db/pool'

/** Serialises concurrent starts: two instances altering one role at once can fail. Next to the migration lock (7_204_930_115). */
const PROVISION_LOCK_KEY = 7_204_930_116
/** The role's ceiling, also set by the migration; the pool stays well under it. */
const CONNECTION_LIMIT = 6
const POOL_MAX = 4

/** The password for a database's reader: stable for a given secret, different for every database. */
export function readerPassword(jwtSecret: string, database: string): string {
  return createHmac('sha256', jwtSecret).update(`qc-ai-reader:v1:${database}`).digest('base64url')
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
// These parsers belong to the reader's pool only; the API's own pool keeps its
// global ones (db/pool.ts).

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

/** The reader's connection string: the API's own, with the role and its password in place of the API's user. */
export function readerConnectionString(databaseUrl: string, role: string, password: string): string {
  const url = new URL(databaseUrl)
  url.username = encodeURIComponent(role)
  url.password = encodeURIComponent(password)
  return url.toString()
}

// ---- The reader --------------------------------------------------------------

export class AiReader {
  /** Signs in as the reader role; null until provisioned, and after a failure. */
  pool: pg.Pool | null = null
  role: string | null = null
  /** Why the reader could not be set up, for the log. */
  failure: string | null = null

  get ready(): boolean {
    return this.pool !== null
  }

  /**
   * Give the role LOGIN, its password and the factory's time zone, then build
   * the pool and prove it can sign in. Idempotent: the API runs it at every
   * start and the tests after every reset. Never throws.
   */
  async provision(db: Db, config: Config): Promise<boolean> {
    await this.end()
    try {
      const { rows } = await db.query<{ database: string; role: string; exists: boolean }>(
        `SELECT current_database() AS database, current_database() || '_ai_reader' AS role,
                EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_database() || '_ai_reader') AS exists`,
      )
      const { database, role, exists } = rows[0]
      if (!exists) throw new Error(`role ${role} does not exist (migration 0031 has not run)`)
      const password = readerPassword(config.JWT_SECRET, database)

      const client = await db.connect()
      try {
        await client.query('BEGIN')
        await client.query('SELECT pg_advisory_xact_lock($1)', [PROVISION_LOCK_KEY])
        // Utility statements take no parameters: the role and the values are quoted here.
        const ident = pg.escapeIdentifier(role)
        await client.query(`ALTER ROLE ${ident} LOGIN PASSWORD ${pg.escapeLiteral(scramVerifier(password))} CONNECTION LIMIT ${CONNECTION_LIMIT}`)
        await client.query(`ALTER ROLE ${ident} SET timezone = ${pg.escapeLiteral(config.FACTORY_TIMEZONE)}`)
        await client.query('COMMIT')
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw e
      } finally {
        client.release()
      }

      const connectionString = readerConnectionString(config.DATABASE_URL, role, password)
      const needsTls = /sslmode=require|\.postgres\.database\.azure\.com/i.test(config.DATABASE_URL)
      const pool = new pg.Pool({
        connectionString,
        max: POOL_MAX,
        ssl: needsTls ? { rejectUnauthorized: true } : undefined,
        idleTimeoutMillis: 10_000,
        connectionTimeoutMillis: 10_000,
        // A backstop behind the statement timeout the runner sets (30 s at most).
        query_timeout: 45_000,
        application_name: 'qc-ai-reader',
        types: readerTypes,
      })
      // An idle connection the server closes must not take the process down.
      pool.on('error', (e) => console.warn('[ai] reader connection lost:', e.message))
      try {
        const probe = await pool.connect()
        probe.release(true)
      } catch (e) {
        await pool.end().catch(() => undefined)
        throw e
      }
      this.pool = pool
      this.role = role
      this.failure = null
      return true
    } catch (e) {
      this.failure = e instanceof Error ? e.message : String(e)
      console.warn(`[ai] the assistant's database reader is not available: ${this.failure}`)
      return false
    }
  }

  async end(): Promise<void> {
    const pool = this.pool
    this.pool = null
    if (pool) await pool.end().catch(() => undefined)
  }
}
