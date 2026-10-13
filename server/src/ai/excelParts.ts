// ============================================================================
// §20 — the Excel cards an answer left: each file the assistant made, as its
// card shows it (its name, each sheet's columns and rows, its size, until
// when it can be downloaded). Apart from the tool (./excel), so the
// transcript reads them without loading what the tool needs. A request that
// made no file leaves no card: the answer's words say why.
// ============================================================================

import type { AiExcelPart } from '@qc/shared/aiExcel'
import type { Queryable } from '../db/pool'

/** The Excel cards of a conversation's answers (of one, with `turnId`), by the tool call that made each. */
export async function loadExcelParts(q: Queryable, conversationId: string, turnId?: string): Promise<Map<string, AiExcelPart>> {
  // A timestamptz reads as its ISO text (db/pool).
  const { rows } = await q.query<{ id: string; toolUseId: string; fileName: string; card: AiExcelPart['sheets']; byteSize: number; expiresAt: string; expired: boolean }>(
    `SELECT f.id, f.tool_use_id AS "toolUseId", f.file_name AS "fileName", f.card, f.byte_size AS "byteSize", f.expires_at AS "expiresAt",
            (f.removed_at IS NOT NULL OR f.expires_at <= now()) AS expired
       FROM ai_excel_files f
      WHERE f.conversation_id = $1 AND ($2::uuid IS NULL OR f.turn_id = $2) AND f.status = 'made'`,
    [conversationId, turnId ?? null],
  )
  return new Map(
    rows.map((r) => {
      const part: AiExcelPart = { type: 'excel', fileId: r.id, fileName: r.fileName, sheets: r.card, byteSize: r.byteSize, expiresAt: r.expiresAt }
      if (r.expired) part.expired = true
      return [r.toolUseId, part]
    }),
  )
}
