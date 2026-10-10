import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest'
import type { ApiErrorBody, AuditListResponse, AuditOptionsResponse, AuditStats } from '@qc/shared/api'
import type { AiAccess, AiAccessListResponse, AiMeResponse } from '@qc/shared/ai'
import type { Automation, AutomationPeopleResponse, AutomationRun, AutomationRunsResponse, AutomationsResponse, AutomationTestResponse } from '@qc/shared/automation'
import { ROLES } from '@qc/shared/types'
import { runReadOnlyQuery } from '../src/ai/runQuery'
import { isolate } from '../src/automations/text'
import { TestApp } from './harness'
import { alertsOf, grant, insertAutomation, runsOf, setUp, watchDraft, type People } from './automationsKit'

// §21 — the Automations page's routes and who may use them: people who may
// not create automations get 404 from every one; a creator sees and changes
// their own; the owner, everyone's. Changes are audited for the owner's eyes;
// runs are recorded, never audited. The permission itself is the owner's to
// give, person by person, on the assistant's access list.

const app = new TestApp()
let p: People
let mine: string
let theirs: string
let report: string

const get = <T>(path: string, as = p.creator) => app.api<T>('GET', path, { token: as.token })
const post = <T>(path: string, as = p.creator, body?: unknown) => app.api<T>('POST', path, { token: as.token, body })
const patch = <T>(path: string, body: unknown, as = p.creator) => app.api<T>('PATCH', path, { token: as.token, body })

beforeAll(async () => {
  await app.start()
  p = await setUp(app)
})
afterAll(() => app.stop())
beforeEach(async () => {
  await app.db.query(`UPDATE ai_automations SET deleted_at = now(), next_run_at = NULL WHERE deleted_at IS NULL`)
  mine = await insertAutomation(app.db, { creatorId: p.creator.user.id, name: 'Mine', nextRunAt: null, status: 'paused' })
  theirs = await insertAutomation(app.db, { creatorId: p.creator2.user.id, name: 'Theirs', nextRunAt: null, status: 'paused' })
  report = await insertAutomation(app.db, { creatorId: p.creator.user.id, kind: 'report', name: 'My report', nextRunAt: null, status: 'paused' })
  for (const s of Object.values(p)) app.aiLimiter.reset(s.user.id)
})

describe('§21 who may create automations', () => {
  it('is the owner, and the people the owner allows: /me says so, the access list shows it, the owner sets it', async () => {
    const me = async (s = p.creator) => (await get<AiMeResponse>('/api/ai/me', s)).body.automations
    expect(await me(p.owner)).toBe(true)
    expect(await me(p.creator)).toBe(true)
    for (const s of [p.plain, p.admin2, p.viewer]) expect(await me(s), s.user.name).toBe(false)
    const list = (await get<AiAccessListResponse>('/api/ai/access', p.owner)).body.people
    expect(list.map((a) => [a.username, a.automations])).toEqual([
      ['admin', true],
      ['creator', true],
      ['creator2', true],
      ['plain', false],
    ])
    // Left out of a change, the permission stays as it is; changed, it is audited like the rest of the row.
    const kept = await app.api<AiAccess>('PUT', `/api/ai/access/${p.creator.user.id}`, {
      token: p.owner.token,
      body: { enabled: true, domains: ['inspection'], model: 'claude-sonnet-5-5', effort: 'medium', monthlyCapUsd: 40 },
    })
    expect(kept.body).toMatchObject({ automations: true, monthlyCapUsd: 40 })
    await grant(app, p.owner, p.creator, { automations: false })
    expect(await me(p.creator)).toBe(false)
    await grant(app, p.owner, p.creator, { automations: true })
    const audit = await get<AuditListResponse>(`/api/audit?entity=AiAccess&limit=200`, p.owner)
    expect(audit.body.entries.filter((e) => e.entityId === p.creator.user.id && e.field === 'automations').map((e) => [e.oldValue, e.newValue])).toEqual([
      ['may not create', 'may create'],
      ['may create', 'may not create'],
    ])
    // Nobody else may set it: the owner's routes do not exist for them.
    expect((await app.api('PUT', `/api/ai/access/${p.plain.user.id}`, { token: p.admin2.token, body: { enabled: true, domains: ['inspection'], model: 'claude-sonnet-5-5', effort: 'medium', monthlyCapUsd: 5, automations: true } })).status).toBe(404)
  })
})

