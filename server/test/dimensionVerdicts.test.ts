// ============================================================================
// §8.2 — a dimension's verdict is decided in exact decimals, as it is
// stored (numeric(14, 4)), never in floating point: 50.15 +0.05 read at
// 50.2 is on the limit, inside tolerance. Saved that way from now on, and
// the verdicts already stored are decided again by migration 0073: only a
// row whose verdict was wrong changes, it says so in the audit trail as the
// system's correction (not a person's: no inspector's record counts it), and
// the figures kept per sample and session follow.
// ============================================================================

import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { SampleDetail, SaveSampleRequest, SaveSampleResponse, SessionWithOrder } from '@qc/shared/api'
import type { ProductionOrder } from '@qc/shared/types'
import type { KpiOverview } from '@qc/shared/kpi'
import { TestApp, type Session, factoryDay } from './harness'

const app = new TestApp()
let admin: Session
let insp: Session
let sessionId: string
let sampleId: string
let rows: Record<string, string>

const MIGRATION = fileURLToPath(new URL('../migrations/0073_factory_day_exact_tolerances.sql', import.meta.url))

type Dim = SaveSampleRequest['dimensions'][number]
const dim = (name: string, sequence: number, nominal: number | null, tol: number | null, actual: number | null): Dim => ({ name, sequence, nominal, tolPlus: tol, tolMinus: tol, actual, unit: 'mm', source: 'item-order' })

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  admin = await app.register('admin', 'Admin')
  insp = await app.register('insp', 'Hany Fathy')
  await app.api('POST', '/api/master/machines', { token: admin.token, body: { code: '31', name: 'Roll Forming', line: 'LM2', displayName: '31-Roll Forming-LM2', process: 'forming', factory: 'Factory 1' } })
  await app.api('POST', '/api/orders/import', {
    token: admin.token,
    body: { rows: [{ lineKey: 'V-1', orderNumber: '20095-QC1-HYH', item: 'XL Light Beam', itemCode: '125185TA3', workCenterCode: '31', requiredQty: 5000, finishedQty: 0, customer: 'Beta Storage', drawing: 'BS9059/31' }] },
  })
  const order = (await app.api<ProductionOrder[]>('GET', '/api/orders', { token: admin.token })).body[0]
  sessionId = (await app.api<SessionWithOrder>('POST', '/api/sessions', { token: insp.token, body: { orderId: order.id, startQty: 0 } })).body.id
  const saved = await app.api<SaveSampleResponse>('POST', `/api/sessions/${sessionId}/samples`, {
    token: insp.token,
    body: {
      submissionId: randomUUID(),
      drawing: 'BS9059/31',
      sampleQty: 10,
      dimensions: [
        dim('Width', 1, 50.15, 0.05, 50.2), // on the upper limit
        dim('Height', 2, 100, 0.3, 100.27), // on the edge of the warning band
        dim('Depth', 3, 125, 0.5, 125.1), // comfortably inside
        dim('Flange', 4, 40, 0.2, 40.5), // outside
        dim('Paint thickness', 5, null, null, 61), // nothing to judge it by
        dim('Lip', 6, 0.3, 0.1, 0.4), // on the limit again
      ],
      defects: [],
      coils: [],
    } satisfies SaveSampleRequest,
  })
  expect(saved.status).toBe(201)
  sampleId = saved.body.sampleId
  const { rows: found } = await app.db.query<{ name: string; id: string }>(`SELECT name, id FROM dimension_results WHERE sample_id = $1`, [sampleId])
  rows = Object.fromEntries(found.map((r) => [r.name, r.id]))
})
afterAll(() => app.stop())

const statuses = async (): Promise<Record<string, [string, number]>> =>
  Object.fromEntries(
    (await app.db.query<{ name: string; status: string; version: number }>(`SELECT name, status, version FROM dimension_results WHERE sample_id = $1`, [sampleId])).rows.map((r) => [r.name, [r.status, r.version]]),
  )

describe('§8.2 a verdict as saved', () => {
  it('is decided in exact decimals', async () => {
    const detail = (await app.api<SampleDetail>('GET', `/api/samples/${sampleId}`, { token: insp.token })).body
    expect(Object.fromEntries(detail.dimensions.map((d) => [d.name, d.status]))).toEqual({
      Width: 'Warning',
      Height: 'Warning',
      Depth: 'Pass',
      Flange: 'Fail',
      'Paint thickness': 'Pending',
      Lip: 'Warning',
    })
  })
})

