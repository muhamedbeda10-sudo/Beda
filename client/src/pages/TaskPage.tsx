// ============================================================================
// One task: what is to be done, by whom, by when, and its thread. Each person
// it was sent to moves their own part here (Start, Mark done, and back to in
// progress while it waits) and writes on the thread with photos; its sender
// confirms each done ("it leaves their list") or sends it back with why, and
// may change, close or withdraw the task. Opened by someone it was sent to,
// it is marked read for its sender. Someone not on it is told it is not there.
// ============================================================================

import '@fontsource/ibm-plex-sans-arabic/arabic-400.css'
import '@fontsource/ibm-plex-sans-arabic/arabic-600.css'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Ban, Check, CheckCheck, Eye, Loader2, Lock, MessageSquareText, Pencil, Play, RotateCcw, Send, Undo2, Users } from 'lucide-react'
import {
  TASK_DESCRIPTION_MAX,
  TASK_MAX_PHOTOS,
  TASK_MESSAGE_MAX,
  TASK_PRIORITY_LABEL,
  TASK_TITLE_MAX,
  taskEventText,
  type TaskAssignee,
  type TaskDetail,
  type TaskMessage,
  type TaskPhoto,
  type TaskPriority,
} from '@qc/shared/tasks'
import { can } from '@qc/shared/rules'
import { Badge, Button, Card, EmptyState, Modal } from '@/components/ui'
import { Segmented } from '@/components/ui/PageShell'
import { Lightbox, type ViewableImage } from '@/components/ui/Lightbox'
import { ImagePicker } from '@/components/inspection/ImagePicker'
import { factoryInstant, factoryMoment, factoryTimestamp, factoryWallTime } from '@/components/followUps/wording'
import { PriorityBadge, TaskDue, TaskProgress, TaskStateBadge } from '@/components/tasks/parts'
import { standing, taskNumber } from '@/components/tasks/wording'
import { ApiError } from '@/lib/api'
import { textDirection } from '@/lib/direction'
import { cn } from '@/lib/utils'
import { endTask, markTaskSeen, reviewTask, setTaskState, updateTask, useTask, writeOnTask } from '@/services/tasks'
import { resolveImageUrl } from '@/services/uploadImage'
import { useApp } from '@/store/AppContext'
import { useAuth } from '@/store/AuthContext'

export function TaskPage() {
  const { id = '' } = useParams()
  const { profile } = useAuth()
  const { data: task, isLoading, error, refetch } = useTask(id || null)
  const gone = error instanceof ApiError && error.status === 404

  // Read by someone it was sent to, the first time: once per opening.
  const marked = useRef<string | null>(null)
  useEffect(() => {
    if (!task || !profile || marked.current === task.id) return
    const mine = task.assignees.find((a) => a.userId === profile.id)
    if (mine && !mine.seenAt) {
      marked.current = task.id
      markTaskSeen(task.id)
    }
  }, [task, profile])

  return (
    <div className="ai-type mx-auto w-full max-w-4xl space-y-4">
      <Link to="/tasks" className="inline-flex min-h-[40px] items-center gap-1 text-13 font-semibold text-brand-700 hover:underline dark:text-brand-300">
        <ArrowLeft className="h-4 w-4 rtl:rotate-180" /> Tasks
      </Link>
      {isLoading ? (
        <Card className="flex items-center justify-center gap-2 p-10 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading the task…
        </Card>
      ) : gone ? (
        <EmptyState icon={<Lock className="h-10 w-10" />} title="This task is not there" hint="A task is seen only by the person who sent it and the people it went to." />
      ) : !task ? (
        <Card className="p-6 text-sm">
          The task could not be loaded.{' '}
          <button type="button" onClick={() => void refetch()} className="font-semibold text-brand-700 underline dark:text-brand-300">
            Try again
          </button>
        </Card>
      ) : (
        <TaskView task={task} />
      )}
    </div>
  )
}

