import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import { AI_DEFAULT_MONTHLY_CAP_USD, AI_MODEL, type AiMeResponse, type AiSettingsResponse } from '@qc/shared/ai'
import type { ApiErrorBody } from '@qc/shared/api'
import { TestApp, type Session } from './harness'
import { aiOwner, currentAiOwner, pinAiOwner } from '../src/ai/owner'

// §20 — the one owner of the assistant: the live, active account named by
// AI_OWNER_USERNAME (any case), pinned once, at start or on first need, and
// never moved through the app afterwards — not by a rename, not by a new
// account taking the name, not by a changed setting.

const app = new TestApp()
let admin: Session

const ownerRow = async () => (await app.db.query<{ userId: string }>(`SELECT user_id AS "userId" FROM ai_owner`)).rows[0]?.userId ?? null
const config = (username: string) => ({ ...app.config, AI_OWNER_USERNAME: username })
const createUser = async (username: string, name: string, role = 'admin') => {
  const res = await app.api<{ id: string }>('POST', '/api/users', { token: admin.token, body: { username, password: 'Password#1', name, role } })
  expect(res.status).toBe(201)
  return res.body.id
}

beforeAll(async () => {
  await app.start({ AI_OWNER_USERNAME: 'Mo.Beda' })
})
afterAll(() => app.stop())

