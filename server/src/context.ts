import type { Config } from './config'
import type { Db } from './db/pool'
import type { ImageStorage } from './images/storage'
import type { AiModelClient } from './ai/model'
import type { AiReader } from './ai/reader'
import { RateLimiter } from './lib/rateLimit'
import type { PushSender } from './push/send'

/** Everything a route module needs, handed in once when the app is built. */
export interface AppContext {
  config: Config
  db: Db
  images: ImageStorage
  loginLimiter: RateLimiter
  version: string
  /** §20 — the model behind the AI assistant: Anthropic in production, a scripted stand-in in tests. */
  ai: AiModelClient
  /** §20 — the assistant's read-only way into the database, set up at start. */
  aiReader: AiReader
  /** §20 — questions per person, so one runaway client cannot spend the month's cap in minutes. */
  aiLimiter: RateLimiter
  /** §20 — saved reports run or exported per person: free, but every run reads the database. */
  aiReportLimiter: RateLimiter
  /** §24 — how a push is sent: web-push in production, a recorder in tests. */
  pushSender?: PushSender
}
