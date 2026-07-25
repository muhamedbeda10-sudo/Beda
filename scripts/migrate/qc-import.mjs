#!/usr/bin/env node
// ============================================================================
// Dataverse -> Firestore : the real import.
//
//   npm i firebase-admin
//   export GOOGLE_APPLICATION_CREDENTIALS=/secure/path/serviceAccount.json
//   node qc-import.mjs /path/to/qc-migration/data --commit
//
// Reads the same transforms as qc-dryrun.mjs, so what the dry run reported is
// exactly what gets written — there is no second mapping to drift.
//
// Safety properties:
//   * --commit is required. Without it this refuses to write.
//   * Document ids are the Dataverse GUIDs, so running twice rewrites the same
//     documents. There is no path that duplicates a record.
//   * Files stream; the 46 MB export is never held in memory whole.
//   * The service-account path comes from the environment. The key is never
//     read from source, never printed, never logged.
// ============================================================================

import path from 'node:path'
import { statSync } from 'node:fs'
import { FILES, COL, streamRows } from './qc-dryrun.mjs'

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

  --commit          required; without it nothing is written
  --only <col>      restrict to one target collection
  --skip <col,col>  skip collections (e.g. already imported)
  --verbose         print every failure

  Requires:  npm i firebase-admin
             GOOGLE_APPLICATION_CREDENTIALS=<path to service account json>

Run qc-dryrun.mjs first and read its report. This writes the same documents.
`

async function main() {
  const argv = process.argv.slice(2)
  const src = argv.find((a) => !a.startsWith('--'))
  const commit = argv.includes('--commit')
  const verbose = argv.includes('--verbose')
  const only = argv[argv.indexOf('--only') + 1]
  const skip = new Set((argv[argv.indexOf('--skip') + 1] ?? '').split(',').filter(Boolean))

  if (!src) {
    console.log(HELP)
    process.exit(1)
  }
  const dir = path.resolve(src.replace(/^~/, process.env.HOME ?? '~'))
  if (!exists(dir)) {
    console.error(`\n  Folder not found: ${dir}\n`)
    process.exit(1)
  }
  if (!commit) {
    console.error('\n  Refusing to write without --commit. Run qc-dryrun.mjs to preview.\n')
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

  console.log(`\n  Dataverse → Firestore — COMMIT`)
  console.log(`  source: ${dir}`)
  console.log(`  project: ${process.env.GOOGLE_CLOUD_PROJECT ?? '(from service account)'}\n`)

  // ---- Pre-pass, identical to the dry run ----------------------------------
  console.log('  Resolving cross-file references…')
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
    `    orders ${num(orderIds.size)} · sessions ${num(sessionIds.size)} · samples ${num(sampleIds.size)}\n`,
  )

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
  const written = new Map()
  const skipped = { rejected: 0, dangling: 0, filtered: 0 }
  let queued = 0
  const started = Date.now()

  for (const spec of FILES) {
    const p = f(spec.file)
    if (!exists(p)) {
      console.log(`  ${spec.label.padEnd(22)} — file missing, skipped`)
      continue
    }
    let n = 0
    for await (const row of streamRows(p)) {
      const out = spec.fn(row, ctx)
      if (out.reject) {
        skipped.rejected++
        continue
      }
      if (only && out.collection !== only) {
        skipped.filtered++
        continue
      }
      if (skip.has(out.collection)) {
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
        process.stdout.write(`\r  queued ${num(queued)}…`)
        await writer.flush()
      }
    }
    process.stdout.write('\r')
    console.log(`  ${spec.label.padEnd(22)} ${pad(n)} queued`)
  }

  console.log('\n  Flushing…')
  await writer.close()
  const secs = ((Date.now() - started) / 1000).toFixed(1)

  // ---- Report --------------------------------------------------------------
  console.log('\n  ── Written per collection ────────────────────────────')
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

  console.log('\n  ── Not written ───────────────────────────────────────')
  console.log(`  rejected by the transform  ${pad(skipped.rejected)}`)
  console.log(`  dangling parent reference  ${pad(skipped.dangling)}`)
  if (skipped.filtered) console.log(`  excluded by --only/--skip  ${pad(skipped.filtered)}`)

  if (failures.length) {
    console.log('\n  ── Write failures ────────────────────────────────────')
    console.log(`  ${num(failures.length)} documents could not be written after retries.`)
    for (const x of verbose ? failures : failures.slice(0, 20)) {
      console.log(`    ${x.path} — ${x.message}`)
    }
    if (!verbose && failures.length > 20) console.log(`    … ${num(failures.length - 20)} more (--verbose)`)
    console.log('\n  Re-run the import: document ids are stable, so it retries')
    console.log('  these without duplicating anything already written.')
    process.exit(1)
  }

  console.log('\n  Images are not part of this pass — 223 files upload separately.')
  console.log('  Re-running is safe: the same document ids are rewritten.\n')
}

main().catch((e) => {
  console.error('\n  Import failed:', e.message)
  console.error('  Nothing further was written. Re-running is safe.\n')
  process.exit(1)
})
