// ============================================================================
// §23 — a notice the assistant drafted, as a card in its answer: a new
// notice, a change to one, its withdrawal or its deletion. A new notice or a
// change shows exactly as the reader will see it (the notice's own card, in
// its preview mode), with its days, whom it is aimed at and how its targets
// combine, and how many people it reaches; a change also lists what it
// changes, before → after. A withdrawal or a deletion shows the notice as it
// is, under a word on what the button does. Nothing changes until the person
// who asked presses its button — Publish, Apply changes, Withdraw, or Delete
// (which asks once more) — and Discard sets it aside. Photos and files are
// not the assistant's: a change keeps them, and the card says so.
//
// Once decided the card says so — "Published · Open in Notices" — here and
// wherever the conversation is open; one decided before it was drawn keeps
// what it proposed folded away (the notice may have changed on the Notices
// page since). Replaced by a newer card it turns muted and folded; out of
// date (the notice changed or went after the card was made) it says to ask
// again. A draft the server did not accept shows compactly, like a failed
// query: the assistant was told why and usually tries again.
// ============================================================================

import { memo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ArrowDown, ArrowRight, Ban, BellOff, BellPlus, CheckCircle2, ChevronDown, Loader2, OctagonX, Paperclip, PenLine, Send, Trash2, Undo2, Users, X } from 'lucide-react'
import type { AiNoticeAction, AiNoticeDraft, AiNoticePart } from '@qc/shared/noticeAssistant'
import { can } from '@qc/shared/rules'
import { NOTICE_TARGET_LABEL, type NoticeTarget } from '@qc/shared/types'
import { Badge, Button, Modal } from '@/components/ui'
import { NoticeCard, TargetChips } from '@/components/notices/NoticeCard'
import { PROPOSAL_WAIT } from '@/components/automations/AutomationProposalCard'
import { ErrorList, errorLines } from '@/components/automations/parts'
import { ApiError } from '@/lib/api'
import { textDirection } from '@/lib/direction'
import { cn, formatDateTime, formatFullTimestamp } from '@/lib/utils'
import { applyNoticeProposal, discardNoticeProposal } from '@/services/noticeProposals'
import { useApp } from '@/store/AppContext'
import { useAuth } from '@/store/AuthContext'
import {
  NOTICE_ACTION_BUSY,
  NOTICE_ACTION_BUTTON,
  NOTICE_ACTION_FAILED,
  NOTICE_ACTION_HINT,
  NOTICE_ACTION_TITLE,
  NOTICE_APPLIED,
  NOTICE_REFUSED,
  NOTICE_STATE_TONE,
  appliedToast,
  attachmentsNote,
  daysText,
  matchModeText,
  noticeChanges,
  noticePartOf,
  noticeStateLabel,
  noticeTitle,
  previewNotice,
  reachText,
  reachesNobody,
  staleText,
  type NoticeChange,
} from './noticeProposal'

const ACTION_BTN = 'min-h-[40px] touch:min-h-[44px]'

/** Each action's mark and colours: a new notice or a change in the brand's, a withdrawal amber, a deletion red. */
const ACTION_LOOK: Record<AiNoticeAction, { icon: typeof BellPlus; tile: string; wash: string; ring: string }> = {
  create: { icon: BellPlus, tile: 'bg-brand-600 text-white', wash: 'from-brand-50/70 dark:from-brand-500/10', ring: 'ring-brand-200 dark:ring-brand-500/30' },
  update: { icon: PenLine, tile: 'bg-brand-600 text-white', wash: 'from-brand-50/70 dark:from-brand-500/10', ring: 'ring-brand-200 dark:ring-brand-500/30' },
  withdraw: { icon: BellOff, tile: 'bg-amber-500 text-white', wash: 'from-amber-50/80 dark:from-amber-500/10', ring: 'ring-amber-200 dark:ring-amber-500/30' },
  delete: { icon: Trash2, tile: 'bg-rose-600 text-white', wash: 'from-rose-50/80 dark:from-rose-500/10', ring: 'ring-rose-200 dark:ring-rose-500/30' },
}

/**
 * `writing`: an answer that may still replace it is not finished yet — its
 * own, or a later one of the conversation that drafted a notice card. Its
 * buttons wait until it ends.
 */
