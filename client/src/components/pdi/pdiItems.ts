// The items of an order as a PDI reads them: its lines grouped by item code
// and name together. One item can run on several machines, each
// line with its own drawing number; the PDI covers the item, so every one of
// its lines, and shows every drawing.

import type { ProductionOrder } from '@qc/shared/types'
import { orderDrawings } from '@qc/shared/rules'

export interface OrderItem {
  key: string
  itemCode: string
  item: string
  drawings: string[]
  lineIds: string[]
  /** The machines the item runs on in this order. */
  machines: string[]
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

export function itemsOfLines(lines: ProductionOrder[]): OrderItem[] {
  const byKey = new Map<string, OrderItem>()
  for (const l of lines) {
    // Code and name together: two items that share a code stay two.
    const key = `${(l.itemCode ?? '').trim()}|${l.item.trim()}`.toLowerCase()
    let it = byKey.get(key)
    if (!it) {
      it = { key, itemCode: l.itemCode ?? '', item: l.item, drawings: [], lineIds: [], machines: [] }
      byKey.set(key, it)
    }
    it.lineIds.push(l.id)
    // Its real drawings: DWG2 when DWG1 is a placeholder such as "(V)".
    for (const drawing of orderDrawings(l)) if (!it.drawings.includes(drawing)) it.drawings.push(drawing)
    if (l.workCenterCode && !it.machines.includes(l.workCenterCode)) it.machines.push(l.workCenterCode)
  }
  return Array.from(byKey.values()).sort((a, b) => collator.compare(a.itemCode || a.item, b.itemCode || b.item) || collator.compare(a.item, b.item))
}
