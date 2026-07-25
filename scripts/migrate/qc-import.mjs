#!/usr/bin/env node
// ============================================================================
// Dataverse -> Firestore : the real import.
//
//   npm i firebase-admin
//   export GOOGLE_APPLICATION_CREDENTIALS=/secure/path/serviceAccount.json
//   node qc-import.mjs /path/to/qc-migration/data --stage=master --commit
//
// Reads the same transforms as qc-dryrun.mjs, so what the dry run reported is
// exactly what gets written. There is no second mapping to drift.
//
// Safety properties, each enforced below and each covered by a test:
//
//   1. --commit is the only thing that enables writing. Every check runs, and
//      the process exits, before firebase-admin is imported. Without --commit
//      no credential is read, no app is initialised and no connection to
//      Firestore is opened.
//   2. The importer writes only to the collections in STAGES.all. Any document
//      routed anywhere else aborts the run. There is no delete, no collection
//      clear, no query: the only database operation is set(merge) on a
//      document whose id is a Dataverse GUID.
//   3. Document ids are the source GUIDs, so a second run rewrites the same
//      documents. Nothing duplicates, and an interrupted run is resumed by
//      running it again.
//   4. Files stream. The 46 MB export is never held in memory whole.
//   5. The service-account path comes from the environment. The key is never
//      read from source, never printed, never logged.
// ============================================================================

import path from 'node:path'
import { statSync, readFileSync, writeFileSync } from 'node:fs'
import { FILES, COL, streamRows } from './qc-dryrun.mjs'

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

/**
 * Master reference data: small, stable, and what every screen needs before any
 * inspection record makes sense. 444 documents.
 */
export const MASTER_COLLECTIONS = [
  COL.machines,
  COL.gradeMappings,
  COL.itemDimensionMaster,
  COL.itemDimensionOrder,
  COL.workCenterDefects,
  COL.workCenterDimensions,
]

/** The order and coil catalogues. The bulk of the row count, ~59,200 documents. */
export const CATALOGUE_COLLECTIONS = [
  COL.orders,
  COL.coils,
  COL.itemReferenceImages,
  COL.productionData,
]

/** Recorded inspection evidence, and the quarantine holding rows with no parent. */
export const EVIDENCE_COLLECTIONS = [
  COL.sessions,
  COL.samples,
  COL.dimensions,
  COL.defects,
  COL.sampleCoils,
  COL.pdi,
  COL.audit,
  COL.orphanMeasurements,
  COL.orphanSamples,
]

/**
 * `master` and `history` partition the data exactly, which is the property the
 * staged plan depends on: run master, then history, and nothing is left behind.
 * `catalogue` and `evidence` split history further for anyone who wants the two
 * large phases separately. They are optional, never a substitute for the pair.
 */
export const STAGES = {
  master: MASTER_COLLECTIONS,
  catalogue: CATALOGUE_COLLECTIONS,
  evidence: EVIDENCE_COLLECTIONS,
  history: [...CATALOGUE_COLLECTIONS, ...EVIDENCE_COLLECTIONS],
  all: [...MASTER_COLLECTIONS, ...CATALOGUE_COLLECTIONS, ...EVIDENCE_COLLECTIONS],
}

/** Collections whose documents reference a parent in another file. */
const NEEDS_PARENT_RESOLUTION = new Set([
  COL.sessions,
  COL.samples,
  COL.dimensions,
  COL.defects,
  COL.sampleCoils,
  COL.orphanMeasurements,
  COL.orphanSamples,
])

/**
 * Every collection the transforms can produce must belong to a stage.
 *
 * If a new collection is ever added to COL and not placed in a stage, a staged
 * run would silently skip it and the operator would believe the data was in.
 * This turns that into a startup failure instead.
 */
export function unstagedCollections() {
  const staged = new Set(STAGES.all)
  return Object.values(COL).filter((c) => !staged.has(c))
}

