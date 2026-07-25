import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { doc, setDoc } from 'firebase/firestore'
import { ArrowLeft, FileText, Plus, Search } from 'lucide-react'
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Select } from '@/components/ui'
import { ImagePicker } from '@/components/inspection/ImagePicker'
import { useAll } from '@/services/useCollection'
import { COL, stripUndefined } from '@/services/repository'
import { getDb } from '@/lib/firebase'
import { useAuth } from '@/store/AuthContext'
import { useApp } from '@/store/AppContext'
import { uid, formatDateTime } from '@/lib/utils'
import type { PDIDocument, ProductionOrder } from '@/domain/types'

/** §4 — Pre-Delivery Inspection: photo documentation attached to an order. */
export function PDIPage() {
  const navigate = useNavigate()
  const { profile } = useAuth()
  const { toast } = useApp()
  const { rows: orders } = useAll<ProductionOrder>(COL.orders)
  const { rows: docs, loading } = useAll<PDIDocument>(COL.pdi)

  const [term, setTerm] = useState('')
  const [adding, setAdding] = useState(false)

  const orderById = useMemo(() => new Map(orders.map((o) => [o.id, o])), [orders])

  const filtered = useMemo(() => {
    const t = term.trim().toLowerCase()
    return docs
      .filter((d) => {
        if (!t) return true
        const o = orderById.get(d.orderId)
        return (
          o?.orderNumber.toLowerCase().includes(t) ||
          o?.item.toLowerCase().includes(t) ||
          (d.notes ?? '').toLowerCase().includes(t)
        )
      })
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  }, [docs, term, orderById])

  return (
    <div className="space-y-4">
      <button
        onClick={() => navigate('/')}
        className="inline-flex min-h-[44px] items-center gap-1.5 text-sm font-semibold text-slate-500 hover:text-brand-600 dark:text-slate-400"
      >
        <ArrowLeft className="h-4 w-4" /> Inspections
      </button>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">PDI Documents</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Pre-delivery inspection photos attached to a production order.
          </p>
        </div>
        <Button variant="primary" className="min-h-[48px]" onClick={() => setAdding(true)}>
          <Plus className="h-4 w-4" /> New PDI
        </Button>
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <Input
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Search by order, item or note…"
          className="min-h-[48px] pl-9"
        />
      </div>

      {loading ? (
        <Card className="p-10 text-center text-sm text-slate-400">Loading…</Card>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<FileText className="h-10 w-10" />}
          title="No PDI documents yet"
          hint="Attach pre-delivery photos to an order so they travel with the record."
          action={
            <Button variant="primary" onClick={() => setAdding(true)}>
              <Plus className="h-4 w-4" /> New PDI
            </Button>
          }
        />
      ) : (
        <div className="space-y-3">
          {filtered.map((d) => {
            const o = orderById.get(d.orderId)
            return (
              <Card key={d.id} className="p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-bold">{o?.orderNumber ?? 'Unknown order'}</span>
                  <Badge tone="neutral">{d.imageIds.length} photo{d.imageIds.length === 1 ? '' : 's'}</Badge>
                  <span className="ml-auto text-xs text-slate-400">{formatDateTime(d.createdAt)}</span>
                </div>
                {o && (
                  <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
                    {o.item} · {o.customer}
                  </p>
                )}
                {d.notes && <p dir="auto" className="mt-2 text-sm">{d.notes}</p>}
                <div className="mt-3">
                  <ImagePicker imageIds={d.imageIds} onChange={() => {}} readOnly />
                </div>
              </Card>
            )
          })}
        </div>
      )}

      {adding && (
        <NewPDIDialog
          orders={orders}
          onClose={() => setAdding(false)}
          onSave={async (orderId, notes, imageIds) => {
            if (!profile) return
            const record: PDIDocument = {
              id: uid('pdi'),
              orderId,
              notes,
              imageIds,
              createdAt: new Date().toISOString(),
              createdByUid: profile.uid,
            }
            try {
              await setDoc(doc(getDb(), COL.pdi, record.id), stripUndefined(record))
              toast('PDI document saved.', 'success')
              setAdding(false)
            } catch (e) {
              toast(e instanceof Error ? e.message : 'Could not save.', 'error')
            }
          }}
        />
      )}
    </div>
  )
}

function NewPDIDialog({
  orders,
  onClose,
  onSave,
}: {
  orders: ProductionOrder[]
  onClose: () => void
  onSave: (orderId: string, notes: string, imageIds: string[]) => void
}) {
  const [orderId, setOrderId] = useState(orders[0]?.id ?? '')
  const [notes, setNotes] = useState('')
  const [imageIds, setImageIds] = useState<string[]>([])

  return (
    <Modal
      open
      onClose={onClose}
      title="New PDI document"
      icon={<FileText className="h-5 w-5" />}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!orderId} onClick={() => onSave(orderId, notes, imageIds)}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Production order">
          <Select value={orderId} onChange={(e) => setOrderId(e.target.value)} className="min-h-[48px]">
            {orders.map((o) => (
              <option key={o.id} value={o.id}>
                {o.orderNumber} · {o.item}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Notes">
          <textarea dir="auto" className="input min-h-[80px]" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <div>
          <span className="label">Photos</span>
          <ImagePicker imageIds={imageIds} onChange={setImageIds} orderId={orderId} />
        </div>
      </div>
    </Modal>
  )
}
