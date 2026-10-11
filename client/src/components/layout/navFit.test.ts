import { describe, expect, it } from 'vitest'
import { NAV_FIT_SLACK, nextNavFit, type NavNeeds } from './navFit'

const none: NavNeeds = { full: 0, compact: 0 }

describe('how the bar’s tabs fit', () => {
  it('keeps the names while they fit, whatever the number of tabs', () => {
    const same = nextNavFit('full', none, 0, 1302)
    expect(same.fit).toBe('full')
    // Nothing changed: the same object, so nothing renders again.
    expect(same.needs).toBe(none)
  })

  it('tightens a step at a time when they do not: tighter padding first, then the icons alone', () => {
    const compact = nextNavFit('full', none, 40, 1216)
    expect(compact).toEqual({ fit: 'compact', needs: { full: 1216 + 40 + NAV_FIT_SLACK, compact: 0 } })
    const icons = nextNavFit('compact', compact.needs, 12, 1216)
    expect(icons).toEqual({ fit: 'icons', needs: { full: 1280, compact: 1216 + 12 + NAV_FIT_SLACK } })
    // Icons alone are as tight as it gets.
    expect(nextNavFit('icons', icons.needs, 30, 1000).fit).toBe('icons')
  })

  it('steps back once the window has the room the looser fit needed, with some to spare', () => {
    const needs = { full: 1356, compact: 1300 }
    expect(nextNavFit('icons', needs, 0, 1299).fit).toBe('icons')
    expect(nextNavFit('icons', needs, 0, 1300).fit).toBe('compact')
    expect(nextNavFit('compact', needs, 0, 1355).fit).toBe('compact')
    expect(nextNavFit('compact', needs, 0, 1356).fit).toBe('full')
  })

  it('reads a pixel of rounding as fitting', () => {
    expect(nextNavFit('full', none, 1, 1302).fit).toBe('full')
  })

  it('waits out of the row for the room the names needed: the menu on a touch screen keeps the tabs measured, never overflowing', () => {
    // A landscape tablet: six names do not fit at 1024, so the bar goes to icons, and a finger gets the menu instead.
    const compact = nextNavFit('full', none, 180, 960)
    const icons = nextNavFit('compact', compact.needs, 110, 960)
    expect(icons.fit).toBe('icons')
    const needs = icons.needs
    expect(needs.compact).toBe(960 + 110 + NAV_FIT_SLACK)
    // Out of the row the tabs push nothing past it, so the overflow reads 0; that alone does not bring the names back.
    const stay = nextNavFit('icons', needs, 0, needs.compact - 1)
    expect(stay.fit).toBe('icons')
    expect(stay.needs).toBe(needs)
    // Turned or widened to the room the tighter names needed, they come back (and the menu button goes).
    expect(nextNavFit('icons', needs, 0, needs.compact)).toEqual({ fit: 'compact', needs })
  })
})
