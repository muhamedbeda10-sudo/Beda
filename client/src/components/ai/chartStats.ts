// ============================================================================
// §20 — the statistics behind the assistant's quality charts and the layouts
// of its other new kinds, as pure functions (./AiQualityCharts and
// ./AiMoreCharts draw them):
//
//   • a histogram's bins, and the process's capability: Cp and Cpk from the
//     short-term spread (σ within, from the average moving range of the
//     readings in time order: MR̄ / 1.128), Pp and Ppk from the overall one
//     (the readings' standard deviation) — as quality engineers read them;
//   • an X̄-R chart's subgroups: σ from the subgroups' ranges (R / d2 of each
//     subgroup's size, averaged), so subgroups of different sizes each get
//     their own limits: X̄̄ ± 3σ/√n, and R between D3·d2·σ and D4·d2·σ;
//   • the attribute charts' limits: p̄ ± 3√(p̄(1−p̄)/n), ū ± 3√(ū/n), c̄ ± 3√c̄,
//     none below zero (nor a share above one);
//   • a box plot's quartiles (linear between ranks, as Excel's QUARTILE.INC),
//     its whiskers to the furthest reading within 1.5 IQR, the rest outliers;
//   • a sankey's stages in columns, by the longest way to each;
//   • a calendar's days in weeks, Monday first;
//   • a risk's priority: S × O (× D, the RPN), and its zone.
// ============================================================================

/** The spread of some readings: how many, their mean, their standard deviation (n − 1), the least and the most. */
export interface Spread {
  n: number
  mean: number
  sd: number
  min: number
  max: number
}

export function spreadOf(values: readonly number[]): Spread | null {
  const n = values.length
  if (n === 0) return null
  const mean = values.reduce((t, v) => t + v, 0) / n
  const sd = n > 1 ? Math.sqrt(values.reduce((t, v) => t + (v - mean) ** 2, 0) / (n - 1)) : 0
  return { n, mean, sd, min: Math.min(...values), max: Math.max(...values) }
}

/** σ within: the average moving range of readings in their order, over d2 for two (1.128). Null for fewer than two. */
export function sigmaWithin(values: readonly number[]): number | null {
  if (values.length < 2) return null
  let ranges = 0
  for (let i = 1; i < values.length; i++) ranges += Math.abs(values[i] - values[i - 1])
  return ranges / (values.length - 1) / 1.128
}

export interface Capability {
  /** Short term, from σ within. */
  cp: number | null
  cpk: number | null
  /** Overall, from the standard deviation. */
  pp: number | null
  ppk: number | null
  /** Readings outside the limits, below and above. */
  below: number
  above: number
}

/**
 * How capable the process is of its limits: Cp (both limits) and Cpk (the nearer one, either alone will do) from
 * σ within, Pp and Ppk from σ overall. Null where a limit is missing or a σ is zero.
 */
export function capabilityOf(values: readonly number[], lsl: number | undefined, usl: number | undefined): Capability | null {
  const s = spreadOf(values)
  if (!s || (lsl === undefined && usl === undefined)) return null
  const within = sigmaWithin(values)
  const indices = (sigma: number | null) => {
    if (sigma === null || !(sigma > 0)) return { whole: null, nearer: null }
    const whole = lsl !== undefined && usl !== undefined ? (usl - lsl) / (6 * sigma) : null
    const sides = [usl !== undefined ? (usl - s.mean) / (3 * sigma) : null, lsl !== undefined ? (s.mean - lsl) / (3 * sigma) : null].filter((v): v is number => v !== null)
    return { whole, nearer: sides.length > 0 ? Math.min(...sides) : null }
  }
  const short = indices(within)
  const long = indices(s.sd)
  return {
    cp: short.whole,
    cpk: short.nearer,
    pp: long.whole,
    ppk: long.nearer,
    below: lsl === undefined ? 0 : values.filter((v) => v < lsl).length,
    above: usl === undefined ? 0 : values.filter((v) => v > usl).length,
  }
}

