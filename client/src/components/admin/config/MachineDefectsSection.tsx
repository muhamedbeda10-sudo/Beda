// ============================================================================
// The defect names offered on each machine (§5.1).
// ============================================================================

import { useCallback } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Badge, Field, Input } from '@/components/ui'
import { useMaster } from '@/services/queries'
import { MasterDataPanel, MachineSelect, numberOrNull, requireNumber, requireText } from '@/components/admin/MasterDataPanel'
import { type WorkCenterDefect } from '@qc/shared/types'

interface DefectDraft {
  workCenterCode: string
  defectName: string
}

export function MachineDefectsSection() {
  const { data: rows = [], isLoading: loading } = useMaster('work-center-defects')

  const sort = useCallback(
    (a: WorkCenterDefect, b: WorkCenterDefect) => a.defectName.localeCompare(b.defectName),
    [],
  )
  const groupBy = useCallback((r: WorkCenterDefect) => r.workCenterCode, [])
  const groupLabel = useCallback((g: string) => `Machine ${g}`, [])

  return (
    <MasterDataPanel<'work-center-defects', DefectDraft>
      title="Machine defects"
      icon={<AlertTriangle className="h-5 w-5" />}
      kind='work-center-defects'
      rows={rows}
      loading={loading}
      sort={sort}
      groupBy={groupBy}
      groupLabel={groupLabel}
      addLabel="Add defect"
      emptyHint="Add the defect names inspectors should be able to pick from."
      minTableWidth="min-w-[28rem]"
      columns={[
        {
          key: 'name',
          label: 'Defect name',
          text: (r) => r.defectName,
          // A block in its own direction: an Arabic name starts at the right of its cell, an English one at the left.
          render: (r) => (
            <span dir="auto" className="block text-start font-semibold">
              {r.defectName}
            </span>
          ),
        },
        {
          key: 'wc',
          label: 'Machine',
          text: (r) => r.workCenterCode,
          render: (r) => <Badge tone="neutral">{r.workCenterCode}</Badge>,
        },
      ]}
      describe={(r) => `${r.defectName} (machine ${r.workCenterCode})`}
      newDraft={() => ({ workCenterCode: '', defectName: '' })}
      toDraft={(r) => ({ workCenterCode: r.workCenterCode, defectName: r.defectName })}
      validate={(d) =>
        requireText(d.workCenterCode, 'Machine') ?? requireText(d.defectName, 'Defect name')
      }
      toRecord={(d) => ({
        workCenterCode: d.workCenterCode.trim(),
        defectName: d.defectName.trim(),
      })}
      renderForm={(d, patch) => (
        <>
          <Field label="Machine">
            <MachineSelect value={d.workCenterCode} onChange={(code) => patch({ workCenterCode: code })} autoFocus />
          </Field>
          <Field label="Defect name" hint="Arabic or English.">
            <Input
              dir="auto"
              value={d.defectName}
              onChange={(e) => patch({ defectName: e.target.value })}
              placeholder="خدش سطحى"
            />
          </Field>
        </>
      )}
    />
  )
}
