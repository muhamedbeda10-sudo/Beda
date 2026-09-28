// §4 — a new PDI: find the order by any words of its number, or narrow the
// orders to a factory, a machine or an item; see every item the order carries
// with its drawing number, untick what does not ship this time, then notes
// and photos.

import { useEffect, useMemo, useState } from 'react'
import { Check, FileText, Search, X } from 'lucide-react'
import { Button, Field, Input, Modal, Select } from '@/components/ui'
import { ImagePicker } from '@/components/inspection/ImagePicker'
import { useMaster, useOrderAllLines, useOrderNumbersAnywhere } from '@/services/queries'
import { cn } from '@/lib/utils'
import { byName } from '@/components/dashboard/filters'
import { itemsOfLines } from './pdiItems'

export function NewPdiDialog({ onClose, onSave, saving }: { onClose: () => void; onSave: (orderIds: string[], notes: string, imageIds: string[]) => void; saving: boolean }) {
  const [orderTerm, setOrderTerm] = useState('')
  const [factory, setFactory] = useState('')
  const [machine, setMachine] = useState('')
  const [itemFilter, setItemFilter] = useState('')
  const [orderNumber, setOrderNumber] = useState('')
  /** An order found through an item: only the matching items start ticked, once its lines arrive. */
  const [tickOnly, setTickOnly] = useState<string | null>(null)
  const [itemTerm, setItemTerm] = useState('')
  /** The items left out of this delivery; everything else is covered. */
  const [unticked, setUnticked] = useState<Set<string>>(new Set())
  const [notes, setNotes] = useState('')
  const [imageIds, setImageIds] = useState<string[]>([])

  const { data: machines = [] } = useMaster('machines')
  const factories = useMemo(() => Array.from(new Set(machines.map((m) => m.factory?.trim() ?? '').filter(Boolean))).sort(byName), [machines])
  const machineOptions = useMemo(
    () => machines.filter((m) => !factory || (m.factory ?? '').trim().toLowerCase() === factory.toLowerCase()).sort((a, b) => byName(a.displayName || a.code, b.displayName || b.code)),
    [machines, factory],
  )
  const searchingOrders = orderNumber === ''
  const { data: found, isFetching: searching } = useOrderNumbersAnywhere(searchingOrders ? orderTerm : '', searchingOrders ? { factory, machine, item: itemFilter } : {})
  const numbers = found?.orders ?? []
  const anyFilter = orderTerm.trim() !== '' || factory !== '' || machine !== '' || itemFilter.trim() !== ''
  const { data: lines = [], isLoading: linesLoading } = useOrderAllLines(orderNumber)
  const items = useMemo(() => itemsOfLines(lines), [lines])
  useEffect(() => {
    if (tickOnly === null || items.length === 0) return
    const t = tickOnly.toLowerCase()
    const matching = items.filter((i) => `${i.item} ${i.itemCode} ${i.drawings.join(' ')}`.toLowerCase().includes(t))
    // An item filter that no item of the order matches leaves every item ticked.
    if (matching.length > 0) setUnticked(new Set(items.filter((i) => !matching.includes(i)).map((i) => i.key)))
    setTickOnly(null)
  }, [items, tickOnly])
  const shownItems = useMemo(() => {
    const t = itemTerm.trim().toLowerCase()
    if (!t) return items
    return items.filter((i) => `${i.item} ${i.itemCode} ${i.drawings.join(' ')}`.toLowerCase().includes(t))
  }, [items, itemTerm])
  const ticked = items.filter((i) => !unticked.has(i.key))
  const orderIds = ticked.flatMap((i) => i.lineIds)
  const customer = numbers.find((n) => n.orderNumber === orderNumber)?.customer ?? lines[0]?.customer ?? ''

  const pickOrder = (n: string) => {
    setOrderNumber(n)
    setUnticked(new Set())
    setItemTerm('')
    setImageIds([])
    setTickOnly(n && itemFilter.trim() ? itemFilter.trim() : null)
  }
  const toggle = (key: string) =>
    setUnticked((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  return (
    <Modal
      open
      onClose={onClose}
      title="New PDI document"
      icon={<FileText className="h-5 w-5" />}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={orderIds.length === 0 || saving} onClick={() => onSave(orderIds, notes, imageIds)}>
            {saving ? 'Saving…' : `Save · ${ticked.length} ${ticked.length === 1 ? 'item' : 'items'}`}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {orderNumber === '' ? (
          <div className="space-y-3">
            <Field label="Production order" hint="Type any words of the order number, in any order: 20542 ph4.">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <Input autoFocus value={orderTerm} onChange={(e) => setOrderTerm(e.target.value)} placeholder="Order number…" className="min-h-[48px] pl-9" aria-label="Order number" />
              </div>
            </Field>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <Select
                value={factory}
                onChange={(e) => {
                  setFactory(e.target.value)
                  setMachine('')
                }}
                className="min-h-[44px]"
                aria-label="PDI factory"
              >
                <option value="">All factories</option>
                {factories.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </Select>
              <Select value={machine} onChange={(e) => setMachine(e.target.value)} className="min-h-[44px]" aria-label="PDI machine">
                <option value="">All machines</option>
                {machineOptions.map((m) => (
                  <option key={m.id} value={m.code}>
                    {m.displayName || m.code}
                  </option>
                ))}
              </Select>
              <Input value={itemFilter} onChange={(e) => setItemFilter(e.target.value)} placeholder="Item, code or drawing" className="min-h-[44px]" aria-label="PDI item filter" dir="auto" />
            </div>
            {anyFilter && (
              <ul className="max-h-72 divide-y divide-slate-100 overflow-auto rounded-xl ring-1 ring-slate-200 dark:divide-slate-800 dark:ring-slate-700" aria-label="Orders found">
                {numbers.map((n) => (
                  <li key={n.orderNumber}>
                    <button type="button" onClick={() => pickOrder(n.orderNumber)} className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800">
                      <span className="font-semibold">{n.orderNumber}</span>
                      <span className="min-w-0 flex-1 truncate text-sm text-slate-500">{n.customer}</span>
                      <span className="shrink-0 text-xs text-slate-400">{n.lineCount} {n.lineCount === 1 ? 'line' : 'lines'}</span>
                    </button>
                  </li>
                ))}
                {numbers.length === 0 && <li className="px-3 py-4 text-center text-sm text-slate-400">{searching ? 'Searching…' : 'No open order matches.'}</li>}
                {found?.more && <li className="px-3 py-2.5 text-center text-xs font-semibold text-amber-700 dark:text-amber-300">More orders match than are listed: type more of the number, or narrow by factory, machine or item.</li>}
              </ul>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2 rounded-xl bg-brand-50 px-3 py-2.5 ring-1 ring-brand-200 dark:bg-brand-500/10 dark:ring-brand-500/30">
            <span className="font-bold">{orderNumber}</span>
            {customer && <span className="text-sm text-slate-500">{customer}</span>}
            <button type="button" onClick={() => pickOrder('')} className="ml-auto inline-flex items-center gap-1 text-xs font-semibold text-brand-700 hover:underline dark:text-brand-300">
              <X className="h-3.5 w-3.5" /> Change order
            </button>
          </div>
        )}

        {orderNumber !== '' && (
          <div>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <span className="label !mb-0">
                Items in this delivery · {ticked.length} of {items.length}
              </span>
              <span className="flex gap-3 text-xs font-semibold">
                <button type="button" className="text-brand-700 hover:underline disabled:opacity-40 dark:text-brand-300" disabled={unticked.size === 0} onClick={() => setUnticked(new Set())}>
                  Tick all
                </button>
                <button type="button" className="text-slate-500 hover:underline disabled:opacity-40" disabled={ticked.length === 0} onClick={() => setUnticked(new Set(items.map((i) => i.key)))}>
                  Untick all
                </button>
              </span>
            </div>
            {items.length > 8 && (
              <div className="relative mb-2">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <Input value={itemTerm} onChange={(e) => setItemTerm(e.target.value)} placeholder="Find an item, code or drawing…" className="min-h-[44px] pl-9" aria-label="Find an item" />
              </div>
            )}
            <ul className="max-h-[45vh] min-h-[12rem] divide-y divide-slate-100 overflow-auto rounded-xl ring-1 ring-slate-200 dark:divide-slate-800 dark:ring-slate-700" aria-label="Items of the order">
              {linesLoading && <li className="px-3 py-4 text-center text-sm text-slate-400">Loading the items…</li>}
              {shownItems.map((i) => {
                const on = !unticked.has(i.key)
                return (
                  <li key={i.key}>
                    <button type="button" role="checkbox" aria-checked={on} onClick={() => toggle(i.key)} className="flex w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800">
                      <span className={cn('mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded border', on ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-300 dark:border-slate-600')}>{on && <Check className="h-3.5 w-3.5" />}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block font-semibold" dir="auto">
                          {i.item}
                          {i.itemCode && <span className="ml-1.5 text-xs font-normal text-slate-400">{i.itemCode}</span>}
                        </span>
                        <span className="block text-xs text-slate-500">
                          Drawing: <span className="font-semibold text-slate-700 dark:text-slate-200">{i.drawings.length ? i.drawings.join(' · ') : '—'}</span>
                        </span>
                      </span>
                    </button>
                  </li>
                )
              })}
              {!linesLoading && items.length === 0 && <li className="px-3 py-4 text-center text-sm text-slate-400">This order has no open lines.</li>}
              {items.length > 0 && shownItems.length === 0 && <li className="px-3 py-4 text-center text-sm text-slate-400">No item matches.</li>}
            </ul>
          </div>
        )}

        <Field label="Notes">
          <textarea dir="auto" className="input min-h-[80px] w-full" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <div>
          <span className="label">Photos</span>
          <ImagePicker imageIds={imageIds} onChange={setImageIds} orderId={orderIds[0]} />
        </div>
      </div>
    </Modal>
  )
}
