// ============================================================================
// Tasks: the ones sent to the person and, for someone given the AI assistant,
// the ones they sent — active (in the order to work them) or closed. "New
// task" sends one. Opened from the assistant's header and from the bell.
// ============================================================================

import '@fontsource/ibm-plex-sans-arabic/arabic-400.css'
import '@fontsource/ibm-plex-sans-arabic/arabic-600.css'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Inbox, ListTodo, Loader2, Plus, Send } from 'lucide-react'
import type { TaskBox, TaskListStatus, TaskSummary } from '@qc/shared/tasks'
import { Button, Card, EmptyState } from '@/components/ui'
import { Segmented } from '@/components/ui/PageShell'
import { NewTaskDialog } from '@/components/tasks/NewTaskDialog'
import { TaskRow } from '@/components/tasks/TaskRow'
import { workOrder } from '@/components/tasks/wording'
import { usePersistedState } from '@/lib/usePersistedState'
import { useTaskCounts, useTasks } from '@/services/tasks'
import { useAuth } from '@/store/AuthContext'

export function TasksPage() {
  const navigate = useNavigate()
  const { factoryTimeZone: tz } = useAuth()
  const { data: counts } = useTaskCounts()
  const canCreate = counts?.canCreate ?? false
  const [box, setBox] = usePersistedState<TaskBox>('qc-tasks:box', 'assigned')
  const [status, setStatus] = usePersistedState<TaskListStatus>('qc-tasks:status', 'active')
  const [creating, setCreating] = useState(false)
  // Someone who may not send tasks has only those sent to them.
  const shownBox: TaskBox = canCreate ? box : 'assigned'
  const { data, isLoading, isError, refetch, hasNextPage, fetchNextPage, isFetchingNextPage } = useTasks(shownBox, status, counts !== undefined)

  const tasks = useMemo(() => {
    const seen = new Set<string>()
    const out: TaskSummary[] = []
    for (const page of data?.pages ?? []) {
      for (const t of page.tasks) {
        if (seen.has(t.id)) continue
        seen.add(t.id)
        out.push(t)
      }
    }
    return status === 'active' ? workOrder(out) : out
  }, [data, status])

  const empty =
    status === 'active'
      ? shownBox === 'assigned'
        ? { title: 'Nothing to do', hint: 'Tasks sent to you show here until their sender confirms them done.' }
        : { title: 'No open tasks sent', hint: 'Send a task to someone with "New task": you follow it here until it is done.' }
      : { title: 'Nothing closed yet', hint: 'Tasks confirmed done or withdrawn show here.' }

  return (
    <div className="ai-type mx-auto w-full max-w-4xl space-y-4">
      <header className="flex flex-wrap items-center gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300">
          <ListTodo className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-extrabold tracking-tight">Tasks</h1>
          <p className="text-13 text-muted">
            {counts ? `${counts.assignedOpen} to do${counts.assignedOverdue > 0 ? `, ${counts.assignedOverdue} overdue` : ''}${canCreate ? ` · ${counts.toConfirm} to confirm` : ''}` : ' '}
          </p>
        </div>
        {canCreate && (
          <Button variant="primary" onClick={() => setCreating(true)} className="min-h-[44px]">
            <Plus className="h-4 w-4" /> New task
          </Button>
        )}
      </header>

      <div className="flex flex-wrap items-center gap-2">
        {canCreate && (
          <Segmented
            label="Whose tasks"
            value={shownBox}
            onChange={setBox}
            options={[
              { value: 'assigned', label: 'Sent to me', icon: <Inbox className="h-4 w-4" /> },
              { value: 'created', label: 'Sent by me', icon: <Send className="h-4 w-4" /> },
            ]}
          />
        )}
        <Segmented
          label="Which tasks"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'active', label: 'Active' },
            { value: 'closed', label: 'Closed' },
          ]}
        />
      </div>

      {isLoading ? (
        <Card className="flex items-center justify-center gap-2 p-10 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </Card>
      ) : isError && !data ? (
        <Card className="p-6 text-sm">
          The tasks could not be loaded.{' '}
          <button type="button" onClick={() => void refetch()} className="font-semibold text-brand-700 underline dark:text-brand-300">
            Try again
          </button>
        </Card>
      ) : tasks.length === 0 ? (
        <EmptyState icon={<ListTodo className="h-10 w-10" />} title={empty.title} hint={empty.hint} />
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {tasks.map((t) => (
            <li key={t.id}>
              <TaskRow task={t} timeZone={tz} />
            </li>
          ))}
        </ul>
      )}
      {hasNextPage && (
        <Button onClick={() => void fetchNextPage()} disabled={isFetchingNextPage} className="min-h-[44px]">
          {isFetchingNextPage ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Load more
        </Button>
      )}
      <NewTaskDialog
        open={creating}
        onClose={() => setCreating(false)}
        onSent={(task) => {
          setCreating(false)
          navigate(`/tasks/${task.id}`)
        }}
      />
    </div>
  )
}
