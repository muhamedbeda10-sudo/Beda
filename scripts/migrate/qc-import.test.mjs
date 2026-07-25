// Tests for the properties the importer promises the operator, rather than for
// the transforms (those live in qc-dryrun.test.mjs). These are the claims the
// project owner is being asked to trust before running the thing against the
// real database, so each one is checked rather than asserted in a comment.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  STAGES,
  MASTER_COLLECTIONS,
  CATALOGUE_COLLECTIONS,
  EVIDENCE_COLLECTIONS,
  unstagedCollections,
  route,
  parseArgs,
  flagValue,
} from './qc-import.mjs'
import { COL, FILES } from './qc-dryrun.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const IMPORTER = path.join(here, 'qc-import.mjs')
const source = readFileSync(IMPORTER, 'utf8')

/** Run the importer and capture what it says, whatever exit code it uses. */
function run(args, env = {}) {
  try {
    const stdout = execFileSync('node', [IMPORTER, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, out: stdout }
  } catch (e) {
    return { code: e.status, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

describe('stages', () => {
  it('master is exactly the six reference collections', () => {
    expect([...MASTER_COLLECTIONS].sort()).toEqual(
      [
        COL.machines,
        COL.gradeMappings,
        COL.itemDimensionMaster,
        COL.itemDimensionOrder,
        COL.workCenterDefects,
        COL.workCenterDimensions,
      ].sort(),
    )
  })

  it('master and history partition the data, so the staged plan leaves nothing behind', () => {
    const union = [...STAGES.master, ...STAGES.history].sort()
    expect(union).toEqual([...STAGES.all].sort())
    // and they do not overlap, so nothing is written twice by the pair
    const overlap = STAGES.master.filter((c) => STAGES.history.includes(c))
    expect(overlap).toEqual([])
  })

  it('history is exactly catalogue plus evidence', () => {
    expect([...STAGES.history].sort()).toEqual(
      [...CATALOGUE_COLLECTIONS, ...EVIDENCE_COLLECTIONS].sort(),
    )
  })

  it('no stage lists the same collection twice', () => {
    for (const [name, cols] of Object.entries(STAGES)) {
      expect(new Set(cols).size, `stage ${name} has a duplicate`).toBe(cols.length)
    }
  })

  it('every collection the transforms can produce belongs to a stage', () => {
    // Guards against a new COL entry being added and silently skipped by a
    // staged run. The importer refuses to start if this is ever false.
    expect(unstagedCollections()).toEqual([])
  })

  it('quarantine collections are staged, so evidence with no parent is not left behind', () => {
    expect(STAGES.all).toContain(COL.orphanMeasurements)
    expect(STAGES.all).toContain(COL.orphanSamples)
  })
})

describe('write guards', () => {
  it('refuses to run without --commit', () => {
    const r = run(['/tmp'])
    expect(r.code).not.toBe(0)
    expect(r.out).toMatch(/Refusing to write without --commit/)
  })

  it('checks --commit before it ever reads a credential', () => {
    // No GOOGLE_APPLICATION_CREDENTIALS, no --commit: the --commit message is
    // the one that appears, which means the run stopped before the credential
    // was needed and therefore before any connection could be opened.
    const r = run(['/tmp'], { GOOGLE_APPLICATION_CREDENTIALS: '' })
    expect(r.out).toMatch(/Refusing to write without --commit/)
    expect(r.out).not.toMatch(/GOOGLE_APPLICATION_CREDENTIALS is not set/)
  })

  it('refuses to run without GOOGLE_APPLICATION_CREDENTIALS', () => {
    const r = run(['/tmp', '--commit'], { GOOGLE_APPLICATION_CREDENTIALS: '' })
    expect(r.code).not.toBe(0)
    expect(r.out).toMatch(/GOOGLE_APPLICATION_CREDENTIALS is not set/)
  })

  it('rejects an unknown stage before doing anything', () => {
    const r = run(['/tmp', '--commit', '--stage=everything'], {
      GOOGLE_APPLICATION_CREDENTIALS: '',
    })
    expect(r.code).not.toBe(0)
    expect(r.out).toMatch(/Unknown stage/)
    expect(r.out).toMatch(/master/)
  })

  it('rejects a missing source folder', () => {
    const r = run(['/nonexistent-folder-for-the-test', '--commit'])
    expect(r.code).not.toBe(0)
    expect(r.out).toMatch(/Folder not found/)
  })

  it('imports firebase-admin only after every guard has run', () => {
    const guardIdx = source.indexOf("Refusing to write without --commit")
    const credIdx = source.indexOf('GOOGLE_APPLICATION_CREDENTIALS is not set')
    const importIdx = source.indexOf("await import('firebase-admin')")
    const initIdx = source.indexOf('admin.initializeApp')
    expect(guardIdx).toBeGreaterThan(-1)
    expect(importIdx).toBeGreaterThan(guardIdx)
    expect(importIdx).toBeGreaterThan(credIdx)
    expect(initIdx).toBeGreaterThan(importIdx)
  })

  it('has no delete, no recursive delete and no query in the write path', () => {
    // The only database operation is set(merge) on a document id. Anything that
    // could remove or overwrite data this import does not own would show here.
    expect(source).not.toMatch(/\.delete\(/)
    expect(source).not.toMatch(/recursiveDelete/)
    expect(source).not.toMatch(/bulkWriter\(\)[\s\S]*?\.where\(/)
    expect(source).toMatch(/writer\.set\(/)
  })

  it('aborts if a transform ever routes a document outside the staged collections', () => {
    expect(route('someOtherCollection')).toBe('forbidden')
    expect(route('users')).toBe('forbidden')
    expect(source).toMatch(/decision === 'forbidden'/)
    expect(source).toMatch(/Nothing further was written/)
  })
})

describe('routing', () => {
  it('a master run writes the six reference collections and nothing else', () => {
    for (const c of MASTER_COLLECTIONS) {
      expect(route(c, { stage: 'master' }), c).toBe('write')
    }
    for (const c of STAGES.history) {
      expect(route(c, { stage: 'master' }), c).toBe('filtered')
    }
  })

  it('a history run writes everything a master run did not', () => {
    for (const c of STAGES.history) {
      expect(route(c, { stage: 'history' }), c).toBe('write')
    }
    for (const c of MASTER_COLLECTIONS) {
      expect(route(c, { stage: 'history' }), c).toBe('filtered')
    }
  })

  it('master then history covers every collection exactly once', () => {
    for (const c of STAGES.all) {
      const written = ['master', 'history'].filter((s) => route(c, { stage: s }) === 'write')
      expect(written.length, `${c} written by ${written.join(' and ') || 'no stage'}`).toBe(1)
    }
  })

  it('--only narrows within the stage and never widens it', () => {
    expect(route(COL.machines, { stage: 'master', only: COL.machines })).toBe('write')
    expect(route(COL.gradeMappings, { stage: 'master', only: COL.machines })).toBe('filtered')
    // --only cannot pull in a collection the stage excludes
    expect(route(COL.orders, { stage: 'master', only: COL.orders })).toBe('filtered')
  })

  it('--skip removes a collection from the run', () => {
    expect(route(COL.machines, { stage: 'master', skip: new Set([COL.machines]) })).toBe('filtered')
  })
})

describe('argument parsing', () => {
  it('does not treat the source folder as an --only value', () => {
    // The regression this guards: indexOf('--only') is -1 when the flag is
    // absent, and argv[-1 + 1] is argv[0], the folder. Every run without --only
    // became "--only /path/to/data", which matches no collection, so the
    // importer filtered out every document and wrote nothing.
    const opts = parseArgs(['/path/to/data', '--commit'])
    expect(opts.only).toBeNull()
    expect(opts.skip.size).toBe(0)
    expect(route(COL.machines, opts)).toBe('write')
  })

  it('reads --only and --skip when they are actually given', () => {
    const opts = parseArgs(['/data', '--commit', '--only', 'machines', '--skip', 'orders,coils'])
    expect(opts.only).toBe('machines')
    expect([...opts.skip].sort()).toEqual(['coils', 'orders'])
    expect(opts.src).toBe('/data')
  })

  it('finds the source folder however the flags are ordered', () => {
    expect(parseArgs(['--only', 'orders', '/data', '--commit']).src).toBe('/data')
    expect(parseArgs(['--skip', 'coils', '/data', '--commit']).src).toBe('/data')
  })

  it('treats a flag following --only as a missing value, not as the value', () => {
    expect(flagValue(['--only', '--commit'], '--only')).toBeNull()
    expect(flagValue(['--only'], '--only')).toBeNull()
  })

  it('defaults to the all stage', () => {
    expect(parseArgs(['/data', '--commit']).stage).toBe('all')
    expect(parseArgs(['/data', '--commit', '--stage=master']).stage).toBe('master')
  })
})

describe('the 444', () => {
  it('the master files account for 444 source rows', () => {
    // The number quoted in the staged plan. If the mapping ever changes which
    // files feed master, this fails rather than quietly moving the target.
    const masterFiles = [
      '15_cr863_dimensions.json',
      '16_quality_dimensionorders.json',
      '17_cr863_workcenterdimensions.json',
      '18_cr863_workcentervisualdefects.json',
      '19_quality_grademappings.json',
      '20_cr863_machineses.json',
    ]
    const total = FILES.filter((f) => masterFiles.includes(f.file)).reduce((n, f) => n + f.expect, 0)
    expect(total).toBe(444)
  })
})

describe('verification', () => {
  it('reads the count back from Firestore rather than trusting the queue', () => {
    expect(source).toMatch(/\.count\(\)\.get\(\)/)
  })

  it('exits non-zero when a collection holds fewer documents than were written', () => {
    expect(source).toMatch(/if \(diff < 0\) short\+\+/)
    expect(source).toMatch(/fewer documents than this run wrote/)
    expect(source).toMatch(/process\.exit\(1\)/)
  })

  it('treats writing nothing as a failure', () => {
    expect(source).toMatch(/no documents were written at all/)
  })

  it('prints expected, actual and difference per collection', () => {
    expect(source).toMatch(/'expected'/)
    expect(source).toMatch(/'actual'/)
    expect(source).toMatch(/'difference'/)
  })
})

describe('resume', () => {
  it('records a file as complete only after its writes are flushed', () => {
    const flushIdx = source.indexOf('await writer.flush()\n    progress.completedFiles.push')
    expect(flushIdx).toBeGreaterThan(-1)
  })

  it('ignores a progress file written by a different stage', () => {
    expect(source).toMatch(/prior\.stage !== opts\.stage/)
  })
})
