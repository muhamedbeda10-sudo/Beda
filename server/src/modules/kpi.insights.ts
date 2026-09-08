// ============================================================================
// Insights (§15.4). Plain rules a quality manager would apply by eye, run
// over the overview once it is assembled: a rate past its threshold, a
// trend past the alert line, one defect or one machine carrying most of the
// problem, a Hold left too long. Each rule yields at most one insight, so
// the panel stays short and every line has a reason. Nothing here guesses;
// every sentence quotes the figure it was built from.
// ============================================================================

import { deltaPct, type KpiInsight, type KpiOverview, type KpiThresholds } from '@qc/shared/kpi'

type Draft = Omit<KpiOverview, 'insights'>

const fmt = (n: number | null, digits = 1): string => (n === null ? '—' : n.toFixed(digits))
const pctText = (n: number | null): string => (n === null ? '—' : `${fmt(n)}%`)
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

function defectRateRules(o: Draft, t: KpiThresholds): KpiInsight[] {
  const out: KpiInsight[] = []
  const rate = o.current.defectRatePct
  if (rate === null) return out
  if (rate > t.defectRateAmber) {
    out.push({
      id: 'defect-rate-red',
      severity: 'critical',
      title: `Defect rate is ${pctText(rate)}, above the ${t.defectRateAmber}% limit`,
      detail: `${o.current.defectPieces} defect pieces in ${o.current.pieces} inspected.`,
      action: 'Review the Pareto below and the worst machine; agree a containment before the next shift.',
    })
  } else if (rate > t.defectRateGreen) {
    out.push({
      id: 'defect-rate-amber',
      severity: 'warning',
      title: `Defect rate is ${pctText(rate)}, above the ${t.defectRateGreen}% target`,
      detail: `${o.current.defectPieces} defect pieces in ${o.current.pieces} inspected.`,
      action: 'Watch the daily trend; act on the leading defect before it grows.',
    })
  }
  const delta = deltaPct(rate, o.previous.defectRatePct)
  if (delta !== null && Math.abs(delta) >= t.trendAlertPct && o.previous.pieces > 0) {
    const worse = delta > 0
    out.push({
      id: worse ? 'defect-rate-rising' : 'defect-rate-falling',
      severity: worse ? 'warning' : 'good',
      title: worse
        ? `Defect rate rose ${fmt(Math.abs(delta))}% against the previous period`
        : `Defect rate fell ${fmt(Math.abs(delta))}% against the previous period`,
      detail: `${pctText(o.previous.defectRatePct)} before, ${pctText(rate)} now.`,
      action: worse ? 'Compare the Pareto of both periods: a new defect or an old one growing?' : undefined,
    })
  }
  return out
}

function yieldRules(o: Draft, t: KpiThresholds): KpiInsight[] {
  const out: KpiInsight[] = []
  const fpy = o.current.fpyPct
  if (fpy !== null && o.current.samples >= 5) {
    if (fpy < t.fpyAmber) {
      out.push({
        id: 'fpy-red',
        severity: 'critical',
        title: `First-pass yield is ${pctText(fpy)}, below the ${t.fpyAmber}% floor`,
        detail: `Only ${Math.round((fpy / 100) * o.current.samples)} of ${o.current.samples} samples passed with nothing to record.`,
        action: 'Every sample is finding something: check setup and first-piece approval on the machines with the lowest yield.',
      })
    } else if (fpy < t.fpyGreen) {
      out.push({
        id: 'fpy-amber',
        severity: 'warning',
        title: `First-pass yield is ${pctText(fpy)}, below the ${t.fpyGreen}% target`,
        detail: `${o.current.samples} samples in the period.`,
      })
    }
  }
  const dimFail = o.current.dimFailPct
  if (dimFail !== null && o.current.dimensionsMeasured >= 20 && dimFail > t.dimFailAmber) {
    out.push({
      id: 'dim-fail-red',
      severity: 'critical',
      title: `${pctText(dimFail)} of measured dimensions are out of tolerance`,
      detail: `${o.current.dimensionsFail} failed of ${o.current.dimensionsMeasured} measured, ${o.current.dimensionsWarning} in the warning band.`,
      action: 'Look at the capability table: a low Cpk with a mean off nominal is a setup problem, a low Cp is a machine problem.',
    })
  } else if (dimFail !== null && o.current.dimensionsMeasured >= 20 && dimFail > t.dimFailGreen) {
    out.push({
      id: 'dim-fail-amber',
      severity: 'warning',
      title: `${pctText(dimFail)} of measured dimensions are out of tolerance`,
      detail: `${o.current.dimensionsFail} failed of ${o.current.dimensionsMeasured} measured.`,
    })
  }
  return out
}

