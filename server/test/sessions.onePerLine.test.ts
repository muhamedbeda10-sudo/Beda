// ============================================================================
// §4.4 — one open inspection session per order line at a time, the owner's
// rule: every way a session opens (a first sample, the API's own start, a
// reopen) finds the one already open after locking the line, the database
// refuses a second one from any writer, and an older pair written before the
// rule stays workable. Closing is a change to an open session like adding a
// sample: its inspector's, or of someone who may correct open sessions.
// ============================================================================

import { randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ApiErrorBody, ClearOrdersResult, CloseSessionRequest, SessionWithOrder, StartWithSampleResponse } from '@qc/shared/api'
import type { ProductionOrder } from '@qc/shared/types'
import { TestApp, type Session } from './harness'
import { createPool, pgCode, type Db } from '../src/db/pool'
import { defaultMigrationsDir, migrate } from '../src/db/migrate'

const app = new TestApp()
/** The test's own connections, apart from the API's pool. */
let raw: Db
let admin: Session
let insp: Session
/** An inspector who may not correct open sessions: their own only. */
let solo: Session
let lines: ProductionOrder[]
const line = (key: string) => lines.find((o) => o.lineKey === key)!

const sample = () => ({ submissionId: randomUUID(), drawing: 'D-1', sampleQty: 5, dimensions: [], defects: [], coils: [] })
const startWithSample = (s: Session, start: { orderId: string; startQty: number } | { workCenterCode: string; producedQty: number }) =>
  app.api<StartWithSampleResponse & ApiErrorBody>('POST', '/api/sessions/start-with-sample', { token: s.token, body: { start, sample: sample() } })
const openOn = async (orderId: string) =>
  (await app.db.query<{ id: string }>(`SELECT id FROM inspection_sessions WHERE order_id = $1 AND status = 'Open' AND deleted_at IS NULL ORDER BY seq`, [orderId])).rows.map((r) => r.id)
const get = async (id: string) => (await app.api<SessionWithOrder>('GET', `/api/sessions/${id}`, { token: admin.token })).body
const close = async (s: Session, id: string, body: Omit<CloseSessionRequest, 'version'> = { finalQty: 5 }) =>
  app.api<SessionWithOrder & ApiErrorBody>('POST', `/api/sessions/${id}/close`, { token: s.token, body: { ...body, version: (await get(id)).version } })

/**
 * Two open sessions on one line, as an installation may hold them from before
 * the rule: written with the guard switched off, as the old code could.
 */
async function legacyTwins(order: ProductionOrder): Promise<[string, string]> {
  await app.db.query('ALTER TABLE inspection_sessions DISABLE TRIGGER inspection_sessions_one_open_per_line')
  try {
    const ids: string[] = []
    for (const seq of [1, 2]) {
      const { rows } = await app.db.query<{ id: string }>(
        `INSERT INTO inspection_sessions (seq, order_id, work_center_code, inspector_id, inspector_name, started_at)
         VALUES ((SELECT COALESCE(max(seq), 0) + 1 FROM inspection_sessions WHERE order_id = $1), $1, $2, $3, 'Inspector One', now() - make_interval(mins => $4)) RETURNING id`,
        [order.id, order.workCenterCode, insp.user.id, 10 - seq],
      )
      ids.push(rows[0].id)
    }
    return ids as [string, string]
  } finally {
    await app.db.query('ALTER TABLE inspection_sessions ENABLE TRIGGER inspection_sessions_one_open_per_line')
  }
}

beforeAll(async () => {
  await app.start()
  raw = createPool(app.config.DATABASE_URL, 3)
})
afterAll(async () => {
  await raw.end()
  await app.stop()
})

