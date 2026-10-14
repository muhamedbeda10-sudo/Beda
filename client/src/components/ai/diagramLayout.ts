// ============================================================================
// §20 — where everything of a diagram the assistant drew goes (./AiDiagram
// draws it): a fishbone's bones and causes, a flowchart's nodes in layers
// with its edges, a mind map's tree. Pure functions of the diagram and of how
// wide a text is, so the layouts are tested without a browser. Texts wrap to
// a width of their own; a word too long for it is broken.
// ============================================================================

import type { FishboneBone, FishboneCause, FlowEdge, FlowNode, MindNode } from '@qc/shared/aiDiagram'

/** How wide a text is drawn, in px, at a font size, bold or not. */
export type Measure = (text: string, size: number, bold?: boolean) => number

/** A width read from the characters alone, where nothing can measure: generous, so texts reckoned apart are apart. */
export const estimateWidth: Measure = (text, size, bold = false) => text.length * size * (bold ? 0.6 : 0.56)

/** A text in lines no wider than `max`: by words, and a word wider than a line in pieces. */
export function wrapText(text: string, max: number, size: number, measure: Measure, bold = false): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const tried = line ? `${line} ${word}` : word
    if (measure(tried, size, bold) <= max) {
      line = tried
      continue
    }
    if (line) lines.push(line)
    line = ''
    let rest = word
    while (measure(rest, size, bold) > max && rest.length > 1) {
      let n = rest.length - 1
      while (n > 1 && measure(rest.slice(0, n), size, bold) > max) n--
      lines.push(rest.slice(0, n))
      rest = rest.slice(n)
    }
    line = rest
  }
  if (line) lines.push(line)
  return lines.length > 0 ? lines : ['']
}

/** The widest of some lines. */
const widest = (lines: readonly string[], size: number, measure: Measure, bold = false) => Math.max(0, ...lines.map((l) => measure(l, size, bold)))

/** A text's direction, by its first letter that has one: Arabic (and Hebrew) right to left. */
export function textDir(text: string): 'rtl' | 'ltr' {
  const m = /[A-Za-z\u00C0-\u024F\u05D0-\u05EA\u0620-\u064A\u066E-\u06D3\u06FA-\u06FF\uFB1D-\uFDFF\uFE70-\uFEFC]/.exec(text)
  return m && !/[A-Za-z\u00C0-\u024F]/.test(m[0]) ? 'rtl' : 'ltr'
}

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** The type a diagram is written in: its size, a line's height, and the smaller type of a figure. */
export const FONT = 12
export const LINE = 15
export const SMALL = 11
export const SMALL_LINE = 14
const MARGIN = 16

// ---- Fishbone -----------------------------------------------------------------------------

/** How far a bone leans: across, per unit down. */
const SLANT = 0.45
/** How wide a cause is written, at most. */
const CAUSE_WIDTH = 168
const CAUSE_GAP = 8
const LABEL_HEIGHT = 26
const HEAD_WIDTH = 150

export interface FishCause {
  cause: FishboneCause
  lines: string[]
  evidence: string[]
  /** Where its line meets the bone, and how far its line runs to the left of it. */
  x: number
  y: number
  width: number
  /** Its text's first baseline, and where its lines end on the right. */
  top: number
  textX: number
}

export interface FishBone {
  bone: FishboneBone
  side: 'top' | 'bottom'
  /** The bone, from its name to the spine. */
  from: { x: number; y: number }
  to: { x: number; y: number }
  label: Box
  causes: FishCause[]
}

export interface FishboneLayout {
  width: number
  height: number
  spineY: number
  spineFrom: number
  head: Box
  headLines: string[]
  bones: FishBone[]
}

