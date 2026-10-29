// ============================================================================
// MTC — the delivery notes: the supplier's note of the coils delivered, its
// number, day and PO. Read by Claude from its PDF, photos or sheet (Upload
// delivery note) or typed (New), checked and saved; every coil it lists then
// shows the note's PO and delivery date in the coil register, whichever came
// first. Everyone who may open the MTC tab reads them; whoever may upload
// certificates saves, corrects and removes them.
// ============================================================================

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, FileUp, Loader2, Plus, Save, Trash2, Truck, X } from 'lucide-react'
import {
  DELIVERY_NOTE_MAX_COILS,
  MTC_ACCEPT,
  MTC_SUPPLIERS,
  cleanMtcNumber,
  type DeliveryNote,
  type DeliveryNoteExtractResult,
  type DeliveryNoteInput,
  type DeliveryNoteSummary,
} from '@qc/shared/mtc'
import { calendarDay } from '@qc/shared/rules'
import { Badge, Button, Card, EmptyState, Modal } from '@/components/ui'
import { FilterBar } from '@/components/ui/PageShell'
import { ScrollX } from '@/components/ui/ScrollX'
import { CertificateRejected, deleteDeliveryNote, readDeliveryNote, saveDeliveryNote, useDeliveryNote, useDeliveryNotes } from '@/services/mtc'
import { useDebounced } from '@/services/queries'
import { usePersistedState } from '@/lib/usePersistedState'
import { useAuth } from '@/store/AuthContext'
import { useApp } from '@/store/AppContext'
import { cn, formatDay } from '@/lib/utils'
import { MtcDocumentLink } from './MtcDocument'

const PAGE = 100

/** What the form holds: every field as typed. */
interface NoteDraft {
  noteNumber: string
  deliveryDate: string
  poNumber: string
  supplier: string
  notes: string
  coils: { key: number; coilNumber: string; weightKg: string }[]
}

let seq = 0
const line = (coilNumber = '', weightKg = '') => ({ key: ++seq, coilNumber, weightKg })
const toDraft = (n: DeliveryNoteInput): NoteDraft => ({
  noteNumber: n.noteNumber,
  deliveryDate: n.deliveryDate,
  poNumber: n.poNumber,
  supplier: n.supplier,
  notes: n.notes,
  coils: n.coils.length ? n.coils.map((c) => line(c.coilNumber, c.weightKg === null ? '' : String(c.weightKg))) : [line()],
})

/** What is wrong with the draft, in a sentence; null when it can be saved. */
function draftProblem(d: NoteDraft): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.deliveryDate)) return 'Enter the delivery date.'
  const seen = new Set<string>()
  for (const c of d.coils) {
    const n = c.coilNumber.trim()
    if (!n) {
      if (c.weightKg.trim()) return 'A weight has no coil number.'
      continue
    }
    if (seen.has(n.toLowerCase())) return `${n} is listed twice.`
    seen.add(n.toLowerCase())
    if (c.weightKg.trim() && cleanMtcNumber(c.weightKg) === undefined) return `${n}: the weight is not a number.`
  }
  return null
}

const fromDraft = (d: NoteDraft): DeliveryNoteInput => ({
  noteNumber: d.noteNumber.trim(),
  deliveryDate: d.deliveryDate,
  poNumber: d.poNumber.trim(),
  supplier: d.supplier.trim(),
  notes: d.notes.trim(),
  coils: d.coils.filter((c) => c.coilNumber.trim()).map((c) => ({ coilNumber: c.coilNumber.trim(), weightKg: c.weightKg.trim() ? (cleanMtcNumber(c.weightKg) ?? null) : null })),
})

