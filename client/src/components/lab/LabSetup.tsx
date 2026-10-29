// ============================================================================
// §26 — The lab's setup: each grade's limits (by thickness band where its
// standard splits them), the lists the report chooses from, and the machine
// log's workbook imported once (and again: only what is new is added).
// ============================================================================

import { useRef, useState } from 'react'
import { FileUp, Loader2, Pencil, Plus, Trash2, X } from 'lucide-react'
import { LAB_FAMILIES, LAB_FAMILY_NAMES, LAB_IMPORT_CHUNK, LAB_LISTS, LAB_LIST_NAMES, parseLabLog, rangeText, type LabFamily, type LabGrade, type LabGradeInput, type LabList, type LabLogRow } from '@qc/shared/lab'
import { Button, Card, Modal } from '@/components/ui'
import { ScrollX } from '@/components/ui/ScrollX'
import { isDecimalOrBlank, parseDecimal } from '@/lib/decimal'
import { readWorkbook, WorkbookReadError } from '@/lib/xlsx'
import { chunk } from '@/lib/utils'
import { importLabLog, useAddLabListValue, useDeleteLabGrade, useDeleteLabListValue, useInvalidateLab, useLabOptions, useSaveLabGrade } from '@/services/lab'
import { useApp } from '@/store/AppContext'

type NumKey = 'thicknessFrom' | 'thicknessTo' | 'yieldMin' | 'yieldMax' | 'tensileMin' | 'tensileMax' | 'elongationMin'
const NUMS: { key: NumKey; label: string }[] = [
  { key: 'thicknessFrom', label: 'Thickness from (mm, ≥)' },
  { key: 'thicknessTo', label: 'Thickness to (mm, <)' },
  { key: 'yieldMin', label: 'Yield min (N/mm²)' },
  { key: 'yieldMax', label: 'Yield max (N/mm²)' },
  { key: 'tensileMin', label: 'Tensile min (N/mm²)' },
  { key: 'tensileMax', label: 'Tensile max (N/mm²)' },
  { key: 'elongationMin', label: 'Elongation min (%)' },
]

function GradeDialog({ grade, family, onClose }: { grade?: LabGrade; family: LabFamily; onClose: () => void }) {
  const { toast } = useApp()
  const save = useSaveLabGrade(grade?.id)
  const [form, setForm] = useState(() => ({
    family: grade?.family ?? family, grade: grade?.grade ?? '', standard: grade?.standard ?? '', hardness: grade?.hardness ?? '',
    ...Object.fromEntries(NUMS.map(({ key }) => [key, grade?.[key] === null || grade?.[key] === undefined ? '' : String(grade[key])])) as Record<NumKey, string>,
  }))
  const bad = NUMS.filter(({ key }) => !isDecimalOrBlank(form[key]))
  async function submit() {
    const body: LabGradeInput = { family: form.family, grade: form.grade.trim(), standard: form.standard.trim(), hardness: form.hardness.trim(), ...Object.fromEntries(NUMS.map(({ key }) => [key, parseDecimal(form[key])])) as Record<NumKey, number | null> }
    try { await save.mutateAsync(body); toast('Saved.', 'success'); onClose() } catch (error) { toast(error instanceof Error ? error.message : 'Could not save.', 'error') }
  }
  return <Modal open size="lg" title={grade ? `Edit ${grade.grade}` : 'New grade'} onClose={onClose} footer={<>
    <Button variant="ghost" onClick={onClose}>Cancel</Button>
    <Button variant="primary" disabled={!form.grade.trim() || bad.length > 0 || save.isPending} onClick={() => void submit()}>{save.isPending && <Loader2 className="h-4 w-4 animate-spin" />}Save</Button>
  </>}>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="block"><span className="label">Family</span><select className="input" value={form.family} onChange={(e) => setForm({ ...form, family: e.target.value as LabFamily })}>{LAB_FAMILIES.map((f) => <option key={f} value={f}>{LAB_FAMILY_NAMES[f]}</option>)}</select></label>
      <label className="block"><span className="label">Grade</span><input className="input" maxLength={60} value={form.grade} onChange={(e) => setForm({ ...form, grade: e.target.value })} /></label>
      <label className="block"><span className="label">Standard</span><input className="input" maxLength={120} value={form.standard} onChange={(e) => setForm({ ...form, standard: e.target.value })} /></label>
      <label className="block"><span className="label">Hardness (as written)</span><input className="input" maxLength={60} value={form.hardness} onChange={(e) => setForm({ ...form, hardness: e.target.value })} /></label>
      {NUMS.map(({ key, label }) => <label key={key} className="block"><span className="label">{label}</span><input inputMode="decimal" className="input tabular-nums" aria-invalid={!isDecimalOrBlank(form[key]) || undefined} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} /></label>)}
    </div>
    <p className="mt-3 text-xs text-muted">Leave a limit empty when the standard sets none. A grade whose limits change with the thickness has one row per band: from is included, to is not (below 3 mm, then from 3 mm). A test keeps the limits it was judged by.</p>
    {bad.length > 0 && <p role="alert" className="mt-2 text-sm text-danger-600">Not a number: {bad.map((b) => b.label).join(', ')}.</p>}
  </Modal>
}

