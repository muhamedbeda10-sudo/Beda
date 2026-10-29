// ============================================================================
// §27 — An instrument opened from the plan: everything known of it, where it
// stands, its certificates (each read as the paper, printed, its laboratory's
// PDF opened or downloaded), its history from the audit log, and what may be
// done: correct it, record a calibration, scrap it — the day, the reason and
// the details, kept in the scrap log — or, for whoever sets calibration up,
// restore or delete it.
// ============================================================================

import { useState, type ReactNode } from 'react'
import { Ban, Download, FileText, History, Loader2, Pencil, Plus, Printer, RotateCcw, Trash2 } from 'lucide-react'
import {
  CALIBRATION_PERMISSIONS, SCRAP_REASONS, intervalLabel, workingDays,
  type CalibrationCertificate, type CalibrationItem, type CalibrationOptions,
} from '@qc/shared/calibration'
import { Badge, Button, Modal } from '@/components/ui'
import { PdfViewer } from '@/components/documents/WorkInstructionViewer'
import { usePrint } from '@/components/print/usePrint'
import { apiBlob } from '@/lib/api'
import { formatDateTime } from '@/lib/utils'
import { calibrationFilePath, useCalibrationItem, useDeleteCalibrationCertificate, useDeleteCalibrationItem, useRestoreCalibrationItem, useScrapCalibrationItem } from '@/services/calibration'
import { useAuth } from '@/store/AuthContext'
import { useApp } from '@/store/AppContext'
import { CertificateDialog } from './CertificateDialog'
import { CertificatePaper, CertificateSheet } from './CertificateSheet'
import { ItemDialog } from './ItemDialog'
import { calDay, daysText, KindBadge, ResultBadge, StatusBadge } from './common'

/** The audit log's words for an instrument's fields. */
const FIELD_NAMES: Record<string, string> = {
  category: 'Category', name: 'Name', deviceCode: 'Device code', manufacturer: 'Manufacturer', range: 'Range', resolution: 'Resolution', tolerance: 'Tolerance', unit: 'Unit',
  department: 'Department', holder: 'Holder', receivedOn: 'Received on', kind: 'Kind', calibrationCode: 'Calibration code', lastCalibratedOn: 'Last calibration',
  intervalMonths: 'Interval (months)', notes: 'Notes', status: 'Status', scrappedOn: 'Scrapped on', scrapReason: 'Scrap reason', scrapDetails: 'Scrap details',
  certificateNo: 'Certificate No', calibratedOn: 'Calibration date', body: 'Laboratory', performedBy: 'Calibrated by', approvedBy: 'Approved by', reference: 'Reference',
  readings: 'Readings', fileId: 'PDF',
}

