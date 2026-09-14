// The overview as sheets: one per table on the screen, numbers left as
// numbers so Excel can chart them. The filter and the thresholds go on the
// first sheet so a saved file says what it measured.

import type { KpiOverview, KpiTotals } from '@qc/shared/kpi'
import type { SheetSpec } from '@/lib/xlsxWrite'
import { shiftName } from '@qc/shared/rules'
import type { ShiftLetter } from '@qc/shared/types'

const TOTAL_ROWS: { key: keyof KpiTotals; label: string }[] = [
  { key: 'sessions', label: 'Sessions started' },
  { key: 'sessionsClosed', label: 'Sessions closed' },
  { key: 'samples', label: 'Samples' },
  { key: 'samplesPerSession', label: 'Samples per session' },
  { key: 'pieces', label: 'Pieces inspected' },
  { key: 'defectPieces', label: 'Defect pieces' },
  { key: 'defectRecords', label: 'Defect records' },
  { key: 'defectRatePct', label: 'Defect rate %' },
  { key: 'fpyPct', label: 'First-pass yield %' },
  { key: 'dimensionsMeasured', label: 'Dimensions measured' },
  { key: 'dimensionsPass', label: 'Dimensions pass' },
  { key: 'dimensionsWarning', label: 'Dimensions warning' },
  { key: 'dimensionsFail', label: 'Dimensions fail' },
  { key: 'dimFailPct', label: 'Dimension fail %' },
  { key: 'ptLengthsTested', label: 'PT lengths tested' },
  { key: 'ptLengthsRejected', label: 'PT lengths rejected' },
  { key: 'ptRejectPct', label: 'PT reject %' },
  { key: 'paintReadings', label: 'Paint readings' },
  { key: 'paintMeanMicrons', label: 'Paint mean µm' },
  { key: 'paintMinMicrons', label: 'Paint min µm' },
  { key: 'activeInspectors', label: 'Active inspectors' },
  { key: 'machinesInspected', label: 'Machines inspected' },
]