export function DeliveryNotesView({ leading, canUpload, columnPicker }: { leading: ReactNode; canUpload: boolean; columnPicker?: ReactNode }) {
  const { toast } = useApp()
  const { factoryTimeZone } = useAuth()
  const [term, setTerm] = usePersistedState('qc-mtc:delivery-notes:term', '')
  const search = useDebounced(term.trim())
  const list = useDeliveryNotes(search, PAGE)
  const notes = useMemo(() => list.data?.pages.flatMap((p) => p.notes) ?? [], [list.data])
  const total = list.data?.pages[0]?.total ?? null

  const [open, setOpen] = useState<
    { kind: 'existing'; id: string } | { kind: 'new'; input: DeliveryNoteInput; uncertain: string[]; documentId?: string; fileName?: string; problem?: string } | null
  >(null)

  // ---- Reading a note ----
  const fileInput = useRef<HTMLInputElement>(null)
  const [reading, setReading] = useState<{ name: string; abort: AbortController } | null>(null)
  const readingRef = useRef<AbortController | null>(null)
  useEffect(() => () => readingRef.current?.abort(), [])

  async function startReading(files: File[]) {
    if (files.length === 0) return
    const abort = new AbortController()
    readingRef.current = abort
    setReading({ name: files.length === 1 ? files[0].name : `${files[0].name} and ${files.length - 1} more`, abort })
    try {
      const read: DeliveryNoteExtractResult = await readDeliveryNote(files, abort.signal)
      if (!read.note) toast(read.problem ? `Nothing was read: ${read.problem}` : 'This document is not a delivery note: nothing was read.', 'error')
      else {
        const { uncertain, ...input } = read.note
        setOpen({ kind: 'new', input, uncertain, documentId: read.documentId, fileName: read.fileName, problem: read.problem })
      }
    } catch (e) {
      if (e instanceof CertificateRejected) toast(e.message, 'error')
      else if ((e as Error).name !== 'AbortError') toast(e instanceof Error ? e.message : 'The delivery note could not be read.', 'error')
    } finally {
      readingRef.current = null
      setReading(null)
    }
  }

  const blank = (): DeliveryNoteInput => ({ noteNumber: '', deliveryDate: calendarDay(new Date(), factoryTimeZone), poNumber: '', supplier: '', notes: '', coils: [] })

  return (
    <div className="space-y-3">
      <FilterBar
        leading={leading}
        actionsInline
        actions={
          <>
            {columnPicker}
            {canUpload && (
              <>
                <input
                  ref={fileInput}
                  type="file"
                  accept={MTC_ACCEPT}
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? [])
                    e.target.value = ''
                    void startReading(files)
                  }}
                />
                <Button className="h-10 touch:h-11" onClick={() => setOpen({ kind: 'new', input: blank(), uncertain: [] })}>
                  <Plus className="h-4 w-4" /> New
                </Button>
                <Button
                  variant="primary"
                  className="h-10 touch:h-11"
                  disabled={reading !== null}
                  data-tip="The delivery note’s PDF, photos of its pages, or its Excel sheet"
                  onClick={() => fileInput.current?.click()}
                >
                  <FileUp className="h-4 w-4" /> Upload delivery note
                </Button>
              </>
            )}
          </>
        }
        search={{ value: term, onChange: setTerm, placeholder: 'Search notes, POs, suppliers or coils…', label: 'Search delivery notes' }}
        chips={[]}
        canReset={!!term}
        onReset={() => setTerm('')}
      />

      {reading && (
        <Card className="flex flex-wrap items-center gap-3 p-4" role="status" aria-live="polite">
          <Loader2 className="h-5 w-5 shrink-0 animate-spin text-brand-600" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">Reading {reading.name}…</p>
            <p className="text-xs text-muted">Claude is reading the note’s number, day, PO and every coil delivered. Keep this page open.</p>
          </div>
          <Button className="min-h-[44px]" onClick={() => reading.abort.abort()}>
            <X className="h-4 w-4" /> Cancel
          </Button>
        </Card>
      )}

      {list.isError && !list.data ? (
        <Card className="p-6">
          <EmptyState icon={<Truck className="h-10 w-10" />} title="The delivery notes could not be loaded" hint="Check the connection and try again." action={<Button onClick={() => void list.refetch()}>Try again</Button>} />
        </Card>
      ) : list.isLoading ? (
        <Card className="p-6 text-sm text-muted">
          <Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> Loading…
        </Card>
      ) : notes.length === 0 ? (
        <EmptyState
          icon={<Truck className="h-10 w-10" />}
          title={search ? 'No delivery notes match' : 'No delivery notes yet'}
          hint={search ? 'Clear the search to see them all.' : canUpload ? 'Upload a delivery note, or type one with New.' : undefined}
        />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:hidden">
            {notes.map((n) => (
              <Card key={n.id} className="min-w-0 cursor-pointer p-4" role="button" tabIndex={0} onClick={() => setOpen({ kind: 'existing', id: n.id })} onKeyDown={(e) => e.key === 'Enter' && setOpen({ kind: 'existing', id: n.id })}>
                <p className="truncate font-bold">{n.noteNumber || 'Delivery note'}</p>
                <p className="text-sm text-muted">
                  {formatDay(n.deliveryDate)}
                  {n.poNumber ? ` · PO ${n.poNumber}` : ''}
                  {n.supplier ? ` · ${n.supplier}` : ''}
                </p>
                <p className="mt-1 text-sm">
                  <CoilCount note={n} />
                </p>
              </Card>
            ))}
          </div>
          <Card className="hidden overflow-hidden md:block">
            <ScrollX label="Delivery notes">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-muted dark:bg-slate-800/60">
                  <tr>
                    <th className="px-3 py-2.5 font-bold">Delivery date</th>
                    <th className="px-3 py-2.5 font-bold">Note No.</th>
                    <th className="px-3 py-2.5 font-bold">PO</th>
                    <th className="px-3 py-2.5 font-bold">Supplier</th>
                    <th className="px-3 py-2.5 font-bold">Coils received</th>
                    <th className="px-3 py-2.5 font-bold">File</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {notes.map((n) => (
                    <tr
                      key={n.id}
                      className="data-row cursor-pointer bg-white transition-colors hover:bg-slate-50 dark:bg-slate-900 dark:hover:bg-[#17202f]"
                      tabIndex={0}
                      onClick={() => setOpen({ kind: 'existing', id: n.id })}
                      onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && setOpen({ kind: 'existing', id: n.id })}
                    >
                      <td className="px-3 py-3 font-semibold">{formatDay(n.deliveryDate)}</td>
                      <td className="px-3 py-3 font-mono text-[13px]">{n.noteNumber || '—'}</td>
                      <td className="px-3 py-3 font-mono text-[13px]">{n.poNumber || '—'}</td>
                      <td className="px-3 py-3">{n.supplier || '—'}</td>
                      <td className="px-3 py-3">
                        <CoilCount note={n} />
                      </td>
                      <td className="px-3 py-3">
                        {n.documentId ? (
                          <MtcDocumentLink id={n.documentId} title={`Delivery note ${n.noteNumber}`}>
                            Open
                          </MtcDocumentLink>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollX>
          </Card>
          <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
            <span>
              {notes.length} of {total ?? notes.length} delivery note{total === 1 ? '' : 's'}
            </span>
            {list.hasNextPage && (
              <Button className="min-h-[40px]" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                {list.isFetchingNextPage ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Show more
              </Button>
            )}
          </div>
        </>
      )}

      {open?.kind === 'existing' && <ExistingNote id={open.id} canEdit={canUpload} onClose={() => setOpen(null)} />}
      {open?.kind === 'new' && (
        <NoteForm
          title={open.fileName ? `Delivery note read from ${open.fileName}` : 'New delivery note'}
          initial={open.input}
          uncertain={open.uncertain}
          documentId={open.documentId}
          problem={open.problem}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  )
}

function CoilCount({ note }: { note: DeliveryNoteSummary }) {
  const missing = note.coils - note.registered
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className="tabular-nums">
        {note.coils} coil{note.coils === 1 ? '' : 's'}
      </span>
      {note.coils > 0 &&
        (missing === 0 ? (
          <Badge tone="green">All certificates in</Badge>
        ) : (
          <span data-tip="Coils on the note whose certificate is not in the coil register yet">
            <Badge tone="amber">{missing} without MTC</Badge>
          </span>
        ))}
    </span>
  )
}

function ExistingNote({ id, canEdit, onClose }: { id: string; canEdit: boolean; onClose: () => void }) {
  const note = useDeliveryNote(id)
  if (!note.data) {
    return (
      <Modal open onClose={onClose} title="Delivery note" size="sm">
        {note.isError ? <p className="text-sm text-muted">This delivery note could not be loaded. It may have been removed.</p> : <Loader2 className="h-5 w-5 animate-spin text-muted" />}
      </Modal>
    )
  }
  return <NoteForm title={`Delivery note ${note.data.noteNumber}`.trim()} initial={note.data} existing={note.data} readOnly={!canEdit} documentId={note.data.documentId ?? undefined} onClose={onClose} />
}

function NoteForm({
  title,
  initial,
  uncertain = [],
  existing,
  documentId,
  problem,
  readOnly = false,
  onClose,
}: {
  title: string
  initial: DeliveryNoteInput
  uncertain?: string[]
  existing?: DeliveryNote
  documentId?: string
  problem?: string
  readOnly?: boolean
  onClose: () => void
}) {
  const qc = useQueryClient()
  const { toast } = useApp()
  const [draft, setDraft] = useState<NoteDraft>(() => toDraft(initial))
  const [unsure, setUnsure] = useState<string[]>(uncertain)
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const wrong = draftProblem(draft)
  const set = (key: keyof Omit<NoteDraft, 'coils'>, value: string) => {
    setDraft((d) => ({ ...d, [key]: value }))
    setUnsure((u) => u.filter((x) => x !== key))
  }
  const setLine = (k: number, change: Partial<NoteDraft['coils'][number]>) => {
    setDraft((d) => ({ ...d, coils: d.coils.map((c) => (c.key === k ? { ...c, ...change } : c)) }))
    setUnsure((u) => u.filter((x) => x !== 'coils'))
  }
  const registeredOf = useMemo(() => new Map((existing?.coils ?? []).map((c) => [c.coilNumber.toLowerCase(), c])), [existing])

  async function save() {
    setSaving(true)
    try {
      const body = { ...fromDraft(draft), documentId: documentId ?? null }
      await saveDeliveryNote(qc, existing ? { ...body, id: existing.id, version: existing.version } : body)
      toast(existing ? 'Delivery note saved.' : `Delivery note saved: ${body.coils.length} coil${body.coils.length === 1 ? '' : 's'}.`, 'success')
      onClose()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'The delivery note could not be saved.', 'error')
    } finally {
      setSaving(false)
    }
  }

  const field = (key: keyof Omit<NoteDraft, 'coils'>, label: string, extra: { type?: string; max?: number; list?: string; mono?: boolean } = {}) => (
    <label className="block min-w-0">
      <span className="label">{label}</span>
      {readOnly ? (
        <span className={cn('block min-h-6 text-sm', extra.mono && 'font-mono')}>{(key === 'deliveryDate' ? formatDay(draft[key]) : draft[key]) || '—'}</span>
      ) : (
        <input
          type={extra.type ?? 'text'}
          maxLength={extra.max}
          list={extra.list}
          className={cn('input', extra.mono && 'font-mono', unsure.includes(key) && 'bg-amber-50 ring-2 ring-amber-400 dark:bg-amber-500/10')}
          value={draft[key]}
          onChange={(e) => set(key, e.target.value)}
        />
      )}
    </label>
  )

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      icon={<Truck className="h-5 w-5" />}
      size="xl"
      footer={
        readOnly ? (
          <Button className="min-h-[44px]" onClick={onClose}>
            Close
          </Button>
        ) : (
          <>
            {existing && (
              <Button variant="ghost" className="mr-auto min-h-[44px] text-danger-700 dark:text-danger-400" onClick={() => setConfirmDelete(true)}>
                <Trash2 className="h-4 w-4" /> Delete
              </Button>
            )}
            <Button className="min-h-[44px]" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" className="min-h-[44px]" disabled={!!wrong || saving} onClick={() => void save()}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save
            </Button>
          </>
        )
      }
    >
      <div className="space-y-4">
        {problem && (
          <p className="flex gap-2 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            {problem}
          </p>
        )}
        {!readOnly && unsure.length > 0 && <p className="text-sm text-muted">Check the amber values against the paper: Claude was not sure of them.</p>}
        <datalist id="delivery-note-suppliers">
          {MTC_SUPPLIERS.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {field('deliveryDate', 'Delivery date', { type: 'date' })}
          {field('noteNumber', 'Note No.', { max: 120, mono: true })}
          {field('poNumber', 'PO', { max: 120, mono: true })}
          {field('supplier', 'Supplier', { max: 200, list: 'delivery-note-suppliers' })}
        </div>
        {(draft.notes || !readOnly) && field('notes', 'Notes', { max: 1000 })}
        {documentId && (
          <p className="text-sm">
            <MtcDocumentLink id={documentId} title={title}>
              Open the note as uploaded
            </MtcDocumentLink>
          </p>
        )}

        <section>
          <h3 className={cn('mb-2 text-sm font-bold', unsure.includes('coils') && 'text-amber-700 dark:text-amber-300')}>
            Coils received ({draft.coils.filter((c) => c.coilNumber.trim()).length})
          </h3>
          <div className="overflow-hidden rounded-xl ring-1 ring-slate-200 dark:ring-slate-800">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-muted dark:bg-slate-800/60">
                <tr>
                  <th className="w-10 px-2 py-2 font-bold">#</th>
                  <th className="px-2 py-2 font-bold">Coil number</th>
                  <th className="px-2 py-2 text-right font-bold">Weight (kg)</th>
                  {existing && <th className="px-2 py-2 font-bold">MTC</th>}
                  {!readOnly && (
                    <th className="w-12 px-2 py-2">
                      <span className="sr-only">Remove</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {draft.coils.map((c, i) => {
                  const reg = registeredOf.get(c.coilNumber.trim().toLowerCase())
                  return (
                    <tr key={c.key}>
                      <td className="px-2 py-1.5 text-xs tabular-nums text-muted">{i + 1}</td>
                      <td className="px-2 py-1.5">
                        {readOnly ? (
                          <span className="font-mono">{c.coilNumber}</span>
                        ) : (
                          <input className="input h-9 font-mono" maxLength={120} aria-label={`Coil number, line ${i + 1}`} value={c.coilNumber} onChange={(e) => setLine(c.key, { coilNumber: e.target.value })} />
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        {readOnly ? (
                          <span className="tabular-nums">{c.weightKg || '—'}</span>
                        ) : (
                          <input
                            inputMode="decimal"
                            className="input ml-auto h-9 w-28 text-right tabular-nums"
                            aria-label={`Weight, line ${i + 1}`}
                            value={c.weightKg}
                            onChange={(e) => setLine(c.key, { weightKg: e.target.value })}
                          />
                        )}
                      </td>
                      {existing && (
                        <td className="px-2 py-1.5">
                          {reg?.coilId ? <Badge tone="green">{reg.mtcNumber ? `MTC ${reg.mtcNumber}` : 'Registered'}</Badge> : <Badge tone="amber">No MTC yet</Badge>}
                        </td>
                      )}
                      {!readOnly && (
                        <td className="px-1 py-1">
                          <button
                            type="button"
                            aria-label={`Remove line ${i + 1}`}
                            onClick={() => setDraft((d) => ({ ...d, coils: d.coils.filter((x) => x.key !== c.key) }))}
                            className="grid h-9 w-9 place-items-center rounded-lg text-muted hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {!readOnly && (
            <Button className="mt-2 min-h-[40px]" disabled={draft.coils.length >= DELIVERY_NOTE_MAX_COILS} onClick={() => setDraft((d) => ({ ...d, coils: [...d.coils, line()] }))}>
              <Plus className="h-4 w-4" /> Add a coil
            </Button>
          )}
        </section>
        {!readOnly && wrong && <p className="text-sm font-semibold text-rose-700 dark:text-rose-300">{wrong}</p>}
      </div>

      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete this delivery note?"
        size="sm"
        footer={
          <>
            <Button className="min-h-[44px]" onClick={() => setConfirmDelete(false)}>
              Keep
            </Button>
            <Button
              variant="danger"
              className="min-h-[44px]"
              onClick={() =>
                existing &&
                void deleteDeliveryNote(qc, existing.id).then(
                  () => {
                    toast('Delivery note deleted.', 'success')
                    onClose()
                  },
                  (e: unknown) => toast(e instanceof Error ? e.message : 'The delivery note could not be deleted.', 'error'),
                )
              }
            >
              Delete
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-600 dark:text-slate-300">Its coils lose this note’s PO and delivery date (or take those of another note that lists them). The audit log keeps it.</p>
      </Modal>
    </Modal>
  )
}
