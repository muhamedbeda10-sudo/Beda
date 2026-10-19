import { describe, expect, it } from 'vitest'
import { looksLikeHeader, parseClipboardGrid, planRows } from './PasteImporter'
import { DEFECTS_IMPORTER, MACHINES_IMPORTER, PRODUCTION_IMPORTER } from './importers'

describe('pasting from Excel', () => {
  it('splits the clipboard into rows and cells, dropping the trailing newline', () => {
    expect(parseClipboardGrid('58\tA. Welding Line\tLM4\r\n48\tPainting Line\tLM4\r\n')).toEqual([
      ['58', 'A. Welding Line', 'LM4'],
      ['48', 'Painting Line', 'LM4'],
    ])
    expect(parseClipboardGrid('a\t\tc\n')).toEqual([['a', '', 'c']])
  })

  it('recognises a pasted header row by the column names', () => {
    expect(looksLikeHeader(['Machine code', 'Machine name', 'Factory'], MACHINES_IMPORTER.fields)).toBe(true)
    expect(looksLikeHeader(['Item ID', 'Dimension Name', 'Tolerance Plus', 'Tolerance Minus', 'Sequence Number', ''], PRODUCTION_IMPORTER.fields)).toBe(true)
    expect(looksLikeHeader(['58', 'A. Welding Line', 'LM4'], MACHINES_IMPORTER.fields)).toBe(false)
  })

  it('plans rows the way the file importer does: typed values, keys, new-vs-update, skipped rows named', () => {
    const rows = [
      ['DC.DR.FR.BD.', 'D1(Left)', '0.5', '0.5', '1', ''],
      ['DC.DR.FR.BD.', 'F', '', '1', '5', '48'],
      ['', 'Orphan', '1', '1', '2', ''],
      ['DC.DR.FR.BD.', 'Bad', 'x', '1', '3', ''],
      ['', '', '', '', '', ''],
    ]
    const existing = new Set(['dc.dr.fr.bd.||d1(left)||'])
    const plan = planRows(rows, PRODUCTION_IMPORTER, ['itemCode', 'dimensionName', 'workCenterCode'], existing, 'Africa/Cairo')
    expect(plan.valid.map((r) => [r.key, r.mode])).toEqual([
      ['dc.dr.fr.bd.||d1(left)||', 'update'],
      ['dc.dr.fr.bd.||f||48', 'new'],
    ])
    expect(plan.valid[0].values).toEqual({ itemCode: 'DC.DR.FR.BD.', dimensionName: 'D1(Left)', tolPlus: 0.5, tolMinus: 0.5, sequence: 1 })
    expect(plan.valid[1].values).toEqual({ itemCode: 'DC.DR.FR.BD.', dimensionName: 'F', tolMinus: 1, sequence: 5, workCenterCode: '48' })
    expect(Array.from(plan.problems.keys())).toEqual([2, 3])
    expect(plan.problems.get(2)!.messages).toEqual(['Item ID is empty'])
    expect(plan.problems.get(3)!.messages).toEqual(['Tolerance + is not a number ("x")'])
  })

  it('treats a repeated key inside one paste as an update of the earlier row', () => {
    const plan = planRows([['58', 'Weld crack'], ['58', 'weld crack']], DEFECTS_IMPORTER, ['workCenterCode', 'defectName'], new Set(), 'Africa/Cairo')
    expect(plan.valid.map((r) => r.mode)).toEqual(['new', 'update'])
  })
})
