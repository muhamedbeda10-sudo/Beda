import { describe, expect, it } from 'vitest'
import { buildGradeIndex } from './rules'
import { gradeFor, gradeRows, judge, labGradeKey, limitsOf, logSpecimen, parseLabLog, parseLabReference, rangeText, sizeThickness, variance, withinLimits, type LabGrade } from './lab'

const grade = (g: Partial<LabGrade>): LabGrade => ({ id: g.grade ?? 'x', family: 'sheet', grade: 'S420MC', standard: 'EN 10149-2-2013', thicknessFrom: null, thicknessTo: null, yieldMin: 420, yieldMax: null, tensileMin: 480, tensileMax: 620, elongationMin: 16, hardness: '', position: 0, ...g })
const GRADES = [
  grade({ id: 'a', thicknessTo: 3, elongationMin: 16 }),
  grade({ id: 'b', thicknessFrom: 3, elongationMin: 19 }),
  grade({ id: 'c', grade: 'S350GD', standard: 'EN 10346:2015', yieldMin: 350, tensileMin: 420, tensileMax: null, elongationMin: 16 }),
  grade({ id: 'd', family: 'bolt', grade: '8.8', standard: 'ISO 898-1', yieldMin: 640, tensileMin: 800, tensileMax: null, elongationMin: 12 }),
]

