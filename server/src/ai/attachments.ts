// ============================================================================
// §20 — files a question carries: photos (handwritten sheets too), PDFs and
// spreadsheets, for Claude to read.
//
//   • a file is attached before the question is sent: checked by its bytes
//     (never its name), counted in tokens by Anthropic on the model of the
//     person attaching it — which also proves Claude can read it, so a damaged
//     or locked PDF is refused now rather than sinking every later question of
//     its conversation — and kept: a photo's or a PDF's bytes in the file
//     store, a spreadsheet's text (read on the device) in the database.
//   • the question takes it: its stored message holds a reference to it,
//     `{ type: 'qc_attachment', attachmentId, tokens }`, in the order the
//     person attached them, between the date line and their words. The
//     reference never changes, and neither does the file, so the conversation
//     is still replayed byte for byte.
//   • right before each call to the model the references become what Claude
//     reads (expandAttachments): a photo, a PDF, or the spreadsheet's text,
//     each named. Bytes are read from the store once per question.
//   • the caps price a reference at its counted tokens, with a margin for a
//     model whose tokenizer counts differently (attachmentTokens).
// ============================================================================

import { createHash, randomUUID } from 'node:crypto'
import type Anthropic from '@anthropic-ai/sdk'
import {
  AI_IMAGE_LONG_EDGE,
  AI_MAX_ATTACHMENTS_PER_CONVERSATION,
  AI_MAX_ATTACHMENTS_PER_QUESTION,
  AI_MAX_ATTACHMENT_TOKENS,
  AI_MAX_CONVERSATION_ATTACHMENT_BYTES,
  AI_MAX_CONVERSATION_ATTACHMENT_TOKENS,
  type AiAttachment,
  type AiAttachmentKind,
} from '@qc/shared/ai'
import type { Db, Queryable } from '../db/pool'
import type { ImageStorage } from '../images/storage'
import { HttpError, badRequest } from '../lib/errors'

type ContentBlockParam = Anthropic.Beta.BetaContentBlockParam
type MessageParam = Anthropic.Beta.BetaMessageParam

// ---- References in the stored history ------------------------------------------------

/** A file in a stored question: what Claude reads in its place is built right before each call. */
export interface AttachmentRef {
  type: 'qc_attachment'
  attachmentId: string
  /** What Claude reads of it, as counted when it was attached. */
  tokens: number
}

/** A block of a stored message: as sent, or a file's reference. */
export type StoredBlock = ContentBlockParam | AttachmentRef

/** A message as it is stored and replayed: what is sent, files by reference. */
export interface StoredMessage {
  role: 'user' | 'assistant'
  content: StoredBlock[]
}

export const isAttachmentRef = (b: unknown): b is AttachmentRef =>
  typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'qc_attachment' && typeof (b as { attachmentId?: unknown }).attachmentId === 'string'

/**
 * Counted on the model of the person attaching it; another model's tokenizer
 * may count more. The caps err on the dear side: a third more.
 */
const OTHER_MODEL_MARGIN = 1.35

/** What the files referenced in these messages may take of a call's input, for the caps. */
export function attachmentTokens(messages: readonly { content: unknown }[]): number {
  let sum = 0
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue
    for (const b of m.content) if (isAttachmentRef(b)) sum += Math.ceil(b.tokens * OTHER_MODEL_MARGIN)
  }
  return sum
}

// ---- What Claude reads -----------------------------------------------------------------

/** One stored file, as much of it as building what Claude reads needs. */
export interface AttachmentRecord {
  id: string
  kind: AiAttachmentKind
  name: string
  mimeType: string
  storageKey: string | null
  contentText: string | null
  summary: string | null
}

/** A file's name inside a tag's attribute: one line, no quotes or angle brackets, so it reads as a name only. */
function attributeName(name: string): string {
  return name.replace(/[\s]+/g, ' ').replace(/["<>]/g, "'").trim().slice(0, 255) || 'file'
}

/**
 * What Claude reads for a file: its name, then the photo, the PDF or the
 * spreadsheet's text. The same file always gives the same blocks, so a
 * conversation replays unchanged. `bytes` is null when the store no longer
 * has them: Claude is told so.
 */
export function attachmentBlocks(a: AttachmentRecord, bytes: Buffer | null): ContentBlockParam[] {
  const name = attributeName(a.name)
  if (a.kind === 'sheet') {
    const outline = a.summary ? `${a.summary}\n` : ''
    return [{ type: 'text', text: `<attachment name="${name}" kind="spreadsheet">\n${outline}${a.contentText ?? ''}\n</attachment>` }]
  }
  if (!bytes) return [{ type: 'text', text: `<attachment name="${name}" kind="${a.kind}">This file is no longer available.</attachment>` }]
  const data = bytes.toString('base64')
  if (a.kind === 'image') {
    return [
      { type: 'text', text: `<attachment name="${name}" kind="photo"/>` },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } },
    ]
  }
  return [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data }, title: name }]
}

