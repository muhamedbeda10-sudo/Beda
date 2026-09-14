import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowLeft,
  ChevronRight,
  ClipboardList,
  Droplets,
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
} from 'lucide-react'
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Select, Stat } from '@/components/ui'
import { ImagePicker } from '@/components/inspection/ImagePicker'
import { SessionToneBadge, sessionToneClass } from '@/components/inspection/SessionTone'
import { Attr, SampleDetail, Section, SectionEmpty, dispositionToneOf, num, statusToneOf } from '@/components/inspection/SampleDetail'
import { DefectEditDialog, DimensionEditDialog } from '@/components/inspection/CorrectionDialogs'
import { SessionQuantitiesDialog } from '@/components/inspection/SessionQuantitiesDialog'
import { OrderNoteList } from '@/components/inspection/OrderNotes'
import { loadOlderSessions, useDebounced, useHistory, useHistoryOptions, useMaster, useSampleDetail, useSessionNotes, useSessionSamples } from '@/services/queries'
import { correctDefect, correctDimension, deleteNote, deleteSample, deleteSession, reopenSession } from '@/services/mutations'
import { usePersistedState } from '@/lib/usePersistedState'
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
type RangeFilter = 'all' | '7' | '30' | '90'

/** How many sessions one page holds. The filters are answered over the whole
 *  record, so this bounds what is fetched, never what can be found. */
const SESSION_PAGE = 100

const RANGE_LABEL: Record<RangeFilter, string> = {
  all: 'All time',
  '7': 'Last 7 days',
  '30': 'Last 30 days',
  '90': 'Last 90 days',
}


export function HistoryPage() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { role } = useAuth()
  const { toast } = useApp()
  const [params, setParams] = useSearchParams()

  // The filters are kept on this device: leaving for another tab and coming
  // back finds them where they were left, as on every list in the app.
  const [term, setTerm] = usePersistedState('qc-history:term', '')
  const [olderHasMore, setOlderHasMore] = useState(false)
  const [status, setStatus] = usePersistedState<StatusFilter>('qc-history:status', 'All')
  const [workCenter, setWorkCenter] = usePersistedState('qc-history:machine', 'all')
  const [range, setRange] = usePersistedState<RangeFilter>('qc-history:range', 'all')
  const [inspectorFilter, setInspectorFilter] = usePersistedState('qc-history:inspector', 'all')
  const [factoryFilter, setFactoryFilter] = usePersistedState('qc-history:factory', 'all')

  const [openSessionId, setOpenSessionId] = useState<string | null>(null)
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
    if (range !== 'all') f.since = daysAgoISO(Number(range))
    if (dispositionFilter) f.disposition = dispositionFilter
    else if (status === 'Hold') f.disposition = 'Hold'
    return f
  }, [settledTerm, status, workCenter, inspectorFilter, factoryFilter, range, dispositionFilter])

  const { data: history, isLoading: loading, isFetching } = useHistory(filters, SESSION_PAGE)
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

  // The lists a filter may offer come from the record, not from the page on
  // screen — an inspector who last worked a year ago is still in the list.
  const { data: options } = useHistoryOptions()
  const workCenterOptions = options?.workCenterCodes ?? []
  const inspectorOptions = options?.inspectors ?? []

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

  const openSession = openSessionId ? (sessions.find((s) => s.id === openSessionId) ?? null) : null
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

  async function saveDefect(defect: DefectResult, patch: { disposition: Disposition; qty: number }) {
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

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight">History</h1>
      </div>

      <div className="grid grid-cols-3 gap-2 sm:gap-3">
        <Stat
          compact
          label="Sessions"
          value={totals.sessions}
          sub={totals.sessions > filtered.length ? `${filtered.length} on screen, the rest below` : 'All of them on screen'}
          icon={<HistoryIcon className="h-5 w-5" />}
        />
        <Stat compact label="Open" value={totals.open} tone={totals.open > 0 ? 'green' : 'neutral'} icon={<ClipboardList className="h-5 w-5" />} />
        <Stat compact label="Closed" value={totals.closed} tone="neutral" icon={<Lock className="h-5 w-5" />} />
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
        <div className={cn('grid grid-cols-2 gap-3 sm:grid-cols-3', seesAll && 'lg:grid-cols-5')}>
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
        {isFetching && !loading && <p className="text-xs text-slate-400">Searching the whole record…</p>}
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

          {/* md+ — the same rows as a table. */}
          <Card className="hidden md:block">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px] text-sm">
                <thead>
                  <tr className="border-b border-slate-100 text-left text-xs font-bold uppercase tracking-wide text-slate-400 dark:border-slate-800">
                    <th className="px-4 py-3">Seq</th>
                    <th className="px-4 py-3">Order</th>
                    <th className="px-4 py-3">Item</th>
                    <th className="px-4 py-3">Machine</th>
                    <th className="px-4 py-3">Inspector</th>
                    <th className="px-4 py-3">Date</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3 text-right">Samples</th>
                    <th className="px-4 py-3 text-right">Rejected before release</th>
                    <th className="px-4 py-3 text-right">Final qty</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {filtered.map((s) => (
                    <tr
                      key={s.id}
                      onClick={() => setOpenSessionId(s.id)}
                      className={cn('cursor-pointer transition-colors', sessionToneClass(s, 'row', 'hover:bg-slate-50 dark:hover:bg-slate-800/50'))}
                    >
                      <td className="px-4 py-3 tabular-nums text-slate-400">#{s.seq}</td>
                      <td className="px-4 py-3 font-bold">{isStockOrder(s.order) ? <Badge tone="violet">For stock</Badge> : (s.order?.orderNumber ?? '—')}</td>
                      <td className="max-w-[220px] truncate px-4 py-3">{s.order?.item ?? '—'}</td>
                      <td className="px-4 py-3">{workCenterName(s.workCenterCode)}</td>
                      <td className="px-4 py-3">{s.inspectorName}</td>
                      <td className="px-4 py-3 tabular-nums">{formatDate(s.startedAt)}</td>
                      <td className="px-4 py-3">
                        <span className="inline-flex flex-wrap items-center gap-1.5">
                          <Badge tone={s.status === 'Open' ? 'green' : 'neutral'}>{s.status}</Badge>
                          <SessionToneBadge session={s} />
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">{num(s.sampleCount)}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{num(s.startQtyConfirmed?.qty)}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{num(s.finalQty)}</td>
                      <td className="px-4 py-3 text-right">
                        <ChevronRight className="ml-auto h-4 w-4 text-slate-400" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
                  <Attr label="Closed" value={openSession.closedAt ? formatDateTime(openSession.closedAt) : '—'} />
                  <Attr label="Closed by" value={openSession.closedByName ?? (openSession.closedAt ? 'Unknown' : '—')} />
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
      {editingDim && <DimensionEditDialog dimension={editingDim} saving={saving} onClose={() => setEditingDim(null)} onSave={(actual) => saveDimension(editingDim, actual)} />}

      {editingDefect && <DefectEditDialog defect={editingDefect} saving={saving} onClose={() => setEditingDefect(null)} onSave={(patch) => saveDefect(editingDefect, patch)} />}
    </div>
  )
}

// ---- Sample detail ---------------------------------------------------------

// ---- Correction dialogs ----------------------------------------------------
