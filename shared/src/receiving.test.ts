import { describe, expect, it } from 'vitest'
import { decisionQuantities, deliveryNoteQrText, deliveryNoteStatus, parseCoilList, parsePurchaseOrderSheet, sheetDay, type DeliveryNoteLine } from './receiving'

describe('§27 receiving', () => {
  it('puts the quantities a decision says on a line, and refuses a partial one that is not', () => {
    expect(decisionQuantities('accepted', 50, null)).toEqual({ acceptedQty: 50, rejectedQty: 0 })
    expect(decisionQuantities('rejected', 50, 10)).toEqual({ acceptedQty: 0, rejectedQty: 50 })
    expect(decisionQuantities('hold', 50, 10)).toEqual({ acceptedQty: null, rejectedQty: null })
    expect(decisionQuantities('partial', 12.5, 10.2)).toEqual({ acceptedQty: 10.2, rejectedQty: 2.3 })
    for (const bad of [null, 0, 12.5, 13]) expect(decisionQuantities('partial', 12.5, bad)).toHaveProperty('error')
  })

  it('works a note’s state out of its lines as the database does', () => {
    expect(deliveryNoteStatus({ pending: 1, hold: 1 }, false)).toBe('awaiting-qc')
    expect(deliveryNoteStatus({ pending: 0, hold: 2 }, false)).toBe('hold')
    expect(deliveryNoteStatus({ pending: 0, hold: 0 }, false)).toBe('decided')
    expect(deliveryNoteStatus({ pending: 3, hold: 0 }, true)).toBe('closed')
  })

  it('reads the coils off the paper as typed or pasted from Excel', () => {
    expect(parseCoilList('456596-0-0-0\t4200\tH1\n\n 456597-0-0-0 \n456596-0-0-0\nC9;4,5;H9\nC10, 3000')).toEqual({
      coils: [
        { coilNumber: '456596-0-0-0', weight: 4200, heatNumber: 'H1' },
        { coilNumber: '456597-0-0-0', weight: null, heatNumber: '' },
        { coilNumber: 'C9', weight: 45, heatNumber: 'H9' },
        { coilNumber: 'C10', weight: 3000, heatNumber: '' },
      ],
      problems: [],
    })
    expect(parseCoilList('C1\theavy').problems).toEqual(['Line 1: “heavy” is not a weight in kg.'])
  })

  it('reads purchasing’s sheet: the header found by its names, each PO line a row, the rest said why', () => {
    const rows = [
      ['Purchase orders export'],
      ['PO No', 'Vendor', 'Order Date', 'Line No', 'Item Code', 'Description', 'DWG No', 'Size', 'Qty', 'UOM'],
      ['4500123', 'Ezz Steel', '2026-10-01', '10', 'BRK-100', 'Bracket', 'DWG-77', '100 x 50', '1,500', 'pcs'],
      ['4500123', 'Ezz Steel', '01/10/2026', '', 'BOLT', '', '', '', '20.5', 'kg'],
      ['4500124', '', '', '', '', '', '', '', '3', ''],
      ['', '', '', '', '', '', '', '', '', ''],
    ]
    const read = parsePurchaseOrderSheet(rows)
    expect(read.missingColumns).toEqual([])
    expect(read.rows).toEqual([
      { poNumber: '4500123', supplier: 'Ezz Steel', poDate: '2026-10-01', lineNo: 10, itemCode: 'BRK-100', description: 'Bracket', drawing: 'DWG-77', dimensions: '100 x 50', quantity: 1500, unit: 'pcs', notes: '' },
      { poNumber: '4500123', supplier: 'Ezz Steel', poDate: '2026-10-01', lineNo: null, itemCode: 'BOLT', description: '', drawing: '', dimensions: '', quantity: 20.5, unit: 'kg', notes: '' },
    ])
    expect(read.skipped).toEqual(['Row 5: no item code.'])
    expect(parsePurchaseOrderSheet([['PO', 'Item']]).missingColumns).toEqual(['Quantity'])
  })

  it('reads a sheet’s days whichever way they are written', () => {
    expect(['2026-10-29', '29/10/2026', '29.10.2026', '46324', '31/02/2026', 'soon'].map(sheetDay)).toEqual(['2026-10-29', '2026-10-29', '2026-10-29', '2026-10-29', '', ''])
  })

  it('puts the decisions in the QR code, and only the link and the numbers when they would not fit', () => {
    const line = (i: number): DeliveryNoteLine => ({
      id: String(i), poLineId: String(i), lineNo: i, itemCode: `ITEM-${i}`, description: '', drawing: '', dimensions: '', unit: 'pcs', orderedQty: 10, quantity: 10, notes: '',
      status: i === 1 ? 'partial' : 'accepted', acceptedQty: i === 1 ? 8 : 10, rejectedQty: i === 1 ? 2 : 0, holdReason: '', rejectReason: '', decisionNotes: '', imageIds: [],
      decidedAt: null, decidedByName: 'سارة', version: 1,
    })
    const note = { reference: 'DN-26-0001', poNumber: 'PO-1', supplier: 'Ezz', factory: 'Factory 1', deliveredOn: '2026-10-28', lineItems: [line(1), line(2)] }
    expect(deliveryNoteQrText(note, 'https://qc/receiving/notes/x')).toBe(
      'https://qc/receiving/notes/x\nDN-26-0001 · PO PO-1\nEzz · Factory 1 · 2026-10-28\nITEM-1 8/10 pcs: Partly accepted by سارة\nITEM-2 10 pcs: Accepted by سارة')
    const long = deliveryNoteQrText({ ...note, lineItems: Array.from({ length: 80 }, (_, i) => line(i + 2)) }, 'https://qc/receiving/notes/x')
    expect(long).toBe('https://qc/receiving/notes/x\nDN-26-0001 · PO PO-1\n80 lines')
  })
})
