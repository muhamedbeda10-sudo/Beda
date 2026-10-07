// ============================================================================
// Work instructions — the controlled documents (PDF) the wizard offers on a
// step: acceptance limits, test methods, repair instructions. A new issue of
// a code supersedes the one in force; the old issue stays on record.
// ============================================================================

import { useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { BookOpen, Eye, FileText, History, Loader2, Pencil, Trash2, UploadCloud } from 'lucide-react'
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Select } from '@/components/ui'
import { WorkInstructionViewer } from '@/components/documents/WorkInstructionViewer'
import { useWorkInstructions } from '@/services/queries'
import { deleteWorkInstruction, updateWorkInstruction, uploadWorkInstruction } from '@/services/mutations'
import { useAuth } from '@/store/AuthContext'
import { useApp } from '@/store/AppContext'
import { can } from '@/domain'
import {
  PROCESSES,
  PROCESS_LABEL,
  WORK_INSTRUCTION_STEPS,
  WORK_INSTRUCTION_STEP_LABEL,
  type WorkInstruction,
  type WorkInstructionScope,
  type WorkInstructionStep,
} from '@qc/shared/types'
import { When } from '@/components/ui/Tooltip'
import { useTableView, ViewNote, ViewTh } from '@/components/ui/ColumnFilter'

interface UploadDraft {
  code: string
  title: string
  issueNo: string
  issueDate: string
  process: WorkInstructionScope
  step: WorkInstructionStep
  file: File | null
}

const SCOPE_LABEL: Record<WorkInstructionScope, string> = { all: 'Every machine', ...PROCESS_LABEL }

const emptyDraft = (): UploadDraft => ({ code: '', title: '', issueNo: '', issueDate: '', process: 'welding', step: 'defects', file: null })