function TaskView({ task: t }: { task: TaskDetail }) {
  const { factoryTimeZone: tz } = useAuth()
  const open = t.status === 'open'
  return (
    <>
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
          <span className="font-bold tabular-nums text-slate-700 dark:text-slate-200">{taskNumber(t)}</span>
          <PriorityBadge priority={t.priority} />
          {t.status === 'closed' && <Badge tone="green">Closed</Badge>}
          {t.status === 'cancelled' && <Badge tone="neutral">Withdrawn</Badge>}
          {open && <span>· {standing(t)}</span>}
        </div>
        <h1 dir={textDirection(t.title) ?? 'auto'} className="break-words text-start text-2xl font-extrabold tracking-tight">
          {t.title}
        </h1>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-13 text-muted">
          <span>
            From <span className="font-semibold text-slate-700 dark:text-slate-200">{t.createdBy.name}</span> ·{' '}
            <time dateTime={t.createdAt} data-tip={factoryTimestamp(t.createdAt, tz)}>
              {factoryMoment(t.createdAt, tz)}
            </time>
          </span>
          <TaskDue task={t} timeZone={tz} />
        </p>
        {t.description && (
          <p dir="auto" className="whitespace-pre-wrap break-words rounded-xl bg-slate-50 px-3 py-2.5 text-sm text-slate-700 dark:bg-slate-800/60 dark:text-slate-200">
            {t.description}
          </p>
        )}
      </header>

      {open && t.myState && t.myState !== 'confirmed' && <MyPart task={t} />}
      <People task={t} />
      {t.isCreator && open && <SenderTools task={t} />}
      <Thread task={t} />
    </>
  )
}

function Section({ icon, title, extra, children }: { icon: ReactNode; title: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <Card className="space-y-3 p-4">
      <h2 className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wide text-muted">
        {icon} {title} {extra}
      </h2>
      {children}
    </Card>
  )
}

/** A write and its toast: the error's own sentence, or a general one. */
function useRun() {
  const { toast } = useApp()
  const [busy, setBusy] = useState<string | null>(null)
  const run = async (what: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(what)
    try {
      await fn()
      if (done) toast(done, 'success')
      return true
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'That did not go through. Try again.', 'error')
      return false
    } finally {
      setBusy(null)
    }
  }
  return { busy, run }
}

/** The viewer's own part: start it, mark it done (with a word on it), or take it back while it waits. */
function MyPart({ task: t }: { task: TaskDetail }) {
  const qc = useQueryClient()
  const { busy, run } = useRun()
  const [note, setNote] = useState('')
  const state = t.myState!
  return (
    <Section icon={<Play className="h-3.5 w-3.5" />} title="Your part" extra={<TaskStateBadge state={state} />}>
      {state === 'done' ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted">You marked it done. {t.createdBy.name} confirms it, or sends it back if something is still to do.</p>
          <Button onClick={() => void run('undo', () => setTaskState(qc, t.id, { state: 'in_progress' }), 'Back to in progress.')} disabled={busy !== null} className="min-h-[44px]">
            {busy === 'undo' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Undo2 className="h-4 w-4" />} Back to in progress
          </Button>
        </div>
      ) : (
        <>
          <textarea dir="auto" value={note} onChange={(e) => setNote(e.target.value)} maxLength={TASK_MESSAGE_MAX} rows={2} className="input min-h-[60px] resize-y py-2" placeholder="A word on what you did (optional)" />
          <div className="flex flex-wrap gap-2">
            {state === 'todo' && (
              <Button onClick={() => void run('start', () => setTaskState(qc, t.id, { state: 'in_progress', note: note.trim() }).then(() => setNote('')), 'Started.')} disabled={busy !== null} className="min-h-[44px]">
                {busy === 'start' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} Start
              </Button>
            )}
            <Button variant="primary" onClick={() => void run('done', () => setTaskState(qc, t.id, { state: 'done', note: note.trim() }).then(() => setNote('')), `Marked done: ${t.createdBy.name} is told.`)} disabled={busy !== null} className="min-h-[44px]">
              {busy === 'done' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Mark done
            </Button>
          </div>
        </>
      )}
    </Section>
  )
}

/** The people it went to, each with their part; the sender confirms a done one or sends it back. */
function People({ task: t }: { task: TaskDetail }) {
  const { factoryTimeZone: tz } = useAuth()
  return (
    <Section icon={<Users className="h-3.5 w-3.5" />} title={`Sent to ${t.assignees.length === 1 ? '1 person' : `${t.assignees.length} people`}`}>
      <TaskProgress task={t} />
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {t.assignees.map((a) => (
          <PersonRow key={a.userId} task={t} a={a} timeZone={tz} />
        ))}
      </ul>
    </Section>
  )
}