describe('migration 0071 over an installation that already holds open twins', () => {
  it('applies, and leaves the twins as they are', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'qc-migrations-'))
    try {
      const all = defaultMigrationsDir()
      for (const file of await readdir(all)) if (/^\d{4}_.+\.sql$/.test(file) && file < '0071') await copyFile(path.join(all, file), path.join(dir, file))
      await app.db.query('DROP SCHEMA IF EXISTS ai_saved CASCADE; DROP SCHEMA IF EXISTS ai CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
      await migrate(app.db, dir)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
    const user = (await app.db.query<{ id: string }>(`INSERT INTO users (username, name, role, password_hash) VALUES ('old', 'Old', 'admin', 'x') RETURNING id`)).rows[0].id
    const order = (await app.db.query<{ id: string }>(`INSERT INTO production_orders (line_key, order_number, item, item_code, work_center_code) VALUES ('L-OLD', 'OLD-1', 'Beam', 'B-1', '58') RETURNING id`)).rows[0].id
    for (const seq of [1, 2]) {
      await app.db.query(`INSERT INTO inspection_sessions (seq, order_id, work_center_code, inspector_id, inspector_name) VALUES ($1, $2, '58', $3, 'Old')`, [seq, order, user])
    }
    const applied = await migrate(app.db)
    expect(applied.map((m) => m.version)).toContain('0071')
    expect((await app.db.query(`SELECT 1 FROM inspection_sessions WHERE order_id = $1 AND status = 'Open'`, [order])).rowCount).toBe(2)
    // A third is refused all the same.
    await expect(app.db.query(`INSERT INTO inspection_sessions (seq, order_id, work_center_code, inspector_id, inspector_name) VALUES (3, $1, '58', $2, 'Old')`, [order, user])).rejects.toThrow(
      /already open on this order line/,
    )
  })
})

