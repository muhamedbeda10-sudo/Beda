import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Concession, ConcessionCategory, ConcessionItem, ConcessionListResponse, ConcessionOptions, CreateConcessionRequest } from '@qc/shared/concessions'
import type { ImageAsset, Machine } from '@qc/shared/types'
import { TestApp, tinyJpeg, type Session } from './harness'

const app = new TestApp()
let admin: Session
let recorder: Session
let reader: Session
let outsider: Session
let first: Machine
let second: Machine
let category: ConcessionCategory

const create = (overrides: Partial<CreateConcessionRequest> = {}): CreateConcessionRequest => ({
  submissionId: randomUUID(), date: '2026-10-22', factories: ['Factory 1', 'Factory 2'], machineIds: [first.id, second.id],
  customer: 'Alpha Customer', itemCode: 'UP80', item: 'Upright', description: 'Material approved by customer email',
  quantity: 'all stock', categoryId: category.id, concessionBy: 'Customer engineering', imageIds: [], ...overrides,
})
const save = (body: CreateConcessionRequest, user = recorder) => app.api<Concession>('POST', '/api/concessions', { token: user.token, body })
async function upload(user: Session) {
  const bytes = tinyJpeg(42)
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: 'image/jpeg' }), 'email.jpg')
  for (const [k, v] of Object.entries({ originalFilename: 'email.jpg', width: '10', height: '10', sha256: createHash('sha256').update(bytes).digest('hex'), thumbnailDataUrl: 'data:image/jpeg;base64,AAAA' })) form.append(k, v)
  return app.api<ImageAsset>('POST', '/api/images', { token: user.token, raw: form })
}

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  admin = await app.register('admin', 'Administrator')
  for (const username of ['recorder', 'reader', 'outsider']) {
    expect((await app.api('POST', '/api/users', { token: admin.token, body: { username, password: 'Password#1', name: username, role: 'viewer' } })).status).toBe(201)
  }
  recorder = await app.login('recorder')
  reader = await app.login('reader')
  outsider = await app.login('outsider')
  for (const [person, recording] of [[recorder, true], [reader, false]] as const) {
    expect((await app.api('PUT', `/api/users/${person.user.id}/permissions`, { token: admin.token, body: { overrides: [
      { permission: 'view-concessions', granted: true }, ...(recording ? [{ permission: 'record-concession', granted: true }] : []),
    ] } })).status).toBe(200)
  }
  first = (await app.api<Machine>('POST', '/api/master/machines', { token: admin.token, body: { code: '31', name: 'Forming', line: 'LM1', displayName: '31 Forming', process: 'forming', factory: 'Factory 1' } })).body
  second = (await app.api<Machine>('POST', '/api/master/machines', { token: admin.token, body: { code: '48', name: 'Painting', line: 'LM2', displayName: '48 Painting', process: 'paint', factory: 'Factory 2' } })).body
  expect((await app.api('POST', '/api/orders/import', { token: admin.token, body: { rows: [
    { lineKey: 'C-1', orderNumber: 'C100', item: 'Upright', itemCode: 'UP80', workCenterCode: '31', customer: 'Alpha Customer' },
    { lineKey: 'C-2', orderNumber: 'C100', item: 'Upright', itemCode: 'UP80', workCenterCode: '48', customer: 'Alpha Customer' },
    { lineKey: 'C-3', orderNumber: 'C101', item: 'Beam', itemCode: 'BM', workCenterCode: '31', customer: 'Beta Customer' },
    { lineKey: 'C-4', orderNumber: 'C100', item: 'Frame B', itemCode: 'UP80', workCenterCode: '31', customer: 'Alpha Customer' },
  ] } })).status).toBe(200)
  category = (await app.api<ConcessionOptions>('GET', '/api/concessions/options', { token: recorder.token })).body.categories.find((c) => c.name === 'Material Change')!
})
afterAll(() => app.stop())

