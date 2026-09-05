import { describe, expect, it } from 'vitest'
import { ORDERS_IMPORTER, gradeFromMaterial, normaliseHeader } from './importers'

describe('order sheet from the ERP', () => {
  it('reads the grade out of the raw-material description', () => {
    expect(gradeFromMaterial('RM.ST.CO.HR. : 344 : 1.5 : S315MC : PO')).toBe('S315MC')
    expect(gradeFromMaterial('RM.ST.CO.PRG. : 110 : 1.5 : S350GD+Z275MAC : ZCL')).toBe('S350GD+Z275MAC')
    expect(gradeFromMaterial('Steel')).toBeUndefined()
    expect(gradeFromMaterial('a : b : c : ')).toBeUndefined()
  })

  it('derives the expected grade only when the sheet has none of its own', () => {
    const derive = ORDERS_IMPORTER.derive!
    expect(derive({ material: 'RM.ST.SH.HR. : 1000x3000 : 4 : S315MC : PO' }).expectedGrade).toBe('S315MC')
    expect(derive({ material: 'RM.ST.SH.HR. : 1000x3000 : 4 : S315MC : PO', expectedGrade: 'S275JR' }).expectedGrade).toBe('S275JR')
    expect(derive({ item: 'Beam' }).expectedGrade).toBeUndefined()
  })

  it("maps the Dataverse export's own column names without renaming", () => {
    const headers = ['cr863_accessstatus', 'cr863_color', 'cr863_cusname', 'cr863_dwg1', 'cr863_dwg2', 'cr863_explocal', 'cr863_finished_q', 'cr863_item', 'cr863_itemid', 'cr863_order', 'cr863_orderid', 'cr863_rawmaterialdescription', 'cr863_releasedate', 'cr863_req_q', 'cr863_workcenter']
    const byNorm = new Map(headers.map((h) => [normaliseHeader(h), h]))
    const mapped: Record<string, string | undefined> = {}
    for (const f of ORDERS_IMPORTER.fields) {
      const hit = [f.key, f.label, ...(f.aliases ?? [])].map(normaliseHeader).map((c) => byNorm.get(c)).find(Boolean)
      mapped[f.key] = hit
    }
    expect(mapped.lineKey).toBe('cr863_orderid')
    expect(mapped.orderNumber).toBe('cr863_order')
    expect(mapped.itemCode).toBe('cr863_itemid')
    expect(mapped.item).toBe('cr863_item')
    expect(mapped.workCenterCode).toBe('cr863_workcenter')
    expect(mapped.requiredQty).toBe('cr863_req_q')
    expect(mapped.finishedQty).toBe('cr863_finished_q')
    expect(mapped.drawing).toBe('cr863_dwg1')
    expect(mapped.drawingAlt).toBe('cr863_dwg2')
    expect(mapped.material).toBe('cr863_rawmaterialdescription')
    expect(mapped.customer).toBe('cr863_cusname')
    expect(mapped.type).toBe('cr863_explocal')
    expect(mapped.colour).toBe('cr863_color')
    expect(mapped.erpStatus).toBe('cr863_accessstatus')
    expect(mapped.date).toBe('cr863_releasedate')
    expect(mapped.expectedGrade).toBeUndefined()
  })
})

describe('cell coercion', () => {
  it('turns a spreadsheet date into an ISO timestamp and names a bad one', async () => {
    const { coerceCell, ORDERS_IMPORTER } = await import('./importers')
    const date = ORDERS_IMPORTER.fields.find((f) => f.key === 'date')!
    expect(coerceCell(date, '2026-08-30 10:00:52')).toEqual({ value: new Date('2026-08-30 10:00:52').toISOString() })
    expect(coerceCell(date, '2026-08-30')).toEqual({ value: new Date('2026-08-30').toISOString() })
    expect(coerceCell(date, '10:00:52')).toEqual({ error: 'Date is not a date ("10:00:52")' })
    const qty = ORDERS_IMPORTER.fields.find((f) => f.key === 'requiredQty')!
    expect(coerceCell(qty, '1,350')).toEqual({ value: 1350 })
    expect(coerceCell(qty, 'many')).toEqual({ error: 'Required qty is not a number ("many")' })
  })
})
