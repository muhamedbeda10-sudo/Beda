// ============================================================================
// §20 — where everything of a diagram goes (shared/aiDiagram.ts). The model
// says what a diagram holds; this lays it out, the same way every time, for
// AiDiagram to draw. Hand-written like the dashboard's charts — no layout
// library in the bundle for a tablet on the factory Wi-Fi — and pure, so it
// is tested without a browser: the width of a text is asked of `measure`.
//
//   • flow and swimlane — layered: each box a step after the boxes whose
//     arrows enter it (a loop back, such as rework, set aside to rank them),
//     long arrows routed through the steps they pass, the boxes of each step
//     ordered to cross as few arrows as they can, then set where their
//     neighbours pull them; a swimlane keeps each box in its lane.
//   • tree — each parent centred over its children, levels apart.
//   • fishbone — the effect at the head, the bones in pairs above and below
//     the spine, each cause on its bone, its sub-causes under it.
//   • columns — side by side, each box the column's width.
//
// Everything is laid out reading left to right, then mirrored for a diagram
// that reads right to left: it starts on the right, as its words do.
// ============================================================================

import type { AiDiagramEdge, AiDiagramNode, AiDiagramShape, AiDiagramSpec } from '@qc/shared/aiDiagram'

/** A text's width in px, at a size and a weight. */
export type Measure = (text: string, size: number, weight: number) => number

export interface Font {
  size: number
  weight: number
  /** The height of a line. */
  line: number
}

export const LABEL_FONT: Font = { size: 12, weight: 600, line: 15 }
export const DETAIL_FONT: Font = { size: 10.5, weight: 400, line: 13 }
export const FIGURE_FONT: Font = { size: 12, weight: 700, line: 15 }
export const GROUP_FONT: Font = { size: 11.5, weight: 700, line: 14 }
export const EDGE_FONT: Font = { size: 10.5, weight: 600, line: 13 }

/** A box's padding, its least width, how wide its words run. */
const PAD_X = 10
const PAD_Y = 7
const MIN_W = 72
const TEXT_MAX = 156
const DECISION_TEXT_MAX = 112
/** A decision's diamond around its words: the box of its words scaled by this (2 fits it exactly; the padding takes the rest). */
const DIAMOND = 1.8
/** Between boxes of one step, and between steps (more when the arrows carry words). */
const GAP_CROSS = 18
const GAP_DUMMY = 8
const GAP_ACROSS = 52
const GAP_DOWN = 40
const EDGE_LABEL_ROOM = 28
/** Around the whole drawing. */
const MARGIN = 14
/** A swimlane's lanes: their header's width at most, the room above and below their boxes. */
const LANE_HEADER_MAX = 104
const LANE_PAD = 20
/** A tree's subtrees apart, and its levels. */
const TREE_GAP = 16
/** A fishbone: how far a bone leans per unit down, its causes' widths, gaps. */
const SLANT = 0.5
const CAUSE_MAX = 150
const SUB_INDENT = 16
const ROW_GAP = 6
const BONE_LABEL_GAP = 10
const SPINE_GAP = 16
const SLOT_GAP = 24
const TICK = 8
/** Columns: the gap between them, between boxes, the header's height. */
const COLUMN_GAP = 36
const COLUMN_MAX = 176
/** Ordering sweeps: enough for the diagrams this draws (at most 60 boxes). */
const ORDER_SWEEPS = 8
const PLACE_SWEEPS = 6

export interface Point {
  x: number
  y: number
}

/** A box as drawn: where, its shape, its words in lines, and where its words start. */
export interface PlacedNode {
  id: string
  node: AiDiagramNode
  shape: AiDiagramShape
  x: number
  y: number
  w: number
  h: number
  label: string[]
  detail: string[]
  figure?: string
  /** The top of its words, centred on the box. */
  textTop: number
  /** A fishbone's effect: drawn as the head. */
  head?: true
}

/** An arrow: its path, its words and where they go. */
export interface PlacedEdge {
  edge: AiDiagramEdge
  d: string
  label?: { lines: string[]; x: number; y: number; w: number; h: number }
}

/** A lane or a column: a band behind the boxes, with its name. */
export interface Region {
  id: string
  kind: 'lane' | 'column'
  x: number
  y: number
  w: number
  h: number
  /** Where its name is: a lane's header at its start, a column's at its top. */
  header: { x: number; y: number; w: number; h: number; lines: string[] }
}

/** A line with no arrow: a fishbone's spine, bones, and the ticks and branches its causes hang on. */
export interface Stroke {
  kind: 'spine' | 'bone' | 'tick'
  d: string
}

/** A fishbone's bone name, at the bone's outer end. */
export interface Tag {
  x: number
  y: number
  w: number
  h: number
  lines: string[]
}

export interface DiagramLayout {
  width: number
  height: number
  regions: Region[]
  strokes: Stroke[]
  edges: PlacedEdge[]
  nodes: PlacedNode[]
  tags: Tag[]
  /** Chevrons between columns (SIPOC reads from one to the next). */
  chevrons: string[]
}

// ---- Words ------------------------------------------------------------------------------

/** A text broken into lines no wider than `max`, at spaces where it can, inside a word too long for a line. */
export function wrapText(text: string, max: number, font: Font, measure: Measure): string[] {
  const width = (t: string) => measure(t, font.size, font.weight)
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    const next = line ? `${line} ${word}` : word
    if (width(next) <= max) {
      line = next
      continue
    }
    if (line) lines.push(line)
    if (width(word) <= max) {
      line = word
      continue
    }
    // A word wider than a line (a long code): cut it where it fills one.
    let piece = ''
    for (const ch of Array.from(word)) {
      if (piece && width(piece + ch) > max) {
        lines.push(piece)
        piece = ch
      } else piece += ch
    }
    line = piece
  }
  if (line) lines.push(line)
  return lines.length > 0 ? lines : ['']
}

