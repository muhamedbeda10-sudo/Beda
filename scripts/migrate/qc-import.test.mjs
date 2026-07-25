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
  HISTORY_COLLECTIONS,
  DEFERRED_COLLECTIONS,
  WRITABLE_COLLECTIONS,
  unstagedCollections,
  route,
  keepDocument,
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

  it('history carries the inspection evidence, the quarantine and orders', () => {
    for (const c of [
      COL.sessions,
      COL.samples,
      COL.dimensions,
      COL.defects,
      COL.sampleCoils,
      COL.pdi,
      COL.audit,
      COL.orphanMeasurements,
      COL.orphanSamples,
      COL.orders,
    ]) {
      expect(HISTORY_COLLECTIONS, `history should include ${c}`).toContain(c)
    }
  })

  it('the bulk catalogues are deferred, not in master or history', () => {
    for (const c of [COL.coils, COL.itemReferenceImages, COL.productionData]) {
      expect(DEFERRED_COLLECTIONS, `${c} should be deferred`).toContain(c)
      expect(MASTER_COLLECTIONS).not.toContain(c)
      expect(HISTORY_COLLECTIONS).not.toContain(c)
    }
  })

  it('the three stages cover every writable collection', () => {
    const union = [
      ...new Set([...MASTER_COLLECTIONS, ...HISTORY_COLLECTIONS, ...DEFERRED_COLLECTIONS]),
    ].sort()
    expect(union).toEqual([...WRITABLE_COLLECTIONS].sort())
  })

  it('orders is the only collection two stages share, and it is split by row', () => {
    const shared = WRITABLE_COLLECTIONS.filter((c) => {
      const n = [MASTER_COLLECTIONS, HISTORY_COLLECTIONS, DEFERRED_COLLECTIONS].filter((s) =>
        s.includes(c),
      ).length
      return n > 1
    })
    expect(shared).toEqual([COL.orders])
  })

  it('all is master plus history, not everything in the file', () => {
    expect([...STAGES.all].sort()).toEqual(
      [...new Set([...MASTER_COLLECTIONS, ...HISTORY_COLLECTIONS])].sort(),
    )
    expect(STAGES.all).not.toContain(COL.coils)
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
})

