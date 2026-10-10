// ============================================================================
// §21 — what the automations' tests share: the people (the owner, a creator
// the owner allowed, a person given the assistant without automations, and
// others), a question asked in the chat and its stream read back, machines to
// watch (ai.machines is readable by every set of domains), an automation put
// straight into the database for the engine's tests, and an engine over the
// test app with a clock the test turns.
// ============================================================================

import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import type { ApiErrorBody } from '@qc/shared/api'
import type { AiAccess, AiEffort, AiModelId, AiStreamEvent } from '@qc/shared/ai'
import type {
  AutomationActions,
  AutomationChannels,
  AutomationDraft,
  AutomationRecipient,
  AutomationScheduleSpec,
  AutomationStatus,
  AutomationWatchSpec,
} from '@qc/shared/automation'
import type { Db } from '../src/db/pool'
import { AutomationEngine, type EngineDeps } from '../src/automations/engine'
import { withoutIsolates } from '../src/automations/text'
import type { TestApp, Session } from './harness'

export const KEY = `sk-ant-api03-${'k_9-'.repeat(20)}LaSt`
export const ALL_DOMAINS = ['inspection', 'orders', 'materials', 'audit']

export interface People {
  owner: Session
  /** An inspector the owner gave the assistant and allowed to create automations (inspection data only). */
  creator: Session
  /** A second inspector allowed to create automations. */
  creator2: Session
  /** A supervisor given the assistant, not allowed to create automations. */
  plain: Session
  /** An administrator who is not the owner, without the assistant. */
  admin2: Session
  /** A viewer, without the assistant. */
  viewer: Session
}

export interface Grant {
  enabled?: boolean
  domains?: string[]
  model?: AiModelId
  effort?: AiEffort
  monthlyCapUsd?: number
  automations?: boolean
}

export async function grant(app: TestApp, owner: Session, person: Session, g: Grant = {}): Promise<AiAccess> {
  const body = { enabled: true, domains: ['inspection'], model: 'claude-sonnet-5-5', effort: 'medium', monthlyCapUsd: 50, ...g }
  const res = await app.api<AiAccess>('PUT', `/api/ai/access/${person.user.id}`, { token: owner.token, body })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return res.body
}

/** A fresh database with the people, the key set, and two machines registered. */
export async function setUp(app: TestApp): Promise<People> {
  await app.resetDatabase()
  const owner = await app.register('admin', 'Owner Admin')
  for (const [username, name, role] of [
    ['creator', 'Cara Creator', 'inspector'],
    ['creator2', 'Cyril Second', 'inspector'],
    ['plain', 'Paula Plain', 'supervisor'],
    ['admin2', 'Second Admin', 'admin'],
    ['watcher', 'Vera Viewer', 'viewer'],
  ]) {
    const made = await app.api('POST', '/api/users', { token: owner.token, body: { username, password: 'Password#1', name, role } })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
  }
  const people: People = {
    owner,
    creator: await app.login('creator'),
    creator2: await app.login('creator2'),
    plain: await app.login('plain'),
    admin2: await app.login('admin2'),
    viewer: await app.login('watcher'),
  }
  expect((await app.api('PUT', '/api/ai/key', { token: owner.token, body: { apiKey: KEY } })).status).toBe(200)
  await grant(app, owner, people.creator, { automations: true })
  await grant(app, owner, people.creator2, { automations: true })
  await grant(app, owner, people.plain)
  await addMachines(app.db, ['58', '31'])
  return people
}

/** Machines in the register: what ai.machines shows, and what the tests' watches watch. */
export async function addMachines(db: Db, codes: string[]): Promise<void> {
  for (const code of codes) {
    await db.query(`INSERT INTO machines (code, name, display_name, process) VALUES ($1, $2, $3, 'forming')`, [code, `Machine ${code}`, `${code}. Machine`])
  }
}

export const MACHINES_SQL = `SELECT machine_code, machine FROM ai.machines ORDER BY machine_code`

export function watchDraft(over: Partial<AutomationDraft> = {}, watch: Partial<AutomationWatchSpec> = {}): AutomationDraft {
  return {
    kind: 'watch',
    name: 'New machines',
    description: 'Tells the supervisors about every machine added to the register.',
    language: 'en',
    watch: { sql: MACHINES_SQL, keyColumn: 'machine_code', everyMinutes: 5, titleTemplate: 'New machine {{machine}}', bodyTemplate: 'Code {{machine_code}}', ...watch },
    recipients: [{ kind: 'role', role: 'supervisor' }],
    channels: { bell: true, chat: false },
    actions: { notify: true, followUp: null },
    ...over,
  }
}

export function reportDraft(over: Partial<AutomationDraft> = {}, schedule: Partial<AutomationScheduleSpec> = {}): AutomationDraft {
  return {
    kind: 'report',
    name: 'Machine register',
    description: 'The machines in the register, every morning.',
    language: 'en',
    schedule: { cadence: 'daily', time: '08:00', sections: [{ title: 'Machines', sql: 'SELECT count(*)::int AS machines FROM ai.machines' }], summary: false, ...schedule },
    recipients: [{ kind: 'role', role: 'supervisor' }],
    channels: { bell: true, chat: false },
    actions: { notify: true, followUp: null },
    ...over,
  }
}

export interface NewAutomation {
  creatorId: string
  kind?: 'watch' | 'report'
  name?: string
  watch?: AutomationWatchSpec
  schedule?: AutomationScheduleSpec
  recipients?: AutomationRecipient[]
  channels?: AutomationChannels
  actions?: AutomationActions
  status?: AutomationStatus
  nextRunAt?: Date | null
  language?: 'ar' | 'en'
}

