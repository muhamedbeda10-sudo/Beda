# Dataverse -> Firestore migration

Two scripts. Both need Node 22 and nothing else installed; `qc-import.mjs`
additionally needs `firebase-admin` and a service-account key, and only at the
point where it actually writes.

| | |
|---|---|
| `qc-dryrun.mjs` | Reads the export, reports what would be written. Never connects to Firestore. |
| `qc-import.mjs` | Writes it. Refuses to do anything without `--commit`. |

Both read the same transforms, from `qc-dryrun.mjs`. There is one mapping, so
what the dry run reports is what the import writes.

---

## 1. Dry run first

```
node qc-dryrun.mjs /path/to/qc-migration/data
```

No arguments beyond the folder, no network, no credentials. It streams the
46 MB export and prints per-collection document counts, rows that have no home,
choice-decode failures, and the quarantine totals. Read that report before
running anything below.

## 2. Credentials

The key never appears in this repository, in any command line, or in any log.
The importer reads it from the environment and from nowhere else:

```
export GOOGLE_APPLICATION_CREDENTIALS=/secure/path/serviceAccount.json
npm i firebase-admin
```

`.gitignore` already excludes `*serviceAccount*.json`, `*adminsdk*.json` and
`.env`. Do not paste the key into a chat window, an issue, or a commit.

## 3. Import in stages

`--stage` is **required**. There is no default, because the default would be the
run that writes everything.

```
node qc-import.mjs /path/to/qc-migration/data --stage=master  --commit
node qc-import.mjs /path/to/qc-migration/data --stage=history --commit
```

| stage | collections | roughly |
|---|---|---|
| `master` | machines, gradeMappings, itemDimensionMaster, itemDimensionOrder, workCenterDefects, workCenterDimensions | 444 |
| `history` | sessions, samples, dimensions, defects, sampleCoils, PDI, audit, quarantine, **paint samples, session initializations, and the four image-metadata tables** -- plus only the production orders those rows reference | 5,706 rows + 125 orders |
| `all` | master + history. Today's authorised scope, not "everything in the file". | |
| `deferred` | the remaining production orders, coils, itemReferenceImages, productionData, and every image **byte** | ~59,200 |

The three stages **partition** the data: every document the transforms can
produce belongs to exactly one of them. That is enforced by a test, not by this
paragraph.

### Orders are selected by reference, not imported wholesale

The export holds 28,871 production orders. Only the ones the inspection rows
actually point at come across in `history`. The set is derived at run time from
the history rows themselves -- the order on each session, the order behind each
sample's session, the order on each PDI -- and never from a hardcoded list. The
orders file is read to learn which ids exist; reading is free, writing is what
is being limited.

The run reports the derivation before it writes anything:

```
    orders in file 28,871 - sessions 147 - samples 374
    orders referenced by the history rows: 125 (125 via sessions, 0 via samples, 0 via PDI)
```

It also names any referenced order that is **not** in the export, and counts
sessions with no order link at all. Both should be zero; if they are not, that
is a finding to act on, not a line to scroll past.

`deferred` takes exactly the orders `history` did not, so nothing is lost --
it is queued for a day with the write budget for it.

### Images: the rows migrate now, the bytes do not

Four source tables are image *metadata*, and they are rows in the export, not
files on disk. They migrate in stage 2:

| file | rows | collection | link column |
|---|---|---|---|
| `06_cr863_visualdefectimages.json` | 17 | `defectImages` | `_cr863_visualdefectresult2_value` |
| `07_cr863_samplecoilimages.json` | 5 | `sampleCoilImages` | `_cr863_samplecoil2_value` |
| `08_quality_paintsampleimages.json` | 99 | `paintSamples` | `quality_inspectionsampleidtext` |
| `10_cr863_pdiimages.json` | 3 | `pdiImages` | `_cr863_pdi_value` |

Each document carries `legacySourceUrl` and `imagePending: true`.

