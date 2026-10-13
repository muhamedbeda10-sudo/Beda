// ============================================================================
// The saved-table cards the assistant left in a conversation: what each
// change made, and how its table stands now (as it left it, changed since,
// or removed). Apart from the tools, so the transcript reads them without
// loading what the tools need.
// ============================================================================

import type { AiSavedTablePart } from '@qc/shared/savedTables'
import type { Queryable } from '../db/pool'

/** The saved-table cards of a conversation's answers (of one, with `turnId`), by the tool call that made each, as each table stands now. */
export async function loadSavedTableParts(q: Queryable, conversationId: string, turnId?: string): Promise<Map<string, AiSavedTablePart>> {
  const { rows } = await q.query<{
    changeId: string
    toolUseId: string
    tableId: string
    name: string
    title: string
    action: AiSavedTablePart['action']
    source: AiSavedTablePart['source']
    refresh: AiSavedTablePart['refresh']
    rowCount: number | null
    columns: { name: string }[] | null
    removed: boolean
    latest: boolean
  }>(
    `SELECT c.id AS "changeId", c.tool_use_id AS "toolUseId", c.table_id AS "tableId", t.name, COALESCE(c.definition ->> 'title', t.title) AS title,
            c.action, t.source, COALESCE(c.definition ->> 'refresh', t.refresh) AS refresh, c.row_count AS "rowCount", c.columns,
            (t.deleted_at IS NOT NULL) AS removed,
            NOT EXISTS (SELECT 1 FROM ai_saved_table_changes later
                         WHERE later.table_id = c.table_id AND later.action <> 'refresh' AND (later.created_at, later.id) > (c.created_at, c.id)) AS latest
       FROM ai_saved_table_changes c JOIN ai_saved_tables t ON t.id = c.table_id
      WHERE c.conversation_id = $1 AND ($2::uuid IS NULL OR c.turn_id = $2)`,
    [conversationId, turnId ?? null],
  )
  return new Map(
    rows.map((r) => [
      r.toolUseId,
      {
        type: 'saved-table',
        changeId: r.changeId,
        tableId: r.tableId,
        name: r.name,
        title: r.title,
        action: r.action,
        source: r.source,
        refresh: r.source === 'rows' ? 'never' : (r.refresh as AiSavedTablePart['refresh']),
        rowCount: r.rowCount,
        columns: (r.columns ?? []).map((c) => c.name),
        state: r.removed ? 'removed' : r.latest ? 'current' : 'changed',
      } satisfies AiSavedTablePart,
    ]),
  )
}
