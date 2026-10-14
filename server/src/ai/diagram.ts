// ============================================================================
// §20 — diagrams the assistant draws (shared/aiDiagram.ts): one tool of every
// new conversation, make_diagram, loaded through the tool search when a
// question needs it. The model says what the diagram holds — its layout, its
// boxes, arrows and groups — and the app lays it out and draws it; the model
// never places anything.
//
// What it is sent is checked here, every problem told at once, so it fixes
// them in one go: the layout's own rules (a swimlane's boxes each in a lane, a
// tree with one root and no loop, a fishbone with one effect and its causes on
// bones, each cause with its figure from the data), the ids every arrow,
// parent and group names, the words' lengths.
//
// A figure on a box is never the model's own text. It names a row of one of
// the diagram's figure queries — read-only, over the ai.* views, run here as
// the person's domains read now, as run_sql runs — by the value of the
// query's key column, and the server writes that row's value in. A query no
// box uses is not run. A box marked a hypothesis (not shown by the data) has
// no figure, and is drawn dashed — except on a fishbone, which holds only what
// the data shows: every cause there carries its figure, and a hypothesis, or a
// cause with no figure, is refused.
//
// What passes is kept with the call and its result, in one transaction
// (ai_diagrams, migration 0058), and shown as a card in its place.
// ============================================================================

import { randomUUID } from 'node:crypto'
import type Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import type { AiCell, AiStreamEvent } from '@qc/shared/ai'
import {
  AI_DIAGRAM_DETAIL_MAX,
  AI_DIAGRAM_DIRECTIONS,
  AI_DIAGRAM_EDGE_LABEL_MAX,
  AI_DIAGRAM_GROUP_LABEL_MAX,
  AI_DIAGRAM_ID_MAX,
  AI_DIAGRAM_LABEL_MAX,
  AI_DIAGRAM_LAYOUTS,
  AI_DIAGRAM_LINK_MAX,
  AI_DIAGRAM_MAX_DECIMALS,
  AI_DIAGRAM_MAX_DEPTH,
  AI_DIAGRAM_MAX_EDGES,
  AI_DIAGRAM_MAX_GROUPS,
  AI_DIAGRAM_MAX_NODES,
  AI_DIAGRAM_MAX_SOURCES,
  AI_DIAGRAM_MIN_GROUPS,
  AI_DIAGRAM_SHAPES,
  AI_DIAGRAM_SOURCE_MAX_ROWS,
  AI_DIAGRAM_TITLE_MAX,
  AI_DIAGRAM_TONES,
  AI_DIAGRAM_UNIT_MAX,
  diagramReadsRightToLeft,
  type AiDiagramDirection,
  type AiDiagramEdge,
  type AiDiagramGroup,
  type AiDiagramLayout,
  type AiDiagramNode,
  type AiDiagramPart,
  type AiDiagramShape,
  type AiDiagramSource,
  type AiDiagramSpec,
  type AiDiagramTone,
} from '@qc/shared/aiDiagram'
import type { Config } from '../config'
import type { Db, Queryable } from '../db/pool'
import { describeIssues } from '../automations/draft'
import { isGranted, loadAccess } from './access'
import { HANDED_OVER, type Readers, type ToolHandler, type ToolOutcome } from './assistant'
import { cutChars } from './blocks'
import { resultColumn } from './excel'
import { AI_MAX_SQL_CHARS, AI_QUERY_TIMEOUT_MS, runReadOnlyQuery, type QueryRun } from './runQuery'
import { withQueryOrigin } from './slowQueries'

type ToolUse = Anthropic.Beta.BetaToolUseBlock

export const MAKE_DIAGRAM_TOOL_NAME = 'make_diagram'

const LAYOUT_WORDS =
  'flow: boxes in the order the arrows run (a process map, a flowchart, a decision tree, a value stream). ' +
  'swimlane: the same, each box in the lane (group) of who does it (a department, a role, a machine). ' +
  'tree: each box under its parent (5 whys, a fault tree, a mind map, a breakdown); one root. ' +
  'fishbone: a cause-and-effect (Ishikawa) diagram: one effect box with no group and no parent, each cause on a bone (group, such as the 6M), a sub-cause under its cause (parent); only causes the data shows, each with its figure, never a hypothesis. ' +
  'columns: boxes in columns side by side, each in its column (group), in order (SIPOC, before and after, options compared).'

