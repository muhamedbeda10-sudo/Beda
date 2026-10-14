// ============================================================================
// §20 — the diagram cards an answer left: each diagram the assistant drew, as
// it was checked and kept. Apart from the tool (./diagram), so the transcript
// reads them without loading what the tool needs. A call that drew nothing
// leaves no card: the answer's words say why.
// ============================================================================

import type { AiDiagramPart, AiDiagramSpec } from '@qc/shared/aiDiagram'
import type { Queryable } from '../db/pool'

/** The diagram cards of a conversation's answers (of one, with `turnId`), by the tool call that drew each. */
export async function loadDiagramParts(q: Queryable, conversationId: string, turnId?: string): Promise<Map<string, AiDiagramPart>> {
  const { rows } = await q.query<{ id: string; toolUseId: string; spec: AiDiagramSpec }>(
    `SELECT id, tool_use_id AS "toolUseId", spec FROM ai_diagrams WHERE conversation_id = $1 AND ($2::uuid IS NULL OR turn_id = $2)`,
    [conversationId, turnId ?? null],
  )
  return new Map(rows.map((r) => [r.toolUseId, { type: 'diagram', diagramId: r.id, spec: r.spec } satisfies AiDiagramPart]))
}
