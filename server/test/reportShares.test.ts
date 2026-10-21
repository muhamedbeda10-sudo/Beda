// ============================================================================
// A saved report shared with people and roles (ai/reportShares.ts). Its
// owner shares it from its Share panel while they have the assistant; each
// change is audited, and whoever it newly reaches is told once in the bell's
// Reports. A recipient — the assistant or not — finds it on the Reports page,
// opens it without its SQL, runs it with the inputs and days its owner's run
// takes, and takes it to Excel with the permission to export records. A run
// reads as the owner's current domains within those the report was written
// under, never the recipient's; it is recorded for the owner, and the photos
// it showed are the recipient's to open, and no others. Anyone it is not
// shared with gets 404.
// ============================================================================

import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ApiErrorBody } from '@qc/shared/api'
import type { ImageAsset, ProductionOrder } from '@qc/shared/types'
import type { SessionWithOrder } from '@qc/shared/api'
import type { UserNotificationsResponse } from '@qc/shared/automation'
import type {
  ReportSharesResponse,
  ReportShareTarget,
  SharedReport,
  SharedReportRunResponse,
  SharedReportsResponse,
  SharedReportsStatus,
} from '@qc/shared/reportShares'
import { changeReport, deleteReport, findReport, insertReport } from '../src/ai/reports'
import { SHARED_NO_ACCESS, anySharedReports, purgeSharePhotos, runPhotoIds } from '../src/ai/reportShares'
import { reportWorkbookDoc } from '../src/reportStyles/documents'
import { BUILTIN_RESOLVED_STYLE } from '@qc/shared/reportStyles'
import { TestApp, factoryDay, tinyJpeg, type Session } from './harness'
import { grant, setUp, type People } from './automationsKit'

const app = new TestApp()
let p: People
/** The viewer, with the inspection screens taken away: someone who reads no inspection photo of their own. */
let viewer: Session
let seed = 700

/** Cara's report (an inspector given the assistant over inspections): machines, with a number to type and a list to filter. */
const MACHINES = {
  title: 'Machines by code',
  question: 'Which machines are on the register?',
  description: 'The machines on the register, those asked for.',
  period: null,
  adjustable: false,
  inputs: [
    { name: 'codes', label: 'Machines', kind: 'list' as const, required: false },
    { name: 'top', label: 'How many', kind: 'number' as const, required: true, default: 10 },
  ],
  sections: [
    { title: 'Count', display: 'figures' as const, sql: `SELECT count(*)::int AS "Machines" FROM ai.machines WHERE ({{codes}} IS NULL OR machine_code = ANY({{codes}}))` },
    { title: 'Each machine', sql: `SELECT machine_code AS code FROM ai.machines WHERE ({{codes}} IS NULL OR machine_code = ANY({{codes}})) ORDER BY 1 LIMIT {{top}}` },
  ],
}

/** A section over the order sheet (domain orders), which Cara may not read. */
const ORDER_LINES = { title: 'Order lines', sql: 'SELECT count(*)::int AS lines FROM ai.order_lines' }

let reportId = ''

const shares = (id: string, as: Session) => app.api<ReportSharesResponse & ApiErrorBody>('GET', `/api/ai/reports/${id}/shares`, { token: as.token })
const share = (id: string, as: Session, body: { add?: ReportShareTarget[]; remove?: ReportShareTarget[] }) =>
  app.api<ReportSharesResponse & ApiErrorBody>('PUT', `/api/ai/reports/${id}/shares`, { token: as.token, body })
const opened = (id: string, as: Session) => app.api<SharedReport & ApiErrorBody>('GET', `/api/reports/shared/${id}`, { token: as.token })
const run = (id: string, as: Session, query = '') => app.api<SharedReportRunResponse & ApiErrorBody>('GET', `/api/reports/shared/${id}/run${query}`, { token: as.token })
const list = (as: Session, query = '') => app.api<SharedReportsResponse>('GET', `/api/reports/shared${query}`, { token: as.token })
const status = async (as: Session) => (await app.api<SharedReportsStatus>('GET', '/api/reports/shared/status', { token: as.token })).body.any
const user = (s: Session): ReportShareTarget => ({ kind: 'user', userId: s.user.id })

