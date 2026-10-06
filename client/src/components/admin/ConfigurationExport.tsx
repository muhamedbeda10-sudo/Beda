// ============================================================================
// §7 — the configuration as a workbook. An administrator picks what to take
// out — machines, item dimensions, machine defects, grade equivalences, PT
// consumables, reference photos, work instructions — and each one becomes a
// sheet whose columns are the same fields the import sheets carry, so what
// comes out can go back in.
// ============================================================================

import { useState } from 'react'
import { Check, Download, FileSpreadsheet, Loader2 } from 'lucide-react'
import type { MasterKind } from '@qc/shared/api'
import type { Machine, GradeMapping, ItemDimensionOrder, ItemReferenceImage, PTConsumableProduct, WorkCenterDefect, WorkInstruction } from '@qc/shared/types'
import { PROCESS_LABEL } from '@qc/shared/types'
import { Badge, Button, Modal } from '@/components/ui'
import { api } from '@/lib/api'
import { downloadWorkbook, type SheetSpec } from '@/lib/xlsxWrite'
import { cn, formatDate } from '@/lib/utils'
import { useApp } from '@/store/AppContext'

/** What a set is called, where it comes from, and how one record becomes a row. */
interface Exportable {
  key: string
  label: string
  hint: string
  sheet: string
  header: string[]
  /** The records, straight from the API rather than a screen's cached page. */
  load: () => Promise<unknown[]>
  row: (record: never) => (string | number | null)[]
}

const master = <K extends MasterKind>(kind: K) => () => api<unknown[]>(`/master/${kind}`)
const text = (v: string | null | undefined) => (v ?? '').trim()

export const EXPORTABLES: Exportable[] = [
  {
    key: 'machines',
    label: 'Machines',
    hint: 'Code, name, line, factory, process, whether item dimensions load, and whether the dashboard counts it',
    sheet: 'Machines',
    header: ['Code', 'Name', 'Line', 'Display name', 'Factory', 'Process', 'Loads item dimensions', 'On the dashboard'],
    load: master('machines'),
    row: (m: Machine) => [m.code, m.name, m.line, m.displayName, text(m.factory), PROCESS_LABEL[m.process] ?? m.process, m.usesItemDimensions ? 'Yes' : 'No', m.onDashboard === false ? 'No' : 'Yes'],
  },
  {
    key: 'item-dimension-order',
    label: 'Item dimensions',
    hint: 'The dimensions of each item, in the order they are measured',
    sheet: 'Item dimensions',
    header: ['Item code', 'Item', 'Machine', 'Dimension', 'Sequence', 'Nominal', 'Tol +', 'Tol −', 'Unit'],
    load: master('item-dimension-order'),
    row: (d: ItemDimensionOrder) => [d.itemCode, d.item, text(d.workCenterCode), d.dimensionName, d.sequence, d.nominal ?? null, d.tolPlus, d.tolMinus, d.unit],
  },
  {
    key: 'work-center-defects',
    label: 'Machine defects',
    hint: 'The defect each machine offers the inspector',
    sheet: 'Machine defects',
    header: ['Machine', 'Defect'],
    load: master('work-center-defects'),
    row: (d: WorkCenterDefect) => [d.workCenterCode, d.defectName],
  },
  {
    key: 'grade-mappings',
    label: 'Grade mappings',
    hint: 'Grades treated as equivalent to one another',
    sheet: 'Grade mappings',
    header: ['Grade A', 'Grade B'],
    load: master('grade-mappings'),
    row: (g: GradeMapping) => [g.gradeA, g.gradeB],
  },
  {
    key: 'pt-consumables',
    label: 'PT consumables',
    hint: 'Cleaner, penetrant and developer with their lot numbers',
    sheet: 'PT consumables',
    header: ['Kind', 'Product', 'Lot / batch'],
    load: master('pt-consumables'),
    row: (c: PTConsumableProduct) => [c.kind, c.productName, c.lotBatch],
  },
  {
    key: 'item-reference-images',
    label: 'Reference photos',
    hint: 'Which photo belongs to which item; the photos stay in the app',
    sheet: 'Reference photos',
    header: ['Item code', 'Item', 'Machine', 'Caption', 'Photo id'],
    load: master('item-reference-images'),
    row: (r: ItemReferenceImage) => [r.itemCode, r.item, text(r.workCenterCode), text(r.caption), r.imageId],
  },
  {
    key: 'work-instructions',
    label: 'Work instructions',
    hint: 'The controlled documents in force, with their issue',
    sheet: 'Work instructions',
    header: ['Code', 'Title', 'Issue', 'Issue date', 'Process', 'Step', 'File', 'Uploaded by', 'Uploaded'],
    load: () => api<WorkInstruction[]>('/work-instructions'),
    row: (w: WorkInstruction) => [w.code, w.title, text(w.issueNo), w.issueDate ? formatDate(w.issueDate) : '', w.process, w.step, w.originalFilename, w.uploadedByName, formatDate(w.uploadedAt)],
  },
]

