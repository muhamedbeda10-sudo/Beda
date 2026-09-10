// ============================================================================
// §9.4 — corrections to a recorded sample: one measurement, or one defect's
// disposition and quantity. Used from History and from the board, so a
// sample is corrected the same way wherever it was opened. Every save is an
// audited change; a defect may move from any disposition to any other.
// ============================================================================

import { useState } from 'react'
import { AlertTriangle, Ruler } from 'lucide-react'
import { DISPOSITIONS, type DefectResult, type DimensionResult, type Disposition } from '@qc/shared/types'
import { dimensionStatus } from '@qc/shared/rules'
import { Badge, Button, Field, Input, Modal, Select } from '@/components/ui'
import { Attr, num, statusToneOf } from '@/components/inspection/SampleDetail'

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

export function DefectEditDialog({
  defect,
  saving,
  onClose,
  onSave,
}: {
  defect: DefectResult
  saving: boolean
  onClose: () => void
  onSave: (patch: { disposition: Disposition; qty: number }) => void
}) {
  const [disposition, setDisposition] = useState<Disposition | ''>(defect.disposition ?? '')
  const [qty, setQty] = useState(String(defect.qty))
  const parsedQty = Number(qty)
  const valid = disposition !== '' && qty.trim() !== '' && !Number.isNaN(parsedQty) && parsedQty > 0

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
          <Button variant="primary" className="min-h-[48px]" disabled={!valid || saving} onClick={() => valid && onSave({ disposition: disposition as Disposition, qty: parsedQty })}>
            {saving ? 'Saving…' : 'Save correction'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="font-bold" dir="auto">
          {defect.defectName}
        </p>
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
      </div>
    </Modal>
  )
}
