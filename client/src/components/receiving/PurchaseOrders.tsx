// ============================================================================
// §27 — The purchase orders deliveries are received against. Until the
// purchasing system's API fills them, they are imported from its Excel sheet
// (one row a PO line: PO number, item, quantity, and what else it has) or
// typed in. A line that has been delivered stays: it can be corrected, not
// removed.
// ============================================================================

import { useRef, useState } from 'react'
import { FileUp, Loader2, Plus, Trash2 } from 'lucide-react'
import {
  PURCHASE_ORDER_IMPORT_CHUNK, PURCHASE_ORDER_IMPORT_FIELDS, RECEIVING_PERMISSIONS, parsePurchaseOrderSheet,
  type PurchaseOrder, type PurchaseOrderImportRow, type PurchaseOrderLineInput,
} from '@qc/shared/receiving'
import { Badge, Button, Card, EmptyState, Modal } from '@/components/ui'
import { FilterBar } from '@/components/ui/PageShell'
import { ScrollX } from '@/components/ui/ScrollX'
import { parseDecimal } from '@/lib/decimal'
import { readWorkbook, WorkbookReadError } from '@/lib/xlsx'
import { chunk, formatDateTime } from '@/lib/utils'
import { useDebounced } from '@/services/queries'
import { importPurchaseOrders, useDeletePurchaseOrder, useInvalidateReceiving, usePurchaseOrder, usePurchaseOrders, useReceivingOptions, useSavePurchaseOrder } from '@/services/receiving'
import { useAuth } from '@/store/AuthContext'
import { useApp } from '@/store/AppContext'
import { qtyText } from './receivingUi'

const PAGE = 50
const P = RECEIVING_PERMISSIONS

interface LineDraft { id?: string; lineNo: string; itemCode: string; description: string; drawing: string; dimensions: string; quantity: string; unit: string; notes: string; delivered: number }
const blankLine = (): LineDraft => ({ lineNo: '', itemCode: '', description: '', drawing: '', dimensions: '', quantity: '', unit: '', notes: '', delivered: 0 })

