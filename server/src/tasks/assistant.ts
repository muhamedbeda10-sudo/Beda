// ============================================================================
// Tasks in the AI assistant: the tools of a new conversation (loaded only
// when a question needs them, through the tool search), and the cards they
// leave.
//
//   • find_people — the people a task can be sent to, by name: their ids.
//   • propose_task — a task drafted as a card: what is to be done, to whom,
//     how urgent, by when (factory time). Checked as sending would check it;
//     nothing is sent until the person presses Send task on the card (then
//     tasks/service.ts sends it, checking it all again). A draft that
//     revises one of this conversation still waiting replaces its card.
//   • my_tasks — the person's tasks, sent by them and sent to them, with
//     where each person is on each: for "who has not done it", "what is
//     overdue", or to act on what is found.
//
// Each reads the person again: one who may no longer send tasks gets "not
// allowed" from the drafting tools, and a card is refused at its press.
// ============================================================================

import { randomUUID } from 'node:crypto'
import type Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import type { AiStreamEvent, AiTaskDraft, AiTaskPart } from '@qc/shared/ai'
import { TASK_DESCRIPTION_MAX, TASK_MAX_ASSIGNEES, TASK_PRIORITIES, TASK_TITLE_MAX, type TaskPriority } from '@qc/shared/tasks'
import type { Config } from '../config'
import type { Db, Queryable } from '../db/pool'
import type { ToolHandler, ToolOutcome } from '../ai/assistant'
import { describeIssues } from '../automations/draft'
import { HttpError, notFound } from '../lib/errors'
import { toPart, type ProposalRow } from './proposals'
import { createTask, listTasks, mayCreateTasks } from './service'

type ToolUse = Anthropic.Beta.BetaToolUseBlock

export const FIND_PEOPLE_TOOL_NAME = 'find_people'
export const PROPOSE_TASK_TOOL_NAME = 'propose_task'
export const MY_TASKS_TOOL_NAME = 'my_tasks'

/** People find_people returns at most. */
export const MAX_PEOPLE_FOUND = 30

export const FIND_PEOPLE_TOOL: Anthropic.Beta.BetaTool = {
  name: FIND_PEOPLE_TOOL_NAME,
  description:
    'Find the people a task can be sent to (active accounts of the app, not viewers), by part of their name or their role (inspector, supervisor, admin). ' +
    `Returns at most ${MAX_PEOPLE_FOUND}, each with its id, name and role: use these ids, exactly, as propose_task's assigneeIds.`,
  eager_input_streaming: true,
  input_schema: {
    type: 'object',
    properties: { query: { type: 'string', description: "Part of a person's name, or a role. Empty: everyone (the first ones)." } },
    additionalProperties: false,
  },
}

export const PROPOSE_TASK_TOOL: Anthropic.Beta.BetaTool = {
  name: PROPOSE_TASK_TOOL_NAME,
  description:
    'Show the person a card for a task to send: what is to be done, to whom, how urgent and by when, with Send task and Discard. Nothing is sent until they press Send task; each person it goes to is then told. ' +
    'Call it as soon as the request is clear (the card is the confirmation). Find the people first with find_people. ' +
    'Returns the card (its proposalId), or the exact problems to fix before calling again.',
  eager_input_streaming: true,
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: `What is to be done, in a line (at most ${TASK_TITLE_MAX} characters), in the person's language.` },
      description: { type: 'string', description: 'Optional. Details: where, what to check or do, what to send back (photos, figures). In the person\'s language.' },
      assigneeIds: { type: 'array', items: { type: 'string' }, description: `1 to ${TASK_MAX_ASSIGNEES} people's ids, from find_people.` },
      priority: { type: 'string', enum: [...TASK_PRIORITIES], description: 'normal (the default), high, or urgent for a safety or quality risk that cannot wait.' },
      due: { type: 'string', description: 'Optional. The deadline on the factory\'s clock, "YYYY-MM-DD HH:MM". Only one the person gave or agreed to.' },
      revisesProposalId: { type: 'string', description: 'Optional. When changing a card of this conversation still waiting: its proposalId. Its card is marked as replaced.' },
    },
    required: ['title', 'assigneeIds'],
    additionalProperties: false,
  },
}

