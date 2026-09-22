import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import type { ApiErrorBody, MatchNoticesResponse, NoticeInboxResponse, SessionWithOrder } from '@qc/shared/api'
import type { Notice, NoticeAcknowledgement, NoticeAdminRow, NoticeFile, ProductionOrder } from '@qc/shared/types'
import { TestApp, type Session } from './harness'

const app = new TestApp()
let admin: Session
let inspector: Session
let supervisor: Session
let weldOrder: ProductionOrder
let paintOrder: ProductionOrder
let weldSession: SessionWithOrder
let notice: Notice

const today = new Date().toISOString().slice(0, 10)

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  admin = await app.register('admin', 'Admin')
  inspector = await app.register('insp', 'Inspector One')
  await app.api('POST', '/api/users', { token: admin.token, body: { username: 'sup', password: 'Password#1', name: 'Super', role: 'supervisor' } })
  supervisor = await app.login('sup')
  await app.api('POST', '/api/master/machines', { token: admin.token, body: { code: '58', name: 'A. Welding Line', line: 'LM4', displayName: '58-A. Welding Line-LM4', process: 'welding', factory: 'Factory 1' } })
  await app.api('POST', '/api/master/machines', { token: admin.token, body: { code: '48', name: 'Painting Line', line: 'LM4', displayName: '48-Painting Line-LM4', process: 'paint', factory: 'Factory 2' } })
  await app.api('POST', '/api/orders/import', {
    token: admin.token,
    body: {
      rows: [
        { lineKey: 'L-1', orderNumber: '20095-QC1-HYH', item: 'XL Light Beam', itemCode: '125185TA3', workCenterCode: '58', requiredQty: 2500, finishedQty: 2000, customer: 'Beta Storage', expectedGrade: 'S355JR', drawing: 'BS9059/58' },
        { lineKey: 'L-2', orderNumber: '20480-Ph1.4-SMA', item: 'Shuttle Beam', itemCode: 'LB406015-5TA3', workCenterCode: '48', requiredQty: 1350, finishedQty: 900, customer: 'Alpha Racking', expectedGrade: 'ST52-3', drawing: 'BS9059/48' },
      ],
    },
  })
  const orders = (await app.api<ProductionOrder[]>('GET', '/api/orders', { token: admin.token })).body
  weldOrder = orders.find((o) => o.lineKey === 'L-1')!
  paintOrder = orders.find((o) => o.lineKey === 'L-2')!
  weldSession = (await app.api<SessionWithOrder>('POST', '/api/sessions', { token: inspector.token, body: { orderId: weldOrder.id, startQty: 500 } })).body
})
afterAll(() => app.stop())

