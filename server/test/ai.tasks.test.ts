import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import type { ApiErrorBody } from '@qc/shared/api'
import type { AiMessagesResponse, AiStreamEvent, AiTaskPart, AiTaskProposalResponse } from '@qc/shared/ai'
import type { TaskDetail } from '@qc/shared/tasks'
import { TestApp, type Session } from './harness'
import { text } from './aiFake'
import { ask, grant, setUp, type People } from './automationsKit'
import { resultJson, systemOf, toolNames, toolUse } from './noticesKit'
import { factoryInstant, factoryWall, taskToolHandlers } from '../src/tasks/assistant'

// Tasks through the assistant: it finds the people by name, drafts the task
// as a card (what, to whom, how urgent, by when on the factory's clock), and
// nothing is sent until the person who asked presses Send task — then the
// task is made exactly as the Tasks page makes it, and each person is told.
// It also reads the person's own tasks, to answer about them. The model is
// the scripted stand-in.

const app = new TestApp()
let p: People
let tz: string

const findPeople = (query: string, id?: string) => toolUse('find_people', { query }, id)
const proposeTask = (input: unknown, id?: string) => toolUse('propose_task', input, id)
const myTasks = (input: unknown = {}, id?: string) => toolUse('my_tasks', input, id)

/** The results the model was sent back in call `k` (its last message). */
function resultsAt(k: number): Anthropic.Beta.BetaToolResultBlockParam[] {
  const messages = app.model.calls[k].params.messages
  return messages[messages.length - 1].content as Anthropic.Beta.BetaToolResultBlockParam[]
}

const taskEvents = (events: AiStreamEvent[]): AiTaskPart[] => events.filter((e): e is Extract<AiStreamEvent, { type: 'task' }> => e.type === 'task').map((e) => e.part)

/** Tomorrow at 10:00 on the factory's clock. */
function tomorrowAtTen(): string {
  return `${factoryWall(new Date(Date.now() + 86_400_000).toISOString(), tz).slice(0, 10)} 10:00`
}

function draft(over: Record<string, unknown> = {}) {
  return {
    title: 'Recheck the coil stock in bay 3',
    description: 'Count the coils and send a photo of the tags.',
    assigneeIds: [p.creator2.user.id, p.admin2.user.id],
    priority: 'high',
    due: tomorrowAtTen(),
    ...over,
  }
}

interface Proposed {
  part: AiTaskPart
  result: Anthropic.Beta.BetaToolResultBlockParam
  conversationId: string
  doneParts: AiTaskPart[]
}

/** The model drafts a task card in the person's conversation (a new one unless given). */
async function proposeInChat(as: Session, input: unknown, conversationId?: string): Promise<Proposed> {
  const before = app.model.calls.length
  app.model.reply({ content: [text('Here is the card.'), proposeTask(input)] }, { content: [text('The card is ready: press Send task to send it.')] })
  const res = await ask(app, as, 'Send a task', conversationId)
  expect(res.status, JSON.stringify(res.error)).toBe(200)
  const parts = taskEvents(res.events)
  expect(parts).toHaveLength(1)
  return {
    part: parts[0],
    result: resultsAt(before + 1)[0],
    conversationId: res.conversationId,
    doneParts: (res.done?.message.parts ?? []).filter((x): x is AiTaskPart => x.type === 'task'),
  }
}

const press = (as: Session, id: string, what: 'send' | 'discard') => app.api<AiTaskProposalResponse | ApiErrorBody>('POST', `/api/ai/task-proposals/${id}/${what}`, { token: as.token })
const refusal = (res: { body: unknown }) => (res.body as ApiErrorBody).error as { code: string; message: string; details?: { part: AiTaskPart } }

/** A conversation's task cards as its history shows them now. */
async function historyCards(as: Session, conversationId: string): Promise<AiTaskPart[]> {
  const res = await app.api<AiMessagesResponse>('GET', `/api/ai/conversations/${conversationId}/messages`, { token: as.token })
  expect(res.status).toBe(200)
  return res.body.messages.flatMap((m) => m.parts.filter((x): x is AiTaskPart => x.type === 'task'))
}

const taskCount = async (title: string) => (await app.db.query(`SELECT 1 FROM tasks WHERE title = $1`, [title])).rowCount

beforeAll(async () => {
  await app.start()
  p = await setUp(app)
  tz = app.config.FACTORY_TIMEZONE
})
afterAll(() => app.stop())
beforeEach(() => {
  app.model.reset()
  for (const s of Object.values(p)) app.aiLimiter.reset(s.user.id)
})

