import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Plus,
  Search,
  FileText,
  Factory,
  Play,
  XCircle,
  ChevronRight,
  ChevronDown,
  Layers,
  Boxes,
  AlertTriangle,
  Trash2,
} from 'lucide-react'
import { useDB, actions } from '@/store/db'
import { groupSessionsByMachine, sessionView, orderById, samplesOf, sessionHasHold } from '@/lib/selectors'
import { Badge, Button, Card, Modal, statusTone } from '@/components/ui'
import { NewInspectionDialog } from '@/components/inspection/NewInspectionDialog'
import { formatDate, cn } from '@/lib/utils'
import type { InspectionSession } from '@/types'

type Filter = 'open' | 'all'

export function InspectionsPage() {
  const db = useDB()
  const navigate = useNavigate()
  const [newOpen, setNewOpen] = useState(false)
  const [filter, setFilter] = useState<Filter>('open')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [confirmDelete, setConfirmDelete] = useState<InspectionSession | null>(null)

  const sessions = useMemo(() => {
    const list = [...db.sessions].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
    return filter === 'open' ? list.filter((s) => s.status === 'Open') : list
  }, [db.sessions, filter])

  const groups = useMemo(() => groupSessionsByMachine(db, sessions), [db, sessions])

  return (
    <div className="space-y-5">
      {/* Quick actions */}
      <div className="grid grid-cols-3 gap-3">
        <QuickAction icon={<Plus className="h-6 w-6" />} title="New" subtitle="Inspection" onClick={() => setNewOpen(true)} primary />
        <QuickAction icon={<Search className="h-6 w-6" />} title="Coil" subtitle="Search" onClick={() => navigate('/history?tab=coils')} />
        <QuickAction icon={<FileText className="h-6 w-6" />} title="PDI" subtitle="Documents" onClick={() => navigate('/orders')} />
      </div>

      {/* Section header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">Inspection Sessions</h2>
          <Badge tone="blue">{db.sessions.length}</Badge>
        </div>
        <div className="inline-flex rounded-xl bg-slate-100 p-1 dark:bg-slate-800">
          {(['open', 'all'] as Filter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                'rounded-lg px-3.5 py-1.5 text-sm font-semibold capitalize transition-colors',
                filter === f ? 'bg-white text-brand-600 shadow-sm dark:bg-slate-700 dark:text-white' : 'text-slate-500',
              )}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {groups.length === 0 && (
        <Card className="p-10 text-center">
          <Factory className="mx-auto h-10 w-10 text-slate-300" />
          <p className="mt-3 font-semibold">No {filter === 'open' ? 'open ' : ''}inspection sessions</p>
          <p className="mt-1 text-sm text-slate-400">Start a new inspection to begin recording samples.</p>
          <Button variant="primary" className="mx-auto mt-4" onClick={() => setNewOpen(true)}>
            <Plus className="h-4 w-4" /> New Inspection
          </Button>
        </Card>
      )}

      {/* Machine groups */}
      <div className="space-y-4">
        {groups.map((g) => (
          <Card key={g.machine.id} className="overflow-hidden">
            <div className="flex items-center gap-3 border-b border-slate-100 px-4 py-3.5 dark:border-slate-800">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-100 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300">
                <Factory className="h-5 w-5" />
              </span>
              <h3 className="flex-1 text-lg font-extrabold leading-tight">{g.machine.name}</h3>
              <Badge tone="neutral">{g.sampleCount} samples</Badge>
            </div>

            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {g.sessions.map((s) => {
                const order = orderById(db, s.orderId)
                const isOpen = expanded[s.id]
                const samples = samplesOf(db, s.id)
                const remaining = order ? Math.max(0, order.requiredQty - order.finishedQty) : 0
                return (
                  <div key={s.id} className={cn('px-4 py-3.5', isOpen && 'bg-slate-50/70 dark:bg-slate-800/30')}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-bold">{order?.orderId ?? '—'}</span>
                          <Badge tone="neutral">{s.sampleCount} samples</Badge>
                          <Badge tone={statusTone(s.status)}>{s.status.toUpperCase()}</Badge>
                        </div>
                        <p className="mt-0.5 truncate text-sm font-medium text-brand-600 dark:text-brand-400">
                          {order?.item} : {order?.itemCode} : {order?.nominalL} : {order?.color}
                        </p>
                        <p className="mt-0.5 text-xs text-slate-400">
                          {formatDate(s.startedAt)} · By {s.inspector}
                        </p>
                      </div>
                      <button
                        onClick={() => setExpanded((e) => ({ ...e, [s.id]: !e[s.id] }))}
                        className="shrink-0 rounded-lg p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700"
                        aria-label="Toggle details"
                      >
                        {isOpen ? <ChevronDown className="h-5 w-5" /> : <ChevronRight className="h-5 w-5" />}
                      </button>
                    </div>

                    <div className="mt-2.5 flex items-center gap-2">
                      <span className="rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-500 dark:bg-slate-800 dark:text-slate-300">
                        QTY {s.finalQty ?? 0}
                      </span>
                      <Badge tone={s.confirm === 'Confirmed' ? 'green' : 'amber'}>{s.confirm.toUpperCase()}</Badge>
                      {s.holdCount > 0 && (
                        <Badge tone="amber" icon={<AlertTriangle className="h-3 w-3" />}>
                          {s.holdCount} hold
                        </Badge>
                      )}
                    </div>

                    <div className="mt-2.5 flex items-center gap-2">
                      <Button variant="primary" className="flex-1" onClick={() => navigate(`/session/${s.id}`)}>
                        <Play className="h-4 w-4" /> Continue
                      </Button>
                      <button
                        onClick={() => setConfirmDelete(s)}
                        className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-rose-500 ring-1 ring-rose-200 transition-colors hover:bg-rose-50 dark:ring-rose-500/30 dark:hover:bg-rose-500/10"
                        aria-label="Discard session"
                      >
                        <XCircle className="h-6 w-6" />
                      </button>
                    </div>

                    {/* Expanded order detail (matches screenshot) */}
                    {isOpen && order && (
                      <div className="mt-3 rounded-2xl border border-slate-200 p-4 dark:border-slate-700">
                        <div className="grid grid-cols-3 gap-2 text-center">
                          <Metric label="REQ Q" value={order.requiredQty} />
                          <Metric label="FINISHED" value={order.finishedQty} tone="green" />
                          <Metric label="REMAIN" value={remaining} tone="blue" />
                        </div>
                        <div className="mt-3">
                          <Badge tone="neutral">{order.status}</Badge>
                        </div>
                        <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                          <Detail label="DWG" value={order.drawing} accent />
                          <Detail label="ROUTE" value={order.route} />
                          <Detail label="COLOR" value={order.color} />
                          <Detail label="DATE" value={formatDate(order.date)} />
                        </div>
                        <div className="mt-3 flex flex-wrap gap-3 text-sm text-slate-500 dark:text-slate-400">
                          <span>T: <b className="text-slate-800 dark:text-slate-100">{order.nominalT.toFixed(2)}</b></span>
                          <span>W: <b className="text-slate-800 dark:text-slate-100">{order.nominalW.toFixed(2)}</b></span>
                          <span>L: <b className="text-slate-800 dark:text-slate-100">{order.nominalL.toFixed(2)}</b></span>
                        </div>
                        <div className="mt-3 border-t border-slate-100 pt-3 dark:border-slate-700">
                          <p className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase text-slate-400">
                            <Boxes className="h-3.5 w-3.5" /> Samples
                          </p>
                          <div className="flex flex-wrap gap-2">
                            {samples.length === 0 && <span className="text-xs text-slate-400">No samples yet.</span>}
                            {samples.map((sm) => (
                              <button
                                key={sm.id}
                                onClick={() => navigate(`/session/${s.id}?sample=${sm.id}`)}
                                className="rounded-lg bg-brand-50 px-3 py-1.5 text-sm font-semibold text-brand-700 ring-1 ring-brand-200 hover:bg-brand-100 dark:bg-brand-500/10 dark:text-brand-300 dark:ring-brand-500/20"
                              >
                                {sm.label}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </Card>
        ))}
      </div>

      <NewInspectionDialog open={newOpen} onClose={() => setNewOpen(false)} />

      <Modal
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        title="Discard session?"
        icon={<Trash2 className="h-5 w-5" />}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (confirmDelete) actions.deleteSession(confirmDelete.id)
                setConfirmDelete(null)
              }}
            >
              <Trash2 className="h-4 w-4" /> Discard
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-600 dark:text-slate-300">
          This will permanently remove the session, its samples, measurements, defects and images. This cannot be undone.
        </p>
        {confirmDelete && sessionHasHold(db, confirmDelete.id) && (
          <div className="mt-3 flex items-center gap-2 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:bg-amber-500/10 dark:text-amber-400">
            <AlertTriangle className="h-4 w-4" /> This session has open Hold defects.
          </div>
        )}
      </Modal>
    </div>
  )
}

function QuickAction({
  icon,
  title,
  subtitle,
  onClick,
  primary,
}: {
  icon: React.ReactNode
  title: string
  subtitle: string
  onClick: () => void
  primary?: boolean
}) {
  return (
    <button onClick={onClick} className="card flex flex-col items-center gap-2 p-4 transition-transform active:scale-[.97] sm:p-5">
      <span
        className={cn(
          'grid h-14 w-14 place-items-center rounded-full text-white shadow-sm',
          primary ? 'bg-brand-600' : 'bg-brand-500',
        )}
      >
        {icon}
      </span>
      <div className="text-center leading-tight">
        <p className="font-bold">{title}</p>
        <p className="text-sm text-slate-500 dark:text-slate-400">{subtitle}</p>
      </div>
    </button>
  )
}

function Metric({ label, value, tone }: { label: string; value: number; tone?: 'green' | 'blue' }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase text-slate-400">{label}</p>
      <p
        className={cn(
          'text-2xl font-bold tabular-nums',
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
      <p className={cn('font-semibold', accent ? 'text-brand-600 dark:text-brand-400' : 'text-slate-800 dark:text-slate-100')}>{value}</p>
    </div>
  )
}
