// ============================================================================
// Tasks (tasks/service.ts): sent by someone given the AI assistant to the
// people of the app, worked and followed to the end. A task exists only for
// the people on it: to anyone else every route answers "not found".
// ============================================================================

import { Router } from 'express'
import { z } from 'zod'
import {
  TASK_DESCRIPTION_MAX,
  TASK_MAX_ASSIGNEES,
  TASK_MAX_PHOTOS,
  TASK_MESSAGE_MAX,
  TASK_PRIORITIES,
  TASK_TITLE_MAX,
  type TaskCountsResponse,
  type TaskDetail,
  type TaskPerson,
  type TasksResponse,
} from '@qc/shared/tasks'
import type { AppContext } from '../context'
import { withTransaction } from '../db/pool'
import { HttpError, notFound } from '../lib/errors'
import { parse } from '../lib/validate'
import { requireUser } from '../auth/middleware'
import { addMessage, assignablePeople, createTask, endTask, listTasks, loadTask, markSeen, mayCreateTasks, reviewPart, setOwnState, taskCounts, updateTask } from '../tasks/service'

const uuid = z.string().uuid()
const dueAt = z.string().datetime({ offset: true }).nullable()
const note = z.string().max(TASK_MESSAGE_MAX).default('')

const createSchema = z
  .object({
    title: z.string().min(1).max(TASK_TITLE_MAX * 2),
    description: z.string().max(TASK_DESCRIPTION_MAX).optional(),
    priority: z.enum(TASK_PRIORITIES as [string, ...string[]]).optional(),
    dueAt: dueAt.optional(),
    assigneeIds: z.array(uuid).min(1, 'Choose at least one person to send the task to.').max(TASK_MAX_ASSIGNEES),
  })
  .strict()

const updateSchema = z
  .object({
    title: z.string().min(1).max(TASK_TITLE_MAX * 2).optional(),
    description: z.string().max(TASK_DESCRIPTION_MAX).optional(),
    priority: z.enum(TASK_PRIORITIES as [string, ...string[]]).optional(),
    dueAt: dueAt.optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change.')

const listQuery = z.object({
  box: z.enum(['assigned', 'created']).default('assigned'),
  status: z.enum(['active', 'closed', 'all']).default('active'),
  before: z.string().datetime({ offset: true }).optional(),
  beforeId: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
})

export function tasksRoutes(ctx: AppContext): Router {
  const r = Router()
  const db = ctx.db
  const actorOf = (req: Parameters<typeof requireUser>[0]) => {
    const u = requireUser(req)
    return { id: u.id, name: u.name }
  }

  /** What waits on the person, and whether they may send tasks. */
  r.get('/counts', async (req, res) => {
    const user = requireUser(req)
    const body: TaskCountsResponse = { ...(await taskCounts(db, user.id)), canCreate: await mayCreateTasks(db, user.id) }
    res.json(body)
  })

  r.get('/', async (req, res) => {
    const user = requireUser(req)
    const q = parse(listQuery, req.query)
    const before = q.before && q.beforeId ? { createdAt: q.before, id: q.beforeId } : null
    const body: TasksResponse = await listTasks(db, user.id, { box: q.box, status: q.status, before, limit: q.limit })
    res.json(body)
  })

  /** Who a task may be sent to: for the people who may send one. */
  r.get('/people', async (req, res) => {
    const user = requireUser(req)
    if (!(await mayCreateTasks(db, user.id))) throw new HttpError(403, 'forbidden', 'Tasks are sent by the people given the AI assistant.')
    const body: TaskPerson[] = await assignablePeople(db)
    res.json(body)
  })

  r.post('/', async (req, res) => {
    const actor = actorOf(req)
    const body = parse(createSchema, req.body)
    const made = await withTransaction(db, async (tx) => {
      // Read again in the transaction that sends it: access taken away a moment ago is taken away.
      if (!(await mayCreateTasks(tx, actor.id))) throw new HttpError(403, 'forbidden', 'Tasks are sent by the people given the AI assistant.')
      return createTask(tx, actor, { ...body, priority: body.priority as never }, { timeZone: ctx.config.FACTORY_TIMEZONE })
    })
    const task: TaskDetail = (await loadTask(db, made.id, actor.id))!
    res.status(201).json(task)
  })

  r.get('/:id', async (req, res) => {
    const user = requireUser(req)
    const task = await loadTask(db, parse(uuid, req.params.id), user.id)
    if (!task) throw notFound('That task')
    res.json(task)
  })

  /** Read for the first time by someone it was sent to: their sender sees it. */
  r.post('/:id/seen', async (req, res) => {
    const user = requireUser(req)
    await markSeen(db, parse(uuid, req.params.id), user.id)
    res.status(204).end()
  })

  const respond = async (id: string, userId: string, res: Parameters<Parameters<typeof r.get>[1]>[1]) => {
    const task = await loadTask(db, id, userId)
    if (!task) throw notFound('That task')
    res.json(task)
  }

  r.patch('/:id', async (req, res) => {
    const actor = actorOf(req)
    const id = parse(uuid, req.params.id)
    const patch = parse(updateSchema, req.body)
    await withTransaction(db, (tx) => updateTask(tx, id, actor, { ...patch, priority: patch.priority as never }))
    await respond(id, actor.id, res)
  })

  r.post('/:id/state', async (req, res) => {
    const actor = actorOf(req)
    const id = parse(uuid, req.params.id)
    const body = parse(z.object({ state: z.enum(['in_progress', 'done']), note }).strict(), req.body)
    await withTransaction(db, (tx) => setOwnState(tx, id, actor, body.state, body.note))
    await respond(id, actor.id, res)
  })

  r.post('/:id/review', async (req, res) => {
    const actor = actorOf(req)
    const id = parse(uuid, req.params.id)
    const body = parse(z.object({ userId: uuid, decision: z.enum(['confirm', 'reopen']), note }).strict(), req.body)
    await withTransaction(db, (tx) => reviewPart(tx, id, actor, body.userId, body.decision, body.note))
    await respond(id, actor.id, res)
  })

  r.post('/:id/close', async (req, res) => {
    const actor = actorOf(req)
    const id = parse(uuid, req.params.id)
    const body = parse(z.object({ note }).strict(), req.body ?? {})
    await withTransaction(db, (tx) => endTask(tx, id, actor, 'close', body.note))
    await respond(id, actor.id, res)
  })

  r.post('/:id/cancel', async (req, res) => {
    const actor = actorOf(req)
    const id = parse(uuid, req.params.id)
    const body = parse(z.object({ note }).strict(), req.body ?? {})
    await withTransaction(db, (tx) => endTask(tx, id, actor, 'cancel', body.note))
    await respond(id, actor.id, res)
  })

  r.post('/:id/messages', async (req, res) => {
    const actor = actorOf(req)
    const id = parse(uuid, req.params.id)
    const body = parse(z.object({ body: z.string().max(TASK_MESSAGE_MAX).default(''), imageIds: z.array(uuid).max(TASK_MAX_PHOTOS).default([]) }).strict(), req.body)
    await withTransaction(db, (tx) => addMessage(tx, id, actor, body.body, body.imageIds))
    await respond(id, actor.id, res)
  })

  return r
}
