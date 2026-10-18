// ============================================================================
// Where a report's values go in one of the company's Excel forms. On the
// left, the form's sheet as the app read it — its cells with text, its merged
// ranges — with what is mapped marked on it (a cell blue, a table's rows
// green); a click on a cell picks it. On the right, the mapping: single cells
// (a field of the report, one of its inputs, a value or a total of a
// section, or text), and tables (a section's rows from a starting row, and
// what happens when they are more than the form holds: rows inserted, or
// the sheet copied page after page). The assistant proposes one from the
// sheet and the columns the report showed in the run on screen; what is
// wrong with it, against the form and the report, is said as it is edited.
// ============================================================================

import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2, Plus, Sparkles, Trash2 } from 'lucide-react'
import {
  REPORT_FORM_AGGREGATES,
  REPORT_FORM_FIELDS,
  REPORT_FORM_FIELD_NAMES,
  REPORT_FORM_MAX_CELLS,
  REPORT_FORM_MAX_TABLES,
  columnName,
  isHexColor,
  parseCellRef,
  reportFormMappingProblems,
  type ReportForm,
  type ReportFormAggregate,
  type ReportFormField,
  type ReportFormMapping,
  type ReportFormTable,
  type ReportFormValue,
} from '@qc/shared/reportStyles'
import type { AiReport } from '@qc/shared/ai'
import { Button, Field, Input, Modal, Select } from '@/components/ui'
import { cn } from '@/lib/utils'
import { saveReportForm, suggestReportForm } from '@/services/reportStyles'
import { useApp } from '@/store/AppContext'

/** Rows and columns of the sheet shown: a form's head, table and foot fit; past them the sheet is as it is. */
const GRID_ROWS = 60
const GRID_COLS = 16

const AGGREGATE_NAMES: Record<ReportFormAggregate, string> = {
  first: 'Its first row’s value',
  sum: 'Sum of all rows',
  count: 'Count of rows',
  average: 'Average',
  min: 'Smallest',
  max: 'Largest',
}

const emptyMapping = (form: ReportForm): ReportFormMapping => ({ sheet: form.sheets[0]?.name ?? '', cells: [], tables: [] })

