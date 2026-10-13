import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { ApiErrorBody } from '@qc/shared/api'
import {
  AI_MAX_PINNED_CONVERSATIONS,
  AI_MODEL,
  type AiConversation,
  type AiConversationGroup,
  type AiConversationGroupsResponse,
  type AiConversationSearchResponse,
  type AiConversationsResponse,
  type AiStreamEvent,
} from '@qc/shared/ai'
import { TestApp, type Session } from './harness'
import { text } from './aiFake'
import { foldForSearch, likePattern, snippetAround } from '../src/ai/conversationSearch'

// §20 — keeping one's conversations in order (migration 0052): renamed,
// pinned, in groups, archived, and found again by what was said in them.
// Each person's own: someone else's conversation or group is not found.

const app = new TestApp()
let admin: Session
let other: Session
const KEY = `sk-ant-api03-${'k_9-'.repeat(20)}LaSt`

/** Ask a question the scripted model answers with `answer`; the conversation's id. */
async function ask(question: string, answer: string, opts: { as?: Session; conversationId?: string } = {}): Promise<string> {
  app.aiLimiter.reset((opts.as ?? admin).user.id)
  app.model.reply({ content: [text(answer)] })
  const res = await app.api<string>('POST', '/api/ai/chat', {
    token: (opts.as ?? admin).token,
    body: { message: question, clientId: randomUUID(), ...(opts.conversationId ? { conversationId: opts.conversationId } : {}) },
  })
  expect(res.status).toBe(200)
  const start = res.body
    .split('\n\n')
    .filter((f) => f.startsWith('event: start'))
    .map((f) => JSON.parse(f.slice(f.indexOf('data: ') + 6)) as Extract<AiStreamEvent, { type: 'start' }>)[0]
  return start.conversation.id
}

const patch = (id: string, body: object, as = admin) => app.api<AiConversation & ApiErrorBody>('PATCH', `/api/ai/conversations/${id}`, { token: as.token, body })
const list = async (query: string, as = admin) => {
  const res = await app.api<AiConversationsResponse>('GET', `/api/ai/conversations?${query}`, { token: as.token })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return res.body
}
const titles = (r: AiConversationsResponse) => r.conversations.map((c) => c.title)
const search = (q: string, as = admin) => app.api<AiConversationSearchResponse & ApiErrorBody>('GET', `/api/ai/conversations/search?q=${encodeURIComponent(q)}`, { token: as.token })
const makeGroup = async (name: string, as = admin) => {
  const res = await app.api<AiConversationGroup & ApiErrorBody>('POST', '/api/ai/conversation-groups', { token: as.token, body: { name } })
  return res
}
const groups = async (as = admin) => (await app.api<AiConversationGroupsResponse>('GET', '/api/ai/conversation-groups', { token: as.token })).body.groups

let scrap: string
let routing: string
let ncr: string

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  admin = await app.register('admin', 'Admin')
  await app.api('POST', '/api/users', { token: admin.token, body: { username: 'admin2', password: 'Password#1', name: 'Second Admin', role: 'admin' } })
  other = await app.login('admin2')
  const granted = await app.api('PUT', `/api/ai/access/${other.user.id}`, {
    token: admin.token,
    body: { enabled: true, domains: ['inspection'], model: AI_MODEL, effort: 'medium', monthlyCapUsd: 50 },
  })
  expect(granted.status).toBe(200)
  expect((await app.api('PUT', '/api/ai/key', { token: admin.token, body: { apiKey: KEY } })).status).toBe(200)
  scrap = await ask('Scrap last week by machine', 'Machine 58 had the most scrap: 4.2 %.\n\n<suggestions>\n- Compare with June\n</suggestions>')
  routing = await ask('Routing of the C150 purlin', 'The purlin passes the roll former, then the punch.')
  ncr = await ask('كم عدد تقارير عدم المطابقة؟', 'هناك إجابةٌ واحدة: ثلاثة تقارير.')
})
afterAll(() => app.stop())

