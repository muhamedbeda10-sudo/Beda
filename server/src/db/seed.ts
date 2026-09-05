// ============================================================================
// Demo master data for an EMPTY database — machines, defect names, dimension
// configuration, grade equivalences, PT consumables, a few coils and orders.
// Seeded once, only when there are no production orders yet, so re-running it
// (or leaving SEED_DEMO_DATA on) can never overwrite real data.
// ============================================================================

import type { Db } from './pool'
import { withTransaction } from './pool'

const machines = [
  { code: '7', name: 'Painting Line', line: 'LM1' },
  { code: '11', name: 'Painting Line', line: 'LM2' },
  { code: '22', name: 'Shuttle Welding', line: 'LM3' },
  { code: '48', name: 'Painting Line', line: 'LM4' },
  { code: '58', name: 'A. Welding Line', line: 'LM4' },
]

const items = [
  { item: 'XL Light Beam', code: '125185TA3', grade: 'S355JR' },
  { item: 'Shuttle Beam', code: 'LB406015-5TA3', grade: 'ST52-3' },
  { item: 'Walkway Mesh', code: 'WM220-4T2', grade: 'DX51D' },
  { item: 'XL Upright', code: 'UP90-3T3', grade: 'S355JR' },
]

// One row per order LINE: the ERP's Order ID, the order number, the item, the
// machine. An order number repeats when the order has several lines.
const orders = [
  ['1001', '20480-Ph1.4-SMA', 1, '48', 1350, 900, 'Alpha Racking'],
  ['1002', '20480-Ph1.4-SMA', 3, '58', 400, 0, 'Alpha Racking'],
  ['1003', '20095-QC1-HYH', 0, '58', 2500, 2500, 'Beta Storage'],
  ['1004', '19868-Ph2.2B-EHF', 0, '58', 2176, 2176, 'Beta Storage'],
  ['1005', '20389-EHF', 2, '48', 480, 210, 'Gamma Logistics'],
  ['1006', '20194-Ph6.1-KLM', 3, '22', 900, 340, 'Delta Industrial'],
  ['1007', '20551-Ph2.1-TRT', 0, '7', 600, 120, 'Alpha Racking'],
  ['1008', '20603-QC2-PLM', 3, '11', 750, 0, 'Delta Industrial'],
] as const

// [item index, machine code or null for every machine, dimension, seq, nominal, tol+, tol-]
const dimensionOrder: Array<[number, string | null, string, number, number, number, number]> = [
  [0, null, 'Width', 1, 125, 0.5, 0.5],
  [0, null, 'Thickness', 2, 2.5, 0.15, 0.15],
  [0, null, 'Length', 3, 2500, 2, 2],
  [0, null, 'Hole pitch H', 4, 40, 0.3, 0.3],
  [1, null, 'Width', 1, 110, 0.5, 0.5],
  [1, null, 'Thickness', 2, 2.0, 0.1, 0.1],
  [1, null, 'Length', 3, 1350, 2, 2],
  // On the paint line the same item is judged on coating thickness as well.
  [1, '48', 'Paint thickness', 1, 60, 10, 5],
  [3, null, 'Flange K', 1, 22, 0.3, 0.3],
  [3, null, 'Slot J', 2, 18, 0.25, 0.25],
  [3, null, 'Notch N', 3, 12, 0.2, 0.2],
  [2, null, 'Width', 1, 220, 1, 1],
  [2, null, 'Thickness', 2, 4, 0.2, 0.2],
]

const workCenterDefects: Array<[string, string]> = [
  ...['ترحيل فى الابعاد', 'خدش سطحى', 'زوائد قص', 'انحراف ثقوب'].flatMap((n) => ['22', '58'].map((wc) => [wc, n] as [string, string])),
  ...['عيب فى الدهان', 'اختلاف لون', 'سماكة دهان غير مطابقة', 'خدش سطحى', 'فقاعات دهان'].flatMap((n) =>
    ['7', '11', '48'].map((wc) => [wc, n] as [string, string]),
  ),
  ...['عيب لحام', 'تشقق لحام', 'مسامية لحام'].map((n) => ['58', n] as [string, string]),
  ...['عيب لحام', 'مسامية لحام'].map((n) => ['22', n] as [string, string]),
]