function PersonRow({ task: t, a, timeZone }: { task: TaskDetail; a: TaskAssignee; timeZone: string }) {
  const qc = useQueryClient()
  const { busy, run } = useRun()
  const [why, setWhy] = useState<string | null>(null)
  const reviewing = t.isCreator && t.status === 'open' && a.state === 'done'
  return (
    <li className="py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span dir="auto" className="min-w-0 flex-1 truncate text-sm font-semibold">
          {a.name}
        </span>
        <TaskStateBadge state={a.state} />
        {a.seenAt ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-muted" data-tip={`Opened ${factoryTimestamp(a.seenAt, timeZone)}`}>
            <Eye className="h-3.5 w-3.5" /> Read
          </span>
        ) : (
          <span className="text-[11px] text-muted">Not opened yet</span>
        )}
      </div>
      {a.doneAt && a.state !== 'todo' && (
        <p className="mt-0.5 text-xs text-muted">
          Done {factoryMoment(a.doneAt, timeZone)}
          {a.confirmedAt && ` · confirmed ${factoryMoment(a.confirmedAt, timeZone)}`}
        </p>
      )}
      {reviewing && why === null && (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => void run('confirm', () => reviewTask(qc, t.id, { userId: a.userId, decision: 'confirm' }), `${a.name}'s part is confirmed done.`)} disabled={busy !== null} className="min-h-[44px]">
            {busy === 'confirm' ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCheck className="h-4 w-4" />} Confirm done
          </Button>
          <Button onClick={() => setWhy('')} disabled={busy !== null} className="min-h-[44px]">
            <RotateCcw className="h-4 w-4" /> Not yet
          </Button>
        </div>
      )}
      {reviewing && why !== null && (
        <div className="mt-2 space-y-2">
          <textarea dir="auto" value={why} onChange={(e) => setWhy(e.target.value)} maxLength={TASK_MESSAGE_MAX} rows={2} autoFocus className="input min-h-[60px] resize-y py-2" placeholder={`What is still to be done? ${a.name} is told.`} />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              onClick={() => void run('reopen', () => reviewTask(qc, t.id, { userId: a.userId, decision: 'reopen', note: why.trim() }).then(() => setWhy(null)), `Sent back to ${a.name}.`)}
              disabled={busy !== null || why.trim() === ''}
              className="min-h-[44px]"
            >
              {busy === 'reopen' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />} Send it back
            </Button>
            <Button onClick={() => setWhy(null)} disabled={busy !== null} className="min-h-[44px]">
              Cancel
            </Button>
          </div>
        </div>
      )}
    </li>
  )
}