export const MY_TASKS_TOOL: Anthropic.Beta.BetaTool = {
  name: MY_TASKS_TOOL_NAME,
  description:
    'The tasks of the person asking: the ones they sent (with where each person is on it) and the ones sent to them. ' +
    'Use it for questions about tasks (who has not done it, what is overdue, what waits for their confirmation), before proposing a task like one already sent, and to follow up on tasks. ' +
    'Each row: number (T-n), the link to its page, title, status, priority, deadline (factory time), overdue, who sent it, each person and their state (todo, in_progress, done = waiting for the sender to confirm, confirmed), and how many messages.',
  eager_input_streaming: true,
  input_schema: {
    type: 'object',
    properties: {
      box: { type: 'string', enum: ['sent', 'received', 'both'], description: 'sent: by the person; received: to the person; both (the default).' },
      status: { type: 'string', enum: ['active', 'closed', 'all'], description: 'active (the default): still open; closed: confirmed done or withdrawn; all.' },
    },
    additionalProperties: false,
  },
}

/** The tools of every new conversation of someone given the assistant (who may send tasks). */
export const TASK_TOOLS: readonly Anthropic.Beta.BetaTool[] = [FIND_PEOPLE_TOOL, PROPOSE_TASK_TOOL, MY_TASKS_TOOL]

const NOT_ALLOWED = 'Not allowed: this person may not send tasks (any more): only someone given the assistant. Tell them so; nothing was proposed.'

const ProposeInput = z
  .object({
    title: z.string(),
    description: z.string().nullish(),
    assigneeIds: z.array(z.string()),
    priority: z.string().nullish(),
    due: z.string().nullish(),
    revisesProposalId: z.string().nullish(),
  })
  .passthrough()
const FindInput = z.object({ query: z.string().nullish() }).passthrough()
const MyTasksInput = z.object({ box: z.enum(['sent', 'received', 'both']).nullish(), status: z.enum(['active', 'closed', 'all']).nullish() }).passthrough()

// ---- Factory time --------------------------------------------------------------------------

const clockOf = (timeZone: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })

/** How far the zone's clock is ahead of UTC at an instant, in ms. */
function offsetAt(at: number, timeZone: string): number {
  const parts = clockOf(timeZone).formatToParts(new Date(at))
  const n = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second')) - Math.floor(at / 1000) * 1000
}

/** "YYYY-MM-DD HH:MM" on the factory's clock as an instant; null when it is no such time. */
export function factoryInstant(wall: string, timeZone: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(wall.trim())
  if (!m) return null
  const [y, mo, d, h, mi] = m.slice(1).map(Number)
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null
  const asUtc = Date.UTC(y, mo - 1, d, h, mi)
  if (new Date(asUtc).getUTCDate() !== d) return null
  const o1 = offsetAt(asUtc, timeZone)
  const t1 = asUtc - o1
  const o2 = offsetAt(t1, timeZone)
  return new Date(o2 === o1 ? t1 : asUtc - o2).toISOString()
}

/** An instant as the factory's clock reads it: "YYYY-MM-DD HH:MM". */
export function factoryWall(iso: string, timeZone: string): string {
  const at = Date.parse(iso)
  return new Date(at + offsetAt(at, timeZone)).toISOString().slice(0, 16).replace('T', ' ')
}

// ---- Checking a draft -------------------------------------------------------------------------

