// Before the run: a database for each worker (test/databases.ts), made on the base database's server one after
// another — two CREATE DATABASE from the same template at once may refuse each other.

import pg from 'pg'
import { BASE_TEST_DATABASE_URL, testWorkers, workerDatabaseUrl } from './databases'

export default async function setup(): Promise<void> {
  const client = new pg.Client({ connectionString: BASE_TEST_DATABASE_URL })
  await client.connect()
  try {
    for (let worker = 1; worker <= testWorkers(); worker++) {
      const name = decodeURIComponent(new URL(workerDatabaseUrl(worker)).pathname.slice(1))
      const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])
      if (!rowCount) await client.query(`CREATE DATABASE ${client.escapeIdentifier(name)}`)
    }
  } finally {
    await client.end()
  }
}
