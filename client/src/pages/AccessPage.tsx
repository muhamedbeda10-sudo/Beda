// ============================================================================
// §19 — Access: the ERP order sheet as it was uploaded, as one table anyone
// can browse. Every filter runs in SQL over the whole sheet, so a line is
// found wherever it sits; the columns are the reader's to choose and to
// size, as in History. A line with inspections opens History on it.
// ============================================================================

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronRight, RotateCcw, Search, Table2, X } from 'lucide-react'
import type { OrderListFilters, OrderListRow } from '@qc/shared/api'
import { Badge, Button, Card, EmptyState, Field, Input, Select } from '@/components/ui'
import { ColumnPicker, FitColumnsButton, GridFrame, useResizableColumns, type ColumnDef } from '@/components/ui/ResizableColumns'
import { loadMoreOrders, useDebounced, useMaster, useOrderList, useOrderListOptions } from '@/services/queries'
import { usePersistedState } from '@/lib/usePersistedState'
import { useApp } from '@/store/AppContext'
import { cn, formatDate, formatDateTime } from '@/lib/utils'

const ACCESS_COLUMNS: ColumnDef[] = [
  { key: 'orderNumber', label: 'Order', width: 150, min: 90 },
  { key: 'lineKey', label: 'Line key', width: 110, min: 70, defaultHidden: true },
  { key: 'item', label: 'Item', width: 240, min: 100 },
  { key: 'itemCode', label: 'Item code', width: 130, min: 80 },
  { key: 'machine', label: 'Machine', width: 160, min: 80 },
  { key: 'factory', label: 'Factory', width: 110, min: 80, defaultHidden: true },
  { key: 'erpStatus', label: 'ERP status', width: 100, min: 80 },
  { key: 'requiredQty', label: 'Required', width: 100, min: 72, align: 'right' },
  { key: 'finishedQty', label: 'Finished', width: 100, min: 72, align: 'right' },
  { key: 'remainingQty', label: 'Remaining', width: 100, min: 72, align: 'right' },
  { key: 'customer', label: 'Customer', width: 170, min: 90 },
  { key: 'expectedGrade', label: 'Expected grade', width: 120, min: 80 },
  { key: 'drawing', label: 'Drawing', width: 130, min: 80, defaultHidden: true },
  { key: 'drawingAlt', label: 'Drawing (alt)', width: 130, min: 80, defaultHidden: true },
  { key: 'issue', label: 'Issue', width: 90, min: 64, defaultHidden: true },
  { key: 'material', label: 'Material', width: 120, min: 80, defaultHidden: true },
  { key: 'type', label: 'Type', width: 100, min: 64, defaultHidden: true },
  { key: 'colour', label: 'Colour', width: 100, min: 64, defaultHidden: true },
  { key: 'date', label: 'Order date', width: 120, min: 90 },
  { key: 'sessions', label: 'Sessions', width: 96, min: 72, align: 'right', defaultHidden: true },
  { key: 'samples', label: 'Samples', width: 96, min: 72, align: 'right', defaultHidden: true },
  { key: 'defectPieces', label: 'Defect pcs', width: 104, min: 80, align: 'right', defaultHidden: true },
  { key: 'lastInspected', label: 'Last inspected', width: 150, min: 90, defaultHidden: true },
  { key: 'open', label: '', width: 48, min: 40, hideable: false },
]

const num = (v: number | null | undefined) => (v === null || v === undefined || Number.isNaN(v) ? '—' : String(v))

/** The code out of what was typed or picked: "125185TA3 — XL Light Beam" and "125185TA3" both give the code. */
/** A pick from the list is "code — name"; sending the code alone matches it. Anything else is sent as typed. */
const itemTermOf = (typed: string) => (typed.includes(' — ') ? typed.split(' — ')[0] : typed).trim()

function statusTone(s: string): 'green' | 'amber' | 'violet' | 'neutral' | 'red' {
  const v = s.trim().toLowerCase()
  if (v === 'active') return 'green'
  if (v === 'hold') return 'amber'
  if (v === 'stock') return 'violet'
  if (v === 'cancel' || v === 'cancelled') return 'red'
  return 'neutral'
}