function paretoRules(o: Draft): KpiInsight[] {
  const top = o.pareto[0]
  if (!top || o.current.defectPieces < 10) return []
  if (top.sharePct >= 40) {
    return [
      {
        id: 'pareto-concentrated',
        severity: 'warning',
        title: `"${top.defectName}" alone is ${fmt(top.sharePct, 0)}% of all defect pieces`,
        detail: `${top.pieces} pieces in ${plural(top.records, 'record')}. Removing one cause halves the problem.`,
        action: 'Open a corrective action on this defect: root cause, containment, and a check in the next period.',
      },
    ]
  }
  const vital = o.pareto.filter((r) => r.cumulativePct <= 80).length
  if (vital >= 1 && o.pareto.length >= 4) {
    return [
      {
        id: 'pareto-vital-few',
        severity: 'info',
        title: `${plural(vital, 'defect')} make up 80% of defect pieces`,
        detail: o.pareto
          .slice(0, vital)
          .map((r) => `${r.defectName} ${fmt(r.sharePct, 0)}%`)
          .join(', '),
        action: 'Work these first; the rest is noise until they are down.',
      },
    ]
  }
  return []
}

function outlierRule(
  id: string,
  rows: { label: string; sub?: string; pieces: number; defectRatePct: number | null; key: string }[],
  overall: number | null,
  noun: string,
  link: 'machine' | 'item',
): KpiInsight | null {
  if (overall === null || overall <= 0) return null
  const candidates = rows.filter((r) => r.pieces >= 30 && r.defectRatePct !== null && r.defectRatePct >= overall * 2 && r.defectRatePct > 1)
  if (candidates.length === 0) return null
  const worst = candidates.sort((a, b) => (b.defectRatePct ?? 0) - (a.defectRatePct ?? 0))[0]
  return {
    id,
    severity: (worst.defectRatePct ?? 0) >= overall * 3 ? 'critical' : 'warning',
    title: `${noun} ${worst.label} runs at ${pctText(worst.defectRatePct)}, ${fmt((worst.defectRatePct ?? 0) / overall, 1)}× the overall rate`,
    detail: `${worst.pieces} pieces inspected${worst.sub ? ` · ${worst.sub}` : ''}. Overall ${pctText(overall)}.`,
    action: link === 'machine' ? 'Walk the machine: setup sheet, tooling wear, and the operator on the worst shift.' : 'Check the drawing revision and the tooling for this item before the next run.',
    link: { kind: link, value: worst.key },
  }
}

function capabilityRules(o: Draft, t: KpiThresholds): KpiInsight[] {
  const weak = o.dimensions.filter((d) => d.cpk !== null && d.readings >= t.minReadingsForCpk && d.cpk < t.cpkAmber)
  if (weak.length === 0) return []
  const worst = weak[0]
  const offCentre = worst.centering !== null && Math.abs(worst.centering) >= 0.5
  return [
    {
      id: 'cpk-low',
      severity: worst.cpk !== null && worst.cpk < t.cpkAmber * 0.75 ? 'critical' : 'warning',
      title: `${plural(weak.length, 'dimension')} below Cpk ${t.cpkAmber}; worst is "${worst.name}" on ${worst.itemCode} at ${fmt(worst.cpk, 2)}`,
      detail: `${worst.readings} readings, mean ${fmt(worst.mean, 2)} ${worst.unit} against nominal ${fmt(worst.nominal, 2)}; Cp ${fmt(worst.cp, 2)}.`,
      action: offCentre
        ? 'The mean sits off nominal: re-centre the setup, the spread itself is acceptable.'
        : 'The spread is too wide for the tolerance: check the machine, not the setup.',
      link: { kind: 'item', value: worst.itemCode },
    },
  ]
}

