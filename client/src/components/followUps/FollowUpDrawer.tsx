// ============================================================================
// §21 — one follow-up, opened over the list (/follow-ups/<id>): what it is
// about, the case it was opened for, where it leads (its session, sample and
// order), and its timeline — comments and every change, oldest first. The
// people it concerns work it from here: move its status (closing it takes a
// note), comment, and — the automation's creator, supervisors, administrators
// and the assistant's owner — give it to someone else or move its deadline.
// The server says who may do what; the buttons follow.
// ============================================================================

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  CircleDot,
  ExternalLink,
  ListChecks,
  Loader2,
  MessageSquareText,
  Send,
  Sparkles,
  UserRound,
  Zap,
} from 'lucide-react'
import { FOLLOW_UP_COMMENT_MAX, FOLLOW_UP_STATUSES, type FollowUpDetail, type FollowUpEvent, type FollowUpEventKind, type FollowUpStatus, type FollowUpUpdateRequest } from '@qc/shared/automation'
import { Badge, Button, Drawer, EmptyState, Select } from '@/components/ui'
import { Section } from '@/components/inspection/SampleDetail'
import { useAi } from '@/components/ai/AiAssistantProvider'
import { ApiError } from '@/lib/api'
import { cn } from '@/lib/utils'
import { commentOnFollowUp, updateFollowUp, useAssignablePeople, useFollowUp, useOwnAutomationIds } from '@/services/followUps'
import { useApp } from '@/store/AppContext'
import { useAuth } from '@/store/AuthContext'
import { CaseValues, DueText, FollowUpStatusBadge } from './parts'
import { FOLLOW_UP_STATUS_LABEL, assigneeChoices, factoryInstant, factoryMoment, factoryTimestamp, factoryWallTime, followUpLinks, isOverdue, mayOpenAutomation } from './wording'

const EVENT_ICON: Record<FollowUpEventKind, typeof CircleDot> = {
  created: Sparkles,
  comment: MessageSquareText,
  status: CircleDot,
  assignee: UserRound,
  due: CalendarClock,
  escalated: AlertTriangle,
}

const EVENT_TONE: Partial<Record<FollowUpEventKind, string>> = {
  escalated: 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300',
  created: 'bg-brand-100 text-brand-700 dark:bg-brand-500/15 dark:text-brand-200',
}

/** The device reads another zone than the factory: say whose clock a time is on. */
const deviceZone = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return ''
  }
})()

export function FollowUpDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { data, isLoading, isError, error, refetch } = useFollowUp(id)
  const gone = error instanceof ApiError && error.status === 404
  const f = data && data.id === id ? data : null
  return (
    <Drawer
      open={id !== null}
      onClose={onClose}
      icon={<ListChecks className="h-5 w-5" />}
      title="Follow-up"
      subtitle={f ? <span dir="auto">{f.automationName}</span> : undefined}
    >
      {f ? (
        <FollowUpBody followUp={f} />
      ) : isLoading ? (
        <p className="flex items-center gap-2 py-8 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </p>
      ) : gone ? (
        <EmptyState icon={<ListChecks className="h-10 w-10" />} title="This follow-up is not there for you" hint="It may have been given to someone else, or the link is not right." />
      ) : isError ? (
        <EmptyState icon={<ListChecks className="h-10 w-10" />} title="The follow-up could not be loaded" hint="Check the connection and try again." action={<Button onClick={() => void refetch()}>Try again</Button>} />
      ) : null}
    </Drawer>
  )
}

function Fact({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={cn('min-w-0', wide && 'col-span-2')}>
      <dt className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-0.5 break-words text-sm font-medium">{children}</dd>
    </div>
  )
}

function InAppLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="inline-flex max-w-full items-center gap-1 font-semibold text-brand-700 underline-offset-4 hover:underline dark:text-brand-300">
      <span className="truncate" dir="auto">
        {children}
      </span>
      <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden />
    </Link>
  )
}

