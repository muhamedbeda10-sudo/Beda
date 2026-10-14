// ============================================================================
// §20 — diagrams the assistant draws (shared/aiDiagram.ts): one tool of every
// new conversation, draw_diagram, loaded through the tool search when an
// answer needs one. The model writes the diagram itself — a fishbone of a
// problem's causes, a 5 Whys chain, a flowchart, a mind map — and the server
// checks it: every text within its length, every count within its limits, a
// flowchart's edges between its own nodes, and every fishbone cause (and any
// 5 Whys evidence) backed by a figure that a query of the conversation
// returned (./evidence) — the model may not put on a fishbone what it did not
// read in the data. Anything wrong is told to the model, every problem at
// once, and nothing is drawn. A diagram that passes is shown as a card in the
// answer and kept with it (migration 0058), in the transaction that keeps the
// call and its result.
//
// It runs no query of its own: it reads only the results of the queries the
// person's own conversation ran, so anyone the assistant answers may have one
// drawn.
// ============================================================================

import { randomUUID } from 'node:crypto'
import type Anthropic from '@anthropic-ai/sdk'
import {
  AI_DIAGRAM_KINDS,
  AI_DIAGRAM_LIMITS as L,
  AI_DIAGRAM_NAMES,
  FISHBONE_CATEGORIES,
  FLOW_NODE_SHAPES,
  mindMapSize,
  type AiDiagram,
  type AiDiagramBody,
  type AiDiagramKind,
  type AiDiagramPart,
  type FishboneBone,
  type FishboneCause,
  type FiveWhysStep,
  type FlowEdge,
  type FlowNode,
  type FlowNodeShape,
  type MindNode,
} from '@qc/shared/aiDiagram'
import type { AiStreamEvent } from '@qc/shared/ai'
import type { Queryable } from '../db/pool'
import type { ToolHandler, ToolOutcome } from './assistant'
import { conversationResults, findEvidence, type QueryResult } from './evidence'

type ToolUse = Anthropic.Beta.BetaToolUseBlock

export const DRAW_DIAGRAM_TOOL_NAME = 'draw_diagram'

const text = (description: string) => ({ type: 'string', description })

/** A mind map's node, `depth` levels of children under it at most. */
function mindNodeSchema(depth: number): Record<string, unknown> {
  const node: Record<string, unknown> = { type: 'object', properties: { label: text(`At most ${L.mindMap.label} characters.`) }, required: ['label'], additionalProperties: false }
  if (depth > 0) (node.properties as Record<string, unknown>).children = { type: 'array', description: `Optional. At most ${L.mindMap.maxChildren}.`, items: mindNodeSchema(depth - 1) }
  return node
}

