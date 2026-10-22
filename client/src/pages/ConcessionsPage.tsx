import { useState } from 'react'
import { FileCheck2, Loader2, Plus } from 'lucide-react'
import type { Concession } from '@qc/shared/concessions'
import { Button, Card, Drawer, EmptyState, Field, Input } from '@/components/ui'
import { FilterBar, FilterSelect } from '@/components/ui/PageShell'
import { ScrollX } from '@/components/ui/ScrollX'
import { ImagePicker } from '@/components/inspection/ImagePicker'
import { NewConcessionDialog } from '@/components/concessions/NewConcessionDialog'
import { useConcessionOptions, useConcessions } from '@/services/concessions'
import { useDebounced } from '@/services/queries'
import { useAuth } from '@/store/AuthContext'

export function ConcessionsPage() {
  const { can } = useAuth()
  const [search, setSearch] = useState('')
  const [factory, setFactory] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [offset, setOffset] = useState(0)
  const [creating, setCreating] = useState(false)
  const [opened, setOpened] = useState<Concession | null>(null)
  const options = useConcessionOptions()
  const debounced = useDebounced(search, 250)
  const list = useConcessions({ q: debounced || undefined, factory: factory || undefined, categoryId: categoryId || undefined, from: from || undefined, to: to || undefined, offset, limit: 50 })
  const categoryName = options.data?.categories.find((c) => c.id === categoryId)?.name ?? categoryId
  const change = (setter: (v: string) => void) => (value: string) => { setter(value); setOffset(0) }
  function reset() { setSearch(''); setFactory(''); setCategoryId(''); setFrom(''); setTo(''); setOffset(0) }
  const chips = [
    ...(factory ? [{ key: 'factory', label: `Factory: ${factory}`, onRemove: () => change(setFactory)('') }] : []),
    ...(categoryId ? [{ key: 'category', label: `Category: ${categoryName}`, onRemove: () => change(setCategoryId)('') }] : []),
    ...(from ? [{ key: 'from', label: `From: ${from}`, onRemove: () => change(setFrom)('') }] : []),
    ...(to ? [{ key: 'to', label: `To: ${to}`, onRemove: () => change(setTo)('') }] : []),
  ]

  return <div className="space-y-3">
    <FilterBar search={{ value: search, onChange: change(setSearch), placeholder: 'Customer, item, description, concession by…', label: 'Search concessions' }} filters={<>
      <FilterSelect label="Factory" value={factory} onChange={change(setFactory)}><option value="">All factories</option>{(options.data?.factories ?? []).map((f) => <option key={f}>{f}</option>)}</FilterSelect>
      <FilterSelect label="Category" value={categoryId} onChange={change(setCategoryId)}><option value="">All categories</option>{(options.data?.categories ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</FilterSelect>
    </>} more={<>
      <Field label="From date"><Input type="date" value={from} onChange={(e) => change(setFrom)(e.target.value)} /></Field>
      <Field label="To date"><Input type="date" value={to} onChange={(e) => change(setTo)(e.target.value)} /></Field>
    </>} moreCount={Number(!!from) + Number(!!to)} chips={chips} onReset={reset} canReset={!!(search || chips.length)} actions={can('record-concession') ? <Button variant="primary" onClick={() => setCreating(true)}><Plus className="h-4 w-4" />New concession</Button> : undefined} />
    {options.isError && <p role="alert" className="text-sm text-danger-600">Could not load filter choices. <button className="underline" onClick={() => void options.refetch()}>Retry</button></p>}
    {list.isPending ? <p className="flex items-center justify-center gap-2 py-14 text-sm text-muted"><Loader2 className="h-4 w-4 animate-spin" />Loading concessions…</p> : list.isError ?
      <p role="alert" className="py-10 text-center text-sm text-danger-600">{list.error.message} <button type="button" className="underline" onClick={() => void list.refetch()}>Retry</button></p> : list.data.concessions.length === 0 ?
        <EmptyState icon={<FileCheck2 className="h-10 w-10" />} title="No concessions found" hint={search || chips.length ? 'Try changing the filters.' : 'Record the first concession using New concession.'} /> :
        <Card className="overflow-hidden"><ScrollX label="Concessions register"><table className="w-full min-w-[1150px] text-left text-sm">
          <thead className="bg-slate-50 text-xs text-muted dark:bg-slate-800"><tr>{['Date', 'Factory', 'MC', 'CUS', 'Item', 'Description', 'QTY', 'Category', 'Concession BY', 'Image', ''].map((name, i) => <th key={i} scope="col" className="px-3 py-3 font-semibold">{name || <span className="sr-only">Open record</span>}</th>)}</tr></thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">{list.data.concessions.map((c) => <tr key={c.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
            <td className="whitespace-nowrap px-3 py-3">{c.date}</td>
            <td className="px-3 py-3">{c.factories.join(', ')}</td>
            <td className="px-3 py-3">{c.machines.map((m) => m.displayName || m.code).join(', ')}</td>
            <td dir="auto" className="px-3 py-3">{c.customer}</td>
            <td className="px-3 py-3"><span dir="auto">{c.item}</span><span className="block text-xs text-muted">{c.itemCode}</span></td>
            <td className="max-w-64 px-3 py-3"><span dir="auto" className="line-clamp-3 break-words">{c.description}</span></td>
            <td dir="auto" className="px-3 py-3">{c.quantity}</td><td className="px-3 py-3">{c.categoryName}</td><td dir="auto" className="px-3 py-3">{c.concessionBy}</td>
            <td className="px-3 py-3">{c.imageIds.length ? <button type="button" className="min-h-11 text-brand-700 underline dark:text-brand-300" onClick={() => setOpened(c)} aria-label={`View ${c.imageIds.length} email screenshots for ${c.item}`}>{c.imageIds.length} image{c.imageIds.length === 1 ? '' : 's'}</button> : '—'}</td>
            <td className="px-3 py-3"><Button onClick={() => setOpened(c)} aria-label={`Open concession for ${c.item} on ${c.date}`}>Open</Button></td>
          </tr>)}</tbody>
        </table></ScrollX></Card>}
    {list.data && <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted">
      <span>{list.data.total.toLocaleString()} concession{list.data.total === 1 ? '' : 's'}{list.data.total > 0 && ` · ${offset + 1}–${offset + list.data.concessions.length}`}</span>
      <div className="flex gap-2"><Button disabled={!offset || list.isFetching} onClick={() => setOffset((v) => Math.max(0, v - 50))}>Previous</Button><Button disabled={!list.data.hasMore || list.isFetching} onClick={() => setOffset((v) => v + 50)}>Next</Button></div>
    </div>}
    {creating && <NewConcessionDialog onClose={() => setCreating(false)} />}
    {opened && <Drawer open onClose={() => setOpened(null)} title="Concession" subtitle={`${opened.date} · ${opened.categoryName}`} footer={<Button onClick={() => setOpened(null)}>Close</Button>}>
      <dl className="grid gap-4 text-sm sm:grid-cols-2">
        {[
          ['Factory', opened.factories.join(', ')], ['MC', opened.machines.map((m) => m.displayName || m.code).join(', ')],
          ['CUS', opened.customer], ['Item', [opened.itemCode, opened.item].filter(Boolean).join(' · ')],
          ['QTY', opened.quantity], ['Concession BY', opened.concessionBy],
        ].map(([label, value]) => <div key={label}><dt className="label">{label}</dt><dd dir="auto" className="break-words">{value}</dd></div>)}
        <div className="sm:col-span-2"><dt className="label">Description</dt><dd dir="auto" className="whitespace-pre-wrap break-words">{opened.description}</dd></div>
        <div className="sm:col-span-2"><dt className="label">Image · email screenshots</dt><dd>{opened.imageIds.length ? <ImagePicker imageIds={opened.imageIds} onChange={() => undefined} readOnly /> : 'No screenshots attached.'}</dd></div>
      </dl>
      <p className="mt-6 text-xs text-muted">Recorded by {opened.createdByName} · {new Date(opened.createdAt).toLocaleString()}</p>
    </Drawer>}
  </div>
}
