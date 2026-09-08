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
