import { describe, expect, it } from 'vitest'
import { pdiDay } from './PdiList'

describe('the PDI list’s days', () => {
  it('counts back from the factory day in the factory’s zone', () => {
    // 03:00 on 1 October in Cairo (UTC+3): still 30 September's factory day.
    const night = new Date('2026-10-01T00:00:00Z')
    expect(pdiDay('Africa/Cairo', 0, night)).toBe('2026-09-30')
    expect(pdiDay('Africa/Cairo', 7, night)).toBe('2026-09-23')
    expect(pdiDay('Africa/Cairo', 0, new Date('2026-10-01T05:00:00Z'))).toBe('2026-10-01')
    expect(pdiDay('Africa/Cairo', 31, new Date('2026-03-01T06:00:00Z'))).toBe('2026-01-29')
  })
})