/**
 * Whether a document bound for `collection` is written by this run.
 *
 * Returns 'write', 'filtered' (out of stage or excluded by a flag), or
 * 'forbidden' (a collection this importer must never touch, which aborts).
 * Kept separate from main() so the routing that decides what the database
 * receives is testable without a database.
 */
export function route(collection, { stage = 'all', only = null, skip = new Set() } = {}) {
  if (!new Set(STAGES.all).has(collection)) return 'forbidden'
  if (!new Set(STAGES[stage] ?? []).has(collection)) return 'filtered'
  if (only && collection !== only) return 'filtered'
  if (skip.has(collection)) return 'filtered'
  return 'write'
}

// ---------------------------------------------------------------------------
// Progress log
// ---------------------------------------------------------------------------

const PROGRESS_FILE = 'qc-import-progress.json'

function readProgress(dir) {
  try {
    const raw = JSON.parse(readFileSync(path.join(dir, PROGRESS_FILE), 'utf8'))
    return {
      startedAt: raw.startedAt ?? null,
      stage: raw.stage ?? null,
      completedFiles: Array.isArray(raw.completedFiles) ? raw.completedFiles : [],
      queued: raw.queued && typeof raw.queued === 'object' ? raw.queued : {},
    }
  } catch {
    return null
  }
}

function writeProgress(dir, state) {
  try {
    writeFileSync(path.join(dir, PROGRESS_FILE), JSON.stringify(state, null, 2))
  } catch (e) {
    console.warn(`  (could not update ${PROGRESS_FILE}: ${e.message})`)
  }
}

// ---------------------------------------------------------------------------

const exists = (p) => {
  try {
    statSync(p)
    return true
  } catch {
    return false
  }
}
const num = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
const pad = (n, w = 9) => num(n).padStart(w)

const HELP = `
Dataverse -> Firestore import

  node qc-import.mjs <folder-with-the-json-files> --commit [options]

  --commit           required; without it nothing is written and no connection
                     to Firestore is opened
  --stage=<name>     master     the 444 reference documents (start here)
                     history    everything else
                     catalogue  orders and coils only, a subset of history
                     evidence   sessions and below, a subset of history
                     all        default
  --only <col>       restrict to one target collection
  --skip <col,col>   skip collections
  --resume           skip files already recorded complete in ${PROGRESS_FILE}
  --allow-existing   pass when a target collection already holds documents this
                     run did not write, so a surplus is not treated as a failure
  --verbose          print every failure

  Requires:  npm i firebase-admin
             GOOGLE_APPLICATION_CREDENTIALS=<path to service account json>

Run qc-dryrun.mjs first and read its report. This writes the same documents.

Re-running is safe. Document ids are the Dataverse GUIDs, so a second run
rewrites the same documents rather than creating new ones.
`

/**
 * `--flag value`, or null when the flag is absent.
 *
 * indexOf returns -1 for a missing flag, and argv[-1 + 1] is argv[0] -- the
 * source folder. Reading the value unconditionally therefore turned every run
 * without --only into "--only <the folder path>", which matches no collection,
 * so nothing was ever written. Hence the explicit presence check.
 */
export function flagValue(argv, flag) {
  const i = argv.indexOf(flag)
  if (i === -1 || i + 1 >= argv.length) return null
  const v = argv[i + 1]
  return v.startsWith('--') ? null : v
}

export function parseArgs(argv) {
  const stageArg = argv.find((a) => a.startsWith('--stage='))
  // A value belonging to --only or --skip is not the source folder, however the
  // arguments happen to be ordered.
  const consumed = new Set()
  for (const flag of ['--only', '--skip']) {
    const i = argv.indexOf(flag)
    if (i !== -1 && i + 1 < argv.length) consumed.add(i + 1)
  }
  return {
    src: argv.find((a, i) => !a.startsWith('--') && !consumed.has(i)),
    commit: argv.includes('--commit'),
    verbose: argv.includes('--verbose'),
    resume: argv.includes('--resume'),
    allowExisting: argv.includes('--allow-existing'),
    stage: stageArg ? stageArg.slice('--stage='.length) : 'all',
    only: flagValue(argv, '--only'),
    skip: new Set((flagValue(argv, '--skip') ?? '').split(',').filter(Boolean)),
  }
}