function supplierRules(o: Draft): KpiInsight[] {
  const overall = o.current.defectRatePct
  if (overall === null || overall <= 0) return []
  const rows = o.suppliers.filter((s) => s.pieces >= 30 && s.defectRatePct !== null && s.defectRatePct >= overall * 2 && s.defectRatePct > 1)
  if (rows.length === 0) return []
  const worst = rows.sort((a, b) => (b.defectRatePct ?? 0) - (a.defectRatePct ?? 0))[0]
  return [
    {
      id: 'supplier-outlier',
      severity: 'warning',
      title: `Coils from ${worst.supplier} (${worst.grade}) show ${pctText(worst.defectRatePct)} defects, ${fmt((worst.defectRatePct ?? 0) / overall, 1)}× the overall rate`,
      detail: `${worst.pieces} pieces from ${plural(worst.samples, 'sample')} on this material.`,
      action: 'Raise it with procurement with the coil numbers from History; hold incoming material of this grade for inspection.',
    },
  ]
}

function wireRules(o: Draft, t: KpiThresholds): KpiInsight[] {
  const out: KpiInsight[] = []
  const rate = o.current.ptRejectPct
  if (rate !== null && o.current.ptLengthsTested >= 10 && rate > t.ptRejectAmber) {
    out.push({
      id: 'pt-reject-red',
      severity: 'critical',
      title: `${pctText(rate)} of PT weld lengths rejected`,
      detail: `${o.current.ptLengthsRejected} of ${o.current.ptLengthsTested} lengths tested.`,
      action: 'Check wire batch, gas flow and the welder settings on the lines with rejects.',
    })
  }
  const bad = o.wireBatches.filter((w) => w.lengthsTested >= 10 && w.rejectPct !== null && w.rejectPct > t.ptRejectAmber)
  if (bad.length > 0) {
    const worst = bad.sort((a, b) => (b.rejectPct ?? 0) - (a.rejectPct ?? 0))[0]
    out.push({
      id: 'wire-batch',
      severity: 'warning',
      title: `Wire batch ${worst.batch} rejects ${pctText(worst.rejectPct)} of tested lengths`,
      detail: `${worst.lengthsRejected} of ${worst.lengthsTested} lengths.`,
      action: 'Quarantine the batch and test a length from another batch on the same machine to separate wire from welder.',
    })
  }
  return out
}

function holdRules(o: Draft, t: KpiThresholds): KpiInsight[] {
  if (o.holds.length === 0) return []
  const red = o.holds.filter((h) => h.ageDays >= t.holdAgeRedDays)
  const amber = o.holds.filter((h) => h.ageDays >= t.holdAgeAmberDays && h.ageDays < t.holdAgeRedDays)
  const pieces = o.holds.reduce((n, h) => n + h.qty, 0)
  if (red.length > 0) {
    const oldest = red.sort((a, b) => b.ageDays - a.ageDays)[0]
    return [
      {
        id: 'hold-aging-red',
        severity: 'critical',
        title: `${plural(red.length, 'defect')} on Hold for ${t.holdAgeRedDays}+ days`,
        detail: `Oldest: ${oldest.defectName} on order ${oldest.orderNumber} (${oldest.item}), ${plural(oldest.ageDays, 'day')}. ${pieces} pieces on Hold in total.`,
        action: 'Decide each one today: rework, use-as-is or scrap. Material on Hold blocks the line and the invoice.',
        link: { kind: 'history-hold', value: 'Hold' },
      },
    ]
  }
  if (amber.length > 0) {
    return [
      {
        id: 'hold-aging-amber',
        severity: 'warning',
        title: `${plural(amber.length, 'defect')} on Hold for ${t.holdAgeAmberDays}+ days`,
        detail: `${pieces} pieces on Hold in total across ${plural(o.holds.length, 'defect')}.`,
        action: 'Set the disposition before they pass the red line.',
        link: { kind: 'history-hold', value: 'Hold' },
      },
    ]
  }
  return [
    {
      id: 'hold-open',
      severity: 'info',
      title: `${plural(o.holds.length, 'defect')} on Hold, ${pieces} pieces`,
      detail: 'All within the age limit.',
      link: { kind: 'history-hold', value: 'Hold' },
    },
  ]
}

