// ============================================================================
// A saved report shared with people and roles (shared/reportShares.ts).
//
// Its owner shares it — only their own report, only while they have the
// assistant — from its Share panel (ai.routes.ts) or by asking the assistant
// (reportTools.ts, share_report): both through shareReport here, so the rules,
// the audit entries and the bell's alerts are one. Each change is audited
// (entity AiReport, one entry per person or role added or removed). Everyone
// it reaches as it is shared — the people named and the role's members then —
// is told once in the bell's Reports; sharing it again tells nobody twice.
//
// Whom a report is shared with is read at every request: a role's members as
// they are now, an inactive account never, its owner never (their own report
// is in My reports). To anyone else it does not exist. Deleting the report, or
// unsharing it, takes it from them at once.
//
// A recipient runs it as its owner's domains as they are at each section,
// within the domains its queries were written under (author_domains, as a
// scheduled saved report is bounded in automations/savedReport.ts) — never
// their own, assistant or not. An owner who no longer has the assistant runs
// nothing for anyone. Each run and export by a recipient is recorded
// (ai_report_runs) for the owner's panel, and the photos it showed them are
// theirs to open for a day after (readableImageIds, images.routes.ts).
// ============================================================================

import type pg from 'pg'
import { AI_PHOTO_COLUMN, type AiDomain, type AiReport, type AiReportSectionRun } from '@qc/shared/ai'
import { auditEvent } from '@qc/shared/audit'
import {
  REPORT_SHARE_MAX_TARGETS,
  roleShareLabel,
  shareKey,
  type ReportSharePerson,
  type ReportShareRunner,
  type ReportSharesResponse,
  type ReportShareTarget,
  type ReportShareView,
  type SharedReport,
  type SharedReportSummary,
  type SharedReportsResponse,
} from '@qc/shared/reportShares'
import { ROLES, type Role } from '@qc/shared/types'
import type { Queryable } from '../db/pool'
import { writeAudit } from '../audit/service'
import { createNotifications } from '../automations/notify'
import { activeUserIds, distinctIds, isUuid, LIVE_PERSON } from '../automations/people'
import { isGranted, loadAccess } from './access'
import { findReportOpenTo, type SectionReader } from './reports'

/** How long a recipient may open the photos a run showed them: a day, renewed by every run that shows them again. */
export const SHARE_PHOTO_HOURS = 24

/** What a recipient reads when the report's owner no longer has the assistant: nothing runs for anyone. */
export const ownerGone = (ownerName: string): string =>
  `${ownerName || 'Whoever shared this report'} no longer has access to the AI assistant, so this report cannot run. Ask them to share it again.`

/** What a section reads for a recipient when its data is beyond what its owner may read now. */
export const SHARED_NO_ACCESS = 'Whoever shared this report may not read this data now, so this section does not run.'
/** The same, naming the data: the owner lacks that domain now, and the report cannot read more than they may. */
export const sharedNoAccessTo = (what: string): string => `Whoever shared this report may not read ${what} now, so this section does not run.`

/**
 * Whether the report `r` (an alias of ai_reports) is open to the person `person` (a parameter) as a recipient: not
 * deleted, not theirs, shared with them or with the role their active account holds now.
 */
export const sharedWith = (person: string, r = 'r'): string =>
  `(${r}.deleted_at IS NULL AND ${r}.user_id <> ${person} AND EXISTS (
     SELECT 1 FROM ai_report_shares s JOIN users p ON p.id = ${person} AND p.is_active AND p.deleted_at IS NULL
      WHERE s.report_id = ${r}.id AND (s.user_id = p.id OR s.role = p.role)))`

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ---- The owner's side ---------------------------------------------------------------------

interface ShareRow {
  userId: string | null
  role: Role | null
  sharedAt: string
  sharedByName: string
  name: string | null
  username: string | null
  active: boolean | null
}

const byRoleThenName = (a: ReportShareView, b: ReportShareView): number => {
  if (a.kind !== b.kind) return a.kind === 'role' ? -1 : 1
  if (a.kind === 'role' && b.kind === 'role') return ROLES.indexOf(a.role) - ROLES.indexOf(b.role)
  return a.label.localeCompare(b.label)
}

