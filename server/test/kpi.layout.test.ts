// ============================================================================
// §15 — the dashboard board: a fixed default for everyone, and an arrangement
// of their own for each administrator.
// ============================================================================

import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import type { DashboardLayoutResponse } from '@qc/shared/api'
import { DASHBOARD_WIDGETS, defaultDashboardLayouts, normaliseDashboardLayout, normaliseDashboardLayouts, type DashboardLayouts } from '@qc/shared/kpi'
import { TestApp, type Session } from './harness'

const app = new TestApp()
let admin: Session
let otherAdmin: Session
let viewer: Session

const layoutOf = async (s: Session) => (await app.api<DashboardLayoutResponse>('GET', '/api/kpi/layout', { token: s.token })).body

/** The layout an administrator saved for everyone before layouts became personal. */
function sharedDefault(): DashboardLayouts {
  const layouts = defaultDashboardLayouts()
  layouts.general = layouts.general.map((it) => (it.i === 'g.pieDefects' ? { ...it, hidden: true } : it.i === 'g.pareto' ? { ...it, title: 'أهم العيوب' } : it))
  return layouts
}

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  admin = await app.register('admin', 'Admin')
  await app.api('POST', '/api/users', { token: admin.token, body: { username: 'watcher', password: 'Password#1', name: 'Plant Manager', role: 'viewer' } })
  await app.api('POST', '/api/users', { token: admin.token, body: { username: 'second', password: 'Password#1', name: 'Second Admin', role: 'admin' } })
  viewer = await app.login('watcher')
  otherAdmin = await app.login('second')
})
afterAll(() => app.stop())

