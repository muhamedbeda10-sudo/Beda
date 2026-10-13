import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import type { AiExcelSheet } from '@qc/shared/aiExcel'
import { buildWorkbook, cellOf, columnLetter, formatCode } from '../src/ai/excelBook'

// The workbook the server builds from a file the assistant laid out, read
// back with ExcelJS: what Excel would show.

const read = async (bytes: Buffer) => {
  const book = new ExcelJS.Workbook()
  await book.xlsx.load(bytes as unknown as ArrayBuffer)
  return book
}

const SCRAP: AiExcelSheet = {
  name: 'Scrap',
  title: 'Scrap by machine',
  notes: 'October 2026, all shifts.',
  sql: 'SELECT 1',
  columns: [
    { column: 'machine', header: 'Machine', format: 'text' },
    { column: 'pieces', header: 'Pieces', format: 'integer' },
    { column: 'kg', header: 'Weight (kg)', format: 'decimal', decimals: 1 },
    { column: 'rate', header: 'Reject rate', format: 'percent', decimals: 1 },
    { column: 'day', header: 'Day', format: 'date' },
    { column: 'at', header: 'Closed at', format: 'datetime' },
  ],
  totals: {
    label: 'Total',
    columns: [
      { column: 'pieces', total: 'sum' },
      { column: 'kg', total: 'sum' },
      { column: 'rate', total: 'average' },
      { column: 'day', total: 'count' },
    ],
  },
  rightToLeft: false,
}