/** Whom the report is shared with: the roles first, then the people by name. */
export async function loadShares(q: Queryable, reportId: string): Promise<ReportShareView[]> {
  const { rows } = await q.query<ShareRow>(
    `SELECT s.user_id AS "userId", s.role::text AS role, s.created_at AS "sharedAt", COALESCE(b.name, '') AS "sharedByName",
            u.name, u.username, (u.is_active AND u.deleted_at IS NULL) AS active
       FROM ai_report_shares s LEFT JOIN users b ON b.id = s.shared_by_id LEFT JOIN users u ON u.id = s.user_id
      WHERE s.report_id = $1`,
    [reportId],
  )
  return rows
    .map((r): ReportShareView => {
      if (r.role) return { kind: 'role', role: r.role, label: roleShareLabel(r.role), sharedAt: r.sharedAt, sharedByName: r.sharedByName }
      const view: ReportShareView = { kind: 'user', userId: r.userId!, label: r.name ?? 'A removed account', sharedAt: r.sharedAt, sharedByName: r.sharedByName }
      if (!r.active) view.inactive = true
      return view
    })
    .sort(byRoleThenName)
}

/** Who ran the report shared with them, how often and when last; the latest first. */
export async function loadRunners(q: Queryable, reportId: string): Promise<ReportShareRunner[]> {
  const { rows } = await q.query<ReportShareRunner>(
    `SELECT x.user_id AS "userId", COALESCE(u.name, '') AS name,
            count(*) FILTER (WHERE x.kind = 'run')::int AS runs, count(*) FILTER (WHERE x.kind = 'export')::int AS exports,
            max(x.ran_at) AS "lastRunAt"
       FROM ai_report_runs x LEFT JOIN users u ON u.id = x.user_id
      WHERE x.report_id = $1
      GROUP BY x.user_id, u.name`,
    [reportId],
  )
  return rows.sort((a, b) => Date.parse(b.lastRunAt) - Date.parse(a.lastRunAt))
}

/** The people a report may be shared with: every live account but its owner, by name. */
export async function sharePeople(q: Queryable, ownerId: string): Promise<ReportSharePerson[]> {
  const { rows } = await q.query<ReportSharePerson>(`SELECT u.id, u.name, u.username, u.role::text AS role FROM users u WHERE ${LIVE_PERSON} AND u.id <> $1`, [ownerId])
  return rows.sort((a, b) => a.name.localeCompare(b.name) || a.username.localeCompare(b.username))
}

/** The owner's Share panel: whom it is shared with, who ran it, and whom it may be shared with. */
export async function sharesResponse(q: Queryable, reportId: string, ownerId: string): Promise<ReportSharesResponse> {
  return { reportId, shares: await loadShares(q, reportId), runners: await loadRunners(q, reportId), people: await sharePeople(q, ownerId), roles: [...ROLES] }
}

