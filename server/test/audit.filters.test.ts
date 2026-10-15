// ============================================================================
// §11 — the audit browser's filters are answered over the whole log.
//
// The log is the table that grows fastest: every save the factory makes writes
// to it. A browser that filtered the newest few hundred entries could not
// answer "who changed this measurement in March". These tests hold the API to
// filtering in SQL, paging back with a cursor, and counting the whole match.
// ============================================================================

import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import type { AuditListResponse, AuditOptionsResponse, ColumnValuesResponse } from '@qc/shared/api'
import { TestApp, type Session } from './harness'

const app = new TestApp()
let admin: Session
let supervisor: Session
/** Far more entries than a page holds, so nothing is found by luck. */
const NOISE = 300
const PAGE = 25
/** Promoting the supervisor in the setup is itself audited: one 'update' on
 *  'User' by Admin, written at setup time. It counts like any other entry. */
const PROMOTION = 1

const get = (query: string) => app.api<AuditListResponse>('GET', `/api/audit?limit=${PAGE}&${query}`, { token: admin.token })

beforeAll(async () => {
  // No AI owner: pinning one writes the assistant's own entries, which these counts are not about.
  await app.start({ AI_OWNER_USERNAME: 'nobody.here' })
  await app.resetDatabase()
  admin = await app.register('admin', 'Admin')
  supervisor = await app.register('sup', 'Rania Adel')
  await app.api('PATCH', `/api/users/${supervisor.user.id}`, { token: admin.token, body: { role: 'supervisor' } })

  // The log as it really accumulates: a wall of routine entries, and one
  // change buried deep inside it. Written straight to the table — the filters
  // under test are a read, and three hundred real saves would prove nothing
  // more. The API's own writers are covered in inspection.test.ts.
  await app.db.query(
    `INSERT INTO audit_log (at, user_id, user_name, action, entity, entity_id, field, old_value, new_value, order_number, item)
     SELECT now() - make_interval(mins => g), $1, 'Admin', 'update', 'InspectionSample', 'sample-' || g,
            'sampleQty', (g)::text, (g + 1)::text, '20552-Ph2.3-RHE', 'XL Light Beam'
       FROM generate_series(1, $2) g`,
    [admin.user.id, NOISE],
  )
  await app.db.query(
    `INSERT INTO audit_log (at, user_id, user_name, action, entity, entity_id, field, old_value, new_value, order_number, item, work_center_code)
     VALUES (now() - interval '400 minutes', $1, 'Rania Adel', 'acknowledge', 'DimensionResult', 'dim-buried',
             'actual', '78.5', '81.2', '19868-Ph2.2B-EHF', 'Deep Shelf Panel', 'STAM 24')`,
    [supervisor.user.id],
  )
})
afterAll(() => app.stop())