/** The bell's Reports of a person: what the sharing told them. */
async function sharedAlerts(s: Session) {
  const res = await app.api<UserNotificationsResponse>('GET', '/api/notifications?category=reports', { token: s.token })
  return res.body.notifications.filter((n) => n.title.includes('shared a report'))
}

async function newReport(over: Partial<typeof MACHINES> & { sections?: { title: string; sql: string }[] } = {}, owner = p.creator, authorDomains?: string[]) {
  return (
    await insertReport(app.db, {
      ...MACHINES,
      ...over,
      userId: owner.user.id,
      conversationId: null,
      turnId: null,
      madeBy: 'assistant',
      ...(authorDomains ? { authorDomains: authorDomains as never } : {}),
    })
  ).id
}

beforeAll(async () => {
  await app.start()
  p = await setUp(app)
  const away = ['view-inspections', 'view-history'].map((permission) => ({ permission, granted: false }))
  expect((await app.api('PUT', `/api/users/${p.viewer.user.id}/permissions`, { token: p.owner.token, body: { overrides: away } })).status).toBe(200)
  viewer = await app.login('watcher')
  reportId = await newReport()
})
afterAll(() => app.stop())
beforeEach(async () => {
  for (const s of Object.values(p)) app.aiReportLimiter.reset(s.user.id)
  // Cara's access as setUp gave it: the assistant over inspections.
  await grant(app, p.owner, p.creator, { automations: true })
})