const widest = (lines: readonly string[], font: Font, measure: Measure) => Math.max(0, ...lines.map((l) => measure(l, font.size, font.weight)))

interface Sized {
  id: string
  node: AiDiagramNode
  shape: AiDiagramShape
  w: number
  h: number
  label: string[]
  detail: string[]
  figure?: string
  /** The height of its words, and how far below the box's centre they sit (a cylinder's lid takes room at its top). */
  textH: number
  textShift: number
}

/** A box's words in lines and the box's size around them, by its shape. */
function sizeNode(node: AiDiagramNode, shape: AiDiagramShape, measure: Measure, max = TEXT_MAX): Sized {
  const wrapAt = shape === 'decision' ? DECISION_TEXT_MAX : max
  const label = wrapText(node.label, wrapAt, LABEL_FONT, measure)
  const detail = node.detail ? wrapText(node.detail, wrapAt, DETAIL_FONT, measure) : []
  const figure = node.figure?.text
  const textW = Math.max(widest(label, LABEL_FONT, measure), widest(detail, DETAIL_FONT, measure), figure ? measure(figure, FIGURE_FONT.size, FIGURE_FONT.weight) : 0)
  const textH = label.length * LABEL_FONT.line + (figure ? FIGURE_FONT.line : 0) + (detail.length > 0 ? 2 + detail.length * DETAIL_FONT.line : 0)
  let w = Math.max(MIN_W, textW + 2 * PAD_X)
  let h = textH + 2 * PAD_Y
  let textShift = 0
  switch (shape) {
    case 'decision':
      w = Math.max(MIN_W * 1.4, (textW + 12) * DIAMOND)
      h = Math.max(48, (textH + 8) * DIAMOND)
      break
    case 'terminal':
      w += 12
      h = Math.max(h, 30)
      break
    case 'store':
      // A cylinder: its lid takes the top.
      h += 10
      textShift = 5
      break
    case 'document':
      // Its wavy foot takes the bottom.
      h += 6
      textShift = -3
      break
    case 'inspection':
      w += 10
      break
  }
  return { id: node.id, node, shape, w: Math.ceil(w), h: Math.ceil(h), label, detail, figure, textH, textShift }
}

const place = (s: Sized, x: number, y: number, head = false): PlacedNode => {
  const p: PlacedNode = { id: s.id, node: s.node, shape: s.shape, x, y, w: s.w, h: s.h, label: s.label, detail: s.detail, textTop: y + (s.h - s.textH) / 2 + s.textShift }
  if (s.figure) p.figure = s.figure
  if (head) p.head = true
  return p
}

// ---- Placing in one dimension ---------------------------------------------------------

/**
 * Centres for items in a fixed order, each as near its wish as it can be while
 * keeping the gaps between neighbours (`sep[i]`, between i and i + 1): the
 * least squares fit, by pooling adjacent violators. Within [lo, hi] when given
 * (the room is known to hold them all).
 */
export function packInOrder(wish: readonly number[], sep: readonly number[], lo = -Infinity, hi = Infinity): number[] {
  const n = wish.length
  if (n === 0) return []
  const offset: number[] = [0]
  for (let i = 1; i < n; i++) offset[i] = offset[i - 1] + sep[i - 1]
  // Blocks of pooled values: each its mean and how many it holds.
  const blocks: { mean: number; count: number }[] = []
  for (let i = 0; i < n; i++) {
    blocks.push({ mean: wish[i] - offset[i], count: 1 })
    while (blocks.length > 1 && blocks[blocks.length - 2].mean > blocks[blocks.length - 1].mean) {
      const b = blocks.pop()!
      const a = blocks[blocks.length - 1]
      a.mean = (a.mean * a.count + b.mean * b.count) / (a.count + b.count)
      a.count += b.count
    }
  }
  const out: number[] = []
  for (const b of blocks) for (let k = 0; k < b.count; k++) out.push(b.mean + offset[out.length])
  // Into the room: pushed down from its start, then up from its end.
  if (lo > -Infinity) {
    out[0] = Math.max(out[0], lo)
    for (let i = 1; i < n; i++) out[i] = Math.max(out[i], out[i - 1] + sep[i - 1])
  }
  if (hi < Infinity) {
    out[n - 1] = Math.min(out[n - 1], hi)
    for (let i = n - 2; i >= 0; i--) out[i] = Math.min(out[i], out[i + 1] - sep[i])
  }
  return out
}

// ---- Flow and swimlane: layered ---------------------------------------------------------

interface Layer {
  /** A box, or a point an arrow passes through on its way across a step (`chain`: the arrow's index). */
  id: string
  sized: Sized | null
  rank: number
  lane: number
  /** Its centre across the steps. */
  cross: number
  order: number
}

/**
 * Which arrows run back (to a box earlier in the work: rework, a return), found
 * depth first from the boxes in the order they were given: each one, turned
 * round, leaves the arrows without a loop.
 */
