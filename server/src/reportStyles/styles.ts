// ============================================================================
// Report styles, as kept (migration 0070). A person reads their own styles
// and the shared ones; changes and deletes their own; one with the
// Configuration permission shares any and makes one the company's default.
// Each save is a version, kept with who made it. A report prints in its own
// style while that style is there; else in the company's default; else in
// the built-in look.
// ============================================================================

import { BUILTIN_REPORT_STYLE, nextRevision, sameSpec, type ReportStyle, type ReportStyleSpec, type ReportStyleVersion, type ResolvedReportStyle } from '@qc/shared/reportStyles'
import type { Queryable } from '../db/pool'
import { styleSpecSchema } from './styleSchema'

interface StyleRow {
  id: string
  ownerId: string
  ownerName: string
  name: string
  spec: unknown
  logoDataUrl: string | null
  shared: boolean
  isDefault: boolean
  version: number
  updatedAt: string
  updatedByName: string
}

const STYLE_COLUMNS = `s.id, s.owner_id AS "ownerId", u.name AS "ownerName", s.name, s.spec, s.logo_data_url AS "logoDataUrl", s.shared,
  s.is_default AS "isDefault", s.version, s.updated_at AS "updatedAt", s.updated_by_name AS "updatedByName"`
const STYLE_FROM = `report_styles s JOIN users u ON u.id = s.owner_id`

/**
 * A spec as kept, read back through the schema: a choice added since it was
 * saved takes the built-in's value; one that no longer reads is the built-in
 * look rather than a broken report.
 */
export function readSpec(raw: unknown, fallback: ReportStyleSpec): ReportStyleSpec {
  const merged = mergeOver(fallback, raw)
  const parsed = styleSpecSchema.safeParse(merged)
  return parsed.success ? parsed.data : fallback
}

/** `over` laid on `base`, object by object; arrays and values taken whole. */
function mergeOver<T>(base: T, over: unknown): T {
  if (!over || typeof over !== 'object' || Array.isArray(over) || !base || typeof base !== 'object' || Array.isArray(base)) return (over === undefined ? base : over) as T
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) out[k] = k in out ? mergeOver(out[k], v) : v
  return out as T
}


const toStyle = (r: StyleRow, userId: string): ReportStyle => ({
  id: r.id,
  name: r.name,
  version: r.version,
  spec: readSpec(r.spec, BUILTIN_REPORT_STYLE),
  logoDataUrl: r.logoDataUrl,
  shared: r.shared,
  isDefault: r.isDefault,
  mine: r.ownerId === userId,
  ownerName: r.ownerName,
  updatedAt: r.updatedAt,
  updatedByName: r.updatedByName,
})

export const resolved = (s: Pick<ReportStyle, 'id' | 'name' | 'version' | 'spec' | 'logoDataUrl'>): ResolvedReportStyle => ({
  id: s.id,
  name: s.name,
  version: s.version,
  spec: s.spec,
  logoDataUrl: s.logoDataUrl,
})

/** The styles a person may use: their own and the shared ones, the default first, then by name. */
export async function listStyles(q: Queryable, userId: string): Promise<ReportStyle[]> {
  const { rows } = await q.query<StyleRow>(
    `SELECT ${STYLE_COLUMNS} FROM ${STYLE_FROM}
      WHERE s.deleted_at IS NULL AND (s.owner_id = $1 OR s.shared)
      ORDER BY s.is_default DESC, lower(s.name), s.id`,
    [userId],
  )
  return rows.map((r) => toStyle(r, userId))
}

/** One style the person may use; null when it is not there or not theirs to see. */
export async function findStyle(q: Queryable, id: string, userId: string, lock = false): Promise<ReportStyle | null> {
  const { rows } = await q.query<StyleRow>(
    `SELECT ${STYLE_COLUMNS} FROM ${STYLE_FROM} WHERE s.id = $1 AND s.deleted_at IS NULL AND (s.owner_id = $2 OR s.shared)${lock ? ' FOR UPDATE OF s' : ''}`,
    [id, userId],
  )
  return rows[0] ? toStyle(rows[0], userId) : null
}

