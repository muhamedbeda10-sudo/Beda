import { describe, expect, it } from 'vitest'
import { CHAR_WIDTH, CHAR_WIDTH_WIDE, axisNames, dataSpan, labelEvery, runsOf, slantRoom, spreadLabels } from './labels'

describe('labels that never overlap', () => {
  it('leaves labels already apart where they are', () => {
    expect(spreadLabels([20, 60, 100], 11, 0, 200)).toEqual([20, 60, 100])
  })
  it('pushes a crowded label down just enough, keeping the order', () => {
    expect(spreadLabels([50, 48, 52], 11, 0, 200)).toEqual([59, 48, 70])
  })
  it('pushes the stack back up from the bottom edge', () => {
    expect(spreadLabels([195, 196], 11, 0, 200)).toEqual([189, 200])
  })
  it('keeps a label below the top edge', () => {
    expect(spreadLabels([-5], 11, 8, 200)).toEqual([8])
  })
})

describe('names slanted under their columns', () => {
  const COS = Math.cos((35 * Math.PI) / 180)
  const SIN = Math.sin((35 * Math.PI) / 180)
  /** How far right of the drawing's left edge column i's name reaches at most (10 px letters leaning back as well), with the margin given. */
  const reachLeft = (names: string[], i: number, x0: number, x1: number) => x0 + ((x1 - x0) * (i + 0.5)) / names.length - names[i].length * CHAR_WIDTH * COS - 10 * SIN

  it('asks for the room a long first name needs, so it is not cut at the left edge', () => {
    const names = ['Paint thickness out of to…', 'Scratch', 'Burr', 'Hole misalignment', 'Colour difference', 'Weld porosity', 'Weld crack', 'Bubbles', 'Dimension shift', 'Dent', 'Rust spot', 'Missing hole']
    const room = slantRoom(names, 808, CHAR_WIDTH, 10)
    // With the dashboard's 44 the first name started 38 px left of the drawing.
    expect(reachLeft(names, 0, 44, 808)).toBeLessThan(0)
    expect(room).toBeGreaterThan(44)
    names.forEach((_, i) => expect(reachLeft(names, i, room, 808)).toBeGreaterThanOrEqual(1))
  })

  it('asks for nothing when the names are short, and only for the names written', () => {
    expect(slantRoom(['A', 'B', 'C'], 700, CHAR_WIDTH, 10)).toBeLessThanOrEqual(0)
    const names = ['A very long name of a category', 'B', 'C', 'D']
    expect(slantRoom(names, 700, CHAR_WIDTH, 10, (i) => i > 0)).toBeLessThanOrEqual(0)
    expect(slantRoom(names, 700, CHAR_WIDTH, 10)).toBeGreaterThan(0)
  })
})

describe('names along a line chart', () => {
  // A year of days, as the assistant draws them: "Oct 1, 2025" … across a 760-wide drawing.
  const days = Array.from({ length: 365 }, (_, i) => {
    const d = new Date(Date.UTC(2025, 9, 1 + i))
    return `${d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} ${d.getUTCDate()}, ${d.getUTCFullYear()}`
  })
  const x0 = 50
  const x1 = 744
  const slot = (x1 - x0) / days.length
  const xAt = (i: number) => x0 + slot * i + slot / 2
  const extent = (a: { x: number; anchor: string }, label: string) => {
    const w = label.length * CHAR_WIDTH
    return a.anchor === 'start' ? [a.x, a.x + w] : a.anchor === 'end' ? [a.x - w, a.x] : [a.x - w / 2, a.x + w / 2]
  }

  it('writes as many as stand apart at their length, evenly from the first, none over another', () => {
    const names = axisNames(days, xAt, slot, 760, 31)
    expect(names.length).toBeGreaterThanOrEqual(6)
    expect(names.length).toBeLessThanOrEqual(10)
    expect(names[0].i).toBe(0)
    const step = names[1].i - names[0].i
    names.forEach((a, k) => expect(a.i).toBe(k * step))
    for (let k = 1; k < names.length; k++) expect(extent(names[k], days[names[k].i])[0]).toBeGreaterThan(extent(names[k - 1], days[names[k - 1].i])[1])
  })

  it('keeps every name inside the drawing', () => {
    for (const a of axisNames(days, xAt, slot, 760, 1)) {
      const [left, right] = extent(a, days[a.i])
      expect(left).toBeGreaterThanOrEqual(0)
      expect(right).toBeLessThanOrEqual(760)
    }
  })

  it('names every point of a short axis, as the dashboard does', () => {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun']
    const s = (x1 - x0) / months.length
    expect(axisNames(months, (i) => x0 + s * i + s / 2, s, 760, 1).map((a) => [a.i, a.anchor])).toEqual(months.map((_, i) => [i, 'middle']))
  })
})

