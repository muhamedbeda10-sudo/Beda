import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { KpiBreakdown, KpiGeneral } from '@qc/shared/kpi'
import type { CloseSessionRequest, SaveSampleRequest, SessionWithOrder } from '@qc/shared/api'
import type { AiCell } from '@qc/shared/ai'
import type { ProductionOrder } from '@qc/shared/types'
import { TestApp, factoryDay, type Session } from './harness'
import { runReadOnlyQuery } from '../src/ai/runQuery'

// §20 — the ai views say what the screens say. Recorded through the API like
// any inspection, then read as the assistant reads it: the dashboard's
// production and rejects, History's per-session figures, holds, and the
// things the assistant must never see.

const app = new TestApp()
let admin: Session
let inspector: Session
let lines: ProductionOrder[]
const line = (key: string) => lines.find((o) => o.lineKey === key)!
const ids: Record<string, string> = {}

/** What the assistant reads: through its own role, in factory time. */
async function read(sql: string): Promise<AiCell[][]> {
  const res = await runReadOnlyQuery(app.aiReader.pool, sql, { maxRows: 1000, timeoutMs: 10_000, timeZone: app.config.FACTORY_TIMEZONE })
  if (!res.ok) throw new Error(`${res.error}\n${sql}`)
  return res.rows
}

function defects(qty: number, disposition: 'Repair' | 'Hold' = 'Repair'): SaveSampleRequest['defects'] {
  return [{ defectName: 'Burr', qty, disposition, notes: '', imageIds: [] }]
}

/** A welding sample carries its penetrant test. */
const PT: SaveSampleRequest['pt'] = {
  consumableLots: { Cleaner: 'C-1', Penetrant: 'P-1', Developer: 'D-1' },
  weldingWireBatch: 'WW-1',
  testedLengths: [{ lengthMm: 150, verdict: 'Accept' }],
  imageIds: [],
}

async function open(order: ProductionOrder, defectQty: number, opts: { startQty?: number; disposition?: 'Repair' | 'Hold'; pt?: boolean } = {}): Promise<SessionWithOrder> {
  const opened = await app.api<SessionWithOrder>('POST', '/api/sessions', { token: inspector.token, body: { orderId: order.id, startQty: opts.startQty ?? 0 } })
  expect(opened.status, JSON.stringify(opened.body)).toBe(201)
  const saved = await app.api('POST', `/api/sessions/${opened.body.id}/samples`, {
    token: inspector.token,
    body: { submissionId: randomUUID(), drawing: 'D-1', sampleQty: 10, dimensions: [], defects: defects(defectQty, opts.disposition), coils: [], ...(opts.pt ? { pt: PT } : {}) },
  })
  expect(saved.status, JSON.stringify(saved.body)).toBe(201)
  return (await app.api<SessionWithOrder>('GET', `/api/sessions/${opened.body.id}`, { token: inspector.token })).body
}

async function close(s: SessionWithOrder, body: Omit<CloseSessionRequest, 'version'>): Promise<void> {
  const res = await app.api('POST', `/api/sessions/${s.id}/close`, { token: inspector.token, body: { ...body, version: s.version } })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
}

