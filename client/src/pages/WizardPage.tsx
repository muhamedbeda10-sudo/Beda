import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
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
  Pencil,
  BookOpen,
  ChevronDown,
} from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Select, resultTone } from '@/components/ui'
import { ImagePicker } from '@/components/inspection/ImagePicker'
import { CoilPicker } from '@/components/inspection/CoilPicker'
import { WorkInstructionLinks } from '@/components/documents/WorkInstructionLinks'
import { WorkInstructionViewer } from '@/components/documents/WorkInstructionViewer'
import { EdgeShadows, useScrollEdges } from '@/components/ui/ScrollX'
import { UndoStrip, insertAt, useUndo } from '@/components/inspection/UndoStrip'
import { useDebounced, useSampleDetail, useWizardContext, useWizardPreview } from '@/services/queries'
import { useWeldingWireSuggestions } from '@/services/mtc'
import { discardSession, matchNotices, reRecordSample, saveSample, startSessionWithSample } from '@/services/mutations'
import { NoticeGate } from '@/components/notices/NoticeGate'
import type { NoticeForUser } from '@qc/shared/types'
import { loadDraft, saveDraft, clearDraft, type SampleDraft, type DraftDefect, type DraftCoil, type DraftPT, type DraftDimension, type DraftNote, draftIsUntouched } from '@/services/draftStore'
import { OrderNoteList } from '@/components/inspection/OrderNotes'
import { useApp } from '@/store/AppContext'
import { useAuth } from '@/store/AuthContext'
import { cn, uid, newSubmissionId } from '@/lib/utils'
import { PHONE, isCoarsePointer, matchesMedia, useMediaQuery } from '@/lib/media'
import { useBottomBarRef } from '@/lib/bottomBar'
import {
  SHORT_LANDSCAPE,
  coveringAcknowledgement,
  dimensionFigures,
  hasBadFigure,
  isBlankLength,
  keptLengths,
  keyboardLikelyOpen,
  opensKeyboard,
  previewStatus,
  renumberLengthIssues,
  withCoilRule,
  wizardLoadState,
} from './wizardHelpers'
import { isDecimalOrBlank, normaliseDecimal, parseDecimal } from '@/lib/decimal'
import { failureMessage, singleFlight } from '@/lib/busyAction'
import { useHoldUpdates } from '@/lib/appUpdate'
import { useUploadsInFlight } from '@/components/inspection/imageUploads'
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
  resolveDimensions,
  validateSample,
  buildGradeIndex,
  findGradeMismatches,
  gradesEquivalent,
  isPaintThicknessName,
  isOtherDefect,
  isStockOrder,
  drawingRequiredFor,
  orderDrawings,
  OTHER_DEFECT_NAME,
  ptOverallVerdict,
  PAINT_THICKNESS_NAME,
  PAINT_THICKNESS_READINGS,
  PAINT_THICKNESS_UNIT,
  PT_MIN_TEST_FREQUENCY_PCT,
  takesConfiguredDimensions,
  type WizardStep,
} from '@qc/shared/rules'

/** Each step's name, the shorter one its chip carries where only the open step is named, and its icon. */
const STEP_META: Record<WizardStep, { label: string; short: string; icon: typeof Ruler }> = {
  setup: { label: 'Setup', short: 'Setup', icon: ClipboardList },
  dimensions: { label: 'Dimensions', short: 'Dimensions', icon: Ruler },
  defects: { label: 'Defects', short: 'Defects', icon: AlertTriangle },
  paint: { label: 'Paint sample', short: 'Paint', icon: Camera },
  paintThickness: { label: 'Paint thickness', short: 'Thickness', icon: Gauge },
  pt: { label: 'PT / Weld', short: 'PT / Weld', icon: FlaskConical },
  review: { label: 'Review & Save', short: 'Review', icon: Check },
}

const CONSUMABLE_KINDS: PTConsumableKind[] = ['Cleaner', 'Penetrant', 'Developer']

/** The card that holds the open step: a step opened from further down the page is scrolled to its top. */
const STEP_CARD_ID = 'wizard-step'

/**
 * The rail (or, on a short landscape screen, the strip around it): stuck under
 * the app header — 4rem, its 1px rule and the safe area above it. While it is
 * stuck it takes the page's colour and a hairline like the header's, so the
 * step being filled in scrolls away beneath it; at rest it is part of the page.
 */
const STICKY = 'top-[calc(4rem+1px+env(safe-area-inset-top))] z-20 py-2 transition-[background-color,box-shadow] duration-150'
const STUCK = 'bg-slate-100/95 shadow-[0_1px_0_theme(colors.slate.200)] backdrop-blur dark:bg-slate-950/95 dark:shadow-[0_1px_0_theme(colors.slate.800)]'

/** A row's delete control: a 44 px target, grey until it is pointed at (AA against white and the tinted rows). */
const REMOVE = 'icon-btn shrink-0 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10 dark:hover:text-rose-400'

