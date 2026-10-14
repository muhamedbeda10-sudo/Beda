import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import type { AiMessagesResponse, AiStreamEvent } from '@qc/shared/ai'
import type { AiDiagramPart } from '@qc/shared/aiDiagram'
import { readDiagram } from '../src/ai/diagrams'
import { figuresIn, findEvidence } from '../src/ai/evidence'
import { TestApp } from './harness'
import { text } from './aiFake'
import { ask, setUp, type People } from './automationsKit'
import { systemOf, toolNames, toolUse } from './noticesKit'

// Diagrams the assistant draws (draw_diagram): a fishbone, a 5 Whys, a
// flowchart, a mind map, each checked and kept with the answer and shown as a
// card. A fishbone holds only what the data shows: every cause's figure must
// be one a query of the conversation returned. The model is the scripted
// stand-in.

const app = new TestApp()
let p: People

const FINDINGS = `SELECT * FROM (VALUES ('RF-03 reject %', 4.1, 1.2), ('Night shift share %', 61, 88)) v(finding, value, other)`
const runSql = (sql: string) => toolUse('run_sql', { purpose: 'Rejects by machine and shift', sql })
const draw = (input: unknown) => toolUse('draw_diagram', input)
const diagramEvents = (events: AiStreamEvent[]): AiDiagramPart[] => events.filter((e): e is Extract<AiStreamEvent, { type: 'diagram' }> => e.type === 'diagram').map((e) => e.part)

function lastResult(): Anthropic.Beta.BetaToolResultBlockParam {
  const messages = app.model.calls[app.model.calls.length - 1].params.messages
  const content = messages[messages.length - 1].content as Anthropic.Beta.BetaToolResultBlockParam[]
  return content[content.length - 1]
}

