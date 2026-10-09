import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { ApiErrorBody } from '@qc/shared/api'
import { AI_DEFAULT_MONTHLY_CAP_USD, AI_MODEL, type AiSettingsResponse, type AiStatusResponse } from '@qc/shared/ai'
import { TestApp, type Session } from './harness'
import { resolveApiKey } from '../src/ai/credentials'
import { runReadOnlyQuery } from '../src/ai/runQuery'

// §20 — who may use the assistant, its switch and cap, and the API key: set
// in the app, checked with Anthropic first, kept encrypted, never shown,
// never logged, never in the audit trail.

const app = new TestApp()
let admin: Session
let other: Session
let sup: Session
let insp: Session
let viewer: Session

const KEY = `sk-ant-api03-${'Q7r_'.repeat(20)}kZ9x`
const NEW_KEY = `sk-ant-api03-${'b4-N'.repeat(20)}Wq2e`

const settings = (s: Session) => app.api<AiSettingsResponse>('GET', '/api/ai/settings', { token: s.token })
const status = (s: Session = admin) => app.api<AiStatusResponse>('GET', '/api/ai/status', { token: s.token })
const ask = (s: Session = admin) => app.api<ApiErrorBody>('POST', '/api/ai/chat', { token: s.token, body: { message: 'How many machines are there?', clientId: randomUUID() } })

/** Every row of every table in public, as text — what a copy of the database would hold. */
async function databaseText(): Promise<string> {
  const { rows } = await app.db.query<{ name: string }>(`SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public'`)
  const parts: string[] = []
  for (const { name } of rows) {
    const dump = await app.db.query<{ t: string | null }>(`SELECT string_agg(x::text, E'\\n') AS t FROM public.${name} x`)
    parts.push(dump.rows[0].t ?? '')
  }
  return parts.join('\n')
}

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  admin = await app.register('admin', 'Admin')
  for (const [username, name, role] of [
    ['admin2', 'Second Admin', 'admin'],
    ['sup', 'Super', 'supervisor'],
    ['insp', 'Inspector', 'inspector'],
    ['watch', 'Viewer', 'viewer'],
  ]) {
    await app.api('POST', '/api/users', { token: admin.token, body: { username, password: 'Password#1', name, role } })
  }
  other = await app.login('admin2')
  sup = await app.login('sup')
  insp = await app.login('insp')
  viewer = await app.login('watch')
})
afterAll(() => app.stop())

describe('§20 who may use the assistant', () => {
  it('refuses everyone but administrators, on every route', async () => {
    const id = randomUUID()
    const routes: [string, string, unknown?][] = [
      ['GET', '/api/ai/status'],
      ['GET', '/api/ai/settings'],
      ['PUT', '/api/ai/settings', { enabled: true, monthlyCapUsd: 10 }],
      ['PUT', '/api/ai/key', { apiKey: KEY }],
      ['DELETE', '/api/ai/key'],
      ['GET', '/api/ai/conversations'],
      ['GET', `/api/ai/conversations/${id}/messages`],
      ['DELETE', `/api/ai/conversations/${id}`],
      ['POST', '/api/ai/chat', { message: 'hello', clientId: randomUUID() }],
      ['GET', `/api/ai/queries/${id}/export`],
      ['GET', '/api/ai/usage'],
    ]
    for (const s of [sup, insp, viewer]) {
      for (const [method, path, body] of routes) {
        const res = await app.api(method, path, { token: s.token, body })
        expect(res.status, `${s.user.role} ${method} ${path}`).toBe(403)
      }
    }
    expect((await app.api('GET', '/api/ai/status')).status).toBe(401)
    expect(app.model.checkedKeys).toEqual([])
  })
})