export const DRAW_DIAGRAM_TOOL: Anthropic.Beta.BetaTool = {
  name: DRAW_DIAGRAM_TOOL_NAME,
  description:
    'Draw a diagram in the answer, shown to the person as a card (and printed with it): a fishbone (Ishikawa) of the causes of a problem, a 5 Whys chain down to a root cause, a flowchart of a process, or a mind map. ' +
    "A fishbone holds only causes the data shows: run the queries first; each cause's evidence is checked against their results, and a figure no query returned is refused. " +
    'You write the diagram; give the object of its kind (fishbone, five_whys, flowchart or mind_map) and leave the others out. Every text in the language of the question. ' +
    'Returns that it was drawn, or every problem to fix before calling again.',
  eager_input_streaming: true,
  input_schema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: [...AI_DIAGRAM_KINDS] },
      title: text(`The diagram's title (at most ${L.title} characters).`),
      notes: text(`Optional. A line under it (at most ${L.notes} characters): the period and the data the causes were checked against, or what the reader should know.`),
      fishbone: {
        type: 'object',
        description: 'For kind fishbone.',
        properties: {
          problem: text(`The head: the problem, short (at most ${L.fishbone.problem} characters), e.g. "Wavy edge on RF-03, Oct 1-13".`),
          bones: {
            type: 'array',
            description: `${L.fishbone.minBones} to ${L.fishbone.maxBones} bones, usually the 6M in this order: ${FISHBONE_CATEGORIES.join(', ')}. Leave out a bone the data shows nothing on.`,
            items: {
              type: 'object',
              properties: {
                category: text(`The bone's name (at most ${L.fishbone.category} characters).`),
                causes: {
                  type: 'array',
                  description: `1 to ${L.fishbone.maxCauses} causes on this bone, the strongest first.`,
                  items: {
                    type: 'object',
                    properties: {
                      text: text(`The cause (at most ${L.fishbone.cause} characters).`),
                      evidence: text(
                        `The figure that shows it, exactly as a query of this conversation returned it (at most ${L.fishbone.evidence} characters), e.g. "4.1% rejects vs 1.2% avg". Every number in it must be in a query's result.`,
                      ),
                    },
                    required: ['text', 'evidence'],
                    additionalProperties: false,
                  },
                },
              },
              required: ['category', 'causes'],
              additionalProperties: false,
            },
          },
        },
        required: ['problem', 'bones'],
        additionalProperties: false,
      },
      five_whys: {
        type: 'object',
        description: 'For kind five-whys.',
        properties: {
          problem: text(`The problem asked about (at most ${L.fiveWhys.problem} characters).`),
          steps: {
            type: 'array',
            description: `2 to ${L.fiveWhys.maxSteps} answers to "Why?", in order, each the cause of the one before; the last is the root cause.`,
            items: {
              type: 'object',
              properties: {
                because: text(`At most ${L.fiveWhys.step} characters.`),
                evidence: text(`Optional. The figure that shows it, as a query of this conversation returned it (at most ${L.fiveWhys.evidence} characters).`),
              },
              required: ['because'],
              additionalProperties: false,
            },
          },
          actions: { type: 'array', items: { type: 'string' }, description: `Optional. At most ${L.fiveWhys.maxActions} actions against the root cause.` },
        },
        required: ['problem', 'steps'],
        additionalProperties: false,
      },
      flowchart: {
        type: 'object',
        description: 'For kind flowchart.',
        properties: {
          nodes: {
            type: 'array',
            description: `${L.flowchart.minNodes} to ${L.flowchart.maxNodes} nodes, in the order the process runs.`,
            items: {
              type: 'object',
              properties: {
                id: text(`Short and unique (at most ${L.flowchart.id} characters), e.g. "cut".`),
                label: text(`What happens (at most ${L.flowchart.label} characters).`),
                shape: { type: 'string', enum: [...FLOW_NODE_SHAPES], description: 'start, end, step, or decision (a question with two or more named ways out).' },
                highlight: { type: 'boolean', description: 'Optional. Marks the node out: where the problem arises, or the step that changes.' },
              },
              required: ['id', 'label', 'shape'],
              additionalProperties: false,
            },
          },
          edges: {
            type: 'array',
            description: `At most ${L.flowchart.maxEdges}. Every way out of a decision named by its answer.`,
            items: {
              type: 'object',
              properties: {
                from: text('A node id.'),
                to: text('A node id.'),
                label: text(`Optional; required out of a decision (at most ${L.flowchart.edgeLabel} characters), e.g. "Yes", "Fail".`),
              },
              required: ['from', 'to'],
              additionalProperties: false,
            },
          },
        },
        required: ['nodes', 'edges'],
        additionalProperties: false,
      },
      mind_map: {
        type: 'object',
        description: 'For kind mind-map.',
        properties: {
          center: text(`The subject in the middle (at most ${L.mindMap.center} characters).`),
          branches: {
            type: 'array',
            description: `1 to ${L.mindMap.maxBranches} branches; ${L.mindMap.maxDepth} levels at most, ${L.mindMap.maxNodes} nodes in all.`,
            items: mindNodeSchema(L.mindMap.maxDepth - 1),
          },
        },
        required: ['center', 'branches'],
        additionalProperties: false,
      },
    },
    required: ['kind', 'title'],
    additionalProperties: false,
  },
}

export const DIAGRAM_TOOLS: readonly Anthropic.Beta.BetaTool[] = [DRAW_DIAGRAM_TOOL]

// ---- Checking what the model sent -----------------------------------------------------------

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Reads the parts of a diagram, gathering every problem as it goes. */
class Reader {
  readonly problems: string[] = []

  constructor(private readonly results: readonly QueryResult[]) {}