describe('§21 the routes, by who asks', () => {
  const routes = (id: string) =>
    [
      ['GET', '/api/automations'],
      ['GET', '/api/automations/people'],
      ['GET', `/api/automations/${id}`],
      ['PATCH', `/api/automations/${id}`],
      ['POST', `/api/automations/${id}/pause`],
      ['POST', `/api/automations/${id}/resume`],
      ['POST', `/api/automations/${id}/run`],
      ['POST', `/api/automations/${id}/test`],
      ['GET', `/api/automations/${id}/runs`],
      ['DELETE', `/api/automations/${id}`],
      ['OPTIONS', `/api/automations/${id}`],
      ['POST', `/api/ai/automation-proposals/${id}/activate`],
      ['POST', `/api/ai/automation-proposals/${id}/discard`],
    ] as const

  it('answers 404 to everyone who may not create automations, as if none of it existed', async () => {
    for (const s of [p.plain, p.admin2, p.viewer]) {
      for (const [method, path] of routes(mine)) {
        const res = await app.api<ApiErrorBody>(method, path, { token: s.token, body: method === 'PATCH' ? { name: 'x' } : undefined })
        expect(res.status, `${s.user.name} ${method} ${path}`).toBe(404)
        if (method !== 'OPTIONS') expect(res.body.error.code).toBe('not_found')
      }
    }
    expect((await app.api('GET', '/api/automations')).status).toBe(401)
    // Nothing happened to it.
    expect((await get<Automation>(`/api/automations/${mine}`)).body).toMatchObject({ name: 'Mine', status: 'paused' })
  })

  it("shows a creator their own automations only; someone else's does not exist for them", async () => {
    const list = await get<AutomationsResponse>(`/api/automations?creator=${p.creator2.user.id}`)
    expect(list.body.automations.map((a) => a.name).sort()).toEqual(['Mine', 'My report'])
    for (const [method, path] of routes(theirs).slice(2, 10)) {
      const res = await app.api(method, path, { token: p.creator.token, body: method === 'PATCH' ? { name: 'x' } : undefined })
      expect(res.status, `${method} ${path}`).toBe(404)
    }
    expect((await get<Automation>(`/api/automations/${theirs}`, p.creator2)).body.name).toBe('Theirs')
  })

  it("shows the owner everyone's, one person's on asking, and lets the owner change any", async () => {
    const all = await get<AutomationsResponse>('/api/automations', p.owner)
    expect(all.body.automations.map((a) => a.name).sort()).toEqual(['Mine', 'My report', 'Theirs'])
    const one = await get<AutomationsResponse>(`/api/automations?creator=${p.creator2.user.id}`, p.owner)
    expect(one.body.automations.map((a) => [a.name, a.creator.name])).toEqual([['Theirs', 'Cyril Second']])
    const renamed = await patch<Automation>(`/api/automations/${theirs}`, { name: 'Theirs, renamed by the owner' }, p.owner)
    expect(renamed.status).toBe(200)
    expect(renamed.body).toMatchObject({ name: 'Theirs, renamed by the owner', updatedByName: 'Owner Admin', creator: { id: p.creator2.user.id } })
    expect((await post<Automation>(`/api/automations/${theirs}/resume`, p.owner)).body.status).toBe('active')
    expect((await post<Automation>(`/api/automations/${theirs}/pause`, p.owner)).body.status).toBe('paused')
    expect((await app.api('DELETE', `/api/automations/${theirs}`, { token: p.owner.token })).status).toBe(204)
    expect((await get(`/api/automations/${theirs}`, p.creator2)).status).toBe(404)
  })

  it('offers active accounts as recipients, never the system sender, and the roles', async () => {
    const res = await get<AutomationPeopleResponse>('/api/automations/people')
    expect(res.body.roles).toEqual([...ROLES])
    const usernames = res.body.people.map((x) => x.username)
    expect(usernames).toEqual(expect.arrayContaining(['admin', 'creator', 'creator2', 'plain', 'admin2', 'watcher']))
    expect(usernames.some((u) => u.startsWith('qc-automations'))).toBe(false)
    await app.db.query(`UPDATE users SET is_active = false WHERE id = $1`, [p.viewer.user.id])
    expect((await get<AutomationPeopleResponse>('/api/automations/people')).body.people.map((x) => x.username)).not.toContain('watcher')
    await app.db.query(`UPDATE users SET is_active = true WHERE id = $1`, [p.viewer.user.id])
  })
})

