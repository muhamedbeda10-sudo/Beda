import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CreateScrapRequest, ScrapListResponse, ScrapOptions, ScrapRecord, ScrapType } from '@qc/shared/scrap'
import type { ImageAsset, Machine } from '@qc/shared/types'
import { TestApp, tinyJpeg, type Session } from './harness'

const app = new TestApp()
let admin: Session
let inspector: Session
let colleague: Session
let supervisor: Session
let reader: Session
let outsider: Session
let press: Machine
let welder: Machine
let coarse: ScrapType
let soft: ScrapType
let seed = 100

async function upload(user: Session) {
  const bytes = tinyJpeg(seed++)
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: 'image/jpeg' }), 'scrap.jpg')
  for (const [k, v] of Object.entries({ originalFilename: 'scrap.jpg', width: '10', height: '10', sha256: createHash('sha256').update(bytes).digest('hex'), thumbnailDataUrl: 'data:image/jpeg;base64,AAAA' })) form.append(k, v)
  const response = await app.api<ImageAsset>('POST', '/api/images', { token: user.token, raw: form })
  expect(response.status, JSON.stringify(response.body)).toBe(201)
  return response.body.id
}
async function create(user = inspector, overrides: Partial<CreateScrapRequest> = {}): Promise<CreateScrapRequest> {
  return {
    submissionId: randomUUID(), date: '2026-10-20', factory: 'LM3', machineId: press.id, scrapTypeId: coarse.id, weightKg: 513.25,
    responsiblePerson: '', inspectorId: user.user.id, cardImageId: await upload(user), boxImageId: await upload(user), ...overrides,
  }
}
const save = (body: CreateScrapRequest, user = inspector) => app.api<ScrapRecord>('POST', '/api/scrap', { token: user.token, body })
const list = async (query = '', user = reader) => (await app.api<ScrapListResponse>('GET', `/api/scrap?${query}`, { token: user.token })).body
const edit = (record: ScrapRecord, changes: Partial<ScrapRecord>, user = inspector) => app.api<ScrapRecord>('PUT', `/api/scrap/${record.id}`, {
  token: user.token,
  body: { version: record.version, date: record.date, factory: record.factory, machineId: record.machineId, scrapTypeId: record.scrapTypeId, weightKg: record.weightKg,
    responsiblePerson: record.responsiblePerson, inspectorId: record.inspectorId, cardImageId: record.cardImageId, boxImageId: record.boxImageId, ...changes },
})

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  admin = await app.register('admin', 'Administrator')
  for (const [username, role] of [['inspector', 'inspector'], ['colleague', 'inspector'], ['supervisor', 'supervisor'], ['reader', 'viewer'], ['outsider', 'viewer']] as const) {
    expect((await app.api('POST', '/api/users', { token: admin.token, body: { username, password: 'Password#1', name: username, role } })).status).toBe(201)
  }
  inspector = await app.login('inspector')
  colleague = await app.login('colleague')
  supervisor = await app.login('supervisor')
  reader = await app.login('reader')
  outsider = await app.login('outsider')
  expect((await app.api('PUT', `/api/users/${outsider.user.id}/permissions`, { token: admin.token, body: { overrides: [{ permission: 'view-history', granted: false }] } })).status).toBe(200)
  outsider = await app.login('outsider')
  press = (await app.api<Machine>('POST', '/api/master/machines', { token: admin.token, body: { code: '21', name: 'Press 400 T', line: 'LM3', displayName: '3-Press 400 T-ID-21', process: 'forming', factory: 'LM3' } })).body
  welder = (await app.api<Machine>('POST', '/api/master/machines', { token: admin.token, body: { code: '9', name: 'STAM Beams', line: 'LM2', displayName: '2-STAM Beams-ID-9', process: 'welding', factory: 'LM2' } })).body
  const options = (await app.api<ScrapOptions>('GET', '/api/scrap/options', { token: inspector.token })).body
  coarse = options.types.find((t) => t.name === 'Coarse scrap')!
  soft = options.types.find((t) => t.name === 'Soft scrap')!
})
afterAll(() => app.stop())