  /** The queries an evidence's figures were found in; [] (with a problem) when it shows none, or one no query returned. */
  evidence(evidence: string, where: string): string[] {
    const found = findEvidence(evidence, this.results)
    if ('sources' in found) return found.sources
    if (found.none) this.problem(`${where}: give the figure that shows it (a count, a rate, a share), as a query returned it.`)
    else this.problem(`${where}: ${found.missing.map((m) => `"${m}"`).join(', ')} ${found.missing.length === 1 ? 'is' : 'are'} in no query's result in this conversation. Run the query that shows it first, and copy the figure as it returned it; a cause the data cannot show stays off the fishbone.`)
    return []
  }

  problem(message: string): void {
    this.problems.push(message)
  }

  /** A text on one line; '' (with a problem) when it is missing and required, or too long. */
  text(value: unknown, where: string, max: number, required = true): string {
    if (value === undefined || value === null) {
      if (required) this.problem(`${where}: required.`)
      return ''
    }
    if (typeof value !== 'string') {
      this.problem(`${where}: must be text.`)
      return ''
    }
    const line = oneLine(value)
    if (!line && required) this.problem(`${where}: must not be empty.`)
    if (line.length > max) this.problem(`${where}: ${line.length} characters; shorten it to ${max} at most.`)
    return line
  }

  /** A list; [] (with a problem) when it is not one, or holds fewer than `min` or more than `max`. */
  list(value: unknown, where: string, min: number, max: number): unknown[] {
    if (value === undefined || value === null) {
      if (min > 0) this.problem(`${where}: required.`)
      return []
    }
    if (!Array.isArray(value)) {
      this.problem(`${where}: must be a list.`)
      return []
    }
    if (value.length < min) this.problem(`${where}: ${value.length} given; at least ${min}.`)
    if (value.length > max) this.problem(`${where}: ${value.length} given; at most ${max}.`)
    return value.slice(0, max)
  }

  object(value: unknown, where: string): Record<string, unknown> | null {
    if (isRecord(value)) return value
    this.problem(`${where}: ${value === undefined || value === null ? 'required' : 'must be an object'}.`)
    return null
  }
}

function readFishbone(r: Reader, input: Record<string, unknown>): AiDiagramBody | null {
  const f = r.object(input.fishbone, 'fishbone')
  if (!f) return null
  const problem = r.text(f.problem, 'fishbone.problem', L.fishbone.problem)
  const seen = new Set<string>()
  const bones: FishboneBone[] = r.list(f.bones, 'fishbone.bones', L.fishbone.minBones, L.fishbone.maxBones).map((b, i) => {
    const where = `fishbone.bones[${i}]`
    const bone = r.object(b, where)
    if (!bone) return { category: '', causes: [] }
    const category = r.text(bone.category, `${where}.category`, L.fishbone.category)
    if (category && seen.has(category.toLowerCase())) r.problem(`${where}.category: "${category}" is given twice; put its causes on one bone.`)
    seen.add(category.toLowerCase())
    const causes: FishboneCause[] = r.list(bone.causes, `${where}.causes`, 1, L.fishbone.maxCauses).map((c, j) => {
      const at = `${where}.causes[${j}]`
      const cause = r.object(c, at)
      if (!cause) return { text: '', evidence: '', sources: [] }
      const said = r.text(cause.text, `${at}.text`, L.fishbone.cause)
      const evidence = r.text(cause.evidence, `${at}.evidence`, L.fishbone.evidence)
      return { text: said, evidence, sources: evidence ? r.evidence(evidence, `${at}.evidence`) : [] }
    })
    return { category, causes }
  })
  return { kind: 'fishbone', problem, bones }
}

function readFiveWhys(r: Reader, input: Record<string, unknown>): AiDiagramBody | null {
  const w = r.object(input.five_whys, 'five_whys')
  if (!w) return null
  const problem = r.text(w.problem, 'five_whys.problem', L.fiveWhys.problem)
  const steps: FiveWhysStep[] = r.list(w.steps, 'five_whys.steps', 2, L.fiveWhys.maxSteps).map((s, i) => {
    const where = `five_whys.steps[${i}]`
    const step = r.object(s, where)
    if (!step) return { because: '' }
    const because = r.text(step.because, `${where}.because`, L.fiveWhys.step)
    const evidence = r.text(step.evidence, `${where}.evidence`, L.fiveWhys.evidence, false)
    return evidence ? { because, evidence, sources: r.evidence(evidence, `${where}.evidence`) } : { because }
  })
  const actions = r.list(w.actions, 'five_whys.actions', 0, L.fiveWhys.maxActions).map((a, i) => r.text(a, `five_whys.actions[${i}]`, L.fiveWhys.action))
  return { kind: 'five-whys', problem, steps, actions }
}