describe('§21 an automation, changed outside the chat', () => {
  it('shows its people by name, and marks those who can no longer be told', async () => {
    await app.db.query(`UPDATE ai_automations SET recipients = $2::json, actions = $3::json WHERE id = $1`, [
      mine,
      JSON.stringify([{ kind: 'user', userId: p.viewer.user.id }, { kind: 'role', role: 'admin' }, { kind: 'column', column: 'gone' }]),
      JSON.stringify({ notify: true, followUp: { assignee: { kind: 'creator' }, dueHours: 8 } }),
    ])
    await app.db.query(`UPDATE users SET is_active = false WHERE id = $1`, [p.viewer.user.id])
    const a = (await get<Automation>(`/api/automations/${mine}`)).body
    expect(a.recipients).toEqual([
      { kind: 'user', userId: p.viewer.user.id, label: 'Vera Viewer', invalid: true },
      { kind: 'role', role: 'admin', label: 'Every administrator' },
      { kind: 'column', column: 'gone', label: 'People in "gone"', invalid: true },
    ])
    expect(a.assignee).toEqual({ kind: 'creator', label: 'Cara Creator (creator)' })
    expect(a).not.toHaveProperty('conversationId')
    await app.db.query(`UPDATE users SET is_active = true WHERE id = $1`, [p.viewer.user.id])
  })

  it('checks a change like a draft (its queries as they are), and audits it field by field', async () => {
    const wrong: [unknown, RegExp][] = [
      [{ everyMinutes: 3 }, /^watch\.everyMinutes: from 5 to 1440/],
      [{ recipients: [{ kind: 'user', userId: '00000000-0000-4000-8000-000000000000' }] }, /no active account/],
      [{ recipients: [{ kind: 'column', column: 'inspector_id' }] }, /the result has no column "inspector_id"/],
      [{ cadence: 'weekly' }, /^cadence: only a scheduled report has one/],
      [{ channels: { bell: false, chat: false } }, /^channels: choose/],
      [{ name: '' }, /^name: give the automation a name/],
      [{ sql: 'SELECT 1' }, /Unrecognized key/],
    ]
    for (const [body, expected] of wrong) {
      const res = await patch<ApiErrorBody>(`/api/automations/${mine}`, body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(res.body.error.message, JSON.stringify(body)).toMatch(expected)
    }
    const ok = await patch<Automation>(`/api/automations/${mine}`, {
      name: 'Mine, renamed',
      everyMinutes: 30,
      recipients: [{ kind: 'user', userId: p.plain.user.id }, { kind: 'column', column: 'machine_code' }],
      channels: { bell: true, chat: true },
    })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(ok.body).toMatchObject({ name: 'Mine, renamed', watch: { everyMinutes: 30, sql: watchDraft().watch!.sql }, channels: { bell: true, chat: true }, updatedByName: 'Cara Creator' })
    const audit = await get<AuditListResponse>(`/api/audit?entity=Automation&limit=200`, p.owner)
    const changes = audit.body.entries.filter((e) => e.entityId === mine).map((e) => [e.field, e.oldValue, e.newValue])
    expect(changes).toEqual(
      expect.arrayContaining([
        ['name', 'Mine', 'Mine, renamed'],
        ['interval', 'Every 5 minutes', 'Every 30 minutes'],
        ['recipients', 'Every supervisor', 'Paula Plain, People in "machine_code"'],
        ['channels', 'bell', 'bell, chat'],
      ]),
    )
    expect(changes.some(([field]) => field === 'queries')).toBe(false)
    // A report's schedule: its next run follows at once, while it is on.
    await post(`/api/automations/${report}/resume`)
    const weekly = await patch<Automation>(`/api/automations/${report}`, { cadence: 'weekly', weekday: 3, time: '06:15', period: { kind: 'last_week', weekStart: 'saturday' } })
    expect(weekly.status, JSON.stringify(weekly.body)).toBe(200)
    expect(weekly.body.schedule).toMatchObject({ cadence: 'weekly', weekday: 3, time: '06:15', period: { kind: 'last_week', weekStart: 'saturday' } })
    const at = new Date(weekly.body.nextRunAt!)
    expect(new Intl.DateTimeFormat('en-US', { timeZone: app.config.FACTORY_TIMEZONE, weekday: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at)).toBe('Wednesday 06:15')
    expect((await patch<ApiErrorBody>(`/api/automations/${report}`, { period: null, sections: [] })).status).toBe(400)
    expect((await patch<ApiErrorBody>(`/api/automations/${report}`, { everyMinutes: 10 })).body.error.message).toMatch(/only a watch has an interval/)
  })

  it('pauses, resumes and deletes, each audited; deleted, it is gone from every list', async () => {
    const paused = await post<Automation>(`/api/automations/${mine}/resume`)
    expect(paused.body).toMatchObject({ status: 'active' })
    expect(paused.body.nextRunAt).not.toBeNull()
    const p2 = await post<Automation>(`/api/automations/${mine}/pause`)
    expect(p2.body).toMatchObject({ status: 'paused', nextRunAt: null })
    expect((await app.api('DELETE', `/api/automations/${mine}`, { token: p.creator.token })).status).toBe(204)
    expect((await get(`/api/automations/${mine}`)).status).toBe(404)
    expect((await get<AutomationsResponse>('/api/automations', p.owner)).body.automations.map((a) => a.id)).not.toContain(mine)
    const audit = await get<AuditListResponse>(`/api/audit?entity=Automation&limit=200`, p.owner)
    expect(audit.body.entries.filter((e) => e.entityId === mine).map((e) => [e.action, e.field, e.oldValue, e.newValue])).toEqual([
      ['delete', 'automation', 'Mine', null],
      ['update', 'status', 'active', 'paused'],
      ['update', 'status', 'paused', 'active'],
    ].map(([a, f, o, n]) => [a, f, o, n ?? undefined]))
  })
})

describe('§21 running and testing', () => {
  it('runs now, once a minute at most, never while running, never while its creator cannot run it', async () => {
    const run = await post<AutomationRun>(`/api/automations/${mine}/run`)
    expect(run.status).toBe(200)
    expect(run.body).toMatchObject({ automationId: mine, trigger: 'manual', ok: true, matched: 2, fired: 2, notified: 2 })
    expect((await alertsOf(app.db, p.plain.user.id)).filter((a) => a.kind === 'automation-case').length).toBeGreaterThanOrEqual(2)
    const again = await post<ApiErrorBody>(`/api/automations/${mine}/run`)
    expect(again.status).toBe(429)
    await app.db.query(`UPDATE ai_automations SET last_manual_run_at = NULL, running_until = now() + interval '5 minutes' WHERE id = $1`, [mine])
    expect((await post<ApiErrorBody>(`/api/automations/${mine}/run`)).status).toBe(409)
    await app.db.query(`UPDATE ai_automations SET running_until = NULL WHERE id = $1`, [mine])
    // Its creator stopped by the owner: the owner may still look, and is told why it cannot run.
    await grant(app, p.owner, p.creator, { enabled: false, automations: true })
    const blocked = await post<ApiErrorBody>(`/api/automations/${mine}/run`, p.owner)
    expect(blocked.status).toBe(409)
    expect(blocked.body.error.message).toBe('It cannot run now: its creator no longer has the assistant, or no data to read.')
    await grant(app, p.owner, p.creator, { automations: true })
  })

  it('tests without telling anyone or recording anything', async () => {
    await app.db.query(`INSERT INTO ai_automation_hits (automation_id, case_key, first_seen_at) VALUES ($1, '31', now())`, [mine])
    const before = await alertsOf(app.db, p.plain.user.id)
    const res = await post<AutomationTestResponse>(`/api/automations/${mine}/test`)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, matched: 2, newCases: 1, truncated: false, columns: ['machine_code', 'machine'], sampleTitle: `New machine ${isolate('31. Machine')}`, recipients: 1 })
    expect(await runsOf(app.db, mine)).toEqual([])
    expect((await app.db.query(`SELECT 1 FROM ai_automation_hits WHERE automation_id = $1`, [mine])).rowCount).toBe(1)
    expect(await alertsOf(app.db, p.plain.user.id)).toEqual(before)
    const r = await post<AutomationTestResponse>(`/api/automations/${report}/test`)
    expect(r.body).toMatchObject({ ok: true, recipients: 1, sections: [{ title: 'Machines', ok: true, rows: [[2]] }] })
    expect((await app.db.query(`SELECT 1 FROM ai_report_deliveries WHERE automation_id = $1`, [report])).rowCount).toBe(0)
  })

  it("takes one run or test of a person's at a time, and counts each against their runs", async () => {
    // A query slow enough to still be running when the second request comes.
    const slow = await insertAutomation(app.db, {
      creatorId: p.creator2.user.id,
      name: 'Slow',
      watch: { ...watchDraft().watch!, sql: `SELECT g::text AS machine_code, 'x' AS machine FROM generate_series(1, 4000000) g WHERE g < 0` },
      nextRunAt: null,
      status: 'paused',
    })
    const [a, b] = await Promise.all([post<AutomationTestResponse>(`/api/automations/${slow}/test`, p.creator2), post<ApiErrorBody>(`/api/automations/${slow}/test`, p.creator2)])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    const refused = (a.status === 409 ? a.body : b.body) as ApiErrorBody
    expect(refused.error.message).toBe('A run or test of yours is still going. Wait for it to finish.')
    // A run while a test is going is refused alike; someone else is not held up.
    const [t, r, other] = await Promise.all([
      post<AutomationTestResponse>(`/api/automations/${slow}/test`, p.creator2),
      post<ApiErrorBody>(`/api/automations/${slow}/run`, p.creator2),
      post<AutomationTestResponse>(`/api/automations/${mine}/test`),
    ])
    expect([t.status, r.status].sort()).toEqual([200, 409])
    expect(other.status).toBe(200)
    // Runs and tests count against the person's report runs.
    for (let i = 0; i < 60; i++) app.aiReportLimiter.hit(p.creator2.user.id)
    try {
      const limited = await post<ApiErrorBody>(`/api/automations/${slow}/test`, p.creator2)
      expect(limited.status).toBe(429)
      expect(limited.body.error.code).toBe('rate_limited')
      expect((await post<ApiErrorBody>(`/api/automations/${slow}/run`, p.creator2)).status).toBe(429)
    } finally {
      app.aiReportLimiter.reset(p.creator2.user.id)
    }
  })

  it('pages the run history newest first, thirty at a time', async () => {
    for (let i = 0; i < 35; i++) {
      await app.db.query(`INSERT INTO ai_automation_runs (automation_id, trigger, started_at, finished_at, ok, ms) VALUES ($1, 'schedule', $2, $2, true, 5)`, [
        mine,
        new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString(),
      ])
    }
    const first = await get<AutomationRunsResponse>(`/api/automations/${mine}/runs`)
    expect(first.body.runs).toHaveLength(30)
    expect(first.body.hasMore).toBe(true)
    expect(first.body.runs[0].startedAt).toBe(new Date(Date.UTC(2026, 9, 1) + 34 * 60_000).toISOString())
    const second = await get<AutomationRunsResponse>(`/api/automations/${mine}/runs?before=${first.body.runs[29].id}`)
    expect(second.body).toMatchObject({ hasMore: false })
    expect(second.body.runs.map((r) => r.startedAt)).toEqual([4, 3, 2, 1, 0].map((i) => new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString()))
    expect((await get(`/api/automations/${mine}/runs?before=nope`)).status).toBe(400)
  })
})

