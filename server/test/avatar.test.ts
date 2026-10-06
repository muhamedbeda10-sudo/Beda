import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import type { AvatarResponse, AvatarsResponse } from '@qc/shared/api'
import { TestApp, tinyJpeg, type Session } from './harness'

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

const jpegUrl = (seed = 1) => `data:image/jpeg;base64,${tinyJpeg(seed).toString('base64')}`

describe('the profile photo', () => {
  it('starts empty, so the circle shows the initials', async () => {
    const res = await app.api<AvatarResponse>('GET', '/api/auth/me/avatar', { token: admin.token })
    expect(res.status).toBe(200)
    expect(res.body.dataUrl).toBeNull()
  })

  it('is set, replaced and removed by its owner — a viewer too', async () => {
    for (const who of [admin, viewer]) {
      expect((await app.api('PUT', '/api/auth/me/avatar', { token: who.token, body: { dataUrl: jpegUrl(1) } })).status).toBe(200)
      expect((await app.api('PUT', '/api/auth/me/avatar', { token: who.token, body: { dataUrl: jpegUrl(2) } })).status).toBe(200)
      expect((await app.api<AvatarResponse>('GET', '/api/auth/me/avatar', { token: who.token })).body.dataUrl).toBe(jpegUrl(2))
    }
    expect((await app.api('DELETE', '/api/auth/me/avatar', { token: viewer.token })).status).toBe(204)
    expect((await app.api<AvatarResponse>('GET', '/api/auth/me/avatar', { token: viewer.token })).body.dataUrl).toBeNull()
    // One person's removal leaves the other's photo alone.
    expect((await app.api<AvatarResponse>('GET', '/api/auth/me/avatar', { token: admin.token })).body.dataUrl).toBe(jpegUrl(2))
  })

  it('refuses anything that is not a JPEG, or is too large, and anyone signed out', async () => {
    const png = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')}`
    const lying = `data:image/jpeg;base64,${Buffer.from('not a picture at all').toString('base64')}`
    const huge = `data:image/jpeg;base64,${'A'.repeat(70 * 1024)}`
    for (const dataUrl of [png, lying, huge, 'data:image/jpeg;base64,']) {
      expect((await app.api('PUT', '/api/auth/me/avatar', { token: admin.token, body: { dataUrl } })).status, dataUrl.slice(0, 30)).toBe(400)
    }
    expect((await app.api('GET', '/api/auth/me/avatar')).status).toBe(401)
    expect((await app.api('PUT', '/api/auth/me/avatar', { body: { dataUrl: jpegUrl(3) } })).status).toBe(401)
  })

  it('gives the chat the small copies of colleagues who have a photo, and nothing for the rest', async () => {
    await app.api('PUT', '/api/auth/me/avatar', { token: admin.token, body: { dataUrl: jpegUrl(4), thumbDataUrl: jpegUrl(5) } })
    const res = await app.api<AvatarsResponse>('GET', `/api/auth/avatars?ids=${admin.user.id},${viewer.user.id}`, { token: viewer.token })
    expect(res.status).toBe(200)
    expect(res.body.avatars).toEqual({ [admin.user.id]: jpegUrl(5) })
    // A photo set without a small copy is sent whole.
    await app.api('PUT', '/api/auth/me/avatar', { token: viewer.token, body: { dataUrl: jpegUrl(6) } })
    const both = await app.api<AvatarsResponse>('GET', `/api/auth/avatars?ids=${admin.user.id},${viewer.user.id}`, { token: admin.token })
    expect(both.body.avatars[viewer.user.id]).toBe(jpegUrl(6))
    expect((await app.api('GET', '/api/auth/avatars?ids=nope', { token: admin.token })).status).toBe(400)
    expect((await app.api('GET', `/api/auth/avatars?ids=${admin.user.id}`)).status).toBe(401)
    const fake = `data:image/jpeg;base64,${Buffer.from('not a picture at all').toString('base64')}`
    expect((await app.api('PUT', '/api/auth/me/avatar', { token: admin.token, body: { dataUrl: jpegUrl(1), thumbDataUrl: fake } })).status).toBe(400)
  })
})