/**
 * The files of one question's answer, read once each: every call of the
 * answer sends the same blocks for them.
 */
export class AttachmentExpander {
  private blocks = new Map<string, Promise<ContentBlockParam[]>>()

  constructor(
    private readonly db: Queryable,
    private readonly store: ImageStorage,
  ) {}

  private load(id: string): Promise<ContentBlockParam[]> {
    let pending = this.blocks.get(id)
    if (!pending) {
      pending = (async () => {
        const { rows } = await this.db.query<AttachmentRecord>(
          `SELECT id, kind, original_filename AS name, mime_type AS "mimeType", storage_key AS "storageKey", content_text AS "contentText", summary
             FROM ai_attachments WHERE id = $1`,
          [id],
        )
        const a = rows[0]
        if (!a) return [{ type: 'text', text: '<attachment>This file is no longer available.</attachment>' } as ContentBlockParam]
        return attachmentBlocks(a, a.storageKey ? await readAll(this.store, a.storageKey) : null)
      })()
      // A failed read is tried again by the next call, not remembered.
      pending.catch(() => this.blocks.delete(id))
      this.blocks.set(id, pending)
    }
    return pending
  }

  /** The messages as Claude reads them: every file's reference replaced by its blocks. */
  async expand(messages: readonly StoredMessage[]): Promise<MessageParam[]> {
    const out: MessageParam[] = []
    for (const m of messages) {
      if (!m.content.some(isAttachmentRef)) {
        out.push(m as MessageParam)
        continue
      }
      const content: ContentBlockParam[] = []
      for (const b of m.content) {
        if (isAttachmentRef(b)) content.push(...(await this.load(b.attachmentId)))
        else content.push(b)
      }
      out.push({ role: m.role, content })
    }
    return out
  }
}

/** A stored file's bytes, or null when the store has nothing under its key. */
export async function readAll(store: ImageStorage, key: string): Promise<Buffer | null> {
  const stored = await store.get(key)
  if (!stored) return null
  const chunks: Buffer[] = []
  for await (const chunk of stored.stream) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer))
  return Buffer.concat(chunks)
}

// ---- Checking the bytes ------------------------------------------------------------------

/** A JPEG's width and height from its frame header; null for bytes that are not a JPEG with one. */
export function jpegSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return null
  let at = 2
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return null
    const marker = bytes[at + 1]
    // Fill bytes, and markers that carry no length.
    if (marker === 0xff) {
      at++
      continue
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2
      continue
    }
    if (marker === 0xd9 || marker === 0xda) return null
    const length = bytes.readUInt16BE(at + 2)
    if (length < 2) return null
    // Start of frame: every SOFn but DHT (c4), JPG (c8) and DAC (cc).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (at + 9 > bytes.length) return null
      const height = bytes.readUInt16BE(at + 5)
      const width = bytes.readUInt16BE(at + 7)
      return width > 0 && height > 0 ? { width, height } : null
    }
    at += 2 + length
  }
  return null
}

export const isPdf = (bytes: Buffer): boolean => bytes.length >= 5 && bytes.subarray(0, 5).toString('latin1') === '%PDF-'

/** A preview a photo may carry: a small JPEG data URL. */
const THUMBNAIL_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/
export const MAX_THUMBNAIL_CHARS = 60_000
export const isThumbnail = (v: string): boolean => v.length <= MAX_THUMBNAIL_CHARS && THUMBNAIL_RE.test(v)

/** A file's kind by its bytes, with what it is served as; refused with a word on what is accepted. */
export function sniffAttachment(bytes: Buffer): { kind: 'image' | 'pdf'; mimeType: string; width?: number; height?: number } {
  if (isPdf(bytes)) return { kind: 'pdf', mimeType: 'application/pdf' }
  const size = jpegSize(bytes)
  if (size) {
    if (Math.max(size.width, size.height) > AI_IMAGE_LONG_EDGE) {
      throw badRequest(`A photo may be at most ${AI_IMAGE_LONG_EDGE} pixels on its long side. Attach it from the app, which makes it so.`)
    }
    return { kind: 'image', mimeType: 'image/jpeg', ...size }
  }
  throw badRequest('Only photos, PDFs and spreadsheets (.xlsx, .csv) can be attached.')
}

// ---- Keeping and listing ------------------------------------------------------------------