function PoDialog({ po, onClose }: { po?: PurchaseOrder; onClose: () => void }) {
  const { toast } = useApp()
  const options = useReceivingOptions()
  const save = useSavePurchaseOrder(po?.id)
  const units = (options.data?.lists ?? []).filter((l) => l.list === 'unit')
  const [head, setHead] = useState({ poNumber: po?.poNumber ?? '', supplier: po?.supplier ?? '', poDate: po?.poDate ?? '', notes: po?.notes ?? '' })
  const [lines, setLines] = useState<LineDraft[]>(() => po?.lines.map((l) => ({ id: l.id, lineNo: String(l.lineNo), itemCode: l.itemCode, description: l.description, drawing: l.drawing,
    dimensions: l.dimensions, quantity: String(l.quantity), unit: l.unit, notes: l.notes, delivered: l.deliveredQty })) ?? [blankLine()])
  const set = (i: number, patch: Partial<LineDraft>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  const filled = lines.filter((l) => l.itemCode.trim() || l.quantity.trim())
  const bad = filled.filter((l) => !l.itemCode.trim() || !(parseDecimal(l.quantity)! > 0) || (l.lineNo.trim() && !/^\d{1,6}$/.test(l.lineNo.trim())))
  const valid = !!head.poNumber.trim() && filled.length > 0 && bad.length === 0

  async function submit() {
    const body = {
      ...head, poNumber: head.poNumber.trim(), supplier: head.supplier.trim(), notes: head.notes.trim(),
      lines: filled.map((l): PurchaseOrderLineInput & { id?: string } => ({ id: l.id, lineNo: l.lineNo.trim() ? Number(l.lineNo) : null, itemCode: l.itemCode.trim(), description: l.description.trim(),
        drawing: l.drawing.trim(), dimensions: l.dimensions.trim(), quantity: parseDecimal(l.quantity)!, unit: l.unit.trim(), notes: l.notes.trim() })),
      ...(po ? { version: po.version } : {}),
    }
    try { const saved = await save.mutateAsync(body); toast(`PO ${saved.poNumber} saved.`, 'success'); onClose() }
    catch (error) { toast(error instanceof Error ? error.message : 'Could not save.', 'error') }
  }
  const cellInput = 'input h-9 py-1 text-sm'
  return <Modal open size="xl" title={po ? `PO ${po.poNumber}` : 'New purchase order'} onClose={() => { if (!save.isPending) onClose() }} footer={<>
    <Button variant="ghost" disabled={save.isPending} onClick={onClose}>Cancel</Button>
    <Button variant="primary" disabled={!valid || save.isPending} onClick={() => void submit()}>{save.isPending && <Loader2 className="h-4 w-4 animate-spin" />}Save</Button>
  </>}>
    <fieldset disabled={save.isPending} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="block"><span className="label">PO number</span><input dir="auto" className="input font-mono" autoFocus={!po} maxLength={60} value={head.poNumber} onChange={(e) => setHead({ ...head, poNumber: e.target.value })} /></label>
        <label className="block"><span className="label">Supplier</span><input dir="auto" className="input" maxLength={200} value={head.supplier} onChange={(e) => setHead({ ...head, supplier: e.target.value })} /></label>
        <label className="block"><span className="label">PO date</span><input type="date" className="input" value={head.poDate} onChange={(e) => setHead({ ...head, poDate: e.target.value })} /></label>
        <label className="block"><span className="label">Notes</span><input dir="auto" className="input" maxLength={4000} value={head.notes} onChange={(e) => setHead({ ...head, notes: e.target.value })} /></label>
      </div>
      <ScrollX label="The PO's lines"><table className="w-full min-w-[980px] text-left text-sm">
        <thead className="text-xs text-muted"><tr>{['Line', 'Item code', 'Description', 'Drawing', 'Dimensions', 'Quantity', 'Unit', 'Notes', 'Delivered', ''].map((h, i) =>
          <th key={i} scope="col" className="whitespace-nowrap border-b px-1.5 py-2 dark:border-slate-700">{h || <span className="sr-only">Remove</span>}</th>)}</tr></thead>
        <tbody>{lines.map((l, i) => <tr key={l.id ?? `new-${i}`} className="border-b border-slate-100 dark:border-slate-800">
          <td className="w-20 px-1.5 py-1.5"><input inputMode="numeric" className={`${cellInput} tabular-nums`} aria-label={`Line ${i + 1}: number`} placeholder="auto" value={l.lineNo} onChange={(e) => set(i, { lineNo: e.target.value })} /></td>
          <td className="px-1.5 py-1.5"><input dir="auto" className={`${cellInput} font-semibold`} aria-label={`Line ${i + 1}: item code`} maxLength={120} value={l.itemCode} onChange={(e) => set(i, { itemCode: e.target.value })} /></td>
          <td className="px-1.5 py-1.5"><input dir="auto" className={cellInput} aria-label={`Line ${i + 1}: description`} maxLength={500} value={l.description} onChange={(e) => set(i, { description: e.target.value })} /></td>
          <td className="px-1.5 py-1.5"><input dir="auto" className={cellInput} aria-label={`Line ${i + 1}: drawing`} maxLength={200} value={l.drawing} onChange={(e) => set(i, { drawing: e.target.value })} /></td>
          <td className="px-1.5 py-1.5"><input dir="auto" className={cellInput} aria-label={`Line ${i + 1}: dimensions`} maxLength={500} value={l.dimensions} onChange={(e) => set(i, { dimensions: e.target.value })} /></td>
          <td className="w-28 px-1.5 py-1.5"><input inputMode="decimal" className={`${cellInput} tabular-nums`} aria-label={`Line ${i + 1}: quantity`} aria-invalid={(!!l.quantity && !(parseDecimal(l.quantity)! > 0)) || undefined} value={l.quantity} onChange={(e) => set(i, { quantity: e.target.value })} /></td>
          <td className="w-24 px-1.5 py-1.5"><input dir="auto" className={cellInput} list="receiving-units" aria-label={`Line ${i + 1}: unit`} maxLength={30} value={l.unit} onChange={(e) => set(i, { unit: e.target.value })} /></td>
          <td className="px-1.5 py-1.5"><input dir="auto" className={cellInput} aria-label={`Line ${i + 1}: notes`} maxLength={2000} value={l.notes} onChange={(e) => set(i, { notes: e.target.value })} /></td>
          <td className="whitespace-nowrap px-1.5 py-1.5 tabular-nums text-muted">{qtyText(l.delivered)}</td>
          <td className="px-1.5 py-1.5">{l.delivered > 0 ? <span className="sr-only">Delivered: cannot be removed</span>
            : <button type="button" className="btn-ghost h-9 min-h-0 px-2 text-danger-700 touch:h-11 dark:text-danger-400" aria-label={`Remove line ${i + 1}`} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></button>}</td>
        </tr>)}</tbody>
      </table></ScrollX>
      <datalist id="receiving-units">{units.map((u) => <option key={u.id} value={u.value} />)}</datalist>
      <Button onClick={() => setLines((ls) => [...ls, blankLine()])}><Plus className="h-4 w-4" />Add a line</Button>
      {bad.length > 0 && <p role="alert" className="text-sm text-danger-600">Each line needs an item code and a quantity above 0; a line number is a whole number.</p>}
    </fieldset>
  </Modal>
}

function ImportSheet() {
  const { toast } = useApp()
  const invalidate = useInvalidateReceiving()
  const input = useRef<HTMLInputElement>(null)
  const [read, setRead] = useState<{ name: string; rows: PurchaseOrderImportRow[]; skipped: string[]; missing: string[] } | null>(null)
  const [running, setRunning] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  async function pick(file: File | undefined) {
    if (!file) return
    try {
      const book = readWorkbook(new Uint8Array(await file.arrayBuffer()))
      const parsed = parsePurchaseOrderSheet(book.sheets[0]?.rows ?? [])
      setRead({ name: file.name, rows: parsed.rows, skipped: parsed.skipped, missing: parsed.missingColumns })
      setDone(null)
    } catch (error) { toast(error instanceof WorkbookReadError || error instanceof Error ? error.message : 'The workbook could not be read.', 'error') }
    finally { if (input.current) input.current.value = '' }
  }
  async function run() {
    if (!read) return
    setRunning(true)
    const total = { ordersCreated: 0, linesCreated: 0, linesUpdated: 0, linesUnchanged: 0 }
    try {
      // A PO's lines in one request, so a PO is never split between two.
      const byPo = new Map<string, PurchaseOrderImportRow[]>()
      for (const r of read.rows) byPo.set(r.poNumber.toLowerCase(), [...(byPo.get(r.poNumber.toLowerCase()) ?? []), r])
      const batches: PurchaseOrderImportRow[][] = []
      let batch: PurchaseOrderImportRow[] = []
      for (const rows of byPo.values()) {
        if (batch.length && batch.length + rows.length > PURCHASE_ORDER_IMPORT_CHUNK) { batches.push(batch); batch = [] }
        if (rows.length > PURCHASE_ORDER_IMPORT_CHUNK) batches.push(...chunk(rows, PURCHASE_ORDER_IMPORT_CHUNK))
        else batch.push(...rows)
      }
      if (batch.length) batches.push(batch)
      for (const part of batches) {
        const r = await importPurchaseOrders(part)
        total.ordersCreated += r.ordersCreated; total.linesCreated += r.linesCreated; total.linesUpdated += r.linesUpdated; total.linesUnchanged += r.linesUnchanged
      }
      const text = `${total.ordersCreated} new POs; ${total.linesCreated} lines added, ${total.linesUpdated} changed, ${total.linesUnchanged} as they were.`
      setDone(text)
      toast(text, 'success')
    } catch (error) { toast(error instanceof Error ? error.message : 'The import stopped.', 'error') }
    finally { setRunning(false); void invalidate() }
  }
  return <Card className="space-y-3 p-4">
    <h2 className="text-base font-semibold">Import from Excel</h2>
    <p className="text-sm text-muted">Purchasing’s sheet (.xlsx), one row a PO line. Its columns are found by their names: {PURCHASE_ORDER_IMPORT_FIELDS.map((f) => f.label).join(', ')} (PO number, item code and quantity are needed). A PO already here keeps its other lines; a line is matched by its number, else by its item. Import the sheet again whenever it changes.</p>
    <input ref={input} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="sr-only" aria-label="Choose the purchase orders workbook" onChange={(e) => void pick(e.target.files?.[0])} />
    <div className="flex flex-wrap items-center gap-2">
      <Button disabled={running} onClick={() => input.current?.click()}><FileUp className="h-4 w-4" />Choose the workbook</Button>
      {read && read.rows.length > 0 && <Button variant="primary" disabled={running} onClick={() => void run()}>{running && <Loader2 className="h-4 w-4 animate-spin" />}Import {read.rows.length.toLocaleString()} lines</Button>}
    </div>
    {read && <div className="space-y-1 text-sm" aria-live="polite">
      {read.missing.length ? <p role="alert" className="text-danger-600">{read.name}: no column for {read.missing.join(', ')} was found in its first rows.</p>
        : <p>{read.name}: {read.rows.length.toLocaleString()} lines of {new Set(read.rows.map((r) => r.poNumber.toLowerCase())).size.toLocaleString()} POs.{read.skipped.length ? ` ${read.skipped.length} rows left out: ${read.skipped.slice(0, 3).join(' ')}` : ''}</p>}
      {done && <p className="text-success-700 dark:text-success-400">{done}</p>}
    </div>}
  </Card>
}

export function PurchaseOrders() {
  const { can } = useAuth()
  const { toast } = useApp()
  const [search, setSearch] = useState('')
  const [offset, setOffset] = useState(0)
  const [opened, setOpened] = useState<string | 'new' | null>(null)
  const list = usePurchaseOrders({ q: useDebounced(search, 250) || undefined, offset, limit: PAGE })
  const openedPo = usePurchaseOrder(opened && opened !== 'new' ? opened : null)
  const remove = useDeletePurchaseOrder()
  const manage = can(P.purchaseOrders)
  async function del(id: string, number: string) {
    if (!window.confirm(`Delete PO ${number}? Only a PO without delivery notes can be deleted.`)) return
    try { await remove.mutateAsync(id); toast(`PO ${number} deleted.`, 'success') } catch (error) { toast(error instanceof Error ? error.message : 'Could not delete.', 'error') }
  }
  return <div className="space-y-3">
    <FilterBar search={{ value: search, onChange: (v) => { setSearch(v); setOffset(0) }, placeholder: 'PO number, supplier, item, drawing…', label: 'Search the purchase orders' }}
      chips={[]} onReset={() => { setSearch(''); setOffset(0) }} canReset={!!search}
      actions={manage ? <Button variant="primary" onClick={() => setOpened('new')}><Plus className="h-4 w-4" />New PO</Button> : undefined} />
    {list.isPending ? <p className="flex items-center justify-center gap-2 py-14 text-sm text-muted"><Loader2 className="h-4 w-4 animate-spin" />Loading…</p>
      : list.isError ? <p role="alert" className="py-10 text-center text-sm text-danger-600">{list.error.message} <button type="button" className="underline" onClick={() => void list.refetch()}>Retry</button></p>
      : !list.data.orders.length ? <EmptyState icon={<FileUp className="h-10 w-10" />} title="No purchase orders" hint={manage ? 'Import purchasing’s sheet below, or add a PO by hand.' : undefined} />
      : <Card className="overflow-hidden"><ScrollX label="Purchase orders"><table className="w-full min-w-[760px] text-left text-sm">
        <thead className="bg-slate-50 text-xs font-semibold text-muted dark:bg-slate-800/60"><tr>{['PO', 'Supplier', 'Date', 'Lines', 'Ordered', 'Delivered', 'From', 'Changed', ''].map((h, i) =>
          <th key={i} scope="col" className="whitespace-nowrap px-3 py-2.5">{h || <span className="sr-only">Actions</span>}</th>)}</tr></thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">{list.data.orders.map((o) => <tr key={o.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
          <td className="whitespace-nowrap px-3 py-2.5 font-mono font-semibold">{o.poNumber}</td>
          <td dir="auto" className="px-3 py-2.5">{o.supplier || '—'}</td>
          <td className="whitespace-nowrap px-3 py-2.5">{o.poDate || '—'}</td>
          <td className="px-3 py-2.5 tabular-nums">{o.lines}</td>
          <td className="px-3 py-2.5 tabular-nums">{qtyText(o.quantity)}</td>
          <td className="px-3 py-2.5 tabular-nums">{qtyText(o.deliveredQty)}</td>
          <td className="px-3 py-2.5"><Badge>{o.source === 'import' ? 'Excel' : o.source === 'api' ? 'Purchasing' : 'By hand'}</Badge></td>
          <td className="whitespace-nowrap px-3 py-2.5 text-xs text-muted">{formatDateTime(o.updatedAt)}</td>
          <td className="whitespace-nowrap px-3 py-2.5 text-right">
            <Button aria-label={`Open PO ${o.poNumber}`} onClick={() => setOpened(o.id)}>Open</Button>
            {can(P.setup) && o.deliveredQty === 0 && <button type="button" className="btn-ghost ms-1 h-9 min-h-0 px-2 text-danger-700 touch:h-11 dark:text-danger-400" aria-label={`Delete PO ${o.poNumber}`} onClick={() => void del(o.id, o.poNumber)}><Trash2 className="h-4 w-4" /></button>}
          </td>
        </tr>)}</tbody>
      </table></ScrollX></Card>}
    {list.data && list.data.total > PAGE && <div className="flex items-center justify-between gap-2 text-sm text-muted"><span>{list.data.total.toLocaleString()} POs</span><div className="flex gap-2"><Button disabled={!offset} onClick={() => setOffset((x) => Math.max(0, x - PAGE))}>Previous</Button><Button disabled={!list.data.hasMore} onClick={() => setOffset((x) => x + PAGE)}>Next</Button></div></div>}
    {manage && <ImportSheet />}
    {opened === 'new' && <PoDialog onClose={() => setOpened(null)} />}
    {opened && opened !== 'new' && (openedPo.data ? (manage ? <PoDialog key={`${openedPo.data.id}:${openedPo.data.version}`} po={openedPo.data} onClose={() => setOpened(null)} />
      : <PoReadOnly po={openedPo.data} onClose={() => setOpened(null)} />)
      : <Modal open size="sm" title="Purchase order" onClose={() => setOpened(null)}>{openedPo.isError ? <p role="alert" className="text-sm text-danger-600">{openedPo.error.message}</p> : <p className="flex items-center gap-2 text-sm text-muted"><Loader2 className="h-4 w-4 animate-spin" />Loading…</p>}</Modal>)}
  </div>
}