function ScrapDialog({ item, today, onClose }: { item: CalibrationItem; today: string; onClose: () => void }) {
  const { toast } = useApp()
  const scrap = useScrapCalibrationItem(item.id)
  const [scrappedOn, setDay] = useState(today)
  const [choice, setChoice] = useState<string>(SCRAP_REASONS[0])
  const [other, setOther] = useState('')
  const [details, setDetails] = useState('')
  const reason = choice === 'other' ? other.trim() : choice
  const days = workingDays(item.receivedOn, scrappedOn)
  const invalid = !scrappedOn || scrappedOn > today || (!!item.receivedOn && scrappedOn < item.receivedOn) || !reason
  async function submit() {
    try {
      await scrap.mutateAsync({ scrappedOn, reason, details: details.trim(), version: item.version })
      toast(`${item.calibrationCode || item.name} scrapped; it is kept in the scrap log.`, 'success')
      onClose()
    } catch (error) { toast(error instanceof Error ? error.message : 'Could not scrap.', 'error') }
  }
  return <Modal open size="md" title={`Scrap ${item.calibrationCode || item.name}?`} icon={<Ban className="h-5 w-5" />} onClose={onClose} footer={<>
    <Button variant="ghost" onClick={onClose}>Cancel</Button>
    <Button variant="danger" disabled={invalid || scrap.isPending} onClick={() => void submit()}>{scrap.isPending && <Loader2 className="h-4 w-4 animate-spin" />}Scrap the instrument</Button>
  </>}>
    <div className="space-y-3">
      <p className="text-sm text-muted">It leaves the calibration plan and its code is free for another instrument. The scrap log (F-Q-05-03) and the instrument’s history keep the day, the reason, the details and who recorded it.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block"><span className="label">Scrapped on (تاريخ التكهين)</span><input type="date" className="input" value={scrappedOn} min={item.receivedOn ?? undefined} max={today} onChange={(e) => setDay(e.target.value)} /></label>
        <div><span className="label">Days in use</span><p className="flex min-h-11 items-center text-sm tabular-nums">{days === null ? '—' : `${days.toLocaleString()} days since ${calDay(item.receivedOn)}`}</p></div>
      </div>
      <label className="block"><span className="label">Reason</span>
        <select className="input" value={choice} onChange={(e) => setChoice(e.target.value)}>
          {SCRAP_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
          <option value="other">Other…</option>
        </select>
      </label>
      {choice === 'other' && <label className="block"><span className="label">The reason</span><input dir="auto" className="input" maxLength={200} value={other} onChange={(e) => setOther(e.target.value)} autoFocus /></label>}
      <label className="block"><span className="label">Details</span><textarea dir="auto" rows={3} maxLength={4000} className="input" value={details} onChange={(e) => setDetails(e.target.value)} placeholder="What was found, what replaces it…" /></label>
    </div>
  </Modal>
}

/** A certificate opened: as the paper, with its laboratory's PDF, printed or corrected. */
function CertificateView({ cert, item, options, canRecord, canSetup, onClose }: { cert: CalibrationCertificate; item: CalibrationItem; options: CalibrationOptions; canRecord: boolean; canSetup: boolean; onClose: () => void }) {
  const { toast } = useApp()
  const printer = usePrint()
  const remove = useDeleteCalibrationCertificate()
  const [pdf, setPdf] = useState(false)
  const [editing, setEditing] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [downloading, setDownloading] = useState(false)
  async function download() {
    if (!cert.fileId) return
    setDownloading(true)
    try {
      const url = URL.createObjectURL(await apiBlob(calibrationFilePath(cert.fileId)))
      const a = document.createElement('a')
      a.href = url
      a.download = cert.fileName ?? `${cert.certificateNo || 'certificate'}.pdf`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch { toast('The PDF could not be downloaded.', 'error') }
    finally { setDownloading(false) }
  }
  async function del() {
    try { await remove.mutateAsync(cert.id); toast('Certificate deleted.', 'success'); onClose() } catch (error) { toast(error instanceof Error ? error.message : 'Could not delete.', 'error') }
  }
  if (editing) return <CertificateDialog item={item} options={options} cert={cert} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); onClose() }} />
  return <>
    <Modal open size="xl" title={<span className="flex flex-wrap items-center gap-2">Certificate {cert.certificateNo} <ResultBadge result={cert.result} /></span>} onClose={onClose} footer={<>
      {canSetup && <Button variant="ghost" className="mr-auto text-danger-700 dark:text-danger-400" onClick={() => setConfirm(true)}><Trash2 className="h-4 w-4" />Delete</Button>}
      {cert.fileId && <Button onClick={() => setPdf(true)}><FileText className="h-4 w-4" />Open the PDF</Button>}
      {cert.fileId && <Button disabled={downloading} onClick={() => void download()}>{downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}Download</Button>}
      <Button onClick={() => printer.print(<CertificatePaper cert={cert} />, { title: `Calibration Certificate ${cert.certificateNo}`, day: cert.calibratedOn, bare: true })}><Printer className="h-4 w-4" />Print</Button>
      {canRecord && <Button variant="primary" onClick={() => setEditing(true)}><Pencil className="h-4 w-4" />Edit</Button>}
    </>}>
      <CertificateSheet cert={cert} mode="view" />
      <p className="mt-3 text-xs text-muted">{cert.source === 'import' ? 'Imported from the certificates log. ' : ''}{cert.updatedByName} · {formatDateTime(cert.updatedAt)}</p>
    </Modal>
    {pdf && cert.fileId && <PdfViewer path={calibrationFilePath(cert.fileId)} title={cert.fileName ?? 'Certificate'} subtitle={cert.certificateNo} onClose={() => setPdf(false)} />}
    {confirm && <Modal open size="sm" title={`Delete certificate ${cert.certificateNo}?`} onClose={() => setConfirm(false)} footer={<><Button onClick={() => setConfirm(false)}>Keep it</Button><Button variant="danger" disabled={remove.isPending} onClick={() => void del()}>{remove.isPending && <Loader2 className="h-4 w-4 animate-spin" />}Delete</Button></>}>
      <p className="text-sm">If it is the instrument’s latest, the instrument goes back to the certificate before it. The audit log keeps that it was deleted, and by whom.</p>
    </Modal>}
    {printer.node}
  </>
}

