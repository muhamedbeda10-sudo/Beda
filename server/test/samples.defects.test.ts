// ============================================================================
// §7 — a session's defects, listed with their samples, so a Hold can be
// decided from the board without opening each sample. Deciding one goes
// through the existing correction, which is what the last case exercises.
// The correction also changes a defect's type picked by mistake (§9.4).
// ============================================================================

import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { SessionDefectsResponse, SessionWithOrder } from '@qc/shared/api'
import type { DefectResult, ProductionOrder } from '@qc/shared/types'
import { TestApp, type Session } from './harness'

const app = new TestApp()
let admin: Session
let inspector: Session
let session: SessionWithOrder

const sample = (defects: { name: string; disposition: 'Hold' | 'Repair' }[]) => ({
  submissionId: randomUUID(),
  drawing: 'D-1',
  sampleQty: 10,
  dimensions: [{ name: 'Width', sequence: 1, nominal: 125, tolPlus: 0.5, tolMinus: 0.5, actual: 125.1, unit: 'mm', source: 'item-order' }],
  defects: defects.map((d) => ({ defectName: d.name, qty: 2, disposition: d.disposition, notes: '', imageIds: [] })),
  coils: [],
})

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  admin = await app.register('admin', 'Admin')
  inspector = await app.register('insp', 'Inspector One')
  await app.api('POST', '/api/master/machines', { token: admin.token, body: { code: '31', name: 'Roll Forming', line: 'LM2', displayName: '31-Roll Forming-LM2', process: 'forming' } })
  for (const name of ['Edge', 'Scratch']) await app.api('POST', '/api/master/work-center-defects', { token: admin.token, body: { workCenterCode: '31', defectName: name } })
  await app.api('POST', '/api/orders/import', {
    token: admin.token,
    body: { rows: [{ lineKey: 'L-1', orderNumber: '20095-QC1-HYH', item: 'XL Light Beam', itemCode: '125185TA3', workCenterCode: '31', requiredQty: 500, finishedQty: 0, customer: 'Beta', expectedGrade: '', drawing: 'D-1' }] },
  })
  const order = (await app.api<ProductionOrder[]>('GET', '/api/orders', { token: admin.token })).body[0]
  session = (await app.api<SessionWithOrder>('POST', '/api/sessions', { token: inspector.token, body: { orderId: order.id, startQty: 0 } })).body
  // Two samples: a Hold on each, and one already decided.
  for (const body of [sample([{ name: 'Edge', disposition: 'Hold' }]), sample([{ name: 'Scratch', disposition: 'Hold' }, { name: 'Edge', disposition: 'Repair' }])]) {
    const res = await app.api('POST', `/api/sessions/${session.id}/samples`, { token: inspector.token, body })
    if (res.status !== 201) throw new Error(`sample failed ${res.status} ${JSON.stringify(res.body)}`)
  }
})
afterAll(() => app.stop())

describe('a session’s defects, for deciding Holds from the board', () => {
  it('lists every live defect with the sample it sits on', async () => {
    const res = await app.api<SessionDefectsResponse>('GET', `/api/samples/defects?sessionId=${session.id}`, { token: inspector.token })
    expect(res.status).toBe(200)
    // Sample by sample, and by name within one — the order the list draws.
    expect(res.body.defects.map((d) => [d.sampleIndex, d.defectName, d.disposition])).toEqual([
      [1, 'Edge', 'Hold'],
      [2, 'Edge', 'Repair'],
      [2, 'Scratch', 'Hold'],
    ])
    expect(res.body.defects.every((d) => typeof d.version === 'number')).toBe(true)
  })

  it('needs a signed-in reader and a real session id', async () => {
    expect((await app.api('GET', `/api/samples/defects?sessionId=${session.id}`)).status).toBe(401)
    expect((await app.api('GET', '/api/samples/defects?sessionId=nope', { token: inspector.token })).status).toBe(400)
  })

  it('a Hold decided through the correction leaves the list of Holds', async () => {
    const before = (await app.api<SessionDefectsResponse>('GET', `/api/samples/defects?sessionId=${session.id}`, { token: inspector.token })).body
    const hold = before.defects.find((d) => d.defectName === 'Scratch')!
    const res = await app.api<DefectResult>('PATCH', `/api/samples/defects/${hold.id}`, { token: inspector.token, body: { disposition: 'Repair', qty: hold.qty, version: hold.version } })
    expect(res.status).toBe(200)
    const after = (await app.api<SessionDefectsResponse>('GET', `/api/samples/defects?sessionId=${session.id}`, { token: inspector.token })).body
    expect(after.defects.filter((d) => d.disposition === 'Hold').map((d) => d.defectName)).toEqual(['Edge'])
    const s = (await app.api<SessionWithOrder>('GET', `/api/sessions/${session.id}`, { token: inspector.token })).body
    expect(s.holdCount).toBe(1)
  })
})

