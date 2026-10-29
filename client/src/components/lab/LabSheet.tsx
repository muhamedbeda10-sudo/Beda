// ============================================================================
// §26 — The Material Testing Report (form F-Q-02-20), drawn as the paper and
// its workbook lay it out: the letterhead, the test's particulars two to a
// row, the Standard Limits and Test Results bands, three samples and their
// average, the machine's curve, the hardness test, and the document control
// at the foot. Filled in place (mode "edit"), read (mode "view") or printed
// (mode "paper"); what the workbook worked out with its formulas is worked
// out here and cannot be typed over.
// ============================================================================

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { LAB_FORM, LAB_SPECIMENS, LAB_TEST_TYPE, HARDNESS_STANDARD, SPECIMEN_INFO, rangeText, withinLimits, type LabGrade, type LabList, type LabListValue, type LabFormReference } from '@qc/shared/lab'
import { PRINT_PENDING_ATTR } from '@/components/print/usePrint'
import { useImages } from '@/services/queries'
import { resolveImageUrl } from '@/services/uploadImage'
import { cn } from '@/lib/utils'
import type { LabDraft, LabWorking } from './labDraft'

export type LabSheetMode = 'edit' | 'view' | 'paper'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** A day as the workbook writes it: 9-Sep-26. */
export const sheetDay = (day: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  return m ? `${Number(m[3])}-${MONTHS[Number(m[2]) - 1]}-${m[1].slice(2)}` : day
}
/** The form's issue date as its foot writes it: 23/12/2024. */
const footDay = (day: string) => day.replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$3/$2/$1')

const fmt = (v: number | null, digits = 1) => (v === null || v === undefined ? '' : Number(v.toFixed(digits)).toString())

const border = 'border border-slate-400 dark:border-slate-600'
const head = cn(border, 'bg-slate-50 px-2 py-1.5 text-[13px] font-bold text-slate-900 dark:bg-slate-800/70 dark:text-slate-100')
const cell = cn(border, 'px-2 py-1.5 text-sm text-slate-900 dark:text-slate-100')
const band = cn(border, 'bg-yellow-300 px-2 py-1 text-center text-sm font-bold text-slate-900')
/** A result outside the limits is marked, not only coloured (WCAG 1.4.1). */
export const OutMark = ({ ok }: { ok: boolean | null }) => (ok === false ? <><span aria-hidden className="ms-1 font-bold">✕</span><span className="sr-only"> (out of limits)</span></> : null)
const toneOf = (ok: boolean | null) => (ok === false ? 'bg-danger-50 text-danger-800 dark:bg-danger-500/15 dark:text-danger-300' : ok === true ? 'bg-success-50 text-success-800 dark:bg-success-500/10 dark:text-success-300' : '')

/** A cell's control: a select of a list, the value typed when it is not on it, or "Other…" to type one. */
function ListInput({ id, value, values, onChange, label, placeholder }: { id: string; value: string; values: string[]; onChange: (v: string) => void; label: string; placeholder?: string }) {
  const listed = values.some((v) => v.toLowerCase() === value.toLowerCase())
  const [typing, setTyping] = useState(false)
  useEffect(() => { if (!value) setTyping(false) }, [value])
  if (typing || !values.length) {
    return <div className="flex gap-1">
      <input id={id} aria-label={label} dir="auto" className="input h-9 py-1" value={value} placeholder={placeholder} maxLength={120} onChange={(e) => onChange(e.target.value)} />
      {values.length > 0 && <button type="button" className="btn-ghost h-9 min-h-0 shrink-0 px-2 text-xs touch:h-11" onClick={() => { setTyping(false); if (!listed) onChange('') }}>List</button>}
    </div>
  }
  return <select id={id} aria-label={label} className="input h-9 py-1 pr-8" value={listed ? values.find((v) => v.toLowerCase() === value.toLowerCase()) : value}
    onChange={(e) => { if (e.target.value === '\u0000other') { setTyping(true); onChange('') } else onChange(e.target.value) }}>
    <option value="">—</option>
    {!listed && value && <option value={value}>{value} (not on the list)</option>}
    {values.map((v) => <option key={v} value={v}>{v}</option>)}
    <option value={'\u0000other'}>Other…</option>
  </select>
}