/** Files a person may hold attached and not yet sent. */
export const MAX_PENDING_ATTACHMENTS = 20

export function buildAiAttachmentKey(id: string, kind: 'image' | 'pdf'): string {
  return kind === 'image' ? `images/ai/${id}.jpg` : `documents/ai/${id}.pdf`
}

export const sha256Hex = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')

const ATTACHMENT_SELECT = `a.id, a.kind, a.original_filename AS name, a.byte_size AS "byteSize", a.input_tokens AS tokens,
  a.width, a.height, a.thumbnail_data_url AS "thumbnailDataUrl", a.summary`

/** The app's view of a stored file: what it is, never its bytes or its text. */
function toAttachment(row: AiAttachment & { width: number | null; height: number | null; thumbnailDataUrl: string | null; summary: string | null }): AiAttachment {
  const a: AiAttachment = { id: row.id, kind: row.kind, name: row.name, byteSize: row.byteSize, tokens: row.tokens }
  if (row.width !== null && row.height !== null) {
    a.width = row.width
    a.height = row.height
  }
  if (row.thumbnailDataUrl) a.thumbnailDataUrl = row.thumbnailDataUrl
  if (row.summary) a.summary = row.summary
  return a
}

/** Refuse a new file while the person holds too many attached and not yet sent. */
export async function checkPending(q: Queryable, userId: string): Promise<void> {
  const { rows } = await q.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ai_attachments WHERE user_id = $1 AND turn_id IS NULL AND deleted_at IS NULL AND created_at > now() - interval '1 day'`,
    [userId],
  )
  if (rows[0].n >= MAX_PENDING_ATTACHMENTS) {
    throw new HttpError(429, 'rate_limited', `You have ${MAX_PENDING_ATTACHMENTS} files attached and not sent. Send them, or remove some, first.`)
  }
}

/** Refuse a file that alone would take more of Claude's reading than one file may. */
export function checkTokens(tokens: number): void {
  if (tokens > AI_MAX_ATTACHMENT_TOKENS) {
    throw badRequest(
      `This file is about ${tokens.toLocaleString('en-US')} tokens for Claude to read — more than the ${AI_MAX_ATTACHMENT_TOKENS.toLocaleString('en-US')} one file may take. Attach only the pages or rows you need.`,
    )
  }
}

export interface NewAttachment {
  userId: string
  kind: AiAttachmentKind
  name: string
  mimeType: string
  byteSize: number
  sha256: string
  storageKey: string | null
  driver: string | null
  width?: number
  height?: number
  thumbnailDataUrl?: string | null
  contentText?: string
  summary?: string
  tokens: number
  tokenModel: string
}

export async function insertAttachment(q: Queryable, a: NewAttachment & { id?: string }): Promise<AiAttachment> {
  const { rows } = await q.query(
    `INSERT INTO ai_attachments AS a (id, user_id, kind, original_filename, mime_type, byte_size, sha256, storage_key, driver, width, height,
                                     thumbnail_data_url, content_text, summary, input_tokens, token_model)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     RETURNING ${ATTACHMENT_SELECT}`,
    [
      a.id ?? randomUUID(),
      a.userId,
      a.kind,
      a.name,
      a.mimeType,
      a.byteSize,
      a.sha256,
      a.storageKey,
      a.driver,
      a.width ?? null,
      a.height ?? null,
      a.thumbnailDataUrl ?? null,
      a.contentText ?? null,
      a.summary ?? null,
      a.tokens,
      a.tokenModel,
    ],
  )
  return toAttachment(rows[0] as Parameters<typeof toAttachment>[0])
}

/** Take a file off a question before it is sent; one sent already, or someone else's, is not found. */
export async function removePending(q: Queryable, userId: string, id: string): Promise<boolean> {
  const { rowCount } = await q.query(`UPDATE ai_attachments SET deleted_at = now() WHERE id = $1 AND user_id = $2 AND turn_id IS NULL AND deleted_at IS NULL`, [id, userId])
  return !!rowCount
}

/**
 * The files a question carries, taken for it in the order given: each must be
 * the asker's, attached and not yet sent or removed. The conversation, with
 * them, stays within its bounds. Returns their references, for the question's
 * stored message.
 */
export async function takeAttachments(q: Queryable, args: { userId: string; conversationId: string; turnId: string; ids: readonly string[] }): Promise<AttachmentRef[]> {
  if (args.ids.length === 0) return []
  if (args.ids.length > AI_MAX_ATTACHMENTS_PER_QUESTION) throw badRequest(`A question may carry at most ${AI_MAX_ATTACHMENTS_PER_QUESTION} files.`)
  if (new Set(args.ids).size !== args.ids.length) throw badRequest('Each file once.')
  const { rows } = await q.query<{ id: string; tokens: number; byteSize: number; kind: AiAttachmentKind }>(
    `SELECT id, input_tokens AS tokens, byte_size AS "byteSize", kind FROM ai_attachments
      WHERE id = ANY($1::uuid[]) AND user_id = $2 AND turn_id IS NULL AND deleted_at IS NULL FOR UPDATE`,
    [args.ids, args.userId],
  )
  if (rows.length !== args.ids.length) throw new HttpError(404, 'not_found', 'One of the files is no longer attached. Attach it again.')
  const { rows: held } = await q.query<{ n: number; bytes: number; tokens: number }>(
    `SELECT count(*)::int AS n, COALESCE(sum(byte_size) FILTER (WHERE kind <> 'sheet'), 0)::bigint AS bytes, COALESCE(sum(input_tokens), 0)::bigint AS tokens
       FROM ai_attachments WHERE conversation_id = $1`,
    [args.conversationId],
  )
  const n = held[0].n + rows.length
  const bytes = Number(held[0].bytes) + rows.reduce((s, r) => s + (r.kind === 'sheet' ? 0 : r.byteSize), 0)
  const tokens = Number(held[0].tokens) + rows.reduce((s, r) => s + r.tokens, 0)
  const startNew = ' Start a new conversation for these files.'
  if (n > AI_MAX_ATTACHMENTS_PER_CONVERSATION) throw badRequest(`A conversation may carry at most ${AI_MAX_ATTACHMENTS_PER_CONVERSATION} files.${held[0].n > 0 ? startNew : ''}`)
  if (bytes > AI_MAX_CONVERSATION_ATTACHMENT_BYTES) {
    throw badRequest(`The photos and PDFs of one conversation may come to ${AI_MAX_CONVERSATION_ATTACHMENT_BYTES / 1024 / 1024} MB at most.${held[0].n > 0 ? startNew : ''}`)
  }
  if (tokens > AI_MAX_CONVERSATION_ATTACHMENT_TOKENS) {
    throw badRequest(
      `The files of one conversation may take ${AI_MAX_CONVERSATION_ATTACHMENT_TOKENS.toLocaleString('en-US')} tokens of Claude's reading at most; these come to ${tokens.toLocaleString('en-US')}.${held[0].n > 0 ? startNew : ''}`,
    )
  }
  const byId = new Map(rows.map((r) => [r.id, r]))
  const refs: AttachmentRef[] = []
  for (const [position, id] of args.ids.entries()) {
    await q.query(`UPDATE ai_attachments SET conversation_id = $2, turn_id = $3, position = $4 WHERE id = $1`, [id, args.conversationId, args.turnId, position])
    refs.push({ type: 'qc_attachment', attachmentId: id, tokens: byId.get(id)!.tokens })
  }
  return refs
}

