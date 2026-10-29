// ============================================================================
// §27 — Receiving: what comes in, from the warehouse's door to quality's
// decision and back. Its parts, each its own address:
//
//   • Delivery notes (/receiving) — the warehouse sends what came on a PO;
//     quality receiving opens the ones awaiting it and decides each line; the
//     warehouse sees them come back, prints and closes them.
//     /receiving/notes/<id> opens one (the bell's alerts link there).
//   • Items (/receiving/items) — every item received with its decision, one
//     list filtered: Accepted, Hold, Rejected… for quality, the warehouse or
//     anyone who follows a supplier.
//   • Coils & MTC (/receiving/coils) — the coils on the suppliers' papers,
//     matched with the MTC register: the ones still without a certificate.
//   • Purchase orders — the POs received against, imported or typed in.
//   • Setup — the lists, for whoever sets receiving up.
// ============================================================================

import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ClipboardList, Loader2, PackageCheck, Plus, Settings2, ShoppingCart, Cylinder } from 'lucide-react'
import {
  DELIVERY_NOTE_STATUSES, DELIVERY_NOTE_STATUS_NAMES, RECEIVING_PERMISSIONS, RECEIVING_STATUS_NAMES,
  type DeliveredCoilListQuery, type DeliveryNote, type DeliveryNoteSummary, type ReceivedItemListQuery, type ReceivingLineStatus,
} from '@qc/shared/receiving'
import { Badge, Button, Card, EmptyState, Field, Input } from '@/components/ui'
import { ExportMenu, FilterBar, FilterSelect, Segmented } from '@/components/ui/PageShell'
import { ScrollX } from '@/components/ui/ScrollX'
import { DeliveryNoteDialog } from '@/components/receiving/DeliveryNoteDialog'
import { DeliveryNoteView } from '@/components/receiving/DeliveryNoteView'
import { PurchaseOrders } from '@/components/receiving/PurchaseOrders'
import { ReceivingSetup } from '@/components/receiving/ReceivingSetup'
import { LineBadge, NoteBadge, Parts, dayText, qtyText } from '@/components/receiving/receivingUi'
import { downloadWorkbook } from '@/lib/xlsxWrite'
import { usePersistedState } from '@/lib/usePersistedState'
import { formatDateTime } from '@/lib/utils'
import { useDebounced } from '@/services/queries'
import { fetchAllDeliveredCoils, fetchAllReceivedItems, useDeliveredCoils, useDeliveryNotes, useReceivedItems, useReceivingOptions } from '@/services/receiving'
import { useAuth } from '@/store/AuthContext'
import { useApp } from '@/store/AppContext'

const PAGE = 50
const P = RECEIVING_PERMISSIONS
type Section = 'notes' | 'items' | 'coils' | 'purchase-orders' | 'setup'
const SECTIONS: readonly Section[] = ['notes', 'items', 'coils', 'purchase-orders', 'setup']

function Pager({ total, offset, hasMore, busy, setOffset, what }: { total: number; offset: number; hasMore: boolean; busy: boolean; setOffset: (f: (x: number) => number) => void; what: string }) {
  return <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted"><span>{total.toLocaleString()} {what}</span>
    <div className="flex gap-2"><Button disabled={!offset || busy} onClick={() => setOffset((x) => Math.max(0, x - PAGE))}>Previous</Button><Button disabled={!hasMore || busy} onClick={() => setOffset((x) => x + PAGE)}>Next</Button></div></div>
}

const Loading = () => <p className="flex items-center justify-center gap-2 py-14 text-sm text-muted"><Loader2 className="h-4 w-4 animate-spin" />Loading…</p>
const Failed = ({ message, retry }: { message: string; retry: () => void }) => <p role="alert" className="py-10 text-center text-sm text-danger-600">{message} <button type="button" className="underline" onClick={retry}>Retry</button></p>

