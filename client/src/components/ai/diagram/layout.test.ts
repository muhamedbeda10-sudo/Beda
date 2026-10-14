import { describe, expect, it } from 'vitest'
import type { AiDiagramNode, AiDiagramSpec } from '@qc/shared/aiDiagram'
import { backEdges, layoutDiagram, packInOrder, ranks, wrapText, LABEL_FONT, type DiagramLayout, type PlacedNode } from './layout'
import { estimateMeasure } from './measure'

const node = (id: string, label: string, more: Partial<AiDiagramNode> = {}): AiDiagramNode => ({ id, label, shape: 'step', tone: 'neutral', ...more })
const spec = (more: Partial<AiDiagramSpec>): AiDiagramSpec => ({ layout: 'flow', title: 'T', direction: 'across', rtl: false, groups: [], nodes: [], edges: [], sources: [], ...more })
const lay = (s: AiDiagramSpec) => layoutDiagram(s, estimateMeasure)
const byId = (l: DiagramLayout) => new Map(l.nodes.map((n) => [n.id, n]))
const overlap = (a: PlacedNode, b: PlacedNode) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

function expectNoOverlap(l: DiagramLayout) {
  for (let i = 0; i < l.nodes.length; i++) for (let j = i + 1; j < l.nodes.length; j++) expect(overlap(l.nodes[i], l.nodes[j]), `${l.nodes[i].id} over ${l.nodes[j].id}`).toBe(false)
}
function expectInside(l: DiagramLayout) {
  for (const n of l.nodes) {
    expect(n.x).toBeGreaterThanOrEqual(0)
    expect(n.y).toBeGreaterThanOrEqual(0)
    expect(n.x + n.w).toBeLessThanOrEqual(l.width)
    expect(n.y + n.h).toBeLessThanOrEqual(l.height)
  }
}

/** A process with a decision and a rework loop back to the check. */
const PROCESS = spec({
  nodes: [
    node('start', 'Coil loaded', { shape: 'terminal' }),
    node('form', 'Roll forming'),
    node('check', 'First-piece check', { shape: 'inspection' }),
    node('ok', 'Within tolerance?', { shape: 'decision' }),
    node('run', 'Run the order'),
    node('adjust', 'Adjust the rolls'),
    node('store', 'Finished stock', { shape: 'store' }),
  ],
  edges: [
    { from: 'start', to: 'form' },
    { from: 'form', to: 'check' },
    { from: 'check', to: 'ok' },
    { from: 'ok', to: 'run', label: 'Yes' },
    { from: 'ok', to: 'adjust', label: 'No' },
    { from: 'adjust', to: 'check', dashed: true },
    { from: 'run', to: 'store' },
  ],
})

describe('words', () => {
  it('breaks at spaces within the width, and inside a word too long for a line', () => {
    const measure = (t: string) => t.length * 10
    expect(wrapText('Roll forming line two', 100, LABEL_FONT, measure)).toEqual(['Roll', 'forming', 'line two'])
    expect(wrapText('ABCDEFGHIJKLMNO', 50, LABEL_FONT, measure)).toEqual(['ABCDE', 'FGHIJ', 'KLMNO'])
    expect(wrapText('', 50, LABEL_FONT, measure)).toEqual([''])
  })
})

describe('placing in order', () => {
  it('puts each item at its wish when the gaps allow, and as near as they allow when not', () => {
    expect(packInOrder([0, 100, 200], [50, 50])).toEqual([0, 100, 200])
    // Two wishing for the same place share it, the gap between them.
    expect(packInOrder([10, 10], [20])).toEqual([0, 20])
    // Within the room given.
    expect(packInOrder([0, 0, 0], [10, 10], 5, 100)).toEqual([5, 15, 25])
    expect(packInOrder([90, 90], [10], -Infinity, 80)).toEqual([70, 80])
  })
})

describe('ranking a flow', () => {
  it('turns round only the arrows that run back, and ranks each box after those that enter it', () => {
    const ids = PROCESS.nodes.map((n) => n.id)
    const back = backEdges(ids, PROCESS.edges)
    expect([...back]).toEqual([5])
    const forward = PROCESS.edges.map((e, i) => (back.has(i) ? { from: e.to, to: e.from } : e))
    expect(Object.fromEntries(ranks(ids, forward))).toEqual({ start: 0, form: 1, check: 2, ok: 3, run: 4, adjust: 4, store: 5 })
  })

  it('sets a side input just before the step it joins', () => {
    const r = ranks(['a', 'b', 'c', 'm'], [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'm', to: 'c' },
    ])
    expect(r.get('m')).toBe(1)
  })
})

