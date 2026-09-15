// ============================================================================
// §16 — the administrator's notices: write one, aim it, attach photos and
// documents, see who has read it, withdraw it. Targets are alternatives
// within a kind and combine across kinds; that rule is written on the form.
// ============================================================================

import { useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { BellPlus, Check, ClipboardList, Eye, FileUp, Loader2, Pencil, Plus, Trash2, Undo2, Users, X } from 'lucide-react'
import type { SaveNoticeRequest } from '@qc/shared/api'
import {
  NOTICE_TARGET_KINDS,
  NOTICE_TARGET_LABEL,
  PROCESSES,
  PROCESS_LABEL,
  ROLES,
  type NoticeAdminRow,
  type NoticeFile,
  type NoticeSeverity,
  type NoticeTarget,
  type NoticeTargetKind,
} from '@qc/shared/types'
import { can, shiftName } from '@qc/shared/rules'
import { AdminLayout } from '@/components/admin/AdminLayout'
import { ImagePicker } from '@/components/inspection/ImagePicker'
import { NoticeCard, NoticeFileRow, SeverityBadge, TargetChips, validityText } from '@/components/notices/NoticeCard'
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Select } from '@/components/ui'
import { ApiError } from '@/lib/api'
import { cn, formatDateTime } from '@/lib/utils'
import { deleteNotice, saveNotice, uploadNoticeFile, withdrawNotice } from '@/services/mutations'
import { useAdminNotices, useMaster, useNoticeAcknowledgements, useOrderSearch, useUsers } from '@/services/queries'
import { useApp } from '@/store/AppContext'

const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

interface Draft extends SaveNoticeRequest {
  files: NoticeFile[]
}

const EMPTY: Draft = { title: '', body: '', severity: 'warning', requiresAck: true, validFrom: today(), validTo: null, targets: [], imageIds: [], fileIds: [], files: [] }

const CONTEXT_KINDS: NoticeTargetKind[] = ['factory', 'machine', 'process', 'order-number', 'order-line', 'item-code', 'customer', 'shift']

// ---- Target builder --------------------------------------------------------