export function backEdges(ids: readonly string[], edges: readonly { from: string; to: string }[]): Set<number> {
  const out = new Map<string, number[]>()
  edges.forEach((e, i) => out.set(e.from, [...(out.get(e.from) ?? []), i]))
  const hasIn = new Set(edges.map((e) => e.to))
  const state = new Map<string, 'open' | 'done'>()
  const back = new Set<number>()
  // Sources first, so the work's start is where the walk starts.
  const starts = [...ids.filter((id) => !hasIn.has(id)), ...ids]
  for (const start of starts) {
    if (state.has(start)) continue
    const stack: { id: string; next: number }[] = [{ id: start, next: 0 }]
    state.set(start, 'open')
    while (stack.length > 0) {
      const top = stack[stack.length - 1]
      const list = out.get(top.id) ?? []
      if (top.next >= list.length) {
        state.set(top.id, 'done')
        stack.pop()
        continue
      }
      const i = list[top.next++]
      const to = edges[i].to
      const s = state.get(to)
      if (s === 'open') back.add(i)
      else if (!s) {
        state.set(to, 'open')
        stack.push({ id: to, next: 0 })
      }
    }
  }
  return back
}

/** Each box's step: one after the latest box whose arrow enters it; a box only leaving arrows sits just before the first it enters. */
export function ranks(ids: readonly string[], forward: readonly { from: string; to: string }[]): Map<string, number> {
  const preds = new Map<string, string[]>(ids.map((id) => [id, []]))
  const succs = new Map<string, string[]>(ids.map((id) => [id, []]))
  for (const e of forward) {
    preds.get(e.to)!.push(e.from)
    succs.get(e.from)!.push(e.to)
  }
  const indegree = new Map(ids.map((id) => [id, preds.get(id)!.length]))
  const queue = ids.filter((id) => indegree.get(id) === 0)
  const topo: string[] = []
  while (queue.length > 0) {
    const id = queue.shift()!
    topo.push(id)
    for (const s of succs.get(id)!) {
      indegree.set(s, indegree.get(s)! - 1)
      if (indegree.get(s) === 0) queue.push(s)
    }
  }
  const rank = new Map<string, number>()
  for (const id of topo) rank.set(id, Math.max(0, ...preds.get(id)!.map((p) => rank.get(p)! + 1)))
  // A side input (a material joining at the fifth step) sits by the step it joins, not at the start.
  for (const id of [...topo].reverse()) {
    if (preds.get(id)!.length > 0 || succs.get(id)!.length === 0) continue
    rank.set(id, Math.min(...succs.get(id)!.map((s) => rank.get(s)!)) - 1)
  }
  return rank
}

/** Crossings between the arrows of two neighbouring steps, by the order of their ends. */
function crossings(segments: readonly [number, number][]): number {
  let n = 0
  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      const [a1, b1] = segments[i]
      const [a2, b2] = segments[j]
      if ((a1 - a2) * (b1 - b2) < 0) n++
    }
  }
  return n
}

interface Route {
  edge: AiDiagramEdge
  /** The boxes and passing points along it, in the direction it was ranked. */
  chain: string[]
  /** Turned round to rank it: it runs back. */
  back: boolean
}

