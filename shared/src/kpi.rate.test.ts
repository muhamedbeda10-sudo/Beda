import { describe, it, expect } from 'vitest'
import { deltaPct, ppm, rejectRate } from './kpi'

describe('§15 — reject rate and PPM', () => {
  it('takes the PPM from the exact rate, not from a rate rounded to two decimals', () => {
    // 52 rejected on 9,130 accepted: 52 ÷ 9,182.
    const rate = rejectRate(52, 9130)
    expect(rate).toBe(0.5663)
    expect(ppm(rate)).toBe(5663)
    expect(rate!.toFixed(2)).toBe('0.57')
  })

  it('reads one piece per million', () => {
    expect(ppm(rejectRate(1, 999_999))).toBe(1)
  })

  it('has no rate when nothing was made', () => {
    expect(rejectRate(0, 0)).toBeNull()
    expect(ppm(null)).toBeNull()
  })

  it('keeps the change between periods to two decimals', () => {
    expect(deltaPct(0.5663, 0.5)).toBe(13.26)
    expect(deltaPct(1, null)).toBeNull()
  })
})
