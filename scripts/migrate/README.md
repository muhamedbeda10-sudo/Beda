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

Run the small reference data first, confirm it landed, then run the rest.

```
node qc-import.mjs /path/to/qc-migration/data --stage=master  --commit
node qc-import.mjs /path/to/qc-migration/data --stage=history --commit
```

| stage | collections | documents |
|---|---|---|
| `master` | machines, gradeMappings, itemDimensionMaster, itemDimensionOrder, workCenterDefects, workCenterDimensions | 444 |
| `history` | everything else | the rest |
| `catalogue` | orders, coils, itemReferenceImages, productionData | a subset of `history` |
| `evidence` | sessions, samples, dimensions, defects, sampleCoils, PDI, audit, quarantine | a subset of `history` |
| `all` | everything (the default) | |

`master` and `history` partition the data exactly. Running the two of them, in
either order, writes every document once and leaves nothing behind. That is
enforced by a test, not by this paragraph.

`catalogue` and `evidence` split `history` for anyone who wants the two large
phases separately. They are convenience, not a substitute for the pair.

Other flags:

```
--only <collection>     one collection, within the stage
--skip <col,col>        exclude collections
--resume                skip files already recorded complete
--allow-existing        accept collections that already hold other documents
--verbose               print every write failure
```

## 4. What the importer will and will not do

**`--commit` is the only thing that enables writing.** Every check -- the
folder, `--commit`, the stage name, the credential -- runs before
`firebase-admin` is imported. A run that fails any of them exits before an app
is initialised, so no connection to Firestore is opened at all. Without
`--commit`, nothing is read, nothing is sent, nothing is written.

**It cannot touch a collection outside its own list.** Every document is routed
through `route()`, which compares the target against `STAGES.all`. A document
bound for anything else aborts the run rather than being written. The only
database operation in the whole file is `set(..., { merge: true })` on a
document whose id is a Dataverse GUID. There is no delete, no recursive delete,
no collection clear, and no query that could match a record this migration does
not own.

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

`expected` is what this run wrote -- the same number the dry run reported.
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
  "completedFiles": ["12_cr863_productionorder1s.json", "13_cr863_samplecoilcopies.json"],
  "queued": { "orders": 28871, "coils": 30296 }
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

The 223 image files (82 MB) are a separate migration. They are on disk, not in
the database export, and Cloud Storage is unavailable on the Spark plan. The
dry run lists the five image files it deliberately skips.

## 8. Quarantine

349 dimension rows in the export have no parent sample. 240 of them are unfilled
template rows and are rejected. The other 109 carry real measurements and are
written to `orphanMeasurements` with `quarantined: true` and `needsReview: true`.
Samples with no session go to `orphanSamples` the same way.

Nothing that carries a recorded measurement is dropped. Losing evidence quietly
is the failure this system exists to prevent, so a row that cannot be placed is
held for a person to place rather than discarded.
