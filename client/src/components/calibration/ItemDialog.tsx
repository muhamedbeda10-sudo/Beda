// ============================================================================
// §27 — Adding or correcting an instrument: its category (which fills the
// kind, interval, resolution and tolerance it usually has), its data, where
// it is held and by whom, and its calibration — the last one and the
// interval, the next worked out as it is typed.
// ============================================================================

import { useMemo, useState, type FormEvent } from 'react'
import { Loader2, Wand2 } from 'lucide-react'
import {
  CALIBRATION_KINDS, CALIBRATION_KIND_NAMES, INTERVAL_PRESETS, MAX_INTERVAL_MONTHS, calibrationStatus, nextDueOn, suggestCode,
  type CalibrationItem, type CalibrationItemData, type CalibrationKind, type CalibrationOptions,
} from '@qc/shared/calibration'
import { Button, Modal } from '@/components/ui'
import { Segmented } from '@/components/ui/PageShell'
import { useHoldUpdates } from '@/lib/appUpdate'
import { useSaveCalibrationItem } from '@/services/calibration'
import { useApp } from '@/store/AppContext'
import { calDay, daysText, numberText, parseNumber, StatusBadge } from './common'

interface Draft {
  categoryId: string
  name: string
  deviceCode: string
  manufacturer: string
  range: string
  resolution: string
  tolerance: string
  unit: string
  departmentId: string
  holder: string
  receivedOn: string
  kind: CalibrationKind
  calibrationCode: string
  lastCalibratedOn: string
  intervalMonths: string
  notes: string
}

const toDraft = (i?: CalibrationItem): Draft => ({
  categoryId: i?.categoryId ?? '', name: i?.name ?? '', deviceCode: i?.deviceCode ?? '', manufacturer: i?.manufacturer ?? '', range: i?.range ?? '',
  resolution: i?.resolution ?? '', tolerance: numberText(i?.tolerance), unit: i?.unit ?? 'mm', departmentId: i?.departmentId ?? '', holder: i?.holder ?? '',
  receivedOn: i?.receivedOn ?? '', kind: i?.kind ?? 'internal', calibrationCode: i?.calibrationCode ?? '', lastCalibratedOn: i?.lastCalibratedOn ?? '',
  intervalMonths: String(i?.intervalMonths ?? 12), notes: i?.notes ?? '',
})

