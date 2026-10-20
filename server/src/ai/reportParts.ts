// ============================================================================
// §20 — the cards of the reports the assistant built or changed
// (./reportTools, save_report), as each report stands now, and of whom it
// shared one with (share_report, ./reportShares): where a
// conversation's answers are read again (./transcript). Apart from the tool,
// so reading a conversation does not load the report runner.
// ============================================================================

import type { AiReport, AiReportPart, AiReportSharePart } from '@qc/shared/ai'
import type { AiReportInput } from '@qc/shared/aiReportInputs'
import { roleShareLabel } from '@qc/shared/reportShares'
import { ROLES, type Role } from '@qc/shared/types'
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

/** A share card, whom the report is shared with listed as its Share panel lists them: the roles first, then the people by name. */
export function reportSharePart(c: { cardId: string; reportId: string; title: string; added: string[]; removed: string[]; sharedWith: { label: string; role: Role | null }[]; deleted?: boolean }): AiReportSharePart {
  const rank = (r: Role | null) => (r ? ROLES.indexOf(r) : ROLES.length)
  const sorted = [...c.sharedWith].sort((a, b) => rank(a.role) - rank(b.role) || a.label.localeCompare(b.label))
  return {
    type: 'report-share',
    cardId: c.cardId,
    reportId: c.reportId,
    title: c.title,
    added: c.added,
    removed: c.removed,
    sharedWith: sorted.map((s) => s.label),
    state: c.deleted ? 'removed' : 'current',
  }
}

/**
 * The cards the assistant's share_report calls left in a conversation (of one answer, with `turnId`), by the tool
 * call that left each: whom it added and removed, as they were named then, and whom the report is shared with now.
 */
export async function loadReportShareParts(q: Queryable, conversationId: string, turnId?: string): Promise<Map<string, AiReportSharePart>> {
  const { rows } = await q.query<{ cardId: string; toolUseId: string; reportId: string; title: string; added: string[]; removed: string[]; gone: boolean }>(
    `SELECT c.id AS "cardId", c.tool_use_id AS "toolUseId", c.report_id AS "reportId", r.title, c.added, c.removed, (r.deleted_at IS NOT NULL) AS gone
       FROM ai_report_share_cards c JOIN ai_reports r ON r.id = c.report_id
      WHERE c.conversation_id = $1 AND ($2::uuid IS NULL OR c.turn_id = $2)`,
    [conversationId, turnId ?? null],
  )
  if (rows.length === 0) return new Map()
  const { rows: shares } = await q.query<{ reportId: string; role: Role | null; name: string | null }>(
    `SELECT s.report_id AS "reportId", s.role::text AS role, u.name
       FROM ai_report_shares s LEFT JOIN users u ON u.id = s.user_id
      WHERE s.report_id = ANY($1::uuid[])`,
    [[...new Set(rows.map((r) => r.reportId))]],
  )
  const sharedWith = new Map<string, { label: string; role: Role | null }[]>()
  for (const s of shares) {
    const entry = s.role ? { label: roleShareLabel(s.role), role: s.role } : { label: s.name ?? 'A removed account', role: null }
    sharedWith.set(s.reportId, [...(sharedWith.get(s.reportId) ?? []), entry])
  }
  return new Map(
    rows.map((r) => [
      r.toolUseId,
      reportSharePart({ cardId: r.cardId, reportId: r.reportId, title: r.title, added: r.added, removed: r.removed, sharedWith: sharedWith.get(r.reportId) ?? [], deleted: r.gone }),
    ]),
  )
}