describe('sharing a report from its Share panel', () => {
  it('lists whom it is shared with, who ran it, and whom it may be shared with: every live account but its owner', async () => {
    const res = await shares(reportId, p.creator)
    expect(res.status).toBe(200)
    expect(res.body.shares).toEqual([])
    expect(res.body.runners).toEqual([])
    expect(res.body.roles).toEqual(['viewer', 'inspector', 'supervisor', 'admin'])
    const ids = res.body.people.map((x) => x.id)
    expect(ids).toContain(viewer.user.id)
    expect(ids).toContain(p.admin2.user.id)
    expect(ids).not.toContain(p.creator.user.id)
  })

  it('shares with people and roles, audits each, and tells everyone it reaches once in the bell’s Reports', async () => {
    const res = await share(reportId, p.creator, { add: [user(viewer), { kind: 'role', role: 'supervisor' }] })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.shares.map((s) => s.label)).toEqual(['Every supervisor', 'Vera Viewer'])
    expect(res.body.shares[1]).toMatchObject({ kind: 'user', userId: viewer.user.id, sharedByName: 'Cara Creator' })

    const audit = await app.db.query<{ userId: string; field: string; oldValue: string; newValue: string }>(
      `SELECT user_id AS "userId", field, old_value AS "oldValue", new_value AS "newValue" FROM audit_log WHERE entity = 'AiReport' AND entity_id = $1 ORDER BY new_value COLLATE "C"`,
      [reportId],
    )
    expect(audit.rows).toEqual([
      { userId: p.creator.user.id, field: 'shared with', oldValue: '', newValue: 'Every supervisor' },
      { userId: p.creator.user.id, field: 'shared with', oldValue: '', newValue: 'Vera Viewer' },
    ])

    for (const s of [viewer, p.plain]) {
      const alerts = await sharedAlerts(s)
      expect(alerts).toHaveLength(1)
      expect(alerts[0]).toMatchObject({ kind: 'report-shared', title: 'Cara Creator shared a report with you: Machines by code', link: `/reports/${reportId}` })
    }
    // Neither its owner nor anyone outside it is told; nor is it an alert of the Alerts tab.
    for (const s of [p.creator, p.admin2]) expect(await sharedAlerts(s)).toEqual([])
    const alertsTab = await app.api<UserNotificationsResponse>('GET', '/api/notifications?category=alerts', { token: viewer.token })
    expect(alertsTab.body.notifications.some((n) => n.kind === 'report-shared')).toBe(false)
  })

  it('tells nobody twice: unshared and shared again, or shared again through a role', async () => {
    expect((await share(reportId, p.creator, { remove: [user(viewer)] })).body.shares.map((s) => s.label)).toEqual(['Every supervisor'])
    expect((await share(reportId, p.creator, { add: [user(viewer), user(p.plain)] })).status).toBe(200)
    expect(await sharedAlerts(viewer)).toHaveLength(1)
    expect(await sharedAlerts(p.plain)).toHaveLength(1)
    const audit = await app.db.query(`SELECT 1 FROM audit_log WHERE entity = 'AiReport' AND entity_id = $1 AND field = 'shared with' AND old_value = 'Vera Viewer'`, [reportId])
    expect(audit.rowCount).toBe(1)
    // Adding what is there already changes nothing, and writes nothing.
    const before = (await app.db.query(`SELECT count(*)::int AS n FROM audit_log WHERE entity_id = $1`, [reportId])).rows[0].n
    expect((await share(reportId, p.creator, { add: [user(viewer)] })).status).toBe(200)
    expect((await app.db.query(`SELECT count(*)::int AS n FROM audit_log WHERE entity_id = $1`, [reportId])).rows[0].n).toBe(before)
    expect((await share(reportId, p.creator, { remove: [user(p.plain)] })).status).toBe(200)
  })

  it('refuses what cannot be shared, changing nothing', async () => {
    const before = (await shares(reportId, p.creator)).body.shares
    const refused = async (body: object, words: RegExp) => {
      const res = await app.api<ApiErrorBody>('PUT', `/api/ai/reports/${reportId}/shares`, { token: p.creator.token, body })
      expect(res.status, JSON.stringify(res.body)).toBe(400)
      expect(res.body.error.message).toMatch(words)
    }
    await refused({ add: [user(p.creator)] }, /yours already/)
    await refused({ add: [{ kind: 'user', userId: randomUUID() }] }, /No person has the id/)
    await refused({ add: [{ kind: 'role', role: 'boss' }] }, /role/)
    await refused({ add: [user(p.admin2)], remove: [user(p.admin2)] }, /both added and removed/)
    const gone = await app.db.query<{ id: string }>(`INSERT INTO users (username, name, role, password_hash, is_active) VALUES ('left', 'Lea Left', 'inspector', 'x', false) RETURNING id`)
    await refused({ add: [{ kind: 'user', userId: gone.rows[0].id }] }, /not active/)
    expect((await shares(reportId, p.creator)).body.shares).toEqual(before)
  })

  it('is its owner’s alone, while they have the assistant: 404 to anyone else, 403 once the assistant is taken from them', async () => {
    // Paula has the assistant but the report is Cara's; the viewer and the second administrator have no assistant.
    expect((await shares(reportId, p.plain)).status).toBe(404)
    expect((await share(reportId, p.plain, { add: [user(p.admin2)] })).status).toBe(404)
    for (const s of [viewer, p.admin2]) expect((await share(reportId, s, { add: [user(p.creator2)] })).status).toBe(403)
    await grant(app, p.owner, p.creator, { enabled: false })
    expect((await shares(reportId, p.creator)).status).toBe(403)
    expect((await share(reportId, p.creator, { add: [user(p.admin2)] })).status).toBe(403)
  })

  it('counts its people and roles on the report for its owner alone', async () => {
    expect((await findReport(app.db, reportId, p.creator.user.id))?.shareCount).toBe(2)
    const theirs = await newReport({ title: 'Shared with everyone given the assistant' })
    await app.db.query(`UPDATE ai_reports SET shared = true WHERE id = $1`, [theirs])
    expect((await findReport(app.db, theirs, p.creator.user.id))?.shareCount).toBeUndefined()
    await share(theirs, p.creator, { add: [user(p.admin2)] })
    expect((await findReport(app.db, theirs, p.plain.user.id))?.shareCount).toBeUndefined()
    await share(theirs, p.creator, { remove: [user(p.admin2)] })
  })
})