describe('§26 the lab’s rules', () => {
  it('reads a thickness from a size, never from a bolt’s', () => {
    expect(sizeThickness('Black Sheet', '2.4 mm')).toBe(2.4)
    expect(sizeThickness('Wire', 'wire -Ø 4,3')).toBe(4.3)
    expect(sizeThickness('Bolt', 'M10*50')).toBeNull()
    expect(sizeThickness('Black Sheet', '')).toBeNull()
  })

  it('finds a grade’s band for the thickness, its coating aside, or through the equivalences', () => {
    expect(labGradeKey('S350GD+Z275')).toBe('s350gd')
    expect(gradeFor(gradeRows(GRADES, 'sheet', 's420 mc'), 2.4)?.id).toBe('a')
    expect(gradeFor(gradeRows(GRADES, 'sheet', 'S420MC'), 3)?.id).toBe('b')
    expect(gradeFor(gradeRows(GRADES, 'sheet', 'S420MC'), null)).toBeNull()
    expect(gradeFor(gradeRows(GRADES, 'sheet', 'S350GD+Z275'), null)?.id).toBe('c')
    expect(gradeRows(GRADES, 'bolt', 'S420MC')).toEqual([])
    expect(gradeRows(GRADES, 'sheet', 'S420')).toEqual([])
    const index = buildGradeIndex([{ gradeA: 'S420', gradeB: 'S420MC' }])
    expect(gradeFor(gradeRows(GRADES, 'sheet', 'S420', index), 2)?.id).toBe('a')
    expect(limitsOf(null)).toEqual({ yieldMin: null, yieldMax: null, tensileMin: null, tensileMax: null, elongationMin: null })
  })

  it('writes limits as the report does', () => {
    expect(rangeText(480, 620)).toBe('480-620')
    expect(rangeText(420, null, true)).toBe('420')
    expect(rangeText(360, null)).toBe('≥ 360')
    expect(rangeText(null, 280, true)).toBe('≤ 280')
    expect(rangeText(null, null)).toBe('')
  })

  it('judges every specimen: one under the minimum fails the test, whatever the average', () => {
    const limits = limitsOf(GRADES[0])
    const j = judge([{ tensile: 511.7, yield: 423.6, elongation: 31.6 }, { tensile: 509.5, yield: 408.9, elongation: 33.2 }, { tensile: 510.8, yield: 405.7, elongation: 25.1 }, { tensile: null, yield: null, elongation: null }], limits)
    expect(j).toEqual({ tensileAvg: 510.67, yieldAvg: 412.73, elongationAvg: 29.97, tensileOk: true, yieldOk: false, elongationOk: true, result: 'fail' })
    expect(judge([{ tensile: 500, yield: 430, elongation: 20 }], limits).result).toBe('pass')
    expect(judge([{ tensile: 500, yield: null, elongation: null }], limitsOf(null)).result).toBe('no-limits')
    expect(judge([], limits).result).toBe('no-results')
    expect(withinLimits(280, null, 280)).toBe(true)
    expect(withinLimits(281, null, 280)).toBe(false)
    expect(variance(510.67, 524)).toBe(-13.33)
    expect(variance(null, 524)).toBeNull()
  })

  it('numbers tests as the lab does', () => {
    expect(parseLabReference('93-26')).toEqual({ number: 93, year: 2026 })
    expect(parseLabReference('02-25')).toEqual({ number: 2, year: 2025 })
    expect(parseLabReference('26-3')).toBeNull()
    expect(parseLabReference('NCR-1')).toBeNull()
  })

  it('reads the machine log’s rows as tests: its words for a specimen, year-first names, repeats, dates and N/A', () => {
    expect(logSpecimen('Glavanized Sheet', '')).toBe('Galvanized Sheet')
    expect(logSpecimen('Sheet', 'Z.C')).toBe('Galvanized Sheet')
    expect(logSpecimen('Sheet', 'S420')).toBe('Black Sheet')
    expect(logSpecimen('Bolt', '8.8')).toBe('Bolt')
    expect(logSpecimen('Bolt', 'S420')).toBe('Black Sheet')
    expect(logSpecimen('Bolt', 'S350GD')).toBe('Galvanized Sheet')
    expect(logSpecimen('Tube 50*50', '')).toBeNull()
    const row = (cells: Partial<Record<number, string>>) => Array.from({ length: 19 }, (_, i) => cells[i] ?? '')
    const { tests, skipped } = parseLabLog([
      row({ 0: 'No.', 1: 'Date', 2: 'Name' }),
      row({ 0: '445', 1: '2026-07-16', 2: '93-26', 3: 'Black Sheet', 4: 'S420', 5: '2.4', 6: '456596-0-0-0', 7: '510.7', 8: '412.7', 9: '33.3', 10: '2', 11: 'Link Misr 06-07-2025 ezz', 12: '20121', 13: '93-26', 14: 'Awny Erian', 16: '524', 17: '430', 18: '23' }),
      row({ 0: '364', 1: '2026-01-14', 2: '26-3', 3: 'Bolt', 4: '8.8', 5: 'M10*50', 7: '949', 8: 'N/A', 9: '3.9', 11: 'N/A', 14: '#REF!' }),
      row({ 0: '3', 1: '2025-05-28', 2: '02-25', 3: 'Sheet', 4: 'Z.C', 7: '365.7', 10: '28-3', 11: '45714' }),
      row({ 0: '4', 1: '2025-05-28', 2: '02-25', 3: 'Sheet', 4: 'Z.C', 7: '366' }),
      row({ 0: '530', 2: '178-26', 13: '178-26' }),
      row({ 0: '9', 1: '2025-01-01', 3: 'Wire' }),
    ])
    expect(skipped).toBe(1)
    expect(tests.map((t) => t.reference)).toEqual(['93-26', '3-26', '2-25', '2-25 (2)'])
    expect(tests[0]).toMatchObject({ testDate: '2026-07-16', specimenType: 'Black Sheet', grade: 'S420', size: '2.4', specimenCode: '456596-0-0-0', tensile: 510.7, yield: 412.7, elongation: 33.3, hardness: 2, certificate: 'Link Misr 06-07-2025 ezz', cusNo: '20121', testedBy: 'Awny Erian', mtcTensile: 524, mtcYield: 430, mtcElongation: 23 })
    expect(tests[1]).toMatchObject({ specimenType: 'Bolt', yield: null, certificate: '', testedBy: '' })
    expect(tests[2]).toMatchObject({ specimenType: 'Galvanized Sheet', hardness: null, notes: 'Hardness 28-3', certificate: '2025-02-26' })
  })
})
