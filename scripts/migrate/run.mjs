#!/usr/bin/env node
// ============================================================================
// Dataverse -> Firestore migration.
//
//   node scripts/migrate/run.mjs --src ~/Downloads/qc-migration/data
//   node scripts/migrate/run.mjs --src ... --commit
//
// Dry run is the default: it reads every row, applies the full transform and
// prints the reconciliation report WITHOUT opening a Firestore connection.
//
// Files are read as a stream — the largest export is 46 MB and is never held in
// memory whole. Document ids are the Dataverse GUIDs, so a second run rewrites
// the same documents rather than duplicating them.
//
// Credentials come from GOOGLE_APPLICATION_CREDENTIALS (a path). The key is
// never read from source, never printed, never logged.
// ============================================================================

import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
// stream-json ships CommonJS; import the default and destructure.
import streamJson from 'stream-json'
import pickFilter from 'stream-json/filters/Pick.js'
import streamArrayMod from 'stream-json/streamers/StreamArray.js'

const { parser } = streamJson
const { pick } = pickFilter
const { streamArray } = streamArrayMod
import {
  COL,
  transformOrder,
  transformMachine,
  transformCoil,
  transformDimensionOrder,
  transformDimensionMaster,
  transformWorkCenterDefect,
  transformWorkCenterDimension,
  transformGradeMapping,
  transformItemImage,
  transformProductionData,
  transformSession,
  transformSample,
  transformDimensionResult,
  transformDefectResult,
  transformSampleCoil,
  transformPdi,
  transformAuditLog,
} from './transform.mjs'

// ---- Source files, in dependency order -------------------------------------

const FILES = [
  { file: '12_cr863_productionorder1s.json', expect: 28871, fn: transformOrder, label: 'production orders' },
  { file: '13_cr863_samplecoilcopies.json', expect: 30296, fn: transformCoil, label: 'coil catalogue' },
  { file: '15_cr863_dimensions.json', expect: 24, fn: transformDimensionMaster, label: 'dimension master' },
  { file: '16_quality_dimensionorders.json', expect: 328, fn: transformDimensionOrder, label: 'dimension order' },
  { file: '17_cr863_workcenterdimensions.json', expect: 1, fn: transformWorkCenterDimension, label: 'work-centre dimensions' },
  { file: '18_cr863_workcentervisualdefects.json', expect: 52, fn: transformWorkCenterDefect, label: 'work-centre defects' },
  { file: '19_quality_grademappings.json', expect: 7, fn: transformGradeMapping, label: 'grade mappings' },
  { file: '20_cr863_machineses.json', expect: 32, fn: transformMachine, label: 'machines' },
  { file: '21_quality_itemimages.json', expect: 42, fn: transformItemImage, label: 'item reference images' },
  { file: '23_cr863_productiondatas.json', expect: 11, fn: transformProductionData, label: 'production data' },
  { file: '01_cr863_inspectionsession1s.json', expect: 147, fn: transformSession, label: 'inspection sessions' },
  { file: '02_cr863_inspectionsample1s.json', expect: 374, fn: transformSample, label: 'inspection samples' },
  { file: '03_cr863_dimensionresult2s.json', expect: 4770, fn: transformDimensionResult, label: 'dimension results' },
  { file: '04_cr863_visualdefectresult2s.json', expect: 46, fn: transformDefectResult, label: 'defect results' },
  { file: '05_cr863_samplecoil2s.json', expect: 142, fn: transformSampleCoil, label: 'sample coils' },
  { file: '09_cr863_pdis.json', expect: 1, fn: transformPdi, label: 'PDI records' },
  { file: '24_cr863_auditlogs.json', expect: 31, fn: transformAuditLog, label: 'audit log' },
]

/** Read ahead of the main pass to resolve cross-file references. */
const PREPASS = {
  orders: '12_cr863_productionorder1s.json',
  sessions: '01_cr863_inspectionsession1s.json',
  samples: '02_cr863_inspectionsample1s.json',
  sessionInit: '11_quality_sessioninitializations.json',
  dimensionResults: '03_cr863_dimensionresult2s.json',
}