function Grades() {
  const { toast } = useApp()
  const options = useLabOptions()
  const remove = useDeleteLabGrade()
  const [editing, setEditing] = useState<{ grade?: LabGrade; family: LabFamily } | null>(null)
  const band = (g: LabGrade) => (g.thicknessFrom === null && g.thicknessTo === null ? 'All' : g.thicknessFrom === null ? `< ${g.thicknessTo} mm` : g.thicknessTo === null ? `≥ ${g.thicknessFrom} mm` : `${g.thicknessFrom}–${g.thicknessTo} mm`)
  async function del(g: LabGrade) {
    if (!window.confirm(`Remove ${g.grade} (${band(g)})? Tests already saved keep their limits.`)) return
    try { await remove.mutateAsync(g.id) } catch (error) { toast(error instanceof Error ? error.message : 'Could not remove.', 'error') }
  }
  return <Card className="space-y-3 p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-base font-semibold">Grades and their limits</h2>
      <Button onClick={() => setEditing({ family: 'sheet' })}><Plus className="h-4 w-4" />Add a grade</Button>
    </div>
    {!options.data ? <p className="text-sm text-muted">Loading…</p> : <ScrollX label="Grades"><table className="w-full min-w-[760px] text-left text-sm">
      <thead className="text-xs text-muted"><tr>{['Family', 'Grade', 'Standard', 'Thickness', 'Yield', 'Tensile', 'Elongation', 'Hardness', ''].map((h, i) => <th key={i} scope="col" className="border-b px-2 py-2 dark:border-slate-700">{h || <span className="sr-only">Actions</span>}</th>)}</tr></thead>
      <tbody>{options.data.grades.map((g) => <tr key={g.id} className="border-b border-slate-100 dark:border-slate-800">
        <td className="px-2 py-2">{LAB_FAMILY_NAMES[g.family]}</td>
        <td className="px-2 py-2 font-semibold">{g.grade}</td>
        <td className="px-2 py-2">{g.standard || '—'}</td>
        <td className="whitespace-nowrap px-2 py-2">{band(g)}</td>
        <td className="whitespace-nowrap px-2 py-2 tabular-nums">{rangeText(g.yieldMin, g.yieldMax) || '—'}</td>
        <td className="whitespace-nowrap px-2 py-2 tabular-nums">{rangeText(g.tensileMin, g.tensileMax) || '—'}</td>
        <td className="whitespace-nowrap px-2 py-2 tabular-nums">{rangeText(g.elongationMin, null) || '—'}</td>
        <td className="px-2 py-2">{g.hardness || '—'}</td>
        <td className="whitespace-nowrap px-2 py-2 text-right">
          <button type="button" className="btn-ghost h-9 min-h-0 px-2 touch:h-11" aria-label={`Edit ${g.grade} ${band(g)}`} onClick={() => setEditing({ grade: g, family: g.family })}><Pencil className="h-4 w-4" /></button>
          <button type="button" className="btn-ghost h-9 min-h-0 px-2 text-danger-700 touch:h-11 dark:text-danger-400" aria-label={`Remove ${g.grade} ${band(g)}`} onClick={() => void del(g)}><Trash2 className="h-4 w-4" /></button>
        </td>
      </tr>)}</tbody>
    </table></ScrollX>}
    {editing && <GradeDialog grade={editing.grade} family={editing.family} onClose={() => setEditing(null)} />}
  </Card>
}

