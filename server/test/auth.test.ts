import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import type { ApiErrorBody, AuthConfigResponse, AuthResponse } from '@qc/shared/api'
import type { UserProfile } from '@qc/shared/types'
import { TestApp, cookieOf } from './harness'

const app = new TestApp()

beforeAll(async () => {
  // No ADMIN+ here: the administrators' own rules (ADMIN+ has its own tests, in ai.owner and permissions).
  await app.start({ AI_OWNER_USERNAME: 'nobody.here' })
  await app.resetDatabase()
})
afterAll(() => app.stop())

describe('registration and roles', () => {
  it('reports self-registration open while there are no users', async () => {
    const res = await app.api<AuthConfigResponse>('GET', '/api/auth/config')
    expect(res.status).toBe(200)
    expect(res.body.selfRegistrationOpen).toBe(true)
  })

  it('makes the first account the admin and every later one an inspector', async () => {
    const first = await app.register('admin', 'First Admin')
    expect(first.user.role).toBe('admin')
    expect(first.cookie).toMatch(/^qc_refresh=/)
    const second = await app.register('insp', 'Second User')
    expect(second.user.role).toBe('inspector')
  })

  it('normalises the username and rejects a duplicate', async () => {
    const res = await app.api<ApiErrorBody>('POST', '/api/auth/register', {
      body: { username: '  Admin ', password: 'Password#1', name: 'Dup' },
    })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('duplicate')
  })

  it('rejects a short password with a field-level message', async () => {
    const res = await app.api<ApiErrorBody>('POST', '/api/auth/register', {
      body: { username: 'x1', password: 'short', name: 'X' },
    })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('validation')
    expect(res.body.error.message).toMatch(/at least 8/)
  })
})

describe('sign in, refresh, sign out', () => {
  it('rejects a wrong password without revealing whether the username exists', async () => {
    const wrong = await app.api<ApiErrorBody>('POST', '/api/auth/login', { body: { username: 'admin', password: 'nope-nope' } })
    const unknown = await app.api<ApiErrorBody>('POST', '/api/auth/login', { body: { username: 'ghost', password: 'nope-nope' } })
    expect(wrong.status).toBe(401)
    expect(unknown.status).toBe(401)
    expect(wrong.body.error.message).toBe(unknown.body.error.message)
  })

  it('signs in, answers /me, and rotates the refresh cookie', async () => {
    const s = await app.login('admin')
    const me = await app.api<UserProfile>('GET', '/api/auth/me', { token: s.token })
    expect(me.status).toBe(200)
    expect(me.body.username).toBe('admin')
    expect(me.body.role).toBe('admin')

    const refreshed = await app.api<AuthResponse>('POST', '/api/auth/refresh', { cookie: s.cookie })
    expect(refreshed.status).toBe(200)
    expect(refreshed.body.accessToken).toBeTruthy()
    const rotated = cookieOf(refreshed.cookies)
    expect(rotated).not.toBe(s.cookie)

    // The old refresh token is spent.
    const replay = await app.api<ApiErrorBody>('POST', '/api/auth/refresh', { cookie: s.cookie })
    expect(replay.status).toBe(401)
    // The new one works.
    const again = await app.api<AuthResponse>('POST', '/api/auth/refresh', { cookie: rotated })
    expect(again.status).toBe(200)
  })

  it('revokes the device on logout so its access token stops working', async () => {
    const s = await app.login('insp')
    expect((await app.api('GET', '/api/auth/me', { token: s.token })).status).toBe(200)
    const out = await app.api('POST', '/api/auth/logout', { cookie: s.cookie })
    expect(out.status).toBe(204)
    expect((await app.api('GET', '/api/auth/me', { token: s.token })).status).toBe(401)
    expect((await app.api('POST', '/api/auth/refresh', { cookie: s.cookie })).status).toBe(401)
  })

  it('answers 401 without a token and for a forged one', async () => {
    expect((await app.api('GET', '/api/sessions/open')).status).toBe(401)
    expect((await app.api('GET', '/api/sessions/open', { token: 'abc.def.ghi' })).status).toBe(401)
  })

  it('rate-limits repeated failed sign-ins per username', async () => {
    let last = 0
    for (let i = 0; i < 12; i++) {
      last = (await app.api('POST', '/api/auth/login', { body: { username: 'limited', password: 'wrong-wrong' } })).status
    }
    expect(last).toBe(429)
  })

  it('lets a user change their own password and signs out other devices', async () => {
    const a = await app.login('admin')
    const b = await app.login('admin')
    const res = await app.api('POST', '/api/auth/change-password', {
      token: a.token,
      body: { currentPassword: 'Password#1', newPassword: 'NewPassword#2' },
    })
    expect(res.status).toBe(204)
    expect((await app.api('GET', '/api/auth/me', { token: a.token })).status).toBe(200)
    expect((await app.api('GET', '/api/auth/me', { token: b.token })).status).toBe(401)
    expect((await app.api('POST', '/api/auth/login', { body: { username: 'admin', password: 'Password#1' } })).status).toBe(401)
    await app.login('admin', 'NewPassword#2')
  })
})

