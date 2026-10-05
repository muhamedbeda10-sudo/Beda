import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowLeft,
  ChevronRight,
  ClipboardList,
  Droplets,
  Download,
  FileText,
  History as HistoryIcon,
  Info,
  Layers,
  Lock,
  LockOpen,
  MessageSquareText,
  Pencil,
  Plus,
  Trash2,
  Package2,
  Ruler,
  Search,
  ShieldCheck,
  SprayCan,
  X,
  Camera,
  RotateCcw,
} from 'lucide-react'
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Select, Stat } from '@/components/ui'
import { ImagePicker } from '@/components/inspection/ImagePicker'
import { PtCoverageBadge, SessionToneBadge, ptCoverage, sessionToneClass } from '@/components/inspection/SessionTone'
import { Attr, SampleDetail, Section, SectionEmpty, dispositionToneOf, num, statusToneOf } from '@/components/inspection/SampleDetail'
import { DefectEditDialog, DimensionEditDialog, type DefectCorrection } from '@/components/inspection/CorrectionDialogs'
import { SessionQuantitiesDialog } from '@/components/inspection/SessionQuantitiesDialog'
import { OrderNoteList } from '@/components/inspection/OrderNotes'
import { SessionPhotos } from '@/components/inspection/SessionPhotos'
import { PdiList } from '@/components/pdi/PdiList'
import { StageBadge } from '@/components/inspection/UniversalChoice'
import { historySheets } from '@/components/history/exportHistory'
import { SessionGroupModal, type GroupSpec } from '@/components/history/SessionGroupModal'
import { downloadWorkbook } from '@/lib/xlsxWrite'
import { loadHistoryExport, loadOlderSessions, useSession, useDebounced, useHistory, useHistoryOptions, useMaster, useSampleDetail, useSessionNotes, useSessionSamples } from '@/services/queries'
import { correctDefect, correctDimension, deleteNote, deleteSample, deleteSession, reopenSession } from '@/services/mutations'
import { usePersistedState } from '@/lib/usePersistedState'
import { ColumnPicker, FitColumnsButton, GridFrame, useResizableColumns, type ColumnDef } from '@/components/ui/ResizableColumns'
import { useAuth } from '@/store/AuthContext'
import { useApp } from '@/store/AppContext'
import { can, dimensionStatus, isStockOrder, processForMachine, shiftName } from '@/domain'
import { cn, daysAgoISO, formatDate, formatDateTime } from '@/lib/utils'
import {
  DISPOSITIONS,
  type DefectResult,
  type DimensionResult,
  type DimensionStatus,
  type Disposition,
  type InspectionSample,
  type InspectionSession,
  type PTRecord,
  type PaintSampleRecord,
  type SampleCoil,
  type Process,
} from '@qc/shared/types'
import type { HistoryFilters, SessionWithOrder } from '@qc/shared/api'

// ============================================================================
// §6 — History. Three levels: session → sample → the full record of that sample.
//
// This is also the correction screen. Inspectors mis-key a measurement or pick
// the wrong disposition, and quality evidence has to be correctable — but never
// silently. Every edit here goes through the API's version-checked correction
// endpoints, which write one audit entry per changed field.
//
// Reads are bounded at every level. The list is one page of recent sessions
// with their orders; a session's samples load when that session is opened,
// and a sample's dimensions, defects and coils when that sample is opened.
// ============================================================================

/** Open, Closed, or — the case a supervisor looks for first — on Hold. */
type StatusFilter = 'All' | 'Open' | 'Closed' | 'Hold'
type RangeFilter = 'all' | '7' | '30' | '90' | 'custom'

/** How many sessions one page holds. The filters are answered over the whole
 *  record, so this bounds what is fetched, never what can be found. */
const SESSION_PAGE = 100

const RANGE_LABEL: Record<RangeFilter, string> = {
  all: 'All time',
  '7': 'Last 7 days',
  '30': 'Last 30 days',
  '90': 'Last 90 days',
  custom: 'A day or a range…',
}

const todayISO = () => new Date().toISOString().slice(0, 10)


/**
 * The table's columns and their starting widths; a desktop drags them, anyone
 * hides them (§11). The everyday set is on by default; the rest are there for
 * the full picture and switched on from the Columns button.
 */
const HISTORY_COLUMNS: ColumnDef[] = [
  { key: 'seq', label: 'Seq', width: 72, min: 56 },
  { key: 'order', label: 'Order', width: 120, min: 80 },
  { key: 'item', label: 'Item', width: 240, min: 100 },
  { key: 'itemCode', label: 'Item code', width: 120, min: 80, defaultHidden: true },
  { key: 'customer', label: 'Customer', width: 160, min: 90, defaultHidden: true },
  { key: 'factory', label: 'Factory', width: 110, min: 80, defaultHidden: true },
  { key: 'machine', label: 'Machine', width: 150, min: 80 },
  { key: 'inspector', label: 'Inspector', width: 150, min: 80 },
  { key: 'date', label: 'Started', width: 130, min: 90 },
  { key: 'closed', label: 'Closed', width: 150, min: 90, defaultHidden: true },
  { key: 'closedBy', label: 'Closed by', width: 150, min: 80, defaultHidden: true },
  { key: 'status', label: 'Status', width: 150, min: 90 },
  { key: 'samples', label: 'Samples', width: 96, min: 72, align: 'right' },
  { key: 'pieces', label: 'Pieces inspected', width: 120, min: 80, align: 'right' },
  { key: 'defects', label: 'Defects', width: 90, min: 72, align: 'right' },
  { key: 'defectPieces', label: 'Defect pcs', width: 104, min: 80, align: 'right' },
  { key: 'defectRate', label: 'Defect %', width: 96, min: 72, align: 'right' },
  { key: 'inspectedRate', label: 'Defect % of inspected', width: 120, min: 80, align: 'right', defaultHidden: true },
  { key: 'dimFails', label: 'Dims failed', width: 100, min: 80, align: 'right', defaultHidden: true },
  { key: 'pt', label: 'PT tested / required', width: 150, min: 100, align: 'right', defaultHidden: true },
  { key: 'holds', label: 'On Hold', width: 90, min: 72, align: 'right', defaultHidden: true },
  { key: 'notes', label: 'Notes', width: 80, min: 64, align: 'right', defaultHidden: true },
  { key: 'rejected', label: 'Rejected before release', width: 150, min: 90, align: 'right' },
  { key: 'produced', label: 'Produced (stock)', width: 130, min: 90, align: 'right', defaultHidden: true },
  { key: 'final', label: 'Final qty', width: 100, min: 80, align: 'right' },
  { key: 'grade', label: 'Expected grade', width: 120, min: 80, defaultHidden: true },
  { key: 'open', label: '', width: 48, min: 40, hideable: false },
]

