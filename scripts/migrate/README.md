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
| `history` | sessions, samples, dimensions, defects, sampleCoils, PDI, audit, quarantine -- **plus only the production orders those rows reference** | ~5,400 |
| `all` | master + history. Today's authorised scope, not "everything in the file". | |
| `deferred` | the remaining production orders, coils, itemReferenceImages, productionData | ~59,200 |

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
auditLogs             itemDimensionMaster   orphanMeasurements    sampleCoils
coils                 itemDimensionOrder    orphanSamples         samples
defects               itemReferenceImages   pdiDocuments          sessions
dimensions            machines              productionData        workCenterDefects
gradeMappings         orders                                      workCenterDimensions
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
  samples                         374
  sessions                        147
  orders                          125
  ...
  TOTAL                         5,281

  Orders: 125 of 28,871 in the file, selected because the inspection rows reference them.

  Within budget: 5,281 writes, limit 18,000.
```

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
* item reference images (42);
* every image file -- 223 files, 82 MB. They are on disk, not in the database
  export. The dry run lists the five image files it deliberately skips.

The first three are `--stage=deferred`, which will exceed the default
`--max-writes` and refuse until the budget is raised deliberately or the project
moves to Blaze.

## 8. Quarantine

349 dimension rows in the export have no parent sample. 240 of them are unfilled
template rows and are rejected. The other 109 carry real measurements and are
written to `orphanMeasurements` with `quarantined: true` and `needsReview: true`.
Samples with no session go to `orphanSamples` the same way.

Nothing that carries a recorded measurement is dropped. Losing evidence quietly
is the failure this system exists to prevent, so a row that cannot be placed is
held for a person to place rather than discarded.
