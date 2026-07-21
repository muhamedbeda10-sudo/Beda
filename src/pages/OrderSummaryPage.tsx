import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Search,
  Package,
  Factory,
  CheckCircle2,
  Loader,
  Activity,
  Play,
  ChevronRight,
  ClipboardList,
  Boxes,
} from 'lucide-react'
import { useDB, actions } from '@/store/db'
import { machineById, sessionView } from '@/lib/selectors'
import { Badge, Button, Card, Modal, Field, Input, Select, Stat, EmptyState } from '@/components/ui'
import { formatDate, cn } from '@/lib/utils'
import type {
  ProductionOrder,
  InspectionCoverage,
  OrderStatus,
} from '@/types'

type BadgeTone = 'neutral' | 'green' | 'blue' | 'amber' | 'red' | 'violet'

function coverageTone(c: InspectionCoverage): BadgeTone {
  return c === 'Inspected' ? 'green' : c === 'In Progress' ? 'blue' : 'neutral'
}

function orderStatusTone(s: OrderStatus): BadgeTone {
  return s === 'Active' ? 'green' : s === 'On Hold' ? 'amber' : s === 'Completed' ? 'blue' : 'red'
}

const COVERAGES: InspectionCoverage[] = ['Not Started', 'In Progress', 'Inspected']
const STATUSES: OrderStatus[] = ['Active', 'On Hold', 'Completed', 'Cancelled']