export function layoutFishbone(problem: string, bones: readonly FishboneBone[], measure: Measure): FishboneLayout {
  type Sized = { bone: FishboneBone; side: 'top' | 'bottom'; column: number; causes: { cause: FishboneCause; lines: string[]; evidence: string[]; h: number; w: number }[]; label: number; reach: number }
  const sized: Sized[] = bones.map((bone, i) => {
    const causes = bone.causes.map((cause) => {
      const lines = wrapText(cause.text, CAUSE_WIDTH, FONT, measure)
      const evidence = cause.evidence ? wrapText(cause.evidence, CAUSE_WIDTH, SMALL, measure, true) : []
      const w = Math.max(widest(lines, FONT, measure), widest(evidence, SMALL, measure, true))
      return { cause, lines, evidence, h: lines.length * LINE + evidence.length * SMALL_LINE + CAUSE_GAP, w }
    })
    // How far the bone reaches from the spine: past its causes to its name.
    const reach = LABEL_HEIGHT + 10 + causes.reduce((t, c) => t + c.h, 0) + 14
    return { bone, side: i % 2 === 0 ? 'top' : 'bottom', column: Math.floor(i / 2), causes, label: measure(bone.category, FONT, true) + 20, reach }
  })
  const topReach = Math.max(LABEL_HEIGHT + 40, ...sized.filter((s) => s.side === 'top').map((s) => s.reach))
  const bottomReach = Math.max(LABEL_HEIGHT + 40, ...sized.filter((s) => s.side === 'bottom').map((s) => s.reach))
  const columns = Math.ceil(sized.length / 2)
  // Bones lean alike, so causes left of one bone keep clear of the bone before it by the columns' pitch.
  const pitch = CAUSE_WIDTH + 34
  // Where each column's bones meet the spine, before the drawing is moved to start at its margin.
  const spineX = (c: number) => c * pitch
  const spineY = topReach
  const bonesOut: FishBone[] = sized.map((s) => {
    const sign = s.side === 'top' ? -1 : 1
    const reach = s.side === 'top' ? topReach : bottomReach
    const tip = reach - LABEL_HEIGHT
    const at = spineX(s.column)
    const from = { x: at - SLANT * tip, y: spineY + sign * tip }
    const label: Box = { x: from.x - s.label / 2, y: s.side === 'top' ? spineY - reach : spineY + tip, w: s.label, h: LABEL_HEIGHT }
    // Causes run from the bone's name toward the spine: each a block of text, its line under it to the bone.
    let d = tip - 10
    const causes: FishCause[] = s.causes.map((c) => {
      const body = c.h - CAUSE_GAP
      const blockTop = s.side === 'top' ? spineY - d : spineY + d - body
      d -= c.h
      const y = blockTop + body + 4
      // The text ends clear of the bone where the bone leans furthest left beside it: at the block's far edge.
      const far = Math.max(Math.abs(blockTop - spineY), Math.abs(y - spineY))
      const textX = at - SLANT * far - 8
      const x = at - SLANT * Math.abs(y - spineY)
      return { cause: c.cause, lines: c.lines, evidence: c.evidence, x, y, textX, width: Math.max(x - textX + c.w + 4, 40), top: blockTop + FONT - 1 }
    })
    return { bone: s.bone, side: s.side, from, to: { x: at, y: spineY }, label, causes }
  })
  const headLines = wrapText(problem, HEAD_WIDTH - 20, FONT, measure, true)
  const headH = Math.max(44, headLines.length * LINE + 18)
  const lastAt = spineX(columns - 1)
  const head: Box = { x: lastAt + 40, y: spineY - headH / 2, w: HEAD_WIDTH, h: headH }
  // Move everything so its leftmost point sits at the margin.
  const left = Math.min(...bonesOut.flatMap((b) => [b.label.x, ...b.causes.map((c) => c.x - c.width), b.from.x]), 0)
  const dx = MARGIN - left
  for (const b of bonesOut) {
    b.from.x += dx
    b.to.x += dx
    b.label.x += dx
    for (const c of b.causes) {
      c.x += dx
      c.textX += dx
    }
  }
  head.x += dx
  const spineFrom = Math.min(...bonesOut.map((b) => b.to.x)) - 24
  return { width: head.x + head.w + MARGIN, height: spineY + bottomReach + MARGIN, spineY, spineFrom, head, headLines, bones: bonesOut }
}

