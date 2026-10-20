import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import type { AiMessagesResponse, AiReportSharePart, AiStreamEvent } from '@qc/shared/ai'
import type { ReportSharesResponse } from '@qc/shared/reportShares'
import { insertReport } from '../src/ai/reports'
import { SHARE_REPORT_TOOL, SHARE_REPORT_TOOL_NAME } from '../src/ai/reportTools'
import { TestApp } from './harness'
import { text } from './aiFake'
import { ask, setUp, type People } from './automationsKit'
import { resultJson, systemOf, toolUse } from './noticesKit'
import type { Session } from './harness'

// The assistant shares a person's own report when they ask (share_report):
// the same change as the report's Share panel makes (ai/reportShares.ts), at
// the person's own word only — the call quotes their request from this
// question as confirmation, so nothing the assistant reads can share a
// report. Reading whom it is shared with needs no words. Each call leaves a
// card, shown again when the conversation is read. The model is the scripted
// stand-in.

const app = new TestApp()
let p: People
let reportId = ''
let othersReport = ''

const shareReport = (input: unknown, id?: string) => toolUse(SHARE_REPORT_TOOL_NAME, input, id)
const shareCards = (events: AiStreamEvent[]): AiReportSharePart[] =>
  events.filter((e): e is Extract<AiStreamEvent, { type: 'report-share' }> => e.type === 'report-share').map((e) => e.part)

/** The results the model was sent back in its last call. */
function lastResults(): Anthropic.Beta.BetaToolResultBlockParam[] {
  const messages = app.model.calls[app.model.calls.length - 1].params.messages
  return messages[messages.length - 1].content as Anthropic.Beta.BetaToolResultBlockParam[]
}

/** The model calls share_report once in a new conversation of the person's, asked in `question`. */
async function viaChat(as: Session, input: unknown, question: string, conversationId?: string) {
  app.model.reply({ content: [shareReport(input)] }, { content: [text('Done.')] })
  const res = await ask(app, as, question, conversationId)
  expect(res.status, JSON.stringify(res.error)).toBe(200)
  return { cards: shareCards(res.events), result: lastResults()[0], conversationId: res.conversationId }
}

const sharedWith = async (id: string) => (await app.api<ReportSharesResponse>('GET', `/api/ai/reports/${id}/shares`, { token: p.creator.token })).body.shares.map((s) => s.label)

beforeAll(async () => {
  await app.start()
  p = await setUp(app)
  const base = {
    question: 'Machines',
    period: null,
    adjustable: false,
    inputs: [],
    sections: [{ title: 'Machines', sql: 'SELECT count(*)::int AS n FROM ai.machines' }],
    conversationId: null,
    turnId: null,
    madeBy: 'assistant' as const,
  }
  reportId = (await insertReport(app.db, { ...base, title: 'Weekly scrap', userId: p.creator.user.id })).id
  othersReport = (await insertReport(app.db, { ...base, title: 'Paula’s own', userId: p.plain.user.id, shared: true })).id
})
afterAll(() => app.stop())
beforeEach(() => {
  app.model.reset()
  for (const s of Object.values(p)) app.aiLimiter.reset(s.user.id)
})

