// ============================================================================
// §27 — Recording a calibration: the certificate's number and day, the
// interval to the next (worked out as it is typed), the reference it was
// checked against and the readings at each nominal value — started from the
// category's template, each error and its verdict worked out at once — or,
// for an external calibration, the laboratory and its certificate's PDF.
// Saving it moves the instrument on: its last calibration becomes this one.
// ============================================================================

import { useRef, useState, type FormEvent } from 'react'
import { FileUp, Loader2, Plus, Trash2, X } from 'lucide-react'
import {
  CALIBRATION_KINDS, CALIBRATION_KIND_NAMES, CERTIFICATE_RESULT_NAMES, EMPTY_REFERENCE, INTERVAL_PRESETS, MAX_GROUPS, MAX_INTERVAL_MONTHS, MAX_READINGS,
  groupsFromTemplate, judgeCertificate, nextDueOn, readingError, readingOk,
  type CalibrationCertificate, type CalibrationCertificateData, type CalibrationItem, type CalibrationKind, type CalibrationOptions, type CalibrationReference,
} from '@qc/shared/calibration'
import { Button, Modal } from '@/components/ui'
import { Segmented } from '@/components/ui/PageShell'
import { useHoldUpdates } from '@/lib/appUpdate'
import { cn } from '@/lib/utils'
import { uploadCalibrationFile, useSaveCalibrationCertificate } from '@/services/calibration'
import { useAuth } from '@/store/AuthContext'
import { useApp } from '@/store/AppContext'
import { calDay, numberText, parseNumber, RESULT_TONE } from './common'

interface RowDraft { nominal: string; reading: string }
interface GroupDraft { name: string; readings: RowDraft[] }
interface Draft {
  certificateNo: string
  kind: CalibrationKind
  calibratedOn: string
  intervalMonths: string
  body: string
  performedBy: string
  approvedBy: string
  resolution: string
  tolerance: string
  unit: string
  reference: CalibrationReference
  groups: GroupDraft[]
  fileId: string | null
  fileName: string | null
  notes: string
}

const groupsDraft = (groups: CalibrationCertificate['groups']): GroupDraft[] =>
  groups.map((g) => ({ name: g.name, readings: g.readings.map((r) => ({ nominal: numberText(r.nominal), reading: numberText(r.reading) })) }))

function initialDraft(item: CalibrationItem, options: CalibrationOptions, today: string, me: string, cert?: CalibrationCertificate, previous?: CalibrationCertificate): Draft {
  if (cert) {
    return {
      certificateNo: cert.certificateNo, kind: cert.kind, calibratedOn: cert.calibratedOn, intervalMonths: String(cert.intervalMonths), body: cert.body, performedBy: cert.performedBy,
      approvedBy: cert.approvedBy, resolution: cert.resolution, tolerance: numberText(cert.tolerance), unit: cert.unit, reference: { ...EMPTY_REFERENCE, ...cert.reference },
      groups: groupsDraft(cert.groups), fileId: cert.fileId, fileName: cert.fileName, notes: cert.notes,
    }
  }
  // A new certificate starts from the category's template, or the last certificate's nominal values and reference.
  const category = options.categories.find((c) => c.id === item.categoryId)
  const template = category?.template.length ? groupsFromTemplate(category.template)
    : previous ? previous.groups.map((g) => ({ name: g.name, readings: g.readings.map((r) => ({ nominal: r.nominal, reading: null })) })) : []
  const reference = previous && Object.values(previous.reference).some(Boolean) ? previous.reference : category?.reference ?? EMPTY_REFERENCE
  return {
    certificateNo: '', kind: item.kind, calibratedOn: today, intervalMonths: String(item.intervalMonths), body: item.kind === 'external' ? previous?.body ?? '' : '',
    performedBy: item.kind === 'internal' ? me : '', approvedBy: previous?.approvedBy ?? '', resolution: item.resolution, tolerance: numberText(item.tolerance), unit: item.unit,
    reference: { ...EMPTY_REFERENCE, ...reference }, groups: groupsDraft(template), fileId: null, fileName: null, notes: '',
  }
}

