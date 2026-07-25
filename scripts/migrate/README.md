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

> ### Deploy `firestore.rules` BEFORE running stage `master`
>
> The Admin SDK bypasses security rules, so the import succeeds whether or not
> the current rules are deployed. If they are not, every write still lands and
> then **the app shows empty screens**, because the client is denied reads on
> collections the rules do not name -- `paintSamples`, `defectImages`,
> `sampleCoilImages`, `pdiImages`, `sessionInitializations`,
> `workCenterDimensions`, `productionData`, `orphanMeasurements`,
> `orphanSamples`.
>
> Nothing in the import enforces this, and no error will point at it. Deploy
> first, and check again after:
>
> ```
> firebase deploy --only firestore:rules
> ```
>
> A push to `main` deploys them too, via `.github/workflows/firebase-hosting.yml`.

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
node qc-import.mjs /path/to/data --stage=master  --project=linkmisr-9afbd --commit
node qc-import.mjs /path/to/data --stage=history --project=linkmisr-9afbd --commit
```

| stage | collections | roughly |
|---|---|---|
| `master` | machines, gradeMappings, itemDimensionMaster, itemDimensionOrder, workCenterDefects, workCenterDimensions | 444 |
| `history` | sessions, samples, dimensions, defects, sampleCoils, PDI, audit, quarantine, **paint samples, session initializations, and the four image-metadata tables** -- plus only the production orders those rows reference | 5,706 rows -> **5,591 documents** incl. 125 orders |
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

> **A later `--stage=deferred` run will report a surplus on `orders`, and fail.**
> That is correct, not corruption.
>
> Stage 2 already wrote the 125 referenced orders. Verification compares the
> live count against what *that* run wrote, so a deferred run writing the
> remaining 28,746 reads back 28,871 and reports `+125`. The guard is doing
> exactly its job: it cannot tell "orders my sibling stage wrote" from "orders
> somebody else put here", so it refuses and asks.
>
> Pass `--allow-existing` on the deferred run, having read the surplus and
> recognised it as the 125:
>
> ```
> node qc-import.mjs <folder> --stage=deferred --project=linkmisr-9afbd --commit \
>   --max-writes 60000 --allow-existing
> ```
>
> Do not add `--allow-existing` to the `master` or `history` runs. On a first
> import into an empty project those should show `0` in every difference column,
> and a surplus there would be a real finding.

### Images: the rows migrate now, the bytes do not

Four source tables are image *metadata*, and they are rows in the export, not
files on disk. They migrate in stage 2:

| file | rows | collection | link column |
|---|---|---|---|
| `06_cr863_visualdefectimages.json` | 17 | `defectImages` | `_cr863_visualdefectresult_value` |
| `07_cr863_samplecoilimages.json` | 5 | `sampleCoilImages` | `_cr863_samplecoil_value` |
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

Note the lookup columns **drop the digit** even though the parent tables are
`cr863_visualdefectresult2s` and `cr863_samplecoil2s`. Verified against the real
files.

Each transform still accepts more than one spelling, with the verified name
first, and **reports which one the real data used** before anything is written:

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

### The target project is asserted, twice

`--project` is **required**:

```
node qc-import.mjs /path/to/data --stage=master --project=linkmisr-9afbd --commit
```

`applicationDefault()` writes to whatever `GOOGLE_APPLICATION_CREDENTIALS`
points at. With two service-account files on a machine, or one wrong `export`,
a run writes every document into the wrong project -- and then reads its counts
back from that same wrong project and prints *"Verified: every collection holds
exactly what this run wrote"*, because from its own point of view it did.

**This is the one failure in the whole design that verification cannot catch**,
so it has its own guard, checked twice:

1. the `project_id` in the service-account file, **before `firebase-admin` is
   even imported**, so a wrong-project run never opens a connection;
2. the project the initialised SDK actually resolved, before the writer is
   created and before the first write.

Either mismatch aborts. So does an unverifiable target -- if the project cannot
be determined, the run stops rather than assuming it is the right one. The
target is printed in the header, above the projection, while there is still time
to stop:

```
  Dataverse -> Firestore
  source: /home/.../qc-migration/data
  stage:  master -> machines, gradeMappings, ...
  target: linkmisr-9afbd
  mode:   COMMIT
```

Only `project_id` is read out of the credential file. Nothing else from it is
returned, printed or logged.

### The process exits when it is done

`app.delete()` is called and the process exits explicitly, on both the success
and the not-verified path. Without it the Firestore gRPC channel keeps the event
loop alive: the operator sees "Verified" and then a terminal that just sits
there, which during a live migration reads as a hang and invites a Ctrl-C at the
worst possible moment.

### Dimension rows with no reading are kept

4,770 dimension results, of which 349 have no parent sample. Those 349 split
exactly: 240 have neither an actual nor a nominal and are dropped, 109 carry a
measurement and go to quarantine. So the file produces **4,530 documents**.

The drop rule applies **only to parentless rows.** 623 rows have a valid parent
sample but no actual and no nominal, and a further 36 have a nominal but no
actual. All 659 are imported.

Dropping them would quietly raise the completion rate of every inspection they
belong to. That is falsifying a QC record, not tidying one.

Each carries:

| field | meaning |
|---|---|
| `measured: false` | no reading was ever taken |
| `unmeasuredReason: 'blank-template-row'` | neither a spec nor a reading -- the 623 |
| `unmeasuredReason: 'required-not-measured'` | a spec existed and nobody measured it -- the 36 |

**An unmeasured row is never imported as passing.** The source marks some of
them `Pass`; the import forces `status: 'Pending'` whenever `actual` is null and
keeps the original in `legacy.sourceStatus`. A dimension with no reading cannot
have passed, whatever the old system recorded.

### Child counts are denormalised

The history list needs counts per row. Fetching the children to count them is
the unbounded read the app was rebuilt to avoid, and a count aggregation per row
is a per-row cost on every page view. So the counts live on the parent:

| document | fields |
|---|---|
| session | `sampleCount` |
| sample | `dimensionCount`, `measuredDimensionCount`, `defectCount`, `coilCount` |

The migration computes them from the rows it is already streaming, so they cost
nothing extra and start out exactly matching what was written. The app maintains
them in the **same batch** that writes a sample -- `saveSampleAtomic` derives
them from the bundle it is committing and increments the session's `sampleCount`
with `increment(1)` in that batch. The count and the things it counts cannot
land separately, so they cannot drift.

`measuredDimensionCount` is deliberately separate from `dimensionCount` so the
623 stay visible as unmeasured rather than folding into a completion figure.

Other flags:

```
--project <id>          REQUIRED. The project this run may write to.
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

**`--project` names the only project it may write to**, and a mismatch aborts
before the first write. See below.

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

Stage 2 is **5,706 source rows**, of which 240 are dropped (parentless with
nothing recorded), giving 5,466 documents plus 125 referenced orders =
**5,591**. Grand total for the day: 444 + 5,591 = **6,035**, inside the 18,000
cap and the 20,000 daily limit.

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
node qc-import.mjs /path/to/data --stage=history --project=linkmisr-9afbd --commit --resume
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