// ---- Flowchart ----------------------------------------------------------------------------

const NODE_TEXT = 150
const DECISION_TEXT = 112
const LAYER_GAP = 46
const NODE_GAP = 30

export interface FlowNodeLayout {
  node: FlowNode
  lines: string[]
  box: Box
  layer: number
}

export interface FlowEdgeLayout {
  edge: FlowEdge
  /** The path's points: a curve down for an edge forward, a detour on the right for one back. */
  path: string
  /** Where its name goes. */
  labelAt: { x: number; y: number } | null
  back: boolean
}

export interface FlowchartLayout {
  width: number
  height: number
  nodes: FlowNodeLayout[]
  edges: FlowEdgeLayout[]
}

/** Each node's size: a box (a pill for a start or an end) round its text, a diamond twice as roomy. */
function flowSize(node: FlowNode, measure: Measure): { lines: string[]; w: number; h: number } {
  if (node.shape === 'decision') {
    const lines = wrapText(node.label, DECISION_TEXT, FONT, measure)
    const tw = Math.max(widest(lines, FONT, measure), 40)
    return { lines, w: Math.round(tw * 1.5 + 40), h: Math.round(lines.length * LINE * 1.5 + 34) }
  }
  const lines = wrapText(node.label, NODE_TEXT, FONT, measure, node.shape !== 'step')
  const tw = Math.max(widest(lines, FONT, measure, node.shape !== 'step'), 48)
  return { lines, w: Math.round(tw + 28), h: lines.length * LINE + 18 }
}

/** The edges that close a loop, found by a walk from the starts: drawn back, and left out when the layers are set. */
function backEdges(nodes: readonly FlowNode[], edges: readonly FlowEdge[]): Set<number> {
  const out = new Map<string, number[]>()
  edges.forEach((e, i) => out.set(e.from, [...(out.get(e.from) ?? []), i]))
  const state = new Map<string, 'open' | 'done'>()
  const back = new Set<number>()
  const visit = (id: string) => {
    state.set(id, 'open')
    for (const i of out.get(id) ?? []) {
      const to = edges[i].to
      const s = state.get(to)
      if (s === 'open') back.add(i)
      else if (!s) visit(to)
    }
    state.set(id, 'done')
  }
  const entered = new Set(edges.map((e) => e.to))
  const starts = nodes.filter((n) => n.shape === 'start' || !entered.has(n.id))
  for (const n of [...starts, ...nodes]) if (!state.has(n.id)) visit(n.id)
  return back
}

