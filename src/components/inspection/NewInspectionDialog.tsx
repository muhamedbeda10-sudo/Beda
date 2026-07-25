import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { doc, setDoc } from 'firebase/firestore'
import { Search, Package, Play, ArrowLeft, CheckCircle2, Boxes, Factory } from 'lucide-react'
import { Badge, Button, Field, Input, Modal, Select } from '@/components/ui'
import { usePrefixSearch, useSmallCollection, useWhere } from '@/services/useCollection'
import { COL, stripUndefined } from '@/services/repository'
import { getDb } from '@/lib/firebase'
import { useAuth } from '@/store/AuthContext'
import { useApp } from '@/store/AppContext'
import { uid } from '@/lib/utils'
import { isPaintWorkCenter, isPTWorkCenter } from '@/domain/rules'
import type { InspectionSample, InspectionSession, Machine, ProductionOrder } from '@/domain/types'

/**
 * §4 — New Inspection.
 * Cascading filters narrow to one order; the inspector then confirms the order
 * context and the starting production quantity before any session exists. That
 * confirmation is the baseline every later quantity is judged against.
 */
export function NewInspectionDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate()
  const { profile } = useAuth()
  const { toast } = useApp()

  const [orderTerm, setOrderTerm] = useState('')
  const [itemFilter, setItemFilter] = useState('')
  const [wcFilter, setWcFilter] = useState('')
  const [picked, setPicked] = useState<ProductionOrder | null>(null)
  const [startQty, setStartQty] = useState('')
  const [busy, setBusy] = useState(false)

  // The order catalogue is ~29,000 rows, so it is searched on the server rather
  // than loaded. Inspectors type either an order number or an item code, so
  // both are matched as prefixes; the item-code query only runs once something
  // has been typed, because with an empty term it would repeat the first list.
  const term = orderTerm.trim()
  const { rows: byOrderNumber } = usePrefixSearch<ProductionOrder>(COL.orders, 'orderNumber', term, 40)
  const { rows: byItemCode } = usePrefixSearch<ProductionOrder>(COL.orders, 'itemCode', term, 40, {
    enabled: term.length > 0,
  })

  const { rows: machines } = useSmallCollection<Machine>(COL.machines)
  // Only the picked order's history is needed, never every session or sample.
  const { rows: sessions } = useWhere<InspectionSession>(COL.sessions, 'orderId', picked?.id)
  const { rows: samples } = useWhere<InspectionSample>(COL.samples, 'orderId', picked?.id)

  /** Work centres come from the machine register, which is master data. */
  const wcOptions = useMemo(
    () => Array.from(new Set(machines.map((m) => m.code))).sort((a, b) => Number(a) - Number(b)),
    [machines],
  )

  const found = useMemo(() => {
    const byId = new Map<string, ProductionOrder>()
    for (const o of [...byOrderNumber, ...byItemCode]) byId.set(o.id, o)
    return Array.from(byId.values())
  }, [byOrderNumber, byItemCode])

  /** Items present in what the search returned — not the whole catalogue. */
  const itemOptions = useMemo(() => Array.from(new Set(found.map((o) => o.item))).sort(), [found])

  const results = useMemo(
    () =>
      found
        .filter((o) => !itemFilter || o.item === itemFilter)
        .filter((o) => !wcFilter || o.workCenterCode === wcFilter)
        .sort((a, b) => a.orderNumber.localeCompare(b.orderNumber))
        .slice(0, 40),
    [found, itemFilter, wcFilter],
  )

  /** Samples already recorded against the picked order (§4). */
  const previousSamples = useMemo(
    () => [...samples].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    [samples],
  )

  function reset() {
    setPicked(null)
    setStartQty('')
    setOrderTerm('')
    setItemFilter('')
    setWcFilter('')
  }

  async function startSession() {
    if (!picked || !profile) return
    const qty = Number(startQty)
    if (Number.isNaN(qty) || qty < 0) return
    setBusy(true)
    try {
      const now = new Date().toISOString()
      // `sessions` is already scoped to this order.
      const seq = sessions.length + 1
      const session: InspectionSession = {
        id: uid('sess'),
        seq,
        orderId: picked.id,
        workCenterCode: picked.workCenterCode,
        inspectorUid: profile.uid,
        inspectorName: profile.name,
        startedAt: now,
        status: 'Open',
        startQtyConfirmed: { qty, byUid: profile.uid, byName: profile.name, at: now },
        version: 0,
      }
      await setDoc(doc(getDb(), COL.sessions, session.id), stripUndefined(session))
      toast(`Session started for ${picked.orderNumber}.`, 'success')
      reset()
      onClose()
      navigate(`/wizard/${session.id}`)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not start the session.', 'error')
    } finally {
      setBusy(false)
    }
  }

  // ---- Step 2: confirm the order and the starting quantity -----------------
  if (picked) {
    const machine = machines.find((m) => m.code === picked.workCenterCode)
    const remaining = Math.max(0, picked.requiredQty - picked.finishedQty)
    const qty = Number(startQty)
    const valid = startQty.trim() !== '' && !Number.isNaN(qty) && qty >= 0

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
            <Button variant="primary" disabled={!valid || busy} onClick={startSession} className="min-h-[48px]">
              <Play className="h-4 w-4" /> {busy ? 'Starting…' : 'Start inspection'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="rounded-2xl bg-slate-50 p-4 dark:bg-slate-800/50">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-lg font-bold">{picked.orderNumber}</p>
              {isPaintWorkCenter(picked.workCenterCode) && <Badge tone="violet">Paint sample step</Badge>}
              {isPTWorkCenter(picked.workCenterCode) && <Badge tone="amber">PT / weld step</Badge>}
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
              <Detail label="Work center" value={machine?.name ?? picked.workCenterCode} />
              <Detail label="Drawing" value={picked.drawing} />
              <Detail label="Material" value={picked.material} />
              <Detail label="Grade" value={picked.expectedGrade} />
              <Detail label="Customer" value={picked.customer} />
              <Detail label="Type" value={picked.type} />
              <Detail label="Colour" value={picked.colour} />
            </dl>
          </div>

          <Field
            label="Starting production quantity"
            hint="Confirmed once per session — the baseline every later quantity is judged against."
          >
            <Input
              autoFocus
              type="number"
              inputMode="numeric"
              value={startQty}
              onChange={(e) => setStartQty(e.target.value)}
              placeholder="0"
              className="min-h-[48px] text-lg"
            />
          </Field>

          <div>
            <p className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase text-slate-400">
              <Boxes className="h-3.5 w-3.5" /> Previous samples on this order
            </p>
            {previousSamples.length === 0 ? (
              <p className="rounded-xl border border-dashed border-slate-200 py-3 text-center text-sm text-slate-400 dark:border-slate-700">
                No samples recorded yet.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {previousSamples.slice(0, 12).map((s) => (
                  <span
                    key={s.id}
                    className="rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                  >
                    #{s.index} · shift {s.shift} · {new Date(s.createdAt).toLocaleDateString()}
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-start gap-2 rounded-xl bg-brand-50 px-3 py-2.5 text-sm text-brand-700 dark:bg-brand-500/10 dark:text-brand-300">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            Who confirmed this quantity, and when, is recorded with the session.
          </div>
        </div>
      </Modal>
    )
  }

  // ---- Step 1: cascading filters -------------------------------------------
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
    >
      <div className="space-y-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            autoFocus
            value={orderTerm}
            onChange={(e) => setOrderTerm(e.target.value)}
            placeholder="Order number or item code…"
            className="min-h-[48px] pl-9"
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Select value={itemFilter} onChange={(e) => setItemFilter(e.target.value)} className="min-h-[48px]">
            <option value="">All items found</option>
            {itemOptions.map((i) => (
              <option key={i} value={i}>
                {i}
              </option>
            ))}
          </Select>
          <Select value={wcFilter} onChange={(e) => setWcFilter(e.target.value)} className="min-h-[48px]">
            <option value="">All work centers</option>
            {wcOptions.map((w) => (
              <option key={w} value={w}>
                {machines.find((m) => m.code === w)?.displayName ?? `Work center ${w}`}
              </option>
            ))}
          </Select>
        </div>

        <div className="max-h-[46vh] space-y-2 overflow-y-auto pr-1">
          {results.length === 0 && (
            <p className="py-8 text-center text-sm text-slate-400">No orders match those filters.</p>
          )}
          {results.map((o) => (
            <button
              key={o.id}
              onClick={() => {
                setPicked(o)
                setStartQty(String(Math.max(0, o.requiredQty - o.finishedQty)))
              }}
              className="flex w-full items-center gap-3 rounded-2xl border border-slate-200 p-3 text-left transition-colors hover:border-brand-400 hover:bg-brand-50/50 dark:border-slate-800 dark:hover:border-brand-500/50 dark:hover:bg-brand-500/5"
            >
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-100 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300">
                <Package className="h-5 w-5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-bold">{o.orderNumber}</p>
                <p className="truncate text-sm text-slate-500 dark:text-slate-400">
                  {o.item} · {o.itemCode} · WC {o.workCenterCode}
                </p>
              </div>
            </button>
          ))}
        </div>
      </div>
    </Modal>
  )
}

function Metric({ label, value, tone }: { label: string; value: number; tone?: 'green' | 'blue' }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase text-slate-400">{label}</p>
      <p
        className={
          tone === 'green'
            ? 'text-xl font-bold tabular-nums text-emerald-500'
            : tone === 'blue'
              ? 'text-xl font-bold tabular-nums text-brand-500'
              : 'text-xl font-bold tabular-nums'
        }
      >
        {value}
      </p>
    </div>
  )
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase text-slate-400">{label}</dt>
      <dd className="truncate font-semibold text-slate-800 dark:text-slate-100">{value || '—'}</dd>
    </div>
  )
}
