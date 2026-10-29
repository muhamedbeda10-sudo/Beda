import { useState, type ReactNode } from 'react'
import { Loader2, Pencil, Recycle, Trash2 } from 'lucide-react'
import type { ScrapListQuery, ScrapRecord } from '@qc/shared/scrap'
import { calendarDay } from '@qc/shared/rules'
import { Button, Card, Drawer, EmptyState, Field, Input, Modal, Select } from '@/components/ui'
import { ExportMenu, FilterBar, FilterSelect, type FilterChip } from '@/components/ui/PageShell'
import { ScrollX } from '@/components/ui/ScrollX'
import { ImagePicker } from '@/components/inspection/ImagePicker'
import { ScrapDialog } from '@/components/scrap/ScrapDialog'
import { downloadWorkbook } from '@/lib/xlsxWrite'
import { usePersistedState } from '@/lib/usePersistedState'
import { formatDate, formatDateTime } from '@/lib/utils'
import { loadScrapExport, useDeleteScrap, useScrapList, useScrapOptions } from '@/services/scrap'
import { useDebounced } from '@/services/queries'
import { useAuth } from '@/store/AuthContext'
import { useApp } from '@/store/AppContext'

const PAGE = 50
const kg = (value: number) => `${value.toLocaleString(undefined, { maximumFractionDigits: 3 })} kg`

