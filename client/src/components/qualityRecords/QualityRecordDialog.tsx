import { useEffect, useState, type FormEvent } from 'react'
import { Loader2 } from 'lucide-react'
import { calendarDay } from '@qc/shared/rules'
import { emptyQualityData, QUALITY_FORMS, type QualityKind, type QualityRecord, type QualityRecordData } from '@qc/shared/qualityRecords'
import { Button, Modal } from '@/components/ui'
import { Segmented } from '@/components/ui/PageShell'
import { ImagePicker } from '@/components/inspection/ImagePicker'
import { useUploadsInFlight } from '@/components/inspection/imageUploads'
import { useHoldUpdates } from '@/lib/appUpdate'
import { useQualityOptions, useSaveQualityRecord } from '@/services/qualityRecords'
import { useAuth } from '@/store/AuthContext'
import { useApp } from '@/store/AppContext'
import { ComplaintFields, NcrFields, TextField } from './RecordFields'

export function QualityRecordDialog({ kind, record, onClose, onSaved }: { kind: QualityKind; record?: QualityRecord; onClose: () => void; onSaved: (record: QualityRecord) => void }) {
  const { profile, factoryTimeZone } = useAuth()
  const { toast } = useApp()
  const config = QUALITY_FORMS[kind]
  const options = useQualityOptions(kind)
  const save = useSaveQualityRecord(kind, record?.id)
  const [initial] = useState(() => ({ reference: record?.reference ?? '', date: record?.date ?? calendarDay(new Date(), factoryTimeZone), data: record?.data ?? emptyQualityData(kind, profile?.name ?? '', calendarDay(new Date(), factoryTimeZone)), imageIds: record?.imageIds ?? [] }))
  const [submissionId] = useState(() => crypto.randomUUID())
  const [reference, setReference] = useState(initial.reference)
  const [date, setDate] = useState(initial.date)
  const [data, setData] = useState<QualityRecordData>(initial.data)
  const [imageIds, setImageIds] = useState(initial.imageIds)
  const [tab, setTab] = useState(kind === 'ncr' ? 'report' : 'details')
  const [discard, setDiscard] = useState(false)
  const [uploading, onUploading] = useUploadsInFlight()
  const busy = save.isPending || uploading > 0
  const dirty = JSON.stringify({ reference, date, data, imageIds }) !== JSON.stringify(initial)
  useHoldUpdates(dirty || busy)
  useEffect(() => {
    if (!dirty && !busy) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty, busy])
  function close() { if (!busy) { if (dirty) setDiscard(true); else onClose() } }
  const valid = !!(date && data.description.trim() && imageIds.length <= 50 && (data.kind === 'ncr'
    ? data.raisedBy.trim() && data.sources.length && (!data.sources.includes('Product non-conformity') || (data.totalQuantity.trim() && data.rejectedQuantity.trim())) && (data.effectiveness === 'Pending' || data.effectivenessDate)
    : data.orderNumber && data.productName && data.issues.length))
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!valid || busy) return
    const cleaned = data.kind === 'ncr' ? { ...data, correctiveActions: data.correctiveActions.filter((a) => a.description.trim() || a.responsibility.trim() || a.completionDate) } : data
    try {
      const result = await save.mutateAsync({ submissionId, version: record?.version, reference, date, data: cleaned, imageIds })
      toast('Saved.', 'success')
      onSaved(result)
    } catch (error) { toast(error instanceof Error ? error.message : 'Could not save.', 'error') }
  }
  const lastTab = kind === 'ncr' ? 'follow-up' : 'complaint'
  return <>
    <Modal open title={`${record ? 'Edit' : 'New'} ${config.singular}`} size="xl" onClose={close} footer={<>
      <Button type="button" variant="ghost" disabled={busy} onClick={close}>Cancel</Button>
      <Button type="submit" form="quality-record" variant="primary" disabled={!valid || busy || !options.data}>{busy && <Loader2 className="h-4 w-4 animate-spin" />}{uploading ? 'Uploading…' : save.isPending ? 'Saving…' : 'Save'}</Button>
    </>}>
      {options.isError ? <p role="alert" className="text-sm text-danger-600">Could not load choices. <button type="button" className="underline" onClick={() => void options.refetch()}>Retry</button></p> : !options.data ? <p className="text-sm text-muted">Loading…</p> : <form id="quality-record" onSubmit={(event) => void submit(event)} className="space-y-4">
        <fieldset disabled={save.isPending} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2"><TextField label={kind === 'ncr' ? 'Date' : 'Date of complaint'} type="date" value={date} onChange={setDate} required /><TextField label={kind === 'ncr' ? 'Report no.' : 'Complaint serial no.'} maxLength={120} value={reference} onChange={setReference} /></div>
          <Segmented value={tab} onChange={setTab} label="Form sections" options={kind === 'ncr' ? [{ value: 'report', label: 'Report' }, { value: 'correction', label: 'Correction' }, { value: 'follow-up', label: 'Follow-up' }] : [{ value: 'details', label: 'Details' }, { value: 'complaint', label: 'Complaint' }]} />
          {data.kind === 'ncr' ? <NcrFields data={data} update={(patch) => setData((old) => old.kind === 'ncr' ? { ...old, ...patch } : old)} options={options.data} tab={tab} /> : <ComplaintFields data={data} update={(patch) => setData((old) => old.kind === 'customer-complaint' ? { ...old, ...patch } : old)} options={options.data} tab={tab} />}
          {tab === lastTab && <div><span className="label">Images</span><ImagePicker imageIds={imageIds} onChange={setImageIds} onUploading={onUploading} lockedReason={save.isPending ? 'Saving…' : undefined} />{imageIds.length > 50 && <p role="alert" className="text-xs text-danger-600">Maximum 50 images.</p>}</div>}
        </fieldset>
      </form>}
    </Modal>
    {discard && <Modal open title="Discard changes?" size="sm" onClose={() => setDiscard(false)} footer={<><Button onClick={() => setDiscard(false)}>Keep editing</Button><Button variant="danger" onClick={onClose}>Discard</Button></>}><p className="text-sm">Unsaved changes will be lost.</p></Modal>}
  </>
}