/** How a capability index reads: 1.33 and above capable, 1 to 1.33 only just, below 1 not. */
export function capabilityTone(index: number | null): 'good' | 'fair' | 'poor' | null {
  if (index === null) return null
  return index >= 1.33 ? 'good' : index >= 1 ? 'fair' : 'poor'
}

/** A step for an axis across a span: 1, 2, 2.5 or 5 of a power of ten, giving about `parts` steps. */
export function niceStep(span: number, parts: number): number {
  if (!(span > 0)) return 1
  const raw = span / parts
  const p = 10 ** Math.floor(Math.log10(raw))
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((step) => step >= raw) ?? 10 * p
}

export interface Bins {
  /** The edges of the bins, one more than the bins: [from, to) each, the last [from, to]. */
  edges: number[]
  counts: number[]
}

/**
 * A histogram's bins: about √n of them (5 to 20), of a round width, across the readings and the limits given, so a
 * limit outside every reading is still on the axis.
 */
export function binsOf(values: readonly number[], also: readonly number[] = []): Bins {
  const all = [...values, ...also]
  const lo = Math.min(...all)
  const hi = Math.max(...all)
  const parts = Math.min(20, Math.max(5, Math.ceil(Math.sqrt(values.length))))
  const span = hi - lo || Math.abs(hi) || 1
  // The round width just under the even one, so there are at least as many bins as wanted; one up when that makes too many.
  const even = span / parts
  const p = 10 ** Math.floor(Math.log10(even))
  const under = [10, 5, 2.5, 2, 1].map((m) => m * p).find((step) => step <= even) ?? p
  const width = Math.ceil(span / under) > 2 * parts ? niceStep(span, parts) : under
  const from = Math.floor(lo / width) * width
  let to = Math.ceil(hi / width) * width
  if (to <= from) to = from + width
  const k = Math.max(1, Math.round((to - from) / width))
  const edges = Array.from({ length: k + 1 }, (_, i) => from + i * width)
  const counts = new Array<number>(k).fill(0)
  for (const v of values) counts[Math.min(k - 1, Math.max(0, Math.floor((v - from) / width + 1e-9)))]++
  return { edges, counts }
}

/** The normal curve's height at x, for a mean and σ: scaled by the caller to the bins' counts. */
export const normalAt = (x: number, mean: number, sd: number) => Math.exp(-0.5 * ((x - mean) / sd) ** 2) / (sd * Math.sqrt(2 * Math.PI))

// ---- Control charts with limits of their own at each point ---------------------------------

/** A control chart whose limits may change from point to point (subgroups or samples of different sizes). */
export interface Stepped {
  values: (number | null)[]
  center: number
  ucl: (number | null)[]
  lcl: (number | null)[]
  /** Whether each point is beyond its limits. */
  out: boolean[]
}

const outOf = (values: readonly (number | null)[], ucl: readonly (number | null)[], lcl: readonly (number | null)[]) =>
  values.map((v, i) => v !== null && ((ucl[i] !== null && v > ucl[i]!) || (lcl[i] !== null && v < lcl[i]!)))

/** d2, D3 and D4 for subgroups of 2 to 10. */
const D2 = [0, 0, 1.128, 1.693, 2.059, 2.326, 2.534, 2.704, 2.847, 2.97, 3.078]
const D3 = [0, 0, 0, 0, 0, 0, 0, 0.076, 0.136, 0.184, 0.223]
const D4 = [0, 0, 3.267, 2.574, 2.282, 2.114, 2.004, 1.924, 1.864, 1.816, 1.777]

export interface XbarR {
  /** The subgroups drawn (those of 2 to 10 readings), in order, with their sizes. */
  sizes: number[]
  means: Stepped
  ranges: Stepped
  sigma: number
  /** Subgroups left out: a single reading, or more than ten. */
  left: number
}

