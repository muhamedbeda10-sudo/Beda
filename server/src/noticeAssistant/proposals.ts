// ============================================================================
// §23 — the notice cards the assistant made. Every propose_notice_change call
// whose action could be read leaves one: what it would do, as checked — or
// why it did not pass. It is stored with the answer that made it, in the same
// transaction as the call and its result, and the answer shows it in its
// CURRENT state: proposed, applied (naming the notice, and who pressed the
// button when), discarded, superseded by a newer version of it, or stale (the
// notice changed after the card was made). Only the person who asked may
// apply or discard it, once (lifecycle.ts).
//
// A new version of a card of the same conversation (revisesProposalId)
// supersedes it in the transaction that stores the new one, and only when
// the new one passed — as automations' proposals do (§22). All the versions
// of a card are one notice: of the new notices among them, only one is ever
// published (noticeVersions; lifecycle.ts).
// ============================================================================

import type { AiNoticeAction, AiNoticeDraft, AiNoticePart, AiNoticeProposalState, AiNoticeReach } from '@qc/shared/noticeAssistant'
import type { Queryable } from '../db/pool'
import { cutChars } from '../ai/blocks'
import { isUuid } from '../automations/people'

export interface NoticeProposalRecord {
  id: string
  userId: string
  toolUseId: string
  action: AiNoticeAction
  noticeId: string | null
  draft: AiNoticeDraft | null
  before: AiNoticeDraft | null
  /** notices.updated_at when the card was made, as PostgreSQL writes it (to the microsecond). */
  noticeUpdatedAt: string | null
  reach: AiNoticeReach | null
  revisesProposalId: string | null
  ok: boolean
  error: string | null
}

/** Store cards with the answer that made them, in its transaction. */
export async function insertNoticeProposals(q: Queryable, conversationId: string, turnId: string, records: NoticeProposalRecord[]): Promise<void> {
  for (const p of records) {
    await q.query(
      `INSERT INTO ai_notice_proposals (id, user_id, conversation_id, turn_id, tool_use_id, action, notice_id, draft, before, notice_updated_at,
                                        reach, revises_proposal_id, ok, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::json, $9::json, $10::timestamptz, $11::json, $12, $13, $14)`,
      [
        p.id,
        p.userId,
        conversationId,
        turnId,
        p.toolUseId,
        p.action,
        p.noticeId,
        p.draft ? JSON.stringify(p.draft) : null,
        p.before ? JSON.stringify(p.before) : null,
        p.noticeUpdatedAt,
        p.reach ? JSON.stringify(p.reach) : null,
        p.revisesProposalId,
        p.ok,
        p.error,
      ],
    )
  }
}

/** What a card's revisesProposalId means: what is wrong with it, the card it names, and the one it supersedes once stored (none when there is nothing left to mark). */
export interface NoticeRevision {
  errors: string[]
  revises: string | null
  supersedes: string | null
}

const quotedId = (s: string) => `"${cutChars(s, 60, true)}"`

/** A version of a new notice that was published: the notice it made, and whether that is still there. */
export interface PublishedVersion {
  proposalId: string
  noticeId: string
  noticeLive: boolean
}

/**
 * A card's versions: every card of its conversation linked to it through
 * revisesProposalId — back to the first and on to every later one, one card
 * revised twice giving two versions side by side. They are all versions of
 * one notice, so of the new notices among them only one may ever be
 * published. `first`: the one card they all go back to.
 */
