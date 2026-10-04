import { describe, it, expect } from 'vitest'
import { mapOrderRow, matchOrderColumns } from './orderImport'

describe('§7.7 — reading an Access row as the importer does', () => {
  const match = matchOrderColumns(['Order ID', 'ORDER', 'Item ID', 'Req Q', 'Finished Q', 'Raw Material Description', 'Release Date', 'Remarks'])

  it('matches columns on their names, case and punctuation aside, and lists the rest', () => {
    expect(match.byField).toMatchObject({ lineKey: 'Order ID', orderNumber: 'ORDER', itemCode: 'Item ID', requiredQty: 'Req Q', finishedQty: 'Finished Q', material: 'Raw Material Description', date: 'Release Date' })
    expect(match.unknown).toEqual(['Remarks'])
  })

  it('reads numbers, dates and the grade, and leaves empty cells out', () => {
    const out = mapOrderRow({ 'Order ID': 100245, ORDER: ' 20480-Ph1.4 ', 'Item ID': '', 'Req Q': '1,350', 'Finished Q': null, 'Raw Material Description': 'RM.ST.CO.HR. : 344 : 1.5 : S315MC : PO', 'Release Date': '2026-09-01T00:00:00' }, match)
    expect(out).toEqual({
      values: { lineKey: '100245', orderNumber: '20480-Ph1.4', requiredQty: 1350, material: 'RM.ST.CO.HR. : 344 : 1.5 : S315MC : PO', expectedGrade: 'S315MC', date: new Date('2026-09-01T00:00:00').toISOString() },
    })
  })

  it('says which cell cannot be read', () => {
    expect(mapOrderRow({ 'Order ID': 'A', 'Req Q': 'many' }, match)).toEqual({ error: 'Required qty is not a number ("many")' })
    expect(mapOrderRow({ 'Order ID': 'A', 'Release Date': 'soon' }, match)).toEqual({ error: 'Date is not a date ("soon")' })
  })
})
