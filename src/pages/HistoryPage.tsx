import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  Search,
  History as HistoryIcon,
  Layers,
  CheckCircle2,
  Boxes,
  AlertTriangle,
  Ruler,
  Eye,
  ImageIcon,
  Play,
} from 'lucide-react'
import { useDB } from '@/store/db'
import {
  sessionView,
  orderById,
  machineById,
  samplesOf,
  dimsOf,
  defectsOf,
  imagesOf,
  sessionDefects,
  type SessionView,
} from '@/lib/selectors'
import {
  Badge,
  Button,
  Card,
  Modal,
  Field,
  Input,
  Select,
  Stat,
  EmptyState,
  statusTone,
  resultTone,
  dispositionTone,
} from '@/components/ui'
import { Lightbox } from '@/components/ui/Lightbox'
import { cn, formatDate, formatDateTime, daysAgoISO } from '@/lib/utils'
import type { InspectionImage, InspectionSession } from '@/types'

type StatusFilter = 'all' | 'Open' | 'Closed'
type RangeFilter = 'all' | '7' | '30' | '90'
type Tab = 'sessions' | 'coils'

const RANGE_LABEL: Record<RangeFilter, string> = {
  all: 'All time',
  '7': 'Last 7 days',
  '30': 'Last 30 days',
  '90': 'Last 90 days',
}

