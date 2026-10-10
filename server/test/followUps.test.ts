import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { ApiErrorBody, HistoryResponse, SaveSampleRequest, SessionWithOrder, StartWithSampleResponse } from '@qc/shared/api'
import type { AuditListResponse } from '@qc/shared/api'
import type { FollowUp, FollowUpCountsResponse, FollowUpDetail, FollowUpPeopleResponse, FollowUpsResponse } from '@qc/shared/automation'
import type { ProductionOrder, UserProfile } from '@qc/shared/types'
import { TestApp, type Session } from './harness'
import { escalateOverdue, openFollowUps, type NewFollowUp } from '../src/automations/followUps'
import { systemUserId } from '../src/automations/systemChat'
import { isolate, withoutIsolates } from '../src/automations/text'
import { pinAiOwner } from '../src/ai/owner'

// §21 — follow-ups: opened once per case, seen by the people they concern,
// worked and closed with a note, escalated once, every change audited; an
// open one marks its session "Needs review" in History.

const app = new TestApp()
let admin: Session // also the assistant's owner
let sup: Session
let assignee: Session
let other: Session
let creator: Session
let viewer: Session
let goneId: string
let systemId: string
let order: ProductionOrder
let sessionA: SessionWithOrder
let sessionB: string
let sampleA: string
let automationId: string
let ids: string[] = []

const HOUR = 3_600_000

async function addUser(username: string, name: string, role: string): Promise<Session> {
  const res = await app.api<UserProfile>('POST', '/api/users', { token: admin.token, body: { username, password: 'Password#1', name, role } })
  expect(res.status).toBe(201)
  return app.login(username)
}

/** An automation row for follow-ups to belong to (activation itself is tested with the automations). */
async function automation(creatorId: string, name: string): Promise<string> {
  const { rows } = await app.db.query<{ id: string }>(
    `INSERT INTO ai_automations (creator_id, kind, name, description, language, watch, recipients, channels, actions, status)
     VALUES ($1, 'watch', $2, '', 'en', '{}', '[]', '{"bell":true,"chat":false}', '{"notify":false,"followUp":null}', 'paused') RETURNING id`,
    [creatorId, name],
  )
  return rows[0].id
}

const item = (over: Partial<NewFollowUp>): NewFollowUp => ({
  automationId,
  caseKey: randomUUID(),
  title: 'A case',
  body: '',
  assigneeId: null,
  dueAt: new Date(Date.now() + 2 * HOUR),
  caseColumns: ['session_id', 'defects'],
  caseRow: [null, 3],
  ...over,
})

const creatorOf = async () => creator.user.id
const get = (s: Session, id: string) => app.api<FollowUpDetail>('GET', `/api/follow-ups/${id}`, { token: s.token })
const listOf = (s: Session, query = '') => app.api<FollowUpsResponse>('GET', `/api/follow-ups${query}`, { token: s.token })
const patch = (s: Session, id: string, body: unknown) => app.api<FollowUpDetail & ApiErrorBody>('PATCH', `/api/follow-ups/${id}`, { token: s.token, body })
const counts = (s: Session) => app.api<FollowUpCountsResponse>('GET', '/api/follow-ups/counts', { token: s.token })
const peopleFor = (s: Session) => app.api<FollowUpPeopleResponse>('GET', '/api/follow-ups/people', { token: s.token })
/** A person's alerts of a kind, their words as they read (the isolates around values left out). */
const alertsOf = async (userId: string, kind: string) =>
  (
    await app.db.query<{ title: string; body: string; link: string; followUpId: string }>(
      `SELECT title, body, link, follow_up_id AS "followUpId" FROM user_notifications WHERE user_id = $1 AND kind = $2 ORDER BY created_at, id`,
      [userId, kind],
    )
  ).rows.map((r) => ({ ...r, title: withoutIsolates(r.title), body: withoutIsolates(r.body) }))

