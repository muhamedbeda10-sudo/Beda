import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest'
import type { ApiErrorBody } from '@qc/shared/api'
import type { AiAccessListResponse, AiMessagesResponse } from '@qc/shared/ai'
import type { AiNoticeApplyResponse, AiNoticePart } from '@qc/shared/noticeAssistant'
import type { Notice, NoticeAdminRow, NoticeFile } from '@qc/shared/types'
import type Anthropic from '@anthropic-ai/sdk'
import { TestApp, factoryDay, type Session } from './harness'
import { text } from './aiFake'
import { ask, grant } from './automationsKit'
import { noticeToolHandlers } from '../src/noticeAssistant/tools'
import {
  findTargets,
  noticeBody,
  noticeEvents,
  pageNotice,
  proposeNotice,
  resultJson,
  resultsOf,
  setUpNotices,
  toolNames,
  type NoticePeople,
} from './noticesKit'

// §23 — an administrator the owner allows (the owner implicitly) can have the
// assistant write a notice: a new one, a change, a withdrawal or a deletion.
// Each is a card that shows what will go out and to whom, and nothing changes
// until the person who asked presses its button — then the notice is written
// exactly as the Notices page writes it, as them. The person's role is read
// again at every call and every press. The model is the scripted stand-in.

const app = new TestApp()
let p: NoticePeople
let today: string

/** The draft of a notice as the model writes it: the page's fields, targets by kind and value only. */
function draft(over: Record<string, unknown> = {}) {
  return {
    title: 'Check the weld start on every beam',
    body: 'Customer complaint on the last batch.',
    severity: 'warning',
    requiresAck: true,
    matchMode: 'all',
    validFrom: today,
    validTo: null,
    targets: [
      { kind: 'machine', value: '58' },
      { kind: 'role', value: 'inspector' },
    ],
    ...over,
  }
}

interface Proposed {
  part: AiNoticePart | undefined
  result: ReturnType<typeof resultsOf>[number]
  conversationId: string
  doneParts: AiNoticePart[]
}

/** The model proposes a card in the person's conversation (a new one unless given); the card streamed, and what the model was told. */
async function proposeInChat(as: Session, input: unknown, conversationId?: string): Promise<Proposed> {
  app.model.reply({ content: [text('Here is the card.'), proposeNotice(input)] }, { content: [text('The card is ready: press its button to go ahead.')] })
  const res = await ask(app, as, 'Put out a notice', conversationId)
  expect(res.status, JSON.stringify(res.error)).toBe(200)
  const parts = noticeEvents(res.events)
  expect(parts.length).toBeLessThanOrEqual(1)
  return {
    part: parts[0],
    result: resultsOf(app)[0],
    conversationId: res.conversationId,
    doneParts: (res.done?.message.parts ?? []).filter((x): x is AiNoticePart => x.type === 'notice'),
  }
}

const press = (as: Session, id: string, what: 'apply' | 'discard') => app.api<AiNoticeApplyResponse | ApiErrorBody>('POST', `/api/ai/notice-proposals/${id}/${what}`, { token: as.token })
const applied = async (as: Session, id: string) => {
  const res = await press(as, id, 'apply')
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return (res.body as AiNoticeApplyResponse).part
}
const refusal = (res: { body: unknown }) => (res.body as ApiErrorBody).error as { code: string; message: string; details?: { part: AiNoticePart } }

/** The notice as the administrator's list has it, without what differs between two notices made alike. */
async function adminRow(id: string): Promise<Partial<NoticeAdminRow> | undefined> {
  const rows = (await app.api<NoticeAdminRow[]>('GET', '/api/notices/admin', { token: p.owner.token })).body
  const row = rows.find((r) => r.id === id)
  if (!row) return undefined
  const { id: _id, createdAt: _c, updatedAt: _u, withdrawnAt, ...rest } = row
  return { ...rest, withdrawnAt: withdrawnAt ? 'set' : withdrawnAt }
}

/** A notice's audit entries, oldest first, without their ids and times. */
async function auditOf(noticeId: string) {
  const { rows } = await app.db.query(
    `SELECT action, entity, field, old_value AS "oldValue", new_value AS "newValue", user_id AS "userId", user_name AS "userName"
       FROM audit_log WHERE entity = 'Notice' AND entity_id = $1 ORDER BY id`,
    [noticeId],
  )
  return rows
}

/** A conversation's notice cards as its history shows them now. */
async function historyCards(as: Session, conversationId: string): Promise<AiNoticePart[]> {
  const res = await app.api<AiMessagesResponse>('GET', `/api/ai/conversations/${conversationId}/messages`, { token: as.token })
  expect(res.status).toBe(200)
  return res.body.messages.flatMap((m) => m.parts.filter((x): x is AiNoticePart => x.type === 'notice'))
}

const noticeCount = async (title: string) => (await app.db.query(`SELECT 1 FROM notices WHERE title = $1 AND deleted_at IS NULL`, [title])).rowCount

beforeAll(async () => {
  await app.start()
  p = await setUpNotices(app)
  today = factoryDay()
})
afterAll(() => app.stop())
beforeEach(() => {
  app.model.reset()
  for (const s of Object.values(p)) app.aiLimiter.reset(s.user.id)
})