export const AiNoticeProposalCard = memo(function AiNoticeProposalCard({ part, writing = false }: { part: AiNoticePart; writing?: boolean }) {
  // The card as its button or Discard left it, until the conversation itself says so.
  const [decided, setDecided] = useState<AiNoticePart | null>(null)
  const shown = decided && decided.proposalId === part.proposalId && part.state === 'proposed' ? decided : part
  // A new notice or a change carries the notice as it will be; a withdrawal or a deletion, the notice as it is.
  const notice = shown.action === 'create' || shown.action === 'update' ? shown.draft : shown.before
  if (!shown.ok || !notice) return <FailedNotice part={shown} />
  return <Proposal part={shown} notice={notice} writing={writing} onDecided={setDecided} />
})

function Proposal({ part, notice, writing, onDecided }: { part: AiNoticePart; notice: AiNoticeDraft; writing: boolean; onDecided: (p: AiNoticePart) => void }) {
  const qc = useQueryClient()
  const { toast } = useApp()
  const { role } = useAuth()
  const [busy, setBusy] = useState<'apply' | 'discard' | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [problems, setProblems] = useState<string[] | null>(null)
  // Decided before this card was drawn: what it proposed stays folded — the notice may have changed on its page since.
  const [showProposal, setShowProposal] = useState(part.state !== 'applied')
  // Replaced by a newer card, before it was drawn or while in view: folded, the newer card below is the one to read.
  const [showReplaced, setShowReplaced] = useState(false)

  const { action, state } = part
  const look = ACTION_LOOK[action]
  const proposed = state === 'proposed'
  const applied = state === 'applied'
  const superseded = state === 'superseded'
  const shownOpen = superseded ? showReplaced : showProposal
  const folded = (applied || superseded) && !shownOpen
  const title = noticeTitle(part)
  const changes = action === 'update' && part.before && part.draft ? noticeChanges(part.before, part.draft) : null
  const attachments = attachmentsNote(action, notice.attachments ?? part.before?.attachments)
  // The Notices page is an administrator's: the link is offered only while the person still is one.
  const mayOpenNotices = can(role, 'manage-admin-data')

  /**
   * A refusal, said in a toast and on the card. A conflict: decided elsewhere, replaced by a newer card, or the
   * notice changed since — the card as the server sent it along takes over (out of date, applied already), and the
   * conversation is fetched again (applyNoticeProposal). Not found: the permission may be gone, or the card.
   */
  const refused = (e: unknown, fallback: string) => {
    setConfirmDelete(false)
    const settled = noticePartOf(e, part.proposalId)
    if (settled) onDecided(settled)
    if (e instanceof ApiError && e.status === 404) {
      const why = 'It can no longer be decided here: you may no longer manage notices through the assistant, or the card is gone.'
      toast(why, 'error')
      setProblems([why])
      return
    }
    const lines = errorLines(e, fallback)
    toast(lines[0], e instanceof ApiError && e.status === 409 ? 'warning' : 'error')
    setProblems(lines)
  }

  const apply = async () => {
    setBusy('apply')
    setProblems(null)
    try {
      const res = await applyNoticeProposal(qc, part.proposalId)
      onDecided(res.part)
      setConfirmDelete(false)
      toast(appliedToast(action, title), 'success')
    } catch (e) {
      refused(e, NOTICE_ACTION_FAILED[action])
    } finally {
      setBusy(null)
    }
  }

  const discard = async () => {
    setBusy('discard')
    setProblems(null)
    try {
      const res = await discardNoticeProposal(qc, part.proposalId)
      onDecided(res.part)
    } catch (e) {
      refused(e, 'Could not discard it.')
    } finally {
      setBusy(null)
    }
  }


  return (
    <article
      aria-label={`${NOTICE_ACTION_TITLE[action]}: ${title}`}
      className={cn(
        'my-2 overflow-hidden rounded-2xl bg-white shadow-sm ring-1 dark:bg-slate-900',
        applied ? 'ring-emerald-200 dark:ring-emerald-500/30' : proposed ? look.ring : 'ring-slate-200 opacity-80 dark:ring-slate-800',
      )}
    >
      <header className={cn('flex items-start gap-3 border-b border-slate-100 bg-gradient-to-b to-transparent px-3 py-2.5 dark:border-slate-800', look.wash)}>
        <span aria-hidden className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-xl shadow-sm', look.tile)}>
          <look.icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-bold uppercase tracking-wide text-muted">{NOTICE_ACTION_TITLE[action]}</span>
            <Badge tone={NOTICE_STATE_TONE[state]}>{noticeStateLabel(action, state)}</Badge>
          </div>
          <h4 dir={textDirection(title) ?? 'auto'} className="mt-1 break-words text-start text-sm font-bold text-slate-900 dark:text-slate-50">
            {title || 'Untitled notice'}
          </h4>
        </div>
      </header>

      <div className="space-y-3 px-3 py-3">
        {(applied || superseded) && (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
            {superseded
              ? folded
                ? 'Nothing of it changes: the newer card below is the one to decide.'
                : 'As it was proposed, before the newer card below.'
              : folded
                ? appliedFoldedText(action)
                : action === 'delete'
                  ? 'The notice as it was when you deleted it.'
                  : 'As it was proposed: the notice may have been changed on the Notices page since.'}
            <button
              type="button"
              onClick={() => (superseded ? setShowReplaced((o) => !o) : setShowProposal((o) => !o))}
              aria-expanded={shownOpen}
              className="inline-flex items-center gap-1 font-semibold text-brand-700 hover:underline dark:text-brand-300 touch:min-h-[44px]"
            >
              <ChevronDown className={cn('h-3.5 w-3.5 transition-transform duration-200', shownOpen && 'rotate-180')} /> {shownOpen ? 'Hide what was proposed' : 'Show what was proposed'}
            </button>
          </p>
        )}

        {!folded && (
          <>
            {proposed && (action === 'withdraw' || action === 'delete') && (
              <p
                className={cn(
                  'flex items-start gap-2 rounded-lg px-2.5 py-2 text-xs',
                  action === 'delete' ? 'bg-rose-50 text-rose-800 dark:bg-rose-500/10 dark:text-rose-200' : 'bg-amber-50 text-amber-900 dark:bg-amber-500/10 dark:text-amber-200',
                )}
              >
                <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
                {action === 'delete'
                  ? 'Deleting takes it out of every bell and list, the Notices page included. The record stays for the audit.'
                  : 'Withdrawing stops it showing at once, in the bell and before inspections. The record and every acknowledgement stay.'}
              </p>
            )}
            {action === 'update' && part.before && (
              <p className="rounded-lg bg-violet-50 px-2.5 py-1.5 text-xs text-violet-800 dark:bg-violet-500/10 dark:text-violet-200">
                Changes the notice <bdi dir="auto" className="font-semibold">“{part.before.title}”</bdi> when you apply it.
              </p>
            )}

            <section aria-label={action === 'create' || action === 'update' ? 'As readers will see it' : 'The notice as it is'} className="space-y-1.5">
              <p className="text-[11px] font-bold uppercase tracking-wide text-muted">{action === 'create' || action === 'update' ? 'As readers will see it' : 'The notice as it is'}</p>
              <NoticeCard notice={previewNotice(notice)} preview showTargets={false} />
            </section>

            <NoticeFacts action={action} notice={notice} part={part} />

            {changes && <ChangeList changes={changes} />}

            {attachments && (
              <p className="flex items-start gap-1.5 text-xs text-muted">
                <Paperclip className="mt-px h-3.5 w-3.5 shrink-0" /> {attachments}
              </p>
            )}
          </>
        )}

        {proposed && <ErrorList lines={problems} />}
      </div>

      <footer className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-3 py-2.5 dark:border-slate-800">
        {applied ? (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-13">
            <span className="inline-flex items-center gap-1 font-semibold text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="h-4 w-4" /> {NOTICE_APPLIED[action]}
            </span>
            {part.appliedAt && (
              <time dateTime={part.appliedAt} data-tip={formatFullTimestamp(part.appliedAt)} className="text-xs text-muted">
                {formatDateTime(part.appliedAt)}
                {part.appliedByName ? ` by ${part.appliedByName}` : ''}
              </time>
            )}
            {mayOpenNotices && (
              <>
                <span aria-hidden className="text-muted">
                  ·
                </span>
                <Link to="/notices" className="inline-flex items-center gap-1 font-semibold text-brand-700 hover:underline dark:text-brand-300 touch:min-h-[44px]">
                  Open in Notices <ArrowRight className="h-3.5 w-3.5 rtl:rotate-180" />
                </Link>
              </>
            )}
          </p>
        ) : state === 'discarded' ? (
          <p className="inline-flex items-center gap-1 text-13 text-muted">
            <Ban className="h-4 w-4" /> Discarded — nothing changed. Ask the assistant again any time.
          </p>
        ) : superseded ? (
          <p className="inline-flex items-center gap-1 text-13 text-muted">
            <ArrowDown className="h-4 w-4" /> Replaced by a newer version below
          </p>
        ) : state === 'stale' ? (
          <p className="inline-flex items-start gap-1 text-13 text-amber-800 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {staleText(action)}
          </p>
        ) : (
          <>
            <Button
              variant={action === 'delete' ? 'danger' : 'primary'}
              className={ACTION_BTN}
              onClick={() => (action === 'delete' ? setConfirmDelete(true) : void apply())}
              disabled={writing || busy !== null}
              data-tip={writing ? PROPOSAL_WAIT : undefined}
            >
              {busy === 'apply' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ActionIcon action={action} />} {busy === 'apply' ? NOTICE_ACTION_BUSY[action] : NOTICE_ACTION_BUTTON[action]}
            </Button>
            <Button variant="ghost" className={ACTION_BTN} onClick={() => void discard()} disabled={writing || busy !== null} data-tip={writing ? PROPOSAL_WAIT : undefined}>
              {busy === 'discard' ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />} Discard
            </Button>
            <span className="basis-full text-[11px] text-muted sm:ms-auto sm:basis-auto">{NOTICE_ACTION_HINT[action]}</span>
          </>
        )}
      </footer>

      {confirmDelete && proposed && (
        <Modal
          open
          onClose={() => busy === null && setConfirmDelete(false)}
          size="sm"
          title="Delete this notice?"
          footer={
            <>
              <Button onClick={() => setConfirmDelete(false)} disabled={busy !== null}>
                Keep it
              </Button>
              <Button variant="danger" onClick={() => void apply()} disabled={writing || busy !== null} data-tip={writing ? PROPOSAL_WAIT : undefined}>
                {busy === 'apply' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} {busy === 'apply' ? NOTICE_ACTION_BUSY.delete : 'Delete'}
              </Button>
            </>
          }
        >
          <p className="text-sm text-slate-600 dark:text-slate-300">
            <b dir={textDirection(title) ?? 'auto'} className="block break-words">
              {title || 'Untitled notice'}
            </b>
            It disappears from every bell and list, the Notices page included. The record stays for the audit.
          </p>
        </Modal>
      )}
    </article>
  )
}

