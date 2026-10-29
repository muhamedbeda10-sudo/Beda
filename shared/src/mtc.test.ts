import { describe, expect, it } from 'vitest'
import {
  MTC_REGISTERS,
  cleanMtcNumber,
  coilStandard,
  mtcCertificateField,
  mtcDoubtShare,
  mtcGradeIndex,
  mtcIdField,
  mtcInputFields,
  mtcJudge,
  mtcLimitText,
  mtcValuesOf,
  readWrittenNumber,
  slittingProblem,
  slittingText,
  type MtcStandard,
} from './mtc'

describe('a certificate’s numbers, as written', () => {
  it('reads a comma before exactly three digits as a thousands separator', () => {
    expect(cleanMtcNumber('1,250')).toBe(1250)
    expect(cleanMtcNumber('12,500')).toBe(12500)
    expect(cleanMtcNumber('1,250,000')).toBe(1250000)
    expect(cleanMtcNumber(' 24,180 ')).toBe(24180)
  })

  it('reads commas as thousands when a dot is the decimal point', () => {
    expect(cleanMtcNumber('1,250.5')).toBe(1250.5)
    expect(cleanMtcNumber('1,250,000.125')).toBe(1250000.125)
    expect(cleanMtcNumber('1,250.5555')).toBe(1250.556)
  })

  it('reads dots as thousands when a comma is the decimal point', () => {
    expect(cleanMtcNumber('1.250,5')).toBe(1250.5)
    expect(cleanMtcNumber('1.250.000')).toBe(1250000)
  })

  it('keeps a single comma that cannot group thousands as a decimal comma', () => {
    expect(cleanMtcNumber('12,5')).toBe(12.5)
    expect(cleanMtcNumber('1,25')).toBe(1.25)
    expect(cleanMtcNumber('0,125')).toBe(0.125)
    expect(cleanMtcNumber('355,1234')).toBe(355.123)
  })

  it('reads plain numbers as they are', () => {
    expect(cleanMtcNumber('1250')).toBe(1250)
    expect(cleanMtcNumber('1.5')).toBe(1.5)
    expect(cleanMtcNumber(0.0004)).toBe(0)
    expect(cleanMtcNumber(355.1236)).toBe(355.124)
  })

  it('refuses what is not one number rather than guessing', () => {
    for (const text of ['1,250,5', '1,25.5', '1.2.5', '1,2,3', 'abc', '12 kg', ',', '.', '   ']) {
      expect(cleanMtcNumber(text), text).toBeUndefined()
    }
    expect(Number.isNaN(readWrittenNumber('1,250,5'))).toBe(true)
    expect(cleanMtcNumber('-5')).toBeUndefined()
    expect(cleanMtcNumber('')).toBeUndefined()
    expect(cleanMtcNumber(null)).toBeUndefined()
  })
})

describe('the coil register as the factory’s sheet has it', () => {
  const coils = MTC_REGISTERS.coils
  it('keeps the sheet’s column order, with the delivery note’s fields not read from a certificate', () => {
    expect(coils.fields.map((f) => f.key)).toEqual([
      'supplier', 'poNumber', 'heatNumber', 'coilNumber', 'productForm', 'thickness', 'width', 'length', 'grade', 'smType',
      'deliveryDate', 'mtcNumber', 'yield', 'tensile', 'elongation', 'notes',
    ])
    expect(mtcIdField(coils).key).toBe('coilNumber')
    expect(mtcInputFields(coils).map((f) => f.key)).not.toContain('poNumber')
    expect(mtcInputFields(coils).map((f) => f.key)).not.toContain('deliveryDate')
    expect(mtcCertificateField(coils)?.key).toBe('mtcNumber')
    expect(mtcCertificateField(MTC_REGISTERS['welding-wire'])).toBeUndefined()
    // What the delivery note brings is never taken from a review.
    expect(mtcValuesOf(coils, { coilNumber: 'C1', poNumber: 'PO-1', deliveryDate: '2026-01-01' })).toEqual({ coilNumber: 'C1' })
  })

  it('does not doubt a reading for what not every mill prints', () => {
    // The seven fields counted before still count; missing heat number, form, tensile, elongation, length and MTC No. do not.
    expect(mtcDoubtShare(coils, [{ uncertain: ['heatNumber', 'productForm', 'tensile', 'elongation', 'length', 'mtcNumber'] }])).toBe(0)
    expect(mtcDoubtShare(coils, [{ uncertain: ['yield', 'grade', 'thickness'] }])).toBeCloseTo(3 / 7)
  })

  it('judges yield, tensile and elongation against the grade, green or red, and says nothing without a limit', () => {
    const std: MtcStandard = { grade: 'S420MC', standard: '', yieldMin: 420, yieldMax: 540, tensileMin: 480, tensileMax: 620, elongationMin: 16 }
    expect(mtcJudge(std, 'yield', 433)).toBe(true)
    expect(mtcJudge(std, 'yield', 560)).toBe(false)
    expect(mtcJudge(std, 'tensile', 470)).toBe(false)
    expect(mtcJudge(std, 'elongation', 16)).toBe(true)
    expect(mtcJudge(std, 'elongation', undefined)).toBeNull()
    expect(mtcJudge(null, 'yield', 433)).toBeNull()
    expect(mtcJudge({ ...std, tensileMin: null, tensileMax: null }, 'tensile', 100)).toBeNull()
    expect(mtcLimitText(std, 'tensile')).toBe('480–620')
    expect(mtcLimitText(std, 'elongation')).toBe('≥ 16')
  })

  it('finds a coil’s grade band as the lab does: by its thickness, through an equivalence, without its coating', () => {
    const band = (thicknessFrom: number | null, thicknessTo: number | null, yieldMin: number) =>
      ({ grade: 'S350GD', standard: 'EN 10346', thicknessFrom, thicknessTo, yieldMin, yieldMax: null, tensileMin: 420, tensileMax: null, elongationMin: 16 })
    const grades = [band(null, 3, 350), band(3, null, 340)]
    const index = mtcGradeIndex({ gradeMappings: [{ gradeA: 'S350GD', gradeB: 'E350' }] })
    expect(coilStandard(grades, index, 'S350GD+Z275', 2)?.yieldMin).toBe(350)
    expect(coilStandard(grades, index, 'S350GD', 4)?.yieldMin).toBe(340)
    expect(coilStandard(grades, index, 'E350', 2)?.grade).toBe('S350GD')
    expect(coilStandard(grades, index, 'S235JR', 2)).toBeNull()
    expect(coilStandard(grades, index, undefined, 2)).toBeNull()
  })

  it('checks a slitting’s strips: some, each above zero, together no wider than the coil', () => {
    expect(slittingProblem([400, 400, 420], 1250)).toBeNull()
    expect(slittingProblem([700, 600], 1250)).toMatch(/wider than the coil/)
    expect(slittingProblem([], 1250)).toMatch(/at least one/)
    expect(slittingProblem([0], null)).toMatch(/above zero/)
    expect(slittingProblem([5000], null)).toBeNull()
    expect(slittingText([400, 400, 420.5])).toBe('400 + 400 + 420.5')
  })
})