function layered(spec: AiDiagramSpec, measure: Measure): DiagramLayout {
  const across = spec.direction === 'across' || spec.layout === 'swimlane'
  const lanes = spec.layout === 'swimlane' ? spec.groups : []
  const laneOf = new Map(lanes.map((g, i) => [g.id, i]))
  const sized = spec.nodes.map((n) => sizeNode(n, n.shape, measure))
  const sizedById = new Map(sized.map((s) => [s.id, s]))
  const ids = spec.nodes.map((n) => n.id)
  // Along the work (main) and across it (cross), by direction.
  const mainOf = (s: Sized) => (across ? s.w : s.h)
  const crossOf = (s: Sized | null) => (s ? (across ? s.h : s.w) : 0)

  const back = backEdges(ids, spec.edges)
  const forward = spec.edges.map((e, i) => (back.has(i) ? { from: e.to, to: e.from } : { from: e.from, to: e.to }))
  const rank = ranks(ids, forward)

  const items = new Map<string, Layer>()
  sized.forEach((s, i) => items.set(s.id, { id: s.id, sized: s, rank: rank.get(s.id)!, lane: laneOf.get(s.node.group ?? '') ?? 0, cross: 0, order: i }))
  // An arrow across several steps passes through a point at each step between: room is kept for it there.
  const routes: Route[] = spec.edges.map((edge, i) => {
    const f = forward[i]
    const from = items.get(f.from)!
    const to = items.get(f.to)!
    // A way back (rework) runs under the boxes it passes, in a channel of its own: it keeps no room among them.
    if (back.has(i)) return { edge, chain: [f.from, f.to], back: true }
    const chain = [f.from]
    for (let r = from.rank + 1; r < to.rank; r++) {
      const id = `\u0000${i}:${r}`
      const half = r - from.rank <= (to.rank - from.rank) / 2
      items.set(id, { id, sized: null, rank: r, lane: half ? from.lane : to.lane, cross: 0, order: from.order + (r - from.rank) * 0.001 })
      chain.push(id)
    }
    chain.push(f.to)
    return { edge, chain, back: back.has(i) }
  })
  // What pulls the boxes into order and into place: the arrows forward, through the points they pass. A way back pulls nothing.
  const links: [string, string][] = routes.filter((r) => !r.back).flatMap((r) => r.chain.slice(1).map((id, k) => [r.chain[k], id] as [string, string]))
  const predsOf = new Map<string, string[]>()
  const succsOf = new Map<string, string[]>()
  for (const [a, b] of links) {
    predsOf.set(b, [...(predsOf.get(b) ?? []), a])
    succsOf.set(a, [...(succsOf.get(a) ?? []), b])
  }

  // ---- The order of each step's boxes: lanes first, then where their neighbours are.
  const maxRank = Math.max(0, ...[...items.values()].map((it) => it.rank))
  const layers: Layer[][] = Array.from({ length: maxRank + 1 }, () => [])
  for (const it of items.values()) layers[it.rank].push(it)
  const sortLayer = (layer: Layer[]) => layer.sort((a, b) => a.lane - b.lane || a.order - b.order)
  layers.forEach((l) => {
    sortLayer(l)
    l.forEach((it, k) => (it.order = k))
  })
  const totalCrossings = () => {
    let n = 0
    for (let r = 0; r < maxRank; r++) {
      const segs: [number, number][] = []
      for (const it of layers[r]) for (const s of succsOf.get(it.id) ?? []) segs.push([it.order, items.get(s)!.order])
      n += crossings(segs)
    }
    return n
  }
  let best = layers.map((l) => l.map((it) => it.id))
  let bestCount = totalCrossings()
  for (let sweep = 0; sweep < ORDER_SWEEPS && bestCount > 0; sweep++) {
    const down = sweep % 2 === 0
    const rs = down ? [...Array(maxRank + 1).keys()].slice(1) : [...Array(maxRank).keys()].reverse()
    for (const r of rs) {
      const layer = layers[r]
      for (const it of layer) {
        const near = (down ? predsOf : succsOf).get(it.id) ?? []
        if (near.length > 0) it.order = near.reduce((n, id) => n + items.get(id)!.order, 0) / near.length
      }
      sortLayer(layer)
      layer.forEach((it, k) => (it.order = k))
    }
    const count = totalCrossings()
    if (count < bestCount) {
      bestCount = count
      best = layers.map((l) => l.map((it) => it.id))
    }
  }
  best.forEach((ids, r) => {
    layers[r] = ids.map((id) => items.get(id)!)
    layers[r].forEach((it, k) => (it.order = k))
  })

  // ---- Where each box sits across the steps: as near its neighbours as the gaps allow, in its lane.
  const gapOf = (a: Layer, b: Layer) => (a.sized && b.sized ? GAP_CROSS : GAP_DUMMY)
  const sepOf = (a: Layer, b: Layer) => crossOf(a.sized) / 2 + crossOf(b.sized) / 2 + gapOf(a, b)
  // A lane is as wide as its fullest step needs: its boxes and the gaps between them.
  const laneSize = lanes.map(
    (_, l) =>
      Math.max(
        44,
        ...layers.map((layer) => {
          const inLane = layer.filter((it) => it.lane === l)
          return inLane.reduce((n, it, k) => n + crossOf(it.sized) + (k > 0 ? gapOf(inLane[k - 1], it) : 0), 0)
        }),
      ) +
      2 * LANE_PAD,
  )
  const laneStart = laneSize.map((_, l) => laneSize.slice(0, l).reduce((n, s) => n + s, 0))
  const placeLayer = (layer: Layer[], wish: (it: Layer) => number) => {
    if (lanes.length === 0) {
      const at = packInOrder(layer.map(wish), layer.slice(1).map((it, k) => sepOf(layer[k], it)))
      layer.forEach((it, k) => (it.cross = at[k]))
      return
    }
    for (let l = 0; l < lanes.length; l++) {
      const inLane = layer.filter((it) => it.lane === l)
      if (inLane.length === 0) continue
      const lo = laneStart[l] + LANE_PAD + crossOf(inLane[0].sized) / 2
      const hi = laneStart[l] + laneSize[l] - LANE_PAD - crossOf(inLane[inLane.length - 1].sized) / 2
      const at = packInOrder(inLane.map(wish), inLane.slice(1).map((it, k) => sepOf(inLane[k], it)), lo, hi)
      inLane.forEach((it, k) => (it.cross = at[k]))
    }
  }
  // First stacked, each lane's boxes at its middle; then pulled toward their neighbours, sweep by sweep.
  for (const layer of layers) {
    if (lanes.length === 0) {
      const at = packInOrder(layer.map(() => 0), layer.slice(1).map((it, k) => sepOf(layer[k], it)))
      layer.forEach((it, k) => (it.cross = at[k]))
    } else placeLayer(layer, (it) => laneStart[it.lane] + laneSize[it.lane] / 2)
  }
  const meanOf = (near: string[] | undefined, fallback: number) => (near && near.length > 0 ? near.reduce((n, id) => n + items.get(id)!.cross, 0) / near.length : fallback)
  for (let sweep = 0; sweep < PLACE_SWEEPS; sweep++) {
    const down = sweep % 2 === 0
    const rs = down ? [...Array(maxRank + 1).keys()].slice(1) : [...Array(maxRank).keys()].reverse()
    for (const r of rs) placeLayer(layers[r], (it) => meanOf((down ? predsOf : succsOf).get(it.id), it.cross))
  }
  // Last, each box between all its neighbours.
  for (const layer of layers) placeLayer(layer, (it) => meanOf([...(predsOf.get(it.id) ?? []), ...(succsOf.get(it.id) ?? [])], it.cross))

  // ---- Along the steps: each step as deep as its largest box, the gap wider where arrows carry words.
  const labelled = spec.edges.some((e) => e.label)
  const gap = (across ? GAP_ACROSS : GAP_DOWN) + (labelled ? EDGE_LABEL_ROOM : 0)
  const depth = layers.map((layer) => Math.max(0, ...layer.map((it) => (it.sized ? mainOf(it.sized) : 0))))
  const header = lanes.length > 0 ? laneHeaders(lanes.map((g) => g.label), measure) : null
  const mainStart: number[] = []
  let at = header ? header.width + 16 : 0
  for (let r = 0; r <= maxRank; r++) {
    mainStart[r] = at
    at += depth[r] + gap
  }
  const mainEnd = at - gap
  // A point: (main, cross) in the drawing, by direction.
  const pt = (main: number, cross: number): Point => (across ? { x: main, y: cross } : { x: cross, y: main })
  const centreOf = (it: Layer) => pt(mainStart[it.rank] + depth[it.rank] / 2, it.cross)

  const nodes: PlacedNode[] = sized.map((s) => {
    const c = centreOf(items.get(s.id)!)
    return place(s, c.x - s.w / 2, c.y - s.h / 2)
  })
  const box = new Map(nodes.map((n) => [n.id, n]))
  // Where an arrow leaves a box and enters one, along the work.
  const exit = (n: PlacedNode): Point => (across ? { x: n.x + n.w, y: n.y + n.h / 2 } : { x: n.x + n.w / 2, y: n.y + n.h })
  const entry = (n: PlacedNode): Point => (across ? { x: n.x, y: n.y + n.h / 2 } : { x: n.x + n.w / 2, y: n.y })

  // The ways back, the shortest nearest the boxes: each in its own channel under the boxes of the steps it spans (in the
  // lanes from its start to its end), out beside them down the page.
  const channels = new Map<Route, number>()
  const loops = routes.filter((r) => r.back).sort((a, b) => span(a) - span(b))
  function span(r: Route) {
    return Math.abs(items.get(r.edge.from)!.rank - items.get(r.edge.to)!.rank)
  }
  loops.forEach((r, k) => {
    const a = items.get(r.edge.from)!
    const b = items.get(r.edge.to)!
    const [lo, hi] = [Math.min(a.rank, b.rank), Math.max(a.rank, b.rank)]
    const [laneLo, laneHi] = [Math.min(a.lane, b.lane), Math.max(a.lane, b.lane)]
    const under = nodes.filter((n) => {
      const it = items.get(n.id)!
      return it.rank >= lo && it.rank <= hi && (lanes.length === 0 || (it.lane >= laneLo && it.lane <= laneHi))
    })
    const farthest = Math.max(...under.map((n) => (across ? n.y + n.h : n.x + n.w)))
    channels.set(r, farthest + LOOP_GAP + k * LOOP_STEP)
  })
  const edges: Drawn[] = routes.map((r) => {
    if (r.back) {
      const from = box.get(r.edge.from)!
      const to = box.get(r.edge.to)!
      const c = channels.get(r)!
      const [a, b] = across ? [bottom(from), bottom(to)] : [side(from), side(to)]
      const points = across ? [a, { x: a.x, y: c }, { x: b.x, y: c }, b] : [a, { x: c, y: a.y }, { x: c, y: b.y }, b]
      return { edge: r.edge, points, kind: 'loop' }
    }
    const first = box.get(r.chain[0])!
    const last = box.get(r.chain[r.chain.length - 1])!
    const middle = r.chain.slice(1, -1).map((id) => centreOf(items.get(id)!))
    return { edge: r.edge, points: [exit(first), ...middle, entry(last)], kind: across ? 'across' : 'down' }
  })

  const regions: Region[] = []
  if (header) {
    const width = Math.max(mainEnd + 16, header.width + 16 + 40)
    lanes.forEach((g, l) => {
      regions.push({
        id: g.id,
        kind: 'lane',
        x: 0,
        y: laneStart[l],
        w: width,
        h: laneSize[l],
        header: { x: 0, y: laneStart[l], w: header.width, h: laneSize[l], lines: header.lines[l] },
      })
    })
  }
  return finish({ nodes, edges, regions, strokes: [], tags: [], chevrons: [] }, spec.rtl, measure)
}

