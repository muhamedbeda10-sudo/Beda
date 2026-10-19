// ============================================================================
// Forward-only SQL migrations.
//
// Files in ../../migrations are applied in name order, each in its own
// transaction, and recorded in schema_migrations. An advisory lock makes it
// safe for several App Service instances to start at once: one applies, the
// others wait and find nothing left to do.
// ============================================================================

import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Db } from './pool'

/** Arbitrary but fixed — identifies "the QC migration lock" cluster-wide. */
const LOCK_KEY = 7_204_930_115

export interface AppliedMigration {
  version: string
  name: string
}

export function defaultMigrationsDir(): string {
  // Works both from src (tsx) and from the bundled dist/index.js: the
  // migrations folder sits next to `src` and next to `dist`.
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [path.resolve(here, '../../migrations'), path.resolve(here, '../migrations')]
  return candidates.find((c) => existsSync(c)) ?? candidates[0]
}

/**
 * The migration files, in order. A version is a file's four-digit prefix and
 * names one migration: two files with the same prefix (two branches that each
 * took the next number) would make one of them never run where the other
 * already had, and fail a fresh database on its key — so they stop the start
 * here, before anything is applied, naming both files.
 */
export async function listMigrationFiles(dir: string): Promise<{ version: string; name: string; file: string }[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (e) {
    throw new Error(`Migrations directory not found: ${dir}`)
  }
  const files = entries
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort()
    .map((f) => ({ version: f.slice(0, 4), name: f.slice(5, -4), file: path.join(dir, f) }))
  const seen = new Map<string, string>()
  for (const f of files) {
    const other = seen.get(f.version)
    if (other) {
      throw new Error(`Two migrations share version ${f.version}: ${path.basename(other)} and ${path.basename(f.file)}. Give one of them the next free number.`)
    }
    seen.set(f.version, f.file)
  }
  return files
}

export async function migrate(db: Db, dir = defaultMigrationsDir()): Promise<AppliedMigration[]> {
  // Read (and checked) before the database is touched.
  const files = await listMigrationFiles(dir)
  const client = await db.connect()
  const applied: AppliedMigration[] = []
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY])
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    text PRIMARY KEY,
        name       text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`)
    const done = new Set(
      (await client.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map((r) => r.version),
    )
    for (const m of files) {
      if (done.has(m.version)) continue
      const sql = await readFile(m.file, 'utf8')
      await client.query('BEGIN')
      try {
        await client.query(sql)
        await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [m.version, m.name])
        await client.query('COMMIT')
      } catch (e) {
        await client.query('ROLLBACK')
        throw new Error(`Migration ${m.version}_${m.name} failed: ${e instanceof Error ? e.message : String(e)}`)
      }
      applied.push({ version: m.version, name: m.name })
    }
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY])
    } finally {
      client.release()
    }
  }
  return applied
}
