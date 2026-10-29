import { useEffect, useState, type FormEvent } from 'react'
import { Loader2, Plus, X } from 'lucide-react'
import { MAX_SCRAP_WEIGHT_KG, type ScrapRecord } from '@qc/shared/scrap'
import { calendarDay } from '@qc/shared/rules'
import { Button, Field, Input, Modal, Select } from '@/components/ui'
import { ImagePicker } from '@/components/inspection/ImagePicker'
import { useUploadsInFlight } from '@/components/inspection/imageUploads'
import { useHoldUpdates } from '@/lib/appUpdate'
import { useAddScrapType, useCreateScrap, useScrapOptions, useUpdateScrap } from '@/services/scrap'
import { useAuth } from '@/store/AuthContext'
import { useApp } from '@/store/AppContext'

/** The weight as typed: a number above 0 (a comma reads as a decimal point), else null. */
export function parseWeight(text: string): number | null {
  const value = Number(text.trim().replace(',', '.'))
  if (!text.trim() || !Number.isFinite(value) || value <= 0 || value > MAX_SCRAP_WEIGHT_KG) return null
  const rounded = Math.round(value * 1000) / 1000
  return rounded > 0 ? rounded : null
}

/**
 * Records scrap (from Inspections) or corrects a record (from History). The weight and both photos, the scrap card
 * and the scrap box, are required; Save says what is still missing.
 */
