// ============================================================================
// One sample in full — the record the History drill-down and the session card
// on the board both open: measurements, defects, coils, paint and PT, with the
// correction pencils only where the caller allows them.
// ============================================================================

import type { ReactNode } from 'react'
import { AlertTriangle, Droplets, Info, Package2, Pencil, Ruler, ShieldCheck, SprayCan } from 'lucide-react'
import { Badge } from '@/components/ui'
import { ImagePicker } from '@/components/inspection/ImagePicker'
import { shiftName } from '@/domain'
import { formatDateTime } from '@/lib/utils'
import type {
  DefectResult,
  DimensionResult,
  DimensionStatus,
  Disposition,
  InspectionSample,
  InspectionSession,
  PTRecord,
  PaintSampleRecord,
  Process,
  SampleCoil,
} from '@qc/shared/types'
import type { SessionWithOrder } from '@qc/shared/api'
import { When } from '@/components/ui/Tooltip'

export function statusToneOf(s: DimensionStatus) {
  return s === 'Pass' ? 'green' : s === 'Fail' ? 'red' : s === 'Warning' ? 'amber' : 'neutral'
}

export function dispositionToneOf(d: Disposition | null) {
  switch (d) {
    case 'Rejected':
      return 'red'
    case 'Hold':
      return 'amber'
    case 'Repair':
      return 'violet'
    case 'Used in another order':
      return 'blue'
    case 'Accept with concession':
      return 'green'
    default:
      return 'neutral'
  }
}

export function num(v: number | null | undefined, dash = '—'): string {
  return v === null || v === undefined || Number.isNaN(v) ? dash : String(v)
}

