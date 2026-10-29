// ============================================================================
// §27 — A delivery note read back, where its whole cycle happens: quality
// decides each line (and the coils on the paper); the warehouse sees the
// decisions come back, prints the note with its QR code and closes it. Its
// history says who did what, Holds decided later included.
// ============================================================================

import { useState } from 'react'
import { Loader2, Pencil, Printer, RotateCcw, Trash2 } from 'lucide-react'
import { RECEIVING_PERMISSIONS, RECEIVING_STATUS_NAMES, type DeliveryNote, type DeliveryNoteLine } from '@qc/shared/receiving'
import { Badge, Button, Modal } from '@/components/ui'
import { ImagePicker } from '@/components/inspection/ImagePicker'
import { usePrint } from '@/components/print/usePrint'
import { useCloseNote, useDeleteNote, useDeliveryNote, useReopenNote } from '@/services/receiving'
import { useAuth } from '@/store/AuthContext'
import { useApp } from '@/store/AppContext'
import { formatDateTime } from '@/lib/utils'
import { CoilsDialog } from './CoilsDialog'
import { DecisionDialog } from './DecisionDialog'
import { DeliveryNotePaper } from './DeliveryNotePaper'
import { LineBadge, NoteBadge, Parts, dayText, qtyText } from './receivingUi'

const P = RECEIVING_PERMISSIONS
const noEdit = () => undefined

function Line({ line, onDecide }: { line: DeliveryNoteLine; onDecide?: () => void }) {
  return <li className="space-y-2 rounded-xl border border-slate-200 p-3 dark:border-slate-700">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2"><span dir="auto" className="font-semibold">{line.itemCode}</span><LineBadge status={line.status} /><span className="text-xs text-muted">line {line.lineNo}</span></p>
        <p className="text-sm"><Parts parts={[line.description, line.drawing && `Drawing ${line.drawing}`, line.dimensions]} /></p>
      </div>
      <div className="text-right text-sm tabular-nums">
        <p className="font-semibold">{qtyText(line.quantity, line.unit)}</p>
        <p className="text-xs text-muted">of {qtyText(line.orderedQty, line.unit)} ordered</p>
      </div>
    </div>
    {line.notes && <p dir="auto" className="text-sm text-muted">Warehouse: {line.notes}</p>}
    {line.status !== 'pending' && <div className="space-y-1 rounded-lg bg-slate-50 p-2 text-sm dark:bg-slate-800/60">
      {line.status === 'partial' && <p className="tabular-nums">Accepted {qtyText(line.acceptedQty, line.unit)} · rejected {qtyText(line.rejectedQty, line.unit)}</p>}
      {line.holdReason && <p><span className="font-semibold">On Hold: </span>{line.holdReason}</p>}
      {line.rejectReason && <p dir="auto"><span className="font-semibold">Why rejected: </span>{line.rejectReason}</p>}
      {line.decisionNotes && <p dir="auto">{line.decisionNotes}</p>}
      <p className="text-xs text-muted">{RECEIVING_STATUS_NAMES[line.status]} by {line.decidedByName} · {formatDateTime(line.decidedAt)}</p>
      {line.imageIds.length > 0 && <ImagePicker imageIds={line.imageIds} onChange={noEdit} readOnly />}
    </div>}
    {onDecide && <Button variant={line.status === 'pending' || line.status === 'hold' ? 'primary' : 'secondary'} onClick={onDecide}>{line.status === 'pending' ? 'Decide' : line.status === 'hold' ? 'Decide the Hold' : 'Change the decision'}</Button>}
  </li>
}

