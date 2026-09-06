import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
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
  Package2,
  Pencil,
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
import { useHistory, useMaster, useSampleDetail, useSessionSamples } from '@/services/queries'
import { correctDefect, correctDimension } from '@/services/mutations'
import { useAuth } from '@/store/AuthContext'
import { useApp } from '@/store/AppContext'
import { can, dimensionStatus, processForMachine, shiftName } from '@/domain'
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
import type { SessionWithOrder } from '@qc/shared/api'

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

type StatusFilter = 'All' | 'Open' | 'Closed'
type RangeFilter = 'all' | '7' | '30' | '90'

/** How many sessions the list holds. Stated in the UI — never a silent cut. */
const SESSION_PAGE = 100

const RANGE_LABEL: Record<RangeFilter, string> = {
  all: 'All time',
  '7': 'Last 7 days',
  '30': 'Last 30 days',
  '90': 'Last 90 days',
}


export function HistoryPage() {
  const queryClient = useQueryClient()
  const { role } = useAuth()
  const { toast } = useApp()
  const [params, setParams] = useSearchParams()

  const [term, setTerm] = useState('')
  const [status, setStatus] = useState<StatusFilter>('All')
  const [workCenter, setWorkCenter] = useState('all')
  const [range, setRange] = useState<RangeFilter>('all')

  const [openSessionId, setOpenSessionId] = useState<string | null>(null)
  const [openSampleId, setOpenSampleId] = useState<string | null>(null)
  const [editingDim, setEditingDim] = useState<DimensionResult | null>(null)
  const [editingDefect, setEditingDefect] = useState<DefectResult | null>(null)
  const [saving, setSaving] = useState(false)

  /** The Inspections page links here as `/history?disposition=Hold` so a
   *  supervisor lands straight on the sessions that still owe a decision. */
  const dispositionParam = params.get('disposition')
  const dispositionFilter = (DISPOSITIONS as readonly string[]).includes(dispositionParam ?? '') ? (dispositionParam as Disposition) : null

  // ---- The list ------------------------------------------------------------
  // One page of the newest sessions (or those owning a defect with the landing
  // disposition), each with its order. The filters below narrow this page.
  const { data: history, isLoading: loading } = useHistory(dispositionFilter, SESSION_PAGE)
  const sessions = useMemo(() => history?.sessions ?? [], [history])

  // Master data — the work-centre names come from nowhere else.
  const { data: machines = [] } = useMaster('machines')

  // ---- The drill-down ------------------------------------------------------
  // Children load for what is open and nothing else.
  const { data: samples = [], isLoading: samplesLoading } = useSessionSamples(openSessionId)
  const { data: detail, isLoading: sampleLoading } = useSampleDetail(openSampleId)

  /** The open session's samples, in the order they were taken. */
  const sessionSamples = useMemo(() => [...samples].sort((a, b) => a.index - b.index), [samples])

  const workCenterName = (code: string) => machines.find((m) => m.code === code)?.displayName ?? `Machine ${code}`

  const workCenterOptions = useMemo(() => {
    const codes = Array.from(new Set(sessions.map((s) => s.workCenterCode))).filter(Boolean)
    return codes.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  }, [sessions])

  // The API hands an inspector only their own sessions; a supervisor or
  // administrator gets everyone's and may narrow by who and where.
  const seesAll = can(role, 'view-all-sessions')
  const [inspectorFilter, setInspectorFilter] = useState('all')
  const [factoryFilter, setFactoryFilter] = useState('all')
  const factoryOf = useCallback((code: string) => machines.find((m) => m.code === code)?.factory?.trim() ?? '', [machines])
  const inspectorOptions = useMemo(() => {
    const byId = new Map<string, string>()
    for (const s of sessions) byId.set(s.inspectorId, s.inspectorName)
    return Array.from(byId, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
  }, [sessions])
  const factoryOptions = useMemo(() => {
    const names = new Set<string>()
    for (const s of sessions) {
      const f = machines.find((m) => m.code === s.workCenterCode)?.factory?.trim()
      if (f) names.add(f)
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b))
  }, [sessions, machines])

  const filtered = useMemo(() => {
    const t = term.trim().toLowerCase()
    const since = range === 'all' ? null : daysAgoISO(Number(range))
    return sessions
      .filter((s) => {
        if (status !== 'All' && s.status !== status) return false
        if (workCenter !== 'all' && s.workCenterCode !== workCenter) return false
        if (inspectorFilter !== 'all' && s.inspectorId !== inspectorFilter) return false
        if (factoryFilter !== 'all' && factoryOf(s.workCenterCode) !== factoryFilter) return false
        if (since && s.startedAt < since) return false
        if (!t) return true
        return (
          (s.order?.orderNumber ?? '').toLowerCase().includes(t) ||
          (s.order?.item ?? '').toLowerCase().includes(t) ||
          (s.order?.itemCode ?? '').toLowerCase().includes(t) ||
          s.inspectorName.toLowerCase().includes(t)
        )
      })
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : b.seq - a.seq))
  }, [sessions, term, status, workCenter, range, inspectorFilter, factoryFilter, factoryOf])

  const totals = useMemo(() => {
    let open = 0
    for (const s of filtered) if (s.status === 'Open') open += 1
    return { sessions: filtered.length, open, closed: filtered.length - open }
  }, [filtered])

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
          sub={dispositionFilter ? `Dispositioned ${dispositionFilter}` : `Of the last ${SESSION_PAGE}`}
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
            placeholder="Order number, item or inspector…"
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
      </Card>

      {loading ? (
        <Card className="p-10 text-center text-sm text-slate-400">Loading…</Card>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<HistoryIcon className="h-10 w-10" />}
          title="No sessions match"
          hint={dispositionFilter ? `Nothing is currently dispositioned ${dispositionFilter}.` : 'Widen the date range or clear the search to see more.'}
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
                  <span className="font-bold">{s.order?.orderNumber ?? '—'}</span>
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
                      <td className="px-4 py-3 font-bold">{s.order?.orderNumber ?? '—'}</td>
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
              {openSample && <span className="text-sm font-semibold text-brand-600 dark:text-brand-400">· Sample #{openSample.index}</span>}
            </span>
          ) : null
        }
        footer={
          <Button className="min-h-[48px]" onClick={closeDrilldown}>
            Close
          </Button>
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
                  <Attr label="Rejected qty before release" value={openSession.startQtyConfirmed?.qty} />
                  <Attr label="Final qty" value={openSession.finalQty} />
                  <Attr label="Closed" value={openSession.closedAt ? formatDateTime(openSession.closedAt) : '—'} />
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
                        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-100 text-sm font-bold tabular-nums text-brand-700 dark:bg-brand-500/15 dark:text-brand-300">
                          #{sm.index}
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

      {editingDim && <DimensionEditDialog dimension={editingDim} saving={saving} onClose={() => setEditingDim(null)} onSave={(actual) => saveDimension(editingDim, actual)} />}

      {editingDefect && <DefectEditDialog defect={editingDefect} saving={saving} onClose={() => setEditingDefect(null)} onSave={(patch) => saveDefect(editingDefect, patch)} />}
    </div>
  )
}

