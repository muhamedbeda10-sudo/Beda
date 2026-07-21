import { useState } from 'react'
import { Plus, Trash2, Ruler } from 'lucide-react'
import type { DimensionResult, InspectionSample } from '@/types'
import { useDB, actions } from '@/store/db'
import { dimsOf } from '@/lib/selectors'
import { evalDimension, cn } from '@/lib/utils'
import { Badge, Button, Select, resultTone } from '@/components/ui'

export function DimensionTable({ sample }: { sample: InspectionSample }) {
  const db = useDB()
  const dims = dimsOf(db, sample.id)
  const [adding, setAdding] = useState(false)

  function commitMeasured(dim: DimensionResult, raw: string) {
    const measured = raw === '' ? null : Number(raw)
    const result = evalDimension({ ...dim, measured })
    actions.updateDimension(dim.id, { measured, result })
    actions.recomputeSample(sample.id)
  }

  function addFromSpec(specId: string) {
    const spec = db.dimensionSpecs.find((s) => s.id === specId)
    if (!spec) return
    actions.addDimension({
      sampleId: sample.id,
      code: spec.code,
      name: spec.name,
      target: spec.target,
      tolMinus: spec.tolMinus,
      tolPlus: spec.tolPlus,
      measured: null,
      unit: spec.unit,
      result: 'Pending',
    })
    actions.recomputeSample(sample.id)
    setAdding(false)
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h4 className="flex items-center gap-1.5 text-sm font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          <Ruler className="h-4 w-4" /> Dimension Results
        </h4>
        <Button variant="secondary" className="!px-2.5 !py-1.5 text-xs" onClick={() => setAdding((a) => !a)}>
          <Plus className="h-3.5 w-3.5" /> Add
        </Button>
      </div>

      {adding && (
        <div className="mb-2 flex items-center gap-2 rounded-xl bg-slate-50 p-2.5 dark:bg-slate-800/50">
          <Select className="flex-1" defaultValue="" onChange={(e) => e.target.value && addFromSpec(e.target.value)}>
            <option value="" disabled>
              Choose a dimension spec…
            </option>
            {db.dimensionSpecs
              .filter((s) => s.active)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code} · {s.name} ({s.target}±{s.tolPlus} {s.unit})
                </option>
              ))}
          </Select>
          <Button variant="ghost" className="!px-2.5" onClick={() => setAdding(false)}>
            Cancel
          </Button>
        </div>
      )}

      {dims.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-200 py-4 text-center text-sm text-slate-400 dark:border-slate-700">
          No measurements yet.
        </p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-400 dark:bg-slate-800/60">
              <tr>
                <th className="px-3 py-2 text-left font-semibold">Dim</th>
                <th className="px-2 py-2 text-right font-semibold">Target</th>
                <th className="px-2 py-2 text-center font-semibold">Tol</th>
                <th className="px-2 py-2 text-center font-semibold">Measured</th>
                <th className="px-2 py-2 text-center font-semibold">Result</th>
                <th className="px-1 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {dims.map((dim) => (
                <tr key={dim.id} className={cn(dim.result === 'Fail' && 'bg-rose-50/50 dark:bg-rose-500/5')}>
                  <td className="px-3 py-2">
                    <span className="font-bold">{dim.code}</span>
                    <span className="ml-1 hidden text-xs text-slate-400 sm:inline">{dim.name}</span>
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">
                    {dim.target}
                    <span className="text-xs text-slate-400"> {dim.unit}</span>
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 text-center text-xs text-slate-400">
                    +{dim.tolPlus}/-{dim.tolMinus}
                  </td>
                  <td className="px-2 py-2 text-center">
                    <input
                      type="number"
                      inputMode="decimal"
                      step="0.01"
                      defaultValue={dim.measured ?? ''}
                      onBlur={(e) => commitMeasured(dim, e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                      placeholder="—"
                      className={cn(
                        'w-20 rounded-lg border px-2 py-1.5 text-center text-sm tabular-nums focus:outline-none focus:ring-2',
                        dim.result === 'Fail'
                          ? 'border-rose-300 focus:ring-rose-400/40 dark:border-rose-500/40 dark:bg-slate-800'
                          : 'border-slate-300 focus:ring-brand-400/40 dark:border-slate-600 dark:bg-slate-800',
                      )}
                    />
                  </td>
                  <td className="px-2 py-2 text-center">
                    <Badge tone={resultTone(dim.result)}>{dim.result}</Badge>
                  </td>
                  <td className="px-1 py-2">
                    <button
                      onClick={() => {
                        actions.deleteDimension(dim.id)
                        actions.recomputeSample(sample.id)
                      }}
                      className="rounded p-1 text-slate-300 hover:bg-rose-50 hover:text-rose-500 dark:hover:bg-rose-500/10"
                      aria-label="Delete measurement"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
