import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { AiMessagesResponse, AiStreamEvent } from '@qc/shared/ai'
import { TestApp, type Session } from './harness'
import { runSql, text, thinking } from './aiFake'
import { parseSuggestions, stripSuggestions } from '../src/ai/suggestions'

// §20 — the follow-up questions an answer ends with. The model writes them in
// a <suggestions> block at the end of its answer; the transcript keeps the
// block byte for byte (it is replayed), and the display takes it out of the
// text and offers the questions on their own.

describe('§20 follow-up questions: reading the block', () => {
  it('takes the list lines of the last whole block, at most three, markers dropped', () => {
    const text = 'There are **2** machines.\n\n<suggestions>\n- Which machine has the most defects?\n* كم عدد العينات اليوم؟\n1. And last week?\n2) A fourth one\n</suggestions>'
    expect(parseSuggestions(text)).toEqual(['Which machine has the most defects?', 'كم عدد العينات اليوم؟', 'And last week?'])
    expect(stripSuggestions(text, true)).toBe('There are **2** machines.')
    // The last block counts; lines without a list marker do not; duplicates once; long ones cut at 200 characters.
    const two = `<suggestions>\n- Old\n</suggestions>Text\n<suggestions>\nFollow-ups:\n- New\n- New\n- ${'ق'.repeat(250)}\n</suggestions>`
    expect(parseSuggestions(two)).toEqual(['New', 'ق'.repeat(200)])
    expect(stripSuggestions(two, true)).toBe('Text')
    expect(parseSuggestions('No block at all.')).toEqual([])
    expect(parseSuggestions('<suggestions>\n\n</suggestions>')).toEqual([])
    expect(parseSuggestions('<suggestions>\n- Unclosed')).toEqual([])
  })

  it('strips an unfinished block, or the start of its tag, from the end of an answer only', () => {
    expect(stripSuggestions('The answer.\n\n<suggestions>\n- Half a quest', true)).toBe('The answer.')
    expect(stripSuggestions('The answer.\n\n<sugg', true)).toBe('The answer.')
    expect(stripSuggestions('The answer.\n<s', true)).toBe('The answer.')
    // Untouched text stays exactly as written, trailing spaces and all.
    expect(stripSuggestions('Let me check.\n', true)).toBe('Let me check.\n')
    expect(stripSuggestions('a < b', true)).toBe('a < b')
    // Before a query, only whole blocks go.
    expect(stripSuggestions('Let me check <sugg', false)).toBe('Let me check <sugg')
    expect(stripSuggestions('Before <suggestions>\n- x\n</suggestions> after', false)).toBe('Before  after')
  })
})

