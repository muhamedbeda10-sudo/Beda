// ============================================================================
// A task in a list: its number, title and priority; where it stands for the
// viewer; its deadline; who sent it (or, for its sender, how far its people
// are); and how much has been written on it.
// ============================================================================

import { Link } from 'react-router-dom'
import { MessageSquareText } from 'lucide-react'
import type { TaskSummary } from '@qc/shared/tasks'
import { textDirection } from '@/lib/direction'
import { cn } from '@/lib/utils'
import { PriorityBadge, TaskDue, TaskProgress } from './parts'
import { standing, taskNumber } from './wording'

export function TaskRow({ task: t, timeZone, onOpen, compact = false }: { task: TaskSummary; timeZone: string; onOpen?: () => void; compact?: boolean }) {
  return (
    <Link
      to={`/tasks/${encodeURIComponent(t.id)}`}
      onClick={onOpen}
      className={cn(
        'block rounded-2xl bg-white px-3 py-2.5 ring-1 transition-colors hover:bg-slate-50 dark:bg-slate-900 dark:hover:bg-slate-800/60',
        t.waitingForMe ? 'ring-brand-300 dark:ring-brand-500/40' : t.overdue ? 'ring-rose-200 dark:ring-rose-500/30' : 'ring-slate-200/70 dark:ring-slate-800',
      )}
    >
      <span className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0 text-xs font-bold tabular-nums text-muted">{taskNumber(t)}</span>
        <span dir={textDirection(t.title) ?? 'auto'} className={cn('min-w-0 flex-1 break-words text-start text-sm', compact ? 'line-clamp-2' : 'line-clamp-3', t.waitingForMe ? 'font-bold' : 'font-semibold')}>
          {t.title}
        </span>
        <PriorityBadge priority={t.priority} />
      </span>
      <span className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted">
        <span className={cn(t.waitingForMe && 'font-semibold text-brand-700 dark:text-brand-300')}>{standing(t)}</span>
        <TaskDue task={t} timeZone={timeZone} />
        {!t.isCreator && <span dir="auto">from {t.createdBy.name}</span>}
        {t.isCreator && <span>{t.assignees.length === 1 ? `to ${t.assignees[0].name}` : `to ${t.assignees.length} people`}</span>}
        {t.messageCount > 0 && (
          <span className="inline-flex items-center gap-1">
            <MessageSquareText className="h-3.5 w-3.5" /> {t.messageCount}
          </span>
        )}
      </span>
      {t.isCreator && t.assignees.length > 1 && t.status === 'open' && <TaskProgress task={t} className="mt-2" />}
    </Link>
  )
}