describe('concessions permissions and choices', () => {
  it('enforces screen access on every read and write; a reader cannot record or add a category', async () => {
    for (const path of ['', '/options', '/customers', '/items?customer=Alpha']) {
      expect((await app.api('GET', `/api/concessions${path}`, { token: outsider.token })).status, path).toBe(403)
    }
    expect((await save(create(), outsider)).status).toBe(403)
    expect((await save(create(), reader)).status).toBe(403)
    for (const user of [reader, outsider]) expect((await app.api('POST', '/api/concessions/categories', { token: user.token, body: { name: 'Other' } })).status).toBe(403)
    expect((await upload(reader)).status).toBe(403)
  })

  it('offers the machine register, the three categories and only the chosen customer’s items', async () => {
    const options = (await app.api<ConcessionOptions>('GET', '/api/concessions/options', { token: reader.token })).body
    expect(options.factories).toEqual(['Factory 1', 'Factory 2'])
    expect(options.machines.map((m) => m.id).sort()).toEqual([first.id, second.id].sort())
    expect(options.categories.map((c) => c.name)).toEqual(['Dimension Concession', 'Material Change', 'Visual Concession'])
    expect((await app.api<string[]>('GET', '/api/concessions/customers?q=alpha', { token: recorder.token })).body).toEqual(['Alpha Customer'])
    const items = (await app.api<ConcessionItem[]>('GET', '/api/concessions/items?customer=alpha%20customer', { token: recorder.token })).body
    expect(items).toEqual([{ itemCode: 'UP80', item: 'Frame B' }, { itemCode: 'UP80', item: 'Upright' }])
    expect((await app.api<ConcessionItem[]>('GET', '/api/concessions/items?customer=Alpha%20Customer&q=UP80', { token: reader.token })).body).toHaveLength(2)
  })

  it('adds a reusable category once, including concurrent differently cased retries, and audits it', async () => {
    const results = await Promise.all(['Special Approval', ' special approval '].map((name) => app.api<ConcessionCategory>('POST', '/api/concessions/categories', { token: recorder.token, body: { name } })))
    expect(results.map((v) => v.status).sort()).toEqual([200, 201])
    expect(results[0].body.id).toBe(results[1].body.id)
    expect((await app.db.query("SELECT id FROM audit_log WHERE entity = 'ConcessionCategory' AND entity_id = $1", [results[0].body.id])).rows).toHaveLength(1)
    const result = await save(create({ categoryId: results[0].body.id }))
    expect(result.status).toBe(201)
    expect(result.body.categoryName.toLowerCase()).toBe('special approval')
  })
})

describe('recording concessions and their evidence', () => {
  it('saves multiple factories and machines, text or numeric quantities, and email screenshots with a separate author', async () => {
    // This person has no record-inspection permission: concession recording is enough to upload its evidence.
    const image = await upload(recorder)
    expect(image.status).toBe(201)
    const response = await save(create({ quantity: '250', imageIds: [image.body.id, image.body.id], concessionBy: 'Customer manager' }))
    expect(response.status, JSON.stringify(response.body)).toBe(201)
    expect(response.body).toMatchObject({ date: '2026-10-22', factories: ['Factory 1', 'Factory 2'], quantity: '250', concessionBy: 'Customer manager', createdById: recorder.user.id, createdByName: 'recorder', imageIds: [image.body.id] })
    expect(response.body.machines.map((m) => m.displayName).sort()).toEqual(['31 Forming', '48 Painting'])
    const content = (user: Session) => app.api('GET', `/api/images/${image.body.id}/content`, { token: user.token })
    expect((await content(reader)).status).toBe(200)
    expect((await content(outsider)).status).toBe(404)
    expect((await app.api<ImageAsset[]>('GET', `/api/images?ids=${image.body.id}`, { token: reader.token })).body.map((v) => v.id)).toEqual([image.body.id])
    expect((await app.db.query("SELECT action FROM audit_log WHERE entity = 'Concession' AND entity_id = $1", [response.body.id])).rows).toEqual([{ action: 'create' }])
  })

  it('replays a save once even concurrently and rejects a reused submission with changed data or another author', async () => {
    const body = create()
    const responses = await Promise.all([save(body), save(body)])
    expect(responses.map((r) => r.status).sort()).toEqual([200, 201])
    expect(responses[0].body.id).toBe(responses[1].body.id)
    expect((await save(body)).status).toBe(200)
    expect((await save({ ...body, quantity: 'different' })).status).toBe(409)
    expect((await save(body, admin)).status).toBe(409)
    expect((await app.db.query('SELECT id FROM concessions WHERE submission_id = $1', [body.submissionId])).rows).toHaveLength(1)
    expect((await app.db.query("SELECT id FROM audit_log WHERE entity = 'Concession' AND entity_id = $1", [responses[0].body.id])).rows).toHaveLength(1)
  })

  it('rejects invalid dates, customer/item combinations, factory/machine combinations and missing evidence atomically', async () => {
    const before = (await app.db.query('SELECT count(*) AS n FROM concessions')).rows[0].n
    for (const overrides of [
      { date: '2026-02-30' }, { date: '0000-01-01' }, { customer: 'Beta Customer' }, { item: 'No such item' },
      { factories: ['Factory 1'] }, { machineIds: [first.id] }, { machineIds: [randomUUID()] },
      { factories: [] }, { quantity: '  ' }, { concessionBy: '' }, { categoryId: randomUUID() }, { imageIds: [randomUUID()] },
    ]) {
      const response = await save(create(overrides))
      expect(response.status, JSON.stringify({ overrides, response: response.body })).toBe(400)
    }
    const privatePhoto = await upload(admin)
    expect((await save(create({ imageIds: [privatePhoto.body.id] }))).status).toBe(403)
    expect((await app.db.query('SELECT count(*) AS n FROM concessions')).rows[0].n).toBe(before)
  })
})