/** The sender's: change the task, close it for everyone, or withdraw it. */
function SenderTools({ task: t }: { task: TaskDetail }) {
  const qc = useQueryClient()
  const { busy, run } = useRun()
  const [editing, setEditing] = useState(false)
  const [ending, setEnding] = useState<'close' | 'cancel' | null>(null)
  const [note, setNote] = useState('')
  const left = t.assignees.filter((a) => a.state !== 'confirmed').length
  return (
    <div className="flex flex-wrap gap-2">
      <Button onClick={() => setEditing(true)} className="min-h-[44px]">
        <Pencil className="h-4 w-4" /> Change
      </Button>
      <Button onClick={() => setEnding('close')} className="min-h-[44px]" data-tip="Every part is confirmed as it stands, and the task closes">
        <CheckCheck className="h-4 w-4" /> Close for everyone
      </Button>
      <Button onClick={() => setEnding('cancel')} className="min-h-[44px] text-rose-700 dark:text-rose-300">
        <Ban className="h-4 w-4" /> Withdraw
      </Button>
      {editing && <EditTaskDialog task={t} onClose={() => setEditing(false)} />}
      <Modal
        open={ending !== null}
        onClose={() => busy === null && setEnding(null)}
        title={ending === 'close' ? `Close ${taskNumber(t)} for everyone?` : `Withdraw ${taskNumber(t)}?`}
        size="sm"
        footer={
          <>
            <Button onClick={() => setEnding(null)} disabled={busy !== null} className="min-h-[44px]">
              Keep it open
            </Button>
            <Button
              variant="primary"
              onClick={() =>
                void run(ending!, () => endTask(qc, t.id, ending!, note.trim()), ending === 'close' ? 'The task is closed.' : 'The task is withdrawn.').then((ok) => {
                  if (ok) {
                    setEnding(null)
                    setNote('')
                  }
                })
              }
              disabled={busy !== null}
              className="min-h-[44px]"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : ending === 'close' ? <CheckCheck className="h-4 w-4" /> : <Ban className="h-4 w-4" />} {ending === 'close' ? 'Close it' : 'Withdraw it'}
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted">
          {ending === 'close'
            ? `Each of the ${left} ${left === 1 ? 'person' : 'people'} still on it is taken as done, and told.`
            : `It stops for everyone on it, and they are told. It stays on record, withdrawn.`}
        </p>
        <textarea dir="auto" value={note} onChange={(e) => setNote(e.target.value)} maxLength={TASK_MESSAGE_MAX} rows={2} className="input mt-3 min-h-[60px] resize-y py-2" placeholder="A word on why (optional)" />
      </Modal>
    </div>
  )
}

