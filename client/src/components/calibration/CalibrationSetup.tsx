// ============================================================================
// §27 — Calibration's configuration: the categories (each kind of
// instrument's code prefix, usual interval and kind, and the certificate a new
// calibration starts from: its groups of nominal values and its reference),
// the departments with the code their calibration codes carry, and the old
// workbooks imported — the register, the certificates log and the scrap form —
// each again adding only what is new.
// ============================================================================

import { useRef, useState } from 'react'
import { FileUp, Loader2, Pencil, Plus, Trash2 } from 'lucide-react'
import {
  CALIBRATION_IMPORT_CHUNK, CALIBRATION_KINDS, CALIBRATION_KIND_NAMES, EMPTY_REFERENCE, INTERVAL_PRESETS, MAX_GROUPS, MAX_INTERVAL_MONTHS, intervalLabel,
  parseCalibrationCertificateLog, parseCalibrationRegister, parseCalibrationScrapLog,
  type CalibrationCategory, type CalibrationCategoryInput, type CalibrationDepartment, type CalibrationImport, type CalibrationImportResult, type CalibrationKind,
} from '@qc/shared/calibration'
import { Button, Card, Modal } from '@/components/ui'
import { ScrollX } from '@/components/ui/ScrollX'
import { readWorkbook, WorkbookReadError } from '@/lib/xlsx'
import { chunk } from '@/lib/utils'
import {
  importCalibration, useCalibrationOptions, useDeleteCalibrationCategory, useDeleteCalibrationDepartment, useInvalidateCalibration, useSaveCalibrationCategory,
  useSaveCalibrationDepartment,
} from '@/services/calibration'
import { useApp } from '@/store/AppContext'
import { numberText, parseNumber } from './common'

/** Nominal values as typed: "11.5, 40, 70" — undefined when one is not a number. */
function parseNominals(raw: string): number[] | undefined {
  const parts = raw.split(/[,،;\s]+/).filter(Boolean)
  const values = parts.map((p) => parseNumber(p))
  return values.every((v): v is number => typeof v === 'number') ? values : undefined
}