export const MAKE_DIAGRAM_TOOL: Anthropic.Beta.BetaTool = {
  name: MAKE_DIAGRAM_TOOL_NAME,
  description:
    'Draw a diagram in the answer: a process map or flowchart, a swimlane across departments, a tree (5 whys, fault tree, mind map), a fishbone (cause and effect) or columns (SIPOC). ' +
    'Give what it holds — boxes (nodes), arrows (edges), groups — and the app lays it out and draws it; never positions. ' +
    'A figure on a box comes from one of the figure queries (figures): read-only SQL over the ai.* views, as run_sql takes it, returning one row per key; a box names its source and its key, and the server writes the value in. Never write a figure of the record into a label or a detail. ' +
    `At most ${AI_DIAGRAM_MAX_NODES} boxes. Returns what was drawn, or every problem to fix before calling again.`,
  eager_input_streaming: true,
  input_schema: {
    type: 'object',
    properties: {
      layout: { type: 'string', enum: [...AI_DIAGRAM_LAYOUTS], description: LAYOUT_WORDS },
      title: { type: 'string', description: `What the diagram shows, in the person's language (at most ${AI_DIAGRAM_TITLE_MAX} characters): the process, or the effect with its scope (machine, period).` },
      direction: {
        type: 'string',
        enum: [...AI_DIAGRAM_DIRECTIONS],
        description: 'flow and tree only: across (along the reading direction; a flow\'s default) or down the page (a tree\'s default; a long flow reads better down on a narrow screen).',
      },
      groups: {
        type: 'array',
        description: `swimlane: its lanes, top to bottom; fishbone: its bones (categories); columns: its columns, in reading order. ${AI_DIAGRAM_MIN_GROUPS} to ${AI_DIAGRAM_MAX_GROUPS}. flow and tree take none.`,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'A short id that nodes name as their group.' },
            label: { type: 'string', description: `Its name, in the person's language (at most ${AI_DIAGRAM_GROUP_LABEL_MAX} characters).` },
          },
          required: ['id', 'label'],
          additionalProperties: false,
        },
      },
      nodes: {
        type: 'array',
        description: `The boxes, 2 to ${AI_DIAGRAM_MAX_NODES}, in a sensible order (a flow's in the order of the work; a column's top to bottom).`,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'A short id, unique in the diagram, that edges and parents name.' },
            label: { type: 'string', description: `A few words (at most ${AI_DIAGRAM_LABEL_MAX} characters), in the person's language; codes and names exactly as in the data.` },
            detail: { type: 'string', description: `Optional. A second, smaller line (at most ${AI_DIAGRAM_DETAIL_MAX} characters): where, what to check, what the label leaves out. No figures of the record.` },
            shape: {
              type: 'string',
              enum: [...AI_DIAGRAM_SHAPES],
              description: 'flow and swimlane only (default step): step, decision (label its outgoing edges with the answers), terminal (start or end), inspection (a quality check), store (stock or a wait), document (a record or a form), note.',
            },
            tone: { type: 'string', enum: [...AI_DIAGRAM_TONES], description: 'Optional (default neutral): accent to pick a box out, good, warning, bad (the problem, a bottleneck, the main cause).' },
            group: { type: 'string', description: "The id of its lane (swimlane), bone (fishbone) or column (columns)." },
            parent: { type: 'string', description: "tree: the id of its parent (every box but the root has one). fishbone: a sub-cause's cause." },
            hypothesis: { type: 'boolean', description: 'True for a step or a why that the data does not show: put forward from experience, to be checked. Drawn dashed. A box with a figure is never one, and a fishbone takes none.' },
            figure: {
              type: 'object',
              description: "Optional. The figure shown on the box: the row of a figure query whose key column holds `key`; the server writes that row's value in.",
              properties: {
                source: { type: 'string', description: 'The id of a figure query (figures).' },
                key: { type: 'string', description: "The value of that query's key column on the row wanted, exactly as the query returns it." },
              },
              required: ['source', 'key'],
              additionalProperties: false,
            },
            link: { type: 'string', description: 'Optional. A page of this application the box opens, such as /history?session=<session_id>.' },
          },
          required: ['id', 'label'],
          additionalProperties: false,
        },
      },
      edges: {
        type: 'array',
        description: `flow and swimlane only: the arrows, at most ${AI_DIAGRAM_MAX_EDGES}. A loop back (rework) is fine.`,
        items: {
          type: 'object',
          properties: {
            from: { type: 'string', description: 'The id of the box it leaves.' },
            to: { type: 'string', description: 'The id of the box it enters.' },
            label: { type: 'string', description: `Optional (at most ${AI_DIAGRAM_EDGE_LABEL_MAX} characters): a decision's answer (Yes, No, OK, NG), or what moves along it.` },
            dashed: { type: 'boolean', description: 'A path taken now and then: rework, a return, a hold.' },
          },
          required: ['from', 'to'],
          additionalProperties: false,
        },
      },
      figures: {
        type: 'array',
        description: `Optional. The queries the boxes' figures come from, at most ${AI_DIAGRAM_MAX_SOURCES}; one no box uses is not run.`,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'A short id that boxes name as their figure\'s source.' },
            purpose: { type: 'string', description: "One short line, in the person's language, saying what it counts. Shown with the diagram." },
            sql: { type: 'string', description: `One read-only SELECT over ai.* views, as run_sql takes it, returning one row per key (at most ${AI_DIAGRAM_SOURCE_MAX_ROWS} rows).` },
            key: { type: 'string', description: 'The column whose values the boxes name (a machine, a defect, a shift).' },
            value: { type: 'string', description: 'The numeric column shown on the box.' },
            unit: { type: 'string', description: `Optional. Written after the figure (at most ${AI_DIAGRAM_UNIT_MAX} characters): %, pcs, h, kg.` },
            decimals: { type: 'integer', description: `Optional. 0 to ${AI_DIAGRAM_MAX_DECIMALS}; left out, whole numbers are written whole and others with up to 2 decimals.` },
          },
          required: ['id', 'purpose', 'sql', 'key', 'value'],
          additionalProperties: false,
        },
      },
    },
    required: ['layout', 'title', 'nodes'],
    additionalProperties: false,
  },
}