/** One of the person's own reports, not deleted: its title; null when it is not theirs (or not there). */
export async function ownReport(q: Queryable, reportId: string, userId: string, lock = false): Promise<{ id: string; title: string; description: string | null } | null> {
  if (!UUID.test(reportId)) return null
  const { rows } = await q.query<{ id: string; title: string; description: string | null }>(
    `SELECT id, title, description FROM ai_reports WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
    [reportId, userId],
  )
  return rows[0] ?? null
}

/** Where an assistant's share_report call was made: its card is kept with the change. */
export interface ShareCardSource {
  conversationId: string
  turnId: string
  toolUseId: string
}

export type ShareOutcome =
  /** Not one of the person's own reports (someone else's, deleted, or no such report). */
  | { kind: 'not-found' }
  /** The person no longer has the assistant. */
  | { kind: 'not-allowed' }
  | { kind: 'problems'; problems: string[] }
  | {
      kind: 'done'
      report: { id: string; title: string }
      /** Whom this change added and removed, by name; empty when it changed nothing. */
      added: string[]
      removed: string[]
      /** Whom it is shared with now. */
      shares: ReportShareView[]
      /** How many people the bell told. */
      notified: number
      /** The card kept for the assistant's call, when it was one. */
      cardId?: string
    }

/**
 * Share one of `by`'s own reports with people and roles, and stop sharing it with others, in one change: checked
 * (their own report, not deleted; they have the assistant; each person a live account other than theirs, each role a
 * role; no more than REPORT_SHARE_MAX_TARGETS), audited, and told in the bell to everyone it newly reaches — once per
 * report and person, ever. Adding what is there already, or removing what is not, changes nothing. Run inside the
 * caller's transaction; `card` keeps the assistant's card with it.
 */
export async function shareReport(
  tx: Queryable,
  args: { reportId: string; by: { id: string; name: string }; add: readonly ReportShareTarget[]; remove: readonly ReportShareTarget[]; card?: ShareCardSource },
): Promise<ShareOutcome> {
  const report = await ownReport(tx, args.reportId, args.by.id, true)
  if (!report) return { kind: 'not-found' }
  if (!isGranted(await loadAccess(tx, args.by.id))) return { kind: 'not-allowed' }

  const problems: string[] = []
  const valid = (t: ReportShareTarget, i: number, list: 'add' | 'remove'): boolean => {
    if (t?.kind === 'role') {
      if (ROLES.includes(t.role)) return true
      problems.push(`${list}[${i}]: "${String(t.role)}" is not a role (${ROLES.join(', ')}).`)
    } else if (t?.kind === 'user') {
      if (isUuid(t.userId)) return true
      problems.push(`${list}[${i}]: "${String(t.userId)}" is not a person's id.`)
    } else problems.push(`${list}[${i}]: a person ({ kind: 'user', userId }) or a role ({ kind: 'role', role }).`)
    return false
  }
  const add = args.add.filter((t, i) => valid(t, i, 'add'))
  const remove = args.remove.filter((t, i) => valid(t, i, 'remove'))
  const removing = new Set(remove.map(shareKey))
  for (const t of add) if (removing.has(shareKey(t))) problems.push(`${t.kind === 'role' ? roleShareLabel(t.role) : t.userId} is both added and removed: say which.`)

  // The people added, as they are: a live account other than the owner's.
  const addIds = distinctIds(add.flatMap((t) => (t.kind === 'user' ? [t.userId] : [])))
  const people = new Map<string, { name: string; live: boolean }>()
  if (addIds.length > 0) {
    const { rows } = await tx.query<{ id: string; name: string; live: boolean }>(`SELECT u.id, u.name, (${LIVE_PERSON}) AS live FROM users u WHERE u.id = ANY($1::uuid[])`, [addIds])
    for (const r of rows) people.set(r.id, { name: r.name, live: r.live })
  }
  for (const id of addIds) {
    const p = people.get(id)
    if (id === args.by.id) problems.push('The report is yours already: share it with others.')
    else if (!p) problems.push(`No person has the id ${id}.`)
    else if (!p.live) problems.push(`${p.name}'s account is not active: a report cannot be shared with it.`)
  }
  if (problems.length > 0) return { kind: 'problems', problems }

  const before = await loadShares(tx, report.id)
  const present = new Map(before.map((s) => [shareKey(s), s]))
  const toAdd = new Map<string, ReportShareTarget>()
  for (const t of add) if (!present.has(shareKey(t))) toAdd.set(shareKey(t), t.kind === 'user' ? { kind: 'user', userId: t.userId.toLowerCase() } : t)
  const toRemove = [...new Set(remove.map(shareKey))].map((k) => present.get(k)).filter((s): s is ReportShareView => !!s)
  if (before.length - toRemove.length + toAdd.size > REPORT_SHARE_MAX_TARGETS) {
    return { kind: 'problems', problems: [`A report is shared with at most ${REPORT_SHARE_MAX_TARGETS} people and roles: share it with a role instead of each of its people.`] }
  }

  const at = new Date().toISOString()
  const ctx = { userId: args.by.id, userName: args.by.name, entity: 'AiReport', entityId: report.id }
  const removed: string[] = []
  for (const s of toRemove) {
    if (s.kind === 'user') await tx.query(`DELETE FROM ai_report_shares WHERE report_id = $1 AND user_id = $2`, [report.id, s.userId])
    else await tx.query(`DELETE FROM ai_report_shares WHERE report_id = $1 AND role = $2`, [report.id, s.role])
    removed.push(s.label)
  }
  const added: string[] = []
  for (const t of toAdd.values()) {
    await tx.query(`INSERT INTO ai_report_shares (report_id, user_id, role, shared_by_id) VALUES ($1, $2, $3, $4)`, [
      report.id,
      t.kind === 'user' ? t.userId : null,
      t.kind === 'role' ? t.role : null,
      args.by.id,
    ])
    added.push(t.kind === 'user' ? people.get(t.userId)!.name : roleShareLabel(t.role))
  }
  // Whom it was shared with and with whom no longer, by name: never what the report holds (its title is personal).
  await writeAudit(tx, [
    ...toRemove.map((s) => auditEvent('update', ctx, at, { field: 'shared with', oldValue: s.label, newValue: '' })),
    ...[...toAdd.values()].map((t, i) => auditEvent('update', ctx, at, { field: 'shared with', oldValue: '', newValue: added[i] })),
  ])

  // Everyone it reaches now, through a person or a role added: told once per report, ever, whoever shares it again.
  const fresh = [...toAdd.values()]
  const reached = (await activeUserIds(tx, { userIds: fresh.flatMap((t) => (t.kind === 'user' ? [t.userId] : [])), roles: fresh.flatMap((t) => (t.kind === 'role' ? [t.role] : [])) })).filter(
    (id) => id !== args.by.id,
  )
  let notified = 0
  if (reached.length > 0) {
    const { rows } = await tx.query<{ userId: string }>(
      `INSERT INTO ai_report_share_notices (report_id, user_id) SELECT $1, x FROM unnest($2::uuid[]) x ON CONFLICT DO NOTHING RETURNING user_id AS "userId"`,
      [report.id, reached],
    )
    notified = await createNotifications(
      tx,
      rows.map((r) => r.userId),
      {
        kind: 'report-shared',
        severity: 'info',
        title: `${args.by.name} shared a report with you: ${report.title}`,
        body: `${report.description ? `${report.description}\n\n` : ''}Open it on the Reports page to run it.`,
        link: `/reports/${report.id}`,
      },
    )
  }

  let cardId: string | undefined
  if (args.card) cardId = await keepShareCard(tx, { reportId: report.id, userId: args.by.id, source: args.card, added, removed })
  const shares = toAdd.size > 0 || toRemove.length > 0 ? await loadShares(tx, report.id) : before
  return { kind: 'done', report: { id: report.id, title: report.title }, added, removed, shares, notified, ...(cardId ? { cardId } : {}) }
}