**`legacySourceUrl` is a reconciliation key for the byte migration and nothing
else. The app must never render it.** It is a SharePoint link that stops working
the moment permissions change, so treating it as an image source would put
broken evidence in front of an inspector. The app renders `imageIds`, which stay
empty until the bytes land.

`08_quality_paintsampleimages.json` is named "...images" but the row **is** the
paint inspection record -- it carries the notes and the time the sample was
taken, with the photo as one field. It lands in `paintSamples`, the collection
the History screen already reads. Writing zero of these would silently drop the
entire paint inspection history.

Its link to the sample is `quality_inspectionsampleidtext`: a **text** column
holding the sample GUID, with no `_value` suffix, so a generic lookup resolver
does not see it.

Because these four tables were mapped after the rest of the export was
understood, each transform accepts more than one spelling of its link column and
**reports which one the real data used**, before anything is written:

```
  -- Resolved link columns -----------------------------
    06_cr863_visualdefectimages.json -> defect: _cr863_visualdefectresult2_value
    08_quality_paintsampleimages.json -> sample: quality_inspectionsampleidtext
```

If a link resolves to no column at all, the run **refuses to start**. Those rows
would otherwise be written with an empty parent reference, which is evidence
pointing at nothing.

### Session initializations link by key, not by lookup

`_quality_inspectionsession_value` is null on 70 of the 71 rows, so it cannot be
the link. `quality_sessionkey` holds the session GUID directly and matches on 70.

All 71 are imported. The one that does not resolve is written with `sessionId`
unset, `needsReview: true` and the reason recorded -- not dropped. A setup record
with a broken pointer is still evidence that a session was set up.

The same rule applies to the 1 sample of 374 whose `_cr863_inspectionsession_value`
is null: it goes to `orphanSamples` flagged, never silently discarded.

Other flags:

```
--max-writes <n>        refuse to start above this. Default 18000.
--only <collection>     one collection, within the stage
--skip <col,col>        exclude collections
--resume                skip files already recorded complete
--allow-existing        accept collections that already hold other documents
--verbose               print every write failure
```

## 4. What the importer will and will not do

**`--commit` is the only flag that enables writing.** Without it the script
reads local files, prints what it would write, and stops with exit 0. No
credential is read, `firebase-admin` is never imported, no app is initialised,
and no connection to Firestore is opened. A dry run touches nothing.

**Every collection it is capable of writing to**, and no others -- the script
prints this same list in its own `--help` output:

```
auditLogs             machines              productionData
coils                 orders                sampleCoilImages
defectImages          orphanMeasurements    sampleCoils
defects               orphanSamples         samples
dimensions            paintSamples          sessionInitializations
gradeMappings         pdiDocuments          sessions
itemDimensionMaster   pdiImages             workCenterDefects
itemDimensionOrder                          workCenterDimensions
itemReferenceImages
```

A document routed anywhere else **aborts the run**. Every target goes through
`route()`, which compares it against that list. The only database operation in
the whole file is `set(..., { merge: true })` on a document whose id is a
Dataverse GUID. There is no delete, no recursive delete, no collection clear,
and no query that could match a record this migration does not own.

**It counts before it writes.** Nothing is sent until the run has streamed the
export, computed exactly what it would write, and printed the projection per
collection with a total. The projection and the write pass consume the *same*
generator, so the number shown is the number written -- a projection computed by
a second implementation would be worth nothing.

**It refuses to exceed the write budget.** If the projection is above
`--max-writes` (default **18,000**) the run stops with exit 1 *before*
`firebase-admin` is imported. The Spark free plan allows 20,000 writes per day,
so the default leaves headroom for the app itself. On a resumed run the budget
is checked against what is left to write, not the whole stage.

```
  -- Projected writes ----------------------------------
  dimensions                    4,530
  samples                         373
  sessions                        147
  orders                          125
  paintSamples                     99
  sessionInitializations           71
  defects                          46
  sampleCoils                     142
  auditLogs                        31
  defectImages                     17
  sampleCoilImages                  5
  pdiImages                         3
  pdiDocuments                      1
  orphanSamples                     1
  ...
  TOTAL                         5,591

  Orders: 125 of 28,871 in the file, selected because the inspection rows reference them.

  Within budget: 5,591 writes, limit 18,000.
```