function FactoryFilter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const options = useReceivingOptions()
  const factories = (options.data?.lists ?? []).filter((l) => l.list === 'factory')
  if (!factories.length) return null
  return <FilterSelect label="Factory" value={value} onChange={onChange}><option value="">All factories</option>{factories.map((f) => <option key={f.id}>{f.value}</option>)}</FilterSelect>
}

/** A note's lines by decision, in a few words: "3 items · 1 on hold". */
function linesSummary(n: DeliveryNoteSummary): string {
  const parts = [[n.pendingLines, 'awaiting'], [n.acceptedLines, 'accepted'], [n.partialLines, 'partly'], [n.rejectedLines, 'rejected'], [n.holdLines, 'on hold']] as const
  return [`${n.lines} ${n.lines === 1 ? 'item' : 'items'}`, ...parts.filter(([c]) => c > 0 && c !== n.lines).map(([c, w]) => `${c} ${w}`)].join(' · ')
}

function NotesList({ onOpen }: { onOpen: (id: string) => void }) {
  const { can } = useAuth()
  const [status, setStatus] = usePersistedState<string>('qc-receiving:status', can(P.decide) && !can(P.deliver) ? 'awaiting-qc' : 'open')
  const [search, setSearch] = useState('')
  const [factory, setFactory] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [offset, setOffset] = useState(0)
  const [creating, setCreating] = useState(false)
  const list = useDeliveryNotes({ q: useDebounced(search, 250) || undefined, status: status === 'all' ? undefined : status, factory: factory || undefined, from: from || undefined, to: to || undefined, offset, limit: PAGE })
  const change = (setter: (v: string) => void) => (v: string) => { setter(v); setOffset(0) }
  const chips = [
    ...(factory ? [{ key: 'factory', label: factory, onRemove: () => change(setFactory)('') }] : []),
    ...(from ? [{ key: 'from', label: `From: ${from}`, onRemove: () => change(setFrom)('') }] : []),
    ...(to ? [{ key: 'to', label: `To: ${to}`, onRemove: () => change(setTo)('') }] : []),
  ]
  return <div className="space-y-3">
    <FilterBar search={{ value: search, onChange: change(setSearch), placeholder: 'Note, PO, supplier, item, coil…', label: 'Search the delivery notes' }}
      filters={<>
        <FilterSelect label="State" value={status} onChange={change(setStatus)}>
          <option value="open">Not closed</option>
          {DELIVERY_NOTE_STATUSES.map((s) => <option key={s} value={s}>{DELIVERY_NOTE_STATUS_NAMES[s]}</option>)}
          <option value="all">All</option>
        </FilterSelect>
        <FactoryFilter value={factory} onChange={change(setFactory)} />
      </>}
      more={<><Field label="Arrived from"><Input type="date" value={from} onChange={(e) => change(setFrom)(e.target.value)} /></Field><Field label="Arrived to"><Input type="date" value={to} onChange={(e) => change(setTo)(e.target.value)} /></Field></>}
      moreCount={Number(!!from) + Number(!!to)} chips={chips} onReset={() => { setSearch(''); setFactory(''); setFrom(''); setTo(''); setOffset(0) }} canReset={!!(search || chips.length)}
      actions={can(P.deliver) ? <Button variant="primary" onClick={() => setCreating(true)}><Plus className="h-4 w-4" />New delivery note</Button> : undefined} />
    {list.isPending ? <Loading /> : list.isError ? <Failed message={list.error.message} retry={() => void list.refetch()} />
      : !list.data.notes.length ? <EmptyState icon={<PackageCheck className="h-10 w-10" />} title="No delivery notes" hint={status === 'awaiting-qc' ? 'Nothing is waiting for quality.' : undefined} />
      : <Card className="overflow-hidden"><ScrollX label="Delivery notes"><table className="w-full min-w-[920px] text-left text-sm">
        <thead className="bg-slate-50 text-xs font-semibold text-muted dark:bg-slate-800/60"><tr>{['Note', 'Arrived', 'PO', 'Supplier', 'Factory', 'Items', 'Coils', 'State', 'Sent by', ''].map((h, i) =>
          <th key={i} scope="col" className="whitespace-nowrap px-3 py-2.5">{h || <span className="sr-only">Open</span>}</th>)}</tr></thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">{list.data.notes.map((n) => <tr key={n.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
          <td className="whitespace-nowrap px-3 py-2.5 font-semibold">{n.reference}</td>
          <td className="whitespace-nowrap px-3 py-2.5">{dayText(n.deliveredOn)}</td>
          <td className="whitespace-nowrap px-3 py-2.5 font-mono">{n.poNumber}</td>
          <td dir="auto" className="px-3 py-2.5">{n.supplier || '—'}</td>
          <td dir="auto" className="px-3 py-2.5">{n.factory}</td>
          <td className="px-3 py-2.5">{linesSummary(n)}</td>
          <td className="px-3 py-2.5 tabular-nums">{n.coils || '—'}</td>
          <td className="px-3 py-2.5"><NoteBadge status={n.status} /></td>
          <td className="whitespace-nowrap px-3 py-2.5 text-xs text-muted">{n.createdByName}<br />{formatDateTime(n.createdAt)}</td>
          <td className="px-3 py-2.5"><Button aria-label={`Open ${n.reference}`} onClick={() => onOpen(n.id)}>Open</Button></td>
        </tr>)}</tbody>
      </table></ScrollX></Card>}
    {list.data && <Pager total={list.data.total} offset={offset} hasMore={list.data.hasMore} busy={list.isFetching} setOffset={setOffset} what="delivery notes" />}
    {creating && <DeliveryNoteDialog onClose={() => setCreating(false)} onSaved={(n) => { setCreating(false); onOpen(n.id) }} />}
  </div>
}

