// ============================================================================
// §19 — Access: the ERP order sheet as it was uploaded, as one table anyone
// can browse. Every filter runs in SQL over the whole sheet, so a line is
// found wherever it sits; the columns are the reader's to choose and to
// size, as in History. A line with inspections opens History on it.
// ============================================================================

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, ChevronRight, Table2 } from 'lucide-react'
import { orderLineProblems } from '@qc/shared/rules'
import { ORDER_DETAIL_FIELDS, type OrderDetailKey } from '@qc/shared/orderImport'
import type { OrderListFilters, OrderListRow } from '@qc/shared/api'
import { Badge, Button, Card, EmptyState, Field, Input, Select } from '@/components/ui'
import { SessionGroupModal, type GroupSpec } from '@/components/history/SessionGroupModal'
import { FilterBar, FilterSelect, type FilterChip } from '@/components/ui/PageShell'
import { ColumnPicker, GridFrame, GridHead, SkeletonRows, TableFooter, TABLE_QUERY, useResizableColumns, type ColumnDef } from '@/components/ui/ResizableColumns'
import { loadMoreOrders, loadOrderListValues, useDebounced, useMaster, useOrderList, useOrderListOptions } from '@/services/queries'
import { useServerColumns } from '@/components/ui/ColumnFilter'
import { matchesMedia, useCoarsePointer, useMediaQuery } from '@/lib/media'
import { usePersistedState } from '@/lib/usePersistedState'
import { useApp } from '@/store/AppContext'
import { cn, formatDate, formatDateTime, formatDay } from '@/lib/utils'
import { sessionDetailPath } from '@/lib/links'

/**
 * The sheet's columns. A screen narrower than 1180 px starts with the lean set — the order, the item, its ERP status,
 * what remains to produce, the customer and the order's date — so a tablet held upright sees Remaining without
 * scrolling; the Columns button adds the rest. From 1180 px (an iPad Air on its side) the everyday set fits the frame
 * up to Remaining.
 */
const ACCESS_COLUMNS: ColumnDef[] = [
  { key: 'orderNumber', label: 'Order', width: 150, min: 90, lean: true },
  { key: 'lineKey', label: 'Line key', width: 110, min: 70, defaultHidden: true },
  { key: 'item', label: 'Item', width: 200, min: 100, flex: true, lean: true },
  { key: 'itemCode', label: 'Item code', width: 120, min: 80 },
  { key: 'machine', label: 'Machine', width: 150, min: 80 },
  { key: 'factory', label: 'Factory', width: 110, min: 80, defaultHidden: true },
  { key: 'erpStatus', label: 'ERP status', width: 100, min: 80, lean: true },
  { key: 'requiredQty', label: 'Required', width: 124, min: 96, align: 'right' },
  { key: 'finishedQty', label: 'Finished', width: 124, min: 96, align: 'right' },
  { key: 'remainingQty', label: 'Remaining', width: 124, min: 96, align: 'right', lean: true },
  { key: 'customer', label: 'Customer', width: 170, min: 90, lean: true },
  { key: 'expectedGrade', label: 'Expected grade', width: 120, min: 80 },
  { key: 'drawing', label: 'Drawing', width: 130, min: 80, defaultHidden: true },
  { key: 'drawingAlt', label: 'Drawing (alt)', width: 130, min: 80, defaultHidden: true },
  { key: 'material', label: 'Material', width: 120, min: 80, defaultHidden: true },
  { key: 'type', label: 'Type', width: 100, min: 64, defaultHidden: true },
  { key: 'colour', label: 'Colour', width: 100, min: 64, defaultHidden: true },
  { key: 'date', label: 'Order date', width: 120, min: 90, lean: true },
  { key: 'sessions', label: 'Sessions', width: 116, min: 96, align: 'right', defaultHidden: true },
  { key: 'samples', label: 'Samples', width: 116, min: 96, align: 'right', defaultHidden: true },
  { key: 'defectPieces', label: 'Defect pcs', width: 104, min: 80, align: 'right', defaultHidden: true },
  { key: 'lastInspected', label: 'Last inspected', width: 150, min: 90, defaultHidden: true },
  // §7.7.1 — the ERP's further columns, hidden until the reader picks them from Columns.
  ...ORDER_DETAIL_FIELDS.map(
    (f): ColumnDef =>
      f.kind === 'number'
        ? { key: f.key, label: f.label, width: 124, min: 80, align: 'right', defaultHidden: true }
        : f.kind === 'day'
          ? { key: f.key, label: f.label, width: 120, min: 90, defaultHidden: true }
          : { key: f.key, label: f.label, width: 150, min: 80, defaultHidden: true },
  ),
  { key: 'open', label: '', width: 48, min: 40, hideable: false },
]

