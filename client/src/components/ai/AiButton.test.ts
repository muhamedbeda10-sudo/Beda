// The assistant's button is dragged where the person wants it: the place is held on screen whatever the window's
// size, and a drop back in its corner gives it its default place again.

import { describe, expect, it } from 'vitest'
import { clampPlace, nearHome } from './AiButton'

describe('where the assistant’s button is dropped', () => {
  it('keeps the whole button within the window', () => {
    expect(clampPlace({ right: 300, bottom: 200 }, 56, 1200, 800)).toEqual({ right: 300, bottom: 200 })
    // Dragged past the left or the top edge: held 4 px in.
    expect(clampPlace({ right: 1190, bottom: 790 }, 56, 1200, 800)).toEqual({ right: 1200 - 56 - 4, bottom: 800 - 56 - 4 })
    // Past the right or the bottom edge (the window shrank around it).
    expect(clampPlace({ right: -30, bottom: -30 }, 56, 1200, 800)).toEqual({ right: 4, bottom: 4 })
  })

  it('on a window too small for it, keeps the edge rather than a place off the screen', () => {
    expect(clampPlace({ right: 100, bottom: 100 }, 56, 40, 40)).toEqual({ right: 4, bottom: 4 })
  })

  it('counts a drop near the corner as putting the button back', () => {
    expect(nearHome({ right: 20, bottom: 20 })).toBe(true)
    expect(nearHome({ right: 35, bottom: 10 })).toBe(true)
    expect(nearHome({ right: 36, bottom: 10 })).toBe(false)
    expect(nearHome({ right: 10, bottom: 400 })).toBe(false)
  })
})