export function ConfigurationExport({ onClose }: { onClose: () => void }) {
  const { toast } = useApp()
  const [picked, setPicked] = useState<Set<string>>(() => new Set(EXPORTABLES.map((e) => e.key)))
  const [busy, setBusy] = useState(false)

  const toggle = (key: string) =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const all = picked.size === EXPORTABLES.length

  async function run() {
    const chosen = EXPORTABLES.filter((e) => picked.has(e.key))
    if (chosen.length === 0) return
    setBusy(true)
    try {
      const sheets: SheetSpec[] = []
      for (const e of chosen) {
        const records = await e.load()
        sheets.push({ name: e.sheet, header: e.header, rows: records.map((r) => e.row(r as never)) })
      }
      const day = new Date().toISOString().slice(0, 10)
      downloadWorkbook(`QC-configuration-${day}.xlsx`, sheets)
      toast(`Exported ${sheets.length} sheet${sheets.length === 1 ? '' : 's'}.`, 'success')
      onClose()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'The export could not be built.', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      icon={<FileSpreadsheet className="h-5 w-5" />}
      title="Export configuration"
      footer={
        <>
          <Button className="min-h-[48px]" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" className="min-h-[48px]" onClick={() => void run()} disabled={busy || picked.size === 0}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            {busy ? 'Building…' : `Export ${picked.size} sheet${picked.size === 1 ? '' : 's'}`}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-muted">Pick what to take out. Each becomes a sheet in one workbook.</p>
          <button
            type="button"
            onClick={() => setPicked(all ? new Set() : new Set(EXPORTABLES.map((e) => e.key)))}
            className="shrink-0 text-xs font-semibold text-brand-700 hover:underline dark:text-brand-300"
          >
            {all ? 'Clear all' : 'Select all'}
          </button>
        </div>

        <ul className="space-y-1.5">
          {EXPORTABLES.map((e) => {
            const on = picked.has(e.key)
            return (
              <li key={e.key}>
                <button
                  type="button"
                  onClick={() => toggle(e.key)}
                  aria-pressed={on}
                  className={cn(
                    'flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left ring-1 transition-colors',
                    on ? 'bg-brand-50 ring-brand-200 dark:bg-brand-500/10 dark:ring-brand-500/30' : 'ring-slate-200 hover:bg-slate-50 dark:ring-slate-700 dark:hover:bg-slate-800',
                  )}
                >
                  <span
                    className={cn(
                      'mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md ring-1',
                      on ? 'bg-brand-600 text-white ring-brand-600' : 'ring-slate-300 dark:ring-slate-600',
                    )}
                  >
                    {on && <Check className="h-3.5 w-3.5" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold">{e.label}</span>
                    <span className="block text-xs text-muted">{e.hint}</span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>

        <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <Badge tone="neutral">.xlsx</Badge>
          The columns match the import sheets, so an exported list can be edited and loaded back.
        </p>
      </div>
    </Modal>
  )
}
