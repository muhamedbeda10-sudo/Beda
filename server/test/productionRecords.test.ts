import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import {
  EXISTING_KEYS_MAX,
  type ApiErrorBody,
  type AuditListResponse,
  type ClearProductionRecordsResult,
  type ExistingKeysResponse,
  type ImportResult,
  type ProductionRecordImportRow,
  type ProductionRecordsSummary,
} from '@qc/shared/api'
import { AI_DOMAIN_IDS, AI_PREVIEW_ROWS, type AiAccess, type AiCell, type AiDomain, type AiMeResponse } from '@qc/shared/ai'
import { TestApp, type Session } from './harness'
import { AI_DOMAIN_COMBINATIONS, combinationRole, domainsOfBits } from '../src/ai/domains'
import { renderSystemPrompt } from '../src/ai/prompt'
import { runReadOnlyQuery } from '../src/ai/runQuery'
import { describeAiSchema } from '../src/ai/schemaDoc'

// §24 — the ERP's production task record: the child of the order sheet, one
// row per day's work (a shift, or a stage) on an order line, imported by an
// administrator and read by the assistant through the fifth data domain. The import reads the
// export's own spellings (days, "Day3", "01/2026", the placeholder for an
// unrecorded time), is idempotent on Order ID + Record ID, keeps rows a
// later file leaves out, and can be undone and redone. The view joins the
// line and the machine; PostgreSQL keeps the domain to those given it.

const app = new TestApp()
let owner: Session
let inspector: Session
let database: string
const OLD_DOMAINS: AiDomain[] = ['inspection', 'orders', 'materials', 'audit']

/** What the assistant reads, as the role of these domains (every domain unless given), in factory time. */
async function read(sql: string, domains: readonly AiDomain[] = AI_DOMAIN_IDS): Promise<AiCell[][]> {
  const res = await runReadOnlyQuery(app.aiReader.poolFor(domains), sql, { maxRows: AI_PREVIEW_ROWS, timeoutMs: 10_000, timeZone: app.config.FACTORY_TIMEZONE })
  if (!res.ok) throw new Error(`${res.error}\n${sql}`)
  return res.rows
}

const importRows = (rows: ProductionRecordImportRow[], as: Session = owner) =>
  app.api<ImportResult>('POST', '/api/production-records/import', { token: as.token, body: { rows } })

/** The first day of line 490226, as the ERP writes a day (ISO with a midnight time), with every column filled. */
const DAY1: ProductionRecordImportRow = {
  lineKey: '490226',
  erpRecordId: '113290',
  week: '01/2026',
  orderNumber: '19383-Ph1.7-SGR',
  item: 'Shuttle Rail : 218-RO-SP : 10800-LH-T1 : 27',
  colour: 'ZC',
  producedQty: 132,
  worker1: 'مصطفى  محمود ',
  worker2: '',
  worker3: 'مصطفى محمود',
  worker4: 'احمد حسن',
  dayNo: 'Day1',
  workDay: '2025-12-26 00:00:00',
  workCenterCode: '40',
  durationHours: 1.76,
  stageQty: 0,
  lengthMm: 10800,
  widthMm: 347,
  thicknessMm: 3,
  requiredQty: 132,
  actualHours: 2,
  plannedHours: 1.76,
  shift: 'وردية صباحية 8 ساعات',
  resource: 'Roll Forming Line C2792015',
  weightKg: 10485,
  producedWeightKg: 10485,
  producedLengthM: 1425.6,
}

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  database = new URL(app.config.DATABASE_URL).pathname.slice(1)
  owner = await app.register('admin', 'Admin')
  inspector = await app.register('insp', 'Inspector')
  for (const m of [
    { code: '40', name: 'Roll Forming', line: 'LM1', displayName: '40. Roll Forming C2792015', process: 'forming', factory: 'Factory 1' },
    { code: '21', name: 'Press 400 t', line: 'LM3', displayName: '21. Press 400 t', process: 'universal', factory: 'Factory 2', onDashboard: false },
  ]) {
    expect((await app.api('POST', '/api/master/machines', { token: owner.token, body: m })).status).toBe(201)
  }
  // The order sheet: two of the record's lines are on it, the third is not.
  const sheet = await app.api<ImportResult>('POST', '/api/orders/import', {
    token: owner.token,
    body: {
      rows: [
        { lineKey: '490226', orderNumber: '19383-Ph1.7-SGR', item: 'Shuttle Rail', itemCode: 'SR-218', workCenterCode: '40', requiredQty: 132, finishedQty: 100, customer: 'Alpha Racking', erpStatus: 'Active' },
        { lineKey: '486768', orderNumber: '19145-Ph14.23-EHF', item: 'XL Boxed Beam Connector', itemCode: 'XBC-5TA3', workCenterCode: '21', requiredQty: 3872, finishedQty: 3872, customer: 'Beta Storage', erpStatus: 'Active' },
      ],
    },
  })
  expect(sheet.body).toEqual({ inserted: 2, updated: 0, unchanged: 0 })
})
afterAll(() => app.stop())

