import { describe, it, expect } from 'vitest'
import { ORDER_DETAIL_KEYS, ORDER_IMPORT_FIELDS, mapOrderRow, matchOrderColumns, parseMoment, readOrderCell } from './orderImport'

const CAIRO = 'Africa/Cairo'

describe('§7.7 — reading an Access row as the importer does', () => {
  const match = matchOrderColumns(['Order ID', 'ORDER', 'Item ID', 'Req Q', 'Finished Q', 'Raw Material Description', 'Release Date', 'Remarks'])

  it('matches columns on their names, case and punctuation aside, and lists the rest', () => {
    expect(match.byField).toMatchObject({ lineKey: 'Order ID', orderNumber: 'ORDER', itemCode: 'Item ID', requiredQty: 'Req Q', finishedQty: 'Finished Q', material: 'Raw Material Description', date: 'Release Date' })
    expect(match.unknown).toEqual(['Remarks'])
  })

  it('reads numbers, dates and the grade, and leaves empty cells out', () => {
    const out = mapOrderRow({ 'Order ID': 100245, ORDER: ' 20480-Ph1.4 ', 'Item ID': '', 'Req Q': '1,350', 'Finished Q': null, 'Raw Material Description': 'RM.ST.CO.HR. : 344 : 1.5 : S315MC : PO', 'Release Date': '2026-09-01T00:00:00' }, match, CAIRO)
    expect(out).toEqual({
      // Midnight in Cairo (summer time, UTC+3), whatever clock the API runs on.
      values: { lineKey: '100245', orderNumber: '20480-Ph1.4', requiredQty: 1350, material: 'RM.ST.CO.HR. : 344 : 1.5 : S315MC : PO', expectedGrade: 'S315MC', date: '2026-08-31T21:00:00.000Z' },
    })
  })

  it('says which cell cannot be read', () => {
    expect(mapOrderRow({ 'Order ID': 'A', 'Req Q': 'many' }, match, CAIRO)).toEqual({ error: 'Required qty is not a number ("many")' })
    expect(mapOrderRow({ 'Order ID': 'A', 'Release Date': 'soon' }, match, CAIRO)).toEqual({ error: 'Date is not a date ("soon")' })
  })
})