const gradeMappings = [
  ['S355JR', 'ST52-3'],
  ['ST52-3', 'E355'],
  ['DX51D', 'DX51D+Z'],
]

const ptConsumables = [
  ['Cleaner', 'SKC-S Cleaner/Remover', 'B24-0388'],
  ['Penetrant', 'SKL-SP2 Red Penetrant', 'B24-0417'],
  ['Developer', 'SKD-S2 Developer', 'B24-0511'],
]

const coils = [
  ['C10021', 'S355JR', 'HR', 'Ezz Steel', 2.5, 1250, 355],
  ['C10022', 'ST52-3', 'HR', 'Ezz Steel', 2.0, 1200, 355],
  ['C10023', 'DX51D', 'GI', 'Suez Steel', 4.0, 1500, 240],
  ['C10024', 'E355', 'HR', 'Beshay Steel', 3.0, 1250, 355],
]

/** Returns false when the database already holds orders. */
export async function seedDemoDataIfEmpty(db: Db): Promise<boolean> {
  return withTransaction(db, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [8_811_003])
    const { rows } = await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM production_orders')
    if (rows[0].n > 0) return false

    const machineIds = new Map<string, string>()
    for (const m of machines) {
      const { rows: ins } = await tx.query<{ id: string }>(
        `INSERT INTO machines (code, name, line, display_name) VALUES ($1, $2, $3, $4) RETURNING id`,
        [m.code, m.name, m.line, `${m.code}-${m.name}-${m.line}`],
      )
      machineIds.set(m.code, ins[0].id)
    }
    for (const [lineKey, orderNumber, itemIx, wc, required, finished, customer] of orders) {
      const it = items[itemIx]
      await tx.query(
        `INSERT INTO production_orders
           (line_key, order_number, item, item_code, work_center_code, machine_id, required_qty, finished_qty,
            drawing, drawing_alt, issue, material, expected_grade, customer, type, colour, erp_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Rev C','Steel',$11,$12,'Export','RAL7016','Active')`,
        [lineKey, orderNumber, it.item, it.code, wc, machineIds.get(wc) ?? null, required, finished, `BS9059/${wc}`, `BS9059/${wc}-ALT`, it.grade, customer],
      )
    }
    for (const [itemIx, wc, name, seq, nominal, plus, minus] of dimensionOrder) {
      const it = items[itemIx]
      await tx.query(
        `INSERT INTO item_dimension_order (item_code, item, work_center_code, dimension_name, sequence, nominal, tol_plus, tol_minus, unit)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'mm')`,
        [it.code, it.item, wc, name, seq, nominal, plus, minus],
      )
    }
    await tx.query(
      `INSERT INTO item_dimension_master (item_code, item, dimension_name, nominal, tol_plus, tol_minus, unit)
       VALUES ($1, 'XL Light Beam', 'Squareness', 90, 0.5, 0.5, 'deg')`,
      [items[0].code],
    )
    for (const [wc, name] of workCenterDefects) {
      await tx.query(`INSERT INTO work_center_defects (work_center_code, defect_name) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [wc, name])
    }
    for (const [a, b] of gradeMappings) {
      await tx.query(`INSERT INTO grade_mappings (grade_a, grade_b) VALUES ($1, $2)`, [a, b])
    }
    for (const [kind, product, lot] of ptConsumables) {
      await tx.query(`INSERT INTO pt_consumables (kind, product_name, lot_batch) VALUES ($1, $2, $3)`, [kind, product, lot])
    }
    for (const [number, grade, sm, supplier, thickness, width, yld] of coils) {
      await tx.query(
        `INSERT INTO coils (coil_number, grade, sm_type, supplier, thickness, width, yield) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [number, grade, sm, supplier, thickness, width, yld],
      )
    }
    return true
  })
}