describe('§4.4 one open session per order line', () => {
  beforeAll(async () => {
    await app.resetDatabase()
    admin = await app.register('admin', 'Admin')
    insp = await app.register('insp', 'Inspector One')
    const second = await app.register('solo', 'Inspector Solo')
    expect(
      (await app.api('PUT', `/api/users/${second.user.id}/permissions`, { token: admin.token, body: { overrides: [{ permission: 'edit-open-session', granted: false }] } })).status,
    ).toBe(200)
    solo = await app.login('solo')
    for (const machine of [
      { code: '90', name: 'Press 90', line: 'LM3', displayName: '90-Press-LM3', process: 'universal', factory: 'Factory 1' },
      { code: '21', name: '400T Press', displayName: '21-400T Press', factory: 'Factory 3', process: 'forming' },
    ]) {
      expect((await app.api('POST', '/api/master/machines', { token: admin.token, body: machine })).status).toBe(201)
    }
    await app.api('POST', '/api/orders/import', {
      token: admin.token,
      body: {
        rows: ['A', 'B', 'C', 'D', 'E', 'F'].map((k) => ({
          lineKey: `U-${k}`,
          orderNumber: `5000${k}`,
          item: `Item ${k}`,
          itemCode: `IT-${k}`,
          workCenterCode: '90',
          requiredQty: 100,
          finishedQty: 0,
          customer: 'A',
          drawing: 'D-1',
        })),
      },
    })
    lines = (await app.api<ProductionOrder[]>('GET', '/api/orders', { token: admin.token })).body
  })

  it('lands inspectors starting on one line at the same moment in one session', async () => {
    const started = await Promise.all([insp, admin, insp, admin].map((s) => startWithSample(s, { orderId: line('U-A').id, startQty: 0 })))
    expect(started.map((r) => r.status)).toEqual([201, 201, 201, 201])
    expect(new Set(started.map((r) => r.body.session.id)).size).toBe(1)
    expect(started.filter((r) => !r.body.joined)).toHaveLength(1)
    expect(new Set(started.map((r) => r.body.sample.sampleId)).size).toBe(4)
    expect(await openOn(line('U-A').id)).toEqual([started[0].body.session.id])
    expect((await get(started[0].body.session.id)).sampleCount).toBe(4)
  })

  it('refuses a second open session in the database, from any writer, even one that raced past every check', async () => {
    const order = line('U-B')
    const insert = (c: { query: Db['query'] }, seq: number) =>
      c.query(`INSERT INTO inspection_sessions (seq, order_id, work_center_code, inspector_id, inspector_name) VALUES ($1, $2, '90', $3, 'Inspector One') RETURNING id`, [
        seq,
        order.id,
        insp.user.id,
      ])
    const a = await raw.connect()
    const b = await raw.connect()
    try {
      await a.query('BEGIN')
      await b.query('BEGIN')
      const first = (await insert(a, 1)).rows[0].id as string
      // The second writer waits for the first: both saw no open session when they started.
      const second = insert(b, 2).then(
        () => null,
        (e: unknown) => e,
      )
      await waitUntilBlocked()
      await a.query('COMMIT')
      const refused = (await second) as { constraint?: string; message: string }
      expect(pgCode(refused)).toBe('23505')
      expect(refused.constraint).toBe('inspection_sessions_one_open_per_line')
      await b.query('ROLLBACK')

      // Nor by bringing one back, or moving one onto the line.
      const other = (await insert(app.db, 2).catch((e: unknown) => e)) as Error
      expect(other.message).toMatch(/already open on this order line/)
      await app.db.query(`UPDATE inspection_sessions SET status = 'Closed', closed_at = now() WHERE id = $1`, [first])
      const gone = (await insert(app.db, 2)).rows[0].id as string
      await app.db.query(`UPDATE inspection_sessions SET deleted_at = now() WHERE id = $1`, [gone])
      const third = (await insert(app.db, 3)).rows[0].id as string
      await expect(app.db.query(`UPDATE inspection_sessions SET deleted_at = NULL WHERE id = $1`, [gone])).rejects.toThrow(/already open/)
      const elsewhere = (await app.db.query<{ id: string }>(
        `INSERT INTO inspection_sessions (seq, order_id, work_center_code, inspector_id, inspector_name) VALUES (1, $1, '90', $2, 'Inspector One') RETURNING id`,
        [line('U-C').id, insp.user.id],
      )).rows[0].id
      await expect(app.db.query(`UPDATE inspection_sessions SET order_id = $2, seq = 9 WHERE id = $1`, [elsewhere, order.id])).rejects.toThrow(/already open/)
      // The API says it in words.
      const api = await app.api<ApiErrorBody>('POST', '/api/sessions', { token: insp.token, body: { orderId: order.id, startQty: 1 } })
      expect(api.status).toBe(409)
      expect(api.body.error.details).toEqual({ sessionId: third })
      for (const id of [third, elsewhere]) await app.db.query(`UPDATE inspection_sessions SET deleted_at = now() WHERE id = $1`, [id])
    } finally {
      a.release()
      b.release()
    }
  })

  it('keeps an older pair workable, and reopens neither beside an open one', async () => {
    const [older, newer] = await legacyTwins(line('U-D'))
    // Both still take samples and corrections, and close.
    for (const id of [older, newer]) {
      expect((await app.api('POST', `/api/sessions/${id}/samples`, { token: insp.token, body: sample() })).status).toBe(201)
    }
    expect((await app.api('PATCH', `/api/sessions/${newer}/quantities`, { token: insp.token, body: { startQty: 3, version: (await get(newer)).version } })).status).toBe(200)
    // A first sample on the line joins the newer one: no third.
    const joined = await startWithSample(insp, { orderId: line('U-D').id, startQty: 0 })
    expect(joined.body).toMatchObject({ joined: true, session: { id: newer } })
    expect((await close(insp, older, { universal: { kind: 'final' }, finalQty: 5 })).status).toBe(200)

    // Reopened beside the open one: refused, saying which.
    const reopen = async () => app.api<SessionWithOrder & ApiErrorBody>('POST', `/api/sessions/${older}/reopen`, { token: admin.token, body: { version: (await get(older)).version } })
    const refused = await reopen()
    expect(refused.status).toBe(409)
    expect(refused.body.error).toEqual({
      code: 'duplicate',
      message: 'Session #2 is already open on this line, started by Inspector One. One session per line is open at a time: close it before reopening this one.',
      details: { sessionId: newer },
    })
    expect((await get(older)).status).toBe('Closed')
    expect((await close(insp, newer, { universal: { kind: 'final' }, finalQty: 5 })).status).toBe(200)
    expect((await reopen()).status).toBe(200)
    expect(await openOn(line('U-D').id)).toEqual([older])
  })

  it('decides a universal line’s kind once when two of its sessions close at the same moment', async () => {
    const [a, b] = await legacyTwins(line('U-E'))
    for (const id of [a, b]) expect((await app.api('POST', `/api/sessions/${id}/samples`, { token: insp.token, body: sample() })).status).toBe(201)
    const [final, staged] = await Promise.all([
      close(insp, a, { universal: { kind: 'final' }, finalQty: 5 }),
      close(insp, b, { universal: { kind: 'staged', stages: [{ stage: 1, qty: 5 }] } }),
    ])
    // The first close decided; the other was told what the line is.
    expect([final.status, staged.status].sort()).toEqual([200, 400])
    const kinds = (await app.db.query<{ kind: string | null }>(`SELECT universal_kind AS kind FROM inspection_sessions WHERE order_id = $1 AND status = 'Closed'`, [line('U-E').id])).rows
    expect(kinds).toHaveLength(1)
  })

  it('lets only its inspector, or one who may correct open sessions, close a session or add to it by starting', async () => {
    const mine = await startWithSample(insp, { orderId: line('U-F').id, startQty: 0 })
    expect(mine.status).toBe(201)
    const id = mine.body.session.id

    // An inspector who may not correct others' open sessions does not join this one, and is told whose it is.
    const refused = await startWithSample(solo, { orderId: line('U-F').id, startQty: 0 })
    expect(refused.status).toBe(403)
    expect(refused.body.error.message).toBe(
      'Session #1 is already open on this line, started by Inspector One. Only they, or someone who may correct open sessions, can record in it.',
    )
    expect((await get(id)).sampleCount).toBe(1)
    // Nor closes it.
    const notTheirs = await close(solo, id, { universal: { kind: 'final' }, finalQty: 5 })
    expect(notTheirs.status).toBe(403)
    expect(notTheirs.body.error.message).toBe('This session was started by Inspector One. Only they, or someone who may correct open sessions, can close it.')
    expect((await get(id)).status).toBe('Open')

    // One who may correct open sessions joins it; its inspector closes it.
    expect((await startWithSample(admin, { orderId: line('U-F').id, startQty: 0 })).body).toMatchObject({ joined: true, session: { id } })
    expect((await close(insp, id, { universal: { kind: 'final' }, finalQty: 5 })).status).toBe(200)
    // The solo inspector's own session is theirs to close.
    const theirs = await startWithSample(solo, { orderId: line('U-F').id, startQty: 0 })
    expect(theirs.body.joined).toBe(false)
    expect((await close(solo, theirs.body.session.id, { universal: { kind: 'final' }, finalQty: 5 })).status).toBe(200)
  })

  it('keeps the STOCK lines through a catalogue clear: an open stock session is joined, never twinned', async () => {
    const first = await startWithSample(insp, { workCenterCode: '21', producedQty: 50 })
    expect(first.status).toBe(201)
    const stockLine = first.body.session.orderId
    const live = (await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM production_orders WHERE deleted_at IS NULL AND order_number <> 'STOCK'`)).rows[0].n

    const cleared = await app.api<ClearOrdersResult>('POST', '/api/orders/clear', { token: admin.token })
    expect(cleared.body.removed).toBe(live)
    expect((await app.db.query(`SELECT 1 FROM production_orders WHERE id = $1 AND deleted_at IS NULL`, [stockLine])).rowCount).toBe(1)
    const again = await startWithSample(insp, { workCenterCode: '21', producedQty: 50 })
    expect(again.body).toMatchObject({ joined: true, session: { id: first.body.session.id } })

    // A STOCK line retired by an older clear, its session still open: found all the same.
    await app.db.query(`UPDATE production_orders SET deleted_at = now() WHERE id = $1`, [stockLine])
    const after = await startWithSample(insp, { workCenterCode: '21', producedQty: 50 })
    expect(after.body).toMatchObject({ joined: true, session: { id: first.body.session.id } })
    expect(await openOn(stockLine)).toEqual([first.body.session.id])
  })

  it('reads closed sessions by when they closed through an index', async () => {
    const { rows } = await app.db.query<{ def: string }>(`SELECT indexdef AS def FROM pg_indexes WHERE indexname = 'inspection_sessions_closed_idx'`)
    expect(rows[0].def).toMatch(/\(closed_at\) WHERE \(\(deleted_at IS NULL\) AND \(status = 'Closed'::session_status\)\)/)
    const c = await raw.connect()
    try {
      await c.query('ANALYZE inspection_sessions')
      await c.query('BEGIN')
      await c.query('SET LOCAL enable_seqscan = off')
      // The dashboard's production and ai.production_sessions read closed sessions by a span of closed_at.
      const plan = await c.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT id FROM inspection_sessions s
          WHERE s.deleted_at IS NULL AND s.status = 'Closed' AND s.final_qty IS NOT NULL AND s.closed_at IS NOT NULL
            AND s.closed_at >= now() - interval '7 days' AND s.closed_at < now()`,
      )
      expect(plan.rows.map((r) => r['QUERY PLAN']).join('\n')).toMatch(/inspection_sessions_closed_idx/)
      await c.query('ROLLBACK')
    } finally {
      c.release()
    }
  })
})

/** Until a backend of this database waits on a lock (the test's second writer). */
async function waitUntilBlocked(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const { rowCount } = await app.db.query(`SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)
    if (rowCount) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('nothing waited on a lock')
}