async function main() {
  const argv = process.argv.slice(2)
  const opts = parseArgs(argv)

  // ---- Guards --------------------------------------------------------------
  // Everything in this block runs before firebase-admin is imported, so a run
  // that fails any check never opens a connection to Firestore.

  if (!opts.src) {
    console.log(HELP)
    process.exit(1)
  }
  const dir = path.resolve(opts.src.replace(/^~/, process.env.HOME ?? '~'))
  if (!exists(dir)) {
    console.error(`\n  Folder not found: ${dir}\n`)
    process.exit(1)
  }
  if (!opts.commit) {
    console.error('\n  Refusing to write without --commit. Run qc-dryrun.mjs to preview.\n')
    process.exit(1)
  }
  if (!STAGES[opts.stage]) {
    console.error(
      `\n  Unknown stage "${opts.stage}". Choose one of: ${Object.keys(STAGES).join(', ')}\n`,
    )
    process.exit(1)
  }
  const orphaned = unstagedCollections()
  if (orphaned.length) {
    console.error(
      `\n  These collections belong to no stage: ${orphaned.join(', ')}\n` +
        '  A staged run would skip them without saying so. Add them to a stage\n' +
        '  in qc-import.mjs before running.\n',
    )
    process.exit(1)
  }
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.error(
      '\n  GOOGLE_APPLICATION_CREDENTIALS is not set.\n' +
        '  Point it at the service-account file, e.g.\n' +
        '    export GOOGLE_APPLICATION_CREDENTIALS=/secure/path/serviceAccount.json\n',
    )
    process.exit(1)
  }

  let admin
  try {
    admin = (await import('firebase-admin')).default
  } catch {
    console.error('\n  firebase-admin is not installed. Run:  npm i firebase-admin\n')
    process.exit(1)
  }

  // ---- Past this line, and only past this line, the process talks to Firestore.
  admin.initializeApp({ credential: admin.credential.applicationDefault() })
  const db = admin.firestore()
  // BulkWriter batches and retries internally, staying inside the 500-operation
  // limit without the caller chunking by hand.
  const writer = db.bulkWriter()

  const failures = []
  writer.onWriteError((err) => {
    if (err.failedAttempts < 4) return true // retry transient failures
    failures.push({ path: err.documentRef.path, message: err.message })
    return false
  })

  /** The complete set of collections this process may write to. */
  const inStage = new Set(STAGES[opts.stage])

  console.log(`\n  Dataverse -> Firestore -- COMMIT`)
  console.log(`  source: ${dir}`)
  console.log(`  stage:  ${opts.stage} (${inStage.size} collections)`)
  console.log(`  project: ${process.env.GOOGLE_CLOUD_PROJECT ?? '(from service account)'}\n`)

  // ---- Resume --------------------------------------------------------------
  const prior = readProgress(dir)
  const doneFiles = new Set()
  if (prior && opts.resume) {
    if (prior.stage !== opts.stage) {
      console.log(
        `  ${PROGRESS_FILE} is from stage "${prior.stage}", this run is "${opts.stage}".`,
      )
      console.log('  Ignoring it and starting this stage from the top.\n')
    } else {
      for (const f of prior.completedFiles) doneFiles.add(f)
      console.log(`  Resuming: ${doneFiles.size} file(s) already complete.\n`)
    }
  } else if (prior && !opts.resume) {
    console.log(`  A ${PROGRESS_FILE} from a previous run is present.`)
    console.log('  Starting from the top. That is safe -- the same ids are rewritten.')
    console.log('  Pass --resume to skip the files it records as complete.\n')
  }

  const progress = {
    startedAt: new Date().toISOString(),
    stage: opts.stage,
    completedFiles: [...doneFiles],
    queued: prior && opts.resume && prior.stage === opts.stage ? { ...prior.queued } : {},
  }

  // ---- Pre-pass ------------------------------------------------------------
  // Resolving parents means streaming every file, so it runs only when this
  // stage actually writes something that references a parent. A master-only
  // run skips it entirely.
  const needsPrePass = STAGES[opts.stage].some((c) => NEEDS_PARENT_RESOLUTION.has(c))

  const orderIds = new Set()
  const orderWorkCenter = new Map()
  const sessionIds = new Set()
  const sessionMeta = new Map()
  const sessionInspector = new Map()
  const sessionInit = new Map()
  const sampleIds = new Set()
  const sampleIndex = new Map()
  const dimensionSequence = new Map()
  const f = (n) => path.join(dir, n)

  if (needsPrePass) {
    console.log('  Resolving cross-file references...')
    if (exists(f('12_cr863_productionorder1s.json'))) {
      for await (const r of streamRows(f('12_cr863_productionorder1s.json'))) {
        const id = r.cr863_productionorder1id
        if (!id) continue
        orderIds.add(id)
        orderWorkCenter.set(id, String(r.cr863_workcenter ?? ''))
      }
    }
    if (exists(f('01_cr863_inspectionsession1s.json'))) {
      for await (const r of streamRows(f('01_cr863_inspectionsession1s.json'))) {
        const id = r.cr863_inspectionsession1id
        if (!id) continue
        sessionIds.add(id)
        sessionMeta.set(id, {
          orderId: r._cr863_productionorder_value ?? '',
          drawing: r.cr863_drawingno ?? '',
          issue: r.cr863_issueno ?? undefined,
        })
      }
    }
    if (exists(f('11_quality_sessioninitializations.json'))) {
      for await (const r of streamRows(f('11_quality_sessioninitializations.json'))) {
        const key = r.quality_sessionkey
        if (key && sessionIds.has(key)) sessionInit.set(key, r)
      }
    }
    if (exists(f('02_cr863_inspectionsample1s.json'))) {
      const bySession = new Map()
      for await (const r of streamRows(f('02_cr863_inspectionsample1s.json'))) {
        const id = r.cr863_inspectionsample1id
        if (!id) continue
        sampleIds.add(id)
        const sid = r._cr863_inspectionsession_value ?? ''
        const arr = bySession.get(sid) ?? []
        arr.push({ id, at: r.cr863_sampledatetime ?? r.createdon ?? '', name: r.cr863_inspectorname ?? '' })
        bySession.set(sid, arr)
      }
      for (const [sid, arr] of bySession) {
        arr.sort((a, b) => String(a.at).localeCompare(String(b.at)))
        arr.forEach((s, i) => sampleIndex.set(s.id, i + 1))
        const first = arr.find((s) => s.name)
        if (first) sessionInspector.set(sid, first.name)
      }
    }
    if (exists(f('03_cr863_dimensionresult2s.json'))) {
      const bySample = new Map()
      for await (const r of streamRows(f('03_cr863_dimensionresult2s.json'))) {
        const id = r.cr863_dimensionresult2id
        if (!id) continue
        const sid = r._cr863_inspectionsample_value ?? ''
        const n = (bySample.get(sid) ?? 0) + 1
        bySample.set(sid, n)
        dimensionSequence.set(id, n)
      }
    }
    console.log(
      `    orders ${num(orderIds.size)} - sessions ${num(sessionIds.size)} - samples ${num(sampleIds.size)}\n`,
    )
  }

  const counts = {}
  const ctx = {
    orderWorkCenter,
    session: sessionMeta,
    sessionInspector,
    sessionInit,
    sampleIndex,
    dimensionSequence,
    decodeFailure: () => {},
    count: (k) => (counts[k] = (counts[k] ?? 0) + 1),
  }

  const parentOf = {
    [COL.sessions]: (d) => orderIds.has(d.orderId),
    [COL.samples]: (d) => sessionIds.has(d.sessionId),
    [COL.dimensions]: (d) => sampleIds.has(d.sampleId),
    [COL.defects]: (d) => sampleIds.has(d.sampleId),
    [COL.sampleCoils]: (d) => sampleIds.has(d.sampleId),
  }

  // ---- Write ---------------------------------------------------------------
  const written = new Map(Object.entries(progress.queued))
  const skipped = { rejected: 0, dangling: 0, filtered: 0 }
  let queued = 0
  const started = Date.now()

  for (const spec of FILES) {
    const p = f(spec.file)
    if (!exists(p)) {
      console.log(`  ${spec.label.padEnd(22)} -- file missing, skipped`)
      continue
    }
    if (doneFiles.has(spec.file)) {
      console.log(`  ${spec.label.padEnd(22)} -- already complete, skipped`)
      continue
    }
    let n = 0
    for await (const row of streamRows(p)) {
      const out = spec.fn(row, ctx)
      if (out.reject) {
        skipped.rejected++
        continue
      }
      // Guard 2. A transform that ever routed a document outside the known set
      // would be writing somewhere nobody reviewed. Stop rather than write it.
      const decision = route(out.collection, opts)
      if (decision === 'forbidden') {
        throw new Error(
          `${spec.file} produced a document for "${out.collection}", which is not a ` +
            'collection this importer is allowed to write. Nothing further was written.',
        )
      }
      if (decision === 'filtered') {
        skipped.filtered++
        continue
      }
      const check = parentOf[out.collection]
      if (check && !check(out.doc)) {
        skipped.dangling++
        continue
      }
      // The Dataverse GUID is the document id, so this overwrites on a re-run
      // rather than creating a second copy.
      writer.set(db.collection(out.collection).doc(out.id), out.doc, { merge: true })
      written.set(out.collection, (written.get(out.collection) ?? 0) + 1)
      n++
      queued++
      if (queued % 5000 === 0) {
        process.stdout.write(`\r  queued ${num(queued)}...`)
        await writer.flush()
      }
    }
    process.stdout.write('\r')
    console.log(`  ${spec.label.padEnd(22)} ${pad(n)} queued`)

    // The file is only recorded complete after its writes are acknowledged, so
    // a --resume never skips a file whose documents never landed.
    await writer.flush()
    progress.completedFiles.push(spec.file)
    progress.queued = Object.fromEntries(written)
    writeProgress(dir, progress)
  }

  console.log('\n  Flushing...')
  await writer.close()
  const secs = ((Date.now() - started) / 1000).toFixed(1)

  // ---- Report --------------------------------------------------------------
  // On a resumed run these are cumulative for the stage, not just this pass --
  // which is what the verification below has to compare against.
  console.log('\n  -- Written per collection ----------------------------')
  let total = 0
  for (const [col, c] of [...written].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${col.padEnd(24)} ${pad(c)}`)
    total += c
  }
  console.log(`  ${'TOTAL'.padEnd(24)} ${pad(total)}   in ${secs}s`)

  const q = (written.get(COL.orphanMeasurements) ?? 0) + (written.get(COL.orphanSamples) ?? 0)
  if (q) {
    console.log(`\n  ${num(q)} rows are in quarantine and need a person to place them:`)
    if (written.get(COL.orphanMeasurements)) console.log(`    ${COL.orphanMeasurements}`)
    if (written.get(COL.orphanSamples)) console.log(`    ${COL.orphanSamples}`)
  }

  console.log('\n  -- Not written ---------------------------------------')
  console.log(`  rejected by the transform  ${pad(skipped.rejected)}`)
  console.log(`  dangling parent reference  ${pad(skipped.dangling)}`)
  if (skipped.filtered) console.log(`  outside this stage/filter  ${pad(skipped.filtered)}`)

  if (failures.length) {
    console.log('\n  -- Write failures ------------------------------------')
    console.log(`  ${num(failures.length)} documents could not be written after retries.`)
    for (const x of opts.verbose ? failures : failures.slice(0, 20)) {
      console.log(`    ${x.path} -- ${x.message}`)
    }
    if (!opts.verbose && failures.length > 20) {
      console.log(`    ... ${num(failures.length - 20)} more (--verbose)`)
    }
  }

  // ---- Verification --------------------------------------------------------
  // Queueing a write is not evidence that it landed. Read the count back from
  // Firestore for every collection this run touched and compare.
  //
  // What the comparison can and cannot prove:
  //   actual <  expected  writes are missing. Always a failure.
  //   actual >  expected  the collection holds documents this run did not
  //                       write. On a re-run that never happens, because the
  //                       ids are stable and get rewritten in place, so it
  //                       means pre-existing data. Reported, and a failure
  //                       unless --allow-existing says it is expected.
  console.log('\n  -- Verifying against Firestore -----------------------')
  const rows = []
  for (const [col, expected] of [...written].sort((a, b) => a[0].localeCompare(b[0]))) {
    let actual = null
    let error = null
    try {
      const snap = await db.collection(col).count().get()
      actual = snap.data().count
    } catch (e) {
      error = e.message
    }
    rows.push({ col, expected, actual, error })
  }

  console.log(`  ${'collection'.padEnd(24)}${'expected'.padStart(11)}${'actual'.padStart(11)}${'difference'.padStart(13)}`)
  let short = 0
  let surplus = 0
  let unreadable = 0
  for (const r of rows) {
    if (r.error) {
      unreadable++
      console.log(`  ${r.col.padEnd(24)}${pad(r.expected, 11)}${'unreadable'.padStart(11)}${'?'.padStart(13)}`)
      console.log(`      ${r.error}`)
      continue
    }
    const diff = r.actual - r.expected
    if (diff < 0) short++
    if (diff > 0) surplus++
    const shown = diff === 0 ? '0' : diff > 0 ? `+${num(diff)}` : `-${num(-diff)}`
    console.log(`  ${r.col.padEnd(24)}${pad(r.expected, 11)}${pad(r.actual, 11)}${shown.padStart(13)}`)
  }

  const problems = []
  // "Ran cleanly and wrote nothing" is a failure, not a success. It is what a
  // wrong folder, a wrong --stage or a wrong --only looks like.
  if (total === 0) problems.push('no documents were written at all')
  if (failures.length) problems.push(`${num(failures.length)} documents failed to write`)
  if (short) problems.push(`${short} collection(s) hold fewer documents than this run wrote`)
  if (unreadable) problems.push(`${unreadable} collection(s) could not be counted`)
  if (surplus && !opts.allowExisting) {
    problems.push(
      `${surplus} collection(s) hold documents this run did not write ` +
        '(pass --allow-existing if that is expected)',
    )
  } else if (surplus) {
    console.log('\n  Surplus documents accepted: --allow-existing was passed.')
  }

  if (problems.length) {
    console.log('\n  -- NOT VERIFIED --------------------------------------')
    for (const p of problems) console.log(`  ${p}`)
    console.log('\n  Re-run the import. Document ids are stable, so it retries')
    console.log('  what is missing without duplicating anything already written.')
    console.log(`  ${PROGRESS_FILE} records how far this run got; --resume uses it.\n`)
    process.exit(1)
  }

  console.log(
    surplus
      ? '\n  Verified: every document this run wrote is in Firestore.' +
          `\n  ${surplus} collection(s) also hold other documents, accepted via --allow-existing.`
      : '\n  Verified: every collection holds exactly what this run wrote.',
  )
  if (opts.stage === 'master') {
    console.log('  Next:  node qc-import.mjs <folder> --stage=history --commit')
  }
  console.log('\n  Images are not part of this pass -- 223 files upload separately.')
  console.log('  Re-running is safe: the same document ids are rewritten.\n')
}

// Only run when invoked directly, so the tests can import the stage tables.
if (process.argv[1] && process.argv[1].endsWith('qc-import.mjs')) {
  main().catch((e) => {
    console.error('\n  Import failed:', e.message)
    console.error(`  Re-running is safe. ${PROGRESS_FILE} records how far it got.\n`)
    process.exit(1)
  })
}
