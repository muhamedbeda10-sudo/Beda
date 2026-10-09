/**
 * Value labels at one x position, moved apart so no two overlap. Each label
 * keeps its order top to bottom, sits at least `gap` from its neighbour, and
 * stays inside [top, bottom]; a label moves only as far as it must. Returns
 * the new y for each label, in the order given.
 */
export function spreadLabels(ys: number[], gap: number, top: number, bottom: number): number[] {
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y || a.i - b.i)
  const placed = order.map((o) => Math.min(bottom, Math.max(top, o.y)))
  // Down: each label clears the one above it.
  for (let k = 1; k < placed.length; k++) placed[k] = Math.max(placed[k], placed[k - 1] + gap)
  // Up: past the bottom edge, the stack is pushed back up as one.
  if (placed.length > 0 && placed[placed.length - 1] > bottom) {
    placed[placed.length - 1] = bottom
    for (let k = placed.length - 2; k >= 0; k--) placed[k] = Math.min(placed[k], placed[k + 1] - gap)
  }
  const out = new Array<number>(ys.length)
  order.forEach((o, k) => (out[o.i] = placed[k]))
  return out
}

/** About how wide a chart's name is drawn, per character: at 10 px, and at 11 px or 10 px bold. Generous, so names reckoned apart are apart. */
export const CHAR_WIDTH = 5.8
export const CHAR_WIDTH_WIDE = 6.2

/** A name slanted at the bar charts' angle (35°): how much of its length runs across, and how much of its height leans back. */
const SLANT_COS = Math.cos((35 * Math.PI) / 180)
const SLANT_SIN = Math.sin((35 * Math.PI) / 180)

/**
 * The left margin that names slanted under their columns need. Each is
 * turned 35° and anchored at its end under its column's middle, so it reaches
 * down and to the left — its length across, and its letters' tops leaning
 * further back; the first ones reach furthest, and a long one at the first
 * column would run past the drawing's left edge. The columns share the width
 * from the margin to `x1`, so a wider margin moves them too: this is the
 * least margin that keeps every named one (`named`) inside the drawing.
 */
export function slantRoom(names: readonly string[], x1: number, charWidth: number, fontSize: number, named: (i: number) => boolean = () => true): number {
  const n = names.length
  let room = 0
  names.forEach((name, i) => {
    if (!named(i)) return
    // Column i's middle is at x0 + (x1 - x0)·f, and the name reaches `reach` to the left of it: x0 ≥ (reach - x1·f) / (1 - f).
    const f = (i + 0.5) / n
    const reach = name.length * charWidth * SLANT_COS + fontSize * SLANT_SIN + 4
    room = Math.max(room, (reach - x1 * f) / (1 - f))
  })
  return Math.ceil(room)
}

export interface AxisName {
  /** The point it names. */
  i: number
  x: number
  anchor: 'start' | 'middle' | 'end'
}

/**
 * The names written along a line chart's x axis when they may be long (a
 * day with its year, "Oct 28, 2025"): evenly, every k-th point from the
 * first — k at least `every`, and enough that names of the longest's length
 * stand apart — each centred under its point, but kept inside the drawing
 * (0 to `width`); the last is left out when, kept inside, it would run into
 * the one before.
 */
export function axisNames(labels: readonly string[], xAt: (i: number) => number, slot: number, width: number, every: number, charWidth = CHAR_WIDTH): AxisName[] {
  const n = labels.length
  if (n === 0) return []
  const longest = Math.max(...labels.map((l) => l.length))
  const step = Math.max(1, every, Math.ceil((longest * charWidth + 12) / Math.max(slot, 1e-6)))
  const placed: (AxisName & { left: number; right: number })[] = []
  for (let i = 0; i < n; i += step) {
    const w = labels[i].length * charWidth
    const x = xAt(i)
    if (x - w / 2 < 2) placed.push({ i, x: 2, anchor: 'start', left: 2, right: 2 + w })
    else if (x + w / 2 > width - 2) placed.push({ i, x: width - 2, anchor: 'end', left: width - 2 - w, right: width - 2 })
    else placed.push({ i, x, anchor: 'middle', left: x - w / 2, right: x + w / 2 })
  }
  const last = placed.at(-1)
  const before = placed.at(-2)
  if (last && before && last.left < before.right + 4) placed.pop()
  return placed.map(({ i, x, anchor }) => ({ i, x, anchor }))
}