const bottom = (n: PlacedNode): Point => ({ x: n.x + n.w / 2, y: n.y + n.h })
const side = (n: PlacedNode): Point => ({ x: n.x + n.w, y: n.y + n.h / 2 })

/** A swimlane's lane names, wrapped in a header column as wide as the widest needs (at most LANE_HEADER_MAX). */
function laneHeaders(labels: readonly string[], measure: Measure): { width: number; lines: string[][] } {
  const lines = labels.map((l) => wrapText(l, LANE_HEADER_MAX - 16, GROUP_FONT, measure))
  const width = Math.ceil(Math.max(64, ...lines.map((ls) => widest(ls, GROUP_FONT, measure) + 16)))
  return { width, lines }
}

// ---- Tree -----------------------------------------------------------------------------------

function tree(spec: AiDiagramSpec, measure: Measure): DiagramLayout {
  const across = spec.direction === 'across'
  const sized = new Map(spec.nodes.map((n) => [n.id, sizeNode(n, 'step', measure)]))
  const children = new Map<string, string[]>(spec.nodes.map((n) => [n.id, []]))
  for (const n of spec.nodes) if (n.parent) children.get(n.parent)?.push(n.id)
  const root = spec.nodes.find((n) => !n.parent)?.id ?? spec.nodes[0].id
  const crossOf = (id: string) => (across ? sized.get(id)!.h : sized.get(id)!.w)
  const mainOf = (id: string) => (across ? sized.get(id)!.w : sized.get(id)!.h)

  // Each level as deep as its largest box.
  const level = new Map<string, number>()
  const walk = (id: string, l: number) => {
    level.set(id, l)
    for (const c of children.get(id)!) walk(c, l + 1)
  }
  walk(root, 0)
  const levels = Math.max(...level.values()) + 1
  const depth = Array.from({ length: levels }, (_, l) => Math.max(0, ...[...level].filter(([, x]) => x === l).map(([id]) => mainOf(id))))
  const gap = across ? GAP_ACROSS : GAP_DOWN
  const mainStart = depth.map((_, l) => depth.slice(0, l).reduce((n, d) => n + d + gap, 0))

  // Each subtree in its own span across, side by side; a parent centred over its children.
  const centre = new Map<string, number>()
  const spans = new Map<string, number>()
  const kidsSpanOf = (kids: readonly string[]) => kids.reduce((n, k) => n + spans.get(k)!, 0) + TREE_GAP * (kids.length - 1)
  const measureSpans = (id: string) => {
    const kids = children.get(id)!
    for (const k of kids) measureSpans(k)
    spans.set(id, kids.length === 0 ? crossOf(id) : Math.max(crossOf(id), kidsSpanOf(kids)))
  }
  measureSpans(root)
  const lay = (id: string, start: number) => {
    const kids = children.get(id)!
    const own = spans.get(id)!
    if (kids.length === 0) {
      centre.set(id, start + own / 2)
      return
    }
    let at = start + (own - kidsSpanOf(kids)) / 2
    for (const k of kids) {
      lay(k, at)
      at += spans.get(k)! + TREE_GAP
    }
    centre.set(id, (centre.get(kids[0])! + centre.get(kids[kids.length - 1])!) / 2)
  }
  lay(root, 0)

  const nodes: PlacedNode[] = spec.nodes.map((n) => {
    const s = sized.get(n.id)!
    const l = level.get(n.id) ?? 0
    const main = mainStart[l] + depth[l] / 2
    const cross = centre.get(n.id) ?? 0
    return across ? place(s, main - s.w / 2, cross - s.h / 2) : place(s, cross - s.w / 2, main - s.h / 2)
  })
  const box = new Map(nodes.map((n) => [n.id, n]))
  const edges: Drawn[] = spec.nodes.flatMap((n) => {
    if (!n.parent) return []
    const p = box.get(n.parent)!
    const c = box.get(n.id)!
    const from = across ? { x: p.x + p.w, y: p.y + p.h / 2 } : { x: p.x + p.w / 2, y: p.y + p.h }
    const to = across ? { x: c.x, y: c.y + c.h / 2 } : { x: c.x + c.w / 2, y: c.y }
    return [{ edge: { from: p.id, to: c.id }, points: [from, to], kind: across ? 'across' : 'down' } satisfies Drawn]
  })
  return finish({ nodes, edges, regions: [], strokes: [], tags: [], chevrons: [] }, spec.rtl, measure)
}