export async function noticeVersions(q: Queryable, conversationId: string, proposalId: string): Promise<{ first: string; published: PublishedVersion | null }> {
  // A conversation holds a handful of cards: read once, walked here.
  const { rows } = await q.query<{ id: string; revises: string | null; action: AiNoticeAction; state: AiNoticeProposalState; noticeId: string | null; noticeLive: boolean }>(
    `SELECT p.id, p.revises_proposal_id AS revises, p.action, p.state, p.notice_id AS "noticeId",
            EXISTS (SELECT 1 FROM notices n WHERE n.id = p.notice_id AND n.deleted_at IS NULL) AS "noticeLive"
       FROM ai_notice_proposals p
      WHERE p.conversation_id = $1`,
    [conversationId],
  )
  const byId = new Map(rows.map((r) => [r.id, r]))
  const firsts = new Map<string, string>()
  const firstOf = (id: string): string => {
    const path: string[] = []
    let at = id
    // A card names only one stored before it, so the walk ends; the guard is for a link no card should have.
    while (!firsts.has(at) && !path.includes(at)) {
      path.push(at)
      const up = byId.get(at)?.revises
      if (!up || !byId.has(up)) break
      at = up
    }
    const first = firsts.get(at) ?? at
    for (const p of path) firsts.set(p, first)
    return first
  }
  const first = firstOf(proposalId)
  const made = rows.find((r) => r.action === 'create' && r.state === 'applied' && r.noticeId && firstOf(r.id) === first)
  return { first, published: made ? { proposalId: made.id, noticeId: made.noticeId!, noticeLive: made.noticeLive } : null }
}

/**
 * Check the card a new one revises: one of the same conversation, made for
 * the same person. One still proposed (and passed) is superseded when the new
 * one is stored; one discarded, superseded, stale already or that did not
 * pass leaves nothing to mark. One applied has done what it did: a new
 * version of it would do it twice, so the model is told what to ask for
 * instead — as when another version of it published its notice already
 * (pressed while a later version was being written, say).
 */
export async function checkNoticeRevision(q: Queryable, conversationId: string, userId: string, revisesProposalId: string, action: AiNoticeAction): Promise<NoticeRevision> {
  const none = (error: string): NoticeRevision => ({ errors: [error], revises: null, supersedes: null })
  // A change, a withdrawal or a deletion names its notice: a link to a card already done leaves nothing to replace
  // and nothing it could do twice, so it is let go rather than shown as a card that did not pass. Only a new notice
  // after a published version would be the same notice twice.
  const unlinked: NoticeRevision = { errors: [], revises: null, supersedes: null }
  if (!isUuid(revisesProposalId)) return none(`revisesProposalId: ${quotedId(revisesProposalId)} is not a proposal id.`)
  const { rows } = await q.query<{ id: string; ok: boolean; state: AiNoticeProposalState; action: AiNoticeAction; noticeId: string | null; noticeLive: boolean }>(
    `SELECT p.id, p.ok, p.state, p.action, p.notice_id AS "noticeId",
            EXISTS (SELECT 1 FROM notices n WHERE n.id = p.notice_id AND n.deleted_at IS NULL) AS "noticeLive"
       FROM ai_notice_proposals p
      WHERE p.id = $1 AND p.conversation_id = $2 AND p.user_id = $3`,
    [revisesProposalId, conversationId, userId],
  )
  const revised = rows[0]
  if (!revised) return none('revisesProposalId: no card of this conversation has that id (each propose_notice_change result names its proposalId).')
  if (revised.state === 'applied') {
    if (action !== 'create') return unlinked
    const what =
      revised.action === 'create'
        ? revised.noticeLive
          ? `that card was published: it is the notice ${revised.noticeId} now. To change it, propose an update with noticeId "${revised.noticeId}" and leave revisesProposalId out.`
          : 'that card was published, and the notice it made has since been deleted. Propose this as a new notice and leave revisesProposalId out.'
        : revised.noticeLive
          ? `that card was applied already. To change the notice again, propose a new ${revised.action === 'update' ? 'update' : 'change'} of notice ${revised.noticeId} and leave revisesProposalId out.`
          : 'that card was applied already, and its notice is deleted now. Leave revisesProposalId out.'
    return none(`revisesProposalId: ${what}`)
  }
  const { published } = await noticeVersions(q, conversationId, revised.id)
  if (published) {
    if (action !== 'create') return unlinked
    return none(
      published.noticeLive
        ? `revisesProposalId: another version of that card was published: it is the notice ${published.noticeId} now. To change it, propose an update with noticeId "${published.noticeId}" and leave revisesProposalId out.`
        : 'revisesProposalId: another version of that card was published, and the notice it made has since been deleted. Propose this as a new notice and leave revisesProposalId out.',
    )
  }
  return { errors: [], revises: revised.id, supersedes: revised.ok && revised.state === 'proposed' ? revised.id : null }
}