function Lists() {
  const { toast } = useApp()
  const options = useLabOptions()
  const add = useAddLabListValue()
  const remove = useDeleteLabListValue()
  const [typed, setTyped] = useState<Partial<Record<LabList, string>>>({})
  async function addTo(list: LabList) {
    const value = (typed[list] ?? '').trim()
    if (!value) return
    try { await add.mutateAsync({ list, value }); setTyped((t) => ({ ...t, [list]: '' })) } catch (error) { toast(error instanceof Error ? error.message : 'Could not add.', 'error') }
  }
  return <Card className="space-y-3 p-4">
    <h2 className="text-base font-semibold">Lists</h2>
    <div className="grid gap-4 md:grid-cols-2">
      {LAB_LISTS.map((list) => <section key={list} aria-label={LAB_LIST_NAMES[list]} className="space-y-2">
        <h3 className="label">{LAB_LIST_NAMES[list]}</h3>
        <div className="flex flex-wrap gap-1.5">{(options.data?.lists ?? []).filter((l) => l.list === list).map((l) => <span key={l.id} className="inline-flex items-center gap-1 rounded-md bg-slate-100 py-0.5 pl-2 pr-0.5 text-sm dark:bg-slate-800">
          {l.value}<button type="button" className="rounded p-1.5 hover:bg-slate-200 dark:hover:bg-slate-700 touch:p-2.5" aria-label={`Remove ${l.value}`} onClick={() => void remove.mutateAsync(l.id).catch((e: Error) => toast(e.message, 'error'))}><X className="h-3.5 w-3.5" /></button>
        </span>)}</div>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void addTo(list) }}>
          <input className="input h-9 py-1" aria-label={`Add to ${LAB_LIST_NAMES[list]}`} placeholder="Add…" maxLength={120} value={typed[list] ?? ''} onChange={(e) => setTyped((t) => ({ ...t, [list]: e.target.value }))} />
          <Button type="submit" disabled={!(typed[list] ?? '').trim() || add.isPending}>Add</Button>
        </form>
      </section>)}
    </div>
  </Card>
}

function ImportLog() {
  const { toast } = useApp()
  const invalidate = useInvalidateLab()
  const input = useRef<HTMLInputElement>(null)
  const [read, setRead] = useState<{ name: string; tests: LabLogRow[]; skipped: number } | null>(null)
  const [progress, setProgress] = useState<{ done: number; created: number; existing: number } | null>(null)
  const [running, setRunning] = useState(false)

  async function pick(file: File | undefined) {
    if (!file) return
    try {
      const book = readWorkbook(new Uint8Array(await file.arrayBuffer()))
      const parsed = parseLabLog(book.sheets[0]?.rows ?? [])
      setRead({ name: file.name, ...parsed })
      setProgress(null)
    } catch (error) { toast(error instanceof WorkbookReadError || error instanceof Error ? error.message : 'The workbook could not be read.', 'error') }
    finally { if (input.current) input.current.value = '' }
  }
  async function run() {
    if (!read) return
    setRunning(true)
    let created = 0, existing = 0, done = 0
    try {
      for (const part of chunk(read.tests, LAB_IMPORT_CHUNK)) {
        const r = await importLabLog(part)
        created += r.created; existing += r.existing; done += part.length
        setProgress({ done, created, existing })
      }
      toast(`${created.toLocaleString()} tests imported; ${existing.toLocaleString()} were already in the lab.`, 'success')
    } catch (error) { toast(error instanceof Error ? error.message : 'The import stopped.', 'error') }
    finally { setRunning(false); void invalidate() }
  }
  return <Card className="space-y-3 p-4">
    <h2 className="text-base font-semibold">Import the machine log</h2>
    <p className="text-sm text-muted">The Tensile Test Machine Log workbook (.xlsx): each row with a date, a type and a result becomes a test, its averages as one sample. A number already in the lab is left as it is, so importing the log again adds only what is new, and new tests continue the year’s numbers.</p>
    <input ref={input} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="sr-only" aria-label="Choose the machine log workbook" onChange={(e) => void pick(e.target.files?.[0])} />
    <div className="flex flex-wrap items-center gap-2">
      <Button disabled={running} onClick={() => input.current?.click()}><FileUp className="h-4 w-4" />Choose the workbook</Button>
      {read && <Button variant="primary" disabled={running || !read.tests.length} onClick={() => void run()}>{running && <Loader2 className="h-4 w-4 animate-spin" />}Import {read.tests.length.toLocaleString()} tests</Button>}
    </div>
    {read && <p className="text-sm" aria-live="polite">{read.name}: {read.tests.length.toLocaleString()} tests found{read.skipped ? `, ${read.skipped.toLocaleString()} rows without a result left out` : ''}.{progress && ` ${progress.done.toLocaleString()} sent: ${progress.created.toLocaleString()} added, ${progress.existing.toLocaleString()} already there.`}</p>}
  </Card>
}

export function LabSetup() {
  return <div className="space-y-4">
    <Grades />
    <Lists />
    <ImportLog />
  </div>
}
