import { describe, expect, it } from 'vitest'
import { FONT, LINE, estimateWidth, layoutFishbone, layoutFlowchart, layoutMindMap, textDir, wrapText, type Box } from './diagramLayout'

const overlap = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

describe('the layout of a diagram', () => {
  it('wraps a text by words to its width, breaking a word too long for a line', () => {
    expect(wrapText('Night shift: most of the defects', 100, FONT, estimateWidth)).toEqual(['Night shift:', 'most of the', 'defects'])
    expect(wrapText('ABCDEFGHIJKLMNOPQRSTUVWXYZ', 60, FONT, estimateWidth)).toEqual(['ABCDEFGH', 'IJKLMNOP', 'QRSTUVWX', 'YZ'])
    expect(wrapText('', 60, FONT, estimateWidth)).toEqual([''])
    expect(textDir('رسم DWG2')).toBe('rtl')
    expect(textDir('DWG2 رسم')).toBe('ltr')
    expect(textDir('03 ٪')).toBe('ltr')
  })

  it('keeps every fishbone cause left of its own bone and clear of the bone before it, top and bottom', () => {
    const cause = (t: string) => ({ text: t, evidence: '4.1% vs 1.2% avg', sources: ['Q'] })
    const bones = ['Man', 'Machine', 'Method', 'Material', 'Measurement'].map((category, i) => ({
      category,
      causes: Array.from({ length: i + 1 }, (_, j) => cause(`A long cause number ${j + 1} that wraps over two lines at least`)),
    }))
    const l = layoutFishbone('Wavy edge on RF-03', bones, estimateWidth)
    const boneX = (b: (typeof l.bones)[number], y: number) => b.to.x - ((b.to.x - b.from.x) * Math.abs(y - l.spineY)) / Math.abs(b.from.y - l.spineY)
    for (const [i, b] of l.bones.entries()) {
      expect(b.side).toBe(i % 2 === 0 ? 'top' : 'bottom')
      for (const c of b.causes) {
        const lines = c.lines.length + c.evidence.length
        // Its text, from its first line's top to its last line, ends left of its bone at every height.
        for (let k = 0; k < lines; k++) {
          const y = c.top - FONT + k * LINE
          expect(c.textX).toBeLessThan(boneX(b, y))
          expect(c.textX).toBeLessThan(boneX(b, y + LINE))
        }
        // The bone before it on the same side is left of where its text starts.
        const before = l.bones[i - 2]
        if (before) expect(boneX(before, c.y)).toBeLessThan(c.textX - 120)
        expect(c.x - c.width).toBeGreaterThanOrEqual(0)
      }
    }
    // The head sits on the spine, right of every bone.
    expect(l.head.y + l.head.h / 2).toBe(l.spineY)
    expect(Math.max(...l.bones.map((b) => b.to.x))).toBeLessThan(l.head.x)
    expect(l.width).toBe(l.head.x + l.head.w + 16)
  })

  it('lays a flowchart out in layers from its start, a loop drawn back, no two nodes over each other', () => {
    const nodes = [
      { id: 's', label: 'Sample taken', shape: 'start' as const },
      { id: 'm', label: 'Measure every dimension', shape: 'step' as const },
      { id: 'd', label: 'All inside tolerance?', shape: 'decision' as const },
      { id: 'h', label: 'Hold', shape: 'step' as const },
      { id: 'a', label: 'Adjust the machine', shape: 'step' as const },
      { id: 'e', label: 'Saved', shape: 'end' as const },
    ]
    const edges = [
      { from: 's', to: 'm' },
      { from: 'm', to: 'd' },
      { from: 'd', to: 'e', label: 'Yes' },
      { from: 'd', to: 'h', label: 'No' },
      { from: 'h', to: 'a' },
      { from: 'a', to: 'm', label: 'Re-measure' },
    ]
    const l = layoutFlowchart(nodes, edges, estimateWidth)
    expect(l.nodes.map((n) => [n.node.id, n.layer])).toEqual([
      ['s', 0],
      ['m', 1],
      ['d', 2],
      ['h', 3],
      ['a', 4],
      ['e', 3],
    ])
    expect(l.edges.map((e) => e.back)).toEqual([false, false, false, false, false, true])
    for (const a of l.nodes) for (const b of l.nodes) if (a !== b) expect(overlap(a.box, b.box)).toBe(false)
    // The way back runs right of every node, its name inside the drawing.
    const back = l.edges[5]
    expect(back.labelAt!.x).toBeGreaterThan(Math.max(...l.nodes.map((n) => n.box.x + n.box.w)))
    expect(back.labelAt!.x + estimateWidth('Re-measure', 11, true)).toBeLessThanOrEqual(l.width)
    expect(Math.min(...l.nodes.map((n) => n.box.x))).toBe(16)
  })

  it('draws a mind map from its centre outwards, each parent level with the middle of its children', () => {
    const l = layoutMindMap('Line audit', [{ label: 'Machine', children: [{ label: 'Rolls' }, { label: 'Straightener' }, { label: 'Press' }] }, { label: 'People' }], estimateWidth)
    expect(l.nodes.map((n) => [n.label, n.depth, n.branch, n.parent])).toEqual([
      ['Line audit', 0, -1, null],
      ['Machine', 1, 0, 0],
      ['Rolls', 2, 0, 1],
      ['Straightener', 2, 0, 1],
      ['Press', 2, 0, 1],
      ['People', 1, 1, 0],
    ])
    const mid = (b: Box) => b.y + b.h / 2
    const [, machine, rolls, , press] = l.nodes
    expect(mid(machine.box)).toBeCloseTo((mid(rolls.box) + mid(press.box)) / 2)
    for (const a of l.nodes) for (const b of l.nodes) if (a !== b) expect(overlap(a.box, b.box)).toBe(false)
    expect(rolls.box.x).toBeGreaterThan(machine.box.x + machine.box.w)
  })
})
