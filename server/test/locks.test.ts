// ============================================================================
// Writes under a session take their locks in one order — the session first,
// then what is in it — so two of them never wait on each other crosswise; a
// correction is of a live sample only; and when the database still undoes a
// write that crossed another (a deadlock, a serialisation failure), the
// person is told to send it again, not that the server failed. Requests the
// body or upload parsers refuse are answered as the client's mistake.
// ============================================================================

import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ApiErrorBody, SampleDetail, SaveSampleResponse, SessionWithOrder } from '@qc/shared/api'
import type { DefectResult, DimensionResult, ProductionOrder } from '@qc/shared/types'
import { TestApp, tinyJpeg, type Session } from './harness'
import { createPool, type Db } from '../src/db/pool'

const app = new TestApp()
let raw: Db
let admin: Session
let order: ProductionOrder
let sessionId: string

const sampleBody = () => ({
  drawing: 'D-1',
  sampleQty: 5,
  dimensions: [{ name: 'Length', sequence: 1, nominal: 10, tolPlus: 1, tolMinus: 1, actual: 10, unit: 'mm', source: 'manual' }],
  defects: [{ defectName: 'Burr', qty: 1, disposition: 'Repair', imageIds: [] }],
  coils: [],
})
async function recordSample(): Promise<SampleDetail> {
  const saved = await app.api<SaveSampleResponse>('POST', `/api/sessions/${sessionId}/samples`, { token: admin.token, body: { submissionId: randomUUID(), ...sampleBody() } })
  expect(saved.status).toBe(201)
  return (await app.api<SampleDetail>('GET', `/api/samples/${saved.body.sampleId}`, { token: admin.token })).body
}

