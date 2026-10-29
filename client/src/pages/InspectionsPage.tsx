import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
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
  Loader2,
  AlertTriangle,
  Recycle,
} from 'lucide-react'
import { Badge, Button, Card, Field, Input, Modal } from '@/components/ui'
import { FilterBar, FilterSelect, Segmented } from '@/components/ui/PageShell'
import { EdgeShadows, ScrollX, useScrollEdges } from '@/components/ui/ScrollX'
import { RecentlyClosed } from '@/components/inspection/RecentlyClosed'
import { NewInspectionDialog } from '@/components/inspection/NewInspectionDialog'
import { PtCoverageBadge, SessionToneBadge, ptCoverageText, sessionToneClass } from '@/components/inspection/SessionTone'
import { SampleDetail } from '@/components/inspection/SampleDetail'
import { DefectEditDialog, DimensionEditDialog, type DefectCorrection } from '@/components/inspection/CorrectionDialogs'
import { SessionQuantitiesDialog } from '@/components/inspection/SessionQuantitiesDialog'
import { HoldDecisionDialog, mayDecideHolds } from '@/components/inspection/HoldDecisionDialog'
import { OrderDetailsPanel } from '@/components/inspection/OrderDetailsPanel'
import { boardViewFor, factorySwitch, offersFactoryChoice, type BoardDensity, type FactoryCount } from '@/components/inspection/boardLayout'
import { InstallBanner } from '@/components/layout/InstallBanner'
import { useMaster, useOpenBoard, useSampleDetail, useSessionStages } from '@/services/queries'
import { UniversalChoice, readUniversalDraft, universalDraft, type UniversalDraft } from '@/components/inspection/UniversalChoice'
import { closeSession, correctDefect, correctDimension, discardSession } from '@/services/mutations'
import { useAuth } from '@/store/AuthContext'
import { useApp } from '@/store/AppContext'
import { isStockOrder, processForMachine, sessionTone, shiftName, type Process, type SessionTone } from '@/domain'
import { cn, formatDateTime } from '@/lib/utils'
import { useTableView, ViewNote, ViewTh } from '@/components/ui/ColumnFilter'
import { usePersistedState } from '@/lib/usePersistedState'
import { useBusyAction } from '@/lib/busyAction'
import { useHoldUpdates } from '@/lib/appUpdate'
import { PHONE, useMediaQuery } from '@/lib/media'
import type { CloseSessionRequest, SampleSummary, SessionWithOrder } from '@qc/shared/api'
import type { DefectResult, DimensionResult, Disposition, Machine } from '@qc/shared/types'
import { When } from '@/components/ui/Tooltip'
import { ScrapDialog } from '@/components/scrap/ScrapDialog'

const COLLAPSE_AFTER = 3
/** Sessions on a machine without a factory gather under this tab. */
const NO_FACTORY = '__none__'
/** Machines are ordered by the worst thing on them: Hold before defects before the rest. */
const TONE_RANK: Record<NonNullable<SessionTone> | 'none', number> = { hold: 0, defect: 1, prior: 2, none: 3 }
/**
 * The board's filter selects on a phone: the factory and the inspector share their row, half each. Once a filter is
 * set, Reset joins the inspector's select on its row and the factory's takes a row of its own (FACTORY_ALONE), so the
 * value chosen is read in full ("Factory 10", not "Factory 1…") and Reset never sits alone on a row. The browser
 * draws the select's arrow in a room of its own, so the padding beside it is cut back to leave the words what is
 * left. Important, as these override FilterSelect's own phone sizes.
 */