export function layoutFlowchart(nodes: readonly FlowNode[], edges: readonly FlowEdge[], measure: Measure): FlowchartLayout {
  const index = new Map(nodes.map((n, i) => [n.id, i]))
  const back = backEdges(nodes, edges)
  const forward = edges.filter((_, i) => !back.has(i))
  // Layers: the longest way from a start.
  const layer = nodes.map(() => 0)
  for (let pass = 0; pass < nodes.length; pass++) {
    let moved = false
    for (const e of forward) {
      const a = index.get(e.from)!
      const b = index.get(e.to)!
      if (layer[b] < layer[a] + 1) {
        layer[b] = layer[a] + 1
        moved = true
      }
    }
    if (!moved) break
  }
  const layers: number[][] = []
  nodes.forEach((_, i) => (layers[layer[i]] ??= []).push(i))
  for (let k = 0; k < layers.length; k++) layers[k] ??= []
  // The order within each layer: by where the nodes before and after it stand, a few sweeps each way.
  const order = new Map<number, number>()
  const renumber = () => layers.forEach((l) => l.forEach((n, i) => order.set(n, i)))
  renumber()
  const preds = nodes.map((_, i) => forward.filter((e) => index.get(e.to) === i).map((e) => index.get(e.from)!))
  const succs = nodes.map((_, i) => forward.filter((e) => index.get(e.from) === i).map((e) => index.get(e.to)!))
  const mean = (xs: number[], fallback: number) => (xs.length > 0 ? xs.reduce((t, x) => t + (order.get(x) ?? 0), 0) / xs.length : fallback)
  for (let sweep = 0; sweep < 4; sweep++) {
    const down = sweep % 2 === 0
    const ks = down ? layers.map((_, k) => k).slice(1) : layers.map((_, k) => k).reverse().slice(1)
    for (const k of ks) {
      const by = layers[k].map((n) => ({ n, at: mean(down ? preds[n] : succs[n], order.get(n)!) }))
      by.sort((a, b) => a.at - b.at || a.n - b.n)
      layers[k] = by.map((b) => b.n)
      renumber()
    }
  }
  const sizes = nodes.map((n) => flowSize(n, measure))
  const boxes: Box[] = nodes.map(() => ({ x: 0, y: 0, w: 0, h: 0 }))
  let y = MARGIN
  layers.forEach((l, k) => {
    const h = Math.max(0, ...l.map((n) => sizes[n].h))
    // Each node as near as it can be to the middle of the nodes before it, apart from its neighbours.
    let right = -Infinity
    for (const n of l) {
      const before = preds[n].filter((p) => layer[p] < k)
      const wanted = before.length > 0 ? before.reduce((t, p) => t + boxes[p].x + boxes[p].w / 2, 0) / before.length : 0
      const x = Math.max(wanted - sizes[n].w / 2, right + NODE_GAP)
      boxes[n] = { x, y: y + (h - sizes[n].h) / 2, w: sizes[n].w, h: sizes[n].h }
      right = x + sizes[n].w
    }
    // A layer pushed off to the right comes back as one, around where it was wanted.
    if (l.length > 1) {
      const wanted = l.map((n) => {
        const before = preds[n].filter((p) => layer[p] < k)
        return before.length > 0 ? before.reduce((t, p) => t + boxes[p].x + boxes[p].w / 2, 0) / before.length : null
      })
      const known = wanted.filter((w): w is number => w !== null)
      if (known.length > 0) {
        const centre = (boxes[l[0]].x + boxes[l[l.length - 1]].x + boxes[l[l.length - 1]].w) / 2
        const target = known.reduce((t, w) => t + w, 0) / known.length
        const shift = target - centre
        for (const n of l) boxes[n].x += shift
      }
    }
    y += h + LAYER_GAP
  })
  const minX = Math.min(...boxes.map((b) => b.x))
  for (const b of boxes) b.x += MARGIN - minX
  let width = Math.max(...boxes.map((b) => b.x + b.w)) + MARGIN
  const height = y - LAYER_GAP + MARGIN

  // Forward edges leave a node's foot (a decision's side, for a node off to that side) and enter the next one's head.
  const outs = new Map<number, number[]>()
  edges.forEach((e, i) => {
    if (!back.has(i)) outs.set(index.get(e.from)!, [...(outs.get(index.get(e.from)!) ?? []), i])
  })
  let detour = Math.max(...boxes.map((b) => b.x + b.w)) + 18
  const laid: FlowEdgeLayout[] = edges.map((edge, i) => {
    const a = boxes[index.get(edge.from)!]
    const b = boxes[index.get(edge.to)!]
    if (back.has(i)) {
      const x = detour
      detour += 14
      const ay = a.y + a.h / 2
      const by = b.y + b.h / 2
      // Its name beside the way back up, clear of the nodes.
      width = Math.max(width, x + (edge.label ? 6 + measure(edge.label, SMALL, true) : 0) + MARGIN)
      return { edge, back: true, path: `M ${a.x + a.w} ${ay} H ${x} V ${by} H ${b.x + b.w + 2}`, labelAt: edge.label ? { x: x + 6, y: (ay + by) / 2 + 4 } : null }
    }
    const siblings = (outs.get(index.get(edge.from)!) ?? []).filter((j) => !back.has(j))
    const k = siblings.indexOf(i)
    const ac = a.x + a.w / 2
    const bc = b.x + b.w / 2
    const shape = nodes[index.get(edge.from)!].shape
    let sx = ac
    let sy = a.y + a.h
    if (shape === 'decision' && Math.abs(bc - ac) > a.w / 4) {
      sx = bc < ac ? a.x : a.x + a.w
      sy = a.y + a.h / 2
    } else if (siblings.length > 1) {
      sx = a.x + (a.w * (k + 1)) / (siblings.length + 1)
    }
    const ey = b.y - 2
    const side = sy === a.y + a.h / 2
    const path = side ? `M ${sx} ${sy} H ${bc} V ${ey}` : `M ${sx} ${sy} C ${sx} ${(sy + ey) / 2}, ${bc} ${(sy + ey) / 2}, ${bc} ${ey}`
    const labelAt = edge.label ? (side ? { x: (sx + bc) / 2, y: sy - 5 } : { x: sx + 4, y: sy + 13 }) : null
    return { edge, back: false, path, labelAt }
  })
  return { width, height, nodes: nodes.map((node, i) => ({ node, lines: sizes[i].lines, box: boxes[i], layer: layer[i] })), edges: laid }
}

