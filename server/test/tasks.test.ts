import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import type { ApiErrorBody } from '@qc/shared/api'
import type { ImageAsset } from '@qc/shared/types'
import type { TaskCountsResponse, TaskDetail, TaskPerson, TasksResponse } from '@qc/shared/tasks'
import { TestApp, tinyJpeg, type Session } from './harness'
import { setUp, type People } from './automationsKit'

// Tasks: sent by someone given the AI assistant, worked by the people they
// went to (in progress, done, with words and photos on the thread), confirmed
// or sent back by the sender, closed once everyone is confirmed. Only the
// people on a task see it; each change tells those it concerns in the bell.

const app = new TestApp()
let p: People

type Res = TaskDetail & ApiErrorBody
const send = (as: Session, body: object) => app.api<Res>('POST', '/api/tasks', { token: as.token, body })
const get = (as: Session, id: string) => app.api<Res>('GET', `/api/tasks/${id}`, { token: as.token })
const act = (as: Session, id: string, what: string, body: object = {}) => app.api<Res>('POST', `/api/tasks/${id}/${what}`, { token: as.token, body })
const counts = async (as: Session) => (await app.api<TaskCountsResponse>('GET', '/api/tasks/counts', { token: as.token })).body
const list = async (as: Session, query: string) => (await app.api<TasksResponse>('GET', `/api/tasks?${query}`, { token: as.token })).body.tasks

/** The bell's alerts of one person, newest first. */
async function alertsOf(userId: string): Promise<{ kind: string; title: string; body: string; link: string; severity: string; task_id: string }[]> {
  const { rows } = await app.db.query(`SELECT kind, title, body, link, severity, task_id FROM user_notifications WHERE user_id = $1 ORDER BY created_at DESC, id DESC`, [userId])
  return rows
}

async function uploadPhoto(s: Session, seed: number): Promise<ImageAsset> {
  const bytes = tinyJpeg(seed)
  const form = new FormData()
  form.set('file', new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }), 'site.jpg')
  form.set('originalFilename', 'site.jpg')
  form.set('width', '1600')
  form.set('height', '1200')
  form.set('sha256', createHash('sha256').update(bytes).digest('hex'))
  form.set('thumbnailDataUrl', 'data:image/jpeg;base64,/9j/4AAQSkZJRg==')
  const res = await app.api<ImageAsset>('POST', '/api/images', { token: s.token, raw: form })
  expect(res.status).toBe(201)
  return res.body
}

const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString()

beforeAll(async () => {
  await app.start()
  p = await setUp(app)
})
afterAll(() => app.stop())

