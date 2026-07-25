// ============================================================================
// Master data + demo orders for a fresh database.
// Seeded once, only when the database is empty — never overwrites real data.
// ============================================================================

import { collection, doc, getDocs, limit, query, writeBatch } from 'firebase/firestore'
import { getDb } from '@/lib/firebase'
import { COL, stripUndefined } from './repository'
import type {
  Coil,
  GradeMapping,
  ItemDimensionMaster,
  ItemDimensionOrder,
  Machine,
  ProductionOrder,
  PTConsumableProduct,
  WorkCenterDefect,
} from '@/domain/types'

const machines: Machine[] = [
  { id: 'wc7', code: '7', machineNumber: '7', line: 'LM1', name: '7-Paint Sample Line', factory: 'Main' },
  { id: 'wc11', code: '11', machineNumber: '11', line: 'LM2', name: '11-Paint Sample Booth', factory: 'Main' },
  { id: 'wc22', code: '22', machineNumber: '22', line: 'LM3', name: '22-Welding Cell', factory: 'Main' },
  { id: 'wc48', code: '48', machineNumber: '48', line: 'LM4', name: '48-Painting Line-LM4', factory: 'Main' },
  { id: 'wc58', code: '58', machineNumber: '58-A', line: 'LM4', name: '58-A. Welding Line-LM4', factory: 'Main' },
]

const items = [
  { item: 'XL Light Beam', code: '125185TA3', grade: 'S355JR' },
  { item: 'Shuttle Beam', code: 'LB406015-5TA3', grade: 'ST52-3' },
  { item: 'Walkway Mesh', code: 'WM220-4T2', grade: 'DX51D' },
  { item: 'XL Upright', code: 'UP90-3T3', grade: 'S355JR' },
]

const orders: ProductionOrder[] = [
  mkOrder('20480-Ph1.4-SMA', items[1], '48', 1350, 900, 'Alpha Racking'),
  mkOrder('20095-QC1-HYH', items[0], '58', 2500, 2500, 'Beta Storage'),
  mkOrder('19868-Ph2.2B-EHF', items[0], '58', 2176, 2176, 'Beta Storage'),
  mkOrder('20389-EHF', items[2], '48', 480, 210, 'Gamma Logistics'),
  mkOrder('20194-Ph6.1-KLM', items[3], '22', 900, 340, 'Delta Industrial'),
  mkOrder('20551-Ph2.1-TRT', items[0], '7', 600, 120, 'Alpha Racking'),
  mkOrder('20603-QC2-PLM', items[3], '11', 750, 0, 'Delta Industrial'),
]

function mkOrder(
  orderNumber: string,
  it: { item: string; code: string; grade: string },
  wc: string,
  required: number,
  finished: number,
  customer: string,
): ProductionOrder {
  return {
    id: `ord_${orderNumber.replace(/[^a-zA-Z0-9]/g, '_')}`,
    orderNumber,
    item: it.item,
    itemCode: it.code,
    workCenterCode: wc,
    machineId: `wc${wc}`,
    requiredQty: required,
    finishedQty: finished,
    drawing: `BS9059/${wc}`,
    drawingAlt: `BS9059/${wc}-ALT`,
    issue: 'Rev C',
    material: 'Steel',
    expectedGrade: it.grade,
    customer,
    type: 'Export',
    colour: 'RAL7016',
    date: new Date().toISOString(),
  }
}

/** Dimension order per item — drives pre-fill and the sequence the inspector
 *  measures in (§7). */
const dimensionOrder: ItemDimensionOrder[] = [
  dim('XL Light Beam', 'Width', 1, 125, 0.5, 0.5),
  dim('XL Light Beam', 'Thickness', 2, 2.5, 0.15, 0.15),
  dim('XL Light Beam', 'Length', 3, 2500, 2, 2),
  dim('XL Light Beam', 'Hole pitch H', 4, 40, 0.3, 0.3),
  dim('Shuttle Beam', 'Width', 1, 110, 0.5, 0.5),
  dim('Shuttle Beam', 'Thickness', 2, 2.0, 0.1, 0.1),
  dim('Shuttle Beam', 'Length', 3, 1350, 2, 2),
  dim('XL Upright', 'Flange K', 1, 22, 0.3, 0.3),
  dim('XL Upright', 'Slot J', 2, 18, 0.25, 0.25),
  dim('XL Upright', 'Notch N', 3, 12, 0.2, 0.2),
  dim('Walkway Mesh', 'Width', 1, 220, 1, 1),
  dim('Walkway Mesh', 'Thickness', 2, 4, 0.2, 0.2),
]

