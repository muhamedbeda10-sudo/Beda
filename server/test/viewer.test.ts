import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { HistoryResponse, OpenSessionsResponse } from '@qc/shared/api'
import { TestApp, type Session } from './harness'

const app = new TestApp()
let admin: Session
let viewer: Session

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  admin = await app.register('admin', 'Admin')
  await app.api('POST', '/api/users', { token: admin.token, body: { username: 'watcher', password: 'Password#1', name: 'Plant Manager', role: 'viewer' } })
  viewer = await app.login('watcher')
})
afterAll(() => app.stop())

describe('§14 — the viewer role', () => {
  it('signs in as a viewer and reads the board, History and the dashboard', async () => {
    expect(viewer.user.role).toBe('viewer')
    const board = await app.api<OpenSessionsResponse>('GET', '/api/sessions/open', { token: viewer.token })
    expect(board.status).toBe(200)
    const history = await app.api<HistoryResponse>('GET', '/api/sessions/history', { token: viewer.token })
    expect(history.status).toBe(200)
    expect((await app.api('GET', '/api/kpi/span', { token: viewer.token })).status).toBe(200)
    expect((await app.api('GET', '/api/master/machines', { token: viewer.token })).status).toBe(200)
  })

  it('is refused every write and every door that is not theirs', async () => {
    const refused: [string, string, unknown?][] = [
      ['POST', '/api/sessions', { orderId: randomUUID(), startQty: 0 }],
      ['POST', '/api/sessions/start-with-sample', {}],
      ['POST', `/api/sessions/${randomUUID()}/close`, {}],
      ['POST', `/api/sessions/${randomUUID()}/reopen`, {}],
      ['DELETE', `/api/sessions/${randomUUID()}`],
      ['PATCH', `/api/sessions/${randomUUID()}/quantities`, { finalQty: 1 }],
      ['DELETE', `/api/samples/${randomUUID()}`],
      ['POST', '/api/pdi', {}],
      ['POST', '/api/master/machines', { code: '9', name: 'x' }],
      ['POST', '/api/orders/import', {}],
      ['POST', '/api/production-records/import', {}],
      ['GET', '/api/production-records/summary'],
      ['PUT', '/api/kpi/thresholds', {}],
      ['GET', '/api/users'],
      ['GET', '/api/audit'],
      ['GET', '/api/releases/state'],
      ['GET', '/api/chat/conversations'],
      ['GET', '/api/chat/unread'],
      ['POST', '/api/chat/conversations', { kind: 'direct', userId: admin.user.id }],
      ['GET', '/api/notices/inbox'],
      ['POST', '/api/notices/match', { workCenterCode: '58' }],
      ['GET', '/api/notices/admin'],
    ]
    for (const [method, path, body] of refused) {
      const res = await app.api(method as 'GET', path, { token: viewer.token, body })
      expect(res.status, `${method} ${path}`).toBe(403)
    }
  })

  it('does not appear in the chat directory, and an administrator can make one', async () => {
    const users = await app.api<{ username: string }[]>('GET', '/api/chat/users', { token: admin.token })
    expect(users.body.map((u) => u.username)).not.toContain('watcher')
    expect((await app.api('POST', '/api/users', { token: admin.token, body: { username: 'w2', password: 'Password#1', name: 'Second', role: 'viewer' } })).status).toBe(201)
  })
})
