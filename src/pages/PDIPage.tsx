import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { doc, setDoc } from 'firebase/firestore'
import { ArrowLeft, FileText, Plus, Search } from 'lucide-react'
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Select } from '@/components/ui'
import { ImagePicker } from '@/components/inspection/ImagePicker'
import { useDocsByIds, usePrefixSearch, useRecent } from '@/services/useCollection'
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
  const [term, setTerm] = useState('')
  const [adding, setAdding] = useState(false)

  // The 50 most recent PDI documents, and only the orders they name.
  const { rows: docs, loading } = useRecent<PDIDocument>(COL.pdi, 'createdAt', 50)
  const docOrderIds = useMemo(() => docs.map((d) => d.orderId), [docs])
  const { rows: orders } = useDocsByIds<ProductionOrder>(COL.orders, docOrderIds)

  const orderById = useMemo(() => new Map(orders.map((o) => [o.id, o])), [orders])

  // Searching narrows what is already on screen; it does not scan the archive.
  const filtered = useMemo(() => {
    const t = term.trim().toLowerCase()
    if (!t) return docs
    return docs.filter((d) => {
      const o = orderById.get(d.orderId)
      return (
        o?.orderNumber.toLowerCase().includes(t) ||
        o?.item.toLowerCase().includes(t) ||
        (d.notes ?? '').toLowerCase().includes(t)
      )
    })
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
  onClose,
  onSave,
}: {
  onClose: () => void
  onSave: (orderId: string, notes: string, imageIds: string[]) => void
}) {
  const [orderTerm, setOrderTerm] = useState('')
  const [orderId, setOrderId] = useState('')
  const [notes, setNotes] = useState('')
  const [imageIds, setImageIds] = useState<string[]>([])

  // The order is chosen by searching the catalogue on the server, not by
  // scrolling a list of 29,000 options.
  const { rows: orders } = usePrefixSearch<ProductionOrder>(COL.orders, 'orderNumber', orderTerm, 25)

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
        <Field label="Production order" hint="Type an order number to search.">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              autoFocus
              value={orderTerm}
              onChange={(e) => setOrderTerm(e.target.value)}
              placeholder="Order number…"
              className="min-h-[48px] pl-9"
            />
          </div>
          <Select
            value={orderId}
            onChange={(e) => setOrderId(e.target.value)}
            className="mt-2 min-h-[48px]"
          >
            <option value="">Select an order…</option>
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