Source rows for stage 2 total **5,706**, plus 125 referenced orders. The
projection writes slightly fewer because 240 unfilled dimension template rows
are rejected, as agreed. The script prints the real number on the real data;
this is an illustration, not a promise.

**It verifies before it claims success.** See below.

## 5. Verification

Queueing a write is not evidence that it landed. When the run finishes the
importer reads the document count back from Firestore for every collection it
wrote and prints:

```
  -- Verifying against Firestore -----------------------
  collection                 expected     actual   difference
  gradeMappings                     7          7            0
  itemDimensionMaster              24         24            0
  ...
```

`expected` is what this run wrote, which is the projection printed before
writing -- the same numbers the dry run reports, from the same code. A
collection whose written count differs from its projection is a failure too.
`actual` is the live count.

* `actual < expected` -- writes are missing. Always a failure.
* `actual > expected` -- the collection holds documents this run did not write.
  A re-run never causes this, because the ids are stable and get rewritten in
  place, so it means pre-existing data. Failure unless `--allow-existing`.
* Nothing written at all -- a failure. That is what a wrong folder, a wrong
  `--stage` or a wrong `--only` looks like, and it should not read as success.

Any of those exits non-zero. The script does not print "done" without having
confirmed the writes are there.

## 6. If it is interrupted

**Re-running is safe.** Every document id is the Dataverse GUID from the source
row. A second run rewrites the same documents in place; it does not create a
second copy of anything. This is true whether the first run was interrupted
after 100 documents or 64,000, and true whether or not you pass `--resume`.

The importer writes `qc-import-progress.json` into the source folder as it goes:

```json
{
  "startedAt": "2026-07-25T14:02:11.004Z",
  "stage": "history",
  "completedFiles": ["01_cr863_inspectionsession1s.json", "02_cr863_inspectionsample1s.json"],
  "queued": { "sessions": 147, "samples": 374 }
}
```

A file is recorded complete only after its writes have been flushed and
acknowledged, so `--resume` never skips a file whose documents did not land.

```
node qc-import.mjs /path/to/data --stage=history --commit --resume
```

`--resume` skips the files listed in `completedFiles`. A progress file written
by a different stage is ignored rather than trusted. Without `--resume` the run
starts from the top, which is slower and equally safe.

If you are unsure how far a run got, run without `--resume`. The verification
step at the end is the thing that tells you the data is there, and it does not
depend on the progress file being accurate.

## 7. Not in this pass

Held back deliberately, because the project is on the Spark free plan today --
20,000 writes per day and no Cloud Storage:

* the production orders no inspection row references (28,746 of 28,871);
* the coil catalogue, `13_cr863_samplecoilcopies.json` (30,296);
* item reference images, `21_quality_itemimages.json` (42) -- needs Storage;
* `22_cr863_images.json` (2) -- needs Storage;
* production data, `23_cr863_productiondatas.json` (11). Production reporting --
  worker names, produced weight, shift category, resource -- not QC data, and no
  screen in the specification consumes it;
* every image **byte**. The metadata rows are in; the files follow once Storage
  exists, matched up through `legacySourceUrl`.

The first three collections are `--stage=deferred`, which will exceed the
default `--max-writes` and refuse until the budget is raised deliberately or the
project moves to Blaze.


## 8. Quarantine

349 dimension rows in the export have no parent sample. 240 of them are unfilled
template rows and are rejected. The other 109 carry real measurements and are
written to `orphanMeasurements` with `quarantined: true` and `needsReview: true`.
Samples with no session go to `orphanSamples` the same way.

Nothing that carries a recorded measurement is dropped. Losing evidence quietly
is the failure this system exists to prevent, so a row that cannot be placed is
held for a person to place rather than discarded.