function sizeLabel(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

export function WorkInstructionsSection() {
  const queryClient = useQueryClient()
  const { role } = useAuth()
  const { toast } = useApp()
  const [history, setHistory] = useState(false)
  const { data: rows = [], isLoading } = useWorkInstructions(undefined, history)
  const [upload, setUpload] = useState<UploadDraft | null>(null)
  const [editing, setEditing] = useState<WorkInstruction | null>(null)
  const [editDraft, setEditDraft] = useState<Omit<UploadDraft, 'file' | 'code'>>({ title: '', issueNo: '', issueDate: '', process: 'welding', step: 'defects' })
  const [removing, setRemoving] = useState<WorkInstruction | null>(null)
  const [viewing, setViewing] = useState<WorkInstruction | null>(null)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const canManage = can(role, 'manage-admin-data')

  const sorted = useMemo(
    () =>
      [...rows].sort(
        (a, b) =>
          a.step.localeCompare(b.step) || a.sortOrder - b.sortOrder || a.code.localeCompare(b.code, undefined, { numeric: true }) || (a.uploadedAt < b.uploadedAt ? 1 : -1),
      ),
    [rows],
  )
  const view = useTableView(sorted, [
    { key: 'code', value: (w) => w.code },
    { key: 'title', value: (w) => w.title },
    { key: 'issue', value: (w) => w.issueNo || '—' },
    { key: 'scope', value: (w) => SCOPE_LABEL[w.process] },
    { key: 'step', value: (w) => WORK_INSTRUCTION_STEP_LABEL[w.step] },
    { key: 'file', value: (w) => w.uploadedByName, noValues: false },
  ])

  async function submitUpload() {
    if (!upload) return
    if (!upload.file) return toast('Choose the PDF file.', 'error')
    if (!upload.code.trim() || !upload.title.trim()) return toast('Code and title are required.', 'error')
    setBusy(true)
    try {
      const created = await uploadWorkInstruction(queryClient, upload.file, {
        code: upload.code.trim(),
        title: upload.title.trim(),
        issueNo: upload.issueNo.trim(),
        issueDate: upload.issueDate || undefined,
        process: upload.process,
        step: upload.step,
      })
      toast(`${created.code} is in force${created.issueNo ? ` (issue ${created.issueNo})` : ''}.`, 'success')
      setUpload(null)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'The document could not be uploaded.', 'error')
    } finally {
      setBusy(false)
    }
  }

  async function submitEdit() {
    if (!editing) return
    if (!editDraft.title.trim()) return toast('Title is required.', 'error')
    setBusy(true)
    try {
      await updateWorkInstruction(queryClient, editing.id, {
        title: editDraft.title.trim(),
        issueNo: editDraft.issueNo.trim(),
        issueDate: editDraft.issueDate || null,
        process: editDraft.process,
        step: editDraft.step,
      })
      toast('Document updated.', 'success')
      setEditing(null)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'The document could not be updated.', 'error')
    } finally {
      setBusy(false)
    }
  }

  async function submitRemove() {
    if (!removing) return
    setBusy(true)
    try {
      await deleteWorkInstruction(queryClient, removing.id)
      toast(`${removing.code} is no longer offered.`, 'success')
      setRemoving(null)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'The document could not be removed.', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <Card className="space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-100 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300">
              <BookOpen className="h-5 w-5" />
            </span>
            <h2 className="text-lg font-bold">Work instructions</h2>
          </div>
          <div className="flex flex-wrap gap-2">
            {can(role, 'manage-admin-data') && (
              <Button className="min-h-[48px]" onClick={() => setHistory((h) => !h)}>
                <History className="h-4 w-4" /> {history ? 'In force only' : 'Show superseded'}
              </Button>
            )}
            {canManage && (
              <Button variant="primary" className="min-h-[48px]" onClick={() => setUpload(emptyDraft())}>
                <UploadCloud className="h-4 w-4" /> Upload PDF
              </Button>
            )}
          </div>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : sorted.length === 0 ? (
          <EmptyState icon={<FileText className="h-10 w-10" />} title="No work instructions yet" hint="Upload a PDF and choose the process and step it belongs to." />
        ) : (
          <div className="overflow-x-auto rounded-2xl ring-1 ring-slate-200 dark:ring-slate-800">
            <table className="w-full min-w-[60rem] text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-muted dark:bg-slate-800/60">
                <tr>
                  <ViewTh view={view} column="code" label="Code" className="px-3 py-2.5 font-bold" />
                  <ViewTh view={view} column="title" label="Title" className="px-3 py-2.5 font-bold" />
                  <ViewTh view={view} column="issue" label="Issue" className="px-3 py-2.5 font-bold" />
                  <ViewTh view={view} column="scope" label="Applies to" className="px-3 py-2.5 font-bold" />
                  <ViewTh view={view} column="step" label="Step" className="px-3 py-2.5 font-bold" />
                  <ViewTh view={view} column="file" label="File" className="px-3 py-2.5 font-bold" />
                  <th className="px-3 py-2.5 text-right font-bold">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {view.rows.map((w) => {
                  const superseded = !!w.supersededAt
                  return (
                    <tr key={w.id} className={superseded ? 'opacity-60' : 'hover:bg-slate-50/70 dark:hover:bg-slate-800/40'}>
                      <td className="px-3 py-2.5 font-mono text-[13px] font-semibold">{w.code}</td>
                      <td className="max-w-[24rem] px-3 py-2.5">
                        <span className="block truncate font-semibold" data-tip={w.title}>
                          {w.title}
                        </span>
                        {superseded && <Badge tone="neutral">Superseded <When iso={w.supersededAt ?? undefined} /></Badge>}
                      </td>
                      <td className="px-3 py-2.5 tabular-nums">
                        {w.issueNo || '—'}
                        {w.issueDate && <span className="block text-xs text-muted">{w.issueDate.slice(0, 10)}</span>}
                      </td>
                      <td className="px-3 py-2.5">
                        <Badge tone={w.process === 'all' ? 'neutral' : w.process === 'welding' ? 'amber' : w.process === 'paint' ? 'violet' : 'blue'}>{SCOPE_LABEL[w.process]}</Badge>
                      </td>
                      <td className="px-3 py-2.5">{WORK_INSTRUCTION_STEP_LABEL[w.step]}</td>
                      <td className="px-3 py-2.5 text-xs text-muted">
                        {sizeLabel(w.byteSize)} · {w.uploadedByName} · <When iso={w.uploadedAt} />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <div className="inline-flex gap-1">
                          <button type="button" onClick={() => setViewing(w)} aria-label={`Open ${w.code}`} className="grid h-12 w-12 place-items-center rounded-xl text-muted transition-colors hover:bg-slate-100 hover:text-brand-600 dark:hover:bg-slate-800">
                            <Eye className="h-4 w-4" />
                          </button>
                          {canManage && !superseded && (
                            <>
                              <button
                                type="button"
                                onClick={() => {
                                  setEditing(w)
                                  setEditDraft({ title: w.title, issueNo: w.issueNo, issueDate: w.issueDate?.slice(0, 10) ?? '', process: w.process, step: w.step })
                                }}
                                aria-label={`Edit ${w.code}`}
                                className="grid h-12 w-12 place-items-center rounded-xl text-muted transition-colors hover:bg-slate-100 hover:text-brand-600 dark:hover:bg-slate-800"
                              >
                                <Pencil className="h-4 w-4" />
                              </button>
                              <button
                                type="button"
                                onClick={() => setUpload({ ...emptyDraft(), code: w.code, title: w.title, process: w.process, step: w.step })}
                                aria-label={`Upload a new issue of ${w.code}`}
                                className="grid h-12 w-12 place-items-center rounded-xl text-muted transition-colors hover:bg-slate-100 hover:text-brand-600 dark:hover:bg-slate-800"
                              >
                                <UploadCloud className="h-4 w-4" />
                              </button>
                              <button type="button" disabled={busy} onClick={() => setRemoving(w)} aria-label={`Remove ${w.code}`} className="grid h-12 w-12 place-items-center rounded-xl text-muted transition-colors hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10">
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal
        open={upload !== null}
        onClose={() => {
          if (!busy) setUpload(null)
        }}
        title="Upload a work instruction"
        icon={<UploadCloud className="h-5 w-5" />}
        footer={
          <>
            <Button className="min-h-[48px]" onClick={() => setUpload(null)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" className="min-h-[48px]" onClick={() => void submitUpload()} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
              Put in force
            </Button>
          </>
        }
      >
        {upload && (
          <div className="space-y-3">
            <div>
              <span className="label">PDF file</span>
              <input ref={fileRef} type="file" accept="application/pdf,.pdf" hidden onChange={(e) => setUpload({ ...upload, file: e.target.files?.[0] ?? null })} />
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="flex min-h-[64px] w-full items-center gap-3 rounded-2xl border-2 border-dashed border-slate-300 px-4 text-left text-sm hover:border-brand-400 dark:border-slate-700"
              >
                <FileText className="h-5 w-5 shrink-0 text-brand-600" />
                {upload.file ? (
                  <span className="min-w-0">
                    <span className="block truncate font-semibold">{upload.file.name}</span>
                    <span className="text-xs text-muted">{sizeLabel(upload.file.size)}</span>
                  </span>
                ) : (
                  <span className="text-muted">Choose the PDF…</span>
                )}
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Document code" hint="A new issue of an existing code replaces the one in force.">
                <Input value={upload.code} onChange={(e) => setUpload({ ...upload, code: e.target.value })} placeholder="WI-PD-03-01" autoCapitalize="characters" />
              </Field>
              <Field label="Issue no.">
                <Input value={upload.issueNo} onChange={(e) => setUpload({ ...upload, issueNo: e.target.value })} placeholder="02" />
              </Field>
            </div>
            <Field label="Title">
              <Input value={upload.title} onChange={(e) => setUpload({ ...upload, title: e.target.value })} placeholder="Acceptance limits for welding imperfections" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Issue date">
                <Input type="date" value={upload.issueDate} onChange={(e) => setUpload({ ...upload, issueDate: e.target.value })} />
              </Field>
              <Field label="Applies to">
                <Select value={upload.process} onChange={(e) => setUpload({ ...upload, process: e.target.value as WorkInstructionScope })} className="min-h-[48px]">
                  <option value="all">{SCOPE_LABEL.all}</option>
                  {PROCESSES.map((p) => (
                    <option key={p} value={p}>
                      {PROCESS_LABEL[p]}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label="Shown on step">
              <Select value={upload.step} onChange={(e) => setUpload({ ...upload, step: e.target.value as WorkInstructionStep })} className="min-h-[48px]">
                {WORK_INSTRUCTION_STEPS.map((st) => (
                  <option key={st} value={st}>
                    {WORK_INSTRUCTION_STEP_LABEL[st]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}
      </Modal>

      <Modal
        open={editing !== null}
        onClose={() => {
          if (!busy) setEditing(null)
        }}
        title={editing ? `Edit ${editing.code}` : 'Edit'}
        icon={<Pencil className="h-5 w-5" />}
        footer={
          <>
            <Button className="min-h-[48px]" onClick={() => setEditing(null)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" className="min-h-[48px]" onClick={() => void submitEdit()} disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              Save changes
            </Button>
          </>
        }
      >
        {editing && (
          <div className="space-y-3">
            <Field label="Title">
              <Input value={editDraft.title} onChange={(e) => setEditDraft({ ...editDraft, title: e.target.value })} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Issue no.">
                <Input value={editDraft.issueNo} onChange={(e) => setEditDraft({ ...editDraft, issueNo: e.target.value })} />
              </Field>
              <Field label="Issue date">
                <Input type="date" value={editDraft.issueDate} onChange={(e) => setEditDraft({ ...editDraft, issueDate: e.target.value })} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Applies to">
                <Select value={editDraft.process} onChange={(e) => setEditDraft({ ...editDraft, process: e.target.value as WorkInstructionScope })} className="min-h-[48px]">
                  <option value="all">{SCOPE_LABEL.all}</option>
                  {PROCESSES.map((p) => (
                    <option key={p} value={p}>
                      {PROCESS_LABEL[p]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Shown on step">
                <Select value={editDraft.step} onChange={(e) => setEditDraft({ ...editDraft, step: e.target.value as WorkInstructionStep })} className="min-h-[48px]">
                  {WORK_INSTRUCTION_STEPS.map((st) => (
                    <option key={st} value={st}>
                      {WORK_INSTRUCTION_STEP_LABEL[st]}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <p className="text-xs text-muted">To replace the PDF itself, upload a new issue under the same code.</p>
          </div>
        )}
      </Modal>

      <Modal
        open={removing !== null}
        onClose={() => {
          if (!busy) setRemoving(null)
        }}
        title={removing ? `Remove ${removing.code}?` : 'Remove'}
        icon={<Trash2 className="h-5 w-5" />}
        size="sm"
        footer={
          <>
            <Button className="min-h-[48px]" onClick={() => setRemoving(null)} disabled={busy}>
              Keep it
            </Button>
            <Button variant="danger" className="min-h-[48px]" onClick={() => void submitRemove()} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              Remove
            </Button>
          </>
        }
      >
        {removing && (
          <p className="text-sm text-slate-600 dark:text-slate-300">
            <span className="font-semibold">{removing.title}</span> stops being offered in the wizard. The file stays on record and the removal is written to the audit log.
          </p>
        )}
      </Modal>

      {viewing && <WorkInstructionViewer instruction={viewing} onClose={() => setViewing(null)} />}
    </div>
  )
}
