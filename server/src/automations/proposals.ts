// ============================================================================
// §21 — what the assistant proposed. Every propose_automation call leaves a
// proposal: the draft as checked, what running it once found, and — when it
// did not pass — why. It is stored with the answer that made it, in the same
// transaction as the call and its result, and the answer's card shows it in
// its CURRENT state: proposed, activated (with the automation it became),
// discarded, or superseded. Only the person who asked may activate or discard
// it; a proposal is decided once.
//
// §22 — a proposal keeps the person's words of agreement the assistant quoted
// (confirmation.ts). A new version of a proposal of the same conversation
// (revisesProposalId) supersedes it, in the transaction that stores the new
// one and only when the new one passed: the older card then says it was
// replaced, and it can no longer be activated. A version of one already
// activated is proposed as a change of the automation it became
// (replacesAutomationId) instead, and the model is told so.
// ============================================================================

import type { AiAutomationPart, AutomationBacktest, AutomationDraft, AutomationProposalState } from '@qc/shared/automation'
import type { Queryable } from '../db/pool'
import { cutChars } from '../ai/blocks'
import { assigneeView, namedUserIds, peopleById, recipientViews } from './labels'
import { isUuid } from './people'

export interface ProposalRecord {
  id: string
  userId: string
  toolUseId: string
  ok: boolean
  error: string | null
  draft: AutomationDraft | null
  backtest: AutomationBacktest | null
  /** §22 — the person's words of agreement, as the assistant quoted them; null in a conversation whose tool asks for none. */
  confirmation: string | null
}

/** Store proposals with the answer that made them, in its transaction. */
export async function insertProposals(q: Queryable, conversationId: string, turnId: string, proposals: ProposalRecord[]): Promise<void> {
  for (const p of proposals) {
    await q.query(
      `INSERT INTO ai_automation_proposals (id, user_id, conversation_id, turn_id, tool_use_id, ok, error, draft, backtest, confirmation)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::json, $9::json, $10)`,
      [
        p.id,
        p.userId,
        conversationId,
        turnId,
        p.toolUseId,
        p.ok,
        p.error,
        p.draft ? JSON.stringify(p.draft) : null,
        p.backtest ? JSON.stringify(p.backtest) : null,
        p.confirmation,
      ],
    )
  }
}

/** What a draft's revisesProposalId means: what is wrong with it, or the proposal it supersedes once stored (none, when there is nothing left to mark). */
export interface Revision {
  errors: string[]
  supersedes: string | null
  /** The proposal was activated: the automation it became, still there, which a new version changes instead. */
  became?: string
}

const quotedId = (s: string) => `"${cutChars(s, 60, true)}"`

/**
 * Check the proposal a new one revises: one of the same conversation, made
 * for the same person. One still proposed (and passed) is superseded when
 * the new one is stored; one discarded, superseded already or that did not
 * pass leaves nothing to mark. One activated is an automation now: a new
 * version of it is a change of that automation (`became`; tools.ts proposes
 * it so), and only when that cannot be does the model get the error.
 */
export async function checkRevision(q: Queryable, conversationId: string, userId: string, revisesProposalId: string): Promise<Revision> {
  if (!isUuid(revisesProposalId)) return { errors: [`revisesProposalId: ${quotedId(revisesProposalId)} is not a proposal id.`], supersedes: null }
  const { rows } = await q.query<{ ok: boolean; state: AutomationProposalState; automationId: string | null; automationExists: boolean }>(
    `SELECT p.ok, p.state, p.automation_id AS "automationId",
            EXISTS (SELECT 1 FROM ai_automations a WHERE a.id = p.automation_id AND a.deleted_at IS NULL) AS "automationExists"
       FROM ai_automation_proposals p
      WHERE p.id = $1 AND p.conversation_id = $2 AND p.user_id = $3`,
    [revisesProposalId, conversationId, userId],
  )
  const revised = rows[0]
  if (!revised) {
    return { errors: ['revisesProposalId: no proposal of this conversation has that id (each propose_automation result names its proposalId).'], supersedes: null }
  }
  if (revised.state === 'activated') {
    return {
      errors: [
        revised.automationExists
          ? `revisesProposalId: that proposal was activated and is now the automation ${revised.automationId}. To change it, set replacesAutomationId to "${revised.automationId}" and leave revisesProposalId out.`
          : 'revisesProposalId: that proposal was activated, and the automation it became has since been deleted. Propose this as a new automation and leave revisesProposalId out.',
      ],
      supersedes: null,
      ...(revised.automationExists && revised.automationId ? { became: revised.automationId } : {}),
    }
  }
  return { errors: [], supersedes: revised.ok && revised.state === 'proposed' ? revisesProposalId.toLowerCase() : null }
}

