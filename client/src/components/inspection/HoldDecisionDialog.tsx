// ============================================================================
// §7 — the Hold decisions of one session, made from the board.
//
// A Hold is a defect waiting for someone to decide. Tapping the Hold badge on
// a session opens this: one card per defect on Hold, the decision as a row of
// buttons, saved through the same version-checked correction the sample view
// uses — so the audit entry is the same too.
// ============================================================================

import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Ban, CheckCircle2, Loader2, PauseCircle, Shuffle, Wrench } from 'lucide-react'
import type { SessionWithOrder } from '@qc/shared/api'
import type { Disposition } from '@qc/shared/types'
import { Button, Modal } from '@/components/ui'
import { useSessionDefects } from '@/services/queries'
import { correctDefect } from '@/services/mutations'
import { useApp } from '@/store/AppContext'
import { cn } from '@/lib/utils'

/** The decisions a Hold can take, each with the colour it carries elsewhere. */
const CHOICES: { value: Exclude<Disposition, 'Hold'>; label: string; icon: typeof Wrench; on: string; off: string }[] = [
  { value: 'Repair', label: 'Repair', icon: Wrench, on: 'bg-brand-600 text-white ring-brand-600', off: 'text-brand-700 ring-brand-200 hover:bg-brand-50 dark:text-brand-300 dark:ring-brand-500/40' },
  { value: 'Rejected', label: 'Reject', icon: Ban, on: 'bg-rose-600 text-white ring-rose-600', off: 'text-rose-700 ring-rose-200 hover:bg-rose-50 dark:text-rose-300 dark:ring-rose-500/40' },
  { value: 'Used in another order', label: 'Use in another order', icon: Shuffle, on: 'bg-violet-600 text-white ring-violet-600', off: 'text-violet-700 ring-violet-200 hover:bg-violet-50 dark:text-violet-300 dark:ring-violet-500/40' },
  { value: 'Accept with concession', label: 'Accept with concession', icon: CheckCircle2, on: 'bg-emerald-600 text-white ring-emerald-600', off: 'text-emerald-700 ring-emerald-200 hover:bg-emerald-50 dark:text-emerald-300 dark:ring-emerald-500/40' },
]

export function HoldDecisionDialog({ session, onClose }: { session: SessionWithOrder; onClose: () => void }) {
  const queryClient = useQueryClient()
  const { toast } = useApp()
  const { data, isLoading } = useSessionDefects(session.id)
  const holds = (data?.defects ?? []).filter((d) => d.disposition === 'Hold')
  /** The decision picked per defect, before it is saved. */
  const [picked, setPicked] = useState<Record<string, Exclude<Disposition, 'Hold'>>>({})
  const [savingId, setSavingId] = useState<string | null>(null)

  async function decide(id: string) {
    const d = holds.find((x) => x.id === id)
    const disposition = picked[id]
    if (!d || !disposition || savingId) return
    setSavingId(id)
    try {
      await correctDefect(queryClient, id, { disposition, qty: d.qty, version: d.version })
      toast(`"${d.defectName}" — ${disposition}. The change is in the audit log.`, 'success')
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
      size="lg"
      icon={<PauseCircle className="h-5 w-5" />}
      title={
        <span>
          On Hold
          {holds.length > 0 && <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-800 dark:bg-amber-500/20 dark:text-amber-300">{holds.length}</span>}
        </span>
      }
      footer={
        <Button className="min-h-[48px]" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="mb-4 rounded-xl bg-slate-50 px-3 py-2 text-sm dark:bg-slate-800/60">
        <span className="font-bold">{session.order?.orderNumber ?? 'For stock'}</span>
        <span className="text-slate-400"> · session #{session.seq}</span>
        {session.order?.item && (
          <span className="block truncate text-xs text-slate-500 dark:text-slate-400" dir="auto">
            {session.order.item}
          </span>
        )}
      </div>

      {isLoading ? (
        <p className="py-8 text-center text-sm text-slate-400">Loading…</p>
      ) : holds.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-8 text-center">
          <CheckCircle2 className="h-8 w-8 text-emerald-500" />
          <p className="text-sm font-semibold">Nothing on Hold in this session.</p>
          <p className="text-xs text-slate-400">Every defect here has its decision.</p>
        </div>
      ) : (
        <ul className="space-y-3">
          {holds.map((d) => {
            const choice = picked[d.id]
            const saving = savingId === d.id
            return (
              <li key={d.id} className="rounded-2xl border border-amber-200 bg-amber-50/40 p-3 dark:border-amber-500/30 dark:bg-amber-500/5 sm:p-4">
                <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                  <p dir="auto" className="min-w-0 flex-1 text-base font-bold leading-snug">
                    {d.defectName}
                  </p>
                  <span className="flex shrink-0 flex-wrap items-center gap-1.5 text-xs font-semibold">
                    <span className="rounded-full bg-white px-2 py-0.5 tabular-nums text-slate-600 ring-1 ring-slate-200 dark:bg-slate-900 dark:text-slate-300 dark:ring-slate-700">
                      Sample {session.seq}-{d.sampleIndex}
                    </span>
                    <span className="rounded-full bg-white px-2 py-0.5 tabular-nums text-slate-600 ring-1 ring-slate-200 dark:bg-slate-900 dark:text-slate-300 dark:ring-slate-700">
                      {d.qty} pc{d.qty === 1 ? '' : 's'}
                    </span>
                  </span>
                </div>
                {d.notes && (
                  <p dir="auto" className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                    {d.notes}
                  </p>
                )}

                {/* The decision: one tap to choose, one to save. */}
                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {CHOICES.map((c) => {
                    const Icon = c.icon
                    const on = choice === c.value
                    return (
                      <button
                        key={c.value}
                        type="button"
                        aria-pressed={on}
                        disabled={saving}
                        onClick={() => setPicked((p) => ({ ...p, [d.id]: c.value }))}
                        className={cn(
                          'inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl px-2 text-xs font-bold ring-1 transition-colors',
                          on ? c.on : cn('bg-white dark:bg-slate-900', c.off),
                        )}
                      >
                        <Icon className="h-4 w-4 shrink-0" />
                        <span className="text-center leading-tight">{c.label}</span>
                      </button>
                    )
                  })}
                </div>
                <div className="mt-2 flex justify-end">
                  <Button variant="primary" className="min-h-[44px]" disabled={!choice || saving} onClick={() => void decide(d.id)}>
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    {saving ? 'Saving…' : choice ? `Save: ${choice}` : 'Pick a decision'}
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </Modal>
  )
}