export function FormMapper({
  form,
  report,
  columns,
  onClose,
}: {
  form: ReportForm
  report: AiReport
  /** The columns each section showed in the run on screen; null for one not run, or failed. */
  columns: (string[] | null)[]
  onClose: () => void
}) {
  const qc = useQueryClient()
  const { toast } = useApp()
  const [name, setName] = useState(form.name)
  const [mapping, setMapping] = useState<ReportFormMapping>(form.mapping ?? emptyMapping(form))
  const [picked, setPicked] = useState<string | null>(null)
  const [suggesting, setSuggesting] = useState(false)
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)

  const sheet = form.sheets.find((s) => s.name === mapping.sheet) ?? form.sheets[0]
  const sections = report.sections.map((s, i) => ({ title: s.title, columns: columns[i] ?? null }))
  const inputNames = report.inputs.map((i) => i.name)
  const problems = useMemo(() => reportFormMappingProblems(mapping, form.sheets, sections, inputNames), [mapping, form.sheets, sections, inputNames])

  const suggest = async () => {
    setSuggesting(true)
    setNotes('')
    try {
      const res = await suggestReportForm(form.id, columns)
      setMapping(res.mapping)
      setNotes(res.notes || 'Done. Check each value against the form, then save.')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'The assistant could not match the form.', 'error')
    } finally {
      setSuggesting(false)
    }
  }

  const save = async () => {
    setSaving(true)
    try {
      await saveReportForm(qc, form, name.trim(), mapping.cells.length === 0 && mapping.tables.length === 0 ? null : mapping)
      toast('The form is saved.', 'success')
      onClose()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'The form could not be saved.', 'error')
    } finally {
      setSaving(false)
    }
  }

  const setCell = (i: number, next: ReportFormMapping['cells'][number] | null) =>
    setMapping((m) => ({ ...m, cells: next ? m.cells.map((c, k) => (k === i ? next : c)) : m.cells.filter((_, k) => k !== i) }))
  const setTable = (i: number, next: ReportFormTable | null) =>
    setMapping((m) => ({ ...m, tables: next ? m.tables.map((t, k) => (k === i ? next : t)) : m.tables.filter((_, k) => k !== i) }))
  const firstSection = report.sections.length > 0 ? 0 : -1
  const columnsOf = (section: number) => columns[section] ?? []

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title="Where the report’s values go"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()} disabled={saving || !name.trim() || problems.length > 0}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">
            <Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} dir="auto" />
          </Field>
          <Field label="Sheet to fill">
            <Select value={mapping.sheet} onChange={(e) => setMapping({ ...mapping, sheet: e.target.value })}>
              {form.sheets.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="flex flex-wrap items-center gap-2 rounded-xl bg-violet-50/60 p-3 ring-1 ring-violet-200 dark:bg-violet-500/5 dark:ring-violet-500/30">
          <Button variant="primary" className="min-h-[40px]" onClick={() => void suggest()} disabled={suggesting || columns.every((c) => !c)}>
            {suggesting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} {suggesting ? 'Matching…' : 'Let the assistant match it'}
          </Button>
          <p dir="auto" className="min-w-0 flex-1 text-13 text-violet-900 dark:text-violet-200">
            {notes || (columns.every((c) => !c) ? 'Run the report first: the form is matched to the columns it shows.' : 'It reads the form’s labels and the report’s columns, in English or Arabic.')}
          </p>
        </div>

        {sheet && <SheetGrid sheet={sheet} mapping={mapping} picked={picked} onPick={setPicked} />}

        <section className="space-y-2">
          <div className="flex items-center gap-2">
            <h3 className="min-w-0 flex-1 text-sm font-bold">Cells</h3>
            <Button
              className="h-8 min-h-0 gap-1.5 px-2.5 py-0 text-xs touch:h-11"
              disabled={mapping.cells.length >= REPORT_FORM_MAX_CELLS}
              onClick={() => setMapping((m) => ({ ...m, cells: [...m.cells, { ref: picked ?? '', value: { kind: 'field', field: 'ran.day' } }] }))}
            >
              <Plus className="h-3.5 w-3.5" /> Add a cell{picked ? ` (${picked})` : ''}
            </Button>
          </div>
          {mapping.cells.length === 0 && <p className="text-13 text-muted">A date, an order number, a total: one value each.</p>}
          {mapping.cells.map((c, i) => (
            <div key={i} className="flex flex-wrap items-end gap-2 rounded-lg bg-slate-50 p-2 dark:bg-slate-800/50">
              <Field label="Cell">
                <Input value={c.ref} onChange={(e) => setCell(i, { ...c, ref: e.target.value.toUpperCase() })} className="w-20 font-mono" placeholder="C3" />
              </Field>
              <ValueEditor value={c.value} report={report} columnsOf={columnsOf} firstSection={firstSection} onChange={(value) => setCell(i, { ...c, value })} />
              <button type="button" className="icon-btn h-10 w-10 hover:text-rose-600" onClick={() => setCell(i, null)} aria-label="Remove the cell">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </section>

        <section className="space-y-2">
          <div className="flex items-center gap-2">
            <h3 className="min-w-0 flex-1 text-sm font-bold">Tables</h3>
            <Button
              className="h-8 min-h-0 gap-1.5 px-2.5 py-0 text-xs touch:h-11"
              disabled={mapping.tables.length >= REPORT_FORM_MAX_TABLES || firstSection < 0}
              onClick={() =>
                setMapping((m) => ({
                  ...m,
                  tables: [
                    ...m.tables,
                    { section: 0, startRow: picked ? (parseCellRef(picked)?.row ?? 1) : 1, overflow: m.tables[0]?.overflow ?? 'insert', ...(m.tables[0]?.overflow === 'next-sheet' ? { lastRow: (parseCellRef(picked ?? '')?.row ?? 1) + 19 } : {}), columns: [] },
                  ],
                }))
              }
            >
              <Plus className="h-3.5 w-3.5" /> Add a table
            </Button>
          </div>
          {mapping.tables.length === 0 && <p className="text-13 text-muted">A section’s rows, one per row of the form, from a starting row.</p>}
          {mapping.tables.map((t, i) => (
            <TableEditor key={i} table={t} report={report} columnsOf={columnsOf} onChange={(next) => setTable(i, next)} />
          ))}
        </section>

        {problems.length > 0 && (
          <ul className="space-y-1 rounded-lg bg-amber-50 p-3 text-13 text-amber-900 ring-1 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-200 dark:ring-amber-500/30">
            {problems.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  )
}

function ValueEditor({
  value,
  report,
  columnsOf,
  firstSection,
  onChange,
}: {
  value: ReportFormValue
  report: AiReport
  columnsOf: (section: number) => string[]
  firstSection: number
  onChange: (v: ReportFormValue) => void
}) {
  const kind = (k: ReportFormValue['kind']) => {
    if (k === 'field') onChange({ kind: 'field', field: 'ran.day' })
    else if (k === 'input') onChange({ kind: 'input', name: report.inputs[0]?.name ?? '' })
    else if (k === 'section') onChange({ kind: 'section', section: Math.max(0, firstSection), column: columnsOf(Math.max(0, firstSection))[0] ?? '', aggregate: 'first' })
    else onChange({ kind: 'text', text: '' })
  }
  return (
    <>
      <Field label="Takes">
        <Select value={value.kind} onChange={(e) => kind(e.target.value as ReportFormValue['kind'])} className="w-auto">
          <option value="field">A field of the report</option>
          {report.inputs.length > 0 && <option value="input">One of its inputs</option>}
          {firstSection >= 0 && <option value="section">A section’s value</option>}
          <option value="text">Text</option>
        </Select>
      </Field>
      {value.kind === 'field' && (
        <Field label="Field">
          <Select value={value.field} onChange={(e) => onChange({ kind: 'field', field: e.target.value as ReportFormField })} className="w-auto">
            {REPORT_FORM_FIELDS.map((f) => (
              <option key={f} value={f}>
                {REPORT_FORM_FIELD_NAMES[f]}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {value.kind === 'input' && (
        <Field label="Input">
          <Select value={value.name} onChange={(e) => onChange({ kind: 'input', name: e.target.value })} className="w-auto">
            {report.inputs.map((i) => (
              <option key={i.name} value={i.name}>
                {i.label}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {value.kind === 'section' && (
        <>
          <SectionPick report={report} value={value.section} onChange={(section) => onChange({ ...value, section, column: columnsOf(section)[0] ?? value.column })} />
          <ColumnPick columns={columnsOf(value.section)} value={value.column} onChange={(column) => onChange({ ...value, column })} />
          <Field label="Which">
            <Select value={value.aggregate} onChange={(e) => onChange({ ...value, aggregate: e.target.value as ReportFormAggregate })} className="w-auto">
              {REPORT_FORM_AGGREGATES.map((a) => (
                <option key={a} value={a}>
                  {AGGREGATE_NAMES[a]}
                </option>
              ))}
            </Select>
          </Field>
        </>
      )}
      {value.kind === 'text' && (
        <Field label="Text">
          <Input value={value.text} maxLength={500} onChange={(e) => onChange({ kind: 'text', text: e.target.value })} dir="auto" />
        </Field>
      )}
    </>
  )
}

function SectionPick({ report, value, onChange }: { report: AiReport; value: number; onChange: (section: number) => void }) {
  return (
    <Field label="Section">
      <Select value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-auto max-w-[16rem]">
        {report.sections.map((s, i) => (
          <option key={i} value={i}>
            {i + 1}. {s.title}
          </option>
        ))}
      </Select>
    </Field>
  )
}

/** A section's column: one of those the run showed, or as typed when the section has not run. */
function ColumnPick({ columns, value, onChange }: { columns: string[]; value: string; onChange: (column: string) => void }) {
  return (
    <Field label="Column">
      {columns.length > 0 ? (
        <Select value={value} onChange={(e) => onChange(e.target.value)} className="w-auto max-w-[14rem]">
          {!columns.includes(value) && <option value={value}>{value || '—'}</option>}
          {columns.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
      ) : (
        <Input value={value} onChange={(e) => onChange(e.target.value)} className="w-40" />
      )}
    </Field>
  )
}

function TableEditor({ table: t, report, columnsOf, onChange }: { table: ReportFormTable; report: AiReport; columnsOf: (section: number) => string[]; onChange: (t: ReportFormTable | null) => void }) {
  const available = columnsOf(t.section)
  return (
    <div className="space-y-2 rounded-lg bg-emerald-50/60 p-3 ring-1 ring-emerald-200 dark:bg-emerald-500/5 dark:ring-emerald-500/30">
      <div className="flex flex-wrap items-end gap-2">
        <SectionPick report={report} value={t.section} onChange={(section) => onChange({ ...t, section, columns: [] })} />
        <Field label="First row">
          <Input type="number" min={1} value={t.startRow} onChange={(e) => onChange({ ...t, startRow: Number(e.target.value) || 1 })} className="w-24" />
        </Field>
        <Field label="When there are more rows">
          <Select
            value={t.overflow}
            onChange={(e) => {
              const overflow = e.target.value as ReportFormTable['overflow']
              const { lastRow: _last, ...rest } = t
              onChange(overflow === 'next-sheet' ? { ...rest, overflow, lastRow: t.lastRow ?? t.startRow + 19 } : { ...rest, overflow })
            }}
            className="w-auto"
          >
            <option value="insert">Insert rows (what is below moves down)</option>
            <option value="next-sheet">Carry on to a copy of the sheet</option>
          </Select>
        </Field>
        {t.overflow === 'next-sheet' && (
          <Field label="Last row of the form">
            <Input type="number" min={t.startRow} value={t.lastRow ?? t.startRow} onChange={(e) => onChange({ ...t, lastRow: Number(e.target.value) || t.startRow })} className="w-24" />
          </Field>
        )}
        <button type="button" className="icon-btn ms-auto h-10 w-10 hover:text-rose-600" onClick={() => onChange(null)} aria-label="Remove the table">
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
      <div className="space-y-1.5">
        {t.columns.map((c, k) => (
          <div key={k} className="flex flex-wrap items-end gap-2">
            <Field label="Form column">
              <Input value={c.col} maxLength={3} onChange={(e) => onChange({ ...t, columns: t.columns.map((x, j) => (j === k ? { ...x, col: e.target.value.toUpperCase() } : x)) })} className="w-20 font-mono" placeholder="B" />
            </Field>
            <ColumnPick columns={available} value={c.column} onChange={(column) => onChange({ ...t, columns: t.columns.map((x, j) => (j === k ? { ...x, column } : x)) })} />
            <button type="button" className="icon-btn h-10 w-10 hover:text-rose-600" onClick={() => onChange({ ...t, columns: t.columns.filter((_, j) => j !== k) })} aria-label="Remove the column">
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
        <Button
          className="h-8 min-h-0 gap-1.5 px-2.5 py-0 text-xs touch:h-11"
          onClick={() => onChange({ ...t, columns: [...t.columns, { col: columnName(Math.min(16_384, t.columns.length + 1)), column: available[t.columns.length] ?? available[0] ?? '' }] })}
        >
          <Plus className="h-3.5 w-3.5" /> Add a column
        </Button>
      </div>
    </div>
  )
}

/** The form's sheet as read, what is mapped marked on it; a click picks a cell. */
function SheetGrid({ sheet, mapping, picked, onPick }: { sheet: ReportForm['sheets'][number]; mapping: ReportFormMapping; picked: string | null; onPick: (ref: string) => void }) {
  const rows = Math.min(GRID_ROWS, Math.max(sheet.rowCount, 12))
  const cols = Math.min(GRID_COLS, Math.max(sheet.columnCount, 6))
  const byRef = useMemo(() => new Map(sheet.cells.map((c) => [c.ref, c])), [sheet])
  const mapped = useMemo(() => new Set(mapping.sheet === sheet.name ? mapping.cells.map((c) => c.ref.toUpperCase()) : []), [mapping, sheet.name])
  const inTable = (row: number, col: number) =>
    mapping.sheet === sheet.name &&
    mapping.tables.some((t) => row >= t.startRow && row <= (t.overflow === 'next-sheet' ? (t.lastRow ?? t.startRow) : t.startRow) && t.columns.some((c) => parseCellRef(`${c.col}1`)?.col === col))
  return (
    <div className="max-h-[22rem] overflow-auto rounded-lg ring-1 ring-slate-200 dark:ring-slate-700">
      <table className="border-collapse text-[11px]">
        <thead className="sticky top-0 z-10 bg-slate-100 dark:bg-slate-800">
          <tr>
            <th className="w-8 border border-slate-200 px-1 dark:border-slate-700" />
            {Array.from({ length: cols }, (_, c) => (
              <th key={c} className="min-w-[4.5rem] border border-slate-200 px-1 font-semibold text-muted dark:border-slate-700">
                {columnName(c + 1)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }, (_, r) => (
            <tr key={r}>
              <th className="sticky left-0 border border-slate-200 bg-slate-100 px-1 font-semibold text-muted dark:border-slate-700 dark:bg-slate-800">{r + 1}</th>
              {Array.from({ length: cols }, (_, c) => {
                const ref = `${columnName(c + 1)}${r + 1}`
                const cell = byRef.get(ref)
                return (
                  <td
                    key={c}
                    onClick={() => onPick(ref)}
                    dir="auto"
                    className={cn(
                      'max-w-[10rem] cursor-pointer truncate border border-slate-200 px-1 py-0.5 dark:border-slate-700',
                      cell?.bold && 'font-bold',
                      mapped.has(ref) && 'bg-blue-100 ring-1 ring-inset ring-blue-400 dark:bg-blue-500/20',
                      !mapped.has(ref) && inTable(r + 1, c + 1) && 'bg-emerald-100 dark:bg-emerald-500/20',
                      picked === ref && 'outline outline-2 outline-violet-500',
                    )}
                    style={cell?.fill && isHexColor(cell.fill) && !mapped.has(ref) && !inTable(r + 1, c + 1) ? { background: cell.fill } : undefined}
                    title={cell?.text}
                  >
                    {cell?.text ?? ''}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