/** The card of an assistant's share_report call, kept so that its conversation shows it when read again. */
export async function keepShareCard(q: Queryable, c: { reportId: string; userId: string; source: ShareCardSource; added: string[]; removed: string[] }): Promise<string> {
  const { rows } = await q.query<{ id: string }>(
    `INSERT INTO ai_report_share_cards (report_id, conversation_id, turn_id, tool_use_id, user_id, added, removed)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [c.reportId, c.source.conversationId, c.source.turnId, c.source.toolUseId, c.userId, c.added, c.removed],
  )
  return rows[0].id
}

// ---- The recipients' side --------------------------------------------------------------------

/** A report shared with the person, as its owner's run reads it: its SQL, whose it is, the domains it was written under. */
export type SharedRecord = AiReport & { ownerId: string; authorDomains: AiDomain[] | null }

/** The report `id` as a recipient opens it; null when it is not shared with them (or deleted, or theirs). */
export function findSharedReport(q: Queryable, id: string, userId: string): Promise<SharedRecord | null> {
  return UUID.test(id) ? findReportOpenTo(q, id, userId, sharedWith('$2')) : Promise.resolve(null)
}

/** Whether anything is shared with the person: one indexed look-up by them and by their role. */
export async function anySharedReports(q: Queryable, userId: string): Promise<boolean> {
  const { rows } = await q.query<{ any: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM users p
         JOIN ai_report_shares s ON s.user_id = p.id OR s.role = p.role
         JOIN ai_reports r ON r.id = s.report_id AND r.deleted_at IS NULL AND r.user_id <> p.id
        WHERE p.id = $1 AND p.is_active AND p.deleted_at IS NULL) AS any`,
    [userId],
  )
  return rows[0].any
}