export function HistoryPage() {
  const db = useDB()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()

  const tab: Tab = params.get('tab') === 'coils' ? 'coils' : 'sessions'
  const setTab = (t: Tab) => {
    const next = new URLSearchParams(params)
    if (t === 'coils') next.set('tab', 'coils')
    else next.delete('tab')
    setParams(next, { replace: true })
  }

  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [machineFilter, setMachineFilter] = useState<string>('all')
  const [range, setRange] = useState<RangeFilter>('all')
  const [detail, setDetail] = useState<InspectionSession | null>(null)

  const machines = useMemo(
    () => [...db.machines].sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true })),
    [db.machines],
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const cutoff = range === 'all' ? null : daysAgoISO(Number(range))
    return db.sessions
      .map((s) => sessionView(db, s))
      .filter((v) => {
        if (status !== 'all' && v.status !== status) return false
        if (machineFilter !== 'all' && v.machineId !== machineFilter) return false
        if (cutoff && v.startedAt < cutoff) return false
        if (q) {
          const hay = [
            v.order?.orderId,
            v.order?.item,
            v.order?.itemCode,
            v.inspector,
            v.machine?.name,
            v.machine?.code,
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()
          if (!hay.includes(q)) return false
        }
        return true
      })
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
  }, [db, query, status, machineFilter, range])

  const stats = useMemo(() => {
    let closed = 0
    let samples = 0
    let defects = 0
    for (const v of filtered) {
      if (v.status === 'Closed') closed++
      samples += v.sampleCount
      defects += v.defectCount
    }
    return { total: filtered.length, closed, samples, defects }
  }, [filtered])

  // ---- Coils tab: flatten samples that carry a coil id -----------------------
  const coilRows = useMemo(() => {
    const q = query.trim().toLowerCase()
    const rows = db.samples
      .filter((s) => s.coilId && s.coilId.trim() !== '')
      .map((sample) => {
        const session = db.sessions.find((x) => x.id === sample.sessionId)
        const order = session ? orderById(db, session.orderId) : undefined
        const machine = session ? machineById(db, session.machineId) : undefined
        return { sample, session, order, machine }
      })
      .filter((r) => r.session)
      .filter((r) => {
        if (!q) return true
        const hay = [r.sample.coilId, r.sample.label, r.order?.orderId, r.order?.item, r.machine?.name]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
        return hay.includes(q)
      })
      .sort((a, b) => (a.sample.createdAt < b.sample.createdAt ? 1 : -1))
    return rows
  }, [db, query])

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-brand-100 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300">
            <HistoryIcon className="h-6 w-6" />
          </span>
          <div>
            <h1 className="text-2xl font-bold leading-tight">History</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Audit-friendly record of past inspection sessions, samples and coils.
            </p>
          </div>
        </div>
        <div className="inline-flex rounded-xl bg-slate-100 p-1 dark:bg-slate-800">
          {(['sessions', 'coils'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                'rounded-lg px-3.5 py-1.5 text-sm font-semibold capitalize transition-colors',
                tab === t ? 'bg-white text-brand-600 shadow-sm dark:bg-slate-700 dark:text-white' : 'text-slate-500',
              )}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* Filter bar */}
      <Card className="p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="sm:col-span-2 lg:col-span-1">
            <Field label="Search">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={tab === 'coils' ? 'Coil, order, item…' : 'Order, item, inspector, machine…'}
                  className="pl-9"
                />
              </div>
            </Field>
          </div>

          {tab === 'sessions' && (
            <>
              <Field label="Status">
                <Select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
                  <option value="all">All statuses</option>
                  <option value="Open">Open</option>
                  <option value="Closed">Closed</option>
                </Select>
              </Field>

              <Field label="Machine">
                <Select value={machineFilter} onChange={(e) => setMachineFilter(e.target.value)}>
                  <option value="all">All machines</option>
                  {machines.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.code} · {m.name}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="Date range">
                <Select value={range} onChange={(e) => setRange(e.target.value as RangeFilter)}>
                  {(['all', '7', '30', '90'] as RangeFilter[]).map((r) => (
                    <option key={r} value={r}>
                      {RANGE_LABEL[r]}
                    </option>
                  ))}
                </Select>
              </Field>
            </>
          )}
        </div>
      </Card>

      {tab === 'sessions' ? (
        <>
          {/* Stat tiles */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Sessions" value={stats.total} icon={<Layers className="h-5 w-5" />} tone="blue" />
            <Stat
              label="Closed"
              value={stats.closed}
              sub={`${stats.total - stats.closed} open`}
              icon={<CheckCircle2 className="h-5 w-5" />}
              tone="green"
            />
            <Stat label="Samples" value={stats.samples} icon={<Boxes className="h-5 w-5" />} tone="neutral" />
            <Stat
              label="Defects"
              value={stats.defects}
              icon={<AlertTriangle className="h-5 w-5" />}
              tone={stats.defects > 0 ? 'amber' : 'neutral'}
            />
          </div>

          {filtered.length === 0 ? (
            <EmptyState
              icon={<HistoryIcon className="h-10 w-10" />}
              title="No sessions match your filters"
              hint="Try clearing the search or widening the date range."
            />
          ) : (
            <>
              {/* Mobile: cards */}
              <div className="space-y-3 md:hidden">
                {filtered.map((v) => (
                  <SessionCard key={v.id} view={v} onOpen={() => setDetail(v)} />
                ))}
              </div>

              {/* Desktop: table */}
              <Card className="hidden overflow-hidden md:block">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-100 text-left text-xs font-semibold uppercase tracking-wide text-slate-400 dark:border-slate-800">
                        <th className="px-4 py-3">#</th>
                        <th className="px-4 py-3">Order</th>
                        <th className="px-4 py-3">Machine</th>
                        <th className="px-4 py-3">Inspector</th>
                        <th className="px-4 py-3">Started</th>
                        <th className="px-4 py-3">Status</th>
                        <th className="px-4 py-3 text-right">Samples</th>
                        <th className="px-4 py-3 text-right">Defects</th>
                        <th className="px-4 py-3 text-right">Final Qty</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {filtered.map((v) => (
                        <tr
                          key={v.id}
                          onClick={() => setDetail(v)}
                          className="cursor-pointer transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/40"
                        >
                          <td className="px-4 py-3">
                            <span className="grid h-7 w-7 place-items-center rounded-full bg-brand-100 text-xs font-bold text-brand-700 dark:bg-brand-500/15 dark:text-brand-300">
                              {v.seq}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <div className="font-bold">{v.order?.orderId ?? '—'}</div>
                            <div className="truncate text-xs text-brand-600 dark:text-brand-400">
                              {v.order?.item ?? '—'} : {v.order?.itemCode ?? '—'}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-slate-600 dark:text-slate-300">{v.machine?.name ?? '—'}</td>
                          <td className="px-4 py-3 text-slate-600 dark:text-slate-300">{v.inspector}</td>
                          <td className="whitespace-nowrap px-4 py-3 text-slate-500 dark:text-slate-400">
                            {formatDateTime(v.startedAt)}
                          </td>
                          <td className="px-4 py-3">
                            <Badge tone={statusTone(v.status)}>{v.status}</Badge>
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums">{v.sampleCount}</td>
                          <td className="px-4 py-3 text-right tabular-nums">
                            {v.defectCount > 0 ? (
                              <span className="font-semibold text-amber-600 dark:text-amber-400">{v.defectCount}</span>
                            ) : (
                              <span className="text-slate-400">0</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right font-semibold tabular-nums">{v.finalQty ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            </>
          )}
        </>
      ) : (
        <CoilsList rows={coilRows} onOpenSession={(id) => navigate(`/session/${id}`)} />
      )}

      <SessionDetailModal
        session={detail}
        onClose={() => setDetail(null)}
        onOpenSession={(id) => {
          setDetail(null)
          navigate(`/session/${id}`)
        }}
      />
    </div>
  )
}

// ============================================================================
// Session card (mobile)
// ============================================================================
function SessionCard({ view, onOpen }: { view: SessionView; onOpen: () => void }) {
  return (
    <button onClick={onOpen} className="card w-full p-4 text-left transition-transform active:scale-[.99]">
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-100 text-sm font-bold text-brand-700 dark:bg-brand-500/15 dark:text-brand-300">
          {view.seq}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-bold">{view.order?.orderId ?? '—'}</span>
            <Badge tone={statusTone(view.status)}>{view.status}</Badge>
          </div>
          <p className="mt-0.5 truncate text-sm font-medium text-brand-600 dark:text-brand-400">
            {view.order?.item ?? '—'} : {view.order?.itemCode ?? '—'}
          </p>
          <p className="mt-0.5 text-xs text-slate-400">
            {view.machine?.name ?? '—'} · {view.inspector}
          </p>
          <p className="mt-0.5 text-xs text-slate-400">{formatDateTime(view.startedAt)}</p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Badge tone="neutral" icon={<Boxes className="h-3 w-3" />}>
          {view.sampleCount} samples
        </Badge>
        <Badge tone={view.defectCount > 0 ? 'amber' : 'neutral'} icon={<AlertTriangle className="h-3 w-3" />}>
          {view.defectCount} defects
        </Badge>
        <span className="ml-auto rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-500 dark:bg-slate-800 dark:text-slate-300">
          QTY {view.finalQty ?? '—'}
        </span>
      </div>
    </button>
  )
}

// ============================================================================
// Coils tab
// ============================================================================
function CoilsList({
  rows,
  onOpenSession,
}: {
  rows: Array<{
    sample: { id: string; label: string; coilId?: string; createdAt: string }
    session?: InspectionSession
    order?: { orderId: string; item: string } | undefined
    machine?: { name: string } | undefined
  }>
  onOpenSession: (id: string) => void
}) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<Search className="h-10 w-10" />}
        title="No coils found"
        hint="Samples record a coil id when captured. Try a different search."
      />
    )
  }
  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-left text-xs font-semibold uppercase tracking-wide text-slate-400 dark:border-slate-800">
              <th className="px-4 py-3">Coil</th>
              <th className="px-4 py-3">Sample</th>
              <th className="px-4 py-3">Order</th>
              <th className="px-4 py-3">Machine</th>
              <th className="px-4 py-3">Captured</th>
              <th className="px-4 py-3 text-right">Session</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {rows.map((r) => (
              <tr key={r.sample.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                <td className="px-4 py-3 font-bold">{r.sample.coilId}</td>
                <td className="px-4 py-3 text-slate-600 dark:text-slate-300">{r.sample.label}</td>
                <td className="px-4 py-3">
                  <div className="font-semibold">{r.order?.orderId ?? '—'}</div>
                  <div className="truncate text-xs text-brand-600 dark:text-brand-400">{r.order?.item ?? '—'}</div>
                </td>
                <td className="px-4 py-3 text-slate-600 dark:text-slate-300">{r.machine?.name ?? '—'}</td>
                <td className="whitespace-nowrap px-4 py-3 text-slate-500 dark:text-slate-400">
                  {formatDateTime(r.sample.createdAt)}
                </td>
                <td className="px-4 py-3 text-right">
                  {r.session && (
                    <Button variant="ghost" onClick={() => onOpenSession(r.session!.id)}>
                      <Play className="h-4 w-4" /> Open
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

// ============================================================================
// Session detail modal — full drill-down
// ============================================================================
function SessionDetailModal({
  session,
  onClose,
  onOpenSession,
}: {
  session: InspectionSession | null
  onClose: () => void
  onOpenSession: (id: string) => void
}) {
  const db = useDB()
  const [lightbox, setLightbox] = useState<{ images: InspectionImage[]; index: number } | null>(null)

  const data = useMemo(() => {
    if (!session) return null
    const view = sessionView(db, session)
    const samples = samplesOf(db, session.id)
    const allDefects = sessionDefects(db, session.id)
    let measurements = 0
    let imageCount = 0
    const perSample = samples.map((sample) => {
      const dims = dimsOf(db, sample.id)
      const defects = defectsOf(db, sample.id)
      const sampleImages = imagesOf(db, 'sample', sample.id)
      const defectImages = defects.flatMap((d) => imagesOf(db, 'defect', d.id))
      const images = [...sampleImages, ...defectImages]
      measurements += dims.length
      imageCount += images.length
      return { sample, dims, defects, sampleImages, defectImages, images }
    })
    return { view, samples, allDefects, perSample, measurements, imageCount }
  }, [db, session])

  const open = !!session && !!data

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        size="xl"
        icon={<Layers className="h-5 w-5" />}
        title={data ? `Session #${data.view.seq} · ${data.view.order?.orderId ?? '—'}` : 'Session'}
        footer={
          session && (
            <>
              <Button variant="ghost" onClick={onClose}>
                Close
              </Button>
              <Button variant="primary" onClick={() => onOpenSession(session.id)}>
                <Play className="h-4 w-4" /> Open session
              </Button>
            </>
          )
        }
      >
        {data && session && (
          <div className="space-y-5">
            {/* Summary header */}
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={statusTone(data.view.status)}>{data.view.status}</Badge>
              <Badge tone={data.view.confirm === 'Confirmed' ? 'green' : 'amber'}>{data.view.confirm}</Badge>
              {data.view.holdCount > 0 && (
                <Badge tone="amber" icon={<AlertTriangle className="h-3 w-3" />}>
                  {data.view.holdCount} hold
                </Badge>
              )}
            </div>

            {/* Order / machine / dates grid */}
            <div className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-2xl border border-slate-200 p-4 text-sm dark:border-slate-700 sm:grid-cols-3">
              <Info label="Order" value={data.view.order?.orderId ?? '—'} accent />
              <Info label="Item" value={data.view.order?.item ?? '—'} />
              <Info label="Item code" value={data.view.order?.itemCode ?? '—'} />
              <Info label="Machine" value={data.view.machine?.name ?? '—'} />
              <Info label="Inspector" value={data.view.inspector} />
              <Info label="Final qty" value={data.view.finalQty != null ? String(data.view.finalQty) : '—'} />
              <Info label="Started" value={formatDateTime(data.view.startedAt)} />
              <Info label="Closed" value={data.view.closedAt ? formatDateTime(data.view.closedAt) : '—'} />
              <Info label="Order date" value={formatDate(data.view.order?.date)} />
            </div>

            {/* Counts */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <MiniStat icon={<Boxes className="h-4 w-4" />} label="Samples" value={data.samples.length} />
              <MiniStat icon={<Ruler className="h-4 w-4" />} label="Measurements" value={data.measurements} />
              <MiniStat icon={<Eye className="h-4 w-4" />} label="Defects" value={data.allDefects.length} />
              <MiniStat icon={<ImageIcon className="h-4 w-4" />} label="Images" value={data.imageCount} />
            </div>

            {session.note && (
              <div className="rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-600 dark:bg-slate-800/50 dark:text-slate-300">
                <span className="font-semibold">Note: </span>
                {session.note}
              </div>
            )}

            {/* Per-sample drill-down */}
            {data.perSample.length === 0 && (
              <EmptyState icon={<Boxes className="h-9 w-9" />} title="No samples recorded" />
            )}

            <div className="space-y-4">
              {data.perSample.map(({ sample, dims, defects, images }) => (
                <div key={sample.id} className="rounded-2xl border border-slate-200 dark:border-slate-700">
                  <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
                    <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-100 text-sm font-bold text-brand-700 dark:bg-brand-500/15 dark:text-brand-300">
                      {sample.label}
                    </span>
                    <span className="font-semibold">Sample {sample.label}</span>
                    <Badge tone={resultTone(sample.result)}>{sample.result}</Badge>
                    {sample.coilId && (
                      <Badge tone="neutral">Coil {sample.coilId}</Badge>
                    )}
                    <span className="ml-auto text-xs text-slate-400">{formatDateTime(sample.createdAt)}</span>
                  </div>

                  <div className="space-y-4 p-4">
                    {/* Dimensions */}
                    <div>
                      <p className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase text-slate-400">
                        <Ruler className="h-3.5 w-3.5" /> Dimensions ({dims.length})
                      </p>
                      {dims.length === 0 ? (
                        <p className="text-xs text-slate-400">No dimension measurements.</p>
                      ) : (
                        <div className="overflow-x-auto rounded-xl border border-slate-100 dark:border-slate-800">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="border-b border-slate-100 text-left text-xs font-semibold uppercase text-slate-400 dark:border-slate-800">
                                <th className="px-3 py-2">Code</th>
                                <th className="px-3 py-2">Target ± Tol</th>
                                <th className="px-3 py-2 text-right">Measured</th>
                                <th className="px-3 py-2 text-right">Result</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                              {dims.map((d) => (
                                <tr key={d.id}>
                                  <td className="px-3 py-2">
                                    <span className="font-semibold">{d.code}</span>
                                    <span className="ml-1 text-xs text-slate-400">{d.name}</span>
                                  </td>
                                  <td className="whitespace-nowrap px-3 py-2 tabular-nums text-slate-600 dark:text-slate-300">
                                    {d.target}
                                    <span className="text-slate-400">
                                      {' '}
                                      (-{d.tolMinus}/+{d.tolPlus}) {d.unit}
                                    </span>
                                  </td>
                                  <td className="px-3 py-2 text-right tabular-nums font-semibold">
                                    {d.measured != null ? `${d.measured} ${d.unit}` : '—'}
                                  </td>
                                  <td className="px-3 py-2 text-right">
                                    <Badge tone={resultTone(d.result)}>{d.result}</Badge>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>

                    {/* Defects */}
                    <div>
                      <p className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase text-slate-400">
                        <Eye className="h-3.5 w-3.5" /> Visual defects ({defects.length})
                      </p>
                      {defects.length === 0 ? (
                        <p className="text-xs text-slate-400">No visual defects.</p>
                      ) : (
                        <div className="space-y-2">
                          {defects.map((def) => (
                            <div
                              key={def.id}
                              className="rounded-xl border border-slate-100 px-3 py-2.5 dark:border-slate-800"
                            >
                              <div className="flex flex-wrap items-center gap-2">
                                <span dir="auto" className="font-semibold">
                                  {def.title}
                                </span>
                                <Badge tone={def.severity === 'Critical' ? 'red' : def.severity === 'Major' ? 'amber' : 'neutral'}>
                                  {def.severity}
                                </Badge>
                                <Badge tone={dispositionTone(def.disposition)}>{def.disposition}</Badge>
                                <span className="ml-auto text-xs text-slate-400">Qty {def.qty}</span>
                              </div>
                              {def.description && (
                                <p dir="auto" className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                                  {def.description}
                                </p>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Images */}
                    <div>
                      <p className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase text-slate-400">
                        <ImageIcon className="h-3.5 w-3.5" /> Images ({images.length})
                      </p>
                      {images.length === 0 ? (
                        <p className="text-xs text-slate-400">No images.</p>
                      ) : (
                        <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
                          {images.map((img, i) => (
                            <button
                              key={img.id}
                              onClick={() => setLightbox({ images, index: i })}
                              className="aspect-square overflow-hidden rounded-lg ring-1 ring-slate-200 transition-transform hover:scale-[1.03] dark:ring-slate-700"
                            >
                              <img src={img.dataUrl} alt={img.caption || 'inspection'} className="h-full w-full object-cover" />
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </Modal>

      {lightbox && (
        <Lightbox images={lightbox.images} startIndex={lightbox.index} onClose={() => setLightbox(null)} />
      )}
    </>
  )
}

function Info({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      <p
        dir="auto"
        className={cn(
          'mt-0.5 truncate font-semibold',
          accent ? 'text-brand-600 dark:text-brand-400' : 'text-slate-800 dark:text-slate-100',
        )}
        title={value}
      >
        {value}
      </p>
    </div>
  )
}

function MiniStat({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="flex items-center gap-3 rounded-xl bg-slate-50 px-3 py-2.5 dark:bg-slate-800/50">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-white text-brand-600 ring-1 ring-slate-200 dark:bg-slate-900 dark:text-brand-300 dark:ring-slate-700">
        {icon}
      </span>
      <div>
        <p className="text-lg font-bold leading-none tabular-nums">{value}</p>
        <p className="text-xs text-slate-400">{label}</p>
      </div>
    </div>
  )
}
