// ============================================================================
// §21 — what the assistant proposed. Every propose_automation call leaves a
// proposal: the draft as checked, what running it once found, and — when it
// did not pass — why. It is stored with the answer that made it, in the same
// transaction as the call and its result, and the answer's card shows it in
// its CURRENT state: proposed, activated (with the automation it became), or
// discarded. Only the person who asked may activate or discard it; a proposal
// is decided once.
// ============================================================================

import type { AiAutomationPart, AutomationBacktest, AutomationDraft, AutomationProposalState } from '@qc/shared/automation'
import type { Queryable } from '../db/pool'
import { assigneeView, namedUserIds, peopleById, recipientViews } from './labels'

export interface ProposalRecord {
  id: string
  userId: string
  toolUseId: string
  ok: boolean
  error: string | null
  draft: AutomationDraft | null
  backtest: AutomationBacktest | null
}

/** Store proposals with the answer that made them, in its transaction. */
export async function insertProposals(q: Queryable, conversationId: string, turnId: string, proposals: ProposalRecord[]): Promise<void> {
  for (const p of proposals) {
    await q.query(
      `INSERT INTO ai_automation_proposals (id, user_id, conversation_id, turn_id, tool_use_id, ok, error, draft, backtest)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::json, $9::json)`,
      [p.id, p.userId, conversationId, turnId, p.toolUseId, p.ok, p.error, p.draft ? JSON.stringify(p.draft) : null, p.backtest ? JSON.stringify(p.backtest) : null],
    )
  }
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
       p.draft, p.backtest, p.state, p.automation_id AS "automationId", u.name AS "creatorName",
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