function cell(key: string, o: OrderListRow, fixed: boolean, machineName: (code: string) => string): ReactNode {
  const clip = fixed ? 'truncate' : ''
  const text = (value: string, extra = '') => (
    <td key={key} className={cn('px-4 py-3', extra, clip)} title={value || undefined}>
      {value || '—'}
    </td>
  )
  const number = (value: number | null | undefined, extra = '') => (
    <td key={key} className={cn('px-4 py-3 text-right tabular-nums', extra)}>
      {num(value)}
    </td>
  )
  switch (key) {
    case 'orderNumber':
      return text(o.orderNumber, 'font-bold')
    case 'lineKey':
      return text(o.lineKey, 'font-mono text-xs')
    case 'item':
      return (
        <td key={key} className={cn('px-4 py-3', fixed ? 'truncate' : 'max-w-[240px] truncate')} title={o.item}>
          {o.item || '—'}
        </td>
      )
    case 'itemCode':
      return text(o.itemCode, 'font-mono text-xs')
    case 'machine':
      return text(machineName(o.workCenterCode))
    case 'factory':
      return text(o.factory)
    case 'erpStatus':
      return (
        <td key={key} className="px-4 py-3">
          {o.erpStatus ? <Badge tone={statusTone(o.erpStatus)}>{o.erpStatus}</Badge> : '—'}
        </td>
      )
    case 'requiredQty':
      return number(o.requiredQty)
    case 'finishedQty':
      return number(o.finishedQty)
    case 'remainingQty':
      return number(o.remainingQty, o.remainingQty > 0 ? 'font-semibold text-brand-700 dark:text-brand-300' : 'text-slate-400')
    case 'customer':
      return text(o.customer)
    case 'expectedGrade':
      return text(o.expectedGrade)
    case 'drawing':
      return text(o.drawing)
    case 'drawingAlt':
      return text(o.drawingAlt ?? '')
    case 'issue':
      return text(o.issue ?? '')
    case 'material':
      return text(o.material)
    case 'type':
      return text(o.type)
    case 'colour':
      return text(o.colour)
    case 'date':
      return text(o.date ? formatDate(o.date) : '', 'tabular-nums')
    case 'sessions':
      return number(o.sessions, o.sessions > 0 ? 'font-semibold' : 'text-slate-400')
    case 'samples':
      return number(o.samples, o.samples > 0 ? '' : 'text-slate-400')
    case 'defectPieces':
      return number(o.defectPieces, o.defectPieces > 0 ? 'font-bold text-rose-600 dark:text-rose-400' : 'text-slate-400')
    case 'lastInspected':
      return text(o.lastInspectedAt ? formatDateTime(o.lastInspectedAt) : '', 'tabular-nums')
    case 'open':
      return (
        <td key={key} className="px-4 py-3 text-right">
          {o.sessions > 0 && <ChevronRight className="ml-auto h-4 w-4 text-slate-400" />}
        </td>
      )
    default:
      return null
  }
}

