// ============================================================================
// The bell's Tasks: what the person has to do (sent to them, in the order to
// work them) and, for what they sent, the people who said done and wait for
// their confirmation. Each opens its task; all of them are on the Tasks page.
// ============================================================================

import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, ListTodo, Loader2 } from 'lucide-react'
import type { TaskSummary } from '@qc/shared/tasks'
import { EmptyState } from '@/components/ui'
import { TaskRow } from '@/components/tasks/TaskRow'
import { workOrder } from '@/components/tasks/wording'
import { useTasks } from '@/services/tasks'
import { useAuth } from '@/store/AuthContext'

const flat = (pages: { tasks: TaskSummary[] }[] | undefined) => (pages ?? []).flatMap((p) => p.tasks)

export function BellTasks({ onLeave, sender }: { onLeave: () => void; sender: boolean }) {
  const { factoryTimeZone: tz } = useAuth()
  const assigned = useTasks('assigned', 'active')
  const created = useTasks('created', 'active', sender)
  const toDo = useMemo(() => workOrder(flat(assigned.data?.pages)), [assigned.data])
  const toConfirm = useMemo(() => workOrder(flat(created.data?.pages).filter((t) => t.waitingForMe)), [created.data])
  const loading = assigned.isLoading || (sender && created.isLoading)

  return (
    <div className="space-y-4">
      {loading && (
        <p className="flex items-center gap-2 py-8 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </p>
      )}
      {!loading && toDo.length === 0 && toConfirm.length === 0 && (
        <EmptyState icon={<ListTodo className="h-10 w-10" />} title="No tasks waiting" hint="Tasks sent to you show here until they are confirmed done." />
      )}
      {toConfirm.length > 0 && (
        <section className="space-y-2">
          <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-muted">Done: waiting for you to confirm</p>
          <ul className="space-y-2">
            {toConfirm.map((t) => (
              <li key={t.id}>
                <TaskRow task={t} timeZone={tz} onOpen={onLeave} compact />
              </li>
            ))}
          </ul>
        </section>
      )}
      {toDo.length > 0 && (
        <section className="space-y-2">
          <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-muted">Sent to you</p>
          <ul className="space-y-2">
            {toDo.map((t) => (
              <li key={t.id}>
                <TaskRow task={t} timeZone={tz} onOpen={onLeave} compact />
              </li>
            ))}
          </ul>
        </section>
      )}
      <Link to="/tasks" onClick={onLeave} className="inline-flex min-h-[40px] items-center gap-1 text-13 font-semibold text-brand-700 hover:underline dark:text-brand-300">
        Open the Tasks page <ArrowRight className="h-3.5 w-3.5 rtl:rotate-180" />
      </Link>
    </div>
  )
}
