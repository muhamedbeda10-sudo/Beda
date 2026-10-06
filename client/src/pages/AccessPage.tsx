// ============================================================================
// §19 — Access: the ERP order sheet as it was uploaded, as one table anyone
// can browse. Every filter runs in SQL over the whole sheet, so a line is
// found wherever it sits; the columns are the reader's to choose and to
// size, as in History. A line with inspections opens History on it.
// ============================================================================

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronRight, Table2 } from 'lucide-react'
import type { OrderListFilters, OrderListRow } from '@qc/shared/api'
import { Badge, Button, Card, EmptyState, Field, Input, Select } from '@/components/ui'
import { SessionGroupModal, type GroupSpec } from '@/components/history/SessionGroupModal'
import { FilterBar, FilterSelect, HeaderStat, PageHeader, type FilterChip } from '@/components/ui/PageShell'
import { ColumnPicker, GridFrame, GridHead, SkeletonRows, TableFooter, useResizableColumns, type ColumnDef } from '@/components/ui/ResizableColumns'
import { loadMoreOrders, useDebounced, useMaster, useOrderList, useOrderListOptions } from '@/services/queries'
import { usePersistedState } from '@/lib/usePersistedState'
import { useApp } from '@/store/AppContext'
import { cn, formatDate, formatDateTime } from '@/lib/utils'
import { sessionDetailPath } from '@/lib/links'

