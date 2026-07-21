import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, Package, Play, ArrowRight, Factory, CheckCircle2 } from 'lucide-react'
import { Modal, Input, Field, Button, Badge } from '@/components/ui'
import { useDB, actions } from '@/store/db'
import { machineById } from '@/lib/selectors'
import { useApp } from '@/store/AppContext'
import type { ProductionOrder } from '@/types'
import { cn } from '@/lib/utils'

/**
 * New Inspection flow.
 * Step 1: pick a production order.
 * Step 2: if the machine is a Paint Sample line (7 / 11 / 48) go straight into
 * the inspection. Otherwise show a start-session confirmation popup (qty).
 */
export function NewInspectionDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const db = useDB()
  const { toast } = useApp()
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [selected, setSelected] = useState<ProductionOrder | null>(null)
  const [qty, setQty] = useState('')

  const results = useMemo(() => {
    const term = q.trim().toLowerCase()
    return db.orders
      .filter((o) => o.status !== 'Cancelled')
      .filter(
        (o) =>
          !term ||
          o.orderId.toLowerCase().includes(term) ||
          o.item.toLowerCase().includes(term) ||
          o.itemCode.toLowerCase().includes(term),
      )
      .slice(0, 40)
  }, [db.orders, q])

  function reset() {
    setSelected(null)
    setQty('')
    setQ('')
  }

  function startFlow(order: ProductionOrder) {
    const machine = machineById(db, order.machineId)
    const isPaintSample = machine?.kind === 'Paint Sample'
    if (isPaintSample) {
      // Paint sample machines go straight into inspection.
      const session = actions.createSession({
        orderId: order.id,
        machineId: order.machineId,
        confirm: 'Confirmed',
      })
      toast(`Inspection started for ${order.orderId}`, 'success')
      reset()
      onClose()
      navigate(`/session/${session.id}`)
    } else {
      // Non-paint machines require a start-session confirmation popup.
      setSelected(order)
      setQty(String(order.requiredQty || ''))
    }
  }

  function confirmStart() {
    if (!selected) return
    const session = actions.createSession({
      orderId: selected.id,
      machineId: selected.machineId,
      finalQty: qty ? Number(qty) : undefined,
      confirm: 'Confirmed',
    })
    toast(`Inspection started for ${selected.orderId}`, 'success')
    reset()
    onClose()
    navigate(`/session/${session.id}`)
  }

  // Confirmation popup (step 2)
  if (selected) {
    const machine = machineById(db, selected.machineId)
    return (
      <Modal
        open={open}
        onClose={() => setSelected(null)}
        title="Confirm inspection start"
        icon={<Factory className="h-5 w-5" />}
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setSelected(null)}>
              Back
            </Button>
            <Button variant="primary" onClick={confirmStart}>
              <Play className="h-4 w-4" /> Start Inspection
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="rounded-2xl bg-slate-50 p-4 dark:bg-slate-800/50">
            <p className="text-lg font-bold">{selected.orderId}</p>
            <p className="text-sm text-brand-600 dark:text-brand-400">
              {selected.item} : {selected.itemCode} : {selected.nominalL} : {selected.color}
            </p>
            <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-xs uppercase text-slate-400">Machine</p>
                <p className="font-semibold">{machine?.name}</p>
              </div>
              <div>
                <p className="text-xs uppercase text-slate-400">Route</p>
                <p className="font-semibold">{selected.route}</p>
              </div>
            </div>
          </div>
          <Field label="Starting quantity" hint="Confirm the batch quantity for this session">
            <Input type="number" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="0" />
          </Field>
          <div className="flex items-center gap-2 rounded-xl bg-brand-50 px-3 py-2.5 text-sm text-brand-700 dark:bg-brand-500/10 dark:text-brand-300">
            <CheckCircle2 className="h-4 w-4" />
            A new inspection session will be created and linked to this order.
          </div>
        </div>
      </Modal>
    )
  }

  // Order picker (step 1)
  return (
    <Modal
      open={open}
      onClose={() => {
        reset()
        onClose()
      }}
      title="New Inspection"
      icon={<Package className="h-5 w-5" />}
      size="lg"
    >
      <div className="space-y-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search order, item or code…" className="pl-9" />
        </div>
        <div className="max-h-[52vh] space-y-2 overflow-y-auto pr-1">
          {results.length === 0 && <p className="py-8 text-center text-sm text-slate-400">No matching orders.</p>}
          {results.map((o) => {
            const machine = machineById(db, o.machineId)
            const isPaint = machine?.kind === 'Paint Sample'
            return (
              <button
                key={o.id}
                onClick={() => startFlow(o)}
                className="group flex w-full items-center gap-3 rounded-2xl border border-slate-200 p-3 text-left transition-colors hover:border-brand-400 hover:bg-brand-50/50 dark:border-slate-800 dark:hover:border-brand-500/50 dark:hover:bg-brand-500/5"
              >
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-100 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300">
                  <Package className="h-5 w-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-bold">{o.orderId}</span>
                    {isPaint && <Badge tone="violet">Paint Sample</Badge>}
                    <Badge tone={o.status === 'Active' ? 'green' : 'neutral'}>{o.status}</Badge>
                  </div>
                  <p className="truncate text-sm text-slate-500 dark:text-slate-400">
                    {o.item} : {o.itemCode} · {machine?.name}
                  </p>
                </div>
                <ArrowRight className={cn('h-5 w-5 shrink-0 text-slate-300 transition-transform group-hover:translate-x-0.5 group-hover:text-brand-500')} />
              </button>
            )
          })}
        </div>
      </div>
    </Modal>
  )
}