/** Images are a deliberate second pass — the files are on disk, not in the DB. */
const DEFERRED = [
  '06_cr863_visualdefectimages.json',
  '07_cr863_samplecoilimages.json',
  '08_quality_paintsampleimages.json',
  '10_cr863_pdiimages.json',
  '22_cr863_images.json',
]

// ---- Streaming -------------------------------------------------------------

/** Yield each element of the `rows` array without holding the file in memory. */
async function* streamRows(filePath) {
  const pipeline = createReadStream(filePath)
    .pipe(parser())
    .pipe(pick({ filter: 'rows' }))
    .pipe(streamArray())
  for await (const { value } of pipeline) yield value
}

async function exists(p) {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

// ---- CLI -------------------------------------------------------------------

function parseArgs(argv) {
  const args = { src: null, commit: false, only: null, verbose: false }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--src') args.src = argv[++i]
    else if (a === '--commit') args.commit = true
    else if (a === '--only') args.only = argv[++i]
    else if (a === '--verbose') args.verbose = true
    else if (a === '--help' || a === '-h') args.help = true
  }
  return args
}

const HELP = `
Dataverse -> Firestore migration

  --src <dir>   folder holding the exported *.json table files   (required)
  --commit      actually write to Firestore (default is a dry run)
  --only <col>  restrict to one target collection
  --verbose     list every rejected row rather than the first few

Dry run touches nothing and needs no credentials.
Committing reads GOOGLE_APPLICATION_CREDENTIALS for a service-account path.
`

// ---- Report ----------------------------------------------------------------

function makeReport() {
  return {
    perCollection: new Map(),
    rejects: [],
    decodeFailures: [],
    counts: {},
    fileIssues: [],
    notes: [],
  }
}

function bump(map, key, n = 1) {
  map.set(key, (map.get(key) ?? 0) + n)
}