describe('§23 who may have notices written', () => {
  it('stores the permission per person, the owner holding it implicitly, and audits it', async () => {
    const list = (await app.api<AiAccessListResponse>('GET', '/api/ai/access', { token: p.owner.token })).body.people
    const flag = (s: Session) => list.find((x) => x.userId === s.user.id)?.notices
    expect([flag(p.owner), flag(p.boss), flag(p.admin2), flag(p.insp), flag(p.inspFlag)]).toEqual([true, true, false, false, true])
    // Left out of a change, it stays as it was.
    expect((await grant(app, p.owner, p.boss, { monthlyCapUsd: 40 })).notices).toBe(true)
    const created = await app.db.query<{ newValue: string }>(`SELECT new_value AS "newValue" FROM audit_log WHERE entity = 'AiAccess' AND entity_id = $1 AND action = 'create'`, [p.boss.user.id])
    expect(created.rows[0].newValue).toMatch(/; may manage notices$/)
    await grant(app, p.owner, p.admin2, { notices: true })
    await grant(app, p.owner, p.admin2, { notices: false })
    const changes = await app.db.query(`SELECT field, old_value AS "oldValue", new_value AS "newValue" FROM audit_log WHERE entity = 'AiAccess' AND entity_id = $1 AND action = 'update' ORDER BY id`, [p.admin2.user.id])
    expect(changes.rows).toEqual([
      { field: 'notices', oldValue: 'may not manage', newValue: 'may manage' },
      { field: 'notices', oldValue: 'may manage', newValue: 'may not manage' },
    ])
    // Only the owner gives it, as everything about access.
    expect((await app.api('PUT', `/api/ai/access/${p.insp.user.id}`, { token: p.boss.token, body: { enabled: true, domains: ['inspection'], monthlyCapUsd: 50, notices: true } })).status).toBe(404)
  })

  it('gives the writing tools to administrators allowed only, and refuses a press from anyone else', async () => {
    // An administrator not allowed, and an inspector whose row allows it: no writing tools; a call to one is unknown.
    for (const who of [p.admin2, p.inspFlag]) {
      const { result } = await proposeInChat(who, { action: 'create', draft: draft() })
      expect(toolNames(app)).toEqual(['run_sql', 'tool_search_tool_bm25', 'list_notices', 'notice_details', 'find_people', 'propose_task', 'my_tasks', 'update_playbook', 'make_diagram', 'list_saved_tables', 'save_table', 'update_saved_table', 'refresh_saved_table', 'remove_saved_table'])
      expect(result).toMatchObject({ is_error: true, content: 'Unknown tool "propose_notice_change". The tools are "run_sql", "list_notices", "notice_details", "find_people", "propose_task", "my_tasks", "update_playbook", "make_diagram", "list_saved_tables", "save_table", "update_saved_table", "refresh_saved_table", "remove_saved_table".' })
    }
    expect((await app.db.query(`SELECT 1 FROM ai_notice_proposals`)).rowCount).toBe(0)

    const { part } = await proposeInChat(p.boss, { action: 'create', draft: draft({ title: 'Pressed by whom' }) })
    expect(part).toMatchObject({ ok: true, state: 'proposed' })
    for (const who of [p.admin2, p.inspFlag, p.insp, p.viewer]) {
      const res = await press(who, part!.proposalId, 'apply')
      expect(res.status, who.user.name).toBe(403)
      expect(refusal(res).message).toMatch(/^Only an administrator the assistant's owner allows/)
      expect((await press(who, part!.proposalId, 'discard')).status).toBe(403)
    }
    // The owner may, but a card is pressed by the person who asked only.
    expect((await press(p.owner, part!.proposalId, 'apply')).status).toBe(404)
    expect(await noticeCount('Pressed by whom')).toBe(0)
    expect((await applied(p.boss, part!.proposalId)).state).toBe('applied')
  })

  it('stops the tools and the button the moment the permission goes, or the person stops being an administrator', async () => {
    const pending = await proposeInChat(p.boss, { action: 'create', draft: draft({ title: 'Taken back' }) })
    const conversationId = pending.conversationId
    const loseIt = [
      { take: () => grant(app, p.owner, p.boss, { notices: false }), give: () => grant(app, p.owner, p.boss, { notices: true }) },
      {
        take: () => app.api('PATCH', `/api/users/${p.boss.user.id}`, { token: p.owner.token, body: { role: 'supervisor' } }),
        give: () => app.api('PATCH', `/api/users/${p.boss.user.id}`, { token: p.owner.token, body: { role: 'admin' } }),
      },
    ]
    for (const { take, give } of loseIt) {
      await take()
      try {
        const again = await proposeInChat(p.boss, { action: 'create', draft: draft({ title: 'Not now' }) }, conversationId)
        expect(again.result).toMatchObject({ is_error: true, content: expect.stringMatching(/^Not allowed/) })
        expect(again.part).toBeUndefined()
        app.model.reply({ content: [findTargets({ kind: 'machine' })] }, { content: [text('Not allowed.')] })
        await ask(app, p.boss, 'Which machines?', conversationId)
        expect(resultsOf(app)[0]).toMatchObject({ is_error: true, content: expect.stringMatching(/^Not allowed/) })
        expect((await press(p.boss, pending.part!.proposalId, 'apply')).status).toBe(403)
      } finally {
        await give()
      }
    }
    expect(await noticeCount('Not now')).toBe(0)
    expect((await applied(p.boss, pending.part!.proposalId)).state).toBe('applied')
    // The owner needs no permission of their row: an administrator, they may.
    const owners = await proposeInChat(p.owner, { action: 'create', draft: draft({ title: 'From the owner' }) })
    expect((await applied(p.owner, owners.part!.proposalId)).appliedByName).toBe('Owner Admin')
  })
})

describe('§23 finding what a notice can be aimed at', () => {
  it('looks values up where the Notices page does, the order sheet only with a query', async () => {
    app.model.reply(
      {
        content: [
          findTargets({ kind: 'machine' }),
          findTargets({ kind: 'user', query: 'ivy' }),
          findTargets({ kind: 'role' }),
          findTargets({ kind: 'order-number' }),
          findTargets({ kind: 'order-number', query: '2009' }),
          findTargets({ kind: 'customer', query: 'alpha' }),
          findTargets({ kind: 'order-line', query: '20480' }),
          findTargets({ kind: 'factory' }),
          findTargets({ kind: 'planet' }),
        ],
      },
      { content: [text('Found them.')] },
    )
    await ask(app, p.boss, 'What can I aim at?')
    const [machines, users, roles, noQuery, orders, customers, lines, factories, bad] = resultsOf(app)
    expect(resultJson(machines).values).toEqual([
      { value: '48', label: '48-Painting Line-LM4', detail: 'Factory 2' },
      { value: '58', label: '58-A. Welding Line-LM4', detail: 'Factory 1' },
    ])
    expect(resultJson(users).values).toEqual([{ value: p.insp.user.id, label: 'Ivy Inspector', detail: 'insp · inspector' }])
    // Viewers receive no notices: not a role to aim at.
    expect((resultJson(roles).values as { value: string }[]).map((r) => r.value)).toEqual(['inspector', 'supervisor', 'admin'])
    expect(noQuery).toMatchObject({ is_error: true, content: expect.stringMatching(/^Give query/) })
    expect(resultJson(orders).values).toEqual([{ value: '20095-QC1-HYH', label: '20095-QC1-HYH', detail: 'Beta Storage · 1 line · machine 58' }])
    expect(resultJson(customers).values).toEqual([{ value: 'Alpha Racking', label: 'Alpha Racking', detail: '1 order line' }])
    expect(resultJson(lines).values).toEqual([{ value: expect.any(String), label: '20480-SMA · Shuttle Beam (LB406015-5TA3)', detail: 'machine 48 · line L-2' }])
    expect((resultJson(factories).values as { value: string }[]).map((f) => f.value)).toEqual(['Factory 1', 'Factory 2'])
    expect(bad).toMatchObject({ is_error: true, content: expect.stringMatching(/^Fix these and call find_notice_targets again:\n- kind: /) })
  })
})

describe('§23 a card applied writes the notice exactly as the Notices page does', () => {
  let conversationId = ''
  let viaCard: Notice
  let viaPage: Notice

  it('shows a new notice as a card, with its labels and reach, and writes nothing until Publish', async () => {
    const before = (await app.db.query(`SELECT count(*)::int AS n FROM notices`)).rows[0].n
    const proposed = await proposeInChat(p.boss, { action: 'create', draft: draft({ targets: [{ kind: 'machine', value: ' 58 ' }, { kind: 'role', value: 'inspector' }, { kind: 'order-number', value: '20095-qc1-hyh' }] }) })
    conversationId = proposed.conversationId
    expect(proposed.part).toEqual({
      type: 'notice',
      proposalId: expect.any(String),
      ok: true,
      action: 'create',
      draft: {
        title: 'Check the weld start on every beam',
        body: 'Customer complaint on the last batch.',
        severity: 'warning',
        requiresAck: true,
        matchMode: 'all',
        validFrom: today,
        validTo: null,
        // The values as the sources write them, the labels as people read them: never the model's.
        targets: [
          { kind: 'machine', value: '58', label: '58-A. Welding Line-LM4' },
          { kind: 'role', value: 'inspector', label: 'Inspector' },
          { kind: 'order-number', value: '20095-QC1-HYH', label: '20095-QC1-HYH' },
        ],
      },
      reach: { everyone: false, people: null, placeBound: true },
      state: 'proposed',
    })
    // The answer ends with the same card, and the model is told what it shows and that nothing happened yet.
    expect(proposed.doneParts).toEqual([proposed.part])
    const told = resultJson(proposed.result)
    expect(told).toMatchObject({
      proposed: true,
      proposalId: proposed.part!.proposalId,
      action: 'create',
      notice: { title: 'Check the weld start on every beam', severity: 'warning', requiresAck: true, days: `from ${today}, until withdrawn`, matchMode: 'all' },
      reach: 'Whoever works at the place it names, when they meet it there',
    })
    expect(told.note).toMatch(/^Shown to the person as a card with Publish and Discard\. Nothing changes until they press Publish: say so, and never say the notice is published\./)
    expect((await app.db.query(`SELECT count(*)::int AS n FROM notices`)).rows[0].n).toBe(before)
  })

  it('publishes it as the person who pressed the button, exactly like the page’s own', async () => {
    const [card] = await historyCards(p.boss, conversationId)
    const part = await applied(p.boss, card.proposalId)
    expect(part).toMatchObject({ state: 'applied', noticeId: expect.any(String), appliedByName: 'Boss Admin', appliedAt: expect.any(String) })
    viaCard = (await app.api<Notice[]>('GET', '/api/notices/admin', { token: p.owner.token })).body.find((x) => x.id === part.noticeId)!
    viaPage = await pageNotice(app, p.boss, { targets: card.draft!.targets })
    expect(await adminRow(viaCard.id)).toEqual(await adminRow(viaPage.id))
    expect(viaCard.createdByName).toBe('Boss Admin')
    // The same audit entry, as the same person: an entry made from a card reads like one made on the page.
    expect(await auditOf(viaCard.id)).toEqual(await auditOf(viaPage.id))
    expect(await auditOf(viaCard.id)).toEqual([{ action: 'create', entity: 'Notice', field: null, oldValue: null, newValue: null, userId: p.boss.user.id, userName: 'Boss Admin' }])
    // The history shows the card as it stands now; a second press is told it was applied, with the card.
    expect(await historyCards(p.boss, conversationId)).toEqual([part])
    const again = await press(p.boss, card.proposalId, 'apply')
    expect(again.status).toBe(409)
    expect(refusal(again)).toMatchObject({ code: 'conflict', message: 'This card was already applied.', details: { part } })
  })

  it('applies a change field by field, as the page saves it', async () => {
    const change = { title: 'Check the weld start on every beam, both ends', severity: 'critical' as const, validTo: factoryDay(7) }
    const proposed = await proposeInChat(p.boss, { action: 'update', noticeId: viaCard.id, draft: draft({ ...change, targets: [{ kind: 'machine', value: '58' }, { kind: 'role', value: 'inspector' }, { kind: 'order-number', value: '20095-QC1-HYH' }] }) }, conversationId)
    expect(proposed.part).toMatchObject({ ok: true, action: 'update', noticeId: viaCard.id, state: 'proposed', draft: { ...change, validFrom: today }, before: { title: 'Check the weld start on every beam', severity: 'warning', validTo: null } })
    expect(resultJson(proposed.result).note).toMatch(/card with Apply changes and Discard.*never say the notice is changed/)
    await applied(p.boss, proposed.part!.proposalId)
    const put = await app.api<Notice>('PUT', `/api/notices/${viaPage.id}`, { token: p.boss.token, body: noticeBody({ ...change, targets: viaPage.targets }) })
    expect(put.status).toBe(200)
    expect(await adminRow(viaCard.id)).toEqual(await adminRow(viaPage.id))
    const changes = (rows: Record<string, unknown>[]) => rows.filter((r) => r.action === 'update')
    expect(changes(await auditOf(viaCard.id))).toEqual(changes(await auditOf(viaPage.id)))
    expect(changes(await auditOf(viaCard.id)).map((r) => r.field)).toEqual(['title', 'severity', 'validTo'])
  })

  it('withdraws and deletes as the page does', async () => {
    const withdrawal = await proposeInChat(p.boss, { action: 'withdraw', noticeId: viaCard.id }, conversationId)
    expect(withdrawal.part).toMatchObject({ ok: true, action: 'withdraw', noticeId: viaCard.id, before: { severity: 'critical' }, reach: { placeBound: true } })
    expect(withdrawal.part).not.toHaveProperty('draft')
    await applied(p.boss, withdrawal.part!.proposalId)
    expect((await app.api('POST', `/api/notices/${viaPage.id}/withdraw`, { token: p.boss.token })).status).toBe(200)
    expect(await adminRow(viaCard.id)).toEqual(await adminRow(viaPage.id))
    expect((await adminRow(viaCard.id))?.withdrawnByName).toBe('Boss Admin')
    expect(await auditOf(viaCard.id)).toEqual(await auditOf(viaPage.id))

    // Withdrawn already: a second withdrawal is refused before any card.
    const twice = await proposeInChat(p.boss, { action: 'withdraw', noticeId: viaCard.id }, conversationId)
    expect(twice.part).toMatchObject({ ok: false, error: expect.stringContaining('withdrawn already') })
    expect(twice.result).toMatchObject({ is_error: true, content: expect.stringMatching(/^Not proposed\. Fix these/) })

    const deletion = await proposeInChat(p.boss, { action: 'delete', noticeId: viaCard.id }, conversationId)
    expect(deletion.part).toMatchObject({ ok: true, action: 'delete', state: 'proposed' })
    expect(resultJson(deletion.result).note).toMatch(/card with Delete and Discard/)
    await applied(p.boss, deletion.part!.proposalId)
    expect((await app.api('DELETE', `/api/notices/${viaPage.id}`, { token: p.boss.token })).status).toBe(204)
    expect(await adminRow(viaCard.id)).toBeUndefined()
    expect(await auditOf(viaCard.id)).toEqual(await auditOf(viaPage.id))
    expect((await auditOf(viaCard.id)).map((r) => r.action)).toEqual(['create', 'update', 'update', 'update', 'update', 'delete'])

    // Every card of the conversation as it stands now.
    expect((await historyCards(p.boss, conversationId)).map((c) => [c.action, c.ok, c.state])).toEqual([
      ['create', true, 'applied'],
      ['update', true, 'applied'],
      ['withdraw', true, 'applied'],
      ['withdraw', false, 'proposed'],
      ['delete', true, 'applied'],
    ])
  })

  it("keeps a notice's photos and files through a change, and says so", async () => {
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n')
    const form = new FormData()
    form.set('file', new Blob([pdf], { type: 'application/pdf' }), 'method.pdf')
    const file = (await app.api<NoticeFile>('POST', '/api/notices/files', { token: p.boss.token, raw: form })).body
    const notice = await pageNotice(app, p.boss, { title: 'With a method sheet', fileIds: [file.id] })
    const proposed = await proposeInChat(p.boss, { action: 'update', noticeId: notice.id, draft: draft({ title: 'With the new method sheet', targets: [] }) })
    expect(proposed.part).toMatchObject({ ok: true, before: { attachments: 1 }, draft: { attachments: 1, title: 'With the new method sheet' } })
    expect(resultJson(proposed.result).note).toContain("The notice's photos and files stay as they are")
    await applied(p.boss, proposed.part!.proposalId)
    const after = (await app.api<Notice[]>('GET', '/api/notices/admin', { token: p.boss.token })).body.find((x) => x.id === notice.id)!
    expect(after.title).toBe('With the new method sheet')
    expect(after.files.map((f) => f.id)).toEqual([file.id])
  })
})

describe('§23 a card decided once', () => {
  it('discards a card: nothing is written, and it cannot be applied after', async () => {
    const { part, conversationId } = await proposeInChat(p.boss, { action: 'create', draft: draft({ title: 'Never mind' }) })
    const discarded = await press(p.boss, part!.proposalId, 'discard')
    expect(discarded.status).toBe(200)
    expect((discarded.body as AiNoticeApplyResponse).part).toMatchObject({ state: 'discarded' })
    expect((await press(p.boss, part!.proposalId, 'discard')).status).toBe(200)
    const late = await press(p.boss, part!.proposalId, 'apply')
    expect(late.status).toBe(409)
    expect(refusal(late)).toMatchObject({ message: 'This card was discarded. Ask the assistant again.', details: { part: { state: 'discarded' } } })
    expect(await noticeCount('Never mind')).toBe(0)
    expect((await historyCards(p.boss, conversationId))[0].state).toBe('discarded')
  })

  it('applies a card once however many presses race', async () => {
    const { part } = await proposeInChat(p.boss, { action: 'create', draft: draft({ title: 'Pressed twice' }) })
    const presses = await Promise.all([press(p.boss, part!.proposalId, 'apply'), press(p.boss, part!.proposalId, 'apply'), press(p.boss, part!.proposalId, 'apply')])
    expect(presses.map((r) => r.status).sort()).toEqual([200, 409, 409])
    for (const r of presses.filter((x) => x.status === 409)) expect(refusal(r)).toMatchObject({ message: 'This card was already applied.', details: { part: { state: 'applied' } } })
    expect(await noticeCount('Pressed twice')).toBe(1)
  })

  it('turns a card stale when its notice changed, was withdrawn or deleted since: nothing is written over it', async () => {
    const notice = await pageNotice(app, p.boss, { title: 'Original words' })
    const change = await proposeInChat(p.boss, { action: 'update', noticeId: notice.id, draft: draft({ title: 'Words from the card', targets: [] }) })
    const withdrawal = await proposeInChat(p.boss, { action: 'withdraw', noticeId: notice.id }, change.conversationId)
    // Changed on the page meanwhile.
    expect((await app.api('PUT', `/api/notices/${notice.id}`, { token: p.owner.token, body: noticeBody({ title: 'Words from the page' }) })).status).toBe(200)
    for (const card of [change.part!, withdrawal.part!]) {
      const res = await press(p.boss, card.proposalId, 'apply')
      expect(res.status).toBe(409)
      expect(refusal(res)).toMatchObject({ code: 'conflict', message: expect.stringMatching(/^The notice changed/), details: { part: { state: 'stale' } } })
    }
    const kept = (await app.api<Notice[]>('GET', '/api/notices/admin', { token: p.boss.token })).body.find((x) => x.id === notice.id)!
    expect(kept.title).toBe('Words from the page')
    expect(kept.withdrawnAt ?? null).toBeNull()
    expect((await historyCards(p.boss, change.conversationId)).map((c) => c.state)).toEqual(['stale', 'stale'])
    expect(refusal(await press(p.boss, change.part!.proposalId, 'apply')).message).toMatch(/can no longer be applied/)
    expect((await press(p.boss, change.part!.proposalId, 'discard')).status).toBe(409)

    // Deleted meanwhile.
    const gone = await pageNotice(app, p.boss, { title: 'Soon gone' })
    const deletion = await proposeInChat(p.boss, { action: 'delete', noticeId: gone.id })
    expect((await app.api('DELETE', `/api/notices/${gone.id}`, { token: p.owner.token })).status).toBe(204)
    const res = await press(p.boss, deletion.part!.proposalId, 'apply')
    expect(res.status).toBe(409)
    expect(refusal(res).details?.part.state).toBe('stale')
  })

  it('supersedes a card with a newer version of the conversation, which applies in its place', async () => {
    const first = await proposeInChat(p.boss, { action: 'create', draft: draft({ title: 'Version one' }) })
    const second = await proposeInChat(p.boss, { action: 'create', draft: draft({ title: 'Version two' }), revisesProposalId: first.part!.proposalId }, first.conversationId)
    expect(second.part).toMatchObject({ ok: true, state: 'proposed' })
    expect(resultJson(second.result).note).toContain('The card of the version it revises is marked as replaced by this one.')
    expect((await historyCards(p.boss, first.conversationId)).map((c) => c.state)).toEqual(['superseded', 'proposed'])
    const old = await press(p.boss, first.part!.proposalId, 'apply')
    expect(old.status).toBe(409)
    expect(refusal(old)).toMatchObject({ message: 'A newer version of this card was made below; use that one.', details: { part: { state: 'superseded' } } })
    const made = await applied(p.boss, second.part!.proposalId)
    expect(await noticeCount('Version one')).toBe(0)
    expect(await noticeCount('Version two')).toBe(1)

    // A version of a card already published would publish it twice: the model is told to change that notice instead.
    const third = await proposeInChat(p.boss, { action: 'create', draft: draft({ title: 'Version three' }), revisesProposalId: second.part!.proposalId }, first.conversationId)
    expect(third.part).toMatchObject({ ok: false, state: 'proposed' })
    expect(third.part!.error).toContain(`it is the notice ${made.noticeId} now. To change it, propose an update with noticeId "${made.noticeId}"`)
    // A card of another conversation, or no card at all, is not one to revise; a failed version leaves its card as it was.
    const elsewhere = await proposeInChat(p.boss, { action: 'create', draft: draft({ title: 'Elsewhere' }), revisesProposalId: second.part!.proposalId })
    expect(elsewhere.part!.error).toMatch(/no card of this conversation has that id/)
    const failed = await proposeInChat(p.boss, { action: 'create', draft: draft({ title: '' }), revisesProposalId: third.part!.proposalId }, first.conversationId)
    expect(failed.part).toMatchObject({ ok: false })
    expect((await historyCards(p.boss, first.conversationId)).map((c) => c.state)).toEqual(['superseded', 'applied', 'proposed', 'proposed'])
  })

  it('refuses a new version of a new notice whose earlier card was published while the model wrote it', async () => {
    const first = await proposeInChat(p.boss, { action: 'create', draft: draft({ title: 'Raced one' }) })
    const second = await proposeInChat(p.boss, { action: 'create', draft: draft({ title: 'Raced two' }), revisesProposalId: first.part!.proposalId }, first.conversationId)
    // As if the first card's button had been pressed before the new version was stored (so it was never superseded).
    await app.db.query(`UPDATE ai_notice_proposals SET state = 'proposed' WHERE id = $1`, [first.part!.proposalId])
    await applied(p.boss, first.part!.proposalId)
    const res = await press(p.boss, second.part!.proposalId, 'apply')
    expect(res.status).toBe(409)
    expect(refusal(res)).toMatchObject({ message: expect.stringMatching(/^Another version of this card was published already/), details: { part: { state: 'stale' } } })
    expect(await noticeCount('Raced two')).toBe(0)
  })
})

describe('§23 a press while the assistant is still writing', () => {
  /** A propose_notice_change call run as the answer loop runs it: what it would keep, kept only when the test stores it. */
  async function callPropose(as: Session, conversationId: string, input: unknown) {
    const { rows } = await app.db.query<{ id: string }>(`SELECT id FROM ai_turns WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1`, [conversationId])
    const handlers = noticeToolHandlers({ db: app.db, config: app.config, userId: as.user.id, conversationId, turnId: rows[0].id, emit: () => undefined })
    const tu = { type: 'tool_use', id: `toolu_race_${Math.random().toString(36).slice(2, 10)}`, name: 'propose_notice_change', input } as Anthropic.Beta.BetaToolUseBlock
    const outcome = await handlers.propose_notice_change.run(tu, new AbortController().signal)
    return { store: outcome.store!, told: JSON.parse(String(outcome.result.content)) as { proposalId: string; note: string } }
  }

  it('never waits on the answer being stored to apply an older card, and never applies a newer version over what that card did', async () => {
    const notice = await pageNotice(app, p.boss, { title: 'Raced words' })
    const older = await proposeInChat(p.boss, { action: 'update', noticeId: notice.id, draft: draft({ title: 'Raced words, first version', targets: [] }) })
    const revision = await callPropose(p.boss, older.conversationId, { action: 'update', noticeId: notice.id, draft: draft({ title: 'Raced words, second version', targets: [] }), revisesProposalId: older.part!.proposalId })
    expect(revision.told.note).toContain('The card of the version it revises is marked as replaced by this one.')
    // Another card of the same step, stored first: the answer holds a key share on the notice (and on the person).
    const other = await callPropose(p.boss, older.conversationId, { action: 'withdraw', noticeId: notice.id })
    const tx = await app.db.connect()
    try {
      await tx.query('BEGIN')
      await other.store(tx)
      // The person presses the older card's button meanwhile: it goes through at once, never waiting on the answer
      // (which would deadlock when the answer then marks that card superseded).
      const pressed = await Promise.race([press(p.boss, older.part!.proposalId, 'apply'), new Promise<'still waiting'>((resolve) => setTimeout(() => resolve('still waiting'), 5_000))])
      expect(pressed === 'still waiting' ? pressed : pressed.status).toBe(200)
      // The new version is stored after it: the older card keeps what the person decided.
      await revision.store(tx)
      await tx.query('COMMIT')
    } catch (e) {
      await tx.query('ROLLBACK')
      throw e
    } finally {
      tx.release()
    }
    const cards = await historyCards(p.boss, older.conversationId)
    expect(cards.map((c) => c.state)).toEqual(['applied'])
    const states = await app.db.query<{ id: string; state: string }>(`SELECT id, state FROM ai_notice_proposals WHERE id = ANY($1::uuid[])`, [[revision.told.proposalId, other.told.proposalId]])
    expect(states.rows.map((r) => r.state)).toEqual(['proposed', 'proposed'])
    // Both newer cards were made over the notice as it was before the press: applying either now would write over it.
    for (const id of [revision.told.proposalId, other.told.proposalId]) {
      const res = await press(p.boss, id, 'apply')
      expect(res.status).toBe(409)
      expect(refusal(res).details?.part.state).toBe('stale')
    }
    const now = (await app.api<Notice[]>('GET', '/api/notices/admin', { token: p.boss.token })).body.find((x) => x.id === notice.id)!
    expect(now.title).toBe('Raced words, first version')
    expect(now.withdrawnAt ?? null).toBeNull()
  })
})

describe('§23 a card checked before it is shown', () => {
  it('names every problem, and keeps the card for the record without a button', async () => {
    const expired = await pageNotice(app, p.boss, { title: 'Long over', validFrom: factoryDay(-30), validTo: factoryDay(-20) })
    const unchanged = await pageNotice(app, p.boss, { title: 'Already right', targets: [] })
    const cases: [unknown, RegExp[]][] = [
      [{ action: 'create', draft: draft({ validFrom: '2026-02-30', validTo: '2026-02-01' }) }, [/draft\.validFrom: "2026-02-30" is not a day/, /draft\.validTo: The end is before the start\./]],
      [
        { action: 'create', draft: draft({ targets: [{ kind: 'machine', value: '99' }, { kind: 'role', value: 'viewer' }, { kind: 'customer', value: 'Nobody Ltd' }] }) },
        [/draft\.targets\.0: no machine with the code "99" is in the register\. Find the value with find_notice_targets/, /draft\.targets\.1: the viewer role does not receive notices/, /draft\.targets\.2: no customer "Nobody Ltd"/],
      ],
      [{ action: 'create', draft: draft({ targets: [{ kind: 'user', value: 'Ivy' }] }) }, [/draft\.targets\.0\.value: Not a valid user\./]],
      [{ action: 'create', draft: draft({ title: '   ' }) }, [/draft\.title: /]],
      [{ action: 'create', draft: draft({ validFrom: factoryDay(-10), validTo: factoryDay(-1) }) }, [/the notice would never be shown/]],
      [{ action: 'create', noticeId: unchanged.id, draft: draft() }, [/noticeId: a new notice has none yet/]],
      [{ action: 'update' }, [/draft: a change needs what changes/, /noticeId: name the notice to change/]],
      // Photos and files are the Notices page's: a draft cannot carry any.
      [{ action: 'update', noticeId: unchanged.id, draft: { ...draft({ targets: [] }), imageIds: [] } }, [/draft: Unrecognized key\(s\) in object: 'imageIds'/]],
      [{ action: 'update', noticeId: unchanged.id, draft: draft({ title: 'Already right', targets: [] }) }, [/it is the notice exactly as it is/]],
      [{ action: 'withdraw', noticeId: expired.id }, [/that notice ended on .*nothing to withdraw/]],
      [{ action: 'delete', noticeId: '00000000-0000-4000-8000-000000000000' }, [/noticeId: no notice has the id/]],
      [{ action: 'delete', noticeId: unchanged.id, draft: draft() }, [/draft: a deletion carries no draft/]],
    ]
    for (const [input, problems] of cases) {
      const { part, result } = await proposeInChat(p.boss, input)
      expect(part, JSON.stringify(input)).toMatchObject({ ok: false, state: 'proposed', error: expect.any(String) })
      expect(part).not.toHaveProperty('draft')
      expect(part).not.toHaveProperty('reach')
      for (const problem of problems) expect(part!.error, JSON.stringify(input)).toMatch(problem)
      expect(result).toMatchObject({ is_error: true, content: expect.stringMatching(/^Not proposed\. Fix these and call propose_notice_change again:\n- /) })
      const res = await press(p.boss, part!.proposalId, 'apply')
      expect(res.status).toBe(409)
      expect(refusal(res).message).toMatch(/did not pass its checks/)
    }
    // Without an action there is no card at all.
    const { part, result } = await proposeInChat(p.boss, { draft: draft() })
    expect(part).toBeUndefined()
    expect(result).toMatchObject({ is_error: true, content: expect.stringMatching(/^Fix these and call propose_notice_change again:\n- action: /) })
  })

  it('counts whom a notice reaches among the live accounts that receive notices', async () => {
    const reachOf = async (over: Record<string, unknown>) => (await proposeInChat(p.boss, { action: 'create', draft: draft(over) })).part!.reach
    // Everyone: the six accounts of roles with a bell (the viewer has none).
    expect(await reachOf({ targets: [] })).toEqual({ everyone: true, people: 6, placeBound: false })
    expect(await reachOf({ targets: [{ kind: 'role', value: 'admin' }] })).toEqual({ everyone: false, people: 3, placeBound: false })
    // all: the users among the role; any: the users and the role together.
    expect(await reachOf({ targets: [{ kind: 'role', value: 'admin' }, { kind: 'user', value: p.boss.user.id }, { kind: 'user', value: p.insp.user.id }] })).toEqual({ everyone: false, people: 1, placeBound: false })
    expect(await reachOf({ matchMode: 'any', targets: [{ kind: 'role', value: 'supervisor' }, { kind: 'user', value: p.insp.user.id }] })).toEqual({ everyone: false, people: 2, placeBound: false })
    // A place: under all, whoever works there; under any, the people it names at once and whoever works there.
    expect(await reachOf({ targets: [{ kind: 'machine', value: '48' }, { kind: 'role', value: 'supervisor' }] })).toEqual({ everyone: false, people: null, placeBound: true })
    expect(await reachOf({ matchMode: 'any', targets: [{ kind: 'machine', value: '48' }, { kind: 'role', value: 'supervisor' }] })).toEqual({ everyone: false, people: 1, placeBound: true })
    expect(await reachOf({ matchMode: 'any', targets: [{ kind: 'shift', value: 'B' }] })).toEqual({ everyone: false, people: null, placeBound: true })
  })
})

describe('§23 one notice from every version of its card', () => {
  it('never publishes a new notice twice through a chain of versions, however far back the published one is', async () => {
    // The first version published while the second was being written (so it was never superseded), then a third revises the second.
    const first = await proposeInChat(p.boss, { action: 'create', draft: draft({ title: 'Chain v1' }) })
    const second = await proposeInChat(p.boss, { action: 'create', draft: draft({ title: 'Chain v2' }), revisesProposalId: first.part!.proposalId }, first.conversationId)
    await app.db.query(`UPDATE ai_notice_proposals SET state = 'proposed' WHERE id = $1`, [first.part!.proposalId])
    const made = await applied(p.boss, first.part!.proposalId)
    // The model is told the notice is out, and what to ask for instead: a third version would publish it again.
    const third = await proposeInChat(p.boss, { action: 'create', draft: draft({ title: 'Chain v3' }), revisesProposalId: second.part!.proposalId }, first.conversationId)
    expect(third.part).toMatchObject({ ok: false, state: 'proposed' })
    expect(third.part!.error).toContain(`another version of that card was published: it is the notice ${made.noticeId} now. To change it, propose an update with noticeId "${made.noticeId}"`)
    expect(resultsOf(app)[0]).toMatchObject({ is_error: true })
    expect((await historyCards(p.boss, first.conversationId)).map((c) => c.state)).toEqual(['applied', 'proposed', 'proposed'])
    // The second is still refused at its press.
    expect(refusal(await press(p.boss, second.part!.proposalId, 'apply')).details?.part.state).toBe('stale')
    expect([await noticeCount('Chain v1'), await noticeCount('Chain v2'), await noticeCount('Chain v3')]).toEqual([1, 0, 0])
  })

  it('lets a change, a withdrawal or a deletion that names a card already done go through, unlinked, instead of failing', async () => {
    // The model often links the next card to the last one even after it was pressed: "withdraw it", then "delete it".
    const made = await proposeInChat(p.boss, { action: 'create', draft: draft({ title: 'Linked after done' }) })
    const notice = await applied(p.boss, made.part!.proposalId)
    const withdraw = await proposeInChat(p.boss, { action: 'withdraw', noticeId: notice.noticeId, revisesProposalId: made.part!.proposalId }, made.conversationId)
    expect(withdraw.part).toMatchObject({ ok: true, action: 'withdraw', state: 'proposed' })
    await applied(p.boss, withdraw.part!.proposalId)
    const del = await proposeInChat(p.boss, { action: 'delete', noticeId: notice.noticeId, revisesProposalId: withdraw.part!.proposalId }, made.conversationId)
    expect(del.part).toMatchObject({ ok: true, action: 'delete', state: 'proposed' })
    await applied(p.boss, del.part!.proposalId)
    // Nothing earlier was marked replaced: what was pressed stays as it was.
    expect((await historyCards(p.boss, made.conversationId)).map((c) => c.state)).toEqual(['applied', 'applied', 'applied'])
    // A new notice linked to the published one is still refused: it would be the same notice twice.
    const again = await proposeInChat(p.boss, { action: 'create', draft: draft({ title: 'Linked after done, again' }), revisesProposalId: made.part!.proposalId }, made.conversationId)
    expect(again.part).toMatchObject({ ok: false })
  })

  it('refuses any version of a new notice once another one of them is out: an earlier one, a later one, or one beside it', async () => {
    // A version that failed leaves its card as it was, so the first and the third are both live.
    const first = await proposeInChat(p.boss, { action: 'create', draft: draft({ title: 'Family v1' }) })
    const failed = await proposeInChat(p.boss, { action: 'create', draft: draft({ title: ' ' }), revisesProposalId: first.part!.proposalId }, first.conversationId)
    expect(failed.part).toMatchObject({ ok: false })
    const third = await proposeInChat(p.boss, { action: 'create', draft: draft({ title: 'Family v3' }), revisesProposalId: failed.part!.proposalId }, first.conversationId)
    expect(third.part).toMatchObject({ ok: true, state: 'proposed' })
    expect((await historyCards(p.boss, first.conversationId)).map((c) => c.state)).toEqual(['proposed', 'proposed', 'proposed'])
    await applied(p.boss, third.part!.proposalId)
    const older = await press(p.boss, first.part!.proposalId, 'apply')
    expect(older.status).toBe(409)
    expect(refusal(older)).toMatchObject({ message: expect.stringMatching(/^Another version of this card was published/), details: { part: { state: 'stale' } } })
    expect([await noticeCount('Family v1'), await noticeCount('Family v3')]).toEqual([0, 1])

    // Two versions of one card (the model named the same card twice): the second leaves the first live, and only one goes out.
    const root = await proposeInChat(p.boss, { action: 'create', draft: draft({ title: 'Twin v1' }) })
    const a = await proposeInChat(p.boss, { action: 'create', draft: draft({ title: 'Twin a' }), revisesProposalId: root.part!.proposalId }, root.conversationId)
    const b = await proposeInChat(p.boss, { action: 'create', draft: draft({ title: 'Twin b' }), revisesProposalId: root.part!.proposalId }, root.conversationId)
    expect((await historyCards(p.boss, root.conversationId)).map((c) => c.state)).toEqual(['superseded', 'proposed', 'proposed'])
    // Pressed at once, both held where the notice is written (its author's account locked here): the second waits for the
    // first before it looks at the other versions, so it finds the notice out, never both writing it.
    const lock = await app.db.connect()
    let presses: Awaited<ReturnType<typeof press>>[]
    try {
      await lock.query('BEGIN')
      await lock.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [p.boss.user.id])
      const both = Promise.all([press(p.boss, a.part!.proposalId, 'apply'), press(p.boss, b.part!.proposalId, 'apply')])
      const waiting = async () => (await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)).rows[0].n >= 2
      for (let i = 0; !(await waiting()); i++) {
        if (i === 200) throw new Error('Timed out waiting for both presses to wait')
        await new Promise((r) => setTimeout(r, 25))
      }
      await lock.query('COMMIT')
      presses = await both
    } finally {
      lock.release()
    }
    expect(presses.map((r) => r.status).sort()).toEqual([200, 409])
    expect([await noticeCount('Twin a'), await noticeCount('Twin b')].sort()).toEqual([0, 1])
  })
})

