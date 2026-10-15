// ============================================================================
// §21 — an automation the assistant proposed, as a card in its answer. It
// says in plain words what would run and when, whom it would tell and where,
// what it would do with each case — and what running it once found, and when
// (a card is read again days later): the cases matching (a few of them, and
// what a notification of the first would say), or each section of a report.
// A change of one of the person's automations names it, and says what
// becomes of the cases matching now: those it has already seen never fire
// again, and those it has not either carry on (the same query and key
// column) or are recorded as seen unless the person asks to be alerted.
// Nothing runs until the person who asked presses Activate; Edit changes its
// words, people, channels, actions and timing first (its queries change only
// by asking the assistant), and Discard sets it aside. Once decided, the card
// says so — "Active · Open in Automations" — here and wherever the
// conversation is open; an activated one opened later keeps what was proposed
// folded away, since its page may have changed it since.
//
// §22 — a newer version proposed later in the conversation replaces it: the
// card turns muted, says so, offers nothing to decide, and keeps what it
// proposed folded away (still there to read). It turns so the moment the
// newer card arrives, and on every reload after. Pressing a button of a card
// decided or replaced elsewhere fetches the conversation again and says why.
//
// A draft the server did not accept shows compactly, like a failed query:
// the assistant was told why and usually tries again in the same answer.
// ============================================================================

import { memo, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowRight, Ban, CheckCircle2, ChevronDown, Loader2, OctagonX, Pencil, Undo2, X, Zap } from 'lucide-react'
import type { AiAutomationPart, AutomationDraft, AutomationEdits } from '@qc/shared/automation'
import { Badge, Button } from '@/components/ui'
import { cn } from '@/lib/utils'
import { ApiError } from '@/lib/api'
import { activateProposal, discardProposal, recheckAccessOn404, useAutomationPeople } from '@/services/automations'
import { useApp } from '@/store/AppContext'
import { useAuth } from '@/store/AuthContext'
import { AutomationEditor } from './AutomationEditor'
import { CasesTable, DefinitionFacts, ErrorList, KindBadge, NotificationPreview, SectionsPreview, errorLines, periodText } from './parts'
import {
  PROPOSAL_STATE_LABEL,
  PROPOSAL_STATE_TONE,
  applyEdits,
  assigneeView,
  automationSummary,
  existingCases,
  factoryMoment,
  factoryTimestamp,
  hasEdits,
  knownWatchColumns,
  matchedText,
  recipientViews,
  type AutomationPerson,
} from './wording'

/** Why the buttons wait while the answer is still being written: the proposal is kept with the answer's round. */
export const PROPOSAL_WAIT = 'Available when the answer is finished'

const ACTION_BTN = 'min-h-[40px] touch:min-h-[44px]'

/** `writing`: its answer is not finished yet. */
export const AutomationProposalCard = memo(function AutomationProposalCard({ part, writing = false }: { part: AiAutomationPart; writing?: boolean }) {
  // The card as the last Activate or Discard left it, until the conversation itself says so.
  const [decided, setDecided] = useState<AiAutomationPart | null>(null)
  const shown = decided && decided.proposalId === part.proposalId && part.state === 'proposed' ? decided : part
  if (!shown.ok || !shown.draft) return <FailedDraft part={shown} />
  return <Proposal part={shown} draft={shown.draft} writing={writing} onDecided={setDecided} />
})