export function DeliveryNoteView({ id, onClose, onEdit }: { id: string; onClose: () => void; onEdit: (n: DeliveryNote) => void }) {
  const query = useDeliveryNote(id)
  const { can, profile } = useAuth()
  const { toast } = useApp()
  const printer = usePrint()
  const close = useCloseNote(id)
  const reopen = useReopenNote(id)
  const remove = useDeleteNote()
  const [deciding, setDeciding] = useState<DeliveryNoteLine | null>(null)
  const [coils, setCoils] = useState(false)
  const [confirm, setConfirm] = useState<'close' | 'reopen' | 'delete' | null>(null)
  const [reason, setReason] = useState('')
  const n = query.data
  const open = !!n && n.status !== 'closed'
  const undecided = !!n && n.lineItems.every((l) => l.status === 'pending')
  const mayDecide = open && can(P.decide)
  const mayDelete = !!n && (can(P.setup) || (can(P.deliver) && n.createdById === profile?.id && open && undecided))

  async function act(what: 'close' | 'reopen' | 'delete') {
    if (!n) return
    try {
      if (what === 'close') { await close.mutateAsync(n.version); toast(`${n.reference} closed.`, 'success') }
      if (what === 'reopen') { await reopen.mutateAsync({ version: n.version, reason: reason.trim() }); toast(`${n.reference} reopened.`, 'success') }
      if (what === 'delete') { await remove.mutateAsync(n.id); toast(`${n.reference} deleted.`, 'success'); onClose() }
      setConfirm(null)
    } catch (error) { toast(error instanceof Error ? error.message : 'Could not save.', 'error') }
  }
  const pending = close.isPending || reopen.isPending || remove.isPending

  return <>
    <Modal open size="xl" title={n ? <span className="flex flex-wrap items-center gap-2">{n.reference} <NoteBadge status={n.status} /></span> : 'Delivery note'} onClose={onClose} footer={<>
      {mayDelete && <Button variant="ghost" className="mr-auto text-danger-700 dark:text-danger-400" onClick={() => setConfirm('delete')}><Trash2 className="h-4 w-4" />Delete</Button>}
      {n?.status === 'closed' && can(P.setup) && <Button onClick={() => { setReason(''); setConfirm('reopen') }}><RotateCcw className="h-4 w-4" />Reopen</Button>}
      {n && open && undecided && can(P.deliver) && <Button onClick={() => onEdit(n)}><Pencil className="h-4 w-4" />Edit</Button>}
      {n && <Button onClick={() => printer.print(<DeliveryNotePaper note={n} />, { title: `Delivery note ${n.reference}`, day: n.deliveredOn, bare: true })}><Printer className="h-4 w-4" />Print</Button>}
      {n?.status === 'decided' && can(P.deliver) && <Button variant="primary" onClick={() => setConfirm('close')}>Close the note</Button>}
      <Button variant="ghost" onClick={onClose}>Done</Button>
    </>}>
      {query.isPending ? <p className="flex items-center gap-2 text-sm text-muted"><Loader2 className="h-4 w-4 animate-spin" />Loading…</p>
        : query.isError ? <p role="alert" className="text-sm text-danger-600">{query.error.message} <button type="button" className="underline" onClick={() => void query.refetch()}>Retry</button></p>
        : n && <div className="space-y-5">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
            {[['PO', n.poNumber], ['Supplier', n.supplier || '—'], ['Factory', n.factory], ['Arrived on', dayText(n.deliveredOn)], ['Supplier’s note no.', n.supplierDnNo || '—'],
              ['Sent by', `${n.createdByName} · ${formatDateTime(n.createdAt)}`]].map(([k, v]) => <div key={k}><dt className="label">{k}</dt><dd dir="auto">{v}</dd></div>)}
            {n.notes && <div className="col-span-2 sm:col-span-3"><dt className="label">Notes</dt><dd dir="auto" className="whitespace-pre-wrap">{n.notes}</dd></div>}
            {n.closedAt && <div className="col-span-2 sm:col-span-3"><dt className="label">Closed</dt><dd>{n.closedByName} · {formatDateTime(n.closedAt)}</dd></div>}
          </dl>

          <section aria-labelledby="dn-items" className="space-y-2">
            <h3 id="dn-items" className="text-sm font-semibold">Items ({n.lines})</h3>
            <ul className="space-y-2">{n.lineItems.map((l) => <Line key={l.id} line={l} onDecide={mayDecide ? () => setDeciding(l) : undefined} />)}</ul>
          </section>

          <section aria-labelledby="dn-coils" className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 id="dn-coils" className="text-sm font-semibold">Coils on the supplier’s paper ({n.coils}{n.coils ? `; ${n.coilList.filter((c) => !c.hasMtc).length} without MTC yet` : ''})</h3>
              {open && (can(P.deliver) || can(P.decide)) && <Button onClick={() => setCoils(true)}>{n.coils ? 'Edit the coils' : 'Add coils'}</Button>}
            </div>
            {n.coilList.length > 0 ? <ul className="flex flex-wrap gap-1.5">{n.coilList.map((c) => <li key={c.coilNumber} className="inline-flex items-center gap-1.5 rounded-lg bg-slate-100 py-1 pe-1.5 ps-2.5 text-xs dark:bg-slate-800">
              <span className="font-mono font-semibold">{c.coilNumber}</span>{c.weight !== null && <span className="text-muted">{qtyText(c.weight, 'kg')}</span>}
              <Badge tone={c.hasMtc ? 'green' : 'amber'} tip={c.hasMtc ? [c.grade, c.thickness !== null ? `${c.thickness} mm` : ''].filter(Boolean).join(' · ') : 'Its certificate has not been read into the MTC register yet.'}>{c.hasMtc ? 'MTC' : 'MTC to come'}</Badge>
            </li>)}</ul> : <p className="text-sm text-muted">No coils on this delivery.</p>}
            {n.imageIds.length > 0 && <div><span className="label">The supplier’s paper</span><ImagePicker imageIds={n.imageIds} onChange={noEdit} readOnly /></div>}
          </section>

          <section aria-labelledby="dn-history" className="space-y-2">
            <h3 id="dn-history" className="text-sm font-semibold">History</h3>
            <ol className="space-y-1.5 border-s-2 border-slate-200 ps-3 text-sm dark:border-slate-700">{n.events.map((e) => <li key={e.id}>
              <p><span className="font-semibold">{{ created: 'Sent to quality', edited: 'Corrected', decided: e.itemCode, coils: 'Coils', closed: 'Closed', reopened: 'Reopened' }[e.kind]}</span>
                {e.status && <> <LineBadge status={e.status} /></>}</p>
              {e.text && <p dir="auto" className="text-muted">{e.text}</p>}
              <p className="text-xs text-muted">{e.byName} · {formatDateTime(e.at)}</p>
            </li>)}</ol>
          </section>
        </div>}
    </Modal>
    {deciding && n && <DecisionDialog key={`${deciding.id}:${deciding.version}`} note={n} line={deciding} onClose={() => setDeciding(null)} onSaved={() => setDeciding(null)} />}
    {coils && n && <CoilsDialog note={n} onClose={() => setCoils(false)} onSaved={() => setCoils(false)} />}
    {confirm && n && <Modal open size="sm" onClose={() => { if (!pending) setConfirm(null) }}
      title={confirm === 'close' ? `Close ${n.reference}?` : confirm === 'reopen' ? `Reopen ${n.reference}?` : `Delete ${n.reference}?`}
      footer={<><Button onClick={() => setConfirm(null)} disabled={pending}>Cancel</Button>
        <Button variant={confirm === 'delete' ? 'danger' : 'primary'} disabled={pending || (confirm === 'reopen' && !reason.trim())} onClick={() => void act(confirm)}>{pending && <Loader2 className="h-4 w-4 animate-spin" />}{confirm === 'close' ? 'Yes, close it' : confirm === 'reopen' ? 'Reopen' : 'Delete'}</Button></>}>
      {confirm === 'close' && <p className="text-sm">Quality’s decisions are final once it is closed; the store’s own system takes it from here. Print it first if the paper is needed.</p>}
      {confirm === 'reopen' && <label className="block"><span className="label">Why it is reopened</span><textarea dir="auto" rows={2} maxLength={1000} className="input" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} /></label>}
      {confirm === 'delete' && <p className="text-sm">It leaves the lists and the PO’s quantities. The audit log keeps that it was deleted, and by whom.</p>}
    </Modal>}
    {printer.node}
  </>
}
