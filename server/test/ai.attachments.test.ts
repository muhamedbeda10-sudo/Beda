import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type Anthropic from '@anthropic-ai/sdk'
import type { ApiErrorBody } from '@qc/shared/api'
import { AI_MODEL, type AiAttachment, type AiMessagesResponse, type AiStreamEvent } from '@qc/shared/ai'
import { TestApp, type Session } from './harness'
import { apiError, text } from './aiFake'
import { attachmentTokens, jpegSize, type AttachmentRef } from '../src/ai/attachments'
import { worstCaseUsd } from '../src/ai/models'
import { ROUTER_SYSTEM } from '../src/ai/router'

// §20 — files a question carries: a photo, a PDF or a spreadsheet is
// attached first (counted by Anthropic on the person's model, which refuses a
// file Claude cannot read), then taken by the question it is sent with. The
// stored history holds a reference; Claude receives the file itself.

const app = new TestApp()
let admin: Session
let other: Session
let inspector: Session
const KEY = `sk-ant-api03-${'k_9-'.repeat(20)}LaSt`

/** A real JPEG header with a frame of the given size: enough for the server's checks, and its bytes are what Claude gets. */
function jpeg(width: number, height: number, seed = 1): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00])
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01])
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([seed & 0xff, 0x00]), Buffer.from([0xff, 0xd9])])
}
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n')
const THUMB = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2Q=='

async function attach(bytes: Buffer, name: string, opts: { as?: Session; thumbnail?: string; type?: string } = {}) {
  const form = new FormData()
  form.set('file', new Blob([new Uint8Array(bytes)], { type: opts.type ?? 'application/octet-stream' }), name)
  if (opts.thumbnail) form.set('thumbnail', opts.thumbnail)
  return app.api<AiAttachment & ApiErrorBody>('POST', '/api/ai/attachments', { token: (opts.as ?? admin).token, raw: form })
}

const attachSheet = (body: { name: string; text: string; summary?: string }, as: Session = admin) =>
  app.api<AiAttachment & ApiErrorBody>('POST', '/api/ai/attachments/sheet', { token: as.token, body })

interface Frame {
  event: string
  data: AiStreamEvent
}
const frames = (raw: string): Frame[] =>
  raw
    .split('\n\n')
    .filter((f) => f && !f.startsWith(':'))
    .map((f) => {
      const m = /^event: (\w+)\ndata: (.+)$/.exec(f)!
      return { event: m[1], data: JSON.parse(m[2]) as AiStreamEvent }
    })

async function ask(message: string, attachmentIds: string[], opts: { conversationId?: string; as?: Session } = {}) {
  const res = await app.api<string | ApiErrorBody>('POST', '/api/ai/chat', {
    token: (opts.as ?? admin).token,
    body: { message, clientId: randomUUID(), attachmentIds, ...(opts.conversationId ? { conversationId: opts.conversationId } : {}) },
  })
  const events = res.status === 200 ? frames(res.body as string).map((f) => f.data) : []
  const start = events.find((e): e is Extract<AiStreamEvent, { type: 'start' }> => e.type === 'start')
  return { res, events, conversationId: start?.conversation.id ?? '', title: start?.conversation.title }
}

type Block = Anthropic.Beta.BetaContentBlockParam
const lastUser = (n: number): Block[] => {
  const messages = app.model.calls[n].params.messages
  return messages[messages.length - 1].content as Block[]
}

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  admin = await app.register('admin', 'Admin')
  await app.api('POST', '/api/users', { token: admin.token, body: { username: 'admin2', password: 'Password#1', name: 'Second Admin', role: 'admin' } })
  await app.api('POST', '/api/users', { token: admin.token, body: { username: 'insp', password: 'Password#1', name: 'Inspector', role: 'inspector' } })
  other = await app.login('admin2')
  inspector = await app.login('insp')
  const granted = await app.api('PUT', `/api/ai/access/${other.user.id}`, {
    token: admin.token,
    body: { enabled: true, domains: ['inspection'], monthlyCapUsd: 50 },
  })
  expect(granted.status).toBe(200)
  expect((await app.api('PUT', '/api/ai/key', { token: admin.token, body: { apiKey: KEY } })).status).toBe(200)
})
afterAll(() => app.stop())
beforeEach(() => {
  app.model.reset()
  app.aiLimiter.reset(admin.user.id)
})

