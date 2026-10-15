// ============================================================================
// §16 — the administrator's notices: write one, aim it, attach photos and
// documents, see who has read it, withdraw it. Targets are alternatives
// within a kind and combine across kinds; that rule is written on the form.
// A page of its own at /notices, opened from the bell's Notices tab (for
// those who may manage them), not from Administration. A new notice is
// written by the assistant (§23): "New in the assistant" opens it on a new
// conversation to draft one as a card; this page keeps the notices written —
// who read them, a change, withdrawing or removing one.
// ============================================================================

import { useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { BellPlus, Check, ClipboardList, Eye, FileUp, Loader2, Megaphone, Pencil, Plus, Sparkles, Trash2, Undo2, Users, X } from 'lucide-react'
import { useAi } from '@/components/ai/AiAssistantProvider'
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
  type NoticeMatchMode,
} from '@qc/shared/types'
import { normaliseMachineCode, shiftName } from '@qc/shared/rules'
import { ImagePicker } from '@/components/inspection/ImagePicker'
import { NoticeCard, NoticeFileRow, SeverityBadge, TargetChips, validityText } from '@/components/notices/NoticeCard'
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Select } from '@/components/ui'
import { Segmented } from '@/components/ui/PageShell'
import { ApiError } from '@/lib/api'
import { isCoarsePointer } from '@/lib/media'
import { cn, formatDateTime } from '@/lib/utils'
import { useTableView, ViewNote, ViewTh } from '@/components/ui/ColumnFilter'
import { deleteNotice, saveNotice, uploadNoticeFile, withdrawNotice } from '@/services/mutations'
import { useAdminNotices, useLinesOfMachines, useLinesOfOrders, useMaster, useNoticeAcknowledgements, useOrderSearch, useUserDirectory } from '@/services/queries'
import { useApp } from '@/store/AppContext'
import { When } from '@/components/ui/Tooltip'

const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

interface Draft extends SaveNoticeRequest {
  files: NoticeFile[]
}


const CONTEXT_KINDS: NoticeTargetKind[] = ['factory', 'machine', 'process', 'order-number', 'order-line', 'item-code', 'customer', 'shift']

/** What each way of combining the targets means, written under the switch. */
const MATCH_MODE_HINT: Record<NoticeMatchMode, string> = {
  all: 'Each kind must hold at once; several values of one kind are alternatives. This machine AND this order.',
  any: 'One target of any kind is enough. This machine OR this order OR this person.',
}

// ---- Target builder --------------------------------------------------------

interface Candidate {
  value: string
  label: string
  /** A second line under the label: a machine's factory, a line's item. */
  sub?: string
}

/**
 * A list to tick several of and add at once: machines, people, orders,
 * lines, items. A search box narrows it; "all shown" ticks what is on
 * screen. Already-added values are shown ticked and locked.
 */
