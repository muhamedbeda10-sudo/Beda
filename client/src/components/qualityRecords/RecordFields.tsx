import { useId, useState, type ReactNode } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { COMPLAINT_ISSUES, EFFECTIVENESS, NCR_DISPOSITIONS, NCR_SOURCES, type NcrData, type CustomerComplaintData, type QualityKind, type QualityOrder, type QualityRecordOptions } from '@qc/shared/qualityRecords'
import { Button, Field, Input, Select } from '@/components/ui'
import { MultiSelectMenu, SearchSelect } from '@/components/dashboard/filters'
import { useDebounced } from '@/services/queries'
import { useQualityItems, useQualityOrders } from '@/services/qualityRecords'

export function TextField({ label, value, onChange, type = 'text', required = false, maxLength = 200, readOnly = false }: { label: string; value: string; onChange?: (v: string) => void; type?: string; required?: boolean; maxLength?: number; readOnly?: boolean }) {
  return <Field label={label}><Input aria-label={label} type={type} required={required} maxLength={maxLength} dir={type === 'text' ? 'auto' : undefined} readOnly={readOnly} value={value} onChange={(e) => onChange?.(e.target.value)} /></Field>
}
export function TextAreaField({ label, value, onChange, required = false }: { label: string; value: string; onChange: (v: string) => void; required?: boolean }) {
  return <Field label={label}><textarea aria-label={label} className="input min-h-24" dir="auto" maxLength={4000} required={required} value={value} onChange={(e) => onChange(e.target.value)} /></Field>
}
function PeopleField({ label, value, onChange, people }: { label: string; value: string; onChange: (v: string) => void; people: QualityRecordOptions['people'] }) {
  const id = useId()
  return <Field label={label}><Input aria-label={label} dir="auto" list={id} maxLength={200} value={value} onChange={(e) => onChange(e.target.value)} /><datalist id={id}>{people.map((p) => <option key={p.id} value={p.name} />)}</datalist></Field>
}
function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="space-y-3"><h3 className="border-b border-slate-200 pb-2 text-sm font-bold dark:border-slate-700">{title}</h3>{children}</section>
}
function CheckGroup<T extends string>({ label, options, selected, onChange }: { label: string; options: readonly T[]; selected: T[]; onChange: (v: T[]) => void }) {
  return <fieldset><legend className="label">{label}</legend><div className="grid gap-2 sm:grid-cols-2">{options.map((option) => <label key={option} className="flex min-h-10 items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-700"><input type="checkbox" checked={selected.includes(option)} onChange={() => onChange(selected.includes(option) ? selected.filter((v) => v !== option) : [...selected, option])} />{option}</label>)}</div></fieldset>
}
export function RecordOrderPicker({ kind, value, onPick }: { kind: QualityKind; value: string; onPick: (v: QualityOrder | null) => void }) {
  const [term, setTerm] = useState('')
  const orders = useQualityOrders(kind, useDebounced(term, 250))
  return <div><span className="label">Order no.</span><SearchSelect ariaLabel="Order number" value={value ? { value, label: value } : null} options={(orders.data ?? []).map((o) => ({ value: o.orderNumber, label: o.orderNumber }))} search={term} onSearch={setTerm} onPick={(picked) => onPick(orders.data?.find((o) => o.orderNumber === picked?.value) ?? null)} placeholder="Select order" clearLabel="Clear" loading={orders.isFetching} />{orders.isError && <button type="button" className="text-xs text-danger-600 underline" onClick={() => void orders.refetch()}>Retry</button>}</div>
}

