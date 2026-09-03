// ============================================================================
// Integration-test harness: a real PostgreSQL database (reset per file), the
// real Express app on an ephemeral port, and a tiny typed HTTP client.
//
//   TEST_DATABASE_URL  defaults to postgresql://qc:qc@127.0.0.1:5432/qc_test
// ============================================================================

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type { AuthResponse } from '@qc/shared/api'
import { loadConfig, type Config } from '../src/config'
import { createPool, type Db } from '../src/db/pool'
import { migrate } from '../src/db/migrate'
import { createApp } from '../src/app'
import { LocalImageStorage } from '../src/images/storage'
import { RateLimiter } from '../src/lib/rateLimit'

export interface ApiResponse<T = unknown> {
  status: number
  body: T
  headers: Headers
  /** Set-Cookie values, for the refresh cookie. */
  cookies: string[]
}

export interface Session {
  token: string
  user: AuthResponse['user']
  cookie: string
}

export class TestApp {
  db!: Db
  server!: Server
  baseUrl!: string
  config!: Config
  private tmpDir!: string

  async start(overrides: Partial<NodeJS.ProcessEnv> = {}): Promise<this> {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://qc:qc@127.0.0.1:5432/qc_test',
      JWT_SECRET: 'test-secret-test-secret-test-secret-test-secret',
      ACCESS_TOKEN_TTL: '15m',
      IMAGE_STORAGE_DRIVER: 'local',
      RUN_MIGRATIONS_ON_START: 'false',
      SEED_DEMO_DATA: 'false',
      ...overrides,
    }
    this.config = loadConfig(env)
    this.db = createPool(this.config.DATABASE_URL, 5)
    this.tmpDir = await mkdtemp(path.join(os.tmpdir(), 'qc-images-'))
    const app = createApp({
      config: this.config,
      db: this.db,
      images: new LocalImageStorage(this.tmpDir),
      loginLimiter: new RateLimiter(10, 15 * 60_000),
      version: 'test',
    })
    await new Promise<void>((resolve) => {
      this.server = app.listen(0, '127.0.0.1', () => resolve())
    })
    const { port } = this.server.address() as AddressInfo
    this.baseUrl = `http://127.0.0.1:${port}`
    return this
  }

  /** Drop everything and re-run the migrations from scratch. */
  async resetDatabase(): Promise<void> {
    await this.db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
    await migrate(this.db)
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
    await this.db.end()
    await rm(this.tmpDir, { recursive: true, force: true })
  }

  async api<T = unknown>(
    method: string,
    urlPath: string,
    options: { body?: unknown; token?: string; cookie?: string; raw?: RequestInit['body']; headers?: Record<string, string> } = {},
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = { ...(options.headers ?? {}) }
    if (options.token) headers.authorization = `Bearer ${options.token}`
    if (options.cookie) headers.cookie = options.cookie
    let body: RequestInit['body']
    if (options.raw !== undefined) body = options.raw
    else if (options.body !== undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(options.body)
    }
    const res = await fetch(`${this.baseUrl}${urlPath}`, { method, headers, body })
    const text = await res.text()
    let parsed: unknown = text
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      /* not JSON */
    }
    return { status: res.status, body: parsed as T, headers: res.headers, cookies: res.headers.getSetCookie() }
  }

  async register(email: string, name: string, password = 'Password#1'): Promise<Session> {
    const res = await this.api<AuthResponse>('POST', '/api/auth/register', { body: { email, password, name } })
    if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`)
    return { token: res.body.accessToken, user: res.body.user, cookie: cookieOf(res.cookies) }
  }

  async login(email: string, password = 'Password#1'): Promise<Session> {
    const res = await this.api<AuthResponse>('POST', '/api/auth/login', { body: { email, password } })
    if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`)
    return { token: res.body.accessToken, user: res.body.user, cookie: cookieOf(res.cookies) }
  }
}

export function cookieOf(setCookies: string[]): string {
  const c = setCookies.find((x) => x.startsWith('qc_refresh='))
  return c ? c.split(';')[0] : ''
}

/** A minimal but real JPEG: SOI, a tiny APP0 segment, EOI. Enough for the
 *  server's magic-byte check and for hashing. */
export function tinyJpeg(seed = 1): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00])
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, Buffer.from([seed & 0xff, (seed >> 8) & 0xff]), Buffer.from([0xff, 0xd9])])
}