describe('order selection', () => {
  const referenced = new Set(['ord-a', 'ord-b'])
  const opts = { stage: 'history', referencedOrders: referenced }

  it('history takes only the orders the history rows reference', () => {
    expect(keepDocument(COL.orders, { id: 'ord-a' }, opts)).toBe(true)
    expect(keepDocument(COL.orders, { id: 'ord-zzz' }, opts)).toBe(false)
  })

  it('deferred takes exactly the orders history did not', () => {
    const d = { stage: 'deferred', referencedOrders: referenced }
    expect(keepDocument(COL.orders, { id: 'ord-a' }, d)).toBe(false)
    expect(keepDocument(COL.orders, { id: 'ord-zzz' }, d)).toBe(true)
  })

  it('history and deferred together cover every order exactly once', () => {
    const all = ['ord-a', 'ord-b', 'ord-c', 'ord-d']
    for (const id of all) {
      const taken = ['history', 'deferred'].filter((stage) =>
        keepDocument(COL.orders, { id }, { stage, referencedOrders: referenced }),
      )
      expect(taken.length, `${id} taken by ${taken.join(' and ') || 'no stage'}`).toBe(1)
    }
  })

  it('leaves every other collection whole', () => {
    for (const c of WRITABLE_COLLECTIONS) {
      if (c === COL.orders) continue
      expect(keepDocument(c, { id: 'anything' }, opts), c).toBe(true)
    }
  })

  it('derives the referenced set at run time, never from a hardcoded list', () => {
    // A literal GUID list in the source would be the failure mode here.
    expect(source).toMatch(/referencedOrders\.add\(orderId\)/)
    expect(source).not.toMatch(/const REFERENCED_ORDERS\s*=\s*\[/)
    expect(source).toMatch(/_cr863_productionorder_value/)
  })
})

describe('write guards', () => {
  it('requires --stage, with no default', () => {
    const r = run(['/tmp', '--commit'])
    expect(r.code).not.toBe(0)
    expect(r.out).toMatch(/--stage is required/)
    expect(parseArgs(['/data', '--commit']).stage).toBeNull()
  })

  it('rejects an unknown stage before doing anything', () => {
    const r = run(['/tmp', '--commit', '--stage=everything'])
    expect(r.code).not.toBe(0)
    expect(r.out).toMatch(/Unknown stage/)
    expect(r.out).toMatch(/master/)
  })

  it('rejects a missing source folder', () => {
    const r = run(['/nonexistent-folder-for-the-test', '--commit', '--stage=master'])
    expect(r.code).not.toBe(0)
    expect(r.out).toMatch(/Folder not found/)
  })

  it('imports firebase-admin only after the projection has been printed', () => {
    const projIdx = source.indexOf('-- Projected writes')
    const budgetIdx = source.indexOf('REFUSING TO START')
    const commitIdx = source.indexOf("Stopping here: --commit was not given")
    const credIdx = source.indexOf('GOOGLE_APPLICATION_CREDENTIALS is not set')
    const importIdx = source.indexOf("await import('firebase-admin')")
    const initIdx = source.indexOf('admin.initializeApp')
    for (const [name, idx] of Object.entries({ projIdx, budgetIdx, commitIdx, credIdx })) {
      expect(idx, name).toBeGreaterThan(-1)
      expect(importIdx, `firebase-admin imported before ${name}`).toBeGreaterThan(idx)
    }
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

  it('aborts if a transform ever routes a document outside the writable set', () => {
    expect(route('someOtherCollection', { stage: 'all' })).toBe('forbidden')
    expect(route('users', { stage: 'all' })).toBe('forbidden')
    expect(source).toMatch(/decision === 'forbidden'/)
    expect(source).toMatch(/Nothing further was written/)
  })

  it('lists every collection it can write to in its own help text', () => {
    const r = run([])
    for (const c of WRITABLE_COLLECTIONS) {
      expect(r.out, `help should name ${c}`).toContain(c)
    }
  })
})

describe('write budget', () => {
  it('defaults to 18000, under the Spark plan daily limit of 20000', () => {
    expect(parseArgs(['/data', '--stage=master', '--commit']).maxWrites).toBe(18000)
  })

  it('reads an explicit --max-writes', () => {
    expect(parseArgs(['/data', '--stage=master', '--max-writes', '500']).maxWrites).toBe(500)
  })

  it('refuses to start when the projection exceeds the limit', () => {
    expect(source).toMatch(/remainingTotal > opts\.maxWrites/)
    expect(source).toMatch(/REFUSING TO START/)
    // and the refusal happens before firebase-admin is imported
    expect(source.indexOf('REFUSING TO START')).toBeLessThan(
      source.indexOf("await import('firebase-admin')"),
    )
  })

  it('projects and writes from one code path, so the number is the number', () => {
    // Two implementations would let the projection and the write drift apart.
    const uses = source.match(/documentsToWrite\(/g) ?? []
    expect(uses.length).toBe(3) // the definition, the projection, the write
  })
})

describe('routing', () => {
  it('a master run writes the six reference collections and nothing else', () => {
    for (const c of MASTER_COLLECTIONS) {
      expect(route(c, { stage: 'master' }), c).toBe('write')
    }
    for (const c of HISTORY_COLLECTIONS) {
      expect(route(c, { stage: 'master' }), c).toBe('filtered')
    }
    for (const c of DEFERRED_COLLECTIONS) {
      expect(route(c, { stage: 'master' }), c).toBe('filtered')
    }
  })

  it('a history run writes the evidence, and not the master data', () => {
    for (const c of HISTORY_COLLECTIONS) {
      expect(route(c, { stage: 'history' }), c).toBe('write')
    }
    for (const c of MASTER_COLLECTIONS) {
      expect(route(c, { stage: 'history' }), c).toBe('filtered')
    }
  })

  it('never writes the deferred catalogues in master or history', () => {
    for (const c of [COL.coils, COL.itemReferenceImages, COL.productionData]) {
      expect(route(c, { stage: 'master' }), c).toBe('filtered')
      expect(route(c, { stage: 'history' }), c).toBe('filtered')
      expect(route(c, { stage: 'all' }), c).toBe('filtered')
    }
  })

  it('writes nothing at all without a stage', () => {
    for (const c of WRITABLE_COLLECTIONS) {
      expect(route(c, {}), c).toBe('filtered')
    }
  })

  it('--only narrows within the stage and never widens it', () => {
    expect(route(COL.machines, { stage: 'master', only: COL.machines })).toBe('write')
    expect(route(COL.gradeMappings, { stage: 'master', only: COL.machines })).toBe('filtered')
    // --only cannot pull in a collection the stage excludes
    expect(route(COL.coils, { stage: 'master', only: COL.coils })).toBe('filtered')
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
    const opts = parseArgs(['/path/to/data', '--stage=master', '--commit'])
    expect(opts.only).toBeNull()
    expect(opts.skip.size).toBe(0)
    expect(route(COL.machines, opts)).toBe('write')
  })

  it('reads --only, --skip and --max-writes when they are actually given', () => {
    const opts = parseArgs([
      '/data', '--stage=history', '--commit',
      '--only', 'sessions', '--skip', 'defects,samples', '--max-writes', '9000',
    ])
    expect(opts.only).toBe('sessions')
    expect([...opts.skip].sort()).toEqual(['defects', 'samples'])
    expect(opts.maxWrites).toBe(9000)
    expect(opts.src).toBe('/data')
  })

  it('finds the source folder however the flags are ordered', () => {
    expect(parseArgs(['--only', 'orders', '/data', '--commit']).src).toBe('/data')
    expect(parseArgs(['--max-writes', '100', '/data', '--commit']).src).toBe('/data')
  })

  it('treats a flag following --only as a missing value, not as the value', () => {
    expect(flagValue(['--only', '--commit'], '--only')).toBeNull()
    expect(flagValue(['--only'], '--only')).toBeNull()
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

  it('exits non-zero when the written count differs from the projection', () => {
    expect(source).toMatch(/wrote a different count than projected/)
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
    const flushIdx = source.indexOf('await writer.flush()\n      progress.completedFiles.push')
    expect(flushIdx).toBeGreaterThan(-1)
  })

  it('ignores a progress file written by a different stage', () => {
    expect(source).toMatch(/prior\.stage !== opts\.stage/)
  })
})

describe('the 444', () => {
  it('the master files account for 444 source rows', () => {
    // The number in the staged plan. If the mapping ever changes which files
    // feed master, this fails rather than quietly moving the target.
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