function readFlowchart(r: Reader, input: Record<string, unknown>): AiDiagramBody | null {
  const f = r.object(input.flowchart, 'flowchart')
  if (!f) return null
  const ids = new Set<string>()
  const nodes: FlowNode[] = r.list(f.nodes, 'flowchart.nodes', L.flowchart.minNodes, L.flowchart.maxNodes).map((n, i) => {
    const where = `flowchart.nodes[${i}]`
    const node = r.object(n, where)
    if (!node) return { id: '', label: '', shape: 'step' }
    const id = r.text(node.id, `${where}.id`, L.flowchart.id)
    if (id && ids.has(id)) r.problem(`${where}.id: "${id}" is given twice; each node needs its own.`)
    ids.add(id)
    const label = r.text(node.label, `${where}.label`, L.flowchart.label)
    const shape = FLOW_NODE_SHAPES.includes(node.shape as FlowNodeShape) ? (node.shape as FlowNodeShape) : null
    if (!shape) r.problem(`${where}.shape: one of ${FLOW_NODE_SHAPES.join(', ')}.`)
    const out: FlowNode = { id, label, shape: shape ?? 'step' }
    if (node.highlight === true) out.highlight = true
    return out
  })
  const pairs = new Set<string>()
  const edges: FlowEdge[] = r.list(f.edges, 'flowchart.edges', 1, L.flowchart.maxEdges).map((e, i) => {
    const where = `flowchart.edges[${i}]`
    const edge = r.object(e, where)
    if (!edge) return { from: '', to: '' }
    const from = r.text(edge.from, `${where}.from`, L.flowchart.id)
    const to = r.text(edge.to, `${where}.to`, L.flowchart.id)
    const label = r.text(edge.label, `${where}.label`, L.flowchart.edgeLabel, false)
    if (from && !ids.has(from)) r.problem(`${where}.from: no node "${from}".`)
    if (to && !ids.has(to)) r.problem(`${where}.to: no node "${to}".`)
    if (from && from === to) r.problem(`${where}: a node cannot lead to itself.`)
    const pair = `${from}\u0000${to}`
    if (from && to && pairs.has(pair)) r.problem(`${where}: "${from}" to "${to}" is given twice.`)
    pairs.add(pair)
    return label ? { from, to, label } : { from, to }
  })
  for (const n of nodes) {
    if (!n.id) continue
    const outs = edges.filter((e) => e.from === n.id)
    if (nodes.length > 1 && outs.length === 0 && !edges.some((e) => e.to === n.id)) r.problem(`flowchart: node "${n.id}" is joined to nothing.`)
    if (n.shape === 'decision') {
      if (outs.length < 2) r.problem(`flowchart: decision "${n.id}" needs at least two ways out.`)
      else if (outs.some((e) => !e.label)) r.problem(`flowchart: name every way out of decision "${n.id}" by its answer (label).`)
    }
  }
  return { kind: 'flowchart', nodes, edges }
}

function readMindNodes(r: Reader, value: unknown, where: string, depth: number, max: number): MindNode[] {
  return r.list(value, where, depth === 1 ? 1 : 0, max).map((v, i) => {
    const at = `${where}[${i}]`
    const node = r.object(v, at)
    if (!node) return { label: '' }
    const label = r.text(node.label, `${at}.label`, L.mindMap.label)
    if (node.children === undefined || node.children === null) return { label }
    if (depth >= L.mindMap.maxDepth) {
      r.problem(`${at}.children: a mind map goes ${L.mindMap.maxDepth} levels deep at most.`)
      return { label }
    }
    const children = readMindNodes(r, node.children, `${at}.children`, depth + 1, L.mindMap.maxChildren)
    return children.length > 0 ? { label, children } : { label }
  })
}

