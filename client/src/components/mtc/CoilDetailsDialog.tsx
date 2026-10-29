// ============================================================================
// MTC — one coil, opened from the register: every field of the factory's
// sheet, its certified strengths against its grade, its certificate and
// delivery note to open, and its slitting — the day and the strips' widths
// after slitting, recorded here by whoever may.
// ============================================================================

import { useMemo, useState } from 'react'
import { Loader2, Plus, Scissors, Trash2, X } from 'lucide-react'
import { MTC_REGISTERS, SLITTING_MAX_STRIPS, cleanMtcNumber, slittingProblem, slittingText, type CoilSlitting } from '@qc/shared/mtc'
import { calendarDay } from '@qc/shared/rules'
import { Badge, Button, Modal } from '@/components/ui'
import { useAddSlitting, useCoilDetails, useRemoveSlitting } from '@/services/mtc'
import { useAuth } from '@/store/AuthContext'
import { useApp } from '@/store/AppContext'
import { cn, formatDay } from '@/lib/utils'
import { JudgedValue, fieldText, isJudged } from './cells'
import { MtcDocumentLink } from './MtcDocument'

const register = MTC_REGISTERS.coils

export function CoilDetailsDialog({ coilId, onClose }: { coilId: string; onClose: () => void }) {
  const details = useCoilDetails(coilId)
  const { can } = useAuth()
  const mayslit = can('record-slitting')
  const data = details.data
  const values = data?.coil.values ?? {}
  const standard = data?.coil.standard
  const coilNumber = String(values.coilNumber ?? '')
  const width = typeof values.width === 'number' ? values.width : null

  return (
    <Modal open onClose={onClose} title={coilNumber ? `Coil ${coilNumber}` : 'Coil'} icon={<Scissors className="h-5 w-5" />} size="xl">
      {details.isError ? (
        <p className="text-sm text-muted">This coil could not be loaded. It may have been removed.</p>
      ) : !data ? (
        <p className="flex items-center gap-2 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </p>
      ) : (
        <div className="space-y-5">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3 lg:grid-cols-4">
            {register.fields
              .filter((f) => f.key !== 'notes')
              .map((f) => (
                <div key={f.key} className="min-w-0">
                  <dt className="text-xs font-semibold uppercase text-muted">{f.unit ? `${f.label} (${f.unit})` : f.label}</dt>
                  <dd className={cn('truncate', f.mono && 'font-mono text-[13px]', f.identifies && 'font-bold')}>
                    {f.certificate && data.coil.documentId && values[f.key] !== undefined ? (
                      <MtcDocumentLink id={data.coil.documentId} title={`MTC ${values[f.key]}`}>
                        {String(values[f.key])}
                      </MtcDocumentLink>
                    ) : isJudged(f.key) ? (
                      <JudgedValue field={f} value={values[f.key]} standard={standard} />
                    ) : (
                      fieldText(f, values[f.key]) || '—'
                    )}
                  </dd>
                </div>
              ))}
          </dl>
          {values.notes !== undefined && <p className="whitespace-pre-wrap text-sm text-muted">{String(values.notes)}</p>}

          <section className="rounded-xl bg-slate-50 px-3 py-2 text-sm dark:bg-slate-800/60">
            {standard ? (
              <p>
                Judged by <b>{standard.grade}</b>
                {standard.standard ? ` (${standard.standard})` : ''} at its thickness: <span className="text-emerald-700 dark:text-emerald-300">green</span> within,{' '}
                <span className="text-rose-700 dark:text-rose-300">red</span> outside.
              </p>
            ) : (
              <p className="text-muted">No lab grade for {values.grade ? `${values.grade} at this thickness` : 'a coil without a grade'}: add its limits under Lab → Setup to compare the certificate.</p>
            )}
            {!data.coil.documentId && values.mtcNumber !== undefined && <p className="text-muted">The certificate’s file was not kept (registered before files were kept, or imported).</p>}
          </section>

          <section>
            <h3 className="mb-1 text-sm font-bold">Delivery note</h3>
            {data.deliveryNote ? (
              <p className="text-sm">
                {data.deliveryNote.documentId ? (
                  <MtcDocumentLink id={data.deliveryNote.documentId} title={`Delivery note ${data.deliveryNote.noteNumber}`}>
                    {data.deliveryNote.noteNumber || 'Delivery note'}
                  </MtcDocumentLink>
                ) : (
                  <b>{data.deliveryNote.noteNumber || 'Delivery note'}</b>
                )}{' '}
                · {formatDay(data.deliveryNote.deliveryDate)}
                {data.deliveryNote.poNumber ? ` · ${/^p\.?\s?o\b/i.test(data.deliveryNote.poNumber) ? '' : 'PO '}${data.deliveryNote.poNumber}` : ''}
                {data.deliveryNote.supplier ? ` · ${data.deliveryNote.supplier}` : ''}
              </p>
            ) : (
              <p className="text-sm text-muted">No delivery note lists this coil yet: its PO and delivery date come from the note once it is saved.</p>
            )}
          </section>

          <Slittings coilId={coilId} coilWidth={width} slittings={data.slittings} mayslit={mayslit} />
        </div>
      )}
    </Modal>
  )
}

