// ============================================================================
// The assistant's playbook: a person's own instructions and conclusions, and
// the instructions the assistant's owner sets for everyone. Read into the
// system prompt of each new conversation; changed by the assistant (at the
// person's word, update_playbook) or on the Playbook page — both through
// here, with the same checks:
//
//   • only people given the assistant keep a playbook;
//   • a personal entry is its person's alone: anyone else's is "not found";
//   • only the assistant's owner sets, changes or removes one for everyone,
//     and those are instructions only;
//   • at most PLAYBOOK_MAX_PERSONAL entries a person, PLAYBOOK_MAX_SHARED for
//     everyone, counted under a lock so two saves at once cannot pass it.
//
// Every change is written to the append-only history, with the answer and
// the tool call when the assistant made it, and to the audit log.
// ============================================================================

import {
  PLAYBOOK_BASIS_MAX,
  PLAYBOOK_MAX_PERSONAL,
  PLAYBOOK_MAX_SHARED,
  PLAYBOOK_TEXT_MAX,
  type PlaybookEntry,
  type PlaybookKind,
  type PlaybookScope,
} from '@qc/shared/playbook'
import type { Queryable } from '../db/pool'
import { auditChanges, auditCreate, auditDelete } from '../audit/service'
import { isGranted, loadAccess } from '../ai/access'
import { HttpError, badRequest, notFound } from '../lib/errors'

export interface PlaybookActor {
  id: string
  name: string
  /** The assistant's owner, as of now: may set instructions for everyone. */
  owner: boolean
}

/** Where a change was made: the answer and the tool call, when the assistant made it. */
export interface PlaybookSource {
  conversationId: string
  turnId: string
  toolUseId: string
}

interface EntryRow {
  id: string
  scope: PlaybookScope
  userId: string | null
  kind: PlaybookKind
  body: string
  basis: string
  createdAt: string
  updatedAt: string
  createdByName: string
  conversationId: string | null
  lastByAssistant: boolean
}

const ENTRY_SELECT = `e.id, e.scope, e.user_id AS "userId", e.kind, e.body, e.basis, e.created_at AS "createdAt", e.updated_at AS "updatedAt",
  e.created_by_name AS "createdByName",
  last.conversation_id AS "conversationId", (last.conversation_id IS NOT NULL) AS "lastByAssistant"`
const LAST_CHANGE = `LEFT JOIN LATERAL (SELECT c.conversation_id FROM ai_playbook_changes c WHERE c.entry_id = e.id ORDER BY c.created_at DESC, c.id DESC LIMIT 1) last ON true`

/** Whether this person keeps a playbook now: the assistant is theirs. */
export async function mayUsePlaybook(q: Queryable, userId: string): Promise<boolean> {
  return isGranted(await loadAccess(q, userId))
}

const toEntry = (r: EntryRow, viewer: { id: string; owner: boolean }): PlaybookEntry => ({
  id: r.id,
  scope: r.scope,
  kind: r.kind,
  text: r.body,
  basis: r.basis,
  createdAt: new Date(r.createdAt).toISOString(),
  updatedAt: new Date(r.updatedAt).toISOString(),
  createdByName: r.createdByName,
  source: r.lastByAssistant ? 'assistant' : 'page',
  // A shared entry's conversation is the owner's: no one else may open it.
  conversationId: r.scope === 'personal' ? r.conversationId : viewer.owner ? r.conversationId : null,
  mayEdit: r.scope === 'personal' ? r.userId === viewer.id : viewer.owner,
})

/** The person's playbook: the instructions for everyone, then their own, oldest first. */
export async function listPlaybook(q: Queryable, viewer: { id: string; owner: boolean }): Promise<PlaybookEntry[]> {
  const { rows } = await q.query<EntryRow>(
    `SELECT ${ENTRY_SELECT} FROM ai_playbook_entries e ${LAST_CHANGE}
      WHERE e.deleted_at IS NULL AND (e.scope = 'shared' OR e.user_id = $1)
      ORDER BY (e.scope = 'personal'), e.created_at, e.id`,
    [viewer.id],
  )
  return rows.map((r) => toEntry(r, viewer))
}

/** What the system prompt of a new conversation says the person's playbook holds. */
export interface PromptPlaybook {
  shared: { id: string; text: string }[]
  instructions: { id: string; text: string; day: string }[]
  conclusions: { id: string; text: string; basis: string; day: string }[]
}