describe('notices', () => {
  it('only an administrator writes', async () => {
    const res = await app.api('POST', '/api/notices', { token: inspector.token, body: { title: 'x', severity: 'info', validFrom: today } })
    expect(res.status).toBe(403)
    expect((await app.api('GET', '/api/notices/admin', { token: supervisor.token })).status).toBe(403)
  })

  it('refuses a validity that ends before it starts and a bad target', async () => {
    const res = await app.api<ApiErrorBody>('POST', '/api/notices', { token: admin.token, body: { title: 'x', severity: 'info', validFrom: '2026-09-10', validTo: '2026-09-01' } })
    expect(res.status).toBe(400)
    const bad = await app.api<ApiErrorBody>('POST', '/api/notices', { token: admin.token, body: { title: 'x', severity: 'info', validFrom: today, targets: [{ kind: 'role', value: 'boss' }] } })
    expect(bad.status).toBe(400)
  })

  it('creates a notice for inspectors on machine 58', async () => {
    const res = await app.api<Notice>('POST', '/api/notices', {
      token: admin.token,
      body: {
        title: 'Check the weld start on every beam',
        body: 'Customer complaint on the last batch.',
        severity: 'warning',
        requiresAck: true,
        validFrom: today,
        validTo: null,
        targets: [
          { kind: 'machine', value: '58', label: '58-A. Welding Line-LM4' },
          { kind: 'role', value: 'inspector', label: 'Inspector' },
        ],
        imageIds: [],
        fileIds: [],
      },
    })
    expect(res.status).toBe(201)
    notice = res.body
    expect(notice.targets).toHaveLength(2)
    expect(notice.createdByName).toBe('Admin')
    expect(notice.validTo).toBeNull()
  })

  it('is pending for the inspector on that machine, not elsewhere, not for a supervisor', async () => {
    const here = await app.api<MatchNoticesResponse>('POST', '/api/notices/match', { token: inspector.token, body: { sessionId: weldSession.id } })
    expect(here.status).toBe(200)
    expect(here.body.notices.map((n) => n.id)).toEqual([notice.id])
    expect(here.body.notices[0].pending).toBe(true)
    const before = await app.api<MatchNoticesResponse>('POST', '/api/notices/match', { token: inspector.token, body: { workCenterCode: '58', orderId: weldOrder.id } })
    expect(before.body.notices).toHaveLength(1)
    const elsewhere = await app.api<MatchNoticesResponse>('POST', '/api/notices/match', { token: inspector.token, body: { workCenterCode: '48', orderId: paintOrder.id } })
    expect(elsewhere.body.notices).toHaveLength(0)
    const sup = await app.api<MatchNoticesResponse>('POST', '/api/notices/match', { token: supervisor.token, body: { sessionId: weldSession.id } })
    expect(sup.body.notices).toHaveLength(0)
  })

  it('stays out of the bell until met at the machine; acknowledging then files it', async () => {
    // Aimed at a place: nobody's bell lists it before they meet it there — not even the administrator's.
    const inbox = await app.api<NoticeInboxResponse>('GET', '/api/notices/inbox', { token: inspector.token })
    expect(inbox.body.pendingCount).toBe(0)
    expect(inbox.body.notices).toHaveLength(0)
    expect((await app.api<NoticeInboxResponse>('GET', '/api/notices/inbox', { token: admin.token })).body.notices).toHaveLength(0)
    // Seeing it (the gate opened) lists it, but is not enough when acknowledgement is required.
    expect((await app.api('POST', `/api/notices/${notice.id}/seen`, { token: inspector.token })).status).toBe(204)
    const seen = await app.api<NoticeInboxResponse>('GET', '/api/notices/inbox', { token: inspector.token })
    expect(seen.body.pendingCount).toBe(1)
    expect(seen.body.notices[0].active).toBe(true)
    const ack = await app.api('POST', `/api/notices/${notice.id}/acknowledge`, { token: inspector.token, body: { context: { sessionId: weldSession.id, workCenterCode: '58' } } })
    expect(ack.status).toBe(204)
    const after = await app.api<NoticeInboxResponse>('GET', '/api/notices/inbox', { token: inspector.token })
    expect(after.body.pendingCount).toBe(0)
    expect(after.body.notices[0].acknowledgedAt).not.toBeNull()
    // Once per reader: it no longer comes up at the machine.
    const again = await app.api<MatchNoticesResponse>('POST', '/api/notices/match', { token: inspector.token, body: { sessionId: weldSession.id } })
    expect(again.body.notices).toHaveLength(0)
    // The supervisor's bell does not list a notice aimed at inspectors.
    expect((await app.api<NoticeInboxResponse>('GET', '/api/notices/inbox', { token: supervisor.token })).body.notices).toHaveLength(0)
  })

  it('lets the administrator see who acknowledged', async () => {
    const rows = await app.api<NoticeAcknowledgement[]>('GET', `/api/notices/${notice.id}/acknowledgements`, { token: admin.token })
    expect(rows.status).toBe(200)
    expect(rows.body).toHaveLength(1)
    expect(rows.body[0].userName).toBe('Inspector One')
    expect(rows.body[0].acknowledgedAt).not.toBeNull()
    expect(rows.body[0].context?.workCenterCode).toBe('58')
    const list = await app.api<NoticeAdminRow[]>('GET', '/api/notices/admin', { token: admin.token })
    expect(list.body[0].acknowledgedCount).toBe(1)
    expect(list.body[0].seenCount).toBe(1)
  })

  it('a notice for everyone needs no acknowledgement and is done once seen', async () => {
    const created = await app.api<Notice>('POST', '/api/notices', {
      token: admin.token,
      body: { title: 'Canteen closed Thursday', severity: 'info', requiresAck: false, validFrom: today, validTo: today },
    })
    expect(created.status).toBe(201)
    const sup = await app.api<NoticeInboxResponse>('GET', '/api/notices/inbox', { token: supervisor.token })
    expect(sup.body.pendingCount).toBe(1)
    await app.api('POST', `/api/notices/${created.body.id}/seen`, { token: supervisor.token })
    expect((await app.api<NoticeInboxResponse>('GET', '/api/notices/inbox', { token: supervisor.token })).body.pendingCount).toBe(0)
    // Withdrawn: gone from the pending list, still in the archive.
    const withdrawn = await app.api<Notice>('POST', `/api/notices/${created.body.id}/withdraw`, { token: admin.token })
    expect(withdrawn.status).toBe(200)
    expect(withdrawn.body.withdrawnByName).toBe('Admin')
    const insp = await app.api<NoticeInboxResponse>('GET', '/api/notices/inbox', { token: inspector.token })
    expect(insp.body.pendingCount).toBe(0)
    expect(insp.body.notices.find((n) => n.id === created.body.id)?.active).toBe(false)
  })

  it('under "any", one target of any kind is enough', async () => {
    // Machine 48 OR the supervisor role: the supervisor gets it anywhere, the inspector only on machine 48.
    const res = await app.api<Notice>('POST', '/api/notices', {
      token: admin.token,
      body: {
        title: 'Paint booth 2 is down',
        severity: 'info',
        requiresAck: false,
        matchMode: 'any',
        validFrom: today,
        validTo: null,
        targets: [
          { kind: 'machine', value: '48', label: '48-Painting Line-LM4' },
          { kind: 'role', value: 'supervisor', label: 'Supervisor' },
        ],
        imageIds: [],
        fileIds: [],
      },
    })
    expect(res.status).toBe(201)
    expect(res.body.matchMode).toBe('any')
    const any = res.body
    const supAtWeld = await app.api<MatchNoticesResponse>('POST', '/api/notices/match', { token: supervisor.token, body: { workCenterCode: '58', orderId: weldOrder.id } })
    expect(supAtWeld.body.notices.map((n) => n.id)).toContain(any.id)
    const inspAtPaint = await app.api<MatchNoticesResponse>('POST', '/api/notices/match', { token: inspector.token, body: { workCenterCode: '48', orderId: paintOrder.id } })
    expect(inspAtPaint.body.notices.map((n) => n.id)).toContain(any.id)
    const inspAtWeld = await app.api<MatchNoticesResponse>('POST', '/api/notices/match', { token: inspector.token, body: { workCenterCode: '58', orderId: weldOrder.id } })
    expect(inspAtWeld.body.notices.map((n) => n.id)).not.toContain(any.id)
    // The supervisor is named, so their bell lists it at once; the inspector's waits for machine 48.
    expect((await app.api<NoticeInboxResponse>('GET', '/api/notices/inbox', { token: supervisor.token })).body.notices.map((n) => n.id)).toContain(any.id)
    expect((await app.api<NoticeInboxResponse>('GET', '/api/notices/inbox', { token: inspector.token })).body.notices.map((n) => n.id)).not.toContain(any.id)
    // Switched to "all", the supervisor must be on machine 48 too.
    const put = await app.api<Notice>('PUT', `/api/notices/${any.id}`, { token: admin.token, body: { ...any, matchMode: 'all', fileIds: [] } })
    expect(put.status).toBe(200)
    expect(put.body.matchMode).toBe('all')
    const supAtWeldAll = await app.api<MatchNoticesResponse>('POST', '/api/notices/match', { token: supervisor.token, body: { workCenterCode: '58', orderId: weldOrder.id } })
    expect(supAtWeldAll.body.notices.map((n) => n.id)).not.toContain(any.id)
    await app.api('POST', `/api/notices/${any.id}/withdraw`, { token: admin.token })
  })

  it('carries a PDF and refuses other files', async () => {
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n')
    const form = new FormData()
    form.set('file', new Blob([pdf], { type: 'application/pdf' }), 'method.pdf')
    const up = await app.api<NoticeFile>('POST', '/api/notices/files', { token: admin.token, raw: form })
    expect(up.status).toBe(201)
    expect(up.body.mimeType).toBe('application/pdf')
    const wrong = new FormData()
    wrong.set('file', new Blob([Buffer.from('hello')], { type: 'text/plain' }), 'notes.txt')
    expect((await app.api('POST', '/api/notices/files', { token: admin.token, raw: wrong })).status).toBe(400)
    const updated = await app.api<Notice>('PUT', `/api/notices/${notice.id}`, {
      token: admin.token,
      body: { ...notice, fileIds: [up.body.id], imageIds: [], validTo: null },
    })
    expect(updated.status).toBe(200)
    expect(updated.body.files.map((f) => f.id)).toEqual([up.body.id])
    const content = await app.api('GET', `/api/notices/files/${up.body.id}/content`, { token: inspector.token })
    expect(content.status).toBe(200)
    expect(content.headers.get('content-type')).toBe('application/pdf')
  })

  it('is removed by an administrator and disappears everywhere', async () => {
    expect((await app.api('DELETE', `/api/notices/${notice.id}`, { token: admin.token })).status).toBe(204)
    expect((await app.api<NoticeInboxResponse>('GET', '/api/notices/inbox', { token: inspector.token })).body.notices.find((n) => n.id === notice.id)).toBeUndefined()
    const list = await app.api<NoticeAdminRow[]>('GET', '/api/notices/admin', { token: admin.token })
    expect(list.body.find((n) => n.id === notice.id)).toBeUndefined()
  })
})
