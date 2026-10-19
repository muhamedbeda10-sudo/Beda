// ============================================================================
// §16 — the Notices button at the top, apart from the bell: a megaphone with
// how many notices wait to be read (or acknowledged), and the list behind it
// — what needs attention first, then everything earlier. Opening a notice
// that needs no acknowledgement is reading it; one that does is acknowledged
// with its button.
//
// Whoever may manage notices writes one from here as well: New notice opens
// the form (NoticeForm, by hand), With the assistant opens it on a new
// conversation to draft one as a card (§23, for those it may write notices
// for), and Manage notices opens the Notices page (who read them, a change,
// withdrawing or removing one).
// ============================================================================

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowRight, BellPlus, Check, ChevronDown, ChevronUp, Loader2, Megaphone, Sparkles } from 'lucide-react'
import type { NoticeForUser } from '@qc/shared/types'
import { useAi } from '@/components/ai/AiAssistantProvider'
import { Badge, Button, Drawer, EmptyState } from '@/components/ui'
import { useNoticeInbox } from '@/services/queries'
import { acknowledgeNotice, markNoticeSeen } from '@/services/mutations'
import { useApp } from '@/store/AppContext'
import { cn, timeAgo } from '@/lib/utils'
import { textDirection } from '@/lib/direction'
import { NoticeCard, SEVERITY_META, validityText } from './NoticeCard'
import { NEW_NOTICE_TEXT, NoticeForm, newNoticeDraft } from './NoticeForm'
import { badgeText } from './alerts'

function InboxRow({ notice, open, onToggle }: { notice: NoticeForUser; open: boolean; onToggle: () => void }) {
  const qc = useQueryClient()
  const { toast } = useApp()
  const [busy, setBusy] = useState(false)
  const m = SEVERITY_META[notice.severity]
  const ack = async () => {
    setBusy(true)
    try {
      await acknowledgeNotice(qc, notice.id)
      toast('Acknowledged.', 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not acknowledge.', 'error')
    } finally {
      setBusy(false)
    }
  }
  const badge = notice.pending ? <Badge tone={notice.requiresAck ? 'violet' : 'blue'}>{notice.requiresAck ? 'Acknowledge' : 'New'}</Badge> : null
  return (
    <li className={cn('rounded-2xl ring-1 transition-shadow', notice.pending ? m.ring : 'ring-slate-200/70 dark:ring-slate-800', open && 'shadow-card')}>
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-start gap-3 rounded-2xl px-3 py-3 text-left hover:bg-slate-50/70 dark:hover:bg-slate-800/40">
        <span className={cn('mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl', notice.pending ? m.iconBg : 'bg-slate-100 text-muted dark:bg-slate-800')}>
          <m.icon className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          {/* The title in its own direction (an Arabic one starts at the right, its end clipped, not its start), on two
              lines at most while folded, and whole once open: the card under it leaves its own title out. */}
          <span
            dir={textDirection(notice.title) ?? 'auto'}
            className={cn('break-words text-start text-sm', open ? 'block' : 'line-clamp-2', notice.pending ? 'font-bold' : 'font-semibold text-slate-600 dark:text-slate-300')}
          >
            {notice.title}
          </span>
          {/* On a phone the badge waits on this line, under the title, so the title has the row's width. */}
          <span className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted">
            {badge && <span className="sm:hidden">{badge}</span>}
            <span>
              {timeAgo(notice.createdAt)} · <span className="whitespace-nowrap">{validityText(notice)}</span>
              {!notice.active ? ' · expired' : ''}
              {notice.acknowledgedAt ? ' · acknowledged' : notice.seenAt ? ' · read' : ''}
            </span>
          </span>
        </span>
        {badge && <span className="shrink-0 max-sm:hidden">{badge}</span>}
        {open ? <ChevronUp className="mt-1 h-4 w-4 shrink-0 text-muted" /> : <ChevronDown className="mt-1 h-4 w-4 shrink-0 text-muted" />}
      </button>
      {open && (
        <div className="px-3 pb-3 animate-page-in">
          <NoticeCard
            notice={notice}
            hideHeader
            className="ring-0 p-0 bg-transparent dark:bg-transparent"
            actions={
              notice.pending && notice.requiresAck ? (
                <Button variant="primary" onClick={ack} disabled={busy} className="min-h-[44px]">
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} I have read this — acknowledge
                </Button>
              ) : undefined
            }
          />
        </div>
      )}
    </li>
  )
}

/**
 * `receives`: this person is sent notices (by role); `manage`: they may write them. Shown to either; a person who
 * only writes them has the buttons to write one, and no list.
 */
