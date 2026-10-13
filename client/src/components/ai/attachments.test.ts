import { describe, expect, it } from 'vitest'
import { csvLine, formatBytes, pickedKind, readyIds, sheetText, type PendingAttachment } from './attachments'

describe('pickedKind', () => {
  it('knows photos, PDFs and spreadsheets by name or type', () => {
    expect(pickedKind({ name: 'IMG_0042.HEIC', type: '' })).toBe('image')
    expect(pickedKind({ name: 'scan', type: 'image/png' })).toBe('image')
    expect(pickedKind({ name: 'certificate.PDF', type: '' })).toBe('pdf')
    expect(pickedKind({ name: 'download', type: 'application/pdf' })).toBe('pdf')
    expect(pickedKind({ name: 'orders.xlsx', type: '' })).toBe('sheet')
    expect(pickedKind({ name: 'old.xls', type: '' })).toBe('sheet')
    expect(pickedKind({ name: 'export.csv', type: 'text/csv' })).toBe('sheet')
    expect(pickedKind({ name: 'notes.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })).toBeNull()
    expect(pickedKind({ name: 'run.exe', type: '' })).toBeNull()
  })
})

describe('csvLine', () => {
  it('quotes what needs it and drops trailing empty cells', () => {
    expect(csvLine(['A-1', '12', 'ok, then', 'say "hi"', 'two\nlines', '', ' '])).toBe('A-1,12,"ok, then","say ""hi""","two\nlines"')
    expect(csvLine(['', 'x'])).toBe(',x')
    expect(csvLine([])).toBe('')
  })
})

describe('sheetText', () => {
  it('writes each sheet that holds anything under a heading with its size', () => {
    const read = sheetText([
      { name: 'Orders', rows: [['order', 'qty'], ['A-1', '12']] },
      { name: 'Empty', rows: [] },
      { name: 'Coils "B"', rows: [['coil'], ['C-9']] },
    ])
    expect(read).toEqual({
      text: '## Sheet "Orders" (2 rows × 2 columns)\norder,qty\nA-1,12\n## Sheet "Coils \'B\'" (2 rows × 1 column)\ncoil\nC-9',
      summary: '2 sheets · 4 rows',
      omittedRows: 0,
    })
  })

  it('outlines a single sheet by its rows and columns', () => {
    expect(sheetText([{ name: 'Sheet1', rows: [['a', 'b', 'c']] }])?.summary).toBe('1 row × 3 columns')
  })

  it('leaves out the rows past its length, and says how many', () => {
    const rows = Array.from({ length: 100 }, (_, i) => [`row-${i}`, 'x'.repeat(20)])
    const read = sheetText([{ name: 'Big', rows }], 1000)!
    expect(read.text.length).toBeLessThanOrEqual(1000)
    expect(read.omittedRows).toBeGreaterThan(0)
    expect(read.text.endsWith(`[${read.omittedRows} more rows not included: the file is longer than the assistant can read at once.]`)).toBe(true)
    expect(read.summary).toBe(`100 rows × 2 columns · ${read.omittedRows} rows left out`)
  })

  it('is null when nothing is in it', () => {
    expect(sheetText([{ name: 'Sheet1', rows: [] }])).toBeNull()
    expect(sheetText([])).toBeNull()
  })
})

describe('readyIds', () => {
  const file = (key: string, state: PendingAttachment['state']): PendingAttachment => ({
    key,
    name: key,
    kind: 'pdf',
    state,
    attachment: state === 'ready' ? { id: `id-${key}`, kind: 'pdf', name: key, byteSize: 10, tokens: 5 } : undefined,
  })
  it('gives the ids in order once every file is kept', () => {
    expect(readyIds([])).toEqual([])
    expect(readyIds([file('a', 'ready'), file('b', 'ready')])).toEqual(['id-a', 'id-b'])
    expect(readyIds([file('a', 'ready'), file('b', 'uploading')])).toBeNull()
    expect(readyIds([file('a', 'failed')])).toBeNull()
  })
})

describe('formatBytes', () => {
  it('reads as a person would say it', () => {
    expect(formatBytes(900)).toBe('900 B')
    expect(formatBytes(20_480)).toBe('20 KB')
    expect(formatBytes(3_500_000)).toBe('3.3 MB')
  })
})
