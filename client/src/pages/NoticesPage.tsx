// ============================================================================
// §16 — the notices written: who read them, a change, withdrawing or removing
// one; and a new one, by hand (New notice: NoticeForm) or with the assistant
// (§23, New in the assistant: it drafts the notice as a card). A page of its
// own at /notices for those who may manage notices, opened from the Notices
// button at the top (Manage notices), not from Administration.
// ============================================================================

import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { BellPlus, Check, ClipboardList, Eye, Loader2, Megaphone, Pencil, Sparkles, Trash2, Undo2, Users } from 'lucide-react'
import { useAi } from '@/components/ai/AiAssistantProvider'
import type { NoticeAdminRow } from '@qc/shared/types'
import { NoticeCard, SeverityBadge, TargetChips, validityText } from '@/components/notices/NoticeCard'
import { NEW_NOTICE_TEXT, NoticeForm, newNoticeDraft, noticeDraftOf, noticeToday, type NoticeDraft } from '@/components/notices/NoticeForm'
import { Badge, Button, Card, EmptyState, Modal } from '@/components/ui'
import { ApiError } from '@/lib/api'
import { cn, formatDateTime } from '@/lib/utils'
import { useTableView, ViewTh } from '@/components/ui/ColumnFilter'
import { deleteNotice, withdrawNotice } from '@/services/mutations'
import { useAdminNotices, useNoticeAcknowledgements } from '@/services/queries'
import { useApp } from '@/store/AppContext'
import { When } from '@/components/ui/Tooltip'

// ---- Acknowledgements ------------------------------------------------------