describe('§24 the production task record import', () => {
  it('imports records on Order ID + Record ID, reading every column as the ERP writes it', async () => {
    const res = await importRows([
      DAY1,
      // Day-first date, the week with a typo (kept), the placeholder for an unrecorded time, no quantity at all.
      { ...DAY1, erpRecordId: '113291', dayNo: 'Day2', workDay: '27/12/2025', week: '01/2028', actualHours: 0.00001, producedQty: undefined, producedWeightKg: undefined, producedLengthM: undefined },
      // A staged line on the press, day 3 written as a bare number, a week that is not a week, a zero quantity.
      { lineKey: '486768', erpRecordId: '130184', week: 'wk 14', orderNumber: '19145-Ph14.23-EHF', item: 'XL Boxed Beam Connector : 5TA3 : X : LH', producedQty: 0, requiredQty: 3872, worker1: 'حسين صبرى', dayNo: 3, workDay: '2026-03-31', workCenterCode: '21', durationHours: 4.99, stageNo: 2, stageQty: 429, actualHours: 5, plannedHours: 4.99, shift: 'وردية مسائية 8 ساعات', resource: 'Press Line APY400-GLK4-400', weightKg: 3026 },
      // The same line's next stage the day after, nothing finished yet, the machine's code written with a leading zero.
      { lineKey: '486768', erpRecordId: '130185', week: '14/2026', orderNumber: '19145-Ph14.23-EHF', item: 'XL Boxed Beam Connector : 5TA3 : X : LH', producedQty: 0, requiredQty: 3872, dayNo: 'Day4', workDay: '2026-04-01', workCenterCode: '021', durationHours: 4.99, stageNo: 3, stageQty: 1000, actualHours: 0.00001, plannedHours: 4.99, resource: 'Press Line APY400-GLK4-400', weightKg: 3026 },
      // A line the sheet does not have, on a machine the register does not have, with no day.
      { lineKey: '999001', erpRecordId: '140000', orderNumber: '19999-X', item: 'Unknown Thing', producedQty: 10, requiredQty: 10, workCenterCode: '99', resource: 'Shear GPN840 4mt' },
    ])
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body).toEqual({ inserted: 5, updated: 0, unchanged: 0 })

    const { rows } = await app.db.query(
      `SELECT line_key, erp_record_id, week, week_no, week_year, produced_qty, required_qty, day_no, work_day::text AS work_day, actual_hours, planned_hours,
              duration_hours, stage_no, stage_qty, produced_weight_kg, produced_length_m, worker_1, worker_3, shift, deleted_at, imported_at
         FROM production_task_records ORDER BY line_key, erp_record_id`,
    )
    expect(rows).toMatchObject([
      { line_key: '486768', erp_record_id: '130184', week: 'wk 14', week_no: null, week_year: null, produced_qty: 0, required_qty: 3872, day_no: 3, work_day: '2026-03-31', actual_hours: 5, stage_no: 2, stage_qty: 429, worker_1: 'حسين صبرى' },
      { line_key: '486768', erp_record_id: '130185', week: '14/2026', week_no: 14, week_year: 2026, produced_qty: 0, required_qty: 3872, day_no: 4, work_day: '2026-04-01', actual_hours: null, stage_no: 3, stage_qty: 1000, worker_1: '' },
      { line_key: '490226', erp_record_id: '113290', week: '01/2026', week_no: 1, week_year: 2026, produced_qty: 132, day_no: 1, work_day: '2025-12-26', actual_hours: 2, planned_hours: 1.76, duration_hours: 1.76, stage_no: null, stage_qty: 0, produced_weight_kg: 10485, produced_length_m: 1425.6, worker_1: 'مصطفى  محمود', shift: 'وردية صباحية 8 ساعات', deleted_at: null },
      { line_key: '490226', erp_record_id: '113291', week: '01/2028', week_no: 1, week_year: 2028, produced_qty: null, day_no: 2, work_day: '2025-12-27', actual_hours: null, produced_weight_kg: null, produced_length_m: null },
      { line_key: '999001', erp_record_id: '140000', week: '', week_no: null, produced_qty: 10, day_no: null, work_day: null, actual_hours: null, stage_no: null, stage_qty: null },
    ])
    for (const r of rows) expect(r.imported_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    const audit = await app.api<AuditListResponse>('GET', '/api/audit', { token: owner.token })
    expect(audit.body.entries.filter((e) => e.entity === 'ProductionTaskRecord')).toMatchObject([{ action: 'update', entityId: 'bulk-import', field: 'import', newValue: '5 inserted, 0 updated, 0 unchanged' }])
  })

  it('refuses a day or a day number it cannot read, naming the row, and anything negative or blank', async () => {
    const cases: [ProductionRecordImportRow, RegExp][] = [
      [{ ...DAY1, workDay: '31/02/2026' }, /Order ID "490226", record 113290: "31\/02\/2026" is not a day/],
      [{ ...DAY1, workDay: 'yesterday' }, /is not a day \(write it as 2026-01-05 or 05\/01\/2026\)/],
      [{ ...DAY1, erpRecordId: '7', dayNo: 'Dayx' }, /Order ID "490226", record 7: "Dayx" is not a day number/],
      [{ ...DAY1, dayNo: 1.5 }, /is not a day number/],
      // A number the column cannot hold is refused like any other non-day, not left to the database.
      [{ ...DAY1, dayNo: 40000 }, /Order ID "490226", record 113290: "40000" is not a day number/],
      [{ ...DAY1, dayNo: 'Day40000' }, /is not a day number/],
      [{ ...DAY1, producedQty: -1 }, /producedQty/],
      [{ ...DAY1, stageNo: 1.5 }, /stageNo/],
      [{ ...DAY1, lineKey: '  ' }, /lineKey/],
      [{ ...DAY1, erpRecordId: '' }, /erpRecordId/],
    ]
    for (const [row, message] of cases) {
      const res = await importRows([row])
      expect(res.status, JSON.stringify(row)).toBe(400)
      expect((res.body as unknown as ApiErrorBody).error.message, JSON.stringify(row)).toMatch(message)
    }
    expect((await app.api('POST', '/api/production-records/import', { token: owner.token, body: { rows: [] } })).status).toBe(400)
    expect((await importRows(Array.from({ length: 1001 }, (_, i) => ({ ...DAY1, erpRecordId: `r${i}` })))).status).toBe(400)
    // A request refused writes nothing: still the five rows.
    expect((await app.db.query('SELECT count(*)::int AS n FROM production_task_records')).rows[0].n).toBe(5)
  })

  it('is idempotent: a re-import that changes a row writes it over and counts it, the same record id on another line is another row, and the last of a repeated key wins', async () => {
    const again = await importRows([
      { ...DAY1, producedQty: 140, actualHours: 2.5, worker4: '' },
      // The ERP's record id repeats across order lines: this is a different record.
      { ...DAY1, lineKey: '486768', producedQty: 1 },
    ])
    expect(again.body).toEqual({ inserted: 1, updated: 1, unchanged: 0 })
    const { rows } = await app.db.query(
      `SELECT line_key, produced_qty, actual_hours, worker_4, imported_at > created_at AS reimported FROM production_task_records WHERE erp_record_id = '113290' ORDER BY line_key`,
    )
    expect(rows).toEqual([
      { line_key: '486768', produced_qty: 1, actual_hours: 2, worker_4: 'احمد حسن', reimported: false },
      { line_key: '490226', produced_qty: 140, actual_hours: 2.5, worker_4: '', reimported: true },
    ])

    // One batch naming a record twice applies the later row; the key is matched whatever its case.
    const twice = await importRows([
      { lineKey: 'l-abc', erpRecordId: 'R1', producedQty: 5 },
      { lineKey: 'L-ABC', erpRecordId: 'r1', producedQty: 6 },
    ])
    expect(twice.body).toEqual({ inserted: 1, updated: 0, unchanged: 0 })
    const once = await importRows([{ lineKey: 'L-abc', erpRecordId: 'R1', producedQty: 7 }])
    expect(once.body).toEqual({ inserted: 0, updated: 1, unchanged: 0 })
    // The spelling stored is the one that made the row (the later of the first batch); a re-import keeps it, as the order sheet's does.
    const abc = await app.db.query(`SELECT line_key, erp_record_id, produced_qty FROM production_task_records WHERE lower(line_key) = 'l-abc'`)
    expect(abc.rows).toEqual([{ line_key: 'L-ABC', erp_record_id: 'r1', produced_qty: 7 }])
  })

  it('answers which records exist in the importer’s composite-key convention', async () => {
    const res = await app.api<ExistingKeysResponse>('POST', '/api/production-records/existing-keys', {
      token: owner.token,
      body: { keys: ['490226||113290', '490226||113290', 'L-ABC||r1', '490226||999', '999||113290', '113290', 'a||b||c'] },
    })
    expect(res.status).toBe(200)
    expect(res.body.existing.sort()).toEqual(['490226||113290', 'l-abc||r1'])
    const keys = Array.from({ length: EXISTING_KEYS_MAX }, (_, i) => `probe-${i}||${i}`)
    expect((await app.api('POST', '/api/production-records/existing-keys', { token: owner.token, body: { keys } })).status).toBe(200)
    expect((await app.api('POST', '/api/production-records/existing-keys', { token: owner.token, body: { keys: [...keys, 'one||more'] } })).status).toBe(400)
  })

  it('summarises the record for the import page', async () => {
    const res = await app.api<ProductionRecordsSummary>('GET', '/api/production-records/summary', { token: owner.token })
    expect(res.status).toBe(200)
    // Seven rows over four lines (490226, 486768, 999001, l-abc), two of them on the order sheet.
    expect(res.body).toMatchObject({ rows: 7, lines: 4, linesKnown: 2, firstDay: '2025-12-26', lastDay: '2026-04-01' })
    expect(res.body.lastImportAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('is an administrator’s alone', async () => {
    expect((await importRows([DAY1], inspector)).status).toBe(403)
    expect((await app.api('POST', '/api/production-records/existing-keys', { token: inspector.token, body: { keys: ['490226||113290'] } })).status).toBe(403)
    expect((await app.api('GET', '/api/production-records/summary', { token: inspector.token })).status).toBe(403)
    expect((await app.api('DELETE', '/api/production-records', { token: inspector.token })).status).toBe(403)
    expect((await app.api('GET', '/api/production-records/summary')).status).toBe(401)
    expect((await app.api('GET', '/api/production-records/nothing', { token: owner.token })).status).toBe(404)
  })
})

describe('§24 what the assistant reads', () => {
  it('shows each record with its order line and machine when they are known, and says so when they are not', async () => {
    const rows = await read(
      `SELECT line_key, erp_record_id, order_line_known, item_code, customer, order_required_qty, order_finished_qty, erp_status,
              work_center_code, machine, factory, process, counts_on_dashboard, resource, work_day, work_month, day_no, week_no, week_year,
              produced_qty, required_qty, actual_hours, stage_no, stage_qty
         FROM ai.production_task_records
        WHERE (line_key, erp_record_id) IN (('490226', '113290'), ('490226', '113291'), ('486768', '130184'), ('486768', '130185'), ('999001', '140000'))
        ORDER BY line_key, erp_record_id`,
    )
    // The machine is resolved once, by ai.machine_key: '021' is the register's '21', and its dashboard flag comes with its name.
    expect(rows).toEqual([
      ['486768', '130184', true, 'XBC-5TA3', 'Beta Storage', 3872, 3872, 'Active', '21', '21. Press 400 t', 'Factory 2', 'universal', false, 'Press Line APY400-GLK4-400', '2026-03-31', '2026-03', 3, null, null, 0, 3872, 5, 2, 429],
      ['486768', '130185', true, 'XBC-5TA3', 'Beta Storage', 3872, 3872, 'Active', '021', '21. Press 400 t', 'Factory 2', 'universal', false, 'Press Line APY400-GLK4-400', '2026-04-01', '2026-04', 4, 14, 2026, 0, 3872, null, 3, 1000],
      ['490226', '113290', true, 'SR-218', 'Alpha Racking', 132, 100, 'Active', '40', '40. Roll Forming C2792015', 'Factory 1', 'forming', true, 'Roll Forming Line C2792015', '2025-12-26', '2025-12', 1, 1, 2026, 140, 132, 2.5, null, 0],
      ['490226', '113291', true, 'SR-218', 'Alpha Racking', 132, 100, 'Active', '40', '40. Roll Forming C2792015', 'Factory 1', 'forming', true, 'Roll Forming Line C2792015', '2025-12-27', '2025-12', 2, 1, 2028, null, 132, null, null, 0],
      ['999001', '140000', false, null, null, null, null, null, '99', 'Machine 99', '', null, true, 'Shear GPN840 4mt', null, null, null, null, null, 10, 10, null, null, null],
    ])
    // order_line_id is the sheet's row, so the two join as the design says: on line_key.
    const joined = await read(
      `SELECT r.line_key, o.item, o.machine_code, r.order_line_id = o.order_line_id AS same_row, sum(r.produced_qty) AS made, max(r.required_qty) AS required
         FROM ai.production_task_records r JOIN ai.order_lines o ON o.line_key = r.line_key
        GROUP BY r.line_key, o.item, o.machine_code, same_row ORDER BY r.line_key`,
    )
    expect(joined).toEqual([
      ['486768', 'XL Boxed Beam Connector', '21', true, 1, 3872],
      ['490226', 'Shuttle Rail', '40', true, 140, 132],
    ])
  })

  it('lists the workers of a record once each, blanks left out, in their columns’ order', async () => {
    const rows = await read(
      `SELECT erp_record_id, to_jsonb(workers) AS workers, array_length(workers, 1) AS n FROM ai.production_task_records
        WHERE line_key = '490226' ORDER BY erp_record_id`,
    )
    // The runner hands JSON cells to the model as text.
    expect(rows).toEqual([
      ['113290', '["مصطفى محمود"]', 1],
      ['113291', '["مصطفى محمود","احمد حسن"]', 2],
    ])
    const byPerson = await read(
      `SELECT w AS person, count(*) AS days, sum(produced_qty) AS made FROM ai.production_task_records, unnest(workers) AS w GROUP BY w ORDER BY w`,
    )
    // Six rows: two of them the copy of DAY1 written on line 486768 above, with its two people and one piece.
    expect(byPerson).toEqual([
      ['احمد حسن', 2, 1],
      ['حسين صبرى', 1, 0],
      ['مصطفى محمود', 3, 141],
    ])
    const none = await read(`SELECT to_jsonb(workers), array_length(workers, 1) FROM ai.production_task_records WHERE line_key = '999001'`)
    expect(none).toEqual([['[]', null]])
  })

  it('leaves out what was removed, and shows it again once re-imported', async () => {
    expect((await read(`SELECT count(*) FROM ai.production_task_records`))[0]).toEqual([7])
    const cleared = await app.api<ClearProductionRecordsResult>('DELETE', '/api/production-records', { token: owner.token })
    expect(cleared.status).toBe(200)
    expect(cleared.body).toEqual({ removed: 7 })
    expect((await read(`SELECT count(*) FROM ai.production_task_records`))[0]).toEqual([0])
    expect((await app.api<ProductionRecordsSummary>('GET', '/api/production-records/summary', { token: owner.token })).body).toEqual({
      rows: 0, lines: 0, linesKnown: 0, firstDay: null, lastDay: null, lastImportAt: null,
    })
    const gone = await app.db.query(`SELECT count(*)::int AS n, count(deleted_by_id)::int AS by FROM production_task_records WHERE deleted_at IS NOT NULL`)
    expect(gone.rows[0]).toEqual({ n: 7, by: 7 })
    expect((await app.api('DELETE', '/api/production-records', { token: owner.token })).body).toEqual({ removed: 0 })

    // The fresh export still carries the record: the upsert brings it back in place, as an update.
    const back = await importRows([{ ...DAY1, producedQty: 150 }])
    expect(back.body).toEqual({ inserted: 0, updated: 1, unchanged: 0 })
    expect(await read(`SELECT erp_record_id, produced_qty FROM ai.production_task_records`)).toEqual([['113290', 150]])
    expect((await app.db.query(`SELECT deleted_at, deleted_by_id FROM production_task_records WHERE erp_record_id = '113290' AND line_key = '490226'`)).rows[0]).toEqual({ deleted_at: null, deleted_by_id: null })
    // Never erased: the database refuses a DELETE outright.
    await expect(app.db.query(`DELETE FROM production_task_records`)).rejects.toThrow(/Hard delete is not allowed/)

    const audit = await app.api<AuditListResponse>('GET', '/api/audit', { token: owner.token })
    const entries = audit.body.entries.filter((e) => e.entity === 'ProductionTaskRecord').map((e) => [e.action, e.entityId, e.newValue])
    expect(entries.slice(0, 3)).toEqual([
      ['update', 'bulk-import', '0 inserted, 1 updated, 0 unchanged'],
      ['delete', 'bulk-clear', '0 production records marked deleted before a fresh import'],
      ['delete', 'bulk-clear', '7 production records marked deleted before a fresh import'],
    ])
  })
})

describe('§24 the production domain', () => {
  it('is its own role, reading its view and the machines and nothing else, through the runner and by its grants', async () => {
    const only = combinationRole(database, '000010')
    expect(app.aiReader.roleFor(['production'])).toBe(only)
    const { rows } = await app.db.query<{ name: string; can: boolean }>(
      `SELECT viewname AS name, has_table_privilege($1, 'ai.' || viewname, 'SELECT') AS can FROM pg_views WHERE schemaname = 'ai' ORDER BY 1`,
      [only],
    )
    expect(rows.filter((r) => r.can).map((r) => r.name)).toEqual(['machines', 'production_task_records'])
    expect(rows).toHaveLength(36)
    expect(await read(`SELECT count(*) FROM ai.production_task_records`, ['production'])).toEqual([[1]])
    expect(await read(`SELECT count(*) FROM ai.machines`, ['production'])).toEqual([[2]])
    for (const view of ['inspection_sessions', 'order_lines', 'coils', 'audit_log', 'users']) {
      const res = await runReadOnlyQuery(app.aiReader.poolFor(['production']), `SELECT 1 FROM ai.${view} LIMIT 1`, { maxRows: 10, timeoutMs: 10_000, timeZone: 'Africa/Cairo' })
      expect(res, view).toMatchObject({ ok: false, code: '42501', error: expect.stringMatching(/permission denied for view/) })
    }
    // And the other way round: the four domains of before see nothing of it.
    for (const bits of AI_DOMAIN_COMBINATIONS) {
      const domains = domainsOfBits(bits)
      const can = await app.db.query<{ can: boolean }>(`SELECT has_table_privilege($1, 'ai.production_task_records', 'SELECT') AS can`, [combinationRole(database, bits)])
      expect(can.rows[0].can, bits).toBe(domains.includes('production'))
      const res = await runReadOnlyQuery(app.aiReader.poolFor(domains), `SELECT 1 FROM ai.production_task_records LIMIT 1`, { maxRows: 10, timeoutMs: 10_000, timeZone: 'Africa/Cairo' })
      expect(res.ok, bits).toBe(domains.includes('production'))
    }
  })

  it('is described to the model, with its meanings, only for a person who has it; everyone else’s prompt says nothing of it', async () => {
    const tz = app.config.FACTORY_TIMEZONE
    const PRODUCTION_WORDS = ["the ERP's production task record", 'ai.production_task_records', 'produced_weight_kg', 'order_line_known', 'imported_at', 'worker_1']

    const own = renderSystemPrompt(tz, await describeAiSchema(app.db, ['production']), ['production'])
    for (const w of PRODUCTION_WORDS) expect(own, w).toContain(w)
    expect(own).toContain("- the ERP's production task record: what each machine made per day, by whom and in which shift, with hours, weights and lengths")
    expect(own).toContain('### ai.production_task_records\n')
    expect(own).toContain('### ai.machines\n')
    expect(own).toContain('- required_qty double precision: The task\'s required pieces, repeated on EVERY row of the line')
    expect(own).toContain('- workers text[]: The people on the machine that day')
    expect(own).toContain('# Meanings that are easy to get wrong')
    expect(own).toContain("a row is one day's work on one order line (line_key + day_no; two rows may share a work_day: another shift or stage - count days with count(DISTINCT work_day)), the child of the order sheet")
    expect(own).toContain('take it once per line_key (max(required_qty) GROUP BY line_key)')
    expect(own).toContain("Per TASK, repeated on every row of the line: required_qty, duration_hours (the task's planned hours) and weight_kg (the task's weight) - never sum them across days")
    expect(own).toContain("the stage rows carry produced_qty 0 and the stage's pieces in stage_qty")
    expect(own).toContain("week / week_no / week_year is the ERP's planning week of the task, the same on every row of the line, not the week the work was done")
    expect(own).toContain("Periods of the task record are work_day (work_day >= '2026-09-01' AND work_day < '2026-10-01'), never imported_at")
    expect(own).toContain('actual_hours NULL = not recorded')
    expect(own).toContain('imported_at says how fresh a row is')
    // The view's own comments tell the same story.
    expect(own).toContain("One row = one day's work (a shift, or a stage) on one ORDER LINE (line_key), numbered day_no; a line often has two rows on the same work_day")
    expect(own).toContain("for the rest join ai.order_lines on line_key when you can read it")
    expect(own).toContain("week is the task's PLANNING week, not the week of the work: periods and weeks come from work_day")
    expect(own).toContain("- duration_hours double precision: The ERP's planned hours for the WHOLE task")
    expect(own).toContain("- weight_kg double precision: The WHOLE task's weight in kg")
    expect(own).toContain("- stage_no smallint: Staged (universal) lines only: the stage this row's work was for, with stage_qty the pieces that passed it that day; such a row has produced_qty 0")
    expect(own).toContain("- day_no smallint: Numbers the line's rows in the ERP's order (Day1, Day2 …); several may fall on the same work_day")
    expect(own).toContain('never on imported_at; group days by work_day, months by work_month')
    expect(own).not.toContain('join ai.order_lines on line_key for everything about the line')
    for (const view of ['inspection_sessions', 'order_lines', 'coils', 'audit_log']) expect(own).not.toContain(`### ai.${view}\n`)
    // Alone, the record is the only production there is: not a word of the inspection record's figure.
    expect(own).not.toContain('production_between')
    expect(own).not.toContain('Two records of production exist')

    // The prompt of anyone without the domain is as it was: not a word of the record, whatever else they have.
    for (const bits of AI_DOMAIN_COMBINATIONS) {
      const domains = domainsOfBits(bits)
      if (domains.includes('production')) continue
      const prompt = renderSystemPrompt(tz, await describeAiSchema(app.db, domains), domains)
      for (const w of PRODUCTION_WORDS) expect(prompt, `${bits} ${w}`).not.toContain(w)
      expect(prompt, bits).not.toContain('production task record')
      // The same bytes every time, whichever order the domains come in.
      expect(prompt, bits).toBe(renderSystemPrompt(tz, await describeAiSchema(app.db, [...domains].reverse()), [...domains].reverse()))
    }
    // With the other four, the record's section and meanings simply join the rest.
    const all = renderSystemPrompt(tz, await describeAiSchema(app.db, AI_DOMAIN_IDS), AI_DOMAIN_IDS)
    const old = renderSystemPrompt(tz, await describeAiSchema(app.db, OLD_DOMAINS), OLD_DOMAINS)
    expect(all.length).toBeGreaterThan(old.length)
    expect(all).toContain('It joins ai.order_lines on line_key when you can read both')

    // Someone who reads both records is told which production is which; someone who reads one of them is not.
    const RECONCILED = "- Two records of production exist: the inspection record's (closed inspection sessions: ai.production_between, the dashboard's figure) and the ERP's production task record (sum of produced_qty by work_day)."
    expect(all).toContain(RECONCILED)
    expect(all).toContain('Never add the two together.')
    const both: AiDomain[] = ['inspection', 'production']
    expect(renderSystemPrompt(tz, await describeAiSchema(app.db, both), both)).toContain(RECONCILED)
    expect(renderSystemPrompt(tz, await describeAiSchema(app.db, ['inspection']), ['inspection'])).not.toContain('Two records of production')
    expect(renderSystemPrompt(tz, await describeAiSchema(app.db, ['orders', 'production']), ['orders', 'production'])).not.toContain('Two records of production')
    expect(own).not.toContain('Two records of production')
  })

  it('can be granted by the owner, on its own or with the rest; nobody has it until then', async () => {
    const grant = (domains: string[]) =>
      app.api<AiAccess>('PUT', `/api/ai/access/${inspector.user.id}`, { token: owner.token, body: { enabled: true, domains, monthlyCapUsd: 5 } })
    const four = await grant(OLD_DOMAINS)
    expect(four.status, JSON.stringify(four.body)).toBe(200)
    expect(four.body.domains).toEqual(OLD_DOMAINS)
    expect((await app.api<AiMeResponse>('GET', '/api/ai/me', { token: inspector.token })).body).toMatchObject({ granted: true, owner: false })

    const alone = await grant(['production'])
    expect(alone.status).toBe(200)
    expect(alone.body.domains).toEqual(['production'])
    const stored = await app.db.query<{ domains: string[] }>(`SELECT domains FROM ai_access WHERE user_id = $1`, [inspector.user.id])
    expect(stored.rows[0].domains).toEqual(['production'])
    const audit = await app.api<AuditListResponse>('GET', '/api/audit', { token: owner.token })
    expect(audit.body.entries.find((e) => e.entity === 'AiAccess' && e.field === 'domains')).toMatchObject({
      oldValue: 'Inspections, Orders and PDI, Coils, suppliers and master data, Audit log and accounts',
      newValue: 'Production record',
    })

    // In its fixed place, last, whatever order it was sent in.
    const all = await grant(['production', 'audit', 'inspection', 'materials', 'orders'])
    expect(all.body.domains).toEqual(['inspection', 'orders', 'materials', 'audit', 'production'])

    // The database holds the list to the five domains; the API refuses an unknown one first.
    expect((await grant(['production', 'sales'])).status).toBe(400)
    await expect(app.db.query(`UPDATE ai_access SET domains = ARRAY['production', 'sales'] WHERE user_id = $1`, [inspector.user.id])).rejects.toThrow(/ai_access_domains/)
  })
})
