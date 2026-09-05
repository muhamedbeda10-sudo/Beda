import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { EXISTING_KEYS_MAX, type ApiErrorBody, type AuditListResponse, type ImportResult, type ExistingKeysResponse, type OrderHistory, type CoilUsage } from '@qc/shared/api'
import type { OrderNumberSummary } from '@qc/shared/api'
import type { Machine, ProductionOrder, Coil, WorkCenterDefect, ItemDimensionOrder } from '@qc/shared/types'
import { TestApp, type Session } from './harness'

const app = new TestApp()
let admin: Session
let inspector: Session

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  admin = await app.register('admin@factory.com', 'Admin')
  inspector = await app.register('insp@factory.com', 'Inspector')
})
afterAll(() => app.stop())

describe('master data', () => {
  let machineId: string

  it('admin creates, everyone reads', async () => {
    const created = await app.api<Machine>('POST', '/api/master/machines', {
      token: admin.token,
      body: { code: '58', name: 'A. Welding Line', line: 'LM4', displayName: '58-A. Welding Line-LM4' },
    })
    expect(created.status).toBe(201)
    expect(created.body.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(created.body.machineNumber).toBeUndefined()
    machineId = created.body.id

    const list = await app.api<Machine[]>('GET', '/api/master/machines', { token: inspector.token })
    expect(list.status).toBe(200)
    expect(list.body).toHaveLength(1)
    expect(list.body[0].displayName).toBe('58-A. Welding Line-LM4')
  })

  it('an inspector cannot write', async () => {
    const res = await app.api('POST', '/api/master/machines', { token: inspector.token, body: { code: '7', name: 'Paint', displayName: 'x' } })
    expect(res.status).toBe(403)
  })

  it('rejects a duplicate business key as 409', async () => {
    const res = await app.api<ApiErrorBody>('POST', '/api/master/machines', {
      token: admin.token,
      body: { code: '58', name: 'Other', line: 'LM4', displayName: '58-a. welding line-lm4' },
    })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('duplicate')
  })

  it('validates the body', async () => {
    const res = await app.api<ApiErrorBody>('POST', '/api/master/item-dimension-order', {
      token: admin.token,
      body: { itemCode: 'BM-1', dimensionName: 'Width', sequence: 0, tolPlus: -1, tolMinus: 0 },
    })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('validation')
  })

  it('edits with a field-level audit trail', async () => {
    const put = await app.api<Machine>('PUT', `/api/master/machines/${machineId}`, {
      token: admin.token,
      body: { code: '58', name: 'A. Welding Line', line: 'LM4', displayName: '58-A. Welding Line-LM4', machineNumber: 'M-58' },
    })
    expect(put.status).toBe(200)
    expect(put.body.machineNumber).toBe('M-58')

    const audit = await app.api<AuditListResponse>('GET', '/api/audit', { token: admin.token })
    const entry = audit.body.entries.find((e) => e.entity === 'Machine' && e.action === 'update')
    expect(entry).toBeDefined()
    expect(entry!.field).toBe('machineNumber')
    expect(entry!.oldValue).toBe('')
    expect(entry!.newValue).toBe('M-58')
  })

  it('soft-deletes: hidden from the list, still in the database', async () => {
    expect((await app.api('DELETE', `/api/master/machines/${machineId}`, { token: admin.token })).status).toBe(204)
    const list = await app.api<Machine[]>('GET', '/api/master/machines', { token: inspector.token })
    expect(list.body).toHaveLength(0)
    const { rows } = await app.db.query('SELECT deleted_at FROM machines WHERE id = $1', [machineId])
    expect(rows[0].deleted_at).not.toBeNull()
    expect((await app.api('DELETE', `/api/master/machines/${machineId}`, { token: admin.token })).status).toBe(404)
  })

  it('filters by machine, matching the code without regard to case', async () => {
    await app.api('POST', '/api/master/work-center-defects', { token: admin.token, body: { workCenterCode: '58-A', defectName: 'عيب لحام' } })
    await app.api('POST', '/api/master/work-center-defects', { token: admin.token, body: { workCenterCode: '48', defectName: 'خدش سطحى' } })
    const wc58 = await app.api<WorkCenterDefect[]>('GET', '/api/master/work-center-defects?workCenterCode=58-a', { token: inspector.token })
    expect(wc58.body.map((d) => d.defectName)).toEqual(['عيب لحام'])
  })

  it('bulk-imports machines on the code and defects on machine + name', async () => {
    const machines = await app.api<ImportResult>('POST', '/api/master/machines/import', {
      token: admin.token,
      body: { rows: [{ code: 'RF-01', name: 'Roll Former 1', factory: 'Factory A' }, { code: 'RF-02', name: 'Roll Former 2', factory: 'Factory A', line: 'L2' }] },
    })
    expect(machines.body).toEqual({ inserted: 2, updated: 0 })
    const again = await app.api<ImportResult>('POST', '/api/master/machines/import', {
      token: admin.token,
      body: { rows: [{ code: 'rf-01', name: 'Roll Former One' }] },
    })
    expect(again.body).toEqual({ inserted: 0, updated: 1 })
    const list = await app.api<Machine[]>('GET', '/api/master/machines?factory=Factory%20A', { token: inspector.token })
    const one = list.body.find((m) => m.code === 'RF-01')!
    expect(one.name).toBe('Roll Former One')
    expect(one.factory).toBe('Factory A')
    expect(one.displayName).toBe('RF-01-Roll Former One')
    expect(list.body.find((m) => m.code === 'RF-02')!.displayName).toBe('RF-02-Roll Former 2-L2')

    const keys = await app.api<ExistingKeysResponse>('POST', '/api/master/machines/existing-keys', { token: admin.token, body: { keys: ['RF-01', 'nope'] } })
    expect(keys.body.existing).toEqual(['rf-01'])

    const defects = await app.api<ImportResult>('POST', '/api/master/work-center-defects/import', {
      token: admin.token,
      body: { rows: [{ workCenterCode: 'RF-01', defectName: 'Twist' }, { workCenterCode: 'rf-01', defectName: 'twist' }, { workCenterCode: 'RF-01', defectName: 'Bow' }] },
    })
    expect(defects.body).toEqual({ inserted: 2, updated: 0 })
    const repeat = await app.api<ImportResult>('POST', '/api/master/work-center-defects/import', {
      token: admin.token,
      body: { rows: [{ workCenterCode: 'RF-01', defectName: 'twist' }] },
    })
    expect(repeat.body).toEqual({ inserted: 0, updated: 1 })
    const defectKeys = await app.api<ExistingKeysResponse>('POST', '/api/master/work-center-defects/existing-keys', {
      token: admin.token,
      body: { keys: ['RF-01||Twist', 'RF-01||Nope'] },
    })
    expect(defectKeys.body.existing).toEqual(['rf-01||twist'])
  })

  it('refuses a hard delete at the database', async () => {
    await expect(app.db.query('DELETE FROM work_center_defects')).rejects.toThrow(/Hard delete is not allowed/)
  })

  it('bulk-imports the dimension configuration, matching on item code + name + machine', async () => {
    const first = await app.api<ImportResult>('POST', '/api/master/item-dimension-order/import', {
      token: admin.token,
      body: {
        rows: [
          { itemCode: '125185TA3', item: 'XL Light Beam', dimensionName: 'Width', sequence: 1, nominal: 125, tolPlus: 0.5, tolMinus: 0.5 },
          { itemCode: '125185TA3', item: 'XL Light Beam', dimensionName: 'Length', sequence: 2, nominal: 2500, tolPlus: 2, tolMinus: 2 },
          // The same dimension, but only on one machine: a separate row.
          { itemCode: '125185TA3', workCenterCode: 'RF-01', dimensionName: 'Width', sequence: 1, nominal: 130, tolPlus: 1, tolMinus: 1 },
        ],
      },
    })
    expect(first.body).toEqual({ inserted: 3, updated: 0 })
    const second = await app.api<ImportResult>('POST', '/api/master/item-dimension-order/import', {
      token: admin.token,
      body: { rows: [{ itemCode: '125185ta3', dimensionName: 'width', nominal: 126 }, { itemCode: '125185ta3', dimensionName: 'width', workCenterCode: 'rf-01', nominal: 131 }] },
    })
    expect(second.body).toEqual({ inserted: 0, updated: 2 })
    const list = await app.api<ItemDimensionOrder[]>('GET', '/api/master/item-dimension-order?itemCode=125185TA3', { token: inspector.token })
    expect(list.body).toHaveLength(3)
    const general = list.body.find((d) => d.dimensionName === 'Width' && !d.workCenterCode)!
    expect(general.nominal).toBe(126)
    expect(general.tolPlus).toBe(0.5)
    expect(general.item).toBe('XL Light Beam')
    expect(list.body.find((d) => d.workCenterCode === 'RF-01')!.nominal).toBe(131)
    const onMachine = await app.api<ItemDimensionOrder[]>('GET', '/api/master/item-dimension-order?itemCode=125185TA3&workCenterCode=rf-01', { token: inspector.token })
    expect(onMachine.body.map((d) => d.nominal)).toEqual([131])

    const keys = await app.api<ExistingKeysResponse>('POST', '/api/master/item-dimension-order/existing-keys', {
      token: admin.token,
      body: { keys: ['125185TA3||Width||', '125185TA3||Width||RF-01', '125185TA3||Width||RF-09'] },
    })
    expect(keys.body.existing.sort()).toEqual(['125185ta3||width||', '125185ta3||width||rf-01'])
  })

  it('answers 404 for an unknown table', async () => {
    expect((await app.api('GET', '/api/master/users', { token: admin.token })).status).toBe(404)
  })
})

describe('production orders', () => {
  it('imports order lines on the Order ID, updates on re-import, and leaves unmapped fields alone', async () => {
    const first = await app.api<ImportResult>('POST', '/api/orders/import', {
      token: admin.token,
      body: {
        rows: [
          // One order, two lines on two machines: both survive.
          { lineKey: 'L-1', orderNumber: '20480-Ph1.4-SMA', item: 'Shuttle Beam', itemCode: 'LB406015-5TA3', workCenterCode: '48', requiredQty: 1350, finishedQty: 900, customer: 'Alpha Racking', expectedGrade: 'ST52-3', drawing: 'BS9059/48' },
          { lineKey: 'L-2', orderNumber: '20480-Ph1.4-SMA', item: 'XL Upright', itemCode: 'UP90-3T3', workCenterCode: '58', requiredQty: 400, finishedQty: 0, customer: 'Alpha Racking', expectedGrade: 'S355JR', drawing: 'BS9059/58' },
          { lineKey: 'L-3', orderNumber: '20095-QC1-HYH', item: 'XL Light Beam', itemCode: '125185TA3', workCenterCode: '58', requiredQty: 2500, finishedQty: 2500, customer: 'Beta Storage', expectedGrade: 'S355JR', drawing: 'BS9059/58' },
        ],
      },
    })
    expect(first.status).toBe(200)
    expect(first.body).toEqual({ inserted: 3, updated: 0 })

    const second = await app.api<ImportResult>('POST', '/api/orders/import', {
      token: admin.token,
      body: { rows: [{ lineKey: 'l-1', finishedQty: 1000 }, { lineKey: 'L-4', orderNumber: '20389-EHF', item: 'Walkway Mesh', workCenterCode: '48' }] },
    })
    expect(second.body).toEqual({ inserted: 1, updated: 1 })

    const found = await app.api<ProductionOrder[]>('GET', '/api/orders?search=20480', { token: inspector.token })
    expect(found.body).toHaveLength(2)
    const line1 = found.body.find((o) => o.lineKey === 'L-1')!
    expect(line1.finishedQty).toBe(1000)
    expect(line1.item).toBe('Shuttle Beam')
    expect(line1.customer).toBe('Alpha Racking')
  })

  it('refuses a new line that does not say which order it belongs to', async () => {
    const res = await app.api<ApiErrorBody>('POST', '/api/orders/import', { token: admin.token, body: { rows: [{ lineKey: 'L-9', finishedQty: 1 }] } })
    expect(res.status).toBe(400)
    expect(res.body.error.message).toMatch(/L-9/)
  })

  it('searches by order number, item code or line key prefix, case-insensitively', async () => {
    const byCode = await app.api<ProductionOrder[]>('GET', '/api/orders?search=lb4060', { token: inspector.token })
    expect(byCode.body.map((o) => o.lineKey)).toEqual(['L-1'])
    const byKey = await app.api<ProductionOrder[]>('GET', '/api/orders?search=l-3', { token: inspector.token })
    expect(byKey.body.map((o) => o.orderNumber)).toEqual(['20095-QC1-HYH'])
    const all = await app.api<ProductionOrder[]>('GET', '/api/orders', { token: inspector.token })
    expect(all.body).toHaveLength(4)
    const none = await app.api<ProductionOrder[]>('GET', '/api/orders?search=zzz', { token: inspector.token })
    expect(none.body).toHaveLength(0)
  })

  it('narrows to a machine: the order numbers on it, then the lines of one order there', async () => {
    const on58 = await app.api<OrderNumberSummary[]>('GET', '/api/orders/numbers?machine=58', { token: inspector.token })
    expect(on58.body).toEqual([
      { orderNumber: '20095-QC1-HYH', customer: 'Beta Storage', lineCount: 1 },
      { orderNumber: '20480-Ph1.4-SMA', customer: 'Alpha Racking', lineCount: 1 },
    ])
    const on48 = await app.api<OrderNumberSummary[]>('GET', '/api/orders/numbers?machine=48&search=204', { token: inspector.token })
    expect(on48.body.map((o) => o.orderNumber)).toEqual(['20480-Ph1.4-SMA'])
    const everywhere = await app.api<OrderNumberSummary[]>('GET', '/api/orders/numbers', { token: inspector.token })
    expect(everywhere.body.find((o) => o.orderNumber === '20480-Ph1.4-SMA')!.lineCount).toBe(2)

    const lines = await app.api<ProductionOrder[]>('GET', '/api/orders?machine=58&orderNumber=20480-ph1.4-sma', { token: inspector.token })
    expect(lines.body.map((o) => o.lineKey)).toEqual(['L-2'])
    const allLines = await app.api<ProductionOrder[]>('GET', '/api/orders?orderNumber=20480-Ph1.4-SMA', { token: inspector.token })
    expect(allLines.body.map((o) => o.lineKey)).toEqual(['L-1', 'L-2'])
  })

  it('escapes LIKE wildcards in the search term', async () => {
    const res = await app.api<ProductionOrder[]>('GET', '/api/orders?search=%25', { token: inspector.token })
    expect(res.body).toHaveLength(0)
  })

  it('reports which line keys already exist for the import preview', async () => {
    const res = await app.api<ExistingKeysResponse>('POST', '/api/orders/existing-keys', {
      token: admin.token,
      body: { keys: ['l-1', 'nope-1'] },
    })
    expect(res.body.existing).toEqual(['l-1'])
  })

  it('answers exactly the published maximum of keys per request and refuses one more', async () => {
    const keys = Array.from({ length: EXISTING_KEYS_MAX }, (_, i) => `probe-${i}`)
    const full = await app.api<ExistingKeysResponse>('POST', '/api/orders/existing-keys', { token: admin.token, body: { keys } })
    expect(full.status).toBe(200)
    expect(full.body.existing).toEqual([])
    const over = await app.api<ApiErrorBody>('POST', '/api/orders/existing-keys', { token: admin.token, body: { keys: [...keys, 'one-more'] } })
    expect(over.status).toBe(400)
  })

  it('fetches by ids and answers an empty history for a fresh order', async () => {
    const all = await app.api<ProductionOrder[]>('GET', '/api/orders', { token: inspector.token })
    const ids = all.body.map((o) => o.id)
    const byIds = await app.api<ProductionOrder[]>('GET', `/api/orders/by-ids?ids=${ids.join(',')}`, { token: inspector.token })
    expect(byIds.body).toHaveLength(4)
    const history = await app.api<OrderHistory>('GET', `/api/orders/${ids[0]}/history`, { token: inspector.token })
    expect(history.body).toEqual({ sessions: [], samples: [] })
    expect((await app.api('GET', `/api/orders/00000000-0000-0000-0000-000000000000`, { token: inspector.token })).status).toBe(404)
  })

  it('does not let an inspector import', async () => {
    expect((await app.api('POST', '/api/orders/import', { token: inspector.token, body: { rows: [{ lineKey: 'X', orderNumber: 'X' }] } })).status).toBe(403)
  })
})

describe('coils', () => {
  it('imports and searches by number, grade and supplier', async () => {
    const res = await app.api<ImportResult>('POST', '/api/coils/import', {
      token: admin.token,
      body: {
        rows: [
          { coilNumber: 'C10021', grade: 'S355JR', supplier: 'Ezz Steel', thickness: 2.5 },
          { coilNumber: 'C10023', grade: 'DX51D', supplier: 'Suez Steel', thickness: 4 },
        ],
      },
    })
    expect(res.body).toEqual({ inserted: 2, updated: 0 })
    const byGrade = await app.api<Coil[]>('GET', '/api/coils?search=dx5', { token: inspector.token })
    expect(byGrade.body.map((c) => c.coilNumber)).toEqual(['C10023'])
    const bySupplier = await app.api<Coil[]>('GET', '/api/coils?search=ezz', { token: inspector.token })
    expect(bySupplier.body.map((c) => c.coilNumber)).toEqual(['C10021'])
    expect(bySupplier.body[0].thickness).toBe(2.5)
    const usage = await app.api<CoilUsage[]>('GET', '/api/coils/usage?coilNumbers=C10021', { token: inspector.token })
    expect(usage.body).toEqual([])
  })
})