describe('the tools and the prompt', () => {
  it('gives everyone given the assistant the task tools, loaded on demand, and says how to use them', async () => {
    app.model.reply({ content: [text('Hi.')] })
    await ask(app, p.plain, 'Hello')
    expect(toolNames(app).slice(-9)).toEqual(['find_people', 'propose_task', 'my_tasks', 'update_playbook', 'list_saved_tables', 'save_table', 'update_saved_table', 'refresh_saved_table', 'remove_saved_table'])
    for (const tool of app.model.calls[0].params.tools!.slice(-9, -6)) expect(tool).toMatchObject({ defer_loading: true, eager_input_streaming: true })
    const system = systemOf(app)
    expect(system).toContain('# Tasks')
    expect(system).toContain('never say a task was sent; say the card is ready')
    expect(system).toContain('are answered from my_tasks, never from run_sql')
    expect(system).toContain('# Read-only, but for tasks\nYou cannot change anything in the system except tasks,')
  })

  it('reads the factory clock both ways, through a change of daylight saving time', () => {
    for (const wall of ['2026-01-15 09:30', '2026-07-15 09:30', '2026-10-30 23:59']) expect(factoryWall(factoryInstant(wall, tz)!, tz)).toBe(wall)
    expect(factoryInstant('2026-02-30 10:00', tz)).toBeNull()
    expect(factoryInstant('tomorrow at ten', tz)).toBeNull()
    expect(factoryInstant('2026-01-15 09:30', 'UTC')).toBe('2026-01-15T09:30:00.000Z')
  })
})

describe('finding people', () => {
  it('finds the people a task can go to by name or role, never viewers, with the ids to use', async () => {
    app.model.reply({ content: [findPeople('cyril'), findPeople('vera'), findPeople('supervisor'), findPeople('')] }, { content: [text('Found them.')] })
    await ask(app, p.plain, 'Who is Cyril?')
    const [cyril, vera, supervisors, everyone] = resultsAt(1).map((r) => resultJson<{ people: { id: string; name: string; role: string }[]; truncated: boolean }>(r))
    expect(cyril.people).toEqual([{ id: p.creator2.user.id, name: 'Cyril Second', role: 'inspector' }])
    expect(vera.people).toEqual([])
    expect(supervisors.people.map((x) => x.name)).toEqual(['Paula Plain'])
    expect(everyone.people.map((x) => x.name)).toEqual(['Cara Creator', 'Cyril Second', 'Owner Admin', 'Paula Plain', 'Second Admin'])
    expect(everyone.truncated).toBe(false)
  })
})

