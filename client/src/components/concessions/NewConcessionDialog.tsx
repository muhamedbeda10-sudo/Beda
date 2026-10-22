import { useEffect, useState, type FormEvent } from 'react'
import { Loader2, Plus } from 'lucide-react'
import type { ConcessionItem } from '@qc/shared/concessions'
import { calendarDay } from '@qc/shared/rules'
import { Button, Field, Input, Modal, Select } from '@/components/ui'
import { MultiSelectMenu, SearchSelect } from '@/components/dashboard/filters'
import { ImagePicker } from '@/components/inspection/ImagePicker'
import { useUploadsInFlight } from '@/components/inspection/imageUploads'
import { useHoldUpdates } from '@/lib/appUpdate'
import { useAddConcessionCategory, useConcessionCustomers, useConcessionItems, useConcessionOptions, useCreateConcession } from '@/services/concessions'
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
  const [customer, setCustomer] = useState('')
  const [customerSearch, setCustomerSearch] = useState('')
  const [item, setItem] = useState<ConcessionItem | null>(null)
  const [itemSearch, setItemSearch] = useState('')
  const [description, setDescription] = useState('')
  const [quantity, setQuantity] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [newCategory, setNewCategory] = useState<string | null>(null)
  const [concessionBy, setConcessionBy] = useState('')
  const [imageIds, setImageIds] = useState<string[]>([])
  const [uploading, onUploading] = useUploadsInFlight()
  const [discard, setDiscard] = useState(false)
  const customers = useConcessionCustomers(useDebounced(customerSearch, 250))
  const items = useConcessionItems(customer, useDebounced(itemSearch, 250))
  const machines = options.data?.machines.filter((m) => factories.includes(m.factory)) ?? []
  const dirty = !!(date !== initialDate || factories.length || machineIds.length || customer || item || description || quantity || categoryId || concessionBy || imageIds.length || newCategory?.trim())
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

  const ready = !!(date && factories.length && machineIds.length && customer && item && description.trim() && quantity.trim() && categoryId && concessionBy.trim() && imageIds.length <= 50)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!ready || busy || !item) return
    try {
      await save.mutateAsync({ submissionId, date, factories, machineIds, customer, ...item, description, quantity, categoryId, concessionBy, imageIds })
      toast('Concession saved.', 'success')
      onClose()
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not save the concession.', 'error')
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
    <Modal open onClose={close} title="New concession" size="xl" footer={<>
      <Button type="button" variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
      <Button type="submit" form="new-concession" variant="primary" disabled={!ready || busy || !options.data}>
        {busy && <Loader2 className="h-4 w-4 animate-spin" />}{uploading ? 'Uploading photos…' : save.isPending ? 'Saving…' : 'Save concession'}
      </Button>
    </>}>
      {options.isError ? <p role="alert" className="text-sm text-danger-600">Could not load the choices. <button type="button" className="underline" onClick={() => void options.refetch()}>Try again</button></p> :
        !options.data ? <p className="text-sm text-muted">Loading choices…</p> : <form id="new-concession" onSubmit={(event) => void submit(event)}>
          <fieldset disabled={save.isPending || addCategory.isPending} className="grid min-w-0 gap-4 sm:grid-cols-2">
            <Field label="Date"><Input type="date" required value={date} onChange={(e) => setDate(e.target.value)} /></Field>
            <div>
              <span className="label">Factory · select one or more</span>
              <MultiSelectMenu ariaLabel="Factories" allLabel="No factories selected" noun="factories" className="!max-w-full !text-sm" options={Array.from(new Set(options.data.machines.map((m) => m.factory).filter(Boolean))).sort().map((f) => ({ value: f, label: f }))} selected={factories} onChange={(next) => {
                setFactories(next)
                setMachineIds((ids) => ids.filter((id) => options.data!.machines.some((m) => m.id === id && next.includes(m.factory))))
              }} />
              {options.data.machines.every((m) => !m.factory) && <p className="mt-1 text-xs text-muted">Add factories to the machine register in Configuration first.</p>}
            </div>
            <div className="sm:col-span-2">
              <span className="label">MC · select one or more machines</span>
              {factories.length ? <MultiSelectMenu ariaLabel="Machines" allLabel="No machines selected" noun="machines" className="!max-w-full !text-sm" options={machines.map((m) => ({ value: m.id, label: m.displayName || m.code, sub: m.factory }))} selected={machineIds} onChange={setMachineIds} /> : <p className="text-sm text-muted">Choose the factories first.</p>}
              <p className="mt-1 text-xs text-muted">Select at least one machine from each chosen factory.</p>
            </div>
            <div>
              <span className="label">CUS · customer</span>
              <SearchSelect ariaLabel="Customer" value={customer ? { value: customer, label: customer } : null} options={(customers.data ?? []).map((c) => ({ value: c, label: c }))} search={customerSearch} onSearch={setCustomerSearch} onPick={(picked) => { setCustomer(picked?.value ?? ''); setItem(null); setItemSearch('') }} placeholder="Choose a customer" clearLabel="Clear customer" loading={customers.isFetching} />
              {customers.isError && <p role="alert" className="mt-1 text-xs text-danger-600">Could not load customers. <button type="button" className="underline" onClick={() => void customers.refetch()}>Retry</button></p>}
            </div>
            <div>
              <span className="label">Item · from CUS</span>
              {customer ? <SearchSelect ariaLabel="Item" value={item ? { value: itemKey(item), label: item.item, sub: item.itemCode } : null} options={(items.data ?? []).map((i) => ({ value: itemKey(i), label: i.item, sub: i.itemCode }))} search={itemSearch} onSearch={setItemSearch} onPick={(picked) => setItem(items.data?.find((i) => itemKey(i) === picked?.value) ?? null)} placeholder="Choose this customer’s item" clearLabel="Clear item" loading={items.isFetching} /> : <p className="py-3 text-sm text-muted">Choose the customer first.</p>}
              {items.isError && <p role="alert" className="mt-1 text-xs text-danger-600">Could not load items. <button type="button" className="underline" onClick={() => void items.refetch()}>Retry</button></p>}
            </div>
            {(customers.data?.length === 100 || items.data?.length === 100) && <p className="text-xs text-muted sm:col-span-2">Showing the first 100 matches. Search to find a customer or item.</p>}
            <div className="sm:col-span-2"><Field label="Description"><textarea className="input min-h-24" dir="auto" required maxLength={4000} value={description} onChange={(e) => setDescription(e.target.value)} /></Field></div>
            <Field label="QTY" hint="Number or text, for example 250 pcs or all stock."><Input required maxLength={200} value={quantity} onChange={(e) => setQuantity(e.target.value)} /></Field>
            <Field label="Concession BY" hint="The person or party granting the concession."><Input dir="auto" required maxLength={200} value={concessionBy} onChange={(e) => setConcessionBy(e.target.value)} /></Field>
            <div className="sm:col-span-2 space-y-2">
              <Field label="Category"><Select aria-label="Concession category" required value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">Choose a category</option>{options.data.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select></Field>
              {newCategory === null ? <Button type="button" variant="ghost" onClick={() => setNewCategory('')}><Plus className="h-4 w-4" />Add category</Button> : <div className="flex flex-wrap items-center gap-2">
                <Input aria-label="New category name" className="min-w-40 flex-1" maxLength={120} value={newCategory} onChange={(e) => setNewCategory(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void createCategory() } }} />
                <Button type="button" disabled={!newCategory.trim() || busy} onClick={() => void createCategory()}>Add</Button>
                <Button type="button" variant="ghost" onClick={() => setNewCategory(null)}>Cancel</Button>
              </div>}
            </div>
            <div className="sm:col-span-2">
              <span className="label">Image · email screenshots</span>
              <ImagePicker imageIds={imageIds} onChange={setImageIds} onUploading={onUploading} lockedReason={save.isPending ? 'Saving the concession…' : undefined} />
              <p className="mt-1 text-xs text-muted">Attach screenshots of the email. Up to 50 images.</p>
              {imageIds.length > 50 && <p role="alert" className="mt-1 text-xs text-danger-600">Remove {imageIds.length - 50} images before saving.</p>}
            </div>
          </fieldset>
        </form>}
    </Modal>
    {discard && <Modal open onClose={() => setDiscard(false)} title="Discard this concession?" size="sm" footer={<>
      <Button onClick={() => setDiscard(false)}>Keep editing</Button><Button variant="danger" onClick={onClose}>Discard</Button>
    </>}><p className="text-sm">The details and attached photos have not been saved to the register.</p></Modal>}
  </>
}