function sample(): SaveSampleRequest {
  return {
    submissionId: randomUUID(),
    drawing: 'D-1',
    sampleQty: 5,
    dimensions: [{ name: 'Width', sequence: 1, nominal: 125, tolPlus: 0.5, tolMinus: 0.5, actual: 125.1, unit: 'mm', source: 'item-order' }],
    defects: [],
    coils: [],
  }
}

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  admin = await app.register('admin', 'Admin')
  sup = await addUser('sup', 'Sara Supervisor', 'supervisor')
  assignee = await addUser('ali', 'Ali Assignee', 'inspector')
  other = await addUser('omar', 'Omar Other', 'inspector')
  creator = await addUser('carla', 'Carla Creator', 'inspector')
  viewer = await addUser('vera', 'Vera Viewer', 'viewer')
  goneId = (await addUser('gone', 'Gone Person', 'inspector')).user.id
  await app.api('PATCH', `/api/users/${goneId}`, { token: admin.token, body: { isActive: false } })
  systemId = await systemUserId(app.db)
  // The API pins the assistant's owner at start; here, the first account.
  expect(await pinAiOwner(app.db, app.config)).toBe(admin.user.id)

  await app.api('POST', '/api/master/machines', { token: admin.token, body: { code: '31', name: 'Roll Forming', line: 'LM2', displayName: '31-Roll Forming-LM2', process: 'forming' } })
  await app.api('POST', '/api/master/item-dimension-order', {
    token: admin.token,
    body: { itemCode: '100155TA3', item: 'XL Light Beam', dimensionName: 'Width', sequence: 1, nominal: 125, tolPlus: 0.5, tolMinus: 0.5, unit: 'mm' },
  })
  await app.api('POST', '/api/orders/import', {
    token: admin.token,
    body: {
      rows: [
        { lineKey: 'H-1', orderNumber: '20552-RHE', item: 'XL Light Beam', itemCode: '100155TA3', workCenterCode: '31', requiredQty: 500, finishedQty: 0, customer: 'RHE', expectedGrade: '', drawing: 'D-1' },
        { lineKey: 'H-2', orderNumber: '20553-RHE', item: 'XL Light Beam', itemCode: '100155TA3', workCenterCode: '31', requiredQty: 500, finishedQty: 0, customer: 'RHE', expectedGrade: '', drawing: 'D-1' },
      ],
    },
  })
  const orders = (await app.api<ProductionOrder[]>('GET', '/api/orders', { token: admin.token })).body
  order = orders.find((o) => o.lineKey === 'H-1')!
  const started = await app.api<StartWithSampleResponse>('POST', '/api/sessions/start-with-sample', {
    token: assignee.token,
    body: { start: { orderId: order.id, startQty: 0 }, sample: sample() },
  })
  expect(started.status).toBe(201)
  sessionA = started.body.session
  sampleA = started.body.sample.sampleId
  sessionB = (await app.api<{ id: string }>('POST', '/api/sessions', { token: assignee.token, body: { orderId: orders.find((o) => o.lineKey === 'H-2')!.id, startQty: 0 } })).body.id
  automationId = await automation(creator.user.id, 'Hold watch')
})
afterAll(() => app.stop())

