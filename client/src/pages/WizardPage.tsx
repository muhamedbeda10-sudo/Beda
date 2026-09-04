import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Save,
  Plus,
  Trash2,
  AlertTriangle,
  Ruler,
  Camera,
  FlaskConical,
  ClipboardList,
  Layers,
  Loader2,
  CheckCircle2,
  CloudOff,
  Search,
} from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Select } from '@/components/ui'
import { ImagePicker } from '@/components/inspection/ImagePicker'
import { useWizardContext } from '@/services/queries'
import { saveSample } from '@/services/mutations'
import { loadDraft, saveDraft, clearDraft, type SampleDraft, type DraftDefect } from '@/services/draftStore'
import { useApp } from '@/store/AppContext'
import { useAuth } from '@/store/AuthContext'
import { cn, uid, newSubmissionId } from '@/lib/utils'
import {
  DISPOSITIONS,
  type Disposition,
  type PTConsumableKind,
  type ProductionOrder,
  type PTConsumableProduct,
  type ItemReferenceImage,
} from '@qc/shared/types'
import type { SaveSampleRequest } from '@qc/shared/api'
import {
  stepsForWorkCenter,
  deriveShift,
  shiftName,
  dimensionStatus,
  resolveDimensions,
  validateSample,
  buildGradeIndex,
  findGradeMismatches,
  isPaintWorkCenter,
  isPTWorkCenter,
  type WizardStep,
} from '@qc/shared/rules'

const STEP_META: Record<WizardStep, { label: string; icon: typeof Ruler }> = {
  setup: { label: 'Setup', icon: ClipboardList },
  dimensions: { label: 'Dimensions', icon: Ruler },
  defects: { label: 'Defects', icon: AlertTriangle },
  paint: { label: 'Paint Sample', icon: Camera },
  pt: { label: 'PT / Weld', icon: FlaskConical },
  review: { label: 'Review & Save', icon: Check },
}

const CONSUMABLE_KINDS: PTConsumableKind[] = ['Cleaner', 'Penetrant', 'Developer']

