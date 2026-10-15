import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import type { ApiErrorBody } from '@qc/shared/api'
import { DEFAULT_ROLE_PERMISSIONS, PERMISSION_IDS, type Permission, type RolePermissionsResponse } from '@qc/shared/permissions'
import type { ManagedUser, UserProfile } from '@qc/shared/types'
import { TestApp, type Session } from './harness'

// §14 — permissions: each role's set, changed by administrators; a person's
// own overrides; screens locked on the server, not only hidden; ADMIN+ (the
// AI assistant's owner) above them all; nobody gives what they do not hold.

const app = new TestApp()
/** ADMIN+: the first account, named by AI_OWNER_USERNAME. */
let owner: Session
let admin2: Session
let sup: Session
let insp: Session
let viewer: Session

const me = async (s: Session) => (await app.api<UserProfile>('GET', '/api/auth/me', { token: s.token })).body
const users = async (s: Session = owner) => (await app.api<ManagedUser[]>('GET', '/api/users', { token: s.token })).body
const setOverrides = (by: Session, who: Session, overrides: { permission: Permission; granted: boolean }[]) =>
  app.api<ManagedUser & ApiErrorBody>('PUT', `/api/users/${who.user.id}/permissions`, { token: by.token, body: { overrides } })
const setRole = (by: Session, role: string, permissions: Permission[]) =>
  app.api<RolePermissionsResponse & ApiErrorBody>('PUT', `/api/users/roles/${role}`, { token: by.token, body: { permissions } })
const status = async (s: Session, path: string) => (await app.api('GET', path, { token: s.token })).status

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  owner = await app.register('admin', 'Owner')
  for (const [username, name, role] of [
    ['admin2', 'Second Admin', 'admin'],
    ['sup', 'Super Visor', 'supervisor'],
    ['insp', 'Inspector', 'inspector'],
    ['watch', 'Viewer', 'viewer'],
  ]) {
    expect((await app.api('POST', '/api/users', { token: owner.token, body: { username, password: 'Password#1', name, role } })).status).toBe(201)
  }
  admin2 = await app.login('admin2')
  sup = await app.login('sup')
  insp = await app.login('insp')
  viewer = await app.login('watch')
})
afterAll(() => app.stop())

describe('§14 the permissions as stored', () => {
  it('holds the catalog and each role’s starting set', async () => {
    const ids = (await app.db.query<{ id: string }>(`SELECT id FROM permissions ORDER BY id`)).rows.map((r) => r.id)
    expect(ids).toEqual([...PERMISSION_IDS].sort())
    const roles = await app.api<RolePermissionsResponse>('GET', '/api/users/roles', { token: owner.token })
    expect(roles.status).toBe(200)
    for (const role of ['viewer', 'inspector', 'supervisor', 'admin'] as const) expect(roles.body.roles[role], role).toEqual([...DEFAULT_ROLE_PERMISSIONS[role]])
    expect(roles.body.editable).toEqual(['viewer', 'inspector', 'supervisor', 'admin'])
    // Another administrator changes the other roles' sets, never the administrators'.
    expect((await app.api<RolePermissionsResponse>('GET', '/api/users/roles', { token: admin2.token })).body.editable).toEqual(['viewer', 'inspector', 'supervisor'])
  })

  it('tells each person what they hold, and the owner that they are ADMIN+ with everything', async () => {
    expect(await me(owner)).toMatchObject({ adminPlus: true, permissions: [...PERMISSION_IDS] })
    expect(await me(insp)).toMatchObject({ adminPlus: false, permissions: [...DEFAULT_ROLE_PERMISSIONS.inspector] })
    const login = await app.api<{ user: UserProfile }>('POST', '/api/auth/login', { body: { username: 'watch', password: 'Password#1' } })
    expect(login.body.user.permissions).toEqual([...DEFAULT_ROLE_PERMISSIONS.viewer])
    const listed = await users()
    expect(listed.find((u) => u.username === 'admin')).toMatchObject({ adminPlus: true, overrides: [] })
    expect(listed.find((u) => u.username === 'insp')).toMatchObject({ adminPlus: false, overrides: [] })
  })
})

