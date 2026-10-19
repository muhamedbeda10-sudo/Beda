import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultMigrationsDir, listMigrationFiles, migrate } from '../src/db/migrate'
import type { Db } from '../src/db/pool'

// A migration's version is its file's four-digit prefix. Two files sharing
// one (two branches that each took the next number) stop the start before
// anything is applied, instead of one being skipped where the other ran, or
// a fresh database failing half-way on the version's key.

let dir: string | null = null
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = null
})

async function folder(files: string[]): Promise<string> {
  dir = await mkdtemp(path.join(os.tmpdir(), 'qc-migrations-'))
  for (const f of files) await writeFile(path.join(dir, f), 'SELECT 1;')
  return dir
}

describe('migration versions', () => {
  it('lists the migrations in order, each version once', async () => {
    const d = await folder(['0002_second.sql', '0001_first.sql', 'README.md', '0003_third.sql'])
    expect((await listMigrationFiles(d)).map((m) => [m.version, m.name])).toEqual([
      ['0001', 'first'],
      ['0002', 'second'],
      ['0003', 'third'],
    ])
  })

  it('refuses two files with one version, naming both, before anything is applied', async () => {
    const d = await folder(['0001_first.sql', '0002_mine.sql', '0002_theirs.sql'])
    await expect(listMigrationFiles(d)).rejects.toThrow('Two migrations share version 0002: 0002_mine.sql and 0002_theirs.sql. Give one of them the next free number.')
    // Nothing reaches the database: the refusal comes before the first query.
    const untouched = { connect: () => Promise.reject(new Error('the database was reached')) } as unknown as Db
    await expect(migrate(untouched, d)).rejects.toThrow(/Two migrations share version 0002/)
  })

  it('finds every migration of the repository under its own version', async () => {
    const files = (await readdir(defaultMigrationsDir())).filter((f) => f.endsWith('.sql'))
    // Every file is a migration the runner reads, and no prefix is taken twice.
    expect(files.filter((f) => !/^\d{4}_.+\.sql$/.test(f))).toEqual([])
    const versions = files.map((f) => f.slice(0, 4))
    expect(versions.filter((v, i) => versions.indexOf(v) !== i)).toEqual([])
    expect((await listMigrationFiles(defaultMigrationsDir())).length).toBe(files.length)
  })
})