export const DIAGRAM_TOOLS: readonly Anthropic.Beta.BetaTool[] = [MAKE_DIAGRAM_TOOL]

// ---- The input, as it may arrive ------------------------------------------------------------
//
// Eager input streaming means the API no longer holds the model to the schema: an id may come as a number, a field
// as null. Read leniently here; the checks below say what is wrong.

const Id = z.union([z.string(), z.number()]).transform((v) => String(v))
const Text = z.string().nullish()

const NodeInput = z
  .object({
    id: Id,
    label: z.string(),
    detail: Text,
    shape: Text,
    tone: Text,
    group: Id.nullish(),
    parent: Id.nullish(),
    hypothesis: z.boolean().nullish(),
    figure: z.object({ source: Id, key: z.union([z.string(), z.number()]).transform((v) => String(v)) }).passthrough().nullish(),
    link: Text,
  })
  .passthrough()
const EdgeInput = z.object({ from: Id, to: Id, label: Text, dashed: z.boolean().nullish() }).passthrough()
const GroupInput = z.object({ id: Id, label: z.string() }).passthrough()
const SourceInput = z
  .object({ id: Id, purpose: z.string(), sql: z.string(), key: z.string(), value: z.string(), unit: Text, decimals: z.number().nullish() })
  .passthrough()
const Input = z
  .object({
    layout: z.string(),
    title: z.string(),
    direction: Text,
    groups: z.array(GroupInput).nullish(),
    nodes: z.array(NodeInput),
    edges: z.array(EdgeInput).nullish(),
    figures: z.array(SourceInput).nullish(),
  })
  .passthrough()

/** Other names the model may give a layout. */
const LAYOUT_ALIASES: Record<string, AiDiagramLayout> = {
  process: 'flow',
  'process-map': 'flow',
  processmap: 'flow',
  flowchart: 'flow',
  'flow-chart': 'flow',
  'value-stream': 'flow',
  'swim-lane': 'swimlane',
  swimlanes: 'swimlane',
  'cross-functional': 'swimlane',
  ishikawa: 'fishbone',
  'fish-bone': 'fishbone',
  'cause-effect': 'fishbone',
  'cause-and-effect': 'fishbone',
  mindmap: 'tree',
  'mind-map': 'tree',
  '5-why': 'tree',
  '5-whys': 'tree',
  'five-whys': 'tree',
  'fault-tree': 'tree',
  sipoc: 'columns',
  column: 'columns',
}

function layoutOf(raw: string): AiDiagramLayout | null {
  const t = raw.trim().toLowerCase().replace(/[\s_]+/g, '-')
  if ((AI_DIAGRAM_LAYOUTS as readonly string[]).includes(t)) return t as AiDiagramLayout
  return LAYOUT_ALIASES[t] ?? null
}

/** A value of a closed list, as the model may spell it ("Decision", " bad "); undefined when it gave none, null when it is none of them. */
function oneOf<T extends string>(raw: string | null | undefined, values: readonly T[]): T | null | undefined {
  if (raw === null || raw === undefined || raw.trim() === '') return undefined
  const t = raw.trim().toLowerCase() as T
  return values.includes(t) ? t : null
}

const oneLine = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()

/** A page of this application, as a box may open it: a path of this site, nothing that leaves it. The panel checks it again. */
export function isAppLink(raw: string): boolean {
  // eslint-disable-next-line no-control-regex
  if (raw.length > AI_DIAGRAM_LINK_MAX || /[\s\u0000-\u001f\u007f\\]/.test(raw)) return false
  if (!raw.startsWith('/') || raw.startsWith('//')) return false
  try {
    const url = new URL(raw, 'https://app.invalid')
    return url.origin === 'https://app.invalid' && !`${url.pathname}${url.search}${url.hash}`.startsWith('//')
  } catch {
    return false
  }
}