const staged = (...stages: [number, number][]): Omit<CloseSessionRequest, 'version'> => ({ universal: { kind: 'staged', stages: stages.map(([stage, qty]) => ({ stage, qty })) } })

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  admin = await app.register('admin', 'Admin')
  inspector = await app.register('insp', 'Inspector One')
  for (const m of [
    { code: '90', name: 'Press 90', line: 'LM3', displayName: '90-Press-LM3', process: 'universal', factory: 'Factory 1' },
    { code: '58', name: 'Welding', line: 'LM4', displayName: '58-Welding-LM4', process: 'welding', factory: 'Factory 2' },
    { code: '31', name: 'Roll Forming', line: 'LM2', displayName: '31-Roll Forming-LM2', process: 'forming', factory: 'Factory 1' },
    { code: '77', name: 'Manual welding', line: 'LM9', displayName: '77-Manual-LM9', process: 'forming', factory: 'Factory 2', onDashboard: false },
  ]) {
    expect((await app.api('POST', '/api/master/machines', { token: admin.token, body: m })).status).toBe(201)
  }
  const row = (lineKey: string, orderNumber: string, item: string, itemCode: string, workCenterCode: string, finishedQty = 0) => ({
    lineKey, orderNumber, item, itemCode, workCenterCode, requiredQty: 500, finishedQty, customer: 'Client', drawing: 'D-1',
  })
  await app.api('POST', '/api/orders/import', {
    token: admin.token,
    body: { rows: [row('U-1', '60001', 'Base Plate', 'BP-10', '90'), row('U-2', '60001', 'Bracket', 'BR-2', '90'), row('W-1', '60002', 'Frame', 'FR-1', '58'), row('F-1', '60003', 'Upright', 'UP-1', '31'), row('X-1', '60004', 'Spacer', 'SP-1', '77')] },
  })
  lines = (await app.api<ProductionOrder[]>('GET', '/api/orders', { token: admin.token })).body

  // A staged line: stages 1 and 2 at 100, then stage 3 at 90.
  const s1 = await open(line('U-1'), 2)
  await close(s1, staged([1, 100], [2, 100]))
  const s2 = await open(line('U-1'), 3)
  await close(s2, staged([3, 90]))
  ids.stage3 = s2.id
  // A final product: each session a new quantity.
  for (const qty of [40, 25]) {
    const s = await open(line('U-2'), 1)
    await close(s, { universal: { kind: 'final' }, finalQty: qty })
  }
  // Welding, with pieces rejected before release and a defect on Hold.
  const w = await open(line('W-1'), 4, { startQty: 2, disposition: 'Hold', pt: true })
  await close(w, { finalQty: 101 })
  ids.welding = w.id
  const f = await open(line('F-1'), 2)
  await close(f, { finalQty: 200 })
  // A machine the dashboard leaves out.
  const x = await open(line('X-1'), 5)
  await close(x, { finalQty: 50 })
})
afterAll(() => app.stop())

