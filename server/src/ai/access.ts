// ============================================================================
// §20 — who may use the assistant, as the owner set it. Each person granted
// has a row: on or off, the data domains they may ask about, and a personal
// monthly cap on top of the assistant's own. The model and effort are not the
// person's: they are set by what Claude is doing (the owner's Models, in the
// assistant's settings). Everything is read again on every request, before
// every call to the model and before every query, so a change the owner makes
// — or an account being deactivated — takes effect at once.
//
// Four permissions on top, all the owner's to give: creating automations
// (§21), having the assistant write notices (§23) — only ever while the
// account is an administrator, its role read as it is now — having it make
// Excel files (§20), and uploading mill test certificates (MTC tab).
// ============================================================================

import {
  AI_DOMAINS,
  type AiAccess,
  type AiAccessRequest,
  type AiDomain,
  type AiMeResponse,
  type AiStatusResponse,
  type AiStopReason,
} from '@qc/shared/ai'
import { auditEvent } from '@qc/shared/audit'
import { can } from '@qc/shared/rules'
import type { Role } from '@qc/shared/types'
import type { Config } from '../config'
import type { Queryable } from '../db/pool'
import { auditChanges, writeAudit } from '../audit/service'
import { storedDomains } from './domains'
import { minCallWorstCaseUsd } from './models'
import { loadAiSettings, loadAvailability, type AiAvailability } from './settings'
import { monthSpend, personalMonthSpend } from './transcript'

/** A person's use of the assistant, with whether their account can still sign in. */
export interface AccessRecord {
  userId: string
  enabled: boolean
  domains: AiDomain[]
  monthlyCapUsd: number
  /** May create automations (§21); the owner may whatever this says. */
  automations: boolean
  /** May have the assistant write notices (§23), while an administrator; the owner may whatever this says. */
  notices: boolean
  /** May have the assistant make Excel files (§20); the owner may whatever this says. */
  excel: boolean
  /** May upload mill test certificates (MTC tab), the assistant on for them or not; the owner may whatever this says. */
  mtc: boolean
  /** The account is active and not removed. */
  active: boolean
}

interface AccessRow {
  userId: string
  enabled: boolean
  domains: string[]
  monthlyCapUsd: number
  automations: boolean
  notices: boolean
  excel: boolean
  mtc: boolean
  active: boolean
}

/** A row as the API uses it: a model or effort no longer offered reads as the default, never as something unchecked. */
function toRecord(r: AccessRow): AccessRecord {
  return {
    userId: r.userId,
    enabled: r.enabled,
    domains: storedDomains(r.domains),
    monthlyCapUsd: Number(r.monthlyCapUsd),
    automations: r.automations,
    notices: r.notices,
    excel: r.excel,
    mtc: r.mtc,
    active: r.active,
  }
}

const ACCESS_COLUMNS = `a.user_id AS "userId", a.enabled, a.domains, a.monthly_cap_usd AS "monthlyCapUsd",
       a.automations, a.notices, a.excel, a.mtc, (u.is_active AND u.deleted_at IS NULL) AS active`

/** A person's row, or null when the owner never gave them the assistant. */
export async function loadAccess(q: Queryable, userId: string): Promise<AccessRecord | null> {
  const { rows } = await q.query<AccessRow>(`SELECT ${ACCESS_COLUMNS} FROM ai_access a JOIN users u ON u.id = a.user_id WHERE a.user_id = $1`, [userId])
  return rows[0] ? toRecord(rows[0]) : null
}

/** Whether the person may use the assistant at all: an active account, a row switched on, something to ask about. */
export const isGranted = (a: AccessRecord | null): a is AccessRecord => !!a && a.active && a.enabled && a.domains.length > 0

/**
 * Whether the person may create automations (§21): given the assistant, and
 * its owner or allowed by the owner. Read again wherever it matters, like the
 * access itself: a permission taken away stops the tools and the routes at once.
 */
export const mayAutomate = (a: AccessRecord | null, owner: boolean): a is AccessRecord => isGranted(a) && (owner || a.automations)

/**
 * Whether the person may have the assistant make Excel files (§20): given
 * the assistant, and its owner or allowed by the owner. Read again by the
 * tool, by every download and by every Excel export of a query or a report:
 * a permission taken away stops them all at once.
 */
export const mayMakeExcel = (a: AccessRecord | null, owner: boolean): a is AccessRecord => isGranted(a) && (owner || a.excel)

