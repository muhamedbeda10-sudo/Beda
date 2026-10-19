// ============================================================================
// §20 — the one person who controls the assistant. Its key, its switch and
// caps, who may use it and what it has cost are theirs alone; to everyone
// else, administrators included, that part of the app does not exist.
//
// The owner is pinned once, and only deliberately: at the API's start, the
// live, active account whose username is AI_OWNER_USERNAME (any case); by
// whoever runs the server, with `npm run ai:pin-owner -w server -- <username>`;
// or, on an empty installation, the first account registered when it takes
// that name. Nothing else pins — no request, whoever makes it. Until a pin
// exists the name is reserved: the app neither creates an account with it,
// nor renames one to it, nor lets anyone register it, so nobody can make
// themselves the owner by taking the name.
//
// From then on the pin never moves through the app — not for a rename, not
// for a new account taking the name, not for a changed setting (that only
// logs a warning). Should the pinned account be deactivated or removed,
// nobody controls the assistant; putting it right is a database operation.
//
// Who the owner is, is read again on every request: nothing is cached.
// ============================================================================

import { AI_DOMAIN_IDS } from '@qc/shared/ai'
import { auditEvent } from '@qc/shared/audit'
import type { Config } from '../config'
import { withTransaction, type Db, type Queryable } from '../db/pool'
import { writeAudit } from '../audit/service'
import { loadAccess, saveAccess } from './access'
import { loadAiSettings } from './settings'

/** Serialises pinning across instances: two pins at once pin once. Next to the reader's lock (7_204_930_116). */
const PIN_LOCK_KEY = 7_204_930_117

/** Settings already warned about, so the log says it once per process, not on every request. */
const warned = new Set<string>()

export interface PinnedAiOwner {
  userId: string
  username: string
  live: boolean
}

/** The pin as it stands, whether or not its account can act now; null before anyone is pinned. */
export async function pinnedAiOwner(q: Queryable): Promise<PinnedAiOwner | null> {
  const { rows } = await q.query<PinnedAiOwner>(
    `SELECT o.user_id AS "userId", u.username, (u.is_active AND u.deleted_at IS NULL) AS live
       FROM ai_owner o JOIN users u ON u.id = o.user_id WHERE o.id = 1`,
  )
  return rows[0] ?? null
}

/**
 * The owner's account id when the owner can act: pinned, active, not
 * removed. Never pins.
 */
export async function currentAiOwner(q: Queryable, config: Config): Promise<string | null> {
  const row = await pinnedAiOwner(q)
  if (!row) return null
  warnIfRenamed(row, config)
  return row.live ? row.userId : null
}

/** The owner's account id, as `currentAiOwner`. Never pins: an owner is pinned at start, or by the server's operator. */
export async function aiOwner(db: Db, config: Config): Promise<string | null> {
  return currentAiOwner(db, config)
}

/** Whether this account is the owner, as of now. */
export async function isAiOwner(db: Db, config: Config, userId: string): Promise<boolean> {
  return (await aiOwner(db, config)) === userId
}

/**
 * The account pinned as owner, whether or not it can sign in now. For
 * guarding the account itself: one deactivated today may be active again
 * tomorrow, and still the owner.
 */
export async function aiOwnerAccount(db: Db, _config: Config): Promise<string | null> {
  return (await pinnedAiOwner(db))?.userId ?? null
}

/**
 * Whether a username may not be given now: it is the owner's name
 * (AI_OWNER_USERNAME, any case) and nobody is pinned yet. Whoever took it
 * would be pinned at the next start; once an owner is pinned the name is
 * an ordinary one again.
 */
export async function isReservedForAiOwner(q: Queryable, config: Config, username: string): Promise<boolean> {
  if (username.trim().toLowerCase() !== config.AI_OWNER_USERNAME.toLowerCase()) return false
  return (await pinnedAiOwner(q)) === null
}

/** What the app answers when a reserved name is asked for. */
export const RESERVED_OWNER_NAME = 'This username is reserved. Choose another.'

/**
 * Pin the owner, if none is pinned and the account named — AI_OWNER_USERNAME
 * unless the operator names another — is live and active; their own access
 * is created with it (every domain, a personal cap of the assistant's cap).
 * For the API's start and the operator's command only. Returns the owner's
 * id (a pin made before included, when its account can act), or null.
 */
export async function pinAiOwner(db: Db, config: Config, username = config.AI_OWNER_USERNAME): Promise<string | null> {
  return withTransaction(db, (tx) => pinAiOwnerIn(tx, username))
}

/**
 * The same, inside a transaction the caller holds — the first registration
 * of an empty installation, when it takes the owner's name, so the account
 * and its pin land together.
 */
export async function pinAiOwnerIn(tx: Queryable, username: string): Promise<string | null> {
  await tx.query('SELECT pg_advisory_xact_lock($1)', [PIN_LOCK_KEY])
  const existing = await pinnedAiOwner(tx)
  if (existing) return existing.live ? existing.userId : null
  const user = await findCandidate(tx, username)
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
    await saveAccess(tx, user, { enabled: true, domains: [...AI_DOMAIN_IDS], monthlyCapUsd: cap }, by)
  }
  console.log(`[ai] the assistant's owner is pinned: ${user.username}`)
  return user.id
}

async function findCandidate(q: Queryable, username: string): Promise<{ id: string; name: string; username: string } | null> {
  const { rows } = await q.query<{ id: string; name: string; username: string }>(
    `SELECT id, name, username FROM users WHERE lower(username) = lower($1) AND is_active AND deleted_at IS NULL AND NOT is_system`,
    [username.trim()],
  )
  // Usernames are unique among live accounts: at most one.
  return rows[0] ?? null
}

/** A pin that no longer matches the setting stays where it is; the log says so, once. */
function warnIfRenamed(row: PinnedAiOwner, config: Config): void {
  if (row.username.toLowerCase() === config.AI_OWNER_USERNAME.toLowerCase()) return
  const key = `${row.userId}:${config.AI_OWNER_USERNAME.toLowerCase()}`
  if (warned.has(key)) return
  warned.add(key)
  console.warn(
    `[ai] AI_OWNER_USERNAME is "${config.AI_OWNER_USERNAME}", but the assistant's owner stays the account pinned first (now "${row.username}"); the app never moves it.`,
  )
}