describe('user administration', () => {
  it('lets an admin create, promote and deactivate accounts, but not lock itself out', async () => {
    const admin = await app.login('admin', 'NewPassword#2')
    const inspector = await app.login('insp')

    expect((await app.api('GET', '/api/users', { token: inspector.token })).status).toBe(403)

    const created = await app.api<UserProfile>('POST', '/api/users', {
      token: admin.token,
      body: { username: 'sup', password: 'Password#1', name: 'Super Visor', role: 'supervisor' },
    })
    expect(created.status).toBe(201)
    expect(created.body.role).toBe('supervisor')

    const promoted = await app.api<UserProfile>('PATCH', `/api/users/${inspector.user.id}`, { token: admin.token, body: { role: 'supervisor' } })
    expect(promoted.status).toBe(200)
    expect(promoted.body.role).toBe('supervisor')
    // The role change is visible on the very next request, not after token expiry.
    const me = await app.api<UserProfile>('GET', '/api/auth/me', { token: inspector.token })
    expect(me.body.role).toBe('supervisor')

    const selfDemote = await app.api<ApiErrorBody>('PATCH', `/api/users/${admin.user.id}`, { token: admin.token, body: { role: 'inspector' } })
    expect(selfDemote.status).toBe(400)

    const deactivated = await app.api<UserProfile>('PATCH', `/api/users/${inspector.user.id}`, { token: admin.token, body: { isActive: false } })
    expect(deactivated.body.isActive).toBe(false)
    expect((await app.api('GET', '/api/auth/me', { token: inspector.token })).status).toBe(401)
    expect((await app.api('POST', '/api/auth/login', { body: { username: 'insp', password: 'Password#1' } })).status).toBe(401)

    const list = await app.api<UserProfile[]>('GET', '/api/users', { token: admin.token })
    expect(list.body.map((u) => u.username).sort()).toEqual(['admin', 'insp', 'sup'])
  })

  it('lets an admin rename a login, refusing one that is taken', async () => {
    const admin = await app.login('admin', 'NewPassword#2')
    const list = await app.api<UserProfile[]>('GET', '/api/users', { token: admin.token })
    const sup = list.body.find((u) => u.username === 'sup')!
    const taken = await app.api<ApiErrorBody>('PATCH', `/api/users/${sup.id}`, { token: admin.token, body: { username: 'insp' } })
    expect(taken.status).toBe(409)
    const bad = await app.api<ApiErrorBody>('PATCH', `/api/users/${sup.id}`, { token: admin.token, body: { username: 'no spaces' } })
    expect(bad.status).toBe(400)
    const renamed = await app.api<UserProfile>('PATCH', `/api/users/${sup.id}`, { token: admin.token, body: { username: ' Super.Visor ' } })
    expect(renamed.status).toBe(200)
    expect(renamed.body.username).toBe('super.visor')
    expect((await app.api('POST', '/api/auth/login', { body: { username: 'sup', password: 'Password#1' } })).status).toBe(401)
    await app.login('super.visor')
    // Back to the old name so the tests that follow still find it.
    await app.api('PATCH', `/api/users/${sup.id}`, { token: admin.token, body: { username: 'sup' } })
  })

  it('removes an account: it leaves the list, cannot sign in, and frees its username', async () => {
    const admin = await app.login('admin', 'NewPassword#2')
    const sup = await app.login('sup')
    const list = await app.api<UserProfile[]>('GET', '/api/users', { token: admin.token })
    const supId = list.body.find((u) => u.username === 'sup')!.id

    // Not yourself, and only an administrator.
    expect((await app.api('DELETE', `/api/users/${admin.user.id}`, { token: admin.token })).status).toBe(400)
    expect((await app.api('DELETE', `/api/users/${supId}`, { token: sup.token })).status).toBe(403)
    expect((await app.api('DELETE', '/api/users/not-a-uuid', { token: admin.token })).status).toBe(400)

    expect((await app.api('DELETE', `/api/users/${supId}`, { token: admin.token })).status).toBe(204)
    expect((await app.api('GET', '/api/auth/me', { token: sup.token })).status).toBe(401)
    expect((await app.api('POST', '/api/auth/refresh', { cookie: sup.cookie })).status).toBe(401)
    expect((await app.api('POST', '/api/auth/login', { body: { username: 'sup', password: 'Password#1' } })).status).toBe(401)
    expect((await app.api('DELETE', `/api/users/${supId}`, { token: admin.token })).status).toBe(404)
    const after = await app.api<UserProfile[]>('GET', '/api/users', { token: admin.token })
    expect(after.body.map((u) => u.username).sort()).toEqual(['admin', 'insp'])

    // The username can be given to someone else; the old row is a different person.
    const again = await app.api<UserProfile>('POST', '/api/users', {
      token: admin.token,
      body: { username: 'sup', password: 'Password#1', name: 'New Super', role: 'inspector' },
    })
    expect(again.status).toBe(201)
    expect(again.body.id).not.toBe(supId)
  })

  it('refuses to remove the last active administrator', async () => {
    const admin = await app.login('admin', 'NewPassword#2')
    const list = await app.api<UserProfile[]>('GET', '/api/users', { token: admin.token })
    const insp = list.body.find((u) => u.username === 'insp')!
    // Make the inspector an admin, then try to remove the original admin from that account.
    await app.api('PATCH', `/api/users/${insp.id}`, { token: admin.token, body: { role: 'admin', isActive: true } })
    const second = await app.login('insp')
    expect((await app.api('DELETE', `/api/users/${admin.user.id}`, { token: second.token })).status).toBe(204)
    // Now `insp` is the only admin: nobody may remove or demote it.
    const third = await app.api<UserProfile>('POST', '/api/users', {
      token: second.token,
      body: { username: 'other.admin', password: 'Password#1', name: 'Other', role: 'inspector' },
    })
    expect(third.status).toBe(201)
    const selfRemove = await app.api<ApiErrorBody>('DELETE', `/api/users/${insp.id}`, { token: second.token })
    expect(selfRemove.status).toBe(400)
  })
})

describe('closed self-registration', () => {
  it('still allows the first account, then refuses the second', async () => {
    const closed = new TestApp()
    await closed.start({ AUTH_ALLOW_SELF_REGISTRATION: 'false' })
    try {
      await closed.resetDatabase()
      const cfg = await closed.api<AuthConfigResponse>('GET', '/api/auth/config')
      expect(cfg.body.selfRegistrationOpen).toBe(true)
      const first = await closed.register('boss', 'Boss')
      expect(first.user.role).toBe('admin')
      const cfg2 = await closed.api<AuthConfigResponse>('GET', '/api/auth/config')
      expect(cfg2.body.selfRegistrationOpen).toBe(false)
      const second = await closed.api<ApiErrorBody>('POST', '/api/auth/register', {
        body: { username: 'walkin', password: 'Password#1', name: 'Walk In' },
      })
      expect(second.status).toBe(403)
    } finally {
      await closed.stop()
    }
  })
})
