// ============================================================================
// PT consumables and their lot numbers (§5.6).
// ============================================================================

import { useCallback } from 'react'
import { FlaskConical } from 'lucide-react'
import { Badge, Field, Input, Select } from '@/components/ui'
import { useMaster } from '@/services/queries'
import { MasterDataPanel, MachineSelect, numberOrNull, requireNumber, requireText } from '@/components/admin/MasterDataPanel'
import { type PTConsumableKind, type PTConsumableProduct } from '@qc/shared/types'

const PT_KINDS: readonly PTConsumableKind[] = ['Cleaner', 'Penetrant', 'Developer']

interface PTDraft {
  kind: PTConsumableKind
  productName: string
  lotBatch: string
}

export function PTConsumablesSection() {
  const { data: rows = [], isLoading: loading } = useMaster('pt-consumables')

  const sort = useCallback(
    (a: PTConsumableProduct, b: PTConsumableProduct) =>
      PT_KINDS.indexOf(a.kind) - PT_KINDS.indexOf(b.kind) ||
      a.productName.localeCompare(b.productName),
    [],
  )

  return (
    <MasterDataPanel<'pt-consumables', PTDraft>
      title="PT consumables"
      icon={<FlaskConical className="h-5 w-5" />}
      kind='pt-consumables'
      rows={rows}
      loading={loading}
      sort={sort}
      addLabel="Add consumable"
      emptyHint="Add the PT consumables in use, with their current lot numbers."
      minTableWidth="min-w-[32rem]"
      columns={[
        {
          key: 'kind',
          label: 'Kind',
          render: (r) => (
            <Badge tone={r.kind === 'Cleaner' ? 'blue' : r.kind === 'Penetrant' ? 'red' : 'violet'}>
              {r.kind}
            </Badge>
          ),
        },
        {
          key: 'name',
          label: 'Product',
          text: (r) => r.productName,
          render: (r) => <span className="font-semibold">{r.productName}</span>,
        },
        {
          key: 'lot',
          label: 'Lot / batch',
          text: (r) => r.lotBatch,
          render: (r) => <span className="tabular-nums">{r.lotBatch}</span>,
        },
      ]}
      describe={(r) => `${r.kind} — ${r.productName}`}
      newDraft={() => ({ kind: 'Cleaner', productName: '', lotBatch: '' })}
      toDraft={(r) => ({ kind: r.kind, productName: r.productName, lotBatch: r.lotBatch })}
      validate={(d) =>
        requireText(d.productName, 'Product name') ?? requireText(d.lotBatch, 'Lot / batch')
      }
      toRecord={(d) => ({
        kind: d.kind,
        productName: d.productName.trim(),
        lotBatch: d.lotBatch.trim(),
      })}
      renderForm={(d, patch) => (
        <>
          <Field label="Kind">
            <Select
              className="min-h-[48px]"
              value={d.kind}
              onChange={(e) => patch({ kind: e.target.value as PTConsumableKind })}
            >
              {PT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Product name">
            <Input
              value={d.productName}
              onChange={(e) => patch({ productName: e.target.value })}
              placeholder="SKL-SP2 Red Penetrant"
            />
          </Field>
          <Field label="Lot / batch">
            <Input
              value={d.lotBatch}
              onChange={(e) => patch({ lotBatch: e.target.value })}
              placeholder="B24-0417"
            />
          </Field>
        </>
      )}
    />
  )
}
