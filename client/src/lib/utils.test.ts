import { describe, expect, it } from 'vitest'
import { chunk, formatDate, formatDateTime, formatFullTimestamp, formatTime } from './utils'

describe('chunk', () => {
  it('slices a list into consecutive pieces of at most the given size', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(chunk([1, 2, 3], 3)).toEqual([[1, 2, 3]])
    expect(chunk([1, 2], 10)).toEqual([[1, 2]])
    expect(chunk([], 4)).toEqual([])
  })

  it('rejects a size that could never terminate', () => {
    expect(() => chunk([1], 0)).toThrow(RangeError)
    expect(() => chunk([1], 1.5)).toThrow(RangeError)
  })
})

describe('one date format everywhere', () => {
  const year = new Date().getFullYear()
  const at = (y: number) => new Date(y, 9, 5, 15, 5, 22).toISOString()

  it('gives this year the time and another year the year, on a 24-hour clock', () => {
    expect(formatDateTime(at(year))).toBe('Oct 5, 15:05')
    expect(formatDateTime(at(year - 1))).toBe(`Oct 5, ${year - 1}`)
    expect(formatDate(at(year))).toBe('Oct 5')
    expect(formatDate(at(year - 1))).toBe(`Oct 5, ${year - 1}`)
    expect(formatTime(new Date(year, 0, 1, 9, 7).toISOString())).toBe('09:07')
  })

  it('writes the whole timestamp for a tooltip, and a dash for nothing', () => {
    expect(formatFullTimestamp(at(year))).toBe(`Mon, Oct 5, ${year}, 15:05:22`.replace('Mon', new Date(year, 9, 5).toLocaleDateString('en-US', { weekday: 'short' })))
    expect(formatDateTime(undefined)).toBe('—')
    expect(formatDate('not a date')).toBe('—')
    expect(formatFullTimestamp(null)).toBe('')
  })
})
