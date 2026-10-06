// ============================================================================
// §16 — the bell. A count of what is still to be read, and the list behind
// it: what needs attention first, then everything earlier as an archive.
// Polls every few minutes while the tab is open; nothing pushes.
// ============================================================================

import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Bell, Check, ChevronDown, ChevronUp, Loader2 } from 'lucide-react'
import type { NoticeForUser } from '@qc/shared/types'
import { Badge, Button, Drawer, EmptyState } from '@/components/ui'
import { useNoticeInbox } from '@/services/queries'
import { acknowledgeNotice, markNoticeSeen } from '@/services/mutations'
import { useApp } from '@/store/AppContext'
import { cn, timeAgo } from '@/lib/utils'
import { NoticeCard, SEVERITY_META, validityText } from './NoticeCard'

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
  return (
    <li className={cn('rounded-2xl ring-1 transition-shadow', notice.pending ? m.ring : 'ring-slate-200/70 dark:ring-slate-800', open && 'shadow-card')}>
      <button type="button" onClick={onToggle} className="flex w-full items-start gap-3 rounded-2xl px-3 py-3 text-left hover:bg-slate-50/70 dark:hover:bg-slate-800/40">
        <span className={cn('mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl', notice.pending ? m.iconBg : 'bg-slate-100 text-muted dark:bg-slate-800')}>
          <m.icon className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className={cn('block truncate text-sm', notice.pending ? 'font-bold' : 'font-semibold text-slate-600 dark:text-slate-300')}>{notice.title}</span>
          <span className="mt-0.5 block text-xs text-muted">
            {timeAgo(notice.createdAt)} · {validityText(notice)}
            {!notice.active ? ' · expired' : ''}
            {notice.acknowledgedAt ? ' · acknowledged' : notice.seenAt ? ' · read' : ''}
          </span>
        </span>
        {notice.pending && <Badge tone={notice.requiresAck ? 'violet' : 'blue'}>{notice.requiresAck ? 'Acknowledge' : 'New'}</Badge>}
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

export function NoticeBell({ className }: { className?: string }) {
  const qc = useQueryClient()
  const { data, isLoading } = useNoticeInbox()
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const pending = data?.pendingCount ?? 0
  const notices = data?.notices ?? []
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
      <button type="button" onClick={() => setOpen(true)} className={cn('icon-btn relative', className)} aria-label={pending > 0 ? `Notices, ${pending} to read` : 'Notices'}>
        <Bell className={cn('h-5 w-5', pending > 0 && 'animate-[wiggle_1.2s_ease-in-out_1]')} />
        {pending > 0 && (
          <span className="absolute -right-0.5 -top-0.5 grid min-w-[18px] place-items-center rounded-full bg-rose-600 px-1 text-[10px] font-bold leading-[18px] text-white ring-2 ring-white dark:ring-slate-900">
            {pending > 99 ? '99+' : pending}
          </span>
        )}
      </button>
      <Drawer open={open} onClose={() => setOpen(false)} title="Notices" subtitle={pending > 0 ? `${pending} to read` : 'Nothing waiting for you'} icon={<Bell className="h-5 w-5" />}>
        {isLoading && (
          <p className="flex items-center gap-2 py-8 text-sm text-muted">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </p>
        )}
        {!isLoading && notices.length === 0 && <EmptyState icon={<Bell className="h-10 w-10" />} title="No notices" hint="Notices from the quality office will show here." />}
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
      </Drawer>
    </>
  )
}
