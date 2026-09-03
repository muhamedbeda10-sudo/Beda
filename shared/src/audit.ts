// ============================================================================
// §11 — field-level change detection.
// Every edit after the initial save must produce an audit entry naming the
// field, its old value and its new value. Diffing lives here so no call site
// can "forget" to record something. Used by the API when it applies a
// correction; the client only ever reads audit entries.
// ============================================================================

import type { AuditEntry, AuditAction } from './types'

/** Fields that carry no business meaning and would only add noise. */
const IGNORED_FIELDS = new Set(['version', 'updatedAt', 'id'])

export interface AuditContext {
  userId: string
  userName: string
  entity: string
  entityId: string
  orderNumber?: string
  item?: string
  workCenterCode?: string
  sessionId?: string
  sampleId?: string
}

function render(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return JSON.stringify(v)
}

/** An audit entry before the store assigns its id. */
export type AuditDraft = Omit<AuditEntry, 'id'>

/**
 * Compare two versions of a record and return one entry per changed field.
 * Returns an empty array when nothing meaningful changed, so callers can skip
 * writing a no-op audit trail.
 */
export function diffForAudit(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  ctx: AuditContext,
  at: string,
): AuditDraft[] {
  const entries: AuditDraft[] = []
  const fields = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])

  for (const field of fields) {
    if (IGNORED_FIELDS.has(field)) continue
    const oldValue = render(before?.[field])
    const newValue = render(after?.[field])
    if (oldValue === newValue) continue
    entries.push({
      at,
      userId: ctx.userId,
      userName: ctx.userName,
      action: 'update',
      entity: ctx.entity,
      entityId: ctx.entityId,
      field,
      oldValue,
      newValue,
      orderNumber: ctx.orderNumber,
      item: ctx.item,
      workCenterCode: ctx.workCenterCode,
      sessionId: ctx.sessionId,
      sampleId: ctx.sampleId,
    })
  }
  return entries
}

/** A single non-field-level event (create, soft delete, acknowledge, purge…). */
export function auditEvent(
  action: AuditAction,
  ctx: AuditContext,
  at: string,
  detail?: { field?: string; oldValue?: string; newValue?: string },
): AuditDraft {
  return {
    at,
    userId: ctx.userId,
    userName: ctx.userName,
    action,
    entity: ctx.entity,
    entityId: ctx.entityId,
    field: detail?.field,
    oldValue: detail?.oldValue,
    newValue: detail?.newValue,
    orderNumber: ctx.orderNumber,
    item: ctx.item,
    workCenterCode: ctx.workCenterCode,
    sessionId: ctx.sessionId,
    sampleId: ctx.sampleId,
  }
}