function Slittings({ coilId, coilWidth, slittings, mayslit }: { coilId: string; coilWidth: number | null; slittings: CoilSlitting[]; mayslit: boolean }) {
  const { toast } = useApp()
  const remove = useRemoveSlitting(coilId)
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<CoilSlitting | null>(null)
  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <h3 className="flex-1 text-sm font-bold">Slitting</h3>
        {mayslit && !adding && (
          <Button className="min-h-[40px]" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" /> Record slitting
          </Button>
        )}
      </div>
      {adding && <SlittingForm coilId={coilId} coilWidth={coilWidth} onDone={() => setAdding(false)} />}
      {slittings.length === 0 ? (
        !adding && <p className="text-sm text-muted">Not slit.</p>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-xl ring-1 ring-slate-200 dark:divide-slate-800 dark:ring-slate-800">
          {slittings.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
              <span className="font-semibold">{formatDay(s.slitDate)}</span>
              <span className="font-mono tabular-nums">{slittingText(s.widths)} mm</span>
              <Badge tone="neutral">
                {s.widths.length} strip{s.widths.length === 1 ? '' : 's'} · {s.totalWidth} mm
                {coilWidth !== null ? ` · trim ${Math.round((coilWidth - s.totalWidth) * 1000) / 1000} mm` : ''}
              </Badge>
              {s.notes && <span className="text-muted">{s.notes}</span>}
              <span className="ml-auto text-xs text-muted">{s.createdByName}</span>
              {mayslit && (
                <button
                  type="button"
                  aria-label={`Remove the slitting of ${formatDay(s.slitDate)}`}
                  onClick={() => setRemoving(s)}
                  className="grid h-9 w-9 place-items-center rounded-lg text-muted hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <Modal
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title="Remove this slitting?"
        size="sm"
        footer={
          <>
            <Button className="min-h-[44px]" onClick={() => setRemoving(null)}>
              Keep
            </Button>
            <Button
              variant="danger"
              className="min-h-[44px]"
              disabled={remove.isPending}
              onClick={() =>
                removing &&
                remove.mutate(removing.id, {
                  onSuccess: () => setRemoving(null),
                  onError: (e) => toast(e instanceof Error ? e.message : 'The slitting could not be removed.', 'error'),
                })
              }
            >
              Remove
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-600 dark:text-slate-300">{removing ? `${formatDay(removing.slitDate)}: ${slittingText(removing.widths)} mm. The audit log keeps it.` : ''}</p>
      </Modal>
    </section>
  )
}

function SlittingForm({ coilId, coilWidth, onDone }: { coilId: string; coilWidth: number | null; onDone: () => void }) {
  const { factoryTimeZone } = useAuth()
  const { toast } = useApp()
  const add = useAddSlitting(coilId)
  const [slitDate, setSlitDate] = useState(() => calendarDay(new Date(), factoryTimeZone))
  const [widths, setWidths] = useState<string[]>(['', ''])
  const [notes, setNotes] = useState('')
  const parsed = useMemo(() => widths.filter((w) => w.trim() !== '').map((w) => cleanMtcNumber(w) ?? Number.NaN), [widths])
  const problem = slittingProblem(parsed, coilWidth)
  const total = parsed.every(Number.isFinite) ? Math.round(parsed.reduce((a, b) => a + b, 0) * 1000) / 1000 : null

  return (
    <form
      className="mb-3 space-y-3 rounded-xl p-3 ring-1 ring-brand-200 dark:ring-brand-500/30"
      onSubmit={(e) => {
        e.preventDefault()
        if (problem || !slitDate) return
        add.mutate(
          { slitDate, widths: parsed, notes: notes.trim() || undefined },
          { onSuccess: onDone, onError: (err) => toast(err instanceof Error ? err.message : 'The slitting could not be saved.', 'error') },
        )
      }}
    >
      <label className="block max-w-[12rem]">
        <span className="label">Slitting date</span>
        <input type="date" required className="input" value={slitDate} onChange={(e) => setSlitDate(e.target.value)} />
      </label>
      <fieldset>
        <legend className="label">Width after slitting (mm), strip by strip{coilWidth !== null ? ` — coil ${coilWidth} mm` : ''}</legend>
        <div className="flex flex-wrap items-center gap-2">
          {widths.map((w, i) => (
            <span key={i} className="inline-flex items-center gap-1">
              <input
                inputMode="decimal"
                className="input h-10 w-24 text-right tabular-nums"
                aria-label={`Strip ${i + 1} width, mm`}
                value={w}
                onChange={(e) => setWidths((all) => all.map((x, j) => (j === i ? e.target.value : x)))}
              />
              {widths.length > 1 && (
                <button
                  type="button"
                  aria-label={`Remove strip ${i + 1}`}
                  onClick={() => setWidths((all) => all.filter((_, j) => j !== i))}
                  className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </span>
          ))}
          <Button type="button" className="min-h-[40px]" disabled={widths.length >= SLITTING_MAX_STRIPS} onClick={() => setWidths((all) => [...all, all[all.length - 1] ?? ''])}>
            <Plus className="h-4 w-4" /> Strip
          </Button>
        </div>
        <p className={cn('mt-1 text-xs', problem && parsed.length > 0 ? 'text-rose-700 dark:text-rose-300' : 'text-muted')}>
          {parsed.length > 0 && problem ? problem : total !== null && parsed.length > 0 ? `${parsed.length} strips, ${total} mm${coilWidth !== null ? `; trim ${Math.round((coilWidth - total) * 1000) / 1000} mm` : ''}.` : 'Enter each strip’s width.'}
        </p>
      </fieldset>
      <label className="block">
        <span className="label">Notes</span>
        <input className="input" maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>
      <div className="flex justify-end gap-2">
        <Button type="button" className="min-h-[44px]" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" className="min-h-[44px]" disabled={!!problem || !slitDate || add.isPending}>
          {add.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Scissors className="h-4 w-4" />} Save slitting
        </Button>
      </div>
    </form>
  )
}
