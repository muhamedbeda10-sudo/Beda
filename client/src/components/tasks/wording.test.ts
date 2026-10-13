import { describe, expect, it } from 'vitest'
import type { TaskAssignee, TaskSummary } from '@qc/shared/tasks'
import { progressOf, standing, taskNumber, workOrder } from './wording'

const person = (name: string, state: TaskAssignee['state']): TaskAssignee => ({ userId: name, name, state, stateAt: '2026-10-13T08:00:00.000Z' })
const task = (over: Partial<TaskSummary>): TaskSummary => ({
  id: over.id ?? 'x',
  number: 7,
  title: 'T',
  priority: 'normal',
  status: 'open',
  dueAt: null,
  overdue: false,
  createdBy: { id: 'c', name: 'Cara' },
  createdAt: '2026-10-13T08:00:00.000Z',
  updatedAt: '2026-10-13T08:00:00.000Z',
  assignees: [person('Ali', 'todo')],
  isCreator: false,
  waitingForMe: false,
  messageCount: 0,
  lastActivityAt: '2026-10-13T08:00:00.000Z',
  ...over,
})

describe('tasks in words and in order', () => {
  it('names a task by its number', () => {
    expect(taskNumber({ number: 12 })).toBe('T-12')
  })

  it('works what waits on the viewer first, then the overdue, then by deadline, priority and age', () => {
    const sorted = workOrder([
      task({ id: 'late-normal', dueAt: '2026-10-20T08:00:00.000Z' }),
      task({ id: 'no-due-urgent', priority: 'urgent' }),
      task({ id: 'overdue', overdue: true, dueAt: '2026-10-01T08:00:00.000Z' }),
      task({ id: 'waiting', waitingForMe: true }),
      task({ id: 'soon', dueAt: '2026-10-14T08:00:00.000Z' }),
      task({ id: 'no-due-newer', createdAt: '2026-10-13T09:00:00.000Z' }),
    ])
    expect(sorted.map((t) => t.id)).toEqual(['waiting', 'overdue', 'soon', 'late-normal', 'no-due-urgent', 'no-due-newer'])
  })

  it('says where a task stands for the viewer', () => {
    expect(standing(task({ myState: 'todo' }))).toBe('To do')
    expect(standing(task({ myState: 'done' }))).toBe('Waiting for confirmation')
    expect(standing(task({ isCreator: true, assignees: [person('Ali', 'done'), person('Mona', 'done'), person('Sam', 'todo')] }))).toBe('2 to confirm')
    expect(standing(task({ isCreator: true, assignees: [person('Ali', 'confirmed'), person('Sam', 'todo')] }))).toBe('1 of 2 confirmed')
    expect(standing(task({ status: 'cancelled' }))).toBe('Withdrawn')
    expect(standing(task({ status: 'closed' }))).toBe('Closed')
  })

  it('counts the people at each step', () => {
    expect(progressOf(task({ assignees: [person('A', 'done'), person('B', 'done'), person('C', 'confirmed')] }))).toEqual({ todo: 0, in_progress: 0, done: 2, confirmed: 1 })
  })
})
