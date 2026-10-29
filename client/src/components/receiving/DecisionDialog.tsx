// ============================================================================
// §27 — Quality receiving decides one line of a delivery note: Accepted;
// Partly accepted (the quantity accepted, the rest rejected); Rejected (why,
// in detail, with photos); or Hold (why, from the list, and notes) to be
// decided once what was missing comes. A decision is changed the same way
// until the warehouse closes the note.
// ============================================================================

import { useState, type FormEvent } from 'react'
import { Loader2 } from 'lucide-react'
import { RECEIVING_DECISIONS, RECEIVING_STATUS_NAMES, decisionQuantities, type DeliveryNote, type DeliveryNoteLine, type ReceivingDecision } from '@qc/shared/receiving'
import { Button, Modal } from '@/components/ui'
import { Segmented } from '@/components/ui/PageShell'
import { ImagePicker } from '@/components/inspection/ImagePicker'
import { useUploadsInFlight } from '@/components/inspection/imageUploads'
import { parseDecimal } from '@/lib/decimal'
import { useDecideLine, useReceivingOptions } from '@/services/receiving'
import { useApp } from '@/store/AppContext'
import { Parts, qtyText } from './receivingUi'

export function DecisionDialog({ note, line, onClose, onSaved }: { note: DeliveryNote; line: DeliveryNoteLine; onClose: () => void; onSaved: (n: DeliveryNote) => void }) {
  const { toast } = useApp()
  const options = useReceivingOptions()
  const decide = useDecideLine(note.id)
  const [decision, setDecision] = useState<ReceivingDecision>(line.status === 'pending' ? 'accepted' : line.status)
  const [accepted, setAccepted] = useState(line.status === 'partial' && line.acceptedQty !== null ? String(line.acceptedQty) : '')
  const [holdReason, setHoldReason] = useState(line.holdReason)
  const [rejectReason, setRejectReason] = useState(line.rejectReason)
  const [notes, setNotes] = useState(line.decisionNotes)
  const [imageIds, setImageIds] = useState<string[]>(line.imageIds)
  const [uploading, onUploading] = useUploadsInFlight()
  const busy = decide.isPending || uploading > 0
  const reasons = (options.data?.lists ?? []).filter((l) => l.list === 'hold-reason')
  const quantities = decisionQuantities(decision, line.quantity, parseDecimal(accepted))
  const rejects = decision === 'rejected' || decision === 'partial'
  const problem = 'error' in quantities ? quantities.error
    : decision === 'hold' && !holdReason.trim() ? 'Choose why it is on Hold.'
    : rejects && !rejectReason.trim() ? 'Write why it is rejected.'
    : ''

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (problem || busy) return
    try {
      const saved = await decide.mutateAsync({
        lineId: line.id, decision, acceptedQty: decision === 'partial' ? parseDecimal(accepted) : null,
        holdReason: decision === 'hold' ? holdReason.trim() : '', rejectReason: rejects ? rejectReason.trim() : '', notes: notes.trim(), imageIds, version: line.version,
      })
      toast(`${line.itemCode}: ${RECEIVING_STATUS_NAMES[decision]}.`, 'success')
      onSaved(saved)
    } catch (error) { toast(error instanceof Error ? error.message : 'Could not save.', 'error') }
  }

  return <Modal open size="lg" title={`Decide ${line.itemCode}`} onClose={() => { if (!busy) onClose() }} footer={<>
    <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
    <Button type="submit" form="receiving-decision" variant={decision === 'rejected' ? 'danger' : 'primary'} disabled={!!problem || busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />}{uploading ? 'Uploading…' : `Save: ${RECEIVING_STATUS_NAMES[decision]}`}</Button>
  </>}>
    <form id="receiving-decision" onSubmit={(e) => void submit(e)} className="space-y-4">
      <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
        <div><dt className="label">Delivery</dt><dd>{note.reference} · PO {note.poNumber} line {line.lineNo}</dd></div>
        <div><dt className="label">Came</dt><dd className="tabular-nums">{qtyText(line.quantity, line.unit)} <span className="text-muted">of {qtyText(line.orderedQty, line.unit)} ordered</span></dd></div>
        <div><dt className="label">Description</dt><dd dir="auto">{line.description || '—'}</dd></div>
        <div><dt className="label">Drawing · dimensions</dt><dd><Parts parts={[line.drawing, line.dimensions]} /></dd></div>
      </dl>
      <fieldset disabled={decide.isPending} className="space-y-4">
        <Segmented value={decision} onChange={setDecision} label="Decision" options={RECEIVING_DECISIONS.map((d) => ({ value: d, label: RECEIVING_STATUS_NAMES[d] }))} />
        {decision === 'partial' && <label className="block max-w-xs">
          <span className="label">Quantity accepted ({line.unit || 'of what came'})</span>
          <input inputMode="decimal" className="input tabular-nums" autoFocus value={accepted} onChange={(e) => setAccepted(e.target.value)} />
          {'acceptedQty' in quantities && <span className="mt-1 block text-xs text-muted">Rejected: {qtyText(quantities.rejectedQty, line.unit)}</span>}
        </label>}
        {decision === 'hold' && <label className="block max-w-sm">
          <span className="label">Why on Hold</span>
          <select className="input" value={holdReason} onChange={(e) => setHoldReason(e.target.value)}>
            <option value="">Choose…</option>
            {reasons.map((r) => <option key={r.id}>{r.value}</option>)}
            {holdReason && !reasons.some((r) => r.value === holdReason) && <option>{holdReason}</option>}
          </select>
        </label>}
        {rejects && <label className="block">
          <span className="label">Why rejected — the defect, how many, where</span>
          <textarea dir="auto" rows={3} maxLength={4000} className="input" value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
        </label>}
        <label className="block"><span className="label">{decision === 'hold' ? 'What is awaited (notes)' : 'Notes'}</span>
          <textarea dir="auto" rows={2} maxLength={4000} className="input" value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
        <div><span className="label">Photos{rejects ? ' of the defect' : ''}</span>
          <ImagePicker imageIds={imageIds} onChange={(edit) => setImageIds((ids) => edit(ids))} onUploading={onUploading} lockedReason={decide.isPending ? 'Saving…' : undefined} /></div>
        {problem && (decision !== 'partial' || accepted) && <p role="alert" className="text-sm text-danger-600">{problem}</p>}
      </fieldset>
    </form>
  </Modal>
}