/** A figure as it is drawn: whole numbers whole, others with up to two decimals (or as many as asked), then the unit. */
export function figureText(value: number, unit: string, decimals: number | undefined): string {
  const digits =
    decimals !== undefined ? { minimumFractionDigits: decimals, maximumFractionDigits: decimals } : Number.isInteger(value) ? { maximumFractionDigits: 0 } : { maximumFractionDigits: 2 }
  const n = value.toLocaleString('en-US', digits)
  if (!unit) return n
  return unit === '%' ? `${n}%` : `${n} ${unit}`
}

/** A key cell as boxes name it: its text, trimmed; null for none. */
const keyText = (v: AiCell): string | null => (v === null ? null : String(v).trim())

export interface DiagramCheck {
  spec: AiDiagramSpec
  /** What was changed or left out on the way, for the model. */
  notes: string[]
}

interface CheckedSource {
  id: string
  purpose: string
  sql: string
  key: string
  value: string
  unit: string
  decimals?: number
}

/**
 * The diagram as the model sent it, checked: its shape, its layout's rules,
 * and the figure queries its boxes name, each run (`run`) as the person's
 * domains read. Every problem, or the diagram as it will be kept.
 */
export async function checkDiagram(input: unknown, run: (source: { id: string; purpose: string; sql: string }) => Promise<QueryRun>): Promise<{ errors: string[] } | DiagramCheck> {
  const parsed = Input.safeParse(input)
  if (!parsed.success) return { errors: describeIssues(parsed.error) }
  const i = parsed.data
  const errors: string[] = []
  const notes: string[] = []

  const layout = layoutOf(i.layout)
  if (!layout) return { errors: [`layout: one of ${AI_DIAGRAM_LAYOUTS.join(', ')}.`] }
  const title = cutChars(oneLine(i.title), AI_DIAGRAM_TITLE_MAX, true)
  if (title === '') errors.push('title: say what the diagram shows.')

  let direction: AiDiagramDirection = layout === 'tree' ? 'down' : 'across'
  if (layout === 'flow' || layout === 'tree') {
    const d = oneOf(i.direction, AI_DIAGRAM_DIRECTIONS)
    if (d === null) errors.push(`direction: across or down.`)
    else if (d) direction = d
  }

  // ---- Groups: a swimlane's lanes, a fishbone's bones, columns; none for a flow or a tree.
  const groups: AiDiagramGroup[] = []
  const groupIds = new Set<string>()
  const takesGroups = layout === 'swimlane' || layout === 'fishbone' || layout === 'columns'
  const groupName = layout === 'swimlane' ? 'lane' : layout === 'fishbone' ? 'bone' : 'column'
  const givenGroups = i.groups ?? []
  if (!takesGroups && givenGroups.length > 0) {
    errors.push(`groups: a ${layout} takes none${layout === 'flow' ? ' (for lanes of who does each step, use the swimlane layout)' : ''}.`)
  } else if (takesGroups) {
    if (givenGroups.length < AI_DIAGRAM_MIN_GROUPS || givenGroups.length > AI_DIAGRAM_MAX_GROUPS) {
      errors.push(`groups: a ${layout} takes ${AI_DIAGRAM_MIN_GROUPS} to ${AI_DIAGRAM_MAX_GROUPS} ${groupName}s; it has ${givenGroups.length}.`)
    }
    for (const [k, g] of givenGroups.slice(0, AI_DIAGRAM_MAX_GROUPS).entries()) {
      const id = g.id.trim()
      const label = cutChars(oneLine(g.label), AI_DIAGRAM_GROUP_LABEL_MAX, true)
      if (id === '' || id.length > AI_DIAGRAM_ID_MAX) errors.push(`groups[${k}].id: 1 to ${AI_DIAGRAM_ID_MAX} characters.`)
      else if (groupIds.has(id)) errors.push(`groups[${k}].id: "${id}" is used twice.`)
      if (label === '') errors.push(`groups[${k}].label: give the ${groupName} a name.`)
      groupIds.add(id)
      groups.push({ id, label })
    }
  }

  // ---- Figure queries: checked as given; run later, only those a box names.
  const sources = new Map<string, CheckedSource>()
  const givenSources = i.figures ?? []
  if (givenSources.length > AI_DIAGRAM_MAX_SOURCES) errors.push(`figures: at most ${AI_DIAGRAM_MAX_SOURCES} queries; there are ${givenSources.length}. Return several measures as rows of one query, by key.`)
  for (const [k, s] of givenSources.slice(0, AI_DIAGRAM_MAX_SOURCES).entries()) {
    const where = `figures[${k}]`
    const id = s.id.trim()
    const problems: string[] = []
    if (id === '' || id.length > AI_DIAGRAM_ID_MAX) problems.push(`${where}.id: 1 to ${AI_DIAGRAM_ID_MAX} characters.`)
    else if (sources.has(id)) problems.push(`${where}.id: "${id}" is used twice.`)
    if (oneLine(s.purpose) === '') problems.push(`${where}.purpose: say what it counts.`)
    if (s.sql.trim() === '' || s.sql.length > AI_MAX_SQL_CHARS) problems.push(`${where}.sql: one SELECT of at most ${AI_MAX_SQL_CHARS} characters.`)
    if (s.key.trim() === '') problems.push(`${where}.key: the column the boxes name.`)
    if (s.value.trim() === '') problems.push(`${where}.value: the numeric column shown.`)
    const unit = oneLine(s.unit)
    if (Array.from(unit).length > AI_DIAGRAM_UNIT_MAX) problems.push(`${where}.unit: at most ${AI_DIAGRAM_UNIT_MAX} characters.`)
    const decimals = s.decimals ?? undefined
    if (decimals !== undefined && (!Number.isInteger(decimals) || decimals < 0 || decimals > AI_DIAGRAM_MAX_DECIMALS)) problems.push(`${where}.decimals: a whole number from 0 to ${AI_DIAGRAM_MAX_DECIMALS}.`)
    if (problems.length > 0) {
      errors.push(...problems)
      continue
    }
    sources.set(id, { id, purpose: cutChars(oneLine(s.purpose), 200, true), sql: s.sql, key: s.key.trim(), value: s.value.trim(), unit, decimals })
  }

  // ---- Boxes.
  const nodes: AiDiagramNode[] = []
  const byId = new Map<string, AiDiagramNode>()
  const cut: string[] = []
  const asked = new Map<number, { source: string; key: string }>()
  if (i.nodes.length < 2 || i.nodes.length > AI_DIAGRAM_MAX_NODES) {
    errors.push(
      i.nodes.length > AI_DIAGRAM_MAX_NODES
        ? `nodes: at most ${AI_DIAGRAM_MAX_NODES}; there are ${i.nodes.length}. Keep the main ones, group the rest, or split it into two diagrams.`
        : 'nodes: a diagram takes at least 2 boxes.',
    )
  }
  const takesShapes = layout === 'flow' || layout === 'swimlane'
  for (const [k, n] of i.nodes.slice(0, AI_DIAGRAM_MAX_NODES).entries()) {
    const where = `nodes[${k}]`
    const id = n.id.trim()
    if (id === '' || id.length > AI_DIAGRAM_ID_MAX) {
      errors.push(`${where}.id: 1 to ${AI_DIAGRAM_ID_MAX} characters.`)
      continue
    }
    if (byId.has(id)) {
      errors.push(`${where}.id: "${id}" is used twice.`)
      continue
    }
    const fullLabel = oneLine(n.label)
    if (fullLabel === '') errors.push(`${where}.label: give the box a few words.`)
    const label = cutChars(fullLabel, AI_DIAGRAM_LABEL_MAX, true)
    if (label !== fullLabel) cut.push(id)
    const node: AiDiagramNode = { id, label, shape: 'step', tone: 'neutral' }
    const detail = cutChars(oneLine(n.detail), AI_DIAGRAM_DETAIL_MAX, true)
    if (detail) node.detail = detail
    const shape = oneOf(n.shape, AI_DIAGRAM_SHAPES)
    if (shape === null) errors.push(`${where}.shape: one of ${AI_DIAGRAM_SHAPES.join(', ')}.`)
    else if (shape && takesShapes) node.shape = shape as AiDiagramShape
    const tone = oneOf(n.tone, AI_DIAGRAM_TONES)
    if (tone === null) errors.push(`${where}.tone: one of ${AI_DIAGRAM_TONES.join(', ')}.`)
    else if (tone) node.tone = tone as AiDiagramTone
    const group = n.group?.trim() || undefined
    if (group !== undefined) {
      if (!takesGroups) errors.push(`${where}.group: a ${layout} has no groups.`)
      else if (!groupIds.has(group)) errors.push(`${where}.group: "${group}" is not one of the ${groupName}s (${[...groupIds].map((g) => `"${g}"`).join(', ')}).`)
      else node.group = group
    } else if (layout === 'swimlane' || layout === 'columns') {
      errors.push(`${where}.group: every box of a ${layout} is in a ${groupName}; give it one.`)
    }
    const parent = n.parent?.trim() || undefined
    if (parent !== undefined) {
      if (layout !== 'tree' && layout !== 'fishbone') errors.push(`${where}.parent: only a tree or a fishbone takes parents${takesShapes ? '; a flow is joined by edges' : ''}.`)
      else node.parent = parent
    }
    if (n.hypothesis) node.hypothesis = true
    if (n.figure) {
      if (n.hypothesis) errors.push(`${where}: a box with a figure from the data is not a hypothesis; drop one of them.`)
      else asked.set(nodes.length, { source: n.figure.source.trim(), key: n.figure.key.trim() })
    }
    const link = n.link?.trim()
    if (link) {
      if (isAppLink(link)) node.link = link
      else errors.push(`${where}.link: a page of this application, starting with one "/" (such as /history?session=<session_id>).`)
    }
    nodes.push(node)
    byId.set(id, node)
  }
  if (cut.length > 0) notes.push(`Labels longer than ${AI_DIAGRAM_LABEL_MAX} characters were cut (${cut.map((c) => `"${c}"`).join(', ')}): keep labels to a few words and put the rest in detail.`)

  // ---- Arrows, where the layout has them.
  const edges: AiDiagramEdge[] = []
  const givenEdges = i.edges ?? []
  if (!takesShapes && givenEdges.length > 0) {
    errors.push(`edges: a ${layout} takes none: ${layout === 'columns' ? 'its columns are read in order' : 'each box names its parent'}.`)
  } else if (givenEdges.length > AI_DIAGRAM_MAX_EDGES) {
    errors.push(`edges: at most ${AI_DIAGRAM_MAX_EDGES}; there are ${givenEdges.length}.`)
  } else {
    const seen = new Set<string>()
    for (const [k, e] of givenEdges.entries()) {
      const where = `edges[${k}]`
      const from = e.from.trim()
      const to = e.to.trim()
      const missing = [from, to].filter((id) => !byId.has(id))
      if (missing.length > 0) {
        errors.push(`${where}: ${missing.map((m) => `"${m}"`).join(' and ')} ${missing.length === 1 ? 'is no box' : 'are no boxes'} of the diagram.`)
        continue
      }
      if (from === to) {
        errors.push(`${where}: an arrow from a box to itself; draw a rework loop through the step it returns to.`)
        continue
      }
      if (seen.has(`${from}\u0000${to}`)) {
        errors.push(`${where}: a second arrow from "${from}" to "${to}"; give one arrow both labels.`)
        continue
      }
      seen.add(`${from}\u0000${to}`)
      const edge: AiDiagramEdge = { from, to }
      const label = cutChars(oneLine(e.label), AI_DIAGRAM_EDGE_LABEL_MAX, true)
      if (label) edge.label = label
      if (e.dashed) edge.dashed = true
      edges.push(edge)
    }
  }

  // ---- A tree's and a fishbone's parents.
  if (layout === 'tree') errors.push(...treeProblems(nodes, byId))
  if (layout === 'fishbone') errors.push(...fishboneProblems(nodes, byId, new Set([...asked.keys()].map((at) => nodes[at].id))))

  // ---- The figures: each query a box names, run once; each box's row found by its key.
  const used = new Set([...asked.values()].map((a) => a.source))
  const kept: AiDiagramSource[] = []
  for (const [at, a] of asked) {
    if (!sources.has(a.source)) {
      errors.push(`node "${nodes[at].id}".figure.source: "${a.source}" is not one of the figure queries${sources.size > 0 ? ` (${[...sources.keys()].map((s) => `"${s}"`).join(', ')})` : ' (figures is empty)'}.`)
    }
  }
  const unused = [...sources.keys()].filter((s) => !used.has(s))
  if (unused.length > 0) notes.push(`Figure queries no box uses were not run: ${unused.map((s) => `"${s}"`).join(', ')}.`)
  for (const source of sources.values()) {
    if (!used.has(source.id)) continue
    const result = await run({ id: source.id, purpose: source.purpose, sql: source.sql })
    const where = `figures "${source.id}"`
    if (!result.ok) {
      errors.push(`${where}: the query failed: ${result.error}`)
      continue
    }
    if (result.truncated) {
      errors.push(`${where}: the query returns more than ${AI_DIAGRAM_SOURCE_MAX_ROWS} rows; return one row per key, only the keys the boxes name.`)
      continue
    }
    const keyAt = resultColumn(result.columns, source.key)
    const valueAt = resultColumn(result.columns, source.value)
    const returns = `it returns ${result.columns.map((c) => `"${c}"`).join(', ')}`
    if (keyAt < 0) errors.push(`${where}.key: "${source.key}" is not one column of the result (${returns}).`)
    if (valueAt < 0) errors.push(`${where}.value: "${source.value}" is not one column of the result (${returns}).`)
    if (keyAt < 0 || valueAt < 0) continue
    // Each key's rows: a key on two rows names no single figure.
    const rowsByKey = new Map<string, AiCell[][]>()
    for (const row of result.rows) {
      const k = keyText(row[keyAt] ?? null)
      if (k === null) continue
      const list = rowsByKey.get(k)
      if (list) list.push(row)
      else rowsByKey.set(k, [row])
    }
    const keysByFold = new Map<string, string[]>()
    for (const k of rowsByKey.keys()) keysByFold.set(k.toLowerCase(), [...(keysByFold.get(k.toLowerCase()) ?? []), k])
    for (const [at, a] of asked) {
      if (a.source !== source.id) continue
      const node = nodes[at]
      const exact = rowsByKey.has(a.key) ? a.key : (keysByFold.get(a.key.toLowerCase()) ?? []).length === 1 ? keysByFold.get(a.key.toLowerCase())![0] : null
      if (exact === null) {
        const known = [...rowsByKey.keys()].slice(0, 20).map((k) => JSON.stringify(k))
        errors.push(`node "${node.id}".figure: no row of "${source.id}" has ${source.key} = ${JSON.stringify(a.key)}${known.length > 0 ? ` (it has ${known.join(', ')}${rowsByKey.size > known.length ? ', …' : ''})` : ' (it returned no rows)'}.`)
        continue
      }
      const rows = rowsByKey.get(exact)!
      if (rows.length > 1) {
        errors.push(`node "${node.id}".figure: ${rows.length} rows of "${source.id}" have ${source.key} = ${JSON.stringify(exact)}; return one row per key.`)
        continue
      }
      const value = rows[0][valueAt]
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push(`node "${node.id}".figure: the "${result.columns[valueAt]}" of ${JSON.stringify(exact)} is ${value === null ? 'empty' : 'not a number'}; select a number (0 where there is none).`)
        continue
      }
      node.figure = { text: figureText(value, source.unit, source.decimals), value, source: source.id }
    }
    kept.push({ id: source.id, purpose: source.purpose, sql: source.sql, rows: result.rows.length, ms: Math.round(result.ms) })
  }

  if (errors.length > 0) return { errors }
  const rtl = diagramReadsRightToLeft([title, ...groups.map((g) => g.label), ...nodes.flatMap((n) => [n.label, n.detail ?? ''])])
  return { spec: { layout, title, direction, rtl, groups, nodes, edges, sources: kept }, notes }
}

