// The schedule's zoom: a day is never squeezed under 8 px nor stretched past 40 px an hour, and the hour ticks a
// day gets follow its width.

import { describe, expect, it } from 'vitest'
import { clampZoom, ticksPerDay, zoomBounds } from './ScheduleSection'

describe('the schedule’s zoom', () => {
  it('holds the zoom between the narrowest and the widest day', () => {
    // 2 weeks: 110 px a day.
    expect(clampZoom(1, 110)).toBe(1)
    expect(clampZoom(0.01, 110)).toBeCloseTo(8 / 110)
    expect(clampZoom(1000, 110)).toBeCloseTo(960 / 110)
    expect(zoomBounds(110)).toEqual({ min: 8 / 110, max: 960 / 110 })
  })

  it('treats a nonsense zoom (an old stored value) as 1×', () => {
    expect(clampZoom(NaN, 110)).toBe(1)
    expect(clampZoom(-2, 110)).toBe(1)
    expect(clampZoom(Infinity, 110)).toBe(1)
  })

  it('names the hours once a day is wide enough for their labels', () => {
    expect(ticksPerDay(28)).toBe(1)
    expect(ticksPerDay(64)).toBe(1)
    expect(ticksPerDay(80)).toBe(2)
    expect(ticksPerDay(110)).toBe(2)
    expect(ticksPerDay(160)).toBe(4)
    expect(ticksPerDay(240)).toBe(6)
    expect(ticksPerDay(480)).toBe(12)
    expect(ticksPerDay(960)).toBe(24)
  })
})