function FollowUpBody({ followUp: f }: { followUp: FollowUpDetail }) {
  const qc = useQueryClient()
  const { toast } = useApp()
  const { factoryTimeZone: tz } = useAuth()
  const ai = useAi()
  const [busy, setBusy] = useState<'status' | 'assignee' | 'due' | 'comment' | null>(null)
  const [closing, setClosing] = useState(false)
  const [note, setNote] = useState('')
  const [comment, setComment] = useState('')
  const [assigneeId, setAssigneeId] = useState(f.assignee?.id ?? '')
  const [dueWall, setDueWall] = useState(() => factoryWallTime(f.dueAt, tz))
  const links = followUpLinks(f)
  const overdue = isOverdue(f)
  // The automation's page opens for its creator and the assistant's owner alone; to anyone else it is not there.
  const ownAutomations = useOwnAutomationIds(!!f.automationId && ai.automations && !ai.owner)
  const canOpenAutomation = mayOpenAutomation(f.automationId, { owner: ai.owner, automations: ai.automations, own: ownAutomations })

  // Someone else's change arrives with the next fetch: the fields follow what is now stored.
  useEffect(() => setAssigneeId(f.assignee?.id ?? ''), [f.assignee?.id])
  useEffect(() => setDueWall(factoryWallTime(f.dueAt, tz)), [f.dueAt, tz])
  useEffect(() => {
    if (f.status === 'done') setClosing(false)
  }, [f.status])

  // Everyone it can be given to, viewers too; asked for only when this person may give it to someone else (and it is not closed).
  const mayReassign = f.canReassign && f.status !== 'done'
  const { data: people, isLoading: peopleLoading, isError: peopleFailed, refetch: refetchPeople } = useAssignablePeople(mayReassign)
  const choices = useMemo(() => assigneeChoices(people ?? [], f.assignee), [people, f.assignee])

  const change = async (what: 'status' | 'assignee' | 'due', body: FollowUpUpdateRequest, done: string) => {
    setBusy(what)
    try {
      await updateFollowUp(qc, f.id, body)
      toast(done, 'success')
      return true
    } catch (e) {
      toast(e instanceof Error ? e.message : 'The change could not be saved.', 'error')
      return false
    } finally {
      setBusy(null)
    }
  }

  const pickStatus = (s: FollowUpStatus) => {
    if (s === f.status || busy) return
    if (s === 'done') {
      setClosing(true)
      return
    }
    setClosing(false)
    void change('status', { status: s }, `Set to ${FOLLOW_UP_STATUS_LABEL[s].toLowerCase()}.`)
  }
  const close = async () => {
    if (!note.trim()) return
    if (await change('status', { status: 'done', closingNote: note.trim() }, 'Closed. The people it concerns are told.')) setNote('')
  }
  const assigneeName = (people ?? []).find((p) => p.id === assigneeId)?.name ?? 'them'
  const saveAssignee = () => void change('assignee', { assigneeId }, `Given to ${assigneeName}; they are told.`)
  const dueIso = factoryInstant(dueWall, tz)
  // The field holds minutes: a deadline stored with seconds is the same deadline.
  const dueChanged = dueIso !== null && Math.floor(Date.parse(dueIso) / 60_000) !== Math.floor(Date.parse(f.dueAt) / 60_000)
  const saveDue = () => {
    if (dueIso) void change('due', { dueAt: dueIso }, 'Deadline moved.')
  }
  const send = async () => {
    const body = comment.trim()
    if (!body || busy) return
    setBusy('comment')
    try {
      await commentOnFollowUp(qc, f.id, { body })
      setComment('')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'The comment could not be added.', 'error')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="ai-type space-y-5">
      <div className="space-y-2">
        <h3 dir="auto" className="break-words text-lg font-bold leading-snug">
          {f.title}
        </h3>
        <div className="flex flex-wrap items-center gap-1.5">
          <FollowUpStatusBadge status={f.status} />
          {overdue && <Badge tone="red">Overdue</Badge>}
          {f.escalatedAt && f.status !== 'done' && (
            <Badge tone="red" icon={<AlertTriangle className="h-3 w-3" />} tip={`Escalated ${factoryTimestamp(f.escalatedAt, tz)}`}>
              Escalated
            </Badge>
          )}
        </div>
        {f.body && (
          <p dir="auto" className="whitespace-pre-line break-words text-sm text-slate-700 dark:text-slate-200">
            {f.body}
          </p>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-3">
        <Fact label="Assigned to">{f.assignee ? <span dir="auto">{f.assignee.name}</span> : <span className="text-muted">Nobody</span>}</Fact>
        <Fact label="Deadline">
          <DueText followUp={f} timeZone={tz} />
        </Fact>
        <Fact label="Automation">
          {canOpenAutomation && f.automationId ? (
            <InAppLink to={`/automations/${encodeURIComponent(f.automationId)}`}>{f.automationName}</InAppLink>
          ) : (
            <span dir="auto">{f.automationName}</span>
          )}
        </Fact>
        <Fact label="Opened">
          <time dateTime={f.createdAt} data-tip={factoryTimestamp(f.createdAt, tz)}>
            {factoryMoment(f.createdAt, tz)}
          </time>
        </Fact>
        {links.session && (
          <Fact label="Session" wide>
            <InAppLink to={links.session}>{f.sessionLabel ?? 'Open the session'}</InAppLink>
          </Fact>
        )}
        {f.sampleId && (
          <Fact label="Sample">{links.sample ? <InAppLink to={links.sample}>Open the sample</InAppLink> : <span className="font-mono text-xs">{f.sampleId}</span>}</Fact>
        )}
        {links.order && (
          <Fact label="Order">
            <InAppLink to={links.order}>{f.orderNumber}</InAppLink>
          </Fact>
        )}
        <Fact label="Case">
          <span dir="auto" className="font-mono text-xs">
            {f.caseKey}
          </span>
        </Fact>
        {f.status === 'done' && f.closedAt && (
          <Fact label="Closed" wide>
            <time dateTime={f.closedAt} data-tip={factoryTimestamp(f.closedAt, tz)}>
              {factoryMoment(f.closedAt, tz)}
            </time>
            {f.closedByName && <span dir="auto"> by {f.closedByName}</span>}
          </Fact>
        )}
      </dl>

      {f.status === 'done' && f.closingNote && (
        <div className="rounded-2xl bg-emerald-50 px-4 py-3 ring-1 ring-emerald-200 dark:bg-emerald-500/10 dark:ring-emerald-500/25">
          <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-emerald-800 dark:text-emerald-300">
            <CheckCircle2 className="h-3.5 w-3.5" /> Closing note
          </p>
          <p dir="auto" className="mt-1 whitespace-pre-line break-words text-sm text-slate-800 dark:text-slate-100">
            {f.closingNote}
          </p>
        </div>
      )}

      {f.canEdit && (
        <Section icon={<CircleDot className="h-4 w-4" />} title="Status">
          <div role="group" aria-label="Status" className="inline-flex flex-wrap gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-800">
            {FOLLOW_UP_STATUSES.map((s) => {
              const on = (closing ? 'done' : f.status) === s
              return (
                <button
                  key={s}
                  type="button"
                  aria-pressed={on}
                  disabled={busy !== null}
                  onClick={() => pickStatus(s)}
                  className={cn(
                    'inline-flex min-h-[36px] items-center gap-1.5 rounded-lg px-3 text-sm font-semibold transition-colors disabled:opacity-60 touch:min-h-[44px]',
                    on ? 'bg-white text-brand-700 shadow-sm dark:bg-slate-900 dark:text-brand-300' : 'text-muted hover:text-slate-800 dark:hover:text-slate-100',
                  )}
                >
                  {busy === 'status' && on && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {FOLLOW_UP_STATUS_LABEL[s]}
                </button>
              )
            })}
          </div>
          {closing && f.status !== 'done' && (
            <div className="mt-3 space-y-2 animate-page-in">
              <label className="block">
                <span className="label">Closing note</span>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={FOLLOW_UP_COMMENT_MAX}
                  rows={3}
                  dir="auto"
                  autoFocus
                  placeholder="What was found and what was done"
                  className="input min-h-[88px] py-2"
                />
              </label>
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" onClick={() => void close()} disabled={!note.trim() || busy !== null} className="min-h-[44px]">
                  {busy === 'status' ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Close the follow-up
                </Button>
                <Button onClick={() => setClosing(false)} disabled={busy !== null} className="min-h-[44px]">
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </Section>
      )}

      {/* A closed follow-up has no one to chase and no deadline to keep: reopened, it can be given and moved again. */}
      {mayReassign && (
        <Section icon={<UserRound className="h-4 w-4" />} title="Assignee and deadline">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <label className="block">
                <span className="label">Assigned to</span>
                <Select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} disabled={busy !== null || !people} aria-label="Assigned to">
                  {!f.assignee && <option value="">Nobody</option>}
                  {/* Whom it is given to now, though no longer among the people it can be given to (an account switched off since). */}
                  {choices.current && <option value={choices.current.id}>{choices.current.name}</option>}
                  {choices.groups.map((g) => (
                    <optgroup key={g.role} label={g.label}>
                      {g.people.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} ({p.username})
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </Select>
              </label>
              {peopleLoading && <span className="block text-xs text-muted">Loading the people…</span>}
              {peopleFailed && !people && (
                <span className="flex flex-wrap items-center gap-x-2 text-xs text-rose-700 dark:text-rose-300">
                  The people could not be loaded.
                  <button type="button" onClick={() => void refetchPeople()} className="font-semibold text-brand-700 hover:underline dark:text-brand-300 touch:min-h-[44px]">
                    Try again
                  </button>
                </span>
              )}
              <Button onClick={saveAssignee} disabled={busy !== null || !assigneeId || assigneeId === (f.assignee?.id ?? '')} className="min-h-[44px]">
                {busy === 'assignee' ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserRound className="h-4 w-4" />} Reassign
              </Button>
            </div>
            <div className="space-y-2">
              <label className="block">
                <span className="label">Deadline</span>
                <input
                  type="datetime-local"
                  value={dueWall}
                  min={factoryWallTime(f.createdAt, tz)}
                  onChange={(e) => setDueWall(e.target.value)}
                  disabled={busy !== null}
                  className="input"
                  aria-label="Deadline"
                />
                {deviceZone && deviceZone !== tz && <span className="mt-1 block text-xs text-muted">The factory’s clock ({tz}).</span>}
              </label>
              <Button onClick={saveDue} disabled={busy !== null || !dueChanged} className="min-h-[44px]">
                {busy === 'due' ? <Loader2 className="h-4 w-4 animate-spin" /> : <CalendarClock className="h-4 w-4" />} Move the deadline
              </Button>
            </div>
          </div>
        </Section>
      )}

      <Section icon={<Zap className="h-4 w-4" />} title="The case">
        <CaseValues columns={f.caseColumns} row={f.caseRow} />
      </Section>

      <Section icon={<MessageSquareText className="h-4 w-4" />} title="Timeline" count={f.commentCount}>
        <ol className="space-y-2">
          {f.events.map((e) => (
            <TimelineEvent key={e.id} event={e} timeZone={tz} />
          ))}
        </ol>
        {f.canEdit && (
          <div className="mt-3 space-y-2">
            <label className="block">
              <span className="sr-only">Comment</span>
              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault()
                    void send()
                  }
                }}
                maxLength={FOLLOW_UP_COMMENT_MAX}
                rows={3}
                dir="auto"
                placeholder="Write a comment for the people on this follow-up"
                className="input min-h-[88px] py-2"
              />
            </label>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted">{comment.length > FOLLOW_UP_COMMENT_MAX - 200 ? `${FOLLOW_UP_COMMENT_MAX - comment.length} characters left` : 'Ctrl+Enter sends'}</span>
              <Button variant="primary" onClick={() => void send()} disabled={!comment.trim() || busy !== null} className="min-h-[44px]">
                {busy === 'comment' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4 rtl:rotate-180" />} Comment
              </Button>
            </div>
          </div>
        )}
      </Section>
    </div>
  )
}

function TimelineEvent({ event: e, timeZone }: { event: FollowUpEvent; timeZone: string }) {
  const Icon = EVENT_ICON[e.kind]
  const when = (
    <time dateTime={e.createdAt} data-tip={factoryTimestamp(e.createdAt, timeZone)} className="tabular-nums">
      {factoryMoment(e.createdAt, timeZone)}
    </time>
  )
  if (e.kind === 'comment') {
    return (
      <li className="flex items-start gap-2.5">
        <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
          <Icon className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1 rounded-2xl rounded-tl-md bg-white px-3 py-2 ring-1 ring-slate-200 dark:bg-slate-800 dark:ring-slate-700">
          <p className="flex flex-wrap items-baseline justify-between gap-x-2 text-xs">
            <span dir="auto" className="font-bold text-slate-800 dark:text-slate-100">
              {e.authorName}
            </span>
            <span className="text-muted">{when}</span>
          </p>
          <p dir="auto" className="mt-0.5 whitespace-pre-wrap break-words text-sm">
            {e.body}
          </p>
        </div>
      </li>
    )
  }
  return (
    <li className="flex items-start gap-2.5">
      <span className={cn('mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full', EVENT_TONE[e.kind] ?? 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400')}>
        <Icon className="h-3.5 w-3.5" />
      </span>
      <p className="min-w-0 flex-1 pt-1 text-sm text-slate-600 dark:text-slate-300">
        <span dir="auto" className="whitespace-pre-line break-words">
          {e.body}
        </span>
        <span className="text-xs text-muted">
          {' '}
          — <span dir="auto">{e.authorName}</span> · {when}
        </span>
      </p>
    </li>
  )
}