/** A draft as sending would check it: every problem named, or the task as its card shows it. */
export async function checkTaskDraft(q: Queryable, input: unknown, now: Date, timeZone: string): Promise<{ errors: string[]; draft: AiTaskDraft | null; revises: string | null }> {
  const parsed = ProposeInput.safeParse(input)
  if (!parsed.success) return { errors: describeIssues(parsed.error), draft: null, revises: null }
  const i = parsed.data
  const errors: string[] = []
  const title = i.title.replace(/\s+/g, ' ').trim()
  if (title === '') errors.push('title: say what is to be done.')
  if (title.length > TASK_TITLE_MAX) errors.push(`title: at most ${TASK_TITLE_MAX} characters.`)
  const description = (i.description ?? '').trim()
  if (description.length > TASK_DESCRIPTION_MAX) errors.push(`description: at most ${TASK_DESCRIPTION_MAX} characters.`)
  const priority = (i.priority ?? 'normal').trim().toLowerCase()
  if (!(TASK_PRIORITIES as readonly string[]).includes(priority)) errors.push(`priority: one of ${TASK_PRIORITIES.join(', ')}.`)
  let dueAt: string | null = null
  if (i.due && i.due.trim() !== '') {
    dueAt = factoryInstant(i.due, timeZone)
    if (!dueAt) errors.push(`due: "YYYY-MM-DD HH:MM" on the factory's clock (${timeZone}).`)
    else if (Date.parse(dueAt) < now.getTime() - 5 * 60_000) errors.push(`due: ${i.due} has already passed (it is ${factoryWall(now.toISOString(), timeZone)} now).`)
  }
  const ids = [...new Set(i.assigneeIds.map((s) => s.trim()))]
  const uuids = ids.filter((s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s))
  if (ids.length === 0) errors.push('assigneeIds: at least one person, from find_people.')
  if (ids.length > TASK_MAX_ASSIGNEES) errors.push(`assigneeIds: at most ${TASK_MAX_ASSIGNEES} people.`)
  for (const bad of ids.filter((s) => !uuids.includes(s))) errors.push(`assigneeIds: "${bad}" is not a person's id: use the ids find_people returns.`)
  const { rows: people } = await q.query<{ id: string; name: string }>(
    `SELECT u.id, u.name FROM users u WHERE u.id = ANY($1::uuid[]) AND u.is_active AND u.deleted_at IS NULL AND NOT u.is_system AND u.role <> 'viewer'`,
    [uuids],
  )
  for (const id of uuids.filter((x) => !people.some((p) => p.id === x))) errors.push(`assigneeIds: no one a task can go to has the id ${id} (a viewer, or an account removed or deactivated).`)
  const revises = i.revisesProposalId?.trim() || null
  if (errors.length > 0) return { errors, draft: null, revises }
  const order = new Map(ids.map((id, k) => [id, k]))
  return {
    errors,
    draft: { title, description, priority: priority as TaskPriority, dueAt, assignees: people.sort((a, b) => order.get(a.id)! - order.get(b.id)!) },
    revises,
  }
}

// ---- Proposals ------------------------------------------------------------------------------------

/** One card of the person's, locked for its press; "not found" for anyone else's, or in a deleted conversation. */
async function lockProposal(tx: Queryable, id: string, userId: string): Promise<ProposalRow & { conversationId: string }> {
  const { rows } = await tx.query<ProposalRow & { conversationId: string }>(
    `SELECT p.id, p.tool_use_id AS "toolUseId", p.ok, p.error, p.draft, p.status, p.task_id AS "taskId", t.number AS "taskNumber", p.conversation_id AS "conversationId"
       FROM ai_task_proposals p JOIN ai_conversations c ON c.id = p.conversation_id LEFT JOIN tasks t ON t.id = p.task_id
      WHERE p.id = $1 AND p.user_id = $2 AND c.deleted_at IS NULL FOR UPDATE OF p`,
    [id, userId],
  )
  const p = rows[0]
  if (!p) throw notFound('That task card')
  return p
}

const ALREADY: Record<Exclude<AiTaskPart['state'], 'proposed'>, string> = {
  sent: 'This task was sent already.',
  discarded: 'This card was discarded. Ask the assistant again.',
  superseded: 'A newer version of this card was made below; use that one.',
}

/** A press the card no longer takes, with the card as it stands, so the app shows it so. */
const refused = (message: string, p: ProposalRow) => new HttpError(409, 'conflict', message, { part: toPart(p) })