/** The reports shared with the person, last changed first; `search` matches the title or what it shows, ignoring case. */
export async function listSharedReports(
  q: Queryable,
  userId: string,
  opts: { before: string | null; beforeId: string | null; limit: number; search: string | null },
): Promise<SharedReportsResponse> {
  const { rows } = await q.query<SharedReportSummary & { description: string | null }>(
    `SELECT r.id, r.title, r.description, COALESCE(u.name, '') AS "ownerName", r.updated_at AS "updatedAt",
            json_array_length(r.inputs) AS "inputCount", json_array_length(r.sections) AS "sectionCount"
       FROM ai_reports r LEFT JOIN users u ON u.id = r.user_id
      WHERE ${sharedWith('$1')}
        AND ($2::timestamptz IS NULL
             OR ($5::uuid IS NULL AND date_trunc('milliseconds', r.updated_at) < $2)
             OR ($5::uuid IS NOT NULL AND (date_trunc('milliseconds', r.updated_at), r.id) < ($2, $5::uuid)))
        AND ($4::text IS NULL OR strpos(lower(r.title), lower($4)) > 0 OR strpos(lower(COALESCE(r.description, '')), lower($4)) > 0)
      ORDER BY date_trunc('milliseconds', r.updated_at) DESC, r.id DESC LIMIT $3`,
    [userId, opts.before, opts.limit + 1, opts.search, opts.beforeId],
  )
  const reports = rows.slice(0, opts.limit).map(({ description, ...r }): SharedReportSummary => (description ? { ...r, description } : r))
  return { reports, hasMore: rows.length > opts.limit }
}

/** The report as a recipient sees it: what it shows and asks for, never its SQL nor the question it came from. */
export function toSharedReport(r: SharedRecord, opts: { available: boolean; excel: boolean }): SharedReport {
  const out: SharedReport = {
    id: r.id,
    title: r.title,
    ownerName: r.ownerName,
    updatedAt: r.updatedAt,
    period: r.adjustable ? r.period : null,
    adjustable: r.adjustable,
    inputs: r.inputs,
    sections: r.sections.map((s) => ({
      title: s.title,
      ...(s.chart ? { chart: s.chart } : {}),
      ...(s.display && s.display !== 'table' ? { display: s.display } : {}),
      ...(s.tree ? { tree: s.tree } : {}),
      ...(s.note ? { note: s.note } : {}),
    })),
    available: opts.available,
    excel: opts.excel,
  }
  if (r.description) out.description = r.description
  if (!opts.available) out.unavailable = ownerGone(r.ownerName)
  return out
}

/** Whether the report's owner has the assistant now: a shared report runs for nobody once they do not. */
export async function ownerMayRun(q: Queryable, r: Pick<SharedRecord, 'ownerId'>): Promise<boolean> {
  return isGranted(await loadAccess(q, r.ownerId))
}

/**
 * Where a recipient's next section runs: the owner's domains as they are when it starts, within the domains the
 * report's queries were written under (none for the app's own reports); 'withdrawn' once the owner no longer has the
 * assistant or the two share no domain.
 */
export function ownerReader(q: Queryable, readers: { poolFor(domains: readonly AiDomain[]): pg.Pool | null }, r: Pick<SharedRecord, 'id' | 'ownerId' | 'authorDomains'>): SectionReader {
  // Said once a run, in the log, for whoever asks why a recipient reads nothing: the page says only that the owner may not.
  let said = false
  const withdrawn = (why: string): 'withdrawn' => {
    if (!said) console.warn(`[reports] shared report ${r.id} runs nothing for a recipient: ${why}`)
    said = true
    return 'withdrawn'
  }
  return async () => {
    const owner = await loadAccess(q, r.ownerId)
    if (!isGranted(owner)) return withdrawn('its owner no longer has the assistant')
    const domains = owner.domains.filter((d) => !r.authorDomains || r.authorDomains.includes(d))
    return domains.length > 0 ? readers.poolFor(domains) : withdrawn(`its owner reads ${owner.domains.join(', ')} now and its queries were written under ${r.authorDomains!.join(', ')}: nothing in common`)
  }
}

