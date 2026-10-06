import { useCallback, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import {
  Plus,
  Search,
  FileText,
  Factory,
  Play,
  ChevronDown,
  ChevronUp,
  Boxes,
  Lock,
  CheckCircle2,
  ClipboardCheck,
  MessageSquareText,
  ChevronRight,
  Star,
  LayoutGrid,
  LayoutList,
  Table2,
} from 'lucide-react'
import { Badge, Button, Card, Field, Input, Modal } from '@/components/ui'
import { FilterBar, FilterSelect, Segmented } from '@/components/ui/PageShell'
import { RecentlyClosed } from '@/components/inspection/RecentlyClosed'
import { NewInspectionDialog } from '@/components/inspection/NewInspectionDialog'
import { PtCoverageBadge, SessionToneBadge, ptCoverageText, sessionToneClass } from '@/components/inspection/SessionTone'
import { SampleDetail } from '@/components/inspection/SampleDetail'
import { DefectEditDialog, DimensionEditDialog, type DefectCorrection } from '@/components/inspection/CorrectionDialogs'
import { SessionQuantitiesDialog } from '@/components/inspection/SessionQuantitiesDialog'
import { HoldDecisionDialog } from '@/components/inspection/HoldDecisionDialog'
import { OrderDetailsPanel } from '@/components/inspection/OrderDetailsPanel'
import { InstallBanner } from '@/components/layout/InstallBanner'
import { useMaster, useOpenBoard, useSampleDetail, useSessionStages } from '@/services/queries'
import { UniversalChoice, readUniversalDraft, universalDraft, type UniversalDraft } from '@/components/inspection/UniversalChoice'
import { closeSession, correctDefect, correctDimension, discardSession } from '@/services/mutations'
import { useAuth } from '@/store/AuthContext'
import { useApp } from '@/store/AppContext'
import { can, isStockOrder, processForMachine, sessionTone, shiftName, type Process, type SessionTone } from '@/domain'
import { cn } from '@/lib/utils'
import { usePersistedState } from '@/lib/usePersistedState'
import type { CloseSessionRequest, SampleSummary, SessionWithOrder } from '@qc/shared/api'
import type { DefectResult, DimensionResult, Disposition, Machine } from '@qc/shared/types'
import { When } from '@/components/ui/Tooltip'

const COLLAPSE_AFTER = 3
/** Sessions on a machine without a factory gather under this tab. */
const NO_FACTORY = '__none__'
/** Machines are ordered by the worst thing on them: Hold before defects before the rest. */
const TONE_RANK: Record<NonNullable<SessionTone> | 'none', number> = { hold: 0, defect: 1, prior: 2, none: 3 }

interface MachineGroup {
  code: string
  machine?: Machine
  label: string
  factory: string
  sessions: SessionWithOrder[]
  sampleCount: number
  tone: SessionTone
  latest: string
}

export function InspectionsPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { role } = useAuth()
  // A viewer reads the board: no new inspection, no continue, no close.
  const canRecord = can(role, 'record-inspection')
  const { toast } = useApp()

  // Only the open sessions — this screen exists to answer "what is open now".
  // The API returns them with their orders and samples in one round trip.
  const { data: board, isLoading } = useOpenBoard()
  const { data: machines = [] } = useMaster('machines')
  const openSessions = board?.sessions ?? []
  const samples = board?.samples ?? []

  const [newOpen, setNewOpen] = useState(false)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  /** The session whose order is open in full, in the side panel. */
  const [details, setDetails] = useState<SessionWithOrder | null>(null)

  // ---- How this device likes the board (kept across shifts) ----------------
  const [factoryTab, setFactoryTab] = usePersistedState<string>('qc-board:factory', 'all')
  const [machinePick, setMachinePick] = usePersistedState<string>('qc-board:machine', 'all')
  const [collapsed, setCollapsed] = usePersistedState<Record<string, boolean>>('qc-board:collapsed', {})
  const [favourite, setFavourite] = usePersistedState<string | null>('qc-board:favourite', null)
  const [density, setDensity] = usePersistedState<'cards' | 'compact' | 'table'>('qc-board:density', 'cards')

  // ---- Who sees what (§14) ------------------------------------------------
  // The board is everyone's: every open session, with an inspector filter so
  // a technician can narrow it to their own name. The board has no search: a
  // shift's open sessions are found by factory and machine at a glance.
  const seesAll = true
  const [inspectorFilter, setInspectorFilter] = usePersistedState('qc-board:inspector', 'all')

  const machineOf = useMemo(() => new Map(machines.map((m) => [m.code, m])), [machines])
  const machineLabel = useCallback(
    (code: string) => {
      const m = machineOf.get(code)
      return m?.displayName || m?.name || `Machine ${code}`
    },
    [machineOf],
  )
  const factoryOf = useCallback((code: string) => machineOf.get(code)?.factory?.trim() || NO_FACTORY, [machineOf])

  const inspectorOptions = useMemo(() => {
    const byId = new Map<string, string>()
    for (const s of openSessions) byId.set(s.inspectorId, s.inspectorName)
    return Array.from(byId, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
  }, [openSessions])

  /** Sessions after the inspector filter; the factory tabs count these. */
  const base = useMemo(() => (!seesAll || inspectorFilter === 'all' ? openSessions : openSessions.filter((s) => s.inspectorId === inspectorFilter)), [seesAll, openSessions, inspectorFilter])

  /** Every factory in the register, with how many open sessions it holds now. */
  const factoryTabs = useMemo(() => {
    const counts = new Map<string, number>()
    for (const m of machines) {
      const f = m.factory?.trim()
      if (f) counts.set(f, 0)
    }
    let unassigned = 0
    for (const s of base) {
      const f = factoryOf(s.workCenterCode)
      if (f === NO_FACTORY) unassigned++
      else counts.set(f, (counts.get(f) ?? 0) + 1)
    }
    const tabs = Array.from(counts, ([name, count]) => ({ key: name, label: name, count })).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))
    if (unassigned > 0) tabs.push({ key: NO_FACTORY, label: 'No factory', count: unassigned })
    return tabs
  }, [machines, base, factoryOf])
  const factoryKnown = factoryTab === 'all' || factoryTabs.some((t) => t.key === factoryTab)
  const activeFactory = factoryKnown ? factoryTab : 'all'

  /** Sessions in the chosen factory; the machine chips count these. */
  const inFactory = useMemo(() => (activeFactory === 'all' ? base : base.filter((s) => factoryOf(s.workCenterCode) === activeFactory)), [base, activeFactory, factoryOf])

  const samplesBySession = useMemo(() => {
    const m = new Map<string, SampleSummary[]>()
    for (const s of samples) {
      const arr = m.get(s.sessionId) ?? []
      arr.push(s)
      m.set(s.sessionId, arr)
    }
    return m
  }, [samples])

  /** One group per machine with open sessions: the worst signal on it decides its place. */
  const groupsInFactory = useMemo<MachineGroup[]>(() => {
    const byWc = new Map<string, MachineGroup>()
    for (const s of [...inFactory].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))) {
      const machine = machineOf.get(s.workCenterCode)
      const g = byWc.get(s.workCenterCode) ?? {
        code: s.workCenterCode,
        machine,
        label: machineLabel(s.workCenterCode),
        factory: factoryOf(s.workCenterCode),
        sessions: [],
        sampleCount: 0,
        tone: null,
        latest: s.startedAt,
      }
      g.sessions.push(s)
      g.sampleCount += samplesBySession.get(s.id)?.length ?? 0
      const tone = sessionTone(s)
      if (TONE_RANK[tone ?? 'none'] < TONE_RANK[g.tone ?? 'none']) g.tone = tone
      if (s.startedAt > g.latest) g.latest = s.startedAt
      byWc.set(s.workCenterCode, g)
    }
    return Array.from(byWc.values()).sort((a, b) => {
      // The machine this device watches comes first, whatever its state.
      if (a.code === favourite) return -1
      if (b.code === favourite) return 1
      const rank = TONE_RANK[a.tone ?? 'none'] - TONE_RANK[b.tone ?? 'none']
      if (rank !== 0) return rank
      return a.latest < b.latest ? 1 : -1
    })
  }, [inFactory, machineOf, machineLabel, factoryOf, samplesBySession, favourite])

  const machinePickKnown = machinePick === 'all' || groupsInFactory.some((g) => g.code === machinePick)
  const activeMachine = machinePickKnown ? machinePick : 'all'
  const groups = activeMachine === 'all' ? groupsInFactory : groupsInFactory.filter((g) => g.code === activeMachine)

  /**
   * The board as frames: the pinned machine first, in a frame of its own,
   * then one frame per factory in the register's order, each holding its
   * machines in the order the worst signal gives them.
   */
  const sections = useMemo(() => {
    const pinned = groups.filter((g) => g.code === favourite)
    const byFactory = new Map<string, MachineGroup[]>()
    for (const g of groups) {
      if (g.code === favourite) continue
      byFactory.set(g.factory, [...(byFactory.get(g.factory) ?? []), g])
    }
    const out: { key: string; label: string; groups: MachineGroup[]; pinned: boolean }[] = []
    if (pinned.length > 0) out.push({ key: '__pinned__', label: 'My machine', groups: pinned, pinned: true })
    const ordered = [...factoryTabs.map((t) => t.key), ...byFactory.keys()].filter((k, i, all) => all.indexOf(k) === i)
    for (const key of ordered) {
      const gs = byFactory.get(key)
      if (gs?.length) out.push({ key, label: key === NO_FACTORY ? 'No factory' : key, groups: gs, pinned: false })
    }
    return out
  }, [groups, favourite, factoryTabs])

  const narrowed = seesAll && inspectorFilter !== 'all'
  const filtering = narrowed || activeFactory !== 'all' || activeMachine !== 'all'

  const [closing, setClosing] = useState<SessionWithOrder | null>(null)
  /** §4 — the session whose quantities are being corrected. */
  const [correctingQty, setCorrectingQty] = useState<SessionWithOrder | null>(null)
  /** §7 — the session whose Holds are being decided from the badge. */
  const [holdFor, setHoldFor] = useState<SessionWithOrder | null>(null)
  /** Who may change a defect's decision here: the same rule as any correction. */
  const mayDecide = (s: SessionWithOrder) => (s.holdCount ?? 0) > 0 && (s.status === 'Open' ? can(role, 'edit-open-session') : can(role, 'edit-closed-session'))
  /** A sample opened from its chip on the card: the full record, read-only here. */
  const [viewing, setViewing] = useState<{ session: SessionWithOrder; sample: SampleSummary } | null>(null)
  const { data: viewingDetail, isLoading: viewingLoading } = useSampleDetail(viewing?.sample.id ?? null)
  /** §14 — an open session's sample is corrected by an inspector, a closed one's by a supervisor; the API enforces the same. */
  const viewingEditable = viewing ? (viewing.session.status === 'Open' ? can(role, 'edit-open-session') : can(role, 'edit-closed-session')) : false
  const [editingDim, setEditingDim] = useState<DimensionResult | null>(null)
  const [editingDefect, setEditingDefect] = useState<DefectResult | null>(null)
  const [correcting, setCorrecting] = useState(false)

  async function saveDimension(dim: DimensionResult, actual: number | null) {
    setCorrecting(true)
    try {
      await correctDimension(queryClient, dim.id, { actual, version: dim.version })
      toast('Measurement corrected. The change is in the audit log.', 'success')
      setEditingDim(null)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save the correction.', 'error')
    } finally {
      setCorrecting(false)
    }
  }

  async function saveDefect(defect: DefectResult, patch: DefectCorrection) {
    setCorrecting(true)
    try {
      await correctDefect(queryClient, defect.id, { ...patch, version: defect.version })
      toast('Defect corrected. The change is in the audit log.', 'success')
      setEditingDefect(null)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save the correction.', 'error')
    } finally {
      setCorrecting(false)
    }
  }

  // ---- The board's two renderings of a set of machines ---------------------
  // Each frame below hands its machines to one of these; the factory name on
  // a machine is shown only where the frame does not already say it.
  const boardTable = (secs: typeof sections) => (
    // Every open session in one table: a header row per factory, then its machines in the same order as the cards.
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[60rem] text-sm">
          <thead className="bg-slate-50 text-left text-[11px] font-semibold uppercase tracking-wide text-muted dark:bg-slate-800/60">
            <tr>
              <th className="px-4 py-3">Machine</th>
              <th className="px-4 py-3">Order</th>
              <th className="px-4 py-3">Item</th>
              <th className="px-4 py-3">Inspector</th>
              <th className="px-4 py-3">Started</th>
              <th className="px-4 py-3 text-right">Samples</th>
              <th className="px-4 py-3 text-right">Defects</th>
              <th className="px-4 py-3">State</th>
              <th className="px-4 py-3"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          {secs.map((sec) => {
            const showFactory = sec.pinned
            const sessionCount = sec.groups.reduce((n, g) => n + g.sessions.length, 0)
            return (
              <tbody key={sec.key} className="divide-y divide-slate-100 border-t border-slate-200 dark:divide-slate-800 dark:border-slate-700">
                <tr className="bg-slate-100/80 dark:bg-slate-800/70">
                  <th colSpan={9} scope="colgroup" className="px-4 py-1.5 text-left text-xs font-bold uppercase tracking-wide text-muted">
                    <span className="inline-flex items-center gap-2">
                      {sec.pinned ? <Star className="h-3.5 w-3.5 fill-current text-amber-500" /> : <Factory className="h-3.5 w-3.5" />}
                      {sec.label}
                      <span className="font-semibold normal-case tracking-normal tabular-nums">
                        · {sec.groups.length} machine{sec.groups.length === 1 ? '' : 's'} · {sessionCount} session{sessionCount === 1 ? '' : 's'}
                      </span>
                    </span>
                  </th>
                </tr>
                {sec.groups.flatMap((g) =>
                  g.sessions.map((s) => {
                const order = s.order
                    const count = samplesBySession.get(s.id)?.length ?? 0
                    return (
                      <tr key={s.id} onClick={() => setDetails(s)} className={cn('cursor-pointer transition-colors', sessionToneClass(s, 'row', 'hover:bg-slate-50 dark:hover:bg-slate-800/50'))}>
                        <td className="px-4 py-2.5">
                          <span className="flex items-center gap-1.5 font-semibold">
                            {g.code === favourite && <Star className="h-3.5 w-3.5 fill-current text-amber-500" />}
                            {g.label}
                          </span>
                          {showFactory && g.factory !== NO_FACTORY && <span className="block text-xs text-muted">{g.factory}</span>}
                        </td>
                        <td className="px-4 py-2.5 font-bold">
                          {isStockOrder(order) ? <Badge tone="violet">For stock</Badge> : (order?.orderNumber ?? '—')}
                          <span className="ml-1.5 text-xs font-bold tabular-nums text-muted">#{s.seq}</span>
                        </td>
                        <td className="max-w-[220px] truncate px-4 py-2.5">
                          <span className="block truncate">{order?.item ?? '—'}</span>
                          <span className="block truncate font-mono text-xs text-muted">{order?.itemCode ?? ''}</span>
                        </td>
                        <td className="px-4 py-2.5">{s.inspectorName}</td>
                        <td className="px-4 py-2.5 tabular-nums text-muted"><When iso={s.startedAt} time /></td>
                        <td className="px-4 py-2.5 text-right tabular-nums">{count}</td>
                        <td className={cn('px-4 py-2.5 text-right tabular-nums', (s.defectCount ?? 0) > 0 && 'font-bold text-rose-600 dark:text-rose-400')}>{s.defectCount ?? 0}</td>
                        <td className="px-4 py-2.5">
                          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                            {s.status === 'Open' ? <Badge tone="green">OPEN</Badge> : <Badge tone="neutral" icon={<Lock className="h-3 w-3" />}>CLOSED</Badge>}
                            <SessionToneBadge session={s} onHold={mayDecide(s) ? () => setHoldFor(s) : undefined} />
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          {s.status === 'Open' && canRecord && (
                            <Button
                              variant="primary"
                              className="min-h-[36px] px-3 py-1.5 touch:min-h-[44px]"
                              onClick={(e) => {
                                e.stopPropagation()
                                navigate(`/wizard/${s.id}`)
                              }}
                            >
                              <Play className="h-4 w-4" /> Continue
                            </Button>
                          )}
                        </td>
                      </tr>
                    )
                  }),
                )}
              </tbody>
            )
          })}
        </table>
      </div>
    </Card>
  )

  const machineCards = (gs: MachineGroup[], showFactory: boolean) => (
    // Several machines side by side on a wide screen; one column on a phone.
    <div className={cn('grid items-start gap-4', density === 'cards' ? 'grid-cols-1 md:grid-cols-2 xl:grid-cols-3' : 'grid-cols-1 xl:grid-cols-2')}>
      {gs.map((g) => {
        const isCollapsed = collapsed[g.code] === true
        const isExpanded = expanded[g.code]
        const visible = isExpanded || density === 'compact' ? g.sessions : g.sessions.slice(0, COLLAPSE_AFTER)
        const hidden = g.sessions.length - visible.length
        const isFavourite = g.code === favourite
        return (
          <Card key={g.code} className={cn('overflow-hidden', isFavourite && 'ring-2 ring-brand-300 dark:ring-brand-500/50')}>
            <div className="flex items-center gap-3 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
              <button
                type="button"
                onClick={() => setCollapsed((c) => ({ ...c, [g.code]: !isCollapsed }))}
                aria-expanded={!isCollapsed}
                aria-label={isCollapsed ? `Expand ${g.label}` : `Collapse ${g.label}`}
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
              >
                <span
                  className={cn(
                    'grid h-10 w-10 shrink-0 place-items-center rounded-xl',
                    g.tone === 'hold'
                      ? 'bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400'
                      : g.tone === 'defect'
                        ? 'bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-400'
                        : 'bg-brand-100 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300',
                  )}
                >
                  <Factory className="h-5 w-5" />
                </span>
                <span className="min-w-0 flex-1">
                  {/* The full machine name, on two lines if it must; the counts sit under it so a narrow column never clips it. */}
                  <span className="line-clamp-2 text-base font-extrabold leading-tight" data-tip={g.label}>
                    {g.label}
                  </span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted">
                    {showFactory && g.factory !== NO_FACTORY && <span>{g.factory}</span>}
                    <span className="tabular-nums">
                      {g.sessions.length} session{g.sessions.length === 1 ? '' : 's'} · {g.sampleCount} sample{g.sampleCount === 1 ? '' : 's'}
                    </span>
                  </span>
                </span>
                {isCollapsed ? <ChevronDown className="h-4 w-4 shrink-0 text-muted" /> : <ChevronUp className="h-4 w-4 shrink-0 text-muted" />}
              </button>
              <button
                type="button"
                onClick={() => setFavourite(isFavourite ? null : g.code)}
                aria-pressed={isFavourite}
                aria-label={isFavourite ? `Stop pinning ${g.label}` : `Pin ${g.label} as my machine`}
                data-tip={isFavourite ? 'My machine — pinned first on this device' : 'Pin as my machine on this device'}
                className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-xl transition-colors', isFavourite ? 'text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-500/10' : 'text-slate-300 hover:bg-slate-100 hover:text-amber-500 dark:text-slate-600 dark:hover:bg-slate-800')}
              >
                <Star className={cn('h-5 w-5', isFavourite && 'fill-current')} />
              </button>
            </div>

            {!isCollapsed && density === 'compact' ? (
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {visible.map((s) => {
                  const order = s.order
                  const count = samplesBySession.get(s.id)?.length ?? 0
                  return (
                    <li key={s.id} className={cn('flex items-center gap-3 px-4 py-2.5', sessionToneClass(s, 'row'))}>
                      <button type="button" onClick={() => setDetails(s)} className="min-w-0 flex-1 text-left" aria-label={`Order details for ${order?.orderNumber ?? 'this session'}`}>
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          {isStockOrder(order) ? <Badge tone="violet">For stock</Badge> : <span className="font-bold">{order?.orderNumber ?? '—'}</span>}
                          <span className="text-xs font-bold tabular-nums text-muted">#{s.seq}</span>
                          <span className="truncate text-sm text-brand-600 dark:text-brand-400">{order?.item ?? '—'}</span>
                        </span>
                        <span className="block truncate text-xs text-muted">
                          {s.inspectorName} · <When iso={s.startedAt} /> · {count} sample{count === 1 ? '' : 's'}
                          {s.startQtyConfirmed ? ` · rejected before release ${s.startQtyConfirmed.qty}` : ''}
                          {s.producedQty !== undefined ? ` · produced ${s.producedQty} pairs` : ''}
                        </span>
                      </button>
                      <SessionToneBadge session={s} className="hidden sm:inline-flex" onHold={mayDecide(s) ? () => setHoldFor(s) : undefined} />
                      {s.status === 'Open' ? (
                        <Button variant="primary" className={cn('min-h-[40px] shrink-0 touch:min-h-[44px]', !canRecord && 'hidden')} onClick={() => navigate(`/wizard/${s.id}`)} aria-label="Continue">
                          <Play className="h-4 w-4" />
                          <span className="hidden sm:inline">Continue</span>
                        </Button>
                      ) : (
                        <Badge tone="neutral" icon={<Lock className="h-3 w-3" />}>
                          CLOSED
                        </Badge>
                      )}
                    </li>
                  )
                })}
              </ul>
            ) : !isCollapsed ? (
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {visible.map((s) => {
                const order = s.order
                const sessionSamples = samplesBySession.get(s.id) ?? []
                return (
                  <div key={s.id} className={cn('px-4 py-3.5', sessionToneClass(s, 'block'))}>
                    {/* The card's head opens the order in full; buttons and chips keep their own job. */}
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => setDetails(s)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          setDetails(s)
                        }
                      }}
                      className="group -mx-2 -mt-1 cursor-pointer rounded-xl px-2 pt-1 pb-1 transition-colors hover:bg-white/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 dark:hover:bg-slate-800/60"
                      aria-label={`Order details for ${order?.orderNumber ?? 'this session'}`}
                    >
                    <div className="flex flex-wrap items-center gap-2">
                      {isStockOrder(order) ? (
                        <Badge tone="violet">For stock</Badge>
                      ) : (
                        <span className="font-bold">{order?.orderNumber ?? '—'}</span>
                      )}
                      <span className="text-xs font-bold tabular-nums text-muted">#{s.seq}</span>
                      {s.status === 'Open' ? <Badge tone="green">OPEN</Badge> : <Badge tone="neutral" icon={<Lock className="h-3 w-3" />}>CLOSED · stays while on Hold</Badge>}
                      <SessionToneBadge session={s} onHold={mayDecide(s) ? () => setHoldFor(s) : undefined} />
                      <Badge tone="neutral">
                        {sessionSamples.length} sample{sessionSamples.length === 1 ? '' : 's'}
                      </Badge>
                      {s.startQtyConfirmed && (
                        <Badge tone="blue" icon={<CheckCircle2 className="h-3 w-3" />}>
                          Rejected before release {s.startQtyConfirmed.qty}
                        </Badge>
                      )}
                      {s.producedQty !== undefined && (
                        <Badge tone="blue" icon={<Boxes className="h-3 w-3" />}>
                          Produced {s.producedQty} pairs
                        </Badge>
                      )}
                      {(s.noteCount ?? 0) > 0 && (
                        <Badge tone="neutral" icon={<MessageSquareText className="h-3 w-3" />}>
                          {s.noteCount} note{s.noteCount === 1 ? '' : 's'}
                        </Badge>
                      )}
                    </div>
                    <p className="mt-1 truncate text-sm font-medium text-brand-600 dark:text-brand-400">
                      {order?.item} · {order?.itemCode}
                    </p>
                    <p className="mt-0.5 flex items-center gap-1 text-xs text-muted">
                      <span>
                        <When iso={s.startedAt} /> · {s.inspectorName}
                      </span>
                      <span className="ml-auto inline-flex items-center gap-0.5 font-semibold text-brand-600 opacity-70 transition-[opacity,transform] group-hover:translate-x-0.5 group-hover:opacity-100 dark:text-brand-400">
                        Order details <ChevronRight className="h-3.5 w-3.5" />
                      </span>
                    </p>
                    </div>

                    {/* A closed session on Hold is here to be seen, not continued; deleting is an administrator's act, from History. */}
                    {s.status === 'Open' && canRecord && (
                      <div className="mt-2.5 flex items-center justify-end gap-2">
                        <Button variant="primary" className="min-h-[40px] px-5 touch:min-h-[44px]" onClick={() => navigate(`/wizard/${s.id}`)}>
                          <Play className="h-4 w-4" /> Continue
                        </Button>
                        <Button variant="secondary" className="min-h-[40px] touch:min-h-[44px]" onClick={() => setClosing(s)} aria-label="Close session">
                          <Lock className="h-4 w-4" />
                          <span className="hidden sm:inline">Close</span>
                        </Button>
                      </div>
                    )}

                    {sessionSamples.length > 0 && (
                      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
                        <span className="flex items-center gap-1 text-xs font-bold uppercase text-muted">
                          <Boxes className="h-3.5 w-3.5" /> Samples
                        </span>
                        {[...sessionSamples]
                          .sort((a, b) => a.index - b.index)
                          .map((sm) => (
                            <button
                              key={sm.id}
                              type="button"
                              onClick={() => setViewing({ session: s, sample: sm })}
                              className={cn(
                                'min-h-[36px] rounded-lg px-2.5 py-1 text-xs font-semibold ring-1 transition-colors',
                                // The chip wears the sample's worst signal: amber while a defect waits on Hold, red for defects decided, blue when clean.
                                (sm.holdCount ?? 0) > 0
                                  ? 'bg-amber-50 text-amber-800 ring-amber-300 hover:bg-amber-100 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-500/40'
                                  : (sm.defectCount ?? 0) > 0
                                    ? 'bg-rose-50 text-rose-800 ring-rose-300 hover:bg-rose-100 dark:bg-rose-500/15 dark:text-rose-300 dark:ring-rose-500/40'
                                    : 'bg-brand-50 text-brand-700 ring-brand-200 hover:bg-brand-100 dark:bg-brand-500/10 dark:text-brand-300 dark:ring-brand-500/20 dark:hover:bg-brand-500/20',
                              )}
                              aria-label={`Open sample ${sm.index}${(sm.holdCount ?? 0) > 0 ? ', on Hold' : ''}`}
                              data-tip={(sm.holdCount ?? 0) > 0 ? 'A defect in this sample is on Hold' : undefined}
                            >
                              {s.seq}-{sm.index}
                            </button>
                          ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
            ) : null}

            {!isCollapsed && density === 'cards' && hidden > 0 && (
              <button
                onClick={() => setExpanded((e) => ({ ...e, [g.code]: true }))}
                className="flex w-full items-center justify-center gap-1.5 border-t border-slate-100 py-3 text-sm font-semibold text-brand-600 hover:bg-slate-50 dark:border-slate-800 dark:text-brand-400 dark:hover:bg-slate-800/50"
              >
                <ChevronDown className="h-4 w-4" /> View {hidden} more
              </button>
            )}
          </Card>
        )
      })}
    </div>
  )

  function resetFilters() {
    setInspectorFilter('all')
    setFactoryTab('all')
    setMachinePick('all')
  }

  /** A machine chip wears the worst signal on the machine: amber for a Hold, red for defects. */
  const chipTone = (tone: SessionTone, active: boolean) =>
    cn(
      'inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 text-13 font-semibold ring-1 transition-colors touch:h-11',
      active
        ? 'bg-brand-600 text-white ring-brand-600'
        : tone === 'hold'
          ? 'bg-amber-50 text-amber-800 ring-amber-300 hover:bg-amber-100 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/40'
          : tone === 'defect'
            ? 'bg-rose-50 text-rose-800 ring-rose-300 hover:bg-rose-100 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-500/40'
            : 'bg-white text-slate-700 ring-slate-200 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-200 dark:ring-slate-700 dark:hover:bg-slate-800',
    )

  return (
    <div className="space-y-4">
      <InstallBanner />

      {/* No title row: the tab names the page. New Inspection and the other actions sit at the right end; on a phone they head it. */}
      <FilterBar
        actions={
          <>
            {canRecord && (
              <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:items-center">
                <button type="button" onClick={() => setNewOpen(true)} className="btn-primary col-span-2 h-11 min-h-0 px-4 py-0 text-sm sm:order-last sm:h-10 touch:h-11">
                  <Plus className="h-4 w-4" /> New Inspection
                </button>
                <button type="button" onClick={() => navigate('/coils')} aria-label="Coil Search" data-tip="Coil Search" className="btn-secondary h-11 min-h-0 px-3 py-0 text-13 sm:h-10 md:max-2xl:px-2.5 touch:h-11">
                  <Search className="h-4 w-4" /> <span className="md:max-2xl:sr-only">Coil Search</span>
                </button>
                <button type="button" onClick={() => navigate('/pdi')} aria-label="PDI Documents" data-tip="PDI Documents" className="btn-secondary h-11 min-h-0 px-3 py-0 text-13 sm:h-10 md:max-2xl:px-2.5 touch:h-11">
                  <FileText className="h-4 w-4" /> <span className="md:max-2xl:sr-only">PDI Documents</span>
                </button>
              </div>
            )}
            <Segmented
              iconsWhenTight
              label="Board view"
              value={density}
              onChange={setDensity}
              options={[
                { value: 'cards', label: 'Cards', icon: <LayoutGrid className="h-4 w-4" /> },
                { value: 'compact', label: 'Compact', icon: <LayoutList className="h-4 w-4" /> },
                { value: 'table', label: 'Table', icon: <Table2 className="h-4 w-4" /> },
              ]}
            />
          </>
        }
        singleRow
        filters={
          seesAll && openSessions.length > 0 ? (
          <>
            {factoryTabs.length > 0 && (
              <div role="tablist" aria-label="Factory" className="flex h-10 min-w-0 max-w-full shrink items-center gap-0.5 overflow-x-auto rounded-lg bg-slate-200/70 p-0.5 max-md:w-full dark:bg-slate-800 touch:h-11">
                {[{ key: 'all', label: 'All', count: base.length }, ...factoryTabs].map((t) => {
                  const active = activeFactory === t.key
                  return (
                    <button
                      key={t.key}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      aria-label={`${t.key === 'all' ? 'All factories' : t.label}, ${t.count} open`}
                      onClick={() => {
                        setFactoryTab(t.key)
                        setMachinePick('all')
                      }}
                      className={cn(
                        'inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 text-13 font-semibold transition-colors touch:h-10',
                        active
                          ? 'bg-white text-brand-700 shadow-sm dark:bg-slate-900 dark:text-brand-300'
                          : t.count === 0
                            ? 'text-muted hover:text-slate-700 dark:hover:text-slate-200'
                            : 'text-slate-700 hover:text-slate-900 dark:text-slate-200 dark:hover:text-white',
                      )}
                    >
                      {t.label}
                      <span
                        className={cn(
                          'rounded px-1.5 text-[11px] font-bold tabular-nums leading-[18px]',
                          t.count === 0 ? 'font-semibold text-muted' : active ? 'bg-brand-600 text-white' : 'bg-white text-slate-800 dark:bg-slate-900 dark:text-slate-100',
                        )}
                      >
                        {t.count}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
            <FilterSelect label="Inspector" value={inspectorFilter} onChange={setInspectorFilter}>
              <option value="all">All inspectors</option>
              {inspectorOptions.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </FilterSelect>
          </>
          ) : undefined
        }
        chips={[]}
        onReset={resetFilters}
        canReset={filtering}
      />

      {/* The machines with something open, spread out, each coloured by the worst signal on it; tap one to see it alone. */}
      {seesAll && groupsInFactory.length > 1 && (
        <div role="tablist" aria-label="Machine" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 lg:flex-wrap lg:overflow-visible lg:pb-0">
          <button type="button" role="tab" aria-selected={activeMachine === 'all'} onClick={() => setMachinePick('all')} className={chipTone(null, activeMachine === 'all')}>
            All machines
            <span className={cn('rounded-full px-1.5 text-xs tabular-nums', activeMachine === 'all' ? 'bg-white/20' : 'bg-black/5 dark:bg-white/10')}>{groupsInFactory.length}</span>
          </button>
          {groupsInFactory.map((g) => (
            <button key={g.code} type="button" role="tab" aria-selected={activeMachine === g.code} onClick={() => setMachinePick(activeMachine === g.code ? 'all' : g.code)} className={chipTone(g.tone, activeMachine === g.code)}>
              {g.code === favourite && <Star className="h-3.5 w-3.5 fill-current" />}
              {g.label}
              <span className={cn('rounded-full px-1.5 text-xs tabular-nums', activeMachine === g.code ? 'bg-white/20' : 'bg-black/5 dark:bg-white/10')}>{g.sessions.length}</span>
            </button>
          ))}
        </div>
      )}

      {isLoading ? (
        <div className="card px-4 py-3 text-13 text-muted">Loading the open sessions…</div>
      ) : groups.length === 0 ? (
        // A quiet board says so in one line, and leaves the room to what was closed today.
        <div className="card flex flex-wrap items-center gap-3 px-4 py-3">
          <ClipboardCheck className="h-6 w-6 shrink-0 text-muted" />
          <div className="min-w-0 flex-1">
            <p className="font-semibold">{filtering ? 'No open session here' : 'Nothing is open right now'}</p>
            <p className="text-13 text-muted">{filtering ? 'Pick another factory, machine or inspector.' : 'Start a new inspection to begin recording samples.'}</p>
          </div>
          {filtering ? (
            <Button className="min-h-[40px] touch:min-h-[44px]" onClick={resetFilters}>
              Show everything
            </Button>
          ) : canRecord ? (
            <Button variant="primary" className="min-h-[40px] touch:min-h-[44px]" onClick={() => setNewOpen(true)}>
              <Plus className="h-4 w-4" /> New Inspection
            </Button>
          ) : null}
        </div>
      ) : density === 'table' ? (
        boardTable(sections)
      ) : (
        // A header row per factory, its machines under it; the pinned machine heads the board under its own.
        <div className="space-y-5">
          {sections.map((sec) => {
            const sessionCount = sec.groups.reduce((n, g) => n + g.sessions.length, 0)
            return (
              <section key={sec.key} aria-label={sec.label} className="space-y-2.5">
                <div className={cn('flex items-center gap-2 border-b pb-1.5', sec.pinned ? 'border-amber-300 dark:border-amber-500/40' : 'border-slate-200 dark:border-slate-800')}>
                  {sec.pinned ? <Star className="h-3.5 w-3.5 fill-current text-amber-500" /> : <Factory className="h-3.5 w-3.5 text-muted" />}
                  <h2 className="text-xs font-bold uppercase tracking-wide text-muted">{sec.label}</h2>
                  <span className="text-xs tabular-nums text-muted">
                    · {sec.groups.length} machine{sec.groups.length === 1 ? '' : 's'} · {sessionCount} session{sessionCount === 1 ? '' : 's'}
                  </span>
                </div>
                {machineCards(sec.groups, sec.pinned)}
              </section>
            )
          })}
        </div>
      )}

      <RecentlyClosed machineName={machineLabel} />

      <NewInspectionDialog open={newOpen} onClose={() => setNewOpen(false)} />

      <OrderDetailsPanel
        session={details}
        samples={details ? (samplesBySession.get(details.id) ?? []) : []}
        machines={machines}
        canRecord={canRecord}
        onClose={() => setDetails(null)}
        onContinue={(s) => navigate(`/wizard/${s.id}`)}
        onCloseSession={(s) => {
          setDetails(null)
          setClosing(s)
        }}
        onOpenSample={(s, sm) => setViewing({ session: s, sample: sm })}
        onCorrectQuantities={details && (details.status === 'Open' ? can(role, 'edit-open-session') : can(role, 'edit-closed-session')) ? (s) => setCorrectingQty(s) : undefined}
      />
      {correctingQty && <SessionQuantitiesDialog session={correctingQty} onClose={() => setCorrectingQty(null)} />}
      {holdFor && <HoldDecisionDialog session={holdFor} onClose={() => setHoldFor(null)} />}

      {closing && (
        <CloseSessionDialog
          process={processForMachine(machines.find((m) => m.code === closing.workCenterCode) ?? null, closing.workCenterCode)}
          session={closing}
          onClose={() => setClosing(null)}
          onConfirm={async (body) => {
            try {
              await closeSession(queryClient, closing.id, { ...body, version: closing.version })
              toast('Session closed.', 'success')
            } catch (e) {
              toast(e instanceof Error ? e.message : 'Could not close the session.', 'error')
            }
            setClosing(null)
          }}
          onDiscard={async () => {
            try {
              await discardSession(queryClient, closing.id)
              toast('Session discarded. Nothing was recorded in it.', 'success')
            } catch (e) {
              toast(e instanceof Error ? e.message : 'Could not discard the session.', 'error')
            }
            setClosing(null)
          }}
        />
      )}

      <Modal
        open={viewing !== null}
        onClose={() => setViewing(null)}
        size="xl"
        icon={<Boxes className="h-5 w-5" />}
        title={
          viewing ? (
            <span className="flex flex-wrap items-center gap-2">
              {viewing.session.order?.orderNumber ?? '—'}
              <span className="text-sm font-semibold text-muted">Sample {viewing.session.seq}-{viewing.sample.index}</span>
              <Badge tone="neutral">
                {shiftName(viewing.sample.shift)} shift · <When iso={viewing.sample.createdAt} time />
              </Badge>
            </span>
          ) : (
            'Sample'
          )
        }
        footer={
          <>
            {viewing && viewingEditable && (
              <Button variant="secondary" className="min-h-[48px]" onClick={() => navigate(`/wizard/${viewing.session.id}/edit/${viewing.sample.id}`)}>
                Re-record sample
              </Button>
            )}
            <Button className="min-h-[48px]" onClick={() => setViewing(null)}>
              Close
            </Button>
          </>
        }
      >
        {viewing && viewingDetail ? (
          <SampleDetail
            session={viewing.session}
            process={processForMachine(machines.find((m) => m.code === viewing.session.workCenterCode) ?? null, viewing.session.workCenterCode)}
            sample={viewingDetail.sample}
            dimensions={viewingDetail.dimensions}
            defects={viewingDetail.defects}
            coils={viewingDetail.coils}
            paint={viewingDetail.paint ?? undefined}
            pt={viewingDetail.pt ?? undefined}
            loading={viewingLoading}
            editable={viewingEditable}
            onEditDimension={setEditingDim}
            onEditDefect={setEditingDefect}
          />
        ) : (
          <p className="py-10 text-center text-sm text-muted">Loading the sample…</p>
        )}
      </Modal>

      {editingDim && <DimensionEditDialog dimension={editingDim} saving={correcting} onClose={() => setEditingDim(null)} onSave={(actual) => saveDimension(editingDim, actual)} />}
      {editingDefect && viewing && <DefectEditDialog defect={editingDefect} workCenterCode={viewing.session.workCenterCode} saving={correcting} onClose={() => setEditingDefect(null)} onSave={(patch) => saveDefect(editingDefect, patch)} />}
    </div>
  )
}

function CloseSessionDialog({
  session,
  process,
  onClose,
  onConfirm,
  onDiscard,
}: {
  session: SessionWithOrder
  /** The machine's process: a welding session shows its PT coverage against the quantity typed. */
  process: Process
  onClose: () => void
  onConfirm: (body: Omit<CloseSessionRequest, 'version'>) => void
  onDiscard: () => void
}) {
  // A stock session confirms the quantity that came out; an order session its starting count.
  const stock = isStockOrder(session.order)
  const [qty, setQty] = useState(String(stock ? (session.producedQty ?? '') : (session.startQtyConfirmed?.qty ?? '')))
  const parsed = Number(qty)
  // §4 — on a universal machine the close says what the item is: a final product, or the stages this session covered.
  const asksUniversal = process === 'universal' && !stock && (session.sampleCount ?? 0) > 0
  const { data: stages, isLoading: stagesLoading } = useSessionStages(session.id, asksUniversal)
  const universal = stages?.universal === true
  const [draft, setDraft] = useState<UniversalDraft | null>(null)
  const current = draft ?? (stages ? universalDraft(stages.lineKind) : null)
  const read = universal && current ? readUniversalDraft(current, stages.stages.map((s) => s.stage)) : null
  const qtyValid = qty.trim() !== '' && !Number.isNaN(parsed) && parsed >= 0
  const valid = asksUniversal && stagesLoading ? false : universal ? read !== null && !('problem' in read) : qtyValid
  const confirm = () => {
    if (universal && read && !('problem' in read)) onConfirm({ universal: read.choice, ...(read.finalQty !== undefined ? { finalQty: read.finalQty } : {}) })
    else if (!universal) onConfirm({ finalQty: parsed })
  }

  // With no sample there is nothing to close as a record: the session is discarded instead.
  if ((session.sampleCount ?? 0) === 0) {
    return (
      <Modal
        open
        onClose={onClose}
        title="Nothing recorded yet"
        icon={<Lock className="h-5 w-5" />}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              Keep it open
            </Button>
            <Button variant="danger" onClick={onDiscard}>
              Discard session
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-600 dark:text-slate-300">
          This session has no sample, so it cannot be closed as an inspection record. Record a sample first, or discard the session: it leaves the board and
          History, and the discard is written to the audit log with your name.
        </p>
      </Modal>
    )
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Close session"
      icon={<Lock className="h-5 w-5" />}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid} onClick={confirm}>
            <Lock className="h-4 w-4" /> Close session
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {universal && stages && current ? (
          <>
            <UniversalChoice options={stages} draft={current} onChange={setDraft} kindLocked={stages.lineKind !== null} />
            {read && 'problem' in read && <p className="text-xs font-semibold text-muted">{read.problem}</p>}
          </>
        ) : asksUniversal && stagesLoading ? (
          <div className="skeleton h-24" />
        ) : (
          <Field label={stock ? 'Final quantity produced (pairs)' : 'Final produced quantity'} hint="Recorded against this session and audited.">
            <Input autoFocus type="number" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} className="min-h-[48px] text-lg" />
          </Field>
        )}
        {process === 'welding' && (
          // §5.6 — the PT requirement follows the quantity as it is typed: 5% of it, rounded up, against what was tested.
          <div
            className={cn(
              'rounded-2xl border-l-4 p-3 text-sm',
              !valid
                ? 'border-l-slate-300 bg-slate-50 text-slate-600 dark:bg-slate-800/60 dark:text-slate-300'
                : ptCoverageText(session, parsed).endsWith('met')
                  ? 'border-l-emerald-500 bg-emerald-50/70 text-emerald-900 dark:bg-emerald-500/10 dark:text-emerald-100'
                  : 'border-l-amber-500 bg-amber-50/70 text-amber-900 dark:bg-amber-500/10 dark:text-amber-100',
            )}
          >
            <p className="flex flex-wrap items-center gap-2 font-bold">
              PT coverage <PtCoverageBadge session={session} finalQty={valid ? parsed : null} />
            </p>
            <p className="mt-1">{ptCoverageText(session, valid ? parsed : null)}</p>
          </div>
        )}
        <p className="text-sm text-muted">
          A closed session becomes read-only for inspectors. A supervisor can still correct it, and any correction is audited.
        </p>
      </div>
    </Modal>
  )
}
