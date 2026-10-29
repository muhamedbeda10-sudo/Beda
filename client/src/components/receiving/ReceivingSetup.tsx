// ============================================================================
// §27 — Receiving's setup: the factories that receive, the reasons a delivery
// is put on Hold, the units a PO counts in.
// ============================================================================

import { useState } from 'react'
import { X } from 'lucide-react'
import { RECEIVING_LISTS, RECEIVING_LIST_NAMES, type ReceivingList } from '@qc/shared/receiving'
import { Button, Card } from '@/components/ui'
import { useAddReceivingListValue, useDeleteReceivingListValue, useReceivingOptions } from '@/services/receiving'
import { useApp } from '@/store/AppContext'

const HINT: Record<ReceivingList, string> = {
  factory: 'Offered to the warehouse for “Factory that received it”.',
  'hold-reason': 'What quality chooses from when it puts a line on Hold.',
  unit: 'Offered for a PO line’s quantity.',
}

export function ReceivingSetup() {
  const { toast } = useApp()
  const options = useReceivingOptions()
  const add = useAddReceivingListValue()
  const remove = useDeleteReceivingListValue()
  const [typed, setTyped] = useState<Partial<Record<ReceivingList, string>>>({})
  async function addTo(list: ReceivingList) {
    const value = (typed[list] ?? '').trim()
    if (!value) return
    try { await add.mutateAsync({ list, value }); setTyped((t) => ({ ...t, [list]: '' })) } catch (error) { toast(error instanceof Error ? error.message : 'Could not add.', 'error') }
  }
  return <Card className="space-y-4 p-4">
    <h2 className="text-base font-semibold">Lists</h2>
    <div className="grid gap-5 md:grid-cols-3">
      {RECEIVING_LISTS.map((list) => <section key={list} aria-label={RECEIVING_LIST_NAMES[list]} className="space-y-2">
        <h3 className="label">{RECEIVING_LIST_NAMES[list]}</h3>
        <p className="text-xs text-muted">{HINT[list]}</p>
        <div className="flex flex-wrap gap-1.5">{(options.data?.lists ?? []).filter((l) => l.list === list).map((l) => <span key={l.id} className="inline-flex items-center gap-1 rounded-md bg-slate-100 py-0.5 pl-2 pr-0.5 text-sm dark:bg-slate-800">
          {l.value}<button type="button" className="rounded p-1.5 hover:bg-slate-200 dark:hover:bg-slate-700 touch:p-2.5" aria-label={`Remove ${l.value}`} onClick={() => void remove.mutateAsync(l.id).catch((e: Error) => toast(e.message, 'error'))}><X className="h-3.5 w-3.5" /></button>
        </span>)}</div>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void addTo(list) }}>
          <input dir="auto" className="input h-9 py-1" aria-label={`Add to ${RECEIVING_LIST_NAMES[list]}`} placeholder="Add…" maxLength={120} value={typed[list] ?? ''} onChange={(e) => setTyped((t) => ({ ...t, [list]: e.target.value }))} />
          <Button type="submit" disabled={!(typed[list] ?? '').trim() || add.isPending}>Add</Button>
        </form>
      </section>)}
    </div>
  </Card>
}