const ITEM_TABS: { value: 'all' | ReceivingLineStatus; label: string }[] = [
  { value: 'all', label: 'All' }, { value: 'accepted', label: 'Accepted' }, { value: 'hold', label: 'Hold' }, { value: 'rejected', label: 'Rejected' },
  { value: 'partial', label: 'Partly accepted' }, { value: 'pending', label: 'Awaiting QC' },
]

function ItemsRegister({ onOpen }: { onOpen: (id: string) => void }) {
  const { toast } = useApp()
  const [status, setStatus] = usePersistedState<'all' | ReceivingLineStatus>('qc-receiving:items', 'all')
  const [search, setSearch] = useState('')
  const [factory, setFactory] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [offset, setOffset] = useState(0)
  const [exporting, setExporting] = useState(false)
  const query: ReceivedItemListQuery = { q: useDebounced(search, 250) || undefined, status: status === 'all' ? undefined : status, factory: factory || undefined, from: from || undefined, to: to || undefined }
  const list = useReceivedItems({ ...query, offset, limit: PAGE })
  const change = <T,>(setter: (v: T) => void) => (v: T) => { setter(v); setOffset(0) }
  const chips = [
    ...(factory ? [{ key: 'factory', label: factory, onRemove: () => change(setFactory)('') }] : []),
    ...(from ? [{ key: 'from', label: `From: ${from}`, onRemove: () => change(setFrom)('') }] : []),
    ...(to ? [{ key: 'to', label: `To: ${to}`, onRemove: () => change(setTo)('') }] : []),
  ]
  async function exportItems() {
    setExporting(true)
    try {
      const all = await fetchAllReceivedItems(query)
      downloadWorkbook(`Received items ${new Date().toISOString().slice(0, 10)}`, [{
        name: 'Items',
        header: ['Arrived', 'Note', 'PO', 'Supplier', 'Factory', 'Line', 'Item', 'Description', 'Drawing', 'Dimensions', 'Quantity', 'Unit', 'Decision', 'Accepted', 'Rejected', 'Hold reason', 'Why rejected', 'Notes', 'Decided by', 'Decided at'],
        rows: all.items.map((i) => [i.deliveredOn, i.reference, i.poNumber, i.supplier, i.factory, i.lineNo, i.itemCode, i.description, i.drawing, i.dimensions, i.quantity, i.unit,
          RECEIVING_STATUS_NAMES[i.status], i.acceptedQty, i.rejectedQty, i.holdReason, i.rejectReason, i.decisionNotes, i.decidedByName, i.decidedAt ? formatDateTime(i.decidedAt) : '']),
      }])
      if (all.total > all.items.length) toast(`The first ${all.items.length.toLocaleString()} of ${all.total.toLocaleString()} items were exported: narrow the dates for the rest.`, 'info')
    } catch (error) { toast(error instanceof Error ? error.message : 'Could not export.', 'error') }
    finally { setExporting(false) }
  }
  return <div className="space-y-3">
    <Segmented value={status} onChange={change(setStatus)} label="Decision" options={ITEM_TABS} />
    <FilterBar search={{ value: search, onChange: change(setSearch), placeholder: 'Item, drawing, PO, supplier, reason…', label: 'Search the received items' }}
      filters={<FactoryFilter value={factory} onChange={change(setFactory)} />}
      more={<><Field label="Arrived from"><Input type="date" value={from} onChange={(e) => change(setFrom)(e.target.value)} /></Field><Field label="Arrived to"><Input type="date" value={to} onChange={(e) => change(setTo)(e.target.value)} /></Field></>}
      moreCount={Number(!!from) + Number(!!to)} chips={chips} onReset={() => { setSearch(''); setFactory(''); setFrom(''); setTo(''); setOffset(0) }} canReset={!!(search || chips.length)}
      actions={<ExportMenu busy={exporting} items={[{ label: 'Export to Excel', onClick: () => void exportItems(), disabled: !list.data?.total }]} />} />
    {list.isPending ? <Loading /> : list.isError ? <Failed message={list.error.message} retry={() => void list.refetch()} />
      : !list.data.items.length ? <EmptyState icon={<ClipboardList className="h-10 w-10" />} title={status === 'all' ? 'No items received' : `Nothing ${RECEIVING_STATUS_NAMES[status].toLowerCase()}`} />
      : <Card className="overflow-hidden"><ScrollX label="Received items"><table className="w-full min-w-[1100px] text-left text-sm">
        <thead className="bg-slate-50 text-xs font-semibold text-muted dark:bg-slate-800/60"><tr>{['Arrived', 'Note', 'PO', 'Supplier', 'Factory', 'Item', 'Drawing · dimensions', 'Came', 'Decision', 'Why', 'By', ''].map((h, i) =>
          <th key={i} scope="col" className="whitespace-nowrap px-3 py-2.5">{h || <span className="sr-only">Open</span>}</th>)}</tr></thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">{list.data.items.map((i) => <tr key={i.id} className="align-top hover:bg-slate-50 dark:hover:bg-slate-800/50">
          <td className="whitespace-nowrap px-3 py-2.5">{dayText(i.deliveredOn)}</td>
          <td className="whitespace-nowrap px-3 py-2.5 font-semibold">{i.reference}</td>
          <td className="whitespace-nowrap px-3 py-2.5 font-mono">{i.poNumber}</td>
          <td dir="auto" className="px-3 py-2.5">{i.supplier || '—'}</td>
          <td dir="auto" className="px-3 py-2.5">{i.factory}</td>
          <td dir="auto" className="px-3 py-2.5"><span className="font-semibold">{i.itemCode}</span>{i.description && <span className="block text-xs text-muted">{i.description}</span>}</td>
          <td className="px-3 py-2.5"><Parts parts={[i.drawing, i.dimensions]} /></td>
          <td className="whitespace-nowrap px-3 py-2.5 tabular-nums">{qtyText(i.quantity, i.unit)}{i.status === 'partial' && <span className="block text-xs text-muted">{qtyText(i.acceptedQty)} ok · {qtyText(i.rejectedQty)} rejected</span>}</td>
          <td className="px-3 py-2.5"><LineBadge status={i.status} /></td>
          <td className="max-w-72 px-3 py-2.5"><Parts parts={[i.holdReason, i.rejectReason, i.decisionNotes]} /></td>
          <td className="whitespace-nowrap px-3 py-2.5 text-xs text-muted">{i.decidedByName || '—'}{i.decidedAt && <><br />{formatDateTime(i.decidedAt)}</>}</td>
          <td className="px-3 py-2.5"><Button aria-label={`Open ${i.reference}`} onClick={() => onOpen(i.noteId)}>Open</Button></td>
        </tr>)}</tbody>
      </table></ScrollX></Card>}
    {list.data && <Pager total={list.data.total} offset={offset} hasMore={list.data.hasMore} busy={list.isFetching} setOffset={setOffset} what="items" />}
  </div>
}