// ---- Mind map -----------------------------------------------------------------------------

const MIND_TEXT = 150
const MIND_LEVEL_GAP = 44
const MIND_ROW_GAP = 10

export interface MindNodeLayout {
  label: string
  lines: string[]
  box: Box
  depth: number
  /** The branch it belongs to (the centre: -1): its colour. */
  branch: number
  parent: number | null
}

export interface MindMapLayout {
  width: number
  height: number
  nodes: MindNodeLayout[]
}

export function layoutMindMap(center: string, branches: readonly MindNode[], measure: Measure): MindMapLayout {
  type T = { label: string; lines: string[]; w: number; h: number; depth: number; branch: number; children: T[]; span: number }
  const size = (label: string, depth: number, branch: number, children: readonly MindNode[]): T => {
    const bold = depth <= 1
    const lines = wrapText(label, depth === 0 ? 130 : MIND_TEXT, depth === 0 ? FONT + 1 : FONT, measure, bold)
    const w = Math.round(widest(lines, depth === 0 ? FONT + 1 : FONT, measure, bold) + 22)
    const h = lines.length * LINE + 14
    const kids = children.map((c) => size(c.label, depth + 1, depth === 0 ? children.indexOf(c) : branch, c.children ?? []))
    const sum = kids.reduce((t, k) => t + k.span, 0) + Math.max(0, kids.length - 1) * MIND_ROW_GAP
    return { label, lines, w, h, depth, branch, children: kids, span: Math.max(h, sum) }
  }
  const root = size(center, 0, -1, branches)
  // Each level in a column of its own, as wide as its widest node.
  const widths: number[] = []
  const measureLevels = (t: T) => {
    widths[t.depth] = Math.max(widths[t.depth] ?? 0, t.w)
    t.children.forEach(measureLevels)
  }
  measureLevels(root)
  const xs: number[] = []
  widths.forEach((w, d) => (xs[d] = d === 0 ? MARGIN : xs[d - 1] + widths[d - 1] + MIND_LEVEL_GAP))
  const nodes: MindNodeLayout[] = []
  const place = (t: T, top: number, parent: number | null) => {
    const at = nodes.length
    nodes.push({ label: t.label, lines: t.lines, depth: t.depth, branch: t.branch, parent, box: { x: xs[t.depth], y: top + (t.span - t.h) / 2, w: t.w, h: t.h } })
    const sum = t.children.reduce((s, k) => s + k.span, 0) + Math.max(0, t.children.length - 1) * MIND_ROW_GAP
    let y = top + (t.span - sum) / 2
    for (const k of t.children) {
      place(k, y, at)
      y += k.span + MIND_ROW_GAP
    }
  }
  place(root, MARGIN, null)
  return { width: Math.max(...nodes.map((n) => n.box.x + n.box.w)) + MARGIN, height: root.span + MARGIN * 2, nodes }
}