/**
 * Mark a proposal superseded by a newer version, in the transaction that
 * stores that version. Only while it is still proposed: one activated or
 * discarded meanwhile (its card pressed while the model was writing) keeps
 * what the person decided — and a version of one activated so is refused when
 * it is activated in turn (lifecycle.ts), never a second automation. The
 * person who asked for the new version decided it.
 */
export async function supersedeProposal(q: Queryable, proposalId: string, userId: string): Promise<void> {
  await q.query(
    `UPDATE ai_automation_proposals SET state = 'superseded', decided_by_id = $2, decided_at = now()
      WHERE id = $1 AND user_id = $2 AND ok AND state = 'proposed'`,
    [proposalId, userId],
  )
}

export interface StoredProposal extends ProposalRecord {
  conversationId: string
  state: AutomationProposalState
  automationId: string | null
  creatorName: string
  /** The automation it changes, as it is named now (and whether it still exists). */
  replacesName: string | null
}

const PROPOSAL_COLUMNS = `p.id, p.user_id AS "userId", p.conversation_id AS "conversationId", p.tool_use_id AS "toolUseId", p.ok, p.error,
       p.draft, p.backtest, p.confirmation, p.state, p.automation_id AS "automationId", u.name AS "creatorName",
       (SELECT r.name FROM ai_automations r WHERE r.id::text = p.draft ->> 'replacesAutomationId' AND r.deleted_at IS NULL) AS "replacesName"`

/** The person's own proposal; someone else's is "not found". `forUpdate` locks it. */
export async function findProposal(q: Queryable, id: string, userId: string, forUpdate = false): Promise<StoredProposal | null> {
  const { rows } = await q.query<StoredProposal>(
    `SELECT ${PROPOSAL_COLUMNS} FROM ai_automation_proposals p JOIN users u ON u.id = p.user_id
      WHERE p.id = $1 AND p.user_id = $2${forUpdate ? ' FOR UPDATE OF p' : ''}`,
    [id, userId],
  )
  return rows[0] ?? null
}

/** Proposals' cards, as they stand now; one read of names for them all. */
export async function proposalParts(q: Queryable, proposals: StoredProposal[]): Promise<AiAutomationPart[]> {
  const people = await peopleById(
    q,
    proposals.flatMap((p) => (p.draft ? namedUserIds(p.draft.recipients, p.draft.actions) : [])),
  )
  return proposals.map((p) => {
    const part: AiAutomationPart = { type: 'automation', proposalId: p.id, ok: p.ok, state: p.state }
    if (p.error) part.error = p.error
    if (p.draft) {
      part.draft = p.draft
      // A watch's columns as its backtest found them: a recipient column the result lacks reads as invalid.
      const columns = p.draft.kind === 'watch' && p.backtest?.ok ? (p.backtest.columns ?? null) : null
      part.recipients = recipientViews(p.draft.recipients, people, columns)
      if (p.draft.actions.followUp) part.assignee = assigneeView(p.draft.actions.followUp.assignee, people, { name: p.creatorName }, columns)
    }
    if (p.backtest) part.backtest = p.backtest
    if (p.automationId) part.automationId = p.automationId
    if (p.replacesName) part.replacesName = p.replacesName
    return part
  })
}

/** One proposal's card, as it stands now. */
export async function proposalPart(q: Queryable, p: StoredProposal): Promise<AiAutomationPart> {
  return (await proposalParts(q, [p]))[0]
}

/** The cards of a conversation's proposals (one turn's, when given), by the tool call that made each. */
export async function loadProposalParts(q: Queryable, conversationId: string, turnId?: string): Promise<Map<string, AiAutomationPart>> {
  const { rows } = await q.query<StoredProposal>(
    `SELECT ${PROPOSAL_COLUMNS} FROM ai_automation_proposals p JOIN users u ON u.id = p.user_id
      WHERE p.conversation_id = $1 AND ($2::uuid IS NULL OR p.turn_id = $2)`,
    [conversationId, turnId ?? null],
  )
  const parts = await proposalParts(q, rows)
  return new Map(rows.map((r, i) => [r.toolUseId, parts[i]]))
}
