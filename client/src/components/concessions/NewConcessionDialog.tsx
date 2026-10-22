import { useEffect, useState, type FormEvent } from 'react'
import { Loader2, Plus, X } from 'lucide-react'
import type { ConcessionItem } from '@qc/shared/concessions'
import { calendarDay } from '@qc/shared/rules'
import { Button, Field, Input, Modal, Select } from '@/components/ui'
import { MultiSelectMenu, SearchSelect } from '@/components/dashboard/filters'
import { ImagePicker } from '@/components/inspection/ImagePicker'
import { useUploadsInFlight } from '@/components/inspection/imageUploads'
import { useHoldUpdates } from '@/lib/appUpdate'
import { useAddConcessionCategory, useConcessionOrders, useConcessionItems, useConcessionOptions, useCreateConcession } from '@/services/concessions'
import { useDebounced } from '@/services/queries'
import { useAuth } from '@/store/AuthContext'
import { useApp } from '@/store/AppContext'

const itemKey = (item: ConcessionItem) => JSON.stringify([item.itemCode, item.item])

export function NewConcessionDialog({ onClose }: { onClose: () => void }) {
  const { factoryTimeZone } = useAuth()
  const { toast } = useApp()
  const options = useConcessionOptions()
  const save = useCreateConcession()
  const addCategory = useAddConcessionCategory()
  const [submissionId] = useState(() => crypto.randomUUID())
  const [initialDate] = useState(() => calendarDay(new Date(), factoryTimeZone))
  const [date, setDate] = useState(initialDate)
  const [factories, setFactories] = useState<string[]>([])
  const [machineIds, setMachineIds] = useState<string[]>([])
  const [orderNumber, setOrderNumber] = useState('')
  const [orderSearch, setOrderSearch] = useState('')
  const [item, setItem] = useState<ConcessionItem | null>(null)
  const [itemSearch, setItemSearch] = useState('')
  const [description, setDescription] = useState('')
  const [quantity, setQuantity] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [newCategory, setNewCategory] = useState<string | null>(null)
  const [concessionById, setConcessionById] = useState('')
  const [imageIds, setImageIds] = useState<string[]>([])
  const [uploading, onUploading] = useUploadsInFlight()
  const [discard, setDiscard] = useState(false)
  const orders = useConcessionOrders(useDebounced(orderSearch, 250))
  const items = useConcessionItems(orderNumber, useDebounced(itemSearch, 250))
  const machines = options.data?.machines.filter((m) => factories.includes(m.factory)) ?? []
  const dirty = !!(date !== initialDate || factories.length || machineIds.length || orderNumber || item || description || quantity || categoryId || concessionById || imageIds.length || newCategory?.trim())
  const busy = save.isPending || addCategory.isPending || uploading > 0
  useHoldUpdates(dirty || busy)
  useEffect(() => {
    if (!dirty && !busy) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty, busy])

  function close() {
    if (busy) return
    if (dirty) setDiscard(true)
    else onClose()
  }

  const ready = !!(date && factories.length && machineIds.length && orderNumber && item && description.trim() && quantity.trim() && categoryId && concessionById && imageIds.length <= 50)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!ready || busy || !item) return
    try {
      await save.mutateAsync({ submissionId, date, factories, machineIds, orderNumber, ...item, description, quantity, categoryId, concessionById, imageIds })
      toast('Concession saved.', 'success')
      onClose()
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not save.', 'error')
    }
  }

  async function createCategory() {
    if (!newCategory?.trim() || busy) return
    try {
      const category = await addCategory.mutateAsync(newCategory)
      setCategoryId(category.id)
      setNewCategory(null)
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not add the category.', 'error')
    }
  }

  return <>
    <Modal open onClose={close} title="New concession" size="lg" footer={<>
      <Button type="button" variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
      <Button type="submit" form="new-concession" variant="primary" disabled={!ready || busy || !options.data}>
        {busy && <Loader2 className="h-4 w-4 animate-spin" />}{uploading ? 'Uploading…' : save.isPending ? 'Saving…' : 'Save'}
      </Button>
    </>}>
      {options.isError ? <p role="alert" className="text-sm text-danger-600">Could not load choices. <button type="button" className="underline" onClick={() => void options.refetch()}>Retry</button></p> :
        !options.data ? <p className="text-sm text-muted">Loading…</p> : <form id="new-concession" onSubmit={(event) => void submit(event)}>
          <fieldset disabled={save.isPending || addCategory.isPending} className="grid min-w-0 gap-3 sm:grid-cols-2">
            <Field label="Date"><Input aria-label="Date" type="date" required value={date} onChange={(e) => setDate(e.target.value)} /></Field>
            <div><span className="label">Order no.</span>
              <SearchSelect ariaLabel="Order number" value={orderNumber ? { value: orderNumber, label: orderNumber } : null} options={(orders.data ?? []).map((o) => ({ value: o.orderNumber, label: o.orderNumber }))} search={orderSearch} onSearch={setOrderSearch} onPick={(picked) => { setOrderNumber(picked?.value ?? ''); setItem(null); setItemSearch('') }} placeholder="Select order" clearLabel="Clear" loading={orders.isFetching} />
              {orders.isError && <button type="button" className="text-xs text-danger-600 underline" onClick={() => void orders.refetch()}>Retry</button>}
            </div>
            <div><span className="label">Factory</span>
              <MultiSelectMenu ariaLabel="Factories" allLabel="Select factory" noun="factories" className="!min-h-11 !w-full !max-w-full !justify-between !text-sm" options={Array.from(new Set(options.data.machines.map((m) => m.factory).filter(Boolean))).sort().map((f) => ({ value: f, label: f }))} selected={factories} onChange={(next) => {
                setFactories(next)
                setMachineIds((ids) => ids.filter((id) => options.data!.machines.some((m) => m.id === id && next.includes(m.factory))))
              }} />
            </div>
            <div><span className="label">MC</span>
              <MultiSelectMenu ariaLabel="Machines" allLabel="Select MC" noun="machines" className="!min-h-11 !w-full !max-w-full !justify-between !text-sm" options={machines.map((m) => ({ value: m.id, label: m.displayName || m.code }))} selected={machineIds} onChange={setMachineIds} />
            </div>
            <div><span className="label">Item</span>
              <SearchSelect ariaLabel="Item" value={item ? { value: itemKey(item), label: item.item, sub: item.itemCode } : null} options={(items.data ?? []).map((i) => ({ value: itemKey(i), label: i.item, sub: i.itemCode }))} search={itemSearch} onSearch={setItemSearch} onPick={(picked) => setItem(items.data?.find((i) => itemKey(i) === picked?.value) ?? null)} placeholder="Select item" clearLabel="Clear" loading={items.isFetching} />
              {items.isError && <button type="button" className="text-xs text-danger-600 underline" onClick={() => void items.refetch()}>Retry</button>}
            </div>
            <Field label="QTY"><Input aria-label="QTY" required maxLength={200} value={quantity} onChange={(e) => setQuantity(e.target.value)} /></Field>
            <div><div className="mb-1 flex items-center justify-between"><span className="label !mb-0">Category</span><button type="button" aria-label="Add category" className="grid h-6 w-6 place-items-center rounded text-muted hover:text-brand-600" onClick={() => setNewCategory('')}><Plus className="h-4 w-4" /></button></div>
              <Select aria-label="Concession category" required value={categoryId} onChange={(e) => setCategoryId(e.target.value)}><option value="">Select category</option>{options.data.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
              {newCategory !== null && <div className="mt-2 flex items-center gap-1">
                <Input aria-label="New category name" maxLength={120} value={newCategory} onChange={(e) => setNewCategory(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void createCategory() } }} />
                <Button type="button" disabled={!newCategory.trim() || busy} onClick={() => void createCategory()}>Add</Button>
                <button type="button" aria-label="Cancel new category" className="icon-btn shrink-0" onClick={() => setNewCategory(null)}><X className="h-4 w-4" /></button>
              </div>}
            </div>
            <Field label="Concession BY"><Select aria-label="Concession BY" required value={concessionById} onChange={(e) => setConcessionById(e.target.value)}><option value="">Select name</option>{options.data.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
            <div className="sm:col-span-2"><Field label="Description"><textarea aria-label="Description" className="input min-h-20" dir="auto" required maxLength={4000} value={description} onChange={(e) => setDescription(e.target.value)} /></Field></div>
            <div className="sm:col-span-2"><span className="label">Images</span>
              <ImagePicker imageIds={imageIds} onChange={setImageIds} onUploading={onUploading} lockedReason={save.isPending ? 'Saving…' : undefined} />
              {imageIds.length > 50 && <p role="alert" className="mt-1 text-xs text-danger-600">Maximum 50 images.</p>}
            </div>
          </fieldset>
        </form>}
    </Modal>
    {discard && <Modal open onClose={() => setDiscard(false)} title="Discard changes?" size="sm" footer={<>
      <Button onClick={() => setDiscard(false)}>Keep editing</Button><Button variant="danger" onClick={onClose}>Discard</Button>
    </>}><p className="text-sm">Unsaved changes will be lost.</p></Modal>}
  </>
}