export async function promptPlaybook(q: Queryable, userId: string, timeZone: string): Promise<PromptPlaybook> {
  const { rows } = await q.query<{ id: string; scope: PlaybookScope; kind: PlaybookKind; body: string; basis: string; day: string }>(
    `SELECT e.id, e.scope, e.kind, e.body, e.basis, to_char(e.updated_at AT TIME ZONE $2, 'YYYY-MM-DD') AS day
       FROM ai_playbook_entries e
      WHERE e.deleted_at IS NULL AND (e.scope = 'shared' OR e.user_id = $1)
      ORDER BY e.created_at, e.id`,
    [userId, timeZone],
  )
  return {
    shared: rows.filter((r) => r.scope === 'shared').map((r) => ({ id: r.id, text: r.body })),
    instructions: rows.filter((r) => r.scope === 'personal' && r.kind === 'instruction').map((r) => ({ id: r.id, text: r.body, day: r.day })),
    conclusions: rows.filter((r) => r.scope === 'personal' && r.kind === 'conclusion').map((r) => ({ id: r.id, text: r.body, basis: r.basis, day: r.day })),
  }
}

// ---- Changes --------------------------------------------------------------------------------

const oneParagraph = (s: string) => s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()

function checkText(text: string): string {
  const t = oneParagraph(text)
  if (t === '') throw badRequest('Write what the assistant should follow or keep in mind.')
  if (t.length > PLAYBOOK_TEXT_MAX) throw badRequest(`An entry is at most ${PLAYBOOK_TEXT_MAX} characters: keep it to one clear point.`)
  return t
}

function checkBasis(kind: PlaybookKind, basis: string | undefined): string {
  const b = oneParagraph(basis ?? '')
  if (kind === 'instruction') {
    if (b !== '') throw badRequest('Only a conclusion has a basis.')
    return ''
  }
  if (b.length > PLAYBOOK_BASIS_MAX) throw badRequest(`A conclusion's basis is at most ${PLAYBOOK_BASIS_MAX} characters.`)
  return b
}

const forbidden = () => new HttpError(403, 'forbidden', 'The playbook is for the people given the AI assistant.')
const ownerOnly = () => new HttpError(403, 'forbidden', "Only the assistant's owner sets instructions for everyone.")

/** Two saves of one playbook at once take turns, so the count holds. */
async function lockPlaybook(tx: Queryable, scope: PlaybookScope, userId: string): Promise<void> {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [scope === 'shared' ? 'ai-playbook:shared' : `ai-playbook:${userId}`])
}

async function writeChange(
  tx: Queryable,
  c: { entryId: string; action: 'add' | 'change' | 'remove'; before: { body: string; basis: string } | null; after: { body: string; basis: string } | null; by: PlaybookActor; source?: PlaybookSource },
): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO ai_playbook_changes (entry_id, action, body_before, body_after, basis_before, basis_after, by_id, by_name, conversation_id, turn_id, tool_use_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [
      c.entryId,
      c.action,
      c.before?.body ?? null,
      c.after?.body ?? null,
      c.before?.basis ?? null,
      c.after?.basis ?? null,
      c.by.id,
      c.by.name,
      c.source?.conversationId ?? null,
      c.source?.turnId ?? null,
      c.source?.toolUseId ?? null,
    ],
  )
  return rows[0].id
}

const auditOf = (by: PlaybookActor, id: string) => ({ userId: by.id, userName: by.name, entity: 'AiPlaybook', entityId: id })

export interface PlaybookChange {
  changeId: string
  entry: { id: string; scope: PlaybookScope; kind: PlaybookKind; text: string; basis: string }
}