function CategoryDialog({ category, onClose }: { category?: CalibrationCategory; onClose: () => void }) {
  const { toast } = useApp()
  const save = useSaveCalibrationCategory(category?.id)
  const [f, setF] = useState(() => ({
    name: category?.name ?? '', codePrefix: category?.codePrefix ?? '', intervalMonths: String(category?.intervalMonths ?? 12), kind: (category?.kind ?? 'internal') as CalibrationKind,
    resolution: category?.resolution ?? '', tolerance: numberText(category?.tolerance), unit: category?.unit ?? 'mm', reference: { ...EMPTY_REFERENCE, ...category?.reference },
    groups: (category?.template ?? []).map((g) => ({ name: g.name, nominals: g.nominals.join(', ') })),
  }))
  const set = (patch: Partial<typeof f>) => setF((x) => ({ ...x, ...patch }))
  const months = Number(f.intervalMonths)
  const tolerance = parseNumber(f.tolerance)
  const groups = f.groups.map((g) => ({ name: g.name.trim(), nominals: parseNominals(g.nominals) }))
  const bad = !f.name.trim() || !/^[A-Za-z]{0,4}$/.test(f.codePrefix.trim()) || !(Number.isInteger(months) && months >= 1 && months <= MAX_INTERVAL_MONTHS) || tolerance === undefined
    || groups.some((g) => !g.name || !g.nominals)
  async function submit() {
    const body: CalibrationCategoryInput = {
      name: f.name.trim(), codePrefix: f.codePrefix.trim().toUpperCase(), intervalMonths: months, kind: f.kind, resolution: f.resolution.trim(), tolerance: tolerance ?? null, unit: f.unit.trim(),
      template: groups.map((g) => ({ name: g.name, nominals: g.nominals ?? [] })), reference: f.reference,
    }
    try { await save.mutateAsync(body); toast('Saved.', 'success'); onClose() } catch (error) { toast(error instanceof Error ? error.message : 'Could not save.', 'error') }
  }
  const ref = (key: keyof typeof EMPTY_REFERENCE, label: string) => <label className="block"><span className="label">{label}</span><input dir="auto" className="input" maxLength={200} value={f.reference[key]} onChange={(e) => set({ reference: { ...f.reference, [key]: e.target.value } })} /></label>
  return <Modal open size="xl" title={category ? `Edit ${category.name}` : 'New category'} onClose={onClose} footer={<>
    <Button variant="ghost" onClick={onClose}>Cancel</Button>
    <Button variant="primary" disabled={bad || save.isPending} onClick={() => void submit()}>{save.isPending && <Loader2 className="h-4 w-4 animate-spin" />}Save</Button>
  </>}>
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="block sm:col-span-2"><span className="label">Name</span><input dir="auto" className="input" maxLength={120} value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="باكوليس / Vernier caliper" /></label>
        <label className="block"><span className="label">Code prefix</span><input dir="ltr" className="input uppercase" maxLength={4} value={f.codePrefix} aria-invalid={!/^[A-Za-z]{0,4}$/.test(f.codePrefix.trim()) || undefined} onChange={(e) => set({ codePrefix: e.target.value })} placeholder="V" /></label>
        <label className="block"><span className="label">Usual interval</span>
          <select className="input" value={INTERVAL_PRESETS.some((p) => p.months === months) ? f.intervalMonths : ''} onChange={(e) => e.target.value && set({ intervalMonths: e.target.value })}>
            {!INTERVAL_PRESETS.some((p) => p.months === months) && <option value="">{intervalLabel(months)}</option>}
            {INTERVAL_PRESETS.map((p) => <option key={p.months} value={p.months}>{p.label}</option>)}
          </select>
        </label>
        <label className="block"><span className="label">Usual kind</span>
          <select className="input" value={f.kind} onChange={(e) => set({ kind: e.target.value as CalibrationKind })}>{CALIBRATION_KINDS.map((k) => <option key={k} value={k}>{CALIBRATION_KIND_NAMES[k]}</option>)}</select>
        </label>
        <label className="block"><span className="label">Resolution</span><input className="input" maxLength={60} value={f.resolution} onChange={(e) => set({ resolution: e.target.value })} placeholder="0.02 mm" /></label>
        <label className="block"><span className="label">Allowed tolerance (±)</span><input inputMode="decimal" className="input tabular-nums" aria-invalid={tolerance === undefined || undefined} value={f.tolerance} onChange={(e) => set({ tolerance: e.target.value })} /></label>
        <label className="block"><span className="label">Unit</span><input className="input" maxLength={20} value={f.unit} onChange={(e) => set({ unit: e.target.value })} /></label>
      </div>
      <section className="space-y-2" aria-labelledby="cat-template">
        <h3 id="cat-template" className="text-sm font-semibold">Certificate template</h3>
        <p className="text-xs text-muted">The groups of readings a new certificate starts with, each with its nominal values (the reference’s values, separated by commas).</p>
        {f.groups.map((g, gi) => <div key={gi} className="flex flex-wrap items-start gap-2">
          <input dir="auto" aria-label={`Group ${gi + 1} name`} className="input min-w-[12rem] flex-1" maxLength={120} value={g.name} placeholder="القياسات الخارجية / External Measurements" onChange={(e) => set({ groups: f.groups.map((x, i) => (i === gi ? { ...x, name: e.target.value } : x)) })} />
          <input dir="ltr" aria-label={`Group ${gi + 1} nominal values`} className="input min-w-[12rem] flex-1 tabular-nums" value={g.nominals} aria-invalid={!parseNominals(g.nominals) || undefined} placeholder="11.5, 40, 70, 135" onChange={(e) => set({ groups: f.groups.map((x, i) => (i === gi ? { ...x, nominals: e.target.value } : x)) })} />
          <button type="button" className="btn-ghost h-11 min-h-0 px-2" aria-label={`Remove group ${gi + 1}`} onClick={() => set({ groups: f.groups.filter((_, i) => i !== gi) })}><Trash2 className="h-4 w-4" /></button>
        </div>)}
        {f.groups.length < MAX_GROUPS && <Button onClick={() => set({ groups: [...f.groups, { name: '', nominals: '' }] })}><Plus className="h-4 w-4" />Add a group</Button>}
      </section>
      <section className="space-y-2" aria-labelledby="cat-ref">
        <h3 id="cat-ref" className="text-sm font-semibold">Reference</h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {ref('name', 'Reference name')}{ref('manufacturer', 'Manufacturer')}{ref('serial', 'Serial No')}{ref('certificateNo', 'Its calibration certificate No')}{ref('body', 'Its calibration body')}
        </div>
      </section>
    </div>
  </Modal>
}

