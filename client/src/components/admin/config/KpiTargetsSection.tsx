// ============================================================================
// KPI targets (§15.3): the lines between green, amber and red on the
// dashboard. Defaults come from the shared contract; an administrator sets
// the factory's own here and the change lands in the audit log.
// ============================================================================

import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Gauge, RotateCcw, Save } from 'lucide-react'
import { DEFAULT_KPI_THRESHOLDS, type KpiThresholds } from '@qc/shared/kpi'
import { Button, Card, Field, Input } from '@/components/ui'
import { useKpiThresholds } from '@/services/queries'
import { saveKpiThresholds } from '@/services/mutations'
import { useApp } from '@/store/AppContext'
import { ApiError } from '@/lib/api'
import { formatDateTime } from '@/lib/utils'

type Draft = Record<keyof KpiThresholds, string>

interface FieldSpec {
  key: keyof KpiThresholds
  label: string
  hint: string
  step?: string
}

const GROUPS: { title: string; note: string; fields: FieldSpec[] }[] = [
  {
    title: 'Defect rate',
    note: 'Defect pieces per 100 inspected pieces. Lower is better.',
    fields: [
      { key: 'defectRateGreen', label: 'Green at or under (%)', hint: 'On target', step: '0.1' },
      { key: 'defectRateAmber', label: 'Amber at or under (%)', hint: 'Above this is red', step: '0.1' },
    ],
  },
  {
    title: 'First-pass yield',
    note: 'Samples with no defect and no failed dimension, as a % of samples. Higher is better.',
    fields: [
      { key: 'fpyGreen', label: 'Green at or above (%)', hint: 'On target', step: '0.1' },
      { key: 'fpyAmber', label: 'Amber at or above (%)', hint: 'Below this is red', step: '0.1' },
    ],
  },
  {
    title: 'Dimensions out of tolerance',
    note: 'Failed dimensions as a % of measured. Lower is better.',
    fields: [
      { key: 'dimFailGreen', label: 'Green at or under (%)', hint: 'On target', step: '0.1' },
      { key: 'dimFailAmber', label: 'Amber at or under (%)', hint: 'Above this is red', step: '0.1' },
    ],
  },
  {
    title: 'Process capability',
    note: 'Cpk of a dimension against its tolerance. 1.33 is the usual target for a controlled process.',
    fields: [
      { key: 'cpkGreen', label: 'Green at or above', hint: 'Capable', step: '0.01' },
      { key: 'cpkAmber', label: 'Amber at or above', hint: 'Below this is red', step: '0.01' },
      { key: 'minReadingsForCpk', label: 'Readings before Cpk is shown', hint: 'Fewer readings give a misleading figure', step: '1' },
    ],
  },
  {
    title: 'PT weld rejects',
    note: 'Lengths rejected as a % of tested. Lower is better.',
    fields: [
      { key: 'ptRejectGreen', label: 'Green at or under (%)', hint: 'On target', step: '0.1' },
      { key: 'ptRejectAmber', label: 'Amber at or under (%)', hint: 'Above this is red', step: '0.1' },
    ],
  },
  {
    title: 'Hold ageing',
    note: 'A defect left on Hold with no disposition.',
    fields: [
      { key: 'holdAgeAmberDays', label: 'Amber after (days)', hint: 'Worth a reminder', step: '1' },
      { key: 'holdAgeRedDays', label: 'Red after (days)', hint: 'Needs a decision', step: '1' },
    ],
  },
  {
    title: 'Attention',
    note: 'What the insights panel calls out.',
    fields: [
      { key: 'idleMachineDays', label: 'Idle machine after (days)', hint: 'Open orders, no sample', step: '1' },
      { key: 'trendAlertPct', label: 'Trend alert (%)', hint: 'Change vs previous period worth a line', step: '1' },
    ],
  },
]

function toDraft(t: KpiThresholds): Draft {
  const d = {} as Draft
  for (const k of Object.keys(t) as (keyof KpiThresholds)[]) d[k] = String(t[k])
  return d
}

function fromDraft(d: Draft): { value?: KpiThresholds; error?: string } {
  const out = {} as KpiThresholds
  for (const g of GROUPS) {
    for (const f of g.fields) {
      const raw = d[f.key].trim()
      const n = Number(raw)
      if (raw === '' || !Number.isFinite(n) || n < 0) return { error: `${g.title}: "${f.label}" needs a number.` }
      if (f.step === '1' && !Number.isInteger(n)) return { error: `${g.title}: "${f.label}" must be a whole number.` }
      out[f.key] = n
    }
  }
  const order: [keyof KpiThresholds, keyof KpiThresholds, string][] = [
    ['defectRateGreen', 'defectRateAmber', 'Defect rate: green must not exceed amber.'],
    ['dimFailGreen', 'dimFailAmber', 'Dimensions: green must not exceed amber.'],
    ['ptRejectGreen', 'ptRejectAmber', 'PT rejects: green must not exceed amber.'],
    ['holdAgeAmberDays', 'holdAgeRedDays', 'Hold ageing: amber must not exceed red.'],
    ['fpyAmber', 'fpyGreen', 'First-pass yield: amber must not exceed green.'],
    ['cpkAmber', 'cpkGreen', 'Capability: amber must not exceed green.'],
  ]
  for (const [lo, hi, msg] of order) if (out[lo] > out[hi]) return { error: msg }
  if (out.minReadingsForCpk < 3) return { error: 'Capability: at least 3 readings are needed.' }
  return { value: out }
}

export function KpiTargetsSection() {
  const qc = useQueryClient()
  const { toast } = useApp()
  const { data, isLoading } = useKpiThresholds()
  const [draft, setDraft] = useState<Draft>(() => toDraft(DEFAULT_KPI_THRESHOLDS))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (data) setDraft(toDraft(data.thresholds))
  }, [data])

  const dirty = data ? JSON.stringify(toDraft(data.thresholds)) !== JSON.stringify(draft) : false

  const save = async () => {
    const parsed = fromDraft(draft)
    if (!parsed.value) {
      setError(parsed.error ?? 'Check the values.')
      return
    }
    setError(null)
    setSaving(true)
    try {
      await saveKpiThresholds(qc, parsed.value)
      toast('KPI targets saved.', 'success')
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save the targets.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card className="space-y-5 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-100 text-brand-700 dark:bg-brand-500/15 dark:text-brand-200">
            <Gauge className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h3 className="text-base font-bold">KPI targets</h3>
            <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
              Where the dashboard turns green, amber and red.
              {data?.updatedAt ? ` Last changed ${formatDateTime(data.updatedAt)}${data.updatedByName ? ` by ${data.updatedByName}` : ''}.` : ' Using the defaults.'}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button className="min-h-[44px]" onClick={() => setDraft(toDraft(DEFAULT_KPI_THRESHOLDS))} disabled={saving || isLoading}>
            <RotateCcw className="h-4 w-4" /> Defaults
          </Button>
          <Button variant="primary" className="min-h-[44px]" onClick={save} disabled={saving || isLoading || !dirty}>
            <Save className="h-4 w-4" /> {saving ? 'Saving…' : 'Save targets'}
          </Button>
        </div>
      </div>

      {error && <p className="rounded-xl bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">{error}</p>}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {GROUPS.map((g) => (
          <div key={g.title} className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
            <p className="font-semibold">{g.title}</p>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{g.note}</p>
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {g.fields.map((f) => (
                <Field key={f.key} label={f.label} hint={f.hint}>
                  <Input type="number" inputMode="decimal" min={0} step={f.step ?? '0.1'} value={draft[f.key]} onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))} disabled={isLoading} />
                </Field>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Card>
  )
}
