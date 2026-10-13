// ============================================================================
// The task cards the assistant drafted, as the conversation shows them: each
// as it stands now (proposed, sent with its task's number, discarded, or
// replaced by a newer one). Apart from the tools (assistant.ts), so the
// transcript reads them without loading what the tools need.
// ============================================================================

import type { AiTaskDraft, AiTaskPart } from '@qc/shared/ai'
import type { Queryable } from '../db/pool'

export interface ProposalRow {
  id: string
  toolUseId: string
  ok: boolean
  error: string | null
  draft: AiTaskDraft | null
  status: AiTaskPart['state']
  taskId: string | null
  taskNumber: number | null
}

export const toPart = (r: ProposalRow): AiTaskPart => {
  const part: AiTaskPart = { type: 'task', proposalId: r.id, ok: r.ok, state: r.status }
  if (r.error) part.error = r.error
  if (r.draft) part.draft = r.draft
  if (r.taskId) part.taskId = r.taskId
  if (r.taskNumber !== null) part.taskNumber = r.taskNumber
  return part
}

/** The task cards of a conversation's answers (of one, with `turnId`), by the tool call that made each. */
export async function loadTaskParts(q: Queryable, conversationId: string, turnId?: string): Promise<Map<string, AiTaskPart>> {
  const { rows } = await q.query<ProposalRow>(
    `SELECT p.id, p.tool_use_id AS "toolUseId", p.ok, p.error, p.draft, p.status, p.task_id AS "taskId", t.number AS "taskNumber"
       FROM ai_task_proposals p LEFT JOIN tasks t ON t.id = p.task_id
      WHERE p.conversation_id = $1 AND ($2::uuid IS NULL OR p.turn_id = $2)`,
    [conversationId, turnId ?? null],
  )
  return new Map(rows.map((r) => [r.toolUseId, toPart(r)]))
}
