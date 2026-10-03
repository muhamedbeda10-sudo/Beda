// ============================================================================
// §9.4 — corrections to a recorded sample: one measurement, or one defect's
// type, disposition, quantity and notes. Used from History and from the board, so a
// sample is corrected the same way wherever it was opened. Every save is an
// audited change; a defect may move from any disposition to any other.
// ============================================================================

import { useMemo, useState } from 'react'
import { AlertTriangle, Ruler } from 'lucide-react'
import { DISPOSITIONS, type DefectResult, type DimensionResult, type Disposition } from '@qc/shared/types'
import { OTHER_DEFECT_NAME, dimensionStatus, isOtherDefect } from '@qc/shared/rules'
import { Badge, Button, Field, Input, Modal, Select } from '@/components/ui'
import { Attr, num, statusToneOf } from '@/components/inspection/SampleDetail'
import { useMaster } from '@/services/queries'
import { cn } from '@/lib/utils'

export function DimensionEditDialog({
  dimension,
  saving,
  onClose,
  onSave,
}: {
  dimension: DimensionResult
  saving: boolean
  onClose: () => void
  onSave: (actual: number | null) => void
}) {
  const [value, setValue] = useState(dimension.actual === null ? '' : String(dimension.actual))
  const trimmed = value.trim()
  const parsed = trimmed === '' ? null : Number(trimmed)
  const valid = parsed === null || !Number.isNaN(parsed)
  const preview = dimensionStatus({ nominal: dimension.nominal, tolPlus: dimension.tolPlus, tolMinus: dimension.tolMinus, actual: valid ? parsed : null })

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      icon={<Ruler className="h-5 w-5" />}
      title="Correct measurement"
      footer={
        <>
          <Button variant="ghost" className="min-h-[48px]" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" className="min-h-[48px]" disabled={!valid || saving} onClick={() => onSave(parsed)}>
            {saving ? 'Saving…' : 'Save correction'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <dl className="grid grid-cols-3 gap-3 rounded-2xl bg-slate-50 p-3 dark:bg-slate-800/60">
          <Attr label="Dimension" value={dimension.name} />
          <Attr label="Nominal" value={dimension.nominal} />
          <Attr label="Tolerance" value={`+${num(dimension.tolPlus)} / -${num(dimension.tolMinus)}`} />
        </dl>
        <Field label={`Actual${dimension.unit ? ` (${dimension.unit})` : ''}`} hint="Leave empty to clear the measurement. The change is written to the audit log.">
          <Input autoFocus type="number" step="any" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} className="min-h-[48px] text-lg tabular-nums" />
        </Field>
        <p className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
          New status: <Badge tone={statusToneOf(preview)}>{preview}</Badge>
        </p>
      </div>
    </Modal>
  )
}

/** What a defect correction changes: always the disposition and the quantity, and the type and notes as edited. */
export interface DefectCorrection {
  disposition: Disposition
  qty: number
  defectName: string
  notes: string | null
}

export function DefectEditDialog({
  defect,
  workCenterCode,
  saving,
  onClose,
  onSave,
}: {
  defect: DefectResult
  /** The machine the session ran on: its defect list is what the type can change to. */
  workCenterCode: string
  saving: boolean
  onClose: () => void
  onSave: (patch: DefectCorrection) => void
}) {
  const { data: listed = [], isLoading: listLoading } = useMaster('work-center-defects', { workCenterCode })
  // The machine's defects, the name this one already carries (a list can change after recording), then Other.
  const options = useMemo(() => {
    const seen = new Set<string>()
    const out: string[] = []
    const add = (n: string) => {
      const k = n.trim().toLowerCase()
      if (!k || seen.has(k) || isOtherDefect(n)) return
      seen.add(k)
      out.push(n.trim())
    }
    listed.map((d) => d.defectName).sort((a, b) => a.localeCompare(b)).forEach(add)
    add(defect.defectName)
    return out
  }, [listed, defect.defectName])
  const [defectName, setDefectName] = useState(isOtherDefect(defect.defectName) ? OTHER_DEFECT_NAME : defect.defectName.trim())
  const [disposition, setDisposition] = useState<Disposition | ''>(defect.disposition ?? '')
  const [qty, setQty] = useState(String(defect.qty))
  const [notes, setNotes] = useState(defect.notes ?? '')
  const other = isOtherDefect(defectName)
  const parsedQty = Number(qty)
  const valid = defectName !== '' && disposition !== '' && qty.trim() !== '' && !Number.isNaN(parsedQty) && parsedQty > 0 && (!other || notes.trim() !== '')
  const typeChanged = defectName.trim().toLowerCase() !== defect.defectName.trim().toLowerCase()

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      icon={<AlertTriangle className="h-5 w-5" />}
      title="Correct defect"
      footer={
        <>
          <Button variant="ghost" className="min-h-[48px]" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            className="min-h-[48px]"
            disabled={!valid || saving}
            onClick={() => valid && onSave({ defectName, disposition: disposition as Disposition, qty: parsedQty, notes: notes.trim() || null })}
          >
            {saving ? 'Saving…' : 'Save correction'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Defect" hint={typeChanged ? `Was "${defect.defectName}". The photos stay with the defect.` : `Machine ${workCenterCode}'s defects, or Other to describe one that is not listed.`}>
          <Select value={defectName} onChange={(e) => setDefectName(e.target.value)} className="min-h-[48px]" dir="auto" aria-label="Defect type">
            {listLoading && options.length <= 1 && <option disabled>Loading the machine's defects…</option>}
            {options.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
            <option value={OTHER_DEFECT_NAME}>Other (not in the list)</option>
          </Select>
        </Field>
        <Field label="Disposition" hint="A defect can never be left without one (§8.5).">
          <Select value={disposition} onChange={(e) => setDisposition(e.target.value as Disposition | '')} className="min-h-[48px]">
            <option value="">Choose a disposition…</option>
            {DISPOSITIONS.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Quantity" hint="Must be greater than zero.">
          <Input type="number" inputMode="numeric" min={1} value={qty} onChange={(e) => setQty(e.target.value)} className="min-h-[48px] text-lg tabular-nums" />
        </Field>
        {other ? (
          <Field label="Describe the defect *">
            <textarea
              dir="auto"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="What was found, where on the part, how big…"
              className={cn('input min-h-[88px] w-full', notes.trim() === '' && 'border-rose-400')}
            />
          </Field>
        ) : (
          <Field label="Notes">
            <Input dir="auto" value={notes} onChange={(e) => setNotes(e.target.value)} className="min-h-[48px]" />
          </Field>
        )}
        <p className="text-xs text-slate-400">The change is written to the audit log.</p>
      </div>
    </Modal>
  )
}