export function WizardPage() {
  const { sessionId = '' } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { toast } = useApp()
  const { factoryTimeZone } = useAuth()

  // The wizard needs exactly one session and one order, plus the configuration
  // for that order's item and work centre. The API answers all of it in one
  // round trip; nothing here reads a whole table.
  const { data: ctx, isLoading: sessionsLoading, error: loadError } = useWizardContext(sessionId)
  const session = ctx?.session
  const order = ctx?.order
  const wc = session?.workCenterCode ?? ''

  const dimOrder = useMemo(() => ctx?.dimensionOrder ?? [], [ctx])
  const dimMaster = useMemo(() => ctx?.dimensionMaster ?? [], [ctx])
  const refImages = useMemo(() => ctx?.referenceImages ?? [], [ctx])
  const wcDefects = useMemo(() => ctx?.workCenterDefects ?? [], [ctx])
  const gradeMappings = useMemo(() => ctx?.gradeMappings ?? [], [ctx])
  const consumables = useMemo(() => ctx?.ptConsumables ?? [], [ctx])
  const priorSamples = useMemo(() => ctx?.samples ?? [], [ctx])
  const steps = useMemo(() => stepsForWorkCenter(wc), [wc])

  const [draft, setDraft] = useState<SampleDraft | null>(null)
  const [saving, setSaving] = useState(false)
  const [gradePrompt, setGradePrompt] = useState<null | { mismatches: { coilNumber: string; coilGrade: string }[] }>(null)
  const [online, setOnline] = useState(navigator.onLine)

  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])

  // Build (or resume) the draft once the session and its configuration load.
  useEffect(() => {
    if (!session || !order || draft) return
    const existing = loadDraft(session.id)
    if (existing) {
      setDraft(existing)
      return
    }
    const rows = resolveDimensions({
      item: order.item,
      order: dimOrder,
      master: dimMaster,
      previous: [],
    })
    setDraft({
      sessionId: session.id,
      orderId: order.id,
      workCenterCode: session.workCenterCode,
      submissionId: newSubmissionId(),
      step: 'setup',
      drawing: order.drawing ?? '',
      drawingAlt: order.drawingAlt,
      issue: order.issue,
      sampleQty: '1',
      coils: [],
      dimensions: rows.map((r) => ({
        name: r.name,
        sequence: r.sequence,
        nominal: r.nominal === null ? '' : String(r.nominal),
        tolPlus: String(r.tolPlus),
        tolMinus: String(r.tolMinus),
        actual: '',
        unit: r.unit,
        source: r.source,
      })),
      defects: [],
      paint: { imageIds: [] },
      pt: isPTWorkCenter(session.workCenterCode)
        ? { testFrequencyPct: '', consumableLots: {}, imageIds: [] }
        : undefined,
      updatedAt: new Date().toISOString(),
    })
  }, [session, order, draft, dimOrder, dimMaster])

  // Persist on every change so a reload or a dead network loses nothing (§9.6).
  const update = useCallback((patch: Partial<SampleDraft> | ((d: SampleDraft) => SampleDraft)) => {
    setDraft((cur) => {
      if (!cur) return cur
      const next = typeof patch === 'function' ? patch(cur) : { ...cur, ...patch }
      saveDraft(next)
      return next
    })
  }, [])

  const gradeIndex = useMemo(() => buildGradeIndex(gradeMappings), [gradeMappings])

  const defectOptions = useMemo(
    () =>
      Array.from(
        new Set(wcDefects.filter((d) => d.workCenterCode === wc).map((d) => d.defectName)),
      ).sort(),
    [wcDefects, wc],
  )

  const issues = useMemo(() => {
    if (!draft) return []
    return validateSample({
      workCenterCode: draft.workCenterCode,
      sampleQty: Number(draft.sampleQty),
      drawing: draft.drawing,
      coils: draft.coils.map((c) => ({ coilNumber: c.coilNumber, grade: c.grade })),
      defects: draft.defects.map((d) => ({
        defectName: d.defectName,
        disposition: d.disposition,
        qty: Number(d.qty),
      })),
      pt: draft.pt
        ? { testFrequencyPct: Number(draft.pt.testFrequencyPct), consumableLots: draft.pt.consumableLots }
        : undefined,
    })
  }, [draft])

  if (sessionsLoading) return <Card className="p-10 text-center text-sm text-slate-400">Loading…</Card>
  if (!session || !order || loadError) {
    return (
      <EmptyState
        title="Session not found"
        hint="It may have been deleted."
        action={
          <Button variant="primary" onClick={() => navigate('/')}>
            Back to inspections
          </Button>
        }
      />
    )
  }
  if (!draft) return <Card className="p-10 text-center text-sm text-slate-400">Preparing…</Card>

  const current = (draft.step as WizardStep) ?? 'setup'
  const stepIndex = Math.max(0, steps.indexOf(current))
  const goto = (s: WizardStep) => update({ step: s })
  const next = () => stepIndex < steps.length - 1 && goto(steps[stepIndex + 1])
  const back = () => stepIndex > 0 && goto(steps[stepIndex - 1])

  // Shown for orientation; the API derives the stored shift the same way, in
  // the factory's zone, when the sample is saved (§8.1).
  const now = new Date()
  const shift = deriveShift(now, factoryTimeZone)

  async function performSave(acknowledged?: SampleDraft['gradeAcknowledged']) {
    if (!draft || !session || !order) return
    setSaving(true)
    try {
      const index = priorSamples.length + 1

      // The complete sample, sent as one request and written as one
      // transaction: either everything in it exists afterwards, or nothing.
      const body: SaveSampleRequest = {
        submissionId: draft.submissionId,
        drawing: draft.drawing,
        drawingAlt: draft.drawingAlt || undefined,
        issue: draft.issue || undefined,
        sampleQty: Number(draft.sampleQty),
        dimensions: draft.dimensions
          .filter((d) => d.actual.trim() !== '' || d.nominal.trim() !== '')
          .map((d) => ({
            name: d.name,
            sequence: d.sequence,
            nominal: d.nominal.trim() === '' ? null : Number(d.nominal),
            tolPlus: d.tolPlus.trim() === '' ? null : Number(d.tolPlus),
            tolMinus: d.tolMinus.trim() === '' ? null : Number(d.tolMinus),
            actual: d.actual.trim() === '' ? null : Number(d.actual),
            unit: d.unit,
            source: d.source,
          })),
        defects: draft.defects.map((d) => ({
          defectName: d.defectName,
          qty: Number(d.qty),
          // validateSample has already refused a missing disposition (§8.5).
          disposition: d.disposition as Disposition,
          notes: d.notes || undefined,
          imageIds: d.imageIds,
        })),
        coils: draft.coils.map((c) => ({
          coilNumber: c.coilNumber,
          grade: c.grade || undefined,
          smType: c.smType || undefined,
          supplier: c.supplier || undefined,
          thickness: c.thickness ? Number(c.thickness) : undefined,
          width: c.width ? Number(c.width) : undefined,
          yield: c.yield ? Number(c.yield) : undefined,
          notes: c.notes || undefined,
        })),
        paint: isPaintWorkCenter(draft.workCenterCode) ? { notes: draft.paint.notes || undefined, imageIds: draft.paint.imageIds } : undefined,
        pt:
          isPTWorkCenter(draft.workCenterCode) && draft.pt
            ? {
                testFrequencyPct: Number(draft.pt.testFrequencyPct),
                consumableLots: {
                  Cleaner: draft.pt.consumableLots.Cleaner ?? '',
                  Penetrant: draft.pt.consumableLots.Penetrant ?? '',
                  Developer: draft.pt.consumableLots.Developer ?? '',
                },
                sampleSize: draft.pt.sampleSize || undefined,
                testedWeldLength: draft.pt.testedWeldLength || undefined,
                indicationType: draft.pt.indicationType || undefined,
                indicationSize: draft.pt.indicationSize || undefined,
                weldingWireBatch: draft.pt.weldingWireBatch || undefined,
                acceptOrRepair: draft.pt.acceptOrRepair,
                finalResult: draft.pt.finalResult || undefined,
                notes: draft.pt.notes || undefined,
                imageIds: draft.pt.imageIds,
              }
            : undefined,
        gradeAcknowledgement: acknowledged
          ? {
              coilNumbers: acknowledged.coilNumbers,
              expectedGrade: acknowledged.expectedGrade,
              foundGrades: acknowledged.foundGrades,
              at: acknowledged.at,
            }
          : undefined,
      }

      const result = await saveSample(queryClient, session.id, body)

      clearDraft(session.id)
      setDraft(null)
      toast(
        result.deduped ? 'That sample was already saved — no duplicate was created.' : `Sample #${result.index || index} saved.`,
        'success',
      )
    } catch (e) {
      // One clear error, and everything the inspector typed is still here (§5.7).
      toast(e instanceof Error ? e.message : 'The sample could not be saved. Nothing was written — try again.', 'error')
    } finally {
      setSaving(false)
      setGradePrompt(null)
    }
  }

  function attemptSave() {
    if (!draft || !order) return
    if (issues.length > 0) {
      goto(issues[0].step)
      toast(issues[0].message, 'error')
      return
    }
    // §8.4 — block on a grade mismatch unless it was explicitly acknowledged.
    const mismatches = findGradeMismatches(order.expectedGrade, draft.coils, gradeIndex)
    if (mismatches.length > 0 && !draft.gradeAcknowledged) {
      setGradePrompt({ mismatches })
      return
    }
    void performSave(draft.gradeAcknowledged)
  }

  const StepIcon = STEP_META[current].icon

  return (
    <div className="space-y-4 pb-32">
      <button
        onClick={() => navigate('/')}
        className="inline-flex min-h-[44px] items-center gap-1.5 text-sm font-semibold text-slate-500 hover:text-brand-600 dark:text-slate-400"
      >
        <ArrowLeft className="h-4 w-4" /> Inspections
      </button>

      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-bold">{order.orderNumber}</span>
          <Badge tone="blue">WC {session.workCenterCode}</Badge>
          <Badge tone="neutral">
            Shift {shift} · {shiftName(shift)}
          </Badge>
          <Badge tone="neutral">Sample #{priorSamples.length + 1}</Badge>
          {!online && (
            <Badge tone="amber" icon={<CloudOff className="h-3 w-3" />}>
              Offline — your work is saved on this device
            </Badge>
          )}
        </div>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          {order.item} · {order.itemCode}
        </p>
      </Card>

      {/* Step rail */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {steps.map((s, i) => {
          const Icon = STEP_META[s].icon
          const done = i < stepIndex
          const active = i === stepIndex
          return (
            <button
              key={s}
              onClick={() => goto(s)}
              className={cn(
                'flex min-h-[48px] shrink-0 items-center gap-2 rounded-xl px-3.5 text-sm font-bold transition-colors',
                active
                  ? 'bg-brand-600 text-white shadow-sm'
                  : done
                    ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-400 dark:ring-emerald-500/20'
                    : 'bg-white text-slate-600 ring-1 ring-slate-200 dark:bg-slate-900 dark:text-slate-300 dark:ring-slate-700',
              )}
            >
              {done ? <CheckCircle2 className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
              {STEP_META[s].label}
            </button>
          )
        })}
      </div>

      <Card className="space-y-5 p-4">
        <h2 className="flex items-center gap-2 text-lg font-extrabold">
          <StepIcon className="h-5 w-5 text-brand-600" /> {STEP_META[current].label}
        </h2>

        {current === 'setup' && (
          <SetupStep draft={draft} order={order} update={update} shift={shift} refImages={refImages} />
        )}
        {current === 'dimensions' && <DimensionsStep draft={draft} update={update} />}
        {current === 'defects' && (
          <DefectsStep draft={draft} update={update} options={defectOptions} sessionId={session.id} orderId={order.id} />
        )}
        {current === 'paint' && <PaintStep draft={draft} update={update} sessionId={session.id} orderId={order.id} />}
        {current === 'pt' && (
          <PTStep draft={draft} update={update} consumables={consumables} sessionId={session.id} orderId={order.id} />
        )}
        {current === 'review' && <ReviewStep draft={draft} order={order} issues={issues} />}
      </Card>

      {/* Sticky navigation */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 backdrop-blur-md dark:border-slate-800 dark:bg-slate-900/95 safe-bottom">
        <div className="mx-auto flex max-w-7xl items-center gap-2 px-4 py-3">
          <Button variant="secondary" className="min-h-[52px] flex-1 sm:flex-none" disabled={stepIndex === 0} onClick={back}>
            <ArrowLeft className="h-4 w-4" /> Back
          </Button>
          {current === 'review' ? (
            <Button variant="primary" className="min-h-[52px] flex-1" disabled={saving} onClick={attemptSave}>
              {saving ? <Loader2 className="h-5 w-5 animate-spin" /> : <Save className="h-5 w-5" />}
              {saving ? 'Saving…' : 'Save inspection'}
            </Button>
          ) : (
            <Button variant="primary" className="min-h-[52px] flex-1" onClick={next}>
              Next <ArrowRight className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {gradePrompt && order && (
        <Modal
          open
          onClose={() => setGradePrompt(null)}
          title="Grade mismatch detected"
          icon={<AlertTriangle className="h-5 w-5" />}
          footer={
            <>
              <Button variant="ghost" onClick={() => setGradePrompt(null)}>
                Go back and fix
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  const ack = {
                    coilNumbers: gradePrompt.mismatches.map((m) => m.coilNumber),
                    expectedGrade: order.expectedGrade,
                    foundGrades: gradePrompt.mismatches.map((m) => m.coilGrade),
                    at: new Date().toISOString(),
                  }
                  update({ gradeAcknowledged: ack })
                  void performSave(ack)
                }}
              >
                Acknowledge & continue
              </Button>
            </>
          }
        >
          <div className="space-y-3">
            <p className="text-sm text-slate-600 dark:text-slate-300">
              This order expects grade <strong>{order.expectedGrade}</strong>, but these coils do not match it
              — directly or through any configured equivalence:
            </p>
            <ul className="space-y-1.5">
              {gradePrompt.mismatches.map((m) => (
                <li
                  key={m.coilNumber}
                  className="flex items-center justify-between rounded-xl bg-rose-50 px-3 py-2 text-sm dark:bg-rose-500/10"
                >
                  <span className="font-semibold">Coil {m.coilNumber}</span>
                  <span className="text-rose-600 dark:text-rose-400">{m.coilGrade}</span>
                </li>
              ))}
            </ul>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              If you continue, your name, the time and these coils are recorded with the sample — an audit will
              ask about this decision later.
            </p>
          </div>
        </Modal>
      )}
    </div>
  )
}

// ---- Steps -----------------------------------------------------------------

type Updater = (patch: Partial<SampleDraft> | ((d: SampleDraft) => SampleDraft)) => void

function SetupStep({
  draft,
  order,
  update,
  shift,
  refImages,
}: {
  draft: SampleDraft
  order: ProductionOrder
  update: Updater
  shift: 'A' | 'B' | 'C'
  refImages: ItemReferenceImage[]
}) {
  const itemRefs = refImages.filter((r) => r.item === order.item)
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Drawing">
          <Select value={draft.drawing} onChange={(e) => update({ drawing: e.target.value })} className="min-h-[48px]">
            {[order.drawing, order.drawingAlt].filter(Boolean).map((d) => (
              <option key={d} value={d!}>
                {d}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Issue / revision">
          <Input
            value={draft.issue ?? ''}
            onChange={(e) => update({ issue: e.target.value })}
            className="min-h-[48px]"
            placeholder="Rev C"
          />
        </Field>
        <Field label="Sample quantity">
          <Input
            type="number"
            inputMode="numeric"
            value={draft.sampleQty}
            onChange={(e) => update({ sampleQty: e.target.value })}
            className="min-h-[48px] text-lg"
          />
        </Field>
        <div>
          <span className="label">Shift (derived)</span>
          <div className="flex min-h-[48px] items-center rounded-xl bg-slate-100 px-3.5 font-semibold dark:bg-slate-800">
            {shift} · {shiftName(shift)}
          </div>
        </div>
      </div>

      {itemRefs.length > 0 && (
        <div>
          <span className="label">Reference photos for {order.item}</span>
          <ImagePicker imageIds={itemRefs.map((r) => r.imageId)} onChange={() => {}} readOnly />
        </div>
      )}

      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="label !mb-0">
            Coils{' '}
            {isPTWorkCenter(draft.workCenterCode) && (
              <span className="text-rose-500">· at least one required on this work center</span>
            )}
          </span>
          <Button
            variant="secondary"
            className="min-h-[44px]"
            onClick={() => update((d) => ({ ...d, coils: [...d.coils, { coilNumber: '' }] }))}
          >
            <Plus className="h-4 w-4" /> Add coil
          </Button>
        </div>
        {draft.coils.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-200 py-4 text-center text-sm text-slate-400 dark:border-slate-700">
            No coils added. {isPTWorkCenter(draft.workCenterCode) ? 'Add one to continue.' : 'Optional on this work center.'}
          </p>
        ) : (
          <div className="space-y-3">
            {draft.coils.map((c, i) => (
              <div key={i} className="rounded-2xl border border-slate-200 p-3 dark:border-slate-700">
                <div className="grid gap-2 sm:grid-cols-3">
                  <Field label="Coil ID *">
                    <Input
                      value={c.coilNumber}
                      onChange={(e) =>
                        update((d) => {
                          const coils = [...d.coils]
                          coils[i] = { ...coils[i], coilNumber: e.target.value }
                          return { ...d, coils }
                        })
                      }
                      className="min-h-[48px]"
                    />
                  </Field>
                  <Field label="Grade">
                    <Input
                      value={c.grade ?? ''}
                      onChange={(e) =>
                        update((d) => {
                          const coils = [...d.coils]
                          coils[i] = { ...coils[i], grade: e.target.value }
                          return { ...d, coils }
                        })
                      }
                      className="min-h-[48px]"
                    />
                  </Field>
                  <Field label="Supplier">
                    <Input
                      value={c.supplier ?? ''}
                      onChange={(e) =>
                        update((d) => {
                          const coils = [...d.coils]
                          coils[i] = { ...coils[i], supplier: e.target.value }
                          return { ...d, coils }
                        })
                      }
                      className="min-h-[48px]"
                    />
                  </Field>
                  <Field label="Thickness">
                    <Input
                      type="number"
                      inputMode="decimal"
                      value={c.thickness ?? ''}
                      onChange={(e) =>
                        update((d) => {
                          const coils = [...d.coils]
                          coils[i] = { ...coils[i], thickness: e.target.value }
                          return { ...d, coils }
                        })
                      }
                      className="min-h-[48px]"
                    />
                  </Field>
                  <Field label="Width">
                    <Input
                      type="number"
                      inputMode="decimal"
                      value={c.width ?? ''}
                      onChange={(e) =>
                        update((d) => {
                          const coils = [...d.coils]
                          coils[i] = { ...coils[i], width: e.target.value }
                          return { ...d, coils }
                        })
                      }
                      className="min-h-[48px]"
                    />
                  </Field>
                  <Field label="Yield">
                    <Input
                      type="number"
                      inputMode="decimal"
                      value={c.yield ?? ''}
                      onChange={(e) =>
                        update((d) => {
                          const coils = [...d.coils]
                          coils[i] = { ...coils[i], yield: e.target.value }
                          return { ...d, coils }
                        })
                      }
                      className="min-h-[48px]"
                    />
                  </Field>
                </div>
                <div className="mt-2 flex justify-end">
                  <Button
                    variant="ghost"
                    className="min-h-[44px] text-rose-500"
                    onClick={() => update((d) => ({ ...d, coils: d.coils.filter((_, j) => j !== i) }))}
                  >
                    <Trash2 className="h-4 w-4" /> Remove
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function DimensionsStep({ draft, update }: { draft: SampleDraft; update: Updater }) {
  const setRow = (i: number, patch: Partial<SampleDraft['dimensions'][number]>) =>
    update((d) => {
      const dimensions = [...d.dimensions]
      dimensions[i] = { ...dimensions[i], ...patch }
      return { ...d, dimensions }
    })

  if (draft.dimensions.length === 0) {
    return (
      <div className="space-y-3">
        <EmptyState
          icon={<Ruler className="h-10 w-10" />}
          title="No dimensions configured for this item"
          hint="Add one below, or configure them in Admin so they pre-fill next time."
        />
        <AddDimensionButton update={update} />
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="text-xs uppercase text-slate-400">
            <tr>
              <th className="px-2 py-2 text-left font-semibold">Dimension</th>
              <th className="px-2 py-2 text-right font-semibold">Nominal</th>
              <th className="px-2 py-2 text-center font-semibold">Tol ±</th>
              <th className="px-2 py-2 text-center font-semibold">Actual</th>
              <th className="px-2 py-2 text-center font-semibold">Status</th>
              <th />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {draft.dimensions.map((d, i) => {
              const status = dimensionStatus({
                nominal: Number(d.nominal),
                tolPlus: Number(d.tolPlus),
                tolMinus: Number(d.tolMinus),
                actual: d.actual.trim() === '' ? null : Number(d.actual),
              })
              return (
                <tr
                  key={`${d.name}-${i}`}
                  className={cn(
                    status === 'Fail' && 'bg-rose-50/60 dark:bg-rose-500/5',
                    status === 'Warning' && 'bg-amber-50/60 dark:bg-amber-500/5',
                  )}
                >
                  <td className="px-2 py-2 font-semibold">{d.name}</td>
                  <td className="px-2 py-2 text-right tabular-nums">
                    <input
                      value={d.nominal}
                      onChange={(e) => setRow(i, { nominal: e.target.value })}
                      inputMode="decimal"
                      className="w-20 rounded-lg border border-slate-300 px-2 py-2 text-right dark:border-slate-600 dark:bg-slate-800"
                    />
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 text-center text-xs text-slate-400">
                    +{d.tolPlus}/-{d.tolMinus}
                  </td>
                  <td className="px-2 py-2 text-center">
                    <input
                      value={d.actual}
                      onChange={(e) => setRow(i, { actual: e.target.value })}
                      inputMode="decimal"
                      type="number"
                      step="any"
                      placeholder="—"
                      className={cn(
                        'w-24 rounded-lg border px-2 py-3 text-center text-base tabular-nums focus:outline-none focus:ring-2',
                        status === 'Fail'
                          ? 'border-rose-400 focus:ring-rose-400/40 dark:bg-slate-800'
                          : status === 'Warning'
                            ? 'border-amber-400 focus:ring-amber-400/40 dark:bg-slate-800'
                            : 'border-slate-300 focus:ring-brand-400/40 dark:border-slate-600 dark:bg-slate-800',
                      )}
                    />
                  </td>
                  <td className="px-2 py-2 text-center">
                    <Badge
                      tone={status === 'Pass' ? 'green' : status === 'Fail' ? 'red' : status === 'Warning' ? 'amber' : 'neutral'}
                    >
                      {status}
                    </Badge>
                  </td>
                  <td className="px-1 py-2">
                    <button
                      onClick={() => update((dd) => ({ ...dd, dimensions: dd.dimensions.filter((_, j) => j !== i) }))}
                      className="rounded p-2 text-slate-300 hover:text-rose-500"
                      aria-label={`Remove ${d.name}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <AddDimensionButton update={update} />
    </div>
  )
}

function AddDimensionButton({ update }: { update: Updater }) {
  const [name, setName] = useState('')
  return (
    <div className="flex flex-wrap gap-2">
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Add a dimension not in the configuration…"
        className="min-h-[48px] flex-1"
      />
      <Button
        variant="secondary"
        className="min-h-[48px]"
        disabled={!name.trim()}
        onClick={() => {
          update((d) => ({
            ...d,
            dimensions: [
              ...d.dimensions,
              {
                name: name.trim(),
                sequence: d.dimensions.length + 1,
                nominal: '',
                tolPlus: '0',
                tolMinus: '0',
                actual: '',
                unit: 'mm',
                source: 'manual' as const,
              },
            ],
          }))
          setName('')
        }}
      >
        <Plus className="h-4 w-4" /> Add
      </Button>
    </div>
  )
}

function DefectsStep({
  draft,
  update,
  options,
  sessionId,
  orderId,
}: {
  draft: SampleDraft
  update: Updater
  options: string[]
  sessionId: string
  orderId: string
}) {
  const [search, setSearch] = useState('')
  const filtered = options.filter((o) => o.toLowerCase().includes(search.trim().toLowerCase()))

  const setDefect = (key: string, patch: Partial<DraftDefect>) =>
    update((d) => ({
      ...d,
      defects: d.defects.map((x) => (x.key === key ? { ...x, ...patch } : x)),
    }))

  return (
    <div className="space-y-4">
      <div>
        <span className="label">Add a defect</span>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search this work centre's defects…"
            className="min-h-[48px] pl-9"
          />
        </div>
        {options.length === 0 ? (
          <p className="mt-2 rounded-xl border border-dashed border-slate-200 py-3 text-center text-sm text-slate-400 dark:border-slate-700">
            No defects are configured for work center {draft.workCenterCode} yet.
          </p>
        ) : (
          <div className="mt-2 flex max-h-44 flex-wrap gap-2 overflow-y-auto">
            {filtered.map((name) => (
              <button
                key={name}
                dir="auto"
                onClick={() =>
                  update((d) => ({
                    ...d,
                    defects: [
                      ...d.defects,
                      { key: uid('dk'), defectName: name, qty: '1', disposition: null, imageIds: [] },
                    ],
                  }))
                }
                className="min-h-[44px] rounded-xl bg-slate-100 px-3 text-sm font-semibold hover:bg-brand-100 hover:text-brand-700 dark:bg-slate-800 dark:hover:bg-brand-500/20"
              >
                + {name}
              </button>
            ))}
          </div>
        )}
      </div>

      {draft.defects.length === 0 ? (
        <EmptyState icon={<AlertTriangle className="h-10 w-10" />} title="No defects recorded" hint="Pick one above if you found any." />
      ) : (
        <div className="space-y-3">
          {draft.defects.map((d) => (
            <div
              key={d.key}
              className={cn(
                'rounded-2xl border p-3',
                d.disposition
                  ? 'border-slate-200 dark:border-slate-700'
                  : 'border-rose-300 bg-rose-50/50 dark:border-rose-500/40 dark:bg-rose-500/5',
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <p dir="auto" className="font-bold">
                  {d.defectName}
                </p>
                <button
                  onClick={() => update((dd) => ({ ...dd, defects: dd.defects.filter((x) => x.key !== d.key) }))}
                  className="rounded p-2 text-slate-300 hover:text-rose-500"
                  aria-label="Remove defect"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>

              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <Field label="Quantity">
                  <Input
                    type="number"
                    inputMode="numeric"
                    value={d.qty}
                    onChange={(e) => setDefect(d.key, { qty: e.target.value })}
                    className="min-h-[48px]"
                  />
                </Field>
                <Field label="Disposition *">
                  <Select
                    value={d.disposition ?? ''}
                    onChange={(e) => setDefect(d.key, { disposition: (e.target.value || null) as Disposition | null })}
                    className={cn('min-h-[48px]', !d.disposition && 'border-rose-400')}
                  >
                    <option value="">— choose —</option>
                    {DISPOSITIONS.map((x) => (
                      <option key={x} value={x}>
                        {x}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>

              {!d.disposition && (
                <p className="mt-1 flex items-center gap-1.5 text-sm font-semibold text-rose-600 dark:text-rose-400">
                  <AlertTriangle className="h-4 w-4" /> This defect cannot be saved without a disposition.
                </p>
              )}

              <Field label="Notes">
                <Input
                  dir="auto"
                  value={d.notes ?? ''}
                  onChange={(e) => setDefect(d.key, { notes: e.target.value })}
                  className="min-h-[48px]"
                />
              </Field>

              <div className="mt-2">
                <span className="label">Photos</span>
                <ImagePicker
                  imageIds={d.imageIds}
                  onChange={(ids) => setDefect(d.key, { imageIds: ids })}
                  sessionId={sessionId}
                  orderId={orderId}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function PaintStep({
  draft,
  update,
  sessionId,
  orderId,
}: {
  draft: SampleDraft
  update: Updater
  sessionId: string
  orderId: string
}) {
  return (
    <div className="space-y-4">
      {draft.paint.imageIds.length === 0 && (
        <p className="rounded-xl border border-dashed border-slate-200 px-3 py-4 text-center text-sm text-slate-400 dark:border-slate-700">
          Take or upload photos of the paint sample using the buttons below.
        </p>
      )}
      <div>
        <span className="label">Paint sample photos</span>
        <ImagePicker
          imageIds={draft.paint.imageIds}
          onChange={(ids) => update((d) => ({ ...d, paint: { ...d.paint, imageIds: ids } }))}
          sessionId={sessionId}
          orderId={orderId}
        />
      </div>
      <Field label="Notes">
        <textarea
          dir="auto"
          className="input min-h-[96px]"
          value={draft.paint.notes ?? ''}
          onChange={(e) => update((d) => ({ ...d, paint: { ...d.paint, notes: e.target.value } }))}
        />
      </Field>
    </div>
  )
}

function PTStep({
  draft,
  update,
  consumables,
  sessionId,
  orderId,
}: {
  draft: SampleDraft
  update: Updater
  consumables: PTConsumableProduct[]
  sessionId: string
  orderId: string
}) {
  const pt = draft.pt ?? { testFrequencyPct: '', consumableLots: {}, imageIds: [] }
  const setPT = (patch: Partial<typeof pt>) => update((d) => ({ ...d, pt: { ...pt, ...patch } }))
  const freq = Number(pt.testFrequencyPct)
  const freqBad = pt.testFrequencyPct.trim() !== '' && !(freq > 5)

  return (
    <div className="space-y-4">
      <Field label="Test frequency % (must be greater than 5)">
        <Input
          type="number"
          inputMode="decimal"
          step="any"
          value={pt.testFrequencyPct}
          onChange={(e) => setPT({ testFrequencyPct: e.target.value })}
          className={cn('min-h-[48px] text-lg', freqBad && 'border-rose-400')}
        />
        {freqBad && (
          <span className="mt-1 flex items-center gap-1.5 text-sm font-semibold text-rose-600 dark:text-rose-400">
            <AlertTriangle className="h-4 w-4" /> Must be greater than 5%.
          </span>
        )}
      </Field>

      <div>
        <span className="label">Consumables used — lot / batch is mandatory</span>
        <div className="grid gap-2 sm:grid-cols-3">
          {CONSUMABLE_KINDS.map((kind) => {
            const opts = consumables.filter((c) => c.kind === kind)
            const value = pt.consumableLots[kind] ?? ''
            return (
              <Field key={kind} label={kind}>
                <Select
                  value={value}
                  onChange={(e) => setPT({ consumableLots: { ...pt.consumableLots, [kind]: e.target.value } })}
                  className={cn('min-h-[48px]', !value && 'border-rose-400')}
                >
                  <option value="">— choose lot —</option>
                  {opts.map((o) => (
                    <option key={o.id} value={o.lotBatch}>
                      {o.productName} · {o.lotBatch}
                    </option>
                  ))}
                </Select>
              </Field>
            )
          })}
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Sample size">
          <Input value={pt.sampleSize ?? ''} onChange={(e) => setPT({ sampleSize: e.target.value })} className="min-h-[48px]" />
        </Field>
        <Field label="Tested weld length">
          <Input value={pt.testedWeldLength ?? ''} onChange={(e) => setPT({ testedWeldLength: e.target.value })} className="min-h-[48px]" />
        </Field>
        <Field label="Type of indication">
          <Input value={pt.indicationType ?? ''} onChange={(e) => setPT({ indicationType: e.target.value })} className="min-h-[48px]" />
        </Field>
        <Field label="Size">
          <Input value={pt.indicationSize ?? ''} onChange={(e) => setPT({ indicationSize: e.target.value })} className="min-h-[48px]" />
        </Field>
        <Field label="Welding wire batch number">
          <Input value={pt.weldingWireBatch ?? ''} onChange={(e) => setPT({ weldingWireBatch: e.target.value })} className="min-h-[48px]" />
        </Field>
        <Field label="Accept / Reject-Repair">
          <Select
            value={pt.acceptOrRepair ?? ''}
            onChange={(e) => setPT({ acceptOrRepair: (e.target.value || undefined) as 'Accept' | 'Reject / Repair' | undefined })}
            className="min-h-[48px]"
          >
            <option value="">—</option>
            <option value="Accept">Accept</option>
            <option value="Reject / Repair">Reject / Repair</option>
          </Select>
        </Field>
        <Field label="Final result">
          <Input value={pt.finalResult ?? ''} onChange={(e) => setPT({ finalResult: e.target.value })} className="min-h-[48px]" />
        </Field>
      </div>

      <Field label="Notes">
        <textarea dir="auto" className="input min-h-[80px]" value={pt.notes ?? ''} onChange={(e) => setPT({ notes: e.target.value })} />
      </Field>

      <div>
        <span className="label">Attachments</span>
        <ImagePicker imageIds={pt.imageIds} onChange={(ids) => setPT({ imageIds: ids })} sessionId={sessionId} orderId={orderId} />
      </div>
    </div>
  )
}

function ReviewStep({
  draft,
  order,
  issues,
}: {
  draft: SampleDraft
  order: ProductionOrder
  issues: { step: WizardStep; message: string }[]
}) {
  const measured = draft.dimensions.filter((d) => d.actual.trim() !== '')
  return (
    <div className="space-y-4">
      {issues.length > 0 && (
        <div className="rounded-2xl border border-rose-300 bg-rose-50 p-4 dark:border-rose-500/40 dark:bg-rose-500/10">
          <p className="flex items-center gap-2 font-bold text-rose-700 dark:text-rose-400">
            <AlertTriangle className="h-5 w-5" /> Fix these before saving
          </p>
          <ul className="mt-2 space-y-1 text-sm text-rose-700 dark:text-rose-300">
            {issues.map((i, n) => (
              <li key={n}>• {i.message}</li>
            ))}
          </ul>
        </div>
      )}

      <Section title="Order">
        <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          <Row label="Order" value={order.orderNumber} />
          <Row label="Item" value={order.item} />
          <Row label="Drawing" value={draft.drawing} />
          <Row label="Sample qty" value={draft.sampleQty} />
        </dl>
      </Section>

      <Section title={`Coils (${draft.coils.length})`}>
        {draft.coils.length === 0 ? (
          <Empty>No coils recorded.</Empty>
        ) : (
          <ul className="space-y-1 text-sm">
            {draft.coils.map((c, i) => (
              <li key={i} className="flex justify-between rounded-lg bg-slate-50 px-3 py-2 dark:bg-slate-800/50">
                <span className="font-semibold">{c.coilNumber || '(no id)'}</span>
                <span className="text-slate-500">{c.grade || '—'}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={`Dimensions (${measured.length} measured)`}>
        {measured.length === 0 ? (
          <Empty>No measurements entered.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] text-sm">
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {measured.map((d, i) => {
                  const status = dimensionStatus({
                    nominal: Number(d.nominal),
                    tolPlus: Number(d.tolPlus),
                    tolMinus: Number(d.tolMinus),
                    actual: Number(d.actual),
                  })
                  return (
                    <tr key={i}>
                      <td className="py-2 font-semibold">{d.name}</td>
                      <td className="py-2 text-right tabular-nums text-slate-500">
                        {d.nominal} +{d.tolPlus}/-{d.tolMinus}
                      </td>
                      <td className="py-2 text-right font-bold tabular-nums">{d.actual}</td>
                      <td className="py-2 pl-3 text-right">
                        <Badge tone={status === 'Pass' ? 'green' : status === 'Fail' ? 'red' : 'amber'}>{status}</Badge>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title={`Defects (${draft.defects.length})`}>
        {draft.defects.length === 0 ? (
          <Empty>No defects recorded.</Empty>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {draft.defects.map((d) => (
              <li key={d.key} className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2 dark:bg-slate-800/50">
                <span dir="auto" className="font-semibold">
                  {d.defectName}
                </span>
                <span className="flex items-center gap-2">
                  <Badge tone="neutral">Qty {d.qty}</Badge>
                  {d.disposition ? (
                    <Badge tone={d.disposition === 'Rejected' ? 'red' : d.disposition === 'Hold' ? 'amber' : 'green'}>
                      {d.disposition}
                    </Badge>
                  ) : (
                    <Badge tone="red">No disposition</Badge>
                  )}
                  {d.imageIds.length > 0 && <Badge tone="blue">{d.imageIds.length} photo</Badge>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {isPaintWorkCenter(draft.workCenterCode) && (
        <Section title="Paint sample">
          {draft.paint.imageIds.length === 0 ? <Empty>No paint photos.</Empty> : <p className="text-sm">{draft.paint.imageIds.length} photo(s)</p>}
        </Section>
      )}

      {isPTWorkCenter(draft.workCenterCode) && draft.pt && (
        <Section title="PT / weld">
          <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            <Row label="Frequency" value={`${draft.pt.testFrequencyPct}%`} />
            <Row label="Cleaner lot" value={draft.pt.consumableLots.Cleaner ?? '—'} />
            <Row label="Penetrant lot" value={draft.pt.consumableLots.Penetrant ?? '—'} />
            <Row label="Developer lot" value={draft.pt.consumableLots.Developer ?? '—'} />
            <Row label="Result" value={draft.pt.finalResult || '—'} />
          </dl>
        </Section>
      )}

      <p className="flex items-start gap-2 rounded-xl bg-slate-50 px-3 py-3 text-sm text-slate-500 dark:bg-slate-800/50 dark:text-slate-400">
        <Layers className="mt-0.5 h-4 w-4 shrink-0" />
        Saving writes the sample, its measurements, defects, coils and attachments as one unit. If anything
        fails, nothing is written and your entries stay on this screen.
      </p>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">{title}</h3>
      {children}
    </div>
  )
}
function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase text-slate-400">{label}</dt>
      <dd className="truncate font-semibold">{value}</dd>
    </div>
  )
}
function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-slate-200 py-3 text-center text-sm text-slate-400 dark:border-slate-700">
      {children}
    </p>
  )
}