/** An X̄-R chart of subgroups of readings; null with fewer than two subgroups of 2 to 10. */
export function xbarROf(groups: readonly (readonly number[])[]): (XbarR & { kept: number[] }) | null {
  const kept = groups.map((g, i) => ({ g, i })).filter(({ g }) => g.length >= 2 && g.length <= 10)
  if (kept.length < 2) return null
  const means = kept.map(({ g }) => g.reduce((t, v) => t + v, 0) / g.length)
  const ranges = kept.map(({ g }) => Math.max(...g) - Math.min(...g))
  const sizes = kept.map(({ g }) => g.length)
  const sigma = ranges.reduce((t, r, k) => t + r / D2[sizes[k]], 0) / kept.length
  const grand = means.reduce((t, m) => t + m, 0) / means.length
  const mUcl = sizes.map((n) => grand + (3 * sigma) / Math.sqrt(n))
  const mLcl = sizes.map((n) => grand - (3 * sigma) / Math.sqrt(n))
  const rCenter = sizes.map((n) => D2[n] * sigma)
  const rUcl = sizes.map((n) => D4[n] * D2[n] * sigma)
  const rLcl = sizes.map((n) => D3[n] * D2[n] * sigma)
  const rBar = rCenter.reduce((t, v) => t + v, 0) / rCenter.length
  return {
    sizes,
    sigma,
    left: groups.length - kept.length,
    kept: kept.map(({ i }) => i),
    means: { values: means, center: grand, ucl: mUcl, lcl: mLcl, out: outOf(means, mUcl, mLcl) },
    ranges: { values: ranges, center: rBar, ucl: rUcl, lcl: rLcl.map((v) => (v > 0 ? v : null)), out: outOf(ranges, rUcl, rLcl.map((v) => (v > 0 ? v : null))) },
  }
}

/**
 * An attribute chart of each sample's count (defective pieces, defects) and size (pieces inspected, units): a p-chart
 * plots the share defective in %, a u-chart defects per unit, a c-chart the count itself (its size taken as one).
 */
export function attributeOf(kind: 'p' | 'u' | 'c', counts: readonly (number | null)[], sizes: readonly (number | null)[]): Stepped | null {
  const at = counts.map((c, i) => (c !== null && (kind === 'c' || (sizes[i] !== null && sizes[i]! > 0)) ? i : -1)).filter((i) => i >= 0)
  if (at.length < 2) return null
  const total = at.reduce((t, i) => t + counts[i]!, 0)
  const size = (i: number) => (kind === 'c' ? 1 : sizes[i]!)
  const whole = at.reduce((t, i) => t + size(i), 0)
  const bar = total / whole
  const scale = kind === 'p' ? 100 : 1
  const values = counts.map((c, i) => (at.includes(i) ? (c! / size(i)) * scale : null))
  const spread = (i: number) => (kind === 'p' ? 3 * Math.sqrt((bar * (1 - bar)) / size(i)) : 3 * Math.sqrt(bar / size(i)))
  const ucl = counts.map((_, i) => (at.includes(i) ? (kind === 'p' ? Math.min(1, bar + spread(i)) : bar + spread(i)) * scale : null))
  const lcl = counts.map((_, i) => {
    if (!at.includes(i)) return null
    const v = bar - spread(i)
    return v > 0 ? v * scale : null
  })
  return { values, center: bar * scale, ucl, lcl, out: outOf(values, ucl, lcl) }
}

// ---- Box plot ------------------------------------------------------------------------------

export interface BoxStats {
  n: number
  q1: number
  median: number
  q3: number
  /** The whiskers' ends: the furthest readings within 1.5 IQR of the box. */
  low: number
  high: number
  mean: number
  outliers: number[]
}

/** A quantile of sorted readings, linear between ranks (QUARTILE.INC). */
export function quantile(sorted: readonly number[], q: number): number {
  const at = (sorted.length - 1) * q
  const lo = Math.floor(at)
  const hi = Math.ceil(at)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo)
}