export function WizardPage() {
  const { sessionId = '', sampleId: editingSampleId } = useParams()
  const [search] = useSearchParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { toast } = useApp()
  const { factoryTimeZone, profile } = useAuth()
  /** Drafts on this device are the person's own: on a shared tablet the next inspector never resumes them. */
  const userId = profile?.id ?? ''

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
  const { data: ctx, isLoading: sessionsLoading, isFetching: ctxFetching, error: loadError, refetch: reloadContext } = pending ? preview : existing
  // A refresh that failed in the background keeps what was loaded: the wizard works on from it, offline included.
  const loadState = wizardLoadState(!!ctx, loadError)
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
  const previousConnectorCoil = ctx?.previousConnectorCoilNumber ?? null
  const previousSetup = ctx?.previousSetup ?? null
  const orderNotes = useMemo(() => ctx?.orderNotes ?? [], [ctx])
  const steps = useMemo(() => stepsForProcess(process), [process])

  const [draft, setDraft] = useState<SampleDraft | null>(null)
  const [saving, setSaving] = useState(false)
  /** One save (or discard) at a time: a second tap before the button greys out finds it taken. */
  const saveFlight = useRef(singleFlight()).current
  /** Batches of photos still uploading: Save waits for them, so no photo is left off the sample. */
  const [uploads, onUploading] = useUploadsInFlight()
  // A deploy waits while a sample is being entered here (lib/appUpdate.ts).
  useHoldUpdates(draft !== null)
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
    const stored = loadDraft(userId, draftKey, editingSampleId)
    if (stored && !draftIsUntouched(stored) && (!editing || stored.editingVersion === editing.sample.version)) {
      setDraft(stored)
      return
    }
    if (editing && session) {
      setDraft(draftFromSample(editing, userId, session.id, session.workCenterCode, process))
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
      userId,
      sessionId: draftKey,
      orderId: order.id,
      workCenterCode: wc,
      process,
      submissionId: newSubmissionId(),
      step: carried ? steps[1] : steps[0],
      // The line's first real drawing (DWG2 when DWG1 is a placeholder such as "(V)"); one carried from the session's
      // last sample stays while the sheet still gives it.
      drawing: carried
        ? isStockOrder(order) || orderDrawings(order).includes(carried.drawing.trim())
          ? carried.drawing
          : (orderDrawings(order)[0] ?? '')
        : process === 'paint'
          ? ''
          : (orderDrawings(order)[0] ?? ''),
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
      // The coils carried with it were acknowledged on the previous sample; it holds only while they stay as they are
      // (coveringAcknowledgement, on saving).
      gradeAcknowledged: carried?.gradeAcknowledgement
        ? { ...carried.gradeAcknowledgement, at: new Date().toISOString() }
        : undefined,
      dimensions,
      defects: [],
      paint: { imageIds: [] },
      note: { text: '', imageIds: [] },
      pt:
        process === 'welding'
          ? { consumableLots: {}, weldingWireBatch: previousWire ?? '', connectorCoilNumber: previousConnectorCoil ?? '', testedLengths: [], imageIds: [] }
          : undefined,
      updatedAt: new Date().toISOString(),
    })
  }, [session, pending, draftKey, userId, wc, order, draft, dimOrder, previousDims, process, previousWire, previousConnectorCoil, previousSetup, editing, editingSampleId, ctxFetching])

  // Persist on every change so a reload or a dead network loses nothing (§9.6). A change to the coils lets go of the
  // grade acknowledgement given for them as they were (§8.4).
  const update = useCallback((patch: Partial<SampleDraft> | ((d: SampleDraft) => SampleDraft)) => {
    setDraft((cur) => {
      if (!cur) return cur
      const next = withCoilRule(cur, typeof patch === 'function' ? patch(cur) : { ...cur, ...patch })
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
    // A tested-length row left blank is not saved, so it is not checked either; an issue about a later row keeps that
    // row's number on the screen.
    const lengths = keptLengths(draft.pt?.testedLengths ?? [])
    const found = validateSample({
      process: draft.process,
      // A stock item, or a line whose sheet names no drawing, has none to pick.
      drawingRequired: drawingRequiredFor(order),
      // Roll forming, the 400 t press…: the machine requires the coil (Configuration → Machines).
      coilRequired: !!machine?.coilRequired,
      sampleQty: Number(draft.sampleQty),
      drawing: draft.drawing,
      coils: draft.coils.map((c) => ({ coilNumber: c.coilNumber, grade: c.grade })),
      defects: draft.defects.map((d) => ({
        defectName: d.defectName,
        disposition: d.disposition,
        qty: Number(d.qty),
        notes: d.notes,
      })),
      // Read as the save reads them: blank is null, a figure that is not a number is NaN and refused by name.
      dimensions: draft.dimensions.map((d) => ({ name: d.name, ...dimensionFigures(d) })),
      paint: { imageIds: draft.paint.imageIds },
      pt: draft.pt
        ? {
            consumableLots: draft.pt.consumableLots,
            connectorCoilNumber: draft.pt.connectorCoilNumber,
            testedLengths: lengths.kept.map((l) => ({ lengthMm: parseDecimal(l.lengthMm) ?? Number.NaN, verdict: l.verdict ?? null })),
          }
        : undefined,
    })
    return renumberLengthIssues(found, lengths.rowOf)
  }, [draft, order, machine?.coilRequired])

  // ---- Layout: the rail, the keyboard, a short landscape screen ------------
  const short = useMediaQuery(SHORT_LANDSCAPE)
  const keyboard = useKeyboardOpen()
  const stickyRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLDivElement | null>(null)
  // The bar also lifts what floats in the bottom corner (the assistant's button) above Back and Next.
  const bottomBar = useBottomBarRef<HTMLDivElement>()
  const setBar = useCallback(
    (el: HTMLDivElement | null) => {
      barRef.current = el
      bottomBar(el)
    },
    [bottomBar],
  )
  useScrollPadding(stickyRef, barRef, `${!!draft} ${short} ${keyboard}`, keyboard)
  const stuck = useStuck(stickyRef, `${!!draft} ${short} ${keyboard}`)
  /** Set when a save is refused for the sample quantity: the review step then puts the cursor in it. */
  const [focusQty, setFocusQty] = useState(false)
  /** The same for the connector coil number, which lives on Setup: the save lands there with the cursor in it. */
  const [focusConnector, setFocusConnector] = useState(false)
  const connectorFocused = useCallback(() => setFocusConnector(false), [])
  /** A save was refused while the connector coil number was blank: Setup marks the field until it is filled. */
  const [connectorRefused, setConnectorRefused] = useState(false)

  // A step opened from further down the page — Next at the foot of a long step, a chip on the stuck rail — starts at
  // its top, just under the rail. One opened with the top of the page in view stays where it is.
  const shownStep = draft?.step
  const lastStep = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!shownStep) return
    const previous = lastStep.current
    lastStep.current = shownStep
    if (previous === undefined || previous === shownStep) return
    const card = document.getElementById(STEP_CARD_ID)
    const clear = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0
    if (card && card.getBoundingClientRect().top < clear) card.scrollIntoView({ block: 'start' })
  }, [shownStep])

  if (sessionsLoading || (editingSampleId && editingLoading)) return <Card className="p-10 text-center text-sm text-muted">Loading…</Card>
  // Nothing loaded and the server not reached: that is not "deleted", and trying again may well work.
  if (loadState === 'failed') {
    return (
      <EmptyState
        icon={<CloudOff className="h-10 w-10" />}
        title="Could not load this session"
        hint={failureMessage(loadError, 'The server could not be reached.')}
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Button variant="primary" onClick={() => void reloadContext()}>
              Try again
            </Button>
            <Button onClick={() => navigate('/')}>Back to inspections</Button>
          </div>
        }
      />
    )
  }
  if (loadState === 'not-found' || !order || (!session && !pending)) {
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

  /** One save at a time: the Save button and the grade prompt's Acknowledge both come here, and a second tap waits out the first. */
  function performSave(acknowledged?: SampleDraft['gradeAcknowledged']) {
    return saveFlight.run(() => save(acknowledged))
  }

  async function save(acknowledged?: SampleDraft['gradeAcknowledged']) {
    if (!draft || !order || (!session && !pending)) return
    // The figures as the checks read them. A nominal, tolerance or actual that is not a number would go as null — a
    // blank the record would keep for good — so the save is refused instead (validateSample names the row; this is
    // the last word, whatever path reached it).
    const measured = draft.dimensions
      .map((d) => ({ d, figures: dimensionFigures(d) }))
      .filter(({ d }) => d.actual.trim() !== '' || d.nominal.trim() !== '')
    const unreadable = measured.find(({ figures }) => hasBadFigure(figures))
    if (unreadable) {
      goto(steps.includes('dimensions') ? 'dimensions' : 'paintThickness')
      toast(`"${unreadable.d.name}" has a figure that is not a number. Type digits only, e.g. 12.5.`, 'error')
      setGradePrompt(null)
      return
    }
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
        dimensions: measured.map(({ d, figures }) => ({
          name: d.name,
          sequence: d.sequence,
          ...figures,
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
                // validateSample has already refused a missing connector coil number.
                connectorCoilNumber: draft.pt.connectorCoilNumber?.trim() || undefined,
                // validateSample has already refused a missing verdict or length; a blank row is not saved.
                testedLengths: keptLengths(draft.pt.testedLengths).kept.map((l) => ({ lengthMm: parseDecimal(l.lengthMm) ?? Number.NaN, verdict: l.verdict as PTVerdict })),
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
        clearDraft(userId, draftKey)
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
        clearDraft(userId, session.id, draft.editingSampleId)
        setDraft(null)
        toast(`Sample ${session.seq}-${result.index} re-recorded.`, 'success')
        navigate('/history')
        return
      }

      const result = await saveSample(queryClient, session.id, body)

      // The sample is on record: leave the wizard. The session stays open on
      // the board, and "Continue" starts the next sample from a fresh draft.
      clearDraft(userId, session.id)
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
    if (!draft || !order || saveFlight.running) return
    // A photo still uploading is not on the sample yet; the button says so and waits.
    if (uploads > 0) return
    if (issues.length > 0) {
      goto(issues[0].step)
      toast(issues[0].message, 'error')
      // The quantity is the one thing asked on the review step itself: the cursor goes to it.
      if (issues[0].step === 'review') setFocusQty(true)
      // The connector coil number sits low on Setup, where a phone's Back / Next bar can cover it: the cursor goes to it,
      // and the field is marked, so the field the message names is the one in view.
      if (issues.some((i) => i.ref === 'connectorCoil')) setConnectorRefused(true)
      if (issues[0].ref === 'connectorCoil') setFocusConnector(true)
      return
    }
    // §8.4 — block on a grade mismatch unless these very mismatches were explicitly acknowledged; with none, no
    // acknowledgement goes with the sample.
    const mismatches = findGradeMismatches(order.expectedGrade, draft.coils, gradeIndex)
    const acknowledged = coveringAcknowledgement(draft.gradeAcknowledged, order.expectedGrade, draft.coils, gradeIndex)
    if (mismatches.length > 0 && !acknowledged) {
      setGradePrompt({ mismatches })
      return
    }
    void performSave(acknowledged)
  }

  const StepIcon = STEP_META[current].icon
  const backLabel = draft.editingSampleId ? 'History' : 'Inspections'
  const leave = () => {
    if (draft.editingSampleId) navigate('/history')
    else if (priorSamples.length === 0) setLeaving(true)
    else navigate('/')
  }
  const sampleBadge =
    draft.editingSampleId && editing && session ? (
      <Badge tone="amber">Re-recording sample {session.seq}-{editing.sample.index}</Badge>
    ) : session ? (
      <Badge tone="neutral">Sample {session.seq}-{priorSamples.length + 1}</Badge>
    ) : (
      <Badge tone="violet">New session · opens with this sample</Badge>
    )
  const itemLine = `${order.itemCode}${order.item ? ` · ${order.item}` : ''} · Order ID ${order.lineKey}`
  // A refresh of the session failed (the network dropped): the wizard carries on from what was loaded, and says so quietly.
  const staleBadge = (
    <Badge tone="amber" icon={<CloudOff className="h-3 w-3" />} tip="Showing the session as it was loaded. Your entries are saved on this device.">
      Could not refresh
    </Badge>
  )
  const navHeight = keyboard ? 'min-h-[44px]' : short ? 'min-h-[48px]' : 'min-h-[52px]'

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

      <Modal
        open={leaving}
        onClose={() => setLeaving(false)}
        title="No sample recorded yet"
        icon={<AlertTriangle className="h-5 w-5" />}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setLeaving(false)}>
              Stay
            </Button>
            <Button
              onClick={() => {
                setLeaving(false)
                navigate('/')
              }}
            >
              <span className="sm:hidden">Leave, keep it</span>
              <span className="hidden sm:inline">{session ? 'Leave, keep the session' : 'Leave, keep the entries'}</span>
            </Button>
            <Button
              variant="danger"
              disabled={saving}
              onClick={() =>
                saveFlight.run(async () => {
                  if (!session) {
                    // Nothing exists on the server yet: only the entries on this device go.
                    clearDraft(userId, draftKey)
                    toast('Entries discarded. No session was opened.', 'success')
                    navigate('/')
                    return
                  }
                  setSaving(true)
                  try {
                    await discardSession(queryClient, session.id)
                    clearDraft(userId, session.id)
                    toast('Session discarded. Nothing was recorded in it.', 'success')
                    navigate('/')
                  } catch (e) {
                    toast(e instanceof Error ? e.message : 'Could not discard the session.', 'error')
                  } finally {
                    setSaving(false)
                  }
                })
              }
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

      {/* One slot either way, so the step below keeps its place in the tree — and what was typed into it — when a
          tablet is turned between the two layouts. */}
      {short ? (
        // A wide screen with little height: the way back, the order and the rail fold into one strip that stays in
        // view, so the step's first field is on the first screen.
        <div ref={stickyRef} className={cn(STICKY, '-mx-8 flex items-center gap-3 px-8', keyboard ? 'static' : 'sticky', stuck && STUCK)}>
          <button type="button" onClick={leave} className="icon-btn -ms-2" aria-label={`Back to ${backLabel}`} data-tip={`Back to ${backLabel}`}>
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              {isStockOrder(order) ? <Badge tone="violet">For stock</Badge> : <span className="min-w-0 truncate font-bold">{order.orderNumber}</span>}
              <Badge tone="blue">{machine?.displayName ?? `Machine ${wc}`}</Badge>
              {sampleBadge}
              {!online && (
                <Badge tone="amber" icon={<CloudOff className="h-3 w-3" />} tip="Offline — your work is saved on this device">
                  Offline
                </Badge>
              )}
              {online && loadState === 'stale' && staleBadge}
            </div>
            <p className="mt-0.5 truncate text-xs text-muted">{itemLine}</p>
          </div>
          <StepRail steps={steps} stepIndex={stepIndex} onGo={goto} compact className="max-w-[55%] shrink-0" />
        </div>
      ) : (
        <>
          <button onClick={leave} className="inline-flex min-h-[44px] items-center gap-1.5 text-sm font-semibold text-muted hover:text-brand-600">
            <ArrowLeft className="h-4 w-4" /> {backLabel}
          </button>

          <Card className="p-4">
            <div className="flex flex-wrap items-center gap-2">
              {isStockOrder(order) ? <Badge tone="violet">For stock</Badge> : <span className="font-bold">{order.orderNumber}</span>}
              <Badge tone="blue">{machine?.displayName ?? `Machine ${wc}`}</Badge>
              <Badge tone="neutral">
                Shift {shift} · {shiftName(shift)}
              </Badge>
              {sampleBadge}
              {!online && (
                <Badge tone="amber" icon={<CloudOff className="h-3 w-3" />}>
                  Offline — your work is saved on this device
                </Badge>
              )}
              {online && loadState === 'stale' && staleBadge}
            </div>
            <p className="mt-1 text-sm text-muted">{itemLine}</p>
          </Card>

          {/* The rail stays under the header while a long step scrolls, so another step is a tap away from anywhere. It
              spans the page's side margins, so nothing of the step shows beside it as it passes underneath. */}
          <div ref={stickyRef} className={cn(STICKY, '!mt-2 -mx-4 px-4 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8', keyboard ? 'static' : 'sticky', stuck && STUCK)}>
            <StepRail steps={steps} stepIndex={stepIndex} onGo={goto} />
          </div>
        </>
      )}

      <Card id={STEP_CARD_ID} className={cn('space-y-5 p-4', !short && '!mt-2')}>
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <div className="min-w-0">
            {/* On a phone the rail names only this step; here it says how far along it is. */}
            <p className="text-xs font-semibold uppercase tracking-wide text-muted sm:hidden">
              Step {stepIndex + 1} of {steps.length}
            </p>
            <h2 className="flex items-center gap-2 text-lg font-extrabold">
              <StepIcon className="h-5 w-5 text-brand-600" /> {STEP_META[current].label}
            </h2>
          </div>
          {short && <InstructionChips instructions={instructions} step={current} />}
        </div>

        {current === 'setup' && (
          <SetupStep
            draft={draft}
            order={order}
            update={update}
            shift={shift}
            gradeIndex={gradeIndex}
            instructions={short ? [] : instructions}
            connectorRefused={connectorRefused}
            focusConnector={focusConnector}
            onConnectorFocused={connectorFocused}
            coilRequired={!!machine?.coilRequired}
          />
        )}
        {current !== 'setup' && current !== 'review' && steps.includes('setup') && (
          <SetupSummary draft={draft} onEdit={() => update({ step: 'setup' })} />
        )}
        {current === 'dimensions' && (
          <>
            {!short && <WorkInstructionLinks instructions={instructions} step="dimensions" />}
            <DimensionsStep draft={draft} update={update} order={order} refImages={refImages} typedByInspector={!takesConfiguredDimensions(process, machine)} />
          </>
        )}
        {current === 'defects' && (
          <>
            {!short && <WorkInstructionLinks instructions={instructions} step="defects" />}
            <DefectsStep draft={draft} update={update} options={defectOptions} sessionId={session?.id} orderId={order.id} onUploading={onUploading} />
          </>
        )}
        {current === 'paint' && (
          <>
            {!short && <WorkInstructionLinks instructions={instructions} step="paint" />}
            <PaintStep draft={draft} update={update} sessionId={session?.id} orderId={order.id} onUploading={onUploading} />
          </>
        )}
        {current === 'paintThickness' && (
          <>
            {!short && <WorkInstructionLinks instructions={instructions} step="paintThickness" />}
            <PaintThicknessStep draft={draft} update={update} />
          </>
        )}
        {current === 'pt' && (
          <>
            {!short && <WorkInstructionLinks instructions={instructions} step="pt" />}
            <PTStep draft={draft} update={update} consumables={consumables} sessionId={session?.id} orderId={order.id} short={short} onUploading={onUploading} />
          </>
        )}
        {current === 'review' && (
          <ReviewStep
            draft={draft}
            order={order}
            issues={issues}
            update={update}
            orderNotes={orderNotes}
            sessionId={session?.id}
            orderId={order.id}
            focusQty={focusQty}
            onQtyFocused={() => setFocusQty(false)}
            onUploading={onUploading}
          />
        )}
      </Card>

      {/* Sticky navigation. With the keyboard up it shrinks to a strip just tall enough for a finger, so the field being
          typed in stays in sight above it; on a short landscape screen it is a little lower than on a tall one. */}
      <div ref={setBar} className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 backdrop-blur-md dark:border-slate-800 dark:bg-slate-900/95 safe-bottom">
        <div className={cn('mx-auto flex max-w-5xl items-center gap-2 px-4', keyboard ? 'py-1' : short ? 'py-2' : 'py-3')}>
          <Button variant="secondary" className={cn(navHeight, 'flex-1 sm:flex-none')} disabled={stepIndex === 0} onClick={back}>
            <ArrowLeft className="h-4 w-4" /> Back
          </Button>
          {current === 'review' ? (
            <Button variant="primary" className={cn(navHeight, 'flex-1')} disabled={saving || uploads > 0} onClick={attemptSave}>
              {saving || uploads > 0 ? <Loader2 className="h-5 w-5 animate-spin" /> : <Save className="h-5 w-5" />}
              {saving ? (
                'Saving…'
              ) : uploads > 0 ? (
                // Said on the button itself: a disabled button's tooltip never shows to a finger.
                'Waiting for photos…'
              ) : (
                <>
                  <span className="sm:hidden">Save</span>
                  <span className="hidden sm:inline">Save inspection</span>
                </>
              )}
            </Button>
          ) : (
            <Button variant="primary" className={cn(navHeight, 'flex-1')} onClick={next}>
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
              <Button variant="secondary" disabled={saving} onClick={() => setGradePrompt(null)}>
                Go back and fix
              </Button>
              <Button
                variant="danger"
                disabled={saving}
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
                <span className="sm:hidden">Acknowledge</span>
                <span className="hidden sm:inline">Acknowledge & continue</span>
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

// ---- Layout ----------------------------------------------------------------

/**
 * The steps in order, as chips: done ones green, the open one solid. On a
 * phone — and in the short landscape strip — only the open step keeps its
 * name; the others show their icon and number, so a whole process fits across
 * (the name is the chip's accessible name and its tooltip). The open chip is
 * scrolled to the middle whenever the step changes, and a soft edge says when
 * more chips are off to one side.
 */
function StepRail({
  steps,
  stepIndex,
  onGo,
  compact = false,
  className,
}: {
  steps: WizardStep[]
  stepIndex: number
  onGo: (s: WizardStep) => void
  /** Name only the open step, whatever the width. */
  compact?: boolean
  className?: string
}) {
  const strip = useRef<HTMLDivElement>(null)
  const chips = useRef<(HTMLButtonElement | null)[]>([])
  const edges = useScrollEdges(strip)
  const terse = useMediaQuery(PHONE) || compact
  const centred = useRef(false)

  useEffect(() => {
    const frame = strip.current
    const chip = chips.current[stepIndex]
    if (!frame || !chip) return
    // Only the strip moves, never the page: measured on screen, so it holds in either direction of text.
    const f = frame.getBoundingClientRect()
    const c = chip.getBoundingClientRect()
    const by = c.left + c.width / 2 - (f.left + f.width / 2)
    // The page opens with the open step in view at once; a change of step glides there.
    const glide = centred.current && !matchesMedia('(prefers-reduced-motion: reduce)')
    centred.current = true
    if (Math.abs(by) > 1) frame.scrollBy({ left: by, behavior: glide ? 'smooth' : 'auto' })
  }, [stepIndex, terse])

  return (
    <div className={cn('relative min-w-0', className)}>
      <div ref={strip} className={cn('relative flex overflow-x-auto overscroll-x-contain scrollbar-none', terse ? 'gap-1' : 'gap-2')}>
        {steps.map((s, i) => {
          const meta = STEP_META[s]
          const Icon = meta.icon
          const done = i < stepIndex
          const active = i === stepIndex
          const named = active || !terse
          return (
            <button
              key={s}
              ref={(el) => {
                chips.current[i] = el
              }}
              type="button"
              onClick={() => onGo(s)}
              aria-label={`${meta.label}, step ${i + 1} of ${steps.length}${done ? ', done' : ''}`}
              aria-current={active ? 'step' : undefined}
              data-tip={named ? undefined : meta.label}
              className={cn(
                'flex min-h-[44px] shrink-0 items-center rounded-xl text-sm font-bold transition-colors',
                named ? 'gap-2 px-3.5' : 'min-w-[44px] justify-center gap-1 px-2',
                !terse && 'sm:min-h-[48px]',
                active
                  ? 'bg-brand-600 text-white shadow-sm'
                  : done
                    ? 'bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-400 dark:ring-emerald-500/20'
                    : 'bg-white text-slate-600 ring-1 ring-inset ring-slate-200 dark:bg-slate-900 dark:text-slate-300 dark:ring-slate-700',
              )}
            >
              {done ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <Icon className="h-4 w-4 shrink-0" />}
              {named ? <span className="whitespace-nowrap">{terse ? meta.short : meta.label}</span> : <span className="tabular-nums">{i + 1}</span>}
            </button>
          )
        })}
      </div>
      <EdgeShadows {...edges} />
    </div>
  )
}

/**
 * On a short landscape screen, the step's controlled documents as chips beside
 * its title, where the box of buttons would push the first field off the
 * screen. The viewer is the same.
 */
function InstructionChips({ instructions, step }: { instructions: WorkInstruction[]; step: WizardStep }) {
  const [open, setOpen] = useState<WorkInstruction | null>(null)
  const here = instructions.filter((w) => w.step === step)
  if (here.length === 0) return null
  return (
    <div className="flex min-w-0 flex-wrap justify-end gap-2">
      {here.map((w) => (
        <button
          key={w.id}
          type="button"
          onClick={() => setOpen(w)}
          data-tip={w.title}
          className="inline-flex min-h-[44px] max-w-[20rem] items-center gap-2 rounded-full bg-brand-50 px-3.5 text-sm font-semibold text-brand-800 ring-1 ring-inset ring-brand-200 transition-colors hover:bg-brand-100 dark:bg-brand-500/10 dark:text-brand-100 dark:ring-brand-500/30 dark:hover:bg-brand-500/20"
        >
          <BookOpen className="h-4 w-4 shrink-0" />
          <span className="truncate">{w.title}</span>
          <span className="shrink-0 text-xs font-medium text-muted">{w.code}</span>
        </button>
      ))}
      {open && <WorkInstructionViewer instruction={open} onClose={() => setOpen(null)} />}
    </div>
  )
}

/**
 * Whether the on-screen keyboard is up (wizardHelpers.keyboardLikelyOpen),
 * followed as the visible area changes size and focus moves between fields.
 */
function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const vv = window.visualViewport
    let width = window.innerWidth
    let tallest = window.innerHeight
    let frame = 0
    const check = () => {
      frame = 0
      // A turn, or a window resized sideways, starts over: the tallest is measured again at the new width.
      if (window.innerWidth !== width) {
        width = window.innerWidth
        tallest = window.innerHeight
      }
      tallest = Math.max(tallest, window.innerHeight)
      const focused = document.activeElement as (HTMLElement & { type?: string; readOnly?: boolean }) | null
      setOpen(keyboardLikelyOpen({ visible: vv?.height ?? window.innerHeight, tallest, editing: opensKeyboard(focused), coarse: isCoarsePointer() }))
    }
    // Focus moving from one field to the next passes through the page for an instant: judged a frame later, the bar
    // does not jump between them.
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(check)
    }
    vv?.addEventListener('resize', schedule)
    window.addEventListener('resize', schedule)
    document.addEventListener('focusin', schedule)
    document.addEventListener('focusout', schedule)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      vv?.removeEventListener('resize', schedule)
      window.removeEventListener('resize', schedule)
      document.removeEventListener('focusin', schedule)
      document.removeEventListener('focusout', schedule)
    }
  }, [])
  return open
}

