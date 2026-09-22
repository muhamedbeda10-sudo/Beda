// ============================================================================
// §15 — hiding an insight. Per person, by key, on every device; showing it
// again brings it back; the next person's list is their own.
// ============================================================================

import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import type { HiddenInsightsResponse } from '@qc/shared/api'
import { INSIGHT_KEY_MAX, insightKey } from '@qc/shared/kpi'
import { TestApp, type Session } from './harness'

const app = new TestApp()
let admin: Session
let viewer: Session
let inspector: Session

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  admin = await app.register('admin', 'Admin')
  inspector = await app.register('insp', 'Inspector One')
  await app.api('POST', '/api/users', { token: admin.token, body: { username: 'watcher', password: 'Password#1', name: 'Plant Manager', role: 'viewer' } })
  viewer = await app.login('watcher')
})
afterAll(() => app.stop())

const MACHINE_14 = insightKey({ id: 'machine-outlier', link: { kind: 'machine', value: '14' } })
const MACHINE_31 = insightKey({ id: 'machine-outlier', link: { kind: 'machine', value: '31' } })

describe('§15 — hidden insights', () => {
  it('keys carry the rule and its subject', () => {
    expect(MACHINE_14).toBe('machine-outlier:machine:14')
    expect(MACHINE_14).not.toBe(MACHINE_31)
    expect(insightKey({ id: 'fpy-red' })).toBe('fpy-red')
    expect(insightKey({ id: 'x', link: { kind: 'item', value: 'y'.repeat(300) } }).length).toBe(INSIGHT_KEY_MAX)
  })

  it('is for whoever sees the dashboard', async () => {
    expect((await app.api('GET', '/api/kpi/insights/hidden', { token: inspector.token })).status).toBe(403)
    expect((await app.api('POST', '/api/kpi/insights/hide', { token: inspector.token, body: { key: MACHINE_14 } })).status).toBe(403)
    expect((await app.api<HiddenInsightsResponse>('GET', '/api/kpi/insights/hidden', { token: viewer.token })).body.keys).toEqual([])
  })

  it('hides by key, again without complaint, and shows again on request', async () => {
    const hide = await app.api<HiddenInsightsResponse>('POST', '/api/kpi/insights/hide', { token: admin.token, body: { key: MACHINE_14 } })
    expect(hide.status).toBe(200)
    expect(hide.body.keys).toEqual([MACHINE_14])
    // Hiding machine 14 says nothing about machine 31.
    expect((await app.api<HiddenInsightsResponse>('GET', '/api/kpi/insights/hidden', { token: admin.token })).body.keys).toEqual([MACHINE_14])
    const twice = await app.api<HiddenInsightsResponse>('POST', '/api/kpi/insights/hide', { token: admin.token, body: { key: MACHINE_14 } })
    expect(twice.status).toBe(200)
    expect(twice.body.keys).toEqual([MACHINE_14])
    const more = await app.api<HiddenInsightsResponse>('POST', '/api/kpi/insights/hide', { token: admin.token, body: { key: 'fpy-red' } })
    expect(new Set(more.body.keys)).toEqual(new Set([MACHINE_14, 'fpy-red']))

    const back = await app.api<HiddenInsightsResponse>('POST', '/api/kpi/insights/restore', { token: admin.token, body: { key: MACHINE_14 } })
    expect(back.status).toBe(200)
    expect(back.body.keys).toEqual(['fpy-red'])
    // Restoring what is not hidden is a no-op, not an error.
    expect((await app.api<HiddenInsightsResponse>('POST', '/api/kpi/insights/restore', { token: admin.token, body: { key: MACHINE_31 } })).body.keys).toEqual(['fpy-red'])
    // Hidden again after a restore: the same row, back in force.
    expect((await app.api<HiddenInsightsResponse>('POST', '/api/kpi/insights/hide', { token: admin.token, body: { key: MACHINE_14 } })).body.keys).toContain(MACHINE_14)
    const rows = await app.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM insight_dismissals WHERE insight_key = $1`, [MACHINE_14])
    expect(rows.rows[0].n).toBe('1')
  })

  it('is each person\'s own list', async () => {
    expect((await app.api<HiddenInsightsResponse>('GET', '/api/kpi/insights/hidden', { token: viewer.token })).body.keys).toEqual([])
    const mine = await app.api<HiddenInsightsResponse>('POST', '/api/kpi/insights/hide', { token: viewer.token, body: { key: 'coverage-low' } })
    expect(mine.body.keys).toEqual(['coverage-low'])
    expect((await app.api<HiddenInsightsResponse>('GET', '/api/kpi/insights/hidden', { token: admin.token })).body.keys).not.toContain('coverage-low')
  })

  it('refuses a blank or oversized key', async () => {
    expect((await app.api('POST', '/api/kpi/insights/hide', { token: admin.token, body: { key: '   ' } })).status).toBe(400)
    expect((await app.api('POST', '/api/kpi/insights/hide', { token: admin.token, body: { key: 'k'.repeat(INSIGHT_KEY_MAX + 1) } })).status).toBe(400)
    expect((await app.api('POST', '/api/kpi/insights/hide', { token: admin.token, body: {} })).status).toBe(400)
  })
})