const ACCESS_COLUMNS: ColumnDef[] = [
  { key: 'orderNumber', label: 'Order', width: 150, min: 90 },
  { key: 'lineKey', label: 'Line key', width: 110, min: 70, defaultHidden: true },
  { key: 'item', label: 'Item', width: 220, min: 100, flex: true },
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
/** Any part of a code or a name; a pick from the list ("code — name") is that one item, even where two share a code. */
const itemTermOf = (typed: string) => typed.trim()

function statusTone(s: string): 'green' | 'amber' | 'violet' | 'neutral' | 'red' {
  const v = s.trim().toLowerCase()
  if (v === 'active') return 'green'
  if (v === 'hold') return 'amber'
  if (v === 'stock') return 'violet'
  if (v === 'cancel' || v === 'cancelled') return 'red'
  return 'neutral'
}

/** What a cell opens: the order, the line, the item or the machine, laid on their sessions. */
interface Opens {
  order: (o: OrderListRow) => void
  line: (o: OrderListRow) => void
  item: (o: OrderListRow) => void
  machine: (o: OrderListRow) => void
}

/** A cell's text as a link to a grouped view; the row's own click is not triggered. */
function Opener({ onOpen, title, children }: { onOpen: () => void; title: string; children: ReactNode }) {
  return (
    <button
      type="button"
      data-tip={title}
      onClick={(e) => {
        e.stopPropagation()
        onOpen()
      }}
      className="max-w-full truncate text-left decoration-brand-500 underline-offset-4 hover:text-brand-700 hover:underline dark:hover:text-brand-300"
    >
      {children}
    </button>
  )
}

function cell(key: string, o: OrderListRow, fixed: boolean, machineName: (code: string) => string, opens: Opens): ReactNode {
  const clip = fixed ? 'truncate' : ''
  const text = (value: string, extra = '') => (
    <td key={key} className={cn('px-3 py-3', extra, clip)} data-tip={value || undefined}>
      {value || '—'}
    </td>
  )
  // A zero is there to be read past: muted, so the figures that are not zero stand out.
  const number = (value: number | null | undefined, extra = '') => (
    <td key={key} className={cn('px-3 py-3 text-right tabular-nums', extra, value === 0 && 'text-muted')}>
      {num(value)}
    </td>
  )
  switch (key) {
    case 'orderNumber':
      return (
        <td key={key} className={cn('px-3 py-3 font-bold', clip)} data-tip={o.orderNumber}>
          <Opener title="Every session of this order" onOpen={() => opens.order(o)}>{o.orderNumber}</Opener>
        </td>
      )
    case 'lineKey':
      return text(o.lineKey, 'font-mono text-xs')
    case 'item':
      return (
        <td key={key} className={cn('px-3 py-3', fixed ? 'truncate' : 'max-w-[240px] truncate')} data-tip={o.item}>
          {o.item ? <Opener title="Every session of this item" onOpen={() => opens.item(o)}>{o.item}</Opener> : '—'}
        </td>
      )
    case 'itemCode':
      return o.itemCode ? (
        <td key={key} className={cn('px-3 py-3 font-mono text-xs', clip)} data-tip={o.itemCode}>
          <Opener title="Every session of this item" onOpen={() => opens.item(o)}>{o.itemCode}</Opener>
        </td>
      ) : (
        text('', 'font-mono text-xs')
      )
    case 'machine':
      return o.workCenterCode ? (
        <td key={key} className={cn('px-3 py-3', clip)} data-tip={machineName(o.workCenterCode)}>
          <Opener title="The latest sessions on this machine" onOpen={() => opens.machine(o)}>{machineName(o.workCenterCode)}</Opener>
        </td>
      ) : (
        text('')
      )
    case 'factory':
      return text(o.factory)
    case 'erpStatus':
      return (
        <td key={key} className="px-3 py-3">
          {o.erpStatus ? <Badge tone={statusTone(o.erpStatus)}>{o.erpStatus}</Badge> : '—'}
        </td>
      )
    case 'requiredQty':
      return number(o.requiredQty)
    case 'finishedQty':
      return number(o.finishedQty)
    case 'remainingQty':
      return number(o.remainingQty, o.remainingQty > 0 ? 'font-semibold text-brand-700 dark:text-brand-300' : 'text-muted')
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
      return o.sessions > 0 ? (
        <td key={key} className="px-3 py-3 text-right font-semibold tabular-nums">
          <Opener title="This line's sessions" onOpen={() => opens.line(o)}>{num(o.sessions)}</Opener>
        </td>
      ) : (
        number(o.sessions, 'text-muted')
      )
    case 'samples':
      return number(o.samples, o.samples > 0 ? '' : 'text-muted')
    case 'defectPieces':
      return o.defectPieces > 0 ? (
        <td key={key} className="px-3 py-3 text-right font-bold tabular-nums text-rose-600 dark:text-rose-400">
          <Opener title="This line's sessions" onOpen={() => opens.line(o)}>{num(o.defectPieces)}</Opener>
        </td>
      ) : (
        number(o.defectPieces, 'text-muted')
      )
    case 'lastInspected':
      return text(o.lastInspectedAt ? formatDateTime(o.lastInspectedAt) : '', 'tabular-nums')
    case 'open':
      return (
        <td key={key} className="px-3 py-3 text-right">
          {o.sessions > 0 && <ChevronRight className="ml-auto h-4 w-4 text-muted opacity-0 transition-opacity group-hover:opacity-100" />}
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
  /** Rows a page brings; kept on this device. */
  const [pageSize, setPageSize] = usePersistedState<number>('qc-access:page-size', 100)
  const { data, isLoading, isError, refetch } = useOrderList(filters, pageSize)
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
      const page = await loadMoreOrders(filters, rows.length, pageSize)
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
  // §6 — the grouped views, as in History: the order whole, one line, an item or a machine, with every session behind them.
  const [groupSpec, setGroupSpec] = useState<GroupSpec | null>(null)
  const [groupOrder, setGroupOrder] = useState<string | null>(null)
  const opens: Opens = {
    order: (o) => {
      setGroupOrder(o.orderNumber)
      setGroupSpec({ title: `Order ${o.orderNumber}`, subtitle: `${o.customer ? `${o.customer} · ` : ''}every session of the order, on every item and machine`, query: { orderNumber: o.orderNumber } })
    },
    line: (o) => {
      setGroupOrder(o.orderNumber)
      setGroupSpec({ title: `${o.orderNumber} · ${o.item}`, subtitle: `${machineName(o.workCenterCode)} · this line's sessions`, query: { orderId: o.id } })
    },
    item: (o) => {
      setGroupOrder(null)
      setGroupSpec({ title: o.item, subtitle: `${o.itemCode ? `${o.itemCode} · ` : ''}every order it was inspected on, the latest first`, query: o.itemCode ? { itemCode: o.itemCode, itemName: o.item || undefined } : { item: o.item } })
    },
    machine: (o) => {
      setGroupOrder(null)
      setGroupSpec({ title: machineName(o.workCenterCode), subtitle: 'The latest sessions on the machine', query: { workCenterCode: o.workCenterCode } })
    },
  }
  /** A line that has been inspected opens its order's sessions. */
  const open = (o: OrderListRow) => {
    if (o.sessions > 0) opens.order(o)
  }

  const machineLabel = (code: string) => machineName(code) || code
  const chips: FilterChip[] = [
    ...(machine !== 'all' ? [{ key: 'machine', label: `Machine: ${machineLabel(machine)}`, onRemove: () => setMachine('all') }] : []),
    ...(erpStatus !== 'all' ? [{ key: 'status', label: `ERP status: ${erpStatus}`, onRemove: () => setErpStatus('all') }] : []),
    ...(remaining !== 'all' ? [{ key: 'remaining', label: remaining === 'open' ? 'Still to produce' : 'Finished', onRemove: () => setRemaining('all') }] : []),
    ...(factory !== 'all' ? [{ key: 'factory', label: `Factory: ${factory}`, onRemove: () => setFactory('all') }] : []),
    ...(item.trim() ? [{ key: 'item', label: `Item: ${item.trim()}`, onRemove: () => setItem('') }] : []),
    ...(inspected !== 'all' ? [{ key: 'inspected', label: inspected === 'yes' ? 'Inspected' : 'Not inspected yet', onRemove: () => setInspected('all') }] : []),
  ]
  const moreCount = [factory !== 'all', item.trim() !== '', inspected !== 'all'].filter(Boolean).length

  return (
    <div className="space-y-3">
      <PageHeader
        title="Access"
        stats={
          data ? (
            <>
              <HeaderStat value={data.total} label={data.total === 1 ? 'line' : 'lines'} />
              <span>{filtering ? (data.total === 1 ? 'matches the filters' : 'match the filters') : 'on the sheet'}</span>
            </>
          ) : (
            <span>Loading…</span>
          )
        }
        actions={
          <span className="hidden md:inline-flex">
            <ColumnPicker grid={grid} />
          </span>
        }
      />

      <FilterBar
        search={{ value: term, onChange: setTerm, placeholder: 'Order, line key, item, item code, customer, drawing or machine…', label: 'Search orders' }}
        filters={
          <>
            <FilterSelect label="Machine" value={machine} onChange={setMachine}>
              <option value="all">All machines</option>
              {(options?.workCenterCodes ?? []).map((code) => (
                <option key={code} value={code}>
                  {machineName(code)}
                </option>
              ))}
            </FilterSelect>
            <FilterSelect label="ERP status" value={erpStatus} onChange={setErpStatus}>
              <option value="all">All ERP statuses</option>
              {(options?.erpStatuses ?? []).map((st) => (
                <option key={st} value={st}>
                  {st}
                </option>
              ))}
            </FilterSelect>
            <FilterSelect label="Remaining" value={remaining} onChange={(v) => setRemaining(v as 'all' | 'open' | 'done')}>
              <option value="all">All lines</option>
              <option value="open">Still to produce</option>
              <option value="done">Finished</option>
            </FilterSelect>
          </>
        }
        more={
          <>
            <Field label="Factory">
              <Select value={factory} onChange={(e) => setFactory(e.target.value)} className="h-10 py-0 text-sm">
                <option value="all">All factories</option>
                {(options?.factories ?? []).map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Item">
              {/* Any part of a code or a name narrows as it is typed; the list offers the sheet's items for completion. */}
              <Input list="access-items" value={item} onChange={(e) => setItem(e.target.value)} placeholder="Any part of a code or name" className="h-10 py-0 text-sm" aria-label="Item" />
              <datalist id="access-items">
                {(options?.items ?? []).map((i) => (
                  <option key={`${i.itemCode}|${i.item}`} value={`${i.itemCode} — ${i.item}`} />
                ))}
              </datalist>
            </Field>
            <Field label="Inspected">
              <Select value={inspected} onChange={(e) => setInspected(e.target.value as 'all' | 'yes' | 'no')} className="h-10 py-0 text-sm">
                <option value="all">All lines</option>
                <option value="yes">Inspected</option>
                <option value="no">Not inspected yet</option>
              </Select>
            </Field>
          </>
        }
        moreCount={moreCount}
        chips={chips}
        onReset={resetFilters}
        canReset={filtersSet}
      />

      {isError && !data ? (
        <Card className="p-6">
          <EmptyState icon={<Table2 className="h-10 w-10" />} title="The sheet could not be loaded" hint="Check the connection and try again." action={<Button onClick={() => void refetch()}>Try again</Button>} />
        </Card>
      ) : isLoading && rows.length === 0 ? (
        <Card className="overflow-hidden">
          <GridFrame>
            <table className="sticky-first w-full text-sm" style={grid.tableStyle}>
              {grid.colgroup}
              <GridHead grid={grid} />
              <SkeletonRows grid={grid} />
            </table>
          </GridFrame>
        </Card>
      ) : rows.length === 0 ? (
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
                <p className="mt-1 truncate text-xs text-muted">
                  {o.itemCode || '—'} · {machineName(o.workCenterCode) || '—'} · {o.customer || '—'}
                </p>
                <p className="mt-2 text-xs tabular-nums text-muted">
                  Required {num(o.requiredQty)} · Finished {num(o.finishedQty)} · <span className={cn(o.remainingQty > 0 && 'font-semibold text-brand-700 dark:text-brand-300')}>Remaining {num(o.remainingQty)}</span>
                  {o.sessions > 0 ? ` · ${o.sessions} inspection${o.sessions === 1 ? '' : 's'}` : ''}
                </p>
              </button>
            ))}
          </div>

          {/* md+ — the sheet as a table; the columns are the reader's to choose and, on a desktop, to size. */}
          <Card className="hidden overflow-hidden md:block">
            <GridFrame reserve={44}>
              <table ref={grid.tableRef} className={cn('sticky-first w-full text-sm', !grid.enabled && 'min-w-[900px]')} style={grid.tableStyle}>
                {grid.colgroup}
                <GridHead grid={grid} />
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {rows.map((o) => (
                    <tr
                      key={o.id}
                      onClick={() => open(o)}
                      // A line that was inspected opens its order's sessions; a cancelled line reads muted, its figures as they are.
                      className={cn(
                        'data-row group bg-white transition-colors dark:bg-slate-900',
                        o.sessions > 0 && 'cursor-pointer hover:bg-slate-50 dark:hover:bg-[#17202f]',
                        ['cancel', 'cancelled'].includes(o.erpStatus.trim().toLowerCase()) && 'text-muted',
                      )}
                    >
                      {grid.visible.map((c) => cell(c.key, o, grid.enabled, machineName, opens))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </GridFrame>
          </Card>

          <TableFooter
            shown={rows.length}
            total={data?.total ?? null}
            noun={data?.total === 1 ? 'line' : 'lines'}
            hasMore={hasMore}
            loadingMore={loadingMore}
            onMore={() => void showMore()}
            pageSize={pageSize}
            onPageSize={setPageSize}
          />
        </>
      )}

      <SessionGroupModal
        spec={groupSpec}
        onClose={() => setGroupSpec(null)}
        onOpenSession={(id) => navigate(sessionDetailPath(id))}
        footer={
          groupOrder !== null ? (
            <Button onClick={() => navigate(`/history?q=${encodeURIComponent(groupOrder)}`)}>
              Open in History <ChevronRight className="h-4 w-4" />
            </Button>
          ) : undefined
        }
      />
    </div>
  )
}