export function NcrFields({ data: d, update, options, tab }: { data: NcrData; update: (patch: Partial<NcrData>) => void; options: QualityRecordOptions; tab: string }) {
  if (tab === 'report') return <div className="space-y-4">
    <div className="grid gap-3 sm:grid-cols-2">
      <RecordOrderPicker kind="ncr" value={d.orderNumber} onPick={(v) => update({ orderNumber: v?.orderNumber ?? '', customer: v?.customer ?? '' })} />
      <TextField label="Process" value={d.process} onChange={(process) => update({ process })} />
      <div><span className="label">Factory</span><MultiSelectMenu ariaLabel="Factories" allLabel="Select factory" noun="factories" className="!min-h-11 !w-full !max-w-full !justify-between !text-sm" options={options.factories.map((f) => ({ value: f, label: f }))} selected={d.factories} onChange={(factories) => update({ factories, machineIds: d.machineIds.filter((id) => [...d.machines, ...options.machines].some((m) => m.id === id && (!factories.length || factories.includes(m.factory)))) })} /></div>
      <div><span className="label">MC</span><MultiSelectMenu ariaLabel="Machines" allLabel="Select MC" noun="machines" className="!min-h-11 !w-full !max-w-full !justify-between !text-sm" options={[...d.machines, ...options.machines.filter((m) => !d.machines.some((v) => v.id === m.id))].filter((m) => !d.factories.length || d.factories.includes(m.factory)).map((m) => ({ value: m.id, label: m.displayName || m.code }))} selected={d.machineIds} onChange={(machineIds) => update({ machineIds })} /></div>
      <PeopleField label="Raised by" value={d.raisedBy} onChange={(raisedBy) => update({ raisedBy })} people={options.people} />
      <PeopleField label="Assigned to" value={d.assignedTo} onChange={(assignedTo) => update({ assignedTo })} people={options.people} />
    </div>
    <CheckGroup label="Source of non-conformity" options={NCR_SOURCES} selected={d.sources} onChange={(sources) => update({ sources })} />
    {d.sources.includes('Other') && <TextField label="Other source" maxLength={500} value={d.sourceOther} onChange={(sourceOther) => update({ sourceOther })} />}
    {d.sources.includes('Product non-conformity') && <div className="grid gap-3 sm:grid-cols-2"><TextField label="Total QTY" value={d.totalQuantity} onChange={(totalQuantity) => update({ totalQuantity })} required /><TextField label="Rejected QTY" value={d.rejectedQuantity} onChange={(rejectedQuantity) => update({ rejectedQuantity })} required /></div>}
    <TextAreaField label="Description of non-conformity" value={d.description} onChange={(description) => update({ description })} required />
  </div>
  if (tab === 'correction') return <div className="space-y-4">
    <TextAreaField label="Proposed immediate actions (Correction)" value={d.immediateAction} onChange={(immediateAction) => update({ immediateAction })} />
    <PeopleField label="Responsible person" value={d.responsiblePerson} onChange={(responsiblePerson) => update({ responsiblePerson })} people={options.people} />
    <CheckGroup label="Disposition" options={NCR_DISPOSITIONS} selected={d.dispositions} onChange={(dispositions) => update({ dispositions })} />
    <Field label="Corrective action required"><Select aria-label="Corrective action required" value={d.correctiveActionRequired === null ? '' : String(d.correctiveActionRequired)} onChange={(e) => update({ correctiveActionRequired: e.target.value === '' ? null : e.target.value === 'true' })}><option value="">—</option><option value="true">Yes</option><option value="false">No</option></Select></Field>
  </div>
  return <div className="space-y-5">
    <div className="space-y-3"><TextAreaField label="Root cause" value={d.rootCause} onChange={(rootCause) => update({ rootCause })} /><PeopleField label="Completed by" value={d.completedBy} onChange={(completedBy) => update({ completedBy })} people={options.people} /></div>
    <Section title="Corrective actions"><div className="space-y-3">{d.correctiveActions.map((action, index) => <div key={index} className="space-y-2 rounded-xl border border-slate-200 p-3 dark:border-slate-700">
      <div className="flex items-center justify-between"><span className="text-xs font-semibold">Action {index + 1}</span><button type="button" className="icon-btn" aria-label={`Remove action ${index + 1}`} onClick={() => update({ correctiveActions: d.correctiveActions.filter((_, i) => i !== index) })}><Trash2 className="h-4 w-4" /></button></div>
      <TextField label={`Action ${index + 1}`} maxLength={2000} value={action.description} onChange={(description) => update({ correctiveActions: d.correctiveActions.map((v, i) => i === index ? { ...v, description } : v) })} />
      <div className="grid gap-3 sm:grid-cols-2"><PeopleField label={`Responsibility ${index + 1}`} value={action.responsibility} people={options.people} onChange={(responsibility) => update({ correctiveActions: d.correctiveActions.map((v, i) => i === index ? { ...v, responsibility } : v) })} /><TextField label={`Completion date ${index + 1}`} type="date" value={action.completionDate} onChange={(completionDate) => update({ correctiveActions: d.correctiveActions.map((v, i) => i === index ? { ...v, completionDate } : v) })} /></div>
    </div>)}</div><Button type="button" disabled={d.correctiveActions.length >= 50} onClick={() => update({ correctiveActions: [...d.correctiveActions, { description: '', responsibility: '', completionDate: '' }] })}><Plus className="h-4 w-4" />Add action</Button></Section>
    <div className="space-y-3"><TextAreaField label="Effectiveness of actions" value={d.effectivenessDetails} onChange={(effectivenessDetails) => update({ effectivenessDetails })} /><div className="grid gap-3 sm:grid-cols-2"><Field label="Effectiveness"><Select aria-label="Effectiveness" value={d.effectiveness} onChange={(e) => update({ effectiveness: e.target.value as NcrData['effectiveness'] })}>{EFFECTIVENESS.map((v) => <option key={v} value={v}>{v === 'Pending' ? '—' : v}</option>)}</Select></Field><TextField label="Effectiveness date" type="date" value={d.effectivenessDate} onChange={(effectivenessDate) => update({ effectivenessDate })} /></div></div>
  </div>
}