describe('§11 — a filter reaches the whole log', () => {
  it('counts the whole match and pages the newest first', async () => {
    const res = await get('')
    expect(res.body.entries).toHaveLength(PAGE)
    expect(res.body.hasMore).toBe(true)
    expect(res.body.total).toBe(NOISE + PROMOTION + 1)
    expect(res.body.entries.map((e) => e.entityId)).not.toContain('dim-buried')
  })

  it('finds the buried entry by order, by item, by value and by machine', async () => {
    for (const term of ['19868', 'Deep Shelf', '81.2', 'STAM 24']) {
      const res = await get(`q=${encodeURIComponent(term)}`)
      expect(res.body.entries.map((e) => e.entityId), term).toEqual(['dim-buried'])
      expect(res.body.total, term).toBe(1)
    }
  })

  it('narrows by who, by what and by action', async () => {
    expect((await get('userName=Rania%20Adel')).body.total).toBe(1)
    expect((await get('entity=DimensionResult')).body.entries.map((e) => e.entityId)).toEqual(['dim-buried'])
    expect((await get('action=acknowledge')).body.total).toBe(1)
    expect((await get('action=update')).body.total).toBe(NOISE + PROMOTION)
  })

  it('narrows by date', async () => {
    // Half a minute past the hundredth entry, so no entry sits on the boundary.
    const since = new Date(Date.now() - 100.5 * 60_000).toISOString()
    const res = await get(`since=${encodeURIComponent(since)}`)
    expect(res.body.total).toBe(100 + PROMOTION)
    expect(res.body.entries.map((e) => e.entityId)).not.toContain('dim-buried')
  })

  it('treats a typed wildcard as text', async () => {
    expect((await get('q=%25')).body.total).toBe(0)
  })

  it('walks back to the oldest entry, keeping the filter', async () => {
    const seen: string[] = []
    let cursor: { at: string; id: string } | null = null
    for (let guard = 0; guard < 40; guard++) {
      const page: AuditListResponse = (
        await get(`action=update${cursor ? `&before=${encodeURIComponent(cursor.at)}&beforeId=${cursor.id}` : ''}`)
      ).body
      seen.push(...page.entries.map((e) => e.id))
      if (cursor) expect(page.total).toBeUndefined()
      if (!page.hasMore) break
      const last = page.entries[page.entries.length - 1]
      cursor = { at: last.at, id: last.id }
    }
    expect(new Set(seen).size).toBe(NOISE + PROMOTION)
  })

  it('offers every user and entity in the log', async () => {
    const res = await app.api<AuditOptionsResponse>('GET', '/api/audit/options', { token: admin.token })
    expect(res.status).toBe(200)
    expect(res.body.users).toEqual(['Admin', 'Rania Adel'])
    expect(res.body.entities).toEqual(['DimensionResult', 'InspectionSample', 'User'])
  })

  it('refuses a filter it cannot read, and keeps the log shut to inspectors', async () => {
    expect((await get('action=snooping')).status).toBe(400)
    expect((await get('since=yesterday')).status).toBe(400)
    const inspector = await app.register('insp', 'Inspector')
    expect((await app.api('GET', '/api/audit?q=19868', { token: inspector.token })).status).toBe(403)
    expect((await app.api('GET', '/api/audit/options', { token: inspector.token })).status).toBe(403)
  })
})

describe('§11 — Excel\'s column filters, over the whole log', () => {
  const cf = (filters: object) => `cf=${encodeURIComponent(JSON.stringify(filters))}`
  const values = (query: string) => app.api<ColumnValuesResponse>('GET', `/api/audit/values?${query}`, { token: admin.token })

  it('ticks values and leaves some out', async () => {
    expect((await get(cf({ order: { values: ['19868-Ph2.2B-EHF'] } }))).body.entries.map((e) => e.entityId)).toEqual(['dim-buried'])
    expect((await get(cf({ user: { except: ['Admin'] } }))).body.total).toBe(1)
    expect((await get(cf({ machine: { values: [''] } }))).body.total).toBe(NOISE + PROMOTION)
    expect((await get(cf({ newValue: { contains: '81.' } }))).body.entries.map((e) => e.entityId)).toEqual(['dim-buried'])
  })

  it('lists a column\'s values under every other filter', async () => {
    const users = await values('column=user')
    expect(users.body.values).toEqual([
      { value: 'Admin', count: NOISE + PROMOTION },
      { value: 'Rania Adel', count: 1 },
    ])
    expect((await values(`column=action&${cf({ user: { values: ['Rania Adel'] } })}`)).body.values).toEqual([{ value: 'acknowledge', count: 1 }])
  })

  it('sorts by a column, blanks last, and pages by position', async () => {
    expect((await get('sort=machine:desc')).body.entries[0].entityId).toBe('dim-buried')
    const oldest = await get('sort=at:asc')
    expect(oldest.body.entries[0].entityId).toBe('dim-buried')
    expect(oldest.body.total).toBe(NOISE + PROMOTION + 1)
    const seen: string[] = []
    for (let offset = 0; offset < NOISE + PROMOTION + 1; offset += PAGE) {
      const page = (await get(`sort=at:asc&offset=${offset}`)).body
      if (offset > 0) expect(page.total).toBeUndefined()
      seen.push(...page.entries.map((e) => e.id))
    }
    expect(new Set(seen).size).toBe(NOISE + PROMOTION + 1)
    expect((await get('sort=nothing:asc')).status).toBe(400)
  })
})