describe('the Reports page of someone it is shared with', () => {
  it('appears for whoever has a report shared with them, and lists it with who shared it, searchable', async () => {
    expect(await status(viewer)).toBe(true)
    expect(await status(p.plain)).toBe(true)
    expect(await status(p.admin2)).toBe(false)
    // The owner's own report is in their My reports, not here.
    expect(await status(p.creator)).toBe(false)
    const res = await list(viewer)
    expect(res.status).toBe(200)
    expect(res.body.reports).toEqual([
      { id: reportId, title: 'Machines by code', description: 'The machines on the register, those asked for.', ownerName: 'Cara Creator', updatedAt: expect.any(String), inputCount: 2, sectionCount: 2 },
    ])
    expect((await list(viewer, '?q=REGISTER')).body.reports).toHaveLength(1)
    expect((await list(viewer, '?q=nothing like it')).body.reports).toEqual([])
    expect((await list(p.admin2)).body.reports).toEqual([])
  })

  it('opens it without its SQL or the question it came from, saying whether Excel is theirs', async () => {
    const res = await opened(reportId, viewer)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ id: reportId, title: 'Machines by code', ownerName: 'Cara Creator', available: true, excel: false, adjustable: false, period: null })
    expect(res.body.sections).toEqual([{ title: 'Count', display: 'figures' }, { title: 'Each machine' }])
    expect(res.body.inputs.map((i) => i.name)).toEqual(['codes', 'top'])
    expect(JSON.stringify(res.body)).not.toMatch(/SELECT|ai\.machines|Which machines/)
    // A supervisor exports records.
    expect((await opened(reportId, p.plain)).body.excel).toBe(true)
  })

  it('is not found by anyone it is not shared with, whatever they ask', async () => {
    for (const path of ['', '/run', '/workbook']) {
      const res = await app.api<ApiErrorBody>('GET', `/api/reports/shared/${reportId}${path}`, { token: p.admin2.token })
      expect(res.status, path).toBe(404)
      expect(res.body.error.message).toBe('That report was not found.')
    }
    // Nor by its owner, whose report it is: My reports opens it.
    expect((await opened(reportId, p.creator)).status).toBe(404)
    expect((await opened(randomUUID(), viewer)).status).toBe(404)
  })

  it('runs it with the inputs its owner defined, checked as the owner’s run checks them', async () => {
    const res = await run(reportId, viewer)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.sections.map((s) => [s.title, s.ok, s.rows])).toEqual([
      ['Count', true, [[2]]],
      ['Each machine', true, [['31'], ['58']]],
    ])
    expect(res.body.inputs).toEqual({ codes: null, top: 10 })
    expect(res.body.style).toBeTruthy()
    expect(JSON.stringify(res.body)).not.toMatch(/SELECT/)

    const typed = await run(reportId, viewer, `?inputs=${encodeURIComponent(JSON.stringify({ codes: ['58'], top: 1 }))}`)
    expect(typed.body.sections[1].rows).toEqual([['58']])
    const bad = await run(reportId, viewer, `?inputs=${encodeURIComponent(JSON.stringify({ top: 'many' }))}`)
    expect(bad.status).toBe(400)
    // The same words the owner's run gives.
    const owners = await app.api<ApiErrorBody>('GET', `/api/ai/reports/${reportId}/run?inputs=${encodeURIComponent(JSON.stringify({ top: 'many' }))}`, { token: p.creator.token })
    expect(bad.body.error.message).toBe(owners.body.error.message)
    // A report whose days are fixed takes no other days.
    const days = await run(reportId, viewer, `?from=${factoryDay(-3)}&to=${factoryDay()}`)
    expect(days.status).toBe(400)
    expect(days.body.error.message).toMatch(/period cannot be changed/)
  })

  it('runs over other days only when its period can change', async () => {
    const id = await newReport({
      title: 'Machines over a period',
      adjustable: true,
      period: { kind: 'last_days', days: 7 } as never,
      inputs: [],
      sections: [{ title: 'Days', sql: `SELECT {{from}}::text AS first_day, {{to}}::text AS last_day, count(*)::int AS machines FROM ai.machines` }],
    })
    await share(id, p.creator, { add: [user(viewer)] })
    const own = await run(id, viewer)
    expect(own.body.period).toMatchObject({ from: factoryDay(-6), to: factoryDay(), overridden: false })
    const chosen = await run(id, viewer, `?from=${factoryDay(-3)}&to=${factoryDay(-1)}`)
    expect(chosen.status).toBe(200)
    expect(chosen.body.period).toMatchObject({ from: factoryDay(-3), to: factoryDay(-1), overridden: true })
    expect(chosen.body.sections[0].rows).toEqual([[factoryDay(-3), factoryDay(-1), 2]])
  })

  it('reads as its owner may read now, never as the recipient: their own assistant does not widen it', async () => {
    const id = await newReport({ title: 'Machines and orders', inputs: [], sections: [{ title: 'Machines', sql: 'SELECT count(*)::int AS n FROM ai.machines' }, ORDER_LINES] })
    // The assistant's owner may read every domain: shared with them, the report still reads as Cara.
    await share(id, p.creator, { add: [user(p.owner), user(viewer)] })
    for (const s of [p.owner, viewer]) {
      const res = await run(id, s)
      expect(res.body.sections.map((x) => [x.ok, x.error ?? null])).toEqual([
        [true, null],
        [false, SHARED_NO_ACCESS],
      ])
    }
    // Given the orders since, Cara's report reads them for everyone — within what its queries were written under.
    await grant(app, p.owner, p.creator, { domains: ['inspection', 'orders'] })
    const bounded = await run(id, viewer)
    expect(bounded.body.sections[1]).toMatchObject({ ok: false, error: SHARED_NO_ACCESS })
    const written = await newReport({ title: 'Orders, written with them', inputs: [], sections: [ORDER_LINES] }, p.creator, ['inspection', 'orders'])
    await share(written, p.creator, { add: [user(viewer)] })
    expect((await run(written, viewer)).body.sections[0]).toMatchObject({ ok: true, rows: [[0]] })
  })

  it('reads as its owner may read now when the domains its queries were written under are not known', async () => {
    // A report kept before author_domains existed, by a maker who had no access row then: the column was filled
    // with an empty set, which read as a bound stopped every section — even one over nothing — for every recipient.
    const id = await newReport({ title: 'Kept before', inputs: [], sections: [{ title: 'Machines', sql: 'SELECT count(*)::int AS n FROM ai.machines' }, { title: 'One', sql: 'SELECT 1 AS one' }, ORDER_LINES] })
    await app.db.query(`UPDATE ai_reports SET author_domains = '{}' WHERE id = $1`, [id])
    await share(id, p.creator, { add: [user(viewer)] })
    const res = await run(id, viewer)
    // Cara's own domains (the inspections) still bound it: the order sheet stays out.
    expect(res.body.sections.map((x) => [x.ok, x.error ?? null])).toEqual([
      [true, null],
      [true, null],
      [false, SHARED_NO_ACCESS],
    ])
    // A save never writes an empty set either: given none, the maker's domains as they are now are kept instead.
    const written = await newReport({ title: 'Given no domains', inputs: [], sections: [{ title: 'One', sql: 'SELECT 1 AS one' }] }, p.creator, [])
    const kept = await app.db.query<{ domains: string[] | null }>(`SELECT author_domains AS domains FROM ai_reports WHERE id = $1`, [written])
    expect(kept.rows[0].domains).toEqual(['inspection'])
  })

  it('runs for no one once its owner no longer has the assistant, and says so plainly', async () => {
    await grant(app, p.owner, p.creator, { enabled: false })
    const res = await run(reportId, viewer)
    expect(res.status).toBe(409)
    expect(res.body.error.message).toBe('Cara Creator no longer has access to the AI assistant, so this report cannot run. Ask them to share it again.')
    expect((await opened(reportId, viewer)).body).toMatchObject({ available: false, unavailable: res.body.error.message })
    await grant(app, p.owner, p.creator, { automations: true })
    expect((await run(reportId, viewer)).status).toBe(200)
    // An account deactivated is as one withdrawn.
    await app.db.query(`UPDATE users SET is_active = false WHERE id = $1`, [p.creator.user.id])
    expect((await run(reportId, viewer)).status).toBe(409)
    await app.db.query(`UPDATE users SET is_active = true WHERE id = $1`, [p.creator.user.id])
  })

  it('counts each run against the person’s report-run limit', async () => {
    for (let i = 0; i < 60; i++) app.aiReportLimiter.hit(viewer.user.id)
    const res = await run(reportId, viewer)
    expect(res.status).toBe(429)
    expect(res.body.error.code).toBe('rate_limited')
  })

  it('records each recipient’s runs and exports for the owner’s panel', async () => {
    const id = await newReport({ title: 'Counted runs' })
    await share(id, p.creator, { add: [user(viewer), user(p.plain)] })
    await run(id, viewer)
    await run(id, viewer)
    await run(id, p.plain)
    const xlsx = await app.api('GET', `/api/reports/shared/${id}/workbook`, { token: p.plain.token })
    expect(xlsx.status).toBe(200)
    // The owner's own runs are theirs: not counted as a recipient's.
    await app.api('GET', `/api/ai/reports/${id}/run`, { token: p.creator.token })
    const runners = (await shares(id, p.creator)).body.runners
    expect(runners.map((r) => [r.name, r.runs, r.exports]).sort()).toEqual([
      ['Paula Plain', 1, 1],
      ['Vera Viewer', 2, 0],
    ])
    const rows = await app.db.query(`SELECT kind FROM ai_report_runs WHERE report_id = $1 AND user_id = $2`, [id, p.creator.user.id])
    expect(rows.rowCount).toBe(0)
  })

  it('takes it to Excel in its style for whoever may export records, without its SQL', async () => {
    const res = await fetch(`${app.baseUrl}/api/reports/shared/${reportId}/workbook`, { headers: { authorization: `Bearer ${p.plain.token}` } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('spreadsheetml')
    const refused = await app.api<ApiErrorBody>('GET', `/api/reports/shared/${reportId}/workbook`, { token: viewer.token })
    expect(refused.status).toBe(403)
    expect(refused.body.error.message).toMatch(/export records/)
    // What the workbook holds: each section's rows, and no SQL, nor the question.
    const report = (await findReport(app.db, reportId, p.creator.user.id))!
    const file = { report: { ...report, description: undefined }, period: null, values: {}, sections: [{ title: 'Count', ok: true, columns: ['n'], rows: [[1]], truncated: false }], ranAt: new Date().toISOString(), style: BUILTIN_RESOLVED_STYLE, madeBy: 'Paula', timeZone: 'Africa/Cairo' }
    const shared = reportWorkbookDoc(file, { withSql: false })
    expect(shared.sections.every((s) => !('sql' in s))).toBe(true)
    expect(shared.about.map(([k]) => k)).not.toContain('Question')
    const own = reportWorkbookDoc(file)
    expect(own.sections[0]).toHaveProperty('sql')
    expect(own.about.map(([k]) => k)).toContain('Question')
  })
})

