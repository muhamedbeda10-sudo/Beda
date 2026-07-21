import { useState, useMemo, useEffect } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import {
  ArrowLeft,
  Package,
  Layers,
  Settings2,
  Clock,
  User,
  Plus,
  Eye,
  CheckCircle2,
  AlertTriangle,
  Lock,
  Unlock,
  Camera,
  Boxes,
  Pencil,
} from 'lucide-react'
import { useDB, actions } from '@/store/db'
import {
  orderById,
  machineById,
  samplesOf,
  sessionDefects,
  sessionHasHold,
  imagesOf,
} from '@/lib/selectors'
import { Badge, Button, Card, Modal, Field, Input, statusTone, resultTone } from '@/components/ui'
import { DimensionTable } from '@/components/inspection/DimensionTable'
import { DefectList } from '@/components/inspection/DefectList'
import { ImageStrip } from '@/components/inspection/ImageStrip'
import { formatDateTime, cn } from '@/lib/utils'
import { useApp } from '@/store/AppContext'

export function SessionPage() {
  const { id = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const db = useDB()
  const navigate = useNavigate()
  const { toast } = useApp()

  const session = db.sessions.find((s) => s.id === id)
  const samples = useMemo(() => (session ? samplesOf(db, session.id) : []), [db, session])
  const [activeSampleId, setActiveSampleId] = useState<string>('')
  const [closeOpen, setCloseOpen] = useState(false)
  const [qtyOpen, setQtyOpen] = useState(false)

  // sync active sample with url or default to first
  useEffect(() => {
    const urlSample = params.get('sample')
    if (urlSample && samples.some((s) => s.id === urlSample)) setActiveSampleId(urlSample)
    else if (samples.length && !samples.some((s) => s.id === activeSampleId)) setActiveSampleId(samples[0].id)
  }, [params, samples, activeSampleId])

  if (!session) {
    return (
      <div className="py-20 text-center">
        <p className="font-semibold">Session not found.</p>
        <Button variant="primary" className="mx-auto mt-4" onClick={() => navigate('/')}>
          Back to Inspections
        </Button>
      </div>
    )
  }

  const order = orderById(db, session.orderId)
  const machine = machineById(db, session.machineId)
  const defects = sessionDefects(db, session.id)
  const hasHold = sessionHasHold(db, session.id)
  const activeSample = samples.find((s) => s.id === activeSampleId)
  const sessionImgCount = db.images.filter((i) => i.sessionId === session.id).length

  function addSample() {
    const s = actions.addSample(session!.id)
    setActiveSampleId(s.id)
    setParams({ sample: s.id })
    toast(`Sample ${s.label} added`, 'success')
  }

  return (
    <div className="space-y-4 pb-24">
      {/* Back */}
      <button onClick={() => navigate('/')} className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-500 hover:text-brand-600 dark:text-slate-400">
        <ArrowLeft className="h-4 w-4" /> Inspections
      </button>

      {/* Session header */}
      <Card className="p-4">
        <div className="flex items-center gap-3">
          <span className="grid h-9 w-9 place-items-center rounded-full bg-brand-600 text-sm font-bold text-white">{session.seq}</span>
          <Badge tone={statusTone(session.status)}>{session.status.toUpperCase()}</Badge>
          {session.status === 'Open' ? (
            <button onClick={() => setQtyOpen(true)} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300">
              <Plus className="h-3.5 w-3.5" /> SET QTY
            </button>
          ) : (
            <button onClick={() => setQtyOpen(true)} className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-3 py-1 text-xs font-bold text-brand-600 dark:bg-brand-500/10 dark:text-brand-300">
              <CheckCircle2 className="h-3.5 w-3.5" /> QTY: {session.finalQty ?? 0} <Pencil className="h-3 w-3" />
            </button>
          )}
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2.5">
          <InfoTile icon={<Package className="h-4 w-4" />} label="Order" value={order?.orderId ?? '—'} tone="blue" />
          <InfoTile icon={<Layers className="h-4 w-4" />} label="Item" value={order?.item ?? '—'} tone="cyan" mono />
          <InfoTile icon={<Settings2 className="h-4 w-4" />} label="Machine" value={machine?.name ?? '—'} tone="sky" />
          <InfoTile icon={<Clock className="h-4 w-4" />} label="Date / Time" value={formatDateTime(session.startedAt)} tone="amber" />
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
          <span className="text-sm text-slate-500 dark:text-slate-400">
            Qty: <b className="text-slate-800 dark:text-slate-100">{session.finalQty ?? '—'}</b>
          </span>
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1 text-sm font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              <User className="h-3.5 w-3.5" /> {session.inspector}
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-50 px-3 py-1 text-sm font-semibold text-brand-600 dark:bg-brand-500/10 dark:text-brand-300">
              <Eye className="h-3.5 w-3.5" /> {samples.length} sample{samples.length === 1 ? '' : 's'}
            </span>
          </div>
        </div>

        {defects.length > 0 && (
          <div className="mt-3 flex items-center gap-2 rounded-xl bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-600 dark:bg-rose-500/10 dark:text-rose-400">
            <AlertTriangle className="h-4 w-4" /> {defects.length} defect{defects.length === 1 ? '' : 's'} recorded
            {hasHold && <Badge tone="amber" className="ml-auto">{defects.filter((d) => d.disposition === 'Hold').length} on hold</Badge>}
          </div>
        )}
      </Card>

      {/* Sample tabs */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1">
        {samples.map((s) => (
          <button
            key={s.id}
            onClick={() => {
              setActiveSampleId(s.id)
              setParams({ sample: s.id })
            }}
            className={cn(
              'flex shrink-0 items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-bold transition-colors',
              activeSampleId === s.id ? 'bg-brand-600 text-white shadow-sm' : 'bg-white text-slate-600 ring-1 ring-slate-200 dark:bg-slate-900 dark:text-slate-300 dark:ring-slate-700',
            )}
          >
            <Boxes className="h-4 w-4" /> {s.label}
            <span className={cn('h-2 w-2 rounded-full', s.result === 'Pass' ? 'bg-emerald-400' : s.result === 'Fail' ? 'bg-rose-400' : s.result === 'Warning' ? 'bg-amber-400' : 'bg-slate-300')} />
          </button>
        ))}
        <button
          onClick={addSample}
          className="flex shrink-0 items-center gap-1.5 rounded-xl border-2 border-dashed border-slate-300 px-3.5 py-2 text-sm font-bold text-slate-500 hover:border-brand-400 hover:text-brand-500 dark:border-slate-700"
        >
          <Plus className="h-4 w-4" /> Add sample
        </button>
      </div>

      {/* Active sample */}
      {activeSample ? (
        <Card className="space-y-5 p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-extrabold">Sample {activeSample.label}</h3>
              <Badge tone={resultTone(activeSample.result)}>{activeSample.result}</Badge>
            </div>
            {activeSample.coilId && <span className="text-xs text-slate-400">Coil {activeSample.coilId}</span>}
          </div>

          <DimensionTable sample={activeSample} />
          <DefectList sample={activeSample} sessionId={session.id} />

          <div>
            <h4 className="mb-2 flex items-center gap-1.5 text-sm font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              <Camera className="h-4 w-4" /> Sample Photos
            </h4>
            <ImageStrip images={imagesOf(db, 'sample', activeSample.id)} ownerKind="sample" ownerId={activeSample.id} sessionId={session.id} />
          </div>

          <div className="flex justify-end border-t border-slate-100 pt-3 dark:border-slate-800">
            <Button
              variant="ghost"
              className="text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-500/10"
              onClick={() => {
                actions.deleteSample(activeSample.id)
                toast('Sample removed', 'info')
              }}
            >
              Remove sample
            </Button>
          </div>
        </Card>
      ) : (
        <Card className="p-10 text-center">
          <Boxes className="mx-auto h-10 w-10 text-slate-300" />
          <p className="mt-3 font-semibold">No samples yet</p>
          <p className="mt-1 text-sm text-slate-400">Add the first sample to start recording measurements.</p>
          <Button variant="primary" className="mx-auto mt-4" onClick={addSample}>
            <Plus className="h-4 w-4" /> Add sample
          </Button>
        </Card>
      )}

      {/* Sticky action bar */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/90 backdrop-blur-md dark:border-slate-800 dark:bg-slate-900/90 safe-bottom">
        <div className="mx-auto flex max-w-7xl items-center gap-2 px-4 py-3">
          <div className="hidden text-sm text-slate-500 sm:block dark:text-slate-400">
            {samples.length} samples · {defects.length} defects
            {sessionImgCount > 0 && ` · ${sessionImgCount} photos`}
          </div>
          <div className="ml-auto flex items-center gap-2">
            {session.status === 'Open' ? (
              <Button variant="primary" onClick={() => setCloseOpen(true)}>
                <Lock className="h-4 w-4" /> Close session
              </Button>
            ) : (
              <Button variant="secondary" onClick={() => actions.reopenSession(session.id)}>
                <Unlock className="h-4 w-4" /> Reopen
              </Button>
            )}
          </div>
        </div>
      </div>

      <CloseSessionDialog
        open={closeOpen}
        onClose={() => setCloseOpen(false)}
        sessionId={session.id}
        hasHold={hasHold}
        holdCount={defects.filter((d) => d.disposition === 'Hold').length}
        defaultQty={session.finalQty ?? order?.requiredQty ?? 0}
      />
      <SetQtyDialog open={qtyOpen} onClose={() => setQtyOpen(false)} sessionId={session.id} defaultQty={session.finalQty ?? 0} />
    </div>
  )
}

function InfoTile({
  icon,
  label,
  value,
  tone,
  mono,
}: {
  icon: React.ReactNode
  label: string
  value: string
  tone: 'blue' | 'cyan' | 'sky' | 'amber'
  mono?: boolean
}) {
  const tones = {
    blue: 'bg-brand-100 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300',
    cyan: 'bg-cyan-100 text-cyan-600 dark:bg-cyan-500/15 dark:text-cyan-300',
    sky: 'bg-sky-100 text-sky-600 dark:bg-sky-500/15 dark:text-sky-300',
    amber: 'bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300',
  }
  return (
    <div className="flex items-center gap-2.5 rounded-2xl bg-slate-50 p-3 dark:bg-slate-800/50">
      <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-xl', tones[tone])}>{icon}</span>
      <div className="min-w-0">
        <p className="text-xs font-semibold uppercase text-slate-400">{label}</p>
        <p className={cn('truncate font-bold', mono && 'font-mono text-sm')}>{value}</p>
      </div>
    </div>
  )
}

function CloseSessionDialog({
  open,
  onClose,
  sessionId,
  hasHold,
  holdCount,
  defaultQty,
}: {
  open: boolean
  onClose: () => void
  sessionId: string
  hasHold: boolean
  holdCount: number
  defaultQty: number
}) {
  const { toast } = useApp()
  const [qty, setQty] = useState(String(defaultQty))
  const [ack, setAck] = useState(false)
  useEffect(() => setQty(String(defaultQty)), [defaultQty, open])
  useEffect(() => setAck(false), [open])

  function confirm() {
    actions.closeSession(sessionId, Number(qty) || 0)
    toast('Session closed', 'success')
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Close inspection session"
      icon={<Lock className="h-5 w-5" />}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={hasHold && !ack} onClick={confirm}>
            <Lock className="h-4 w-4" /> Confirm & close
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {hasHold && (
          <div className="rounded-2xl border border-amber-300 bg-amber-50 p-3.5 dark:border-amber-500/40 dark:bg-amber-500/10">
            <div className="flex items-center gap-2 font-bold text-amber-700 dark:text-amber-400">
              <AlertTriangle className="h-5 w-5" /> {holdCount} defect{holdCount === 1 ? '' : 's'} on Hold
            </div>
            <p className="mt-1 text-sm text-amber-700/90 dark:text-amber-300/90">
              This session has unresolved Hold defects. Closing now will lock them into the record. Please confirm you have reviewed them.
            </p>
            <label className="mt-2.5 flex cursor-pointer items-center gap-2 text-sm font-semibold text-amber-800 dark:text-amber-300">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="h-4 w-4 rounded accent-amber-600" />
              I have reviewed the Hold defects and want to close.
            </label>
          </div>
        )}
        <Field label="Final / confirmed quantity">
          <Input type="number" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} />
        </Field>
        <div className="flex items-center gap-2 rounded-xl bg-slate-50 px-3 py-2.5 text-sm text-slate-500 dark:bg-slate-800/50 dark:text-slate-400">
          <CheckCircle2 className="h-4 w-4 text-emerald-500" /> Results will be finalized and linked to the production order.
        </div>
      </div>
    </Modal>
  )
}

function SetQtyDialog({ open, onClose, sessionId, defaultQty }: { open: boolean; onClose: () => void; sessionId: string; defaultQty: number }) {
  const { toast } = useApp()
  const [qty, setQty] = useState(String(defaultQty))
  useEffect(() => setQty(String(defaultQty)), [defaultQty, open])
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Set quantity"
      icon={<Plus className="h-5 w-5" />}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              actions.setSessionQty(sessionId, Number(qty) || 0)
              toast('Quantity updated', 'success')
              onClose()
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <Field label="Quantity">
        <Input autoFocus type="number" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} />
      </Field>
    </Modal>
  )
}