describe('§23 a change changes only what it names', () => {
  it('keeps every field a change leaves out as the notice has it, and ends it only when asked', async () => {
    const notice = await pageNotice(app, p.boss, {
      title: 'Coil change on 58',
      body: 'Keep this text',
      validFrom: factoryDay(-3),
      validTo: factoryDay(10),
      targets: [
        { kind: 'machine', value: '58', label: '58-A. Welding Line-LM4' },
        { kind: 'role', value: 'inspector', label: 'Inspector' },
      ],
    })
    const { part, result } = await proposeInChat(p.boss, { action: 'update', noticeId: notice.id, draft: { title: 'Coil change on 58, both ends', severity: 'critical' } })
    expect(part).toMatchObject({
      ok: true,
      draft: {
        title: 'Coil change on 58, both ends',
        body: 'Keep this text',
        severity: 'critical',
        requiresAck: true,
        matchMode: 'all',
        validFrom: factoryDay(-3),
        validTo: factoryDay(10),
        targets: notice.targets,
      },
      reach: { everyone: false, people: null, placeBound: true },
    })
    expect(resultJson(result)).toMatchObject({ notice: { days: `${factoryDay(-3)} to ${factoryDay(10)}`, audience: ['Machine: 58-A. Welding Line-LM4', 'Role: Inspector'] } })
    await applied(p.boss, part!.proposalId)
    expect((await auditOf(notice.id)).filter((r) => r.action === 'update').map((r) => r.field)).toEqual(['title', 'severity'])

    // null is "until withdrawn": the end goes only when the draft says so.
    const open = await proposeInChat(p.boss, { action: 'update', noticeId: notice.id, draft: { validTo: null } })
    expect(open.part).toMatchObject({ ok: true, draft: { validTo: null, validFrom: factoryDay(-3), body: 'Keep this text', title: 'Coil change on 58, both ends' } })
    // A new notice still needs its title, severity and acknowledgement.
    const bare = await proposeInChat(p.boss, { action: 'create', draft: { body: 'No title' } })
    expect(bare.part).toMatchObject({ ok: false })
    expect(bare.part!.error).toMatch(/draft\.title: Required/)
    expect(bare.part!.error).toMatch(/draft\.severity: Required/)
    expect(bare.part!.error).toMatch(/draft\.requiresAck: Required/)
  })

  it('never counts the match mode of one kind of target as a change, nor writes it', async () => {
    const notice = await pageNotice(app, p.boss, { title: 'One machine', targets: [{ kind: 'machine', value: '58', label: '58-A. Welding Line-LM4' }] })
    const same = await proposeInChat(p.boss, { action: 'update', noticeId: notice.id, draft: { matchMode: 'any' } })
    expect(same.part!.error).toMatch(/it is the notice exactly as it is/)
    const retitled = await proposeInChat(p.boss, { action: 'update', noticeId: notice.id, draft: { title: 'One machine only', matchMode: 'any' } })
    expect(retitled.part).toMatchObject({ ok: true, draft: { title: 'One machine only', matchMode: 'all' } })
    await applied(p.boss, retitled.part!.proposalId)
    expect((await auditOf(notice.id)).filter((r) => r.action === 'update').map((r) => r.field)).toEqual(['title'])
  })
})

