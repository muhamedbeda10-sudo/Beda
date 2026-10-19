import { describe, expect, it } from 'vitest'
import { isDecimalOrBlank, normaliseDecimal, parseDecimal } from './decimal'

describe('a figure as an inspector types it', () => {
  it('takes a comma or the Arabic decimal mark for a point, and Arabic or Persian digits for Latin ones', () => {
    expect(normaliseDecimal('0,5')).toBe('0.5')
    expect(normaliseDecimal('٠٫٥')).toBe('0.5')
    expect(normaliseDecimal('۱۲۳٫۴')).toBe('123.4')
    expect(normaliseDecimal('١٢٠٩')).toBe('1209')
    expect(normaliseDecimal(' −0.2 ')).toBe('-0.2')
    // What is not a figure is left as typed, to be refused.
    expect(normaliseDecimal('0.5mm')).toBe('0.5mm')
  })

  it('reads blank as nothing, and anything that is not a plain number as not a number', () => {
    expect(parseDecimal('')).toBeNull()
    expect(parseDecimal('   ')).toBeNull()
    expect(parseDecimal(undefined)).toBeNull()
    expect(parseDecimal('0,5')).toBe(0.5)
    expect(parseDecimal('٠٫٥')).toBe(0.5)
    expect(parseDecimal('-1.25')).toBe(-1.25)
    expect(parseDecimal('+3')).toBe(3)
    expect(parseDecimal('.5')).toBe(0.5)
    expect(parseDecimal('12.')).toBe(12)
    for (const bad of ['0.5mm', 'abc', '1.2.3', '1e3', '0x10', 'Infinity', '-', '.', '1 000', '1,000.5']) {
      expect(parseDecimal(bad), bad).toBeNaN()
    }
  })

  it('says which fields to mark', () => {
    expect(isDecimalOrBlank('')).toBe(true)
    expect(isDecimalOrBlank('12,5')).toBe(true)
    expect(isDecimalOrBlank('12.5 mm')).toBe(false)
  })
})