/** The ERP details by key, for their cells. */
const DETAIL_KIND = new Map<string, (typeof ORDER_DETAIL_FIELDS)[number]['kind']>(ORDER_DETAIL_FIELDS.map((f) => [f.key, f.kind]))

/** The columns that hold figures, and those that hold days: they sort as such, and a day reads "Oct 6" in its menu. */
const ACCESS_FIGURES = new Set([
  'requiredQty', 'finishedQty', 'remainingQty', 'sessions', 'samples', 'defectPieces',
  ...ORDER_DETAIL_FIELDS.filter((f) => f.kind === 'number').map((f) => f.key),
])
const ACCESS_DAYS = new Set(['date', 'lastInspected'])
/** Calendar days with no time zone (the ERP's due, planned and shipping days): never shifted by the device's zone. */
const ACCESS_PLAIN_DAYS = new Set<string>(ORDER_DETAIL_FIELDS.filter((f) => f.kind === 'day').map((f) => f.key))

/**
 * Below a tablet the sheet is cards and the column menus are out of reach: the sorts a phone wants most, sent as a
 * column's menu would send them. No pick is the sheet's own order, by order number.
 */
const PHONE_SORTS: { value: string; label: string }[] = [
  { value: 'remainingQty:desc', label: 'Most remaining' },
  { value: 'date:desc', label: 'Newest order date' },
  { value: 'date:asc', label: 'Oldest order date' },
]

/** Below a tablet: the phone's cards, 50 to a page unless the person chose otherwise. */
const PHONE = `not all and ${TABLE_QUERY}`

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

/**
 * What a cell opens: the order, the line, the item or the machine, laid on their sessions. `links` is false on a touch
 * screen: a cell's text is then plain, and the whole row opens the order's sessions.
 */
interface Opens {
  order: (o: OrderListRow) => void
  line: (o: OrderListRow) => void
  item: (o: OrderListRow) => void
  machine: (o: OrderListRow) => void
  links: boolean
}

/**
 * A cell's text as a link to a grouped view; the row's own click is not triggered. `plain` on a touch screen: the
 * text alone, so a tap anywhere on the row does the one thing the row does, as nothing on screen marks a link apart.
 */
