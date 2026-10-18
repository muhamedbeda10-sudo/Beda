// ============================================================================
// Excel forms, as kept (migration 0070): a workbook with a saved report, and
// where each value goes. Whoever may open the report may fill its forms; its
// owner adds, changes and removes them.
// ============================================================================

import type { ReportForm, ReportFormMapping, ReportFormSheetPreview } from '@qc/shared/reportStyles'
import type { Queryable } from '../db/pool'

interface FormRow {
  id: string
  reportId: string
  ownerId: string
  name: string
  fileName: string
  byteSize: number
  sheets: ReportFormSheetPreview[]
  mapping: ReportFormMapping | null
  version: number
  updatedAt: string
  updatedByName: string
}

const FORM_COLUMNS = `f.id, f.report_id AS "reportId", f.owner_id AS "ownerId", f.name, f.file_name AS "fileName", f.byte_size AS "byteSize",
  f.sheets, f.mapping, f.version, f.updated_at AS "updatedAt", f.updated_by_name AS "updatedByName"`

/** Forms of reports the person may open: their own reports, and the shared ones. */
const OPENABLE = `JOIN ai_reports r ON r.id = f.report_id AND r.deleted_at IS NULL AND (r.user_id = $2 OR r.shared)`

const toForm = (r: FormRow, userId: string): ReportForm => ({
  id: r.id,
  reportId: r.reportId,
  name: r.name,
  fileName: r.fileName,
  byteSize: r.byteSize,
  sheets: r.sheets,
  mapping: r.mapping,
  version: r.version,
  mine: r.ownerId === userId,
  updatedAt: r.updatedAt,
  updatedByName: r.updatedByName,
})

export async function listForms(q: Queryable, reportId: string, userId: string): Promise<ReportForm[]> {
  const { rows } = await q.query<FormRow>(
    `SELECT ${FORM_COLUMNS} FROM report_forms f ${OPENABLE} WHERE f.report_id = $1 AND f.deleted_at IS NULL ORDER BY f.created_at, f.id`,
    [reportId, userId],
  )
  return rows.map((r) => toForm(r, userId))
}

export async function findForm(q: Queryable, id: string, userId: string, lock = false): Promise<ReportForm | null> {
  const { rows } = await q.query<FormRow>(
    `SELECT ${FORM_COLUMNS} FROM report_forms f ${OPENABLE} WHERE f.id = $1 AND f.deleted_at IS NULL${lock ? ' FOR UPDATE OF f' : ''}`,
    [id, userId],
  )
  return rows[0] ? toForm(rows[0], userId) : null
}

/** A form's file, for whoever may open its report. */
export async function formBytes(q: Queryable, id: string): Promise<Buffer> {
  const { rows } = await q.query<{ bytes: Buffer }>(`SELECT file_bytes AS bytes FROM report_forms WHERE id = $1`, [id])
  return rows[0].bytes
}

export const FORMS_PER_REPORT = 10

export async function countForms(q: Queryable, reportId: string): Promise<number> {
  const { rows } = await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM report_forms WHERE report_id = $1 AND deleted_at IS NULL`, [reportId])
  return rows[0].n
}

export async function insertForm(
  q: Queryable,
  args: { reportId: string; owner: { id: string; name: string }; name: string; fileName: string; bytes: Buffer; sha256: string; sheets: ReportFormSheetPreview[] },
): Promise<ReportForm> {
  const { rows } = await q.query<{ id: string }>(
    `INSERT INTO report_forms (report_id, owner_id, name, file_name, byte_size, sha256, file_bytes, sheets, updated_by_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [args.reportId, args.owner.id, args.name, args.fileName, args.bytes.length, args.sha256, args.bytes, JSON.stringify(args.sheets), args.owner.name],
  )
  return (await findForm(q, rows[0].id, args.owner.id))!
}

export async function updateForm(q: Queryable, id: string, next: { name: string; mapping: ReportFormMapping | null }, by: { id: string; name: string }): Promise<ReportForm> {
  await q.query(`UPDATE report_forms SET name = $2, mapping = $3, version = version + 1, updated_at = now(), updated_by_name = $4 WHERE id = $1`, [
    id,
    next.name,
    next.mapping ? JSON.stringify(next.mapping) : null,
    by.name,
  ])
  return (await findForm(q, id, by.id))!
}

export async function deleteForm(q: Queryable, id: string, byId: string): Promise<void> {
  await q.query(`UPDATE report_forms SET deleted_at = now(), deleted_by_id = $2 WHERE id = $1`, [id, byId])
}
