// §4 — the PDI record: every PDI on record, filtered in SQL, newest first and
// walked back page by page, in History's PDI view. The filters are kept on
// this device; Export takes every PDI they match.

import { useEffect, useMemo, useState } from 'react'
import { ChevronRight, Download, FileText, RotateCcw, Search } from 'lucide-react'
import type { PDIListFilters, PDIWithOrder } from '@qc/shared/api'
import { can } from '@qc/shared/rules'
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Select, Stat } from '@/components/ui'
import { ImagePicker } from '@/components/inspection/ImagePicker'
import { loadOlderPdi, loadPdiExport, useDebounced, usePdiList, usePdiOptions } from '@/services/queries'
import { downloadWorkbook } from '@/lib/xlsxWrite'
import { pdiSheets } from '@/components/history/exportHistory'
import { usePersistedState } from '@/lib/usePersistedState'
import { useAuth } from '@/store/AuthContext'
import { useApp } from '@/store/AppContext'
import { When } from '@/components/ui/Tooltip'

const PAGE = 50

type RangeFilter = 'all' | '7' | '30' | '90' | 'custom'
const RANGE_LABEL: Record<RangeFilter, string> = {
  all: 'All time',
  '7': 'Last 7 days',
  '30': 'Last 30 days',
  '90': 'Last 90 days',
  custom: 'A day or a range…',
}