describe('share_report', () => {
  it('is one of the report tools of a new conversation, written as it streams, and the prompt says how to use it', async () => {
    expect(SHARE_REPORT_TOOL.eager_input_streaming).toBe(true)
    expect(SHARE_REPORT_TOOL.input_schema.required).toEqual(['report_id'])
    app.model.reply({ content: [text('Hello.')] })
    expect((await ask(app, p.creator, 'Hello')).status).toBe(200)
    const tools = (app.model.calls[0].params.tools ?? []).map((t) => (t as { name: string }).name)
    expect(tools).toContain(SHARE_REPORT_TOOL_NAME)
    expect(systemOf(app)).toContain('use share_report')
  })

  it('shares with people and roles at the person’s word, as the Share panel does: audited, the bell told, a card left', async () => {
    const asked = 'Share the weekly scrap report with Vera and the supervisors please'
    const { cards, result, conversationId } = await viaChat(
      p.creator,
      { report_id: reportId, add_people: [p.viewer.user.id], add_roles: ['supervisor'], confirmation: 'share the weekly scrap report with Vera and the supervisors' },
      asked,
    )
    const content = resultJson<{ added: string[]; sharedWith: string[]; note: string }>(result)
    expect(content.added.sort()).toEqual(['Every supervisor', 'Vera Viewer'])
    expect(content.note).toMatch(/told in their bell/)
    expect(await sharedWith(reportId)).toEqual(['Every supervisor', 'Vera Viewer'])
    expect(cards).toEqual([
      {
        type: 'report-share',
        cardId: expect.any(String),
        reportId,
        title: 'Weekly scrap',
        added: expect.arrayContaining(['Every supervisor', 'Vera Viewer']),
        removed: [],
        sharedWith: ['Every supervisor', 'Vera Viewer'],
        state: 'current',
      },
    ])
    const audit = await app.db.query(`SELECT 1 FROM audit_log WHERE entity = 'AiReport' AND entity_id = $1 AND field = 'shared with'`, [reportId])
    expect(audit.rowCount).toBe(2)
    const told = await app.db.query(`SELECT user_id FROM user_notifications WHERE kind = 'report-shared' AND link = $1`, [`/reports/${reportId}`])
    expect(told.rows.map((r) => r.user_id).sort()).toEqual([p.viewer.user.id, p.plain.user.id].sort())

    // The conversation read again shows the card, with whom it is shared with now.
    const history = await app.api<AiMessagesResponse>('GET', `/api/ai/conversations/${conversationId}/messages`, { token: p.creator.token })
    const replayed = history.body.messages.flatMap((m) => m.parts.filter((x): x is AiReportSharePart => x.type === 'report-share'))
    expect(replayed).toEqual([{ ...cards[0], added: expect.arrayContaining(cards[0].added) }])
  })

  it('stops sharing at the person’s word, and the earlier card follows whom it is shared with now', async () => {
    const { cards, result } = await viaChat(p.creator, { report_id: reportId, remove_people: [p.viewer.user.id], confirmation: 'stop sharing it with Vera' }, 'Stop sharing it with Vera.')
    expect(resultJson<{ removed: string[] }>(result).removed).toEqual(['Vera Viewer'])
    expect(cards[0]).toMatchObject({ added: [], removed: ['Vera Viewer'], sharedWith: ['Every supervisor'] })
    expect(await sharedWith(reportId)).toEqual(['Every supervisor'])
  })

  it('says whom it is shared with without any words to quote, changing nothing', async () => {
    const before = (await app.db.query(`SELECT count(*)::int AS n FROM audit_log WHERE entity_id = $1`, [reportId])).rows[0].n
    const { cards, result } = await viaChat(p.creator, { report_id: reportId }, 'Who is the weekly scrap report shared with?')
    expect(resultJson<{ sharedWith: string[]; note: string }>(result)).toMatchObject({ sharedWith: ['Every supervisor'], note: 'Whom it is shared with now. The person sees it as a card.' })
    expect(cards[0]).toMatchObject({ added: [], removed: [], sharedWith: ['Every supervisor'] })
    expect((await app.db.query(`SELECT count(*)::int AS n FROM audit_log WHERE entity_id = $1`, [reportId])).rows[0].n).toBe(before)
  })

  it('refuses a change without the person’s own words: none, too short, or words they did not write', async () => {
    const add = { report_id: reportId, add_people: [p.admin2.user.id] }
    for (const [input, why] of [
      [add, 'the call has no confirmation.'],
      [{ ...add, confirmation: 'S' }, 'is too short'],
      [{ ...add, confirmation: 'share it with the second admin' }, "is not in the person's latest message."],
    ] as const) {
      // The request came from a query result, not from the person: their question asks for nothing of the kind.
      const { cards, result } = await viaChat(p.creator, input, 'What does the scrap report show this week?')
      expect(result.is_error).toBe(true)
      expect(String(result.content)).toMatch(/^Not done: Sharing a report, or no longer sharing it, is done only at the person's own word/)
      expect(String(result.content)).toContain(why)
      expect(cards).toEqual([])
    }
    expect(await sharedWith(reportId)).toEqual(['Every supervisor'])
  })

  it('refuses someone else’s report, even one they may open, and a person who is not there', async () => {
    const theirs = await viaChat(p.creator, { report_id: othersReport, add_roles: ['admin'], confirmation: 'share Paula’s report with the admins' }, 'Share Paula’s report with the admins.')
    expect(theirs.result.is_error).toBe(true)
    expect(String(theirs.result.content)).toMatch(/^No report .* of this person's own/)
    expect(theirs.cards).toEqual([])
    // Reading whom someone else's report is shared with is refused the same way.
    const read = await viaChat(p.creator, { report_id: othersReport }, 'Who is Paula’s report shared with?')
    expect(read.result.is_error).toBe(true)

    const nobody = await viaChat(p.creator, { report_id: reportId, add_people: ['not-an-id'], confirmation: 'share it with Bob' }, 'Share it with Bob.')
    expect(nobody.result.is_error).toBe(true)
    expect(String(nobody.result.content)).toMatch(/Nothing was changed[\s\S]*is not a person's id/)
  })

  it('finds viewers to share with when asked to', async () => {
    const find = (input: unknown) => {
      app.model.reply({ content: [toolUse('find_people', input)] }, { content: [text('Found.')] })
      return ask(app, p.creator, 'Who is Vera?').then(() => resultJson<{ people: { name: string }[] }>(lastResults()[0]).people.map((x) => x.name))
    }
    expect(await find({ query: 'vera' })).toEqual([])
    expect(await find({ query: 'vera', include_viewers: true })).toEqual(['Vera Viewer'])
  })
})