/** A tree: one root, every other box under a box of the diagram, no loop, at most AI_DIAGRAM_MAX_DEPTH deep. */
function treeProblems(nodes: readonly AiDiagramNode[], byId: ReadonlyMap<string, AiDiagramNode>): string[] {
  const errors: string[] = []
  const roots = nodes.filter((n) => !n.parent)
  if (roots.length !== 1) {
    errors.push(
      roots.length === 0
        ? 'nodes: a tree has one root, a box with no parent (the problem, the goal, the top event).'
        : `nodes: a tree has one root; ${roots.length} boxes have no parent (${roots.slice(0, 6).map((r) => `"${r.id}"`).join(', ')}). Put them under one box.`,
    )
  }
  for (const n of nodes) if (n.parent && !byId.has(n.parent)) errors.push(`node "${n.id}".parent: "${n.parent}" is no box of the diagram.`)
  if (errors.length > 0) return errors
  for (const n of nodes) {
    let depth = 1
    const seen = new Set<string>([n.id])
    for (let at = n; at.parent; at = byId.get(at.parent)!) {
      if (seen.has(at.parent)) {
        return [`node "${n.id}": its parents go round in a loop; a tree has none.`]
      }
      seen.add(at.parent)
      depth++
    }
    if (depth > AI_DIAGRAM_MAX_DEPTH) return [`node "${n.id}" is ${depth} levels deep; a tree goes at most ${AI_DIAGRAM_MAX_DEPTH}.`]
  }
  return errors
}