/** The files of a conversation's questions (of one, with `turnId`), by question, in order. */
export async function loadTurnAttachments(q: Queryable, conversationId: string, turnId?: string): Promise<Map<string, AiAttachment[]>> {
  const { rows } = await q.query<Parameters<typeof toAttachment>[0] & { turnId: string }>(
    `SELECT a.turn_id AS "turnId", ${ATTACHMENT_SELECT} FROM ai_attachments a
      WHERE a.conversation_id = $1 AND ($2::uuid IS NULL OR a.turn_id = $2) ORDER BY a.turn_id, a.position`,
    [conversationId, turnId ?? null],
  )
  const out = new Map<string, AiAttachment[]>()
  for (const r of rows) {
    const list = out.get(r.turnId)
    if (list) list.push(toAttachment(r))
    else out.set(r.turnId, [toAttachment(r)])
  }
  return out
}

/** A file the person may read back: their own, attached or sent in a conversation they have not deleted. */
export async function findOwnAttachment(
  db: Db,
  userId: string,
  id: string,
): Promise<{ storageKey: string | null; mimeType: string; name: string; sha256: string; byteSize: number } | null> {
  const { rows } = await db.query<{ storageKey: string | null; mimeType: string; name: string; sha256: string; byteSize: number }>(
    `SELECT a.storage_key AS "storageKey", a.mime_type AS "mimeType", a.original_filename AS name, a.sha256, a.byte_size AS "byteSize"
       FROM ai_attachments a LEFT JOIN ai_conversations c ON c.id = a.conversation_id
      WHERE a.id = $1 AND a.user_id = $2 AND a.deleted_at IS NULL AND (a.conversation_id IS NULL OR c.deleted_at IS NULL)`,
    [id, userId],
  )
  return rows[0] ?? null
}