describe('§21 — opening follow-ups', () => {
  it('opens one per case, checks what each points at, and tells each assignee', async () => {
    const opened = await openFollowUps(
      app.db,
      [
        item({ caseKey: 'k1', title: 'Hold on 20552', body: 'Three defects on Hold.', assigneeId: assignee.user.id, sessionId: sessionA.id, dueAt: new Date(Date.now() + 2 * HOUR) }),
        // Only the sample: its session comes along. Already overdue.
        item({ caseKey: 'k2', title: '  Sample   check\n', assigneeId: viewer.user.id, sampleId: sampleA, dueAt: new Date(Date.now() - HOUR) }),
        // Nothing on record to point at, and an assignee who cannot be told: unassigned.
        item({ caseKey: 'k3', title: 'Order check', assigneeId: goneId, sessionId: randomUUID(), sampleId: 'not-an-id', orderNumber: ' 99999-X ', dueAt: new Date(Date.now() + 5 * HOUR) }),
        // The same case again in the same run: passed over.
        item({ caseKey: 'k1', title: 'Twice' }),
      ],
      { automationName: 'Hold watch', creatorId: creator.user.id },
    )
    expect(opened).toHaveLength(3)
    ids = opened
    // A later run finds the same cases: nothing new.
    expect(await openFollowUps(app.db, [item({ caseKey: 'k1' }), item({ caseKey: 'k2' })], { automationName: 'Hold watch', creatorId: creator.user.id })).toEqual([])

    const { rows } = await app.db.query<{ id: string; title: string; sessionId: string | null; sampleId: string | null; orderNumber: string | null; assigneeId: string | null; creatorId: string }>(
      `SELECT id, title, session_id AS "sessionId", sample_id AS "sampleId", order_number AS "orderNumber", assignee_id AS "assigneeId", creator_id AS "creatorId"
         FROM follow_ups ORDER BY case_key`,
    )
    expect(rows).toEqual([
      { id: ids[0], title: 'Hold on 20552', sessionId: sessionA.id, sampleId: null, orderNumber: '20552-RHE', assigneeId: assignee.user.id, creatorId: creator.user.id },
      { id: ids[1], title: 'Sample check', sessionId: sessionA.id, sampleId: sampleA, orderNumber: '20552-RHE', assigneeId: viewer.user.id, creatorId: creator.user.id },
      { id: ids[2], title: 'Order check', sessionId: null, sampleId: null, orderNumber: '99999-X', assigneeId: null, creatorId: creator.user.id },
    ])
    const told = await alertsOf(assignee.user.id, 'follow-up-assigned')
    expect(told).toEqual([{ title: 'Hold on 20552', body: 'Assigned to you by the automation "Hold watch".\nThree defects on Hold.', link: `/follow-ups/${ids[0]}`, followUpId: ids[0] }])
    expect(await alertsOf(viewer.user.id, 'follow-up-assigned')).toHaveLength(1)
  })

  it('writes the opening into the timeline and the audit log, as the system sender, under the session', async () => {
    const detail = await get(admin, ids[0])
    expect(detail.status).toBe(200)
    expect(detail.body.events).toEqual([expect.objectContaining({ kind: 'created', authorName: 'QC Automations', body: `Opened by the automation "${isolate('Hold watch')}".` })])
    const { rows } = await app.db.query<{ userId: string; userName: string; action: string; sessionId: string | null; orderNumber: string | null; item: string | null; workCenterCode: string | null }>(
      `SELECT user_id AS "userId", user_name AS "userName", action, session_id AS "sessionId", order_number AS "orderNumber", item, work_center_code AS "workCenterCode"
         FROM audit_log WHERE entity = 'FollowUp' AND entity_id = $1`,
      [ids[0]],
    )
    expect(rows).toEqual([{ userId: systemId, userName: 'QC Automations', action: 'create', sessionId: sessionA.id, orderNumber: '20552-RHE', item: 'XL Light Beam', workCenterCode: '31' }])
  })

  it('reads as the app shows it: the session, its automation, the case row', async () => {
    const f = (await get(admin, ids[1])).body
    expect(f).toMatchObject({
      automationId,
      automationName: 'Hold watch',
      caseKey: 'k2',
      title: 'Sample check',
      status: 'open',
      assignee: { id: viewer.user.id, name: 'Vera Viewer' },
      overdue: true,
      sessionId: sessionA.id,
      sessionLabel: '20552-RHE · XL Light Beam · 31-Roll Forming-LM2 · #1',
      sampleId: sampleA,
      orderNumber: '20552-RHE',
      caseColumns: ['session_id', 'defects'],
      caseRow: [null, 3],
      commentCount: 0,
      canEdit: true,
      canReassign: true,
    })
    expect(f.closedAt).toBeUndefined()
    // Renaming the automation renames it on its follow-ups.
    await app.db.query(`UPDATE ai_automations SET name = 'Hold watch (line 31)' WHERE id = $1`, [automationId])
    expect((await get(admin, ids[1])).body.automationName).toBe('Hold watch (line 31)')
    await app.db.query(`UPDATE ai_automations SET name = 'Hold watch' WHERE id = $1`, [automationId])
  })
})

describe('§21 — History marks a session "Needs review"', () => {
  it('counts the open follow-ups on the list rows and the session itself', async () => {
    const history = await app.api<HistoryResponse>('GET', '/api/sessions/history', { token: other.token })
    const byId = new Map(history.body.sessions.map((s) => [s.id, s]))
    expect(byId.get(sessionA.id)?.openFollowUps).toBe(2)
    expect(byId.get(sessionB)?.openFollowUps).toBe(0)
    // Sorted by a column, the rows come another way: the same count.
    const sorted = await app.api<HistoryResponse>('GET', '/api/sessions/history?sort=seq:asc', { token: other.token })
    expect(sorted.status).toBe(200)
    expect(sorted.body.sessions.find((s) => s.id === sessionA.id)?.openFollowUps).toBe(2)
    const detail = await app.api<SessionWithOrder>('GET', `/api/sessions/${sessionA.id}`, { token: viewer.token })
    expect(detail.body.openFollowUps).toBe(2)
  })

  it('lists the session’s follow-ups that the reader may see', async () => {
    expect((await listOf(sup, `?scope=all&sessionId=${sessionA.id}`)).body.followUps.map((f) => f.id).sort()).toEqual([ids[0], ids[1]].sort())
    expect((await listOf(assignee, `?sessionId=${sessionA.id}`)).body.followUps.map((f) => f.id)).toEqual([ids[0]])
    expect((await listOf(other, `?sessionId=${sessionA.id}`)).body.followUps).toEqual([])
  })
})

