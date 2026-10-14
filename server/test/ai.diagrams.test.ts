import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import type { AiMessagesResponse, AiStreamEvent } from '@qc/shared/ai'
import type { AiDiagramPart } from '@qc/shared/aiDiagram'
import { checkDiagram, figureText, isAppLink } from '../src/ai/diagram'
import type { QueryRun } from '../src/ai/runQuery'
import { TestApp } from './harness'
import { text } from './aiFake'
import { ask, setUp, type People } from './automationsKit'
import { resultJson, systemOf, toolNames, toolUse } from './noticesKit'

// Diagrams the assistant draws (make_diagram), for everyone given the
// assistant: the model says what a diagram holds and the app lays it out.
// Every problem is told at once and nothing is kept; a figure on a box is
// written in by the server from a query run as the person's domains read;
// what passes is kept with the answer and shown as a card, live and in the
// history alike. The model is the scripted stand-in.

const app = new TestApp()
let p: People

const makeDiagram = (input: unknown, id?: string) => toolUse('make_diagram', input, id)
const diagramEvents = (events: AiStreamEvent[]): AiDiagramPart[] => events.filter((e): e is Extract<AiStreamEvent, { type: 'diagram' }> => e.type === 'diagram').map((e) => e.part)

/** The result the model was sent back for its last tool call. */
function lastResult(): Anthropic.Beta.BetaToolResultBlockParam {
  const messages = app.model.calls[app.model.calls.length - 1].params.messages
  const content = messages[messages.length - 1].content as Anthropic.Beta.BetaToolResultBlockParam[]
  return content[content.length - 1]
}

/** Pieces per machine, worked out from its code: 58 makes 116, 31 makes 62. */
const PIECES = { id: 'pieces', purpose: 'Defect pieces by machine', sql: `SELECT machine_code AS code, machine_code::int * 2 AS pieces FROM ai.machines ORDER BY machine_code DESC`, key: 'code', value: 'pieces', unit: 'pcs' }

const FISHBONE = {
  layout: 'fishbone',
  title: 'Twist on the roll formers, October',
  groups: [
    { id: 'machine', label: 'Machine' },
    { id: 'material', label: 'Material' },
    { id: 'environment', label: 'Environment' },
  ],
  nodes: [
    { id: 'effect', label: 'Twist in the profile', tone: 'bad' },
    { id: 'm58', label: 'Machine 58', group: 'machine', tone: 'bad', figure: { source: 'pieces', key: '58' }, link: '/history?machine=58' },
    { id: 'm31', label: 'Machine 31', group: 'machine', figure: { source: 'pieces', key: 31 } },
    { id: 'roll', label: 'Worn rolls', parent: 'm58', hypothesis: true },
    { id: 'coil', label: 'Coil thickness varies', group: 'material', hypothesis: true },
    { id: 'heat', label: 'Heat in the hall', group: 'environment', hypothesis: true },
  ],
  figures: [PIECES, { id: 'spare', purpose: 'Never used', sql: 'SELECT nonsense FROM nowhere', key: 'a', value: 'b' }],
}

/** The model calls make_diagram once (in a new conversation of the person's unless given). */
async function viaChat(input: unknown, as = p.plain, conversationId?: string) {
  app.model.reply({ content: [makeDiagram(input)] }, { content: [text('Here is the diagram.')] })
  const res = await ask(app, as, 'Draw me a fishbone of the twist', conversationId)
  expect(res.status, JSON.stringify(res.error)).toBe(200)
  return { cards: diagramEvents(res.events), result: lastResult(), conversationId: res.conversationId }
}

beforeAll(async () => {
  await app.start()
  p = await setUp(app)
})
afterAll(() => app.stop())
beforeEach(() => {
  app.model.reset()
  for (const s of Object.values(p)) app.aiLimiter.reset(s.user.id)
})

