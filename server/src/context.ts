import type { Config } from './config'
import type { Db } from './db/pool'
import type { ImageStorage } from './images/storage'
import { RateLimiter } from './lib/rateLimit'

/** Everything a route module needs, handed in once when the app is built. */
export interface AppContext {
  config: Config
  db: Db
  images: ImageStorage
  loginLimiter: RateLimiter
  version: string
}
