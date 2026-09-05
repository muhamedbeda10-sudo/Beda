// ============================================================================
// Item master dimensions — the fallback nominal and tolerance (§7).
// ============================================================================

import { useCallback } from 'react'
import { Ruler } from 'lucide-react'
import { Field, Input } from '@/components/ui'
import { useMaster } from '@/services/queries'
import { MasterDataPanel, MachineSelect, numberOrNull, requireNumber, requireText } from '@/components/admin/MasterDataPanel'
import { type ItemDimensionMaster } from '@qc/shared/types'

interface DimMasterDraft {
  itemCode: string
  item: string
  dimensionName: string
  nominal: string
  tolPlus: string
  tolMinus: string
  unit: string
}

export function ItemMasterSection() {
  const { data: rows = [], isLoading: loading } = useMaster('item-dimension-master')

  const sort = useCallback(
    (a: ItemDimensionMaster, b: ItemDimensionMaster) =>
      a.itemCode.localeCompare(b.itemCode, undefined, { numeric: true }) || a.dimensionName.localeCompare(b.dimensionName),
    [],
  )

  return (
    <MasterDataPanel<'item-dimension-master', DimMasterDraft>
      title="Item master dimensions"
      description="Fallback nominal and tolerance when an item has no dimension-order entry."
      hint="The wizard reads the dimension order first; anything not found there falls back to this master list."
      icon={<Ruler className="h-5 w-5" />}
      kind='item-dimension-master'
      rows={rows}
      loading={loading}
      sort={sort}
      addLabel="Add dimension"
      emptyHint="Add the master dimensions inspectors should fall back to."
      columns={[
        { key: 'itemCode', label: 'Item code', render: (r) => <span className="font-semibold">{r.itemCode}</span> },
        { key: 'item', label: 'Item', render: (r) => r.item || '—' },
        { key: 'name', label: 'Dimension', render: (r) => <span dir="auto">{r.dimensionName}</span> },
        { key: 'nominal', label: 'Nominal', className: 'tabular-nums', render: (r) => (r.nominal === undefined || r.nominal === null ? '—' : r.nominal) },
        {
          key: 'tol',
          label: 'Tolerance',
          className: 'tabular-nums',
          render: (r) => `+${r.tolPlus} / −${r.tolMinus}`,
        },
        { key: 'unit', label: 'Unit', render: (r) => r.unit || '—' },
      ]}
      describe={(r) => `${r.itemCode} · ${r.dimensionName}`}
      newDraft={() => ({
        itemCode: '',
        item: '',
        dimensionName: '',
        nominal: '0',
        tolPlus: '0',
        tolMinus: '0',
        unit: 'mm',
      })}
      toDraft={(r) => ({
        itemCode: r.itemCode,
        item: r.item ?? '',
        dimensionName: r.dimensionName,
        nominal: r.nominal === undefined || r.nominal === null ? '' : String(r.nominal),
        tolPlus: String(r.tolPlus),
        tolMinus: String(r.tolMinus),
        unit: r.unit,
      })}
      validate={(d) =>
        requireText(d.itemCode, 'Item code') ??
        requireText(d.dimensionName, 'Dimension name') ??
        requireNumber(d.nominal, 'Nominal') ??
        requireNumber(d.tolPlus, 'Tolerance +') ??
        requireNumber(d.tolMinus, 'Tolerance −') ??
        requireText(d.unit, 'Unit')
      }
      toRecord={(d) => ({
        itemCode: d.itemCode.trim(),
        item: d.item.trim(),
        dimensionName: d.dimensionName.trim(),
        nominal: Number(d.nominal),
        tolPlus: Number(d.tolPlus),
        tolMinus: Number(d.tolMinus),
        unit: d.unit.trim(),
      })}
      renderForm={(d, patch) => (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Item code">
              <Input value={d.itemCode} onChange={(e) => patch({ itemCode: e.target.value })} />
            </Field>
            <Field label="Item name" hint="Optional, for display.">
              <Input value={d.item} onChange={(e) => patch({ item: e.target.value })} />
            </Field>
          </div>
          <Field label="Dimension name">
            <Input
              dir="auto"
              value={d.dimensionName}
              onChange={(e) => patch({ dimensionName: e.target.value })}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Nominal">
              <Input
                inputMode="decimal"
                value={d.nominal}
                onChange={(e) => patch({ nominal: e.target.value })}
              />
            </Field>
            <Field label="Unit">
              <Input value={d.unit} onChange={(e) => patch({ unit: e.target.value })} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
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