describe('how many names an axis writes', () => {
  it('writes every month on a desktop card, and as many as have room on a phone', () => {
    // Twelve months across the 636 px a 720-wide drawing plots on: every one.
    expect(labelEvery(12, 636, 3)).toBe(1)
    // Across the 244 px of a 360 px phone's card: every other one at most.
    const k = labelEvery(12, 244, 3)
    expect(k).toBeGreaterThan(1)
    expect(Math.ceil(12 / k) * 32).toBeLessThanOrEqual(244)
  })

  it('gives a long name the room of its letters', () => {
    // "Sep 1 – Sep 7", 13 letters at 11 px: about 93 px a name.
    const k = labelEvery(30, 600, 13)
    expect(Math.ceil(30 / k) * (13 * CHAR_WIDTH_WIDE + 12)).toBeLessThanOrEqual(600)
    expect(labelEvery(30, 600, 13, CHAR_WIDTH_WIDE)).toBeGreaterThan(labelEvery(30, 600, 3, CHAR_WIDTH_WIDE))
  })

  it('writes the one name of a one-point axis, and one name at least however narrow', () => {
    expect(labelEvery(1, 10, 20)).toBe(1)
    expect(labelEvery(5, 10, 20)).toBe(5)
  })
})

describe('the run of an axis worth drawing', () => {
  it('leaves out the empty points before the first and after the last that hold anything', () => {
    // This year on the 10th of October, production from September: Sep and Oct.
    const made = [0, 0, 0, 0, 0, 0, 0, 0, 1815, 760]
    expect(dataSpan(made.length, (i) => made[i] > 0)).toEqual({ from: 8, to: 10 })
    expect(dataSpan(4, (i) => [0, 3, 0, 0][i] > 0)).toEqual({ from: 1, to: 2 })
  })

  it('keeps an empty point between two that hold something: a gap is part of the story', () => {
    const made = [0, 4, 0, 0, 7, 0]
    expect(dataSpan(made.length, (i) => made[i] > 0)).toEqual({ from: 1, to: 5 })
  })

  it('keeps the whole axis when nothing holds anything', () => {
    expect(dataSpan(3, () => false)).toEqual({ from: 0, to: 3 })
    expect(dataSpan(0, () => true)).toEqual({ from: 0, to: 0 })
  })
})

describe('points gathered into runs', () => {
  it('starts a run at the first point and at each point that starts one', () => {
    // Ten days from a Thursday: Thu–Sun, then a week from Monday, then Mon again.
    const weekday = [4, 5, 6, 0, 1, 2, 3, 4, 5, 6, 0, 1]
    expect(runsOf(weekday.length, (i) => weekday[i] === 1)).toEqual([
      { from: 0, to: 4 },
      { from: 4, to: 11 },
      { from: 11, to: 12 },
    ])
  })

  it('is one run when nothing starts another, and none for no points', () => {
    expect(runsOf(3, () => false)).toEqual([{ from: 0, to: 3 }])
    expect(runsOf(0, () => true)).toEqual([])
  })
})