function CoilsRegister({ onOpen }: { onOpen: (id: string) => void }) {
  const { toast } = useApp()
  const [mtc, setMtc] = usePersistedState<'missing' | 'matched' | 'all'>('qc-receiving:coils', 'missing')
  const [search, setSearch] = useState('')
  const [offset, setOffset] = useState(0)
  const [exporting, setExporting] = useState(false)
  const query: DeliveredCoilListQuery = { q: useDebounced(search, 250) || undefined, mtc: mtc === 'all' ? undefined : mtc }
  const list = useDeliveredCoils({ ...query, offset, limit: PAGE })
  async function exportCoils() {
    setExporting(true)
    try {
      const all = await fetchAllDeliveredCoils(query)
      downloadWorkbook(`Delivered coils ${mtc === 'missing' ? 'without MTC ' : ''}${new Date().toISOString().slice(0, 10)}`, [{
        name: 'Coils',
        header: ['Coil', 'Weight kg', 'Heat no.', 'MTC', 'Grade', 'Thickness', 'Note', 'PO', 'Supplier', 'Factory', 'Arrived'],
        rows: all.coils.map((c) => [c.coilNumber, c.weight, c.heatNumber, c.hasMtc ? 'Read' : 'To come', c.grade, c.thickness, c.reference, c.poNumber, c.supplier, c.factory, c.deliveredOn]),
      }])
    } catch (error) { toast(error instanceof Error ? error.message : 'Could not export.', 'error') }
    finally { setExporting(false) }
  }
  return <div className="space-y-3">
    <Segmented value={mtc} onChange={(v) => { setMtc(v); setOffset(0) }} label="MTC" options={[
      { value: 'missing', label: `Without MTC${list.data ? ` (${list.data.missing.toLocaleString()})` : ''}` }, { value: 'matched', label: 'MTC read' }, { value: 'all', label: 'All coils' }]} />
    <FilterBar search={{ value: search, onChange: (v) => { setSearch(v); setOffset(0) }, placeholder: 'Coil, heat no., note, PO, supplier…', label: 'Search the delivered coils' }}
      chips={[]} onReset={() => { setSearch(''); setOffset(0) }} canReset={!!search}
      actions={<ExportMenu busy={exporting} items={[{ label: 'Export to Excel', onClick: () => void exportCoils(), disabled: !list.data?.total }]} />} />
    <p className="text-xs text-muted">A coil leaves “Without MTC” by itself once its certificate is read into the MTC register (QA → MTC). Export the list to ask the suppliers for the rest.</p>
    {list.isPending ? <Loading /> : list.isError ? <Failed message={list.error.message} retry={() => void list.refetch()} />
      : !list.data.coils.length ? <EmptyState icon={<Cylinder className="h-10 w-10" />} title={mtc === 'missing' ? 'Every delivered coil has its MTC' : 'No coils'} />
      : <Card className="overflow-hidden"><ScrollX label="Delivered coils"><table className="w-full min-w-[900px] text-left text-sm">
        <thead className="bg-slate-50 text-xs font-semibold text-muted dark:bg-slate-800/60"><tr>{['Coil', 'Weight', 'Heat no.', 'MTC', 'Note', 'PO', 'Supplier', 'Factory', 'Arrived', ''].map((h, i) =>
          <th key={i} scope="col" className="whitespace-nowrap px-3 py-2.5">{h || <span className="sr-only">Open</span>}</th>)}</tr></thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">{list.data.coils.map((c) => <tr key={`${c.noteId}:${c.coilNumber}`} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
          <td className="whitespace-nowrap px-3 py-2.5 font-mono font-semibold">{c.coilNumber}</td>
          <td className="whitespace-nowrap px-3 py-2.5 tabular-nums">{c.weight !== null ? qtyText(c.weight, 'kg') : '—'}</td>
          <td dir="auto" className="px-3 py-2.5">{c.heatNumber || '—'}</td>
          <td className="px-3 py-2.5">{c.hasMtc ? <Badge tone="green">{[c.grade, c.thickness !== null ? `${c.thickness} mm` : ''].filter(Boolean).join(' · ') || 'Read'}</Badge> : <Badge tone="amber">To come</Badge>}</td>
          <td className="whitespace-nowrap px-3 py-2.5 font-semibold">{c.reference}</td>
          <td className="whitespace-nowrap px-3 py-2.5 font-mono">{c.poNumber}</td>
          <td dir="auto" className="px-3 py-2.5">{c.supplier || '—'}</td>
          <td dir="auto" className="px-3 py-2.5">{c.factory}</td>
          <td className="whitespace-nowrap px-3 py-2.5">{dayText(c.deliveredOn)}</td>
          <td className="px-3 py-2.5"><Button aria-label={`Open ${c.reference}`} onClick={() => onOpen(c.noteId)}>Open</Button></td>
        </tr>)}</tbody>
      </table></ScrollX></Card>}
    {list.data && <Pager total={list.data.total} offset={offset} hasMore={list.data.hasMore} busy={list.isFetching} setOffset={setOffset} what="coils" />}
  </div>
}