describe('§21 — who sees a follow-up', () => {
  it('shows the assignee theirs, the creator their automation’s, and everyone’s to supervisors, administrators and the owner', async () => {
    const seen = async (s: Session, query = '') => (await listOf(s, query)).body.followUps.map((f) => f.id).sort()
    expect(await seen(assignee)).toEqual([ids[0]])
    // "All" is not more for someone who does not see everyone's.
    expect(await seen(assignee, '?scope=all')).toEqual([ids[0]])
    expect(await seen(viewer)).toEqual([ids[1]])
    expect(await seen(creator)).toEqual([...ids].sort())
    expect(await seen(other)).toEqual([])
    expect(await seen(other, '?scope=all')).toEqual([])
    expect(await seen(sup)).toEqual([])
    expect(await seen(sup, '?scope=all')).toEqual([...ids].sort())
    expect(await seen(admin, '?scope=all')).toEqual([...ids].sort())

    expect((await get(other, ids[0])).status).toBe(404)
    expect((await patch(other, ids[0], { status: 'in_progress' })).status).toBe(404)
    expect((await app.api('POST', `/api/follow-ups/${ids[0]}/comments`, { token: other.token, body: { body: 'Hi' } })).status).toBe(404)
    expect((await get(viewer, ids[0])).status).toBe(404)
    expect((await get(viewer, ids[1])).status).toBe(200)
    expect((await get(sup, randomUUID())).status).toBe(404)
  })

  it('counts each person’s own for the navigation badge: the open ones of their "Mine", assigned to them or opened by their automations', async () => {
    expect((await counts(assignee)).body).toEqual({ visible: true, all: false, mineOpen: 1, mineOverdue: 0 })
    expect((await counts(viewer)).body).toEqual({ visible: true, all: false, mineOpen: 1, mineOverdue: 1 })
    const mine = await app.api<FollowUpsResponse>('GET', '/api/follow-ups?scope=mine&status=open,in_progress', { token: creator.token })
    expect((await counts(creator)).body).toEqual({ visible: true, all: false, mineOpen: mine.body.followUps.length, mineOverdue: mine.body.followUps.filter((f) => f.overdue).length })
    expect(mine.body.followUps.length).toBeGreaterThan(0)
    expect((await counts(other)).body).toEqual({ visible: false, all: false, mineOpen: 0, mineOverdue: 0 })
    expect((await counts(sup)).body).toEqual({ visible: true, all: true, mineOpen: 0, mineOverdue: 0 })
  })

  it('says what each viewer may do', async () => {
    const asAssignee = (await get(assignee, ids[0])).body
    expect([asAssignee.canEdit, asAssignee.canReassign]).toEqual([true, false])
    const asCreator = (await get(creator, ids[0])).body
    expect([asCreator.canEdit, asCreator.canReassign]).toEqual([true, true])
    const asSup = (await get(sup, ids[0])).body
    expect([asSup.canEdit, asSup.canReassign]).toEqual([true, true])
  })
})

