# QC Inspection Recorder — notes for every session

Monorepo (npm workspaces): `shared/` (TypeScript types and rules), `server/`
(Express, PostgreSQL, forward-only SQL migrations in `server/migrations/`),
`client/` (React). Tests: `npm test` (Vitest; the server's run against a real
PostgreSQL, `TEST_DATABASE_URL`). A push to `main` deploys to Azure.

## The assistant's views stay fast — a standing rule

The AI assistant answers any question by writing its own SQL over the views
in schema `ai` (and the saved tables in `ai_saved`). Nobody fixes queries one
by one: the views themselves are kept fast, for every question, now and for
any data added later. Whenever a change adds or alters data the assistant can
read — a new module, a new table, a new column, a new view — follow this,
without being asked:

1. **No figure worked out row by row.** A count, sum or list over another
   table (a sample's defects, a session's samples…) is not a subquery in the
   view: keep it as the record is written, in a rollup table maintained by
   statement triggers that work the affected rows out again whole (see
   `server/migrations/0067_ai_fast_views.sql`: `sample_rollups`,
   `session_rollups`, `refresh_*_rollups`, `rollups_watch`). Extend those, or
   add one the same way. A per-row subquery is acceptable only when it is a
   single indexed lookup of the row's own few children.
2. **Derived values that people filter on are indexable.** A value worked
   out by a function (a machine's key, a material) gets an expression index
   or a stored column, matching the way the assistant writes the filter
   (e.g. `inspection_sessions_machine_key_idx` on `ai.machine_key(work_center_code)`).
3. **Join on ids, filter on indexed timestamps.** Every view keeps an `*_at`
   timestamp backed by an index, and ids to join on.
4. **Keep view contracts.** `CREATE OR REPLACE VIEW` with every existing
   column, name and type unchanged (saved reports and automations depend on
   them); new columns go at the end, each with a `COMMENT ON COLUMN` — the
   comments are the assistant's data dictionary.
5. **Tell the assistant.** When a new column replaces a costly pattern (like
   `material` instead of joining `sample_coils`), say so in the column comment
   and, if it is a general habit, in the "Fast queries" section of
   `server/src/ai/prompt.ts`.
6. **Prove it.**
   - `server/test/aiViewsPerf.test.ts` finds every `ai` view from the catalog:
     a new view must be added to `SUBQUERIES_PER_ROW` with why each per-row
     subquery is cheap, and every view must read whole within the budget on
     the made-up factory (`server/test/perf/factoryData.ts`). Extend
     `factoryDataSql` with rows for any new table, in realistic proportions,
     so the new view is timed on real volume rather than passing empty.
   - A rollup gets a test like `server/test/aiRollups.test.ts`: its figures
     equal the plain definition after every kind of change (insert, update,
     soft delete, restore, moves).
   - For a larger change, time the views by hand at full scale: load
     `factoryDataSql(30000)` into a copy of the test database and read each
     view whole.

At run time the assistant also guards itself (`server/src/ai/assistant.ts`,
`runQuery.ts`): a query stopped at 60 s comes back with where its time went
(`planSummary`) and advice to narrow it; a question that truly needs the whole
record runs with `long: true` (up to 10 minutes, one at a time across the app,
the person notified by the bell). Keep those working when touching the query
path.