/**
 * A fishbone: one effect (no bone, no parent), each cause on a bone, each sub-cause under a cause and on its bone; and
 * only what the data shows. Every cause and sub-cause carries a figure from a figure query (`figured`: the boxes that
 * ask for one); one put forward from the model's own knowledge — a hypothesis, or a box with no figure — is refused.
 */
function fishboneProblems(nodes: AiDiagramNode[], byId: ReadonlyMap<string, AiDiagramNode>, figured: ReadonlySet<string>): string[] {
  const errors: string[] = []
  const effects = nodes.filter((n) => !n.group && !n.parent)
  if (effects.length !== 1) {
    errors.push(
      effects.length === 0
        ? 'nodes: a fishbone has one effect: a box with no group and no parent (the problem, with its scope).'
        : `nodes: a fishbone has one effect; ${effects.length} boxes have no group and no parent (${effects.slice(0, 6).map((e) => `"${e.id}"`).join(', ')}). Put each cause on a bone (group).`,
    )
  }
  const effect = effects.length === 1 ? effects[0] : null
  if (effect?.hypothesis) errors.push(`node "${effect.id}": the effect is the problem observed, not a hypothesis.`)
  for (const n of nodes) {
    if (n === effect) continue
    if (n.hypothesis) errors.push(`node "${n.id}": a fishbone holds only what the data shows, never a hypothesis; leave this cause off it.`)
    else if (!figured.has(n.id)) errors.push(`node "${n.id}": every cause on a fishbone shows the figure from the data that bears it out; give it a figure from a figure query, or leave it off.`)
  }
  for (const n of nodes) {
    if (!n.parent) continue
    const parent = byId.get(n.parent)
    if (!parent) {
      errors.push(`node "${n.id}".parent: "${n.parent}" is no box of the diagram.`)
      continue
    }
    if (parent === effect) {
      errors.push(`node "${n.id}".parent: a cause goes on a bone (group), not under the effect.`)
      continue
    }
    if (parent.parent) {
      errors.push(`node "${n.id}".parent: "${parent.id}" is itself a sub-cause; a fishbone goes two levels deep (a cause, its sub-causes).`)
      continue
    }
    if (!parent.group) continue
    if (n.group && n.group !== parent.group) errors.push(`node "${n.id}".group: its cause "${parent.id}" is on "${parent.group}"; a sub-cause is on its cause's bone.`)
    else n.group = parent.group
  }
  return errors
}