describe('make_diagram', () => {
  it('is in every new conversation, loaded on demand, with its part of the prompt', async () => {
    app.model.reply({ content: [text('Hi.')] })
    await ask(app, p.plain, 'Hello')
    expect(toolNames(app)).toContain('make_diagram')
    const tool = app.model.calls[0].params.tools!.find((t) => (t as { name: string }).name === 'make_diagram') as Anthropic.Beta.BetaTool
    expect(tool.defer_loading).toBe(true)
    const system = systemOf(app)
    const section = system.slice(system.indexOf('# Diagrams'), system.indexOf('\n#', system.indexOf('# Diagrams') + 2))
    expect(section).toContain('draw it with make_diagram')
    expect(section).toContain('Never write a figure of the record into a label')
    expect(section).toContain('is marked hypothesis: true')
    // Where to look for the 6M is said only of what the person can read: inspections, not the coil register.
    expect(section).toContain('ai.dimension_measurements')
    expect(section).not.toContain('ai.coils')
  })

  it('draws the diagram as checked, writes its figures in from its query, and keeps it with the answer', async () => {
    const { cards, result, conversationId } = await viaChat(FISHBONE)
    const told = resultJson<{ drawn: boolean; figures: { box: string; figure: string }[]; hypotheses: number; notes: string[] }>(result)
    expect(told.drawn).toBe(true)
    expect(told.figures).toEqual([
      { box: 'm58', figure: '116 pcs' },
      { box: 'm31', figure: '62 pcs' },
    ])
    expect(told.hypotheses).toBe(3)
    expect(told.notes.join(' ')).toContain('Figure queries no box uses were not run: "spare"')

    expect(cards).toHaveLength(1)
    const { spec } = cards[0]
    expect(spec.layout).toBe('fishbone')
    expect(spec.rtl).toBe(false)
    expect(spec.nodes.find((n) => n.id === 'm58')).toEqual({
      id: 'm58',
      label: 'Machine 58',
      shape: 'step',
      tone: 'bad',
      group: 'machine',
      figure: { text: '116 pcs', value: 116, source: 'pieces' },
      link: '/history?machine=58',
    })
    // A sub-cause sits on its cause's bone.
    expect(spec.nodes.find((n) => n.id === 'roll')).toMatchObject({ parent: 'm58', group: 'machine', hypothesis: true })
    expect(spec.sources).toEqual([{ id: 'pieces', purpose: 'Defect pieces by machine', sql: PIECES.sql, rows: 2, ms: expect.any(Number) }])

    // The saved conversation shows the same card, from what was kept.
    const saved = await app.api<AiMessagesResponse>('GET', `/api/ai/conversations/${conversationId}/messages`, { token: p.plain.token })
    const parts = saved.body.messages.at(-1)!.parts
    expect(parts.find((x) => x.type === 'diagram')).toEqual(cards[0])
    const kept = await app.db.query(`SELECT user_id AS "userId" FROM ai_diagrams WHERE id = $1`, [cards[0].diagramId])
    expect(kept.rows).toEqual([{ userId: p.plain.user.id }])
    // Kept as drawn: never changed or deleted.
    await expect(app.db.query(`UPDATE ai_diagrams SET spec = '{}' WHERE id = $1`, [cards[0].diagramId])).rejects.toThrow(/append-only/)
    await expect(app.db.query(`DELETE FROM ai_diagrams WHERE id = $1`, [cards[0].diagramId])).rejects.toThrow()
  })

  it('tells the model every problem at once and keeps nothing', async () => {
    const before = (await app.db.query(`SELECT count(*)::int AS n FROM ai_diagrams`)).rows[0].n
    const { cards, result } = await viaChat({
      ...FISHBONE,
      nodes: [
        { id: 'effect', label: 'Twist' },
        { id: 'other', label: 'A second effect' },
        { id: 'm58', label: 'Machine 58', group: 'machines', figure: { source: 'pieces', key: '99' } },
        { id: 'm31', label: 'Machine 31', group: 'machine', figure: { source: 'pieces', key: '31' }, hypothesis: true },
        { id: 'roll', label: 'Rolls', group: 'machine', link: 'https://evil.example' },
        { id: 'roll', label: 'Rolls again', group: 'machine' },
      ],
      edges: [{ from: 'effect', to: 'm58' }],
    })
    expect(cards).toEqual([])
    expect(result.is_error).toBe(true)
    const said = String(result.content)
    expect(said).toContain('Nothing was drawn. Fix these and call make_diagram again')
    expect(said).toContain('nodes[2].group: "machines" is not one of the bones ("machine", "material", "environment")')
    expect(said).toContain('nodes[3]: a box with a figure from the data is not a hypothesis')
    expect(said).toContain('nodes[4].link: a page of this application')
    expect(said).toContain('nodes[5].id: "roll" is used twice')
    expect(said).toContain('edges: a fishbone takes none')
    expect(said).toContain('a fishbone has one effect; 3 boxes have no group and no parent ("effect", "other", "m58")')
    expect((await app.db.query(`SELECT count(*)::int AS n FROM ai_diagrams`)).rows[0].n).toBe(before)
  })

  it('says which keys a figure query has when a box names one it has not', async () => {
    const { result } = await viaChat({ ...FISHBONE, nodes: FISHBONE.nodes.map((n) => (n.id === 'm31' ? { ...n, figure: { source: 'pieces', key: '77' } } : n)) })
    expect(String(result.content)).toContain('node "m31".figure: no row of "pieces" has code = "77" (it has "58", "31")')
  })

  it("runs a figure's query as the person's domains read: no more", async () => {
    const { result } = await viaChat({
      ...FISHBONE,
      figures: [{ ...PIECES, sql: `SELECT coil_number AS code, 1 AS pieces FROM ai.coils` }],
    })
    expect(result.is_error).toBe(true)
    expect(String(result.content)).toMatch(/figures "pieces": the query failed: .*(permission|not among)/i)
  })

  it('reads an Arabic diagram right to left', async () => {
    const { cards } = await viaChat({
      layout: 'flow',
      title: 'مسار التفتيش على خط التشكيل',
      nodes: [
        { id: 'a', label: 'بداية الوردية', shape: 'terminal' },
        { id: 'b', label: 'فحص أول قطعة', shape: 'inspection' },
        { id: 'c', label: 'مطابق؟', shape: 'decision' },
        { id: 'd', label: 'تشغيل', shape: 'step' },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'c', to: 'd', label: 'نعم' },
        { from: 'c', to: 'b', label: 'لا', dashed: true },
      ],
    })
    expect(cards).toHaveLength(1)
    expect(cards[0].spec).toMatchObject({ layout: 'flow', direction: 'across', rtl: true })
    expect(cards[0].spec.edges[3]).toEqual({ from: 'c', to: 'b', label: 'لا', dashed: true })
  })
})