function PoReadOnly({ po, onClose }: { po: PurchaseOrder; onClose: () => void }) {
  return <Modal open size="xl" title={`PO ${po.poNumber}`} onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
    <p className="mb-3 text-sm">{[po.supplier, po.poDate, po.notes].filter(Boolean).join(' · ') || '—'}</p>
    <ScrollX label="The PO's lines"><table className="w-full min-w-[860px] text-left text-sm">
      <thead className="text-xs text-muted"><tr>{['Line', 'Item', 'Description', 'Drawing', 'Dimensions', 'Ordered', 'Delivered', 'Accepted', 'Rejected', 'Hold', 'Awaiting QC'].map((h) => <th key={h} scope="col" className="whitespace-nowrap border-b px-2 py-2 dark:border-slate-700">{h}</th>)}</tr></thead>
      <tbody>{po.lines.map((l) => <tr key={l.id} className="border-b border-slate-100 dark:border-slate-800">
        <td className="px-2 py-2 tabular-nums">{l.lineNo}</td><td dir="auto" className="px-2 py-2 font-semibold">{l.itemCode}</td><td dir="auto" className="px-2 py-2">{l.description || '—'}</td>
        <td dir="auto" className="px-2 py-2">{l.drawing || '—'}</td><td dir="auto" className="px-2 py-2">{l.dimensions || '—'}</td>
        {[l.quantity, l.deliveredQty, l.acceptedQty, l.rejectedQty, l.holdQty, l.pendingQty].map((v, i) => <td key={i} className="whitespace-nowrap px-2 py-2 tabular-nums">{qtyText(v, i === 0 ? l.unit : '')}</td>)}
      </tr>)}</tbody>
    </table></ScrollX>
  </Modal>
}
