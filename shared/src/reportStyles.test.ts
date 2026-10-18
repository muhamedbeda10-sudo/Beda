import { describe, expect, it } from 'vitest'
import { BUILTIN_REPORT_STYLE, columnName, columnNumber, nextRevision, parseCellRef, reportFormMappingProblems, sameSpec, type ReportFormMapping } from './reportStyles'

describe('a style’s document control', () => {
  it('moves the revision on as it is written, keeping its zeros and prefix', () => {
    expect(nextRevision('02')).toBe('03')
    expect(nextRevision('09')).toBe('10')
    expect(nextRevision('3')).toBe('4')
    expect(nextRevision('Rev. 07')).toBe('Rev. 08')
    // Not a number: the person's to change.
    expect(nextRevision('A')).toBe('A')
    expect(nextRevision('')).toBe('')
  })

  it('compares two specs choice by choice, the order keys were written in aside', () => {
    const shuffled = JSON.parse(JSON.stringify({ footer: BUILTIN_REPORT_STYLE.footer, ...BUILTIN_REPORT_STYLE }))
    expect(sameSpec(BUILTIN_REPORT_STYLE, shuffled)).toBe(true)
    expect(sameSpec(BUILTIN_REPORT_STYLE, { ...BUILTIN_REPORT_STYLE, numbering: false })).toBe(false)
  })
})

describe('A1 references', () => {
  it('read and write columns and cells', () => {
    expect(parseCellRef('c12')).toEqual({ col: 3, row: 12 })
    expect(parseCellRef('AA1')).toEqual({ col: 27, row: 1 })
    expect(parseCellRef('XFD1048576')).toEqual({ col: 16_384, row: 1_048_576 })
    expect(parseCellRef('XFE1')).toBeNull()
    expect(parseCellRef('A0')).toBeNull()
    expect(parseCellRef('1A')).toBeNull()
    expect(columnName(1)).toBe('A')
    expect(columnName(26)).toBe('Z')
    expect(columnName(27)).toBe('AA')
    expect(columnName(703)).toBe('AAA')
    expect(columnNumber('ab')).toBe(28)
    expect(columnNumber('A1')).toBe(0)
  })
})

describe('a form’s mapping', () => {
  const sheets = [{ name: 'QF-07' }]
  const sections = [
    { title: 'Defects', columns: ['machine', 'defects'] },
    { title: 'Not run yet', columns: null },
  ]
  const good: ReportFormMapping = {
    sheet: 'QF-07',
    cells: [
      { ref: 'B2', value: { kind: 'field', field: 'ran.day' } },
      { ref: 'D2', value: { kind: 'input', name: 'order' } },
      { ref: 'C20', value: { kind: 'section', section: 0, column: 'defects', aggregate: 'sum' } },
    ],
    tables: [{ section: 0, startRow: 6, overflow: 'insert', columns: [{ col: 'A', column: 'machine' }, { col: 'C', column: 'defects' }] }],
  }

  it('reads when every value goes somewhere real', () => {
    expect(reportFormMappingProblems(good, sheets, sections, ['order'])).toEqual([])
    // A section not run yet: its columns are checked when the form is filled.
    expect(reportFormMappingProblems({ ...good, cells: [{ ref: 'B3', value: { kind: 'section', section: 1, column: 'anything', aggregate: 'first' } }] }, sheets, sections, ['order'])).toEqual([])
  })

  it('says what is wrong, each in a line', () => {
    const problems = reportFormMappingProblems(
      {
        sheet: 'Other',
        cells: [
          { ref: 'B2', value: { kind: 'input', name: 'missing' } },
          { ref: 'b2', value: { kind: 'text', text: 'twice' } },
          { ref: 'B-2', value: { kind: 'text', text: 'x' } },
          { ref: 'A7', value: { kind: 'section', section: 0, column: 'nope', aggregate: 'first' } },
        ],
        tables: [
          { section: 0, startRow: 6, overflow: 'next-sheet', columns: [{ col: 'A', column: 'machine' }] },
          { section: 3, startRow: 6, overflow: 'insert', columns: [{ col: 'A', column: 'machine' }, { col: 'a', column: 'machine' }] },
        ],
      },
      sheets,
      sections,
      ['order'],
    )
    expect(problems).toEqual(
      expect.arrayContaining([
        'The form has no sheet named “Other”.',
        'Cell B2: the report has no input “missing”.',
        'Cell b2 is filled twice.',
        '“B-2” is not a cell (write it as C3).',
        'Cell A7: section 1 (“Defects”) has no column “nope”.',
        'The tables of one form take more rows the same way: all insert rows, or all go on to a copy of the sheet.',
        'Table 1: give the last row the form holds (at or after the first).',
        'Table 2: the report has no section 4.',
        'Table 2: column A is filled twice.',
        'Table 2 overlaps another table\'s rows.',
      ]),
    )
  })

  it('keeps cells out of a table’s rows', () => {
    const inside = { ...good, cells: [{ ref: 'C6', value: { kind: 'text' as const, text: 'x' } }] }
    expect(reportFormMappingProblems(inside, sheets, sections, [])).toEqual(["Cell C6 is inside table 1's rows."])
    // A fixed table holds its rows down to its last.
    const fixed: ReportFormMapping = { ...good, cells: [{ ref: 'A9', value: { kind: 'text', text: 'x' } }], tables: [{ ...good.tables[0], overflow: 'next-sheet', lastRow: 10 }] }
    expect(reportFormMappingProblems(fixed, sheets, sections, [])).toEqual(["Cell A9 is inside table 1's rows."])
  })
})
