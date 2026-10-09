import { afterEach, describe, expect, it, vi } from 'vitest'
import { chunk, dayInTimeZone, formatDate, formatDateTime, formatFullTimestamp, formatTime, lockBodyScroll } from './utils'

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

describe('the factory day', () => {
  it('is the day in the factory zone, not the device or UTC', () => {
    // 22:30 UTC on Oct 5 is already Oct 6 in Cairo (UTC+3 in summer time).
    expect(dayInTimeZone(new Date('2026-10-05T22:30:00Z'), 'Africa/Cairo')).toBe('2026-10-06')
    expect(dayInTimeZone(new Date('2026-10-05T22:30:00Z'), 'UTC')).toBe('2026-10-05')
  })
})

describe('the page under an overlay', () => {
  // The tests run without a browser: a body with a style is all the lock touches.
  const stubBody = (overflow: string) => {
    const body = { style: { overflow } }
    vi.stubGlobal('document', { body })
    return body
  }
  afterEach(() => vi.unstubAllGlobals())

  it('scrolls again only when the last overlay closes, in whatever order they close', () => {
    const body = stubBody('')
    const sheet = lockBodyScroll()
    expect(body.style.overflow).toBe('hidden')
    // A modal opened from the sheet, then closed: the sheet still covers the page.
    const modal = lockBodyScroll()
    modal()
    expect(body.style.overflow).toBe('hidden')
    sheet()
    expect(body.style.overflow).toBe('')
  })

  it('gives back what the page had before the first lock, not what the second one saw', () => {
    const body = stubBody('auto')
    // A modal open while the panel turns from docked to a sheet (a rotation), then both close.
    const modal = lockBodyScroll()
    const sheet = lockBodyScroll()
    modal()
    sheet()
    expect(body.style.overflow).toBe('auto')
  })

  it('counts a release once, however often it is called', () => {
    const body = stubBody('')
    const outer = lockBodyScroll()
    const inner = lockBodyScroll()
    inner()
    inner()
    expect(body.style.overflow).toBe('hidden')
    outer()
    expect(body.style.overflow).toBe('')
  })
})
