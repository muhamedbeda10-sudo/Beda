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
  X,
} from 'lucide-react'
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Select } from '@/components/ui'
import { NewInspectionDialog } from '@/components/inspection/NewInspectionDialog'
import { SessionToneBadge, sessionToneClass } from '@/components/inspection/SessionTone'
import { SampleDetail } from '@/components/inspection/SampleDetail'
import { DefectEditDialog, DimensionEditDialog } from '@/components/inspection/CorrectionDialogs'
import { SessionQuantitiesDialog } from '@/components/inspection/SessionQuantitiesDialog'
import { OrderDetailsPanel } from '@/components/inspection/OrderDetailsPanel'
import { InstallBanner } from '@/components/layout/InstallBanner'
import { useMaster, useOpenBoard, useSampleDetail } from '@/services/queries'
import { closeSession, correctDefect, correctDimension, discardSession } from '@/services/mutations'
import { useAuth } from '@/store/AuthContext'
import { useApp } from '@/store/AppContext'
import { can, isStockOrder, processForMachine, sessionTone, shiftName, type SessionTone } from '@/domain'
import { cn, formatDate, formatDateTime } from '@/lib/utils'
import { usePersistedState } from '@/lib/usePersistedState'
import type { SampleSummary, SessionWithOrder } from '@qc/shared/api'
import type { DefectResult, DimensionResult, Disposition, Machine } from '@qc/shared/types'

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
  // The board is everyone's: every open session, with a search and an
  // inspector filter so a technician can narrow it to their own name.
  const seesAll = true
  const [term, setTerm] = useState('')
  const [inspectorFilter, setInspectorFilter] = useState('all')

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

  /** Sessions after the supervisor's search and inspector filter; the tabs count these. */
  const base = useMemo(() => {
    if (!seesAll) return openSessions
    const t = term.trim().toLowerCase()
    return openSessions.filter((s) => {
      if (inspectorFilter !== 'all' && s.inspectorId !== inspectorFilter) return false
      if (!t) return true
      return (
        (s.order?.orderNumber ?? '').toLowerCase().includes(t) ||
        (s.order?.item ?? '').toLowerCase().includes(t) ||
        (s.order?.itemCode ?? '').toLowerCase().includes(t) ||
        (s.order?.customer ?? '').toLowerCase().includes(t)
      )
    })
  }, [seesAll, openSessions, term, inspectorFilter])

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

  const shown = groups.reduce((n, g) => n + g.sessions.length, 0)
  const narrowed = seesAll && (term.trim() !== '' || inspectorFilter !== 'all')
  const filtering = narrowed || activeFactory !== 'all' || activeMachine !== 'all'

  const [closing, setClosing] = useState<SessionWithOrder | null>(null)
  /** §4 — the session whose quantities are being corrected. */
  const [correctingQty, setCorrectingQty] = useState<SessionWithOrder | null>(null)
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

  async function saveDefect(defect: DefectResult, patch: { disposition: Disposition; qty: number }) {
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

  const chipTone = (tone: SessionTone, active: boolean) =>
    cn(
      'inline-flex min-h-[40px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 text-sm font-semibold ring-1 transition-colors',
      active
        ? 'bg-brand-600 text-white ring-brand-600 shadow-glow'
        : tone === 'hold'
          ? 'bg-amber-50 text-amber-800 ring-amber-300 hover:bg-amber-100 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/40'
          : tone === 'defect'
            ? 'bg-rose-50 text-rose-800 ring-rose-300 hover:bg-rose-100 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-500/40'
            : 'bg-white text-slate-700 ring-slate-200 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-200 dark:ring-slate-700 dark:hover:bg-slate-800',
    )

  // ---- The board's two renderings of a set of machines ---------------------
  // Each frame below hands its machines to one of these; the factory name on
  // a machine is shown only where the frame does not already say it.
  const machineTable = (gs: MachineGroup[], showFactory: boolean) => (
    // Every open session in one flat table, machine by machine in the same order as the cards.
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[60rem] text-sm">
          <thead className="bg-slate-50 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:bg-slate-800/60">
            <tr>
              <th className="px-4 py-3">Machine</th>
              <th className="px-4 py-3">Order</th>
              <th className="px-4 py-3">Item</th>
              <th className="px-4 py-3">Inspector</th>
              <th className="px-4 py-3">Started</th>
              <th className="px-4 py-3 text-right">Samples</th>
              <th className="px-4 py-3 text-right">Defects</th>
              <th className="px-4 py-3">State</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {gs.flatMap((g) =>
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
                      {showFactory && g.factory !== NO_FACTORY && <span className="block text-xs text-slate-400">{g.factory}</span>}
                    </td>
                    <td className="px-4 py-2.5 font-bold">
                      {isStockOrder(order) ? <Badge tone="violet">For stock</Badge> : (order?.orderNumber ?? '—')}
                      <span className="ml-1.5 text-xs font-bold tabular-nums text-slate-400">#{s.seq}</span>
                    </td>
                    <td className="max-w-[220px] truncate px-4 py-2.5">
                      <span className="block truncate">{order?.item ?? '—'}</span>
                      <span className="block truncate font-mono text-xs text-slate-400">{order?.itemCode ?? ''}</span>
                    </td>
                    <td className="px-4 py-2.5">{s.inspectorName}</td>
                    <td className="px-4 py-2.5 tabular-nums text-slate-500 dark:text-slate-400">{formatDateTime(s.startedAt)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{count}</td>
                    <td className={cn('px-4 py-2.5 text-right tabular-nums', (s.defectCount ?? 0) > 0 && 'font-bold text-rose-600 dark:text-rose-400')}>{s.defectCount ?? 0}</td>
                    <td className="px-4 py-2.5">
                      <span className="inline-flex flex-wrap items-center gap-1.5">
                        {s.status === 'Open' ? <Badge tone="green">OPEN</Badge> : <Badge tone="neutral" icon={<Lock className="h-3 w-3" />}>CLOSED</Badge>}
                        <SessionToneBadge session={s} />
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {s.status === 'Open' && (
                        <Button
                          variant="primary"
                          className="min-h-[40px]"
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
                  <span className="line-clamp-2 text-base font-extrabold leading-tight" title={g.label}>
                    {g.label}
                  </span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-400">
                    {showFactory && g.factory !== NO_FACTORY && <span>{g.factory}</span>}
                    <span className="tabular-nums">
                      {g.sessions.length} session{g.sessions.length === 1 ? '' : 's'} · {g.sampleCount} sample{g.sampleCount === 1 ? '' : 's'}
                    </span>
                  </span>
                </span>
                {isCollapsed ? <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" /> : <ChevronUp className="h-4 w-4 shrink-0 text-slate-400" />}
              </button>
              <button
                type="button"
                onClick={() => setFavourite(isFavourite ? null : g.code)}
                aria-pressed={isFavourite}
                aria-label={isFavourite ? `Stop pinning ${g.label}` : `Pin ${g.label} as my machine`}
                title={isFavourite ? 'My machine — pinned first on this device' : 'Pin as my machine on this device'}
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
                          <span className="text-xs font-bold tabular-nums text-slate-400">#{s.seq}</span>
                          <span className="truncate text-sm text-brand-600 dark:text-brand-400">{order?.item ?? '—'}</span>
                        </span>
                        <span className="block truncate text-xs text-slate-400">
                          {s.inspectorName} · {formatDate(s.startedAt)} · {count} sample{count === 1 ? '' : 's'}
                          {s.startQtyConfirmed ? ` · rejected before release ${s.startQtyConfirmed.qty}` : ''}
                          {s.producedQty !== undefined ? ` · produced ${s.producedQty} pairs` : ''}
                        </span>
                      </button>
                      <SessionToneBadge session={s} className="hidden sm:inline-flex" />
                      {s.status === 'Open' ? (
                        <Button variant="primary" className="min-h-[40px] shrink-0" onClick={() => navigate(`/wizard/${s.id}`)} aria-label="Continue">
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
                      <span className="text-xs font-bold tabular-nums text-slate-400">#{s.seq}</span>
                      {s.status === 'Open' ? <Badge tone="green">OPEN</Badge> : <Badge tone="neutral" icon={<Lock className="h-3 w-3" />}>CLOSED · stays while on Hold</Badge>}
                      <SessionToneBadge session={s} />
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
                    <p className="mt-0.5 flex items-center gap-1 text-xs text-slate-400">
                      <span>
                        {formatDate(s.startedAt)} · {s.inspectorName}
                      </span>
                      <span className="ml-auto inline-flex items-center gap-0.5 font-semibold text-brand-600 opacity-70 transition-[opacity,transform] group-hover:translate-x-0.5 group-hover:opacity-100 dark:text-brand-400">
                        Order details <ChevronRight className="h-3.5 w-3.5" />
                      </span>
                    </p>
                    </div>

                    {/* A closed session on Hold is here to be seen, not continued; deleting is an administrator's act, from History. */}
                    {s.status === 'Open' && (
                      <div className="mt-3 flex items-center gap-2">
                        <Button variant="primary" className="min-h-[48px] flex-1" onClick={() => navigate(`/wizard/${s.id}`)}>
                          <Play className="h-4 w-4" /> Continue
                        </Button>
                        <Button variant="secondary" className="min-h-[48px]" onClick={() => setClosing(s)} aria-label="Close session">
                          <Lock className="h-4 w-4" />
                          <span className="hidden sm:inline">Close</span>
                        </Button>
                      </div>
                    )}

                    {sessionSamples.length > 0 && (
                      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
                        <span className="flex items-center gap-1 text-xs font-bold uppercase text-slate-400">
                          <Boxes className="h-3.5 w-3.5" /> Samples
                        </span>
                        {[...sessionSamples]
                          .sort((a, b) => a.index - b.index)
                          .map((sm) => (
                            <button
                              key={sm.id}
                              type="button"
                              onClick={() => setViewing({ session: s, sample: sm })}
                              className="min-h-[36px] rounded-lg bg-brand-50 px-2.5 py-1 text-xs font-semibold text-brand-700 ring-1 ring-brand-200 transition-colors hover:bg-brand-100 dark:bg-brand-500/10 dark:text-brand-300 dark:ring-brand-500/20 dark:hover:bg-brand-500/20"
                              aria-label={`Open sample ${sm.index}`}
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

  return (
    <div className="space-y-5">
      <InstallBanner />

      {/* §4 — one toolbar: the three primary actions, then search, inspector and the view toggle.
          On a phone the actions are tiles and the rest stacks under them; on a wide screen it is one row. */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="grid w-full grid-cols-3 gap-3 lg:flex lg:w-auto lg:items-stretch">
          <QuickAction icon={<Plus className="h-6 w-6 lg:h-5 lg:w-5" />} title="New" subtitle="Inspection" onClick={() => setNewOpen(true)} />
          <QuickAction icon={<Search className="h-6 w-6 lg:h-5 lg:w-5" />} title="Coil" subtitle="Search" onClick={() => navigate('/coils')} />
          <QuickAction icon={<FileText className="h-6 w-6 lg:h-5 lg:w-5" />} title="PDI" subtitle="Documents" onClick={() => navigate('/pdi')} />
        </div>
        <div className="flex items-center gap-2 lg:hidden">
          <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">Open sessions</h2>
          <Badge tone="blue">{filtering ? `${shown} of ${openSessions.length}` : openSessions.length}</Badge>
        </div>
        {seesAll && openSessions.length > 0 && (
          // Search and the inspector filter: their own row on a phone, the right end of the toolbar on a wide screen.
          <div className="order-last grid w-full grid-cols-1 gap-2 sm:grid-cols-[1fr_auto] lg:order-none lg:ml-auto lg:flex lg:w-auto">
            <div className="relative lg:w-72">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input
                value={term}
                onChange={(e) => setTerm(e.target.value)}
                placeholder="Order number, item or customer…"
                className="min-h-[44px] pl-9 pr-9"
                aria-label="Search open sessions"
              />
              {term && (
                <button type="button" onClick={() => setTerm('')} aria-label="Clear search" className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-slate-400 hover:text-slate-600">
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            <Select value={inspectorFilter} onChange={(e) => setInspectorFilter(e.target.value)} className="min-h-[44px] sm:min-w-[12rem]" aria-label="Inspector">
              <option value="all">All inspectors</option>
              {inspectorOptions.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </Select>
          </div>
        )}
        <div className={cn('flex items-center gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-800 lg:order-last', seesAll && openSessions.length > 0 ? 'ml-auto lg:ml-0' : 'ml-auto')} role="group" aria-label="Board view">
          {(
            [
              { key: 'cards', label: 'Cards', icon: <LayoutGrid className="h-4 w-4" /> },
              { key: 'compact', label: 'Compact', icon: <LayoutList className="h-4 w-4" /> },
              { key: 'table', label: 'Table', icon: <Table2 className="h-4 w-4" /> },
            ] as const
          ).map((v) => (
            <button
              key={v.key}
              type="button"
              onClick={() => setDensity(v.key)}
              aria-pressed={density === v.key}
              aria-label={`${v.label} view`}
              title={`${v.label} view`}
              className={cn(
                'inline-flex min-h-[36px] items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold transition-colors',
                density === v.key ? 'bg-white text-brand-700 shadow-card dark:bg-slate-900 dark:text-brand-300' : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200',
              )}
            >
              {v.icon} <span className="hidden sm:inline">{v.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* The factories in one framed row and the machines in another, each
          named on its frame, so the two levels read apart at a glance. On a
          phone each row scrolls sideways; on a wide screen the chips wrap. */}
      <div className="flex flex-col gap-3">
      <div className="hidden items-center gap-2 lg:flex">
        <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">Open sessions</h2>
        <Badge tone="blue">{filtering ? `${shown} of ${openSessions.length}` : openSessions.length}</Badge>
      </div>
      {factoryTabs.length > 0 && (
        <fieldset className="rounded-2xl border border-slate-200 px-3 pb-2.5 pt-1 dark:border-slate-700">
        <legend className="px-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-400">Factories</legend>
        <div className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 lg:flex-wrap lg:overflow-visible lg:pb-0" role="tablist" aria-label="Factory">
          {[{ key: 'all', label: 'All factories', count: base.length }, ...factoryTabs].map((t) => {
            const active = activeFactory === t.key
            return (
              <button
                key={t.key}
                role="tab"
                aria-selected={active}
                onClick={() => {
                  setFactoryTab(t.key)
                  setMachinePick('all')
                }}
                className={cn(
                  'inline-flex min-h-[44px] shrink-0 items-center gap-2 whitespace-nowrap rounded-xl px-4 text-sm font-bold transition-colors',
                  active ? 'bg-brand-600 text-white shadow-glow' : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-300 dark:ring-slate-700 dark:hover:bg-slate-800',
                )}
              >
                <Factory className="h-4 w-4" />
                {t.label}
                <span className={cn('rounded-full px-2 py-0.5 text-xs tabular-nums', active ? 'bg-white/20' : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400')}>{t.count}</span>
              </button>
            )
          })}
        </div>
        </fieldset>
      )}

      {/* Machine chips: only the machines with something open, coloured by the worst signal on them. */}
      {groupsInFactory.length > 1 && (
        <fieldset className="rounded-2xl border border-slate-200 px-3 pb-2.5 pt-1 dark:border-slate-700">
        <legend className="px-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-400">Machines</legend>
        <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 lg:flex-wrap lg:overflow-visible lg:pb-0" role="tablist" aria-label="Machine">
          <button role="tab" aria-selected={activeMachine === 'all'} onClick={() => setMachinePick('all')} className={chipTone(null, activeMachine === 'all')}>
            All machines
          </button>
          {groupsInFactory.map((g) => (
            <button key={g.code} role="tab" aria-selected={activeMachine === g.code} onClick={() => setMachinePick(activeMachine === g.code ? 'all' : g.code)} className={chipTone(g.tone, activeMachine === g.code)}>
              {g.code === favourite && <Star className="h-3.5 w-3.5 fill-current" />}
              {g.label}
              <span className={cn('rounded-full px-1.5 py-0.5 text-xs tabular-nums', activeMachine === g.code ? 'bg-white/20' : 'bg-black/5 dark:bg-white/10')}>{g.sessions.length}</span>
            </button>
          ))}
        </div>
        </fieldset>
      )}
      </div>

      {isLoading ? (
        <Card className="p-10 text-center text-sm text-slate-400">Loading…</Card>
      ) : groups.length === 0 ? (
        <EmptyState
          icon={<ClipboardCheck className="h-10 w-10" />}
          title={filtering ? 'No open session here' : 'Nothing is open right now'}
          hint={filtering ? 'Pick another factory or machine, or clear the search.' : 'Start a new inspection to begin recording samples.'}
          action={
            filtering ? (
              <Button
                onClick={() => {
                  setTerm('')
                  setInspectorFilter('all')
                  setFactoryTab('all')
                  setMachinePick('all')
                }}
              >
                Show everything
              </Button>
            ) : (
              <Button variant="primary" onClick={() => setNewOpen(true)}>
                <Plus className="h-4 w-4" /> New Inspection
              </Button>
            )
          }
        />
      ) : (
        // One frame per factory, its machines inside, each machine's sessions
        // beneath it — the same order on a phone, stacked in one column. The
        // pinned machine takes a frame of its own at the top.
        <div className="space-y-4">
          {sections.map((sec) => (
            <fieldset
              key={sec.key}
              className={cn('rounded-2xl border px-3 pb-3 pt-1 sm:px-4 sm:pb-4', sec.pinned ? 'border-amber-300 dark:border-amber-500/40' : 'border-slate-200 dark:border-slate-700')}
            >
              <legend className="flex items-center gap-2 px-1.5 text-xs font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                {sec.pinned ? <Star className="h-3.5 w-3.5 fill-current text-amber-500" /> : <Factory className="h-3.5 w-3.5" />}
                {sec.label}
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] tabular-nums text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                  {sec.groups.length} machine{sec.groups.length === 1 ? '' : 's'} · {sec.groups.reduce((n, g) => n + g.sessions.length, 0)} session
                  {sec.groups.reduce((n, g) => n + g.sessions.length, 0) === 1 ? '' : 's'}
                </span>
              </legend>
              {density === 'table' ? machineTable(sec.groups, sec.pinned) : machineCards(sec.groups, sec.pinned)}
            </fieldset>
          ))}
        </div>
      )}

      <NewInspectionDialog open={newOpen} onClose={() => setNewOpen(false)} />

      <OrderDetailsPanel
        session={details}
        samples={details ? (samplesBySession.get(details.id) ?? []) : []}
        machines={machines}
        canRecord={can(role, 'record-inspection')}
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

      {closing && (
        <CloseSessionDialog
          session={closing}
          onClose={() => setClosing(null)}
          onConfirm={async (qty) => {
            try {
              await closeSession(queryClient, closing.id, { finalQty: qty, version: closing.version })
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
              <span className="text-sm font-semibold text-slate-400">Sample {viewing.session.seq}-{viewing.sample.index}</span>
              <Badge tone="neutral">
                {shiftName(viewing.sample.shift)} shift · {formatDateTime(viewing.sample.createdAt)}
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
          <p className="py-10 text-center text-sm text-slate-400">Loading the sample…</p>
        )}
      </Modal>

      {editingDim && <DimensionEditDialog dimension={editingDim} saving={correcting} onClose={() => setEditingDim(null)} onSave={(actual) => saveDimension(editingDim, actual)} />}
      {editingDefect && <DefectEditDialog defect={editingDefect} saving={correcting} onClose={() => setEditingDefect(null)} onSave={(patch) => saveDefect(editingDefect, patch)} />}
    </div>
  )
}

function CloseSessionDialog({
  session,
  onClose,
  onConfirm,
  onDiscard,
}: {
  session: SessionWithOrder
  onClose: () => void
  onConfirm: (qty: number) => void
  onDiscard: () => void
}) {
  // A stock session confirms the quantity that came out; an order session its starting count.
  const stock = isStockOrder(session.order)
  const [qty, setQty] = useState(String(stock ? (session.producedQty ?? '') : (session.startQtyConfirmed?.qty ?? '')))
  const parsed = Number(qty)
  const valid = qty.trim() !== '' && !Number.isNaN(parsed) && parsed >= 0

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
          <Button variant="primary" disabled={!valid} onClick={() => onConfirm(parsed)}>
            <Lock className="h-4 w-4" /> Close session
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label={stock ? 'Final quantity produced (pairs)' : 'Final produced quantity'} hint="Recorded against this session and audited.">
          <Input autoFocus type="number" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} className="min-h-[48px] text-lg" />
        </Field>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          A closed session becomes read-only for inspectors. A supervisor can still correct it, and any correction is audited.
        </p>
      </div>
    </Modal>
  )
}

function QuickAction({ icon, title, subtitle, onClick }: { icon: ReactNodeLike; title: string; subtitle: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="card-hover group flex min-h-[112px] flex-col items-center justify-center gap-2 p-4 lg:min-h-0 lg:flex-row lg:justify-start lg:gap-3 lg:px-4 lg:py-2.5"
    >
      <span className="grid h-14 w-14 place-items-center rounded-full bg-gradient-to-br from-brand-600 to-brand-800 text-white shadow-card transition-transform duration-300 ease-out group-hover:scale-110 group-hover:rotate-3 lg:h-10 lg:w-10">
        {icon}
      </span>
      <div className="text-center leading-tight lg:text-left">
        <p className="font-bold">
          {title}
          <span className="hidden lg:inline"> {subtitle}</span>
        </p>
        <p className="text-sm text-slate-500 dark:text-slate-400 lg:hidden">{subtitle}</p>
      </div>
    </button>
  )
}

type ReactNodeLike = Parameters<typeof Badge>[0]['children']
