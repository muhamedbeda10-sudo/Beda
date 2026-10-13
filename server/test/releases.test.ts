import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import type { ReleaseStateResponse } from '@qc/shared/api'
import { RELEASES } from '@qc/shared/releases'
import { TestApp, type Session } from './harness'

const app = new TestApp()
let admin: Session
let insp: Session

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  admin = await app.register('admin', 'Admin')
  insp = await app.register('insp', 'Inspector One')
})
afterAll(() => app.stop())

describe('§18 — what\'s new', () => {
  it('is for administrators', async () => {
    expect((await app.api('GET', '/api/releases/state', { token: insp.token })).status).toBe(403)
    expect((await app.api('POST', '/api/releases/seen', { token: insp.token, body: { releaseId: RELEASES[0].id } })).status).toBe(403)
  })

  it('starts unread, moves forward only, and refuses an unknown id', async () => {
    const start = await app.api<ReleaseStateResponse>('GET', '/api/releases/state', { token: admin.token })
    expect(start.status).toBe(200)
    expect(start.body.lastSeenReleaseId).toBeNull()
    expect((await app.api('POST', '/api/releases/seen', { token: admin.token, body: { releaseId: '2099-01-01.1' } })).status).toBe(400)
    const newest = RELEASES[0].id
    const seen = await app.api<ReleaseStateResponse>('POST', '/api/releases/seen', { token: admin.token, body: { releaseId: newest } })
    expect(seen.body.lastSeenReleaseId).toBe(newest)
    // An older note dismissed later does not move the mark back.
    const oldest = RELEASES[RELEASES.length - 1].id
    const again = await app.api<ReleaseStateResponse>('POST', '/api/releases/seen', { token: admin.token, body: { releaseId: oldest } })
    expect(again.body.lastSeenReleaseId).toBe(newest)
    expect((await app.api<ReleaseStateResponse>('GET', '/api/releases/state', { token: admin.token })).body.lastSeenReleaseId).toBe(newest)
  })

  it('moves forward through the newest releases, and never back', async () => {
    const [newest, middle, oldest] = RELEASES.slice(0, 3).map((r) => r.id)
    const made = await app.api('POST', '/api/users', { token: admin.token, body: { username: 'admin2', password: 'Password#1', name: 'Second Admin', role: 'admin' } })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    const other = await app.login('admin2')
    const mark = async (releaseId: string) => (await app.api<ReleaseStateResponse>('POST', '/api/releases/seen', { token: other.token, body: { releaseId } })).body.lastSeenReleaseId
    expect(await mark(oldest)).toBe(oldest)
    expect(await mark(newest)).toBe(newest)
    expect(await mark(middle)).toBe(newest)
  })
})