/** A recipient's run or export of a shared report, for its owner's panel. */
export async function recordRecipientRun(q: Queryable, reportId: string, userId: string, kind: 'run' | 'export'): Promise<void> {
  await q.query(`INSERT INTO ai_report_runs (report_id, user_id, kind) VALUES ($1, $2, $3)`, [reportId, userId, kind])
}

/** The stored photos a run's sections name: each section's photo_id column (as the app finds it), each cell an image's id. */
export function runPhotoIds(sections: readonly Pick<AiReportSectionRun, 'ok' | 'columns' | 'rows'>[]): string[] {
  const ids = new Set<string>()
  for (const s of sections) {
    if (!s.ok) continue
    const at = s.columns.findIndex((c) => c.trim().toLowerCase() === AI_PHOTO_COLUMN)
    if (at < 0) continue
    for (const row of s.rows) {
      const v = row[at]
      if (typeof v === 'string' && UUID.test(v)) ids.add(v.toLowerCase())
    }
  }
  return [...ids]
}

/** A photo the assistant can show — an inspection's or a PDI's — that `i` (an alias of images) is. */
export const ASSISTANT_PHOTO = (i: string): string => `(EXISTS (SELECT 1 FROM defect_images x WHERE x.image_id = ${i}.id)
      OR EXISTS (SELECT 1 FROM paint_sample_images x WHERE x.image_id = ${i}.id)
      OR EXISTS (SELECT 1 FROM pt_record_images x WHERE x.image_id = ${i}.id)
      OR EXISTS (SELECT 1 FROM session_note_images x WHERE x.image_id = ${i}.id)
      OR EXISTS (SELECT 1 FROM pdi_images x WHERE x.image_id = ${i}.id))`

/**
 * The photos a recipient's run showed them, theirs to open for SHARE_PHOTO_HOURS from now: only the inspection and
 * PDI photos among them (what the assistant's photo views hold, whatever else a photo_id column might name).
 */
export async function keepRunPhotos(q: Queryable, reportId: string, userId: string, sections: readonly Pick<AiReportSectionRun, 'ok' | 'columns' | 'rows'>[]): Promise<void> {
  const ids = runPhotoIds(sections)
  if (ids.length === 0) return
  await q.query(
    `INSERT INTO ai_report_share_images (report_id, user_id, image_id, expires_at)
     SELECT $1, $2, i.id, now() + make_interval(hours => $4) FROM images i
      WHERE i.id = ANY($3::uuid[]) AND i.deleted_at IS NULL AND ${ASSISTANT_PHOTO('i')}
     ON CONFLICT (report_id, user_id, image_id) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
    [reportId, userId, ids, SHARE_PHOTO_HOURS],
  )
}

/**
 * Whether the image `i` was shown to the person `person` by a run of a report still shared with them, within the
 * last SHARE_PHOTO_HOURS — and is an inspection's or a PDI's photo.
 */
export const SHARED_RUN_PHOTO = (i: string, person: string): string => `(EXISTS (
       SELECT 1 FROM ai_report_share_images x JOIN ai_reports r ON r.id = x.report_id
        WHERE x.image_id = ${i}.id AND x.user_id = ${person} AND x.expires_at > now() AND ${sharedWith(person)})
     AND ${ASSISTANT_PHOTO(i)})`

/** Remove the photos' grants that lapsed before `now`. Returns how many went. */
export async function purgeSharePhotos(q: Queryable, now: Date = new Date()): Promise<number> {
  const { rowCount } = await q.query(`DELETE FROM ai_report_share_images WHERE expires_at < $1`, [now.toISOString()])
  return rowCount ?? 0
}
