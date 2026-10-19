// ============================================================================
// §23 — what the tests of notices through the assistant share: the people
// (the owner, an administrator allowed to have notices written, one who is
// not, an inspector allowed — which an inspector can never use —, a plain
// inspector and supervisor, a viewer with no bell), machines and order lines
// to aim at, a notice made on the Notices page, the tool calls as the
// scripted model writes them, and what the model was sent back.
// ============================================================================

import { expect } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import type { SaveNoticeRequest } from '@qc/shared/api'
import type { AiStreamEvent } from '@qc/shared/ai'
import type { AiNoticePart } from '@qc/shared/noticeAssistant'
import type { Notice } from '@qc/shared/types'
import { calendarDay, type Session, type TestApp } from './harness'
import { KEY, grant } from './automationsKit'

export interface NoticePeople {
  /** The assistant's owner, an administrator: may have notices written whatever their row says. */
  owner: Session
  /** An administrator the owner allows to have notices written. */
  boss: Session
  /** An administrator given the assistant, not allowed to have notices written. */
  admin2: Session
  /** An inspector given the assistant. */
  insp: Session
  /** An inspector whose row allows notices: never in effect, as an inspector is no administrator. */
  inspFlag: Session
  /** A supervisor given the assistant. */
  sup: Session
  /** A viewer given the assistant: viewers have no bell. */
  viewer: Session
}

const ACCOUNTS: [keyof NoticePeople, string, string, string][] = [
  ['boss', 'boss', 'Boss Admin', 'admin'],
  ['admin2', 'admin2', 'Second Admin', 'admin'],
  ['insp', 'insp', 'Ivy Inspector', 'inspector'],
  ['inspFlag', 'inspflag', 'Ian Flagged', 'inspector'],
  ['sup', 'sup', 'Sam Supervisor', 'supervisor'],
  ['viewer', 'watch', 'Vic Viewer', 'viewer'],
]

/** A fresh database with the people, the key, two machines and two order lines. */
export async function setUpNotices(app: TestApp): Promise<NoticePeople> {
  await app.resetDatabase()
  const owner = await app.register('admin', 'Owner Admin')
  for (const [, username, name, role] of ACCOUNTS) {
    const made = await app.api('POST', '/api/users', { token: owner.token, body: { username, password: 'Password#1', name, role } })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
  }
  const people = { owner } as NoticePeople
  for (const [key, username] of ACCOUNTS) people[key] = await app.login(username)
  expect((await app.api('PUT', '/api/ai/key', { token: owner.token, body: { apiKey: KEY } })).status).toBe(200)
  await grant(app, owner, people.boss, { notices: true })
  await grant(app, owner, people.admin2)
  await grant(app, owner, people.insp)
  await grant(app, owner, people.inspFlag, { notices: true })
  await grant(app, owner, people.sup)
  await grant(app, owner, people.viewer)
  for (const machine of [
    { code: '58', name: 'A. Welding Line', line: 'LM4', displayName: '58-A. Welding Line-LM4', process: 'welding', factory: 'Factory 1' },
    { code: '48', name: 'Painting Line', line: 'LM4', displayName: '48-Painting Line-LM4', process: 'paint', factory: 'Factory 2' },
  ]) {
    expect((await app.api('POST', '/api/master/machines', { token: owner.token, body: machine })).status).toBe(201)
  }
  const imported = await app.api('POST', '/api/orders/import', {
    token: owner.token,
    body: {
      rows: [
        { lineKey: 'L-1', orderNumber: '20095-QC1-HYH', item: 'XL Light Beam', itemCode: '125185TA3', workCenterCode: '58', requiredQty: 2500, finishedQty: 0, customer: 'Beta Storage' },
        { lineKey: 'L-2', orderNumber: '20480-SMA', item: 'Shuttle Beam', itemCode: 'LB406015-5TA3', workCenterCode: '48', requiredQty: 1350, finishedQty: 0, customer: 'Alpha Racking' },
      ],
    },
  })
  expect(imported.status, JSON.stringify(imported.body)).toBeLessThan(300)
  return people
}

/** A notice as the Notices page saves it, with what the test changes. */
export function noticeBody(over: Partial<SaveNoticeRequest> = {}): SaveNoticeRequest {
  return {
    title: 'Check the weld start on every beam',
    body: 'Customer complaint on the last batch.',
    severity: 'warning',
    requiresAck: true,
    matchMode: 'all',
    validFrom: calendarDay(),
    validTo: null,
    targets: [],
    imageIds: [],
    fileIds: [],
    ...over,
  }
}

/** A notice made on the Notices page, by an administrator. */
export async function pageNotice(app: TestApp, as: Session, over: Partial<SaveNoticeRequest> = {}): Promise<Notice> {
  const res = await app.api<Notice>('POST', '/api/notices', { token: as.token, body: noticeBody(over) })
  expect(res.status, JSON.stringify(res.body)).toBe(201)
  return res.body
}

type Block = Anthropic.Beta.BetaContentBlock

let calls = 0
const toolId = () => `toolu_n${++calls}_${Math.random().toString(36).slice(2, 8)}`

/** A tool call as the scripted model writes it. */
export const toolUse = (name: string, input: unknown, id = toolId()): Block => ({ type: 'tool_use', id, name, input }) as Block
export const listNotices = (input: unknown = {}, id?: string) => toolUse('list_notices', input, id)
export const noticeDetails = (id: string, toolUseId?: string) => toolUse('notice_details', { id }, toolUseId)
export const findTargets = (input: unknown, id?: string) => toolUse('find_notice_targets', input, id)
export const proposeNotice = (input: unknown, id?: string) => toolUse('propose_notice_change', input, id)

/** The results the model was sent back after its last tool calls, in order. */
export function resultsOf(app: TestApp): Anthropic.Beta.BetaToolResultBlockParam[] {
  const call = app.model.calls[app.model.calls.length - 1]
  const last = call.params.messages[call.params.messages.length - 1]
  return last.content as Anthropic.Beta.BetaToolResultBlockParam[]
}

/** A result's text, parsed when it is JSON. */
export function resultJson<T = Record<string, unknown>>(r: Anthropic.Beta.BetaToolResultBlockParam): T {
  expect(r.is_error, String(r.content)).toBeFalsy()
  return JSON.parse(String(r.content)) as T
}

/** The tools of the model's last call, by name. */
export const toolNames = (app: TestApp): string[] => (app.model.calls[app.model.calls.length - 1].params.tools ?? []).map((t) => (t as { name: string }).name)

/** The system prompt of the model's last call. */
export const systemOf = (app: TestApp): string => (app.model.calls[app.model.calls.length - 1].params.system as { text: string }[])[0].text

/** The notice cards an answer streamed, in order. */
export const noticeEvents = (events: AiStreamEvent[]): AiNoticePart[] =>
  events.filter((e): e is Extract<AiStreamEvent, { type: 'notice' }> => e.type === 'notice').map((e) => e.part)