describe('§14 screens are locked on the server', () => {
  it('refuses a screen’s data to whoever may not open it', async () => {
    // A viewer: no coil search, no chat; MTC and History, yes.
    expect(await status(viewer, '/api/coils?search=1')).toBe(403)
    expect(await status(viewer, '/api/chat/conversations')).toBe(403)
    expect(await status(viewer, '/api/mtc/coils/table')).toBe(200)
    expect(await status(viewer, '/api/sessions/history')).toBe(200)
    // An inspector: no dashboard, no Access, no audit log, no users.
    for (const path of ['/api/kpi/span', '/api/orders/list', '/api/audit', '/api/users', '/api/users/roles', '/api/releases/state']) expect(await status(insp, path), path).toBe(403)
    expect(await status(sup, '/api/audit')).toBe(200)
  })

  it('takes a screen away from one person at once, on the token they hold, and gives one back', async () => {
    const taken = await setOverrides(owner, insp, [
      { permission: 'view-history', granted: false },
      { permission: 'view-mtc', granted: false },
      { permission: 'view-dashboard', granted: true },
    ])
    expect(taken.status).toBe(200)
    expect(taken.body.overrides).toEqual([
      { permission: 'view-history', granted: false },
      { permission: 'view-dashboard', granted: true },
      { permission: 'view-mtc', granted: false },
    ])
    expect(taken.body.permissions).not.toContain('view-history')
    expect(await status(insp, '/api/sessions/history')).toBe(403)
    expect(await status(insp, '/api/pdi')).toBe(403)
    expect(await status(insp, '/api/mtc/mesh-wire/table')).toBe(403)
    // The PT step still reads the welding wire batches: they record inspections.
    expect(await status(insp, '/api/mtc/welding-wire/table')).toBe(200)
    expect(await status(insp, '/api/kpi/span')).toBe(200)
    expect((await me(insp)).permissions).toContain('view-dashboard')

    // An override saying what the role says already is not kept: the person follows their role in it.
    const back = await setOverrides(owner, insp, [
      { permission: 'view-history', granted: true },
      { permission: 'view-mtc', granted: true },
    ])
    expect(back.body.overrides).toEqual([])
    expect(await status(insp, '/api/sessions/history')).toBe(200)
    expect(await status(insp, '/api/kpi/span')).toBe(403)

    // Every change is in the person's audit trail, in words.
    const audit = await app.db.query<{ field: string; oldValue: string; newValue: string }>(
      `SELECT field, old_value AS "oldValue", new_value AS "newValue" FROM audit_log WHERE entity = 'User' AND entity_id = $1 AND field LIKE 'permission:%' ORDER BY id`,
      [insp.user.id],
    )
    expect(audit.rows).toEqual([
      { field: 'permission: History', oldValue: 'as the role', newValue: 'taken away' },
      { field: 'permission: Dashboard', oldValue: 'as the role', newValue: 'given' },
      { field: 'permission: MTC', oldValue: 'as the role', newValue: 'taken away' },
      { field: 'permission: History', oldValue: 'taken away', newValue: 'as the role' },
      { field: 'permission: Dashboard', oldValue: 'given', newValue: 'as the role' },
      { field: 'permission: MTC', oldValue: 'taken away', newValue: 'as the role' },
    ])
  })

  it('picks the people who hear the chat and receive notices by what they hold, overrides included', async () => {
    const chat = async () => (await app.api<{ username: string }[]>('GET', '/api/chat/users', { token: insp.token })).body.map((u) => u.username)
    expect(await chat()).not.toContain('watch')
    await setOverrides(owner, viewer, [{ permission: 'use-chat', granted: true }])
    expect(await chat()).toContain('watch')
    expect(await status(viewer, '/api/chat/conversations')).toBe(200)
    const has = async (p: Permission) => (await app.db.query<{ has: boolean }>(`SELECT user_has_permission($1, $2) AS has`, [viewer.user.id, p])).rows[0].has
    expect(await has('use-chat')).toBe(true)
    expect(await has('read-notices')).toBe(false)
    await setOverrides(owner, viewer, [])
    expect(await chat()).not.toContain('watch')
  })
})