describe('scrap permissions and choices', () => {
  it('lets inspectors record, History readers read, and nobody else either', async () => {
    expect((await app.api('GET', '/api/scrap', { token: outsider.token })).status).toBe(403)
    expect((await app.api('GET', '/api/scrap/options', { token: outsider.token })).status).toBe(403)
    expect((await app.api('GET', '/api/scrap', { token: reader.token })).status).toBe(200)
    expect((await save(await create(inspector, { inspectorId: inspector.user.id }), reader)).status).toBe(403)
    expect((await app.api('POST', '/api/scrap/types', { token: reader.token, body: { name: 'Paint scrap' } })).status).toBe(403)
  })

  it('offers the factories’ machines, the two types and the people who inspect', async () => {
    const options = (await app.api<ScrapOptions>('GET', '/api/scrap/options', { token: reader.token })).body
    expect(options.factories).toEqual(['LM2', 'LM3'])
    expect(options.machines.map((m) => m.id).sort()).toEqual([press.id, welder.id].sort())
    expect(options.types.map((t) => t.name)).toEqual(['Coarse scrap', 'Soft scrap'])
    const names = options.inspectors.map((p) => p.name)
    expect(names).toEqual(expect.arrayContaining(['inspector', 'colleague', 'supervisor']))
    expect(names).not.toContain('reader')
  })

  it('adds a scrap type once, whatever its case, and audits it', async () => {
    const results = await Promise.all(['Paint scrap', ' paint SCRAP '].map((name) => app.api<ScrapType>('POST', '/api/scrap/types', { token: inspector.token, body: { name } })))
    expect(results.map((r) => r.status).sort()).toEqual([200, 201])
    expect(results[0].body.id).toBe(results[1].body.id)
    expect((await app.db.query("SELECT 1 FROM audit_log WHERE entity = 'ScrapType' AND entity_id = $1", [results[0].body.id])).rows).toHaveLength(1)
  })
})

describe('recording scrap', () => {
  it('saves the weight, both photos and the names as recorded, and audits it', async () => {
    const body = await create(inspector, { responsiblePerson: ' Ahmed Ali ' })
    const response = await save(body)
    expect(response.status, JSON.stringify(response.body)).toBe(201)
    expect(response.body).toMatchObject({ date: '2026-10-20', factory: 'LM3', machineName: '3-Press 400 T-ID-21', machineCode: '21', scrapTypeName: 'Coarse scrap',
      weightKg: 513.25, responsiblePerson: 'Ahmed Ali', inspectorName: 'inspector', cardImageId: body.cardImageId, boxImageId: body.boxImageId, createdByName: 'inspector', version: 0 })
    expect((await app.db.query("SELECT action FROM audit_log WHERE entity = 'ScrapRecord' AND entity_id = $1", [response.body.id])).rows).toEqual([{ action: 'create' }])
    const content = (user: Session, id: string) => app.api('GET', `/api/images/${id}/content`, { token: user.token })
    for (const id of [body.cardImageId, body.boxImageId]) {
      expect((await content(reader, id)).status).toBe(200)
      expect((await content(outsider, id)).status).toBe(404)
    }
  })

  it('requires the weight and both photos, and checks every choice, saving nothing on a refusal', async () => {
    const before = (await app.db.query('SELECT count(*)::int AS n FROM scrap_records')).rows[0].n
    const photo = await upload(inspector)
    const cases: Record<string, unknown>[] = [
      { weightKg: undefined }, { weightKg: 0 }, { weightKg: -5 }, { weightKg: 'heavy' }, { weightKg: 2_000_000 }, { weightKg: 0.0001 },
      { cardImageId: undefined }, { boxImageId: undefined }, { cardImageId: '' }, { cardImageId: photo, boxImageId: photo },
      { factory: 'LM2' }, { machineId: randomUUID() }, { scrapTypeId: randomUUID() }, { inspectorId: reader.user.id }, { inspectorId: randomUUID() },
      { date: '2026-02-30' }, { date: '2999-01-01' }, { cardImageId: randomUUID() },
    ]
    for (const overrides of cases) {
      const body = { ...(await create()), ...overrides } as CreateScrapRequest
      const response = await save(body)
      expect(response.status, JSON.stringify({ overrides, body: response.body })).toBe(400)
    }
    // Another person's photo, not attached to anything this person can read.
    expect((await save(await create(inspector, { cardImageId: await upload(admin) }))).status).toBe(403)
    // A photo already evidence of another scrap record, as the same slot or the other one.
    const used = (await list('limit=1')).records[0]
    expect((await save(await create(inspector, { cardImageId: used.cardImageId }))).status).toBe(400)
    expect((await save(await create(inspector, { boxImageId: used.cardImageId }))).status).toBe(400)
    // A photo of another kind of record, even one this person took.
    const reference = await upload(inspector)
    await app.db.query(`INSERT INTO item_reference_images (item, item_code, image_id) VALUES ('Upright', 'UP80', $1)`, [reference])
    expect((await save(await create(inspector, { cardImageId: reference }))).status).toBe(400)
    expect((await app.db.query('SELECT count(*)::int AS n FROM scrap_records')).rows[0].n).toBe(before)
  })

  it('keeps one live record per photo even when two saves race with the same photo', async () => {
    const card = await upload(inspector)
    const results = await Promise.all([save(await create(inspector, { cardImageId: card })), save(await create(inspector, { cardImageId: card }))])
    expect(results.map((r) => r.status).sort()).toEqual([201, 400])
    await expect(app.db.query(`UPDATE scrap_records SET box_image_id = card_image_id WHERE id = $1`, [results.find((r) => r.status === 201)!.body.id])).rejects.toThrow()
  })

  it('keeps one record when a save is retried, even concurrently, and refuses a reused submission with other values', async () => {
    const body = await create()
    const responses = await Promise.all([save(body), save(body)])
    expect(responses.map((r) => r.status).sort()).toEqual([200, 201])
    expect(responses[0].body.id).toBe(responses[1].body.id)
    expect((await save({ ...body, weightKg: 99 })).status).toBe(409)
    expect((await app.db.query('SELECT 1 FROM scrap_records WHERE submission_id = $1', [body.submissionId])).rows).toHaveLength(1)
  })
})

