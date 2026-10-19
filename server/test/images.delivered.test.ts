// ============================================================================
// §21, §10 — a delivered report shows its content to whoever it went to: the
// photos a section shows (a photo_id column) are theirs to see, whatever
// screens they hold. Only those photos, only for those people, and only the
// photos the assistant can show — an id a result merely names opens nothing.
// ============================================================================

import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ChatConversation, ImageAsset, ProductionOrder } from '@qc/shared/types'
import type { AutomationDelivery } from '@qc/shared/automation'
import type { SessionWithOrder } from '@qc/shared/api'
import { TestApp, tinyJpeg, type Session } from './harness'
import { Clock, engineFor, insertAutomation, reportDraft, runsOf, setUp, type People } from './automationsKit'

const app = new TestApp()
let p: People
/** A recipient who opens no inspection screen: the viewer, with the board and History taken away. */
let reader: Session
let seed = 300

async function upload(s: Session): Promise<string> {
  const bytes = tinyJpeg(seed++)
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: 'image/jpeg' }), 'photo.jpg')
  for (const [k, v] of Object.entries({ originalFilename: 'photo.jpg', width: '10', height: '10', sha256: createHash('sha256').update(bytes).digest('hex'), thumbnailDataUrl: 'data:image/jpeg;base64,AAAA' })) {
    form.append(k, v)
  }
  const res = await app.api<ImageAsset>('POST', '/api/images', { token: s.token, raw: form })
  expect(res.status, JSON.stringify(res.body)).toBe(201)
  return res.body.id
}
const content = async (s: Session, id: string) => (await app.api('GET', `/api/images/${id}/content`, { token: s.token })).status
const listed = async (s: Session, ids: string[]) => (await app.api<ImageAsset[]>('GET', `/api/images?ids=${ids.join(',')}`, { token: s.token })).body.map((i) => i.id).sort()

beforeAll(async () => {
  await app.start()
  p = await setUp(app)
  const away = ['view-inspections', 'view-history'].map((permission) => ({ permission, granted: false }))
  expect((await app.api('PUT', `/api/users/${p.viewer.user.id}/permissions`, { token: p.owner.token, body: { overrides: away } })).status).toBe(200)
  reader = await app.login('watcher')
})
afterAll(() => app.stop())

describe('§21 the photos of a delivered report', () => {
  it('lets the people it went to see the photos it shows, and nothing more', async () => {
    await app.api('POST', '/api/orders/import', {
      token: p.owner.token,
      body: { rows: [{ lineKey: 'R-1', orderNumber: '60001', item: 'Upright', itemCode: 'UP-1', workCenterCode: '31', requiredQty: 100, finishedQty: 0, customer: 'C', drawing: 'D-1' }] },
    })
    const order = (await app.api<ProductionOrder[]>('GET', '/api/orders', { token: p.owner.token })).body[0]
    const session = await app.api<SessionWithOrder>('POST', '/api/sessions', { token: p.creator.token, body: { orderId: order.id, startQty: 0 } })
    const [shown, notShown] = [await upload(p.creator), await upload(p.creator)]
    const saved = await app.api('POST', `/api/sessions/${session.body.id}/samples`, {
      token: p.creator.token,
      body: {
        submissionId: randomUUID(),
        drawing: 'D-1',
        sampleQty: 5,
        dimensions: [],
        defects: [
          { defectName: 'Crack', qty: 1, disposition: 'Repair', imageIds: [shown] },
          { defectName: 'Dent', qty: 1, disposition: 'Repair', imageIds: [notShown] },
        ],
        coils: [],
      },
    })
    expect(saved.status).toBe(201)
    // A private chat photo whose id the report's author knows: a result naming it opens nothing.
    const direct = await app.api<ChatConversation>('POST', '/api/chat/conversations', { token: p.creator.token, body: { kind: 'direct', userId: p.creator2.user.id } })
    const privatePhoto = await upload(p.creator)
    await app.api('POST', `/api/chat/conversations/${direct.body.id}/messages`, { token: p.creator.token, body: { clientId: randomUUID(), body: 'mine', imageIds: [privatePhoto] } })

    for (const id of [shown, notShown, privatePhoto]) expect(await content(reader, id)).toBe(404)

    const clock = new Clock()
    const automation = await insertAutomation(app.db, {
      creatorId: p.creator.user.id,
      schedule: {
        ...reportDraft().schedule!,
        summary: false,
        sections: [
          { title: 'Cracks', sql: `SELECT photo_id, defect_name FROM ai.inspection_photos WHERE defect_name = 'Crack'` },
          { title: 'Named', sql: `SELECT '${privatePhoto}'::uuid AS "Photo_ID", 'x' AS caption` },
        ],
      },
      recipients: [{ kind: 'user', userId: reader.user.id }],
      nextRunAt: clock.now(),
    })
    await engineFor(app, clock).tick()
    const run = (await runsOf(app.db, automation)).at(-1)!
    expect(run.deliveryId).not.toBeNull()
    const delivered = await app.api<AutomationDelivery>('GET', `/api/automations/deliveries/${run.deliveryId}`, { token: reader.token })
    expect(delivered.status).toBe(200)
    expect(delivered.body.sections.map((s) => s.rows.map((r) => r[0]))).toEqual([[shown], [privatePhoto]])

    // What it shows, to whom it went: theirs to see.
    expect(await content(reader, shown)).toBe(200)
    expect(await listed(reader, [shown, notShown, privatePhoto])).toEqual([shown])
    // Not the photo it does not show, nor an id it only names.
    expect(await content(reader, notShown)).toBe(404)
    expect(await content(reader, privatePhoto)).toBe(404)
    // Nor for someone it did not go to, holding the same screens.
    const stranger = await app.api('POST', '/api/users', { token: p.owner.token, body: { username: 'stranger', password: 'Password#1', name: 'Stan Stranger', role: 'viewer' } })
    expect(stranger.status).toBe(201)
    const away = ['view-inspections', 'view-history'].map((permission) => ({ permission, granted: false }))
    await app.api('PUT', `/api/users/${(stranger.body as { id: string }).id}/permissions`, { token: p.owner.token, body: { overrides: away } })
    expect(await content(await app.login('stranger'), shown)).toBe(404)

    // Recorded as the delivery was stored: one indexed look-up.
    const recorded = await app.db.query<{ imageId: string }>(`SELECT image_id AS "imageId" FROM ai_report_delivery_images WHERE delivery_id = $1`, [run.deliveryId])
    expect(recorded.rows.map((r) => r.imageId).sort()).toEqual([shown, privatePhoto].sort())
  })
})
