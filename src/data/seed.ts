import type {
  DB,
  Machine,
  ProductionOrder,
  InspectionSession,
  InspectionSample,
  DimensionResult,
  VisualDefectResult,
  DefectType,
  DimensionSpec,
  GradeMapping,
  PTConsumable,
  AuditLog,
} from '@/types'
import { evalDimension, rollupSample } from '@/lib/utils'

// Deterministic pseudo-random so seed data is stable across reloads.
let s = 987654321
function rnd(): number {
  s = (s * 1103515245 + 12345) & 0x7fffffff
  return s / 0x7fffffff
}
function pick<T>(arr: T[]): T {
  return arr[Math.floor(rnd() * arr.length)]
}
function rint(lo: number, hi: number): number {
  return Math.floor(rnd() * (hi - lo + 1)) + lo
}
function daysAgo(days: number, hour = 9, min = 0): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  d.setHours(hour, min, 0, 0)
  return d.toISOString()
}

let n = 0
const id = (p: string) => `${p}_${(++n).toString(36)}_${Math.floor(rnd() * 1e6).toString(36)}`

// ---- Machines --------------------------------------------------------------
const machines: Machine[] = [
  { id: 'm7', code: '7', name: '7-Paint Sample Line', kind: 'Paint Sample', active: true },
  { id: 'm11', code: '11', name: '11-Paint Sample Booth', kind: 'Paint Sample', active: true },
  { id: 'm48', code: '48', name: '48-Painting Line-LM4', kind: 'Paint Sample', active: true },
  { id: 'm58', code: '58-A', name: '58-A. Welding Line-LM4', kind: 'Welding', active: true },
  { id: 'm24', code: '24', name: '24-Stamping Upright', kind: 'Stamping', active: true },
  { id: 'm31', code: '31', name: '31-Roll Forming', kind: 'Roll Forming', active: true },
  { id: 'm42', code: '42', name: '42-Assembly Cell', kind: 'Assembly', active: true },
  { id: 'm60', code: '60', name: '60-Packing Bay', kind: 'Packing', active: true },
]

// ---- Lookup: dimension specs ----------------------------------------------
const dimensionSpecs: DimensionSpec[] = [
  { id: 'ds_t', code: 'T', name: 'Thickness', target: 2.5, tolMinus: 0.15, tolPlus: 0.15, unit: 'mm', active: true },
  { id: 'ds_w', code: 'W', name: 'Width', target: 125.0, tolMinus: 0.5, tolPlus: 0.5, unit: 'mm', active: true },
  { id: 'ds_l', code: 'L', name: 'Length', target: 2500, tolMinus: 2, tolPlus: 2, unit: 'mm', active: true },
  { id: 'ds_h', code: 'H', name: 'Hole Pitch H', target: 40.0, tolMinus: 0.3, tolPlus: 0.3, unit: 'mm', active: true },
  { id: 'ds_j', code: 'J', name: 'Slot J', target: 18.0, tolMinus: 0.25, tolPlus: 0.25, unit: 'mm', active: true },
  { id: 'ds_k', code: 'K', name: 'Flange K', target: 22.0, tolMinus: 0.3, tolPlus: 0.3, unit: 'mm', active: true },
  { id: 'ds_n', code: 'N', name: 'Notch N', target: 12.0, tolMinus: 0.2, tolPlus: 0.2, unit: 'mm', active: true },
]

// ---- Lookup: defect types (bilingual) -------------------------------------
const defectTypes: DefectType[] = [
  { id: 'dt1', code: 'DIM-01', title: 'ترحيل فى الابعاد', description: 'Dimensional drift beyond tolerance', defaultSeverity: 'Major', active: true },
  { id: 'dt2', code: 'PNT-02', title: 'عيب فى الدهان', description: 'Paint run / orange peel / low DFT', defaultSeverity: 'Minor', active: true },
  { id: 'dt3', code: 'WLD-03', title: 'عيب لحام', description: 'Weld porosity / undercut', defaultSeverity: 'Critical', active: true },
  { id: 'dt4', code: 'SUR-04', title: 'خدش سطحى', description: 'Surface scratch', defaultSeverity: 'Minor', active: true },
  { id: 'dt5', code: 'BUR-05', title: 'زوائد قص', description: 'Burr / sharp edge', defaultSeverity: 'Major', active: true },
  { id: 'dt6', code: 'HOL-06', title: 'انحراف ثقوب', description: 'Hole misalignment', defaultSeverity: 'Major', active: true },
]