const FISHBONE = {
  kind: 'fishbone',
  title: 'Wavy edge',
  notes: 'Inspections 1–13 Oct.',
  fishbone: {
    problem: 'Wavy edge on RF-03',
    bones: [
      { category: 'Machine', causes: [{ text: 'RF-03 far above the others', evidence: '4.1% vs 1.2% avg' }] },
      { category: 'Man', causes: [{ text: 'Night shift', evidence: '61% of 88 defects' }] },
    ],
  },
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

describe('draw_diagram in the chat', () => {
  it('is a tool of every new conversation, with its part of the prompt', async () => {
    app.model.reply({ content: [text('Hi.')] })
    await ask(app, p.plain, 'Hello')
    expect(toolNames(app)).toContain('draw_diagram')
    const system = systemOf(app)
    expect(system).toContain('# Diagrams')
    expect(system).toContain('A fishbone holds only what the data shows, never a cause from your own knowledge or a guess')
  })

  it('draws a fishbone whose figures the queries returned, keeps it with the answer and names their query', async () => {
    app.model.reply({ content: [runSql(FINDINGS)] }, { content: [draw(FISHBONE)] }, { content: [text('RF-03 and the night shift stand out.')] })
    const res = await ask(app, p.plain, 'Draw a fishbone of the wavy edge')
    expect(res.status).toBe(200)
    const [card] = diagramEvents(res.events)
    expect(card.diagram).toEqual({
      kind: 'fishbone',
      title: 'Wavy edge',
      notes: 'Inspections 1–13 Oct.',
      problem: 'Wavy edge on RF-03',
      bones: [
        { category: 'Machine', causes: [{ text: 'RF-03 far above the others', evidence: '4.1% vs 1.2% avg', sources: ['Rejects by machine and shift'] }] },
        { category: 'Man', causes: [{ text: 'Night shift', evidence: '61% of 88 defects', sources: ['Rejects by machine and shift'] }] },
      ],
    })
    const sent = app.model.calls[2].params.messages.at(-1)!.content as Anthropic.Beta.BetaToolResultBlockParam[]
    expect(sent[0].is_error).toBeFalsy()
    expect(String(sent[0].content)).toContain('is shown to the person as a card')

    // The saved conversation shows the very card, in its place.
    const saved = await app.api<AiMessagesResponse>('GET', `/api/ai/conversations/${res.conversationId}/messages`, { token: p.plain.token })
    const answer = saved.body.messages.at(-1)!
    expect(answer.parts.map((x) => x.type)).toEqual(['query', 'diagram', 'text'])
    expect(answer.parts[1]).toEqual(card)
    // Kept as drawn.
    await expect(app.db.query(`UPDATE ai_diagrams SET kind = 'mind-map' WHERE id = $1`, [card.diagramId])).rejects.toThrow(/kept as drawn/)
  })

  it('refuses a fishbone cause whose figure no query returned, and draws nothing', async () => {
    const made = { ...FISHBONE, fishbone: { ...FISHBONE.fishbone, bones: [...FISHBONE.fishbone.bones, { category: 'Material', causes: [{ text: 'Supplier coils', evidence: '72% of defects' }, { text: 'Roll wear', evidence: 'worn' }] }] } }
    app.model.reply({ content: [runSql(FINDINGS)] }, { content: [draw(made)] }, { content: [text('I could not show that.')] })
    const res = await ask(app, p.plain, 'Draw a fishbone of the wavy edge')
    expect(diagramEvents(res.events)).toEqual([])
    const result = lastResult()
    expect(result.is_error).toBe(true)
    expect(String(result.content)).toContain('fishbone.bones[2].causes[0].evidence: "72" is in no query\'s result in this conversation.')
    expect(String(result.content)).toContain('a cause the data cannot show stays off the fishbone')
    expect(String(result.content)).toContain('fishbone.bones[2].causes[1].evidence: give the figure that shows it')
    expect((await app.db.query(`SELECT 1 FROM ai_diagrams WHERE conversation_id = $1`, [res.conversationId])).rowCount).toBe(0)
  })

  it('refuses a fishbone drawn before any query, whatever its figures', async () => {
    app.model.reply({ content: [draw(FISHBONE)] }, { content: [text('Let me check first.')] })
    const res = await ask(app, p.plain, 'Draw a fishbone of the wavy edge')
    expect(diagramEvents(res.events)).toEqual([])
    expect(String(lastResult().content)).toContain('"4.1", "1.2" are in no query\'s result')
  })
})

describe('the rules a diagram is checked by', () => {
  const results = [{ purpose: 'Q', rows: [['RF-03', 0.0412, 1284, '2026-10-02', null]] }]

  it('finds a figure as written, rounded, as a share in %, or inside a text', () => {
    expect(figuresIn('1,284 pieces, 4.1% on RF-03 (٣ days), −0.06 mm')).toEqual([
      { text: '1284', value: 1284, places: 0 },
      { text: '4.1', value: 4.1, places: 1 },
      { text: '03', value: 3, places: 0 },
      { text: '3', value: 3, places: 0 },
      { text: '0.06', value: 0.06, places: 2 },
    ])
    expect(findEvidence('4.1% of 1,284 on RF-03', results)).toEqual({ sources: ['Q'] })
    expect(findEvidence('0.04 share', results)).toEqual({ sources: ['Q'] })
    expect(findEvidence('held 2026-10-02', results)).toEqual({ sources: ['Q'] })
    expect(findEvidence('4.2%', results)).toEqual({ missing: ['4.2'] })
    expect(findEvidence('mostly at night', results)).toEqual({ missing: [], none: true })
  })

  it('takes a 5 Whys, a flowchart and a mind map as written, and says every problem at once', () => {
    const fiveWhys = readDiagram({ kind: 'five-whys', title: 'Late', five_whys: { problem: 'Shipped late', steps: [{ because: 'On hold', evidence: '1284 pieces' }, { because: 'No supervisor at night' }], actions: ['Approve a second one'] } }, results)
    expect(fiveWhys).toEqual({
      diagram: { kind: 'five-whys', title: 'Late', problem: 'Shipped late', steps: [{ because: 'On hold', evidence: '1284 pieces', sources: ['Q'] }, { because: 'No supervisor at night' }], actions: ['Approve a second one'] },
    })

    const flow = readDiagram(
      {
        kind: 'flowchart',
        title: 'Inspect',
        flowchart: {
          nodes: [
            { id: 'a', label: 'Start', shape: 'start' },
            { id: 'b', label: 'OK?', shape: 'decision' },
            { id: 'c', label: 'Done', shape: 'end', highlight: true },
            { id: 'a', label: 'Twice', shape: 'step' },
            { id: 'z', label: 'Alone', shape: 'blob' },
          ],
          edges: [
            { from: 'a', to: 'b' },
            { from: 'b', to: 'c' },
            { from: 'b', to: 'x' },
            { from: 'c', to: 'c' },
          ],
        },
      },
      [],
    )
    expect('problems' in flow && flow.problems).toEqual([
      'flowchart.nodes[3].id: "a" is given twice; each node needs its own.',
      'flowchart.nodes[4].shape: one of start, end, step, decision.',
      'flowchart.edges[2].to: no node "x".',
      'flowchart.edges[3]: a node cannot lead to itself.',
      'flowchart: name every way out of decision "b" by its answer (label).',
      'flowchart: node "z" is joined to nothing.',
    ])

    const mind = readDiagram({ kind: 'mind-map', title: 'Audit', mind_map: { center: 'RF-03', branches: [{ label: 'Machine', children: [{ label: 'Rolls', children: [{ label: 'Stand 6', children: [{ label: 'Too deep' }] }] }] }] } }, [])
    expect('problems' in mind && mind.problems).toEqual(['mind_map.branches[0].children[0].children[0].children: a mind map goes 3 levels deep at most.'])
    const ok = readDiagram({ kind: 'mind-map', title: 'Audit', mind_map: { center: 'RF-03', branches: [{ label: 'Machine', children: [{ label: 'Rolls' }] }, { label: 'People' }] } }, [])
    expect(ok).toEqual({ diagram: { kind: 'mind-map', title: 'Audit', center: 'RF-03', branches: [{ label: 'Machine', children: [{ label: 'Rolls' }] }, { label: 'People' }] } })

    expect(readDiagram({ kind: 'pie', title: 'x' }, [])).toEqual({ problems: ['kind: one of fishbone, five-whys, flowchart, mind-map.'] })
    const long = readDiagram({ kind: 'fishbone', title: 'x'.repeat(130), fishbone: { problem: 'P', bones: [{ category: 'Man', causes: [] }] } }, [])
    expect('problems' in long && long.problems).toEqual([
      'title: 130 characters; shorten it to 120 at most.',
      'fishbone.bones: 1 given; at least 2.',
      'fishbone.bones[0].causes: 0 given; at least 1.',
    ])
  })
})