function readMindMap(r: Reader, input: Record<string, unknown>): AiDiagramBody | null {
  const m = r.object(input.mind_map, 'mind_map')
  if (!m) return null
  const center = r.text(m.center, 'mind_map.center', L.mindMap.center)
  const branches = readMindNodes(r, m.branches, 'mind_map.branches', 1, L.mindMap.maxBranches)
  const size = mindMapSize(branches)
  if (size > L.mindMap.maxNodes) r.problem(`mind_map: ${size} nodes; ${L.mindMap.maxNodes} at most.`)
  return { kind: 'mind-map', center, branches }
}

const READERS: Record<AiDiagramKind, (r: Reader, input: Record<string, unknown>) => AiDiagramBody | null> = {
  fishbone: readFishbone,
  'five-whys': readFiveWhys,
  flowchart: readFlowchart,
  'mind-map': readMindMap,
}

/** The diagram the model sent, checked against the results of the conversation's queries; or every problem with it. */
export function readDiagram(input: unknown, results: readonly QueryResult[]): { diagram: AiDiagram } | { problems: string[] } {
  const r = new Reader(results)
  if (!isRecord(input)) return { problems: ['The input must be an object.'] }
  const kind = AI_DIAGRAM_KINDS.includes(input.kind as AiDiagramKind) ? (input.kind as AiDiagramKind) : null
  if (!kind) return { problems: [`kind: one of ${AI_DIAGRAM_KINDS.join(', ')}.`] }
  const title = r.text(input.title, 'title', L.title)
  const notes = r.text(input.notes, 'notes', L.notes, false)
  const body = READERS[kind](r, input)
  if (r.problems.length > 0 || !body) return { problems: r.problems }
  return { diagram: { ...body, title, ...(notes ? { notes } : {}) } }
}

// ---- The tool -----------------------------------------------------------------------------

export interface DiagramToolContext {
  db: Queryable
  conversationId: string
  turnId: string
  emit: (event: AiStreamEvent) => void
}

const failed = (tu: ToolUse, content: string): ToolOutcome => ({ result: { type: 'tool_result', tool_use_id: tu.id, is_error: true, content } })

async function draw(ctx: DiagramToolContext, tu: ToolUse): Promise<ToolOutcome> {
  // Only what the model has read: the conversation's queries kept so far (a query in the same step as the drawing is
  // not kept yet, so its figures are refused: the prompt has the queries run first).
  const read = readDiagram(tu.input, await conversationResults(ctx.db, ctx.conversationId))
  if ('problems' in read) {
    return failed(tu, ['Nothing was drawn. Fix these and call draw_diagram again:', ...read.problems.map((p) => `- ${p}`)].join('\n'))
  }
  const { diagram } = read
  const part: AiDiagramPart = { type: 'diagram', diagramId: randomUUID(), diagram }
  ctx.emit({ type: 'diagram', part })
  return {
    result: {
      type: 'tool_result',
      tool_use_id: tu.id,
      content: `Drawn: the ${AI_DIAGRAM_NAMES[diagram.kind].toLowerCase()} "${diagram.title}" is shown to the person as a card where you called the tool. Do not write it out again; say what it shows and what to do next.`,
    },
    store: async (tx) => {
      await tx.query(`INSERT INTO ai_diagrams (id, conversation_id, turn_id, tool_use_id, kind, diagram) VALUES ($1, $2, $3, $4, $5, $6::json)`, [
        part.diagramId,
        ctx.conversationId,
        ctx.turnId,
        tu.id,
        diagram.kind,
        JSON.stringify(diagram),
      ])
    },
  }
}

export function diagramToolHandlers(ctx: DiagramToolContext): Record<string, ToolHandler> {
  return { [DRAW_DIAGRAM_TOOL_NAME]: { run: (tu) => draw(ctx, tu) } }
}

// ---- The cards ----------------------------------------------------------------------------

/** The diagrams of a conversation's answers (of one, with `turnId`), by the tool call that drew each. */
export async function loadDiagramParts(q: Queryable, conversationId: string, turnId?: string): Promise<Map<string, AiDiagramPart>> {
  const { rows } = await q.query<{ id: string; toolUseId: string; diagram: AiDiagram }>(
    `SELECT id, tool_use_id AS "toolUseId", diagram FROM ai_diagrams WHERE conversation_id = $1 AND ($2::uuid IS NULL OR turn_id = $2)`,
    [conversationId, turnId ?? null],
  )
  return new Map(rows.map((r) => [r.toolUseId, { type: 'diagram', diagramId: r.id, diagram: r.diagram }]))
}