export function kpiSheets(o: KpiOverview): SheetSpec[] {
  const f = o.filters
  const summary: SheetSpec = {
    name: 'Summary',
    header: ['KPI', 'Current', 'Previous'],
    rows: [
      ['Period', `${f.from} to ${f.to}`, `${f.prevFrom} to ${f.prevTo}`],
      ['Factory', f.factory ?? 'All', ''],
      ['Machine', f.workCenterCode ?? 'All', ''],
      ['Item code', f.itemCode ?? 'All', ''],
      ['Shift', f.shift ? `${f.shift} (${shiftName(f.shift)})` : 'All', ''],
      ['Generated', o.generatedAt, ''],
      [],
      ...TOTAL_ROWS.map((r) => [r.label, o.current[r.key] as number | null, o.previous[r.key] as number | null]),
      [],
      ['Pieces by disposition', '', ''],
      ...Object.entries(o.current.byDisposition).map(([k, v]) => [k, v ?? null, o.previous.byDisposition[k as keyof typeof o.previous.byDisposition] ?? null]),
      [],
      ['Thresholds', '', ''],
      ...Object.entries(o.thresholds).map(([k, v]) => [k, v, '']),
      [],
      // Every figure above is counted over every record the filters match.
      // The sheets that follow are the largest few of something, so the
      // workbook states how many exist behind each one.
      ['What the list sheets show', 'In this workbook', 'In the period'],
      ['Pareto — defect types', o.pareto.length, o.counts.defectTypes],
      ['Machines', o.byMachine.length, o.counts.machines],
      ['Inspectors', o.byInspector.length, o.counts.inspectors],
      ['Shifts', o.byShift.length, o.counts.shifts],
      ['Items', o.byItem.length, o.counts.items],
      ['Capability — dimensions', o.dimensions.length, o.counts.dimensions],
      ['Suppliers', o.suppliers.length, o.counts.suppliers],
      ['Wire batches', o.wireBatches.length, o.counts.wireBatches],
      ['Holds (oldest first)', o.holds.length, o.counts.holds],
    ],
  }
  const group = (name: string, rows: KpiOverview['byMachine']): SheetSpec => ({
    name,
    header: ['Key', 'Label', 'Detail', 'Sessions', 'Samples', 'Pieces', 'Defect pieces', 'Defect rate %', 'FPY %', 'Dim fail %'],
    rows: rows.map((r) => [r.key, r.label, r.sub ?? '', r.sessions, r.samples, r.pieces, r.defectPieces, r.defectRatePct, r.fpyPct, r.dimFailPct]),
  })
  return [
    summary,
    {
      name: 'Insights',
      header: ['Severity', 'Title', 'Detail', 'Action'],
      rows: o.insights.map((i) => [i.severity, i.title, i.detail, i.action ?? '']),
    },
    {
      name: 'Daily',
      header: ['Day', 'Samples', 'Pieces', 'Defect pieces', 'Defect rate %', 'FPY %'],
      rows: o.daily.map((d) => [d.day, d.samples, d.pieces, d.defectPieces, d.defectRatePct, d.fpyPct]),
    },
    {
      name: 'Pareto',
      header: ['Defect', 'Pieces', 'Records', 'Share %', 'Cumulative %'],
      rows: [
        ...o.pareto.map((p) => [p.defectName, p.pieces, p.records, p.sharePct, p.cumulativePct]),
        // The tail as one row, so the shares add to the period's own total.
        ...(o.paretoOthers ? [[`Others (${o.paretoOthers.types} types)`, o.paretoOthers.pieces, null, o.paretoOthers.sharePct, 100]] : []),
      ],
    },
    group('Machines', o.byMachine),
    group('Inspectors', o.byInspector),
    {
      ...group('Shifts', o.byShift),
      rows: o.byShift.map((r) => [r.key, `${r.label} (${shiftName(r.key as ShiftLetter)})`, '', r.sessions, r.samples, r.pieces, r.defectPieces, r.defectRatePct, r.fpyPct, r.dimFailPct]),
    },
    group('Items', o.byItem),
    {
      name: 'Capability',
      header: ['Item code', 'Item', 'Dimension', 'Unit', 'Readings', 'Mean', 'Std dev', 'Nominal', 'Tol +', 'Tol −', 'Cp', 'Cpk', 'Pass %', 'Fail %'],
      rows: o.dimensions.map((d) => [d.itemCode, d.item, d.name, d.unit, d.readings, d.mean, d.stdDev, d.nominal, d.tolPlus, d.tolMinus, d.cp, d.cpk, d.passPct, d.failPct]),
    },
    {
      name: 'Suppliers',
      header: ['Supplier', 'Grade', 'Samples', 'Pieces', 'Defect pieces', 'Defect rate %'],
      rows: o.suppliers.map((s) => [s.supplier, s.grade, s.samples, s.pieces, s.defectPieces, s.defectRatePct]),
    },
    {
      name: 'Wire batches',
      header: ['Batch', 'Lengths tested', 'Lengths rejected', 'Reject %'],
      rows: o.wireBatches.map((w) => [w.batch, w.lengthsTested, w.lengthsRejected, w.rejectPct]),
    },
    {
      name: 'Holds',
      header: ['Order', 'Item', 'Machine', 'Defect', 'Qty', 'Age (days)', 'Session id', 'Sample id'],
      rows: o.holds.map((h) => [h.orderNumber, h.item, h.workCenterCode, h.defectName, h.qty, h.ageDays, h.sessionId, h.sampleId]),
    },
    {
      name: 'Idle machines',
      header: ['Machine', 'Label', 'Factory', 'Open lines', 'Days since sample'],
      rows: o.idleMachines.map((m) => [m.workCenterCode, m.label, m.factory, m.openLines, m.daysSinceSample]),
    },
    {
      name: 'Discipline',
      header: ['Measure', 'Value'],
      rows: [
        ['Closed without final quantity', o.discipline.closedWithoutFinalQty],
        ['Samples re-recorded', o.discipline.samplesReRecorded],
        ['Field corrections', o.discipline.corrections],
        ['Sessions discarded', o.discipline.sessionsDiscarded],
        ['Typed coils %', o.discipline.typedCoilPct],
        ['Grade acknowledgements', o.discipline.gradeAcknowledgements],
        ['Notes written', o.discipline.notes],
        ['Open sessions without a sample', o.discipline.emptyOpenSessions],
        ['Open lines', o.discipline.openLines],
        ['Open lines inspected', o.discipline.openLinesInspected],
        ['Coverage %', o.discipline.coveragePct],
      ],
    },
  ]
}