const defectSentences = [
  'البعد K خارج التجاوز من ٣ مم الى ٣.٥ مم',
  'الابعاد (H,J,K) خارج التجاوز ب ٢.٨ مم',
  'البعد N خارج التجاوز من 2.2 مم الى 2.5 مم',
  'خدش سطحى على الوجه الأمامى للعينة',
  'زوائد قص واضحة على الحافة السفلية',
  'انحراف فى مركز الثقب رقم 3',
]

// ---- Lookup: grade mappings ------------------------------------------------
const gradeMappings: GradeMapping[] = [
  { id: 'g_a', grade: 'A', minPassRate: 98, maxDefectRate: 1, color: '#16a34a', label: 'Premium' },
  { id: 'g_b', grade: 'B', minPassRate: 95, maxDefectRate: 3, color: '#2563eb', label: 'Standard' },
  { id: 'g_c', grade: 'C', minPassRate: 90, maxDefectRate: 6, color: '#f59e0b', label: 'Conditional' },
  { id: 'g_d', grade: 'D', minPassRate: 0, maxDefectRate: 100, color: '#dc2626', label: 'Reject' },
]

// ---- Lookup: PT consumables ------------------------------------------------
const ptConsumables: PTConsumable[] = [
  { id: 'pt1', code: 'PEN-RED-7', name: 'Red Penetrant SKL-SP2', type: 'Penetrant', batch: 'B24-0417', expiry: '2027-04-01', active: true },
  { id: 'pt2', code: 'DEV-WHT-9', name: 'Developer SKD-S2', type: 'Developer', batch: 'B24-0511', expiry: '2027-05-01', active: true },
  { id: 'pt3', code: 'CLN-SOL-3', name: 'Cleaner/Remover SKC-S', type: 'Cleaner', batch: 'B24-0388', expiry: '2026-12-01', active: true },
]

// ---- Orders ----------------------------------------------------------------
const items = [
  { name: 'XL Light Beam', code: '125185TA3', route: 'Export' },
  { name: 'Shuttle Beam', code: 'LB406015-5TA3', route: 'Local' },
  { name: 'Walkway Mesh', code: 'WM220-4T2', route: 'Export' },
  { name: 'XL Upright', code: 'UP90-3T3', route: 'Local' },
  { name: 'Bracing Angle', code: 'BA45-2T2', route: 'Export' },
  { name: 'Base Plate', code: 'BP160-6T4', route: 'Local' },
]
const colors = ['YW1104', 'BL2207', 'GR3310', 'OR5502', 'RAL7016']
const inspectors = ['Mohamed Abdelrahman', 'Mahmoud Gaafar', 'QC2', 'Ahmed Samir', 'Karim Hosny']