function TargetBuilder({ targets, onChange }: { targets: NoticeTarget[]; onChange: (t: NoticeTarget[]) => void }) {
  const [kind, setKind] = useState<NoticeTargetKind>('machine')
  const [value, setValue] = useState('')
  const [label, setLabel] = useState('')
  const { data: machines = [] } = useMaster('machines')
  const { data: users = [] } = useUsers()
  const searching = kind === 'order-number' || kind === 'order-line'
  const { data: orderHits = [], isFetching } = useOrderSearch(value, 30, searching && value.trim().length >= 2)
  const factories = useMemo(() => Array.from(new Set(machines.map((m) => m.factory?.trim() ?? '').filter(Boolean))).sort(), [machines])

  const add = (v: string, l: string) => {
    const trimmed = v.trim()
    if (!trimmed) return
    if (targets.some((t) => t.kind === kind && t.value.toLowerCase() === trimmed.toLowerCase())) return
    onChange([...targets, { kind, value: trimmed, label: l.trim() || trimmed }])
    setValue('')
    setLabel('')
  }
  const remove = (t: NoticeTarget) => onChange(targets.filter((x) => !(x.kind === t.kind && x.value === t.value)))

  const orderNumbers = useMemo(() => Array.from(new Set(orderHits.map((o) => o.orderNumber))).slice(0, 12), [orderHits])

  return (
    <div className="space-y-3 rounded-xl border border-slate-200 p-3 dark:border-slate-800">
      <p className="text-xs text-slate-500 dark:text-slate-400">
        No target means everyone, everywhere. Several values of one kind: any of them. Different kinds: all of them at once (this machine <b>and</b> this order).
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[10rem_1fr_auto]">
        <Select value={kind} onChange={(e) => { setKind(e.target.value as NoticeTargetKind); setValue(''); setLabel('') }} aria-label="Target kind">
          {NOTICE_TARGET_KINDS.map((k) => (
            <option key={k} value={k}>
              {NOTICE_TARGET_LABEL[k]}
            </option>
          ))}
        </Select>
        {kind === 'factory' && (
          <Select value={value} onChange={(e) => { setValue(e.target.value); setLabel(e.target.value) }} aria-label="Factory">
            <option value="">Choose a factory…</option>
            {factories.map((f) => (
              <option key={f} value={f}>{f}</option>
            ))}
          </Select>
        )}
        {kind === 'machine' && (
          <Select value={value} onChange={(e) => { const m = machines.find((x) => x.code === e.target.value); setValue(e.target.value); setLabel(m?.displayName ?? e.target.value) }} aria-label="Machine">
            <option value="">Choose a machine…</option>
            {[...machines].sort((a, b) => a.displayName.localeCompare(b.displayName)).map((m) => (
              <option key={m.id} value={m.code}>{m.displayName}</option>
            ))}
          </Select>
        )}
        {kind === 'process' && (
          <Select value={value} onChange={(e) => { setValue(e.target.value); setLabel(PROCESS_LABEL[e.target.value as keyof typeof PROCESS_LABEL] ?? e.target.value) }} aria-label="Process">
            <option value="">Choose a process…</option>
            {PROCESSES.map((p) => (
              <option key={p} value={p}>{PROCESS_LABEL[p]}</option>
            ))}
          </Select>
        )}
        {kind === 'shift' && (
          <Select value={value} onChange={(e) => { setValue(e.target.value); setLabel(`${e.target.value} · ${shiftName(e.target.value as 'A')}`) }} aria-label="Shift">
            <option value="">Choose a shift…</option>
            {(['A', 'B', 'C'] as const).map((s) => (
              <option key={s} value={s}>{s} · {shiftName(s)}</option>
            ))}
          </Select>
        )}
        {kind === 'role' && (
          <Select value={value} onChange={(e) => { setValue(e.target.value); setLabel(e.target.value.charAt(0).toUpperCase() + e.target.value.slice(1)) }} aria-label="Role">
            <option value="">Choose a role…</option>
            {ROLES.filter((r) => can(r, 'read-notices')).map((r) => (
              <option key={r} value={r} className="capitalize">{r}</option>
            ))}
          </Select>
        )}
        {kind === 'user' && (
          <Select value={value} onChange={(e) => { const u = users.find((x) => x.id === e.target.value); setValue(e.target.value); setLabel(u?.name ?? '') }} aria-label="User">
            <option value="">Choose a user…</option>
            {[...users].filter((u) => u.isActive).sort((a, b) => a.name.localeCompare(b.name)).map((u) => (
              <option key={u.id} value={u.id}>{u.name} ({u.username})</option>
            ))}
          </Select>
        )}
        {(kind === 'item-code' || kind === 'customer') && (
          <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder={kind === 'item-code' ? 'Item code, e.g. 125185TA3' : 'Customer name as on the order'} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), add(value, value))} />
        )}
        {kind === 'order-number' && (
          <div>
            <Input list="notice-order-numbers" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Type part of the order number" onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), add(value, value))} />
            <datalist id="notice-order-numbers">{orderNumbers.map((n) => <option key={n} value={n} />)}</datalist>
          </div>
        )}
        {kind === 'order-line' && <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="Type part of the order number, then pick the line" />}
        {kind !== 'order-line' && (
          <Button type="button" onClick={() => add(value, label)} disabled={!value.trim()} className="min-h-[44px]">
            <Plus className="h-4 w-4" /> Add
          </Button>
        )}
      </div>
      {kind === 'order-line' && value.trim().length >= 2 && (
        <ul className="max-h-48 space-y-1 overflow-y-auto rounded-xl border border-slate-200 p-1 dark:border-slate-800">
          {isFetching && orderHits.length === 0 && <li className="px-3 py-2 text-sm text-slate-400">Searching…</li>}
          {!isFetching && orderHits.length === 0 && <li className="px-3 py-2 text-sm text-slate-400">No order line matches.</li>}
          {orderHits.map((o) => {
            const l = `${o.orderNumber} · ${o.item} (${o.itemCode}) · machine ${o.workCenterCode}`
            return (
              <li key={o.id}>
                <button type="button" onClick={() => add(o.id, l)} className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800">
                  {l}
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {targets.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {targets.map((t) => (
            <span key={`${t.kind}:${t.value}`} className="inline-flex items-center gap-1 rounded-full bg-brand-50 py-1 pl-2.5 pr-1 text-xs font-semibold text-brand-800 ring-1 ring-brand-200 dark:bg-brand-500/15 dark:text-brand-100 dark:ring-brand-500/30">
              <span className="font-normal opacity-70">{NOTICE_TARGET_LABEL[t.kind]}</span> {t.label || t.value}
              <button type="button" onClick={() => remove(t)} className="rounded-full p-0.5 hover:bg-brand-200/60 dark:hover:bg-brand-500/30" aria-label={`Remove ${t.label || t.value}`}>
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p className="text-xs font-semibold text-slate-500">Everyone, everywhere.</p>
      )}
    </div>
  )
}

// ---- The form --------------------------------------------------------------

function NoticeForm({ initial, id, onClose }: { initial: Draft; id: string | null; onClose: () => void }) {
  const qc = useQueryClient()
  const { toast } = useApp()
  const [d, setD] = useState<Draft>(initial)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const patch = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }))

  const pickFile = async (file: File | undefined) => {
    if (!file) return
    if (file.size > 25 * 1024 * 1024) {
      toast('A file may be at most 25 MB.', 'error')
      return
    }
    setUploading(true)
    try {
      const stored = await uploadNoticeFile(file)
      patch({ files: [...d.files, stored], fileIds: [...d.fileIds, stored.id] })
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'The file could not be uploaded.', 'error')
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const save = async () => {
    if (!d.title.trim()) {
      setError('Give the notice a title.')
      return
    }
    if (d.validTo && d.validTo < d.validFrom) {
      setError('The end date is before the start date.')
      return
    }
    setError(null)
    setSaving(true)
    try {
      const { files: _files, ...body } = d
      void _files
      await saveNotice(qc, id, { ...body, title: d.title.trim(), body: d.body.trim(), validTo: d.validTo || null })
      toast(id ? 'Notice updated.' : 'Notice published.', 'success')
      onClose()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save the notice.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      icon={<BellPlus className="h-5 w-5" />}
      title={id ? 'Edit notice' : 'New notice'}
      footer={
        <>
          <Button onClick={onClose} disabled={saving} className="min-h-[44px]">Cancel</Button>
          <Button variant="primary" onClick={save} disabled={saving || uploading} className="min-h-[44px]">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} {id ? 'Save changes' : 'Publish'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <p className="rounded-xl bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">{error}</p>}
        <Field label="Title">
          <Input value={d.title} onChange={(e) => patch({ title: e.target.value })} placeholder="What must the reader know?" maxLength={200} autoFocus />
        </Field>
        <Field label="Message">
          <textarea className="input min-h-[7rem]" value={d.body} onChange={(e) => patch({ body: e.target.value })} placeholder="Say what to do and why." maxLength={4000} />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <Field label="Severity">
            <Select value={d.severity} onChange={(e) => patch({ severity: e.target.value as NoticeSeverity })}>
              <option value="info">Information</option>
              <option value="warning">Warning</option>
              <option value="critical">Critical</option>
            </Select>
          </Field>
          <Field label="Shown from">
            <Input type="date" value={d.validFrom} onChange={(e) => patch({ validFrom: e.target.value })} />
          </Field>
          <Field label="Until" hint="Leave empty to show until withdrawn.">
            <Input type="date" value={d.validTo ?? ''} min={d.validFrom} onChange={(e) => patch({ validTo: e.target.value || null })} />
          </Field>
          <Field label="Reading">
            <label className="input flex min-h-[44px] cursor-pointer items-center gap-2">
              <input type="checkbox" checked={d.requiresAck} onChange={(e) => patch({ requiresAck: e.target.checked })} className="h-4 w-4 accent-brand-600" />
              <span className="text-sm">Must acknowledge</span>
            </label>
          </Field>
        </div>
        <div>
          <span className="label">Aimed at</span>
          <TargetBuilder targets={d.targets} onChange={(targets) => patch({ targets })} />
        </div>
        <div>
          <span className="label">Photos</span>
          <ImagePicker imageIds={d.imageIds} onChange={(imageIds) => patch({ imageIds })} />
        </div>
        <div>
          <span className="label">Documents</span>
          <div className="space-y-1.5">
            {d.files.map((f) => (
              <div key={f.id} className="flex items-center gap-2">
                <div className="flex-1"><NoticeFileRow file={f} /></div>
                <button type="button" onClick={() => patch({ files: d.files.filter((x) => x.id !== f.id), fileIds: d.fileIds.filter((x) => x !== f.id) })} className="icon-btn hover:text-rose-600" aria-label={`Remove ${f.originalFilename}`}>
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
            <input ref={fileRef} type="file" accept=".pdf,.xlsx,.xls,application/pdf" className="hidden" onChange={(e) => void pickFile(e.target.files?.[0])} />
            <Button type="button" onClick={() => fileRef.current?.click()} disabled={uploading || d.files.length >= 10} className="min-h-[44px]">
              {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileUp className="h-4 w-4" />} Attach a PDF or Excel file
            </Button>
            <p className="text-xs text-slate-400">Up to 25 MB each. A PDF opens in the app; a workbook is downloaded.</p>
          </div>
        </div>
      </div>
    </Modal>
  )
}

// ---- Acknowledgements ------------------------------------------------------

function AcksModal({ notice, onClose }: { notice: NoticeAdminRow; onClose: () => void }) {
  const { data = [], isLoading } = useNoticeAcknowledgements(notice.id)
  return (
    <Modal open onClose={onClose} size="lg" icon={<Users className="h-5 w-5" />} title="Who has read it">
      <div className="space-y-3">
        <div>
          <p className="font-bold">{notice.title}</p>
          <TargetChips notice={notice} className="mt-1.5" />
        </div>
        {isLoading && <p className="text-sm text-slate-400">Loading…</p>}
        {!isLoading && data.length === 0 && <p className="text-sm text-slate-400">Nobody has opened it yet.</p>}
        {data.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400">
                  <th className="px-2 py-1.5">Reader</th>
                  <th className="px-2 py-1.5">Read</th>
                  <th className="px-2 py-1.5">Acknowledged</th>
                  <th className="px-2 py-1.5">Where</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {data.map((a) => (
                  <tr key={a.userId}>
                    <td className="px-2 py-1.5 font-semibold">{a.userName}</td>
                    <td className="px-2 py-1.5 text-slate-500">{formatDateTime(a.seenAt)}</td>
                    <td className="px-2 py-1.5">{a.acknowledgedAt ? <Badge tone="green" icon={<Check className="h-3 w-3" />}>{formatDateTime(a.acknowledgedAt)}</Badge> : <span className="text-slate-400">—</span>}</td>
                    <td className="px-2 py-1.5 text-xs text-slate-500">
                      {a.context?.workCenterCode ? `Machine ${a.context.workCenterCode}` : ''}
                      {a.context?.orderNumber ? ` · ${a.context.orderNumber}` : ''}
                      {a.context?.itemCode ? ` · ${a.context.itemCode}` : ''}
                      {!a.context?.workCenterCode && !a.context?.orderNumber ? 'From the bell' : ''}
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
  const qc = useQueryClient()
  const { toast } = useApp()
  const { data: notices = [], isLoading } = useAdminNotices()
  const [form, setForm] = useState<{ id: string | null; draft: Draft } | null>(null)
  const [acks, setAcks] = useState<NoticeAdminRow | null>(null)
  const [preview, setPreview] = useState<NoticeAdminRow | null>(null)
  const [confirm, setConfirm] = useState<{ kind: 'withdraw' | 'delete'; notice: NoticeAdminRow } | null>(null)
  const [busy, setBusy] = useState(false)
  const [showArchive, setShowArchive] = useState(false)

  const active = notices.filter((n) => n.active)
  const archive = notices.filter((n) => !n.active)

  const edit = (n: NoticeAdminRow) =>
    setForm({
      id: n.id,
      draft: { title: n.title, body: n.body, severity: n.severity, requiresAck: n.requiresAck, validFrom: n.validFrom, validTo: n.validTo, targets: n.targets, imageIds: n.imageIds, fileIds: n.files.map((f) => f.id), files: n.files },
    })

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
            {n.withdrawnAt ? <Badge tone="neutral">Withdrawn</Badge> : !n.active ? <Badge tone="neutral">{n.validFrom > today() ? 'Scheduled' : 'Expired'}</Badge> : <Badge tone="green">Live</Badge>}
          </div>
          <h3 className="mt-1.5 text-base font-bold leading-snug">{n.title}</h3>
          <p className="mt-0.5 text-xs text-slate-400">
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
    <AdminLayout
      title="Notices"
      needs="manage-admin-data"
      actions={
        <Button variant="primary" className="min-h-[44px]" onClick={() => setForm({ id: null, draft: { ...EMPTY, validFrom: today() } })}>
          <BellPlus className="h-4 w-4" /> New notice
        </Button>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          A notice reaches the people it is aimed at through the bell, and comes up before they start a session where it applies. Each reader sees it once; when it must be acknowledged, their name and the time are kept.
        </p>
        {isLoading && <p className="text-sm text-slate-400">Loading…</p>}
        {!isLoading && notices.length === 0 && (
          <EmptyState icon={<ClipboardList className="h-10 w-10" />} title="No notices yet" hint="Write the first one for a machine, an order, a customer or a shift." action={<Button variant="primary" onClick={() => setForm({ id: null, draft: { ...EMPTY, validFrom: today() } })}><BellPlus className="h-4 w-4" /> New notice</Button>} />
        )}
        {active.length > 0 && (
          <section className="space-y-2">
            <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-400">Live ({active.length})</p>
            {active.map((n) => <Row key={n.id} n={n} />)}
          </section>
        )}
        {archive.length > 0 && (
          <section className="space-y-2">
            <button type="button" onClick={() => setShowArchive((s) => !s)} className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-400 hover:text-brand-700">
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
            {confirm.kind === 'withdraw' ? 'It stops showing at once. The record and every acknowledgement stay.' : 'It disappears from every bell and list. The record stays for the audit.'}
          </p>
        </Modal>
      )}
    </AdminLayout>
  )
}