describe('§9.4 — correcting a defect picked by mistake', () => {
  const defectsOf = async () => (await app.api<SessionDefectsResponse>('GET', `/api/samples/defects?sessionId=${session.id}`, { token: inspector.token })).body.defects
  const patch = (token: string, id: string, body: Record<string, unknown>) => app.api<DefectResult>('PATCH', `/api/samples/defects/${id}`, { token, body })

  it("lets the inspector change the type to another of the machine's defects while the session is open, and audits it", async () => {
    const edge = (await defectsOf()).find((d) => d.sampleIndex === 2 && d.defectName === 'Edge')!
    const res = await patch(inspector.token, edge.id, { defectName: 'Scratch', disposition: edge.disposition, qty: edge.qty, version: edge.version })
    expect(res.status).toBe(200)
    expect(res.body.defectName).toBe('Scratch')
    expect(res.body.version).toBe(edge.version + 1)
    const audit = await app.db.query<{ field: string; oldValue: string; newValue: string }>(
      `SELECT field, old_value AS "oldValue", new_value AS "newValue" FROM audit_log WHERE entity = 'DefectResult' AND entity_id = $1 AND field = 'defectName'`,
      [edge.id],
    )
    expect(audit.rows).toEqual([{ field: 'defectName', oldValue: 'Edge', newValue: 'Scratch' }])
  })

  it("refuses a name that is not one of the machine's defects", async () => {
    const d = (await defectsOf())[0]
    const res = await patch(inspector.token, d.id, { defectName: 'Crack', disposition: d.disposition, qty: d.qty, version: d.version })
    expect(res.status).toBe(400)
  })

  it('takes Other only with a description, and stores it as Other', async () => {
    const d = (await defectsOf())[0]
    expect((await patch(inspector.token, d.id, { defectName: 'Other', disposition: d.disposition, qty: d.qty, notes: '  ', version: d.version })).status).toBe(400)
    const res = await patch(inspector.token, d.id, { defectName: 'other', disposition: d.disposition, qty: d.qty, notes: 'Burr on the lip', version: d.version })
    expect(res.status).toBe(200)
    expect(res.body.defectName).toBe('Other')
    expect(res.body.notes).toBe('Burr on the lip')
    // Back to a listed defect: the description may stay as a note.
    const back = await patch(inspector.token, d.id, { defectName: 'Edge', disposition: d.disposition, qty: d.qty, version: res.body.version })
    expect(back.status).toBe(200)
    expect(back.body.defectName).toBe('Edge')
    expect(back.body.notes).toBe('Burr on the lip')
  })

  it('keeps a name the machine no longer lists when only the quantity changes', async () => {
    const res = await app.api('POST', `/api/sessions/${session.id}/samples`, { token: inspector.token, body: sample([{ name: 'Wavy', disposition: 'Repair' }]) })
    expect(res.status).toBe(201)
    const wavy = (await defectsOf()).find((d) => d.defectName === 'Wavy')!
    const ok = await patch(inspector.token, wavy.id, { defectName: 'Wavy', disposition: 'Repair', qty: 5, version: wavy.version })
    expect(ok.status).toBe(200)
    expect(ok.body.qty).toBe(5)
  })

  it('leaves a closed session to a supervisor or an administrator', async () => {
    const s = (await app.api<SessionWithOrder>('GET', `/api/sessions/${session.id}`, { token: inspector.token })).body
    expect((await app.api('POST', `/api/sessions/${session.id}/close`, { token: inspector.token, body: { finalQty: 480, version: s.version } })).status).toBe(200)
    const d = (await defectsOf())[0]
    expect((await patch(inspector.token, d.id, { defectName: 'Scratch', disposition: d.disposition, qty: d.qty, version: d.version })).status).toBe(403)
    const res = await patch(admin.token, d.id, { defectName: 'Scratch', disposition: d.disposition, qty: d.qty, version: d.version })
    expect(res.status).toBe(200)
    expect(res.body.defectName).toBe('Scratch')
  })
})