function AcksModal({ notice, onClose }: { notice: NoticeAdminRow; onClose: () => void }) {
  const { data = [], isLoading } = useNoticeAcknowledgements(notice.id)
  const view = useTableView(data, [
    { key: 'reader', value: (a) => a.userName },
    { key: 'read', value: (a) => formatDateTime(a.seenAt), sortValue: (a) => Date.parse(a.seenAt), numeric: true },
    { key: 'ack', value: (a) => (a.acknowledgedAt ? formatDateTime(a.acknowledgedAt) : '—'), sortValue: (a) => (a.acknowledgedAt ? Date.parse(a.acknowledgedAt) : null), numeric: true },
    {
      key: 'where',
      value: (a) =>
        [a.context?.workCenterCode ? `Machine ${a.context.workCenterCode}` : '', a.context?.orderNumber ?? '', a.context?.itemCode ?? ''].filter(Boolean).join(' · ') || 'From the Notices list',
    },
  ])
  return (
    <Modal open onClose={onClose} size="lg" icon={<Users className="h-5 w-5" />} title="Who has read it">
      <div className="space-y-3">
        <div>
          <p className="font-bold">{notice.title}</p>
          <TargetChips notice={notice} className="mt-1.5" />
        </div>
        {isLoading && <p className="text-sm text-muted">Loading…</p>}
        {!isLoading && data.length === 0 && <p className="text-sm text-muted">Nobody has opened it yet.</p>}
        {data.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-muted">
                  <ViewTh view={view} column="reader" label="Reader" className="px-2 py-1.5" />
                  <ViewTh view={view} column="read" label="Read" className="px-2 py-1.5" />
                  <ViewTh view={view} column="ack" label="Acknowledged" className="px-2 py-1.5" />
                  <ViewTh view={view} column="where" label="Where" className="px-2 py-1.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {view.rows.map((a) => (
                  <tr key={a.userId}>
                    <td className="px-2 py-1.5 font-semibold">{a.userName}</td>
                    <td className="px-2 py-1.5 text-muted"><When iso={a.seenAt} time /></td>
                    <td className="px-2 py-1.5">{a.acknowledgedAt ? <Badge tone="green" icon={<Check className="h-3 w-3" />}><When iso={a.acknowledgedAt} time /></Badge> : <span className="text-muted">—</span>}</td>
                    <td className="px-2 py-1.5 text-xs text-muted">
                      {a.context?.workCenterCode ? `Machine ${a.context.workCenterCode}` : ''}
                      {a.context?.orderNumber ? ` · ${a.context.orderNumber}` : ''}
                      {a.context?.itemCode ? ` · ${a.context.itemCode}` : ''}
                      {!a.context?.workCenterCode && !a.context?.orderNumber ? 'From the Notices list' : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Modal>
  )
}

// ---- The page --------------------------------------------------------------

export function NoticesPage() {
  const ai = useAi()
  const qc = useQueryClient()
  const { toast } = useApp()
  const { data: notices = [], isLoading } = useAdminNotices()
  const [form, setForm] = useState<{ id: string | null; draft: NoticeDraft } | null>(null)
  const [acks, setAcks] = useState<NoticeAdminRow | null>(null)
  const [preview, setPreview] = useState<NoticeAdminRow | null>(null)
  const [confirm, setConfirm] = useState<{ kind: 'withdraw' | 'delete'; notice: NoticeAdminRow } | null>(null)
  const [busy, setBusy] = useState(false)
  const [showArchive, setShowArchive] = useState(false)

  const active = notices.filter((n) => n.active)
  const archive = notices.filter((n) => !n.active)

  const edit = (n: NoticeAdminRow) => setForm({ id: n.id, draft: noticeDraftOf(n) })
  const write = () => setForm({ id: null, draft: newNoticeDraft() })

  const act = async () => {
    if (!confirm) return
    setBusy(true)
    try {
      if (confirm.kind === 'withdraw') await withdrawNotice(qc, confirm.notice.id)
      else await deleteNotice(qc, confirm.notice.id)
      toast(confirm.kind === 'withdraw' ? 'Notice withdrawn.' : 'Notice removed.', 'success')
      setConfirm(null)
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'That did not work.', 'error')
    } finally {
      setBusy(false)
    }
  }

  const Row = ({ n }: { n: NoticeAdminRow }) => (
    <Card className={cn('p-4', !n.active && 'opacity-80')}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <SeverityBadge severity={n.severity} />
            {n.requiresAck && <Badge tone="violet">Acknowledge</Badge>}
            {n.withdrawnAt ? <Badge tone="neutral">Withdrawn</Badge> : !n.active ? <Badge tone="neutral">{n.validFrom > noticeToday() ? 'Scheduled' : 'Expired'}</Badge> : <Badge tone="green">Live</Badge>}
          </div>
          <h3 dir="auto" className="mt-1.5 break-words text-start text-base font-bold leading-snug">
            {n.title}
          </h3>
          <p className="mt-0.5 text-xs text-muted">
            {n.createdByName} · {validityText(n)} · {n.imageIds.length} photo{n.imageIds.length === 1 ? '' : 's'} · {n.files.length} file{n.files.length === 1 ? '' : 's'}
          </p>
          <TargetChips notice={n} className="mt-2" />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button type="button" onClick={() => setAcks(n)} className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl px-3 text-sm font-semibold text-brand-700 ring-1 ring-brand-200 hover:bg-brand-50 dark:text-brand-200 dark:ring-brand-500/30 dark:hover:bg-brand-500/10">
            <Users className="h-4 w-4" /> {n.acknowledgedCount} acknowledged · {n.seenCount} read
          </button>
          <button type="button" onClick={() => setPreview(n)} className="icon-btn" aria-label="Preview"><Eye className="h-4 w-4" /></button>
          <button type="button" onClick={() => edit(n)} className="icon-btn" aria-label="Edit"><Pencil className="h-4 w-4" /></button>
          {n.active && (
            <button type="button" onClick={() => setConfirm({ kind: 'withdraw', notice: n })} className="icon-btn" aria-label="Withdraw"><Undo2 className="h-4 w-4" /></button>
          )}
          <button type="button" onClick={() => setConfirm({ kind: 'delete', notice: n })} className="icon-btn hover:text-rose-600" aria-label="Remove"><Trash2 className="h-4 w-4" /></button>
        </div>
      </div>
    </Card>
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300">
          <Megaphone className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-extrabold tracking-tight">Notices</h1>
          <p className="max-w-4xl text-13 text-muted">
            A notice reaches the people it is aimed at through the Notices button at the top, and comes up before they start a session where it applies. Each reader sees it once; when it must be acknowledged, their name and the time are kept. Write one here by hand, or with the assistant.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" className="min-h-[44px]" onClick={write}>
            <BellPlus className="h-4 w-4" /> New notice
          </Button>
          {ai.notices && (
            <Button className="min-h-[44px]" onClick={() => ai.compose(NEW_NOTICE_TEXT)} data-tip="Opens the assistant in a new conversation: say what to tell whom, and for how long">
              <Sparkles className="h-4 w-4" /> New in the assistant
            </Button>
          )}
        </div>
      </div>
      <div className="space-y-4">
        {isLoading && <p className="text-sm text-muted">Loading…</p>}
        {!isLoading && notices.length === 0 && (
          <EmptyState
            icon={<ClipboardList className="h-10 w-10" />}
            title="No notices yet"
            hint={ai.notices ? 'Write the first one by hand, or ask the assistant: for a machine, an order, a customer or a shift.' : 'Write the first one: for a machine, an order, a customer or a shift.'}
            action={<Button variant="primary" onClick={write}><BellPlus className="h-4 w-4" /> New notice</Button>}
          />
        )}
        {active.length > 0 && (
          <section className="space-y-2">
            <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-muted">Live ({active.length})</p>
            {active.map((n) => <Row key={n.id} n={n} />)}
          </section>
        )}
        {archive.length > 0 && (
          <section className="space-y-2">
            <button type="button" onClick={() => setShowArchive((s) => !s)} className="text-[11px] font-bold uppercase tracking-[0.16em] text-muted hover:text-brand-700">
              {showArchive ? 'Hide' : 'Show'} scheduled, expired and withdrawn ({archive.length})
            </button>
            {showArchive && archive.map((n) => <Row key={n.id} n={n} />)}
          </section>
        )}
      </div>

      {form && <NoticeForm key={form.id ?? 'new'} id={form.id} initial={form.draft} onClose={() => setForm(null)} />}
      {acks && <AcksModal notice={acks} onClose={() => setAcks(null)} />}
      {preview && (
        <Modal open onClose={() => setPreview(null)} size="lg" title="As the reader sees it">
          <NoticeCard notice={preview} className="ring-0 p-0 bg-transparent dark:bg-transparent" />
        </Modal>
      )}
      {confirm && (
        <Modal
          open
          onClose={() => setConfirm(null)}
          size="sm"
          title={confirm.kind === 'withdraw' ? 'Withdraw this notice?' : 'Remove this notice?'}
          footer={
            <>
              <Button onClick={() => setConfirm(null)} disabled={busy}>Keep it</Button>
              <Button variant={confirm.kind === 'delete' ? 'danger' : 'primary'} onClick={act} disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : confirm.kind === 'withdraw' ? <Undo2 className="h-4 w-4" /> : <Trash2 className="h-4 w-4" />}
                {confirm.kind === 'withdraw' ? 'Withdraw' : 'Remove'}
              </Button>
            </>
          }
        >
          <p className="text-sm text-slate-600 dark:text-slate-300">
            <b>{confirm.notice.title}</b>
            <br />
            {confirm.kind === 'withdraw' ? 'It stops showing at once. The record and every acknowledgement stay.' : 'It disappears from everyone’s Notices and every list. The record stays for the audit.'}
          </p>
        </Modal>
      )}
    </div>
  )
}
