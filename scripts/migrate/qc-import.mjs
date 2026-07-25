#!/usr/bin/env node
// ============================================================================
// Dataverse -> Firestore : the real import.
//
//   npm i firebase-admin
//   export GOOGLE_APPLICATION_CREDENTIALS=/secure/path/serviceAccount.json
//   node qc-import.mjs /path/to/data --stage=master --project=linkmisr-9afbd --commit
//
// Reads the same transforms as qc-dryrun.mjs, so what the dry run reported is
// exactly what gets written. There is no second mapping to drift.
//
// Safety properties, each enforced below and each covered by a test:
//
//   1. --commit is the only thing that enables writing. Every check, and the
//      whole projection pass, runs before firebase-admin is imported. Without
//      --commit no credential is read, no app is initialised, and no connection
//      to Firestore is opened. A run without it reads local files and prints.
//   2. The importer writes only to the collections in STAGES.all. Any document
//      routed anywhere else aborts the run. There is no delete, no collection
//      clear, no query: the only database operation is set(merge) on a
//      document whose id is a Dataverse GUID.
//   3. Document ids are the source GUIDs, so a second run rewrites the same
//      documents. Nothing duplicates, and an interrupted run is resumed by
//      running it again.
//   4. Nothing is written until the run has counted what it would write and
//      shown the number. A projection above --max-writes refuses to start,
//      which is what keeps a staged run inside the Spark daily write quota.
//   5. Files stream. The 46 MB export is never held in memory whole.
//   6. The service-account path comes from the environment. The key is never
//      read from source, never printed, never logged. Only its project_id is
//      read out of it, to check the target.
//   7. The target project is asserted, twice, before the first write: once from
//      the credential file and once from what the SDK resolved. Writing to the
//      wrong project is the one failure the verification pass cannot catch,
//      because it would read its counts back from that same wrong project.
// ============================================================================

import path from 'node:path'
import { statSync, readFileSync, writeFileSync } from 'node:fs'
import { FILES, COL, streamRows, strOrNull, numOrNull } from './qc-dryrun.mjs'

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

/**
 * Recorded inspection evidence, the quarantine holding rows with no parent, and
 * the production orders those rows actually point at.
 *
 * Orders are in this stage by row, not by collection. The export holds 28,871
 * of them; the 147 sessions reference far fewer. Only the referenced ones come
 * across, and the set is derived from the history rows at run time -- never
 * hardcoded, never the whole file. See referencedOrderIds() below.
 */
export const HISTORY_COLLECTIONS = [
  COL.sessions,
  COL.samples,
  COL.dimensions,
  COL.defects,
  COL.sampleCoils,
  COL.pdi,
  COL.audit,
  COL.orphanMeasurements,
  COL.orphanSamples,
  // The paint inspection record, and the per-session setup record.
  COL.paintSamples,
  COL.sessionInitializations,
  // Image metadata. The rows come across now; the bytes stay in SharePoint
  // until Cloud Storage exists, which is what imagePending marks.
  COL.defectImages,
  COL.sampleCoilImages,
  COL.pdiImages,
  COL.orders,
]

/**
 * Held back deliberately. The project is on the Spark plan: 20,000 writes a day
 * and no Cloud Storage, so the bulk catalogues and every image wait for a day
 * of their own or for a Blaze upgrade.
 *
 * Orders appear here too, as the complement of the referenced set: whatever
 * `history` did not take.
 */
export const DEFERRED_COLLECTIONS = [
  COL.orders,
  COL.coils,
  COL.itemReferenceImages,
  COL.productionData,
]

/**
 * `master`, `history` and `deferred` partition the data: every document the
 * transforms can produce belongs to exactly one of them, orders included, and
 * that is asserted by a test rather than claimed here.
 *
 * There is no default. Choosing the stage is the whole point of staging, and a
 * default would be the one that quietly writes 65,000 documents.
 */
export const STAGES = {
  master: MASTER_COLLECTIONS,
  history: HISTORY_COLLECTIONS,
  deferred: DEFERRED_COLLECTIONS,
  /** Today's authorised scope: master + history. Not "everything in the file". */
  all: [...new Set([...MASTER_COLLECTIONS, ...HISTORY_COLLECTIONS])],
}