describe('§7.7.1 — the ERP "Tasks" query, every column of it', () => {
  /** The query's header row, as the 2026 export writes it (57 columns). */
  const TASKS_HEADERS = [
    'ID', 'Status', 'Work Center', 'Release Date', 'Due Date', 'Refined Date', 'Pivot', 'Order', 'Item', 'Req_Q', 'Rem_Q', 'Finished_Q',
    'Canceled_Qty', 'Accepted_Qty', 'Stock_Qty', 'L (mm)', 'W (mm)', 'T (mm)', 'W (Kg)', 'Stage', 'Color', 'QC Category', 'VersionParentID',
    'Parent ID', 'Part Dur (Hr)', 'Model Group ID', 'Cus Name', 'Exp/Local', 'DWG1', 'DWG2', 'Total area(m2)', 'Total Powder (KG)', 'Item ID',
    'Order Type', 'Raw Material Description', 'Raw Material Qty', 'Coil Serial Number', 'Raw Material Powder', 'Item Family', 'Translation',
    'Total Actual Sample Qty', 'Total Hold Qty', 'Total Std Sample Qty', 'Total Rem QC Record Qty', 'Planned Start', 'Planned Finish',
    'Shipping Status', 'Shipping Start Date', 'Shipping End Date', 'Bom ID', 'RM Received QTY', 'RM Receiving Date', 'DelayReason',
    'DelayPeriod', 'DelayComment', 'Status Reason', 'RM Promiss Date',
  ]
  const match = matchOrderColumns(TASKS_HEADERS)

  it('maps every column to its own field, and every field to a column (the expected grade is read from the material)', () => {
    expect(match.unknown).toEqual([])
    const columns = Object.values(match.byField)
    expect(new Set(columns).size).toBe(columns.length)
    expect(columns).toHaveLength(TASKS_HEADERS.length)
    expect(ORDER_IMPORT_FIELDS.filter((f) => match.byField[f.key] === undefined).map((f) => f.key)).toEqual([])
    expect(match.byField).toMatchObject({
      lineKey: 'ID', erpStatus: 'Status', workCenterCode: 'Work Center', date: 'Release Date', orderNumber: 'Order', item: 'Item',
      itemCode: 'Item ID', requiredQty: 'Req_Q', finishedQty: 'Finished_Q', colour: 'Color', customer: 'Cus Name', type: 'Exp/Local',
      drawing: 'DWG1', drawingAlt: 'DWG2', material: 'Raw Material Description',
      dueDate: 'Due Date', refinedDate: 'Refined Date', planningWeek: 'Pivot', erpRemainingQty: 'Rem_Q', cancelledQty: 'Canceled_Qty',
      acceptedQty: 'Accepted_Qty', stockQty: 'Stock_Qty', lengthMm: 'L (mm)', widthMm: 'W (mm)', thicknessMm: 'T (mm)', weightKg: 'W (Kg)',
      stage: 'Stage', qcCategory: 'QC Category', versionParentId: 'VersionParentID', parentId: 'Parent ID', partDurationHours: 'Part Dur (Hr)',
      modelGroupId: 'Model Group ID', totalAreaM2: 'Total area(m2)', totalPowderKg: 'Total Powder (KG)', erpOrderType: 'Order Type',
      rawMaterialQty: 'Raw Material Qty', coilSerialNumber: 'Coil Serial Number', rawMaterialPowder: 'Raw Material Powder',
      itemFamily: 'Item Family', itemTranslation: 'Translation', totalActualSampleQty: 'Total Actual Sample Qty',
      totalHoldQty: 'Total Hold Qty', totalStdSampleQty: 'Total Std Sample Qty', totalRemQcRecordQty: 'Total Rem QC Record Qty',
      plannedStart: 'Planned Start', plannedFinish: 'Planned Finish', shippingStatus: 'Shipping Status',
      shippingStartDate: 'Shipping Start Date', shippingEndDate: 'Shipping End Date', bomId: 'Bom ID', rmReceivedQty: 'RM Received QTY',
      rmReceivingDate: 'RM Receiving Date', delayReasonCode: 'DelayReason', delayPeriod: 'DelayPeriod', delayComment: 'DelayComment',
      statusReason: 'Status Reason', rmPromiseDate: 'RM Promiss Date',
    })
  })

  it('every ERP detail clears when empty; no core field does', () => {
    const details = new Set<string>(ORDER_DETAIL_KEYS)
    for (const f of ORDER_IMPORT_FIELDS) expect(f.clearsWhenEmpty === true, f.key).toBe(details.has(f.key))
    expect(ORDER_DETAIL_KEYS).toHaveLength(42)
  })

  it('reads days as days, a whole-number code as one, and clears an empty detail while leaving an empty core field out', () => {
    const out = mapOrderRow(
      {
        ID: 462484, Order: '19145-Ph1.23-EHF-(Rail)', 'Req_Q': 24, 'Item ID': '',
        'Due Date': '2026-02-25 00:00:00', 'Planned Start': '06/04/2026', 'Shipping End Date': '', 'RM Promiss Date': null,
        Pivot: '01/2026', 'Total Hold Qty': -8, 'W (Kg)': '1,419.17', DelayReason: 14, DelayComment: '  ', Translation: 'شاتيل ريل',
      },
      match,
      CAIRO,
    )
    expect(out).toEqual({
      values: {
        lineKey: '462484', orderNumber: '19145-Ph1.23-EHF-(Rail)', requiredQty: 24,
        dueDate: '2026-02-25', plannedStart: '2026-04-06', shippingEndDate: null, rmPromiseDate: null,
        planningWeek: '01/2026', totalHoldQty: -8, weightKg: 1419.17, delayReasonCode: 14, delayComment: null, itemTranslation: 'شاتيل ريل',
      },
    })
  })

  it('says which detail cannot be read', () => {
    expect(mapOrderRow({ ID: 'A', 'Due Date': 'next week' }, match, CAIRO)).toEqual({ error: 'Due date is not a day ("next week")' })
    expect(mapOrderRow({ ID: 'A', 'Due Date': '2026-02-30' }, match, CAIRO)).toEqual({ error: 'Due date is not a day ("2026-02-30")' })
    expect(mapOrderRow({ ID: 'A', DelayReason: 2.5 }, match, CAIRO)).toEqual({ error: 'Delay reason is not a whole number ("2.5")' })
    expect(mapOrderRow({ ID: 'A', 'Rem_Q': 'n/a' }, match, CAIRO)).toEqual({ error: 'Remaining qty (ERP) is not a number ("n/a")' })
  })
})

