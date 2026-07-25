import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Plus,
  Search,
  FileText,
  Factory,
  Play,
  Trash2,
  ChevronDown,
  AlertTriangle,
  Boxes,
  Lock,
  CheckCircle2,
  ClipboardCheck,
} from 'lucide-react'
import { Badge, Button, Card, EmptyState, Field, Input, Modal } from '@/components/ui'
import { NewInspectionDialog } from '@/components/inspection/NewInspectionDialog'
import { useSmallCollection, useDocsByIds, useWhereIn, useCount, useQueryRows } from '@/services/useCollection'
import { COL, closeSession, softDelete } from '@/services/repository'
import { where, limit as fbLimit } from 'firebase/firestore'
import { useAuth } from '@/store/AuthContext'
import { useApp } from '@/store/AppContext'
import { can } from '@/domain/rules'
import { cn, formatDate } from '@/lib/utils'
import type {
  InspectionSample,
  InspectionSession,
  Machine,
  ProductionOrder,
} from '@/domain/types'

const COLLAPSE_AFTER = 3

export function InspectionsPage() {
  const navigate = useNavigate()
  const { profile, role } = useAuth()
  const { toast } = useApp()

  // Only the open sessions — this screen exists to answer "what is open now",
  // and the closed ones would be thousands of documents nobody is looking at.
  const { rows: openSessions, loading } = useQueryRows<InspectionSession>(
    COL.sessions,
    [where('status', '==', 'Open'), fbLimit(200)],
    ['open-sessions'],
  )
  const { rows: machines } = useSmallCollection<Machine>(COL.machines)

  const sessionIds = useMemo(() => openSessions.map((s) => s.id), [openSessions])
  const orderIds = useMemo(() => openSessions.map((s) => s.orderId), [openSessions])

  // The orders behind the open sessions, fetched by id — a handful of reads
  // instead of the whole 28,871-row collection.
  const { rows: orders } = useDocsByIds<ProductionOrder>(COL.orders, orderIds)
  // Samples belonging to those sessions only.
  const { rows: samples } = useWhereIn<InspectionSample>(COL.samples, 'sessionId', sessionIds)

  // The Hold badge needs the number, not the defects. A count aggregation does
  // not return documents, so this stays cheap however many defects exist.
  const { count: holdCount } = useCount(
    COL.defects,
    [where('disposition', '==', 'Hold')],
    ['hold-count'],
  )

  const [newOpen, setNewOpen] = useState(false)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [closing, setClosing] = useState<InspectionSession | null>(null)
  const [deleting, setDeleting] = useState<InspectionSession | null>(null)

  const orderById = useMemo(() => new Map(orders.map((o) => [o.id, o])), [orders])
  const samplesBySession = useMemo(() => {
    const m = new Map<string, InspectionSample[]>()
    for (const s of samples) {
      const arr = m.get(s.sessionId) ?? []
      arr.push(s)
      m.set(s.sessionId, arr)
    }
    return m
  }, [samples])

  /** Group by work center / line, the way the inspector thinks about the floor. */
  const groups = useMemo(() => {
    const sorted = [...openSessions].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
    const byWc = new Map<string, { machine?: Machine; label: string; sessions: InspectionSession[]; sampleCount: number }>()
    for (const s of sorted) {
      const machine = machines.find((m) => m.code === s.workCenterCode)
      const label = machine?.displayName || machine?.name || `Work center ${s.workCenterCode}`
      const g = byWc.get(s.workCenterCode) ?? { machine, label, sessions: [], sampleCount: 0 }
      g.sessions.push(s)
      g.sampleCount += samplesBySession.get(s.id)?.length ?? 0
      byWc.set(s.workCenterCode, g)
    }
    return Array.from(byWc.values()).sort((a, b) => a.label.localeCompare(b.label))
  }, [openSessions, machines, samplesBySession])

  const auditCtx = (s: InspectionSession) => {
    const order = orderById.get(s.orderId)
    return {
      userUid: profile?.uid ?? 'unknown',
      userName: profile?.name ?? 'unknown',
      entity: 'InspectionSession',
      entityId: s.id,
      orderNumber: order?.orderNumber,
      item: order?.item,
      workCenterCode: s.workCenterCode,
      sessionId: s.id,
    }
  }

  return (
    <div className="space-y-5">
      {/* §4 — three primary actions */}
      <div className="grid grid-cols-3 gap-3">
        <QuickAction icon={<Plus className="h-6 w-6" />} title="New" subtitle="Inspection" onClick={() => setNewOpen(true)} />
        <QuickAction icon={<Search className="h-6 w-6" />} title="Coil" subtitle="Search" onClick={() => navigate('/coils')} />
        <QuickAction icon={<FileText className="h-6 w-6" />} title="PDI" subtitle="Documents" onClick={() => navigate('/pdi')} />
      </div>

      {holdCount > 0 && (
        <Card className="flex items-center gap-3 border-l-4 border-l-amber-400 p-4">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400">
            <AlertTriangle className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-bold">
              {holdCount} defect{holdCount === 1 ? '' : 's'} on Hold
            </p>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Open business items — they stay here until a disposition resolves them.
            </p>
          </div>
          <Button variant="secondary" onClick={() => navigate('/history?disposition=Hold')}>
            Review
          </Button>
        </Card>
      )}

      <div className="flex items-center gap-2">
        <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">Open sessions</h2>
        <Badge tone="blue">{openSessions.length}</Badge>
      </div>

      {loading ? (
        <Card className="p-10 text-center text-sm text-slate-400">Loading…</Card>
      ) : groups.length === 0 ? (
        <EmptyState
          icon={<ClipboardCheck className="h-10 w-10" />}
          title="Nothing is open right now"
          hint="Start a new inspection to begin recording samples."
          action={
            <Button variant="primary" onClick={() => setNewOpen(true)}>
              <Plus className="h-4 w-4" /> New Inspection
            </Button>
          }
        />
      ) : (
        <div className="space-y-4">
          {groups.map((g) => {
            const isExpanded = expanded[g.label]
            const visible = isExpanded ? g.sessions : g.sessions.slice(0, COLLAPSE_AFTER)
            const hidden = g.sessions.length - visible.length
            return (
              <Card key={g.label} className="overflow-hidden">
                <div className="flex items-center gap-3 border-b border-slate-100 px-4 py-3.5 dark:border-slate-800">
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-100 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300">
                    <Factory className="h-5 w-5" />
                  </span>
                  <h3 className="flex-1 text-lg font-extrabold leading-tight">{g.label}</h3>
                  <Badge tone="neutral">
                    {g.sampleCount} sample{g.sampleCount === 1 ? '' : 's'}
                  </Badge>
                </div>

                <div className="divide-y divide-slate-100 dark:divide-slate-800">
                  {visible.map((s) => {
                    const order = orderById.get(s.orderId)
                    const sessionSamples = samplesBySession.get(s.id) ?? []
                    return (
                      <div key={s.id} className="px-4 py-3.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-bold">{order?.orderNumber ?? '—'}</span>
                          <Badge tone="green">OPEN</Badge>
                          <Badge tone="neutral">
                            {sessionSamples.length} sample{sessionSamples.length === 1 ? '' : 's'}
                          </Badge>
                          {s.startQtyConfirmed && (
                            <Badge tone="blue" icon={<CheckCircle2 className="h-3 w-3" />}>
                              Qty {s.startQtyConfirmed.qty}
                            </Badge>
                          )}
                        </div>
                        <p className="mt-1 truncate text-sm font-medium text-brand-600 dark:text-brand-400">
                          {order?.item} · {order?.itemCode}
                        </p>
                        <p className="mt-0.5 text-xs text-slate-400">
                          {formatDate(s.startedAt)} · {s.inspectorName}
                        </p>

                        <div className="mt-3 flex items-center gap-2">
                          <Button variant="primary" className="min-h-[48px] flex-1" onClick={() => navigate(`/wizard/${s.id}`)}>
                            <Play className="h-4 w-4" /> Continue
                          </Button>
                          <Button
                            variant="secondary"
                            className="min-h-[48px]"
                            onClick={() => setClosing(s)}
                            aria-label="Close session"
                          >
                            <Lock className="h-4 w-4" />
                            <span className="hidden sm:inline">Close</span>
                          </Button>
                          {can(role, 'delete-session') && (
                            <button
                              onClick={() => setDeleting(s)}
                              className="grid h-12 w-12 shrink-0 place-items-center rounded-xl text-rose-500 ring-1 ring-rose-200 transition-colors hover:bg-rose-50 dark:ring-rose-500/30 dark:hover:bg-rose-500/10"
                              aria-label="Delete session"
                            >
                              <Trash2 className="h-5 w-5" />
                            </button>
                          )}
                        </div>

                        {sessionSamples.length > 0 && (
                          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
                            <span className="flex items-center gap-1 text-xs font-bold uppercase text-slate-400">
                              <Boxes className="h-3.5 w-3.5" /> Samples
                            </span>
                            {sessionSamples
                              .sort((a, b) => a.index - b.index)
                              .map((sm) => (
                                <span
                                  key={sm.id}
                                  className="rounded-lg bg-brand-50 px-2.5 py-1 text-xs font-semibold text-brand-700 ring-1 ring-brand-200 dark:bg-brand-500/10 dark:text-brand-300 dark:ring-brand-500/20"
                                >
                                  #{sm.index} · {sm.shift}
                                </span>
                              ))}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>

                {hidden > 0 && (
                  <button
                    onClick={() => setExpanded((e) => ({ ...e, [g.label]: true }))}
                    className="flex w-full items-center justify-center gap-1.5 border-t border-slate-100 py-3 text-sm font-semibold text-brand-600 hover:bg-slate-50 dark:border-slate-800 dark:text-brand-400 dark:hover:bg-slate-800/50"
                  >
                    <ChevronDown className="h-4 w-4" /> View {hidden} more
                  </button>
                )}
              </Card>
            )
          })}
        </div>
      )}

      <NewInspectionDialog open={newOpen} onClose={() => setNewOpen(false)} />

      {closing && (
        <CloseSessionDialog
          session={closing}
          onClose={() => setClosing(null)}
          onConfirm={async (qty) => {
            try {
              await closeSession(closing, qty, auditCtx(closing))
              toast('Session closed.', 'success')
            } catch (e) {
              toast(e instanceof Error ? e.message : 'Could not close the session.', 'error')
            }
            setClosing(null)
          }}
        />
      )}

      <Modal
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title="Delete this session?"
        icon={<Trash2 className="h-5 w-5" />}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                if (!deleting) return
                try {
                  await softDelete(COL.sessions, deleting.id, auditCtx(deleting))
                  toast('Session marked deleted. Nothing was erased.', 'success')
                } catch (e) {
                  toast(e instanceof Error ? e.message : 'Could not delete.', 'error')
                }
                setDeleting(null)
              }}
            >
              <Trash2 className="h-4 w-4" /> Delete
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-600 dark:text-slate-300">
          The session is marked as deleted and hidden from this list. Nothing is erased — the samples,
          measurements and photos stay in the record, and this deletion is written to the audit log.
        </p>
      </Modal>
    </div>
  )
}

function CloseSessionDialog({
  session,
  onClose,
  onConfirm,
}: {
  session: InspectionSession
  onClose: () => void
  onConfirm: (qty: number) => void
}) {
  const [qty, setQty] = useState(String(session.startQtyConfirmed?.qty ?? ''))
  const parsed = Number(qty)
  const valid = qty.trim() !== '' && !Number.isNaN(parsed) && parsed >= 0

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
        <Field label="Final produced quantity" hint="Recorded against this session and audited.">
          <Input
            autoFocus
            type="number"
            inputMode="numeric"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            className="min-h-[48px] text-lg"
          />
        </Field>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          A closed session becomes read-only for inspectors. A supervisor can still correct it, and any
          correction is audited.
        </p>
      </div>
    </Modal>
  )
}

function QuickAction({
  icon,
  title,
  subtitle,
  onClick,
}: {
  icon: ReactNodeLike
  title: string
  subtitle: string
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className="card flex min-h-[112px] flex-col items-center justify-center gap-2 p-4 transition-transform active:scale-[.97]"
    >
      <span className="grid h-14 w-14 place-items-center rounded-full bg-brand-600 text-white shadow-sm">{icon}</span>
      <div className="text-center leading-tight">
        <p className="font-bold">{title}</p>
        <p className="text-sm text-slate-500 dark:text-slate-400">{subtitle}</p>
      </div>
    </button>
  )
}

type ReactNodeLike = Parameters<typeof Badge>[0]['children']