// ---- The tool -------------------------------------------------------------------------------

export interface DiagramToolContext {
  db: Db
  config: Config
  readers: Readers
  userId: string
  conversationId: string
  turnId: string
  emit: (event: AiStreamEvent) => void
}

const failed = (tu: ToolUse, content: string): ToolOutcome => ({ result: { type: 'tool_result', tool_use_id: tu.id, is_error: true, content } })

export function diagramToolHandlers(ctx: DiagramToolContext): Record<string, ToolHandler> {
  return { [MAKE_DIAGRAM_TOOL_NAME]: { run: (tu, signal) => make(ctx, tu, signal) } }
}

async function make(ctx: DiagramToolContext, tu: ToolUse, signal: AbortSignal): Promise<ToolOutcome> {
  try {
    // The person's domains as they are now: a figure reads only what they may.
    const access = await loadAccess(ctx.db, ctx.userId)
    if (!isGranted(access)) return failed(tu, 'Not drawn: this person no longer has the assistant.')
    const pool = ctx.readers.poolFor(access.domains)
    const named = (tu.input as { title?: unknown } | null)?.title
    const checked = await checkDiagram(tu.input, (source) =>
      // Its queries are this diagram's, named by it and their purpose (a slow one is kept for the owner: slowQueries.ts).
      withQueryOrigin({ purpose: `${typeof named === 'string' ? oneLine(named) : 'Diagram'} · ${source.purpose}` }, () =>
        runReadOnlyQuery(pool, source.sql, { maxRows: AI_DIAGRAM_SOURCE_MAX_ROWS, timeoutMs: AI_QUERY_TIMEOUT_MS, timeZone: ctx.config.FACTORY_TIMEZONE, signal }),
      ),
    )
    if (signal.aborted) return failed(tu, signal.reason === HANDED_OVER ? 'Not drawn: the answer was handed over.' : 'Not drawn: stopped.')
    if ('errors' in checked) {
      return failed(tu, ['Nothing was drawn. Fix these and call make_diagram again:', ...checked.errors.map((p) => `- ${p}`)].join('\n'))
    }
    const part: AiDiagramPart = { type: 'diagram', diagramId: randomUUID(), spec: checked.spec }
    ctx.emit({ type: 'diagram', part })
    const { spec } = checked
    const content = {
      drawn: true,
      layout: spec.layout,
      title: spec.title,
      boxes: spec.nodes.length,
      arrows: spec.edges.length,
      figures: spec.nodes.flatMap((n) => (n.figure ? [{ box: n.id, figure: n.figure.text }] : [])),
      hypotheses: spec.nodes.filter((n) => n.hypothesis).length,
      ...(checked.notes.length > 0 ? { notes: checked.notes } : {}),
      note:
        'Shown to the person in your answer, in its place, with the figure queries under it. Do not draw it again in text or list every box: say in a few sentences what it shows, ' +
        'which boxes the data bears out (with their figures) and which are hypotheses to check, and what to do next. To change it, call make_diagram again with the whole diagram.',
    }
    return {
      result: { type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(content) },
      store: (tx) => storeDiagram(tx, ctx, tu.id, part),
    }
  } catch (e) {
    if (signal.aborted) return failed(tu, 'Not drawn: stopped.')
    console.error('[ai] a diagram could not be drawn', e)
    return failed(tu, 'Not drawn: a fault on the server. Say so to the person; they may ask again.')
  }
}

async function storeDiagram(tx: Queryable, ctx: DiagramToolContext, toolUseId: string, part: AiDiagramPart): Promise<void> {
  await tx.query(
    `INSERT INTO ai_diagrams (id, conversation_id, turn_id, tool_use_id, user_id, spec) VALUES ($1, $2, $3, $4, $5, $6::json)`,
    [part.diagramId, ctx.conversationId, ctx.turnId, toolUseId, ctx.userId, JSON.stringify(part.spec)],
  )
}
