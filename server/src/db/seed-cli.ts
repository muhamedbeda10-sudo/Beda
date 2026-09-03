// `npm run db:seed` — load the demo master data into an empty database.
import { loadConfig } from '../config'
import { createPool } from './pool'
import { migrate } from './migrate'
import { seedDemoDataIfEmpty } from './seed'

const config = loadConfig()
const db = createPool(config.DATABASE_URL, 2)
try {
  await migrate(db)
  const seeded = await seedDemoDataIfEmpty(db)
  console.log(seeded ? 'Demo data seeded.' : 'Database already has orders — nothing seeded.')
} finally {
  await db.end()
}