const orders: ProductionOrder[] = []
const orderSuffix = ['QC1-HYH', 'Ph2.2B-EHF', 'Ph1.4-SMA', 'EHF', 'Ph6.1-KLM', 'Ph3.3-TRT', 'Ph1.1-NBX', 'QC2-PLM']
for (let i = 0; i < 26; i++) {
  const it = items[i % items.length]
  const machine = machines[i % machines.length]
  const req = rint(80, 2600)
  const fin = rnd() < 0.35 ? req : rint(0, req)
  const base = 20000 + rint(80, 620)
  orders.push({
    id: id('o'),
    orderId: `${base}-${orderSuffix[i % orderSuffix.length]}`,
    item: it.name,
    itemCode: it.code,
    machineId: machine.id,
    requiredQty: req,
    finishedQty: fin,
    color: pick(colors),
    drawing: `(V), BS9059 / ${rint(20, 60)}`,
    route: it.route,
    date: daysAgo(rint(1, 120)),
    status: pick<ProductionOrder['status']>(['Active', 'Active', 'Active', 'On Hold', 'Completed']),
    coverage: 'Not Started',
    nominalT: 2 + rnd(),
    nominalW: 90 + rint(0, 60),
    nominalL: [1350, 2500, 2900, 3000][i % 4],
  })
}
// A few pinned orders that match the screenshots exactly
orders[0] = { ...orders[0], orderId: '20095-QC1-HYH', item: 'XL Light Beam', itemCode: '125185TA3', machineId: 'm58', nominalL: 2500, color: 'SW' as string, requiredQty: 2, finishedQty: 2 }
orders[1] = { ...orders[1], orderId: '19868-Ph2.2B-EHF', item: 'XL Light Beam', itemCode: '125185TA3', machineId: 'm58', nominalL: 2900, color: 'SW' as string, requiredQty: 2176, finishedQty: 2176, drawing: '(V), BS9059 / 35', route: 'Export' }
orders[2] = { ...orders[2], orderId: '20480-Ph1.4-SMA', item: 'Shuttle Beam', itemCode: 'LB406015-5TA3', machineId: 'm48', nominalL: 1350 }
orders[3] = { ...orders[3], orderId: '20389-EHF', item: 'Walkway Mesh', itemCode: 'WM220-4T2', machineId: 'm48' }
orders[4] = { ...orders[4], orderId: '20194-Ph6.1-KLM', item: 'XL Upright', itemCode: 'UP90-3T3', machineId: 'm24' }

// ---- Sessions / samples / dimensions / defects ----------------------------
const sessions: InspectionSession[] = []
const samples: InspectionSample[] = []
const dimensions: DimensionResult[] = []
const defects: VisualDefectResult[] = []
const audit: AuditLog[] = []

const orderSeq: Record<string, number> = {}

function makeSampleData(session: InspectionSession, count: number, machineKind: string) {
  for (let sIdx = 1; sIdx <= count; sIdx++) {
    const sample: InspectionSample = {
      id: id('smp'),
      sessionId: session.id,
      index: sIdx,
      label: `${sIdx}-1`,
      coilId: `C${rint(10000, 99999)}`,
      result: 'Pending',
      createdAt: session.startedAt,
      inspector: session.inspector,
    }
    // dimensions: pick 3-5 specs
    const specCount = rint(3, 5)
    const chosen = [...dimensionSpecs].sort(() => rnd() - 0.5).slice(0, specCount)
    const dimResults: DimensionResult[] = []
    for (const spec of chosen) {
      // Mostly in spec, sometimes fail
      const fail = rnd() < 0.14
      const drift = fail
        ? (spec.tolPlus + 0.2 + rnd() * 0.5) * (rnd() < 0.5 ? -1 : 1)
        : (rnd() - 0.5) * (spec.tolPlus + spec.tolMinus) * 0.85
      const measured = machineKind === 'Paint Sample' ? spec.target : +(spec.target + drift).toFixed(2)
      const dr: DimensionResult = {
        id: id('dim'),
        sampleId: sample.id,
        code: spec.code,
        name: spec.name,
        target: spec.target,
        tolMinus: spec.tolMinus,
        tolPlus: spec.tolPlus,
        measured: machineKind === 'Paint Sample' ? null : measured,
        unit: spec.unit,
        result: 'Pending',
      }
      dr.result = evalDimension(dr)
      dimResults.push(dr)
      dimensions.push(dr)
    }
    // defects: occasionally
    const defList: VisualDefectResult[] = []
    if (rnd() < 0.3) {
      const dcount = rint(1, 3)
      for (let d = 0; d < dcount; d++) {
        const dt = pick(defectTypes)
        const disp = pick<VisualDefectResult['disposition']>(['Rejected', 'Hold', 'Accepted'])
        const def: VisualDefectResult = {
          id: id('def'),
          sampleId: sample.id,
          defectCode: dt.code,
          title: dt.title,
          description: pick(defectSentences),
          severity: dt.defaultSeverity,
          qty: rint(1, 9),
          disposition: disp,
        }
        defList.push(def)
        defects.push(def)
      }
    }
    sample.result = rollupSample(
      dimResults.map((d) => d.result),
      defList.map((d) => d.disposition),
    )
    samples.push(sample)
  }
}