describe('§21 — the list', () => {
  it('puts the overdue first, then by deadline, and filters', async () => {
    const all = (await listOf(sup, '?scope=all')).body
    expect(all.followUps.map((f) => f.id)).toEqual([ids[1], ids[0], ids[2]])
    expect(all.followUps.map((f) => f.overdue)).toEqual([true, false, false])
    expect(all.hasMore).toBe(false)
    expect((await listOf(sup, '?scope=all&overdue=true')).body.followUps.map((f) => f.id)).toEqual([ids[1]])
    expect((await listOf(sup, '?scope=all&status=done')).body.followUps).toEqual([])
    expect((await listOf(sup, '?scope=all&status=open,in_progress')).body.followUps).toHaveLength(3)
    expect((await listOf(sup, `?scope=all&automationId=${automationId}`)).body.followUps).toHaveLength(3)
    expect((await listOf(sup, `?scope=all&automationId=${randomUUID()}`)).body.followUps).toEqual([])
    expect((await listOf(sup, '?status=closed')).status).toBe(400)
    expect((await listOf(sup, '?scope=everyone')).status).toBe(400)
  })

  it('walks every follow-up a page at a time, in order', async () => {
    const many = await automation(creator.user.id, 'Busy watch')
    const now = Date.now()
    const made = await openFollowUps(
      app.db,
      Array.from({ length: 62 }, (_, i) => item({ automationId: many, caseKey: `m${i}`, title: `Busy ${i}`, assigneeId: other.user.id, dueAt: new Date(now + ((i % 7) - 2) * HOUR) })),
      { automationName: 'Busy watch', creatorId: creator.user.id },
    )
    expect(made).toHaveLength(62)
    const seen: FollowUp[] = []
    let before: string | undefined
    for (let guard = 0; guard < 5; guard++) {
      const page = (await listOf(other, `?automationId=${many}${before ? `&before=${before}` : ''}`)).body
      seen.push(...page.followUps)
      if (!page.hasMore) break
      expect(page.followUps).toHaveLength(50)
      before = page.followUps[page.followUps.length - 1].id
    }
    expect(seen).toHaveLength(62)
    expect(new Set(seen.map((f) => f.id)).size).toBe(62)
    // Overdue first, each group by deadline.
    const firstOnTime = seen.findIndex((f) => !f.overdue)
    expect(seen.slice(firstOnTime).every((f) => !f.overdue)).toBe(true)
    const inOrder = (xs: FollowUp[]) => xs.every((f, i) => i === 0 || xs[i - 1].dueAt <= f.dueAt)
    expect(inOrder(seen.slice(0, firstOnTime))).toBe(true)
    expect(inOrder(seen.slice(firstOnTime))).toBe(true)
    // Closed ones go to the end, the latest closed first.
    await app.db.query(
      `UPDATE follow_ups SET status = 'done', closed_at = now() - make_interval(mins => (substr(case_key, 2)::int)), closed_by_name = 'Omar Other', closing_note = 'Fine.'
        WHERE automation_id = $1 AND substr(case_key, 2)::int < 3`,
      [many],
    )
    const tail = (await listOf(other, `?automationId=${many}&before=${seen[49].id}`)).body.followUps
    expect(tail.slice(-3).map((f) => f.title)).toEqual(['Busy 0', 'Busy 1', 'Busy 2'])
    await app.db.query(`UPDATE follow_ups SET status = 'open', closed_at = NULL, closed_by_name = NULL, closing_note = NULL WHERE automation_id = $1`, [many])
    // Out of the way of the rest of the file.
    await app.db.query(`UPDATE follow_ups SET status = 'done', closed_at = now(), closed_by_name = 'Omar Other', closing_note = 'Done.' WHERE automation_id = $1`, [many])
  })
})

