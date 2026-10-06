import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
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
  Gauge,
  Cable,
  MessageSquareText,
} from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Select } from '@/components/ui'
import { ImagePicker } from '@/components/inspection/ImagePicker'
import { CoilPicker } from '@/components/inspection/CoilPicker'
import { WorkInstructionLinks } from '@/components/documents/WorkInstructionLinks'
import { useSampleDetail, useWizardContext, useWizardPreview } from '@/services/queries'
import { discardSession, matchNotices, reRecordSample, saveSample, startSessionWithSample } from '@/services/mutations'
import { NoticeGate } from '@/components/notices/NoticeGate'
import type { NoticeForUser } from '@qc/shared/types'
import { loadDraft, saveDraft, clearDraft, type SampleDraft, type DraftDefect, type DraftCoil, type DraftPT, type DraftDimension, type DraftNote, draftIsUntouched } from '@/services/draftStore'
import { OrderNoteList } from '@/components/inspection/OrderNotes'
import { useApp } from '@/store/AppContext'
import { useAuth } from '@/store/AuthContext'
import { cn, uid, newSubmissionId } from '@/lib/utils'
import {
  DISPOSITIONS,
  type Disposition,
  type PTConsumableKind,
  type PTVerdict,
  type Process,
  type Coil,
  type ProductionOrder,
  type PTConsumableProduct,
  type ItemReferenceImage,
  type SessionNote,
  type WorkInstruction,
} from '@qc/shared/types'
import type { SampleDetail, SaveSampleRequest, StartSessionRequest } from '@qc/shared/api'
import {
  stepsForProcess,
  deriveShift,
  shiftName,
  dimensionStatus,
  resolveDimensions,
  validateSample,
  buildGradeIndex,
  findGradeMismatches,
  gradesEquivalent,
  isPaintThicknessName,
  isOtherDefect,
  isStockOrder,
  OTHER_DEFECT_NAME,
  ptOverallVerdict,
  PAINT_THICKNESS_NAME,
  PAINT_THICKNESS_READINGS,
  PAINT_THICKNESS_UNIT,
  PT_MIN_TEST_FREQUENCY_PCT,
  takesConfiguredDimensions,
  type WizardStep,
} from '@qc/shared/rules'

const STEP_META: Record<WizardStep, { label: string; icon: typeof Ruler }> = {
  setup: { label: 'Setup', icon: ClipboardList },
  dimensions: { label: 'Dimensions', icon: Ruler },
  defects: { label: 'Defects', icon: AlertTriangle },
  paint: { label: 'Paint sample', icon: Camera },
  paintThickness: { label: 'Paint thickness', icon: Gauge },
  pt: { label: 'PT / Weld', icon: FlaskConical },
  review: { label: 'Review & Save', icon: Check },
}

const CONSUMABLE_KINDS: PTConsumableKind[] = ['Cleaner', 'Penetrant', 'Developer']

