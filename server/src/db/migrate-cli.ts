// `npm run db:migrate` — apply pending migrations and exit.
import { loadConfig } from '../config'
import { createPool } from './pool'
import { migrate } from './migrate'

const config = loadConfig()
const db = createPool(config.DATABASE_URL, 2)
try {
  const applied = await migrate(db)
  if (applied.length === 0) console.log('Database is up to date.')
  for (const m of applied) console.log(`Applied ${m.version}_${m.name}`)
} finally {
  await db.end()
}