/** Send task: the task made from the card, as its person, checked again as the Tasks page checks it; the card says so from then on. */
export async function sendTaskProposal(tx: Queryable, id: string, actor: { id: string; name: string }, timeZone: string, now = new Date()): Promise<AiTaskPart> {
  const p = await lockProposal(tx, id, actor.id)
  if (p.status !== 'proposed') throw refused(ALREADY[p.status], p)
  if (!p.ok || !p.draft) throw refused('This card did not pass its checks, so there is nothing to send. Ask the assistant to fix it.', p)
  if (!(await mayCreateTasks(tx, actor.id))) throw new HttpError(403, 'forbidden', 'Tasks are sent by the people given the AI assistant.')
  const d = p.draft
  const task = await createTask(
    tx,
    actor,
    { title: d.title, description: d.description, priority: d.priority, dueAt: d.dueAt, assigneeIds: d.assignees.map((a) => a.id) },
    { conversationId: p.conversationId, timeZone, now },
  )
  await tx.query(`UPDATE ai_task_proposals SET status = 'sent', task_id = $2, decided_at = now() WHERE id = $1`, [id, task.id])
  return toPart({ ...p, status: 'sent', taskId: task.id, taskNumber: task.number })
}

/** Discard: the card set aside; nothing is sent. */
export async function discardTaskProposal(tx: Queryable, id: string, userId: string): Promise<AiTaskPart> {
  const p = await lockProposal(tx, id, userId)
  if (p.status !== 'proposed') throw refused(ALREADY[p.status], p)
  if (!p.ok) throw refused('This card did not pass its checks; there is nothing to discard.', p)
  await tx.query(`UPDATE ai_task_proposals SET status = 'discarded', decided_at = now() WHERE id = $1`, [id])
  return toPart({ ...p, status: 'discarded' })
}

// ---- The tools ------------------------------------------------------------------------------------

export interface TaskToolContext {
  db: Db
  config: Config
  userId: string
  userName: string
  conversationId: string
  turnId: string
  emit: (event: AiStreamEvent) => void
  now?: () => Date
}

const answered = (tu: ToolUse, content: string): ToolOutcome => ({ result: { type: 'tool_result', tool_use_id: tu.id, content } })
const failed = (tu: ToolUse, content: string): ToolOutcome => ({ result: { type: 'tool_result', tool_use_id: tu.id, is_error: true, content } })

export function taskToolHandlers(ctx: TaskToolContext): Record<string, ToolHandler> {
  return {
    [FIND_PEOPLE_TOOL_NAME]: { run: (tu) => findPeople(ctx, tu) },
    [PROPOSE_TASK_TOOL_NAME]: { run: (tu) => propose(ctx, tu) },
    [MY_TASKS_TOOL_NAME]: { run: (tu) => myTasks(ctx, tu) },
  }
}

async function findPeople(ctx: TaskToolContext, tu: ToolUse): Promise<ToolOutcome> {
  if (!(await mayCreateTasks(ctx.db, ctx.userId))) return failed(tu, NOT_ALLOWED)
  const input = FindInput.safeParse(tu.input ?? {})
  if (!input.success) return failed(tu, describeIssues(input.error).join('\n'))
  const query = (input.data.query ?? '').trim().toLowerCase()
  // Matched as typed: a % or _ in it is no wildcard.
  const pattern = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
  const { rows } = await ctx.db.query<{ id: string; name: string; role: string }>(
    `SELECT u.id, u.name, u.role FROM users u
      WHERE u.is_active AND u.deleted_at IS NULL AND NOT u.is_system AND u.role <> 'viewer'
        AND ($1 = '' OR lower(u.name) LIKE $2 OR u.role::text = $1 OR lower(u.username) LIKE $2)
      ORDER BY u.name, u.id LIMIT $3`,
    [query, pattern, MAX_PEOPLE_FOUND + 1],
  )
  return answered(tu, JSON.stringify({ query, people: rows.slice(0, MAX_PEOPLE_FOUND), truncated: rows.length > MAX_PEOPLE_FOUND }))
}