export function OrderSummaryPage() {
  const db = useDB()
  const navigate = useNavigate()

  const [query, setQuery] = useState('')
  const [machineFilter, setMachineFilter] = useState<string>('all')
  const [coverageFilter, setCoverageFilter] = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [selected, setSelected] = useState<ProductionOrder | null>(null)

  // Session count per order id
  const sessionCounts = useMemo(() => {
    const map = new Map<string, number>()
    for (const s of db.sessions) map.set(s.orderId, (map.get(s.orderId) ?? 0) + 1)
    return map
  }, [db.sessions])

  const stats = useMemo(() => {
    return {
      total: db.orders.length,
      active: db.orders.filter((o) => o.status === 'Active').length,
      inspected: db.orders.filter((o) => o.coverage === 'Inspected').length,
      inProgress: db.orders.filter((o) => o.coverage === 'In Progress').length,
    }
  }, [db.orders])

  const orders = useMemo(() => {
    const q = query.trim().toLowerCase()
    return db.orders
      .filter((o) => {
        if (q) {
          const hay = `${o.orderId} ${o.item} ${o.itemCode}`.toLowerCase()
          if (!hay.includes(q)) return false
        }
        if (machineFilter !== 'all' && o.machineId !== machineFilter) return false
        if (coverageFilter !== 'all' && o.coverage !== coverageFilter) return false
        if (statusFilter !== 'all' && o.status !== statusFilter) return false
        return true
      })
      .sort((a, b) => (a.date < b.date ? 1 : -1))
  }, [db.orders, query, machineFilter, coverageFilter, statusFilter])

  return (
    <div className="space-y-5">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-extrabold leading-tight">Order Summary</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Review production orders and their inspection coverage at a glance.
        </p>
      </div>

      {/* Stat tiles */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Total Orders" value={stats.total} icon={<Package className="h-5 w-5" />} tone="blue" />
        <Stat label="Active" value={stats.active} icon={<Activity className="h-5 w-5" />} tone="green" />
        <Stat label="Inspected" value={stats.inspected} icon={<CheckCircle2 className="h-5 w-5" />} tone="green" />
        <Stat label="In Progress" value={stats.inProgress} icon={<Loader className="h-5 w-5" />} tone="amber" />
      </div>

      {/* Filters */}
      <Card className="p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Field label="Search">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <Input
                  className="pl-9"
                  placeholder="Order, item or code…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
            </Field>
          </div>
          <div className="sm:w-44">
            <Field label="Machine">
              <Select value={machineFilter} onChange={(e) => setMachineFilter(e.target.value)}>
                <option value="all">All machines</option>
                {db.machines.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="sm:w-40">
            <Field label="Coverage">
              <Select value={coverageFilter} onChange={(e) => setCoverageFilter(e.target.value)}>
                <option value="all">All coverage</option>
                {COVERAGES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="sm:w-40">
            <Field label="Status">
              <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                <option value="all">All status</option>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </div>
      </Card>

      {orders.length === 0 ? (
        <EmptyState
          icon={<ClipboardList className="h-10 w-10" />}
          title="No orders match"
          hint="Try adjusting the search or filters above."
        />
      ) : (
        <>
          {/* Desktop table */}
          <Card className="hidden overflow-hidden md:block">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] text-sm">
                <thead>
                  <tr className="border-b border-slate-100 text-left text-xs font-semibold uppercase tracking-wide text-slate-400 dark:border-slate-800">
                    <th className="px-4 py-3">Order</th>
                    <th className="px-4 py-3">Item</th>
                    <th className="px-4 py-3">Machine</th>
                    <th className="px-4 py-3 text-right">Req / Fin / Rem</th>
                    <th className="px-4 py-3">Progress</th>
                    <th className="px-4 py-3">Coverage</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3 text-right">Sessions</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {orders.map((o) => {
                    const machine = machineById(db, o.machineId)
                    const remaining = Math.max(0, o.requiredQty - o.finishedQty)
                    const pct = o.requiredQty > 0 ? Math.min(100, Math.round((o.finishedQty / o.requiredQty) * 100)) : 0
                    return (
                      <tr
                        key={o.id}
                        onClick={() => setSelected(o)}
                        className="cursor-pointer transition-colors hover:bg-slate-50/70 dark:hover:bg-slate-800/40"
                      >
                        <td className="px-4 py-3 font-bold">{o.orderId}</td>
                        <td className="px-4 py-3">
                          <div className="font-medium text-slate-800 dark:text-slate-100">{o.item}</div>
                          <div className="text-xs text-slate-400">{o.itemCode}</div>
                        </td>
                        <td className="px-4 py-3 text-slate-600 dark:text-slate-300">{machine?.name ?? '—'}</td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          <span className="text-slate-700 dark:text-slate-200">{o.requiredQty}</span>
                          <span className="text-slate-300 dark:text-slate-600"> / </span>
                          <span className="text-emerald-600 dark:text-emerald-400">{o.finishedQty}</span>
                          <span className="text-slate-300 dark:text-slate-600"> / </span>
                          <span className="text-brand-600 dark:text-brand-400">{remaining}</span>
                        </td>
                        <td className="px-4 py-3">
                          <ProgressBar pct={pct} />
                        </td>
                        <td className="px-4 py-3">
                          <Badge tone={coverageTone(o.coverage)}>{o.coverage}</Badge>
                        </td>
                        <td className="px-4 py-3">
                          <Badge tone={orderStatusTone(o.status)}>{o.status}</Badge>
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums font-semibold">
                          {sessionCounts.get(o.id) ?? 0}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <ChevronRight className="ml-auto h-4 w-4 text-slate-300 dark:text-slate-600" />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          {/* Mobile cards */}
          <div className="space-y-3 md:hidden">
            {orders.map((o) => {
              const machine = machineById(db, o.machineId)
              const remaining = Math.max(0, o.requiredQty - o.finishedQty)
              const pct = o.requiredQty > 0 ? Math.min(100, Math.round((o.finishedQty / o.requiredQty) * 100)) : 0
              return (
                <Card key={o.id} className="p-4 transition-transform active:scale-[.99]">
                  <button onClick={() => setSelected(o)} className="block w-full cursor-pointer text-left">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-bold">{o.orderId}</p>
                        <p className="mt-0.5 truncate text-sm font-medium text-brand-600 dark:text-brand-400">
                          {o.item} · {o.itemCode}
                        </p>
                      </div>
                      <Badge tone={coverageTone(o.coverage)}>{o.coverage}</Badge>
                    </div>
                    <p className="mt-1 flex items-center gap-1.5 text-xs text-slate-400">
                      <Factory className="h-3.5 w-3.5" /> {machine?.name ?? '—'}
                    </p>
                    <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                      <MiniMetric label="REQ" value={o.requiredQty} />
                      <MiniMetric label="FIN" value={o.finishedQty} tone="green" />
                      <MiniMetric label="REM" value={remaining} tone="blue" />
                    </div>
                    <div className="mt-3">
                      <ProgressBar pct={pct} />
                    </div>
                    <div className="mt-3 flex items-center justify-between gap-2">
                      <Badge tone={orderStatusTone(o.status)}>{o.status}</Badge>
                      <Badge tone="neutral" icon={<Boxes className="h-3 w-3" />}>
                        {sessionCounts.get(o.id) ?? 0} sessions
                      </Badge>
                    </div>
                  </button>
                </Card>
              )
            })}
          </div>
        </>
      )}

      {/* Detail modal */}
      <OrderDetailModal order={selected} onClose={() => setSelected(null)} navigate={navigate} />
    </div>
  )
}

function OrderDetailModal({
  order,
  onClose,
  navigate,
}: {
  order: ProductionOrder | null
  onClose: () => void
  navigate: (to: string) => void
}) {
  const db = useDB()

  const sessions = useMemo(() => {
    if (!order) return []
    return db.sessions
      .filter((s) => s.orderId === order.id)
      .map((s) => sessionView(db, s))
      .sort((a, b) => b.seq - a.seq)
  }, [db, order])

  if (!order) return null

  const machine = machineById(db, order.machineId)
  const remaining = Math.max(0, order.requiredQty - order.finishedQty)
  const pct = order.requiredQty > 0 ? Math.min(100, Math.round((order.finishedQty / order.requiredQty) * 100)) : 0

  function startInspection() {
    if (!order) return
    const s = actions.createSession({ orderId: order.id, machineId: order.machineId, confirm: 'Confirmed' })
    onClose()
    navigate(`/session/${s.id}`)
  }

  return (
    <Modal
      open={!!order}
      onClose={onClose}
      title={order.orderId}
      icon={<Package className="h-5 w-5" />}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" onClick={startInspection}>
            <Play className="h-4 w-4" /> Start Inspection
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={coverageTone(order.coverage)}>{order.coverage}</Badge>
          <Badge tone={orderStatusTone(order.status)}>{order.status}</Badge>
          <span className="text-sm text-slate-500 dark:text-slate-400">
            {machine?.name ?? '—'}
          </span>
        </div>

        {/* Quantities */}
        <div className="grid grid-cols-3 gap-2 rounded-2xl border border-slate-200 p-4 text-center dark:border-slate-700">
          <MiniMetric label="REQUIRED" value={order.requiredQty} />
          <MiniMetric label="FINISHED" value={order.finishedQty} tone="green" />
          <MiniMetric label="REMAINING" value={remaining} tone="blue" />
          <div className="col-span-3 mt-1">
            <ProgressBar pct={pct} />
            <p className="mt-1 text-xs text-slate-400 tabular-nums">{pct}% finished</p>
          </div>
        </div>

        {/* Fields */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3">
          <Detail label="Item" value={order.item} />
          <Detail label="Item Code" value={order.itemCode} />
          <Detail label="Drawing" value={order.drawing} accent />
          <Detail label="Route" value={order.route} />
          <Detail label="Color" value={order.color} />
          <Detail label="Date" value={formatDate(order.date)} />
          <Detail label="Nominal T" value={order.nominalT.toFixed(2)} />
          <Detail label="Nominal W" value={order.nominalW.toFixed(2)} />
          <Detail label="Nominal L" value={order.nominalL.toFixed(2)} />
        </div>

        {/* Sessions */}
        <div className="border-t border-slate-100 pt-4 dark:border-slate-800">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase text-slate-400">
            <Boxes className="h-3.5 w-3.5" /> Inspection Sessions ({sessions.length})
          </p>
          {sessions.length === 0 ? (
            <p className="text-sm text-slate-400">No inspection sessions yet for this order.</p>
          ) : (
            <div className="space-y-2">
              {sessions.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center gap-3 rounded-xl border border-slate-200 px-3 py-2.5 dark:border-slate-700"
                >
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand-600 text-sm font-bold text-white tabular-nums">
                    {s.seq}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={s.status === 'Open' ? 'green' : 'neutral'}>{s.status}</Badge>
                      <span className="text-xs text-slate-400 tabular-nums">{s.sampleCount} samples</span>
                    </div>
                    <p className="mt-0.5 truncate text-xs text-slate-400">By {s.inspector}</p>
                  </div>
                  <Button variant="secondary" onClick={() => navigate(`/session/${s.id}`)}>
                    Open
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}

function ProgressBar({ pct }: { pct: number }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
      <div
        className="h-full rounded-full bg-brand-500 transition-all"
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

function MiniMetric({ label, value, tone }: { label: string; value: number; tone?: 'green' | 'blue' }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase text-slate-400">{label}</p>
      <p
        className={cn(
          'text-xl font-bold tabular-nums',
          tone === 'green' && 'text-emerald-500',
          tone === 'blue' && 'text-brand-500',
        )}
      >
        {value}
      </p>
    </div>
  )
}

function Detail({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase text-slate-400">{label}</p>
      <p className={cn('font-semibold', accent ? 'text-brand-600 dark:text-brand-400' : 'text-slate-800 dark:text-slate-100')}>
        {value || '—'}
      </p>
    </div>
  )
}