// Build ~40 sessions across orders/time
for (let i = 0; i < 42; i++) {
  const order = orders[rint(0, orders.length - 1)]
  const machine = machines.find((m) => m.id === order.machineId)!
  orderSeq[order.id] = (orderSeq[order.id] || 0) + 1
  const dayOffset = rint(0, 92)
  const closed = i > 6 && rnd() < 0.72
  const started = daysAgo(dayOffset, rint(7, 17), rint(0, 59))
  const session: InspectionSession = {
    id: id('sess'),
    seq: orderSeq[order.id],
    orderId: order.id,
    machineId: machine.id,
    inspector: pick(inspectors),
    startedAt: started,
    closedAt: closed ? daysAgo(dayOffset, rint(17, 20)) : undefined,
    status: closed ? 'Closed' : 'Open',
    confirm: rnd() < 0.7 ? 'Confirmed' : 'Pending',
    finalQty: closed ? rint(0, order.requiredQty) : undefined,
    note: undefined,
  }
  sessions.push(session)
  makeSampleData(session, rint(1, 4), machine.kind)
  // update order coverage
  order.coverage = closed ? 'Inspected' : 'In Progress'
}

// A couple of explicitly-open sessions matching screenshots (top of list)
sessions.unshift(
  {
    id: 'sess_pin1',
    seq: 1,
    orderId: orders[2].id, // 20480-Ph1.4-SMA
    machineId: 'm48',
    inspector: 'QC2',
    startedAt: daysAgo(0, 9, 28),
    status: 'Open',
    confirm: 'Confirmed',
  },
  {
    id: 'sess_pin2',
    seq: 1,
    orderId: orders[3].id, // 20389-EHF
    machineId: 'm48',
    inspector: 'QC2',
    startedAt: daysAgo(1, 14, 58),
    closedAt: daysAgo(1, 15, 40),
    status: 'Closed',
    confirm: 'Confirmed',
    finalQty: 48,
  },
)
makeSampleData(sessions[0], 1, 'Paint Sample')
makeSampleData(sessions[1], 1, 'Paint Sample')

// ---- Audit logs ------------------------------------------------------------
const auditActions: AuditLog['action'][] = ['create', 'update', 'close', 'import', 'update', 'create']
for (let i = 0; i < 60; i++) {
  const sess = pick(sessions)
  const order = orders.find((o) => o.id === sess.orderId)!
  const action = pick(auditActions)
  audit.push({
    id: id('aud'),
    at: daysAgo(rint(0, 90), rint(6, 20), rint(0, 59)),
    user: pick(inspectors),
    action,
    entity: pick(['InspectionSession', 'InspectionSample', 'ProductionOrder', 'DimensionResult', 'VisualDefect']),
    entityRef: order.orderId,
    summary:
      action === 'close'
        ? `Closed session #${sess.seq} for ${order.orderId} (qty ${sess.finalQty ?? 0})`
        : action === 'import'
          ? `Imported production orders from Excel`
          : action === 'create'
            ? `Created record on ${order.orderId}`
            : `Updated record on ${order.orderId}`,
  })
}
audit.sort((a, b) => (a.at < b.at ? 1 : -1))

export function buildSeed(): DB {
  return {
    machines,
    orders,
    sessions,
    samples,
    dimensions,
    defects,
    images: [],
    defectTypes,
    dimensionSpecs,
    gradeMappings,
    ptConsumables,
    audit,
    meta: { version: 1, seededAt: new Date().toISOString() },
  }
}
