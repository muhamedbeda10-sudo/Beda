// ============================================================================
// §27 — The warehouse sends what came to quality receiving: the PO's number
// brings its lines (item, drawing, dimensions, what was ordered, what came
// before); tick the ones on the truck and say how many of each; the factory
// that received it; the coils on the supplier's paper, typed or pasted, with
// a photo of the paper. A note is corrected the same way until quality
// decides one of its lines.
// ============================================================================

import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { calendarDay } from '@qc/shared/rules'
import { RECEIVING_MAX_COILS, coilListText, parseCoilList, roundQty, type DeliveryNote, type PurchaseOrder } from '@qc/shared/receiving'
import { Button, Modal } from '@/components/ui'
import { ScrollX } from '@/components/ui/ScrollX'
import { ImagePicker } from '@/components/inspection/ImagePicker'
import { useUploadsInFlight } from '@/components/inspection/imageUploads'
import { useHoldUpdates } from '@/lib/appUpdate'
import { parseDecimal } from '@/lib/decimal'
import { useMediaQuery } from '@/lib/media'
import { useDebounced } from '@/services/queries'
import { usePurchaseOrder, usePurchaseOrderByNumber, useReceivingOptions, useSaveDeliveryNote } from '@/services/receiving'
import { useAuth } from '@/store/AuthContext'
import { useApp } from '@/store/AppContext'
import { cn } from '@/lib/utils'
import { Parts, qtyText } from './receivingUi'

interface Picked { quantity: string; notes: string }

const OverMark = () => <span className="col-span-2 mt-1 flex items-center gap-1 text-xs text-warning-800 dark:text-warning-400"><AlertTriangle className="h-3.5 w-3.5" />More than still to come</span>