describe('sending a task', () => {
  it('is for people given the assistant; everyone has the counts', async () => {
    expect(await counts(p.creator)).toEqual({ assignedOpen: 0, assignedOverdue: 0, toConfirm: 0, canCreate: true })
    expect((await counts(p.admin2)).canCreate).toBe(false)
    const refused = await send(p.admin2, { title: 'Check the press', assigneeIds: [p.creator2.user.id] })
    expect(refused.status).toBe(403)
    expect((await app.api('GET', '/api/tasks/people', { token: p.admin2.token })).status).toBe(403)
    const people = (await app.api<TaskPerson[]>('GET', '/api/tasks/people', { token: p.creator.token })).body
    // Viewers are not sent tasks.
    expect(people.map((x) => x.name)).not.toContain('Vera Viewer')
    expect(people.map((x) => x.name)).toContain('Second Admin')
  })

  it('refuses what it cannot send, keeping nothing', async () => {
    const before = await app.db.query(`SELECT count(*)::int AS n FROM tasks`)
    for (const [body, why] of [
      [{ title: '  ', assigneeIds: [p.admin2.user.id] }, /title/],
      [{ title: 'X', assigneeIds: [] }, /at least one person/],
      [{ title: 'X', assigneeIds: [p.viewer.user.id] }, /cannot be sent a task/],
      [{ title: 'X', assigneeIds: [p.admin2.user.id], dueAt: new Date(Date.now() - 86_400_000).toISOString() }, /already passed/],
      [{ title: 'X', assigneeIds: [p.admin2.user.id], priority: 'whenever' }, /./],
    ] as const) {
      const res = await send(p.creator, body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(res.body.error.message).toMatch(why)
    }
    expect((await app.db.query(`SELECT count(*)::int AS n FROM tasks`)).rows[0].n).toBe(before.rows[0].n)
  })
})

describe('a task followed to the end', () => {
  let id = ''

  it('goes to each person, who is told in the bell; nobody else can see it', async () => {
    const res = await send(p.creator, { title: 'Recheck  the coil\nstock', description: 'Count the coils of supplier Ezz in bay 3.', priority: 'high', dueAt: inAnHour(), assigneeIds: [p.admin2.user.id, p.creator2.user.id] })
    expect(res.status).toBe(201)
    id = res.body.id
    expect(res.body).toMatchObject({ title: 'Recheck the coil stock', priority: 'high', status: 'open', isCreator: true, waitingForMe: false, canEdit: true })
    expect(res.body.number).toBeGreaterThan(0)
    expect(res.body.assignees.map((a) => [a.name, a.state])).toEqual([
      ['Cyril Second', 'todo'],
      ['Second Admin', 'todo'],
    ])
    expect(res.body.messages.map((m) => m.event)).toEqual(['created'])
    const alert = (await alertsOf(p.admin2.user.id))[0]
    expect(alert).toMatchObject({ kind: 'task-assigned', severity: 'warning', link: `/tasks/${id}`, task_id: id })
    expect(alert.title).toBe(`New task from Cara Creator: T-${res.body.number}: Recheck the coil stock`)
    expect(alert.body).toMatch(/^Count the coils of supplier Ezz in bay 3\. Deadline: \d{4}-\d{2}-\d{2} \d{2}:\d{2}\.$/)
    // The sender is not told of their own sending.
    expect((await alertsOf(p.creator.user.id)).filter((a) => a.task_id === id)).toEqual([])
    // Someone not on it: it does not exist.
    expect((await get(p.plain, id)).status).toBe(404)
    expect((await act(p.plain, id, 'messages', { body: 'Hi' })).status).toBe(404)
    // The people on it see it, waiting for them.
    const mine = await get(p.admin2, id)
    expect(mine.body).toMatchObject({ isCreator: false, myState: 'todo', waitingForMe: true, canEdit: false })
    expect((await list(p.admin2, 'box=assigned&status=active')).map((t) => t.id)).toContain(id)
    expect(await counts(p.admin2)).toMatchObject({ assignedOpen: 1, toConfirm: 0 })
    expect((await list(p.creator, 'box=created&status=active')).map((t) => t.id)).toContain(id)
  })

  it('is worked by each person: started, written on with photos, done; the sender is told each time', async () => {
    expect((await act(p.admin2, id, 'seen')).status).toBe(204)
    const started = await act(p.admin2, id, 'state', { state: 'in_progress' })
    expect(started.status).toBe(200)
    expect(started.body.myState).toBe('in_progress')
    expect(started.body.assignees.find((a) => a.name === 'Second Admin')?.seenAt).toEqual(expect.any(String))
    expect((await alertsOf(p.creator.user.id))[0]).toMatchObject({ kind: 'task-updated', title: expect.stringMatching(/^Second Admin started T-\d+: Recheck the coil stock$/) })

    const photo = await uploadPhoto(p.admin2, 3)
    const wrote = await act(p.admin2, id, 'messages', { body: 'Bay 3 has 14 coils; two are wet.', imageIds: [photo.id] })
    expect(wrote.status).toBe(200)
    const message = wrote.body.messages.at(-1)!
    expect(message).toMatchObject({ kind: 'comment', authorName: 'Second Admin', body: 'Bay 3 has 14 coils; two are wet.', photos: [{ id: photo.id, width: 1600, height: 1200 }] })
    // The sender and the other person on it are told; the writer is not.
    expect((await alertsOf(p.creator.user.id))[0]).toMatchObject({ kind: 'task-updated', body: 'Bay 3 has 14 coils; two are wet.' })
    expect((await alertsOf(p.creator2.user.id))[0]).toMatchObject({ kind: 'task-updated' })
    // Someone else's photo cannot be sent; nor nothing at all.
    const theirs = await uploadPhoto(p.creator2, 4)
    expect((await act(p.admin2, id, 'messages', { body: '', imageIds: [theirs.id] })).status).toBe(400)
    expect((await act(p.admin2, id, 'messages', { body: '   ' })).status).toBe(400)

    const done = await act(p.admin2, id, 'state', { state: 'done', note: 'Counted and labelled.' })
    expect(done.body.myState).toBe('done')
    expect(done.body.waitingForMe).toBe(false)
    expect((await alertsOf(p.creator.user.id))[0]).toMatchObject({ kind: 'task-done', title: expect.stringMatching(/^Second Admin marked T-\d+: Recheck the coil stock done: confirm it or send it back$/), body: 'Counted and labelled.' })
    expect(await counts(p.creator)).toMatchObject({ toConfirm: 1 })
    expect(await counts(p.admin2)).toMatchObject({ assignedOpen: 0 })
    // Waiting for the sender: it is on their side now.
    expect((await get(p.creator, id)).body.waitingForMe).toBe(true)
    // Only the person can move their own part; a done part cannot be done twice.
    expect((await act(p.creator, id, 'state', { state: 'done' })).status).toBe(403)
    expect((await act(p.admin2, id, 'state', { state: 'done' })).status).toBe(409)
  })

  it('is sent back by the sender with why, and stays to do for that person', async () => {
    expect((await act(p.admin2, id, 'review', { userId: p.admin2.user.id, decision: 'reopen' })).status).toBe(403)
    const bare = await act(p.creator, id, 'review', { userId: p.admin2.user.id, decision: 'reopen' })
    expect(bare.status).toBe(400)
    expect(bare.body.error.message).toBe('Say what is still to be done, so they know.')
    const back = await act(p.creator, id, 'review', { userId: p.admin2.user.id, decision: 'reopen', note: 'Move the two wet coils inside first.' })
    expect(back.status).toBe(200)
    expect(back.body.assignees.find((a) => a.name === 'Second Admin')?.state).toBe('in_progress')
    expect(back.body.messages.at(-1)).toMatchObject({ kind: 'event', event: 'reopened', subjectName: 'Second Admin', body: 'Move the two wet coils inside first.' })
    expect((await alertsOf(p.admin2.user.id))[0]).toMatchObject({ kind: 'task-reopened', severity: 'warning', body: 'Move the two wet coils inside first.' })
    expect(await counts(p.admin2)).toMatchObject({ assignedOpen: 1 })
    // A part not marked done cannot be confirmed.
    expect((await act(p.creator, id, 'review', { userId: p.admin2.user.id, decision: 'confirm' })).status).toBe(409)
  })

  it('leaves a person’s list once their part is confirmed, and closes when everyone is', async () => {
    await act(p.admin2, id, 'state', { state: 'done' })
    // Two confirmations at once: one wins, the other meets it confirmed.
    const [a, b] = await Promise.all([
      act(p.creator, id, 'review', { userId: p.admin2.user.id, decision: 'confirm' }),
      act(p.creator, id, 'review', { userId: p.admin2.user.id, decision: 'confirm' }),
    ])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    expect((await alertsOf(p.admin2.user.id))[0].title).toMatch(/^Cara Creator confirmed your part of T-\d+/)
    expect((await list(p.admin2, 'box=assigned&status=active')).map((t) => t.id)).not.toContain(id)
    expect((await list(p.admin2, 'box=assigned&status=closed')).map((t) => t.id)).toContain(id)
    expect((await get(p.creator, id)).body.status).toBe('open')

    await act(p.creator2, id, 'state', { state: 'done' })
    const closed = await act(p.creator, id, 'review', { userId: p.creator2.user.id, decision: 'confirm' })
    expect(closed.body.status).toBe('closed')
    expect(closed.body.closedAt).toEqual(expect.any(String))
    expect(closed.body.messages.at(-1)?.event).toBe('closed')
    // A closed task takes no more changes.
    const late = await act(p.admin2, id, 'messages', { body: 'One more thing' })
    expect(late.status).toBe(409)
    expect(late.body.error.message).toBe('This task is closed.')
  })
})

describe('changing and withdrawing a task', () => {
  it('is its sender’s alone, recorded on the thread and in the audit log', async () => {
    const made = await send(p.plain, { title: 'Paint touch-up', assigneeIds: [p.creator.user.id], dueAt: inAnHour() })
    const id = made.body.id
    expect((await app.api('PATCH', `/api/tasks/${id}`, { token: p.creator.token, body: { title: 'Mine now' } })).status).toBe(403)
    const edited = await app.api<Res>('PATCH', `/api/tasks/${id}`, { token: p.plain.token, body: { title: 'Paint touch-up on rack 4', priority: 'urgent', dueAt: made.body.dueAt } })
    expect(edited.status).toBe(200)
    expect(edited.body).toMatchObject({ title: 'Paint touch-up on rack 4', priority: 'urgent' })
    expect(edited.body.messages.at(-1)?.event).toBe('edited')
    const audit = await app.db.query(`SELECT field, old_value, new_value FROM audit_log WHERE entity = 'Task' AND entity_id = $1 ORDER BY field`, [`T-${made.body.number}`])
    // Its sending, then each field changed (the deadline sent again unchanged is no change).
    expect(audit.rows).toEqual([
      { field: 'priority', old_value: 'normal', new_value: 'urgent' },
      { field: 'title', old_value: 'Paint touch-up', new_value: 'Paint touch-up on rack 4' },
      { field: null, old_value: null, new_value: null },
    ])
    expect((await alertsOf(p.creator.user.id))[0]).toMatchObject({ kind: 'task-updated' })

    const withdrawn = await act(p.plain, id, 'cancel', { note: 'Done by the night shift already.' })
    expect(withdrawn.body.status).toBe('cancelled')
    expect((await alertsOf(p.creator.user.id))[0]).toMatchObject({ title: expect.stringMatching(/^Paula Plain withdrew T-\d+/), body: 'Done by the night shift already.' })
    const late = await act(p.creator, id, 'state', { state: 'in_progress' })
    expect(late.status).toBe(409)
    expect(late.body.error.message).toBe('This task was withdrawn.')
    expect(await counts(p.creator)).toMatchObject({ assignedOpen: 0 })
  })

  it('closes for everyone at its sender’s word, each part confirmed as it stood', async () => {
    const made = await send(p.creator, { title: 'Clean the welding bay', assigneeIds: [p.admin2.user.id, p.creator2.user.id] })
    await act(p.admin2, made.body.id, 'state', { state: 'in_progress' })
    const closed = await act(p.creator, made.body.id, 'close', { note: 'Enough for today.' })
    expect(closed.body.status).toBe('closed')
    expect(closed.body.assignees.every((a) => a.state === 'confirmed')).toBe(true)
    expect((await alertsOf(p.creator2.user.id))[0].title).toMatch(/^Cara Creator closed T-\d+/)
  })
})
