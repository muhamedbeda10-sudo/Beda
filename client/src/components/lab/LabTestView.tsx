// ============================================================================
// §26 — A test read back: its report as it was judged (the limits copied at
// its save), its row of the machine log, and the coil it came from; printed
// as the paper form, corrected, or deleted by whoever sets the lab up.
// ============================================================================

import { useState } from 'react'
import { Loader2, Printer, Trash2 } from 'lucide-react'
import { LAB_PERMISSIONS, LAB_VERDICT_NAMES, type LabTest } from '@qc/shared/lab'
import { Badge, Button, Modal } from '@/components/ui'
import { usePrint } from '@/components/print/usePrint'
import { useDeleteLabTest, useLabCoil, useLabTest } from '@/services/lab'
import { useAuth } from '@/store/AuthContext'
import { useApp } from '@/store/AppContext'
import { formatDateTime } from '@/lib/utils'
import { LabSheet } from './LabSheet'
import { CoilNote, LogFields, verdictTone } from './LabTestDialog'
import { toDraft, workSaved } from './labDraft'

/** The report on paper, alone: what the browser prints. */
export function LabPaper({ test }: { test: LabTest }) {
  return <div className="print-sheet"><LabSheet mode="paper" data={toDraft(test)} working={workSaved(test)} form={test.form} /></div>
}

export function LabTestView({ id, onClose, onEdit }: { id: string; onClose: () => void; onEdit: (t: LabTest) => void }) {
  const query = useLabTest(id)
  const { can } = useAuth()
  const { toast } = useApp()
  const printer = usePrint()
  const remove = useDeleteLabTest()
  const [confirm, setConfirm] = useState(false)
  const t = query.data
  const coil = useLabCoil(t?.specimenCode ?? '', !!t?.specimenCode)

  async function del() {
    if (!t) return
    try {
      await remove.mutateAsync(t.id)
      toast(`Test ${t.reference} deleted.`, 'success')
      onClose()
    } catch (error) { toast(error instanceof Error ? error.message : 'Could not delete.', 'error') }
  }

  return <>
    <Modal open size="xl" title={t ? <span className="flex items-center gap-2">Test {t.reference} <Badge tone={verdictTone(t.result)}>{LAB_VERDICT_NAMES[t.result]}</Badge></span> : 'Lab test'} onClose={onClose} footer={<>
      {t && can(LAB_PERMISSIONS.setup) && <Button variant="ghost" className="mr-auto text-danger-700 dark:text-danger-400" onClick={() => setConfirm(true)}><Trash2 className="h-4 w-4" />Delete</Button>}
      <Button onClick={onClose}>Close</Button>
      {t && <Button onClick={() => printer.print(<LabPaper test={t} />, { title: `Material Testing Report ${t.reference}`, day: t.testDate, bare: true })}><Printer className="h-4 w-4" />Print</Button>}
      {t && can(LAB_PERMISSIONS.record) && <Button variant="primary" onClick={() => onEdit(t)}>Edit</Button>}
    </>}>
      {query.isPending ? <p className="flex items-center gap-2 text-sm text-muted"><Loader2 className="h-4 w-4 animate-spin" />Loading…</p>
        : query.isError ? <p role="alert" className="text-sm text-danger-600">{query.error.message} <button type="button" className="underline" onClick={() => void query.refetch()}>Retry</button></p>
        : t && <div className="space-y-4">
          <LabSheet mode="view" data={toDraft(t)} working={workSaved(t)} form={t.form} codeNote={t.specimenCode ? <CoilNote lookup={coil.data ? { ...coil.data, tests: coil.data.tests.filter((x) => x.id !== t.id) } : undefined} /> : null} />
          <LogFields draft={toDraft(t)} readOnly averages={{ tensile: t.tensileAvg, yield: t.yieldAvg, elongation: t.elongationAvg }} />
          <p className="text-xs text-muted">{t.source === 'log-import' ? 'Imported from the machine log (its averages only). ' : ''}{t.updatedByName} · {formatDateTime(t.updatedAt)}</p>
        </div>}
    </Modal>
    {confirm && t && <Modal open size="sm" title={`Delete test ${t.reference}?`} onClose={() => setConfirm(false)} footer={<><Button onClick={() => setConfirm(false)}>Keep it</Button><Button variant="danger" disabled={remove.isPending} onClick={() => void del()}>{remove.isPending && <Loader2 className="h-4 w-4 animate-spin" />}Delete</Button></>}>
      <p className="text-sm">It leaves the log, the coil’s page and the assistant. The audit log keeps that it was deleted, and by whom.</p>
    </Modal>}
    {printer.node}
  </>
}