function NumberInput({ value, onChange, label, ok }: { value: string; onChange: (v: string) => void; label: string; ok?: boolean | null }) {
  return <input aria-label={label} inputMode="decimal" className={cn('input h-9 py-1 text-center tabular-nums', ok === false && 'border-danger-500 ring-1 ring-danger-500 dark:border-danger-400')} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={ok === false || undefined} />
}

/** The machine's curve and any other photo, at full size on the report. */
function SheetImages({ ids, paper }: { ids: string[]; paper: boolean }) {
  const { data: assets, isFetched } = useImages(ids)
  const [urls, setUrls] = useState<Record<string, string | null>>({})
  useEffect(() => {
    let cancelled = false
    for (const a of assets ?? []) {
      if (a.id in urls) continue
      resolveImageUrl(a).then((u) => !cancelled && setUrls((m) => ({ ...m, [a.id]: u || null }))).catch(() => !cancelled && setUrls((m) => ({ ...m, [a.id]: null })))
    }
    return () => { cancelled = true }
  }, [assets, urls])
  const ready = isFetched && (assets ?? []).every((a) => a.id in urls)
  return <div className="flex flex-wrap justify-center gap-3" {...(paper && !ready ? { [PRINT_PENDING_ATTR]: '' } : {})}>
    {ids.map((id) => urls[id] ? <img key={id} src={urls[id]!} alt="Stress–elongation curve" className="max-h-[420px] max-w-full object-contain" /> : null)}
  </div>
}

export interface LabSheetProps {
  mode: LabSheetMode
  data: LabDraft
  working: LabWorking
  onChange?: (patch: Partial<LabDraft>) => void
  lists?: LabListValue[]
  grades?: LabGrade[]
  /** The next number, shown while the certificate number is left to the app. */
  nextReference?: string
  /** Under the specimen code: what the coil register knows of it. */
  codeNote?: ReactNode
  /** The images' picker while the report is filled. */
  imagePicker?: ReactNode
  form?: LabFormReference
}