// ---- Fishbone -------------------------------------------------------------------------------

interface BoneRow {
  s: Sized
  sub: boolean
}

function fishbone(spec: AiDiagramSpec, measure: Measure): DiagramLayout {
  const effectNode = spec.nodes.find((n) => !n.group && !n.parent) ?? spec.nodes[0]
  const effect = sizeNode(effectNode, 'step', measure, CAUSE_MAX)
  // Each bone's rows: its causes in order, each followed by its sub-causes.
  const bones = spec.groups.map((g) => {
    const causes = spec.nodes.filter((n) => n.group === g.id && !n.parent)
    const rows: BoneRow[] = causes.flatMap((c) => [
      { s: sizeNode(c, 'step', measure, CAUSE_MAX), sub: false },
      ...spec.nodes.filter((n) => n.parent === c.id).map((n) => ({ s: sizeNode(n, 'step', measure, CAUSE_MAX - SUB_INDENT), sub: true })),
    ])
    const tagLines = wrapText(g.label, CAUSE_MAX, GROUP_FONT, measure)
    const tag = { lines: tagLines, w: Math.ceil(widest(tagLines, GROUP_FONT, measure) + 20), h: tagLines.length * GROUP_FONT.line + 10 }
    const rowsH = rows.reduce((n, r) => n + r.s.h, 0) + ROW_GAP * Math.max(0, rows.length - 1)
    const length = BONE_LABEL_GAP + Math.max(rowsH, 24) + SPINE_GAP
    return { id: g.id, rows, tag, length }
  })

  // The bones in pairs: one above the spine, one below, the first pair farthest from the head.
  interface Bone {
    top: boolean
    x: number
    length: number
    rows: { s: Sized; sub: boolean; cx: number; cy: number }[]
    tag: { lines: string[]; w: number; h: number }
  }
  const placed: Bone[] = []
  const nodes: PlacedNode[] = []
  const strokes: { kind: Stroke['kind']; points: Point[] }[] = []
  const tags: Tag[] = []
  // Where each bone's rows sit, relative to the foot of its tag (bx): returns its extent left and right.
  const shape = (b: (typeof bones)[number], top: boolean) => {
    let y = top ? -b.length + BONE_LABEL_GAP : SPINE_GAP
    const rows = b.rows.map((r) => {
      const cy = y + r.s.h / 2
      y += r.s.h + ROW_GAP
      // How far down the bone from its tag the row is, and where the bone is there.
      const t = top ? cy + b.length : b.length - cy
      const boneX = SLANT * t
      const right = boneX - TICK - (r.sub ? SUB_INDENT : 0)
      return { s: r.s, sub: r.sub, cx: right - r.s.w / 2, cy }
    })
    const left = Math.min(-b.tag.w / 2, ...rows.map((r) => r.cx - r.s.w / 2))
    const right = Math.max(b.tag.w / 2, SLANT * b.length)
    return { rows, left, right }
  }
  let x = 0
  for (let pair = 0; pair * 2 < bones.length; pair++) {
    const up = bones[pair * 2]
    const down = bones[pair * 2 + 1]
    const a = shape(up, true)
    const b = down ? shape(down, false) : null
    const left = Math.min(a.left, b?.left ?? Infinity)
    const right = Math.max(a.right, b?.right ?? -Infinity)
    const bx = x - left
    placed.push({ top: true, x: bx, length: up.length, rows: a.rows, tag: up.tag })
    if (down && b) placed.push({ top: false, x: bx, length: down.length, rows: b.rows, tag: down.tag })
    x = bx + right + SLOT_GAP
  }
  const spineEnd = x - SLOT_GAP + 18
  for (const b of placed) {
    const foot = b.top ? -b.length : b.length
    strokes.push({ kind: 'bone', points: [{ x: b.x, y: foot }, { x: b.x + SLANT * b.length, y: 0 }] })
    const tagY = b.top ? foot - b.tag.h : foot
    tags.push({ x: b.x - b.tag.w / 2, y: tagY, w: b.tag.w, h: b.tag.h, lines: b.tag.lines })
    let cause: PlacedNode | null = null
    for (const r of b.rows) {
      // Its rows were set out from the bone's foot: moved along with the bone.
      const n = place(r.s, b.x + r.cx - r.s.w / 2, r.cy - r.s.h / 2)
      nodes.push(n)
      if (!r.sub) {
        cause = n
        // From the box to the bone, level.
        const t = b.top ? r.cy + b.length : b.length - r.cy
        strokes.push({ kind: 'tick', points: [{ x: n.x + n.w, y: r.cy }, { x: b.x + SLANT * t, y: r.cy }] })
      } else if (cause) {
        // Down from its cause, then across to it.
        const stem = cause.x + cause.w - SUB_INDENT / 2
        strokes.push({ kind: 'tick', points: [{ x: stem, y: cause.y + cause.h }, { x: stem, y: r.cy }, { x: n.x + n.w, y: r.cy }] })
      }
    }
  }
  const head = place(effect, spineEnd, -effect.h / 2, true)
  nodes.push(head)
  strokes.unshift({ kind: 'spine', points: [{ x: Math.min(0, ...placed.map((b) => b.x)) - 12, y: 0 }, { x: spineEnd, y: 0 }] })
  return finish({ nodes, edges: [], regions: [], strokes, tags, chevrons: [] }, spec.rtl, measure)
}