function fmt(n) {
  return String(n).padStart(7).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

// ---- Main ------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv)
  if (args.help || !args.src) {
    console.log(HELP)
    process.exit(args.src ? 0 : 1)
  }

  const src = path.resolve(args.src.replace(/^~/, process.env.HOME ?? '~'))
  if (!(await exists(src))) {
    console.error(`Source folder not found: ${src}`)
    process.exit(1)
  }

  const report = makeReport()
  const mode = args.commit ? 'COMMIT' : 'DRY RUN'
  console.log(`\n  Dataverse → Firestore migration — ${mode}`)
  console.log(`  source: ${src}\n`)

  // ---- Pre-pass: build the cross-file lookups ------------------------------
  console.log('  Resolving cross-file references…')

  const orderWorkCenter = new Map()
  const sessionMeta = new Map()
  const sessionInspector = new Map()
  const sessionInit = new Map()
  const sampleIndex = new Map()
  const dimensionSequence = new Map()
  const sessionIds = new Set()
  const sampleIds = new Set()
  const orderIds = new Set()

  const ordersFile = path.join(src, PREPASS.orders)
  if (await exists(ordersFile)) {
    for await (const r of streamRows(ordersFile)) {
      const id = r.cr863_productionorder1id
      if (!id) continue
      orderIds.add(id)
      orderWorkCenter.set(id, String(r.cr863_workcenter ?? ''))
    }
  }

  const sessionsFile = path.join(src, PREPASS.sessions)
  if (await exists(sessionsFile)) {
    for await (const r of streamRows(sessionsFile)) {
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

  // Session initialisation links by quality_sessionkey held as text, not by the
  // lookup column — which is empty. 70 of 71 resolve.
  const initFile = path.join(src, PREPASS.sessionInit)
  let initMatched = 0
  let initUnmatched = []
  if (await exists(initFile)) {
    for await (const r of streamRows(initFile)) {
      const key = r.quality_sessionkey
      if (key && sessionIds.has(key)) {
        sessionInit.set(key, r)
        initMatched++
      } else {
        initUnmatched.push(r.quality_sessioninitializationid ?? '(no id)')
      }
    }
    report.notes.push(
      `Session initialisations matched by quality_sessionkey: ${initMatched} matched, ${initUnmatched.length} unmatched${
        initUnmatched.length ? ` (${initUnmatched.join(', ')})` : ''
      }`,
    )
  }

  // Sample ordinal within its session, and dimension ordinal within its sample.
  const samplesFile = path.join(src, PREPASS.samples)
  if (await exists(samplesFile)) {
    const bySession = new Map()
    for await (const r of streamRows(samplesFile)) {
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
      // A session carries no inspector of its own; take it from its first sample.
      const first = arr.find((s) => s.name)
      if (first) sessionInspector.set(sid, first.name)
    }
  }

  const dimFile = path.join(src, PREPASS.dimensionResults)
  if (await exists(dimFile)) {
    const bySample = new Map()
    for await (const r of streamRows(dimFile)) {
      const id = r.cr863_dimensionresult2id
      if (!id) continue
      const sid = r._cr863_inspectionsample_value ?? ''
      const n = (bySample.get(sid) ?? 0) + 1
      bySample.set(sid, n)
      dimensionSequence.set(id, n)
    }
  }

  console.log(
    `    orders ${orderIds.size} · sessions ${sessionIds.size} · samples ${sampleIds.size} · initialisations ${initMatched}\n`,
  )

  // ---- Transform pass ------------------------------------------------------

  const ctx = {
    orderWorkCenter,
    session: sessionMeta,
    sessionInspector,
    sessionInit,
    sampleIndex,
    dimensionSequence,
    decodeFailure: (f, id) => report.decodeFailures.push({ ...f, id }),
    count: (k) => (report.counts[k] = (report.counts[k] ?? 0) + 1),
  }

  // Orphan detection uses the id sets gathered above.
  const parentOf = {
    [COL.sessions]: (doc) => (orderIds.has(doc.orderId) ? null : `order ${doc.orderId}`),
    [COL.samples]: (doc) => (sessionIds.has(doc.sessionId) ? null : `session ${doc.sessionId}`),
    [COL.dimensions]: (doc) => (sampleIds.has(doc.sampleId) ? null : `sample ${doc.sampleId}`),
    [COL.defects]: (doc) => (sampleIds.has(doc.sampleId) ? null : `sample ${doc.sampleId}`),
    [COL.sampleCoils]: (doc) => (sampleIds.has(doc.sampleId) ? null : `sample ${doc.sampleId}`),
  }

  let writer = null
  let firestore = null
  if (args.commit) {
    const admin = await import('firebase-admin').catch(() => null)
    if (!admin) {
      console.error('  firebase-admin is not installed. Run: npm i -D firebase-admin')
      process.exit(1)
    }
    if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      console.error('  GOOGLE_APPLICATION_CREDENTIALS is not set. Point it at the service-account file.')
      process.exit(1)
    }
    const app = admin.default.initializeApp({ credential: admin.default.credential.applicationDefault() })
    firestore = admin.default.firestore(app)
    writer = firestore.bulkWriter()
    writer.onWriteError((err) => {
      report.fileIssues.push(`write failed for ${err.documentRef.path}: ${err.message}`)
      return err.failedAttempts < 3
    })
  }

  const orphans = []

  for (const spec of FILES) {
    const filePath = path.join(src, spec.file)
    if (!(await exists(filePath))) {
      report.fileIssues.push(`missing file: ${spec.file}`)
      continue
    }
    let seen = 0
    let written = 0
    for await (const row of streamRows(filePath)) {
      seen++
      const out = spec.fn(row, ctx)
      if (out.reject) {
        report.rejects.push({ file: spec.file, ...out.reject })
        continue
      }
      if (args.only && out.collection !== args.only) continue

      const check = parentOf[out.collection]
      if (check) {
        const missing = check(out.doc)
        if (missing) {
          orphans.push({ file: spec.file, id: out.id, missing })
          report.rejects.push({ file: spec.file, id: out.id, reason: `orphan — ${missing} not found` })
          continue
        }
      }

      bump(report.perCollection, out.collection)
      written++
      if (writer) writer.set(firestore.collection(out.collection).doc(out.id), out.doc, { merge: true })
    }
    const delta = spec.expect != null && seen !== spec.expect ? `  ⚠ expected ${spec.expect}` : ''
    console.log(`  ${spec.label.padEnd(24)} read ${fmt(seen)}  →  ${fmt(written)}${delta}`)
  }

  if (writer) {
    console.log('\n  Flushing writes…')
    await writer.close()
  }

  // ---- Report --------------------------------------------------------------

  console.log('\n  ── Documents per collection ─────────────────────────────')
  let total = 0
  for (const [col, n] of [...report.perCollection].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${col.padEnd(26)} ${fmt(n)}`)
    total += n
  }
  console.log(`  ${'TOTAL'.padEnd(26)} ${fmt(total)}`)

  console.log('\n  ── Grade extraction ─────────────────────────────────────')
  const got = report.counts.gradeExtracted ?? 0
  const missing = report.counts.gradeUnavailable ?? 0
  const pct = got + missing ? ((got / (got + missing)) * 100).toFixed(1) : '0.0'
  console.log(`  extracted ${fmt(got)}   unavailable ${fmt(missing)}   (${pct}% of orders)`)
  console.log('  Orders with no grade skip the mismatch check rather than compare')
  console.log('  against an invented value.')

  console.log('\n  ── Rows with no home ────────────────────────────────────')
  if (report.rejects.length === 0) {
    console.log('  none')
  } else {
    const byReason = new Map()
    for (const r of report.rejects) bump(byReason, r.reason)
    for (const [reason, n] of [...byReason].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${fmt(n)}  ${reason}`)
    }
    const show = args.verbose ? report.rejects : report.rejects.slice(0, 10)
    for (const r of show) console.log(`      ${r.file} ${r.id ?? ''} — ${r.reason}`)
    if (!args.verbose && report.rejects.length > 10) {
      console.log(`      … ${report.rejects.length - 10} more (use --verbose)`)
    }
  }

  console.log('\n  ── Orphans ──────────────────────────────────────────────')
  console.log(orphans.length === 0 ? '  none — every child resolves to its parent' : `  ${orphans.length}`)

  console.log('\n  ── Decode failures ──────────────────────────────────────')
  if (report.decodeFailures.length === 0) {
    console.log('  none — every choice value was present in the metadata')
  } else {
    const byField = new Map()
    for (const f of report.decodeFailures) bump(byField, `${f.field} = ${f.value}`)
    for (const [k, n] of byField) console.log(`  ${fmt(n)}  ${k}`)
  }

  if (report.notes.length) {
    console.log('\n  ── Notes ────────────────────────────────────────────────')
    for (const n of report.notes) console.log(`  · ${n}`)
  }

  console.log('\n  ── Deferred ─────────────────────────────────────────────')
  console.log(`  ${DEFERRED.length} image tables are not imported by this pass.`)
  console.log('  223 files (82 MB) are on disk; they upload in a separate step so')
  console.log('  nothing is written twice.')

  if (report.fileIssues.length) {
    console.log('\n  ── Problems ─────────────────────────────────────────────')
    for (const p of report.fileIssues) console.log(`  ! ${p}`)
  }

  console.log(
    args.commit
      ? '\n  Committed. Re-running writes the same document ids — no duplicates.\n'
      : '\n  Dry run only. Nothing was written. Add --commit when the numbers look right.\n',
  )
}

main().catch((e) => {
  console.error('\n  Migration failed:', e.message)
  process.exit(1)
})