/** An automation put straight into the database (the engine's tests): as an activation would leave it, minus the baseline. */
export async function insertAutomation(db: Db, a: NewAutomation): Promise<string> {
  const kind = a.kind ?? (a.schedule ? 'report' : 'watch')
  const watch = kind === 'watch' ? (a.watch ?? watchDraft().watch!) : null
  const schedule = kind === 'report' ? (a.schedule ?? reportDraft().schedule!) : null
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO ai_automations (creator_id, kind, name, description, language, watch, schedule, recipients, channels, actions, status, next_run_at, result_columns)
     VALUES ($1, $2, $3, 'A test automation.', $4, $5::json, $6::json, $7::json, $8::json, $9::json, $10, $11, $12::json) RETURNING id`,
    [
      a.creatorId,
      kind,
      a.name ?? (kind === 'watch' ? 'New machines' : 'Machine register'),
      a.language ?? 'en',
      watch ? JSON.stringify(watch) : null,
      schedule ? JSON.stringify(schedule) : null,
      JSON.stringify(a.recipients ?? [{ kind: 'role', role: 'supervisor' }]),
      JSON.stringify(a.channels ?? { bell: true, chat: false }),
      JSON.stringify(a.actions ?? { notify: true, followUp: null }),
      a.status ?? 'active',
      a.nextRunAt === undefined ? new Date().toISOString() : a.nextRunAt ? a.nextRunAt.toISOString() : null,
      watch ? JSON.stringify(['machine_code', 'machine']) : null,
    ],
  )
  return rows[0].id
}

/** A clock the test sets, and an engine that reads it. */
export class Clock {
  constructor(public at: Date = new Date()) {}
  now = () => new Date(this.at)
  advance(ms: number): Date {
    this.at = new Date(this.at.getTime() + ms)
    return this.now()
  }
}

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE

export function engineFor(app: TestApp, clock: Clock, db: Db = app.db): AutomationEngine {
  return new AutomationEngine(depsFor(app, db), { now: clock.now })
}

export function depsFor(app: TestApp, db: Db = app.db): EngineDeps {
  return { db, config: app.config, readers: app.aiReader, model: app.model }
}

type Done = Extract<AiStreamEvent, { type: 'done' }>

export interface Asked {
  status: number
  events: AiStreamEvent[]
  done?: Done
  error?: ApiErrorBody['error']
  conversationId: string
}

/** Ask the assistant; the stream read back as events. */
export async function ask(app: TestApp, as: Session, message: string, conversationId?: string): Promise<Asked> {
  const res = await app.api<string | ApiErrorBody>('POST', '/api/ai/chat', {
    token: as.token,
    body: { message, clientId: randomUUID(), ...(conversationId ? { conversationId } : {}) },
  })
  if (res.status !== 200) return { status: res.status, events: [], error: (res.body as ApiErrorBody).error, conversationId: '' }
  const events = (res.body as string)
    .split('\n\n')
    .filter((f) => f && !f.startsWith(':'))
    .map((f) => JSON.parse(f.slice(f.indexOf('data: ') + 6)) as AiStreamEvent)
  const done = events.find((e): e is Done => e.type === 'done')
  const start = events.find((e): e is Extract<AiStreamEvent, { type: 'start' }> => e.type === 'start')
  return { status: res.status, events, done, conversationId: start?.conversation.id ?? '' }
}

/** Text as it reads: the isolates that set values apart (automations/text.ts) left out. */
export const plain = (text: string): string => withoutIsolates(text)

/** The bell's alerts a person has, oldest first, their words as they read (`raw` keeps the isolates). */
export async function alertsOf(db: Db, userId: string, raw = false): Promise<{ kind: string; title: string; body: string; link: string | null; severity: string }[]> {
  const { rows } = await db.query<{ kind: string; title: string; body: string; link: string | null; severity: string }>(
    `SELECT kind, title, body, link, severity FROM user_notifications WHERE user_id = $1 ORDER BY created_at, id`,
    [userId],
  )
  return raw ? rows : rows.map((r) => ({ ...r, title: plain(r.title), body: plain(r.body) }))
}

/** The chat messages the system sender wrote to a person, oldest first, as they read (`raw` keeps the isolates). */
export async function systemMessagesTo(db: Db, userId: string, raw = false): Promise<string[]> {
  const { rows } = await db.query<{ body: string }>(
    `SELECT m.body FROM chat_messages m
       JOIN chat_members me ON me.conversation_id = m.conversation_id AND me.user_id = $1
       JOIN users s ON s.id = m.sender_id AND s.is_system
      ORDER BY m.created_at, m.id`,
    [userId],
  )
  return rows.map((r) => (raw ? r.body : plain(r.body)))
}

/** An automation's runs, oldest first, as stored. */
export async function runsOf(db: Db, automationId: string) {
  const { rows } = await db.query<{
    id: string
    trigger: string
    ok: boolean | null
    error: string | null
    matched: number | null
    fired: number | null
    notified: number | null
    followUps: number | null
    casesNotified: number
    digest: boolean
    note: string | null
    deliveryId: string | null
    startedAt: string
  }>(
    `SELECT id, trigger, ok, error, matched, fired, notified, follow_ups AS "followUps", cases_notified AS "casesNotified", digest, note,
            delivery_id AS "deliveryId", started_at AS "startedAt"
       FROM ai_automation_runs WHERE automation_id = $1 ORDER BY started_at, id`,
    [automationId],
  )
  return rows
}
