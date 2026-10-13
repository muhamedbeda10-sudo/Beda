// ============================================================================
// Tasks, in words and in order: pure helpers the pages, the bell and their
// tests share.
// ============================================================================

import type { TaskAssigneeState, TaskPriority, TaskSummary } from '@qc/shared/tasks'

/** A task's name as people say it: "T-12". */
export const taskNumber = (t: Pick<TaskSummary, 'number'>) => `T-${t.number}`

/**
 * Active tasks in the order to work them: what waits on the viewer first,
 * then the overdue, then by deadline (none last), then the most urgent, then
 * the newest.
 */
export function workOrder<T extends Pick<TaskSummary, 'waitingForMe' | 'overdue' | 'dueAt' | 'priority' | 'createdAt'>>(tasks: readonly T[]): T[] {
  const rank: Record<TaskPriority, number> = { urgent: 0, high: 1, normal: 2 }
  return [...tasks].sort(
    (a, b) =>
      Number(b.waitingForMe) - Number(a.waitingForMe) ||
      Number(b.overdue) - Number(a.overdue) ||
      (a.dueAt === null ? 1 : 0) - (b.dueAt === null ? 1 : 0) ||
      (a.dueAt && b.dueAt ? Date.parse(a.dueAt) - Date.parse(b.dueAt) : 0) ||
      rank[a.priority] - rank[b.priority] ||
      Date.parse(b.createdAt) - Date.parse(a.createdAt),
  )
}

/** Where a task stands for the viewer, in a few words. */
export function standing(t: Pick<TaskSummary, 'status' | 'isCreator' | 'myState' | 'assignees'>): string {
  if (t.status === 'closed') return 'Closed'
  if (t.status === 'cancelled') return 'Withdrawn'
  const done = t.assignees.filter((a) => a.state === 'done').length
  if (t.isCreator && done > 0) return done === 1 ? '1 to confirm' : `${done} to confirm`
  if (t.myState === 'done') return 'Waiting for confirmation'
  if (t.myState === 'confirmed') return 'Your part is confirmed'
  if (t.myState === 'in_progress') return 'In progress'
  if (t.myState === 'todo') return 'To do'
  const confirmed = t.assignees.filter((a) => a.state === 'confirmed').length
  return `${confirmed} of ${t.assignees.length} confirmed`
}

/** How many of the people on it are at each step. */
export function progressOf(t: Pick<TaskSummary, 'assignees'>): Record<TaskAssigneeState, number> {
  const out: Record<TaskAssigneeState, number> = { todo: 0, in_progress: 0, done: 0, confirmed: 0 }
  for (const a of t.assignees) out[a.state]++
  return out
}
