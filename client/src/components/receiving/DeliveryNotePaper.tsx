// ============================================================================
// §27 — A delivery note on paper, for the warehouse to print once quality has
// decided it: the PO and the delivery, each line with its decision (and why),
// the coils with whether their MTC came, who sent it and who decided, and a
// QR code that opens the note in the app and carries the decisions as text.
// ============================================================================

import { DELIVERY_NOTE_STATUS_NAMES, RECEIVING_STATUS_NAMES, deliveryNoteQrText, receivingNotePath, type DeliveryNote } from '@qc/shared/receiving'
import { paperWhen } from '@/components/print/PrintSheet'
import { QrCode } from './QrCode'
import { Parts, dayText, qtyText } from './receivingUi'

export const noteLink = (id: string) => `${window.location.origin}${receivingNotePath(id)}`

const cell = 'border border-slate-400 px-1.5 py-1 align-top'

export function DeliveryNotePaper({ note }: { note: DeliveryNote }) {
  const deciders = Array.from(new Set(note.lineItems.map((l) => l.decidedByName).filter(Boolean)))
  return <div className="print-sheet bg-white p-2 text-[11px] leading-snug text-slate-900">
    <header className="flex items-start justify-between gap-4 border-b-2 border-slate-900 pb-2">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-600">Quality receiving</p>
        <h1 className="text-lg font-bold">Delivery note {note.reference}</h1>
        <p className="font-semibold">{DELIVERY_NOTE_STATUS_NAMES[note.status]}</p>
      </div>
      <div className="flex flex-col items-center gap-0.5">
        <QrCode text={deliveryNoteQrText(note, noteLink(note.id))} size={112} label={`QR code of ${note.reference}`} />
        <span className="text-[9px] text-slate-600">Scan to open</span>
      </div>
    </header>
    <dl className="mt-2 grid grid-cols-3 gap-x-4 gap-y-1">
      {[['PO', note.poNumber], ['Supplier', note.supplier || '—'], ['Factory', note.factory], ['Arrived on', dayText(note.deliveredOn)], ['Supplier’s note no.', note.supplierDnNo || '—'],
        ['Sent by', `${note.createdByName}, ${paperWhen(note.createdAt)}`]].map(([k, v]) =>
        <div key={k}><dt className="text-[9px] font-semibold uppercase tracking-wide text-slate-600">{k}</dt><dd dir="auto" className="font-medium">{v}</dd></div>)}
    </dl>
    <table className="mt-3 w-full border-collapse text-left">
      <thead className="bg-slate-100"><tr>{['Line', 'Item', 'Description · drawing · dimensions', 'Came', 'Decision', 'Accepted', 'Rejected', 'Why / notes', 'By'].map((h) => <th key={h} className={`${cell} font-semibold`}>{h}</th>)}</tr></thead>
      <tbody>{note.lineItems.map((l) => <tr key={l.id}>
        <td className={cell}>{l.lineNo}</td>
        <td dir="auto" className={`${cell} font-semibold`}>{l.itemCode}</td>
        <td className={cell}><Parts parts={[l.description, l.drawing, l.dimensions]} /></td>
        <td className={`${cell} whitespace-nowrap tabular-nums`}>{qtyText(l.quantity, l.unit)}</td>
        <td className={`${cell} whitespace-nowrap font-bold`}>{RECEIVING_STATUS_NAMES[l.status]}</td>
        <td className={`${cell} tabular-nums`}>{qtyText(l.acceptedQty)}</td>
        <td className={`${cell} tabular-nums`}>{qtyText(l.rejectedQty)}</td>
        <td className={cell}><Parts parts={[l.holdReason, l.rejectReason, l.decisionNotes, l.notes && `Warehouse: ${l.notes}`]} /></td>
        <td className={cell}>{l.decidedByName ? `${l.decidedByName}${l.decidedAt ? `, ${paperWhen(l.decidedAt)}` : ''}` : '—'}</td>
      </tr>)}</tbody>
    </table>
    {note.coilList.length > 0 && <section className="mt-3">
      <h2 className="text-xs font-bold">Coils ({note.coilList.length}; {note.coilList.filter((c) => !c.hasMtc).length} without their MTC yet)</h2>
      <p className="mt-1 columns-3 gap-4">{note.coilList.map((c) => <span key={c.coilNumber} className="block break-inside-avoid font-mono">{c.coilNumber}{c.weight !== null ? ` · ${qtyText(c.weight, 'kg')}` : ''} · {c.hasMtc ? 'MTC ✓' : 'MTC to come'}</span>)}</p>
    </section>}
    {note.notes && <p dir="auto" className="mt-2"><span className="font-semibold">Notes: </span>{note.notes}</p>}
    <footer className="mt-6 grid grid-cols-2 gap-8 text-[10px]">
      <div className="border-t border-slate-500 pt-1">Warehouse — {note.closedByName || note.createdByName}</div>
      <div className="border-t border-slate-500 pt-1">Quality receiving — {deciders.join(', ') || '—'}</div>
    </footer>
  </div>
}