function PickList({
  candidates,
  taken,
  onAdd,
  searching,
  emptyText,
  searchPlaceholder,
  term,
  onTerm,
}: {
  candidates: Candidate[]
  taken: Set<string>
  onAdd: (picked: Candidate[]) => void
  searching?: boolean
  emptyText: string
  searchPlaceholder: string
  term: string
  onTerm: (t: string) => void
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const shown = useMemo(() => {
    const q = term.trim().toLowerCase()
    return q ? candidates.filter((c) => `${c.label} ${c.sub ?? ''} ${c.value}`.toLowerCase().includes(q)) : candidates
  }, [candidates, term])
  const free = shown.filter((c) => !taken.has(c.value.toLowerCase()))
  const allShown = free.length > 0 && free.every((c) => picked.has(c.value))
  const toggle = (v: string) =>
    setPicked((p) => {
      const n = new Set(p)
      if (n.has(v)) n.delete(v)
      else n.add(v)
      return n
    })
  const add = () => {
    const chosen = candidates.filter((c) => picked.has(c.value) && !taken.has(c.value.toLowerCase()))
    if (chosen.length === 0) return
    onAdd(chosen)
    setPicked(new Set())
  }
  const count = Array.from(picked).filter((v) => !taken.has(v.toLowerCase())).length
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input value={term} onChange={(e) => onTerm(e.target.value)} placeholder={searchPlaceholder} className="min-h-[44px] flex-1" aria-label={searchPlaceholder} />
        <label className="inline-flex min-h-[44px] items-center gap-2 text-xs font-semibold text-slate-600 dark:text-slate-300">
          <input
            type="checkbox"
            checked={allShown}
            disabled={free.length === 0}
            onChange={(e) => setPicked((p) => { const n = new Set(p); for (const c of free) e.target.checked ? n.add(c.value) : n.delete(c.value); return n })}
            className="h-4 w-4 accent-brand-600"
          />
          All shown ({free.length})
        </label>
        <Button type="button" onClick={add} disabled={count === 0} className="min-h-[44px]">
          <Plus className="h-4 w-4" /> Add {count > 0 ? count : ''}
        </Button>
      </div>
      <ul className="max-h-56 space-y-0.5 overflow-y-auto rounded-xl border border-slate-200 p-1 dark:border-slate-800">
        {searching && shown.length === 0 && <li className="px-3 py-2 text-sm text-muted">Searching…</li>}
        {!searching && shown.length === 0 && <li className="px-3 py-2 text-sm text-muted">{emptyText}</li>}
        {shown.map((c) => {
          const locked = taken.has(c.value.toLowerCase())
          const on = locked || picked.has(c.value)
          return (
            <li key={c.value}>
              <label className={cn('flex min-h-[40px] cursor-pointer items-center gap-3 rounded-lg px-2 text-sm hover:bg-slate-50 dark:hover:bg-slate-800 touch:min-h-[44px]', locked && 'cursor-default opacity-60')}>
                <input type="checkbox" checked={on} disabled={locked} onChange={() => toggle(c.value)} className="h-4 w-4 accent-brand-600" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{c.label}</span>
                  {c.sub && <span className="block truncate text-xs text-muted">{c.sub}</span>}
                </span>
                {locked && <span className="text-[11px] font-semibold uppercase text-muted">added</span>}
              </label>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function TargetBuilder({
  targets,
  matchMode,
  onChange,
  onMatchMode,
}: {
  targets: NoticeTarget[]
  matchMode: NoticeMatchMode
  onChange: (t: NoticeTarget[]) => void
  onMatchMode: (m: NoticeMatchMode) => void
}) {
  const [kind, setKind] = useState<NoticeTargetKind>('machine')
  const [term, setTerm] = useState('')
  const [typed, setTyped] = useState('')
  const { data: machines = [] } = useMaster('machines')
  const { data: users = [] } = useUserDirectory()
  const searching = kind === 'order-number' || kind === 'order-line'
  const { data: orderHits = [], isFetching } = useOrderSearch(term, 60, searching && term.trim().length >= 2)
  const factories = useMemo(() => Array.from(new Set(machines.map((m) => m.factory?.trim() ?? '').filter(Boolean))).sort(), [machines])

  // ---- The cascade: what was targeted first narrows what is offered next.
  //   factory / process → the machines in them
  //   machines (or the factories' / process's machines) → the orders, lines, items and customers on them
  //   order numbers → their lines and items
  const of = (k: NoticeTargetKind) => targets.filter((t) => t.kind === k).map((t) => t.value)
  const targetedFactories = of('factory').map((f) => f.trim().toLowerCase())
  const targetedProcesses = of('process')
  const targetedMachines = of('machine').map(normaliseMachineCode)
  const targetedOrders = of('order-number')
  const targetedItems = of('item-code').map((v) => v.trim().toLowerCase())
  const machinesInScope = useMemo(
    () =>
      machines.filter(
        (m) =>
          (targetedFactories.length === 0 || targetedFactories.includes((m.factory ?? '').trim().toLowerCase())) &&
          (targetedProcesses.length === 0 || targetedProcesses.includes(m.process)),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [machines, targetedFactories.join('|'), targetedProcesses.join('|')],
  )
  /** The machine codes orders are looked up on: the targeted machines, else the factories' or process's machines, else none (no narrowing). */
  const scopeMachines = useMemo(() => {
    if (targetedMachines.length > 0) return machinesInScope.filter((m) => targetedMachines.includes(normaliseMachineCode(m.code))).map((m) => m.code)
    if (targetedFactories.length > 0 || targetedProcesses.length > 0) return machinesInScope.map((m) => m.code)
    return []
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machinesInScope, targetedMachines.join('|'), targetedFactories.length, targetedProcesses.length])
  const inScope = (workCenterCode: string) => scopeMachines.length === 0 || scopeMachines.some((c) => normaliseMachineCode(c) === normaliseMachineCode(workCenterCode))
  const needLines = kind === 'order-number' || kind === 'order-line' || kind === 'item-code' || kind === 'customer'
  const { data: orderLines = [], isFetching: linesFetching } = useLinesOfOrders(targetedOrders, needLines)
  const { data: machineLines = [], isFetching: machineLinesFetching } = useLinesOfMachines(scopeMachines, needLines && targetedOrders.length === 0)
  /** The lines the next pick is drawn from: the targeted orders' (in scope), else the scope machines'. */
  const scopeLines = useMemo(() => (targetedOrders.length > 0 ? orderLines : machineLines).filter((o) => inScope(o.workCenterCode)), [targetedOrders.length, orderLines, machineLines, scopeMachines]) // eslint-disable-line react-hooks/exhaustive-deps
  const narrowedBy = [
    targetedFactories.length ? `${targetedFactories.length} factor${targetedFactories.length === 1 ? 'y' : 'ies'}` : '',
    targetedProcesses.length ? `${targetedProcesses.length} process${targetedProcesses.length === 1 ? '' : 'es'}` : '',
    targetedMachines.length ? `${targetedMachines.length} machine${targetedMachines.length === 1 ? '' : 's'}` : '',
    targetedOrders.length ? `${targetedOrders.length} order${targetedOrders.length === 1 ? '' : 's'}` : '',
  ].filter(Boolean)
  const taken = useMemo(() => new Set(targets.filter((t) => t.kind === kind).map((t) => t.value.toLowerCase())), [targets, kind])

  const addMany = (picked: Candidate[]) => {
    const fresh = picked.filter((c) => !targets.some((t) => t.kind === kind && t.value.toLowerCase() === c.value.toLowerCase()))
    if (fresh.length === 0) return
    onChange([...targets, ...fresh.map((c) => ({ kind, value: c.value, label: c.label }))])
  }
  const addTyped = () => {
    const v = typed.trim()
    if (!v) return
    addMany([{ value: v, label: v }])
    setTyped('')
  }
  const remove = (t: NoticeTarget) => onChange(targets.filter((x) => !(x.kind === t.kind && x.value === t.value)))

  const candidates = useMemo<Candidate[]>(() => {
    switch (kind) {
      case 'factory':
        return factories.map((f) => ({ value: f, label: f }))
      case 'machine':
        return [...machinesInScope].sort((a, b) => a.displayName.localeCompare(b.displayName)).map((m) => ({ value: m.code, label: m.displayName, sub: m.factory ?? undefined }))
      case 'process':
        return PROCESSES.map((p) => ({ value: p, label: PROCESS_LABEL[p] }))
      case 'shift':
        return (['A', 'B', 'C'] as const).map((s) => ({ value: s, label: `${s} · ${shiftName(s)}` }))
      case 'role':
        // Any role: a notice reaches those of it who receive notices (§14), as the role's set and their own say.
        return ROLES.map((r) => ({ value: r, label: r.charAt(0).toUpperCase() + r.slice(1) }))
      case 'user':
        return [...users].filter((u) => u.isActive).sort((a, b) => a.name.localeCompare(b.name)).map((u) => ({ value: u.id, label: u.name, sub: `${u.username} · ${u.role}` }))
      case 'order-number': {
        // The scope's orders when there is one; the search on top, narrowed to the scope.
        const rows = [...(targetedOrders.length === 0 ? scopeLines : []), ...orderHits.filter((o) => inScope(o.workCenterCode))]
        const seen = new Map<string, Candidate>()
        for (const o of rows) if (!seen.has(o.orderNumber)) seen.set(o.orderNumber, { value: o.orderNumber, label: o.orderNumber, sub: `${o.customer || '—'} · ${o.item} · machine ${o.workCenterCode}` })
        return Array.from(seen.values())
      }
      case 'order-line': {
        // The scope's lines first, then whatever the search finds inside the scope; targeted items narrow further.
        const rows = [...scopeLines, ...orderHits.filter((o) => inScope(o.workCenterCode))].filter((o) => targetedItems.length === 0 || targetedItems.includes(o.itemCode.trim().toLowerCase()))
        const seen = new Map<string, Candidate>()
        for (const o of rows) if (!seen.has(o.id)) seen.set(o.id, { value: o.id, label: `${o.orderNumber} · ${o.item} (${o.itemCode})`, sub: `machine ${o.workCenterCode} · line ${o.lineKey}` })
        return Array.from(seen.values())
      }
      case 'item-code': {
        const seen = new Map<string, Candidate>()
        for (const o of scopeLines) if (o.itemCode && !seen.has(o.itemCode.toLowerCase())) seen.set(o.itemCode.toLowerCase(), { value: o.itemCode, label: o.itemCode, sub: `${o.item} · ${o.orderNumber}` })
        return Array.from(seen.values())
      }
      case 'customer': {
        const seen = new Map<string, Candidate & { n: number }>()
        for (const o of scopeLines) {
          const c = o.customer?.trim()
          if (!c) continue
          const k = c.toLowerCase()
          const cur = seen.get(k)
          if (cur) cur.n += 1
          else seen.set(k, { value: c, label: c, sub: '', n: 1 })
        }
        return Array.from(seen.values()).map((c) => ({ value: c.value, label: c.label, sub: `${c.n} line${c.n === 1 ? '' : 's'} in scope` }))
      }
      default:
        return []
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, factories, machinesInScope, users, orderHits, scopeLines, targetedOrders.length, targetedItems.join('|'), scopeMachines.join('|')])

  // A customer list only exists once there is a scope to draw it from; otherwise it is typed.
  const listed = kind !== 'customer' || scopeLines.length > 0 || linesFetching || machineLinesFetching
  const typedToo = kind === 'item-code' || kind === 'customer'

  return (
    <div className="space-y-3 rounded-xl border border-slate-200 p-3 dark:border-slate-800">
      {/* How the targets combine. Only worth deciding once there is more than one. The chosen way is explained in
          words under the switch — a finger gets no tooltip. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="font-semibold text-muted">Reach:</span>
        <Segmented
          label="Reach"
          value={matchMode}
          onChange={onMatchMode}
          options={[
            { value: 'all', label: 'ALL of them (AND)' },
            { value: 'any', label: 'ANY of them (OR)' },
          ]}
        />
        <span className="basis-full text-muted">
          {MATCH_MODE_HINT[matchMode]} No target means everyone, everywhere.
          {narrowedBy.length > 0 && <> The lists below are narrowed by what is already targeted: {narrowedBy.join(', ')}.</>}
        </span>
      </div>

      {/* items-start: the kind's select keeps its own height instead of stretching to the pick list's beside it. */}
      <div className="grid grid-cols-1 items-start gap-2 sm:grid-cols-[11rem_1fr]">
        <Select value={kind} onChange={(e) => { setKind(e.target.value as NoticeTargetKind); setTerm(''); setTyped('') }} aria-label="Target kind" className="min-h-[44px]">
          {NOTICE_TARGET_KINDS.map((k) => (
            <option key={k} value={k}>
              {NOTICE_TARGET_LABEL[k]}
            </option>
          ))}
        </Select>
        <div className="space-y-2">
          {listed && (
            <PickList
              candidates={candidates}
              taken={taken}
              onAdd={addMany}
              searching={(searching && isFetching) || (needLines && (linesFetching || machineLinesFetching))}
              term={term}
              onTerm={setTerm}
              searchPlaceholder={
                kind === 'order-number' ? scopeMachines.length ? 'Filter the orders on the targeted machines, or type another order number…' : 'Type part of the order number…'
                : kind === 'order-line' ? scopeLines.length ? 'Filter the lines, or type another order number…' : 'Type part of the order number…'
                : kind === 'item-code' ? 'Filter the items…'
                : kind === 'customer' ? 'Filter the customers…'
                : `Filter ${NOTICE_TARGET_LABEL[kind].toLowerCase()}s…`
              }
              emptyText={
                (kind === 'order-number' || kind === 'order-line') && scopeLines.length === 0
                  ? scopeMachines.length ? 'No order line on the targeted machines. Type part of an order number to search.' : 'Type at least two characters of an order number; or target a factory or a machine first and its orders are listed.'
                  : kind === 'item-code'
                    ? scopeLines.length ? 'No item in scope.' : 'Target an order number, a machine or a factory first and its items are listed here; or type an item code below.'
                    : kind === 'customer'
                      ? 'No customer in scope; type one below.'
                      : 'Nothing to choose from.'
              }
            />
          )}
          {typedToo && (
            <div className="flex gap-2">
              <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={kind === 'item-code' ? 'Or type an item code, e.g. 125185TA3' : 'Customer name as on the order'} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addTyped())} className="min-h-[44px]" />
              <Button type="button" onClick={addTyped} disabled={!typed.trim()} className="min-h-[44px]">
                <Plus className="h-4 w-4" /> Add
              </Button>
            </div>
          )}
        </div>
      </div>
      {targets.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          {targets.map((t) => (
            <span key={`${t.kind}:${t.value}`} className="inline-flex h-9 items-center gap-1 rounded-full bg-brand-50 pl-3 pr-0.5 text-xs font-semibold text-brand-800 ring-1 ring-brand-200 dark:bg-brand-500/15 dark:text-brand-100 dark:ring-brand-500/30">
              <span className="font-normal opacity-70">{NOTICE_TARGET_LABEL[t.kind]}</span>{' '}
              <span dir="auto" className="max-w-[14rem] truncate">
                {t.label || t.value}
              </span>
              {/* Drawn 32 px round; the invisible box around it takes a tap 6 px further out, a 44 px target that is still
                  the chip's own, so a finger removes this target and not the one beside it. */}
              <button
                type="button"
                onClick={() => remove(t)}
                className="relative grid h-8 w-8 shrink-0 place-items-center rounded-full hover:bg-brand-200/60 before:absolute before:-inset-1.5 before:content-[''] dark:hover:bg-brand-500/30"
                aria-label={`Remove ${t.label || t.value}`}
              >
                <X className="h-4 w-4" />
              </button>
            </span>
          ))}
          {targets.length > 1 && (
            <button type="button" onClick={() => onChange([])} className="inline-flex min-h-[44px] items-center rounded-xl px-3 text-xs font-semibold text-muted hover:bg-slate-100 hover:text-rose-600 dark:hover:bg-slate-800">
              Clear all
            </button>
          )}
        </div>
      ) : (
        <p className="text-xs font-semibold text-muted">Everyone, everywhere.</p>
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
          <Input dir="auto" value={d.title} onChange={(e) => patch({ title: e.target.value })} placeholder="What must the reader know?" maxLength={200} autoFocus={!isCoarsePointer()} />
        </Field>
        <Field label="Message">
          <textarea dir="auto" className="input min-h-[7rem]" value={d.body} onChange={(e) => patch({ body: e.target.value })} placeholder="Say what to do and why." maxLength={4000} />
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
          <TargetBuilder targets={d.targets} matchMode={d.matchMode ?? 'all'} onChange={(targets) => patch({ targets })} onMatchMode={(matchMode) => patch({ matchMode })} />
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
            <p className="text-xs text-muted">Up to 25 MB each. A PDF opens in the app; a workbook is downloaded.</p>
          </div>
        </div>
      </div>
    </Modal>
  )
}

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
        [a.context?.workCenterCode ? `Machine ${a.context.workCenterCode}` : '', a.context?.orderNumber ?? '', a.context?.itemCode ?? ''].filter(Boolean).join(' · ') || 'From the bell',
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

/** What the assistant's question box holds for a new notice: the person finishes the sentence. */
export const NEW_NOTICE_TEXT = 'Write a notice: '

export function NoticesPage() {
  const ai = useAi()
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
      draft: { title: n.title, body: n.body, severity: n.severity, requiresAck: n.requiresAck, matchMode: n.matchMode ?? 'all', validFrom: n.validFrom, validTo: n.validTo, targets: n.targets, imageIds: n.imageIds, fileIds: n.files.map((f) => f.id), files: n.files },
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
            A notice reaches the people it is aimed at through the bell, and comes up before they start a session where it applies. Each reader sees it once; when it must be acknowledged, their name and the time are kept.
          </p>
        </div>
        {ai.notices && (
          <Button variant="primary" className="min-h-[44px]" onClick={() => ai.compose(NEW_NOTICE_TEXT)} data-tip="Opens the assistant in a new conversation: say what to tell whom, and for how long">
            <Sparkles className="h-4 w-4" /> New in the assistant
          </Button>
        )}
      </div>
      <div className="space-y-4">
        {isLoading && <p className="text-sm text-muted">Loading…</p>}
        {!isLoading && notices.length === 0 && (
          <EmptyState icon={<ClipboardList className="h-10 w-10" />} title="No notices yet" hint={ai.notices ? 'Ask the assistant for the first one: for a machine, an order, a customer or a shift.' : "Notices are written with the AI assistant. Ask the assistant's owner to let you write them."} action={ai.notices ? <Button variant="primary" onClick={() => ai.compose(NEW_NOTICE_TEXT)}><Sparkles className="h-4 w-4" /> New in the assistant</Button> : undefined} />
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
            {confirm.kind === 'withdraw' ? 'It stops showing at once. The record and every acknowledgement stay.' : 'It disappears from every bell and list. The record stays for the audit.'}
          </p>
        </Modal>
      )}
    </div>
  )
}
