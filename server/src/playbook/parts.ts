// ============================================================================
// The playbook cards the assistant left in a conversation: what each change
// saved, and how its entry stands now (as it left it, changed since, or
// removed). Apart from the service, so the transcript reads them without
// loading what the service needs.
// ============================================================================

import type { AiPlaybookPart, PlaybookKind, PlaybookScope } from '@qc/shared/playbook'
import type { Queryable } from '../db/pool'

/** The playbook cards of a conversation's answers (of one, with `turnId`), by the tool call that made each, as each entry stands now. */
export async function loadPlaybookParts(q: Queryable, conversationId: string, turnId?: string): Promise<Map<string, AiPlaybookPart>> {
  const { rows } = await q.query<{
    changeId: string
    toolUseId: string
    entryId: string
    action: AiPlaybookPart['action']
    scope: PlaybookScope
    kind: PlaybookKind
    text: string
    basis: string
    removed: boolean
    latest: boolean
  }>(
    `SELECT c.id AS "changeId", c.tool_use_id AS "toolUseId", c.entry_id AS "entryId", c.action, e.scope, e.kind,
            COALESCE(c.body_after, c.body_before) AS text, COALESCE(c.basis_after, c.basis_before, '') AS basis,
            (e.deleted_at IS NOT NULL) AS removed,
            NOT EXISTS (SELECT 1 FROM ai_playbook_changes later WHERE later.entry_id = c.entry_id AND (later.created_at, later.id) > (c.created_at, c.id)) AS latest
       FROM ai_playbook_changes c JOIN ai_playbook_entries e ON e.id = c.entry_id
      WHERE c.conversation_id = $1 AND ($2::uuid IS NULL OR c.turn_id = $2)`,
    [conversationId, turnId ?? null],
  )
  return new Map(
    rows.map((r) => [
      r.toolUseId,
      {
        type: 'playbook',
        changeId: r.changeId,
        entryId: r.entryId,
        action: r.action,
        scope: r.scope,
        kind: r.kind,
        text: r.text,
        basis: r.basis,
        state: r.removed ? 'removed' : r.latest ? 'current' : 'changed',
      } satisfies AiPlaybookPart,
    ]),
  )
}