export function ItemView({ id, options, onClose }: { id: string; options: CalibrationOptions; onClose: () => void }) {
  const query = useCalibrationItem(id)
  const { can } = useAuth()
  const { toast } = useApp()
  const restore = useRestoreCalibrationItem(id)
  const remove = useDeleteCalibrationItem()
  const [editing, setEditing] = useState(false)
  const [newCert, setNewCert] = useState(false)
  const [scrapping, setScrapping] = useState(false)
  const [openCert, setOpenCert] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const record = can(CALIBRATION_PERMISSIONS.record)
  const setup = can(CALIBRATION_PERMISSIONS.setup)
  const data = query.data
  const i = data?.item
  const cert = data?.certificates.find((c) => c.id === openCert)

  async function doRestore() {
    if (!i) return
    try { await restore.mutateAsync(i.version); toast('Back in the plan.', 'success') } catch (error) { toast(error instanceof Error ? error.message : 'Could not restore.', 'error') }
  }
  async function doDelete() {
    if (!i) return
    try { await remove.mutateAsync(i.id); toast(`${i.calibrationCode || i.name} deleted.`, 'success'); onClose() } catch (error) { toast(error instanceof Error ? error.message : 'Could not delete.', 'error') }
  }

  const row = (label: string, value: ReactNode) => <div className="flex flex-col gap-0.5 border-b border-slate-100 py-2 dark:border-slate-800 sm:flex-row sm:gap-3">
    <dt className="w-44 shrink-0 text-xs font-semibold uppercase tracking-wide text-muted">{label}</dt>
    <dd className="min-w-0 text-sm">{value || <span className="text-muted">—</span>}</dd>
  </div>

  if (editing && i) return <ItemDialog item={i} options={options} onClose={() => setEditing(false)} onSaved={() => setEditing(false)} />
  if (newCert && i) return <CertificateDialog item={i} options={options} previous={data?.certificates[0]} onClose={() => setNewCert(false)} onSaved={() => setNewCert(false)} />
  if (cert && i) return <CertificateView cert={cert} item={i} options={options} canRecord={record} canSetup={setup} onClose={() => setOpenCert(null)} />

  return <>
    <Modal open size="xl" title={i ? <span className="flex flex-wrap items-center gap-2"><span dir="auto">{i.calibrationCode || i.name}</span><StatusBadge status={i.status} /></span> : 'Instrument'} onClose={onClose} footer={i && <>
      {setup && <Button variant="ghost" className="mr-auto text-danger-700 dark:text-danger-400" onClick={() => setConfirmDelete(true)}><Trash2 className="h-4 w-4" />Delete</Button>}
      {i.scrap ? (setup && <Button disabled={restore.isPending} onClick={() => void doRestore()}>{restore.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}Restore to the plan</Button>)
        : record && <Button className="text-danger-700 dark:text-danger-400" onClick={() => setScrapping(true)}><Ban className="h-4 w-4" />Scrap</Button>}
      {record && <Button onClick={() => setEditing(true)}><Pencil className="h-4 w-4" />Edit</Button>}
      {record && !i.scrap && <Button variant="primary" onClick={() => setNewCert(true)}><Plus className="h-4 w-4" />New certificate</Button>}
    </>}>
      {query.isPending ? <p className="flex items-center gap-2 text-sm text-muted"><Loader2 className="h-4 w-4 animate-spin" />Loading…</p>
        : query.isError ? <p role="alert" className="text-sm text-danger-600">{query.error.message} <button type="button" className="underline" onClick={() => void query.refetch()}>Retry</button></p>
        : i && data && <div className="space-y-5">
          {/* Where it stands, at a glance. */}
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl bg-slate-50 p-3 dark:bg-slate-800/60"><p className="text-xs font-semibold uppercase text-muted">Last calibration</p><p className="mt-1 text-lg font-bold tabular-nums">{calDay(i.lastCalibratedOn)}</p><p className="text-xs text-muted">Interval: {intervalLabel(i.intervalMonths)}</p></div>
            <div className="rounded-xl bg-slate-50 p-3 dark:bg-slate-800/60"><p className="text-xs font-semibold uppercase text-muted">Next calibration</p><p className="mt-1 text-lg font-bold tabular-nums">{calDay(i.nextDueOn)}</p><p className="text-xs text-muted">{daysText(i) || (i.scrap ? 'Out of the plan' : 'Not calibrated yet')}</p></div>
            <div className="rounded-xl bg-slate-50 p-3 dark:bg-slate-800/60"><p className="text-xs font-semibold uppercase text-muted">Certificates</p><p className="mt-1 text-lg font-bold tabular-nums">{i.certificates}</p><p className="flex items-center gap-1 text-xs text-muted"><KindBadge kind={i.kind} /></p></div>
          </div>
          {i.scrap && <div role="note" className="rounded-xl border border-violet-200 bg-violet-50 p-3 text-sm dark:border-violet-500/30 dark:bg-violet-500/10">
            <p className="font-semibold">Scrapped{i.scrap.scrappedOn ? ` on ${calDay(i.scrap.scrappedOn)}` : ''}{i.workingDays !== null ? ` after ${i.workingDays.toLocaleString()} days in use` : ''}</p>
            <p dir="auto">{i.scrap.reason}{i.scrap.details ? ` — ${i.scrap.details}` : ''}</p>
            <p className="text-xs text-muted">Recorded by {i.scrap.byName || '—'} · {formatDateTime(i.scrap.at)}</p>
          </div>}
          <dl>
            {row('Instrument', <span dir="auto" className="font-semibold">{i.name}</span>)}
            {row('Category', i.categoryName)}
            {row('Calibration code', <span dir="ltr">{i.calibrationCode}</span>)}
            {row('Device code / serial', <span dir="auto">{i.deviceCode}</span>)}
            {row('Manufacturer · range', [i.manufacturer, i.range].filter(Boolean).join(' · '))}
            {row('Resolution · tolerance', [i.resolution, i.tolerance !== null ? `± ${i.tolerance} ${i.unit}` : ''].filter(Boolean).join(' · '))}
            {row('Department', i.departmentName)}
            {row('Held by', i.holder ? <span dir="auto">{i.holder}{i.receivedOn ? <span className="text-muted"> · since {calDay(i.receivedOn)}</span> : ''}</span> : '')}
            {i.notes && row('Notes', <span dir="auto" className="whitespace-pre-wrap">{i.notes}</span>)}
          </dl>
          <section aria-labelledby="cal-certs" className="space-y-2">
            <h3 id="cal-certs" className="text-sm font-semibold">Certificates</h3>
            {!data.certificates.length ? <p className="text-sm text-muted">No certificate recorded yet.{record && !i.scrap ? ' Record one with New certificate.' : ''}</p>
              : <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-700">{data.certificates.map((c) => <li key={c.id}>
                <button type="button" onClick={() => setOpenCert(c.id)} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-start hover:bg-slate-50 dark:hover:bg-slate-800/60 touch:min-h-[44px]">
                  <span dir="ltr" className="font-semibold">{c.certificateNo || '—'}</span>
                  <span className="text-sm tabular-nums">{calDay(c.calibratedOn)} → {calDay(c.nextDueOn)}</span>
                  <KindBadge kind={c.kind} />
                  <ResultBadge result={c.result} />
                  {c.fileId && <Badge tone="blue" icon={<FileText className="h-3 w-3" />}>PDF</Badge>}
                  <span className="ms-auto text-xs text-muted">{c.kind === 'external' ? c.body : c.performedBy}</span>
                </button>
              </li>)}</ul>}
          </section>
          <section aria-labelledby="cal-history" className="space-y-2">
            <button type="button" id="cal-history" className="flex items-center gap-2 text-sm font-semibold" aria-expanded={showHistory} onClick={() => setShowHistory((x) => !x)}><History className="h-4 w-4" />History ({data.history.length})</button>
            {showHistory && <ul className="space-y-1 text-sm">{data.history.map((h, n) => <li key={n} className="flex flex-wrap gap-x-2 border-b border-slate-100 py-1.5 dark:border-slate-800">
              <span className="text-xs tabular-nums text-muted">{formatDateTime(h.at)}</span>
              <span className="text-xs font-semibold">{h.userName}</span>
              <span dir="auto">{h.action === 'create' ? (h.entity === 'CalibrationCertificate' ? `Recorded certificate ${h.item ?? ''}` : 'Added') : h.action === 'delete' ? (h.entity === 'CalibrationCertificate' ? `Deleted certificate ${h.item ?? ''}` : 'Deleted')
                : <>{h.entity === 'CalibrationCertificate' ? 'Certificate · ' : ''}{FIELD_NAMES[h.field ?? ''] ?? h.field}: <span className="text-muted line-through decoration-slate-400">{h.oldValue || '—'}</span> → {h.newValue || '—'}</>}</span>
            </li>)}</ul>}
          </section>
          <p className="text-xs text-muted">{i.source === 'import' ? 'Imported from the register. ' : ''}Added by {i.createdByName} · last changed by {i.updatedByName}, {formatDateTime(i.updatedAt)}</p>
        </div>}
    </Modal>
    {scrapping && i && <ScrapDialog item={i} today={options.today} onClose={() => setScrapping(false)} />}
    {confirmDelete && i && <Modal open size="sm" title={`Delete ${i.calibrationCode || i.name}?`} onClose={() => setConfirmDelete(false)} footer={<><Button onClick={() => setConfirmDelete(false)}>Keep it</Button><Button variant="danger" disabled={remove.isPending} onClick={() => void doDelete()}>{remove.isPending && <Loader2 className="h-4 w-4 animate-spin" />}Delete</Button></>}>
      <p className="text-sm">For an instrument entered by mistake: it leaves the plan, the scrap log and the assistant with its certificates. To take an instrument out of use, scrap it instead. The audit log keeps that it was deleted, and by whom.</p>
    </Modal>}
  </>
}