interface HistoryCellContext {
  /** True on a desktop with fixed column widths: the cell shows what fits and the whole text on hover. */
  fixed: boolean
  workCenterName: (code: string) => string
  factoryOf: (code: string) => string
  processOf: (code: string) => Process
  /** The grouped views a cell opens: the order whole, the item or the machine within the filters. */
  openOrder: (s: SessionWithOrder) => void
  openItem: (s: SessionWithOrder) => void
  openMachine: (s: SessionWithOrder) => void
}

/** A cell's text as a link to a grouped view; the row's own click (the session) is not triggered. */
function GroupLink({ onOpen, children, title }: { onOpen: () => void; children: ReactNode; title: string }) {
  return (
    <button
      type="button"
      title={title}
      onClick={(e) => {
        e.stopPropagation()
        onOpen()
      }}
      className="max-w-full truncate text-left underline decoration-slate-300 decoration-dotted underline-offset-4 hover:text-brand-700 hover:decoration-brand-500 dark:decoration-slate-600 dark:hover:text-brand-300"
    >
      {children}
    </button>
  )
}

const pctText = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 1000) / 10}%` : '—')

/** One cell of the table, by column key. */
function historyCell(key: string, s: SessionWithOrder, ctx: HistoryCellContext): ReactNode {
  const clip = ctx.fixed ? 'truncate' : ''
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
  const defects = s.defectCount ?? 0
  const defectPieces = s.defectPieces ?? 0
  const pieces = s.piecesInspected ?? 0
  switch (key) {
    case 'seq':
      return <td key={key} className="px-4 py-3 tabular-nums text-slate-400">#{s.seq}</td>
    case 'order':
      return (
        <td key={key} className={cn('px-4 py-3 font-bold', clip)} title={s.order?.orderNumber ?? undefined}>
          {isStockOrder(s.order) ? <Badge tone="violet">For stock</Badge> : s.order?.orderNumber ? <GroupLink title="Every session of this order" onOpen={() => ctx.openOrder(s)}>{s.order.orderNumber}</GroupLink> : '—'}
        </td>
      )
    case 'item':
      return (
        <td key={key} className={cn('px-4 py-3', ctx.fixed ? 'truncate' : 'max-w-[220px] truncate')} title={s.order?.item ?? undefined}>
          {s.order?.item ? <GroupLink title="This item's sessions, within the filters" onOpen={() => ctx.openItem(s)}>{s.order.item}</GroupLink> : '—'}
        </td>
      )
    case 'itemCode':
      return s.order?.itemCode ? (
        <td key={key} className={cn('px-4 py-3 font-mono text-xs', clip)} title={s.order.itemCode}>
          <GroupLink title="This item's sessions, within the filters" onOpen={() => ctx.openItem(s)}>{s.order.itemCode}</GroupLink>
        </td>
      ) : (
        text('', 'font-mono text-xs')
      )
    case 'customer':
      return text(s.order?.customer ?? '')
    case 'factory':
      return text(ctx.factoryOf(s.workCenterCode))
    case 'machine':
      return (
        <td key={key} className={cn('px-4 py-3', clip)} title={ctx.workCenterName(s.workCenterCode)}>
          <GroupLink title="This machine's sessions, within the filters" onOpen={() => ctx.openMachine(s)}>{ctx.workCenterName(s.workCenterCode)}</GroupLink>
        </td>
      )
    case 'inspector':
      return text(s.inspectorName)
    case 'date':
      return (
        <td key={key} className={cn('px-4 py-3 tabular-nums', clip)} title={formatDateTime(s.startedAt)}>
          {formatDate(s.startedAt)}
        </td>
      )
    case 'closed':
      return text(s.closedAt ? formatDateTime(s.closedAt) : '', 'tabular-nums')
    case 'closedBy':
      return text(s.closedAt ? (s.closedByName ?? 'Unknown') : '')
    case 'status':
      return (
        <td key={key} className="px-4 py-3">
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <Badge tone={s.status === 'Open' ? 'green' : 'neutral'}>{s.status}</Badge>
            <StageBadge kind={s.universalKind} stages={s.stages} />
            <SessionToneBadge session={s} />
          </span>
        </td>
      )
    case 'samples':
      return number(s.sampleCount)
    case 'pieces':
      return number(pieces)
    case 'defects':
      return number(defects, defects > 0 ? 'font-bold text-rose-600 dark:text-rose-400' : '')
    case 'defectPieces':
      // The same figure the dashboard adds up per day and per machine.
      return number(defectPieces, defectPieces > 0 ? 'font-bold text-rose-600 dark:text-rose-400' : '')
    case 'defectRate': {
      // Defect pieces per 100 produced: the final quantity is the batch, known once the session is closed.
      const produced = s.status === 'Closed' && s.finalQty !== undefined ? s.finalQty : null
      return (
        <td
          key={key}
          className={cn('px-4 py-3 text-right tabular-nums', produced !== null && defectPieces > 0 && 'font-bold text-rose-600 dark:text-rose-400')}
          title={produced === null ? 'Known once the session is closed with a final quantity' : `${defectPieces} defect pieces of ${produced} produced`}
        >
          {produced === null ? '—' : pctText(defectPieces, produced)}
        </td>
      )
    }
    case 'inspectedRate':
      return (
        <td key={key} className={cn('px-4 py-3 text-right tabular-nums', defectPieces > 0 && 'font-bold text-rose-600 dark:text-rose-400')} title="Defect pieces over pieces inspected">
          {pctText(defectPieces, pieces)}
        </td>
      )
    case 'dimFails':
      return number(s.dimensionFailCount ?? 0, (s.dimensionFailCount ?? 0) > 0 ? 'font-bold text-rose-600 dark:text-rose-400' : '')
    case 'pt': {
      // Welding only; the requirement is 5% of the final quantity once the session is closed.
      if (ctx.processOf(s.workCenterCode) !== 'welding') return <td key={key} className="px-4 py-3 text-right text-slate-400">—</td>
      const c = ptCoverage(s, s.status === 'Closed' ? s.finalQty : null)
      return (
        <td key={key} className={cn('px-4 py-3 text-right tabular-nums', c.required !== null && (c.met ? 'font-semibold text-emerald-700 dark:text-emerald-400' : 'font-bold text-amber-700 dark:text-amber-400'))} title={c.required === null ? 'Required is known once the session is closed' : c.short > 0 ? `Short by ${c.short}` : 'Met'}>
          {c.tested} / {c.required ?? '—'}
        </td>
      )
    }
    case 'holds':
      return number(s.holdCount ?? 0, (s.holdCount ?? 0) > 0 ? 'font-bold text-amber-700 dark:text-amber-400' : '')
    case 'notes':
      return number(s.noteCount ?? 0)
    case 'rejected':
      return number(s.startQtyConfirmed?.qty)
    case 'produced':
      return number(isStockOrder(s.order) ? (s.producedQty ?? null) : null)
    case 'final':
      return number(s.finalQty)
    case 'grade':
      return text(s.order?.expectedGrade ?? '')
    case 'open':
      return (
        <td key={key} className="px-4 py-3 text-right">
          <ChevronRight className="ml-auto h-4 w-4 text-slate-400" />
        </td>
      )
    default:
      return null
  }
}

export function HistoryPage() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { role } = useAuth()
  const { toast } = useApp()
  const [params, setParams] = useSearchParams()
  /** What History lists: inspection sessions, or PDI documents. Kept on this device. */
  const [kind, setKind] = usePersistedState<'sessions' | 'pdi'>('qc-history:kind', 'sessions')
  // A grouped view elsewhere (Access) sends a session in the address: it opens, once, and leaves the address.
  useEffect(() => {
    const id = params.get('session')
    if (id === null) return
    setKind('sessions')
    setOpenSampleId(null)
    setOpenSessionId(id)
    const next = new URLSearchParams(params)
    next.delete('session')
    setParams(next, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params])
  // Access sends an order number in the address: it becomes the search, once, and leaves the address.
  useEffect(() => {
    const q = params.get('q')
    if (q === null) return
    setKind('sessions')
    setTerm(q)
    const next = new URLSearchParams(params)
    next.delete('q')
    setParams(next, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params])

  // The filters are kept on this device: leaving for another tab and coming
  // back finds them where they were left, as on every list in the app.
  const [term, setTerm] = usePersistedState('qc-history:term', '')
  const [olderHasMore, setOlderHasMore] = useState(false)
  const [status, setStatus] = usePersistedState<StatusFilter>('qc-history:status', 'All')
  const [workCenter, setWorkCenter] = usePersistedState('qc-history:machine', 'all')
  const [range, setRange] = usePersistedState<RangeFilter>('qc-history:range', 'all')
  /** The custom range: factory days, both inclusive; the same day twice is one day. */
  const [fromDay, setFromDay] = usePersistedState('qc-history:from', todayISO())
  const [toDay, setToDay] = usePersistedState('qc-history:to', todayISO())
  const [inspectorFilter, setInspectorFilter] = usePersistedState('qc-history:inspector', 'all')
  const [factoryFilter, setFactoryFilter] = usePersistedState('qc-history:factory', 'all')
  /** Any part of a code or a name; a pick from the list ("code — name") is that one item, even where two share a code. */
  const [itemFilter, setItemFilter] = usePersistedState('qc-history:item', '')
  const settledItem = useDebounced(itemFilter.trim(), 300)
  /** Every filter back to how the tab opens the first time. */
  const filtersSet = term !== '' || status !== 'All' || workCenter !== 'all' || range !== 'all' || inspectorFilter !== 'all' || factoryFilter !== 'all' || itemFilter !== ''
  const resetFilters = () => {
    setTerm('')
    setStatus('All')
    setWorkCenter('all')
    setRange('all')
    setFromDay(todayISO())
    setToDay(todayISO())
    setInspectorFilter('all')
    setFactoryFilter('all')
    setItemFilter('')
  }

  const [openSessionId, setOpenSessionId] = useState<string | null>(null)
  const grid = useResizableColumns('qc-history:grid', HISTORY_COLUMNS)
  const [openSampleId, setOpenSampleId] = useState<string | null>(null)
  const [editingDim, setEditingDim] = useState<DimensionResult | null>(null)
  const [editingDefect, setEditingDefect] = useState<DefectResult | null>(null)
  const [saving, setSaving] = useState(false)
  /** What an administrator asked to delete; confirmed in its own dialog. */
  const [removing, setRemoving] = useState<
    { kind: 'session'; id: string; label: string } | { kind: 'sample'; id: string; label: string } | { kind: 'note'; id: string; label: string } | null
  >(null)
  const canDelete = can(role, 'delete-session')
  /** §4 — an open session's quantities by an inspector, a closed one's by a supervisor; the API enforces the same. */
  const canCorrectQuantities = (s: SessionWithOrder) => (s.status === 'Open' ? can(role, 'edit-open-session') : can(role, 'edit-closed-session'))
  const [correctingQty, setCorrectingQty] = useState<SessionWithOrder | null>(null)
  const canDeleteNote = can(role, 'delete-note')

  async function reopen() {
    if (!openSession) return
    setSaving(true)
    try {
      await reopenSession(queryClient, openSession.id, openSession.version)
      toast('Session reopened. Samples can be added again.', 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not reopen the session.', 'error')
    } finally {
      setSaving(false)
    }
  }

  async function confirmRemove() {
    if (!removing) return
    setSaving(true)
    try {
      if (removing.kind === 'session') {
        await deleteSession(queryClient, removing.id)
        toast('Session marked deleted. Nothing was erased.', 'success')
        closeDrilldown()
      } else if (removing.kind === 'note') {
        if (openSession) await deleteNote(queryClient, openSession.id, removing.id)
        toast('Note marked deleted. Nothing was erased.', 'success')
      } else {
        await deleteSample(queryClient, removing.id)
        toast('Sample marked deleted. Nothing was erased.', 'success')
        setOpenSampleId(null)
      }
      setRemoving(null)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not delete.', 'error')
    } finally {
      setSaving(false)
    }
  }

  /** The Inspections page links here as `/history?disposition=Hold` so a
   *  supervisor lands straight on the sessions that still owe a decision. */
  const dispositionParam = params.get('disposition')
  const dispositionFilter = (DISPOSITIONS as readonly string[]).includes(dispositionParam ?? '') ? (dispositionParam as Disposition) : null

  // ---- The list ------------------------------------------------------------
  // Every filter is answered by the API over the whole record, never by
  // sifting the page in hand: a session that matches is found whether it is
  // the newest one or the ten-thousandth.
  const settledTerm = useDebounced(term.trim(), 300)
  const filters = useMemo<HistoryFilters>(() => {
    const f: HistoryFilters = {}
    if (settledTerm) f.q = settledTerm
    if (status === 'Open' || status === 'Closed') f.status = status
    if (workCenter !== 'all') f.workCenterCode = workCenter
    if (inspectorFilter !== 'all') f.inspectorId = inspectorFilter
    if (factoryFilter !== 'all') f.factory = factoryFilter
    if (settledItem) f.item = settledItem
    if (range === 'custom') {
      // Either end may be left open; an inverted pair is sent in order rather than refused.
      const [a, b] = fromDay && toDay && fromDay > toDay ? [toDay, fromDay] : [fromDay, toDay]
      if (a) f.from = a
      if (b) f.to = b
    } else if (range !== 'all') f.since = daysAgoISO(Number(range))
    if (dispositionFilter) f.disposition = dispositionFilter
    else if (status === 'Hold') f.disposition = 'Hold'
    return f
  }, [settledTerm, status, workCenter, inspectorFilter, factoryFilter, settledItem, range, fromDay, toDay, dispositionFilter])

  const { data: history, isLoading: loading, isFetching } = useHistory(filters, SESSION_PAGE, kind === 'sessions')
  // A link to the sessions with a disposition lands on the sessions, whatever was last shown.
  useEffect(() => {
    if (dispositionFilter) setKind('sessions')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispositionFilter])
  /** Pages walked back from the first one, so an older session is never out of reach. */
  const [older, setOlder] = useState<SessionWithOrder[]>([])
  const [loadingOlder, setLoadingOlder] = useState(false)
  const sessions = useMemo(() => {
    const first = history?.sessions ?? []
    const seen = new Set(first.map((s) => s.id))
    return [...first, ...older.filter((s) => !seen.has(s.id))]
  }, [history, older])
  const hasMore = older.length > 0 ? olderHasMore : (history?.hasMore ?? false)

  // Different filters are a different list: start again from its first page.
  useEffect(() => {
    setOlder([])
    setOlderHasMore(false)
  }, [filters])

  async function showOlder() {
    const last = sessions[sessions.length - 1]
    if (!last || loadingOlder) return
    setLoadingOlder(true)
    try {
      const page = await loadOlderSessions(filters, last.startedAt, SESSION_PAGE)
      setOlder((prev) => [...prev, ...page.sessions])
      setOlderHasMore(page.hasMore)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not load older sessions.', 'error')
    } finally {
      setLoadingOlder(false)
    }
  }

  // Master data — the work-centre names come from nowhere else.
  const { data: machines = [] } = useMaster('machines')

  // ---- The drill-down ------------------------------------------------------
  // Children load for what is open and nothing else.
  const { data: samples = [], isLoading: samplesLoading } = useSessionSamples(openSessionId)
  const { data: sessionNotes = [], isLoading: notesLoading } = useSessionNotes(openSessionId)
  const { data: detail, isLoading: sampleLoading } = useSampleDetail(openSampleId)

  /** The open session's samples, in the order they were taken. */
  const sessionSamples = useMemo(() => [...samples].sort((a, b) => a.index - b.index), [samples])

  const workCenterName = (code: string) => machines.find((m) => m.code === code)?.displayName ?? `Machine ${code}`

  // §6 — the grouped views: an order whole, an item or a machine within the filters, or the filters themselves.
  const [groupSpec, setGroupSpec] = useState<GroupSpec | null>(null)
  const withinFilters = 'Within the filters above'
  function openOrder(s: SessionWithOrder) {
    if (!s.order?.orderNumber || isStockOrder(s.order)) return
    setGroupSpec({ title: `Order ${s.order.orderNumber}`, subtitle: `${s.order.customer ? `${s.order.customer} · ` : ''}every session of the order, whatever the filters`, query: { orderNumber: s.order.orderNumber } })
  }
  function openItem(s: SessionWithOrder) {
    if (!s.order) return
    // An item is its code and its name: two items may share a code.
    const query = s.order.itemCode ? { ...filters, itemCode: s.order.itemCode, itemName: s.order.item || undefined } : { ...filters, item: s.order.item }
    setGroupSpec({ title: s.order.item, subtitle: `${s.order.itemCode ? `${s.order.itemCode} · ` : ''}${withinFilters}`, query })
  }
  function openMachine(s: SessionWithOrder) {
    setGroupSpec({ title: workCenterName(s.workCenterCode), subtitle: withinFilters, query: { ...filters, workCenterCode: s.workCenterCode } })
  }
  function openCounter(status?: 'Open' | 'Closed') {
    setGroupSpec({ title: status ? `${status} sessions` : 'Sessions', subtitle: withinFilters, query: { ...filters, ...(status ? { status } : {}) } })
  }
  function openFromGroup(sessionId: string) {
    setGroupSpec(null)
    setOpenSampleId(null)
    setOpenSessionId(sessionId)
  }
  const cellContext = useMemo<HistoryCellContext>(
    () => ({
      fixed: grid.enabled,
      workCenterName: (code) => machines.find((m) => m.code === code)?.displayName ?? `Machine ${code}`,
      factoryOf: (code) => machines.find((m) => m.code === code)?.factory ?? '',
      processOf: (code) => processForMachine(machines.find((m) => m.code === code) ?? null, code),
      openOrder,
      openItem,
      openMachine,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [grid.enabled, machines, filters],
  )

  // The lists a filter may offer come from the record, not from the page on
  // screen — an inspector who last worked a year ago is still in the list.
  const { data: options } = useHistoryOptions()
  const workCenterOptions = options?.workCenterCodes ?? []
  const inspectorOptions = options?.inspectors ?? []
  const itemOptions = options?.items ?? []

  // History is the factory's record: everyone reads all of it and may
  // narrow by who and where.
  const seesAll = true
  const factoryOptions = useMemo(() => {
    const names = new Set<string>()
    for (const m of machines) {
      const f = m.factory?.trim()
      if (f) names.add(f)
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b))
  }, [machines])

  /** The API answers newest first; the merged pages keep that order. */
  const filtered = useMemo(
    () => [...sessions].sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : b.seq - a.seq)),
    [sessions],
  )

  // Counted by the API over everything that matches — the stat is the size of
  // the match, not the size of what has been fetched so far.
  const totals = useMemo(() => {
    const matched = history?.totals
    if (!matched) {
      const open = filtered.filter((s) => s.status === 'Open').length
      return { sessions: filtered.length, open, closed: filtered.length - open }
    }
    return { sessions: matched.sessions, open: matched.open, closed: matched.sessions - matched.open }
  }, [history, filtered])

  // A session opened from a grouped view may sit outside the filters: it is fetched on its own then.
  const openInList = openSessionId ? (sessions.find((s) => s.id === openSessionId) ?? null) : null
  const { data: openFetched } = useSession(openSessionId && !openInList ? openSessionId : null)
  const openSession = openInList ?? (openSessionId && openFetched?.id === openSessionId ? openFetched : null)
  const openSample = openSampleId && detail ? detail.sample : null

  /** §14 — an inspector may correct an open session; a closed one needs a
   *  supervisor. Anything else is read-only, and says so. The API enforces
   *  the same rule, so this only decides what to show. */
  const editable = openSession
    ? openSession.status === 'Open'
      ? can(role, 'edit-open-session')
      : can(role, 'edit-closed-session')
    : false

  async function saveDimension(dim: DimensionResult, actual: number | null) {
    setSaving(true)
    try {
      await correctDimension(queryClient, dim.id, { actual, version: dim.version })
      toast('Measurement corrected. The change is in the audit log.', 'success')
      setEditingDim(null)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save the correction.', 'error')
    } finally {
      setSaving(false)
    }
  }

  async function saveDefect(defect: DefectResult, patch: DefectCorrection) {
    setSaving(true)
    try {
      await correctDefect(queryClient, defect.id, { ...patch, version: defect.version })
      toast('Defect corrected. The change is in the audit log.', 'success')
      setEditingDefect(null)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save the correction.', 'error')
    } finally {
      setSaving(false)
    }
  }

  // §6 — History to Excel: every session the filters match, not only the page on screen.
  const canExport = can(role, 'export-records')
  const [exporting, setExporting] = useState(false)
  async function exportExcel() {
    if (exporting) return
    setExporting(true)
    try {
      const data = await loadHistoryExport(filters)
      if (data.sessions.length === 0) {
        toast('No session matches these filters.', 'info')
        return
      }
      downloadWorkbook(`QC-history-${todayISO()}.xlsx`, historySheets(data))
      toast(`Exported ${data.sessions.length} ${data.sessions.length === 1 ? 'session' : 'sessions'} with their samples, measurements and defects.`, 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not build the export.', 'error')
    } finally {
      setExporting(false)
    }
  }

  function closeDrilldown() {
    setOpenSessionId(null)
    setOpenSampleId(null)
    setEditingDim(null)
    setEditingDefect(null)
  }

  function clearDisposition() {
    const next = new URLSearchParams(params)
    next.delete('disposition')
    setParams(next, { replace: true })
  }

  const kindToggle = (
    <div role="tablist" aria-label="What History lists" className="inline-flex rounded-xl bg-slate-100 p-1 dark:bg-slate-800">
      {(['sessions', 'pdi'] as const).map((k) => (
        <button
          key={k}
          type="button"
          role="tab"
          aria-selected={kind === k}
          onClick={() => setKind(k)}
          className={cn('inline-flex min-h-[40px] items-center gap-1.5 rounded-lg px-4 text-sm font-semibold transition-colors', kind === k ? 'bg-white text-brand-700 shadow-sm dark:bg-slate-900 dark:text-brand-300' : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200')}
        >
          {k === 'sessions' ? <HistoryIcon className="h-4 w-4" /> : <FileText className="h-4 w-4" />}
          {k === 'sessions' ? 'Sessions' : 'PDI'}
        </button>
      ))}
    </div>
  )

  if (kind === 'pdi') {
    return (
      <div className="space-y-5">
        {kindToggle}
        <PdiList />
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {kindToggle}
      {/* No page heading: the tab says where you are, and the counters take the top of the page. */}
      <div className="grid grid-cols-3 gap-2 sm:gap-3">
        <button type="button" className="text-left" onClick={() => openCounter()} disabled={totals.sessions === 0} aria-label="Sessions: grouped by order line">
          <Stat
            compact
            label="Sessions"
            value={totals.sessions}
            sub={totals.sessions > filtered.length ? `${filtered.length} on screen, the rest below` : 'All of them on screen'}
            icon={<HistoryIcon className="h-5 w-5" />}
          />
        </button>
        <button type="button" className="text-left" onClick={() => openCounter('Open')} disabled={totals.open === 0} aria-label="Open sessions: grouped by order line">
          <Stat compact label="Open" value={totals.open} tone={totals.open > 0 ? 'green' : 'neutral'} icon={<ClipboardList className="h-5 w-5" />} />
        </button>
        <button type="button" className="text-left" onClick={() => openCounter('Closed')} disabled={totals.closed === 0} aria-label="Closed sessions: grouped by order line">
          <Stat compact label="Closed" value={totals.closed} tone="neutral" icon={<Lock className="h-5 w-5" />} />
        </button>
      </div>


      {dispositionFilter && (
        <Card className="flex flex-wrap items-center gap-3 border-l-4 border-l-amber-400 p-4">
          <AlertTriangle className="h-5 w-5 shrink-0 text-amber-500" />
          <p className="min-w-0 flex-1 text-sm font-semibold">
            Showing only sessions with a defect dispositioned <Badge tone={dispositionToneOf(dispositionFilter)}>{dispositionFilter}</Badge>
          </p>
          <Button className="min-h-[48px]" onClick={clearDisposition}>
            <X className="h-4 w-4" /> Clear filter
          </Button>
        </Card>
      )}

      <Card className="space-y-3 p-4">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Order, item, code, customer, inspector, machine or #session…"
            className="min-h-[52px] pl-9 text-base"
            aria-label="Search history"
          />
        </div>
        <div className={cn('grid grid-cols-2 gap-3 sm:grid-cols-3', seesAll && 'lg:grid-cols-6')}>
          <Field label="Status">
            <Select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} className="min-h-[48px]">
              <option value="All">All</option>
              <option value="Open">Open</option>
              <option value="Closed">Closed</option>
              <option value="Hold">On Hold</option>
            </Select>
          </Field>
          <Field label="Date range">
            <Select value={range} onChange={(e) => setRange(e.target.value as RangeFilter)} className="min-h-[48px]">
              {(Object.keys(RANGE_LABEL) as RangeFilter[]).map((r) => (
                <option key={r} value={r}>
                  {RANGE_LABEL[r]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Item">
            <Input list="history-items" value={itemFilter} onChange={(e) => setItemFilter(e.target.value)} placeholder="Any part of a code or name" className="min-h-[48px]" aria-label="Item" />
            <datalist id="history-items">
              {itemOptions.map((i) => (
                <option key={`${i.itemCode}|${i.item}`} value={`${i.itemCode} — ${i.item}`} />
              ))}
            </datalist>
          </Field>
          {range === 'custom' && (
            <>
              <Field label="From day">
                <Input type="date" value={fromDay} max={toDay || undefined} onChange={(e) => setFromDay(e.target.value)} className="min-h-[48px]" aria-label="From day" />
              </Field>
              <Field label="To day">
                <Input type="date" value={toDay} min={fromDay || undefined} onChange={(e) => setToDay(e.target.value)} className="min-h-[48px]" aria-label="To day" />
              </Field>
            </>
          )}
          <div className={cn(!seesAll && 'col-span-2 sm:col-span-1')}>
            <Field label="Machine">
              <Select value={workCenter} onChange={(e) => setWorkCenter(e.target.value)} className="min-h-[48px]">
                <option value="all">All machines</option>
                {workCenterOptions.map((code) => (
                  <option key={code} value={code}>
                    {workCenterName(code)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {seesAll && (
            <>
              <Field label="Inspector">
                <Select value={inspectorFilter} onChange={(e) => setInspectorFilter(e.target.value)} className="min-h-[48px]">
                  <option value="all">All inspectors</option>
                  {inspectorOptions.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Factory">
                <Select value={factoryFilter} onChange={(e) => setFactoryFilter(e.target.value)} className="min-h-[48px]">
                  <option value="all">All factories</option>
                  {factoryOptions.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </Select>
              </Field>
            </>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          {isFetching && !loading ? <p className="text-xs text-slate-400">Searching the whole record…</p> : <span />}
          <span className="flex flex-wrap gap-2">
            {canExport && (
              <Button className="min-h-[40px]" onClick={() => void exportExcel()} disabled={exporting || totals.sessions === 0} aria-label="Export the sessions to Excel">
                <Download className="h-4 w-4" /> {exporting ? 'Building…' : 'Export Excel'}
              </Button>
            )}
            <Button className="min-h-[40px]" onClick={resetFilters} disabled={!filtersSet} aria-label="Reset all filters">
              <RotateCcw className="h-4 w-4" /> Reset all
            </Button>
          </span>
        </div>
      </Card>

      {loading ? (
        <Card className="p-10 text-center text-sm text-slate-400">Loading…</Card>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<HistoryIcon className="h-10 w-10" />}
          title="No sessions match"
          hint={
            dispositionFilter
              ? `Nothing is currently dispositioned ${dispositionFilter}.`
              : 'Nothing in the whole record matches these filters — widen the date range or clear the search.'
          }
        />
      ) : (
        <>
          {/* Mobile — one card per session. */}
          {/* minmax(0,1fr) columns and min-w-0 keep a long item name inside the card instead of widening the page. */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:hidden">
            {filtered.map((s) => (
              <button key={s.id} onClick={() => setOpenSessionId(s.id)} className={cn('card-hover w-full min-w-0 p-4 text-left', sessionToneClass(s, 'block'))}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-bold tabular-nums text-slate-400">#{s.seq}</span>
                  {isStockOrder(s.order) ? <Badge tone="violet">For stock</Badge> : <span className="font-bold">{s.order?.orderNumber ?? '—'}</span>}
                  <Badge tone={s.status === 'Open' ? 'green' : 'neutral'}>{s.status.toUpperCase()}</Badge>
                  <StageBadge kind={s.universalKind} stages={s.stages} />
                  <SessionToneBadge session={s} />
                </div>
                <p className="mt-1 truncate text-sm font-medium text-brand-600 dark:text-brand-400">{s.order?.item ?? 'Unknown item'}</p>
                <p className="mt-0.5 text-xs text-slate-400">
                  {workCenterName(s.workCenterCode)} · {s.inspectorName} · {formatDate(s.startedAt)}
                </p>
                <div className="mt-3 flex items-center gap-2">
                  <span className="flex min-w-0 flex-wrap items-center gap-2">
                    <Badge tone="neutral">
                      {s.sampleCount ?? 0} sample{s.sampleCount === 1 ? '' : 's'}
                    </Badge>
                    {s.startQtyConfirmed && <Badge tone="neutral">Rejected before release {s.startQtyConfirmed.qty}</Badge>}
                    {s.producedQty !== undefined && <Badge tone="neutral">Produced {s.producedQty} pairs</Badge>}
                    {s.finalQty !== undefined && <Badge tone="blue">Final {s.finalQty}</Badge>}
                  </span>
                  <ChevronRight className="ml-auto h-5 w-5 shrink-0 text-slate-400" />
                </div>
              </button>
            ))}
          </div>

          {/* md+ — the same rows as a table; the columns are the person's to size and choose. */}
          <div className="hidden justify-end gap-2 md:flex">
            <FitColumnsButton grid={grid} />
            <ColumnPicker grid={grid} />
          </div>
          <Card className="hidden overflow-hidden md:block">
            <GridFrame>
              <table ref={grid.tableRef} className={cn('w-full text-sm', !grid.enabled && 'min-w-[720px]')} style={grid.tableStyle}>
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
                  {filtered.map((s) => (
                    <tr
                      key={s.id}
                      onClick={() => setOpenSessionId(s.id)}
                      className={cn('cursor-pointer transition-colors', sessionToneClass(s, 'row', 'hover:bg-slate-50 dark:hover:bg-slate-800/50'))}
                    >
                      {grid.visible.map((c) => historyCell(c.key, s, cellContext))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </GridFrame>
          </Card>

          {hasMore && (
            <div className="flex justify-center pt-1">
              <Button className="min-h-[48px]" onClick={() => void showOlder()} disabled={loadingOlder}>
                {loadingOlder ? 'Loading…' : 'Show older sessions'}
              </Button>
            </div>
          )}
        </>
      )}

      {/* ---- Drill-down: samples of one session, then one sample in full ---- */}
      <Modal
        open={!!openSession}
        onClose={closeDrilldown}
        size="xl"
        icon={openSample ? <Layers className="h-5 w-5" /> : <ClipboardList className="h-5 w-5" />}
        title={
          openSession ? (
            <span className="flex flex-wrap items-center gap-2">
              <span>{openSession.order?.orderNumber ?? 'Session'}</span>
              <span className="text-sm font-semibold text-slate-400">#{openSession.seq}</span>
              {openSample && (
                <span className="text-sm font-semibold text-brand-600 dark:text-brand-400">
                  · Sample {openSession.seq}-{openSample.index}
                </span>
              )}
            </span>
          ) : null
        }
        footer={
          <>
            {openSession && openSample && editable && (
              <Button variant="secondary" className="min-h-[48px]" onClick={() => navigate(`/wizard/${openSession.id}/edit/${openSample.id}`)}>
                <Pencil className="h-4 w-4" /> Edit sample
              </Button>
            )}
            {openSession && !openSample && openSession.status === 'Open' && can(role, 'record-inspection') && (
              <Button variant="secondary" className="min-h-[48px]" onClick={() => navigate(`/wizard/${openSession.id}`)}>
                <Plus className="h-4 w-4" /> New sample
              </Button>
            )}
            {openSession && !openSample && openSession.status === 'Closed' && can(role, 'edit-closed-session') && (
              <Button variant="secondary" className="min-h-[48px]" disabled={saving} onClick={() => void reopen()}>
                <LockOpen className="h-4 w-4" /> Reopen session
              </Button>
            )}
            {openSession && !openSample && canCorrectQuantities(openSession) && (
              <Button variant="secondary" className="min-h-[48px]" onClick={() => setCorrectingQty(openSession)}>
                <Pencil className="h-4 w-4" /> Correct quantities
              </Button>
            )}
            {canDelete && openSession && (
              <Button
                variant="danger"
                className="mr-auto min-h-[48px]"
                onClick={() =>
                  setRemoving(
                    openSample
                      ? { kind: 'sample', id: openSample.id, label: `sample ${openSession.seq}-${openSample.index}` }
                      : { kind: 'session', id: openSession.id, label: `session #${openSession.seq} of ${openSession.order?.orderNumber ?? 'this order'}` },
                  )
                }
              >
                <Trash2 className="h-4 w-4" /> {openSample ? 'Delete sample' : 'Delete session'}
              </Button>
            )}
            <Button className="min-h-[48px]" onClick={closeDrilldown}>
              Close
            </Button>
          </>
        }
      >
        {openSession && (
          <div className="space-y-4">
            {!openSampleId && (
              <div className="print-hidden flex flex-wrap gap-2 text-xs">
                {openSession.order?.orderNumber && !isStockOrder(openSession.order) && (
                  <Button className="min-h-[36px]" onClick={() => openOrder(openSession)}>
                    <Layers className="h-3.5 w-3.5" /> Whole order
                  </Button>
                )}
                {openSession.order?.item && (
                  <Button className="min-h-[36px]" onClick={() => openItem(openSession)}>
                    <Layers className="h-3.5 w-3.5" /> This item
                  </Button>
                )}
                <Button className="min-h-[36px]" onClick={() => openMachine(openSession)}>
                  <Layers className="h-3.5 w-3.5" /> This machine
                </Button>
              </div>
            )}
            {openSampleId ? (
              <>
                <button
                  onClick={() => setOpenSampleId(null)}
                  className="inline-flex min-h-[48px] items-center gap-1.5 text-sm font-semibold text-slate-500 hover:text-brand-600 dark:text-slate-400"
                >
                  <ArrowLeft className="h-4 w-4" /> All samples
                </button>
                {detail ? (
                  <SampleDetail
                    session={openSession}
                    process={processForMachine(machines.find((m) => m.code === openSession.workCenterCode) ?? null, openSession.workCenterCode)}
                    sample={detail.sample}
                    dimensions={detail.dimensions}
                    defects={detail.defects}
                    coils={detail.coils}
                    paint={detail.paint ?? undefined}
                    pt={detail.pt ?? undefined}
                    loading={sampleLoading}
                    editable={editable}
                    onEditDimension={setEditingDim}
                    onEditDefect={setEditingDefect}
                  />
                ) : (
                  <SectionEmpty message="Loading the sample…" />
                )}
              </>
            ) : (
              <>
                <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Attr label="Item" value={openSession.order?.item} />
                  <Attr label="Machine" value={workCenterName(openSession.workCenterCode)} />
                  <Attr label="Inspector" value={openSession.inspectorName} />
                  <Attr label="Started" value={formatDateTime(openSession.startedAt)} />
                  <Attr label="Status" value={openSession.status} />
                  {isStockOrder(openSession.order) ? (
                    <Attr label="Quantity produced (pairs)" value={openSession.producedQty} />
                  ) : (
                    <Attr label="Rejected qty before release" value={openSession.startQtyConfirmed?.qty} />
                  )}
                  <Attr label="Final qty" value={openSession.finalQty} />
                  {/* §4 — on a universal machine: a final product, or the stages the session covered and each one's quantity. */}
                  {openSession.universalKind === 'final' && <Attr label="On this machine" value="Final product, no stages" />}
                  {openSession.stages?.length ? <Attr label="Stages · quantity" value={openSession.stages.map((x) => `Stage ${x.stage}: ${x.qty}`).join(' · ')} /> : null}
                  <Attr label="Closed" value={openSession.closedAt ? formatDateTime(openSession.closedAt) : '—'} />
                  <Attr label="Closed by" value={openSession.closedByName ?? (openSession.closedAt ? 'Unknown' : '—')} />
                  {processForMachine(machines.find((m) => m.code === openSession.workCenterCode) ?? null, openSession.workCenterCode) === 'welding' && (
                    <div>
                      <dt className="text-xs font-semibold uppercase text-slate-400">PT coverage (5% of final qty)</dt>
                      <dd className="mt-0.5">
                        <PtCoverageBadge session={openSession} finalQty={openSession.status === 'Closed' ? openSession.finalQty : null} />
                      </dd>
                    </div>
                  )}
                </dl>

                {samplesLoading ? (
                  <SectionEmpty message="Loading the samples of this session…" />
                ) : sessionSamples.length === 0 ? (
                  <SectionEmpty message="No samples were recorded in this session." />
                ) : (
                  <div className="space-y-2">
                    {sessionSamples.map((sm) => (
                      <button
                        key={sm.id}
                        onClick={() => setOpenSampleId(sm.id)}
                        className="flex min-h-[48px] w-full items-center gap-3 rounded-2xl px-4 py-3 text-left ring-1 ring-slate-200 transition-colors hover:bg-slate-50 dark:ring-slate-700 dark:hover:bg-slate-800/60"
                      >
                        {/* The number tile wears the sample's worst signal: amber on Hold, red with defects, blue when clean. */}
                        <span
                          className={cn(
                            'grid h-10 min-w-[2.5rem] shrink-0 place-items-center rounded-xl px-1.5 text-sm font-bold tabular-nums',
                            (sm.holdCount ?? 0) > 0
                              ? 'bg-amber-100 text-amber-800 ring-1 ring-amber-300 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-500/40'
                              : (sm.defectCount ?? 0) > 0
                                ? 'bg-rose-100 text-rose-800 ring-1 ring-rose-300 dark:bg-rose-500/15 dark:text-rose-300 dark:ring-rose-500/40'
                                : 'bg-brand-100 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300',
                          )}
                          title={(sm.holdCount ?? 0) > 0 ? 'A defect in this sample is on Hold' : (sm.defectCount ?? 0) > 0 ? 'This sample recorded defects' : undefined}
                        >
                          {openSession.seq}-{sm.index}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block font-bold">
                            {shiftName(sm.shift)} shift · {sm.inspectorName}
                          </span>
                          <span className="block text-xs text-slate-400">
                            {formatDateTime(sm.createdAt)} · sample qty {sm.sampleQty}
                          </span>
                          {/* The measured/total split keeps a dimension nobody measured visible. */}
                          <span className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-500 dark:text-slate-400">
                            <span className="tabular-nums">
                              {sm.measuredDimensionCount ?? 0}/{sm.dimensionCount ?? 0} measured
                            </span>
                            {(sm.defectCount ?? 0) > 0 && (
                              <span className="tabular-nums text-amber-600 dark:text-amber-400">
                                {sm.defectCount} defect{sm.defectCount === 1 ? '' : 's'}
                              </span>
                            )}
                            {(sm.coilCount ?? 0) > 0 && (
                              <span className="tabular-nums">
                                {sm.coilCount} coil{sm.coilCount === 1 ? '' : 's'}
                              </span>
                            )}
                          </span>
                        </span>
                        <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" />
                      </button>
                    ))}
                  </div>
                )}

                {/* §10.8 — every photo of the session, by what it shows, without opening the samples. */}
                <Section icon={<Camera className="h-4 w-4" />} title="Photos of this session">
                  <SessionPhotos sessionId={openSession.id} sessionSeq={openSession.seq} onOpenSample={(id) => setOpenSampleId(id)} />
                </Section>

                {/* §5.8 — remarks about the order written during this session. */}
                <Section icon={<MessageSquareText className="h-4 w-4" />} title="Notes about the order" count={sessionNotes.length}>
                  {notesLoading ? (
                    <SectionEmpty message="Loading the notes…" />
                  ) : (
                    <OrderNoteList
                      notes={sessionNotes}
                      emptyMessage="No notes were written in this session."
                      machineLabel={workCenterName}
                      onDelete={canDeleteNote ? (n) => setRemoving({ kind: 'note', id: n.id, label: `the note by ${n.authorName}` }) : undefined}
                      deleting={saving}
                    />
                  )}
                </Section>
              </>
            )}

            {!editable && (
              <p className="flex items-center gap-2 rounded-2xl bg-slate-50 px-4 py-3 text-sm text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
                <Lock className="h-4 w-4 shrink-0" />
                {openSession.status === 'Closed'
                  ? 'This session is closed. A supervisor can still correct it — every correction is audited.'
                  : 'Your role can view this record but not correct it.'}
              </p>
            )}
          </div>
        )}
      </Modal>

      <Modal
        open={removing !== null}
        onClose={() => {
          if (!saving) setRemoving(null)
        }}
        title={removing ? `Delete ${removing.label}?` : 'Delete'}
        icon={<Trash2 className="h-5 w-5" />}
        size="sm"
        footer={
          <>
            <Button className="min-h-[48px]" onClick={() => setRemoving(null)} disabled={saving}>
              Keep it
            </Button>
            <Button variant="danger" className="min-h-[48px]" onClick={() => void confirmRemove()} disabled={saving}>
              <Trash2 className="h-4 w-4" /> Delete
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-600 dark:text-slate-300">
          It is marked as deleted and leaves every list and count. Nothing is erased: the measurements, defects and photos stay in the record,
          and this deletion is written to the audit log with your name.
        </p>
      </Modal>

      {correctingQty && <SessionQuantitiesDialog session={correctingQty} onClose={() => setCorrectingQty(null)} />}
      <SessionGroupModal spec={groupSpec} onClose={() => setGroupSpec(null)} onOpenSession={openFromGroup} />
      {editingDim && <DimensionEditDialog dimension={editingDim} saving={saving} onClose={() => setEditingDim(null)} onSave={(actual) => saveDimension(editingDim, actual)} />}

      {editingDefect && openSession && <DefectEditDialog defect={editingDefect} workCenterCode={openSession.workCenterCode} saving={saving} onClose={() => setEditingDefect(null)} onSave={(patch) => saveDefect(editingDefect, patch)} />}
    </div>
  )
}

// ---- Sample detail ---------------------------------------------------------

// ---- Correction dialogs ----------------------------------------------------
