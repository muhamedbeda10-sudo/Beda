// ============================================================================
// §20 — diagrams the assistant draws in an answer: a process map, a
// flowchart, a swimlane across the departments, a tree (5 whys, a fault tree,
// a mind map), a fishbone (Ishikawa) of the causes of a problem, or columns
// side by side (SIPOC, before and after). The model says what is in it —
// boxes, arrows, groups — and the app lays it out and draws it: the model
// never places anything, so every diagram reads the same way, in both themes
// and both directions.
//
// A figure on a box (a count, a share, hours) is never the model's own words:
// it names a row of a read-only query over the ai.* views that the server
// runs, as the person's domains read, and the server writes the figure in. A
// box the data does not show is marked a hypothesis and drawn dashed; a
// fishbone takes none: every cause on it carries its figure from the data.
//
// What passes is kept with the answer (ai_diagrams) and shown as a card in
// its place, live and in the history alike.
// ============================================================================

/**
 * How a diagram is laid out:
 *   • flow — boxes in the order the arrows run: a process map, a flowchart, a decision tree, a value stream;
 *   • swimlane — the same, each box in the lane of who does it (a department, a role, a machine);
 *   • tree — each box under its parent: 5 whys, a fault tree, a mind map, a breakdown;
 *   • fishbone — one effect at the head, its causes on the bones of their category (the 6M);
 *   • columns — boxes in columns side by side: SIPOC, before and after, options compared.
 */
export type AiDiagramLayout = 'flow' | 'swimlane' | 'tree' | 'fishbone' | 'columns'
export const AI_DIAGRAM_LAYOUTS: readonly AiDiagramLayout[] = ['flow', 'swimlane', 'tree', 'fishbone', 'columns']

/** Which way a flow or a tree runs: along the reading direction, or down the page. Fixed for the other layouts. */
export type AiDiagramDirection = 'across' | 'down'
export const AI_DIAGRAM_DIRECTIONS: readonly AiDiagramDirection[] = ['across', 'down']

/**
 * A box's shape, in a flow or a swimlane (the other layouts draw every box alike): a step of the work, a decision
 * (its arrows labelled with the answers), a start or an end, an inspection point, a store or a wait, a document or
 * a record, a note beside the flow.
 */
export type AiDiagramShape = 'step' | 'decision' | 'terminal' | 'inspection' | 'store' | 'document' | 'note'
export const AI_DIAGRAM_SHAPES: readonly AiDiagramShape[] = ['step', 'decision', 'terminal', 'inspection', 'store', 'document', 'note']

/** A box's colour, by what it means: plain, picked out, good, a warning, a problem. */
export type AiDiagramTone = 'neutral' | 'accent' | 'good' | 'warning' | 'bad'
export const AI_DIAGRAM_TONES: readonly AiDiagramTone[] = ['neutral', 'accent', 'good', 'warning', 'bad']

/** Boxes, arrows and groups a diagram holds at most: past them it is no longer read at a glance. */
export const AI_DIAGRAM_MAX_NODES = 60
export const AI_DIAGRAM_MAX_EDGES = 120
/** Lanes, bones or columns, at least and at most. */
export const AI_DIAGRAM_MIN_GROUPS = 2
export const AI_DIAGRAM_MAX_GROUPS = 8
/** How deep a tree goes, the effect counted. */
export const AI_DIAGRAM_MAX_DEPTH = 8
/** Queries a diagram's figures come from, at most; rows each may return. */
export const AI_DIAGRAM_MAX_SOURCES = 4
export const AI_DIAGRAM_SOURCE_MAX_ROWS = 500
/** Words, in characters, at most. */
export const AI_DIAGRAM_TITLE_MAX = 100
export const AI_DIAGRAM_LABEL_MAX = 80
export const AI_DIAGRAM_DETAIL_MAX = 160
export const AI_DIAGRAM_EDGE_LABEL_MAX = 40
export const AI_DIAGRAM_GROUP_LABEL_MAX = 40
export const AI_DIAGRAM_ID_MAX = 40
export const AI_DIAGRAM_UNIT_MAX = 8
export const AI_DIAGRAM_MAX_DECIMALS = 3
export const AI_DIAGRAM_LINK_MAX = 300

/** A figure on a box, as the server wrote it from its query: its text as drawn, its value, and the query it came from. */
export interface AiDiagramFigure {
  text: string
  value: number
  /** The source's id (AiDiagramSource.id). */
  source: string
}

export interface AiDiagramNode {
  id: string
  label: string
  /** A second, smaller line: where, what to check, the detail the label leaves out. */
  detail?: string
  shape: AiDiagramShape
  tone: AiDiagramTone
  /** Its lane, bone or column (AiDiagramGroup.id). */
  group?: string
  /** Its parent box, in a tree or a fishbone (a sub-cause's cause). */
  parent?: string
  /** Not shown by the data: a cause or a step put forward to be checked. Drawn dashed. */
  hypothesis?: true
  figure?: AiDiagramFigure
  /** A page of this application the box opens (a session in History). */
  link?: string
}

export interface AiDiagramEdge {
  from: string
  to: string
  label?: string
  /** A path taken now and then (rework, a return), drawn dashed. */
  dashed?: true
}

export interface AiDiagramGroup {
  id: string
  label: string
}

/** A query the figures came from, as the card's workings show it. */
export interface AiDiagramSource {
  id: string
  purpose: string
  sql: string
  rows: number
  ms: number
}

/** A diagram as it was checked and kept: laid out and drawn by the app from this alone. */
export interface AiDiagramSpec {
  layout: AiDiagramLayout
  title: string
  /** flow and tree only; the other layouts have their own. */
  direction: AiDiagramDirection
  /** Its words read right to left (an Arabic diagram): it is drawn mirrored, from the right. */
  rtl: boolean
  groups: AiDiagramGroup[]
  nodes: AiDiagramNode[]
  edges: AiDiagramEdge[]
  sources: AiDiagramSource[]
}

/** A diagram as a card in its answer. */
export interface AiDiagramPart {
  type: 'diagram'
  diagramId: string
  spec: AiDiagramSpec
}

/** Letters that read right to left (Hebrew, Arabic and their forms) and left to right (Latin, Greek, Cyrillic). */
const RTL_LETTER = /[֐-׿؀-ٟ٭-ۯۺ-ࣿיִ-﷿ﹰ-ﻼ]/
const LTR_LETTER = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/

/**
 * Whether a diagram reads right to left: when most of the letters of its title, groups and boxes do. Codes and
 * figures in an Arabic diagram (machine codes, order numbers) are few beside its words.
 */
export function diagramReadsRightToLeft(texts: readonly string[]): boolean {
  let rtl = 0
  let ltr = 0
  for (const text of texts) {
    for (const ch of text) {
      if (RTL_LETTER.test(ch)) rtl++
      else if (LTR_LETTER.test(ch)) ltr++
    }
  }
  return rtl > ltr
}

/** What each layout is called on its card. */
export const AI_DIAGRAM_LAYOUT_NAME: Record<AiDiagramLayout, string> = {
  flow: 'Process map',
  swimlane: 'Swimlane process map',
  tree: 'Tree',
  fishbone: 'Cause and effect (fishbone)',
  columns: 'Columns',
}
