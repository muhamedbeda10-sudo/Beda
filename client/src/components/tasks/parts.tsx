// ============================================================================
// Tasks' small pieces: the badges for a person's part and a task's priority,
// its deadline on the factory's clock (red once missed), and its people's
// progress as a bar.
// ============================================================================

import { CalendarClock } from 'lucide-react'
import { TASK_PRIORITY_LABEL, TASK_STATE_LABEL, type TaskAssigneeState, type TaskPriority, type TaskSummary } from '@qc/shared/tasks'
import { Badge, type BadgeTone } from '@/components/ui'
import { factoryMoment, factoryTimestamp } from '@/components/followUps/wording'
import { cn } from '@/lib/utils'
import { progressOf } from './wording'

const STATE_TONE: Record<TaskAssigneeState, BadgeTone> = { todo: 'neutral', in_progress: 'blue', done: 'amber', confirmed: 'green' }

export function TaskStateBadge({ state }: { state: TaskAssigneeState }) {
  return <Badge tone={STATE_TONE[state]}>{TASK_STATE_LABEL[state]}</Badge>
}

/** High and Urgent are said; Normal goes without a word. */
export function PriorityBadge({ priority }: { priority: TaskPriority }) {
  if (priority === 'normal') return null
  return <Badge tone={priority === 'urgent' ? 'red' : 'amber'}>{TASK_PRIORITY_LABEL[priority]}</Badge>
}

export function TaskDue({ task: t, timeZone, className }: { task: Pick<TaskSummary, 'dueAt' | 'overdue' | 'status'>; timeZone: string; className?: string }) {
  if (!t.dueAt) return null
  return (
    <span className={cn('inline-flex items-center gap-1 tabular-nums', t.overdue ? 'font-semibold text-rose-600 dark:text-rose-400' : 'text-muted', className)}>
      <CalendarClock className="h-3.5 w-3.5" />
      <time dateTime={t.dueAt} data-tip={factoryTimestamp(t.dueAt, timeZone)}>
        {t.overdue ? 'Overdue · ' : ''}
        {factoryMoment(t.dueAt, timeZone)}
      </time>
    </span>
  )
}

/** The people's parts as a bar: confirmed, done, in progress, to do. */
export function TaskProgress({ task, className }: { task: Pick<TaskSummary, 'assignees'>; className?: string }) {
  const p = progressOf(task)
  const n = Math.max(1, task.assignees.length)
  const seg = (count: number, tone: string) => (count > 0 ? <span className={tone} style={{ width: `${(count / n) * 100}%` }} /> : null)
  return (
    <span
      className={cn('flex h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700', className)}
      role="img"
      aria-label={`${p.confirmed} confirmed, ${p.done} done, ${p.in_progress} in progress, ${p.todo} to do`}
    >
      {seg(p.confirmed, 'bg-emerald-500')}
      {seg(p.done, 'bg-amber-500')}
      {seg(p.in_progress, 'bg-brand-500')}
    </span>
  )
}