describe('§20 pinning the owner', () => {
  it('pins nobody while no live, active account has the name, then the one that does, whatever its case', async () => {
    await app.resetDatabase()
    // Nobody to pin at start: no account at all.
    expect(await pinAiOwner(app.db, app.config)).toBeNull()
    admin = await app.register('admin', 'Admin')
    expect(await aiOwner(app.db, app.config)).toBeNull()

    // An inactive account of that name is not pinned, nor a removed one.
    const inactive = await createUser('mo.beda', 'Mohamed Beda')
    expect((await app.api('PATCH', `/api/users/${inactive}`, { token: admin.token, body: { isActive: false } })).status).toBe(200)
    expect(await aiOwner(app.db, app.config)).toBeNull()
    expect((await app.api('DELETE', `/api/users/${inactive}`, { token: admin.token })).status).toBe(204)
    expect(await aiOwner(app.db, app.config)).toBeNull()
    expect(await ownerRow()).toBeNull()

    // A live one, named in another case: pinned on first need, by any request.
    const owner = await createUser('mo.beda', 'Mohamed Beda')
    const mo = await app.login('mo.beda')
    const me = await app.api<AiMeResponse>('GET', '/api/ai/me', { token: admin.token })
    expect(me.body).toEqual({ granted: false, owner: false, available: false, reason: 'not-granted', automations: false, excel: false, notices: false, mtc: false })
    expect(await ownerRow()).toBe(owner)
    expect((await app.api<AiMeResponse>('GET', '/api/ai/me', { token: mo.token })).body).toMatchObject({ granted: true, owner: true })
  })

  it('gives the owner their own access when pinned, and records the pin for the owner alone', async () => {
    const owner = (await ownerRow())!
    const access = await app.db.query(
      `SELECT enabled, domains, model, effort, monthly_cap_usd AS cap, updated_by_name AS "by" FROM ai_access WHERE user_id = $1`,
      [owner],
    )
    expect(access.rows).toEqual([
      { enabled: true, domains: ['inspection', 'orders', 'materials', 'audit', 'production'], model: AI_MODEL, effort: 'medium', cap: AI_DEFAULT_MONTHLY_CAP_USD, by: 'Mohamed Beda' },
    ])
    const audit = await app.db.query(`SELECT entity, entity_id AS "entityId", action, field, new_value AS "newValue" FROM audit_log WHERE entity LIKE 'Ai%' ORDER BY id`)
    expect(audit.rows).toEqual([
      { entity: 'AiAssistant', entityId: 'owner', action: 'create', field: 'owner', newValue: 'Mohamed Beda (mo.beda)' },
      {
        entity: 'AiAccess',
        entityId: owner,
        action: 'create',
        field: 'access',
        newValue: 'Mohamed Beda (mo.beda): on; Inspections, Orders and PDI, Coils, suppliers and master data, Audit log and accounts, Production record; Claude Sonnet 5.5; Medium; $50.00 a month',
      },
    ])
  })

  it('never moves: not for a rename, a new account taking the name, or another setting', async () => {
    const owner = (await ownerRow())!
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const mo = await app.login('mo.beda')
      // Renamed: still the owner; the setting no longer matches, which the log says once.
      expect((await app.api('PATCH', `/api/users/${owner}`, { token: admin.token, body: { username: 'beda.m' } })).status).toBe(200)
      expect((await app.api('GET', '/api/ai/settings', { token: mo.token })).status).toBe(200)
      expect((await app.api('GET', '/api/ai/settings', { token: mo.token })).status).toBe(200)
      const warnings = warn.mock.calls.filter((c) => String(c[0]).includes('AI_OWNER_USERNAME'))
      expect(warnings).toHaveLength(1)
      expect(String(warnings[0][0])).toMatch(/stays the account pinned first \(now "beda\.m"\)/)

      // A new account takes the name: it owns nothing.
      await createUser('mo.beda', 'Someone Else')
      const newcomer = await app.login('mo.beda')
      expect((await app.api('GET', '/api/ai/settings', { token: newcomer.token })).status).toBe(404)
      expect((await app.api<AiMeResponse>('GET', '/api/ai/me', { token: newcomer.token })).body).toEqual({
        granted: false,
        owner: false,
        available: false,
        reason: 'not-granted',
        automations: false,
        excel: false,
        notices: false,
        mtc: false,
      })
      // Another setting names another account: still the first.
      expect(await aiOwner(app.db, config('admin'))).toBe(owner)
      expect(await pinAiOwner(app.db, config('admin'))).toBe(owner)
      expect(await ownerRow()).toBe(owner)

      // Nor through the database by mistake: the pin refuses every change.
      await expect(app.db.query(`UPDATE ai_owner SET user_id = $1`, [admin.user.id])).rejects.toThrow(/fixed once pinned/)
      await expect(app.db.query(`DELETE FROM ai_owner`)).rejects.toThrow(/fixed once pinned/)
    } finally {
      warn.mockRestore()
    }
  })

  it('leaves the assistant without an owner while the pinned account is deactivated, and never pins another', async () => {
    const owner = (await ownerRow())!
    expect((await app.api('PATCH', `/api/users/${owner}`, { token: admin.token, body: { isActive: false } })).status).toBe(200)
    try {
      expect(await currentAiOwner(app.db, app.config)).toBeNull()
      expect(await aiOwner(app.db, config('admin'))).toBeNull()
      expect((await app.api('GET', '/api/ai/settings', { token: admin.token })).status).toBe(404)
      expect(await ownerRow()).toBe(owner)
    } finally {
      expect((await app.api('PATCH', `/api/users/${owner}`, { token: admin.token, body: { isActive: true } })).status).toBe(200)
    }
    expect(await currentAiOwner(app.db, app.config)).toBe(owner)
  })

  it('keeps the owner’s password the owner’s: no other administrator may set it, not even while the account is deactivated', async () => {
    const owner = (await ownerRow())!
    const hijack = { password: 'Hijacked#12345' }
    const refused = await app.api<ApiErrorBody>('PATCH', `/api/users/${owner}`, { token: admin.token, body: hijack })
    expect(refused.status).toBe(403)
    expect(refused.body.error).toEqual({ code: 'forbidden', message: "Only Mohamed Beda can change this account's password." })
    // Nor along with another change, nor while deactivated: switched on again, the account would be theirs.
    expect((await app.api('PATCH', `/api/users/${owner}`, { token: admin.token, body: { name: 'Mo', ...hijack } })).status).toBe(403)
    expect((await app.api('PATCH', `/api/users/${owner}`, { token: admin.token, body: { isActive: false } })).status).toBe(200)
    expect((await app.api('PATCH', `/api/users/${owner}`, { token: admin.token, body: hijack })).status).toBe(403)
    expect((await app.api('PATCH', `/api/users/${owner}`, { token: admin.token, body: { isActive: true } })).status).toBe(200)
    await expect(app.login('beda.m', hijack.password)).rejects.toThrow(/login failed: 401/)
    const users = await app.db.query(`SELECT name FROM users WHERE id = $1`, [owner])
    expect(users.rows).toEqual([{ name: 'Mohamed Beda' }])
    expect((await app.db.query(`SELECT 1 FROM audit_log WHERE entity = 'User' AND entity_id = $1 AND field = 'password'`, [owner])).rowCount).toBe(0)

    // The owner sets their own; anyone else's, an administrator still may.
    const mo = await app.login('beda.m')
    expect((await app.api('PATCH', `/api/users/${owner}`, { token: mo.token, body: { password: 'Owners#Own12' } })).status).toBe(200)
    await app.login('beda.m', 'Owners#Own12')
    const someone = await createUser('someone', 'Some One', 'inspector')
    expect((await app.api('PATCH', `/api/users/${someone}`, { token: admin.token, body: hijack })).status).toBe(200)
    await app.login('someone', hijack.password)
  })

  it('pins once when many ask at the same moment', async () => {
    await app.resetDatabase()
    admin = await app.register('admin', 'Admin')
    const owner = await createUser('mo.beda', 'Mohamed Beda', 'inspector')
    const pinned = await Promise.all(Array.from({ length: 6 }, () => aiOwner(app.db, app.config)))
    expect(new Set(pinned)).toEqual(new Set([owner]))
    expect((await app.db.query(`SELECT 1 FROM ai_access WHERE user_id = $1`, [owner])).rowCount).toBe(1)
    expect((await app.db.query(`SELECT 1 FROM audit_log WHERE entity = 'AiAssistant' AND entity_id = 'owner'`)).rowCount).toBe(1)
    // Any role may own it: here an inspector, who alone may see the settings.
    const mo = await app.login('mo.beda')
    expect((await app.api<AiSettingsResponse>('GET', '/api/ai/settings', { token: mo.token })).status).toBe(200)
    const refused = await app.api<ApiErrorBody>('GET', '/api/ai/settings', { token: admin.token })
    expect(refused.status).toBe(404)
    expect(refused.body.error).toEqual({ code: 'not_found', message: 'No such endpoint.' })
  })

  it('pins the owner before anyone else may set the password of the account named', async () => {
    await app.resetDatabase()
    admin = await app.register('admin', 'Admin')
    const owner = await createUser('mo.beda', 'Mohamed Beda', 'inspector')
    // Changing anything else pins nobody: a password is what makes the account someone else's.
    expect((await app.api('PATCH', `/api/users/${owner}`, { token: admin.token, body: { name: 'Mohamed B.' } })).status).toBe(200)
    expect(await ownerRow()).toBeNull()
    expect((await app.api('PATCH', `/api/users/${owner}`, { token: admin.token, body: { password: 'Hijacked#12345' } })).status).toBe(403)
    expect(await ownerRow()).toBe(owner)
    const other = await createUser('other', 'Other', 'inspector')
    expect((await app.api('PATCH', `/api/users/${other}`, { token: admin.token, body: { password: 'Reset#123456' } })).status).toBe(200)
  })
})
