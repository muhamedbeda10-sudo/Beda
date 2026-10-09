import { beforeAll, describe, expect, it } from 'vitest'
import { DOMParser as XmlDomParser } from '@xmldom/xmldom'
import { readWorkbook } from './xlsx'
import { columnLetter, escapeXml, sheetName, writeWorkbook } from './xlsxWrite'

beforeAll(() => {
  ;(globalThis as { DOMParser?: unknown }).DOMParser = XmlDomParser
})

describe('xlsx writer', () => {
  it('names columns the way Excel does', () => {
    expect(columnLetter(0)).toBe('A')
    expect(columnLetter(25)).toBe('Z')
    expect(columnLetter(26)).toBe('AA')
    expect(columnLetter(701)).toBe('ZZ')
    expect(columnLetter(702)).toBe('AAA')
  })

  it('keeps sheet names legal and unique', () => {
    const taken = new Set<string>()
    expect(sheetName('By machine / factory: A?', taken)).toBe('By machine   factory  A')
    expect(sheetName('a'.repeat(40), taken)).toBe('a'.repeat(31))
    expect(sheetName('A'.repeat(40), taken)).toBe(`${'A'.repeat(27)} (2)`)
    expect(sheetName('', taken)).toBe('Sheet')
  })

  it('never starts or ends a sheet name with an apostrophe, which Excel refuses — after the cut too', () => {
    const taken = new Set<string>()
    // Cut at 31 characters, the name would end just after "operator'".
    expect(sheetName("1 Rejects per line by operator's shift", taken)).toBe('1 Rejects per line by operator')
    expect(sheetName("'quoted'", taken)).toBe('quoted')
    expect(sheetName("''", taken)).toBe('Sheet')
    // Still unique once the apostrophe is gone.
    expect(sheetName("1 Rejects per line by operator''", taken)).toBe('1 Rejects per line by opera (2)')
    for (const name of taken) expect(name).not.toMatch(/^'|'$/)
  })

  it('escapes what XML cannot hold', () => {
    expect(escapeXml('a<b>&"c"\'')).toBe('a&lt;b&gt;&amp;&quot;c&quot;&apos;')
  })

  it('writes a workbook the reader reads back', () => {
    const bytes = writeWorkbook([
      { name: 'Summary', header: ['KPI', 'Current', 'Previous'], rows: [['Defect rate %', 2.5, 3], ['Samples', 120, null], ['Note', 'ampersand & <tag>', undefined]] },
      { name: 'Pareto', header: ['Defect', 'Pieces'], rows: [['Weld porosity', 30], ['Undercut', 5]] },
    ])
    const wb = readWorkbook(bytes).sheets
    expect(wb.map((s) => s.name)).toEqual(['Summary', 'Pareto'])
    expect(wb[0].rows).toEqual([
      ['KPI', 'Current', 'Previous'],
      ['Defect rate %', '2.5', '3'],
      ['Samples', '120'],
      ['Note', 'ampersand & <tag>'],
    ])
    expect(wb[1].rows[2]).toEqual(['Undercut', '5'])
  })

  it('refuses an empty workbook', () => {
    expect(() => writeWorkbook([])).toThrow()
  })
})