describe('§20 follow-up questions: the block however its tags are written', () => {
  it('reads a block in any case, with spaces or attributes in its tags, as the panel hides it while streaming', () => {
    for (const block of [
      '<Suggestions>\n- Which machine?\n- And last week?\n</Suggestions>',
      '<SUGGESTIONS>\n- Which machine?\n- And last week?\n</SUGGESTIONS >',
      '<suggestions >\n- Which machine?\n- And last week?\n</suggestions\n>',
      '<suggestions lang="en">\n- Which machine?\n- And last week?\n</suggestions>',
    ]) {
      const text = `There are **2** machines.\n\n${block}`
      expect(parseSuggestions(text), block).toEqual(['Which machine?', 'And last week?'])
      expect(stripSuggestions(text, true), block).toBe('There are **2** machines.')
    }
    expect(stripSuggestions('The answer.\n\n<Suggestions>\n- Half a quest', true)).toBe('The answer.')
    expect(stripSuggestions('The answer.\n\n<Sugg', true)).toBe('The answer.')
    expect(stripSuggestions('The answer.\n\n<suggestions class="x', true)).toBe('The answer.')
  })

  it('leaves a tag the answer only names in its text, and takes the block written after it', () => {
    // Named in a sentence, the tag opens no block that runs to the end of the answer.
    for (const named of ['Use `<suggestions>` to list them.\n\nMore', 'The <Suggestions> tag.\nNext line.', 'The <suggestionsx>\nthing.']) {
      expect(stripSuggestions(named, true), named).toBe(named)
    }
    const after = 'The `<suggestions>` block holds the questions.\n\n<suggestions>\n- Which machine?\n</suggestions>'
    expect(stripSuggestions(after, true)).toBe('The `<suggestions>` block holds the questions.')
    expect(parseSuggestions(after)).toEqual(['Which machine?'])
    // Cut off after a named tag: only the block on a line of its own goes.
    expect(stripSuggestions('The `<suggestions>` block.\n\n<suggestions>\n- Which ma', true)).toBe('The `<suggestions>` block.')
  })

  it('takes away the code fence a block was put in, and no fence of the answer’s own', () => {
    const fenced = 'There are **2** machines.\n\n```\n<suggestions>\n- Which machine?\n</suggestions>\n```'
    expect(stripSuggestions(fenced, true)).toBe('There are **2** machines.')
    expect(parseSuggestions(fenced)).toEqual(['Which machine?'])
    expect(stripSuggestions('Text.\n\n~~~~ text\n\n<suggestions>\n- Q?\n</suggestions>\n\n~~~~\n\nAfter.', false)).toBe('Text.\n\n\n\nAfter.')
    // Cut off inside its fence: the fence that never closes goes too.
    expect(stripSuggestions('The answer.\n\n```markdown\n<suggestions>\n- Which ma', true)).toBe('The answer.')
    // A code block of the answer just before the block keeps its closing fence.
    const code = 'Run this:\n\n```sql\nSELECT 1\n```\n\n<suggestions>\n- Q?\n</suggestions>'
    expect(stripSuggestions(code, true)).toBe('Run this:\n\n```sql\nSELECT 1\n```')
    const codeThenCut = 'Run this:\n\n```\nSELECT 1\n```\n<suggestions>\n- Q'
    expect(stripSuggestions(codeThenCut, true)).toBe('Run this:\n\n```\nSELECT 1\n```')
    // A fence that does not close right after the block is the answer's, and stays.
    const open = 'Text\n```\n<suggestions>\n- Q?\n</suggestions>\nmore code\n```'
    expect(stripSuggestions(open, true)).toBe('Text\n```\n\nmore code\n```')
  })
})

const app = new TestApp()
let admin: Session

async function ask(message: string, conversationId?: string) {
  const res = await app.api<string>('POST', '/api/ai/chat', {
    token: admin.token,
    body: { message, clientId: randomUUID(), ...(conversationId ? { conversationId } : {}) },
  })
  expect(res.status).toBe(200)
  const events = res.body
    .split('\n\n')
    .filter((f) => f && !f.startsWith(':'))
    .map((f) => JSON.parse(f.slice(f.indexOf('data: ') + 6)) as AiStreamEvent)
  const done = events.find((e): e is Extract<AiStreamEvent, { type: 'done' }> => e.type === 'done')!
  const start = events.find((e): e is Extract<AiStreamEvent, { type: 'start' }> => e.type === 'start')!
  return { events, done, conversationId: start.conversation.id }
}

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  admin = await app.register('admin', 'Admin')
  await app.api('POST', '/api/master/machines', { token: admin.token, body: { code: '58', name: 'Machine 58', displayName: '58. Machine', process: 'forming' } })
  const set = await app.api('PUT', '/api/ai/key', { token: admin.token, body: { apiKey: `sk-ant-api03-${'k_9-'.repeat(20)}LaSt` } })
  expect(set.status).toBe(200)
})
afterAll(() => app.stop())
beforeEach(() => app.aiLimiter.reset(admin.user.id))

const FINAL = 'There is **1** machine.\n\n<suggestions>\n- Which machines were added this month?\n- ما هي أكثر العيوب تكرارًا؟\n</suggestions>'

