// ============================================================================
// The test databases. Test files run side by side, one per worker, and every
// file resets its database (drops the schemas, runs the migrations again): so
// each worker has a database of its own, the base name with the worker's
// number — qc_test_1, qc_test_2… — made once before the run (globalSetup.ts).
// The assistant's roles are named after the database (qc_test_1_ai_…), so the
// workers' roles never meet either.
//
//   TEST_DATABASE_URL  the base, defaults to postgresql://qc:qc@127.0.0.1:5432/qc_test;
//                      its user may create databases
//   TEST_WORKERS       how many files run at once, by default one per CPU up to 4
// ============================================================================

import os from 'node:os'

export const BASE_TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://qc:qc@127.0.0.1:5432/qc_test'

/** How many test files run at once: TEST_WORKERS, or one per CPU up to 4 (the database is shared by them all). */
export function testWorkers(): number {
  const wanted = Number(process.env.TEST_WORKERS)
  return Number.isInteger(wanted) && wanted > 0 ? wanted : Math.max(1, Math.min(4, os.availableParallelism()))
}

/** The database of worker `worker` (1-based): the base name and the number. */
export function workerDatabaseUrl(worker: number | string): string {
  const url = new URL(BASE_TEST_DATABASE_URL)
  url.pathname = `${url.pathname}_${worker}`
  return url.toString()
}

/** This worker's database; outside a worker (a script), the base itself. */
export function testDatabaseUrl(): string {
  const worker = process.env.VITEST_POOL_ID
  return worker ? workerDatabaseUrl(worker) : BASE_TEST_DATABASE_URL
}
