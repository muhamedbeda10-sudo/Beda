// ============================================================================
// The machine register (§7).
// ============================================================================

import { useCallback } from 'react'
import { Factory } from 'lucide-react'
import { Badge, Field, Input } from '@/components/ui'
import { useMaster } from '@/services/queries'
import { can } from '@/domain'
import { MasterDataPanel, MachineSelect, numberOrNull, requireNumber, requireText } from '@/components/admin/MasterDataPanel'
import { type Machine } from '@qc/shared/types'

interface MachineDraft {
  code: string
  name: string
  line: string
  factory: string
}

export function MachinesSection() {
  const { data: rows = [], isLoading: loading } = useMaster('machines')

  const sort = useCallback(
    (a: Machine, b: Machine) =>
      (a.factory ?? '').localeCompare(b.factory ?? '') ||
      a.code.localeCompare(b.code, undefined, { numeric: true }) ||
      a.line.localeCompare(b.line, undefined, { numeric: true }),
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
      emptyHint="Add the machines and lines used on the shop floor."
      minTableWidth="min-w-[42rem]"
      columns={[
        { key: 'code', label: 'Code', render: (r) => <Badge tone="blue">{r.code}</Badge> },
        { key: 'name', label: 'Machine', render: (r) => r.name },
        { key: 'line', label: 'Line', render: (r) => r.line || '—' },
        {
          key: 'displayName',
          label: 'Shown as',
          render: (r) => <span className="font-semibold">{r.displayName}</span>,
        },
      ]}
      describe={(r) => r.displayName || r.name}
      newDraft={() => ({ code: '', name: '', line: '', factory: '' })}
      toDraft={(r) => ({ code: r.code, name: r.name, line: r.line, factory: r.factory ?? '' })}
      validate={(d) => requireText(d.code, 'Machine code') ?? requireText(d.name, 'Machine name')}
      toRecord={(d) => {
        const code = d.code.trim()
        const name = d.name.trim()
        const line = d.line.trim()
        return {
          code,
          name,
          line,
          factory: d.factory.trim() || undefined,
          // The label the shop floor recognises: "58-A. Welding Line-LM4".
          displayName: [code, name, line].filter(Boolean).join('-'),
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
          <div className="grid grid-cols-2 gap-3">
            <Field label="Machine name" hint='Shown as "{code}-{name}-{line}"'>
              <Input value={d.name} onChange={(e) => patch({ name: e.target.value })} placeholder="A. Welding Line" />
            </Field>
            <Field label="Line" hint="Optional.">
              <Input value={d.line} onChange={(e) => patch({ line: e.target.value })} placeholder="LM4" />
            </Field>
          </div>
        </>
      )}
    />
  )
}
