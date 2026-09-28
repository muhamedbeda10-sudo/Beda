// ============================================================================
// §4 — correct a session's quantities after the fact: the quantity rejected
// before release, the quantity produced (make-to-stock), and the final
// quantity typed at close. Each is as mis-keyed as any other figure; the
// change goes through the version-checked correction endpoint, which writes
// the audit entry.
// ============================================================================

import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Pencil } from 'lucide-react'
import type { SessionWithOrder } from '@qc/shared/api'
import { isStockOrder } from '@qc/shared/rules'
import { Button, Field, Input, Modal } from '@/components/ui'
import { updateSessionQuantities } from '@/services/mutations'
import { useSessionStages } from '@/services/queries'
import { StagePicker } from './StagePicker'
import { useApp } from '@/store/AppContext'

/** A quantity field: empty reads as zero, anything else must be a non-negative number. */
function parseQty(raw: string): number | null {
  if (raw.trim() === '') return 0
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : null
}

export function SessionQuantitiesDialog({ session, onClose }: { session: SessionWithOrder; onClose: () => void }) {
  const queryClient = useQueryClient()
  const { toast } = useApp()
  const stock = isStockOrder(session.order)
  const closed = session.status === 'Closed'
  const [start, setStart] = useState(String(session.startQtyConfirmed?.qty ?? 0))
  const [produced, setProduced] = useState(String(session.producedQty ?? 0))
  const [final, setFinal] = useState(String(session.finalQty ?? 0))
  // A closed session on a universal machine carries its stage, corrected here like a quantity.
  const hasStage = closed && session.stage !== undefined
  const { data: stageOptions } = useSessionStages(session.id, hasStage)
  const [stage, setStage] = useState<number | null>(session.stage ?? null)
  const [saving, setSaving] = useState(false)

  const startQty = parseQty(start)
  const producedQty = parseQty(produced)
  const finalQty = parseQty(final)
  const valid = (stock ? producedQty !== null : startQty !== null) && (!closed || finalQty !== null)

  // Only what changed is sent, so the audit log records exactly that.
  const changes = {
    ...(!stock && startQty !== null && startQty !== (session.startQtyConfirmed?.qty ?? 0) ? { startQty } : {}),
    ...(stock && producedQty !== null && producedQty !== (session.producedQty ?? 0) ? { producedQty } : {}),
    ...(closed && finalQty !== null && finalQty !== (session.finalQty ?? 0) ? { finalQty } : {}),
    ...(hasStage && stage !== null && stage !== session.stage ? { stage } : {}),
  }
  const dirty = Object.keys(changes).length > 0

  async function save() {
    if (!valid || !dirty || saving) return
    setSaving(true)
    try {
      await updateSessionQuantities(queryClient, session.id, { ...changes, version: session.version })
      toast('Quantities corrected. The change is in the audit log.', 'success')
      onClose()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save the correction.', 'error')
    } finally {
      setSaving(false)
    }
  }

  const qtyInput = (value: string, set: (v: string) => void) => (
    <Input
      type="number"
      inputMode="numeric"
      min={0}
      value={value}
      onFocus={(e) => e.target.select()}
      onChange={(e) => set(e.target.value.replace(/^0+(?=\d)/, ''))}
      onKeyDown={(e) => e.key === 'Enter' && void save()}
      className="min-h-[48px] text-lg"
    />
  )

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      icon={<Pencil className="h-5 w-5" />}
      title="Correct quantities"
      footer={
        <>
          <Button className="min-h-[48px]" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" className="min-h-[48px]" onClick={() => void save()} disabled={!valid || !dirty || saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
        {stock ? 'For stock' : session.order?.orderNumber} · session #{session.seq} · {session.status}
      </p>
      <div className="space-y-3">
        {stock ? (
          <Field label="Quantity produced (pairs)">{qtyInput(produced, setProduced)}</Field>
        ) : (
          <Field label="Rejected before release">
            {qtyInput(start, setStart)}
            {session.startQtyConfirmed && (
              <span className="mt-1 block text-xs text-slate-400">
                Recorded as {session.startQtyConfirmed.qty} by {session.startQtyConfirmed.byName}
              </span>
            )}
          </Field>
        )}
        {closed ? (
          <Field label="Final quantity (at close)">{qtyInput(final, setFinal)}</Field>
        ) : (
          <p className="text-xs text-slate-400">The final quantity is typed when the session closes, and can be corrected here after that.</p>
        )}
        {hasStage && stageOptions && (
          <div>
            <span className="label">Stage of this item</span>
            <StagePicker options={stageOptions} value={stage} onChange={setStage} />
          </div>
        )}
        {!valid && <p className="text-sm font-semibold text-rose-600 dark:text-rose-400">Enter zero or a positive quantity.</p>}
      </div>
    </Modal>
  )
}
