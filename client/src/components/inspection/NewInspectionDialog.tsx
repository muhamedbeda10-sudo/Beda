import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Search, Package, Play, ArrowLeft, CheckCircle2, Boxes, Factory, ChevronRight, Layers } from 'lucide-react'
import { Badge, Button, Field, Input, Modal, Select } from '@/components/ui'
import { useMaster, useOpenBoard, useOrderHistory, useOrderLines, useOrderNumbers } from '@/services/queries'
import { matchNotices } from '@/services/mutations'
import { NoticeGate } from '@/components/notices/NoticeGate'
import type { NoticeForUser } from '@qc/shared/types'
import { useApp } from '@/store/AppContext'
import { processForMachine, stockProductionOf } from '@qc/shared/rules'
import { remainingQty, type Machine, type ProductionOrder } from '@qc/shared/types'
import { When } from '@/components/ui/Tooltip'

/**
 * §4 — New Inspection.
 *
 * The inspector stands at a machine, so the machine comes first. It narrows
 * the order catalogue to the orders that have lines on that machine; the
 * chosen order then offers only its lines (items) on that machine. Picking a
 * line shows the order context and asks for the starting production quantity
 * before any session exists — that confirmation is the baseline every later
 * quantity is judged against.
 */
export function NewInspectionDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { toast } = useApp()

  const [machineCode, setMachineCode] = useState('')
  const [orderTerm, setOrderTerm] = useState('')
  const [orderNumber, setOrderNumber] = useState('')
  const [itemTerm, setItemTerm] = useState('')
  const [picked, setPicked] = useState<ProductionOrder | null>(null)
  /** §4 — most lines have nothing rejected before the release inspection, so
   *  zero is what the field starts at; the inspector types a number only when
   *  there is one to report. */
  const [startQty, setStartQty] = useState('0')
  /** On a make-to-stock machine: how many pieces (pairs) came out. */
  const [producedQty, setProducedQty] = useState('')
  const [busy, setBusy] = useState(false)
  /** Notices to read before the session starts (§16); `proceed` starts it once they are handled. */
  const [gate, setGate] = useState<{ notices: NoticeForUser[]; context: { workCenterCode: string; orderNumber?: string; itemCode?: string }; proceed: () => Promise<void> } | null>(null)

  const { data: machines = [] } = useMaster('machines', undefined, open)
  // Order numbers are searched on the server, restricted to the machine —
  // the catalogue is tens of thousands of lines and is never loaded whole.
  const { data: orders = [], isFetching: ordersLoading } = useOrderNumbers(machineCode, orderTerm, 40, open)
  const { data: lines = [], isFetching: linesLoading } = useOrderLines(machineCode, orderNumber, open)
  // Only the picked line's history is needed, never every session or sample.
  const { data: history } = useOrderHistory(picked?.id ?? null)
  // An open session on the line is joined, not doubled (§4.4).
  const { data: board } = useOpenBoard()

  const machine = useMemo(
    () => machines.find((m) => m.code.trim().toLowerCase() === machineCode.trim().toLowerCase()) ?? null,
    [machines, machineCode],
  )

  /** The fixed stock items of the machine, or null for one that works to order. */
  const production = stockProductionOf(machine?.code)

  /** Machines grouped by factory so a multi-site register stays readable. */
  const machineGroups = useMemo(() => {
    const groups = new Map<string, Machine[]>()
    for (const m of machines) {
      const g = m.factory?.trim() || ''
      const arr = groups.get(g) ?? []
      arr.push(m)
      groups.set(g, arr)
    }
    for (const arr of groups.values()) arr.sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }))
    return Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  }, [machines])

  /** The order's items on this machine, narrowed by what was typed. */
  const visibleLines = useMemo(() => {
    const t = itemTerm.trim().toLowerCase()
    if (!t) return lines
    return lines.filter((o) => [o.itemCode, o.item, o.lineKey].some((v) => v.toLowerCase().includes(t)))
  }, [lines, itemTerm])

  /** Samples already recorded against the picked line (§4). */
  const previousSamples = useMemo(
    () => [...(history?.samples ?? [])].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    [history],
  )

  function reset() {
    setPicked(null)
    setStartQty('0')
    setProducedQty('')
    setOrderTerm('')
    setOrderNumber('')
    setItemTerm('')
    setMachineCode('')
  }

  function chooseMachine(code: string) {
    setMachineCode(code)
    setOrderNumber('')
    setOrderTerm('')
    setItemTerm('')
    setProducedQty('')
  }

  /** A make-to-stock machine: no order to pick, only the quantity that came out. */
  async function startStock(afterGate = false) {
    if (!machine) return
    const qty = Number(producedQty)
    if (producedQty.trim() === '' || Number.isNaN(qty) || qty < 0) return
    setBusy(true)
    try {
      if (!afterGate) {
        const notices = await matchNotices({ workCenterCode: machine.code })
        if (notices.length > 0) {
          setGate({ notices, context: { workCenterCode: machine.code, orderNumber: 'STOCK', itemCode: production?.itemCode }, proceed: () => startStock(true) })
          return
        }
      }
      const open = board?.sessions.find((s) => s.status === 'Open' && s.order?.orderNumber === 'STOCK' && s.workCenterCode.trim().toLowerCase() === machine.code.trim().toLowerCase())
      reset()
      onClose()
      if (open) {
        toast(`Joining session #${open.seq} on ${machine.displayName}; your samples are recorded under your name.`, 'info')
        navigate(`/wizard/${open.id}`)
      } else {
        // The session itself is opened when the first sample is saved (§4.4).
        navigate(`/wizard/new?${new URLSearchParams({ workCenterCode: machine.code, producedQty: String(qty) })}`)
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not start the session.', 'error')
    } finally {
      setBusy(false)
    }
  }

  async function start(afterGate = false) {
    if (!picked) return
    const qty = rejectedBeforeRelease
    if (qty === null) return
    setBusy(true)
    try {
      if (!afterGate) {
        const notices = await matchNotices({ workCenterCode: picked.workCenterCode, orderId: picked.id })
        if (notices.length > 0) {
          setGate({ notices, context: { workCenterCode: picked.workCenterCode, orderNumber: picked.orderNumber, itemCode: picked.itemCode }, proceed: () => start(true) })
          return
        }
      }
      const open = openOnLine
      reset()
      onClose()
      if (open) {
        toast(`Joining session #${open.seq} opened by ${open.inspectorName}; your samples are recorded under your name.`, 'info')
        navigate(`/wizard/${open.id}`)
      } else {
        // The session itself is opened when the first sample is saved (§4.4).
        navigate(`/wizard/new?${new URLSearchParams({ orderId: picked.id, startQty: String(qty) })}`)
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not start the session.', 'error')
    } finally {
      setBusy(false)
    }
  }

  /** The gate sits above whichever step is open; it is a portal, so it renders anywhere. */
  const gateEl = gate ? (
    <NoticeGate
      notices={gate.notices}
      context={gate.context}
      onDone={() => {
        const proceed = gate.proceed
        setGate(null)
        void proceed()
      }}
      onCancel={() => {
        setGate(null)
        setBusy(false)
      }}
    />
  ) : null

  /** What the field says, with an emptied field read as none rejected; null when it is not a number. */
  const rejectedBeforeRelease = (() => {
    if (startQty.trim() === '') return 0
    const n = Number(startQty)
    return Number.isNaN(n) || n < 0 ? null : n
  })()

  /** The session already open on the picked line, if any: the inspector joins it. */
  const openOnLine = (history?.sessions ?? []).find((s) => s.status === 'Open') ?? board?.sessions.find((s) => s.status === 'Open' && s.orderId === picked?.id) ?? null

  // ---- Step 4: confirm the line and the starting quantity ------------------
  if (picked) {
    const remaining = remainingQty(picked)
    // Joining an open session asks nothing more: its starting quantity was confirmed when it opened.
    const valid = openOnLine !== null || rejectedBeforeRelease !== null

    return (
      <Modal
        open={open}
        onClose={() => setPicked(null)}
        title="Confirm and start"
        icon={<Factory className="h-5 w-5" />}
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPicked(null)}>
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
            <Button variant="primary" disabled={!valid || busy} onClick={() => start()} className="min-h-[48px]">
              <Play className="h-4 w-4" /> {busy ? 'Opening…' : openOnLine ? `Join session #${openOnLine.seq}` : 'Start inspection'}
            </Button>
          </>
        }
      >
        {gateEl}
        <div className="space-y-4">
          <div className="rounded-2xl bg-slate-50 p-4 dark:bg-slate-800/50">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-lg font-bold">{picked.orderNumber}</p>
              <Badge tone="neutral">Order ID {picked.lineKey}</Badge>
              {statusBadge(picked.erpStatus)}
              {processForMachine(machine, picked.workCenterCode) === 'paint' && <Badge tone="violet">Paint flow</Badge>}
              {processForMachine(machine, picked.workCenterCode) === 'welding' && <Badge tone="amber">Welding flow · VT + PT</Badge>}
            </div>
            <p className="text-sm text-brand-600 dark:text-brand-400">
              {picked.item} · {picked.itemCode}
            </p>

            <div className="mt-3 grid grid-cols-3 gap-2 text-center">
              <Metric label="Required" value={picked.requiredQty} />
              <Metric label="Finished" value={picked.finishedQty} tone="green" />
              <Metric label="Remaining" value={remaining} tone="blue" />
            </div>

            <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
              <Detail label="Machine" value={machine?.displayName ?? picked.workCenterCode} />
              <Detail label="Drawing" value={picked.drawing} />
              <Detail label="Material" value={picked.material} />
              <Detail label="Grade" value={picked.expectedGrade} />
              <Detail label="Customer" value={picked.customer} />
              <Detail label="Type" value={picked.type} />
              <Detail label="Colour" value={picked.colour} />
            </dl>
          </div>

          {openOnLine && (
            <div className="rounded-2xl border-l-4 border-l-brand-500 bg-brand-50/60 p-3 text-sm text-brand-900 dark:bg-brand-500/10 dark:text-brand-100">
              <p className="font-bold">Session #{openOnLine.seq} is open on this line</p>
              <p>
                Opened by {openOnLine.inspectorName} · {openOnLine.sampleCount ?? 0} sample{(openOnLine.sampleCount ?? 0) === 1 ? '' : 's'} so far. Your samples are added to it under your name; nobody opens a second session on the same line.
              </p>
            </div>
          )}
          {!openOnLine && (
          <Field label="Rejected qty before release" hint="Pieces already rejected on this line before the release inspection. Leave it at zero when there are none; the session is opened when the first sample is saved.">
            <Input
              autoFocus
              type="number"
              inputMode="numeric"
              min={0}
              value={startQty}
              // Typing over the zero reads as the number meant, not "012".
              onChange={(e) => setStartQty(e.target.value.replace(/^0+(?=\d)/, ''))}
              onFocus={(e) => e.target.select()}
              placeholder="0"
              className="min-h-[48px] text-lg"
            />
          </Field>
          )}

          <div>
            <p className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase text-muted">
              <Boxes className="h-3.5 w-3.5" /> Previous samples on this item
            </p>
            {previousSamples.length === 0 ? (
              <p className="rounded-xl border border-dashed border-slate-200 py-3 text-center text-sm text-muted dark:border-slate-700">
                No samples recorded yet.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {previousSamples.slice(0, 12).map((s) => (
                  <span key={s.id} className="rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                    #{s.index} · shift {s.shift} · <When iso={s.createdAt} />
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-start gap-2 rounded-xl bg-brand-50 px-3 py-2.5 text-sm text-brand-700 dark:bg-brand-500/10 dark:text-brand-300">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            {openOnLine ? 'Every sample is recorded under the name of whoever took it.' : 'Who confirmed this quantity, and when, is recorded with the session, which is opened by your first sample.'}
          </div>
        </div>
      </Modal>
    )
  }

  // ---- Steps 1–3: machine → order → item; a stock machine has only step 1 ---
  const stock = production !== null
  const stage: 'machine' | 'order' | 'item' | 'stock' = !machineCode ? 'machine' : stock ? 'stock' : !orderNumber ? 'order' : 'item'
  const producedValid = producedQty.trim() !== '' && !Number.isNaN(Number(producedQty)) && Number(producedQty) >= 0

  return (
    <Modal
      open={open}
      onClose={() => {
        reset()
        onClose()
      }}
      title="New inspection"
      icon={<Package className="h-5 w-5" />}
      size="lg"
      footer={
        stage === 'stock' ? (
          <Button variant="primary" disabled={!producedValid || busy} onClick={() => startStock()} className="min-h-[48px]">
            <Play className="h-4 w-4" /> {busy ? 'Starting…' : 'Start inspection'}
          </Button>
        ) : undefined
      }
    >
      {gateEl}
      <div className="space-y-3">
        <ol className="flex flex-wrap items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-muted">
          <Crumb n={1} label="Machine" active={stage === 'machine'} done={stage !== 'machine'} />
          <ChevronRight className="h-3.5 w-3.5" />
          {stage === 'stock' ? (
            <Crumb n={2} label="Quantity produced" active done={false} />
          ) : (
            <>
              <Crumb n={2} label="Order" active={stage === 'order'} done={stage === 'item'} />
              <ChevronRight className="h-3.5 w-3.5" />
              <Crumb n={3} label="Item" active={stage === 'item'} done={false} />
            </>
          )}
        </ol>

        <Field label="Machine">
          <Select value={machineCode} onChange={(e) => chooseMachine(e.target.value)} className="min-h-[48px]" autoFocus>
            <option value="">— choose the machine you are at —</option>
            {machineGroups.map(([factory, group]) =>
              factory ? (
                <optgroup key={factory} label={factory}>
                  {group.map((m) => (
                    <option key={m.id} value={m.code}>
                      {m.displayName}
                    </option>
                  ))}
                </optgroup>
              ) : (
                group.map((m) => (
                  <option key={m.id} value={m.code}>
                    {m.displayName}
                  </option>
                ))
              ),
            )}
          </Select>
        </Field>
        {machines.length === 0 && (
          <p className="rounded-xl border border-dashed border-slate-200 py-3 text-center text-sm text-muted dark:border-slate-700">
            No machines are registered yet. Load the machine sheet in Admin → Bulk import.
          </p>
        )}

        {stage === 'stock' && machine && production && (
          <div className="space-y-4">
            {/* No order on this machine: it makes its fixed items for stock. */}
            <div className="rounded-2xl bg-slate-50 p-4 dark:bg-slate-800/50">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-lg font-bold">{production.item}</p>
                <Badge tone="violet">For stock · no order</Badge>
              </div>
              <p className="text-sm text-brand-600 dark:text-brand-400">
                {machine.displayName} · <span className="font-mono">{production.itemCode}</span>
              </p>
              <ul className="mt-2 flex flex-wrap gap-2">
                {production.pieces.map((piece) => (
                  <li key={piece} className="rounded-lg bg-white px-2.5 py-1 text-xs font-semibold text-slate-600 ring-1 ring-slate-200 dark:bg-slate-900 dark:text-slate-300 dark:ring-slate-700">
                    {piece}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-sm text-muted">
                Made together, so one quantity covers both. The inspection then runs as usual: setup with the coils, samples, dimensions and defects.
              </p>
            </div>
            <Field label="Quantity produced (pairs)" hint="How many came out of the press for this session — right = left, entered once. Confirmed again when the session is closed.">
              <Input
                autoFocus
                type="number"
                inputMode="numeric"
                min={0}
                value={producedQty}
                onChange={(e) => setProducedQty(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && producedValid && !busy) void startStock()
                }}
                placeholder="e.g. 120"
                className="min-h-[48px] text-lg"
              />
            </Field>
            {producedValid && Number(producedQty) > 0 && (
              <p className="text-sm text-muted">
                = <b className="tabular-nums">{Number(producedQty)}</b> right + <b className="tabular-nums">{Number(producedQty)}</b> left
              </p>
            )}
          </div>
        )}

        {stage === 'order' && (
          <>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
              <Input
                autoFocus
                value={orderTerm}
                onChange={(e) => setOrderTerm(e.target.value)}
                placeholder="Order number…"
                className="min-h-[48px] pl-9"
              />
            </div>
            <div className="max-h-[42vh] space-y-2 overflow-y-auto pr-1">
              {orders.length === 0 && (
                <p className="py-8 text-center text-sm text-muted">
                  {ordersLoading ? 'Searching…' : orderTerm ? 'No orders on this machine match that number.' : 'No orders have lines on this machine.'}
                </p>
              )}
              {orders.map((o) => (
                <button
                  key={o.orderNumber}
                  onClick={() => setOrderNumber(o.orderNumber)}
                  className="flex w-full items-center gap-3 rounded-2xl border border-slate-200 p-3 text-left transition-colors hover:border-brand-400 hover:bg-brand-50/50 dark:border-slate-800 dark:hover:border-brand-500/50 dark:hover:bg-brand-500/5"
                >
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-100 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300">
                    <Layers className="h-5 w-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-bold">{o.orderNumber}</p>
                    <p className="truncate text-sm text-muted">{o.customer || '—'}</p>
                  </div>
                  <Badge tone="neutral">
                    {o.lineCount} {o.lineCount === 1 ? 'item' : 'items'}
                  </Badge>
                </button>
              ))}
            </div>
          </>
        )}

        {stage === 'item' && (
          <>
            <div className="flex items-center justify-between gap-2 rounded-xl bg-slate-50 px-3 py-2 dark:bg-slate-800/50">
              <p className="text-sm">
                <span className="text-muted">Order</span> <span className="font-bold">{orderNumber}</span>
              </p>
              <Button
                variant="ghost"
                className="min-h-[40px] shrink-0 whitespace-nowrap"
                onClick={() => {
                  setOrderNumber('')
                  setItemTerm('')
                }}
              >
                <ArrowLeft className="h-4 w-4" /> Change order
              </Button>
            </div>
            {lines.length > 8 && (
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                <Input
                  autoFocus
                  value={itemTerm}
                  onChange={(e) => setItemTerm(e.target.value)}
                  placeholder={`Filter ${lines.length} items by code, name or Order ID…`}
                  className="min-h-[48px] pl-9"
                />
              </div>
            )}
            <div className="max-h-[42vh] space-y-2 overflow-y-auto pr-1">
              {visibleLines.length === 0 && (
                <p className="py-8 text-center text-sm text-muted">
                  {linesLoading ? 'Loading…' : itemTerm ? 'No item on this machine matches that.' : 'This order has no items on this machine.'}
                </p>
              )}
              {visibleLines.map((o) => (
                <button
                  key={o.id}
                  onClick={() => {
                    setPicked(o)
                    // Rejected before release starts at zero: the line's remaining quantity is production, not rejects.
                    setStartQty('0')
                  }}
                  className="flex w-full items-center gap-3 rounded-2xl border border-slate-200 p-3 text-left transition-colors hover:border-brand-400 hover:bg-brand-50/50 dark:border-slate-800 dark:hover:border-brand-500/50 dark:hover:bg-brand-500/5"
                >
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-100 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300">
                    <Package className="h-5 w-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 font-bold">
                      {o.itemCode || <span className="text-muted">no item code</span>}
                      {statusBadge(o.erpStatus)}
                    </p>
                    <p className="truncate text-sm text-muted">
                      {o.item || '—'} · Order ID {o.lineKey}
                      {o.expectedGrade ? ` · ${o.expectedGrade}` : ''}
                    </p>
                  </div>
                  <span className="text-right text-xs tabular-nums text-muted">
                    <span className="block font-bold text-brand-600 dark:text-brand-400">{remainingQty(o)}</span>
                    remaining
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}

/** Hold and Stock lines are still inspectable but worth noticing; Active needs no badge. */
function statusBadge(status: string) {
  const s = status.trim().toLowerCase()
  if (!s || s === 'active') return null
  return <Badge tone={s === 'hold' ? 'amber' : 'neutral'}>{status}</Badge>
}

function Crumb({ n, label, active, done }: { n: number; label: string; active: boolean; done: boolean }) {
  return (
    <li
      className={
        active
          ? 'flex items-center gap-1.5 text-brand-600 dark:text-brand-400'
          : done
            ? 'flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400'
            : 'flex items-center gap-1.5'
      }
    >
      <span className="grid h-5 w-5 place-items-center rounded-full bg-current/10 text-[11px]">{done ? '✓' : n}</span>
      {label}
    </li>
  )
}

function Metric({ label, value, tone }: { label: string; value: number; tone?: 'green' | 'blue' }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase text-muted">{label}</p>
      <p className={tone === 'green' ? 'text-xl font-bold tabular-nums text-emerald-500' : tone === 'blue' ? 'text-xl font-bold tabular-nums text-brand-500' : 'text-xl font-bold tabular-nums'}>
        {value}
      </p>
    </div>
  )
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase text-muted">{label}</dt>
      <dd className="truncate font-semibold text-slate-800 dark:text-slate-100">{value || '—'}</dd>
    </div>
  )
}
