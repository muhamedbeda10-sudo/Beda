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

const images: ImageStorage =
  config.IMAGE_STORAGE_DRIVER === 'azure-blob'
    ? new AzureBlobImageStorage(config.AZURE_STORAGE_CONNECTION_STRING!, config.AZURE_STORAGE_CONTAINER)
    : new LocalImageStorage(path.resolve(config.IMAGE_LOCAL_DIR))

const app = createApp({
  config,
  db,
  images,
  loginLimiter: new RateLimiter(10, 15 * 60_000),
  version: readVersion(),
})

const server = app.listen(config.PORT, () => {
  console.log(`[api] listening on :${config.PORT} (${config.NODE_ENV}, images=${config.IMAGE_STORAGE_DRIVER})`)
})

// App Service sends SIGTERM on restart/scale-in: stop accepting, finish
// in-flight requests, then release the pool.
function shutdown(signal: string) {
  console.log(`[api] ${signal} received, shutting down`)
  server.close(() => {
    db.end().finally(() => process.exit(0))
  })
  setTimeout(() => process.exit(1), 10_000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