describe('correcting and deleting scrap', () => {
  it('lets the recorder correct their own record, a supervisor anyone’s, never a stale version, and audits each field', async () => {
    const record = (await save(await create())).body
    expect((await edit(record, { weightKg: 600 }, colleague)).status).toBe(403)
    expect((await edit(record, { weightKg: 600 }, reader)).status).toBe(403)
    const mine = await edit(record, { weightKg: 600, scrapTypeId: soft.id })
    expect(mine.status, JSON.stringify(mine.body)).toBe(200)
    expect(mine.body).toMatchObject({ weightKg: 600, scrapTypeName: 'Soft scrap', version: 1, updatedByName: 'inspector' })
    expect((await edit(record, { weightKg: 700 }, supervisor)).status).toBe(409)
    const newBox = await upload(supervisor)
    const theirs = await edit(mine.body, { weightKg: 700, boxImageId: newBox }, supervisor)
    expect(theirs.status, JSON.stringify(theirs.body)).toBe(200)
    expect(theirs.body).toMatchObject({ weightKg: 700, boxImageId: newBox, version: 2, updatedByName: 'supervisor' })
    const changes = (await app.db.query("SELECT field, old_value, new_value FROM audit_log WHERE entity = 'ScrapRecord' AND entity_id = $1 AND action = 'update' ORDER BY at, field", [record.id])).rows
    expect(changes).toEqual(expect.arrayContaining([
      { field: 'weightKg', old_value: '513.25', new_value: '600' }, { field: 'scrapType', old_value: 'Coarse scrap', new_value: 'Soft scrap' },
      { field: 'weightKg', old_value: '600', new_value: '700' }, { field: 'boxPhoto', old_value: record.boxImageId, new_value: newBox },
    ]))
    expect((await edit(theirs.body, { weightKg: 0 }, supervisor)).status).toBe(400)
  })

  it('deletes softly, by the recorder or a supervisor, leaving it out of History and the assistant', async () => {
    const record = (await save(await create(inspector, { responsiblePerson: 'DeleteMe' }))).body
    expect((await app.api('DELETE', `/api/scrap/${record.id}?version=${record.version}`, { token: colleague.token })).status).toBe(403)
    expect((await app.api('DELETE', `/api/scrap/${record.id}?version=${record.version + 1}`, { token: inspector.token })).status).toBe(409)
    expect((await app.api('DELETE', `/api/scrap/${record.id}?version=${record.version}`, { token: inspector.token })).status).toBe(204)
    expect((await list('q=DeleteMe')).total).toBe(0)
    expect((await app.db.query('SELECT 1 FROM ai.scrap_records WHERE scrap_id = $1', [record.id])).rows).toHaveLength(0)
    expect((await app.db.query("SELECT action FROM audit_log WHERE entity = 'ScrapRecord' AND entity_id = $1 ORDER BY at", [record.id])).rows.map((r) => r.action)).toEqual(['create', 'delete'])
    await expect(app.db.query('DELETE FROM scrap_records WHERE id = $1', [record.id])).rejects.toThrow()
    expect((await app.api('GET', `/api/images/${record.cardImageId}/content`, { token: reader.token })).status).toBe(404)
  })
})