describe('§21 — working on a follow-up', () => {
  it('lets the assignee move the status, and tells the creator', async () => {
    const res = await patch(assignee, ids[0], { status: 'in_progress' })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('in_progress')
    expect(res.body.events.map((e) => [e.kind, e.authorName, withoutIsolates(e.body)])).toEqual([
      ['created', 'QC Automations', 'Opened by the automation "Hold watch".'],
      ['status', 'Ali Assignee', 'Open → In progress'],
    ])
    expect(await alertsOf(creator.user.id, 'follow-up-updated')).toEqual([
      { title: 'Hold on 20552', body: 'Ali Assignee set it to In progress.', link: `/follow-ups/${ids[0]}`, followUpId: ids[0] },
    ])
    // The one who made the change is not told about it.
    expect(await alertsOf(assignee.user.id, 'follow-up-updated')).toEqual([])
    const { rows } = await app.db.query<{ field: string; oldValue: string; newValue: string; userName: string; sessionId: string }>(
      `SELECT field, old_value AS "oldValue", new_value AS "newValue", user_name AS "userName", session_id AS "sessionId"
         FROM audit_log WHERE entity = 'FollowUp' AND entity_id = $1 AND action = 'update'`,
      [ids[0]],
    )
    expect(rows).toEqual([{ field: 'status', oldValue: 'Open', newValue: 'In progress', userName: 'Ali Assignee', sessionId: sessionA.id }])
  })

  it('keeps reassigning and the deadline to the creator, supervisors, administrators and the owner', async () => {
    const reassign = await patch(assignee, ids[0], { assigneeId: other.user.id })
    expect(reassign.status).toBe(403)
    const move = await patch(assignee, ids[0], { dueAt: new Date(Date.now() + 10 * HOUR).toISOString() })
    expect(move.status).toBe(403)
    // Naming the deadline it already has changes nothing, so it is no change of deadline.
    const same = await patch(assignee, ids[0], { dueAt: (await get(assignee, ids[0])).body.dueAt })
    expect(same.status).toBe(200)
  })

  it('closes only with a closing note, and the session’s mark goes with its last open follow-up', async () => {
    const noNote = await patch(assignee, ids[0], { status: 'done' })
    expect(noNote.status).toBe(400)
    expect(noNote.body.error.message).toBe('Write a closing note to close the follow-up.')
    expect((await patch(assignee, ids[0], { status: 'done', closingNote: '   ' })).status).toBe(400)
    const strayNote = await patch(assignee, ids[0], { closingNote: 'Checked.' })
    expect(strayNote.status).toBe(400)
    const done = await patch(assignee, ids[0], { status: 'done', closingNote: 'Re-inspected: the Hold was released.' })
    expect(done.status).toBe(200)
    expect(done.body).toMatchObject({ status: 'done', closedByName: 'Ali Assignee', closingNote: 'Re-inspected: the Hold was released.', overdue: false })
    expect(done.body.closedAt).toBeTruthy()
    expect(done.body.events.at(-1)).toMatchObject({ kind: 'status', body: 'In progress → Done. Closing note: Re-inspected: the Hold was released.' })
    expect((await app.api<SessionWithOrder>('GET', `/api/sessions/${sessionA.id}`, { token: other.token })).body.openFollowUps).toBe(1)
    expect((await counts(assignee)).body.mineOpen).toBe(0)

    // Reopened by a supervisor: no longer closed, and the session is marked again.
    const reopened = await patch(sup, ids[0], { status: 'open' })
    expect(reopened.status).toBe(200)
    expect(reopened.body.closedAt).toBeUndefined()
    expect(reopened.body.closingNote).toBeUndefined()
    expect((await app.api<SessionWithOrder>('GET', `/api/sessions/${sessionA.id}`, { token: other.token })).body.openFollowUps).toBe(2)
    // Both the assignee and the creator hear of it.
    expect((await alertsOf(assignee.user.id, 'follow-up-updated')).at(-1)?.body).toBe('Sara Supervisor set it to Open.')
    expect((await alertsOf(creator.user.id, 'follow-up-updated')).at(-1)?.body).toBe('Sara Supervisor set it to Open.')

    // Closing both clears the mark.
    expect((await patch(assignee, ids[0], { status: 'done', closingNote: 'Released.' })).status).toBe(200)
    expect((await patch(viewer, ids[1], { status: 'done', closingNote: 'Seen on the board.' })).status).toBe(200)
    const history = await app.api<HistoryResponse>('GET', '/api/sessions/history', { token: other.token })
    expect(history.body.sessions.find((s) => s.id === sessionA.id)?.openFollowUps).toBe(0)
    expect((await app.api<SessionWithOrder>('GET', `/api/sessions/${sessionA.id}`, { token: other.token })).body.openFollowUps).toBe(0)
  })

  it('lets the creator reassign: the new assignee is told and now sees it', async () => {
    expect((await get(other, ids[2])).status).toBe(404)
    const res = await patch(creator, ids[2], { assigneeId: other.user.id })
    expect(res.status).toBe(200)
    expect(res.body.assignee).toEqual({ id: other.user.id, name: 'Omar Other' })
    expect(res.body.events.at(-1)).toMatchObject({ kind: 'assignee', authorName: 'Carla Creator', body: 'Assigned to Omar Other' })
    expect((await alertsOf(other.user.id, 'follow-up-assigned')).filter((a) => a.followUpId === ids[2])).toEqual([
      { title: 'Order check', body: 'Carla Creator assigned this follow-up to you.', link: `/follow-ups/${ids[2]}`, followUpId: ids[2] },
    ])
    expect((await get(other, ids[2])).status).toBe(200)
    // Nobody who cannot be told can be given it.
    expect((await patch(creator, ids[2], { assigneeId: goneId })).status).toBe(400)
    expect((await patch(creator, ids[2], { assigneeId: systemId })).status).toBe(400)
    expect((await patch(creator, ids[2], { assigneeId: randomUUID() })).status).toBe(400)
    // A supervisor hands it on; the creator hears of it.
    const handed = await patch(sup, ids[2], { assigneeId: viewer.user.id })
    expect(handed.status).toBe(200)
    expect((await alertsOf(creator.user.id, 'follow-up-updated')).at(-1)?.body).toBe('Sara Supervisor assigned it to Vera Viewer.')
    expect(handed.body.events.at(-1)?.body).toBe('Assigned to Vera Viewer (was Omar Other)')
  })

  it('moves a deadline within bounds, in the timeline in factory time', async () => {
    const f = (await get(creator, ids[2])).body
    expect((await patch(creator, ids[2], { dueAt: new Date(new Date(f.createdAt).getTime() - HOUR).toISOString() })).status).toBe(400)
    expect((await patch(creator, ids[2], { dueAt: new Date(Date.now() + 400 * 24 * HOUR).toISOString() })).status).toBe(400)
    expect((await patch(creator, ids[2], { dueAt: 'tomorrow' })).status).toBe(400)
    const inRange = new Date(Date.now() + 3 * 24 * HOUR)
    inRange.setUTCSeconds(0, 0)
    const res = await patch(creator, ids[2], { dueAt: inRange.toISOString() })
    expect(res.status).toBe(200)
    expect(res.body.dueAt).toBe(inRange.toISOString())
    const stamp = new Intl.DateTimeFormat('en-CA', { timeZone: app.config.FACTORY_TIMEZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(inRange)
    expect(res.body.events.at(-1)?.kind).toBe('due')
    expect(res.body.events.at(-1)?.body).toMatch(new RegExp(`→ \\d{4}-\\d{2}-\\d{2} ${stamp}$`))
    // The viewer, its assignee, is told.
    expect((await alertsOf(viewer.user.id, 'follow-up-updated')).at(-1)?.body).toMatch(/^Carla Creator moved the deadline to /)
  })

  it('refuses a request that changes nothing it knows', async () => {
    expect((await patch(sup, ids[2], {})).status).toBe(400)
    expect((await patch(sup, ids[2], { title: 'New' })).status).toBe(400)
    expect((await patch(sup, ids[2], { status: 'closed' })).status).toBe(400)
  })

  it('takes comments from anyone who may work on it, and tells the others concerned', async () => {
    const res = await app.api<FollowUpDetail>('POST', `/api/follow-ups/${ids[2]}/comments`, { token: viewer.token, body: { body: '  Checked the order sheet.  ' } })
    expect(res.status).toBe(201)
    expect(res.body.commentCount).toBe(1)
    expect(res.body.events.at(-1)).toMatchObject({ kind: 'comment', authorName: 'Vera Viewer', body: 'Checked the order sheet.' })
    expect((await alertsOf(creator.user.id, 'follow-up-updated')).at(-1)?.body).toBe('Vera Viewer commented: Checked the order sheet.')
    expect((await alertsOf(viewer.user.id, 'follow-up-updated')).map((a) => a.body)).not.toContain('Vera Viewer commented: Checked the order sheet.')
    expect((await app.api('POST', `/api/follow-ups/${ids[2]}/comments`, { token: viewer.token, body: { body: '   ' } })).status).toBe(400)
    expect((await app.api('POST', `/api/follow-ups/${ids[2]}/comments`, { token: viewer.token, body: { body: 'x'.repeat(2001) } })).status).toBe(400)
    const { rows } = await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE entity = 'FollowUp' AND entity_id = $1 AND field = 'comment'`, [ids[2]])
    expect(rows[0].n).toBe(1)
  })

  it('shows follow-up entries in the audit log to supervisors like any other', async () => {
    const res = await app.api<AuditListResponse>('GET', '/api/audit?entity=FollowUp', { token: sup.token })
    expect(res.status).toBe(200)
    expect(res.body.entries.length).toBeGreaterThan(5)
    expect(res.body.entries.some((e) => e.userName === 'QC Automations')).toBe(true)
  })
})

describe('§21 — overdue follow-ups escalate once', () => {
  it('tells the assignee and the creator once, and never about a done one', async () => {
    // The third follow-up is due in three days; the first two are done.
    const late = await openFollowUps(app.db, [item({ caseKey: 'late', title: 'Late one', assigneeId: assignee.user.id, dueAt: new Date(Date.now() - 2 * HOUR) })], {
      automationName: 'Hold watch',
      creatorId: creator.user.id,
    })
    const creatorBefore = (await alertsOf(creator.user.id, 'follow-up-overdue')).length
    expect(await escalateOverdue(app.db, new Date(), creatorOf)).toBe(1)
    expect(await alertsOf(assignee.user.id, 'follow-up-overdue')).toEqual([
      expect.objectContaining({ title: 'Overdue: Late one', link: `/follow-ups/${late[0]}`, followUpId: late[0] }),
    ])
    expect((await alertsOf(creator.user.id, 'follow-up-overdue')).length).toBe(creatorBefore + 1)
    const f = (await get(assignee, late[0])).body
    expect(f.escalatedAt).toBeTruthy()
    expect(f.events.at(-1)).toMatchObject({ kind: 'escalated', authorName: 'QC Automations' })
    // Once.
    expect(await escalateOverdue(app.db, new Date(), creatorOf)).toBe(0)
    expect((await alertsOf(assignee.user.id, 'follow-up-overdue')).length).toBe(1)
  })

  it('never escalates twice when two engines look at once', async () => {
    await openFollowUps(app.db, [item({ caseKey: 'race', title: 'Race', assigneeId: assignee.user.id, dueAt: new Date(Date.now() - HOUR) })], {
      automationName: 'Hold watch',
      creatorId: creator.user.id,
    })
    const results = await Promise.all([escalateOverdue(app.db, new Date(), creatorOf), escalateOverdue(app.db, new Date(), creatorOf)])
    expect(results.reduce((a, b) => a + b, 0)).toBe(1)
    expect((await alertsOf(assignee.user.id, 'follow-up-overdue')).filter((a) => a.title === 'Overdue: Race')).toHaveLength(1)
  })

  it('escalates again only after the deadline is moved on and missed again', async () => {
    // Three days on, the reassigned one is overdue too.
    const later = new Date(Date.now() + 4 * 24 * HOUR)
    expect(await escalateOverdue(app.db, later, creatorOf)).toBe(1)
    expect((await get(viewer, ids[2])).body.escalatedAt).toBeTruthy()
    // Its deadline moved into the future clears the escalation…
    const moved = await patch(creator, ids[2], { dueAt: new Date(Date.now() + 5 * 24 * HOUR).toISOString() })
    expect(moved.body.escalatedAt).toBeUndefined()
    // …and a missed deadline escalates once more.
    expect(await escalateOverdue(app.db, new Date(Date.now() + 6 * 24 * HOUR), creatorOf)).toBe(1)
    expect(await escalateOverdue(app.db, new Date(Date.now() + 6 * 24 * HOUR), creatorOf)).toBe(0)
  })

  it('tells the creator named when the automation names none', async () => {
    const [id] = await openFollowUps(app.db, [item({ caseKey: 'nobody', title: 'Unassigned late', dueAt: new Date(Date.now() - HOUR) })], {
      automationName: 'Hold watch',
      creatorId: creator.user.id,
    })
    expect(await escalateOverdue(app.db, new Date(), async () => null)).toBe(1)
    expect((await alertsOf(creator.user.id, 'follow-up-overdue')).some((a) => a.followUpId === id)).toBe(true)
  })
})

describe('§21 — whom a follow-up can be given to', () => {
  it('lists every active account, viewers included, to those who may reassign one; to anyone else it does not exist', async () => {
    // Someone whose automation opened nothing yet, and an account removed: one may ask, the other is not listed.
    const maker = await addUser('dina', 'Dina Maker', 'inspector')
    await automation(maker.user.id, 'Nothing opened yet')
    const removed = await addUser('rami', 'Rami Removed', 'inspector')
    expect((await app.api('DELETE', `/api/users/${removed.user.id}`, { token: admin.token })).status).toBe(204)

    const res = await peopleFor(sup)
    expect(res.status).toBe(200)
    const { rows } = await app.db.query<{ id: string; name: string; username: string; role: string }>(
      `SELECT id, name, username, role::text AS role FROM users WHERE is_active AND deleted_at IS NULL AND NOT is_system ORDER BY lower(name), username`,
    )
    expect(res.body).toEqual({ people: rows })
    const ids = res.body.people.map((x) => x.id)
    expect(ids).toEqual(expect.arrayContaining([viewer.user.id, assignee.user.id, sup.user.id, admin.user.id, maker.user.id]))
    for (const gone of [goneId, removed.user.id, systemId]) expect(ids).not.toContain(gone)
    expect(res.body.people.find((x) => x.id === viewer.user.id)).toEqual({ id: viewer.user.id, name: 'Vera Viewer', username: 'vera', role: 'viewer' })

    // Supervisors, administrators, the owner, and anyone who created an automation — deleted ones too.
    for (const s of [admin, creator, maker]) expect((await peopleFor(s)).body, s.user.name).toEqual(res.body)
    await app.db.query(`UPDATE ai_automations SET deleted_at = now() WHERE creator_id = $1`, [maker.user.id])
    expect((await peopleFor(maker)).status).toBe(200)
    // An assignee, a viewer, anyone else: no such endpoint.
    for (const s of [assignee, viewer, other]) {
      const refused = await app.api<ApiErrorBody>('GET', '/api/follow-ups/people', { token: s.token })
      expect(refused.status, s.user.name).toBe(404)
      expect(refused.body.error.message).toBe('No such endpoint.')
    }
  })
})

describe('§21 — the assistant’s owner sees everyone’s, whatever their role', () => {
  it('keeps seeing all of them as an inspector', async () => {
    await addUser('admin2', 'Second Admin', 'admin')
    const second = await app.login('admin2')
    expect((await app.api('PATCH', `/api/users/${admin.user.id}`, { token: second.token, body: { role: 'inspector' } })).status).toBe(200)
    expect((await counts(admin)).body.all).toBe(true)
    expect((await listOf(admin, '?scope=all&status=open,in_progress')).body.followUps.length).toBeGreaterThan(0)
    const f = (await get(admin, ids[2])).body
    expect([f.canEdit, f.canReassign]).toEqual([true, true])
    expect((await peopleFor(admin)).status).toBe(200)
    // An inspector who is not the owner sees none of it.
    expect((await get(other, ids[1])).status).toBe(404)
  })
})