/** Every collection this process may write to, whatever the stage. */
export const WRITABLE_COLLECTIONS = [
  ...new Set([...MASTER_COLLECTIONS, ...HISTORY_COLLECTIONS, ...DEFERRED_COLLECTIONS]),
].sort()

/** Collections whose documents reference a parent in another file. */
const NEEDS_PARENT_RESOLUTION = new Set([
  COL.sessions,
  COL.samples,
  COL.dimensions,
  COL.defects,
  COL.sampleCoils,
  COL.orphanMeasurements,
  COL.orphanSamples,
  COL.paintSamples,
  COL.sessionInitializations,
  COL.defectImages,
  COL.sampleCoilImages,
  COL.pdiImages,
])

/**
 * Every collection the transforms can produce must belong to a stage.
 *
 * If a new collection is ever added to COL and not placed in a stage, a staged
 * run would silently skip it and the operator would believe the data was in.
 * This turns that into a startup failure instead.
 */
export function unstagedCollections() {
  const staged = new Set(WRITABLE_COLLECTIONS)
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
export function route(collection, { stage = null, only = null, skip = new Set() } = {}) {
  if (!WRITABLE_COLLECTIONS.includes(collection)) return 'forbidden'
  if (!stage || !STAGES[stage]) return 'filtered'
  if (!STAGES[stage].includes(collection)) return 'filtered'
  if (only && collection !== only) return 'filtered'
  if (skip.has(collection)) return 'filtered'
  return 'write'
}

/**
 * The row-level half of routing, for collections a stage takes only part of.
 *
 * Only orders are split this way: `history` takes the ones the inspection rows
 * reference, `deferred` takes the remainder. Every other collection is taken
 * whole by whichever stage lists it.
 */
export function keepDocument(collection, doc, { stage, referencedOrders = new Set() } = {}) {
  if (collection !== COL.orders) return true
  if (stage === 'history' || stage === 'all') return referencedOrders.has(doc.id)
  if (stage === 'deferred') return !referencedOrders.has(doc.id)
  return true
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

const DEFAULT_MAX_WRITES = 18000

const HELP = `
Dataverse -> Firestore import

  node qc-import.mjs <folder> --stage=<name> --project=<id> --commit [options]

  --project=<id>     REQUIRED. The Firebase project this run may write to. The
                     run aborts before the first write if the credential
                     resolves to anything else. Without it the target is
                     whatever GOOGLE_APPLICATION_CREDENTIALS points at, and a
                     wrong-project run would still report success -- the one
                     failure the verification pass cannot catch.
  --stage=<name>     REQUIRED. There is no default.
                     master    the 444 reference documents (start here)
                     history   inspection evidence, plus only the production
                               orders those rows actually reference
                     all       master + history, today's authorised scope
                     deferred  the bulk catalogues held back for a later day:
                               the remaining orders, coils, item reference
                               images, production data. Image BYTES are a
                               separate pass; the image metadata rows are in
                               stage history already.
  --commit           required to write. Without it this counts what it would
                     write, prints the projection, and stops. No credential is
                     read and no connection to Firestore is opened.
  --max-writes <n>   refuse to start if the projection exceeds this.
                     Default ${DEFAULT_MAX_WRITES}, which leaves headroom under the Spark
                     free plan's 20,000 writes per day.
  --only <col>       restrict to one target collection, within the stage
  --skip <col,col>   skip collections
  --resume           skip files already recorded complete in ${PROGRESS_FILE}
  --allow-existing   accept collections that already hold documents this run
                     did not write, instead of treating that as a failure
  --verbose          print every failure

  Requires (only when --commit is given):
             npm i firebase-admin
             GOOGLE_APPLICATION_CREDENTIALS=<path to service account json>

Run qc-dryrun.mjs first and read its report. This writes the same documents.

Re-running is safe. Document ids are the Dataverse GUIDs, so a second run
rewrites the same documents rather than creating new ones.

Collections this script is capable of writing to, and no others:
${WRITABLE_COLLECTIONS.map((c) => `  ${c}`).join('\n')}
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
  // `--flag=value` first, so the form used in the help text works.
  const inline = argv.find((a) => a.startsWith(`${flag}=`))
  if (inline) {
    const v = inline.slice(flag.length + 1)
    return v === '' ? null : v
  }
  const i = argv.indexOf(flag)
  if (i === -1 || i + 1 >= argv.length) return null
  const v = argv[i + 1]
  return v.startsWith('--') ? null : v
}

export function parseArgs(argv) {
  const stage = flagValue(argv, '--stage')
  // A value belonging to a value-taking flag is not the source folder, however
  // the arguments happen to be ordered.
  const consumed = new Set()
  for (const flag of ['--only', '--skip', '--max-writes', '--project', '--stage']) {
    const i = argv.indexOf(flag)
    if (i !== -1 && i + 1 < argv.length) consumed.add(i + 1)
  }
  const maxRaw = flagValue(argv, '--max-writes')
  return {
    src: argv.find((a, i) => !a.startsWith('--') && !consumed.has(i)),
    commit: argv.includes('--commit'),
    verbose: argv.includes('--verbose'),
    resume: argv.includes('--resume'),
    allowExisting: argv.includes('--allow-existing'),
    stage,
    maxWrites: maxRaw === null ? DEFAULT_MAX_WRITES : Number(maxRaw),
    project: flagValue(argv, '--project'),
    only: flagValue(argv, '--only'),
    skip: new Set((flagValue(argv, '--skip') ?? '').split(',').filter(Boolean)),
  }
}

// ---------------------------------------------------------------------------
// Which project is being written to
// ---------------------------------------------------------------------------

/**
 * The project id the credential file names.
 *
 * This is the one failure mode the whole design cannot otherwise catch.
 * applicationDefault() writes to whatever GOOGLE_APPLICATION_CREDENTIALS points
 * at. Point it at the wrong service-account file and the run writes 6,275
 * documents into the wrong project, then reads the counts back from that same
 * wrong project and reports "Verified: every collection holds exactly what this
 * run wrote" -- because from its own point of view it did. Verification cannot
 * see this. So the target is asserted separately, before the first write.
 *
 * Only `project_id` is read out of the file. Nothing else from it is returned,
 * printed or logged.
 */
export function projectIdFromCredentialFile(readFile = readFileSync) {
  const p = process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (!p) return null
  try {
    const parsed = JSON.parse(readFile(p, 'utf8'))
    return typeof parsed.project_id === 'string' ? parsed.project_id : null
  } catch {
    // Unreadable or not a service-account JSON (a gcloud ADC file, say). The
    // caller falls back to what the SDK resolves, and refuses if neither works.
    return null
  }
}

/** What the initialised SDK believes it is talking to. */
export function projectIdFromSdk(app, db) {
  return (
    app?.options?.projectId ||
    app?.options?.credential?.projectId ||
    db?._settings?.projectId ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCLOUD_PROJECT ||
    null
  )
}

/**
 * Compare what was asked for against what was resolved.
 * Returns null when the run may proceed, or the reason it must not.
 */
export function projectMismatch(expected, resolved, { source = 'the credential' } = {}) {
  if (!expected) return 'no --project was given'
  if (!resolved) {
    return (
      'the target project could not be determined from ' +
      `${source}, so it cannot be checked against --project=${expected}`
    )
  }
  if (resolved !== expected) {
    return `${source} resolves to "${resolved}", but --project says "${expected}"`
  }
  return null
}

// ---------------------------------------------------------------------------
// Reading the export
// ---------------------------------------------------------------------------

/**
 * Resolve everything that needs more than one file to decide, and derive the
 * set of production orders the inspection rows actually reference.
 *
 * The referenced set is built from the history rows themselves: the order a
 * session points at, the order behind each sample's session, and the order on
 * each PDI. Nothing here is hardcoded, and the full orders file is read only to
 * learn which ids exist -- reading is free, writing is what is being limited.
 */
async function resolveReferences(dir, { log = console.log } = {}) {
  const f = (n) => path.join(dir, n)
  const orderIds = new Set()
  const orderWorkCenter = new Map()
  const sessionIds = new Set()
  const sessionMeta = new Map()
  const sessionInspector = new Map()
  const sessionInit = new Map()
  const sampleIds = new Set()
  const sampleIndex = new Map()
  const dimensionSequence = new Map()
  const referencedOrders = new Set()
  const referencedBy = { sessions: 0, samples: 0, pdi: 0 }
  let sessionsWithNoOrder = 0
  // Parents for the four image tables, so a dangling image row is caught rather
  // than written against a record that does not exist.
  const defectIds = new Set()
  const sampleCoilIds = new Set()
  const pdiIds = new Set()

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
      const orderId = r._cr863_productionorder_value ?? ''
      sessionMeta.set(id, {
        orderId,
        drawing: r.cr863_drawingno ?? '',
        issue: r.cr863_issueno ?? undefined,
      })
      if (orderId) {
        if (!referencedOrders.has(orderId)) referencedBy.sessions++
        referencedOrders.add(orderId)
      } else {
        sessionsWithNoOrder++
      }
    }
  }
  if (exists(f('11_quality_sessioninitializations.json'))) {
    for await (const r of streamRows(f('11_quality_sessioninitializations.json'))) {
      const key = r.quality_sessionkey
      if (key && sessionIds.has(key)) sessionInit.set(key, r)
    }
  }
  // Denormalised child counts, computed from the rows already being streamed.
  // The history list reads them instead of fetching children per row.
  const samplesPerSession = new Map()
  const dimensionsPerSample = new Map()
  const measuredDimensionsPerSample = new Map()
  const defectsPerSample = new Map()
  const coilsPerSample = new Map()
  const tick = (m, k) => { if (k) m.set(k, (m.get(k) ?? 0) + 1) }
  if (exists(f('02_cr863_inspectionsample1s.json'))) {
    const bySession = new Map()
    for await (const r of streamRows(f('02_cr863_inspectionsample1s.json'))) {
      const id = r.cr863_inspectionsample1id
      if (!id) continue
      sampleIds.add(id)
      tick(samplesPerSession, r._cr863_inspectionsession_value ?? '')
      const sid = r._cr863_inspectionsession_value ?? ''
      // A sample inherits its order from its session, so this adds nothing a
      // session did not already contribute -- unless a sample points at a
      // session that itself is missing, which is worth knowing about.
      const viaSession = sessionMeta.get(sid)?.orderId
      if (viaSession && !referencedOrders.has(viaSession)) {
        referencedBy.samples++
        referencedOrders.add(viaSession)
      }
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
  if (exists(f('09_cr863_pdis.json'))) {
    for await (const r of streamRows(f('09_cr863_pdis.json'))) {
      const orderId = r._cr863_productionorder_value ?? ''
      if (orderId && !referencedOrders.has(orderId)) {
        referencedBy.pdi++
        referencedOrders.add(orderId)
      }
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
      tick(dimensionsPerSample, sid)
      // Counted separately so a row the inspector opened and never measured
      // stays visible as unmeasured instead of reading as work completed.
      if (numOrNull(r.cr863_actual) !== null) tick(measuredDimensionsPerSample, sid)
    }
  }

  // One pass over the three parent tables: collect their ids for the image
  // dangling checks, and count defects and coils per sample for the
  // denormalised totals. Both files link to the sample by
  // _cr863_inspectionsample_value.
  for (const [file, key, into, perSample] of [
    ['04_cr863_visualdefectresult2s.json', 'cr863_visualdefectresult2id', defectIds, defectsPerSample],
    ['05_cr863_samplecoil2s.json', 'cr863_samplecoil2id', sampleCoilIds, coilsPerSample],
    ['09_cr863_pdis.json', 'cr863_pdiid', pdiIds, null],
  ]) {
    if (!exists(f(file))) continue
    for await (const r of streamRows(f(file))) {
      if (r[key]) into.add(r[key])
      if (perSample) tick(perSample, strOrNull(r._cr863_inspectionsample_value))
    }
  }

  const missing = [...referencedOrders].filter((id) => !orderIds.has(id))

  log(
    `    orders in file ${num(orderIds.size)} - sessions ${num(sessionIds.size)} - samples ${num(sampleIds.size)}`,
  )
  log(
    `    orders referenced by the history rows: ${num(referencedOrders.size)}` +
      ` (${referencedBy.sessions} via sessions, ${referencedBy.samples} via samples, ${referencedBy.pdi} via PDI)`,
  )
  if (sessionsWithNoOrder) {
    log(`    ${num(sessionsWithNoOrder)} session(s) have no order link`)
  }
  if (missing.length) {
    log(`    ${num(missing.length)} referenced order(s) are NOT in the export:`)
    for (const id of missing.slice(0, 10)) log(`      ${id}`)
    if (missing.length > 10) log(`      ... ${num(missing.length - 10)} more`)
  }

  return {
    orderIds,
    orderWorkCenter,
    samplesPerSession,
    dimensionsPerSample,
    measuredDimensionsPerSample,
    defectsPerSample,
    coilsPerSample,
    defectIds,
    sampleCoilIds,
    pdiIds,
    sessionIds,
    sessionMeta,
    sessionInspector,
    sessionInit,
    sampleIds,
    sampleIndex,
    dimensionSequence,
    referencedOrders,
    referencedBy,
    sessionsWithNoOrder,
    missingReferencedOrders: missing,
  }
}

/**
 * Every document this run would write, in file order.
 *
 * Projection and the write pass both consume this, so the number printed before
 * writing and the documents actually written come from one piece of code. A
 * projection computed by a second implementation would be worth nothing.
 */
async function* documentsToWrite(dir, refs, opts, tally) {
  const ctx = {
    orderWorkCenter: refs.orderWorkCenter,
    session: refs.sessionMeta,
    sessionInspector: refs.sessionInspector,
    sessionInit: refs.sessionInit,
    sampleIndex: refs.sampleIndex,
    dimensionSequence: refs.dimensionSequence,
    samplesPerSession: refs.samplesPerSession,
    dimensionsPerSample: refs.dimensionsPerSample,
    measuredDimensionsPerSample: refs.measuredDimensionsPerSample,
    defectsPerSample: refs.defectsPerSample,
    coilsPerSample: refs.coilsPerSample,
    // transformSessionInitialization joins on quality_sessionkey, so it needs
    // the session ids to know which of the 71 rows resolve.
    sessionIds: refs.sessionIds,
    decodeFailure: () => {},
    count: () => {},
    resolvedColumn: (file, kind, key) => tally.resolvedColumns.add(`${file} -> ${kind}: ${key ?? '(none found)'}`),
  }

  const parentOf = {
    [COL.sessions]: (d) => refs.orderIds.has(d.orderId),
    [COL.samples]: (d) => refs.sessionIds.has(d.sessionId),
    [COL.dimensions]: (d) => refs.sampleIds.has(d.sampleId),
    [COL.defects]: (d) => refs.sampleIds.has(d.sampleId),
    [COL.sampleCoils]: (d) => refs.sampleIds.has(d.sampleId),
    [COL.paintSamples]: (d) => refs.sampleIds.has(d.sampleId),
    [COL.defectImages]: (d) => refs.defectIds.has(d.defectId),
    [COL.sampleCoilImages]: (d) => refs.sampleCoilIds.has(d.sampleCoilId),
    [COL.pdiImages]: (d) => refs.pdiIds.has(d.pdiId),
    // A session initialisation that does not resolve is imported flagged, not
    // dropped, so it deliberately has no parent check.
  }

  for (const spec of FILES) {
    const p = path.join(dir, spec.file)
    if (!exists(p)) {
      tally.missingFiles.push(spec.file)
      continue
    }
    let n = 0
    for await (const row of streamRows(p)) {
      const out = spec.fn(row, ctx)
      if (out.reject) {
        tally.rejected++
        continue
      }
      const decision = route(out.collection, opts)
      if (decision === 'forbidden') {
        throw new Error(
          `${spec.file} produced a document for "${out.collection}", which is not a ` +
            'collection this importer is allowed to write. Nothing further was written.',
        )
      }
      if (decision === 'filtered') {
        tally.filtered++
        continue
      }
      if (!keepDocument(out.collection, out.doc, { stage: opts.stage, referencedOrders: refs.referencedOrders })) {
        tally.notReferenced++
        continue
      }
      const check = parentOf[out.collection]
      if (check && !check(out.doc)) {
        tally.dangling++
        continue
      }
      n++
      yield { file: spec.file, collection: out.collection, id: out.id, doc: out.doc }
    }
    yield { fileComplete: spec.file, count: n }
  }
}

function freshTally() {
  return {
    rejected: 0,
    filtered: 0,
    dangling: 0,
    notReferenced: 0,
    missingFiles: [],
    resolvedColumns: new Set(),
  }
}

// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2)
  const opts = parseArgs(argv)

  // ---- Guards --------------------------------------------------------------
  // Everything from here to the projection runs on local files only. No
  // credential is read and firebase-admin is not imported until after the
  // projection has been printed and accepted.

  if (!opts.src) {
    console.log(HELP)
    process.exit(1)
  }
  const dir = path.resolve(opts.src.replace(/^~/, process.env.HOME ?? '~'))
  if (!exists(dir)) {
    console.error(`\n  Folder not found: ${dir}\n`)
    process.exit(1)
  }
  if (!opts.stage) {
    console.error(
      `\n  --stage is required. Choose one of: ${Object.keys(STAGES).join(', ')}\n` +
        '  There is no default, because the default would be the run that writes\n' +
        '  everything.\n',
    )
    process.exit(1)
  }
  if (!STAGES[opts.stage]) {
    console.error(
      `\n  Unknown stage "${opts.stage}". Choose one of: ${Object.keys(STAGES).join(', ')}\n`,
    )
    process.exit(1)
  }
  if (!opts.project) {
    console.error(
      '\n  --project is required. It names the Firebase project this run may\n' +
        '  write to, and the run aborts if the credential resolves to any other.\n\n' +
        '    node qc-import.mjs <folder> --stage=master --project=linkmisr-9afbd --commit\n\n' +
        '  Without it, the target is whatever GOOGLE_APPLICATION_CREDENTIALS happens\n' +
        '  to point at, and a wrong-project run would still report success.\n',
    )
    process.exit(1)
  }
  if (!Number.isFinite(opts.maxWrites) || opts.maxWrites <= 0) {
    console.error('\n  --max-writes must be a positive number.\n')
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

  console.log(`\n  Dataverse -> Firestore`)
  console.log(`  source: ${dir}`)
  console.log(`  stage:  ${opts.stage} -> ${STAGES[opts.stage].join(', ')}`)
  console.log(`  target: ${opts.project}`)
  console.log(`  mode:   ${opts.commit ? 'COMMIT' : 'projection only (no --commit)'}\n`)

  // ---- Resume --------------------------------------------------------------
  const prior = readProgress(dir)
  const doneFiles = new Set()
  if (prior && opts.resume) {
    if (prior.stage !== opts.stage) {
      console.log(`  ${PROGRESS_FILE} is from stage "${prior.stage}", this run is "${opts.stage}".`)
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

  // ---- Resolve references --------------------------------------------------
  console.log('  Resolving cross-file references...')
  const refs = await resolveReferences(dir)
  console.log('')

  // ---- Projection ----------------------------------------------------------
  // Count what would be written before writing any of it. This is the same code
  // path the write pass uses, so the number is the number.
  console.log('  Counting what this stage would write...')
  const projTally = freshTally()
  const projected = new Map()
  const projectedRemaining = new Map()
  for await (const item of documentsToWrite(dir, refs, opts, projTally)) {
    if (item.fileComplete) continue
    projected.set(item.collection, (projected.get(item.collection) ?? 0) + 1)
    if (!doneFiles.has(item.file)) {
      projectedRemaining.set(item.collection, (projectedRemaining.get(item.collection) ?? 0) + 1)
    }
  }

  const projectedTotal = [...projected.values()].reduce((a, b) => a + b, 0)
  const remainingTotal = [...projectedRemaining.values()].reduce((a, b) => a + b, 0)

  console.log('\n  -- Projected writes ----------------------------------')
  for (const [col, c] of [...projected].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${col.padEnd(24)} ${pad(c)}`)
  }
  console.log(`  ${'TOTAL'.padEnd(24)} ${pad(projectedTotal)}`)
  if (remainingTotal !== projectedTotal) {
    console.log(`  ${'this run (after resume)'.padEnd(24)} ${pad(remainingTotal)}`)
  }
  if (projected.has(COL.orders)) {
    console.log(
      `\n  Orders: ${num(projected.get(COL.orders))} of ${num(refs.orderIds.size)} in the file,` +
        ' selected because the inspection rows reference them.',
    )
  }

  console.log('\n  -- Not written ---------------------------------------')
  console.log(`  rejected by the transform  ${pad(projTally.rejected)}`)
  console.log(`  dangling parent reference  ${pad(projTally.dangling)}`)
  if (projTally.notReferenced) {
    console.log(`  orders no history row uses ${pad(projTally.notReferenced)}`)
  }
  if (projTally.filtered) console.log(`  outside this stage/filter  ${pad(projTally.filtered)}`)
  if (projTally.missingFiles.length) {
    console.log(`  source files not present   ${pad(projTally.missingFiles.length)}`)
    for (const mf of projTally.missingFiles) console.log(`    ${mf}`)
  }

  // The four image tables were mapped after the rest of the export was known,
  // and Dataverse is not consistent about whether a parent link is a lookup or
  // a text column holding the GUID. Each transform accepts more than one
  // spelling; this reports which one the real data actually used, before
  // anything is written, so a wrong assumption is visible rather than silent.
  if (projTally.resolvedColumns.size) {
    console.log('\n  -- Resolved link columns -----------------------------')
    let unresolved = 0
    for (const line of [...projTally.resolvedColumns].sort()) {
      const bad = line.endsWith('(none found)')
      if (bad) unresolved++
      console.log(`  ${bad ? '!' : ' '} ${line}`)
    }
    if (unresolved) {
      console.error(
        `\n  REFUSING TO START.\n` +
          `  ${unresolved} link(s) resolved to no column at all. Those rows would be\n` +
          '  written with an empty parent reference, which is evidence pointing at\n' +
          '  nothing. Add the real column name to the transform first.\n',
      )
      process.exit(1)
    }
  }

  // ---- Budget --------------------------------------------------------------
  if (remainingTotal > opts.maxWrites) {
    console.error(
      `\n  REFUSING TO START.\n` +
        `  This run would write ${num(remainingTotal)} documents, over the --max-writes\n` +
        `  limit of ${num(opts.maxWrites)}. The Spark free plan allows 20,000 writes a day.\n\n` +
        '  Either pick a smaller --stage, or raise --max-writes deliberately if the\n' +
        '  project is on a plan that can take it.\n',
    )
    process.exit(1)
  }
  console.log(
    `\n  Within budget: ${num(remainingTotal)} writes, limit ${num(opts.maxWrites)}.`,
  )

  if (projectedTotal === 0) {
    console.error('\n  Nothing to write for this stage. Check --stage, --only and the folder.\n')
    process.exit(1)
  }

  if (!opts.commit) {
    console.log('\n  Stopping here: --commit was not given, so nothing was written.')
    console.log('  No credential was read and no connection to Firestore was opened.')
    // Complete, including --project: this line exists to be copy-pasted, and a
    // command missing it aborts on its first check.
    console.log('\n  To write this stage:')
    console.log(
      `    node qc-import.mjs ${opts.src} --stage=${opts.stage} --project=${opts.project} --commit\n`,
    )
    process.exit(0)
  }

  // ---- Credentials ---------------------------------------------------------
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.error(
      '\n  GOOGLE_APPLICATION_CREDENTIALS is not set.\n' +
        '  Point it at the service-account file, e.g.\n' +
        '    export GOOGLE_APPLICATION_CREDENTIALS=/secure/path/serviceAccount.json\n',
    )
    process.exit(1)
  }

  // The credential file names its own project. Checking it here means a
  // wrong-project run stops before firebase-admin is even loaded.
  const fileProject = projectIdFromCredentialFile()
  if (fileProject) {
    const bad = projectMismatch(opts.project, fileProject, {
      source: 'the service-account file',
    })
    if (bad) {
      console.error(
        `\n  WRONG PROJECT. ${bad}.\n\n` +
          '  Nothing was written and no connection was opened. Check\n' +
          '  GOOGLE_APPLICATION_CREDENTIALS, or --project if the target really\n' +
          '  has changed.\n',
      )
      process.exit(1)
    }
    console.log(`  Service-account file targets ${fileProject}, which matches --project.`)
  }

  let admin
  try {
    admin = (await import('firebase-admin')).default
  } catch {
    console.error('\n  firebase-admin is not installed. Run:  npm i firebase-admin\n')
    process.exit(1)
  }

  // ---- Past this line, and only past this line, the process talks to Firestore.
  const app = admin.initializeApp({ credential: admin.credential.applicationDefault() })
  const db = admin.firestore()

  // Second check, on what the initialised SDK actually resolved. The file check
  // above covers a service-account JSON; this covers every other way the
  // credential chain can pick a project, and it runs before the first write.
  const sdkProject = projectIdFromSdk(app, db)
  const bad = projectMismatch(opts.project, sdkProject, { source: 'the initialised SDK' })
  if (bad) {
    console.error(
      `\n  WRONG PROJECT. ${bad}.\n\n` +
        '  Aborting before the first write. Nothing was written.\n',
    )
    await app.delete().catch(() => {})
    process.exit(1)
  }
  console.log(`  Confirmed target project: ${sdkProject}`)
  // BulkWriter batches and retries internally, staying inside the 500-operation
  // limit without the caller chunking by hand.
  const writer = db.bulkWriter()

  const failures = []
  writer.onWriteError((err) => {
    if (err.failedAttempts < 4) return true // retry transient failures
    failures.push({ path: err.documentRef.path, message: err.message })
    return false
  })

  console.log('\n  Writing...\n')

  const progress = {
    startedAt: new Date().toISOString(),
    stage: opts.stage,
    completedFiles: [...doneFiles],
    queued: prior && opts.resume && prior.stage === opts.stage ? { ...prior.queued } : {},
  }

  const written = new Map(Object.entries(progress.queued))
  const writeTally = freshTally()
  let queued = 0
  const started = Date.now()

  for await (const item of documentsToWrite(dir, refs, opts, writeTally)) {
    if (item.fileComplete) {
      if (doneFiles.has(item.fileComplete)) {
        console.log(`  ${item.fileComplete.padEnd(36)} -- already complete, skipped`)
        continue
      }
      console.log(`  ${item.fileComplete.padEnd(36)} ${pad(item.count)} queued`)
      // Recorded complete only after its writes are acknowledged, so --resume
      // can never skip a file whose documents did not land.
      await writer.flush()
      progress.completedFiles.push(item.fileComplete)
      progress.queued = Object.fromEntries(written)
      writeProgress(dir, progress)
      continue
    }
    if (doneFiles.has(item.file)) continue

    // The Dataverse GUID is the document id, so this overwrites on a re-run
    // rather than creating a second copy.
    writer.set(db.collection(item.collection).doc(item.id), item.doc, { merge: true })
    written.set(item.collection, (written.get(item.collection) ?? 0) + 1)
    queued++
    if (queued % 2000 === 0) {
      process.stdout.write(`\r  queued ${num(queued)}...`)
      await writer.flush()
    }
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
  // Firestore for every collection this run touched and compare against the
  // projection -- the same numbers the dry run reports, from the same code.
  //
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
    rows.push({ col, expected, actual, error, projected: projected.get(col) ?? 0 })
  }

  console.log(
    `  ${'collection'.padEnd(24)}${'expected'.padStart(11)}${'actual'.padStart(11)}${'difference'.padStart(13)}`,
  )
  let short = 0
  let surplus = 0
  let unreadable = 0
  let offProjection = 0
  for (const r of rows) {
    if (r.expected !== r.projected) offProjection++
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
  if (offProjection) {
    problems.push(`${offProjection} collection(s) wrote a different count than projected`)
  }
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
    await app.delete().catch(() => {})
    process.exit(1)
  }

  console.log(
    surplus
      ? '\n  Verified: every document this run wrote is in Firestore.' +
          `\n  ${surplus} collection(s) also hold other documents, accepted via --allow-existing.`
      : '\n  Verified: every collection holds exactly what this run wrote.',
  )
  console.log('\n  Held back: the remaining production orders, the coil catalogue, item')
  console.log('  reference images, production data, and the image BYTES. The image')
  console.log('  metadata rows are in -- they carry legacySourceUrl and imagePending.')
  console.log('  Re-running is safe: the same document ids are rewritten.')

  if (opts.stage === 'master') {
    // Printed complete, with this run's own arguments, because it exists to be
    // copy-pasted. A command missing --project would abort on the first line.
    console.log('\n  Next: open the app and check the master data is there, then run')
    console.log(`    node qc-import.mjs ${opts.src} --stage=history --project=${opts.project} --commit`)
  }

  // The last line, so success is one unambiguous statement rather than
  // something the operator has to assemble from the report above it.
  console.log(`\n  Stage ${opts.stage} complete: ${num(total)} documents verified in ${opts.project}.\n`)

  // The Firestore gRPC channel keeps the event loop alive, so without this the
  // process prints "Verified" and then sits there. During a live migration that
  // reads as a hang and invites a Ctrl-C at the worst possible moment.
  await app.delete().catch(() => {})
  process.exit(0)
}

// Only run when invoked directly, so the tests can import the stage tables.
if (process.argv[1] && process.argv[1].endsWith('qc-import.mjs')) {
  main().catch((e) => {
    console.error('\n  Import failed:', e.message)
    console.error(`  Re-running is safe. ${PROGRESS_FILE} records how far it got.\n`)
    process.exit(1)
  })
}