function Categories() {
  const { toast } = useApp()
  const options = useCalibrationOptions()
  const remove = useDeleteCalibrationCategory()
  const [editing, setEditing] = useState<CalibrationCategory | 'new' | null>(null)
  return <Card className="space-y-3 p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><h2 className="text-base font-semibold">Categories</h2><p className="text-sm text-muted">Each kind of instrument: its code prefix, usual interval and kind, and its certificate.</p></div>
      <Button variant="primary" onClick={() => setEditing('new')}><Plus className="h-4 w-4" />New category</Button>
    </div>
    <ScrollX label="Categories"><table className="w-full min-w-[640px] text-left text-sm">
      <thead className="text-xs text-muted"><tr>{['Name', 'Prefix', 'Interval', 'Kind', 'Resolution · tolerance', 'Certificate', ''].map((h, i) => <th key={i} scope="col" className="px-2 py-2 font-semibold">{h || <span className="sr-only">Actions</span>}</th>)}</tr></thead>
      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">{(options.data?.categories ?? []).map((c) => <tr key={c.id}>
        <td dir="auto" className="px-2 py-2 font-semibold">{c.name}</td>
        <td className="px-2 py-2" dir="ltr">{c.codePrefix || '—'}</td>
        <td className="px-2 py-2">{intervalLabel(c.intervalMonths)}</td>
        <td className="px-2 py-2">{CALIBRATION_KIND_NAMES[c.kind]}</td>
        <td className="px-2 py-2">{[c.resolution, c.tolerance !== null ? `± ${c.tolerance} ${c.unit}` : ''].filter(Boolean).join(' · ') || '—'}</td>
        <td className="px-2 py-2 text-xs text-muted">{c.template.length ? c.template.map((g) => `${g.nominals.length} × ${g.name.split('/').pop()?.trim()}`).join(', ') : 'Free readings'}</td>
        <td className="whitespace-nowrap px-2 py-2 text-end">
          <button type="button" className="btn-ghost h-9 min-h-0 px-2 touch:h-11" aria-label={`Edit ${c.name}`} onClick={() => setEditing(c)}><Pencil className="h-4 w-4" /></button>
          <button type="button" className="btn-ghost h-9 min-h-0 px-2 touch:h-11" aria-label={`Remove ${c.name}`} onClick={() => void remove.mutateAsync(c.id).then(() => toast('Removed.', 'success')).catch((e: Error) => toast(e.message, 'error'))}><Trash2 className="h-4 w-4" /></button>
        </td>
      </tr>)}</tbody>
    </table></ScrollX>
    {editing && <CategoryDialog category={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
  </Card>
}

function DepartmentRow({ department }: { department: CalibrationDepartment }) {
  const { toast } = useApp()
  const save = useSaveCalibrationDepartment(department.id)
  const remove = useDeleteCalibrationDepartment()
  const [name, setName] = useState(department.name)
  const [code, setCode] = useState(department.code)
  const changed = name.trim() !== department.name || code.trim().toUpperCase() !== department.code
  return <li className="flex flex-wrap items-center gap-2 py-1.5">
    <input dir="auto" aria-label="Department name" className="input h-9 min-w-[10rem] flex-1 py-1" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
    <input dir="ltr" aria-label={`${department.name} code`} className="input h-9 w-28 py-1 uppercase" maxLength={12} placeholder="QC.01" value={code} onChange={(e) => setCode(e.target.value)} />
    {changed && <Button disabled={!name.trim() || save.isPending} onClick={() => void save.mutateAsync({ name: name.trim(), code: code.trim().toUpperCase() }).then(() => toast('Saved.', 'success')).catch((e: Error) => toast(e.message, 'error'))}>Save</Button>}
    <button type="button" className="btn-ghost h-9 min-h-0 px-2 touch:h-11" aria-label={`Remove ${department.name}`} onClick={() => void remove.mutateAsync(department.id).then(() => toast('Removed.', 'success')).catch((e: Error) => toast(e.message, 'error'))}><Trash2 className="h-4 w-4" /></button>
  </li>
}

function Departments() {
  const { toast } = useApp()
  const options = useCalibrationOptions()
  const add = useSaveCalibrationDepartment()
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  return <Card className="space-y-3 p-4">
    <div><h2 className="text-base font-semibold">Departments</h2><p className="text-sm text-muted">Where instruments are held, any sector of the factory, with the code their calibration codes carry (QC.01 of V.171.QC.01).</p></div>
    <ul className="divide-y divide-slate-100 dark:divide-slate-800">{(options.data?.departments ?? []).map((d) => <DepartmentRow key={`${d.id}:${d.name}:${d.code}`} department={d} />)}</ul>
    <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); void add.mutateAsync({ name: name.trim(), code: code.trim().toUpperCase() }).then(() => { setName(''); setCode(''); toast('Added.', 'success') }).catch((er: Error) => toast(er.message, 'error')) }}>
      <input dir="auto" className="input h-10 min-w-[10rem] flex-1 py-1" aria-label="New department" placeholder="Add a department…" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
      <input dir="ltr" className="input h-10 w-28 py-1 uppercase" aria-label="New department code" placeholder="Code" maxLength={12} value={code} onChange={(e) => setCode(e.target.value)} />
      <Button type="submit" disabled={!name.trim() || add.isPending}>Add</Button>
    </form>
  </Card>
}

