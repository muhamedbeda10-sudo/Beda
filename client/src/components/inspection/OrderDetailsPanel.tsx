// ============================================================================
// Everything about an order, from the session card on the board: the line as
// the ERP export carried it, its quantities, this session, the inspection
// history on the line and the notes written about it. Only THIS line — the same
// order carries other items on other machines, and those are their own business.
// it. Read in full while the board stays behind it.
// ============================================================================

import { useEffect, useState, type ReactNode } from 'react'
import {
  Pencil,
  Boxes,
  Calendar,
  ClipboardList,
  FileText,
  Factory,
  Layers,
  Lock,
  MessageSquareText,
  Package2,
  Palette,
  Play,
  ShieldCheck,
  Tag,
  User,
  ChevronDown,
  ChevronUp,
  Camera,
} from 'lucide-react'
import { Badge, Button, Drawer, type BadgeTone } from '@/components/ui'
import { PtCoverageBadge, SessionToneBadge, sampleChipClass, sampleChipTitle } from '@/components/inspection/SessionTone'
import { OrderNoteList } from '@/components/inspection/OrderNotes'
import { SessionPhotos } from '@/components/inspection/SessionPhotos'
import { useOrder, useOrderHistory, useOrderNotes } from '@/services/queries'
import { cn, formatDate, formatDateTime } from '@/lib/utils'
import { remainingQty, type Machine, type ProductionOrder } from '@qc/shared/types'
import { isStockOrder, processForMachine } from '@qc/shared/rules'
import type { SampleSummary, SessionWithOrder } from '@qc/shared/api'
import { When } from '@/components/ui/Tooltip'