/** History → Scrap: every scrap record, filtered, with the total weight of what the filters match. */
export function ScrapList({ leading }: { leading?: ReactNode }) {
  const { can, profile, factoryTimeZone } = useAuth()
  const { toast } = useApp()
  const [search, setSearch] = usePersistedState('qc-scrap:q', '')
  const [factory, setFactory] = usePersistedState('qc-scrap:factory', '')
  const [machineId, setMachineId] = usePersistedState('qc-scrap:machine', '')
  const [scrapTypeId, setScrapTypeId] = usePersistedState('qc-scrap:type', '')
  const [inspectorId, setInspectorId] = usePersistedState('qc-scrap:inspector', '')
  const [from, setFrom] = usePersistedState('qc-scrap:from', '')
  const [to, setTo] = usePersistedState('qc-scrap:to', '')
  const [offset, setOffset] = useState(0)
  const [opened, setOpened] = useState<ScrapRecord | null>(null)
  const [editing, setEditing] = useState<ScrapRecord | null>(null)
  const [deleting, setDeleting] = useState<ScrapRecord | null>(null)
  const [exporting, setExporting] = useState(false)
  const options = useScrapOptions()
  const remove = useDeleteScrap()
  const term = useDebounced(search.trim(), 250)
  const filters: Omit<ScrapListQuery, 'offset' | 'limit'> = {
    q: term || undefined, factory: factory || undefined, machineId: machineId || undefined, scrapTypeId: scrapTypeId || undefined,
    inspectorId: inspectorId || undefined, from: from || undefined, to: to || undefined,
  }
  const list = useScrapList({ ...filters, offset, limit: PAGE })
  const data = options.data
  const change = (setter: (v: string) => void) => (value: string) => { setter(value); setOffset(0) }
  const machineName = (id: string) => data?.machines.find((m) => m.id === id)?.displayName ?? 'one machine'
  const machines = data ? data.machines.filter((m) => !factory || m.factory === factory) : []
  // Everyone who can be named, and everyone named on a record (a former inspector too).
  const inspectors = data ? [...data.inspectors, ...data.recordedInspectors.filter((r) => !data.inspectors.some((p) => p.id === r.id))].sort((a, b) => a.name.localeCompare(b.name)) : []
  const chips: FilterChip[] = [
    ...(factory ? [{ key: 'factory', label: `Factory: ${factory}`, onRemove: () => change(setFactory)('') }] : []),
    ...(machineId ? [{ key: 'machine', label: `Work center: ${machineName(machineId)}`, onRemove: () => change(setMachineId)('') }] : []),
    ...(scrapTypeId ? [{ key: 'type', label: `Type: ${data?.types.find((t) => t.id === scrapTypeId)?.name ?? 'one type'}`, onRemove: () => change(setScrapTypeId)('') }] : []),
    ...(inspectorId ? [{ key: 'inspector', label: `Inspector: ${inspectors.find((p) => p.id === inspectorId)?.name ?? 'one inspector'}`, onRemove: () => change(setInspectorId)('') }] : []),
    ...(from ? [{ key: 'from', label: `From: ${formatDate(from)}`, onRemove: () => change(setFrom)('') }] : []),
    ...(to ? [{ key: 'to', label: `To: ${formatDate(to)}`, onRemove: () => change(setTo)('') }] : []),
  ]
  function reset() { setSearch(''); setFactory(''); setMachineId(''); setScrapTypeId(''); setInspectorId(''); setFrom(''); setTo(''); setOffset(0) }
  const mayChange = (r: ScrapRecord) => can('edit-scrap') || (can('record-scrap') && r.createdById === profile?.id)

  async function exportExcel() {
    setExporting(true)
    try {
      const all = await loadScrapExport(filters)
      downloadWorkbook(`QC-Scrap-${calendarDay(new Date(), factoryTimeZone)}.xlsx`, [{
        name: 'Scrap',
        header: ['Date', 'Factory', 'Work center', 'Scrap type', 'Weight (kg)', 'Responsible person', 'Quality inspector', 'Recorded by', 'Recorded at'],
        rows: all.map((r) => [r.date, r.factory, r.machineName, r.scrapTypeName, r.weightKg, r.responsiblePerson, r.inspectorName, r.createdByName, formatDateTime(r.createdAt)]),
      }])
      toast(`Exported ${all.length} scrap record${all.length === 1 ? '' : 's'}.`, 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not build the export.', 'error')
    } finally {
      setExporting(false)
    }
  }

  async function confirmDelete() {
    if (!deleting) return
    try {
      await remove.mutateAsync(deleting)
      toast('Scrap record deleted.', 'success')
      setDeleting(null)
      setOpened(null)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not delete.', 'error')
    }
  }

  const records = list.data?.records ?? []
  return <div className="space-y-3">
    <FilterBar
      leading={leading}
      search={{ value: search, onChange: change(setSearch), placeholder: 'Work center, type, inspector…', label: 'Search scrap' }}
      filters={<>
        <FilterSelect label="Factory" value={factory} onChange={(v) => { change(setFactory)(v); setMachineId('') }}><option value="">All factories</option>{(data?.factories ?? []).map((f) => <option key={f}>{f}</option>)}</FilterSelect>
        <FilterSelect label="Scrap type" value={scrapTypeId} onChange={change(setScrapTypeId)}><option value="">All types</option>{(data?.types ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</FilterSelect>
      </>}
      more={<>
        <Field label="Work center"><Select value={machineId} onChange={(e) => change(setMachineId)(e.target.value)}><option value="">All work centers</option>{machines.map((m) => <option key={m.id} value={m.id}>{m.displayName || m.code}</option>)}</Select></Field>
        <Field label="Quality inspector"><Select value={inspectorId} onChange={(e) => change(setInspectorId)(e.target.value)}><option value="">All inspectors</option>{inspectors.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
        <Field label="From date"><Input type="date" value={from} onChange={(e) => change(setFrom)(e.target.value)} /></Field>
        <Field label="To date"><Input type="date" value={to} onChange={(e) => change(setTo)(e.target.value)} /></Field>
      </>}
      moreCount={[machineId, inspectorId, from, to].filter(Boolean).length}
      chips={chips}
      onReset={reset}
      canReset={!!(search || chips.length)}
      actions={can('export-records') ? <ExportMenu busy={exporting} items={[{ label: 'Export Excel', onClick: () => void exportExcel(), disabled: !list.data?.total }]} /> : undefined}
    />
    {options.isError && <p role="alert" className="text-sm text-danger-600">Could not load filter choices. <button type="button" className="underline" onClick={() => void options.refetch()}>Retry</button></p>}
    {list.isPending ? <p className="flex items-center justify-center gap-2 py-14 text-sm text-muted"><Loader2 className="h-4 w-4 animate-spin" />Loading scrap…</p> : list.isError ?
      <p role="alert" className="py-10 text-center text-sm text-danger-600">{list.error.message} <button type="button" className="underline" onClick={() => void list.refetch()}>Retry</button></p> : records.length === 0 ?
        <EmptyState icon={<Recycle className="h-10 w-10" />} title="No scrap records found" hint={search || chips.length ? 'Try changing the filters.' : 'Scrap recorded from Inspections (New Scrap) appears here.'} /> : <>
          {/* A phone: one card per record. */}
          <ul className="space-y-2 md:hidden">{records.map((r) => <li key={r.id}>
            <button type="button" onClick={() => setOpened(r)} className="card flex w-full items-start justify-between gap-3 p-3 text-left">
              <span className="min-w-0"><span className="block font-semibold">{r.machineName}</span>
                <span className="block text-xs text-muted">{formatDate(r.date)} · {r.factory} · {r.scrapTypeName}</span>
                <span className="block text-xs text-muted">{r.inspectorName}</span></span>
              <span className="shrink-0 font-bold tabular-nums">{kg(r.weightKg)}</span>
            </button>
          </li>)}</ul>
          <Card className="hidden overflow-hidden md:block"><ScrollX label="Scrap records"><table className="w-full min-w-[960px] text-left text-sm">
            <thead className="bg-slate-50 text-xs text-muted dark:bg-slate-800"><tr>{['Date', 'Factory', 'Work center', 'Scrap type', 'Weight', 'Responsible person', 'Quality inspector', ''].map((name, i) => <th key={i} scope="col" className={i === 4 ? 'px-3 py-3 text-right font-semibold' : 'px-3 py-3 font-semibold'}>{name || <span className="sr-only">Open record</span>}</th>)}</tr></thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">{records.map((r) => <tr key={r.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
              <td className="whitespace-nowrap px-3 py-2.5 tabular-nums">{formatDate(r.date)}</td>
              <td className="px-3 py-2.5">{r.factory}</td>
              <td className="px-3 py-2.5">{r.machineName}</td>
              <td className="px-3 py-2.5">{r.scrapTypeName}</td>
              <td className="whitespace-nowrap px-3 py-2.5 text-right font-semibold tabular-nums">{kg(r.weightKg)}</td>
              <td dir="auto" className="px-3 py-2.5">{r.responsiblePerson || '—'}</td>
              <td className="px-3 py-2.5">{r.inspectorName}</td>
              <td className="px-3 py-2.5 text-right"><Button onClick={() => setOpened(r)} aria-label={`Open scrap of ${r.machineName} on ${r.date}`}>Open</Button></td>
            </tr>)}</tbody>
          </table></ScrollX></Card>
        </>}
    {list.data && <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted">
      <span>{list.data.total.toLocaleString()} record{list.data.total === 1 ? '' : 's'} · total <strong className="text-slate-900 tabular-nums dark:text-slate-100">{kg(list.data.totalWeightKg)}</strong>{list.data.total > 0 && ` · ${offset + 1}–${offset + records.length}`}</span>
      <div className="flex gap-2"><Button disabled={!offset || list.isFetching} onClick={() => setOffset((v) => Math.max(0, v - PAGE))}>Previous</Button><Button disabled={!list.data.hasMore || list.isFetching} onClick={() => setOffset((v) => v + PAGE)}>Next</Button></div>
    </div>}
    {opened && <Drawer open onClose={() => setOpened(null)} title="Scrap" subtitle={`${formatDate(opened.date)} · ${opened.machineName}`} footer={<>
      {mayChange(opened) && <Button variant="danger" onClick={() => setDeleting(opened)}><Trash2 className="h-4 w-4" />Delete</Button>}
      <span className="flex-1" />
      {mayChange(opened) && <Button onClick={() => setEditing(opened)}><Pencil className="h-4 w-4" />Correct</Button>}
      <Button onClick={() => setOpened(null)}>Close</Button>
    </>}>
      <dl className="grid gap-4 text-sm sm:grid-cols-2">
        {[
          ['Date', formatDate(opened.date)], ['Factory', opened.factory], ['Work center', opened.machineName], ['Scrap type', opened.scrapTypeName],
          ['Weight', kg(opened.weightKg)], ['Responsible person', opened.responsiblePerson || '—'], ['Quality inspector', opened.inspectorName],
        ].map(([label, value]) => <div key={label}><dt className="label">{label}</dt><dd dir="auto" className="break-words">{value}</dd></div>)}
        <div className="grid grid-cols-2 gap-4 sm:col-span-2">
          <div><dt className="label">Scrap card</dt><dd><ImagePicker imageIds={[opened.cardImageId]} onChange={() => undefined} readOnly size="lg" /></dd></div>
          <div><dt className="label">Scrap box</dt><dd><ImagePicker imageIds={[opened.boxImageId]} onChange={() => undefined} readOnly size="lg" /></dd></div>
        </div>
      </dl>
      <p className="mt-6 text-xs text-muted">Recorded by {opened.createdByName} · {formatDateTime(opened.createdAt)}{opened.version > 0 && ` · corrected by ${opened.updatedByName} · ${formatDateTime(opened.updatedAt)}`}</p>
    </Drawer>}
    {editing && <ScrapDialog record={editing} onClose={() => setEditing(null)} onSaved={(saved) => setOpened(saved)} />}
    {deleting && <Modal open onClose={() => !remove.isPending && setDeleting(null)} title="Delete this scrap record?" size="sm" footer={<>
      <Button onClick={() => setDeleting(null)} disabled={remove.isPending}>Keep it</Button>
      <Button variant="danger" onClick={() => void confirmDelete()} disabled={remove.isPending}>{remove.isPending && <Loader2 className="h-4 w-4 animate-spin" />}Delete</Button>
    </>}><p className="text-sm">{deleting.machineName} · {formatDate(deleting.date)} · {kg(deleting.weightKg)}. The deletion is kept in the audit log.</p></Modal>}
  </div>
}