describe('a task card', () => {
  it('drafts the task as a card; Send task makes it as the Tasks page does, tells each person, and the card says so', async () => {
    const due = tomorrowAtTen()
    const proposed = await proposeInChat(p.plain, draft({ title: '  Recheck   the coil stock in bay 3 ' }))
    expect(proposed.part).toMatchObject({
      type: 'task',
      ok: true,
      state: 'proposed',
      draft: {
        title: 'Recheck the coil stock in bay 3',
        description: 'Count the coils and send a photo of the tags.',
        priority: 'high',
        dueAt: factoryInstant(due, tz),
        // In the order the model gave them.
        assignees: [
          { id: p.creator2.user.id, name: 'Cyril Second' },
          { id: p.admin2.user.id, name: 'Second Admin' },
        ],
      },
    })
    const told = resultJson<{ proposed: boolean; proposalId: string; task: { to: string[]; due: string }; note: string }>(proposed.result)
    expect(told).toMatchObject({ proposed: true, proposalId: proposed.part.proposalId, task: { to: ['Cyril Second', 'Second Admin'], due } })
    expect(told.note).toContain('never that the task was sent')
    expect(proposed.doneParts).toEqual([proposed.part])
    expect(await historyCards(p.plain, proposed.conversationId)).toEqual([proposed.part])
    // Nothing is sent until the button.
    expect(await taskCount('Recheck the coil stock in bay 3')).toBe(0)

    // Only the person who asked presses it.
    expect((await press(p.creator, proposed.part.proposalId, 'send')).status).toBe(404)
    const sent = await press(p.plain, proposed.part.proposalId, 'send')
    expect(sent.status, JSON.stringify(sent.body)).toBe(200)
    const part = (sent.body as AiTaskProposalResponse).part
    expect(part).toMatchObject({ state: 'sent', taskId: expect.any(String), taskNumber: expect.any(Number) })

    const task = (await app.api<TaskDetail>('GET', `/api/tasks/${part.taskId}`, { token: p.plain.token })).body
    expect(task).toMatchObject({ number: part.taskNumber, title: 'Recheck the coil stock in bay 3', priority: 'high', dueAt: factoryInstant(due, tz), status: 'open' })
    expect(task.assignees.map((a) => [a.name, a.state])).toEqual([
      ['Cyril Second', 'todo'],
      ['Second Admin', 'todo'],
    ])
    const { rows } = await app.db.query(`SELECT conversation_id AS "conversationId" FROM tasks WHERE id = $1`, [part.taskId])
    expect(rows[0].conversationId).toBe(proposed.conversationId)
    for (const s of [p.creator2, p.admin2]) {
      const alerts = await app.db.query(`SELECT kind FROM user_notifications WHERE user_id = $1 AND task_id = $2`, [s.user.id, part.taskId])
      expect(alerts.rows).toEqual([{ kind: 'task-assigned' }])
    }
    expect(await historyCards(p.plain, proposed.conversationId)).toEqual([part])

    // A second press (another tab) is refused with the card as it stands.
    const again = await press(p.plain, proposed.part.proposalId, 'send')
    expect(again.status).toBe(409)
    expect(refusal(again)).toMatchObject({ message: 'This task was sent already.', details: { part } })
    expect(await taskCount('Recheck the coil stock in bay 3')).toBe(1)
  })

  it('tells the model every problem of a draft, and keeps the failed card with nothing to press', async () => {
    const proposed = await proposeInChat(p.plain, {
      title: ' ',
      assigneeIds: ['Cyril', p.viewer.user.id],
      priority: 'asap',
      due: '2020-01-01 10:00',
    })
    expect(proposed.part).toMatchObject({ ok: false, state: 'proposed' })
    expect(proposed.part).not.toHaveProperty('draft')
    expect(proposed.result.is_error).toBe(true)
    const lines = String(proposed.result.content).split('\n')
    expect(lines[0]).toBe('Not proposed. Fix these and call propose_task again:')
    expect(lines.slice(1)).toEqual([
      '- title: say what is to be done.',
      '- priority: one of normal, high, urgent.',
      expect.stringMatching(/^- due: 2020-01-01 10:00 has already passed \(it is \d{4}-\d{2}-\d{2} \d{2}:\d{2} now\)\.$/),
      '- assigneeIds: "Cyril" is not a person\'s id: use the ids find_people returns.',
      `- assigneeIds: no one a task can go to has the id ${p.viewer.user.id} (a viewer, or an account removed or deactivated).`,
    ])
    expect(await historyCards(p.plain, proposed.conversationId)).toEqual([proposed.part])
    for (const what of ['send', 'discard'] as const) expect((await press(p.plain, proposed.part.proposalId, what)).status).toBe(409)

    const badDue = await proposeInChat(p.plain, draft({ due: 'tomorrow 10am' }))
    expect(String(badDue.result.content)).toContain(`- due: "YYYY-MM-DD HH:MM" on the factory's clock (${tz}).`)
  })

  it('replaces a card still waiting with its revision, and refuses to revise one already sent', async () => {
    const first = await proposeInChat(p.plain, draft({ title: 'Check the press guard' }))
    const second = await proposeInChat(p.plain, draft({ title: 'Check the press guard today', priority: 'urgent', revisesProposalId: first.part.proposalId }), first.conversationId)
    expect(second.part).toMatchObject({ ok: true, state: 'proposed' })
    expect(resultJson<{ note: string }>(second.result).note).toContain('The card it revises is marked as replaced.')
    expect((await historyCards(p.plain, first.conversationId)).map((c) => c.state)).toEqual(['superseded', 'proposed'])
    const stale = await press(p.plain, first.part.proposalId, 'send')
    expect(stale.status).toBe(409)
    expect(refusal(stale)).toMatchObject({ message: 'A newer version of this card was made below; use that one.', details: { part: { state: 'superseded' } } })

    const sent = (await press(p.plain, second.part.proposalId, 'send')).body as AiTaskProposalResponse
    const late = await proposeInChat(p.plain, draft({ title: 'Check it again', revisesProposalId: second.part.proposalId }), first.conversationId)
    expect(late.part.ok).toBe(false)
    expect(String(late.result.content)).toContain(`revisesProposalId: that card was sent already, as T-${sent.part.taskNumber}.`)
    // Another conversation's card is no card of this one.
    const other = await proposeInChat(p.plain, draft({ revisesProposalId: first.part.proposalId }))
    expect(String(other.result.content)).toContain(`revisesProposalId: no task card of this conversation has the id ${first.part.proposalId}.`)
  })

  it('discards a card: nothing is sent, and it can no longer be sent', async () => {
    const proposed = await proposeInChat(p.plain, draft({ title: 'Clean the paint booth filters' }))
    const discarded = await press(p.plain, proposed.part.proposalId, 'discard')
    expect(discarded.status).toBe(200)
    expect((discarded.body as AiTaskProposalResponse).part).toMatchObject({ state: 'discarded' })
    const late = await press(p.plain, proposed.part.proposalId, 'send')
    expect(late.status).toBe(409)
    expect(refusal(late).details?.part.state).toBe('discarded')
    expect(await taskCount('Clean the paint booth filters')).toBe(0)
    expect((await historyCards(p.plain, proposed.conversationId)).map((c) => c.state)).toEqual(['discarded'])
  })

  it('checks the person again at every call and every press', async () => {
    const proposed = await proposeInChat(p.plain, draft({ title: 'Count the spare rollers' }))
    await grant(app, p.owner, p.plain, { enabled: false })
    try {
      const refused = await press(p.plain, proposed.part.proposalId, 'send')
      expect(refused.status).toBe(403)
      expect(await taskCount('Count the spare rollers')).toBe(0)
      // The tools of a conversation begun before answer "not allowed" (run as the answer loop runs them).
      const { rows } = await app.db.query<{ id: string }>(`SELECT id FROM ai_turns WHERE conversation_id = $1 LIMIT 1`, [proposed.conversationId])
      const handlers = taskToolHandlers({ db: app.db, config: app.config, userId: p.plain.user.id, userName: 'Paula Plain', conversationId: proposed.conversationId, turnId: rows[0].id, emit: () => undefined })
      for (const [name, input] of [
        ['find_people', { query: 'cyril' }],
        ['propose_task', draft()],
      ] as const) {
        const tu = { type: 'tool_use', id: `toolu_${name}`, name, input } as Anthropic.Beta.BetaToolUseBlock
        const outcome = await handlers[name].run(tu, new AbortController().signal)
        expect(outcome.result).toMatchObject({ is_error: true, content: expect.stringMatching(/^Not allowed: this person may not send tasks/) })
        expect(outcome.store).toBeUndefined()
      }
    } finally {
      await grant(app, p.owner, p.plain)
    }
    expect((await press(p.plain, proposed.part.proposalId, 'send')).status).toBe(200)
  })
})

