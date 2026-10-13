// ============================================================================
// Tasks — what the routes (modules/tasks.routes.ts) and the assistant's tools
// do with them, each change in the caller's transaction:
//
//   • a task is read only by the people on it: its sender and the people it
//     was sent to. To anyone else it does not exist.
//   • who may send one: someone the assistant's owner gave the assistant to,
//     read again at each sending. Sent, it stays its sender's to follow, edit,
//     confirm, send back or withdraw, whatever happens to their access since.
//   • each person on a task moves their own part: to do → in progress → done
//     (and back from done to in progress while it waits). Done waits for the
//     sender: confirmed (final; it leaves the person's list) or sent back,
//     with why (in progress again, still theirs). The task closes once every
//     part is confirmed. Only an open task changes or takes messages.
//   • every change is written on the task's thread, and the people it
//     concerns are told in the bell (and by push), never the one who did it.
//   • state changes lock the task's row first: two presses at once are taken
//     one after the other, and the second meets the state the first left.
// ============================================================================

import {
  TASK_DESCRIPTION_MAX,
  TASK_MAX_ASSIGNEES,
  TASK_MAX_PHOTOS,
  TASK_MESSAGE_MAX,
  TASK_TITLE_MAX,
  assigneeMayMove,
  type CreateTaskRequest,
  type TaskAssignee,
  type TaskAssigneeState,
  type TaskBox,
  type TaskCountsResponse,
  type TaskDetail,
  type TaskEvent,
  type TaskListStatus,
  type TaskMessage,
  type TaskPerson,
  type TaskPriority,
  type TaskStatus,
  type TaskSummary,
  type UpdateTaskRequest,
} from '@qc/shared/tasks'
import type { UserNotificationKind } from '@qc/shared/automation'
import type { Queryable } from '../db/pool'
import { HttpError, badRequest, notFound } from '../lib/errors'
import { isGranted, loadAccess } from '../ai/access'
import { auditChanges, auditCreate } from '../audit/service'
import { clipText, createNotifications } from '../automations/notify'

/** Someone acting on tasks. */
export interface TaskActor {
  id: string
  name: string
}

/** Who may be sent a task: active people of the app, not read-only viewers, not the system sender. */
const ASSIGNABLE = `u.is_active AND u.deleted_at IS NULL AND NOT u.is_system AND u.role <> 'viewer'`

/** Whether this person may send tasks now: the assistant is theirs. */
export async function mayCreateTasks(q: Queryable, userId: string): Promise<boolean> {
  return isGranted(await loadAccess(q, userId))
}

/** The people a task may be sent to, by name. */
export async function assignablePeople(q: Queryable): Promise<TaskPerson[]> {
  const { rows } = await q.query<TaskPerson>(`SELECT u.id, u.name, u.role FROM users u WHERE ${ASSIGNABLE} ORDER BY u.name, u.id`)
  return rows
}

// ---- Reading ---------------------------------------------------------------------------

interface TaskRow {
  id: string
  number: number
  title: string
  description: string
  priority: TaskPriority
  status: TaskStatus
  dueAt: string | null
  creatorId: string
  creatorName: string
  createdAt: string
  updatedAt: string
  closedAt: string | null
  assignees: TaskAssignee[] | null
  messageCount: number
  lastActivityAt: string | null
}

const TASK_SELECT = `t.id, t.number, t.title, t.description, t.priority, t.status, t.due_at AS "dueAt",
  t.created_by_id AS "creatorId", t.created_by_name AS "creatorName", t.created_at AS "createdAt", t.updated_at AS "updatedAt", t.closed_at AS "closedAt",
  (SELECT json_agg(json_build_object('userId', a.user_id, 'name', a.user_name, 'state', a.state, 'stateAt', a.state_at,
                                     'doneAt', a.done_at, 'confirmedAt', a.confirmed_at, 'seenAt', a.seen_at) ORDER BY a.user_name, a.user_id)
     FROM task_assignees a WHERE a.task_id = t.id) AS assignees,
  (SELECT count(*)::int FROM task_messages m WHERE m.task_id = t.id AND m.kind = 'comment') AS "messageCount",
  (SELECT max(m.created_at) FROM task_messages m WHERE m.task_id = t.id) AS "lastActivityAt"`

