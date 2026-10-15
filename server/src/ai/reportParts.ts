// ============================================================================
// §20 — the cards of the reports the assistant built or changed
// (./reportTools, save_report), as each report stands now: where a
// conversation's answers are read again (./transcript). Apart from the tool,
// so reading a conversation does not load the report runner.
// ============================================================================

import type { AiReport, AiReportPart } from '@qc/shared/ai'
import type { AiReportInput } from '@qc/shared/aiReportInputs'
import type { Queryable } from '../db/pool'

/** The card of a report as a change left it. */
export function reportPart(changeId: string, report: Pick<AiReport, 'id' | 'title' | 'description' | 'shared' | 'inputs' | 'sections'>, action: 'create' | 'update', state: AiReportPart['state']): AiReportPart {
  const part: AiReportPart = {
    type: 'report',
    changeId,
    reportId: report.id,
    action,
    title: report.title,
    shared: report.shared,
    inputs: report.inputs.map((i) => i.label),
    sectionCount: report.sections.length,
    state,
  }
  if (report.description) part.description = report.description
  return part
}

/** The report cards of a conversation's answers (of one, with `turnId`), by the tool call that made each, as each report stands now. */
export async function loadReportParts(q: Queryable, conversationId: string, turnId?: string): Promise<Map<string, AiReportPart>> {
  const { rows } = await q.query<{
    changeId: string
    toolUseId: string
    reportId: string
    action: 'create' | 'update'
    title: string
    description: string | null
    shared: boolean
    inputs: AiReportInput[]
    sectionCount: number
    removed: boolean
    latest: boolean
  }>(
    `SELECT c.id AS "changeId", c.tool_use_id AS "toolUseId", c.report_id AS "reportId", c.action, r.title, r.description, r.shared, r.inputs,
            json_array_length(r.sections) AS "sectionCount", (r.deleted_at IS NOT NULL) AS removed,
            NOT EXISTS (SELECT 1 FROM ai_report_changes later WHERE later.report_id = c.report_id AND (later.created_at, later.id) > (c.created_at, c.id)) AS latest
       FROM ai_report_changes c JOIN ai_reports r ON r.id = c.report_id
      WHERE c.conversation_id = $1 AND ($2::uuid IS NULL OR c.turn_id = $2)`,
    [conversationId, turnId ?? null],
  )
  return new Map(
    rows.map((r) => [
      r.toolUseId,
      reportPart(r.changeId, { id: r.reportId, title: r.title, description: r.description ?? undefined, shared: r.shared, inputs: r.inputs, sections: new Array(r.sectionCount) }, r.action, r.removed ? 'removed' : r.latest ? 'current' : 'changed'),
    ]),
  )
}