export function DeliveryNoteDialog({ note, onClose, onSaved }: { note?: DeliveryNote; onClose: () => void; onSaved: (n: DeliveryNote) => void }) {
  const { factoryTimeZone } = useAuth()
  const { toast } = useApp()
  const phone = !useMediaQuery('(min-width: 768px)')
  const options = useReceivingOptions()
  const save = useSaveDeliveryNote(note?.id)
  const [typed, setTyped] = useState(note?.poNumber ?? '')
  const number = useDebounced(typed, 350)
  const byNumber = usePurchaseOrderByNumber(note ? '' : number)
  const byId = usePurchaseOrder(note?.poId ?? null)
  const po: PurchaseOrder | undefined = note ? byId.data : byNumber.data
  const [picked, setPicked] = useState<Record<string, Picked>>(() =>
    Object.fromEntries((note?.lineItems ?? []).map((l) => [l.poLineId, { quantity: String(l.quantity), notes: l.notes }])))
  const [factory, setFactory] = useState(note?.factory ?? '')
  const [deliveredOn, setDeliveredOn] = useState(note?.deliveredOn ?? calendarDay(new Date(), factoryTimeZone))
  const [supplierDnNo, setSupplierDnNo] = useState(note?.supplierDnNo ?? '')
  const [notes, setNotes] = useState(note?.notes ?? '')
  const [coilsText, setCoilsText] = useState(() => coilListText(note?.coilList ?? []))
  const [imageIds, setImageIds] = useState<string[]>(note?.imageIds ?? [])
  const [submissionId] = useState(() => crypto.randomUUID())
  const [uploading, onUploading] = useUploadsInFlight()
  const [discard, setDiscard] = useState(false)
  const busy = save.isPending || uploading > 0
  const factories = (options.data?.lists ?? []).filter((l) => l.list === 'factory')

  // A new PO typed: what was ticked on another one goes.
  useEffect(() => { if (!note) setPicked({}) }, [po?.id, note])
  // The one factory, when there is one.
  useEffect(() => { if (!factory && factories.length === 1) setFactory(factories[0].value) }, [factories, factory])

  const coils = useMemo(() => parseCoilList(coilsText), [coilsText])
  const before = useMemo(() => new Map((note?.lineItems ?? []).map((l) => [l.poLineId, l.quantity])), [note])
  const lines = Object.entries(picked).map(([poLineId, p]) => ({ poLineId, quantity: parseDecimal(p.quantity), notes: p.notes.trim() }))
  const badQty = lines.filter((l) => l.quantity === null || !(l.quantity > 0))
  const dirty = !!(typed || Object.keys(picked).length || supplierDnNo || notes || coilsText || imageIds.length) && !note || (note && JSON.stringify({ picked, factory, deliveredOn, supplierDnNo, notes, coilsText, imageIds }) !== JSON.stringify({
    picked: Object.fromEntries(note.lineItems.map((l) => [l.poLineId, { quantity: String(l.quantity), notes: l.notes }])), factory: note.factory, deliveredOn: note.deliveredOn,
    supplierDnNo: note.supplierDnNo, notes: note.notes, coilsText: coilListText(note.coilList), imageIds: note.imageIds,
  }))
  useHoldUpdates(!!dirty || busy)
  const tooMany = coils.coils.length > RECEIVING_MAX_COILS
  const valid = !!po && !!factory.trim() && !!deliveredOn && lines.length > 0 && badQty.length === 0 && coils.problems.length === 0 && !tooMany

  function toggle(id: string, remaining: number) {
    setPicked((p) => {
      const next = { ...p }
      if (next[id]) delete next[id]
      else next[id] = { quantity: remaining > 0 ? String(roundQty(remaining)) : '', notes: '' }
      return next
    })
  }
  function close() { if (!busy) { if (dirty) setDiscard(true); else onClose() } }
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!valid || busy || !po) return
    try {
      const saved = await save.mutateAsync({
        poId: po.id, factory: factory.trim(), deliveredOn, supplierDnNo: supplierDnNo.trim(), notes: notes.trim(),
        lines: po.lines.filter((l) => picked[l.id]).map((l) => ({ poLineId: l.id, quantity: parseDecimal(picked[l.id].quantity)!, notes: picked[l.id].notes.trim() })),
        coils: coils.coils, imageIds, ...(note ? { version: note.version } : { submissionId }),
      })
      toast(note ? `${saved.reference} saved.` : `${saved.reference} sent to quality receiving.`, 'success')
      onSaved(saved)
    } catch (error) { toast(error instanceof Error ? error.message : 'Could not save.', 'error') }
  }

  const lookup = note ? byId : byNumber
  const rows = (po?.lines ?? []).map((l) => {
    const earlier = roundQty(l.deliveredQty - (before.get(l.id) ?? 0))
    const remaining = roundQty(l.quantity - earlier)
    const p = picked[l.id]
    const now = p ? parseDecimal(p.quantity) : null
    return { l, earlier, remaining, p, now, over: now !== null && now > remaining }
  })
  const qtyInput = (id: string, item: string, p: Picked, now: number | null) => <input inputMode="decimal" className="input h-9 py-1 tabular-nums" aria-label={`Quantity of ${item} that came`}
    aria-invalid={now === null || !(now > 0) || undefined} value={p.quantity} onChange={(e) => setPicked((x) => ({ ...x, [id]: { ...x[id], quantity: e.target.value } }))} />
  const noteInput = (id: string, item: string, p: Picked) => <input dir="auto" className="input h-9 py-1" aria-label={`Note on ${item}`} maxLength={2000} value={p.notes}
    onChange={(e) => setPicked((x) => ({ ...x, [id]: { ...x[id], notes: e.target.value } }))} />
  return <>
    <Modal open size="xl" title={note ? `Edit ${note.reference}` : 'New delivery note'} onClose={close} footer={<>
      <Button type="button" variant="ghost" disabled={busy} onClick={close}>Cancel</Button>
      <Button type="submit" form="delivery-note" variant="primary" disabled={!valid || busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />}{uploading ? 'Uploading…' : save.isPending ? 'Sending…' : note ? 'Save' : 'Send to quality'}</Button>
    </>}>
      <form id="delivery-note" onSubmit={(e) => void submit(e)} className="space-y-4">
        <fieldset disabled={save.isPending} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="block sm:col-span-2 lg:col-span-1">
              <span className="label">PO number</span>
              <input dir="auto" className="input font-mono" autoFocus={!note} readOnly={!!note} maxLength={60} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Type the PO’s number" />
            </label>
            <label className="block">
              <span className="label">Factory that received it</span>
              <input dir="auto" className="input" list="receiving-factories" maxLength={120} value={factory} onChange={(e) => setFactory(e.target.value)} placeholder={factories.length ? 'Choose…' : 'Factory'} />
              <datalist id="receiving-factories">{factories.map((f) => <option key={f.id} value={f.value} />)}</datalist>
            </label>
            <label className="block"><span className="label">Arrived on</span><input type="date" className="input" value={deliveredOn} onChange={(e) => setDeliveredOn(e.target.value)} /></label>
            <label className="block"><span className="label">Supplier’s delivery note no.</span><input dir="auto" className="input" maxLength={120} value={supplierDnNo} onChange={(e) => setSupplierDnNo(e.target.value)} /></label>
          </div>

          {(note ? !!note.poId : !!number.trim()) && <section aria-labelledby="dn-lines" className="space-y-2">
            {lookup.isFetching && !po ? <p className="flex items-center gap-2 text-sm text-muted"><Loader2 className="h-4 w-4 animate-spin" />Looking for the PO…</p>
              : lookup.isError && !po ? <p role="alert" className="text-sm text-danger-600">{lookup.error.message} Check the number, or ask for the PO to be added under Purchase orders.</p>
              : po && <>
                <h3 id="dn-lines" className="text-sm font-semibold"><Parts parts={[`PO ${po.poNumber}`, po.supplier, po.poDate]} /> — tick what came</h3>
                {phone ? <ul className="space-y-2">{rows.map(({ l, earlier, remaining, p, now, over }) =>
                  <li key={l.id} className={cn('rounded-xl border border-slate-200 p-3 dark:border-slate-700', p && 'border-brand-300 bg-brand-50/60 dark:border-brand-500/40 dark:bg-brand-500/5')}>
                    <label className="flex items-start gap-3">
                      <input type="checkbox" className="mt-0.5 h-6 w-6 shrink-0" aria-label={`${l.itemCode} came`} checked={!!p} onChange={() => toggle(l.id, remaining)} />
                      <span className="min-w-0 text-sm">
                        <span dir="auto" className="block font-semibold">{l.itemCode} <span className="font-normal text-muted">· line {l.lineNo}</span></span>
                        <span className="block"><Parts parts={[l.description, l.drawing, l.dimensions]} /></span>
                        <span className="block text-xs tabular-nums text-muted">Ordered {qtyText(l.quantity, l.unit)} · came before {qtyText(earlier)} · still to come {qtyText(Math.max(remaining, 0))}</span>
                      </span>
                    </label>
                    {p && <div className="mt-2 grid grid-cols-2 gap-2">
                      <label className="block"><span className="label">Came now{l.unit ? ` (${l.unit})` : ''}</span>{qtyInput(l.id, l.itemCode, p, now)}</label>
                      <label className="block"><span className="label">Note</span>{noteInput(l.id, l.itemCode, p)}</label>
                      {over && <OverMark />}
                    </div>}
                  </li>)}</ul>
                  : <ScrollX label="The PO's lines"><table className="w-full min-w-[860px] text-left text-sm">
                  <thead className="text-xs text-muted"><tr>{['', 'Line', 'Item', 'Description', 'Drawing', 'Dimensions', 'Ordered', 'Came before', 'Still to come', 'Came now', 'Note'].map((h, i) =>
                    <th key={i} scope="col" className="whitespace-nowrap border-b px-2 py-2 dark:border-slate-700">{h || <span className="sr-only">Came</span>}</th>)}</tr></thead>
                  <tbody>{rows.map(({ l, earlier, remaining, p, now, over }) =>
                    <tr key={l.id} className={cn('border-b border-slate-100 align-top dark:border-slate-800', p && 'bg-brand-50/60 dark:bg-brand-500/5')}>
                      <td className="px-2 py-2"><input type="checkbox" className="h-5 w-5" aria-label={`${l.itemCode} came`} checked={!!p} onChange={() => toggle(l.id, remaining)} /></td>
                      <td className="px-2 py-2 tabular-nums">{l.lineNo}</td>
                      <td dir="auto" className="whitespace-nowrap px-2 py-2 font-semibold">{l.itemCode}</td>
                      <td dir="auto" className="px-2 py-2">{l.description || '—'}</td>
                      <td dir="auto" className="px-2 py-2">{l.drawing || '—'}</td>
                      <td dir="auto" className="px-2 py-2">{l.dimensions || '—'}</td>
                      <td className="whitespace-nowrap px-2 py-2 tabular-nums">{qtyText(l.quantity, l.unit)}</td>
                      <td className="whitespace-nowrap px-2 py-2 tabular-nums">{qtyText(earlier)}</td>
                      <td className="whitespace-nowrap px-2 py-2 tabular-nums">{qtyText(Math.max(remaining, 0))}</td>
                      <td className="w-32 px-2 py-2">{p && <>{qtyInput(l.id, l.itemCode, p, now)}{over && <OverMark />}</>}</td>
                      <td className="px-2 py-2">{p && noteInput(l.id, l.itemCode, p)}</td>
                    </tr>)}</tbody>
                </table></ScrollX>}
                {badQty.length > 0 && <p role="alert" className="text-sm text-danger-600">Enter the quantity that came of each item ticked.</p>}
              </>}
          </section>}

          <div className="grid gap-4 lg:grid-cols-2">
            <label className="block">
              <span className="label">Coils on the supplier’s paper (one a line: coil number, then weight in kg and heat number if given)</span>
              <textarea dir="auto" rows={5} className="input font-mono text-sm" value={coilsText} onChange={(e) => setCoilsText(e.target.value)} placeholder={'456596-0-0-0\t4200\tH123\n456597-0-0-0'} />
              <span className={cn('mt-1 block text-xs', coils.problems.length || tooMany ? 'text-danger-600' : 'text-muted')} aria-live="polite">
                {coils.problems.length ? coils.problems.slice(0, 3).join(' ') : tooMany ? `At most ${RECEIVING_MAX_COILS} coils on one note.` : coils.coils.length ? `${coils.coils.length} coils. Their MTC is matched as it is read into the MTC register.` : 'Leave empty when no coils came. Paste a column from Excel as it is.'}
              </span>
            </label>
            <div className="space-y-3">
              <div><span className="label">Photo of the supplier’s paper</span>
                <ImagePicker imageIds={imageIds} onChange={(edit) => setImageIds((ids) => edit(ids))} onUploading={onUploading} lockedReason={save.isPending ? 'Saving…' : undefined} /></div>
              <label className="block"><span className="label">Notes</span><textarea dir="auto" rows={2} maxLength={4000} className="input" value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
            </div>
          </div>
        </fieldset>
      </form>
    </Modal>
    {discard && <Modal open size="sm" title="Discard this delivery note?" onClose={() => setDiscard(false)} footer={<><Button onClick={() => setDiscard(false)}>Keep editing</Button><Button variant="danger" onClick={onClose}>Discard</Button></>}>
      <p className="text-sm">What was entered is not sent.</p>
    </Modal>}
  </>
}