describe('§20 follow-up questions in a conversation', () => {
  let conversationId = ''

  it('asks for them in the system prompt of a new conversation', async () => {
    app.model.reply({ content: [text('Hello.')] })
    await ask('Hello')
    const system = (app.model.calls[0].params.system as { text: string }[])[0].text
    expect(system).toContain('# Follow-up questions')
    expect(system).toContain('End every answer with two or three short suggestions, as the very last thing you write, in exactly this form:\n<suggestions>\n- first suggestion\n- second suggestion\n</suggestions>')
    // §22 — an answer that asks the person something suggests their likely replies; any other, the next questions.
    expect(system).toContain('When your answer asks the person something (to choose an option, to answer a question, to confirm a plan), the suggestions are their likely replies, written as they would type them.')
    expect(system).toContain('Otherwise they are questions the person might ask next, each answerable from the ai.* views you can read and none repeating what you just answered.')
    expect(system).toContain('The app shows them as buttons that put the text in the message box and takes the block out of your answer, so never mention it.')
  })

  it('offers them on their own, out of the answer’s text, while the transcript keeps them as written', async () => {
    app.model.reply(
      { content: [thinking('Count them.'), text('Let me count.'), runSql('toolu_s1', 'Count the machines', 'SELECT count(*) AS n FROM ai.machines')] },
      { content: [text(FINAL)] },
    )
    const res = await ask('How many machines?')
    conversationId = res.conversationId
    // The stream carries the text as written; the client hides the block while it streams.
    expect(res.events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')).toBe(`Let me count.${FINAL}`)
    const answer = res.done.message
    expect(answer.parts).toEqual([{ type: 'text', text: 'Let me count.' }, expect.objectContaining({ type: 'query', ok: true }), { type: 'text', text: 'There is **1** machine.' }])
    expect(answer.suggestions).toEqual(['Which machines were added this month?', 'ما هي أكثر العيوب تكرارًا؟'])
    expect(answer.turnId).toEqual(expect.any(String))

    const shown = await app.api<AiMessagesResponse>('GET', `/api/ai/conversations/${conversationId}/messages`, { token: admin.token })
    expect(shown.body.messages[1]).toEqual(answer)
    expect(shown.body.messages[0]).toMatchObject({ role: 'user', turnId: answer.turnId })

    const stored = await app.db.query<{ content: string }>(
      `SELECT content::text AS content FROM ai_messages WHERE conversation_id = $1 AND kind = 'assistant' ORDER BY seq DESC LIMIT 1`,
      [conversationId],
    )
    expect(stored.rows[0].content).toBe(JSON.stringify([text(FINAL)]))
  })

  it('replays the answer with its block byte for byte on the next question', async () => {
    const prior = app.model.calls[app.model.calls.length - 1].params.messages
    app.model.reply({ content: [text('Added: none.\n\n<suggestions>\n- And last month?\n</suggestions>')] })
    const next = await ask('Which machines were added this month?', conversationId)
    const sent = app.model.calls[app.model.calls.length - 1].params.messages
    expect(JSON.stringify(sent.slice(0, prior.length + 1))).toBe(JSON.stringify([...prior, { role: 'assistant', content: [text(FINAL)] }]))
    expect(next.done.message.suggestions).toEqual(['And last month?'])
    // Offered under the latest answer only is the panel's choice; each answer keeps its own.
    const shown = await app.api<AiMessagesResponse>('GET', `/api/ai/conversations/${conversationId}/messages`, { token: admin.token })
    expect(shown.body.messages.filter((m) => m.role === 'assistant').map((m) => m.suggestions)).toEqual([
      ['Which machines were added this month?', 'ما هي أكثر العيوب تكرارًا؟'],
      ['And last month?'],
    ])
  })

  it('takes a block out of the answer however the model wrote its tags, and offers its questions', async () => {
    app.model.reply({ content: [text('One machine.\n\n```\n<Suggestions>\n- Which machine was added last?\n</Suggestions >\n```')] })
    const res = await ask('How many machines, written oddly?')
    expect(res.done.message.parts).toEqual([{ type: 'text', text: 'One machine.' }])
    expect(res.done.message.suggestions).toEqual(['Which machine was added last?'])
  })

  it('shows no block of an answer cut off while writing it, and offers nothing then', async () => {
    app.model.reply({ content: [text('Part of the answer.\n\n<suggestions>\n- Which ma')], stopReason: 'max_tokens' })
    const res = await ask('A long one')
    expect(res.done.message).toMatchObject({ stopReason: 'max_tokens', parts: [{ type: 'text', text: 'Part of the answer.' }] })
    expect(res.done.message).not.toHaveProperty('suggestions')
  })

  it('leaves an answer with no block as it was: a conversation begun before them has none', async () => {
    // A conversation whose stored prompt never asked for them goes on with that prompt, unchanged.
    await app.db.query(`UPDATE ai_conversations SET system_prompt = 'An earlier prompt.' WHERE id = $1`, [conversationId])
    app.model.reply({ content: [text('Plain answer.\n')] })
    const res = await ask('Anything else?', conversationId)
    expect((app.model.calls[app.model.calls.length - 1].params.system as { text: string }[])[0].text).toBe('An earlier prompt.')
    expect(res.done.message.parts).toEqual([{ type: 'text', text: 'Plain answer.\n' }])
    expect(res.done.message).not.toHaveProperty('suggestions')
  })
})