function EditTaskDialog({ task: t, onClose }: { task: TaskDetail; onClose: () => void }) {
  const qc = useQueryClient()
  const { factoryTimeZone: tz } = useAuth()
  const { busy, run } = useRun()
  const [title, setTitle] = useState(t.title)
  const [description, setDescription] = useState(t.description)
  const [priority, setPriority] = useState<TaskPriority>(t.priority)
  const [dueWall, setDueWall] = useState(t.dueAt ? factoryWallTime(t.dueAt, tz) : '')
  const dueIso = dueWall ? factoryInstant(dueWall, tz) : null
  const save = () =>
    void run('save', () => updateTask(qc, t.id, { title: title.trim(), description: description.trim(), priority, dueAt: dueIso }), 'Changed: the people on it are told.').then((ok) => ok && onClose())
  return (
    <Modal
      open
      onClose={() => busy === null && onClose()}
      title={`Change ${taskNumber(t)}`}
      icon={<Pencil className="h-5 w-5" />}
      footer={
        <>
          <Button onClick={onClose} disabled={busy !== null} className="min-h-[44px]">
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={busy !== null || title.trim() === '' || (dueWall !== '' && dueIso === null)} className="min-h-[44px]">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <label className="block">
          <span className="label">What is to be done</span>
          <input dir="auto" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={TASK_TITLE_MAX} className="input" />
        </label>
        <label className="block">
          <span className="label">Details</span>
          <textarea dir="auto" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={TASK_DESCRIPTION_MAX} rows={3} className="input min-h-[88px] resize-y py-2" />
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <span className="label">Priority</span>
            <Segmented label="Priority" value={priority} onChange={setPriority} options={(['normal', 'high', 'urgent'] as const).map((v) => ({ value: v, label: TASK_PRIORITY_LABEL[v] }))} />
          </div>
          <label className="block">
            <span className="label">Deadline</span>
            <input type="datetime-local" value={dueWall} onChange={(e) => setDueWall(e.target.value)} className="input" aria-label="Deadline" />
            <span className="mt-1 block text-xs text-muted">Empty: no deadline. On the factory’s clock ({tz}).</span>
          </label>
        </div>
      </div>
    </Modal>
  )
}

/** The thread: what people wrote, with their photos, and each change in a line of its own; and the box to write in. */
function Thread({ task: t }: { task: TaskDetail }) {
  const { factoryTimeZone: tz, role } = useAuth()
  const qc = useQueryClient()
  const { busy, run } = useRun()
  const [body, setBody] = useState('')
  const [photos, setPhotos] = useState<string[]>([])
  const open = t.status === 'open'
  // Photos are stored where an inspection's are: whoever may record inspections may add them.
  const mayPhoto = can(role, 'record-inspection')
  const send = () =>
    void run('send', () => writeOnTask(qc, t.id, { body: body.trim(), imageIds: photos })).then((ok) => {
      if (ok) {
        setBody('')
        setPhotos([])
      }
    })
  return (
    <Section icon={<MessageSquareText className="h-3.5 w-3.5" />} title="Thread" extra={t.messageCount > 0 ? <span className="tabular-nums">· {t.messageCount}</span> : undefined}>
      <ol className="space-y-2.5">
        {t.messages.map((m) => (
          <MessageItem key={m.id} m={m} timeZone={tz} />
        ))}
      </ol>
      {open ? (
        <div className="space-y-2 border-t border-slate-100 pt-3 dark:border-slate-800">
          <textarea
            dir="auto"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={TASK_MESSAGE_MAX}
            rows={2}
            className="input min-h-[60px] resize-y py-2"
            placeholder="Write on the task: what you found, a question, an answer…"
            aria-label="Write on the task"
          />
          {mayPhoto && photos.length <= TASK_MAX_PHOTOS && <ImagePicker imageIds={photos} onChange={(ids) => setPhotos(ids.slice(0, TASK_MAX_PHOTOS))} />}
          <div className="flex justify-end">
            <Button variant="primary" onClick={send} disabled={busy !== null || (body.trim() === '' && photos.length === 0)} className="min-h-[44px]">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Send
            </Button>
          </div>
        </div>
      ) : (
        <p className="border-t border-slate-100 pt-3 text-xs text-muted dark:border-slate-800">{t.status === 'closed' ? 'The task is closed: its thread is kept as it is.' : 'The task was withdrawn: its thread is kept as it is.'}</p>
      )}
    </Section>
  )
}

function MessageItem({ m, timeZone }: { m: TaskMessage; timeZone: string }) {
  const at = (
    <time dateTime={m.createdAt} data-tip={factoryTimestamp(m.createdAt, timeZone)} className="text-[11px] text-muted">
      {factoryMoment(m.createdAt, timeZone)}
    </time>
  )
  if (m.kind === 'event') {
    return (
      <li className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted">
        <span className="font-semibold text-slate-600 dark:text-slate-300">{taskEventText(m.event!, m.authorName, m.subjectName)}</span>
        {at}
        {m.body && (
          <p dir="auto" className="mt-1 w-full whitespace-pre-wrap break-words rounded-lg bg-slate-50 px-2.5 py-1.5 text-13 text-slate-700 dark:bg-slate-800/60 dark:text-slate-200">
            {m.body}
          </p>
        )}
      </li>
    )
  }
  return (
    <li className="rounded-xl bg-white px-3 py-2 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span dir="auto" className="text-13 font-semibold">
          {m.authorName}
        </span>
        {at}
      </div>
      {m.body && (
        <p dir="auto" className="mt-0.5 whitespace-pre-wrap break-words text-sm">
          {m.body}
        </p>
      )}
      {m.photos.length > 0 && <Photos photos={m.photos} />}
    </li>
  )
}

/** A message's photos: their previews, opening full size in the photo viewer. */
function Photos({ photos }: { photos: TaskPhoto[] }) {
  const { toast } = useApp()
  const [viewing, setViewing] = useState<{ images: ViewableImage[]; index: number } | null>(null)
  const open = async (index: number) => {
    try {
      const urls = await Promise.all(photos.map((p) => resolveImageUrl({ id: p.id, thumbnailDataUrl: p.thumbnailDataUrl ?? undefined })))
      setViewing({ images: photos.map((p, i) => ({ id: p.id, dataUrl: urls[i] })), index })
    } catch {
      toast('The photo could not be opened.', 'error')
    }
  }
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {photos.map((p, i) => (
        <button key={p.id} type="button" onClick={() => void open(i)} className="h-20 w-20 overflow-hidden rounded-lg bg-slate-100 ring-1 ring-slate-200 dark:bg-slate-800 dark:ring-slate-700" aria-label="Open the photo">
          {p.thumbnailDataUrl && <img src={p.thumbnailDataUrl} alt="" className={cn('h-full w-full object-cover')} />}
        </button>
      ))}
      {viewing && <Lightbox images={viewing.images} startIndex={viewing.index} onClose={() => setViewing(null)} />}
    </div>
  )
}