/** A json timestamp as the API writes every other one: ISO, in UTC. */
const iso = (v: string | null | undefined): string | undefined => (v ? new Date(v).toISOString() : undefined)

const STILL_TO_DO: ReadonlySet<TaskAssigneeState> = new Set(['todo', 'in_progress'])

function toSummary(r: TaskRow, viewerId: string, now: Date): TaskSummary {
  const assignees: TaskAssignee[] = (r.assignees ?? []).map((a) => {
    const out: TaskAssignee = { userId: a.userId, name: a.name, state: a.state, stateAt: iso(a.stateAt)! }
    if (a.doneAt) out.doneAt = iso(a.doneAt)
    if (a.confirmedAt) out.confirmedAt = iso(a.confirmedAt)
    if (a.seenAt) out.seenAt = iso(a.seenAt)
    return out
  })
  const mine = assignees.find((a) => a.userId === viewerId)
  const isCreator = r.creatorId === viewerId
  const open = r.status === 'open'
  const dueAt = r.dueAt ? new Date(r.dueAt).toISOString() : null
  const s: TaskSummary = {
    id: r.id,
    number: r.number,
    title: r.title,
    priority: r.priority,
    status: r.status,
    dueAt,
    overdue: open && dueAt !== null && new Date(dueAt) < now && assignees.some((a) => STILL_TO_DO.has(a.state)),
    createdBy: { id: r.creatorId, name: r.creatorName },
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
    assignees,
    isCreator,
    waitingForMe: open && ((!!mine && STILL_TO_DO.has(mine.state)) || (isCreator && assignees.some((a) => a.state === 'done'))),
    messageCount: r.messageCount,
    lastActivityAt: new Date(r.lastActivityAt ?? r.createdAt).toISOString(),
  }
  if (r.closedAt) s.closedAt = new Date(r.closedAt).toISOString()
  if (mine) s.myState = mine.state
  return s
}

/** The viewer is on the task: its sender, or one of the people it went to. */
const PARTICIPANT = `(t.created_by_id = $2 OR EXISTS (SELECT 1 FROM task_assignees p WHERE p.task_id = t.id AND p.user_id = $2))`

/**
 * A box of the viewer's tasks, newest first, `limit` a page (`before`: the
 * last one of the page read). assigned: sent to them — active while it is
 * open and their part not confirmed; created: sent by them — active while open.
 */
export async function listTasks(
  q: Queryable,
  viewerId: string,
  opts: { box: TaskBox; status: TaskListStatus; before?: { createdAt: string; id: string } | null; limit: number },
  now = new Date(),
): Promise<{ tasks: TaskSummary[]; hasMore: boolean }> {
  const where: string[] = []
  if (opts.box === 'assigned') {
    const mine =
      opts.status === 'active'
        ? `AND t.status = 'open' AND a.state <> 'confirmed'`
        : opts.status === 'closed'
          ? `AND (t.status <> 'open' OR a.state = 'confirmed')`
          : ''
    where.push(`EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = t.id AND a.user_id = $1 ${mine})`)
  } else {
    where.push(`t.created_by_id = $1`)
    if (opts.status === 'active') where.push(`t.status = 'open'`)
    if (opts.status === 'closed') where.push(`t.status <> 'open'`)
  }
  const params: unknown[] = [viewerId, opts.limit + 1]
  if (opts.before) {
    params.push(opts.before.createdAt, opts.before.id)
    where.push(`(t.created_at, t.id) < ($3::timestamptz, $4::uuid)`)
  }
  const { rows } = await q.query<TaskRow>(`SELECT ${TASK_SELECT} FROM tasks t WHERE ${where.join(' AND ')} ORDER BY t.created_at DESC, t.id DESC LIMIT $2`, params)
  return { tasks: rows.slice(0, opts.limit).map((r) => toSummary(r, viewerId, now)), hasMore: rows.length > opts.limit }
}