describe('a flow', () => {
  it('lays the work out along the reading direction, no box over another, every arrow drawn', () => {
    const l = lay(PROCESS)
    expectNoOverlap(l)
    expectInside(l)
    const at = byId(l)
    // Each step to the right of the one before.
    expect(at.get('form')!.x).toBeGreaterThan(at.get('start')!.x + at.get('start')!.w)
    expect(at.get('run')!.x).toBeGreaterThan(at.get('ok')!.x + at.get('ok')!.w)
    expect(l.edges).toHaveLength(7)
    expect(l.edges.filter((e) => e.label).map((e) => e.label!.lines[0])).toEqual(['Yes', 'No'])
    for (const e of l.edges) {
      // The way back (rework) runs square under the boxes; the others smooth along the work.
      if (e.edge.from === 'adjust') expect(e.d).toMatch(/^M[\d.]+,[\d.]+( L[\d.]+,[\d.]+ Q[\d., ]+)+ L[\d.]+,[\d.]+$/)
      else expect(e.d).toMatch(/^M[\d.]+,[\d.]+( C[\d., -]+)+$/)
    }
    // Under every box of the steps it spans, from the check to the adjustment.
    const loop = l.edges.find((e) => e.edge.from === 'adjust')!
    const channel = Math.max(...[...loop.d.matchAll(/,([\d.]+)/g)].map((m) => Number(m[1])))
    for (const id of ['check', 'ok', 'run', 'adjust']) expect(channel).toBeGreaterThan(at.get(id)!.y + at.get(id)!.h)
  })

  it('starts on the right when it reads right to left: the drawing mirrored', () => {
    const ltr = lay(PROCESS)
    const rtl = lay({ ...PROCESS, rtl: true })
    const a = byId(ltr)
    const b = byId(rtl)
    for (const id of a.keys()) expect(b.get(id)!.x).toBeCloseTo(ltr.width - a.get(id)!.x - a.get(id)!.w, 5)
    expect(b.get('start')!.x).toBeGreaterThan(b.get('store')!.x)
  })

  it('runs down the page when asked', () => {
    const l = lay({ ...PROCESS, direction: 'down' })
    expectNoOverlap(l)
    const at = byId(l)
    expect(at.get('form')!.y).toBeGreaterThan(at.get('start')!.y + at.get('start')!.h)
    expect(l.height).toBeGreaterThan(l.width)
  })

  it('keeps a decision wide enough for its words inside the diamond', () => {
    const d = byId(lay(PROCESS)).get('ok')!
    const words = Math.max(...d.label.map((t) => estimateMeasure(t, LABEL_FONT.size, LABEL_FONT.weight)))
    // The diamond's middle band holds the words: at their height above and below the centre it is still as wide.
    expect(d.w * (1 - (d.label.length * LABEL_FONT.line) / d.h)).toBeGreaterThanOrEqual(words)
  })
})

describe('a swimlane', () => {
  it('keeps each box inside its lane, across the lanes in order', () => {
    const s = spec({
      layout: 'swimlane',
      groups: [
        { id: 'prod', label: 'Production' },
        { id: 'qc', label: 'Quality control' },
        { id: 'store', label: 'Warehouse' },
      ],
      nodes: [
        node('a', 'Produce the batch', { group: 'prod' }),
        node('b', 'Inspect the samples', { group: 'qc', shape: 'inspection' }),
        node('c', 'Pass?', { group: 'qc', shape: 'decision' }),
        node('d', 'Rework', { group: 'prod' }),
        node('e', 'Receive into stock', { group: 'store' }),
        node('f', 'Hold the batch', { group: 'qc' }),
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'c', to: 'e', label: 'Yes' },
        { from: 'c', to: 'f', label: 'No' },
        { from: 'f', to: 'd' },
        { from: 'd', to: 'b', dashed: true },
      ],
    })
    const l = lay(s)
    expectNoOverlap(l)
    expectInside(l)
    expect(l.regions.map((r) => r.id)).toEqual(['prod', 'qc', 'store'])
    const lane = new Map(l.regions.map((r) => [r.id, r]))
    for (const n of l.nodes) {
      const r = lane.get(n.node.group!)!
      expect(n.y).toBeGreaterThanOrEqual(r.y)
      expect(n.y + n.h).toBeLessThanOrEqual(r.y + r.h)
      // Clear of the lane's header.
      expect(n.x).toBeGreaterThanOrEqual(r.header.x + r.header.w)
    }
  })
})