describe('reading scrap in History and through the assistant', () => {
  it('filters the whole record, sums the weight of every match and pages in a stable order', async () => {
    const older = (await save(await create(inspector, { date: '2026-10-10', responsiblePerson: 'FindMe 100%', weightKg: 100 }))).body
    const newer = (await save(await create(inspector, { date: '2026-10-11', responsiblePerson: 'FindMe', factory: 'LM2', machineId: welder.id, scrapTypeId: soft.id, weightKg: 50.5 }))).body
    const first = await list('q=FindMe&limit=1')
    expect(first).toMatchObject({ total: 2, totalWeightKg: 150.5, hasMore: true })
    expect(first.records[0].id).toBe(newer.id)
    expect((await list('q=FindMe&limit=1&offset=1')).records[0].id).toBe(older.id)
    expect((await list('q=100%25')).records.map((r) => r.id)).toEqual([older.id])
    expect((await list(`q=FindMe&factory=LM2&machineId=${welder.id}&scrapTypeId=${soft.id}&from=2026-10-11&to=2026-10-11`)).records.map((r) => r.id)).toEqual([newer.id])
    expect((await list(`q=FindMe&inspectorId=${colleague.user.id}`)).total).toBe(0)
    expect((await app.api('GET', '/api/scrap?from=2026-10-12&to=2026-10-11', { token: reader.token })).status).toBe(400)
    expect((await app.api<ScrapOptions>('GET', '/api/scrap/options', { token: reader.token })).body.responsiblePeople).toEqual(expect.arrayContaining(['FindMe', 'FindMe 100%']))
  })

  it('keeps the names as recorded after the machine is renamed or moved, and still lets the record be corrected', async () => {
    const record = (await save(await create(inspector, { responsiblePerson: 'Snapshot' }))).body
    await app.db.query("UPDATE machines SET display_name = 'Renamed press', factory = 'LM9' WHERE id = $1", [press.id])
    const read = (await list('q=Snapshot')).records[0]
    expect(read).toMatchObject({ id: record.id, factory: 'LM3', machineName: '3-Press 400 T-ID-21' })
    const corrected = await edit(read, { weightKg: 42 })
    expect(corrected.status, JSON.stringify(corrected.body)).toBe(200)
    expect(corrected.body).toMatchObject({ factory: 'LM3', machineName: '3-Press 400 T-ID-21', weightKg: 42 })
    expect((await save(await create(inspector, { factory: 'LM3' }))).status).toBe(400)
    await app.db.query("UPDATE machines SET display_name = '3-Press 400 T-ID-21', factory = 'LM3' WHERE id = $1", [press.id])
  })

  it('exports every match for people who may export, and offers former inspectors in the filter', async () => {
    expect((await app.api('GET', '/api/scrap/export', { token: reader.token })).status).toBe(403)
    const all = await app.api<ScrapRecord[]>('GET', '/api/scrap/export?q=FindMe', { token: supervisor.token })
    expect(all.status).toBe(200)
    expect(all.body.map((r) => r.responsiblePerson).sort()).toEqual(['FindMe', 'FindMe 100%'])
    await app.db.query(`UPDATE users SET is_active = false WHERE id = $1`, [colleague.user.id])
    await app.db.query(`UPDATE scrap_records SET inspector_id = $1, inspector_name = 'colleague' WHERE id = (SELECT id FROM scrap_records WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1)`, [colleague.user.id])
    const options = (await app.api<ScrapOptions>('GET', '/api/scrap/options', { token: reader.token })).body
    expect(options.inspectors.map((p) => p.id)).not.toContain(colleague.user.id)
    expect(options.recordedInspectors.map((p) => p.id)).toContain(colleague.user.id)
    await app.db.query(`UPDATE users SET is_active = true WHERE id = $1`, [colleague.user.id])
  })

  it('lets a recorder without History read their own record’s photos after a supervisor replaced one', async () => {
    expect((await app.api('PUT', `/api/users/${colleague.user.id}/permissions`, { token: admin.token, body: { overrides: [{ permission: 'view-history', granted: false }] } })).status).toBe(200)
    const recorder = await app.login('colleague')
    const record = (await save(await create(recorder), recorder)).body
    const replaced = (await edit(record, { boxImageId: await upload(supervisor) }, supervisor)).body
    expect((await app.api('GET', `/api/images/${replaced.boxImageId}/content`, { token: recorder.token })).status).toBe(200)
    expect((await app.api('GET', `/api/scrap/${record.id}`, { token: recorder.token })).status).toBe(200)
    expect((await app.api('GET', '/api/scrap', { token: recorder.token })).status).toBe(403)
    expect((await app.api('PUT', `/api/users/${colleague.user.id}/permissions`, { token: admin.token, body: { overrides: [] } })).status).toBe(200)
  })

  it('places each inspector in the factories they worked in lately, for the form', async () => {
    const order = (await app.db.query<{ id: string }>(`INSERT INTO production_orders (order_number, item, item_code, work_center_code, line_key, customer, required_qty)
      VALUES ('S1', 'Beam', 'BM', '9', 'SCRAP-LK1', 'C', 10) RETURNING id`)).rows[0].id
    const session = (when: string, user: Session) => app.db.query(`INSERT INTO inspection_sessions (seq, order_id, work_center_code, inspector_id, inspector_name, status, started_at, closed_at)
      VALUES ((SELECT COALESCE(max(seq), 0) + 1 FROM inspection_sessions WHERE order_id = $1), $1, '9', $2, $3, 'Closed', now() - $4::interval, now() - $4::interval + interval '1 hour')`, [order, user.user.id, user.user.name, when])
    await session('2 days', supervisor)
    await session('200 days', colleague)
    const people = (await app.api<ScrapOptions>('GET', '/api/scrap/options', { token: inspector.token })).body.inspectors
    const of = (user: Session) => people.find((p) => p.id === user.user.id)?.factories
    expect(of(supervisor)).toEqual(['LM2'])
    // Named on scrap in both factories in the tests above.
    expect(of(inspector)).toEqual(['LM2', 'LM3'])
    // Their LM2 session is too old to count; their scrap at LM3 (recorded above) does.
    expect(of(colleague)).toEqual(['LM3'])
  })

  it('gives the assistant’s inspection readers the records and their two photos', async () => {
    const record = (await save(await create(inspector, { weightKg: 77 }))).body
    const row = (await app.db.query('SELECT * FROM ai.scrap_records WHERE scrap_id = $1', [record.id])).rows[0]
    expect(row).toMatchObject({ factory: 'LM3', machine: '3-Press 400 T-ID-21', scrap_type: 'Coarse scrap', weight_kg: 77, inspector: 'inspector', responsible_person: null })
    const photos = (await app.db.query('SELECT photo_id, photo_of FROM ai.scrap_photos WHERE scrap_id = $1 ORDER BY photo_of', [record.id])).rows
    expect(photos).toEqual([{ photo_id: record.boxImageId, photo_of: 'scrap box' }, { photo_id: record.cardImageId, photo_of: 'scrap card' }])
    const grants = (await app.db.query(`SELECT has_table_privilege(current_database() || '_ai_inspection', 'ai.scrap_records', 'SELECT') AS records,
      has_table_privilege(current_database() || '_ai_inspection', 'ai.scrap_photos', 'SELECT') AS photos,
      has_table_privilege(current_database() || '_ai_orders', 'ai.scrap_records', 'SELECT') AS other`)).rows[0]
    expect(grants).toEqual({ records: true, photos: true, other: false })
  })
})