/** One task with its thread, for someone on it; null for anyone else (or none such). */
export async function loadTask(q: Queryable, id: string, viewerId: string, now = new Date()): Promise<TaskDetail | null> {
  const { rows } = await q.query<TaskRow>(`SELECT ${TASK_SELECT} FROM tasks t WHERE t.id = $1 AND ${PARTICIPANT}`, [id, viewerId])
  const r = rows[0]
  if (!r) return null
  const messages = await q.query<{ id: string; kind: 'comment' | 'event'; authorId: string; authorName: string; body: string; event: TaskEvent | null; subjectName: string | null; createdAt: string; photos: TaskMessage['photos'] }>(
    `SELECT m.id, m.kind, m.author_id AS "authorId", m.author_name AS "authorName", m.body, m.event, m.subject_name AS "subjectName", m.created_at AS "createdAt",
            COALESCE((SELECT json_agg(json_build_object('id', i.id, 'thumbnailDataUrl', i.thumbnail_data_url, 'width', i.width, 'height', i.height) ORDER BY mi.position)
                        FROM task_message_images mi JOIN images i ON i.id = mi.image_id WHERE mi.message_id = m.id), '[]'::json) AS photos
       FROM task_messages m WHERE m.task_id = $1 ORDER BY m.seq`,
    [id],
  )
  const summary = toSummary(r, viewerId, now)
  return {
    ...summary,
    description: r.description,
    canEdit: summary.isCreator && r.status === 'open',
    messages: messages.rows.map((m) => {
      const out: TaskMessage = { id: m.id, kind: m.kind, authorId: m.authorId, authorName: m.authorName, body: m.body, photos: m.photos, createdAt: new Date(m.createdAt).toISOString() }
      if (m.event) out.event = m.event
      if (m.subjectName) out.subjectName = m.subjectName
      return out
    }),
  }
}

/** What waits on the viewer: their parts to do (and how many overdue), and the dones they sent to confirm. */
export async function taskCounts(q: Queryable, userId: string): Promise<Omit<TaskCountsResponse, 'canCreate'>> {
  const { rows } = await q.query<{ assignedOpen: number; assignedOverdue: number; toConfirm: number }>(
    `SELECT
       (SELECT count(*)::int FROM task_assignees a JOIN tasks t ON t.id = a.task_id
         WHERE a.user_id = $1 AND t.status = 'open' AND a.state IN ('todo', 'in_progress')) AS "assignedOpen",
       (SELECT count(*)::int FROM task_assignees a JOIN tasks t ON t.id = a.task_id
         WHERE a.user_id = $1 AND t.status = 'open' AND a.state IN ('todo', 'in_progress') AND t.due_at < now()) AS "assignedOverdue",
       (SELECT count(*)::int FROM task_assignees a JOIN tasks t ON t.id = a.task_id
         WHERE t.created_by_id = $1 AND t.status = 'open' AND a.state = 'done') AS "toConfirm"`,
    [userId],
  )
  return rows[0]
}

// ---- Changing ---------------------------------------------------------------------------

/** The task, locked for a change; refused unless the actor is on it (as `as` requires) and it is open. */
async function lockTask(
  tx: Queryable,
  id: string,
  actorId: string,
  as: 'creator' | 'assignee' | 'participant',
): Promise<{ id: string; number: number; title: string; status: TaskStatus; creatorId: string; creatorName: string; dueAt: string | null; priority: TaskPriority; description: string }> {
  const { rows } = await tx.query<{ id: string; number: number; title: string; status: TaskStatus; creatorId: string; creatorName: string; dueAt: string | null; priority: TaskPriority; description: string; onIt: boolean }>(
    `SELECT t.id, t.number, t.title, t.status, t.created_by_id AS "creatorId", t.created_by_name AS "creatorName", t.due_at AS "dueAt", t.priority, t.description,
            EXISTS (SELECT 1 FROM task_assignees p WHERE p.task_id = t.id AND p.user_id = $2) AS "onIt"
       FROM tasks t WHERE t.id = $1 FOR UPDATE`,
    [id, actorId],
  )
  const t = rows[0]
  const creator = t?.creatorId === actorId
  if (!t || (!creator && !t.onIt)) throw notFound('That task')
  if (as === 'creator' && !creator) throw new HttpError(403, 'forbidden', 'Only the person who sent the task can do that.')
  if (as === 'assignee' && !t.onIt) throw new HttpError(403, 'forbidden', 'This task was not sent to you.')
  if (t.status !== 'open') throw new HttpError(409, 'conflict', t.status === 'cancelled' ? 'This task was withdrawn.' : 'This task is closed.')
  return t
}