describe('when what it is shared with changes', () => {
  it('takes it from a recipient at once when it is unshared', async () => {
    const id = await newReport({ title: 'Unshared soon' })
    await share(id, p.creator, { add: [user(p.admin2)] })
    expect((await run(id, p.admin2)).status).toBe(200)
    await share(id, p.creator, { remove: [user(p.admin2)] })
    expect((await run(id, p.admin2)).status).toBe(404)
    expect((await opened(id, p.admin2)).status).toBe(404)
    expect((await list(p.admin2)).body.reports).toEqual([])
    expect(await status(p.admin2)).toBe(false)
  })

  it('takes it from every recipient when it is deleted', async () => {
    const id = await newReport({ title: 'Deleted soon' })
    await share(id, p.creator, { add: [user(viewer), { kind: 'role', role: 'admin' }] })
    expect((await run(id, p.admin2)).status).toBe(200)
    await deleteReport(app.db, id)
    for (const s of [viewer, p.admin2]) {
      expect((await opened(id, s)).status).toBe(404)
      expect((await run(id, s)).status).toBe(404)
      expect((await list(s)).body.reports.map((r) => r.id)).not.toContain(id)
    }
  })

  it('runs the latest version once its owner changes it', async () => {
    const id = await newReport({ title: 'Changing' })
    await share(id, p.creator, { add: [user(viewer)] })
    await changeReport(app.db, id, p.creator.user.id, {
      title: 'Changed',
      description: 'Now one section.',
      period: null,
      adjustable: false,
      inputs: [],
      sections: [{ title: 'Just the count', sql: 'SELECT count(*)::int AS n FROM ai.machines' }],
      shared: false,
    })
    const res = await run(id, viewer)
    expect(res.body.report.title).toBe('Changed')
    expect(res.body.sections.map((s) => [s.title, s.rows])).toEqual([['Just the count', [[2]]]])
  })

  it('follows a role: whoever joins it later reaches the report, whoever leaves it does not', async () => {
    const id = await newReport({ title: 'For the inspectors' })
    await share(id, p.creator, { add: [{ kind: 'role', role: 'inspector' }] })
    // Cyril is an inspector; the viewer is not, yet.
    expect((await run(id, p.creator2)).status).toBe(200)
    expect((await opened(id, viewer)).status).toBe(404)
    await app.db.query(`UPDATE users SET role = 'inspector' WHERE id = $1`, [viewer.user.id])
    expect((await opened(id, viewer)).status).toBe(200)
    await app.db.query(`UPDATE users SET role = 'viewer' WHERE id = $1`, [viewer.user.id])
    expect((await opened(id, viewer)).status).toBe(404)
    // Joining a role later is no news in the bell: the alert is for those it reached when it was shared.
    expect((await sharedAlerts(viewer)).some((a) => a.title.endsWith('For the inspectors'))).toBe(false)
  })

  it('reaches no inactive account: not told, nothing listed', async () => {
    const id = await newReport({ title: 'For the supervisors' })
    const inactive = await app.db.query<{ id: string }>(`INSERT INTO users (username, name, role, password_hash, is_active) VALUES ('sleepy', 'Sam Sleepy', 'supervisor', 'x', false) RETURNING id`)
    await share(id, p.creator, { add: [{ kind: 'role', role: 'supervisor' }] })
    const told = await app.db.query(`SELECT 1 FROM user_notifications WHERE user_id = $1`, [inactive.rows[0].id])
    expect(told.rowCount).toBe(0)
    expect(await anySharedReports(app.db, inactive.rows[0].id)).toBe(false)
    expect(await anySharedReports(app.db, p.plain.user.id)).toBe(true)
  })
})

