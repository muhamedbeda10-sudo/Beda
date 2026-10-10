// ============================================================================
// §20 — who may use the assistant, as the owner set it. Each person granted
// has a row: on or off, the data domains they may ask about, the model and
// effort their questions run on, and a personal monthly cap on top of the
// assistant's own. Everything is read again on every request, before every
// call to the model and before every query, so a change the owner makes — or
// an account being deactivated — takes effect at once.
// ============================================================================

import {
  AI_DOMAINS,
  AI_EFFORTS,
  AI_MODEL,
  AI_MODELS,
  isAiEffort,
  isAiModel,
  type AiAccess,
  type AiAccessRequest,
  type AiDomain,
  type AiEffort,
  type AiMeResponse,
  type AiModelId,
  type AiStatusResponse,
  type AiStopReason,
} from '@qc/shared/ai'
import { auditEvent } from '@qc/shared/audit'
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
  model: AiModelId
  effort: AiEffort
  monthlyCapUsd: number
  /** May create automations (§21); the owner may whatever this says. */
  automations: boolean
  /** The account is active and not removed. */
  active: boolean
}

interface AccessRow {
  userId: string
  enabled: boolean
  domains: string[]
  model: string
  effort: string
  monthlyCapUsd: number
  automations: boolean
  active: boolean
}

/** A row as the API uses it: a model or effort no longer offered reads as the default, never as something unchecked. */
function toRecord(r: AccessRow): AccessRecord {
  return {
    userId: r.userId,
    enabled: r.enabled,
    domains: storedDomains(r.domains),
    model: isAiModel(r.model) ? r.model : AI_MODEL,
    effort: isAiEffort(r.effort) ? r.effort : 'medium',
    monthlyCapUsd: Number(r.monthlyCapUsd),
    automations: r.automations,
    active: r.active,
  }
}

const ACCESS_COLUMNS = `a.user_id AS "userId", a.enabled, a.domains, a.model, a.effort, a.monthly_cap_usd AS "monthlyCapUsd",
       a.automations, (u.is_active AND u.deleted_at IS NULL) AS active`

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
      model: a.model,
      effort: a.effort,
      monthlyCapUsd: a.monthlyCapUsd,
      spentUsd: Number(r.spentUsd),
      owner: a.userId === ownerId,
      // The owner may create automations whatever their row says (§21).
      automations: a.automations || a.userId === ownerId,
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

const MODEL_NAMES = new Map<string, string>(AI_MODELS.map((m) => [m.id, m.name]))
const EFFORT_NAMES = new Map<string, string>(AI_EFFORTS.map((e) => [e.id, e.name]))
const DOMAIN_NAMES = new Map<string, string>(AI_DOMAINS.map((d) => [d.id, d.name]))

/** A row's settings as the audit log shows them: one value per field, in words. */
function auditSnapshot(a: Omit<AccessRecord, 'userId' | 'active'>): Record<string, string> {
  return {
    enabled: a.enabled ? 'on' : 'off',
    domains: a.domains.length ? a.domains.map((d) => DOMAIN_NAMES.get(d) ?? d).join(', ') : 'none',
    model: MODEL_NAMES.get(a.model) ?? a.model,
    effort: EFFORT_NAMES.get(a.effort) ?? a.effort,
    monthlyCapUsd: a.monthlyCapUsd.toFixed(2),
    automations: a.automations ? 'may create' : 'may not create',
  }
}

/** The whole row in one line, for the audit entry of its creation or removal; the automations permission only when given. */
const auditLine = (who: { name: string; username: string }, a: Omit<AccessRecord, 'userId' | 'active'>) => {
  const s = auditSnapshot(a)
  return `${who.name} (${who.username}): ${s.enabled}; ${s.domains}; ${s.model}; ${s.effort}; $${s.monthlyCapUsd} a month${a.automations ? '; may create automations' : ''}`
}

export interface Editor {
  id: string
  name: string
}

/**
 * Create or change a person's row, in the caller's transaction, and audit
 * it: its creation in one line, a change field by field. The automations
 * permission left out of `next` stays as it is (off for a new row).
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
  const wanted = { ...next, automations }
  const values = [person.id, next.enabled, next.domains, next.model, next.effort, next.monthlyCapUsd, by.id, by.name, automations]
  if (!before.rows[0]) {
    await tx.query(
      `INSERT INTO ai_access (user_id, enabled, domains, model, effort, monthly_cap_usd, updated_by_id, updated_by_name, automations)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      values,
    )
    await writeAudit(tx, [auditEvent('create', ctx, new Date().toISOString(), { field: 'access', newValue: auditLine(person, wanted) })])
    return 'created'
  }
  const old = toRecord(before.rows[0])
  const changed = await auditChanges(tx, ctx, auditSnapshot(old), auditSnapshot(wanted))
  if (changed === 0) return 'unchanged'
  await tx.query(
    `UPDATE ai_access SET enabled = $2, domains = $3, model = $4, effort = $5, monthly_cap_usd = $6, updated_by_id = $7, updated_by_name = $8,
            automations = $9
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
  const model = access?.model ?? AI_MODEL
  const app = await loadAvailability(q, config, readerReady, model)
  const owner = ownerId !== null && ownerId === userId
  const me: AiMeResponse = { granted: isGranted(access), owner, available: false, automations: mayAutomate(access, owner) }
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
