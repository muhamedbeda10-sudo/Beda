import { describe, expect, it } from 'vitest'
import { LONG_PRESS_MS, LONG_PRESS_SLOP, driftedTooFar } from './Tooltip'

describe('a long press on a touch screen', () => {
  it('waits half a second, longer than a tap and shorter than the phone’s own menu', () => {
    expect(LONG_PRESS_MS).toBe(500)
  })

  it('survives a finger that trembles, not one that starts to scroll', () => {
    const down = { x: 100, y: 200 }
    expect(driftedTooFar(down, down)).toBe(false)
    expect(driftedTooFar(down, { x: 104, y: 205 })).toBe(false)
    expect(driftedTooFar(down, { x: 100 + LONG_PRESS_SLOP, y: 200 })).toBe(false)
    expect(driftedTooFar(down, { x: 100, y: 200 - LONG_PRESS_SLOP - 1 })).toBe(true)
    expect(driftedTooFar(down, { x: 107, y: 207 })).toBe(true)
  })
})