describe('§20 attaching files', () => {
  it('keeps a photo, counted by Anthropic on the person’s model, with its size and preview', async () => {
    const bytes = jpeg(1200, 900)
    const up = await attach(bytes, 'ورقة الفحص.jpg', { thumbnail: THUMB, type: 'image/jpeg' })
    expect(up.status).toBe(201)
    expect(up.body).toMatchObject({ kind: 'image', name: 'ورقة الفحص.jpg', byteSize: bytes.length, tokens: 1500, width: 1200, height: 900, thumbnailDataUrl: THUMB })
    // Counted as Claude will read it: the file's name, then the photo itself.
    expect(app.model.counted).toHaveLength(1)
    expect(app.model.counted[0]).toMatchObject({ apiKey: KEY, model: AI_MODEL })
    expect(app.model.counted[0].messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: '<attachment name="ورقة الفحص.jpg" kind="photo"/>' },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: bytes.toString('base64') } },
        ],
      },
    ])
    // Its bytes are the person's to read back.
    const back = await fetch(`${app.baseUrl}/api/ai/attachments/${up.body.id}/content`, { headers: { authorization: `Bearer ${admin.token}` } })
    expect(back.status).toBe(200)
    expect(back.headers.get('content-type')).toBe('image/jpeg')
    expect(Buffer.from(await back.arrayBuffer()).equals(bytes)).toBe(true)
    expect((await app.api('GET', `/api/ai/attachments/${up.body.id}/content`, { token: other.token })).status).toBe(404)
  })

  it('keeps a PDF as a document named after the file, and a spreadsheet as its text', async () => {
    const pdf = await attach(PDF, 'mill-certificate.pdf', { type: 'application/pdf' })
    expect(pdf.status).toBe(201)
    expect(pdf.body).toMatchObject({ kind: 'pdf', name: 'mill-certificate.pdf', byteSize: PDF.length })
    expect(pdf.body).not.toHaveProperty('width')
    expect(app.model.counted[0].messages[0].content).toEqual([
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF.toString('base64') }, title: 'mill-certificate.pdf' },
    ])

    const sheet = await attachSheet({ name: 'orders.xlsx', text: '## Sheet "Orders"\norder,qty\nA-1,12', summary: '1 sheet · 1 row × 2 columns' })
    expect(sheet.status).toBe(201)
    expect(sheet.body).toMatchObject({ kind: 'sheet', name: 'orders.xlsx', summary: '1 sheet · 1 row × 2 columns' })
    expect(app.model.counted[1].messages[0].content).toEqual([
      { type: 'text', text: '<attachment name="orders.xlsx" kind="spreadsheet">\n1 sheet · 1 row × 2 columns\n## Sheet "Orders"\norder,qty\nA-1,12\n</attachment>' },
    ])
  })

  it('refuses what it cannot take, before anything is kept', async () => {
    const before = await app.db.query(`SELECT count(*)::int AS n FROM ai_attachments`)
    // Not a photo or a PDF, whatever its name says.
    const wrong = await attach(Buffer.from('order,qty\nA-1,12\n'), 'orders.pdf')
    expect(wrong.status).toBe(400)
    expect(wrong.body.error.message).toBe('Only photos, PDFs and spreadsheets (.xlsx, .csv) can be attached.')
    // A photo larger than the app prepares it.
    const big = await attach(jpeg(4000, 3000), 'big.jpg')
    expect(big.status).toBe(400)
    expect(big.body.error.message).toMatch(/at most 2576 pixels/)
    // A file Claude cannot read is refused by the count.
    app.model.tokenCount = () => {
      throw apiError(400, 'The PDF specified was not valid.')
    }
    const broken = await attach(PDF, 'locked.pdf')
    expect(broken.status).toBe(400)
    expect(broken.body.error.message).toMatch(/^Claude cannot read this PDF/)
    // One that alone would take more than a file may.
    app.model.tokenCount = () => 250_000
    const long = await attach(PDF, 'manual.pdf')
    expect(long.status).toBe(400)
    expect(long.body.error.message).toMatch(/about 250,000 tokens/)
    // A spreadsheet with nothing in it.
    expect((await attachSheet({ name: 'empty.csv', text: '   ' })).status).toBe(400)
    const after = await app.db.query(`SELECT count(*)::int AS n FROM ai_attachments`)
    expect(after.rows[0].n).toBe(before.rows[0].n)
  })

  it('is for people given the assistant only, and says so before reading the file', async () => {
    const res = await attach(PDF, 'cert.pdf', { as: inspector })
    expect(res.status).toBe(403)
    expect((await attachSheet({ name: 'x.csv', text: 'a,b' }, inspector)).status).toBe(403)
    expect(app.model.counted).toEqual([])
  })

  it('bounds the files a person holds attached and not sent', async () => {
    const before = (await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ai_attachments WHERE user_id = $1 AND turn_id IS NULL AND deleted_at IS NULL`, [other.user.id])).rows[0].n
    for (let i = before; i < 20; i++) expect((await attachSheet({ name: `s${i}.csv`, text: `a,b\n${i},1` }, other)).status).toBe(201)
    const over = await attachSheet({ name: 'one-more.csv', text: 'a,b' }, other)
    expect(over.status).toBe(429)
    // Removing one makes room again.
    const { rows } = await app.db.query<{ id: string }>(`SELECT id FROM ai_attachments WHERE user_id = $1 AND turn_id IS NULL AND deleted_at IS NULL LIMIT 1`, [other.user.id])
    expect((await app.api('DELETE', `/api/ai/attachments/${rows[0].id}`, { token: other.token })).status).toBe(204)
    expect((await app.api('DELETE', `/api/ai/attachments/${rows[0].id}`, { token: other.token })).status).toBe(404)
    expect((await attachSheet({ name: 'one-more.csv', text: 'a,b' }, other)).status).toBe(201)
    await app.db.query(`UPDATE ai_attachments SET deleted_at = now() WHERE user_id = $1 AND turn_id IS NULL AND deleted_at IS NULL`, [other.user.id])
  })
})

describe('§20 asking with files', () => {
  let conversationId = ''
  let photo: AiAttachment
  let pdf: AiAttachment
  let sheet: AiAttachment
  const photoBytes = jpeg(2000, 1500, 7)

  it('sends Claude the files in order between the date line and the words, and keeps references only', async () => {
    photo = (await attach(photoBytes, 'sheet.jpg', { thumbnail: THUMB })).body
    pdf = (await attach(PDF, 'cert.pdf')).body
    sheet = (await attachSheet({ name: 'orders.csv', text: 'order,qty\nA-1,12', summary: '1 row × 2 columns' })).body
    app.model.reply({ content: [text('The sheet shows 12 pieces.')] })
    const asked = await ask('What do these say?', [photo.id, pdf.id, sheet.id])
    expect(asked.res.status).toBe(200)
    conversationId = asked.conversationId
    const content = lastUser(0)
    expect(content.map((b) => b.type)).toEqual(['text', 'text', 'image', 'document', 'text', 'text'])
    expect((content[0] as { text: string }).text).toMatch(/^<context>Today: /)
    expect(content[2]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: photoBytes.toString('base64') } })
    expect(content[3]).toMatchObject({ type: 'document', title: 'cert.pdf' })
    expect((content[4] as { text: string }).text).toBe('<attachment name="orders.csv" kind="spreadsheet">\n1 row × 2 columns\norder,qty\nA-1,12\n</attachment>')
    expect(content[5]).toEqual({ type: 'text', text: 'What do these say?' })
    // A new conversation is told how to read files.
    expect(JSON.stringify(app.model.calls[0].params.system)).toContain('# Files the person attaches')
    // A question with files runs at its own level (Models: Sonnet 5.5, medium, as recommended), the router not asked.
    expect(app.model.calls[0].params).toMatchObject({ model: 'claude-sonnet-5-5', output_config: { effort: 'medium' } })
    expect(app.model.completions.filter((c) => c.params.system === ROUTER_SYSTEM)).toHaveLength(0)
    const turn = await app.db.query(`SELECT level, level_reason AS "levelReason" FROM ai_turns WHERE conversation_id = $1`, [conversationId])
    expect(turn.rows).toEqual([{ level: 'chat-files', levelReason: null }])

    // The stored question holds references, never the bytes.
    const { rows } = await app.db.query<{ content: unknown[] }>(`SELECT content FROM ai_messages WHERE conversation_id = $1 AND kind = 'question'`, [conversationId])
    expect(rows[0].content.slice(1, 4)).toEqual([
      { type: 'qc_attachment', attachmentId: photo.id, tokens: 1500 },
      { type: 'qc_attachment', attachmentId: pdf.id, tokens: 1500 },
      { type: 'qc_attachment', attachmentId: sheet.id, tokens: 1500 },
    ])
    expect(JSON.stringify(rows[0].content)).not.toContain(photoBytes.toString('base64'))

    // The conversation shows the question's files with it, in order.
    const shown = await app.api<AiMessagesResponse>('GET', `/api/ai/conversations/${conversationId}/messages`, { token: admin.token })
    expect(shown.body.messages[0].attachments?.map((a) => a.name)).toEqual(['sheet.jpg', 'cert.pdf', 'orders.csv'])
    expect(shown.body.messages[0].attachments?.[0]).toMatchObject({ kind: 'image', width: 2000, height: 1500, thumbnailDataUrl: THUMB })
    expect(shown.body.messages[1].attachments).toBeUndefined()
  })

  it('replays the files byte for byte with the next questions', async () => {
    app.model.reply({ content: [text('Still 12.')] }, { content: [text('Yes.')] })
    expect((await ask('And the total?', [], { conversationId })).res.status).toBe(200)
    expect((await ask('Sure?', [], { conversationId })).res.status).toBe(200)
    const [second, third] = app.model.calls.map((c) => c.params.messages)
    expect(second).toHaveLength(3)
    expect(third).toHaveLength(5)
    expect(third[0].content).toEqual(second[0].content)
    expect(JSON.stringify(second[0].content)).toContain(photoBytes.toString('base64'))
  })

  it('takes a file once, and only the person’s own', async () => {
    // Sent already.
    const twice = await ask('Again', [photo.id], { conversationId })
    expect(twice.res.status).toBe(404)
    // Someone else's.
    const mine = await attach(PDF, 'mine.pdf', { as: other })
    const theirs = await ask('Read it', [mine.body.id])
    expect(theirs.res.status).toBe(404)
    // Taken off before it was sent.
    expect((await app.api('DELETE', `/api/ai/attachments/${mine.body.id}`, { token: other.token })).status).toBe(204)
    expect((await ask('Read it', [mine.body.id], { as: other })).res.status).toBe(404)
    // A sent file cannot be taken off.
    expect((await app.api('DELETE', `/api/ai/attachments/${photo.id}`, { token: admin.token })).status).toBe(404)
    expect(app.model.calls).toEqual([])
  })

  it('takes files alone as a question, named after the first of them', async () => {
    const only = await attach(jpeg(800, 600, 9), 'تقرير اليوم.jpg')
    app.model.reply({ content: [text('A daily report.')] })
    const asked = await ask('', [only.body.id])
    expect(asked.res.status).toBe(200)
    expect(asked.title).toBe('تقرير اليوم.jpg')
    // No empty text block: the date line, the file's name and the photo.
    expect(lastUser(0).map((b) => b.type)).toEqual(['text', 'text', 'image'])
    // Neither words nor files: nothing to ask.
    const none = await app.api<ApiErrorBody>('POST', '/api/ai/chat', { token: admin.token, body: { message: '  ', clientId: randomUUID(), attachmentIds: [] } })
    expect(none.status).toBe(400)
    expect(none.body.error.message).toMatch(/Write a question\.$/)
  })

  it('bounds what one conversation carries', async () => {
    app.model.tokenCount = () => 150_000
    const ids: string[] = []
    for (const n of [1, 2, 3]) ids.push((await attach(PDF, `part-${n}.pdf`)).body.id)
    const over = await ask('Compare them', ids)
    expect(over.res.status).toBe(400)
    expect((over.res.body as ApiErrorBody).error.message).toMatch(/400,000 tokens/)
    // Nothing was taken: two of them still go.
    app.model.reply({ content: [text('Compared.')] })
    const two = await ask('Compare these two', ids.slice(0, 2))
    expect(two.res.status).toBe(200)
    // A third, later, would take the conversation past its bound.
    const third = await ask('Read this too', [ids[2]], { conversationId: two.conversationId })
    expect(third.res.status).toBe(400)
    expect((third.res.body as ApiErrorBody).error.message).toMatch(/Start a new conversation for these files\.$/)
  })
})

describe('§20 the price of files', () => {
  it('reads a JPEG’s size from its frame header', () => {
    expect(jpegSize(jpeg(2576, 1932))).toEqual({ width: 2576, height: 1932 })
    expect(jpegSize(Buffer.from('not a jpeg'))).toBeNull()
    expect(jpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBeNull()
  })

  it('prices a reference at its counted tokens with a margin, not at its few characters', () => {
    const ref: AttachmentRef = { type: 'qc_attachment', attachmentId: randomUUID(), tokens: 100_000 }
    const messages = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }, ref] }]
    expect(attachmentTokens(messages)).toBe(135_000)
    const params = { model: AI_MODEL, system: [], tools: [], max_tokens: 1000 }
    const without = worstCaseUsd({ ...params, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
    const withFile = worstCaseUsd({ ...params, messages })
    // 135 000 tokens more, each at Sonnet 5.5's cache write of $2.50 a million (no fallback asked for here).
    expect(withFile - without).toBeCloseTo(0.3375, 3)
  })
})
