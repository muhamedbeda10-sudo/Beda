// ============================================================================
// §6 — History to Excel. The sessions the filters match on one sheet, their
// samples, measurements and defects on three more, joined by the session's
// Ref (the first characters of its id: a session number repeats across order
// lines, the Ref does not). PDIs: one row per item a PDI covers.
// ============================================================================

import type { HistoryExportResponse, PDIWithOrder } from '@qc/shared/api'
import { PROCESS_LABEL, type Process } from '@qc/shared/types'
import type { SheetSpec } from '@/lib/xlsxWrite'

/** A local date and time that sorts as text: 2026-09-28 14:05. */
function stamp(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const ref = (id: string) => id.slice(0, 8)

export function historySheets(data: HistoryExportResponse): SheetSpec[] {
  const bySession = new Map(data.sessions.map((s) => [s.ref, s]))
  const context = (sessionRef: string) => {
    const s = bySession.get(sessionRef)
    return [ref(sessionRef), s ? `#${s.seq}` : '', s?.orderNumber ?? '', s?.item ?? '', s?.machine ?? '']
  }
  const head = ['Ref', 'Session', 'Order', 'Item', 'Machine']
  return [
    {
      name: 'Sessions',
      header: [...head, 'Item code', 'Customer', 'Factory', 'Process', 'Final product or stages', 'Inspector', 'Started', 'Closed', 'Closed by', 'Status', 'Rejected before release', 'Final qty', 'Produced (stock)', 'Samples', 'Pieces inspected', 'Defect pieces', 'On hold pieces'],
      rows: data.sessions.map((s) => [
        ref(s.ref),
        `#${s.seq}`,
        s.orderNumber,
        s.item,
        s.machine,
        s.itemCode,
        s.customer,
        s.factory,
        s.process ? (PROCESS_LABEL[s.process as Process] ?? s.process) : '',
        s.universalKind === 'final' ? 'Final product' : s.stages.map((x) => `Stage ${x.stage}: ${x.qty}`).join(' · '),
        s.inspectorName,
        stamp(s.startedAt),
        stamp(s.closedAt),
        s.closedByName ?? '',
        s.status,
        s.rejectedBeforeRelease,
        s.finalQty,
        s.producedQty,
        s.samples,
        s.piecesInspected,
        s.defectPieces,
        s.holdPieces,
      ]),
    },
    {
      name: 'Samples',
      header: [...head, 'Sample', 'Recorded', 'Inspector', 'Shift', 'Sample qty', 'Drawing', 'Issue', 'Coils'],
      rows: data.samples.map((x) => [...context(x.sessionRef), x.index, stamp(x.recordedAt), x.inspectorName, x.shift ?? '', x.sampleQty, x.drawing, x.issue, x.coils]),
    },
    {
      name: 'Measurements',
      header: [...head, 'Sample', 'Dimension', 'Nominal', 'Tol +', 'Tol −', 'Unit', 'Actual', 'Result'],
      rows: data.measurements.map((m) => [...context(m.sessionRef), m.sampleIndex, m.name, m.nominal, m.tolPlus, m.tolMinus, m.unit, m.actual, m.status]),
    },
    {
      name: 'Defects',
      header: [...head, 'Sample', 'Defect', 'Qty', 'Disposition', 'Notes'],
      rows: data.defects.map((d) => [...context(d.sessionRef), d.sampleIndex, d.defectName, d.qty, d.disposition, d.notes]),
    },
  ]
}

export function pdiSheets(docs: PDIWithOrder[]): SheetSpec[] {
  return [
    {
      name: 'PDI',
      header: ['Ref', 'Date', 'Order', 'Customer', 'Item', 'Item code', 'Drawing', 'Recorded by', 'Photos', 'Notes'],
      rows: docs.flatMap((d) =>
        (d.items.length ? d.items : [{ itemCode: '', item: '', drawings: [], lineIds: [] }]).map((i) => [
          ref(d.id),
          stamp(d.createdAt),
          d.orderNumber,
          d.customer,
          i.item,
          i.itemCode,
          i.drawings.join(', '),
          d.createdByName,
          d.imageIds.length,
          d.notes ?? '',
        ]),
      ),
    },
  ]
}