const taskName = (t: { number: number; title: string }) => `T-${t.number}: ${t.title}`
const taskLink = (id: string) => `/tasks/${id}`

async function writeMessage(
  tx: Queryable,
  m: { taskId: string; author: TaskActor; kind: 'comment' | 'event'; body?: string; event?: TaskEvent; subject?: TaskActor | null },
): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO task_messages (task_id, author_id, author_name, kind, body, event, subject_id, subject_name) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [m.taskId, m.author.id, m.author.name, m.kind, m.body ?? '', m.event ?? null, m.subject?.id ?? null, m.subject?.name ?? null],
  )
  return rows[0].id
}

/** Tell people of a change in the bell (and by push): never the person who made it. */
async function tell(tx: Queryable, to: readonly string[], actorId: string, n: { kind: UserNotificationKind; severity?: 'info' | 'warning' | 'critical'; title: string; body?: string; taskId: string }): Promise<void> {
  const ids = [...new Set(to)].filter((id) => id !== actorId)
  if (ids.length === 0) return
  await createNotifications(tx, ids, { kind: n.kind, severity: n.severity ?? 'info', title: n.title, body: n.body ?? '', link: taskLink(n.taskId), taskId: n.taskId })
}

/** The people still working on it: everyone on it but those confirmed done. */
async function workingOn(tx: Queryable, taskId: string): Promise<string[]> {
  const { rows } = await tx.query<{ id: string }>(`SELECT user_id AS id FROM task_assignees WHERE task_id = $1 AND state <> 'confirmed'`, [taskId])
  return rows.map((r) => r.id)
}

/** A deadline as given: a real instant, not already past, within two years. */
function checkDue(dueAt: string | null | undefined, now: Date): string | null {
  if (dueAt === undefined || dueAt === null) return null
  const t = Date.parse(dueAt)
  if (!Number.isFinite(t)) throw badRequest('The deadline is not a date and time.')
  if (t < now.getTime() - 5 * 60_000) throw badRequest('The deadline has already passed. Choose a later one.')
  if (t > now.getTime() + 2 * 366 * 86_400_000) throw badRequest('The deadline is more than two years away.')
  return new Date(t).toISOString()
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

/** An instant as the factory reads it: YYYY-MM-DD HH:MM on its clock. */
function factoryTime(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso))
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`
}

const SEVERITY: Record<TaskPriority, 'info' | 'warning' | 'critical'> = { normal: 'info', high: 'warning', urgent: 'critical' }

/** Send a task: its row, its people, the first line of its thread, and each of them told. Returns its id. */
export async function createTask(
  tx: Queryable,
  creator: TaskActor,
  req: CreateTaskRequest,
  opts: { conversationId?: string | null; now?: Date; timeZone: string },
): Promise<{ id: string; number: number }> {
  const now = opts.now ?? new Date()
  const title = oneLine(req.title)
  if (title === '') throw badRequest('Give the task a title.')
  if (title.length > TASK_TITLE_MAX) throw badRequest(`A task's title is at most ${TASK_TITLE_MAX} characters.`)
  const description = (req.description ?? '').trim()
  if (description.length > TASK_DESCRIPTION_MAX) throw badRequest(`A task's description is at most ${TASK_DESCRIPTION_MAX} characters.`)
  const ids = [...new Set(req.assigneeIds)]
  if (ids.length === 0) throw badRequest('Choose at least one person to send the task to.')
  if (ids.length > TASK_MAX_ASSIGNEES) throw badRequest(`A task goes to at most ${TASK_MAX_ASSIGNEES} people.`)
  const priority = req.priority ?? 'normal'
  const dueAt = checkDue(req.dueAt, now)
  const { rows: people } = await tx.query<{ id: string; name: string }>(`SELECT u.id, u.name FROM users u WHERE u.id = ANY($1::uuid[]) AND ${ASSIGNABLE}`, [ids])
  if (people.length !== ids.length) throw badRequest('Someone chosen cannot be sent a task (a removed or deactivated account, or a viewer). Choose again.')
  const { rows } = await tx.query<{ id: string; number: number }>(
    `INSERT INTO tasks (title, description, priority, due_at, created_by_id, created_by_name, conversation_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, number`,
    [title, description, priority, dueAt, creator.id, creator.name, opts.conversationId ?? null],
  )
  const task = rows[0]
  for (const p of people) await tx.query(`INSERT INTO task_assignees (task_id, user_id, user_name) VALUES ($1, $2, $3)`, [task.id, p.id, p.name])
  await writeMessage(tx, { taskId: task.id, author: creator, kind: 'event', event: 'created' })
  await auditCreate(tx, { userId: creator.id, userName: creator.name, entity: 'Task', entityId: `T-${task.number}` }, now.toISOString())
  const due = dueAt ? ` Deadline: ${factoryTime(dueAt, opts.timeZone)}.` : ''
  await tell(tx, people.map((p) => p.id), creator.id, {
    kind: 'task-assigned',
    severity: SEVERITY[priority],
    title: `New task from ${creator.name}: ${taskName({ number: task.number, title })}`,
    body: `${clipText(description, 400)}${due}`.trim(),
    taskId: task.id,
  })
  return task
}