// ---- Columns -------------------------------------------------------------------------------

function columns(spec: AiDiagramSpec, measure: Measure): DiagramLayout {
  const cols = spec.groups.map((g) => {
    const boxes = spec.nodes.filter((n) => n.group === g.id).map((n) => sizeNode(n, 'step', measure, COLUMN_MAX - 2 * PAD_X))
    const lines = wrapText(g.label, COLUMN_MAX - 16, GROUP_FONT, measure)
    const width = Math.ceil(Math.max(MIN_W + 16, widest(lines, GROUP_FONT, measure) + 24, ...boxes.map((b) => b.w + 16)))
    return { g, boxes, lines, width }
  })
  const headerH = Math.max(...cols.map((c) => c.lines.length)) * GROUP_FONT.line + 14
  const nodes: PlacedNode[] = []
  const regions: Region[] = []
  const chevrons: Point[][] = []
  let x = 0
  let height = headerH
  for (const [k, c] of cols.entries()) {
    let y = headerH + 10
    for (const b of c.boxes) {
      // Every box the column's width: the column reads as one list.
      const wide = { ...b, w: c.width - 16 }
      nodes.push(place(wide, x + 8, y))
      y += b.h + 8
    }
    height = Math.max(height, y + 2)
    regions.push({ id: c.g.id, kind: 'column', x, y: 0, w: c.width, h: 0, header: { x, y: 0, w: c.width, h: headerH, lines: c.lines } })
    if (k < cols.length - 1) {
      const cx = x + c.width + COLUMN_GAP / 2
      chevrons.push([
        { x: cx - 5, y: headerH / 2 - 7 },
        { x: cx + 4, y: headerH / 2 },
        { x: cx - 5, y: headerH / 2 + 7 },
      ])
    }
    x += c.width + COLUMN_GAP
  }
  for (const r of regions) r.h = height
  return finish({ nodes, edges: [], regions, strokes: [], tags: [], chevrons }, spec.rtl, measure)
}

// ---- Finishing: margins, the mirror, the paths ---------------------------------------------------

/** An arrow before it is finished: its points, and how its path bends. */
interface Drawn {
  edge: AiDiagramEdge
  points: Point[]
  /** across, down: smooth along the work; loop: square, through the channel of its two middle points (a way back). */
  kind: 'across' | 'down' | 'loop'
}

interface Draft {
  nodes: PlacedNode[]
  edges: Drawn[]
  regions: Region[]
  strokes: { kind: Stroke['kind']; points: Point[] }[]
  tags: Tag[]
  chevrons: Point[][]
}

const r1 = (v: number) => Math.round(v * 10) / 10

