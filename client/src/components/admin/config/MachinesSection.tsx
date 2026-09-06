// ============================================================================
// The machine register (§7).
// ============================================================================

import { useCallback } from 'react'
import { Factory } from 'lucide-react'
import { Badge, Field, Input, Select } from '@/components/ui'
import { useMaster } from '@/services/queries'
import { can } from '@/domain'
import { MasterDataPanel, MachineSelect, numberOrNull, requireNumber, requireText } from '@/components/admin/MasterDataPanel'
import { PROCESSES, PROCESS_LABEL, type Machine, type Process } from '@qc/shared/types'

interface MachineDraft {
  code: string
  name: string
  factory: string
  process: Process
  /** 'item' — the configured item dimensions pre-fill; 'inspector' — the inspector types them. */
  dimensions: 'item' | 'inspector'
  /** 'order' — sessions are opened against an ERP order line; 'stock' — the machine makes one item for stock. */
  mode: 'order' | 'stock'
  stockItem: string
  stockItemCode: string
}

const PROCESS_TONE: Record<Process, 'neutral' | 'amber' | 'violet' | 'blue'> = { forming: 'blue', welding: 'amber', paint: 'violet', other: 'neutral' }

export function MachinesSection() {
  const { data: rows = [], isLoading: loading } = useMaster('machines')

  const sort = useCallback(
    (a: Machine, b: Machine) =>
      (a.factory ?? '').localeCompare(b.factory ?? '') ||
      a.code.localeCompare(b.code, undefined, { numeric: true }),
    [],
  )
  const groupBy = useCallback((r: Machine) => r.factory?.trim() || '', [])
  const groupLabel = useCallback((g: string) => (g ? g : 'No factory set'), [])

  return (
    <MasterDataPanel<'machines', MachineDraft>
      title="Machines"
      groupBy={groupBy}
      groupLabel={groupLabel}
      icon={<Factory className="h-5 w-5" />}
      kind='machines'
      rows={rows}
      loading={loading}
      sort={sort}
      addLabel="Add machine"
      emptyHint="Add the machines used on the shop floor."
      minTableWidth="min-w-[46rem]"
      columns={[
        { key: 'code', label: 'Code', render: (r) => <Badge tone="blue">{r.code}</Badge> },
        { key: 'name', label: 'Machine', render: (r) => r.name },
        { key: 'process', label: 'Process', render: (r) => <Badge tone={PROCESS_TONE[r.process ?? 'forming']}>{PROCESS_LABEL[r.process ?? 'forming']}</Badge> },
        {
          key: 'mode',
          label: 'Works',
          render: (r) =>
            r.stockItem ? (
              <span className="flex flex-wrap items-center gap-1.5">
                <Badge tone="violet">For stock</Badge>
                <span className="text-xs text-slate-500">
                  {r.stockItem} · <span className="font-mono">{r.stockItemCode}</span>
                </span>
              </span>
            ) : (
              <Badge tone="neutral">To order</Badge>
            ),
        },
        {
          key: 'dimensions',
          label: 'Dimensions',
          render: (r) => (r.usesItemDimensions === false ? <Badge tone="amber">Typed by inspector</Badge> : <Badge tone="neutral">From item setup</Badge>),
        },
        {
          key: 'displayName',
          label: 'Shown as',
          render: (r) => <span className="font-semibold">{r.displayName}</span>,
        },
      ]}
      describe={(r) => r.displayName || r.name}
      newDraft={() => ({ code: '', name: '', factory: '', process: 'forming', dimensions: 'item', mode: 'order', stockItem: '', stockItemCode: '' })}
      toDraft={(r) => ({
        code: r.code,
        name: r.name,
        factory: r.factory ?? '',
        process: r.process ?? 'forming',
        dimensions: r.usesItemDimensions === false ? 'inspector' : 'item',
        mode: r.stockItem ? 'stock' : 'order',
        stockItem: r.stockItem ?? '',
        stockItemCode: r.stockItemCode ?? '',
      })}
      validate={(d) =>
        requireText(d.code, 'Machine code') ??
        requireText(d.name, 'Machine name') ??
        (d.mode === 'stock' ? (requireText(d.stockItem, 'Stock item name') ?? requireText(d.stockItemCode, 'Stock item code')) : null)
      }
      toRecord={(d) => {
        const code = d.code.trim()
        const name = d.name.trim()
        return {
          code,
          name,
          line: '',
          factory: d.factory.trim() || undefined,
          process: d.process,
          usesItemDimensions: d.dimensions === 'item',
          stockItem: d.mode === 'stock' ? d.stockItem.trim() : undefined,
          stockItemCode: d.mode === 'stock' ? d.stockItemCode.trim() : undefined,
          // The label the shop floor recognises: "58-A. Welding Line".
          displayName: [code, name].filter(Boolean).join('-'),
        }
      }}
      renderForm={(d, patch) => (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Machine code" hint="As it appears in the ERP order export.">
              <Input value={d.code} onChange={(e) => patch({ code: e.target.value })} placeholder="58" autoCapitalize="characters" />
            </Field>
            <Field label="Factory" hint="Optional.">
              <Input value={d.factory} onChange={(e) => patch({ factory: e.target.value })} placeholder="Factory 1" />
            </Field>
          </div>
          <Field label="Machine name" hint='Shown as "{code}-{name}"'>
            <Input value={d.name} onChange={(e) => patch({ name: e.target.value })} placeholder="A. Welding Line" />
          </Field>
          <Field label="Process" hint="Decides the inspection steps: welding adds VT documents and PT, paint records sample photos and thickness readings.">
            <Select value={d.process} onChange={(e) => patch({ process: e.target.value as Process })} className="min-h-[48px]">
              {PROCESSES.map((p) => (
                <option key={p} value={p}>
                  {PROCESS_LABEL[p]}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Works"
            hint="To order: the inspector picks the ERP order and item when starting. For stock: the machine makes one item with no order — the inspector starts straight away and enters how many came out."
          >
            <Select value={d.mode} onChange={(e) => patch({ mode: e.target.value as MachineDraft['mode'] })} className="min-h-[48px]">
              <option value="order">To order (pick an ERP order)</option>
              <option value="stock">For stock (one item, no order)</option>
            </Select>
          </Field>
          {d.mode === 'stock' && (
            <div className="grid grid-cols-2 gap-3 rounded-2xl border border-violet-200 bg-violet-50/40 p-3 dark:border-violet-500/30 dark:bg-violet-500/5">
              <Field label="Stock item" hint="What the machine makes, as the floor names it.">
                <Input value={d.stockItem} onChange={(e) => patch({ stockItem: e.target.value })} placeholder="Connector (right + left)" />
              </Field>
              <Field label="Item code" hint="Dimensions and reference photos configured under this code apply.">
                <Input value={d.stockItemCode} onChange={(e) => patch({ stockItemCode: e.target.value })} placeholder="CONN-RL" autoCapitalize="characters" />
              </Field>
            </div>
          )}
          {d.process !== 'paint' && (
            <Field
              label="Dimensions"
              hint="From item setup: the item's configured dimensions pre-fill the wizard. Typed by inspector: nothing is loaded; the inspector adds what the part needs, and the next sample starts from the previous one."
            >
              <Select value={d.dimensions} onChange={(e) => patch({ dimensions: e.target.value as MachineDraft['dimensions'] })} className="min-h-[48px]">
                <option value="item">From item setup</option>
                <option value="inspector">Typed by inspector</option>
              </Select>
            </Field>
          )}
        </>
      )}
    />
  )
}
