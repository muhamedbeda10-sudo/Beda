// ============================================================================
// §7 — the Hold decisions of one session, changed from the board.
//
// A Hold is a defect waiting for someone to decide. Tapping the Hold badge on
// a session opens this: every defect on Hold in that session, each with the
// decision to make, saved one by one through the same version-checked
// correction the sample view uses — so the audit entry is the same too.
// ============================================================================

import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { PauseCircle } from 'lucide-react'
import type { SessionWithOrder } from '@qc/shared/api'
import { DISPOSITIONS, type Disposition } from '@qc/shared/types'
import { Badge, Button, Modal, Select } from '@/components/ui'
import { useSessionDefects } from '@/services/queries'
import { correctDefect } from '@/services/mutations'
import { useApp } from '@/store/AppContext'

export function HoldDecisionDialog({ session, onClose }: { session: SessionWithOrder; onClose: () => void }) {
  const queryClient = useQueryClient()
  const { toast } = useApp()
  const { data, isLoading } = useSessionDefects(session.id)
  const holds = (data?.defects ?? []).filter((d) => d.disposition === 'Hold')
  /** The decision picked per defect, before it is saved. */
  const [picked, setPicked] = useState<Record<string, Disposition>>({})
  const [savingId, setSavingId] = useState<string | null>(null)

  async function decide(id: string) {
    const d = holds.find((x) => x.id === id)
    const disposition = picked[id]
    if (!d || !disposition || disposition === 'Hold' || savingId) return
    setSavingId(id)
    try {
      await correctDefect(queryClient, id, { disposition, qty: d.qty, version: d.version })
      toast(`"${d.defectName}" is now ${disposition}. The change is in the audit log.`, 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save the decision.', 'error')
    } finally {
      setSavingId(null)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      icon={<PauseCircle className="h-5 w-5" />}
      title="On Hold"
      footer={
        <Button className="min-h-[48px]" onClick={onClose}>
          Done
        </Button>
      }
    >
      <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
        {session.order?.orderNumber ?? 'For stock'} · session #{session.seq} · {session.order?.item}
      </p>
      {isLoading ? (
        <p className="py-6 text-center text-sm text-slate-400">Loading…</p>
      ) : holds.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-400">Nothing on Hold in this session any more.</p>
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {holds.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p dir="auto" className="font-semibold">
                  {d.defectName}
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Sample {session.seq}-{d.sampleIndex} · {d.qty} pc{d.qty === 1 ? '' : 's'}
                  {d.notes ? ` · ${d.notes}` : ''}
                </p>
              </div>
              <Badge tone="amber">Hold</Badge>
              <Select
                value={picked[d.id] ?? 'Hold'}
                onChange={(e) => setPicked((p) => ({ ...p, [d.id]: e.target.value as Disposition }))}
                className="min-h-[44px] w-full sm:w-56"
                aria-label={`Decision for ${d.defectName}`}
              >
                {DISPOSITIONS.map((x) => (
                  <option key={x} value={x}>
                    {x === 'Hold' ? 'Hold — decide…' : x}
                  </option>
                ))}
              </Select>
              <Button
                variant="primary"
                className="min-h-[44px]"
                disabled={!picked[d.id] || picked[d.id] === 'Hold' || savingId !== null}
                onClick={() => void decide(d.id)}
              >
                {savingId === d.id ? 'Saving…' : 'Save'}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}