/**
 * Mark a card superseded by a newer version, in the transaction that stores
 * that version. Only while it is still proposed: one applied or discarded
 * meanwhile (its button pressed while the model was writing) keeps what the
 * person decided; a new version of a new notice already published is refused
 * when it is applied in turn (lifecycle.ts), never a second notice.
 */
export async function supersedeNoticeProposal(q: Queryable, proposalId: string, userId: string): Promise<void> {
  await q.query(`UPDATE ai_notice_proposals SET state = 'superseded' WHERE id = $1 AND user_id = $2 AND ok AND state = 'proposed'`, [proposalId, userId])
}

export interface StoredNoticeProposal extends NoticeProposalRecord {
  conversationId: string
  state: AiNoticeProposalState
  appliedAt: string | null
  appliedByName: string | null
}

const PROPOSAL_COLUMNS = `p.id, p.user_id AS "userId", p.conversation_id AS "conversationId", p.tool_use_id AS "toolUseId", p.action,
       p.notice_id AS "noticeId", p.draft, p.before, p.notice_updated_at::text AS "noticeUpdatedAt", p.reach,
       p.revises_proposal_id AS "revisesProposalId", p.ok, p.error, p.state, p.applied_at AS "appliedAt", a.name AS "appliedByName"`
const PROPOSAL_FROM = `ai_notice_proposals p LEFT JOIN users a ON a.id = p.applied_by`

/** The person's own card; someone else's is "not found". `forUpdate` locks it (the card alone, not the account that applied it). */
export async function findNoticeProposal(q: Queryable, id: string, userId: string, forUpdate = false): Promise<StoredNoticeProposal | null> {
  if (!isUuid(id)) return null
  const { rows } = await q.query<StoredNoticeProposal>(
    `SELECT ${PROPOSAL_COLUMNS} FROM ${PROPOSAL_FROM} WHERE p.id = $1 AND p.user_id = $2${forUpdate ? ' FOR UPDATE OF p' : ''}`,
    [id, userId],
  )
  return rows[0] ?? null
}

/** A card as it stands now. */
export function noticePart(p: StoredNoticeProposal): AiNoticePart {
  const part: AiNoticePart = { type: 'notice', proposalId: p.id, ok: p.ok, action: p.action, state: p.state }
  if (p.error) part.error = p.error
  if (p.noticeId) part.noticeId = p.noticeId
  if (p.draft) part.draft = p.draft
  if (p.before) part.before = p.before
  if (p.reach) part.reach = p.reach
  if (p.appliedAt) part.appliedAt = p.appliedAt
  if (p.appliedByName) part.appliedByName = p.appliedByName
  return part
}

/** A card as it was just made, before it is stored: proposed. */
export function freshNoticePart(p: NoticeProposalRecord, conversationId: string): AiNoticePart {
  return noticePart({ ...p, conversationId, state: 'proposed', appliedAt: null, appliedByName: null })
}

/** The cards of a conversation (one turn's, when given), by the tool call that made each. */
export async function loadNoticeParts(q: Queryable, conversationId: string, turnId?: string): Promise<Map<string, AiNoticePart>> {
  const { rows } = await q.query<StoredNoticeProposal>(
    `SELECT ${PROPOSAL_COLUMNS} FROM ${PROPOSAL_FROM} WHERE p.conversation_id = $1 AND ($2::uuid IS NULL OR p.turn_id = $2)`,
    [conversationId, turnId ?? null],
  )
  return new Map(rows.map((r) => [r.toolUseId, noticePart(r)]))
}