function Opener({ onOpen, title, children, plain = false }: { onOpen: () => void; title: string; children: ReactNode; plain?: boolean }) {
  if (plain) return <>{children}</>
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

/** The mark on a line the order sheet got wrong; its tooltip says what. */
function ProblemMark({ problems }: { problems: string[] }) {
  const text = `Check this line on the order sheet:\n${problems.join('\n')}`
  return (
    <span role="img" aria-label={text} data-tip={text} className="inline-grid h-5 w-5 shrink-0 place-items-center rounded text-amber-600 dark:text-amber-400">
      <AlertTriangle className="h-4 w-4" />
    </span>
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
    case 'orderNumber': {
      // A line the sheet got wrong is marked, never hidden: the mark says what to correct on the sheet.
      const problems = orderLineProblems(o)
      return (
        <td key={key} className={cn('px-3 py-3 font-bold', clip)} data-tip={problems.length ? undefined : o.orderNumber}>
          <span className="flex min-w-0 items-center gap-1.5">
            {problems.length > 0 && <ProblemMark problems={problems} />}
            <Opener title="Every session of this order" plain={!opens.links} onOpen={() => opens.order(o)}>
              {o.orderNumber}
            </Opener>
          </span>
        </td>
      )
    }
    case 'lineKey':
      return text(o.lineKey, 'font-mono text-xs')
    case 'item':
      return (
        <td key={key} className={cn('px-3 py-3', fixed ? 'truncate' : 'max-w-[240px] truncate')} data-tip={o.item}>
          {o.item ? (
            <Opener title="Every session of this item" plain={!opens.links} onOpen={() => opens.item(o)}>
              {o.item}
            </Opener>
          ) : (
            '—'
          )}
        </td>
      )
    case 'itemCode':
      return o.itemCode ? (
        <td key={key} className={cn('px-3 py-3 font-mono text-xs', clip)} data-tip={o.itemCode}>
          <Opener title="Every session of this item" plain={!opens.links} onOpen={() => opens.item(o)}>
            {o.itemCode}
          </Opener>
        </td>
      ) : (
        text('', 'font-mono text-xs')
      )
    case 'machine':
      return o.workCenterCode ? (
        <td key={key} className={cn('px-3 py-3', fixed ? 'truncate' : 'max-w-[200px] truncate')} data-tip={machineName(o.workCenterCode)}>
          <Opener title="The latest sessions on this machine" plain={!opens.links} onOpen={() => opens.machine(o)}>
            {machineName(o.workCenterCode)}
          </Opener>
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
          <Opener title="This line's sessions" plain={!opens.links} onOpen={() => opens.line(o)}>
            {num(o.sessions)}
          </Opener>
        </td>
      ) : (
        number(o.sessions, 'text-muted')
      )
    case 'samples':
      return number(o.samples, o.samples > 0 ? '' : 'text-muted')
    case 'defectPieces':
      return o.defectPieces > 0 ? (
        <td key={key} className="px-3 py-3 text-right font-bold tabular-nums text-rose-600 dark:text-rose-400">
          <Opener title="This line's sessions" plain={!opens.links} onOpen={() => opens.line(o)}>
            {num(o.defectPieces)}
          </Opener>
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
    default: {
      const kind = DETAIL_KIND.get(key)
      if (!kind) return null
      const v = o[key as OrderDetailKey]
      if (kind === 'number') return number(typeof v === 'number' ? v : null)
      if (kind === 'day') return text(typeof v === 'string' ? formatDay(v) : '', 'tabular-nums')
      return text(typeof v === 'string' ? v : '')
    }
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
  const baseFiltersSet = term !== '' || machine !== 'all' || factory !== 'all' || erpStatus !== 'all' || item !== '' || remaining !== 'all' || inspected !== 'all'
  // Excel's filter and sort on every column, answered over the whole sheet.
  const columnsView = useServerColumns()
  /** A phone's pick from Sort by (PHONE_SORTS), in place of a column's sort it cannot reach; the latest of the two wins. */
  const [phoneSort, setPhoneSort] = useState<string | null>(null)
  useEffect(() => {
    if (columnsView.sortParam) setPhoneSort(null)
  }, [columnsView.sortParam])
  const sortParam = columnsView.sortParam ?? phoneSort ?? undefined
  const coarse = useCoarsePointer()
  const wide = useMediaQuery('(min-width: 1280px)')
  const resetFilters = () => {
    columnsView.clear()
    setPhoneSort(null)
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
      cf: columnsView.cf,
      sort: sortParam,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [debounced, machine, factory, erpStatus, settledItem, remaining, inspected, columnsView.cf, sortParam],
  )
  const filtersSet = baseFiltersSet || columnsView.active || phoneSort !== null
  /** Rows a page brings; kept on this device. A phone starts at 50: a hundred cards make a page too long to reach the paging. */
  const [pageSize, setPageSize] = usePersistedState<number>('qc-access:page-size', matchesMedia(PHONE) ? 50 : 100)
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
  /** Lines on screen the order sheet got wrong, marked in the table. */
  const toCheck = useMemo(() => rows.filter((o) => orderLineProblems(o).length > 0).length, [rows])

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

  const filtering = !!(debounced || machine !== 'all' || factory !== 'all' || erpStatus !== 'all' || item.trim() || remaining !== 'all' || inspected !== 'all' || columnsView.cf)
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
    links: !coarse,
  }
  /** A line that has been inspected opens its order's sessions. */
  const open = (o: OrderListRow) => {
    if (o.sessions > 0) opens.order(o)
  }

  const machineLabel = (code: string) => machineName(code) || code
  const columnChips = columnsView.chips((key) => ACCESS_COLUMNS.find((c) => c.key === key)?.label ?? key)
  /** The column sort in force, set with the table on screen (a tablet, a phone on its side): the Sort by select shows it. */
  const columnSortChip = columnChips.find((c) => c.key === 'sort')
  const pickSort = (value: string) => {
    // A column's sort gives way to the pick, as a pick gives way to a column's sort.
    columnSortChip?.onRemove()
    setPhoneSort(value || null)
  }
  const chips: FilterChip[] = [
    ...(machine !== 'all' ? [{ key: 'machine', label: `Machine: ${machineLabel(machine)}`, onRemove: () => setMachine('all') }] : []),
    ...(erpStatus !== 'all' ? [{ key: 'status', label: `ERP status: ${erpStatus}`, onRemove: () => setErpStatus('all') }] : []),
    ...(remaining !== 'all' ? [{ key: 'remaining', label: remaining === 'open' ? 'Still to produce' : 'Finished', onRemove: () => setRemaining('all') }] : []),
    ...(factory !== 'all' ? [{ key: 'factory', label: `Factory: ${factory}`, onRemove: () => setFactory('all') }] : []),
    ...(item.trim() ? [{ key: 'item', label: `Item: ${item.trim()}`, onRemove: () => setItem('') }] : []),
    ...(inspected !== 'all' ? [{ key: 'inspected', label: inspected === 'yes' ? 'Inspected' : 'Not inspected yet', onRemove: () => setInspected('all') }] : []),
    ...columnChips,
    ...(phoneSort ? [{ key: 'phone-sort', label: `Sorted: ${PHONE_SORTS.find((o) => o.value === phoneSort)?.label ?? phoneSort}`, onRemove: () => setPhoneSort(null) }] : []),
  ]
  /** A column's Excel menu: its values over the whole sheet under every other filter. */
  const columnMenu = (c: ColumnDef) =>
    c.key === 'open'
      ? null
      : columnsView.menu(c.key, c.label, (search) => loadOrderListValues(filters, c.key, search), {
          numeric: ACCESS_FIGURES.has(c.key) || ACCESS_DAYS.has(c.key) || ACCESS_PLAIN_DAYS.has(c.key),
          align: c.align === 'right' ? 'right' : 'left',
          formatValue: ACCESS_PLAIN_DAYS.has(c.key) ? (v) => formatDay(v) : ACCESS_DAYS.has(c.key) ? (v) => formatDate(v) : undefined,
        })
  const moreCount = [factory !== 'all', item.trim() !== '', inspected !== 'all'].filter(Boolean).length

  return (
    <div className="space-y-3">
      {/* No title row: the tab names the page; the count is under the list. */}
      <FilterBar
        actions={
          <span className="hidden md:inline-flex">
            <ColumnPicker grid={grid} />
          </span>
        }
        search={{ value: term, onChange: setTerm, placeholder: wide ? 'Order, line key, item, item code, customer, drawing or machine…' : 'Search orders, items, customers…', label: 'Search orders' }}
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
            {/* A phone has no column menus (the sheet is cards): the sorts it needs most, here. */}
            <FilterSelect label="Sort by" value={sortParam ?? ''} onChange={pickSort} className="md:hidden">
              <option value="">Order number</option>
              {PHONE_SORTS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
              {columnsView.sortParam && !PHONE_SORTS.some((o) => o.value === columnsView.sortParam) && <option value={columnsView.sortParam}>{columnSortChip?.label ?? 'Sorted by a column'}</option>}
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
              <GridHead grid={grid} menu={columnMenu} />
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
          {/* Phone: one card per line. A line with inspections is a button that opens them, with a chevron to say so; one
              without is plain text that says it was not inspected yet, since a finger gets no hover to tell them apart. */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:hidden">
            {rows.map((o) => {
              const problems = orderLineProblems(o)
              const body = (
                <>
                  <div className="flex items-start justify-between gap-2">
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5 truncate font-bold">
                        {problems.length > 0 && <ProblemMark problems={problems} />}
                        {o.orderNumber}
                      </span>
                      <span className="block truncate text-sm text-brand-600 dark:text-brand-400">{o.item || '—'}</span>
                    </span>
                    {o.erpStatus && <Badge tone={statusTone(o.erpStatus)}>{o.erpStatus}</Badge>}
                  </div>
                  <p className="mt-1 truncate text-xs text-muted">
                    {o.itemCode || '—'} · {machineName(o.workCenterCode) || '—'} · {o.customer || '—'}
                  </p>
                  <div className="mt-2 flex items-end gap-2">
                    <p className="min-w-0 flex-1 text-xs tabular-nums text-muted">
                      Required {num(o.requiredQty)} · Finished {num(o.finishedQty)} · <span className={cn(o.remainingQty > 0 && 'font-semibold text-brand-700 dark:text-brand-300')}>Remaining {num(o.remainingQty)}</span>
                      {o.sessions > 0 ? ` · ${o.sessions} inspection${o.sessions === 1 ? '' : 's'}` : <span className="block pt-0.5">Not inspected yet</span>}
                    </p>
                    {o.sessions > 0 && <ChevronRight className="h-5 w-5 shrink-0 text-muted" aria-hidden />}
                  </div>
                  {problems.length > 0 && <p className="mt-1.5 text-xs font-semibold text-amber-700 dark:text-amber-400">{problems.join(' ')} Check it on the order sheet.</p>}
                </>
              )
              return o.sessions > 0 ? (
                <button key={o.id} type="button" onClick={() => open(o)} className="card-hover min-w-0 p-4 text-left">
                  {body}
                </button>
              ) : (
                <div key={o.id} className="card min-w-0 p-4">
                  {body}
                </div>
              )
            })}
          </div>

          {/* md+ — the sheet as a table; the columns are the reader's to choose and, on a desktop, to size. */}
          <Card className="hidden overflow-hidden md:block">
            <GridFrame>
              <table ref={grid.tableRef} className={cn('sticky-first w-full text-sm', !grid.enabled && 'min-w-[900px]')} style={grid.tableStyle}>
                {grid.colgroup}
                <GridHead grid={grid} menu={columnMenu} />
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {rows.map((o) => (
                    <tr
                      key={o.id}
                      onClick={() => open(o)}
                      // A line that was inspected opens its order's sessions; a cancelled line reads muted, its figures as they are.
                      className={cn(
                        'data-row group transition-colors',
                        // Opaque tints, so the sticky first cell takes the row's colour.
                        orderLineProblems(o).length > 0 ? 'bg-[#fffcf6] dark:bg-[#262527]' : 'bg-white dark:bg-slate-900',
                        o.sessions > 0 && (orderLineProblems(o).length > 0 ? 'cursor-pointer hover:bg-[#fef7d8] dark:hover:bg-[#312b25]' : 'cursor-pointer hover:bg-slate-50 dark:hover:bg-[#17202f]'),
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
            // The phrase reads on from the count, in one run: "1–50 of 1,224 lines on the sheet".
            noun={`${data?.total === 1 ? 'line' : 'lines'} ${filtering ? (data?.total === 1 ? 'matches the filters' : 'match the filters') : 'on the sheet'}`}
            hasMore={hasMore}
            loadingMore={loadingMore}
            onMore={() => void showMore()}
            pageSize={pageSize}
            onPageSize={setPageSize}
            extra={
              toCheck > 0 ? (
                <span className="inline-flex items-center gap-1 font-semibold text-amber-700 dark:text-amber-400" data-tip="Lines the order sheet got wrong: an order numbered 0, or no item name or code. They are marked in the table; correct them on the sheet.">
                  <AlertTriangle className="h-3.5 w-3.5" /> {toCheck} on screen to check on the sheet
                </span>
              ) : undefined
            }
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
