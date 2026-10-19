// ============================================================================
// PostgreSQL connection pool and the transaction helper every write uses.
// ============================================================================

import pg from 'pg'

const { Pool, types } = pg

// numeric → number. Measurements are stored exactly in the database; the API
// hands them to JavaScript as numbers, which is what every screen expects.
types.setTypeParser(1700, (v) => (v === null ? null : Number(v)))
// int8 (count(*), bigserial) → number. Counts in this system never approach 2^53.
types.setTypeParser(20, (v) => (v === null ? null : Number(v)))
// timestamptz → ISO-8601 string, so a timestamp reads the same in the API, in
// JSON and in the client, and string comparisons of two timestamps are valid.
types.setTypeParser(1184, (v) => (v === null ? null : new Date(v).toISOString()))

export type Db = pg.Pool
export type Queryable = pg.Pool | pg.PoolClient

export function createPool(connectionString: string, max: number): pg.Pool {
  const needsTls = /sslmode=require|\.postgres\.database\.azure\.com/i.test(connectionString)
  return new Pool({
    connectionString,
    max,
    // Azure Database for PostgreSQL enforces TLS. Its certificate chains to a
    // public CA (DigiCert), so full verification works without a custom bundle.
    ssl: needsTls ? { rejectUnauthorized: true } : undefined,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: 'qc-api',
  })
}

/**
 * Run `fn` inside one transaction. Commits when it resolves, rolls back when it
 * throws. Serializable is not needed: every write that must be exclusive takes
 * a row lock (`SELECT … FOR UPDATE`) on the parent it appends to.
 */
export async function withTransaction<T>(db: Db, fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (e) {
    try {
      await client.query('ROLLBACK')
    } catch {
      /* the connection is gone; releasing it below discards it */
    }
    throw e
  } finally {
    client.release()
  }
}

/** PostgreSQL error codes the API translates into HTTP responses. */
export const PG = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
  RESTRICT_VIOLATION: '23001',
  /** Two transactions waited on each other; the database rolled one back. Sent again, it goes through. */
  DEADLOCK_DETECTED: '40P01',
  /** A transaction could not go on as written (a serializable conflict, or a guard that asks for another isolation). */
  SERIALIZATION_FAILURE: '40001',
} as const

export function pgCode(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : undefined
}
