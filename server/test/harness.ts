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
import type { AuthResponse, PushPayload } from '@qc/shared/api'
import { loadConfig, type Config } from '../src/config'
import { createPool, type Db } from '../src/db/pool'
import { migrate } from '../src/db/migrate'
import { createApp } from '../src/app'
import { LocalImageStorage } from '../src/images/storage'
import { RateLimiter } from '../src/lib/rateLimit'
import type { AiModelClient } from '../src/ai/model'
import { AiReader } from '../src/ai/reader'
import { ScriptedModel } from './aiFake'
import type { PushSender } from '../src/push/send'

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
  images!: LocalImageStorage
  server!: Server
  baseUrl!: string
  config!: Config
  /** §20 — the assistant's database readers, provisioned after every reset. */
  aiReader = new AiReader()
  /** §20 — the model the app talks to: scripted by each test, never the network. */
  model = new ScriptedModel()
  /** §20 — questions per person, as in production (30 per 10 minutes). */
  aiLimiter = new RateLimiter(30, 10 * 60_000)
  /** §20 — saved reports run or exported per person, as in production (60 per 10 minutes). */
  aiReportLimiter = new RateLimiter(60, 10 * 60_000)
  /** §24 — the pushes the app sent, as a push service would have received them; an endpoint listed in `gone` answers 410. */
  pushes: { endpoint: string; payload: PushPayload }[] = []
  gonePushEndpoints = new Set<string>()
  pushSender: PushSender = async (target, payload) => {
    if (this.gonePushEndpoints.has(target.endpoint)) throw Object.assign(new Error('Gone'), { statusCode: 410 })
    this.pushes.push({ endpoint: target.endpoint, payload: JSON.parse(payload) as PushPayload })
    return { statusCode: 201 }
  }
  private tmpDir!: string

  async start(overrides: Partial<NodeJS.ProcessEnv> = {}, options: { ai?: AiModelClient } = {}): Promise<this> {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://qc:qc@127.0.0.1:5432/qc_test',
      JWT_SECRET: 'test-secret-test-secret-test-secret-test-secret',
      ACCESS_TOKEN_TTL: '15m',
      IMAGE_STORAGE_DRIVER: 'local',
      RUN_MIGRATIONS_ON_START: 'false',
      SEED_DEMO_DATA: 'false',
      // §20 — the account that owns the AI assistant: the first one most files register.
      AI_OWNER_USERNAME: 'admin',
      ...overrides,
    }
    this.config = loadConfig(env)
    this.db = createPool(this.config.DATABASE_URL, 5)
    this.tmpDir = await mkdtemp(path.join(os.tmpdir(), 'qc-images-'))
    this.images = new LocalImageStorage(this.tmpDir)
    const app = createApp({
      config: this.config,
      db: this.db,
      images: this.images,
      loginLimiter: new RateLimiter(10, 15 * 60_000),
      version: 'test',
      ai: options.ai ?? this.model,
      aiReader: this.aiReader,
      aiLimiter: this.aiLimiter,
      aiReportLimiter: this.aiReportLimiter,
      pushSender: this.pushSender,
    })
    await new Promise<void>((resolve) => {
      this.server = app.listen(0, '127.0.0.1', () => resolve())
    })
    const { port } = this.server.address() as AddressInfo
    this.baseUrl = `http://127.0.0.1:${port}`
    return this
  }

  /** Drop everything and re-run the migrations from scratch, then set up the assistant's reader as the API does at start. */
  async resetDatabase(): Promise<void> {
    await this.db.query('DROP SCHEMA IF EXISTS ai CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
    await migrate(this.db)
    await this.aiReader.provision(this.db, this.config)
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
    await this.aiReader.end()
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

  async register(username: string, name: string, password = 'Password#1'): Promise<Session> {
    const res = await this.api<AuthResponse>('POST', '/api/auth/register', { body: { username, password, name } })
    if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`)
    return { token: res.body.accessToken, user: res.body.user, cookie: cookieOf(res.cookies) }
  }

  async login(username: string, password = 'Password#1'): Promise<Session> {
    const res = await this.api<AuthResponse>('POST', '/api/auth/login', { body: { username, password } })
    if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`)
    return { token: res.body.accessToken, user: res.body.user, cookie: cookieOf(res.cookies) }
  }
}

/**
 * The factory's calendar day, whole days away from today. The API counts days
 * in the factory's time zone (Africa/Cairo unless FACTORY_TIMEZONE says
 * otherwise), so a test naming "today" must name the same day: the UTC date
 * is a day behind it every evening.
 */
export function factoryDay(offsetDays = 0): string {
  const zone = process.env.FACTORY_TIMEZONE || 'Africa/Cairo'
  const local = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const d = new Date(`${local}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + offsetDays)
  return d.toISOString().slice(0, 10)
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