function idleRules(o: Draft, t: KpiThresholds): KpiInsight[] {
  if (o.idleMachines.length === 0) return []
  const never = o.idleMachines.filter((m) => m.daysSinceSample === null)
  const list = o.idleMachines
    .slice(0, 4)
    .map((m) => `${m.label}${m.daysSinceSample === null ? ' (never)' : ` (${plural(m.daysSinceSample, 'day')})`}`)
    .join(', ')
  return [
    {
      id: 'idle-machines',
      severity: never.length > 0 || o.idleMachines.length >= 3 ? 'warning' : 'info',
      title: `${plural(o.idleMachines.length, 'machine')} with open orders and no sample for ${t.idleMachineDays}+ days`,
      detail: `${list}${o.idleMachines.length > 4 ? ` and ${o.idleMachines.length - 4} more` : ''}.`,
      action: 'Either the machine is not running or nobody is inspecting it; both are worth a walk.',
      link: { kind: 'machine', value: o.idleMachines[0].workCenterCode },
    },
  ]
}

function disciplineRules(o: Draft): KpiInsight[] {
  const out: KpiInsight[] = []
  const d = o.discipline
  if (d.coveragePct !== null && d.openLines >= 5 && d.coveragePct < 50) {
    out.push({
      id: 'coverage-low',
      severity: 'warning',
      title: `Only ${pctText(d.coveragePct)} of open order lines were inspected this period`,
      detail: `${d.openLinesInspected} of ${d.openLines} open lines have a sample.`,
      action: 'Plan inspections against the open lines, not only where the inspector happens to be.',
    })
  }
  if (d.emptyOpenSessions >= 3) {
    out.push({
      id: 'empty-sessions',
      severity: 'info',
      title: `${plural(d.emptyOpenSessions, 'open session')} with no sample`,
      detail: 'Started and left. They clutter the board and hide the real work.',
      action: 'Ask the owners to discard or record; a session without a sample cannot be closed.',
    })
  }
  if (d.closedWithoutFinalQty >= 3) {
    out.push({
      id: 'no-final-qty',
      severity: 'info',
      title: `${plural(d.closedWithoutFinalQty, 'session')} closed without a final quantity`,
      detail: 'The produced quantity is what the defect rate per order is measured against.',
      action: 'Remind inspectors to enter the final quantity at close.',
    })
  }
  if (d.typedCoilPct !== null && d.typedCoilPct > 30 && d.notes >= 0) {
    out.push({
      id: 'typed-coils',
      severity: 'info',
      title: `${pctText(d.typedCoilPct)} of coils were typed by hand instead of picked from the register`,
      detail: 'Typed coils carry no supplier, grade or certificate, so supplier analysis misses them.',
      action: 'Keep the coil register current so inspectors can pick, not type.',
    })
  }
  if (o.current.samples >= 20 && d.samplesReRecorded + d.corrections >= Math.max(5, o.current.samples * 0.1)) {
    out.push({
      id: 'many-corrections',
      severity: 'info',
      title: `${plural(d.samplesReRecorded, 'sample')} re-recorded and ${plural(d.corrections, 'correction')} in the period`,
      detail: 'A high rate of corrections usually means the first entry is rushed or the tablet is hard to use at the station.',
    })
  }
  return out
}