describe('renaming a conversation', () => {
  it('keeps a title of the person’s own, on one line, and refuses an empty or long one', async () => {
    const res = await patch(scrap, { title: '  Scrap\n by machine  ' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body).toMatchObject({ id: scrap, title: 'Scrap by machine', pinnedAt: null, groupId: null, archivedAt: null })
    const { rows } = await app.db.query<{ title_source: string }>(`SELECT title_source FROM ai_conversations WHERE id = $1`, [scrap])
    expect(rows[0].title_source).toBe('person')

    expect((await patch(scrap, { title: '   ' })).body).toMatchObject({ error: { code: 'validation' } })
    expect((await patch(scrap, { title: 'x'.repeat(81) })).status).toBe(400)
    // Emoji count as one character each: 80 of them fit.
    expect((await patch(routing, { title: '🔧'.repeat(80) })).status).toBe(200)
    expect((await patch(routing, { title: 'Purlin routing' })).status).toBe(200)
    expect((await patch(scrap, {})).status).toBe(400)
    expect((await patch(scrap, { colour: 'red' })).status).toBe(400)
  })

  it('is the person’s own: someone else’s conversation is not found', async () => {
    expect((await patch(scrap, { title: 'Mine now' }, other)).status).toBe(404)
    expect((await patch(randomUUID(), { title: 'Nothing' })).status).toBe(404)
  })
})

describe('pinning', () => {
  it('lists the pinned ones first, the latest pinned on top, and out of Recent', async () => {
    expect((await patch(routing, { pinned: true })).body.pinnedAt).not.toBeNull()
    expect((await patch(ncr, { pinned: true })).status).toBe(200)
    expect(titles(await list('scope=pinned'))).toEqual(['كم عدد تقارير عدم المطابقة؟', 'Purlin routing'])
    expect(titles(await list('scope=recent'))).toEqual(['Scrap by machine'])
    // Every one not archived, as before groups.
    expect(titles(await list(''))).toHaveLength(3)
    expect((await patch(ncr, { pinned: false })).body.pinnedAt).toBeNull()
    expect(titles(await list('scope=pinned'))).toEqual(['Purlin routing'])
  })

  it(`stops at ${AI_MAX_PINNED_CONVERSATIONS} pinned at once`, async () => {
    const made: string[] = []
    // Made in the database: as many questions would be over the rate limit, and their answers are not what this checks.
    for (let i = 0; i < AI_MAX_PINNED_CONVERSATIONS; i++) {
      const { rows } = await app.db.query<{ id: string }>(
        `INSERT INTO ai_conversations (user_id, title, model, system_prompt, tools, last_message_at) VALUES ($1, $2, $3, '', '[]', now() - make_interval(mins => $4)) RETURNING id`,
        [other.user.id, `Question ${i}`, AI_MODEL, i],
      )
      made.push(rows[0].id)
    }
    for (const id of made.slice(0, -1)) expect((await patch(id, { pinned: true }, other)).status).toBe(200)
    expect((await patch(made.at(-1)!, { pinned: true }, other)).status).toBe(200)
    const extra = await ask('One more', 'Answer', { as: other })
    const refused = await patch(extra, { pinned: true }, other)
    expect(refused.status).toBe(409)
    expect(refused.body.error.message).toMatch(/At most 30 conversations can be pinned/)
    // Pinning one already pinned changes nothing and is not refused.
    expect((await patch(made[0], { pinned: true }, other)).status).toBe(200)
    // Someone else's pins are theirs: the admin may still pin.
    expect((await patch(ncr, { pinned: true })).status).toBe(200)
    expect((await patch(ncr, { pinned: false })).status).toBe(200)
  })
})

describe('groups', () => {
  let quality: AiConversationGroup
  let production: AiConversationGroup

  it('are made, by name, unique whatever the case, for their maker only', async () => {
    const made = await makeGroup('  Quality ')
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    quality = made.body
    expect(quality).toMatchObject({ name: 'Quality', conversationCount: 0, lastMessageAt: null })
    production = (await makeGroup('Production')).body
    expect((await makeGroup('quality')).body).toMatchObject({ error: { code: 'duplicate' } })
    expect((await makeGroup('')).status).toBe(400)
    expect((await makeGroup('g'.repeat(61))).status).toBe(400)
    // Another person may use the same name, and sees none of the admin's groups.
    expect((await makeGroup('Quality', other)).status).toBe(201)
    expect((await groups(other)).map((g) => g.name)).toEqual(['Quality'])
    expect((await groups()).map((g) => g.name)).toEqual(['Production', 'Quality'])
  })

  it('hold conversations, one group each; the group’s list has its pinned ones too', async () => {
    expect((await patch(scrap, { groupId: quality.id })).body.groupId).toBe(quality.id)
    expect((await patch(ncr, { groupId: quality.id })).status).toBe(200)
    expect((await patch(routing, { groupId: production.id })).status).toBe(200)
    expect(titles(await list(`scope=group&groupId=${quality.id}`))).toEqual(['كم عدد تقارير عدم المطابقة؟', 'Scrap by machine'])
    // Pinned and in a group: in both.
    expect(titles(await list(`scope=group&groupId=${production.id}`))).toEqual(['Purlin routing'])
    expect(titles(await list('scope=pinned'))).toEqual(['Purlin routing'])
    expect(titles(await list('scope=recent'))).toEqual([])
    const counted = await groups()
    expect(counted.find((g) => g.id === quality.id)).toMatchObject({ conversationCount: 2 })
    expect(counted.find((g) => g.id === quality.id)!.lastMessageAt).not.toBeNull()
    // Moved to another group, then out of any.
    expect((await patch(ncr, { groupId: production.id })).status).toBe(200)
    expect((await patch(ncr, { groupId: null })).body.groupId).toBeNull()
    expect(titles(await list('scope=recent'))).toEqual(['كم عدد تقارير عدم المطابقة؟'])
    expect((await app.api('GET', '/api/ai/conversations?scope=group', { token: admin.token })).status).toBe(400)
  })

  it('never takes someone else’s group or conversation', async () => {
    const theirs = (await groups(other))[0]
    expect((await patch(scrap, { groupId: theirs.id })).status).toBe(404)
    expect((await app.api('PATCH', `/api/ai/conversation-groups/${theirs.id}`, { token: admin.token, body: { name: 'Mine' } })).status).toBe(404)
    expect((await app.api('DELETE', `/api/ai/conversation-groups/${theirs.id}`, { token: admin.token })).status).toBe(404)
    // Listing it as theirs shows nothing of theirs.
    expect((await list(`scope=group&groupId=${theirs.id}`)).conversations).toEqual([])
  })

  it('are renamed, and removed: their conversations go back to the list', async () => {
    const renamed = await app.api<AiConversationGroup & ApiErrorBody>('PATCH', `/api/ai/conversation-groups/${quality.id}`, { token: admin.token, body: { name: 'QC' } })
    expect(renamed.body).toMatchObject({ id: quality.id, name: 'QC', conversationCount: 1 })
    expect((await app.api<ApiErrorBody>('PATCH', `/api/ai/conversation-groups/${quality.id}`, { token: admin.token, body: { name: 'production' } })).body).toMatchObject({ error: { code: 'duplicate' } })
    // The same name in another case is its own rename.
    expect((await app.api('PATCH', `/api/ai/conversation-groups/${quality.id}`, { token: admin.token, body: { name: 'qc' } })).status).toBe(200)

    expect((await app.api('DELETE', `/api/ai/conversation-groups/${quality.id}`, { token: admin.token })).status).toBe(204)
    expect((await groups()).map((g) => g.name)).toEqual(['Production'])
    expect(titles(await list('scope=recent'))).toEqual(['كم عدد تقارير عدم المطابقة؟', 'Scrap by machine'])
    // Its name is free again.
    expect((await makeGroup('QC')).status).toBe(201)
  })
})

describe('archiving', () => {
  it('takes a conversation out of the list, unpinned; asked in again, it is back', async () => {
    const res = await patch(routing, { archived: true })
    expect(res.body).toMatchObject({ pinnedAt: null })
    expect(res.body.archivedAt).not.toBeNull()
    expect(titles(await list('scope=archived'))).toEqual(['Purlin routing'])
    expect(titles(await list('scope=pinned'))).toEqual([])
    expect(titles(await list(''))).not.toContain('Purlin routing')
    // Still in its group, but listed there only once it is back.
    const production = (await groups()).find((g) => g.name === 'Production')!
    expect(production.conversationCount).toBe(0)

    expect((await patch(routing, { pinned: true, archived: true })).status).toBe(400)
    // Pinning brings it back.
    expect((await patch(routing, { pinned: true })).body).toMatchObject({ archivedAt: null })
    expect((await patch(routing, { archived: true })).status).toBe(200)

    await ask('And the punch time?', 'Two minutes a piece.', { conversationId: routing })
    expect(titles(await list('scope=archived'))).toEqual([])
    expect(titles(await list(`scope=group&groupId=${production.id}`))).toEqual(['Purlin routing'])
    expect((await patch(routing, { archived: false })).body.archivedAt).toBeNull()
  })
})

describe('the list, a page at a time', () => {
  it('reaches every conversation once, even two at one millisecond', async () => {
    const { rows } = await app.db.query<{ id: string }>(`SELECT id FROM ai_conversations WHERE user_id = $1`, [other.user.id])
    await app.db.query(`UPDATE ai_conversations SET last_message_at = '2026-10-01T08:00:00.123Z' WHERE user_id = $1`, [other.user.id])
    const seen: string[] = []
    let query = 'scope=all&limit=7'
    for (;;) {
      const page = await list(query, other)
      seen.push(...page.conversations.map((c) => c.id))
      if (!page.hasMore) break
      const end = page.conversations.at(-1)!
      query = `scope=all&limit=7&before=${encodeURIComponent(end.lastMessageAt)}&beforeId=${end.id}`
    }
    expect(seen.sort()).toEqual(rows.map((r) => r.id).sort())
  })
})

describe('searching', () => {
  it('finds a conversation by its title, a question or an answer’s words, without the app’s blocks', async () => {
    const byTitle = await search('SCRAP BY')
    expect(byTitle.body.hits).toEqual([expect.objectContaining({ where: 'title', snippet: '', match: null })])

    const byQuestion = await search('C150')
    expect(byQuestion.body.hits).toHaveLength(1)
    expect(byQuestion.body.hits[0]).toMatchObject({ where: 'question', snippet: 'Routing of the C150 purlin' })
    expect(byQuestion.body.hits[0].match).toEqual({ start: 15, length: 4 })

    const byAnswer = await search('4.2 %')
    expect(byAnswer.body.hits[0]).toMatchObject({ where: 'answer', snippet: 'Machine 58 had the most scrap: 4.2 %.', match: { start: 31, length: 5 } })
    // The follow-up questions are the app's, not the answer's words.
    expect((await search('Compare with June')).body.hits).toEqual([])
    // The latest question or answer that has the words.
    expect((await search('punch')).body.hits[0]).toMatchObject({ where: 'question', snippet: 'And the punch time?' })
  })

  it('reads Arabic written either way, and takes % and _ as written', async () => {
    const hit = (await search('اجابة')).body.hits
    expect(hit).toHaveLength(1)
    expect(hit[0]).toMatchObject({ where: 'answer', snippet: 'هناك إجابةٌ واحدة: ثلاثة تقارير.' })
    expect(hit[0].snippet.slice(hit[0].match!.start, hit[0].match!.start + hit[0].match!.length)).toBe('إجابةٌ')
    expect((await search('مطابقه')).body.hits[0]).toMatchObject({ where: 'title' })
    expect((await search('%%')).body.hits).toEqual([])
    expect((await search('a_')).body.hits).toEqual([])
  })

  it('is the person’s own, archived ones included, and refuses too short or long', async () => {
    expect((await search('Scrap', other)).body.hits).toEqual([])
    await patch(scrap, { archived: true })
    expect((await search('Scrap')).body.hits[0].conversation).toMatchObject({ id: scrap, archivedAt: expect.any(String) })
    await patch(scrap, { archived: false })
    expect((await search('a')).status).toBe(400)
    expect((await search('x'.repeat(101))).status).toBe(400)
    // A removed conversation is not found.
    expect((await app.api('DELETE', `/api/ai/conversations/${ncr}`, { token: admin.token })).status).toBe(204)
    expect((await search('اجابة')).body.hits).toEqual([])
  })
})

describe('folding and snippets', () => {
  it('folds as the database does', async () => {
    const samples = ['إجـابةُ ABC مستشفى', 'Çelik ÖZ', 'أآٱ ة ى', '🔧 Wrench']
    for (const s of samples) {
      const { rows } = await app.db.query<{ f: string }>(`SELECT ai_search_fold($1) AS f`, [s])
      expect(foldForSearch(s), s).toBe(rows[0].f)
    }
    expect(likePattern('50%_a\\b')).toBe('%50\\%\\_a\\\\b%')
  })

  it('keeps the words around the match, cut at a space, with … where the text goes on', () => {
    const long = `${'start '.repeat(30)}the welding gap was 2 mm on line 3 ${'end '.repeat(40)}`
    const s = snippetAround(long, 'welding gap')
    expect(s.snippet.startsWith('…')).toBe(true)
    expect(s.snippet.endsWith('…')).toBe(true)
    expect(s.snippet.slice(s.match!.start, s.match!.start + s.match!.length)).toBe('welding gap')
    expect(s.snippet).not.toMatch(/…\S*star\b/)
    expect(snippetAround('short text', 'nothing')).toEqual({ snippet: 'short text', match: null })
    const emoji = snippetAround('🔧 wrench 🔧 here', 'here')
    expect(emoji.snippet.slice(emoji.match!.start, emoji.match!.start + emoji.match!.length)).toBe('here')
  })
})