describe('finding and preserving the register', () => {
  it('filters the entire register, treats search wildcards literally and paginates in a stable order', async () => {
    const older = await save(create({ date: '2026-10-20', description: 'FindMe 100% approved' }))
    const newer = await save(create({ date: '2026-10-21', description: 'FindMe updated' }))
    const list = async (query: string) => (await app.api<ConcessionListResponse>('GET', `/api/concessions?${query}`, { token: reader.token })).body
    const firstPage = await list('q=FindMe&limit=1')
    expect(firstPage.total).toBe(2)
    expect(firstPage.hasMore).toBe(true)
    expect(firstPage.concessions[0].id).toBe(newer.body.id)
    const next = await list('q=FindMe&limit=1&offset=1')
    expect(next.concessions[0].id).toBe(older.body.id)
    expect(next.hasMore).toBe(false)
    expect((await list('q=100%25')).concessions.map((c) => c.id)).toEqual([older.body.id])
    expect((await list(`q=FindMe&factory=Factory%202&machineId=${second.id}&categoryId=${category.id}&from=2026-10-20&to=2026-10-20`)).concessions.map((c) => c.id)).toEqual([older.body.id])
    expect((await list('q=FindMe&factory=Unknown')).total).toBe(0)
    expect((await app.api('GET', '/api/concessions?from=2026-10-22&to=2026-10-20', { token: reader.token })).status).toBe(400)
  })

  it('keeps factory, machine, customer and item snapshots after master data and ERP rows change', async () => {
    const recorded = await save(create({ description: 'Snapshot test' }))
    await app.db.query("UPDATE machines SET display_name = 'New machine name', factory = 'Factory 3' WHERE id = $1", [second.id])
    await app.db.query("UPDATE production_orders SET customer = 'Renamed customer', item = 'Renamed item', deleted_at = now() WHERE customer = 'Alpha Customer'")
    const result = (await app.api<ConcessionListResponse>('GET', '/api/concessions?q=Snapshot', { token: reader.token })).body.concessions[0]
    expect(result.id).toBe(recorded.body.id)
    expect(result).toMatchObject({ customer: 'Alpha Customer', item: 'Upright', factories: ['Factory 1', 'Factory 2'] })
    expect(result.machines.find((m) => m.id === second.id)).toMatchObject({ displayName: '48 Painting', factory: 'Factory 2' })
    const options = (await app.api<ConcessionOptions>('GET', '/api/concessions/options', { token: reader.token })).body
    expect(options.factories).toContain('Factory 2')
    await expect(app.db.query('DELETE FROM concessions WHERE id = $1', [recorded.body.id])).rejects.toThrow()
    await expect(app.db.query('DELETE FROM concession_machines WHERE concession_id = $1', [recorded.body.id])).rejects.toThrow()
  })
})