type ImportKind = CalibrationImport['kind']
const IMPORTS: { kind: ImportKind; title: string; text: string; noun: string }[] = [
  { kind: 'register', title: 'The register (F-Q-05-01)', noun: 'instruments', text: 'Each row of its first sheet becomes an instrument: its department (added when new), category (from its code’s prefix or its name), holder, kind, code and last calibration; the interval is the months between its two dates; KPI هالك is scrapped. An instrument in use is known by its code: importing again adds only what is new.' },
  { kind: 'certificates', title: 'The certificates log', noun: 'certificates', text: 'Each row becomes a certificate of the instrument with its calibration code, with its readings in their groups; an instrument moves on to its latest. Import the register first: a code not in the plan is left out.' },
  { kind: 'scrap', title: 'The scrap form (F-Q-05-03)', noun: 'scrappings', text: 'Each row scraps the instrument of the same name, holder and received day on its day; one not in the plan is added as scrapped, for the record.' },
]

function ImportWorkbook({ kind, title, text, noun }: (typeof IMPORTS)[number]) {
  const { toast } = useApp()
  const invalidate = useInvalidateCalibration()
  const input = useRef<HTMLInputElement>(null)
  const [read, setRead] = useState<{ name: string; rows: CalibrationImport['rows']; skipped: number } | null>(null)
  const [progress, setProgress] = useState<CalibrationImportResult & { done: number } | null>(null)
  const [running, setRunning] = useState(false)
  async function pick(file: File | undefined) {
    if (!file) return
    try {
      const rows = readWorkbook(new Uint8Array(await file.arrayBuffer())).sheets[0]?.rows ?? []
      const parsed = kind === 'register' ? parseCalibrationRegister(rows) : kind === 'certificates' ? parseCalibrationCertificateLog(rows) : parseCalibrationScrapLog(rows)
      if (!parsed.rows.length) toast('Nothing to import was found on the workbook’s first sheet: is it the right workbook?', 'error')
      setRead({ name: file.name, ...parsed })
      setProgress(null)
    } catch (error) { toast(error instanceof WorkbookReadError || error instanceof Error ? error.message : 'The workbook could not be read.', 'error') }
    finally { if (input.current) input.current.value = '' }
  }
  async function run() {
    if (!read) return
    setRunning(true)
    const total = { created: 0, updated: 0, existing: 0, unmatched: 0, done: 0 }
    try {
      for (const part of chunk(read.rows as unknown[], CALIBRATION_IMPORT_CHUNK)) {
        const r = await importCalibration({ kind, rows: part } as CalibrationImport)
        total.created += r.created; total.updated += r.updated; total.existing += r.existing; total.unmatched += r.unmatched; total.done += part.length
        setProgress({ ...total })
      }
      toast(`${total.created.toLocaleString()} added${total.updated ? `, ${total.updated.toLocaleString()} updated` : ''}; ${total.existing.toLocaleString()} already there${total.unmatched ? `; ${total.unmatched.toLocaleString()} not matched` : ''}.`, 'success')
    } catch (error) { toast(error instanceof Error ? error.message : 'The import stopped.', 'error') }
    finally { setRunning(false); void invalidate() }
  }
  return <div className="space-y-2 rounded-xl border border-slate-200 p-3 dark:border-slate-700">
    <h3 className="text-sm font-semibold">{title}</h3>
    <p className="text-sm text-muted">{text}</p>
    <input ref={input} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="sr-only" aria-label={`Choose ${title}`} onChange={(e) => void pick(e.target.files?.[0])} />
    <div className="flex flex-wrap items-center gap-2">
      <Button disabled={running} onClick={() => input.current?.click()}><FileUp className="h-4 w-4" />Choose the workbook</Button>
      {read && read.rows.length > 0 && <Button variant="primary" disabled={running} onClick={() => void run()}>{running && <Loader2 className="h-4 w-4 animate-spin" />}Import {read.rows.length.toLocaleString()} {noun}</Button>}
    </div>
    {read && <p className="text-sm" aria-live="polite">{read.name}: {read.rows.length.toLocaleString()} {noun} found{read.skipped ? `, ${read.skipped.toLocaleString()} rows left out` : ''}.
      {progress && ` ${progress.done.toLocaleString()} sent: ${progress.created.toLocaleString()} added, ${progress.updated.toLocaleString()} updated, ${progress.existing.toLocaleString()} already there${progress.unmatched ? `, ${progress.unmatched.toLocaleString()} not matched` : ''}.`}</p>}
  </div>
}

export function CalibrationSetup() {
  return <div className="space-y-4">
    <Categories />
    <Departments />
    <Card className="space-y-3 p-4">
      <h2 className="text-base font-semibold">Import the old workbooks</h2>
      {IMPORTS.map((i) => <ImportWorkbook key={i.kind} {...i} />)}
    </Card>
  </div>
}