export function AccessPage() {
  const navigate = useNavigate()
  const { toast } = useApp()
  // Kept on this device, as on every list in the app.
  const [term, setTerm] = usePersistedState('qc-access:term', '')
  const [machine, setMachine] = usePersistedState('qc-access:machine', 'all')
  const [factory, setFactory] = usePersistedState('qc-access:factory', 'all')
  const [erpStatus, setErpStatus] = usePersistedState('qc-access:status', 'all')
  const [item, setItem] = usePersistedState('qc-access:item', '')
  const [remaining, setRemaining] = usePersistedState<'all' | 'open' | 'done'>('qc-access:remaining', 'all')
  const [inspected, setInspected] = usePersistedState<'all' | 'yes' | 'no'>('qc-access:inspected', 'all')
  const debounced = useDebounced(term.trim())
  /** Every filter back to how the tab opens the first time. */
  const filtersSet = term !== '' || machine !== 'all' || factory !== 'all' || erpStatus !== 'all' || item !== '' || remaining !== 'all' || inspected !== 'all'
  const resetFilters = () => {
    setTerm('')
    setMachine('all')
    setFactory('all')
    setErpStatus('all')
    setItem('')
    setRemaining('all')
    setInspected('all')
  }
  const settledItem = useDebounced(itemTermOf(item))
  const filters = useMemo<OrderListFilters>(
    () => ({
      q: debounced || undefined,
      workCenterCode: machine === 'all' ? undefined : machine,
      factory: factory === 'all' ? undefined : factory,
      erpStatus: erpStatus === 'all' ? undefined : erpStatus,
      item: settledItem || undefined,
      remaining: remaining === 'all' ? undefined : remaining,
      inspected: inspected === 'all' ? undefined : inspected,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [debounced, machine, factory, erpStatus, settledItem, remaining, inspected],
  )
  const { data, isLoading, isError } = useOrderList(filters)
  const { data: options } = useOrderListOptions()
  const { data: machines = [] } = useMaster('machines')
  const machineName = (code: string) => machines.find((m) => m.code === code)?.displayName ?? (code ? `Machine ${code}` : '')
  const grid = useResizableColumns('qc-access:grid', ACCESS_COLUMNS)

  // Pages past the first, appended; forgotten when the filters change.
  const [more, setMore] = useState<OrderListRow[]>([])
  const [moreHasMore, setMoreHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  useEffect(() => {
    setMore([])
    setMoreHasMore(false)
  }, [filters])
  const rows = useMemo(() => {
    const first = data?.orders ?? []
    const seen = new Set(first.map((o) => o.id))
    return [...first, ...more.filter((o) => !seen.has(o.id))]
  }, [data, more])
  const hasMore = more.length > 0 ? moreHasMore : (data?.hasMore ?? false)

  const showMore = async () => {
    setLoadingMore(true)
    try {
      const page = await loadMoreOrders(filters, rows.length)
      setMore((m) => [...m, ...page.orders])
      setMoreHasMore(page.hasMore)
    } catch {
      toast('More lines could not be loaded.', 'error')
    } finally {
      setLoadingMore(false)
    }
  }

  const filtering = !!(debounced || machine !== 'all' || factory !== 'all' || erpStatus !== 'all' || item.trim() || remaining !== 'all' || inspected !== 'all')
  const clear = () => {
    setTerm('')
    setMachine('all')
    setFactory('all')
    setErpStatus('all')
    setItem('')
    setRemaining('all')
    setInspected('all')
  }
  /** A line that has been inspected opens History on its order number. */
  const open = (o: OrderListRow) => {
    if (o.sessions > 0) navigate(`/history?q=${encodeURIComponent(o.orderNumber)}`)
  }

  return (
    <div className="space-y-5">
      <Card className="space-y-3 p-4">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Order, line key, item, item code, customer, drawing or machine…"
            className="min-h-[52px] pl-9 pr-10 text-base"
            aria-label="Search orders"
          />
          {term && (
            <button type="button" onClick={() => setTerm('')} aria-label="Clear search" className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-slate-400 hover:text-slate-600">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Field label="Machine">
            <Select value={machine} onChange={(e) => setMachine(e.target.value)} className="min-h-[48px]">
              <option value="all">All machines</option>
              {(options?.workCenterCodes ?? []).map((code) => (
                <option key={code} value={code}>
                  {machineName(code)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Factory">
            <Select value={factory} onChange={(e) => setFactory(e.target.value)} className="min-h-[48px]">
              <option value="all">All factories</option>
              {(options?.factories ?? []).map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="ERP status">
            <Select value={erpStatus} onChange={(e) => setErpStatus(e.target.value)} className="min-h-[48px]">
              <option value="all">All statuses</option>
              {(options?.erpStatuses ?? []).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Item">
            {/* Any part of a code or a name narrows as it is typed; the list offers the sheet's items for completion. */}
            <Input
              list="access-items"
              value={item}
              onChange={(e) => setItem(e.target.value)}
              placeholder="Any part of a code or name"
              className="min-h-[48px]"
              aria-label="Item"
            />
            <datalist id="access-items">
              {(options?.items ?? []).map((i) => (
                <option key={i.itemCode} value={`${i.itemCode} — ${i.item}`} />
              ))}
            </datalist>
          </Field>
          <Field label="Remaining">
            <Select value={remaining} onChange={(e) => setRemaining(e.target.value as 'all' | 'open' | 'done')} className="min-h-[48px]">
              <option value="all">All lines</option>
              <option value="open">Still to produce</option>
              <option value="done">Finished</option>
            </Select>
          </Field>
          <Field label="Inspected">
            <Select value={inspected} onChange={(e) => setInspected(e.target.value as 'all' | 'yes' | 'no')} className="min-h-[48px]">
              <option value="all">All lines</option>
              <option value="yes">Inspected</option>
              <option value="no">Not inspected yet</option>
            </Select>
          </Field>
        </div>
        <div className="flex justify-end">
          <Button className="min-h-[40px]" onClick={resetFilters} disabled={!filtersSet} aria-label="Reset all filters">
            <RotateCcw className="h-4 w-4" /> Reset all
          </Button>
        </div>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {data ? (
            <>
              <span className="font-semibold text-slate-700 dark:text-slate-200">{rows.length.toLocaleString()}</span> of{' '}
              <span className="font-semibold text-slate-700 dark:text-slate-200">{data.total.toLocaleString()}</span> line{data.total === 1 ? '' : 's'}
              {filtering ? (data.total === 1 ? ' matches the filters' : ' match the filters') : ' on the sheet'}
            </>
          ) : (
            'Loading…'
          )}
          {filtering && (
            <button type="button" onClick={clear} className="ml-2 font-semibold text-brand-700 hover:underline dark:text-brand-300">
              Clear filters
            </button>
          )}
        </p>
        <div className="hidden gap-2 md:flex">
          <FitColumnsButton grid={grid} />
          <ColumnPicker grid={grid} />
        </div>
      </div>

      {isError ? (
        <Card className="p-6">
          <EmptyState icon={<Table2 className="h-10 w-10" />} title="The sheet could not be loaded" hint="Check the connection and try again." />
        </Card>
      ) : !isLoading && rows.length === 0 ? (
        <Card className="p-6">
          <EmptyState
            icon={<Table2 className="h-10 w-10" />}
            title={filtering ? 'No line matches' : 'No order lines yet'}
            hint={filtering ? 'Widen the filters or clear them.' : 'An administrator imports the ERP sheet under Data import.'}
            action={filtering ? <Button onClick={clear}>Clear filters</Button> : undefined}
          />
        </Card>
      ) : (
        <>
          {/* Phone: one card per line. */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:hidden">
            {rows.map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => open(o)}
                className={cn('card p-4 text-left', o.sessions > 0 ? 'card-hover' : 'cursor-default')}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0">
                    <span className="block truncate font-bold">{o.orderNumber}</span>
                    <span className="block truncate text-sm text-brand-600 dark:text-brand-400">{o.item || '—'}</span>
                  </span>
                  {o.erpStatus && <Badge tone={statusTone(o.erpStatus)}>{o.erpStatus}</Badge>}
                </div>
                <p className="mt-1 truncate text-xs text-slate-500">
                  {o.itemCode || '—'} · {machineName(o.workCenterCode) || '—'} · {o.customer || '—'}
                </p>
                <p className="mt-2 text-xs tabular-nums text-slate-500">
                  Required {num(o.requiredQty)} · Finished {num(o.finishedQty)} · <span className={cn(o.remainingQty > 0 && 'font-semibold text-brand-700 dark:text-brand-300')}>Remaining {num(o.remainingQty)}</span>
                  {o.sessions > 0 ? ` · ${o.sessions} inspection${o.sessions === 1 ? '' : 's'}` : ''}
                </p>
              </button>
            ))}
          </div>

          {/* md+ — the sheet as a table; the columns are the reader's to choose and, on a desktop, to size. */}
          <Card className="hidden overflow-hidden md:block">
            <GridFrame>
              <table ref={grid.tableRef} className={cn('w-full text-sm', !grid.enabled && 'min-w-[900px]')} style={grid.tableStyle}>
                {grid.colgroup}
                <thead>
                  <tr className="border-b border-slate-100 text-left text-xs font-bold uppercase tracking-wide text-slate-400 dark:border-slate-800">
                    {grid.visible.map((c) => (
                      // The cell stays overflow-visible so the grab zone can straddle its edge; only the label is clipped.
                      <th key={c.key} data-col={c.key} className={cn('px-4 py-3', c.align === 'right' && 'text-right', grid.dragging === c.key && '!bg-brand-50 dark:!bg-brand-950')} title={grid.enabled && c.label ? c.label : undefined}>
                        <span className={cn(grid.enabled && 'block truncate')}>{c.label}</span>
                        {c.hideable !== false && grid.handle(c.key)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {rows.map((o) => (
                    <tr
                      key={o.id}
                      onClick={() => open(o)}
                      className={cn('transition-colors', o.sessions > 0 ? 'cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50' : '', o.erpStatus.trim().toLowerCase() === 'cancel' && 'text-slate-400')}
                      title={o.sessions > 0 ? 'Open its inspections in History' : undefined}
                    >
                      {grid.visible.map((c) => cell(c.key, o, grid.enabled, machineName))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </GridFrame>
          </Card>

          {hasMore && (
            <div className="flex justify-center pt-1">
              <Button className="min-h-[48px]" onClick={() => void showMore()} disabled={loadingMore}>
                {loadingMore ? 'Loading…' : 'Show more lines'}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
