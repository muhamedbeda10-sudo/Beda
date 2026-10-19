// ============================================================================
// §10, §14 — a photo is read by whoever may read what it belongs to: a chat
// photo by the members of its conversation, an inspection's by whoever opens
// sessions (or is given the assistant's Inspections), a notice's by whoever
// it is for. A photo just taken, not yet saved with anything, is its
// uploader's. Anyone else is told it does not exist.
// ============================================================================

import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ChatConversationsResponse, SessionWithOrder } from '@qc/shared/api'
import type { ChatConversation, ImageAsset, Notice, ProductionOrder } from '@qc/shared/types'
import { TestApp, factoryDay, tinyJpeg, type Session } from './harness'
import { grant } from './automationsKit'

const app = new TestApp()
let admin: Session
let insp: Session
let sup: Session
let viewer: Session
/** Chat and notices, but nothing of the inspections: an inspector whose screens and recording were taken away. */
let outsider: Session
let seed = 100

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
  await app.resetDatabase()
  admin = await app.register('admin', 'Admin')
  for (const [username, name, role] of [
    ['insp', 'Ivy Inspector', 'inspector'],
    ['sup', 'Sam Supervisor', 'supervisor'],
    ['watch', 'Vic Viewer', 'viewer'],
    ['out', 'Oscar Outsider', 'inspector'],
  ]) {
    expect((await app.api('POST', '/api/users', { token: admin.token, body: { username, password: 'Password#1', name, role } })).status).toBe(201)
  }
  ;[insp, sup, viewer, outsider] = await Promise.all(['insp', 'sup', 'watch', 'out'].map((u) => app.login(u)))
  const away = ['view-inspections', 'view-history', 'view-coil-search', 'record-inspection'].map((permission) => ({ permission, granted: false }))
  expect((await app.api('PUT', `/api/users/${outsider.user.id}/permissions`, { token: admin.token, body: { overrides: away } })).status).toBe(200)
  outsider = await app.login('out')
})
afterAll(() => app.stop())

describe('§10 who reads a photo', () => {
  it('lets the uploader alone read a photo not yet saved with anything', async () => {
    const id = await upload(insp)
    expect(await content(insp, id)).toBe(200)
    expect(await listed(insp, [id])).toEqual([id])
    for (const s of [sup, viewer, outsider]) {
      expect(await content(s, id)).toBe(404)
      expect(await listed(s, [id])).toEqual([])
    }
  })

  it('lets the members of a conversation read its photos, and nobody else', async () => {
    const direct = await app.api<ChatConversation>('POST', '/api/chat/conversations', { token: insp.token, body: { kind: 'direct', userId: sup.user.id } })
    const id = await upload(insp)
    const sent = await app.api('POST', `/api/chat/conversations/${direct.body.id}/messages`, { token: insp.token, body: { clientId: randomUUID(), body: 'look', imageIds: [id] } })
    expect(sent.status).toBe(201)
    expect(await content(sup, id)).toBe(200)
    expect(await content(outsider, id)).toBe(404)
    expect(await content(admin, id)).toBe(404)
    // The general conversation is everyone's who chats.
    const general = (await app.api<ChatConversationsResponse>('GET', '/api/chat/conversations', { token: insp.token })).body.conversations.find((c) => c.kind === 'general')!
    const open = await upload(insp)
    await app.api('POST', `/api/chat/conversations/${general.id}/messages`, { token: insp.token, body: { clientId: randomUUID(), body: 'all', imageIds: [open] } })
    expect(await content(outsider, open)).toBe(200)
    expect(await content(viewer, open)).toBe(404)
  })

  it('lets whoever opens sessions read an inspection’s photos, or whoever is given the assistant’s Inspections', async () => {
    await app.api('POST', '/api/master/machines', { token: admin.token, body: { code: '90', name: 'Press 90', line: 'LM3', displayName: '90-Press-LM3', process: 'universal' } })
    await app.api('POST', '/api/orders/import', {
      token: admin.token,
      body: { rows: [{ lineKey: 'U-1', orderNumber: '50001-A', item: 'Base Plate', itemCode: 'BP-10', workCenterCode: '90', requiredQty: 120, finishedQty: 0, customer: 'A', drawing: 'D-1' }] },
    })
    const order = (await app.api<ProductionOrder[]>('GET', '/api/orders', { token: admin.token })).body[0]
    const session = await app.api<SessionWithOrder>('POST', '/api/sessions', { token: insp.token, body: { orderId: order.id, startQty: 0 } })
    const id = await upload(insp)
    const saved = await app.api('POST', `/api/sessions/${session.body.id}/samples`, {
      token: insp.token,
      body: { submissionId: randomUUID(), drawing: 'D-1', sampleQty: 5, dimensions: [], defects: [{ defectName: 'Burr', qty: 1, disposition: 'Repair', imageIds: [id] }], coils: [] },
    })
    expect(saved.status).toBe(201)
    for (const s of [insp, sup, viewer, admin]) expect(await content(s, id)).toBe(200)
    expect(await content(outsider, id)).toBe(404)
    await grant(app, admin, outsider, { domains: ['inspection'] })
    expect(await content(outsider, id)).toBe(200)
  })

  it('lets whoever a notice is for read its photos', async () => {
    const id = await upload(admin)
    const notice = await app.api<Notice>('POST', '/api/notices', {
      token: admin.token,
      body: { title: 'Supervisors: new gauge', severity: 'info', requiresAck: false, validFrom: factoryDay(), targets: [{ kind: 'role', value: 'supervisor' }], imageIds: [id] },
    })
    expect(notice.status).toBe(201)
    expect(await content(sup, id)).toBe(200)
    expect(await content(insp, id)).toBe(404)
    expect(await content(viewer, id)).toBe(404)
    // Listing several at once leaves out what the reader may not see.
    expect(await listed(viewer, [id])).toEqual([])
    expect(await listed(sup, [id])).toEqual([id])
  })
})