/** Until one of this database's backends waits on a lock. */
async function waitUntilBlocked(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const { rowCount } = await raw.query(`SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)
    if (rowCount) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('nothing waited on a lock')
}

/**
 * Hold the session's row lock in a connection of the test's own, start the
 * request, and once it waits for that lock, report whether it had locked
 * `row` before waiting: a NOWAIT lock on it from a third connection fails if
 * it had. Then let the request go and answer it.
 */
async function lockedBeforeTheSession(request: () => Promise<{ status: number }>, row: { table: string; id: string }): Promise<{ lockedFirst: boolean; status: number }> {
  const holder = await raw.connect()
  const probe = await raw.connect()
  try {
    await holder.query('BEGIN')
    await holder.query('SELECT 1 FROM inspection_sessions WHERE id = $1 FOR UPDATE', [sessionId])
    const pending = request()
    await waitUntilBlocked()
    await probe.query('BEGIN')
    const lockedFirst = await probe.query(`SELECT 1 FROM ${row.table} WHERE id = $1 FOR UPDATE NOWAIT`, [row.id]).then(
      () => false,
      () => true,
    )
    await probe.query('ROLLBACK')
    await holder.query('ROLLBACK')
    return { lockedFirst, status: (await pending).status }
  } finally {
    holder.release()
    probe.release()
  }
}

beforeAll(async () => {
  await app.start({ MAX_IMAGE_BYTES: '4000' })
  await app.resetDatabase()
  raw = createPool(app.config.DATABASE_URL, 3)
  admin = await app.register('admin', 'Admin')
  await app.api('POST', '/api/master/machines', { token: admin.token, body: { code: '90', name: 'Press 90', line: 'LM3', displayName: '90-Press-LM3', process: 'universal' } })
  await app.api('POST', '/api/orders/import', {
    token: admin.token,
    body: { rows: [{ lineKey: 'U-1', orderNumber: '50001-A', item: 'Base Plate', itemCode: 'BP-10', workCenterCode: '90', requiredQty: 120, finishedQty: 0, customer: 'A', drawing: 'D-1' }] },
  })
  order = (await app.api<ProductionOrder[]>('GET', '/api/orders', { token: admin.token })).body[0]
  sessionId = (await app.api<SessionWithOrder>('POST', '/api/sessions', { token: admin.token, body: { orderId: order.id, startQty: 0 } })).body.id
})
afterAll(async () => {
  await raw.end()
  await app.stop()
})

describe('the session first, then what is in it', () => {
  it('deletes a sample under its session’s lock, taken before the sample’s', async () => {
    const s = await recordSample()
    const out = await lockedBeforeTheSession(() => app.api('DELETE', `/api/samples/${s.sample.id}`, { token: admin.token }), { table: 'inspection_samples', id: s.sample.id })
    expect(out).toEqual({ lockedFirst: false, status: 204 })
  })

  it('corrects a measurement and a defect under the session’s lock, taken before theirs', async () => {
    const s = await recordSample()
    const dim = s.dimensions[0]
    const fixed = await lockedBeforeTheSession(
      () => app.api('PATCH', `/api/samples/dimensions/${dim.id}`, { token: admin.token, body: { actual: 10.5, version: dim.version } }),
      { table: 'dimension_results', id: dim.id },
    )
    expect(fixed).toEqual({ lockedFirst: false, status: 200 })
    const defect = s.defects[0]
    const corrected = await lockedBeforeTheSession(
      () => app.api('PATCH', `/api/samples/defects/${defect.id}`, { token: admin.token, body: { disposition: 'Rejected', qty: 1, version: defect.version } }),
      { table: 'defect_results', id: defect.id },
    )
    expect(corrected).toEqual({ lockedFirst: false, status: 200 })
  })

  it('corrects nothing of a deleted sample', async () => {
    const s = await recordSample()
    expect((await app.api('DELETE', `/api/samples/${s.sample.id}`, { token: admin.token })).status).toBe(204)
    const dim = await app.api<ApiErrorBody>('PATCH', `/api/samples/dimensions/${s.dimensions[0].id}`, { token: admin.token, body: { actual: 11, version: s.dimensions[0].version } })
    expect(dim.status).toBe(404)
    expect(dim.body.error.message).toBe('That measurement was not found.')
    const defect = await app.api<ApiErrorBody>('PATCH', `/api/samples/defects/${s.defects[0].id}`, { token: admin.token, body: { disposition: 'Hold', qty: 1, version: s.defects[0].version } })
    expect(defect.status).toBe(404)
    const rows = await app.db.query<Pick<DimensionResult, 'actual'> & Pick<DefectResult, 'version'>>(
      `SELECT (SELECT actual::float8 FROM dimension_results WHERE id = $1) AS actual, (SELECT version FROM defect_results WHERE id = $2) AS version`,
      [s.dimensions[0].id, s.defects[0].id],
    )
    expect(rows.rows[0]).toEqual({ actual: 10, version: 0 })
  })

  it('answers a write the database undid in a deadlock with a conflict to send again, writing nothing', async () => {
    const s = await recordSample()
    const other = await raw.connect()
    try {
      // Another writer holds the sample and will want the session: crosswise to a re-record.
      await other.query('BEGIN')
      await other.query('SELECT 1 FROM inspection_samples WHERE id = $1 FOR UPDATE', [s.sample.id])
      const reRecord = app.api<ApiErrorBody>('PUT', `/api/sessions/${sessionId}/samples/${s.sample.id}`, {
        token: admin.token,
        body: { ...sampleBody(), sampleQty: 9, version: s.sample.version },
      })
      await waitUntilBlocked()
      await new Promise((r) => setTimeout(r, 100))
      const crossing = other.query('SELECT 1 FROM inspection_sessions WHERE id = $1 FOR UPDATE', [sessionId])
      const res = await reRecord
      await crossing
      await other.query('ROLLBACK')
      expect(res.status).toBe(409)
      expect(res.headers.get('retry-after')).toBe('1')
      expect(res.body.error).toEqual({ code: 'conflict', message: 'Someone else was changing the same records at the same moment. Nothing was saved: try again.' })
      expect((await app.api<SampleDetail>('GET', `/api/samples/${s.sample.id}`, { token: admin.token })).body.sample.sampleQty).toBe(5)
    } finally {
      other.release()
    }
    // Sent again, it goes through.
    const again = await app.api('PUT', `/api/sessions/${sessionId}/samples/${s.sample.id}`, { token: admin.token, body: { ...sampleBody(), sampleQty: 9, version: s.sample.version } })
    expect(again.status).toBe(200)
  })
})

describe('requests the parsers refuse', () => {
  it('answers a body too large with 413 and one that is not JSON with 400', async () => {
    const big = await app.api<ApiErrorBody>('POST', '/api/sessions', { token: admin.token, raw: JSON.stringify({ pad: 'x'.repeat(3 * 1024 * 1024) }), headers: { 'content-type': 'application/json' } })
    expect(big.status).toBe(413)
    expect(big.body.error).toEqual({ code: 'payload_too_large', message: 'The request is too large to accept.' })
    const broken = await app.api<ApiErrorBody>('POST', '/api/sessions', { token: admin.token, raw: '{"orderId":', headers: { 'content-type': 'application/json' } })
    expect(broken.status).toBe(400)
    expect(broken.body.error).toEqual({ code: 'validation', message: 'The request body is not valid JSON.' })
  })

  it('answers an upload too large, or with a file where none goes, in words that fit any file', async () => {
    const form = (field: string, bytes: Buffer) => {
      const f = new FormData()
      f.append(field, new Blob([bytes], { type: 'image/jpeg' }), 'photo.jpg')
      return f
    }
    const tooLarge = await app.api<ApiErrorBody>('POST', '/api/images', { token: admin.token, raw: form('file', Buffer.concat([tinyJpeg(), Buffer.alloc(5000)])) })
    expect(tooLarge.status).toBe(413)
    expect(tooLarge.body.error).toEqual({ code: 'payload_too_large', message: 'That file is too large to upload.' })
    const elsewhere = await app.api<ApiErrorBody>('POST', '/api/images', { token: admin.token, raw: form('photo', tinyJpeg()) })
    expect(elsewhere.status).toBe(400)
    expect(elsewhere.body.error).toEqual({ code: 'validation', message: 'The upload has a file where none is expected: attach it as the "file" field.' })
    const two = form('file', tinyJpeg(1))
    two.append('file', new Blob([tinyJpeg(2)], { type: 'image/jpeg' }), 'second.jpg')
    const twice = await app.api<ApiErrorBody>('POST', '/api/images', { token: admin.token, raw: two })
    expect([400, 413]).toContain(twice.status)
    expect(twice.body.error.message).not.toMatch(/photo/)
  })
})