export function ScrapDialog({ record, onClose, onSaved }: { record?: ScrapRecord; onClose: () => void; onSaved?: (record: ScrapRecord) => void }) {
  const { factoryTimeZone, profile, can } = useAuth()
  const { toast } = useApp()
  const options = useScrapOptions()
  const create = useCreateScrap()
  const update = useUpdateScrap()
  const addType = useAddScrapType()
  const [submissionId] = useState(() => crypto.randomUUID())
  const [initial] = useState(() => ({
    date: record?.date ?? calendarDay(new Date(), factoryTimeZone),
    factory: record?.factory ?? '',
    machineId: record?.machineId ?? '',
    scrapTypeId: record?.scrapTypeId ?? '',
    weight: record ? String(record.weightKg) : '',
    responsiblePerson: record?.responsiblePerson ?? '',
    inspectorId: record?.inspectorId ?? '',
    card: record ? [record.cardImageId] : [],
    box: record ? [record.boxImageId] : [],
  }))
  const [date, setDate] = useState(initial.date)
  const [factory, setFactory] = useState(initial.factory)
  const [machineId, setMachineId] = useState(initial.machineId)
  const [scrapTypeId, setScrapTypeId] = useState(initial.scrapTypeId)
  const [weight, setWeight] = useState(initial.weight)
  const [responsiblePerson, setResponsiblePerson] = useState(initial.responsiblePerson)
  const [inspectorId, setInspectorId] = useState(initial.inspectorId)
  const [card, setCard] = useState<string[]>(initial.card)
  const [box, setBox] = useState<string[]>(initial.box)
  const [newType, setNewType] = useState<string | null>(null)
  const [showAllInspectors, setShowAllInspectors] = useState(false)
  const [uploading, onUploading] = useUploadsInFlight()
  const [discard, setDiscard] = useState(false)

  // The person recording is the inspector unless they choose another, once the list says they may be named.
  useEffect(() => {
    if (record || inspectorId || !options.data || !profile) return
    if (options.data.inspectors.some((p) => p.id === profile.id)) setInspectorId(profile.id)
  }, [record, inspectorId, options.data, profile])

  const saving = create.isPending || update.isPending
  const busy = saving || addType.isPending || uploading > 0
  const weightKg = parseWeight(weight)
  const dirty = date !== initial.date || factory !== initial.factory || machineId !== initial.machineId || scrapTypeId !== initial.scrapTypeId ||
    weight !== initial.weight || responsiblePerson !== initial.responsiblePerson || (inspectorId !== initial.inspectorId && !!initial.inspectorId) ||
    card.join() !== initial.card.join() || box.join() !== initial.box.join() || !!newType?.trim()
  useHoldUpdates(dirty || busy)
  useEffect(() => {
    if (!dirty && !busy) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty, busy])

  const data = options.data
  // A record keeps its factory and machine as recorded, even after the machine moved or was retired.
  const factories = data ? Array.from(new Set([...data.machines.map((m) => m.factory), ...(record ? [record.factory] : [])])).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) : []
  const machines = data ? data.machines.filter((m) => m.factory === factory) : []
  const keepsRecorded = !!record && factory === record.factory && !machines.some((m) => m.id === record.machineId)
  const everyone = data ? [...data.inspectors, ...(record && !data.inspectors.some((p) => p.id === record.inspectorId) ? [{ id: record.inspectorId, name: record.inspectorName }] : [])] : []
  // With a factory chosen, its own inspectors (by their recent work there); everyone on request, or when nobody has
  // worked there yet. The person already chosen always stays in the list.
  const ofFactory = factory ? everyone.filter((p) => p.factories?.includes(factory) || p.id === inspectorId) : everyone
  const filtering = !!factory && !showAllInspectors && ofFactory.some((p) => p.factories?.includes(factory))
  const inspectors = filtering ? ofFactory : everyone

  const missing = [
    !date && 'date', !factory && 'factory', !machineId && 'work center', !scrapTypeId && 'scrap type',
    weightKg === null && 'weight', !inspectorId && 'quality inspector', card.length !== 1 && 'scrap card photo', box.length !== 1 && 'scrap box photo',
  ].filter((v): v is string => !!v)
  const ready = missing.length === 0

  function close() {
    if (busy) return
    if (dirty) setDiscard(true)
    else onClose()
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!ready || busy || weightKg === null) return
    const fields = { date, factory, machineId, scrapTypeId, weightKg, responsiblePerson: responsiblePerson.trim(), inspectorId, cardImageId: card[0], boxImageId: box[0] }
    try {
      const saved = record ? await update.mutateAsync({ id: record.id, version: record.version, ...fields }) : await create.mutateAsync({ submissionId, ...fields })
      toast(record ? 'Scrap record corrected.' : 'Scrap saved. It is in History, under Scrap.', 'success')
      onSaved?.(saved)
      onClose()
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not save.', 'error')
    }
  }

  async function createType() {
    if (!newType?.trim() || busy) return
    try {
      const type = await addType.mutateAsync(newType)
      setScrapTypeId(type.id)
      setNewType(null)
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not add the scrap type.', 'error')
    }
  }

  const lock = saving ? 'Saving…' : undefined
  return <>
    <Modal open onClose={close} title={record ? 'Correct scrap' : 'New scrap'} size="lg" footer={<>
      <Button type="button" variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
      <Button type="submit" form="scrap-form" variant="primary" disabled={!ready || busy || !data}>
        {busy && <Loader2 className="h-4 w-4 animate-spin" />}{uploading ? 'Uploading…' : saving ? 'Saving…' : 'Save'}
      </Button>
    </>}>
      {options.isError ? <p role="alert" className="text-sm text-danger-600">Could not load choices. <button type="button" className="underline" onClick={() => void options.refetch()}>Retry</button></p> :
        !data ? <p className="flex items-center gap-2 text-sm text-muted"><Loader2 className="h-4 w-4 animate-spin" />Loading…</p> : <form id="scrap-form" onSubmit={(event) => void submit(event)}>
          <fieldset disabled={saving || addType.isPending} className="grid min-w-0 gap-3 sm:grid-cols-2">
            <Field label="Date"><Input aria-label="Date" type="date" required value={date} onChange={(e) => setDate(e.target.value)} /></Field>
            <Field label="Factory"><Select aria-label="Factory" required value={factory} onChange={(e) => { setFactory(e.target.value); setShowAllInspectors(false); setMachineId(record && e.target.value === record.factory ? record.machineId : '') }}>
              <option value="">Select factory</option>{factories.map((f) => <option key={f}>{f}</option>)}
            </Select></Field>
            <div className="sm:col-span-2"><Field label="Work center"><Select aria-label="Work center" required value={machineId} disabled={!factory} onChange={(e) => setMachineId(e.target.value)}>
              <option value="">{factory ? 'Select work center' : 'Select the factory first'}</option>
              {keepsRecorded && <option value={record.machineId}>{record.machineName} (as recorded)</option>}
              {machines.map((m) => <option key={m.id} value={m.id}>{m.displayName || m.code}</option>)}
            </Select></Field></div>
            <div><div className="mb-1 flex items-center justify-between"><span className="label !mb-0">Scrap type</span>{can('record-scrap') && <button type="button" aria-label="Add scrap type" className="grid h-6 w-6 place-items-center rounded text-muted hover:text-brand-600" onClick={() => setNewType('')}><Plus className="h-4 w-4" /></button>}</div>
              <Select aria-label="Scrap type" required value={scrapTypeId} onChange={(e) => setScrapTypeId(e.target.value)}><option value="">Select type</option>{data.types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>
              {newType !== null && <div className="mt-2 flex items-center gap-1">
                <Input aria-label="New scrap type" maxLength={120} value={newType} onChange={(e) => setNewType(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void createType() } }} />
                <Button type="button" disabled={!newType.trim() || busy} onClick={() => void createType()}>Add</Button>
                <button type="button" aria-label="Cancel new scrap type" className="icon-btn shrink-0" onClick={() => setNewType(null)}><X className="h-4 w-4" /></button>
              </div>}
            </div>
            <Field label="Weight (kg)"><Input aria-label="Weight in kilograms" required inputMode="decimal" type="text" placeholder="0" value={weight} onChange={(e) => setWeight(e.target.value)} aria-invalid={!!weight.trim() && weightKg === null} />
              {!!weight.trim() && weightKg === null && <span role="alert" className="mt-1 block text-xs text-danger-600">Enter a weight above 0 kg.</span>}
            </Field>
            <Field label="Responsible person (optional)"><Input aria-label="Responsible person" dir="auto" maxLength={200} list="scrap-responsible" value={responsiblePerson} onChange={(e) => setResponsiblePerson(e.target.value)} />
              <datalist id="scrap-responsible">{data.responsiblePeople.map((p) => <option key={p} value={p} />)}</datalist>
            </Field>
            <div><Field label="Quality inspector"><Select aria-label="Quality inspector" required value={inspectorId} onChange={(e) => setInspectorId(e.target.value)}><option value="">Select name</option>{inspectors.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
              {factory && (filtering || showAllInspectors) && <button type="button" className="mt-1 min-h-8 text-xs text-brand-700 underline dark:text-brand-300" onClick={() => setShowAllInspectors((v) => !v)}>
                {showAllInspectors ? `Only ${factory}’s inspectors` : 'Show everyone'}
              </button>}
            </div>
            <div><span className="label">Scrap card photo</span>
              <ImagePicker imageIds={card} onChange={(edit) => setCard((ids) => edit(ids).slice(-1))} onUploading={onUploading} lockedReason={lock} max={1} addLabel="scrap card photo" />
            </div>
            <div><span className="label">Scrap box photo</span>
              <ImagePicker imageIds={box} onChange={(edit) => setBox((ids) => edit(ids).slice(-1))} onUploading={onUploading} lockedReason={lock} max={1} addLabel="scrap box photo" />
            </div>
            <p className="text-xs text-muted sm:col-span-2" aria-live="polite">{ready ? 'Ready to save.' : `Still needed: ${missing.join(', ')}.`}</p>
          </fieldset>
        </form>}
    </Modal>
    {discard && <Modal open onClose={() => setDiscard(false)} title="Discard changes?" size="sm" footer={<>
      <Button onClick={() => setDiscard(false)}>Keep editing</Button><Button variant="danger" onClick={onClose}>Discard</Button>
    </>}><p className="text-sm">Unsaved changes will be lost.</p></Modal>}
  </>
}