/**
 * Whether the person may upload mill test certificates (MTC tab): the owner,
 * or an active account the owner allowed — whether or not the assistant is on
 * for them, so someone may read certificates without ever seeing the chat.
 * Read again by every reading and every save.
 */
export const mayUploadMtc = (a: AccessRecord | null, owner: boolean, active: boolean): boolean => active && (owner || (!!a && a.active && a.mtc))

/**
 * Whether the person may have the assistant write notices (§23): given the
 * assistant, an administrator by their role as it is now (`role`, read again
 * by the caller), and the owner or allowed by the owner. The assistant never
 * gets more power than its user has in the app: a person demoted loses it at
 * once, whatever their row says.
 */
export const mayManageNotices = (a: AccessRecord | null, owner: boolean, role: Role | null | undefined): a is AccessRecord =>
  isGranted(a) && can(role ?? undefined, 'manage-admin-data') && (owner || a.notices)

// ---- The owner's list ----------------------------------------------------------------

interface ListedRow extends AccessRow {
  name: string
  username: string
  role: string
  spentUsd: number
  updatedAt: string
  updatedByName: string | null
}

/** Everyone with a row, the owner first, then by name; with what each has spent this calendar month (UTC). */
export async function listAccess(q: Queryable, ownerId: string | null, userId?: string): Promise<AiAccess[]> {
  const { rows } = await q.query<ListedRow>(
    `WITH spend AS (
       SELECT user_id, sum(cost_usd) AS spent FROM ai_usage
        WHERE created_at >= (date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') GROUP BY user_id)
     SELECT ${ACCESS_COLUMNS}, u.name, u.username, u.role::text AS role, COALESCE(s.spent, 0)::numeric(14, 6) AS "spentUsd",
            a.updated_at AS "updatedAt", a.updated_by_name AS "updatedByName"
       FROM ai_access a JOIN users u ON u.id = a.user_id LEFT JOIN spend s ON s.user_id = a.user_id
      WHERE ($2::uuid IS NULL OR a.user_id = $2)
      ORDER BY (a.user_id = $1) DESC NULLS LAST, lower(u.name), u.username`,
    [ownerId, userId ?? null],
  )
  return rows.map((r) => {
    const a = toRecord(r)
    const out: AiAccess = {
      userId: a.userId,
      name: r.name,
      username: r.username,
      role: r.role,
      active: a.active,
      enabled: a.enabled,
      domains: a.domains,
      monthlyCapUsd: a.monthlyCapUsd,
      spentUsd: Number(r.spentUsd),
      owner: a.userId === ownerId,
      // The owner may create automations whatever their row says (§21), and write notices while an administrator (§23).
      automations: a.automations || a.userId === ownerId,
      notices: a.notices || a.userId === ownerId,
      excel: a.excel || a.userId === ownerId,
      mtc: a.mtc || a.userId === ownerId,
      updatedAt: r.updatedAt,
    }
    if (r.updatedByName) out.updatedByName = r.updatedByName
    return out
  })
}

/** Active accounts the owner has not listed yet: whom "Add person" offers. Never the automations' system sender (§21). */
export async function unlistedPeople(q: Queryable): Promise<{ id: string; name: string; username: string; role: string }[]> {
  const { rows } = await q.query<{ id: string; name: string; username: string; role: string }>(
    `SELECT u.id, u.name, u.username, u.role::text AS role FROM users u
      WHERE u.is_active AND u.deleted_at IS NULL AND NOT u.is_system AND NOT EXISTS (SELECT 1 FROM ai_access a WHERE a.user_id = u.id)
      ORDER BY lower(u.name), u.username`,
  )
  return rows
}

// ---- Changes -------------------------------------------------------------------------

const DOMAIN_NAMES = new Map<string, string>(AI_DOMAINS.map((d) => [d.id, d.name]))

/** A row's settings as the audit log shows them: one value per field, in words. */
function auditSnapshot(a: Omit<AccessRecord, 'userId' | 'active'>): Record<string, string> {
  return {
    enabled: a.enabled ? 'on' : 'off',
    domains: a.domains.length ? a.domains.map((d) => DOMAIN_NAMES.get(d) ?? d).join(', ') : 'none',
    monthlyCapUsd: a.monthlyCapUsd.toFixed(2),
    automations: a.automations ? 'may create' : 'may not create',
    notices: a.notices ? 'may manage' : 'may not manage',
    excel: a.excel ? 'may have made' : 'may not have made',
    mtc: a.mtc ? 'may upload' : 'may not upload',
  }
}