describe('checkDiagram', () => {
  const noRun = async (): Promise<QueryRun> => {
    throw new Error('no query should run')
  }
  const errorsOf = async (input: unknown) => {
    const r = await checkDiagram(input, noRun)
    return 'errors' in r ? r.errors : []
  }

  it('holds a tree to one root, no loop, and parents that are boxes', async () => {
    expect(
      await errorsOf({
        layout: 'tree',
        title: '5 whys',
        nodes: [
          { id: 'a', label: 'Problem' },
          { id: 'b', label: 'Why 1', parent: 'c' },
          { id: 'c', label: 'Why 2', parent: 'b' },
        ],
      }),
    ).toEqual(['node "b": its parents go round in a loop; a tree has none.'])
    expect(
      await errorsOf({
        layout: 'tree',
        title: '5 whys',
        nodes: [
          { id: 'a', label: 'Problem' },
          { id: 'b', label: 'Why 1' },
          { id: 'c', label: 'Why 2', parent: 'z' },
        ],
      }),
    ).toEqual(['nodes: a tree has one root; 2 boxes have no parent ("a", "b"). Put them under one box.', 'node "c".parent: "z" is no box of the diagram.'])
  })

  it('holds a swimlane to its lanes and its arrows to boxes, once each, never to themselves', async () => {
    expect(
      await errorsOf({
        layout: 'swimlane',
        title: 'Hold release',
        groups: [
          { id: 'qc', label: 'QC' },
          { id: 'prod', label: 'Production' },
        ],
        nodes: [
          { id: 'a', label: 'Find defect', group: 'qc' },
          { id: 'b', label: 'Rework' },
          { id: 'c', label: 'Release', group: 'qc', shape: 'circle' },
        ],
        edges: [
          { from: 'a', to: 'b' },
          { from: 'a', to: 'b' },
          { from: 'b', to: 'b' },
          { from: 'b', to: 'x' },
        ],
      }),
    ).toEqual([
      'nodes[1].group: every box of a swimlane is in a lane; give it one.',
      'nodes[2].shape: one of step, decision, terminal, inspection, store, document, note.',
      'edges[1]: a second arrow from "a" to "b"; give one arrow both labels.',
      'edges[2]: an arrow from a box to itself; draw a rework loop through the step it returns to.',
      'edges[3]: "x" is no box of the diagram.',
    ])
  })

  it('takes the names the model may give a layout, and keeps labels short', async () => {
    const r = await checkDiagram(
      {
        layout: 'SIPOC',
        title: 'Painting',
        groups: [
          { id: 's', label: 'Suppliers' },
          { id: 'c', label: 'Customers' },
        ],
        nodes: [
          { id: 1, label: 'Powder supplier '.repeat(10), group: 's', shape: 'decision' },
          { id: 2, label: 'Assembly', group: 'c' },
        ],
      },
      noRun,
    )
    if ('errors' in r) throw new Error(r.errors.join('\n'))
    expect(r.spec.layout).toBe('columns')
    expect(r.spec.nodes[0]).toMatchObject({ id: '1', shape: 'step' })
    expect(Array.from(r.spec.nodes[0].label)).toHaveLength(80)
    expect(r.spec.nodes[0].label.endsWith('…')).toBe(true)
    expect(r.notes[0]).toContain('Labels longer than 80 characters were cut ("1")')
  })

  it('writes figures as people read them', () => {
    expect(figureText(1284, 'pcs', undefined)).toBe('1,284 pcs')
    expect(figureText(12.345, '%', undefined)).toBe('12.35%')
    expect(figureText(3, 'h', 1)).toBe('3.0 h')
    expect(figureText(0.5, '', undefined)).toBe('0.5')
  })

  it('lets a box open only a page of this application', () => {
    expect(isAppLink('/history?session=1')).toBe(true)
    expect(isAppLink('//evil.example')).toBe(false)
    expect(isAppLink('/..//evil.example')).toBe(false)
    expect(isAppLink('https://evil.example')).toBe(false)
    expect(isAppLink('javascript:alert(1)')).toBe(false)
    expect(isAppLink('/a b')).toBe(false)
  })
})