/** The sender changes the task's words, priority or deadline; the people still on it are told. */
export async function updateTask(tx: Queryable, id: string, actor: TaskActor, patch: UpdateTaskRequest, now = new Date()): Promise<void> {
  const t = await lockTask(tx, id, actor.id, 'creator')
  // The deadline as stored, as an instant: one sent again unchanged is kept, even once it has passed.
  const currentDue = t.dueAt ? new Date(t.dueAt).toISOString() : null
  const sameDue = (v: string | null) => (v === null ? currentDue === null : currentDue !== null && Date.parse(v) === Date.parse(currentDue))
  const next = {
    title: patch.title !== undefined ? oneLine(patch.title) : t.title,
    description: patch.description !== undefined ? patch.description.trim() : t.description,
    priority: patch.priority ?? t.priority,
    dueAt: patch.dueAt === undefined || sameDue(patch.dueAt) ? currentDue : checkDue(patch.dueAt, now),
  }
  if (next.title === '') throw badRequest('Give the task a title.')
  if (next.title.length > TASK_TITLE_MAX) throw badRequest(`A task's title is at most ${TASK_TITLE_MAX} characters.`)
  if (next.description.length > TASK_DESCRIPTION_MAX) throw badRequest(`A task's description is at most ${TASK_DESCRIPTION_MAX} characters.`)
  const before = { title: t.title, description: t.description, priority: t.priority, dueAt: currentDue }
  const changed = await auditChanges(tx, { userId: actor.id, userName: actor.name, entity: 'Task', entityId: `T-${t.number}` }, before, next, now.toISOString())
  if (changed === 0) return
  await tx.query(`UPDATE tasks SET title = $2, description = $3, priority = $4, due_at = $5 WHERE id = $1`, [id, next.title, next.description, next.priority, next.dueAt])
  await writeMessage(tx, { taskId: id, author: actor, kind: 'event', event: 'edited' })
  await tell(tx, await workingOn(tx, id), actor.id, { kind: 'task-updated', title: `${actor.name} changed ${taskName({ number: t.number, title: next.title })}`, taskId: id })
}