/** Whether a sticky element is stuck now: at its `top`, with the page scrolled under it. */
function useStuck(ref: RefObject<HTMLElement>, layout: string): boolean {
  const [stuck, setStuck] = useState(false)
  useEffect(() => {
    let frame = 0
    const check = () => {
      frame = 0
      const el = ref.current
      const style = el ? getComputedStyle(el) : null
      setStuck(!!el && style?.position === 'sticky' && el.getBoundingClientRect().top <= (parseFloat(style.top) || 0) + 0.5)
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(check)
    }
    check()
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
    }
  }, [ref, layout])
  return stuck
}

/** Room left between a field brought into view and what is fixed over the page. */
const SCROLL_GAP = 8

/**
 * Keeps a field the browser brings into view — on focus, or with the keyboard
 * coming up — clear of what is fixed over the page: the header and the stuck
 * rail above it, the Back / Next bar below. Focus scrolling and scrollIntoView
 * honour the document's scroll padding, so it is set from their measured
 * heights while the wizard is open and put back as it was on leaving. With the
 * keyboard up the rail no longer sticks, and the focused field is brought back
 * into view above the shrunken bar.
 */
function useScrollPadding(sticky: RefObject<HTMLElement>, bar: RefObject<HTMLElement>, layout: string, keyboard: boolean) {
  useEffect(() => {
    const html = document.documentElement
    const before = { top: html.style.scrollPaddingTop, bottom: html.style.scrollPaddingBottom }
    return () => {
      html.style.scrollPaddingTop = before.top
      html.style.scrollPaddingBottom = before.bottom
    }
  }, [])

  useEffect(() => {
    const html = document.documentElement
    const measure = () => {
      const s = sticky.current
      if (!s) return
      // The rail's `top` is the header's height, safe area included (it resolves to pixels even while the rail does
      // not stick); while it sticks, the rail's own height is added.
      const header = parseFloat(getComputedStyle(s).top) || 0
      const top = header + (getComputedStyle(s).position === 'sticky' ? s.offsetHeight : 0)
      html.style.scrollPaddingTop = `${Math.round(top + SCROLL_GAP)}px`
      html.style.scrollPaddingBottom = `${Math.round((bar.current?.offsetHeight ?? 0) + SCROLL_GAP)}px`
    }
    measure()
    const resize = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    if (sticky.current) resize?.observe(sticky.current)
    if (bar.current) resize?.observe(bar.current)
    window.addEventListener('resize', measure)
    return () => {
      resize?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [sticky, bar, layout])

  useEffect(() => {
    if (!keyboard) return
    const frame = requestAnimationFrame(() => (document.activeElement as HTMLElement | null)?.scrollIntoView?.({ block: 'nearest' }))
    return () => cancelAnimationFrame(frame)
  }, [keyboard])
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
  connectorRefused,
  focusConnector,
  onConnectorFocused,
  coilRequired,
}: {
  draft: SampleDraft
  order: ProductionOrder
  update: Updater
  shift: 'A' | 'B' | 'C'
  gradeIndex: Map<string, string>
  instructions: WorkInstruction[]
  /** A save was refused while the connector coil number was blank: the field is marked until it is filled. */
  connectorRefused: boolean
  /** A save was refused for the connector coil number: put the cursor in it. */
  focusConnector: boolean
  onConnectorFocused: () => void
  /** The machine requires the coil this sample was made from (Configuration → Machines). */
  coilRequired: boolean
}) {
  const { toast } = useApp()
  /** The line's drawings to pick from: DWG1 and DWG2 that name one ("(V)", "0" and the like do not). */
  const drawings = useMemo(() => orderDrawings(order), [order])
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
  const connectorMissing = !draft.pt?.connectorCoilNumber?.trim()
  const connectorBad = connectorRefused && connectorMissing
  // The welding wire register's batches (MTC tab) suggested as the batch is typed; any batch may still be typed by hand.
  const wireSearch = useDebounced((draft.pt?.weldingWireBatch ?? '').trim(), 250)
  const { data: wireSuggestions } = useWeldingWireSuggestions(wireSearch, draft.process === 'welding')
  // A refused save lands here for the connector coil number: the cursor goes to it, centred clear of the Back / Next
  // bar. On the next frame, as the wizard first brings a newly opened step's card to the top of the page.
  const connectorRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!focusConnector) return
    const frame = requestAnimationFrame(() => {
      const el = connectorRef.current
      if (el) {
        el.focus({ preventScroll: true })
        el.scrollIntoView({ block: 'center' })
      }
      onConnectorFocused()
    })
    return () => cancelAnimationFrame(frame)
  }, [focusConnector, onConnectorFocused])
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
          <Field label="Drawing" hint={drawings.length === 0 ? 'The order sheet gives no drawing for this line.' : undefined}>
            <Select value={drawings.includes(draft.drawing) ? draft.drawing : ''} onChange={(e) => update({ drawing: e.target.value })} className="min-h-[48px]" disabled={drawings.length === 0}>
              {/* What is shown is what is kept: a drawing the sheet no longer gives (or none yet) reads as not chosen. */}
              {!drawings.includes(draft.drawing) && (
                <option value="" disabled>
                  {drawings.length === 0 ? '—' : 'Choose a drawing…'}
                </option>
              )}
              {drawings.map((d) => (
                <option key={d} value={d}>
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
                list="wizard-welding-wires"
                autoComplete="off"
              />
              <datalist id="wizard-welding-wires">
                {(wireSuggestions?.rows ?? []).map((w) => (
                  <option key={w.id} value={String(w.values.batchNumber ?? '')}>
                    {[w.values.classification, w.values.diameter !== undefined ? `Ø${w.values.diameter}` : undefined, w.values.supplier].filter(Boolean).join(' · ')}
                  </option>
                ))}
              </datalist>
            </div>
          </Field>
          <div className="mt-3">
            <Field label="Connector coil number *" hint="Required. Remembered from the previous sample of this session; change it when a new connector coil goes on.">
              <div className="relative">
                <Cable className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                <input
                  ref={connectorRef}
                  id="wizard-connector-coil"
                  value={draft.pt?.connectorCoilNumber ?? ''}
                  onChange={(e) => update((d) => ({ ...d, pt: { ...(d.pt ?? emptyPT()), connectorCoilNumber: e.target.value } }))}
                  className={cn('input min-h-[48px] pl-9', connectorBad && 'border-rose-400 focus:border-rose-400 focus:ring-rose-400/40 dark:border-rose-400 dark:focus:border-rose-400')}
                  placeholder="e.g. C10021"
                  autoCapitalize="characters"
                  required
                  aria-required="true"
                  aria-invalid={connectorBad || undefined}
                />
              </div>
            </Field>
          </div>
        </div>
      )}

      {!welding && (
      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="label !mb-0">
            Coils{coilRequired && <span className="ms-1 text-rose-600 dark:text-rose-400" aria-hidden>*</span>}
            {coilRequired && <span className="sr-only"> (required)</span>}
          </span>
          <Button variant="secondary" className="min-h-[44px]" onClick={() => setPicking(true)}>
            <Plus className="h-4 w-4" /> Add coil
          </Button>
        </div>
        {draft.coils.length === 0 ? (
          <p
            className={cn(
              'rounded-xl border border-dashed py-4 text-center text-sm',
              coilRequired ? 'border-rose-300 text-rose-700 dark:border-rose-500/40 dark:text-rose-300' : 'border-slate-200 text-muted dark:border-slate-700',
            )}
          >
            {coilRequired ? 'Required on this machine: add the coil this sample was made from.' : 'No coils added. Optional on this machine.'}
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
 * What Setup holds, shown above the later steps: the drawing, and the coils
 * running now — or, on a welding machine, which records the wire and not the
 * coil, the wire batch and the connector coil (required, so a blank one is
 * seen before Save is refused for it). A second coil often goes on mid-session, so adding one
 * is a tap away without hunting for the Setup step on the rail. On a phone the
 * button is an icon at the end of the line, so the summary stays one short
 * strip instead of a box with a button wrapped under it.
 */
function SetupSummary({ draft, onEdit }: { draft: SampleDraft; onEdit: () => void }) {
  const welding = draft.process === 'welding'
  const coils = draft.coils.map((c) => c.coilNumber).filter(Boolean)
  const wire = draft.pt?.weldingWireBatch?.trim() ?? ''
  const connector = draft.pt?.connectorCoilNumber?.trim() ?? ''
  const action = welding ? 'Change setup' : coils.length === 0 ? 'Add coil' : 'Add coil / change setup'
  const ActionIcon = welding ? Pencil : Plus
  const phone = useMediaQuery(PHONE)
  return (
    <div className="flex items-center gap-2 rounded-xl bg-slate-50 py-1 pe-1 ps-3 text-sm dark:bg-slate-800/50">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 py-1">
        <span className="text-xs font-bold uppercase tracking-wide text-muted">Setup</span>
        {draft.drawing && (
          <span className="min-w-0 break-words">
            <span className="text-muted">Drawing</span> <span className="font-semibold">{draft.drawing}</span>
          </span>
        )}
        {welding ? (
          // Both carried from the previous sample, so usually there; amber only when one is not.
          <>
            <span className="min-w-0 break-words">
              <span className="text-muted">Wire batch</span>{' '}
              {wire ? <span className="font-mono text-xs font-semibold">{wire}</span> : <span className="font-semibold text-amber-600 dark:text-amber-400">not set</span>}
            </span>
            <span className="min-w-0 break-words">
              <span className="text-muted">Connector coil</span>{' '}
              {connector ? <span className="font-mono text-xs font-semibold">{connector}</span> : <span className="font-semibold text-amber-600 dark:text-amber-400">not set</span>}
            </span>
          </>
        ) : (
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
        )}
      </div>
      <Button variant="ghost" className="min-h-[44px] shrink-0 max-sm:w-11 max-sm:px-0" onClick={onEdit} data-tip={phone ? action : undefined}>
        <ActionIcon className="h-4 w-4" />
        <span className="max-sm:sr-only">{action}</span>
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

  // A row the inspector added goes at once, with an Undo where it stood. A configured row is part of what this item
  // is checked for, so leaving it out of the sample is asked first, and is then final.
  const undo = useUndo<DraftDimension>()
  const [confirming, setConfirming] = useState<{ row: DraftDimension; index: number } | null>(null)
  const dropRow = (index: number) => update((d) => ({ ...d, dimensions: d.dimensions.filter((_, j) => j !== index) }))
  const removeRow = (index: number) => {
    const row = draft.dimensions[index]
    if (!row) return
    if (row.source === 'item-order') {
      setConfirming({ row, index })
      return
    }
    dropRow(index)
    undo.offer(
      <>
        <bdi>{row.name}</bdi> removed
      </>,
      row,
      index,
    )
  }
  const putBack = () => {
    const r = undo.removed
    if (!r) return
    undo.clear()
    update((d) => ({ ...d, dimensions: insertAt(d.dimensions, r.item, r.index) }))
  }
  const strip = (key: string) => (undo.removed ? <UndoStrip key={`${key}-${undo.removed.id}`} label={undo.removed.label} onUndo={putBack} /> : null)

  // The approved photo of the item sits next to the measurements, so the
  // inspector compares the part in front of them while measuring it — drawn
  // large, to be compared at arm's length.
  const reference =
    refImages.length > 0 ? (
      <div>
        <span className="label">Reference photos for {order.itemCode}</span>
        <ImagePicker imageIds={refImages.map((r) => r.imageId)} onChange={() => {}} readOnly size="lg" />
      </div>
    ) : null

  const confirm = (
    <Modal
      open={confirming !== null}
      onClose={() => setConfirming(null)}
      title="Leave this dimension out?"
      icon={<Ruler className="h-5 w-5" />}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={() => setConfirming(null)}>
            Keep it
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              if (confirming) dropRow(confirming.index)
              setConfirming(null)
            }}
          >
            Leave it out
          </Button>
        </>
      }
    >
      <p className="text-sm text-slate-600 dark:text-slate-300">
        <bdi className="font-semibold text-slate-900 dark:text-white">{confirming?.row.name}</bdi> is set up for {order.itemCode} on this machine. Left out, it
        is not measured on this sample and is not saved with it.
      </p>
    </Modal>
  )

  if (draft.dimensions.length === 0) {
    return (
      <div className="space-y-3">
        {reference}
        {strip('empty')}
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
        {confirm}
      </div>
    )
  }

  // As the server will store it: a blank figure is Pending, and one that is not a number is never a pass.
  const statusOf = previewStatus
  /** A figure typed as the phone's keypad gives it (a comma, Arabic digits) is kept as the number it is. */
  const setFigure = (i: number, field: FigureField, text: string) => setRow(i, { [field]: normaliseDecimal(text) })
  /** The red edge a box takes when what is in it is not a number. */
  const badEdge = (text: string) => (isDecimalOrBlank(text) ? '' : '!border-rose-500 focus:!ring-rose-400/40')
  /** What the row's verdict says: its status, or that a figure in it cannot be read. */
  const verdict = (d: DraftDimension) =>
    hasBadFigure(dimensionFigures(d)) ? (
      <Badge tone="red" tip="A figure in this row is not a number. Type digits only, e.g. 12.5.">
        Not a number
      </Badge>
    ) : (
      <Badge tone={resultTone(statusOf(d))}>{statusOf(d)}</Badge>
    )

  /** The phone card: one per dimension, with the measurement the inspector types made the biggest thing on it. */
  const cards = draft.dimensions.map((d, i) => {
    const status = statusOf(d)
    const unreadable = unreadableFigures(d)
    const nominal = (
      <label className="block">
        <span className="label">Nominal</span>
        <input
          value={d.nominal}
          onChange={(e) => setFigure(i, 'nominal', e.target.value)}
          inputMode="decimal"
          autoComplete="off"
          aria-invalid={!isDecimalOrBlank(d.nominal) || undefined}
          className={cn('input min-h-[48px] text-right tabular-nums', badEdge(d.nominal))}
        />
      </label>
    )
    const actual = (
      <label className="block">
        <span className="label">Actual</span>
        <input
          value={d.actual}
          onChange={(e) => setFigure(i, 'actual', e.target.value)}
          inputMode="decimal"
          autoComplete="off"
          placeholder="—"
          aria-invalid={!isDecimalOrBlank(d.actual) || undefined}
          className={cn(
            'input min-h-[52px] text-center text-lg font-bold tabular-nums',
            status === 'Fail' ? 'border-rose-400' : status === 'Warning' ? 'border-amber-400' : '',
            badEdge(d.actual),
          )}
        />
      </label>
    )
    return (
      <div
        key={`${d.name}-${i}`}
        className={cn(
          'rounded-2xl border p-3',
          status === 'Fail' || unreadable.length > 0
            ? 'border-rose-300 bg-rose-50/60 dark:border-rose-500/40 dark:bg-rose-500/5'
            : status === 'Warning'
              ? 'border-amber-300 bg-amber-50/60 dark:border-amber-500/40 dark:bg-amber-500/5'
              : 'border-slate-200 dark:border-slate-700',
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <p dir="auto" className="min-w-0 break-words font-bold">
            {d.name}
          </p>
          <span className="flex shrink-0 items-center gap-1">
            {verdict(d)}
            <button type="button" onClick={() => removeRow(i)} className={cn(REMOVE, '-my-2 -me-2')} aria-label={`Remove ${d.name}`}>
              <Trash2 className="h-4 w-4" />
            </button>
          </span>
        </div>
        {d.source === 'item-order' ? (
          <div className="mt-2 grid grid-cols-[1fr_auto_1.4fr] items-end gap-2">
            {nominal}
            <span className="pb-3 text-xs tabular-nums text-muted">
              +{d.tolPlus}/-{d.tolMinus}
            </span>
            {actual}
          </div>
        ) : (
          <>
            <div className="mt-2 grid grid-cols-[1fr_1.4fr] items-end gap-2">
              {nominal}
              {actual}
            </div>
            {/* Typed once, and they set Pass or Fail for every later sample: each with its own label, which stays
                when a value is in the box. */}
            <div className="mt-2 grid grid-cols-2 gap-2">
              <label className="block">
                <span className="label">+ tolerance</span>
                <input
                  value={d.tolPlus}
                  onChange={(e) => setFigure(i, 'tolPlus', e.target.value)}
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="0"
                  aria-invalid={!isDecimalOrBlank(d.tolPlus) || undefined}
                  className={cn('input min-h-[44px] text-right tabular-nums', badEdge(d.tolPlus))}
                />
              </label>
              <label className="block">
                <span className="label">− tolerance</span>
                <input
                  value={d.tolMinus}
                  onChange={(e) => setFigure(i, 'tolMinus', e.target.value)}
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder={d.tolPlus || '0'}
                  aria-invalid={!isDecimalOrBlank(d.tolMinus) || undefined}
                  className={cn('input min-h-[44px] text-right tabular-nums', badEdge(d.tolMinus))}
                />
              </label>
            </div>
          </>
        )}
        {unreadable.length > 0 && <BadFigureNote named={unreadable.map((f) => FIGURE_LABEL[f])} />}
      </div>
    )
  })

  const rows = draft.dimensions.map((d, i) => {
    const status = statusOf(d)
    const unreadable = unreadableFigures(d)
    return (
      <tr
        key={`${d.name}-${i}`}
        className={cn(
          (status === 'Fail' || unreadable.length > 0) && 'bg-rose-50/60 dark:bg-rose-500/5',
          status === 'Warning' && 'bg-amber-50/60 dark:bg-amber-500/5',
        )}
      >
        {/* Arabic keeps its own word order and wrapping; the column keeps its header's alignment. */}
        <td dir="auto" className="px-2 py-2 text-left font-semibold">
          {d.name}
          {unreadable.length > 0 && <BadFigureNote named={unreadable.map((f) => FIGURE_LABEL[f])} />}
        </td>
        <td className="px-2 py-2 text-right tabular-nums">
          <input
            value={d.nominal}
            onChange={(e) => setFigure(i, 'nominal', e.target.value)}
            inputMode="decimal"
            autoComplete="off"
            aria-label="Nominal"
            aria-invalid={!isDecimalOrBlank(d.nominal) || undefined}
            className={cn('input-cell w-20 px-2 py-2 text-right touch:min-h-[44px]', badEdge(d.nominal))}
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
              <input
                value={d.tolPlus}
                onChange={(e) => setFigure(i, 'tolPlus', e.target.value)}
                inputMode="decimal"
                autoComplete="off"
                aria-label="Plus tolerance"
                aria-invalid={!isDecimalOrBlank(d.tolPlus) || undefined}
                className={cn('input-cell w-14 px-1.5 py-2 text-right text-sm touch:min-h-[44px]', badEdge(d.tolPlus))}
              />
              / -
              <input
                value={d.tolMinus}
                onChange={(e) => setFigure(i, 'tolMinus', e.target.value)}
                inputMode="decimal"
                autoComplete="off"
                aria-label="Minus tolerance"
                aria-invalid={!isDecimalOrBlank(d.tolMinus) || undefined}
                className={cn('input-cell w-14 px-1.5 py-2 text-right text-sm touch:min-h-[44px]', badEdge(d.tolMinus))}
              />
            </span>
          )}
        </td>
        <td className="px-2 py-2 text-center">
          <input
            value={d.actual}
            onChange={(e) => setFigure(i, 'actual', e.target.value)}
            inputMode="decimal"
            autoComplete="off"
            placeholder="—"
            aria-label="Actual"
            aria-invalid={!isDecimalOrBlank(d.actual) || undefined}
            className={cn(
              'input-cell w-24 px-2 py-3 text-center text-base font-semibold',
              status === 'Fail' ? 'border-rose-400 focus:ring-rose-400/40 dark:border-rose-400' : status === 'Warning' ? 'border-amber-400 focus:ring-amber-400/40 dark:border-amber-400' : '',
              badEdge(d.actual),
            )}
          />
        </td>
        <td className="px-2 py-2 text-center">{verdict(d)}</td>
        <td className="px-1 py-1">
          <button type="button" onClick={() => removeRow(i)} className={REMOVE} aria-label={`Remove ${d.name}`}>
            <Trash2 className="h-4 w-4" />
          </button>
        </td>
      </tr>
    )
  })

  return (
    <div className="space-y-3">
      {reference}
      {/* A phone has no room for a six-column table: one card per dimension. */}
      <div className="space-y-2 sm:hidden">{undo.removed ? insertAt(cards, strip('card'), undo.removed.index) : cards}</div>
      <div className="relative hidden overflow-x-auto sm:block">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="text-xs uppercase text-muted">
            <tr>
              <th className="px-2 py-2 text-left font-semibold">Dimension</th>
              <th className="px-2 py-2 text-right font-semibold">Nominal</th>
              <th className="px-2 py-2 text-center font-semibold">Tol ±</th>
              <th className="px-2 py-2 text-center font-semibold">Actual</th>
              <th className="px-2 py-2 text-center font-semibold">Status</th>
              <th>
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {undo.removed
              ? insertAt(
                  rows,
                  <tr key={`undo-${undo.removed.id}`}>
                    <td colSpan={6} className="px-1 py-1.5">
                      {strip('row')}
                    </td>
                  </tr>,
                  undo.removed.index,
                )
              : rows}
          </tbody>
        </table>
      </div>
      <AddDimensionButton update={update} label={typedByInspector ? 'Add a dimension' : undefined} />
      {confirm}
    </div>
  )
}

/** A dimension's figures the inspector types. */
type FigureField = 'nominal' | 'tolPlus' | 'tolMinus' | 'actual'
const FIGURE_LABEL: Record<FigureField, string> = { nominal: 'Nominal', tolPlus: '+ tolerance', tolMinus: '− tolerance', actual: 'Actual' }

/** The figures of a row typed but not a number — a unit typed after it, a stray letter. */
function unreadableFigures(d: DraftDimension): FigureField[] {
  return (['nominal', 'tolPlus', 'tolMinus', 'actual'] as const).filter((f) => !isDecimalOrBlank(d[f]))
}

/** Said under a row whose figure cannot be read: which one, and what to type instead. The save is refused until it is. */
function BadFigureNote({ named }: { named: string[] }) {
  const subject = named.length === 1 ? `${named[0]} is not a number` : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1].toLowerCase()} are not numbers`
  return (
    <p className="mt-2 flex items-start gap-1.5 text-xs font-semibold text-rose-600 dark:text-rose-400">
      <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
      {subject}. Type digits only, e.g. 12.5.
    </p>
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
  const parsedNominal = parseDecimal(nominal)
  const valid = name.trim() !== '' && parsedNominal !== null && Number.isFinite(parsedNominal) && isDecimalOrBlank(tolPlus) && isDecimalOrBlank(tolMinus)

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
          <Input value={nominal} onChange={(e) => setNominal(normaliseDecimal(e.target.value))} inputMode="decimal" autoComplete="off" aria-invalid={!isDecimalOrBlank(nominal) || undefined} className={cn('min-h-[48px] text-right tabular-nums', !isDecimalOrBlank(nominal) && '!border-rose-500')} />
        </label>
        <label className="block">
          <span className="label">+ tol</span>
          <Input value={tolPlus} onChange={(e) => setTolPlus(normaliseDecimal(e.target.value))} inputMode="decimal" autoComplete="off" placeholder="0" aria-invalid={!isDecimalOrBlank(tolPlus) || undefined} className={cn('min-h-[48px] text-right tabular-nums', !isDecimalOrBlank(tolPlus) && '!border-rose-500')} />
        </label>
        <label className="block">
          <span className="label">- tol</span>
          <Input value={tolMinus} onChange={(e) => setTolMinus(normaliseDecimal(e.target.value))} inputMode="decimal" autoComplete="off" placeholder={tolPlus || '0'} aria-invalid={!isDecimalOrBlank(tolMinus) || undefined} className={cn('min-h-[48px] text-right tabular-nums', !isDecimalOrBlank(tolMinus) && '!border-rose-500')} />
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
  onUploading,
}: {
  draft: SampleDraft
  update: Updater
  options: string[]
  sessionId?: string
  orderId: string
  onUploading: (uploading: boolean) => void
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
  // A defect goes at once — its photos and notes with it — and can be taken back from where it stood for a few seconds.
  const undo = useUndo<DraftDefect>()
  const removeDefect = (key: string) => {
    const index = draft.defects.findIndex((x) => x.key === key)
    const gone = draft.defects[index]
    if (!gone) return
    update((d) => ({ ...d, defects: d.defects.filter((x) => x.key !== key) }))
    undo.offer(
      <>
        <bdi>{gone.defectName}</bdi> removed
      </>,
      gone,
      index,
    )
  }
  const putBack = () => {
    const r = undo.removed
    if (!r) return
    undo.clear()
    update((d) => (d.defects.some((x) => x.key === r.item.key) ? d : { ...d, defects: insertAt(d.defects, r.item, r.index) }))
  }
  const strip = undo.removed ? <UndoStrip key={`undo-${undo.removed.id}`} label={undo.removed.label} onUndo={putBack} /> : null

  const cards = draft.defects.map((d) => (
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
        <p dir="auto" className="flex min-w-0 flex-wrap items-center gap-2 break-words font-bold">
          {d.defectName}
          {isOtherDefect(d.defectName) && <Badge tone="amber">describe it</Badge>}
        </p>
        <button type="button" onClick={() => removeDefect(d.key)} className={cn(REMOVE, '-my-1.5 -me-1.5')} aria-label={`Remove defect ${d.defectName}`}>
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
          // Applied to the defect as it is when the upload lands, not as it was when the photo was taken.
          onChange={(edit) => update((dd) => ({ ...dd, defects: dd.defects.map((x) => (x.key === d.key ? { ...x, imageIds: edit(x.imageIds) } : x)) }))}
          onUploading={onUploading}
          sessionId={sessionId}
          orderId={orderId}
        />
      </div>
    </div>
  ))

  return (
    <div className="space-y-4">
      <div>
        <span className="label">Add a defect</span>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={options.length === 0 ? 'Type the defect name…' : 'Search or type a defect…'}
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
          {/* The plus is drawn outside the name, so it leads every chip the same way whether the name is English or
              Arabic; the name keeps its own direction inside a <bdi>. */}
          {typed && !options.some((o) => o.trim().toLowerCase() === typed.toLowerCase()) && (
            <button
              type="button"
              onClick={() => {
                addDefect(typed)
                setSearch('')
              }}
              className="inline-flex min-h-[44px] max-w-full items-center gap-1 rounded-xl bg-brand-600 px-3 text-sm font-semibold text-white shadow-sm hover:bg-brand-700"
            >
              <Plus className="h-4 w-4 shrink-0" />
              <span className="min-w-0 break-words">
                Add “<bdi dir="auto">{typed}</bdi>”
              </span>
            </button>
          )}
          {filtered.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => addDefect(name)}
              className="inline-flex min-h-[44px] max-w-full items-center gap-1 rounded-xl bg-slate-100 px-3 text-sm font-semibold hover:bg-brand-100 hover:text-brand-700 dark:bg-slate-800 dark:hover:bg-brand-500/20"
            >
              <Plus className="h-4 w-4 shrink-0" />
              <bdi dir="auto" className="min-w-0 break-words">
                {name}
              </bdi>
            </button>
          ))}
          {/* Anything the list does not name is recorded as "Other" and must be described. */}
          <button
            type="button"
            onClick={() => addDefect(OTHER_DEFECT_NAME)}
            className="inline-flex min-h-[44px] items-center gap-1 rounded-xl border border-dashed border-amber-400 bg-amber-50 px-3 text-sm font-semibold text-amber-800 hover:bg-amber-100 dark:bg-amber-500/10 dark:text-amber-200 dark:hover:bg-amber-500/20"
          >
            <Plus className="h-4 w-4 shrink-0" /> Other (not in the list)
          </button>
        </div>
      </div>

      {draft.defects.length === 0 ? (
        <>
          {strip}
          <EmptyState icon={<AlertTriangle className="h-10 w-10" />} title="No defects recorded" hint="Pick one above if you found any." />
        </>
      ) : (
        <div className="space-y-3">
          {undo.removed ? insertAt(cards, strip, undo.removed.index) : cards}
        </div>
      )}
    </div>
  )
}

/** The draft that re-records an existing sample: every row as it stands, ready to be changed. */
function draftFromSample(detail: SampleDetail, userId: string, sessionId: string, workCenterCode: string, process: Process): SampleDraft {
  const { sample, dimensions, defects, coils, paint, pt } = detail
  const str = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(v))
  return {
    userId,
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
            connectorCoilNumber: pt?.connectorCoilNumber ?? '',
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
  return { consumableLots: {}, weldingWireBatch: '', connectorCoilNumber: '', testedLengths: [], imageIds: [] }
}

function PaintStep({
  draft,
  update,
  sessionId,
  orderId,
  onUploading,
}: {
  draft: SampleDraft
  update: Updater
  sessionId?: string
  orderId: string
  onUploading: (uploading: boolean) => void
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
          onChange={(edit) => update((d) => ({ ...d, paint: { ...d.paint, imageIds: edit(d.paint.imageIds) } }))}
          onUploading={onUploading}
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
  /** Readings numbered 1, 2, 3… again in the order they stand. */
  const renumber = (dimensions: DraftDimension[]) => {
    let seq = 0
    return dimensions.map((d) => (isPaintThicknessName(d.name) ? { ...d, sequence: ++seq } : d))
  }
  // An extra reading goes at once and can be taken back for a few seconds, from where it stood.
  const undo = useUndo<DraftDimension>()
  // Each card is the label of its reading's box, named outright: a card that also holds a remove button would
  // otherwise label that button, the first control in it, and a tap on "Reading 4" would remove the reading.
  const idBase = useId()
  const removeFrom = (index: number, n: number) => {
    const gone = draft.dimensions[index]
    if (!gone) return
    update((dd) => ({ ...dd, dimensions: renumber(dd.dimensions.filter((_, i) => i !== index)) }))
    undo.offer(`Reading ${n + 1} removed`, gone, index)
  }
  const putBack = () => {
    const r = undo.removed
    if (!r) return
    undo.clear()
    update((dd) => ({ ...dd, dimensions: renumber(insertAt(dd.dimensions, r.item, r.index)) }))
  }

  if (readings.length === 0) return <Empty>No thickness readings on this draft.</Empty>

  const cards = readings.map(({ d, i }, n) => {
    const filled = d.actual.trim() !== ''
    const required = n < PAINT_THICKNESS_READINGS
    const badge = filled ? <Badge tone="green">Recorded</Badge> : required ? <Badge tone="neutral">Required</Badge> : <Badge tone="neutral">Optional</Badge>
    return (
      <label key={i} htmlFor={`${idBase}-${i}`} className={cn('relative block rounded-2xl border p-3', filled ? 'border-emerald-300 bg-emerald-50/40 dark:border-emerald-500/40 dark:bg-emerald-500/5' : 'border-slate-200 dark:border-slate-700')}>
        <span className="flex min-h-[28px] items-center justify-between gap-2">
          <span className="text-sm font-bold">Reading {n + 1}</span>
          <span className="flex items-center gap-1">
            <span className="hidden sm:inline-flex">{badge}</span>
            {!required && (
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault()
                  removeFrom(i, n)
                }}
                className={cn(REMOVE, '-my-2 -me-2')}
                aria-label={`Remove reading ${n + 1}`}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </span>
        </span>
        <input
          id={`${idBase}-${i}`}
          value={d.actual}
          onChange={(e) => setActual(i, normaliseDecimal(e.target.value))}
          inputMode="decimal"
          autoComplete="off"
          placeholder="—"
          aria-invalid={!isDecimalOrBlank(d.actual) || undefined}
          className={cn('input mt-2 min-h-[52px] text-center text-xl font-bold tabular-nums', !isDecimalOrBlank(d.actual) && '!border-rose-500')}
        />
        {!isDecimalOrBlank(d.actual) && <BadFigureNote named={['The reading']} />}
        {/* Two readings share a phone's row: the state goes under the number, where the card has room for it. */}
        <span className="mt-2 flex sm:hidden">{badge}</span>
      </label>
    )
  })
  // The strip takes a whole row where the reading stood: before the first reading that came after it.
  const stripAt = undo.removed ? readings.findIndex(({ i }) => i >= undo.removed!.index) : -1

  return (
    <div className="space-y-4">
      <div>
        <span className="label">
          Thickness readings <span className="normal-case">({unit})</span>
        </span>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {undo.removed
            ? insertAt(
                cards,
                <div key={`undo-${undo.removed.id}`} className="col-span-full">
                  <UndoStrip label={undo.removed.label} onUndo={putBack} />
                </div>,
                stripAt < 0 ? cards.length : stripAt,
              )
            : cards}
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
  short,
  onUploading,
}: {
  draft: SampleDraft
  update: Updater
  consumables: PTConsumableProduct[]
  sessionId?: string
  orderId: string
  /** A short landscape screen: the explanation folds to one line, so the materials are on the first screen. */
  short: boolean
  onUploading: (uploading: boolean) => void
}) {
  const pt = draft.pt ?? emptyPT()
  const setPT = (patch: Partial<DraftPT>) => update((d) => ({ ...d, pt: { ...(d.pt ?? emptyPT()), ...patch } }))
  // What is saved is what counts: a blank row neither adds to the count nor holds the verdict at "pending".
  const kept = keptLengths(pt.testedLengths).kept
  const testedHere = kept.length
  const setLength = (key: string, patch: Partial<DraftPT['testedLengths'][number]>) =>
    setPT({ testedLengths: pt.testedLengths.map((l) => (l.key === key ? { ...l, ...patch } : l)) })
  const overall = ptOverallVerdict(kept.map((l) => ({ verdict: l.verdict })))

  // A length goes at once, at every width; one with something in it can be taken back for a few seconds. A blank
  // row needs no Undo — and is not saved anyway.
  const undo = useUndo<DraftPT['testedLengths'][number]>()
  const removeLength = (key: string, n: number) => {
    const index = pt.testedLengths.findIndex((l) => l.key === key)
    const gone = pt.testedLengths[index]
    if (!gone) return
    update((d) => {
      const cur = d.pt ?? emptyPT()
      return { ...d, pt: { ...cur, testedLengths: cur.testedLengths.filter((l) => l.key !== key) } }
    })
    if (isBlankLength(gone)) undo.clear()
    else undo.offer(`Length ${n + 1}${gone.lengthMm.trim() ? ` (${gone.lengthMm.trim()} mm)` : ''} removed`, gone, index)
  }
  const putBack = () => {
    const r = undo.removed
    if (!r) return
    undo.clear()
    update((d) => {
      const cur = d.pt ?? emptyPT()
      if (cur.testedLengths.some((l) => l.key === r.item.key)) return d
      return { ...d, pt: { ...cur, testedLengths: insertAt(cur.testedLengths, r.item, r.index) } }
    })
  }

  // The requirement is worked out, not typed: 5% of the final quantity, rounded up, once the session closes.
  const coverTitle = `PT covers ${PT_MIN_TEST_FREQUENCY_PCT}% of the session's production`
  const coverText = (
    <>
      The required count is {PT_MIN_TEST_FREQUENCY_PCT}% of the final quantity, rounded up to a whole piece, and is worked out when the session is closed.
      Every tested length recorded here counts toward it{testedHere > 0 ? ` — ${testedHere} in this sample so far` : ''}.
    </>
  )

  const rows = pt.testedLengths.map((l, n) => {
    const length = parseDecimal(l.lengthMm)
    const bad = length !== null && !(length > 0)
    return (
      // On a phone the remove button takes the free cell beside the length, so the verdict keeps a whole row; from
      // sm everything is one row.
      <div key={l.key} className="grid grid-cols-[auto_1fr_auto] items-center gap-2 rounded-2xl border border-slate-200 p-2.5 dark:border-slate-700 sm:grid-cols-[auto_1fr_auto_auto]">
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-slate-100 text-sm font-bold text-slate-600 dark:bg-slate-800 dark:text-slate-300">{n + 1}</span>
        <label className="block">
          <span className="sr-only">Length {n + 1} in mm</span>
          <div className="relative">
            <input
              value={l.lengthMm}
              onChange={(e) => setLength(l.key, { lengthMm: normaliseDecimal(e.target.value) })}
              inputMode="decimal"
              autoComplete="off"
              placeholder="Length"
              aria-invalid={bad || undefined}
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
                'min-h-[40px] flex-1 whitespace-nowrap rounded-lg px-3 text-sm font-semibold transition-colors touch:min-h-[44px]',
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
          onClick={() => removeLength(l.key, n)}
          className={cn(REMOVE, 'max-sm:col-start-3 max-sm:row-start-1')}
          aria-label={`Remove length ${n + 1}`}
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    )
  })

  return (
    <div className="space-y-4">
      {short ? (
        <details className="group rounded-2xl border-l-4 border-l-brand-500 bg-brand-50/60 text-sm text-brand-900 dark:bg-brand-500/10 dark:text-brand-100">
          <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-2 rounded-e-2xl px-3 font-bold focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 [&::-webkit-details-marker]:hidden">
            <span className="min-w-0 flex-1 truncate">
              {coverTitle}
              {testedHere > 0 && <span className="font-normal"> · {testedHere} tested in this sample</span>}
            </span>
            <ChevronDown className="h-4 w-4 shrink-0 transition-transform group-open:rotate-180" />
          </summary>
          <p className="px-3 pb-3">{coverText}</p>
        </details>
      ) : (
        <div className="rounded-2xl border-l-4 border-l-brand-500 bg-brand-50/60 p-3 text-sm text-brand-900 dark:bg-brand-500/10 dark:text-brand-100">
          <p className="font-bold">{coverTitle}</p>
          <p>{coverText}</p>
        </div>
      )}

      <div>
        <span className="label">PT materials — lot / batch is mandatory</span>
        {/* One under another until a large screen: three across, a tablet's selects cut off the lot — the very thing
            asked for. The lot leads each option, so a narrow select drops the product name, and the one chosen is
            written out in full under it. */}
        <div className="grid gap-2 lg:grid-cols-3">
          {CONSUMABLE_KINDS.map((kind) => {
            const opts = consumables.filter((c) => c.kind === kind)
            const value = pt.consumableLots[kind] ?? ''
            const chosen = value ? opts.find((o) => o.lotBatch === value) : undefined
            return (
              <Field key={kind} label={kind} hint={chosen ? `Lot ${chosen.lotBatch} · ${chosen.productName}` : undefined}>
                <Select
                  value={value}
                  onChange={(e) => setPT({ consumableLots: { ...pt.consumableLots, [kind]: e.target.value } })}
                  className={cn('min-h-[48px]', !value && 'border-rose-400')}
                >
                  <option value="">— choose lot —</option>
                  {opts.map((o) => (
                    <option key={o.id} value={o.lotBatch}>
                      {o.lotBatch} · {o.productName}
                    </option>
                  ))}
                </Select>
              </Field>
            )
          })}
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="label !mb-0">
            Tested weld lengths {pt.testedLengths.length === 0 && <span className="text-rose-500">· at least one</span>}
          </span>
          <Button
            variant="secondary"
            className="min-h-[44px] shrink-0"
            onClick={() => setPT({ testedLengths: [...pt.testedLengths, { key: uid(), lengthMm: '' }] })}
          >
            <Plus className="h-4 w-4" /> Add length
          </Button>
        </div>
        {pt.testedLengths.length === 0 ? (
          <>
            {undo.removed && (
              <div className="mb-2">
                <UndoStrip key={undo.removed.id} label={undo.removed.label} onUndo={putBack} />
              </div>
            )}
            <p className="rounded-xl border border-dashed border-slate-200 py-4 text-center text-sm text-muted dark:border-slate-700">
              Add each weld length you tested and give it a verdict.
            </p>
          </>
        ) : (
          <div className="space-y-2">
            {undo.removed ? insertAt(rows, <UndoStrip key={`undo-${undo.removed.id}`} label={undo.removed.label} onUndo={putBack} />, undo.removed.index) : rows}
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
        <ImagePicker
          imageIds={pt.imageIds}
          onChange={(edit) => update((d) => ({ ...d, pt: { ...(d.pt ?? emptyPT()), imageIds: edit(d.pt?.imageIds ?? []) } }))}
          onUploading={onUploading}
          sessionId={sessionId}
          orderId={orderId}
        />
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
  focusQty,
  onQtyFocused,
  onUploading,
}: {
  draft: SampleDraft
  order: ProductionOrder
  issues: { step: WizardStep; message: string }[]
  update: Updater
  /** Every note written about this order so far, newest first. */
  orderNotes: SessionNote[]
  sessionId?: string
  orderId: string
  /** A save was refused for the quantity: put the cursor in it. */
  focusQty: boolean
  onQtyFocused: () => void
  onUploading: (uploading: boolean) => void
}) {
  const measured = draft.dimensions.filter((d) => d.actual.trim() !== '')
  const qty = Number(draft.sampleQty)
  const qtyBad = !(draft.sampleQty.trim() !== '' && qty > 0)
  const note: DraftNote = draft.note ?? { text: '', imageIds: [] }
  const setNote = (patch: Partial<DraftNote>) => update((d) => ({ ...d, note: { ...(d.note ?? { text: '', imageIds: [] }), ...patch } }))
  const lengths = draft.pt ? keptLengths(draft.pt.testedLengths).kept : []

  // The quantity is typed last, so a mouse finds the cursor in it. A touch screen opens the review to be read — the
  // keyboard would cover it and the Save bar — and the box waits for a tap, unless a save was refused for it.
  const qtyRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!focusQty) return
    const el = qtyRef.current
    if (el) {
      el.focus({ preventScroll: true })
      el.scrollIntoView({ block: 'center' })
    }
    onQtyFocused()
  }, [focusQty, onQtyFocused])

  const spec = (d: DraftDimension) => (d.nominal.trim() === '' ? '— (no nominal)' : `${d.nominal} +${d.tolPlus || 0}/-${d.tolMinus || 0}`)
  // As the server will store it: a blank nominal or tolerance is Pending, not a Fail against 0.
  const statusOf = previewStatus

  return (
    <div className="space-y-4">
      {/* §5.7 — the quantity actually taken is known only once the inspection is done. */}
      <Field label="Sample quantity taken" hint="How many pieces this inspection covered.">
        <input
          ref={qtyRef}
          autoFocus={!isCoarsePointer()}
          type="number"
          inputMode="numeric"
          min={1}
          value={draft.sampleQty}
          onChange={(e) => update({ sampleQty: e.target.value })}
          placeholder="e.g. 5"
          className={cn('input min-h-[52px] text-lg', qtyBad && 'border-rose-400')}
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
          {draft.process === 'welding' && <Row label="Connector coil number" value={draft.pt?.connectorCoilNumber?.trim() || '—'} />}
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
          <>
            {/* A phone: one entry per dimension, the verdict beside the name and the figures in full under it. */}
            <ul className="space-y-1.5 text-sm sm:hidden">
              {measured.map((d, i) => {
                const status = statusOf(d)
                return (
                  <li key={i} className="rounded-lg bg-slate-50 px-3 py-2 dark:bg-slate-800/50">
                    <div className="flex items-start justify-between gap-2">
                      <span dir="auto" className="min-w-0 break-words font-semibold">
                        {d.name}
                      </span>
                      <Badge tone={status === 'Pass' ? 'green' : status === 'Fail' ? 'red' : 'amber'}>{status}</Badge>
                    </div>
                    <p className="mt-0.5 tabular-nums text-muted">
                      {spec(d)} → <span className="font-bold text-slate-900 dark:text-white">{d.actual}</span>
                    </p>
                  </li>
                )
              })}
            </ul>
            {/* From a tablet up, the table: the verdict first, so it reads down the left edge. */}
            <table className="hidden w-full text-sm sm:table">
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {measured.map((d, i) => {
                  const status = statusOf(d)
                  return (
                    <tr key={i}>
                      <td className="w-px py-2 pr-3">
                        <Badge tone={status === 'Pass' ? 'green' : status === 'Fail' ? 'red' : 'amber'}>{status}</Badge>
                      </td>
                      <td dir="auto" className="break-words py-2 text-left font-semibold">
                        {d.name}
                      </td>
                      <td className="whitespace-nowrap py-2 pl-3 text-right tabular-nums text-muted">{spec(d)}</td>
                      <td className="whitespace-nowrap py-2 pl-3 text-right font-bold tabular-nums">{d.actual}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </>
        )}
      </Section>

      <Section title={`Defects (${draft.defects.length})`}>
        {draft.defects.length === 0 ? (
          <Empty>No defects recorded.</Empty>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {draft.defects.map((d) => (
              <li key={d.key} className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2 dark:bg-slate-800/50">
                <span dir="auto" className="min-w-0 break-words font-semibold">
                  {d.defectName}
                  {isOtherDefect(d.defectName) && d.notes && <span className="block break-words text-xs font-normal text-muted">{d.notes}</span>}
                </span>
                <span className="flex flex-wrap items-center justify-end gap-2">
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
              value={
                lengths.length === 0 ? (
                  '—'
                ) : (
                  <ul>
                    {lengths.map((l) => (
                      <li key={l.key} className="tabular-nums">
                        {l.lengthMm || '?'} mm {l.verdict === 'Reject / Repair' ? '✕' : l.verdict === 'Accept' ? '✓' : '?'}
                      </li>
                    ))}
                  </ul>
                )
              }
            />
            <Row label="PT verdict" value={ptOverallVerdict(lengths.map((l) => ({ verdict: l.verdict }))) ?? 'pending'} />
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
            <ImagePicker
              imageIds={note.imageIds}
              onChange={(edit) => update((d) => ({ ...d, note: { ...(d.note ?? { text: '', imageIds: [] }), imageIds: edit(d.note?.imageIds ?? []) } }))}
              onUploading={onUploading}
              sessionId={sessionId}
              orderId={orderId}
            />
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
/** A fact on the review. A long one wraps rather than being cut off: this is the last look before saving. */
function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-semibold uppercase text-muted">{label}</dt>
      <dd dir="auto" className="break-words font-semibold">
        {value}
      </dd>
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
