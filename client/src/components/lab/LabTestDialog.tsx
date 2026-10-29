// ============================================================================
// §26 — Recording a test: the report filled in place, then its row of the
// machine log (the supplier's certificate and its results, CUS No., who
// tested). A sheet's specimen code is its coil number: what the coil
// register knows of it fills what is still empty (grade, thickness,
// supplier, the certificate's yield), and its earlier tests are named.
// ============================================================================

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Loader2 } from 'lucide-react'
import { calendarDay } from '@qc/shared/rules'
import { LAB_VERDICT_NAMES, SPECIMEN_INFO, emptyLabTest, variance, type LabCoilLookup, type LabListValue, type LabOptions, type LabTest } from '@qc/shared/lab'
import { Badge, Button, Modal } from '@/components/ui'
import { ImagePicker } from '@/components/inspection/ImagePicker'
import { useUploadsInFlight } from '@/components/inspection/imageUploads'
import { useHoldUpdates } from '@/lib/appUpdate'
import { parseDecimal } from '@/lib/decimal'
import { useDebounced } from '@/services/queries'
import { useLabCoil, useLabOptions, useSaveLabTest } from '@/services/lab'
import { useAuth } from '@/store/AuthContext'
import { useApp } from '@/store/AppContext'
import { cn } from '@/lib/utils'
import { LabSheet } from './LabSheet'
import { draftProblems, fromDraft, toDraft, workDraft, type LabDraft } from './labDraft'

export const verdictTone = (r: LabTest['result']) => (r === 'pass' ? 'green' : r === 'fail' ? 'red' : 'neutral') as 'green' | 'red' | 'neutral'

/** A list's value for a number: "2.4 mm" for 2.4 when the list has it, else the number in mm. */
function sizeFor(thickness: number | null, values: LabListValue[]): string {
  if (thickness === null) return ''
  return values.find((v) => parseDecimal(v.value.replace(/[^\d.,]/g, '')) === thickness)?.value ?? `${thickness} mm`
}

/** What the coil register says of the specimen code, and the lab's earlier tests of it. */
export function CoilNote({ lookup, loading }: { lookup: LabCoilLookup | undefined; loading?: boolean }) {
  if (loading) return <p className="text-xs text-muted">Looking in the coil register…</p>
  if (!lookup) return null
  const c = lookup.coil
  return <div className="space-y-0.5 text-xs">
    {c ? <p className="text-success-700 dark:text-success-400">In the coil register: {[c.grade, c.thickness !== null ? `${c.thickness} mm` : '', c.supplier, c.yield !== null ? `MTC yield ${c.yield}` : ''].filter(Boolean).join(' · ')}</p>
      : <p className="text-muted">Not in the coil register.</p>}
    {lookup.tests.length > 0 && <p className="text-muted">Tested before: {lookup.tests.slice(0, 5).map((t) => `${t.reference} (${LAB_VERDICT_NAMES[t.result]})`).join(', ')}</p>}
  </div>
}

/** The machine log's own columns: the supplier's certificate and its results against ours. */
export function LogFields({ draft, set, averages, readOnly }: { draft: LabDraft; set?: (p: Partial<LabDraft>) => void; averages: { tensile: number | null; yield: number | null; elongation: number | null }; readOnly?: boolean }) {
  const text = (key: 'supplier' | 'certificate' | 'cusNo' | 'testedBy', label: string, max: number) => <label className="block">
    <span className="label">{label}</span>
    {readOnly ? <span dir="auto" className="block min-h-6 text-sm">{draft[key] || '—'}</span> : <input dir="auto" className="input" maxLength={max} value={draft[key]} onChange={(e) => set?.({ [key]: e.target.value })} />}
  </label>
  const mtc = (key: 'mtcTensile' | 'mtcYield' | 'mtcElongation', label: string, ours: number | null) => {
    const diff = variance(ours, parseDecimal(draft[key]))
    return <label className="block">
      <span className="label">{label}</span>
      {readOnly ? <span className="block min-h-6 text-sm tabular-nums">{draft[key] || '—'}</span> : <input inputMode="decimal" className="input tabular-nums" value={draft[key]} onChange={(e) => set?.({ [key]: e.target.value })} />}
      <span className={cn('mt-1 block text-xs tabular-nums', diff === null ? 'text-muted' : diff < 0 ? 'text-danger-700 dark:text-danger-400' : 'text-success-700 dark:text-success-400')}>
        {diff === null ? 'Variance —' : `Variance ${diff > 0 ? '+' : ''}${diff}`}
      </span>
    </label>
  }
  return <section className="space-y-3 rounded-xl border border-slate-200 p-3 dark:border-slate-700" aria-labelledby="lab-log-heading">
    <h3 id="lab-log-heading" className="text-sm font-semibold">Machine log</h3>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {text('supplier', 'Supplier', 200)}
      {text('certificate', 'Supplier certificate (MTC)', 200)}
      {text('cusNo', 'CUS No.', 120)}
      {text('testedBy', 'Tested by', 200)}
    </div>
    <div className="grid gap-3 sm:grid-cols-3">
      {mtc('mtcTensile', 'MTC Rm (N/mm²)', averages.tensile)}
      {mtc('mtcYield', 'MTC ReH (N/mm²)', averages.yield)}
      {mtc('mtcElongation', 'MTC A (%)', averages.elongation)}
    </div>
    <label className="block">
      <span className="label">Notes</span>
      {readOnly ? <span dir="auto" className="block whitespace-pre-wrap text-sm">{draft.notes || '—'}</span> : <textarea dir="auto" rows={2} maxLength={4000} className="input" value={draft.notes} onChange={(e) => set?.({ notes: e.target.value })} />}
    </label>
  </section>
}