export function OrderDetailsPanel({
  session,
  samples,
  machines,
  canRecord,
  onClose,
  onContinue,
  onCloseSession,
  onOpenSample,
  onCorrectQuantities,
}: {
  session: SessionWithOrder | null
  samples: SampleSummary[]
  machines: Machine[]
  canRecord: boolean
  onClose: () => void
  onContinue: (session: SessionWithOrder) => void
  onCloseSession: (session: SessionWithOrder) => void
  onOpenSample: (session: SessionWithOrder, sample: SampleSummary) => void
  /** Offered when this person may correct the session's quantities (§4). */
  onCorrectQuantities?: (session: SessionWithOrder) => void
}) {
  const orderId = session?.orderId ?? null
  const { data: order } = useOrder(orderId)
  const { data: history } = useOrderHistory(orderId)
  /** Earlier sessions on the line whose samples are shown. */
  const [openSessions, setOpenSessions] = useState<Set<string>>(() => new Set())
  const { data: notes = [], isLoading: notesLoading } = useOrderNotes(orderId)
  const machineLabel = (code: string) => machines.find((m) => m.code === code)?.displayName ?? `Machine ${code}`
  const stock = isStockOrder(session?.order)

  return (
    <Drawer
      open={session !== null}
      onClose={onClose}
      icon={<Package2 className="h-5 w-5" />}
      title={stock ? (session?.order?.item ?? 'Stock item') : (session?.order?.orderNumber ?? 'Order')}
      subtitle={
        // The item, then its code under it: two lines, never a dot left alone at the end of a wrapped name.
        session && (
          <span className="block">
            <span dir="auto" className="block break-words text-start font-semibold text-slate-700 dark:text-slate-200">
              {session.order?.item ?? '—'}
            </span>
            <span className="block break-all font-mono text-xs">{session.order?.itemCode ?? '—'}</span>
          </span>
        )
      }
      footer={
        session && (
          <>
            {/* Closing the session first, continuing (the one most often wanted) last, under the thumb. The dismissing
                Close sits apart at the left from a small tablet up; on a phone, where the sheet's X and the dim area
                around it already close it, it is left out while there is anything else to do, so "Close session…"
                never stands beside a plain "Close". On a phone both labels fit half the width on one line. */}
            {session.status === 'Open' && canRecord && (
              <Button className="min-h-[48px] max-sm:px-3" onClick={() => onCloseSession(session)}>
                <Lock className="h-4 w-4" /> Close session…
              </Button>
            )}
            {session.status === 'Open' && canRecord && (
              <Button variant="primary" className="min-h-[48px] max-sm:px-3" onClick={() => onContinue(session)}>
                <Play className="h-4 w-4" />{' '}
                <span>
                  Continue<span className="max-sm:hidden"> inspection</span>
                </span>
              </Button>
            )}
            <Button className={cn('min-h-[48px] sm:order-first sm:mr-auto', session.status === 'Open' && canRecord && 'max-sm:hidden')} onClick={onClose}>
              Close
            </Button>
          </>
        )
      }
    >
      {session && (
        <div className="space-y-5">
          {/* Badges: the state of the line and of this session, at a glance. */}
          <Reveal index={0} className="flex flex-wrap items-center gap-2">
            <Badge tone="blue" icon={<Factory className="h-3 w-3" />}>
              {machineLabel(session.workCenterCode)}
            </Badge>
            {session.status === 'Open' ? (
              <Badge tone="green">Session #{session.seq} · OPEN</Badge>
            ) : (
              <Badge tone="neutral" icon={<Lock className="h-3 w-3" />}>
                Session #{session.seq} · CLOSED
              </Badge>
            )}
            <SessionToneBadge session={session} />
            {stock ? <Badge tone="violet">For stock · no order</Badge> : order && erpBadge(order.erpStatus)}
          </Reveal>

          {/* Quantities — the numbers a planner asks about first. A stock line has none. */}
          {!stock && <Reveal index={1}>{order ? <Quantities order={order} /> : <Skeleton rows={2} />}</Reveal>}

          {!stock && (
          <Reveal index={2}>
            <Section icon={<FileText className="h-4 w-4" />} title="Order line">
              {order ? (
                <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
                  <Attr icon={<Tag className="h-3.5 w-3.5" />} label="Order ID" value={order.lineKey} mono />
                  <Attr icon={<User className="h-3.5 w-3.5" />} label="Customer" value={order.customer} />
                  <Attr icon={<Calendar className="h-3.5 w-3.5" />} label="Order date" value={order.date ? formatDate(order.date) : ''} />
                  <Attr icon={<Layers className="h-3.5 w-3.5" />} label="Type" value={order.type} />
                  <Attr icon={<Palette className="h-3.5 w-3.5" />} label="Colour" value={order.colour} />
                  <Attr icon={<ShieldCheck className="h-3.5 w-3.5" />} label="Material" value={order.material} />
                  <Attr label="Expected grade" value={order.expectedGrade} />
                  <Attr label="Drawing" value={order.drawing} mono />
                  <Attr label="Alt. drawing" value={order.drawingAlt} mono />
                  <Attr label="ERP status" value={order.erpStatus} />
                  <Attr label="Machine" value={machineLabel(order.workCenterCode)} />
                </dl>
              ) : (
                <Skeleton rows={4} />
              )}
            </Section>
          </Reveal>
          )}

          <Reveal index={3}>
            <Section icon={<ClipboardList className="h-4 w-4" />} title="This session">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
                <Attr label="Inspector" value={session.inspectorName} />
                <Attr label="Started" value={formatDateTime(session.startedAt)} />
                <Attr label="Status" value={session.status} />
                {stock ? (
                  <Attr label="Quantity produced (pairs)" value={session.producedQty !== undefined ? String(session.producedQty) : ''} />
                ) : (
                  <Attr label="Rejected before release" value={session.startQtyConfirmed ? String(session.startQtyConfirmed.qty) : ''} />
                )}
                <Attr label="Final qty" value={session.finalQty !== undefined ? String(session.finalQty) : ''} />
                <Attr label="Closed" value={session.closedAt ? formatDateTime(session.closedAt) : ''} />
                <Attr label="Closed by" value={session.closedByName ?? (session.closedAt ? 'Unknown' : '')} />
                {processForMachine(machines.find((m) => m.code === session.workCenterCode) ?? null, session.workCenterCode) === 'welding' && (
                  <div>
                    <dt className="text-xs font-semibold uppercase text-muted">PT coverage (5% of final qty)</dt>
                    <dd className="mt-0.5">
                      <PtCoverageBadge session={session} finalQty={session.status === 'Closed' ? session.finalQty : null} />
                    </dd>
                  </div>
                )}
              </dl>
              {onCorrectQuantities && (
                <button
                  type="button"
                  onClick={() => onCorrectQuantities(session)}
                  className="mt-2 inline-flex min-h-[40px] items-center gap-1.5 text-sm font-semibold text-brand-700 hover:underline dark:text-brand-300"
                >
                  <Pencil className="h-4 w-4" /> Correct quantities
                </button>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <Chip tone="blue" label="Samples" value={samples.length} />
                <Chip tone={(session.defectCount ?? 0) > 0 ? 'red' : 'neutral'} label="Defects" value={session.defectCount ?? 0} />
                <Chip tone={(session.holdCount ?? 0) > 0 ? 'amber' : 'neutral'} label="On Hold" value={session.holdCount ?? 0} />
                <Chip tone="neutral" label="Notes" value={session.noteCount ?? 0} />
              </div>
              {samples.length > 0 && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <span className="flex items-center gap-1 text-xs font-bold uppercase text-muted">
                    <Boxes className="h-3.5 w-3.5" /> Open a sample
                  </span>
                  {[...samples]
                    .sort((a, b) => a.index - b.index)
                    .map((sm) => (
                      // The chip wears the sample's signal: amber on Hold, red with defects, blue when clean.
                      <button
                        key={sm.id}
                        type="button"
                        onClick={() => onOpenSample(session, sm)}
                        className={cn('min-h-[36px] rounded-lg px-2.5 py-1 text-xs font-semibold transition-colors touch:min-h-[44px] touch:min-w-[44px]', sampleChipClass(sm))}
                        data-tip={sampleChipTitle(sm) || undefined}
                        aria-label={`Open sample ${session.seq}-${sm.index}${sampleChipTitle(sm) ? `, ${sampleChipTitle(sm)}` : ''}`}
                      >
                        {session.seq}-{sm.index}
                      </button>
                    ))}
                </div>
              )}
            </Section>
          </Reveal>

          <Reveal index={4}>
            <Section icon={<ClipboardList className="h-4 w-4" />} title="Inspections on this line" count={history?.sessions.length}>
              {!history ? (
                <Skeleton rows={2} />
              ) : history.sessions.length === 0 ? (
                <Empty>No session has been recorded on this line yet.</Empty>
              ) : (
                <ul className="space-y-1.5">
                  {history.sessions.map((s) => {
                    const current = s.id === session.id
                    const expanded = current || openSessions.has(s.id)
                    const theirs = history.samples.filter((sm) => sm.sessionId === s.id).sort((a, b) => a.index - b.index)
                    return (
                      <li
                        key={s.id}
                        className={cn(
                          'rounded-xl px-3 py-2 text-sm ring-1',
                          current ? 'bg-brand-50 ring-brand-200 dark:bg-brand-500/10 dark:ring-brand-500/30' : 'bg-slate-50 ring-slate-200/70 dark:bg-slate-800/50 dark:ring-slate-700',
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => !current && setOpenSessions((prev) => { const next = new Set(prev); if (next.has(s.id)) next.delete(s.id); else next.add(s.id); return next })}
                          className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-left touch:min-h-[44px]"
                          aria-expanded={expanded}
                        >
                          <span className="font-bold tabular-nums">#{s.seq}</span>
                          <span className="text-slate-600 dark:text-slate-300">{s.inspectorName}</span>
                          <span className="text-xs text-muted"><When iso={s.startedAt} time /></span>
                          <span className="ml-auto flex items-center gap-1.5">
                            {current && <Badge tone="blue">this one</Badge>}
                            <Badge tone={s.status === 'Open' ? 'green' : 'neutral'}>{s.status}</Badge>
                            <Badge tone="neutral">{s.sampleCount ?? 0} samples</Badge>
                            {(s.defectCount ?? 0) > 0 && <Badge tone="red">{s.defectCount} defects</Badge>}
                            {(s.holdCount ?? 0) > 0 && <Badge tone="amber">{s.holdCount} on Hold</Badge>}
                            {!current && (expanded ? <ChevronUp className="h-4 w-4 text-muted" /> : <ChevronDown className="h-4 w-4 text-muted" />)}
                          </span>
                        </button>
                        {/* Any earlier session opens its samples here, read-only: the line's whole record is one tap away. */}
                        {expanded && !current && (
                          <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-slate-200/70 pt-2 dark:border-slate-700">
                            {theirs.length === 0 ? (
                              <span className="text-xs text-muted">No sample in this session.</span>
                            ) : (
                              theirs.map((sm) => (
                                <button
                                  key={sm.id}
                                  type="button"
                                  onClick={() => onOpenSample({ ...s, order: session.order }, sm)}
                                  className={cn('min-h-[36px] rounded-lg px-2.5 py-1 text-xs font-semibold transition-colors touch:min-h-[44px]', sampleChipClass(sm, true))}
                                  data-tip={sampleChipTitle(sm) || undefined}
                                >
                                  {s.seq}-{sm.index}
                                  <span className="ml-1 font-normal text-muted">{sm.inspectorName.split(' ')[0]}</span>
                                </button>
                              ))
                            )}
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </Section>
          </Reveal>

          <Reveal index={5}>
            <Section icon={<Camera className="h-4 w-4" />} title="Photos of this session">
              <SessionPhotos sessionId={session.id} sessionSeq={session.seq} onOpenSample={(id) => { const sm = samples.find((x) => x.id === id); if (sm) onOpenSample(session, sm) }} />
            </Section>
          </Reveal>

          <Reveal index={6}>
            <Section icon={<MessageSquareText className="h-4 w-4" />} title="Notes on this line" count={notes.length}>
              {notesLoading ? <Skeleton rows={2} /> : <OrderNoteList notes={notes} emptyMessage="No notes on this item on this machine yet." machineLabel={machineLabel} />}
            </Section>
          </Reveal>
        </div>
      )}
    </Drawer>
  )
}

// ---- Pieces ----------------------------------------------------------------

/** Sections arrive one after another, so the panel reads top to bottom as it opens. */
function Reveal({ index, className, children }: { index: number; className?: string; children: ReactNode }) {
  return (
    <div className={cn('animate-page-in', className)} style={{ animationDelay: `${80 + index * 55}ms`, animationFillMode: 'both' }}>
      {children}
    </div>
  )
}

function Quantities({ order }: { order: ProductionOrder }) {
  const remaining = remainingQty(order)
  const pct = order.requiredQty > 0 ? Math.min(100, Math.round((order.finishedQty / order.requiredQty) * 100)) : 0
  // The bar fills after the panel has landed, so the eye is drawn to it.
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    const t = window.setTimeout(() => setArmed(true), 120)
    return () => window.clearTimeout(t)
  }, [])
  return (
    <div className="rounded-2xl bg-gradient-to-br from-brand-600 to-brand-800 p-4 text-white shadow-glow">
      <div className="grid grid-cols-3 gap-3">
        <Metric label="Required" value={order.requiredQty} />
        <Metric label="Finished" value={order.finishedQty} />
        <Metric label="Remaining" value={remaining} accent />
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/20">
        <div
          className={cn('h-full origin-left rounded-full bg-white transition-[width] duration-700 ease-out', armed && 'animate-grow-x')}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="mt-1.5 text-xs font-semibold text-white/80">{pct}% of the required quantity finished in the ERP</p>
    </div>
  )
}

function Metric({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-white/70">{label}</p>
      <p className={cn('mt-0.5 text-2xl font-extrabold tabular-nums', accent && 'text-amber-200')}>{value}</p>
    </div>
  )
}

function Section({ icon, title, count, children }: { icon: ReactNode; title: string; count?: number; children: ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <span className="text-muted">{icon}</span>
        <h3 className="text-sm font-bold uppercase tracking-wide text-muted">{title}</h3>
        {count !== undefined && count > 0 && <Badge tone="neutral">{count}</Badge>}
      </div>
      {children}
    </section>
  )
}

/** One attribute of the line, in full: a long customer or machine name wraps rather than hiding its end (a finger gets no tooltip). */
function Attr({ icon, label, value, mono }: { icon?: ReactNode; label: string; value?: string | null; mono?: boolean }) {
  const empty = value === undefined || value === null || value.trim() === ''
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
        {icon}
        {label}
      </dt>
      <dd dir="auto" className={cn('break-words text-start font-semibold', mono && 'font-mono text-sm', empty && 'text-muted')}>
        {empty ? '—' : value}
      </dd>
    </div>
  )
}

function Chip({ tone, label, value }: { tone: BadgeTone; label: string; value: number }) {
  const bg: Record<BadgeTone, string> = {
    neutral: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
    green: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400',
    blue: 'bg-brand-100 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300',
    amber: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400',
    red: 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-400',
    violet: 'bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300',
  }
  return (
    <span className={cn('inline-flex items-baseline gap-1.5 rounded-xl px-3 py-1.5', bg[tone])}>
      <span className="text-lg font-extrabold tabular-nums">{value}</span>
      <span className="text-xs font-semibold uppercase tracking-wide">{label}</span>
    </span>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-xl border border-dashed border-slate-200 px-4 py-3 text-sm text-muted dark:border-slate-700">{children}</p>
}

function Skeleton({ rows }: { rows: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton h-5" style={{ width: `${88 - i * 14}%` }} />
      ))}
    </div>
  )
}

function erpBadge(status: string) {
  const s = status.trim().toLowerCase()
  if (!s || s === 'active') return null
  return <Badge tone={s === 'hold' ? 'amber' : s === 'cancel' ? 'red' : 'neutral'}>ERP: {status}</Badge>
}
