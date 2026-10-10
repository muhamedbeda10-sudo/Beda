// ============================================================================
// §20 — the one person who controls the assistant. Its key, its switch and
// caps, who may use it and what it has cost are theirs alone; to everyone
// else, administrators included, that part of the app does not exist.
//
// The owner is pinned once: the live, active account whose username is
// AI_OWNER_USERNAME (any case), at start or the first time it is needed.
// From then on the pin never moves through the app — not for a rename, not
// for a new account taking the name, not for a changed setting (that only
// logs a warning). Should the pinned account be deactivated or removed,
// nobody controls the assistant; putting it right is a database operation.
//
// Who the owner is, is read again on every request: nothing is cached.
// ============================================================================

import { AI_DOMAIN_IDS, AI_MODEL } from '@qc/shared/ai'
import { auditEvent } from '@qc/shared/audit'
import type { Config } from '../config'
import { withTransaction, type Db, type Queryable } from '../db/pool'
import { writeAudit } from '../audit/service'
import { loadAccess, saveAccess } from './access'
import { loadAiSettings } from './settings'

/** Serialises pinning across instances: two requests at once pin once. Next to the reader's lock (7_204_930_116). */
const PIN_LOCK_KEY = 7_204_930_117

/** The effort the owner's own access starts with. */
const OWNER_EFFORT = 'medium'

/** Settings already warned about, so the log says it once per process, not on every request. */
const warned = new Set<string>()

interface PinnedRow {
  userId: string
  username: string
  live: boolean
}

async function pinned(q: Queryable): Promise<PinnedRow | null> {
  const { rows } = await q.query<PinnedRow>(
    `SELECT o.user_id AS "userId", u.username, (u.is_active AND u.deleted_at IS NULL) AS live
       FROM ai_owner o JOIN users u ON u.id = o.user_id WHERE o.id = 1`,
  )
  return rows[0] ?? null
}

/**
 * The owner's account id when the owner can act: pinned, active, not
 * removed. Never pins: for places that only ask (the audit browser), where
 * nothing of the assistant's exists to hide before an owner was pinned.
 */
export async function currentAiOwner(q: Queryable, config: Config): Promise<string | null> {
  const row = await pinned(q)
  if (!row) return null
  warnIfRenamed(row, config)
  return row.live ? row.userId : null
}

/** The owner's account id, pinning one first if there is none yet and the configured account exists. */
export async function aiOwner(db: Db, config: Config): Promise<string | null> {
  const row = await pinned(db)
  if (row) {
    warnIfRenamed(row, config)
    return row.live ? row.userId : null
  }
  return pinAiOwner(db, config)
}

/** Whether this account is the owner, as of now. */
export async function isAiOwner(db: Db, config: Config, userId: string): Promise<boolean> {
  return (await aiOwner(db, config)) === userId
}

/**
 * The account pinned as owner, whether or not it can sign in now (pinning
 * the configured account first, if nothing is pinned yet). For guarding the
 * account itself: one deactivated today may be active again tomorrow, and
 * still the owner.
 */
export async function aiOwnerAccount(db: Db, config: Config): Promise<string | null> {
  const row = await pinned(db)
  if (row) return row.userId
  // Null when a pin made meanwhile is of an account that cannot act: read it again.
  return (await pinAiOwner(db, config)) ?? (await pinned(db))?.userId ?? null
}

/**
 * Pin the owner, if none is pinned and the configured account is live and
 * active; their own access is created with it (every domain, the default
 * model, medium effort, a personal cap of the assistant's cap). Returns the
 * owner's id (a pin made meanwhile by another request included), or null.
 */
export async function pinAiOwner(db: Db, config: Config): Promise<string | null> {
  const wanted = config.AI_OWNER_USERNAME
  // Looked for before any lock: most of the time, before the account exists, there is nothing to pin.
  const candidate = await findCandidate(db, wanted)
  if (!candidate) return null
  return withTransaction(db, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [PIN_LOCK_KEY])
    const existing = await pinned(tx)
    if (existing) return existing.live ? existing.userId : null
    const user = await findCandidate(tx, wanted)
    if (!user) return null
    await tx.query(`INSERT INTO ai_owner (id, user_id) VALUES (1, $1)`, [user.id])
    const by = { id: user.id, name: user.name }
    await writeAudit(tx, [
      auditEvent('create', { userId: user.id, userName: user.name, entity: 'AiAssistant', entityId: 'owner' }, new Date().toISOString(), {
        field: 'owner',
        newValue: `${user.name} (${user.username})`,
      }),
    ])
    // A row the owner already had (set up in the database beforehand) is theirs as it is.
    if (!(await loadAccess(tx, user.id))) {
      const cap = (await loadAiSettings(tx)).settings.monthlyCapUsd
      await saveAccess(
        tx,
        user,
        { enabled: true, domains: [...AI_DOMAIN_IDS], model: AI_MODEL, effort: OWNER_EFFORT, monthlyCapUsd: cap },
        by,
      )
    }
    console.log(`[ai] the assistant's owner is pinned: ${user.username}`)
    return user.id
  })
}

async function findCandidate(q: Queryable, username: string): Promise<{ id: string; name: string; username: string } | null> {
  const { rows } = await q.query<{ id: string; name: string; username: string }>(
    `SELECT id, name, username FROM users WHERE lower(username) = lower($1) AND is_active AND deleted_at IS NULL AND NOT is_system`,
    [username],
  )
  // Usernames are unique among live accounts: at most one.
  return rows[0] ?? null
}

/** A pin that no longer matches the setting stays where it is; the log says so, once. */
function warnIfRenamed(row: PinnedRow, config: Config): void {
  if (row.username.toLowerCase() === config.AI_OWNER_USERNAME.toLowerCase()) return
  const key = `${row.userId}:${config.AI_OWNER_USERNAME.toLowerCase()}`
  if (warned.has(key)) return
  warned.add(key)
  console.warn(
    `[ai] AI_OWNER_USERNAME is "${config.AI_OWNER_USERNAME}", but the assistant's owner stays the account pinned first (now "${row.username}"); the app never moves it.`,
  )
}