export function LabSheet({ mode, data, working, onChange, lists = [], grades = [], nextReference, codeNote, imagePicker, form = LAB_FORM }: LabSheetProps) {
  const edit = mode === 'edit' && !!onChange
  const set = (patch: Partial<LabDraft>) => onChange?.(patch)
  const info = SPECIMEN_INFO[data.specimenType]
  const listOf = (list: LabList) => lists.filter((l) => l.list === list).map((l) => l.value)
  const gradeNames = useMemo(() => Array.from(new Set(grades.filter((g) => g.family === info.family).map((g) => g.grade))), [grades, info.family])
  const { limits, judgement } = working
  const valueOf = (v: string, fallback = '—') => (v ? <span dir="auto">{v}</span> : <span className="text-muted">{fallback}</span>)

  /** A label and its value, two to a row from a tablet up, one on a phone. */
  const pair = (label: ReactNode, value: ReactNode, id?: string) => <>
    <div className={cn(head, 'col-span-2 flex flex-col justify-center sm:col-span-1')}>{id && edit ? <label htmlFor={id}>{label}</label> : label}</div>
    <div className={cn(cell, 'col-span-2 flex flex-col justify-center sm:col-span-1')}>{value}</div>
  </>

  const specimens = data.specimens
  const sampleCell = (i: number, key: 'tensile' | 'yield' | 'elongation', label: string) => {
    const raw = specimens[i]?.[key] ?? ''
    const n = raw.trim() ? Number(raw.replace(',', '.')) : null
    const ok = key === 'tensile' ? withinLimits(n, limits.tensileMin, limits.tensileMax) : key === 'yield' ? withinLimits(n, limits.yieldMin, limits.yieldMax) : withinLimits(n, limits.elongationMin, null)
    if (edit) return <div className={cn(cell, 'p-1')}><NumberInput label={`Sample ${i + 1} ${label}`} value={raw} ok={ok} onChange={(v) => set({ specimens: specimens.map((s, j) => (j === i ? { ...s, [key]: v } : s)) })} /></div>
    return <div className={cn(cell, 'flex items-center justify-center tabular-nums', toneOf(ok))}>{raw || ''}<OutMark ok={ok} /></div>
  }

  return <div className={cn('lab-sheet mx-auto w-full max-w-[860px] text-slate-900 dark:text-slate-100', mode === 'paper' && 'text-[12px]')}>
    {/* Letterhead */}
    <div className="grid grid-cols-[1fr_2fr_1fr] items-stretch">
      <div className={cn(border, 'flex items-center px-2 py-3 text-sm font-bold')}>Quality Department</div>
      <div className={cn(border, 'flex items-center justify-center px-2 py-3 text-center text-lg font-bold sm:text-xl')}><h2>Material Testing Report</h2></div>
      <div className={cn(border, 'flex items-center justify-center p-2')}><span className="rounded bg-white p-1"><img src="/brand/logo.svg" alt="Link Misr" className="h-8 w-auto max-w-full sm:h-10" /></span></div>
    </div>
    {/* Particulars */}
    <div className="grid grid-cols-2 sm:grid-cols-4">
      {pair('Date', edit ? <input id="lab-date" type="date" required className="input h-9 py-1" value={data.testDate} onChange={(e) => set({ testDate: e.target.value })} /> : sheetDay(data.testDate), 'lab-date')}
      {pair('Test Type', LAB_TEST_TYPE)}
      {pair('Specimen', edit ? <select id="lab-specimen" className="input h-9 py-1 pr-8" value={data.specimenType} onChange={(e) => {
        const next = e.target.value as LabDraft['specimenType']
        // Another family's size and grade lists: what was chosen from the old ones no longer applies.
        set(SPECIMEN_INFO[next].family === info.family ? { specimenType: next } : { specimenType: next, size: '', grade: '' })
      }}>{LAB_SPECIMENS.map((s) => <option key={s}>{s}</option>)}</select> : data.specimenType, 'lab-specimen')}
      {pair('Testing M/C', edit ? <ListInput id="lab-machine" label="Testing machine" value={data.machine} values={listOf('machine')} onChange={(machine) => set({ machine })} /> : valueOf(data.machine), 'lab-machine')}
      {pair('Specimen Code', edit ? <div className="space-y-1"><input id="lab-code" dir="auto" className="input h-9 py-1" maxLength={120} value={data.specimenCode} placeholder={info.family === 'sheet' ? 'Coil number' : 'Batch'} onChange={(e) => set({ specimenCode: e.target.value })} />{codeNote}</div> : <div>{valueOf(data.specimenCode)}{codeNote}</div>, 'lab-code')}
      {pair('Test Standard', valueOf(working.testStandard, 'N/A'))}
      {pair(working.sizeLabel, edit ? <ListInput id="lab-size" label={working.sizeLabel} value={data.size} values={listOf(info.sizeList)} onChange={(size) => set({ size })} /> : valueOf(data.size), 'lab-size')}
      {pair('Certificate No.', edit ? <input id="lab-reference" dir="auto" className="input h-9 py-1" maxLength={60} value={data.reference} placeholder={nextReference ? `${nextReference} (next)` : 'Next number'} onChange={(e) => set({ reference: e.target.value })} /> : valueOf(data.reference), 'lab-reference')}
      {pair('Material Grade', edit ? <ListInput id="lab-grade" label="Material grade" value={data.grade} values={gradeNames} onChange={(grade) => set({ grade })} placeholder={info.family === 'wire' ? 'FE360…' : undefined} /> : valueOf(data.grade), 'lab-grade')}
      {pair('Material Standard', valueOf(working.materialStandard, data.grade ? 'Not on the grades list' : '—'))}
    </div>
    {/* Standard limits */}
    <div className={band}>Standard Limits</div>
    <div className="grid grid-cols-3">
      <div className={cn(head, 'text-center')}>Tensile Strength (RM) N/mm²</div>
      <div className={cn(head, 'text-center')}>{limits.yieldMax !== null && limits.yieldMin === null ? 'Max.' : 'Min.'} Yield Strength N/mm²</div>
      <div className={cn(head, 'text-center')}>Elongation %</div>
      <div className={cn(cell, 'text-center tabular-nums')}>{rangeText(limits.tensileMin, limits.tensileMax) || '—'}</div>
      <div className={cn(cell, 'text-center tabular-nums')}>{rangeText(limits.yieldMin, limits.yieldMax, true) || '—'}</div>
      <div className={cn(cell, 'text-center tabular-nums')}>{rangeText(limits.elongationMin, null, true) || '—'}</div>
    </div>
    {/* Results */}
    <div className={band}>Test Results</div>
    <div className="grid grid-cols-[minmax(4.5rem,0.8fr)_1fr_1fr_1fr]">
      <div className={cn(head, 'text-center')}>Sample No.</div>
      <div className={cn(head, 'text-center')}>Tensile Stress (RM) N/mm²</div>
      <div className={cn(head, 'text-center')}>{limits.yieldMax !== null && limits.yieldMin === null ? 'Max.' : 'Min.'} Yield Stress N/mm²</div>
      <div className={cn(head, 'text-center')}>Elongation %</div>
      {specimens.map((_, i) => <div key={i} className="contents">
        <div className={cn(cell, 'flex items-center justify-center font-semibold')}>{i + 1}</div>
        {sampleCell(i, 'tensile', 'tensile stress')}
        {sampleCell(i, 'yield', 'yield stress')}
        {sampleCell(i, 'elongation', 'elongation')}
      </div>)}
      <div className={cn(head, 'text-center')}>Average</div>
      <div className={cn(cell, 'text-center font-bold tabular-nums', toneOf(judgement.tensileOk))}>{fmt(judgement.tensileAvg)}<OutMark ok={judgement.tensileOk} /></div>
      <div className={cn(cell, 'text-center font-bold tabular-nums', toneOf(judgement.yieldOk))}>{fmt(judgement.yieldAvg)}<OutMark ok={judgement.yieldOk} /></div>
      <div className={cn(cell, 'text-center font-bold tabular-nums', toneOf(judgement.elongationOk))}>{fmt(judgement.elongationAvg)}<OutMark ok={judgement.elongationOk} /></div>
    </div>
    {edit && <div className="flex justify-end border-x border-slate-400 px-2 py-1 dark:border-slate-600">
      {specimens.length < 10 && <button type="button" className="btn-ghost h-8 min-h-0 px-2 text-xs touch:h-11" onClick={() => set({ specimens: [...specimens, { tensile: '', yield: '', elongation: '' }] })}>Add a sample</button>}
      {specimens.length > 3 && <button type="button" className="btn-ghost h-8 min-h-0 px-2 text-xs touch:h-11" onClick={() => set({ specimens: specimens.slice(0, -1) })}>Remove the last</button>}
    </div>}
    {/* The machine's curve */}
    <div className={cn(border, 'min-h-[6rem] p-2')}>
      {edit ? imagePicker : data.imageIds.length ? <SheetImages ids={data.imageIds} paper={mode === 'paper'} /> : <p className="py-6 text-center text-xs text-muted">No curve attached.</p>}
    </div>
    {/* Hardness */}
    <div className={cn(head, 'text-base')}>Hardness Test</div>
    <div className="grid grid-cols-2 sm:grid-cols-4">
      {pair('Test Standard', HARDNESS_STANDARD)}
      {pair('Hardness Value', edit ? <input id="lab-hardness" inputMode="decimal" className="input h-9 py-1 text-center tabular-nums" value={data.hardness} onChange={(e) => set({ hardness: e.target.value })} /> : <span className="font-bold tabular-nums">{data.hardness || '—'}</span>, 'lab-hardness')}
      {pair('Indenter', edit ? <ListInput id="lab-indenter" label="Indenter" value={data.indenter} values={listOf('indenter')} onChange={(indenter) => set({ indenter })} /> : valueOf(data.indenter), 'lab-indenter')}
      {pair('Rockwell Scale', edit ? <ListInput id="lab-scale" label="Rockwell scale" value={data.hardnessScale} values={listOf('scale')} onChange={(hardnessScale) => set({ hardnessScale })} /> : valueOf(data.hardnessScale), 'lab-scale')}
    </div>
    {working.hardnessSpec && <p className={cn(border, 'border-t-0 px-2 py-1 text-xs text-muted')}>The grade expects {working.hardnessSpec}{data.hardnessScale ? ` (${data.hardnessScale})` : ''}.</p>}
    {/* Document control */}
    <div className="grid grid-cols-3 text-xs">
      <div className={cell}>Form Code {form.code}</div>
      <div className={cell}>Issue No. {form.issue}</div>
      <div className={cell}>Issue Date {footDay(form.issueDate)}</div>
    </div>
  </div>
}
