// ============================================================================
// §20 — diagrams the assistant draws in an answer, for the analysis of a
// problem rather than for figures: a fishbone (Ishikawa) of its causes, a
// 5 Whys chain down to its root cause, a flowchart of a process, a mind map.
// The model writes the diagram itself (draw_diagram); the server checks it
// against the limits below and keeps it with the answer, and the answer shows
// it as a card of its own (and prints it). Unlike a chart it runs no query of
// its own: it holds what the model concluded, so it is never part of a saved
// or scheduled report, whose sections run again on new data.
//
// A fishbone holds only what the record shows: every cause carries its
// evidence, a figure a query of the conversation returned, and the server
// finds that figure in the queries' results before it draws anything (the
// queries it came from are kept with the cause). A cause the model cannot
// show from the data is left off the diagram. A 5 Whys step's evidence, when
// it gives one, is checked the same way.
// ============================================================================

export type AiDiagramKind = 'fishbone' | 'five-whys' | 'flowchart' | 'mind-map'
export const AI_DIAGRAM_KINDS: readonly AiDiagramKind[] = ['fishbone', 'five-whys', 'flowchart', 'mind-map']

/** What each kind is called on its card. */
export const AI_DIAGRAM_NAMES: Readonly<Record<AiDiagramKind, string>> = {
  fishbone: 'Fishbone diagram',
  'five-whys': '5 Whys',
  flowchart: 'Flowchart',
  'mind-map': 'Mind map',
}

/** How long each text of a diagram may be, and how many of each thing it holds. */
export const AI_DIAGRAM_LIMITS = {
  title: 120,
  notes: 300,
  fishbone: { problem: 100, category: 30, cause: 80, evidence: 60, minBones: 2, maxBones: 8, maxCauses: 6 },
  fiveWhys: { problem: 160, step: 160, evidence: 80, maxSteps: 7, action: 160, maxActions: 6 },
  flowchart: { id: 24, label: 60, edgeLabel: 24, minNodes: 2, maxNodes: 24, maxEdges: 40 },
  mindMap: { center: 60, label: 60, maxBranches: 8, maxChildren: 6, maxDepth: 3, maxNodes: 60 },
} as const

/** The 6M a fishbone's bones are usually named after, in this order. */
export const FISHBONE_CATEGORIES = ['Man', 'Machine', 'Method', 'Material', 'Measurement', 'Environment'] as const

export interface FishboneCause {
  text: string
  /** The figure that shows it, as a query gave it ("4.1% rejects vs 1.2% avg"). */
  evidence: string
  /** The queries its figures were found in, by their purpose: set by the server, never by the model. */
  sources: string[]
}

export interface FishboneBone {
  category: string
  causes: FishboneCause[]
}

export interface FishboneDiagram {
  kind: 'fishbone'
  /** The head: the problem whose causes the bones hold. */
  problem: string
  bones: FishboneBone[]
}

export interface FiveWhysStep {
  /** The answer to "Why?" at this step: the cause of the step before it. */
  because: string
  evidence?: string
  /** The queries the evidence's figures were found in, when it gives one. */
  sources?: string[]
}

export interface FiveWhysDiagram {
  kind: 'five-whys'
  problem: string
  /** In order; the last is the root cause. */
  steps: FiveWhysStep[]
  /** What is to be done about the root cause. */
  actions: string[]
}

/** A start or an end (a pill), a step (a box), or a decision (a diamond, its edges named for its answers). */
export type FlowNodeShape = 'start' | 'end' | 'step' | 'decision'
export const FLOW_NODE_SHAPES: readonly FlowNodeShape[] = ['start', 'end', 'step', 'decision']

export interface FlowNode {
  id: string
  label: string
  shape: FlowNodeShape
  /** Marked out: where the problem arises, or the step that changes. */
  highlight?: boolean
}

export interface FlowEdge {
  from: string
  to: string
  /** A decision's answer ("Yes", "No", "Fail"). */
  label?: string
}

export interface FlowchartDiagram {
  kind: 'flowchart'
  nodes: FlowNode[]
  edges: FlowEdge[]
}

export interface MindNode {
  label: string
  children?: MindNode[]
}

export interface MindMapDiagram {
  kind: 'mind-map'
  center: string
  branches: MindNode[]
}

export type AiDiagramBody = FishboneDiagram | FiveWhysDiagram | FlowchartDiagram | MindMapDiagram

/** A diagram as it was checked and kept: its body, a title, and a line of notes under it (what the data covers). */
export type AiDiagram = AiDiagramBody & { title: string; notes?: string }

/** A diagram as a card of its answer. */
export interface AiDiagramPart {
  type: 'diagram'
  diagramId: string
  diagram: AiDiagram
}

/** The nodes of a mind map, all of them, its centre aside. */
export function mindMapSize(branches: readonly MindNode[]): number {
  return branches.reduce((n, b) => n + 1 + mindMapSize(b.children ?? []), 0)
}