/** A new entry: the person's own, or — the owner only — an instruction for everyone. */
export async function addEntry(
  tx: Queryable,
  by: PlaybookActor,
  req: { scope: PlaybookScope; kind: PlaybookKind; text: string; basis?: string },
  source?: PlaybookSource,
): Promise<PlaybookChange> {
  if (!(await mayUsePlaybook(tx, by.id))) throw forbidden()
  if (req.scope === 'shared' && !by.owner) throw ownerOnly()
  if (req.scope === 'shared' && req.kind !== 'instruction') {
    throw badRequest('Only instructions are set for everyone: a conclusion comes from data its person may read, which others may not.')
  }
  const text = checkText(req.text)
  const basis = checkBasis(req.kind, req.basis)
  await lockPlaybook(tx, req.scope, by.id)
  const { rows: counted } = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ai_playbook_entries WHERE deleted_at IS NULL AND ${req.scope === 'shared' ? `scope = 'shared'` : 'user_id = $1'}`,
    req.scope === 'shared' ? [] : [by.id],
  )
  const max = req.scope === 'shared' ? PLAYBOOK_MAX_SHARED : PLAYBOOK_MAX_PERSONAL
  // The same words twice (a second save of one request) add nothing.
  const { rows: same } = await tx.query(
    `SELECT 1 FROM ai_playbook_entries WHERE deleted_at IS NULL AND scope = $1 AND user_id IS NOT DISTINCT FROM $2 AND lower(body) = lower($3)`,
    [req.scope, req.scope === 'personal' ? by.id : null, text],
  )
  if (same.length > 0) throw new HttpError(409, 'conflict', 'This is already in the playbook, in these words.')
  if (counted[0].n >= max) {
    throw new HttpError(409, 'conflict', `The playbook ${req.scope === 'shared' ? 'for everyone' : 'is'} full (${max} entries): remove or merge one first.`)
  }
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO ai_playbook_entries (scope, user_id, kind, body, basis, created_by_id, created_by_name) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [req.scope, req.scope === 'personal' ? by.id : null, req.kind, text, basis, by.id, by.name],
  )
  const id = rows[0].id
  const changeId = await writeChange(tx, { entryId: id, action: 'add', before: null, after: { body: text, basis }, by, source })
  await auditCreate(tx, auditOf(by, id))
  return { changeId, entry: { id, scope: req.scope, kind: req.kind, text, basis } }
}

/** One entry the person may change, locked; "not found" for another person's, or one removed. */
async function lockEntry(tx: Queryable, id: string, by: PlaybookActor): Promise<{ scope: PlaybookScope; kind: PlaybookKind; body: string; basis: string }> {
  const { rows } = await tx.query<{ scope: PlaybookScope; userId: string | null; kind: PlaybookKind; body: string; basis: string }>(
    `SELECT scope, user_id AS "userId", kind, body, basis FROM ai_playbook_entries WHERE id = $1 AND deleted_at IS NULL AND (scope = 'shared' OR user_id = $2) FOR UPDATE`,
    [id, by.id],
  )
  const e = rows[0]
  if (!e) throw notFound('That playbook entry')
  if (e.scope === 'shared' && !by.owner) throw ownerOnly()
  return e
}

/** New words (or basis) for an entry. Unchanged, nothing is written. */
export async function changeEntry(tx: Queryable, by: PlaybookActor, id: string, patch: { text?: string; basis?: string }, source?: PlaybookSource): Promise<PlaybookChange> {
  if (!(await mayUsePlaybook(tx, by.id))) throw forbidden()
  const e = await lockEntry(tx, id, by)
  const text = patch.text !== undefined ? checkText(patch.text) : e.body
  const basis = patch.basis !== undefined ? checkBasis(e.kind, patch.basis) : e.basis
  const entry = { id, scope: e.scope, kind: e.kind, text, basis }
  if (text === e.body && basis === e.basis) throw badRequest('Nothing to change: the entry already says exactly this.')
  await tx.query(`UPDATE ai_playbook_entries SET body = $2, basis = $3 WHERE id = $1`, [id, text, basis])
  const changeId = await writeChange(tx, { entryId: id, action: 'change', before: { body: e.body, basis: e.basis }, after: { body: text, basis }, by, source })
  await auditChanges(tx, auditOf(by, id), { text: e.body, basis: e.basis }, { text, basis })
  return { changeId, entry }
}

/** The entry taken out of the playbook; its history stays. */
export async function removeEntry(tx: Queryable, by: PlaybookActor, id: string, source?: PlaybookSource): Promise<PlaybookChange> {
  if (!(await mayUsePlaybook(tx, by.id))) throw forbidden()
  const e = await lockEntry(tx, id, by)
  await tx.query(`UPDATE ai_playbook_entries SET deleted_at = now() WHERE id = $1`, [id])
  const changeId = await writeChange(tx, { entryId: id, action: 'remove', before: { body: e.body, basis: e.basis }, after: null, by, source })
  await auditDelete(tx, auditOf(by, id))
  return { changeId, entry: { id, scope: e.scope, kind: e.kind, text: e.body, basis: e.basis } }
}
