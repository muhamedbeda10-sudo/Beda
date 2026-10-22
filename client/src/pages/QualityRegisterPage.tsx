import { useState } from 'react'
import { ClipboardList, Loader2, Plus } from 'lucide-react'
import { COMPLAINT_ISSUES, NCR_SOURCES, QUALITY_FORMS, type QualityKind, type QualityRecord } from '@qc/shared/qualityRecords'
import { Button, Card, EmptyState, Field, Input } from '@/components/ui'
import { FilterBar, FilterSelect } from '@/components/ui/PageShell'
import { ScrollX } from '@/components/ui/ScrollX'
import { QualityRecordDialog } from '@/components/qualityRecords/QualityRecordDialog'
import { QualityRecordView } from '@/components/qualityRecords/QualityRecordView'
import { useQualityRecords } from '@/services/qualityRecords'
import { useDebounced } from '@/services/queries'
import { useAuth } from '@/store/AuthContext'

export function QualityRegisterPage({ kind }: { kind: QualityKind }) {
  const { can } = useAuth()
  const config = QUALITY_FORMS[kind]
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [offset, setOffset] = useState(0)
  const [editing, setEditing] = useState<QualityRecord | 'new' | null>(null)
  const [openedId, setOpenedId] = useState<string | null>(null)
  const list = useQualityRecords(kind, { q: useDebounced(search, 250) || undefined, category: category || undefined, from: from || undefined, to: to || undefined, offset, limit: 50 })
  const change = (setter: (v: string) => void) => (v: string) => { setter(v); setOffset(0) }
  const reset = () => { setSearch(''); setCategory(''); setFrom(''); setTo(''); setOffset(0) }
  const chips = [
    ...(category ? [{ key: 'category', label: category, onRemove: () => change(setCategory)('') }] : []),
    ...(from ? [{ key: 'from', label: `From: ${from}`, onRemove: () => change(setFrom)('') }] : []),
    ...(to ? [{ key: 'to', label: `To: ${to}`, onRemove: () => change(setTo)('') }] : []),
  ]
  return <div className="space-y-3">
    <FilterBar search={{ value: search, onChange: change(setSearch), placeholder: 'Report, order, description…', label: `Search ${config.title}` }} filters={<FilterSelect label={kind === 'ncr' ? 'Source' : 'Product issue'} value={category} onChange={change(setCategory)}><option value="">{kind === 'ncr' ? 'All sources' : 'All product issues'}</option>{(kind === 'ncr' ? NCR_SOURCES : COMPLAINT_ISSUES).map((c) => <option key={c}>{c}</option>)}</FilterSelect>} more={<><Field label="From date"><Input type="date" value={from} onChange={(e) => change(setFrom)(e.target.value)} /></Field><Field label="To date"><Input type="date" value={to} onChange={(e) => change(setTo)(e.target.value)} /></Field></>} moreCount={Number(!!from) + Number(!!to)} chips={chips} onReset={reset} canReset={!!(search || chips.length)} actions={can(config.record) ? <Button variant="primary" onClick={() => setEditing('new')}><Plus className="h-4 w-4" />New {config.singular}</Button> : undefined} />
    {list.isPending ? <p className="flex items-center justify-center gap-2 py-14 text-sm text-muted"><Loader2 className="h-4 w-4 animate-spin" />Loading…</p> : list.isError ? <p role="alert" className="py-10 text-center text-sm text-danger-600">{list.error.message} <button type="button" className="underline" onClick={() => void list.refetch()}>Retry</button></p> : !list.data.records.length ? <EmptyState icon={<ClipboardList className="h-10 w-10" />} title="No records found" /> : <Card className="overflow-hidden"><ScrollX label={config.title}><table className="w-full min-w-[850px] text-left text-sm">
      <thead className="bg-slate-50 text-xs text-muted dark:bg-slate-800"><tr>{['Report no.', 'Date', 'Order no.', kind === 'ncr' ? 'Source' : 'Product', 'Description', kind === 'ncr' ? 'Assigned to' : 'Product issue', kind === 'ncr' ? 'Effectiveness' : 'Quantity', ''].map((label, i) => <th key={i} scope="col" className="px-3 py-3">{label || <span className="sr-only">Open record</span>}</th>)}</tr></thead>
      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">{list.data.records.map((r) => <tr key={r.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50"><td className="whitespace-nowrap px-3 py-3 font-medium">{r.reference}</td><td className="whitespace-nowrap px-3 py-3">{r.date}</td><td className="px-3 py-3">{r.data.orderNumber || '—'}</td><td className="px-3 py-3">{r.data.kind === 'ncr' ? r.data.sources.join(', ') : r.data.productName}</td><td className="max-w-72 px-3 py-3"><span dir="auto" className="line-clamp-3 break-words">{r.data.description}</span></td><td dir="auto" className="px-3 py-3">{r.data.kind === 'ncr' ? r.data.assignedTo || '—' : r.data.issues.join(', ')}</td><td className="px-3 py-3">{r.data.kind === 'ncr' ? r.data.effectiveness : r.data.quantity || '—'}</td><td className="px-3 py-3"><Button aria-label={`Open ${r.reference}`} onClick={() => setOpenedId(r.id)}>Open</Button></td></tr>)}</tbody>
    </table></ScrollX></Card>}
    {list.data && <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted"><span>{list.data.total.toLocaleString()} records</span><div className="flex gap-2"><Button disabled={!offset || list.isFetching} onClick={() => setOffset((v) => Math.max(0, v - 50))}>Previous</Button><Button disabled={!list.data.hasMore || list.isFetching} onClick={() => setOffset((v) => v + 50)}>Next</Button></div></div>}
    {editing && <QualityRecordDialog key={editing === 'new' ? 'new' : `${editing.id}:${editing.version}`} kind={kind} record={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} onSaved={(r) => { setEditing(null); setOpenedId(r.id); setOffset(0) }} />}
    {openedId && !editing && <QualityRecordView kind={kind} id={openedId} onClose={() => setOpenedId(null)} onEdit={setEditing} />}
  </div>
}