export function SampleDetail({
  session,
  process,
  sample,
  dimensions,
  defects,
  coils,
  paint,
  pt,
  loading,
  editable,
  onEditDimension,
  onEditDefect,
}: {
  session: SessionWithOrder | InspectionSession
  process: Process
  sample: InspectionSample
  dimensions: DimensionResult[]
  defects: DefectResult[]
  coils: SampleCoil[]
  paint?: PaintSampleRecord
  pt?: PTRecord
  loading: boolean
  editable: boolean
  onEditDimension: (d: DimensionResult) => void
  onEditDefect: (d: DefectResult) => void
}) {
  return (
    <div className="space-y-5">
      <dl className="grid grid-cols-2 gap-3 rounded-2xl bg-slate-50 p-4 dark:bg-slate-800/60 sm:grid-cols-4">
        <Attr label="Shift" value={shiftName(sample.shift)} />
        <Attr label="Recorded" value={formatDateTime(sample.createdAt)} />
        <Attr label="Inspector" value={sample.inspectorName} />
        <Attr label="Sample qty" value={sample.sampleQty} />
        <Attr label="Drawing" value={sample.drawing} />
        <Attr label="Drawing alt" value={sample.drawingAlt} />
        <Attr label="Issue" value={sample.issue} />
        <Attr label="Machine" value={session.workCenterCode} />
      </dl>

      {sample.gradeAcknowledgement && (
        <p className="flex items-start gap-2 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/20">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Grade mismatch acknowledged by {sample.gradeAcknowledgement.byName} on <When iso={sample.gradeAcknowledgement.at} time /> — expected{' '}
            {sample.gradeAcknowledgement.expectedGrade}, found {sample.gradeAcknowledgement.foundGrades.join(', ') || '—'}.
          </span>
        </p>
      )}

      <Section icon={<Ruler className="h-4 w-4" />} title={process === 'paint' ? 'Paint thickness readings' : 'Dimensions'} count={dimensions.length}>
        {loading && dimensions.length === 0 ? (
          <SectionEmpty message="Loading the measurements…" />
        ) : dimensions.length === 0 ? (
          <SectionEmpty message={process === 'paint' ? 'No thickness readings were recorded on this sample.' : 'No dimensions were measured on this sample.'} />
        ) : process === 'paint' ? (
          // Recorded as measured: no required value, so no judgement column.
          <ul className="grid grid-cols-3 gap-2">
            {dimensions.map((d) => (
              <li key={d.id} className="rounded-xl bg-slate-50 px-3 py-2 text-center dark:bg-slate-800/60">
                <span className="block text-xs font-semibold uppercase text-muted">Reading {d.sequence}</span>
                <span className="flex items-center justify-center gap-1 text-lg font-bold tabular-nums">
                  {num(d.actual)} <span className="text-xs font-normal text-muted">{d.unit}</span>
                  {editable && (
                    <button type="button" onClick={() => onEditDimension(d)} className="ml-1 rounded p-1 text-slate-300 hover:text-brand-600" aria-label={`Correct reading ${d.sequence}`}>
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-left text-xs font-bold uppercase tracking-wide text-muted dark:border-slate-800">
                  <th className="py-2 pr-3">Dimension</th>
                  <th className="py-2 pr-3 text-right">Nominal</th>
                  <th className="py-2 pr-3 text-right">Tolerance ±</th>
                  <th className="py-2 pr-3 text-right">Actual</th>
                  <th className="py-2 pr-3">Status</th>
                  {editable && <th className="py-2" />}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {dimensions.map((d) => (
                  <tr key={d.id}>
                    <td className="py-2.5 pr-3 font-semibold" dir="auto">
                      {d.name}
                      {d.unit && <span className="ml-1 text-xs font-normal text-muted">({d.unit})</span>}
                    </td>
                    <td className="py-2.5 pr-3 text-right tabular-nums">{num(d.nominal)}</td>
                    <td className="py-2.5 pr-3 text-right tabular-nums text-muted">
                      +{num(d.tolPlus)} / -{num(d.tolMinus)}
                    </td>
                    <td className="py-2.5 pr-3 text-right font-bold tabular-nums">{num(d.actual)}</td>
                    <td className="py-2.5 pr-3">
                      <Badge tone={statusToneOf(d.status)}>{d.status}</Badge>
                    </td>
                    {editable && (
                      <td className="py-2.5 text-right">
                        <button
                          onClick={() => onEditDimension(d)}
                          className="inline-grid h-11 w-11 place-items-center rounded-xl text-muted transition-colors hover:bg-slate-100 hover:text-brand-600 dark:hover:bg-slate-800"
                          aria-label={`Correct ${d.name}`}
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section icon={<AlertTriangle className="h-4 w-4" />} title="Defects" count={defects.length}>
        {loading && defects.length === 0 ? (
          <SectionEmpty message="Loading the defects…" />
        ) : defects.length === 0 ? (
          <SectionEmpty message="No defects were recorded on this sample." />
        ) : (
          <div className="space-y-3">
            {defects.map((d) => (
              <div key={d.id} className="rounded-2xl p-4 ring-1 ring-slate-200 dark:ring-slate-700">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-bold" dir="auto">
                    {d.defectName}
                  </span>
                  <Badge tone="neutral">Qty {d.qty}</Badge>
                  <Badge tone={dispositionToneOf(d.disposition)}>{d.disposition ?? 'No disposition'}</Badge>
                  {editable && (
                    <button
                      onClick={() => onEditDefect(d)}
                      className="ml-auto inline-grid h-11 w-11 place-items-center rounded-xl text-muted transition-colors hover:bg-slate-100 hover:text-brand-600 dark:hover:bg-slate-800"
                      aria-label={`Correct ${d.defectName}`}
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                  )}
                </div>
                {d.notes && (
                  <p className="mt-2 text-sm text-slate-600 dark:text-slate-300" dir="auto">
                    {d.notes}
                  </p>
                )}
                <div className="mt-3">
                  <ImagePicker imageIds={d.imageIds} onChange={() => {}} readOnly />
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section icon={<Package2 className="h-4 w-4" />} title="Coils used" count={coils.length}>
        {loading && coils.length === 0 ? (
          <SectionEmpty message="Loading the coils…" />
        ) : coils.length === 0 ? (
          <SectionEmpty message="No coils were attached to this sample." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-left text-xs font-bold uppercase tracking-wide text-muted dark:border-slate-800">
                  <th className="py-2 pr-3">Coil</th>
                  <th className="py-2 pr-3">Grade</th>
                  <th className="py-2 pr-3">SM type</th>
                  <th className="py-2 pr-3">Supplier</th>
                  <th className="py-2 pr-3 text-right">Thickness</th>
                  <th className="py-2 pr-3 text-right">Width</th>
                  <th className="py-2 text-right">Yield</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {coils.map((c) => {
                  // What the sample recorded comes first; where it recorded nothing,
                  // what the register says today fills in, and says so.
                  const reg = c.register
                  const cell = (own: string | number | undefined, fromRegister: string | number | undefined) =>
                    own !== undefined && own !== '' ? (
                      <span>{typeof own === 'number' ? num(own) : own}</span>
                    ) : fromRegister !== undefined && fromRegister !== '' ? (
                      <span className="text-muted" data-tip="From the coil register today, not recorded with the sample">
                        {typeof fromRegister === 'number' ? num(fromRegister) : fromRegister}
                      </span>
                    ) : (
                      '—'
                    )
                  return (
                    <tr key={c.id}>
                      <td className="py-2.5 pr-3 font-semibold">
                        <span className="flex flex-wrap items-center gap-1.5">
                          {c.coilNumber}
                          {!c.coilId && <Badge tone="amber">typed</Badge>}
                          {reg && <Badge tone="neutral">from register</Badge>}
                        </span>
                      </td>
                      <td className="py-2.5 pr-3">{cell(c.grade, reg?.grade)}</td>
                      <td className="py-2.5 pr-3">{cell(c.smType, reg?.smType)}</td>
                      <td className="py-2.5 pr-3">{cell(c.supplier, reg?.supplier)}</td>
                      <td className="py-2.5 pr-3 text-right tabular-nums">{cell(c.thickness, reg?.thickness)}</td>
                      <td className="py-2.5 pr-3 text-right tabular-nums">{cell(c.width, reg?.width)}</td>
                      <td className="py-2.5 text-right tabular-nums">{cell(c.yield, reg?.yield)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {process === 'paint' && (
        <Section icon={<SprayCan className="h-4 w-4" />} title="Paint sample">
          {!paint ? (
            <SectionEmpty message="No paint sample was recorded for this sample." />
          ) : (
            <div className="space-y-3">
              {paint.notes && (
                <p className="text-sm text-slate-600 dark:text-slate-300" dir="auto">
                  {paint.notes}
                </p>
              )}
              <ImagePicker imageIds={paint.imageIds} onChange={() => {}} readOnly />
            </div>
          )}
        </Section>
      )}

      {process === 'welding' && (
        <Section icon={<Droplets className="h-4 w-4" />} title="PT / weld inspection">
          {!pt ? (
            <SectionEmpty message="No PT record was captured for this sample." />
          ) : (
            <div className="space-y-4">
              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Attr label="Cleaner lot" value={pt.consumableLots.Cleaner} />
                <Attr label="Penetrant lot" value={pt.consumableLots.Penetrant} />
                <Attr label="Developer lot" value={pt.consumableLots.Developer} />
                {pt.testFrequencyPct !== null && pt.testFrequencyPct !== undefined && <Attr label="Test frequency (typed)" value={`${pt.testFrequencyPct}%`} />}
                <Attr label="Welding wire batch" value={pt.weldingWireBatch} />
                <div>
                  <dt className="text-xs font-semibold uppercase text-muted">PT verdict</dt>
                  <dd className="mt-0.5">
                    {pt.acceptOrRepair ? <Badge tone={pt.acceptOrRepair === 'Accept' ? 'green' : 'red'}>{pt.acceptOrRepair}</Badge> : <span className="text-muted">—</span>}
                  </dd>
                </div>
                {/* Older records carry the free-text fields the form used to have. */}
                {pt.sampleSize && <Attr label="Sample size" value={pt.sampleSize} />}
                {pt.testedWeldLength && <Attr label="Tested weld length" value={pt.testedWeldLength} />}
                {pt.indicationType && <Attr label="Indication type" value={pt.indicationType} />}
                {pt.indicationSize && <Attr label="Indication size" value={pt.indicationSize} />}
                {pt.finalResult && <Attr label="Final result" value={pt.finalResult} />}
              </dl>
              {(pt.testedLengths ?? []).length > 0 && (
                <div>
                  <p className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">Tested weld lengths</p>
                  <ul className="flex flex-wrap gap-2">
                    {pt.testedLengths.map((l) => (
                      <li key={l.id ?? l.seq} className="flex items-center gap-2 rounded-xl bg-slate-50 px-3 py-2 text-sm dark:bg-slate-800/60">
                        <span className="text-muted">#{l.seq}</span>
                        <span className="font-bold tabular-nums">{l.lengthMm} mm</span>
                        <Badge tone={l.verdict === 'Accept' ? 'green' : 'red'}>{l.verdict}</Badge>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {pt.notes && (
                <p className="text-sm text-slate-600 dark:text-slate-300" dir="auto">
                  {pt.notes}
                </p>
              )}
              <div>
                <p className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">Attachments</p>
                <ImagePicker imageIds={pt.imageIds} onChange={() => {}} readOnly />
              </div>
            </div>
          )}
        </Section>
      )}
    </div>
  )
}

// ---- Small building blocks -------------------------------------------------


export function Section({ icon, title, count, children }: { icon: ReactNode; title: string; count?: number; children: ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <span className="text-muted">{icon}</span>
        <h3 className="text-sm font-bold uppercase tracking-wide text-muted">{title}</h3>
        {count !== undefined && count > 0 && <Badge tone="neutral">{count}</Badge>}
      </div>
      {children}
    </section>
  )
}

export function SectionEmpty({ message }: { message: string }) {
  return <p className="rounded-2xl border border-dashed border-slate-200 px-4 py-4 text-sm text-muted dark:border-slate-700">{message}</p>
}

export function Attr({ label, value }: { label: string; value?: string | number | null }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</dt>
      <dd className="truncate font-semibold tabular-nums" dir="auto">
        {value === undefined || value === null || value === '' ? '—' : value}
      </dd>
    </div>
  )
}