describe('§23 a card that passed can be applied', () => {
  it('keeps the label of an order line with a long item within what the Notices page saves', async () => {
    const item = `Beam ${'x'.repeat(290)}`.slice(0, 295)
    const imported = await app.api('POST', '/api/orders/import', {
      token: p.owner.token,
      body: { rows: [{ lineKey: 'L-LONG', orderNumber: '20999-LONG', item, itemCode: 'LONG-1', workCenterCode: '58', requiredQty: 10, finishedQty: 0, customer: 'Beta Storage' }] },
    })
    expect(imported.status, JSON.stringify(imported.body)).toBeLessThan(300)
    const { rows } = await app.db.query<{ id: string }>(`SELECT id FROM production_orders WHERE line_key = 'L-LONG'`)
    app.model.reply({ content: [findTargets({ kind: 'order-line', query: '20999' })] }, { content: [text('Found it.')] })
    await ask(app, p.boss, 'Which line?')
    const found = resultJson<{ values: { value: string; label: string }[] }>(resultsOf(app)[0]).values
    expect(found[0].label.length).toBeLessThanOrEqual(300)
    expect(found[0].label).toMatch(/^20999-LONG · Beam x+…? ?\(LONG-1\)$/)
    const { part } = await proposeInChat(p.boss, { action: 'create', draft: draft({ title: 'Long item', targets: [{ kind: 'order-line', value: rows[0].id }] }) })
    expect(part).toMatchObject({ ok: true })
    const label = part!.draft!.targets[0].label
    expect(label).toBe(found[0].label)
    const made = await applied(p.boss, part!.proposalId)
    const notice = (await app.api<Notice[]>('GET', '/api/notices/admin', { token: p.boss.token })).body.find((x) => x.id === made.noticeId)!
    expect(notice.targets[0]).toMatchObject({ kind: 'order-line', value: rows[0].id, label })
  })

  it('tells the model when a card reaches nobody', async () => {
    const { part, result } = await proposeInChat(p.boss, { action: 'create', draft: draft({ title: 'For the viewer', targets: [{ kind: 'user', value: p.viewer.user.id }] }) })
    expect(part).toMatchObject({ ok: true, reach: { everyone: false, people: 0, placeBound: false } })
    expect(resultJson(result).note).toContain('It reaches nobody now')
  })
})
