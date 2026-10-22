import { Loader2 } from 'lucide-react'
import { QUALITY_FORMS, type QualityKind, type QualityRecord } from '@qc/shared/qualityRecords'
import { Button, Modal } from '@/components/ui'
import { ScrollX } from '@/components/ui/ScrollX'
import { ImagePicker } from '@/components/inspection/ImagePicker'
import { useQualityRecord } from '@/services/qualityRecords'
import { useAuth } from '@/store/AuthContext'

export function QualityRecordView({ kind, id, onClose, onEdit }: { kind: QualityKind; id: string; onClose: () => void; onEdit: (record: QualityRecord) => void }) {
  const query = useQualityRecord(kind, id)
  const { can } = useAuth()
  const config = QUALITY_FORMS[kind]
  const r = query.data
  const d = r?.data
  const fields: [string, string | undefined][] = d ? d.kind === 'ncr' ? [
    ['Date', r!.date], ['Order no.', d.orderNumber], ['Factory', d.factories.join(', ')], ['MC', d.machines.map((m) => m.displayName || m.code).join(', ')], ['Process', d.process], ['Raised by', d.raisedBy], ['Assigned to', d.assignedTo], ['Source', d.sources.join(', ')], ['Other source', d.sourceOther], ['Total QTY', d.totalQuantity], ['Rejected QTY', d.rejectedQuantity], ['Description of non-conformity', d.description], ['Proposed immediate actions (Correction)', d.immediateAction], ['Responsible person', d.responsiblePerson], ['Disposition', d.dispositions.join(', ')], ['Corrective action required', d.correctiveActionRequired === null ? '' : d.correctiveActionRequired ? 'Yes' : 'No'], ['Root cause', d.rootCause], ['Completed by', d.completedBy], ['Effectiveness of actions', d.effectivenessDetails], ['Effectiveness', d.effectiveness], ['Effectiveness date', d.effectivenessDate],
  ] : [
    ['Date of complaint', r!.date], ['Order no.', d.orderNumber], ['Customer name', d.customer], ['Product name', d.productName], ['Item code', d.itemCode], ['Contact person', d.contactPerson], ['E-mail', d.email], ['Tel. no.', d.telephone], ['Dimensions', d.dimensions], ['Colour', d.colour], ['Invoice no.', d.invoiceNumber], ['Invoice date', d.invoiceDate], ['Quantity', d.quantity], ['Non-compliance details', d.nonComplianceDetails], ['Product issue', d.issues.join(', ')], ['Other issue', d.issueOther], ['Observations / Description', d.description], ['Quantity processed', d.processedQuantity], ['Quantity lost / replaced', d.lostQuantity], ['Date', d.reportDate], ['Name', d.reportName], ['Signature', d.signature],
  ] : []
  return <Modal open title={r?.reference ?? config.singular} size="xl" onClose={onClose} footer={<>
    <Button onClick={onClose}>Close</Button>{r && can(config.record) && <Button variant="primary" onClick={() => onEdit(r)}>Edit</Button>}
  </>}>
    {query.isPending ? <p className="flex items-center gap-2 text-sm text-muted"><Loader2 className="h-4 w-4 animate-spin" />Loading…</p> : query.isError ? <p role="alert" className="text-sm text-danger-600">{query.error.message} <button className="underline" onClick={() => void query.refetch()}>Retry</button></p> : r && <div className="space-y-5">
      <dl className="grid gap-4 sm:grid-cols-2">{fields.filter(([, value]) => value).map(([label, value]) => <div key={label} className={value!.length > 150 ? 'sm:col-span-2' : undefined}><dt className="label">{label}</dt><dd dir="auto" className="whitespace-pre-wrap break-words text-sm">{value}</dd></div>)}</dl>
      {d?.kind === 'ncr' && d.correctiveActions.length > 0 && <section><h3 className="label">Corrective actions</h3><ScrollX label="Corrective actions"><table className="w-full min-w-[500px] text-left text-sm"><thead><tr>{['No.', 'Action', 'Responsibility', 'Completion date'].map((v) => <th key={v} className="border-b px-2 py-2">{v}</th>)}</tr></thead><tbody>{d.correctiveActions.map((a, i) => <tr key={i}><td className="border-b px-2 py-2">{i + 1}</td><td dir="auto" className="whitespace-pre-wrap border-b px-2 py-2">{a.description}</td><td dir="auto" className="border-b px-2 py-2">{a.responsibility}</td><td className="border-b px-2 py-2">{a.completionDate || '—'}</td></tr>)}</tbody></table></ScrollX></section>}
      {r.imageIds.length > 0 && <div><span className="label">Images</span><ImagePicker imageIds={r.imageIds} onChange={() => undefined} readOnly /></div>}
      <p className="text-xs text-muted">{r.form.code} · Issue {r.form.issue} · {r.form.issueDate}</p>
      <p className="text-xs text-muted">{r.updatedByName} · {new Date(r.updatedAt).toLocaleString()}</p>
    </div>}
  </Modal>
}
