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
