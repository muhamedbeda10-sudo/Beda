// ============================================================================
// A task the assistant drafted, as a card in its answer: what is to be done,
// the details, to whom, how urgent and by when on the factory's clock.
// Nothing is sent until the person who asked presses Send task (each person
// it goes to is then told in their bell); Discard sets it aside.
//
// Once sent the card says so — "Sent as T-12 · Open task" — here and wherever
// the conversation is open. Replaced by a newer card it turns muted and
// folded. A draft the server did not accept shows compactly, like a failed
// query: the assistant was told why and usually tries again.
// ============================================================================

import { memo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowRight, Ban, CalendarClock, CheckCircle2, ChevronDown, ListTodo, Loader2, OctagonX, Send, X } from 'lucide-react'
import type { AiTaskDraft, AiTaskPart } from '@qc/shared/ai'
import { Badge, Button } from '@/components/ui'
import { PROPOSAL_WAIT } from '@/components/automations/AutomationProposalCard'
import { ErrorList, errorLines } from '@/components/automations/parts'
import { factoryMoment, factoryTimestamp } from '@/components/followUps/wording'
import { PriorityBadge } from '@/components/tasks/parts'
import { ApiError } from '@/lib/api'
import { textDirection } from '@/lib/direction'
import { cn } from '@/lib/utils'
import { discardTaskProposal, sendTaskProposal } from '@/services/taskProposals'
import { useApp } from '@/store/AppContext'
import { useAuth } from '@/store/AuthContext'
import { useAi } from './AiAssistantProvider'
import { TASK_CARD_STATE_LABEL, TASK_CARD_STATE_TONE, sentToast, taskPartOf } from './taskProposal'

const ACTION_BTN = 'min-h-[40px] touch:min-h-[44px]'

/**
 * `writing`: an answer that may still replace it is not finished yet — its
 * own, or a later one of the conversation that drafted a task card. Its
 * buttons wait until it ends.
 */
export const AiTaskProposalCard = memo(function AiTaskProposalCard({ part, writing = false }: { part: AiTaskPart; writing?: boolean }) {
  // The card as its button left it, until the conversation itself says so.
  const [decided, setDecided] = useState<AiTaskPart | null>(null)
  const shown = decided && decided.proposalId === part.proposalId && part.state === 'proposed' ? decided : part
  if (!shown.ok || !shown.draft) return <FailedTask part={shown} />
  return <Proposal part={shown} draft={shown.draft} writing={writing} onDecided={setDecided} />
})

