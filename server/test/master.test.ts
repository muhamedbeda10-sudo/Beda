import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import type { ApiErrorBody, AuditListResponse, ImportResult, ExistingKeysResponse, OrderHistory, CoilUsage } from '@qc/shared/api'
import type { Machine, ProductionOrder, Coil, WorkCenterDefect } from '@qc/shared/types'
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
      body: { item: 'Beam', dimensionName: 'Width', sequence: 0, tolPlus: -1, tolMinus: 0 },
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

  it('filters by work centre and by item', async () => {
    await app.api('POST', '/api/master/work-center-defects', { token: admin.token, body: { workCenterCode: '58', defectName: 'عيب لحام' } })
    await app.api('POST', '/api/master/work-center-defects', { token: admin.token, body: { workCenterCode: '48', defectName: 'خدش سطحى' } })
    const wc58 = await app.api<WorkCenterDefect[]>('GET', '/api/master/work-center-defects?workCenterCode=58', { token: inspector.token })
    expect(wc58.body.map((d) => d.defectName)).toEqual(['عيب لحام'])
  })

  it('refuses a hard delete at the database', async () => {
    await expect(app.db.query('DELETE FROM work_center_defects')).rejects.toThrow(/Hard delete is not allowed/)
  })

  it('bulk-imports the dimension configuration, matching on item + name', async () => {
    const first = await app.api<ImportResult>('POST', '/api/master/item-dimension-order/import', {
      token: admin.token,
      body: { rows: [{ item: 'XL Light Beam', dimensionName: 'Width', sequence: 1, nominal: 125, tolPlus: 0.5, tolMinus: 0.5 }, { item: 'XL Light Beam', dimensionName: 'Length', sequence: 2, nominal: 2500, tolPlus: 2, tolMinus: 2 }] },
    })
    expect(first.body).toEqual({ inserted: 2, updated: 0 })
    const second = await app.api<ImportResult>('POST', '/api/master/item-dimension-order/import', {
      token: admin.token,
      body: { rows: [{ item: 'xl light beam', dimensionName: 'width', nominal: 126 }] },
    })
    expect(second.body).toEqual({ inserted: 0, updated: 1 })
    const list = await app.api<Array<{ dimensionName: string; nominal?: number; tolPlus: number }>>('GET', '/api/master/item-dimension-order?item=XL%20Light%20Beam', { token: inspector.token })
    const width = list.body.find((d) => d.dimensionName === 'Width')!
    expect(width.nominal).toBe(126)
    expect(width.tolPlus).toBe(0.5)
  })

  it('answers 404 for an unknown table', async () => {
    expect((await app.api('GET', '/api/master/users', { token: admin.token })).status).toBe(404)
  })
})

describe('production orders', () => {
  it('imports, updates on re-import, and leaves unmapped fields alone', async () => {
    const first = await app.api<ImportResult>('POST', '/api/orders/import', {
      token: admin.token,
      body: {
        rows: [
          { orderNumber: '20480-Ph1.4-SMA', item: 'Shuttle Beam', itemCode: 'LB406015-5TA3', workCenterCode: '48', requiredQty: 1350, finishedQty: 900, customer: 'Alpha Racking', expectedGrade: 'ST52-3', drawing: 'BS9059/48' },
          { orderNumber: '20095-QC1-HYH', item: 'XL Light Beam', itemCode: '125185TA3', workCenterCode: '58', requiredQty: 2500, finishedQty: 2500, customer: 'Beta Storage', expectedGrade: 'S355JR', drawing: 'BS9059/58' },
        ],
      },
    })
    expect(first.status).toBe(200)
    expect(first.body).toEqual({ inserted: 2, updated: 0 })

    const second = await app.api<ImportResult>('POST', '/api/orders/import', {
      token: admin.token,
      body: { rows: [{ orderNumber: '20480-ph1.4-sma', finishedQty: 1000 }, { orderNumber: '20389-EHF', item: 'Walkway Mesh', workCenterCode: '48' }] },
    })
    expect(second.body).toEqual({ inserted: 1, updated: 1 })

    const found = await app.api<ProductionOrder[]>('GET', '/api/orders?search=20480', { token: inspector.token })
    expect(found.body).toHaveLength(1)
    expect(found.body[0].finishedQty).toBe(1000)
    expect(found.body[0].item).toBe('Shuttle Beam')
    expect(found.body[0].customer).toBe('Alpha Racking')
  })

  it('searches by order number or item code prefix, case-insensitively', async () => {
    const byCode = await app.api<ProductionOrder[]>('GET', '/api/orders?search=lb4060', { token: inspector.token })
    expect(byCode.body.map((o) => o.orderNumber)).toEqual(['20480-Ph1.4-SMA'])
    const all = await app.api<ProductionOrder[]>('GET', '/api/orders', { token: inspector.token })
    expect(all.body).toHaveLength(3)
    const none = await app.api<ProductionOrder[]>('GET', '/api/orders?search=zzz', { token: inspector.token })
    expect(none.body).toHaveLength(0)
  })

  it('escapes LIKE wildcards in the search term', async () => {
    const res = await app.api<ProductionOrder[]>('GET', '/api/orders?search=%25', { token: inspector.token })
    expect(res.body).toHaveLength(0)
  })

  it('reports which keys already exist for the import preview', async () => {
    const res = await app.api<ExistingKeysResponse>('POST', '/api/orders/existing-keys', {
      token: admin.token,
      body: { keys: ['20480-PH1.4-SMA', 'nope-1'] },
    })
    expect(res.body.existing).toEqual(['20480-ph1.4-sma'])
  })

  it('fetches by ids and answers an empty history for a fresh order', async () => {
    const all = await app.api<ProductionOrder[]>('GET', '/api/orders', { token: inspector.token })
    const ids = all.body.map((o) => o.id)
    const byIds = await app.api<ProductionOrder[]>('GET', `/api/orders/by-ids?ids=${ids.join(',')}`, { token: inspector.token })
    expect(byIds.body).toHaveLength(3)
    const history = await app.api<OrderHistory>('GET', `/api/orders/${ids[0]}/history`, { token: inspector.token })
    expect(history.body).toEqual({ sessions: [], samples: [] })
    expect((await app.api('GET', `/api/orders/00000000-0000-0000-0000-000000000000`, { token: inspector.token })).status).toBe(404)
  })

  it('does not let an inspector import', async () => {
    expect((await app.api('POST', '/api/orders/import', { token: inspector.token, body: { rows: [{ orderNumber: 'X' }] } })).status).toBe(403)
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