describe('§8.2 migration 0073 decides the stored verdicts again', () => {
  let changedAt: string

  it('changes only the verdicts floating point got wrong, as the system, with an audit entry each', async () => {
    // As the floating-point rule stored them: the limit failed, the band's edge passed, the lip failed.
    await app.db.query(`UPDATE dimension_results SET status = 'Fail' WHERE id = ANY($1::uuid[])`, [[rows.Width, rows.Lip]])
    await app.db.query(`UPDATE dimension_results SET status = 'Pass' WHERE id = $1`, [rows.Height])
    // A wrong verdict on a row marked deleted is put right too: a restored sample brings it back.
    await app.db.query(`UPDATE dimension_results SET deleted_at = now() WHERE id = $1`, [rows.Lip])
    const before = await statuses()
    changedAt = (await app.db.query<{ at: string }>(`SELECT now()::text AS at`)).rows[0].at

    await app.db.query(await readFile(MIGRATION, 'utf8'))

    const after = await statuses()
    expect(after).toEqual({
      Width: ['Warning', before.Width[1] + 1],
      Height: ['Warning', before.Height[1] + 1],
      Depth: before.Depth,
      Flange: before.Flange,
      'Paint thickness': before['Paint thickness'],
      Lip: ['Warning', before.Lip[1] + 1],
    })
    const audit = await app.db.query<{ entityId: string; userName: string; isSystem: boolean; action: string; entity: string; field: string; oldValue: string; newValue: string; sessionId: string; sampleId: string; orderNumber: string; workCenterCode: string }>(
      `SELECT a.entity_id AS "entityId", a.user_name AS "userName", u.is_system AS "isSystem", a.action::text AS action, a.entity, a.field,
              a.old_value AS "oldValue", a.new_value AS "newValue", a.session_id AS "sessionId", a.sample_id AS "sampleId",
              a.order_number AS "orderNumber", a.work_center_code AS "workCenterCode"
         FROM audit_log a JOIN users u ON u.id = a.user_id
        WHERE a.at >= $1 AND a.entity = 'DimensionResult' ORDER BY a.entity_id`,
      [changedAt],
    )
    const expected = [
      [rows.Width, 'Fail', 'Warning'],
      [rows.Height, 'Pass', 'Warning'],
      [rows.Lip, 'Fail', 'Warning'],
    ].sort((a, b) => (a[0] < b[0] ? -1 : 1))
    expect(audit.rows).toEqual(
      expected.map(([entityId, oldValue, newValue]) => ({
        entityId,
        userName: 'System — exact tolerance check',
        isSystem: true,
        action: 'update',
        entity: 'DimensionResult',
        field: 'status',
        oldValue,
        newValue,
        sessionId,
        sampleId,
        orderNumber: '20095-QC1-HYH',
        workCenterCode: '31',
      })),
    )
  })

  it('keeps the figures per sample and session as the verdicts now stand', async () => {
    const plain = await app.db.query<{ pass: number; warning: number; fail: number }>(
      `SELECT count(*) FILTER (WHERE actual IS NOT NULL AND status = 'Pass')::int AS pass,
              count(*) FILTER (WHERE actual IS NOT NULL AND status = 'Warning')::int AS warning,
              count(*) FILTER (WHERE status = 'Fail')::int AS fail
         FROM dimension_results WHERE sample_id = $1 AND deleted_at IS NULL`,
      [sampleId],
    )
    expect(plain.rows[0]).toEqual({ pass: 1, warning: 2, fail: 1 })
    const kept = await app.db.query<{ pass: number; warning: number; fail: number; sessionFails: number }>(
      `SELECT r.dimensions_pass AS pass, r.dimensions_warning AS warning, r.dimensions_fail AS fail, s.dimension_fails AS "sessionFails"
         FROM sample_rollups r JOIN session_rollups s ON s.session_id = $2 WHERE r.sample_id = $1`,
      [sampleId, sessionId],
    )
    expect(kept.rows[0]).toEqual({ ...plain.rows[0], sessionFails: 1 })
  })

  it('counts the system’s correction as nobody’s: not a correction on the dashboard, nor against the inspector', async () => {
    const o = (await app.api<KpiOverview>('GET', `/api/kpi/overview?from=${factoryDay(-1)}&to=${factoryDay(1)}&prevFrom=${factoryDay(-31)}&prevTo=${factoryDay(-2)}`, { token: admin.token })).body
    expect(o.discipline.corrections).toBe(0)
    const ranked = [...o.inspectorRanking!.overall.ranked, ...o.inspectorRanking!.overall.unranked]
    expect(ranked.find((r) => r.inspectorId === insp.user.id)?.corrections).toBe(0)
  })

  it('changes nothing when run again', async () => {
    const before = await statuses()
    const entries = (await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log`)).rows[0].n
    await app.db.query(await readFile(MIGRATION, 'utf8'))
    expect(await statuses()).toEqual(before)
    expect((await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log`)).rows[0].n).toBe(entries)
  })
})

describe('migration 0073 bounds a saved report’s timestamps at 08:00', () => {
  it('rewrites a period bound on a timestamp, leaves a day column and everything else as written, and keeps the list’s order', async () => {
    const sections = [
      { title: 'Samples', sql: 'SELECT count(*) AS n FROM ai.inspection_samples x\nWHERE x.recorded_at >= {{from}}\n  AND x.recorded_at < {{to}} + 1' },
      { title: 'By day', sql: 'SELECT recorded_day, count(*) FROM ai.inspection_samples WHERE recorded_day BETWEEN {{from}} AND {{to}} GROUP BY 1' },
    ]
    const { rows: made } = await app.db.query<{ id: string; updatedAt: string }>(
      `INSERT INTO ai_reports (user_id, title, question, period, adjustable, sections, updated_at)
       VALUES ($1, 'Samples', 'How many samples?', '{"kind":"yesterday"}', true, $2::json, '2026-01-01T00:00:00Z')
       RETURNING id, updated_at::text AS "updatedAt"`,
      [admin.user.id, JSON.stringify(sections)],
    )
    await app.db.query(await readFile(MIGRATION, 'utf8'))
    const { rows: after } = await app.db.query<{ sections: { title: string; sql: string }[]; updatedAt: string }>(
      `SELECT sections, updated_at::text AS "updatedAt" FROM ai_reports WHERE id = $1`,
      [made[0].id],
    )
    expect(after[0].sections).toEqual([
      { title: 'Samples', sql: 'SELECT count(*) AS n FROM ai.inspection_samples x\nWHERE x.recorded_at >= ai.factory_day_start({{from}})\n  AND x.recorded_at < ai.factory_day_start({{to}} + 1)' },
      sections[1],
    ])
    expect(after[0].updatedAt).toBe(made[0].updatedAt)
  })
})