/** A calendar day on this device, YYYY-MM-DD, `back` days ago. */
function localDay(back = 0): string {
  const d = new Date()
  d.setDate(d.getDate() - back)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** The items of a PDI in a line: each item with its drawing numbers. */
function ItemsCell({ doc, max = 3 }: { doc: PDIWithOrder; max?: number }) {
  const shown = doc.items.slice(0, max)
  return (
    <ul className="space-y-0.5">
      {shown.map((i) => (
        <li key={i.itemCode || i.item} className="text-sm" dir="auto">
          <span className="font-medium">{i.item}</span>
          {i.drawings.length > 0 && <span className="ml-1.5 text-xs text-muted">· {i.drawings.join(', ')}</span>}
        </li>
      ))}
      {doc.items.length > max && <li className="text-xs text-muted">+{doc.items.length - max} more</li>}
    </ul>
  )
}

export function PdiDetail({ doc, onClose }: { doc: PDIWithOrder; onClose: () => void }) {
  return (
    <Modal open onClose={onClose} title={`PDI · ${doc.orderNumber}`} icon={<FileText className="h-5 w-5" />} size="lg">
      <div className="space-y-4">
        <p className="text-sm text-muted">
          {doc.customer && <span className="font-semibold text-slate-700 dark:text-slate-200">{doc.customer} · </span>}
          <When iso={doc.createdAt} time /> · {doc.createdByName}
        </p>
        <div>
          <span className="label">
            {doc.items.length} {doc.items.length === 1 ? 'item' : 'items'} in this delivery
          </span>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-muted">
                <th className="px-2 py-1.5 font-semibold">Item</th>
                <th className="px-2 py-1.5 font-semibold">Code</th>
                <th className="px-2 py-1.5 font-semibold">Drawing</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {doc.items.map((i) => (
                <tr key={i.itemCode || i.item}>
                  <td className="px-2 py-1.5 font-semibold" dir="auto">{i.item}</td>
                  <td className="px-2 py-1.5 text-muted">{i.itemCode || '—'}</td>
                  <td className="px-2 py-1.5">{i.drawings.length ? i.drawings.join(' · ') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {doc.notes && (
          <div>
            <span className="label">Notes</span>
            <p dir="auto" className="whitespace-pre-wrap text-sm">{doc.notes}</p>
          </div>
        )}
        <div>
          <span className="label">Photos</span>
          {doc.imageIds.length ? <ImagePicker imageIds={doc.imageIds} onChange={() => {}} readOnly /> : <p className="text-sm text-muted">No photo.</p>}
        </div>
      </div>
    </Modal>
  )
}

export function PdiList() {
  const { toast } = useApp()
  const { role } = useAuth()
  const [term, setTerm] = usePersistedState('qc-pdi:term', '')
  const [range, setRange] = usePersistedState<RangeFilter>('qc-pdi:range', 'all')
  const [fromDay, setFromDay] = usePersistedState('qc-pdi:from', localDay())
  const [toDay, setToDay] = usePersistedState('qc-pdi:to', localDay())
  const [item, setItem] = usePersistedState('qc-pdi:item', '')
  const [by, setBy] = usePersistedState('qc-pdi:by', 'all')
  const [exporting, setExporting] = useState(false)
  const [open, setOpen] = useState<PDIWithOrder | null>(null)

  const settledTerm = useDebounced(term.trim(), 300)
  const settledItem = useDebounced(item.trim(), 300)
  const filters = useMemo<PDIListFilters>(() => {
    const f: PDIListFilters = {}
    if (settledTerm) f.q = settledTerm
    if (settledItem) f.item = settledItem
    if (by !== 'all') f.createdById = by
    if (range === 'custom') {
      const [a, b] = fromDay && toDay && fromDay > toDay ? [toDay, fromDay] : [fromDay, toDay]
      if (a) f.from = a
      if (b) f.to = b
    } else if (range !== 'all') f.from = localDay(Number(range))
    return f
  }, [settledTerm, settledItem, by, range, fromDay, toDay])
  const filtersSet = term !== '' || item !== '' || by !== 'all' || range !== 'all'
  const resetFilters = () => {
    setTerm('')
    setItem('')
    setBy('all')
    setRange('all')
    setFromDay(localDay())
    setToDay(localDay())
  }

  const { data, isLoading, isFetching } = usePdiList(filters, PAGE)
  const { data: options } = usePdiOptions()
  const [older, setOlder] = useState<PDIWithOrder[]>([])
  const [olderHasMore, setOlderHasMore] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  useEffect(() => {
    setOlder([])
    setOlderHasMore(false)
  }, [filters])
  const docs = useMemo(() => {
    const first = data?.documents ?? []
    const seen = new Set(first.map((d) => d.id))
    return [...first, ...older.filter((d) => !seen.has(d.id))]
  }, [data, older])
  const hasMore = older.length > 0 ? olderHasMore : (data?.hasMore ?? false)
  const total = data?.total ?? docs.length

  async function showOlder() {
    const last = docs[docs.length - 1]
    if (!last || loadingOlder) return
    setLoadingOlder(true)
    try {
      const page = await loadOlderPdi(filters, last.createdAt, PAGE)
      setOlder((prev) => [...prev, ...page.documents])
      setOlderHasMore(page.hasMore)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not load older PDIs.', 'error')
    } finally {
      setLoadingOlder(false)
    }
  }

  // §4 — the PDIs the filters match, to Excel: one row per item.
  const canExport = can(role, 'export-records')
  async function exportExcel() {
    if (exporting) return
    setExporting(true)
    try {
      const all = await loadPdiExport(filters)
      if (all.length === 0) {
        toast('No PDI matches these filters.', 'info')
        return
      }
      downloadWorkbook(`QC-PDI-${localDay()}.xlsx`, pdiSheets(all))
      toast(`Exported ${all.length} ${all.length === 1 ? 'PDI' : 'PDIs'}.`, 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not build the export.', 'error')
    } finally {
      setExporting(false)
    }
  }


  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-stretch gap-3">
        <div className="min-w-[12rem] flex-1">
          <Stat compact label="PDI documents" value={total} sub={total > docs.length ? `${docs.length} on screen, the rest below` : 'All of them on screen'} icon={<FileText className="h-5 w-5" />} />
        </div>

      </div>

      <Card className="space-y-3 p-4">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <Input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Order, customer, item, drawing, note or who…" className="min-h-[52px] pl-9 text-base" aria-label="Search PDI" />
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <Field label="Date range">
            <Select value={range} onChange={(e) => setRange(e.target.value as RangeFilter)} className="min-h-[48px]" aria-label="PDI date range">
              {(Object.keys(RANGE_LABEL) as RangeFilter[]).map((r) => (
                <option key={r} value={r}>
                  {RANGE_LABEL[r]}
                </option>
              ))}
            </Select>
          </Field>
          {range === 'custom' && (
            <>
              <Field label="From day">
                <Input type="date" value={fromDay} max={toDay || undefined} onChange={(e) => setFromDay(e.target.value)} className="min-h-[48px]" aria-label="PDI from day" />
              </Field>
              <Field label="To day">
                <Input type="date" value={toDay} min={fromDay || undefined} onChange={(e) => setToDay(e.target.value)} className="min-h-[48px]" aria-label="PDI to day" />
              </Field>
            </>
          )}
          <Field label="Item or drawing">
            <Input value={item} onChange={(e) => setItem(e.target.value)} placeholder="Any part of it" className="min-h-[48px]" aria-label="PDI item" />
          </Field>
          <Field label="Recorded by">
            <Select value={by} onChange={(e) => setBy(e.target.value)} className="min-h-[48px]" aria-label="PDI recorded by">
              <option value="all">Everyone</option>
              {(options?.createdBy ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          {isFetching && !isLoading ? <p className="text-xs text-muted">Searching the whole record…</p> : <span />}
          <span className="flex flex-wrap gap-2">
            {canExport && (
              <Button className="min-h-[40px]" onClick={() => void exportExcel()} disabled={exporting || total === 0} aria-label="Export the PDIs to Excel">
                <Download className="h-4 w-4" /> {exporting ? 'Building…' : 'Export Excel'}
              </Button>
            )}
            <Button className="min-h-[40px]" onClick={resetFilters} disabled={!filtersSet} aria-label="Reset all PDI filters">
              <RotateCcw className="h-4 w-4" /> Reset all
            </Button>
          </span>
        </div>
      </Card>

      {isLoading ? (
        <Card className="p-10 text-center text-sm text-muted">Loading…</Card>
      ) : docs.length === 0 ? (
        <EmptyState
          icon={<FileText className="h-10 w-10" />}
          title={filtersSet ? 'No PDI matches' : 'No PDI documents yet'}
          hint={filtersSet ? 'Nothing in the whole record matches these filters — widen the date range or clear the search.' : 'A PDI recorded from the PDI button on Inspections shows here.'}
        />
      ) : (
        <>
          {/* Phone: one card per PDI. */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:hidden">
            {docs.map((d) => (
              <button key={d.id} type="button" onClick={() => setOpen(d)} className="card-hover w-full min-w-0 p-4 text-left">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-bold">{d.orderNumber || 'Unknown order'}</span>
                  <Badge tone="neutral">
                    {d.imageIds.length} photo{d.imageIds.length === 1 ? '' : 's'}
                  </Badge>
                  <ChevronRight className="ml-auto h-5 w-5 shrink-0 text-muted" />
                </div>
                <p className="mt-0.5 text-xs text-muted">
                  {d.customer && `${d.customer} · `}
                  <When iso={d.createdAt} time /> · {d.createdByName}
                </p>
                <div className="mt-2">
                  <ItemsCell doc={d} />
                </div>
              </button>
            ))}
          </div>

          {/* md+: the same PDIs as a table. */}
          <Card className="hidden overflow-x-auto md:block">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-800/60">
                <tr className="text-left text-[11px] uppercase tracking-wide text-muted">
                  <th className="px-3 py-2 font-semibold">Date</th>
                  <th className="px-3 py-2 font-semibold">Order</th>
                  <th className="px-3 py-2 font-semibold">Customer</th>
                  <th className="px-3 py-2 font-semibold">Items · drawing</th>
                  <th className="px-3 py-2 font-semibold">By</th>
                  <th className="px-3 py-2 text-right font-semibold">Photos</th>
                  <th className="px-3 py-2 font-semibold">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {docs.map((d) => (
                  <tr key={d.id} onClick={() => setOpen(d)} className="cursor-pointer align-top hover:bg-slate-50 dark:hover:bg-slate-800/60">
                    <td className="whitespace-nowrap px-3 py-2 text-muted"><When iso={d.createdAt} time /></td>
                    <td className="whitespace-nowrap px-3 py-2 font-semibold">{d.orderNumber || '—'}</td>
                    <td className="px-3 py-2 text-slate-600 dark:text-slate-300">{d.customer || '—'}</td>
                    <td className="px-3 py-2">
                      <ItemsCell doc={d} />
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">{d.createdByName}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{d.imageIds.length}</td>
                    <td className="max-w-[16rem] px-3 py-2 text-muted">
                      <span className="line-clamp-2" dir="auto">{d.notes ?? ''}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          {hasMore && (
            <div className="flex justify-center">
              <Button className="min-h-[44px]" onClick={() => void showOlder()} disabled={loadingOlder}>
                {loadingOlder ? 'Loading…' : 'Show older PDIs'}
              </Button>
            </div>
          )}
        </>
      )}

      {open && <PdiDetail doc={open} onClose={() => setOpen(null)} />}
    </div>
  )
}
