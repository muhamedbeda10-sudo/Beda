// ============================================================================
// §15 — the dashboard board: one layout for everyone, set by an administrator.
// ============================================================================

import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import type { DashboardLayoutResponse } from '@qc/shared/api'
import { DASHBOARD_WIDGETS, defaultDashboardLayouts, normaliseDashboardLayout } from '@qc/shared/kpi'
import { TestApp, type Session } from './harness'

const app = new TestApp()
let admin: Session
let viewer: Session

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  admin = await app.register('admin', 'Admin')
  await app.api('POST', '/api/users', { token: admin.token, body: { username: 'watcher', password: 'Password#1', name: 'Plant Manager', role: 'viewer' } })
  viewer = await app.login('watcher')
})
afterAll(() => app.stop())

describe('§15 — the dashboard layout', () => {
  it('shows the defaults until one is saved, to anyone who sees the dashboard', async () => {
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

  it('is saved by an administrator only, normalised, and audited', async () => {
    const layouts = defaultDashboardLayouts()
    layouts.general = [{ i: 'g.pareto', x: 0, y: 0, w: 12, h: 12 }, { i: 'g.trend', x: 6, y: 12, w: 6, h: 9 }]
    expect((await app.api('PUT', '/api/kpi/layout', { token: viewer.token, body: { layouts } })).status).toBe(403)
    const saved = await app.api<DashboardLayoutResponse>('PUT', '/api/kpi/layout', { token: admin.token, body: { layouts } })
    expect(saved.status).toBe(200)
    expect(saved.body.isDefault).toBe(false)
    expect(saved.body.updatedByName).toBe('Admin')
    // The two placed widgets come first as placed; the widgets left out are appended below at their default size.
    expect(saved.body.layouts.general.slice(0, 2)).toEqual(layouts.general)
    expect(saved.body.layouts.general.map((i) => i.i).sort()).toEqual(DASHBOARD_WIDGETS.general.map((w) => w.id).sort())
    expect(saved.body.layouts.general[2].y).toBe(21)
    const read = await app.api<DashboardLayoutResponse>('GET', '/api/kpi/layout', { token: viewer.token })
    expect(read.body.layouts).toEqual(saved.body.layouts)
  })

  it('refuses a widget outside the grid and drops an unknown one', async () => {
    const layouts = defaultDashboardLayouts()
    expect((await app.api('PUT', '/api/kpi/layout', { token: admin.token, body: { layouts: { ...layouts, general: [{ i: 'g.trend', x: 0, y: 0, w: 13, h: 5 }] } } })).status).toBe(400)
    expect((await app.api('PUT', '/api/kpi/layout', { token: admin.token, body: { layouts: { ...layouts, general: [{ i: 'g.trend', x: 0, y: 0, w: 4, h: 0 }] } } })).status).toBe(400)
    const odd = await app.api<DashboardLayoutResponse>('PUT', '/api/kpi/layout', { token: admin.token, body: { layouts: { ...layouts, general: [{ i: 'g.nope', x: 0, y: 0, w: 4, h: 4 }] } } })
    expect(odd.status).toBe(200)
    expect(odd.body.layouts.general.some((i) => i.i === 'g.nope')).toBe(false)
    expect(odd.body.layouts.general.length).toBe(DASHBOARD_WIDGETS.general.length)
  })

  it('goes back to the defaults on request', async () => {
    expect((await app.api('DELETE', '/api/kpi/layout', { token: viewer.token })).status).toBe(403)
    const reset = await app.api<DashboardLayoutResponse>('DELETE', '/api/kpi/layout', { token: admin.token })
    expect(reset.status).toBe(200)
    expect(reset.body.isDefault).toBe(true)
    expect(reset.body.layouts).toEqual(defaultDashboardLayouts())
  })

  it('keeps a stored item within the grid when normalising', () => {
    const out = normaliseDashboardLayout('general', [{ i: 'g.trend', x: 10, y: 0, w: 6, h: 200 }])
    expect(out[0]).toEqual({ i: 'g.trend', x: 6, y: 0, w: 6, h: 80 })
  })
})