/** Someone on the task moves their own part: in progress, or done (and back to in progress before it is confirmed). */
export async function setOwnState(tx: Queryable, id: string, actor: TaskActor, state: 'in_progress' | 'done', note = ''): Promise<void> {
  const t = await lockTask(tx, id, actor.id, 'assignee')
  const { rows } = await tx.query<{ state: TaskAssigneeState }>(`SELECT state FROM task_assignees WHERE task_id = $1 AND user_id = $2 FOR UPDATE`, [id, actor.id])
  const from = rows[0].state
  if (!assigneeMayMove(from, state)) {
    throw new HttpError(409, 'conflict', from === 'confirmed' ? 'Your part is already confirmed done.' : from === state ? `It is already ${state === 'done' ? 'done' : 'in progress'}.` : 'That change is not possible now.')
  }
  const body = note.trim()
  if (body.length > TASK_MESSAGE_MAX) throw badRequest(`A note is at most ${TASK_MESSAGE_MAX} characters.`)
  await tx.query(
    `UPDATE task_assignees SET state = $3, state_at = now(), done_at = CASE WHEN $3 = 'done' THEN now() ELSE NULL END WHERE task_id = $1 AND user_id = $2`,
    [id, actor.id, state],
  )
  const event: TaskEvent = state === 'done' ? 'done' : from === 'done' ? 'undone' : 'started'
  await writeMessage(tx, { taskId: id, author: actor, kind: 'event', event, body })
  const name = taskName(t)
  await tell(tx, [t.creatorId], actor.id, {
    kind: event === 'done' ? 'task-done' : 'task-updated',
    title: event === 'done' ? `${actor.name} marked ${name} done: confirm it or send it back` : event === 'started' ? `${actor.name} started ${name}` : `${actor.name} took ${name} back to in progress`,
    body: clipText(body, 400),
    taskId: id,
  })
}

/**
 * The sender, on someone's done: confirmed (final: it leaves their list), or
 * sent back with why (in progress again). The last confirmation closes the task.
 */
export async function reviewPart(tx: Queryable, id: string, actor: TaskActor, userId: string, decision: 'confirm' | 'reopen', note = ''): Promise<{ closed: boolean }> {
  const t = await lockTask(tx, id, actor.id, 'creator')
  const { rows } = await tx.query<{ state: TaskAssigneeState; name: string }>(`SELECT state, user_name AS name FROM task_assignees WHERE task_id = $1 AND user_id = $2 FOR UPDATE`, [id, userId])
  const part = rows[0]
  if (!part) throw notFound('That person on the task')
  if (part.state !== 'done') throw new HttpError(409, 'conflict', `${part.name} has not marked it done${part.state === 'confirmed' ? ': it is confirmed already' : ' yet'}.`)
  const body = note.trim()
  if (body.length > TASK_MESSAGE_MAX) throw badRequest(`A note is at most ${TASK_MESSAGE_MAX} characters.`)
  if (decision === 'reopen' && body === '') throw badRequest('Say what is still to be done, so they know.')
  const subject = { id: userId, name: part.name }
  if (decision === 'confirm') {
    await tx.query(`UPDATE task_assignees SET state = 'confirmed', state_at = now(), confirmed_at = now() WHERE task_id = $1 AND user_id = $2`, [id, userId])
    await writeMessage(tx, { taskId: id, author: actor, kind: 'event', event: 'confirmed', subject, body })
    await tell(tx, [userId], actor.id, { kind: 'task-updated', title: `${actor.name} confirmed your part of ${taskName(t)} done`, body: clipText(body, 400), taskId: id })
  } else {
    await tx.query(`UPDATE task_assignees SET state = 'in_progress', state_at = now(), done_at = NULL WHERE task_id = $1 AND user_id = $2`, [id, userId])
    await writeMessage(tx, { taskId: id, author: actor, kind: 'event', event: 'reopened', subject, body })
    await tell(tx, [userId], actor.id, { kind: 'task-reopened', severity: 'warning', title: `${actor.name} sent ${taskName(t)} back: not done yet`, body: clipText(body, 400), taskId: id })
  }
  return { closed: await closeIfAllConfirmed(tx, id, actor) }
}

/** Every part confirmed: the task closes, and its thread says so. */
async function closeIfAllConfirmed(tx: Queryable, id: string, actor: TaskActor): Promise<boolean> {
  const { rows } = await tx.query<{ left: number }>(`SELECT count(*)::int AS left FROM task_assignees WHERE task_id = $1 AND state <> 'confirmed'`, [id])
  if (rows[0].left > 0) return false
  await tx.query(`UPDATE tasks SET status = 'closed', closed_at = now() WHERE id = $1`, [id])
  await writeMessage(tx, { taskId: id, author: actor, kind: 'event', event: 'closed' })
  return true
}

