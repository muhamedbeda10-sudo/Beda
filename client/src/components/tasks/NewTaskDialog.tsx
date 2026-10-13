// ============================================================================
// Sending a task: what is to be done, to whom (one or more of the app's
// people, found by name), how urgent, and by when on the factory's clock.
// Nothing is sent until "Send task"; each person is then told in the bell.
// ============================================================================

import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Check, ListTodo, Loader2, Search, Send, X } from 'lucide-react'
import { TASK_DESCRIPTION_MAX, TASK_MAX_ASSIGNEES, TASK_PRIORITY_LABEL, TASK_TITLE_MAX, type TaskDetail, type TaskPriority } from '@qc/shared/tasks'
import { Button, Modal } from '@/components/ui'
import { Segmented } from '@/components/ui/PageShell'
import { factoryInstant } from '@/components/followUps/wording'
import { ApiError } from '@/lib/api'
import { cn } from '@/lib/utils'
import { createTask, useTaskPeople } from '@/services/tasks'
import { useApp } from '@/store/AppContext'
import { useAuth } from '@/store/AuthContext'

export function NewTaskDialog({ open, onClose, onSent }: { open: boolean; onClose: () => void; onSent: (task: TaskDetail) => void }) {
  const qc = useQueryClient()
  const { toast } = useApp()
  const { factoryTimeZone: tz } = useAuth()
  const { data: people, isLoading, isError, refetch } = useTaskPeople(open)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [chosen, setChosen] = useState<string[]>([])
  const [term, setTerm] = useState('')
  const [priority, setPriority] = useState<TaskPriority>('normal')
  const [dueWall, setDueWall] = useState('')
  const [busy, setBusy] = useState(false)

  const byId = useMemo(() => new Map((people ?? []).map((p) => [p.id, p])), [people])
  const found = useMemo(() => {
    const q = term.trim().toLowerCase()
    return (people ?? []).filter((p) => !q || p.name.toLowerCase().includes(q) || p.role.toLowerCase().includes(q))
  }, [people, term])
  const dueIso = dueWall ? factoryInstant(dueWall, tz) : null
  const canSend = title.trim() !== '' && chosen.length > 0 && !busy && (dueWall === '' || dueIso !== null)

  const reset = () => {
    setTitle('')
    setDescription('')
    setChosen([])
    setTerm('')
    setPriority('normal')
    setDueWall('')
  }
  const toggle = (id: string) => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : c.length >= TASK_MAX_ASSIGNEES ? c : [...c, id]))
  const submit = async () => {
    if (!canSend) return
    setBusy(true)
    try {
      const task = await createTask(qc, { title: title.trim(), description: description.trim(), priority, dueAt: dueIso, assigneeIds: chosen })
      toast(`T-${task.number} sent to ${chosen.length === 1 ? byId.get(chosen[0])?.name : `${chosen.length} people`}.`, 'success')
      reset()
      onSent(task)
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'The task could not be sent. Try again.', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => !busy && onClose()}
      title="New task"
      icon={<ListTodo className="h-5 w-5" />}
      size="lg"
      footer={
        <>
          <Button onClick={onClose} disabled={busy} className="min-h-[44px]">
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={!canSend} className="min-h-[44px]">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Send task
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <label className="block">
          <span className="label">What is to be done</span>
          <input dir="auto" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={TASK_TITLE_MAX} className="input" placeholder="e.g. Recheck the coil stock in bay 3" autoFocus />
        </label>
        <label className="block">
          <span className="label">Details (optional)</span>
          <textarea
            dir="auto"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={TASK_DESCRIPTION_MAX}
            rows={3}
            className="input min-h-[88px] resize-y py-2"
            placeholder="Where, what to check, what to send back…"
          />
        </label>

        <div>
          <span className="label">
            Send to {chosen.length > 0 && <span className="font-normal text-muted">· {chosen.length} chosen</span>}
          </span>
          {chosen.length > 0 && (
            <ul className="mb-2 flex flex-wrap gap-1.5">
              {chosen.map((id) => (
                <li key={id} className="inline-flex items-center gap-1 rounded-full bg-brand-50 py-1 pe-1 ps-2.5 text-xs font-semibold text-brand-800 dark:bg-brand-500/15 dark:text-brand-200">
                  <span dir="auto">{byId.get(id)?.name ?? '…'}</span>
                  <button type="button" onClick={() => toggle(id)} className="grid h-6 w-6 place-items-center rounded-full hover:bg-brand-100 dark:hover:bg-brand-500/25" aria-label={`Remove ${byId.get(id)?.name ?? ''}`}>
                    <X className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="relative">
            <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <input value={term} onChange={(e) => setTerm(e.target.value)} className="input ps-9" placeholder="Find people by name or role" aria-label="Find people" />
          </div>
          <div className="mt-1.5 max-h-48 overflow-y-auto overscroll-contain rounded-xl ring-1 ring-slate-200 dark:ring-slate-700">
            {isLoading && (
              <p className="flex items-center gap-2 p-3 text-sm text-muted">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading the people…
              </p>
            )}
            {isError && !people && (
              <p className="p-3 text-sm text-rose-700 dark:text-rose-300">
                The people could not be loaded.{' '}
                <button type="button" onClick={() => void refetch()} className="font-semibold underline">
                  Try again
                </button>
              </p>
            )}
            {people && found.length === 0 && <p className="p-3 text-sm text-muted">No one matches.</p>}
            <ul>
              {found.map((p) => {
                const on = chosen.includes(p.id)
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => toggle(p.id)}
                      aria-pressed={on}
                      className={cn('flex w-full items-center gap-2.5 px-3 py-2 text-start text-sm hover:bg-slate-50 dark:hover:bg-slate-800/60 touch:min-h-[44px]', on && 'bg-brand-50/60 dark:bg-brand-500/10')}
                    >
                      <span className={cn('grid h-5 w-5 shrink-0 place-items-center rounded-md ring-1', on ? 'bg-brand-600 text-white ring-brand-600' : 'ring-slate-300 dark:ring-slate-600')}>
                        {on && <Check className="h-3.5 w-3.5" />}
                      </span>
                      <span dir="auto" className="min-w-0 flex-1 truncate font-medium">
                        {p.name}
                      </span>
                      <span className="shrink-0 text-xs capitalize text-muted">{p.role}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <span className="label">Priority</span>
            <Segmented
              label="Priority"
              value={priority}
              onChange={setPriority}
              options={(['normal', 'high', 'urgent'] as const).map((v) => ({ value: v, label: TASK_PRIORITY_LABEL[v] }))}
            />
          </div>
          <label className="block">
            <span className="label">Deadline (optional)</span>
            <input type="datetime-local" value={dueWall} onChange={(e) => setDueWall(e.target.value)} className="input" aria-label="Deadline" />
            <span className="mt-1 block text-xs text-muted">On the factory’s clock ({tz}).</span>
          </label>
        </div>
      </div>
    </Modal>
  )
}