describe('readOrderCell', () => {
  const day = ORDER_IMPORT_FIELDS.find((f) => f.key === 'dueDate')!
  it('reads a day in the forms the workbook reader and Access write, with no time zone', () => {
    expect(readOrderCell(day, '2026-02-25')).toEqual({ value: '2026-02-25' })
    expect(readOrderCell(day, '2026-02-25 00:00:00')).toEqual({ value: '2026-02-25' })
    expect(readOrderCell(day, '25/02/2026')).toEqual({ value: '2026-02-25' })
    expect(readOrderCell(day, '02/25/2026')).toEqual({ error: 'Due date is not a day ("02/25/2026")' })
  })
})

describe('§7.7 — a moment as an export writes it', () => {
  const date = ORDER_IMPORT_FIELDS.find((f) => f.key === 'date')!

  it('reads the day-first form, never month-first', () => {
    // 5 January, Cairo winter time (UTC+2): not the 1st of May.
    expect(readOrderCell(date, '05/01/2026', CAIRO)).toEqual({ value: '2026-01-04T22:00:00.000Z' })
    // The 31st of January is a date, not an error that fails the row.
    expect(readOrderCell(date, '31/01/2026', CAIRO)).toEqual({ value: '2026-01-30T22:00:00.000Z' })
    expect(readOrderCell(date, '5-1-2026 14:30', CAIRO)).toEqual({ value: '2026-01-05T12:30:00.000Z' })
    expect(readOrderCell(date, '31.01.2026 08:15:20', CAIRO)).toEqual({ value: '2026-01-31T06:15:20.000Z' })
    expect(readOrderCell(date, '01/31/2026', CAIRO)).toEqual({ error: 'Date is not a date ("01/31/2026")' })
    expect(readOrderCell(date, '30/02/2026', CAIRO)).toEqual({ error: 'Date is not a date ("30/02/2026")' })
  })

  it('reads a time without an offset as factory time, on the server as in the browser', () => {
    // The Access agent writes yyyy-MM-ddTHH:mm:ss: the factory clock, not UTC.
    expect(readOrderCell(date, '2026-07-15T09:30:00', CAIRO)).toEqual({ value: '2026-07-15T06:30:00.000Z' })
    expect(readOrderCell(date, '2026-01-15 09:30', CAIRO)).toEqual({ value: '2026-01-15T07:30:00.000Z' })
    expect(readOrderCell(date, '2026-01-15', CAIRO)).toEqual({ value: '2026-01-14T22:00:00.000Z' })
    // Without a zone it is the clock where the code runs: the browser, which sits in the factory.
    expect(readOrderCell(date, '2026-01-15T09:30:00')).toEqual({ value: new Date(2026, 0, 15, 9, 30).toISOString() })
  })

  it('gives the same instant for the same line on every import, from either path', () => {
    const access = mapOrderRow({ 'Order ID': 7, 'Release Date': '2026-03-02T13:45:00' }, matchOrderColumns(['Order ID', 'Release Date']), CAIRO)
    const workbook = readOrderCell(date, '02/03/2026 13:45', CAIRO)
    expect(access).toEqual({ values: { lineKey: '7', date: '2026-03-02T11:45:00.000Z' } })
    expect(workbook).toEqual({ value: '2026-03-02T11:45:00.000Z' })
  })

  it('keeps a moment that says its own offset', () => {
    expect(parseMoment('2026-01-15T09:30:00Z', CAIRO)?.toISOString()).toBe('2026-01-15T09:30:00.000Z')
    expect(parseMoment('2026-01-15T09:30:00.250+02:00', CAIRO)?.toISOString()).toBe('2026-01-15T07:30:00.250Z')
    expect(parseMoment('2026-01-15T09:30:00-0500', CAIRO)?.toISOString()).toBe('2026-01-15T14:30:00.000Z')
    expect(parseMoment('Thu, 15 Jan 2026 09:30:00 GMT', CAIRO)?.toISOString()).toBe('2026-01-15T09:30:00.000Z')
  })

  it('refuses what is not a moment', () => {
    for (const text of ['soon', '2026-13-01', '2026-01-15T25:00', '15/01/26', '1768470000']) expect(parseMoment(text, CAIRO), text).toBeNull()
  })
})