describe('§20 the ai views read like the screens', () => {
  it('gives the dashboard’s production and reject pieces per machine', async () => {
    const from = factoryDay(-1)
    const to = factoryDay(1)
    const g = (await app.api<KpiGeneral>('GET', `/api/kpi/general?from=${from}&to=${to}`, { token: admin.token })).body
    const dashboard = g.machines
      .filter((m) => m.piecesProduced > 0)
      .map((m) => [m.workCenterCode, m.piecesProduced, m.productionDefectPieces])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    const views = await read(
      `SELECT machine_code, sum(produced) AS produced, sum(defect_pieces) AS defects
         FROM ai.production_between('${from}', '${to}') GROUP BY machine_code ORDER BY machine_code`,
    )
    // 90: the staged line once at stage 3 (90) plus the final product 40 + 25; the machine off the dashboard is left out.
    expect(views).toEqual([
      ['31', 200, 2],
      ['58', 101, 4],
      ['90', 90 + 40 + 25, 2 + 3 + 1 + 1],
    ])
    expect(views).toEqual(dashboard)
    // The reject rate as the dashboard computes it.
    const [[rate]] = await read(
      `SELECT round((sum(defect_pieces) / (sum(produced) + sum(defect_pieces)) * 100)::numeric, 4) FROM ai.production_between('${from}', '${to}')`,
    )
    expect(rate).toBeCloseTo((13 / (456 + 13)) * 100, 4)
  })

  it('counts a staged line once per month at the highest stage that month, as the breakdown does', async () => {
    // Stage 3 closed last month: this month the line's highest is stage 2's 100.
    await app.db.query(`UPDATE inspection_sessions SET closed_at = closed_at - interval '40 days' WHERE id = $1`, [ids.stage3])
    const from = `${factoryDay(-45).slice(0, 7)}-01`
    const to = factoryDay(1)
    const b = (await app.api<KpiBreakdown>('GET', `/api/kpi/breakdown?from=${from}&to=${to}&process=universal`, { token: admin.token })).body
    const months = b.months.filter((m) => m.made > 0).map((m) => [m.piecesProduced, m.productionDefectPieces])
    const views = await read(
      `SELECT sum(produced), sum(defect_pieces) FROM ai.production_between('${from}', '${to}', 'month')
        WHERE process = 'universal' GROUP BY period ORDER BY period`,
    )
    expect(views).toEqual([
      [90, 3],
      [100 + 40 + 25, 2 + 1 + 1],
    ])
    expect(views).toEqual(months)
    const span = await read(`SELECT sum(produced) FROM ai.production_between('${from}', '${to}') WHERE machine_code = '90'`)
    expect(span).toEqual([[90 + 40 + 25]])
  })

  it('gives History’s figures for a session', async () => {
    const [row] = await read(
      `SELECT session_no, status, machine, process, opened_by, closed_by, rejected_before_release, first_part_clean,
              final_qty, samples, pieces_inspected, defect_pieces, hold_records, hold_pieces, defect_rate_pct,
              inspected_defect_pct, pt_lengths_required, counts_on_dashboard, started_day = (now() AT TIME ZONE 'Africa/Cairo')::date
         FROM ai.inspection_sessions WHERE session_id = '${ids.welding}'`,
    )
    expect(row).toEqual([1, 'Closed', '58-Welding-LM4', 'welding', 'Inspector One', 'Inspector One', 2, false, 101, 1, 10, 4, 1, 4, 4, 40, 6, true, true])
    // The open hold, as the dashboard lists it.
    expect(await read(`SELECT order_number, machine_code, pieces, hold_age_days FROM ai.defects WHERE disposition = 'Hold'`)).toEqual([['60002', '58', 4, 0]])
  })

  it('marks what the dashboard leaves out', async () => {
    expect(await read(`SELECT line_key, counts_on_dashboard FROM ai.order_lines WHERE line_key IN ('X-1', 'F-1') ORDER BY line_key`)).toEqual([
      ['F-1', true],
      ['X-1', false],
    ])
    expect(await read(`SELECT counts_on_dashboard, count(*) FROM ai.inspection_sessions GROUP BY 1 ORDER BY 1`)).toEqual([
      [false, 1],
      [true, 6],
    ])
  })

  it('counts days in the factory’s time zone', async () => {
    // 21:30 UTC is 23:30 in Cairo in January; 22:30 UTC is already the next day there.
    await app.db.query(`UPDATE inspection_samples SET created_at = '2026-01-15 21:30:00+00' WHERE session_id = $1`, [ids.welding])
    expect(await read(`SELECT recorded_day::text FROM ai.inspection_samples WHERE session_id = '${ids.welding}'`)).toEqual([['2026-01-15']])
    await app.db.query(`UPDATE inspection_samples SET created_at = '2026-01-15 22:30:00+00' WHERE session_id = $1`, [ids.welding])
    expect(await read(`SELECT recorded_day::text, recorded_at FROM ai.inspection_samples WHERE session_id = '${ids.welding}'`)).toEqual([['2026-01-16', '2026-01-16 00:30:00+02']])
  })

  it('leaves chat, notices and the assistant’s own key changes out of the audit trail it reads', async () => {
    await app.db.query(
      `INSERT INTO audit_log (user_id, user_name, action, entity, entity_id, field, old_value, new_value)
       VALUES ($1, 'Admin', 'update', 'Notice', 'n1', 'body', 'old text', 'new text'),
              ($1, 'Admin', 'delete', 'ChatGroup', 'g1', NULL, NULL, NULL),
              ($1, 'Admin', 'update', 'AiAssistant', 'api-key', 'apiKey', 'not set', 'set (…AB12)')`,
      [admin.user.id],
    )
    const seen = await read(`SELECT entity, count(*) FROM ai.audit_log GROUP BY entity ORDER BY entity`)
    const entities = seen.map((r) => r[0])
    expect(entities).toContain('InspectionSession')
    expect(entities).not.toContain('Notice')
    expect(entities).not.toContain('ChatGroup')
    expect(entities).not.toContain('AiAssistant')
  })
})