describe('§7 — deciding a Hold in a closed session', () => {
  const defectsOf = async () => (await app.api<SessionDefectsResponse>('GET', `/api/samples/defects?sessionId=${session.id}`, { token: inspector.token })).body.defects
  const patch = (token: string, id: string, body: Record<string, unknown>) => app.api<DefectResult>('PATCH', `/api/samples/defects/${id}`, { token, body })
  const holdOf = async () => {
    const hold = (await defectsOf()).find((d) => d.disposition === 'Hold')
    if (!hold) throw new Error('no Hold left to decide')
    return hold
  }

  it('lets the inspector decide it and nothing else: not the quantity, the name, the notes, nor a defect already decided', async () => {
    const s = (await app.api<SessionWithOrder>('GET', `/api/sessions/${session.id}`, { token: inspector.token })).body
    expect(s.status).toBe('Closed')
    const hold = await holdOf()
    expect((await patch(inspector.token, hold.id, { disposition: 'Repair', qty: hold.qty + 1, version: hold.version })).status).toBe(403)
    expect((await patch(inspector.token, hold.id, { disposition: 'Repair', qty: hold.qty, notes: 'changed', version: hold.version })).status).toBe(403)
    expect((await patch(inspector.token, hold.id, { disposition: 'Hold', qty: hold.qty, version: hold.version })).status).toBe(403)
    const decided = (await defectsOf()).find((d) => d.disposition !== 'Hold')!
    expect((await patch(inspector.token, decided.id, { disposition: 'Rejected', qty: decided.qty, version: decided.version })).status).toBe(403)

    const res = await patch(inspector.token, hold.id, { disposition: 'Accept with concession', qty: hold.qty, defectName: hold.defectName, version: hold.version })
    expect(res.status).toBe(200)
    expect(res.body.disposition).toBe('Accept with concession')
    expect(res.body.qty).toBe(hold.qty)
    const audit = await app.db.query(`SELECT 1 FROM audit_log WHERE entity = 'DefectResult' AND entity_id = $1 AND field = 'disposition' AND new_value LIKE '%Accept with concession%'`, [hold.id])
    expect(audit.rowCount).toBe(1)
  })

  it('needs "Decide Holds": taken away, the closed session is a supervisor’s again', async () => {
    // Put a Hold back as an administrator, then take the right away from the inspector.
    const d = (await defectsOf())[0]
    expect((await patch(admin.token, d.id, { disposition: 'Hold', qty: d.qty, version: d.version })).status).toBe(200)
    expect((await app.api('PUT', `/api/users/${inspector.user.id}/permissions`, { token: admin.token, body: { overrides: [{ permission: 'decide-holds', granted: false }] } })).status).toBe(200)
    const hold = await holdOf()
    expect((await patch(inspector.token, hold.id, { disposition: 'Repair', qty: hold.qty, version: hold.version })).status).toBe(403)
  })
})