export function boxOf(values: readonly number[]): BoxStats | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const q1 = quantile(s, 0.25)
  const q3 = quantile(s, 0.75)
  const reach = 1.5 * (q3 - q1)
  const inside = s.filter((v) => v >= q1 - reach && v <= q3 + reach)
  return {
    n: s.length,
    q1,
    median: quantile(s, 0.5),
    q3,
    low: inside[0] ?? q1,
    high: inside[inside.length - 1] ?? q3,
    mean: s.reduce((t, v) => t + v, 0) / s.length,
    outliers: s.filter((v) => v < q1 - reach || v > q3 + reach),
  }
}

// ---- Sankey --------------------------------------------------------------------------------

export interface SankeyLink {
  from: string
  to: string
  value: number
}

export interface SankeyNode {
  name: string
  /** Its column: the longest way to it from a stage nothing flows into. */
  column: number
  /** What flows through it: the more of what comes in and what goes out. */
  value: number
}

/** A sankey's stages, each in its column, in the order first met; the links as given (none of them a loop: checked). */
export function sankeyNodes(links: readonly SankeyLink[]): SankeyNode[] {
  const names: string[] = []
  for (const l of links) for (const n of [l.from, l.to]) if (!names.includes(n)) names.push(n)
  const column = new Map(names.map((n) => [n, 0]))
  for (let pass = 0; pass < names.length; pass++) {
    let moved = false
    for (const l of links) {
      if (column.get(l.to)! < column.get(l.from)! + 1) {
        column.set(l.to, column.get(l.from)! + 1)
        moved = true
      }
    }
    if (!moved) break
  }
  return names.map((name) => {
    const inflow = links.filter((l) => l.to === name).reduce((t, l) => t + l.value, 0)
    const outflow = links.filter((l) => l.from === name).reduce((t, l) => t + l.value, 0)
    return { name, column: column.get(name)!, value: Math.max(inflow, outflow) }
  })
}

// ---- Calendar ------------------------------------------------------------------------------

const DAY_MS = 86_400_000

export interface CalendarCell {
  /** The day as the query wrote it (YYYY-MM-DD), its value, its week (column) and its weekday (row, Monday 0). */
  day: string
  value: number | null
  week: number
  weekday: number
}

/** Days laid out in weeks, Monday first, from the week of the first to that of the last. `ms` as parseChartDate reads a day. */
export function calendarOf(days: readonly { ms: number; day: string; value: number | null }[]): { cells: CalendarCell[]; weeks: number; start: number } {
  if (days.length === 0) return { cells: [], weeks: 0, start: 0 }
  const first = Math.min(...days.map((d) => d.ms))
  const last = Math.max(...days.map((d) => d.ms))
  const weekday = (ms: number) => (new Date(ms).getUTCDay() + 6) % 7
  const start = first - weekday(first) * DAY_MS
  const cells = days.map((d) => ({ day: d.day, value: d.value, week: Math.floor((d.ms - start) / (7 * DAY_MS)), weekday: weekday(d.ms) }))
  return { cells, weeks: Math.floor((last - start) / (7 * DAY_MS)) + 1, start }
}

// ---- Risk ----------------------------------------------------------------------------------

export type RiskZone = 'high' | 'medium' | 'low'

/**
 * A failure mode's zone on its matrix, by severity and occurrence on the scale's own terms: on 1 to 10, high from
 * S × O of 40 or a severity of 9 or 10 that occurs at all often (O 4 and up), medium from 15; on 1 to 5, high from
 * 15, medium from 6.
 */
export function riskZone(s: number, o: number, scale: 5 | 10): RiskZone {
  const p = s * o
  if (scale === 5) return p >= 15 ? 'high' : p >= 6 ? 'medium' : 'low'
  return p >= 40 || (s >= 9 && o >= 4) ? 'high' : p >= 15 ? 'medium' : 'low'
}