function inspectorRules(o: Draft): KpiInsight[] {
  const rows = o.byInspector.filter((r) => r.sessions >= 3)
  if (rows.length < 3) return []
  const avg = rows.reduce((n, r) => n + r.samples / r.sessions, 0) / rows.length
  if (!(avg > 0)) return []
  const low = rows.filter((r) => r.samples / r.sessions <= avg * 0.5)
  if (low.length === 0) return []
  const worst = low.sort((a, b) => a.samples / a.sessions - b.samples / b.sessions)[0]
  return [
    {
      id: 'inspector-samples-low',
      severity: 'info',
      title: `${worst.label} records ${fmt(worst.samples / worst.sessions, 1)} samples per session; the team averages ${fmt(avg, 1)}`,
      detail: `${plural(worst.sessions, 'session')}, ${plural(worst.samples, 'sample')}.`,
      action: 'Could be short runs, could be sampling too thin. Worth a conversation, not a conclusion.',
    },
  ]
}

function shiftRules(o: Draft): KpiInsight[] {
  const rows = o.byShift.filter((r) => r.pieces >= 50 && r.defectRatePct !== null)
  if (rows.length < 2) return []
  const sorted = [...rows].sort((a, b) => (b.defectRatePct ?? 0) - (a.defectRatePct ?? 0))
  const worst = sorted[0]
  const best = sorted[sorted.length - 1]
  if ((best.defectRatePct ?? 0) <= 0 || (worst.defectRatePct ?? 0) < (best.defectRatePct ?? 0) * 2 || (worst.defectRatePct ?? 0) <= 1) return []
  return [
    {
      id: 'shift-outlier',
      severity: 'warning',
      title: `Shift ${worst.label} runs at ${pctText(worst.defectRatePct)} defects, shift ${best.label} at ${pctText(best.defectRatePct)}`,
      detail: `${worst.pieces} and ${best.pieces} pieces inspected respectively.`,
      action: 'Same machines, different results: look at handover, supervision and lighting on the worse shift.',
    },
  ]
}

function goodRules(o: Draft, t: KpiThresholds, count: number): KpiInsight[] {
  if (count > 0 || o.current.samples < 5) return []
  return [
    {
      id: 'on-target',
      severity: 'good',
      title: 'Every KPI is on target for this period',
      detail: `Defect rate ${pctText(o.current.defectRatePct)} (target ≤ ${t.defectRateGreen}%), first-pass yield ${pctText(o.current.fpyPct)} (target ≥ ${t.fpyGreen}%), ${o.holds.length} defects on Hold.`,
    },
  ]
}

const ORDER: Record<KpiInsight['severity'], number> = { critical: 0, warning: 1, info: 2, good: 3 }

export function buildInsights(o: Draft, t: KpiThresholds): KpiInsight[] {
  if (o.current.samples === 0) {
    return [
      {
        id: 'no-data',
        severity: 'info',
        title: 'No samples recorded in this period with these filters',
        detail: 'Widen the period or clear a filter.',
      },
    ]
  }
  const list: KpiInsight[] = [
    ...defectRateRules(o, t),
    ...yieldRules(o, t),
    ...paretoRules(o),
    ...capabilityRules(o, t),
    ...supplierRules(o),
    ...wireRules(o, t),
    ...holdRules(o, t),
    ...idleRules(o, t),
    ...disciplineRules(o),
    ...inspectorRules(o),
    ...shiftRules(o),
  ]
  const machine = outlierRule('machine-outlier', o.byMachine, o.current.defectRatePct, 'Machine', 'machine')
  if (machine) list.push(machine)
  const item = outlierRule('item-outlier', o.byItem, o.current.defectRatePct, 'Item', 'item')
  if (item) list.push(item)
  const problems = list.filter((i) => i.severity === 'critical' || i.severity === 'warning').length
  list.push(...goodRules(o, t, problems))
  return list.sort((a, b) => ORDER[a.severity] - ORDER[b.severity])
}
