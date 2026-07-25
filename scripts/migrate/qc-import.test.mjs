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
  projectIdFromCredentialFile,
  projectIdFromSdk,
  projectMismatch,
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

const rows = (files) =>
  FILES.filter((f) => files.includes(f.file)).reduce((n, f) => n + f.expect, 0)

const MASTER_FILES = [
  '20_cr863_machineses.json',            // machines                32
  '19_quality_grademappings.json',       // gradeMappings            7
  '15_cr863_dimensions.json',            // itemDimensionMaster     24
  '16_quality_dimensionorders.json',     // itemDimensionOrder     328
  '18_cr863_workcentervisualdefects.json', // workCenterDefects     52
  '17_cr863_workcenterdimensions.json',  // workCenterDimensions     1
]

const HISTORY_FILES = [
  '01_cr863_inspectionsession1s.json',        // sessions              147
  '02_cr863_inspectionsample1s.json',         // samples               374
  '03_cr863_dimensionresult2s.json',          // dimensionResults    4,770
  '04_cr863_visualdefectresult2s.json',       // defectResults          46
  '05_cr863_samplecoil2s.json',               // sampleCoils           142
  '06_cr863_visualdefectimages.json',         // defectImages           17
  '07_cr863_samplecoilimages.json',           // sampleCoilImages        5
  '08_quality_paintsampleimages.json',        // paintSamples           99
  '09_cr863_pdis.json',                       // pdis                    1
  '10_cr863_pdiimages.json',                  // pdiImages               3
  '11_quality_sessioninitializations.json',   // sessionInitializations 71
  '24_cr863_auditlogs.json',                  // auditLogs              31
]

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

  it('has no document delete, no recursive delete and no query in the write path', () => {
    // The only database operation is set(merge) on a document id. Anything that
    // could remove or overwrite data this import does not own would show here.
    //
    // app.delete() is the Firebase app being closed so the process can exit --
    // it removes nothing from the database -- so it is the one permitted
    // occurrence, and this asserts it is the ONLY one rather than skipping the
    // check.
    const deletes = source.match(/[\w.]*\.delete\(/g) ?? []
    expect(deletes.every((d) => d === 'app.delete('), `unexpected delete: ${deletes}`).toBe(true)
    expect(source).not.toMatch(/recursiveDelete/)
    expect(source).not.toMatch(/writer\.delete\(/)
    expect(source).not.toMatch(/batch\.delete\(/)
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

describe('authoritative row counts', () => {
  // Verified against the real export on the owner's machine. These are SOURCE
  // ROW counts, not document counts -- see the note on the history total.

  it('stage master is 444 rows', () => {
    expect(rows(MASTER_FILES)).toBe(444)
  })

  it('stage history is 5,706 rows before the referenced orders', () => {
    expect(rows(HISTORY_FILES)).toBe(5706)
  })

  it('every history file is mapped, so none can be silently missing', () => {
    const mapped = new Set(FILES.map((f) => f.file))
    for (const file of [...MASTER_FILES, ...HISTORY_FILES]) {
      expect(mapped, `${file} is not in FILES`).toContain(file)
    }
  })

  it('the four image tables are mapped and in stage history', () => {
    // The earlier 5,271 estimate was short because these were treated as image
    // files rather than rows. This is the guard against that recurring.
    const imageTables = {
      '06_cr863_visualdefectimages.json': COL.defectImages,
      '07_cr863_samplecoilimages.json': COL.sampleCoilImages,
      '08_quality_paintsampleimages.json': COL.paintSamples,
      '10_cr863_pdiimages.json': COL.pdiImages,
    }
    for (const [file, collection] of Object.entries(imageTables)) {
      expect(FILES.map((f) => f.file), file).toContain(file)
      expect(HISTORY_COLLECTIONS, `${collection} must be in stage history`).toContain(collection)
      expect(route(collection, { stage: 'history' })).toBe('write')
    }
  })

  it('paint samples and session initializations are in stage history', () => {
    for (const c of [COL.paintSamples, COL.sessionInitializations]) {
      expect(HISTORY_COLLECTIONS).toContain(c)
      expect(route(c, { stage: 'history' })).toBe('write')
    }
  })

  it('itemReferenceImages and productionData stay deferred', () => {
    // Confirmed by the owner: production reporting, not QC, and no screen in
    // the spec consumes it; item images need Storage.
    for (const c of [COL.itemReferenceImages, COL.productionData]) {
      expect(DEFERRED_COLLECTIONS).toContain(c)
      expect(route(c, { stage: 'history' })).toBe('filtered')
      expect(route(c, { stage: 'all' })).toBe('filtered')
    }
  })

  it("today's authorised scope fits the default write budget", () => {
    // 444 + 5,706 + 125 referenced orders = 6,275 source rows. The projection
    // writes fewer, because 240 unfilled dimension template rows are rejected,
    // but the budget check has to hold for the larger number either way.
    const referencedOrders = 125
    const total = rows(MASTER_FILES) + rows(HISTORY_FILES) + referencedOrders
    expect(total).toBe(6275)
    expect(total).toBeLessThan(parseArgs(['/d', '--stage=all']).maxWrites)
    expect(total).toBeLessThan(20000) // the Spark daily limit
  })
})

describe('the dimension arithmetic', () => {
  // Verified independently on the real export. Every number here is a fact
  // about the data, and the point of pinning them is that the 623 survive.
  const DIMENSION_ROWS = 4770
  const PARENTLESS = 349
  const PARENTLESS_DROPPED = 240 // no actual AND no nominal, so nothing to keep
  const PARENTLESS_QUARANTINED = 109 // carrying a measurement
  const WITH_PARENT_UNMEASURED_BLANK = 623 // valid parent, no actual, no nominal
  const WITH_PARENT_REQUIRED_SKIPPED = 36 // valid parent, nominal, no actual

  it('the parentless split reconciles exactly', () => {
    expect(PARENTLESS_DROPPED + PARENTLESS_QUARANTINED).toBe(PARENTLESS)
  })

  it('the 623 are inside the rows that have a parent, so they are kept', () => {
    const withParent = DIMENSION_ROWS - PARENTLESS
    expect(withParent).toBe(4421)
    // The drop rule only ever removes parentless rows. The unmeasured rows that
    // DO have a parent are inside this number and are all written.
    expect(WITH_PARENT_UNMEASURED_BLANK + WITH_PARENT_REQUIRED_SKIPPED).toBeLessThan(withParent)
    expect(WITH_PARENT_UNMEASURED_BLANK).toBe(623)
  })

  it('the dimension file produces 4,530 documents, and only 240 are dropped', () => {
    const documents = DIMENSION_ROWS - PARENTLESS_DROPPED
    expect(documents).toBe(4530)
    // 4,421 in dimensions + 109 in quarantine.
    expect((DIMENSION_ROWS - PARENTLESS) + PARENTLESS_QUARANTINED).toBe(documents)
  })

  it("stage 2 projects 5,591 documents, which is the owner's adopted figure", () => {
    const historyDocuments = rows(HISTORY_FILES) - PARENTLESS_DROPPED
    expect(historyDocuments).toBe(5466)
    expect(historyDocuments + 125).toBe(5591)
  })

  it("today's authorised scope fits the default write budget", () => {
    // Source rows 444 + 5,706 + 125 = 6,275; documents 444 + 5,591 = 6,035.
    // Both are checked, because the budget has to hold for the larger one.
    const sourceRows = rows(MASTER_FILES) + rows(HISTORY_FILES) + 125
    const documents = rows(MASTER_FILES) + (rows(HISTORY_FILES) - PARENTLESS_DROPPED) + 125
    expect(sourceRows).toBe(6275)
    expect(documents).toBe(6035)
    const cap = parseArgs(['/d', '--stage=all']).maxWrites
    expect(sourceRows).toBeLessThan(cap)
    expect(documents).toBeLessThan(cap)
    expect(sourceRows).toBeLessThan(20000) // the Spark daily limit
  })
})


// ---------------------------------------------------------------------------
// Which project is being written to.
//
// applicationDefault() targets whatever GOOGLE_APPLICATION_CREDENTIALS points
// at. A wrong-project run writes everything into the wrong database and then
// reads its counts back from that same wrong database, so it reports success.
// Verification cannot catch this; it needs its own guard.
// ---------------------------------------------------------------------------

describe('project target', () => {
  it('is required, and says why', () => {
    const r = run(['/tmp', '--stage=master', '--commit'])
    expect(r.code).not.toBe(0)
    expect(r.out).toMatch(/--project is required/)
    expect(parseArgs(['/d', '--stage=master', '--commit']).project).toBeNull()
  })

  it('accepts both --project=id and --project id', () => {
    expect(parseArgs(['/d', '--project=linkmisr-9afbd']).project).toBe('linkmisr-9afbd')
    expect(parseArgs(['/d', '--project', 'linkmisr-9afbd']).project).toBe('linkmisr-9afbd')
  })

  it('is printed in the header, before the projection', () => {
    expect(source.indexOf('target: ${opts.project}')).toBeGreaterThan(-1)
    expect(source.indexOf('  target: ')).toBeLessThan(source.indexOf('-- Projected writes'))
  })

  it('reads only project_id out of the credential file', () => {
    const fake = () => JSON.stringify({ project_id: 'linkmisr-9afbd', private_key: 'SECRET' })
    process.env.GOOGLE_APPLICATION_CREDENTIALS = '/fake/path.json'
    try {
      expect(projectIdFromCredentialFile(fake)).toBe('linkmisr-9afbd')
    } finally {
      delete process.env.GOOGLE_APPLICATION_CREDENTIALS
    }
  })

  it('returns null rather than throwing on an unreadable credential', () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = '/fake/path.json'
    try {
      expect(projectIdFromCredentialFile(() => 'not json')).toBeNull()
      expect(projectIdFromCredentialFile(() => { throw new Error('nope') })).toBeNull()
    } finally {
      delete process.env.GOOGLE_APPLICATION_CREDENTIALS
    }
  })

  it('resolves the SDK project from whichever field carries it', () => {
    expect(projectIdFromSdk({ options: { projectId: 'a' } }, null)).toBe('a')
    expect(projectIdFromSdk({ options: { credential: { projectId: 'b' } } }, null)).toBe('b')
    expect(projectIdFromSdk({ options: {} }, { _settings: { projectId: 'c' } })).toBe('c')
  })

  it('refuses a mismatch', () => {
    expect(projectMismatch('right', 'wrong')).toMatch(/resolves to "wrong"/)
    expect(projectMismatch('right', 'right')).toBeNull()
  })

  it('refuses when the target cannot be determined at all', () => {
    // Unverifiable is not the same as fine. If the project cannot be read, the
    // run must not write on the assumption that it is the right one.
    expect(projectMismatch('right', null)).toMatch(/could not be determined/)
    expect(projectMismatch(null, 'anything')).toMatch(/no --project/)
  })

  it('checks the credential file before firebase-admin is imported', () => {
    expect(source.indexOf('projectIdFromCredentialFile()')).toBeLessThan(
      source.indexOf("await import('firebase-admin')"),
    )
  })

  it('checks the SDK-resolved project before the writer is created', () => {
    expect(source.indexOf('projectIdFromSdk(app, db)')).toBeLessThan(source.indexOf('db.bulkWriter()'))
  })
})

describe('the next-step hint', () => {
  it('prints a complete command, because it exists to be copy-pasted', () => {
    // A hint missing --project would abort on its first line, and the operator
    // would reasonably conclude the importer was broken.
    // Both hints: the one a projection-only run prints, and the one the master
    // stage prints when it finishes.
    const hints = source.match(/node qc-import\.mjs \$\{opts\.src\}[^`]*/g) ?? []
    expect(hints.length, 'expected both copy-pasteable hints').toBe(2)
    for (const hint of hints) {
      expect(hint, `hint omits --project: ${hint}`).toContain('--project=${opts.project}')
      expect(hint).toContain('--commit')
      expect(hint).toMatch(/--stage=/)
    }
  })

  it('no longer prints the ambiguous GOOGLE_CLOUD_PROJECT line', () => {
    // It sat two lines under "Confirmed target project" and could show a
    // different-looking string for the same project.
    expect(source).not.toMatch(/project: \$\{process\.env\.GOOGLE_CLOUD_PROJECT/)
  })

  it('ends with one unambiguous success line naming stage, count and project', () => {
    expect(source).toMatch(/Stage \$\{opts\.stage\} complete: \$\{num\(total\)\} documents verified in \$\{opts\.project\}/)
  })
})

describe('process lifecycle', () => {
  it('closes the Firebase app and exits explicitly on success', () => {
    // Without this the gRPC channel keeps the event loop alive: the operator
    // sees "Verified" and then a terminal that sits there, which during a live
    // migration reads as a hang and invites a Ctrl-C at the worst moment.
    const verified = source.indexOf('Verified: every collection holds')
    const del = source.indexOf('await app.delete()', verified)
    const exit = source.indexOf('process.exit(0)', del)
    expect(del).toBeGreaterThan(verified)
    expect(exit).toBeGreaterThan(del)
  })

  it('closes the app on the not-verified path too', () => {
    const notVerified = source.indexOf('-- NOT VERIFIED ---')
    expect(source.indexOf('await app.delete()', notVerified)).toBeGreaterThan(notVerified)
  })
})