describe('§20 the API key', () => {
  it('starts with no key: the assistant says so, and a question is refused before any stream', async () => {
    const res = await status()
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ available: false, reason: 'no-key', model: AI_MODEL, spentUsd: 0, capUsd: AI_DEFAULT_MONTHLY_CAP_USD })
    expect(res.body.monthStart).toMatch(/^\d{4}-\d{2}-01T00:00:00\.000Z$/)
    const s = await settings(admin)
    expect(s.body.key).toEqual({ set: false, source: null })
    expect(s.body.settings).toEqual({ enabled: true, monthlyCapUsd: AI_DEFAULT_MONTHLY_CAP_USD })
    const q = await ask()
    expect(q.status).toBe(503)
    expect(q.headers.get('content-type')).toMatch(/application\/json/)
    expect(q.body.error.code).toBe('ai_unavailable')
    expect(q.body.error.message).toMatch(/Administration → AI assistant/)
  })

  it('checks the shape of a key before asking Anthropic', async () => {
    for (const apiKey of ['', 'k3y-9q', 'sk-live-abcdefghijklmnopqrstuvwxyz', `sk-ant-${'x'.repeat(300)}`, 'sk-ant-api03 with-a-space-inside-it']) {
      const res = await app.api<ApiErrorBody>('PUT', '/api/ai/key', { token: admin.token, body: { apiKey } })
      expect(res.status, apiKey.slice(0, 20)).toBe(400)
      // A refused key is not echoed back.
      if (apiKey) expect(JSON.stringify(res.body)).not.toContain(apiKey)
    }
    expect(app.model.checkedKeys).toEqual([])
  })

  it('keeps a key only when Anthropic accepts it', async () => {
    app.model.keyCheck = () => ({ ok: false, reason: 'refused' })
    const refused = await app.api<ApiErrorBody>('PUT', '/api/ai/key', { token: admin.token, body: { apiKey: KEY } })
    expect(refused.status).toBe(400)
    expect(refused.body.error.message).toBe('Anthropic refused this key.')
    app.model.keyCheck = () => ({ ok: false, reason: 'unreachable' })
    const offline = await app.api<ApiErrorBody>('PUT', '/api/ai/key', { token: admin.token, body: { apiKey: KEY } })
    expect(offline.status).toBe(503)
    expect(offline.body.error.code).toBe('ai_unavailable')
    app.model.keyCheck = () => ({ ok: false, reason: 'no-model' })
    expect((await app.api('PUT', '/api/ai/key', { token: admin.token, body: { apiKey: KEY } })).status).toBe(400)
    expect((await settings(admin)).body.key.set).toBe(false)
    expect(app.model.checkedKeys).toEqual([KEY, KEY, KEY])
    app.model.keyCheck = () => ({ ok: true })
  })

  it('stores a good key encrypted, shows only its last four characters, and never returns it', async () => {
    // Whitespace around a pasted key is not part of it.
    const res = await app.api<AiSettingsResponse>('PUT', '/api/ai/key', { token: admin.token, body: { apiKey: `  ${KEY}\n` } })
    expect(res.status).toBe(200)
    expect(res.body.key).toMatchObject({ set: true, source: 'app', last4: 'kZ9x', updatedByName: 'Admin' })
    expect(res.body.key.unreadable).toBeUndefined()
    expect(res.body.status).toMatchObject({ available: true })
    expect(app.model.checkedKeys.at(-1)).toBe(KEY)
    for (const r of [res, await settings(admin), await settings(other), await status()]) expect(JSON.stringify(r.body)).not.toContain(KEY)

    // Nowhere in the database: not in clear, not as its bytes.
    const everything = await databaseText()
    expect(everything).not.toContain(KEY)
    expect(everything).not.toContain(Buffer.from(KEY, 'utf8').toString('hex'))
    const stored = await app.db.query<{ last4: string; keyVersion: number; ivLength: number }>(
      `SELECT last4, key_version AS "keyVersion", length(iv) AS "ivLength" FROM ai_credentials`,
    )
    expect(stored.rows).toEqual([{ last4: 'kZ9x', keyVersion: 1, ivLength: 12 }])
    // The app reads it back.
    const resolved = await resolveApiKey(app.db, app.config)
    expect(resolved.apiKey).toBe(KEY)

    // The audit trail names the change, never the key.
    const audit = await app.db.query<{ entity: string; entityId: string; field: string; oldValue: string; newValue: string; userName: string }>(
      `SELECT entity, entity_id AS "entityId", field, old_value AS "oldValue", new_value AS "newValue", user_name AS "userName"
         FROM audit_log WHERE entity = 'AiAssistant' ORDER BY id`,
    )
    expect(audit.rows).toEqual([{ entity: 'AiAssistant', entityId: 'api-key', field: 'apiKey', oldValue: 'not set', newValue: 'set (…kZ9x)', userName: 'Admin' }])
  })

  it('replaces and removes the key, each change audited', async () => {
    const replaced = await app.api<AiSettingsResponse>('PUT', '/api/ai/key', { token: other.token, body: { apiKey: NEW_KEY } })
    expect(replaced.body.key).toMatchObject({ last4: 'Wq2e', updatedByName: 'Second Admin' })
    expect((await resolveApiKey(app.db, app.config)).apiKey).toBe(NEW_KEY)
    const removed = await app.api<AiSettingsResponse>('DELETE', '/api/ai/key', { token: admin.token })
    expect(removed.status).toBe(200)
    expect(removed.body.key).toEqual({ set: false, source: null })
    expect(removed.body.status.reason).toBe('no-key')
    // Removing nothing changes nothing.
    expect((await app.api('DELETE', '/api/ai/key', { token: admin.token })).status).toBe(200)
    const audit = await app.db.query<{ oldValue: string; newValue: string }>(
      `SELECT old_value AS "oldValue", new_value AS "newValue" FROM audit_log WHERE entity = 'AiAssistant' ORDER BY id`,
    )
    expect(audit.rows).toEqual([
      { oldValue: 'not set', newValue: 'set (…kZ9x)' },
      { oldValue: 'set (…kZ9x)', newValue: 'set (…Wq2e)' },
      { oldValue: 'set (…Wq2e)', newValue: 'removed' },
    ])
    const everything = await databaseText()
    expect(everything).not.toContain(KEY)
    expect(everything).not.toContain(NEW_KEY)
    // The assistant's own view of the audit trail leaves these entries out altogether.
    const seen = await runReadOnlyQuery(app.aiReader.pool, `SELECT count(*) AS n FROM ai.audit_log WHERE entity = 'AiAssistant'`, {
      maxRows: 10,
      timeoutMs: 5000,
      timeZone: app.config.FACTORY_TIMEZONE,
    })
    expect(seen.rows).toEqual([[0]])
  })

  it('reports a key that can no longer be read once the server secret changed', async () => {
    await app.api('PUT', '/api/ai/key', { token: admin.token, body: { apiKey: KEY } })
    const rotated = await resolveApiKey(app.db, { ...app.config, JWT_SECRET: 'a-rotated-secret-a-rotated-secret-a-rotated' })
    expect(rotated.apiKey).toBeNull()
    expect(rotated.state).toMatchObject({ set: true, source: 'app', last4: 'kZ9x', unreadable: true })
  })
})