/** The company's default, as everyone prints in it; null when none is chosen. */
export async function defaultStyle(q: Queryable): Promise<ResolvedReportStyle | null> {
  const { rows } = await q.query<StyleRow>(`SELECT ${STYLE_COLUMNS} FROM ${STYLE_FROM} WHERE s.is_default AND s.deleted_at IS NULL`)
  return rows[0] ? resolved(toStyle(rows[0], '')) : null
}

/**
 * The style a report prints in, for whoever reads it: the one its owner chose
 * while it is there (whoever reads it: the report's look is its owner's
 * choice), else the company's default; null for the built-in look.
 */
export async function styleOfReport(q: Queryable, styleId: string | null | undefined): Promise<ResolvedReportStyle | null> {
  if (styleId) {
    const { rows } = await q.query<StyleRow>(`SELECT ${STYLE_COLUMNS} FROM ${STYLE_FROM} WHERE s.id = $1 AND s.deleted_at IS NULL`, [styleId])
    if (rows[0]) return resolved(toStyle(rows[0], ''))
  }
  return defaultStyle(q)
}

export async function countOwnStyles(q: Queryable, userId: string): Promise<number> {
  const { rows } = await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM report_styles WHERE owner_id = $1 AND deleted_at IS NULL`, [userId])
  return rows[0].n
}

async function keepVersion(q: Queryable, id: string, by: { id: string; name: string }): Promise<void> {
  await q.query(
    `INSERT INTO report_style_versions (style_id, version, name, spec, logo_data_url, changed_by_id, changed_by_name)
     SELECT id, version, name, spec, logo_data_url, $2, $3 FROM report_styles WHERE id = $1`,
    [id, by.id, by.name],
  )
}

export async function insertStyle(
  q: Queryable,
  args: { owner: { id: string; name: string }; name: string; spec: ReportStyleSpec; logoDataUrl: string | null },
): Promise<ReportStyle> {
  const { rows } = await q.query<{ id: string }>(
    `INSERT INTO report_styles (owner_id, name, spec, logo_data_url, updated_by_id, updated_by_name) VALUES ($1, $2, $3, $4, $1, $5) RETURNING id`,
    [args.owner.id, args.name, JSON.stringify(args.spec), args.logoDataUrl, args.owner.name],
  )
  await keepVersion(q, rows[0].id, args.owner)
  return (await findStyle(q, rows[0].id, args.owner.id))!
}

/**
 * A style changed: a new version, kept. With document control on and the
 * look changed, the revision moves on by itself ("02" → "03") and the issue
 * date is today, unless the person changed them in the same save.
 */
export async function updateStyle(
  q: Queryable,
  current: ReportStyle,
  next: { name: string; spec: ReportStyleSpec; logoDataUrl: string | null },
  by: { id: string; name: string },
  today: string,
): Promise<ReportStyle> {
  let spec = next.spec
  const lookChanged = !sameSpec({ ...current.spec, docControl: next.spec.docControl }, next.spec) || current.logoDataUrl !== next.logoDataUrl
  const docTouched = current.spec.docControl.revision !== next.spec.docControl.revision || current.spec.docControl.issueDate !== next.spec.docControl.issueDate
  if (spec.docControl.enabled && lookChanged && !docTouched) {
    spec = { ...spec, docControl: { ...spec.docControl, revision: nextRevision(spec.docControl.revision), issueDate: today } }
  }
  await q.query(
    `UPDATE report_styles SET name = $2, spec = $3, logo_data_url = $4, version = version + 1, updated_at = now(), updated_by_id = $5, updated_by_name = $6 WHERE id = $1`,
    [current.id, next.name, JSON.stringify(spec), next.logoDataUrl, by.id, by.name],
  )
  await keepVersion(q, current.id, by)
  return (await findStyle(q, current.id, by.id))!
}

export async function listVersions(q: Queryable, id: string): Promise<ReportStyleVersion[]> {
  const { rows } = await q.query<{ version: number; name: string; spec: unknown; changedByName: string; changedAt: string }>(
    `SELECT version, name, spec, changed_by_name AS "changedByName", changed_at AS "changedAt" FROM report_style_versions WHERE style_id = $1 ORDER BY version DESC LIMIT 100`,
    [id],
  )
  return rows.map((r) => ({ ...r, spec: readSpec(r.spec, BUILTIN_REPORT_STYLE) }))
}