/** The whole row in one line, for the audit entry of its creation or removal; the automations, notices and Excel permissions only when given. */
const auditLine = (who: { name: string; username: string }, a: Omit<AccessRecord, 'userId' | 'active'>) => {
  const s = auditSnapshot(a)
  return `${who.name} (${who.username}): ${s.enabled}; ${s.domains}; $${s.monthlyCapUsd} a month${a.automations ? '; may create automations' : ''}${a.notices ? '; may manage notices' : ''}${a.excel ? '; may have Excel files made' : ''}${a.mtc ? '; may upload MTC certificates' : ''}`
}

export interface Editor {
  id: string
  name: string
}

/**
 * Create or change a person's row, in the caller's transaction, and audit
 * it: its creation in one line, a change field by field. The automations,
 * notices and Excel permissions left out of `next` stay as they are (off for
 * a new row). The notices permission is kept whatever the person's role: it takes
 * effect only while they are an administrator (mayManageNotices).
 */
export async function saveAccess(
  tx: Queryable,
  person: { id: string; name: string; username: string },
  next: AiAccessRequest,
  by: Editor,
): Promise<'created' | 'updated' | 'unchanged'> {
  const before = await tx.query<AccessRow>(
    `SELECT ${ACCESS_COLUMNS} FROM ai_access a JOIN users u ON u.id = a.user_id WHERE a.user_id = $1 FOR UPDATE OF a`,
    [person.id],
  )
  const ctx = { userId: by.id, userName: by.name, entity: 'AiAccess', entityId: person.id }
  const automations = next.automations ?? before.rows[0]?.automations ?? false
  const notices = next.notices ?? before.rows[0]?.notices ?? false
  const excel = next.excel ?? before.rows[0]?.excel ?? false
  const mtc = next.mtc ?? before.rows[0]?.mtc ?? false
  const wanted = { ...next, automations, notices, excel, mtc }
  const values = [person.id, next.enabled, next.domains, next.monthlyCapUsd, by.id, by.name, automations, notices, excel, mtc]
  if (!before.rows[0]) {
    await tx.query(
      `INSERT INTO ai_access (user_id, enabled, domains, monthly_cap_usd, updated_by_id, updated_by_name, automations, notices, excel, mtc)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      values,
    )
    await writeAudit(tx, [auditEvent('create', ctx, new Date().toISOString(), { field: 'access', newValue: auditLine(person, wanted) })])
    return 'created'
  }
  const old = toRecord(before.rows[0])
  const changed = await auditChanges(tx, ctx, auditSnapshot(old), auditSnapshot(wanted))
  if (changed === 0) return 'unchanged'
  await tx.query(
    `UPDATE ai_access SET enabled = $2, domains = $3, monthly_cap_usd = $4, updated_by_id = $5, updated_by_name = $6,
            automations = $7, notices = $8, excel = $9, mtc = $10
      WHERE user_id = $1`,
    values,
  )
  return 'updated'
}

/** Take the assistant away from a person: the row goes; their conversations stay theirs, unreachable until it is given back. */
export async function removeAccess(tx: Queryable, person: { id: string; name: string; username: string }, by: Editor): Promise<boolean> {
  const { rows } = await tx.query<AccessRow>(
    `DELETE FROM ai_access a USING users u WHERE a.user_id = $1 AND u.id = a.user_id RETURNING ${ACCESS_COLUMNS}`,
    [person.id],
  )
  if (!rows[0]) return false
  await writeAudit(tx, [
    auditEvent('delete', { userId: by.id, userName: by.name, entity: 'AiAccess', entityId: person.id }, new Date().toISOString(), {
      field: 'access',
      oldValue: auditLine(person, toRecord(rows[0])),
    }),
  ])
  return true
}

// ---- Before every call -----------------------------------------------------------------

/** How an answer ends when the asker may no longer be answered, or a cap would be passed. */
export interface Stop {
  stopReason: AiStopReason
  notice: string
}

export const ACCESS_NOTICE = {
  withdrawn: 'Stopped: you no longer have access to the assistant.',
  unavailable: 'Stopped: the assistant is not available right now.',
  appCap: "The assistant's monthly limit is reached, so the answer stopped. It is available again on the 1st.",
  personalCap: "You have reached this month's limit for the assistant, so the answer stopped. It is available again on the 1st.",
}

/**
 * Whether a call that could cost up to `worstUsd` may be made for this
 * person now: their access as it stands (the owner may have changed it, or
 * the account gone, since the answer began), the switch, and both caps — the
 * assistant's and their own — with the call's worst case on top. Why the
 * answer stops, or null to go on. (The queries the call asks for read the
 * access again as each runs: a call can take minutes.)
 */
export async function checkCall(q: Queryable, userId: string, worstUsd: number): Promise<Stop | null> {
  // One after another: `q` may be a transaction's single connection.
  const access = await loadAccess(q, userId)
  if (!isGranted(access)) return { stopReason: 'stopped', notice: ACCESS_NOTICE.withdrawn }
  const { settings } = await loadAiSettings(q)
  if (!settings.enabled) return { stopReason: 'stopped', notice: ACCESS_NOTICE.unavailable }
  const app = await monthSpend(q)
  if (app.spentUsd + worstUsd > settings.monthlyCapUsd) return { stopReason: 'cap', notice: ACCESS_NOTICE.appCap }
  const mine = await personalMonthSpend(q, userId)
  if (mine + worstUsd > access.monthlyCapUsd) return { stopReason: 'cap', notice: ACCESS_NOTICE.personalCap }
  return null
}

// ---- What a person learns --------------------------------------------------------------

export interface PersonAvailability {
  /** What the person may be told: no amounts, no model, no settings. */
  me: AiMeResponse
  /** Their row, when the owner gave them one. */
  access: AccessRecord | null
  /** The assistant's own state, judged on the person's model. The owner's to see. */
  app: AiAvailability
}

/**
 * Whether this person may ask now, and if not, why — in the order that
 * matters to them: not given the assistant at all; the assistant itself not
 * able to answer (off, no key, no readers); its monthly cap; their own.
 * Either cap counts as reached when the least one call could cost would pass it.
 */
export async function personAvailability(
  q: Queryable,
  config: Config,
  readerReady: boolean,
  userId: string,
  ownerId: string | null,
  /** The person's row, when the caller has just read it. */
  known?: AccessRecord | null,
): Promise<PersonAvailability> {
  // One after another: `q` may be a transaction's single connection.
  const access = known !== undefined ? known : await loadAccess(q, userId)
  // Judged on the cheapest model a question may run on now (the owner's Models): a dearer level is held to the caps call by call.
  const app = await loadAvailability(q, config, readerReady)
  const model = app.status.model
  const owner = ownerId !== null && ownerId === userId
  // The role as it is now: a person demoted loses the notices at once (mayManageNotices).
  const role = isGranted(access) ? ((await q.query<{ role: Role }>(`SELECT role FROM users WHERE id = $1`, [userId])).rows[0]?.role ?? null) : null
  const me: AiMeResponse = {
    granted: isGranted(access),
    owner,
    available: false,
    automations: mayAutomate(access, owner),
    excel: mayMakeExcel(access, owner),
    notices: mayManageNotices(access, owner, role),
    mtc: mayUploadMtc(access, owner, true),
  }
  if (!isGranted(access)) me.reason = 'not-granted'
  else if (app.status.reason === 'cap-reached') me.reason = 'cap-reached'
  else if (app.status.reason) me.reason = 'unavailable'
  else if ((await personalMonthSpend(q, userId)) + minCallWorstCaseUsd(model) > access.monthlyCapUsd) me.reason = 'personal-cap'
  else me.available = true
  return { me, access, app }
}

/**
 * The status an answer or a saved report hands back. The owner may see the
 * assistant's figures; anyone else learns only whether they may ask on, in
 * the status's own terms, with no amount and no model.
 */
export function statusFor(p: PersonAvailability): AiStatusResponse {
  if (p.me.owner) return p.app.status
  const status: AiStatusResponse = { available: p.me.available, model: '', spentUsd: 0, capUsd: 0, monthStart: p.app.status.monthStart }
  // Which of the assistant's own reasons it is (a key, the readers) is the owner's business: "not now" says enough.
  if (p.me.reason === 'cap-reached' || p.me.reason === 'personal-cap') status.reason = 'cap-reached'
  else if (p.me.reason) status.reason = 'disabled'
  return status
}