describe('reading the tasks', () => {
  it("answers from the person's own tasks: the ones they sent, with where each person is, and the ones sent to them", async () => {
    const proposed = await proposeInChat(p.plain, draft({ title: 'Measure the upright holes', assigneeIds: [p.creator2.user.id], due: null }))
    const sent = ((await press(p.plain, proposed.part.proposalId, 'send')).body as AiTaskProposalResponse).part
    expect((await app.api('POST', `/api/tasks/${sent.taskId}/state`, { token: p.creator2.token, body: { state: 'done' } })).status).toBe(200)

    type Row = { number: string; link: string; title: string; status: string; due: string | null; from: string; people: { name: string; state: string }[] }
    app.model.reply({ content: [myTasks({ box: 'sent' })] }, { content: [text('One waits for you.')] })
    await ask(app, p.plain, 'What did I send?')
    const mine = resultJson<{ sent: Row[]; received: Row[] }>(resultsAt(app.model.calls.length - 1)[0])
    const row = mine.sent.find((r) => r.title === 'Measure the upright holes')!
    expect(row).toMatchObject({ number: `T-${sent.taskNumber}`, link: `/tasks/${sent.taskId}`, status: 'open', due: null, from: 'Paula Plain', people: [{ name: 'Cyril Second', state: 'done' }] })
    expect(mine.received).toEqual([])

    app.model.reply({ content: [myTasks({ box: 'received' })] }, { content: [text('One.')] })
    await ask(app, p.creator2, 'What was I sent?')
    const theirs = resultJson<{ sent: Row[]; received: Row[] }>(resultsAt(app.model.calls.length - 1)[0])
    expect(theirs.received.map((r) => r.title)).toContain('Measure the upright holes')
    expect(theirs.sent).toEqual([])
    // Someone not on it never sees it.
    app.model.reply({ content: [myTasks()] }, { content: [text('None.')] })
    await ask(app, p.creator, 'My tasks?')
    const others = resultJson<{ sent: Row[]; received: Row[] }>(resultsAt(app.model.calls.length - 1)[0])
    expect([...others.sent, ...others.received].map((r) => r.title)).not.toContain('Measure the upright holes')
  })
})