// ---- Sample detail ---------------------------------------------------------

// ---- Correction dialogs ----------------------------------------------------

function DimensionEditDialog({
  dimension,
  saving,
  onClose,
  onSave,
}: {
  dimension: DimensionResult
  saving: boolean
  onClose: () => void
  onSave: (actual: number | null) => void
}) {
  const [value, setValue] = useState(dimension.actual === null ? '' : String(dimension.actual))
  const trimmed = value.trim()
  const parsed = trimmed === '' ? null : Number(trimmed)
  const valid = parsed === null || !Number.isNaN(parsed)
  const preview = dimensionStatus({ nominal: dimension.nominal, tolPlus: dimension.tolPlus, tolMinus: dimension.tolMinus, actual: valid ? parsed : null })

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      icon={<Ruler className="h-5 w-5" />}
      title="Correct measurement"
      footer={
        <>
          <Button variant="ghost" className="min-h-[48px]" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" className="min-h-[48px]" disabled={!valid || saving} onClick={() => onSave(parsed)}>
            {saving ? 'Saving…' : 'Save correction'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <dl className="grid grid-cols-3 gap-3 rounded-2xl bg-slate-50 p-3 dark:bg-slate-800/60">
          <Attr label="Dimension" value={dimension.name} />
          <Attr label="Nominal" value={dimension.nominal} />
          <Attr label="Tolerance" value={`+${num(dimension.tolPlus)} / -${num(dimension.tolMinus)}`} />
        </dl>
        <Field label={`Actual${dimension.unit ? ` (${dimension.unit})` : ''}`} hint="Leave empty to clear the measurement. The change is written to the audit log.">
          <Input autoFocus type="number" step="any" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} className="min-h-[48px] text-lg tabular-nums" />
        </Field>
        <p className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
          New status: <Badge tone={statusToneOf(preview)}>{preview}</Badge>
        </p>
      </div>
    </Modal>
  )
}

function DefectEditDialog({
  defect,
  saving,
  onClose,
  onSave,
}: {
  defect: DefectResult
  saving: boolean
  onClose: () => void
  onSave: (patch: { disposition: Disposition; qty: number }) => void
}) {
  const [disposition, setDisposition] = useState<Disposition | ''>(defect.disposition ?? '')
  const [qty, setQty] = useState(String(defect.qty))
  const parsedQty = Number(qty)
  const valid = disposition !== '' && qty.trim() !== '' && !Number.isNaN(parsedQty) && parsedQty > 0

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      icon={<AlertTriangle className="h-5 w-5" />}
      title="Correct defect"
      footer={
        <>
          <Button variant="ghost" className="min-h-[48px]" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" className="min-h-[48px]" disabled={!valid || saving} onClick={() => valid && onSave({ disposition: disposition as Disposition, qty: parsedQty })}>
            {saving ? 'Saving…' : 'Save correction'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="font-bold" dir="auto">
          {defect.defectName}
        </p>
        <Field label="Disposition" hint="A defect can never be left without one (§8.5).">
          <Select value={disposition} onChange={(e) => setDisposition(e.target.value as Disposition | '')} className="min-h-[48px]">
            <option value="">Choose a disposition…</option>
            {DISPOSITIONS.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Quantity" hint="Must be greater than zero.">
          <Input type="number" inputMode="numeric" min={1} value={qty} onChange={(e) => setQty(e.target.value)} className="min-h-[48px] text-lg tabular-nums" />
        </Field>
      </div>
    </Modal>
  )
}