export function ReceivingPage() {
  const { can } = useAuth()
  const navigate = useNavigate()
  const params = useParams<{ section?: string; id?: string }>()
  const section: Section = SECTIONS.includes(params.section as Section) && (params.section !== 'setup' || can(P.setup)) ? (params.section as Section) : 'notes'
  const openedId = section === 'notes' ? params.id ?? null : null
  const [editing, setEditing] = useState<DeliveryNote | null>(null)
  const [viewing, setViewing] = useState<string | null>(null)
  const noteId = openedId ?? viewing
  const go = (s: Section) => navigate(s === 'notes' ? '/receiving' : `/receiving/${s}`)
  const open = (id: string) => { if (section === 'notes') navigate(`/receiving/notes/${id}`); else setViewing(id) }
  const shut = () => { if (openedId) navigate('/receiving', { replace: true }); setViewing(null) }

  const options = [
    { value: 'notes' as const, label: 'Delivery notes', icon: <PackageCheck className="h-4 w-4" /> },
    { value: 'items' as const, label: 'Items', icon: <ClipboardList className="h-4 w-4" /> },
    { value: 'coils' as const, label: 'Coils & MTC', icon: <Cylinder className="h-4 w-4" /> },
    { value: 'purchase-orders' as const, label: 'Purchase orders', icon: <ShoppingCart className="h-4 w-4" /> },
    ...(can(P.setup) ? [{ value: 'setup' as const, label: 'Setup', icon: <Settings2 className="h-4 w-4" /> }] : []),
  ]
  return <div className="space-y-3">
    <Segmented value={section} onChange={go} label="Receiving" options={options} />
    {section === 'notes' ? <NotesList onOpen={open} />
      : section === 'items' ? <ItemsRegister onOpen={open} />
      : section === 'coils' ? <CoilsRegister onOpen={open} />
      : section === 'purchase-orders' ? <PurchaseOrders />
      : <ReceivingSetup />}
    {noteId && !editing && <DeliveryNoteView key={noteId} id={noteId} onClose={shut} onEdit={setEditing} />}
    {editing && <DeliveryNoteDialog key={`${editing.id}:${editing.version}`} note={editing} onClose={() => setEditing(null)} onSaved={() => setEditing(null)} />}
  </div>
}
