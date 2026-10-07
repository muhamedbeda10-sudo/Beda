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
import { takesConfiguredDimensions } from '@qc/shared/rules'

interface MachineDraft {
  code: string
  name: string
  factory: string
  process: Process
  /** 'item' — the configured item dimensions pre-fill; 'inspector' — the inspector types them. */
  dimensions: 'item' | 'inspector'
  /** Counted by the dashboard; off for a machine inspected but not weighed with production (manual welding). */
  onDashboard: boolean
}

const PROCESS_TONE: Record<Process, 'neutral' | 'amber' | 'violet' | 'blue' | 'green'> = { forming: 'blue', welding: 'amber', paint: 'violet', universal: 'green' }

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
      minTableWidth="min-w-[54rem]"
      columns={[
        { key: 'code', label: 'Code', render: (r) => <Badge tone="blue">{r.code}</Badge> },
        { key: 'name', label: 'Machine', render: (r) => r.name },
        { key: 'process', label: 'Process', text: (r) => PROCESS_LABEL[r.process ?? 'forming'], render: (r) => <Badge tone={PROCESS_TONE[r.process ?? 'forming']}>{PROCESS_LABEL[r.process ?? 'forming']}</Badge> },
        {
          key: 'dimensions',
          label: 'Dimensions',
          text: (r) => (takesConfiguredDimensions(r.process ?? 'forming', r) ? 'From item setup' : 'Typed by inspector'),
          // What the wizard does, not only the switch: a universal machine is always typed by the inspector.
          render: (r) => (takesConfiguredDimensions(r.process ?? 'forming', r) ? <Badge tone="neutral">From item setup</Badge> : <Badge tone="amber">Typed by inspector</Badge>),
        },
        {
          key: 'dashboard',
          label: 'Dashboard',
          text: (r) => (r.onDashboard === false ? 'Left out' : 'Counted'),
          render: (r) => (r.onDashboard === false ? <Badge tone="amber">Left out</Badge> : <Badge tone="neutral">Counted</Badge>),
        },
        {
          key: 'displayName',
          label: 'Shown as',
          render: (r) => <span className="font-semibold">{r.displayName}</span>,
        },
      ]}
      describe={(r) => r.displayName || r.name}
      newDraft={() => ({ code: '', name: '', factory: '', process: 'forming', dimensions: 'item', onDashboard: true })}
      toDraft={(r) => ({
        code: r.code,
        name: r.name,
        factory: r.factory ?? '',
        process: r.process ?? 'forming',
        dimensions: r.usesItemDimensions === false ? 'inspector' : 'item',
        onDashboard: r.onDashboard !== false,
      })}
      validate={(d) => requireText(d.code, 'Machine code') ?? requireText(d.name, 'Machine name')}
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
          onDashboard: d.onDashboard,
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
          {d.process === 'universal' && (
            <Field label="Dimensions" hint="A universal machine always takes them from the inspector: the next sample of an item on this machine starts from the last one, empty the first time. Nothing is loaded from the item setup.">
              <Select value="inspector" disabled className="min-h-[48px]" aria-label="Dimensions">
                <option value="inspector">Typed by inspector</option>
              </Select>
            </Field>
          )}
          {d.process !== 'paint' && d.process !== 'universal' && (
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
          <Field
            label="Dashboard"
            hint="Left out: the machine is still inspected and its sessions stay in History, but no dashboard figure counts it — for manual welding or a bench, not production."
          >
            <Select value={d.onDashboard ? 'counted' : 'out'} onChange={(e) => patch({ onDashboard: e.target.value === 'counted' })} className="min-h-[48px]">
              <option value="counted">Counted on the dashboard</option>
              <option value="out">Left out of the dashboard</option>
            </Select>
          </Field>
        </>
      )}
    />
  )
}