describe('§21 the audit trail of automations', () => {
  it('shows automation changes to the owner only, and never to the assistant', async () => {
    await patch(`/api/automations/${mine}`, { name: 'Audited' })
    for (const s of [p.admin2, p.plain]) {
      const list = await app.api<AuditListResponse>('GET', '/api/audit?limit=2000', { token: s.token })
      if (list.status === 403) continue
      expect(list.body.entries.some((e) => e.entity === 'Automation'), s.user.name).toBe(false)
      expect((await app.api<AuditOptionsResponse>('GET', '/api/audit/options', { token: s.token })).body.entities).not.toContain('Automation')
      expect((await app.api<AuditStats>('GET', '/api/audit/stats', { token: s.token })).status).toBe(200)
    }
    expect((await get<AuditOptionsResponse>('/api/audit/options', p.owner)).body.entities).toContain('Automation')
    // The assistant reading the audit log never sees them either.
    const run = await runReadOnlyQuery(app.aiReader.poolFor(['audit']), `SELECT count(*)::int AS n FROM ai.audit_log WHERE entity = 'Automation'`, { maxRows: 1, timeoutMs: 5000, timeZone: app.config.FACTORY_TIMEZONE })
    expect(run).toMatchObject({ ok: true, rows: [[0]] })
  })
})
