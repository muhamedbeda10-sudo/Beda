// ============================================================================
// Dimension order per item, optionally per machine (§7).
// ============================================================================

import { useCallback } from 'react'
import { ListOrdered } from 'lucide-react'
import { Badge, Field, Input } from '@/components/ui'
import { useMaster } from '@/services/queries'
import { MasterDataPanel, MachineSelect, numberOrNull, requireNumber, requireText } from '@/components/admin/MasterDataPanel'
import { type ItemDimensionOrder } from '@qc/shared/types'

interface DimOrderDraft {
  itemCode: string
  item: string
  workCenterCode: string
  dimensionName: string
  sequence: string
  nominal: string
  tolPlus: string
  tolMinus: string
  unit: string
}

export function DimensionOrderSection() {
  const { data: rows = [], isLoading: loading } = useMaster('item-dimension-order')

  const sort = useCallback(
    (a: ItemDimensionOrder, b: ItemDimensionOrder) =>
      a.itemCode.localeCompare(b.itemCode, undefined, { numeric: true }) ||
      (a.workCenterCode ?? '').localeCompare(b.workCenterCode ?? '', undefined, { numeric: true }) ||
      a.sequence - b.sequence,
    [],
  )
  const groupBy = useCallback((r: ItemDimensionOrder) => r.itemCode, [])

  return (
    <MasterDataPanel<'item-dimension-order', DimOrderDraft>
      title="Dimension order"
      description="Per-item dimensions, keyed by item ID, in the order they are measured."
      hint={
        <>
          A row with <strong>Every machine</strong> applies wherever the item is produced. A row that names a
          machine applies only there and replaces the general row of the same dimension. <strong>Sequence</strong>{' '}
          controls the order the inspector measures in — put the measurement taken first at 1. These entries also
          pre-fill nominal and tolerance.
        </>
      }
      groupBy={groupBy}
      groupLabel={(g) => `Item ${g}`}
      icon={<ListOrdered className="h-5 w-5" />}
      kind='item-dimension-order'
      rows={rows}
      loading={loading}
      sort={sort}
      addLabel="Add dimension"
      emptyHint="Add the dimensions for an item, or load them from the Bulk import tab."
      minTableWidth="min-w-[50rem]"
      columns={[
        { key: 'item', label: 'Item', render: (r) => <span className="font-semibold">{r.item || r.itemCode}</span> },
        {
          key: 'machine',
          label: 'Machine',
          render: (r) => (r.workCenterCode ? <Badge tone="blue">{r.workCenterCode}</Badge> : <span className="text-slate-400">every machine</span>),
        },
        { key: 'name', label: 'Dimension', render: (r) => <span dir="auto">{r.dimensionName}</span> },
        {
          key: 'seq',
          label: 'Seq',
          className: 'tabular-nums',
          render: (r) => <Badge tone="neutral">{r.sequence}</Badge>,
        },
        {
          key: 'nominal',
          label: 'Nominal',
          className: 'tabular-nums',
          render: (r) => (r.nominal === undefined || r.nominal === null ? '—' : r.nominal),
        },
        {
          key: 'tol',
          label: 'Tolerance',
          className: 'tabular-nums',
          render: (r) => `+${r.tolPlus} / −${r.tolMinus}`,
        },
        { key: 'unit', label: 'Unit', render: (r) => r.unit || '—' },
      ]}
      describe={(r) => `${r.itemCode}${r.workCenterCode ? ` on ${r.workCenterCode}` : ''} · ${r.dimensionName}`}
      newDraft={() => ({
        itemCode: '',
        item: '',
        workCenterCode: '',
        dimensionName: '',
        sequence: '1',
        nominal: '',
        tolPlus: '0',
        tolMinus: '0',
        unit: 'mm',
      })}
      toDraft={(r) => ({
        itemCode: r.itemCode,
        item: r.item ?? '',
        workCenterCode: r.workCenterCode ?? '',
        dimensionName: r.dimensionName,
        sequence: String(r.sequence),
        nominal: r.nominal === undefined || r.nominal === null ? '' : String(r.nominal),
        tolPlus: String(r.tolPlus),
        tolMinus: String(r.tolMinus),
        unit: r.unit,
      })}
      validate={(d) =>
        requireText(d.itemCode, 'Item code') ??
        requireText(d.dimensionName, 'Dimension name') ??
        requireNumber(d.sequence, 'Sequence') ??
        (d.nominal.trim() !== '' && numberOrNull(d.nominal) === null
          ? 'Nominal must be a number.'
          : null) ??
        requireNumber(d.tolPlus, 'Tolerance +') ??
        requireNumber(d.tolMinus, 'Tolerance −') ??
        requireText(d.unit, 'Unit')
      }
      toRecord={(d) => ({
        itemCode: d.itemCode.trim(),
        item: d.item.trim(),
        workCenterCode: d.workCenterCode.trim() || null,
        dimensionName: d.dimensionName.trim(),
        sequence: Number(d.sequence),
        nominal: numberOrNull(d.nominal),
        tolPlus: Number(d.tolPlus),
        tolMinus: Number(d.tolMinus),
        unit: d.unit.trim(),
      })}
      renderForm={(d, patch) => (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Item code">
              <Input value={d.itemCode} onChange={(e) => patch({ itemCode: e.target.value })} placeholder="LB406015-5TA3" />
            </Field>
            <Field label="Item name" hint="Optional, for display.">
              <Input value={d.item} onChange={(e) => patch({ item: e.target.value })} placeholder="XL Light Beam" />
            </Field>
          </div>
          <Field label="Machine" hint="Leave on every machine unless this dimension differs on one.">
            <MachineSelect value={d.workCenterCode} onChange={(code) => patch({ workCenterCode: code })} allowAny />
          </Field>
          <Field label="Dimension name">
            <Input
              dir="auto"
              value={d.dimensionName}
              onChange={(e) => patch({ dimensionName: e.target.value })}
              placeholder="Width"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Sequence" hint="Lowest is measured first.">
              <Input
                inputMode="numeric"
                value={d.sequence}
                onChange={(e) => patch({ sequence: e.target.value })}
              />
            </Field>
            <Field label="Unit">
              <Input value={d.unit} onChange={(e) => patch({ unit: e.target.value })} placeholder="mm" />
            </Field>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Nominal" hint="Optional.">
              <Input
                inputMode="decimal"
                value={d.nominal}
                onChange={(e) => patch({ nominal: e.target.value })}
              />
            </Field>
            <Field label="Tolerance +">
              <Input
                inputMode="decimal"
                value={d.tolPlus}
                onChange={(e) => patch({ tolPlus: e.target.value })}
              />
            </Field>
            <Field label="Tolerance −">
              <Input
                inputMode="decimal"
                value={d.tolMinus}
                onChange={(e) => patch({ tolMinus: e.target.value })}
              />
            </Field>
          </div>
        </>
      )}
    />
  )
}