async function propose(ctx: TaskToolContext, tu: ToolUse): Promise<ToolOutcome> {
  if (!(await mayCreateTasks(ctx.db, ctx.userId))) return failed(tu, NOT_ALLOWED)
  const now = ctx.now ? ctx.now() : new Date()
  const checked = await checkTaskDraft(ctx.db, tu.input, now, ctx.config.FACTORY_TIMEZONE)
  const errors = [...checked.errors]
  let supersedes: string | null = null
  if (checked.revises) {
    const { rows } = await ctx.db.query<{ id: string; status: AiTaskPart['state']; number: number | null }>(
      `SELECT p.id, p.status, t.number FROM ai_task_proposals p LEFT JOIN tasks t ON t.id = p.task_id
        WHERE p.id::text = $1 AND p.conversation_id = $2 AND p.user_id = $3`,
      [checked.revises, ctx.conversationId, ctx.userId],
    )
    const earlier = rows[0]
    if (!earlier) errors.push(`revisesProposalId: no task card of this conversation has the id ${checked.revises}.`)
    else if (earlier.status === 'sent') errors.push(`revisesProposalId: that card was sent already, as T-${earlier.number}. Changes to it are made on its task's page; propose a new task only if the person wants another one.`)
    else if (earlier.status === 'proposed') supersedes = earlier.id
  }
  const ok = errors.length === 0
  const record: ProposalRow = { id: randomUUID(), toolUseId: tu.id, ok, error: ok ? null : errors.join('\n'), draft: ok ? checked.draft : null, status: 'proposed', taskId: null, taskNumber: null }
  ctx.emit({ type: 'task', part: toPart(record) })
  const store = async (tx: Queryable) => {
    await tx.query(
      `INSERT INTO ai_task_proposals (id, conversation_id, turn_id, tool_use_id, user_id, draft, ok, error, revises_proposal_id) VALUES ($1, $2, $3, $4, $5, $6::json, $7, $8, $9)`,
      [record.id, ctx.conversationId, ctx.turnId, tu.id, ctx.userId, record.draft ? JSON.stringify(record.draft) : null, ok, record.error, supersedes],
    )
    if (ok && supersedes) await tx.query(`UPDATE ai_task_proposals SET status = 'superseded', decided_at = now() WHERE id = $1 AND status = 'proposed'`, [supersedes])
  }
  if (!ok) return { result: { type: 'tool_result', tool_use_id: tu.id, is_error: true, content: [`Not proposed. Fix these and call ${PROPOSE_TASK_TOOL_NAME} again:`, ...errors.map((e) => `- ${e}`)].join('\n') }, store }
  const d = checked.draft!
  const content = {
    proposed: true,
    proposalId: record.id,
    task: { title: d.title, to: d.assignees.map((a) => a.name), priority: d.priority, due: d.dueAt ? factoryWall(d.dueAt, ctx.config.FACTORY_TIMEZONE) : null },
    note:
      'Shown to the person as a card with Send task and Discard. Nothing is sent until they press Send task: say the card is ready, never that the task was sent. ' +
      'Once sent, each person is told, works it and marks it done; the person confirms each done on the Tasks page.' +
      (supersedes ? ' The card it revises is marked as replaced.' : ''),
  }
  return { result: { type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(content) }, store }
}

async function myTasks(ctx: TaskToolContext, tu: ToolUse): Promise<ToolOutcome> {
  const input = MyTasksInput.safeParse(tu.input ?? {})
  if (!input.success) return failed(tu, describeIssues(input.error).join('\n'))
  const box = input.data.box ?? 'both'
  const status = input.data.status ?? 'active'
  const tz = ctx.config.FACTORY_TIMEZONE
  const now = ctx.now ? ctx.now() : new Date()
  const read = async (which: 'created' | 'assigned') => (await listTasks(ctx.db, ctx.userId, { box: which, status, limit: 100 }, now)).tasks
  const sent = box === 'received' ? [] : await read('created')
  const received = box === 'sent' ? [] : await read('assigned')
  const row = (t: Awaited<ReturnType<typeof read>>[number]) => ({
    number: `T-${t.number}`,
    link: `/tasks/${t.id}`,
    title: t.title,
    status: t.status,
    priority: t.priority,
    due: t.dueAt ? factoryWall(t.dueAt, tz) : null,
    overdue: t.overdue,
    from: t.createdBy.name,
    people: t.assignees.map((a) => ({ name: a.name, state: a.state, read: !!a.seenAt })),
    messages: t.messageCount,
    lastActivity: factoryWall(t.lastActivityAt, tz),
  })
  return answered(tu, JSON.stringify({ now: factoryWall(now.toISOString(), tz), status, sent: sent.map(row), received: received.map(row) }))
}
