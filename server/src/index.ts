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

// §20 — the AI assistant's database reader. Idempotent, so it runs at every
// start whether or not migrations did; a failure leaves the assistant
// unavailable and everything else running.
const aiReader = new AiReader()
await aiReader.provision(db, config)

const images: ImageStorage =
  config.IMAGE_STORAGE_DRIVER === 'azure-blob'
    ? new AzureBlobImageStorage(config.AZURE_STORAGE_CONNECTION_STRING!, config.AZURE_STORAGE_CONTAINER)
    : new LocalImageStorage(path.resolve(config.IMAGE_LOCAL_DIR))

const ctx: AppContext = {
  config,
  db,
  images,
  loginLimiter: new RateLimiter(10, 15 * 60_000),
  version: readVersion(),
  ai: new AnthropicModelClient(),
  aiReader,
  aiLimiter: new RateLimiter(30, 10 * 60_000),
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

// App Service sends SIGTERM on restart/scale-in: stop accepting, finish
// in-flight requests, then release the pools.
function shutdown(signal: string) {
  console.log(`[api] ${signal} received, shutting down`)
  server.close(() => {
    Promise.allSettled([db.end(), aiReader.end()]).finally(() => process.exit(0))
  })
  setTimeout(() => process.exit(1), 10_000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