describe('§14 a role’s set', () => {
  it('changes for everyone of the role at once, and is audited', async () => {
    const before = [...DEFAULT_ROLE_PERMISSIONS.supervisor]
    expect(await status(sup, '/api/kpi/span')).toBe(403)
    const res = await setRole(admin2, 'supervisor', [...before, 'view-dashboard'])
    expect(res.status).toBe(200)
    expect(res.body.roles.supervisor).toContain('view-dashboard')
    expect(await status(sup, '/api/kpi/span')).toBe(200)
    const audit = await app.db.query(
      `SELECT entity_id AS "role", field, old_value AS "oldValue", new_value AS "newValue", user_name AS "by" FROM audit_log WHERE entity = 'RolePermissions'`,
    )
    expect(audit.rows).toEqual([{ role: 'supervisor', field: 'Dashboard', oldValue: 'off', newValue: 'on', by: 'Second Admin' }])
    expect((await setRole(admin2, 'supervisor', before)).status).toBe(200)
    expect(await status(sup, '/api/kpi/span')).toBe(403)
  })

  it('leaves the administrators’ set to ADMIN+, and takes only known permissions', async () => {
    const refused = await setRole(admin2, 'admin', DEFAULT_ROLE_PERMISSIONS.admin.filter((p) => p !== 'purge-audit-logs'))
    expect(refused.status).toBe(403)
    expect(refused.body.error.message).toBe("The administrators' permissions are changed by ADMIN+ alone.")
    expect((await app.api('PUT', '/api/users/roles/supervisor', { token: owner.token, body: { permissions: ['manage-admin-data'] } })).status).toBe(400)
    expect((await app.api('PUT', '/api/users/roles/superuser', { token: owner.token, body: { permissions: [] } })).status).toBe(400)
    // ADMIN+ may; the administrators lose it at once, ADMIN+ never.
    expect((await setRole(owner, 'admin', DEFAULT_ROLE_PERMISSIONS.admin.filter((p) => p !== 'purge-audit-logs'))).status).toBe(200)
    expect((await me(admin2)).permissions).not.toContain('purge-audit-logs')
    expect((await me(owner)).permissions).toContain('purge-audit-logs')
    expect((await app.api('POST', '/api/audit/purge', { token: admin2.token, body: {} })).status).toBe(403)
    expect((await setRole(owner, 'admin', [...DEFAULT_ROLE_PERMISSIONS.admin])).status).toBe(200)
  })
})

describe('§14 nobody gives what they do not hold', () => {
  it('lets a supervisor given Users manage only those whose permissions they hold, and give only their own', async () => {
    expect((await setOverrides(owner, sup, [{ permission: 'manage-users', granted: true }])).status).toBe(200)
    expect(await status(sup, '/api/users')).toBe(200)
    // An inspector: theirs to change, within what a supervisor holds.
    const given = await setOverrides(sup, insp, [{ permission: 'view-order-sheet', granted: true }])
    expect(given.status, JSON.stringify(given.body)).toBe(200)
    const beyond = await setOverrides(sup, insp, [{ permission: 'delete-session', granted: true }])
    expect(beyond.status).toBe(403)
    expect(beyond.body.error.message).toBe('This would give “Delete sessions”, which you do not hold yourself.')
    // An administrator, ADMIN+, a new administrator, their own role or their own permissions: no.
    expect((await app.api('PATCH', `/api/users/${admin2.user.id}`, { token: sup.token, body: { name: 'X' } })).status).toBe(403)
    expect((await app.api('PATCH', `/api/users/${owner.user.id}`, { token: sup.token, body: { name: 'X' } })).status).toBe(403)
    expect((await app.api('PATCH', `/api/users/${insp.user.id}`, { token: sup.token, body: { role: 'admin' } })).status).toBe(403)
    expect((await app.api('POST', '/api/users', { token: sup.token, body: { username: 'boss', password: 'Password#1', name: 'Boss', role: 'admin' } })).status).toBe(403)
    expect((await setOverrides(sup, sup, [{ permission: 'delete-session', granted: true }])).status).toBe(400)
    expect((await setRole(sup, 'supervisor', [...DEFAULT_ROLE_PERMISSIONS.supervisor, 'manage-users'])).status).toBe(403)
    // A new inspector, yes.
    expect((await app.api('POST', '/api/users', { token: sup.token, body: { username: 'new.insp', password: 'Password#1', name: 'New', role: 'inspector' } })).status).toBe(201)
    await setOverrides(owner, sup, [])
    await setOverrides(owner, insp, [])
    expect(await status(sup, '/api/users')).toBe(403)
  })

  it('drops a removed account’s overrides with it', async () => {
    const created = await app.api<ManagedUser>('POST', '/api/users', { token: owner.token, body: { username: 'temp', password: 'Password#1', name: 'Temp', role: 'viewer' } })
    const temp = await app.login('temp')
    await setOverrides(owner, temp, [{ permission: 'use-chat', granted: true }])
    expect((await app.api('DELETE', `/api/users/${created.body.id}`, { token: owner.token })).status).toBe(204)
    expect((await app.db.query(`SELECT 1 FROM user_permissions WHERE user_id = $1`, [created.body.id])).rowCount).toBe(0)
  })
})