export function ItemDialog({ item, options, onClose, onSaved }: { item?: CalibrationItem; options: CalibrationOptions; onClose: () => void; onSaved: (i: CalibrationItem) => void }) {
  const { toast } = useApp()
  const save = useSaveCalibrationItem(item?.id)
  const [initial] = useState(() => toDraft(item))
  const [d, setDraft] = useState<Draft>(initial)
  const [submissionId] = useState(() => crypto.randomUUID())
  const [discard, setDiscard] = useState(false)
  const set = (patch: Partial<Draft>) => setDraft((x) => ({ ...x, ...patch }))
  const dirty = JSON.stringify(d) !== JSON.stringify(initial)
  useHoldUpdates(dirty || save.isPending)

  const category = options.categories.find((c) => c.id === d.categoryId)
  const department = options.departments.find((x) => x.id === d.departmentId)
  const months = Number(d.intervalMonths)
  const monthsOk = Number.isInteger(months) && months >= 1 && months <= MAX_INTERVAL_MONTHS
  const tolerance = parseNumber(d.tolerance)
  const next = nextDueOn(d.lastCalibratedOn || null, monthsOk ? months : null)
  const status = calibrationStatus({ nextDueOn: next, scrapped: false }, options.today)
  const preset = INTERVAL_PRESETS.some((p) => p.months === months)
  const [customInterval, setCustomInterval] = useState(!preset)
  const suggestion = category?.codePrefix ? suggestCode(category.codePrefix, options.nextCodeNumber, department?.code ?? '') : ''
  const problems = [
    !d.name.trim() && 'the instrument’s name',
    !monthsOk && `an interval of 1 to ${MAX_INTERVAL_MONTHS} months`,
    tolerance === undefined && 'the tolerance as a number',
    d.receivedOn > options.today && 'a received day not still to come',
  ].filter(Boolean) as string[]
  const holders = useMemo(() => options.holders.slice(0, 1000), [options.holders])

  /** A category fills what it usually is, where nothing was typed yet (and its kind and interval on a new instrument). */
  function chooseCategory(id: string) {
    const c = options.categories.find((x) => x.id === id)
    if (!c) return set({ categoryId: '' })
    setDraft((x) => ({
      ...x,
      categoryId: id,
      kind: item ? x.kind : c.kind,
      intervalMonths: item ? x.intervalMonths : String(c.intervalMonths),
      resolution: x.resolution || c.resolution,
      tolerance: x.tolerance || numberText(c.tolerance),
      unit: x.unit && x.unit !== 'mm' ? x.unit : c.unit || 'mm',
    }))
    if (!item) setCustomInterval(!INTERVAL_PRESETS.some((p) => p.months === c.intervalMonths))
  }

  function close() { if (!save.isPending) { if (dirty) setDiscard(true); else onClose() } }
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (problems.length || save.isPending) return
    const data: CalibrationItemData = {
      categoryId: d.categoryId || null, name: d.name.trim(), deviceCode: d.deviceCode.trim(), manufacturer: d.manufacturer.trim(), range: d.range.trim(), resolution: d.resolution.trim(),
      tolerance: tolerance ?? null, unit: d.unit.trim(), departmentId: d.departmentId || null, holder: d.holder.trim(), receivedOn: d.receivedOn || null, kind: d.kind,
      calibrationCode: d.calibrationCode.trim(), lastCalibratedOn: d.lastCalibratedOn || null, intervalMonths: months, notes: d.notes.trim(),
    }
    try {
      const saved = await save.mutateAsync(item ? { ...data, version: item.version } : { ...data, submissionId })
      toast(item ? 'Saved.' : `${saved.name} added to the plan.`, 'success')
      onSaved(saved)
    } catch (error) { toast(error instanceof Error ? error.message : 'Could not save.', 'error') }
  }

  const text = (key: keyof Draft, label: string, max: number, extra?: { placeholder?: string; list?: string; required?: boolean }) => <label className="block">
    <span className="label">{label}</span>
    <input dir="auto" className="input" maxLength={max} value={d[key]} required={extra?.required} placeholder={extra?.placeholder} list={extra?.list} onChange={(e) => set({ [key]: e.target.value })} />
  </label>

  return <>
    <Modal open size="xl" title={item ? `Edit ${item.calibrationCode || item.name}` : 'Add an instrument'} onClose={close} footer={<>
      {problems.length > 0 && <span className="mr-auto text-xs text-danger-600 dark:text-danger-400">Needs {problems.join(', ')}.</span>}
      <Button type="button" variant="ghost" disabled={save.isPending} onClick={close}>Cancel</Button>
      <Button type="submit" form="calibration-item" variant="primary" disabled={problems.length > 0 || save.isPending}>{save.isPending && <Loader2 className="h-4 w-4 animate-spin" />}Save</Button>
    </>}>
      <form id="calibration-item" onSubmit={(e) => void submit(e)} className="space-y-4">
        <fieldset disabled={save.isPending} className="space-y-4">
          <section className="space-y-3" aria-labelledby="cal-device">
            <h3 id="cal-device" className="text-sm font-semibold">The instrument</h3>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <label className="block">
                <span className="label">Category</span>
                <select className="input" value={d.categoryId} onChange={(e) => chooseCategory(e.target.value)}>
                  <option value="">— None —</option>
                  {options.categories.map((c) => <option key={c.id} value={c.id}>{c.name}{c.codePrefix ? ` (${c.codePrefix})` : ''}</option>)}
                </select>
              </label>
              {text('name', 'Instrument name', 200, { required: true, placeholder: 'باكوليس / Vernier 150mm' })}
              {text('deviceCode', 'Device code / serial', 120)}
              {text('manufacturer', 'Manufacturer', 120, { placeholder: 'Insize' })}
              {text('range', 'Range', 120, { placeholder: '150mm' })}
              {text('resolution', 'Resolution', 60, { placeholder: '0.02 mm' })}
              <label className="block">
                <span className="label">Allowed tolerance (±)</span>
                <div className="flex gap-2">
                  <input inputMode="decimal" className="input tabular-nums" value={d.tolerance} aria-invalid={tolerance === undefined || undefined} onChange={(e) => set({ tolerance: e.target.value })} placeholder="0.02" />
                  <input aria-label="Unit" className="input w-24" maxLength={20} value={d.unit} onChange={(e) => set({ unit: e.target.value })} />
                </div>
              </label>
            </div>
          </section>
          <section className="space-y-3" aria-labelledby="cal-holder">
            <h3 id="cal-holder" className="text-sm font-semibold">Where it is held</h3>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="block">
                <span className="label">Department</span>
                <select className="input" value={d.departmentId} onChange={(e) => set({ departmentId: e.target.value })}>
                  <option value="">—</option>
                  {options.departments.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
              </label>
              {text('holder', 'Received by (holder)', 200, { list: 'calibration-holders' })}
              <datalist id="calibration-holders">{holders.map((h) => <option key={h} value={h} />)}</datalist>
              <label className="block"><span className="label">Received on</span><input type="date" className="input" value={d.receivedOn} max={options.today} onChange={(e) => set({ receivedOn: e.target.value })} /></label>
            </div>
          </section>
          <section className="space-y-3" aria-labelledby="cal-plan">
            <h3 id="cal-plan" className="text-sm font-semibold">Calibration</h3>
            <div className="flex flex-wrap items-center gap-3">
              <Segmented label="Calibration kind" value={d.kind} onChange={(kind) => set({ kind })} options={CALIBRATION_KINDS.map((k) => ({ value: k, label: CALIBRATION_KIND_NAMES[k] }))} />
              <span className="text-xs text-muted">{d.kind === 'external' ? 'By an outside laboratory: its certificate is kept as a PDF.' : 'By the quality department, on the app’s certificate.'}</span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <label className="block sm:col-span-2 lg:col-span-1">
                <span className="label">Calibration code</span>
                <div className="flex gap-1">
                  <input dir="ltr" className="input" maxLength={120} value={d.calibrationCode} placeholder={suggestion || 'V.01.QC.01'} onChange={(e) => set({ calibrationCode: e.target.value })} />
                  {suggestion && !d.calibrationCode && <button type="button" className="btn-ghost h-11 min-h-0 shrink-0 px-2" aria-label={`Use ${suggestion}`} data-tip={`Use ${suggestion}`} onClick={() => set({ calibrationCode: suggestion })}><Wand2 className="h-4 w-4" /></button>}
                </div>
                <span className="mt-1 block text-xs text-muted">{d.kind === 'external' ? 'The laboratory’s certificate number.' : suggestion ? `Next: ${suggestion}` : 'Prefix.number.department'}</span>
              </label>
              <label className="block"><span className="label">Last calibration</span><input type="date" className="input" value={d.lastCalibratedOn} onChange={(e) => set({ lastCalibratedOn: e.target.value })} /></label>
              <label className="block">
                <span className="label">Interval</span>
                {customInterval
                  ? <div className="flex items-center gap-2"><input type="number" min={1} max={MAX_INTERVAL_MONTHS} className="input tabular-nums" value={d.intervalMonths} aria-invalid={!monthsOk || undefined} onChange={(e) => set({ intervalMonths: e.target.value })} /><span className="text-sm text-muted">months</span></div>
                  : <select className="input" value={d.intervalMonths} onChange={(e) => { if (e.target.value === 'custom') setCustomInterval(true); else set({ intervalMonths: e.target.value }) }}>
                    {INTERVAL_PRESETS.map((p) => <option key={p.months} value={p.months}>{p.label}</option>)}
                    <option value="custom">Other…</option>
                  </select>}
              </label>
              <div>
                <span className="label">Next calibration</span>
                <div className="flex min-h-11 flex-wrap items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm dark:bg-slate-800/60" aria-live="polite">
                  <span className="font-semibold tabular-nums">{calDay(next)}</span>
                  {next && <StatusBadge status={status} />}
                  {next && <span className="text-xs text-muted">{daysText({ status, daysLeft: Math.round((Date.parse(`${next}T00:00:00Z`) - Date.parse(`${options.today}T00:00:00Z`)) / 86_400_000) })}</span>}
                </div>
              </div>
            </div>
            <label className="block"><span className="label">Notes</span><textarea dir="auto" rows={2} maxLength={4000} className="input" value={d.notes} onChange={(e) => set({ notes: e.target.value })} /></label>
          </section>
        </fieldset>
      </form>
    </Modal>
    {discard && <Modal open size="sm" title="Discard changes?" onClose={() => setDiscard(false)} footer={<><Button onClick={() => setDiscard(false)}>Keep editing</Button><Button variant="danger" onClick={onClose}>Discard</Button></>}>
      <p className="text-sm">What was entered is not saved.</p>
    </Modal>}
  </>
}