export function ComplaintFields({ data: d, update, options, tab }: { data: CustomerComplaintData; update: (patch: Partial<CustomerComplaintData>) => void; options: QualityRecordOptions; tab: string }) {
  const [term, setTerm] = useState('')
  const items = useQualityItems('customer-complaint', d.orderNumber, useDebounced(term, 250))
  const key = (i: { item: string; itemCode: string }) => JSON.stringify([i.itemCode, i.item])
  if (tab === 'details') return <div className="space-y-4">
    <div className="grid gap-3 sm:grid-cols-2">
      <RecordOrderPicker kind="customer-complaint" value={d.orderNumber} onPick={(v) => update({ orderNumber: v?.orderNumber ?? '', customer: v?.customer ?? '', itemCode: '', productName: '' })} />
      <TextField label="Customer name" value={d.customer} readOnly />
      <div><span className="label">Product name</span><SearchSelect ariaLabel="Product name" value={d.productName ? { value: key({ item: d.productName, itemCode: d.itemCode }), label: d.productName, sub: d.itemCode } : null} options={(items.data ?? []).map((i) => ({ value: key(i), label: i.item, sub: i.itemCode }))} search={term} onSearch={setTerm} onPick={(picked) => { const item = items.data?.find((i) => key(i) === picked?.value); update({ productName: item?.item ?? '', itemCode: item?.itemCode ?? '' }) }} placeholder="Select item" clearLabel="Clear" loading={items.isFetching} />{items.isError && <button type="button" className="text-xs text-danger-600 underline" onClick={() => void items.refetch()}>Retry</button>}</div>
      <TextField label="Contact person" value={d.contactPerson} onChange={(contactPerson) => update({ contactPerson })} />
      <TextField label="E-mail" type="email" maxLength={320} value={d.email} onChange={(email) => update({ email })} />
      <TextField label="Tel. no." type="tel" maxLength={80} value={d.telephone} onChange={(telephone) => update({ telephone })} />
      <TextField label="Dimensions" maxLength={500} value={d.dimensions} onChange={(dimensions) => update({ dimensions })} />
      <TextField label="Colour" value={d.colour} onChange={(colour) => update({ colour })} />
      <TextField label="Invoice no." value={d.invoiceNumber} onChange={(invoiceNumber) => update({ invoiceNumber })} />
      <TextField label="Invoice date" type="date" value={d.invoiceDate} onChange={(invoiceDate) => update({ invoiceDate })} />
      <TextField label="Quantity" value={d.quantity} onChange={(quantity) => update({ quantity })} />
    </div>
  </div>
  return <div className="space-y-4">
    <TextAreaField label="Non-compliance details" value={d.nonComplianceDetails} onChange={(nonComplianceDetails) => update({ nonComplianceDetails })} />
    <CheckGroup label="Product issue" options={COMPLAINT_ISSUES} selected={d.issues} onChange={(issues) => update({ issues })} />
    {d.issues.includes('Other') && <TextField label="Other issue" maxLength={500} value={d.issueOther} onChange={(issueOther) => update({ issueOther })} />}
    <TextAreaField label="Observations / Description" value={d.description} onChange={(description) => update({ description })} required />
    <div className="grid gap-3 sm:grid-cols-2">
      <TextField label="Quantity processed" value={d.processedQuantity} onChange={(processedQuantity) => update({ processedQuantity })} />
      <TextField label="Quantity lost / replaced" value={d.lostQuantity} onChange={(lostQuantity) => update({ lostQuantity })} />
      <TextField label="Date" type="date" value={d.reportDate} onChange={(reportDate) => update({ reportDate })} />
      <PeopleField label="Name" value={d.reportName} people={options.people} onChange={(reportName) => update({ reportName })} />
      <TextField label="Signature" maxLength={500} value={d.signature} onChange={(signature) => update({ signature })} />
    </div>
  </div>
}
