// ============================================================================
// §11 — writing the audit trail.
//
// Every write path that changes evidence calls one of these inside the same
// transaction as the change, so the change and its record land together or
// not at all.
// ============================================================================

import { auditEvent, diffForAudit, type AuditContext, type AuditDraft } from '@qc/shared/audit'
import type { Queryable } from '../db/pool'

export async function writeAudit(tx: Queryable, entries: AuditDraft[]): Promise<void> {
  if (entries.length === 0) return
  const cols = [
    'at',
    'user_id',
    'user_name',
    'action',
    'entity',
    'entity_id',
    'field',
    'old_value',
    'new_value',
    'order_number',
    'item',
    'work_center_code',
    'session_id',
    'sample_id',
  ]
  const values: unknown[] = []
  const tuples = entries.map((e, i) => {
    const base = i * cols.length
    values.push(
      e.at,
      e.userId,
      e.userName,
      e.action,
      e.entity,
      e.entityId,
      e.field ?? null,
      e.oldValue ?? null,
      e.newValue ?? null,
      e.orderNumber ?? null,
      e.item ?? null,
      e.workCenterCode ?? null,
      e.sessionId ?? null,
      e.sampleId ?? null,
    )
    return `(${cols.map((_, j) => `$${base + j + 1}`).join(', ')})`
  })
  await tx.query(`INSERT INTO audit_log (${cols.join(', ')}) VALUES ${tuples.join(', ')}`, values)
}

export async function auditCreate(tx: Queryable, ctx: AuditContext, at = new Date().toISOString()): Promise<void> {
  await writeAudit(tx, [auditEvent('create', ctx, at)])
}

export async function auditDelete(tx: Queryable, ctx: AuditContext, at = new Date().toISOString()): Promise<void> {
  await writeAudit(tx, [auditEvent('delete', ctx, at)])
}

/** One entry per changed field between two snapshots of a record. */
export async function auditChanges(
  tx: Queryable,
  ctx: AuditContext,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  at = new Date().toISOString(),
): Promise<number> {
  const entries = diffForAudit(before, after, ctx, at)
  await writeAudit(tx, entries)
  return entries.length
}
