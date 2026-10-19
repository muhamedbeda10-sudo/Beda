// ============================================================================
// §16 — marking a notice seen or acknowledged: only a notice meant for the
// reader — by the rule their Notices are drawn by — and only while it is in
// force. Another's notice is "not found"; a withdrawn or ended one says so.
// ============================================================================

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ApiErrorBody, NoticeInboxResponse } from '@qc/shared/api'
import type { Notice } from '@qc/shared/types'
import { TestApp, factoryDay, type Session } from './harness'

const app = new TestApp()
let admin: Session
let insp: Session
let sup: Session

const make = async (body: Record<string, unknown>) => {
  const res = await app.api<Notice>('POST', '/api/notices', { token: admin.token, body: { severity: 'info', requiresAck: true, validFrom: factoryDay(), ...body } })
  expect(res.status, JSON.stringify(res.body)).toBe(201)
  return res.body
}
const mark = (s: Session, id: string, how: 'seen' | 'acknowledge') => app.api<ApiErrorBody>('POST', `/api/notices/${id}/${how}`, { token: s.token, body: {} })
const marks = async (id: string) => (await app.db.query(`SELECT user_name FROM notice_acknowledgements WHERE notice_id = $1 ORDER BY user_name`, [id])).rows.map((r) => r.user_name)

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  admin = await app.register('admin', 'Admin')
  for (const [username, name, role] of [
    ['insp', 'Ivy Inspector', 'inspector'],
    ['sup', 'Sam Supervisor', 'supervisor'],
  ]) {
    expect((await app.api('POST', '/api/users', { token: admin.token, body: { username, password: 'Password#1', name, role } })).status).toBe(201)
  }
  insp = await app.login('insp')
  sup = await app.login('sup')
})
afterAll(() => app.stop())

describe('§16 seen and acknowledged', () => {
  it('records a notice meant for the reader, and refuses one that is not as if it did not exist', async () => {
    const forSupervisors = await make({ title: 'Supervisors only', targets: [{ kind: 'role', value: 'supervisor' }] })
    for (const how of ['seen', 'acknowledge'] as const) {
      const refused = await mark(insp, forSupervisors.id, how)
      expect(refused.status).toBe(404)
      expect(refused.body.error.message).toBe('That notice was not found.')
    }
    expect(await marks(forSupervisors.id)).toEqual([])
    expect((await mark(sup, forSupervisors.id, 'acknowledge')).status).toBe(204)
    expect(await marks(forSupervisors.id)).toEqual(['Sam Supervisor'])

    // One addressed to a person by name reaches that person only.
    const forIvy = await make({ title: 'Ivy, see me', targets: [{ kind: 'user', value: insp.user.id }] })
    expect((await mark(sup, forIvy.id, 'seen')).status).toBe(404)
    expect((await mark(insp, forIvy.id, 'seen')).status).toBe(204)
    // One aimed at a place is the reader's to meet there.
    const atMachine = await make({ title: 'Machine 58', targets: [{ kind: 'machine', value: '58' }] })
    expect((await mark(insp, atMachine.id, 'acknowledge')).status).toBe(204)
  })

  it('refuses a notice withdrawn, or no longer in force', async () => {
    const withdrawn = await make({ title: 'Withdrawn' })
    expect((await app.api('POST', `/api/notices/${withdrawn.id}/withdraw`, { token: admin.token })).status).toBe(200)
    const late = await mark(insp, withdrawn.id, 'acknowledge')
    expect(late.status).toBe(400)
    expect(late.body.error.message).toBe('This notice was withdrawn.')

    const ended = await make({ title: 'Ended', validFrom: factoryDay(-5), validTo: factoryDay(-2) })
    const old = await mark(insp, ended.id, 'seen')
    expect(old.status).toBe(400)
    expect(old.body.error.message).toBe('This notice is not in force.')
    const soon = await make({ title: 'Next week', validFrom: factoryDay(3) })
    expect((await mark(insp, soon.id, 'seen')).status).toBe(400)
    for (const n of [withdrawn, ended, soon]) expect(await marks(n.id)).toEqual([])

    // Still listed as it was: nothing pending from them.
    const inbox = await app.api<NoticeInboxResponse>('GET', '/api/notices/inbox', { token: insp.token })
    expect(inbox.body.notices.find((n) => n.id === withdrawn.id)?.pending ?? false).toBe(false)
  })
})