describe('§15 — the dashboard layout', () => {
  it("shows the code's defaults while no default was ever saved", async () => {
    const res = await app.api<DashboardLayoutResponse>('GET', '/api/kpi/layout', { token: viewer.token })
    expect(res.status).toBe(200)
    expect(res.body.isDefault).toBe(true)
    expect(res.body.layouts).toEqual(defaultDashboardLayouts())
    // Every widget of each page is placed, inside the grid, without overlap in the default packing.
    for (const page of ['general', 'details'] as const) {
      expect(res.body.layouts[page].map((i) => i.i)).toEqual(DASHBOARD_WIDGETS[page].map((w) => w.id))
      for (const it of res.body.layouts[page]) expect(it.x + it.w).toBeLessThanOrEqual(12)
    }
  })

  it('reads the layout saved for everyone as the default, for every role', async () => {
    await app.db.query(`INSERT INTO app_settings (key, value, updated_by_name, updated_at) VALUES ('dashboard-layout', $1::jsonb, 'Admin', now())`, [JSON.stringify(sharedDefault())])
    const expected = normaliseDashboardLayouts(sharedDefault())
    for (const s of [viewer, admin, otherAdmin]) {
      const l = await layoutOf(s)
      expect(l.isDefault).toBe(true)
      expect(l.layouts).toEqual(expected)
      expect(l.updatedByName).toBe('Admin')
    }
  })

  it("keeps an administrator's arrangement for them alone, and the default untouched", async () => {
    const layouts = defaultDashboardLayouts()
    layouts.general = [{ i: 'g.pareto', x: 0, y: 0, w: 12, h: 12, title: 'Mine' }, { i: 'g.trend', x: 6, y: 12, w: 6, h: 9, hidden: true }]
    const saved = await app.api<DashboardLayoutResponse>('PUT', '/api/kpi/layout', { token: admin.token, body: { layouts } })
    expect(saved.status).toBe(200)
    expect(saved.body.isDefault).toBe(false)
    // The two placed widgets come first as placed; the widgets left out are appended below at their default size.
    expect(saved.body.layouts.general.slice(0, 2)).toEqual(layouts.general)
    expect(saved.body.layouts.general.map((i) => i.i).sort()).toEqual(DASHBOARD_WIDGETS.general.map((w) => w.id).sort())
    expect(saved.body.layouts.general[2].y).toBe(21)
    expect((await layoutOf(admin)).layouts).toEqual(saved.body.layouts)
    // Nobody else's board moved, and the default in app_settings is what it was.
    const expected = normaliseDashboardLayouts(sharedDefault())
    for (const s of [viewer, otherAdmin]) {
      const l = await layoutOf(s)
      expect(l.isDefault).toBe(true)
      expect(l.layouts).toEqual(expected)
    }
    const stored = await app.db.query<{ value: unknown }>(`SELECT value FROM app_settings WHERE key = 'dashboard-layout'`)
    expect(normaliseDashboardLayouts(stored.rows[0].value)).toEqual(expected)
  })

  it('lets a second administrator keep a different arrangement', async () => {
    const layouts = defaultDashboardLayouts()
    layouts.general = layouts.general.map((it) => (it.i === 'g.pareto' ? { ...it, title: 'Second' } : it))
    const saved = await app.api<DashboardLayoutResponse>('PUT', '/api/kpi/layout', { token: otherAdmin.token, body: { layouts } })
    expect(saved.status).toBe(200)
    expect((await layoutOf(otherAdmin)).layouts.general.find((it) => it.i === 'g.pareto')?.title).toBe('Second')
    expect((await layoutOf(admin)).layouts.general.find((it) => it.i === 'g.pareto')?.title).toBe('Mine')
    expect((await layoutOf(viewer)).layouts.general.find((it) => it.i === 'g.pareto')?.title).toBe('أهم العيوب')
  })

  it('refuses anyone but an administrator', async () => {
    const layouts = defaultDashboardLayouts()
    expect((await app.api('PUT', '/api/kpi/layout', { token: viewer.token, body: { layouts } })).status).toBe(403)
    expect((await app.api('DELETE', '/api/kpi/layout', { token: viewer.token })).status).toBe(403)
  })

  it('validates what is saved: names, hidden flags, the grid, unknown widgets', async () => {
    const layouts = defaultDashboardLayouts()
    const named = { ...layouts, general: layouts.general.map((it) => (it.i === 'g.pareto' ? { ...it, title: '   ', hint: '' } : it)) }
    const cleared = await app.api<DashboardLayoutResponse>('PUT', '/api/kpi/layout', { token: admin.token, body: { layouts: named } })
    expect(cleared.body.layouts.general.find((it) => it.i === 'g.pareto')?.title).toBeUndefined()
    const long = { ...layouts, general: layouts.general.map((it) => (it.i === 'g.pareto' ? { ...it, title: 'x'.repeat(81) } : it)) }
    expect((await app.api('PUT', '/api/kpi/layout', { token: admin.token, body: { layouts: long } })).status).toBe(400)
    const bad = { ...layouts, general: layouts.general.map((it) => (it.i === 'g.trend' ? { ...it, hidden: 'yes' } : it)) }
    expect((await app.api('PUT', '/api/kpi/layout', { token: admin.token, body: { layouts: bad } })).status).toBe(400)
    expect((await app.api('PUT', '/api/kpi/layout', { token: admin.token, body: { layouts: { ...layouts, general: [{ i: 'g.trend', x: 0, y: 0, w: 13, h: 5 }] } } })).status).toBe(400)
    expect((await app.api('PUT', '/api/kpi/layout', { token: admin.token, body: { layouts: { ...layouts, general: [{ i: 'g.trend', x: 0, y: 0, w: 4, h: 0 }] } } })).status).toBe(400)
    const odd = await app.api<DashboardLayoutResponse>('PUT', '/api/kpi/layout', { token: admin.token, body: { layouts: { ...layouts, general: [{ i: 'g.nope', x: 0, y: 0, w: 4, h: 4 }] } } })
    expect(odd.status).toBe(200)
    expect(odd.body.layouts.general.some((i) => i.i === 'g.nope')).toBe(false)
    expect(odd.body.layouts.general.length).toBe(DASHBOARD_WIDGETS.general.length)
  })

  it('puts the default back for that administrator only, keeping the row', async () => {
    const reset = await app.api<DashboardLayoutResponse>('DELETE', '/api/kpi/layout', { token: admin.token })
    expect(reset.status).toBe(200)
    expect(reset.body.isDefault).toBe(true)
    expect(reset.body.layouts).toEqual(normaliseDashboardLayouts(sharedDefault()))
    expect((await layoutOf(otherAdmin)).isDefault).toBe(false)
    const rows = await app.db.query<{ layouts: unknown }>(`SELECT layouts FROM dashboard_user_layouts WHERE user_id = $1`, [admin.user.id])
    expect(rows.rows).toEqual([{ layouts: null }])
    // Again is harmless.
    expect((await app.api('DELETE', '/api/kpi/layout', { token: admin.token })).status).toBe(200)
  })

  it('shows the default to an administrator who is no longer one', async () => {
    expect((await app.api('PATCH', `/api/users/${otherAdmin.user.id}`, { token: admin.token, body: { role: 'viewer' } })).status).toBe(200)
    const demoted = await app.login('second')
    const l = await layoutOf(demoted)
    expect(l.isDefault).toBe(true)
    expect(l.layouts).toEqual(normaliseDashboardLayouts(sharedDefault()))
  })

  it('keeps a stored item within the grid when normalising', () => {
    const out = normaliseDashboardLayout('general', [{ i: 'g.trend', x: 10, y: 0, w: 6, h: 200 }])
    expect(out[0]).toEqual({ i: 'g.trend', x: 6, y: 0, w: 6, h: 80 })
  })
})