/** A smooth path through points, level (or upright) at each of them: arrows leave and enter boxes square. */
function smooth(points: readonly Point[], across: boolean): string {
  let d = `M${r1(points[0].x)},${r1(points[0].y)}`
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const c1 = across ? { x: a.x + (b.x - a.x) / 2, y: a.y } : { x: a.x, y: a.y + (b.y - a.y) / 2 }
    const c2 = across ? { x: b.x - (b.x - a.x) / 2, y: b.y } : { x: b.x, y: b.y - (b.y - a.y) / 2 }
    d += ` C${r1(c1.x)},${r1(c1.y)} ${r1(c2.x)},${r1(c2.y)} ${r1(b.x)},${r1(b.y)}`
  }
  return d
}

/** A loop's channel: this far past the boxes it passes, and the next loop this much farther; the radius of its corners. */
const LOOP_GAP = 12
const LOOP_STEP = 10
const LOOP_RADIUS = 8

/** A path through points by straight stretches, its corners rounded. */
function rounded(points: readonly Point[]): string {
  let d = `M${r1(points[0].x)},${r1(points[0].y)}`
  for (let i = 1; i < points.length - 1; i++) {
    const [a, b, c] = [points[i - 1], points[i], points[i + 1]]
    const before = Math.hypot(b.x - a.x, b.y - a.y)
    const after = Math.hypot(c.x - b.x, c.y - b.y)
    const r = Math.min(LOOP_RADIUS, before / 2, after / 2)
    if (r <= 0) continue
    const p = { x: b.x - ((b.x - a.x) / before) * r, y: b.y - ((b.y - a.y) / before) * r }
    const q = { x: b.x + ((c.x - b.x) / after) * r, y: b.y + ((c.y - b.y) / after) * r }
    d += ` L${r1(p.x)},${r1(p.y)} Q${r1(b.x)},${r1(b.y)} ${r1(q.x)},${r1(q.y)}`
  }
  const last = points[points.length - 1]
  return `${d} L${r1(last.x)},${r1(last.y)}`
}

const polyline = (points: readonly Point[]) => points.map((p, i) => `${i === 0 ? 'M' : 'L'}${r1(p.x)},${r1(p.y)}`).join(' ')

/** Where an arrow's words go: halfway along its first stretch (by the box it leaves: a decision's answers sit by it); a loop's halfway along its channel. */
function labelPoint(e: Drawn): Point {
  const [a, b] = e.kind === 'loop' ? [e.points[1], e.points[2]] : e.points
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

/**
 * The drawing, finished: arrows' words placed, everything moved inside a
 * margin from the top left, mirrored when it reads right to left, and the
 * paths written.
 */
function finish(draft: Draft, rtl: boolean, measure: Measure): DiagramLayout {
  const labels = draft.edges.map((e) => {
    if (!e.edge.label) return null
    const lines = wrapText(e.edge.label, 110, EDGE_FONT, measure)
    const w = Math.ceil(widest(lines, EDGE_FONT, measure) + 8)
    const h = lines.length * EDGE_FONT.line + 4
    const c = labelPoint(e)
    return { lines, x: c.x - w / 2, y: c.y - h / 2, w, h }
  })
  // The bounds of everything drawn.
  const xs: number[] = []
  const ys: number[] = []
  const take = (x: number, y: number) => {
    xs.push(x)
    ys.push(y)
  }
  const takeBox = (b: { x: number; y: number; w: number; h: number }) => {
    take(b.x, b.y)
    take(b.x + b.w, b.y + b.h)
  }
  draft.nodes.forEach(takeBox)
  draft.regions.forEach(takeBox)
  draft.tags.forEach(takeBox)
  for (const s of draft.strokes) for (const p of s.points) take(p.x, p.y)
  for (const e of draft.edges) for (const p of e.points) take(p.x, p.y)
  for (const l of labels) if (l) takeBox(l)
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  const width = Math.ceil(Math.max(...xs) - minX + 2 * MARGIN)
  const height = Math.ceil(Math.max(...ys) - minY + 2 * MARGIN)
  // Moved into the margin, and mirrored for a right-to-left diagram.
  const mx = (x: number) => (rtl ? width - (x - minX + MARGIN) : x - minX + MARGIN)
  const my = (y: number) => y - minY + MARGIN
  const mp = (p: Point): Point => ({ x: mx(p.x), y: my(p.y) })
  const rect = <T extends { x: number; y: number; w: number }>(r: T): T => ({ ...r, x: rtl ? mx(r.x) - r.w : mx(r.x), y: my(r.y) })

  const nodes = draft.nodes.map((n) => ({ ...rect(n), textTop: my(n.textTop) }))
  const regions = draft.regions.map((r) => ({ ...rect(r), header: rect(r.header) }))
  const tags = draft.tags.map(rect)
  const strokes: Stroke[] = draft.strokes.map((s) => ({ kind: s.kind, d: polyline(s.points.map(mp)) }))
  const edges: PlacedEdge[] = draft.edges.map((e, i) => {
    const points = e.points.map(mp)
    const d = e.kind === 'loop' ? rounded(points) : smooth(points, e.kind === 'across')
    const placed: PlacedEdge = { edge: e.edge, d }
    const l = labels[i]
    if (l) placed.label = rect(l)
    return placed
  })
  const chevrons = draft.chevrons.map((c) => polyline(c.map(mp)))
  return { width, height, regions, strokes, edges, nodes, tags, chevrons }
}

/** The diagram laid out, by its layout. */
export function layoutDiagram(spec: AiDiagramSpec, measure: Measure): DiagramLayout {
  switch (spec.layout) {
    case 'flow':
    case 'swimlane':
      return layered(spec, measure)
    case 'tree':
      return tree(spec, measure)
    case 'fishbone':
      return fishbone(spec, measure)
    case 'columns':
      return columns(spec, measure)
  }
}