export function CertificateDialog({ item, options, cert, previous, onClose, onSaved }: {
  item: CalibrationItem
  options: CalibrationOptions
  cert?: CalibrationCertificate
  /** The instrument's latest certificate, for a new one to start from. */
  previous?: CalibrationCertificate
  onClose: () => void
  onSaved: (c: CalibrationCertificate) => void
}) {
  const { profile } = useAuth()
  const { toast } = useApp()
  const save = useSaveCalibrationCertificate(cert?.id)
  const [initial] = useState(() => initialDraft(item, options, options.today, profile?.name ?? '', cert, previous))
  const [d, setDraft] = useState<Draft>(initial)
  const [submissionId] = useState(() => crypto.randomUUID())
  const [uploading, setUploading] = useState(false)
  const [discard, setDiscard] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const set = (patch: Partial<Draft>) => setDraft((x) => ({ ...x, ...patch }))
  const setRef = (patch: Partial<CalibrationReference>) => setDraft((x) => ({ ...x, reference: { ...x.reference, ...patch } }))
  const setGroups = (edit: (g: GroupDraft[]) => GroupDraft[]) => setDraft((x) => ({ ...x, groups: edit(x.groups) }))
  const busy = save.isPending || uploading
  const dirty = JSON.stringify(d) !== JSON.stringify(initial)
  useHoldUpdates(dirty || busy)

  const months = Number(d.intervalMonths)
  const monthsOk = Number.isInteger(months) && months >= 1 && months <= MAX_INTERVAL_MONTHS
  const tolerance = parseNumber(d.tolerance)
  const groups = d.groups.map((g) => ({ name: g.name.trim(), readings: g.readings.map((r) => ({ nominal: parseNumber(r.nominal), reading: parseNumber(r.reading) })) }))
  const badNumbers = groups.some((g) => g.readings.some((r) => r.nominal === undefined || r.reading === undefined)) || tolerance === undefined
  const clean = groups.map((g) => ({ name: g.name, readings: g.readings.map((r) => ({ nominal: r.nominal ?? null, reading: r.reading ?? null })) }))
  const judgement = judgeCertificate(clean.map((g) => ({ ...g, readings: g.readings.filter((r) => r.nominal !== null || r.reading !== null) })), tolerance ?? null)
  const next = nextDueOn(d.calibratedOn, monthsOk ? months : null)
  const preset = INTERVAL_PRESETS.some((p) => p.months === months)
  const problems = [
    !d.calibratedOn && 'the calibration day',
    d.calibratedOn > options.today && 'a calibration day not still to come',
    !monthsOk && `an interval of 1 to ${MAX_INTERVAL_MONTHS} months`,
    badNumbers && 'numbers in the readings and tolerance',
  ].filter(Boolean) as string[]

  async function pickFile(file: File | undefined) {
    if (!file) return
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') { toast('Attach the laboratory’s certificate as a PDF.', 'error'); return }
    setUploading(true)
    try {
      const f = await uploadCalibrationFile(file)
      set({ fileId: f.id, fileName: f.fileName })
    } catch (error) { toast(error instanceof Error ? error.message : 'The PDF could not be uploaded.', 'error') }
    finally { setUploading(false); if (fileInput.current) fileInput.current.value = '' }
  }

  function close() { if (!busy) { if (dirty) setDiscard(true); else onClose() } }
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (problems.length || busy) return
    const data: CalibrationCertificateData = {
      itemId: item.id, certificateNo: d.certificateNo.trim(), kind: d.kind, calibratedOn: d.calibratedOn, intervalMonths: months, body: d.body.trim(), performedBy: d.performedBy.trim(),
      approvedBy: d.approvedBy.trim(), resolution: d.resolution.trim(), tolerance: tolerance ?? null, unit: d.unit.trim(), reference: d.reference, groups: clean, fileId: d.fileId,
      notes: d.notes.trim(),
    }
    try {
      const saved = await save.mutateAsync(cert ? { ...data, version: cert.version } : { ...data, submissionId })
      toast(`Certificate ${saved.certificateNo || ''} saved; next calibration ${calDay(saved.nextDueOn)}.`.replace('  ', ' '), 'success')
      onSaved(saved)
    } catch (error) { toast(error instanceof Error ? error.message : 'Could not save.', 'error') }
  }

  const input = (value: string, onChange: (v: string) => void, label: string, max: number, extra?: { dir?: 'ltr' | 'auto'; placeholder?: string }) => <label className="block">
    <span className="label">{label}</span>
    <input dir={extra?.dir ?? 'auto'} className="input" maxLength={max} value={value} placeholder={extra?.placeholder} onChange={(e) => onChange(e.target.value)} />
  </label>

  return <>
    <Modal open size="xl" title={cert ? `Edit certificate ${cert.certificateNo}` : `New certificate · ${item.calibrationCode || item.name}`} onClose={close} footer={<>
      <span className="mr-auto flex flex-wrap items-center gap-2 text-xs text-muted">
        {problems.length > 0 ? <span className="text-danger-600 dark:text-danger-400">Needs {problems.join(', ')}.</span>
          : <>Result <span className={cn('rounded-md px-2 py-0.5 font-semibold', RESULT_TONE[judgement.result] === 'red' ? 'bg-danger-50 text-danger-700 dark:bg-danger-500/10 dark:text-danger-400' : RESULT_TONE[judgement.result] === 'green' ? 'bg-success-50 text-success-700 dark:bg-success-500/10 dark:text-success-400' : 'bg-slate-100 dark:bg-slate-800')}>{CERTIFICATE_RESULT_NAMES[judgement.result]}</span></>}
      </span>
      <Button type="button" variant="ghost" disabled={busy} onClick={close}>Cancel</Button>
      <Button type="submit" form="calibration-certificate" variant="primary" disabled={problems.length > 0 || busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />}{uploading ? 'Uploading…' : 'Save'}</Button>
    </>}>
      <form id="calibration-certificate" onSubmit={(e) => void submit(e)} className="space-y-5">
        <fieldset disabled={save.isPending} className="space-y-5">
          <p className="text-sm text-muted"><span dir="auto" className="font-semibold text-slate-800 dark:text-slate-100">{item.name}</span>{item.deviceCode ? ` · ${item.deviceCode}` : ''}{item.departmentName ? ` · ${item.departmentName}` : ''}{item.holder ? ` · ${item.holder}` : ''}</p>
          <section className="space-y-3" aria-labelledby="cert-main">
            <h3 id="cert-main" className="text-sm font-semibold">Certificate</h3>
            <Segmented label="Calibration kind" value={d.kind} onChange={(kind) => set({ kind })} options={CALIBRATION_KINDS.map((k) => ({ value: k, label: CALIBRATION_KIND_NAMES[k] }))} />
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {input(d.certificateNo, (certificateNo) => set({ certificateNo }), 'Certificate No', 120, { dir: 'ltr', placeholder: d.kind === 'external' ? 'The laboratory’s number' : item.calibrationCode || 'V.01.QC.01' })}
              <label className="block"><span className="label">Calibration date</span><input type="date" required className="input" max={options.today} value={d.calibratedOn} onChange={(e) => set({ calibratedOn: e.target.value })} /></label>
              <label className="block">
                <span className="label">Interval</span>
                <select className="input" value={preset ? d.intervalMonths : 'custom'} onChange={(e) => set({ intervalMonths: e.target.value === 'custom' ? '' : e.target.value })}>
                  {INTERVAL_PRESETS.map((p) => <option key={p.months} value={p.months}>{p.label}</option>)}
                  <option value="custom">{preset ? 'Other…' : `${d.intervalMonths} months`}</option>
                </select>
                {!preset && <input type="number" min={1} max={MAX_INTERVAL_MONTHS} aria-label="Months" className="input mt-1 tabular-nums" value={d.intervalMonths} onChange={(e) => set({ intervalMonths: e.target.value })} />}
              </label>
              <div><span className="label">Re-calibration date</span><p className="flex min-h-11 items-center rounded-lg bg-slate-50 px-3 text-sm font-semibold tabular-nums dark:bg-slate-800/60" aria-live="polite">{calDay(next)}</p></div>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              {input(d.resolution, (resolution) => set({ resolution }), 'Scale value (resolution)', 60, { placeholder: '0.01 mm' })}
              <label className="block">
                <span className="label">Allowed tolerance (±)</span>
                <div className="flex gap-2">
                  <input inputMode="decimal" className="input tabular-nums" aria-invalid={tolerance === undefined || undefined} value={d.tolerance} onChange={(e) => set({ tolerance: e.target.value })} placeholder="0.02" />
                  <input aria-label="Unit" className="input w-24" maxLength={20} value={d.unit} onChange={(e) => set({ unit: e.target.value })} />
                </div>
              </label>
              {d.kind === 'external' && input(d.body, (body) => set({ body }), 'Laboratory (calibration body)', 200, { placeholder: 'المعهد القومى للمعايرة NIS' })}
            </div>
          </section>

          <section className="space-y-2 rounded-xl border border-slate-200 p-3 dark:border-slate-700" aria-labelledby="cert-pdf">
            <h3 id="cert-pdf" className="text-sm font-semibold">The laboratory’s certificate (PDF){d.kind === 'internal' && <span className="font-normal text-muted"> · optional</span>}</h3>
            <input ref={fileInput} type="file" accept=".pdf,application/pdf" className="sr-only" aria-label="Choose the certificate PDF" onChange={(e) => void pickFile(e.target.files?.[0])} />
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" disabled={busy} onClick={() => fileInput.current?.click()}>{uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileUp className="h-4 w-4" />}{d.fileId ? 'Replace the PDF' : 'Attach the PDF'}</Button>
              {d.fileName && <span className="inline-flex items-center gap-1 rounded-lg bg-slate-100 py-1 pe-1 ps-2.5 text-sm dark:bg-slate-800"><span dir="auto" className="max-w-[16rem] truncate">{d.fileName}</span>
                <button type="button" className="rounded p-1.5 hover:bg-slate-200 dark:hover:bg-slate-700 touch:p-2.5" aria-label="Remove the PDF" onClick={() => set({ fileId: null, fileName: null })}><X className="h-3.5 w-3.5" /></button></span>}
            </div>
          </section>

          <section className="space-y-3" aria-labelledby="cert-ref">
            <h3 id="cert-ref" className="text-sm font-semibold">Reference <span className="font-normal text-muted">(بيانات المرجع)</span></h3>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {input(d.reference.name, (name) => setRef({ name }), 'Reference name', 200, { placeholder: 'Block Gauge set' })}
              {input(d.reference.manufacturer, (manufacturer) => setRef({ manufacturer }), 'Manufacturer', 200)}
              {input(d.reference.serial, (serial) => setRef({ serial }), 'Serial No', 200)}
              {input(d.reference.certificateNo, (certificateNo) => setRef({ certificateNo }), 'Its calibration certificate No', 200)}
              {input(d.reference.body, (body) => setRef({ body }), 'Its calibration body', 200)}
            </div>
          </section>

          <section className="space-y-3" aria-labelledby="cert-results">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 id="cert-results" className="text-sm font-semibold">Readings <span className="font-normal text-muted">(نتائج المعايرة)</span></h3>
              <span className="text-xs text-muted">{judgement.readings} reading{judgement.readings === 1 ? '' : 's'}{judgement.maxError !== null ? ` · largest error ${judgement.maxError}` : ''}</span>
            </div>
            {d.groups.length === 0 && <p className="text-sm text-muted">{d.kind === 'external' ? 'The laboratory’s readings are in its PDF; add them here too to judge them.' : 'No readings yet: add a group.'}</p>}
            {d.groups.map((g, gi) => <div key={gi} className="space-y-2 rounded-xl border border-slate-200 p-3 dark:border-slate-700">
              <div className="flex items-center gap-2">
                <input dir="auto" aria-label={`Group ${gi + 1} name`} className="input h-9 py-1 font-semibold" maxLength={120} value={g.name} placeholder="External measurements" onChange={(e) => setGroups((all) => all.map((x, i) => (i === gi ? { ...x, name: e.target.value } : x)))} />
                <button type="button" className="btn-ghost h-9 min-h-0 shrink-0 px-2 touch:h-11" aria-label={`Remove group ${g.name || gi + 1}`} onClick={() => setGroups((all) => all.filter((_, i) => i !== gi))}><Trash2 className="h-4 w-4" /></button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[420px] text-sm">
                  <thead className="text-xs text-muted"><tr><th scope="col" className="px-1 py-1 text-start font-semibold">Nominal{d.unit ? ` (${d.unit})` : ''}</th><th scope="col" className="px-1 py-1 text-start font-semibold">Actual reading</th><th scope="col" className="px-1 py-1 text-end font-semibold">Error</th><th scope="col"><span className="sr-only">Remove</span></th></tr></thead>
                  <tbody>{g.readings.map((r, ri) => {
                    const parsed = { nominal: parseNumber(r.nominal) ?? null, reading: parseNumber(r.reading) ?? null }
                    const error = readingError(parsed)
                    const ok = readingOk(parsed, tolerance ?? null)
                    const setRow = (patch: Partial<RowDraft>) => setGroups((all) => all.map((x, i) => (i === gi ? { ...x, readings: x.readings.map((y, j) => (j === ri ? { ...y, ...patch } : y)) } : x)))
                    return <tr key={ri}>
                      <td className="px-1 py-1"><input inputMode="decimal" aria-label={`${g.name || `Group ${gi + 1}`} reading ${ri + 1} nominal`} className="input h-9 py-1 tabular-nums" aria-invalid={parseNumber(r.nominal) === undefined || undefined} value={r.nominal} onChange={(e) => setRow({ nominal: e.target.value })} /></td>
                      <td className="px-1 py-1"><input inputMode="decimal" aria-label={`${g.name || `Group ${gi + 1}`} reading ${ri + 1} actual`} className={cn('input h-9 py-1 tabular-nums', ok === false && 'border-danger-500 ring-1 ring-danger-500')} aria-invalid={parseNumber(r.reading) === undefined || ok === false || undefined} value={r.reading} onChange={(e) => setRow({ reading: e.target.value })} /></td>
                      <td className={cn('whitespace-nowrap px-1 py-1 text-end tabular-nums', ok === false ? 'font-semibold text-danger-700 dark:text-danger-400' : ok ? 'text-success-700 dark:text-success-400' : 'text-muted')}>
                        {error === null ? '—' : `${error > 0 ? '+' : ''}${error}`}{ok === false && <><span aria-hidden> ✕</span><span className="sr-only"> (out of tolerance)</span></>}
                      </td>
                      <td className="w-10 px-1 py-1"><button type="button" className="btn-ghost h-9 min-h-0 px-2 touch:h-11" aria-label={`Remove reading ${ri + 1}`} onClick={() => setGroups((all) => all.map((x, i) => (i === gi ? { ...x, readings: x.readings.filter((_, j) => j !== ri) } : x)))}><X className="h-4 w-4" /></button></td>
                    </tr>
                  })}</tbody>
                </table>
              </div>
              {g.readings.length < MAX_READINGS && <button type="button" className="btn-ghost h-8 min-h-0 px-2 text-xs touch:h-11" onClick={() => setGroups((all) => all.map((x, i) => (i === gi ? { ...x, readings: [...x.readings, { nominal: '', reading: '' }] } : x)))}><Plus className="h-3.5 w-3.5" />Add a reading</button>}
            </div>)}
            {d.groups.length < MAX_GROUPS && <Button type="button" onClick={() => setGroups((all) => [...all, { name: '', readings: [{ nominal: '', reading: '' }] }])}><Plus className="h-4 w-4" />Add a group</Button>}
          </section>

          <section className="grid gap-3 sm:grid-cols-2" aria-label="Signatures">
            {input(d.performedBy, (performedBy) => set({ performedBy }), 'Calibrated by (القائم بالمعايرة)', 200)}
            {input(d.approvedBy, (approvedBy) => set({ approvedBy }), 'Approved by (مدير الجودة)', 200)}
            <label className="block sm:col-span-2"><span className="label">Notes</span><textarea dir="auto" rows={2} maxLength={4000} className="input" value={d.notes} onChange={(e) => set({ notes: e.target.value })} /></label>
          </section>
        </fieldset>
      </form>
    </Modal>
    {discard && <Modal open size="sm" title="Discard changes?" onClose={() => setDiscard(false)} footer={<><Button onClick={() => setDiscard(false)}>Keep editing</Button><Button variant="danger" onClick={onClose}>Discard</Button></>}>
      <p className="text-sm">What was entered on this certificate is not saved.</p>
    </Modal>}
  </>
}
