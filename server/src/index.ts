// ============================================================================
// Process entry point: configuration → database → migrations → HTTP server.
// ============================================================================

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from './config'
import { createPool } from './db/pool'
import { migrate } from './db/migrate'
import { createApp } from './app'
import { AzureBlobImageStorage, LocalImageStorage, type ImageStorage } from './images/storage'
import { RateLimiter } from './lib/rateLimit'
import { seedWorkInstructionsIfEmpty } from './db/seedWorkInstructions'
import type { AppContext } from './context'
import { AnthropicModelClient } from './ai/model'
import { AiReader } from './ai/reader'
import { pinAiOwner } from './ai/owner'
import { AnswerRunner } from './ai/answerRunner'
import { AutomationEngine } from './automations/engine'
import { SavedTableRefresher } from './ai/savedTables'
import { ensureStarters } from './ai/starters'
import { PushDispatcher } from './push/dispatcher'
import { ExcelFileSweeper } from './ai/excel'

function readVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const pkg = JSON.parse(readFileSync(path.resolve(here, '../package.json'), 'utf8')) as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

const config = loadConfig()
const db = createPool(config.DATABASE_URL, config.DATABASE_POOL_MAX)

if (config.RUN_MIGRATIONS_ON_START) {
  const applied = await migrate(db)
  for (const m of applied) console.log(`[db] applied migration ${m.version}_${m.name}`)
}

// §20 — the AI assistant's database readers. Idempotent, so it runs at every
// start whether or not migrations did; a failure leaves the assistant
// unavailable and everything else running. Then its owner, if not pinned yet
// and the account exists. Nothing else pins it but the operator's command
// (ai/owner.ts): no request does.
const aiReader = new AiReader()
await aiReader.provision(db, config)
try {
  if (!(await pinAiOwner(db, config))) {
    const pinned = await db.query(`SELECT 1 FROM ai_owner`)
    console.warn(
      pinned.rowCount
        ? "[ai] the assistant's owner account is deactivated or removed: nobody controls the assistant until it is back (a database operation)"
        : `[ai] no active account "${config.AI_OWNER_USERNAME}" to own the assistant; nobody controls it until one is pinned: npm run ai:pin-owner -w server -- <username>`,
    )
  }
} catch (e) {
  console.warn('[ai] the assistant\'s owner could not be pinned:', e instanceof Error ? e.message : String(e))
}

const images: ImageStorage =
  config.IMAGE_STORAGE_DRIVER === 'azure-blob'
    ? new AzureBlobImageStorage(config.AZURE_STORAGE_CONNECTION_STRING!, config.AZURE_STORAGE_CONTAINER)
    : new LocalImageStorage(path.resolve(config.IMAGE_LOCAL_DIR))

const ai = new AnthropicModelClient()
const aiReportLimiter = new RateLimiter(60, 10 * 60_000)
// §20 — the assistant's answers, written on the server whatever happens to the request that asked for them; an
// answer lost with another instance (or with this one, before a restart) is taken over and continued.
const answers = new AnswerRunner({ db, config, readers: aiReader, model: ai, images, reportLimiter: aiReportLimiter })
const ctx: AppContext = {
  config,
  db,
  images,
  loginLimiter: new RateLimiter(10, 15 * 60_000),
  version: readVersion(),
  ai,
  aiReader,
  aiLimiter: new RateLimiter(30, 10 * 60_000),
  aiReportLimiter,
  answers,
}
const app = createApp(ctx)

// The shipped work instructions go in once, on an empty table.
try {
  const loaded = await seedWorkInstructionsIfEmpty(ctx)
  if (loaded > 0) console.log(`[seed] loaded ${loaded} shipped work instruction(s)`)
} catch (e) {
  console.warn('[seed] work instructions were not loaded:', e)
}

const server = app.listen(config.PORT, () => {
  console.log(`[api] listening on :${config.PORT} (${config.NODE_ENV}, images=${config.IMAGE_STORAGE_DRIVER})`)
})

// §20 — answers left by an instance that went (a restart, a deploy) are taken over and continued, here as on every
// instance; never in tests, which sweep themselves.
if (config.NODE_ENV !== 'test') answers.start()

// §21 — the automations engine: watches, scheduled reports and follow-up
// escalation, on every instance (a database lease keeps each run to one).
// Never in tests, which drive it themselves; off with AUTOMATIONS_ENABLED=false.
const automations = config.AUTOMATIONS_ENABLED && config.NODE_ENV !== 'test' ? new AutomationEngine({ db, config, readers: aiReader, model: ctx.ai }) : null
if (automations) {
  automations.start()
  console.log('[automations] engine started')
}

// §24 — pushes to the devices people turned notifications on for: on every
// instance (each event is taken once). Never in tests, which drive it themselves.
const push = config.PUSH_ENABLED && config.NODE_ENV !== 'test' ? new PushDispatcher({ db, config }) : null
if (push) {
  push.start()
  console.log('[push] dispatcher started')
}

// §20 — Excel files the assistant made are kept 30 days: their bytes are taken
// out of storage once their time is over, every hour (the log stays).
const excelFiles = config.NODE_ENV !== 'test' ? new ExcelFileSweeper({ db, store: images }) : null
excelFiles?.start()

// §20 — the assistant's saved tables, computed again when due (every hour, or
// every night), on every instance: a lease keeps each computation to one.
const savedTables = config.NODE_ENV !== 'test' ? new SavedTableRefresher({ db, readers: aiReader, timeZone: config.FACTORY_TIMEZONE }) : null
savedTables?.start()

// §20 — what the assistant starts with (Order tracking, Week tracking, the standard times), made once as its
// owner's when there is one; a failure leaves everything else running, and the next start tries again.
if (config.NODE_ENV !== 'test') {
  ensureStarters({ db, config, readers: aiReader })
    .then((r) => {
      if (r.reports.length > 0) console.log(`[ai] starter reports made: ${r.reports.join(', ')}`)
      if (r.table !== 'made' && r.table !== 'there') console.warn(`[ai] the standard times table is not made yet: ${r.table}`)
    })
    .catch((e) => console.warn('[ai] the starter reports could not be made:', e instanceof Error ? e.message : String(e)))
}

// App Service sends SIGTERM on restart/scale-in: stop accepting, finish
// in-flight requests, then release the pools.
function shutdown(signal: string) {
  console.log(`[api] ${signal} received, shutting down`)
  // The answers being written are handed back at once, for the next instance to continue; their streams end,
  // so the server can close. Then the engine, while requests drain: it takes nothing more, and the runs under
  // way are cut short and handed back at once, so another instance takes them.
  const answersStopped = answers.stop()
  const engineStopped = automations?.stop() ?? Promise.resolve()
  const pushStopped = push?.stop() ?? Promise.resolve()
  const sweeperStopped = excelFiles?.stop() ?? Promise.resolve()
  const tablesStopped = savedTables?.stop() ?? Promise.resolve()
  server.close(() => {
    Promise.allSettled([answersStopped, engineStopped, pushStopped, sweeperStopped, tablesStopped])
      .then(() => Promise.allSettled([db.end(), aiReader.end()]))
      .finally(() => process.exit(0))
  })
  setTimeout(() => process.exit(1), 10_000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
