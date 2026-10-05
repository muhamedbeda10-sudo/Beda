// ============================================================================
// What a chip opens. A person: their direct conversation. A machine: the
// board filtered to it. A session: its wizard. An order line or an item: a
// panel with the line(s) and their recent inspection history.
// ============================================================================

import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ClipboardList, Package } from 'lucide-react'
import type { ChatMention, ProductionOrder } from '@qc/shared/types'
import { remainingQty } from '@qc/shared/types'
import { Badge, Button, Drawer } from '@/components/ui'
import { useOrder, useOrderHistory, useOrderSearch } from '@/services/queries'
import { formatDateTime } from '@/lib/utils'
import { sessionDetailPath } from '@/lib/links'

function OrderLine({ orderId, onClose }: { orderId: string; onClose: () => void }) {
  const navigate = useNavigate()
  const { data: o, isLoading } = useOrder(orderId)
  const { data: history } = useOrderHistory(orderId)
  if (isLoading) return <p className="text-sm text-slate-400">Loading…</p>
  if (!o) return <p className="text-sm text-slate-400">This order line is no longer in the catalogue.</p>
  const rows: [string, string][] = [
    ['Order', o.orderNumber],
    ['Item', `${o.item} · ${o.itemCode}`],
    ['Machine', o.workCenterCode],
    ['Customer', o.customer || '—'],
    ['Drawing', o.drawing || '—'],
    ['Expected grade', o.expectedGrade || '—'],
    ['Quantity', `${o.finishedQty} of ${o.requiredQty} · ${remainingQty(o)} remaining`],
    ['ERP status', o.erpStatus || '—'],
  ]
  const sessions = history?.sessions ?? []
  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{k}</dt>
            <dd className="text-sm font-semibold">{v}</dd>
          </div>
        ))}
      </dl>
      <div>
        <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-400">Inspections on this line</p>
        {sessions.length === 0 ? (
          <p className="mt-1 text-sm text-slate-400">None yet.</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {sessions.slice(0, 8).map((s) => (
              <li key={s.id}>
                <button type="button" onClick={() => { onClose(); navigate(sessionDetailPath(s.id)) }} className="flex w-full items-center justify-between gap-2 rounded-xl border border-slate-200 px-3 py-2 text-left text-sm hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">
                  <span>
                    Session #{s.seq} · {s.inspectorName}
                    <span className="block text-xs text-slate-400">{formatDateTime(s.startedAt)}</span>
                  </span>
                  <Badge tone={s.status === 'Open' ? 'green' : 'neutral'}>{s.status}</Badge>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <Button variant="primary" onClick={() => { onClose(); navigate('/history') }}>Open History</Button>
    </div>
  )
}

function ItemLines({ itemCode, onPick }: { itemCode: string; onPick: (o: ProductionOrder) => void }) {
  const { data: lines = [], isFetching } = useOrderSearch(itemCode, 40)
  const mine = lines.filter((o) => o.itemCode.toLowerCase() === itemCode.toLowerCase())
  if (isFetching && mine.length === 0) return <p className="text-sm text-slate-400">Searching…</p>
  if (mine.length === 0) return <p className="text-sm text-slate-400">No open order line carries this item.</p>
  return (
    <ul className="space-y-1">
      {mine.map((o) => (
        <li key={o.id}>
          <button type="button" onClick={() => onPick(o)} className="flex w-full items-center justify-between gap-2 rounded-xl border border-slate-200 px-3 py-2 text-left text-sm hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">
            <span>
              <span className="font-semibold">{o.orderNumber}</span> · machine {o.workCenterCode}
              <span className="block text-xs text-slate-400">{o.customer} · {remainingQty(o)} remaining</span>
            </span>
            <Package className="h-4 w-4 text-slate-400" />
          </button>
        </li>
      ))}
    </ul>
  )
}

/** Handles a chip tap. Returns the panel to render and the handler to call. */
export function useMentionPanel(onOpenDirect: (userId: string) => void) {
  const navigate = useNavigate()
  const [open, setOpen] = useState<ChatMention | null>(null)
  const handle = (m: ChatMention) => {
    if (m.kind === 'user') onOpenDirect(m.value)
    else if (m.kind === 'machine') {
      try {
        localStorage.setItem('qc-board:machine', JSON.stringify(m.value))
        localStorage.setItem('qc-board:factory', JSON.stringify('all'))
      } catch {
        // The board simply opens unfiltered.
      }
      navigate('/')
    } else if (m.kind === 'session') navigate(sessionDetailPath(m.value))
    else setOpen(m)
  }
  const panel = open ? (
    <Drawer open onClose={() => setOpen(null)} title={open.kind === 'order' ? 'Order line' : `Item ${open.value}`} subtitle={open.label} icon={<ClipboardList className="h-5 w-5" />}>
      {open.kind === 'order' ? <OrderLine orderId={open.value} onClose={() => setOpen(null)} /> : <ItemLines itemCode={open.value} onPick={(o) => setOpen({ kind: 'order', value: o.id, label: `${o.orderNumber} · ${o.item}` })} />}
    </Drawer>
  ) : null
  return { handle, panel }
}