const PHONE_SELECT = 'max-md:!min-w-0 max-md:!pl-3 max-md:!pr-2'
const FACTORY_ALONE = 'max-md:!basis-full'

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
  const { can } = useAuth()
  // A viewer reads the board: no new inspection, no continue, no close.
  const canRecord = can('record-inspection')
  const { toast } = useApp()

  // Only the open sessions — this screen exists to answer "what is open now".
  // The API returns them with their orders and samples in one round trip.
  const { data: board, isLoading } = useOpenBoard()
  const { data: machines = [] } = useMaster('machines')
  const openSessions = board?.sessions ?? []
  const samples = board?.samples ?? []

  const [newOpen, setNewOpen] = useState(false)
  const [scrapOpen, setScrapOpen] = useState(false)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  /** The session whose order is open in full, in the side panel. */
  const [details, setDetails] = useState<SessionWithOrder | null>(null)

  // ---- How this device likes the board (kept across shifts) ----------------
  const [factoryTab, setFactoryTab] = usePersistedState<string>('qc-board:factory', 'all')
  const [machinePick, setMachinePick] = usePersistedState<string>('qc-board:machine', 'all')
  const [collapsed, setCollapsed] = usePersistedState<Record<string, boolean>>('qc-board:collapsed', {})
  const [favourite, setFavourite] = usePersistedState<string | null>('qc-board:favourite', null)
  const [density, setDensity] = usePersistedState<BoardDensity>('qc-board:density', 'cards')
  // A phone has no room for the table's columns: a Table kept on this device reads as Compact there, and is the table
  // again once the device is turned or docked wider.
  const phone = useMediaQuery(PHONE)
  const view = boardViewFor(density, phone)

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
  const factoryTabs = useMemo<FactoryCount[]>(() => {
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
  /** What the factory switch offers beside All: the factories with work open, the busiest first (boardLayout). */
  const factoryChoices = useMemo(() => factorySwitch(factoryTabs, activeFactory), [factoryTabs, activeFactory])
  const pickFactory = (key: string) => {
    setFactoryTab(key)
    setMachinePick('all')
  }

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

  // The table view: Excel's sort and filter on every column, the factory header rows kept.
  const boardRows = useMemo(() => sections.flatMap((sec) => sec.groups.flatMap((g) => g.sessions.map((session) => ({ section: sec.key, group: g, session })))), [sections])
  const boardView = useTableView(boardRows, [
    { key: 'machine', value: (r) => r.group.label },
    { key: 'order', value: (r) => `${isStockOrder(r.session.order) ? 'For stock' : (r.session.order?.orderNumber ?? '—')} #${r.session.seq}` },
    { key: 'item', value: (r) => `${r.session.order?.item ?? ''} ${r.session.order?.itemCode ?? ''}`.trim() },
    { key: 'inspector', value: (r) => r.session.inspectorName },
    { key: 'started', value: (r) => formatDateTime(r.session.startedAt), sortValue: (r) => Date.parse(r.session.startedAt), numeric: true },
    { key: 'samples', value: (r) => String(samplesBySession.get(r.session.id)?.length ?? 0), sortValue: (r) => samplesBySession.get(r.session.id)?.length ?? 0, numeric: true },
    { key: 'defects', value: (r) => String(r.session.defectCount ?? 0), sortValue: (r) => r.session.defectCount ?? 0, numeric: true },
    { key: 'state', value: (r) => [r.session.status, (r.session.holdCount ?? 0) > 0 ? 'On Hold' : (r.session.defectCount ?? 0) > 0 ? 'Defects' : ''].filter(Boolean).join(' · ') },
  ])

  const narrowed = seesAll && inspectorFilter !== 'all'
  const filtering = narrowed || activeFactory !== 'all' || activeMachine !== 'all'

  const [closing, setClosing] = useState<SessionWithOrder | null>(null)
  /** §4 — the session whose quantities are being corrected. */
  const [correctingQty, setCorrectingQty] = useState<SessionWithOrder | null>(null)
  /** §7 — the session whose Holds are being decided from the badge. */
  const [holdFor, setHoldFor] = useState<SessionWithOrder | null>(null)
  /** Who may decide a Hold here: whoever may decide Holds, or correct the session. */
  const mayDecide = (s: SessionWithOrder) => mayDecideHolds(s, can)
  /** A sample opened from its chip on the card: the full record, read-only here. */
  const [viewing, setViewing] = useState<{ session: SessionWithOrder; sample: SampleSummary } | null>(null)
  const { data: viewingDetail, isLoading: viewingLoading } = useSampleDetail(viewing?.sample.id ?? null)
  /** §14 — an open session's sample is corrected by an inspector, a closed one's by a supervisor; the API enforces the same. */
  const viewingEditable = viewing ? (viewing.session.status === 'Open' ? can('edit-open-session') : can('edit-closed-session')) : false
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
  const boardTable = (secs: typeof sections) => {
    // The Continue column is for someone who may continue; a reader's table has no empty column to scroll to.
    const actions = canRecord
    const columns = actions ? 9 : 8
    return (
      // Every open session in one table: a header row per factory, then its machines in the same order as the cards.
      // Narrower than its columns (a tablet, a phone turned), the table scrolls sideways inside the card, with a shadow
      // where columns hide; the state sits beside the order, and Continue stays pinned at the right edge
      // (.table-sticky-last), so neither is scrolled out of reach. Cells on 12 px padding: on a desktop the whole table fits.
      <Card className="overflow-hidden">
        <ScrollX label="Open sessions" shadows={actions ? 'start' : 'both'}>
          <table className={cn('w-full min-w-[60rem] text-sm', actions && 'table-sticky-last')}>
            <thead className="bg-slate-50 text-left text-[11px] font-semibold uppercase tracking-wide text-muted dark:bg-slate-800/60">
              <tr>
                <ViewTh view={boardView} column="machine" label="Machine" className="px-3 py-3" />
                <ViewTh view={boardView} column="order" label="Order" className="px-3 py-3" />
                <ViewTh view={boardView} column="state" label="State" className="px-3 py-3" />
                <ViewTh view={boardView} column="item" label="Item" className="px-3 py-3" />
                <ViewTh view={boardView} column="inspector" label="Inspector" className="px-3 py-3" />
                <ViewTh view={boardView} column="started" label="Started" className="px-3 py-3" />
                <ViewTh view={boardView} column="samples" label="Samples" className="px-3 py-3 text-right" />
                <ViewTh view={boardView} column="defects" label="Defects" className="px-3 py-3 text-right" />
                {/* Named for a screen reader, with no hidden text in the cell; opaque, the header's tint laid over the card, as rows pass under it. */}
                {actions && <th aria-label="Actions" className="bg-slate-50 px-3 py-3 dark:bg-[#182234]" />}
              </tr>
            </thead>
            {secs.map((sec) => {
              const showFactory = sec.pinned
              // The section's rows the filters let through, in the order the sort gives.
              const rows = boardView.rows.filter((r) => r.section === sec.key)
              if (rows.length === 0) return null
              const sessionCount = rows.length
              const machineCount = new Set(rows.map((r) => r.group.code)).size
              return (
                <tbody key={sec.key} className="divide-y divide-slate-100 border-t border-slate-200 dark:divide-slate-800 dark:border-slate-700">
                  <tr>
                    {/* The factory's row spans the table: it scrolls with it rather than being pinned as the last cell. */}
                    <th colSpan={columns} scope="colgroup" className="static bg-slate-100/80 px-3 py-1.5 text-left text-xs font-bold uppercase tracking-wide text-muted shadow-none dark:bg-slate-800/70">
                      <span className="inline-flex items-center gap-2 whitespace-nowrap">
                        {sec.pinned ? <Star className="h-3.5 w-3.5 fill-current text-amber-500" /> : <Factory className="h-3.5 w-3.5" />}
                        {sec.label}
                        <span className="font-semibold normal-case tracking-normal tabular-nums">
                          · {machineCount} machine{machineCount === 1 ? '' : 's'} · {sessionCount} session{sessionCount === 1 ? '' : 's'}
                        </span>
                      </span>
                    </th>
                  </tr>
                  {rows.map(({ group: g, session: s }) => {
                    const order = s.order
                    const count = samplesBySession.get(s.id)?.length ?? 0
                    return (
                      // Opaque rows: the pinned Continue cell takes the row's colour (bg-inherit), its hover included.
                      <tr
                        key={s.id}
                        onClick={() => setDetails(s)}
                        className={cn('cursor-pointer transition-colors', sessionToneClass(s, 'row', 'bg-white hover:bg-slate-50 dark:bg-slate-900 dark:hover:bg-[#172033]'))}
                      >
                        <td className="whitespace-nowrap px-3 py-2.5">
                          <span className="flex items-center gap-1.5 font-semibold">
                            {g.code === favourite && <Star className="h-3.5 w-3.5 fill-current text-amber-500" />}
                            {g.label}
                          </span>
                          {showFactory && g.factory !== NO_FACTORY && <span className="block text-xs text-muted">{g.factory}</span>}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5 font-bold">
                          {isStockOrder(order) ? <Badge tone="violet">For stock</Badge> : (order?.orderNumber ?? '—')}
                          <span className="ml-1.5 text-xs font-bold tabular-nums text-muted">#{s.seq}</span>
                        </td>
                        <td className="px-3 py-2.5">
                          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                            {s.status === 'Open' ? <Badge tone="green">OPEN</Badge> : <Badge tone="neutral" icon={<Lock className="h-3 w-3" />}>CLOSED</Badge>}
                            <SessionToneBadge session={s} onHold={mayDecide(s) ? () => setHoldFor(s) : undefined} />
                          </span>
                        </td>
                        <td className="max-w-[220px] truncate px-3 py-2.5">
                          <span className="block truncate">{order?.item ?? '—'}</span>
                          <span className="block truncate font-mono text-xs text-muted">{order?.itemCode ?? ''}</span>
                        </td>
                        <td className="px-3 py-2.5">{s.inspectorName}</td>
                        <td className="px-3 py-2.5 tabular-nums text-muted"><When iso={s.startedAt} time /></td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{count}</td>
                        <td className={cn('px-3 py-2.5 text-right tabular-nums', (s.defectCount ?? 0) > 0 && 'font-bold text-rose-600 dark:text-rose-400')}>{s.defectCount ?? 0}</td>
                        {actions && (
                          <td className="bg-inherit px-3 py-2.5 text-right">
                            {s.status === 'Open' && (
                              <Button
                                variant="primary"
                                className="min-h-[36px] whitespace-nowrap px-3 py-1.5 touch:min-h-[44px]"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  navigate(`/wizard/${s.id}`)
                                }}
                              >
                                <Play className="h-4 w-4" /> Continue
                              </Button>
                            )}
                          </td>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
              )
            })}
          </table>
        </ScrollX>
        {boardView.rows.length === 0 && <p className="px-4 py-6 text-center text-sm text-muted">No open session matches the column filters.</p>}
        <ViewNote view={boardView} total={boardRows.length} className="border-t border-slate-100 dark:border-slate-800" />
      </Card>
    )
  }

  const machineCards = (gs: MachineGroup[], showFactory: boolean) => (
    // Several machines side by side from a small tablet up (two, three on a wide screen); one column on a phone.
    <div className={cn('grid items-start gap-4', view === 'cards' ? 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-3' : 'grid-cols-1 xl:grid-cols-2')}>
      {gs.map((g) => {
        const isCollapsed = collapsed[g.code] === true
        const isExpanded = expanded[g.code]
        const visible = isExpanded || view === 'compact' ? g.sessions : g.sessions.slice(0, COLLAPSE_AFTER)
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
                  {/* The full machine name while the card is open, on as many lines as it takes (a finger gets no tooltip);
                      folded, three lines on a phone and two from a tablet up. The counts sit under it, never clipping it. */}
                  <span className={cn('text-base font-extrabold leading-tight', isCollapsed && 'line-clamp-3 sm:line-clamp-2')} data-tip={isCollapsed ? g.label : undefined}>
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

            {!isCollapsed && view === 'compact' ? (
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
                      {/* What is wrong with the session, in words, on every screen: on a phone the short form ("Hold ×2", "3"),
                          from a small tablet up the sentence. On Hold, either is the way into the decision. */}
                      <SessionToneBadge session={s} compact className="sm:hidden" onHold={mayDecide(s) ? () => setHoldFor(s) : undefined} />
                      <SessionToneBadge session={s} className="max-sm:hidden" onHold={mayDecide(s) ? () => setHoldFor(s) : undefined} />
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
                        {/* Named on every screen: a padlock alone reads as a state, not as the start of closing the session. */}
                        <Button variant="secondary" className="min-h-[40px] touch:min-h-[44px]" onClick={() => setClosing(s)} aria-label="Close session">
                          <Lock className="h-4 w-4" /> Close
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
                                'min-h-[36px] rounded-lg px-2.5 py-1 text-xs font-semibold ring-1 transition-colors touch:min-h-[44px] touch:min-w-[44px]',
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

            {!isCollapsed && view === 'cards' && hidden > 0 && (
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

      {/* No title row: the tab names the page. New Inspection and the other actions sit at the right end; on a phone they
          head it, in two rows: New Inspection with the board's view beside it, then Coil search and New PDI, half each.
          Under them the factory and the inspector, half each, and Reset beside them once a filter is set. From a small
          tablet the actions sit right-aligned on a row of their own under the filters (Coil search, New PDI, the view,
          New Inspection last), the words always shown on a touch screen; from 1280 px everything is one row. */}
      <FilterBar
        actions={
          <div className="grid w-full grid-cols-2 gap-2 sm:ml-auto sm:flex sm:w-auto sm:flex-wrap sm:items-center sm:justify-end">
            {/* A phone's first row; from a small tablet this box steps aside (contents) and its button joins the row. */}
            <div className="col-span-2 flex gap-2 sm:contents">
              {canRecord && (
                <button type="button" onClick={() => setNewOpen(true)} className="btn-primary h-11 min-h-0 min-w-0 flex-1 px-4 py-0 text-sm sm:order-last sm:h-10 sm:flex-none touch:h-11">
                  <Plus className="h-4 w-4" /> New Inspection
                </button>
              )}
              {/* A phone: the view as a select as wide as its longest name (the whole row for a reader, who has no
                  actions); the table is not offered there (boardViewFor). From a small tablet: the switch. */}
              <select
                aria-label="Board view"
                value={view}
                onChange={(e) => setDensity(e.target.value as BoardDensity)}
                className={cn('input h-11 py-0 pl-3 pr-2 text-13 sm:hidden', canRecord ? 'w-auto shrink-0' : 'flex-1')}
              >
                <option value="cards">Cards</option>
                <option value="compact">Compact</option>
              </select>
            </div>
            {canRecord && (
              <>
                {/* Icons alone only under a mouse from a tablet to a wide screen, their names in the tooltip; a finger always gets the words. */}
                <button type="button" onClick={() => navigate('/coils')} data-tip="Coil search" className="btn-secondary h-11 min-h-0 whitespace-nowrap px-3 py-0 text-13 sm:h-10 md:max-2xl:mouse:px-2.5 touch:h-11">
                  <Search className="h-4 w-4 shrink-0" /> <span className="md:max-2xl:mouse:sr-only">Coil search</span>
                </button>
                <button type="button" onClick={() => navigate('/pdi')} data-tip="New PDI" className="btn-secondary h-11 min-h-0 whitespace-nowrap px-3 py-0 text-13 sm:h-10 md:max-2xl:mouse:px-2.5 touch:h-11">
                  <FileText className="h-4 w-4 shrink-0" /> <span className="md:max-2xl:mouse:sr-only">New PDI</span>
                </button>
              </>
            )}
            {/* Scrap is weighed on the floor: recorded from here, read in History under Scrap. */}
            {can('record-scrap') && (
              <button type="button" onClick={() => setScrapOpen(true)} data-tip="New Scrap" className="btn-secondary col-span-2 h-11 min-h-0 whitespace-nowrap px-3 py-0 text-13 sm:h-10 md:max-2xl:mouse:px-2.5 touch:h-11">
                <Recycle className="h-4 w-4 shrink-0" /> <span className="md:max-2xl:mouse:sr-only">New Scrap</span>
              </button>
            )}
            <div className="max-sm:hidden">
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
            </div>
          </div>
        }
        singleRow
        filters={
          seesAll && openSessions.length > 0 ? (
          <>
            {/* The factory: tabs from a portrait tablet up, a select on a phone; offered only when there is a choice to make. */}
            {offersFactoryChoice(factoryChoices, activeFactory) && (
              <>
                <Strip
                  label="Factory"
                  follow={activeFactory}
                  className="min-w-0 max-w-full shrink max-md:hidden"
                  stripClassName="scrollbar-none flex h-10 items-center gap-0.5 rounded-lg bg-slate-200/70 p-0.5 dark:bg-slate-800 touch:h-11"
                  shadowClassName="rounded-lg"
                >
                  {[{ key: 'all', label: 'All', count: base.length }, ...factoryChoices].map((t) => {
                    const active = activeFactory === t.key
                    return (
                      <button
                        key={t.key}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        aria-label={`${t.key === 'all' ? 'All factories' : t.label}, ${t.count} open`}
                        onClick={() => pickFactory(t.key)}
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
                </Strip>
                <FilterSelect label="Factory" value={activeFactory} onChange={pickFactory} className={cn('md:hidden', PHONE_SELECT, filtering && FACTORY_ALONE)}>
                  <option value="all">All factories</option>
                  {factoryChoices.map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.label} · {t.count}
                    </option>
                  ))}
                </FilterSelect>
              </>
            )}
            {/* From a tablet up the select keeps its width in a full row; the factory tabs beside it give way and scroll. */}
            <FilterSelect label="Inspector" value={inspectorFilter} onChange={setInspectorFilter} className={cn('md:shrink-0', PHONE_SELECT)}>
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

      {/* The machines with something open, spread out, each coloured by the worst signal on it; tap one to see it alone.
          Below a desktop's width they scroll sideways in one row, with a shadow where chips hide. */}
      {seesAll && groupsInFactory.length > 1 && (
        <Strip label="Machine" follow={activeMachine} className="-mx-1" stripClassName="flex gap-2 px-1 pb-1 pt-0.5 touch:scrollbar-none lg:flex-wrap lg:overflow-visible">
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
        </Strip>
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
      ) : view === 'table' ? (
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

      {can('view-history') && <RecentlyClosed machineName={machineLabel} />}

      <NewInspectionDialog open={newOpen} onClose={() => setNewOpen(false)} />
      {scrapOpen && <ScrapDialog onClose={() => setScrapOpen(false)} />}

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
        onCorrectQuantities={details && (details.status === 'Open' ? can('edit-open-session') : can('edit-closed-session')) ? (s) => setCorrectingQty(s) : undefined}
      />
      {correctingQty && <SessionQuantitiesDialog session={correctingQty} onClose={() => setCorrectingQty(null)} />}
      {holdFor && <HoldDecisionDialog session={holdFor} onClose={() => setHoldFor(null)} />}

      {closing && (
        <CloseSessionDialog
          process={processForMachine(machines.find((m) => m.code === closing.workCenterCode) ?? null, closing.workCenterCode)}
          session={closing}
          onClose={() => setClosing(null)}
          // A failure is thrown back to the dialog, which stays open with what was typed and says why.
          onConfirm={async (body) => {
            await closeSession(queryClient, closing.id, { ...body, version: closing.version })
            toast('Session closed.', 'success')
            setClosing(null)
          }}
          onDiscard={async () => {
            await discardSession(queryClient, closing.id)
            toast('Session discarded. Nothing was recorded in it.', 'success')
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
  /** Closes the session; throws when it could not, and the dialog stays open with the reason. */
  onConfirm: (body: Omit<CloseSessionRequest, 'version'>) => Promise<void>
  /** Discards the session; throws when it could not. */
  onDiscard: () => Promise<void>
}) {
  // One close or discard at a time — a second tap before the button greys out finds it under way — and a failure
  // keeps the dialog, and the quantity typed in it, with the reason under it.
  const { busy, error, run } = useBusyAction()
  // A deploy waits while the quantity is being typed (lib/appUpdate.ts).
  useHoldUpdates(true)
  const dismiss = () => {
    if (!busy) onClose()
  }
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
    if (universal && read && !('problem' in read)) {
      const choice = read.choice
      const finalQty = read.finalQty
      void run(() => onConfirm({ universal: choice, ...(finalQty !== undefined ? { finalQty } : {}) }), 'Could not close the session.')
    } else if (!universal) void run(() => onConfirm({ finalQty: parsed }), 'Could not close the session.')
  }
  const discard = () => void run(onDiscard, 'Could not discard the session.')
  const failure = error && (
    <p role="alert" className="flex items-start gap-1.5 rounded-xl bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
    </p>
  )

  // With no sample there is nothing to close as a record: the session is discarded instead.
  if ((session.sampleCount ?? 0) === 0) {
    return (
      <Modal
        open
        onClose={dismiss}
        title="Nothing recorded yet"
        icon={<Lock className="h-5 w-5" />}
        size="sm"
        footer={
          <>
            <Button variant="secondary" disabled={busy} onClick={onClose}>
              Keep it open
            </Button>
            <Button variant="danger" disabled={busy} onClick={discard}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} Discard session
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-slate-600 dark:text-slate-300">
            This session has no sample, so it cannot be closed as an inspection record. Record a sample first, or discard the session: it leaves the board and
            History, and the discard is written to the audit log with your name.
          </p>
          {failure}
        </div>
      </Modal>
    )
  }

  return (
    <Modal
      open
      onClose={dismiss}
      title="Close session"
      icon={<Lock className="h-5 w-5" />}
      size="sm"
      footer={
        <>
          {/* The safe choice drawn as a button beside the solid one, not as stray text. */}
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid || busy} onClick={confirm}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />} {busy ? 'Closing…' : 'Close session'}
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
        {failure}
      </div>
    </Modal>
  )
}

/**
 * A row of tabs or chips (role tablist) that scrolls sideways when it is
 * longer than its room: a shadow at each end that hides tabs says there is
 * more that way, and the chosen tab (`follow` names it) is scrolled into view
 * whenever it changes or the row is drawn again, never the page around it.
 * The strip is positioned, so nothing inside it can widen the page.
 */
function Strip({
  label,
  follow,
  className,
  stripClassName,
  shadowClassName,
  children,
}: {
  label: string
  follow: string
  className?: string
  stripClassName?: string
  shadowClassName?: string
  children: ReactNode
}) {
  const strip = useRef<HTMLDivElement>(null)
  const edges = useScrollEdges(strip)
  useLayoutEffect(() => {
    const el = strip.current
    const tab = el?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (!el || !tab || el.scrollWidth <= el.clientWidth) return
    // Measured against the strip, with a little room beside the tab so the shadow does not lie over it.
    const frame = el.getBoundingClientRect()
    const box = tab.getBoundingClientRect()
    const room = 24
    if (box.left < frame.left + room) el.scrollLeft -= frame.left + room - box.left
    else if (box.right > frame.right - room) el.scrollLeft += box.right - (frame.right - room)
  }, [follow])
  return (
    <div className={cn('relative', className)}>
      <div ref={strip} role="tablist" aria-label={label} className={cn('relative overflow-x-auto overscroll-x-contain', stripClassName)}>
        {children}
      </div>
      <EdgeShadows {...edges} className={shadowClassName} />
    </div>
  )
}