/** The sender closes the task for everyone (each part confirmed as it stands), or withdraws it. */
export async function endTask(tx: Queryable, id: string, actor: TaskActor, how: 'close' | 'cancel', note = '', now = new Date()): Promise<void> {
  const t = await lockTask(tx, id, actor.id, 'creator')
  const body = note.trim()
  if (body.length > TASK_MESSAGE_MAX) throw badRequest(`A note is at most ${TASK_MESSAGE_MAX} characters.`)
  const still = await workingOn(tx, id)
  if (how === 'close') {
    await tx.query(
      `UPDATE task_assignees SET state = 'confirmed', state_at = now(), done_at = COALESCE(done_at, now()), confirmed_at = now() WHERE task_id = $1 AND state <> 'confirmed'`,
      [id],
    )
    await tx.query(`UPDATE tasks SET status = 'closed', closed_at = now() WHERE id = $1`, [id])
    await writeMessage(tx, { taskId: id, author: actor, kind: 'event', event: 'closed', body })
    await tell(tx, still, actor.id, { kind: 'task-updated', title: `${actor.name} closed ${taskName(t)}`, body: clipText(body, 400), taskId: id })
  } else {
    await tx.query(`UPDATE tasks SET status = 'cancelled', closed_at = now() WHERE id = $1`, [id])
    await writeMessage(tx, { taskId: id, author: actor, kind: 'event', event: 'cancelled', body })
    await auditChanges(tx, { userId: actor.id, userName: actor.name, entity: 'Task', entityId: `T-${t.number}` }, { status: 'open' }, { status: 'cancelled' }, now.toISOString())
    await tell(tx, still, actor.id, { kind: 'task-updated', title: `${actor.name} withdrew ${taskName(t)}`, body: clipText(body, 400), taskId: id })
  }
}

/** Words and photos on the task's thread, from someone on it; the others on it are told. */
export async function addMessage(tx: Queryable, id: string, actor: TaskActor, body: string, imageIds: readonly string[] = []): Promise<string> {
  const t = await lockTask(tx, id, actor.id, 'participant')
  const text = body.trim()
  if (text.length > TASK_MESSAGE_MAX) throw badRequest(`A message is at most ${TASK_MESSAGE_MAX} characters.`)
  const photos = [...new Set(imageIds)]
  if (photos.length > TASK_MAX_PHOTOS) throw badRequest(`A message carries at most ${TASK_MAX_PHOTOS} photos.`)
  if (text === '' && photos.length === 0) throw badRequest('Write something, or add a photo.')
  if (photos.length > 0) {
    const { rows } = await tx.query<{ id: string }>(`SELECT id FROM images WHERE id = ANY($1::uuid[]) AND uploaded_by_id = $2 AND deleted_at IS NULL`, [photos, actor.id])
    if (rows.length !== photos.length) throw badRequest('One of the photos is not yours to send, or is gone. Add it again.')
  }
  const messageId = await writeMessage(tx, { taskId: id, author: actor, kind: 'comment', body: text })
  for (const [position, imageId] of photos.entries()) {
    await tx.query(`INSERT INTO task_message_images (message_id, image_id, position) VALUES ($1, $2, $3)`, [messageId, imageId, position])
  }
  const said = text !== '' ? clipText(text, 400) : `${photos.length} ${photos.length === 1 ? 'photo' : 'photos'}`
  await tell(tx, [t.creatorId, ...(await workingOn(tx, id))], actor.id, { kind: 'task-updated', title: `${actor.name} wrote on ${taskName(t)}`, body: said, taskId: id })
  return messageId
}

/** Someone on the task opened it: their sender sees it was read. Once. */
export async function markSeen(q: Queryable, id: string, userId: string): Promise<void> {
  await q.query(`UPDATE task_assignees SET seen_at = now() WHERE task_id = $1 AND user_id = $2 AND seen_at IS NULL`, [id, userId])
}