/** What a decided card says, folded, of the notice now. */
function appliedFoldedText(action: AiNoticeAction): string {
  switch (action) {
    case 'create':
      return 'It is out. The Notices page shows it as it is now, with who has read it.'
    case 'update':
      return 'The change is out. The Notices page shows the notice as it is now, with who has read it.'
    case 'withdraw':
      return 'It no longer shows. The Notices page keeps it, with who has read it.'
    case 'delete':
      return 'It is gone from every bell and list. The record stays for the audit.'
  }
}

function ActionIcon({ action }: { action: AiNoticeAction }) {
  if (action === 'create') return <Send className="h-4 w-4" />
  if (action === 'update') return <CheckCircle2 className="h-4 w-4" />
  if (action === 'withdraw') return <Undo2 className="h-4 w-4" />
  return <Trash2 className="h-4 w-4" />
}

/** Its days, whom it is aimed at and how they combine, and whom it reaches. */
function NoticeFacts({ action, notice, part }: { action: AiNoticeAction; notice: AiNoticeDraft; part: AiNoticePart }) {
  const combine = matchModeText(notice)
  const reach = part.reach
  const nobody = reach ? reachesNobody(reach, notice) : false
  return (
    <dl className="grid gap-x-3 gap-y-2 text-13 sm:grid-cols-[auto_1fr]">
      <Fact term="Shown">{daysText(notice)}</Fact>
      <Fact term="Aimed at">
        <TargetChips notice={notice} />
        {combine && <span className="mt-1 block text-xs text-muted">{combine}</span>}
      </Fact>
      {reach && (
        <Fact term={action === 'create' || action === 'update' ? 'Reaches' : 'Reaches now'}>
          <span className={cn('inline-flex items-start gap-1.5 font-semibold', nobody ? 'text-amber-800 dark:text-amber-300' : 'text-slate-800 dark:text-slate-100')}>
            {nobody ? <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <Users className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />}
            {reachText(reach, notice)}
          </span>
        </Fact>
      )}
    </dl>
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

/** What a change changes, field by field: the value now struck through, the new one marked. */
function ChangeList({ changes }: { changes: NoticeChange[] }) {
  return (
    <section aria-label="What changes" className="space-y-2 rounded-xl bg-slate-50 p-2.5 ring-1 ring-slate-200/70 dark:bg-slate-800/40 dark:ring-slate-800">
      <p className="text-[11px] font-bold uppercase tracking-wide text-muted">What changes</p>
      {changes.length === 0 ? (
        <p className="text-13 text-muted">Nothing: it is the same as the notice is now.</p>
      ) : (
        <ul className="space-y-2">
          {changes.map((c) => (
            <li key={c.field} className="text-13">
              <p className="text-xs font-semibold text-slate-600 dark:text-slate-300">{c.label}</p>
              {c.field === 'targets' ? (
                <div className="mt-1 flex flex-wrap gap-1">
                  {c.removed?.map((t) => (
                    <Badge key={`-${t.kind}:${t.value}`} tone="red" tip="No longer aimed at" className="line-through decoration-1">
                      {targetLabel(t)}
                    </Badge>
                  ))}
                  {c.added?.map((t) => (
                    <Badge key={`+${t.kind}:${t.value}`} tone="green" tip="Newly aimed at">
                      + {targetLabel(t)}
                    </Badge>
                  ))}
                </div>
              ) : (
                <div className={cn('mt-1 grid gap-1', c.field === 'body' ? 'grid-cols-1' : 'sm:grid-cols-[1fr_auto_1fr] sm:items-start')}>
                  <span dir={textDirection(c.before) ?? 'auto'} className="whitespace-pre-wrap break-words rounded-md bg-rose-50 px-2 py-1 text-start text-rose-800 line-through decoration-rose-400/70 dark:bg-rose-500/10 dark:text-rose-200">
                    {c.before || 'No text'}
                  </span>
                  <ArrowRight aria-hidden className={cn('h-3.5 w-3.5 self-center text-muted rtl:rotate-180', c.field === 'body' ? 'hidden' : 'hidden sm:block')} />
                  <span className="sr-only">changes to</span>
                  <span dir={textDirection(c.after) ?? 'auto'} className="whitespace-pre-wrap break-words rounded-md bg-emerald-50 px-2 py-1 text-start font-medium text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-200">
                    {c.after || 'No text'}
                  </span>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted">Everything else stays as it is.</p>
    </section>
  )
}

/** A target on a chip: its kind quietly, then its value. */
function targetLabel(t: NoticeTarget): ReactNode {
  return (
    <>
      <span className="font-normal opacity-80">{NOTICE_TARGET_LABEL[t.kind]}</span> <bdi dir="auto">{t.label || t.value}</bdi>
    </>
  )
}

/** A draft the server did not accept: one line, opening on why. */
function FailedNotice({ part }: { part: AiNoticePart }) {
  const [open, setOpen] = useState(false)
  const title = noticeTitle(part)
  return (
    <div className="my-2 overflow-hidden rounded-xl bg-white ring-1 ring-rose-200 dark:bg-slate-900 dark:ring-rose-500/30">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-start gap-2.5 px-3 py-2 text-start transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/60 touch:min-h-[44px]">
        <OctagonX className="mt-0.5 h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400" />
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 text-13 font-semibold text-slate-800 dark:text-slate-100">
            <span className="font-medium text-rose-700 dark:text-rose-300">{NOTICE_REFUSED[part.action] ?? 'Notice card not accepted'}</span>
            {title && (
              <>
                : <bdi dir="auto">{title}</bdi>
              </>
            )}
          </span>
          <span className="mt-0.5 block text-[11px] text-muted">The assistant was told what to fix; nothing changed.</span>
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