describe('the workbook of an Excel file', () => {
  it('writes the title, the notes, a bold header frozen with a filter, real numbers and dates, and totals Excel works out', async () => {
    const bytes = await buildWorkbook(
      [
        {
          sheet: SCRAP,
          rows: [
            ['RF-01', 1200, 13.75, 2.5, '2026-10-01', '2026-10-01 08:30:00'],
            ['RF-02', 800, 2.5, 1.25, '2026-10-02', null],
          ],
        },
        { sheet: { name: 'آلات', sql: 'SELECT 1', columns: [{ column: 'code', header: 'الكود', format: 'text' }], rightToLeft: true }, rows: [['58'], [31]] },
      ],
      { stamp: 'R&D 2026-10-13 08:30', created: new Date('2026-10-13T05:30:00Z') },
    )
    const book = await read(bytes)
    expect(book.worksheets.map((w) => w.name)).toEqual(['Scrap', 'آلات'])
    const ws = book.getWorksheet('Scrap')!
    expect(ws.getCell('A1').value).toBe('Scrap by machine')
    expect(ws.getCell('A1').font).toMatchObject({ bold: true, size: 14 })
    expect(ws.getCell('A2').value).toBe('October 2026, all shifts.')
    // A blank row, then the header: bold, shaded, frozen with everything above it, a filter on it.
    expect(ws.getRow(3).cellCount).toBe(0)
    expect(ws.getRow(4).values).toEqual([undefined, 'Machine', 'Pieces', 'Weight (kg)', 'Reject rate', 'Day', 'Closed at'])
    expect(ws.getCell('B4').font).toMatchObject({ bold: true })
    expect(ws.getCell('B4').fill).toMatchObject({ type: 'pattern', pattern: 'solid' })
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 4 })
    expect(ws.autoFilter).toBe('A4:F6')

    // Numbers as numbers in their formats; a percentage as its fraction; a day and a time as dates, their clock as written.
    expect(ws.getCell('B5')).toMatchObject({ value: 1200, numFmt: '#,##0' })
    expect(ws.getCell('C5')).toMatchObject({ value: 13.75, numFmt: '#,##0.0' })
    expect(ws.getCell('D5')).toMatchObject({ value: 0.025, numFmt: '0.0%' })
    expect(ws.getCell('E5').value).toEqual(new Date(Date.UTC(2026, 9, 1)))
    expect(ws.getCell('E5').numFmt).toBe('yyyy-mm-dd')
    expect(ws.getCell('F5').value).toEqual(new Date(Date.UTC(2026, 9, 1, 8, 30)))
    expect(ws.getCell('F5').numFmt).toBe('yyyy-mm-dd hh:mm')
    expect(ws.getCell('F6').value).toBeNull()

    // The totals: SUBTOTAL, so a filter narrows them, with what the rows add up to until Excel works it out; the label where no total is.
    expect(ws.getCell('A7').value).toBe('Total')
    expect(ws.getCell('B7').value).toEqual({ formula: 'SUBTOTAL(109,B5:B6)', result: 2000 })
    expect(ws.getCell('C7').value).toEqual({ formula: 'SUBTOTAL(109,C5:C6)', result: 16.25 })
    expect(ws.getCell('D7').value).toEqual({ formula: 'SUBTOTAL(101,D5:D6)', result: 0.01875 })
    expect(ws.getCell('D7').numFmt).toBe('0.0%')
    expect(ws.getCell('E7').value).toEqual({ formula: 'SUBTOTAL(103,E5:E6)', result: 2 })
    expect(ws.getCell('E7').numFmt).toBe('#,##0')
    expect(ws.getCell('B7').font).toMatchObject({ bold: true })

    // Set up to print: A4, as wide as the page, the header on every page, when the data was read at the foot.
    expect(ws.pageSetup).toMatchObject({ paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '4:4' })
    expect(ws.headerFooter.oddFooter).toBe('&LR&&D 2026-10-13 08:30&R&P / &N')

    // An Arabic sheet reads right to left; a code stays text, even one the query gave as a number.
    const ar = book.getWorksheet('آلات')!
    expect(ar.views[0]).toMatchObject({ rightToLeft: true, state: 'frozen', ySplit: 1 })
    expect(ar.getColumn(1).values).toEqual([undefined, 'الكود', '58', '31'])
    expect(ar.autoFilter).toBe('A1:A3')
  })

  it('adds no totals row to a sheet without rows, and labels none when every column has a total', async () => {
    const sheet = (columns: AiExcelSheet['columns'], totals: AiExcelSheet['totals']): AiExcelSheet => ({ name: 'S', sql: 'SELECT 1', columns, totals, rightToLeft: false })
    const n = { column: 'n', header: 'N', format: 'integer' } as const
    const empty = await read(await buildWorkbook([{ sheet: sheet([n], { label: 'Total', columns: [{ column: 'n', total: 'sum' }] }), rows: [] }], { stamp: '', created: new Date() }))
    expect(empty.getWorksheet('S')!.actualRowCount).toBe(1)
    const full = await read(await buildWorkbook([{ sheet: sheet([n], { label: 'Total', columns: [{ column: 'n', total: 'sum' }] }), rows: [[3], [4]] }], { stamp: '', created: new Date() }))
    expect(full.getWorksheet('S')!.getRow(4).values).toEqual([undefined, { formula: 'SUBTOTAL(109,A2:A3)', result: 7 }])
  })

  it('writes each value as its column does, and drops what XML cannot hold', () => {
    expect(cellOf(2.5, 'percent')).toBe(0.025)
    expect(cellOf('n/a', 'percent')).toBe('n/a')
    expect(cellOf(58, 'text')).toBe('58')
    expect(cellOf(true, 'text')).toBe('Yes')
    expect(cellOf(false, 'integer')).toBe('No')
    expect(cellOf('2026-10-01 08:30:00+03', 'datetime')).toEqual(new Date(Date.UTC(2026, 9, 1, 8, 30)))
    expect(cellOf('a\u0000b\u0007c\td', 'text')).toBe('abc\td')
    expect(cellOf(null, 'date')).toBeNull()
    expect(formatCode('decimal', 0)).toBe('#,##0')
    expect(formatCode('percent', 2)).toBe('0.00%')
    expect(formatCode('text')).toBeUndefined()
    expect(columnLetter(0)).toBe('A')
    expect(columnLetter(26)).toBe('AA')
  })
})