describe('a tree', () => {
  it('sets each parent over its children, level under level', () => {
    const l = lay(
      spec({
        layout: 'tree',
        direction: 'down',
        nodes: [node('p', 'Twist in the profile'), node('w1', 'Strip enters off-centre', { parent: 'p' }), node('w2', 'Guide worn', { parent: 'w1', hypothesis: true }), node('w3', 'Entry table loose', { parent: 'w1' }), node('x', 'Coil camber', { parent: 'p' })],
      }),
    )
    expectNoOverlap(l)
    expectInside(l)
    const at = byId(l)
    const centre = (id: string) => at.get(id)!.x + at.get(id)!.w / 2
    expect(centre('w1')).toBeCloseTo((centre('w2') + centre('w3')) / 2, 5)
    expect(centre('p')).toBeCloseTo((centre('w1') + centre('x')) / 2, 5)
    expect(at.get('w2')!.y).toBeGreaterThan(at.get('w1')!.y + at.get('w1')!.h)
    expect(l.edges).toHaveLength(4)
  })
})

describe('a fishbone', () => {
  const FISH = spec({
    layout: 'fishbone',
    groups: ['Man', 'Machine', 'Material', 'Method', 'Measurement'].map((g) => ({ id: g.toLowerCase(), label: g })),
    nodes: [
      node('effect', 'Twist in the profile', { tone: 'bad' }),
      node('m1', 'Shift C', { group: 'man', figure: { text: '42 pcs', value: 42, source: 's' } }),
      node('k1', 'Machine 58', { group: 'machine', tone: 'bad' }),
      node('k2', 'Worn rolls', { parent: 'k1', group: 'machine', hypothesis: true }),
      node('k3', 'Straightener set too light', { parent: 'k1', group: 'machine', hypothesis: true }),
      node('t1', 'Coil thickness varies', { group: 'material' }),
      node('t2', 'Supplier B', { group: 'material' }),
      node('e1', 'No check of strip camber', { group: 'method' }),
    ],
  })

  it('puts the effect at the head, a tag at each bone, every cause clear of the others', () => {
    const l = lay(FISH)
    expectNoOverlap(l)
    expectInside(l)
    const head = l.nodes.find((n) => n.head)!
    expect(head.id).toBe('effect')
    for (const n of l.nodes) if (n !== head) expect(n.x + n.w).toBeLessThan(head.x)
    expect(l.tags.map((t) => t.lines.join(' '))).toEqual(['Man', 'Machine', 'Material', 'Method', 'Measurement'])
    // The spine, a bone each, a tick for each cause and a branch for each sub-cause.
    expect(l.strokes.filter((s) => s.kind === 'spine')).toHaveLength(1)
    expect(l.strokes.filter((s) => s.kind === 'bone')).toHaveLength(5)
    expect(l.strokes.filter((s) => s.kind === 'tick')).toHaveLength(7)
    // Bones alternate above and below the spine.
    const spineY = Number(/,([\d.]+)/.exec(l.strokes[0].d)![1])
    expect(l.tags[0].y + l.tags[0].h).toBeLessThan(spineY)
    expect(l.tags[1].y).toBeGreaterThan(spineY)
  })

  it('reads from the right, the head on the left, when it reads right to left', () => {
    const l = lay({ ...FISH, rtl: true })
    expectNoOverlap(l)
    const head = l.nodes.find((n) => n.head)!
    for (const n of l.nodes) if (n !== head) expect(n.x).toBeGreaterThan(head.x + head.w)
  })
})

describe('columns', () => {
  it('stacks each column\'s boxes in it, every box its width', () => {
    const l = lay(
      spec({
        layout: 'columns',
        groups: ['Suppliers', 'Inputs', 'Process', 'Outputs', 'Customers'].map((g) => ({ id: g, label: g })),
        nodes: [
          node('s1', 'Steel mill', { group: 'Suppliers' }),
          node('i1', 'Coils', { group: 'Inputs' }),
          node('i2', 'Powder paint', { group: 'Inputs' }),
          node('p1', 'Roll forming and painting', { group: 'Process' }),
          node('o1', 'Uprights and beams', { group: 'Outputs' }),
          node('c1', 'Warehouses', { group: 'Customers' }),
        ],
      }),
    )
    expectNoOverlap(l)
    expectInside(l)
    const column = new Map(l.regions.map((r) => [r.id, r]))
    for (const n of l.nodes) {
      const c = column.get(n.node.group!)!
      expect(n.x).toBeGreaterThan(c.x)
      expect(n.x + n.w).toBeLessThan(c.x + c.w)
      expect(n.y).toBeGreaterThanOrEqual(c.header.y + c.header.h)
    }
    expect(l.chevrons).toHaveLength(4)
    const [a, b] = l.nodes.filter((n) => n.node.group === 'Inputs')
    expect(b.y).toBeGreaterThan(a.y + a.h)
  })
})