export function NoticesButton({ receives, manage, className }: { receives: boolean; manage: boolean; className?: string }) {
  const ai = useAi()
  const { data } = useNoticeInbox(receives)
  const [open, setOpen] = useState(false)
  const [writing, setWriting] = useState(false)
  if (!receives && !manage) return null

  const pending = receives ? (data?.pendingCount ?? 0) : 0
  // The form and the assistant take the screen: the list closes behind them.
  const writeByHand = () => {
    setOpen(false)
    setWriting(true)
  }
  const writeWithAssistant = () => {
    setOpen(false)
    ai.compose(NEW_NOTICE_TEXT)
  }

  const label = pending > 0 ? `Notices, ${pending} to read` : 'Notices'
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={cn('icon-btn relative', className)} aria-label={label} data-tip="Notices">
        <Megaphone className={cn('h-5 w-5', pending > 0 && 'animate-[wiggle_1.2s_ease-in-out_1]')} />
        {pending > 0 && (
          <span className="absolute -right-0.5 -top-0.5 grid min-w-[18px] place-items-center rounded-full bg-rose-600 px-1 text-[10px] font-bold leading-[18px] text-white ring-2 ring-white dark:ring-slate-900">
            {badgeText(pending)}
          </span>
        )}
      </button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="Notices"
        subtitle={!receives ? 'Write one, or manage them' : pending > 0 ? `${pending} to read` : 'Nothing waiting for you'}
        icon={<Megaphone className="h-5 w-5" />}
      >
        <NoticesPanel receives={receives} manage={manage} onWrite={writeByHand} onAssistant={ai.notices ? writeWithAssistant : undefined} onLeave={() => setOpen(false)} />
      </Drawer>
      {writing && <NoticeForm id={null} initial={newNoticeDraft()} onClose={() => setWriting(false)} />}
    </>
  )
}

/**
 * What the Notices button holds: for whoever writes notices, New notice, With the assistant (`onAssistant`, when it
 * may write them for this person) and the way to the Notices page; then the person's own notices, the ones waiting
 * first. `onLeave` closes it when a link takes them elsewhere.
 */
export function NoticesPanel({ receives, manage, onWrite, onAssistant, onLeave }: { receives: boolean; manage: boolean; onWrite: () => void; onAssistant?: () => void; onLeave: () => void }) {
  const qc = useQueryClient()
  const { data, isLoading } = useNoticeInbox(receives)
  const [expanded, setExpanded] = useState<string | null>(null)
  const notices = receives ? (data?.notices ?? []) : []
  const attention = notices.filter((n) => n.pending)
  const earlier = notices.filter((n) => !n.pending)

  const toggle = (n: NoticeForUser) => {
    const next = expanded === n.id ? null : n.id
    setExpanded(next)
    // Opening a notice that needs no acknowledgement is reading it.
    if (next && n.pending && !n.requiresAck) void markNoticeSeen(qc, n.id).catch(() => undefined)
  }

  return (
    <>
      {manage && (
        <div className="mb-4 space-y-2">
          <div className={cn('grid gap-2', onAssistant && 'grid-cols-2')}>
            <Button variant="primary" onClick={onWrite} className="min-h-[44px]">
              <BellPlus className="h-4 w-4" /> New notice
            </Button>
            {onAssistant && (
              <Button onClick={onAssistant} className="min-h-[44px]" data-tip="Opens the assistant in a new conversation: say what to tell whom, and for how long">
                <Sparkles className="h-4 w-4" /> With the assistant
              </Button>
            )}
          </div>
          <Link to="/notices" onClick={onLeave} className="inline-flex min-h-[40px] items-center gap-1 text-13 font-semibold text-brand-700 hover:underline dark:text-brand-300">
            Manage notices: who read them, change or withdraw one <ArrowRight className="h-3.5 w-3.5 rtl:rotate-180" />
          </Link>
        </div>
      )}
      {receives && (
        <>
          {isLoading && (
            <p className="flex items-center gap-2 py-8 text-sm text-muted">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </p>
          )}
          {!isLoading && notices.length === 0 && <EmptyState icon={<Megaphone className="h-10 w-10" />} title="No notices" hint="Notices from the quality office will show here." />}
          {attention.length > 0 && (
            <section className="space-y-2">
              <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-muted">Needs your attention</p>
              <ul className="space-y-2">
                {attention.map((n) => (
                  <InboxRow key={n.id} notice={n} open={expanded === n.id} onToggle={() => toggle(n)} />
                ))}
              </ul>
            </section>
          )}
          {earlier.length > 0 && (
            <section className={cn('space-y-2', attention.length > 0 && 'mt-5')}>
              <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-muted">Earlier</p>
              <ul className="space-y-2">
                {earlier.map((n) => (
                  <InboxRow key={n.id} notice={n} open={expanded === n.id} onToggle={() => toggle(n)} />
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </>
  )
}
