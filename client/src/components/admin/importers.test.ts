import { describe, expect, it } from 'vitest'
import { PRODUCTION_RECORD_FIELDS, PRODUCTION_RECORD_KEYS } from '@qc/shared/productionImport'
import { ORDERS_IMPORTER, PRODUCTION_RECORDS_IMPORTER, PRODUCTION_RECORD_TEMPLATE_HEADERS, gradeFromMaterial, normaliseHeader, type Importer } from './importers'

/** The column each field would be read from, the way CsvImporter's autoMap picks it: the first of key, label and aliases that names a header. */
function autoMap(importer: Importer, headers: string[]): Record<string, string | undefined> {
  const byNorm = new Map<string, string>()
  for (const h of headers) {
    const n = normaliseHeader(h)
    if (n && !byNorm.has(n)) byNorm.set(n, h)
  }
  const mapped: Record<string, string | undefined> = {}
  for (const f of importer.fields) mapped[f.key] = [f.key, f.label, ...(f.aliases ?? [])].map(normaliseHeader).map((c) => byNorm.get(c)).find(Boolean)
  return mapped
}

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

describe('the production task record from the ERP (§24)', () => {
  /** The export's header row, as "Production Task Record" writes it (30 columns). */
  const EXPORT_HEADERS = [
    'ID', 'Pivot', 'Order', 'Item', 'Color', 'Qty', 'Worker1', 'Worker2', 'Worker3', 'Worker4', 'DayNo', 'Day', 'Work Center', 'Duration',
    'Stage (N)', 'Stage (Qty)', 'Remarks', 'L (mm)', 'W (mm)', 'T (mm)', 'Req_Q', 'Actual Time', 'Planned time', 'Productivity',
    'Shift Category', 'Resource', 'Weight (KG)', 'Produced Weight (KG)', 'Produced Length (Meter)', 'Record ID',
  ]

  it('is the shared contract, sent to its own importer and matched on Order ID + Record ID', () => {
    expect(PRODUCTION_RECORDS_IMPORTER.target).toBe('production-records')
    expect(PRODUCTION_RECORDS_IMPORTER.businessKeys).toEqual([...PRODUCTION_RECORD_KEYS])
    expect(PRODUCTION_RECORDS_IMPORTER.businessKeys).toEqual(['lineKey', 'erpRecordId'])
    expect(PRODUCTION_RECORDS_IMPORTER.optionalKeys).toBeUndefined()
    expect(PRODUCTION_RECORDS_IMPORTER.fields).toEqual([...PRODUCTION_RECORD_FIELDS])
    // The day is read by the API, as a day: the browser must not turn it into a timestamp in its own time zone.
    expect(PRODUCTION_RECORDS_IMPORTER.fields.find((f) => f.key === 'workDay')?.kind).toBe('text')
  })

  it("maps the export's own column names without renaming, every column to its field", () => {
    const mapped = autoMap(PRODUCTION_RECORDS_IMPORTER, EXPORT_HEADERS)
    const expected: Record<string, string> = {
      lineKey: 'ID', erpRecordId: 'Record ID', week: 'Pivot', orderNumber: 'Order', item: 'Item', colour: 'Color', producedQty: 'Qty',
      worker1: 'Worker1', worker2: 'Worker2', worker3: 'Worker3', worker4: 'Worker4', dayNo: 'DayNo', workDay: 'Day', workCenterCode: 'Work Center',
      durationHours: 'Duration', stageNo: 'Stage (N)', stageQty: 'Stage (Qty)', remarks: 'Remarks', lengthMm: 'L (mm)', widthMm: 'W (mm)',
      thicknessMm: 'T (mm)', requiredQty: 'Req_Q', actualHours: 'Actual Time', plannedHours: 'Planned time', shift: 'Shift Category',
      resource: 'Resource', weightKg: 'Weight (KG)', producedWeightKg: 'Produced Weight (KG)', producedLengthM: 'Produced Length (Meter)',
    }
    expect(mapped).toEqual(expected)
    // Every field has a column, no column is read by two fields, and Productivity (always 0 in the ERP) is read by none.
    const columns = Object.values(mapped)
    expect(new Set(columns).size).toBe(PRODUCTION_RECORDS_IMPORTER.fields.length)
    expect(columns).not.toContain('Productivity')
  })

  it("writes the export's column names on its template, and the template imports itself", () => {
    expect(PRODUCTION_RECORDS_IMPORTER.templateHeaders).toBe(PRODUCTION_RECORD_TEMPLATE_HEADERS)
    const keys = PRODUCTION_RECORDS_IMPORTER.fields.map((f) => f.key)
    expect(Object.keys(PRODUCTION_RECORD_TEMPLATE_HEADERS).sort()).toEqual([...keys].sort())
    const headers = keys.map((k) => PRODUCTION_RECORD_TEMPLATE_HEADERS[k])
    expect(headers.every((h) => EXPORT_HEADERS.includes(h))).toBe(true)
    const mapped = autoMap(PRODUCTION_RECORDS_IMPORTER, headers)
    for (const k of keys) expect(mapped[k], k).toBe(PRODUCTION_RECORD_TEMPLATE_HEADERS[k])
  })

  it('maps the same column names the order sheet is keyed on, so the two imports join on one Order ID', () => {
    const orders = autoMap(ORDERS_IMPORTER, ['Order ID', 'Order', 'Item'])
    const records = autoMap(PRODUCTION_RECORDS_IMPORTER, ['Order ID', 'Order', 'Item', 'Record ID'])
    expect(orders.lineKey).toBe('Order ID')
    expect(records.lineKey).toBe('Order ID')
    expect(records.orderNumber).toBe('Order')
    expect(records.erpRecordId).toBe('Record ID')
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