export function WizardPage() {
  const { sessionId = '', sampleId: editingSampleId } = useParams()
  const [search] = useSearchParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { toast } = useApp()
  const { factoryTimeZone } = useAuth()

  // §4.4 — "/wizard/new" is a session that does not exist yet: the line and
  // the starting quantity ride in the address, and the session is opened by
  // the API together with the first sample.
  const pending = useMemo<StartSessionRequest | null>(() => {
    if (sessionId !== 'new') return null
    const orderId = search.get('orderId')
    if (orderId) return { orderId, startQty: Number(search.get('startQty') ?? 0) || 0 }
    const workCenterCode = search.get('workCenterCode')
    if (workCenterCode) return { workCenterCode, producedQty: Number(search.get('producedQty') ?? 0) || 0 }
    return null
  }, [sessionId, search])

  // The wizard needs exactly one session and one order, plus the configuration
  // for that line's item and machine. The API answers all of it in one
  // round trip; nothing here reads a whole table.
  const existing = useWizardContext(pending ? '' : sessionId)
  const preview = useWizardPreview(pending)
  const { data: ctx, isLoading: sessionsLoading, isFetching: ctxFetching, error: loadError } = pending ? preview : existing
  // Re-recording from History: the existing sample is the draft's starting point.
  const { data: editing, isLoading: editingLoading } = useSampleDetail(editingSampleId ?? null)
  const session = ctx?.session ?? null
  const order = ctx?.order
  const machine = ctx?.machine ?? null
  const wc = session?.workCenterCode ?? order?.workCenterCode ?? ''
  /** Where the draft lives on this device: the session's id, or the line's until the session exists. */
  const draftKey = session ? session.id : pending ? ('orderId' in pending ? `new:${pending.orderId}` : `new:stock:${pending.workCenterCode}`) : ''

  const dimOrder = useMemo(() => ctx?.dimensionOrder ?? [], [ctx])
  const refImages = useMemo(() => ctx?.referenceImages ?? [], [ctx])
  const wcDefects = useMemo(() => ctx?.workCenterDefects ?? [], [ctx])
  const gradeMappings = useMemo(() => ctx?.gradeMappings ?? [], [ctx])
  const consumables = useMemo(() => ctx?.ptConsumables ?? [], [ctx])
  const priorSamples = useMemo(() => ctx?.samples ?? [], [ctx])
  const previousDims = useMemo(() => ctx?.previousDimensions ?? [], [ctx])
  const instructions = useMemo(() => ctx?.workInstructions ?? [], [ctx])
  // The machine's process decides the steps: the API resolved it from the register.
  const process: Process = ctx?.process ?? 'forming'
  const previousWire = ctx?.previousWeldingWireBatch ?? null
  const previousSetup = ctx?.previousSetup ?? null
  const orderNotes = useMemo(() => ctx?.orderNotes ?? [], [ctx])
  const steps = useMemo(() => stepsForProcess(process), [process])

  const [draft, setDraft] = useState<SampleDraft | null>(null)
  const [saving, setSaving] = useState(false)
  /** Leaving a session that has no sample yet: keep it, or discard it. */
  const [leaving, setLeaving] = useState(false)
  const [gradePrompt, setGradePrompt] = useState<null | { mismatches: { coilNumber: string; coilGrade: string }[] }>(null)
  const [online, setOnline] = useState(navigator.onLine)
  /** Notices to read on opening this session (§16); asked once per session id. */
  const [gate, setGate] = useState<NoticeForUser[] | null>(null)
  const gatedFor = useRef<string | null>(null)

  useEffect(() => {
    if (!session || editingSampleId || gatedFor.current === sessionId) return
    gatedFor.current = sessionId
    matchNotices({ sessionId })
      .then((notices) => {
        if (notices.length > 0) setGate(notices)
      })
      .catch(() => undefined)
  }, [session, sessionId, editingSampleId])

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
    if ((!session && !pending) || !order || draft || !draftKey) return
    if (editingSampleId && !editing) return
    // A cached context may predate the last save; wait for the fresh one so
    // the nominals and setup the previous sample recorded are carried.
    if (ctxFetching) return
    // A draft the inspector has recorded something in is resumed; one they
    // only opened is rebuilt, so the nominals and setup the server knows now
    // are what they start from.
    const stored = loadDraft(draftKey, editingSampleId)
    if (stored && !draftIsUntouched(stored) && (!editing || stored.editingVersion === editing.sample.version)) {
      setDraft(stored)
      return
    }
    if (editing && session) {
      setDraft(draftFromSample(editing, session.id, session.workCenterCode, process))
      return
    }
    // The item's dimensions on THIS machine: machine-specific rows override
    // the general ones (§8.3), and a row with no configured nominal takes the
    // one typed on the previous sample, so it is entered once.
    const rows = resolveDimensions({
      itemCode: order.itemCode,
      workCenterCode: wc,
      order: dimOrder,
      previous: previousDims,
    })
    const toDraftRow = (r: (typeof rows)[number], sequence = r.sequence): DraftDimension => ({
      name: r.name,
      sequence,
      nominal: r.nominal === null ? '' : String(r.nominal),
      tolPlus: String(r.tolPlus),
      tolMinus: String(r.tolMinus),
      actual: '',
      unit: r.unit,
      source: r.source,
    })
    // A paint sample is three thickness readings, recorded as measured: no
    // required value, no tolerance, no judgement.
    const dimensions: DraftDimension[] =
      process === 'paint'
        ? Array.from({ length: PAINT_THICKNESS_READINGS }, (_, i) => ({
            name: PAINT_THICKNESS_NAME,
            sequence: i + 1,
            nominal: '',
            tolPlus: '',
            tolMinus: '',
            actual: '',
            unit: PAINT_THICKNESS_UNIT,
            source: 'manual' as const,
          }))
        : rows.map((r) => toDraftRow(r))
    // Setup — drawing, issue, coils — is entered once per session: the next
    // sample starts from the previous one's and opens past the Setup step.
    const steps = stepsForProcess(process)
    const carried = previousSetup && steps[0] === 'setup' ? previousSetup : null
    const str = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(v))
    setDraft({
      sessionId: draftKey,
      orderId: order.id,
      workCenterCode: wc,
      process,
      submissionId: newSubmissionId(),
      step: carried ? steps[1] : steps[0],
      drawing: carried ? carried.drawing : process === 'paint' ? '' : (order.drawing ?? ''),
      drawingAlt: carried ? (carried.drawingAlt ?? undefined) : order.drawingAlt,
      issue: carried ? (carried.issue ?? undefined) : order.issue,
      sampleQty: '',
      coils: (carried?.coils ?? []).map((c) => ({
        coilId: c.coilId ?? undefined,
        coilNumber: c.coilNumber,
        grade: c.grade ?? '',
        smType: c.smType ?? '',
        supplier: c.supplier ?? '',
        thickness: str(c.thickness),
        width: str(c.width),
        yield: str(c.yield),
        notes: c.notes ?? '',
      })),
      gradeAcknowledged: carried?.gradeAcknowledgement
        ? { ...carried.gradeAcknowledgement, at: new Date().toISOString() }
        : undefined,
      dimensions,
      defects: [],
      paint: { imageIds: [] },
      note: { text: '', imageIds: [] },
      pt:
        process === 'welding'
          ? { consumableLots: {}, weldingWireBatch: previousWire ?? '', testedLengths: [], imageIds: [] }
          : undefined,
      updatedAt: new Date().toISOString(),
    })
  }, [session, pending, draftKey, wc, order, draft, dimOrder, previousDims, process, previousWire, previousSetup, editing, editingSampleId, ctxFetching])

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
      process: draft.process,
      // A stock item has no order drawing to pick.
      drawingRequired: !isStockOrder(order),
      sampleQty: Number(draft.sampleQty),
      drawing: draft.drawing,
      coils: draft.coils.map((c) => ({ coilNumber: c.coilNumber, grade: c.grade })),
      defects: draft.defects.map((d) => ({
        defectName: d.defectName,
        disposition: d.disposition,
        qty: Number(d.qty),
        notes: d.notes,
      })),
      dimensions: draft.dimensions.map((d) => ({
        name: d.name,
        nominal: d.nominal.trim() === '' ? null : Number(d.nominal),
        actual: d.actual.trim() === '' ? null : Number(d.actual),
      })),
      paint: { imageIds: draft.paint.imageIds },
      pt: draft.pt
        ? {
            consumableLots: draft.pt.consumableLots,
            testedLengths: draft.pt.testedLengths.map((l) => ({ lengthMm: Number(l.lengthMm), verdict: l.verdict ?? null })),
          }
        : undefined,
    })
  }, [draft])

  if (sessionsLoading || (editingSampleId && editingLoading)) return <Card className="p-10 text-center text-sm text-muted">Loading…</Card>
  if (!order || (!session && !pending) || loadError) {
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
  if (!draft) return <Card className="p-10 text-center text-sm text-muted">Preparing…</Card>

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
    if (!draft || !order || (!session && !pending)) return
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
          coilId: c.coilId || undefined,
          coilNumber: c.coilNumber,
          grade: c.grade || undefined,
          smType: c.smType || undefined,
          supplier: c.supplier || undefined,
          thickness: c.thickness ? Number(c.thickness) : undefined,
          width: c.width ? Number(c.width) : undefined,
          yield: c.yield ? Number(c.yield) : undefined,
          notes: c.notes || undefined,
        })),
        paint: draft.process === 'paint' ? { notes: draft.paint.notes || undefined, imageIds: draft.paint.imageIds } : undefined,
        pt:
          draft.process === 'welding' && draft.pt
            ? {
                consumableLots: {
                  Cleaner: draft.pt.consumableLots.Cleaner ?? '',
                  Penetrant: draft.pt.consumableLots.Penetrant ?? '',
                  Developer: draft.pt.consumableLots.Developer ?? '',
                },
                weldingWireBatch: draft.pt.weldingWireBatch?.trim() || undefined,
                // validateSample has already refused a missing verdict or length.
                testedLengths: draft.pt.testedLengths.map((l) => ({ lengthMm: Number(l.lengthMm), verdict: l.verdict as PTVerdict })),
                notes: draft.pt.notes || undefined,
                imageIds: draft.pt.imageIds,
              }
            : undefined,
        // A remark about the order goes with the sample only when it says something.
        note:
          draft.note && (draft.note.text.trim() !== '' || draft.note.imageIds.length > 0)
            ? { text: draft.note.text.trim() || undefined, imageIds: draft.note.imageIds }
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

      if (pending && !session) {
        // §4.4 — the first sample opens the session (or joins the one already
        // open on this line), in one transaction with the sample itself.
        const res = await startSessionWithSample(queryClient, { start: pending, sample: body })
        clearDraft(draftKey)
        setDraft(null)
        toast(
          res.sample.deduped
            ? 'That sample was already saved — no duplicate was created.'
            : res.joined
              ? `Sample ${res.session.seq}-${res.sample.index} added to the open session on this line.`
              : `Session ${res.session.seq} opened · sample ${res.session.seq}-${res.sample.index} saved.`,
          'success',
        )
        navigate('/')
        return
      }
      if (!session) return

      if (draft.editingSampleId) {
        // Re-recording: the whole sample is replaced as one unit; History shows the result.
        const { submissionId: _drop, ...rest } = body
        const result = await reRecordSample(queryClient, session.id, draft.editingSampleId, { ...rest, version: draft.editingVersion ?? 0 })
        clearDraft(session.id, draft.editingSampleId)
        setDraft(null)
        toast(`Sample ${session.seq}-${result.index} re-recorded.`, 'success')
        navigate('/history')
        return
      }

      const result = await saveSample(queryClient, session.id, body)

      // The sample is on record: leave the wizard. The session stays open on
      // the board, and "Continue" starts the next sample from a fresh draft.
      clearDraft(session.id)
      setDraft(null)
      toast(
        result.deduped ? 'That sample was already saved — no duplicate was created.' : `Sample ${session.seq}-${result.index || index} saved.`,
        'success',
      )
      navigate('/')
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
    // Forms read best at a bounded width, so the wizard is centred even on a
    // wide screen while list pages use the whole of it.
    <div className="mx-auto max-w-5xl space-y-4 pb-32">
      {gate && (
        <NoticeGate
          notices={gate}
          context={{ sessionId, workCenterCode: wc, orderNumber: order.orderNumber, itemCode: order.itemCode }}
          onDone={() => setGate(null)}
          onCancel={() => {
            setGate(null)
            navigate('/')
          }}
        />
      )}
      <button
        onClick={() => {
          if (draft.editingSampleId) navigate('/history')
          else if (priorSamples.length === 0) setLeaving(true)
          else navigate('/')
        }}
        className="inline-flex min-h-[44px] items-center gap-1.5 text-sm font-semibold text-muted hover:text-brand-600"
      >
        <ArrowLeft className="h-4 w-4" /> {draft.editingSampleId ? 'History' : 'Inspections'}
      </button>

      <Modal
        open={leaving}
        onClose={() => setLeaving(false)}
        title="No sample recorded yet"
        icon={<AlertTriangle className="h-5 w-5" />}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setLeaving(false)}>
              Stay
            </Button>
            <Button
              onClick={() => {
                setLeaving(false)
                navigate('/')
              }}
            >
              {session ? 'Leave, keep the session' : 'Leave, keep the entries'}
            </Button>
            <Button
              variant="danger"
              disabled={saving}
              onClick={async () => {
                if (!session) {
                  // Nothing exists on the server yet: only the entries on this device go.
                  clearDraft(draftKey)
                  toast('Entries discarded. No session was opened.', 'success')
                  navigate('/')
                  return
                }
                setSaving(true)
                try {
                  await discardSession(queryClient, session.id)
                  clearDraft(session.id)
                  toast('Session discarded. Nothing was recorded in it.', 'success')
                  navigate('/')
                } catch (e) {
                  toast(e instanceof Error ? e.message : 'Could not discard the session.', 'error')
                } finally {
                  setSaving(false)
                }
              }}
            >
              {session ? 'Discard session' : 'Discard entries'}
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-600 dark:text-slate-300">
          {session
            ? 'This session has no sample yet. Your entries so far stay on this device if you keep it; a session that never records a sample cannot be closed, only discarded.'
            : 'No session exists yet: it is opened when the first sample is saved. Your entries so far stay on this device if you leave, and come back when you start this line again.'}
        </p>
      </Modal>

      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          {isStockOrder(order) ? <Badge tone="violet">For stock</Badge> : <span className="font-bold">{order.orderNumber}</span>}
          <Badge tone="blue">{machine?.displayName ?? `Machine ${wc}`}</Badge>
          <Badge tone="neutral">
            Shift {shift} · {shiftName(shift)}
          </Badge>
          {draft.editingSampleId && editing && session ? (
            <Badge tone="amber">Re-recording sample {session.seq}-{editing.sample.index}</Badge>
          ) : session ? (
            <Badge tone="neutral">Sample {session.seq}-{priorSamples.length + 1}</Badge>
          ) : (
            <Badge tone="violet">New session · opens with this sample</Badge>
          )}
          {!online && (
            <Badge tone="amber" icon={<CloudOff className="h-3 w-3" />}>
              Offline — your work is saved on this device
            </Badge>
          )}
        </div>
        <p className="mt-1 text-sm text-muted">
          {order.itemCode}
          {order.item ? ` · ${order.item}` : ''} · Order ID {order.lineKey}
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
          <SetupStep draft={draft} order={order} update={update} shift={shift} gradeIndex={gradeIndex} instructions={instructions} />
        )}
        {current !== 'setup' && current !== 'review' && steps.includes('setup') && (
          <SetupSummary draft={draft} onEdit={() => update({ step: 'setup' })} />
        )}
        {current === 'dimensions' && (
          <>
            <WorkInstructionLinks instructions={instructions} step="dimensions" />
            <DimensionsStep draft={draft} update={update} order={order} refImages={refImages} typedByInspector={!takesConfiguredDimensions(process, machine)} />
          </>
        )}
        {current === 'defects' && (
          <>
            <WorkInstructionLinks instructions={instructions} step="defects" />
            <DefectsStep draft={draft} update={update} options={defectOptions} sessionId={session?.id} orderId={order.id} />
          </>
        )}
        {current === 'paint' && (
          <>
            <WorkInstructionLinks instructions={instructions} step="paint" />
            <PaintStep draft={draft} update={update} sessionId={session?.id} orderId={order.id} />
          </>
        )}
        {current === 'paintThickness' && (
          <>
            <WorkInstructionLinks instructions={instructions} step="paintThickness" />
            <PaintThicknessStep draft={draft} update={update} />
          </>
        )}
        {current === 'pt' && (
          <>
            <WorkInstructionLinks instructions={instructions} step="pt" />
            <PTStep draft={draft} update={update} consumables={consumables} sessionId={session?.id} orderId={order.id} />
          </>
        )}
        {current === 'review' && (
          <ReviewStep draft={draft} order={order} issues={issues} update={update} orderNotes={orderNotes} sessionId={session?.id} orderId={order.id} />
        )}
      </Card>

      {/* Sticky navigation */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 backdrop-blur-md dark:border-slate-800 dark:bg-slate-900/95 safe-bottom">
        <div className="mx-auto flex max-w-5xl items-center gap-2 px-4 py-3">
          <Button variant="secondary" className="min-h-[52px] flex-1 sm:flex-none" disabled={stepIndex === 0} onClick={back}>
            <ArrowLeft className="h-4 w-4" /> Back
          </Button>
          {current === 'review' ? (
            <Button variant="primary" className="min-h-[52px] flex-1" disabled={saving} onClick={attemptSave}>
              {saving ? <Loader2 className="h-5 w-5 animate-spin" /> : <Save className="h-5 w-5" />}
              {saving ? (
                'Saving…'
              ) : (
                <>
                  <span className="sm:hidden">Save</span>
                  <span className="hidden sm:inline">Save inspection</span>
                </>
              )}
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
            <p className="text-sm text-muted">
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
  gradeIndex,
  instructions,
}: {
  draft: SampleDraft
  order: ProductionOrder
  update: Updater
  shift: 'A' | 'B' | 'C'
  gradeIndex: Map<string, string>
  instructions: WorkInstruction[]
}) {
  const { toast } = useApp()
  const [picking, setPicking] = useState(false)
  /** The coil a tap in the picker pointed at, lit for a moment so the eye finds it on the list. */
  const [litCoil, setLitCoil] = useState<string | null>(null)
  const litTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (litTimer.current) clearTimeout(litTimer.current) }, [])
  const pointAtCoil = (coilNumber: string) => {
    setLitCoil(coilNumber.trim().toLowerCase())
    toast(`${coilNumber} is already on this sample.`, 'info')
    if (litTimer.current) clearTimeout(litTimer.current)
    litTimer.current = setTimeout(() => setLitCoil(null), 2500)
  }
  // A welding machine records the wire, not the coil (§5.2).
  const welding = draft.process === 'welding'

  const setCoil = (i: number, patch: Partial<DraftCoil>) =>
    update((d) => {
      const coils = [...d.coils]
      coils[i] = { ...coils[i], ...patch }
      return { ...d, coils }
    })

  /** A register coil is copied onto the sample as a snapshot (§5.2). */
  function addFromRegister(c: Coil) {
    update((d) => ({
      ...d,
      coils: [
        ...d.coils,
        {
          coilId: c.id,
          coilNumber: c.coilNumber,
          grade: c.grade ?? '',
          smType: c.smType ?? '',
          supplier: c.supplier ?? '',
          thickness: c.thickness === undefined ? '' : String(c.thickness),
          width: c.width === undefined ? '' : String(c.width),
          yield: c.yield === undefined ? '' : String(c.yield),
        },
      ],
    }))
  }

  return (
    <div className="space-y-4">
      <WorkInstructionLinks instructions={instructions} step="setup" />
      <div className="grid gap-3 sm:grid-cols-2">
        {isStockOrder(order) ? (
          <Field label="Drawing" hint="Optional on a stock item.">
            <Input value={draft.drawing} onChange={(e) => update({ drawing: e.target.value })} className="min-h-[48px]" placeholder="—" />
          </Field>
        ) : (
          <Field label="Drawing">
            <Select value={draft.drawing} onChange={(e) => update({ drawing: e.target.value })} className="min-h-[48px]">
              {[order.drawing, order.drawingAlt].filter(Boolean).map((d) => (
                <option key={d} value={d!}>
                  {d}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Issue / revision">
          <Input
            value={draft.issue ?? ''}
            onChange={(e) => update({ issue: e.target.value })}
            className="min-h-[48px]"
            placeholder="Rev C"
          />
        </Field>
        <div>
          <span className="label">Shift (derived)</span>
          <div className="flex min-h-[48px] items-center rounded-xl bg-slate-100 px-3.5 font-semibold dark:bg-slate-800">
            {shift} · {shiftName(shift)}
          </div>
        </div>
        <div>
          <span className="label">Expected grade</span>
          <div className="flex min-h-[48px] items-center rounded-xl bg-slate-100 px-3.5 font-semibold dark:bg-slate-800">
            {order.expectedGrade || '—'}
          </div>
        </div>
      </div>

      {welding && (
        <div className="rounded-2xl border border-slate-200 p-3 dark:border-slate-700">
          <Field label="Welding wire batch number" hint="Remembered from the previous sample of this session; change it when a new spool goes on.">
            <div className="relative">
              <Cable className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
              <Input
                value={draft.pt?.weldingWireBatch ?? ''}
                onChange={(e) => update((d) => ({ ...d, pt: { ...(d.pt ?? emptyPT()), weldingWireBatch: e.target.value } }))}
                className="min-h-[48px] pl-9"
                placeholder="e.g. WW-24-0388"
                autoCapitalize="characters"
              />
            </div>
          </Field>
        </div>
      )}

      {!welding && (
      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="label !mb-0">Coils</span>
          <Button variant="secondary" className="min-h-[44px]" onClick={() => setPicking(true)}>
            <Plus className="h-4 w-4" /> Add coil
          </Button>
        </div>
        {draft.coils.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-200 py-4 text-center text-sm text-muted dark:border-slate-700">
            No coils added. Optional on this machine.
          </p>
        ) : (
          <div className="space-y-3">
            {draft.coils.map((c, i) => {
              const fromRegister = !!c.coilId
              const mismatch =
                !!order.expectedGrade && !!c.grade?.trim() && !gradesEquivalent(order.expectedGrade, c.grade, gradeIndex)
              return (
                <div
                  key={`${c.coilId ?? 'typed'}-${c.coilNumber}-${i}`}
                  className={cn(
                    'rounded-2xl border p-3 transition-shadow',
                    mismatch ? 'border-amber-300 bg-amber-50/50 dark:border-amber-500/40 dark:bg-amber-500/5' : 'border-slate-200 dark:border-slate-700',
                    litCoil === c.coilNumber.trim().toLowerCase() && 'ring-2 ring-brand-500 ring-offset-2 dark:ring-offset-slate-900',
                  )}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-base font-bold">{c.coilNumber}</p>
                      {fromRegister ? <Badge tone="green">From register</Badge> : <Badge tone="amber">Typed by hand</Badge>}
                      {c.grade ? <Badge tone={mismatch ? 'red' : 'neutral'}>{c.grade}</Badge> : null}
                    </div>
                    <Button
                      variant="ghost"
                      className="min-h-[44px] text-rose-500"
                      onClick={() => update((d) => ({ ...d, coils: d.coils.filter((_, j) => j !== i) }))}
                    >
                      <Trash2 className="h-4 w-4" /> Remove
                    </Button>
                  </div>

                  {mismatch && (
                    <p className="mt-2 flex items-start gap-1.5 rounded-xl bg-amber-100/70 px-3 py-2 text-sm font-semibold text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                      This coil is grade {c.grade}, but the order expects {order.expectedGrade}. You will be asked to acknowledge
                      this when saving.
                    </p>
                  )}

                  {fromRegister ? (
                    <dl className="mt-2 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                      <CoilFact label="Supplier" value={c.supplier} />
                      <CoilFact label="Thickness" value={c.thickness} unit="mm" />
                      <CoilFact label="Width" value={c.width} unit="mm" />
                      <CoilFact label="Yield" value={c.yield} />
                    </dl>
                  ) : (
                    <div className="mt-2 grid gap-2 sm:grid-cols-3">
                      <Field label="Grade">
                        <Input value={c.grade ?? ''} onChange={(e) => setCoil(i, { grade: e.target.value })} className="min-h-[48px]" />
                      </Field>
                      <Field label="Supplier">
                        <Input value={c.supplier ?? ''} onChange={(e) => setCoil(i, { supplier: e.target.value })} className="min-h-[48px]" />
                      </Field>
                      <Field label="Thickness">
                        <Input
                          type="number"
                          inputMode="decimal"
                          value={c.thickness ?? ''}
                          onChange={(e) => setCoil(i, { thickness: e.target.value })}
                          className="min-h-[48px]"
                        />
                      </Field>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
      )}

      <CoilPicker
        open={picking}
        onClose={() => setPicking(false)}
        onPick={addFromRegister}
        onTyped={(coilNumber) => update((d) => ({ ...d, coils: [...d.coils, { coilNumber }] }))}
        onAlready={pointAtCoil}
        expectedGrade={order.expectedGrade}
        gradeIndex={gradeIndex}
        alreadyChosen={draft.coils.map((c) => c.coilNumber)}
      />
    </div>
  )
}

function CoilFact({ label, value, unit }: { label: string; value?: string; unit?: string }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase text-muted">{label}</dt>
      <dd className="font-semibold tabular-nums">{value ? `${value}${unit ? ` ${unit}` : ''}` : '—'}</dd>
    </div>
  )
}

/**
 * What Setup holds, shown above the later steps: the drawing and the coils
 * running now. A second coil often goes on mid-session, so adding one is a
 * tap away without hunting for the Setup step on the rail.
 */
function SetupSummary({ draft, onEdit }: { draft: SampleDraft; onEdit: () => void }) {
  const coils = draft.coils.map((c) => c.coilNumber).filter(Boolean)
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl bg-slate-50 px-3 py-2 text-sm dark:bg-slate-800/50">
      <span className="text-xs font-bold uppercase tracking-wide text-muted">Setup</span>
      {draft.drawing && (
        <span>
          <span className="text-muted">Drawing</span> <span className="font-semibold">{draft.drawing}</span>
        </span>
      )}
      <span className="flex flex-wrap items-center gap-1.5">
        <span className="text-muted">Coils</span>
        {coils.length === 0 ? (
          <span className="font-semibold text-amber-600 dark:text-amber-400">none yet</span>
        ) : (
          coils.map((n) => (
            <span key={n} className="rounded-md bg-white px-2 py-0.5 font-mono text-xs font-semibold ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-700">
              {n}
            </span>
          ))
        )}
      </span>
      <Button variant="ghost" className="ml-auto min-h-[40px]" onClick={onEdit}>
        <Plus className="h-4 w-4" /> {coils.length === 0 ? 'Add coil' : 'Add coil / change setup'}
      </Button>
    </div>
  )
}

function DimensionsStep({
  draft,
  update,
  order,
  refImages,
  typedByInspector,
}: {
  draft: SampleDraft
  update: Updater
  order: ProductionOrder
  refImages: ItemReferenceImage[]
  /** The machine is set to take dimensions from the inspector, not from item setup. */
  typedByInspector: boolean
}) {
  const setRow = (i: number, patch: Partial<SampleDraft['dimensions'][number]>) =>
    update((d) => {
      const dimensions = [...d.dimensions]
      dimensions[i] = { ...dimensions[i], ...patch }
      return { ...d, dimensions }
    })

  // The approved photo of the item sits next to the measurements, so the
  // inspector compares the part in front of them while measuring it.
  const reference =
    refImages.length > 0 ? (
      <div>
        <span className="label">Reference photos for {order.itemCode}</span>
        <ImagePicker imageIds={refImages.map((r) => r.imageId)} onChange={() => {}} readOnly />
      </div>
    ) : null

  if (draft.dimensions.length === 0) {
    return (
      <div className="space-y-3">
        {reference}
        <EmptyState
          icon={<Ruler className="h-10 w-10" />}
          title={typedByInspector ? 'This machine takes dimensions from you' : 'No dimensions configured for this item on this machine'}
          hint={
            typedByInspector
              ? 'Add what the part needs — name, nominal and tolerance are typed once; the next sample starts from them.'
              : 'Add one below, or configure them in Admin so they pre-fill next time.'
          }
        />
        <AddDimensionButton update={update} label={typedByInspector ? 'Add a dimension' : undefined} />
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {reference}
      {/* A phone has no room for a six-column table: one card per dimension,
          with the measurement the inspector types made the biggest thing on it. */}
      <div className="space-y-2 sm:hidden">
        {draft.dimensions.map((d, i) => {
          const status = dimensionStatus({
            nominal: Number(d.nominal),
            tolPlus: Number(d.tolPlus),
            tolMinus: Number(d.tolMinus),
            actual: d.actual.trim() === '' ? null : Number(d.actual),
          })
          return (
            <div
              key={`${d.name}-${i}`}
              className={cn(
                'rounded-2xl border p-3',
                status === 'Fail'
                  ? 'border-rose-300 bg-rose-50/60 dark:border-rose-500/40 dark:bg-rose-500/5'
                  : status === 'Warning'
                    ? 'border-amber-300 bg-amber-50/60 dark:border-amber-500/40 dark:bg-amber-500/5'
                    : 'border-slate-200 dark:border-slate-700',
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="font-bold">{d.name}</p>
                <span className="flex items-center gap-1">
                  <Badge tone={status === 'Pass' ? 'green' : status === 'Fail' ? 'red' : status === 'Warning' ? 'amber' : 'neutral'}>{status}</Badge>
                  <button
                    onClick={() => update((dd) => ({ ...dd, dimensions: dd.dimensions.filter((_, j) => j !== i) }))}
                    className="rounded p-2 text-slate-300 hover:text-rose-500"
                    aria-label={`Remove ${d.name}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </span>
              </div>
              <div className="mt-2 grid grid-cols-[1fr_auto_1.4fr] items-end gap-2">
                <label className="block">
                  <span className="label">Nominal</span>
                  <input
                    value={d.nominal}
                    onChange={(e) => setRow(i, { nominal: e.target.value })}
                    inputMode="decimal"
                    className="input min-h-[48px] text-right tabular-nums"
                  />
                </label>
                {d.source === 'item-order' ? (
                  <span className="pb-3 text-xs tabular-nums text-muted">
                    +{d.tolPlus}/-{d.tolMinus}
                  </span>
                ) : (
                  <span className="flex flex-col gap-1">
                    <input value={d.tolPlus} onChange={(e) => setRow(i, { tolPlus: e.target.value })} inputMode="decimal" aria-label="Plus tolerance" placeholder="+tol" className="input-cell w-16 px-1.5 py-1 text-right text-xs" />
                    <input value={d.tolMinus} onChange={(e) => setRow(i, { tolMinus: e.target.value })} inputMode="decimal" aria-label="Minus tolerance" placeholder="-tol" className="input-cell w-16 px-1.5 py-1 text-right text-xs" />
                  </span>
                )}
                <label className="block">
                  <span className="label">Actual</span>
                  <input
                    value={d.actual}
                    onChange={(e) => setRow(i, { actual: e.target.value })}
                    inputMode="decimal"
                    type="number"
                    step="any"
                    placeholder="—"
                    className={cn(
                      'input min-h-[52px] text-center text-lg font-bold tabular-nums',
                      status === 'Fail' ? 'border-rose-400' : status === 'Warning' ? 'border-amber-400' : '',
                    )}
                  />
                </label>
              </div>
            </div>
          )
        })}
      </div>
      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="text-xs uppercase text-muted">
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
                      className="input-cell w-20 px-2 py-2 text-right"
                    />
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 text-center text-xs text-muted">
                    {d.source === 'item-order' ? (
                      <>
                        +{d.tolPlus}/-{d.tolMinus}
                      </>
                    ) : (
                      <span className="inline-flex items-center gap-1">
                        +
                        <input value={d.tolPlus} onChange={(e) => setRow(i, { tolPlus: e.target.value })} inputMode="decimal" aria-label="Plus tolerance" className="input-cell w-14 px-1.5 py-2 text-right text-sm" />
                        / -
                        <input value={d.tolMinus} onChange={(e) => setRow(i, { tolMinus: e.target.value })} inputMode="decimal" aria-label="Minus tolerance" className="input-cell w-14 px-1.5 py-2 text-right text-sm" />
                      </span>
                    )}
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
                        'input-cell w-24 px-2 py-3 text-center text-base font-semibold',
                        status === 'Fail' ? 'border-rose-400 focus:ring-rose-400/40 dark:border-rose-400' : status === 'Warning' ? 'border-amber-400 focus:ring-amber-400/40 dark:border-amber-400' : '',
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
      <AddDimensionButton update={update} label={typedByInspector ? 'Add a dimension' : undefined} />
    </div>
  )
}

/**
 * A dimension the configuration does not know: the inspector names it and
 * gives its nominal and tolerance on the first sample. The next sample of
 * this item on this machine carries them forward, so only the actual is
 * typed from then on (§8.3).
 */
function AddDimensionButton({ update, label = 'Add a dimension not in the configuration' }: { update: Updater; label?: string }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [nominal, setNominal] = useState('')
  const [tolPlus, setTolPlus] = useState('')
  const [tolMinus, setTolMinus] = useState('')
  const [unit, setUnit] = useState('mm')
  const valid = name.trim() !== '' && nominal.trim() !== '' && Number.isFinite(Number(nominal))

  function add() {
    update((d) => ({
      ...d,
      dimensions: [
        ...d.dimensions,
        {
          name: name.trim(),
          sequence: d.dimensions.length + 1,
          nominal: nominal.trim(),
          tolPlus: tolPlus.trim() || '0',
          tolMinus: tolMinus.trim() || tolPlus.trim() || '0',
          actual: '',
          unit: unit.trim() || 'mm',
          source: 'manual' as const,
        },
      ],
    }))
    setName('')
    setNominal('')
    setTolPlus('')
    setTolMinus('')
    setOpen(false)
  }

  if (!open) {
    return (
      <Button variant="secondary" className="min-h-[48px]" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" /> {label}
      </Button>
    )
  }

  return (
    <div className="rounded-2xl border border-dashed border-brand-300 bg-brand-50/40 p-3 dark:border-brand-500/40 dark:bg-brand-500/5">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-[2fr_1fr_1fr_1fr_0.8fr]">
        <label className="col-span-2 block sm:col-span-1">
          <span className="label">Dimension</span>
          <Input autoFocus dir="auto" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Hole pitch" className="min-h-[48px]" />
        </label>
        <label className="block">
          <span className="label">Nominal</span>
          <Input value={nominal} onChange={(e) => setNominal(e.target.value)} inputMode="decimal" type="number" step="any" className="min-h-[48px] text-right tabular-nums" />
        </label>
        <label className="block">
          <span className="label">+ tol</span>
          <Input value={tolPlus} onChange={(e) => setTolPlus(e.target.value)} inputMode="decimal" type="number" step="any" placeholder="0" className="min-h-[48px] text-right tabular-nums" />
        </label>
        <label className="block">
          <span className="label">- tol</span>
          <Input value={tolMinus} onChange={(e) => setTolMinus(e.target.value)} inputMode="decimal" type="number" step="any" placeholder={tolPlus || '0'} className="min-h-[48px] text-right tabular-nums" />
        </label>
        <label className="block">
          <span className="label">Unit</span>
          <Input value={unit} onChange={(e) => setUnit(e.target.value)} className="min-h-[48px]" />
        </label>
      </div>
      <div className="mt-2 flex justify-end gap-2">
        <Button className="min-h-[44px]" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button variant="primary" className="min-h-[44px]" disabled={!valid} onClick={add}>
          <Plus className="h-4 w-4" /> Add
        </Button>
      </div>
      <p className="mt-2 text-xs text-muted">Entered once: the next sample of this item on this machine keeps the nominal and tolerance, and asks only for the actual.</p>
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
  sessionId?: string
  orderId: string
}) {
  const [search, setSearch] = useState('')
  const typed = search.trim()
  const filtered = options.filter((o) => o.toLowerCase().includes(typed.toLowerCase()))

  const setDefect = (key: string, patch: Partial<DraftDefect>) =>
    update((d) => ({
      ...d,
      defects: d.defects.map((x) => (x.key === key ? { ...x, ...patch } : x)),
    }))
  const addDefect = (defectName: string) =>
    update((d) => ({
      ...d,
      defects: [...d.defects, { key: uid('dk'), defectName, qty: '1', disposition: null, imageIds: [] }],
    }))

  return (
    <div className="space-y-4">
      <div>
        <span className="label">Add a defect</span>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={options.length === 0 ? 'Type the defect name…' : "Search this machine's defects, or type a new name…"}
            className="min-h-[48px] pl-9"
          />
        </div>
        {options.length === 0 && (
          <p className="mt-2 rounded-xl border border-dashed border-slate-200 py-3 text-center text-sm text-muted dark:border-slate-700">
            No defects are configured for machine {draft.workCenterCode} yet — type the defect's name above and add it.
          </p>
        )}
        <div className="mt-2 flex max-h-44 flex-wrap gap-2 overflow-y-auto">
          {/* A name the list does not carry is added as typed, so a machine without a list still gets named defects. */}
          {typed && !options.some((o) => o.trim().toLowerCase() === typed.toLowerCase()) && (
            <button
              dir="auto"
              onClick={() => {
                addDefect(typed)
                setSearch('')
              }}
              className="min-h-[44px] rounded-xl bg-brand-600 px-3 text-sm font-semibold text-white shadow-sm hover:bg-brand-700"
            >
              + Add "{typed}"
            </button>
          )}
          {filtered.map((name) => (
            <button
              key={name}
              dir="auto"
              onClick={() => addDefect(name)}
              className="min-h-[44px] rounded-xl bg-slate-100 px-3 text-sm font-semibold hover:bg-brand-100 hover:text-brand-700 dark:bg-slate-800 dark:hover:bg-brand-500/20"
            >
              + {name}
            </button>
          ))}
          {/* Anything the list does not name is recorded as "Other" and must be described. */}
          <button
            onClick={() => addDefect(OTHER_DEFECT_NAME)}
            className="min-h-[44px] rounded-xl border border-dashed border-amber-400 bg-amber-50 px-3 text-sm font-semibold text-amber-800 hover:bg-amber-100 dark:bg-amber-500/10 dark:text-amber-200 dark:hover:bg-amber-500/20"
          >
            + Other (not in the list)
          </button>
        </div>
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
                <p dir="auto" className="flex items-center gap-2 font-bold">
                  {d.defectName}
                  {isOtherDefect(d.defectName) && <Badge tone="amber">describe it</Badge>}
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

              {isOtherDefect(d.defectName) ? (
                <Field label="Describe the defect *">
                  <textarea
                    dir="auto"
                    value={d.notes ?? ''}
                    onChange={(e) => setDefect(d.key, { notes: e.target.value })}
                    placeholder="What was found, where on the part, how big…"
                    className={cn('input min-h-[88px]', !d.notes?.trim() && 'border-rose-400')}
                  />
                </Field>
              ) : (
                <Field label="Notes">
                  <Input
                    dir="auto"
                    value={d.notes ?? ''}
                    onChange={(e) => setDefect(d.key, { notes: e.target.value })}
                    className="min-h-[48px]"
                  />
                </Field>
              )}

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

/** The draft that re-records an existing sample: every row as it stands, ready to be changed. */
function draftFromSample(detail: SampleDetail, sessionId: string, workCenterCode: string, process: Process): SampleDraft {
  const { sample, dimensions, defects, coils, paint, pt } = detail
  const str = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(v))
  return {
    sessionId,
    orderId: sample.orderId,
    workCenterCode,
    process,
    submissionId: newSubmissionId(),
    editingSampleId: sample.id,
    editingVersion: sample.version,
    step: stepsForProcess(process)[0],
    drawing: sample.drawing,
    drawingAlt: sample.drawingAlt,
    issue: sample.issue,
    sampleQty: String(sample.sampleQty),
    coils: coils.map((c) => ({
      coilId: c.coilId ?? undefined,
      coilNumber: c.coilNumber,
      grade: c.grade ?? '',
      smType: c.smType ?? '',
      supplier: c.supplier ?? '',
      thickness: str(c.thickness),
      width: str(c.width),
      yield: str(c.yield),
      notes: c.notes ?? '',
    })),
    dimensions: dimensions.map((d) => ({
      name: d.name,
      sequence: d.sequence,
      nominal: str(d.nominal),
      tolPlus: str(d.tolPlus),
      tolMinus: str(d.tolMinus),
      actual: str(d.actual),
      unit: d.unit,
      source: d.source,
    })),
    defects: defects.map((d) => ({ key: uid('dk'), defectName: d.defectName, qty: String(d.qty), disposition: d.disposition, notes: d.notes ?? '', imageIds: d.imageIds })),
    paint: { notes: paint?.notes ?? '', imageIds: paint?.imageIds ?? [] },
    note: { text: '', imageIds: [] },
    pt:
      process === 'welding'
        ? {
            consumableLots: pt?.consumableLots ?? {},
            weldingWireBatch: pt?.weldingWireBatch ?? '',
            testedLengths: (pt?.testedLengths ?? []).map((l) => ({ key: uid('tl'), lengthMm: String(l.lengthMm), verdict: l.verdict })),
            notes: pt?.notes ?? '',
            imageIds: pt?.imageIds ?? [],
          }
        : undefined,
    gradeAcknowledged: sample.gradeAcknowledgement
      ? {
          coilNumbers: sample.gradeAcknowledgement.coilNumbers,
          expectedGrade: sample.gradeAcknowledgement.expectedGrade,
          foundGrades: sample.gradeAcknowledgement.foundGrades,
          at: sample.gradeAcknowledgement.at,
        }
      : undefined,
    updatedAt: new Date().toISOString(),
  }
}

function emptyPT(): DraftPT {
  return { consumableLots: {}, weldingWireBatch: '', testedLengths: [], imageIds: [] }
}

function PaintStep({
  draft,
  update,
  sessionId,
  orderId,
}: {
  draft: SampleDraft
  update: Updater
  sessionId?: string
  orderId: string
}) {
  return (
    <div className="space-y-4">
      {draft.paint.imageIds.length === 0 && (
        <p className="rounded-xl border border-dashed border-rose-300 bg-rose-50/40 px-3 py-4 text-center text-sm text-rose-600 dark:border-rose-500/40 dark:bg-rose-500/5 dark:text-rose-300">
          Photograph the paint sample first — at least one photo is required before the thickness readings.
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

/**
 * Readings of the dry film thickness, recorded as measured: three to start
 * with, three more with every press of Add. The paint line records what the
 * gauge shows; no required value or tolerance is asked for and no judgement
 * is made on the readings. An added reading left empty is not saved.
 */
function PaintThicknessStep({ draft, update }: { draft: SampleDraft; update: Updater }) {
  const readings = draft.dimensions.map((d, i) => ({ d, i })).filter(({ d }) => isPaintThicknessName(d.name))
  const unit = readings[0]?.d.unit || PAINT_THICKNESS_UNIT
  const setActual = (index: number, actual: string) =>
    update((dd) => {
      const dimensions = [...dd.dimensions]
      dimensions[index] = { ...dimensions[index], actual }
      return { ...dd, dimensions }
    })
  const addThree = () =>
    update((dd) => {
      const mine = dd.dimensions.filter((d) => isPaintThicknessName(d.name))
      const last = mine.reduce((n, d) => Math.max(n, d.sequence), 0)
      const more: DraftDimension[] = Array.from({ length: PAINT_THICKNESS_READINGS }, (_, i) => ({
        name: PAINT_THICKNESS_NAME,
        sequence: last + i + 1,
        nominal: '',
        tolPlus: '',
        tolMinus: '',
        actual: '',
        unit,
        source: 'manual' as const,
      }))
      return { ...dd, dimensions: [...dd.dimensions, ...more] }
    })
  const removeFrom = (index: number) =>
    update((dd) => {
      const dimensions = dd.dimensions.filter((_, i) => i !== index)
      let seq = 0
      return { ...dd, dimensions: dimensions.map((d) => (isPaintThicknessName(d.name) ? { ...d, sequence: ++seq } : d)) }
    })

  if (readings.length === 0) return <Empty>No thickness readings on this draft.</Empty>

  return (
    <div className="space-y-4">
      <div>
        <span className="label">
          Thickness readings <span className="normal-case">({unit})</span>
        </span>
        <div className="grid gap-2 sm:grid-cols-3">
          {readings.map(({ d, i }, n) => {
            const filled = d.actual.trim() !== ''
            const required = n < PAINT_THICKNESS_READINGS
            return (
              <label key={i} className={cn('relative block rounded-2xl border p-3', filled ? 'border-emerald-300 bg-emerald-50/40 dark:border-emerald-500/40 dark:bg-emerald-500/5' : 'border-slate-200 dark:border-slate-700')}>
                <span className="flex items-center justify-between gap-2">
                  <span className="text-sm font-bold">Reading {n + 1}</span>
                  <span className="flex items-center gap-1">
                    {filled ? <Badge tone="green">Recorded</Badge> : required ? <Badge tone="neutral">Required</Badge> : <Badge tone="neutral">Optional</Badge>}
                    {!required && (
                      <button type="button" onClick={(e) => { e.preventDefault(); removeFrom(i) }} className="grid h-7 w-7 place-items-center rounded-lg text-muted hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10" aria-label={`Remove reading ${n + 1}`}>
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </span>
                </span>
                <input
                  value={d.actual}
                  onChange={(e) => setActual(i, e.target.value)}
                  inputMode="decimal"
                  type="number"
                  step="any"
                  placeholder="—"
                  className="input mt-2 min-h-[56px] text-center text-2xl font-bold tabular-nums"
                />
              </label>
            )
          })}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button type="button" onClick={addThree} className="min-h-[44px]" disabled={readings.length >= 30}>
            <Plus className="h-4 w-4" /> Add {PAINT_THICKNESS_READINGS} more readings
          </Button>
          <span className="text-xs text-muted">
            {readings.filter(({ d }) => d.actual.trim() !== '').length} of {readings.length} recorded · the first {PAINT_THICKNESS_READINGS} are required, an empty extra one is not saved.
          </span>
        </div>
      </div>
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
  sessionId?: string
  orderId: string
}) {
  const pt = draft.pt ?? emptyPT()
  const setPT = (patch: Partial<DraftPT>) => update((d) => ({ ...d, pt: { ...(d.pt ?? emptyPT()), ...patch } }))
  const testedHere = pt.testedLengths.length
  const setLength = (key: string, patch: Partial<DraftPT['testedLengths'][number]>) =>
    setPT({ testedLengths: pt.testedLengths.map((l) => (l.key === key ? { ...l, ...patch } : l)) })
  const overall = ptOverallVerdict(pt.testedLengths.map((l) => ({ verdict: l.verdict })))

  return (
    <div className="space-y-4">
      {/* The requirement is worked out, not typed: 5% of the final quantity, rounded up, once the session closes. */}
      <div className="rounded-2xl border-l-4 border-l-brand-500 bg-brand-50/60 p-3 text-sm text-brand-900 dark:bg-brand-500/10 dark:text-brand-100">
        <p className="font-bold">PT covers {PT_MIN_TEST_FREQUENCY_PCT}% of the session's production</p>
        <p>
          The required count is {PT_MIN_TEST_FREQUENCY_PCT}% of the final quantity, rounded up to a whole piece, and is worked out when the session is closed.
          Every tested length recorded here counts toward it{testedHere > 0 ? ` — ${testedHere} in this sample so far` : ''}.
        </p>
      </div>

      <div>
        <span className="label">PT materials — lot / batch is mandatory</span>
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

      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="label !mb-0">
            Tested weld lengths {pt.testedLengths.length === 0 && <span className="text-rose-500">· at least one</span>}
          </span>
          <Button
            variant="secondary"
            className="min-h-[44px]"
            onClick={() => setPT({ testedLengths: [...pt.testedLengths, { key: uid(), lengthMm: '' }] })}
          >
            <Plus className="h-4 w-4" /> Add length
          </Button>
        </div>
        {pt.testedLengths.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-200 py-4 text-center text-sm text-muted dark:border-slate-700">
            Add each weld length you tested and give it a verdict.
          </p>
        ) : (
          <div className="space-y-2">
            {pt.testedLengths.map((l, n) => {
              const bad = l.lengthMm.trim() !== '' && !(Number(l.lengthMm) > 0)
              return (
                <div key={l.key} className="grid grid-cols-[auto_1fr_auto] items-center gap-2 rounded-2xl border border-slate-200 p-2.5 dark:border-slate-700 sm:grid-cols-[auto_1fr_auto_auto]">
                  <span className="grid h-10 w-10 place-items-center rounded-xl bg-slate-100 text-sm font-bold text-slate-600 dark:bg-slate-800 dark:text-slate-300">{n + 1}</span>
                  <label className="block">
                    <span className="sr-only">Length {n + 1} in mm</span>
                    <div className="relative">
                      <input
                        value={l.lengthMm}
                        onChange={(e) => setLength(l.key, { lengthMm: e.target.value })}
                        inputMode="decimal"
                        type="number"
                        step="any"
                        placeholder="Length"
                        className={cn('input min-h-[48px] pr-12 text-lg font-bold tabular-nums', bad && 'border-rose-400')}
                      />
                      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-muted">mm</span>
                    </div>
                  </label>
                  <div className="col-span-3 flex rounded-xl bg-slate-100 p-1 dark:bg-slate-800 sm:col-span-1">
                    {(['Accept', 'Reject / Repair'] as const).map((v) => (
                      <button
                        key={v}
                        type="button"
                        onClick={() => setLength(l.key, { verdict: v })}
                        className={cn(
                          'min-h-[40px] flex-1 rounded-lg px-3 text-sm font-semibold transition-colors',
                          l.verdict === v
                            ? v === 'Accept'
                              ? 'bg-emerald-600 text-white shadow-sm'
                              : 'bg-rose-600 text-white shadow-sm'
                            : 'text-slate-600 dark:text-slate-300',
                        )}
                      >
                        {v}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => setPT({ testedLengths: pt.testedLengths.filter((x) => x.key !== l.key) })}
                    className="hidden h-10 w-10 place-items-center rounded-xl text-slate-300 hover:text-rose-500 sm:grid"
                    aria-label={`Remove length ${n + 1}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              )
            })}
            <p className="flex items-center gap-2 text-sm">
              <span className="font-semibold text-muted">PT verdict:</span>
              {overall ? <Badge tone={overall === 'Accept' ? 'green' : 'red'}>{overall}</Badge> : <Badge tone="neutral">pending</Badge>}
            </p>
          </div>
        )}
      </div>

      <Field label="Notes">
        <textarea dir="auto" className="input min-h-[80px]" placeholder="PT inspection notes…" value={pt.notes ?? ''} onChange={(e) => setPT({ notes: e.target.value })} />
      </Field>

      <div>
        <span className="label">Photos</span>
        <ImagePicker imageIds={pt.imageIds} onChange={(ids) => setPT({ imageIds: ids })} sessionId={sessionId} orderId={orderId} />
      </div>
    </div>
  )
}

function ReviewStep({
  draft,
  order,
  issues,
  update,
  orderNotes,
  sessionId,
  orderId,
}: {
  draft: SampleDraft
  order: ProductionOrder
  issues: { step: WizardStep; message: string }[]
  update: Updater
  /** Every note written about this order so far, newest first. */
  orderNotes: SessionNote[]
  sessionId?: string
  orderId: string
}) {
  const measured = draft.dimensions.filter((d) => d.actual.trim() !== '')
  const qty = Number(draft.sampleQty)
  const qtyBad = !(draft.sampleQty.trim() !== '' && qty > 0)
  const note: DraftNote = draft.note ?? { text: '', imageIds: [] }
  const setNote = (patch: Partial<DraftNote>) => update((d) => ({ ...d, note: { ...(d.note ?? { text: '', imageIds: [] }), ...patch } }))
  return (
    <div className="space-y-4">
      {/* §5.7 — the quantity actually taken is known only once the inspection is done. */}
      <Field label="Sample quantity taken" hint="How many pieces this inspection covered.">
        <Input
          autoFocus
          type="number"
          inputMode="numeric"
          min={1}
          value={draft.sampleQty}
          onChange={(e) => update({ sampleQty: e.target.value })}
          placeholder="e.g. 5"
          className={cn('min-h-[52px] text-lg', qtyBad && 'border-rose-400')}
        />
      </Field>

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
          {draft.process !== 'paint' && <Row label="Drawing" value={draft.drawing || '—'} />}
          {draft.process === 'welding' && <Row label="Welding wire" value={draft.pt?.weldingWireBatch?.trim() || '—'} />}
          <Row label="Sample qty" value={draft.sampleQty || '—'} />
        </dl>
      </Section>

      {draft.process !== 'paint' && draft.process !== 'welding' && (
      <Section title={`Coils (${draft.coils.length})`}>
        {draft.coils.length === 0 ? (
          <Empty>No coils recorded.</Empty>
        ) : (
          <ul className="space-y-1 text-sm">
            {draft.coils.map((c, i) => (
              <li key={i} className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2 dark:bg-slate-800/50">
                <span className="font-semibold">{c.coilNumber || '(no id)'}</span>
                <span className="flex items-center gap-2">
                  {!c.coilId && <Badge tone="amber">typed</Badge>}
                  <span className="text-muted">{c.grade || '—'}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
      )}

      <Section title={draft.process === 'paint' ? `Paint thickness (${measured.length} reading${measured.length === 1 ? '' : 's'})` : `Dimensions (${measured.length} measured)`}>
        {measured.length === 0 ? (
          <Empty>No measurements entered.</Empty>
        ) : draft.process === 'paint' ? (
          <ul className="grid grid-cols-3 gap-2 text-sm">
            {measured.map((d, i) => (
              <li key={i} className="rounded-lg bg-slate-50 px-3 py-2 text-center dark:bg-slate-800/50">
                <span className="block text-xs font-semibold uppercase text-muted">Reading {d.sequence}</span>
                <span className="text-lg font-bold tabular-nums">
                  {d.actual} <span className="text-xs font-normal text-muted">{d.unit}</span>
                </span>
              </li>
            ))}
          </ul>
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
                      <td className="py-2 text-right tabular-nums text-muted">
                        {d.nominal.trim() === '' ? '— (no nominal)' : `${d.nominal} +${d.tolPlus || 0}/-${d.tolMinus || 0}`}
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
                <span dir="auto" className="min-w-0 font-semibold">
                  {d.defectName}
                  {isOtherDefect(d.defectName) && d.notes && <span className="block truncate text-xs font-normal text-muted">{d.notes}</span>}
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

      {draft.process === 'paint' && (
        <Section title="Paint sample">
          {draft.paint.imageIds.length === 0 ? <Empty>No paint photos.</Empty> : <p className="text-sm">{draft.paint.imageIds.length} photo(s)</p>}
        </Section>
      )}

      {draft.process === 'welding' && draft.pt && (
        <Section title="PT / weld">
          <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            <Row label="Cleaner lot" value={draft.pt.consumableLots.Cleaner ?? '—'} />
            <Row label="Penetrant lot" value={draft.pt.consumableLots.Penetrant ?? '—'} />
            <Row label="Developer lot" value={draft.pt.consumableLots.Developer ?? '—'} />
            <Row
              label="Tested lengths"
              value={draft.pt.testedLengths.map((l) => `${l.lengthMm || '?'} mm ${l.verdict === 'Reject / Repair' ? '✕' : l.verdict === 'Accept' ? '✓' : '?'}`).join(', ') || '—'}
            />
            <Row label="PT verdict" value={ptOverallVerdict(draft.pt.testedLengths.map((l) => ({ verdict: l.verdict }))) ?? 'pending'} />
          </dl>
        </Section>
      )}

      {/* §5.8 — a remark about the order as a whole: not this sample, the order. */}
      <Section title="Notes about this order">
        <div className="space-y-3 rounded-2xl border border-slate-200 p-3 dark:border-slate-700">
          <Field label="Note" hint="Anything about the order in general — packing, customer requests, what the next shift should know. Optional.">
            <textarea
              dir="auto"
              className="input min-h-[96px]"
              maxLength={4000}
              value={note.text}
              onChange={(e) => setNote({ text: e.target.value })}
              placeholder="Write a note about the order…"
            />
          </Field>
          <Field label="Photos" hint="Photos of the order in general, not of a defect.">
            <ImagePicker imageIds={note.imageIds} onChange={(ids) => setNote({ imageIds: ids })} sessionId={sessionId} orderId={orderId} />
          </Field>
        </div>
        <div className="mt-3">
          <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted">
            <MessageSquareText className="h-3.5 w-3.5" /> Earlier notes on this item here
            {orderNotes.length > 0 && <Badge tone="neutral">{orderNotes.length}</Badge>}
          </p>
          <OrderNoteList notes={orderNotes} emptyMessage="No notes on this item on this machine yet." />
        </div>
      </Section>

      <p className="flex items-start gap-2 rounded-xl bg-slate-50 px-3 py-3 text-sm text-muted dark:bg-slate-800/50">
        <Layers className="mt-0.5 h-4 w-4 shrink-0" />
        Saving writes the sample, its measurements, defects, coils, attachments and your note as one unit. If anything
        fails, nothing is written and your entries stay on this screen.
      </p>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-muted">{title}</h3>
      {children}
    </div>
  )
}
function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase text-muted">{label}</dt>
      <dd className="truncate font-semibold">{value}</dd>
    </div>
  )
}
function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-slate-200 py-3 text-center text-sm text-muted dark:border-slate-700">
      {children}
    </p>
  )
}