function Proposal({ part, draft, writing, onDecided }: { part: AiAutomationPart; draft: AutomationDraft; writing: boolean; onDecided: (p: AiAutomationPart) => void }) {
  const qc = useQueryClient()
  const { toast } = useApp()
  const { profile, factoryTimeZone } = useAuth()
  const [edits, setEdits] = useState<AutomationEdits | null>(null)
  const [editing, setEditing] = useState(false)
  const [notifyExisting, setNotifyExisting] = useState(false)
  const [busy, setBusy] = useState<'activate' | 'discard' | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [problems, setProblems] = useState<string[] | null>(null)
  // Activated before this card was drawn: what was proposed stays folded — the automation may have been changed on its page since.
  const [showProposal, setShowProposal] = useState(part.state !== 'activated')
  // Replaced by a newer version, before it was drawn or while in view: folded, the newer card below is the one to read.
  const [showReplaced, setShowReplaced] = useState(false)

  const proposed = part.state === 'proposed'
  const activated = part.state === 'activated'
  const superseded = part.state === 'superseded'
  const shownOpen = superseded ? showReplaced : showProposal
  const toggleShown = () => (superseded ? setShowReplaced((o) => !o) : setShowProposal((o) => !o))
  const folded = (activated || superseded) && !shownOpen
  // Changes made here count while it can still be activated; decided or replaced, it shows what was proposed.
  const changes = proposed ? edits : null
  const bt = part.backtest
  const watch = draft.kind === 'watch'
  const creatorName = profile?.name ?? 'You'
  // The columns the trial run returned; without one that worked, those the definition names.
  const columns = useMemo(() => (watch ? (bt?.ok && bt.columns ? bt.columns : knownWatchColumns(draft)) : []), [watch, bt, draft])

  // Changes made here show at once; names for people added come from the list the editor loaded.
  const people = useAutomationPeople(changes !== null)
  const peopleMap = useMemo(() => (people.data ? new Map<string, AutomationPerson>(people.data.people.map((p) => [p.id, p])) : null), [people.data])
  const def = useMemo(() => (changes ? applyEdits(draft, changes) : draft), [draft, changes])
  const recipients = changes?.recipients ? recipientViews(def.recipients, peopleMap, part.recipients ?? [], watch ? columns : null) : (part.recipients ?? recipientViews(def.recipients, null))
  const f = def.actions.followUp
  const assignee = f ? (changes?.actions ? assigneeView(f.assignee, peopleMap, creatorName, part.assignee, watch ? columns : null) : (part.assignee ?? assigneeView(f.assignee, null, creatorName))) : undefined
  const summary = automationSummary({ ...def, recipients, assignee, linkedReport: part.linkedReport })
  const matched = bt?.matched ?? 0
  // What becomes of the cases matching now: a change of a watch says how many its automation has not seen yet, and whether they carry on.
  const cases = watch && bt?.ok ? existingCases(draft.replacesAutomationId ? bt : { ...bt, newCases: undefined, keepsCases: undefined }, notifyExisting) : null
  // The automation it was to change was deleted since: activating it is refused, so it says so first.
  const replacedGone = !!draft.replacesAutomationId && !part.replacesName

  /**
   * A refusal, said on the card. Not found: the permission may be gone (or the proposal), and /ai/me says which.
   * A conflict: it was decided elsewhere (another tab), or a newer version replaced it — the conversation is being
   * fetched again to show how it stands (activateProposal, discardProposal), and a toast says why; the card says
   * it too while it is still offered.
   */
  const refused = (e: unknown, fallback: string) => {
    if (e instanceof ApiError && e.status === 404) {
      recheckAccessOn404(qc, e)
      setProblems(['It can no longer be decided here: you may no longer create automations, or the proposal is gone.'])
      return
    }
    if (e instanceof ApiError && e.status === 409) toast(e.message || fallback, 'warning')
    setProblems(errorLines(e, fallback))
  }

  const activate = async () => {
    setBusy('activate')
    setProblems(null)
    try {
      // The choice counts only while it is offered: a change keeping its cases carries them on, whatever it says.
      const res = await activateProposal(qc, part.proposalId, { ...(edits ? { edits } : {}), ...(watch ? { notifyExisting: notifyExisting && !!cases?.offer } : {}) })
      onDecided(res.part)
      setEdits(null)
      toast(part.replacesName ? `“${res.automation.name}” is changed. The change is in the audit log.` : `“${res.automation.name}” is active. The change is in the audit log.`, 'success')
    } catch (e) {
      refused(e, 'Could not activate it.')
    } finally {
      setBusy(null)
    }
  }

  const discard = async () => {
    setBusy('discard')
    setProblems(null)
    try {
      const res = await discardProposal(qc, part.proposalId)
      onDecided(res.part)
      setConfirmDiscard(false)
    } catch (e) {
      refused(e, 'Could not discard it.')
    } finally {
      setBusy(null)
    }
  }


  return (
    <article
      aria-label={`Proposed automation: ${def.name}`}
      className={cn(
        'my-2 overflow-hidden rounded-2xl bg-white shadow-sm ring-1 dark:bg-slate-900',
        activated ? 'ring-emerald-200 dark:ring-emerald-500/30' : proposed ? 'ring-brand-200 dark:ring-brand-500/30' : 'ring-slate-200 opacity-80 dark:ring-slate-800',
      )}
    >
      <header className="flex items-start gap-3 border-b border-slate-100 bg-gradient-to-b from-brand-50/70 to-transparent px-3 py-2.5 dark:border-slate-800 dark:from-brand-500/10">
        <span aria-hidden className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand-600 text-white shadow-sm">
          <Zap className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <KindBadge kind={def.kind} />
            <Badge tone={PROPOSAL_STATE_TONE[part.state]}>{PROPOSAL_STATE_LABEL[part.state]}</Badge>
            {hasEdits(changes) && <Badge tone="violet">Changed here</Badge>}
          </div>
          <h4 dir="auto" className="mt-1 break-words text-sm font-bold text-slate-900 dark:text-slate-50">
            {def.name}
          </h4>
          {!folded && (
            <p dir="auto" className="mt-0.5 whitespace-pre-wrap break-words text-xs text-muted">
              {def.description}
            </p>
          )}
        </div>
      </header>

      <div className="space-y-3 px-3 py-3">
        {(activated || superseded) && (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
            {superseded
              ? folded
                ? 'Nothing of it runs: the newer version below is the one to activate.'
                : 'As it was proposed, before the newer version below.'
              : folded
                ? 'It runs on its own now. Its page shows it as it is, with every change and run since.'
                : 'As proposed: it may have been changed on its page since.'}
            <button
              type="button"
              onClick={toggleShown}
              aria-expanded={shownOpen}
              className="inline-flex items-center gap-1 font-semibold text-brand-700 hover:underline dark:text-brand-300 touch:min-h-[44px]"
            >
              <ChevronDown className={cn('h-3.5 w-3.5 transition-transform duration-200', shownOpen && 'rotate-180')} /> {shownOpen ? 'Hide what was proposed' : 'Show what was proposed'}
            </button>
          </p>
        )}

        {!folded && (
          <>
            {part.replacesName && (
              <div className="rounded-lg bg-violet-50 px-2.5 py-1.5 text-xs text-violet-800 dark:bg-violet-500/10 dark:text-violet-200">
                <p>
                  Changes <bdi dir="auto" className="font-semibold">“{part.replacesName}”</bdi> when activated; the cases it has already fired stay fired.
                </p>
                {/* What changes of it as it is now: the server compares while the card waits. */}
                {proposed && part.changes && (
                  <>
                    <p className="mt-1.5 font-semibold">{part.changes.length > 0 ? 'What changes:' : 'It changes nothing of it as it is now.'}</p>
                    {part.changes.length > 0 && (
                      <ul aria-label="What changes" className="mt-0.5 list-disc space-y-0.5 ps-4">
                        {part.changes.map((line, i) => (
                          <li key={i} dir="auto" className="break-words">
                            {line}
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </div>
            )}
            {replacedGone && proposed && (
              <p className="rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
                The automation this was to change is no longer there, so it cannot be activated. Ask the assistant to propose it again.
              </p>
            )}

            <p className="text-13 leading-relaxed text-slate-700 dark:text-slate-200">{summary}</p>
            <DefinitionFacts def={def} recipients={recipients} assignee={assignee} linkedReport={part.linkedReport} />

            {bt && (
              <section aria-label="What a trial run found" className="space-y-2 rounded-xl bg-slate-50 p-2.5 ring-1 ring-slate-200/70 dark:bg-slate-800/40 dark:ring-slate-800">
                <p className="text-[11px] font-bold uppercase tracking-wide text-muted">
                  Tried{' '}
                  <time dateTime={bt.ranAt} data-tip={factoryTimestamp(bt.ranAt, factoryTimeZone)}>
                    {factoryMoment(bt.ranAt, factoryTimeZone)}
                  </time>
                </p>
                {!bt.ok ? (
                  <p dir="auto" className="whitespace-pre-wrap break-words rounded-lg bg-rose-50 px-2.5 py-2 text-xs text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
                    {bt.error || 'The trial run failed.'}
                  </p>
                ) : watch ? (
                  <>
                    <p className="text-13 font-semibold text-slate-800 dark:text-slate-100">{matchedText(matched, !!bt.truncated)}</p>
                    {bt.columns && bt.sampleRows && bt.sampleRows.length > 0 && (
                      <CasesTable title="Cases it found" columns={bt.columns} rows={bt.sampleRows} more={matched > bt.sampleRows.length || !!bt.truncated} />
                    )}
                    <NotificationPreview title={bt.sampleTitle} body={bt.sampleBody} label="What a notification will say (the first case)" />
                  </>
                ) : (
                  <>
                    {bt.period && <p className="text-13 text-slate-700 dark:text-slate-200">Its sections over {periodText(bt.period)}:</p>}
                    {bt.sections && <SectionsPreview sections={bt.sections} />}
                  </>
                )}
              </section>
            )}
          </>
        )}

        {hasEdits(changes) && (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
            Your changes apply when you activate it, and are checked again then; the trial run above is of the proposal as written.
            <button type="button" onClick={() => setEdits(null)} className="inline-flex items-center gap-1 font-semibold text-brand-700 hover:underline dark:text-brand-300 touch:min-h-[44px]">
              <Undo2 className="h-3.5 w-3.5" /> Undo changes
            </button>
          </p>
        )}

        {proposed && cases && (
          <div className="space-y-1">
            {cases.offer && (
              <label className="flex cursor-pointer items-start gap-2 text-13 font-medium text-slate-700 dark:text-slate-200">
                <input type="checkbox" checked={notifyExisting} onChange={(e) => setNotifyExisting(e.target.checked)} disabled={busy !== null} className="mt-0.5 h-4 w-4 shrink-0 accent-brand-600" />
                {cases.offer}
              </label>
            )}
            <p className="text-xs text-muted">{cases.text}</p>
          </div>
        )}

        {proposed && <ErrorList lines={problems} />}
      </div>

      <footer className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-3 py-2.5 dark:border-slate-800">
        {part.state === 'activated' ? (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-13">
            <span className="inline-flex items-center gap-1 font-semibold text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="h-4 w-4" /> Active
            </span>
            {part.automationId && (
              <>
                <span aria-hidden className="text-muted">
                  ·
                </span>
                <Link to={`/automations/${encodeURIComponent(part.automationId)}`} className="inline-flex items-center gap-1 font-semibold text-brand-700 hover:underline dark:text-brand-300 touch:min-h-[44px]">
                  Open in Automations <ArrowRight className="h-3.5 w-3.5 rtl:rotate-180" />
                </Link>
              </>
            )}
          </p>
        ) : part.state === 'discarded' ? (
          <p className="inline-flex items-center gap-1 text-13 text-muted">
            <Ban className="h-4 w-4" /> Discarded — nothing runs. Ask the assistant again any time.
          </p>
        ) : superseded ? (
          <p className="inline-flex items-center gap-1 text-13 text-muted">
            <ArrowDown className="h-4 w-4" /> Replaced by a newer version below
          </p>
        ) : confirmDiscard ? (
          <>
            <span className="text-13 font-medium text-slate-700 dark:text-slate-200">Discard this proposal?</span>
            <Button variant="danger" className={ACTION_BTN} onClick={() => void discard()} disabled={busy !== null}>
              {busy === 'discard' ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />} Discard
            </Button>
            <Button className={ACTION_BTN} onClick={() => setConfirmDiscard(false)} disabled={busy !== null}>
              Keep it
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="primary"
              className={ACTION_BTN}
              onClick={() => void activate()}
              disabled={writing || busy !== null || replacedGone}
              data-tip={
                writing
                  ? PROPOSAL_WAIT
                  : replacedGone
                    ? 'The automation it changes is no longer there'
                    : watch
                      ? def.watch?.hours || def.watch?.weekdays?.length
                        ? 'Starts it now: its first run is within a minute, or as its hours next open'
                        : 'Starts it now: its first run is within a minute'
                      : 'Starts it now: its first run is at its next time'
              }
            >
              {busy === 'activate' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />} {busy === 'activate' ? 'Activating…' : 'Activate'}
            </Button>
            <Button className={ACTION_BTN} onClick={() => setEditing(true)} disabled={writing || busy !== null} data-tip={writing ? PROPOSAL_WAIT : 'Change its words, people, actions or timing first'}>
              <Pencil className="h-4 w-4" /> Edit
            </Button>
            <Button variant="ghost" className={ACTION_BTN} onClick={() => setConfirmDiscard(true)} disabled={writing || busy !== null} data-tip={writing ? PROPOSAL_WAIT : undefined}>
              <X className="h-4 w-4" /> Discard
            </Button>
            <span className="basis-full text-[11px] text-muted sm:ms-auto sm:basis-auto">Nothing runs until you press Activate.</span>
          </>
        )}
      </footer>

      {editing && proposed && (
        <AutomationEditor
          base={draft}
          initialEdits={edits}
          knownRecipients={part.recipients ?? []}
          knownAssignee={part.assignee}
          reportInputs={part.linkedReport?.inputs}
          creatorName={creatorName}
          columns={columns}
          title={def.name}
          subtitle="Before you activate it. Its queries change only by asking the assistant."
          saveLabel="Keep changes"
          onSave={(next) => {
            setEdits(hasEdits(next) ? next : null)
            setProblems(null)
            setEditing(false)
          }}
          onClose={() => setEditing(false)}
        />
      )}
    </article>
  )
}

/** A draft the server did not accept: one line, opening on why. */
function FailedDraft({ part }: { part: AiAutomationPart }) {
  const [open, setOpen] = useState(false)
  const name = part.draft?.name?.trim()
  return (
    <div className="my-2 overflow-hidden rounded-xl bg-white ring-1 ring-rose-200 dark:bg-slate-900 dark:ring-rose-500/30">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-start gap-2.5 px-3 py-2 text-start transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/60 touch:min-h-[44px]">
        <OctagonX className="mt-0.5 h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400" />
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 text-13 font-semibold text-slate-800 dark:text-slate-100">
            <span className="font-medium text-rose-700 dark:text-rose-300">Automation draft not accepted</span>
            {name && (
              <>
                : <bdi dir="auto">{name}</bdi>
              </>
            )}
          </span>
          <span className="mt-0.5 block text-[11px] text-muted">The assistant was told what to fix; nothing was set up.</span>
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