describe('the photos a recipient’s run shows', () => {
  async function upload(s: Session): Promise<string> {
    const bytes = tinyJpeg(seed++)
    const form = new FormData()
    form.append('file', new Blob([bytes], { type: 'image/jpeg' }), 'photo.jpg')
    for (const [k, v] of Object.entries({ originalFilename: 'photo.jpg', width: '10', height: '10', sha256: createHash('sha256').update(bytes).digest('hex'), thumbnailDataUrl: 'data:image/jpeg;base64,AAAA' })) {
      form.append(k, v)
    }
    const res = await app.api<ImageAsset>('POST', '/api/images', { token: s.token, raw: form })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    return res.body.id
  }
  const content = async (s: Session, id: string) => (await app.api('GET', `/api/images/${id}/content`, { token: s.token })).status

  it('lets the recipient open the inspection photos their run showed, for a while, and no others', async () => {
    await app.api('POST', '/api/orders/import', {
      token: p.owner.token,
      body: { rows: [{ lineKey: 'S-1', orderNumber: '70001', item: 'Upright', itemCode: 'UP-1', workCenterCode: '31', requiredQty: 100, finishedQty: 0, customer: 'C', drawing: 'D-1' }] },
    })
    const order = (await app.api<ProductionOrder[]>('GET', '/api/orders', { token: p.owner.token })).body.find((o) => o.orderNumber === '70001')!
    const session = await app.api<SessionWithOrder>('POST', '/api/sessions', { token: p.creator.token, body: { orderId: order.id, startQty: 0 } })
    const [shown, notShown, uploadedOnly] = [await upload(p.creator), await upload(p.creator), await upload(p.creator)]
    const saved = await app.api('POST', `/api/sessions/${session.body.id}/samples`, {
      token: p.creator.token,
      body: {
        submissionId: randomUUID(),
        drawing: 'D-1',
        sampleQty: 5,
        dimensions: [],
        defects: [
          { defectName: 'Crack', qty: 1, disposition: 'Repair', imageIds: [shown] },
          { defectName: 'Dent', qty: 1, disposition: 'Repair', imageIds: [notShown] },
        ],
        coils: [],
      },
    })
    expect(saved.status).toBe(201)
    const id = await newReport({
      title: 'Cracks in photos',
      inputs: [],
      sections: [
        { title: 'Cracks', sql: `SELECT photo_id, defect_name FROM ai.inspection_photos WHERE defect_name = 'Crack'` },
        // An id a result merely names — a photo no inspection holds — opens nothing.
        { title: 'Named', sql: `SELECT '${uploadedOnly}'::uuid AS "Photo_ID", 'x' AS caption` },
      ],
    })
    // A second viewer who opens no inspection screen either.
    const made = await app.api<{ id: string }>('POST', '/api/users', { token: p.owner.token, body: { username: 'watcher2', password: 'Password#1', name: 'Wes Watcher', role: 'viewer' } })
    const away = ['view-inspections', 'view-history'].map((permission) => ({ permission, granted: false }))
    expect((await app.api('PUT', `/api/users/${made.body.id}/permissions`, { token: p.owner.token, body: { overrides: away } })).status).toBe(200)
    const other = await app.login('watcher2')
    await share(id, p.creator, { add: [user(viewer), user(other)] })
    for (const photo of [shown, notShown, uploadedOnly]) expect(await content(viewer, photo)).toBe(404)

    const res = await run(id, viewer)
    expect(res.body.sections[0].rows).toEqual([[shown, 'Crack']])
    expect(runPhotoIds(res.body.sections).sort()).toEqual([shown, uploadedOnly].sort())
    expect(await content(viewer, shown)).toBe(200)
    expect(await content(viewer, notShown)).toBe(404)
    expect(await content(viewer, uploadedOnly)).toBe(404)
    // Only the person whose run showed it: another recipient who has not run it sees nothing yet.
    expect(await content(other, shown)).toBe(404)
    const listedIds = (await app.api<ImageAsset[]>('GET', `/api/images?ids=${[shown, notShown].join(',')}`, { token: viewer.token })).body.map((i) => i.id)
    expect(listedIds).toEqual([shown])

    // Unshared, the photo closes at once.
    await share(id, p.creator, { remove: [user(viewer)] })
    expect(await content(viewer, shown)).toBe(404)
    await share(id, p.creator, { add: [user(viewer)] })
    expect(await content(viewer, shown)).toBe(200)
    // And when its day is over (the daily upkeep then removes the grant).
    await app.db.query(`UPDATE ai_report_share_images SET expires_at = now() - interval '1 minute' WHERE report_id = $1`, [id])
    expect(await content(viewer, shown)).toBe(404)
    expect(await purgeSharePhotos(app.db)).toBeGreaterThan(0)
    expect((await app.db.query(`SELECT 1 FROM ai_report_share_images WHERE report_id = $1`, [id])).rowCount).toBe(0)
  })
})
