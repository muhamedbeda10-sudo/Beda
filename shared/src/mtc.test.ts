import { describe, expect, it } from 'vitest'
import { cleanMtcNumber, readWrittenNumber } from './mtc'

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
