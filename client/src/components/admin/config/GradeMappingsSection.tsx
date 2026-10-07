// ============================================================================
// Grade equivalences (§8.4).
// ============================================================================

import { useCallback } from 'react'
import { Shuffle } from 'lucide-react'
import { Field, Input } from '@/components/ui'
import { useMaster } from '@/services/queries'
import { MasterDataPanel, MachineSelect, numberOrNull, requireNumber, requireText } from '@/components/admin/MasterDataPanel'
import { type GradeMapping } from '@qc/shared/types'

interface GradeDraft {
  gradeA: string
  gradeB: string
}

export function GradeMappingsSection() {
  const { data: rows = [], isLoading: loading } = useMaster('grade-mappings')

  const sort = useCallback(
    (a: GradeMapping, b: GradeMapping) =>
      a.gradeA.localeCompare(b.gradeA) || a.gradeB.localeCompare(b.gradeB),
    [],
  )

  return (
    <MasterDataPanel<'grade-mappings', GradeDraft>
      title="Grade mappings"
      icon={<Shuffle className="h-5 w-5" />}
      kind='grade-mappings'
      rows={rows}
      loading={loading}
      sort={sort}
      addLabel="Add mapping"
      emptyHint="Add a pair of grades that should be treated as equivalent."
      minTableWidth="min-w-[26rem]"
      columns={[
        { key: 'a', label: 'Grade A', text: (r) => r.gradeA, render: (r) => <span className="font-semibold">{r.gradeA}</span> },
        { key: 'eq', label: '', className: 'w-8 text-center text-muted', filterable: false, render: () => '≡' },
        { key: 'b', label: 'Grade B', text: (r) => r.gradeB, render: (r) => <span className="font-semibold">{r.gradeB}</span> },
      ]}
      describe={(r) => `${r.gradeA} ≡ ${r.gradeB}`}
      newDraft={() => ({ gradeA: '', gradeB: '' })}
      toDraft={(r) => ({ gradeA: r.gradeA, gradeB: r.gradeB })}
      validate={(d) =>
        requireText(d.gradeA, 'Grade A') ??
        requireText(d.gradeB, 'Grade B') ??
        (d.gradeA.trim().toLowerCase() === d.gradeB.trim().toLowerCase()
          ? 'Both grades are the same — no mapping is needed.'
          : null)
      }
      toRecord={(d) => ({ gradeA: d.gradeA.trim(), gradeB: d.gradeB.trim() })}
      renderForm={(d, patch) => (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Grade A">
            <Input
              value={d.gradeA}
              onChange={(e) => patch({ gradeA: e.target.value })}
              placeholder="S355JR"
            />
          </Field>
          <Field label="Grade B">
            <Input
              value={d.gradeB}
              onChange={(e) => patch({ gradeB: e.target.value })}
              placeholder="ST52-3"
            />
          </Field>
        </div>
      )}
    />
  )
}