function Proposal({ part, draft, writing, onDecided }: { part: AiTaskPart; draft: AiTaskDraft; writing: boolean; onDecided: (p: AiTaskPart) => void }) {
  const qc = useQueryClient()
  const { toast } = useApp()
  const { factoryTimeZone: tz } = useAuth()
  const { docked, setOpen } = useAi()
  const [busy, setBusy] = useState<'send' | 'discard' | null>(null)
  const [problems, setProblems] = useState<string[] | null>(null)
  // Replaced by a newer card: folded, the newer card below is the one to read.
  const [showReplaced, setShowReplaced] = useState(false)

  const { state } = part
  const proposed = state === 'proposed'
  const sent = state === 'sent'
  const superseded = state === 'superseded'
  const folded = superseded && !showReplaced

  /**
   * A refusal, said in a toast and on the card. A conflict: decided elsewhere or replaced by a newer card — the card
   * as the server sent it along takes over, and the conversation is fetched again (taskProposals). Not found: the
   * card is gone. Anything else (a person no longer reachable, a deadline passed): the server's words.
   */
  const refused = (e: unknown, fallback: string) => {
    const settled = taskPartOf(e, part.proposalId)
    if (settled) onDecided(settled)
    if (e instanceof ApiError && e.status === 404) {
      const why = 'It can no longer be sent from here: the card or its conversation is gone.'
      toast(why, 'error')
      setProblems([why])
      return
    }
    const lines = errorLines(e, fallback)
    if (e instanceof ApiError && e.status === 400) lines.push('Ask the assistant for a new card with the change.')
    toast(lines[0], e instanceof ApiError && e.status === 409 ? 'warning' : 'error')
    setProblems(lines)
  }

  const send = async () => {
    setBusy('send')
    setProblems(null)
    try {
      const res = await sendTaskProposal(qc, part.proposalId)
      onDecided(res.part)
      toast(sentToast(res.part), 'success')
    } catch (e) {
      refused(e, 'The task could not be sent.')
    } finally {
      setBusy(null)
    }
  }

  const discard = async () => {
    setBusy('discard')
    setProblems(null)
    try {
      const res = await discardTaskProposal(qc, part.proposalId)
      onDecided(res.part)
    } catch (e) {
      refused(e, 'Could not discard it.')
    } finally {
      setBusy(null)
    }
  }

  // Opening the task's page from a sheet over the page puts the sheet away, so the page is in view.
  const leaveForPage = () => {
    if (!docked) setOpen(false)
  }

  return (
    <article
      aria-label={`Task: ${draft.title}`}
      className={cn(
        'my-2 overflow-hidden rounded-2xl bg-white shadow-sm ring-1 dark:bg-slate-900',
        sent ? 'ring-emerald-200 dark:ring-emerald-500/30' : proposed ? 'ring-brand-200 dark:ring-brand-500/30' : 'ring-slate-200 opacity-80 dark:ring-slate-800',
      )}
    >
      <header className="flex items-start gap-3 border-b border-slate-100 bg-gradient-to-b from-brand-50/70 to-transparent px-3 py-2.5 dark:border-slate-800 dark:from-brand-500/10">
        <span aria-hidden className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-xl shadow-sm', sent ? 'bg-emerald-600 text-white' : 'bg-brand-600 text-white')}>
          <ListTodo className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-bold uppercase tracking-wide text-muted">{sent ? `Task T-${part.taskNumber ?? '…'}` : 'New task'}</span>
            <Badge tone={TASK_CARD_STATE_TONE[state]}>{TASK_CARD_STATE_LABEL[state]}</Badge>
            <PriorityBadge priority={draft.priority} />
          </div>
          <h4 dir={textDirection(draft.title) ?? 'auto'} className="mt-1 break-words text-start text-sm font-bold text-slate-900 dark:text-slate-50">
            {draft.title}
          </h4>
        </div>
      </header>

      <div className="space-y-3 px-3 py-3">
        {superseded && (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
            {folded ? 'Nothing of it is sent: the newer card below is the one to send.' : 'As it was drafted, before the newer card below.'}
            <button
              type="button"
              onClick={() => setShowReplaced((o) => !o)}
              aria-expanded={showReplaced}
              className="inline-flex items-center gap-1 font-semibold text-brand-700 hover:underline dark:text-brand-300 touch:min-h-[44px]"
            >
              <ChevronDown className={cn('h-3.5 w-3.5 transition-transform duration-200', showReplaced && 'rotate-180')} /> {showReplaced ? 'Hide it' : 'Show it'}
            </button>
          </p>
        )}

        {!folded && (
          <>
            {draft.description && (
              <p dir="auto" className="whitespace-pre-wrap break-words text-13 text-slate-700 dark:text-slate-200">
                {draft.description}
              </p>
            )}
            <dl className="grid gap-x-3 gap-y-2 text-13 sm:grid-cols-[auto_1fr]">
              <Fact term={draft.assignees.length === 1 ? 'Goes to' : `Goes to · ${draft.assignees.length}`}>
                <ul className="flex flex-wrap gap-1.5">
                  {draft.assignees.map((a) => (
                    <li key={a.id} className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                      <bdi>{a.name}</bdi>
                    </li>
                  ))}
                </ul>
              </Fact>
              <Fact term="Deadline">
                {draft.dueAt ? (
                  <span className="inline-flex items-center gap-1 tabular-nums">
                    <CalendarClock className="h-3.5 w-3.5 text-muted" />
                    <time dateTime={draft.dueAt} data-tip={factoryTimestamp(draft.dueAt, tz)}>
                      {factoryMoment(draft.dueAt, tz)}
                    </time>
                  </span>
                ) : (
                  <span className="text-muted">None</span>
                )}
              </Fact>
            </dl>
          </>
        )}

        {proposed && <ErrorList lines={problems} />}
      </div>

      <footer className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-3 py-2.5 dark:border-slate-800">
        {sent ? (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-13">
            <span className="inline-flex items-center gap-1 font-semibold text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="h-4 w-4" /> Sent{part.taskNumber !== undefined ? ` as T-${part.taskNumber}` : ''}
            </span>
            {part.taskId && (
              <>
                <span aria-hidden className="text-muted">
                  ·
                </span>
                <Link to={`/tasks/${part.taskId}`} onClick={leaveForPage} className="inline-flex items-center gap-1 font-semibold text-brand-700 hover:underline dark:text-brand-300 touch:min-h-[44px]">
                  Open task <ArrowRight className="h-3.5 w-3.5 rtl:rotate-180" />
                </Link>
              </>
            )}
          </p>
        ) : state === 'discarded' ? (
          <p className="inline-flex items-center gap-1 text-13 text-muted">
            <Ban className="h-4 w-4" /> Discarded — nothing was sent. Ask the assistant again any time.
          </p>
        ) : superseded ? (
          <p className="inline-flex items-center gap-1 text-13 text-muted">
            <ArrowDown className="h-4 w-4" /> Replaced by a newer version below
          </p>
        ) : (
          <>
            <Button variant="primary" className={ACTION_BTN} onClick={() => void send()} disabled={writing || busy !== null} data-tip={writing ? PROPOSAL_WAIT : undefined}>
              {busy === 'send' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} {busy === 'send' ? 'Sending…' : 'Send task'}
            </Button>
            <Button variant="ghost" className={ACTION_BTN} onClick={() => void discard()} disabled={writing || busy !== null} data-tip={writing ? PROPOSAL_WAIT : undefined}>
              {busy === 'discard' ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />} Discard
            </Button>
            <span className="basis-full text-[11px] text-muted sm:ms-auto sm:basis-auto">Each person is told in their bell when you send it.</span>
          </>
        )}
      </footer>
    </article>
  )
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-[11px] font-bold uppercase tracking-wide text-muted sm:pt-0.5">{term}</dt>
      <dd className="-mt-1.5 min-w-0 text-slate-700 dark:text-slate-200 sm:mt-0">{children}</dd>
    </>
  )
}

/** A draft the server did not accept: compact, its reasons a tap away. */
function FailedTask({ part }: { part: AiTaskPart }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="my-2 overflow-hidden rounded-xl bg-white ring-1 ring-rose-200 dark:bg-slate-900 dark:ring-rose-500/30">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-start gap-2.5 px-3 py-2 text-start transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/60 touch:min-h-[44px]">
        <OctagonX className="mt-0.5 h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400" />
        <span className="min-w-0 flex-1">
          <span className="text-13 font-medium text-rose-700 dark:text-rose-300">Task card not accepted</span>
          <span className="mt-0.5 block text-[11px] text-muted">The assistant was told what to fix; nothing was sent.</span>
        </span>
        <ChevronDown className={cn('mt-0.5 h-4 w-4 shrink-0 text-muted transition-transform duration-200', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="border-t border-slate-100 px-3 pb-3 pt-2 dark:border-slate-800">
          <p dir="auto" className="whitespace-pre-wrap break-words rounded-lg bg-rose-50 px-2.5 py-2 text-xs text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
            {part.error || 'It did not pass the checks.'}
          </p>
        </div>
      )}
    </div>
  )
}