describe('§20 the switch and the monthly cap', () => {
  it('validates and audits a change of the settings', async () => {
    for (const body of [
      { enabled: true, monthlyCapUsd: -1 },
      { enabled: true, monthlyCapUsd: 2000.01 },
      { enabled: true, monthlyCapUsd: 12.345 },
      { enabled: 'yes', monthlyCapUsd: 10 },
      { enabled: true, monthlyCapUsd: 10, extra: 1 },
    ]) {
      expect((await app.api('PUT', '/api/ai/settings', { token: admin.token, body })).status, JSON.stringify(body)).toBe(400)
    }
    const res = await app.api<AiSettingsResponse>('PUT', '/api/ai/settings', { token: admin.token, body: { enabled: true, monthlyCapUsd: 12.3 } })
    expect(res.status).toBe(200)
    expect(res.body.settings).toEqual({ enabled: true, monthlyCapUsd: 12.3 })
    expect(res.body.updatedByName).toBe('Admin')
    expect(res.body.status.capUsd).toBe(12.3)
    const audit = await app.db.query<{ field: string; oldValue: string; newValue: string }>(
      `SELECT field, old_value AS "oldValue", new_value AS "newValue" FROM audit_log WHERE entity = 'AppSettings' AND entity_id = 'ai-assistant' ORDER BY id`,
    )
    expect(audit.rows).toEqual([{ field: 'monthlyCapUsd', oldValue: '50', newValue: '12.3' }])
  })

  it('switched off, nobody can ask', async () => {
    const off = await app.api<AiSettingsResponse>('PUT', '/api/ai/settings', { token: admin.token, body: { enabled: false, monthlyCapUsd: 12.3 } })
    expect(off.body.status).toMatchObject({ available: false, reason: 'disabled' })
    const q = await ask()
    expect(q.status).toBe(503)
    expect(q.body.error.message).toMatch(/switched off/)
    await app.api('PUT', '/api/ai/settings', { token: admin.token, body: { enabled: true, monthlyCapUsd: 12.3 } })
    expect((await status()).body.available).toBe(true)
  })

  it('at the cap, a question is refused with 402 before anything streams', async () => {
    await app.db.query(`INSERT INTO ai_usage (user_id, model, output_tokens, cost_usd) VALUES ($1, $2, 1000000, 10)`, [admin.user.id, AI_MODEL])
    expect((await status()).body).toMatchObject({ available: true, spentUsd: 10, capUsd: 12.3 })
    await app.api('PUT', '/api/ai/settings', { token: admin.token, body: { enabled: true, monthlyCapUsd: 10 } })
    expect((await status()).body).toMatchObject({ available: false, reason: 'cap-reached', spentUsd: 10, capUsd: 10 })
    const q = await ask()
    expect(q.status).toBe(402)
    expect(q.body.error.code).toBe('ai_budget_reached')
    expect(q.body.error.message).toMatch(/\$10\.00/)
    // Last month's spend does not count against this month.
    await app.db.query(`UPDATE ai_usage SET created_at = date_trunc('month', now()) - interval '1 day'`)
    expect((await status()).body).toMatchObject({ available: true, spentUsd: 0 })
    expect(app.model.calls).toEqual([])
  })

  it('without its database reader, the assistant is unavailable and says why', async () => {
    await app.aiReader.end()
    try {
      expect((await status()).body).toMatchObject({ available: false, reason: 'reader-unavailable' })
      expect((await ask()).status).toBe(503)
    } finally {
      await app.aiReader.provision(app.db, app.config)
    }
    expect((await status()).body.available).toBe(true)
  })

  it('reports the reasons in order: off, then no key, then no reader, then the cap', async () => {
    await app.api('DELETE', '/api/ai/key', { token: admin.token })
    await app.api('PUT', '/api/ai/settings', { token: admin.token, body: { enabled: false, monthlyCapUsd: 0 } })
    expect((await status()).body.reason).toBe('disabled')
    await app.api('PUT', '/api/ai/settings', { token: admin.token, body: { enabled: true, monthlyCapUsd: 0 } })
    expect((await status()).body.reason).toBe('no-key')
    await app.api('PUT', '/api/ai/key', { token: admin.token, body: { apiKey: KEY } })
    expect((await status()).body.reason).toBe('cap-reached')
    await app.api('PUT', '/api/ai/settings', { token: admin.token, body: { enabled: true, monthlyCapUsd: 50 } })
  })
})

describe('§20 a key from the server environment', () => {
  it('wins over the key set in the app, and is shown as such', async () => {
    const envKey = `sk-ant-api03-${'E'.repeat(40)}nv01`
    const withEnv = new TestApp()
    await withEnv.start({ ANTHROPIC_API_KEY: envKey })
    try {
      await withEnv.resetDatabase()
      const boss = await withEnv.register('boss', 'Boss')
      const res = await withEnv.api<AiSettingsResponse>('GET', '/api/ai/settings', { token: boss.token })
      expect(res.body.key).toEqual({ set: true, source: 'environment', last4: 'nv01' })
      expect(res.body.status.available).toBe(true)
      expect(JSON.stringify(res.body)).not.toContain(envKey)
    } finally {
      await withEnv.stop()
    }
  })
})