export function LabTestDialog({ test, onClose, onSaved }: { test?: LabTest; onClose: () => void; onSaved: (t: LabTest) => void }) {
  const { profile, factoryTimeZone } = useAuth()
  const { toast } = useApp()
  const options = useLabOptions()
  const save = useSaveLabTest(test?.id)
  const [initial] = useState<LabDraft>(() => toDraft(test ?? emptyLabTest(calendarDay(new Date(), factoryTimeZone), profile?.name ?? '')))
  const [draft, setDraft] = useState<LabDraft>(initial)
  const [submissionId] = useState(() => crypto.randomUUID())
  const [discard, setDiscard] = useState(false)
  const [uploading, onUploading] = useUploadsInFlight()
  const set = (patch: Partial<LabDraft>) => setDraft((d) => ({ ...d, ...patch }))
  const busy = save.isPending || uploading > 0
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial)
  useHoldUpdates(dirty || busy)
  useEffect(() => {
    if (!dirty && !busy) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty, busy])

  // The first testing machine, once its list has come, for a new report.
  const machines = useMemo(() => (options.data?.lists ?? []).filter((l) => l.list === 'machine'), [options.data])
  useEffect(() => { if (!test && machines.length && !draft.machine) setDraft((d) => (d.machine ? d : { ...d, machine: machines[0].value })) }, [machines, test, draft.machine])

  // A sheet's coil: what the register knows fills what is still empty.
  const code = useDebounced(draft.specimenCode.trim(), 400)
  const isSheet = SPECIMEN_INFO[draft.specimenType].family === 'sheet'
  const coil = useLabCoil(code, !!code)
  // Filled once per coil, and never from the code a saved test was opened with: what is on the test, or changed
  // afterwards, stays the person's.
  const filledFrom = useRef<string | null>(test ? test.specimenCode.trim().toLowerCase() : null)
  useEffect(() => {
    const c = coil.data?.coil
    if (!c || !isSheet || filledFrom.current === c.coilNumber.toLowerCase() || !options.data) return
    filledFrom.current = c.coilNumber.toLowerCase()
    setDraft((d) => ({
      ...d,
      grade: d.grade || c.grade,
      size: d.size || sizeFor(c.thickness, options.data!.lists.filter((l) => l.list === 'sheet-thickness')),
      supplier: d.supplier || c.supplier,
      mtcYield: d.mtcYield || (c.yield !== null ? String(c.yield) : ''),
    }))
  }, [coil.data, isSheet, options.data])

  const data = fromDraft(draft)
  const working = options.data ? workDraft(data, options.data) : null
  const problems = draftProblems(draft)
  const valid = !!draft.testDate && problems.length === 0 && (draft.specimenCode.trim() || draft.grade.trim())

  function close() { if (!busy) { if (dirty) setDiscard(true); else onClose() } }
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!valid || busy) return
    try {
      const saved = await save.mutateAsync({ ...data, submissionId, version: test?.version })
      toast(`Saved as ${saved.reference}.`, 'success')
      onSaved(saved)
    } catch (error) { toast(error instanceof Error ? error.message : 'Could not save.', 'error') }
  }

  return <>
    <Modal open size="xl" title={test ? `Edit test ${test.reference}` : 'New material test'} onClose={close} footer={<>
      {working && <span className="mr-auto flex items-center gap-2 text-xs text-muted">Result <Badge tone={verdictTone(working.judgement.result)}>{LAB_VERDICT_NAMES[working.judgement.result]}</Badge></span>}
      <Button type="button" variant="ghost" disabled={busy} onClick={close}>Cancel</Button>
      <Button type="submit" form="lab-test" variant="primary" disabled={!valid || busy || !options.data}>{busy && <Loader2 className="h-4 w-4 animate-spin" />}{uploading ? 'Uploading…' : save.isPending ? 'Saving…' : 'Save'}</Button>
    </>}>
      {options.isError ? <p role="alert" className="text-sm text-danger-600">Could not load the lab’s lists. <button type="button" className="underline" onClick={() => void options.refetch()}>Retry</button></p>
        : !options.data || !working ? <p className="flex items-center gap-2 text-sm text-muted"><Loader2 className="h-4 w-4 animate-spin" />Loading…</p>
        : <form id="lab-test" onSubmit={(event) => void submit(event)} className="space-y-4">
          <fieldset disabled={save.isPending} className="space-y-4">
            <LabSheet mode="edit" data={draft} working={working} onChange={set} lists={options.data.lists} grades={options.data.grades} nextReference={test ? undefined : options.data.nextReference}
              codeNote={code ? <CoilNote lookup={coil.data} loading={coil.isFetching && !coil.data} /> : null}
              imagePicker={<div><span className="label">Stress–elongation curve (a photo or screenshot of the machine’s graph)</span><ImagePicker imageIds={draft.imageIds} onChange={(edit) => setDraft((d) => ({ ...d, imageIds: edit(d.imageIds) }))} onUploading={onUploading} lockedReason={save.isPending ? 'Saving…' : undefined} /></div>} />
            {problems.length > 0 && <p role="alert" className="text-sm text-danger-600">Not a number: {problems.join(', ')}.</p>}
            <LogFields draft={draft} set={set} averages={{ tensile: working.judgement.tensileAvg, yield: working.judgement.yieldAvg, elongation: working.judgement.elongationAvg }} />
          </fieldset>
        </form>}
    </Modal>
    {discard && <Modal open size="sm" title="Discard changes?" onClose={() => setDiscard(false)} footer={<><Button onClick={() => setDiscard(false)}>Keep editing</Button><Button variant="danger" onClick={onClose}>Discard</Button></>}>
      <p className="text-sm">What was entered on this report is not saved.</p>
    </Modal>}
  </>
}