function dim(
  item: string,
  dimensionName: string,
  sequence: number,
  nominal: number,
  tolPlus: number,
  tolMinus: number,
): ItemDimensionOrder {
  return {
    id: `ido_${item.replace(/\W/g, '')}_${dimensionName.replace(/\W/g, '')}`,
    item,
    dimensionName,
    sequence,
    nominal,
    tolPlus,
    tolMinus,
    unit: 'mm',
  }
}

const dimensionMaster: ItemDimensionMaster[] = [
  {
    id: 'idm_beam_squareness',
    item: 'XL Light Beam',
    dimensionName: 'Squareness',
    nominal: 90,
    tolPlus: 0.5,
    tolMinus: 0.5,
    unit: 'deg',
  },
]

/** Which defects are offered on which work center (§5.1). */
const workCenterDefects: WorkCenterDefect[] = [
  ...['ترحيل فى الابعاد', 'خدش سطحى', 'زوائد قص', 'انحراف ثقوب'].flatMap((name) =>
    ['22', '58'].map((wc) => wcDefect(wc, name)),
  ),
  ...['عيب فى الدهان', 'اختلاف لون', 'سماكة دهان غير مطابقة', 'خدش سطحى', 'فقاعات دهان'].flatMap((name) =>
    ['7', '11', '48'].map((wc) => wcDefect(wc, name)),
  ),
  ...['عيب لحام', 'تشقق لحام', 'مسامية لحام'].map((name) => wcDefect('58', name)),
  ...['عيب لحام', 'مسامية لحام'].map((name) => wcDefect('22', name)),
]

function wcDefect(workCenterCode: string, defectName: string): WorkCenterDefect {
  return {
    id: `wcd_${workCenterCode}_${defectName.replace(/\s/g, '')}`,
    workCenterCode,
    defectName,
  }
}

const gradeMappings: GradeMapping[] = [
  { id: 'gm1', gradeA: 'S355JR', gradeB: 'ST52-3' },
  { id: 'gm2', gradeA: 'ST52-3', gradeB: 'E355' },
  { id: 'gm3', gradeA: 'DX51D', gradeB: 'DX51D+Z' },
]

const ptConsumables: PTConsumableProduct[] = [
  { id: 'ptc1', kind: 'Cleaner', productName: 'SKC-S Cleaner/Remover', lotBatch: 'B24-0388' },
  { id: 'ptc2', kind: 'Penetrant', productName: 'SKL-SP2 Red Penetrant', lotBatch: 'B24-0417' },
  { id: 'ptc3', kind: 'Developer', productName: 'SKD-S2 Developer', lotBatch: 'B24-0511' },
]

const coils: Coil[] = [
  { id: 'coil1', coilNumber: 'C10021', grade: 'S355JR', smType: 'HR', supplier: 'Ezz Steel', thickness: 2.5, width: 1250, yield: 355 },
  { id: 'coil2', coilNumber: 'C10022', grade: 'ST52-3', smType: 'HR', supplier: 'Ezz Steel', thickness: 2.0, width: 1200, yield: 355 },
  { id: 'coil3', coilNumber: 'C10023', grade: 'DX51D', smType: 'GI', supplier: 'Suez Steel', thickness: 4.0, width: 1500, yield: 240 },
  { id: 'coil4', coilNumber: 'C10024', grade: 'E355', smType: 'HR', supplier: 'Beshay Steel', thickness: 3.0, width: 1250, yield: 355 },
]

/**
 * Seed only when empty. Returns false if data already exists, so re-running is
 * safe and can never overwrite real inspection data.
 */
export async function seedMasterDataIfEmpty(): Promise<boolean> {
  const store = getDb()
  const existing = await getDocs(query(collection(store, COL.orders), limit(1)))
  if (!existing.empty) return false

  const batch = writeBatch(store)
  const put = (col: string, rows: Array<{ id: string }>) => {
    for (const r of rows) batch.set(doc(store, col, r.id), stripUndefined(r))
  }
  put(COL.machines, machines)
  put(COL.orders, orders)
  put(COL.itemDimensionOrder, dimensionOrder)
  put(COL.itemDimensionMaster, dimensionMaster)
  put(COL.workCenterDefects, workCenterDefects)
  put(COL.gradeMappings, gradeMappings)
  put(COL.ptConsumables, ptConsumables)
  put(COL.coils, coils)
  await batch.commit()
  return true
}
